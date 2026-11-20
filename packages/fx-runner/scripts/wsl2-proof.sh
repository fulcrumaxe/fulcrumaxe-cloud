#!/usr/bin/env bash
# The WSL2 proof (D#587 B-9c). It runs INSIDE a WSL2 distribution, as an ordinary user, from the root of a checkout that lives on the
# distribution's own file system (never under /mnt), and records what it measured:
#
#   bash packages/fx-runner/scripts/wsl2-proof.sh /absolute/path/to/out-dir
#
# It is started by .github/workflows/wsl2-proof.yml on a hosted Windows runner, and runs unchanged on any other WSL2 host (the owner's own
# Windows machine, a rented one). The host must already be set up as the runner's README says: interop off, no Windows PATH, the C: drive
# automounted, bubblewrap and socat installed. The script does not change the host's configuration; it measures it.
#
# What it records, one row per step in results.jsonl and one table in summary.md:
#   kernel   the kernel names itself WSL2 (`microsoft-standard-WSL2`), asserted first because hosted WSL2 has a history of not starting
#   tools    bwrap, socat and git are present
#   kvm      /dev/kvm, for information only (microVM mode is not offered on WSL2)
#   node     Node at the runner's minimum, installed from a pinned tarball (sha256 checked) when the distribution has none
#   install  the runner package's dependencies, from the lockfile
#   gate     the runner's own WSL2 gate on this machine (test/wslGate.real.test.ts with FX_REAL_WSL=1): every setup check, the canary read of
#            /mnt/c/Users and the cmd.exe launch under the job's sandbox, each with its unsandboxed control. It must PASS, not skip.
#   canary   the read-deny canary matrix (test/canary), the real agent CLI under bubblewrap against a scripted loopback model API and a dummy
#            key, with an unsandboxed control that must find every sentinel. No credential is used. Set FX_WSL_PROOF_CANARY=0 to leave it out.
#
# A row is `pass`, `fail` or `not_tested` (a download that could not be checked, a tool that could not be installed): the verdict is YES only
# when every row passes, NO when any row fails, and NOT TESTED otherwise. The exit status is 0 for YES only.
#
# What it cannot show: it does not run on Windows 11 (where nested virtualization may exist), it adds no WSL drive sentinel to the canary
# matrix, and it does not resolve an allowed host name to see where it points (the runner's README names that limit).
set -uo pipefail

OUT="${1:?usage: wsl2-proof.sh /absolute/path/to/out-dir}"
case "$OUT" in /*) ;; *) echo "wsl2-proof: the out directory must be an absolute path" >&2; exit 2 ;; esac
[ -f packages/fx-runner/package.json ] || { echo "wsl2-proof: run it from the root of the checkout" >&2; exit 2; }
ROOT="$(pwd -P)"
case "$ROOT" in /mnt/*) echo "wsl2-proof: the checkout is under /mnt; it must be on the distribution's own file system" >&2; exit 2 ;; esac
[ "$(id -u)" != 0 ] || { echo "wsl2-proof: run as an ordinary user, not root" >&2; exit 2; }
umask 077
mkdir -p "$OUT"
: > "$OUT/results.jsonl"

NODE_VERSION="24.11.0"
NODE_SHA256="46da9a098973ab7ba4fca76945581ecb2eaf468de347173897044382f10e0a0a"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"
NODE_MIN="22.22.2"
TOOLS_DIR="${HOME:?}/.local"
mkdir -p "$TOOLS_DIR/bin"
export PATH="$TOOLS_DIR/bin:$PATH"

FAILED=0
UNTESTED=0

json_text() { printf '%s' "$1" | tr '\n\t\r' '   ' | cut -c1-400 | sed 's/\\/\\\\/g; s/"/\\"/g'; }

# row <id> <pass|fail|not_tested> <detail>
row() {
  printf '{"id":"%s","verdict":"%s","detail":"%s"}\n' "$1" "$2" "$(json_text "$3")" >> "$OUT/results.jsonl"
  case "$2" in fail) FAILED=1 ;; not_tested) UNTESTED=1 ;; esac
  echo "wsl2-proof: $1 $2: $3"
}

# passed <id>: true when the row for that step says pass.
passed() { grep -qF "{\"id\":\"$1\",\"verdict\":\"pass\"" "$OUT/results.jsonl"; }

# version_at_least <have> <need>: true when have >= need, both dotted numbers.
version_at_least() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n 1)" = "$2" ]; }

finish() {
  local verdict="YES"
  if [ "$FAILED" = 1 ]; then verdict="NO"; elif [ "$UNTESTED" = 1 ]; then verdict="NOT TESTED"; fi
  {
    echo "## WSL2 proof: $verdict"
    echo
    echo "Kernel: \`$(uname -r 2>/dev/null)\`"
    echo
    echo "| step | verdict | detail |"
    echo "|---|---|---|"
    # One JSON object per line, written by row() above: split it on its three fixed keys.
    sed -n 's/^{"id":"\([^"]*\)","verdict":"\([^"]*\)","detail":"\(.*\)"}$/| \1 | \2 | \3 |/p' "$OUT/results.jsonl"
  } > "$OUT/summary.md"
  echo "wsl2-proof: verdict $verdict"
  [ "$verdict" = "YES" ]
  exit $?
}

# step <id> <seconds> <command...>: runs the command with a time limit, its output in <id>.log. Returns the command's status.
step() {
  local id="$1" secs="$2"
  shift 2
  timeout --kill-after=10s "$secs" "$@" > "$OUT/$id.log" 2>&1
}

# ---- kernel: asserted first. Anything else is not WSL2, and nothing after it means anything. ----
KERNEL="$(uname -r 2>/dev/null || true)"
case "$KERNEL" in
  *microsoft-standard-WSL2*) row kernel pass "$KERNEL" ;;
  *) row kernel fail "the kernel is \`$KERNEL\`, not microsoft-standard-WSL2: this is not a WSL2 machine"; finish ;;
esac

# ---- tools ----
MISSING=""
for tool in bwrap socat git curl; do command -v "$tool" > /dev/null 2>&1 || MISSING="$MISSING $tool"; done
if [ -n "$MISSING" ]; then
  row tools fail "missing:$MISSING"
else
  row tools pass "bwrap $(bwrap --version 2>&1 | head -n 1 | tr -d '\n'), socat $(socat -V 2>&1 | sed -n 's/.*version \([0-9.]*\).*/\1/p' | head -n 1)"
fi

# ---- kvm: information only ----
if [ -e /dev/kvm ]; then row kvm pass "/dev/kvm present: $(stat -c '%A %U:%G' /dev/kvm 2>&1)"; else row kvm pass "/dev/kvm absent (information only; microVM mode is not offered on WSL2)"; fi

# ---- node ----
node_ok() { command -v node > /dev/null 2>&1 && version_at_least "$(node --version 2>/dev/null | sed 's/^v//')" "$NODE_MIN"; }
if node_ok; then
  row node pass "node $(node --version) already present"
elif command -v curl > /dev/null 2>&1; then
  TARBALL="$OUT/node.tar.xz"
  if step node-download 300 curl --fail --silent --show-error --location --output "$TARBALL" "$NODE_URL"; then
    if [ "$(sha256sum "$TARBALL" | cut -d' ' -f1)" = "$NODE_SHA256" ]; then
      rm -rf "$TOOLS_DIR/node"
      mkdir -p "$TOOLS_DIR/node"
      if tar -xJf "$TARBALL" -C "$TOOLS_DIR/node" --strip-components=1; then
        ln -sf "$TOOLS_DIR/node/bin/node" "$TOOLS_DIR/bin/node"
        ln -sf "$TOOLS_DIR/node/bin/npm" "$TOOLS_DIR/bin/npm"
        ln -sf "$TOOLS_DIR/node/bin/npx" "$TOOLS_DIR/bin/npx"
        ln -sf "$TOOLS_DIR/node/bin/corepack" "$TOOLS_DIR/bin/corepack"
        row node pass "node $(node --version) from the pinned tarball, sha256 checked"
      else
        row node not_tested "the pinned Node tarball did not unpack"
      fi
    else
      row node not_tested "the Node download did not match its pinned sha256, so it was not used"
    fi
    rm -f "$TARBALL"
  else
    row node not_tested "the Node download failed: $(tail -n 1 "$OUT/node-download.log" 2>/dev/null)"
  fi
else
  row node not_tested "no node and no curl to fetch it"
fi

# ---- install ----
if node_ok; then
  # shellcheck disable=SC2016 # the single-quoted script is meant to expand $1 inside the child shell
  if step install 900 bash -c 'corepack enable --install-directory "$1" && pnpm install --frozen-lockfile --filter "@fulcrumaxe/fx-runner..."' _ "$TOOLS_DIR/bin"; then
    row install pass "pnpm $(pnpm --version 2>/dev/null) installed the runner's dependencies from the lockfile"
  else
    row install not_tested "the dependency install did not finish: $(tail -n 1 "$OUT/install.log" 2>/dev/null)"
  fi
else
  row install not_tested "no usable node"
fi

# ---- machine: what the distribution looks like before anything runs, so a failed gate row can be read against it. Information only; it
# changes nothing and never fails the proof. The checks themselves are the gate's. ----
{
  echo "## /etc/wsl.conf"; cat /etc/wsl.conf 2>&1
  echo "## pid 1"; ps -o pid=,comm= -p 1 2>&1
  echo "## binfmt_misc entries"
  for entry in /proc/sys/fs/binfmt_misc/*; do [ -e "$entry" ] && { echo "-- $entry"; head -n 4 "$entry" 2>&1; }; done
  echo "## WSL environment"; env | grep -E '^WSL' | sed 's/=.*$/=<set>/' 2>&1
  echo "## /run/WSL"; ls -la /run/WSL 2>&1
  echo "## PATH has a Windows drive entry"; printf '%s' "$PATH" | tr ':' '\n' | grep -c '^/mnt/' 2>&1
} > "$OUT/machine.txt" 2>&1 || true

# canary_clean <log> <squeezed Tests line>: the matrix ran every test it can on this machine. A skip fails the proof, except for the files
# named here, each skipped WHOLE because it cannot apply to a Linux host without a signed-in agent account. Anything else skipped, a
# file only partly skipped, or a skip count that differs from those files' own, is a failure. Sets CANARY_NA_NOTE for the row.
#   test/canary.live.test.ts           one real model turn with the operator's own login (FX_CANARY=1); the proof holds no credential
#   test/canary/securitydInit.test.ts  the macOS Keychain daemon (securityd) and Seatbelt; it needs process.platform === "darwin"
CANARY_NA_FILES="test/canary.live.test.ts test/canary/securitydInit.test.ts"
CANARY_NA_NOTE="no test skipped"
canary_clean() {
  local log="$1" summary="$2" line file n total=0 listed="" passed skipped files_skipped
  while IFS= read -r line; do
    file="$(printf '%s' "$line" | sed -n 's/^ *↓ \([^ ]*\) (\([0-9]*\) tests\{0,1\} | \2 skipped)$/\1/p')"
    [ -n "$file" ] || return 1
    case " $CANARY_NA_FILES " in *" $file "*) ;; *) return 1 ;; esac
    n="$(printf '%s' "$line" | sed -n 's/^.*(\([0-9]*\) tests\{0,1\} | .*$/\1/p')"
    total=$((total + n))
    listed="$listed $file"
  done < <(grep -E '^ *↓ ' "$log")
  # Nothing else may say "skipped" except vitest's own two totals lines.
  if grep -Ev '^ *↓ |^ *Test Files |^ *Tests ' "$log" | grep -Eqi 'skipped'; then return 1; fi
  # The file totals must agree with the skip lines read: a skipped file with no line of its own is a skip nobody named.
  files_skipped="$(grep -E '^ *Test Files ' "$log" | tail -n 1 | sed -n 's/^.* \([0-9]*\) skipped .*$/\1/p')"
  [ "${files_skipped:-0}" = "$(printf '%s' "$listed" | wc -w | tr -d ' ')" ] || return 1
  passed="$(printf '%s' "$summary" | sed -n 's/^ \{0,1\}Tests \([0-9]*\) passed.*$/\1/p')"
  skipped="$(printf '%s' "$summary" | sed -n 's/^.* \([0-9]*\) skipped .*$/\1/p')"
  [ -n "$passed" ] || return 1
  [ "${skipped:-0}" = "$total" ] || return 1
  printf '%s' "$summary" | grep -Eq "^ ?Tests [0-9]+ passed( \| ${total} skipped)? \([0-9]+\)$" || return 1
  [ -z "$listed" ] || CANARY_NA_NOTE="skipped, as they cannot apply here:$listed"
  return 0
}

# ---- gate: the runner's own WSL2 gate, real. A skipped run is no answer. ----
if passed install; then
  (cd packages/fx-runner && export FX_REAL_WSL=1 && step gate 600 pnpm exec vitest run test/wslGate.real.test.ts); GATE_RC=$?
  SUMMARY_LINE="$(grep -E '^ *Tests +' "$OUT/gate.log" | tail -n 1 | tr -s ' ')"
  if [ "$GATE_RC" = 0 ] && printf '%s' "$SUMMARY_LINE" | grep -Eq '^ ?Tests [0-9]+ passed \([0-9]+\)$' && ! grep -Eqi 'skipped' "$OUT/gate.log"; then
    row gate pass "$SUMMARY_LINE: the machine clears, and the refusal control leaves no clearance"
  elif [ "$GATE_RC" = 0 ]; then
    row gate fail "the gate test exited 0 but did not run every test (${SUMMARY_LINE:-no summary line}): a skipped test proves nothing"
  else
    # The failing setting's code and detail are lines of the assertion's diff (`+   "wsl_...: ..."`), which the other patterns do not catch.
    row gate fail "the gate test failed (exit $GATE_RC): $(grep -E '^\+ +"wsl_|Error|expected|✗|×|FAIL' "$OUT/gate.log" | head -n 5 | tr '\n' ' ')"
  fi
else
  row gate not_tested "the dependencies are not installed"
fi

# ---- canary: the read-deny matrix under bubblewrap, against the scripted model API ----
if [ "${FX_WSL_PROOF_CANARY:-1}" = 0 ]; then
  row canary not_tested "left out by FX_WSL_PROOF_CANARY=0"
elif passed install; then
  VERSION="$(sed -n 's/^export const MIN_CLAUDE_VERSION = "\(.*\)";$/\1/p' packages/fx-runner/src/engines/claude/pin.ts)"
  if [ -z "$VERSION" ]; then
    row canary not_tested "the runner's minimum agent CLI version could not be read"
  elif ! step canary-cli 600 npm install --global --prefix "$TOOLS_DIR" "@anthropic-ai/claude-code@${VERSION}"; then
    row canary not_tested "the agent CLI ${VERSION} did not install: $(tail -n 1 "$OUT/canary-cli.log" 2>/dev/null)"
  else
    mkdir -p "$OUT/canary"
    (cd packages/fx-runner && export FX_B10=1 FX_B10_CHECK=1 FX_B10_OUT="$OUT/canary" && step canary 2700 pnpm exec vitest run test/canary --no-file-parallelism); CANARY_RC=$?
    SUMMARY_LINE="$(grep -E '^ *Tests +' "$OUT/canary.log" | tail -n 1 | tr -s ' ')"
    if [ "$CANARY_RC" = 0 ] && canary_clean "$OUT/canary.log" "$SUMMARY_LINE"; then
      row canary pass "agent CLI ${VERSION}: $SUMMARY_LINE, every sentinel found unsandboxed and denied under bubblewrap; ${CANARY_NA_NOTE}"
    else
      row canary fail "the canary matrix did not pass (exit $CANARY_RC, ${SUMMARY_LINE:-no summary line})"
    fi
  fi
else
  row canary not_tested "the dependencies are not installed"
fi

finish
