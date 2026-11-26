/**
 * Per-user architecture diagrams with version history.
 * - every save creates a new immutable version; the last MAX_VERSIONS are kept
 * - saves carry baseVersion (optimistic concurrency): a stale device gets 409 instead of silently overwriting
 * - everything is scoped by userId; another user's diagram id answers 404
 */
const { v4: uuid } = require("uuid");
const { Diagram, DiagramVersion } = require("../models");
const { renderSvg } = require("../design/svgRender");

const MAX_VERSIONS = 50;
const MAX_NODES = 200, MAX_EDGES = 500;
const err = (status, msg) => Object.assign(new Error(msg), { statusCode: status });

function validateGraph(g) {
  if (!g || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) throw err(422, "graph must have nodes[] and edges[]");
  if (g.nodes.length > MAX_NODES || g.edges.length > MAX_EDGES) throw err(422, `graph too large (max ${MAX_NODES} nodes, ${MAX_EDGES} edges)`);
  const ids = new Set();
  for (const n of g.nodes) {
    if (!n || typeof n.id !== "string" || typeof n.type !== "string" || !Number.isFinite(n.x) || !Number.isFinite(n.y)) throw err(422, "every node needs string id/type and numeric x/y");
    if (ids.has(n.id)) throw err(422, `duplicate node id ${n.id}`);
    ids.add(n.id);
  }
  for (const e of g.edges) {
    if (!e || typeof e.id !== "string" || !ids.has(e.from) || !ids.has(e.to)) throw err(422, `edge ${e && e.id} references a node that does not exist`);
  }
  return { nodes: g.nodes, edges: g.edges };
}

const cleanName = (n) => { const s = String(n ?? "").trim(); if (!s || s.length > 120) throw err(422, "name is required (max 120 characters)"); return s; };
const summary = (d) => ({ diagramId: d.diagramId, name: d.name, projectId: d.projectId, currentVersion: d.currentVersion, updatedAt: d.updatedAt, createdAt: d.createdAt });

async function mine(userId, diagramId) {
  const d = await Diagram.findOne({ diagramId, userId });
  if (!d) throw err(404, "Diagram not found");
  return d;
}

async function list(userId, { projectId } = {}) {
  const filter = { userId, ...(projectId ? { projectId } : {}) };
  const docs = await Diagram.find(filter).sort({ updatedAt: -1 });
  return docs.map(summary);
}

async function create(userId, { name, projectId = null, graph, requirements = null }) {
  const g = validateGraph(graph);
  const d = await Diagram.create({ diagramId: uuid(), userId, projectId: projectId || null, name: cleanName(name), currentVersion: 1 });
  await DiagramVersion.create({ diagramId: d.diagramId, version: 1, graph: g, requirements, note: "created" });
  return { ...summary(d), graph: g, requirements };
}

async function get(userId, diagramId) {
  const d = await mine(userId, diagramId);
  const v = await DiagramVersion.findOne({ diagramId, version: d.currentVersion });
  return { ...summary(d), graph: v.graph, requirements: v.requirements, note: v.note };
}

async function save(userId, diagramId, { graph, requirements, note = "", baseVersion, name }) {
  const d = await mine(userId, diagramId);
  if (baseVersion !== d.currentVersion) throw Object.assign(err(409, `Diagram changed elsewhere (current version ${d.currentVersion}, you edited ${baseVersion}). Reload to merge.`), { currentVersion: d.currentVersion });
  const g = validateGraph(graph);
  const version = d.currentVersion + 1;
  await DiagramVersion.create({ diagramId, version, graph: g, requirements: requirements ?? null, note: String(note).slice(0, 200) });
  d.currentVersion = version;
  if (name !== undefined) d.name = cleanName(name);
  d.updatedAt = new Date();
  await d.save();
  const old = await DiagramVersion.find({ diagramId }).sort({ version: 1 });
  for (const v of old.slice(0, Math.max(0, old.length - MAX_VERSIONS))) await DiagramVersion.deleteMany({ diagramId, version: v.version });
  return { ...summary(d), graph: g };
}

async function versions(userId, diagramId) {
  await mine(userId, diagramId);
  const vs = await DiagramVersion.find({ diagramId }).sort({ version: -1 });
  return vs.map((v) => ({ version: v.version, note: v.note, createdAt: v.createdAt, nodes: v.graph.nodes.length, edges: v.graph.edges.length }));
}

async function getVersion(userId, diagramId, version) {
  await mine(userId, diagramId);
  const v = await DiagramVersion.findOne({ diagramId, version: Number(version) });
  if (!v) throw err(404, "Version not found (it may have been pruned)");
  return { version: v.version, note: v.note, graph: v.graph, requirements: v.requirements, createdAt: v.createdAt };
}

async function restore(userId, diagramId, version) {
  const d = await mine(userId, diagramId);
  const v = await getVersion(userId, diagramId, version);
  return save(userId, diagramId, { graph: v.graph, requirements: v.requirements, note: `restored v${v.version}`, baseVersion: d.currentVersion });
}

async function remove(userId, diagramId) {
  await mine(userId, diagramId);
  await DiagramVersion.deleteMany({ diagramId });
  await Diagram.deleteMany({ diagramId, userId });
}

async function exportDiagram(userId, diagramId, format) {
  const d = await get(userId, diagramId);
  if (format === "json") {
    return { type: "application/json", filename: `${d.name}.architecture.json`, body: JSON.stringify({ name: d.name, version: d.currentVersion, requirements: d.requirements, graph: d.graph }, null, 2) };
  }
  if (format === "svg") return { type: "image/svg+xml", filename: `${d.name}.svg`, body: renderSvg(d.graph, { title: d.name }) };
  throw err(400, "format must be json or svg (PNG export is done in the browser)");
}

module.exports = { list, create, get, save, versions, getVersion, restore, remove, exportDiagram, validateGraph, MAX_VERSIONS };
