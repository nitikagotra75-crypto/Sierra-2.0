import { lazy, Suspense } from "react";
import { languageFor } from "../lib/languages";
import ErrorBoundary from "./ErrorBoundary";

const MonacoEditor = lazy(() => import("./MonacoEditor"));

export default function CodeViewer({ path, content, language, onMount }) {
  if (!path) return <div className="code-viewer-empty">Select a file to view its generated code</div>;
  return (
    <ErrorBoundary key={path}>
    <Suspense fallback={<div className="code-viewer-empty">Loading editor…</div>}>
      <MonacoEditor path={path} content={content} language={language || languageFor(path)} onMount={onMount} />
    </Suspense>
    </ErrorBoundary>
  );
}
