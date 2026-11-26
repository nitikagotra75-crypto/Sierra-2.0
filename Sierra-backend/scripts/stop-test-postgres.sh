#!/usr/bin/env bash
BIN=$(ls -d /usr/lib/postgresql/*/bin | tail -1)
for d in replica primary; do su postgres -s /bin/bash -c "$BIN/pg_ctl -D /tmp/sierra-pg/$d -m fast stop" >/dev/null 2>&1 || true; done
