import Editor from "@monaco-editor/react";
import "../lib/monacoLocal"; // configures the bundled Monaco before the first editor mounts

function defineTheme(monaco) {
  monaco.editor.defineTheme("sierra", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: { "editor.background": "#0d1117", "editorLineNumber.foreground": "#484f58", "editor.lineHighlightBackground": "#161b2200", "editorGutter.background": "#0d1117" },
  });
}

export default function MonacoEditor({ path, content, language, onMount }) {
  return (
    <Editor
      height="100%"
      theme="sierra"
      beforeMount={defineTheme}
      onMount={onMount}
      path={path}
      language={language}
      value={content ?? ""}
      loading={<div className="code-viewer-empty">Loading editor…</div>}
      options={{ readOnly: true, automaticLayout: true, minimap: { enabled: false }, fontSize: 12.5, fontFamily: "JetBrains Mono, monospace", scrollBeyondLastLine: false, padding: { top: 12 }, renderLineHighlight: "none", wordWrap: "off", fixedOverflowWidgets: true }}
    />
  );
}
