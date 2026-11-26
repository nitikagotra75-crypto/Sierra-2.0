import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../services/api";
import { getSettings } from "../lib/settings";
import StackPicker from "../components/StackPicker";
import DesignSummary from "../components/DesignSummary";

const STEPS = ["Describe", "Stack", "Architecture", "Generate"];

export default function CreateProject() {
  const prefs = getSettings();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [requirement, setRequirement] = useState("");
  const [stacks, setStacks] = useState([]);
  const [stack, setStack] = useState(prefs.defaultStack);
  const [database, setDatabase] = useState(prefs.defaultDatabase);
  const [rps, setRps] = useState("");
  const [cache, setCache] = useState(false);
  const [rateLimit, setRateLimit] = useState(false);
  const [events, setEvents] = useState("");
  const [design, setDesign] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const navigate = useNavigate();

  useEffect(() => { api.listStacks().then((d) => setStacks(d.stacks)).catch((e) => setError(`Could not load stacks: ${e.message}`)); }, []);
  const def = stacks.find((s) => s.id === stack);
  const canCache = !!def?.features?.includes("cache");
  const canEvents = !!def?.features?.includes("events");
  const canRateLimit = !!def?.features?.includes("rateLimit");

  async function reviewArchitecture() {
    setBusy(true); setError(null);
    try {
      setDesign(await api.design({ description: requirement, options: rps ? { expectedRps: Number(rps) } : {} }));
      setStep(2);
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  async function generate() {
    setBusy(true); setError(null);
    try {
      const project = await api.createProject({ name, requirement, stack, database: database || undefined, architecture: prefs.defaultArchitecture, features: { ...(canRateLimit && rateLimit ? { rateLimit: true } : {}), ...(canCache && cache ? { cache: true } : {}), ...(canEvents && events ? { events } : {}) } });
      await api.generate(project.projectId);
      navigate(`/project/${project.projectId}`);
    } catch (e) { setError(e.message); setBusy(false); }
  }

  const canNext0 = name.trim() && requirement.trim().length >= 10;

  return (
    <div className="page page--narrow">
      <h1 className="page-title">Generate a backend</h1>
      <p className="page-subtitle">Describe it, pick a stack, review the architecture, then generate.</p>

      <div className="stepper">
        {STEPS.map((s, i) => (
          <div key={s} className={`step${i === step ? " is-active" : ""}${i < step ? " is-done" : ""}`}>
            <span className="step-num">{i < step ? "✓" : i + 1}</span><span>{s}</span>
          </div>
        ))}
      </div>

      {error && <div className="error-box" style={{ marginBottom: 16 }}>{error}</div>}

      {step === 0 && (
        <div className="form">
          <div>
            <label className="field-label">Project name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Task Manager API" />
          </div>
          <div>
            <label className="field-label">Describe your backend</label>
            <textarea className="textarea" rows={7} value={requirement} onChange={(e) => setRequirement(e.target.value)} placeholder="Task management API with user registration, login and CRUD for tasks and categories." />
            <div className="hint">Entities are detected from this text. At least one sentence.</div>
          </div>
          <div><button className="btn btn-primary" disabled={!canNext0} onClick={() => setStep(1)}>Continue</button></div>
        </div>
      )}

      {step === 1 && (
        <div className="form">
          <StackPicker stacks={stacks} value={stack} onChange={(id) => { setStack(id); setDatabase(""); }} />
          <div className="grid-2">
            <div>
              <label className="field-label">Database</label>
              <select className="select" value={database} onChange={(e) => setDatabase(e.target.value)}>
                <option value="">Stack default ({def?.databases?.[0] || "n/a"})</option>
                {(def?.databases || []).map((d) => <option key={d}>{d}</option>)}
              </select>
            </div>
            <div>
              <label className="field-label">Architecture</label>
              <select className="select" disabled><option>Monolith (layered)</option></select>
              <div className="hint">Modular and microservice output are planned, not available yet.</div>
            </div>
          </div>
          <div>
            <label className="field-label">Expected traffic (requests/second, optional)</label>
            <input className="input input--mono" type="number" min="1" value={rps} onChange={(e) => setRps(e.target.value)} placeholder="e.g. 2000" style={{ maxWidth: 220 }} />
            <div className="hint">Used only for the architecture review. Generated app code is the same layered service.</div>
          </div>
          {(canCache || canEvents || canRateLimit) && (
            <div>
              <div className="section-title">Runtime features</div>
              <div className="form" style={{ gap: 10 }}>
                {canRateLimit && (
                  <label className="row" style={{ cursor: "pointer" }}>
                    <input type="checkbox" checked={rateLimit} onChange={(e) => setRateLimit(e.target.checked)} />
                    <span>Per-IP rate limiting (429 + Retry-After; in-memory, per process)</span>
                  </label>
                )}
                {canCache && (
                  <label className="row" style={{ cursor: "pointer" }}>
                    <input type="checkbox" checked={cache} onChange={(e) => setCache(e.target.checked)} />
                    <span>Redis cache-aside on <span className="mono">GET /&#123;id&#125;</span> (TTL, invalidation on write, fails open)</span>
                  </label>
                )}
                {canEvents && (
                  <div style={{ maxWidth: 360 }}>
                    <label className="field-label">Domain events + worker</label>
                    <select className="select" value={events} onChange={(e) => setEvents(e.target.value)}>
                      <option value="">None</option>
                      <option value="rabbitmq">RabbitMQ</option>
                    </select>
                    <div className="hint">Publishes created/updated/deleted events and generates a consumer with retries and a dead-letter path. The RabbitMQ path is tested against a real broker (Go) or with a fake broker (other stacks); Kafka is available only as an experimental opt-in on the server.</div>
                  </div>
                )}
              </div>
            </div>
          )}
          {def?.notes && <div className="note-box">{def.notes}</div>}
          <div className="row">
            <button className="btn" onClick={() => setStep(0)}>Back</button>
            <button className="btn btn-primary" disabled={busy || !def} onClick={reviewArchitecture}>{busy ? "Analyzing…" : "Review architecture"}</button>
          </div>
        </div>
      )}

      {step === 2 && design && (
        <div className="form">
          <DesignSummary design={design} />
          <div className="note-box">This design is a recommendation for deployment. The generated code targets <span className="mono">{def?.label}</span> with <span className="mono">{database || def?.databases?.[0]}</span>; infrastructure files can be generated in the System design workspace.</div>
          <div className="row">
            <button className="btn" onClick={() => setStep(1)}>Back</button>
            <button className="btn" onClick={() => navigate("/design", { state: { description: requirement, design } })}>Open in design workspace</button>
            <button className="btn btn-primary" onClick={() => setStep(3)}>Approve and continue</button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="form">
          <div className="panel panel-pad">
            <div className="kv"><label>name</label><span>{name}</span></div>
            <div className="kv"><label>stack</label><span className="mono">{def?.label}</span></div>
            <div className="kv"><label>database</label><span className="mono">{database || def?.databases?.[0]}</span></div>
            <div className="kv"><label>architecture</label><span className="mono">monolith (layered)</span></div>
            {canRateLimit && rateLimit && <div className="kv"><label>rate limit</label><span className="mono">per-IP, 120/min default</span></div>}
            {canCache && cache && <div className="kv"><label>cache</label><span className="mono">redis cache-aside</span></div>}
            {canEvents && events && <div className="kv"><label>events</label><span className="mono">{events}</span></div>}
          </div>
          <div className="note-box">After generation Sierra runs the stack&apos;s own test suite. The result is reported exactly as it happens: verified, failed, or not verified if the toolchain is missing.</div>
          <div className="row">
            <button className="btn" onClick={() => setStep(2)}>Back</button>
            <button className="btn btn-primary" disabled={busy} onClick={generate}>{busy ? "Starting…" : "Generate backend"}</button>
          </div>
        </div>
      )}
    </div>
  );
}
