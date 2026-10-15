#!/usr/bin/env bash
# Self-test of the neon-shape entry loader (neon-shape-entries.sh): hostile entries must be refused, a valid
# one accepted. Needs no database. Run by test-neon-shape.sh before it loads the real entries, and runnable
# alone: bash packages/db/scripts/test-neon-shape-entries.sh
set -euo pipefail

LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/neon-shape-entries.sh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

MIG="$T/migrations"
mkdir -p "$MIG"
: >"$MIG/0001_alpha.sql"
: >"$MIG/0002_beta.sql"

failures=0
fail() {
  echo "neon-shape entries self-test FAILED: $*" >&2
  failures=$((failures + 1))
}

# load <entry dir>: runs the loader in a fresh shell; prints its stderr, returns its status.
load() {
  bash -c 'source "$1"; ns_load_entries "$2" "$3" 1' _ "$LIB" "$1" "$MIG" 2>&1
}

# expect_refused <name> <entry dir> <expected text in the message>
expect_refused() {
  local name="$1" dir="$2" want="$3" out rc=0
  out="$(load "$dir")" || rc=$?
  if [ "$rc" -eq 0 ]; then
    fail "$name: the loader accepted it"
  elif ! grep -qF -- "$want" <<<"$out"; then
    fail "$name: refused, but the message lacks '$want': $out"
  fi
}

# fresh <case name>: an empty entry dir with one valid entry; echoes its path.
fresh() {
  local d="$T/$1"
  mkdir -p "$d"
  printf '%s\n' "role good_role" >"$d/0001_alpha.conf"
  echo "$d"
}

# --- valid input is accepted, and what it registers is what it says
d="$(fresh valid)"
cat >"$d/0002_beta.conf" <<'EOF'
# a comment may say anything: $(not run) `not run` ; exit 0

functions DEMO_ROLE one two
privilege DEMO_ROLE column t.c SELECT
privilege DEMO_ROLE schema public USAGE
exempt_single demo check_demo_exception_shape demo_fn uuid,text @FUNCTIONS:DEMO_ROLE
check check_demo_role_shape demo_role DEMO_ROLE
check_everywhere check_demo_everywhere
late
EOF
out="$(bash -c '
  source "$1"; ns_load_entries "$2" "$3" 1
  [ "$NS_ENTRY_COUNT" = 2 ] && [ "${#NS_DECLARED_ROLES[@]}" = 1 ] && [ "${#NS_CHECK_CMDS[@]}" = 2 ] && [ "${#NS_EXEMPT_CMDS[@]}" = 1 ] || exit 3
  [ "${NS_LATE_MIGRATIONS[*]}" = "0002_beta.sql" ] || exit 4
  [ "$DEMO_ROLE_FUNCTIONS" = "'"'"'one'"'"', '"'"'two'"'"'" ] || exit 5
  [ "$DEMO_ROLE_PRIVILEGES" = "'"'"'column t.c SELECT'"'"','"'"'schema public USAGE'"'"'" ] || exit 6
' _ "$LIB" "$d" "$MIG" 2>&1)" || fail "valid entries were not loaded as written (status $?): $out"

# --- hostile lines: each must be refused with file:line, and must not run
bad_line() {
  local name="$1" line="$2" d
  d="$(fresh "$name")"
  printf '%s\n' "# first line is fine" "$line" >"$d/0002_beta.conf"
  expect_refused "$name" "$d" "0002_beta.conf:2: refused"
}
MARK="$T/pwned"
bad_line exit0 "exit 0"
bad_line exit0_after_directive "role x; exit 0"
bad_line redefine_run_checks 'ns_run_checks() { :; }'
bad_line redefine_diff 'diff() { return 0; }'
bad_line command_substitution "role \$(touch $MARK)"
bad_line backticks "role \`touch $MARK\`"
bad_line redirection "role x > $MARK"
bad_line pipe "role x | cat"
bad_line quotes "role 'x'"
bad_line variable 'role $HOME'
bad_line unknown_directive "source /etc/passwd"
bad_line bad_check_name "check run_anything"
bad_line leading_space " role x"
bad_line double_space "role  x"
bad_line trailing_space "role x "
bad_line late_with_args "late now"
bad_line bad_prefix "functions lower one"
bad_line carriage_return "$(printf 'role x\r')"
[ ! -e "$MARK" ] || fail "a hostile line was executed (marker file exists)"

# --- hostile names and file types
d="$(fresh bad_name_sh)"
printf '%s\n' "role x" >"$d/0002_beta.sh"
expect_refused "a .sh entry" "$d" "not named <NNNN>_<migration name>.conf"

d="$(fresh bad_name_upper)"
printf '%s\n' "role x" >"$d/0002_Beta.conf"
expect_refused "an uppercase name" "$d" "not named"

d="$(fresh bad_name_hidden)"
printf '%s\n' "role x" >"$d/.0002_beta.conf"
expect_refused "a hidden file" "$d" "not named"

d="$(fresh other_file)"
printf '%s\n' "readme" >"$d/README.md"
expect_refused "an extra file" "$d" "not named"

d="$(fresh symlink)"
printf '%s\n' "role x" >"$T/target.conf"
ln -s "$T/target.conf" "$d/0002_beta.conf"
expect_refused "a symlink" "$d" "not a regular file"

d="$(fresh subdir)"
mkdir "$d/0002_beta.conf"
expect_refused "a directory" "$d" "not a regular file"

d="$(fresh no_migration)"
printf '%s\n' "role x" >"$d/0009_gamma.conf"
expect_refused "an entry with no migration" "$d" "has no migration 0009_gamma.sql"

mkdir "$T/empty"
expect_refused "an empty directory" "$T/empty" "no entries found"
ln -s "$T/valid" "$T/linkdir"
expect_refused "a symlinked directory" "$T/linkdir" "missing or is a symlink"

# --- nothing is registered when a later line is refused (validate-everything-first)
d="$(fresh all_or_nothing)"
printf '%s\n' "role fine_role" >"$d/0001_alpha.conf"
printf '%s\n' "role also_fine" "exit 0" >"$d/0002_beta.conf"
out="$(bash -c 'source "$1"; ns_load_entries "$2" "$3" 1' _ "$LIB" "$d" "$MIG" 2>&1)" && fail "all_or_nothing: accepted"
grep -qF "0002_beta.conf:2: refused" <<<"$out" || fail "all_or_nothing: wrong message: $out"

# --- an early `exit 0` cannot pass: the exit guard turns it into a failure
rc=0
bash -c 'source "$1"; trap '"'"'rc=$?; ns_exit_guard "$rc" || exit 1'"'"' EXIT; exit 0' _ "$LIB" >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 1 ] || fail "exit 0 before the final step was not turned into a failure (status $rc)"
rc=0
bash -c 'source "$1"; trap '"'"'rc=$?; ns_exit_guard "$rc" || exit 1'"'"' EXIT; NS_COMPLETED=1; exit 0' _ "$LIB" >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 0 ] || fail "a completed run was failed by the exit guard (status $rc)"

# --- the helpers cannot be redefined by anything that does get to run
rc=0
bash -c 'source "$1"; ns_run_checks() { :; }' _ "$LIB" >/dev/null 2>&1 || rc=$?
[ "$rc" -ne 0 ] || fail "ns_run_checks could be redefined after loading (it must be readonly)"

if [ "$failures" -ne 0 ]; then
  echo "neon-shape entries self-test: $failures failure(s)" >&2
  exit 1
fi
echo "==> neon-shape entries self-test: hostile entries refused"
