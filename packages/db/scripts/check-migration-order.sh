#!/usr/bin/env bash
# D#94 R1: merge-monotonic migration numbering. Refuses a PR whose new
# packages/db/migrations/*.sql file does not sort strictly after every
# migration file already on the PR's base, refuses a rename or edit of an
# existing migration file (unless explicitly allowed via
# MIGRATION_ORDER_ALLOW_EDIT), and refuses two files sharing a four-digit
# prefix. See packages/db/migrations/README.md for the rule (R1-R3).
#
# Usage: check-migration-order.sh [--base <ref>]
#   --base <ref>   overrides MIGRATION_ORDER_BASE, which overrides the
#                   default origin/main. In CI (pull_request and push to
#                   main), MIGRATION_ORDER_BASE is set to HEAD^1 -- see
#                   .github/workflows/ci.yml. Locally, origin/main can be
#                   stale, which can only make this check MISS a
#                   violation, never invent one against an up-to-date
#                   main -- CI is the authority.
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
      echo "migration-order: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

# Run from the repo this checkout (or a throwaway test fixture repo)
# belongs to, not from wherever this script happens to be installed --
# tests/test_check_migration_order.sh invokes this same script against a
# disposable git repo, so resolution must follow the caller's cwd.
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

MIGRATIONS_DIR="packages/db/migrations"

if ! MERGE_BASE="$(git merge-base HEAD "$BASE_REF" 2>/dev/null)"; then
  echo "migration-order: cannot resolve base $BASE_REF — refusing to pass" >&2
  exit 2
fi

# The greatest .sql name already on the base -- the sort threshold every
# added file must clear. Read from the BASE REF's own tip
# (${BASE_REF}:${MIGRATIONS_DIR}), NOT from the merge base. R1's rule is
# "every file already on <base>" (packages/db/migrations/README.md), and
# <base> means the base ref itself, re-checked on every run -- not "every
# file present when this branch last forked or rebased from it", which is
# what the merge base gives on an un-rebased branch. Using the merge base
# here lets a stale, un-rebased branch pass against an outdated threshold
# even when the base ref itself is fully up to date: a branch cut before
# the base gains a higher-numbered file, then adding a file that sorts
# below that new file but above the fork point, would wrongly pass. CI
# still agrees with a base-tip read: MIGRATION_ORDER_BASE is set to
# HEAD^1 there, and HEAD^1 IS the base's tip at merge time, so reading
# its own tip and reading merge-base(HEAD, HEAD^1) give the same tree.
# The merge base is kept below, but only to scope the added / modified /
# deleted / renamed diff to this branch's own changes.
if ! BASE_TREE_LISTING="$(git ls-tree --name-only "${BASE_REF}:${MIGRATIONS_DIR}" 2>&1)"; then
  echo "migration-order: cannot read ${BASE_REF}:${MIGRATIONS_DIR} via git ls-tree — refusing to pass (${BASE_TREE_LISTING})" >&2
  exit 2
fi
BASE_FILES="$(printf '%s\n' "$BASE_TREE_LISTING" | grep -E '\.sql$' || true)"
BASE_MAX="$(printf '%s\n' "$BASE_FILES" | sort | tail -1)"

VIOLATIONS=()

# This branch's changes to *.sql files under migrations/ (README.md and
# any other non-.sql file there is the migration runner's own business,
# not this check's -- see migrate.ts:41), relative to the merge base --
# rename detection on, so a plain `git mv` shows as R, not D+A. Raw
# format (not --name-status) so the destination git mode is available:
# that is what catches an existing migration swapped for a symlink (type
# change, status T) or a brand-new migration added as one (status A,
# mode 120000) -- both read fine with `readFileSync` in migrate.ts,
# silently applying whatever the link points at under the old/new name.
# T is included in --diff-filter, but deliberately NOT given its own
# case below: any status this loop doesn't recognize -- including T --
# falls into the catch-all default, which records a violation rather
# than silently ignoring it the way a missing `case` branch would.
CHANGES="$(git diff --raw -M --diff-filter=ADMRT "$MERGE_BASE" HEAD -- "${MIGRATIONS_DIR}/*.sql")"

ADDED_FILES=()
MODIFIED_FILES=()
DELETED_FILES=()
RENAMED_PAIRS=()

while IFS=$'\t' read -r meta path1 path2; do
  [ -z "$meta" ] && continue
  meta="${meta#:}"
  read -r old_mode new_mode old_sha new_sha status <<< "$meta"
  status_letter="${status:0:1}"
  base_a="$(basename "$path1")"
  case "$status_letter" in
    A)
      ADDED_FILES+=("$base_a")
      if [ "$new_mode" = "120000" ]; then
        VIOLATIONS+=("migration-order: $base_a: added as a symlink (mode 120000), refusing")
      fi
      ;;
    M)
      MODIFIED_FILES+=("$base_a")
      if [ "$new_mode" = "120000" ]; then
        VIOLATIONS+=("migration-order: $base_a: modified into a symlink (mode 120000), refusing")
      fi
      ;;
    D) DELETED_FILES+=("$base_a") ;;
    R) RENAMED_PAIRS+=("$base_a -> $(basename "$path2")") ;;
    *) VIOLATIONS+=("migration-order: $base_a: unexpected git status '$status' -- refusing to guess (known: A, M, D, R)") ;;
  esac
done <<< "$CHANGES"

IFS=',' read -ra ALLOWED_EDITS <<< "${MIGRATION_ORDER_ALLOW_EDIT:-}"

# Every file on HEAD, for the duplicate four-digit-prefix check.
HEAD_FILES="$(git ls-tree --name-only "HEAD:${MIGRATIONS_DIR}" 2>/dev/null | grep -E '\.sql$' || true)"
DUP_PREFIXES="$(printf '%s\n' "$HEAD_FILES" | cut -c1-4 | sort | uniq -d)"

for f in ${ADDED_FILES[@]+"${ADDED_FILES[@]}"}; do
  if ! [[ "$f" =~ ^[0-9]{4}_[a-z0-9_]+\.sql$ ]]; then
    VIOLATIONS+=("migration-order: $f: name does not match ^[0-9]{4}_[a-z0-9_]+\\.sql\$")
  fi
  if [ -n "$BASE_MAX" ] && [[ ! "$f" > "$BASE_MAX" ]]; then
    VIOLATIONS+=("migration-order: $f: sorts at or before base max $BASE_MAX")
  fi
done

if [ -n "$DUP_PREFIXES" ]; then
  while read -r prefix; do
    [ -z "$prefix" ] && continue
    dup_files="$(printf '%s\n' "$HEAD_FILES" | grep "^$prefix" | tr '\n' ' ')"
    VIOLATIONS+=("migration-order: duplicate four-digit prefix $prefix: $dup_files")
  done <<< "$DUP_PREFIXES"
fi

for f in ${MODIFIED_FILES[@]+"${MODIFIED_FILES[@]}"}; do
  allowed=false
  for a in ${ALLOWED_EDITS[@]+"${ALLOWED_EDITS[@]}"}; do
    [ "$a" = "$f" ] && allowed=true && break
  done
  if [ "$allowed" = false ]; then
    VIOLATIONS+=("migration-order: $f: modified relative to base (set MIGRATION_ORDER_ALLOW_EDIT=$f for a Spec-approved scoped edit)")
  fi
done

for pair in ${RENAMED_PAIRS[@]+"${RENAMED_PAIRS[@]}"}; do
  VIOLATIONS+=("migration-order: renamed relative to base: $pair")
done

for f in ${DELETED_FILES[@]+"${DELETED_FILES[@]}"}; do
  VIOLATIONS+=("migration-order: $f: removed relative to base")
done

if [ "${#VIOLATIONS[@]}" -gt 0 ]; then
  printf '%s\n' "${VIOLATIONS[@]}" >&2
  exit 1
fi

echo "migration-order: OK (${#ADDED_FILES[@]} new, base max ${BASE_MAX:-none})"
