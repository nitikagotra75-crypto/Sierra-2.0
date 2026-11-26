const fs = require("fs");
const path = require("path");
/**
 * Opt-in `distributed` feature for generated projects: Redis-backed rate limiting, idempotency keys, a safe
 * distributed lock, and an in-process circuit breaker. Currently: python-fastapi.
 *
 * Every Redis operation that must be atomic is a single Lua script (rate limit counter, lock release/extend), or a
 * single `SET NX PX` (lock acquire, idempotency claim). The generated tests run against a REAL Redis (REDIS_URL,
 * default redis://localhost:6379/15) - never fakeredis; if Redis is unreachable the tests are skipped with an
 * explicit reason (and Sierra reports the whole validation as SKIPPED, not VERIFIED).
 *
 * Documented limits (also in the generated README):
 *  - the lock is a single-instance Redis lock: not safe across Redis failover/replication, no fencing tokens.
 *    Use it for efficiency (avoid duplicate work), not as the only guard of a correctness invariant.
 *  - the circuit breaker keeps state per process.
 *  - rate limit is per client IP (X-Forwarded-For is not trusted); per-user limiting is not implemented.
 *  - idempotency replays the stored status/body; headers other than content-type are not replayed.
 */
function must(s, a, b, what) {
  if (!s.includes(a)) throw new Error(`distributed patch: anchor not found (${what})`);
  return s.replace(a, b);
}

const corePy = `"""Redis-backed building blocks. Every class takes an already-built redis client so it can be tested against a real server."""
import json
import logging
import threading
import time
import uuid
from typing import Callable, Optional

log = logging.getLogger("app.distributed")

# Atomic fixed-window counter: INCR, set the TTL only when the key is created, return {count, ttl_ms}.
_RATE_LUA = """
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return {c, ttl}
"""
# Release only if we still own the lock (compare token, then delete) - atomically.
_RELEASE_LUA = """
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end
"""
_EXTEND_LUA = """
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end
"""


class RedisRateLimiter:
    """Distributed fixed-window limiter: every instance shares the same counter in Redis."""

    def __init__(self, client, limit: int, window_seconds: int = 60, prefix: str = "rl"):
        self.client = client
        self.limit = limit
        self.window_ms = int(window_seconds * 1000)
        self.prefix = prefix
        self._script = client.register_script(_RATE_LUA)

    def check(self, scope: str, ident: str):
        """Return (allowed, retry_after_seconds, remaining). Raises redis errors; the caller decides fail-open/closed."""
        if self.limit <= 0:
            return True, 0, -1
        count, ttl_ms = self._script(keys=[f"{self.prefix}:{scope}:{ident}"], args=[self.window_ms])
        if count > self.limit:
            return False, max(1, (int(ttl_ms) + 999) // 1000), 0
        return True, 0, self.limit - int(count)


class IdempotencyStore:
    """Idempotency-Key support. States: processing -> complete (response stored). Entries expire after ttl_seconds."""

    def __init__(self, client, ttl_seconds: int = 86400, lock_seconds: int = 60, prefix: str = "idem"):
        self.client = client
        self.ttl = ttl_seconds
        self.lock_seconds = lock_seconds  # a crashed request keeps the key 'processing' at most this long
        self.prefix = prefix

    def _k(self, key: str) -> str:
        return f"{self.prefix}:{key}"

    def begin(self, key: str, fingerprint: str):
        """Return ('new', None) | ('in_progress', None) | ('replay', {status, body, content_type}) | ('mismatch', None)."""
        claim = json.dumps({"state": "processing", "fp": fingerprint})
        if self.client.set(self._k(key), claim, nx=True, ex=self.lock_seconds):
            return "new", None
        raw = self.client.get(self._k(key))
        if raw is None:  # expired between SET and GET: try once more
            if self.client.set(self._k(key), claim, nx=True, ex=self.lock_seconds):
                return "new", None
            raw = self.client.get(self._k(key))
            if raw is None:
                return "in_progress", None
        rec = json.loads(raw)
        if rec["fp"] != fingerprint:
            return "mismatch", None
        if rec["state"] == "processing":
            return "in_progress", None
        return "replay", rec["response"]

    def complete(self, key: str, fingerprint: str, status: int, body: str, content_type: str) -> None:
        rec = {"state": "complete", "fp": fingerprint, "response": {"status": status, "body": body, "content_type": content_type}}
        self.client.set(self._k(key), json.dumps(rec), ex=self.ttl)

    def abort(self, key: str) -> None:
        """Release the claim (used for 5xx / crashes) so the client can retry with the same key."""
        self.client.delete(self._k(key))


class LockNotAcquired(Exception):
    pass


class RedisLock:
    """
    Single-instance Redis lock: SET NX PX with a random owner token, release/extend only by the owner (Lua).
    Limits: not safe across Redis failover, no fencing token, and if the holder pauses longer than ttl another process
    can take the lock. Use it to avoid duplicate work, not as the sole guard of a correctness invariant.
    """

    def __init__(self, client, name: str, ttl_ms: int = 10000, timeout_s: float = 0.0, retry_interval_s: float = 0.05, prefix: str = "lock"):
        self.client = client
        self.key = f"{prefix}:{name}"
        self.ttl_ms = ttl_ms
        self.timeout_s = timeout_s
        self.retry_interval_s = retry_interval_s
        self.token: Optional[str] = None
        self._release = client.register_script(_RELEASE_LUA)
        self._extend = client.register_script(_EXTEND_LUA)

    def acquire(self) -> bool:
        token = uuid.uuid4().hex
        deadline = time.monotonic() + self.timeout_s
        while True:
            if self.client.set(self.key, token, nx=True, px=self.ttl_ms):
                self.token = token
                return True
            if time.monotonic() >= deadline:
                return False
            time.sleep(self.retry_interval_s)

    def release(self) -> bool:
        """True if we still owned the lock (and freed it); False if it had expired or been taken by someone else."""
        if self.token is None:
            return False
        ok = bool(self._release(keys=[self.key], args=[self.token]))
        self.token = None
        return ok

    def extend(self, ttl_ms: Optional[int] = None) -> bool:
        return self.token is not None and bool(self._extend(keys=[self.key], args=[self.token, ttl_ms or self.ttl_ms]))

    def __enter__(self):
        if not self.acquire():
            raise LockNotAcquired(self.key)
        return self

    def __exit__(self, *exc):
        self.release()


class CircuitOpen(Exception):
    pass


class CircuitBreaker:
    """closed -> (failure_threshold consecutive failures) -> open -> (recovery_timeout) -> half_open -> success: closed / failure: open."""

    def __init__(self, failure_threshold: int = 5, recovery_timeout: float = 30.0, half_open_max_calls: int = 1, clock: Callable[[], float] = time.monotonic):
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self.half_open_max_calls = half_open_max_calls
        self.clock = clock
        self._lock = threading.Lock()
        self._state = "closed"
        self._failures = 0
        self._opened_at = 0.0
        self._half_open_calls = 0

    @property
    def state(self) -> str:
        with self._lock:
            return self._peek()

    def _peek(self) -> str:
        if self._state == "open" and self.clock() - self._opened_at >= self.recovery_timeout:
            self._state, self._half_open_calls = "half_open", 0
        return self._state

    def call(self, fn: Callable, *args, fallback: Optional[Callable] = None, **kwargs):
        with self._lock:
            state = self._peek()
            if state == "open" or (state == "half_open" and self._half_open_calls >= self.half_open_max_calls):
                if fallback:
                    return fallback()
                raise CircuitOpen("circuit is open")
            if state == "half_open":
                self._half_open_calls += 1
        try:
            result = fn(*args, **kwargs)
        except Exception:
            with self._lock:
                self._failures += 1
                if self._state == "half_open" or self._failures >= self.failure_threshold:
                    self._state, self._opened_at = "open", self.clock()
            if fallback:
                return fallback()
            raise
        with self._lock:
            self._state, self._failures = "closed", 0
        return result


class Guard:
    """Framework-agnostic request guard used by the FastAPI/Flask/Django adapters: Redis rate limit + Idempotency-Key."""

    EXEMPT = ("/health", "/metrics")

    def __init__(self, url: str, limit: int = 120, fail_open: bool = True, idem_ttl: int = 86400):
        import redis

        self._redis = redis
        self.client = redis.Redis.from_url(url, socket_timeout=0.5, socket_connect_timeout=0.5, decode_responses=True)
        self.limiter = RedisRateLimiter(self.client, limit)
        self.idem = IdempotencyStore(self.client, ttl_seconds=idem_ttl)
        self.fail_open = fail_open

    @classmethod
    def from_env(cls):
        import os

        url = os.environ.get("REDIS_URL")
        if not url:
            log.warning("REDIS_URL is not set: distributed rate limiting and idempotency are DISABLED")
            return None
        return cls(url, int(os.environ.get("RATE_LIMIT_PER_MINUTE", "120")), os.environ.get("DISTRIBUTED_FAIL_OPEN", "true").lower() != "false", int(os.environ.get("IDEMPOTENCY_TTL_SECONDS", "86400")))

    @staticmethod
    def error(status: int, code: str, message: str, headers: Optional[dict] = None):
        return {"status": status, "body": {"error": {"code": code, "message": message, "details": None}}, "headers": headers or {}}

    def check_rate(self, path: str, ip: str):
        """None when the request may proceed, otherwise an error response dict."""
        if path in self.EXEMPT:
            return None
        try:
            ok, retry, _ = self.limiter.check("ip", ip or "unknown")
        except self._redis.RedisError as exc:
            log.error("rate limiter unavailable: %s", exc)
            return None if self.fail_open else self.error(503, "rate_limiter_unavailable", "Rate limiter is unavailable", {"Retry-After": "1"})
        return None if ok else self.error(429, "rate_limited", "Too many requests", {"Retry-After": str(retry)})

    def begin(self, method: str, path: str, auth: str, key: Optional[str], body: bytes):
        """('skip', None) | ('respond', response dict) | ('proceed', ctx). ctx goes to finish()/abort()."""
        import hashlib

        if method != "POST" or not key or path in self.EXEMPT:
            return "skip", None
        if len(key) > 200:
            return "respond", self.error(422, "invalid_idempotency_key", "Idempotency-Key must be at most 200 characters")
        fp = hashlib.sha256(path.encode() + b"\\0" + body).hexdigest()
        scoped = hashlib.sha256((auth + "|" + key).encode()).hexdigest()  # keys are per caller
        try:
            state, rec = self.idem.begin(scoped, fp)
        except self._redis.RedisError as exc:
            log.error("idempotency store unavailable: %s", exc)
            return "respond", self.error(503, "idempotency_unavailable", "Idempotency store is unavailable", {"Retry-After": "1"})
        if state == "replay":
            return "respond", {"status": rec["status"], "raw": rec["body"], "content_type": rec["content_type"], "headers": {"Idempotent-Replay": "true"}}
        if state == "in_progress":
            return "respond", self.error(409, "request_in_progress", "A request with this Idempotency-Key is still being processed", {"Retry-After": "1"})
        if state == "mismatch":
            return "respond", self.error(422, "idempotency_key_reuse", "This Idempotency-Key was used with a different request")
        return "proceed", (scoped, fp)

    def finish(self, ctx, status: int, body: str, content_type: str) -> None:
        scoped, fp = ctx
        try:
            if status >= 500:
                self.idem.abort(scoped)  # server errors are not cached: the client may retry with the same key
            else:
                self.idem.complete(scoped, fp, status, body, content_type)
        except self._redis.RedisError as exc:
            log.error("could not store idempotent response: %s", exc)

    def abort(self, ctx) -> None:
        try:
            self.idem.abort(ctx[0])
        except self._redis.RedisError:
            pass
`;

const middlewarePy = `import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

from app.core.distributed import Guard

log = logging.getLogger("app.distributed")


def _respond(r: dict):
    if "raw" in r:
        return Response(content=r["raw"], status_code=r["status"], media_type=r["content_type"], headers=r["headers"])
    return JSONResponse(status_code=r["status"], content=r["body"], headers=r["headers"])


def init_distributed(app: FastAPI) -> None:
    guard = Guard.from_env()
    if guard is None:
        return
    app.state.redis = guard.client

    @app.middleware("http")
    async def distributed(request: Request, call_next):
        denied = guard.check_rate(request.url.path, request.client.host if request.client else "unknown")
        if denied:
            return _respond(denied)
        body = await request.body() if request.method == "POST" and request.headers.get("Idempotency-Key") else b""
        action, payload = guard.begin(request.method, request.url.path, request.headers.get("Authorization", ""), request.headers.get("Idempotency-Key"), body)
        if action == "respond":
            return _respond(payload)
        if action == "skip":
            return await call_next(request)
        try:
            response = await call_next(request)
            content = b"".join([c async for c in response.body_iterator])
        except Exception:
            guard.abort(payload)
            raise
        guard.finish(payload, response.status_code, content.decode(), response.media_type or "application/json")
        return Response(content=content, status_code=response.status_code, headers={k: v for k, v in response.headers.items() if k.lower() != "content-length"})
`;

const testsPy = `"""Integration tests against a REAL Redis (REDIS_URL, default redis://localhost:6379/15). Skipped - never faked - if unreachable.
unittest style so the same file runs under pytest and under Django's test runner."""
import os
import threading
import time
import unittest

import redis

from CORE_MODULE import CircuitBreaker, CircuitOpen, IdempotencyStore, LockNotAcquired, RedisLock, RedisRateLimiter

URL = os.environ.get("REDIS_URL", "redis://localhost:6379/15")


class RealRedisCase(unittest.TestCase):
    def setUp(self):
        self.r = redis.Redis.from_url(URL, decode_responses=True, socket_connect_timeout=1, socket_timeout=2)
        try:
            self.r.ping()
        except redis.RedisError as exc:
            self.skipTest(f"REDIS UNAVAILABLE at {URL}: {exc} - these tests need a real Redis")
        self.r.flushdb()
        self.addCleanup(self.r.flushdb)


class RateLimitTests(RealRedisCase):
    def test_counts_across_two_independent_limiter_instances(self):
        a, b = RedisRateLimiter(self.r, 5, 60), RedisRateLimiter(redis.Redis.from_url(URL, decode_responses=True), 5, 60)
        results = [(a if i % 2 else b).check("ip", "1.2.3.4")[0] for i in range(8)]
        self.assertEqual(results, [True] * 5 + [False] * 3)  # one shared counter, not two
        ok, retry, _ = a.check("ip", "1.2.3.4")
        self.assertFalse(ok)
        self.assertTrue(1 <= retry <= 60)
        self.assertTrue(a.check("ip", "9.9.9.9")[0])  # other clients unaffected

    def test_ttl_expires_and_window_resets(self):
        lim = RedisRateLimiter(self.r, 2, window_seconds=1)
        self.assertEqual([lim.check("ip", "x")[0] for _ in range(3)], [True, True, False])
        self.assertTrue(0 < self.r.pttl("rl:ip:x") <= 1000)
        time.sleep(1.2)
        self.assertEqual(self.r.exists("rl:ip:x"), 0)
        self.assertTrue(lim.check("ip", "x")[0])

    def test_atomic_under_concurrency(self):
        lim = RedisRateLimiter(self.r, 20, 60)
        allowed = []
        ts = [threading.Thread(target=lambda: allowed.append(lim.check("ip", "c")[0])) for _ in range(60)]
        [t.start() for t in ts]
        [t.join() for t in ts]
        self.assertEqual(sum(allowed), 20)

    def test_connection_failure_then_recovery(self):
        lim = RedisRateLimiter(self.r, 5, 60)
        self.assertTrue(lim.check("ip", "z")[0])
        dead = RedisRateLimiter(redis.Redis(host="127.0.0.1", port=1, socket_connect_timeout=0.2), 5, 60)
        with self.assertRaises(redis.RedisError):
            dead.check("ip", "z")
        self.assertTrue(lim.check("ip", "z")[0])


class IdempotencyTests(RealRedisCase):
    def test_lifecycle_and_expiry(self):
        s = IdempotencyStore(self.r, ttl_seconds=1, lock_seconds=5)
        self.assertEqual(s.begin("k", "fp1"), ("new", None))
        self.assertEqual(s.begin("k", "fp1"), ("in_progress", None))
        self.assertEqual(s.begin("k", "other")[0], "mismatch")
        s.complete("k", "fp1", 201, '{"id":1}', "application/json")
        state, rec = s.begin("k", "fp1")
        self.assertEqual((state, rec["status"], rec["body"]), ("replay", 201, '{"id":1}'))
        time.sleep(1.2)
        self.assertEqual(s.begin("k", "fp1"), ("new", None))  # expired
        s.abort("k")
        self.assertEqual(s.begin("k", "fp1"), ("new", None))  # an aborted claim can be retried

    def test_concurrent_requests_only_one_claims(self):
        s = IdempotencyStore(self.r)
        out = []
        ts = [threading.Thread(target=lambda: out.append(s.begin("same", "fp")[0])) for _ in range(30)]
        [t.start() for t in ts]
        [t.join() for t in ts]
        self.assertEqual((out.count("new"), out.count("in_progress")), (1, 29))


class LockTests(RealRedisCase):
    def test_mutual_exclusion_and_owner_only_release(self):
        a, b = RedisLock(self.r, "job", ttl_ms=5000), RedisLock(self.r, "job", ttl_ms=5000)
        self.assertTrue(a.acquire())
        self.assertFalse(b.acquire())
        b.token = "forged"  # a non-owner must not be able to release
        self.assertFalse(b.release())
        self.assertEqual(self.r.exists("lock:job"), 1)
        self.assertTrue(a.release())
        self.assertTrue(b.acquire())
        b.release()

    def test_expiry_stale_holder_cannot_release_new_owners_lock(self):
        a, b = RedisLock(self.r, "job2", ttl_ms=200), RedisLock(self.r, "job2", ttl_ms=5000)
        self.assertTrue(a.acquire())
        time.sleep(0.4)
        self.assertTrue(b.acquire())  # a's lock expired
        self.assertFalse(a.release())  # a must NOT delete b's lock
        self.assertEqual(self.r.exists("lock:job2"), 1)
        self.assertTrue(b.extend(3000))
        self.assertTrue(self.r.pttl("lock:job2") > 2000)

    def test_waits_until_timeout_and_context_manager(self):
        holder = RedisLock(self.r, "w", ttl_ms=300)
        self.assertTrue(holder.acquire())
        waiter = RedisLock(self.r, "w", ttl_ms=1000, timeout_s=2.0)
        t0 = time.monotonic()
        self.assertTrue(waiter.acquire())
        self.assertTrue(time.monotonic() - t0 < 1.5)  # got it after expiry, within the timeout
        waiter.release()
        RedisLock(self.r, "w2", ttl_ms=5000).acquire()
        with self.assertRaises(LockNotAcquired):
            with RedisLock(self.r, "w2", timeout_s=0.1):
                pass


class CircuitBreakerTests(unittest.TestCase):
    def test_states_fallback_and_recovery(self):
        t = [0.0]
        cb = CircuitBreaker(failure_threshold=2, recovery_timeout=10, clock=lambda: t[0])

        def boom():
            raise RuntimeError("down")

        for _ in range(2):
            with self.assertRaises(RuntimeError):
                cb.call(boom)
        self.assertEqual(cb.state, "open")
        with self.assertRaises(CircuitOpen):
            cb.call(lambda: 1)
        self.assertEqual(cb.call(boom, fallback=lambda: "fb"), "fb")  # open: fallback without calling boom
        t[0] += 11
        self.assertEqual(cb.state, "half_open")
        with self.assertRaises(RuntimeError):
            cb.call(boom)  # a failed probe re-opens
        self.assertEqual(cb.state, "open")
        t[0] += 11
        self.assertEqual(cb.call(lambda: "ok"), "ok")
        self.assertEqual(cb.state, "closed")
`;

const val = (f) => (f.type === "string" || f.type === "text" ? `"${f.name} 1"` : f.type === "int" ? "1" : f.type === "float" ? "1.5" : f.type === "bool" ? "True" : JSON.stringify(f.values[0]));
const payloadOf = (e) => "{" + e.fields.filter((f) => f.required || f.default === undefined).map((f) => `"${f.name}": ${val(f)}`).join(", ") + "}";
const otherOf = (e) => { const f = e.fields.find((x) => x.type === "string") || e.fields[0]; return f.type === "string" ? `{**PAYLOAD, "${f.name}": "different"}` : "PAYLOAD"; };

function fastapiApiTests(spec) {
  const e = spec.entities[0];
  const A = spec.needsAuth;
  return `"""HTTP-level tests of the distributed middleware against a REAL Redis."""
import os

import pytest
import redis
from fastapi.testclient import TestClient

URL = os.environ.get("REDIS_URL", "redis://localhost:6379/15")
PATH = "/api/${e.plural}"
PAYLOAD = ${payloadOf(e)}
OTHER = ${otherOf(e)}


@pytest.fixture()
def make_client(monkeypatch):
    c = redis.Redis.from_url(URL, decode_responses=True, socket_connect_timeout=1)
    try:
        c.ping()
    except redis.RedisError as exc:
        pytest.skip(f"REDIS UNAVAILABLE at {URL}: {exc}")
    c.flushdb()
    monkeypatch.setenv("REDIS_URL", URL)
    from app.main import create_app
    from app.db.session import Base, engine

    def make(limit):
        monkeypatch.setenv("RATE_LIMIT_PER_MINUTE", str(limit))
        Base.metadata.drop_all(engine)
        Base.metadata.create_all(engine)
        return TestClient(create_app())

    yield make
    c.flushdb()
${A ? `

def _headers(c):
    c.post("/api/auth/register", json={"email": "idem@example.com", "name": "I", "password": "password123"})
    t = c.post("/api/auth/login", json={"email": "idem@example.com", "password": "password123"}).json()["access_token"]
    return {"Authorization": "Bearer " + t}
` : `

def _headers(c):
    return {}
`}

def test_distributed_429_shared_counter_and_exempt_health(make_client):
    with make_client(6) as client:
        codes = [client.get("/openapi.json").status_code for _ in range(8)]
        assert codes == [200] * 6 + [429] * 2
        r = client.get("/openapi.json")
        assert int(r.headers["retry-after"]) >= 1 and r.json()["error"]["code"] == "rate_limited"
        assert client.get("/health").status_code == 200


def test_idempotent_post_creates_once_replays_and_rejects_key_reuse(make_client):
    with make_client(1000) as c:
        h = _headers(c)
        k = {**h, "Idempotency-Key": "key-1"}
        first = c.post(PATH, json=PAYLOAD, headers=k)
        second = c.post(PATH, json=PAYLOAD, headers=k)
        assert first.status_code == 201 and second.status_code == 201
        assert second.json() == first.json() and second.headers["idempotent-replay"] == "true"
        assert len(c.get(PATH, headers=h).json()) == 1  # created exactly once
        reuse = c.post(PATH, json=OTHER, headers=k)
        if OTHER != PAYLOAD:
            assert reuse.status_code == 422 and reuse.json()["error"]["code"] == "idempotency_key_reuse"
        c.post(PATH, json=PAYLOAD, headers=h)
        c.post(PATH, json=PAYLOAD, headers=h)  # no key: nothing is deduplicated
        assert len(c.get(PATH, headers=h).json()) == 3


def test_idempotency_keys_are_per_caller(make_client):
    with make_client(1000) as c:
        ${A ? `h1 = _headers(c)
        c.post("/api/auth/register", json={"email": "two@example.com", "name": "T", "password": "password123"})
        t2 = c.post("/api/auth/login", json={"email": "two@example.com", "password": "password123"}).json()["access_token"]
        h2 = {"Authorization": "Bearer " + t2}` : `h1 = h2 = {}`}
        a = c.post(PATH, json=PAYLOAD, headers={**h1, "Idempotency-Key": "shared"})
        b = c.post(PATH, json=PAYLOAD, headers={**h2, "Idempotency-Key": "shared"})
        ${A ? `assert a.status_code == 201 and b.status_code == 201 and "idempotent-replay" not in b.headers` : `assert a.status_code == 201 and b.headers["idempotent-replay"] == "true"  # no auth: callers share a scope`}


def test_failed_requests_are_not_cached(make_client):
    with make_client(1000) as c:
        h = {**_headers(c), "Idempotency-Key": "bad"}
        bad = {}
        r1 = c.post(PATH, json=bad, headers=h)
        r2 = c.post(PATH, json=bad, headers=h)
        assert r1.status_code == 422 and r2.status_code == 422  # a validation error is replayed as-is, never turned into a success


def test_fail_open_and_fail_closed_when_redis_is_down(monkeypatch):
    monkeypatch.setenv("REDIS_URL", "redis://127.0.0.1:1/0")
    monkeypatch.setenv("DISTRIBUTED_FAIL_OPEN", "true")
    from app.main import create_app
    with TestClient(create_app()) as tc:
        assert tc.get("/openapi.json").status_code == 200  # fail open
    monkeypatch.setenv("DISTRIBUTED_FAIL_OPEN", "false")
    with TestClient(create_app()) as tc:
        r = tc.get("/openapi.json")
        assert r.status_code == 503 and r.json()["error"]["code"] == "rate_limiter_unavailable"


def test_without_redis_url_distributed_features_are_disabled_not_faked(monkeypatch):
    monkeypatch.delenv("REDIS_URL", raising=False)
    from app.main import create_app
    app = create_app()
    assert not hasattr(app.state, "redis")
`;
}

const flaskAdapterPy = `import logging

from flask import Response, g, jsonify, request

from app.core.distributed import Guard

log = logging.getLogger("app.distributed")


def _respond(r: dict):
    if "raw" in r:
        resp = Response(r["raw"], status=r["status"], mimetype=r["content_type"])
    else:
        resp = jsonify(r["body"])
        resp.status_code = r["status"]
    for k, v in r["headers"].items():
        resp.headers[k] = v
    return resp


def init_distributed(app) -> None:
    guard = Guard.from_env()
    if guard is None:
        return
    app.extensions["redis"] = guard.client

    @app.before_request
    def _distributed_before():
        denied = guard.check_rate(request.path, request.remote_addr or "unknown")
        if denied:
            return _respond(denied)
        key = request.headers.get("Idempotency-Key")
        body = request.get_data() if request.method == "POST" and key else b""
        action, payload = guard.begin(request.method, request.path, request.headers.get("Authorization", ""), key, body)
        if action == "respond":
            return _respond(payload)
        if action == "proceed":
            g.idem_ctx = payload
        return None

    @app.after_request
    def _distributed_after(response):
        ctx = g.pop("idem_ctx", None)
        if ctx is not None:
            if response.direct_passthrough:
                guard.abort(ctx)
            else:
                guard.finish(ctx, response.status_code, response.get_data(as_text=True), response.mimetype or "application/json")
        return response
`;

function flaskApiTests(spec) {
  const e = spec.entities[0];
  const A = spec.needsAuth;
  return `"""HTTP-level tests of the distributed hooks against a REAL Redis."""
import os

import pytest
import redis

URL = os.environ.get("REDIS_URL", "redis://localhost:6379/15")
PATH = "/api/${e.plural}"
PAYLOAD = ${payloadOf(e)}
OTHER = ${otherOf(e)}


@pytest.fixture()
def make_client(monkeypatch):
    c = redis.Redis.from_url(URL, decode_responses=True, socket_connect_timeout=1)
    try:
        c.ping()
    except redis.RedisError as exc:
        pytest.skip(f"REDIS UNAVAILABLE at {URL}: {exc}")
    c.flushdb()
    monkeypatch.setenv("REDIS_URL", URL)
    from app.main import create_app
    from app.db.session import Base, engine

    def make(limit):
        monkeypatch.setenv("RATE_LIMIT_PER_MINUTE", str(limit))
        Base.metadata.drop_all(engine)
        app = create_app()
        app.config["TESTING"] = False
        return app.test_client()

    yield make
    c.flushdb()


def _headers(c, email="idem@example.com"):
    ${A ? `c.post("/api/auth/register", json={"email": email, "name": "I", "password": "password123"})
    t = c.post("/api/auth/login", json={"email": email, "password": "password123"}).get_json()["access_token"]
    return {"Authorization": "Bearer " + t}` : "return {}"}


def test_distributed_429_shared_counter_and_exempt_health(make_client):
    c = make_client(6)
    assert [c.get("/openapi.json").status_code for _ in range(8)] == [200] * 6 + [429] * 2
    r = c.get("/openapi.json")
    assert int(r.headers["Retry-After"]) >= 1 and r.get_json()["error"]["code"] == "rate_limited"
    assert c.get("/health").status_code == 200


def test_idempotent_post_creates_once_replays_and_rejects_key_reuse(make_client):
    c = make_client(1000)
    h = _headers(c)
    k = {**h, "Idempotency-Key": "key-1"}
    first = c.post(PATH, json=PAYLOAD, headers=k)
    second = c.post(PATH, json=PAYLOAD, headers=k)
    assert first.status_code == 201 and second.status_code == 201
    assert second.get_json() == first.get_json() and second.headers["Idempotent-Replay"] == "true"
    assert len(c.get(PATH, headers=h).get_json()) == 1  # created exactly once
    if OTHER != PAYLOAD:
        reuse = c.post(PATH, json=OTHER, headers=k)
        assert reuse.status_code == 422 and reuse.get_json()["error"]["code"] == "idempotency_key_reuse"
    c.post(PATH, json=PAYLOAD, headers=h)
    c.post(PATH, json=PAYLOAD, headers=h)
    assert len(c.get(PATH, headers=h).get_json()) == 3


def test_validation_errors_are_replayed_not_turned_into_success(make_client):
    c = make_client(1000)
    h = {**_headers(c), "Idempotency-Key": "bad"}
    assert c.post(PATH, json={}, headers=h).status_code == 422
    assert c.post(PATH, json={}, headers=h).status_code == 422


def test_fail_open_and_fail_closed_when_redis_is_down(monkeypatch):
    monkeypatch.setenv("REDIS_URL", "redis://127.0.0.1:1/0")
    from app.main import create_app
    monkeypatch.setenv("DISTRIBUTED_FAIL_OPEN", "true")
    assert create_app().test_client().get("/openapi.json").status_code == 200
    monkeypatch.setenv("DISTRIBUTED_FAIL_OPEN", "false")
    r = create_app().test_client().get("/openapi.json")
    assert r.status_code == 503 and r.get_json()["error"]["code"] == "rate_limiter_unavailable"


def test_without_redis_url_distributed_features_are_disabled_not_faked(monkeypatch):
    monkeypatch.delenv("REDIS_URL", raising=False)
    from app.main import create_app
    assert "redis" not in create_app().extensions
`;
}

const djangoAdapterPy = `import logging
import os

from django.http import HttpResponse, JsonResponse

from core.distributed import Guard

log = logging.getLogger("app.distributed")


def _respond(r: dict):
    if "raw" in r:
        resp = HttpResponse(r["raw"], status=r["status"], content_type=r["content_type"])
    else:
        resp = JsonResponse(r["body"], status=r["status"])
    for k, v in r["headers"].items():
        resp[k] = v
    return resp


class DistributedMiddleware:
    """Redis rate limit + Idempotency-Key. Active only when REDIS_URL is set (read per request so tests can change it)."""

    def __init__(self, get_response):
        self.get_response = get_response
        self._url = None
        self._guard = None

    def _g(self):
        url = os.environ.get("REDIS_URL")
        if url != self._url or (url and os.environ.get("RATE_LIMIT_PER_MINUTE") != getattr(self, "_limit", None)) or os.environ.get("DISTRIBUTED_FAIL_OPEN") != getattr(self, "_fo", None):
            self._url, self._limit, self._fo = url, os.environ.get("RATE_LIMIT_PER_MINUTE"), os.environ.get("DISTRIBUTED_FAIL_OPEN")
            self._guard = Guard.from_env()
        return self._guard

    def __call__(self, request):
        guard = self._g()
        if guard is None:
            return self.get_response(request)
        denied = guard.check_rate(request.path, request.META.get("REMOTE_ADDR") or "unknown")
        if denied:
            return _respond(denied)
        key = request.headers.get("Idempotency-Key")
        body = request.body if request.method == "POST" and key else b""
        action, payload = guard.begin(request.method, request.path, request.headers.get("Authorization", ""), key, body)
        if action == "respond":
            return _respond(payload)
        if action == "skip":
            return self.get_response(request)
        try:
            response = self.get_response(request)
        except Exception:
            guard.abort(payload)
            raise
        if getattr(response, "streaming", False):
            guard.abort(payload)
        else:
            guard.finish(payload, response.status_code, response.content.decode(), (response.get("Content-Type") or "application/json").split(";")[0])
        return response
`;

function djangoApiTests(spec) {
  const e = spec.entities[0];
  const A = spec.needsAuth;
  return `"""HTTP-level tests of the distributed middleware against a REAL Redis (Django test runner)."""
import json
import os
import unittest

import redis
from django.test import TestCase

URL = os.environ.get("REDIS_URL", "redis://localhost:6379/15")
PATH = "/api/${e.plural}"
PAYLOAD = ${payloadOf(e).replace(/True/g, "True")}
OTHER = ${otherOf(e)}


class DistributedApiTests(TestCase):
    def setUp(self):
        self.r = redis.Redis.from_url(URL, decode_responses=True, socket_connect_timeout=1)
        try:
            self.r.ping()
        except redis.RedisError as exc:
            self.skipTest(f"REDIS UNAVAILABLE at {URL}: {exc}")
        self.r.flushdb()
        self.addCleanup(self.r.flushdb)
        self._env = {k: os.environ.get(k) for k in ("REDIS_URL", "RATE_LIMIT_PER_MINUTE", "DISTRIBUTED_FAIL_OPEN")}
        self.addCleanup(self._restore)
        os.environ["REDIS_URL"] = URL
        os.environ["RATE_LIMIT_PER_MINUTE"] = "1000"
        os.environ.pop("DISTRIBUTED_FAIL_OPEN", None)

    def _restore(self):
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def post(self, body, headers=None, path=PATH):
        extra = {("HTTP_" + k.upper().replace("-", "_")): v for k, v in (headers or {}).items()}
        return self.client.post(path, data=json.dumps(body), content_type="application/json", **extra)

    def auth(self, email="idem@example.com"):
        ${A ? `self.post({"email": email, "name": "I", "password": "password123"}, path="/api/auth/register")
        tok = self.post({"email": email, "password": "password123"}, path="/api/auth/login").json()["access_token"]
        return {"Authorization": "Bearer " + tok}` : "return {}"}

    def listing(self, h):
        extra = {("HTTP_" + k.upper().replace("-", "_")): v for k, v in h.items()}
        return self.client.get(PATH, **extra).json()

    def test_distributed_429_shared_counter_and_exempt_health(self):
        os.environ["RATE_LIMIT_PER_MINUTE"] = "6"
        codes = [self.client.get("/openapi.json").status_code for _ in range(8)]
        self.assertEqual(codes, [200] * 6 + [429] * 2)
        r = self.client.get("/openapi.json")
        self.assertTrue(int(r["Retry-After"]) >= 1)
        self.assertEqual(r.json()["error"]["code"], "rate_limited")
        self.assertEqual(self.client.get("/health").status_code, 200)

    def test_idempotent_post_creates_once_replays_and_rejects_key_reuse(self):
        h = self.auth()
        k = {**h, "Idempotency-Key": "key-1"}
        first, second = self.post(PAYLOAD, k), self.post(PAYLOAD, k)
        self.assertEqual((first.status_code, second.status_code), (201, 201))
        self.assertEqual(second.json(), first.json())
        self.assertEqual(second["Idempotent-Replay"], "true")
        self.assertEqual(len(self.listing(h)), 1)  # created exactly once
        if OTHER != PAYLOAD:
            reuse = self.post(OTHER, k)
            self.assertEqual(reuse.status_code, 422)
            self.assertEqual(reuse.json()["error"]["code"], "idempotency_key_reuse")
        self.post(PAYLOAD, h)
        self.post(PAYLOAD, h)
        self.assertEqual(len(self.listing(h)), 3)

    def test_validation_errors_are_replayed_not_turned_into_success(self):
        h = {**self.auth(), "Idempotency-Key": "bad"}
        self.assertEqual(self.post({}, h).status_code, 422)
        self.assertEqual(self.post({}, h).status_code, 422)

    def test_fail_open_and_fail_closed_when_redis_is_down(self):
        os.environ["REDIS_URL"] = "redis://127.0.0.1:1/0"
        os.environ["DISTRIBUTED_FAIL_OPEN"] = "true"
        self.assertEqual(self.client.get("/openapi.json").status_code, 200)
        os.environ["DISTRIBUTED_FAIL_OPEN"] = "false"
        r = self.client.get("/openapi.json")
        self.assertEqual(r.status_code, 503)
        self.assertEqual(r.json()["error"]["code"], "rate_limiter_unavailable")

    def test_without_redis_url_distributed_features_are_disabled_not_faked(self):
        os.environ.pop("REDIS_URL")
        self.assertEqual(self.client.get("/openapi.json").status_code, 200)
        self.assertFalse(self.r.keys("rl:*"))
`;
}

const README_DIST = (impl) => `## Distributed features (Redis)
Enabled when \`REDIS_URL\` is set (without it they are disabled and a warning is logged - nothing falls back to in-memory counters). Implemented as ${impl}.
- **Rate limiting**: per client IP, atomic Lua counter shared by all instances, \`RATE_LIMIT_PER_MINUTE\` (default 120). Over the limit: \`429\` + \`Retry-After\`. If Redis is down: \`DISTRIBUTED_FAIL_OPEN=true\` (default) lets requests through, \`false\` answers \`503\`.
- **Idempotency**: send \`Idempotency-Key\` on \`POST\`. Same key + same body replays the stored response (\`Idempotent-Replay: true\`); same key + different body \`422\`; still running \`409\`. Entries expire after \`IDEMPOTENCY_TTL_SECONDS\`. 5xx responses are not stored. Keys are scoped by the Authorization header.
- **Lock** (\`RedisLock\`): SET NX PX with an owner token; release/extend only by the owner. It is a single-instance lock: not safe across Redis failover, no fencing tokens, and a holder paused longer than the TTL can lose it. Use it to avoid duplicate work, not as the only guard of a correctness invariant.
- **Circuit breaker** (\`CircuitBreaker\`): closed/open/half-open with threshold, recovery timeout and fallback. State is per process.
- Limits: X-Forwarded-For is not trusted; per-user limits are not implemented.
- Tests need a real Redis (\`REDIS_URL\`, default \`redis://localhost:6379/15\`) and are skipped with a reason otherwise.

## Known limitations`;

const ENV_DIST = "REDIS_URL=redis://localhost:6379/0\nDISTRIBUTED_FAIL_OPEN=true\nIDEMPOTENCY_TTL_SECONDS=86400\n";

function addRedisReq(req) { return req.includes("redis>=5") ? req : req.replace(/\n?$/, "\nredis>=5\n"); }

function fastapi(spec, f) {
  f["app/core/distributed.py"] = corePy;
  f["app/core/dist_middleware.py"] = middlewarePy;
  f["tests/test_distributed_redis.py"] = testsPy.replace("CORE_MODULE", "app.core.distributed");
  f["tests/test_distributed_api.py"] = fastapiApiTests(spec);
  f["app/main.py"] = must(must(f["app/main.py"], "from app.core.metrics import init_metrics\n", "from app.core.metrics import init_metrics\nfrom app.core.dist_middleware import init_distributed\n", "import"),
    "    init_metrics(app)\n", "    init_distributed(app)\n    init_metrics(app)\n", "call");
  f["requirements.txt"] = f["requirements.txt"].includes("redis>=5") ? f["requirements.txt"] : must(f["requirements.txt"], "# test", "redis>=5\n# test", "requirements");
  f[".env.example"] += ENV_DIST;
  f["README.md"] = must(f["README.md"], "## Known limitations", README_DIST("an ASGI middleware"), "readme");
}

function flask(spec, f) {
  f["app/core/distributed.py"] = corePy;
  f["app/core/dist_flask.py"] = flaskAdapterPy;
  f["tests/test_distributed_redis.py"] = testsPy.replace("CORE_MODULE", "app.core.distributed");
  f["tests/test_distributed_api.py"] = flaskApiTests(spec);
  f["app/main.py"] = must(must(f["app/main.py"], "from app.core.metrics import init_metrics\n", "from app.core.metrics import init_metrics\nfrom app.core.dist_flask import init_distributed\n", "flask import"),
    "    register_error_handlers(app)\n", "    register_error_handlers(app)\n    init_distributed(app)\n", "flask call");
  f["requirements.txt"] = addRedisReq(f["requirements.txt"]);
  f[".env.example"] += ENV_DIST;
  f["README.md"] = must(f["README.md"], "## Known limitations", README_DIST("Flask before/after_request hooks"), "readme");
}

function django(spec, f) {
  f["core/distributed.py"] = corePy;
  f["core/distributed_mw.py"] = djangoAdapterPy;
  f["api/tests/test_distributed_redis.py"] = testsPy.replace("CORE_MODULE", "core.distributed");
  f["api/tests/test_distributed_api.py"] = djangoApiTests(spec);
  f["config/settings.py"] = must(f["config/settings.py"], '"core.errors.ErrorMiddleware"]', '"core.distributed_mw.DistributedMiddleware", "core.errors.ErrorMiddleware"]', "django middleware");
  f["requirements.txt"] = addRedisReq(f["requirements.txt"]);
  f[".env.example"] += ENV_DIST;
  f["README.md"] = must(f["README.md"], "## Known limitations", README_DIST("a Django middleware"), "readme");
}


const nodeCoreJs = `"use strict";
// Redis-backed building blocks (ioredis). Every class takes an already-built client so tests can use a REAL server.
const crypto = require("node:crypto");

const RATE_LUA = "local c = redis.call('INCR', KEYS[1]) if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end local ttl = redis.call('PTTL', KEYS[1]) if ttl < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) ttl = tonumber(ARGV[1]) end return {c, ttl}";
const RELEASE_LUA = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
const EXTEND_LUA = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class RedisRateLimiter {
  constructor(client, limit, windowSeconds = 60, prefix = "rl") { Object.assign(this, { client, limit, windowMs: windowSeconds * 1000, prefix }); }
  // Atomic fixed window shared by every instance. Throws on Redis errors; the caller decides fail-open / fail-closed.
  async check(scope, ident) {
    if (this.limit <= 0) return { allowed: true, retryAfter: 0, remaining: -1 };
    const [count, ttl] = await this.client.eval(RATE_LUA, 1, this.prefix + ":" + scope + ":" + ident, this.windowMs);
    if (count > this.limit) return { allowed: false, retryAfter: Math.max(1, Math.ceil(ttl / 1000)), remaining: 0 };
    return { allowed: true, retryAfter: 0, remaining: this.limit - count };
  }
}

class IdempotencyStore {
  constructor(client, { ttlSeconds = 86400, lockSeconds = 60, prefix = "idem" } = {}) { Object.assign(this, { client, ttl: ttlSeconds, lockSeconds, prefix }); }
  k(key) { return this.prefix + ":" + key; }
  // -> {state: "new"|"in_progress"|"replay"|"mismatch", response?}
  async begin(key, fp) {
    const claim = JSON.stringify({ state: "processing", fp });
    for (let i = 0; i < 2; i++) {
      if (await this.client.set(this.k(key), claim, "EX", this.lockSeconds, "NX")) return { state: "new" };
      const raw = await this.client.get(this.k(key));
      if (raw === null) continue; // expired between SET and GET: claim again
      const rec = JSON.parse(raw);
      if (rec.fp !== fp) return { state: "mismatch" };
      return rec.state === "processing" ? { state: "in_progress" } : { state: "replay", response: rec.response };
    }
    return { state: "in_progress" };
  }
  async complete(key, fp, status, body, contentType) {
    await this.client.set(this.k(key), JSON.stringify({ state: "complete", fp, response: { status, body, contentType } }), "EX", this.ttl);
  }
  async abort(key) { await this.client.del(this.k(key)); }
}

class LockNotAcquired extends Error {}

// Single-instance Redis lock (SET NX PX + owner token, Lua compare-and-delete). Not safe across Redis failover, no fencing
// token, and a holder paused longer than ttl can lose it: use it to avoid duplicate work, not as the only guard of an invariant.
class RedisLock {
  constructor(client, name, { ttlMs = 10000, timeoutMs = 0, retryMs = 50, prefix = "lock" } = {}) { Object.assign(this, { client, key: prefix + ":" + name, ttlMs, timeoutMs, retryMs, token: null }); }
  async acquire() {
    const token = crypto.randomUUID();
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      if (await this.client.set(this.key, token, "PX", this.ttlMs, "NX")) { this.token = token; return true; }
      if (Date.now() >= deadline) return false;
      await sleep(this.retryMs);
    }
  }
  async release() {
    if (!this.token) return false;
    const ok = (await this.client.eval(RELEASE_LUA, 1, this.key, this.token)) === 1;
    this.token = null;
    return ok;
  }
  async extend(ttlMs) { return !!this.token && (await this.client.eval(EXTEND_LUA, 1, this.key, this.token, ttlMs || this.ttlMs)) === 1; }
  async run(fn) {
    if (!(await this.acquire())) throw new LockNotAcquired(this.key);
    try { return await fn(); } finally { await this.release(); }
  }
}

class CircuitOpen extends Error {}

// closed -> (failureThreshold consecutive failures) -> open -> (recoveryTimeoutMs) -> half_open -> success: closed / failure: open
class CircuitBreaker {
  constructor({ failureThreshold = 5, recoveryTimeoutMs = 30000, halfOpenMaxCalls = 1, now = Date.now } = {}) {
    Object.assign(this, { failureThreshold, recoveryTimeoutMs, halfOpenMaxCalls, now, _state: "closed", failures: 0, openedAt: 0, halfOpenCalls: 0 });
  }
  get state() {
    if (this._state === "open" && this.now() - this.openedAt >= this.recoveryTimeoutMs) { this._state = "half_open"; this.halfOpenCalls = 0; }
    return this._state;
  }
  async call(fn, { fallback } = {}) {
    const st = this.state;
    if (st === "open" || (st === "half_open" && this.halfOpenCalls >= this.halfOpenMaxCalls)) {
      if (fallback) return fallback();
      throw new CircuitOpen("circuit is open");
    }
    if (st === "half_open") this.halfOpenCalls++;
    try {
      const result = await fn();
      this._state = "closed"; this.failures = 0;
      return result;
    } catch (err) {
      this.failures++;
      if (this._state === "half_open" || this.failures >= this.failureThreshold) { this._state = "open"; this.openedAt = this.now(); }
      if (fallback) return fallback();
      throw err;
    }
  }
}

const EXEMPT = new Set(["/health", "/metrics"]);
const errBody = (code, message) => ({ error: { code, message, details: null } });

// Framework-agnostic request guard (Redis rate limit + Idempotency-Key) used by the framework adapters.
function createGuard({ env = process.env, Redis = require("ioredis") } = {}) {
  const url = env.REDIS_URL;
  if (!url) { console.warn("REDIS_URL is not set: distributed rate limiting and idempotency are DISABLED"); return null; }
  const client = new Redis(url, { connectTimeout: 500, commandTimeout: 500, maxRetriesPerRequest: 1, retryStrategy: (n) => Math.min(n * 200, 2000) });
  client.on("error", () => {}); // outages are handled per request (fail-open / fail-closed); never crash on a connection error
  const limiter = new RedisRateLimiter(client, Number(env.RATE_LIMIT_PER_MINUTE ?? 120));
  const idem = new IdempotencyStore(client, { ttlSeconds: Number(env.IDEMPOTENCY_TTL_SECONDS ?? 86400) });
  const failOpen = String(env.DISTRIBUTED_FAIL_OPEN ?? "true").toLowerCase() !== "false";
  return {
    client,
    async checkRate(path, ip) {
      if (EXEMPT.has(path)) return null;
      try {
        const r = await limiter.check("ip", ip || "unknown");
        return r.allowed ? null : { status: 429, body: errBody("rate_limited", "Too many requests"), headers: { "Retry-After": String(r.retryAfter) } };
      } catch (e) {
        console.error("rate limiter unavailable:", e.message);
        return failOpen ? null : { status: 503, body: errBody("rate_limiter_unavailable", "Rate limiter is unavailable"), headers: { "Retry-After": "1" } };
      }
    },
    // -> {action: "skip"} | {action: "respond", response} | {action: "proceed", ctx}
    async begin(method, path, auth, key, bodyText) {
      if (method !== "POST" || !key || EXEMPT.has(path)) return { action: "skip" };
      if (key.length > 200) return { action: "respond", response: { status: 422, body: errBody("invalid_idempotency_key", "Idempotency-Key must be at most 200 characters"), headers: {} } };
      const fp = crypto.createHash("sha256").update(path + "\\0" + bodyText).digest("hex");
      const scoped = crypto.createHash("sha256").update(auth + "|" + key).digest("hex"); // keys are per caller
      let r;
      try { r = await idem.begin(scoped, fp); } catch (e) {
        console.error("idempotency store unavailable:", e.message);
        return { action: "respond", response: { status: 503, body: errBody("idempotency_unavailable", "Idempotency store is unavailable"), headers: { "Retry-After": "1" } } };
      }
      if (r.state === "replay") return { action: "respond", response: { status: r.response.status, raw: r.response.body, contentType: r.response.contentType, headers: { "Idempotent-Replay": "true" } } };
      if (r.state === "in_progress") return { action: "respond", response: { status: 409, body: errBody("request_in_progress", "A request with this Idempotency-Key is still being processed"), headers: { "Retry-After": "1" } } };
      if (r.state === "mismatch") return { action: "respond", response: { status: 422, body: errBody("idempotency_key_reuse", "This Idempotency-Key was used with a different request"), headers: {} } };
      return { action: "proceed", ctx: { scoped, fp } };
    },
    async finish(ctx, status, body, contentType) {
      try {
        if (status >= 500) await idem.abort(ctx.scoped); // server errors are not cached: the client may retry with the same key
        else await idem.complete(ctx.scoped, ctx.fp, status, body, contentType);
      } catch (e) { console.error("could not store idempotent response:", e.message); }
    },
    async close() { try { await client.quit(); } catch { client.disconnect(); } },
  };
}

module.exports = { RedisRateLimiter, IdempotencyStore, RedisLock, LockNotAcquired, CircuitBreaker, CircuitOpen, createGuard };
`;

const fastifyAdapterJs = `"use strict";
const { createGuard } = require("./distributed");

// Fastify adapter: rate limit in onRequest, Idempotency-Key in preHandler (parsed body) + onSend (stores the response).
function registerDistributed(app, opts) {
  const guard = createGuard(opts);
  if (!guard) return;
  app.decorate("redis", guard.client);
  app.addHook("onClose", async () => guard.close());
  const send = (reply, r) => {
    for (const [k, v] of Object.entries(r.headers || {})) reply.header(k, v);
    reply.code(r.status);
    if (r.raw !== undefined) reply.type(r.contentType || "application/json").send(r.raw);
    else reply.send(r.body);
    return reply;
  };
  app.addHook("onRequest", async (req, reply) => {
    const denied = await guard.checkRate(req.url.split("?")[0], req.ip);
    if (denied) return send(reply, denied);
  });
  app.addHook("preHandler", async (req, reply) => {
    const key = req.headers["idempotency-key"];
    const r = await guard.begin(req.method, req.url.split("?")[0], req.headers.authorization || "", Array.isArray(key) ? key[0] : key, JSON.stringify(req.body ?? null));
    if (r.action === "respond") return send(reply, r.response);
    if (r.action === "proceed") req.idemCtx = r.ctx;
  });
  app.addHook("onSend", async (req, reply, payload) => {
    if (req.idemCtx) {
      const ctx = req.idemCtx;
      req.idemCtx = null;
      await guard.finish(ctx, reply.statusCode, typeof payload === "string" ? payload : String(payload ?? ""), String(reply.getHeader("content-type") || "application/json").split(";")[0]);
    }
    return payload;
  });
}

module.exports = { registerDistributed };
`;

const nodeCoreTests = `"use strict";
// Integration tests against a REAL Redis (REDIS_URL, default redis://localhost:6379/15). Skipped - never faked - if unreachable.
const test = require("node:test");
const assert = require("node:assert");
const Redis = require("ioredis");
const { RedisRateLimiter, IdempotencyStore, RedisLock, LockNotAcquired, CircuitBreaker, CircuitOpen } = require("../src/distributed");

// node --test runs test files in parallel and every file flushes its database: each file gets its own database index (this one: 15)
const URL_ = (() => { const u = new URL(process.env.REDIS_URL || "redis://localhost:6379"); u.pathname = "/15"; return u.toString(); })();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mk = () => { const c = new Redis(URL_, { lazyConnect: true, connectTimeout: 1000, maxRetriesPerRequest: 1, retryStrategy: () => null }); c.on("error", () => {}); return c; };

let redis, reason = null;
test.before(async () => {
  redis = mk();
  try { await redis.connect(); await redis.ping(); await redis.flushdb(); } catch (e) { reason = "REDIS UNAVAILABLE at " + URL_ + ": " + e.message + " - these tests need a real Redis"; }
});
test.after(async () => { if (!reason) await redis.flushdb(); redis.disconnect(); });
const real = (name, fn) => test(name, async (t) => { if (reason) return t.skip(reason); await redis.flushdb(); await fn(t); });

real("rate limit: one shared counter across two independent clients", async () => {
  const other = mk(); await other.connect();
  const a = new RedisRateLimiter(redis, 5, 60), b = new RedisRateLimiter(other, 5, 60);
  const res = [];
  for (let i = 0; i < 8; i++) res.push((await (i % 2 ? a : b).check("ip", "1.2.3.4")).allowed);
  assert.deepEqual(res, [true, true, true, true, true, false, false, false]);
  const blocked = await a.check("ip", "1.2.3.4");
  assert.ok(blocked.retryAfter >= 1 && blocked.retryAfter <= 60);
  assert.equal((await a.check("ip", "9.9.9.9")).allowed, true);
  other.disconnect();
});

real("rate limit: TTL expiry resets the window; atomic under 60 concurrent requests", async () => {
  const lim = new RedisRateLimiter(redis, 2, 1);
  assert.deepEqual([(await lim.check("ip", "x")).allowed, (await lim.check("ip", "x")).allowed, (await lim.check("ip", "x")).allowed], [true, true, false]);
  const ttl = await redis.pttl("rl:ip:x");
  assert.ok(ttl > 0 && ttl <= 1000);
  await sleep(1200);
  assert.equal(await redis.exists("rl:ip:x"), 0);
  assert.equal((await lim.check("ip", "x")).allowed, true);
  const big = new RedisRateLimiter(redis, 20, 60);
  const all = await Promise.all(Array.from({ length: 60 }, () => big.check("ip", "c")));
  assert.equal(all.filter((r) => r.allowed).length, 20);
});

real("rate limit: connection failure throws, healthy client keeps working", async () => {
  const dead = new Redis("redis://127.0.0.1:1", { lazyConnect: true, connectTimeout: 200, maxRetriesPerRequest: 0, retryStrategy: () => null, enableOfflineQueue: false });
  dead.on("error", () => {});
  await assert.rejects(new RedisRateLimiter(dead, 5, 60).check("ip", "z"));
  assert.equal((await new RedisRateLimiter(redis, 5, 60).check("ip", "z")).allowed, true);
  dead.disconnect();
});

real("idempotency: lifecycle, mismatch, expiry, abort", async () => {
  const s = new IdempotencyStore(redis, { ttlSeconds: 1, lockSeconds: 5 });
  assert.deepEqual(await s.begin("k", "fp1"), { state: "new" });
  assert.deepEqual(await s.begin("k", "fp1"), { state: "in_progress" });
  assert.equal((await s.begin("k", "other")).state, "mismatch");
  await s.complete("k", "fp1", 201, '{"id":1}', "application/json");
  const r = await s.begin("k", "fp1");
  assert.equal(r.state, "replay"); assert.equal(r.response.status, 201); assert.equal(r.response.body, '{"id":1}');
  await sleep(1200);
  assert.deepEqual(await s.begin("k", "fp1"), { state: "new" });
  await s.abort("k");
  assert.deepEqual(await s.begin("k", "fp1"), { state: "new" });
});

real("idempotency: 30 concurrent identical requests -> exactly one claims", async () => {
  const s = new IdempotencyStore(redis);
  const out = await Promise.all(Array.from({ length: 30 }, () => s.begin("same", "fp")));
  assert.equal(out.filter((o) => o.state === "new").length, 1);
  assert.equal(out.filter((o) => o.state === "in_progress").length, 29);
});

real("lock: mutual exclusion, owner-only release, stale holder cannot free the new owner's lock", async () => {
  const a = new RedisLock(redis, "job", { ttlMs: 5000 }), b = new RedisLock(redis, "job", { ttlMs: 5000 });
  assert.equal(await a.acquire(), true);
  assert.equal(await b.acquire(), false);
  b.token = "forged";
  assert.equal(await b.release(), false);
  assert.equal(await redis.exists("lock:job"), 1);
  assert.equal(await a.release(), true);
  const s1 = new RedisLock(redis, "job2", { ttlMs: 200 }), s2 = new RedisLock(redis, "job2", { ttlMs: 5000 });
  assert.equal(await s1.acquire(), true);
  await sleep(400);
  assert.equal(await s2.acquire(), true);
  assert.equal(await s1.release(), false);
  assert.equal(await redis.exists("lock:job2"), 1);
  assert.equal(await s2.extend(3000), true);
  assert.ok((await redis.pttl("lock:job2")) > 2000);
});

real("lock: waits within the timeout and run() releases; LockNotAcquired when it cannot", async () => {
  const holder = new RedisLock(redis, "w", { ttlMs: 300 });
  await holder.acquire();
  const t0 = Date.now();
  const got = await new RedisLock(redis, "w", { ttlMs: 1000, timeoutMs: 2000 }).run(async () => "done");
  assert.equal(got, "done"); assert.ok(Date.now() - t0 < 1500);
  assert.equal(await redis.exists("lock:w"), 0);
  await new RedisLock(redis, "w2", { ttlMs: 5000 }).acquire();
  await assert.rejects(new RedisLock(redis, "w2", { timeoutMs: 100 }).run(async () => 1), LockNotAcquired);
});

test("circuit breaker: closed -> open -> half_open -> closed, with fallback", async () => {
  let t = 0;
  const cb = new CircuitBreaker({ failureThreshold: 2, recoveryTimeoutMs: 10, now: () => t });
  const boom = async () => { throw new Error("down"); };
  for (let i = 0; i < 2; i++) await assert.rejects(cb.call(boom), /down/);
  assert.equal(cb.state, "open");
  await assert.rejects(cb.call(async () => 1), CircuitOpen);
  assert.equal(await cb.call(boom, { fallback: () => "fb" }), "fb");
  t += 11;
  assert.equal(cb.state, "half_open");
  await assert.rejects(cb.call(boom), /down/);
  assert.equal(cb.state, "open");
  t += 11;
  assert.equal(await cb.call(async () => "ok"), "ok");
  assert.equal(cb.state, "closed");
});
`;

function fastifyApiTests(spec) {
  const e = spec.entities[0];
  const A = spec.needsAuth;
  const req = e.fields.filter((f) => f.required || f.default === undefined);
  const jval = (f) => (f.type === "string" || f.type === "text" ? JSON.stringify(f.name + " 1") : f.type === "int" ? "1" : f.type === "float" ? "1.5" : f.type === "bool" ? "true" : JSON.stringify(f.values[0]));
  const payload = "{ " + req.map((f) => `${f.name}: ${jval(f)}`).join(", ") + " }";
  const sf = e.fields.find((x) => x.type === "string");
  return `"use strict";
// HTTP-level tests of the distributed hooks against a REAL Redis.
const test = require("node:test");
const assert = require("node:assert");
const Redis = require("ioredis");
const { buildApp } = require("../src/app");

// own database index (14): see distributed_redis.test.js
const URL_ = (() => { const u = new URL(process.env.REDIS_URL || "redis://localhost:6379"); u.pathname = "/14"; return u.toString(); })();
const PATH = "/api/${e.plural}";
const PAYLOAD = ${payload};
const OTHER = ${sf ? `{ ...PAYLOAD, ${sf.name}: "different" }` : "PAYLOAD"};
let reason = null;
test.before(async () => {
  const c = new Redis(URL_, { lazyConnect: true, connectTimeout: 1000, maxRetriesPerRequest: 1, retryStrategy: () => null });
  c.on("error", () => {});
  try { await c.connect(); await c.flushdb(); } catch (e) { reason = "REDIS UNAVAILABLE at " + URL_ + ": " + e.message; }
  c.disconnect();
});

async function make(env, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const app = await buildApp({ dbPath: ":memory:", jwtSecret: "test-secret-not-for-production-0123456789", rateLimitPerMinute: 0 });
  await app.ready();
  try { return await fn(app); } finally {
    await app.close();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
async function headers(app, email = "idem@example.com") {
  ${A ? `await app.inject({ method: "POST", url: "/api/auth/register", payload: { email, name: "I", password: "password123" } });
  const t = (await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "password123" } })).json().access_token;
  return { authorization: "Bearer " + t };` : "return {};"}
}
const real = (name, fn) => test(name, async (t) => { if (reason) return t.skip(reason); const c = new Redis(URL_); c.on("error", () => {}); await c.flushdb(); c.disconnect(); await fn(t); });

real("429 from the shared Redis counter, with Retry-After; /health exempt", () => make({ REDIS_URL: URL_, RATE_LIMIT_PER_MINUTE: "6" }, async (app) => {
  const codes = [];
  for (let i = 0; i < 8; i++) codes.push((await app.inject({ method: "GET", url: "/openapi.json" })).statusCode);
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 200, 429, 429]);
  const r = await app.inject({ method: "GET", url: "/openapi.json" });
  assert.ok(Number(r.headers["retry-after"]) >= 1);
  assert.equal(r.json().error.code, "rate_limited");
  assert.equal((await app.inject({ method: "GET", url: "/health" })).statusCode, 200);
}));

real("idempotent POST creates once, replays, rejects key reuse; no key = no dedupe", () => make({ REDIS_URL: URL_, RATE_LIMIT_PER_MINUTE: "1000" }, async (app) => {
  const h = await headers(app);
  const k = { ...h, "idempotency-key": "key-1" };
  const first = await app.inject({ method: "POST", url: PATH, headers: k, payload: PAYLOAD });
  const second = await app.inject({ method: "POST", url: PATH, headers: k, payload: PAYLOAD });
  assert.equal(first.statusCode, 201); assert.equal(second.statusCode, 201);
  assert.deepEqual(second.json(), first.json());
  assert.equal(second.headers["idempotent-replay"], "true");
  assert.equal((await app.inject({ method: "GET", url: PATH, headers: h })).json().length, 1);
  if (JSON.stringify(OTHER) !== JSON.stringify(PAYLOAD)) {
    const reuse = await app.inject({ method: "POST", url: PATH, headers: k, payload: OTHER });
    assert.equal(reuse.statusCode, 422); assert.equal(reuse.json().error.code, "idempotency_key_reuse");
  }
  await app.inject({ method: "POST", url: PATH, headers: h, payload: PAYLOAD });
  await app.inject({ method: "POST", url: PATH, headers: h, payload: PAYLOAD });
  assert.equal((await app.inject({ method: "GET", url: PATH, headers: h })).json().length, 3);
}));

real("a validation error is replayed as-is, never turned into a success", () => make({ REDIS_URL: URL_, RATE_LIMIT_PER_MINUTE: "1000" }, async (app) => {
  const k = { ...(await headers(app)), "idempotency-key": "bad" };
  assert.equal((await app.inject({ method: "POST", url: PATH, headers: k, payload: {} })).statusCode, 422);
  assert.equal((await app.inject({ method: "POST", url: PATH, headers: k, payload: {} })).statusCode, 422);
}));

test("Redis down: fail open by default, 503 when DISTRIBUTED_FAIL_OPEN=false", async () => {
  await make({ REDIS_URL: "redis://127.0.0.1:1/0", DISTRIBUTED_FAIL_OPEN: "true" }, async (app) => assert.equal((await app.inject({ method: "GET", url: "/openapi.json" })).statusCode, 200));
  await make({ REDIS_URL: "redis://127.0.0.1:1/0", DISTRIBUTED_FAIL_OPEN: "false" }, async (app) => {
    const r = await app.inject({ method: "GET", url: "/openapi.json" });
    assert.equal(r.statusCode, 503); assert.equal(r.json().error.code, "rate_limiter_unavailable");
  });
});

test("without REDIS_URL the distributed features are disabled, not faked", async () => {
  await make({ REDIS_URL: undefined }, async (app) => assert.equal(app.redis, undefined));
});
`;
}

function fastify(spec, f) {
  f["src/distributed.js"] = nodeCoreJs;
  f["src/dist_fastify.js"] = fastifyAdapterJs;
  f["test/distributed_redis.test.js"] = nodeCoreTests;
  f["test/distributed_api.test.js"] = fastifyApiTests(spec);
  const pkg = JSON.parse(f["package.json"]);
  pkg.dependencies = { ...pkg.dependencies, ioredis: "^5.4.1" };
  f["package.json"] = JSON.stringify(pkg, null, 2) + "\n";
  f["src/app.js"] = must(must(f["src/app.js"], "  app.decorate(\"db\", openDb(dbPath));\n", "  app.decorate(\"db\", openDb(dbPath));\n  registerDistributed(app);\n", "fastify register"),
    "\nasync function buildApp(", "\nconst { registerDistributed } = require(\"./dist_fastify\");\n\nasync function buildApp(", "fastify require");
  f[".env.example"] += ENV_DIST;
  f["README.md"] = must(f["README.md"], "## Known limitations", README_DIST("Fastify hooks (ioredis)").replace("`RedisLock`", "`RedisLock` (`src/distributed.js`)"), "readme");
}


const expressAdapterJs = `"use strict";
const { createGuard } = require("./distributed");

// Express adapter (after express.json, before the routes): rate limit, then Idempotency-Key; the response is captured by
// wrapping res.end so it is stored BEFORE it is sent.
function registerDistributed(app, opts) {
  const guard = createGuard(opts);
  if (!guard) return;
  app.locals.redis = guard.client;
  app.locals.closeDistributed = async () => guard.close();
  const send = (res, r) => {
    for (const [k, v] of Object.entries(r.headers || {})) res.set(k, v);
    res.status(r.status);
    if (r.raw !== undefined) return res.type(r.contentType || "application/json").send(r.raw);
    return res.json(r.body);
  };
  app.use(async (req, res, next) => {
    try {
      const path = req.path;
      const denied = await guard.checkRate(path, req.ip);
      if (denied) return send(res, denied);
      const key = req.headers["idempotency-key"];
      const r = await guard.begin(req.method, path, req.headers.authorization || "", Array.isArray(key) ? key[0] : key, JSON.stringify(req.body ?? null));
      if (r.action === "respond") return send(res, r.response);
      if (r.action === "proceed") {
        const ctx = r.ctx;
        const end = res.end;
        res.end = function (chunk, ...rest) {
          res.end = end;
          const body = chunk === undefined || chunk === null || typeof chunk === "function" ? "" : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
          guard.finish(ctx, res.statusCode, body, String(res.getHeader("content-type") || "application/json").split(";")[0]).catch(() => {}).then(() => end.call(res, chunk, ...rest));
          return res;
        };
        // a connection that drops before the handler answers leaves the claim to expire (60 s) instead of blocking the key forever
      }
      return next();
    } catch (e) { return next(e); }
  });
}

module.exports = { registerDistributed };
`;

function expressApiTests(spec) {
  const e = spec.entities[0];
  const A = spec.needsAuth;
  const req = e.fields.filter((f) => f.required || f.default === undefined);
  const jval = (f) => (f.type === "string" || f.type === "text" ? JSON.stringify(f.name + " 1") : f.type === "int" ? "1" : f.type === "float" ? "1.5" : f.type === "bool" ? "true" : JSON.stringify(f.values[0]));
  const payload = "{ " + req.map((f) => `${f.name}: ${jval(f)}`).join(", ") + " }";
  return `// HTTP-level tests of the distributed middleware against a REAL Redis (own database index 14). Skipped, never faked, if
// Redis is unreachable. Like every test of this project they also need MongoDB (MONGODB_URI) for the routes that store data.
const request = require("supertest");
const Redis = require("ioredis");
const mongoose = require("mongoose");

const URL_ = (() => { const u = new URL(process.env.REDIS_URL || "redis://localhost:6379"); u.pathname = "/14"; return u.toString(); })();
const PATH = "/api/${e.plural}";
const PAYLOAD = ${payload};
let reason = null;

beforeAll(async () => {
  const c = new Redis(URL_, { lazyConnect: true, connectTimeout: 1000, maxRetriesPerRequest: 1, retryStrategy: () => null });
  c.on("error", () => {});
  try { await c.connect(); await c.flushdb(); } catch (e) { reason = "REDIS UNAVAILABLE at " + URL_ + ": " + e.message; }
  c.disconnect();
  if (process.env.MONGODB_URI) await mongoose.connect(process.env.MONGODB_URI);
});
afterAll(async () => { await mongoose.disconnect(); });

async function withApp(env, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const { createApp } = require("../src/app");
  const app = createApp();
  try { return await fn(app); } finally {
    if (app.locals.closeDistributed) await app.locals.closeDistributed();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const real = (name, fn) => it(name, async () => {
  if (reason) { console.warn("SKIPPED: " + reason); return; }
  const c = new Redis(URL_); c.on("error", () => {}); await c.flushdb(); c.disconnect();
  await fn();
});

describe("distributed (Redis)", () => {
  real("429 from the shared Redis counter, with Retry-After; /health exempt", () => withApp({ REDIS_URL: URL_, RATE_LIMIT_PER_MINUTE: "6" }, async (app) => {
    const codes = [];
    for (let i = 0; i < 8; i++) codes.push((await request(app).get("/api/__nothing__")).status);
    expect(codes).toEqual([404, 404, 404, 404, 404, 404, 429, 429]);
    const r = await request(app).get("/api/__nothing__");
    expect(Number(r.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(r.body.error.code).toBe("rate_limited");
    expect((await request(app).get("/health")).status).toBe(200);
  }));

  real("a failed POST is replayed as-is under the same key; the same key with a different body is 422", () => withApp({ REDIS_URL: URL_, RATE_LIMIT_PER_MINUTE: "1000" }, async (app) => {
    const h = { "Idempotency-Key": "bad-1" };
    const first = await request(app).post(PATH).set(h).send({});
    const second = await request(app).post(PATH).set(h).send({});
    expect(first.status).toBeGreaterThanOrEqual(400);
    expect(second.status).toBe(first.status);
    expect(second.headers["idempotent-replay"]).toBe("true");
    const reuse = await request(app).post(PATH).set(h).send({ other: 1 });
    expect(reuse.status).toBe(422);
    expect(reuse.body.error.code).toBe("idempotency_key_reuse");
  }));

  real("a successful POST runs the handler once and the stored 201 is replayed (bare Express app, no database)", async () => {
    const express = require("express");
    const { registerDistributed } = require("../src/dist_express");
    const saved = process.env.REDIS_URL; process.env.REDIS_URL = URL_; process.env.RATE_LIMIT_PER_MINUTE = "1000";
    const app = express();
    app.use(express.json());
    registerDistributed(app);
    let runs = 0;
    app.post("/things", (req, res) => { runs++; res.status(201).json({ id: runs, got: req.body }); });
    try {
      const h = { "Idempotency-Key": "once-1" };
      const a = await request(app).post("/things").set(h).send({ x: 1 });
      const b = await request(app).post("/things").set(h).send({ x: 1 });
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(b.body).toEqual(a.body);
      expect(b.headers["idempotent-replay"]).toBe("true");
      expect(runs).toBe(1);
      await request(app).post("/things").send({ x: 1 });
      await request(app).post("/things").send({ x: 1 });
      expect(runs).toBe(3); // no key = no dedupe
    } finally {
      await app.locals.closeDistributed();
      if (saved === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = saved;
      delete process.env.RATE_LIMIT_PER_MINUTE;
    }
  });

  real("idempotent POST creates once (needs MongoDB)", () => withApp({ REDIS_URL: URL_, RATE_LIMIT_PER_MINUTE: "1000" }, async (app) => {
    ${A ? `const email = "idem" + Date.now() + "@example.com";
    await request(app).post("/api/auth/register").send({ name: "I", email, password: "password123" });
    const login = await request(app).post("/api/auth/login").send({ email, password: "password123" });
    const auth = { Authorization: "Bearer " + login.body.token };` : "const auth = {};"}
    const k = { ...auth, "Idempotency-Key": "key-" + Date.now() };
    const first = await request(app).post(PATH).set(k).send(PAYLOAD);
    const second = await request(app).post(PATH).set(k).send(PAYLOAD);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers["idempotent-replay"]).toBe("true");
    const list = await request(app).get(PATH).set(auth);
    expect(list.body.filter((x) => x._id === first.body._id).length).toBe(1);
  }));

  it("Redis down: fail open by default, 503 when DISTRIBUTED_FAIL_OPEN=false", async () => {
    await withApp({ REDIS_URL: "redis://127.0.0.1:1/0", DISTRIBUTED_FAIL_OPEN: "true" }, async (app) => expect((await request(app).get("/health")).status).toBe(200));
    await withApp({ REDIS_URL: "redis://127.0.0.1:1/0", DISTRIBUTED_FAIL_OPEN: "false" }, async (app) => {
      const r = await request(app).get("/api/__nothing__");
      expect(r.status).toBe(503);
      expect(r.body.error.code).toBe("rate_limiter_unavailable");
    });
  });

  it("without REDIS_URL the distributed features are disabled, not faked", async () => {
    await withApp({ REDIS_URL: undefined }, async (app) => expect(app.locals.redis).toBeUndefined());
  });
});
`;
}

function express(spec, f) {
  f["src/distributed.js"] = nodeCoreJs;
  f["src/dist_express.js"] = expressAdapterJs;
  f["test/distributed_redis.node.js"] = nodeCoreTests.replace("// Integration tests against", "// Run by `npm run test:redis` (node:test, not jest): integration tests against");
  f["test/distributed_api.test.js"] = expressApiTests(spec);
  const pkg = JSON.parse(f["package.json"]);
  pkg.dependencies = { ...pkg.dependencies, ioredis: "^5.4.1" };
  pkg.scripts = { ...pkg.scripts, "test:redis": "node --test test/distributed_redis.node.js", test: "jest --runInBand --forceExit && node --test test/distributed_redis.node.js" };
  f["package.json"] = JSON.stringify(pkg, null, 2) + "\n";
  f["src/app.js"] = must(must(f["src/app.js"], "  app.use(express.json());\n", "  app.use(express.json());\n  registerDistributed(app);\n", "express register"),
    "\nfunction createApp()", "\nconst { registerDistributed } = require(\"./dist_express\");\n\nfunction createApp()", "express require");
  f[".env.example"] += (f[".env.example"].endsWith("\n") ? "" : "\n") + ENV_DIST;
  f["README.md"] += "\n" + README_DIST("Express middleware (ioredis)");
}

const nestCoreTs = `// Redis-backed building blocks (ioredis). Every class takes an already-built client so tests can use a REAL server.
import { randomUUID, createHash } from "node:crypto";
import { Redis } from "ioredis";

const RATE_LUA = "local c = redis.call('INCR', KEYS[1]) if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end local ttl = redis.call('PTTL', KEYS[1]) if ttl < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) ttl = tonumber(ARGV[1]) end return {c, ttl}";
const RELEASE_LUA = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
const EXTEND_LUA = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class RedisRateLimiter {
  constructor(private client: Redis, private limit: number, private windowSeconds = 60, private prefix = "rl") {}
  // Atomic fixed window shared by every instance. Throws on Redis errors; the caller decides fail-open / fail-closed.
  async check(scope: string, ident: string): Promise<{ allowed: boolean; retryAfter: number; remaining: number }> {
    if (this.limit <= 0) return { allowed: true, retryAfter: 0, remaining: -1 };
    const [count, ttl] = (await this.client.eval(RATE_LUA, 1, this.prefix + ":" + scope + ":" + ident, this.windowSeconds * 1000)) as [number, number];
    if (count > this.limit) return { allowed: false, retryAfter: Math.max(1, Math.ceil(ttl / 1000)), remaining: 0 };
    return { allowed: true, retryAfter: 0, remaining: this.limit - count };
  }
}

export interface StoredResponse { status: number; body: string; contentType: string }
export type BeginResult = { state: "new" | "in_progress" | "mismatch" } | { state: "replay"; response: StoredResponse };

export class IdempotencyStore {
  private ttl: number; private lockSeconds: number; private prefix: string;
  constructor(private client: Redis, o: { ttlSeconds?: number; lockSeconds?: number; prefix?: string } = {}) {
    this.ttl = o.ttlSeconds ?? 86400; this.lockSeconds = o.lockSeconds ?? 60; this.prefix = o.prefix ?? "idem";
  }
  private k(key: string) { return this.prefix + ":" + key; }
  async begin(key: string, fp: string): Promise<BeginResult> {
    const claim = JSON.stringify({ state: "processing", fp });
    for (let i = 0; i < 2; i++) {
      if (await this.client.set(this.k(key), claim, "EX", this.lockSeconds, "NX")) return { state: "new" };
      const raw = await this.client.get(this.k(key));
      if (raw === null) continue; // expired between SET and GET: claim again
      const rec = JSON.parse(raw);
      if (rec.fp !== fp) return { state: "mismatch" };
      return rec.state === "processing" ? { state: "in_progress" } : { state: "replay", response: rec.response };
    }
    return { state: "in_progress" };
  }
  async complete(key: string, fp: string, status: number, body: string, contentType: string) {
    await this.client.set(this.k(key), JSON.stringify({ state: "complete", fp, response: { status, body, contentType } }), "EX", this.ttl);
  }
  async abort(key: string) { await this.client.del(this.k(key)); }
}

export class LockNotAcquired extends Error {}

// Single-instance Redis lock (SET NX PX + owner token, Lua compare-and-delete). Not safe across Redis failover, no fencing
// token, and a holder paused longer than ttl can lose it: use it to avoid duplicate work, not as the only guard of an invariant.
export class RedisLock {
  token: string | null = null;
  private key: string; private ttlMs: number; private timeoutMs: number; private retryMs: number;
  constructor(private client: Redis, name: string, o: { ttlMs?: number; timeoutMs?: number; retryMs?: number; prefix?: string } = {}) {
    this.key = (o.prefix ?? "lock") + ":" + name; this.ttlMs = o.ttlMs ?? 10000; this.timeoutMs = o.timeoutMs ?? 0; this.retryMs = o.retryMs ?? 50;
  }
  async acquire(): Promise<boolean> {
    const token = randomUUID();
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      if (await this.client.set(this.key, token, "PX", this.ttlMs, "NX")) { this.token = token; return true; }
      if (Date.now() >= deadline) return false;
      await sleep(this.retryMs);
    }
  }
  async release(): Promise<boolean> {
    if (!this.token) return false;
    const ok = (await this.client.eval(RELEASE_LUA, 1, this.key, this.token)) === 1;
    this.token = null;
    return ok;
  }
  async extend(ttlMs?: number): Promise<boolean> { return !!this.token && (await this.client.eval(EXTEND_LUA, 1, this.key, this.token, ttlMs ?? this.ttlMs)) === 1; }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (!(await this.acquire())) throw new LockNotAcquired(this.key);
    try { return await fn(); } finally { await this.release(); }
  }
}

export class CircuitOpen extends Error {}

// closed -> (failureThreshold consecutive failures) -> open -> (recoveryTimeoutMs) -> half_open -> success: closed / failure: open
export class CircuitBreaker {
  private _state: "closed" | "open" | "half_open" = "closed";
  private failures = 0; private openedAt = 0; private halfOpenCalls = 0;
  private failureThreshold: number; private recoveryTimeoutMs: number; private halfOpenMaxCalls: number; private now: () => number;
  constructor(o: { failureThreshold?: number; recoveryTimeoutMs?: number; halfOpenMaxCalls?: number; now?: () => number } = {}) {
    this.failureThreshold = o.failureThreshold ?? 5; this.recoveryTimeoutMs = o.recoveryTimeoutMs ?? 30000; this.halfOpenMaxCalls = o.halfOpenMaxCalls ?? 1; this.now = o.now ?? Date.now;
  }
  get state() {
    if (this._state === "open" && this.now() - this.openedAt >= this.recoveryTimeoutMs) { this._state = "half_open"; this.halfOpenCalls = 0; }
    return this._state;
  }
  async call<T>(fn: () => Promise<T>, o: { fallback?: () => T | Promise<T> } = {}): Promise<T> {
    const st = this.state;
    if (st === "open" || (st === "half_open" && this.halfOpenCalls >= this.halfOpenMaxCalls)) {
      if (o.fallback) return o.fallback();
      throw new CircuitOpen("circuit is open");
    }
    if (st === "half_open") this.halfOpenCalls++;
    try {
      const result = await fn();
      this._state = "closed"; this.failures = 0;
      return result;
    } catch (err) {
      this.failures++;
      if (this._state === "half_open" || this.failures >= this.failureThreshold) { this._state = "open"; this.openedAt = this.now(); }
      if (o.fallback) return o.fallback();
      throw err;
    }
  }
}

const EXEMPT = new Set(["/health", "/metrics"]);
const errBody = (code: string, message: string) => ({ error: { code, message, details: null } });

export interface GuardResponse { status: number; body?: unknown; raw?: string; contentType?: string; headers: Record<string, string> }
export type BeginOutcome = { action: "skip" } | { action: "respond"; response: GuardResponse } | { action: "proceed"; ctx: { scoped: string; fp: string } };

// Framework-agnostic request guard (Redis rate limit + Idempotency-Key) used by the Express/Nest middleware.
export function createGuard(env: NodeJS.ProcessEnv = process.env) {
  const url = env.REDIS_URL;
  if (!url) { console.warn("REDIS_URL is not set: distributed rate limiting and idempotency are DISABLED"); return null; }
  const client = new Redis(url, { connectTimeout: 500, commandTimeout: 500, maxRetriesPerRequest: 1, retryStrategy: (n) => Math.min(n * 200, 2000) });
  client.on("error", () => {}); // outages are handled per request (fail-open / fail-closed); never crash on a connection error
  const limiter = new RedisRateLimiter(client, Number(env.RATE_LIMIT_PER_MINUTE ?? 120));
  const idem = new IdempotencyStore(client, { ttlSeconds: Number(env.IDEMPOTENCY_TTL_SECONDS ?? 86400) });
  const failOpen = String(env.DISTRIBUTED_FAIL_OPEN ?? "true").toLowerCase() !== "false";
  return {
    client,
    async checkRate(path: string, ip: string): Promise<GuardResponse | null> {
      if (EXEMPT.has(path)) return null;
      try {
        const r = await limiter.check("ip", ip || "unknown");
        return r.allowed ? null : { status: 429, body: errBody("rate_limited", "Too many requests"), headers: { "Retry-After": String(r.retryAfter) } };
      } catch (e: any) {
        console.error("rate limiter unavailable:", e.message);
        return failOpen ? null : { status: 503, body: errBody("rate_limiter_unavailable", "Rate limiter is unavailable"), headers: { "Retry-After": "1" } };
      }
    },
    async begin(method: string, path: string, auth: string, key: string | undefined, bodyText: string): Promise<BeginOutcome> {
      if (method !== "POST" || !key || EXEMPT.has(path)) return { action: "skip" };
      if (key.length > 200) return { action: "respond", response: { status: 422, body: errBody("invalid_idempotency_key", "Idempotency-Key must be at most 200 characters"), headers: {} } };
      const fp = createHash("sha256").update(path + "\\\\0" + bodyText).digest("hex");
      const scoped = createHash("sha256").update(auth + "|" + key).digest("hex"); // keys are per caller
      let r: BeginResult;
      try { r = await idem.begin(scoped, fp); } catch (e: any) {
        console.error("idempotency store unavailable:", e.message);
        return { action: "respond", response: { status: 503, body: errBody("idempotency_unavailable", "Idempotency store is unavailable"), headers: { "Retry-After": "1" } } };
      }
      if (r.state === "replay") return { action: "respond", response: { status: r.response.status, raw: r.response.body, contentType: r.response.contentType, headers: { "Idempotent-Replay": "true" } } };
      if (r.state === "in_progress") return { action: "respond", response: { status: 409, body: errBody("request_in_progress", "A request with this Idempotency-Key is still being processed"), headers: { "Retry-After": "1" } } };
      if (r.state === "mismatch") return { action: "respond", response: { status: 422, body: errBody("idempotency_key_reuse", "This Idempotency-Key was used with a different request"), headers: {} } };
      return { action: "proceed", ctx: { scoped, fp } };
    },
    async finish(ctx: { scoped: string; fp: string }, status: number, body: string, contentType: string) {
      try {
        if (status >= 500) await idem.abort(ctx.scoped); // server errors are not cached: the client may retry with the same key
        else await idem.complete(ctx.scoped, ctx.fp, status, body, contentType);
      } catch (e: any) { console.error("could not store idempotent response:", e.message); }
    },
    async close() { try { await client.quit(); } catch { client.disconnect(); } },
  };
}
`;

const nestMiddlewareTs = `import { json } from "express";
import { createGuard, GuardResponse } from "./distributed";

function send(res: any, r: GuardResponse) {
  for (const [k, v] of Object.entries(r.headers)) res.set(k, v);
  res.status(r.status);
  if (r.raw !== undefined) res.type(r.contentType || "application/json").send(r.raw);
  else res.json(r.body);
}

// Express middleware used by NestJS (Express adapter). The body is parsed here (body-parser skips an already-parsed body)
// so the Idempotency-Key request fingerprint is available before the handler runs.
export function createDistributed(env: NodeJS.ProcessEnv = process.env) {
  const guard = createGuard(env);
  if (!guard) return null;
  const parse = json();
  const middleware = async (req: any, res: any, next: (e?: unknown) => void) => {
    try {
      const path = String(req.originalUrl || req.url).split("?")[0];
      const denied = await guard.checkRate(path, req.ip || req.socket?.remoteAddress || "unknown");
      if (denied) return send(res, denied);
      const raw = req.headers["idempotency-key"];
      const key = Array.isArray(raw) ? raw[0] : raw;
      if (req.method !== "POST" || !key) return next();
      try { await new Promise<void>((ok, bad) => parse(req, res, (e?: unknown) => (e ? bad(e) : ok()))); }
      catch { return send(res, { status: 400, body: { error: { code: "invalid_json", message: "Malformed JSON body", details: null } }, headers: {} }); }
      const r = await guard.begin(req.method, path, String(req.headers.authorization || ""), key, JSON.stringify(req.body ?? null));
      if (r.action === "respond") return send(res, r.response);
      if (r.action === "proceed") {
        const ctx = r.ctx;
        const chunks: Buffer[] = [];
        const write = res.write.bind(res), end = res.end.bind(res);
        res.write = (c: any, ...a: any[]) => { if (c && typeof c !== "function") chunks.push(Buffer.from(c)); return write(c, ...a); };
        res.end = (c?: any, ...a: any[]) => {
          if (c && typeof c !== "function") chunks.push(Buffer.from(c));
          const ct = String(res.getHeader("content-type") || "application/json").split(";")[0];
          // store the response BEFORE sending it, so an immediate retry always sees the finished record
          void guard.finish(ctx, res.statusCode, Buffer.concat(chunks).toString(), ct).finally(() => end(c, ...a));
          return res;
        };
      }
      return next();
    } catch (e) { return next(e); }
  };
  return { middleware, close: () => guard.close() };
}
`;

const nestCoreTestTs = `// Integration tests against a REAL Redis (REDIS_URL, default redis://localhost:6379/15). SKIPPED (never faked) if unreachable.
import { spawnSync } from "node:child_process";
import { Redis } from "ioredis";
import { RedisRateLimiter, IdempotencyStore, RedisLock, LockNotAcquired, CircuitBreaker, CircuitOpen } from "../src/common/distributed";

// jest runs test files in parallel workers and every file flushes its database: each file gets its own database index (this one: 15)
const URL_ = (() => { const u = new URL(process.env.SIERRA_TEST_REDIS_URL || "redis://localhost:6379"); u.pathname = "/15"; return u.toString(); })();
const u = new URL(URL_);
const probe = spawnSync(process.execPath, ["-e", "const s=require('net').connect(+process.argv[2],process.argv[1]);s.setTimeout(800);s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(1));s.on('timeout',()=>process.exit(1))", u.hostname, u.port || "6379"]);
const reachable = probe.status === 0;
if (!reachable) console.warn("REDIS UNAVAILABLE at " + URL_ + ": distributed tests are SKIPPED, not passed");
const real = reachable ? it : it.skip;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mk = () => { const c = new Redis(URL_, { lazyConnect: true, connectTimeout: 1000, maxRetriesPerRequest: 1, retryStrategy: () => null }); c.on("error", () => {}); return c; };

describe("distributed building blocks (real Redis)", () => {
  let redis: Redis;
  beforeAll(async () => { if (!reachable) return; redis = mk(); await redis.connect(); });
  beforeEach(async () => { if (reachable) await redis.flushdb(); });
  afterAll(async () => { if (reachable) { await redis.flushdb(); redis.disconnect(); } });

  real("rate limit: one shared counter across two independent clients", async () => {
    const other = mk(); await other.connect();
    const a = new RedisRateLimiter(redis, 5, 60), b = new RedisRateLimiter(other, 5, 60);
    const res: boolean[] = [];
    for (let i = 0; i < 8; i++) res.push((await (i % 2 ? a : b).check("ip", "1.2.3.4")).allowed);
    expect(res).toEqual([true, true, true, true, true, false, false, false]);
    const blocked = await a.check("ip", "1.2.3.4");
    expect(blocked.retryAfter).toBeGreaterThanOrEqual(1);
    expect(blocked.retryAfter).toBeLessThanOrEqual(60);
    expect((await a.check("ip", "9.9.9.9")).allowed).toBe(true);
    other.disconnect();
  });

  real("rate limit: TTL expiry resets the window; atomic under 60 concurrent requests", async () => {
    const lim = new RedisRateLimiter(redis, 2, 1);
    expect([(await lim.check("ip", "x")).allowed, (await lim.check("ip", "x")).allowed, (await lim.check("ip", "x")).allowed]).toEqual([true, true, false]);
    const ttl = await redis.pttl("rl:ip:x");
    expect(ttl).toBeGreaterThan(0); expect(ttl).toBeLessThanOrEqual(1000);
    await sleep(1200);
    expect(await redis.exists("rl:ip:x")).toBe(0);
    expect((await lim.check("ip", "x")).allowed).toBe(true);
    const big = new RedisRateLimiter(redis, 20, 60);
    const all = await Promise.all(Array.from({ length: 60 }, () => big.check("ip", "c")));
    expect(all.filter((r) => r.allowed)).toHaveLength(20);
  });

  real("rate limit: connection failure throws", async () => {
    const dead = new Redis("redis://127.0.0.1:1", { lazyConnect: true, connectTimeout: 200, maxRetriesPerRequest: 0, retryStrategy: () => null, enableOfflineQueue: false });
    dead.on("error", () => {});
    await expect(new RedisRateLimiter(dead, 5, 60).check("ip", "z")).rejects.toBeTruthy();
    expect((await new RedisRateLimiter(redis, 5, 60).check("ip", "z")).allowed).toBe(true);
    dead.disconnect();
  });

  real("idempotency: lifecycle, mismatch, expiry, abort", async () => {
    const s = new IdempotencyStore(redis, { ttlSeconds: 1, lockSeconds: 5 });
    expect(await s.begin("k", "fp1")).toEqual({ state: "new" });
    expect(await s.begin("k", "fp1")).toEqual({ state: "in_progress" });
    expect((await s.begin("k", "other")).state).toBe("mismatch");
    await s.complete("k", "fp1", 201, '{"id":1}', "application/json");
    const r: any = await s.begin("k", "fp1");
    expect(r.state).toBe("replay"); expect(r.response.status).toBe(201); expect(r.response.body).toBe('{"id":1}');
    await sleep(1200);
    expect(await s.begin("k", "fp1")).toEqual({ state: "new" });
    await s.abort("k");
    expect(await s.begin("k", "fp1")).toEqual({ state: "new" });
  });

  real("idempotency: 30 concurrent identical requests -> exactly one claims", async () => {
    const s = new IdempotencyStore(redis);
    const out = await Promise.all(Array.from({ length: 30 }, () => s.begin("same", "fp")));
    expect(out.filter((o) => o.state === "new")).toHaveLength(1);
    expect(out.filter((o) => o.state === "in_progress")).toHaveLength(29);
  });

  real("lock: mutual exclusion, owner-only release, stale holder cannot free the new owner's lock", async () => {
    const a = new RedisLock(redis, "job", { ttlMs: 5000 }), b = new RedisLock(redis, "job", { ttlMs: 5000 });
    expect(await a.acquire()).toBe(true);
    expect(await b.acquire()).toBe(false);
    b.token = "forged";
    expect(await b.release()).toBe(false);
    expect(await redis.exists("lock:job")).toBe(1);
    expect(await a.release()).toBe(true);
    const s1 = new RedisLock(redis, "job2", { ttlMs: 200 }), s2 = new RedisLock(redis, "job2", { ttlMs: 5000 });
    expect(await s1.acquire()).toBe(true);
    await sleep(400);
    expect(await s2.acquire()).toBe(true);
    expect(await s1.release()).toBe(false);
    expect(await redis.exists("lock:job2")).toBe(1);
    expect(await s2.extend(3000)).toBe(true);
    expect(await redis.pttl("lock:job2")).toBeGreaterThan(2000);
  });

  real("lock: waits within the timeout and run() releases; LockNotAcquired when it cannot", async () => {
    const holder = new RedisLock(redis, "w", { ttlMs: 300 });
    await holder.acquire();
    const t0 = Date.now();
    expect(await new RedisLock(redis, "w", { ttlMs: 1000, timeoutMs: 2000 }).run(async () => "done")).toBe("done");
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(await redis.exists("lock:w")).toBe(0);
    await new RedisLock(redis, "w2", { ttlMs: 5000 }).acquire();
    await expect(new RedisLock(redis, "w2", { timeoutMs: 100 }).run(async () => 1)).rejects.toBeInstanceOf(LockNotAcquired);
  });
});

describe("circuit breaker", () => {
  it("closed -> open -> half_open -> closed, with fallback", async () => {
    let t = 0;
    const cb = new CircuitBreaker({ failureThreshold: 2, recoveryTimeoutMs: 10, now: () => t });
    const boom = async (): Promise<string> => { throw new Error("down"); };
    for (let i = 0; i < 2; i++) await expect(cb.call(boom)).rejects.toThrow("down");
    expect(cb.state).toBe("open");
    await expect(cb.call(async () => "x")).rejects.toBeInstanceOf(CircuitOpen);
    expect(await cb.call(boom, { fallback: () => "fb" })).toBe("fb");
    t += 11;
    expect(cb.state).toBe("half_open");
    await expect(cb.call(boom)).rejects.toThrow("down");
    expect(cb.state).toBe("open");
    t += 11;
    expect(await cb.call(async () => "ok")).toBe("ok");
    expect(cb.state).toBe("closed");
  });
});
`;

function nestApiTestTs(spec) {
  const e = spec.entities[0];
  const A = spec.needsAuth;
  const req = e.fields.filter((f) => f.required || f.default === undefined);
  const jval = (f) => (f.type === "string" || f.type === "text" ? JSON.stringify(f.name + " 1") : f.type === "int" ? "1" : f.type === "float" ? "1.5" : f.type === "bool" ? "true" : JSON.stringify(f.values[0]));
  const payload = "{ " + req.map((f) => `${f.name}: ${jval(f)}`).join(", ") + " }";
  const sf = e.fields.find((x) => x.type === "string" && x.required);
  return `// HTTP-level tests of the distributed middleware against a REAL Redis. SKIPPED (never faked) if unreachable.
import { spawnSync } from "node:child_process";
import { Redis } from "ioredis";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.setup";

const URL_ = (() => { const u = new URL(process.env.SIERRA_TEST_REDIS_URL || "redis://localhost:6379"); u.pathname = "/14"; return u.toString(); })();
const u = new URL(URL_);
const probe = spawnSync(process.execPath, ["-e", "const s=require('net').connect(+process.argv[2],process.argv[1]);s.setTimeout(800);s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(1));s.on('timeout',()=>process.exit(1))", u.hostname, u.port || "6379"]);
const reachable = probe.status === 0;
const real = reachable ? it : it.skip;
const PATH = "/api/${e.plural}";
const PAYLOAD: Record<string, unknown> = ${payload};
const OTHER: Record<string, unknown> = ${sf ? `{ ...PAYLOAD, ${sf.name}: "different" }` : "PAYLOAD"};

async function make(env: Record<string, string | undefined>, fn: (http: ReturnType<typeof request>) => Promise<void>) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = configureApp(mod.createNestApplication());
  await app.init();
  try { await fn(request(app.getHttpServer())); } finally {
    await app.close();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
async function headers(http: ReturnType<typeof request>): Promise<Record<string, string>> {
  ${A ? `await http.post("/api/auth/register").send({ email: "idem@example.com", password: "password123" });
  const res = await http.post("/api/auth/login").send({ email: "idem@example.com", password: "password123" });
  return { Authorization: "Bearer " + res.body.access_token };` : "return {};"}
}

describe("distributed middleware (real Redis)", () => {
  beforeEach(async () => { if (!reachable) return; const c = new Redis(URL_); c.on("error", () => {}); await c.flushdb(); c.disconnect(); });

  real("429 from the shared Redis counter, with Retry-After; /health exempt", () => make({ REDIS_URL: URL_, RATE_LIMIT_PER_MINUTE: "6" }, async (http) => {
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await http.get("/openapi.json")).status);
    expect(codes).toEqual([200, 200, 200, 200, 200, 200, 429, 429]);
    const r = await http.get("/openapi.json");
    expect(Number(r.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(r.body.error.code).toBe("rate_limited");
    expect((await http.get("/health")).status).toBe(200);
  }));

  real("idempotent POST creates once, replays, rejects key reuse; no key = no dedupe", () => make({ REDIS_URL: URL_, RATE_LIMIT_PER_MINUTE: "1000" }, async (http) => {
    const h = await headers(http);
    const k = { ...h, "Idempotency-Key": "key-1" };
    const first = await http.post(PATH).set(k).send(PAYLOAD);
    const second = await http.post(PATH).set(k).send(PAYLOAD);
    expect(first.status).toBe(201); expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers["idempotent-replay"]).toBe("true");
    expect((await http.get(PATH).set(h)).body).toHaveLength(1);
    if (JSON.stringify(OTHER) !== JSON.stringify(PAYLOAD)) {
      const reuse = await http.post(PATH).set(k).send(OTHER);
      expect(reuse.status).toBe(422); expect(reuse.body.error.code).toBe("idempotency_key_reuse");
    }
    await http.post(PATH).set(h).send(PAYLOAD);
    await http.post(PATH).set(h).send(PAYLOAD);
    expect((await http.get(PATH).set(h)).body).toHaveLength(3);
  }));

  real("a validation error is replayed as-is, never turned into a success", () => make({ REDIS_URL: URL_, RATE_LIMIT_PER_MINUTE: "1000" }, async (http) => {
    const k = { ...(await headers(http)), "Idempotency-Key": "bad" };
    expect((await http.post(PATH).set(k).send({})).status).toBe(422);
    expect((await http.post(PATH).set(k).send({})).status).toBe(422);
  }));

  it("Redis down: fail open by default, 503 when DISTRIBUTED_FAIL_OPEN=false", async () => {
    await make({ REDIS_URL: "redis://127.0.0.1:1/0", DISTRIBUTED_FAIL_OPEN: "true" }, async (http) => { expect((await http.get("/openapi.json")).status).toBe(200); });
    await make({ REDIS_URL: "redis://127.0.0.1:1/0", DISTRIBUTED_FAIL_OPEN: "false" }, async (http) => {
      const r = await http.get("/openapi.json");
      expect(r.status).toBe(503); expect(r.body.error.code).toBe("rate_limiter_unavailable");
    });
  });

  it("without REDIS_URL the distributed features are disabled, not faked", async () => {
    await make({ REDIS_URL: undefined, RATE_LIMIT_PER_MINUTE: "1000" }, async (http) => {
      for (let i = 0; i < 4; i++) expect((await http.get("/openapi.json")).status).toBe(200);
    });
  });
});
`;
}

function nestjs(spec, f) {
  f["src/common/distributed.ts"] = nestCoreTs;
  f["src/common/dist-middleware.ts"] = nestMiddlewareTs;
  f["test/distributed-core.e2e.ts"] = nestCoreTestTs;
  f["test/distributed-api.e2e.ts"] = nestApiTestTs(spec);
  const pkg = JSON.parse(f["package.json"]);
  pkg.dependencies = { ...pkg.dependencies, ioredis: "^5.4.1", express: "^5.0.0" };
  f["package.json"] = JSON.stringify(pkg, null, 2) + "\n";
  // ordinary tests must not hit a shared Redis: remember the URL for the distributed tests, then clear it
  f["test/setup.ts"] += 'process.env.SIERRA_TEST_REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379/15";\ndelete process.env.REDIS_URL;\n';
  const sig = f["src/app.setup.ts"].includes("opts: {") ? /(export function configureApp\([^)]*\) \{\n)/ : /(export function configureApp\(app: INestApplication\) \{\n)/;
  if (!sig.test(f["src/app.setup.ts"])) throw new Error("distributed patch: anchor not found (nest configureApp)");
  f["src/app.setup.ts"] = f["src/app.setup.ts"].replace(sig, `$1  const dist = createDistributed();
  if (dist) {
    app.use(dist.middleware);
    const close = app.close.bind(app);
    app.close = async () => { await dist.close(); return close(); };
  }
`);
  f["src/app.setup.ts"] = must(f["src/app.setup.ts"], 'import { registerMetrics } from "./common/metrics";\n', 'import { registerMetrics } from "./common/metrics";\nimport { createDistributed } from "./common/dist-middleware";\n', "nest import");
  f[".env.example"] += ENV_DIST;
  f["README.md"] = must(f["README.md"], "## Known limitations", README_DIST("an Express middleware under NestJS (ioredis)") , "readme");
}


// ---------------------------------------------------------------------------------------------- go-nethttp
const GO_TPL = path.join(__dirname, "templates", "go-distributed");
const REDIGO = { mod: "github.com/gomodule/redigo", ver: "v1.8.9" };

function goAddRequire(goMod, { mod, ver }) {
  if (goMod.includes(mod + " ")) return goMod;
  if (/require \(\n/.test(goMod)) return goMod.replace(/require \(\n/, `require (\n\t${mod} ${ver}\n`);
  const single = /^require (\S+ \S+)$/m.exec(goMod);
  if (single) return goMod.replace(single[0], `require (\n\t${single[1]}\n\t${mod} ${ver}\n)`);
  return goMod.replace(/\n?$/, `\n\nrequire ${mod} ${ver}\n`);
}

function goApiTest(spec) {
  const e = spec.entities[0];
  const A = spec.needsAuth;
  const req = e.fields.filter((f) => f.required || f.default === undefined);
  const jv = (f) => (f.type === "string" || f.type === "text" ? JSON.stringify(f.name + " 1") : f.type === "int" ? "1" : f.type === "float" ? "1.5" : f.type === "bool" ? "true" : JSON.stringify(f.values[0]));
  const payload = "{" + req.map((f) => `"${f.name}": ${jv(f)}`).join(", ") + "}";
  const sf = e.fields.find((x) => x.type === "string" && x.required);
  const other = sf ? "{" + req.map((f) => `"${f.name}": ${f === sf ? '"different"' : jv(f)}`).join(", ") + "}" : payload;
  return `package app

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"__APPMOD__/internal/config"
	"__APPMOD__/internal/distributed"
)

// The distributed guard in front of the WHOLE application, against a REAL Redis (REDIS_URL, default
// redis://localhost:6379; database 14 is flushed). Skipped - not passed - when Redis is unreachable.
func redisURL(t *testing.T) string {
	t.Helper()
	raw := os.Getenv("REDIS_URL")
	if raw == "" {
		raw = "redis://localhost:6379"
	}
	u, _ := url.Parse(raw)
	u.Path = "/14" // fixed per test package: go test runs packages in parallel and each test flushes its database
	raw = u.String()
	conn, err := net.DialTimeout("tcp", u.Host, 800*time.Millisecond)
	if err != nil {
		t.Skipf("REDIS UNAVAILABLE at %s: %v - this test did NOT run", raw, err)
	}
	_ = conn.Close()
	c := distributed.NewClient(raw)
	defer c.Close()
	if _, err := c.Do("FLUSHDB"); err != nil {
		t.Skipf("REDIS UNAVAILABLE at %s: %v - this test did NOT run", raw, err)
	}
	return raw
}

func guarded(t *testing.T, limit int) (http.Handler, func()) {
	t.Helper()
	g := distributed.NewGuard(distributed.Options{URL: redisURL(t), RateLimit: limit, FailOpen: true})
	return g.Middleware(New(config.Config{JWTSecret: "test-secret-not-for-production-0123456789", JWTTTL: 3600e9})), g.Close
}

func dcall(h http.Handler, method, path, token, key, body string) (int, string, http.Header) {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.RemoteAddr = "203.0.113.50:7000"
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	if key != "" {
		r.Header.Set("Idempotency-Key", key)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w.Code, w.Body.String(), w.Header()
}

func dtoken(t *testing.T, h http.Handler) string {
${A ? `	t.Helper()
	if code, b, _ := dcall(h, "POST", "/api/auth/register", "", "", ${"`"}{"email": "idem@example.com", "name": "I", "password": "password123"}${"`"}); code != 201 {
		t.Fatalf("register: %d %s", code, b)
	}
	code, b, _ := dcall(h, "POST", "/api/auth/login", "", "", ${"`"}{"email": "idem@example.com", "password": "password123"}${"`"})
	if code != 200 {
		t.Fatalf("login: %d %s", code, b)
	}
	var out struct {
		Token string ${"`"}json:"access_token"${"`"}
	}
	_ = json.Unmarshal([]byte(b), &out)
	return out.Token` : `	_, _ = t, h
	return ""`}
}

func listLen(t *testing.T, h http.Handler, token string) int {
	t.Helper()
	code, b, _ := dcall(h, "GET", "/api/${e.plural}", token, "", "")
	if code != 200 {
		t.Fatalf("list: %d %s", code, b)
	}
	var items []map[string]any
	_ = json.Unmarshal([]byte(b), &items)
	return len(items)
}

func TestDistributedRateLimitThroughTheWholeApp(t *testing.T) {
	h, closeFn := guarded(t, 6)
	defer closeFn()
	var codes []int
	for i := 0; i < 8; i++ {
		c, _, _ := dcall(h, "GET", "/openapi.json", "", "", "")
		codes = append(codes, c)
	}
	want := []int{200, 200, 200, 200, 200, 200, 429, 429}
	for i := range want {
		if codes[i] != want[i] {
			t.Fatalf("codes = %v want %v", codes, want)
		}
	}
	if c, _, _ := dcall(h, "GET", "/health", "", "", ""); c != 200 {
		t.Fatalf("/health must stay exempt: %d", c)
	}
}

func TestDistributedIdempotentCreateThroughTheWholeApp(t *testing.T) {
	h, closeFn := guarded(t, 1000)
	defer closeFn()
	tok := dtoken(t, h)
	c1, b1, _ := dcall(h, "POST", "/api/${e.plural}", tok, "key-1", ${"`"}${payload}${"`"})
	c2, b2, h2 := dcall(h, "POST", "/api/${e.plural}", tok, "key-1", ${"`"}${payload}${"`"})
	if c1 != 201 || c2 != 201 || b1 != b2 || h2.Get("Idempotent-Replay") != "true" {
		t.Fatalf("first=%d %s second=%d %s replay=%q", c1, b1, c2, b2, h2.Get("Idempotent-Replay"))
	}
	if n := listLen(t, h, tok); n != 1 {
		t.Fatalf("one row expected after a replayed POST, got %d", n)
	}
${sf ? `	if c, b, _ := dcall(h, "POST", "/api/${e.plural}", tok, "key-1", ${"`"}${other}${"`"}); c != 422 || !strings.Contains(b, "idempotency_key_reuse") {
		t.Fatalf("key reuse: %d %s", c, b)
	}
` : ""}	dcall(h, "POST", "/api/${e.plural}", tok, "", ${"`"}${payload}${"`"})
	dcall(h, "POST", "/api/${e.plural}", tok, "", ${"`"}${payload}${"`"})
	if n := listLen(t, h, tok); n != 3 {
		t.Fatalf("requests without a key are not deduplicated: want 3 rows, got %d", n)
	}
}

func TestDistributedValidationErrorsAreReplayedNotTurnedIntoSuccess(t *testing.T) {
	h, closeFn := guarded(t, 1000)
	defer closeFn()
	tok := dtoken(t, h)
	for i := 0; i < 2; i++ {
		if c, b, _ := dcall(h, "POST", "/api/${e.plural}", tok, "bad", "{}"); c != 422 {
			t.Fatalf("attempt %d: %d %s", i, c, b)
		}
	}
}
`;
}

function gonethttp(spec, f) {
  for (const name of fs.readdirSync(GO_TPL)) f[`internal/distributed/${name}`] = fs.readFileSync(path.join(GO_TPL, name), "utf8").replace(/__APPMOD__/g, spec.slug);
  f["internal/app/distributed_test.go"] = goApiTest(spec).replace(/__APPMOD__/g, spec.slug);
  // main() cannot be unit-tested without starting a server, so this checks the wiring in the source: removing the guard must fail a test
  f["cmd/server/main_test.go"] = `package main

import (
	"os"
	"strings"
	"testing"
)

func TestMainInstallsTheDistributedGuardAroundTheHandler(t *testing.T) {
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"distributed.FromEnv()", "guard.Middleware(", "guard.Close()"} {
		if !strings.Contains(string(src), want) {
			t.Fatalf("main.go no longer contains %q: the Redis rate limit and idempotency would be silently off", want)
		}
	}
}
`;
  f["go.mod"] = goAddRequire(f["go.mod"], REDIGO);
  let main = f["cmd/server/main.go"];
  main = must(main, "\tsrv := &http.Server{", "\tguard := distributed.FromEnv() // nil (disabled) unless REDIS_URL is set\n\tdefer guard.Close()\n\n\tsrv := &http.Server{", "go main guard");
  const m = /Handler:(\s+)(.+),\n/.exec(main);
  if (!m) throw new Error("distributed patch: anchor not found (go main handler)");
  main = main.replace(m[0], `Handler:${m[1]}guard.Middleware(${m[2]}),\n`);
  main = must(main, `\t"${spec.slug}/internal/config"\n`, `\t"${spec.slug}/internal/config"\n\t"${spec.slug}/internal/distributed"\n`, "go main import");
  f["cmd/server/main.go"] = main;
  if (!f["Dockerfile"].includes("go mod tidy")) f["Dockerfile"] = must(f["Dockerfile"], "COPY . .\n", "COPY . .\n# go.sum is not generated by Sierra: it is resolved here (run `go mod tidy` once locally and commit go.sum to pin it)\nRUN go mod tidy\n", "go dockerfile");
  f[".env.example"] += ENV_DIST + "RATE_LIMIT_PER_MINUTE=120\n";
  f["README.md"] = must(f["README.md"], "## Known limitations", README_DIST("Go net/http middleware (`internal/distributed`, redigo)").replace("- Limits:", "- Run `go mod tidy` once to create go.sum (Sierra does not generate it) and commit it.\n- Responses to idempotent POSTs are buffered in memory until the record is stored.\n- Limits:"), "go readme");
}

const PATCH = { "go-nethttp": gonethttp, "go-gin": gonethttp, "go-fiber": gonethttp, "python-fastapi": fastapi, "python-flask": flask, "python-django": django, "node-fastify": fastify, "node-express": express, nestjs };

function withDistributed(stack) {
  const patch = PATCH[stack.id];
  if (!patch) return stack;
  const base = stack.generate;
  return {
    ...stack,
    features: [...(stack.features || []), "distributed"],
    validate: { ...stack.validate, ...(stack.id === "node-express" ? { testFor: (spec) => [...stack.validate.test, ...(spec.features && spec.features.distributed ? [["node", "--test", "test/distributed_redis.node.js"]] : [])] } : {}), requiresFor: (spec) => [...(stack.validate.requiresFor ? stack.validate.requiresFor(spec) : []), ...(spec.features && spec.features.distributed ? [{ name: "Redis", env: "REDIS_URL", fallback: "redis://localhost:6379/15", hint: "Start one with `redis-server` or `docker run -d -p 6379:6379 redis:7` or set REDIS_URL; the generated GitHub Actions workflow starts a Redis service container." }] : [])] },
    generate(spec) {
      const files = base(spec);
      if (spec.features && spec.features.distributed) patch(spec, files);
      return files;
    },
  };
}

module.exports = { withDistributed, PATCH };
