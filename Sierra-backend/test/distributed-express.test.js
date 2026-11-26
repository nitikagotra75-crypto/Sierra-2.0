const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path"), net = require("net");
const { spawnSync } = require("child_process");
const { registry, buildSpec } = require("../src/engine");
const { writeFiles } = require("../src/execution/executionManager");

const spec = (auth) => buildSpec({ projectName: "Shop", analysis: { needsAuth: auth, primaryEntities: [{ name: "Product", fields: [{ name: "title", type: "string", required: true }] }, { name: "Order", fields: [{ name: "note", type: "string", required: true }] }] }, options: { stack: "node-express", features: { distributed: true } } });
const redisUp = () => new Promise((r) => { const s = net.connect(6379, "127.0.0.1"); s.setTimeout(800); s.on("connect", () => { s.destroy(); r(true); }); s.on("error", () => r(false)); s.on("timeout", () => { s.destroy(); r(false); }); });
const sh = (cmd, args, cwd, env = {}) => spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, ...env }, timeout: 240000 });

test("express + distributed: wiring, scripts and CI are generated; the Redis core test is part of the validated test step", () => {
  const f = registry.generate(spec(true));
  assert.match(f["src/app.js"], /registerDistributed\(app\);/);
  assert.ok(f["src/distributed.js"] && f["src/dist_express.js"] && f["test/distributed_redis.node.js"] && f["test/distributed_api.test.js"]);
  assert.match(f["package.json"], /"ioredis"/);
  assert.match(f[".github/workflows/ci.yml"], /redis:7-alpine/);
  assert.match(f[".github/workflows/ci.yml"], /node --test test\/distributed_redis\.node\.js/);
  assert.ok(!registry.generate(buildSpec({ projectName: "Shop", analysis: { primaryEntities: ["Task"] }, options: { stack: "node-express" } }))["src/dist_express.js"], "off unless requested");
});

for (const auth of [true, false]) {
  test(`express + distributed (auth=${auth}): Redis core + HTTP tests pass against a REAL Redis (the 1 test that stores data needs MongoDB and is not run here)`, async (t) => {
    if (!(await redisUp())) return t.skip("Redis not reachable (skipped, not passed)");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sierra-exd-"));
    await writeFiles(dir, registry.generate(spec(auth)));
    const inst = sh("npm", ["install", "--no-audit", "--no-fund"], dir);
    if (inst.status !== 0) return t.skip("npm registry not reachable");
    const env = { REDIS_URL: "redis://localhost:6379" };
    const core = sh("node", ["--test", "test/distributed_redis.node.js"], dir, env);
    assert.strictEqual(core.status, 0, core.stdout + core.stderr);
    assert.doesNotMatch(core.stdout, /# skipped [1-9]/);
    const api = sh("npx", ["jest", "--runInBand", "--forceExit", "test/distributed_api.test.js", "-t", "429|replayed|Redis down|disabled|bare"], dir, env);
    assert.strictEqual(api.status, 0, api.stdout + api.stderr);
    assert.match(api.stderr + api.stdout, /5 passed/);
    // mutation: an adapter that never stores the response must be caught by the DB-free success-path test
    const p = path.join(dir, "src/dist_express.js");
    fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("guard.finish(ctx, res.statusCode, body,", "Promise.resolve(("));
    const mut = sh("npx", ["jest", "--runInBand", "--forceExit", "test/distributed_api.test.js", "-t", "bare"], dir, env);
    assert.notStrictEqual(mut.status, 0, "storing nothing must fail the replay test");
  });
}
