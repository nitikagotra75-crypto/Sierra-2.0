"use strict";
// API gateway: path-prefix routing to the services, per-upstream circuit breaker, timeouts, request ids and
// (optionally) JWT authentication for the whole system. Zero third-party dependencies.
const http = require("node:http");
const crypto = require("node:crypto");

const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length"]);
const err = (res, status, code, message, headers = {}) => {
  const body = JSON.stringify({ error: { code, message, details: null } });
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers });
  res.end(body);
};

class Breaker {
  constructor({ threshold = 5, recoveryMs = 10000, now = Date.now } = {}) { Object.assign(this, { threshold, recoveryMs, now, failures: 0, openedAt: 0, state: "closed", probing: false }); }
  // true when a request may go to the upstream
  allow() {
    if (this.state === "open" && this.now() - this.openedAt >= this.recoveryMs) { this.state = "half_open"; this.probing = false; }
    if (this.state === "open") return false;
    if (this.state === "half_open") { if (this.probing) return false; this.probing = true; }
    return true;
  }
  success() { this.failures = 0; this.state = "closed"; this.probing = false; }
  failure() {
    this.failures++; this.probing = false;
    if (this.state === "half_open" || this.failures >= this.threshold) { this.state = "open"; this.openedAt = this.now(); }
  }
}

const b64 = (b) => Buffer.from(b).toString("base64url");
function signJwt(payload, secret, ttlSeconds, now = Date.now) {
  const iat = Math.floor(now() / 1000);
  const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64(JSON.stringify({ ...payload, iat, exp: iat + ttlSeconds }));
  return head + "." + body + "." + crypto.createHmac("sha256", secret).update(head + "." + body).digest("base64url");
}
function verifyJwt(token, secret, now = Date.now) {
  const parts = String(token).split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    if (header.alg !== "HS256") return null; // never accept "none" or other algorithms
    const want = crypto.createHmac("sha256", secret).update(parts[0] + "." + parts[1]).digest();
    const got = Buffer.from(parts[2], "base64url");
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
    const p = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    if (typeof p.exp !== "number" || p.exp <= Math.floor(now() / 1000)) return null;
    return p;
  } catch { return null; }
}

function hashPassword(pw) { const salt = crypto.randomBytes(16); return salt.toString("hex") + ":" + crypto.scryptSync(pw, salt, 32).toString("hex"); }
function checkPassword(pw, stored) {
  const [salt, hash] = String(stored).split(":");
  const got = crypto.scryptSync(pw, Buffer.from(salt, "hex"), 32);
  const want = Buffer.from(hash, "hex");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function readJson(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on("data", (c) => { n += c.length; if (n > limit) { reject(Object.assign(new Error("body too large"), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || "null")); } catch { reject(Object.assign(new Error("malformed JSON"), { status: 400 })); } });
    req.on("error", reject);
  });
}

/**
 * config: { routes: [{ name, prefix, target }], auth: bool }
 * opts:   { jwtSecret, dbPath, timeoutMs, breaker: {threshold, recoveryMs, now}, jwtTtlSeconds, now }
 */
function createGateway(config, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const now = opts.now ?? Date.now;
  const routes = [...config.routes].sort((a, b) => b.prefix.length - a.prefix.length).map((r) => ({ ...r, url: new URL(r.target), breaker: new Breaker({ ...(opts.breaker || {}), now }) }));
  let db = null;
  if (config.auth) {
    if (!opts.jwtSecret || String(opts.jwtSecret).length < 32) throw new Error("JWT_SECRET must be set (at least 32 characters) when authentication is enabled");
    const { DatabaseSync } = require("node:sqlite");
    db = new DatabaseSync(opts.dbPath || ":memory:");
    db.exec("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL)");
  }

  const match = (p) => routes.find((r) => p === r.prefix || p.startsWith(r.prefix + "/"));

  async function auth(req, res, path) {
    const creds = async () => {
      const b = await readJson(req);
      const email = b && typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
      const password = b && typeof b.password === "string" ? b.password : "";
      return { email, password };
    };
    if (path === "/api/auth/register") {
      const { email, password } = await creds();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || password.length < 8) return err(res, 422, "validation_error", "a valid email and a password of at least 8 characters are required");
      try {
        const r = db.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)").run(email, hashPassword(password));
        const body = JSON.stringify({ id: Number(r.lastInsertRowid), email });
        res.writeHead(201, { "content-type": "application/json", "content-length": Buffer.byteLength(body) }); return res.end(body);
      } catch (e) {
        if (/UNIQUE/i.test(e.message)) return err(res, 409, "conflict", "email already registered");
        throw e;
      }
    }
    const { email, password } = await creds();
    const u = db.prepare("SELECT id, password_hash FROM users WHERE email = ?").get(email);
    // run the hash either way so unknown emails cost the same as wrong passwords
    const ok = u ? checkPassword(password, u.password_hash) : (checkPassword(password, hashPassword("x")), false);
    if (!ok) return err(res, 401, "invalid_credentials", "invalid email or password");
    const body = JSON.stringify({ access_token: signJwt({ sub: String(u.id) }, opts.jwtSecret, opts.jwtTtlSeconds ?? 3600, now), token_type: "bearer" });
    res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    return res.end(body);
  }

  function proxy(req, res, route, userId) {
    if (!route.breaker.allow()) return err(res, 503, "upstream_unavailable", `${route.name} is unavailable (circuit open)`, { "retry-after": "1" });
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && k !== "x-user-id" && k !== "x-request-id") headers[k] = v; // never trust a client-supplied identity
    headers["x-request-id"] = req.id;
    headers["x-forwarded-for"] = [req.headers["x-forwarded-for"], req.socket.remoteAddress].filter(Boolean).join(", ");
    if (userId) headers["x-user-id"] = userId;
    let finished = false;
    const up = http.request({ hostname: route.url.hostname, port: route.url.port || 80, path: req.url, method: req.method, headers, timeout: timeoutMs }, (ur) => {
      finished = true;
      if (ur.statusCode >= 502 && ur.statusCode <= 504) route.breaker.failure(); else route.breaker.success();
      const out = {};
      for (const [k, v] of Object.entries(ur.headers)) if (!HOP.has(k)) out[k] = v;
      out["x-request-id"] = req.id;
      res.writeHead(ur.statusCode, out);
      ur.pipe(res);
    });
    const fail = (status, code, msg) => { if (finished || res.headersSent) { res.destroy(); return; } finished = true; route.breaker.failure(); err(res, status, code, msg); };
    up.on("timeout", () => { up.destroy(); fail(504, "upstream_timeout", `${route.name} did not answer within ${timeoutMs} ms`); });
    up.on("error", () => fail(502, "bad_gateway", `${route.name} is not reachable`));
    req.pipe(up);
  }

  async function health(res) {
    const results = {};
    await Promise.all(routes.map((r) => new Promise((resolve) => {
      const q = http.get({ hostname: r.url.hostname, port: r.url.port || 80, path: "/health", timeout: 2000 }, (ur) => { ur.resume(); results[r.name] = { status: ur.statusCode === 200 ? "ok" : "down", code: ur.statusCode, circuit: r.breaker.state }; resolve(); });
      q.on("timeout", () => q.destroy());
      q.on("error", () => { results[r.name] = { status: "down", code: null, circuit: r.breaker.state }; resolve(); });
    })));
    const ok = Object.values(results).every((r) => r.status === "ok");
    const body = JSON.stringify({ status: ok ? "ok" : "degraded", services: results });
    res.writeHead(ok ? 200 : 503, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    res.end(body);
  }

  const server = http.createServer(async (req, res) => {
    req.id = crypto.randomUUID();
    res.setHeader("x-request-id", req.id);
    try {
      const path = req.url.split("?")[0];
      if (path === "/health" && req.method === "GET") { const b = '{"status":"ok"}'; res.writeHead(200, { "content-type": "application/json" }); return res.end(b); }
      if (path === "/health/services" && req.method === "GET") return await health(res);
      if (config.auth && (path === "/api/auth/register" || path === "/api/auth/login")) {
        if (req.method !== "POST") return err(res, 405, "method_not_allowed", "use POST");
        return await auth(req, res, path);
      }
      const route = match(path);
      if (!route) return err(res, 404, "not_found", "no such route");
      let userId = null;
      if (config.auth) {
        const m = /^Bearer (.+)$/.exec(String(req.headers.authorization || ""));
        const claims = m && verifyJwt(m[1], opts.jwtSecret, now);
        if (!claims) return err(res, 401, "unauthorized", "a valid bearer token is required", { "www-authenticate": "Bearer" });
        userId = String(claims.sub);
      }
      proxy(req, res, route, userId);
    } catch (e) {
      if (e.status) return err(res, e.status, e.status === 413 ? "payload_too_large" : "bad_request", e.message);
      console.error(e);
      if (!res.headersSent) err(res, 500, "internal_error", "internal error");
    }
  });
  server.on("close", () => { if (db) db.close(); });
  return server;
}

module.exports = { createGateway, signJwt, verifyJwt, Breaker };
