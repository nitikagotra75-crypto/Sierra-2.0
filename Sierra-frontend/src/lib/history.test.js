import test from "node:test";
import assert from "node:assert/strict";
import { createHistory, record, reset, undo, redo, canUndo, canRedo } from "./history.js";

test("record, undo and redo walk the snapshots", () => {
  let h = createHistory("a");
  h = record(h, "b", 1000);
  h = record(h, "c", 2000);
  assert.equal(h.present, "c");
  h = undo(h); assert.equal(h.present, "b");
  h = undo(h); assert.equal(h.present, "a");
  assert.equal(canUndo(h), false);
  assert.equal(undo(h), h);
  h = redo(h); assert.equal(h.present, "b");
  h = redo(h); assert.equal(h.present, "c");
  assert.equal(canRedo(h), false);
});

test("a new change after undo clears the redo stack", () => {
  let h = createHistory("a");
  h = record(h, "b", 1000);
  h = undo(h);
  h = record(h, "x", 5000);
  assert.equal(canRedo(h), false);
  assert.equal(h.present, "x");
});

test("rapid changes (a drag) coalesce into one undo step", () => {
  let h = createHistory("a");
  h = record(h, "b", 1000);          // first change of the drag
  h = record(h, "b1", 1100);
  h = record(h, "b2", 1200);
  assert.equal(h.past.length, 1);
  h = undo(h);
  assert.equal(h.present, "a");
});

test("reset loads a state without an undo step; history is bounded; same value is ignored", () => {
  let h = createHistory("a", 3);
  for (let i = 1; i <= 10; i++) h = record(h, "s" + i, i * 1000);
  assert.equal(h.past.length, 3);
  assert.equal(record(h, h.present, 99999), h);
  h = reset(h, "fresh");
  assert.equal(h.present, "fresh");
  assert.equal(canUndo(h), false);
});
