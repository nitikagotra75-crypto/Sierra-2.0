/**
 * SQL persistence for the Go net/http stack (PostgreSQL via lib/pq, MySQL via go-sql-driver/mysql, both through
 * database/sql). Generated only when spec.database is "postgresql" or "mysql"; "memory" keeps the in-memory repositories.
 *
 *  - internal/store: Open (pool settings + wait-for-database), Migrate (versioned migrations in schema_migrations,
 *    serialized with a database lock so concurrent starters are safe), and ONE dialect file for the chosen database.
 *  - <entity>/sql_repo.go + schema.go, auth/sql_users.go: repositories implementing the same interfaces as the memory ones.
 *  - app/sql.go: SQLStores(db) runs the migrations and returns the stores; app/sql_test.go: integration tests that run
 *    against a REAL database (TEST_DATABASE_URL).
 * Limits (also in the README): no context propagation (queries are not cancelled with the request), no read replicas, no
 * schema-diff tooling: migrations are append-only and a changed entity needs a new migration.
 */
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const goStr = (s) => JSON.stringify(s);
const snake = (n) => String(n).replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

const VERSIONS = { postgresql: { mod: "github.com/lib/pq", ver: "v1.10.9" }, mysql: { mod: "github.com/go-sql-driver/mysql", ver: "v1.7.1" } };

const TYPES = {
  postgresql: { id: "BIGSERIAL PRIMARY KEY", string: "TEXT", text: "TEXT", int: "BIGINT", float: "DOUBLE PRECISION", bool: "BOOLEAN", enum: "TEXT", ts: "TIMESTAMPTZ", tail: "" },
  mysql: { id: "BIGINT AUTO_INCREMENT PRIMARY KEY", string: "VARCHAR(255)", text: "TEXT", int: "BIGINT", float: "DOUBLE", bool: "TINYINT(1)", enum: "VARCHAR(64)", ts: "DATETIME(6)", tail: " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4" },
};
const quote = (db, n) => (db === "postgresql" ? `"${n}"` : `\`${n}\``);
const isSql = (spec) => spec.database === "postgresql" || spec.database === "mysql";
const dbLabel = (db) => (db === "postgresql" ? "PostgreSQL" : "MySQL");
const testUrl = (db) => (db === "postgresql" ? "postgres://app:app@localhost:5432/app?sslmode=disable" : "mysql://app:app@localhost:3306/app");

function dialectGo(db) {
  if (db === "postgresql") return `package store

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/lib/pq"
)

// DriverName is the database/sql driver registered by the imported package.
const DriverName = "postgres"

// DSN: lib/pq understands postgres:// URLs directly; a 5 s connect timeout is added unless the URL sets one, so an
// unreachable server fails fast instead of hanging a request.
func DSN(url string) (string, error) {
	if strings.Contains(url, "connect_timeout=") {
		return url, nil
	}
	if strings.Contains(url, "?") {
		return url + "&connect_timeout=5", nil
	}
	return url + "?connect_timeout=5", nil
}

// Rebind converts ? placeholders to $1, $2, ...
func Rebind(q string) string {
	var b strings.Builder
	n := 0
	for _, r := range q {
		if r == '?' {
			n++
			b.WriteString("$" + strconv.Itoa(n))
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// IsUnique reports a unique-constraint violation (SQLSTATE 23505).
func IsUnique(err error) bool {
	var pe *pq.Error
	return errors.As(err, &pe) && pe.Code == "23505"
}

// Insert runs an INSERT and returns the generated id.
func Insert(db *sql.DB, q string, args ...any) (int64, error) {
	var id int64
	err := db.QueryRow(Rebind(q)+" RETURNING id", args...).Scan(&id)
	return id, err
}

// Lock takes a session-level advisory lock so only one process migrates at a time.
func Lock(db *sql.DB) (func(), error) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	conn, err := db.Conn(ctx)
	if err != nil {
		return nil, err
	}
	if _, err := conn.ExecContext(ctx, "SELECT pg_advisory_lock(727274)"); err != nil {
		_ = conn.Close()
		return nil, err
	}
	return func() {
		_, _ = conn.ExecContext(context.Background(), "SELECT pg_advisory_unlock(727274)")
		_ = conn.Close()
	}, nil
}
`;
  return `package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"time"

	"github.com/go-sql-driver/mysql"
)

// DriverName is the database/sql driver registered by the imported package.
const DriverName = "mysql"

// DSN converts mysql://user:pass@host:3306/db?x=y into the driver's DSN (UTC, parseTime so DATETIME scans into time.Time).
func DSN(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "mysql" {
		return "", fmt.Errorf("DATABASE_URL must look like mysql://user:password@host:3306/database")
	}
	cfg := mysql.NewConfig()
	cfg.User = u.User.Username()
	cfg.Passwd, _ = u.User.Password()
	cfg.Net = "tcp"
	cfg.Addr = u.Host
	cfg.DBName = u.Path[1:]
	cfg.ParseTime = true
	cfg.Loc = time.UTC
	cfg.Timeout = 5 * time.Second // dial timeout: an unreachable server fails fast
	cfg.Params = map[string]string{}
	for k, v := range u.Query() {
		cfg.Params[k] = v[0]
	}
	return cfg.FormatDSN(), nil
}

// Rebind: MySQL uses ? placeholders already.
func Rebind(q string) string { return q }

// IsUnique reports a duplicate-key error (1062).
func IsUnique(err error) bool {
	var me *mysql.MySQLError
	return errors.As(err, &me) && me.Number == 1062
}

// Insert runs an INSERT and returns the generated id.
func Insert(db *sql.DB, q string, args ...any) (int64, error) {
	res, err := db.Exec(q, args...)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// Lock takes a named lock so only one process migrates at a time.
func Lock(db *sql.DB) (func(), error) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	conn, err := db.Conn(ctx)
	if err != nil {
		return nil, err
	}
	var got int
	if err := conn.QueryRowContext(ctx, "SELECT GET_LOCK('sierra_migrate', 60)").Scan(&got); err != nil || got != 1 {
		_ = conn.Close()
		return nil, fmt.Errorf("could not take the migration lock: %v", err)
	}
	return func() {
		_, _ = conn.ExecContext(context.Background(), "SELECT RELEASE_LOCK('sierra_migrate')")
		_ = conn.Close()
	}, nil
}
`;
}

const storeGo = () => `package store

import (
	"database/sql"
	"fmt"
	"sort"
	"time"
	"context"
)

// Options are the connection pool settings (see the DB_* variables in .env.example).
type Options struct {
	MaxOpen        int
	MaxIdle        int
	MaxLifetime    time.Duration
	ConnectTimeout time.Duration
}

// Open connects, configures the pool and waits (up to ConnectTimeout) for the database to accept connections.
func Open(rawURL string, o Options) (*sql.DB, error) {
	dsn, err := DSN(rawURL)
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
	deadline := time.Now().Add(o.ConnectTimeout)
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		err = db.PingContext(ctx)
		cancel()
		if err == nil {
			return db, nil
		}
		if time.Now().After(deadline) {
			_ = db.Close()
			return nil, fmt.Errorf("database is not reachable: %w", err)
		}
		time.Sleep(500 * time.Millisecond)
	}
}

// Migration is one append-only schema change. Versions are unique and applied in ascending order, once.
type Migration struct {
	Version    int
	Name       string
	Statements []string
}

// Migrate applies the pending migrations. A database lock serializes concurrent starters, and each migration is
// recorded in schema_migrations together with its statements (PostgreSQL runs a migration in one transaction; MySQL
// commits DDL statements implicitly, so a migration that fails half-way must be fixed by hand).
func Migrate(db *sql.DB, ms []Migration) error {
	unlock, err := Lock(db)
	if err != nil {
		return err
	}
	defer unlock()
	if _, err := db.Exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name VARCHAR(255) NOT NULL, applied_at TIMESTAMP NOT NULL)"); err != nil {
		return err
	}
	rows, err := db.Query("SELECT version FROM schema_migrations")
	if err != nil {
		return err
	}
	done := map[int]bool{}
	for rows.Next() {
		var v int
		if err := rows.Scan(&v); err != nil {
			_ = rows.Close()
			return err
		}
		done[v] = true
	}
	if err := rows.Err(); err != nil {
		return err
	}
	_ = rows.Close()
	sort.Slice(ms, func(i, j int) bool { return ms[i].Version < ms[j].Version })
	for i := 1; i < len(ms); i++ {
		if ms[i].Version == ms[i-1].Version {
			return fmt.Errorf("duplicate migration version %d", ms[i].Version)
		}
	}
	for _, m := range ms {
		if done[m.Version] {
			continue
		}
		tx, err := db.Begin()
		if err != nil {
			return err
		}
		for _, st := range m.Statements {
			if _, err := tx.Exec(st); err != nil {
				_ = tx.Rollback()
				return fmt.Errorf("migration %d (%s): %w", m.Version, m.Name, err)
			}
		}
		if _, err := tx.Exec(Rebind("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)"), m.Version, m.Name, time.Now().UTC()); err != nil {
			_ = tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}
`;

function usersFiles(spec, db, version) {
  const T = TYPES[db], q = (n) => quote(db, n);
  const g = (n) => (db === "postgresql" ? `\\"${n}\\"` : q(n)); // identifier quoting inside a Go interpreted string
  const ddl = `CREATE TABLE ${q("users")} (${q("id")} ${T.id}, ${q("email")} ${db === "mysql" ? "VARCHAR(255)" : "TEXT"} NOT NULL UNIQUE, ${q("name")} ${T.string} NOT NULL, ${q("password_hash")} ${T.string} NOT NULL, ${q("created_at")} ${T.ts} NOT NULL)${T.tail}`;
  return `package auth

import (
	"database/sql"
	"errors"
	"time"

	"__APPMOD__/internal/httpx"
	"__APPMOD__/internal/store"
)

// SQLUsers is the SQL implementation of UserRepository.
type SQLUsers struct{ DB *sql.DB }

func NewSQLUsers(db *sql.DB) *SQLUsers { return &SQLUsers{DB: db} }

// Migration creates the users table.
func Migration() store.Migration {
	return store.Migration{Version: ${version}, Name: "create_users", Statements: []string{${goStr(ddl)}}}
}

const userCols = ${goStr(["id", "email", "name", "password_hash", "created_at"].map(q).join(", "))}

func scanUser(row interface{ Scan(...any) error }) (User, error) {
	var u User
	err := row.Scan(&u.ID, &u.Email, &u.Name, &u.PasswordHash, &u.CreatedAt)
	return u, err
}

func (r *SQLUsers) ByEmail(email string) (User, bool, error) {
	u, err := scanUser(r.DB.QueryRow(store.Rebind("SELECT "+userCols+" FROM ${g("users")} WHERE ${g("email")} = ?"), email))
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, false, nil
	}
	return u, err == nil, err
}

func (r *SQLUsers) ByID(id int64) (User, bool, error) {
	u, err := scanUser(r.DB.QueryRow(store.Rebind("SELECT "+userCols+" FROM ${g("users")} WHERE ${g("id")} = ?"), id))
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, false, nil
	}
	return u, err == nil, err
}

func (r *SQLUsers) Create(u User) (User, error) {
	u.CreatedAt = u.CreatedAt.UTC().Truncate(time.Microsecond)
	id, err := store.Insert(r.DB, "INSERT INTO ${g("users")} (${["email", "name", "password_hash", "created_at"].map(g).join(", ")}) VALUES (?, ?, ?, ?)", u.Email, u.Name, u.PasswordHash, u.CreatedAt)
	if store.IsUnique(err) {
		return User{}, httpx.Conflict("Email already registered")
	}
	if err != nil {
		return User{}, err
	}
	u.ID = id
	return u, nil
}
`;
}

function entityFiles(spec, e, db, version) {
  const T = TYPES[db], q = (n) => quote(db, n);
  const g = (n) => (db === "postgresql" ? `\\"${n}\\"` : q(n)); // identifier quoting inside a Go interpreted string
  const A = spec.needsAuth;
  const table = e.plural;
  const cols = [...e.fields.map((f) => ({ col: snake(f.name), go: cap(f.name), f })), ...(A ? [{ col: "owner_id", go: "OwnerID" }] : []), { col: "created_at", go: "CreatedAt" }];
  const colDefs = [
    `${q("id")} ${T.id}`,
    ...e.fields.map((f) => `${q(snake(f.name))} ${T[f.type]} NOT NULL${f.type === "enum" ? ` CHECK (${q(snake(f.name))} IN (${f.values.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(", ")}))` : ""}`),
    ...(A ? [`${q("owner_id")} BIGINT NOT NULL`] : []),
    `${q("created_at")} ${T.ts} NOT NULL`,
    ...(A ? [`CONSTRAINT ${q("fk_" + table + "_owner")} FOREIGN KEY (${q("owner_id")}) REFERENCES ${q("users")} (${q("id")}) ON DELETE CASCADE`] : []),
  ];
  const ddl = [`CREATE TABLE ${q(table)} (${colDefs.join(", ")})${T.tail}`, ...(A ? [`CREATE INDEX ${q("idx_" + table + "_owner")} ON ${q(table)} (${q("owner_id")}, ${q("id")})`] : [])];
  const allCols = ["id", ...cols.map((c) => c.col)];
  const sel = allCols.map(q).join(", ");
  const scanArgs = ["&v.ID", ...cols.map((c) => `&v.${c.go}`)].join(", ");
  const insCols = cols.map((c) => g(c.col)).join(", ");
  const insVals = cols.map(() => "?").join(", ");
  const insArgs = cols.map((c) => `v.${c.go}`).join(", ");
  const upd = cols.filter((c) => c.col !== "created_at" && c.col !== "owner_id");
  const T_ = e.name;
  return {
    [`internal/${e.lower}/sql_repo.go`]: `package ${e.lower}

import (
	"database/sql"
	"errors"
	"time"

	"__APPMOD__/internal/store"
)

// SQLRepo is the SQL implementation of Repository.
type SQLRepo struct{ DB *sql.DB }

func NewSQLRepo(db *sql.DB) *SQLRepo { return &SQLRepo{DB: db} }

// Migration creates this entity's table${A ? " (with a foreign key to users and an owner index)" : ""}.
func Migration() store.Migration {
	return store.Migration{Version: ${version}, Name: "create_${table}", Statements: []string{
${ddl.map((s) => `		${goStr(s)},`).join("\n")}
	}}
}

const cols = ${goStr(sel)}

func scan(row interface{ Scan(...any) error }) (${T_}, error) {
	var v ${T_}
	err := row.Scan(${scanArgs})
	return v, err
}

func (r *SQLRepo) List(ownerID int64, limit, offset int) ([]${T_}, error) {
	${A
    ? `rows, err := r.DB.Query(store.Rebind("SELECT "+cols+" FROM ${g(table)} WHERE ${g("owner_id")} = ? ORDER BY ${g("id")} DESC LIMIT ? OFFSET ?"), ownerID, limit, offset)`
    : `_ = ownerID
	rows, err := r.DB.Query(store.Rebind("SELECT "+cols+" FROM ${g(table)} ORDER BY ${g("id")} DESC LIMIT ? OFFSET ?"), limit, offset)`}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []${T_}{}
	for rows.Next() {
		v, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func (r *SQLRepo) Get(id, ownerID int64) (${T_}, bool, error) {
	${A
    ? `v, err := scan(r.DB.QueryRow(store.Rebind("SELECT "+cols+" FROM ${g(table)} WHERE ${g("id")} = ? AND ${g("owner_id")} = ?"), id, ownerID))`
    : `_ = ownerID
	v, err := scan(r.DB.QueryRow(store.Rebind("SELECT "+cols+" FROM ${g(table)} WHERE ${g("id")} = ?"), id))`}
	if errors.Is(err, sql.ErrNoRows) {
		return ${T_}{}, false, nil
	}
	return v, err == nil, err
}

func (r *SQLRepo) Create(v ${T_}) (${T_}, error) {
	v.CreatedAt = v.CreatedAt.UTC().Truncate(time.Microsecond)
	id, err := store.Insert(r.DB, "INSERT INTO ${g(table)} (${insCols}) VALUES (${insVals})", ${insArgs})
	if err != nil {
		return ${T_}{}, err
	}
	v.ID = id
	return v, nil
}

func (r *SQLRepo) Save(v ${T_}) (${T_}, error) {
	_, err := r.DB.Exec(store.Rebind("UPDATE ${g(table)} SET ${upd.map((c) => `${g(c.col)} = ?`).join(", ")} WHERE ${g("id")} = ?"), ${[...upd.map((c) => `v.${c.go}`), "v.ID"].join(", ")})
	return v, err
}

func (r *SQLRepo) Delete(id int64) error {
	_, err := r.DB.Exec(store.Rebind("DELETE FROM ${g(table)} WHERE ${g("id")} = ?"), id)
	return err
}
`,
  };
}

function appSqlGo(spec) {
  const A = spec.needsAuth;
  return `package app

import (
	"database/sql"

${A ? '\t"__APPMOD__/internal/auth"\n' : ""}	"__APPMOD__/internal/store"
${spec.entities.map((e) => `\t"__APPMOD__/internal/${e.lower}"`).join("\n")}
)

// SQLStores applies the pending migrations and returns the SQL-backed stores.
func SQLStores(db *sql.DB) (Stores, error) {
	migrations := []store.Migration{
${A ? "\t\tauth.Migration(),\n" : ""}${spec.entities.map((e) => `\t\t${e.lower}.Migration(),`).join("\n")}
	}
	if err := store.Migrate(db, migrations); err != nil {
		return Stores{}, err
	}
	return Stores{
${A ? "\t\tUsers: auth.NewSQLUsers(db),\n" : ""}${spec.entities.map((e) => `\t\t${e.name}: ${e.lower}.NewSQLRepo(db),`).join("\n")}
	}, nil
}
`;
}

function appSqlTestGo(spec, db, sampleFn) {
  const A = spec.needsAuth;
  const e = spec.entities[0];
  const req = e.fields.filter((f) => f.required || f.default === undefined);
  const payload = "{" + req.map((f) => `"${f.name}": ${sampleFn(f, 1)}`).join(", ") + "}";
  const firstStr = e.fields.find((f) => f.type === "string" && f.required);
  const upd = firstStr ? `{"${firstStr.name}": "changed"}` : "{}";
  const tables = [...spec.entities.map((x) => x.plural).reverse(), ...(A ? ["users"] : []), "schema_migrations"];
  const enumF = e.fields.find((f) => f.type === "enum");
  const q = (n) => quote(db, n);
  const g = (n) => (db === "postgresql" ? `\\"${n}\\"` : q(n)); // identifier quoting inside a Go interpreted string
  return `package app

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
${A ? '\t"sync"\n' : ""}	"testing"
	"time"

	"__APPMOD__/internal/config"
	"__APPMOD__/internal/store"
)

// These tests run against a REAL ${dbLabel(db)} server (TEST_DATABASE_URL). They drop and recreate the application's tables.
func testDB(t *testing.T) (*sql.DB, string) {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL is not set: the ${dbLabel(db)} integration tests did NOT run")
	}
	db, err := store.Open(url, store.Options{MaxOpen: 8, MaxIdle: 4, ConnectTimeout: 15 * time.Second})
	if err != nil {
		t.Fatalf("cannot connect: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	for _, tbl := range []string{${tables.map((x) => goStr(x)).join(", ")}} {
		if _, err := db.Exec(${db === "postgresql" ? '"DROP TABLE IF EXISTS \\"" + tbl + "\\" CASCADE"' : '"DROP TABLE IF EXISTS `" + tbl + "`"'}); err != nil {
			t.Fatalf("reset %s: %v", tbl, err)
		}
	}
	return db, url
}

func sqlApp(t *testing.T, db *sql.DB) http.Handler {
	t.Helper()
	st, err := SQLStores(db)
	if err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return NewWith(config.Config{JWTSecret: "test-secret-not-for-production-0123456789", JWTTTL: 3600e9}, st)
}

func call(t *testing.T, h http.Handler, method, path, token, body string) (int, []byte) {
	t.Helper()
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, path, nil)
	} else {
		r = httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w.Code, w.Body.Bytes()
}

func register(t *testing.T, h http.Handler, email string) string {
	t.Helper()
	if code, b := call(t, h, "POST", "/api/auth/register", "", ${"`"}{"email": "${"`"} + email + ${"`"}", "name": "N", "password": "password123"}${"`"}); code != 201 {
		t.Fatalf("register %s: %d %s", email, code, b)
	}
	code, b := call(t, h, "POST", "/api/auth/login", "", ${"`"}{"email": "${"`"} + email + ${"`"}", "password": "password123"}${"`"})
	if code != 200 {
		t.Fatalf("login: %d %s", code, b)
	}
	var out struct {
		Token string ${"`"}json:"access_token"${"`"}
	}
	_ = json.Unmarshal(b, &out)
	return out.Token
}

func TestSQLMigrationsAreIdempotentAndRecorded(t *testing.T) {
	db, _ := testDB(t)
	sqlApp(t, db)
	sqlApp(t, db) // a second start must not re-apply anything
	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM schema_migrations").Scan(&n); err != nil {
		t.Fatal(err)
	}
	if want := ${spec.entities.length + (A ? 1 : 0)}; n != want {
		t.Fatalf("schema_migrations has %d rows, want %d", n, want)
	}
}

func TestSQLCrudOverHTTP(t *testing.T) {
	db, _ := testDB(t)
	h := sqlApp(t, db)
	tok := ${A ? 'register(t, h, "a@example.com")' : '""'}
	code, b := call(t, h, "POST", "/api/${e.plural}", tok, ${"`"}${payload}${"`"})
	if code != 201 {
		t.Fatalf("create: %d %s", code, b)
	}
	var created map[string]any
	_ = json.Unmarshal(b, &created)
	id := int64(created["id"].(float64))
	if id < 1 {
		t.Fatalf("no id: %s", b)
	}
	if code, b := call(t, h, "GET", "/api/${e.plural}", tok, ""); code != 200 || !strings.Contains(string(b), ${"`"}"id":${"`"}) {
		t.Fatalf("list: %d %s", code, b)
	}
	path := "/api/${e.plural}/" + itoa(id)
	if code, _ := call(t, h, "GET", path, tok, ""); code != 200 {
		t.Fatalf("get: %d", code)
	}
	if code, b := call(t, h, "PUT", path, tok, ${"`"}${upd}${"`"}); code != 200 {
		t.Fatalf("update: %d %s", code, b)
	}
${firstStr ? `	if _, b := call(t, h, "GET", path, tok, ""); !strings.Contains(string(b), "changed") {
		t.Fatalf("update was not persisted: %s", b)
	}
` : ""}	if code, _ := call(t, h, "DELETE", path, tok, ""); code != 204 {
		t.Fatalf("delete: %d", code)
	}
	if code, _ := call(t, h, "GET", path, tok, ""); code != 404 {
		t.Fatalf("deleted row still readable: %d", code)
	}
${spec.entities.slice(1).map((x) => {
    const r = x.fields.filter((f) => f.required || f.default === undefined);
    return `	if code, b := call(t, h, "POST", "/api/${x.plural}", tok, ${"`"}{${r.map((f) => `"${f.name}": ${sampleFn(f, 1)}`).join(", ")}}${"`"}); code != 201 {
		t.Fatalf("create ${x.name}: %d %s", code, b)
	}
`;
  }).join("")}}

func itoa(n int64) string { return strings.TrimSpace(strings.Trim(jsonNum(n), "\\"")) }

func jsonNum(n int64) string { b, _ := json.Marshal(n); return string(b) }

func TestSQLDataSurvivesARestart(t *testing.T) {
	db, url := testDB(t)
	h := sqlApp(t, db)
	tok := ${A ? 'register(t, h, "a@example.com")' : '""'}
	if code, b := call(t, h, "POST", "/api/${e.plural}", tok, ${"`"}${payload}${"`"}); code != 201 {
		t.Fatalf("create: %d %s", code, b)
	}
	db2, err := store.Open(url, store.Options{MaxOpen: 4, ConnectTimeout: 10 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	defer db2.Close()
	h2 := sqlApp(t, db2) // a new process: new pool, same database
${A ? '	tok2 := ""\n	if code, b := call(t, h2, "POST", "/api/auth/login", "", `{"email": "a@example.com", "password": "password123"}`); code == 200 {\n		var o struct {\n			Token string `json:"access_token"`\n		}\n		_ = json.Unmarshal(b, &o)\n		tok2 = o.Token\n	} else {\n		t.Fatalf("login after restart: %d", code)\n	}\n' : '	tok2 := ""\n'}	if code, b := call(t, h2, "GET", "/api/${e.plural}", tok2, ""); code != 200 || !strings.Contains(string(b), ${"`"}"id":${"`"}) {
		t.Fatalf("data lost after restart: %d %s", code, b)
	}
}
${A ? `
func TestSQLRowsAreIsolatedPerOwner(t *testing.T) {
	db, _ := testDB(t)
	h := sqlApp(t, db)
	a, b := register(t, h, "a@example.com"), register(t, h, "b@example.com")
	code, body := call(t, h, "POST", "/api/${e.plural}", a, ${"`"}${payload}${"`"})
	if code != 201 {
		t.Fatalf("create: %d %s", code, body)
	}
	var c map[string]any
	_ = json.Unmarshal(body, &c)
	path := "/api/${e.plural}/" + itoa(int64(c["id"].(float64)))
	if code, _ := call(t, h, "GET", path, b, ""); code != 404 {
		t.Fatalf("another user can read the row: %d", code)
	}
	if _, body := call(t, h, "GET", "/api/${e.plural}", b, ""); strings.TrimSpace(string(body)) != "[]" {
		t.Fatalf("another user's list is not empty: %s", body)
	}
	if code, _ := call(t, h, "DELETE", path, b, ""); code != 404 {
		t.Fatalf("another user can delete the row: %d", code)
	}
}

func TestSQLConcurrentDuplicateRegistrationYieldsOneUserAndConflicts(t *testing.T) {
	db, _ := testDB(t)
	h := sqlApp(t, db)
	var mu sync.Mutex
	codes := map[int]int{}
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			code, _ := call(t, h, "POST", "/api/auth/register", "", ${"`"}{"email": "race@example.com", "name": "N", "password": "password123"}${"`"})
			mu.Lock()
			codes[code]++
			mu.Unlock()
		}()
	}
	wg.Wait()
	if codes[201] != 1 || codes[201]+codes[409] != 12 {
		t.Fatalf("want exactly one 201 and the rest 409, got %v", codes)
	}
	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM users").Scan(&n); err != nil || n != 1 {
		t.Fatalf("users rows = %d (%v)", n, err)
	}
}

func TestSQLForeignKeyRejectsAnOrphanRow(t *testing.T) {
	db, _ := testDB(t)
	sqlApp(t, db)
	_, err := db.Exec(store.Rebind("INSERT INTO ${g(e.plural)} (${e.fields.map((f) => g(snake(f.name))).join(", ")}, ${g("owner_id")}, ${g("created_at")}) VALUES (${e.fields.map(() => "?").join(", ")}, ?, ?)"), ${e.fields.map((f) => (f.type === "string" || f.type === "text" ? '"x"' : f.type === "enum" ? goStr(f.values[0]) : f.type === "bool" ? "true" : "1")).join(", ")}, 999999, time.Now().UTC())
	if err == nil {
		t.Fatal("a row pointing at a missing user was accepted")
	}
}
` : ""}${enumF ? `
func TestSQLCheckConstraintRejectsAnInvalidEnum(t *testing.T) {
	db, _ := testDB(t)
	sqlApp(t, db)
	${A ? 'if _, err := db.Exec(store.Rebind("INSERT INTO ' + g("users") + " (" + ["email", "name", "password_hash", "created_at"].map(g).join(", ") + ') VALUES (?, ?, ?, ?)"), "o@example.com", "o", "x", time.Now().UTC()); err != nil {\n\t\tt.Fatal(err)\n\t}\n\t' : ""}_, err := db.Exec(store.Rebind("INSERT INTO ${g(e.plural)} (${e.fields.map((f) => g(snake(f.name))).join(", ")}${A ? `, ${g("owner_id")}` : ""}, ${g("created_at")}) VALUES (${e.fields.map(() => "?").join(", ")}${A ? ", ?" : ""}, ?)"), ${e.fields.map((f) => (f.type === "string" || f.type === "text" ? '"x"' : f.type === "enum" ? (f.name === enumF.name ? '"not-a-valid-value"' : goStr(f.values[0])) : f.type === "bool" ? "true" : "1")).join(", ")}${A ? ", 1" : ""}, time.Now().UTC())
	if err == nil {
		t.Fatal("the database accepted a value outside the enum")
	}
}
` : ""}
func TestSQLErrorsAreReportedNotSwallowed(t *testing.T) {
	db, _ := testDB(t)
	h := sqlApp(t, db)
	tok := ${A ? 'register(t, h, "a@example.com")' : '""'}
	// break ONLY this entity's table: authentication still works, so the failure must come from the repository itself
	if _, err := db.Exec(${db === "postgresql" ? '"DROP TABLE \\"' + e.plural + '\\" CASCADE"' : '"DROP TABLE `' + e.plural + '`"'}); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct{ method, path, body string }{
		{"GET", "/api/${e.plural}", ""},
		{"GET", "/api/${e.plural}/1", ""},
		{"POST", "/api/${e.plural}", ${"`"}${payload}${"`"}},
	} {
		code, body := call(t, h, c.method, c.path, tok, c.body)
		if code != 500 || !strings.Contains(string(body), "internal_error") {
			t.Fatalf("%s %s: want a 500 internal_error envelope, got %d %s", c.method, c.path, code, body)
		}
		if strings.Contains(string(body), "relation") || strings.Contains(string(body), "doesn't exist") {
			t.Fatalf("database error text leaked to the client: %s", body)
		}
	}
}

func TestSQLPoolSettingsAreApplied(t *testing.T) {
	db, _ := testDB(t)
	if got := db.Stats().MaxOpenConnections; got != 8 {
		t.Fatalf("MaxOpenConnections = %d, want 8", got)
	}
}
`;
}

// Replacements applied to the memory-mode output of the Go generator.
function patch(spec, files, sampleFn) {
  const db = spec.database;
  const v = VERSIONS[db];
  files["go.mod"] = `module ${spec.slug}\n\ngo 1.24\n\nrequire ${v.mod} ${v.ver}\n`;
  files["internal/store/store.go"] = storeGo();
  files["internal/store/dialect.go"] = dialectGo(db);
  let n = 1;
  if (spec.needsAuth) files["internal/auth/sql_users.go"] = usersFiles(spec, db, n++);
  for (const e of spec.entities) Object.assign(files, entityFiles(spec, e, db, n++));
  files["internal/app/sql.go"] = appSqlGo(spec);
  files["internal/app/sql_test.go"] = appSqlTestGo(spec, db, sampleFn);

  const must = (name, a, b) => { if (!files[name].includes(a)) throw new Error(`go sql patch: anchor not found in ${name}: ${a.slice(0, 60)}`); files[name] = files[name].replace(a, b); };
  must("internal/config/config.go", "\tJWTTTL    time.Duration\n}", "\tJWTTTL    time.Duration\n\t// Database. DATABASE_DRIVER=memory runs without a database (data is lost on restart).\n\tDatabaseDriver string\n\tDatabaseURL    string\n\tDBMaxOpen      int\n\tDBMaxIdle      int\n\tDBMaxLifetime  time.Duration\n}");
  must("internal/config/config.go", "\tc.JWTSecret = os.Getenv(\"JWT_SECRET\")", `	c.DatabaseDriver = getenv("DATABASE_DRIVER", ${goStr(db === "postgresql" ? "postgres" : "mysql")})
	c.DatabaseURL = os.Getenv("DATABASE_URL")
	c.DBMaxOpen = getint("DB_MAX_OPEN_CONNS", 10)
	c.DBMaxIdle = getint("DB_MAX_IDLE_CONNS", 5)
	c.DBMaxLifetime = time.Duration(getint("DB_CONN_MAX_LIFETIME_SECONDS", 300)) * time.Second
	if c.DatabaseDriver != "memory" && c.DatabaseURL == "" {
		return c, fmt.Errorf("DATABASE_URL must be set (or DATABASE_DRIVER=memory for a non-persistent store)")
	}
	c.JWTSecret = os.Getenv("JWT_SECRET")`);
  must("internal/config/config.go", "func getenv(k, def string) string {", `func getint(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			return n
		}
	}
	return def
}

func getenv(k, def string) string {`);
  must("internal/config/config.go", '\t"os"\n', '\t"os"\n\t"strconv"\n');
  must("cmd/server/main.go", "\tsrv := &http.Server{", `	var handler http.Handler
	if cfg.DatabaseDriver == "memory" {
		slog.Warn("DATABASE_DRIVER=memory: data is NOT persisted")
		handler = app.New(cfg)
	} else {
		db, err := store.Open(cfg.DatabaseURL, store.Options{MaxOpen: cfg.DBMaxOpen, MaxIdle: cfg.DBMaxIdle, MaxLifetime: cfg.DBMaxLifetime, ConnectTimeout: 30 * time.Second})
		if err != nil {
			slog.Error("database", "err", err)
			os.Exit(1)
		}
		defer db.Close()
		stores, err := app.SQLStores(db)
		if err != nil {
			slog.Error("migrations", "err", err)
			os.Exit(1)
		}
		handler = app.NewWith(cfg, stores)
	}

	srv := &http.Server{`);
  must("cmd/server/main.go", "Handler:           app.New(cfg),", "Handler:           handler,");
  must("cmd/server/main.go", '\t"__APPMOD__/internal/config"\n', '\t"__APPMOD__/internal/config"\n\t"__APPMOD__/internal/store"\n');
  files[".env.example"] += `DATABASE_DRIVER=${db === "postgresql" ? "postgres" : "mysql"}\nDATABASE_URL=${testUrl(db)}\nDB_MAX_OPEN_CONNS=10\nDB_MAX_IDLE_CONNS=5\nDB_CONN_MAX_LIFETIME_SECONDS=300\n`;
  must("Dockerfile", "COPY . .\n", "COPY . .\n# go.sum is not generated by Sierra: it is resolved here (run `go mod tidy` once locally and commit go.sum to pin it)\nRUN go mod tidy\n");
  must("README.md", "- **Data is stored in memory** and is lost on restart. The `Repository` interface is the seam for a real database; no SQL implementation is generated yet.", `- **Data is stored in ${dbLabel(db)}** through database/sql (\`${v.mod}\`). Set \`DATABASE_URL\` (see .env.example). Migrations (\`internal/store\`) run on startup under a database lock and are recorded in \`schema_migrations\`; they are append-only, so a changed entity needs a new migration. \`DATABASE_DRIVER=memory\` runs without a database (data lost on restart).
- Run \`go mod tidy\` once to create go.sum (Sierra does not generate it), then commit it.
- The SQL integration tests (\`internal/app/sql_test.go\`) need a real ${dbLabel(db)}: set \`TEST_DATABASE_URL\` (e.g. ${testUrl(db)}). **They drop the application's tables.** Without it they are skipped.
- Not included: request-context cancellation of queries, read replicas, schema diffing.`);
  return files;
}

module.exports = { patch, isSql, dbLabel, testUrl, VERSIONS };
