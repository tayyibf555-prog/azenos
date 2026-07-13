#!/usr/bin/env bash
# Project-local Postgres (Homebrew postgresql@17 + pgvector) on 127.0.0.1:54329.
# Chosen over Docker for local dev — see docs/DECISIONS.md (disk constraints).
set -euo pipefail
cd "$(dirname "$0")/.."
PG="$(brew --prefix postgresql@17)/bin"
export LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8

if [ ! -d .pgdata ]; then
  "$PG/initdb" -D .pgdata --auth=trust --username=postgres -E UTF8
fi
mkdir -p .pgdata-log

if ! "$PG/pg_isready" -h 127.0.0.1 -p 54329 -q 2>/dev/null; then
  "$PG/pg_ctl" -D .pgdata -l .pgdata-log/postgres.log \
    -o "-p 54329 -c listen_addresses=127.0.0.1" start
fi

"$PG/createdb" -h 127.0.0.1 -p 54329 -U postgres azen_os 2>/dev/null || true
"$PG/psql" -h 127.0.0.1 -p 54329 -U postgres -d azen_os -qc \
  "CREATE EXTENSION IF NOT EXISTS vector" >/dev/null

echo "Postgres ready on 127.0.0.1:54329 (db: azen_os)"
