// Without SIERRA_EXPERIMENTAL a default install offers only stacks Sierra could verify, and says why for the rest.
const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("child_process");
const path = require("path");

const run = (env, code) => spawnSync(process.execPath, ["-e", code], { cwd: path.join(__dirname, ".."), env: { ...process.env, ...env }, encoding: "utf8" });
const ids = (env) => JSON.parse(run(env, 'console.log(JSON.stringify(require("./src/engine").registry.list().map(s=>s.id)))').stdout);

test("default scope: only verified stacks are offered; experimental ones need SIERRA_EXPERIMENTAL=1", () => {
  const def = ids({ SIERRA_EXPERIMENTAL: "" });
  for (const id of ["node-express", "node-fastify", "nestjs", "python-fastapi", "python-flask", "python-django", "go-nethttp", "go-gin"]) assert.ok(def.includes(id), id);
  for (const id of ["go-fiber", "spring-boot", "aspnet-core"]) assert.ok(!def.includes(id), id + " must not be offered by default");
  const exp = ids({ SIERRA_EXPERIMENTAL: "1" });
  for (const id of ["go-fiber", "spring-boot", "aspnet-core"]) assert.ok(exp.includes(id), id);
});

test("default scope: kafka events are refused with a clear 400, rabbitmq is fine", () => {
  const code = (events) => `const {registry,buildSpec}=require("./src/engine");try{registry.generate(buildSpec({projectName:"X",analysis:{needsAuth:false,primaryEntities:["Task"]},options:{stack:"python-fastapi",features:{events:"${events}"}}}));console.log("ok")}catch(e){console.log(e.statusCode+" "+e.message)}`;
  assert.match(run({ SIERRA_EXPERIMENTAL: "" }, code("kafka")).stdout, /^400 events: kafka is experimental/);
  assert.match(run({ SIERRA_EXPERIMENTAL: "" }, code("rabbitmq")).stdout, /^ok/);
  assert.match(run({ SIERRA_EXPERIMENTAL: "1" }, code("kafka")).stdout, /^ok/);
});
