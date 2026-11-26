package distributed

import (
	"errors"
	"sync"
	"time"
)

// ErrCircuitOpen is returned while the breaker is open and no fallback is given.
var ErrCircuitOpen = errors.New("circuit is open")

type State string

const (
	Closed   State = "closed"
	Open     State = "open"
	HalfOpen State = "half_open"
)

// Breaker: closed -> (FailureThreshold consecutive failures) -> open -> (RecoveryTimeout) -> half-open ->
// success: closed / failure: open. The state lives in this process only.
type Breaker struct {
	FailureThreshold int
	RecoveryTimeout  time.Duration
	HalfOpenMaxCalls int
	Now              func() time.Time

	mu       sync.Mutex
	state    State
	failures int
	openedAt time.Time
	probes   int
}

func NewBreaker(threshold int, recovery time.Duration) *Breaker {
	return &Breaker{FailureThreshold: threshold, RecoveryTimeout: recovery, HalfOpenMaxCalls: 1, Now: time.Now, state: Closed}
}

func (b *Breaker) current() State {
	if b.state == Open && b.Now().Sub(b.openedAt) >= b.RecoveryTimeout {
		b.state, b.probes = HalfOpen, 0
	}
	return b.state
}

// State returns the current state.
func (b *Breaker) State() State {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.current()
}

// Call runs fn through the breaker. When the circuit is open (or fn fails) and fallback is non-nil, its result is returned.
func (b *Breaker) Call(fn func() error, fallback func() error) error {
	b.mu.Lock()
	st := b.current()
	if st == Open || (st == HalfOpen && b.probes >= b.HalfOpenMaxCalls) {
		b.mu.Unlock()
		if fallback != nil {
			return fallback()
		}
		return ErrCircuitOpen
	}
	if st == HalfOpen {
		b.probes++
	}
	b.mu.Unlock()

	err := fn()

	b.mu.Lock()
	if err == nil {
		b.state, b.failures = Closed, 0
		b.mu.Unlock()
		return nil
	}
	b.failures++
	if b.state == HalfOpen || b.failures >= b.FailureThreshold {
		b.state, b.openedAt = Open, b.Now()
	}
	b.mu.Unlock()
	if fallback != nil {
		return fallback()
	}
	return err
}
