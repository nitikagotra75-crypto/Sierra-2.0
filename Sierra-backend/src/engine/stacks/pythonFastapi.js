/**
 * FastAPI generator. Layered: routes -> services -> repositories -> SQLAlchemy models.
 * Output is plain files; nothing here executes anything.
 */
const PY = {
  string: { py: "str", col: "String(255)", imp: "String" },
  text: { py: "str", col: "Text", imp: "Text" },
  int: { py: "int", col: "Integer", imp: "Integer" },
  float: { py: "float", col: "Float", imp: "Float" },
  bool: { py: "bool", col: "Boolean", imp: "Boolean" },
  enum: { py: "str", col: "String(32)", imp: "String" },
};

const pyLit = (v) => (typeof v === "boolean" ? (v ? "True" : "False") : JSON.stringify(v));
const pyType = (f) => (f.type === "enum" ? `Literal[${f.values.map((v) => JSON.stringify(v)).join(", ")}]` : PY[f.type].py);
const sampleValue = (f, n = 1) => {
  switch (f.type) {
    case "string": case "text": return `"${f.name} ${n}"`;
    case "int": return String(n);
    case "float": return `${n}.5`;
    case "bool": return "True";
    case "enum": return JSON.stringify(f.values[0]);
  }
};

function requirements(spec) {
  return [
    "fastapi>=0.110,<1",
    "uvicorn[standard]>=0.29",
    "sqlalchemy>=2.0,<3",
    "pydantic>=2.6,<3",
    ...(spec.needsAuth ? ["pyjwt>=2.8,<3", "bcrypt>=4.1"] : []),
    ...(spec.database === "postgresql" ? ["psycopg2-binary>=2.9"] : []),
    // cryptography: MySQL 8's default caching_sha2_password handshake needs it
    ...(spec.database === "mysql" ? ["PyMySQL>=1.1,<2", "cryptography>=42"] : []),
    ...(spec.features && spec.features.cache ? ["redis>=5"] : []),
    ...(spec.features && spec.features.events === "kafka" ? ["kafka-python>=2.0.2"] : []),
    ...(spec.features && spec.features.events === "rabbitmq" ? ["pika>=1.3"] : []),
    "# test",
    "pytest>=8",
    "httpx>=0.27",
    ...(spec.features && spec.features.cache ? ["fakeredis>=2.20"] : []),
  ].join("\n") + "\n";
}

function envExample(spec) {
  return [
    "APP_NAME=" + spec.name,
    "LOG_LEVEL=INFO",
    spec.database === "postgresql"
      ? "DATABASE_URL=postgresql+psycopg2://app:app@localhost:5432/app"
      : spec.database === "mysql"
        ? "DATABASE_URL=mysql+pymysql://app:app@localhost:3306/app?charset=utf8mb4"
        : "DATABASE_URL=sqlite:///./app.db",
    ...(spec.needsAuth ? ["JWT_SECRET=changeme_use_a_long_random_secret", "JWT_EXPIRE_MINUTES=60"] : []),
    ...(spec.features && spec.features.cache ? ["REDIS_URL=redis://localhost:6379/0", "CACHE_TTL_SECONDS=300"] : []),
    ...(spec.features && spec.features.events === "kafka" ? ["KAFKA_BROKERS=localhost:9092", "EVENT_TOPIC=domain-events"] : []),
    ...(spec.features && spec.features.events === "rabbitmq" ? ["AMQP_URL=amqp://app:app@localhost:5672/", "EVENT_QUEUE=domain-events"] : []),
  ].join("\n") + "\n";
}

function dockerfile() {
  return `FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
RUN useradd --create-home appuser && chown -R appuser /app
USER appuser
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health').status==200 else 1)"]
CMD ["uvicorn", "app.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
`;
}

function compose(spec) {
  const my = spec.database === "mysql";
  const pg = spec.database === "postgresql" || my; // both run a separate "db" service
  const f = spec.features || {};
  const dbUrl = my ? "mysql+pymysql://app:app@db:3306/app?charset=utf8mb4" : pg ? "postgresql+psycopg2://app:app@db:5432/app" : "sqlite:////data/app.db";
  const brokerEnv = f.events === "kafka" ? "      KAFKA_BROKERS: kafka:9092\n" : f.events === "rabbitmq" ? "      AMQP_URL: amqp://app:app@rabbitmq:5672/\n" : "";
  const sharedEnv = `      DATABASE_URL: ${dbUrl}\n${spec.needsAuth ? "      JWT_SECRET: ${JWT_SECRET:?set JWT_SECRET in your shell or .env}\n" : ""}${f.cache ? "      REDIS_URL: redis://cache:6379/0\n" : ""}${brokerEnv}`;
  const deps = [pg ? "      db:\n        condition: service_healthy\n" : "", f.cache ? "      cache:\n        condition: service_healthy\n" : ""].join("");
  const sqliteVol = pg ? "" : "    volumes:\n      - appdata:/data\n";
  let y = "services:\n";
  y += `  api:\n    build: .\n    ports:\n      - "8000:8000"\n    environment:\n      LOG_LEVEL: INFO\n${sharedEnv}${deps ? "    depends_on:\n" + deps : ""}${sqliteVol}`;
  if (f.events) {
    y += `  worker:\n    build: .\n    command: ["python", "-m", "app.worker"]\n    environment:\n      LOG_LEVEL: INFO\n${sharedEnv}    depends_on:\n      - ${f.events === "kafka" ? "kafka" : "rabbitmq"}\n${sqliteVol}`;
  }
  if (my) y += `  db:\n    image: mysql:8\n    environment:\n      MYSQL_ROOT_PASSWORD: app\n      MYSQL_DATABASE: app\n      MYSQL_USER: app\n      MYSQL_PASSWORD: app\n    volumes:\n      - pgdata:/var/lib/mysql\n    healthcheck:\n      test: ["CMD-SHELL", "mysqladmin ping -h 127.0.0.1 -uroot -papp"]\n      interval: 5s\n      timeout: 5s\n      retries: 30\n`;
  else if (pg) y += `  db:\n    image: postgres:16-alpine\n    environment:\n      POSTGRES_USER: app\n      POSTGRES_PASSWORD: app\n      POSTGRES_DB: app\n    volumes:\n      - pgdata:/var/lib/postgresql/data\n    healthcheck:\n      test: ["CMD-SHELL", "pg_isready -U app"]\n      interval: 5s\n      timeout: 3s\n      retries: 10\n`;
  if (f.cache) y += `  cache:\n    image: redis:7-alpine\n    command: ["redis-server", "--maxmemory", "128mb", "--maxmemory-policy", "allkeys-lru"]\n    healthcheck:\n      test: ["CMD", "redis-cli", "ping"]\n      interval: 5s\n      timeout: 3s\n      retries: 10\n`;
  if (f.events === "kafka") y += `  kafka:\n    image: apache/kafka:3.8.0\n    environment:\n      KAFKA_NODE_ID: 1\n      KAFKA_PROCESS_ROLES: broker,controller\n      KAFKA_LISTENERS: PLAINTEXT://:9092,CONTROLLER://:9093\n      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:9092\n      KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER\n      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT\n      KAFKA_CONTROLLER_QUORUM_VOTERS: 1@kafka:9093\n      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1\n`;
  if (f.events === "rabbitmq") y += `  rabbitmq:\n    image: rabbitmq:3.13-alpine\n    environment:\n      RABBITMQ_DEFAULT_USER: app\n      RABBITMQ_DEFAULT_PASS: app\n    healthcheck:\n      test: ["CMD", "rabbitmq-diagnostics", "-q", "ping"]\n      interval: 10s\n      timeout: 5s\n      retries: 10\n`;
  y += `volumes:\n${pg ? "  pgdata:\n" : "  appdata:\n"}`;
  return y;
}

function readme(spec) {
  return `# ${spec.name}

FastAPI backend generated by Sierra. Layers: \`routes -> services -> repositories -> SQLAlchemy models\`.

## Run locally
\`\`\`
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # then export the variables (or use your process manager)
uvicorn app.main:create_app --factory --reload
\`\`\`
Interactive OpenAPI docs: http://localhost:8000/docs

## Test
\`\`\`
pytest -q
\`\`\`

## Docker
\`\`\`
${spec.needsAuth ? "export JWT_SECRET=$(openssl rand -hex 32)\n" : ""}docker compose up --build
\`\`\`

## Endpoints
- \`GET /health\`, \`GET /metrics\` (Prometheus text, per process)
${spec.needsAuth ? "- \`POST /api/auth/register\`, \`POST /api/auth/login\`, \`GET /api/auth/me\`\n" : ""}${spec.entities.map((e) => `- \`GET|POST /api/${e.plural}\`, \`GET|PUT|DELETE /api/${e.plural}/{id}\``).join("\n")}

${spec.features && spec.features.cache ? "## Redis cache\n`GET /api/<entity>/{id}` is cache-aside (TTL `CACHE_TTL_SECONDS`, default 300). Updates and deletes invalidate the key. Without `REDIS_URL` a per-process in-memory cache is used; with it, Redis is shared by all instances. If Redis is down requests fall back to the database. List endpoints are not cached.\n\n" : ""}${spec.features && spec.features.events ? `## Events (${spec.features.events})\nEach create/update/delete publishes \`<entity>.created|updated|deleted\` (JSON with id, type, ts, data). Publishing is best effort: a broker outage is logged and never fails the request, so events can be lost (no transactional outbox). Run the consumer with \`python -m app.worker\`; failed messages are retried with backoff and then dead-lettered. Delivery is at-least-once, so \`handle_event\` in \`app/worker.py\` (a logging placeholder) must be idempotent.\n\n` : ""}## Known limitations
- Tables are created at startup with \`create_all\`. Use Alembic migrations before running this against a real production database.
${spec.features && spec.features.events ? (spec.features.events === "rabbitmq" ? "- The RabbitMQ publisher/worker are covered by tests/test_events_rabbitmq_real.py (real broker via AMQP_URL; skipped with a reason when none is reachable).\n" : "- The Kafka client code is unit-tested with fakes only; it has not been run against a real broker.\n") : ""}
- Passwords are hashed with bcrypt; JWTs are HS256 signed with \`JWT_SECRET\`. No refresh tokens or rate limiting are included.
`;
}

const configPy = (spec) => `import os
from dataclasses import dataclass
from functools import lru_cache


@dataclass(frozen=True)
class Settings:
    app_name: str
    database_url: str
    log_level: str
    jwt_secret: str
    jwt_expire_minutes: int
    redis_url: str
    cache_ttl: int


@lru_cache
def get_settings() -> Settings:
    jwt_secret = os.environ.get("JWT_SECRET", "")
    ${spec.needsAuth ? `if not jwt_secret:
        raise RuntimeError("JWT_SECRET must be set")` : "pass"}
    return Settings(
        app_name=os.environ.get("APP_NAME", ${JSON.stringify(spec.name)}),
        database_url=os.environ.get("DATABASE_URL", "sqlite:///./app.db"),
        log_level=os.environ.get("LOG_LEVEL", "INFO"),
        jwt_secret=jwt_secret,
        jwt_expire_minutes=int(os.environ.get("JWT_EXPIRE_MINUTES", "60")),
        redis_url=os.environ.get("REDIS_URL", ""),
        cache_ttl=int(os.environ.get("CACHE_TTL_SECONDS", "300")),
    )
`;

const loggingPy = () => `import json
import logging
import sys
from datetime import datetime, timezone


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload)


def configure_logging(level: str) -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level.upper())
`;

const errorsPy = () => `import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

log = logging.getLogger("app.errors")


class AppError(Exception):
    def __init__(self, status_code: int, code: str, message: str):
        self.status_code = status_code
        self.code = code
        self.message = message


class NotFoundError(AppError):
    def __init__(self, what: str):
        super().__init__(404, "not_found", f"{what} not found")


class ConflictError(AppError):
    def __init__(self, message: str):
        super().__init__(409, "conflict", message)


class UnauthorizedError(AppError):
    def __init__(self, message: str = "Invalid or missing credentials"):
        super().__init__(401, "unauthorized", message)


def _body(code: str, message: str, details=None) -> dict:
    return {"error": {"code": code, "message": message, "details": details}}


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def app_error(_: Request, exc: AppError):
        return JSONResponse(status_code=exc.status_code, content=_body(exc.code, exc.message))

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError):
        details = [{"loc": list(e["loc"]), "msg": e["msg"]} for e in exc.errors()]
        return JSONResponse(status_code=422, content=_body("validation_error", "Request validation failed", details))

    @app.exception_handler(Exception)
    async def unhandled(_: Request, exc: Exception):
        log.exception("unhandled error")
        return JSONResponse(status_code=500, content=_body("internal_error", "Internal server error"))
`;

const securityPy = () => `from datetime import datetime, timedelta, timezone

import bcrypt
import jwt

from app.core.config import get_settings
from app.core.errors import UnauthorizedError


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), hashed.encode("utf-8"))
    except ValueError:
        return False


def create_access_token(subject: str) -> str:
    s = get_settings()
    exp = datetime.now(timezone.utc) + timedelta(minutes=s.jwt_expire_minutes)
    return jwt.encode({"sub": subject, "exp": exp}, s.jwt_secret, algorithm="HS256")


def decode_access_token(token: str) -> str:
    try:
        payload = jwt.decode(token, get_settings().jwt_secret, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise UnauthorizedError()
    return payload["sub"]
`;

const sessionPy = () => `from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.config import get_settings


class Base(DeclarativeBase):
    pass


def _make_engine(url: str):
    if url.startswith("sqlite"):
        kwargs = {"connect_args": {"check_same_thread": False}}
        if url in ("sqlite://", "sqlite:///:memory:"):
            kwargs["poolclass"] = StaticPool
        return create_engine(url, **kwargs)
    return create_engine(url, pool_pre_ping=True)


engine = _make_engine(get_settings().database_url)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
`;

const userModelPy = () => `from datetime import datetime, timezone

from sqlalchemy import DateTime, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(255), default="")
    password_hash: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
`;

function entityModelPy(spec, e) {
  const imps = new Set(["DateTime"]);
  e.fields.forEach((f) => imps.add(PY[f.type].imp));
  if (spec.needsAuth) imps.add("ForeignKey");
  const cols = e.fields.map((f) => {
    const t = PY[f.type];
    const hasDefault = f.default !== undefined;
    const opt = !f.required && !hasDefault;
    const ann = opt ? `Optional[${t.py}]` : t.py;
    const args = [t.col];
    if (hasDefault) args.push(`default=${pyLit(f.default)}`);
    if (opt) args.push("nullable=True");
    return `    ${f.name}: Mapped[${ann}] = mapped_column(${args.join(", ")})`;
  });
  return `from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import ${[...imps].sort().join(", ")}
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class ${e.name}(Base):
    __tablename__ = "${e.plural.replace(/-/g, "_")}"

    id: Mapped[int] = mapped_column(primary_key=True)
${cols.join("\n")}
${spec.needsAuth ? `    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)\n` : ""}    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
`;
}

function entitySchemasPy(spec, e) {
  const create = e.fields.map((f) => {
    const t = pyType(f);
    if (f.required && f.default === undefined) return `    ${f.name}: ${t}`;
    if (f.default !== undefined) return `    ${f.name}: ${t} = ${pyLit(f.default)}`;
    return `    ${f.name}: Optional[${t}] = None`;
  });
  const checks = e.fields.filter((f) => f.type === "string" && f.required).map((f) => f.name);
  const update = e.fields.map((f) => `    ${f.name}: Optional[${pyType(f)}] = None`);
  const read = e.fields.map((f) => {
    const opt = !f.required && f.default === undefined;
    return `    ${f.name}: ${opt ? `Optional[${pyType(f)}]` : pyType(f)}`;
  });
  return `from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, field_validator


class ${e.name}Create(BaseModel):
${create.join("\n")}
${checks.length ? `
    @field_validator(${checks.map((c) => JSON.stringify(c)).join(", ")})
    @classmethod
    def not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("must not be blank")
        return v
` : ""}

class ${e.name}Update(BaseModel):
${update.join("\n")}


class ${e.name}Read(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
${read.join("\n")}
${spec.needsAuth ? "    owner_id: int\n" : ""}    created_at: datetime
`;
}

const repoBasePy = () => `from typing import Generic, Optional, Sequence, Type, TypeVar

from sqlalchemy import select
from sqlalchemy.orm import Session

T = TypeVar("T")


class Repository(Generic[T]):
    """Persistence boundary. Services never touch the Session directly."""

    def __init__(self, db: Session, model: Type[T]):
        self.db = db
        self.model = model

    def list(self, limit: int = 50, offset: int = 0, **filters) -> Sequence[T]:
        stmt = select(self.model).filter_by(**filters).order_by(self.model.id.desc()).limit(limit).offset(offset)
        return self.db.scalars(stmt).all()

    def get(self, id: int, **filters) -> Optional[T]:
        return self.db.scalars(select(self.model).filter_by(id=id, **filters)).first()

    def add(self, obj: T) -> T:
        self.db.add(obj)
        self.db.commit()
        self.db.refresh(obj)
        return obj

    def update(self, obj: T, data: dict) -> T:
        for k, v in data.items():
            setattr(obj, k, v)
        self.db.commit()
        self.db.refresh(obj)
        return obj

    def delete(self, obj: T) -> None:
        self.db.delete(obj)
        self.db.commit()
`;

function entityServicePy(spec, e) {
  const A = spec.needsAuth;
  const F = spec.features || {};
  const C = !!F.cache, E = !!F.events;
  const tbl = e.plural.replace(/-/g, "_");
  const own = A ? ", owner_id=owner_id" : "";
  const ownArg = A ? ", owner_id: int" : "";
  const ownPass = A ? ", owner_id" : "";
  return `${C || E ? "import json\nimport logging\n\n" : ""}from sqlalchemy.orm import Session

${C ? "from app.core.cache import get_cache, ttl_seconds\n" : ""}${E ? "from app.core import events\n" : ""}from app.core.errors import NotFoundError
from app.models.${e.snake} import ${e.name}
from app.repositories.base import Repository
from app.schemas.${e.snake} import ${e.name}Create, ${e.name}Read, ${e.name}Update
${C || E ? `
log = logging.getLogger("app.${e.snake}")
` : ""}

class ${e.name}Service:
    def __init__(self, db: Session):
        self.repo = Repository(db, ${e.name})

    def list(self, ${A ? "owner_id: int, " : ""}limit: int = 50, offset: int = 0):
        return self.repo.list(limit=limit, offset=offset${own})

    def get(self, id: int${ownArg}):
        obj = self.repo.get(id${own})
        if obj is None:
            raise NotFoundError("${e.name}")
        return obj
${C ? `
    @staticmethod
    def _key(id: int${ownArg}) -> str:
        return f"${tbl}:${A ? "{owner_id}" : "all"}:{id}"

    def get_read(self, id: int${ownArg}) -> dict:
        """Cache-aside read: cache first, database on a miss, then populate with a TTL."""
        key = self._key(id${ownPass})
        hit = get_cache().get(key)
        if hit is not None:
            return json.loads(hit)
        data = self._read(self.get(id${ownPass}))
        get_cache().set(key, json.dumps(data), ttl_seconds())
        return data
` : ""}${C || E ? `
    @staticmethod
    def _read(obj) -> dict:
        return ${e.name}Read.model_validate(obj, from_attributes=True).model_dump(mode="json")
` : ""}${E ? `
    def _emit(self, kind: str, data: dict) -> None:
        """Best effort: a broker problem is logged and never fails the request."""
        try:
            events.get_publisher().publish(events.make_event(f"${e.lower}.{kind}", data))
        except Exception:
            log.exception("could not publish ${e.lower}.%s", kind)
` : ""}
    def create(self, data: ${e.name}Create${ownArg}):
        obj = self.repo.add(${e.name}(**data.model_dump()${own}))
${E ? `        self._emit("created", self._read(obj))
` : ""}        return obj

    def update(self, id: int, data: ${e.name}Update${ownArg}):
        obj = self.get(id${ownPass})
        updated = self.repo.update(obj, data.model_dump(exclude_unset=True))
${C ? `        get_cache().delete(self._key(id${ownPass}))  # invalidate on write
` : ""}${E ? `        self._emit("updated", self._read(updated))
` : ""}        return updated

    def delete(self, id: int${ownArg}) -> None:
        obj = self.get(id${ownPass})
${E ? `        snapshot = self._read(obj)
` : ""}        self.repo.delete(obj)
${C ? `        get_cache().delete(self._key(id${ownPass}))
` : ""}${E ? `        self._emit("deleted", snapshot)
` : ""}`;
}

function entityRoutesPy(spec, e) {
  const A = spec.needsAuth;
  const u = A ? ", user: User = Depends(get_current_user)" : "";
  const o = A ? ", user.id" : "";
  return `from typing import List

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from app.db.session import get_db
${A ? "from app.api.deps import get_current_user\nfrom app.models.user import User\n" : ""}from app.schemas.${e.snake} import ${e.name}Create, ${e.name}Read, ${e.name}Update
from app.services.${e.snake}_service import ${e.name}Service

router = APIRouter(prefix="/api/${e.plural}", tags=["${e.plural}"])


@router.get("", response_model=List[${e.name}Read])
def list_${e.snake}(limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0), db: Session = Depends(get_db)${u}):
    return ${e.name}Service(db).list(${A ? "user.id, " : ""}limit, offset)


@router.post("", response_model=${e.name}Read, status_code=201)
def create_${e.snake}(data: ${e.name}Create, db: Session = Depends(get_db)${u}):
    return ${e.name}Service(db).create(data${o})


@router.get("/{id}", response_model=${e.name}Read)
def get_${e.snake}(id: int, db: Session = Depends(get_db)${u}):
    return ${e.name}Service(db).${spec.features && spec.features.cache ? "get_read" : "get"}(id${o})


@router.put("/{id}", response_model=${e.name}Read)
def update_${e.snake}(id: int, data: ${e.name}Update, db: Session = Depends(get_db)${u}):
    return ${e.name}Service(db).update(id, data${o})


@router.delete("/{id}", status_code=204)
def delete_${e.snake}(id: int, db: Session = Depends(get_db)${u}):
    ${e.name}Service(db).delete(id${o})
    return Response(status_code=204)
`;
}

const authFiles = () => ({
  "app/schemas/auth.py": `from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

EMAIL_PATTERN = r"^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$"


class RegisterRequest(BaseModel):
    email: str = Field(pattern=EMAIL_PATTERN, max_length=255)
    name: str = Field(default="", max_length=255)
    password: str = Field(min_length=8, max_length=72)


class LoginRequest(BaseModel):
    email: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class UserRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    email: str
    name: str
    created_at: datetime
`,
  "app/services/auth_service.py": `from sqlalchemy.orm import Session

from app.core.errors import ConflictError, UnauthorizedError
from app.core.security import create_access_token, hash_password, verify_password
from app.models.user import User
from app.repositories.base import Repository
from app.schemas.auth import LoginRequest, RegisterRequest


class AuthService:
    def __init__(self, db: Session):
        self.repo = Repository(db, User)
        self.db = db

    def _by_email(self, email: str):
        return self.db.query(User).filter(User.email == email.lower()).first()

    def register(self, data: RegisterRequest) -> User:
        if self._by_email(data.email):
            raise ConflictError("Email already registered")
        return self.repo.add(User(email=data.email.lower(), name=data.name, password_hash=hash_password(data.password)))

    def login(self, data: LoginRequest) -> str:
        user = self._by_email(data.email)
        if user is None or not verify_password(data.password, user.password_hash):
            raise UnauthorizedError("Invalid email or password")
        return create_access_token(str(user.id))
`,
  "app/api/deps.py": `from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.core.errors import UnauthorizedError
from app.core.security import decode_access_token
from app.db.session import get_db
from app.models.user import User

bearer = HTTPBearer(auto_error=False)


def get_current_user(creds: HTTPAuthorizationCredentials = Depends(bearer), db: Session = Depends(get_db)) -> User:
    if creds is None:
        raise UnauthorizedError()
    user_id = decode_access_token(creds.credentials)
    user = db.get(User, int(user_id))
    if user is None:
        raise UnauthorizedError()
    return user
`,
  "app/api/auth_routes.py": `from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models.user import User
from app.schemas.auth import LoginRequest, RegisterRequest, TokenResponse, UserRead
from app.services.auth_service import AuthService

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/register", response_model=UserRead, status_code=201)
def register(data: RegisterRequest, db: Session = Depends(get_db)):
    return AuthService(db).register(data)


@router.post("/login", response_model=TokenResponse)
def login(data: LoginRequest, db: Session = Depends(get_db)):
    return TokenResponse(access_token=AuthService(db).login(data))


@router.get("/me", response_model=UserRead)
def me(user: User = Depends(get_current_user)):
    return user
`,
  "tests/test_auth.py": `def test_register_login_me(client):
    r = client.post("/api/auth/register", json={"email": "a@example.com", "name": "A", "password": "password123"})
    assert r.status_code == 201
    assert "password" not in r.text
    t = client.post("/api/auth/login", json={"email": "a@example.com", "password": "password123"})
    assert t.status_code == 200
    me = client.get("/api/auth/me", headers={"Authorization": "Bearer " + t.json()["access_token"]})
    assert me.status_code == 200 and me.json()["email"] == "a@example.com"


def test_duplicate_register_rejected(client):
    body = {"email": "dup@example.com", "password": "password123"}
    assert client.post("/api/auth/register", json=body).status_code == 201
    assert client.post("/api/auth/register", json=body).status_code == 409


def test_bad_login_rejected(client):
    client.post("/api/auth/register", json={"email": "b@example.com", "password": "password123"})
    r = client.post("/api/auth/login", json={"email": "b@example.com", "password": "wrong-password"})
    assert r.status_code == 401


def test_weak_password_rejected(client):
    r = client.post("/api/auth/register", json={"email": "c@example.com", "password": "short"})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "validation_error"


def test_invalid_token_rejected(client):
    assert client.get("/api/auth/me", headers={"Authorization": "Bearer not-a-token"}).status_code == 401
`,
});

function entityTestsPy(spec, e) {
  const A = spec.needsAuth;
  const payload = (n) => "{" + e.fields.filter((f) => f.required || f.default === undefined).map((f) => `"${f.name}": ${sampleValue(f, n)}`).join(", ") + "}";
  const first = e.fields.find((f) => f.required && f.type === "string") || e.fields[0];
  const upd = first.type === "string" ? `{"${first.name}": "changed"}` : `{"${first.name}": ${sampleValue(first, 9)}}`;
  const updCheck = first.type === "string" ? `"changed"` : sampleValue(first, 9);
  const H = A ? ", headers=auth_headers" : "";
  const fx = A ? "client, auth_headers" : "client";
  const base = `/api/${e.plural}`;
  return `def test_${e.snake}_crud(${fx}):
    created = client.post("${base}", json=${payload(1)}${H})
    assert created.status_code == 201, created.text
    id_ = created.json()["id"]

    assert client.get("${base}", headers=${A ? "auth_headers" : "{}"}).status_code == 200
    assert len(client.get("${base}"${H}).json()) == 1
    assert client.get(f"${base}/{id_}"${H}).status_code == 200

    updated = client.put(f"${base}/{id_}", json=${upd}${H})
    assert updated.status_code == 200
    assert updated.json()["${first.name}"] == ${updCheck}

    assert client.delete(f"${base}/{id_}"${H}).status_code == 204
    assert client.get(f"${base}/{id_}"${H}).status_code == 404


def test_${e.snake}_validation(${fx}):
    r = client.post("${base}", json={}${H})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "validation_error"
${A ? `

def test_${e.snake}_requires_auth(client):
    assert client.get("${base}").status_code == 401


def test_${e.snake}_isolated_between_users(client, auth_headers):
    created = client.post("${base}", json=${payload(1)}, headers=auth_headers)
    id_ = created.json()["id"]
    client.post("/api/auth/register", json={"email": "other@example.com", "password": "password123"})
    tok = client.post("/api/auth/login", json={"email": "other@example.com", "password": "password123"}).json()["access_token"]
    other = {"Authorization": "Bearer " + tok}
    assert client.get(f"${base}/{id_}", headers=other).status_code == 404
` : ""}`;
}

const conftestPy = (spec) => `import os

${spec.database === "mysql" ? `# The whole suite runs against a REAL MySQL (TEST_DB_URL, e.g. mysql+pymysql://app:app@127.0.0.1:3306/app); without one it
# is skipped, never run against SQLite and reported as a MySQL pass.
os.environ["DATABASE_URL"] = os.environ.get("TEST_DB_URL", "sqlite://")
_NO_DB = "TEST_DB_URL" not in os.environ
` : `os.environ["DATABASE_URL"] = "sqlite://"
`}os.environ.setdefault("JWT_SECRET", "test-secret-not-for-production-use-0123456789")

import pytest
from fastapi.testclient import TestClient

from app.db.session import Base, engine
from app.main import create_app


@pytest.fixture()
def client():
${spec.database === "mysql" ? `    if _NO_DB:
        pytest.skip("TEST_DB_URL is not set: the MySQL path was NOT exercised")
` : ""}    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    with TestClient(create_app()) as c:
        yield c
${spec.needsAuth ? `

@pytest.fixture()
def auth_headers(client):
    client.post("/api/auth/register", json={"email": "user@example.com", "name": "User", "password": "password123"})
    token = client.post("/api/auth/login", json={"email": "user@example.com", "password": "password123"}).json()["access_token"]
    return {"Authorization": "Bearer " + token}
` : ""}`;

const mainPy = (spec) => `import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.core.config import get_settings
from app.core.errors import register_error_handlers
from app.core.logging import configure_logging
from app.db.session import Base, engine
from app.core.metrics import init_metrics
import app.models  # noqa: F401  (registers tables on Base.metadata)
${spec.needsAuth ? "from app.api import auth_routes\n" : ""}${spec.entities.map((e) => `from app.api import ${e.snake}_routes`).join("\n")}


def create_app() -> FastAPI:
    settings = get_settings()
    configure_logging(settings.log_level)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        Base.metadata.create_all(engine)
        logging.getLogger("app").info("startup complete")
        yield

    app = FastAPI(title=settings.app_name, version="1.0.0", lifespan=lifespan)
    register_error_handlers(app)
    init_metrics(app)

    @app.get("/health", tags=["meta"])
    def health():
        return {"status": "ok"}

${spec.needsAuth ? "    app.include_router(auth_routes.router)\n" : ""}${spec.entities.map((e) => `    app.include_router(${e.snake}_routes.router)`).join("\n")}
    return app
`;

const metricsPy = () => `import threading
import time
from collections import defaultdict

from fastapi import FastAPI, Request
from fastapi.responses import PlainTextResponse

_lock = threading.Lock()
_count = defaultdict(int)
_seconds = defaultdict(float)


def _esc(v: str) -> str:
    return v.replace("\\\\", "\\\\\\\\").replace('"', '\\\\"')


def init_metrics(app: FastAPI) -> None:
    """In-process request counters in Prometheus text format. Counters are per worker process and reset on
    restart; with several uvicorn/gunicorn workers each scrape sees one worker."""

    @app.middleware("http")
    async def record(request: Request, call_next):
        t0 = time.perf_counter()
        response = await call_next(request)
        route = getattr(request.scope.get("route"), "path", None) or "unmatched"
        key = (request.method, route, str(response.status_code))
        with _lock:
            _count[key] += 1
            _seconds[key] += time.perf_counter() - t0
        return response

    @app.get("/metrics", include_in_schema=False, response_class=PlainTextResponse)
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
        return PlainTextResponse("\\n".join(lines) + "\\n", media_type="text/plain; version=0.0.4")
`;

function generate(spec) {
  const f = {};
  f["requirements.txt"] = requirements(spec);
  f[".env.example"] = envExample(spec);
  f["Dockerfile"] = dockerfile();
  f["docker-compose.yml"] = compose(spec);
  f[".dockerignore"] = ".venv\n__pycache__\n.pytest_cache\n*.db\n.env\n";
  f[".gitignore"] = ".venv/\n__pycache__/\n.pytest_cache/\n*.db\n.env\n";
  f["README.md"] = readme(spec);
  f["pytest.ini"] = "[pytest]\ntestpaths = tests\n";
  for (const p of ["app", "app/core", "app/db", "app/models", "app/schemas", "app/repositories", "app/services", "app/api", "tests"]) {
    f[`${p}/__init__.py`] = "";
  }
  f["app/main.py"] = mainPy(spec);
  f["app/core/config.py"] = configPy(spec);
  f["app/core/logging.py"] = loggingPy();
  f["app/core/errors.py"] = errorsPy();
  f["app/db/session.py"] = sessionPy();
  f["app/repositories/base.py"] = repoBasePy();
  f["tests/conftest.py"] = conftestPy(spec);
  f["app/core/metrics.py"] = metricsPy();
  f["tests/test_health.py"] = `def test_health(client):\n    r = client.get("/health")\n    assert r.status_code == 200\n    assert r.json() == {"status": "ok"}\n\n\ndef test_openapi_available(client):\n    assert client.get("/openapi.json").status_code == 200\n\n\ndef test_metrics_counts_requests_by_route_template(client):\n    client.get("/health")\n    client.get("/definitely-missing")\n    text = client.get("/metrics").text\n    assert 'http_requests_total{method="GET",route="/health",status="200"}' in text\n    assert 'route="unmatched",status="404"' in text\n`;

  const F = spec.features || {};
  const feat = require("./pythonFeatures");
  if (F.cache) {
    f["app/core/cache.py"] = feat.cachePy();
    f["tests/test_cache.py"] = feat.cacheTestsPy(spec);
  }
  if (F.events) {
    f["app/core/events.py"] = feat.eventsPy(F.events);
    f["app/worker.py"] = feat.workerPy(F.events);
    f["tests/test_events.py"] = feat.eventsTestsPy(spec, F.events);
    if (F.events === "rabbitmq") f["tests/test_events_rabbitmq_real.py"] = feat.rabbitRealTestsPy();
  }
  const modelImports = [];
  if (spec.needsAuth) {
    f["app/core/security.py"] = securityPy();
    f["app/models/user.py"] = userModelPy();
    modelImports.push("from app.models.user import User  # noqa: F401");
    Object.assign(f, authFiles());
  }
  for (const e of spec.entities) {
    f[`app/models/${e.snake}.py`] = entityModelPy(spec, e);
    f[`app/schemas/${e.snake}.py`] = entitySchemasPy(spec, e);
    f[`app/services/${e.snake}_service.py`] = entityServicePy(spec, e);
    f[`app/api/${e.snake}_routes.py`] = entityRoutesPy(spec, e);
    f[`tests/test_${e.snake}.py`] = entityTestsPy(spec, e);
    modelImports.push(`from app.models.${e.snake} import ${e.name}  # noqa: F401`);
  }
  f["app/models/__init__.py"] = modelImports.join("\n") + "\n";
  return f;
}

const parts = { PY, pyLit, pyType, sampleValue, envExample, compose, configPy, loggingPy, securityPy, sessionPy, userModelPy, entityModelPy, entitySchemasPy, repoBasePy, entityServicePy };

module.exports = {
  parts,
  id: "python-fastapi",
  label: "Python + FastAPI",
  language: "Python",
  framework: "FastAPI",
  status: "implemented",
  databases: ["sqlite", "postgresql", "mysql"],
  features: ["cache", "events"],
  generate,
  validate: {
    toolchain: "python3",
    setup: [["python3", "-m", "venv", ".venv"], [".venv/bin/pip", "install", "-q", "-r", "requirements.txt"]],
    test: [[".venv/bin/python", "-m", "pytest", "-q"]],
    requiresFor: (spec) => [...(spec.database === "mysql" ? [{ name: "MySQL", env: "TEST_DB_URL", fallback: "mysql+pymysql://app:app@127.0.0.1:3306/app", hint: "Start MySQL 8 (user app / password app / database app) or set TEST_DB_URL; the generated GitHub Actions workflow starts a MySQL service container." }] : []), ...(spec.features && spec.features.events === "rabbitmq" ? [{ name: "RabbitMQ", env: "AMQP_URL", fallback: "amqp://app:app@localhost:5672/", hint: "Start one with `docker run -d -p 5672:5672 -e RABBITMQ_DEFAULT_USER=app -e RABBITMQ_DEFAULT_PASS=app rabbitmq:3.13` or set AMQP_URL; the generated GitHub Actions workflow starts a RabbitMQ service container." }] : [])],
  },
};
