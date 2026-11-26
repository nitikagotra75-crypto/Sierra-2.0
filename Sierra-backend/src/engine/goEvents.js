/**
 * RabbitMQ domain events for the Go net/http stack (features.events = "rabbitmq"; Kafka is rejected with HTTP 400).
 *
 *  - internal/events: envelope, best-effort confirmed publisher with reconnect + cooldown, consumer with manual acks,
 *    retry via x-retries and a <queue>.dlq dead-letter queue (amqp091-go).
 *  - every entity Service publishes <entity>.created|updated|deleted after a SUCCESSFUL write.
 *  - cmd/worker: the consumer process (the handler is a logging placeholder that must be idempotent).
 *  - tests: unit tests without a broker, an app-level test with a fake publisher, and real-broker tests (skipped, never
 *    passed, when no RabbitMQ is reachable).
 */
const fs = require("fs");
const path = require("path");

const TPL = path.join(__dirname, "templates", "go-events");
const AMQP = { mod: "github.com/rabbitmq/amqp091-go", ver: "v1.9.0" };

function httpError(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
}

function must(src, needle, repl, what) {
  if (!src.includes(needle)) throw new Error(`events patch: anchor not found (${what})`);
  return src.replace(needle, repl);
}

function addRequire(goMod, { mod, ver }) {
  if (goMod.includes(mod + " ")) return goMod;
  if (/require \(\n/.test(goMod)) return goMod.replace(/require \(\n/, `require (\n\t${mod} ${ver}\n`);
  const single = /^require (\S+ \S+)$/m.exec(goMod);
  if (single) return goMod.replace(single[0], `require (\n\t${single[1]}\n\t${mod} ${ver}\n)`);
  return goMod.replace(/\n?$/, `\n\nrequire ${mod} ${ver}\n`);
}

const WORKER = (slug) => `// Command worker consumes domain events from RabbitMQ. Replace handle with real work; it must be idempotent because
// delivery is at-least-once.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"${slug}/internal/events"
)

func handle(ev events.Event) error {
	slog.Info("event", "type", ev.Type, "id", ev.ID, "data", string(ev.Data))
	return nil
}

func main() {
	url := os.Getenv("AMQP_URL")
	if url == "" {
		url = os.Getenv("RABBITMQ_URL")
	}
	if url == "" {
		slog.Error("AMQP_URL is not set")
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	c := &events.Consumer{URL: url, Queue: events.Queue(), Handle: handle}
	slog.Info("worker started", "queue", c.Queue)
	_ = c.Run(ctx)
}
`;

function appTest(spec) {
  const e = spec.entities[0];
  const A = spec.needsAuth;
  const req = e.fields.filter((f) => f.required || f.default === undefined);
  const jv = (f) => (f.type === "string" || f.type === "text" ? JSON.stringify(f.name + " 1") : f.type === "int" ? "1" : f.type === "float" ? "1.5" : f.type === "bool" ? "true" : JSON.stringify(f.values[0]));
  const payload = "{" + req.map((f) => `"${f.name}": ${jv(f)}`).join(", ") + "}";
  const tick = "`";
  return `package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"${spec.slug}/internal/config"
	"${spec.slug}/internal/events"
)

type recorder struct {
	mu  sync.Mutex
	got []events.Event
}

func (r *recorder) Publish(ev events.Event) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.got = append(r.got, ev)
}

func (r *recorder) types() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []string
	for _, e := range r.got {
		out = append(out, e.Type)
	}
	return out
}

func ecall(h http.Handler, method, path, token, body string) (int, string) {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w.Code, w.Body.String()
}

func TestSuccessfulWritesPublishEventsAndFailedOnesDoNot(t *testing.T) {
	rec := &recorder{}
	events.SetShared(rec)
	t.Cleanup(func() { events.SetShared(events.Noop{}) })
	h := New(config.Config{JWTSecret: "test-secret-not-for-production-0123456789", JWTTTL: 3600e9})
	tok := ""
${A ? `	if c, b := ecall(h, "POST", "/api/auth/register", "", ${tick}{"email": "ev@example.com", "name": "E", "password": "password123"}${tick}); c != 201 {
		t.Fatalf("register: %d %s", c, b)
	}
	_, b := ecall(h, "POST", "/api/auth/login", "", ${tick}{"email": "ev@example.com", "password": "password123"}${tick})
	var out struct {
		Token string ${tick}json:"access_token"${tick}
	}
	_ = json.Unmarshal([]byte(b), &out)
	tok = out.Token
` : ""}	if got := rec.types(); len(got) != 0 {
		t.Fatalf("auth must not publish entity events, got %v", got)
	}
	code, body := ecall(h, "POST", "/api/${e.plural}", tok, ${tick}${payload}${tick})
	if code != 201 {
		t.Fatalf("create: %d %s", code, body)
	}
	var created map[string]any
	_ = json.Unmarshal([]byte(body), &created)
	id := strings.TrimSuffix(strings.TrimPrefix(string(mustJSON(created["id"])), ""), "")
	if c, b := ecall(h, "PUT", "/api/${e.plural}/"+id, tok, "{}"); c != 200 {
		t.Fatalf("update: %d %s", c, b)
	}
	if c, b := ecall(h, "GET", "/api/${e.plural}/"+id, tok, ""); c != 200 {
		t.Fatalf("get: %d %s", c, b)
	}
	if c, _ := ecall(h, "DELETE", "/api/${e.plural}/"+id, tok, ""); c/100 != 2 {
		t.Fatalf("delete: %d", c)
	}
	want := []string{"${e.lower}.created", "${e.lower}.updated", "${e.lower}.deleted"}
	got := rec.types()
	if len(got) != 3 || got[0] != want[0] || got[1] != want[1] || got[2] != want[2] {
		t.Fatalf("events = %v, want %v (a read must not publish)", got, want)
	}
	if !strings.Contains(string(rec.got[0].Data), ${tick}"id":${tick}) {
		t.Fatalf("created event carries the entity: %s", rec.got[0].Data)
	}
	// failures publish nothing
	before := len(rec.types())
	ecall(h, "GET", "/api/${e.plural}/999999", tok, "")
	ecall(h, "PUT", "/api/${e.plural}/999999", tok, "{}")
	ecall(h, "DELETE", "/api/${e.plural}/999999", tok, "")
	if n := len(rec.types()); n != before {
		t.Fatalf("not-found requests published %d event(s)", n-before)
	}
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}
`;
}

const README = `## Events (RabbitMQ)
Every successful create/update/delete publishes \`<entity>.created|updated|deleted\` (JSON: id, type, ts, data) to the durable topic exchange \`domain-events\`; set \`AMQP_URL\` to enable it (without it events are dropped and a warning is logged once). Publishing is **best effort**: publisher confirms are awaited, but a broker outage is logged and never fails the request, so events can be lost (no transactional outbox). After a failure the publisher backs off for 5 s instead of paying a connect timeout on every request.

Run the consumer with \`go run ./cmd/worker\` (queue \`EVENT_QUEUE\`, default \`domain-events\`). A message is acknowledged only after the handler succeeds; failures are re-queued with an \`x-retries\` header and, after 3 attempts, moved to \`<queue>.dlq\`. Delivery is at-least-once, so \`handle\` in \`cmd/worker/main.go\` (a logging placeholder) must be idempotent. \`internal/events\` tests run against a real RabbitMQ when \`AMQP_URL\` is reachable and are skipped otherwise.

`;

function patch(spec, f) {
  for (const name of fs.readdirSync(TPL)) f[`internal/events/${name}`] = fs.readFileSync(path.join(TPL, name), "utf8");
  f["cmd/worker/main.go"] = WORKER(spec.slug);
  f["internal/app/events_test.go"] = appTest(spec);
  f["go.mod"] = addRequire(f["go.mod"], AMQP);
  const imp = `\t"${spec.slug}/internal/events"\n`;
  const httpxImp = `\t"${spec.slug}/internal/httpx"\n`;
  for (const e of spec.entities) {
    const file = `internal/${e.lower}/${e.lower}.go`;
    let s = f[file];
    s = must(s, "type Service struct{ Repo Repository }", `type Service struct {
	Repo   Repository
	Events events.Publisher // nil = no events
}

func (s *Service) emit(typ string, data any) {
	if s.Events != nil {
		s.Events.Publish(events.New(typ, data))
	}
}`, `${e.lower} service`);
    s = must(s, httpxImp, imp + httpxImp, `${e.lower} import`);
    s = s.replace(/func \(s \*Service\) Create\(([^)]*)\) \((\w+), error\) \{/, (m, params, T) => {
      const args = params.split(",").map((p) => p.trim().split(/\s+/)[0]).map((n) => (n === "_" ? "0" : n)).join(", ");
      return `func (s *Service) Create(${params}) (${T}, error) {\n\tv, err := s.create(${args})\n\tif err == nil {\n\t\ts.emit("${e.lower}.created", v)\n\t}\n\treturn v, err\n}\n\nfunc (s *Service) create(${params}) (${T}, error) {`;
    });
    s = s.replace(/func \(s \*Service\) Update\(([^)]*)\) \((\w+), error\) \{/, (m, params, T) => {
      const args = params.split(",").map((p) => p.trim().split(/\s+/)[0]).map((n) => (n === "_" ? "0" : n)).join(", ");
      return `func (s *Service) Update(${params}) (${T}, error) {\n\tv, err := s.update(${args})\n\tif err == nil {\n\t\ts.emit("${e.lower}.updated", v)\n\t}\n\treturn v, err\n}\n\nfunc (s *Service) update(${params}) (${T}, error) {`;
    });
    s = s.replace(/func \(s \*Service\) Delete\(([^)]*)\) error \{/, (m, params) => {
      const args = params.split(",").map((p) => p.trim().split(/\s+/)[0]).map((n) => (n === "_" ? "0" : n)).join(", ");
      const id = args.split(", ")[0];
      return `func (s *Service) Delete(${params}) error {\n\tif err := s.delete(${args}); err != nil {\n\t\treturn err\n\t}\n\ts.emit("${e.lower}.deleted", map[string]int64{"id": ${id}})\n\treturn nil\n}\n\nfunc (s *Service) delete(${params}) error {`;
    });
    if (!/s\.create\(/.test(s) || !/s\.update\(/.test(s) || !/s\.delete\(/.test(s)) throw new Error("events patch: service methods not rewritten for " + e.name);
    f[file] = s;
  }
  let app = f["internal/app/app.go"];
  app = must(app, httpxImp, imp + httpxImp, "app import");
  for (const e of spec.entities) app = must(app, `Service{Repo: st.${e.name}}`, `Service{Repo: st.${e.name}, Events: events.Shared()}`, "app wiring " + e.name);
  f["internal/app/app.go"] = app;
  let main = f["cmd/server/main.go"];
  const anchor = main.includes(`\t"${spec.slug}/internal/distributed"\n`) ? `\t"${spec.slug}/internal/distributed"\n` : `\t"${spec.slug}/internal/config"\n`;
  main = must(main, anchor, anchor + imp, "main import");
  main = must(main, "\tsrv := &http.Server{", "\tdefer events.Close()\n\n\tsrv := &http.Server{", "main close");
  f["cmd/server/main.go"] = main;
  f["Dockerfile"] = must(f["Dockerfile"], "go build -o /out/server ./cmd/server\n", "go build -o /out/server ./cmd/server && CGO_ENABLED=0 go build -o /out/worker ./cmd/worker\n", "dockerfile build");
  f["Dockerfile"] = must(f["Dockerfile"], "COPY --from=build /out/server /server\n", "COPY --from=build /out/server /server\nCOPY --from=build /out/worker /worker\n", "dockerfile copy");
  if (!f["Dockerfile"].includes("go mod tidy")) f["Dockerfile"] = must(f["Dockerfile"], "COPY . .\n", "COPY . .\n# go.sum is not generated by Sierra: it is resolved here (run `go mod tidy` once locally and commit go.sum to pin it)\nRUN go mod tidy\n", "go dockerfile");
  f[".env.example"] += "AMQP_URL=amqp://app:app@localhost:5672/\nEVENT_QUEUE=domain-events\n";
  f["README.md"] = must(f["README.md"], "## Known limitations", README + "## Known limitations", "readme");
}

function withGoEvents(stack) {
  const base = stack.generate;
  return {
    ...stack,
    features: [...(stack.features || []), "events"],
    validate: {
      ...stack.validate,
      setupFor: (spec) => (spec.features && spec.features.events ? [["go", "mod", "tidy"]] : stack.validate.setupFor ? stack.validate.setupFor(spec) : stack.validate.setup || []),
      requiresFor: (spec) => [
        ...(stack.validate.requiresFor ? stack.validate.requiresFor(spec) : []),
        ...(spec.features && spec.features.events === "rabbitmq" ? [{ name: "RabbitMQ", env: "AMQP_URL", fallback: "amqp://app:app@localhost:5672/", hint: "Start one with `docker run -d -p 5672:5672 -e RABBITMQ_DEFAULT_USER=app -e RABBITMQ_DEFAULT_PASS=app rabbitmq:3.13` or set AMQP_URL; the generated GitHub Actions workflow starts a RabbitMQ service container." }] : []),
      ],
    },
    generate(spec) {
      const ev = spec.features && spec.features.events;
      if (ev && ev !== "rabbitmq") throw httpError(`stack '${stack.id}' supports events: rabbitmq only (Kafka is not implemented for Go)`);
      const files = base(spec);
      if (ev) patch(spec, files);
      return files;
    },
  };
}

module.exports = { withGoEvents };
