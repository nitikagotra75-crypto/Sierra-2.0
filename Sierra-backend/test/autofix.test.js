const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { autoFix, llmFixer } = require("../src/engine/autofix");
const { registry, buildSpec } = require("../src/engine");
const { validateStack, hasTool } = require("../src/engine/validate");
const { writeFiles } = require("../src/execution/executionManager");

// A tiny real "stack": validation runs real `node` commands, so failures/passes are genuine process results.
const tinyStack = { id: "tiny", validate: { toolchain: "node", build: [["node", "--check", "src/lib.js"]], test: [["node", "test.js"]] } };
const GOOD = "module.exports.add = (a, b) => a + b;\n";
const base = () => ({ "src/lib.js": GOOD, "test.js": 'const {add}=require("./src/lib");if(add(1,2)!==3){console.error("src/lib.js: add is wrong");process.exit(1)}console.log("ok")\n', "README.md": "keep me\n" });
async function ws(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sierra-af-"));
  await writeFiles(dir, files);
  return dir;
}
const read = (dir, f) => fs.readFileSync(path.join(dir, f), "utf8");

test("already passing: no fixer call, verified, status passed", async () => {
  const dir = await ws(base());
  let calls = 0;
  const r = await autoFix({ stack: tinyStack, workspacePath: dir, files: base(), fixer: async () => { calls++; return { changes: [] }; } });
  assert.equal(r.status, "passed"); assert.equal(r.verified, true); assert.equal(calls, 0); assert.equal(r.attempts, 0);
});

test("fixes a failing test through a targeted edit, tracks history and leaves unrelated files alone", async () => {
  const files = { ...base(), "src/lib.js": "module.exports.add = (a, b) => a - b;\n" };
  const dir = await ws(files);
  const seen = [];
  const r = await autoFix({ stack: tinyStack, workspacePath: dir, files, fixer: async (ctx) => { seen.push(ctx); return { changes: [{ path: "src/lib.js", newContent: GOOD, description: "use +" }] }; } });
  assert.equal(r.status, "fixed"); assert.equal(r.verified, true); assert.equal(r.attempts, 1);
  assert.deepEqual(r.changedFiles, ["src/lib.js"]);
  assert.equal(read(dir, "src/lib.js"), GOOD); assert.equal(read(dir, "README.md"), "keep me\n");
  assert.equal(seen[0].phase, "test"); assert.deepEqual(seen[0].candidates, ["src/lib.js"]); assert.match(seen[0].output, /add is wrong/);
  assert.equal(r.history[0].applied[0].path, "src/lib.js"); assert.equal(r.history[0].resultStatus, "passed");
});

test("bounded: a fixer that never fixes stops at maxAttempts and reports the unresolved error (never verified)", async () => {
  const files = { ...base(), "src/lib.js": "module.exports.add = (a, b) => a * b;\n" };
  const dir = await ws(files);
  let n = 0;
  const r = await autoFix({ stack: tinyStack, workspacePath: dir, files, maxAttempts: 2, fixer: async () => ({ changes: [{ path: "src/lib.js", newContent: `module.exports.add = (a, b) => a * b * 0 + ${++n};\n`, description: "tweak" }] }) });
  assert.equal(r.status, "unresolved"); assert.equal(r.verified, false); assert.equal(n, 2); assert.equal(r.attempts, 2);
  assert.equal(r.unresolved.length, 1); assert.match(r.unresolved[0].error, /add is wrong/);
});

test("unsafe edits are rejected: traversal, new files, absolute paths, empty content, too many files", async () => {
  const files = { ...base(), "src/lib.js": "module.exports.add = (a, b) => 0;\n" };
  const dir = await ws(files);
  const outside = path.join(path.dirname(dir), "af-pwned.txt");
  const r = await autoFix({ stack: tinyStack, workspacePath: dir, files, maxAttempts: 1, fixer: async () => ({ changes: [
    { path: "../af-pwned.txt", newContent: "x" }, { path: "new-file.js", newContent: "x" }, { path: "/etc/passwd", newContent: "x" }, { path: "src/lib.js", newContent: "  " },
  ] }) });
  assert.equal(r.status, "unresolved");
  assert.deepEqual(r.history[0].rejected.map((x) => x.path), ["../af-pwned.txt", "new-file.js", "/etc/passwd", "src/lib.js"]);
  assert.ok(!fs.existsSync(outside)); assert.ok(!fs.existsSync(path.join(dir, "new-file.js")));
});

test("a fix that breaks an EARLIER phase is rolled back", async () => {
  const files = { ...base(), "src/lib.js": "module.exports.add = (a, b) => a - b;\n" };
  const dir = await ws(files);
  const r = await autoFix({ stack: tinyStack, workspacePath: dir, files, maxAttempts: 1, fixer: async () => ({ changes: [{ path: "src/lib.js", newContent: "module.exports.add = (a, b => a + b;\n", description: "syntax error" }] }) });
  assert.equal(r.history[0].rolledBack, true);
  assert.equal(read(dir, "src/lib.js"), "module.exports.add = (a, b) => a - b;\n");
  assert.equal(r.verified, false); assert.deepEqual(r.changedFiles, []);
});

test("no fixer configured / fixer error / skipped validation are never reported as verified", async () => {
  const files = { ...base(), "src/lib.js": "module.exports.add = () => 0;\n" };
  const dir = await ws(files);
  const a = await autoFix({ stack: tinyStack, workspacePath: dir, files });
  assert.equal(a.status, "unresolved"); assert.equal(a.verified, false); assert.match(a.reason, /no fixer/);
  const b = await autoFix({ stack: tinyStack, workspacePath: dir, files, fixer: async () => { throw new Error("LLM down"); } });
  assert.equal(b.verified, false); assert.match(b.reason, /LLM down/);
  const c = await autoFix({ stack: { id: "x", validate: { toolchain: "definitely-not-installed-tool" } }, workspacePath: dir, files });
  assert.equal(c.status, "not_verified"); assert.equal(c.verified, false);
});

test("llmFixer builds the prompt from the real error and returns the model's edits", async () => {
  let got;
  const fixer = llmFixer(async (q) => { got = q; return { changes: [{ path: "src/lib.js", newContent: GOOD, description: "d" }] }; });
  const out = await fixer({ stack: "tiny", phase: "test", command: "node test.js", output: "src/lib.js: add is wrong", files: { "src/lib.js": "x" }, candidates: ["src/lib.js"], history: [] });
  assert.match(got.prompt, /add is wrong/); assert.match(got.prompt, /--- src\/lib.js ---/);
  assert.equal(out.changes[0].path, "src/lib.js");
});

// Real stack end to end: break a generated FastAPI file, run its REAL pytest, repair via the (scripted) fixer, re-run.
test("python-fastapi: a broken generated file is repaired and the project's own tests then pass", async (t) => {
  if (!(await hasTool("python3"))) return t.skip("python3 not installed");
  const spec = buildSpec({ projectName: "Demo", analysis: { needsAuth: false, primaryEntities: [{ name: "Task", fields: [{ name: "title", type: "string", required: true }] }] }, options: { stack: "python-fastapi" } });
  const files = registry.generate(spec);
  const target = "app/core/errors.py";
  assert.ok(files[target], "expected generated file " + target);
  const broken = { ...files, [target]: files[target] + "\ndef broken(:\n" };
  const dir = await ws(broken);
  const r = await autoFix({ stack: registry.get("python-fastapi"), workspacePath: dir, files: broken, spec, fixer: async (ctx) => {
    assert.ok(ctx.candidates.includes(target), "error output should point at the broken file: " + ctx.candidates);
    return { changes: [{ path: target, newContent: files[target], description: "remove syntax error" }] };
  } });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, "fixed"); assert.equal(r.verified, true); assert.deepEqual(r.changedFiles, [target]);
});

test("pipeline: failing generation is repaired by the injected fixer and the report carries the auto-fix history", async (t) => {
  const { Project, ProjectFile } = require("../src/models");
  const { runEnginePipeline } = require("../src/engine/pipeline");
  global.__SIERRA_LOCAL_MODE__ = true;
  if (!(await hasTool("python3"))) return t.skip("python3 not installed");
  const stack = registry.get("python-fastapi");
  const realGenerate = stack.generate;
  const target = "app/core/errors.py";
  let original;
  stack.generate = (spec) => { const f = realGenerate(spec); original = f[target]; return { ...f, [target]: f[target] + "\ndef broken(:\n" }; };
  try {
    const projectId = "af-pipe-" + Date.now();
    await Project.create({ projectId, name: "AF", requirement: "A todo API", techStack: { stack: "python-fastapi", backend: "FastAPI", features: {} } });
    const report = await runEnginePipeline(projectId, { fixer: async () => ({ changes: [{ path: target, newContent: original, description: "remove syntax error" }] }) });
    assert.equal(report.status, "VERIFIED");
    assert.equal(report.autofix.status, "fixed"); assert.deepEqual(report.autofix.changedFiles, [target]);
    assert.equal(report.autofix.history.length, 1);
    const stored = await ProjectFile.find({ projectId });
    assert.equal(stored.find((f) => f.path === target).content, original);
  } finally { stack.generate = realGenerate; }
});
