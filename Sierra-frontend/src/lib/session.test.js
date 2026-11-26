import test from "node:test";
import assert from "node:assert";
import { getToken, setToken, clearToken, _resetForTests } from "./session.js";

const fake = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };

test("token round-trips and clears", () => {
  _resetForTests(); const s = fake();
  assert.equal(getToken(s), null);
  setToken("abc", s); assert.equal(getToken(s), "abc");
  clearToken(s); assert.equal(getToken(s), null);
});
test("blocked storage still keeps the token in memory for this page view", () => {
  _resetForTests();
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  setToken("mem", broken); assert.equal(getToken(broken), "mem");
  clearToken(broken); assert.equal(getToken(broken), null);
});
