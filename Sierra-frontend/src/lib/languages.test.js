import test from "node:test";
import assert from "node:assert/strict";
import { languageFor, LANGUAGES } from "./languages.js";

test("maps every file type Sierra generates to a Monaco language", () => {
  const cases = { "src/app.js": "javascript", "src/app.module.ts": "typescript", "app/main.py": "python", "cmd/server/main.go": "go", "go.mod": "go",
    "src/main/java/App.java": "java", "Program.cs": "csharp", "pom.xml": "xml", "App.csproj": "xml", "docker-compose.yml": "yaml", "k8s/app.yaml": "yaml",
    "Dockerfile": "dockerfile", "infra/Dockerfile.prod": "dockerfile", "README.md": "markdown", "package.json": "json", ".env.example": "ini", "nginx.conf": "ini",
    "application.properties": "ini", "unknown.zzz": "plaintext", "": "plaintext" };
  for (const [p, lang] of Object.entries(cases)) assert.equal(languageFor(p), lang, p);
  for (const lang of Object.values(cases)) assert.ok(LANGUAGES.includes(lang), `${lang} is selectable`);
});
