const test = require("node:test");
const assert = require("node:assert");
process.env.SIERRA_AUTH_SECRET = "test-secret-at-least-16-chars";
global.__SIERRA_LOCAL_MODE__ = true;
const { createApp } = require("../src/app");
const auth = require("../src/services/authService");

let server, base;
test.before(async () => { await new Promise((r) => { server = createApp().listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());

const call = async (method, p, { token, body } = {}) => {
  const res = await fetch(base + p, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text, headers: res.headers };
};
const reg = async (email) => (await call("POST", "/api/auth/register", { body: { email, password: "password123" } })).json.token;
const graph = (extra = []) => ({ nodes: [{ id: "a", type: "app", label: "API", x: 0, y: 0 }, { id: "d", type: "db", label: "DB <x>", x: 300, y: 0 }, ...extra], edges: [{ id: "e1", from: "a", to: "d" }] });

test("auth: register, duplicate, login, bad password, me", async () => {
  const t = await reg("a@example.com");
  assert.ok(t);
  assert.equal((await call("POST", "/api/auth/register", { body: { email: "a@example.com", password: "password123" } })).status, 409);
  assert.equal((await call("POST", "/api/auth/login", { body: { email: "a@example.com", password: "wrongwrong" } })).status, 401);
  const l = await call("POST", "/api/auth/login", { body: { email: "A@example.com", password: "password123" } });
  assert.equal(l.status, 200);
  assert.equal((await call("GET", "/api/auth/me", { token: l.json.token })).json.user.email, "a@example.com");
  assert.equal((await call("POST", "/api/auth/register", { body: { email: "bad", password: "short" } })).status, 422);
});

test("tokens: tampered and expired are rejected", () => {
  const t = auth.issueToken("u1");
  assert.equal(auth.verifyToken(t), "u1");
  assert.equal(auth.verifyToken(t.slice(0, -2) + "xx"), null);
  assert.equal(auth.verifyToken(t, Date.now() + 8 * 24 * 3600 * 1000), null);
});

test("diagrams require authentication", async () => {
  assert.equal((await call("GET", "/api/diagrams")).status, 401);
  assert.equal((await call("GET", "/api/diagrams", { token: "garbage" })).status, 401);
});

test("diagram lifecycle: create, version, conflict, restore, export, delete", async () => {
  const t = await reg("life@example.com");
  const c = await call("POST", "/api/diagrams", { token: t, body: { name: "Shop", projectId: "p1", graph: graph() } });
  assert.equal(c.status, 201); assert.equal(c.json.currentVersion, 1);
  const id = c.json.diagramId;
  const s = await call("PUT", `/api/diagrams/${id}`, { token: t, body: { graph: graph([{ id: "c", type: "cache", label: "Redis", x: 150, y: 100 }]), baseVersion: 1, note: "add cache" } });
  assert.equal(s.status, 200); assert.equal(s.json.currentVersion, 2);
  const stale = await call("PUT", `/api/diagrams/${id}`, { token: t, body: { graph: graph(), baseVersion: 1 } });
  assert.equal(stale.status, 409);
  const vs = await call("GET", `/api/diagrams/${id}/versions`, { token: t });
  assert.deepEqual(vs.json.versions.map((v) => v.version), [2, 1]);
  const r = await call("POST", `/api/diagrams/${id}/restore/1`, { token: t });
  assert.equal(r.json.currentVersion, 3); assert.equal(r.json.graph.nodes.length, 2);
  assert.equal((await call("GET", `/api/diagrams/${id}`, { token: t })).json.graph.nodes.length, 2);
  const svg = await call("GET", `/api/diagrams/${id}/export?format=svg`, { token: t });
  assert.match(svg.headers.get("content-type"), /svg/); assert.ok(svg.text.includes("DB &lt;x&gt;")); assert.ok(!svg.text.includes("DB <x>"));
  const js = await call("GET", `/api/diagrams/${id}/export?format=json`, { token: t });
  assert.equal(JSON.parse(js.text).graph.nodes.length, 2);
  assert.equal((await call("GET", `/api/diagrams/${id}/export?format=png`, { token: t })).status, 400);
  assert.equal((await call("DELETE", `/api/diagrams/${id}`, { token: t })).status, 204);
  assert.equal((await call("GET", `/api/diagrams/${id}`, { token: t })).status, 404);
});

test("users are isolated; list filters by project", async () => {
  const a = await reg("iso-a@example.com"), b = await reg("iso-b@example.com");
  const d1 = (await call("POST", "/api/diagrams", { token: a, body: { name: "A1", projectId: "pa", graph: graph() } })).json;
  await call("POST", "/api/diagrams", { token: a, body: { name: "A2", projectId: "pb", graph: graph() } });
  assert.equal((await call("GET", `/api/diagrams/${d1.diagramId}`, { token: b })).status, 404);
  assert.equal((await call("PUT", `/api/diagrams/${d1.diagramId}`, { token: b, body: { graph: graph(), baseVersion: 1 } })).status, 404);
  assert.equal((await call("DELETE", `/api/diagrams/${d1.diagramId}`, { token: b })).status, 404);
  assert.equal((await call("GET", "/api/diagrams", { token: b })).json.diagrams.length, 0);
  assert.equal((await call("GET", "/api/diagrams?projectId=pa", { token: a })).json.diagrams.length, 1);
  assert.equal((await call("GET", "/api/diagrams", { token: a })).json.diagrams.length, 2);
});

test("graph validation rejects bad input", async () => {
  const t = await reg("val@example.com");
  const bad = [
    { nodes: [], edges: [{ id: "e", from: "x", to: "y" }] },
    { nodes: [{ id: "a", type: "app", x: 0, y: 0 }, { id: "a", type: "db", x: 1, y: 1 }], edges: [] },
    { nodes: [{ id: "a", type: "app", x: "0", y: 0 }], edges: [] },
    "nope",
  ];
  for (const g of bad) assert.equal((await call("POST", "/api/diagrams", { token: t, body: { name: "x", graph: g } })).status, 422);
  assert.equal((await call("POST", "/api/diagrams", { token: t, body: { name: "", graph: graph() } })).status, 422);
});

test("only the newest 50 versions are kept", async () => {
  const t = await reg("prune@example.com");
  const { diagramId } = (await call("POST", "/api/diagrams", { token: t, body: { name: "P", graph: graph() } })).json;
  for (let v = 1; v <= 52; v++) assert.equal((await call("PUT", `/api/diagrams/${diagramId}`, { token: t, body: { graph: graph(), baseVersion: v } })).status, 200);
  const vs = (await call("GET", `/api/diagrams/${diagramId}/versions`, { token: t })).json.versions;
  assert.equal(vs.length, 50); assert.equal(vs[0].version, 53); assert.equal(vs[49].version, 4);
  assert.equal((await call("GET", `/api/diagrams/${diagramId}/versions/1`, { token: t })).status, 404);
});
