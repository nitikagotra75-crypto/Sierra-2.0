const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { spawn } = require("child_process");
const { registry, buildSpec } = require("../src/engine");
const { validateStack, hasTool } = require("../src/engine/validate");
const { writeFiles } = require("../src/execution/executionManager");

const spec = (stack, auth = true) => buildSpec({ projectName: "Demo", analysis: { needsAuth: auth, primaryEntities: [{ name: "Task", fields: [{ name: "title", type: "string", required: true }] }] }, options: { stack, features: { distributed: true } } });

test("distributed is only accepted by stacks that implement it", () => {
  assert.ok(registry.generate(spec("python-fastapi"))["app/core/distributed.py"]);
  assert.ok(registry.generate(spec("python-flask"))["app/core/distributed.py"]);
  assert.ok(registry.generate(spec("python-django"))["core/distributed.py"]);
  assert.ok(registry.generate(spec("node-fastify"))["src/distributed.js"]);
  assert.ok(registry.generate(spec("nestjs"))["src/common/distributed.ts"]);
  assert.ok(registry.generate(spec("go-nethttp"))["internal/distributed/guard.go"]);
  assert.match(registry.generate(spec("go-nethttp"))["go.mod"], /gomodule\/redigo v1.8.9/);
  assert.ok(registry.generate(spec("node-express"))["src/dist_express.js"]);
  for (const id of ["go-gin", "go-fiber"]) assert.ok(registry.generate(spec(id))["internal/distributed/guard.go"], id);
  for (const id of ["spring-boot", "aspnet-core"]) assert.throws(() => registry.generate(spec(id)), (e) => e.statusCode === 400, id);
  assert.ok(!registry.generate(buildSpec({ projectName: "D", analysis: { primaryEntities: ["Task"] }, options: { stack: "python-fastapi" } }))["app/core/distributed.py"]);
});

test("distributed feature adds a Redis service to the generated CI workflow", () => {
  assert.match(registry.generate(spec("python-fastapi"))[".github/workflows/ci.yml"], /redis:7/);
});

test("validation is SKIPPED (not verified) when Redis is not reachable", async (t) => {
  if (!(await hasTool("python3"))) return t.skip("python3 not installed");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sierra-dist-skip-"));
  await writeFiles(dir, registry.generate(spec("python-fastapi")));
  const res = await validateStack(registry.get("python-fastapi"), dir, { spec: spec("python-fastapi"), env: { ...process.env, REDIS_URL: "redis://127.0.0.1:1/0" } });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(res.status, "skipped");
  assert.equal(res.missingService, "Redis");
});

// Real run: starts a private redis-server, then the GENERATED project's own pytest suite runs against it.
const REAL = ["python-fastapi", "python-flask", "python-django", "node-fastify", "nestjs", "go-nethttp"];
// Go modules: an explicit GOPROXY, else the local file proxy built by scripts/build-go-proxy.py, else the default proxy.
const goEnv = () => (process.env.GOPROXY ? {} : fs.existsSync("/tmp/goproxy") ? { GOPROXY: "file:///tmp/goproxy", GOSUMDB: "off", GOFLAGS: "-mod=mod" } : {});
for (const stackId of REAL) test(`${stackId} with distributed: generated suite passes against a REAL redis-server (none skipped)`, async (t) => {
  if (!(await hasTool(stackId.startsWith("node") || stackId === "nestjs" ? "node" : stackId.startsWith("go") ? "go" : "python3"))) return t.skip("toolchain not installed");
  if (!(await hasTool("redis-server"))) return t.skip("redis-server not installed");
  const port = 6391 + (REAL.indexOf(stackId));
  const redis = spawn("redis-server", ["--port", String(port), "--save", "", "--appendonly", "no"], { stdio: "ignore" });
  try {
    await new Promise((r) => setTimeout(r, 800));
    for (const auth of [true, false]) {
      const s = spec(stackId, auth);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sierra-dist-"));
      await writeFiles(dir, registry.generate(s));
      const res = await validateStack(registry.get(stackId), dir, { spec: s, env: { ...process.env, ...goEnv(), REDIS_URL: `redis://127.0.0.1:${port}/15`, NO_PROXY: "" } });
      const out = res.steps.at(-1) ? res.steps.at(-1).output : "";
      if (res.status === "skipped" && stackId === "go-nethttp") { fs.rmSync(dir, { recursive: true, force: true }); return t.skip(res.reason); }
      assert.equal(res.status, "passed", out);
      if (stackId === "go-nethttp") { // go test is quiet about skips: run it verbosely and require every distributed test to PASS and none to SKIP
        const v = require("child_process").execFileSync("go", ["test", "./...", "-v", "-count=1"], { cwd: dir, env: { ...process.env, ...goEnv(), REDIS_URL: `redis://127.0.0.1:${port}/15` }, encoding: "utf8" });
        assert.doesNotMatch(v, /--- SKIP/, v);
        assert.ok((v.match(/^--- PASS: Test(Distributed|Guard|Rate|Idempot|Lock|Breaker|Without|Main)/gm) || []).length >= 13, v);
      }
      fs.rmSync(dir, { recursive: true, force: true });
      assert.doesNotMatch(out, /skipped/i, "redis tests must run, not be skipped: " + out);
    }
  } finally { redis.kill(); }
});
