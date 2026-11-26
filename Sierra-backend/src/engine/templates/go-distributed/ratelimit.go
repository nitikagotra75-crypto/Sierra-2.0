package distributed

import (
	"time"

	"github.com/gomodule/redigo/redis"
)

// Atomic fixed window: INCR, set the expiry on the first hit, return {count, ttl_ms}.
const rateLua = "local c = redis.call('INCR', KEYS[1]) if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end local ttl = redis.call('PTTL', KEYS[1]) if ttl < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) ttl = tonumber(ARGV[1]) end return {c, ttl}"

// RateLimiter is a fixed-window counter shared by every instance that talks to the same Redis.
type RateLimiter struct {
	c      *Client
	Limit  int
	Window time.Duration
	Prefix string
}

type RateResult struct {
	Allowed    bool
	RetryAfter int // seconds, when not allowed
	Remaining  int
}

func NewRateLimiter(c *Client, limit int, window time.Duration) *RateLimiter {
	return &RateLimiter{c: c, Limit: limit, Window: window, Prefix: "rl"}
}

// Check counts one request for (scope, ident). It returns an error when Redis cannot be reached; the caller decides
// whether to fail open or closed. A Limit <= 0 disables limiting.
func (r *RateLimiter) Check(scope, ident string) (RateResult, error) {
	if r.Limit <= 0 {
		return RateResult{Allowed: true, Remaining: -1}, nil
	}
	v, err := redis.Int64s(r.c.do("EVAL", rateLua, 1, r.Prefix+":"+scope+":"+ident, r.Window.Milliseconds()))
	if err != nil {
		return RateResult{}, err
	}
	count, ttl := v[0], v[1]
	if count > int64(r.Limit) {
		retry := int((ttl + 999) / 1000)
		if retry < 1 {
			retry = 1
		}
		return RateResult{Allowed: false, RetryAfter: retry}, nil
	}
	return RateResult{Allowed: true, Remaining: r.Limit - int(count)}, nil
}
