/**
 * Optional runtime features for generated Python (FastAPI) services:
 *   cache  -> Redis cache-aside on GET /<entity>/{id}, invalidated on update/delete, fail-open
 *   events -> domain events (<entity>.created|updated|deleted) published to Kafka or RabbitMQ,
 *             plus a worker with bounded retries and a dead-letter destination.
 * Broker clients are exercised in tests through injected fakes; nothing here is tested against a real broker.
 */

const cachePy = () => `import json
import logging
import os
import time
from typing import Optional, Protocol

log = logging.getLogger("app.cache")


class Cache(Protocol):
    def get(self, key: str) -> Optional[str]: ...
    def set(self, key: str, value: str, ttl: int) -> None: ...
    def delete(self, key: str) -> None: ...


class MemoryCache:
    """Per-process cache used when REDIS_URL is not set. Not shared between instances."""

    def __init__(self, clock=time.monotonic):
        self._data: dict[str, tuple[float, str]] = {}
        self._clock = clock

    def get(self, key):
        item = self._data.get(key)
        if item is None:
            return None
        expires, value = item
        if self._clock() >= expires:
            self._data.pop(key, None)
            return None
        return value

    def set(self, key, value, ttl):
        self._data[key] = (self._clock() + ttl, value)

    def delete(self, key):
        self._data.pop(key, None)


class RedisCache:
    """Redis-backed cache. Every call fails open: a Redis outage is logged and treated as a miss."""

    def __init__(self, client):
        self.client = client

    def get(self, key):
        try:
            return self.client.get(key)
        except Exception:
            log.warning("cache get failed; treating as miss", exc_info=True)
            return None

    def set(self, key, value, ttl):
        try:
            self.client.set(key, value, ex=ttl)
        except Exception:
            log.warning("cache set failed", exc_info=True)

    def delete(self, key):
        try:
            self.client.delete(key)
        except Exception:
            log.warning("cache delete failed", exc_info=True)


_cache: Optional[Cache] = None


def get_cache() -> Cache:
    global _cache
    if _cache is None:
        url = os.environ.get("REDIS_URL")
        if url:
            import redis

            _cache = RedisCache(redis.Redis.from_url(url, socket_timeout=0.5, decode_responses=True))
        else:
            _cache = MemoryCache()
    return _cache


def set_cache(cache: Optional[Cache]) -> None:
    global _cache
    _cache = cache


def ttl_seconds() -> int:
    return int(os.environ.get("CACHE_TTL_SECONDS", "300"))
`;

const eventsPy = (kind) => `import json
import logging
import os
import threading
import uuid
from datetime import datetime, timezone
from typing import Optional, Protocol

log = logging.getLogger("app.events")


def make_event(event_type: str, data: dict) -> dict:
    return {"id": str(uuid.uuid4()), "type": event_type, "ts": datetime.now(timezone.utc).isoformat(), "data": data}


class EventPublisher(Protocol):
    def publish(self, event: dict) -> None: ...


class NoopPublisher:
    def publish(self, event: dict) -> None:
        log.debug("event not published (no broker configured): %s", event["type"])


${kind === "kafka" ? `class KafkaPublisher:
    """Publishes JSON events to a Kafka topic, keyed by event type. Best effort: failures are logged, not raised."""

    def __init__(self, producer=None, topic: Optional[str] = None):
        if producer is None:
            from kafka import KafkaProducer

            producer = KafkaProducer(
                bootstrap_servers=os.environ["KAFKA_BROKERS"].split(","),
                value_serializer=lambda v: json.dumps(v).encode("utf-8"),
                acks="all",
                retries=3,
            )
        self.producer = producer
        self.topic = topic or os.environ.get("EVENT_TOPIC", "domain-events")

    def publish(self, event: dict) -> None:
        try:
            self.producer.send(self.topic, event)
        except Exception:
            log.exception("failed to publish %s", event.get("type"))
` : `class RabbitPublisher:
    """
    Publishes persistent JSON messages to a durable queue with publisher confirms.
    Best effort for the caller: failures are logged, never raised. A dropped connection is re-opened and the publish
    is retried once. The pika connection is not thread-safe, so publishes are serialised with a lock.
    """

    def __init__(self, channel=None, queue: Optional[str] = None, url: Optional[str] = None):
        self.queue = queue or os.environ.get("EVENT_QUEUE", "domain-events")
        self._url = url or (os.environ.get("AMQP_URL") if channel is None else None)
        self._lock = threading.Lock()
        self._conn = None
        self.channel = channel
        if channel is not None:
            self.channel.queue_declare(queue=self.queue, durable=True)
        else:
            self._connect()

    def _connect(self) -> None:
        import pika

        self.close()
        self._conn = pika.BlockingConnection(pika.URLParameters(self._url))
        self.channel = self._conn.channel()
        self.channel.queue_declare(queue=self.queue, durable=True)
        self.channel.confirm_delivery()  # a nack / unroutable message raises instead of being lost silently

    def close(self) -> None:
        try:
            if self._conn is not None and self._conn.is_open:
                self._conn.close()
        except Exception:  # noqa: BLE001 - closing a dead connection is best effort
            pass
        self._conn = None

    def publish(self, event: dict) -> None:
        import pika

        body = json.dumps(event).encode("utf-8")
        props = pika.BasicProperties(delivery_mode=2, content_type="application/json")  # 2 = persistent
        with self._lock:
            for attempt in (1, 2):
                try:
                    if self._url and (self._conn is None or self._conn.is_closed or self.channel is None or self.channel.is_closed):
                        self._connect()
                    self.channel.basic_publish(exchange="", routing_key=self.queue, body=body, properties=props)
                    return
                except Exception:  # noqa: BLE001
                    if attempt == 2 or not self._url:
                        log.exception("failed to publish %s", event.get("type"))
                        return
                    self._conn = None  # force a reconnect for the second attempt
`}

_publisher: Optional[EventPublisher] = None


def get_publisher() -> EventPublisher:
    global _publisher
    if _publisher is None:
        if ${kind === "kafka" ? 'os.environ.get("KAFKA_BROKERS")' : 'os.environ.get("AMQP_URL")'}:
            try:
                _publisher = ${kind === "kafka" ? "KafkaPublisher()" : "RabbitPublisher()"}
            except Exception:
                log.exception("broker unavailable; events disabled for this process")
                _publisher = NoopPublisher()
        else:
            _publisher = NoopPublisher()
    return _publisher


def set_publisher(p: Optional[EventPublisher]) -> None:
    global _publisher
    _publisher = p
`;

const workerPy = (kind) => `"""Event consumer. Run with: python -m app.worker

Delivery is at-least-once, so handle_event must be idempotent. A message that keeps failing is retried
with backoff and then moved to the dead-letter destination instead of blocking the stream.
"""
import json
import logging
import os
import threading
import time

from app.core.logging import configure_logging

log = logging.getLogger("app.worker")
MAX_ATTEMPTS = int(os.environ.get("EVENT_MAX_ATTEMPTS", "3"))


class Deduper:
    """Remembers recently processed event ids (in memory, per process) to skip redeliveries."""

    def __init__(self, capacity: int = 10_000):
        self.capacity = capacity
        self._seen: dict[str, None] = {}

    def seen(self, event_id: str) -> bool:
        """Check-and-mark. Only safe for brokers where marking before processing cannot lose a message."""
        if event_id in self._seen:
            return True
        self.add(event_id)
        return False

    def contains(self, event_id: str) -> bool:
        return event_id in self._seen

    def add(self, event_id: str) -> None:
        self._seen[event_id] = None
        if len(self._seen) > self.capacity:
            self._seen.pop(next(iter(self._seen)))


def handle_event(event: dict) -> None:
    """Business hook: replace with real work (send email, update a read model, ...)."""
    log.info("handled %s %s", event.get("type"), event.get("id"))


def process_with_retry(handler, event: dict, send_to_dlq, max_attempts: int = MAX_ATTEMPTS, sleep=time.sleep, base_delay: float = 0.5) -> bool:
    """Run handler with bounded retries. Returns True on success, False if the event was dead-lettered."""
    last_error = None
    for attempt in range(1, max_attempts + 1):
        try:
            handler(event)
            return True
        except Exception as exc:  # noqa: BLE001 - any handler failure is retried
            last_error = exc
            log.warning("attempt %d/%d failed for %s: %s", attempt, max_attempts, event.get("id"), exc)
            if attempt < max_attempts:
                sleep(base_delay * 2 ** (attempt - 1))
    send_to_dlq(event, str(last_error))
    return False


${kind === "kafka" ? `def run() -> None:
    from kafka import KafkaConsumer, KafkaProducer

    topic = os.environ.get("EVENT_TOPIC", "domain-events")
    brokers = os.environ["KAFKA_BROKERS"].split(",")
    consumer = KafkaConsumer(topic, bootstrap_servers=brokers, group_id="workers", enable_auto_commit=False,
                             auto_offset_reset="earliest", value_deserializer=lambda b: json.loads(b.decode("utf-8")))
    dlq = KafkaProducer(bootstrap_servers=brokers, value_serializer=lambda v: json.dumps(v).encode("utf-8"))
    dedupe = Deduper()

    def send_to_dlq(event, error):
        dlq.send(topic + ".dlq", {"event": event, "error": error})
        dlq.flush()

    for message in consumer:
        event = message.value
        if not dedupe.seen(event.get("id", "")):
            process_with_retry(handle_event, event, send_to_dlq)
        consumer.commit()  # commit after handled or dead-lettered, so a crash redelivers rather than loses
` : `class RabbitWorker:
    """
    Consumes a durable queue with manual acks, bounded retries (in process, exponential backoff), a dead-letter queue
    (<queue>.dlq) and automatic reconnection with backoff. A message is acked only AFTER it was handled or dead-lettered
    (and the DLQ publish was confirmed), so a crash or dropped connection redelivers it instead of losing it:
    delivery is at-least-once and handle_event must be idempotent.
    """

    def __init__(self, url, queue, handler=None, max_attempts=MAX_ATTEMPTS, base_delay=0.5, prefetch=10, reconnect_delay=1.0, max_reconnect_delay=30.0):
        self.url, self.queue = url, queue
        self.handler, self.max_attempts, self.base_delay, self.prefetch = handler, max_attempts, base_delay, prefetch
        self.reconnect_delay, self.max_reconnect_delay = reconnect_delay, max_reconnect_delay
        self.dedupe = Deduper()
        self.connections = 0  # successful connections so far (observable in tests / metrics)
        self._stop = threading.Event()

    def stop(self) -> None:
        self._stop.set()

    def run(self) -> None:
        delay = self.reconnect_delay
        while not self._stop.is_set():
            try:
                self._consume()
                delay = self.reconnect_delay
            except Exception as exc:  # noqa: BLE001 - AMQP errors, socket errors: reconnect
                log.warning("consumer connection lost (%s); reconnecting in %.1fs", exc, delay)
                if self._stop.wait(delay):
                    break
                delay = min(delay * 2, self.max_reconnect_delay)

    def _consume(self) -> None:
        import pika

        conn = pika.BlockingConnection(pika.URLParameters(self.url))
        try:
            ch = conn.channel()
            ch.queue_declare(queue=self.queue, durable=True)
            ch.queue_declare(queue=self.queue + ".dlq", durable=True)
            ch.basic_qos(prefetch_count=self.prefetch)
            ch.confirm_delivery()
            self.connections += 1
            props = pika.BasicProperties(delivery_mode=2, content_type="application/json")

            def send_to_dlq(payload, error):
                body = json.dumps({"event": payload, "error": error}).encode("utf-8")
                ch.basic_publish(exchange="", routing_key=self.queue + ".dlq", body=body, properties=props)

            def on_message(channel, method, _props, body):
                try:
                    event = json.loads(body)
                    if not isinstance(event, dict):
                        raise ValueError("event must be a JSON object")
                except ValueError as exc:
                    send_to_dlq(body.decode("utf-8", "replace"), f"undecodable message: {exc}")
                    channel.basic_ack(delivery_tag=method.delivery_tag)
                    return
                event_id = event.get("id", "")
                if not (event_id and self.dedupe.contains(event_id)):
                    # conn.sleep keeps AMQP heartbeats flowing while we back off between attempts
                    process_with_retry(self.handler or handle_event, event, send_to_dlq, max_attempts=self.max_attempts, sleep=conn.sleep, base_delay=self.base_delay)
                channel.basic_ack(delivery_tag=method.delivery_tag)
                if event_id:
                    self.dedupe.add(event_id)  # marked only after the ack succeeded

            ch.basic_consume(queue=self.queue, on_message_callback=on_message)
            while not self._stop.is_set():
                conn.process_data_events(time_limit=0.5)
        finally:
            try:
                if conn.is_open:
                    conn.close()
            except Exception:  # noqa: BLE001
                pass


def run() -> None:
    import signal

    worker = RabbitWorker(os.environ["AMQP_URL"], os.environ.get("EVENT_QUEUE", "domain-events"))
    signal.signal(signal.SIGTERM, lambda *_: worker.stop())
    worker.run()
`}

if __name__ == "__main__":
    configure_logging(os.environ.get("LOG_LEVEL", "INFO"))
    run()
`;

const cacheTestsPy = (spec) => `import json

import fakeredis

from app.core.cache import MemoryCache, RedisCache, set_cache


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


def test_memory_cache_expires_entries():
    clock = Clock()
    c = MemoryCache(clock=clock)
    c.set("k", "v", ttl=10)
    assert c.get("k") == "v"
    clock.now = 11
    assert c.get("k") is None


def test_redis_cache_roundtrip_and_delete():
    c = RedisCache(fakeredis.FakeRedis(decode_responses=True))
    c.set("k", json.dumps({"a": 1}), ttl=60)
    assert json.loads(c.get("k")) == {"a": 1}
    c.delete("k")
    assert c.get("k") is None


def test_redis_outage_fails_open():
    class Broken:
        def get(self, *a, **k):
            raise ConnectionError("redis down")

        set = delete = get

    c = RedisCache(Broken())
    assert c.get("k") is None
    c.set("k", "v", ttl=1)
    c.delete("k")


${spec.entities.map((e) => {
  const A = spec.needsAuth;
  const req = e.fields.filter((f) => f.required || f.default === undefined);
  const val = (f) => (f.type === "string" || f.type === "text" ? `"${f.name} 1"` : f.type === "int" ? "1" : f.type === "float" ? "1.5" : f.type === "bool" ? "True" : JSON.stringify(f.values[0]));
  const payload = "{" + req.map((f) => `"${f.name}": ${val(f)}`).join(", ") + "}";
  const first = e.fields.find((f) => f.required && f.type === "string") || e.fields[0];
  const H = A ? ", headers=auth_headers" : "";
  const fx = A ? "client, auth_headers" : "client";
  const upd = first.type === "string" ? `{"${first.name}": "fresh"}` : `{"${first.name}": ${first.type === "int" ? "9" : first.type === "float" ? "9.5" : first.type === "bool" ? "False" : JSON.stringify(first.values ? first.values[first.values.length - 1] : "x")}}`;
  const updCheck = first.type === "string" ? '"fresh"' : null;
  return `def test_${e.snake}_get_is_cached_and_invalidated(${fx}):
    cache = MemoryCache()
    set_cache(cache)
    id_ = client.post("/api/${e.plural}", json=${payload}${H}).json()["id"]
    assert not cache._data
    first = client.get(f"/api/${e.plural}/{id_}"${H}).json()
    assert len(cache._data) == 1                      # populated on first read (cache-aside)
    assert client.get(f"/api/${e.plural}/{id_}"${H}).json() == first
    changed = client.put(f"/api/${e.plural}/{id_}", json=${upd}${H})
    assert changed.status_code == 200
    assert not cache._data                            # invalidated on write
    ${updCheck ? `assert client.get(f"/api/${e.plural}/{id_}"${H}).json()["${first.name}"] == ${updCheck}` : `assert client.get(f"/api/${e.plural}/{id_}"${H}).status_code == 200`}
    client.delete(f"/api/${e.plural}/{id_}"${H})
    assert not cache._data
    assert client.get(f"/api/${e.plural}/{id_}"${H}).status_code == 404
    set_cache(None)
`;
}).join("\n\n")}`;

const eventsTestsPy = (spec, kind) => `from app.core import events
from app.core.events import set_publisher
from app.worker import Deduper, process_with_retry


class Recorder:
    def __init__(self):
        self.events = []

    def publish(self, event):
        self.events.append(event)


${spec.entities.map((e) => {
  const A = spec.needsAuth;
  const req = e.fields.filter((f) => f.required || f.default === undefined);
  const val = (f) => (f.type === "string" || f.type === "text" ? `"${f.name} 1"` : f.type === "int" ? "1" : f.type === "float" ? "1.5" : f.type === "bool" ? "True" : JSON.stringify(f.values[0]));
  const payload = "{" + req.map((f) => `"${f.name}": ${val(f)}`).join(", ") + "}";
  const first = e.fields.find((f) => f.required && f.type === "string") || e.fields[0];
  const H = A ? ", headers=auth_headers" : "";
  const fx = A ? "client, auth_headers" : "client";
  const upd = first.type === "string" ? `{"${first.name}": "changed"}` : `{"${first.name}": ${first.type === "int" ? "9" : first.type === "float" ? "9.5" : first.type === "bool" ? "False" : JSON.stringify(first.values ? first.values[first.values.length - 1] : "x")}}`;
  return `def test_${e.snake}_emits_domain_events(${fx}):
    rec = Recorder()
    set_publisher(rec)
    id_ = client.post("/api/${e.plural}", json=${payload}${H}).json()["id"]
    client.put(f"/api/${e.plural}/{id_}", json=${upd}${H})
    client.delete(f"/api/${e.plural}/{id_}"${H})
    assert [x["type"] for x in rec.events] == ["${e.lower}.created", "${e.lower}.updated", "${e.lower}.deleted"]
    assert all(x["id"] and x["ts"] and x["data"]["id"] == id_ for x in rec.events)
    set_publisher(None)
`;
}).join("\n\n")}
def test_publish_failure_does_not_break_the_request(client${spec.needsAuth ? ", auth_headers" : ""}):
    class Broken:
        def publish(self, event):
            raise RuntimeError("broker down")

    set_publisher(Broken())
    r = client.post("/api/${spec.entities[0].plural}", json=${(() => {
      const e = spec.entities[0];
      const req = e.fields.filter((f) => f.required || f.default === undefined);
      const val = (f) => (f.type === "string" || f.type === "text" ? `"${f.name} 1"` : f.type === "int" ? "1" : f.type === "float" ? "1.5" : f.type === "bool" ? "True" : JSON.stringify(f.values[0]));
      return "{" + req.map((f) => `"${f.name}": ${val(f)}`).join(", ") + "}";
    })()}${spec.needsAuth ? ", headers=auth_headers" : ""})
    assert r.status_code == 201
    set_publisher(None)


${kind === "kafka" ? `def test_kafka_publisher_sends_json_event_to_topic():
    sent = []

    class FakeProducer:
        def send(self, topic, value):
            sent.append((topic, value))

    pub = events.KafkaPublisher(producer=FakeProducer(), topic="t")
    pub.publish(events.make_event("x.created", {"id": 1}))
    assert sent[0][0] == "t" and sent[0][1]["type"] == "x.created"


def test_kafka_publisher_swallows_send_errors():
    class Boom:
        def send(self, *a, **k):
            raise RuntimeError("down")

    events.KafkaPublisher(producer=Boom(), topic="t").publish(events.make_event("x", {}))
` : `def test_rabbit_publisher_declares_durable_queue_and_publishes():
    calls = {"declared": [], "published": []}

    class FakeChannel:
        def queue_declare(self, queue, durable):
            calls["declared"].append((queue, durable))

        def basic_publish(self, exchange, routing_key, body, properties):
            calls["published"].append((routing_key, body))

    pub = events.RabbitPublisher(channel=FakeChannel(), queue="q")
    pub.publish(events.make_event("x.created", {"id": 1}))
    assert calls["declared"] == [("q", True)]
    assert calls["published"][0][0] == "q"


def test_rabbit_publisher_swallows_publish_errors():
    class Boom:
        def queue_declare(self, **k):
            pass

        def basic_publish(self, **k):
            raise RuntimeError("down")

    events.RabbitPublisher(channel=Boom(), queue="q").publish(events.make_event("x", {}))
`}

def test_worker_retries_then_succeeds():
    attempts, dlq, sleeps = [], [], []

    def flaky(event):
        attempts.append(1)
        if len(attempts) < 3:
            raise RuntimeError("transient")

    ok = process_with_retry(flaky, {"id": "1"}, lambda e, err: dlq.append((e, err)), max_attempts=3, sleep=sleeps.append)
    assert ok and len(attempts) == 3 and not dlq
    assert sleeps == [0.5, 1.0]  # exponential backoff


def test_worker_dead_letters_after_max_attempts():
    dlq = []

    def always_fails(event):
        raise RuntimeError("poison")

    ok = process_with_retry(always_fails, {"id": "2"}, lambda e, err: dlq.append((e, err)), max_attempts=2, sleep=lambda s: None)
    assert not ok and dlq == [({"id": "2"}, "poison")]


def test_deduper_skips_redelivered_events():
    d = Deduper(capacity=2)
    assert d.seen("a") is False
    assert d.seen("a") is True
    d.seen("b")
    d.seen("c")  # evicts the oldest
    assert d.seen("a") is False
`;

const rabbitRealTestsPy = () => `"""Integration tests against a REAL RabbitMQ (AMQP_URL, default amqp://app:app@localhost:5672/). Skipped - never faked - if unreachable."""
import json
import os
import socket
import threading
import time
import uuid
from urllib.parse import urlparse

import pika
import pytest

from app.core.events import RabbitPublisher, make_event
from app.worker import RabbitWorker

URL = os.environ.get("AMQP_URL", "amqp://app:app@localhost:5672/")


@pytest.fixture(scope="module", autouse=True)
def broker():
    try:
        pika.BlockingConnection(pika.URLParameters(URL)).close()
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"RABBITMQ UNAVAILABLE at {URL}: {exc} - these tests need a real RabbitMQ")


class Proxy:
    """TCP forwarder in front of the broker so a test can cut every live connection (a real network failure)."""

    def __init__(self):
        u = urlparse(URL)
        self.target = (u.hostname or "localhost", u.port or 5672)
        self.srv = socket.socket()
        self.srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.srv.bind(("127.0.0.1", 0))
        self.srv.listen(16)
        self.port = self.srv.getsockname()[1]
        self.pairs, self.accepted, self.open = [], 0, True
        threading.Thread(target=self._accept, daemon=True).start()

    @property
    def url(self):
        u = urlparse(URL)
        return f"{u.scheme}://{u.username}:{u.password}@127.0.0.1:{self.port}{u.path or '/'}"

    def _accept(self):
        while self.open:
            try:
                c, _ = self.srv.accept()
            except OSError:
                return
            try:
                b = socket.create_connection(self.target)
            except OSError:
                c.close()
                continue
            self.accepted += 1
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

    def drop_all(self):
        for c, b in self.pairs:
            for x in (c, b):
                try:
                    x.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                x.close()
        self.pairs = []

    def close(self):
        self.open = False
        self.drop_all()
        self.srv.close()


@pytest.fixture()
def queue():
    q = "t-" + uuid.uuid4().hex[:10]
    yield q
    conn = pika.BlockingConnection(pika.URLParameters(URL))
    ch = conn.channel()
    for name in (q, q + ".dlq"):
        ch.queue_delete(queue=name)
    conn.close()


@pytest.fixture()
def proxy():
    p = Proxy()
    yield p
    p.close()


def wait_for(cond, timeout=15.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if cond():
            return True
        time.sleep(0.05)
    return False


def start(worker):
    t = threading.Thread(target=worker.run, daemon=True)
    t.start()
    return t


def stop(worker, t):
    worker.stop()
    t.join(timeout=10)
    assert not t.is_alive(), "worker did not stop"


def depth(q):
    conn = pika.BlockingConnection(pika.URLParameters(URL))
    n = conn.channel().queue_declare(queue=q, durable=True, passive=True).method.message_count
    conn.close()
    return n


def test_publish_consume_and_ack(queue):
    got = []
    w = RabbitWorker(URL, queue, handler=got.append, base_delay=0.01)
    t = start(w)
    pub = RabbitPublisher(queue=queue, url=URL)
    ev = make_event("x.created", {"id": 1})
    pub.publish(ev)
    assert wait_for(lambda: got and got[0]["id"] == ev["id"])
    assert wait_for(lambda: depth(queue) == 0)  # acked: nothing left, nothing unacked
    stop(w, t)
    pub.close()


def test_published_messages_are_persistent(queue):
    pub = RabbitPublisher(queue=queue, url=URL)
    pub.publish(make_event("x.created", {"id": 1}))
    conn = pika.BlockingConnection(pika.URLParameters(URL))
    method, props, body = conn.channel().basic_get(queue, auto_ack=True)
    conn.close()
    pub.close()
    assert props.delivery_mode == 2 and props.content_type == "application/json"
    assert json.loads(body)["type"] == "x.created"


def test_retry_then_success(queue):
    calls = []

    def flaky(event):
        calls.append(1)
        if len(calls) < 3:
            raise RuntimeError("transient")

    w = RabbitWorker(URL, queue, handler=flaky, max_attempts=3, base_delay=0.02)
    t = start(w)
    pub = RabbitPublisher(queue=queue, url=URL)
    pub.publish(make_event("x.created", {"id": 1}))
    assert wait_for(lambda: len(calls) == 3)
    assert wait_for(lambda: depth(queue) == 0)
    assert depth(queue + ".dlq") == 0  # recovered: nothing dead-lettered
    stop(w, t)
    pub.close()


def test_poison_message_is_dead_lettered_with_error(queue):
    def poison(event):
        raise RuntimeError("cannot process")

    w = RabbitWorker(URL, queue, handler=poison, max_attempts=2, base_delay=0.01)
    t = start(w)
    pub = RabbitPublisher(queue=queue, url=URL)
    ev = make_event("x.created", {"id": 7})
    pub.publish(ev)
    assert wait_for(lambda: depth(queue + ".dlq") == 1)
    assert wait_for(lambda: depth(queue) == 0)  # the main queue is not blocked by the poison message
    conn = pika.BlockingConnection(pika.URLParameters(URL))
    _, _, body = conn.channel().basic_get(queue + ".dlq", auto_ack=True)
    conn.close()
    rec = json.loads(body)
    assert rec["event"]["id"] == ev["id"] and "cannot process" in rec["error"]
    stop(w, t)
    pub.close()


def test_undecodable_message_goes_to_dlq(queue):
    w = RabbitWorker(URL, queue, handler=lambda e: None, base_delay=0.01)
    t = start(w)
    assert wait_for(lambda: w.connections >= 1)
    conn = pika.BlockingConnection(pika.URLParameters(URL))
    conn.channel().basic_publish(exchange="", routing_key=queue, body=b"not json{")
    conn.close()
    assert wait_for(lambda: depth(queue + ".dlq") == 1)
    stop(w, t)


def test_consumer_reconnects_after_connection_loss(queue, proxy):
    got = []
    w = RabbitWorker(proxy.url, queue, handler=got.append, base_delay=0.01, reconnect_delay=0.1)
    t = start(w)
    assert wait_for(lambda: w.connections == 1)
    proxy.drop_all()  # network failure while idle
    assert wait_for(lambda: w.connections == 2), "consumer did not reconnect"
    pub = RabbitPublisher(queue=queue, url=URL)  # publish directly to the broker
    ev = make_event("x.created", {"id": 2})
    pub.publish(ev)
    assert wait_for(lambda: got and got[0]["id"] == ev["id"])
    stop(w, t)
    pub.close()


def test_unacked_message_is_redelivered_after_connection_loss(queue, proxy):
    calls = []

    def handler(event):
        calls.append(event["id"])
        if len(calls) == 1:
            proxy.drop_all()  # the connection dies while the message is being processed (before the ack)
            time.sleep(0.3)

    w = RabbitWorker(proxy.url, queue, handler=handler, base_delay=0.01, reconnect_delay=0.1)
    t = start(w)
    assert wait_for(lambda: w.connections == 1)
    pub = RabbitPublisher(queue=queue, url=URL)
    ev = make_event("x.created", {"id": 3})
    pub.publish(ev)
    assert wait_for(lambda: len(calls) == 2), "message was lost instead of redelivered"
    assert calls[0] == calls[1] == ev["id"]  # at-least-once: handler must be idempotent
    assert wait_for(lambda: depth(queue) == 0)
    stop(w, t)
    pub.close()


def test_publisher_reconnects_after_connection_loss(queue, proxy):
    pub = RabbitPublisher(queue=queue, url=proxy.url)
    pub.publish(make_event("x.created", {"id": 1}))
    proxy.drop_all()
    ev = make_event("x.created", {"id": 2})
    pub.publish(ev)  # first attempt fails on the dead socket, the publisher reconnects and retries
    conn = pika.BlockingConnection(pika.URLParameters(URL))
    ids = []
    while True:
        method, props, body = conn.channel().basic_get(queue, auto_ack=True)
        if method is None:
            break
        ids.append(json.loads(body)["id"])
    conn.close()
    pub.close()
    assert ev["id"] in ids and len(ids) == 2
    assert proxy.accepted >= 2


def test_publish_when_broker_is_unreachable_never_raises(queue):
    pub = RabbitPublisher(queue=queue, url=URL)
    pub._url = "amqp://app:app@127.0.0.1:1/"  # simulate the broker going away for good
    pub._conn = None
    pub.publish(make_event("x.created", {"id": 1}))  # logged, not raised
    pub.close()
`;

module.exports = { cachePy, eventsPy, workerPy, cacheTestsPy, eventsTestsPy, rabbitRealTestsPy };
