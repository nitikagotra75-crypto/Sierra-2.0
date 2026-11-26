import { useState } from "react";
import { TYPE_META, removeNode, removeEdge, updateNode, updateEdge } from "../lib/diagram";

function ConfigField({ k, value, onCommit }) {
  const [text, setText] = useState(typeof value === "object" ? JSON.stringify(value) : String(value));
  const [bad, setBad] = useState(false);
  if (typeof value === "boolean") return <input type="checkbox" checked={value} onChange={(e) => onCommit(e.target.checked)} />;
  if (typeof value === "number") return <input className="input input--mono" type="number" value={Number.isFinite(value) ? value : ""} onChange={(e) => onCommit(e.target.value === "" ? 0 : Number(e.target.value))} />;
  if (typeof value === "object") {
    return <input className={`input input--mono${bad ? " input--bad" : ""}`} value={text} aria-label={k} onChange={(e) => { setText(e.target.value); try { onCommit(JSON.parse(e.target.value)); setBad(false); } catch { setBad(true); } }} />;
  }
  return <input className="input input--mono" value={value} onChange={(e) => onCommit(e.target.value)} />;
}

export default function Inspector({ graph, selected, onChange, onSelect }) {
  if (!selected) {
    return <div className="dim">Select a component or connection to edit it. Changes are applied to the diagram immediately and are what infrastructure generation uses.</div>;
  }

  if (selected.kind === "edge") {
    const e = graph.edges.find((x) => x.id === selected.id);
    if (!e) return null;
    return (
      <div className="form" style={{ gap: 12 }}>
        <div className="section-title">Connection</div>
        <div className="mono">{e.from} → {e.to}</div>
        <div><label className="field-label">Label</label><input className="input" value={e.label || ""} onChange={(ev) => onChange(updateEdge(graph, e.id, { label: ev.target.value }))} /></div>
        <div><label className="field-label">Protocol</label><input className="input input--mono" value={e.protocol || ""} onChange={(ev) => onChange(updateEdge(graph, e.id, { protocol: ev.target.value }))} /></div>
        <button className="btn btn-danger" onClick={() => { onChange(removeEdge(graph, e.id)); onSelect(null); }}>Remove connection</button>
      </div>
    );
  }

  const n = graph.nodes.find((x) => x.id === selected.id);
  if (!n) return null;
  const m = TYPE_META[n.type] || TYPE_META.external;
  const setConfig = (k, v) => onChange(updateNode(graph, n.id, { config: { ...n.config, [k]: v } }));
  return (
    <div className="form" style={{ gap: 12 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="section-title" style={{ margin: 0 }}>Component</div>
        <span className="tag" style={{ color: m.color }}>{n.type}</span>
      </div>
      <div><label className="field-label">Label</label><input className="input" value={n.label} onChange={(e) => onChange(updateNode(graph, n.id, { label: e.target.value }))} /></div>
      <div>
        <div className="section-title">Configuration</div>
        {Object.keys(n.config || {}).length === 0 && <div className="dim">No settings for this component.</div>}
        {Object.entries(n.config || {}).map(([k, v]) => (
          <div className="kv" key={`${n.id}:${k}`}><label title={k}>{k}</label><ConfigField k={k} value={v} onCommit={(nv) => setConfig(k, nv)} /></div>
        ))}
      </div>
      {n.rationale && <div><div className="section-title">Why it is here</div><div>{n.rationale}</div></div>}
      {n.tradeoffs?.length > 0 && <div><div className="section-title">Trade-offs</div><ul className="plain">{n.tradeoffs.map((t, i) => <li key={i}>{t}</li>)}</ul></div>}
      <button className="btn btn-danger" onClick={() => { onChange(removeNode(graph, n.id)); onSelect(null); }}>Remove component</button>
    </div>
  );
}
