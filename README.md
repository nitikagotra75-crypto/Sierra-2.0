Sierra 2.0 — Backend

Sierra turns a plain-English requirement into a working backend project in the stack you pick, then runs that project's own tests and tells you honestly whether it passed.

Example requirement: Library API: books (title, author, isbn), members, loans. Members can register and log in. Result: a downloadable project with models, routes, validation and tests, plus a verification report.

Frontend repo: https://github.com/nitikagotra75-crypto/Sierra-frontend

What it does
Reads your requirement and works out the entities and typed fields (books (title, author, isbn) becomes a Book with those three fields). An LLM designs the schema if you configure a key; otherwise fields are read straight from the requirement text.
Generates the project for the chosen stack, from reviewed templates (Express, FastAPI, Fastify, NestJS, Django, Flask, Go net/http, Gin).
Only what you asked for. Login/JWT is generated only if the requirement mentions it. Dockerfile, docker-compose and the GitHub Actions workflow are generated only if you ask for them.
Verifies it: formats, builds and runs the generated project's own tests with the real toolchain.
Reports honestly: VERIFIED only when the tests ran and passed. A missing toolchain or service gives NOT_VERIFIED with the reason, never a fake pass. Generated files stay downloadable either way.
Stacks
Stack	Language	Databases	Needs on your machine to reach VERIFIED
node-express (MERN)	Node.js	MongoDB	Node, a running MongoDB (MONGODB_URI)
node-fastify	Node.js	SQLite	Node
nestjs	TypeScript	SQLite	Node
python-fastapi	Python	SQLite, PostgreSQL, MySQL	Python 3
python-django	Python	SQLite, PostgreSQL	Python 3
python-flask	Python	SQLite, PostgreSQL	Python 3
go-nethttp	Go	in-memory, PostgreSQL, MySQL	Go 1.24+, internet for modules
go-gin	Go	in-memory, PostgreSQL, MySQL	Go 1.24+, internet for modules

Optional features (opt-in per project): Redis (rate limit, idempotency keys, locks, circuit breaker), RabbitMQ events (Go), read/write splitting (Go + PostgreSQL/MySQL), microservices architecture (node-fastify, python-fastapi, go-nethttp).

Hidden unless SIERRA_EXPERIMENTAL=1 because Sierra could not build and run them: Go Fiber, Spring Boot, ASP.NET Core, Kafka events.

Quick start

Requirements: Node.js 18+. Python 3 and Go are needed only for those stacks.

bash
cd Sierra-backend
cp .env.example .env        # Windows: copy .env.example .env
npm install
npm run doctor              # checks Node, npm registry, .env, Python, Go, MongoDB
npm start                   # http://localhost:5001

Then start the frontend (Sierra-frontend: npm install, npm run dev, open http://localhost:5173).

.env
env
PORT=5001

# Sierra login/signup. REQUIRED, at least 16 characters.
SIERRA_AUTH_SECRET=change-me-to-a-long-random-string

# MongoDB. Needed to VERIFY Express projects. Delete the line to run without it.
MONGODB_URI=mongodb://localhost:27017/sierra

# AI (optional). Order tried: Gemini -> Groq -> Anthropic. No key = fields read from the requirement text.
GEMINI_API_KEY=
SIERRA_LLM_MODEL=gemini-2.5-flash
GROQ_API_KEY=
GROQ_MODEL=llama-3.3-70b-versatile

# Optional
SIERRA_MAX_FIX_ATTEMPTS=3
REDIS_URL=redis://localhost:6379

Rules: delete any line you have no value for (never leave <placeholder>), keep the file named exactly .env, never commit it. The frontend needs its own .env: VITE_API_BASE=http://localhost:5001.

Writing a good requirement

List entities with their fields in brackets. Mention auth, Docker or CI only if you want them.

Good	Result
Blog API: posts (title, content, published), comments, author login.	Post(title, content, published), Comment, auth
Shop API: products (name, price, stock), orders	Product with typed price/stock, Order, no auth
Notes API: notes (title, body). Include Dockerfile and GitHub Actions CI.	Note + Dockerfile, compose and CI files

Field types are inferred from names (price is a float, stock an int, is_active a boolean, due_date a date) or written explicitly: qty int, price: float. A listed entity with no fields (members) gets generic name/description fields, and the report says so.

Projects to test every stack

Paste each requirement on the Create Project page and pick the stack.

Stack	Requirement	Expected
node-express	Library API: books (title, author, isbn), members, loans. Members can register and log in.	VERIFIED with MongoDB running, else NOT_VERIFIED (MongoDB missing)
node-fastify	Blog API: posts (title, content, published), comments, author login.	VERIFIED
nestjs	Shop API: products (name, price, stock), orders, customers login ke saath.	VERIFIED
python-fastapi	Task manager API: tasks (title, description, status, due_date), users login ke saath.	VERIFIED
python-django	Clinic API: patients (name, age, phone), appointments (date, doctor), staff login.	VERIFIED
python-flask	Notes API: notes (title, body, tags), user auth.	VERIFIED
go-nethttp	Inventory API: items (sku, name, quantity, price) aur stock update.	VERIFIED (Go installed)
go-gin	Event booking API: events (title, date, capacity), bookings, user login.	VERIFIED (Go + internet)

For each project check: the Files tab shows your fields in the model, Verification says VERIFIED with a test count, and the downloaded zip installs and runs (register, login, call an endpoint with and without a token).

API

Base URL http://localhost:5001.

Method	Path	Purpose
POST	/api/auth/register, /api/auth/login	Sierra account
GET	/api/auth/me	Current user
GET	/api/projects/stacks	Stacks, databases and features on offer
POST	/api/projects	Create {name, requirement, stack, database, architecture?, features?}
POST	/api/projects/:id/generate	Start generation and verification
GET	/api/projects/:id/events	Live progress (server-sent events)
GET	/api/projects/:id/status	{status, report}
GET	/api/projects/:id/files, /files/*	List / read generated files
GET	/api/projects/:id/schema	Entities and fields used
GET	/api/projects/:id/test-results	Test output
GET	/api/projects/:id/download	Zip of the generated project
POST	/api/design, /api/design/infra	System design and infra files
GET/POST/PUT/DELETE	/api/diagrams	Saved diagrams with versions

Statuses: VERIFIED, NOT_VERIFIED (could not run the tests, reason given), FAILED (ran and failed).

Troubleshooting
Symptom	Fix
querySrv EBADNAME _mongodb._tcp.<cluster>...	MONGODB_URI still holds the placeholder. Put a real URI or delete the line.
npm error code ETARGET	Stale npm cache or lagging mirror. npm cache clean --force, or npm install --before=<date ~2 weeks ago>. Sierra retries this itself for generated projects.
Express shows NOT_VERIFIED: MongoDB not reachable	Start MongoDB and set MONGODB_URI. Files are still generated.
Python/Go stack shows NOT_VERIFIED	Install Python 3 / Go 1.24+ and re-run.
Login returns 503	SIERRA_AUTH_SECRET missing or shorter than 16 characters.
npm run doctor prints FAIL	Fix that line first; WARN is fine.
Tests
bash
npm test      # 197 tests, 0 skipped on the last full run

The full run uses real Redis, RabbitMQ, PostgreSQL (primary and replica) and MySQL (primary and binlog replica) plus Go and Python. Without them those tests are reported as skipped, never as passed. See TESTING_REPORT.md.

Honest limits
Generation is template-based. Reviewed templates per stack give predictable code; the requirement controls entities, fields, auth and extras.
Express was verified here against FerretDB (MongoDB wire compatible), not real MongoDB.
Docker was not run in Sierra's sandbox. Docker/compose/CI files you request are statically checked only.
Gin was tested against Debian's Gin 1.8.1 offline; the generated go.mod pins 1.10.0.
Gemini and Groq calls were tested with a stub server, not with live keys.
Not available: Redis for Spring/.NET, read/write splitting for FastAPI + MySQL.

Details: IMPLEMENTATION_STATUS.md, SYSTEM_ARCHITECTURE.md, TESTING_REPORT.md.

Author

Nitika Gotra — @nitikagotra75-crypto
