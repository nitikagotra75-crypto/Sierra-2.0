/**
 * Runs the stack's own toolchain against generated files and reports what
 * ACTUALLY happened. If the toolchain is missing the result is "skipped",
 * never "passed".
 */
const fs = require("fs/promises");
const path = require("path");
const net = require("net");
const { runCommand, writeFiles } = require("../execution/executionManager");

async function hasTool(bin) {
  const r = await runCommand("command", ["-v", bin], { cwd: process.cwd(), env: process.env, timeoutMs: 5000 });
  return r.code === 0;
}

// A module that cannot be fetched from the (local or remote) proxy, as reported by a later phase (build/vet) when `go mod tidy -e` tolerated it.
const MODULE_FETCH_RE = /reading (file|https?):\/\/[^\n]*\/@v\/[^\n]*(no such file|not found|404|410|403)|module lookup disabled/i;
const OFFLINE_RE = /dial tcp|no such host|lookup [^\n]*(proxy|golang|github)|connect tunnel|Forbidden|403|ECONNREFUSED|ETIMEDOUT|network is unreachable|Temporary failure in name resolution|i\/o timeout|could not resolve host|Could not transfer|Transfer failed|UnknownHost|Non-resolvable|Connection refused|Network is unreachable/i;

const tail = (s, n = 3000) => (s.length > n ? "…" + s.slice(-n) : s);

/**
 * @returns {{status:"passed"|"failed"|"skipped", reason?:string, steps:Array}}
 */
async function validateStack(stack, workspacePath, { env = process.env, onStep, probe = probeTcp, spec = null } = {}) {
  if (spec && spec.architecture === "microservices") return require("./architecture").validateSystem(stack, workspacePath, { env, onStep, probe, spec }, validateStack);
  const v = stack.validate;
  if (!v) return { status: "skipped", reason: "stack defines no validation", steps: [] };
  if (!(await hasTool(v.toolchain))) {
    return { status: "skipped", reason: `toolchain '${v.toolchain}' is not installed on this server`, steps: [] };
  }
  // External services the project's own tests need (e.g. MongoDB for the Express stack). If one is not reachable the
  // tests cannot run honestly, so the result is "skipped" with the exact way to provide it, never a fake pass.
  const runEnv = { ...env };
  for (const req of [...(v.requires || []), ...(v.requiresFor && spec ? v.requiresFor(spec) : [])]) {
    const uri = runEnv[req.env] || req.fallback;
    const hp = hostPort(uri);
    if (!hp || !(await probe(hp.host, hp.port))) {
      return { status: "skipped", reason: `${req.name} is not reachable at ${uri}. ${req.hint}`, steps: [], missingService: req.name };
    }
    runEnv[req.env] = uri;
  }
  const steps = [];
  for (const [phase, cmds] of [["format", v.format || []], ["setup", (v.setupFor && spec ? v.setupFor(spec) : v.setup) || []], ["build", v.build || []], ["test", (v.testFor && spec ? v.testFor(spec) : v.test) || []]]) {
    for (const entry of cmds) {
      const [cmd, ...args] = Array.isArray(entry) ? entry : entry.cmd;
      const emptyOutput = !Array.isArray(entry) && entry.emptyOutput;
      onStep && onStep(`${phase}: ${[cmd, ...args].join(" ")}`);
      const r = await runCommand(cmd, args, { cwd: workspacePath, env: runEnv, timeoutMs: 300000 });
      steps.push({ phase, command: [cmd, ...args].join(" "), code: r.code, timedOut: !!r.timedOut, output: tail(r.stdout + "\n" + r.stderr) });
      const unformatted = emptyOutput && r.code === 0 && r.stdout.trim() !== "";
      if (r.code !== 0 || unformatted) {
        if (unformatted) steps[steps.length - 1].output = "These files are not formatted:\n" + r.stdout.trim();
        // Dependency resolution that cannot reach the network says nothing about the generated code: report it as
        // "skipped" (not verified) rather than "failed" or "passed".
        // `go mod tidy -e` tolerates an unreachable proxy (exit 0) and drops the module; the build then says "no required module
        // provides package", whose real cause is the network error recorded by the setup step.
        const missingModule = /no required module provides package|cannot find module providing package/.test(r.stdout + "\n" + r.stderr) && steps.some((x) => x.phase === "setup" && OFFLINE_RE.test(x.output || ""));
        if (v.offlineMeansSkipped && (missingModule || (phase === "setup" && OFFLINE_RE.test(r.stdout + "\n" + r.stderr)) || (["setup", "build", "test"].includes(phase) && MODULE_FETCH_RE.test(r.stdout + "\n" + r.stderr)))) {
          return { status: "skipped", reason: "dependencies could not be downloaded (network blocked); the generated code was not compiled or tested", steps };
        }
        return { status: "failed", failedPhase: phase, steps };
      }
    }
  }
  return { status: "passed", steps };
}

function hostPort(uri) {
  try {
    const u = new URL(String(uri).replace(/^(mongodb(\+srv)?|redis|rediss|amqp|amqps|postgres(ql)?|mysql|kafka):\/\//, "http://"));
    return { host: u.hostname, port: Number(u.port) || 80 };
  } catch { return null; }
}

function probeTcp(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/** Static, stack-independent checks on the generated file set. */
function checkFileSet(files, spec = null) {
  const findings = [];
  const names = Object.keys(files);
  const has = (re) => names.some((n) => re.test(n));
  if (!spec || !spec.scope || spec.scope.docker) findings.push({ check: "dockerfile", level: has(/(^|\/)Dockerfile$/) ? "pass" : "fail", detail: "Dockerfile present" });
  else findings.push({ check: "dockerfile", level: "pass", detail: "Dockerfile not requested, so not generated" });
  findings.push({ check: "readme", level: has(/^README\.md$/) ? "pass" : "fail", detail: "README.md present" });
  findings.push({ check: "env-template", level: has(/^\.env\.example$/) ? "pass" : "fail", detail: ".env.example present" });
  findings.push({ check: "tests", level: has(/(^|\/)(tests?\/|.*_test\.go$|.*\.test\.js$)/) ? "pass" : "fail", detail: "test files present" });
  const secretRe = /(JWT_SECRET|SECRET|PASSWORD|API_KEY)\s*[:=]\s*["'][^"']{8,}["']/i;
  const leaked = names.filter((n) => !/(^|\/)(tests?|.*_test\.go|.*\.test\.(js|py))/.test(n) && !/\.example$|\.md$/.test(n) && secretRe.test(files[n]));
  findings.push({ check: "hardcoded-secrets", level: leaked.length ? "fail" : "pass", detail: leaked.length ? `possible secret in ${leaked.join(", ")}` : "no hardcoded secrets found in source" });
  if (spec && spec.architecture === "modular") { const { violations, ...f } = require("./architecture").checkModules(files, spec); findings.push(f); }
  return findings;
}

module.exports = { validateStack, checkFileSet, writeFiles, hasTool, hostPort, probeTcp };
