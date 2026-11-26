#!/usr/bin/env bash
# Private Postgres 16 PRIMARY (:5440) + STREAMING REPLICA (:5441) for the read/write-splitting integration tests.
# Needs the apt package `postgresql` and root (initdb refuses to run as root, so it runs as the postgres user).
#   export SIERRA_TEST_PG_PRIMARY=postgresql+psycopg2://app:app@127.0.0.1:5440/app
#   export SIERRA_TEST_PG_REPLICA=postgresql+psycopg2://app:app@127.0.0.1:5441/app
set -euo pipefail
BIN=$(ls -d /usr/lib/postgresql/*/bin | tail -1)
ROOT=/tmp/sierra-pg
P=$ROOT/primary; R=$ROOT/replica
run() { su postgres -s /bin/bash -c "$*"; }
rm -rf "$ROOT"; mkdir -p "$ROOT"; chown postgres:postgres "$ROOT"
run "$BIN/initdb -D $P -U postgres -A trust >/dev/null"
cat >> $P/postgresql.conf <<CONF
port = 5440
listen_addresses = '127.0.0.1'
unix_socket_directories = '$ROOT'
wal_level = replica
max_wal_senders = 10
hot_standby = on
CONF
echo "host replication replicator 127.0.0.1/32 trust" >> $P/pg_hba.conf
echo "host all all 127.0.0.1/32 trust" >> $P/pg_hba.conf
run "$BIN/pg_ctl -D $P -l $ROOT/primary.log -w start >/dev/null"
run "psql -h 127.0.0.1 -p 5440 -U postgres -c \"CREATE ROLE replicator REPLICATION LOGIN PASSWORD 'repl'\" -c \"CREATE ROLE app SUPERUSER LOGIN PASSWORD 'app'\" -c \"CREATE DATABASE app OWNER app\" >/dev/null"
run "$BIN/pg_basebackup -h 127.0.0.1 -p 5440 -U replicator -D $R -R -X stream >/dev/null"
sed -i "s/^port = 5440/port = 5441/" $R/postgresql.conf
run "$BIN/pg_ctl -D $R -l $ROOT/replica.log -w start >/dev/null"
echo "primary :5440, replica :5441 (streaming)"
