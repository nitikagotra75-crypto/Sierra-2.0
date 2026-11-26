/** Read-only explanation of a design: why each component exists, what was left out, and the risks. */
export default function DesignSummary({ design }) {
  return (
    <div>
      <div className="section-title">{design.summary}</div>
      {design.nodes.filter((n) => n.rationale).map((n) => (
        <div key={n.id} className="decision">
          <div className="decision-title">{n.label}</div>
          <div>{n.rationale}</div>
          {n.tradeoffs?.length > 0 && <ul className="plain">{n.tradeoffs.map((t, i) => <li key={i}>{t}</li>)}</ul>}
        </div>
      ))}
      {design.skipped?.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div className="section-title">Deliberately not included</div>
          {design.skipped.map((s) => <div key={s.component} className="decision"><span className="decision-title">{s.component}</span> <span className="dim">{s.reason}</span></div>)}
        </div>
      )}
    </div>
  );
}
