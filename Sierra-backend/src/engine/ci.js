/**
 * Adds a GitHub Actions workflow to every generated project so the verification Sierra cannot do in its own sandbox
 * (compilers, package registries, real databases and brokers) has a reproducible path: run in CI with service
 * containers, with the same commands Sierra's validator uses.
 *
 * Each service container is only added when the generated project actually uses it.
 */
const SETUP = {
  node: (v) => `      - uses: actions/setup-node@v4\n        with:\n          node-version: "${v || 22}"\n`,
  python3: () => `      - uses: actions/setup-python@v5\n        with:\n          python-version: "3.12"\n`,
  go: () => `      - uses: actions/setup-go@v5\n        with:\n          go-version: "1.24"\n`,
  mvn: () => `      - uses: actions/setup-java@v4\n        with:\n          distribution: temurin\n          java-version: "21"\n          cache: maven\n`,
  dotnet: () => `      - uses: actions/setup-dotnet@v4\n        with:\n          dotnet-version: "8.0.x"\n`,
};

const HEALTH = (cmd) => `        options: >-\n          --health-cmd "${cmd}"\n          --health-interval 5s\n          --health-timeout 5s\n          --health-retries 20\n`;

function servicesFor(stackId, spec) {
  const f = spec.features || {};
  const svc = [];
  const env = [];
  if (stackId === "node-express") {
    svc.push(`      mongo:\n        image: mongo:7\n        ports: ["27017:27017"]\n${HEALTH("mongosh --quiet --eval 'db.runCommand({ping:1}).ok' || exit 1")}`);
    env.push("MONGODB_URI: mongodb://127.0.0.1:27017/sierra_ci");
  }
  if (/^go-(nethttp|gin|fiber)$/.test(stackId) && spec.database === "postgresql") {
    svc.push(`      postgres:\n        image: postgres:16-alpine\n        ports: ["5432:5432"]\n        env:\n          POSTGRES_USER: app\n          POSTGRES_PASSWORD: app\n          POSTGRES_DB: app\n${HEALTH("pg_isready -U app -d app")}`);
    env.push("TEST_DATABASE_URL: postgres://app:app@127.0.0.1:5432/app?sslmode=disable");
  }
  if (/^go-(nethttp|gin|fiber)$/.test(stackId) && spec.database === "mysql") {
    svc.push(`      mysql:\n        image: mysql:8\n        ports: ["3306:3306"]\n        env:\n          MYSQL_ROOT_PASSWORD: app\n          MYSQL_DATABASE: app\n          MYSQL_USER: app\n          MYSQL_PASSWORD: app\n${HEALTH("mysqladmin ping -h 127.0.0.1 -uroot -papp")}`);
    env.push("TEST_DATABASE_URL: mysql://app:app@127.0.0.1:3306/app");
  }
  if (stackId === "python-fastapi" && spec.database === "mysql") {
    svc.push(`      mysql:\n        image: mysql:8\n        ports: ["3306:3306"]\n        env:\n          MYSQL_ROOT_PASSWORD: app\n          MYSQL_DATABASE: app\n          MYSQL_USER: app\n          MYSQL_PASSWORD: app\n${HEALTH("mysqladmin ping -h 127.0.0.1 -uroot -papp")}`);
    env.push("TEST_DB_URL: mysql+pymysql://app:app@127.0.0.1:3306/app");
  }
  if (f.cache || f.distributed) {
    svc.push(`      redis:\n        image: redis:7-alpine\n        ports: ["6379:6379"]\n${HEALTH("redis-cli ping")}`);
    env.push("REDIS_URL: redis://127.0.0.1:6379/0");
  }
  if (f.events === "rabbitmq") {
    svc.push(`      rabbitmq:\n        image: rabbitmq:3.13-management-alpine\n        ports: ["5672:5672"]\n${HEALTH("rabbitmq-diagnostics -q ping")}`);
    env.push("RABBITMQ_URL: amqp://guest:guest@127.0.0.1:5672/", "AMQP_URL: amqp://guest:guest@127.0.0.1:5672/");
  }
  if (f.events === "kafka") {
    svc.push(`      kafka:\n        image: apache/kafka:3.8.0\n        ports: ["9092:9092"]\n        env:\n          KAFKA_NODE_ID: 1\n          KAFKA_PROCESS_ROLES: broker,controller\n          KAFKA_LISTENERS: PLAINTEXT://:9092,CONTROLLER://:9093\n          KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://127.0.0.1:9092\n          KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER\n          KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT\n          KAFKA_CONTROLLER_QUORUM_VOTERS: 1@127.0.0.1:9093\n          KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1\n          KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: 1\n          KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: 1\n`);
    env.push("KAFKA_BOOTSTRAP_SERVERS: 127.0.0.1:9092");
  }
  return { svc, env };
}

function workflow(stack, spec) {
  const v = stack.validate;
  const { svc, env } = servicesFor(stack.id, spec);
  const cmds = [...(v.format || []).map((e) => (Array.isArray(e) ? e : e.cmd)), ...((v.setupFor ? v.setupFor(spec) : v.setup) || []), ...(v.build || []), ...((v.testFor ? v.testFor(spec) : v.test) || [])];
  const fmtCheck = (v.format || []).some((e) => !Array.isArray(e) && e.emptyOutput);
  const run = (c) => {
    const line = c.join(" ");
    if (fmtCheck && c[0] === "gofmt") return `      - name: gofmt (must list no files)\n        run: test -z "$(gofmt -l .)"\n`;
    return `      - run: ${line}\n`;
  };
  return `name: ci
on:
  push:
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
${svc.length ? `    services:\n${svc.join("")}` : ""}${env.length ? `    env:\n${env.map((e) => `      ${e}`).join("\n")}\n` : ""}    steps:
      - uses: actions/checkout@v4
${(SETUP[v.toolchain] || (() => ""))()}${cmds.map(run).join("")}
  docker:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Lint Dockerfile
        uses: hadolint/hadolint-action@v3.1.0
        with:
          dockerfile: Dockerfile
          failure-threshold: warning
      - name: Build image
        run: docker build -t ${spec.slug}:ci .
`;
}

const testCompose = (stackId, spec) => {
  if (stackId !== "node-express") return null;
  return `# Real MongoDB for the generated tests (no in-memory fake):
#   docker compose -f docker-compose.test.yml up -d --wait
#   MONGODB_URI=mongodb://127.0.0.1:27017/test npm test
#   docker compose -f docker-compose.test.yml down
services:
  mongo:
    image: mongo:7
    ports:
      - "127.0.0.1:27017:27017"
    healthcheck:
      test: ["CMD-SHELL", "mongosh --quiet --eval 'db.runCommand({ping:1}).ok' || exit 1"]
      interval: 5s
      timeout: 5s
      retries: 20
`;
};

function withCi(stack) {
  if (!stack.validate) return stack;
  const base = stack.generate;
  return {
    ...stack,
    generate(spec) {
      const files = base(spec);
      if (!files[".github/workflows/ci.yml"]) files[".github/workflows/ci.yml"] = workflow(stack, spec);
      const tc = testCompose(stack.id, spec);
      if (tc && !files["docker-compose.test.yml"]) files["docker-compose.test.yml"] = tc;
      if (files["README.md"] && !/## Continuous integration/.test(files["README.md"])) {
        files["README.md"] += `
## Continuous integration
\`.github/workflows/ci.yml\` runs the same format/build/test commands Sierra's validator uses${svc(stack, spec)}, plus a Dockerfile lint and image build. Sierra itself could not run this project's toolchain in its own environment unless its report says the test suite passed; CI is the reproducible way to verify it.
${stack.id === "node-express" ? "\nThe tests need a real MongoDB: `docker compose -f docker-compose.test.yml up -d --wait` then `MONGODB_URI=mongodb://127.0.0.1:27017/test npm test`.\n" : ""}`;
      }
      return files;
    },
  };
}

const svc = (stack, spec) => {
  const { svc: s } = servicesFor(stack.id, spec);
  return s.length ? ` against service containers (${s.map((x) => x.match(/^\s+(\w+):/)[1]).join(", ")})` : "";
};

module.exports = { withCi, workflow, servicesFor };
