// Persist edited diagrams in the browser (localStorage), keyed by the exact requirements that produced them.
// Everything is wrapped in try/catch: storage can be missing, full or blocked.
const PREFIX = "sierra.diagram.v1:";

export const keyFor = (requirements) => PREFIX + JSON.stringify(requirements);

export function isGraph(g) {
  return !!g && Array.isArray(g.nodes) && Array.isArray(g.edges)
    && g.nodes.every((n) => n && typeof n.id === "string" && typeof n.type === "string" && Number.isFinite(n.x) && Number.isFinite(n.y))
    && g.edges.every((e) => e && typeof e.id === "string" && typeof e.from === "string" && typeof e.to === "string");
}

export function loadSaved(key, storage = globalThis.localStorage) {
  try {
    const raw = storage && storage.getItem(key);
    if (!raw) return null;
    const g = JSON.parse(raw);
    return isGraph(g) ? g : null;
  } catch { return null; }
}

export function saveGraph(key, graph, storage = globalThis.localStorage) {
  try { storage && storage.setItem(key, JSON.stringify(graph)); return true; } catch { return false; }
}

export function clearSaved(key, storage = globalThis.localStorage) {
  try { storage && storage.removeItem(key); } catch { /* ignore */ }
}
