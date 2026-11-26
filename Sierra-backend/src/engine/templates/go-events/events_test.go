package events

import (
	"encoding/json"
	"testing"
	"time"
)

func TestNewEnvelope(t *testing.T) {
	ev := New("product.created", map[string]any{"id": 1})
	if ev.Type != "product.created" || len(ev.ID) != 32 || ev.TS == "" {
		t.Fatalf("bad envelope: %+v", ev)
	}
	raw, _ := json.Marshal(ev)
	var back Event
	if err := json.Unmarshal(raw, &back); err != nil || string(back.Data) != `{"id":1}` {
		t.Fatalf("round trip failed: %v %s", err, back.Data)
	}
	if New("a", 1).ID == New("a", 1).ID {
		t.Fatal("ids must be unique")
	}
}

func TestPublishNeverFailsTheCallerWhenTheBrokerIsDown(t *testing.T) {
	p := NewAMQP("amqp://app:app@127.0.0.1:1/", "q")
	p.Timeout = 300 * time.Millisecond
	p.Cooldown = time.Minute
	start := time.Now()
	if err := p.PublishErr(New("x.created", 1)); err == nil {
		t.Fatal("expected an error with no broker")
	}
	p.Publish(New("x.created", 1)) // must return, not panic
	// the second call is inside the cooldown, so it must not pay another connect attempt
	t0 := time.Now()
	_ = p.PublishErr(New("x.created", 1))
	if time.Since(t0) > 100*time.Millisecond {
		t.Fatalf("cooldown not applied: second call took %s", time.Since(t0))
	}
	if time.Since(start) > 3*time.Second {
		t.Fatal("publishing against a dead broker blocked too long")
	}
}
