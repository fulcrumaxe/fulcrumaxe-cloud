#!/usr/bin/env bash
# The self-build sandbox probe (D#6 R7e, C15 section 5 items 4 to 8). Steps, each prints at most one JSON document and never a canary value:
#   plant    OUTSIDE the sandbox, before the job: plants a canary in each credential location of the floor, records the processes that exist now.
#   run      INSIDE the job's sandbox (the job's command is `bash self-build-probe.sh run [--no-egress] [--no-nix]`): tries each forbidden thing.
#            It cannot know the canary values (the state is in the hidden home); a read that returns anything is a leak, reported as a closed word.
#   verify   OUTSIDE, after the job: probe files absent, canaries intact, nothing the job started left, no canary value in the given LOGFILEs.
#   unplant  OUTSIDE: removes what plant made, and a probe file or decoy process a failed run left.   list-floor: the covered locations.
# Optional environment: FX_PROBE_STATE (state directory), FX_PROBE_SYSTEM_DIR (default /etc, for the system write probe), FX_PROBE_ALLOWED_DOMAINS
# (extra hosts that must be reachable; the domains of .fulcrumaxe/runner-sandbox.json in the working directory are added when jq is present).
set -u

# CREDENTIAL_FLOOR of src/sandbox/sandboxSettings.ts (a test keeps them equal), relative to the home directory.
FLOOR=(.ssh .aws .config/gh .kube .docker .gnupg .netrc .npmrc .claude .claude.json .config/fx-runner .local/share/keyrings Library/Keychains)
# Single files on a real machine: never overwritten, only read.
FILES=(.netrc .npmrc .claude.json)
SYSTEM_DIR="${FX_PROBE_SYSTEM_DIR:-/etc}"
NIX_SOCKET=/nix/var/nix/daemon-socket/socket
SENTINEL='postgres: fx-probe-sentinel'

is_file_entry() { local e; for e in "${FILES[@]}"; do [ "$e" = "$1" ] && return 0; done; return 1; }
state_dir() { printf '%s' "${FX_PROBE_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/fx-probe}"; }
rand_hex() { od -An -N16 -tx1 /dev/urandom | tr -d ' \n'; }

CHECKS=()
PASS=0; FAIL=0; INCONCLUSIVE=0
# add ID ITEM EXPECT RESULT DETAIL: every field is a closed word chosen in this file, never read from the machine.
add() {
  CHECKS+=("{\"id\":\"$1\",\"item\":$2,\"expect\":\"$3\",\"result\":\"$4\",\"detail\":\"$5\"}")
  case "$4" in pass) PASS=$((PASS + 1)) ;; fail) FAIL=$((FAIL + 1)) ;; *) INCONCLUSIVE=$((INCONCLUSIVE + 1)) ;; esac
}
emit() {
  local joined="" c
  for c in "${CHECKS[@]+"${CHECKS[@]}"}"; do joined="${joined:+$joined,}$c"; done
  printf '{"probe":"fx-self-build","version":1,"step":"%s","summary":{"pass":%d,"fail":%d,"inconclusive":%d},"checks":[%s]}\n' "$1" "$PASS" "$FAIL" "$INCONCLUSIVE" "$joined"
  [ "$FAIL" -eq 0 ]
}
slug() { printf '%s' "$1" | tr '/.' '__' | sed 's/^_*//'; }

# plant_fail MESSAGE: every failing exit of `plant` goes through here (and the EXIT trap catches the rest), so a failed plant never leaves a
# canary or a directory it made behind: the trap runs `unplant`, which removes exactly what the manifest lists.
plant_fail() { echo "probe: $1" >&2; exit 2; }

plant() {
  local state; state="$(state_dir)"
  [ ! -e "$state" ] || { echo "probe: $state exists; run unplant first" >&2; exit 2; }
  umask 077
  mkdir -p "$state" || plant_fail "cannot create $state"
  # From here on any exit (an error, or a signal) undoes what has been planted so far. Cleared when the plant is complete.
  trap 'rc=$?; trap - EXIT; unplant; exit "$rc"' EXIT
  trap 'exit 2' INT TERM HUP
  : > "$state/manifest"; : > "$state/values"
  local entry target made
  for entry in "${FLOOR[@]}"; do
    if [ "$entry" = Library/Keychains ] && [ "$(uname -s)" != Darwin ]; then continue; fi
    if is_file_entry "$entry"; then
      # A single-file location. One that is not there is created (noclobber) with a canary and recorded like the directories' canaries; one that
      # exists is never touched: it is read as it is. An existing non-empty file is its own test (a read that returns data is a leak). An
      # empty one tests nothing, so it is recorded and `verify` reports it as not covered.
      target="$HOME/$entry"
      if [ -e "$target" ] || [ -L "$target" ]; then
        if [ -s "$target" ]; then printf 'real\t%s\n' "$target" >> "$state/manifest"; else printf 'empty\t%s\n' "$target" >> "$state/manifest"; fi
        continue
      fi
      local fvalue="FXPROBE-CANARY-$(rand_hex)"
      ( set -C; printf '%s\n' "$fvalue" > "$target" ) 2> /dev/null || plant_fail "cannot create $target"
      printf 'file\t%s\n' "$target" >> "$state/manifest"
      printf '%s\n' "$fvalue" >> "$state/values"
      continue
    fi
    target="$HOME/$entry/fx-probe-canary"
    # Only directories that are not there are made, and each one is recorded so unplant removes exactly those (deepest first).
    local dir="$HOME/$entry" parts=() p
    while [ ! -e "$dir" ] && [ "$dir" != "$HOME" ] && [ "$dir" != / ]; do parts+=("$dir"); dir="$(dirname "$dir")"; done
    # parts holds the missing directories innermost first; they are made outermost first.
    local i
    for ((i = ${#parts[@]} - 1; i >= 0; i--)); do
      mkdir -m 700 "${parts[$i]}" || plant_fail "cannot create ${parts[$i]}"
      printf 'dir\t%s\n' "${parts[$i]}" >> "$state/manifest"
    done
    [ ! -e "$target" ] || plant_fail "$target already exists"
    local value="FXPROBE-CANARY-$(rand_hex)"
    ( set -C; printf '%s\n' "$value" > "$target" ) 2> /dev/null || plant_fail "cannot write $target"
    printf 'file\t%s\n' "$target" >> "$state/manifest"
    printf '%s\n' "$value" >> "$state/values"
  done
  # The processes that exist now, so verify names only what the job added.
  pgrep -u "$(id -u)" -f 'postgres|chrom' 2> /dev/null | sort -n > "$state/baseline.pids" || true
  made=$(grep -c . "$state/manifest" || true)
  trap - EXIT INT TERM HUP
  echo "probe: planted ($made manifest lines)" >&2
}

unplant() {
  local state; state="$(state_dir)"
  rm -f "$HOME/fx-probe" "$SYSTEM_DIR/fx-probe" 2> /dev/null
  pkill -u "$(id -u)" -f "$SENTINEL" 2> /dev/null || true
  [ -d "$state" ] || return 0
  local kind path
  # Files first, then directories from the deepest, and only if empty.
  while IFS=$'\t' read -r kind path; do [ "$kind" = file ] && rm -f -- "$path"; done < "$state/manifest"
  grep '^dir' "$state/manifest" | cut -f2 | awk '{ print length($0) "\t" $0 }' | sort -rn | cut -f2 | while IFS= read -r path; do rmdir -- "$path" 2> /dev/null || echo "probe: left $path (not empty)" >&2; done
  rm -rf "$state"
}

# try_read PATH: success (0) only if the read returned at least one byte. Nothing it read is kept past the test or printed.
try_read() { local n; n="$(cat -- "$1" 2> /dev/null | wc -c)"; [ "${n:-0}" -gt 0 ]; }

# The first path components under $HOME that lead to the job's own directories; seeing only those is what "home is hidden" looks like.
own_roots() {
  local p top
  for p in "$PWD" "${XDG_CACHE_HOME:-}" "${TMPDIR:-}"; do
    case "$p" in "$HOME"/*) top="${p#"$HOME"/}"; printf '%s\n' "${top%%/*}" ;; esac
  done
}

check_reads() {
  local entry target seen n
  for entry in "${FLOOR[@]}"; do
    if is_file_entry "$entry"; then target="$HOME/$entry"; else target="$HOME/$entry/fx-probe-canary"; fi
    if try_read "$target"; then add "cred_read_$(slug "$entry")" 4 denied fail read_returned_data; else add "cred_read_$(slug "$entry")" 4 denied pass read_refused_or_absent; fi
    # The directory itself: listing must show nothing.
    if ! is_file_entry "$entry"; then
      n="$(ls -A -- "$HOME/$entry" 2> /dev/null | wc -l)"
      if [ "${n:-0}" -gt 0 ]; then add "cred_list_$(slug "$entry")" 4 denied fail listing_returned_entries; else add "cred_list_$(slug "$entry")" 4 denied pass listing_empty_or_refused; fi
    fi
  done
  # ~ : a listing may show only the first components that lead to the job's own directories.
  local roots; roots="$(own_roots)"
  seen=0
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    printf '%s\n' "$roots" | grep -Fxq -- "$name" || seen=$((seen + 1))
  done < <(ls -A -- "$HOME" 2> /dev/null)
  if [ "$seen" -gt 0 ]; then add home_list 4 denied fail home_shows_other_entries; else add home_list 4 denied pass home_shows_only_job_paths; fi
  if try_read "$HOME/.bashrc"; then add home_bashrc_read 4 denied fail read_returned_data; else add home_bashrc_read 4 denied pass read_refused_or_absent; fi
}

check_writes() {
  if ( : > "$HOME/fx-probe" ) 2> /dev/null; then
    # A write can "succeed" into the private tmpfs the sandbox lays over a hidden home directory. Item 5 reads "neither file exists on the host
    # after the job, and no write reaches the real home or the system directory", and a write into that tmpfs never reaches the disk, so it
    # passes here; `verify` proves the file is absent afterwards (absent_home). A write that succeeds anywhere else is a fail.
    # (the mount point is the field after the parent id, the device and the root: the fifth)
    if awk -v h="$HOME" -v f=$((2 + 3)) '$f == h { last = $0 } END { exit !(last ~ / - tmpfs /) }' /proc/self/mountinfo 2> /dev/null; then add write_home 5 absent_after_job pass write_stayed_in_private_tmpfs; else add write_home 5 denied fail write_succeeded; fi
  else add write_home 5 denied pass write_refused; fi
  if ( : > "$SYSTEM_DIR/fx-probe" ) 2> /dev/null; then add write_system 5 denied fail write_succeeded; else add write_system 5 denied pass write_refused; fi
}

# curl_try URL [curl options...]: sets CURL_EXIT and CURL_CODE. The body is thrown away.
curl_try() {
  local url="$1"; shift
  if ! command -v curl > /dev/null 2>&1; then CURL_EXIT=127; CURL_CODE=000; return; fi
  CURL_CODE="$(curl -sS -o /dev/null --max-time 25 --connect-timeout 15 -w '%{http_code}' "$@" "$url" 2> /dev/null)"
  CURL_EXIT=$?
  CURL_CODE="${CURL_CODE:-000}"
}

must_fail() { # ID URL [curl options...]
  local id="$1"; shift
  curl_try "$@"
  if [ "$CURL_EXIT" = 127 ]; then add "$id" 6 denied inconclusive curl_missing
  elif [ "$CURL_EXIT" -ne 0 ]; then add "$id" 6 denied pass request_refused
  else add "$id" 6 denied fail request_succeeded; fi
}

must_reach() { # ID URL
  curl_try "$2"
  if [ "$CURL_EXIT" = 127 ]; then add "$1" 6 reachable inconclusive curl_missing
  elif [ "$CURL_EXIT" -eq 0 ]; then add "$1" 6 reachable pass reached
  else add "$1" 6 reachable fail not_reachable; fi
}

allowed_domains() {
  local d
  for d in ${FX_PROBE_ALLOWED_DOMAINS:-}; do printf '%s\n' "$d"; done
  if [ -f .fulcrumaxe/runner-sandbox.json ] && command -v jq > /dev/null 2>&1; then jq -r '.entries[]? | select(.kind == "domain") | .value' .fulcrumaxe/runner-sandbox.json 2> /dev/null; fi
}

check_egress() {
  must_fail egress_example_com https://example.com/
  must_fail egress_example_org https://example.org/
  must_fail egress_direct_ip https://1.1.1.1/
  must_fail egress_direct_ip_no_proxy https://1.1.1.1/ --noproxy '*'
  # The control: the registry every install needs.
  must_reach egress_registry_npmjs https://registry.npmjs.org/
  must_reach egress_model_host https://api.anthropic.com/
  local d bad=0
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    case "$d" in registry.npmjs.org | api.anthropic.com) continue ;; esac
    # A domain from a file is checked as a plain host name before it reaches a command line.
    printf '%s' "$d" | grep -Eq '^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$' || { bad=$((bad + 1)); add "egress_allowed_invalid_$bad" 6 reachable inconclusive domain_not_plain; continue; }
    must_reach "egress_allowed_$(slug "$d")" "https://$d/"
  done < <(allowed_domains | sort -u)
}

check_nix() {
  local out="" code
  if [ ! -e "$NIX_SOCKET" ] && [ ! -d "$(dirname "$NIX_SOCKET")" ]; then
    add nix_daemon_socket 7 denied pass socket_directory_hidden
    return
  fi
  if command -v node > /dev/null 2>&1; then
    out="$(node -e 'const s=require("net").connect(process.argv[1]);s.on("connect",()=>{process.stdout.write("connected");process.exit(0)});s.on("error",(e)=>{process.stdout.write(String(e.code||"error"));process.exit(1)});setTimeout(()=>{process.stdout.write("timeout");process.exit(2)},5000)' "$NIX_SOCKET" 2> /dev/null)"
    code=$?
  elif command -v socat > /dev/null 2>&1; then
    out="$(printf '' | socat -T3 - "UNIX-CONNECT:$NIX_SOCKET" 2>&1 > /dev/null && echo connected || echo refused)"
    code=$?
  else
    add nix_daemon_socket 7 denied inconclusive no_connect_tool
    return
  fi
  case "$out" in
    connected) add nix_daemon_socket 7 denied fail connected ;;
    ENOENT | EPERM | EACCES | ECONNREFUSED | ENOTDIR | refused) add nix_daemon_socket 7 denied pass "connect_$(printf '%s' "$out" | tr 'A-Z' 'a-z')" ;;
    *) add nix_daemon_socket 7 denied inconclusive connect_other ;;
  esac
  : "$code"
}

# A decoy named like the processes item 8 looks for. If the sandbox does not end the job's process tree, it is still there for `verify`.
start_sentinel() {
  # Not `sleep`: on some systems it is a multi-call binary that reads its applet from argv[0].
  ( exec -a "$SENTINEL" bash -c 'while :; do sleep 30; done' ) > /dev/null 2>&1 &
  disown 2> /dev/null || true
}

run() {
  local egress=1 nix=1 a
  for a in "$@"; do case "$a" in --no-egress) egress=0 ;; --no-nix) nix=0 ;; esac; done
  start_sentinel
  sleep 1
  # Without this the "gone" answer of `verify` could only mean the decoy never started.
  if pgrep -f "$SENTINEL" > /dev/null 2>&1; then add sentinel_started 8 started pass started; else add sentinel_started 8 started inconclusive not_visible; fi
  check_reads
  check_writes
  if [ "$egress" = 1 ]; then check_egress; fi
  if [ "$nix" = 1 ]; then check_nix; fi
  emit run
}

verify() {
  local state; state="$(state_dir)"
  local log hits n
  [ -d "$state" ] || { echo "probe: no state at $state; run plant first" >&2; exit 2; }
  local p id
  for id in home system; do
    if [ "$id" = home ]; then p="$HOME/fx-probe"; else p="$SYSTEM_DIR/fx-probe"; fi
    if [ -e "$p" ] || [ -L "$p" ]; then add "absent_$id" 5 absent fail file_exists; else add "absent_$id" 5 absent pass file_absent; fi
  done
  # Every file in the manifest is still exactly the canary that was planted: nothing in the job changed a credential location.
  local kind path i=0 value
  while IFS=$'\t' read -r kind path; do
    [ "$kind" = file ] || continue
    i=$((i + 1))
    value="$(sed -n "${i}p" "$state/values")"
    if [ "$(cat -- "$path" 2> /dev/null)" = "$value" ]; then add "canary_intact_$i" 4 intact pass unchanged; else add "canary_intact_$i" 4 intact fail changed_or_missing; fi
  done < "$state/manifest"
  # No canary value in any log file given.
  for log in "$@"; do
    [ -f "$log" ] || { add "log_$(slug "$(basename "$log")")" 4 clean inconclusive log_missing; continue; }
    hits="$(grep -c -F -f "$state/values" -- "$log" 2> /dev/null || true)"
    if [ "${hits:-0}" -eq 0 ]; then add "log_$(slug "$(basename "$log")")" 4 clean pass no_canary_in_log; else add "log_$(slug "$(basename "$log")")" 4 clean fail canary_in_log; fi
  done
  # A single-file location that already existed but was empty tests nothing: reported, not passed.
  while IFS=$'\t' read -r kind path; do
    [ "$kind" = empty ] || continue
    add "not_covered_$(slug "$(basename "$path")")" 4 covered inconclusive existing_file_empty
  done < "$state/manifest"
  # Item 8: nothing the job started is left.
  if pgrep -u "$(id -u)" -f "$SENTINEL" > /dev/null 2>&1; then add leftover_sentinel 8 gone fail sentinel_alive; else add leftover_sentinel 8 gone pass sentinel_gone; fi
  n=0
  for pid in $(pgrep -u "$(id -u)" -f 'postgres|chrom' 2> /dev/null); do
    grep -qx "$pid" "$state/baseline.pids" 2> /dev/null || n=$((n + 1))
  done
  if [ "$n" -eq 0 ]; then add leftover_processes 8 gone pass none_new; else add leftover_processes 8 gone fail new_processes_alive; fi
  emit verify
}

cmd="${1:-}"; [ $# -gt 0 ] && shift
# --state DIR may come before the other arguments of plant, verify and unplant.
while [ "${1:-}" = --state ]; do FX_PROBE_STATE="${2:?--state needs a directory}"; export FX_PROBE_STATE; shift 2; done
case "$cmd" in
  plant) plant ;;
  run) run "$@" ;;
  verify) verify "$@" ;;
  unplant) unplant ;;
  list-floor) printf '%s\n' "${FLOOR[@]}" ;;
  *) echo "usage: self-build-probe.sh plant|run|verify|unplant|list-floor" >&2; exit 2 ;;
esac
