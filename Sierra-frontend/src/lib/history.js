// Undo/redo over immutable snapshots. Changes that arrive within `coalesceMs` of the previous one (e.g. the
// many updates a single drag produces) are merged into one undo step.
export function createHistory(initial, limit = 100) {
  return { past: [], present: initial, future: [], at: 0, limit };
}

export function record(h, next, now = Date.now(), coalesceMs = 400) {
  if (next === h.present) return h;
  const merge = h.past.length > 0 && now - h.at < coalesceMs;
  const past = merge ? h.past : [...h.past, h.present].slice(-h.limit);
  return { ...h, past, present: next, future: [], at: now };
}

// Replace the state without creating an undo step (loading a new design).
export function reset(h, state) {
  return { ...h, past: [], present: state, future: [], at: 0 };
}

export function undo(h) {
  if (!h.past.length) return h;
  const prev = h.past[h.past.length - 1];
  return { ...h, past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future], at: 0 };
}

export function redo(h) {
  if (!h.future.length) return h;
  const [next, ...rest] = h.future;
  return { ...h, past: [...h.past, h.present], present: next, future: rest, at: 0 };
}

export const canUndo = (h) => h.past.length > 0;
export const canRedo = (h) => h.future.length > 0;
