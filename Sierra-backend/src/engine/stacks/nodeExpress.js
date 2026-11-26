// Wraps the original (pre-2.0) Express/Mongoose generator unchanged, so existing behaviour is preserved.
const { generateProject } = require("../../agents/codeGeneratorAgent");

module.exports = {
  id: "node-express",
  label: "Node.js + Express",
  language: "JavaScript",
  framework: "Express",
  status: "implemented",
  databases: ["mongodb"],
  generate(spec) {
    const endpoints = [
      ...(spec.needsAuth ? [{ method: "POST", path: "/api/auth/register" }, { method: "POST", path: "/api/auth/login" }] : []),
      ...spec.entities.flatMap((e) => [
        { method: "GET", path: `/api/${e.plural}` }, { method: "POST", path: `/api/${e.plural}` },
        { method: "GET", path: `/api/${e.plural}/:id` }, { method: "PUT", path: `/api/${e.plural}/:id` }, { method: "DELETE", path: `/api/${e.plural}/:id` },
      ]),
    ];
    return generateProject({
      projectName: spec.name,
      analysis: { needsAuth: spec.needsAuth, primaryEntities: spec.entities.map((e) => e.name), endpoints },
    });
  },
  validate: {
    toolchain: "node",
    // The generated tests use a real MongoDB through MONGODB_URI (no in-memory fake). Provide one with
    // `docker compose -f docker-compose.test.yml up -d` (generated in the project) or point MONGODB_URI at any instance.
    requires: [{ name: "MongoDB", env: "MONGODB_URI", fallback: "mongodb://127.0.0.1:27017/sierra_test", hint: "Start one with `docker run -d -p 27017:27017 mongo:7` or set MONGODB_URI; the generated GitHub Actions workflow starts a Mongo service container." }],
    setup: [["npm", "install", "--no-audit", "--no-fund"]], test: [["npx", "jest", "--runInBand", "--forceExit"]] },
};
