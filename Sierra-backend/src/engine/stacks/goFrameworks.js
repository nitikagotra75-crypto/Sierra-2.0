/**
 * Gin and Fiber generators (EXPERIMENTAL).
 *
 * They reuse the framework-free layers of the go-nethttp generator (entity types/validation/services, auth service,
 * httpx, metrics) and replace only the HTTP layer with framework-native routing. The go-nethttp output is verified by
 * running its tests; these two stacks additionally need `go mod tidy` to download Gin/Fiber, which this build
 * environment cannot do, so they have NOT been compiled or run here. Validation reports "skipped" when the module
 * proxy is unreachable, never "passed".
 */
const goNet = require("./goNetHttp");
const goSql = require("./goSql");
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const bt = (s) => s.replace(/~/g, "`");

const AUTH_EXTRA = `
// Authenticate validates an "Authorization: Bearer <token>" header value and returns the user id.
func (s *Service) Authenticate(header string) (int64, error) {
	raw, found := strings.CutPrefix(header, "Bearer ")
	if !found || raw == "" {
		return 0, httpx.Unauthorized("Invalid or missing credentials")
	}
	sub, valid := parseToken(s.Secret, raw)
	if !valid {
		return 0, httpx.Unauthorized("Invalid or missing credentials")
	}
	id, _ := strconv.ParseInt(sub, 10, 64)
	if _, ok, err := s.Repo.ByID(id); err != nil {
		return 0, err
	} else if !ok {
		return 0, httpx.Unauthorized("Invalid or missing credentials")
	}
	return id, nil
}
`;

const OBSERVE = `
// Observe records one request; used by frameworks that do not set http.Request.Pattern.
func (g *Registry) Observe(method, route string, status int, d time.Duration) {
	k := key{method, route, fmt.Sprint(status)}
	g.mu.Lock()
	g.count[k]++
	g.seconds[k] += d.Seconds()
	g.mu.Unlock()
}
`;

const ERRORBODY = bt(`
// ErrorBody maps an error to the standard JSON error envelope and HTTP status.
func ErrorBody(err error) (int, map[string]any) {
	if ae, ok := err.(*AppError); ok {
		return ae.Status, map[string]any{"error": map[string]any{"code": ae.Code, "message": ae.Message, "details": ae.Details}}
	}
	slog.Error("unhandled error", "err", err)
	return 500, map[string]any{"error": map[string]any{"code": "internal_error", "message": "Internal server error", "details": nil}}
}

// DecodeBytes parses a JSON body (unknown fields rejected).
func DecodeBytes(b []byte, dst any) error {
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return Validation([]map[string]string{{"msg": "invalid JSON body: " + err.Error()}})
	}
	return nil
}
`);

const dockerfile = () => `FROM golang:1.24-alpine AS build
WORKDIR /src
COPY . .
RUN go mod tidy && CGO_ENABLED=0 go build -o /out/server ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/server /server
EXPOSE 8080
ENTRYPOINT ["/server"]
`;

// ---------------------------------------------------------------- Gin
const ginx = (spec) => `package ginx

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"${spec.slug}/internal/auth"
	"${spec.slug}/internal/httpx"
)

// Observe records the matched route pattern on the original request so the metrics middleware (which wraps the
// engine as a plain http.Handler) can label by route instead of raw path.
func Observe() gin.HandlerFunc {
	return func(c *gin.Context) {
		orig := c.Request
		c.Next()
		if p := c.FullPath(); p != "" {
			p = strings.NewReplacer(":id", "{id}").Replace(p)
			orig.Pattern = c.Request.Method + " " + p
		}
	}
}

// Auth rejects requests without a valid bearer token and stores the user id for handlers (UID).
func Auth(s *auth.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := s.Authenticate(c.GetHeader("Authorization"))
		if err != nil {
			httpx.WriteError(c.Writer, err)
			c.Abort()
			return
		}
		c.Set("uid", id)
		c.Next()
	}
}

func UID(c *gin.Context) int64 { return c.GetInt64("uid") }

func NoRoute(c *gin.Context) { httpx.WriteError(c.Writer, httpx.NotFound("route")) }

var _ = http.StatusOK
`;

function ginEntityHandler(spec, e) {
  const A = spec.needsAuth;
  const uid = A ? "ginx.UID(c)" : "0";
  return `package ${e.lower}

import (
	"strconv"

	"github.com/gin-gonic/gin"

${A ? `	"${spec.slug}/internal/ginx"\n` : ""}	"${spec.slug}/internal/httpx"
)

type Handler struct{ Svc *Service }

func pathID(c *gin.Context) (int64, error) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
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

// Routes registers the endpoints on a router group (the group carries the auth middleware when auth is enabled).
func (h *Handler) Routes(g gin.IRoutes) {
	g.GET("/api/${e.plural}", func(c *gin.Context) {
		limit := atoiDefault(c.Query("limit"), 50, 1, 200)
		offset := atoiDefault(c.Query("offset"), 0, 0, 1<<30)
		items, err := h.Svc.List(${uid}, limit, offset)
		if err != nil {
			httpx.WriteError(c.Writer, err)
			return
		}
		httpx.JSON(c.Writer, 200, items)
	})
	g.POST("/api/${e.plural}", func(c *gin.Context) {
		var in CreateInput
		if err := httpx.Decode(c.Request, &in); err != nil {
			httpx.WriteError(c.Writer, err)
			return
		}
		v, err := h.Svc.Create(in, ${uid})
		if err != nil {
			httpx.WriteError(c.Writer, err)
			return
		}
		httpx.JSON(c.Writer, 201, v)
	})
	g.GET("/api/${e.plural}/:id", func(c *gin.Context) {
		id, err := pathID(c)
		if err != nil {
			httpx.WriteError(c.Writer, err)
			return
		}
		v, err := h.Svc.Get(id, ${uid})
		if err != nil {
			httpx.WriteError(c.Writer, err)
			return
		}
		httpx.JSON(c.Writer, 200, v)
	})
	g.PUT("/api/${e.plural}/:id", func(c *gin.Context) {
		id, err := pathID(c)
		if err != nil {
			httpx.WriteError(c.Writer, err)
			return
		}
		var in UpdateInput
		if err := httpx.Decode(c.Request, &in); err != nil {
			httpx.WriteError(c.Writer, err)
			return
		}
		v, err := h.Svc.Update(id, in, ${uid})
		if err != nil {
			httpx.WriteError(c.Writer, err)
			return
		}
		httpx.JSON(c.Writer, 200, v)
	})
	g.DELETE("/api/${e.plural}/:id", func(c *gin.Context) {
		id, err := pathID(c)
		if err != nil {
			httpx.WriteError(c.Writer, err)
			return
		}
		if err := h.Svc.Delete(id, ${uid}); err != nil {
			httpx.WriteError(c.Writer, err)
			return
		}
		c.Status(204)
	})
}
`;
}

function ginApp(spec) {
  const A = spec.needsAuth;
  return `package app

import (
	_ "embed"
	"net/http"

	"github.com/gin-gonic/gin"

	"${spec.slug}/internal/config"
	"${spec.slug}/internal/ginx"
	"${spec.slug}/internal/httpx"
	"${spec.slug}/internal/metrics"
${A ? `	"${spec.slug}/internal/auth"\n` : ""}${spec.entities.map((e) => `	"${spec.slug}/internal/${e.lower}"`).join("\n")}
)

// openAPI is generated by Sierra from the project spec and served verbatim; edit it together with the routes.
//
//go:embed openapi.json
var openAPI []byte

// New wires repositories -> services -> handlers. It is the only place that knows concrete types.
func New(cfg config.Config) http.Handler {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(ginx.Observe())
	r.NoRoute(ginx.NoRoute)
	r.GET("/health", func(c *gin.Context) { httpx.JSON(c.Writer, 200, map[string]string{"status": "ok"}) })
	r.GET("/openapi.json", func(c *gin.Context) {
		c.Data(200, "application/json", openAPI)
	})
	reg := metrics.New()
	r.GET("/metrics", gin.WrapH(reg.Handler()))
${A ? `	authSvc := &auth.Service{Repo: auth.NewMemoryUsers(), Secret: []byte(cfg.JWTSecret), TTL: cfg.JWTTTL}
	registerAuth(r, authSvc)
	api := r.Group("", ginx.Auth(authSvc))
` : `	_ = cfg
	api := r.Group("")
`}${spec.entities.map((e) => `	(&${e.lower}.Handler{Svc: &${e.lower}.Service{Repo: ${e.lower}.NewMemoryRepo()}}).Routes(api)`).join("\n")}
	// The engine is an http.Handler, so the same logging/recovery/metrics wrappers apply as in the net/http stack.
	return reg.Middleware(httpx.Wrap(r))
}
`;
}

const ginAuthRoutes = (spec) => `package app

import (
	"github.com/gin-gonic/gin"

	"${spec.slug}/internal/auth"
	"${spec.slug}/internal/ginx"
	"${spec.slug}/internal/httpx"
)

func registerAuth(r *gin.Engine, s *auth.Service) {
	r.POST("/api/auth/register", func(c *gin.Context) {
		var in auth.RegisterInput
		if err := httpx.Decode(c.Request, &in); err != nil {
			httpx.WriteError(c.Writer, err)
			return
		}
		u, err := s.Register(in)
		if err != nil {
			httpx.WriteError(c.Writer, err)
			return
		}
		httpx.JSON(c.Writer, 201, u)
	})
	r.POST("/api/auth/login", func(c *gin.Context) {
		var in auth.LoginInput
		if err := httpx.Decode(c.Request, &in); err != nil {
			httpx.WriteError(c.Writer, err)
			return
		}
		tok, err := s.Login(in)
		if err != nil {
			httpx.WriteError(c.Writer, err)
			return
		}
		httpx.JSON(c.Writer, 200, map[string]string{"access_token": tok, "token_type": "bearer"})
	})
	r.GET("/api/auth/me", ginx.Auth(s), func(c *gin.Context) {
		u, _, err := s.Repo.ByID(ginx.UID(c))
		if err != nil {
			httpx.WriteError(c.Writer, err)
			return
		}
		httpx.JSON(c.Writer, 200, u)
	})
}
`;

// ---------------------------------------------------------------- Fiber
const fiberx = (spec) => `package fiberx

import (
	"errors"
	"time"

	"github.com/gofiber/fiber/v2"

	"${spec.slug}/internal/auth"
	"${spec.slug}/internal/httpx"
	"${spec.slug}/internal/metrics"
)

// Route labels a handler with its route pattern so metrics are keyed by pattern, not by raw path.
func Route(label string, h fiber.Handler) fiber.Handler {
	return func(c *fiber.Ctx) error {
		c.Locals("route", label)
		return h(c)
	}
}

// Metrics records every request (including unmatched ones) in the registry.
func Metrics(reg *metrics.Registry) fiber.Handler {
	return func(c *fiber.Ctx) error {
		start := time.Now()
		err := c.Next()
		route, _ := c.Locals("route").(string)
		if route == "" {
			route = "unmatched"
		}
		status := c.Response().StatusCode()
		if err != nil {
			status, _ = Status(err)
		}
		reg.Observe(c.Method(), route, status, time.Since(start))
		return err
	}
}

// Status maps any error to an HTTP status and the standard error body.
func Status(err error) (int, map[string]any) {
	var fe *fiber.Error
	if errors.As(err, &fe) {
		code := "http_error"
		if fe.Code == 404 {
			code = "not_found"
		}
		return fe.Code, map[string]any{"error": map[string]any{"code": code, "message": fe.Message, "details": nil}}
	}
	return httpx.ErrorBody(err)
}

func ErrorHandler(c *fiber.Ctx, err error) error {
	status, body := Status(err)
	return c.Status(status).JSON(body)
}

// Recover turns panics into the standard 500 body.
func Recover() fiber.Handler {
	return func(c *fiber.Ctx) (err error) {
		defer func() {
			if r := recover(); r != nil {
				err = &httpx.AppError{Status: 500, Code: "internal_error", Message: "Internal server error"}
			}
		}()
		return c.Next()
	}
}

func Auth(s *auth.Service) fiber.Handler {
	return func(c *fiber.Ctx) error {
		id, err := s.Authenticate(c.Get("Authorization"))
		if err != nil {
			return err
		}
		c.Locals("uid", id)
		return c.Next()
	}
}

func UID(c *fiber.Ctx) int64 {
	id, _ := c.Locals("uid").(int64)
	return id
}

func NotFound(c *fiber.Ctx) error { return httpx.NotFound("route") }

// Label sets the route pattern used for metrics; it runs before auth so rejected requests are labelled too.
func Label(label string) fiber.Handler {
	return func(c *fiber.Ctx) error {
		c.Locals("route", label)
		return c.Next()
	}
}

// Pass is the guard used when auth is disabled.
func Pass(c *fiber.Ctx) error { return c.Next() }
`;

function fiberEntityHandler(spec, e) {
  const A = spec.needsAuth;
  const uid = A ? "fiberx.UID(c)" : "0";
  const R = (m, p) => `fiberx.Label(${JSON.stringify(m + " " + p)}), guard, `;
  const base = `/api/${e.plural}`;
  return `package ${e.lower}

import (
	"strconv"

	"github.com/gofiber/fiber/v2"

	"${spec.slug}/internal/fiberx"
	"${spec.slug}/internal/httpx"
)

type Handler struct{ Svc *Service }

func pathID(c *fiber.Ctx) (int64, error) {
	id, err := strconv.ParseInt(c.Params("id"), 10, 64)
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

// Routes registers the endpoints; guard is the auth middleware (a pass-through when auth is disabled).
func (h *Handler) Routes(r fiber.Router, guard fiber.Handler) {
	r.Get("${base}", ${R("GET", base)}func(c *fiber.Ctx) error {
		limit := atoiDefault(c.Query("limit"), 50, 1, 200)
		offset := atoiDefault(c.Query("offset"), 0, 0, 1<<30)
		items, err := h.Svc.List(${uid}, limit, offset)
		if err != nil {
			return err
		}
		return c.Status(200).JSON(items)
	})
	r.Post("${base}", ${R("POST", base)}func(c *fiber.Ctx) error {
		var in CreateInput
		if err := httpx.DecodeBytes(c.Body(), &in); err != nil {
			return err
		}
		v, err := h.Svc.Create(in, ${uid})
		if err != nil {
			return err
		}
		return c.Status(201).JSON(v)
	})
	r.Get("${base}/:id", ${R("GET", base + "/{id}")}func(c *fiber.Ctx) error {
		id, err := pathID(c)
		if err != nil {
			return err
		}
		v, err := h.Svc.Get(id, ${uid})
		if err != nil {
			return err
		}
		return c.Status(200).JSON(v)
	})
	r.Put("${base}/:id", ${R("PUT", base + "/{id}")}func(c *fiber.Ctx) error {
		id, err := pathID(c)
		if err != nil {
			return err
		}
		var in UpdateInput
		if err := httpx.DecodeBytes(c.Body(), &in); err != nil {
			return err
		}
		v, err := h.Svc.Update(id, in, ${uid})
		if err != nil {
			return err
		}
		return c.Status(200).JSON(v)
	})
	r.Delete("${base}/:id", ${R("DELETE", base + "/{id}")}func(c *fiber.Ctx) error {
		id, err := pathID(c)
		if err != nil {
			return err
		}
		if err := h.Svc.Delete(id, ${uid}); err != nil {
			return err
		}
		return c.SendStatus(204)
	})
}
`;
}

function fiberApp(spec) {
  const A = spec.needsAuth;
  return `package app

import (
	_ "embed"
	"net/http"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/adaptor"

	"${spec.slug}/internal/config"
	"${spec.slug}/internal/fiberx"
	"${spec.slug}/internal/httpx"
	"${spec.slug}/internal/metrics"
${A ? `	"${spec.slug}/internal/auth"\n` : ""}${spec.entities.map((e) => `	"${spec.slug}/internal/${e.lower}"`).join("\n")}
)

// openAPI is generated by Sierra from the project spec and served verbatim; edit it together with the routes.
//
//go:embed openapi.json
var openAPI []byte

// New wires repositories -> services -> handlers. It returns an http.Handler (Fiber app adapted through
// fiber's adaptor) so the same tests and the same logging wrapper work as in the net/http stack.
func New(cfg config.Config) http.Handler {
	f := fiber.New(fiber.Config{
		DisableStartupMessage: true,
		ErrorHandler:          fiberx.ErrorHandler,
		BodyLimit:             1 << 20,
	})
	reg := metrics.New()
	f.Use(fiberx.Metrics(reg))
	f.Use(fiberx.Recover())
	f.Get("/health", fiberx.Route("GET /health", func(c *fiber.Ctx) error { return c.JSON(map[string]string{"status": "ok"}) }))
	f.Get("/openapi.json", fiberx.Route("GET /openapi.json", func(c *fiber.Ctx) error {
		c.Set("Content-Type", "application/json")
		return c.Send(openAPI)
	}))
	f.Get("/metrics", fiberx.Route("GET /metrics", adaptor.HTTPHandler(reg.Handler())))
${A ? `	authSvc := &auth.Service{Repo: auth.NewMemoryUsers(), Secret: []byte(cfg.JWTSecret), TTL: cfg.JWTTTL}
	registerAuth(f, authSvc)
	guard := fiberx.Auth(authSvc)
` : `	_ = cfg
	guard := fiberx.Pass
`}${spec.entities.map((e) => `	(&${e.lower}.Handler{Svc: &${e.lower}.Service{Repo: ${e.lower}.NewMemoryRepo()}}).Routes(f, guard)`).join("\n")}
	f.Use(fiberx.NotFound)
	return httpx.Wrap(adaptor.FiberApp(f))
}
`;
}

const fiberAuthRoutes = (spec) => `package app

import (
	"github.com/gofiber/fiber/v2"

	"${spec.slug}/internal/auth"
	"${spec.slug}/internal/fiberx"
	"${spec.slug}/internal/httpx"
)

func registerAuth(f *fiber.App, s *auth.Service) {
	f.Post("/api/auth/register", fiberx.Route("POST /api/auth/register", func(c *fiber.Ctx) error {
		var in auth.RegisterInput
		if err := httpx.DecodeBytes(c.Body(), &in); err != nil {
			return err
		}
		u, err := s.Register(in)
		if err != nil {
			return err
		}
		return c.Status(201).JSON(u)
	}))
	f.Post("/api/auth/login", fiberx.Route("POST /api/auth/login", func(c *fiber.Ctx) error {
		var in auth.LoginInput
		if err := httpx.DecodeBytes(c.Body(), &in); err != nil {
			return err
		}
		tok, err := s.Login(in)
		if err != nil {
			return err
		}
		return c.Status(200).JSON(map[string]string{"access_token": tok, "token_type": "bearer"})
	}))
	f.Get("/api/auth/me", fiberx.Auth(s), fiberx.Route("GET /api/auth/me", func(c *fiber.Ctx) error {
		u, _, err := s.Repo.ByID(fiberx.UID(c))
		if err != nil {
			return err
		}
		return c.Status(200).JSON(u)
	}))
}
`;

function derive(spec, kind) {
  const files = goNet.generate(spec);
  const A = spec.needsAuth;
  const req = kind === "gin" ? "github.com/gin-gonic/gin v1.10.0" : "github.com/gofiber/fiber/v2 v2.52.5";
  const sql = goSql.isSql(spec) ? goSql.VERSIONS[spec.database] : null;
  files["go.mod"] = sql ? `module ${spec.slug}\n\ngo 1.24\n\nrequire (\n\t${req}\n\t${sql.mod} ${sql.ver}\n)\n` : `module ${spec.slug}\n\ngo 1.24\n\nrequire ${req}\n`;
  files["Dockerfile"] = dockerfile();
  if (A) files["internal/auth/auth.go"] += AUTH_EXTRA;
  if (A) {
    // Authenticate uses strings/strconv, which the generated Middleware already imports.
  }
  files["internal/metrics/metrics.go"] += OBSERVE;
  if (kind === "fiber") {
    files["internal/httpx/httpx.go"] = files["internal/httpx/httpx.go"].replace('import (\n\t"encoding/json"', 'import (\n\t"bytes"\n\t"encoding/json"') + ERRORBODY;
  }
  for (const e of spec.entities) {
    files[`internal/${e.lower}/handler.go`] = kind === "gin" ? ginEntityHandler(spec, e) : fiberEntityHandler(spec, e);
  }
  const stores = (src) => {
    const a = spec.needsAuth;
    const types = `// Stores groups the persistence the application needs (shared with the net/http stack's layout).
type Stores struct {
${a ? "\tUsers auth.UserRepository\n" : ""}${spec.entities.map((e) => `\t${e.name} ${e.lower}.Repository`).join("\n")}
}

// MemoryStores returns non-persistent in-memory stores.
func MemoryStores() Stores {
	return Stores{
${a ? "\t\tUsers: auth.NewMemoryUsers(),\n" : ""}${spec.entities.map((e) => `\t\t${e.name}: ${e.lower}.NewMemoryRepo(),`).join("\n")}
	}
}

// New builds the application on in-memory stores.
func New(cfg config.Config) http.Handler { return NewWith(cfg, MemoryStores()) }

// NewWith wires repositories -> services -> handlers. It is the only place that knows concrete types.
func NewWith(cfg config.Config, st Stores) http.Handler {`;
    let out = src.replace(/\/\/ New wires repositories[^\n]*\n(?:\/\/ [^\n]*\n)*func New\(cfg config\.Config\) http\.Handler \{/, types);
    if (out === src) throw new Error("gin/fiber stores: New() anchor not found");
    out = out.replace("auth.NewMemoryUsers(), Secret", "st.Users, Secret");
    for (const e of spec.entities) out = out.replace(`${e.lower}.Service{Repo: ${e.lower}.NewMemoryRepo()}`, `${e.lower}.Service{Repo: st.${e.name}}`);
    return out;
  };
  if (kind === "gin") {
    files["internal/ginx/ginx.go"] = ginx(spec);
    files["internal/app/app.go"] = stores(ginApp(spec));
    if (A) files["internal/app/auth_routes.go"] = ginAuthRoutes(spec);
  } else {
    files["internal/fiberx/fiberx.go"] = fiberx(spec);
    files["internal/app/app.go"] = stores(fiberApp(spec));
    if (A) files["internal/app/auth_routes.go"] = fiberAuthRoutes(spec);
  }
  if (!A) {
    // fiberx/ginx import the auth package; without auth the generated project has none, so drop that part.
    const k = kind === "gin" ? "internal/ginx/ginx.go" : "internal/fiberx/fiberx.go";
    files[k] = files[k]
      .replace(`\t"${spec.slug}/internal/auth"\n`, "")
      .replace(/\/\/ Auth rejects[\s\S]*?func UID\(c \*gin\.Context\) int64 \{[^\n]*\n/, "")
      .replace(/func Auth\(s \*auth\.Service\) fiber\.Handler \{[\s\S]*?\n\}\n\nfunc UID\(c \*fiber\.Ctx\) int64 \{[\s\S]*?\n\}\n/, "");
  }
  const name = kind === "gin" ? "Gin" : "Fiber";
  const tail = files["README.md"].split("\n").slice(1).join("\n");
  files["README.md"] = `# ${spec.name}

Go + ${name} backend generated by Sierra (EXPERIMENTAL).

**Status:** the domain, auth, validation, error-envelope and metrics layers are shared with Sierra's go-nethttp stack, whose
tests are executed. The ${name} routing layer and its dependency wiring were generated but **could not be compiled or run** in
Sierra's build environment (Go module downloads are blocked there). Run \`go mod tidy && go vet ./... && go test ./...\` before
relying on it; please report failures.

${tail.replace(/^\s*\n/, "")}`;
  return files;
}

const mk = (kind) => ({
  id: kind === "gin" ? "go-gin" : "go-fiber",
  label: kind === "gin" ? "Go + Gin" : "Go + Fiber",
  language: "Go",
  framework: cap(kind),
  status: "implemented",
  databases: ["memory", "postgresql", "mysql"],
  notes: kind === "gin" ? "Gin compiled and tested in Sierra's sandbox against Debian's Gin 1.8.1 (not the pinned v1.10.0). In-memory, PostgreSQL or MySQL." : "EXPERIMENTAL: Fiber could not be compiled in Sierra's sandbox (not packaged, module downloads blocked). In-memory, PostgreSQL or MySQL (statically validated).",
  generate: (spec) => derive(spec, kind),
  validate: {
    toolchain: "go",
    format: [{ cmd: ["gofmt", "-l", "."], emptyOutput: true }],
    // -e: tidy also resolves modules behind build tags (e.g. Gin's optional JSON libraries); a genuinely missing module still fails the build
    setup: [["go", "mod", "tidy", "-e"]],
    requiresFor: goNet.validate.requiresFor,
    build: [["go", "build", "./..."]],
    offlineMeansSkipped: true,
    test: [["go", "vet", "./..."], ["go", "test", "./..."]],
  },
});

module.exports = [mk("gin"), mk("fiber")];
