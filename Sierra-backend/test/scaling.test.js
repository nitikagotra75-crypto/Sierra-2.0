const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { registry, buildSpec } = require("../src/engine");
const { validateStack, hasTool, hostPort, probeTcp } = require("../src/engine/validate");
const { validateInfra } = require("../src/design/infraValidate");
const { writeFiles } = require("../src/execution/executionManager");

const PRIMARY = process.env.SIERRA_TEST_PG_PRIMARY || "postgresql+psycopg2://app:app@127.0.0.1:5440/app";
const REPLICA = process.env.SIERRA_TEST_PG_REPLICA || "postgresql+psycopg2://app:app@127.0.0.1:5441/app";
const spec = (database = "postgresql", auth = true) => buildSpec({ projectName: "Demo", analysis: { needsAuth: auth, primaryEntities: [{ name: "Task", fields: [{ name: "title", type: "string", required: true }] }] }, options: { stack: "python-fastapi", database, features: { readWriteSplit: true } } });

test("readWriteSplit requires PostgreSQL and is rejected by stacks that do not implement it", () => {
  assert.throws(() => registry.generate(spec("sqlite")), (e) => e.statusCode === 400 && /postgresql/.test(e.message));
  assert.throws(() => registry.generate(buildSpec({ projectName: "D", analysis: { primaryEntities: ["Task"] }, options: { stack: "go-gin", features: { readWriteSplit: true } } })), (e) => e.statusCode === 400);
});

test("generated routing: writes on primary, list reads on replicas, env-driven pools, replica compose files", () => {
  const f = registry.generate(spec());
  assert.match(f["app/db/routing.py"], /class ReplicaRouter/);
  assert.match(f["app/api/task_routes.py"], /Depends\(get_read_db\)/);
  assert.match(f["app/db/session.py"], /DB_POOL_SIZE/);
  assert.match(f["docker-compose.yml"], /db-replica:/);
  assert.match(f["infra/postgres/replica-entrypoint.sh"], /pg_basebackup/);
  assert.match(f["README.md"], /no automatic failover/);
  assert.doesNotMatch(f["docker-compose.yml"], /REPLICATION_PASSWORD: [^$]/); // no hardcoded replication secret
});

test("generated compose with replica passes real compose/yaml validation (structure only: nothing is started)", async (t) => {
  const f = registry.generate(spec());
  const infra = await validateInfra(f, { dockerfiles: Object.keys(f).filter((p) => /Dockerfile$/.test(p)) });
  assert.notEqual(infra.status, "failed", JSON.stringify(infra.results.filter((r) => r.status === "failed")));
});

test("validation is SKIPPED (never verified) when PostgreSQL is unreachable", async (t) => {
  if (!(await hasTool("python3"))) return t.skip("python3 not installed");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sierra-rw-skip-"));
  await writeFiles(dir, registry.generate(spec()));
  const res = await validateStack(registry.get("python-fastapi"), dir, { spec: spec(), env: { ...process.env, TEST_DATABASE_URL: "postgresql+psycopg2://app:app@127.0.0.1:1/app" } });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(res.status, "skipped"); assert.equal(res.missingService, "PostgreSQL primary");
});

test("python-fastapi + readWriteSplit: routing, fallback and recovery pass against a REAL Postgres primary + streaming replica (none skipped)", async (t) => {
  if (!(await hasTool("python3"))) return t.skip("python3 not installed");
  const hp = hostPort(PRIMARY), hr = hostPort(REPLICA);
  if (!(await probeTcp(hp.host, hp.port)) || !(await probeTcp(hr.host, hr.port))) return t.skip("Postgres primary/replica not reachable (start them with scripts/start-test-postgres.sh)");
  for (const auth of [true, false]) {
    const s = spec("postgresql", auth);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sierra-rw-"));
    await writeFiles(dir, registry.generate(s));
    const res = await validateStack(registry.get("python-fastapi"), dir, { spec: s, env: { ...process.env, TEST_DATABASE_URL: PRIMARY, TEST_DATABASE_REPLICA_URLS: REPLICA, NO_PROXY: "" } });
    fs.rmSync(dir, { recursive: true, force: true });
    const out = res.steps.at(-1) ? res.steps.at(-1).output : "";
    assert.equal(res.status, "passed", out);
    assert.doesNotMatch(out, /skipped/i, out);
  }
});
