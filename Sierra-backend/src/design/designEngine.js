/**
 * System design engine. Deterministic and rule-based: the same requirements
 * always yield the same architecture, and every optional component carries
 * the reason it was selected plus the trade-off it introduces. Nothing is on
 * by default except client, application tier and a primary database.
 *
 * (An LLM can later propose `options`; this module stays the source of truth
 * for which components are justified.)
 */
const DB_LABEL = { postgresql: "PostgreSQL", mongodb: "MongoDB", mysql: "MySQL" };

function extractSignals(description = "", options = {}) {
  const t = description.toLowerCase();
  const has = (re) => re.test(t);
  const scaleWords = has(/million|billion|high[- ]traffic|massive|scalab|viral|global/);
  const rps = Number.isFinite(options.expectedRps) ? options.expectedRps : scaleWords ? 5000 : 50;
  const readHeavy = options.readWriteRatio != null ? options.readWriteRatio >= 5 : has(/shorten|url short|feed|catalog|read[- ]heavy|cdn|lookup|browse|blog|news/);
  return {
    rps,
    readHeavy,
    strongConsistency: options.consistency ? options.consistency === "strong" : has(/payment|bank|ledger|inventory|booking|transaction|order|checkout|wallet/),
    events: has(/event|stream|kafka|real[- ]?time|analytics|click|telemetry|audit log|log ingest/),
    jobs: has(/email|notification|background|job|queue|report|video|image process|thumbnail|webhook|schedule/),
    microservices: has(/micro-?service/),
    documentModel: has(/document|flexible schema|json|cms|catalog of varying/),
    lowLatency: options.latencyMs != null ? options.latencyMs <= 100 : has(/low[- ]latency|real[- ]?time|fast|sub-?second/),
    highAvailability: has(/high availability|99\.9|zero downtime|fault[- ]tolerant|resilien/),
    budget: options.budget || "moderate", // low | moderate | high
  };
}

function chooseDatabase(sig, options) {
  if (options.database) return { db: options.database, why: `Chosen explicitly by the user (${DB_LABEL[options.database] || options.database}).` };
  if (sig.strongConsistency) return { db: "postgresql", why: "Requirements involve money/stock/bookings, so ACID transactions and strong consistency outweigh schema flexibility." };
  if (sig.documentModel) return { db: "mongodb", why: "Requirements describe flexible, document-shaped data; a document store avoids rigid migrations." };
  return { db: "postgresql", why: "Default relational choice: mature, strong consistency, rich indexing, and enough headroom for most workloads before sharding is a concern." };
}

function designSystem({ description, options = {} }) {
  if (!description || typeof description !== "string" || description.trim().length < 10) {
    const e = new Error("description must be at least a sentence");
    e.statusCode = 400;
    throw e;
  }
  const sig = extractSignals(description, options);
  const nodes = [];
  const edges = [];
  const add = (n) => (nodes.push(n), n);
  const link = (from, to, label, protocol) => edges.push({ id: `${from}->${to}`, from, to, label, protocol });
  const decisions = [];
  const skipped = [];

  const { db, why: dbWhy } = chooseDatabase(sig, options);
  const scaleOut = sig.rps >= 500 || sig.highAvailability;
  const instances = !scaleOut ? 1 : sig.rps >= 5000 ? 4 : 2;

  add({ id: "client", type: "client", label: "Client applications", config: {}, rationale: "Web/mobile consumers of the API.", tradeoffs: [] });

  if (scaleOut) {
    add({ id: "lb", type: "load-balancer", label: "Load balancer (Nginx)", config: { algorithm: "round_robin", healthCheck: "/health" },
      rationale: `Expected ~${sig.rps} req/s${sig.highAvailability ? " with an availability requirement" : ""}; a single instance is both a throughput ceiling and a single point of failure.`,
      tradeoffs: ["Adds a network hop (~1 ms) and one more component to operate", "Must itself be made redundant (2+ nodes or a managed LB) to remove the SPOF it replaces"] });
    link("client", "lb", "HTTPS", "https");
  }
  if (sig.microservices) {
    add({ id: "gateway", type: "api-gateway", label: "API gateway", config: { authAtEdge: true, rateLimit: "100 req/min/client" },
      rationale: "Microservices were requested; a gateway gives one public entry point, central auth and rate limiting.",
      tradeoffs: ["Single choke point for latency and failure", "Another deployable that every team depends on"] });
    link(scaleOut ? "lb" : "client", "gateway", "HTTP", "http");
  }
  add({ id: "app", type: "app-server", label: `Application servers ×${instances}`, config: { instances, stateless: true, gracefulShutdownSec: 10, healthEndpoint: "/health" },
    rationale: instances > 1 ? "Stateless instances behind the balancer scale horizontally; sessions use signed tokens, not server memory." : "Traffic is low enough that one instance is sufficient; it is still stateless so scaling out later needs no redesign.",
    tradeoffs: instances > 1 ? ["Requires statelessness: no in-process sessions or local file storage", "Cross-instance coordination (locks, idempotency) must live in shared stores"] : ["Single instance = downtime on deploy/crash until you scale out"] });
  link(sig.microservices ? "gateway" : scaleOut ? "lb" : "client", "app", "HTTP", "http");

  add({ id: "db", type: "database", label: `${DB_LABEL[db] || db} (primary)`, config: { engine: db, poolSize: Math.max(10, instances * 10), indexes: ["primary keys", "foreign keys", "columns used in WHERE/ORDER BY"] },
    rationale: dbWhy, tradeoffs: db === "mongodb" ? ["Weaker cross-document transactions", "Joins are application-side"] : ["Vertical scaling limit; horizontal write scaling needs sharding/partitioning"] });
  link("app", "db", "SQL/driver (pooled)", "tcp");

  // Cache
  const cacheJustified = sig.readHeavy && (sig.rps >= 1000 || sig.lowLatency);
  if (cacheJustified) {
    const pattern = sig.strongConsistency ? "cache-aside (short TTL)" : "cache-aside";
    add({ id: "cache", type: "cache", label: "Redis cache", config: { pattern, ttlSeconds: sig.strongConsistency ? 30 : 3600, eviction: "allkeys-lru", invalidation: "delete key on write" },
      rationale: `Read-heavy workload at ~${sig.rps} req/s${sig.lowLatency ? " with a low-latency goal" : ""}; serving hot keys from memory protects the database and cuts latency.`,
      tradeoffs: ["Stale reads until TTL expiry or invalidation (eventual consistency)", "Cache stampede risk on cold start or mass expiry", "Another stateful component to run and size"] });
    link("app", "cache", "GET/SET", "redis");
  } else skipped.push({ component: "Redis cache", reason: sig.readHeavy ? `Traffic (~${sig.rps} req/s) is within what the database serves directly; a cache would add staleness for no measurable gain.` : "Workload is not read-heavy, so cache hit rates would be low." });

  // Read replicas
  const replicasJustified = sig.readHeavy && sig.rps >= 2000 && db !== "mongodb";
  if (replicasJustified) {
    const n = sig.rps >= 20000 ? 3 : 1;
    add({ id: "replica", type: "read-replica", label: `Read replica ×${n}`, config: { count: n, replication: "asynchronous streaming", routing: "reads -> replica, writes -> primary" },
      rationale: "Read volume exceeds what one primary should serve; replicas scale reads and double as failover candidates.",
      tradeoffs: ["Replication lag: a read right after a write may miss it (read-your-writes needs routing to primary)", "Replicas do not scale writes"] });
    link("db", "replica", "replication", "tcp");
    link("app", "replica", "reads", "tcp");
  } else skipped.push({ component: "Read replicas", reason: "Read load does not yet justify the replication lag and extra cost." });

  // Messaging
  if (sig.events || sig.jobs) {
    const kafka = sig.events && (sig.rps >= 1000 || /kafka|stream|analytics/.test(description.toLowerCase()));
    const broker = kafka ? "kafka" : "rabbitmq";
    add({ id: "queue", type: "message-broker", label: kafka ? "Apache Kafka" : "RabbitMQ", config: kafka
        ? { topics: ["domain-events"], partitions: 3, retention: "7d", consumerGroup: "workers", retry: "retry topic + dead-letter topic" }
        : { queues: ["jobs", "jobs.retry", "jobs.dlq"], prefetch: 10, retry: "TTL retry queue, then dead-letter queue" },
      rationale: kafka ? "High-volume event stream/analytics: Kafka's partitioned, replayable log fits fan-out to multiple consumers."
        : "Background work (emails, notifications, processing) should not block requests; a work queue with retries and a DLQ is the simplest fit.",
      tradeoffs: kafka ? ["Heavy to operate (brokers, partitions, offsets)", "At-least-once delivery means consumers must be idempotent", "Overkill below ~1k events/s"] : ["No replay of consumed messages", "Throughput ceiling lower than Kafka"] });
    link("app", "queue", "publish", broker);
    add({ id: "worker", type: "worker", label: "Background workers", config: { concurrency: 4, idempotent: true },
      rationale: "Consumers process messages out of band and can scale independently of the API.", tradeoffs: ["Eventual consistency between request and effect", "Needs idempotency keys / dedupe"] });
    link("queue", "worker", "consume", broker);
    link("worker", "db", "SQL/driver", "tcp");
  } else skipped.push({ component: "Message broker", reason: "No asynchronous or event-driven requirement detected; synchronous request/response is simpler and easier to debug." });

  const tradeoffSummary = [];
  if (sig.strongConsistency) tradeoffSummary.push("CAP: chose consistency over availability for money/stock-like data; during a partition writes may be rejected rather than diverge.");
  else tradeoffSummary.push("CAP: partition tolerance is assumed; for this data a brief inconsistency is acceptable, so availability is favoured (cache/replicas may serve slightly stale data).");

  const bottlenecks = [];
  bottlenecks.push(db === "mongodb" ? "Primary node write throughput; shard key choice becomes critical beyond a single replica set." : "Primary database write throughput and connection count (pool × instances must stay below the DB connection limit).");
  if (cacheJustified) bottlenecks.push("Cache hit ratio: a low ratio sends full load back to the database.");
  if (scaleOut) bottlenecks.push("Load balancer capacity if it is not itself redundant.");
  if (sig.events) bottlenecks.push("Consumer lag: slow consumers let the backlog grow without bound.");

  const failures = [
    { scenario: "An app instance crashes", effect: instances > 1 ? "LB health checks remove it; traffic shifts to survivors." : "Full outage until restart (single instance).", mitigation: instances > 1 ? "Keep >=2 instances; graceful shutdown drains in-flight requests." : "Scale to >=2 instances." },
    { scenario: "Primary database is down", effect: "Writes fail; reads fail unless served by cache/replica.", mitigation: "Automated failover (managed DB or Patroni), tested backups, point-in-time recovery." },
  ];
  if (cacheJustified) failures.push({ scenario: "Redis is unavailable", effect: "Requests fall through to the database; latency and DB load spike.", mitigation: "Treat cache as optional (fail open), add timeouts and circuit breaker, request coalescing against stampedes." });
  if (sig.events || sig.jobs) failures.push({ scenario: "Consumer fails repeatedly on a message", effect: "Message would block or loop.", mitigation: "Bounded retries with backoff, then dead-letter queue for inspection." });

  const scaling = [`Scale the stateless app tier horizontally (currently ×${instances}).`];
  if (sig.rps >= 20000) scaling.push("Beyond ~20k req/s: partition data (hash-shard by primary key) so no single primary owns all writes.");
  scaling.push("Vertical scaling of the database first (cheapest); add replicas/cache before sharding.");

  const cost = sig.budget === "low" && nodes.length > 4 ? "Budget is low but the design has many moving parts; consider dropping the broker/replicas until measurements justify them." : `${nodes.length} components; every optional one above the minimum (client, app, db) was added only for a stated reason.`;

  return {
    summary: `${nodes.length}-component architecture for ~${sig.rps} req/s on ${DB_LABEL[db] || db}.`,
    requirements: { ...sig },
    nodes, edges,
    skipped,
    requestFlow: edges.length ? buildFlow(nodes, edges) : [],
    consistency: tradeoffSummary,
    bottlenecks, failureScenarios: failures, scalingStrategies: scaling,
    costComplexity: cost,
    backupRecovery: "Nightly full backup + continuous WAL/oplog archiving; restore drill at least quarterly. Backups are only trusted once restored successfully.",
  };
}

function buildFlow(nodes, edges) {
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const start = (nodes.find((n) => n.type === "client") || nodes[0] || {}).id;
  if (!start) return [];
  const out = [start]; let cur = start;
  const seen = new Set(out);
  const next = (id) => edges.find((e) => e.from === id && byId[e.to] && ["load-balancer", "api-gateway", "app-server"].includes(byId[e.to].type));
  while (byId[cur] && byId[cur].type !== "app-server") {
    const e = next(cur);
    if (!e || seen.has(e.to)) break;
    out.push(e.to); seen.add(e.to); cur = e.to;
  }
  const steps = out.map((id, i) => `${i + 1}. ${byId[id].label}`);
  const first = (t) => nodes.find((n) => n.type === t);
  const hasCache = first("cache"), hasReplica = first("read-replica");
  steps.push(`${steps.length + 1}. ${hasCache ? "Redis lookup; on miss query " + (hasReplica ? "read replica (writes go to primary)" : "database") + " and populate cache" : hasReplica ? "Reads -> read replica, writes -> primary" : "Query/update the primary database"}`);
  if (first("message-broker")) steps.push(`${steps.length + 1}. Publish event/job to ${first("message-broker").label}; workers consume asynchronously`);
  return steps;
}

module.exports = { designSystem, extractSignals, buildFlow };
