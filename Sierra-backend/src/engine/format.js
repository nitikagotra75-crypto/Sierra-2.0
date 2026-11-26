/**
 * Formatter stage of the generate -> format -> lint -> build -> test pipeline.
 * Go output is passed through `gofmt` when it is installed; a file gofmt rejects (syntax error) is left untouched so
 * the later build/validate steps report the real error instead of it being hidden. Without gofmt the files are
 * returned unformatted and the validator's gofmt check says so.
 */
const { spawnSync } = require("child_process");

let gofmtAvailable;
function hasGofmt() {
  if (gofmtAvailable === undefined) gofmtAvailable = spawnSync("sh", ["-c", "command -v gofmt"]).status === 0;
  return gofmtAvailable;
}

function formatGo(files) {
  if (!hasGofmt()) return files;
  const out = { ...files };
  for (const [name, text] of Object.entries(files)) {
    if (!name.endsWith(".go")) continue;
    const r = spawnSync("gofmt", [], { input: text, encoding: "utf8" });
    if (r.status === 0 && r.stdout) out[name] = r.stdout;
  }
  return out;
}

const FORMATTERS = { Go: formatGo };

function withFormat(stack) {
  const fmt = FORMATTERS[stack.language];
  if (!fmt) return stack;
  const base = stack.generate;
  return { ...stack, generate: (spec) => fmt(base(spec)) };
}

module.exports = { withFormat, formatGo };
