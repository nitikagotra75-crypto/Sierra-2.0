function pluralOf(entityLower) {
  return entityLower + (entityLower.endsWith("s") ? "es" : "s");
}

// Generic fields used only when the requirement/LLM gave no fields for the entity.
const GENERIC_FIELDS = [
  { name: "title", type: "string", required: true },
  { name: "description", type: "text", required: false, default: "" },
  { name: "status", type: "enum", required: false, values: ["pending", "in-progress", "completed"], default: "pending" },
];
const fieldsOf = (def) => (def && def.fields && def.fields.length ? def.fields : GENERIC_FIELDS);
const MONGOOSE_TYPE = { string: "String", text: "String", int: "Number", float: "Number", bool: "Boolean", enum: "String" };

function mongooseField(f) {
  const parts = [`type: ${MONGOOSE_TYPE[f.type] || "String"}`];
  if (f.type === "string" || f.type === "text") parts.push("trim: true");
  if (f.required && f.default === undefined) parts.push("required: true");
  if (f.type === "enum") parts.push(`enum: ${JSON.stringify(f.values)}`);
  if (f.type === "int") parts.push('validate: { validator: Number.isInteger, message: "{PATH} must be an integer" }');
  if (f.default !== undefined) parts.push(`default: ${JSON.stringify(f.default)}`);
  else if (f.type === "text") parts.push('default: ""');
  return `    ${f.name}: { ${parts.join(", ")} },`;
}

function entityModel(entity, needsAuth, def) {
  return `const mongoose = require("mongoose");

const ${entity.toLowerCase()}Schema = new mongoose.Schema(
  {
${fieldsOf(def).map(mongooseField).join("\n")}
    ${needsAuth ? `owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },` : ""}
  },
  { timestamps: true }
);

module.exports = mongoose.model("${entity}", ${entity.toLowerCase()}Schema);
`;
}

function validatorChain(f, optional) {
  let c = `body("${f.name}")`;
  if (optional) c += ".optional()";
  if (f.type === "string" || f.type === "text") c += `.isString().withMessage("${f.name} must be a string").trim()` + (f.required && !optional ? `.notEmpty().withMessage("${f.name} is required")` : "");
  else if (f.type === "int") c += `.isInt().withMessage("${f.name} must be an integer").toInt()`;
  else if (f.type === "float") c += `.isFloat().withMessage("${f.name} must be a number").toFloat()`;
  else if (f.type === "bool") c += `.isBoolean().withMessage("${f.name} must be true or false").toBoolean()`;
  else if (f.type === "enum") c += `.isIn(${JSON.stringify(f.values)}).withMessage("${f.name} must be one of ${f.values.join(", ")}")`;
  if (!optional && f.required && f.default === undefined && !/notEmpty/.test(c)) c = c.replace(/^body\("([^"]+)"\)/, 'body("$1").exists({ checkNull: true }).withMessage("$1 is required")');
  return c;
}

function entityValidators(entity, def) {
  const lower = entity.toLowerCase();
  const fields = fieldsOf(def);
  return `const { body, param } = require("express-validator");

const create${entity}Validators = [
${fields.map((f) => `  ${validatorChain(f, !(f.required && f.default === undefined))},`).join("\n")}
];

const update${entity}Validators = [
  param("id").isMongoId().withMessage("Invalid ${lower} id"),
${fields.map((f) => `  ${validatorChain(f, true)},`).join("\n")}
];

const id${entity}Validator = [param("id").isMongoId().withMessage("Invalid ${lower} id")];

module.exports = { create${entity}Validators, update${entity}Validators, id${entity}Validator };
`;
}

function entityService(entity, needsAuth) {
  const Model = entity;
  return `const ${Model} = require("../models/${Model}");

async function list${entity}s(${needsAuth ? "ownerId" : ""}) {
  const filter = ${needsAuth ? "{ owner: ownerId }" : "{}"};
  return ${Model}.find(filter).sort({ createdAt: -1 });
}

async function get${entity}(id${needsAuth ? ", ownerId" : ""}) {
  const filter = { _id: id${needsAuth ? ", owner: ownerId" : ""} };
  const doc = await ${Model}.findOne(filter);
  if (!doc) {
    const err = new Error("${entity} not found");
    err.statusCode = 404;
    throw err;
  }
  return doc;
}

async function create${entity}(data${needsAuth ? ", ownerId" : ""}) {
  const payload = { ...data${needsAuth ? ", owner: ownerId" : ""} };
  return ${Model}.create(payload);
}

async function update${entity}(id, data${needsAuth ? ", ownerId" : ""}) {
  const filter = { _id: id${needsAuth ? ", owner: ownerId" : ""} };
  const doc = await ${Model}.findOneAndUpdate(filter, data, { new: true, runValidators: true });
  if (!doc) {
    const err = new Error("${entity} not found");
    err.statusCode = 404;
    throw err;
  }
  return doc;
}

async function delete${entity}(id${needsAuth ? ", ownerId" : ""}) {
  const filter = { _id: id${needsAuth ? ", owner: ownerId" : ""} };
  const doc = await ${Model}.findOneAndDelete(filter);
  if (!doc) {
    const err = new Error("${entity} not found");
    err.statusCode = 404;
    throw err;
  }
  return doc;
}

module.exports = { list${entity}s, get${entity}, create${entity}, update${entity}, delete${entity} };
`;
}

function entityController(entity, needsAuth) {
  const svc = entity.toLowerCase() + "Service";
  return `const { validationResult } = require("express-validator");
const service = require("../services/${svc}");

function ownerOf(req) {
  return ${needsAuth ? "req.userId" : "undefined"};
}

async function list(req, res, next) {
  try {
    const items = await service.list${entity}s(ownerOf(req));
    res.status(200).json({ items });
  } catch (err) {
    next(err);
  }
}

async function getOne(req, res, next) {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: "Validation failed", details: errors.array() });
    const item = await service.get${entity}(req.params.id, ownerOf(req));
    res.status(200).json({ item });
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: "Validation failed", details: errors.array() });
    const item = await service.create${entity}(req.body, ownerOf(req));
    res.status(201).json({ item });
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: "Validation failed", details: errors.array() });
    const item = await service.update${entity}(req.params.id, req.body, ownerOf(req));
    res.status(200).json({ item });
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: "Validation failed", details: errors.array() });
    await service.delete${entity}(req.params.id, ownerOf(req));
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

module.exports = { list, getOne, create, update, remove };
`;
}

function entityRoutes(entity, needsAuth) {
  const lower = entity.toLowerCase();
  return `const express = require("express");
const router = express.Router();
const controller = require("../controllers/${lower}Controller");
const { create${entity}Validators, update${entity}Validators, id${entity}Validator } = require("../validators/${lower}Validators");
${needsAuth ? `const { requireAuth } = require("../middleware/auth");` : ""}

${needsAuth ? "router.use(requireAuth);" : ""}

router.get("/", controller.list);
router.get("/:id", id${entity}Validator, controller.getOne);
router.post("/", create${entity}Validators, controller.create);
router.put("/:id", update${entity}Validators, controller.update);
router.delete("/:id", id${entity}Validator, controller.remove);

module.exports = router;
`;
}

const sampleValue = (f, tag) => (f.type === "string" || f.type === "text") ? `${f.name} ${tag}` : f.type === "int" ? 3 : f.type === "float" ? 9.5 : f.type === "bool" ? true : f.values[0];
const otherValue = (f) => (f.type === "string" || f.type === "text") ? `${f.name} updated` : f.type === "int" ? 7 : f.type === "float" ? 12.25 : f.type === "bool" ? false : f.values[f.values.length - 1];

function entityTests(entity, needsAuth, def) {
  const fields = fieldsOf(def);
  const lower = entity.toLowerCase();
  const plural = pluralOf(lower);
  const sent = Object.fromEntries(fields.filter((f) => f.required || f.type !== "enum").map((f) => [f.name, sampleValue(f, "one")]));
  const body = JSON.stringify(sent);
  const first = fields.find((f) => f.required) || fields[0];
  const upd = fields.find((f) => f.type === "enum") || fields.find((f) => !f.required) || fields[0];
  const updBody = JSON.stringify({ [upd.name]: otherValue(upd) });
  const required = fields.find((f) => f.required && f.default === undefined);
  return `const request = require("supertest");
const mongoose = require("mongoose");
const { createApp } = require("../src/app");

const app = createApp();

beforeAll(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  ${needsAuth ? "" : ""}
});

afterAll(async () => {
  await mongoose.connection.close();
});

describe("${entity} CRUD", () => {
  let token;
  let createdId;

  beforeAll(async () => {
    ${needsAuth
      ? `const email = \`${lower}_\${Date.now()}@example.com\`;
    await request(app).post("/api/auth/register").send({ email, password: "password123" });
    const loginRes = await request(app).post("/api/auth/login").send({ email, password: "password123" });
    token = loginRes.body.token;`
      : "// no auth required for this resource"}
  });

  function auth(req) {
    return ${needsAuth ? "req.set(\"Authorization\", `Bearer ${token}`)" : "req"};
  }

  it("creates a new ${lower}", async () => {
    const res = await auth(request(app).post("/api/${plural}")).send(${body});
    expect(res.status).toBe(201);
    expect(res.body.item.${first.name}).toBe(${JSON.stringify(sent[first.name])});
    createdId = res.body.item._id;
  });

  ${required ? `it("rejects a ${lower} without the required ${required.name}", async () => {
    const res = await auth(request(app).post("/api/${plural}")).send({});
    expect(res.status).toBe(400);
  });

  ` : ""}it("lists ${plural}", async () => {
    const res = await auth(request(app).get("/api/${plural}"));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  it("gets a single ${lower} by id", async () => {
    const res = await auth(request(app).get(\`/api/${plural}/\${createdId}\`));
    expect(res.status).toBe(200);
    expect(res.body.item._id).toBe(createdId);
  });

  it("updates a ${lower}", async () => {
    const res = await auth(request(app).put(\`/api/${plural}/\${createdId}\`)).send(${updBody});
    expect(res.status).toBe(200);
    expect(res.body.item.${upd.name}).toBe(${JSON.stringify(otherValue(upd))});
  });

  it("deletes a ${lower}", async () => {
    const res = await auth(request(app).delete(\`/api/${plural}/\${createdId}\`));
    expect(res.status).toBe(204);
  });

  it("returns 404 for a deleted ${lower}", async () => {
    const res = await auth(request(app).get(\`/api/${plural}/\${createdId}\`));
    expect(res.status).toBe(404);
  });
});
`;
}

module.exports = { fieldsOf, pluralOf, entityModel, entityValidators, entityService, entityController, entityRoutes, entityTests };