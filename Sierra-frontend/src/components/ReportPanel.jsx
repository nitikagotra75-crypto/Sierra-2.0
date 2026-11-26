import StatusBadge from "./StatusBadge";
import { LEVELS, buildRows } from "../lib/verification";

function exportReport(report) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url; a.download = "sierra-verification-report.json"; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const RESULT = { passed: ["report-ok", "Passed"], failed: ["report-fail", "Failed"], skipped: ["report-warn", "Skipped"], blocked: ["report-warn", "Blocked"] };

function Matrix({ report }) {
  const rows = buildRows(report);
  const reached = (report.levels && report.levels.reached) || [];
  const failed = (report.levels && report.levels.failed) || [];
  return (
    <div className="report-block">
      <div className="section-title">Verification levels</div>
      <div className="row" style={{ flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
        {LEVELS.map(([k, l]) => <span key={k} className={`tag ${reached.includes(k) ? "" : "tag--planned"}`}>{reached.includes(k) ? "✓" : "○"} {l}</span>)}
        {failed.map((f) => <span key={f} className="tag report-fail">✗ {f}</span>)}
      </div>
      <div style={{ overflowX: "auto" }}>
        <table className="report-table">
          <thead><tr><th>Feature</th><th>Framework</th><th>Level</th><th>Result</th><th>Details</th><th>Command</th><th>Verified at</th></tr></thead>
          <tbody>
            {rows.map((r, i) => {
              const [cls, label] = RESULT[r.result];
              return (
                <tr key={i}>
                  <td>{r.feature}</td><td className="mono">{r.framework}</td>
                  <td>{r.level ? (LEVELS.find(([k]) => k === r.level) || [])[1] : "—"}</td>
                  <td className={cls}>{label}</td>
                  <td><details><summary className="dim">{String(r.detail || "").split("\n")[0].slice(0, 80) || "—"}</summary><pre className="out">{r.detail}</pre></details></td>
                  <td className="mono">{r.command || "—"}</td>
                  <td className="mono">{r.at ? new Date(r.at).toLocaleString() : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <button className="btn btn-sm" style={{ marginTop: 10 }} onClick={() => exportReport(report)}>Export report (JSON)</button>
    </div>
  );
}

function Row({ label, ok, detail, warn }) {
  return (
    <div className="report-row">
      <span className="report-row-label">{label}</span>
      <span className={warn ? "report-warn" : ok ? "report-ok" : "report-fail"}>{detail}</span>
    </div>
  );
}

function Header({ report }) {
  return (
    <div className="row" style={{ justifyContent: "space-between", marginBottom: 14 }}>
      <div className="section-title" style={{ margin: 0 }}>Verification report</div>
      <StatusBadge status={report.status} />
    </div>
  );
}

function V2Report({ report }) {
  const v = report.validation || { status: "skipped", steps: [] };
  return (
    <div className="tab-pad">
      <Header report={report} />
      <div className="report-block panel panel-pad">
        <Row label="Stack" ok detail={report.stack} />
        <Row label="Files generated" ok={report.filesGenerated > 0} detail={report.filesGenerated || 0} />
        <Row label="Toolchain validation" ok={v.status === "passed"} warn={v.status === "skipped"} detail={v.status === "skipped" ? `skipped: ${v.reason}` : v.status} />
      </div>
      {report.reason && <div className="error-box report-block">{report.reason}</div>}
      <Matrix report={report} />
      {v.steps.length > 0 && (
        <div className="report-block">
          <div className="section-title">Commands run</div>
          {v.steps.map((s, i) => (
            <details key={i} open={s.code !== 0} style={{ marginBottom: 6 }}>
              <summary><span className={s.code === 0 ? "report-ok" : "report-fail"}>{s.code === 0 ? "✓" : "✗"}</span> <span className="mono">{s.command}</span></summary>
              <pre className="out">{s.output || "(no output)"}</pre>
            </details>
          ))}
        </div>
      )}
      {report.staticChecks && (
        <div className="report-block panel panel-pad">
          <div className="section-title">Static checks</div>
          {report.staticChecks.map((c) => <Row key={c.check} label={c.detail} ok={c.level === "pass"} detail={c.level} />)}
        </div>
      )}
      {report.autofix && report.autofix.history?.length > 0 && (
        <div className="report-block">
          <div className="section-title">Auto-fix history ({report.autofix.status})</div>
          {report.autofix.history.map((h, i) => (
            <details key={i} style={{ marginBottom: 6 }}>
              <summary><span className="mono">attempt {i + 1}: {h.phase}</span> <span className="dim">{h.command}</span></summary>
              <pre className="out">{JSON.stringify(h, null, 2)}</pre>
            </details>
          ))}
        </div>
      )}
      {report.apisCreated?.length > 0 && (
        <div className="report-block">
          <div className="section-title">APIs created</div>
          <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>{report.apisCreated.map((a) => <span key={a} className="tag">{a}</span>)}</div>
        </div>
      )}
      {report.disclaimer && <div className="disclaimer">{report.disclaimer}</div>}
    </div>
  );
}

export default function ReportPanel({ project }) {
  const report = project?.report;
  if (!report) return <div className="tab-pad dim">No verification report yet. Waiting for the pipeline to finish.</div>;
  if (report.engine === "v2") return <V2Report report={report} />;

  if (report.status && report.reason && !report.apiTests) {
    return (
      <div className="tab-pad">
        <Header report={report} />
        <div className="error-box">{report.reason}</div>
        {report.detail && <pre className="out">{report.detail}</pre>}
      </div>
    );
  }

  const failCount = (lvl) => report.security.findings.filter((f) => f.level === lvl).length;
  return (
    <div className="tab-pad">
      <Header report={report} />
      <div className="report-block panel panel-pad">
        <Row label="Files generated" ok={report.filesGenerated} detail={report.filesGenerated ? "✓" : "✗"} />
        <Row label="Dependencies" ok={report.dependenciesInstalled} detail={report.dependenciesInstalled ? "✓" : "✗"} />
        <Row label="Build" ok={report.build} detail={report.build ? "✓" : "✗"} />
        <Row label="Server startup" ok={report.serverStartup} detail={report.serverStartup ? `✓ (${report.dockerMode ? "docker" : "sandbox"})` : "✗"} />
        <Row label="API tests" ok={report.apiTests.passed === report.apiTests.total && report.apiTests.total > 0} detail={`${report.apiTests.passed}/${report.apiTests.total}`} />
        <Row label="Regression tests" ok={report.regressionTests} detail={report.regressionTests ? "✓" : "✗"} />
        <Row label="Code quality" ok={report.codeQuality.issues.length === 0} detail={`${report.codeQuality.issues.length} issue(s)`} />
        <Row label="Security check" ok={failCount("fail") === 0} detail={`${failCount("fail")} fail, ${failCount("warn")} warn`} />
      </div>
      {report.fixAttempts?.length > 0 && (
        <div className="report-block">
          <div className="section-title">Self-debugging</div>
          {report.fixAttempts.map((f, i) => (
            <div key={i} className="mono dim">#{f.attempt} {f.failure}: {f.applied ? `fixed ${f.file} (${f.method})` : "no confident fix found"}</div>
          ))}
        </div>
      )}
      {report.apisCreated && (
        <div className="report-block">
          <div className="section-title">APIs created</div>
          <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>{report.apisCreated.map((a) => <span key={a} className="tag">{a}</span>)}</div>
        </div>
      )}
      {report.security?.disclaimer && <div className="disclaimer">{report.security.disclaimer}</div>}
    </div>
  );
}
