package distributed

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"time"

	"github.com/gomodule/redigo/redis"
)

const releaseLua = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end"
const extendLua = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end"

// ErrNotAcquired is returned by Run when the lock could not be taken in time.
var ErrNotAcquired = errors.New("lock not acquired")

// Lock is a single-instance Redis lock: SET NX PX with an owner token, released and extended only by the owner
// (Lua compare-and-delete). It is NOT safe across a Redis failover, has no fencing token, and a holder paused longer
// than TTL can lose it: use it to avoid duplicate work, not as the only guard of a correctness invariant.
type Lock struct {
	c       *Client
	key     string
	TTL     time.Duration
	Timeout time.Duration // how long Acquire keeps retrying (0 = try once)
	Retry   time.Duration
	token   string
}

func NewLock(c *Client, name string, ttl, timeout time.Duration) *Lock {
	return &Lock{c: c, key: "lock:" + name, TTL: ttl, Timeout: timeout, Retry: 50 * time.Millisecond}
}

func newToken() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (l *Lock) Acquire() (bool, error) {
	token := newToken()
	deadline := time.Now().Add(l.Timeout)
	for {
		_, err := redis.String(l.c.do("SET", l.key, token, "PX", l.TTL.Milliseconds(), "NX"))
		if err == nil {
			l.token = token
			return true, nil
		}
		if !errors.Is(err, redis.ErrNil) {
			return false, err
		}
		if !time.Now().Before(deadline) {
			return false, nil
		}
		time.Sleep(l.Retry)
	}
}

// Release frees the lock only if this holder still owns it.
func (l *Lock) Release() (bool, error) {
	if l.token == "" {
		return false, nil
	}
	n, err := redis.Int(l.c.do("EVAL", releaseLua, 1, l.key, l.token))
	l.token = ""
	return n == 1, err
}

// Extend renews the TTL only if this holder still owns the lock.
func (l *Lock) Extend(ttl time.Duration) (bool, error) {
	if l.token == "" {
		return false, nil
	}
	if ttl <= 0 {
		ttl = l.TTL
	}
	n, err := redis.Int(l.c.do("EVAL", extendLua, 1, l.key, l.token, ttl.Milliseconds()))
	return n == 1, err
}

// Run holds the lock while fn runs.
func (l *Lock) Run(fn func() error) error {
	ok, err := l.Acquire()
	if err != nil {
		return err
	}
	if !ok {
		return ErrNotAcquired
	}
	defer func() { _, _ = l.Release() }()
	return fn()
}
