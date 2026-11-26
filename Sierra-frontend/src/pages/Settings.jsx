import { useCallback, useEffect, useState } from "react";
import { api } from "../services/api";
import { getSettings, saveSettings } from "../lib/settings";
import StackPicker from "../components/StackPicker";

export default function Settings() {
  const [s, setS] = useState(getSettings());
  const [stacks, setStacks] = useState([]);
  const [caps, setCaps] = useState(null);
  const [health, setHealth] = useState("checking");
  const [saved, setSaved] = useState(false);

  const fetchStatus = useCallback(() => {
    api.health().then(() => setHealth("up")).catch(() => setHealth("down"));
    api.capabilities().then(setCaps).catch(() => setCaps(null));
    api.listStacks().then((d) => setStacks(d.stacks)).catch(() => setStacks([]));
  }, []);
  function probe(recheck = false) {
    if (recheck) setHealth("checking");
    fetchStatus();
  }
  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const stack = stacks.find((x) => x.id === s.defaultStack);

  function save(e) {
    e.preventDefault();
    saveSettings(s);
    setSaved(true);
    probe(true);
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    <div className="page page--narrow">
      <h1 className="page-title">Settings</h1>
      <p className="page-subtitle">Stored in this browser only.</p>
      <form className="form" onSubmit={save}>
        <div>
          <div className="section-title">Backend connection</div>
          <label className="field-label">API base URL</label>
          <input className="input input--mono" value={s.apiBase} placeholder="http://localhost:5001" onChange={(e) => setS({ ...s, apiBase: e.target.value })} />
          <div className="hint"><span className={`dot ${health === "up" ? "dot--ok" : health === "down" ? "dot--down" : ""}`} />{health === "up" ? "Reachable" : health === "down" ? "Not reachable at this address" : "Checking…"}</div>
        </div>

        <div>
          <div className="section-title">Generator defaults</div>
          <StackPicker stacks={stacks} value={s.defaultStack} onChange={(id) => setS({ ...s, defaultStack: id, defaultDatabase: "" })} />
          <div className="grid-2" style={{ marginTop: 12 }}>
            <div>
              <label className="field-label">Database</label>
              <select className="select" value={s.defaultDatabase} onChange={(e) => setS({ ...s, defaultDatabase: e.target.value })}>
                <option value="">Stack default</option>
                {(stack?.databases || []).map((d) => <option key={d}>{d}</option>)}
              </select>
            </div>
            <div>
              <label className="field-label">Architecture</label>
              <select className="select" value={s.defaultArchitecture} onChange={(e) => setS({ ...s, defaultArchitecture: e.target.value })}>
                <option value="monolith">Monolith (layered)</option>
              </select>
            </div>
          </div>
        </div>

        <div className="row"><button className="btn btn-primary" type="submit">Save</button>{saved && <span className="report-ok">Saved</span>}</div>
      </form>

      <div style={{ marginTop: 32 }}>
        <div className="section-title">Server toolchains (used to validate generated code)</div>
        {caps ? (
          <div className="panel">
            <table className="table"><tbody>
              {Object.entries(caps.toolchains).map(([k, v]) => (
                <tr key={k}><td className="mono">{k}</td><td className={v ? "report-ok" : "dim"}>{v ? "available" : "not installed"}</td></tr>
              ))}
              <tr><td className="mono">LLM (Claude)</td><td className={caps.llm ? "report-ok" : "dim"}>{caps.llm ? "API key configured" : "no API key: heuristic requirement parser is used"}</td></tr>
            </tbody></table>
          </div>
        ) : <div className="dim">Backend not reachable.</div>}
        <div className="hint">If a stack&apos;s toolchain is missing, its projects finish as &quot;Not verified&quot; instead of passing.</div>
      </div>
    </div>
  );
}
