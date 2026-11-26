/**
 * Reusable auto-fix loop for ANY stack that defines `validate` (format/setup/build/test):
 *   validate -> capture the real failing command output -> ask a fixer for targeted edits -> apply safely -> validate again
 * until the validation passes or `maxAttempts` fixes have been tried. Properties:
 *  - the result is `verified: true` ONLY when the last real validation run passed; skipped validation is never verified;
 *  - bounded: at most maxAttempts fixer calls, and it stops early if the fixer proposes nothing / the same error repeats;
 *  - safe edits: only files that already exist in the project, relative paths inside the workspace, bounded size,
 *    at most maxFilesPerAttempt files; everything else is rejected and recorded;
 *  - full history: every attempt records the failing phase/command/error excerpt, proposed + applied + rejected edits;
 *  - edits that make the project fail EARLIER than before are rolled back (a fix must not regress the pipeline phase).
 * The fixer is injectable: `llmFixer()` uses the configured LLM; tests inject deterministic fixers (the validation is
 * always real, only the "who writes the fix" part is substituted).
 */
const fs = require("fs/promises");
const path = require("path");
const { validateStack } = require("./validate");

const PHASE_ORDER = ["format", "setup", "build", "test"];
const MAX_FILE_BYTES = 200 * 1024;

const failingStep = (validation) => [...(validation.steps || [])].reverse().find((s) => s.code !== 0 || s.output.startsWith("These files are not formatted")) || null;

/** Paths of project files mentioned in the error output (most relevant candidates first, deduped). */
function candidateFiles(output, known) {
  const hits = new Map();
  const norm = (p) => p.replace(/^\.\//, "").replace(/\\/g, "/");
  for (const rel of known) {
    const i = output.lastIndexOf(norm(rel));
    if (i >= 0) hits.set(rel, i);
  }
  return [...hits.entries()].sort((a, b) => b[1] - a[1]).map(([rel]) => rel);
}

function safeTarget(workspace, rel, known) {
  if (typeof rel !== "string" || !rel || path.isAbsolute(rel) || rel.includes("\0")) return "invalid path";
  const norm = path.posix.normalize(rel.replace(/\\/g, "/"));
  if (norm.startsWith("..") || norm.includes("/../")) return "path escapes the workspace";
  if (!known.has(norm)) return "file is not part of the generated project (creating files is not allowed)";
  const full = path.resolve(workspace, norm);
  if (!full.startsWith(path.resolve(workspace) + path.sep)) return "path escapes the workspace";
  return { norm, full };
}

async function autoFix({ stack, workspacePath, files, spec = null, fixer, maxAttempts = 3, maxFilesPerAttempt = 3, validate = validateStack, onEvent = () => {} }) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 0 || maxAttempts > 10) throw new Error("maxAttempts must be an integer between 0 and 10");
  const current = { ...files }; // path -> content, kept in sync with disk
  const known = new Set(Object.keys(current));
  const history = [];
  const changed = new Set();
  let validation = await validate(stack, workspacePath, { spec });
  let attempts = 0;
  const finish = (status, extra = {}) => ({
    status,
    verified: validation.status === "passed",
    attempts,
    maxAttempts,
    finalValidation: { status: validation.status, failedPhase: validation.failedPhase || null, reason: validation.reason || null },
    changedFiles: [...changed].sort(),
    history,
    unresolved: validation.status === "failed" ? [unresolvedOf(validation)] : [],
    files: current,
    validation,
    ...extra,
  });

  while (validation.status === "failed") {
    if (!fixer) return finish("unresolved", { reason: "no fixer configured (set GEMINI_API_KEY or GROQ_API_KEY or inject one)" });
    if (attempts >= maxAttempts) return finish("unresolved", { reason: `still failing after ${maxAttempts} fix attempt(s)` });
    attempts++;
    const step = failingStep(validation);
    const entry = { attempt: attempts, phase: validation.failedPhase, command: step && step.command, error: step && step.output.slice(-1500), proposed: [], applied: [], rejected: [] };
    history.push(entry);
    onEvent({ type: "autofix", attempt: attempts, phase: entry.phase, command: entry.command });
    const candidates = candidateFiles(step ? step.output : "", Object.keys(current));
    let proposal;
    try {
      proposal = await fixer({ stack: stack.id, phase: entry.phase, command: entry.command, output: step ? step.output : "", candidates, files: Object.fromEntries(candidates.slice(0, 6).map((c) => [c, current[c]])), history: history.slice(0, -1) });
    } catch (e) {
      entry.fixerError = e.message;
      return finish("unresolved", { reason: `fixer failed: ${e.message}` });
    }
    const edits = (proposal && proposal.changes) || [];
    entry.proposed = edits.map((c) => ({ path: c.path, description: c.description || "" }));
    if (edits.length === 0) return finish("unresolved", { reason: "fixer proposed no change" });

    const backup = {};
    for (const c of edits.slice(0, maxFilesPerAttempt)) {
      const t = safeTarget(workspacePath, c.path, known);
      if (typeof t === "string") { entry.rejected.push({ path: c.path, reason: t }); continue; }
      if (typeof c.newContent !== "string" || !c.newContent.trim()) { entry.rejected.push({ path: c.path, reason: "empty content" }); continue; }
      if (Buffer.byteLength(c.newContent) > MAX_FILE_BYTES) { entry.rejected.push({ path: c.path, reason: "file too large" }); continue; }
      if (c.newContent === current[t.norm]) { entry.rejected.push({ path: c.path, reason: "no change" }); continue; }
      backup[t.norm] = current[t.norm];
      await fs.writeFile(t.full, c.newContent, "utf8");
      current[t.norm] = c.newContent;
      entry.applied.push({ path: t.norm, description: c.description || "" });
    }
    for (const c of edits.slice(maxFilesPerAttempt)) entry.rejected.push({ path: c.path, reason: `more than ${maxFilesPerAttempt} files in one attempt` });
    if (entry.applied.length === 0) return finish("unresolved", { reason: "no proposed edit could be applied safely" });

    const before = validation.failedPhase;
    const sig = (step && step.output.slice(-400)) || "";
    validation = await validate(stack, workspacePath, { spec });
    entry.resultStatus = validation.status;
    entry.resultPhase = validation.failedPhase || null;
    if (validation.status === "failed" && PHASE_ORDER.indexOf(validation.failedPhase) < PHASE_ORDER.indexOf(before)) {
      for (const [rel, content] of Object.entries(backup)) { await fs.writeFile(path.resolve(workspacePath, rel), content, "utf8"); current[rel] = content; }
      entry.rolledBack = true;
      entry.applied = [];
      validation = await validate(stack, workspacePath, { spec });
      continue;
    }
    for (const a of entry.applied) changed.add(a.path);
    const next = failingStep(validation);
    if (validation.status === "failed" && next && next.output.slice(-400) === sig && history.length > 1 && history[history.length - 2].error && history[history.length - 2].error.endsWith(sig)) {
      return finish("unresolved", { reason: "the same error repeated after two fixes" });
    }
  }
  if (validation.status === "skipped") return finish("not_verified", { reason: validation.reason });
  return finish(attempts === 0 ? "passed" : "fixed");
}

function unresolvedOf(validation) {
  const s = failingStep(validation);
  return { phase: validation.failedPhase, command: s && s.command, error: s && s.output.slice(-1500) };
}

/** Fixer backed by the configured LLM (see agents/llm.js). Returns null-equivalent when no key is configured. */
function llmFixer(ask) {
  const { askForJSON, hasLLM } = require("../agents/llm");
  if (!ask && !hasLLM) return null;
  const call = ask || askForJSON;
  return async ({ stack, phase, command, output, files, candidates, history }) => {
    if (candidates.length === 0) return { changes: [] };
    const res = await call({
      system: 'You repair generated backend projects. Reply with ONLY JSON: {"changes":[{"path":"<one of the provided files>","newContent":"<full corrected file>","description":"<one sentence>"}]}. Make the smallest change that fixes the reported error. Do not touch unrelated code, do not add files, do not change tests to make them pass unless the test itself is wrong.',
      prompt: `Stack: ${stack}\nFailing phase: ${phase}\nCommand: ${command}\n\nOutput:\n${output.slice(-4000)}\n\nPrevious attempts:\n${JSON.stringify(history.map((h) => ({ applied: h.applied, result: h.resultStatus })))}\n\nFiles:\n${Object.entries(files).map(([f, c]) => `--- ${f} ---\n${c}`).join("\n\n")}`,
      maxTokens: 8192,
    });
    return { changes: Array.isArray(res.changes) ? res.changes : [] };
  };
}

module.exports = { autoFix, llmFixer, candidateFiles };
