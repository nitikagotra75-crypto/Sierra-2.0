import test from "node:test";
import assert from "node:assert";
import { syncMessage } from "./sync.js";

test("maps API errors to sync states", () => {
  assert.equal(syncMessage({ status: 409 }).state, "conflict");
  assert.equal(syncMessage({ status: 401 }).state, "auth");
  assert.equal(syncMessage({ status: 404 }).state, "error");
  assert.equal(syncMessage(new TypeError("fetch failed")).state, "offline");
  assert.equal(syncMessage(new Error("boom")).text, "boom");
});
