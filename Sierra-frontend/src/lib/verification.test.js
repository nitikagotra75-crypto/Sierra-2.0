import test from "node:test";
import assert from "node:assert";
import { buildRows } from "./verification.js";

const base = { stack: "python-fastapi", verifiedAt: "2026-11-15T00:00:00Z", staticChecks: [{ check: "files", level: "pass", detail: "ok" }], levels: { blocked: [{ step: "end-to-end", reason: "not run" }] } };

test("passed validation shows passed with the test command and timestamp", () => {
  const rows = buildRows({ ...base, validation: { status: "passed", steps: [{ command: ".venv/bin/python -m pytest -q", code: 0, output: "" }] } });
  const t = rows.find((r) => r.feature.startsWith("Generated"));
  assert.equal(t.result, "passed"); assert.match(t.command, /pytest/); assert.equal(t.at, "2026-11-15T00:00:00Z");
});
test("skipped is never shown as passed; blocked rows are kept", () => {
  const rows = buildRows({ ...base, validation: { status: "skipped", reason: "toolchain 'go' is not installed", steps: [] } });
  assert.equal(rows[0].result, "skipped"); assert.match(rows[0].detail, /not installed/);
  assert.ok(rows.some((r) => r.result === "blocked" && r.feature === "end-to-end"));
});
test("failed validation carries the failing command output", () => {
  const rows = buildRows({ ...base, validation: { status: "failed", steps: [{ command: "pytest", code: 1, output: "AssertionError" }] } });
  assert.equal(rows[0].result, "failed"); assert.equal(rows[0].detail, "AssertionError");
});
test("infra and autofix rows come from the report only", () => {
  const rows = buildRows({ ...base, infraValidation: { results: [{ check: "dockerfile", tool: "hadolint", status: "passed", detail: "ok" }] }, autofix: { verified: false, status: "unresolved", attempts: 3, maxAttempts: 3, changedFiles: [], reason: "still failing" } });
  assert.equal(rows.find((r) => r.feature === "Infra: dockerfile").result, "passed");
  assert.equal(rows.find((r) => r.feature === "AI auto-fix loop").result, "failed");
});
test("schema row: LLM schema is passed, default is skipped, issues and unsupported items are shown", () => {
  const llm = buildRows({ ...base, schema: { source: "llm", issues: ["dropped field x"], unsupported: ["nested objects"], entities: [{ name: "Product", fields: [{ name: "title" }, { name: "price" }] }] } }).find((r) => r.feature === "Entity schema");
  assert.equal(llm.result, "passed"); assert.match(llm.detail, /Product\(2\)/); assert.match(llm.detail, /dropped field x/); assert.match(llm.detail, /unsupported: nested objects/);
  const def = buildRows({ ...base, schema: { source: "default", issues: ["no LLM key"], unsupported: [], entities: [{ name: "Item", fields: [{ name: "title" }] }] } }).find((r) => r.feature === "Entity schema");
  assert.equal(def.result, "skipped");
});
