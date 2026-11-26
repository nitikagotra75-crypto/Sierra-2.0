const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawnSync } = require("node:child_process");
const { registry, buildSpec } = require("../src/engine");
const { writeFiles } = require("../src/execution/executionManager");

const spec = (stack, auth) => buildSpec({ projectName: "Shop", analysis: { needsAuth: auth, primaryEntities: [{ name: "Product", fields: [{ name: "title", type: "string", required: true }] }, { name: "Order", fields: [{ name: "note", type: "string", required: true }] }] }, options: { stack, features: { distributed: true } } });
const redisUp = () => new Promise((r) => { const s = net.connect(6379, "127.0.0.1"); s.on("connect", () => { s.destroy(); r(true); }); s.on("error", () => r(false)); });
const hasGo = () => spawnSync("go", ["version"]).status === 0;

for (const stack of ["go-gin", "go-fiber"]) for (const auth of [true, false]) {
  test(`${stack} (auth=${auth}) with distributed: guard wraps the handler, files are gofmt-clean, shared package passes against a REAL Redis`, async (t) => {
    const f = registry.generate(spec(stack, auth));
    assert.match(f["cmd/server/main.go"], /guard\.Middleware\(app\.New\(cfg\)\)/);
    assert.match(f["cmd/server/main.go"], /defer guard\.Close\(\)/);
    assert.match(f["go.mod"], /gomodule\/redigo v1\.8\.9/);
    assert.ok(f["cmd/server/main_test.go"] && f["internal/distributed/guard.go"]);
    assert.throws(() => registry.generate(buildSpec({ projectName: "Shop", analysis: { needsAuth: auth, primaryEntities: [{ name: "A", fields: [{ name: "t", type: "string", required: true }] }] }, options: { stack: "express" === stack ? "x" : "spring-boot", features: { distributed: true } } })), (e) => e.statusCode === 400);
    if (!hasGo()) return t.skip("go not installed");
    if (!(await redisUp())) return t.skip("no redis on :6379 (skipped, not passed)");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sierra-gofw-"));
    await writeFiles(dir, f);
    const env = { ...process.env, REDIS_URL: "redis://localhost:6379/13", GOFLAGS: "-mod=mod" };
    if (fs.existsSync("/tmp/goproxy")) Object.assign(env, { GOPROXY: "file:///tmp/goproxy", GOSUMDB: "off" });
    const fmt = spawnSync("gofmt", ["-l", "."], { cwd: dir, encoding: "utf8" });
    assert.equal(fmt.stdout.trim(), "");
    // Only the framework-free package can be built where Gin/Fiber cannot be downloaded.
    const r = spawnSync("go", ["test", "-count=1", "-v", "./internal/distributed/"], { cwd: dir, env, encoding: "utf8" });
    if (/no required module provides|dial tcp|proxy|lookup/.test(r.stderr + r.stdout) && r.status !== 0) return t.skip("go modules unreachable");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok((r.stdout.match(/^--- PASS/gm) || []).length >= 10);
    assert.doesNotMatch(r.stdout, /^--- SKIP/m);
  });
}
