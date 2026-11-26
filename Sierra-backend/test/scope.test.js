const test = require("node:test");
const assert = require("node:assert/strict");
const { scopeFor, applyScope } = require("../src/engine/scope");
const { analyzeRequirement } = require("../src/agents/requirementAgent");
const { generateProject } = require("../src/agents/codeGeneratorAgent");

test("Docker and CI are generated only when asked for", () => {
  assert.deepEqual(scopeFor("Simple API: books (title, author, isbn)"), { docker: false, ci: false });
  assert.deepEqual(scopeFor("Notes API with docker and github actions"), { docker: true, ci: true });
  assert.equal(scopeFor("anything", { architecture: "microservices" }).docker, true);
});

test("applyScope drops container/CI files and their README sections, keeps the rest", () => {
  const files = { "Dockerfile": "x", ".dockerignore": "x", "docker-compose.yml": "x", ".github/workflows/ci.yml": "x", "src/app.js": "x",
    "README.md": "# t\n\n## Run\nnpm start\n\n## Docker\n```\ndocker compose up\n```\n\n## Endpoints\n- GET /health\n\n## Continuous integration\nci.yml\n" };
  const out = applyScope(files, { docker: false, ci: false });
  assert.deepEqual(Object.keys(out).sort(), ["README.md", "src/app.js"]);
  assert.ok(!/docker|ci\.yml/i.test(out["README.md"]));
  assert.match(out["README.md"], /## Endpoints/);
  assert.equal(Object.keys(applyScope(files, { docker: true, ci: true })).length, 6);
});

test('"author" no longer triggers auth; real auth words still do', async () => {
  assert.equal((await analyzeRequirement("Simple API: books (title, author, isbn)")).needsAuth, false);
  assert.equal((await analyzeRequirement("Blog API: posts, comments, author login.")).needsAuth, true);
  assert.equal((await analyzeRequirement("Library: books. Members can register and log in.")).needsAuth, true);
});

test("Express: no Dockerfile unless scope.docker", () => {
  const base = { needsAuth: false, primaryEntities: ["Book"], endpoints: [] };
  assert.ok(!("Dockerfile" in generateProject({ projectName: "x", analysis: { ...base, scope: { docker: false } } })));
  assert.ok("Dockerfile" in generateProject({ projectName: "x", analysis: { ...base, scope: { docker: true } } }));
});
