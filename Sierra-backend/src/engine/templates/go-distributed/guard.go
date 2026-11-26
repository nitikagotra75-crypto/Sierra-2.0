package distributed

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"__APPMOD__/internal/httpx"
)

// Options configures a Guard.
type Options struct {
	URL            string
	RateLimit      int           // requests per Window per client IP (0 disables)
	Window         time.Duration // default 1 minute
	IdempotencyTTL time.Duration // default 24 h
	FailOpen       bool          // Redis errors let the request through (true) or answer 503 (false)
}

// Guard applies the Redis rate limit and Idempotency-Key handling as http middleware.
type Guard struct {
	c        *Client
	limiter  *RateLimiter
	idem     *IdempotencyStore
	failOpen bool
}

// NewGuard builds a guard for an explicit configuration.
func NewGuard(o Options) *Guard {
	if o.Window <= 0 {
		o.Window = time.Minute
	}
	if o.IdempotencyTTL <= 0 {
		o.IdempotencyTTL = 24 * time.Hour
	}
	c := NewClient(o.URL)
	return &Guard{c: c, limiter: NewRateLimiter(c, o.RateLimit, o.Window), idem: NewIdempotencyStore(c, o.IdempotencyTTL, 60*time.Second), failOpen: o.FailOpen}
}

// FromEnv reads REDIS_URL, RATE_LIMIT_PER_MINUTE (default 120), IDEMPOTENCY_TTL_SECONDS (default 86400) and
// DISTRIBUTED_FAIL_OPEN (default true). Without REDIS_URL it returns nil: the features are DISABLED (a warning is
// logged); nothing falls back to in-memory counters, because those would be wrong behind a load balancer.
func FromEnv() *Guard {
	url := os.Getenv("REDIS_URL")
	if url == "" {
		slog.Warn("REDIS_URL is not set: distributed rate limiting and idempotency are DISABLED")
		return nil
	}
	return NewGuard(Options{
		URL:            url,
		RateLimit:      envInt("RATE_LIMIT_PER_MINUTE", 120),
		IdempotencyTTL: time.Duration(envInt("IDEMPOTENCY_TTL_SECONDS", 86400)) * time.Second,
		FailOpen:       !strings.EqualFold(os.Getenv("DISTRIBUTED_FAIL_OPEN"), "false"),
	})
}

func envInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			return n
		}
	}
	return def
}

// Close releases the Redis pool. Safe on a nil Guard.
func (g *Guard) Close() {
	if g != nil {
		_ = g.c.Close()
	}
}

func exempt(path string) bool { return path == "/health" || path == "/metrics" }

func clientIP(r *http.Request) string {
	h, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return h // X-Forwarded-For is deliberately not trusted
}

func writeErr(w http.ResponseWriter, status int, code, msg string, headers map[string]string) {
	for k, v := range headers {
		w.Header().Set(k, v)
	}
	httpx.JSON(w, status, map[string]any{"error": map[string]any{"code": code, "message": msg, "details": nil}})
}

// buffered holds a response until the idempotent record is stored, so a retry that arrives right after the client got
// its answer always sees the finished record. Bodies are held in memory: this is meant for JSON APIs.
type buffered struct {
	header http.Header
	status int
	body   bytes.Buffer
}

func (b *buffered) Header() http.Header         { return b.header }
func (b *buffered) WriteHeader(code int)        { if b.status == 0 { b.status = code } }
func (b *buffered) Write(p []byte) (int, error) { if b.status == 0 { b.status = 200 }; return b.body.Write(p) }

// Middleware wraps next. A nil Guard returns next unchanged.
func (g *Guard) Middleware(next http.Handler) http.Handler {
	if g == nil {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if exempt(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		res, err := g.limiter.Check("ip", clientIP(r))
		if err != nil {
			slog.Error("rate limiter unavailable", "err", err)
			if !g.failOpen {
				writeErr(w, 503, "rate_limiter_unavailable", "Rate limiter is unavailable", map[string]string{"Retry-After": "1"})
				return
			}
		} else if !res.Allowed {
			writeErr(w, 429, "rate_limited", "Too many requests", map[string]string{"Retry-After": strconv.Itoa(res.RetryAfter)})
			return
		}

		key := r.Header.Get("Idempotency-Key")
		if r.Method != http.MethodPost || key == "" {
			next.ServeHTTP(w, r)
			return
		}
		if len(key) > 200 {
			writeErr(w, 422, "invalid_idempotency_key", "Idempotency-Key must be at most 200 characters", nil)
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
		if err != nil {
			writeErr(w, 413, "payload_too_large", "Request body is too large", nil)
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		fpSum := sha256.Sum256(append([]byte(r.URL.Path+"\x00"), body...))
		scopedSum := sha256.Sum256([]byte(r.Header.Get("Authorization") + "|" + key)) // keys are per caller
		fp, scoped := hex.EncodeToString(fpSum[:]), hex.EncodeToString(scopedSum[:])

		state, stored, err := g.idem.Begin(scoped, fp)
		if err != nil {
			slog.Error("idempotency store unavailable", "err", err)
			writeErr(w, 503, "idempotency_unavailable", "Idempotency store is unavailable", map[string]string{"Retry-After": "1"})
			return
		}
		switch state {
		case StateReplay:
			w.Header().Set("Content-Type", stored.ContentType)
			w.Header().Set("Idempotent-Replay", "true")
			w.WriteHeader(stored.Status)
			_, _ = w.Write(stored.Body)
			return
		case StateInProgress:
			writeErr(w, 409, "request_in_progress", "A request with this Idempotency-Key is still being processed", map[string]string{"Retry-After": "1"})
			return
		case StateMismatch:
			writeErr(w, 422, "idempotency_key_reuse", "This Idempotency-Key was used with a different request", nil)
			return
		}

		buf := &buffered{header: http.Header{}}
		func() {
			defer func() {
				if rec := recover(); rec != nil { // the claim must not stay "processing" if the handler panics
					_ = g.idem.Abort(scoped)
					panic(rec)
				}
			}()
			next.ServeHTTP(buf, r)
		}()
		if buf.status == 0 {
			buf.status = 200
		}
		if buf.status >= 500 {
			_ = g.idem.Abort(scoped) // server errors are not cached: the client may retry with the same key
		} else if err := g.idem.Complete(scoped, fp, Stored{Status: buf.status, Body: buf.body.Bytes(), ContentType: buf.header.Get("Content-Type")}); err != nil {
			slog.Error("could not store idempotent response", "err", err)
		}
		for k, v := range buf.header {
			w.Header()[k] = v
		}
		w.WriteHeader(buf.status)
		_, _ = w.Write(buf.body.Bytes())
	})
}
