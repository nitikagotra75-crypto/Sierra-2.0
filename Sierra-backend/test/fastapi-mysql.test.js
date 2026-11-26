const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path"), net = require("net");
const { spawnSync } = require("child_process");
const { registry, buildSpec } = require("../src/engine");
const { validateStack, hasTool } = require("../src/engine/validate");
const { writeFiles } = require("../src/execution/executionManager");

const ENT = [{ name: "Product", fields: [{ name: "title", type: "string", required: true }, { name: "price", type: "float", required: true }] }, { name: "Order", fields: [{ name: "note", type: "string", required: true }] }];
const spec = (auth, o = {}) => buildSpec({ projectName: "Shop", analysis: { needsAuth: auth, primaryEntities: ENT }, options: { stack: "python-fastapi", database: "mysql", ...o } });
const URL_ = process.env.SIERRA_TEST_FASTAPI_MYSQL_URL || "mysql+pymysql://app:app@127.0.0.1:3307/app";
const up = () => new Promise((r) => { const u = new URL(URL_.replace("mysql+pymysql", "mysql")); const s = net.connect(Number(u.port), u.hostname); s.setTimeout(800); s.on("connect", () => { s.destroy(); r(true); }); s.on("error", () => r(false)); s.on("timeout", () => { s.destroy(); r(false); }); });

test("fastapi + mysql: driver, env, compose, CI service and microservices data store are generated", () => {
  const f = registry.generate(spec(true));
  assert.match(f["requirements.txt"], /PyMySQL/);
  assert.match(f["requirements.txt"], /cryptography/);
  assert.match(f[".env.example"], /DATABASE_URL=mysql\+pymysql:\/\/app:app@localhost:3306\/app/);
  assert.match(f["docker-compose.yml"], /image: mysql:8/);
  assert.match(f[".github/workflows/ci.yml"], /TEST_DB_URL: mysql\+pymysql/);
  assert.match(f["tests/conftest.py"], /TEST_DB_URL/);
  assert.ok(!/psycopg2/.test(f["requirements.txt"]));
  const ms = registry.generate(spec(true, { architecture: "microservices" }));
  assert.match(ms["docker-compose.yml"], /DATABASE_URL: "mysql\+pymysql:\/\/app:\$\{DB_PASSWORD\}@db-product:3306\/app/);
  assert.match(ms["docker-compose.yml"], /db-order:\n    image: mysql:8/);
});

for (const auth of [true, false]) {
  test(`fastapi + mysql (auth=${auth}): the WHOLE generated suite passes against a REAL MySQL 8, and is skipped (not passed) without one`, async (t) => {
    if (!(await hasTool("python3"))) return t.skip("python3 not installed");
    if (!(await up())) return t.skip("MySQL not reachable (skipped, not passed)");
    const s = spec(auth);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sierra-fam-"));
    await writeFiles(dir, registry.generate(s));
    const r = await validateStack(registry.get("python-fastapi"), dir, { spec: s, env: { ...process.env, TEST_DB_URL: URL_ } });
    if (r.status === "skipped") return t.skip(r.reason);
    assert.strictEqual(r.status, "passed", JSON.stringify(r.steps.filter((x) => x.code !== 0)));
    const env = { ...process.env }; delete env.TEST_DB_URL;
    const bare = spawnSync(path.join(dir, ".venv/bin/python"), ["-m", "pytest", "-q"], { cwd: dir, env, encoding: "utf8" });
    assert.match(bare.stdout, /skipped/);
    assert.doesNotMatch(bare.stdout, /\d+ passed/, "no MySQL = nothing may be reported as passed");
    const mine = spawnSync(path.join(dir, ".venv/bin/python"), ["-m", "pytest", "-q"], { cwd: dir, env: { ...process.env, TEST_DB_URL: URL_ }, encoding: "utf8" });
    assert.match(mine.stdout, /\d+ passed/);
    assert.doesNotMatch(mine.stdout, /skipped/);
  });
}
