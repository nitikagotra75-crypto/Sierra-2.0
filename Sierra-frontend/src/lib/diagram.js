// Pure graph helpers for the architecture diagram. No React, no DOM, so they can be unit-tested.
export const NODE_W = 176;
export const NODE_H = 66;

const COLUMN = {
  client: 0, "load-balancer": 1, "api-gateway": 2, "app-server": 3, microservice: 3,
  cache: 4, database: 4, "message-broker": 4, "read-replica": 5, worker: 5, external: 5,
};

export const TYPE_META = {
  client: { tag: "CLI", color: "#8b949e" },
  "load-balancer": { tag: "LB", color: "#58a6ff" },
  "api-gateway": { tag: "GW", color: "#58a6ff" },
  "app-server": { tag: "APP", color: "#3fb950" },
  microservice: { tag: "SVC", color: "#3fb950" },
  cache: { tag: "RDS", color: "#f0883e" },
  database: { tag: "DB", color: "#d29922" },
  "read-replica": { tag: "RR", color: "#d29922" },
  "message-broker": { tag: "MQ", color: "#a371f7" },
  worker: { tag: "WRK", color: "#a371f7" },
  external: { tag: "EXT", color: "#8b949e" },
};

// What a user can add from the toolbar. `config` keys match what the backend infra generator reads.
export const PALETTE = [
  { key: "lb", type: "load-balancer", label: "Load balancer", node: { label: "Load balancer (Nginx)", config: { algorithm: "round_robin", healthCheck: "/health" } } },
  { key: "gateway", type: "api-gateway", label: "API gateway", node: { label: "API gateway", config: { authAtEdge: true, rateLimit: "100 req/min/client" } } },
  { key: "service", type: "microservice", label: "Microservice", node: { label: "Service", config: { instances: 2 } } },
  { key: "cache", type: "cache", label: "Redis cache", node: { label: "Redis cache", config: { pattern: "cache-aside", ttlSeconds: 3600, eviction: "allkeys-lru", invalidation: "delete key on write" } } },
  { key: "replica", type: "read-replica", label: "Read replica", node: { label: "Read replica ×1", config: { count: 1, replication: "asynchronous streaming" } } },
  { key: "kafka", type: "message-broker", label: "Kafka", node: { label: "Apache Kafka", config: { topics: ["domain-events"], partitions: 3, retention: "7d" } } },
  { key: "rabbit", type: "message-broker", label: "RabbitMQ", node: { label: "RabbitMQ", config: { queues: ["jobs", "jobs.retry", "jobs.dlq"], prefetch: 10 } } },
  { key: "worker", type: "worker", label: "Worker", node: { label: "Background workers", config: { concurrency: 4, idempotent: true } } },
  { key: "external", type: "external", label: "External service", node: { label: "External service", config: {} } },
];

export function layoutNodes(nodes) {
  // Empty columns are collapsed so a small design does not leave large gaps.
  const used = [...new Set(nodes.filter((n) => !(Number.isFinite(n.x) && Number.isFinite(n.y))).map((n) => COLUMN[n.type] ?? 4))].sort((a, b) => a - b);
  const rows = {};
  return nodes.map((n) => {
    if (Number.isFinite(n.x) && Number.isFinite(n.y)) return n;
    const col = used.indexOf(COLUMN[n.type] ?? 4);
    rows[col] = (rows[col] ?? -1) + 1;
    return { ...n, x: 30 + col * (NODE_W + 44), y: 30 + rows[col] * (NODE_H + 36) };
  });
}

export function fromDesign(design) {
  return { nodes: layoutNodes(design.nodes), edges: design.edges.map((e) => ({ ...e })) };
}

export function summarize(node) {
  const c = node.config || {};
  if (node.type === "app-server" || node.type === "microservice") return `${c.instances ?? 1} instance(s)${c.stateless ? " · stateless" : ""}`;
  if (node.type === "database") return `${c.engine ?? "db"} · pool ${c.poolSize ?? "?"}`;
  if (node.type === "cache") return `${c.pattern ?? "cache"} · TTL ${c.ttlSeconds ?? "?"}s`;
  if (node.type === "load-balancer") return `${c.algorithm ?? "round_robin"}`;
  if (node.type === "read-replica") return `${c.count ?? 1} replica(s) · ${c.replication ?? "async"}`;
  if (node.type === "message-broker") return c.partitions ? `${c.partitions} partitions · ${c.retention ?? ""}` : `${(c.queues || []).length} queues`;
  if (node.type === "worker") return `concurrency ${c.concurrency ?? "?"}`;
  return TYPE_META[node.type] ? "" : node.type;
}

function uniqueId(base, taken) {
  let id = base, i = 2;
  while (taken.has(id)) id = `${base}${i++}`;
  return id;
}

export function addNode(graph, paletteKey, pos) {
  const p = PALETTE.find((x) => x.key === paletteKey);
  if (!p) throw new Error(`unknown component '${paletteKey}'`);
  const id = uniqueId(p.key, new Set(graph.nodes.map((n) => n.id)));
  const node = { id, type: p.type, rationale: "Added manually in the diagram editor.", tradeoffs: [], ...structuredClone(p.node), x: Math.round(pos.x), y: Math.round(pos.y) };
  return { graph: { ...graph, nodes: [...graph.nodes, node] }, id };
}

export function removeNode(graph, id) {
  return { nodes: graph.nodes.filter((n) => n.id !== id), edges: graph.edges.filter((e) => e.from !== id && e.to !== id) };
}

export function removeEdge(graph, id) {
  return { ...graph, edges: graph.edges.filter((e) => e.id !== id) };
}

export function addEdge(graph, from, to) {
  if (from === to) throw new Error("A component cannot connect to itself");
  const ids = new Set(graph.nodes.map((n) => n.id));
  if (!ids.has(from) || !ids.has(to)) throw new Error("Both ends must exist");
  const id = `${from}->${to}`;
  if (graph.edges.some((e) => e.id === id)) throw new Error("Those components are already connected in that direction");
  return { ...graph, edges: [...graph.edges, { id, from, to, label: "connects", protocol: "tcp" }] };
}

export function updateNode(graph, id, patch) {
  return { ...graph, nodes: graph.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) };
}

export function updateEdge(graph, id, patch) {
  return { ...graph, edges: graph.edges.map((e) => (e.id === id ? { ...e, ...patch } : e)) };
}

function clip(cx, cy, tx, ty) {
  const dx = tx - cx, dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const k = Math.min((NODE_W / 2) / Math.abs(dx || 1e-9), (NODE_H / 2) / Math.abs(dy || 1e-9));
  return { x: cx + dx * k, y: cy + dy * k };
}

export function edgeGeometry(a, b) {
  const ac = { x: a.x + NODE_W / 2, y: a.y + NODE_H / 2 }, bc = { x: b.x + NODE_W / 2, y: b.y + NODE_H / 2 };
  const s = clip(ac.x, ac.y, bc.x, bc.y), t = clip(bc.x, bc.y, ac.x, ac.y);
  return { x1: s.x, y1: s.y, x2: t.x, y2: t.y, mx: (s.x + t.x) / 2, my: (s.y + t.y) / 2 };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Standalone SVG of the current graph (used for SVG and PNG export). */
export function toSvg(graph) {
  const byId = Object.fromEntries(graph.nodes.map((n) => [n.id, n]));
  const pad = 40;
  const minX = Math.min(...graph.nodes.map((n) => n.x), 0) - pad, minY = Math.min(...graph.nodes.map((n) => n.y), 0) - pad;
  const maxX = Math.max(...graph.nodes.map((n) => n.x + NODE_W), 0) + pad, maxY = Math.max(...graph.nodes.map((n) => n.y + NODE_H), 0) + pad;
  const w = maxX - minX, h = maxY - minY;
  const edges = graph.edges.filter((e) => byId[e.from] && byId[e.to]).map((e) => {
    const g = edgeGeometry(byId[e.from], byId[e.to]);
    return `<line x1="${g.x1}" y1="${g.y1}" x2="${g.x2}" y2="${g.y2}" stroke="#6e7681" stroke-width="1.5" marker-end="url(#arrow)"/><text x="${g.mx}" y="${g.my - 6}" fill="#8b949e" font-size="11" text-anchor="middle" font-family="monospace">${esc(e.label || "")}</text>`;
  }).join("");
  const nodes = graph.nodes.map((n) => {
    const m = TYPE_META[n.type] || TYPE_META.external;
    return `<g><rect x="${n.x}" y="${n.y}" width="${NODE_W}" height="${NODE_H}" rx="4" fill="#161b22" stroke="${m.color}" stroke-width="1.5"/><text x="${n.x + 12}" y="${n.y + 26}" fill="#e6edf3" font-size="13" font-weight="600" font-family="sans-serif">${esc(n.label)}</text><text x="${n.x + 12}" y="${n.y + 46}" fill="#8b949e" font-size="11" font-family="monospace">${esc(summarize(n))}</text><text x="${n.x + NODE_W - 10}" y="${n.y + 16}" fill="${m.color}" font-size="10" text-anchor="end" font-family="monospace">${m.tag}</text></g>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${minX} ${minY} ${w} ${h}"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="#6e7681"/></marker></defs><rect x="${minX}" y="${minY}" width="${w}" height="${h}" fill="#0d1117"/>${edges}${nodes}</svg>`;
}

/** Payload for POST /api/design/infra: strips editor-only fields. */
export function toDesignPayload(design, graph) {
  return {
    ...design,
    nodes: graph.nodes.map((n) => { const c = { ...n }; delete c.x; delete c.y; return c; }),
    edges: graph.edges,
  };
}
