/**
 * Opt-in `readWriteSplit` feature (python-fastapi + PostgreSQL): writes and read-your-writes reads go to the primary,
 * list reads go to configured streaming replicas, unhealthy replicas are skipped for a cooldown and reads fall back to
 * the primary when no replica is usable. Also generates a primary + streaming-replica docker-compose setup.
 *
 * What is verified (see generated tests/test_read_write_split.py, run against a REAL primary + streaming replica):
 * routing of SELECT/INSERT statements per engine, replication actually delivering rows, fallback and recovery when
 * the replica becomes unreachable, read-only enforcement on the standby. The compose/entrypoint scripts are only
 * validated structurally by Sierra (no Docker here); the same pg_basebackup flow was exercised against local Postgres.
 *
 * Limits (in the generated README): replication is asynchronous, so replica reads can be stale (lag); by default only
 * list endpoints read from replicas (REPLICA_READS=list) so create -> get sees its own write; there is no automatic
 * failover/promotion; a replica that dies mid-query fails that request with 503.
 */
function must(s, a, b, what) {
  if (!s.includes(a)) throw new Error(`readWriteSplit patch: anchor not found (${what})`);
  return s.replace(a, b);
}

const routingPy = `"""Primary/replica routing. Writes use app.db.session.get_db (primary); list reads use get_read_db."""
import itertools
import logging
import os
import threading
import time
from typing import Callable, List, Optional

from sqlalchemy import create_engine, event, text
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.exc import DBAPIError, OperationalError
from sqlalchemy.orm import Session, sessionmaker

from fastapi import Depends

from app.db.session import get_db, pool_kwargs

log = logging.getLogger("app.db.routing")


class Replica:
    def __init__(self, url: str, engine: Engine):
        self.url = url
        self.engine = engine
        self.healthy = True
        self.last_error: Optional[str] = None
        self.failed_at = 0.0

    @property
    def label(self) -> str:
        return make_url(self.url).render_as_string(hide_password=True) if "://" in self.url else self.url


def _default_engine(url: str) -> Engine:
    return create_engine(url, connect_args={"connect_timeout": 3}, **pool_kwargs())


class ReplicaRouter:
    """Round-robin over healthy replicas. A failed replica is skipped for \`cooldown\` seconds, then retried."""

    def __init__(self, urls: List[str], cooldown: float = 15.0, clock: Callable[[], float] = time.monotonic, engine_factory: Callable[[str], Engine] = _default_engine):
        self.cooldown = cooldown
        self.clock = clock
        self.replicas = [Replica(u, engine_factory(u)) for u in urls]
        self._rr = itertools.cycle(range(len(self.replicas))) if self.replicas else None
        self._lock = threading.Lock()
        for rep in self.replicas:
            # a connection that breaks while serving a query also marks the replica unhealthy
            event.listen(rep.engine, "handle_error", self._on_error(rep))

    def _on_error(self, rep: Replica):
        def handler(ctx):
            if getattr(ctx, "is_disconnect", False) or isinstance(ctx.original_exception, OSError):
                self.mark_failed(rep, ctx.original_exception)
        return handler

    def mark_failed(self, rep: Replica, exc) -> None:
        with self._lock:
            if rep.healthy:
                log.warning("replica %s marked unhealthy: %s", rep.label, exc)
            rep.healthy, rep.last_error, rep.failed_at = False, str(exc)[:200], self.clock()

    def _usable(self, rep: Replica) -> bool:
        return rep.healthy or self.clock() - rep.failed_at >= self.cooldown

    def session(self) -> Optional[Session]:
        """A session on the next usable replica, or None (caller falls back to the primary)."""
        if not self.replicas:
            return None
        for _ in range(len(self.replicas)):
            with self._lock:
                rep = self.replicas[next(self._rr)]
                usable = self._usable(rep)
            if not usable:
                continue
            s = sessionmaker(bind=rep.engine, autoflush=False, expire_on_commit=False)()
            try:
                s.connection()  # checks a connection out now, so an unreachable replica is detected before the query
            except (OperationalError, DBAPIError, OSError) as exc:
                s.close()
                self.mark_failed(rep, exc)
                continue
            with self._lock:
                if not rep.healthy:
                    log.info("replica %s is healthy again", rep.label)
                rep.healthy, rep.last_error = True, None
            return s
        return None

    def status(self) -> list:
        out = []
        for rep in self.replicas:
            try:
                with rep.engine.connect() as c:
                    in_recovery = c.execute(text("SELECT pg_is_in_recovery()")).scalar()
                out.append({"url": rep.label, "healthy": True, "in_recovery": bool(in_recovery), "last_error": None})
                with self._lock:
                    rep.healthy, rep.last_error = True, None
            except Exception as exc:  # noqa: BLE001
                self.mark_failed(rep, exc)
                out.append({"url": rep.label, "healthy": False, "in_recovery": None, "last_error": rep.last_error})
        return out


def _from_env() -> ReplicaRouter:
    urls = [u.strip() for u in os.environ.get("DATABASE_REPLICA_URLS", "").split(",") if u.strip()]
    return ReplicaRouter(urls, cooldown=float(os.environ.get("REPLICA_HEALTH_COOLDOWN_SECONDS", "15")))


router: ReplicaRouter = _from_env()


def set_router(r: ReplicaRouter) -> None:
    global router
    router = r


def get_read_db(primary: Session = Depends(get_db)):
    """Session for a read: a healthy replica when one is available, otherwise the primary session (no connection is
    checked out for it unless it is used)."""
    s = router.session()
    if s is None:
        yield primary
        return
    try:
        yield s
    finally:
        s.close()
`;

const healthPy = `from fastapi import FastAPI
from sqlalchemy import text

from app.db import routing
from app.db.session import engine


def init_db_health(app: FastAPI) -> None:
    @app.get("/health/db", tags=["meta"])
    def health_db():
        try:
            with engine.connect() as c:
                c.execute(text("SELECT 1"))
            primary = {"healthy": True}
        except Exception as exc:  # noqa: BLE001
            primary = {"healthy": False, "error": str(exc)[:200]}
        replicas = routing.router.status()
        return {"primary": primary, "replicas": replicas, "replica_reads": routing.REPLICA_READS}
`;

const testsPy = `"""Read/write splitting. Unit tests always run; the integration tests need a REAL primary + streaming replica:
   TEST_DATABASE_URL=postgresql+psycopg2://app:app@127.0.0.1:5440/app
   TEST_DATABASE_REPLICA_URLS=postgresql+psycopg2://app:app@127.0.0.1:5441/app
They are skipped with a reason (never faked) when those are not set/reachable."""
import os
import socket
import threading
import time
from urllib.parse import urlparse

import pytest
from sqlalchemy import create_engine, event, text
from sqlalchemy.exc import OperationalError, ProgrammingError

from app.db import routing
from app.db.routing import ReplicaRouter
from app.db.session import Base, get_db, pool_kwargs

PRIMARY = os.environ.get("TEST_DATABASE_URL")
REPLICA = (os.environ.get("TEST_DATABASE_REPLICA_URLS") or "").split(",")[0].strip()


# ---------------------------------------------------------------- unit tests (sqlite, no external service)
def _sqlite(url):
    return create_engine(url, connect_args={"check_same_thread": False})


def test_round_robin_skips_failed_replica_and_recovers_after_cooldown(tmp_path):
    t = [0.0]
    good1, good2 = f"sqlite:///{tmp_path}/a.db", f"sqlite:///{tmp_path}/b.db"
    bad = f"sqlite:////nonexistent-dir-xyz/c.db"
    r = ReplicaRouter([good1, bad, good2], cooldown=10, clock=lambda: t[0], engine_factory=_sqlite)
    used = []
    for _ in range(6):
        s = r.session()
        assert s is not None
        used.append(str(s.get_bind().url))
        s.close()
    assert not any("nonexistent" in u for u in used)
    assert {good1, good2} == set(used)
    assert [x.healthy for x in r.replicas] == [True, False, True]
    t[0] += 11  # cooldown over: the bad replica is tried again (still bad -> stays unhealthy)
    for _ in range(3):
        r.session().close()
    assert r.replicas[1].healthy is False and r.replicas[1].failed_at == 11


def test_no_usable_replica_returns_none(tmp_path):
    r = ReplicaRouter(["sqlite:////nonexistent-dir-xyz/a.db"], cooldown=60, engine_factory=_sqlite)
    assert r.session() is None
    assert ReplicaRouter([], engine_factory=_sqlite).session() is None


def test_pool_settings_come_from_environment(monkeypatch):
    monkeypatch.setenv("DB_POOL_SIZE", "7")
    monkeypatch.setenv("DB_MAX_OVERFLOW", "3")
    monkeypatch.setenv("DB_POOL_TIMEOUT", "5")
    k = pool_kwargs()
    assert k["pool_size"] == 7 and k["max_overflow"] == 3 and k["pool_timeout"] == 5 and k["pool_pre_ping"] is True


# ---------------------------------------------------------------- integration tests (real Postgres primary + replica)
@pytest.fixture(scope="module")
def pg():
    if not PRIMARY or not REPLICA:
        pytest.skip("TEST_DATABASE_URL / TEST_DATABASE_REPLICA_URLS not set: these tests need a real PostgreSQL primary and streaming replica")
    primary = create_engine(PRIMARY, pool_pre_ping=True)
    replica = create_engine(REPLICA, pool_pre_ping=True)
    try:
        with primary.connect() as c:
            c.execute(text("SELECT 1"))
        with replica.connect() as c:
            if not c.execute(text("SELECT pg_is_in_recovery()")).scalar():
                pytest.skip("TEST_DATABASE_REPLICA_URLS does not point at a standby (pg_is_in_recovery() is false)")
    except OperationalError as exc:
        pytest.skip(f"PostgreSQL unavailable: {exc}")
    import app.models  # noqa: F401

    Base.metadata.drop_all(primary)
    Base.metadata.create_all(primary)

    def schema_replicated():  # DDL travels through the same asynchronous WAL stream as data
        with replica.connect() as c:
            return all(c.execute(text("SELECT to_regclass(:n)"), {"n": f"public.{t}"}).scalar() for t in Base.metadata.tables)

    assert wait_for(schema_replicated, 15), "schema did not replicate to the standby"
    yield primary, replica
    Base.metadata.drop_all(primary)


@pytest.fixture(autouse=True)
def _restore_router():
    """Tests install their own router; never leak it into other test modules (which run on sqlite)."""
    yield
    routing.set_router(ReplicaRouter([]))


def wait_for(cond, timeout=10.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if cond():
            return True
        time.sleep(0.05)
    return False


def record(engine, label, log, table):
    @event.listens_for(engine, "before_cursor_execute")
    def _(conn, cursor, statement, params, context, executemany):
        if table in statement.lower():  # only the entity table: auth lookups on \"users\" use the primary by design
            log.append((label, statement.strip().split()[0].upper()))


class TcpProxy:
    """Forwarder in front of the replica so a test can make it unreachable and bring it back on the same port."""

    def __init__(self, target):
        u = urlparse(target.replace("postgresql+psycopg2", "postgresql"))
        self.target = (u.hostname, u.port or 5432)
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        self.port = s.getsockname()[1]
        s.close()
        self.srv, self.pairs = None, []
        self.url = target.replace(f"{u.hostname}:{u.port}", f"127.0.0.1:{self.port}")
        self.start()

    def start(self):
        self.srv = socket.socket()
        self.srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.srv.bind(("127.0.0.1", self.port))
        self.srv.listen(16)
        threading.Thread(target=self._accept, args=(self.srv,), daemon=True).start()

    def _accept(self, srv):
        while True:
            try:
                c, _ = srv.accept()
            except OSError:
                return
            b = socket.create_connection(self.target)
            self.pairs.append((c, b))
            for a, z in ((c, b), (b, c)):
                threading.Thread(target=self._pipe, args=(a, z), daemon=True).start()

    @staticmethod
    def _pipe(a, z):
        try:
            while True:
                d = a.recv(65536)
                if not d:
                    break
                z.sendall(d)
        except OSError:
            pass
        for x in (a, z):
            try:
                x.close()
            except OSError:
                pass

    def stop(self):
        try:
            self.srv.shutdown(socket.SHUT_RDWR)  # wakes the thread blocked in accept(); close() alone would keep listening
        except OSError:
            pass
        try:
            self.srv.close()
        except OSError:
            pass
        for c, b in self.pairs:
            for x in (c, b):
                try:
                    x.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                x.close()
        self.pairs = []


def test_replication_is_operational_and_standby_is_read_only(pg):
    primary, replica = pg
    with primary.begin() as c:
        c.execute(text("CREATE TABLE IF NOT EXISTS repl_probe (id int primary key, v text)"))
        c.execute(text("INSERT INTO repl_probe VALUES (1, 'hello') ON CONFLICT DO NOTHING"))
    def visible():
        try:
            with replica.connect() as c:
                return c.execute(text("SELECT v FROM repl_probe WHERE id = 1")).scalar() == "hello"
        except ProgrammingError:  # the CREATE TABLE has not been replayed on the standby yet
            return False
    assert wait_for(visible), "row written on the primary never appeared on the replica"
    with pytest.raises(Exception, match="read-only"):
        with replica.begin() as c:
            c.execute(text("INSERT INTO repl_probe VALUES (2, 'nope')"))
    with primary.begin() as c:
        c.execute(text("DROP TABLE repl_probe"))


@pytest.fixture()
def app_client(pg, monkeypatch):
    from fastapi.testclient import TestClient

    from app.main import create_app

    primary, replica = pg
    rt = ReplicaRouter([REPLICA], cooldown=0.5)
    routing.set_router(rt)
    app = create_app()
    from sqlalchemy.orm import sessionmaker

    maker = sessionmaker(bind=primary, autoflush=False, expire_on_commit=False)

    def primary_db():
        s = maker()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = primary_db
    with TestClient(app) as c:
        yield c, primary, replica, rt, app


${"${ROUTE_TESTS}"}
`;

function routeTests(spec) {
  const e = spec.entities[0];
  const A = spec.needsAuth;
  const req = e.fields.filter((f) => f.required || f.default === undefined);
  const val = (f) => (f.type === "string" || f.type === "text" ? `"${f.name} 1"` : f.type === "int" ? "1" : f.type === "float" ? "1.5" : f.type === "bool" ? "True" : JSON.stringify(f.values[0]));
  const payload = "{" + req.map((f) => `"${f.name}": ${val(f)}`).join(", ") + "}";
  const H = A ? "H" : "";
  const hdr = A ? ", headers=H" : "";
  return `${A ? `
def _auth(c):
    c.post("/api/auth/register", json={"email": "split@example.com", "name": "S", "password": "password123"})
    t = c.post("/api/auth/login", json={"email": "split@example.com", "password": "password123"}).json()["access_token"]
    return {"Authorization": "Bearer " + t}

` : ""}
def test_writes_hit_primary_list_reads_hit_replica_get_by_id_reads_primary(app_client):
    c, primary, replica, rt, app = app_client
    ${A ? "H = _auth(c)\n    " : ""}log = []
    record(primary, "primary", log, "${e.plural}")
    record(rt.replicas[0].engine, "replica", log, "${e.plural}")
    created = c.post("/api/${e.plural}", json=${payload}${hdr})
    assert created.status_code == 201
    id_ = created.json()["id"]
    assert ("primary", "INSERT") in log and ("replica", "INSERT") not in log
    log.clear()
    assert c.get(f"/api/${e.plural}/{id_}"${hdr}).status_code == 200  # read-your-writes: by-id reads use the primary
    assert ("primary", "SELECT") in log and ("replica", "SELECT") not in log
    log.clear()
    def listed():
        log.clear()
        r = c.get("/api/${e.plural}"${hdr})
        return r.status_code == 200 and any(x["id"] == id_ for x in r.json())
    assert wait_for(listed), "list never saw the row: replication or routing is broken"  # replication lag is allowed to delay it
    assert ("replica", "SELECT") in log and ("primary", "SELECT") not in log
    assert c.delete(f"/api/${e.plural}/{id_}"${hdr}).status_code == 204


def test_replica_outage_falls_back_to_primary_then_recovers(pg, monkeypatch):
    from fastapi.testclient import TestClient
    from sqlalchemy.orm import sessionmaker

    from app.main import create_app

    primary, replica = pg
    proxy = TcpProxy(REPLICA)
    rt = ReplicaRouter([proxy.url], cooldown=0.5)
    routing.set_router(rt)
    app = create_app()
    maker = sessionmaker(bind=primary, autoflush=False, expire_on_commit=False)

    def primary_db():
        s = maker()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = primary_db
    log = []
    record(primary, "primary", log, "${e.plural}")
    record(rt.replicas[0].engine, "replica", log, "${e.plural}")
    try:
        with TestClient(app) as c:
            ${A ? "H = _auth(c)\n            " : ""}created = c.post("/api/${e.plural}", json=${payload}${hdr}).json()["id"]
            assert wait_for(lambda: (log.clear(), c.get("/api/${e.plural}"${hdr}).status_code)[1] == 200 and ("replica", "SELECT") in log)
            proxy.stop()  # replica becomes unreachable
            rt.replicas[0].engine.dispose()
            log.clear()
            r = c.get("/api/${e.plural}"${hdr})
            assert r.status_code == 200 and any(x["id"] == created for x in r.json()), "reads must fall back to the primary"
            assert ("primary", "SELECT") in log
            assert rt.replicas[0].healthy is False
            assert c.get("/health/db").json()["replicas"][0]["healthy"] is False
            proxy.start()  # replica is back
            time.sleep(0.7)  # cooldown
            assert wait_for(lambda: (log.clear(), c.get("/api/${e.plural}"${hdr}).status_code)[1] == 200 and ("replica", "SELECT") in log and ("primary", "SELECT") not in log), "traffic did not return to the recovered replica"
            assert rt.replicas[0].healthy is True
            c.delete(f"/api/${e.plural}/{created}"${hdr})
    finally:
        proxy.stop()


def test_health_db_reports_primary_and_replicas(app_client):
    c, primary, replica, rt, app = app_client
    body = c.get("/health/db").json()
    assert body["primary"]["healthy"] is True
    assert body["replicas"][0]["healthy"] is True and body["replicas"][0]["in_recovery"] is True
`;
}

function fastapi(spec, f) {
  if (spec.database !== "postgresql") throw Object.assign(new Error("readWriteSplit requires database=postgresql"), { statusCode: 400 });
  f["app/db/routing.py"] = routingPy.replace("\nrouter: ReplicaRouter", "\nREPLICA_READS = os.environ.get(\"REPLICA_READS\", \"list\")  # list | all\n\n\nrouter: ReplicaRouter");
  f["app/db/health.py"] = healthPy;
  f["tests/test_read_write_split.py"] = testsPy.replace("${ROUTE_TESTS}", routeTests(spec));

  f["app/db/session.py"] = must(must(f["app/db/session.py"], "from sqlalchemy import create_engine\n", "import os\n\nfrom sqlalchemy import create_engine\n", "session import"),
    "def _make_engine(url: str):", `def pool_kwargs() -> dict:
    """Connection pool settings from the environment (applied to the primary and every replica engine)."""
    return {
        "pool_size": int(os.environ.get("DB_POOL_SIZE", "5")),
        "max_overflow": int(os.environ.get("DB_MAX_OVERFLOW", "10")),
        "pool_timeout": float(os.environ.get("DB_POOL_TIMEOUT", "30")),
        "pool_recycle": int(os.environ.get("DB_POOL_RECYCLE", "1800")),
        "pool_pre_ping": True,
    }


def _make_engine(url: str):`);
  f["app/db/session.py"] = must(f["app/db/session.py"], "return create_engine(url, pool_pre_ping=True)", "return create_engine(url, **pool_kwargs())", "pool");

  for (const e of spec.entities) {
    const p = `app/api/${e.snake}_routes.py`;
    let s = f[p];
    s = must(s, "from app.db.session import get_db\n", "from app.db.routing import REPLICA_READS, get_read_db\nfrom app.db.session import get_db\n\nread_by_id_db = get_read_db if REPLICA_READS == \"all\" else get_db  # by-id reads use the primary unless REPLICA_READS=all\n", `${e.name} import`);
    s = must(s, `def list_${e.snake}(limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0), db: Session = Depends(get_db)`, `def list_${e.snake}(limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0), db: Session = Depends(get_read_db)`, `${e.name} list`);
    s = must(s, `def get_${e.snake}(id: int, db: Session = Depends(get_db)`, `def get_${e.snake}(id: int, db: Session = Depends(read_by_id_db)`, `${e.name} get`);
    f[p] = s;
  }
  f["app/main.py"] = must(must(must(f["app/main.py"], "from app.core.metrics import init_metrics\n", "from app.core.metrics import init_metrics\nfrom app.db.health import init_db_health\n", "main import"),
    "    init_metrics(app)\n", "    init_metrics(app)\n    init_db_health(app)\n", "main call"),
    "    register_error_handlers(app)\n", "    register_error_handlers(app)\n    from sqlalchemy.exc import OperationalError\n    from fastapi.responses import JSONResponse\n\n    @app.exception_handler(OperationalError)\n    async def db_unavailable(_, exc):  # a database that is down is 503, not a generic 500\n        return JSONResponse(status_code=503, headers={\"Retry-After\": \"1\"}, content={\"error\": {\"code\": \"database_unavailable\", \"message\": \"Database is unavailable\", \"details\": None}})\n", "main handler");

  f[".env.example"] += "DATABASE_REPLICA_URLS=postgresql+psycopg2://app:app@localhost:5433/app\nREPLICA_READS=list\nREPLICA_HEALTH_COOLDOWN_SECONDS=15\nDB_POOL_SIZE=5\nDB_MAX_OVERFLOW=10\nDB_POOL_TIMEOUT=30\nREPLICATION_PASSWORD=change-me\n";

  let y = f["docker-compose.yml"];
  y = y.split("      DATABASE_URL: postgresql+psycopg2://app:app@db:5432/app\n").join("      DATABASE_URL: postgresql+psycopg2://app:app@db:5432/app\n      DATABASE_REPLICA_URLS: postgresql+psycopg2://app:app@db-replica:5432/app\n");
  y = must(y, "      db:\n        condition: service_healthy\n", "      db:\n        condition: service_healthy\n      db-replica:\n        condition: service_healthy\n", "compose depends");
  y = must(y, "  db:\n    image: postgres:16-alpine\n    environment:\n      POSTGRES_USER: app\n      POSTGRES_PASSWORD: app\n      POSTGRES_DB: app\n    volumes:\n      - pgdata:/var/lib/postgresql/data\n",
    "  db:\n    image: postgres:16-alpine\n    command: [\"postgres\", \"-c\", \"wal_level=replica\", \"-c\", \"max_wal_senders=10\", \"-c\", \"hot_standby=on\"]\n    environment:\n      POSTGRES_USER: app\n      POSTGRES_PASSWORD: app\n      POSTGRES_DB: app\n      REPLICATION_PASSWORD: ${REPLICATION_PASSWORD:?set REPLICATION_PASSWORD in your shell or .env}\n    volumes:\n      - pgdata:/var/lib/postgresql/data\n      - ./infra/postgres/primary-init.sh:/docker-entrypoint-initdb.d/10-replication.sh:ro\n", "compose db");
  y = must(y, "volumes:\n  pgdata:\n", "  db-replica:\n    image: postgres:16-alpine\n    entrypoint: [\"/bin/sh\", \"/replica-entrypoint.sh\"]\n    environment:\n      PGUSER: app\n      REPLICATION_PASSWORD: ${REPLICATION_PASSWORD:?set REPLICATION_PASSWORD in your shell or .env}\n    volumes:\n      - pgreplica:/var/lib/postgresql/data\n      - ./infra/postgres/replica-entrypoint.sh:/replica-entrypoint.sh:ro\n    depends_on:\n      db:\n        condition: service_healthy\n    healthcheck:\n      test: [\"CMD-SHELL\", \"pg_isready -U app\"]\n      interval: 5s\n      timeout: 3s\n      retries: 20\nvolumes:\n  pgdata:\n  pgreplica:\n", "compose volumes");
  f["docker-compose.yml"] = y;
  f["infra/postgres/primary-init.sh"] = `#!/bin/sh
# Runs once on first start of the PRIMARY: creates the replication role and lets replicas connect.
set -e
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD '$REPLICATION_PASSWORD'"
echo "host replication replicator all scram-sha-256" >> "$PGDATA/pg_hba.conf"
`;
  f["infra/postgres/replica-entrypoint.sh"] = `#!/bin/sh
# STREAMING REPLICA: on first start clone the primary with pg_basebackup (-R writes standby.signal + primary_conninfo),
# then run the normal postgres entrypoint, which starts it as a hot standby. Needs the primary to be healthy first.
set -e
if [ -z "$(ls -A "$PGDATA" 2>/dev/null)" ]; then
  until pg_isready -h db -U "$PGUSER"; do sleep 1; done
  PGPASSWORD="$REPLICATION_PASSWORD" pg_basebackup -h db -U replicator -D "$PGDATA" -R -X stream
  chown -R postgres:postgres "$PGDATA"
  chmod 700 "$PGDATA"
fi
exec docker-entrypoint.sh postgres -c hot_standby=on
`;
  f["README.md"] = must(f["README.md"], "## Known limitations", `## Read/write splitting and replication (PostgreSQL)
- Writes always use the primary (\`DATABASE_URL\`). **List** endpoints read from \`DATABASE_REPLICA_URLS\` (comma separated, round robin); by-id reads use the primary so create -> get sees its own write (\`REPLICA_READS=all\` sends them to replicas too).
- A replica that cannot be reached is skipped for \`REPLICA_HEALTH_COOLDOWN_SECONDS\`, then tried again; with no usable replica reads fall back to the primary. A replica that dies in the middle of a query fails that request with \`503\`.
- Pools: \`DB_POOL_SIZE\`, \`DB_MAX_OVERFLOW\`, \`DB_POOL_TIMEOUT\`, \`DB_POOL_RECYCLE\` apply to the primary and every replica. \`GET /health/db\` reports the primary and each replica.
- \`docker-compose.yml\` starts a primary plus a streaming replica (\`infra/postgres/*.sh\`, set \`REPLICATION_PASSWORD\`). Replication is **asynchronous**: replica reads can be stale, and there is **no automatic failover** (promoting a replica is a manual operation).
- \`tests/test_read_write_split.py\` runs unit tests always and integration tests only against a real primary + standby (\`TEST_DATABASE_URL\`, \`TEST_DATABASE_REPLICA_URLS\`); otherwise they are skipped with a reason.

## Known limitations`, "readme");
}

const PATCH = { "python-fastapi": fastapi };

function withReadWriteSplit(stack) {
  const patch = PATCH[stack.id];
  if (!patch) return stack;
  const base = stack.generate;
  const prev = stack.validate.requiresFor;
  return {
    ...stack,
    features: [...(stack.features || []), "readWriteSplit"],
    validate: { ...stack.validate, requiresFor: (spec) => [...(prev ? prev(spec) : []), ...(spec.features && spec.features.readWriteSplit ? [{ name: "PostgreSQL primary", env: "TEST_DATABASE_URL", fallback: "postgresql+psycopg2://app:app@127.0.0.1:5440/app", hint: "Start a primary + streaming replica with scripts/start-test-postgres.sh (or the generated docker-compose.yml) and set TEST_DATABASE_URL and TEST_DATABASE_REPLICA_URLS; the generated GitHub Actions workflow cannot start a streaming replica from service containers, so run the compose file there." }] : [])] },
    generate(spec) {
      const files = base(spec);
      if (spec.features && spec.features.readWriteSplit) patch(spec, files);
      return files;
    },
  };
}

module.exports = { withReadWriteSplit, PATCH };
