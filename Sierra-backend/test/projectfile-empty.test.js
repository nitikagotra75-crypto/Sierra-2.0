const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
require("../src/models");

test("ProjectFile accepts empty content (Python __init__.py); path stays required", () => {
  const PF = mongoose.models.ProjectFile;
  assert.ok(PF, "model is registered");
  assert.equal(new PF({ projectId: "p", path: "app/__init__.py", content: "" }).validateSync(), undefined);
  assert.ok(new PF({ projectId: "p", path: "", content: "a" }).validateSync(), "empty path is rejected");
});
