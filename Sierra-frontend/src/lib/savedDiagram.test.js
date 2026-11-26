import test from "node:test";
import assert from "node:assert/strict";
import { keyFor, isGraph, loadSaved, saveGraph, clearSaved } from "./savedDiagram.js";

const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };
const graph = { nodes: [{ id: "n1", type: "cache", x: 1, y: 2, config: {} }], edges: [{ id: "e1", from: "n1", to: "n1" }] };

test("save, load and clear round-trip a graph", () => {
  const s = mem(); const k = keyFor({ description: "x", options: {} });
  assert.equal(loadSaved(k, s), null);
  assert.equal(saveGraph(k, graph, s), true);
  assert.deepEqual(loadSaved(k, s), graph);
  clearSaved(k, s);
  assert.equal(loadSaved(k, s), null);
});

test("different requirements never share a saved diagram", () => {
  assert.notEqual(keyFor({ description: "a" }), keyFor({ description: "b" }));
});

test("corrupt or foreign data is ignored, and a throwing storage never throws", () => {
  const s = mem(); s.setItem("k", "{not json"); assert.equal(loadSaved("k", s), null);
  s.setItem("k", JSON.stringify({ nodes: [{ id: 1 }], edges: [] })); assert.equal(loadSaved("k", s), null);
  assert.equal(isGraph({ nodes: [], edges: [] }), true);
  const bad = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("full"); }, removeItem() { throw new Error("blocked"); } };
  assert.equal(loadSaved("k", bad), null);
  assert.equal(saveGraph("k", graph, bad), false);
  clearSaved("k", bad);
  assert.equal(loadSaved("k", undefined), null);
});
