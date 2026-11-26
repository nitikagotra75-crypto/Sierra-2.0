// Package distributed provides Redis-backed building blocks (rate limiting, idempotency keys, locks) and an in-process
// circuit breaker, plus an http middleware that applies rate limiting and Idempotency-Key handling.
package distributed

import (
	"time"

	"github.com/gomodule/redigo/redis"
)

// Client is a small pooled Redis client. Commands fail fast (500 ms dial/read/write timeouts, bounded pool) so a Redis
// outage turns into errors the caller can handle (fail open / fail closed) instead of hanging requests.
type Client struct{ pool *redis.Pool }

// NewClient builds a pool for a redis:// URL. It does not connect until the first command.
func NewClient(url string) *Client {
	return &Client{pool: &redis.Pool{
		MaxIdle:     10,
		MaxActive:   50,
		IdleTimeout: 60 * time.Second,
		Dial: func() (redis.Conn, error) {
			return redis.DialURL(url,
				redis.DialConnectTimeout(500*time.Millisecond),
				redis.DialReadTimeout(500*time.Millisecond),
				redis.DialWriteTimeout(500*time.Millisecond))
		},
	}}
}

// Close releases the pool.
func (c *Client) Close() error { return c.pool.Close() }

func (c *Client) do(cmd string, args ...any) (any, error) {
	conn := c.pool.Get()
	defer conn.Close()
	return conn.Do(cmd, args...)
}

// Do runs a raw command (useful for tests and small extensions).
func (c *Client) Do(cmd string, args ...any) (any, error) { return c.do(cmd, args...) }
