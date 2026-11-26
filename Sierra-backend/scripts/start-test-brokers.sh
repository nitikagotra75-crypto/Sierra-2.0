#!/usr/bin/env bash
# Starts PRIVATE throwaway services for Sierra's real-integration tests (no Docker needed; apt packages are enough):
#   RabbitMQ on :5673 (user app/app)        -> export SIERRA_TEST_AMQP_URL=amqp://app:app@localhost:5673/
# Requires: apt-get install rabbitmq-server (root). Stop with scripts/stop-test-brokers.sh.
set -euo pipefail
export RABBITMQ_NODENAME=sierra_t@localhost RABBITMQ_NODE_PORT=5673 RABBITMQ_DIST_PORT=25673
export RABBITMQ_MNESIA_BASE=/tmp/rmq/mnesia RABBITMQ_LOG_BASE=/tmp/rmq/log RABBITMQ_ENABLED_PLUGINS_FILE=/tmp/rmq/plugins RABBITMQ_PID_FILE=/tmp/rmq/pid
mkdir -p /tmp/rmq/mnesia /tmp/rmq/log && echo "[]." > /tmp/rmq/plugins
id rabbitmq >/dev/null 2>&1 && chown -R rabbitmq:rabbitmq /tmp/rmq
(nohup rabbitmq-server >/tmp/rmq/start.log 2>&1 &)
for _ in $(seq 1 40); do rabbitmqctl -n "$RABBITMQ_NODENAME" await_startup >/dev/null 2>&1 && break; sleep 2; done
rabbitmqctl -n "$RABBITMQ_NODENAME" add_user app app >/dev/null 2>&1 || true
rabbitmqctl -n "$RABBITMQ_NODENAME" set_permissions -p / app ".*" ".*" ".*" >/dev/null
echo "RabbitMQ ready: export SIERRA_TEST_AMQP_URL=amqp://app:app@localhost:5673/"
