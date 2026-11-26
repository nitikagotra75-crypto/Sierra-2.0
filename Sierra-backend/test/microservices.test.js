const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const { spawn } = require("child_process");
const { registry, buildSpec } = require("../src/engine");
const { validateStack, hasTool } = require("../src/engine/validate");
const { writeFiles } = require("../src/execution/executionManager");
const { validateInfra } = require("../src/design/infraValidate");

const spec = (stack, o = {}) => buildSpec({
  projectName: "Shop",
  analysis: { needsAuth: o.auth !== false, primaryEntities: [{ name: "Product", fields: [{ name: "title", type: "string", required: true }, { name: "price", type: "float", required: true }] }, { name: "Order", fields: [{ name: "note", type: "string", required: true }] }] },
  options: { stack, architecture: "microservices", database: o.database, features: o.features },
});

test("microservices needs >= 2 entities and a valid architecture value", () => {
  assert.throws(() => registry.generate(buildSpec({ projectName: "X", analysis: { primaryEntities: ["Task"] }, options: { stack: "node-fastify", architecture: "microservices" } })), (e) => e.statusCode === 400 && /at least 2 entities/.test(e.message));
  assert.throws(() => buildSpec({ projectName: "X", analysis: { primaryEntities: ["A", "B"] }, options: { architecture: "serverless" } }), (e) => e.statusCode === 400);
});

test("a system has one service per entity, a gateway, compose, env template, root CI and docs", () => {
  const f = registry.generate(spec("node-fastify"));
  for (const k of ["services/product/package.json", "services/order/package.json", "services/product/Dockerfile", "gateway/server.js", "gateway/test/gateway.test.js", "docker-compose.yml", ".env.example", ".github/workflows/ci.yml", "ARCHITECTURE.md", "README.md"]) assert.ok(f[k], k);
  assert.ok(!Object.keys(f).some((k) => k.startsWith("services/") && k.includes("/.github/")), "per-service workflows must not be nested");
  const routes = JSON.parse(f["gateway/routes.json"]);
  assert.equal(routes.auth, true);
  assert.deepEqual(routes.routes.map((r) => r.prefix), ["/api/products", "/api/orders"]);
  assert.match(f["docker-compose.yml"], /JWT_SECRET: \$\{JWT_SECRET:\?/);
  assert.doesNotMatch(f["docker-compose.yml"], /ports:[\s\S]*product-service[\s\S]*ports:/, "services must not publish ports");
  assert.match(f[".env.example"], /JWT_SECRET=/);
  // services are unauthenticated behind the gateway, the gateway owns auth
  assert.ok(!f["services/product/src/routes/auth.js"]);
  const noAuth = registry.generate(spec("node-fastify", { auth: false }));
  assert.equal(JSON.parse(noAuth["gateway/routes.json"]).auth, false);
  assert.doesNotMatch(noAuth["docker-compose.yml"], /JWT_SECRET/);
});

test("python stacks get a real Postgres per service, with the password from .env", () => {
  const f = registry.generate(spec("python-fastapi", { auth: false }));
  const c = f["docker-compose.yml"];
  assert.match(c, /db-product:[\s\S]*image: postgres:16-alpine/);
  assert.match(c, /db-order:/);
  assert.match(c, /DATABASE_URL: "postgresql\+psycopg2:\/\/app:\$\{DB_PASSWORD\}@db-product:5432\/app"/);
  assert.match(c, /POSTGRES_PASSWORD: \$\{DB_PASSWORD:\?/);
  assert.match(c, /condition: service_healthy/);
  assert.match(f[".env.example"], /DB_PASSWORD=/);
});

test("features reach every service; shared Redis/RabbitMQ are added once", () => {
  const f = registry.generate(spec("python-fastapi", { auth: false, features: { distributed: true, events: "rabbitmq" } }));
  const c = f["docker-compose.yml"];
  assert.equal((c.match(/^  redis:/gm) || []).length, 1);
  assert.equal((c.match(/^  rabbitmq:/gm) || []).length, 1);
  assert.match(c, /REDIS_URL: "redis:\/\/redis:6379\/0"/);
  assert.match(c, /RABBITMQ_URL: "amqp:\/\/app:\$\{BROKER_PASSWORD\}@rabbitmq:5672\/"/);
  assert.ok(f["services/product/app/core/distributed.py"] && f["services/order/app/core/distributed.py"]);
  assert.match(f[".env.example"], /BROKER_PASSWORD=/);
  assert.throws(() => registry.generate(spec("spring-boot", { features: { distributed: true } })), (e) => e.statusCode === 400);
});

test("generated compose/workflow/Dockerfiles pass the static infra validators that are installed", async () => {
  for (const stack of ["node-fastify", "python-fastapi", "go-nethttp", "spring-boot"]) {
    const f = registry.generate(spec(stack, { auth: stack !== "go-nethttp" }));
    const r = validateInfra(Object.fromEntries(Object.entries(f).filter(([n]) => /(^|\/)(Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|\.github\/workflows\/[^/]+\.ya?ml)$/.test(n))));
    assert.notEqual(r.status, "failed", stack + ": " + JSON.stringify(r.results.filter((x) => x.status === "failed")));
  }
});

// Real run: install + test every service and the gateway, then start the services and the gateway as processes
// and drive the system through the gateway only.
test("node-fastify system: every part's own tests pass, and the running system works through the gateway", async (t) => {
  if (!(await hasTool("node"))) return t.skip("node not installed");
  const s = spec("node-fastify");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sierra-ms-"));
  await writeFiles(dir, registry.generate(s));
  const procs = [];
  try {
    const res = await validateStack(registry.get("node-fastify"), dir, { spec: s });
    assert.equal(res.status, "passed", JSON.stringify(res.steps.filter((x) => x.code !== 0)));
    assert.deepEqual(res.parts.map((p) => p.status), ["passed", "passed", "passed"]);

    const freePort = () => new Promise((r) => { const sv = http.createServer().listen(0, "127.0.0.1", () => { const p = sv.address().port; sv.close(() => r(p)); }); });
    const start = async (cwd, env, port) => {
      const p = spawn("node", ["server.js".replace("server.js", fs.existsSync(path.join(cwd, "server.js")) ? "server.js" : "src/server.js")], { cwd, env: { ...process.env, ...env, PORT: String(port) }, stdio: "ignore" });
      procs.push(p);
      for (let i = 0; i < 60; i++) { try { await new Promise((ok, no) => http.get({ host: "127.0.0.1", port, path: "/health" }, (r) => { r.resume(); r.statusCode === 200 ? ok() : no(); }).on("error", no)); return p; } catch { await new Promise((r) => setTimeout(r, 250)); } }
      throw new Error("did not start: " + cwd);
    };
    const [pp, op, gp] = [await freePort(), await freePort(), await freePort()];
    const dbs = fs.mkdtempSync(path.join(os.tmpdir(), "sierra-ms-db-"));
    const prod = await start(path.join(dir, "services/product"), { DATABASE_PATH: path.join(dbs, "p.db") }, pp);
    await start(path.join(dir, "services/order"), { DATABASE_PATH: path.join(dbs, "o.db") }, op);
    await start(path.join(dir, "gateway"), { JWT_SECRET: "x".repeat(40), GATEWAY_DB_PATH: path.join(dbs, "g.db"), UPSTREAM_PRODUCT: `http://127.0.0.1:${pp}`, UPSTREAM_ORDER: `http://127.0.0.1:${op}`, UPSTREAM_TIMEOUT_MS: "1500", BREAKER_THRESHOLD: "2" }, gp);

    const call = (p, { method = "GET", body, token } = {}) => new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const r = http.request({ host: "127.0.0.1", port: gp, path: p, method, headers: { ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}), ...(token ? { authorization: "Bearer " + token } : {}) } }, (x) => { const c = []; x.on("data", (d) => c.push(d)); x.on("end", () => { const text = Buffer.concat(c).toString(); resolve({ status: x.statusCode, json: (() => { try { return JSON.parse(text); } catch { return null; } })() }); }); });
      r.on("error", reject); if (data) r.write(data); r.end();
    });

    assert.equal((await call("/api/products")).status, 401, "no token");
    assert.equal((await call("/api/auth/register", { method: "POST", body: { email: "u@example.com", password: "password123" } })).status, 201);
    const token = (await call("/api/auth/login", { method: "POST", body: { email: "u@example.com", password: "password123" } })).json.access_token;
    const made = await call("/api/products", { method: "POST", token, body: { title: "Lamp", price: 9.5 } });
    assert.equal(made.status, 201, JSON.stringify(made));
    assert.equal((await call("/api/products", { token })).json.length, 1);
    assert.equal((await call("/api/orders", { token })).json.length, 0, "database per service: the order service sees none of the products");
    assert.equal((await call("/api/orders", { method: "POST", token, body: { note: "gift" } })).status, 201);
    assert.equal((await call("/health/services")).json.status, "ok");

    prod.kill();
    await new Promise((r) => setTimeout(r, 300));
    const codes = [(await call("/api/products", { token })).status, (await call("/api/products", { token })).status, (await call("/api/products", { token })).status];
    assert.deepEqual(codes, [502, 502, 503], "product service down: 502s, then its circuit opens");
    assert.equal((await call("/api/orders", { token })).status, 200, "order service keeps working");
    const h = await call("/health/services");
    assert.equal(h.status, 503); assert.equal(h.json.services.product.status, "down"); assert.equal(h.json.services.order.status, "ok");
  } finally {
    procs.forEach((p) => p.kill());
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


// The same real system run for the other verified stacks, with a REAL PostgreSQL database per service.
const PGBASE = process.env.SIERRA_TEST_MS_PG || "postgres://app:app@127.0.0.1:5440";
const pgUp = () => new Promise((r) => { const u = new URL(PGBASE); const sv = require("net").connect(Number(u.port), u.hostname); sv.setTimeout(800); sv.on("connect", () => { sv.destroy(); r(true); }); sv.on("error", () => r(false)); sv.on("timeout", () => { sv.destroy(); r(false); }); });
const STACKS = {
  "python-fastapi": {
    tool: "python3",
    env: (db) => ({ DATABASE_URL: `postgresql+psycopg2://${PGBASE.replace("postgres://", "")}/${db}` }),
    cmd: (cwd, port) => [path.join(cwd, ".venv/bin/uvicorn"), ["app.main:create_app", "--factory", "--host", "127.0.0.1", "--port", String(port)]],
  },
  "go-nethttp": {
    tool: "go",
    env: (db) => ({ DATABASE_DRIVER: "postgres", DATABASE_URL: `${PGBASE}/${db}?sslmode=disable` }),
    build: (cwd) => require("child_process").spawnSync("go", ["build", "-o", "server.bin", "./cmd/server"], { cwd, encoding: "utf8", env: { ...process.env, ...(fs.existsSync("/tmp/goproxy") ? { GOPROXY: "file:///tmp/goproxy", GOSUMDB: "off", GOFLAGS: "-mod=mod" } : {}) } }),
    cmd: (cwd) => [path.join(cwd, "server.bin"), []],
  },
};
for (const [stack, st] of Object.entries(STACKS)) {
  test(`${stack} system: every part's own tests pass; the running system (real Postgres per service) works through the gateway`, async (t) => {
    if (!(await hasTool(st.tool)) || !(await hasTool("node"))) return t.skip(st.tool + " not installed");
    if (!(await pgUp())) return t.skip("PostgreSQL not reachable (skipped, not passed)");
    const s = spec(stack);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sierra-ms-"));
    await writeFiles(dir, registry.generate(s));
    const procs = [];
    try {
      const env = { ...process.env, TEST_DATABASE_URL: `${PGBASE}/app?sslmode=disable`, ...(fs.existsSync("/tmp/goproxy") ? { GOPROXY: "file:///tmp/goproxy", GOSUMDB: "off", GOFLAGS: "-mod=mod" } : {}) };
      const res = await validateStack(registry.get(stack), dir, { spec: s, env });
      if (res.status === "skipped") return t.skip(res.reason);
      assert.equal(res.status, "passed", JSON.stringify(res.steps.filter((x) => x.code !== 0)));
      assert.deepEqual(res.parts.map((p) => p.status), ["passed", "passed", "passed"]);
      const freePort = () => new Promise((r) => { const sv = http.createServer().listen(0, "127.0.0.1", () => { const p = sv.address().port; sv.close(() => r(p)); }); });
      const wait = async (port) => { for (let i = 0; i < 120; i++) { try { await new Promise((ok, no) => http.get({ host: "127.0.0.1", port, path: "/health" }, (r) => { r.resume(); r.statusCode === 200 ? ok() : no(); }).on("error", no)); return; } catch { await new Promise((r) => setTimeout(r, 250)); } } throw new Error("did not start on " + port); };
      const startSvc = async (name, db) => {
        const cwd = path.join(dir, "services", name), port = await freePort();
        if (st.build) { const b = st.build(cwd); assert.equal(b.status, 0, b.stderr); }
        const [bin, args] = st.cmd(cwd, port);
        const p = spawn(bin, args, { cwd, env: { ...process.env, ...st.env(db), PORT: String(port), JWT_SECRET: "x".repeat(40) }, stdio: "ignore" });
        procs.push(p); await wait(port); return { p, port };
      };
      // clean databases (the services create their own tables)
      const { spawnSync } = require("child_process");
      for (const db of ["ms_product", "ms_order"]) spawnSync("psql", [`${PGBASE}/postgres`, "-c", `DROP DATABASE IF EXISTS ${db}`, "-c", `CREATE DATABASE ${db}`], { encoding: "utf8" });
      const prod = await startSvc("product", "ms_product");
      const ord = await startSvc("order", "ms_order");
      const gp = await freePort();
      const g = spawn("node", ["server.js"], { cwd: path.join(dir, "gateway"), env: { ...process.env, PORT: String(gp), JWT_SECRET: "x".repeat(40), GATEWAY_DB_PATH: path.join(dir, "g.db"), UPSTREAM_PRODUCT: `http://127.0.0.1:${prod.port}`, UPSTREAM_ORDER: `http://127.0.0.1:${ord.port}`, UPSTREAM_TIMEOUT_MS: "1500", BREAKER_THRESHOLD: "2" }, stdio: "ignore" });
      procs.push(g); await wait(gp);
      const call = (p, { method = "GET", body, token } = {}) => new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const r = http.request({ host: "127.0.0.1", port: gp, path: p, method, headers: { ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}), ...(token ? { authorization: "Bearer " + token } : {}) } }, (x) => { const c = []; x.on("data", (d) => c.push(d)); x.on("end", () => { const text = Buffer.concat(c).toString(); resolve({ status: x.statusCode, json: (() => { try { return JSON.parse(text); } catch { return null; } })() }); }); });
        r.on("error", reject); if (data) r.write(data); r.end();
      });
      assert.equal((await call("/api/products")).status, 401, "no token");
      assert.equal((await call("/api/auth/register", { method: "POST", body: { email: "u@example.com", password: "password123" } })).status, 201);
      const token = (await call("/api/auth/login", { method: "POST", body: { email: "u@example.com", password: "password123" } })).json.access_token;
      const made = await call("/api/products", { method: "POST", token, body: { title: "Lamp", price: 9.5 } });
      assert.equal(made.status, 201, JSON.stringify(made));
      assert.equal((await call("/api/products", { token })).json.length, 1);
      assert.equal((await call("/api/orders", { token })).json.length, 0, "database per service: the order service sees none of the products");
      assert.equal((await call("/api/orders", { method: "POST", token, body: { note: "gift" } })).status, 201);
      assert.equal((await call("/health/services")).json.status, "ok");
      prod.p.kill();
      await new Promise((r) => setTimeout(r, 400));
      const codes = [];
      for (let i = 0; i < 3; i++) codes.push((await call("/api/products", { token })).status);
      assert.deepEqual(codes, [502, 502, 503], "product service down: 502s, then its circuit opens");
      assert.equal((await call("/api/orders", { token })).status, 200, "order service keeps working");
    } finally {
      procs.forEach((p) => p.kill());
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
