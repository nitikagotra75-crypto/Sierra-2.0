package distributed

import (
	"encoding/json"
	"errors"
	"time"

	"github.com/gomodule/redigo/redis"
)

// Stored is a finished response kept for replay.
type Stored struct {
	Status      int    `json:"status"`
	Body        []byte `json:"body"`
	ContentType string `json:"content_type"`
}

type BeginState int

const (
	StateNew BeginState = iota // this caller owns the key and must Complete or Abort it
	StateInProgress            // another request with the same key is still running
	StateReplay                // a finished response exists
	StateMismatch              // the key was used with a different request
)

type record struct {
	State string `json:"state"`
	FP    string `json:"fp"`
	Stored
}

// IdempotencyStore keeps "processing" and "complete" records under Idempotency-Key.
type IdempotencyStore struct {
	c        *Client
	TTL      time.Duration // how long a finished response is kept
	LockTTL  time.Duration // how long a request may stay "processing" before the claim expires
	Prefix   string
}

func NewIdempotencyStore(c *Client, ttl, lockTTL time.Duration) *IdempotencyStore {
	return &IdempotencyStore{c: c, TTL: ttl, LockTTL: lockTTL, Prefix: "idem"}
}

func (s *IdempotencyStore) k(key string) string { return s.Prefix + ":" + key }

// Begin atomically claims the key (SET NX) or reports what already exists.
func (s *IdempotencyStore) Begin(key, fp string) (BeginState, *Stored, error) {
	claim, _ := json.Marshal(record{State: "processing", FP: fp})
	for i := 0; i < 2; i++ {
		_, err := redis.String(s.c.do("SET", s.k(key), claim, "NX", "EX", int(s.LockTTL.Seconds())))
		if err == nil {
			return StateNew, nil, nil
		}
		if !errors.Is(err, redis.ErrNil) {
			return 0, nil, err
		}
		raw, err := redis.Bytes(s.c.do("GET", s.k(key)))
		if errors.Is(err, redis.ErrNil) {
			continue // expired between SET and GET: claim again
		}
		if err != nil {
			return 0, nil, err
		}
		var rec record
		if err := json.Unmarshal(raw, &rec); err != nil {
			return 0, nil, err
		}
		if rec.FP != fp {
			return StateMismatch, nil, nil
		}
		if rec.State == "processing" {
			return StateInProgress, nil, nil
		}
		st := rec.Stored
		return StateReplay, &st, nil
	}
	return StateInProgress, nil, nil
}

// Complete stores the finished response for TTL.
func (s *IdempotencyStore) Complete(key, fp string, st Stored) error {
	b, _ := json.Marshal(record{State: "complete", FP: fp, Stored: st})
	_, err := s.c.do("SET", s.k(key), b, "EX", int(s.TTL.Seconds()))
	return err
}

// Abort releases a claim so the client can retry with the same key.
func (s *IdempotencyStore) Abort(key string) error {
	_, err := s.c.do("DEL", s.k(key))
	return err
}
