// Builds the rows of the verification matrix from the backend's real report. Nothing here invents a result:
// a row only says "passed" when the backend recorded a passed check.
export const LEVELS = [
  ["IMPLEMENTED", "Implemented"],
  ["STATICALLY_VALIDATED", "Static validation passed"],
  ["INTEGRATION_TESTED", "Integration tested"],
  ["END_TO_END_VERIFIED", "End-to-end verified"],
];

const lastFailing = (v) => [...(v.steps || [])].reverse().find((s) => s.code !== 0);

export function buildRows(report) {
  const rows = [];
  const stack = report.stack || "";
  const at = report.verifiedAt || null;
  const v = report.validation;
  if (v) {
    const testStep = [...(v.steps || [])].reverse().find((s) => /test|pytest|mvn|dotnet|go /.test(s.command)) || (v.steps || []).at(-1);
    const fail = lastFailing(v);
    rows.push({
      feature: "Generated project test suite", framework: stack, level: "INTEGRATION_TESTED",
      result: v.status === "passed" ? "passed" : v.status === "skipped" ? "skipped" : "failed",
      detail: v.status === "skipped" ? v.reason : fail ? fail.output : `${(v.steps || []).length} command(s) succeeded`,
      command: testStep ? testStep.command : null, at,
    });
  }
  for (const c of report.staticChecks || []) {
    rows.push({ feature: `Static check: ${c.check}`, framework: stack, level: "STATICALLY_VALIDATED", result: c.level === "pass" ? "passed" : c.level === "fail" ? "failed" : "skipped", detail: c.detail, command: null, at });
  }
  for (const r of (report.infraValidation && report.infraValidation.results) || []) {
    rows.push({ feature: `Infra: ${r.check}`, framework: r.tool, level: "STATICALLY_VALIDATED", result: r.status === "passed" ? "passed" : r.status === "failed" ? "failed" : "skipped", detail: r.detail, command: r.tool, at });
  }
  if (report.autofix) {
    const a = report.autofix;
    rows.push({ feature: "AI auto-fix loop", framework: stack, level: "INTEGRATION_TESTED", result: a.verified ? "passed" : "failed", detail: `${a.status}: ${a.attempts}/${a.maxAttempts} attempt(s), ${a.changedFiles.length} file(s) changed${a.reason ? ` - ${a.reason}` : ""}`, command: null, at });
  }
  if (report.schema) {
    const sc = report.schema;
    const ents = (sc.entities || []).map((e) => `${e.name}(${(e.fields || []).length})`).join(", ");
    const notes = [...(sc.issues || []), ...(sc.unsupported || []).map((u) => `unsupported: ${typeof u === "string" ? u : JSON.stringify(u)}`)];
    rows.push({ feature: "Entity schema", framework: stack, level: "IMPLEMENTED", result: sc.source === "llm" ? "passed" : "skipped", detail: `${sc.source === "llm" ? "designed by the LLM" : "generic default (LLM schema not used)"}: ${ents || "none"}${notes.length ? ` | ${notes.join("; ")}` : ""}`, command: null, at });
  }
  for (const b of (report.levels && report.levels.blocked) || []) {
    rows.push({ feature: b.step, framework: stack, level: null, result: "blocked", detail: b.reason, command: null, at });
  }
  return rows;
}
