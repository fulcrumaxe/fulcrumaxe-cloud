#!/usr/bin/env bash
# scripts/check-globalsetup-env.sh — D#56 guard.
#
# Fails, naming file and line, if any packages/*/test/globalSetup.ts or
# apps/*/test/globalSetup.ts (relative to --root, default: the repo this
# script lives in) contains an assignment to `process.env.<anything>`, or a
# `Math.random()` port expression.
#
# WHY. `vitest.workspace.ts` runs every project's globalSetup in ONE shared
# orchestrator process before any project's test workers fork, so
# `process.env` there is that process's single shared object -- a WRITE in
# one project's globalSetup can be overwritten by another project's
# globalSetup before this project's own test workers fork and read it back.
# That is D#56's root cause (see packages/db/test/support/ephemeral-pg.ts's
# header). The fix is `provide()`/`inject()` plus a worker-side
# `bind-test-env.ts` setupFile instead -- this guard is what keeps that fix
# from regressing. Reads of `process.env` are fine and stay in every
# globalSetup (the `DATABASE_URL_TEST` override path reads it); only WRITES
# are forbidden, which is why the pattern below requires an `=` right after
# the property name, not just the name appearing anywhere on the line.
#
# `Math.random()` is the OTHER D#56 defect: a port picked this way has no
# collision guard against another project's cluster. ephemeral-pg.ts asks
# the OS for a free port (bind 127.0.0.1:0) instead, with a bounded retry
# for the small window between releasing that port and Postgres binding it.
#
# --root lets this run against a tree that ISN'T this checkout -- see
# tests/test_check_globalsetup_env.sh, which points it at synthetic
# fixtures, and this task's own PR description, which points it at copies
# of two other open PRs' still-unconverted globalSetup.ts files.
#
# Usage:
#   bash scripts/check-globalsetup-env.sh [--root DIR]
#
# Exit 0 = every globalSetup.ts found under --root is clean (or none exist
#          -- a workspace with no DB-backed package yet is not a failure).
# Exit 1 = at least one hit.
# Exit 2 = usage error, or --root does not exist.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root)
      if [[ -z "${2:-}" ]]; then
        echo "error: --root requires a directory" >&2
        exit 2
      fi
      ROOT="$2"
      shift 2
      ;;
    -h|--help)
      sed -n '/^# Usage:/,/^# Exit 2/p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ ! -d "$ROOT" ]]; then
  echo "error: --root directory does not exist: $ROOT" >&2
  exit 2
fi
ROOT="$(cd "$ROOT" && pwd)"

# An assignment to process.env.<NAME>, never a read: the `[^=]` right after
# the `=` excludes `==`/`===` (a comparison, i.e. a read), and requiring
# `=` immediately after the property name means `process.env.X)` (an `if`
# read) and `${process.env.X}` (interpolation) never match either. This is
# the SAME regex D#56's acceptance criterion 4 runs against the PR head
# directly -- one rule, checked by hand once and enforced here on every run.
PATTERN='process\.env\.[A-Za-z_][A-Za-z0-9_]* *=[^=]|Math\.random'

shopt -s nullglob
FILES=("$ROOT"/packages/*/test/globalSetup.ts "$ROOT"/apps/*/test/globalSetup.ts)
shopt -u nullglob

HITS=0
SCANNED=0
for f in "${FILES[@]}"; do
  SCANNED=$((SCANNED + 1))
  rel="${f#"$ROOT"/}"
  while IFS=: read -r lineno content; do
    [[ -z "$lineno" ]] && continue
    echo "FAIL: $rel:$lineno: $content"
    HITS=$((HITS + 1))
  done < <(grep -nE -- "$PATTERN" "$f" 2>/dev/null)
done

if [[ "$HITS" -gt 0 ]]; then
  echo "check-globalsetup-env: FAIL ($HITS hit(s) across $SCANNED file(s) under $ROOT)"
  exit 1
fi
echo "check-globalsetup-env: PASS ($SCANNED file(s) scanned under $ROOT, 0 hits)"
exit 0
