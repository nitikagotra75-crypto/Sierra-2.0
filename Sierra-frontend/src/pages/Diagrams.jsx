import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../services/api";
import { useAuth } from "../context/AuthContext";

export default function Diagrams() {
  const { user } = useAuth();
  const nav = useNavigate();
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const load = () => api.listDiagrams().then((d) => setItems(d.diagrams)).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  async function remove(d) {
    if (!window.confirm(`Delete "${d.name}" and all its versions?`)) return;
    try { await api.deleteDiagram(d.diagramId); await load(); } catch (e) { setError(e.message); }
  }

  return (
    <div className="tab-pad">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 14 }}>
        <div><div className="section-title" style={{ margin: 0 }}>My diagrams</div><div className="hint">Stored on the server for {user.email}; available from any device where you sign in.</div></div>
        <Link className="btn btn-primary" to="/design">New diagram</Link>
      </div>
      {error && <div className="error-box" role="alert">{error}</div>}
      {items === null && !error && <div className="dim">Loading…</div>}
      {items && items.length === 0 && <div className="empty-state">No saved diagrams yet. Design a system, then use “Save to account”.</div>}
      {items && items.map((d) => (
        <div key={d.diagramId} className="panel panel-pad row" style={{ justifyContent: "space-between", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
          <div><strong>{d.name}</strong><div className="hint mono">v{d.currentVersion} · updated {new Date(d.updatedAt).toLocaleString()}</div></div>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            <button className="btn btn-sm btn-primary" onClick={() => nav("/design", { state: { diagramId: d.diagramId } })}>Open</button>
            <button className="btn btn-sm" onClick={() => api.downloadDiagram(d.diagramId, "svg").catch((e) => setError(e.message))}>SVG</button>
            <button className="btn btn-sm" onClick={() => api.downloadDiagram(d.diagramId, "json").catch((e) => setError(e.message))}>JSON</button>
            <button className="btn btn-sm btn-danger" onClick={() => remove(d)}>Delete</button>
          </div>
        </div>
      ))}
    </div>
  );
}
