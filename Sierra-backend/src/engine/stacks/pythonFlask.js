/**
 * Flask generator. Shares the persistence layer (SQLAlchemy models, repositories, services,
 * pydantic schemas, security helpers) with the FastAPI stack; only the web layer is Flask-specific.
 * Limitation: Flask has no built-in OpenAPI document, so none is generated for this stack.
 */
const { parts: P, ...fastapi } = require("./pythonFastapi");
void fastapi;

const errorsPy = () => `import logging

from flask import Flask, jsonify
from werkzeug.exceptions import HTTPException

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


def _body(code: str, message: str, details=None) -> dict:
    return {"error": {"code": code, "message": message, "details": details}}


def register_error_handlers(app: Flask) -> None:
    @app.errorhandler(AppError)
    def app_error(exc: AppError):
        return jsonify(_body(exc.code, exc.message, exc.details)), exc.status_code

    @app.errorhandler(HTTPException)
    def http_error(exc: HTTPException):
        return jsonify(_body("http_error", exc.description or exc.name)), exc.code

    @app.errorhandler(Exception)
    def unhandled(exc: Exception):
        log.exception("unhandled error")
        return jsonify(_body("internal_error", "Internal server error")), 500
`;

const validationPy = () => `from flask import request
from pydantic import BaseModel, ValidationError

from app.core.errors import ValidationFailed


def parse_body(model: type[BaseModel]):
    """Validate the JSON body with pydantic; failures become the standard 422 error."""
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ValidationFailed([{"loc": ["body"], "msg": "JSON object required"}])
    try:
        return model.model_validate(data)
    except ValidationError as exc:
        raise ValidationFailed([{"loc": list(e["loc"]), "msg": e["msg"]} for e in exc.errors()])


def dump(model: type[BaseModel], obj) -> dict:
    return model.model_validate(obj, from_attributes=True).model_dump(mode="json")
`;

const sessionFlaskPy = () => P.sessionPy().replace(/\n\ndef get_db\(\):[\s\S]*$/, "\n");

const depsPy = () => `from functools import wraps

from flask import g, request

from app.core.errors import UnauthorizedError
from app.core.security import decode_access_token
from app.models.user import User


def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        header = request.headers.get("Authorization", "")
        if not header.startswith("Bearer ") or len(header) <= 7:
            raise UnauthorizedError()
        user_id = decode_access_token(header[7:])
        user = g.db.get(User, int(user_id))
        if user is None:
            raise UnauthorizedError()
        g.user = user
        return fn(*args, **kwargs)

    return wrapper
`;

const authRoutesPy = () => `from flask import Blueprint, g, jsonify

from app.api.deps import login_required
from app.core.validation import dump, parse_body
from app.schemas.auth import LoginRequest, RegisterRequest, UserRead
from app.services.auth_service import AuthService

bp = Blueprint("auth", __name__, url_prefix="/api/auth")


@bp.post("/register")
def register():
    user = AuthService(g.db).register(parse_body(RegisterRequest))
    return jsonify(dump(UserRead, user)), 201


@bp.post("/login")
def login():
    token = AuthService(g.db).login(parse_body(LoginRequest))
    return jsonify({"access_token": token, "token_type": "bearer"})


@bp.get("/me")
@login_required
def me():
    return jsonify(dump(UserRead, g.user))
`;

function entityRoutesPy(spec, e) {
  const A = spec.needsAuth;
  const o = A ? "g.user.id, " : "";
  const oLast = A ? ", g.user.id" : "";
  return `from flask import Blueprint, Response, g, jsonify, request

${A ? "from app.api.deps import login_required\n" : ""}from app.core.errors import ValidationFailed
from app.core.validation import dump, parse_body
from app.schemas.${e.snake} import ${e.name}Create, ${e.name}Read, ${e.name}Update
from app.services.${e.snake}_service import ${e.name}Service

bp = Blueprint("${e.snake}", __name__, url_prefix="/api/${e.plural}")


def _int_arg(name: str, default: int, lo: int, hi: int) -> int:
    raw = request.args.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        raise ValidationFailed([{"loc": ["query", name], "msg": "must be an integer"}])
    if not lo <= value <= hi:
        raise ValidationFailed([{"loc": ["query", name], "msg": f"must be between {lo} and {hi}"}])
    return value


@bp.get("")
${A ? "@login_required\n" : ""}def list_${e.snake}():
    items = ${e.name}Service(g.db).list(${o}_int_arg("limit", 50, 1, 200), _int_arg("offset", 0, 0, 10**9))
    return jsonify([dump(${e.name}Read, i) for i in items])


@bp.post("")
${A ? "@login_required\n" : ""}def create_${e.snake}():
    obj = ${e.name}Service(g.db).create(parse_body(${e.name}Create)${oLast})
    return jsonify(dump(${e.name}Read, obj)), 201


@bp.get("/<int:id>")
${A ? "@login_required\n" : ""}def get_${e.snake}(id: int):
    return jsonify(dump(${e.name}Read, ${e.name}Service(g.db).get(id${oLast})))


@bp.put("/<int:id>")
${A ? "@login_required\n" : ""}def update_${e.snake}(id: int):
    obj = ${e.name}Service(g.db).update(id, parse_body(${e.name}Update)${oLast})
    return jsonify(dump(${e.name}Read, obj))


@bp.delete("/<int:id>")
${A ? "@login_required\n" : ""}def delete_${e.snake}(id: int):
    ${e.name}Service(g.db).delete(id${oLast})
    return Response(status=204)
`;
}

function entityTestsPy(spec, e) {
  const A = spec.needsAuth;
  const req = e.fields.filter((f) => f.required || f.default === undefined);
  const payload = "{" + req.map((f) => `"${f.name}": ${P.sampleValue(f, 1)}`).join(", ") + "}";
  const first = e.fields.find((f) => f.required && f.type === "string") || e.fields[0];
  const upd = first.type === "string" ? `{"${first.name}": "changed"}` : `{"${first.name}": ${P.sampleValue(first, 9)}}`;
  const updCheck = first.type === "string" ? `"changed"` : P.sampleValue(first, 9);
  const H = A ? ", headers=auth_headers" : "";
  const fx = A ? "client, auth_headers" : "client";
  const base = `/api/${e.plural}`;
  return `def test_${e.snake}_crud(${fx}):
    created = client.post("${base}", json=${payload}${H})
    assert created.status_code == 201, created.get_data(as_text=True)
    id_ = created.get_json()["id"]

    listed = client.get("${base}"${A ? ", headers=auth_headers" : ""})
    assert listed.status_code == 200 and len(listed.get_json()) == 1
    assert client.get(f"${base}/{id_}"${H}).status_code == 200

    updated = client.put(f"${base}/{id_}", json=${upd}${H})
    assert updated.status_code == 200
    assert updated.get_json()["${first.name}"] == ${updCheck}

    assert client.delete(f"${base}/{id_}"${H}).status_code == 204
    assert client.get(f"${base}/{id_}"${H}).status_code == 404


def test_${e.snake}_validation(${fx}):
    r = client.post("${base}", json={}${H})
    assert r.status_code == 422
    assert r.get_json()["error"]["code"] == "validation_error"


def test_${e.snake}_bad_pagination(${fx}):
    assert client.get("${base}?limit=0"${H}).status_code == 422
${A ? `

def test_${e.snake}_requires_auth(client):
    assert client.get("${base}").status_code == 401


def test_${e.snake}_isolated_between_users(client, auth_headers):
    created = client.post("${base}", json=${payload}, headers=auth_headers)
    id_ = created.get_json()["id"]
    client.post("/api/auth/register", json={"email": "other@example.com", "password": "password123"})
    tok = client.post("/api/auth/login", json={"email": "other@example.com", "password": "password123"}).get_json()["access_token"]
    assert client.get(f"${base}/{id_}", headers={"Authorization": "Bearer " + tok}).status_code == 404
` : ""}`;
}

const authTestsPy = () => `def test_register_login_me(client):
    r = client.post("/api/auth/register", json={"email": "a@example.com", "name": "A", "password": "password123"})
    assert r.status_code == 201
    assert "password" not in r.get_data(as_text=True)
    t = client.post("/api/auth/login", json={"email": "a@example.com", "password": "password123"})
    assert t.status_code == 200
    me = client.get("/api/auth/me", headers={"Authorization": "Bearer " + t.get_json()["access_token"]})
    assert me.status_code == 200 and me.get_json()["email"] == "a@example.com"


def test_duplicate_register_rejected(client):
    body = {"email": "dup@example.com", "password": "password123"}
    assert client.post("/api/auth/register", json=body).status_code == 201
    assert client.post("/api/auth/register", json=body).status_code == 409


def test_bad_login_rejected(client):
    client.post("/api/auth/register", json={"email": "b@example.com", "password": "password123"})
    assert client.post("/api/auth/login", json={"email": "b@example.com", "password": "wrong-password"}).status_code == 401


def test_weak_password_rejected(client):
    r = client.post("/api/auth/register", json={"email": "c@example.com", "password": "short"})
    assert r.status_code == 422
    assert r.get_json()["error"]["code"] == "validation_error"


def test_invalid_token_rejected(client):
    assert client.get("/api/auth/me", headers={"Authorization": "Bearer not-a-token"}).status_code == 401
`;

const conftestPy = (spec) => `import os

os.environ["DATABASE_URL"] = "sqlite://"
os.environ.setdefault("JWT_SECRET", "test-secret-not-for-production-use-0123456789")

import pytest

from app.db.session import Base, engine
from app.main import create_app


@pytest.fixture()
def client():
    Base.metadata.drop_all(engine)
    app = create_app()
    app.config["TESTING"] = False  # keep real error handlers active
    with app.test_client() as c:
        yield c
${spec.needsAuth ? `

@pytest.fixture()
def auth_headers(client):
    client.post("/api/auth/register", json={"email": "user@example.com", "name": "User", "password": "password123"})
    token = client.post("/api/auth/login", json={"email": "user@example.com", "password": "password123"}).get_json()["access_token"]
    return {"Authorization": "Bearer " + token}
` : ""}`;

const mainPy = (spec) => `import json
import logging
from pathlib import Path

from flask import Flask, g, jsonify

from app.core.config import get_settings
from app.core.errors import register_error_handlers
from app.core.logging import configure_logging
from app.core.metrics import init_metrics
from app.db.session import Base, SessionLocal, engine
import app.models  # noqa: F401  (registers tables on Base.metadata)
${spec.needsAuth ? "from app.api import auth_routes\n" : ""}${spec.entities.map((e) => `from app.api import ${e.snake}_routes`).join("\n")}


def create_app() -> Flask:
    settings = get_settings()
    configure_logging(settings.log_level)
    app = Flask(settings.app_name)
    register_error_handlers(app)
    Base.metadata.create_all(engine)

    @app.before_request
    def open_session():
        g.db = SessionLocal()

    @app.teardown_request
    def close_session(_exc):
        db = g.pop("db", None)
        if db is not None:
            db.close()

    @app.get("/health")
    def health():
        return jsonify({"status": "ok"})

    openapi_doc = json.loads((Path(__file__).parent / "openapi.json").read_text())

    @app.get("/openapi.json")
    def openapi():
        return jsonify(openapi_doc)

    init_metrics(app)

${spec.needsAuth ? "    app.register_blueprint(auth_routes.bp)\n" : ""}${spec.entities.map((e) => `    app.register_blueprint(${e.snake}_routes.bp)`).join("\n")}
    logging.getLogger("app").info("startup complete")
    return app
`;

const { openApiJson } = require("../openapiDoc");

const metricsPy = () => `import threading
import time
from collections import defaultdict

from flask import Response, g, request

_lock = threading.Lock()
_count = defaultdict(int)
_seconds = defaultdict(float)


def _esc(v: str) -> str:
    return v.replace("\\\\", "\\\\\\\\").replace('"', '\\\\"')


def init_metrics(app):
    """In-process request counters in Prometheus text format. Counters are per worker process: with several
    gunicorn workers each scrape sees one worker, so use a multiprocess-aware client if you need exact totals."""

    @app.before_request
    def _start():
        g._t0 = time.perf_counter()

    @app.after_request
    def _record(resp):
        t0 = g.pop("_t0", None)
        route = request.url_rule.rule if request.url_rule else "unmatched"
        key = (request.method, route, str(resp.status_code))
        with _lock:
            _count[key] += 1
            if t0 is not None:
                _seconds[key] += time.perf_counter() - t0
        return resp

    @app.get("/metrics")
    def metrics():
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
        return Response("\\n".join(lines) + "\\n", mimetype="text/plain; version=0.0.4")
`;

const openapiTestPy = () => `import json
import re
from pathlib import Path


def _norm(path):
    return re.sub(r"<(?:[^:>]+:)?[^>]+>|\\{[^}]+\\}", "{}", path)


def test_openapi_served_and_matches_registered_routes(client):
    spec = client.get("/openapi.json").get_json()
    assert spec["openapi"].startswith("3.")
    assert json.loads((Path(__file__).parent.parent / "app" / "openapi.json").read_text()) == spec
    documented = {(_norm(p), m.upper()) for p, ops in spec["paths"].items() for m in ops}
    registered = {
        (_norm(r.rule), m)
        for r in client.application.url_map.iter_rules()
        if r.rule.startswith("/api/")
        for m in r.methods - {"HEAD", "OPTIONS"}
    }
    api_documented = {d for d in documented if d[0].startswith("/api/")}
    assert registered == api_documented


def test_metrics_counts_requests_by_route_template(client):
    client.get("/health")
    client.get("/definitely-missing")
    text = client.get("/metrics").get_data(as_text=True)
    assert 'http_requests_total{method="GET",route="/health",status="200"}' in text
    assert 'route="unmatched",status="404"' in text
`;

function generate(spec) {
  const f = {};
  f["requirements.txt"] = [
    "flask>=3.0,<4", "gunicorn>=22", "sqlalchemy>=2.0,<3", "pydantic>=2.6,<3",
    ...(spec.needsAuth ? ["pyjwt>=2.8,<3", "bcrypt>=4.1"] : []),
    ...(spec.database === "postgresql" ? ["psycopg2-binary>=2.9"] : []),
    "# test", "pytest>=8",
  ].join("\n") + "\n";
  f[".env.example"] = P.envExample(spec);
  f["Dockerfile"] = `FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
RUN useradd --create-home appuser && chown -R appuser /app
USER appuser
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health').status==200 else 1)"]
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "--workers", "2", "app.main:create_app()"]
`;
  f["docker-compose.yml"] = P.compose(spec);
  f[".dockerignore"] = ".venv\n__pycache__\n.pytest_cache\n*.db\n.env\n";
  f[".gitignore"] = ".venv/\n__pycache__/\n.pytest_cache/\n*.db\n.env\n";
  f["pytest.ini"] = "[pytest]\ntestpaths = tests\n";
  f["README.md"] = `# ${spec.name}

Flask backend generated by Sierra. Layers: \`blueprints -> services -> repositories -> SQLAlchemy models\`, request bodies validated with pydantic.

## Run locally
\`\`\`
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # then export the variables
flask --app "app.main:create_app" run --port 8000
\`\`\`

## Test
\`\`\`
pytest -q
\`\`\`

## Endpoints
- \`GET /health\`, \`GET /openapi.json\`, \`GET /metrics\` (Prometheus text, per process)
${spec.needsAuth ? "- \`POST /api/auth/register\`, \`POST /api/auth/login\`, \`GET /api/auth/me\`\n" : ""}${spec.entities.map((e) => `- \`GET|POST /api/${e.plural}\`, \`GET|PUT|DELETE /api/${e.plural}/<id>\``).join("\n")}

## Known limitations
- **No OpenAPI/Swagger document** is generated for Flask; the endpoint list above is the contract.
- Tables are created at startup with \`create_all\`; use Alembic migrations before using a real production database.
- bcrypt password hashing and HS256 JWT; no refresh tokens or rate limiting.
`;
  for (const p of ["app", "app/core", "app/db", "app/models", "app/schemas", "app/repositories", "app/services", "app/api", "tests"]) f[`${p}/__init__.py`] = "";
  f["app/main.py"] = mainPy(spec);
  f["app/core/config.py"] = P.configPy(spec);
  f["app/core/logging.py"] = P.loggingPy();
  f["app/core/metrics.py"] = metricsPy();
  f["app/openapi.json"] = openApiJson(spec);
  f["tests/test_openapi_metrics.py"] = openapiTestPy();
  f["app/core/errors.py"] = errorsPy();
  f["app/core/validation.py"] = validationPy();
  f["app/db/session.py"] = sessionFlaskPy();
  f["app/repositories/base.py"] = P.repoBasePy();
  f["tests/conftest.py"] = conftestPy(spec);
  f["tests/test_health.py"] = `def test_health(client):\n    r = client.get("/health")\n    assert r.status_code == 200\n    assert r.get_json() == {"status": "ok"}\n\n\ndef test_unknown_route_is_json(client):\n    r = client.get("/nope")\n    assert r.status_code == 404\n    assert r.get_json()["error"]["code"] == "http_error"\n`;
  const modelImports = [];
  if (spec.needsAuth) {
    f["app/core/security.py"] = P.securityPy();
    f["app/models/user.py"] = P.userModelPy();
    modelImports.push("from app.models.user import User  # noqa: F401");
    // schemas + service are framework-neutral and shared with the FastAPI stack
    const fa = require("./pythonFastapi").generate({ ...spec, entities: [], needsAuth: true, database: spec.database });
    f["app/schemas/auth.py"] = fa["app/schemas/auth.py"];
    f["app/services/auth_service.py"] = fa["app/services/auth_service.py"];
    f["app/api/deps.py"] = depsPy();
    f["app/api/auth_routes.py"] = authRoutesPy();
    f["tests/test_auth.py"] = authTestsPy();
  }
  for (const e of spec.entities) {
    f[`app/models/${e.snake}.py`] = P.entityModelPy(spec, e);
    f[`app/schemas/${e.snake}.py`] = P.entitySchemasPy(spec, e);
    f[`app/services/${e.snake}_service.py`] = P.entityServicePy(spec, e);
    f[`app/api/${e.snake}_routes.py`] = entityRoutesPy(spec, e);
    f[`tests/test_${e.snake}.py`] = entityTestsPy(spec, e);
    modelImports.push(`from app.models.${e.snake} import ${e.name}  # noqa: F401`);
  }
  f["app/models/__init__.py"] = modelImports.join("\n") + "\n";
  return f;
}

module.exports = {
  id: "python-flask",
  label: "Python + Flask",
  language: "Python",
  framework: "Flask",
  status: "implemented",
  databases: ["sqlite", "postgresql"],
  notes: "No OpenAPI document is generated for Flask.",
  generate,
  validate: {
    toolchain: "python3",
    setup: [["python3", "-m", "venv", ".venv"], [".venv/bin/pip", "install", "-q", "-r", "requirements.txt"]],
    test: [[".venv/bin/python", "-m", "pytest", "-q"]],
  },
};
