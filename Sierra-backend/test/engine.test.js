const test = require("node:test");
const assert = require("node:assert");
const { registry, buildSpec } = require("../src/engine");
const { checkFileSet, hasTool } = require("../src/engine/validate");

const analysis = (needsAuth) => ({ needsAuth, primaryEntities: ["Task", "Category"] });
const specFor = (stack, needsAuth = true, database) => buildSpec({ projectName: "Demo API", analysis: analysis(needsAuth), options: { stack, database } });

test("registry lists implemented and planned stacks honestly", () => {
  const list = registry.list();
  const byId = Object.fromEntries(list.map((s) => [s.id, s]));
  for (const id of ["node-express", "python-fastapi", "python-flask", "python-django", "node-fastify", "nestjs", "go-nethttp", "go-gin", "go-fiber", "spring-boot", "aspnet-core"]) assert.equal(byId[id].status, "implemented", id);
});

test("planned and unknown stacks are refused, not faked", () => {
  registry.register({ id: "tmp-planned", label: "Tmp", language: "X", framework: "X", status: "planned", databases: [], notes: "" });
  assert.throws(() => registry.generate(specFor("tmp-planned")), (e) => e.statusCode === 501);
  assert.throws(() => registry.generate(specFor("nope")), (e) => e.statusCode === 400);
});

test("unsupported database for a stack is refused", () => {
  assert.throws(() => registry.generate(specFor("go-nethttp", true, "mongodb")), (e) => e.statusCode === 400);
});

test("spec rejects bad identifiers (no code injection through entity names)", () => {
  assert.throws(() => buildSpec({ projectName: "x", analysis: { primaryEntities: ['Task"; drop'] } }));
  assert.throws(() => buildSpec({ projectName: "x", analysis: { primaryEntities: [{ name: "Task", fields: [{ name: "a b", type: "string" }] }] } }));
  assert.throws(() => buildSpec({ projectName: "x", analysis: { primaryEntities: [{ name: "Task", fields: [{ name: "a", type: "blob" }] }] } }));
});

for (const stack of ["node-express", "python-fastapi", "python-flask", "python-django", "node-fastify", "nestjs", "go-nethttp", "go-gin", "go-fiber", "spring-boot", "aspnet-core"]) {
  for (const auth of [true, false]) {
    test(`${stack} generates a complete file set (auth=${auth})`, () => {
      const files = registry.generate(specFor(stack, auth));
      assert.ok(Object.keys(files).length > 10);
      const failed = checkFileSet(files).filter((c) => c.level === "fail");
      assert.deepEqual(failed, []);
      for (const [p, c] of Object.entries(files)) assert.equal(typeof c, "string", p);
      assert.equal(Object.keys(files).some((p) => /auth/i.test(p)), auth);
      assert.ok(!Object.values(files).join("\n").includes("__APPMOD__"));
    });
  }
}

test("custom entity fields flow into generated FastAPI and Go code", () => {
  const a = { needsAuth: false, primaryEntities: [{ name: "Product", fields: [
    { name: "name", type: "string", required: true },
    { name: "price", type: "float", required: true },
    { name: "inStock", type: "bool", required: false, default: true },
  ] }] };
  for (const stack of ["python-fastapi", "python-flask", "python-django", "node-fastify", "nestjs", "go-nethttp", "go-gin", "go-fiber", "spring-boot", "aspnet-core"]) {
    const files = registry.generate(buildSpec({ projectName: "Shop", analysis: a, options: { stack } }));
    const all = Object.values(files).join("\n");
    assert.match(all, /price/);
    assert.match(all, /inStock/);
  }
});

// ---- Real toolchain runs (skipped if the tool is not installed on the machine running the tests) ----
const { validateStack, writeFiles } = require("../src/engine/validate");
const os = require("os"), path = require("path"), fs = require("fs");
const { runCommand } = require("../src/execution/executionManager");

for (const [stackId, tool] of [["go-nethttp", "go"], ["python-fastapi", "python3"], ["python-flask", "python3"], ["python-django", "python3"], ["node-fastify", "node"], ["nestjs", "node"]]) {
  for (const auth of [true, false]) {
    test(`${stackId} generated project passes its own test suite (auth=${auth})`, async (t) => {
      if (!(await hasTool(tool))) return t.skip(`${tool} not installed`);
      const stack = registry.get(stackId);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sierra-${stackId}-`));
      await writeFiles(dir, registry.generate(specFor(stackId, auth)));
      const res = await validateStack(stack, dir, { env: { ...process.env, NO_PROXY: "" } });
      assert.equal(res.status, "passed", JSON.stringify(res.steps.slice(-1)));
      fs.rmSync(dir, { recursive: true, force: true });
    });
  }
}

test("validateStack reports skipped, never passed, when the toolchain is missing", async () => {
  const res = await validateStack({ validate: { toolchain: "definitely-not-a-real-binary", setup: [], test: [["x"]] } }, os.tmpdir());
  assert.equal(res.status, "skipped");
});

test("engine pipeline end-to-end (Go, local store): VERIFIED only after real tests pass", async (t) => {
  if (!(await hasTool("go"))) return t.skip("go not installed");
  global.__SIERRA_LOCAL_MODE__ = true;
  const { Project } = require("../src/models");
  const { runEnginePipeline } = require("../src/engine/pipeline");
  const projectId = "test-" + Date.now();
  await Project.create({ projectId, name: "Task Service", requirement: "Task API with user login and CRUD for tasks",
    techStack: { stack: "go-nethttp", database: "memory", architecture: "monolith" } });
  const report = await runEnginePipeline(projectId);
  assert.equal(report.status, "VERIFIED", JSON.stringify(report.validation && report.validation.steps));
  assert.equal(report.validation.status, "passed");
  fs.rmSync(path.join(__dirname, "..", "workspaces", projectId), { recursive: true, force: true });
});

test("NestJS project runs end-to-end through the pipeline and is VERIFIED only after jest passes", async (t) => {
  if (!(await hasTool("node"))) return t.skip("node missing");
  global.__SIERRA_LOCAL_MODE__ = true;
  const { Project } = require("../src/models");
  const { runEnginePipeline } = require("../src/engine/pipeline");
  const projectId = "test-nest-" + Date.now();
  await Project.create({ projectId, name: "Task Service", requirement: "Task API with user login and CRUD for tasks",
    techStack: { stack: "nestjs", database: "sqlite", architecture: "monolith" } });
  const report = await runEnginePipeline(projectId);
  assert.equal(report.status, "VERIFIED", JSON.stringify(report.validation && report.validation.steps));
  fs.rmSync(path.join(__dirname, "..", "workspaces", projectId), { recursive: true, force: true });
});

test("features are only accepted by stacks that implement them", () => {
  const withFeat = (stack, features) => buildSpec({ projectName: "Demo API", analysis: analysis(true), options: { stack, features } });
  assert.throws(() => registry.generate(withFeat("go-nethttp", { cache: true })), (e) => e.statusCode === 400);
  assert.throws(() => registry.generate(withFeat("python-flask", { events: "kafka" })), (e) => e.statusCode === 400);
  const files = registry.generate(withFeat("python-fastapi", { cache: true, events: "rabbitmq" }));
  assert.ok(files["app/core/cache.py"] && files["app/core/events.py"] && files["app/worker.py"]);
  assert.match(files["docker-compose.yml"], /rabbitmq/);
  assert.match(files["docker-compose.yml"], /redis/);
  const plain = registry.generate(withFeat("python-fastapi", {}));
  assert.ok(!plain["app/core/cache.py"] && !plain["app/worker.py"]);
});

test("FastAPI with cache + events passes its own test suite (real run)", async (t) => {
  if (!(await hasTool("python3"))) return t.skip("python3 not installed");
  const stack = registry.get("python-fastapi");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sierra-features-"));
  const spec = buildSpec({ projectName: "Feat API", analysis: analysis(true), options: { stack: "python-fastapi", database: "sqlite", features: { cache: true, events: "kafka" } } });
  await writeFiles(dir, registry.generate(spec));
  const res = await validateStack(stack, dir, { env: process.env });
  assert.equal(res.status, "passed", JSON.stringify(res.steps.slice(-1)));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- Stacks whose dependencies cannot be fetched offline: never "passed" unless they really passed ----
for (const [stackId, tool] of [["go-gin", "go"], ["go-fiber", "go"], ["spring-boot", "mvn"], ["aspnet-core", "dotnet"]]) {
  test(`${stackId}: validation is skipped when dependencies/toolchain are unavailable, and a real failure is never hidden`, async (t) => {
    const stack = registry.get(stackId);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sierra-${stackId}-`));
    await writeFiles(dir, registry.generate(specFor(stackId, true)));
    const res = await validateStack(stack, dir, { env: { ...process.env, NO_PROXY: "" } });
    fs.rmSync(dir, { recursive: true, force: true });
    assert.ok(["skipped", "passed"].includes(res.status), `${stackId} generated code failed its own tests: ${JSON.stringify(res.steps.slice(-1))}`);
    if (res.status === "skipped") assert.ok(res.reason, "skipped must say why");
    void tool;
  });
}

test("Gin/Fiber: generated Go parses, and the framework-free packages type-check", async (t) => {
  if (!(await hasTool("go"))) return t.skip("go not installed");
  for (const stackId of ["go-gin", "go-fiber"]) {
    for (const auth of [true, false]) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sierra-${stackId}-`));
      await writeFiles(dir, registry.generate(specFor(stackId, auth)));
      const fmt = await runCommand("gofmt", ["-e", "-l", "."], { cwd: dir, env: process.env });
      assert.ok(!/:\d+:\d+:/.test(fmt.stderr), `${stackId} syntax: ${fmt.stderr}`);
      const pkgs = ["./internal/httpx", "./internal/metrics", "./internal/config", ...(auth ? ["./internal/auth"] : [])];
      const vet = await runCommand("go", ["vet", ...pkgs], { cwd: dir, env: { ...process.env, NO_PROXY: "", GOFLAGS: "-mod=mod" } });
      assert.equal(vet.code, 0, `${stackId} vet: ${vet.stderr}`);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("Spring Boot: generated Java has no syntax errors (javac, dependency errors ignored)", async (t) => {
  if (!(await hasTool("javac"))) return t.skip("javac not installed");
  for (const auth of [true, false]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sierra-spring-"));
    await writeFiles(dir, registry.generate(specFor("spring-boot", auth)));
    const list = [];
    (function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) f.isDirectory() ? walk(path.join(d, f.name)) : f.name.endsWith(".java") && list.push(path.join(d, f.name)); })(dir);
    fs.writeFileSync(path.join(dir, "files.txt"), list.join("\n"));
    const r = await runCommand("javac", ["-proc:none", "-Xmaxerrs", "10000", "-d", path.join(dir, "out"), "@files.txt"], { cwd: dir, env: process.env });
    const syntax = (r.stderr + r.stdout).split("\n").filter((l) => /error:/.test(l) && !/does not exist|cannot find symbol|static import only|does not override|incompatible types|cannot be applied|is not abstract|cannot access|has private access|unreported exception|no suitable|bad operand|cannot be dereferenced/.test(l));
    assert.deepEqual(syntax, [], `auth=${auth}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- rateLimit feature: generated per stack, tested for real by the generated project's own suite ----
test("rateLimit is only accepted by stacks that implement it", () => {
  const withRl = (stack) => buildSpec({ projectName: "Demo", analysis: { needsAuth: true, primaryEntities: [{ name: "Task", fields: [{ name: "title", type: "string", required: true }] }] }, options: { stack, features: { rateLimit: true } } });
  for (const id of ["python-fastapi", "python-flask", "python-django", "node-fastify", "nestjs", "go-nethttp"]) {
    const files = registry.generate(withRl(id));
    assert.ok(Object.keys(files).some((f) => /rate.?limit/i.test(f)), id);
    assert.match(files[".env.example"], /RATE_LIMIT_PER_MINUTE/);
    assert.match(files["README.md"], /## Rate limiting/);
  }
  for (const id of ["node-express", "go-gin", "go-fiber", "spring-boot", "aspnet-core"]) {
    assert.throws(() => registry.generate(withRl(id)), (e) => e.statusCode === 400, id);
  }
  // off by default: no limiter files
  const off = registry.generate(specFor("python-fastapi", true));
  assert.ok(!Object.keys(off).some((f) => /ratelimit/.test(f)));
});

for (const [stackId, tool] of [["python-fastapi", "python3"], ["python-flask", "python3"], ["python-django", "python3"], ["node-fastify", "node"], ["nestjs", "node"], ["go-nethttp", "go"]]) {
  for (const auth of [true, false]) {
    test(`${stackId} with rateLimit passes its own tests (real run, auth=${auth})`, async (t) => {
      if (!(await hasTool(tool))) return t.skip(`${tool} not installed`);
      const spec = buildSpec({ projectName: "Demo", analysis: { needsAuth: auth, primaryEntities: [{ name: "Task", fields: [{ name: "title", type: "string", required: true }] }] }, options: { stack: stackId, features: { rateLimit: true } } });
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sierra-rl-${stackId}-`));
      await writeFiles(dir, registry.generate(spec));
      const res = await validateStack(registry.get(stackId), dir, { env: { ...process.env, NO_PROXY: "" } });
      fs.rmSync(dir, { recursive: true, force: true });
      assert.equal(res.status, "passed", JSON.stringify(res.steps.slice(-1)));
    });
  }
}

// ---- regression: non-zero defaults on bool/int/float fields (Go used to emit `in.Done == ""`, which did not compile) ----
test("go-nethttp: bool/int/float defaults compile, are gofmt-clean, and keep an explicit zero value", async (t) => {
  if (!(await hasTool("go"))) return t.skip("go not installed");
  const spec = buildSpec({ projectName: "Defaults", analysis: { needsAuth: false, primaryEntities: [{ name: "Task", fields: [
    { name: "title", type: "string", required: true }, { name: "done", type: "bool", required: false, default: true },
    { name: "prio", type: "int", required: false, default: 3 }, { name: "score", type: "float", required: false, default: 0.5 },
    { name: "note", type: "string", required: false, default: "n/a" } ] }] }, options: { stack: "go-nethttp" } });
  const files = registry.generate(spec);
  files["internal/task/defaults_test.go"] = `package task

import "testing"

func TestDefaultsAppliedOnlyWhenNotSent(t *testing.T) {
	svc := &Service{Repo: NewMemoryRepo()}
	got, err := svc.Create(CreateInput{Title: "a"}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if !got.Done || got.Prio != 3 || got.Score != 0.5 || got.Note != "n/a" {
		t.Fatalf("defaults not applied: %+v", got)
	}
	no := false
	zero := int64(0)
	got, err = svc.Create(CreateInput{Title: "b", Done: &no, Prio: &zero}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if got.Done || got.Prio != 0 {
		t.Fatalf("explicit zero values were overwritten by defaults: %+v", got)
	}
}
`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sierra-godef-"));
  await writeFiles(dir, files);
  const res = await validateStack(registry.get("go-nethttp"), dir, {});
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(res.status, "passed", JSON.stringify(res.steps.slice(-1)));
  assert.ok(res.steps.some((s) => s.phase === "format"), "gofmt check must run");
  assert.ok(res.steps.some((s) => s.phase === "build"), "go build must run");
});

test("validation reports SKIPPED (never passed) when a required service is unreachable, with how to provide it", async () => {
  const res = await validateStack(registry.get("node-express"), os.tmpdir(), { env: { ...process.env, MONGODB_URI: "mongodb://127.0.0.1:1/none" } });
  assert.equal(res.status, "skipped");
  assert.equal(res.missingService, "MongoDB");
  assert.match(res.reason, /docker run|MONGODB_URI/);
  assert.equal(res.steps.length, 0);
});

test("every implemented stack ships a CI workflow; express also ships a Mongo test compose", () => {
  for (const s of registry.list().filter((x) => x.status === "implemented")) {
    const files = registry.generate(buildSpec({ projectName: "Demo", analysis: { needsAuth: true, primaryEntities: [{ name: "Task", fields: [{ name: "title", type: "string", required: true }] }] }, options: { stack: s.id } }));
    assert.ok(files[".github/workflows/ci.yml"], s.id);
    assert.match(files[".github/workflows/ci.yml"], /hadolint/);
    assert.match(files["README.md"], /## Continuous integration/, s.id);
    if (s.id === "node-express") {
      assert.match(files[".github/workflows/ci.yml"], /mongo:7/);
      assert.match(files["docker-compose.test.yml"], /mongo:7/);
    }
  }
});
