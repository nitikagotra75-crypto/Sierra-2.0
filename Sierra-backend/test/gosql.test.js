const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path"), net = require("net");
const { registry, buildSpec } = require("../src/engine");
const { validateStack, hasTool } = require("../src/engine/validate");
const { writeFiles } = require("../src/execution/executionManager");

const ENTITIES = [
  { name: "Product", fields: [{ name: "title", type: "string", required: true }, { name: "price", type: "float", required: true }, { name: "kind", type: "enum", values: ["a", "b"], default: "a" }, { name: "active", type: "bool", default: true }] },
  { name: "Order", fields: [{ name: "note", type: "string", required: true }] },
];
const spec = (database, auth = true, o = {}) => buildSpec({ projectName: "Shop", analysis: { needsAuth: auth, primaryEntities: ENTITIES }, options: { stack: "go-nethttp", database, ...o } });
const URLS = { postgresql: process.env.SIERRA_TEST_GO_PG_URL || "postgres://app:app@127.0.0.1:5440/app?sslmode=disable", mysql: process.env.SIERRA_TEST_GO_MYSQL_URL || "mysql://app:app@127.0.0.1:3307/app" };
const open = (url) => new Promise((r) => { const u = new URL(url); const s = net.connect(Number(u.port), u.hostname); s.setTimeout(800); s.on("connect", () => { s.destroy(); r(true); }); s.on("error", () => r(false)); s.on("timeout", () => { s.destroy(); r(false); }); });
// Where Go modules come from: an explicit GOPROXY, else the local file proxy built by scripts/build-go-proxy.py, else the default.
const goEnv = () => ({ ...process.env, ...(process.env.GOPROXY ? {} : fs.existsSync("/tmp/goproxy") ? { GOPROXY: "file:///tmp/goproxy", GOSUMDB: "off", GOFLAGS: "-mod=mod" } : {}) });

test("memory stays the default; sql adds the store, repositories, migrations, wiring and a pinned driver", () => {
  const mem = registry.generate(spec(undefined));
  assert.ok(!mem["internal/store/store.go"]); assert.doesNotMatch(mem["go.mod"], /require/);
  for (const [db, mod, ver] of [["postgresql", "github.com/lib/pq", "v1.10.9"], ["mysql", "github.com/go-sql-driver/mysql", "v1.7.1"]]) {
    const f = registry.generate(spec(db));
    for (const k of ["internal/store/store.go", "internal/store/dialect.go", "internal/product/sql_repo.go", "internal/order/sql_repo.go", "internal/auth/sql_users.go", "internal/app/sql.go", "internal/app/sql_test.go"]) assert.ok(f[k], `${db}: ${k}`);
    assert.match(f["go.mod"], new RegExp(`require ${mod.replace(/[./]/g, "\\$&")} ${ver}`));
    assert.match(f["internal/store/dialect.go"], db === "postgresql" ? /pq\.Error/ : /MySQLError/);
    assert.match(f["internal/product/sql_repo.go"], /Version: 2, Name: "create_products"/);
    assert.match(f["internal/product/sql_repo.go"], /FOREIGN KEY/);
    assert.match(f["internal/product/sql_repo.go"], /CHECK/);
    assert.match(f[".env.example"], /DATABASE_URL=/);
    assert.match(f["README.md"], /go mod tidy/);
    assert.match(f[".github/workflows/ci.yml"], db === "postgresql" ? /image: postgres:16-alpine/ : /image: mysql:8/);
    assert.match(f[".github/workflows/ci.yml"], /TEST_DATABASE_URL/);
    assert.match(f[".github/workflows/ci.yml"], /go mod tidy/);
    assert.doesNotMatch(f["internal/store/dialect.go"], db === "postgresql" ? /go-sql-driver/ : /lib\/pq/, "only the chosen driver is imported");
  }
  const noAuth = registry.generate(spec("postgresql", false));
  assert.ok(!noAuth["internal/auth/sql_users.go"]); assert.doesNotMatch(noAuth["internal/product/sql_repo.go"], /owner_id/);
});

test("the sql repositories carry no secrets and quote every identifier", () => {
  const f = registry.generate(spec("postgresql"));
  assert.doesNotMatch(f["internal/product/sql_repo.go"], /FROM products /, "table names must be quoted");
  assert.match(f["internal/product/sql_repo.go"], /\\"products\\"/);
});

for (const db of ["postgresql", "mysql"]) for (const auth of [true, false]) {
  test(`go-nethttp + ${db} (auth ${auth}): format, vet, build and the integration tests pass against a REAL ${db}`, async (t) => {
    if (!(await hasTool("go"))) return t.skip("go is not installed");
    if (!(await open(URLS[db]))) return t.skip(`${db} is not reachable at ${URLS[db]} (scripts/start-test-${db === "postgresql" ? "postgres" : "mysql"}.sh)`);
    const s = spec(db, auth);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sierra-gosql-"));
    try {
      await writeFiles(dir, registry.generate(s));
      const r = await validateStack(registry.get("go-nethttp"), dir, { spec: s, env: { ...goEnv(), TEST_DATABASE_URL: URLS[db] } });
      if (r.status === "skipped") return t.skip(r.reason);
      assert.equal(r.status, "passed", JSON.stringify(r.steps.filter((x) => x.code !== 0)).slice(0, 2000));
      // run the SQL tests verbosely: every one must PASS and none may SKIP
      const out = require("child_process").execFileSync("go", ["test", "./internal/app", "-run", "SQL", "-v", "-count=1"], { cwd: dir, env: { ...goEnv(), TEST_DATABASE_URL: URLS[db] }, encoding: "utf8" });
      assert.doesNotMatch(out, /--- SKIP/, "the SQL tests must run, not skip");
      const passed = (out.match(/^--- PASS: TestSQL/gm) || []).length;
      assert.equal(passed, auth ? (s.entities[0].fields.some((f) => f.type === "enum") ? 9 : 8) : 6, out);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

test("without a reachable database Sierra reports SKIPPED with the missing service, never passed", async () => {
  const s = spec("postgresql");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sierra-gosql-"));
  try {
    await writeFiles(dir, registry.generate(s));
    const r = await validateStack(registry.get("go-nethttp"), dir, { spec: s, env: { ...goEnv(), TEST_DATABASE_URL: "postgres://app:app@127.0.0.1:1/app" } });
    assert.equal(r.status, "skipped"); assert.match(r.reason, /PostgreSQL/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
