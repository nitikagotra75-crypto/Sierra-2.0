"use strict";
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { createGateway, signJwt, verifyJwt } = require("../src/app");
const config = require("../routes.json");

const SECRET = "test-secret-not-for-production-0123456789";
const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));
const close = (server) => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });

// A stand-in upstream that echoes what the gateway forwarded.
function upstream(handler) {
  const s = http.createServer((req, res) => {
    if (req.url === "/health") { res.writeHead(200, { "content-type": "application/json" }); return res.end('{"status":"ok"}'); }
    handler ? handler(req, res) : (() => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() })); });
    })();
  });
  return s;
}

async function setup({ routes = config.routes, auth = config.auth, handlers = [], opts = {} } = {}) {
  const ups = routes.map((_, i) => upstream(handlers[i]));
  const ports = await Promise.all(ups.map(listen));
  const cfg = { auth, routes: routes.map((r, i) => ({ ...r, target: "http://127.0.0.1:" + ports[i] })) };
  const gw = createGateway(cfg, { jwtSecret: SECRET, timeoutMs: 400, ...opts });
  const port = await listen(gw);
  const call = (path, { method = "GET", body, token, headers = {} } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port, path, method, headers: { ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}), ...(token ? { authorization: "Bearer " + token } : {}), ...headers } }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c));
      res.on("end", () => { const text = Buffer.concat(chunks).toString(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ } resolve({ status: res.statusCode, headers: res.headers, json, text }); });
    });
    req.on("error", reject); if (data) req.write(data); req.end();
  });
  return { call, ups, ports, gw, stop: async () => { await close(gw); await Promise.all(ups.map(close)); } };
}
async function login(call, email = "a@example.com") {
  await call("/api/auth/register", { method: "POST", body: { email, password: "password123" } });
  return (await call("/api/auth/login", { method: "POST", body: { email, password: "password123" } })).json.access_token;
}

const first = config.routes[0];

test("routes by path prefix and forwards method, path, query and body", async () => {
  const s = await setup({ auth: false });
  try {
    const r = await s.call(first.prefix + "/5?x=1", { method: "POST", body: { a: 1 } });
    assert.equal(r.status, 200);
    assert.equal(r.json.method, "POST"); assert.equal(r.json.url, first.prefix + "/5?x=1"); assert.equal(r.json.body, '{"a":1}');
    assert.ok(r.headers["x-request-id"]); assert.equal(r.json.headers["x-request-id"], r.headers["x-request-id"]);
    assert.equal((await s.call("/nope")).status, 404);
    assert.equal((await s.call(first.prefix + "x")).status, 404, "prefix must match whole path segments");
  } finally { await s.stop(); }
});

test("each prefix reaches its own service", async () => {
  const handlers = config.routes.map((r) => (req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ served_by: r.name })); });
  const s = await setup({ auth: false, handlers });
  try {
    for (const r of config.routes) assert.equal((await s.call(r.prefix + "/probe")).json.served_by, r.name);
  } finally { await s.stop(); }
});

test("health: gateway liveness, and aggregated service health (503 when one is down)", async () => {
  const s = await setup({ auth: false });
  try {
    assert.equal((await s.call("/health")).status, 200);
    const ok = await s.call("/health/services");
    assert.equal(ok.status, 200); assert.equal(ok.json.status, "ok");
    assert.deepEqual(Object.keys(ok.json.services).sort(), config.routes.map((r) => r.name).sort());
    await close(s.ups[0]);
    const bad = await s.call("/health/services");
    assert.equal(bad.status, 503); assert.equal(bad.json.status, "degraded"); assert.equal(bad.json.services[config.routes[0].name].status, "down");
  } finally { await s.stop(); }
});

test("upstream down: 502, then the circuit opens (503 without touching the upstream) and half-open recovery closes it", async () => {
  let t = 0;
  const s = await setup({ auth: false, opts: { breaker: { threshold: 2, recoveryMs: 1000, now: () => t }, now: () => t } });
  const savedPort = s.ports[0];
  try {
    await close(s.ups[0]);
    assert.equal((await s.call(first.prefix)).status, 502);
    assert.equal((await s.call(first.prefix)).status, 502);
    const open = await s.call(first.prefix);
    assert.equal(open.status, 503); assert.equal(open.json.error.code, "upstream_unavailable"); assert.ok(open.headers["retry-after"]);
    // other services are unaffected by this circuit
    if (config.routes.length > 1) assert.equal((await s.call(config.routes[1].prefix)).status, 200);
    // bring the service back on the same port, wait out the recovery time: one probe is let through and closes the circuit
    const back = upstream(); await new Promise((r) => back.listen(savedPort, "127.0.0.1", r));
    t += 1500;
    assert.equal((await s.call(first.prefix)).status, 200);
    assert.equal((await s.call(first.prefix)).status, 200);
    await close(back);
  } finally { await s.stop(); }
});

test("slow upstream: 504 after the timeout", async () => {
  const s = await setup({ auth: false, handlers: [() => { /* never answers */ }] });
  try {
    const r = await s.call(first.prefix);
    assert.equal(r.status, 504); assert.equal(r.json.error.code, "upstream_timeout");
  } finally { await s.stop(); }
});

test("a client cannot forge the identity header or request id", async () => {
  const s = await setup({ auth: false });
  try {
    const r = await s.call(first.prefix, { headers: { "x-user-id": "999", "x-request-id": "forged" } });
    assert.equal(r.json.headers["x-user-id"], undefined);
    assert.notEqual(r.json.headers["x-request-id"], "forged");
  } finally { await s.stop(); }
});

test("jwt: signature, expiry and algorithm are enforced", () => {
  const good = signJwt({ sub: "1" }, SECRET, 60);
  assert.equal(verifyJwt(good, SECRET).sub, "1");
  assert.equal(verifyJwt(good, SECRET + "x"), null);
  assert.equal(verifyJwt(good.slice(0, -2) + "xx", SECRET), null);
  let t = Date.now();
  const short = signJwt({ sub: "1" }, SECRET, 1, () => t);
  assert.ok(verifyJwt(short, SECRET, () => t));
  assert.equal(verifyJwt(short, SECRET, () => t + 5000), null);
  const none = Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url") + "." + Buffer.from('{"sub":"1","exp":9999999999}').toString("base64url") + ".";
  assert.equal(verifyJwt(none, SECRET), null);
  assert.equal(verifyJwt("garbage", SECRET), null);
});

if (config.auth) {
  test("auth: register, duplicate, validation, login, bad credentials", async () => {
    const s = await setup();
    try {
      const reg = await s.call("/api/auth/register", { method: "POST", body: { email: "A@Example.com", password: "password123" } });
      assert.equal(reg.status, 201); assert.equal(reg.json.email, "a@example.com"); assert.equal(reg.json.password_hash, undefined);
      assert.equal((await s.call("/api/auth/register", { method: "POST", body: { email: "a@example.com", password: "password123" } })).status, 409);
      assert.equal((await s.call("/api/auth/register", { method: "POST", body: { email: "bad", password: "password123" } })).status, 422);
      assert.equal((await s.call("/api/auth/register", { method: "POST", body: { email: "b@example.com", password: "short" } })).status, 422);
      const ok = await s.call("/api/auth/login", { method: "POST", body: { email: "a@example.com", password: "password123" } });
      assert.equal(ok.status, 200); assert.ok(ok.json.access_token);
      assert.equal((await s.call("/api/auth/login", { method: "POST", body: { email: "a@example.com", password: "wrong-password" } })).status, 401);
      assert.equal((await s.call("/api/auth/login", { method: "POST", body: { email: "nobody@example.com", password: "password123" } })).status, 401);
      assert.equal((await s.call("/api/auth/login", { method: "GET" })).status, 405);
      assert.equal((await s.call("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: undefined })).status, 422);
    } finally { await s.stop(); }
  });

  test("auth: every service route needs a valid token; the user id is forwarded", async () => {
    const s = await setup();
    try {
      assert.equal((await s.call(first.prefix)).status, 401);
      assert.equal((await s.call(first.prefix, { token: "garbage" })).status, 401);
      assert.equal((await s.call(first.prefix, { token: signJwt({ sub: "1" }, "another-secret-another-secret-123456", 60) })).status, 401);
      const token = await login(s.call);
      const r = await s.call(first.prefix, { token });
      assert.equal(r.status, 200);
      assert.match(r.json.headers["x-user-id"], /^\d+$/);
      assert.equal((await s.call("/health")).status, 200, "health stays public");
    } finally { await s.stop(); }
  });

  test("auth: refuses to start without a strong JWT secret", () => {
    assert.throws(() => createGateway(config, { jwtSecret: "short" }), /JWT_SECRET/);
    assert.throws(() => createGateway(config, {}), /JWT_SECRET/);
  });
}
