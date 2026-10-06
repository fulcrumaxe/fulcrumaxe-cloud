#!/usr/bin/env bash
# scripts/reap-orphan-test-pg.sh -- stop orphaned ephemeral test Postgres clusters.
#
# The vitest pg harness (packages/db/test/support/ephemeral-pg.ts) creates
# fx-<pkg>-pg-XXXX scratch dirs holding an owner.pid. A harness killed
# uncatchably (SIGKILL / OOM) leaves its postmaster running. Usage:
#   bash scripts/reap-orphan-test-pg.sh           # dry run: list what would be reaped
#   bash scripts/reap-orphan-test-pg.sh --apply   # stop the clusters, remove the dirs
#   bash scripts/reap-orphan-test-pg.sh --root D  # scan only D, instead of the default roots
#
# A dir is considered only if it is a real directory (not a symlink) owned by
# us, matching fx-*-pg-* directly under /tmp/nix-shell.* or $TMPDIR. Then:
#   - owner.pid present: reaped only if it is a number naming a dead process
#     (empty or garbage means no action);
#   - owner.pid absent (older harness): reaped only if the postmaster is older
#     than 6 h and has ppid 1.
# Nothing is ever signalled unless /proc/<pid>/cmdline shows a postgres of
# ours started with `-D <dir>/data`; a live pid that fails that check (forged
# or recycled postmaster.pid) leaves the whole dir alone. Postmasters in the
# github-runner cgroup are skipped, and so are dirs whose owner is alive.
set -uo pipefail

APPLY=false
ROOT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=true ;;
    --root) [[ -n "${2:-}" ]] || { echo "usage: $0 [--apply] [--root DIR]" >&2; exit 2; }; ROOT="$2"; shift ;;
    *) echo "usage: $0 [--apply] [--root DIR]" >&2; exit 2 ;;
  esac
  shift
done
# --root DIR replaces the default scan roots (/tmp/nix-shell.* and $TMPDIR) with DIR alone.
if [[ -n "$ROOT" ]]; then
  scan_globs=("$ROOT"/fx-*-pg-*)
else
  scan_globs=(/tmp/nix-shell.*/fx-*-pg-* "${TMPDIR:-/tmp}"/fx-*-pg-*)
fi

MIN_AGE_SECS=21600
me=$(id -u)
count=0

# One pass over both roots; TMPDIR is usually one of the /tmp/nix-shell.* dirs.
declare -A seen=()
for cand in "${scan_globs[@]}"; do
  [[ -n "${seen[$cand]:-}" ]] && continue
  seen[$cand]=1
  dir=$cand
  [[ -L "$dir" || ! -d "$dir" || ! -O "$dir" ]] && continue

  owner=""
  has_owner=false
  if [[ -e "$dir/owner.pid" ]]; then
    has_owner=true
    # trim only the ends: "1 2" must stay invalid, not become 12
    owner=$(head -c 32 "$dir/owner.pid" 2>/dev/null | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  fi
  pm=""
  [[ -r "$dir/data/postmaster.pid" ]] && pm=$(head -1 "$dir/data/postmaster.pid" | tr -d '[:space:]')

  # Is pm a live postgres of ours for this dir?  none | ours | foreign
  state=none
  if [[ "$pm" =~ ^[0-9]+$ && -d "/proc/$pm" ]]; then
    real=$(realpath -- "$dir")
    cmd=$(tr '\0' ' ' <"/proc/$pm/cmdline" 2>/dev/null)
    exe=$(basename -- "${cmd%% *}")
    if [[ ("$exe" == postgres || "$exe" == postmaster) && ( "$cmd" == *" -D $dir/data "* || "$cmd" == *" -D $real/data "* ) \
          && "$(stat -c %u "/proc/$pm" 2>/dev/null)" == "$me" ]]; then
      state=ours
    else
      state=foreign
    fi
  fi
  [[ "$state" == foreign ]] && continue
  if [[ "$state" == ours ]] && grep -q 'github-runner' "/proc/$pm/cgroup" 2>/dev/null; then
    continue
  fi

  if [[ "$has_owner" == true ]]; then
    [[ "$owner" =~ ^[0-9]+$ ]] || continue          # garbage or empty: no action
    (( 10#$owner > 0 )) || continue                 # 0 is not a pid: no action
    [[ -d "/proc/$owner" ]] && continue             # owner alive
    reason="owner $owner is gone"
  else
    [[ "$state" == ours ]] || continue              # legacy rule needs a verified postmaster
    ppid=$(ps -o ppid= -p "$pm" | tr -d ' ')
    age=$(ps -o etimes= -p "$pm" | tr -d ' ')
    [[ "$ppid" == "1" && "${age:-0}" -gt "$MIN_AGE_SECS" ]] || continue
    reason="no owner.pid, postmaster $pm has ppid 1 and is ${age}s old"
  fi

  count=$((count + 1))
  if [[ "$APPLY" == true ]]; then
    echo "reaping $dir ($reason)"
    if [[ "$state" == ours ]]; then
      pg_ctl -D "$dir/data" -m fast stop >/dev/null 2>&1 || kill -INT "$pm" 2>/dev/null
    fi
    rm -rf -- "$dir"
  else
    echo "would reap $dir ($reason)"
  fi
done

if [[ "$APPLY" == true ]]; then
  echo "reaped $count orphaned test postgres cluster(s)"
else
  echo "$count orphaned test postgres cluster(s) found (dry run; --apply to reap)"
fi
