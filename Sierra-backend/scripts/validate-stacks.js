#!/usr/bin/env node
/**
 * Generates every implemented stack (auth on/off) and runs its real validation (format, build, the project's own tests).
 *
 *   node scripts/validate-stacks.js                 # report; skipped stacks are listed, exit 0 unless something FAILED
 *   node scripts/validate-stacks.js --strict        # CI mode: a SKIPPED stack (missing toolchain/network/service) fails the run
 *   node scripts/validate-stacks.js --stack go-gin  # one stack (repeatable)
 *   node scripts/validate-stacks.js --out report.json
 *
 * Statuses are never merged: PASSED, FAILED and SKIPPED are separate, and SKIPPED is never reported as passing.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { registry, buildSpec } = require("../src/engine");
const { validateStack, writeFiles } = require("../src/engine/validate");

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const only = args.flatMap((a, i) => (a === "--stack" ? [args[i + 1]] : []));
const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;

const analysis = (needsAuth) => ({
  needsAuth,
  // One entity that exercises every field type, including non-zero defaults (a past bug class: Go failed to compile bool defaults).
  primaryEntities: [{ name: "Task", fields: [
    { name: "title", type: "string", required: true }, { name: "notes", type: "text", required: false },
    { name: "done", type: "bool", required: false, default: true }, { name: "priority", type: "int", required: false, default: 3 },
    { name: "score", type: "float", required: false, default: 0.5 }, { name: "status", type: "enum", values: ["open", "closed"], required: false, default: "open" },
  ] }],
});

(async () => {
  const rows = [];
  for (const info of registry.list().filter((s) => s.status === "implemented" && (!only.length || only.includes(s.id)))) {
    for (const needsAuth of [true, false]) {
      const stack = registry.get(info.id);
      const spec = buildSpec({ projectName: "Validation Demo", analysis: analysis(needsAuth), options: { stack: info.id } });
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sierra-vs-${info.id}-`));
      const t0 = Date.now();
      await writeFiles(dir, registry.generate(spec));
      const res = await validateStack(stack, dir, {});
      fs.rmSync(dir, { recursive: true, force: true });
      const failedStep = res.steps.find((s) => s.code !== 0 || s.output.startsWith("These files are not formatted"));
      rows.push({ stack: info.id, auth: needsAuth, status: res.status.toUpperCase(), seconds: Math.round((Date.now() - t0) / 1000), reason: res.reason || null, failedPhase: res.failedPhase || null, failedCommand: failedStep ? failedStep.command : null, output: res.status === "failed" && failedStep ? failedStep.output : null });
      const r = rows[rows.length - 1];
      console.log(`${r.status.padEnd(8)} ${r.stack.padEnd(14)} auth=${String(needsAuth).padEnd(5)} ${r.seconds}s${r.reason ? "  " + r.reason : ""}${r.failedCommand ? "  failed: " + r.failedCommand : ""}`);
      if (r.output) console.log(r.output.split("\n").map((l) => "    " + l).join("\n"));
    }
  }
  const count = (s) => rows.filter((r) => r.status === s).length;
  console.log(`\nPASSED ${count("PASSED")}  FAILED ${count("FAILED")}  SKIPPED ${count("SKIPPED")}`);
  if (out) fs.writeFileSync(out, JSON.stringify({ strict, rows }, null, 2));
  const bad = count("FAILED") > 0 || (strict && count("SKIPPED") > 0);
  if (strict && count("SKIPPED")) console.log("--strict: skipped validations are treated as failures (the toolchain, network or service was unavailable).");
  process.exit(bad ? 1 : 0);
})();
