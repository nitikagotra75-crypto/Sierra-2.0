/**
 * Opt-in `rateLimit` feature for generated projects: a fixed-window, per-client-IP limiter (in memory, per process).
 *
 * Wraps a stack definition so that (a) the stack advertises the `rateLimit` feature and (b) when the spec enables
 * it, extra files and small patches are applied to the stack's normal output. Supported: python-fastapi,
 * python-flask, python-django, node-fastify, nestjs, go-nethttp. Each generated project tests the limiter for real
 * (429 + Retry-After + standard error envelope; /health and /metrics exempt).
 *
 * Limits (also written into the generated README): counters live in process memory, so with N workers/replicas the
 * effective limit is N x the setting, and counters reset on restart. The client key is the socket peer address;
 * X-Forwarded-For is NOT trusted, so behind a proxy/ingress every client shares the proxy address until you
 * configure trusted-proxy handling for your framework or rate limit at the proxy (the generated nginx config can).
 */
const DEFAULT = 120;
const ENV_LINE = `RATE_LIMIT_PER_MINUTE=${DEFAULT}`;

function must(s, a, b, what) {
  if (!s.includes(a)) throw new Error(`rateLimit patch: anchor not found (${what})`);
  return s.replace(a, b);
}

const README_SECTION = (framework) => `
## Rate limiting
Requests are limited per client IP with a fixed window (${framework}). Configure with \`RATE_LIMIT_PER_MINUTE\` (default ${DEFAULT}; \`0\` disables). Over the limit the API answers \`429\` with a \`Retry-After\` header and the standard error body (\`code: "rate_limited"\`). \`/health\` and \`/metrics\` are exempt.

Limitations: counters are kept in process memory, so with several workers or replicas the effective limit is multiplied and counters reset on restart; the client key is the socket peer address and \`X-Forwarded-For\` is not trusted, so behind a reverse proxy all clients share the proxy's address unless you configure trusted proxies or limit at the proxy instead.
`;

// ------------------------------------------------------------------ Python (shared core)
const limiterPy = `import threading
import time


class FixedWindowLimiter:
    """Fixed-window counter per key. In-process only (see README)."""

    def __init__(self, limit: int, window: float = 60.0, clock=time.monotonic, max_keys: int = 10000):
        self.limit = limit
        self.window = window
        self.clock = clock
        self.max_keys = max_keys
        self._hits: dict = {}
        self._lock = threading.Lock()

    def check(self, key: str):
        """Return (allowed, retry_after_seconds)."""
        if self.limit <= 0:
            return True, 0
        now = self.clock()
        with self._lock:
            start, count = self._hits.get(key, (now, 0))
            if now - start >= self.window:
                start, count = now, 0
            if count >= self.limit:
                return False, max(1, int(start + self.window - now) + 1)
            self._hits[key] = (start, count + 1)
            if len(self._hits) > self.max_keys:
                self._purge(now)
            return True, 0

    def _purge(self, now: float) -> None:
        self._hits = {k: v for k, v in self._hits.items() if now - v[0] < self.window}
        if len(self._hits) > self.max_keys:  # still too many live keys: drop the oldest half
            keep = sorted(self._hits.items(), key=lambda kv: kv[1][0])[len(self._hits) // 2 :]
            self._hits = dict(keep)


EXEMPT = ("/health", "/metrics")
`;

const limiterTestsPy = (extraImport) => `${extraImport}from app.core.ratelimit import FixedWindowLimiter


def test_window_allows_limit_then_blocks_then_resets():
    t = [1000.0]
    lim = FixedWindowLimiter(2, window=60, clock=lambda: t[0])
    assert lim.check("a") == (True, 0)
    assert lim.check("a") == (True, 0)
    ok, retry = lim.check("a")
    assert ok is False and 1 <= retry <= 61
    assert lim.check("b") == (True, 0)  # other clients are independent
    t[0] += 61
    assert lim.check("a") == (True, 0)  # new window


def test_zero_disables_and_key_table_is_bounded():
    assert FixedWindowLimiter(0).check("x") == (True, 0)
    lim = FixedWindowLimiter(5, max_keys=10)
    for i in range(200):
        lim.check(str(i))
    assert len(lim._hits) <= 11
`;

function fastapi(spec, f) {
  f["app/core/ratelimit.py"] = limiterPy + `
import os

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse


def init_rate_limit(app: FastAPI) -> None:
    limiter = FixedWindowLimiter(int(os.environ.get("RATE_LIMIT_PER_MINUTE", "${DEFAULT}")))

    @app.middleware("http")
    async def rate_limit(request: Request, call_next):
        if request.url.path in EXEMPT:
            return await call_next(request)
        key = request.client.host if request.client else "unknown"
        ok, retry = limiter.check(key)
        if not ok:
            return JSONResponse(
                status_code=429,
                headers={"Retry-After": str(retry)},
                content={"error": {"code": "rate_limited", "message": "Too many requests", "details": None}},
            )
        return await call_next(request)
`;
  f["tests/test_rate_limit.py"] = limiterTestsPy("") + `
from fastapi.testclient import TestClient

from app.main import create_app


def test_over_limit_returns_429_with_retry_after_and_exempt_paths(monkeypatch):
    monkeypatch.setenv("RATE_LIMIT_PER_MINUTE", "3")
    with TestClient(create_app()) as c:
        codes = [c.get("/openapi.json").status_code for _ in range(5)]
        assert codes == [200, 200, 200, 429, 429]
        r = c.get("/openapi.json")
        assert int(r.headers["retry-after"]) >= 1
        assert r.json()["error"]["code"] == "rate_limited"
        assert c.get("/health").status_code == 200
        assert c.get("/metrics").status_code == 200
`;
  f["app/main.py"] = must(must(f["app/main.py"], "from app.core.metrics import init_metrics\n", "from app.core.metrics import init_metrics\nfrom app.core.ratelimit import init_rate_limit\n", "fastapi import"),
    "    init_metrics(app)\n", "    init_rate_limit(app)  # added before metrics so rejected requests are counted\n    init_metrics(app)\n", "fastapi call");
  f[".env.example"] += ENV_LINE + "\n";
  f["README.md"] = must(f["README.md"], "## Known limitations", README_SECTION("FastAPI middleware").trimStart() + "\n## Known limitations", "fastapi readme");
}

function flask(spec, f) {
  f["app/core/ratelimit.py"] = limiterPy + `
import os

from flask import jsonify, request


def init_rate_limit(app) -> None:
    limiter = FixedWindowLimiter(int(os.environ.get("RATE_LIMIT_PER_MINUTE", "${DEFAULT}")))

    @app.before_request
    def _rate_limit():
        if request.path in EXEMPT:
            return None
        ok, retry = limiter.check(request.remote_addr or "unknown")
        if ok:
            return None
        resp = jsonify({"error": {"code": "rate_limited", "message": "Too many requests", "details": None}})
        resp.status_code = 429
        resp.headers["Retry-After"] = str(retry)
        return resp
`;
  f["tests/test_rate_limit.py"] = limiterTestsPy("") + `
from app.main import create_app


def test_over_limit_returns_429_with_retry_after_and_exempt_paths(monkeypatch):
    monkeypatch.setenv("RATE_LIMIT_PER_MINUTE", "3")
    c = create_app().test_client()
    codes = [c.get("/openapi.json").status_code for _ in range(5)]
    assert codes == [200, 200, 200, 429, 429]
    r = c.get("/openapi.json")
    assert int(r.headers["Retry-After"]) >= 1
    assert r.get_json()["error"]["code"] == "rate_limited"
    assert c.get("/health").status_code == 200
    assert c.get("/metrics").status_code == 200
`;
  f["app/main.py"] = must(must(f["app/main.py"], "from app.core.metrics import init_metrics\n", "from app.core.metrics import init_metrics\nfrom app.core.ratelimit import init_rate_limit\n", "flask import"),
    "    register_error_handlers(app)\n", "    register_error_handlers(app)\n    init_rate_limit(app)\n", "flask call");
  f[".env.example"] += ENV_LINE + "\n";
  f["README.md"] = must(f["README.md"], "## Known limitations", README_SECTION("Flask before_request hook").trimStart() + "\n## Known limitations", "flask readme");
}

function django(spec, f) {
  f["core/ratelimit.py"] = limiterPy.replace("EXEMPT = (", "EXEMPT_PATHS = (") + `
import os

from django.http import JsonResponse


class RateLimitMiddleware:
    """Per-process fixed-window limiter keyed by REMOTE_ADDR (X-Forwarded-For is not trusted)."""

    def __init__(self, get_response):
        self.get_response = get_response
        self.limiter = FixedWindowLimiter(int(os.environ.get("RATE_LIMIT_PER_MINUTE", "${DEFAULT}")))

    def __call__(self, request):
        if request.path in EXEMPT_PATHS:
            return self.get_response(request)
        ok, retry = self.limiter.check(request.META.get("REMOTE_ADDR") or "unknown")
        if not ok:
            resp = JsonResponse({"error": {"code": "rate_limited", "message": "Too many requests", "details": None}}, status=429)
            resp["Retry-After"] = str(retry)
            return resp
        return self.get_response(request)
`;
  f["api/tests/test_rate_limit.py"] = `from django.http import HttpResponse
from django.test import RequestFactory, SimpleTestCase

from core.ratelimit import FixedWindowLimiter, RateLimitMiddleware


class RateLimitTests(SimpleTestCase):
    def test_window_blocks_then_resets(self):
        t = [1000.0]
        lim = FixedWindowLimiter(2, window=60, clock=lambda: t[0])
        self.assertEqual(lim.check("a"), (True, 0))
        self.assertEqual(lim.check("a"), (True, 0))
        ok, retry = lim.check("a")
        self.assertFalse(ok)
        self.assertGreaterEqual(retry, 1)
        self.assertEqual(lim.check("b"), (True, 0))
        t[0] += 61
        self.assertEqual(lim.check("a"), (True, 0))

    def test_zero_disables_and_key_table_is_bounded(self):
        self.assertEqual(FixedWindowLimiter(0).check("x"), (True, 0))
        lim = FixedWindowLimiter(5, max_keys=10)
        for i in range(200):
            lim.check(str(i))
        self.assertLessEqual(len(lim._hits), 11)

    def test_middleware_returns_429_envelope_and_exempts_health(self):
        import os
        os.environ["RATE_LIMIT_PER_MINUTE"] = "3"
        try:
            mw = RateLimitMiddleware(lambda request: HttpResponse("ok"))
        finally:
            del os.environ["RATE_LIMIT_PER_MINUTE"]
        rf = RequestFactory()
        codes = [mw(rf.get("/openapi.json")).status_code for _ in range(5)]
        self.assertEqual(codes, [200, 200, 200, 429, 429])
        r = mw(rf.get("/openapi.json"))
        self.assertGreaterEqual(int(r["Retry-After"]), 1)
        self.assertIn(b"rate_limited", r.content)
        self.assertEqual(mw(rf.get("/health")).status_code, 200)
        self.assertEqual(mw(rf.get("/metrics")).status_code, 200)
`;
  f["config/settings.py"] = must(f["config/settings.py"], 'MIDDLEWARE = ["core.metrics.MetricsMiddleware", "core.errors.ErrorMiddleware"]',
    'MIDDLEWARE = ["core.metrics.MetricsMiddleware", "core.ratelimit.RateLimitMiddleware", "core.errors.ErrorMiddleware"]', "django middleware");
  f[".env.example"] += ENV_LINE + "\n";
  f["README.md"] = must(f["README.md"], "## Known limitations", README_SECTION("Django middleware").trimStart() + "\n## Known limitations", "django readme");
}

// ------------------------------------------------------------------ Node
const limiterJs = `// Fixed-window limiter per key, in process memory (see README for limits).
class FixedWindowLimiter {
  constructor(limit, { windowMs = 60000, now = Date.now, maxKeys = 10000 } = {}) {
    this.limit = limit; this.windowMs = windowMs; this.now = now; this.maxKeys = maxKeys; this.hits = new Map();
  }

  /** Returns { allowed, retryAfter } (seconds). */
  check(key) {
    if (!(this.limit > 0)) return { allowed: true, retryAfter: 0 };
    const t = this.now();
    let e = this.hits.get(key);
    if (!e || t - e.start >= this.windowMs) e = { start: t, count: 0 };
    if (e.count >= this.limit) return { allowed: false, retryAfter: Math.max(1, Math.ceil((e.start + this.windowMs - t) / 1000)) };
    e.count += 1;
    this.hits.set(key, e);
    if (this.hits.size > this.maxKeys) this.purge(t);
    return { allowed: true, retryAfter: 0 };
  }

  purge(t) {
    for (const [k, e] of this.hits) if (t - e.start >= this.windowMs) this.hits.delete(k);
    if (this.hits.size > this.maxKeys) {
      const oldest = [...this.hits.entries()].sort((a, b) => a[1].start - b[1].start).slice(0, Math.floor(this.hits.size / 2));
      for (const [k] of oldest) this.hits.delete(k);
    }
  }
}

const EXEMPT = new Set(["/health", "/metrics"]);
const pathOf = (url) => url.split("?")[0];
`;

function fastify(spec, f) {
  f["src/ratelimit.js"] = limiterJs + `
function registerRateLimit(app, limitPerMinute) {
  const limiter = new FixedWindowLimiter(limitPerMinute);
  app.addHook("onRequest", async (req, reply) => {
    if (EXEMPT.has(pathOf(req.url))) return;
    const r = limiter.check(req.ip || "unknown");
    if (r.allowed) return;
    reply.code(429).header("Retry-After", String(r.retryAfter))
      .send({ error: { code: "rate_limited", message: "Too many requests", details: null } });
    return reply;
  });
}

module.exports = { FixedWindowLimiter, registerRateLimit };
`;
  f["test/ratelimit.test.js"] = `const test = require("node:test");
const assert = require("node:assert");
const { buildApp } = require("../src/app");
const { FixedWindowLimiter } = require("../src/ratelimit");

test("window blocks after the limit and resets; key table is bounded", () => {
  let t = 1000;
  const lim = new FixedWindowLimiter(2, { now: () => t });
  assert.equal(lim.check("a").allowed, true);
  assert.equal(lim.check("a").allowed, true);
  const blocked = lim.check("a");
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfter >= 1);
  assert.equal(lim.check("b").allowed, true);
  t += 61000;
  assert.equal(lim.check("a").allowed, true);
  assert.equal(new FixedWindowLimiter(0).check("x").allowed, true);
  const small = new FixedWindowLimiter(5, { maxKeys: 10 });
  for (let i = 0; i < 200; i++) small.check(String(i));
  assert.ok(small.hits.size <= 11);
});

test("over the limit: 429 + Retry-After + error envelope; /health and /metrics exempt", async () => {
  const app = await buildApp({ dbPath: ":memory:", jwtSecret: "test-secret-not-for-production-0123456789", rateLimitPerMinute: 3 });
  await app.ready();
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await app.inject({ method: "GET", url: "/openapi.json" })).statusCode);
  assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  const r = await app.inject({ method: "GET", url: "/openapi.json" });
  assert.ok(Number(r.headers["retry-after"]) >= 1);
  assert.equal(r.json().error.code, "rate_limited");
  assert.equal((await app.inject({ method: "GET", url: "/health" })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/metrics" })).statusCode, 200);
  await app.close();
});
`;
  f["src/app.js"] = must(must(must(f["src/app.js"], "async function buildApp({ dbPath = \":memory:\", jwtSecret = \"\", logger = false } = {}) {",
    "async function buildApp({ dbPath = \":memory:\", jwtSecret = \"\", logger = false, rateLimitPerMinute = Number(process.env.RATE_LIMIT_PER_MINUTE ?? ${DEFAULT}) } = {}) {".replace("${DEFAULT}", DEFAULT), "fastify signature"),
    "  app.decorate(\"db\", openDb(dbPath));\n", "  app.decorate(\"db\", openDb(dbPath));\n  registerRateLimit(app, rateLimitPerMinute);\n", "fastify register"),
    "\nasync function buildApp(", "\nconst { registerRateLimit } = require(\"./ratelimit\");\n\nasync function buildApp(", "fastify require");
  f[".env.example"] += ENV_LINE + "\n";
  f["README.md"] = must(f["README.md"], "## Known limitations", README_SECTION("Fastify onRequest hook").trimStart() + "\n## Known limitations", "fastify readme");
}

function nest(spec, f) {
  f["src/common/rate-limit.ts"] = `// Fixed-window limiter per client IP, in process memory (see README for limits).
export class FixedWindowLimiter {
  private hits = new Map<string, { start: number; count: number }>();

  constructor(private readonly limit: number, private readonly windowMs = 60000, private readonly now: () => number = Date.now, private readonly maxKeys = 10000) {}

  check(key: string): { allowed: boolean; retryAfter: number } {
    if (!(this.limit > 0)) return { allowed: true, retryAfter: 0 };
    const t = this.now();
    let e = this.hits.get(key);
    if (!e || t - e.start >= this.windowMs) e = { start: t, count: 0 };
    if (e.count >= this.limit) return { allowed: false, retryAfter: Math.max(1, Math.ceil((e.start + this.windowMs - t) / 1000)) };
    e.count += 1;
    this.hits.set(key, e);
    if (this.hits.size > this.maxKeys) this.purge(t);
    return { allowed: true, retryAfter: 0 };
  }

  get size() { return this.hits.size; }

  private purge(t: number) {
    for (const [k, e] of this.hits) if (t - e.start >= this.windowMs) this.hits.delete(k);
    if (this.hits.size > this.maxKeys) {
      const oldest = [...this.hits.entries()].sort((a, b) => a[1].start - b[1].start).slice(0, Math.floor(this.hits.size / 2));
      for (const [k] of oldest) this.hits.delete(k);
    }
  }
}

const EXEMPT = new Set(["/health", "/metrics"]);

export function rateLimitMiddleware(limitPerMinute: number) {
  const limiter = new FixedWindowLimiter(limitPerMinute);
  return (req: any, res: any, next: () => void) => {
    if (EXEMPT.has(String(req.originalUrl || req.url).split("?")[0])) return next();
    const r = limiter.check(req.ip || req.socket?.remoteAddress || "unknown");
    if (r.allowed) return next();
    res.status(429).set("Retry-After", String(r.retryAfter)).json({ error: { code: "rate_limited", message: "Too many requests", details: null } });
  };
}
`;
  f["test/rate-limit.e2e.ts"] = `import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.setup";
import { FixedWindowLimiter } from "../src/common/rate-limit";

describe("rate limiting", () => {
  it("window blocks after the limit and resets; key table is bounded", () => {
    let t = 1000;
    const lim = new FixedWindowLimiter(2, 60000, () => t);
    expect(lim.check("a").allowed).toBe(true);
    expect(lim.check("a").allowed).toBe(true);
    const blocked = lim.check("a");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThanOrEqual(1);
    expect(lim.check("b").allowed).toBe(true);
    t += 61000;
    expect(lim.check("a").allowed).toBe(true);
    expect(new FixedWindowLimiter(0).check("x").allowed).toBe(true);
    const small = new FixedWindowLimiter(5, 60000, Date.now, 10);
    for (let i = 0; i < 200; i++) small.check(String(i));
    expect(small.size).toBeLessThanOrEqual(11);
  });

  it("over the limit: 429 + Retry-After + error envelope; /health exempt", async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = configureApp(mod.createNestApplication(), { rateLimitPerMinute: 3 });
    await app.init();
    const http = request(app.getHttpServer());
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await http.get("/openapi.json")).status);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    const r = await http.get("/openapi.json");
    expect(Number(r.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(r.body.error.code).toBe("rate_limited");
    expect((await http.get("/health")).status).toBe(200);
    await app.close();
  });
});
`;
  f["src/app.setup.ts"] = must(must(f["src/app.setup.ts"], "export function configureApp(app: INestApplication) {\n",
    `export function configureApp(app: INestApplication, opts: { rateLimitPerMinute?: number } = {}) {\n  app.use(rateLimitMiddleware(opts.rateLimitPerMinute ?? Number(process.env.RATE_LIMIT_PER_MINUTE ?? ${DEFAULT})));\n`, "nest configureApp"),
    'import { AllExceptionsFilter } from "./common/http-exception.filter";\n', 'import { AllExceptionsFilter } from "./common/http-exception.filter";\nimport { rateLimitMiddleware } from "./common/rate-limit";\n', "nest import");
  f[".env.example"] += ENV_LINE + "\n";
  f["README.md"] = must(f["README.md"], "## Known limitations", README_SECTION("Express middleware under NestJS").trimStart() + "\n## Known limitations", "nest readme");
}

// ------------------------------------------------------------------ Go
function go(spec, f) {
  const mod = spec.slug;
  f["internal/ratelimit/ratelimit.go"] = `// Package ratelimit is a fixed-window, per-client limiter kept in process memory (see README for limits).
package ratelimit

import (
	"net"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"

	"${mod}/internal/httpx"
)

type bucket struct {
	start time.Time
	n     int
}

type Limiter struct {
	mu      sync.Mutex
	limit   int
	window  time.Duration
	now     func() time.Time
	maxKeys int
	hits    map[string]*bucket
}

func New(limit int, window time.Duration) *Limiter {
	return &Limiter{limit: limit, window: window, now: time.Now, maxKeys: 10000, hits: map[string]*bucket{}}
}

// FromEnv reads RATE_LIMIT_PER_MINUTE (default ${DEFAULT}; 0 disables).
func FromEnv() *Limiter {
	limit := ${DEFAULT}
	if v := os.Getenv("RATE_LIMIT_PER_MINUTE"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			limit = n
		}
	}
	return New(limit, time.Minute)
}

// Allow reports whether key may proceed; when it may not, the second value is the Retry-After in seconds.
func (l *Limiter) Allow(key string) (bool, int) {
	if l.limit <= 0 {
		return true, 0
	}
	t := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.hits[key]
	if b == nil || t.Sub(b.start) >= l.window {
		b = &bucket{start: t}
		l.hits[key] = b
	}
	if b.n >= l.limit {
		retry := int(b.start.Add(l.window).Sub(t).Seconds()) + 1
		if retry < 1 {
			retry = 1
		}
		return false, retry
	}
	b.n++
	if len(l.hits) > l.maxKeys {
		l.purge(t)
	}
	return true, 0
}

func (l *Limiter) purge(t time.Time) {
	for k, b := range l.hits {
		if t.Sub(b.start) >= l.window {
			delete(l.hits, k)
		}
	}
	if len(l.hits) > l.maxKeys { // still too many live keys: drop arbitrary half
		i := 0
		for k := range l.hits {
			if i%2 == 0 {
				delete(l.hits, k)
			}
			i++
		}
	}
}

func (l *Limiter) Size() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.hits)
}

// Middleware rejects over-limit requests with 429. /health and /metrics are exempt.
func (l *Limiter) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" || r.URL.Path == "/metrics" {
			next.ServeHTTP(w, r)
			return
		}
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			host = r.RemoteAddr
		}
		ok, retry := l.Allow(host)
		if !ok {
			w.Header().Set("Retry-After", strconv.Itoa(retry))
			httpx.WriteError(w, &httpx.AppError{Status: 429, Code: "rate_limited", Message: "Too many requests"})
			return
		}
		next.ServeHTTP(w, r)
	})
}
`;
  f["internal/ratelimit/ratelimit_test.go"] = `package ratelimit

import (
	"testing"
	"time"
)

func TestWindowBlocksThenResetsAndIsBounded(t *testing.T) {
	now := time.Unix(1000, 0)
	l := New(2, time.Minute)
	l.now = func() time.Time { return now }
	for i := 0; i < 2; i++ {
		if ok, _ := l.Allow("a"); !ok {
			t.Fatalf("request %d should pass", i)
		}
	}
	ok, retry := l.Allow("a")
	if ok || retry < 1 {
		t.Fatalf("third request must be blocked with retry>=1, got ok=%v retry=%d", ok, retry)
	}
	if ok, _ := l.Allow("b"); !ok {
		t.Fatal("other clients are independent")
	}
	now = now.Add(61 * time.Second)
	if ok, _ := l.Allow("a"); !ok {
		t.Fatal("new window should allow")
	}
	if ok, _ := New(0, time.Minute).Allow("x"); !ok {
		t.Fatal("0 disables the limiter")
	}
	small := New(5, time.Minute)
	small.maxKeys = 10
	for i := 0; i < 200; i++ {
		small.Allow(string(rune('A' + i%50)) + time.Duration(i).String())
	}
	if small.Size() > 11 {
		t.Fatalf("key table not bounded: %d", small.Size())
	}
}
`;
  f["internal/app/ratelimit_test.go"] = `package app

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"${mod}/internal/config"
)

func TestOverLimitReturns429WithRetryAfterAndExemptPaths(t *testing.T) {
	t.Setenv("RATE_LIMIT_PER_MINUTE", "3")
	h := New(config.Config{JWTSecret: "test-secret-not-for-production-0123456789", JWTTTL: 3600e9})
	get := func(path string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.RemoteAddr = "203.0.113.9:4444"
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	var codes []int
	for i := 0; i < 5; i++ {
		codes = append(codes, get("/openapi.json").Code)
	}
	want := []int{200, 200, 200, 429, 429}
	for i := range want {
		if codes[i] != want[i] {
			t.Fatalf("codes = %v, want %v", codes, want)
		}
	}
	r := get("/openapi.json")
	if n, err := strconv.Atoi(r.Header().Get("Retry-After")); err != nil || n < 1 {
		t.Fatalf("Retry-After = %q", r.Header().Get("Retry-After"))
	}
	if !strings.Contains(r.Body.String(), "rate_limited") {
		t.Fatalf("body = %s", r.Body.String())
	}
	if get("/health").Code != 200 || get("/metrics").Code != 200 {
		t.Fatal("/health and /metrics must be exempt")
	}
}
`;
  f["internal/app/app.go"] = must(must(f["internal/app/app.go"], "return reg.Middleware(httpx.Wrap(mux))", "return reg.Middleware(httpx.Wrap(ratelimit.FromEnv().Middleware(mux)))", "go return"),
    `\t"${mod}/internal/httpx"\n`, `\t"${mod}/internal/httpx"\n\t"${mod}/internal/ratelimit"\n`, "go import");
  f[".env.example"] += ENV_LINE + "\n";
  f["README.md"] = must(f["README.md"], "## Known limitations", README_SECTION("net/http middleware").trimStart() + "\n## Known limitations", "go readme");
}

const PATCH = { "python-fastapi": fastapi, "python-flask": flask, "python-django": django, "node-fastify": fastify, nestjs: nest, "go-nethttp": go };

function withRateLimit(stack) {
  const patch = PATCH[stack.id];
  if (!patch) return stack;
  const base = stack.generate;
  return {
    ...stack,
    features: [...(stack.features || []), "rateLimit"],
    generate(spec) {
      const files = base(spec);
      if (spec.features && spec.features.rateLimit) patch(spec, files);
      return files;
    },
  };
}

module.exports = { withRateLimit, PATCH };
