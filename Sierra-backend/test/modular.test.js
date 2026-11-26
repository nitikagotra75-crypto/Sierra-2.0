const test = require("node:test");
const assert = require("node:assert");
const { registry, buildSpec } = require("../src/engine");
const { checkModules, moduleOwnership } = require("../src/engine/architecture");
const { checkFileSet } = require("../src/engine/validate");

const spec = (stack, o = {}) => buildSpec({ projectName: "Shop", analysis: { needsAuth: !!o.auth, primaryEntities: ["Product", "Order"] }, options: { stack, architecture: "modular", database: o.database } });
const STACKS = ["nestjs", "node-fastify", "python-fastapi", "python-flask", "python-django", "go-nethttp", "go-gin", "go-fiber", "spring-boot", "aspnet-core", "node-express"];

test("modular needs >= 2 entities", () => {
  assert.throws(() => registry.generate(buildSpec({ projectName: "X", analysis: { primaryEntities: ["Task"] }, options: { stack: "nestjs", architecture: "modular" } })), (e) => e.statusCode === 400 && /at least 2 entities/.test(e.message));
});

for (const stack of STACKS) test(`${stack}: every entity is a module with its own files, MODULES.md documents it, and the boundary check passes`, () => {
  const s = spec(stack, { auth: true });
  const f = registry.generate(s);
  assert.ok(f["MODULES.md"]);
  const { owned } = moduleOwnership(f, s);
  for (const e of s.entities) { assert.ok(owned[e.name].length > 0, `${stack}: no files for ${e.name}`); assert.match(f["MODULES.md"], new RegExp("### " + e.name)); }
  const r = checkModules(f, s);
  assert.equal(r.level, "pass", r.detail);
  assert.ok(checkFileSet(f, s).some((c) => c.check === "module-boundaries" && c.level === "pass"));
  assert.ok(!checkFileSet(f).some((c) => c.check === "module-boundaries"), "monolith specs are not checked");
});

// The check must actually catch a violation (mutation): make Order's code import Product's code in each language.
const IMPORT = { js: (n) => `const x = require("./${n}");`, ts: (n) => `import { X } from "../${n}/${n}.service";`, py: (n) => `from app.services.${n}_service import X`, go: (n) => `import "shop/internal/${n}"`, java: (n) => `import app.${n}.${n[0].toUpperCase() + n.slice(1)}Service;`, cs: (n) => `using Api.Services.${n[0].toUpperCase() + n.slice(1)}Service;` };
for (const stack of STACKS) test(`${stack}: a cross-module import is detected`, () => {
  const s = spec(stack);
  const f = registry.generate(s);
  const { owned } = moduleOwnership(f, s);
  const victim = owned.Order.find((p) => /\.(js|ts|py|go|java|cs)$/.test(p));
  const ext = victim.split(".").pop();
  const bad = { ...f, [victim]: IMPORT[ext]("product") + "\n" + f[victim] };
  const r = checkModules(bad, s);
  assert.equal(r.level, "fail", `${stack} ${victim}`);
  assert.match(r.detail, /\(module Order\) imports module Product/);
});
