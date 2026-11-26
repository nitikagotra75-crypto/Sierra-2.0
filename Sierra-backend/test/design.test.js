const test = require("node:test");
const assert = require("node:assert");
const { designSystem } = require("../src/design/designEngine");
const { generateInfra } = require("../src/design/infraGenerator");
const { runCommand, writeFiles } = require("../src/execution/executionManager");
const { hasTool } = require("../src/engine/validate");
const fs = require("fs"), os = require("os"), path = require("path");

const ids = (d) => d.nodes.map((n) => n.id);

test("scalable URL shortener gets LB, cache and replicas but no broker", () => {
  const d = designSystem({ description: "Build a scalable URL shortener capable of handling millions of requests." });
  for (const id of ["lb", "app", "db", "cache", "replica"]) assert.ok(ids(d).includes(id), id);
  assert.ok(!ids(d).includes("queue"));
  assert.ok(d.skipped.some((s) => s.component === "Message broker"));
});

test("small app stays minimal: no optional infrastructure", () => {
  const d = designSystem({ description: "Small internal todo app for my team" });
  assert.deepEqual(ids(d), ["client", "app", "db"]);
});

test("every node has a rationale and edges reference existing nodes", () => {
  for (const description of ["Scalable URL shortener for millions of users", "Payment checkout with email notifications, high availability", "Real-time analytics event stream for clicks, high traffic"]) {
    const d = designSystem({ description });
    const set = new Set(ids(d));
    for (const n of d.nodes) assert.ok(n.rationale && n.rationale.length > 10, n.id);
    for (const e of d.edges) assert.ok(set.has(e.from) && set.has(e.to), e.id);
  }
});

test("payments choose PostgreSQL and strong consistency; event streams choose Kafka; jobs choose RabbitMQ", () => {
  assert.equal(designSystem({ description: "Payment ledger service for wallets" }).nodes.find((n) => n.id === "db").config.engine, "postgresql");
  assert.match(designSystem({ description: "Real-time analytics event stream for clicks, high traffic" }).nodes.find((n) => n.id === "queue").label, /Kafka/);
  assert.match(designSystem({ description: "Photo app that sends email notifications in the background" }).nodes.find((n) => n.id === "queue").label, /Rabbit/);
});

test("explicit options override inference; bad input rejected", () => {
  const d = designSystem({ description: "Simple catalog site for products", options: { expectedRps: 20000, database: "mongodb" } });
  assert.equal(d.nodes.find((n) => n.id === "db").config.engine, "mongodb");
  assert.ok(!ids(d).includes("replica")); // mongodb uses replica sets/sharding, not SQL read replicas
  assert.throws(() => designSystem({ description: "x" }), (e) => e.statusCode === 400);
});

test("infra only contains components present in the design", () => {
  const small = generateInfra(designSystem({ description: "Small internal todo app for my team" }), { stack: "go-nethttp" });
  assert.ok(!("infra/nginx.conf" in small) && !("infra/redis.conf" in small));
  assert.ok(!/redis|kafka|rabbit/i.test(small["infra/docker-compose.yml"]));
  const big = generateInfra(designSystem({ description: "Scalable URL shortener for millions of users" }), { stack: "python-fastapi" });
  assert.ok("infra/nginx.conf" in big && "infra/redis.conf" in big);
  assert.match(big["infra/docker-compose.yml"], /replicas: 4/);
  assert.match(big["infra/NOTES.md"], /NOT provisioned/);
  assert.ok(!big["infra/NOTES.md"].includes("Prometheus config is generated"));
});

test("infra rejects a design without app/database", () => {
  assert.throws(() => generateInfra({ nodes: [] }), (e) => e.statusCode === 400);
});

async function withFiles(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sierra-infra-"));
  await writeFiles(dir, files);
  try { return await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test("generated YAML parses (PyYAML) for compose, k8s and CI", async (t) => {
  if (!(await hasTool("python3"))) return t.skip("python3 missing");
  const probe = await runCommand("python3", ["-c", "'import yaml'"], { cwd: os.tmpdir(), env: process.env });
  if (probe.code !== 0) return t.skip("PyYAML missing");
  for (const description of ["Scalable URL shortener for millions of users", "Real-time analytics event stream for clicks, high traffic", "Photo app that sends email notifications in the background", "Small internal todo app"]) {
    const files = generateInfra(designSystem({ description }), { stack: "go-nethttp" });
    await withFiles(files, async (dir) => {
      for (const f of ["infra/docker-compose.yml", "infra/k8s/app.yaml", "infra/k8s/data.yaml", "infra/monitoring/prometheus.yml", "infra/monitoring/alerts.yml", "infra/monitoring/grafana/provisioning/datasources/prometheus.yml", "infra/monitoring/grafana/provisioning/dashboards/sierra.yml", ".github/workflows/ci.yml"]) {
        const r = await runCommand("python3", ["-c", "'import yaml,sys;list(yaml.safe_load_all(open(sys.argv[1])))'", path.join(dir, f)], { cwd: dir, env: process.env });
        assert.equal(r.code, 0, `${description}: ${f}: ${r.stderr}`);
      }
    });
  }
});

test("docker compose config accepts the generated compose file", async (t) => {
  const probe = await runCommand("docker", ["compose", "version"], { cwd: os.tmpdir(), env: process.env, timeoutMs: 15000 });
  if (probe.code !== 0) return t.skip("docker compose not available");
  const files = generateInfra(designSystem({ description: "Real-time analytics event stream for clicks, high traffic" }), { stack: "go-nethttp" });
  await withFiles(files, async (dir) => {
    const r = await runCommand("docker", ["compose", "-f", "infra/docker-compose.yml", "config", "-q"], { cwd: dir, env: { ...process.env, JWT_SECRET: "x" }, timeoutMs: 30000 });
    assert.equal(r.code, 0, r.stderr);
  });
});

test("buildFlow survives cyclic or dangling edges (edited diagrams)", () => {
  const { buildFlow } = require("../src/design/designEngine");
  const nodes = [{ id: "c", type: "client", label: "C" }, { id: "a", type: "load-balancer", label: "A" }, { id: "b", type: "api-gateway", label: "B" }];
  const edges = [{ from: "c", to: "a" }, { from: "a", to: "b" }, { from: "b", to: "a" }, { from: "b", to: "ghost" }];
  assert.ok(Array.isArray(buildFlow(nodes, edges)));
});

test("zip writer output is a valid archive (verified with python zipfile)", async (t) => {
  if (!(await hasTool("python3"))) return t.skip("python3 missing");
  const { createZip } = require("../src/utils/zip");
  const files = { "a.txt": "hello", "dir/b.go": "package main\n", "ünï.md": "x".repeat(5000) };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sierra-zip-"));
  fs.writeFileSync(path.join(dir, "t.zip"), createZip(files));
  const code = "'import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(sorted(z.namelist()));assert z.read(\"dir/b.go\")==b\"package main\\n\"'";
  const r = await runCommand("python3", ["-c", code, path.join(dir, "t.zip")], { cwd: dir, env: process.env });
  assert.equal(r.code, 0, r.stderr);
  assert.throws(() => createZip({ "../evil": "x" }));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("k8s data manifests and monitoring follow the design and the stack", () => {
  const d = designSystem({ description: "Real-time analytics event stream for clicks, high traffic" });
  const files = generateInfra(d, { stack: "python-fastapi" });
  const data = files["infra/k8s/data.yaml"];
  assert.match(data, /kind: StatefulSet/);
  assert.match(data, /name: db\b/);
  assert.match(data, /volumeClaimTemplates/);
  assert.ok(!/password:\s*\S/i.test(data.replace(/secretKeyRef.*\n/g, "")), "no inline credentials");
  assert.match(files["infra/k8s/app.yaml"], /prometheus\.io\/scrape/);
  assert.match(files["infra/monitoring/prometheus.yml"], /metrics_path: \/metrics/);
  assert.match(files["infra/docker-compose.yml"], /prometheus:/);
  assert.match(files["infra/NOTES.md"], /Create these Secrets/);
  // the legacy Express generator has no /metrics, so no monitoring config is emitted for it
  const express = generateInfra(d, { stack: "node-express" });
  assert.ok(!("infra/monitoring/prometheus.yml" in express));
  assert.match(express["infra/NOTES.md"], /does not expose `\/metrics`/);
  assert.ok(!/prometheus/.test(express["infra/docker-compose.yml"]));
  // opt out
  assert.ok(!("infra/monitoring/prometheus.yml" in generateInfra(d, { stack: "go-nethttp", monitoring: false })));
});

test("alert rules and the Grafana dashboard only use metrics the stack really emits", () => {
  const d = designSystem({ description: "Real-time analytics event stream for clicks, high traffic" });
  const known = new Set(["up", "http_requests_total", "http_request_duration_seconds_sum"]);
  const metricNames = (text) => [...text.matchAll(/\b([a-z_]+)(?:\{|\[)/g)].map((m) => m[1]).filter((n) => /^(up|http_[a-z_]+)$/.test(n));
  const files = generateInfra(d, { stack: "python-fastapi" });
  const dash = JSON.parse(files["infra/monitoring/grafana/dashboards/service-overview.json"]);
  assert.ok(dash.panels.length >= 5 && dash.uid);
  const exprs = dash.panels.flatMap((p) => p.targets.map((t) => t.expr)).join("\n") + files["infra/monitoring/alerts.yml"];
  for (const n of metricNames(exprs)) assert.ok(known.has(n), `unknown metric ${n}`);
  assert.match(files["infra/monitoring/alerts.yml"], /alert: HighServerErrorRatio/);
  assert.match(files["infra/monitoring/prometheus.yml"], /rule_files:/);
  assert.match(files["infra/docker-compose.yml"], /127\.0\.0\.1:3001:3000/);
  // Spring Boot's Micrometer names differ: only the generic up alert and panel are generated
  const spring = generateInfra(d, { stack: "spring-boot" });
  assert.ok(!/HighServerErrorRatio/.test(spring["infra/monitoring/alerts.yml"]));
  assert.equal(JSON.parse(spring["infra/monitoring/grafana/dashboards/service-overview.json"]).panels.length, 1);
  // monitoring off => none of it
  const off = generateInfra(d, { stack: "python-fastapi", monitoring: false });
  assert.ok(!Object.keys(off).some((k) => k.includes("monitoring")));
});

// ---- real linters over generated infra (skipped checks are reported as skipped, never as passed) ----
const { validateInfra } = require("../src/design/infraValidate");
const { computeLevels } = require("../src/engine/levels");

test("generated infra passes the real linters that are installed; skipped tools are reported as skipped", (t) => {
  const d = designSystem({ description: "Real-time analytics event stream for clicks, high traffic" });
  const v = validateInfra(generateInfra(d, { stack: "python-fastapi" }));
  assert.notEqual(v.status, "failed", JSON.stringify(v.results.filter((r) => r.status === "failed")));
  assert.ok(v.results.length >= 5);
  assert.ok(v.results.every((r) => ["passed", "failed", "skipped"].includes(r.status)));
  assert.match(v.notes, /nothing was deployed/i);
  const real = v.results.filter((r) => r.status === "passed" && !/structural/.test(r.tool));
  if (!real.length) t.diagnostic("no external linters installed here; all real-tool checks were skipped");
  assert.equal(v.level, "STATICALLY_VALIDATED");
});

test("the infra validator actually catches broken files (negative controls)", (t) => {
  const bad = validateInfra({
    "Dockerfile": "FROM ubuntu:latest\nRUN apt-get install -y curl\nCMD python app.py\n",
    "docker-compose.yml": "services:\n  app:\n    image: x\n    ports: not-a-list\n",
    "k8s/app.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: app\nspec:\n  replicas: three\n",
    "monitoring/alerts.yml": "groups:\n  - name: a\n    rules:\n      - alert: X\n        labels: { severity: warning }\n",
    "monitoring/alertmanager.yml": "route:\n  receiver: nope\nreceivers:\n  - name: default\n",
  });
  assert.equal(bad.status, "failed");
  assert.equal(bad.level, "IMPLEMENTED");
  const failedChecks = bad.results.filter((r) => r.status === "failed").map((r) => r.check);
  // structural checks need only python+PyYAML; the others depend on installed tools
  assert.ok(failedChecks.includes("prometheus-rules-structure"), failedChecks.join());
  assert.ok(failedChecks.includes("alertmanager-config-structure"), failedChecks.join());
  for (const [check, tool] of [["dockerfile-lint", "hadolint"], ["compose-config", "docker compose config"], ["kubernetes-schema", "kubernetes-validate"]]) {
    const r = bad.results.find((x) => x.check === check);
    assert.ok(r, check);
    if (r.status === "skipped") t.diagnostic(`${tool} not installed: negative control for ${check} not exercised`);
    else assert.equal(r.status, "failed", check);
  }
});

test("verification levels are cumulative, failures cap the level, and skips are listed as blocked", () => {
  const ok = { status: "passed" };
  const none = computeLevels({ validation: ok, staticChecks: [], infra: { status: "passed", results: [] } });
  assert.equal(none.level, "INTEGRATION_TESTED");
  assert.ok(none.blocked.some((b) => b.step === "end-to-end"));
  assert.equal(computeLevels({ validation: { status: "skipped", reason: "no go" }, staticChecks: [] }).level, "STATICALLY_VALIDATED");
  assert.equal(computeLevels({ validation: { status: "skipped", reason: "no go" }, staticChecks: [] }).blocked[0].step, "test-suite");
  assert.equal(computeLevels({ validation: ok, staticChecks: [{ level: "fail" }] }).level, "IMPLEMENTED");
  assert.equal(computeLevels({ validation: ok, infra: { status: "failed", results: [] } }).level, "IMPLEMENTED");
  assert.deepEqual(computeLevels({ validation: { status: "failed" }, staticChecks: [] }).failed, ["test-suite"]);
  assert.equal(computeLevels({ validation: ok, smoke: { status: "passed" }, infra: { status: "passed", results: [] } }).level, "END_TO_END_VERIFIED");
});
