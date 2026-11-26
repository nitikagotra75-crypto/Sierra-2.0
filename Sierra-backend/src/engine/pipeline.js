/**
 * Generation pipeline for non-legacy stacks. Honest by construction:
 *  - status VERIFIED only when the stack's own test suite really ran and passed;
 *  - status NOT_VERIFIED when validation was skipped (missing toolchain) or static checks failed;
 *  - status FAILED when generation or the test suite failed.
 */
const path = require("path");
const { Project, ProjectFile } = require("../models");
const { emitEvent } = require("../sse");
const { analyzeRequirement } = require("../agents/requirementAgent");
const exec = require("../execution/executionManager");
const { registry, buildSpec } = require("./index");
const { validateStack, checkFileSet } = require("./validate");
const { validateInfra } = require("../design/infraValidate");
const { computeLevels } = require("./levels");
const { autoFix, llmFixer } = require("./autofix");
const { designSchema } = require("./schemaAgent");

async function runEnginePipeline(projectId, { fixer, schemaAsk, maxFixAttempts = Number(process.env.SIERRA_MAX_FIX_ATTEMPTS || 3) } = {}) {
  const project = await Project.findOne({ projectId });
  const ev = (type, icon, text, extra) => emitEvent(projectId, { type, icon, text, ...extra });
  const stackId = project.techStack.stack;
  const stack = registry.get(stackId);

  project.finalStatus = "RUNNING";
  await project.save();
  try {
    ev("step", "›", "Analyzing requirements...");
    const analysis = await analyzeRequirement(project.requirement);
    project.analysis = analysis;
    ev("ok", "✓", `Requirements analyzed (${analysis.source === "llm" ? "via Claude" : "heuristic parser"})`);

    const schema = await designSchema(project.requirement, { ask: schemaAsk });
    if (schema.source !== "default") {
      analysis.primaryEntities = schema.entities;
      analysis.entities = [...new Set([...(analysis.needsAuth ? ["User"] : []), ...schema.entities.map((e) => e.name)])];
      project.analysis = analysis;
    }
    analysis.schemaSource = schema.source;
    ev(schema.issues.length && schema.source === "default" ? "step" : "ok", schema.source !== "default" ? "✓" : "›", schema.source !== "default" ? `Schema ${schema.source === "llm" ? "designed by the LLM" : "read from the requirement"}: ${schema.entities.map((e) => `${e.name}(${e.fields.length})`).join(", ")}${schema.issues.length ? ` — ${schema.issues.length} issue(s) reported` : ""}` : `Schema: generic entity (${schema.issues[0]})`);

    const spec = buildSpec({
      projectName: project.name,
      analysis,
      options: { stack: stackId, database: project.techStack.database, architecture: project.techStack.architecture, features: project.techStack.features },
    });
    ev("step", "›", `Generating ${stack.label} backend...`);
    const scope = require("./scope").scopeFor(project.requirement, { architecture: spec.architecture });
    spec.scope = scope;
    let files = require("./scope").applyScope(registry.generate(spec), scope);
    await ProjectFile.deleteMany({ projectId });
    await ProjectFile.insertMany(Object.entries(files).map(([p, content]) => ({ projectId, path: p, content })));
    project.generatedFiles = Object.keys(files);
    project.apisCreated = [
      ...(spec.needsAuth ? ["POST /api/auth/register", "POST /api/auth/login"] : []),
      ...spec.entities.flatMap((e) => ["GET", "POST"].map((m) => `${m} /api/${e.plural}`).concat(["GET", "PUT", "DELETE"].map((m) => `${m} /api/${e.plural}/:id`))),
    ];
    project.modelsCreated = [...(spec.needsAuth ? ["User"] : []), ...spec.entities.map((e) => e.name)];
    ev("ok", "✓", `Files generated (${Object.keys(files).length} files)`);

    const workspacePath = path.join(exec.WORKSPACES_ROOT, projectId);
    project.workspacePath = workspacePath;
    await exec.writeFiles(workspacePath, files);

    ev("step", "›", `Validating with the ${stack.validate.toolchain} toolchain...`);
    let validation = await validateStack(stack, workspacePath, { spec, onStep: (t) => ev("step", "›", t) });
    let autofixReport = null;
    const activeFixer = fixer || llmFixer();
    if (validation.status === "failed" && activeFixer && maxFixAttempts > 0) {
      ev("step", "›", `Validation failed; running the auto-fix loop (max ${maxFixAttempts} attempts)...`);
      autofixReport = await autoFix({ stack, workspacePath, files, spec, fixer: activeFixer, maxAttempts: maxFixAttempts, onEvent: (e) => ev("step", "›", `Auto-fix attempt ${e.attempt}: ${e.phase} failed (${e.command})`) });
      files = autofixReport.files;
      validation = autofixReport.validation;
      delete autofixReport.files;
      delete autofixReport.validation;
      if (autofixReport.changedFiles.length) {
        await ProjectFile.deleteMany({ projectId });
        await ProjectFile.insertMany(Object.entries(files).map(([p, content]) => ({ projectId, path: p, content })));
      }
      ev(autofixReport.verified ? "ok" : "error", autofixReport.verified ? "✓" : "✗", `Auto-fix ${autofixReport.status}: ${autofixReport.changedFiles.length} file(s) changed in ${autofixReport.attempts} attempt(s)`);
    }
    if (validation.status === "passed") ev("ok", "✓", "Stack test suite passed");
    else if (validation.status === "skipped") ev("step", "!", `Validation skipped: ${validation.reason}`);
    else ev("error", "✗", `Validation failed at: ${validation.steps[validation.steps.length - 1].command}`);

    const staticChecks = checkFileSet(files, spec);
    const staticFailed = staticChecks.some((c) => c.level === "fail");
    const infra = validateInfra(Object.fromEntries(Object.entries(files).filter(([n]) => /(^|\/)(Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|\.github\/workflows\/[^/]+\.ya?ml)$/.test(n))));
    if (infra.status === "failed") ev("error", "✗", `Infra validation failed: ${infra.results.filter((r) => r.status === "failed").map((r) => r.check).join(", ")}`);
    else ev("ok", "✓", `Infra validation: ${infra.summary}`);
    const levels = computeLevels({ validation, staticChecks, infra });

    const status = validation.status === "failed" ? "FAILED" : validation.status === "passed" && !staticFailed && infra.status !== "failed" ? "VERIFIED" : "NOT_VERIFIED";
    const report = {
      engine: "v2",
      verifiedAt: new Date().toISOString(),
      stack: stackId,
      database: spec.database || stack.databases[0],
      filesGenerated: Object.keys(files).length,
      validation,
      staticChecks,
      infraValidation: infra,
      autofix: autofixReport,
      schema: { source: schema.source, issues: schema.issues, unsupported: schema.unsupported, entities: spec.entities.map((e) => ({ name: e.name, fields: e.fields.map((f) => ({ name: f.name, type: f.type, required: f.required, references: f.references || null })) })) },
      levels,
      apisCreated: project.apisCreated,
      modelsCreated: project.modelsCreated,
      status,
      disclaimer:
        "VERIFIED means the stack's generated test suite was executed here and passed. It does not mean production-ready: no load testing, security audit or real-database integration test was performed.",
    };
    project.finalStatus = status;
    project.report = report;
    await project.save();
    ev("final", status === "VERIFIED" ? "✓" : status === "FAILED" ? "✗" : "!", `Backend ${status}`, { report });
    return report;
  } catch (err) {
    const report = { engine: "v2", status: "FAILED", reason: err.message };
    project.finalStatus = "FAILED";
    project.report = report;
    await project.save();
    ev("error", "✗", `Pipeline error: ${err.message}`);
    ev("final", "✗", `Backend FAILED: ${err.message}`, { report });
    return report;
  }
}

module.exports = { runEnginePipeline };
