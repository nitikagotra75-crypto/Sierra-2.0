const test = require("node:test");
const assert = require("node:assert/strict");
const { schemaFromRequirement } = require("../src/engine/requirementSchema");
const { designSchema } = require("../src/engine/schemaAgent");
const { generateProject } = require("../src/agents/codeGeneratorAgent");

const shape = (r) => schemaFromRequirement(r).entities.map((e) => `${e.name}(${e.fields.map((f) => `${f.name}:${f.type}${f.required ? "*" : ""}`).join(",")})`);

test("fields and entities are read from the requirement text", () => {
  assert.deepEqual(shape("Library API: books (title, author, isbn), members, loans. Members can register and log in."), [
    "Book(title:string*,author:string,isbn:string)", "Member(name:string*,description:text)", "Loan(name:string*,description:text)"]);
  assert.deepEqual(shape("Shop API: products (name, price, stock), orders, customers login ke saath."), [
    "Product(name:string*,price:float,stock:int)", "Order(name:string*,description:text)"]);
  assert.deepEqual(shape("Task manager API: tasks (title, description, status, due_date), users login ke saath."), [
    "Task(title:string*,description:text,status:string,dueDate:date)"]);
  assert.deepEqual(shape("Blog API: posts (title, content, published), comments, author login."), [
    "Post(title:string*,content:text,published:bool)", "Comment(name:string*,description:text)"]);
});

test("explicit types and is_ prefixes are honoured; isbn is not a boolean", () => {
  assert.deepEqual(shape("API: items (sku, qty int, price: float, is_active)"), ["Item(sku:string*,qty:int,price:float,isActive:bool)"]);
  assert.match(shape("API: books (isbn)")[0], /isbn:string/);
});

test("nothing is invented for text without entities", () => {
  assert.deepEqual(schemaFromRequirement("Make me something cool").entities, []);
  assert.deepEqual(schemaFromRequirement("").entities, []);
});

test("designSchema without an LLM reads the requirement and reports generic fields", async () => {
  const s = await designSchema("Library API: books (title, author), members", { ask: undefined });
  if (require("../src/agents/llm").hasLLM) return;
  assert.equal(s.source, "requirement");
  assert.ok(s.issues.some((i) => /Member: no fields/.test(i)));
});

test("Express codegen uses the real fields in model, validators and tests", async () => {
  const sc = schemaFromRequirement("Shop API: products (name, price, stock)");
  const files = generateProject({ projectName: "shop", analysis: { needsAuth: true, primaryEntities: ["Product"], entityDefs: sc.entities, endpoints: [] } });
  assert.match(files["src/models/Product.js"], /price: \{ type: Number/);
  assert.match(files["src/models/Product.js"], /stock: \{ type: Number, validate/);
  assert.match(files["src/validators/productValidators.js"], /body\("price"\)\.optional\(\)\.isFloat\(\)/);
  assert.match(files["tests/product.test.js"], /rejects a product without the required name/);
  assert.match(files["tests/product.test.js"], /"price":9\.5/);
  for (const f of Object.values(files)) new Function(f.startsWith("#!") ? "" : "return 1"); // all strings
});
