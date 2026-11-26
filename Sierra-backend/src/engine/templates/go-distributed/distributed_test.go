package distributed

import (
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gomodule/redigo/redis"
)

// These tests need a REAL Redis (REDIS_URL, default redis://localhost:6379/15) and FLUSH that database.
// If it is unreachable they are SKIPPED with a message: a skipped test is not a pass.
// redisURL: host/port/auth come from REDIS_URL, but the database index is fixed per test package (this one uses 15, the
// application tests use 14) because `go test` runs packages in parallel and every test flushes its database.
func redisURL() string {
	raw := os.Getenv("REDIS_URL")
	if raw == "" {
		raw = "redis://localhost:6379"
	}
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	u.Path = "/15"
	return u.String()
}

func realClient(t *testing.T) *Client {
	t.Helper()
	u, _ := url.Parse(redisURL())
	conn, err := net.DialTimeout("tcp", u.Host, 800*time.Millisecond)
	if err != nil {
		t.Skipf("REDIS UNAVAILABLE at %s: %v - this test did NOT run", redisURL(), err)
	}
	_ = conn.Close()
	c := NewClient(redisURL())
	if _, err := c.do("FLUSHDB"); err != nil {
		t.Skipf("REDIS UNAVAILABLE at %s: %v - this test did NOT run", redisURL(), err)
	}
	t.Cleanup(func() { _, _ = c.do("FLUSHDB"); _ = c.Close() })
	return c
}

func TestRateLimitIsOneSharedCounterAcrossClients(t *testing.T) {
	a := realClient(t)
	b := NewClient(redisURL())
	defer b.Close()
	la, lb := NewRateLimiter(a, 5, time.Minute), NewRateLimiter(b, 5, time.Minute)
	var got []bool
	for i := 0; i < 8; i++ {
		l := la
		if i%2 == 1 {
			l = lb
		}
		r, err := l.Check("ip", "1.2.3.4")
		if err != nil {
			t.Fatal(err)
		}
		got = append(got, r.Allowed)
	}
	want := []bool{true, true, true, true, true, false, false, false}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v want %v", got, want)
		}
	}
	r, _ := la.Check("ip", "1.2.3.4")
	if r.RetryAfter < 1 || r.RetryAfter > 60 {
		t.Fatalf("RetryAfter = %d", r.RetryAfter)
	}
	if r, _ := la.Check("ip", "9.9.9.9"); !r.Allowed {
		t.Fatal("other clients are independent")
	}
}

func TestRateLimitWindowExpiresAndIsAtomicUnderConcurrency(t *testing.T) {
	c := realClient(t)
	l := NewRateLimiter(c, 2, time.Second)
	for i, want := range []bool{true, true, false} {
		if r, _ := l.Check("ip", "x"); r.Allowed != want {
			t.Fatalf("request %d allowed=%v want %v", i, r.Allowed, want)
		}
	}
	if ttl, _ := redis.Int64(c.do("PTTL", "rl:ip:x")); ttl <= 0 || ttl > 1000 {
		t.Fatalf("ttl = %d", ttl)
	}
	time.Sleep(1200 * time.Millisecond)
	if n, _ := redis.Int(c.do("EXISTS", "rl:ip:x")); n != 0 {
		t.Fatal("window key must expire")
	}
	if r, _ := l.Check("ip", "x"); !r.Allowed {
		t.Fatal("a new window must allow")
	}
	big := NewRateLimiter(c, 20, time.Minute)
	var allowed int64
	var wg sync.WaitGroup
	for i := 0; i < 60; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if r, err := big.Check("ip", "c"); err == nil && r.Allowed {
				atomic.AddInt64(&allowed, 1)
			}
		}()
	}
	wg.Wait()
	if allowed != 20 {
		t.Fatalf("allowed %d of 60, want exactly 20", allowed)
	}
}

func TestRateLimitReportsRedisFailure(t *testing.T) {
	dead := NewClient("redis://127.0.0.1:1")
	defer dead.Close()
	if _, err := NewRateLimiter(dead, 5, time.Minute).Check("ip", "z"); err == nil {
		t.Fatal("an unreachable Redis must return an error")
	}
}

func TestIdempotencyLifecycle(t *testing.T) {
	c := realClient(t)
	s := NewIdempotencyStore(c, time.Second, 5*time.Second)
	if st, _, _ := s.Begin("k", "fp1"); st != StateNew {
		t.Fatalf("first begin = %v", st)
	}
	if st, _, _ := s.Begin("k", "fp1"); st != StateInProgress {
		t.Fatalf("second begin = %v", st)
	}
	if st, _, _ := s.Begin("k", "other"); st != StateMismatch {
		t.Fatalf("different body = %v", st)
	}
	if err := s.Complete("k", "fp1", Stored{Status: 201, Body: []byte(`{"id":1}`), ContentType: "application/json"}); err != nil {
		t.Fatal(err)
	}
	st, got, _ := s.Begin("k", "fp1")
	if st != StateReplay || got.Status != 201 || string(got.Body) != `{"id":1}` {
		t.Fatalf("replay = %v %+v", st, got)
	}
	time.Sleep(1200 * time.Millisecond)
	if st, _, _ := s.Begin("k", "fp1"); st != StateNew {
		t.Fatalf("after expiry = %v", st)
	}
	_ = s.Abort("k")
	if st, _, _ := s.Begin("k", "fp1"); st != StateNew {
		t.Fatalf("after abort = %v", st)
	}
}

func TestIdempotencyConcurrentClaimsYieldExactlyOneOwner(t *testing.T) {
	c := realClient(t)
	s := NewIdempotencyStore(c, time.Minute, time.Minute)
	var owners, busy int64
	var wg sync.WaitGroup
	for i := 0; i < 30; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			st, _, _ := s.Begin("same", "fp")
			if st == StateNew {
				atomic.AddInt64(&owners, 1)
			} else if st == StateInProgress {
				atomic.AddInt64(&busy, 1)
			}
		}()
	}
	wg.Wait()
	if owners != 1 || busy != 29 {
		t.Fatalf("owners=%d busy=%d", owners, busy)
	}
}

func TestLockMutualExclusionOwnerOnlyReleaseAndStaleHolder(t *testing.T) {
	c := realClient(t)
	a, b := NewLock(c, "job", 5*time.Second, 0), NewLock(c, "job", 5*time.Second, 0)
	if ok, _ := a.Acquire(); !ok {
		t.Fatal("a must acquire")
	}
	if ok, _ := b.Acquire(); ok {
		t.Fatal("b must not acquire while a holds it")
	}
	b.token = "forged"
	if ok, _ := b.Release(); ok {
		t.Fatal("a non-owner must not release")
	}
	if n, _ := redis.Int(c.do("EXISTS", "lock:job")); n != 1 {
		t.Fatal("lock must still be held")
	}
	if ok, _ := a.Release(); !ok {
		t.Fatal("owner releases")
	}
	s1, s2 := NewLock(c, "job2", 200*time.Millisecond, 0), NewLock(c, "job2", 5*time.Second, 0)
	if ok, _ := s1.Acquire(); !ok {
		t.Fatal("s1 acquires")
	}
	time.Sleep(400 * time.Millisecond)
	if ok, _ := s2.Acquire(); !ok {
		t.Fatal("s2 acquires after s1's TTL expired")
	}
	if ok, _ := s1.Release(); ok {
		t.Fatal("the stale holder must not free the new owner's lock")
	}
	if n, _ := redis.Int(c.do("EXISTS", "lock:job2")); n != 1 {
		t.Fatal("new owner's lock must survive")
	}
	if ok, _ := s2.Extend(3 * time.Second); !ok {
		t.Fatal("owner extends")
	}
	if ttl, _ := redis.Int64(c.do("PTTL", "lock:job2")); ttl < 2000 {
		t.Fatalf("ttl after extend = %d", ttl)
	}
}

func TestLockWaitsWithinTimeoutAndRunReleases(t *testing.T) {
	c := realClient(t)
	holder := NewLock(c, "w", 300*time.Millisecond, 0)
	holder.Acquire()
	start := time.Now()
	ran := false
	if err := NewLock(c, "w", time.Second, 2*time.Second).Run(func() error { ran = true; return nil }); err != nil || !ran {
		t.Fatalf("run: %v ran=%v", err, ran)
	}
	if time.Since(start) > 1500*time.Millisecond {
		t.Fatal("waited too long")
	}
	if n, _ := redis.Int(c.do("EXISTS", "lock:w")); n != 0 {
		t.Fatal("Run must release")
	}
	NewLock(c, "w2", 5*time.Second, 0).Acquire()
	if err := NewLock(c, "w2", time.Second, 100*time.Millisecond).Run(func() error { return nil }); err != ErrNotAcquired {
		t.Fatalf("want ErrNotAcquired, got %v", err)
	}
}

func TestBreakerStateMachine(t *testing.T) {
	now := time.Unix(1000, 0)
	b := NewBreaker(2, 10*time.Second)
	b.Now = func() time.Time { return now }
	boom := func() error { return net.ErrClosed }
	for i := 0; i < 2; i++ {
		if err := b.Call(boom, nil); err != net.ErrClosed {
			t.Fatalf("call %d: %v", i, err)
		}
	}
	if b.State() != Open {
		t.Fatalf("state = %s", b.State())
	}
	if err := b.Call(func() error { return nil }, nil); err != ErrCircuitOpen {
		t.Fatalf("want ErrCircuitOpen, got %v", err)
	}
	fb := false
	_ = b.Call(boom, func() error { fb = true; return nil })
	if !fb {
		t.Fatal("fallback must run while open")
	}
	now = now.Add(11 * time.Second)
	if b.State() != HalfOpen {
		t.Fatalf("state = %s", b.State())
	}
	if err := b.Call(boom, nil); err != net.ErrClosed || b.State() != Open {
		t.Fatalf("a failed probe must reopen: %v %s", err, b.State())
	}
	now = now.Add(11 * time.Second)
	if err := b.Call(func() error { return nil }, nil); err != nil || b.State() != Closed {
		t.Fatalf("a successful probe must close: %v %s", err, b.State())
	}
}

func okHandler(count *int64) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt64(count, 1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(201)
		_, _ = w.Write([]byte(`{"n":` + string(rune('0'+atomic.LoadInt64(count))) + `}`))
	})
}

func do(h http.Handler, method, path, key, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.RemoteAddr = "203.0.113.7:5000"
	if key != "" {
		r.Header.Set("Idempotency-Key", key)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestGuardRateLimitsWithRetryAfterAndExemptPaths(t *testing.T) {
	realClient(t)
	g := NewGuard(Options{URL: redisURL(), RateLimit: 6, FailOpen: true})
	defer g.Close()
	var n int64
	h := g.Middleware(okHandler(&n))
	var codes []int
	for i := 0; i < 8; i++ {
		codes = append(codes, do(h, "GET", "/api/things", "", "").Code)
	}
	want := []int{201, 201, 201, 201, 201, 201, 429, 429}
	for i := range want {
		if codes[i] != want[i] {
			t.Fatalf("codes = %v want %v", codes, want)
		}
	}
	r := do(h, "GET", "/api/things", "", "")
	if r.Header().Get("Retry-After") == "" || !strings.Contains(r.Body.String(), "rate_limited") {
		t.Fatalf("429 must carry Retry-After and an error envelope: %v %s", r.Header(), r.Body.String())
	}
	if do(h, "GET", "/health", "", "").Code != 201 || do(h, "GET", "/metrics", "", "").Code != 201 {
		t.Fatal("/health and /metrics are exempt")
	}
}

func TestGuardIdempotentPostRunsOnceReplaysAndRejectsReuse(t *testing.T) {
	realClient(t)
	g := NewGuard(Options{URL: redisURL(), RateLimit: 1000, FailOpen: true})
	defer g.Close()
	var n int64
	h := g.Middleware(okHandler(&n))
	first := do(h, "POST", "/api/things", "key-1", `{"a":1}`)
	second := do(h, "POST", "/api/things", "key-1", `{"a":1}`)
	if first.Code != 201 || second.Code != 201 || first.Body.String() != second.Body.String() {
		t.Fatalf("first=%d %s second=%d %s", first.Code, first.Body.String(), second.Code, second.Body.String())
	}
	if second.Header().Get("Idempotent-Replay") != "true" || n != 1 {
		t.Fatalf("handler ran %d times, replay header %q", n, second.Header().Get("Idempotent-Replay"))
	}
	if r := do(h, "POST", "/api/things", "key-1", `{"a":2}`); r.Code != 422 || !strings.Contains(r.Body.String(), "idempotency_key_reuse") {
		t.Fatalf("reuse = %d %s", r.Code, r.Body.String())
	}
	do(h, "POST", "/api/things", "", `{"a":1}`)
	do(h, "POST", "/api/things", "", `{"a":1}`)
	if n != 3 {
		t.Fatalf("requests without a key are never deduplicated: handler ran %d times", n)
	}
}

func TestGuardServerErrorsAreNotCachedAndConcurrentDuplicatesRunOnce(t *testing.T) {
	realClient(t)
	g := NewGuard(Options{URL: redisURL(), RateLimit: 1000, FailOpen: true})
	defer g.Close()
	var calls int64
	flaky := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if atomic.AddInt64(&calls, 1) == 1 {
			w.WriteHeader(500)
			return
		}
		w.WriteHeader(201)
	})
	h := g.Middleware(flaky)
	if do(h, "POST", "/x", "k5", "{}").Code != 500 {
		t.Fatal("first call fails")
	}
	if do(h, "POST", "/x", "k5", "{}").Code != 201 {
		t.Fatal("a 5xx must not be cached: the retry with the same key must run again")
	}
	var runs int64
	slow := g.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt64(&runs, 1)
		time.Sleep(300 * time.Millisecond)
		w.WriteHeader(201)
	}))
	var wg sync.WaitGroup
	var ok, busy int64
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			switch do(slow, "POST", "/x", "same", "{}").Code {
			case 201:
				atomic.AddInt64(&ok, 1)
			case 409:
				atomic.AddInt64(&busy, 1)
			}
		}()
	}
	wg.Wait()
	if runs != 1 || ok < 1 || ok+busy != 10 {
		t.Fatalf("runs=%d ok=%d busy=%d", runs, ok, busy)
	}
}

func TestGuardWhenRedisIsDownFailsOpenOrClosed(t *testing.T) {
	var n int64
	open := NewGuard(Options{URL: "redis://127.0.0.1:1/0", RateLimit: 5, FailOpen: true})
	defer open.Close()
	if do(open.Middleware(okHandler(&n)), "GET", "/x", "", "").Code != 201 {
		t.Fatal("fail-open must let the request through")
	}
	closed := NewGuard(Options{URL: "redis://127.0.0.1:1/0", RateLimit: 5, FailOpen: false})
	defer closed.Close()
	r := do(closed.Middleware(okHandler(&n)), "GET", "/x", "", "")
	if r.Code != 503 || !strings.Contains(r.Body.String(), "rate_limiter_unavailable") {
		t.Fatalf("fail-closed = %d %s", r.Code, r.Body.String())
	}
}

func TestWithoutRedisURLTheGuardIsDisabledNotFaked(t *testing.T) {
	t.Setenv("REDIS_URL", "")
	if g := FromEnv(); g != nil {
		t.Fatal("without REDIS_URL FromEnv must return nil")
	}
	var n int64
	var g *Guard
	for i := 0; i < 5; i++ {
		if do(g.Middleware(okHandler(&n)), "GET", "/x", "", "").Code != 201 {
			t.Fatal("a nil guard must pass everything through")
		}
	}
}
