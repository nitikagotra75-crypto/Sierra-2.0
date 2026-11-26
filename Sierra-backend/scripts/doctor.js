// npm run doctor : checks everything Sierra needs, with a plain verdict per item.
require("dotenv").config();
const { spawnSync } = require("child_process");
const net = require("net");
const rows = [];
const add = (name, ok, detail, level) => rows.push({ name, ok, detail, level: level || (ok ? "ok" : "fail") });
const run = (c, a) => { try { const r = spawnSync(c, a, { encoding: "utf8", shell: process.platform === "win32", timeout: 20000 }); return r.status === 0 ? (r.stdout || "").trim() : null; } catch { return null; } };
const tcp = (host, port) => new Promise((res) => { const s = net.connect({ host, port, timeout: 2000 }, () => { s.destroy(); res(true); }); s.on("error", () => res(false)); s.on("timeout", () => { s.destroy(); res(false); }); });

(async () => {
  const major = Number(process.versions.node.split(".")[0]);
  add("Node.js", major >= 18, `v${process.versions.node}${major >= 18 ? "" : " (need 18+)"}`);
  const npmv = run("npm", ["--version"]);
  add("npm", !!npmv, npmv || "npm not found");
  const reg = run("npm", ["config", "get", "registry"]);
  add("npm registry", !!reg, reg || "unknown", reg && !/registry\.npmjs\.org/.test(reg) ? "warn" : undefined);
  const sec = process.env.SIERRA_AUTH_SECRET || "";
  add("SIERRA_AUTH_SECRET", sec.length >= 16, sec.length >= 16 ? "set" : "missing or shorter than 16 chars (login/signup will return 503)");
  const uri = (process.env.MONGODB_URI || "").trim();
  if (!uri) add("MONGODB_URI", true, "not set: Express projects will be NOT_VERIFIED (files still generated)", "warn");
  else if (/[<>]/.test(uri) || !/^mongodb(\+srv)?:\/\//.test(uri)) add("MONGODB_URI", false, "placeholder or invalid value");
  else add("MONGODB_URI", true, "looks valid (connection is tested when the server starts)");
  const llm = ["GEMINI_API_KEY", "GROQ_API_KEY", "ANTHROPIC_API_KEY"].filter((k) => process.env[k]);
  add("LLM key", true, llm.length ? llm.join(", ") : "none: default entity schema will be used", llm.length ? "ok" : "warn");
  const tools = [["python", ["--version"], "Python stacks (fastapi/django/flask)"], ["go", ["version"], "Go stacks (net/http, gin)"]];
  for (const [c, a, why] of tools) {
    const v = run(c, a) || (c === "python" ? run("python3", a) || run("py", a) : null);
    add(c, !!v, v || `not found: ${why} will be NOT_VERIFIED`, v ? "ok" : "warn");
  }
  add("MongoDB local :27017", await tcp("127.0.0.1", 27017), "optional", "warn");
  for (const r of rows) {
    const mark = r.level === "ok" ? "OK  " : r.level === "warn" ? "WARN" : "FAIL";
    console.log(`${mark}  ${r.name.padEnd(22)} ${r.detail}`);
  }
  const fails = rows.filter((r) => r.level === "fail");
  console.log(fails.length ? `\n${fails.length} problem(s) must be fixed.` : "\nReady. Run: npm start");
  process.exit(fails.length ? 1 : 0);
})();
