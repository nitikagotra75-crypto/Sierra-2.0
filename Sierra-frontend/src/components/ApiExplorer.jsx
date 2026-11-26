import { useMemo, useState } from "react";

const DEFAULT_PORT = { "python-fastapi": 8000, "python-flask": 8000, "python-django": 8000, "node-fastify": 3000, nestjs: 3000, "go-nethttp": 8080, "node-express": 4000 };

function sampleValue(f) {
  if (f.type === "enum") return f.values[0];
  if (f.type === "int") return 1;
  if (f.type === "float") return 1.5;
  if (f.type === "bool") return true;
  return `sample ${f.name}`;
}

/** Endpoint list + copyable curl commands. It does not send requests: generated apps run where the user runs them. */
export default function ApiExplorer({ project, schema }) {
  const stack = project.techStack?.stack || "node-express";
  const [base, setBase] = useState(`http://localhost:${DEFAULT_PORT[stack] || 8080}`);
  const [copied, setCopied] = useState(null);
  const endpoints = useMemo(() => (project.apisCreated || []).map((e) => { const [method, ...rest] = e.split(" "); return { method, path: rest.join(" ") }; }), [project.apisCreated]);
  const needsAuth = !!schema?.needsAuth;

  function curl({ method, path }) {
    const url = base.replace(/\/+$/, "") + path.replace(/:id|\{id\}/g, "1");
    const isAuthRoute = path.startsWith("/api/auth");
    const resource = path.split("/")[2];
    const entity = schema?.entities.find((e) => e.plural === resource);
    let body = null;
    if (method === "POST" || method === "PUT") {
      if (path === "/api/auth/register") body = { email: "user@example.com", name: "User", password: "password123" };
      else if (path === "/api/auth/login") body = { email: "user@example.com", password: "password123" };
      else if (entity) body = Object.fromEntries(entity.fields.filter((f) => method === "POST" ? f.required || f.default === undefined : f.required).map((f) => [f.name, sampleValue(f)]));
    }
    return [`curl -X ${method} '${url}'`, needsAuth && !isAuthRoute ? `  -H 'Authorization: Bearer <token>'` : null, body ? `  -H 'Content-Type: application/json'` : null, body ? `  -d '${JSON.stringify(body)}'` : null].filter(Boolean).join(" \\\n");
  }

  if (endpoints.length === 0) return <div className="tab-pad dim">No endpoints recorded yet.</div>;
  return (
    <div className="tab-pad">
      <div className="grid-2" style={{ marginBottom: 14, alignItems: "end" }}>
        <div>
          <label className="field-label">Base URL where you run the generated API</label>
          <input className="input input--mono" value={base} onChange={(e) => setBase(e.target.value)} />
        </div>
        <div className="hint">Sierra does not host generated apps. Run the project locally, then use these commands.</div>
      </div>
      <div className="list">
        {endpoints.map((e, i) => (
          <div key={i}>
            <div className="endpoint">
              <span className={`method m-${e.method}`}>{e.method}</span>
              <span>{e.path}</span>
              <button className="btn btn-sm" onClick={() => { navigator.clipboard?.writeText(curl(e)).then(() => { setCopied(i); setTimeout(() => setCopied(null), 1200); }).catch(() => {}); }}>{copied === i ? "Copied" : "Copy curl"}</button>
            </div>
            <pre className="curl">{curl(e)}</pre>
          </div>
        ))}
      </div>
    </div>
  );
}
