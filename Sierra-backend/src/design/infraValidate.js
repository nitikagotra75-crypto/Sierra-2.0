/**
 * Static validation of generated infrastructure files with real tools, when they are installed.
 *
 * Honesty rules:
 *  - Every result is "passed", "failed" or "skipped" (tool not installed). Skipped is never reported as passed.
 *  - The overall level is STATICALLY_VALIDATED at best. Nothing here deploys, starts a container or applies a
 *    manifest, so a pass says "the files are well-formed and lint-clean", not "this runs in a cluster".
 *
 * Tools are looked up in $SIERRA_TOOLS_BIN (a venv bin dir, e.g. one created with
 * `pip install hadolint-py yamllint kubernetes-validate actionlint-py crossplane pyyaml`) and then in PATH.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const toolDirs = () => [process.env.SIERRA_TOOLS_BIN, "/tmp/infra-venv/bin"].filter(Boolean).filter((d) => fs.existsSync(d));

function findTool(name) {
  for (const d of toolDirs()) {
    const p = path.join(d, name);
    if (fs.existsSync(p)) return p;
  }
  const r = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function run(cmd, args, { cwd, env, timeout = 120000 } = {}) {
  const r = spawnSync(cmd, args, { cwd, env: env || process.env, encoding: "utf8", timeout });
  return { code: r.status === null ? -1 : r.status, out: ((r.stdout || "") + (r.stderr || "")).trim() };
}

const clip = (s, n = 1500) => (s.length > n ? s.slice(0, n) + "…" : s);

function write(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

const result = (check, tool, status, detail, files = []) => ({ check, tool, status, detail: clip(detail || ""), files });

const isYaml = (f) => /\.ya?ml$/.test(f);
const skipped = (check, tool, hint) => result(check, tool, "skipped", `${tool} is not installed here; ${hint}`);

// Structural checks that need no external tool beyond python3 + PyYAML (used when promtool/amtool are absent).
const STRUCT_PY = `
import sys, yaml
kind, path = sys.argv[1], sys.argv[2]
docs = [d for d in yaml.safe_load_all(open(path)) if d is not None]
errs = []
def rules_ok(groups, where):
    if not isinstance(groups, list) or not groups: errs.append(where + ": groups must be a non-empty list"); return
    for g in groups:
        if not g.get("name"): errs.append(where + ": group without name")
        for r in g.get("rules", []):
            if "alert" in r:
                if not r.get("expr"): errs.append(where + ": alert " + r["alert"] + " has no expr")
                if not r.get("labels", {}).get("severity"): errs.append(where + ": alert " + r["alert"] + " has no severity label")
            elif "record" not in r: errs.append(where + ": rule is neither alert nor record")
if kind == "rules":
    rules_ok(docs[0].get("groups"), path)
elif kind == "prometheusrule":
    for d in docs:
        if d.get("kind") == "PrometheusRule":
            if d.get("apiVersion") != "monitoring.coreos.com/v1": errs.append("PrometheusRule apiVersion must be monitoring.coreos.com/v1")
            rules_ok(d.get("spec", {}).get("groups"), "PrometheusRule")
        elif d.get("kind") == "ServiceMonitor":
            if not d.get("spec", {}).get("endpoints"): errs.append("ServiceMonitor has no endpoints")
            if not d.get("spec", {}).get("selector", {}).get("matchLabels"): errs.append("ServiceMonitor has no selector.matchLabels")
        else: errs.append("unexpected kind " + str(d.get("kind")))
elif kind == "alertmanager":
    c = docs[0]
    names = {r.get("name") for r in c.get("receivers", [])}
    if not c.get("route", {}).get("receiver"): errs.append("route.receiver is required")
    def walk(r):
        if r.get("receiver") and r["receiver"] not in names: errs.append("route references unknown receiver " + r["receiver"])
        for s in r.get("routes", []): walk(s)
    walk(c.get("route", {}))
elif kind == "prometheus":
    c = docs[0]
    if not c.get("scrape_configs"): errs.append("no scrape_configs")
    for rf in c.get("rule_files", []): pass
print("\\n".join(errs))
sys.exit(1 if errs else 0)
`;

function validateInfra(files, { dockerfiles = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sierra-infra-"));
  write(dir, files);
  const names = Object.keys(files);
  const results = [];
  const py = findTool("python") || findTool("python3");
  try {
    // 1. yamllint -------------------------------------------------------
    const yamlFiles = names.filter(isYaml);
    const yl = findTool("yamllint");
    if (!yamlFiles.length) { /* nothing to lint */ }
    else if (!yl) results.push(skipped("yaml-lint", "yamllint", "pip install yamllint"));
    else {
      const r = run(yl, ["-d", "{extends: relaxed, rules: {line-length: disable}}", ...yamlFiles], { cwd: dir });
      results.push(result("yaml-lint", "yamllint", r.code === 0 ? "passed" : "failed", r.out, yamlFiles));
    }

    // 2. docker compose config (offline; resolves interpolation, no daemon needed) --------------
    for (const f of names.filter((n) => /(^|\/)docker-compose[^/]*\.ya?ml$/.test(n))) {
      const docker = findTool("docker");
      if (!docker || run(docker, ["compose", "version"]).code !== 0) { results.push(skipped("compose-config", "docker compose", "install Docker with the compose plugin")); break; }
      // Required variables (${VAR:?msg}) must be present for `config` to resolve; supply placeholders only for this check.
      const env = { ...process.env };
      for (const m of files[f].matchAll(/\$\{([A-Z0-9_]+):\?/g)) env[m[1]] = "placeholder-for-validation";
      const r = run(docker, ["compose", "-f", f, "--profile", "*", "config", "-q"], { cwd: dir, env });
      results.push(result("compose-config", "docker compose config", r.code === 0 ? "passed" : "failed", r.out, [f]));
    }

    // 3. Kubernetes core manifests against the official API schemas ---------------------------
    const k8sCore = names.filter((n) => /(^|\/)k8s\/[^/]+\.ya?ml$/.test(n) && !/monitoring\.ya?ml$/.test(n));
    if (k8sCore.length) {
      const kv = findTool("kubernetes-validate");
      if (!kv) results.push(skipped("kubernetes-schema", "kubernetes-validate", "pip install kubernetes-validate"));
      else {
        const r = run(kv, ["--strict", "--no-warn", ...k8sCore], { cwd: dir });
        results.push(result("kubernetes-schema", "kubernetes-validate", r.code === 0 ? "passed" : "failed", r.out, k8sCore));
      }
    }

    // 4. Prometheus operator CRs, rules, Alertmanager, Prometheus config -------------------
    const structural = (check, kind, file) => {
      if (!names.includes(file)) return;
      if (!py) return results.push(skipped(check, "python3+PyYAML", "install python3 and PyYAML"));
      const r = run(py, ["-I", "-c", STRUCT_PY, kind, file], { cwd: dir });
      if (/No module named 'yaml'/.test(r.out)) return results.push(skipped(check, "PyYAML", "pip install pyyaml"));
      results.push(result(check, "structural check (python)", r.code === 0 ? "passed" : "failed", r.out, [file]));
    };
    const promtool = findTool("promtool");
    const amtool = findTool("amtool");
    for (const f of names.filter((n) => /monitoring\/alerts\.ya?ml$/.test(n))) {
      structural("prometheus-rules-structure", "rules", f);
      results.push(promtool ? (() => { const r = run(promtool, ["check", "rules", f], { cwd: dir }); return result("promtool-check-rules", "promtool", r.code === 0 ? "passed" : "failed", r.out, [f]); })()
        : skipped("promtool-check-rules", "promtool", "run `promtool check rules` (the generated CI workflow does)"));
    }
    for (const f of names.filter((n) => /monitoring\/prometheus\.ya?ml$/.test(n))) {
      structural("prometheus-config-structure", "prometheus", f);
      results.push(promtool ? (() => { const r = run(promtool, ["check", "config", f], { cwd: dir }); return result("promtool-check-config", "promtool", r.code === 0 ? "passed" : "failed", r.out, [f]); })()
        : skipped("promtool-check-config", "promtool", "run `promtool check config` (the generated CI workflow does)"));
    }
    for (const f of names.filter((n) => /monitoring\/alertmanager\.ya?ml$/.test(n))) {
      structural("alertmanager-config-structure", "alertmanager", f);
      results.push(amtool ? (() => { const r = run(amtool, ["check-config", f], { cwd: dir }); return result("amtool-check-config", "amtool", r.code === 0 ? "passed" : "failed", r.out, [f]); })()
        : skipped("amtool-check-config", "amtool", "run `amtool check-config` (the generated CI workflow does)"));
    }
    for (const f of names.filter((n) => /k8s\/monitoring\.ya?ml$/.test(n))) structural("prometheusrule-structure", "prometheusrule", f);

    // 5. GitHub Actions workflows -----------------------------------------------------
    const wf = names.filter((n) => /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(n));
    if (wf.length) {
      const al = findTool("actionlint");
      results.push(al ? (() => { const r = run(al, wf, { cwd: dir }); return result("workflow-lint", "actionlint", r.code === 0 ? "passed" : "failed", r.out, wf); })()
        : skipped("workflow-lint", "actionlint", "pip install actionlint-py"));
    }

    // 6. Dockerfiles ----------------------------------------------------------------
    const dfs = dockerfiles ? names.filter((n) => /(^|\/)Dockerfile[^/]*$/.test(n)) : [];
    if (dfs.length) {
      const hl = findTool("hadolint");
      for (const f of dfs) {
        results.push(hl ? (() => { const r = run(hl, ["--failure-threshold", "warning", f], { cwd: dir }); return result("dockerfile-lint", "hadolint", r.code === 0 ? "passed" : "failed", r.out, [f]); })()
          : skipped("dockerfile-lint", "hadolint", "pip install hadolint-py"));
      }
    }

    // 7. nginx ----------------------------------------------------------------------
    for (const f of names.filter((n) => /(^|\/)nginx[^/]*\.conf$/.test(n))) {
      const nginx = findTool("nginx");
      if (nginx) {
        // nginx -t needs resolvable upstream hosts; a parse-level failure there is reported as-is rather than hidden.
        const r = run(nginx, ["-t", "-c", path.join(dir, f), "-p", dir]);
        results.push(result("nginx-test", "nginx -t", r.code === 0 ? "passed" : "failed", r.out, [f]));
      } else if (py && run(py, ["-I", "-c", "import crossplane"]).code === 0) {
        const script = "import sys,json,crossplane\\np=crossplane.parse(sys.argv[1])\\nerrs=[e for c in p['config'] for e in c.get('errors',[])]\\nprint(p['status'], json.dumps(p.get('errors', []))[:1500])\\nsys.exit(0 if p['status']=='ok' and not errs else 1)";
        const r = run(py, ["-I", "-c", script.replace(/\\n/g, "\n"), f], { cwd: dir });
        results.push(result("nginx-syntax", "crossplane (parser only, not nginx -t)", r.code === 0 ? "passed" : "failed", r.out, [f]));
      } else results.push(skipped("nginx-test", "nginx", "run `nginx -t` (the generated CI workflow does)"));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => r.status === "failed");
  const skippedChecks = results.filter((r) => r.status === "skipped");
  const passed = results.filter((r) => r.status === "passed");
  return {
    status: failed.length ? "failed" : passed.length ? (skippedChecks.length ? "partial" : "passed") : "skipped",
    level: failed.length || !passed.length ? "IMPLEMENTED" : "STATICALLY_VALIDATED",
    summary: `${passed.length} passed, ${failed.length} failed, ${skippedChecks.length} skipped`,
    notes: "Static validation only: nothing was deployed, started or applied to a cluster.",
    results,
  };
}

module.exports = { validateInfra, findTool };
