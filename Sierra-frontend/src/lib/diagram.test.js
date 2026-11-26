import test from "node:test";
import assert from "node:assert";
import { fromDesign, addNode, removeNode, addEdge, removeEdge, updateNode, toSvg, toDesignPayload, edgeGeometry, NODE_W, NODE_H } from "./diagram.js";

const design = {
  nodes: [
    { id: "client", type: "client", label: "Client", config: {} },
    { id: "app", type: "app-server", label: "App ×2", config: { instances: 2 } },
    { id: "db", type: "database", label: "PostgreSQL", config: { engine: "postgresql", poolSize: 20 } },
  ],
  edges: [{ id: "client->app", from: "client", to: "app", label: "HTTP", protocol: "http" }, { id: "app->db", from: "app", to: "db", label: "SQL", protocol: "tcp" }],
};

test("layout assigns finite, non-overlapping positions", () => {
  const g = fromDesign(design);
  for (const n of g.nodes) assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y));
  for (let i = 0; i < g.nodes.length; i++) for (let j = i + 1; j < g.nodes.length; j++) {
    const a = g.nodes[i], b = g.nodes[j];
    const overlap = a.x < b.x + NODE_W && b.x < a.x + NODE_W && a.y < b.y + NODE_H && b.y < a.y + NODE_H;
    assert.ok(!overlap, `${a.id} overlaps ${b.id}`);
  }
});

test("add node uses unique ids and registers config the infra generator reads", () => {
  let g = fromDesign(design);
  let r = addNode(g, "cache", { x: 10, y: 10 }); g = r.graph;
  assert.equal(g.nodes.find((n) => n.id === r.id).config.eviction, "allkeys-lru");
  r = addNode(g, "cache", { x: 20, y: 20 });
  assert.notEqual(r.id, "cache");
  assert.throws(() => addNode(g, "nope", { x: 0, y: 0 }));
});

test("removing a node removes its edges", () => {
  const g = removeNode(fromDesign(design), "app");
  assert.equal(g.edges.length, 0);
  assert.equal(g.nodes.length, 2);
});

test("addEdge rejects self, duplicate and dangling connections", () => {
  const g = fromDesign(design);
  assert.throws(() => addEdge(g, "app", "app"));
  assert.throws(() => addEdge(g, "client", "app"));
  assert.throws(() => addEdge(g, "app", "ghost"));
  const g2 = addEdge(g, "client", "db");
  assert.equal(g2.edges.length, 3);
  assert.equal(removeEdge(g2, "client->db").edges.length, 2);
});

test("config edits are reflected in the exported SVG and payload", () => {
  let g = fromDesign(design);
  g = updateNode(g, "app", { config: { instances: 7 } });
  assert.match(toSvg(g), /7 instance/);
  const p = toDesignPayload(design, g);
  assert.equal(p.nodes.find((n) => n.id === "app").config.instances, 7);
  assert.ok(p.nodes.every((n) => !("x" in n)));
});

test("svg escapes labels", () => {
  const g = updateNode(fromDesign(design), "client", { label: '<img onerror="x">' });
  assert.ok(!toSvg(g).includes("<img"));
});

test("edge geometry stays on node borders", () => {
  const g = fromDesign(design);
  const geo = edgeGeometry(g.nodes[0], g.nodes[1]);
  assert.ok(Number.isFinite(geo.x1 + geo.y1 + geo.x2 + geo.y2));
});
