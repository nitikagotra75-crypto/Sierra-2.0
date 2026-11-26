#!/usr/bin/env bash
# Private MySQL 8 instance for Sierra's tests (port 3307, user app/app, database app). No Docker needed.
set -euo pipefail
D=${SIERRA_MYSQL_DIR:-/tmp/sierra-mysql}
PORT=${SIERRA_MYSQL_PORT:-3307}
if mysqladmin --protocol=tcp -h127.0.0.1 -P"$PORT" -uroot ping >/dev/null 2>&1; then echo "MySQL already running on :$PORT"; exit 0; fi
mkdir -p "$D"; chown -R mysql:mysql "$D"
if [ ! -d "$D/data/mysql" ]; then mysqld --no-defaults --initialize-insecure --user=mysql --datadir="$D/data" >"$D/init.log" 2>&1; fi
nohup mysqld --no-defaults --user=mysql --datadir="$D/data" --port="$PORT" --bind-address=127.0.0.1 --socket="$D/mysql.sock" --mysqlx=OFF --pid-file="$D/mysql.pid" >"$D/mysqld.log" 2>&1 &
for i in $(seq 1 60); do mysqladmin --protocol=tcp -h127.0.0.1 -P"$PORT" -uroot ping >/dev/null 2>&1 && break; sleep 1; done
mysql --protocol=tcp -h127.0.0.1 -P"$PORT" -uroot -e "CREATE DATABASE IF NOT EXISTS app; CREATE USER IF NOT EXISTS 'app'@'%' IDENTIFIED BY 'app'; GRANT ALL ON *.* TO 'app'@'%'; FLUSH PRIVILEGES;"
echo "MySQL ready: app:app@tcp(127.0.0.1:$PORT)/app"
