export default function SchemaView({ schema, error }) {
  if (error) return <div className="tab-pad"><div className="error-box">{error}</div></div>;
  if (!schema) return <div className="tab-pad dim">Loading schema…</div>;
  if (!schema.entities.length) return <div className="tab-pad dim">No entities recorded yet.</div>;
  return (
    <div className="tab-pad">
      <div className="note-box" style={{ marginBottom: 16 }}>
        Database: <span className="mono">{schema.database || "n/a"}</span> · Stack: <span className="mono">{schema.stack}</span>. Every record also has <span className="mono">id</span> and <span className="mono">createdAt</span>
        {schema.needsAuth ? "; non-user records are scoped to their owner." : "."}
      </div>
      {schema.entities.map((e) => (
        <div key={e.name} className="report-block">
          <div className="section-title">{e.name}</div>
          <div className="panel">
            <table className="table">
              <thead><tr><th>Field</th><th>Type</th><th>Required</th><th>Default / values</th></tr></thead>
              <tbody>
                {e.fields.map((f) => (
                  <tr key={f.name}>
                    <td className="mono">{f.name}</td>
                    <td className="mono dim">{f.type}</td>
                    <td>{f.required ? "yes" : "no"}</td>
                    <td className="mono dim">{f.type === "enum" ? f.values.join(" | ") : f.default !== undefined && f.default !== "" ? String(f.default) : f.note || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
