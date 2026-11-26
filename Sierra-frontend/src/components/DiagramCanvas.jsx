import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { NODE_W, NODE_H, TYPE_META, summarize, edgeGeometry, addEdge } from "../lib/diagram";

const MIN_K = 0.25, MAX_K = 2.5;

function fitView(nodes, w, h) {
  if (!nodes.length || !w || !h) return { x: 0, y: 0, k: 1 };
  const minX = Math.min(...nodes.map((n) => n.x)) - 40, minY = Math.min(...nodes.map((n) => n.y)) - 40;
  const maxX = Math.max(...nodes.map((n) => n.x + NODE_W)) + 40, maxY = Math.max(...nodes.map((n) => n.y + NODE_H)) + 40;
  const k = Math.max(MIN_K, Math.min(1.2, Math.min(w / (maxX - minX), h / (maxY - minY))));
  return { k, x: (w - (maxX - minX) * k) / 2 - minX * k, y: (h - (maxY - minY) * k) / 2 - minY * k };
}

/**
 * Interactive SVG diagram. State of truth is `graph` (owned by the parent); this component only
 * renders it and reports edits through onChange. Pan: drag background. Zoom: wheel / buttons.
 * Move: drag a component. Connect: toggle "Connect", click source then target.
 */
export default function DiagramCanvas({ graph, onChange, selected, onSelect, mode, onError, fitKey, svgRef }) {
  const wrapRef = useRef(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  // The pending connect source is remembered together with the mode it was picked in, so leaving
  // connect mode discards it without needing an effect to reset state.
  const [link, setLink] = useState({ mode: null, id: null });
  const linkFrom = link.mode === mode ? link.id : null;
  const setLinkFrom = (id) => setLink({ mode, id });
  const drag = useRef(null);
  const graphRef = useRef(graph);
  const viewRef = useRef(view);
  useLayoutEffect(() => { graphRef.current = graph; viewRef.current = view; });

  const fit = useCallback(() => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (r) setView(fitView(graphRef.current.nodes, r.width, r.height));
  }, []);
  useEffect(() => { fit(); }, [fitKey, fit]);

  // Wheel zoom must be a non-passive native listener so preventDefault works.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      setView((v) => {
        const k = Math.max(MIN_K, Math.min(MAX_K, v.k * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
        return { k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const zoomBy = (f) => {
    const r = wrapRef.current.getBoundingClientRect();
    const px = r.width / 2, py = r.height / 2;
    setView((v) => { const k = Math.max(MIN_K, Math.min(MAX_K, v.k * f)); return { k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k }; });
  };

  function onNodeDown(e, n) {
    e.stopPropagation();
    if (mode === "connect") {
      if (!linkFrom) { setLinkFrom(n.id); onSelect({ kind: "node", id: n.id }); return; }
      try { onChange(addEdge(graphRef.current, linkFrom, n.id)); } catch (err) { onError(err.message); }
      setLinkFrom(null);
      return;
    }
    onSelect({ kind: "node", id: n.id });
    drag.current = { type: "node", id: n.id, sx: e.clientX, sy: e.clientY, ox: n.x, oy: n.y };
    wrapRef.current.setPointerCapture?.(e.pointerId);
  }

  function onBgDown(e) {
    onSelect(null);
    setLinkFrom(null);
    wrapRef.current.focus();
    drag.current = { type: "pan", sx: e.clientX, sy: e.clientY, ox: viewRef.current.x, oy: viewRef.current.y };
    wrapRef.current.setPointerCapture?.(e.pointerId);
  }

  function onMove(e) {
    const d = drag.current;
    if (!d) return;
    if (d.type === "pan") setView((v) => ({ ...v, x: d.ox + e.clientX - d.sx, y: d.oy + e.clientY - d.sy }));
    else {
      const k = viewRef.current.k;
      const x = Math.round(d.ox + (e.clientX - d.sx) / k), y = Math.round(d.oy + (e.clientY - d.sy) / k);
      onChange({ ...graphRef.current, nodes: graphRef.current.nodes.map((n) => (n.id === d.id ? { ...n, x, y } : n)) });
    }
  }
  const onUp = () => { drag.current = null; };

  const byId = Object.fromEntries(graph.nodes.map((n) => [n.id, n]));

  return (
    <div ref={wrapRef} className="canvas-wrap" tabIndex={0} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} data-testid="canvas">
      <svg ref={svgRef} className="canvas-svg" onPointerDown={onBgDown} role="img" aria-label="Architecture diagram">
        <defs>
          <marker id="arrow-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="#55606d" /></marker>
        </defs>
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {graph.edges.filter((e) => byId[e.from] && byId[e.to]).map((e) => {
            const g = edgeGeometry(byId[e.from], byId[e.to]);
            const sel = selected?.kind === "edge" && selected.id === e.id;
            return (
              <g key={e.id} className={sel ? "edge-sel" : ""} data-edge={e.id} onPointerDown={(ev) => { ev.stopPropagation(); onSelect({ kind: "edge", id: e.id }); wrapRef.current.focus(); }} style={{ cursor: "pointer" }}>
                <line x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} stroke="transparent" strokeWidth="14" />
                <line className="edge-line" x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} markerEnd="url(#arrow-head)" />
                <text className="edge-label" x={g.mx} y={g.my - 6}>{e.label}</text>
              </g>
            );
          })}
          {graph.nodes.map((n) => {
            const m = TYPE_META[n.type] || TYPE_META.external;
            const sel = selected?.kind === "node" && selected.id === n.id;
            return (
              <g key={n.id} className={sel || linkFrom === n.id ? "node-sel" : ""} data-node={n.id} transform={`translate(${n.x} ${n.y})`} onPointerDown={(e) => onNodeDown(e, n)} style={{ cursor: mode === "connect" ? "crosshair" : "grab" }}>
                <rect className="node-rect" width={NODE_W} height={NODE_H} rx="4" stroke={linkFrom === n.id ? "#4493f8" : m.color} />
                <text className="node-title" x="12" y="26">{n.label.length > 21 ? n.label.slice(0, 20) + "…" : n.label}</text>
                <text className="node-sub" x="12" y="47">{summarize(n)}</text>
                <text className="node-tag" x={NODE_W - 10} y="16" textAnchor="end" fill={m.color}>{m.tag}</text>
              </g>
            );
          })}
        </g>
      </svg>
      <div className="canvas-hud">
        <button className="btn btn-sm" onClick={() => zoomBy(1.2)} aria-label="Zoom in">+</button>
        <button className="btn btn-sm" onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out">−</button>
        <button className="btn btn-sm" onClick={fit}>Fit</button>
      </div>
      <div className="canvas-hint">
        {mode === "connect" ? (linkFrom ? "Click the target component" : "Click the source component") : "Drag to move · scroll to zoom · Del to remove"} · {Math.round(view.k * 100)}%
      </div>
    </div>
  );
}
