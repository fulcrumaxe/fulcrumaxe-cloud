#!/usr/bin/env bash
set -euo pipefail

# Runs @fx/webhooks's test suite. Mirrors packages/model-connection/scripts/
# test-pg.sh exactly (same env var contract, same throwaway-cluster
# fallback): every test here needs real RLS/grants/SKIP LOCKED behaviour,
# so a mocked pg client couldn't prove criteria 5-8 or 12.
#
# DATABASE_URL_TEST set -> use that database directly (with
# DATABASE_URL_APP_USER/DATABASE_URL_PLATFORM_OPS alongside it). Otherwise
# initdb + pg_ctl a disposable cluster, torn down on exit.

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ -n "${DATABASE_URL_TEST:-}" ]; then
  export DATABASE_URL="$DATABASE_URL_TEST"
  : "${DATABASE_URL_APP_USER:?DATABASE_URL_APP_USER must be set alongside DATABASE_URL_TEST (same host/port/db, user=app_user)}"
  : "${DATABASE_URL_PLATFORM_OPS:?DATABASE_URL_PLATFORM_OPS must be set alongside DATABASE_URL_TEST (same host/port/db, user=platform_ops)}"
  exec pnpm exec vitest run "$@"
fi

PG_TMP_DIR="$(mktemp -d)"
PGDATA_DIR="$PG_TMP_DIR/data"
PG_PORT=$(( (RANDOM % 5000) + 45432 ))

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

createdb -h 127.0.0.1 -p "$PG_PORT" -U postgres fx_webhooks_test

export DATABASE_URL="postgres://postgres@127.0.0.1:${PG_PORT}/fx_webhooks_test"
export DATABASE_URL_APP_USER="postgres://app_user@127.0.0.1:${PG_PORT}/fx_webhooks_test"
export DATABASE_URL_PLATFORM_OPS="postgres://platform_ops@127.0.0.1:${PG_PORT}/fx_webhooks_test"

pnpm exec vitest run "$@"
