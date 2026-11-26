/**
 * "Only what was asked for". Extras that are separable files (container and CI files) are generated only when the
 * requirement asks for them, or when the architecture needs them (microservices ship a compose file per design).
 * Auth is decided by requirementAgent from whole-word matches; this module covers Docker and CI.
 */
const DOCKER_RE = /\b(docker|dockerfile|dockerize[ds]?|dockerise[ds]?|container(?:s|ize[ds]?|ise[ds]?)?|compose|kubernetes|k8s|deploy(?:ment|ed)?)\b/i;
const CI_RE = /\b(ci\/cd|ci|cd|github actions?|gh actions?|pipelines?|workflows?|continuous integration)\b/i;

function scopeFor(requirement, { architecture } = {}) {
  const text = String(requirement || "");
  return {
    docker: DOCKER_RE.test(text) || architecture === "microservices",
    ci: CI_RE.test(text),
  };
}

const DOCKER_FILE = /(^|\/)(Dockerfile[^/]*|\.dockerignore|docker-compose[^/]*\.ya?ml)$/;
const CI_FILE = /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/;

function dropSection(readme, headingRe) {
  const lines = readme.split("\n");
  const out = [];
  let skipping = false;
  for (const line of lines) {
    if (/^## /.test(line)) skipping = headingRe.test(line);
    if (!skipping) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

function applyScope(files, scope) {
  const out = {};
  for (const [name, content] of Object.entries(files)) {
    if (!scope.docker && DOCKER_FILE.test(name)) continue;
    if (!scope.ci && CI_FILE.test(name)) continue;
    out[name] = content;
  }
  if (typeof out["README.md"] === "string") {
    let r = out["README.md"];
    if (!scope.docker) r = dropSection(r, /docker|container/i);
    if (!scope.ci) r = dropSection(r, /continuous integration|\bCI\b/i);
    out["README.md"] = r;
  }
  return out;
}

module.exports = { scopeFor, applyScope };
