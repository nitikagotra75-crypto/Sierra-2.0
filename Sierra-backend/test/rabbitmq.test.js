const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { registry, buildSpec } = require("../src/engine");
const { validateStack, hasTool, hostPort, probeTcp } = require("../src/engine/validate");
const { writeFiles } = require("../src/execution/executionManager");

const URL_ = process.env.SIERRA_TEST_AMQP_URL || "amqp://app:app@localhost:5673/";
const spec = () => buildSpec({ projectName: "Demo", analysis: { needsAuth: false, primaryEntities: [{ name: "Task", fields: [{ name: "title", type: "string", required: true }] }] }, options: { stack: "python-fastapi", features: { events: "rabbitmq" } } });

test("rabbitmq events: generated project ships real-broker tests and a RabbitMQ CI service", () => {
  const files = registry.generate(spec());
  assert.ok(files["tests/test_events_rabbitmq_real.py"]);
  assert.match(files["app/worker.py"], /class RabbitWorker/);
  assert.match(files[".github/workflows/ci.yml"], /rabbitmq:3\.13/);
  assert.match(files[".github/workflows/ci.yml"], /AMQP_URL/);
});

test("validation is SKIPPED (never verified) when RabbitMQ is unreachable", async (t) => {
  if (!(await hasTool("python3"))) return t.skip("python3 not installed");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sierra-rmq-skip-"));
  await writeFiles(dir, registry.generate(spec()));
  const res = await validateStack(registry.get("python-fastapi"), dir, { spec: spec(), env: { ...process.env, AMQP_URL: "amqp://app:app@127.0.0.1:1/" } });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(res.status, "skipped"); assert.equal(res.missingService, "RabbitMQ");
});

test("python-fastapi + rabbitmq: ack, retry, DLQ, reconnection and redelivery pass against a REAL RabbitMQ (none skipped)", async (t) => {
  if (!(await hasTool("python3"))) return t.skip("python3 not installed");
  const hp = hostPort(URL_);
  if (!(await probeTcp(hp.host, hp.port))) return t.skip(`RabbitMQ not reachable at ${URL_} (start one with scripts/start-test-brokers.sh)`);
  const s = spec();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sierra-rmq-"));
  await writeFiles(dir, registry.generate(s));
  const res = await validateStack(registry.get("python-fastapi"), dir, { spec: s, env: { ...process.env, AMQP_URL: URL_, NO_PROXY: "" } });
  fs.rmSync(dir, { recursive: true, force: true });
  const out = res.steps.at(-1) ? res.steps.at(-1).output : "";
  assert.equal(res.status, "passed", out);
  assert.doesNotMatch(out, /skipped/i, out);
});
