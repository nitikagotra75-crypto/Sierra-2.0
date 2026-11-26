// Package events publishes domain events (<entity>.created|updated|deleted) to RabbitMQ and consumes them.
//
// Publishing is best effort: a broker outage is logged and never fails the HTTP request, so events can be lost (there is
// no transactional outbox). Consuming is at-least-once: a message is acknowledged only after the handler succeeds, a
// failed message is re-published with an incremented x-retries header, and after MaxRetries it is moved to <queue>.dlq.
// Handlers must therefore be idempotent.
package events

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"os"
	"sync"
	"time"
)

// Exchange is the durable topic exchange events are published to (routing key = event type).
const Exchange = "domain-events"

// Event is the JSON envelope on the wire.
type Event struct {
	ID   string          `json:"id"`
	Type string          `json:"type"`
	TS   string          `json:"ts"`
	Data json.RawMessage `json:"data"`
}

// New wraps data in an envelope with a random id and a UTC timestamp.
func New(typ string, data any) Event {
	raw, err := json.Marshal(data)
	if err != nil {
		raw = []byte("null")
	}
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return Event{ID: hex.EncodeToString(b), Type: typ, TS: time.Now().UTC().Format(time.RFC3339Nano), Data: raw}
}

// Publisher is what the services depend on.
type Publisher interface{ Publish(ev Event) }

// Noop drops every event (used when AMQP_URL is not set).
type Noop struct{}

func (Noop) Publish(Event) {}

var (
	mu     sync.Mutex
	shared Publisher
)

// Shared returns the process-wide publisher: RabbitMQ when AMQP_URL (or RABBITMQ_URL) is set, otherwise a Noop that logs once.
func Shared() Publisher {
	mu.Lock()
	defer mu.Unlock()
	if shared == nil {
		url := os.Getenv("AMQP_URL")
		if url == "" {
			url = os.Getenv("RABBITMQ_URL")
		}
		if url == "" {
			slog.Warn("events disabled: AMQP_URL is not set")
			shared = Noop{}
		} else {
			shared = NewAMQP(url, Queue())
		}
	}
	return shared
}

// SetShared replaces the process-wide publisher (tests).
func SetShared(p Publisher) {
	mu.Lock()
	defer mu.Unlock()
	shared = p
}

// Close closes the shared publisher if it holds a connection.
func Close() {
	mu.Lock()
	p := shared
	mu.Unlock()
	if c, ok := p.(interface{ Close() error }); ok {
		_ = c.Close()
	}
}

// Queue is the consumer queue name (EVENT_QUEUE, default "domain-events").
func Queue() string {
	if q := os.Getenv("EVENT_QUEUE"); q != "" {
		return q
	}
	return "domain-events"
}
