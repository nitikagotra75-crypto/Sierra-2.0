/** Renders a saved diagram graph to a standalone SVG (server-side, no browser). All text is XML-escaped. */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
const W = 176, H = 64;
const trunc = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));

function renderSvg(graph, { title = "Architecture" } = {}) {
  const nodes = graph.nodes || [];
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
  const minX = Math.min(0, ...xs) - 40, minY = Math.min(0, ...ys) - 40;
  const maxX = Math.max(0, ...xs) + W + 40, maxY = Math.max(0, ...ys) + H + 40;
  const edges = (graph.edges || []).filter((e) => byId[e.from] && byId[e.to]).map((e) => {
    const a = byId[e.from], b = byId[e.to];
    const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2;
    const mx = (x1 + x2) / 2;
    return `<path d="M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}" fill="none" stroke="#6b7280" stroke-width="1.5" marker-end="url(#arrow)"/>`;
  }).join("");
  const boxes = nodes.map((n) => `<g><rect x="${n.x}" y="${n.y}" width="${W}" height="${H}" rx="8" fill="#1f2937" stroke="#374151"/>` +
    `<text x="${n.x + 12}" y="${n.y + 26}" fill="#e5e7eb" font-family="sans-serif" font-size="13" font-weight="600">${esc(trunc(n.label || n.type, 21))}</text>` +
    `<text x="${n.x + 12}" y="${n.y + 46}" fill="#9ca3af" font-family="monospace" font-size="11">${esc(trunc(n.type, 24))}</text></g>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${maxX - minX} ${maxY - minY}" width="${maxX - minX}" height="${maxY - minY}">` +
    `<title>${esc(title)}</title><rect x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" fill="#0b0f14"/>` +
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="#6b7280"/></marker></defs>${edges}${boxes}</svg>`;
}

module.exports = { renderSvg };
