// File path -> Monaco language id, plus the list offered by the language switcher.
const EXT = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", tsx: "typescript", json: "json",
  md: "markdown", py: "python", go: "go", yml: "yaml", yaml: "yaml", sh: "shell", java: "java", cs: "csharp", csproj: "xml",
  xml: "xml", conf: "ini", ini: "ini", mod: "go", sum: "plaintext", txt: "plaintext", sql: "sql", properties: "ini", html: "html", css: "css",
  toml: "ini", env: "ini",
};
const BASENAME = { dockerfile: "dockerfile", ".env": "ini", ".env.example": "ini", ".gitignore": "plaintext", ".dockerignore": "plaintext" };

export function languageFor(path) {
  if (!path) return "plaintext";
  const base = path.split("/").pop().toLowerCase();
  if (BASENAME[base]) return BASENAME[base];
  if (base.startsWith("dockerfile.")) return "dockerfile";
  return EXT[base.split(".").pop()] || "plaintext";
}

export const LANGUAGES = ["plaintext", "javascript", "typescript", "json", "python", "go", "java", "csharp", "yaml", "dockerfile", "shell", "ini", "xml", "markdown", "sql", "html", "css"];
