export default function StackPicker({ stacks, value, onChange }) {
  const groups = {};
  for (const s of stacks) (groups[s.language] = groups[s.language] || []).push(s);
  return (
    <div className="form" style={{ gap: 14 }}>
      {Object.entries(groups).map(([lang, items]) => (
        <div key={lang}>
          <div className="section-title">{lang}</div>
          <div className="stack-grid">
            {items.map((s) => {
              const ready = s.status === "implemented";
              return (
                <button type="button" key={s.id} disabled={!ready} onClick={() => onChange(s.id)} className={`stack-card${value === s.id ? " is-selected" : ""}`} title={ready ? s.notes || "" : "Not implemented yet"}>
                  <span className="stack-card-name">{s.label}</span>
                  <span className="stack-card-sub">
                    {ready ? <span className="mono">{s.databases.join(" · ")}</span> : <span className="tag tag--planned">planned</span>}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
