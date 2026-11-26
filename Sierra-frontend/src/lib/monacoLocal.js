// Bundles Monaco with the app (no CDN), so the editor works offline and behind restrictive proxies.
import * as monaco from "monaco-editor/editor/editor.main.js";
import { loader } from "@monaco-editor/react";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import JsonWorker from "monaco-editor/language/json/json.worker.js?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker.js?worker";

self.MonacoEnvironment = {
  getWorker(_id, label) {
    if (label === "json") return new JsonWorker();
    if (label === "typescript" || label === "javascript") return new TsWorker();
    return new EditorWorker();
  },
};

// Generated projects are read-only previews with missing dependencies: do not show red squiggles for unresolved imports.
for (const d of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
  d.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
}

loader.config({ monaco });

export default monaco;
