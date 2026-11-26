const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path"), net = require("net");
const { spawnSync } = require("child_process");
const { registry, buildSpec } = require("../src/engine");
const { validateStack, hasTool } = require("../src/engine/validate");
const { writeFiles } = require("../src/execution/executionManager");

const ENT = [{ name: "Product", fields: [{ name: "title", type: "string", required: true }, { name: "price", type: "float", required: true }] }, { name: "Order", fields: [{ name: "note", type: "string", required: true }] }];
const spec = (stack, db, auth = true, features = {}) => buildSpec({ projectName: "Shop", analysis: { needsAuth: auth, primaryEntities: ENT }, options: { stack, database: db, features } });
const URLS = { postgresql: process.env.SIERRA_TEST_GO_PG_URL || "postgres://app:app@127.0.0.1:5440/app?sslmode=disable", mysql: process.env.SIERRA_TEST_GO_MYSQL_URL || "mysql://app:app@127.0.0.1:3307/app" };
const open = (url) => new Promise((r) => { const u = new URL(url); const s = net.connect(Number(u.port), u.hostname); s.setTimeout(800); s.on("connect", () => { s.destroy(); r(true); }); s.on("error", () => r(false)); s.on("timeout", () => { s.destroy(); r(false); }); });
const proxy = () => fs.existsSync("/tmp/goproxy/github.com/gin-gonic/gin/@v/v1.10.0.zip");
const env = (db) => ({ ...process.env, TEST_DATABASE_URL: URLS[db], REDIS_URL: "redis://localhost:6379/15", ...(fs.existsSync("/tmp/goproxy") ? { GOPROXY: "file:///tmp/goproxy", GOSUMDB: "off", GOFLAGS: "-mod=mod" } : {}) });

test("gin/fiber + postgresql/mysql: Stores wiring, driver require, CI service and README are generated; fiber is gofmt-clean", () => {
  for (const stack of ["go-gin", "go-fiber"]) for (const db of ["postgresql", "mysql"]) {
    const f = registry.generate(spec(stack, db));
    assert.match(f["internal/app/app.go"], /func NewWith\(cfg config\.Config, st Stores\) http\.Handler/, stack + db);
    assert.match(f["internal/app/app.go"], /Repo: st\.Product/);
    assert.match(f["internal/app/app.go"], /st\.Users/);
    assert.match(f["go.mod"], db === "postgresql" ? /lib\/pq v1\.10\.9/ : /go-sql-driver\/mysql v1\.7\.1/);
    assert.match(f["cmd/server/main.go"], /app\.SQLStores\(db\)/);
    assert.ok(f["internal/store/store.go"] && f["internal/app/sql_test.go"]);
    assert.match(f[".github/workflows/ci.yml"], db === "postgresql" ? /postgres:16-alpine/ : /image: mysql:8/);
    assert.match(f[".github/workflows/ci.yml"], /TEST_DATABASE_URL/);
  }
  assert.ok(!/internal\/store/.test(Object.keys(registry.generate(spec("go-gin", undefined))).join(",")), "memory stays memory");
  assert.throws(() => registry.generate(spec("go-gin", "mongodb")), (e) => e.statusCode === 400);
  const g = spawnSync("gofmt", ["-d", "-e"], { input: registry.generate(spec("go-fiber", "postgresql"))["internal/app/app.go"], encoding: "utf8" });
  assert.strictEqual(g.stderr, "", g.stderr);
  assert.strictEqual(g.stdout.trim(), "", "not gofmt-formatted");
});

for (const [db, auth, features] of [["postgresql", true, {}], ["mysql", false, {}], ["postgresql", true, { distributed: true }]]) {
  test(`go-gin + ${db} (auth=${auth}${features.distributed ? ", distributed" : ""}): compiles against a REAL Gin and the generated suite passes on a REAL database (Gin 1.8.1 from Debian, not the pinned 1.10.0)`, async (t) => {
    if (!(await hasTool("go"))) return t.skip("go not installed");
    if (!proxy()) return t.skip("local Gin proxy not built (python3 scripts/build-go-proxy.py /tmp/goproxy) - skipped, not passed");
    if (!(await open(URLS[db]))) return t.skip(db + " not reachable (skipped, not passed)");
    if (features.distributed && !(await open("redis://127.0.0.1:6379"))) return t.skip("Redis not reachable");
    const s = spec("go-gin", db, auth, features);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sierra-gin-"));
    await writeFiles(dir, registry.generate(s));
    const r = await validateStack(registry.get("go-gin"), dir, { spec: s, env: env(db) });
    if (r.status === "skipped") return t.skip(r.reason);
    assert.strictEqual(r.status, "passed", JSON.stringify(r.steps.filter((x) => x.code !== 0)));
    const v = spawnSync("go", ["test", "-count=1", "-v", "-run", "TestSQLCrudOverHTTP|TestSQLDataSurvivesARestart", "./internal/app/"], { cwd: dir, env: env(db), encoding: "utf8" });
    assert.match(v.stdout, /--- PASS: TestSQLDataSurvivesARestart/);
    assert.doesNotMatch(v.stdout, /SKIP/);
  });
}

test("go-gin + sql: a mutation that makes NewWith ignore the injected stores is caught by the real-database tests", async (t) => {
  if (!(await hasTool("go")) || !proxy() || !(await open(URLS.postgresql))) return t.skip("go / Gin proxy / PostgreSQL not available (skipped, not passed)");
  const s = spec("go-gin", "postgresql");
  const files = registry.generate(s);
  const before = files["internal/app/app.go"];
  files["internal/app/app.go"] = before.replace("func NewWith(cfg config.Config, st Stores) http.Handler {", "func NewWith(cfg config.Config, st Stores) http.Handler {\n\tst = MemoryStores()");
  assert.notStrictEqual(files["internal/app/app.go"], before);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sierra-gin-m-"));
  await writeFiles(dir, files);
  const r = await validateStack(registry.get("go-gin"), dir, { spec: s, env: env("postgresql") });
  if (r.status === "skipped") return t.skip(r.reason);
  assert.strictEqual(r.status, "failed", "in-memory stores behind an SQL project must fail the persistence tests");
});
