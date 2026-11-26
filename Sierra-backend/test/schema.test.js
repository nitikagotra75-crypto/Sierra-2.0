const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { validateSchema, designSchema } = require("../src/engine/schemaAgent");
const { registry, buildSpec } = require("../src/engine");
const { validateStack, hasTool } = require("../src/engine/validate");
const { writeFiles } = require("../src/execution/executionManager");

const SHOP = { entities: [
  { name: "Customer", fields: [{ name: "email", type: "string", required: true }, { name: "fullName", type: "string", required: true }, { name: "loyaltyPoints", type: "integer", default: 0 }] },
  { name: "Product", fields: [{ name: "name", type: "string", required: true }, { name: "price", type: "number", required: true }, { name: "inStock", type: "boolean", default: true }] },
  { name: "Order", fields: [{ name: "customerId", type: "int", required: true, references: "Customer" }, { name: "status", type: "enum", values: ["pending", "paid", "shipped"], default: "pending" }, { name: "total", type: "float", required: true }] },
  { name: "Payment", fields: [{ name: "orderId", type: "int", required: true, references: "Order" }, { name: "amount", type: "float", required: true }, { name: "method", type: "enum", values: ["card", "upi", "cod"], required: true }] },
  { name: "Shipment", fields: [{ name: "orderId", type: "int", required: true, references: "Order" }, { name: "carrier", type: "string" }, { name: "trackingCode", type: "string" }, { name: "address", type: "nested" }] },
] };

test("validateSchema accepts a realistic e-commerce schema, normalises types, reports what is not generated", () => {
  const r = validateSchema(SHOP);
  assert.deepEqual(r.entities.map((e) => e.name), ["Customer", "Product", "Order", "Payment", "Shipment"]);
  assert.equal(r.entities[0].fields[2].type, "int"); assert.equal(r.entities[1].fields[1].type, "float"); assert.equal(r.entities[1].fields[2].type, "bool");
  assert.equal(r.entities[2].fields[0].references, "Customer");
  assert.ok(r.unsupported.some((u) => /Shipment\.address: nested/.test(u)));
  assert.ok(r.unsupported.some((u) => /FOREIGN KEY/.test(u)));
  assert.ok(!r.entities[4].fields.some((f) => f.name === "address"));
});

test("validateSchema rejects hostile or invalid model output instead of passing it to the generators", () => {
  const bad = { entities: [
    { name: "x; DROP TABLE", fields: [{ name: "a", type: "string" }] },
    { name: "User", fields: [{ name: "a", type: "string" }] },
    { name: "Thing", fields: [{ name: "id", type: "int" }, { name: "class", type: "string" }, { name: "ok", type: "string", required: true }, { name: "bad-name", type: "string" }, { name: "n", type: "int", default: "x" }, { name: "e", type: "enum", values: [] }, { name: "t", type: "blob" }, { name: "ref", type: "int", references: "Nope" }] },
    { name: "Thing", fields: [{ name: "a", type: "string" }] },
  ] };
  const r = validateSchema(bad);
  assert.deepEqual(r.entities.map((e) => e.name), ["Thing"]);
  assert.deepEqual(r.entities[0].fields.map((f) => f.name), ["ok"]);
  assert.ok(r.issues.length >= 9, r.issues.join("\n"));
  assert.equal(validateSchema({}).entities.length, 0); assert.equal(validateSchema(null).entities.length, 0);
});

test("designSchema: no LLM -> default (never invented); bad answer -> default with the reasons; good answer -> llm", async () => {
  const none = await designSchema("shop", { ask: null });
  if (!require("../src/agents/llm").hasLLM) { assert.equal(none.source, "default"); assert.match(none.issues[0], /no LLM/); }
  assert.equal((await designSchema("x", { ask: async () => { throw new Error("rate limited"); } })).source, "default");
  const junk = await designSchema("x", { ask: async () => ({ entities: [{ name: "lower", fields: [] }] }) });
  assert.equal(junk.source, "default"); assert.ok(junk.issues.length);
  let seen;
  const ok = await designSchema("Build an e-commerce backend with customers, orders, products, payments and shipping.", { ask: async (q) => { seen = q; return SHOP; } });
  assert.equal(ok.source, "llm"); assert.equal(ok.entities.length, 5); assert.match(seen.prompt, /e-commerce/);
});

// The proof that the designed schema is carried consistently into model, API, validation and the generated project's own tests.
test("python-fastapi: an LLM-designed e-commerce schema generates and passes the project's own tests (real run)", async (t) => {
  if (!(await hasTool("python3"))) return t.skip("python3 not installed");
  const { entities } = validateSchema(SHOP);
  const spec = buildSpec({ projectName: "Shop", analysis: { needsAuth: true, primaryEntities: entities }, options: { stack: "python-fastapi" } });
  const files = registry.generate(spec);
  assert.match(files["app/models/order.py"], /status/); assert.match(files["app/models/order.py"], /customer_id|customerId/);
  assert.match(files["app/schemas/order.py"], /customerId|customer_id/);
  assert.match(files["tests/test_order.py"] || Object.values(files).join("\n"), /customerId|customer_id/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sierra-schema-"));
  await writeFiles(dir, files);
  const res = await validateStack(registry.get("python-fastapi"), dir, { spec });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(res.status, "passed", res.steps.at(-1) && res.steps.at(-1).output);
});

test("go-nethttp: required numeric fields are pointers and an empty create is rejected (regression found by the e-commerce schema)", async (t) => {
  const { entities } = validateSchema(SHOP);
  const spec = buildSpec({ projectName: "Shop", analysis: { needsAuth: true, primaryEntities: entities }, options: { stack: "go-nethttp" } });
  const files = registry.generate(spec);
  assert.match(files["internal/order/order.go"], /Total\s+\*float64/);
  assert.match(files["internal/order/order.go"], /"msg": "is required"/);
  if (!(await hasTool("go"))) return t.skip("go toolchain not installed (the Go build/test of this regression runs in CI)");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sierra-go-schema-"));
  await writeFiles(dir, files);
  const res = await validateStack(registry.get("go-nethttp"), dir, { spec });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(res.status, "passed", res.steps.at(-1) && res.steps.at(-1).output.slice(-500));
});
