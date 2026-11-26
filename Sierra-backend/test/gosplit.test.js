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
const spec = (database, auth = true, extra = {}) => buildSpec({ projectName: "Shop", analysis: { needsAuth: auth, primaryEntities: ENTITIES }, options: { stack: "go-nethttp", database, features: { readWriteSplit: true, ...extra } } });
const URLS = {
  postgresql: [process.env.SIERRA_TEST_GO_PG_URL || "postgres://app:app@127.0.0.1:5440/app?sslmode=disable", process.env.SIERRA_TEST_GO_PG_REPLICA_URL || "postgres://app:app@127.0.0.1:5441/app?sslmode=disable"],
  mysql: [process.env.SIERRA_TEST_GO_MYSQL_URL || "mysql://app:app@127.0.0.1:3307/app", process.env.SIERRA_TEST_GO_MYSQL_REPLICA_URL || "mysql://app:app@127.0.0.1:3308/app"],
};
const open = (url) => new Promise((r) => { const u = new URL(url); const s = net.connect(Number(u.port), u.hostname); s.setTimeout(800); s.on("connect", () => { s.destroy(); r(true); }); s.on("error", () => r(false)); s.on("timeout", () => { s.destroy(); r(false); }); });
const goEnv = (db) => ({ ...process.env, TEST_DATABASE_URL: URLS[db][0], TEST_DATABASE_REPLICA_URLS: URLS[db][1], ...(process.env.GOPROXY ? {} : fs.existsSync("/tmp/goproxy") ? { GOPROXY: "file:///tmp/goproxy", GOSUMDB: "off", GOFLAGS: "-mod=mod" } : {}) });
const run = async (db, s, mutate) => {
  const files = registry.generate(s);
  if (mutate) mutate(files);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sierra-gosplit-"));
  await writeFiles(d, files);
  return validateStack(registry.get("go-nethttp"), d, { spec: s, env: goEnv(db) });
};

test("readWriteSplit (go-nethttp): needs postgresql or mysql; generates routing, not replication", () => {
  for (const db of [undefined, "memory"]) assert.throws(() => registry.generate(spec(db)), (e) => e.statusCode === 400 && /postgresql or mysql/.test(e.message));
  assert.throws(() => registry.generate(buildSpec({ projectName: "D", analysis: { primaryEntities: ["Task"] }, options: { stack: "go-gin", features: { readWriteSplit: true } } })), (e) => e.statusCode === 400);
  const f = registry.generate(spec("mysql"));
  assert.match(f["internal/store/replicas.go"], /func \(r \*Replicas\) Query/);
  assert.match(f["internal/product/sql_repo.go"], /r\.Read\.Query\(r\.DB, /);
  assert.match(f["internal/app/sql.go"], /NewSQLRepoWith\(db, rep\)/);
  assert.match(f["cmd/server/main.go"], /OpenReplicas/);
  assert.match(f["README.md"], /you provision and operate the replication/);
  assert.match(f["internal/store/dialect.go"], /cfg\.Timeout = 5 \* time\.Second/);
  assert.match(registry.generate(spec("postgresql"))["internal/store/dialect.go"], /connect_timeout=5/);
  assert.doesNotMatch(registry.generate(buildSpec({ projectName: "Shop", analysis: { primaryEntities: ENTITIES }, options: { stack: "go-nethttp", database: "mysql" } }))["internal/store/store.go"] + "", /Replicas/);
});

for (const db of ["postgresql", "mysql"]) for (const auth of [true, false]) {
  test(`go-nethttp ${db} (auth=${auth}): list reads are served by a REAL replica, by-id reads/writes use the primary, a dead replica falls back`, async (t) => {
    if (!(await hasTool("go"))) return t.skip("go not installed");
    if (!(await open(URLS[db][0])) || !(await open(URLS[db][1]))) return t.skip(`${db} primary/replica not reachable (scripts/start-test-${db === "mysql" ? "mysql-replica" : "postgres"}.sh) - skipped, not passed`);
    const r = await run(db, spec(db, auth));
    if (r.status === "skipped") return t.skip(r.reason);
    assert.strictEqual(r.status, "passed", JSON.stringify(r.steps && r.steps.filter((x) => x.code !== 0)));
  });
}

test("readWriteSplit mutations are caught: list on the primary, and no fallback to the primary", async (t) => {
  if (!(await hasTool("go"))) return t.skip("go not installed");
  const db = "postgresql";
  if (!(await open(URLS[db][0])) || !(await open(URLS[db][1]))) return t.skip("postgresql primary/replica not reachable");
  const a = await run(db, spec(db), (f) => { f["internal/product/sql_repo.go"] = f["internal/product/sql_repo.go"].replace("r.Read.Query(r.DB, ", "r.DB.Query("); });
  if (a.status === "skipped") return t.skip(a.reason);
  assert.strictEqual(a.status, "failed", "a List that never uses the replica must fail the routing test");
  const b = await run(db, spec(db), (f) => { f["internal/store/replicas.go"] = f["internal/store/replicas.go"].replace("\treturn primary.Query(q, args...)\n}", "\treturn nil, sql.ErrConnDone\n}"); });
  assert.strictEqual(b.status, "failed", "no fallback to the primary must fail the dead-replica test");
  const c = await run(db, spec(db), (f) => { f["internal/store/replicas.go"] = f["internal/store/replicas.go"].replace("rp.downUntil = r.now().Add(r.Cooldown)", "_ = r.Cooldown"); });
  assert.strictEqual(c.status, "failed", "no cooldown must fail the failure-count assertion");
});
