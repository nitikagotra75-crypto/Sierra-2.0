const { v4: uuid } = require("uuid");
const { Project, ProjectFile, TestRun } = require("../models");
const { runPipeline } = require("../orchestrator");

async function createProject({ name, requirement, stack, database, architecture, features }) {
  if (!name || !requirement) {
    const err = new Error("name and requirement are required");
    err.statusCode = 400;
    throw err;
  }
  const projectId = uuid();
  const { registry } = require("../engine");
  if (features && (typeof features !== "object" || Array.isArray(features) || (features.events && !["kafka", "rabbitmq"].includes(features.events)))) {
    const err = new Error("features must be an object; features.events must be 'kafka' or 'rabbitmq'");
    err.statusCode = 400;
    throw err;
  }
  const stackId = stack || "node-express";
  const def = registry.get(stackId);
  if (!def) {
    const err = new Error(`unknown stack '${stackId}'`);
    err.statusCode = 400;
    throw err;
  }
  if (def.status !== "implemented") {
    const err = new Error(`stack '${stackId}' is planned but not implemented yet`);
    err.statusCode = 501;
    throw err;
  }
  if (database && def.databases.length && !def.databases.includes(database)) {
    const err = new Error(`stack '${stackId}' supports: ${def.databases.join(", ")}`);
    err.statusCode = 400;
    throw err;
  }
  return Project.create({
    projectId,
    name,
    requirement,
    techStack: { backend: def.label, stack: stackId, architecture: architecture || "monolith", database: database || def.databases[0] || null, testing: "stack-native", features: features || {} },
  });
}

async function listProjects() {
  return Project.find().sort({ createdAt: -1 }).limit(50);
}

async function getProject(projectId) {
  const project = await Project.findOne({ projectId });
  if (!project) {
    const err = new Error("not found");
    err.statusCode = 404;
    throw err;
  }
  return project;
}

async function startGeneration(projectId) {
  // Confirms the project exists, then fires the pipeline in the background.
  // Progress is delivered over SSE at /:id/events, not in this response.
  await getProject(projectId);
  runPipeline(projectId).catch((e) => console.error("[pipeline] fatal", e));
}

async function listFiles(projectId) {
  const files = await ProjectFile.find({ projectId }, "path -_id").sort({ path: 1 });
  return files.map((f) => f.path);
}

async function getFile(projectId, filePath) {
  const file = await ProjectFile.findOne({ projectId, path: filePath });
  if (!file) {
    const err = new Error("file not found");
    err.statusCode = 404;
    throw err;
  }
  return file;
}

async function getTestResults(projectId) {
  return TestRun.find({ projectId }).sort({ createdAt: 1 });
}

async function listRecentRuns(limit = 50) {
  const runs = await TestRun.find({}).sort({ createdAt: -1 }).limit(limit);
  const projects = await Project.find({});
  const nameById = Object.fromEntries(projects.map((p) => [p.projectId, p.name]));
  return runs.map((r) => {
    const plain = typeof r.toObject === "function" ? r.toObject() : r;
    return { ...plain, projectName: nameById[plain.projectId] || plain.projectId };
  });
}

async function getStatus(projectId) {
  const project = await getProject(projectId);
  return { status: project.finalStatus, report: project.report };
}

async function getSchema(projectId) {
  const project = await getProject(projectId);
  const { normalizeEntity } = require("../engine/spec");
  const a = project.analysis || {};
  const entities = (a.primaryEntities || []).map((e) => normalizeEntity(e));
  return {
    stack: project.techStack && project.techStack.stack,
    database: project.techStack && project.techStack.database,
    needsAuth: !!a.needsAuth,
    entities: [
      ...(a.needsAuth ? [{ name: "User", fields: [{ name: "email", type: "string", required: true, unique: true }, { name: "name", type: "string" }, { name: "passwordHash", type: "string", required: true, note: "never returned by the API" }] }] : []),
      ...entities.map((e) => ({ name: e.name, plural: e.plural, ownedByUser: !!a.needsAuth, fields: e.fields })),
    ],
    endpoints: project.apisCreated || [],
  };
}

async function getZip(projectId) {
  const { createZip } = require("../utils/zip");
  const project = await getProject(projectId);
  const files = await ProjectFile.find({ projectId });
  if (!files.length) { const err = new Error("no generated files yet"); err.statusCode = 404; throw err; }
  return { name: project.name, buffer: createZip(Object.fromEntries(files.map((f) => [f.path, f.content]))) };
}

module.exports = {
  getSchema,
  getZip,
  createProject,
  listProjects,
  getProject,
  startGeneration,
  listFiles,
  getFile,
  getTestResults,
  listRecentRuns,
  getStatus,
};