#!/usr/bin/env bash
set -euo pipefail

# Runs @fx/core's test suite. test/unit/** needs no database; test/pg/**
# needs the real RLS/grants behaviour from @fx/db's migrations, so this
# mirrors packages/db/scripts/test-pg.sh exactly (same env var contract,
# same throwaway-cluster fallback) rather than inventing a second way to
# stand up Postgres for tests.
#
# - If DATABASE_URL_TEST is set, use that database directly (a developer's
#   own Postgres, or CI-provided) instead of spinning up a throwaway
#   cluster. DATABASE_URL_APP_USER and DATABASE_URL_PLATFORM_OPS must also
#   be set in that case (same host/port/db, connecting as role app_user /
#   platform_ops respectively).
# - Otherwise, initdb + pg_ctl a brand-new, disposable cluster in a temp
#   dir, torn down on exit regardless of the test outcome.

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ -n "${DATABASE_URL_TEST:-}" ]; then
  export DATABASE_URL="$DATABASE_URL_TEST"
  : "${DATABASE_URL_APP_USER:?DATABASE_URL_APP_USER must be set alongside DATABASE_URL_TEST (same host/port/db, user=app_user)}"
  : "${DATABASE_URL_PLATFORM_OPS:?DATABASE_URL_PLATFORM_OPS must be set alongside DATABASE_URL_TEST (same host/port/db, user=platform_ops)}"
  exec pnpm exec vitest run "$@"
fi

PG_TMP_DIR="$(mktemp -d)"
PGDATA_DIR="$PG_TMP_DIR/data"
PG_PORT=$(( (RANDOM % 5000) + 25432 ))

cleanup() {
  pg_ctl -D "$PGDATA_DIR" -m fast stop >/dev/null 2>&1 || true
  rm -rf "$PG_TMP_DIR"
}
trap cleanup EXIT

initdb -D "$PGDATA_DIR" -U postgres --auth=trust --no-locale >"$PG_TMP_DIR/initdb.log" 2>&1

{
  echo "listen_addresses = '127.0.0.1'"
  echo "port = $PG_PORT"
  echo "unix_socket_directories = '$PG_TMP_DIR'"
} >> "$PGDATA_DIR/postgresql.conf"

pg_ctl -D "$PGDATA_DIR" -l "$PG_TMP_DIR/postgres.log" -w start

createdb -h 127.0.0.1 -p "$PG_PORT" -U postgres fx_core_test

export DATABASE_URL="postgres://postgres@127.0.0.1:${PG_PORT}/fx_core_test"
export DATABASE_URL_APP_USER="postgres://app_user@127.0.0.1:${PG_PORT}/fx_core_test"
export DATABASE_URL_PLATFORM_OPS="postgres://platform_ops@127.0.0.1:${PG_PORT}/fx_core_test"

pnpm exec vitest run "$@"
