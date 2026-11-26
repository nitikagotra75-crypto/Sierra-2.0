import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import FileExplorer from "./FileExplorer";
import CodeViewer from "./CodeViewer";
import { LANGUAGES, languageFor } from "../lib/languages";

/**
 * File browser + tabbed Monaco editor. `files` is a list of paths; `loadFile(path)` resolves to the content.
 * Tabs, a filter, language switching and go-to-line are provided here; find/replace-style navigation inside a
 * file is Monaco's own (Ctrl/Cmd+F, Ctrl+G).
 */
export default function CodeWorkspace({ files, loadFile, initial }) {
  const [open, setOpen] = useState(initial ? [initial] : []);
  const [active, setActive] = useState(initial || null);
  const [contents, setContents] = useState({});
  const [langOverride, setLangOverride] = useState({});
  const [filter, setFilter] = useState("");
  const [drawer, setDrawer] = useState(false);
  const [line, setLine] = useState("");
  const [pos, setPos] = useState({ line: 1, col: 1 });
  const editorRef = useRef(null);

  const shown = useMemo(() => (filter ? files.filter((f) => f.toLowerCase().includes(filter.toLowerCase())) : files), [files, filter]);

  const select = useCallback((path) => {
    setOpen((o) => (o.includes(path) ? o : [...o, path]));
    setActive(path);
    setDrawer(false);
  }, []);

  useEffect(() => {
    if (!active || contents[active] !== undefined) return;
    let live = true;
    Promise.resolve(loadFile(active))
      .then((c) => live && setContents((m) => ({ ...m, [active]: c })))
      .catch(() => live && setContents((m) => ({ ...m, [active]: "// couldn't load file" })));
    return () => { live = false; };
  }, [active, contents, loadFile]);

  function close(path, e) {
    e.stopPropagation();
    setOpen((o) => {
      const next = o.filter((p) => p !== path);
      if (active === path) setActive(next[next.length - 1] || null);
      return next;
    });
  }

  function onMount(editor) {
    editorRef.current = editor;
    editor.onDidChangeCursorPosition((e) => setPos({ line: e.position.lineNumber, col: e.position.column }));
  }

  function goToLine(e) {
    e.preventDefault();
    const n = Number(line);
    const ed = editorRef.current;
    if (!ed || !Number.isInteger(n) || n < 1) return;
    ed.revealLineInCenter(n);
    ed.setPosition({ lineNumber: n, column: 1 });
    ed.focus();
  }

  const lang = active ? langOverride[active] || languageFor(active) : "plaintext";

  return (
    <div className={`code-ws${drawer ? " drawer-open" : ""}`} data-testid="code-workspace">
      <div className="code-ws-side">
        <div className="code-ws-filter">
          <input className="input" placeholder={`Filter ${files.length} files…`} value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter files" />
        </div>
        <div className="file-explorer-pane">
          <FileExplorer files={shown} selected={active} onSelect={select} />
          {shown.length === 0 && <div className="hint" style={{ padding: 12 }}>No files match.</div>}
        </div>
      </div>
      <div className="code-ws-main">
        <div className="code-ws-bar">
          <button className="btn btn-sm code-ws-drawer-btn" onClick={() => setDrawer((d) => !d)} aria-expanded={drawer}>Files</button>
          <div className="code-tabs" role="tablist">
            {open.map((p) => (
              <div key={p} role="tab" aria-selected={p === active} className={`code-tab${p === active ? " active" : ""}`} onClick={() => setActive(p)} title={p}>
                <span className="code-tab-name">{p.split("/").pop()}</span>
                <button className="code-tab-close" aria-label={`Close ${p}`} onClick={(e) => close(p, e)}>×</button>
              </div>
            ))}
          </div>
        </div>
        {active && (
          <div className="code-ws-tools">
            <span className="mono code-ws-path" title={active}>{active}</span>
            <label className="row" style={{ gap: 6 }}>
              <span className="hint">Language</span>
              <select className="select select-sm" value={lang} onChange={(e) => setLangOverride((m) => ({ ...m, [active]: e.target.value }))} aria-label="Language">
                {(LANGUAGES.includes(lang) ? LANGUAGES : [lang, ...LANGUAGES]).map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </label>
            <form onSubmit={goToLine} className="row" style={{ gap: 6 }}>
              <input className="input input-sm" style={{ width: 70 }} inputMode="numeric" placeholder="Line" value={line} onChange={(e) => setLine(e.target.value)} aria-label="Go to line" />
              <button className="btn btn-sm" type="submit">Go</button>
            </form>
            <span className="hint mono">Ln {pos.line}, Col {pos.col}</span>
          </div>
        )}
        <div className="code-pane">
          <CodeViewer path={active} content={active ? contents[active] ?? "" : ""} language={active ? lang : undefined} onMount={onMount} />
        </div>
      </div>
    </div>
  );
}
