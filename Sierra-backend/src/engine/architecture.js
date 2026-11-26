/**
 * Architecture modes. `monolith` is the default single project. `microservices` generates a SYSTEM:
 *   - one independently deployable service per entity, each produced by the chosen stack's own generator (so each one
 *     ships its own tests, Dockerfile and data store),
 *   - a zero-dependency API gateway (routing, circuit breaker, timeouts, request ids and - when auth is on - JWT
 *     authentication for the whole system; the services themselves run unauthenticated on the private compose network),
 *   - docker-compose with a database per service and the shared Redis/broker when those features are requested,
 *   - a root GitHub Actions workflow with one job per service plus the gateway.
 * Validation runs every service's own toolchain and the gateway's tests; the system is only "passed" if all of them
 * passed, and "skipped" (never passed) if any part could not run.
 */
const fs = require("fs");
const path = require("path");

const ARCHITECTURES = ["monolith", "modular", "microservices"];
const TPL = path.join(__dirname, "templates", "gateway");
const tpl = (rel) => fs.readFileSync(path.join(TPL, rel), "utf8");
// compose interpolates $: keep literal ones literal, but leave the ${NAME} references we add ourselves
const dollars = (s) => String(s).replace(/\$(?!\{[A-Z_]+\})/g, () => "$$");
const q = (s) => JSON.stringify(String(s));
const SECRET_KEY = /SECRET|PASSWORD|TOKEN|API_KEY|PRIVATE_KEY/i;

function httpError(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }

function parseEnv(text) {
  const out = {};
  for (const line of String(text || "").split("\n")) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// The database each service gets: an explicit choice wins; Python stacks default to a real Postgres per service.
function serviceDatabase(spec, stack) {
  if (spec.database) return spec.database;
  const dbs = stack.databases || [];
  return dbs.includes("postgresql") ? "postgresql" : dbs[0] || null;
}

function serviceSpecs(spec, stack) {
  if (spec.entities.length < 2) throw httpError("microservices needs at least 2 entities (one service per entity); use the monolith architecture for a single entity");
  return spec.entities.map((e) => ({
    entity: e,
    name: `${e.lower}-service`,
    dir: `services/${e.lower}`,
    spec: { ...spec, name: `${spec.name} ${e.name} service`, slug: `${spec.slug}-${e.lower}`, entities: [e], needsAuth: false, architecture: "monolith", database: serviceDatabase(spec, stack) },
  }));
}

const PG_URL = { "go-nethttp": (h, pw) => `postgres://app:${pw}@${h}:5432/app?sslmode=disable`, "python-fastapi": (h, pw) => `postgresql+psycopg2://app:${pw}@${h}:5432/app`, "python-flask": (h, pw) => `postgresql+psycopg2://app:${pw}@${h}:5432/app`, "python-django": (h, pw) => `postgresql://app:${pw}@${h}:5432/app` };
const SQLITE_VOL = {
  "node-fastify": { DATABASE_PATH: "/app/data/app.db" },
  nestjs: { DATABASE_PATH: "/app/data/app.db" },
  "aspnet-core": { ConnectionStrings__Default: "Data Source=/app/data/app.db" },
  "spring-boot": { DATABASE_URL: "jdbc:h2:file:/app/data/app;AUTO_SERVER=TRUE" },
};

// -> { env, services: [yaml blocks], volumes: [names], mounts: [], dependsOn: [], note }
function dataStore(stackId, database, svc) {
  const n = svc.entity.lower;
  const none = { env: {}, services: [], volumes: [], mounts: [], dependsOn: [], note: null };
  if (database === "postgresql" && PG_URL[stackId]) {
    return {
      ...none,
      env: { ...(stackId === "go-nethttp" ? { DATABASE_DRIVER: "postgres" } : {}), DATABASE_URL: PG_URL[stackId](`db-${n}`, "${DB_PASSWORD}") },
      volumes: [`${n}-pgdata`],
      dependsOn: [`db-${n}`],
      services: [`  db-${n}:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: \${DB_PASSWORD:?set DB_PASSWORD in .env}
      POSTGRES_DB: app
    volumes:
      - ${n}-pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d app"]
      interval: 5s
      timeout: 5s
      retries: 20
`],
      note: `PostgreSQL (db-${n})`,
    };
  }
  if (database === "mysql" && (stackId === "go-nethttp" || stackId === "python-fastapi")) {
    return {
      ...none,
      env: stackId === "go-nethttp" ? { DATABASE_DRIVER: "mysql", DATABASE_URL: `mysql://app:\${DB_PASSWORD}@db-${n}:3306/app` } : { DATABASE_URL: `mysql+pymysql://app:\${DB_PASSWORD}@db-${n}:3306/app?charset=utf8mb4` },
      volumes: [`${n}-mysql`],
      dependsOn: [`db-${n}`],
      services: [`  db-${n}:
    image: mysql:8
    restart: unless-stopped
    environment:
      MYSQL_ROOT_PASSWORD: \${DB_PASSWORD:?set DB_PASSWORD in .env}
      MYSQL_DATABASE: app
      MYSQL_USER: app
      MYSQL_PASSWORD: \${DB_PASSWORD}
    volumes:
      - ${n}-mysql:/var/lib/mysql
    healthcheck:
      test: ["CMD-SHELL", "mysqladmin ping -h 127.0.0.1 -uroot -p$$MYSQL_ROOT_PASSWORD"]
      interval: 5s
      timeout: 5s
      retries: 30
`],
      note: `MySQL (db-${n})`,
    };
  }
  if (database === "mongodb") {
    return {
      ...none,
      env: { MONGODB_URI: `mongodb://mongo-${n}:27017/app` },
      volumes: [`${n}-mongo`],
      dependsOn: [`mongo-${n}`],
      services: [`  mongo-${n}:
    image: mongo:7
    restart: unless-stopped
    volumes:
      - ${n}-mongo:/data/db
    healthcheck:
      test: ["CMD-SHELL", "mongosh --quiet --eval 'db.runCommand({ping:1}).ok' || exit 1"]
      interval: 5s
      timeout: 5s
      retries: 20
`],
      note: `MongoDB (mongo-${n})`,
    };
  }
  if ((database === "sqlite" || database === "h2") && SQLITE_VOL[stackId]) return { ...none, env: SQLITE_VOL[stackId], volumes: [`${n}-data`], mounts: [`${n}-data:/app/data`], note: `SQLite file on volume ${n}-data` };
  if (database === "sqlite" || database === "h2") return { ...none, note: "embedded database inside the container (NOT persisted: choose postgresql for a persistent database)" };
  if (database === "memory") return { ...none, note: "in-memory store (NOT persisted)" };
  return { ...none, note: database || "none" };
}

function sharedServices(spec) {
  const f = spec.features || {};
  const out = [];
  const env = {};
  if (f.cache || f.distributed) {
    out.push(`  redis:
    image: redis:7-alpine
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 20
`);
    env.REDIS_URL = "redis://redis:6379/0";
  }
  if (f.events === "rabbitmq") {
    out.push(`  rabbitmq:
    image: rabbitmq:3.13-management-alpine
    restart: unless-stopped
    environment:
      RABBITMQ_DEFAULT_USER: app
      RABBITMQ_DEFAULT_PASS: \${BROKER_PASSWORD:?set BROKER_PASSWORD in .env}
    healthcheck:
      test: ["CMD", "rabbitmq-diagnostics", "-q", "ping"]
      interval: 10s
      timeout: 10s
      retries: 20
`);
    env.RABBITMQ_URL = "amqp://app:${BROKER_PASSWORD}@rabbitmq:5672/";
    env.AMQP_URL = env.RABBITMQ_URL;
  }
  if (f.events === "kafka") {
    out.push(`  kafka:
    image: apache/kafka:3.8.0
    restart: unless-stopped
    environment:
      KAFKA_NODE_ID: 1
      KAFKA_PROCESS_ROLES: broker,controller
      KAFKA_LISTENERS: PLAINTEXT://:9092,CONTROLLER://:9093
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:9092
      KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT
      KAFKA_CONTROLLER_QUORUM_VOTERS: 1@kafka:9093
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: 1
`);
    env.KAFKA_BOOTSTRAP_SERVERS = "kafka:9092";
  }
  return { services: out, env, names: out.map((b) => /^ {2}(\S+):/.exec(b)[1]) };
}

function rootWorkflow(items, gateway) {
  const jobs = [];
  for (const it of items) {
    const m = /^jobs:\n {2}test:\n([\s\S]*?)(?=\n {2}docker:)/m.exec(it.ci);
    if (!m) throw new Error(`cannot derive a CI job for ${it.dir}: unexpected workflow layout`);
    jobs.push(`  test-${it.entity.lower}:\n    name: ${it.name}\n    defaults:\n      run:\n        working-directory: ${it.dir}\n${m[1].replace(/\s+$/, "")}\n`);
  }
  if (gateway) jobs.push(`  test-gateway:\n    name: gateway\n    runs-on: ubuntu-latest\n    defaults:\n      run:\n        working-directory: gateway\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: "22"\n      - run: npm test\n`);
  const dockerfiles = [...items.map((i) => `${i.dir}/Dockerfile`), "gateway/Dockerfile"];
  return `name: ci
on:
  push:
  pull_request:

jobs:
${jobs.join("\n")}
  docker:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        dockerfile:
${dockerfiles.map((d) => `          - ${d}`).join("\n")}
    steps:
      - uses: actions/checkout@v4
      - name: Lint Dockerfile
        uses: hadolint/hadolint-action@v3.1.0
        with:
          dockerfile: \${{ matrix.dockerfile }}
          failure-threshold: warning
      - name: Build image
        run: docker build -f \${{ matrix.dockerfile }} -t sierra-ci:test "$(dirname "\${{ matrix.dockerfile }}")"
`;
}

function generateMicroservices(spec, stack, generateOne) {
  const svcs = serviceSpecs(spec, stack);
  const files = {};
  const shared = sharedServices(spec);
  const secrets = new Set();
  const composeSvc = [];
  const volumes = new Set();
  const items = [];

  for (const s of svcs) {
    const sub = generateOne(s.spec);
    const df = sub["Dockerfile"] || "";
    const port = Number((/^EXPOSE (\d+)/m.exec(df) || [])[1] || 8000);
    const base = parseEnv(sub[".env.example"]);
    const ds = dataStore(stack.id, s.spec.database, s);
    const env = { ...base, ...ds.env };
    for (const k of Object.keys(shared.env)) if (k in base || (spec.features.events && /^(RABBITMQ_URL|AMQP_URL|KAFKA_BOOTSTRAP_SERVERS)$/.test(k)) || k === "REDIS_URL") env[k] = shared.env[k];
    const ci = sub[".github/workflows/ci.yml"];
    for (const [name, text] of Object.entries(sub)) {
      if (name.startsWith(".github/")) continue;
      files[`${s.dir}/${name}`] = text;
    }
    ds.volumes.forEach((v) => volumes.add(v));
    ds.services.forEach((y) => composeSvc.push(y));
    const envLines = Object.entries(env).map(([k, v]) => {
      if (SECRET_KEY.test(k) && !/\$\{/.test(v)) { const ref = `${k}_${s.entity.lower}`.toUpperCase(); secrets.add(ref); return `      ${k}: \${${ref}:?set ${ref} in .env}`; }
      return `      ${k}: ${q(dollars(v))}`;
    });
    const dep = [...ds.dependsOn.map((d) => `      ${d}:\n        condition: service_healthy`), ...shared.names.filter((n) => (n === "redis" && ("REDIS_URL" in env)) || (n !== "redis" && (n === "rabbitmq" ? "RABBITMQ_URL" in env : "KAFKA_BOOTSTRAP_SERVERS" in env))).map((d) => `      ${d}:\n        condition: service_healthy`)];
    composeSvc.push(`  ${s.name}:
    build: ./${s.dir}
    restart: unless-stopped
${envLines.length ? `    environment:\n${envLines.join("\n")}\n` : ""}${ds.mounts.length ? `    volumes:\n${ds.mounts.map((m) => `      - ${m}`).join("\n")}\n` : ""}${dep.length ? `    depends_on:\n${dep.join("\n")}\n` : ""}    expose:
      - "${port}"
`);
    items.push({ ...s, port, ci, store: ds.note });
  }

  // gateway
  const routes = { auth: !!spec.needsAuth, routes: items.map((i) => ({ name: i.entity.lower, prefix: `/api/${i.entity.plural}`, target: `http://${i.name}:${i.port}` })) };
  files["gateway/routes.json"] = JSON.stringify(routes, null, 2) + "\n";
  for (const f of ["server.js", "package.json", "Dockerfile", "src/app.js", "test/gateway.test.js"]) files[`gateway/${f}`] = tpl(f);
  if (!spec.needsAuth) files["gateway/Dockerfile"] = files["gateway/Dockerfile"].replace("RUN mkdir -p /app/data && chown -R node:node /app\n", "RUN chown -R node:node /app\n");
  files["gateway/.env.example"] = "PORT=8080\nUPSTREAM_TIMEOUT_MS=5000\nBREAKER_THRESHOLD=5\nBREAKER_RECOVERY_MS=10000\n" + (spec.needsAuth ? "GATEWAY_DB_PATH=./data/gateway.db\nJWT_TTL_SECONDS=3600\n" : "");

  const gwEnv = ["      PORT: \"8080\"", ...(spec.needsAuth ? ["      JWT_SECRET: ${JWT_SECRET:?set JWT_SECRET in .env (at least 32 characters)}", "      GATEWAY_DB_PATH: /app/data/gateway.db"] : [])];
  composeSvc.push(`  gateway:
    build: ./gateway
    restart: unless-stopped
    ports:
      - "\${GATEWAY_PORT:-8080}:8080"
    environment:
${gwEnv.join("\n")}
${spec.needsAuth ? "    volumes:\n      - gateway-data:/app/data\n" : ""}    depends_on:
${items.map((i) => `      ${i.name}:\n        condition: service_started`).join("\n")}
`);
  if (spec.needsAuth) volumes.add("gateway-data");

  files["docker-compose.yml"] = `# ${spec.name}: ${items.length} services behind one gateway. Only the gateway publishes a port.
# Copy .env.example to .env and fill in the values, then: docker compose up --build
services:
${[...shared.services, ...composeSvc].join("\n")}${volumes.size ? `\nvolumes:\n${[...volumes].map((v) => `  ${v}:`).join("\n")}\n` : ""}`;

  const needsDbPw = items.some((i) => /^(PostgreSQL|MySQL)/.test(i.store || ""));
  files[".env.example"] = [
    "# Copy to .env. Never commit real values.",
    "GATEWAY_PORT=8080",
    ...(spec.needsAuth ? ["JWT_SECRET=  # at least 32 random characters"] : []),
    ...(needsDbPw ? ["DB_PASSWORD=  # letters and digits only: it is used inside connection URLs"] : []),
    ...(spec.features.events === "rabbitmq" ? ["BROKER_PASSWORD="] : []),
    ...[...secrets].map((s) => `${s}=`),
  ].join("\n") + "\n";

  files[".github/workflows/ci.yml"] = rootWorkflow(items, true);
  files["ARCHITECTURE.md"] = `# ${spec.name} - microservices architecture

| Service | Path prefix at the gateway | Stack | Data store |
|---|---|---|---|
${items.map((i) => `| ${i.name} | \`/api/${i.entity.plural}\` | ${stack.label} | ${i.store} |`).join("\n")}
| gateway | \`/\` | Node.js (no dependencies) | ${spec.needsAuth ? "SQLite (users)" : "none"} |

\`\`\`
client -> gateway :8080 ${spec.needsAuth ? "(JWT check, X-User-Id)" : ""} -> ${items.map((i) => i.name).join(" | ")}
\`\`\`

## Decisions
- **Database per service**: no service reads another service's tables. Cross-entity references are plain ids; there are no foreign keys across services and no distributed transactions.
- **Gateway**: longest-prefix routing, ${spec.needsAuth ? "registration/login and JWT verification for every route (the services are not exposed and do not authenticate; they trust the gateway's \`X-User-Id\`)," : "no authentication (services are public through the gateway),"} per-upstream circuit breaker, upstream timeout (504), request ids, and \`GET /health/services\` aggregating service health.
- **Failure isolation**: one service down trips only its own circuit (503); the others keep serving.
${spec.features.events ? `- **Events**: each service publishes its own events to ${spec.features.events}; no service consumes another service's events yet.\n` : ""}${spec.features.distributed || spec.features.cache ? "- **Redis**: one shared Redis; keys are namespaced per feature, not per service.\n" : ""}
## Limitations
- The gateway is a single instance and the circuit state is per gateway process.
- No service discovery or service mesh: addresses are compose service names.
- No saga/outbox: there is no cross-service consistency mechanism.
- Sierra validated each service's own test suite and the gateway's tests; it did not run the whole compose stack unless its report says so.
`;
  files["README.md"] = `# ${spec.name}

Microservices generated by Sierra: ${items.map((i) => `\`${i.name}\``).join(", ")} behind one gateway. See ARCHITECTURE.md.

## Run
\`\`\`
cp .env.example .env   # fill in the values
docker compose up --build
curl localhost:8080/health/services
\`\`\`
${spec.needsAuth ? "\nRegister and log in through the gateway (`POST /api/auth/register`, `POST /api/auth/login`), then send `Authorization: Bearer <token>`.\n" : ""}
## Tests
- Each service: \`cd services/<name> && <that stack's test command>\` (see each service's README).
- Gateway: \`cd gateway && npm test\` (Node >= 22.13).
- CI: \`.github/workflows/ci.yml\` runs every service's job (with its service containers) and the gateway.

## Known limitations
See ARCHITECTURE.md.
`;
  return files;
}

// ---------------------------------------------------------------------------------------------------- validation
async function validateSystem(stack, root, { env, onStep, probe, spec }, validateStack) {
  const svcs = serviceSpecs(spec, stack);
  const parts = [{ label: "gateway", dir: path.join(root, "gateway"), stack: { validate: { toolchain: "node", test: [["npm", "test"]] } }, spec: null }];
  for (const s of svcs) parts.push({ label: s.dir, dir: path.join(root, s.dir), stack, spec: s.spec });
  const steps = [];
  const skipped = [];
  const results = [];
  for (const p of parts) {
    onStep && onStep(`validating ${p.label}`);
    const r = await validateStack(p.stack, p.dir, { env, onStep, probe, spec: p.spec });
    for (const st of r.steps || []) steps.push({ ...st, command: `[${p.label}] ${st.command}` });
    results.push({ part: p.label, status: r.status });
    if (r.status === "failed") return { status: "failed", failedPhase: r.failedPhase, failedPart: p.label, steps, parts: results };
    if (r.status === "skipped") skipped.push(`${p.label}: ${r.reason}`);
  }
  if (skipped.length) return { status: "skipped", reason: `not every part could be verified - ${skipped.join(" | ")}`, steps, parts: results };
  return { status: "passed", steps, parts: results };
}


// ------------------------------------------------------------------------------------------- modular monolith
// One deployable, but every entity is a module that owns its own files and data and does not import another module's
// internals. Sierra generates the modules, documents the ownership (MODULES.md) and checks the boundary statically on
// every generated file set (reported as the `module-boundaries` static check).
const tokens = (str) => String(str).replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

function ownerOf(file, entities) {
  const t = new Set(tokens(file));
  const hits = entities.filter((e) => t.has(e.lower) || t.has(e.snake));
  return hits.length === 1 ? hits[0] : null; // 0 = shared kernel, >1 = ambiguous: not attributed to a module
}

function moduleOwnership(files, spec) {
  const owned = Object.fromEntries(spec.entities.map((e) => [e.name, []]));
  const shared = [];
  for (const f of Object.keys(files)) {
    if (/^(test|tests|node_modules)\//.test(f) || /(^|\/)(test|tests|__tests__)\//.test(f) || /(_test\.go|\.test\.[jt]s|\.e2e\.ts|Tests?\.(java|cs)|test_[^/]*\.py)$/.test(f)) continue;
    const o = ownerOf(f, spec.entities);
    (o ? owned[o.name] : shared).push(f);
  }
  return { owned, shared };
}

const IMPORT_LINE = /^\s*(import|from|using|require|const .*= *require|use)\b|\brequire\(|\bimport\(/;

function checkModules(files, spec) {
  const violations = [];
  for (const [file, text] of Object.entries(files)) {
    const owner = ownerOf(file, spec.entities);
    if (!owner || !/\.(js|ts|py|go|java|cs)$/.test(file)) continue;
    String(text).split("\n").forEach((line, i) => {
      if (!IMPORT_LINE.test(line)) return;
      const t = new Set(tokens(line));
      for (const other of spec.entities) {
        if (other.name === owner.name) continue;
        if ((t.has(other.lower) || t.has(other.snake)) && !t.has(owner.lower) && !t.has(owner.snake)) violations.push(`${file}:${i + 1} (module ${owner.name}) imports module ${other.name}`);
      }
    });
  }
  return {
    check: "module-boundaries",
    level: violations.length ? "fail" : "pass",
    detail: violations.length ? `module boundary violations: ${violations.slice(0, 5).join("; ")}` : `${spec.entities.length} modules, no module imports another module's code`,
    violations,
  };
}

function applyModular(spec, stack, files) {
  if (spec.entities.length < 2) throw httpError("the modular architecture needs at least 2 entities (one module per entity); use the monolith architecture for a single entity");
  const { owned, shared } = moduleOwnership(files, spec);
  const missing = spec.entities.filter((e) => owned[e.name].length === 0).map((e) => e.name);
  if (missing.length) throw new Error(`modular: could not attribute any generated file to module(s) ${missing.join(", ")} for stack ${stack.id}`);
  const out = { ...files };
  out["MODULES.md"] = `# ${spec.name} - modular monolith

One deployable application; each entity is a module. A module owns its files and its data and must not import another module's code.

| Module | API | Files owned |
|---|---|---|
${spec.entities.map((e) => `| ${e.name} | \`/api/${e.plural}\` | ${owned[e.name].length} |`).join("\n")}

## Ownership
${spec.entities.map((e) => `### ${e.name}\n${owned[e.name].map((f) => `- \`${f}\``).join("\n")}`).join("\n\n")}

## Shared kernel (not owned by any module)
${shared.map((f) => `- \`${f}\``).join("\n") || "- (none)"}

## Rules
1. A module's source files do not import another module's source files. Cross-module references are by id only (no foreign keys across modules' tables), so a module can later be extracted into a service (see the microservices architecture).
2. Shared code lives in the shared kernel above (configuration, errors, database wiring, application assembly).
3. Sierra checks rule 1 statically on every generation (\`module-boundaries\` in the verification report). It is a static import check, not a runtime isolation guarantee: nothing stops a hand-written change from reaching across modules through shared code or the database.
`;
  if (out["README.md"]) out["README.md"] += "\n## Modules\nThis is a modular monolith; see MODULES.md for module ownership and the boundary rule.\n";
  return out;
}

module.exports = { checkModules, applyModular, moduleOwnership, ARCHITECTURES, generateMicroservices, validateSystem, serviceSpecs, httpError };
