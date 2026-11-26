# Sierra 2.0 – System architecture

## Flow
requirement text -> `requirementAgent` (LLM or heuristic) -> optional `schemaAgent` (LLM entity schema, strictly validated) -> `ProjectSpec` (`src/engine/spec.js`) -> stack generator -> files -> pipeline (format, setup, build, test) -> report with verification levels.

## Engine
- **Stack registry** (`src/engine/index.js`): each stack is `{id, generate(spec), validate}`. Cross-cutting features are wrappers that patch the generated files: `withCi(withReadWriteSplit(withDistributed(withRateLimit(stack))))`. A stack that does not implement a requested feature (`cache`, `events`, `rateLimit`, `distributed`, `readWriteSplit`) rejects it with HTTP 400 rather than silently ignoring it.
- **Validation** (`validate.js`): runs the generated project's own toolchain. `requiresFor(spec)` lists real services (Redis, RabbitMQ, Postgres); if one is unreachable (TCP probe) the result is `SKIPPED` with `missingService`, never a pass.
- **Auto-fix** (`autofix.js`): validate -> take the failing step -> fixer proposes edits -> safe apply (existing files only, no path traversal, size/file limits) -> revalidate; edits that break an earlier phase are rolled back; `verified` only if the final validation passed.
- **Pipeline** (`pipeline.js`): orders phases, persists files, attaches the auto-fix and schema reports and `verifiedAt`.

## Generated-app runtime features
- **Distributed (Redis)**: atomic Lua fixed-window rate limit; `Idempotency-Key` (SET NX, states processing -> complete, per-caller scoping, request fingerprint, 5xx not cached); owner-token lock (SET NX PX + Lua compare-and-delete); in-process circuit breaker. Framework adapters: ASGI middleware (FastAPI), Flask hooks, Django middleware, Fastify hooks, Nest (Express middleware). Fail-open by default (`DISTRIBUTED_FAIL_OPEN`); disabled with a warning if `REDIS_URL` is unset.
- **Events**: Kafka or RabbitMQ publisher + worker; RabbitMQ with persistent messages, publisher confirms, ack after handling, bounded retry, dead-letter queue, reconnect.
- **Read/write split**: SQLAlchemy primary + optional replicas; list reads to replicas, by-id reads to primary; unhealthy replicas skipped for a cooldown; fallback to primary. Postgres streaming replication scripts for compose. Asynchronous replication, so replicas can lag, and there is no failover.

## Design engine and infra
`src/design/` returns a component graph with trade-offs/bottlenecks/failures; `POST /api/design/infra` emits Docker/Compose/Nginx/K8s/Prometheus/Grafana config (configuration only, nothing deployed). Diagrams are persisted per user with versions and a `baseVersion` conflict check (409); server SVG/JSON export.

## Frontend
React 19 + Vite. Auth context + `RequireAuth`, server sync (`lib/sync.js`), verification panel built only from the backend report.

## Not built
Microservices/modular-monolith generation, Go SQL repositories and Go Redis/broker features, MySQL replication, Redis features for Express/Gin/Fiber/Spring/.NET.
