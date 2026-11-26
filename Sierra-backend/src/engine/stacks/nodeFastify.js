/**
 * Fastify generator (CommonJS, Node >= 22.13). Persistence uses the built-in node:sqlite module so the
 * generated project needs no native build step. Layers: routes -> services -> repositories.
 * OpenAPI JSON is produced by @fastify/swagger from the route schemas.
 */
const JSON_TYPE = { string: "string", text: "string", int: "integer", float: "number", bool: "boolean", enum: "string" };
const SQL_TYPE = { string: "TEXT", text: "TEXT", int: "INTEGER", float: "REAL", bool: "INTEGER", enum: "TEXT" };
const sample = (f, n = 1) => {
  switch (f.type) {
    case "string": case "text": return JSON.stringify(`${f.name} ${n}`);
    case "int": return String(n);
    case "float": return `${n}.5`;
    case "bool": return "true";
    case "enum": return JSON.stringify(f.values[0]);
  }
};

const j = (v) => JSON.stringify(v);

function entityFiles(spec, e) {
  const A = spec.needsAuth;
  const fields = e.fields.map((f) => ({ name: f.name, type: f.type, required: !!f.required, ...(f.default !== undefined ? { default: f.default } : {}), ...(f.values ? { values: f.values } : {}) }));
  const props = Object.fromEntries(e.fields.map((f) => {
    const p = { type: JSON_TYPE[f.type] };
    if (f.type === "string" && f.required) p.minLength = 1;
    if (f.type === "enum") p.enum = f.values;
    return [f.name, p];
  }));
  const required = e.fields.filter((f) => f.required && f.default === undefined).map((f) => f.name);
  const readProps = { id: { type: "integer" }, ...props, ...(A ? { owner_id: { type: "integer" } } : {}), created_at: { type: "string" } };
  const first = e.fields.find((f) => f.required && f.type === "string") || e.fields[0];
  const files = {};
  files[`src/entities/${e.lower}.js`] = `module.exports = {
  table: ${j(e.plural.replace(/-/g, "_"))},
  route: ${j(e.plural)},
  tag: ${j(e.name)},
  owned: ${A},
  fields: ${JSON.stringify(fields, null, 2).replace(/\n/g, "\n  ")},
  schemas: {
    create: { type: "object", additionalProperties: false, properties: ${JSON.stringify(props)}, required: ${j(required)} },
    update: { type: "object", additionalProperties: false, properties: ${JSON.stringify(props)} },
    read: { type: "object", properties: ${JSON.stringify(readProps)} },
  },
};
`;
  const H = A ? ", headers: auth" : "";
  const payload = "{ " + e.fields.filter((f) => f.required || f.default === undefined).map((f) => `${f.name}: ${sample(f, 1)}`).join(", ") + " }";
  const upd = first.type === "string" ? `{ ${first.name}: "changed" }` : `{ ${first.name}: ${sample(first, 9)} }`;
  const updCheck = first.type === "string" ? `"changed"` : sample(first, 9);
  files[`test/${e.lower}.test.js`] = `const test = require("node:test");
const assert = require("node:assert");
const { build${A ? ", login" : ""} } = require("./helpers");

test("${e.lower} CRUD", async () => {
  const app = await build();
  ${A ? "const auth = await login(app, \"user@example.com\");\n  " : ""}const created = await app.inject({ method: "POST", url: "/api/${e.plural}", payload: ${payload}${H} });
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().id;
  const list = await app.inject({ method: "GET", url: "/api/${e.plural}"${H} });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().length, 1);
  assert.equal((await app.inject({ method: "GET", url: \`/api/${e.plural}/\${id}\`${H} })).statusCode, 200);
  const updated = await app.inject({ method: "PUT", url: \`/api/${e.plural}/\${id}\`, payload: ${upd}${H} });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal(updated.json().${first.name}, ${updCheck});
  assert.equal((await app.inject({ method: "DELETE", url: \`/api/${e.plural}/\${id}\`${H} })).statusCode, 204);
  assert.equal((await app.inject({ method: "GET", url: \`/api/${e.plural}/\${id}\`${H} })).statusCode, 404);
  await app.close();
});

test("${e.lower} validation and pagination errors use the standard shape", async () => {
  const app = await build();
  ${A ? "const auth = await login(app, \"user@example.com\");\n  " : ""}const bad = await app.inject({ method: "POST", url: "/api/${e.plural}", payload: {}${H} });
  assert.equal(bad.statusCode, 422);
  assert.equal(bad.json().error.code, "validation_error");
  const page = await app.inject({ method: "GET", url: "/api/${e.plural}?limit=0"${H} });
  assert.equal(page.statusCode, 422);
  await app.close();
});
${A ? `
test("${e.lower} requires auth and is isolated per user", async () => {
  const app = await build();
  assert.equal((await app.inject({ method: "GET", url: "/api/${e.plural}" })).statusCode, 401);
  const one = await login(app, "one@example.com");
  const created = await app.inject({ method: "POST", url: "/api/${e.plural}", payload: ${payload}, headers: one });
  const two = await login(app, "two@example.com");
  const other = await app.inject({ method: "GET", url: \`/api/${e.plural}/\${created.json().id}\`, headers: two });
  assert.equal(other.statusCode, 404);
  await app.close();
});
` : ""}`;
  return files;
}

const BASE = {
  "src/config.js": (spec) => `function load(env = process.env) {
  const cfg = {
    port: Number(env.PORT || 3000),
    host: env.HOST || "0.0.0.0",
    dbPath: env.DATABASE_PATH || "./data/app.db",
    logLevel: env.LOG_LEVEL || "info",
    jwtSecret: env.JWT_SECRET || "",
  };
  ${spec.needsAuth ? `if (!cfg.jwtSecret) throw new Error("JWT_SECRET must be set");` : ""}
  return cfg;
}
module.exports = { load };
`,
  "src/errors.js": () => `class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
const notFound = (what) => new AppError(404, "not_found", \`\${what} not found\`);
const conflict = (msg) => new AppError(409, "conflict", msg);
const unauthorized = (msg = "Invalid or missing credentials") => new AppError(401, "unauthorized", msg);
const validation = (details) => new AppError(422, "validation_error", "Request validation failed", details);
const body = (code, message, details = null) => ({ error: { code, message, details } });
module.exports = { AppError, notFound, conflict, unauthorized, validation, body };
`,
  "src/db.js": () => `const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

function openDb(file) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}
module.exports = { openDb };
`,
  "src/repositories/base.js": (spec) => `const SQL = { string: "TEXT", text: "TEXT", int: "INTEGER", float: "REAL", bool: "INTEGER", enum: "TEXT" };
// Table/column names come from generation-time constants, never from request data; values are always bound parameters.
const q = (id) => '"' + String(id).replace(/"/g, '""') + '"';

class Repository {
  constructor(db, meta) {
    this.db = db;
    this.meta = meta;
    const cols = meta.fields.map((f) => \`\${q(f.name)} \${SQL[f.type]}\${f.required ? " NOT NULL" : ""}\`);
    db.exec(\`CREATE TABLE IF NOT EXISTS \${q(meta.table)} (id INTEGER PRIMARY KEY AUTOINCREMENT, \${cols.join(", ")}\${meta.owned ? ", owner_id INTEGER NOT NULL REFERENCES users(id)" : ""}, created_at TEXT NOT NULL)\`);
  }

  _out(row) {
    if (!row) return null;
    const out = { ...row };
    for (const f of this.meta.fields) if (f.type === "bool" && out[f.name] !== null) out[f.name] = !!out[f.name];
    return out;
  }

  _in(f, v) { return f.type === "bool" && v !== null && v !== undefined ? (v ? 1 : 0) : v ?? null; }

  list({ ownerId, limit, offset }) {
    const where = this.meta.owned ? "WHERE owner_id = ?" : "";
    const params = this.meta.owned ? [ownerId, limit, offset] : [limit, offset];
    return this.db.prepare(\`SELECT * FROM \${q(this.meta.table)} \${where} ORDER BY id DESC LIMIT ? OFFSET ?\`).all(...params).map((r) => this._out(r));
  }

  get(id, ownerId) {
    const where = this.meta.owned ? "AND owner_id = ?" : "";
    return this._out(this.db.prepare(\`SELECT * FROM \${q(this.meta.table)} WHERE id = ? \${where}\`).get(...(this.meta.owned ? [id, ownerId] : [id])));
  }

  create(data, ownerId) {
    const names = this.meta.fields.map((f) => f.name);
    const values = this.meta.fields.map((f) => this._in(f, data[f.name] !== undefined ? data[f.name] : f.default));
    const cols = [...names, ...(this.meta.owned ? ["owner_id"] : []), "created_at"].map(q);
    const params = [...values, ...(this.meta.owned ? [ownerId] : []), new Date().toISOString()];
    const info = this.db.prepare(\`INSERT INTO \${q(this.meta.table)} (\${cols.join(", ")}) VALUES (\${params.map(() => "?").join(", ")})\`).run(...params);
    return this.get(Number(info.lastInsertRowid), ownerId);
  }

  update(id, data, ownerId) {
    const fields = this.meta.fields.filter((f) => data[f.name] !== undefined);
    if (fields.length) {
      const sets = fields.map((f) => \`\${q(f.name)} = ?\`).join(", ");
      const where = this.meta.owned ? "AND owner_id = ?" : "";
      this.db.prepare(\`UPDATE \${q(this.meta.table)} SET \${sets} WHERE id = ? \${where}\`).run(...fields.map((f) => this._in(f, data[f.name])), id, ...(this.meta.owned ? [ownerId] : []));
    }
    return this.get(id, ownerId);
  }

  delete(id, ownerId) {
    const where = this.meta.owned ? "AND owner_id = ?" : "";
    this.db.prepare(\`DELETE FROM \${q(this.meta.table)} WHERE id = ? \${where}\`).run(...(this.meta.owned ? [id, ownerId] : [id]));
  }
}
module.exports = { Repository };
`,
  "src/services/crud.js": () => `const { notFound } = require("../errors");

class CrudService {
  constructor(repo, label) { this.repo = repo; this.label = label; }
  list(ownerId, limit, offset) { return this.repo.list({ ownerId, limit, offset }); }
  get(id, ownerId) {
    const row = this.repo.get(id, ownerId);
    if (!row) throw notFound(this.label);
    return row;
  }
  create(data, ownerId) { return this.repo.create(data, ownerId); }
  update(id, data, ownerId) { this.get(id, ownerId); return this.repo.update(id, data, ownerId); }
  delete(id, ownerId) { this.get(id, ownerId); this.repo.delete(id, ownerId); }
}
module.exports = { CrudService };
`,
  "src/routes/crud.js": (spec) => `const { Repository } = require("../repositories/base");
const { CrudService } = require("../services/crud");

const idParam = { type: "object", properties: { id: { type: "integer" } }, required: ["id"] };
const pageQuery = { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 200, default: 50 }, offset: { type: "integer", minimum: 0, default: 0 } } };

module.exports = function crudRoutes(meta) {
  return async function (app) {
    const service = new CrudService(new Repository(app.db, meta), meta.tag);
    const pre = meta.owned ? { preHandler: app.authenticate } : {};
    const owner = (req) => (meta.owned ? req.user.id : null);
    const sec = meta.owned ? { security: [{ bearer: [] }] } : {};
    const base = \`/api/\${meta.route}\`;

    app.get(base, { ...pre, schema: { tags: [meta.tag], ...sec, querystring: pageQuery, response: { 200: { type: "array", items: meta.schemas.read } } } }, async (req) => service.list(owner(req), req.query.limit, req.query.offset));
    app.post(base, { ...pre, schema: { tags: [meta.tag], ...sec, body: meta.schemas.create, response: { 201: meta.schemas.read } } }, async (req, reply) => reply.code(201).send(service.create(req.body, owner(req))));
    app.get(\`\${base}/:id\`, { ...pre, schema: { tags: [meta.tag], ...sec, params: idParam, response: { 200: meta.schemas.read } } }, async (req) => service.get(req.params.id, owner(req)));
    app.put(\`\${base}/:id\`, { ...pre, schema: { tags: [meta.tag], ...sec, params: idParam, body: meta.schemas.update, response: { 200: meta.schemas.read } } }, async (req) => service.update(req.params.id, req.body, owner(req)));
    app.delete(\`\${base}/:id\`, { ...pre, schema: { tags: [meta.tag], ...sec, params: idParam } }, async (req, reply) => { service.delete(req.params.id, owner(req)); return reply.code(204).send(); });
  };
};
`,
  "src/routes/auth.js": () => `const bcrypt = require("bcryptjs");
const { conflict, unauthorized } = require("../errors");

const userRead = { type: "object", properties: { id: { type: "integer" }, email: { type: "string" }, name: { type: "string" }, created_at: { type: "string" } } };

module.exports = async function authRoutes(app) {
  const db = app.db;
  db.exec("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', password_hash TEXT NOT NULL, created_at TEXT NOT NULL)");
  const byEmail = (email) => db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, created_at: u.created_at });

  app.post("/api/auth/register", { schema: { tags: ["auth"], body: { type: "object", additionalProperties: false, required: ["email", "password"], properties: { email: { type: "string", pattern: "^[^@\\\\s]+@[^@\\\\s]+\\\\.[^@\\\\s]+$", maxLength: 255 }, name: { type: "string", maxLength: 255 }, password: { type: "string", minLength: 8, maxLength: 72 } } }, response: { 201: userRead } } }, async (req, reply) => {
    const email = req.body.email.toLowerCase();
    if (byEmail(email)) throw conflict("Email already registered");
    const info = db.prepare("INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)").run(email, req.body.name || "", bcrypt.hashSync(req.body.password, 10), new Date().toISOString());
    return reply.code(201).send(publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(Number(info.lastInsertRowid))));
  });

  app.post("/api/auth/login", { schema: { tags: ["auth"], body: { type: "object", additionalProperties: false, required: ["email", "password"], properties: { email: { type: "string" }, password: { type: "string" } } } } }, async (req) => {
    const u = byEmail(req.body.email.toLowerCase());
    if (!u || !bcrypt.compareSync(req.body.password, u.password_hash)) throw unauthorized("Invalid email or password");
    return { access_token: app.jwt.sign({ sub: String(u.id) }, { expiresIn: "1h" }), token_type: "bearer" };
  });

  app.get("/api/auth/me", { preHandler: app.authenticate, schema: { tags: ["auth"], security: [{ bearer: [] }], response: { 200: userRead } } }, async (req) => publicUser(req.user));
};
`,
};

function appJs(spec) {
  const A = spec.needsAuth;
  return `const Fastify = require("fastify");
const { openDb } = require("./db");
const { AppError, unauthorized, body } = require("./errors");
${A ? 'const bcryptCheck = require("bcryptjs"); void bcryptCheck;\n' : ""}
async function buildApp({ dbPath = ":memory:", jwtSecret = "", logger = false } = {}) {
  const app = Fastify({ logger, ajv: { customOptions: { allErrors: true, coerceTypes: "array", useDefaults: true, removeAdditional: false } } });
  app.decorate("db", openDb(dbPath));
  app.addHook("onClose", async () => app.db.close());

  await app.register(require("@fastify/swagger"), { openapi: { info: { title: ${j(spec.name)}, version: "1.0.0" }, components: { securitySchemes: { bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" } } } } });
${A ? `  await app.register(require("@fastify/jwt"), { secret: jwtSecret });
  app.decorate("authenticate", async (req) => {
    let payload;
    try { payload = await req.jwtVerify(); } catch { throw unauthorized(); }
    const user = app.db.prepare("SELECT * FROM users WHERE id = ?").get(Number(payload.sub));
    if (!user) throw unauthorized();
    req.user = user;
  });
` : ""}
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send(body(err.code, err.message, err.details));
    if (err.validation) return reply.code(422).send(body("validation_error", "Request validation failed", err.validation.map((v) => ({ loc: [err.validationContext, v.instancePath || v.params?.missingProperty || ""], msg: v.message }))));
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send(body("http_error", err.message));
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send(body("internal_error", "Internal server error"));
  });
  app.setNotFoundHandler((req, reply) => reply.code(404).send(body("http_error", "Route not found")));

  app.get("/health", { schema: { tags: ["meta"] } }, async () => ({ status: "ok" }));
  // In-process request counters (Prometheus text). Per process; reset on restart.
  const counts = new Map();
  app.addHook("onResponse", async (req, reply) => {
    const key = JSON.stringify([req.method, req.routeOptions?.url || "unmatched", String(reply.statusCode)]);
    const cur = counts.get(key) || { n: 0, s: 0 };
    cur.n += 1; cur.s += reply.elapsedTime / 1000;
    counts.set(key, cur);
  });
  app.get("/metrics", { schema: { hide: true } }, async (req, reply) => {
    const esc = (v) => String(v).replace(/\\\\/g, "\\\\\\\\").replace(/"/g, '\\\\"');
    const rows = [...counts.entries()].sort().map(([k, v]) => [JSON.parse(k), v]);
    const lbl = ([m, r, st]) => \`method="\${m}",route="\${esc(r)}",status="\${st}"\`;
    const out = ["# HELP http_requests_total Requests handled, by method, route template and status.", "# TYPE http_requests_total counter",
      ...rows.map(([k, v]) => \`http_requests_total{\${lbl(k)}} \${v.n}\`),
      "# HELP http_request_duration_seconds_sum Total time spent handling requests.", "# TYPE http_request_duration_seconds_sum counter",
      ...rows.map(([k, v]) => \`http_request_duration_seconds_sum{\${lbl(k)}} \${v.s.toFixed(6)}\`)];
    return reply.type("text/plain; version=0.0.4").send(out.join("\\n") + "\\n");
  });
  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());
${A ? '  await app.register(require("./routes/auth"));\n' : ""}${spec.entities.map((e) => `  await app.register(require("./routes/crud")(require("./entities/${e.lower}")));`).join("\n")}
  return app;
}

module.exports = { buildApp };
`;
}

function generate(spec) {
  const f = {};
  const A = spec.needsAuth;
  f["package.json"] = JSON.stringify({
    name: spec.slug, version: "1.0.0", private: true, main: "src/server.js", engines: { node: ">=22.13" },
    scripts: { start: "node src/server.js", test: "node --test test/*.test.js" },
    dependencies: { fastify: "^5.0.0", "@fastify/swagger": "^9.0.0", ...(A ? { "@fastify/jwt": "^9.0.0", bcryptjs: "^2.4.3" } : {}) },
  }, null, 2) + "\n";
  for (const [p, fn] of Object.entries(BASE)) {
    if (!A && p === "src/routes/auth.js") continue;
    f[p] = fn(spec);
  }
  f["src/app.js"] = appJs(spec);
  f["src/server.js"] = `const { load } = require("./config");
const { buildApp } = require("./app");

async function main() {
  const cfg = load();
  const app = await buildApp({ dbPath: cfg.dbPath, jwtSecret: cfg.jwtSecret, logger: { level: cfg.logLevel } });
  const stop = async (signal) => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  await app.listen({ port: cfg.port, host: cfg.host });
}
main().catch((err) => { console.error(err); process.exit(1); });
`;
  f["test/helpers.js"] = `const { buildApp } = require("../src/app");

async function build() {
  const app = await buildApp({ dbPath: ":memory:", jwtSecret: "test-secret-not-for-production-0123456789" });
  await app.ready();
  return app;
}
${A ? `
async function login(app, email) {
  await app.inject({ method: "POST", url: "/api/auth/register", payload: { email, password: "password123" } });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "password123" } });
  return { authorization: "Bearer " + res.json().access_token };
}
module.exports = { build, login };
` : "module.exports = { build };\n"}`;
  f["test/health.test.js"] = `const test = require("node:test");
const assert = require("node:assert");
const { build } = require("./helpers");

test("health and OpenAPI", async () => {
  const app = await build();
  assert.deepEqual((await app.inject({ method: "GET", url: "/health" })).json(), { status: "ok" });
  const spec = (await app.inject({ method: "GET", url: "/openapi.json" })).json();
  assert.ok(spec.openapi && spec.paths["/health"]);
  const missing = await app.inject({ method: "GET", url: "/nope" });
  const metrics = (await app.inject({ method: "GET", url: "/metrics" })).body;
  assert.ok(metrics.includes('http_requests_total{method="GET",route="/health",status="200"} 1'), metrics);
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, "http_error");
  await app.close();
});
`;
  if (A) f["test/auth.test.js"] = `const test = require("node:test");
const assert = require("node:assert");
const { build } = require("./helpers");

test("register, login, me; no password leaks", async () => {
  const app = await build();
  const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "a@example.com", name: "A", password: "password123" } });
  assert.equal(reg.statusCode, 201);
  assert.ok(!reg.body.includes("password"));
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "a@example.com", password: "password123" } });
  assert.equal(login.statusCode, 200);
  const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: "Bearer " + login.json().access_token } });
  assert.equal(me.json().email, "a@example.com");
  await app.close();
});

test("duplicate, weak password, bad login, bad token", async () => {
  const app = await build();
  const body = { email: "d@example.com", password: "password123" };
  assert.equal((await app.inject({ method: "POST", url: "/api/auth/register", payload: body })).statusCode, 201);
  assert.equal((await app.inject({ method: "POST", url: "/api/auth/register", payload: body })).statusCode, 409);
  const weak = await app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "w@example.com", password: "short" } });
  assert.equal(weak.statusCode, 422);
  assert.equal(weak.json().error.code, "validation_error");
  assert.equal((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "d@example.com", password: "wrong-password" } })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: "Bearer nope" } })).statusCode, 401);
  await app.close();
});
`;
  for (const e of spec.entities) Object.assign(f, entityFiles(spec, e));
  f[".env.example"] = ["PORT=3000", "LOG_LEVEL=info", "DATABASE_PATH=./data/app.db", ...(A ? ["JWT_SECRET=changeme_use_a_long_random_secret"] : [])].join("\n") + "\n";
  f["Dockerfile"] = `FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "src/server.js"]
`;
  f["docker-compose.yml"] = `services:
  api:
    build: .
    ports:
      - "3000:3000"
    environment:
      DATABASE_PATH: /app/data/app.db
${A ? "      JWT_SECRET: ${JWT_SECRET:?set JWT_SECRET in your shell or .env}\n" : ""}    volumes:
      - appdata:/app/data
volumes:
  appdata:
`;
  f[".dockerignore"] = "node_modules\ndata\n.env\n";
  f[".gitignore"] = "node_modules/\ndata/\n.env\n";
  f["README.md"] = `# ${spec.name}

Fastify backend generated by Sierra. Layers: \`routes -> services -> repositories\`; SQLite through Node's built-in \`node:sqlite\`.

## Run
\`\`\`
npm install
${A ? "export JWT_SECRET=$(openssl rand -hex 32)\n" : ""}npm start
\`\`\`
Requires Node >= 22.13. OpenAPI document: \`GET /openapi.json\`.

## Test
\`\`\`
npm test
\`\`\`

## Endpoints
- \`GET /health\`, \`GET /openapi.json\`, \`GET /metrics\` (Prometheus text, per process)
${A ? "- \`POST /api/auth/register\`, \`POST /api/auth/login\`, \`GET /api/auth/me\`\n" : ""}${spec.entities.map((e) => `- \`GET|POST /api/${e.plural}\`, \`GET|PUT|DELETE /api/${e.plural}/:id\``).join("\n")}

## Known limitations
- SQLite only (single node). For multiple app instances behind a load balancer you need a networked database; no Postgres/MongoDB repository is generated for this stack yet.
- No schema migrations; tables are created at startup if missing. \`node:sqlite\` is still marked experimental by Node.
- bcrypt (bcryptjs) hashing and HS256 JWT; no refresh tokens or rate limiting.
`;
  return f;
}

module.exports = {
  id: "node-fastify",
  label: "Node.js + Fastify",
  language: "JavaScript",
  framework: "Fastify",
  status: "implemented",
  databases: ["sqlite"],
  notes: "SQLite via node:sqlite (Node >= 22.13). OpenAPI at /openapi.json.",
  generate,
  validate: { toolchain: "node", setup: [["npm", "install", "--no-audit", "--no-fund"]], test: [["npm", "test"]] },
};
