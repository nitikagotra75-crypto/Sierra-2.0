/**
 * Standard-library Go HTTP generator (Go 1.24+, pattern routing, log/slog).
 * Layers: handler -> service -> repository (interface). Only an in-memory
 * repository is generated for now; see `notes` below.
 *
 * Templates use "~" in place of a backtick (Go struct tags) because the
 * templates themselves are JS template literals.
 */
const goSql = require("./goSql");
const bt = (s) => s.replace(/~/g, "`");
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const GO = { string: "string", text: "string", int: "int64", float: "float64", bool: "bool", enum: "string" };
const goName = (n) => cap(n);
const sample = (f, n = 1) => {
  switch (f.type) {
    case "string": case "text": return JSON.stringify(`${f.name} ${n}`);
    case "int": return String(n);
    case "float": return `${n}.5`;
    case "bool": return "true";
    case "enum": return JSON.stringify(f.values[0]);
  }
};
const jsonSample = (f, n = 1) => sample(f, n); // JSON literal form is identical for these types

const goMod = (spec) => `module ${spec.slug}

go 1.24
`;

const configGo = (spec) => bt(`package config

import (
	"fmt"
	"os"
	"time"
)

type Config struct {
	Port      string
	LogLevel  string
	JWTSecret string
	JWTTTL    time.Duration
}

func Load() (Config, error) {
	c := Config{
		Port:     getenv("PORT", "8080"),
		LogLevel: getenv("LOG_LEVEL", "info"),
		JWTTTL:   time.Hour,
	}
	c.JWTSecret = os.Getenv("JWT_SECRET")
	${spec.needsAuth ? `if c.JWTSecret == "" {
		return c, fmt.Errorf("JWT_SECRET must be set")
	}` : "_ = fmt.Sprint"}
	return c, nil
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
`);

const httpxGo = () => bt(`package httpx

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"time"
)

type AppError struct {
	Status  int
	Code    string
	Message string
	Details any
}

func (e *AppError) Error() string { return e.Message }

func NotFound(what string) *AppError {
	return &AppError{Status: 404, Code: "not_found", Message: what + " not found"}
}
func Conflict(msg string) *AppError     { return &AppError{Status: 409, Code: "conflict", Message: msg} }
func Unauthorized(msg string) *AppError { return &AppError{Status: 401, Code: "unauthorized", Message: msg} }
func Validation(details any) *AppError {
	return &AppError{Status: 422, Code: "validation_error", Message: "Request validation failed", Details: details}
}

func JSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if v != nil {
		_ = json.NewEncoder(w).Encode(v)
	}
}

func WriteError(w http.ResponseWriter, err error) {
	if ae, ok := err.(*AppError); ok {
		JSON(w, ae.Status, map[string]any{"error": map[string]any{"code": ae.Code, "message": ae.Message, "details": ae.Details}})
		return
	}
	slog.Error("unhandled error", "err", err)
	JSON(w, 500, map[string]any{"error": map[string]any{"code": "internal_error", "message": "Internal server error", "details": nil}})
}

// Decode reads a JSON body (max 1 MiB, unknown fields rejected).
func Decode(r *http.Request, dst any) error {
	r.Body = http.MaxBytesReader(nil, r.Body, 1<<20)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return Validation([]map[string]string{{"msg": "invalid JSON body: " + err.Error()}})
	}
	return nil
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (s *statusWriter) WriteHeader(c int) { s.status = c; s.ResponseWriter.WriteHeader(c) }

// Middleware chain: panic recovery + structured request logging.
func Wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: 200}
		defer func() {
			if rec := recover(); rec != nil {
				slog.Error("panic", "panic", rec)
				WriteError(sw, &AppError{Status: 500, Code: "internal_error", Message: "Internal server error"})
			}
			slog.Info("request", "method", r.Method, "path", r.URL.Path, "status", sw.status, "ms", time.Since(start).Milliseconds())
		}()
		next.ServeHTTP(sw, r)
	})
}
`);

const authGo = () => ({
  "internal/auth/auth.go": bt(`package auth

import (
	"context"
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"APPMOD/internal/httpx"
)

// Passwords: PBKDF2-HMAC-SHA256 (stdlib, Go 1.24+), random 16-byte salt.
// Tokens: HS256 JWT implemented with crypto/hmac so the project has zero third-party dependencies.
var passwordIterations = 600_000

func hashPassword(pw string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key, err := pbkdf2.Key(sha256.New, pw, salt, passwordIterations, 32)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("pbkdf2-sha256$%d$%s$%s", passwordIterations, base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key)), nil
}

func verifyPassword(pw, stored string) bool {
	parts := strings.Split(stored, "$")
	if len(parts) != 4 || parts[0] != "pbkdf2-sha256" {
		return false
	}
	iter, err := strconv.Atoi(parts[1])
	if err != nil || iter < 1 {
		return false
	}
	salt, err1 := base64.RawStdEncoding.DecodeString(parts[2])
	want, err2 := base64.RawStdEncoding.DecodeString(parts[3])
	if err1 != nil || err2 != nil {
		return false
	}
	got, err := pbkdf2.Key(sha256.New, pw, salt, iter, len(want))
	return err == nil && subtle.ConstantTimeCompare(got, want) == 1
}

var b64 = base64.RawURLEncoding

func signToken(secret []byte, sub string, ttl time.Duration) (string, error) {
	hdr, _ := json.Marshal(map[string]string{"alg": "HS256", "typ": "JWT"})
	claims, _ := json.Marshal(map[string]any{"sub": sub, "exp": time.Now().Add(ttl).Unix()})
	unsigned := b64.EncodeToString(hdr) + "." + b64.EncodeToString(claims)
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(unsigned))
	return unsigned + "." + b64.EncodeToString(mac.Sum(nil)), nil
}

func parseToken(secret []byte, tok string) (string, bool) {
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		return "", false
	}
	hdrRaw, err := b64.DecodeString(parts[0])
	if err != nil {
		return "", false
	}
	var hdr struct{ Alg string ~json:"alg"~ }
	if json.Unmarshal(hdrRaw, &hdr) != nil || hdr.Alg != "HS256" {
		return "", false // rejects alg=none and algorithm confusion
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(parts[0] + "." + parts[1]))
	sig, err := b64.DecodeString(parts[2])
	if err != nil || !hmac.Equal(sig, mac.Sum(nil)) {
		return "", false
	}
	claimsRaw, err := b64.DecodeString(parts[1])
	if err != nil {
		return "", false
	}
	var c struct {
		Sub string ~json:"sub"~
		Exp int64  ~json:"exp"~
	}
	if json.Unmarshal(claimsRaw, &c) != nil || c.Exp < time.Now().Unix() {
		return "", false
	}
	return c.Sub, true
}

type User struct {
	ID           int64     ~json:"id"~
	Email        string    ~json:"email"~
	Name         string    ~json:"name"~
	PasswordHash string    ~json:"-"~
	CreatedAt    time.Time ~json:"created_at"~
}

type UserRepository interface {
	ByEmail(email string) (User, bool, error)
	ByID(id int64) (User, bool, error)
	Create(u User) (User, error)
}

type MemoryUsers struct {
	mu   sync.RWMutex
	next int64
	data map[int64]User
}

func NewMemoryUsers() *MemoryUsers { return &MemoryUsers{next: 1, data: map[int64]User{}} }

func (m *MemoryUsers) ByEmail(email string) (User, bool, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, u := range m.data {
		if u.Email == email {
			return u, true, nil
		}
	}
	return User{}, false, nil
}

func (m *MemoryUsers) ByID(id int64) (User, bool, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	u, ok := m.data[id]
	return u, ok, nil
}

func (m *MemoryUsers) Create(u User) (User, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	u.ID = m.next
	m.next++
	m.data[u.ID] = u
	return u, nil
}

type Service struct {
	Repo   UserRepository
	Secret []byte
	TTL    time.Duration
}

type RegisterInput struct {
	Email    string ~json:"email"~
	Name     string ~json:"name"~
	Password string ~json:"password"~
}

type LoginInput struct {
	Email    string ~json:"email"~
	Password string ~json:"password"~
}

func (s *Service) Register(in RegisterInput) (User, error) {
	email := strings.ToLower(strings.TrimSpace(in.Email))
	var problems []map[string]string
	if !strings.Contains(email, "@") || strings.HasSuffix(email, "@") || strings.HasPrefix(email, "@") {
		problems = append(problems, map[string]string{"loc": "email", "msg": "must be a valid email"})
	}
	if len(in.Password) < 8 || len(in.Password) > 72 {
		problems = append(problems, map[string]string{"loc": "password", "msg": "must be 8-72 characters"})
	}
	if len(problems) > 0 {
		return User{}, httpx.Validation(problems)
	}
	if _, exists, err := s.Repo.ByEmail(email); err != nil {
		return User{}, err
	} else if exists {
		return User{}, httpx.Conflict("Email already registered")
	}
	hash, err := hashPassword(in.Password)
	if err != nil {
		return User{}, err
	}
	return s.Repo.Create(User{Email: email, Name: in.Name, PasswordHash: hash, CreatedAt: time.Now().UTC()})
}

func (s *Service) Login(in LoginInput) (string, error) {
	u, ok, err := s.Repo.ByEmail(strings.ToLower(strings.TrimSpace(in.Email)))
	if err != nil {
		return "", err
	}
	if !ok || !verifyPassword(in.Password, u.PasswordHash) {
		return "", httpx.Unauthorized("Invalid email or password")
	}
	return signToken(s.Secret, strconv.FormatInt(u.ID, 10), s.TTL)
}

type ctxKey struct{}

// Middleware validates the bearer token and stores the user id in the request context.
func (s *Service) Middleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		h := r.Header.Get("Authorization")
		raw, found := strings.CutPrefix(h, "Bearer ")
		if !found || raw == "" {
			httpx.WriteError(w, httpx.Unauthorized("Invalid or missing credentials"))
			return
		}
		sub, valid := parseToken(s.Secret, raw)
		if !valid {
			httpx.WriteError(w, httpx.Unauthorized("Invalid or missing credentials"))
			return
		}
		id, _ := strconv.ParseInt(sub, 10, 64)
		if _, ok, err := s.Repo.ByID(id); err != nil {
			httpx.WriteError(w, err)
			return
		} else if !ok {
			httpx.WriteError(w, httpx.Unauthorized("Invalid or missing credentials"))
			return
		}
		next(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, id)))
	}
}

func UserID(ctx context.Context) int64 {
	id, _ := ctx.Value(ctxKey{}).(int64)
	return id
}

func (s *Service) Register_(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/auth/register", func(w http.ResponseWriter, r *http.Request) {
		var in RegisterInput
		if err := httpx.Decode(r, &in); err != nil {
			httpx.WriteError(w, err)
			return
		}
		u, err := s.Register(in)
		if err != nil {
			httpx.WriteError(w, err)
			return
		}
		httpx.JSON(w, 201, u)
	})
	mux.HandleFunc("POST /api/auth/login", func(w http.ResponseWriter, r *http.Request) {
		var in LoginInput
		if err := httpx.Decode(r, &in); err != nil {
			httpx.WriteError(w, err)
			return
		}
		tok, err := s.Login(in)
		if err != nil {
			httpx.WriteError(w, err)
			return
		}
		httpx.JSON(w, 200, map[string]string{"access_token": tok, "token_type": "bearer"})
	})
	mux.HandleFunc("GET /api/auth/me", s.Middleware(func(w http.ResponseWriter, r *http.Request) {
		u, _, err := s.Repo.ByID(UserID(r.Context()))
		if err != nil {
			httpx.WriteError(w, err)
			return
		}
		httpx.JSON(w, 200, u)
	}))
}
`).replace(/APPMOD/g, "__APPMOD__").replace("m.data[u.ID] = u\n\tm.data[u.ID] = u", "m.data[u.ID] = u"),
});

function entityGo(spec, e) {
  const A = spec.needsAuth;
  const pkg = e.lower;
  const T = e.name;
  const structFields = e.fields.map((f) => `\t${goName(f.name)} ${GO[f.type]} ~json:"${f.name}"~`).join("\n");
  const updFields = e.fields.map((f) => `\t${goName(f.name)} *${GO[f.type]} ~json:"${f.name}"~`).join("\n");
  // bool/int/float fields with a non-zero default are pointers on CreateInput so "not sent" can be told from an explicit
  // zero value (e.g. done=false). Strings/enums keep the plain-value form where "" means "not sent".
  const nonZero = (f) => f.default !== undefined && f.default !== null && f.default !== "" && f.default !== 0 && f.default !== false && ["bool", "int", "float"].includes(f.type);
  // a REQUIRED bool/int/float with no default is a pointer too, otherwise "missing" cannot be told from 0/false and an empty body would pass validation
  const reqNum = (f) => f.required && (f.default === undefined || f.default === null) && ["bool", "int", "float"].includes(f.type);
  const isPtr = (f) => nonZero(f) || reqNum(f);
  const createFields = e.fields.map((f) => `\t${goName(f.name)} ${isPtr(f) ? "*" : ""}${GO[f.type]} ~json:"${f.name}"~`).join("\n");
  const validate = e.fields.map((f) => {
    const N = goName(f.name);
    const parts = [];
    if (f.type === "string" && f.required) parts.push(`\tif strings.TrimSpace(v.${N}) == "" {\n\t\t*p = append(*p, map[string]string{"loc": "${f.name}", "msg": "must not be blank"})\n\t}`);
    if (reqNum(f)) parts.push(`\tif v.${N} == nil {\n\t\t*p = append(*p, map[string]string{"loc": "${f.name}", "msg": "is required"})\n\t}`);
    if (f.type === "enum") parts.push(`\tif v.${N} != "" && !slices.Contains([]string{${f.values.map((x) => JSON.stringify(x)).join(", ")}}, v.${N}) {\n\t\t*p = append(*p, map[string]string{"loc": "${f.name}", "msg": "must be one of ${f.values.join(", ")}"})\n\t}`);
    return parts.join("\n");
  }).filter(Boolean).join("\n");
  const defaults = e.fields.filter((f) => f.default !== undefined && f.default !== "" && (["string", "text", "enum"].includes(f.type) || nonZero(f))).map((f) => {
    const N = goName(f.name);
    if (nonZero(f)) return `\tif in.${N} == nil {\n\t\td := ${GO[f.type]}(${JSON.stringify(f.default)})\n\t\tin.${N} = &d\n\t}`;
    return `\tif in.${N} == "" {\n\t\tin.${N} = ${JSON.stringify(f.default)}\n\t}`;
  }).join("\n");
  const copyIn = e.fields.map((f) => `\t\t${goName(f.name)}: ${isPtr(f) ? "*" : ""}in.${goName(f.name)},`).join("\n");
  const applyUpd = e.fields.map((f) => `\tif in.${goName(f.name)} != nil {\n\t\tcur.${goName(f.name)} = *in.${goName(f.name)}\n\t}`).join("\n");
  const updValidate = e.fields.filter((f) => f.type === "string" && f.required || f.type === "enum").map((f) => {
    const N = goName(f.name);
    if (f.type === "enum") return `\tif in.${N} != nil && !slices.Contains([]string{${f.values.map((x) => JSON.stringify(x)).join(", ")}}, *in.${N}) {\n\t\tproblems = append(problems, map[string]string{"loc": "${f.name}", "msg": "must be one of ${f.values.join(", ")}"})\n\t}`;
    return `\tif in.${N} != nil && strings.TrimSpace(*in.${N}) == "" {\n\t\tproblems = append(problems, map[string]string{"loc": "${f.name}", "msg": "must not be blank"})\n\t}`;
  }).join("\n");
  const o = A ? "ownerID" : "_";
  const files = {};

  files[`internal/${pkg}/${pkg}.go`] = bt(`package ${pkg}

import (
	"slices"
	"strings"
	"sync"
	"time"

	"__APPMOD__/internal/httpx"
)

type ${T} struct {
	ID        int64     ~json:"id"~
${structFields}
${A ? "\tOwnerID   int64     ~json:\"owner_id\"~\n" : ""}	CreatedAt time.Time ~json:"created_at"~
}

type CreateInput struct {
${createFields}
}

type UpdateInput struct {
${updFields}
}

// Repository is the persistence boundary; swap the implementation without touching the service.
type Repository interface {
	List(ownerID int64, limit, offset int) ([]${T}, error)
	Get(id, ownerID int64) (${T}, bool, error)
	Create(v ${T}) (${T}, error)
	Save(v ${T}) (${T}, error)
	Delete(id int64) error
}

type MemoryRepo struct {
	mu   sync.RWMutex
	next int64
	data map[int64]${T}
}

func NewMemoryRepo() *MemoryRepo { return &MemoryRepo{next: 1, data: map[int64]${T}{}} }

func (m *MemoryRepo) List(ownerID int64, limit, offset int) ([]${T}, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]${T}, 0, len(m.data))
	for _, v := range m.data {
		${A ? "if v.OwnerID != ownerID {\n\t\t\tcontinue\n\t\t}" : "_ = ownerID"}
		out = append(out, v)
	}
	slices.SortFunc(out, func(a, b ${T}) int { return int(b.ID - a.ID) })
	if offset > len(out) {
		offset = len(out)
	}
	out = out[offset:]
	if limit < len(out) {
		out = out[:limit]
	}
	return out, nil
}

func (m *MemoryRepo) Get(id, ownerID int64) (${T}, bool, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	v, ok := m.data[id]
	${A ? "if ok && v.OwnerID != ownerID {\n\t\treturn ${T}{}, false, nil\n\t}" : "_ = ownerID"}
	return v, ok, nil
}

func (m *MemoryRepo) Create(v ${T}) (${T}, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	v.ID = m.next
	m.next++
	m.data[v.ID] = v
	return v, nil
}

func (m *MemoryRepo) Save(v ${T}) (${T}, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.data[v.ID] = v
	return v, nil
}

func (m *MemoryRepo) Delete(id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.data, id)
	return nil
}

type Service struct{ Repo Repository }

func (s *Service) List(${o} int64, limit, offset int) ([]${T}, error) {
	return s.Repo.List(${A ? "ownerID" : "0"}, limit, offset)
}

func (s *Service) Get(id int64, ${o} int64) (${T}, error) {
	v, ok, err := s.Repo.Get(id, ${A ? "ownerID" : "0"})
	if err != nil {
		return ${T}{}, err
	}
	if !ok {
		return ${T}{}, httpx.NotFound("${T}")
	}
	return v, nil
}

func (s *Service) Create(in CreateInput, ${o} int64) (${T}, error) {
	var problems []map[string]string
	validateCreate(in, &problems)
	if len(problems) > 0 {
		return ${T}{}, httpx.Validation(problems)
	}
${defaults}
	return s.Repo.Create(${T}{
${copyIn}
${A ? "\t\tOwnerID:   ownerID,\n" : ""}		CreatedAt: time.Now().UTC(),
	})
}

func (s *Service) Update(id int64, in UpdateInput, ${o} int64) (${T}, error) {
	cur, err := s.Get(id, ${A ? "ownerID" : "0"})
	if err != nil {
		return ${T}{}, err
	}
	var problems []map[string]string
${updValidate}
	if len(problems) > 0 {
		return ${T}{}, httpx.Validation(problems)
	}
${applyUpd}
	return s.Repo.Save(cur)
}

func (s *Service) Delete(id int64, ${o} int64) error {
	if _, err := s.Get(id, ${A ? "ownerID" : "0"}); err != nil {
		return err
	}
	return s.Repo.Delete(id)
}

func validateCreate(v CreateInput, p *[]map[string]string) {
${validate || "\t_ = v\n\t_ = p"}
}

var _ = strings.TrimSpace
`).replace(/\$\{T\}/g, T);

  const uid = A ? "auth.UserID(r.Context())" : "0";
  files[`internal/${pkg}/handler.go`] = bt(`package ${pkg}

import (
	"net/http"
	"strconv"

	"__APPMOD__/internal/httpx"
${A ? "\t\"__APPMOD__/internal/auth\"\n" : ""})

type Handler struct{ Svc *Service }

func pathID(r *http.Request) (int64, error) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		return 0, httpx.Validation([]map[string]string{{"loc": "id", "msg": "must be an integer"}})
	}
	return id, nil
}

func atoiDefault(s string, def, min, max int) int {
	n, err := strconv.Atoi(s)
	if err != nil || n < min {
		return def
	}
	if n > max {
		return max
	}
	return n
}

${A ? "// Routes registers the endpoints; every route requires a valid bearer token.\nfunc (h *Handler) Routes(mux *http.ServeMux, authSvc *auth.Service) {\n\twrap := authSvc.Middleware" : "// Routes registers the endpoints.\nfunc (h *Handler) Routes(mux *http.ServeMux) {\n\twrap := func(f http.HandlerFunc) http.HandlerFunc { return f }"}
	mux.HandleFunc("GET /api/${e.plural}", wrap(func(w http.ResponseWriter, r *http.Request) {
		limit := atoiDefault(r.URL.Query().Get("limit"), 50, 1, 200)
		offset := atoiDefault(r.URL.Query().Get("offset"), 0, 0, 1<<30)
		items, err := h.Svc.List(${uid}, limit, offset)
		if err != nil {
			httpx.WriteError(w, err)
			return
		}
		httpx.JSON(w, 200, items)
	}))
	mux.HandleFunc("POST /api/${e.plural}", wrap(func(w http.ResponseWriter, r *http.Request) {
		var in CreateInput
		if err := httpx.Decode(r, &in); err != nil {
			httpx.WriteError(w, err)
			return
		}
		v, err := h.Svc.Create(in, ${uid})
		if err != nil {
			httpx.WriteError(w, err)
			return
		}
		httpx.JSON(w, 201, v)
	}))
	mux.HandleFunc("GET /api/${e.plural}/{id}", wrap(func(w http.ResponseWriter, r *http.Request) {
		id, err := pathID(r)
		if err != nil {
			httpx.WriteError(w, err)
			return
		}
		v, err := h.Svc.Get(id, ${uid})
		if err != nil {
			httpx.WriteError(w, err)
			return
		}
		httpx.JSON(w, 200, v)
	}))
	mux.HandleFunc("PUT /api/${e.plural}/{id}", wrap(func(w http.ResponseWriter, r *http.Request) {
		id, err := pathID(r)
		if err != nil {
			httpx.WriteError(w, err)
			return
		}
		var in UpdateInput
		if err := httpx.Decode(r, &in); err != nil {
			httpx.WriteError(w, err)
			return
		}
		v, err := h.Svc.Update(id, in, ${uid})
		if err != nil {
			httpx.WriteError(w, err)
			return
		}
		httpx.JSON(w, 200, v)
	}))
	mux.HandleFunc("DELETE /api/${e.plural}/{id}", wrap(func(w http.ResponseWriter, r *http.Request) {
		id, err := pathID(r)
		if err != nil {
			httpx.WriteError(w, err)
			return
		}
		if err := h.Svc.Delete(id, ${uid}); err != nil {
			httpx.WriteError(w, err)
			return
		}
		w.WriteHeader(204)
	}))
}
`);
  return files;
}

function appGo(spec) {
  const A = spec.needsAuth;
  return bt(`package app

import (
	_ "embed"
	"net/http"
${A ? "\t\"time\"\n" : ""}
	"__APPMOD__/internal/config"
	"__APPMOD__/internal/httpx"
	"__APPMOD__/internal/metrics"
${A ? "\t\"__APPMOD__/internal/auth\"\n" : ""}${spec.entities.map((e) => `\t"__APPMOD__/internal/${e.lower}"`).join("\n")}
)

// openAPI is generated by Sierra from the project spec and served verbatim; edit it together with the routes.
//
//go:embed openapi.json
var openAPI []byte

// Stores groups the persistence the application needs.
type Stores struct {
${A ? "\tUsers auth.UserRepository\n" : ""}${spec.entities.map((e) => `\t${e.name} ${e.lower}.Repository`).join("\n")}
}

// MemoryStores returns non-persistent in-memory stores.
func MemoryStores() Stores {
	return Stores{
${A ? "\t\tUsers: auth.NewMemoryUsers(),\n" : ""}${spec.entities.map((e) => `\t\t${e.name}: ${e.lower}.NewMemoryRepo(),`).join("\n")}
	}
}

// New builds the application on in-memory stores.
func New(cfg config.Config) http.Handler { return NewWith(cfg, MemoryStores()) }

// NewWith wires repositories -> services -> handlers. It is the only place that knows concrete types.
func NewWith(cfg config.Config, st Stores) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		httpx.JSON(w, 200, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /openapi.json", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(openAPI)
	})
	reg := metrics.New()
	mux.Handle("GET /metrics", reg.Handler())
${A ? `	authSvc := &auth.Service{Repo: st.Users, Secret: []byte(cfg.JWTSecret), TTL: cfg.JWTTTL}
	authSvc.Register_(mux)
	_ = time.Second
` : "\t_ = cfg\n"}${spec.entities.map((e) => `	(&${e.lower}.Handler{Svc: &${e.lower}.Service{Repo: st.${e.name}}}).Routes(mux${A ? ", authSvc" : ""})`).join("\n")}
	return reg.Middleware(httpx.Wrap(mux))
}
`);
}

const mainGo = () => bt(`package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"__APPMOD__/internal/app"
	"__APPMOD__/internal/config"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		slog.Error("invalid configuration", "err", err)
		os.Exit(1)
	}
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           app.New(cfg),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      15 * time.Second,
	}

	go func() {
		slog.Info("listening", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("server error", "err", err)
			os.Exit(1)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	slog.Info("shutting down")
	_ = srv.Shutdown(ctx)
}
`);

function testsGo(spec) {
  const A = spec.needsAuth;
  const body = bt(`package app_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"__APPMOD__/internal/app"
	"__APPMOD__/internal/config"
)

type client struct {
	t     *testing.T
	h     http.Handler
	token string
}

func newClient(t *testing.T) *client {
	return &client{t: t, h: app.New(config.Config{JWTSecret: "test-secret-not-for-production-0123456789", JWTTTL: 3600e9})}
}

func (c *client) do(method, path string, body any) (int, map[string]any, []byte) {
	var buf bytes.Buffer
	if body != nil {
		_ = json.NewEncoder(&buf).Encode(body)
	}
	req := httptest.NewRequest(method, path, &buf)
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	rec := httptest.NewRecorder()
	c.h.ServeHTTP(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out, rec.Body.Bytes()
}

func TestHealth(t *testing.T) {
	c := newClient(t)
	if code, out, _ := c.do("GET", "/health", nil); code != 200 || out["status"] != "ok" {
		t.Fatalf("health: %d %v", code, out)
	}
}
${A ? `
func (c *client) login(email string) {
	c.do("POST", "/api/auth/register", map[string]any{"email": email, "password": "password123"})
	code, out, _ := c.do("POST", "/api/auth/login", map[string]any{"email": email, "password": "password123"})
	if code != 200 {
		c.t.Fatalf("login failed: %d", code)
	}
	c.token = out["access_token"].(string)
}

func TestAuthFlow(t *testing.T) {
	c := newClient(t)
	if code, _, raw := c.do("POST", "/api/auth/register", map[string]any{"email": "a@example.com", "password": "password123"}); code != 201 || bytes.Contains(raw, []byte("password")) {
		t.Fatalf("register: %d %s", code, raw)
	}
	if code, _, _ := c.do("POST", "/api/auth/register", map[string]any{"email": "a@example.com", "password": "password123"}); code != 409 {
		t.Fatalf("duplicate should be 409, got %d", code)
	}
	if code, _, _ := c.do("POST", "/api/auth/register", map[string]any{"email": "b@example.com", "password": "short"}); code != 422 {
		t.Fatalf("weak password should be 422, got %d", code)
	}
	if code, _, _ := c.do("POST", "/api/auth/login", map[string]any{"email": "a@example.com", "password": "wrong-password"}); code != 401 {
		t.Fatalf("bad login should be 401, got %d", code)
	}
	c.login("a@example.com")
	if code, out, _ := c.do("GET", "/api/auth/me", nil); code != 200 || out["email"] != "a@example.com" {
		t.Fatalf("me: %d %v", code, out)
	}
	c.token = "garbage"
	if code, _, _ := c.do("GET", "/api/auth/me", nil); code != 401 {
		t.Fatalf("invalid token should be 401, got %d", code)
	}
}
` : ""}`);
  const ents = spec.entities.map((e) => {
    const req = e.fields.filter((f) => f.required || f.default === undefined);
    const payload = (n) => "map[string]any{" + req.map((f) => `"${f.name}": ${jsonSample(f, n)}`).join(", ") + "}";
    const first = e.fields.find((f) => f.required && f.type === "string") || e.fields[0];
    const upd = first.type === "string" ? `map[string]any{"${first.name}": "changed"}` : `map[string]any{"${first.name}": ${sample(first, 9)}}`;
    const chk = first.type === "string" ? `"changed"` : null;
    return bt(`
func Test${cap(e.name)}CRUD(t *testing.T) {
	c := newClient(t)
${A ? '\tc.login("user@example.com")\n' : ""}	code, out, raw := c.do("POST", "/api/${e.plural}", ${payload(1)})
	if code != 201 {
		t.Fatalf("create: %d %s", code, raw)
	}
	id := int(out["id"].(float64))
	path := "/api/${e.plural}/" + itoa(id)
	if code, _, _ := c.do("GET", path, nil); code != 200 {
		t.Fatalf("get: %d", code)
	}
	code, out, raw = c.do("PUT", path, ${upd})
	if code != 200 {
		t.Fatalf("update: %d %s", code, raw)
	}
	${chk ? `if out["${first.name}"] != ${chk} {\n\t\tt.Fatalf("update not applied: %v", out)\n\t}` : "_ = out"}
	if code, _, _ := c.do("DELETE", path, nil); code != 204 {
		t.Fatalf("delete: %d", code)
	}
	if code, _, _ := c.do("GET", path, nil); code != 404 {
		t.Fatalf("get after delete should be 404, got %d", code)
	}
}

func Test${cap(e.name)}Validation(t *testing.T) {
	c := newClient(t)
${A ? '\tc.login("user@example.com")\n' : ""}	code, out, _ := c.do("POST", "/api/${e.plural}", map[string]any{})
	if code != 422 {
		t.Fatalf("empty create should be 422, got %d", code)
	}
	if out["error"].(map[string]any)["code"] != "validation_error" {
		t.Fatalf("unexpected error shape: %v", out)
	}
}
${A ? `
func Test${cap(e.name)}RequiresAuthAndIsolated(t *testing.T) {
	c := newClient(t)
	if code, _, _ := c.do("GET", "/api/${e.plural}", nil); code != 401 {
		t.Fatalf("unauthenticated should be 401, got %d", code)
	}
	c.login("one@example.com")
	_, out, _ := c.do("POST", "/api/${e.plural}", ${payload(1)})
	id := int(out["id"].(float64))
	c.login("two@example.com")
	if code, _, _ := c.do("GET", "/api/${e.plural}/"+itoa(id), nil); code != 404 {
		t.Fatalf("other user's record should be 404, got %d", code)
	}
}
` : ""}`);
  }).join("");
  return body + ents + "\nfunc itoa(n int) string { return strconv.Itoa(n) }\n";
}

const dockerfile = () => `FROM golang:1.24-alpine AS build
WORKDIR /src
COPY . .
RUN CGO_ENABLED=0 go build -o /out/server ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/server /server
EXPOSE 8080
ENTRYPOINT ["/server"]
`;

const readme = (spec) => `# ${spec.name}

Go (net/http, standard library routing) backend generated by Sierra. Layers: \`handler -> service -> repository\`.

## Run (Go 1.24+, no third-party dependencies)
\`\`\`
${spec.needsAuth ? "export JWT_SECRET=$(openssl rand -hex 32)\n" : ""}go run ./cmd/server
\`\`\`

## Test
\`\`\`
go vet ./... && go test ./...
\`\`\`

## Endpoints
- \`GET /health\`, \`GET /openapi.json\`, \`GET /metrics\` (Prometheus text, per process)
${spec.needsAuth ? "- \`POST /api/auth/register\`, \`POST /api/auth/login\`, \`GET /api/auth/me\`\n" : ""}${spec.entities.map((e) => `- \`GET|POST /api/${e.plural}\`, \`GET|PUT|DELETE /api/${e.plural}/{id}\``).join("\n")}

## Known limitations
- **Data is stored in memory** and is lost on restart. The \`Repository\` interface is the seam for a real database; no SQL implementation is generated yet.
- No OpenAPI document is generated for this stack yet; the endpoint list above is the contract.
- No rate limiting or refresh tokens.
`;

const metricsGo = () => bt(`// Package metrics keeps in-process request counters and renders them in the Prometheus text format.
// Counters are per process and are lost on restart; use a full client library if you need histograms.
package metrics

import (
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

type key struct{ method, route, status string }

type Registry struct {
	mu      sync.Mutex
	count   map[key]int64
	seconds map[key]float64
}

func New() *Registry {
	return &Registry{count: map[key]int64{}, seconds: map[key]float64{}}
}

type recorder struct {
	http.ResponseWriter
	status int
}

func (r *recorder) WriteHeader(c int) { r.status = c; r.ResponseWriter.WriteHeader(c) }

// Middleware must wrap the mux: ServeMux sets r.Pattern on the request it dispatches, which gives a bounded
// route label ("GET /api/items/{id}") instead of the raw path.
func (g *Registry) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &recorder{ResponseWriter: w, status: 200}
		next.ServeHTTP(rec, r)
		route := r.Pattern
		if route == "" {
			route = "unmatched"
		}
		k := key{r.Method, route, fmt.Sprint(rec.status)}
		g.mu.Lock()
		g.count[k]++
		g.seconds[k] += time.Since(start).Seconds()
		g.mu.Unlock()
	})
}

func esc(s string) string {
	return strings.NewReplacer("\\\\", "\\\\\\\\", "\\"", "\\\\\\"", "\\n", "\\\\n").Replace(s)
}

func (g *Registry) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		g.mu.Lock()
		keys := make([]key, 0, len(g.count))
		for k := range g.count {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool { return fmt.Sprint(keys[i]) < fmt.Sprint(keys[j]) })
		var b strings.Builder
		b.WriteString("# HELP http_requests_total Requests handled, by method, route pattern and status.\\n# TYPE http_requests_total counter\\n")
		for _, k := range keys {
			fmt.Fprintf(&b, "http_requests_total{method=\\"%s\\",route=\\"%s\\",status=\\"%s\\"} %d\\n", k.method, esc(k.route), k.status, g.count[k])
		}
		b.WriteString("# HELP http_request_duration_seconds_sum Total time spent handling requests.\\n# TYPE http_request_duration_seconds_sum counter\\n")
		for _, k := range keys {
			fmt.Fprintf(&b, "http_request_duration_seconds_sum{method=\\"%s\\",route=\\"%s\\",status=\\"%s\\"} %.6f\\n", k.method, esc(k.route), k.status, g.seconds[k])
		}
		g.mu.Unlock()
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		_, _ = w.Write([]byte(b.String()))
	})
}
`);

const openapiTestGo = () => bt(`package app_test

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestOpenAPIServedAndEveryDocumentedRouteIsRegistered(t *testing.T) {
	c := newClient(t)
	code, spec, _ := c.do("GET", "/openapi.json", nil)
	if code != 200 || spec["openapi"] == nil {
		t.Fatalf("openapi: %d %v", code, spec)
	}
	paths := spec["paths"].(map[string]any)
	for path, ops := range paths {
		for method := range ops.(map[string]any) {
			url := strings.ReplaceAll(path, "{id}", "1")
			code, out, raw := c.do(strings.ToUpper(method), url, map[string]any{})
			if code == 405 {
				t.Errorf("%s %s documented but not allowed", method, path)
			}
			if code == 404 {
				var e struct{ Error struct{ Code string } }
				_ = json.Unmarshal(raw, &e)
				if e.Error.Code != "not_found" {
					t.Errorf("%s %s documented but route is missing: %v", method, path, out)
				}
			}
		}
	}
}

func TestMetricsCountsRequestsByRoutePattern(t *testing.T) {
	c := newClient(t)
	c.do("GET", "/health", nil)
	c.do("GET", "/definitely-missing", nil)
	_, _, raw := c.do("GET", "/metrics", nil)
	text := string(raw)
	if !strings.Contains(text, ~http_requests_total{method="GET",route="GET /health",status="200"} 1~) {
		t.Errorf("missing /health counter:\\n%s", text)
	}
	if !strings.Contains(text, ~route="unmatched",status="404"~) {
		t.Errorf("missing unmatched counter:\\n%s", text)
	}
}
`);

function generate(spec) {
  const files = {};
  files["go.mod"] = goMod(spec);
  files["cmd/server/main.go"] = mainGo();
  files["internal/config/config.go"] = configGo(spec);
  files["internal/httpx/httpx.go"] = httpxGo();
  files["internal/app/app.go"] = appGo(spec);
  files["internal/app/app_test.go"] = testsGo(spec).replace('"testing"\n', '"strconv"\n\t"testing"\n');
  files["internal/metrics/metrics.go"] = metricsGo();
  files["internal/app/openapi.json"] = require("../openapiDoc").openApiJson(spec);
  files["internal/app/openapi_test.go"] = openapiTestGo();
  files["Dockerfile"] = dockerfile();
  files[".env.example"] = ["PORT=8080", "LOG_LEVEL=info", ...(spec.needsAuth ? ["JWT_SECRET=changeme_use_a_long_random_secret"] : [])].join("\n") + "\n";
  files[".gitignore"] = "bin/\n.env\n";
  files["README.md"] = readme(spec);
  if (spec.needsAuth) Object.assign(files, authGo());
  for (const e of spec.entities) Object.assign(files, entityGo(spec, e));
  if (goSql.isSql(spec)) goSql.patch(spec, files, jsonSample);
  for (const k of Object.keys(files)) files[k] = files[k].replace(/__APPMOD__/g, spec.slug);
  return files;
}

module.exports = {
  id: "go-nethttp",
  label: "Go + net/http",
  language: "Go",
  framework: "net/http",
  status: "implemented",
  databases: ["memory", "postgresql", "mysql"],
  notes: "In-memory repositories (default) or PostgreSQL / MySQL through database/sql with versioned migrations.",
  generate,
  validate: {
    offlineMeansSkipped: true,
    setupFor: (spec) => (goSql.isSql(spec) || (spec.features && spec.features.distributed) ? [["go", "mod", "tidy"]] : []),
    requiresFor: (spec) => (goSql.isSql(spec) ? [{ name: goSql.dbLabel(spec.database), env: "TEST_DATABASE_URL", fallback: goSql.testUrl(spec.database), hint: `Start one (e.g. docker run -d -p ${spec.database === "postgresql" ? "5432:5432 -e POSTGRES_USER=app -e POSTGRES_PASSWORD=app -e POSTGRES_DB=app postgres:16" : "3306:3306 -e MYSQL_ROOT_PASSWORD=app -e MYSQL_DATABASE=app -e MYSQL_USER=app -e MYSQL_PASSWORD=app mysql:8"}) or set TEST_DATABASE_URL. The tests drop the application's tables.` }] : []),
    format: [{ cmd: ["gofmt", "-l", "."], emptyOutput: true }],
    toolchain: "go",
    setup: [],
    build: [["go", "build", "./..."]],
    test: [["go", "vet", "./..."], ["go", "test", "./..."]],
  },
};
