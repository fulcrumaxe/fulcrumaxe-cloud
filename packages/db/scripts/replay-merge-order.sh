#!/usr/bin/env bash
# D#94 criterion 5: a historical audit, run once for this PR and re-runnable
# by hand afterward. It is deliberately NOT wired into scripts/check.sh --
# CI's checkout is shallow (fetch-depth: 2, just enough for
# check-migration-order.sh's HEAD^1), so it has no history to replay.
#
# For every .sql file present on <base>, this orders them by the commit
# that FIRST added each one (merge order -- the order a live database
# upgraded PR by PR actually applied them in), applies that order to one
# throwaway database, applies plain lexical order (what a fresh install
# applies, per migrate.ts's readdirSync().sort()) to a second, and diffs
# the resulting schemas with neon-shape-catalog.sql. An empty diff proves
# the two orders are interchangeable for every file already on <base> --
# see packages/db/migrations/README.md for why that's expected to hold.
#
# Usage: replay-merge-order.sh [--base <ref>]
set -euo pipefail

LC_ALL=C
export LC_ALL

BASE_REF="${MIGRATION_ORDER_BASE:-origin/main}"
while [ $# -gt 0 ]; do
  case "$1" in
    --base)
      BASE_REF="${2:?--base requires a ref}"
      shift 2
      ;;
    *)
      echo "replay-merge-order: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

MIGRATIONS_DIR="packages/db/migrations"
CATALOG_SQL="$REPO_ROOT/packages/db/scripts/neon-shape-catalog.sql"

if ! git merge-base HEAD "$BASE_REF" >/dev/null 2>&1; then
  echo "replay-merge-order: cannot resolve base $BASE_REF — refusing to pass" >&2
  exit 2
fi

# Every .sql file present on the base, right now -- the same universe
# check-migration-order.sh's BASE_MAX is drawn from.
BASE_FILES="$(git ls-tree --name-only "${BASE_REF}:${MIGRATIONS_DIR}" 2>/dev/null | grep -E '\.sql$' || true)"
if [ -z "$BASE_FILES" ]; then
  echo "replay-merge-order: no .sql files found on $BASE_REF -- nothing to replay" >&2
  exit 2
fi

# Order each file by the commit timestamp of the commit that first added
# it (git log --diff-filter=A on a squash-merged history gives one add
# commit per file), searched within the base's own history so a file
# that hasn't reached <base> yet can't be picked up. Ties (same commit
# adding more than one file) break on filename, for a stable order.
#
# Arrays throughout (never a bare `for f in $VAR`) so a filename is never
# handed to word splitting or globbing -- R1's name pattern already
# excludes spaces and shell metacharacters, but this loop shouldn't rely
# on that to stay safe.
mapfile -t BASE_FILES_ARR <<< "$BASE_FILES"

MERGE_ORDER_LINES=""
for f in "${BASE_FILES_ARR[@]}"; do
  ts="$(git log "$BASE_REF" --diff-filter=A --format=%ct -- "${MIGRATIONS_DIR}/${f}" 2>/dev/null | tail -1)"
  if [ -z "$ts" ]; then
    echo "replay-merge-order: could not find an add-commit for $f on $BASE_REF — refusing to pass" >&2
    exit 2
  fi
  MERGE_ORDER_LINES="${MERGE_ORDER_LINES}${ts}	${f}
"
done

mapfile -t MERGE_ORDER_FILES_ARR < <(printf '%s' "$MERGE_ORDER_LINES" | sort -k1,1n -k2,2 | cut -f2)
mapfile -t LEXICAL_ORDER_FILES_ARR < <(printf '%s\n' "$BASE_FILES" | sort)

echo "replay-merge-order: merge order used:"
printf '  %s\n' "${MERGE_ORDER_FILES_ARR[@]}"

PG_TMP_DIR="$(mktemp -d)"
PGDATA_DIR="$PG_TMP_DIR/data"
PG_PORT=$(( (RANDOM % 5000) + 15432 ))

cleanup() {
  pg_ctl -D "$PGDATA_DIR" -m fast stop >/dev/null 2>&1 || true
  rm -rf "$PG_TMP_DIR"
}
trap cleanup EXIT

initdb -D "$PGDATA_DIR" -U postgres --auth=trust --no-locale >"$PG_TMP_DIR/initdb.log" 2>&1
{
  echo "listen_addresses = ''"
  echo "port = $PG_PORT"
  echo "unix_socket_directories = '$PG_TMP_DIR'"
} >> "$PGDATA_DIR/postgresql.conf"
pg_ctl -D "$PGDATA_DIR" -l "$PG_TMP_DIR/postgres.log" -w start

PSQL=(psql -h "$PG_TMP_DIR" -p "$PG_PORT" -U postgres -X -q -v ON_ERROR_STOP=1)

"${PSQL[@]}" -d postgres -c "CREATE DATABASE replay_merge;"
"${PSQL[@]}" -d postgres -c "CREATE DATABASE replay_lexical;"

# Read file CONTENT from the base ref's git object, not this worktree's
# disk -- this worktree can be behind $BASE_REF (its own PR hasn't
# rebased onto every migration merged since it branched), and the base's
# object store always has the right bytes regardless.
echo "==> applying merge order to replay_merge"
for f in "${MERGE_ORDER_FILES_ARR[@]}"; do
  git show "${BASE_REF}:${MIGRATIONS_DIR}/${f}" | "${PSQL[@]}" -d replay_merge
done

echo "==> applying lexical order to replay_lexical"
for f in "${LEXICAL_ORDER_FILES_ARR[@]}"; do
  git show "${BASE_REF}:${MIGRATIONS_DIR}/${f}" | "${PSQL[@]}" -d replay_lexical
done

echo "==> diffing neon-shape-catalog.sql between replay_merge and replay_lexical"
"${PSQL[@]}" -d replay_merge -A -F'|' -f "$CATALOG_SQL" > "$PG_TMP_DIR/catalog_merge.txt"
"${PSQL[@]}" -d replay_lexical -A -F'|' -f "$CATALOG_SQL" > "$PG_TMP_DIR/catalog_lexical.txt"

if ! diff -u "$PG_TMP_DIR/catalog_merge.txt" "$PG_TMP_DIR/catalog_lexical.txt"; then
  echo "replay-merge-order: catalog diff FAILED (merge order vs lexical order, see diff above) -- stop and report it, don't rename anything" >&2
  exit 1
fi

echo "replay-merge-order: OK ($(printf '%s\n' "$BASE_FILES" | wc -l | tr -d ' ') files, empty diff)"
