/**
 * Generates infrastructure files from a design produced by designEngine.
 * Only components that exist in the design are emitted. Everything returned
 * is CONFIGURATION: nothing here starts or provisions anything, and the
 * generated NOTES file says exactly what is and is not covered.
 */
const APP_PORT = { "node-express": 4000, "python-fastapi": 8000, "python-flask": 8000, "python-django": 8000, "node-fastify": 3000, "go-nethttp": 8080 };
const TEST_CMD = {
  "node-express": { setup: "npm install", test: "npm test", runtime: "node", version: "20" },
  "python-fastapi": { setup: "pip install -r requirements.txt", test: "pytest -q", runtime: "python", version: "3.12" },
  "python-django": { setup: "pip install -r requirements.txt", test: "python manage.py test", runtime: "python", version: "3.12" },
  "node-fastify": { setup: "npm install", test: "npm test", runtime: "node", version: "22" },
  "python-flask": { setup: "pip install -r requirements.txt", test: "pytest -q", runtime: "python", version: "3.12" },
  "go-nethttp": { setup: "go version", test: "go vet ./... && go test ./...", runtime: "go", version: "1.24" },
};

// Stacks whose generated apps expose GET /metrics (the legacy Express generator does not).
const HAS_METRICS = new Set(["python-fastapi", "python-flask", "python-django", "node-fastify", "nestjs", "go-nethttp", "go-gin", "go-fiber", "spring-boot", "aspnet-core"]);
APP_PORT.nestjs = 3000;
TEST_CMD["go-gin"] = { setup: "go mod tidy", test: "go vet ./... && go test ./...", runtime: "go", version: "1.24" };
TEST_CMD["go-fiber"] = TEST_CMD["go-gin"];
TEST_CMD["spring-boot"] = { setup: "mvn -B -q -DskipTests test-compile", test: "mvn -B test", runtime: "java", version: "21" };
TEST_CMD["aspnet-core"] = { setup: "dotnet restore", test: "dotnet test", runtime: "dotnet", version: "8.0.x" };
TEST_CMD.nestjs = { setup: "npm install", test: "npm test", runtime: "node", version: "22" };

const byType = (design, t) => design.nodes.find((n) => n.type === t);

function dbService(db) {
  if (db === "mongodb") return { image: "mongo:7", port: 27017, health: `["CMD", "mongosh", "--quiet", "--eval", "db.adminCommand('ping')"]`, vol: "/data/db", env: "", url: "mongodb://db:27017/app" };
  if (db === "mysql") return { image: "mysql:8.4", port: 3306, health: `["CMD", "mysqladmin", "ping", "-h", "localhost", "-uroot", "-papp"]`, vol: "/var/lib/mysql", env: "      MYSQL_ROOT_PASSWORD: app\n      MYSQL_DATABASE: app\n", url: "mysql://root:app@db:3306/app" };
  return { image: "postgres:16-alpine", port: 5432, health: `["CMD-SHELL", "pg_isready -U app"]`, vol: "/var/lib/postgresql/data", env: "      POSTGRES_USER: app\n      POSTGRES_PASSWORD: app\n      POSTGRES_DB: app\n", url: "postgresql://app:app@db:5432/app" };
}

function compose(design, stack, monitoring) {
  const port = APP_PORT[stack] || 8080;
  const app = byType(design, "app-server");
  const db = byType(design, "database");
  const d = dbService(db.config.engine);
  const lb = byType(design, "load-balancer");
  const cache = byType(design, "cache");
  const q = byType(design, "message-broker");
  const vols = ["dbdata"];
  let y = `services:\n`;
  if (lb) y += `  nginx:\n    image: nginx:1.27-alpine\n    ports:\n      - "8080:80"\n    volumes:\n      - ./nginx.conf:/etc/nginx/nginx.conf:ro\n    depends_on:\n      - app\n`;
  y += `  app:\n    build: ..\n${lb ? "" : `    ports:\n      - "8080:${port}"\n`}    deploy:\n      replicas: ${app.config.instances}\n    environment:\n      PORT: "${port}"\n      DATABASE_URL: \${DATABASE_URL:-${d.url}}\n      JWT_SECRET: \${JWT_SECRET:?set JWT_SECRET}\n${cache ? "      REDIS_URL: redis://cache:6379\n" : ""}${q ? (q.label.includes("Kafka") ? "      KAFKA_BROKERS: kafka:9092\n" : "      AMQP_URL: amqp://app:app@rabbitmq:5672\n") : ""}    depends_on:\n      db:\n        condition: service_healthy\n    healthcheck:\n      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:${port}/health || exit 1"]\n      interval: 10s\n      timeout: 3s\n      retries: 5\n    stop_grace_period: ${app.config.gracefulShutdownSec}s\n`;
  y += `  db:\n    image: ${d.image}\n${d.env ? `    environment:\n${d.env}` : ""}    volumes:\n      - dbdata:${d.vol}\n    healthcheck:\n      test: ${d.health}\n      interval: 5s\n      timeout: 3s\n      retries: 10\n`;
  if (cache) y += `  cache:\n    image: redis:7-alpine\n    command: ["redis-server", "/usr/local/etc/redis/redis.conf"]\n    volumes:\n      - ./redis.conf:/usr/local/etc/redis/redis.conf:ro\n    healthcheck:\n      test: ["CMD", "redis-cli", "ping"]\n      interval: 5s\n      timeout: 3s\n      retries: 10\n`;
  if (q && q.label.includes("Kafka")) y += `  kafka:\n    image: apache/kafka:3.8.0\n    environment:\n      KAFKA_NODE_ID: 1\n      KAFKA_PROCESS_ROLES: broker,controller\n      KAFKA_LISTENERS: PLAINTEXT://:9092,CONTROLLER://:9093\n      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:9092\n      KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER\n      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT\n      KAFKA_CONTROLLER_QUORUM_VOTERS: 1@kafka:9093\n      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1\n`;
  if (q && q.label.includes("Rabbit")) y += `  rabbitmq:\n    image: rabbitmq:3.13-management-alpine\n    environment:\n      RABBITMQ_DEFAULT_USER: app\n      RABBITMQ_DEFAULT_PASS: app\n    healthcheck:\n      test: ["CMD", "rabbitmq-diagnostics", "-q", "ping"]\n      interval: 10s\n      timeout: 5s\n      retries: 10\n`;
  if (monitoring) y += `  prometheus:\n    image: prom/prometheus:v2.54.1\n    profiles: ["monitoring"]   # docker compose --profile monitoring up\n    ports:\n      - "9090:9090"\n    volumes:\n      - ./monitoring/prometheus.yml:/etc/prometheus/prometheus.yml:ro\n      - ./monitoring/alerts.yml:/etc/prometheus/alerts.yml:ro\n    depends_on:\n      - app\n  alertmanager:\n    image: prom/alertmanager:v0.27.0\n    profiles: ["monitoring"]\n    ports:\n      - "127.0.0.1:9093:9093"\n    volumes:\n      - ./monitoring/alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro\n  grafana:\n    image: grafana/grafana:11.2.0\n    profiles: ["monitoring"]\n    ports:\n      - "127.0.0.1:3001:3000"   # local only; put it behind your own auth before exposing it\n    environment:\n      GF_SECURITY_ADMIN_PASSWORD: \${GRAFANA_ADMIN_PASSWORD:-admin}   # set GRAFANA_ADMIN_PASSWORD; the default is only safe on localhost\n    volumes:\n      - ./monitoring/grafana/provisioning:/etc/grafana/provisioning:ro\n      - ./monitoring/grafana/dashboards:/var/lib/grafana/dashboards:ro\n    depends_on:\n      - prometheus\n`;
  y += `volumes:\n${vols.map((v) => `  ${v}:`).join("\n")}\n`;
  return y;
}

function nginx(design, stack) {
  const port = APP_PORT[stack] || 8080;
  return `events { worker_connections 1024; }
http {
  # Docker DNS returns every replica of "app"; nginx re-resolves so scaled replicas are picked up.
  resolver 127.0.0.11 valid=10s;
  upstream app_pool {
    zone app_pool 64k;
    server app:${port} resolve max_fails=3 fail_timeout=10s;
  }
  limit_req_zone $binary_remote_addr zone=perip:10m rate=20r/s;
  server {
    listen 80;
    location /health { proxy_pass http://app_pool; }
    location / {
      limit_req zone=perip burst=40 nodelay;
      proxy_pass http://app_pool;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_next_upstream error timeout http_502 http_503;
      proxy_connect_timeout 2s;
      proxy_read_timeout 15s;
    }
  }
}
`;
}

function redisConf(design) {
  const c = byType(design, "cache").config;
  return `# ${c.pattern}; invalidation: ${c.invalidation}. TTLs (${c.ttlSeconds}s) are set by the application when writing keys.
maxmemory 256mb
maxmemory-policy ${c.eviction}
appendonly no
`;
}

function k8s(design, stack, monitoring) {
  const port = APP_PORT[stack] || 8080;
  const app = byType(design, "app-server");
  const cache = byType(design, "cache");
  const min = Math.max(app.config.instances, 2), max = min * 4;
  const q = byType(design, "message-broker");
  const kafka = q && q.label.includes("Kafka");
  let y = `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: app-config\ndata:\n  PORT: "${port}"\n${cache ? '  REDIS_URL: "redis://cache:6379"\n' : ""}${kafka ? '  KAFKA_BROKERS: "kafka:9092"\n' : ""}---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
spec:
  replicas: ${min}
  selector:
    matchLabels: { app: app }
  strategy:
    rollingUpdate: { maxUnavailable: 0, maxSurge: 1 }
  template:
    metadata:
      labels: { app: app }${monitoring ? `
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/path: /metrics
        prometheus.io/port: "${port}"` : ""}
    spec:
      terminationGracePeriodSeconds: ${app.config.gracefulShutdownSec + 5}
      containers:
        - name: app
          image: REGISTRY/app:TAG   # replace with your pushed image
          ports:
            - containerPort: ${port}
          envFrom:
            - configMapRef: { name: app-config }
            - secretRef: { name: app-secrets }   # create it yourself: DATABASE_URL, JWT_SECRET
          readinessProbe:
            httpGet: { path: /health, port: ${port} }
            periodSeconds: 5
          livenessProbe:
            httpGet: { path: /health, port: ${port} }
            initialDelaySeconds: 10
            periodSeconds: 10
          resources:
            requests: { cpu: 100m, memory: 128Mi }
            limits: { cpu: 500m, memory: 512Mi }
---
apiVersion: v1
kind: Service
metadata:
  name: app
  labels: { app: app }
spec:
  selector: { app: app }
  ports:
    - name: http
      port: 80
      targetPort: ${port}
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: app
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: app }
  minReplicas: ${min}
  maxReplicas: ${max}
  metrics:
    - type: Resource
      resource: { name: cpu, target: { type: Utilization, averageUtilization: 70 } }
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: app
spec:
  rules:
    - http:
        paths:
          - path: /
            pathType: Prefix
            backend: { service: { name: app, port: { number: 80 } } }
`;
  if (cache) y += `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cache
spec:
  replicas: 1
  selector:
    matchLabels: { app: cache }
  template:
    metadata:
      labels: { app: cache }
    spec:
      containers:
        - name: redis
          image: redis:7-alpine
          args: ["--maxmemory", "256mb", "--maxmemory-policy", "${cache.config.eviction}"]
          ports:
            - containerPort: 6379
---
apiVersion: v1
kind: Service
metadata:
  name: cache
spec:
  selector: { app: cache }
  ports:
    - port: 6379
`;
  return y;
}

// Stateful backing services as single-replica StatefulSets with persistent volumes. Credentials come from
// Secrets you create (see NOTES.md); nothing secret is written here. Single replica = no HA: use a managed
// service or an operator for production.
function k8sData(design) {
  const db = byType(design, "database");
  const q = byType(design, "message-broker");
  const eng = db.config.engine;
  const d = {
    mongodb: { image: "mongo:7", port: 27017, mount: "/data/db", env: "", probe: `["mongosh", "--quiet", "--eval", "db.adminCommand('ping')"]` },
    mysql: { image: "mysql:8.4", port: 3306, mount: "/var/lib/mysql", env: `            - { name: MYSQL_ROOT_PASSWORD, valueFrom: { secretKeyRef: { name: db-secrets, key: password } } }\n            - { name: MYSQL_DATABASE, value: app }\n`, probe: `["sh", "-c", "mysqladmin ping -h localhost -uroot -p$MYSQL_ROOT_PASSWORD"]` },
  }[eng] || { image: "postgres:16-alpine", port: 5432, mount: "/var/lib/postgresql/data", env: `            - { name: POSTGRES_USER, value: app }\n            - { name: POSTGRES_PASSWORD, valueFrom: { secretKeyRef: { name: db-secrets, key: password } } }\n            - { name: POSTGRES_DB, value: app }\n            - { name: PGDATA, value: /var/lib/postgresql/data/pgdata }\n`, probe: `["pg_isready", "-U", "app"]` };
  const sts = (name, image, port, mount, env, probe, size, extra = "") => `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: ${name}
spec:
  serviceName: ${name}
  replicas: 1
  selector:
    matchLabels: { app: ${name} }
  template:
    metadata:
      labels: { app: ${name} }
    spec:
      containers:
        - name: ${name}
          image: ${image}
${extra}          ports:
            - containerPort: ${port}
${env ? `          env:\n${env}` : ""}          readinessProbe:
            exec: { command: ${probe} }
            initialDelaySeconds: 10
            periodSeconds: 10
          volumeMounts:
            - { name: data, mountPath: ${mount} }
          resources:
            requests: { cpu: 100m, memory: 256Mi }
            limits: { memory: 1Gi }
  volumeClaimTemplates:
    - metadata: { name: data }
      spec:
        accessModes: ["ReadWriteOnce"]
        resources: { requests: { storage: ${size} } }
---
apiVersion: v1
kind: Service
metadata:
  name: ${name}
spec:
  clusterIP: None
  selector: { app: ${name} }
  ports:
    - port: ${port}
`;
  // The app reaches the database through the Service named "db".
  let y = sts("db", d.image, d.port, d.mount, d.env, d.probe, "10Gi");
  if (q && q.label.includes("Kafka")) {
    const env = ["KAFKA_NODE_ID: \"1\"", "KAFKA_PROCESS_ROLES: broker,controller", "KAFKA_LISTENERS: PLAINTEXT://:9092,CONTROLLER://:9093", "KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:9092", "KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER", "KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT", "KAFKA_CONTROLLER_QUORUM_VOTERS: 1@kafka:9093", "KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: \"1\""]
      .map((l) => { const [k, v] = l.split(": "); return `            - { name: ${k}, value: ${JSON.stringify(v.replace(/^"|"$/g, ""))} }\n`; }).join("");
    y += "---\n" + sts("kafka", "apache/kafka:3.8.0", 9092, "/var/lib/kafka/data", env, `["sh", "-c", "/opt/kafka/bin/kafka-broker-api-versions.sh --bootstrap-server localhost:9092 > /dev/null"]`, "10Gi");
  }
  if (q && q.label.includes("Rabbit")) {
    const env = `            - { name: RABBITMQ_DEFAULT_USER, value: app }\n            - { name: RABBITMQ_DEFAULT_PASS, valueFrom: { secretKeyRef: { name: rabbitmq-secrets, key: password } } }\n`;
    y += "---\n" + sts("rabbitmq", "rabbitmq:3.13-management-alpine", 5672, "/var/lib/rabbitmq", env, `["rabbitmq-diagnostics", "-q", "ping"]`, "5Gi");
  }
  return y;
}

function prometheusConf(stack) {
  return `# Scrapes the app's GET /metrics. Counters are per process; with several replicas Prometheus scrapes each one.
global:
  scrape_interval: 15s
rule_files:
  - /etc/prometheus/alerts.yml
alerting:
  alertmanagers:
    - static_configs:
        - targets: ["alertmanager:9093"]
scrape_configs:
  - job_name: app
    metrics_path: /metrics
    dns_sd_configs:
      - names: ["app"]          # Docker DNS returns every replica
        type: A
        port: ${APP_PORT[stack] || 8080}
`;
}

// Stacks whose /metrics uses Sierra's http_requests_total / http_request_duration_seconds_sum families.
// Spring Boot (Micrometer) and ASP.NET Core expose different names, so only the generic `up` alert applies there.
const SIERRA_METRICS = new Set(["python-fastapi", "python-flask", "python-django", "node-fastify", "nestjs", "go-nethttp", "go-gin", "go-fiber"]);

function alertList(stack) {
  const a = [{ alert: "AppDown", expr: 'up{job="app"} == 0', for: "2m", severity: "critical", summary: "App instance {{ $labels.instance }} is not being scraped" }];
  if (SIERRA_METRICS.has(stack)) {
    a.push(
      { alert: "HighServerErrorRatio", expr: 'sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m])) > 0.05', for: "5m", severity: "warning", summary: "More than 5% of requests failed with 5xx over 5 minutes" },
      { alert: "HighAverageLatency", expr: "sum(rate(http_request_duration_seconds_sum[5m])) / sum(rate(http_requests_total[5m])) > 0.5", for: "10m", severity: "warning", summary: "Average request latency above 500 ms for 10 minutes" },
      { alert: "ManyRateLimitedRequests", expr: 'sum(rate(http_requests_total{status="429"}[5m])) > 5', for: "5m", severity: "info", summary: "Clients are being rate limited (429) at more than 5 req/s" },
    );
  }
  return a;
}

const ruleYaml = (r, ind) => `${ind}- alert: ${r.alert}
${ind}  expr: ${r.expr}
${ind}  for: ${r.for}
${ind}  labels: { severity: ${r.severity} }
${ind}  annotations:
${ind}    summary: "${r.summary}"
`;

function alertRules(stack) {
  let y = "groups:\n  - name: app\n    rules:\n" + alertList(stack).map((r) => ruleYaml(r, "      ")).join("");
  if (!SIERRA_METRICS.has(stack)) y += "# Request-level alerts are omitted: this stack's /metrics does not use the http_requests_total family.\n";
  return y;
}

// Resource alerts use cAdvisor / kube-state-metrics series, which exist only when the cluster runs kube-prometheus-stack
// (or equivalent). They are generated for Kubernetes only and cannot fire in the compose setup.
const K8S_RESOURCE_ALERTS = [
  { alert: "PodHighMemory", expr: 'max by (pod) (container_memory_working_set_bytes{pod=~"app-.*", container!=""}) / max by (pod) (kube_pod_container_resource_limits{pod=~"app-.*", resource="memory"}) > 0.9', for: "10m", severity: "warning", summary: "Pod {{ $labels.pod }} is using more than 90% of its memory limit" },
  { alert: "PodCrashLooping", expr: 'increase(kube_pod_container_status_restarts_total{pod=~"app-.*"}[15m]) > 3', for: "0m", severity: "critical", summary: "Pod {{ $labels.pod }} restarted more than 3 times in 15 minutes" },
];

function alertmanagerConf() {
  return `# Alertmanager routes alerts evaluated by Prometheus. No receiver with a notification integration is configured, so
# alerts are grouped and visible in the Alertmanager UI (http://localhost:9093) but nobody is paged or emailed.
# Add a receiver below (email_configs, slack_configs, webhook_configs, ...) and keep its credentials out of git:
# Alertmanager does not expand environment variables; use *_file options (e.g. url_file, api_url_file, auth_password_file).
route:
  receiver: default
  group_by: [alertname]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  routes:
    - matchers: ['severity="critical"']
      receiver: default
      repeat_interval: 1h
receivers:
  - name: default
inhibit_rules:
  - source_matchers: ['severity="critical"']
    target_matchers: ['severity="warning"']
    equal: [alertname]
`;
}

function k8sMonitoring(stack, port) {
  const rules = [...alertList(stack), ...K8S_RESOURCE_ALERTS];
  return `# Requires the Prometheus Operator CRDs (e.g. kube-prometheus-stack). These are custom resources: they are NOT covered by
# kubernetes-validate; check the rules with promtool in CI (see NOTES.md). The "release" label (not set here) may need to match your Prometheus
# ruleSelector/serviceMonitorSelector (kube-prometheus-stack defaults to release: <helm release name>).
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: app-alerts
  labels:
    app: app
spec:
  groups:
    - name: app
      rules:
${rules.map((r) => ruleYaml(r, "        ")).join("")}---
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: app
  labels:
    app: app
spec:
  selector:
    matchLabels:
      app: app
  endpoints:
    - port: http
      path: /metrics
      interval: 15s
`;
}

function grafanaFiles(stack) {
  const ds = `apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
`;
  const prov = `apiVersion: 1
providers:
  - name: sierra
    type: file
    options:
      path: /var/lib/grafana/dashboards
`;
  const panel = (id, title, expr, x, y, unit) => ({
    id, type: "timeseries", title, gridPos: { x, y, w: 12, h: 8 },
    datasource: { type: "prometheus", uid: "${DS_PROMETHEUS}" }, fieldConfig: { defaults: { unit: unit || "short" }, overrides: [] },
    targets: [{ refId: "A", expr, legendFormat: "{{route}}", datasource: { type: "prometheus", uid: "${DS_PROMETHEUS}" } }],
  });
  const panels = [panel(1, "Instances up", 'up{job="app"}', 0, 0)];
  if (SIERRA_METRICS.has(stack)) {
    panels.push(
      panel(2, "Requests per second by route", "sum by (route) (rate(http_requests_total[5m]))", 12, 0, "reqps"),
      panel(3, "5xx ratio", 'sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))', 0, 8, "percentunit"),
      panel(4, "Average latency", "sum(rate(http_request_duration_seconds_sum[5m])) / sum(rate(http_requests_total[5m]))", 12, 8, "s"),
      panel(5, "Rate-limited requests (429) per second", 'sum(rate(http_requests_total{status="429"}[5m]))', 0, 16, "reqps"),
    );
  }
  const dash = { title: "Service overview", uid: "sierra-overview", schemaVersion: 39, version: 1, refresh: "30s", time: { from: "now-1h", to: "now" }, panels,
    templating: { list: [{ name: "DS_PROMETHEUS", type: "datasource", query: "prometheus", label: "Datasource" }] } };
  return {
    "infra/monitoring/grafana/provisioning/datasources/prometheus.yml": ds,
    "infra/monitoring/grafana/provisioning/dashboards/sierra.yml": prov,
    "infra/monitoring/grafana/dashboards/service-overview.json": JSON.stringify(dash, null, 2) + "\n",
  };
}

function ciWorkflow(stack) {
  const c = TEST_CMD[stack] || TEST_CMD["node-express"];
  const setup = { node: `      - uses: actions/setup-node@v4\n        with: { node-version: "${c.version}" }\n`, python: `      - uses: actions/setup-python@v5\n        with: { python-version: "${c.version}" }\n`, go: `      - uses: actions/setup-go@v5\n        with: { go-version: "${c.version}" }\n`, java: `      - uses: actions/setup-java@v4\n        with: { distribution: temurin, java-version: "${c.version}" }\n`, dotnet: `      - uses: actions/setup-dotnet@v4\n        with: { dotnet-version: "${c.version}" }\n` }[c.runtime];
  return `name: ci
on:
  push: { branches: [main] }
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
${setup}      - run: ${c.setup}
      - run: ${c.test}
  docker:
    runs-on: ubuntu-latest
    needs: test
    steps:
      - uses: actions/checkout@v4
      - run: docker build -t app:\${{ github.sha }} .
`;
}

function notes(design, stack, monitoring) {
  const present = new Set(design.nodes.map((n) => n.type));
  const lines = [
    "# Infrastructure notes", "",
    "These files are **configuration only**. Nothing has been started, deployed or load-tested by Sierra.", "",
    "## Covered by the generated files",
    "- `docker-compose.yml`: app (" + byType(design, "app-server").config.instances + " replica(s)), database" + (present.has("load-balancer") ? ", nginx load balancer" : "") + (present.has("cache") ? ", Redis" : "") + (present.has("message-broker") ? ", " + byType(design, "message-broker").label : "") + ".",
    "- `k8s/app.yaml`: Deployment, Service, HPA, Ingress, probes, resource limits" + (present.has("cache") ? ", single-pod Redis" : "") + ".",
    "- `k8s/data.yaml`: single-replica StatefulSets with persistent volumes for the database" + (present.has("message-broker") ? " and " + byType(design, "message-broker").label : "") + ". Credentials come from Secrets you create (below).",
    ...(monitoring ? ["- `monitoring/prometheus.yml` + a `prometheus` compose service (profile `monitoring`) that scrapes `GET /metrics`; pods carry `prometheus.io/*` scrape annotations.", "- `monitoring/alerts.yml` (Prometheus alert rules) and a provisioned Grafana dashboard + datasource (`grafana` compose service, same profile, bound to localhost). `monitoring/alertmanager.yml` + an `alertmanager` compose service route the alerts, but no notification receiver is configured, so nothing is paged or emailed until you add one. `k8s/monitoring.yaml` holds a PrometheusRule (including pod memory/restart alerts that need kube-prometheus-stack metrics) and a ServiceMonitor; it needs the Prometheus Operator CRDs and was only validated structurally, never applied to a cluster."] : []),
    "- `.github/workflows/ci.yml`: test + docker build.", "",
    "## In the design but NOT provisioned by these files",
  ];
  if (present.has("read-replica")) lines.push("- **Read replicas / replication**: use a managed database or an operator (e.g. CloudNativePG) rather than hand-rolled compose replication. Application read/write splitting is not generated.");
  if (present.has("message-broker")) lines.push("- **Producers/consumers & worker service**: the broker is configured, but only the python-fastapi generator can emit producer/worker code (events feature, tested with fakes, not a live broker); other stacks have none.");
  if (present.has("api-gateway")) lines.push("- **API gateway / microservice split**: generated backends are a single deployable; services are not split.");
  lines.push(
    "- **HA data tier**: `k8s/data.yaml` is single-replica with no backups, failover or tuning. Use a managed service or an operator for production.",
    monitoring
      ? "- **Monitoring**: apps expose per-process request counters at `/metrics` (count and total duration by method/route/status; no histograms). No Grafana dashboards or alert rules are generated, and Prometheus is not installed in the cluster by these files."
      : `- **Monitoring**: the \`${stack}\` generator does not expose \`/metrics\`, so no Prometheus config was generated.`, "- **Redis/cache usage in app code**: Redis is provisioned and `REDIS_URL` injected, but only the python-fastapi generator can emit cache code, and only when the project was generated with the cache feature enabled.", "- **Secrets**: `JWT_SECRET` must be supplied by you; none are generated or committed.");
  lines.push("", "## Create these Secrets before applying `k8s/` (placeholders, choose your own values)", "```", "kubectl create secret generic app-secrets --from-literal=JWT_SECRET=<random> --from-literal=DATABASE_URL=<connection string to the db service>" + (present.has("message-broker") && byType(design, "message-broker").label.includes("Rabbit") ? " --from-literal=AMQP_URL=amqp://app:<password>@rabbitmq:5672" : ""), "kubectl create secret generic db-secrets --from-literal=password=<password>" + (present.has("message-broker") && byType(design, "message-broker").label.includes("Rabbit") ? "\nkubectl create secret generic rabbitmq-secrets --from-literal=password=<password>" : ""), "```");
  return lines.join("\n") + "\n";
}

function architectureDoc(design, name = "This system") {
  const L = [`# ${name}: Architecture`, "", design.summary, "", "## Components and why they exist"];
  for (const n of design.nodes) {
    L.push(`### ${n.label}`, n.rationale, "");
    if (n.tradeoffs.length) L.push("Trade-offs:", ...n.tradeoffs.map((t) => `- ${t}`), "");
  }
  L.push("## Components deliberately NOT included", ...design.skipped.map((s) => `- **${s.component}**: ${s.reason}`), "", "## Request flow", ...design.requestFlow, "", "## Consistency", ...design.consistency.map((c) => `- ${c}`), "", "## Potential bottlenecks", ...design.bottlenecks.map((b) => `- ${b}`), "", "## Failure scenarios", ...design.failureScenarios.map((f) => `- **${f.scenario}**: ${f.effect} Mitigation: ${f.mitigation}`), "", "## Scaling strategy", ...design.scalingStrategies.map((s) => `- ${s}`), "", "## Cost and complexity", design.costComplexity, "", "## Backup and recovery", design.backupRecovery, "");
  return L.join("\n");
}

function generateInfra(design, { stack = "node-express", name, monitoring } = {}) {
  monitoring = (monitoring ?? true) && HAS_METRICS.has(stack);
  if (!design || !Array.isArray(design.nodes) || !byType(design, "app-server") || !byType(design, "database")) {
    const e = new Error("design must contain an app-server and a database node");
    e.statusCode = 400;
    throw e;
  }
  const files = {
    "infra/docker-compose.yml": compose(design, stack, monitoring),
    "infra/k8s/app.yaml": k8s(design, stack, monitoring),
    "infra/k8s/data.yaml": k8sData(design),
    "infra/NOTES.md": notes(design, stack, monitoring),
    ".github/workflows/ci.yml": ciWorkflow(stack),
    "docs/ARCHITECTURE.md": architectureDoc(design, name),
  };
  if (byType(design, "load-balancer")) files["infra/nginx.conf"] = nginx(design, stack);
  if (monitoring) {
    files["infra/monitoring/prometheus.yml"] = prometheusConf(stack);
    files["infra/monitoring/alerts.yml"] = alertRules(stack);
    files["infra/monitoring/alertmanager.yml"] = alertmanagerConf();
    files["infra/k8s/monitoring.yaml"] = k8sMonitoring(stack);
    Object.assign(files, grafanaFiles(stack));
  }
  if (byType(design, "cache")) files["infra/redis.conf"] = redisConf(design);
  return files;
}

module.exports = { generateInfra, architectureDoc };
