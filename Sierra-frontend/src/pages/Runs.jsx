import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../services/api";

export default function Runs() {
  const [runs, setRuns] = useState(null);
  const [projects, setProjects] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.listRecentRuns().then((d) => setRuns(d.runs)).catch((e) => setError(e.message));
    api.listProjects().then((d) => setProjects(d.projects)).catch(() => {});
  }, []);

  return (
    <div className="page">
      <h1 className="page-title">Generation history</h1>
      <p className="page-subtitle">Every generation and every test run, across all projects.</p>
      {error && <div className="error-box" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="section-title">Generations</div>
      {projects && projects.length === 0 && <div className="dim" style={{ marginBottom: 20 }}>No generations yet.</div>}
      <div className="list" style={{ marginBottom: 28 }}>
        {projects && projects.map((p) => (
          <Link key={p.projectId} to={`/project/${p.projectId}`} className="list-item">
            <div className="list-item-main">
              <div className="list-item-title truncate">{p.name}</div>
              <div className="list-item-sub mono">{p.createdAt ? new Date(p.createdAt).toLocaleString() : ""}</div>
            </div>
            <div className="list-item-side"><span className="tag">{p.techStack?.stack || "node-express"}</span><span>{p.finalStatus}</span></div>
          </Link>
        ))}
      </div>

      <div className="section-title">Test runs (Express pipeline)</div>
      {runs && runs.length === 0 && <div className="dim">No test runs recorded. Other stacks record their results in the project&apos;s verification report.</div>}
      <div className="list">
        {runs && runs.map((r) => (
          <Link key={r._id} to={`/project/${r.projectId}`} className="list-item">
            <div className="row" style={{ minWidth: 0 }}>
              <span className="mono dim" style={{ width: 84, flexShrink: 0 }}>{r.phase}</span>
              <span className="truncate" style={{ color: "var(--bright)" }}>{r.projectName}</span>
            </div>
            <div className="list-item-side">
              <span className={r.failed > 0 ? "report-fail" : "report-ok"}>{r.passed}/{r.passed + r.failed} passed</span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
