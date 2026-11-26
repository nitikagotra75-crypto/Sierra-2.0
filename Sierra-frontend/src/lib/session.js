// Auth token storage. localStorage can be missing/blocked, so every access is guarded and an in-memory copy is kept.
const KEY = "sierra.session.v1";
let memory = null;

export function getToken(storage = globalThis.localStorage) {
  if (memory) return memory;
  try { const t = storage && storage.getItem(KEY); if (t) memory = t; return t || null; } catch { return null; }
}
export function setToken(token, storage = globalThis.localStorage) {
  memory = token;
  try { storage && storage.setItem(KEY, token); } catch { /* memory only */ }
}
export function clearToken(storage = globalThis.localStorage) {
  memory = null;
  try { storage && storage.removeItem(KEY); } catch { /* ignore */ }
}
export function _resetForTests() { memory = null; }
