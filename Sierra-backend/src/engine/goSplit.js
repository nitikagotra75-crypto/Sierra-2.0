/**
 * Read/write splitting for the Go net/http stack with PostgreSQL or MySQL (features.readWriteSplit).
 *
 * What is generated: application-side routing only. List queries go round-robin to the replicas in DATABASE_REPLICA_URLS;
 * a replica that errors is skipped for a cooldown and the query falls back to the next replica and finally the primary.
 * Everything else (writes, by-id reads, auth lookups, migrations) uses the primary, so a client reads its own writes.
 * What is NOT generated: the replication topology itself, failover, or lag awareness (replicas are asynchronous).
 */
const path = require("path");

function httpError(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
}

function must(src, needle, repl, what) {
  if (!src.includes(needle)) throw new Error(`readWriteSplit patch: anchor not found (${what})`);
  return src.replace(needle, repl);
}

const REPLICAS_GO = `package store

import (
	"database/sql"
	"net/url"
	"sync"
	"time"
)

// Replicas routes read-only queries to replica databases and falls back to the primary.
type Replicas struct {
	// Cooldown is how long a replica that failed is skipped (default 15 s).
	Cooldown time.Duration

	mu   sync.Mutex
	list []*replica
	next int
	now  func() time.Time
}

type replica struct {
	db        *sql.DB
	label     string
	downUntil time.Time
	lastErr   string
	served    int64
	failures  int64
}

// ReplicaStatus is a snapshot for health endpoints and tests. URLs are reduced to host/database: no credentials.
type ReplicaStatus struct {
	Target    string
	Healthy   bool
	LastError string
	Served    int64
	Failures  int64
}

// OpenReplicas prepares pools for the replica URLs. It does not connect: an unreachable replica must not stop the
// application from starting, it is simply skipped until it answers.
func OpenReplicas(rawURLs []string, o Options) (*Replicas, error) {
	r := &Replicas{Cooldown: 15 * time.Second, now: time.Now}
	for _, raw := range rawURLs {
		dsn, err := DSN(raw)
		if err != nil {
			return nil, err
		}
		db, err := sql.Open(DriverName, dsn)
		if err != nil {
			return nil, err
		}
		if o.MaxOpen > 0 {
			db.SetMaxOpenConns(o.MaxOpen)
		}
		if o.MaxIdle > 0 {
			db.SetMaxIdleConns(o.MaxIdle)
		}
		if o.MaxLifetime > 0 {
			db.SetConnMaxLifetime(o.MaxLifetime)
		}
		label := raw
		if u, err := url.Parse(raw); err == nil {
			label = u.Host + u.Path
		}
		r.list = append(r.list, &replica{db: db, label: label})
	}
	return r, nil
}

// Query runs a read on the next healthy replica, or on the primary when there is none (or r is nil).
func (r *Replicas) Query(primary *sql.DB, q string, args ...any) (*sql.Rows, error) {
	if r != nil {
		for _, rp := range r.candidates() {
			rows, err := rp.db.Query(q, args...)
			if err == nil {
				r.mu.Lock()
				rp.served++
				rp.lastErr = ""
				r.mu.Unlock()
				return rows, nil
			}
			r.mu.Lock()
			rp.failures++
			rp.lastErr = err.Error()
			rp.downUntil = r.now().Add(r.Cooldown)
			r.mu.Unlock()
		}
	}
	return primary.Query(q, args...)
}

// candidates returns the replicas that are not cooling down, starting after the one used last (round robin).
func (r *Replicas) candidates() []*replica {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := len(r.list)
	var out []*replica
	for i := 0; i < n; i++ {
		rp := r.list[(r.next+i)%n]
		if !r.now().Before(rp.downUntil) {
			out = append(out, rp)
		}
	}
	if n > 0 {
		r.next = (r.next + 1) % n
	}
	return out
}

// Status reports every replica.
func (r *Replicas) Status() []ReplicaStatus {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]ReplicaStatus, 0, len(r.list))
	for _, rp := range r.list {
		out = append(out, ReplicaStatus{Target: rp.label, Healthy: !r.now().Before(rp.downUntil) && rp.lastErr == "", LastError: rp.lastErr, Served: rp.served, Failures: rp.failures})
	}
	return out
}

// Close releases every replica pool.
func (r *Replicas) Close() {
	if r == nil {
		return
	}
	for _, rp := range r.list {
		_ = rp.db.Close()
	}
}
`;

const testGo = (spec) => {
  const e = spec.entities[0];
  const A = spec.needsAuth;
  const req = e.fields.filter((f) => f.required || f.default === undefined);
  const jv = (f) => (f.type === "string" || f.type === "text" ? JSON.stringify(f.name + " 1") : f.type === "int" ? "1" : f.type === "float" ? "1.5" : f.type === "bool" ? "true" : JSON.stringify(f.values[0]));
  const payload = "{" + req.map((f) => `"${f.name}": ${jv(f)}`).join(", ") + "}";
  return `package app

import (
	"encoding/json"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"__APPMOD__/internal/config"
	"__APPMOD__/internal/store"
)

// Real primary + replica (TEST_DATABASE_URL, TEST_DATABASE_REPLICA_URLS). Skipped - never passed - without them.
func replicaURLs(t *testing.T) []string {
	t.Helper()
	raw := os.Getenv("TEST_DATABASE_REPLICA_URLS")
	if raw == "" {
		t.Skip("TEST_DATABASE_REPLICA_URLS is not set: the replica routing test did NOT run")
	}
	return strings.Split(raw, ",")
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestListIsServedByTheReplicaWhileWritesAndByIDReadsUseThePrimary(t *testing.T) {
	db, _ := testDB(t)
	urls := replicaURLs(t)
	rep, err := store.OpenReplicas(urls, store.Options{MaxOpen: 4, MaxIdle: 2})
	if err != nil {
		t.Fatal(err)
	}
	defer rep.Close()
	rdb, err := store.Open(urls[0], store.Options{MaxOpen: 2, ConnectTimeout: 10 * time.Second})
	if err != nil {
		t.Fatalf("cannot connect to the replica directly: %v", err)
	}
	defer rdb.Close()
	st, err := SQLStoresWith(db, rep)
	if err != nil {
		t.Fatalf("migrate: %v", err)
	}
	eventually(t, "the schema to reach the replica", func() bool {
		var n int
		return rdb.QueryRow("SELECT COUNT(*) FROM ${e.plural}").Scan(&n) == nil
	})
	h := NewWith(config.Config{JWTSecret: "test-secret-not-for-production-0123456789", JWTTTL: 3600e9}, st)
	tok := ${A ? 'register(t, h, "split@example.com")' : '""'}
	code, b := call(t, h, "POST", "/api/${e.plural}", tok, \`${payload}\`)
	if code != 201 {
		t.Fatalf("create: %d %s", code, b)
	}
	var created map[string]any
	_ = json.Unmarshal(b, &created)
	id := strings.TrimSuffix(string(splitJSON(created["id"])), ".0")
	if c, body := call(t, h, "GET", "/api/${e.plural}/"+id, tok, ""); c != 200 {
		t.Fatalf("a by-id read right after the write must see it (primary), got %d %s", c, body)
	}
	eventually(t, "the row to replicate", func() bool {
		var n int
		return rdb.QueryRow("SELECT COUNT(*) FROM ${e.plural}").Scan(&n) == nil && n == 1
	})
	before := rep.Status()[0].Served
	code, b = call(t, h, "GET", "/api/${e.plural}", tok, "")
	var items []map[string]any
	_ = json.Unmarshal(b, &items)
	if code != 200 || len(items) != 1 {
		t.Fatalf("list: %d %s", code, b)
	}
	if rep.Status()[0].Served != before+1 {
		t.Fatalf("the list was not served by the replica (served %d -> %d)", before, rep.Status()[0].Served)
	}
}

func TestUnreachableReplicaFallsBackToThePrimaryAndIsSkippedDuringTheCooldown(t *testing.T) {
	db, raw := testDB(t)
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	u.Host = "127.0.0.1:1" // nothing listens here
	rep, err := store.OpenReplicas([]string{u.String()}, store.Options{})
	if err != nil {
		t.Fatalf("an unreachable replica must not stop startup: %v", err)
	}
	defer rep.Close()
	st, err := SQLStoresWith(db, rep)
	if err != nil {
		t.Fatal(err)
	}
	h := NewWith(config.Config{JWTSecret: "test-secret-not-for-production-0123456789", JWTTTL: 3600e9}, st)
	tok := ${A ? 'register(t, h, "fallback@example.com")' : '""'}
	if c, b := call(t, h, "POST", "/api/${e.plural}", tok, \`${payload}\`); c != 201 {
		t.Fatalf("create: %d %s", c, b)
	}
	for i := 0; i < 3; i++ {
		c, b := call(t, h, "GET", "/api/${e.plural}", tok, "")
		var items []map[string]any
		_ = json.Unmarshal(b, &items)
		if c != 200 || len(items) != 1 {
			t.Fatalf("list %d with a dead replica must come from the primary: %d %s", i, c, b)
		}
	}
	s := rep.Status()[0]
	if s.Healthy || s.Served != 0 || s.Failures != 1 {
		t.Fatalf("status %+v: want unhealthy, 0 served and exactly 1 failure (later requests skip it during the cooldown)", s)
	}
}

func splitJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}
`;
};

function patch(spec, f) {
  f["internal/store/replicas.go"] = REPLICAS_GO;
  f["internal/app/replica_test.go"] = testGo(spec).replace(/__APPMOD__/g, spec.slug);
  for (const e of spec.entities) {
    const file = `internal/${e.lower}/sql_repo.go`;
    let s = f[file];
    s = must(s, "type SQLRepo struct{ DB *sql.DB }", "// SQLRepo is the SQL implementation; Read (optional) routes List queries to replicas.\ntype SQLRepo struct {\n\tDB   *sql.DB\n\tRead *store.Replicas\n}", `${e.name} struct`);
    s = must(s, "func NewSQLRepo(db *sql.DB) *SQLRepo { return &SQLRepo{DB: db} }", "func NewSQLRepo(db *sql.DB) *SQLRepo { return &SQLRepo{DB: db} }\n\n// NewSQLRepoWith reads lists from rep (nil = primary only).\nfunc NewSQLRepoWith(db *sql.DB, rep *store.Replicas) *SQLRepo { return &SQLRepo{DB: db, Read: rep} }", `${e.name} ctor`);
    const n = (s.match(/rows, err := r\.DB\.Query\(store\.Rebind\(/g) || []).length;
    if (n !== 1) throw new Error(`readWriteSplit patch: expected exactly one List query in ${file}, found ${n}`);
    s = s.replace("rows, err := r.DB.Query(store.Rebind(", "rows, err := r.Read.Query(r.DB, store.Rebind(");
    f[file] = s;
  }
  let sql = f["internal/app/sql.go"];
  sql = must(sql, "func SQLStores(db *sql.DB) (Stores, error) {", "func SQLStores(db *sql.DB) (Stores, error) { return SQLStoresWith(db, nil) }\n\n// SQLStoresWith is SQLStores with list reads routed to the replicas (nil = primary only). Migrations and every write use db.\nfunc SQLStoresWith(db *sql.DB, rep *store.Replicas) (Stores, error) {", "sql.go");
  for (const e of spec.entities) sql = must(sql, `${e.lower}.NewSQLRepo(db)`, `${e.lower}.NewSQLRepoWith(db, rep)`, `sql.go ${e.name}`);
  f["internal/app/sql.go"] = sql;
  let cfg = f["internal/config/config.go"];
  cfg = must(cfg, "\tDatabaseURL    string\n", "\tDatabaseURL    string\n\t// Optional read replicas (comma separated URLs of the same kind as DATABASE_URL).\n\tDatabaseReplicaURLs []string\n", "config field");
  cfg = must(cfg, '\tc.DatabaseURL = os.Getenv("DATABASE_URL")\n', '\tc.DatabaseURL = os.Getenv("DATABASE_URL")\n\tfor _, u := range strings.Split(os.Getenv("DATABASE_REPLICA_URLS"), ",") {\n\t\tif u = strings.TrimSpace(u); u != "" {\n\t\t\tc.DatabaseReplicaURLs = append(c.DatabaseReplicaURLs, u)\n\t\t}\n\t}\n', "config parse");
  cfg = must(cfg, '\t"strconv"\n', '\t"strconv"\n\t"strings"\n', "config import");
  f["internal/config/config.go"] = cfg;
  let main = f["cmd/server/main.go"];
  main = must(main, "\t\tstores, err := app.SQLStores(db)\n", `		var replicas *store.Replicas
		if len(cfg.DatabaseReplicaURLs) > 0 {
			replicas, err = store.OpenReplicas(cfg.DatabaseReplicaURLs, store.Options{MaxOpen: cfg.DBMaxOpen, MaxIdle: cfg.DBMaxIdle, MaxLifetime: cfg.DBMaxLifetime})
			if err != nil {
				slog.Error("replicas", "err", err)
				os.Exit(1)
			}
			defer replicas.Close()
			slog.Info("list reads are routed to replicas", "count", len(cfg.DatabaseReplicaURLs))
		}
		stores, err := app.SQLStoresWith(db, replicas)
`, "main stores");
  f["cmd/server/main.go"] = main;
  f[".env.example"] += "# Optional read replicas, comma separated (list endpoints only; replicas are asynchronous, so reads can be stale)\nDATABASE_REPLICA_URLS=\n";
  f["README.md"] = must(f["README.md"], "## Known limitations", `## Read replicas
Set \`DATABASE_REPLICA_URLS\` to route the **list** endpoints to read replicas (round robin). Writes, by-id reads, auth lookups and migrations always use the primary, so a client reads its own writes. A replica that errors is skipped for 15 s and the query falls back to the next replica and finally the primary; an unreachable replica never stops the app from starting. Sierra generates the application side only: **you provision and operate the replication** (asynchronous, so list reads can lag; no failover, no lag awareness; a replica that accepts connections but hangs is not detected). \`internal/app/replica_test.go\` runs against a real primary + replica when \`TEST_DATABASE_REPLICA_URLS\` is set and is skipped otherwise (CI service containers cannot provide a replica).

## Known limitations`, "readme");
}

const REPLICA_ENV = { postgresql: "postgres://app:app@127.0.0.1:5441/app?sslmode=disable", mysql: "mysql://app:app@127.0.0.1:3308/app" };

function withGoSplit(stack) {
  const base = stack.generate;
  return {
    ...stack,
    features: [...(stack.features || []), "readWriteSplit"],
    validate: {
      ...stack.validate,
      requiresFor: (spec) => [
        ...(stack.validate.requiresFor ? stack.validate.requiresFor(spec) : []),
        ...(spec.features && spec.features.readWriteSplit ? [{ name: "database replica", env: "TEST_DATABASE_REPLICA_URLS", fallback: REPLICA_ENV[spec.database] || REPLICA_ENV.postgresql, hint: "Start a replica (scripts/start-test-postgres.sh or scripts/start-test-mysql-replica.sh) or set TEST_DATABASE_REPLICA_URLS. Sierra generates the routing only; the replica is yours to run." }] : []),
      ],
    },
    generate(spec) {
      const on = spec.features && spec.features.readWriteSplit;
      if (on && !["postgresql", "mysql"].includes(spec.database)) throw httpError("readWriteSplit requires database=postgresql or mysql");
      const files = base(spec);
      if (on) patch(spec, files);
      return files;
    },
  };
}

module.exports = { withGoSplit };
