package events

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

// These tests need a REAL RabbitMQ (AMQP_URL, default amqp://app:app@localhost:5672/). They are skipped - never
// passed - when none is reachable. Each test uses its own queue and deletes it afterwards.
func brokerURL(t *testing.T) string {
	t.Helper()
	raw := os.Getenv("AMQP_URL")
	if raw == "" {
		raw = "amqp://app:app@localhost:5672/"
	}
	u, err := url.Parse(raw)
	if err != nil {
		t.Skip("invalid AMQP_URL")
	}
	port := u.Port()
	if port == "" {
		port = "5672"
	}
	c, err := net.DialTimeout("tcp", net.JoinHostPort(u.Hostname(), port), 500*time.Millisecond)
	if err != nil {
		t.Skipf("RabbitMQ not reachable at %s (start one or set AMQP_URL): %v", raw, err)
	}
	_ = c.Close()
	return raw
}

func freshQueue(t *testing.T, raw string) string {
	q := fmt.Sprintf("test-%d", time.Now().UnixNano())
	t.Cleanup(func() {
		conn, err := amqp.Dial(raw)
		if err != nil {
			return
		}
		defer conn.Close()
		ch, _ := conn.Channel()
		_, _ = ch.QueueDelete(q, false, false, false)
		_, _ = ch.QueueDelete(q+".dlq", false, false, false)
	})
	return q
}

func depth(t *testing.T, raw, queue string) int {
	conn, err := amqp.Dial(raw)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	ch, _ := conn.Channel()
	q, err := ch.QueueInspect(queue)
	if err != nil {
		t.Fatal(err)
	}
	return q.Messages
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestPublishedEventIsConfirmedPersistedAndConsumed(t *testing.T) {
	raw := brokerURL(t)
	q := freshQueue(t, raw)
	pub := NewAMQP(raw, q)
	defer pub.Close()
	if err := pub.PublishErr(New("product.created", map[string]any{"id": 7})); err != nil {
		t.Fatal(err)
	}
	if got := depth(t, raw, q); got != 1 {
		t.Fatalf("queue depth = %d, want 1 (event must be routed to the bound queue)", got)
	}
	var mu sync.Mutex
	var seen []Event
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := &Consumer{URL: raw, Queue: q, RetryDelay: 20 * time.Millisecond, Handle: func(e Event) error {
		mu.Lock()
		defer mu.Unlock()
		seen = append(seen, e)
		return nil
	}}
	go c.Run(ctx)
	waitFor(t, "delivery", func() bool { mu.Lock(); defer mu.Unlock(); return len(seen) == 1 })
	if seen[0].Type != "product.created" || string(seen[0].Data) != `{"id":7}` {
		t.Fatalf("unexpected event %+v", seen[0])
	}
	waitFor(t, "ack (queue empty)", func() bool { return depth(t, raw, q) == 0 })
}

func TestFailedHandlerIsRetriedThenSucceeds(t *testing.T) {
	raw := brokerURL(t)
	q := freshQueue(t, raw)
	pub := NewAMQP(raw, q)
	defer pub.Close()
	if err := pub.PublishErr(New("order.updated", 1)); err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := &Consumer{URL: raw, Queue: q, MaxRetries: 5, RetryDelay: 20 * time.Millisecond, Handle: func(Event) error {
		if calls.Add(1) < 3 {
			return fmt.Errorf("transient failure")
		}
		return nil
	}}
	go c.Run(ctx)
	waitFor(t, "third attempt", func() bool { return calls.Load() == 3 })
	waitFor(t, "queues empty", func() bool { return depth(t, raw, q) == 0 && depth(t, raw, q+".dlq") == 0 })
	time.Sleep(200 * time.Millisecond)
	if calls.Load() != 3 {
		t.Fatalf("handler ran %d times after success, want exactly 3", calls.Load())
	}
}

func TestPoisonMessageGoesToTheDeadLetterQueueAfterMaxRetries(t *testing.T) {
	raw := brokerURL(t)
	q := freshQueue(t, raw)
	pub := NewAMQP(raw, q)
	defer pub.Close()
	if err := pub.PublishErr(New("order.deleted", 1)); err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := &Consumer{URL: raw, Queue: q, MaxRetries: 3, RetryDelay: 20 * time.Millisecond, Handle: func(Event) error {
		calls.Add(1)
		panic("boom") // a panicking handler must be treated as a failure, not crash the worker
	}}
	go c.Run(ctx)
	waitFor(t, "dead letter", func() bool { return depth(t, raw, q+".dlq") == 1 })
	if calls.Load() != 3 {
		t.Fatalf("handler ran %d times, want 3 (MaxRetries)", calls.Load())
	}
	if got := depth(t, raw, q); got != 0 {
		t.Fatalf("main queue depth %d, want 0: the poison message must not keep cycling", got)
	}
}

func TestUnacknowledgedMessageIsRedeliveredAfterTheConsumerConnectionDrops(t *testing.T) {
	raw := brokerURL(t)
	q := freshQueue(t, raw)
	pub := NewAMQP(raw, q)
	defer pub.Close()
	if err := pub.PublishErr(New("product.updated", 1)); err != nil {
		t.Fatal(err)
	}
	// A consumer that takes the message and dies without acknowledging it.
	conn, err := amqp.Dial(raw)
	if err != nil {
		t.Fatal(err)
	}
	ch, _ := conn.Channel()
	if err := declare(ch, q); err != nil {
		t.Fatal(err)
	}
	ds, _ := ch.Consume(q, "", false, false, false, false, nil)
	select {
	case <-ds:
	case <-time.After(5 * time.Second):
		t.Fatal("no delivery")
	}
	_ = conn.Close()
	var got atomic.Int32
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go (&Consumer{URL: raw, Queue: q, Handle: func(Event) error { got.Add(1); return nil }}).Run(ctx)
	waitFor(t, "redelivery", func() bool { return got.Load() == 1 })
}
