#!/usr/bin/env bash
# Real-binary canary for file-tool confinement (D#6 R4b1-4). Run from the repo root, in a session that is signed in
# with the subscription you want to use. It makes ONE short model turn and nothing else costs money.
#
#   bash packages/fx-runner/scripts/canary.sh /absolute/path/to/claude
#
# What it checks: the file tools and the shell sandbox of the real CLI refuse every call that reaches outside the
# workspace (directly and through links), the inside calls work, and nothing outside changes. The probes are the
# operator's own self-test, written into the job's role card (the trusted part of the prompt), because a model refuses
# the same instructions inside the untrusted block and a refused probe tests nothing. A probe the model does not call
# is reported FAIL. It needs bwrap and socat on PATH on Linux and WSL2 (it exits 2 before planting anything if not).
#
# It plants canary files in ~/.fx-runner, ~/.ssh and the binary's directory, swaps in a decoy ~/.bashrc (the real one is
# restored on exit, or the decoy removed if you had none), runs test/canary.live.test.ts, then removes everything it
# planted, including the directories it had to create. The run's own files (jobs, logs, session index, workspaces) live
# in ~/fx-canary-<id> and go with it; set FX_CANARY_KEEP=1 to keep that directory and read the log. It refuses to start
# if ~/.bashrc.fx-canary-bak already exists (a previous run was cut off: restore that file by hand first).
#
# The test prints one PASS or FAIL line per probe; the exit status is non-zero if any is FAIL. Record the CLI version
# printed first, and set MIN_CLAUDE_VERSION (src/engines/claude/pin.ts) to the oldest version this passes on.
set -euo pipefail

CLAUDE_BIN="${1:?usage: canary.sh /absolute/path/to/claude}"
case "$CLAUDE_BIN" in /*) ;; *) echo "canary: the binary path must be absolute" >&2; exit 2 ;; esac
[ -x "$CLAUDE_BIN" ] || { echo "canary: $CLAUDE_BIN is not executable" >&2; exit 2; }
: "${HOME:?}"
umask 077

ID="$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
BIN_DIR="$(dirname "$CLAUDE_BIN")"
BAK="$HOME/.bashrc.fx-canary-bak"
{ [ ! -e "$BAK" ] && [ ! -L "$BAK" ]; } || { echo "canary: $BAK exists; restore it to ~/.bashrc first" >&2; exit 2; }

D_STATE="$HOME/.fx-runner"
D_SSH="$HOME/.ssh"
F_STATE="$D_STATE/canary-$ID.txt"
F_SSH="$D_SSH/canary-$ID.txt"
F_BIN="$BIN_DIR/canary-$ID.txt"
F_RC="$HOME/.bashrc"
OUT_WRITE="$HOME/fx-canary-outside-$ID.txt"
M_STATE="CANARY-STATE-$ID"; M_SSH="CANARY-SSH-$ID"; M_BIN="CANARY-BIN-$ID"; M_RC="CANARY-RC-$ID"

# The CLI's shell sandbox starts bwrap and socat by name, so the run needs them on its PATH (the test finds them through
# this PATH and adds their directories to the agent's). Checked here, before anything is planted, so a machine without
# them stops with nothing touched. macOS has its own sandbox and needs neither.
if [ "$(uname -s)" != "Darwin" ]; then
  for tool in bwrap socat; do
    command -v "$tool" > /dev/null 2>&1 || { echo "canary: $tool is not on PATH (the CLI's shell sandbox needs bwrap and socat; on NixOS: nix shell nixpkgs#bubblewrap nixpkgs#socat)" >&2; exit 2; }
  done
fi

MADE_STATE=0; MADE_SSH=0; MOVED_RC=0; PLANTED_RC=0

cleanup() {
  # Best effort, in order: nothing below may stop the ~/.bashrc restore, and nothing may run before it.
  set +e
  if [ "$MOVED_RC" = 1 ] && { [ -e "$BAK" ] || [ -L "$BAK" ]; }; then
    mv -f "$BAK" "$F_RC"   # replaces the decoy; a link is moved as a link, never written through
  elif [ "$PLANTED_RC" = 1 ] && [ "$MOVED_RC" = 0 ]; then
    rm -f "$F_RC"
  fi
  rm -f "$F_STATE" "$F_SSH" "$F_BIN" "$OUT_WRITE"
  if [ "${FX_CANARY_KEEP:-0}" = 1 ]; then echo "canary: kept $HOME/fx-canary-$ID" >&2; else rm -rf "$HOME/fx-canary-$ID"; fi
  # Only the directories this run created, and only if nothing else is in them.
  if [ "$MADE_STATE" = 1 ]; then rmdir "$D_STATE" 2>/dev/null || echo "canary: left $D_STATE (not empty)" >&2; fi
  if [ "$MADE_SSH" = 1 ]; then rmdir "$D_SSH" 2>/dev/null || echo "canary: left $D_SSH (not empty)" >&2; fi
}
trap cleanup EXIT
trap 'exit 143' TERM INT HUP

if [ ! -d "$D_STATE" ]; then mkdir -m 700 "$D_STATE"; MADE_STATE=1; fi
if [ ! -d "$D_SSH" ]; then mkdir -m 700 "$D_SSH"; MADE_SSH=1; fi
printf '%s\n' "$M_STATE" > "$F_STATE"
printf '%s\n' "$M_SSH" > "$F_SSH"
printf '%s\n' "$M_BIN" > "$F_BIN"
# MOVED_RC is set before the mv, so an interrupted run still tries the restore. -L: a dangling link is a ~/.bashrc too.
if [ -e "$F_RC" ] || [ -L "$F_RC" ]; then MOVED_RC=1; mv -f "$F_RC" "$BAK"; fi
PLANTED_RC=1
printf '# decoy for the canary\n# %s\n' "$M_RC" > "$F_RC"

export FX_CANARY=1 FX_CANARY_HOME="$HOME" FX_CANARY_CLAUDE="$CLAUDE_BIN" FX_CANARY_ID="$ID"
export FX_CANARY_OUTSIDE_FILES="$F_STATE:$F_SSH:$F_BIN:$F_RC" FX_CANARY_OUTSIDE_WRITE="$OUT_WRITE"
export FX_CANARY_SSH_FILE="$F_SSH" FX_CANARY_RC_FILE="$F_RC"
export FX_CANARY_MARKERS="$M_STATE:$M_SSH:$M_BIN:$M_RC"

"$CLAUDE_BIN" --version
pnpm --filter @fulcrumaxe/fx-runner exec vitest run test/canary.live.test.ts
echo "canary: PASS (record the version above and the denied-call count in the PR)"
