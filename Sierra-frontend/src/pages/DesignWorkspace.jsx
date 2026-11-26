import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { keyFor, loadSaved, saveGraph, clearSaved } from "../lib/savedDiagram";
import { createHistory, record, reset, undo, redo, canUndo, canRedo } from "../lib/history";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { syncMessage } from "../lib/sync";
import { api } from "../services/api";
import { PALETTE, fromDesign, addNode, removeNode, removeEdge, toSvg, toDesignPayload } from "../lib/diagram";
import DiagramCanvas from "../components/DiagramCanvas";
import Inspector from "../components/Inspector";
import DesignSummary from "../components/DesignSummary";
import CodeViewer from "../components/CodeViewer";

const FALLBACK_STACKS = [["python-fastapi", "Python + FastAPI"], ["node-express", "Node.js + Express"], ["go-nethttp", "Go + net/http"]];

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function DesignWorkspace() {
  const { state } = useLocation();
  const [description, setDescription] = useState(state?.description || "");
  const [rps, setRps] = useState("");
  const [consistency, setConsistency] = useState("");
  const [database, setDatabase] = useState("");
  const [design, setDesign] = useState(state?.design || null);
  const [hist, setHist] = useState(() => createHistory(state?.design ? fromDesign(state.design) : null));
  const graph = hist.present;
  const setGraph = (g) => setHist((h) => record(h, typeof g === "function" ? g(h.present) : g));
  const loadGraph = (g) => setHist((h) => reset(h, g));
  const [baseline, setBaseline] = useState(state?.design ? JSON.stringify(fromDesign(state.design)) : null);
  const [fitKey, setFitKey] = useState(0);
  const [selected, setSelected] = useState(null);
  const [mode, setMode] = useState("select");
  const [paletteKey, setPaletteKey] = useState(PALETTE[0].key);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const [tab, setTab] = useState("why");
  const [stack, setStack] = useState("python-fastapi");
  const [stackList, setStackList] = useState(FALLBACK_STACKS);
  useEffect(() => { api.listStacks().then((d) => { const ok = d.stacks.filter((x) => x.status === "implemented").map((x) => [x.id, x.label]); if (ok.length) setStackList(ok); }).catch(() => {}); }, []);
  const [infra, setInfra] = useState(null);
  const [infraFile, setInfraFile] = useState(null);
  const [restored, setRestored] = useState(false);
  const svgRef = useRef(null);
  const { user } = useAuth();
  const nav = useNavigate();
  // Server copy of this diagram: id, name, version and the JSON that was last synced (to know when there are unsynced edits).
  const [remote, setRemote] = useState(null);
  const [name, setName] = useState("");
  const [sync, setSync] = useState({ state: "idle", text: "" });
  const [versions, setVersions] = useState(null);
  const unsynced = !!graph && (!remote || remote.json !== JSON.stringify(graph));

  const dirty = graph && baseline !== JSON.stringify(graph);
  const requirements = useMemo(() => ({
    description,
    options: { ...(rps ? { expectedRps: Number(rps) } : {}), ...(consistency ? { consistency } : {}), ...(database ? { database } : {}) },
  }), [description, rps, consistency, database]);

  useEffect(() => {
    function onKey(e) {
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) { e.preventDefault(); setHist(undo); }
      else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); setHist(redo); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const storageKey = keyFor(requirements);

  // Autosave edits for these exact requirements; an unedited graph is not stored.
  useEffect(() => {
    if (!graph || !design) return undefined;
    const id = setTimeout(() => { if (dirty) saveGraph(storageKey, graph); else clearSaved(storageKey); }, 500);
    return () => clearTimeout(id);
  }, [graph, design, dirty, storageKey]);

  // fresh=true (the user chose "discard my edits") ignores and clears any saved diagram.
  async function runDesign(fresh = false) {
    setBusy(true); setError(null); setConfirmRegen(false);
    try {
      const d = await api.design(requirements);
      let g = fromDesign(d);
      const base = JSON.stringify(g);
      const saved = fresh ? null : loadSaved(storageKey);
      if (fresh) clearSaved(storageKey);
      setRestored(!!saved);
      if (saved) g = saved;
      setDesign(d); loadGraph(g); setBaseline(base); setSelected(null); setInfra(null); setFitKey((k) => k + 1); setTab("why");
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  function regenerate() {
    if (dirty && !confirmRegen) { setConfirmRegen(true); return; }
    runDesign(!!design);
  }

  function openRemote(id) {
    setBusy(true); setError(null); setSync({ state: "saving", text: "Loading from server…" });
    return fetchRemote(id);
  }

  async function fetchRemote(id) {
    try {
      const d = await api.getDiagram(id);
      const req = d.requirements || {};
      setDescription(req.description || ""); setRps(req.options?.expectedRps ? String(req.options.expectedRps) : ""); setConsistency(req.options?.consistency || ""); setDatabase(req.options?.database || "");
      if (req.description) setDesign(await api.design(req));
      loadGraph(d.graph); setBaseline(JSON.stringify(d.graph)); setSelected(null); setInfra(null); setFitKey((k) => k + 1);
      setRemote({ id: d.diagramId, version: d.currentVersion, json: JSON.stringify(d.graph) }); setName(d.name); setVersions(null);
      setSync({ state: "saved", text: `Loaded v${d.currentVersion} from your account` });
    } catch (e) { setSync(syncMessage(e)); setError(e.message); }
    setBusy(false);
  }

  async function saveRemote({ overwrite = false } = {}) {
    if (!user) { nav("/login", { state: { from: "/design" } }); return; }
    setSync({ state: "saving", text: "Saving…" });
    try {
      const json = JSON.stringify(graph);
      let res;
      if (!remote) {
        if (!name.trim()) { setSync({ state: "error", text: "Give the diagram a name first." }); return; }
        res = await api.createDiagram({ name: name.trim(), graph, requirements });
      } else {
        const baseVersion = overwrite ? (await api.getDiagram(remote.id)).currentVersion : remote.version;
        res = await api.saveDiagram(remote.id, { graph, requirements, baseVersion, note: overwrite ? "overwrote newer version" : "" });
      }
      setRemote({ id: res.diagramId, version: res.currentVersion, json }); setVersions(null);
      setSync({ state: "saved", text: `Saved as v${res.currentVersion} · ${new Date().toLocaleTimeString()}` });
    } catch (e) { setSync(syncMessage(e)); }
  }

  async function showVersions() {
    try { setVersions((await api.diagramVersions(remote.id)).versions); } catch (e) { setSync(syncMessage(e)); }
  }
  async function restoreVersion(n) {
    try {
      const r = await api.restoreDiagram(remote.id, n);
      loadGraph(r.graph); setRemote({ id: r.diagramId, version: r.currentVersion, json: JSON.stringify(r.graph) }); setFitKey((k) => k + 1); setVersions(null);
      setSync({ state: "saved", text: `Restored v${n} as v${r.currentVersion}` });
    } catch (e) { setSync(syncMessage(e)); }
  }

  const openFromRoute = useEffectEvent((id) => fetchRemote(id));
  const routeDiagramId = state?.diagramId;
  useEffect(() => { if (routeDiagramId) openFromRoute(routeDiagramId); }, [routeDiagramId]);

  function addComponent() {
    try {
      const { graph: g, id } = addNode(graph, paletteKey, { x: 80 + Math.random() * 40, y: 380 + Math.random() * 40 });
      setGraph(g); setSelected({ kind: "node", id });
    } catch (e) { setError(e.message); }
  }

  function deleteSelected() {
    if (!selected) return;
    setGraph(selected.kind === "node" ? removeNode(graph, selected.id) : removeEdge(graph, selected.id));
    setSelected(null);
  }

  useEffect(() => {
    const onKey = (e) => {
      if ((e.key === "Delete" || e.key === "Backspace") && document.activeElement?.dataset?.testid === "canvas") { e.preventDefault(); deleteSelected(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function generateInfra() {
    setBusy(true); setError(null);
    try {
      const { files } = await api.designInfra({ design: toDesignPayload(design, graph), stack, name: "System" });
      setInfra(files); setInfraFile(Object.keys(files)[0]); setTab("infra");
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  function exportPng() {
    const svg = toSvg(graph);
    const m = svg.match(/viewBox="([-\d.]+) ([-\d.]+) ([\d.]+) ([\d.]+)"/);
    const w = Number(m[3]), h = Number(m[4]);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = w * 2; c.height = h * 2;
      const ctx = c.getContext("2d");
      ctx.scale(2, 2); ctx.drawImage(img, 0, 0, w, h);
      c.toBlob((b) => { const url = URL.createObjectURL(b); const a = document.createElement("a"); a.href = url; a.download = "architecture.png"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
    };
    img.onerror = () => setError("PNG export failed in this browser; use SVG export.");
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }

  const canAnalyze = description.trim().length >= 10;

  return (
    <div className="ws">
      <div className="ws-left">
        <div className="section-title">Requirements</div>
        <div className="form" style={{ gap: 12 }}>
          <div>
            <label className="field-label">Describe the system</label>
            <textarea className="textarea" rows={7} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Build a scalable URL shortener capable of handling millions of requests." />
          </div>
          <div className="grid-2">
            <div><label className="field-label">Traffic (req/s)</label><input className="input input--mono" type="number" min="1" value={rps} onChange={(e) => setRps(e.target.value)} placeholder="auto" /></div>
            <div><label className="field-label">Consistency</label><select className="select" value={consistency} onChange={(e) => setConsistency(e.target.value)}><option value="">auto</option><option value="strong">strong</option><option value="eventual">eventual</option></select></div>
          </div>
          <div><label className="field-label">Database</label><select className="select" value={database} onChange={(e) => setDatabase(e.target.value)}><option value="">auto (recommend)</option><option value="postgresql">PostgreSQL</option><option value="mongodb">MongoDB</option><option value="mysql">MySQL</option></select></div>
          {error && <div className="error-box">{error}</div>}
          <button className="btn btn-primary" disabled={busy || !canAnalyze} onClick={regenerate}>{busy ? "Working…" : design ? (confirmRegen ? "Discard my edits and regenerate" : "Regenerate architecture") : "Design architecture"}</button>
          {confirmRegen && <button className="btn" onClick={() => setConfirmRegen(false)}>Keep my edits</button>}
          <div className="hint">The design is rule-based and deterministic: the same requirements give the same architecture. Optional components appear only when the requirements justify them.</div>
        </div>
      </div>

      <div className="ws-center">
        {graph ? (
          <>
            <div className="toolbar">
              <button className={`btn btn-sm${mode === "connect" ? " is-active" : ""}`} onClick={() => setMode(mode === "connect" ? "select" : "connect")}>Connect</button>
              <span className="sep" />
              <select className="select" style={{ width: 150, padding: "3px 6px" }} value={paletteKey} onChange={(e) => setPaletteKey(e.target.value)} aria-label="Component to add">
                {PALETTE.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
              <button className="btn btn-sm" onClick={addComponent}>Add</button>
              <button className="btn btn-sm btn-danger" disabled={!selected} onClick={deleteSelected}>Delete</button>
              <span className="sep" />
              <button className="btn btn-sm" disabled={!canUndo(hist)} onClick={() => setHist(undo)} title="Undo (Ctrl+Z)">Undo</button>
              <button className="btn btn-sm" disabled={!canRedo(hist)} onClick={() => setHist(redo)} title="Redo (Ctrl+Shift+Z)">Redo</button>
              <span className="sep" />
              <button className="btn btn-sm" onClick={() => download("architecture.svg", toSvg(graph), "image/svg+xml")}>Export SVG</button>
              <button className="btn btn-sm" onClick={exportPng}>Export PNG</button>
              <button className="btn btn-sm" onClick={() => download("architecture.json", JSON.stringify(toDesignPayload(design, graph), null, 2), "application/json")}>Export JSON</button>
              <span className="sep" />
              {!remote && <input className="input" style={{ width: 150, padding: "3px 6px" }} placeholder="Diagram name" aria-label="Diagram name" value={name} onChange={(e) => setName(e.target.value)} />}
              <button className="btn btn-sm btn-primary" onClick={() => saveRemote()} disabled={sync.state === "saving" || (!!remote && !unsynced)} title={user ? "Save to your account" : "Sign in to save to your account"}>{user ? (remote ? "Save new version" : "Save to account") : "Sign in to save"}</button>
              {remote && <button className="btn btn-sm" onClick={showVersions}>Versions</button>}
              {remote && <button className="btn btn-sm" onClick={() => api.downloadDiagram(remote.id, "svg").catch((e) => setError(e.message))} title="SVG rendered by the server from the saved version">Server SVG</button>}
              {sync.state !== "idle" && <span className={`tag ${sync.state === "saved" ? "" : "tag--planned"}`} role="status">{sync.text}</span>}
              {sync.state === "conflict" && <><button className="btn btn-sm" onClick={() => openRemote(remote.id)}>Reload server version</button><button className="btn btn-sm btn-danger" onClick={() => saveRemote({ overwrite: true })}>Overwrite with mine</button></>}
              {dirty && <span className="tag tag--planned" style={{ marginLeft: "auto" }} title={restored ? "Restored from your saved edits" : "Edits are saved in this browser"}>{restored ? "edited · restored" : "edited · saved"}</span>}
            </div>
            {versions && (
              <div className="panel panel-pad" style={{ margin: "8px 12px" }}>
                <div className="row" style={{ justifyContent: "space-between" }}><div className="section-title" style={{ margin: 0 }}>Saved versions</div><button className="btn btn-sm" onClick={() => setVersions(null)}>Close</button></div>
                {versions.map((v) => <div key={v.version} className="row" style={{ justifyContent: "space-between", padding: "4px 0" }}><span className="mono">v{v.version}{v.version === remote.version ? " (current)" : ""} · {v.nodes} nodes · {v.note || "edited"} · {new Date(v.createdAt).toLocaleString()}</span>{v.version !== remote.version && <button className="btn btn-sm" onClick={() => restoreVersion(v.version)}>Restore</button>}</div>)}
              </div>
            )}
            <DiagramCanvas graph={graph} onChange={setGraph} selected={selected} onSelect={setSelected} mode={mode} onError={setError} fitKey={fitKey} svgRef={svgRef} />
            <div className="bottom-panel">
              <div className="tabs" style={{ padding: "0 12px" }}>
                {[["why", "Decisions"], ["flow", "Request flow"], ["risk", "Risks & scaling"], ["infra", "Infrastructure"]].map(([k, l]) => <button key={k} className={`tab${tab === k ? " active" : ""}`} onClick={() => setTab(k)}>{l}</button>)}
              </div>
              <div className="bottom-body">
                {tab === "why" && <DesignSummary design={{ ...design, nodes: graph.nodes }} />}
                {tab === "flow" && (
                  <>
                    <ol className="flow">{(design.requestFlow || []).map((s, i) => <li key={i}>{s.replace(/^\d+\.\s*/, "")}</li>)}</ol>
                    {dirty && <div className="hint" style={{ marginTop: 10 }}>Shown for the generated design; the flow in the exported architecture document is recomputed from your edited diagram.</div>}
                    <div className="section-title" style={{ marginTop: 16 }}>Consistency</div>
                    {design.consistency.map((c, i) => <div key={i}>{c}</div>)}
                  </>
                )}
                {tab === "risk" && (
                  <>
                    <div className="section-title">Potential bottlenecks</div><ul className="plain">{design.bottlenecks.map((b, i) => <li key={i}>{b}</li>)}</ul>
                    <div className="section-title" style={{ marginTop: 14 }}>Failure scenarios</div>
                    {design.failureScenarios.map((f, i) => <div className="decision" key={i}><span className="decision-title">{f.scenario}</span><div className="dim">{f.effect} Mitigation: {f.mitigation}</div></div>)}
                    <div className="section-title" style={{ marginTop: 14 }}>Scaling</div><ul className="plain">{design.scalingStrategies.map((s, i) => <li key={i}>{s}</li>)}</ul>
                    <div className="section-title" style={{ marginTop: 14 }}>Cost and complexity</div><div>{design.costComplexity}</div>
                  </>
                )}
                {tab === "infra" && (
                  <>
                    <div className="row" style={{ marginBottom: 10 }}>
                      <select className="select" style={{ width: 200 }} value={stack} onChange={(e) => setStack(e.target.value)} aria-label="Application stack">{stackList.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                      <button className="btn btn-primary" disabled={busy} onClick={generateInfra}>Generate infrastructure files</button>
                      <span className="hint">From the diagram as it is now, including your edits. Configuration only: nothing is started or deployed.</span>
                    </div>
                    {infra && (
                      <div className="panel" style={{ display: "grid", gridTemplateColumns: "230px 1fr", height: 360 }}>
                        <div className="file-explorer-pane">
                          {Object.keys(infra).map((f) => <button key={f} className={`file-node is-file${infraFile === f ? " is-selected" : ""}`} onClick={() => setInfraFile(f)}>{f}</button>)}
                        </div>
                        <div className="code-pane" style={{ position: "relative" }}>
                          <button className="btn btn-sm" style={{ position: "absolute", right: 12, top: 8, zIndex: 2 }} onClick={() => download(infraFile.split("/").pop(), infra[infraFile], "text/plain")}>Download</button>
                          <CodeViewer path={infraFile} content={infra[infraFile]} />
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="empty-state" style={{ margin: 32 }}>
            <p style={{ margin: 0 }}>Describe a system on the left to get an architecture you can inspect and edit.</p>
          </div>
        )}
      </div>

      <div className="ws-right">
        {graph ? <Inspector graph={graph} selected={selected} onChange={setGraph} onSelect={setSelected} /> : <div className="dim">The inspector shows the selected component&apos;s configuration.</div>}
      </div>
    </div>
  );
}
