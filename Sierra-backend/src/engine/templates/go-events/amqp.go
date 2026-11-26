package events

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

// declare creates the durable topology: exchange, queue bound with "#", and <queue>.dlq.
func declare(ch *amqp.Channel, queue string) error {
	if err := ch.ExchangeDeclare(Exchange, "topic", true, false, false, false, nil); err != nil {
		return err
	}
	if _, err := ch.QueueDeclare(queue, true, false, false, false, nil); err != nil {
		return err
	}
	if err := ch.QueueBind(queue, "#", Exchange, false, nil); err != nil {
		return err
	}
	_, err := ch.QueueDeclare(queue+".dlq", true, false, false, false, nil)
	return err
}

// AMQP publishes with publisher confirms and reconnects lazily. After a failure it refuses to retry for Cooldown, so a
// broker outage costs requests nothing instead of a connect timeout each.
type AMQP struct {
	URL      string
	Queue    string
	Timeout  time.Duration
	Cooldown time.Duration

	mu       sync.Mutex
	conn     *amqp.Connection
	ch       *amqp.Channel
	confirms chan amqp.Confirmation
	nextTry  time.Time
}

func NewAMQP(url, queue string) *AMQP {
	return &AMQP{URL: url, Queue: queue, Timeout: 3 * time.Second, Cooldown: 5 * time.Second}
}

func (p *AMQP) connect() error {
	conn, err := amqp.DialConfig(p.URL, amqp.Config{Dial: amqp.DefaultDial(p.Timeout), Heartbeat: 10 * time.Second})
	if err != nil {
		return err
	}
	ch, err := conn.Channel()
	if err != nil {
		_ = conn.Close()
		return err
	}
	if err := declare(ch, p.Queue); err != nil {
		_ = conn.Close()
		return err
	}
	if err := ch.Confirm(false); err != nil {
		_ = conn.Close()
		return err
	}
	p.conn, p.ch = conn, ch
	p.confirms = ch.NotifyPublish(make(chan amqp.Confirmation, 1))
	return nil
}

func (p *AMQP) reset() {
	if p.conn != nil {
		_ = p.conn.Close()
	}
	p.conn, p.ch, p.confirms = nil, nil, nil
}

// PublishErr publishes one event and waits for the broker's confirm.
func (p *AMQP) PublishErr(ev Event) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.conn == nil || p.conn.IsClosed() {
		p.reset()
		if time.Now().Before(p.nextTry) {
			return errors.New("broker unavailable (cooling down)")
		}
		if err := p.connect(); err != nil {
			p.nextTry = time.Now().Add(p.Cooldown)
			return err
		}
	}
	body, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), p.Timeout)
	defer cancel()
	if err := p.ch.PublishWithContext(ctx, Exchange, ev.Type, false, false, amqp.Publishing{
		ContentType: "application/json", DeliveryMode: amqp.Persistent, MessageId: ev.ID, Body: body,
	}); err != nil {
		p.reset()
		p.nextTry = time.Now().Add(p.Cooldown)
		return err
	}
	select {
	case c := <-p.confirms:
		if !c.Ack {
			return errors.New("broker nacked the event")
		}
		return nil
	case <-ctx.Done():
		p.reset()
		p.nextTry = time.Now().Add(p.Cooldown)
		return errors.New("timed out waiting for the broker confirm")
	}
}

// Publish is best effort: errors are logged, never returned.
func (p *AMQP) Publish(ev Event) {
	if err := p.PublishErr(ev); err != nil {
		slog.Warn("event not published", "type", ev.Type, "id", ev.ID, "error", err.Error())
	}
}

func (p *AMQP) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.reset()
	return nil
}

// Handler processes one event; returning an error (or panicking) triggers a retry.
type Handler func(Event) error

// Consumer reads Queue with manual acknowledgements.
type Consumer struct {
	URL        string
	Queue      string
	MaxRetries int           // total delivery attempts before dead-lettering (default 3)
	RetryDelay time.Duration // pause before a failed message is re-queued (default 500ms)
	Handle     Handler
}

func (c *Consumer) attempts() int {
	if c.MaxRetries <= 0 {
		return 3
	}
	return c.MaxRetries
}

func safe(h Handler, ev Event) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("handler panic: %v", r)
		}
	}()
	return h(ev)
}

// Run consumes until ctx is cancelled, reconnecting with a short backoff when the broker goes away. Messages that were
// delivered but not acknowledged when the connection dropped are redelivered by the broker.
func (c *Consumer) Run(ctx context.Context) error {
	for {
		err := c.runOnce(ctx)
		if ctx.Err() != nil {
			return nil
		}
		slog.Warn("consumer disconnected, retrying", "error", fmt.Sprint(err))
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(time.Second):
		}
	}
}

func (c *Consumer) runOnce(ctx context.Context) error {
	conn, err := amqp.DialConfig(c.URL, amqp.Config{Dial: amqp.DefaultDial(5 * time.Second), Heartbeat: 10 * time.Second})
	if err != nil {
		return err
	}
	defer conn.Close()
	ch, err := conn.Channel()
	if err != nil {
		return err
	}
	if err := declare(ch, c.Queue); err != nil {
		return err
	}
	if err := ch.Qos(10, 0, false); err != nil {
		return err
	}
	pub, err := conn.Channel() // republishing (retry / DLQ) uses confirms so a message is never acked before its copy is safe
	if err != nil {
		return err
	}
	if err := pub.Confirm(false); err != nil {
		return err
	}
	confirms := pub.NotifyPublish(make(chan amqp.Confirmation, 1))
	deliveries, err := ch.Consume(c.Queue, "", false, false, false, false, nil)
	if err != nil {
		return err
	}
	closed := conn.NotifyClose(make(chan *amqp.Error, 1))
	delay := c.RetryDelay
	if delay == 0 {
		delay = 500 * time.Millisecond
	}
	for {
		select {
		case <-ctx.Done():
			return nil
		case e := <-closed:
			if e == nil {
				return errors.New("connection closed")
			}
			return e
		case d, ok := <-deliveries:
			if !ok {
				return errors.New("delivery channel closed")
			}
			c.process(ctx, d, pub, confirms, delay)
		}
	}
}

func retriesOf(d amqp.Delivery) int {
	switch v := d.Headers["x-retries"].(type) {
	case int32:
		return int(v)
	case int64:
		return int(v)
	case int:
		return v
	}
	return 0
}

func (c *Consumer) process(ctx context.Context, d amqp.Delivery, pub *amqp.Channel, confirms <-chan amqp.Confirmation, delay time.Duration) {
	var ev Event
	handleErr := json.Unmarshal(d.Body, &ev)
	if handleErr == nil {
		handleErr = safe(c.Handle, ev)
	}
	if handleErr == nil {
		_ = d.Ack(false)
		return
	}
	tries := retriesOf(d) + 1
	headers := amqp.Table{"x-retries": int32(tries), "x-last-error": handleErr.Error()}
	target := c.Queue
	if tries >= c.attempts() {
		target = c.Queue + ".dlq"
		slog.Error("event dead-lettered", "queue", c.Queue, "type", ev.Type, "id", ev.ID, "error", handleErr.Error())
	} else {
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			_ = d.Nack(false, true)
			return
		}
	}
	for len(confirms) > 0 { // a late confirm from an earlier timed-out publish must not be taken for this one
		<-confirms
	}
	// default exchange routes by queue name; the copy is confirmed before the original is acknowledged
	pctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	err := pub.PublishWithContext(pctx, "", target, false, false, amqp.Publishing{
		ContentType: d.ContentType, DeliveryMode: amqp.Persistent, MessageId: d.MessageId, Body: d.Body, Headers: headers,
	})
	if err == nil {
		select {
		case cf := <-confirms:
			if !cf.Ack {
				err = errors.New("nacked")
			}
		case <-pctx.Done():
			err = pctx.Err()
		}
	}
	if err != nil {
		_ = d.Nack(false, true) // could not store the copy: keep the original
		return
	}
	_ = d.Ack(false)
}
