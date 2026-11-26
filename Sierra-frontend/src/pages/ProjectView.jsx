import { useEffect, useState, useCallback } from "react";
import { useParams } from "react-router-dom";
import { api } from "../services/api";
import { useProjectEvents } from "../hooks/useProjectEvents";
import StatusBadge from "../components/StatusBadge";
import ActivityFeed from "../components/ActivityFeed";
import CodeWorkspace from "../components/CodeWorkspace";
import ReportPanel from "../components/ReportPanel";
import ApiExplorer from "../components/ApiExplorer";
import SchemaView from "../components/SchemaView";

const TABS = [["activity", "Live activity"], ["files", "Files"], ["report", "Verification"], ["api", "API"], ["db", "Database"]];

export default function ProjectView() {
  const { id } = useParams();
  const [project, setProject] = useState(null);
  const [files, setFiles] = useState([]);
  const [schema, setSchema] = useState(null);
  const [schemaError, setSchemaError] = useState(null);
  const [tab, setTab] = useState("activity");

  function loadAll() {
    api.getProject(id).then(setProject).catch(() => {});
    api.listFiles(id).then((d) => setFiles(d.files)).catch(() => {});
    api.getSchema(id).then((d) => { setSchema(d); setSchemaError(null); }).catch((e) => setSchemaError(e.message));
  }

  const events = useProjectEvents(id, () => { loadAll(); setTab("report"); });
  useEffect(loadAll, [id]);

  const loadFile = useCallback((path) => api.getFile(id, path).then((d) => d.content), [id]);

  if (!project) return <div className="page dim">Loading project…</div>;

  return (
    <div className="project-view">
      <div className="project-header">
        <div>
          <h1 className="project-title">{project.name}</h1>
          <p className="project-subtitle">{project.requirement}</p>
          <div className="project-meta">
            <span className="tag">{project.techStack?.stack || "node-express"}</span>
            {project.techStack?.database && <span className="tag">{project.techStack.database}</span>}
            <span className="tag">{project.techStack?.architecture || "monolith"}</span>
          </div>
        </div>
        <div className="row">
          <StatusBadge status={project.finalStatus} />
          {files.length > 0 && <a className="btn" href={api.downloadUrl(id)} download>Download .zip</a>}
        </div>
      </div>

      <div className="tabs">
        {TABS.map(([k, label]) => <button key={k} onClick={() => setTab(k)} className={`tab${tab === k ? " active" : ""}`}>{label}</button>)}
      </div>

      <div className="tab-content">
        {tab === "activity" && <ActivityFeed events={events} />}
        {tab === "files" && <CodeWorkspace files={files} loadFile={loadFile} />}
        {tab === "report" && <ReportPanel project={project} />}
        {tab === "api" && <ApiExplorer project={project} schema={schema} />}
        {tab === "db" && <SchemaView schema={schema} error={schemaError} />}
      </div>
    </div>
  );
}
