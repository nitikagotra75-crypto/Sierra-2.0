#!/usr/bin/env bash
mysqladmin --protocol=tcp -h127.0.0.1 -P"${SIERRA_MYSQL_PORT:-3307}" -uroot shutdown 2>/dev/null || true
