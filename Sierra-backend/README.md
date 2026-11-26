# Sierra Backend

REST API for **Sierra**, an AI-assisted backend builder. It takes a user's prompt, asks an LLM (Gemini API) to generate backend code, stores the project in MongoDB, and can build and run the generated project in an isolated Docker container.

Frontend repo: https://github.com/nitikagotra75-crypto/Sierra-frontend

## Features

- Generate backend project files from a natural-language prompt using Claude
- Save and retrieve projects with MongoDB (Mongoose)
- Build a Docker image from generated files and run it on a free port
- CORS-enabled REST API consumed by the React frontend
- `run_demo.js` to test the pipeline without the UI

## Tech Stack

| Purpose | Package |
|---|---|
| Server | Node.js, Express 4 |
| AI | `@anthropic-ai/sdk` |
| Database | `mongoose` (`mongodb-memory-server` for dev/testing) |
| Containers | `dockerode`, `tar-fs`, `get-port` |
| Utilities | `cors`, `dotenv`, `uuid` |

## Project Structure

```
Sierra-backend/
├── src/            # Server entry (index.js), routes, services, models
├── run_demo.js     # Demo script for the generate -> run flow
├── package.json
└── .gitignore
```

## How It Works

```
Request -> Express route -> Claude generates files -> Save in MongoDB
        -> (on Run) tar files -> Docker build -> start container on free port -> return URL
```

1. **Receive prompt:** the frontend sends a JSON request.
2. **Generate:** the backend calls the Gemini API and parses the returned files.
3. **Store:** the project is saved with a `uuid` id in MongoDB.
4. **Run:** files are packed with `tar-fs`, built into an image with `dockerode`, and started on a port found by `get-port`.
5. **Respond:** the API returns project data, status, and the running container's port/URL.

## Getting Started

### Prerequisites
- Node.js 18+
- Docker running locally
- MongoDB (local or Atlas)
- Gemini API key (aistudio.google.com/apikey)

### Install
```bash
git clone https://github.com/nitikagotra75-crypto/Sierra-backend.git
cd Sierra-backend
npm install
```

### Environment variables
Create a `.env` file:
```env
PORT=5000
MONGODB_URI=mongodb://localhost:27017/sierra
GEMINI_API_KEY=your_api_key
SIERRA_LLM_MODEL=your_gemini_model_name
GROQ_API_KEY=your_groq_key   # optional fallback
GROQ_MODEL=llama-3.3-70b-versatile
CLIENT_URL=http://localhost:5173
```

### Run
```bash
npm run dev     # or: npm start
```
Server starts at `http://localhost:5000`.

### Demo
```bash
node run_demo.js
```

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/projects/generate` | Generate project code from a prompt |
| GET | `/api/projects` | List projects |
| GET | `/api/projects/:id` | Get a project and its files |
| PUT | `/api/projects/:id` | Update project files |
| POST | `/api/projects/:id/run` | Build and run in Docker |
| POST | `/api/projects/:id/stop` | Stop the container |

Example:
```bash
curl -X POST http://localhost:5000/api/projects/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Todo API with CRUD and MongoDB"}'
```

## Connecting With the Frontend

- The frontend calls this API using the URL in its `VITE_API_URL`.
- `CLIENT_URL` here must match the frontend origin so CORS allows the requests.
- Both must be running at the same time (backend 5000, frontend 5173 by default).

## Security Notes

- Never commit `.env` or API keys.
- Run generated code in Docker with CPU/memory limits; never expose the Docker socket publicly.
- Restrict CORS to your real frontend domain in production.

## Scripts

| Script | Description |
|---|---|
| `npm start` | Start the server |
| `npm run dev` | Start the server (dev) |

## Author

Nitika Gotra - [@nitikagotra75-crypto](https://github.com/nitikagotra75-crypto)

## Sierra 2.0 (in progress)

- **Multi-stack engine** (`src/engine/`): Express, FastAPI, Flask, Django, Fastify, NestJS and Go net/http generate real projects plus Gin, Fiber, Spring Boot and ASP.NET Core. **Gin, Fiber, Spring Boot and ASP.NET Core are generated but could not be compiled or run in Sierra's own build environment** (Go module proxy and Maven Central are blocked there, no .NET SDK); validation reports them as `skipped`, never `VERIFIED`, unless the toolchain and network are available on your machine; other frameworks are listed as `planned` and return HTTP 501. `GET /api/projects/stacks` lists them.
- **System design engine** (`src/design/`): `POST /api/design {description, options}` returns a component graph with the rationale, trade-offs, bottlenecks and failure scenarios for each component. Optional components (cache, replicas, broker, gateway) are added only when the requirements justify them.
- **Infra generation**: `POST /api/design/infra {design, stack}` returns docker-compose, nginx, Redis, Kubernetes (app + single-replica StatefulSets for the DB/broker), Prometheus scrape config (only for stacks that expose `/metrics`), CI and `ARCHITECTURE.md` files. These are configuration only; `infra/NOTES.md` lists what is not provisioned.
- **Rate limiting** (`features.rateLimit`): opt-in per-IP fixed-window limiter (429 + `Retry-After`, `RATE_LIMIT_PER_MINUTE`) for FastAPI, Flask, Django, Fastify, NestJS and Go net/http, tested by each generated project's own suite. In-memory and per process; `X-Forwarded-For` is not trusted.
- **Monitoring files**: infra output includes Prometheus alert rules and a provisioned Grafana dashboard (nothing is deployed, and there is no Alertmanager).
- **Generated-app features**: every implemented stack except legacy Express serves `/health`, `/openapi.json` and a per-process Prometheus-text `/metrics`. python-fastapi can optionally add a Redis cache and Kafka/RabbitMQ events + worker (RabbitMQ tested against a real broker; Kafka only with fakes).
- **Honest status**: `VERIFIED` means the generated project's own test suite ran and passed. A missing toolchain gives `NOT_VERIFIED`, never a pass.
- Tests: `npm test` (needs Go and Python 3 for the full run; missing toolchains are skipped).
- **Distributed features** (`features.distributed`, FastAPI/Flask/Django/Fastify/NestJS): Redis rate limit, `Idempotency-Key`, locks and a circuit breaker, tested against a real Redis. **Read/write splitting** (`features.readWriteSplit`, FastAPI + Postgres) tested against a real primary and streaming replica (async replication, no failover).
- **Auto-fix** and **LLM schema design** are available in the pipeline (`fixer`, `schemaAsk` options) and were tested with injected clients, not a live LLM.
- See `IMPLEMENTATION_STATUS.md` (what is verified vs not), `SYSTEM_ARCHITECTURE.md` and `TESTING_REPORT.md`.
- **Architectures**: `architecture: "microservices"` (one service per entity, needs 2+ entities, Node gateway with JWT auth and per-upstream circuit breakers, compose with a DB per service, per-service CI jobs; verified end to end on node-fastify only) and `"modular-monolith"` (per-entity modules, `MODULES.md`, static `module-boundaries` check). Docker compose itself was not run here.
- **Go net/http** supports PostgreSQL and MySQL (database/sql, versioned migrations; tested against real servers), `features.distributed` (Redis, real Redis), `features.events="rabbitmq"` (publisher + `cmd/worker` consumer with retry and DLQ; tested against a real RabbitMQ; Kafka is rejected) and `features.readWriteSplit` (list reads on replicas with fallback; tested against a real Postgres and a real MySQL replica; Sierra generates the routing, you operate the replication). `go mod tidy` generates go.sum on first build.
- **Redis features** (`features.distributed`) are available for FastAPI, Flask, Django, Fastify, NestJS, Express, Go net/http, Gin and Fiber. Express: core and database-free HTTP tests ran against real Redis, the test that stores data needs MongoDB. Gin/Fiber: the shared Go package was tested against real Redis; the framework wiring is only statically validated (the frameworks cannot be built in Sierra's sandbox). Spring Boot and ASP.NET Core still reject it with HTTP 400.
- **Gin/Fiber** support PostgreSQL and MySQL. Gin was compiled and tested here against a real Gin (Debian's 1.8.1, not the pinned 1.10.0) and real databases; Fiber is statically validated only. **FastAPI** supports MySQL (whole suite tested on a real MySQL 8). Microservices were run end to end on node-fastify, python-fastapi and go-nethttp.
- Not available: Kafka for Go, Redis for Spring/.NET, read/write splitting for FastAPI + MySQL. CI-only (never run in Sierra's sandbox): Kafka against a real broker, Gin/Fiber/Spring/.NET builds, GitHub Actions, Docker compose, real LLM calls.

## What is offered by default
A default install offers only what Sierra could verify (generate, compile and run its own tests):

| Stack | Verified here |
|---|---|
| Python FastAPI / Flask / Django | tests run, SQLite; FastAPI also PostgreSQL and MySQL on real servers |
| Node Fastify / NestJS | tests run |
| Node Express (MERN) | generated; its tests need MongoDB, which Sierra's sandbox lacks, so they run in the generated CI workflow |
| Go net/http | tests run on real PostgreSQL / MySQL / Redis / RabbitMQ |
| Go Gin | compiled and tested against a real Gin (1.8.1 in Sierra's sandbox; CI resolves the pinned release) |

Opt-in with `SIERRA_EXPERIMENTAL=1` (generated and statically checked, but never built or run by Sierra): **Go Fiber, Spring Boot, ASP.NET Core** and **Kafka events**. Without the flag they are not listed and Kafka is refused with a clear 400.
Not available at all: Redis for Spring/.NET, read/write splitting for FastAPI + MySQL.


## Quick start (Windows / macOS / Linux)
```
cp .env.example .env      # Windows: copy .env.example .env   then edit it
npm install
npm run doctor            # checks Node, npm registry, .env, Python/Go, MongoDB
npm start                 # http://localhost:5001
```
If `npm install` ever fails with `ETARGET` (a lagging npm mirror), run `npm install --before=<a date ~2 weeks ago>`.
Express projects need a real MongoDB (`MONGODB_URI`) to reach VERIFIED; without it they are NOT_VERIFIED with the files still generated.
