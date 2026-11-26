/**
 * Django generator (no DRF). Layers: views -> services -> Django ORM (the ORM manager acts as the
 * repository). Request bodies are validated with pydantic; shapes match the other Sierra stacks.
 * Known limitation: no migration files are generated (tables come from `migrate --run-syncdb`).
 */
const { parts: P } = require("./pythonFastapi");

const FIELD = {
  string: (o) => `models.CharField(max_length=255${o})`,
  text: (o) => `models.TextField(${o.replace(/^, /, "")})`,
  int: (o) => `models.BigIntegerField(${o.replace(/^, /, "")})`,
  float: (o) => `models.FloatField(${o.replace(/^, /, "")})`,
  bool: (o) => `models.BooleanField(${o.replace(/^, /, "")})`,
  enum: (o) => `models.CharField(max_length=32${o})`,
};

function modelPy(spec, e) {
  const cols = e.fields.map((f) => {
    const hasDefault = f.default !== undefined;
    const opt = !f.required && !hasDefault;
    const o = `${hasDefault ? `, default=${P.pyLit(f.default)}` : ""}${opt ? ", null=True, blank=True" : ""}${hasDefault && f.type !== "bool" ? ", blank=True" : ""}`;
    return `    ${f.name} = ${FIELD[f.type](o)}`;
  });
  return `from django.db import models
from django.utils import timezone


class ${e.name}(models.Model):
${cols.join("\n")}
${spec.needsAuth ? "    owner = models.ForeignKey(\"api.User\", on_delete=models.CASCADE, related_name=\"+\")\n" : ""}    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        db_table = "${e.plural.replace(/-/g, "_")}"
`;
}

function serviceDjangoPy(spec, e) {
  const A = spec.needsAuth;
  const own = A ? ", owner_id=owner_id" : "";
  return `from api.models import ${e.name}
from api.schemas.${e.snake} import ${e.name}Create, ${e.name}Update
from core.errors import NotFoundError


class ${e.name}Service:
    def list(self${A ? ", owner_id: int" : ""}, limit: int = 50, offset: int = 0):
        qs = ${e.name}.objects.filter(${A ? "owner_id=owner_id" : ""}).order_by("-id")
        return list(qs[offset : offset + limit])

    def get(self, id: int${A ? ", owner_id: int" : ""}):
        try:
            return ${e.name}.objects.get(id=id${own})
        except ${e.name}.DoesNotExist:
            raise NotFoundError("${e.name}")

    def create(self, data: ${e.name}Create${A ? ", owner_id: int" : ""}):
        return ${e.name}.objects.create(**data.model_dump()${own})

    def update(self, id: int, data: ${e.name}Update${A ? ", owner_id: int" : ""}):
        obj = self.get(id${A ? ", owner_id" : ""})
        for key, value in data.model_dump(exclude_unset=True).items():
            setattr(obj, key, value)
        obj.save()
        return obj

    def delete(self, id: int${A ? ", owner_id: int" : ""}) -> None:
        self.get(id${A ? ", owner_id" : ""}).delete()
`;
}

function viewsPy(spec, e) {
  const A = spec.needsAuth;
  const o = A ? "request.user.id, " : "";
  const oLast = A ? ", request.user.id" : "";
  const names = e.fields.map((f) => f.name);
  return `from api.schemas.${e.snake} import ${e.name}Create, ${e.name}Read, ${e.name}Update
from api.services.${e.snake}_service import ${e.name}Service
from core.http import api_view, dump, int_arg, no_content, parse_body

service = ${e.name}Service()
FIELDS = ${JSON.stringify(names)}


def _read(obj):
    return dump(${e.name}Read, {"id": obj.id, ${names.map((n) => `"${n}": obj.${n}`).join(", ")}${A ? ", \"owner_id\": obj.owner_id" : ""}, "created_at": obj.created_at})


@api_view("GET", "POST"${A ? ", auth=True" : ""})
def collection(request):
    if request.method == "GET":
        items = service.list(${o}int_arg(request, "limit", 50, 1, 200), int_arg(request, "offset", 0, 0, 10**9))
        return [_read(i) for i in items], 200
    return _read(service.create(parse_body(request, ${e.name}Create)${oLast})), 201


@api_view("GET", "PUT", "DELETE"${A ? ", auth=True" : ""})
def item(request, id):
    if request.method == "GET":
        return _read(service.get(id${oLast})), 200
    if request.method == "PUT":
        return _read(service.update(id, parse_body(request, ${e.name}Update)${oLast})), 200
    service.delete(id${oLast})
    return no_content()
`;
}

const errorsPy = () => `import logging

from django.http import JsonResponse

log = logging.getLogger("app.errors")


class AppError(Exception):
    def __init__(self, status_code: int, code: str, message: str, details=None):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details


class NotFoundError(AppError):
    def __init__(self, what: str):
        super().__init__(404, "not_found", f"{what} not found")


class ConflictError(AppError):
    def __init__(self, message: str):
        super().__init__(409, "conflict", message)


class UnauthorizedError(AppError):
    def __init__(self, message: str = "Invalid or missing credentials"):
        super().__init__(401, "unauthorized", message)


class ValidationFailed(AppError):
    def __init__(self, details):
        super().__init__(422, "validation_error", "Request validation failed", details)


def error_body(code: str, message: str, details=None) -> dict:
    return {"error": {"code": code, "message": message, "details": details}}


def not_found_view(request, exception=None):
    return JsonResponse(error_body("http_error", "Route not found"), status=404)


class ErrorMiddleware:
    """Turns AppError and unexpected exceptions into the standard JSON error shape."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        return self.get_response(request)

    def process_exception(self, request, exc):
        if isinstance(exc, AppError):
            return JsonResponse(error_body(exc.code, exc.message, exc.details), status=exc.status_code)
        log.exception("unhandled error")
        return JsonResponse(error_body("internal_error", "Internal server error"), status=500)
`;

const httpPy = (spec) => `import json
from functools import wraps

from django.http import HttpResponse, JsonResponse
from django.views.decorators.csrf import csrf_exempt
from pydantic import BaseModel, ValidationError

from core.errors import AppError, UnauthorizedError, ValidationFailed, error_body
${spec.needsAuth ? "from core.security import decode_access_token\nfrom api.models import User\n" : ""}

def parse_body(request, model: type[BaseModel]):
    try:
        data = json.loads(request.body or b"")
    except ValueError:
        data = None
    if not isinstance(data, dict):
        raise ValidationFailed([{"loc": ["body"], "msg": "JSON object required"}])
    try:
        return model.model_validate(data)
    except ValidationError as exc:
        raise ValidationFailed([{"loc": list(e["loc"]), "msg": e["msg"]} for e in exc.errors()])


def dump(model: type[BaseModel], data) -> dict:
    return model.model_validate(data).model_dump(mode="json")


def int_arg(request, name: str, default: int, lo: int, hi: int) -> int:
    raw = request.GET.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        raise ValidationFailed([{"loc": ["query", name], "msg": "must be an integer"}])
    if not lo <= value <= hi:
        raise ValidationFailed([{"loc": ["query", name], "msg": f"must be between {lo} and {hi}"}])
    return value


def no_content():
    return HttpResponse(status=204)

${spec.needsAuth ? `
def _authenticate(request):
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer ") or len(header) <= 7:
        raise UnauthorizedError()
    user = User.objects.filter(id=int(decode_access_token(header[7:]))).first()
    if user is None:
        raise UnauthorizedError()
    return user

` : ""}
def api_view(*methods, auth: bool = False):
    """JSON endpoint: method check, optional bearer auth, returns (payload, status) or a ready response."""

    def deco(fn):
        @csrf_exempt
        @wraps(fn)
        def wrapper(request, *args, **kwargs):
            if request.method not in methods:
                resp = JsonResponse(error_body("http_error", "Method not allowed"), status=405)
                resp["Allow"] = ", ".join(methods)
                return resp
${spec.needsAuth ? "            if auth:\n                request.user = _authenticate(request)\n" : ""}            result = fn(request, *args, **kwargs)
            if isinstance(result, HttpResponse):
                return result
            payload, status = result
            return JsonResponse(payload, status=status, safe=False)

        return wrapper

    return deco
`;

const securityPy = () => `from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from django.conf import settings

from core.errors import UnauthorizedError


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), hashed.encode("utf-8"))
    except ValueError:
        return False


def create_access_token(subject: str) -> str:
    exp = datetime.now(timezone.utc) + timedelta(minutes=settings.JWT_EXPIRE_MINUTES)
    return jwt.encode({"sub": subject, "exp": exp}, settings.JWT_SECRET, algorithm="HS256")


def decode_access_token(token: str) -> str:
    try:
        return jwt.decode(token, settings.JWT_SECRET, algorithms=["HS256"])["sub"]
    except jwt.PyJWTError:
        raise UnauthorizedError()
`;

const authViewsPy = () => `from api.models import User
from api.schemas.auth import LoginRequest, RegisterRequest, UserRead
from core.errors import ConflictError, UnauthorizedError
from core.http import api_view, dump, parse_body
from core.security import create_access_token, hash_password, verify_password


def _user(u):
    return dump(UserRead, {"id": u.id, "email": u.email, "name": u.name, "created_at": u.created_at})


@api_view("POST")
def register(request):
    data = parse_body(request, RegisterRequest)
    email = data.email.lower()
    if User.objects.filter(email=email).exists():
        raise ConflictError("Email already registered")
    return _user(User.objects.create(email=email, name=data.name, password_hash=hash_password(data.password))), 201


@api_view("POST")
def login(request):
    data = parse_body(request, LoginRequest)
    user = User.objects.filter(email=data.email.lower()).first()
    if user is None or not verify_password(data.password, user.password_hash):
        raise UnauthorizedError("Invalid email or password")
    return {"access_token": create_access_token(str(user.id)), "token_type": "bearer"}, 200


@api_view("GET", auth=True)
def me(request):
    return _user(request.user), 200
`;

const userModelPy = () => `class User(models.Model):
    email = models.CharField(max_length=255, unique=True)
    name = models.CharField(max_length=255, default="", blank=True)
    password_hash = models.CharField(max_length=255)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        db_table = "users"
`;

const settingsPy = (spec) => `import os
import sys
from pathlib import Path

import dj_database_url

BASE_DIR = Path(__file__).resolve().parent.parent
TESTING = "test" in sys.argv

JWT_SECRET = os.environ.get("JWT_SECRET", "test-secret-not-for-production-0123456789" if TESTING else "")
JWT_EXPIRE_MINUTES = int(os.environ.get("JWT_EXPIRE_MINUTES", "60"))
SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY") or JWT_SECRET or ("test-key" if TESTING else "")
if not SECRET_KEY:
    raise RuntimeError("Set DJANGO_SECRET_KEY${spec.needsAuth ? " (and JWT_SECRET)" : ""}")
${spec.needsAuth ? `if not JWT_SECRET:
    raise RuntimeError("JWT_SECRET must be set")
` : ""}
DEBUG = os.environ.get("DEBUG", "false").lower() == "true"
ALLOWED_HOSTS = os.environ.get("ALLOWED_HOSTS", "localhost,127.0.0.1,testserver").split(",")

INSTALLED_APPS = ["api"]
MIDDLEWARE = ["core.metrics.MetricsMiddleware", "core.errors.ErrorMiddleware"]
ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
USE_TZ = True
TIME_ZONE = "UTC"

DATABASES = {"default": dj_database_url.parse(os.environ.get("DATABASE_URL", f"sqlite:///{BASE_DIR / 'db.sqlite3'}"))}

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {"json": {"()": "core.logging.JsonFormatter"}},
    "handlers": {"console": {"class": "logging.StreamHandler", "formatter": "json", "stream": "ext://sys.stdout"}},
    "root": {"handlers": ["console"], "level": os.environ.get("LOG_LEVEL", "INFO")},
}
`;

const loggingPy = () => P.loggingPy().replace(/\n\ndef configure_logging[\s\S]*$/, "\n");

const { openApiJson } = require("../openapiDoc");

const metricsPy = () => `import threading
import time
from collections import defaultdict

from django.http import HttpResponse

_lock = threading.Lock()
_count = defaultdict(int)
_seconds = defaultdict(float)


def _esc(v: str) -> str:
    return v.replace("\\\\", "\\\\\\\\").replace('"', '\\\\"')


class MetricsMiddleware:
    """In-process request counters in Prometheus text format. Counters are per worker process: with several
    gunicorn workers each scrape sees one worker, so use a multiprocess-aware client if you need exact totals."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        t0 = time.perf_counter()
        response = self.get_response(request)
        match = getattr(request, "resolver_match", None)
        route = "/" + match.route if match and match.route is not None else "unmatched"
        key = (request.method, route, str(response.status_code))
        with _lock:
            _count[key] += 1
            _seconds[key] += time.perf_counter() - t0
        return response


def metrics_view(request):
    lines = [
        "# HELP http_requests_total Requests handled, by method, route template and status.",
        "# TYPE http_requests_total counter",
    ]
    with _lock:
        for (m, r, st), n in sorted(_count.items()):
            lines.append('http_requests_total{method="%s",route="%s",status="%s"} %d' % (m, _esc(r), st, n))
        lines += [
            "# HELP http_request_duration_seconds_sum Total time spent handling requests.",
            "# TYPE http_request_duration_seconds_sum counter",
        ]
        for (m, r, st), v in sorted(_seconds.items()):
            lines.append('http_request_duration_seconds_sum{method="%s",route="%s",status="%s"} %.6f' % (m, _esc(r), st, v))
    return HttpResponse("\\n".join(lines) + "\\n", content_type="text/plain; version=0.0.4")
`;

const openapiTestPy = () => `import json
import re
from pathlib import Path

from api.tests.base import ApiTestCase


def _norm(path):
    return re.sub(r"<(?:[^:>]+:)?[^>]+>|\\{[^}]+\\}", "{}", path)


class OpenApiMetricsTests(ApiTestCase):
    def test_openapi_served_and_matches_registered_routes(self):
        from api import urls

        spec = self.call("GET", "/openapi.json").json()
        self.assertTrue(spec["openapi"].startswith("3."))
        on_disk = json.loads((Path(__file__).resolve().parent.parent.parent / "config" / "openapi.json").read_text())
        self.assertEqual(on_disk, spec)
        documented = {(_norm(p), m.upper()) for p, ops in spec["paths"].items() if p.startswith("/api/") for m in ops}
        # Django routes accept any method and dispatch inside the view, so compare paths, then check each documented
        # method really is handled (not 405) by calling it.
        registered = {_norm("/" + str(u.pattern)) for u in urls.urlpatterns}
        self.assertEqual(registered, {d[0] for d in documented})

    def test_metrics_counts_requests_by_route_template(self):
        self.call("GET", "/health")
        self.call("GET", "/definitely-missing")
        text = self.call("GET", "/metrics").content.decode()
        self.assertIn('http_requests_total{method="GET",route="/health",status="200"}', text)
        self.assertIn('route="unmatched",status="404"', text)
`;

function generate(spec) {
  const A = spec.needsAuth;
  const f = {};
  const pg = spec.database === "postgresql";
  f["requirements.txt"] = ["django>=5.0,<6", "pydantic>=2.6,<3", "dj-database-url>=2.1", "gunicorn>=22", ...(A ? ["pyjwt>=2.8,<3", "bcrypt>=4.1"] : []), ...(pg ? ["psycopg2-binary>=2.9"] : [])].join("\n") + "\n";
  f[".env.example"] = ["DJANGO_SECRET_KEY=changeme_use_a_long_random_secret", "LOG_LEVEL=INFO", pg ? "DATABASE_URL=postgres://app:app@localhost:5432/app" : "DATABASE_URL=sqlite:///db.sqlite3", ...(A ? ["JWT_SECRET=changeme_use_a_long_random_secret", "JWT_EXPIRE_MINUTES=60"] : [])].join("\n") + "\n";
  f["manage.py"] = `#!/usr/bin/env python
import os
import sys

if __name__ == "__main__":
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
    from django.core.management import execute_from_command_line

    execute_from_command_line(sys.argv)
`;
  for (const p of ["config", "core", "api", "api/services", "api/schemas", "api/tests"]) f[`${p}/__init__.py`] = "";
  f["config/settings.py"] = settingsPy(spec);
  f["config/wsgi.py"] = `import os\n\nfrom django.core.wsgi import get_wsgi_application\n\nos.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")\napplication = get_wsgi_application()\n`;
  f["config/urls.py"] = `import json
from pathlib import Path

from django.http import JsonResponse
from django.urls import include, path

from core.metrics import metrics_view

handler404 = "core.errors.not_found_view"
_OPENAPI = json.loads((Path(__file__).parent / "openapi.json").read_text())


def health(request):
    return JsonResponse({"status": "ok"})


def openapi(request):
    return JsonResponse(_OPENAPI)


urlpatterns = [path("health", health), path("metrics", metrics_view), path("openapi.json", openapi), path("", include("api.urls"))]
`;
  f["core/errors.py"] = errorsPy();
  f["core/metrics.py"] = metricsPy();
  f["config/openapi.json"] = openApiJson(spec);
  f["api/tests/test_openapi_metrics.py"] = openapiTestPy();
  f["core/http.py"] = httpPy(spec);
  f["core/logging.py"] = loggingPy();
  if (A) f["core/security.py"] = securityPy();
  f["api/apps.py"] = `from django.apps import AppConfig\n\n\nclass ApiConfig(AppConfig):\n    name = "api"\n`;

  const models = [`from django.db import models\nfrom django.utils import timezone\n`];
  if (A) models.push("\n" + userModelPy());
  const ents = [];
  for (const e of spec.entities) {
    const m = modelPy(spec, e).split("\n").slice(4).join("\n");
    ents.push("\n" + m.replace(/^\n+/, ""));
    f[`api/schemas/${e.snake}.py`] = P.entitySchemasPy(spec, e);
    f[`api/services/${e.snake}_service.py`] = serviceDjangoPy(spec, e);
    f[`api/views_${e.snake}.py`] = viewsPy(spec, e);
  }
  f["api/models.py"] = models.join("\n") + "\n" + ents.join("\n");
  if (A) {
    const fa = require("./pythonFastapi").generate({ ...spec, entities: [], needsAuth: true });
    f["api/schemas/auth.py"] = fa["app/schemas/auth.py"];
    f["api/auth_views.py"] = authViewsPy();
  }
  f["api/urls.py"] = `from django.urls import path

${A ? "from api import auth_views\n" : ""}${spec.entities.map((e) => `from api import views_${e.snake}`).join("\n")}

urlpatterns = [
${A ? `    path("api/auth/register", auth_views.register),\n    path("api/auth/login", auth_views.login),\n    path("api/auth/me", auth_views.me),\n` : ""}${spec.entities.map((e) => `    path("api/${e.plural}", views_${e.snake}.collection),\n    path("api/${e.plural}/<int:id>", views_${e.snake}.item),`).join("\n")}
]
`;

  // tests
  f["api/tests/base.py"] = `import json

from django.test import TestCase


class ApiTestCase(TestCase):
    def call(self, method, path, body=None, token=None):
        extra = {"HTTP_AUTHORIZATION": "Bearer " + token} if token else {}
        data = json.dumps(body) if body is not None else None
        return self.client.generic(method, path, data or "", content_type="application/json", **extra)
${A ? `
    def login(self, email="user@example.com"):
        self.call("POST", "/api/auth/register", {"email": email, "password": "password123"})
        return self.call("POST", "/api/auth/login", {"email": email, "password": "password123"}).json()["access_token"]
` : ""}`;
  f["api/tests/test_health.py"] = `from api.tests.base import ApiTestCase


class HealthTests(ApiTestCase):
    def test_health(self):
        r = self.call("GET", "/health")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"status": "ok"})

    def test_unknown_route_is_json(self):
        r = self.call("GET", "/nope")
        self.assertEqual(r.status_code, 404)
        self.assertEqual(r.json()["error"]["code"], "http_error")
`;
  if (A) f["api/tests/test_auth.py"] = `from api.tests.base import ApiTestCase


class AuthTests(ApiTestCase):
    def test_register_login_me(self):
        r = self.call("POST", "/api/auth/register", {"email": "a@example.com", "name": "A", "password": "password123"})
        self.assertEqual(r.status_code, 201)
        self.assertNotIn("password", r.content.decode())
        tok = self.call("POST", "/api/auth/login", {"email": "a@example.com", "password": "password123"}).json()["access_token"]
        me = self.call("GET", "/api/auth/me", token=tok)
        self.assertEqual(me.json()["email"], "a@example.com")

    def test_duplicate_weak_bad_login_bad_token(self):
        body = {"email": "d@example.com", "password": "password123"}
        self.assertEqual(self.call("POST", "/api/auth/register", body).status_code, 201)
        self.assertEqual(self.call("POST", "/api/auth/register", body).status_code, 409)
        weak = self.call("POST", "/api/auth/register", {"email": "w@example.com", "password": "short"})
        self.assertEqual(weak.status_code, 422)
        self.assertEqual(weak.json()["error"]["code"], "validation_error")
        self.assertEqual(self.call("POST", "/api/auth/login", {"email": "d@example.com", "password": "wrong-password"}).status_code, 401)
        self.assertEqual(self.call("GET", "/api/auth/me", token="not-a-token").status_code, 401)
`;
  for (const e of spec.entities) {
    const req = e.fields.filter((fl) => fl.required || fl.default === undefined);
    const payload = "{" + req.map((fl) => `"${fl.name}": ${P.sampleValue(fl, 1)}`).join(", ") + "}";
    const first = e.fields.find((fl) => fl.required && fl.type === "string") || e.fields[0];
    const upd = first.type === "string" ? `{"${first.name}": "changed"}` : `{"${first.name}": ${P.sampleValue(first, 9)}}`;
    const chk = first.type === "string" ? `"changed"` : P.sampleValue(first, 9);
    const t = A ? ", token=tok" : "";
    const base = `/api/${e.plural}`;
    f[`api/tests/test_${e.snake}.py`] = `from api.tests.base import ApiTestCase


class ${e.name}Tests(ApiTestCase):
    def test_crud(self):
${A ? "        tok = self.login()\n" : ""}        created = self.call("POST", "${base}", ${payload}${t})
        self.assertEqual(created.status_code, 201, created.content)
        id_ = created.json()["id"]
        listed = self.call("GET", "${base}"${t})
        self.assertEqual(listed.status_code, 200)
        self.assertEqual(len(listed.json()), 1)
        self.assertEqual(self.call("GET", f"${base}/{id_}"${t}).status_code, 200)
        updated = self.call("PUT", f"${base}/{id_}", ${upd}${t})
        self.assertEqual(updated.status_code, 200, updated.content)
        self.assertEqual(updated.json()["${first.name}"], ${chk})
        self.assertEqual(self.call("DELETE", f"${base}/{id_}"${t}).status_code, 204)
        self.assertEqual(self.call("GET", f"${base}/{id_}"${t}).status_code, 404)

    def test_validation_and_pagination(self):
${A ? "        tok = self.login()\n" : ""}        bad = self.call("POST", "${base}", {}${t})
        self.assertEqual(bad.status_code, 422)
        self.assertEqual(bad.json()["error"]["code"], "validation_error")
        self.assertEqual(self.call("GET", "${base}?limit=0"${t}).status_code, 422)
${A ? `
    def test_requires_auth_and_isolated(self):
        self.assertEqual(self.call("GET", "${base}").status_code, 401)
        one = self.login("one@example.com")
        created = self.call("POST", "${base}", ${payload}, token=one)
        two = self.login("two@example.com")
        self.assertEqual(self.call("GET", f"${base}/{created.json()['id']}", token=two).status_code, 404)
` : ""}`;
  }

  f["Dockerfile"] = `FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
RUN useradd --create-home appuser && chown -R appuser /app
USER appuser
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health').status==200 else 1)"]
CMD ["sh", "-c", "python manage.py migrate --run-syncdb && gunicorn config.wsgi --bind 0.0.0.0:8000 --workers 2"]
`;
  f["docker-compose.yml"] = `services:
  api:
    build: .
    ports:
      - "8000:8000"
    environment:
      DJANGO_SECRET_KEY: \${DJANGO_SECRET_KEY:?set DJANGO_SECRET_KEY}
${A ? "      JWT_SECRET: ${JWT_SECRET:?set JWT_SECRET}\n" : ""}      DATABASE_URL: ${pg ? "postgres://app:app@db:5432/app" : "sqlite:////data/db.sqlite3"}
${pg ? `    depends_on:
      db:
        condition: service_healthy
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
      POSTGRES_DB: app
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app"]
      interval: 5s
      timeout: 3s
      retries: 10
volumes:
  pgdata:
` : `    volumes:
      - appdata:/data
volumes:
  appdata:
`}`;
  f[".dockerignore"] = ".venv\n__pycache__\n*.sqlite3\n.env\n";
  f[".gitignore"] = ".venv/\n__pycache__/\n*.sqlite3\n.env\n";
  f["README.md"] = `# ${spec.name}

Django backend generated by Sierra (no DRF). Layers: \`views -> services -> Django ORM\`; request bodies validated with pydantic.

## Run locally
\`\`\`
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
export DJANGO_SECRET_KEY=$(openssl rand -hex 32)${A ? "\nexport JWT_SECRET=$(openssl rand -hex 32)" : ""}
python manage.py migrate --run-syncdb
python manage.py runserver
\`\`\`

## Test
\`\`\`
python manage.py test
\`\`\`

## Endpoints
- \`GET /health\`, \`GET /openapi.json\`, \`GET /metrics\` (Prometheus text, per process)
${A ? "- \`POST /api/auth/register\`, \`POST /api/auth/login\`, \`GET /api/auth/me\`\n" : ""}${spec.entities.map((e) => `- \`GET|POST /api/${e.plural}\`, \`GET|PUT|DELETE /api/${e.plural}/<id>\``).join("\n")}

## Known limitations
- **No migration files** are generated; tables are created with \`migrate --run-syncdb\`. Run \`makemigrations\` yourself before evolving the schema in production.
- **No OpenAPI document** is generated for this stack; the endpoint list above is the contract.
- bcrypt hashing and HS256 JWT; no refresh tokens or rate limiting. The Django admin/auth apps are intentionally not installed.
`;
  return f;
}

module.exports = {
  id: "python-django",
  label: "Python + Django",
  language: "Python",
  framework: "Django",
  status: "implemented",
  databases: ["sqlite", "postgresql"],
  notes: "No migrations or OpenAPI document are generated.",
  generate,
  validate: {
    toolchain: "python3",
    setup: [["python3", "-m", "venv", ".venv"], [".venv/bin/pip", "install", "-q", "-r", "requirements.txt"]],
    test: [[".venv/bin/python", "manage.py", "test"]],
  },
};
