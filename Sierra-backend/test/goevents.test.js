const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path"), net = require("net");
const { registry, buildSpec } = require("../src/engine");
const { validateStack, hasTool } = require("../src/engine/validate");
const { writeFiles } = require("../src/execution/executionManager");

const ENTITIES = [
  { name: "Product", fields: [{ name: "title", type: "string", required: true }, { name: "price", type: "float", required: true }] },
  { name: "Order", fields: [{ name: "note", type: "string", required: true }] },
];
const spec = (auth = true, o = {}, events = "rabbitmq") => buildSpec({ projectName: "Shop", analysis: { needsAuth: auth, primaryEntities: ENTITIES }, options: { stack: "go-nethttp", features: { events, ...(o.features || {}) }, ...(o.database ? { database: o.database } : {}) } });
const AMQP = process.env.SIERRA_TEST_AMQP_URL || "amqp://app:app@localhost:5673/";
const open = (url) => new Promise((r) => { const u = new URL(url); const s = net.connect(Number(u.port || 5672), u.hostname); s.setTimeout(800); s.on("connect", () => { s.destroy(); r(true); }); s.on("error", () => r(false)); s.on("timeout", () => { s.destroy(); r(false); }); });
const goEnv = () => ({ ...process.env, AMQP_URL: AMQP, TEST_DATABASE_URL: process.env.SIERRA_TEST_GO_PG_URL || "postgres://app:app@127.0.0.1:5440/app?sslmode=disable", REDIS_URL: "redis://localhost:6379/12", ...(process.env.GOPROXY ? {} : fs.existsSync("/tmp/goproxy") ? { GOPROXY: "file:///tmp/goproxy", GOSUMDB: "off", GOFLAGS: "-mod=mod" } : {}) });
const run = async (s, mutate) => {
  const files = registry.generate(s);
  if (mutate) mutate(files);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sierra-goev-"));
  await writeFiles(d, files);
  return validateStack(registry.get("go-nethttp"), d, { spec: s, env: goEnv() });
};

test("events: only rabbitmq is supported for Go (kafka -> 400); other stacks of the feature are unaffected", () => {
  assert.throws(() => registry.generate(spec(true, {}, "kafka")), (e) => e.statusCode === 400);
  const f = registry.generate(spec());
  for (const k of ["internal/events/events.go", "internal/events/amqp.go", "internal/events/amqp_test.go", "cmd/worker/main.go", "internal/app/events_test.go"]) assert.ok(f[k], k);
  assert.match(f["go.mod"], /github.com\/rabbitmq\/amqp091-go v1\.9\.0/);
  assert.match(f["internal/product/product.go"], /s\.emit\("product\.created", v\)/);
  assert.match(f["internal/app/app.go"], /Events: events\.Shared\(\)/);
  assert.match(f["Dockerfile"], /\/out\/worker/);
  assert.match(f[".github/workflows/ci.yml"], /rabbitmq:3\.13/);
  assert.ok(!registry.generate(buildSpec({ projectName: "Shop", analysis: { needsAuth: true, primaryEntities: ENTITIES }, options: { stack: "go-nethttp" } }))["internal/events/events.go"], "off unless requested");
});

for (const [name, auth, o] of [["memory+auth", true, {}], ["memory, no auth", false, {}], ["postgresql + distributed", true, { database: "postgresql", features: { distributed: true } }]]) {
  test(`go-nethttp events (${name}): generated suite passes against a REAL RabbitMQ`, async (t) => {
    if (!(await hasTool("go"))) return t.skip("go not installed");
    if (!(await open(AMQP))) return t.skip("RabbitMQ not reachable (skipped, not passed)");
    if (o.database && !(await open("postgres://127.0.0.1:5440/"))) return t.skip("PostgreSQL not reachable");
    if (o.features && !(await open("redis://127.0.0.1:6379"))) return t.skip("Redis not reachable");
    const s = spec(auth, o);
    const r = await run(s);
    if (r.status === "skipped") return t.skip(r.reason);
    assert.strictEqual(r.status, "passed", JSON.stringify(r.steps && r.steps.filter((x) => x.code !== 0)));
  });
}

test("events: mutations are caught (no emit on create; services not wired to the publisher)", async (t) => {
  if (!(await hasTool("go"))) return t.skip("go not installed");
  if (!(await open(AMQP))) return t.skip("RabbitMQ not reachable (skipped, not passed)");
  const s = spec(true);
  const a = await run(s, (f) => { f["internal/product/product.go"] = f["internal/product/product.go"].replace('s.emit("product.created", v)', "_ = v"); });
  if (a.status === "skipped") return t.skip(a.reason);
  assert.strictEqual(a.status, "failed", "dropping the created event must fail the generated tests");
  const b = await run(s, (f) => { f["internal/app/app.go"] = f["internal/app/app.go"].replace(/, Events: events\.Shared\(\)/g, "").replace(/\t"[^"]*\/internal\/events"\n/, ""); });
  assert.strictEqual(b.status, "failed", "unwired publisher must fail the generated tests");
  const c = await run(s, (f) => { f["internal/events/amqp.go"] = f["internal/events/amqp.go"].replace("if tries >= c.attempts() {", "if false {"); });
  assert.strictEqual(c.status, "failed", "a consumer that never dead-letters must fail the real-broker tests");
});
