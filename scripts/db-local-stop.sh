#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
PG="$(brew --prefix postgresql@17)/bin"
"$PG/pg_ctl" -D .pgdata stop
