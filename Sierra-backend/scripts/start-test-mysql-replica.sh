#!/usr/bin/env bash
# Private MySQL 8 ASYNC REPLICA of the test primary started by scripts/start-test-mysql.sh (primary :3307, replica :3308).
# Classic binlog-position replication; the replica is super_read_only, so a write that reaches it fails loudly.
#   export SIERRA_TEST_GO_MYSQL_URL=mysql://app:app@127.0.0.1:3307/app
#   export SIERRA_TEST_GO_MYSQL_REPLICA_URL=mysql://app:app@127.0.0.1:3308/app
set -euo pipefail
here=$(dirname "$0")
bash "$here/start-test-mysql.sh" >/dev/null
P=${SIERRA_MYSQL_PORT:-3307}; RPORT=${SIERRA_MYSQL_REPLICA_PORT:-3308}
RD=${SIERRA_MYSQL_REPLICA_DIR:-/tmp/sierra-mysql-replica}
pm() { mysql --protocol=tcp -h127.0.0.1 -P"$P" -uroot "$@"; }
rm_() { mysql --protocol=tcp -h127.0.0.1 -P"$RPORT" -uroot "$@"; }
if mysqladmin --protocol=tcp -h127.0.0.1 -P"$RPORT" -uroot ping >/dev/null 2>&1 && [ "$(rm_ -Nse "SELECT COUNT(*) FROM performance_schema.replication_applier_status WHERE SERVICE_STATE='ON'")" = "1" ]; then echo "replica already running on :$RPORT"; exit 0; fi
mysqladmin --protocol=tcp -h127.0.0.1 -P"$RPORT" -uroot shutdown >/dev/null 2>&1 || true
sleep 1; rm -rf "$RD"; mkdir -p "$RD"; chown -R mysql:mysql "$RD"
pm -e "CREATE USER IF NOT EXISTS 'repl'@'%' IDENTIFIED BY 'repl'; GRANT REPLICATION SLAVE ON *.* TO 'repl'@'%'; FLUSH PRIVILEGES;"
# the replica is seeded from a --source-data dump below, so replication starts at exactly the dump's binlog position
mysqld --no-defaults --initialize-insecure --user=mysql --datadir="$RD/data" >"$RD/init.log" 2>&1
nohup mysqld --no-defaults --user=mysql --datadir="$RD/data" --port="$RPORT" --bind-address=127.0.0.1 --socket="$RD/mysql.sock" --mysqlx=OFF --pid-file="$RD/mysql.pid" --server-id=2 --skip-log-bin --relay-log="$RD/relay" >"$RD/mysqld.log" 2>&1 &
for i in $(seq 1 60); do rm_ -e "SELECT 1" >/dev/null 2>&1 && break; sleep 1; done
# consistent dump of the primary's app database; its header records the binlog file/position to stream from
DUMP=$(mktemp)
mysqldump --protocol=tcp -h127.0.0.1 -P"$P" -uroot --single-transaction --source-data=2 --databases app --set-gtid-purged=OFF > "$DUMP" 2>/dev/null || mysqldump --protocol=tcp -h127.0.0.1 -P"$P" -uroot --single-transaction --master-data=2 --databases app > "$DUMP"
LOGFILE=$(grep -m1 -oP "SOURCE_LOG_FILE='\K[^']+|MASTER_LOG_FILE='\K[^']+" "$DUMP")
LOGPOS=$(grep -m1 -oP "SOURCE_LOG_POS=\K[0-9]+|MASTER_LOG_POS=\K[0-9]+" "$DUMP")
rm_ < "$DUMP"; rm -f "$DUMP"
rm_ -e "CREATE USER IF NOT EXISTS 'app'@'%' IDENTIFIED BY 'app'; GRANT ALL ON *.* TO 'app'@'%'; FLUSH PRIVILEGES;
CHANGE REPLICATION SOURCE TO SOURCE_HOST='127.0.0.1', SOURCE_PORT=$P, SOURCE_USER='repl', SOURCE_PASSWORD='repl', SOURCE_LOG_FILE='$LOGFILE', SOURCE_LOG_POS=$LOGPOS, GET_SOURCE_PUBLIC_KEY=1;
START REPLICA; SET PERSIST super_read_only=ON; SET GLOBAL super_read_only=ON;"
for i in $(seq 1 30); do [ "$(rm_ -Nse "SELECT COUNT(*) FROM performance_schema.replication_applier_status WHERE SERVICE_STATE='ON'")" = "1" ] && break; sleep 1; done
echo "MySQL replica ready on :$RPORT (source :$P, $LOGFILE:$LOGPOS)"
