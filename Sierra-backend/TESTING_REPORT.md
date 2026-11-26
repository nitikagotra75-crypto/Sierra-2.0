# Testing report (2026-11-17)

Backend `npm test` (full run, final code, with real Redis, RabbitMQ, Postgres primary+replica, MySQL primary+replica): **197 tests, 197 passed, 0 failed, 0 skipped**.
Frontend (last run): `npx eslint src` clean, `npm test` 22/22, `vite build` OK, Playwright E2E for auth/sync/conflict/restore/export passed.

## Real-dependency tests actually executed here
- redis-server 7.0.15: generated FastAPI, Flask, Django, Fastify and NestJS projects' own Redis suites (auth on and off) passed with none skipped. Mutation checks (removing idempotency mismatch, lock owner check, rate-limit blocking, hook registration) made the generated tests fail.
- RabbitMQ (private node): persistence, confirms, ack-after-handle, retry, DLQ, reconnect, redelivery (`test/rabbitmq.test.js`).
- PostgreSQL 16 primary + streaming replica: read routing, fallback to primary, recovery (`test/scaling.test.js`).
- Redis unreachable: generated suites SKIP with a reason and Sierra reports `skipped` + `missingService`, never verified.
- Bugs found and fixed by these tests: the Node Redis client treated pre-ready requests as "Redis down"; the Nest middleware dropped the response body when forwarding after storing the idempotent response.

- Go net/http + PostgreSQL and MySQL repositories (versioned migrations, FKs, CHECKs, owner isolation, error paths) against real servers: 7/7 in `test/gosql.test.js`. Mutation check: a List that swallowed errors survived a weak test, so it was replaced by a drop-the-table test.
- go-nethttp Redis features against a real Redis (distributed Go package tests + main wiring test).
- Microservices (node-fastify): every service's and the gateway's own tests pass, then the services and gateway run as processes and are driven through the gateway. Modular-monolith boundary check on 11 stacks (`test/modular.test.js`).
- Bugs found: parallel test packages/workers sharing one Redis DB (FLUSHDB collisions) -> per-file DB indexes; compose `$` escaping; python DB default overridden by registry order.

- Go RabbitMQ events against a real RabbitMQ: confirm/persist/consume, retry then success, poison message -> `<queue>.dlq` after MaxRetries (panicking handler), redelivery of an unacked message, dead broker never fails the publisher (`test/goevents.test.js`, 3 variants, 3 mutations caught).
- Go read/write splitting against a real Postgres primary + streaming replica AND a real MySQL 8 primary + binlog replica (`test/gosplit.test.js`): list served by the replica, by-id/writes on the primary, dead replica falls back and is skipped during the cooldown; 4 variants, 3 mutations caught.
- Express + Redis: core (8) and database-free HTTP tests against real Redis, both auth variants; the test that stores data needs MongoDB and was not run (`test/distributed-express.test.js`). A mutation (response never stored) is caught.
- Gin/Fiber + Redis: the shared Go package's tests against real Redis in generated Gin and Fiber projects (gofmt clean). The framework wiring is only statically asserted (`test/distributed-gofw.test.js`).
- Bugs found: `go build` failed for no-auth projects because the events patch forwarded the blank owner parameter `_`; a duplicate helper name between two generated test files; a stale services/ports state after pauses made tests skip (they reported SKIPPED, not passed).

- Microservices run end to end (every part's own tests, then services + gateway as processes, driven through the gateway, circuit breaker) on **node-fastify, python-fastapi and go-nethttp**; the last two with a real PostgreSQL database per service (`test/microservices.test.js`).
- FastAPI + MySQL: the whole generated suite (16 tests) on a real MySQL 8; with no `TEST_DB_URL` it is skipped, never run on SQLite and reported as MySQL (`test/fastapi-mysql.test.js`).
- Gin + PostgreSQL/MySQL/memory/distributed: compiled against a **real Gin** and the generated suite run on real databases (`test/goframeworks-sql.test.js`; 3 variants + a mutation that makes `NewWith` ignore the injected stores is caught). Caveat: the Gin is Debian's **1.8.1**, served under the label v1.10.0 by `scripts/build-go-proxy.py`; the pinned v1.10.0 itself was not run. Fiber: gofmt + wiring assertions + vet of the framework-free packages only.
- Bugs found in this round: `go mod tidy -e` turned an unreachable framework into a "failed" build instead of "skipped" (fixed: the build failure is linked back to the setup network error); stale assertions that expected Gin/Fiber/Express to reject features they now support.

## Not executed (and why)
Kafka (no binary/container reachable; CI only), MongoDB (Express data tests), Docker compose runs, Redis for Spring/.NET (rejected with HTTP 400; no toolchain to build them), Fiber SQL repositories compiled, Kafka for Go (rejected), the Fiber wiring of Redis/SQL (cannot be built here), replication failover/lag handling (not implemented), Fiber/Spring/.NET builds (registries blocked / no SDK; Gin built only against Debian's 1.8.1), real LLM calls (no API key), any GitHub Actions run, GitHub push (403).

## Reproduce
Start services: `scripts/start-test-brokers.sh`, `scripts/start-test-postgres.sh`, `scripts/start-test-mysql-replica.sh`, `redis-server`; then `npm test` · `node scripts/validate-stacks.js --strict`. CI: `.github/workflows/ci.yml`.
