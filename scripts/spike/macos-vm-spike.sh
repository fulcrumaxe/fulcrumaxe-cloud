#!/usr/bin/env bash
# macOS sandbox spike (measurement tool, not product code). Run by .github/workflows/macos-vm-spike.yml
# on a GitHub-hosted macOS runner; also runnable by hand on a Mac: bash scripts/spike/macos-vm-spike.sh OUTDIR
#
#   Step 1   can an Apple Virtualization (vz) VM boot here at all? (vfkit, pinned, sha256-checked)
#   Step 2a  if it boots: boot time, host RSS, guest memory line
#   Step 2b  if it cannot: the Seatbelt path (sandbox-exec) that v1 macOS and Claude Code's own sandbox use
#
# Output: OUTDIR/results.jsonl (one row per number: command, load, value) and OUTDIR/logs/. Turn it into a
# report with scripts/spike/macos-spike-report.py. This script never fails the job for a measurement that
# fails: a failure is the finding. The one exception is a pinned download that cannot be fetched or does not
# match its sha256: nothing was tried then, so the script finishes its other steps and exits 1, and the report
# says "NOT TESTED" rather than "NO". It takes no secrets and reads no input except its one argument.
set -uo pipefail

OUT="${1:?usage: macos-vm-spike.sh OUTDIR}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="$(cd "$HERE/../.." && pwd -P)"
mkdir -p "$OUT/logs"
OUT="$(cd "$OUT" && pwd -P)"
WORK="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/macos-spike.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"
T="$HERE/spike_tools.py"

# ---- pins. Every download is checked against the sha256 written here; a mismatch skips the VM step and fails the script. ----
DOWNLOAD_FAILED=0
VFKIT_VERSION="v0.6.4"
VFKIT_URL="https://github.com/crc-org/vfkit/releases/download/${VFKIT_VERSION}/vfkit"
VFKIT_SHA256="0ed83fc8ca7aa708598835480dba1362406aa7cd1dab3b27464eb76327d9652d"
ALPINE_BASE="https://dl-cdn.alpinelinux.org/alpine/v3.20/releases"
ALPINE_NETBOOT="netboot-3.20.10"
ARCH="$(uname -m)"
if [ "$ARCH" = "arm64" ]; then
  GUEST_ARCH="aarch64"
  KERNEL_SHA256="573d0eb4713fc7b631e7242a95fa9d048c60365993658b24d5106a69d0a0e7f2"
  INITRD_SHA256="90f5159c2cbf81b5d6ad7b14a314815589a7077d0e8fa4e8aa0403c3fef458ae"
else
  GUEST_ARCH="x86_64"
  KERNEL_SHA256="be523954ad673a78c9cdfd3d473a8d39609f5901adfcc68402c67dc037a64c7e"
  INITRD_SHA256="753108c476889bdd37bb220352b57d19145a56b261aded262ee3a0dc00de05cd"
fi

rec() { python3 "$T" rec "$OUT" "$@"; }
# fact ID 'shell command': runs the command and records its output as the value.
fact() {
  local v
  v="$(bash -c "$2" 2>&1)"
  rec "$1" "$v" "text" "$2" ""
}
# fetch URL FILE SHA256: download and verify; on failure records the row, sets DOWNLOAD_FAILED and returns 1.
fetch() {
  curl -fsSL --retry 3 --max-time 180 -o "$2" "$1" || { DOWNLOAD_FAILED=1; rec "download.$(basename "$2")" "failed" "text" "curl -fsSL $1" "download failed"; return 1; }
  local got
  got="$(shasum -a 256 "$2" | awk '{print $1}')"
  if [ "$got" != "$3" ]; then
    DOWNLOAD_FAILED=1
    rec "download.$(basename "$2")" "sha256 mismatch: got $got" "text" "shasum -a 256 $2" "expected $3"
    return 1
  fi
}

# ======================= host facts (every job) =======================
fact host.sw_vers 'sw_vers'
fact host.arch 'uname -m'
fact host.cpu_brand 'sysctl -n machdep.cpu.brand_string'
fact host.model 'sysctl -n hw.model'
fact host.memsize_bytes 'sysctl -n hw.memsize'
fact host.hv_support 'sysctl -n kern.hv_support'
fact host.hv_vmm_present 'sysctl -n kern.hv_vmm_present'
fact host.loadavg 'sysctl -n vm.loadavg'
fact host.hardware_overview 'system_profiler SPHardwareDataType'
fact host.runner_image 'echo "ImageOS=${ImageOS:-unset} ImageVersion=${ImageVersion:-unset} RUNNER_ARCH=${RUNNER_ARCH:-unset}"'
fact pin.homebrew 'brew --version | head -1'
fact pin.xcode 'xcodebuild -version | tr "\n" " "'
fact pin.node 'node --version'
fact pin.python 'python3 --version'
fact pin.pnpm 'pnpm --version'

# ======================= step 1: can a vz VM boot? =======================
python3 "$T" timed "$OUT" probe.vz_framework 120 -- swift "$HERE/vz-probe.swift"
rec probe.vz_framework.output "$(cat "$OUT/logs/probe.vz_framework.log" 2>/dev/null)" text "swift scripts/spike/vz-probe.swift" ""

VM_BOOTED=no
if fetch "$VFKIT_URL" "$WORK/vfkit" "$VFKIT_SHA256" \
   && fetch "$ALPINE_BASE/$GUEST_ARCH/$ALPINE_NETBOOT/vmlinuz-virt" "$WORK/vmlinuz-virt" "$KERNEL_SHA256" \
   && fetch "$ALPINE_BASE/$GUEST_ARCH/$ALPINE_NETBOOT/initramfs-virt" "$WORK/initramfs-virt" "$INITRD_SHA256"; then
  chmod +x "$WORK/vfkit"
  fact pin.vfkit "'$WORK/vfkit' --version"
  fact pin.guest "echo 'alpine $ALPINE_NETBOOT $GUEST_ARCH vmlinuz-virt sha256=$KERNEL_SHA256 initramfs-virt sha256=$INITRD_SHA256'"
  # Does this vfkit expose save/restore of machine state? (help text only; nothing is saved.)
  fact vm.state_flags_in_help "'$WORK/vfkit' --help 2>&1 | grep -i -E 'state|restore|snapshot' || echo 'no state/restore/snapshot text in --help'"
  if python3 "$T" vmboot "$OUT" vm.boot 5 "$WORK/vfkit" "$WORK/vmlinuz-virt" "$WORK/initramfs-virt"; then
    VM_BOOTED=yes
  fi
fi
if [ "$DOWNLOAD_FAILED" = 1 ]; then VM_BOOTED=not_tested; fi
rec result.vm_booted "$VM_BOOTED" text "see vm.boot.* rows" "step 1 verdict: yes only if the guest wrote a console byte; not_tested means a download or its sha256 check failed and no boot was tried"

if [ "$VM_BOOTED" = yes ]; then
  # ======================= step 2a: the VM boots =======================
  # The numbers are in vm.boot.* above. Save/restore and the in-guest check.sh are not driven from this script:
  # the Alpine netboot guest has no node or pnpm, and vfkit's state flags are recorded above for B-1 to try.
  rec result.vm_in_guest_check "not run" text "" "the netboot guest has no node/pnpm; needs a real guest image (a B-1 question)"
  rec result.nested_note "nested virtualization (see host.hv_vmm_present); not a measure of bare-metal Mac performance" text "" ""
else
  # ======================= step 2b: the Seatbelt fallback =======================
  PROFILE="$OUT/seatbelt.sb"
  CANARY="$WORK/canary-secrets"
  mkdir -p "$CANARY"
  echo "canary" > "$CANARY/secret.txt"
  cat > "$PROFILE" <<'EOF'
(version 1)
(allow default)
(deny network*)
(allow network-outbound (remote ip "localhost:*"))
(allow network-bind (local ip "localhost:*"))
(allow network-inbound (local ip "localhost:*"))
(deny file-write*)
(allow file-write*
  (subpath (param "WORKSPACE"))
  (subpath (param "WORK"))
  (subpath "/private/tmp")
  (subpath "/private/var/folders")
  (subpath "/dev"))
(deny file-read* (subpath (param "CANARY")))
EOF
  sbx() { sandbox-exec -f "$PROFILE" -D "WORKSPACE=$WORKSPACE" -D "WORK=$WORK" -D "CANARY=$CANARY" "$@"; }
  if ! sbx /usr/bin/true 2>"$OUT/logs/profile-check.log"; then
    rec seatbelt.profile_invalid "$(cat "$OUT/logs/profile-check.log")" text "sandbox-exec -f seatbelt.sb /usr/bin/true" "falling back to a profile without the loopback rule"
    sed -i.bak -e '/localhost/d' "$PROFILE"
  fi
  sbx /usr/bin/true && rec seatbelt.trivial_profile "runs" text "sandbox-exec -f seatbelt.sb /usr/bin/true" "exit 0"
  rec seatbelt.profile "$(cat "$PROFILE")" text "cat seatbelt.sb" "writes limited to the workspace, the work dir, the device directory, /private/tmp and /private/var/folders (broader than workspace alone); network denied except loopback; one read-deny canary"

  # Start-up overhead.
  python3 "$T" timeit "$OUT" seatbelt.true_bare 30 -- /usr/bin/true
  python3 "$T" timeit "$OUT" seatbelt.true_sandboxed 30 -- sandbox-exec -f "$PROFILE" -D "WORKSPACE=$WORKSPACE" -D "WORK=$WORK" -D "CANARY=$CANARY" /usr/bin/true
  python3 "$T" timeit "$OUT" seatbelt.node_bare 15 -- node -e 0
  python3 "$T" timeit "$OUT" seatbelt.node_sandboxed 15 -- sandbox-exec -f "$PROFILE" -D "WORKSPACE=$WORKSPACE" -D "WORK=$WORK" -D "CANARY=$CANARY" node -e 0

  # What it can and cannot confine. expect = what a confining sandbox should do.
  export WORKSPACE WORK CANARY OUTSIDE="$HOME/spike-outside-probe"
  cat > "$WORK/loopback.py" <<'EOF'
import socket
s = socket.socket(); s.bind(("127.0.0.1", 0)); s.listen(1)
c = socket.create_connection(s.getsockname(), timeout=3); a, _ = s.accept(); c.sendall(b"x"); print(a.recv(1))
EOF
  probe() { # probe ID EXPECT 'shell command' [plain]
    local rc
    if [ "${4:-}" = plain ]; then bash -c "$3" >/dev/null 2>&1; rc=$?; else sbx bash -c "$3" >/dev/null 2>&1; rc=$?; fi
    if [ "$rc" = 0 ]; then rec "$1" allowed text "$3" "expected: $2; run ${4:-under the profile}"; else rec "$1" "denied (exit $rc)" text "$3" "expected: $2; run ${4:-under the profile}"; fi
  }
  probe probe.write_workspace allowed 'echo x > "$WORKSPACE/.spike-probe" && rm "$WORKSPACE/.spike-probe"'
  probe probe.write_temp allowed 'echo x > "$WORK/probe"'
  probe probe.write_outside denied 'echo x > "$OUTSIDE"'
  probe probe.write_outside_control allowed 'echo x > "$OUTSIDE" && rm "$OUTSIDE"' plain
  probe probe.write_outside_grandchild denied 'bash -c "bash -c \"echo x > \$OUTSIDE\""'
  probe probe.network_external denied 'curl -sS -m 8 -o /dev/null https://example.com'
  probe probe.network_external_control allowed 'curl -sS -m 8 -o /dev/null https://example.com' plain
  probe probe.network_loopback allowed 'python3 "$WORK/loopback.py"'
  probe probe.dns_lookup denied 'python3 -c "import socket; socket.gethostbyname(\"example.com\")"'
  probe probe.read_canary denied 'cat "$CANARY/secret.txt"'
  probe probe.read_system_file "allowed: reads outside the canary are not confined" 'cat /etc/hosts'
  probe probe.process_list "allowed: there is no pid namespace" 'ps -A'
  probe probe.nested_sandbox_exec "either: a child may only tighten" 'sandbox-exec -p "(version 1)(allow default)" /usr/bin/true'
  rec observation.cpu_memory_limits "no per-process CPU or memory cap in a Seatbelt profile" text "" "from Apple's profile language as documented, not measured here"
  rec observation.sandbox_exec_status "sandbox-exec is deprecated in its man page but still shipped" text "" "not checked against the macOS release notes"

  # The scoped check, unsandboxed and sandboxed, twice each. Caches live under $WORK so the profile's
  # write rules are the same for both. The install runs first, unsandboxed, because the profile denies network.
  export COREPACK_HOME="$WORK/corepack" npm_config_store_dir="$WORK/pnpm-store" PNPM_HOME="$WORK/pnpm-home" \
    XDG_CACHE_HOME="$WORK/xdg-cache" XDG_STATE_HOME="$WORK/xdg-state" XDG_DATA_HOME="$WORK/xdg-data" \
    FX_CHECK_AFFECTED="packages/net-guard,packages/test-guard"
  mkdir -p "$COREPACK_HOME" "$npm_config_store_dir" "$PNPM_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME" "$XDG_DATA_HOME"
  cd "$WORKSPACE" || exit "$DOWNLOAD_FAILED"
  python3 "$T" timed "$OUT" check.prewarm_install 480 -- pnpm install --frozen-lockfile
  if grep -q 'check.prewarm_install.exit.*"value": 0,' "$OUT/results.jsonl"; then
    for round in 1 2; do
      python3 "$T" timed "$OUT" "check.unsandboxed.run$round" 420 -- bash scripts/check.sh
      python3 "$T" timed "$OUT" "check.sandboxed.run$round" 420 -- sandbox-exec -f "$PROFILE" \
        -D "WORKSPACE=$WORKSPACE" -D "WORK=$WORK" -D "CANARY=$CANARY" bash scripts/check.sh
    done
    rec check.scope "$FX_CHECK_AFFECTED" text "FX_CHECK_AFFECTED=$FX_CHECK_AFFECTED bash scripts/check.sh" "n=2 per arm, alternating, install pre-warmed"
  else
    rec check.skipped "the unsandboxed pnpm install failed; see logs/check.prewarm_install.log" text "pnpm install --frozen-lockfile" "a macOS-portability finding"
  fi
  rec result.needs_real_mac "a vz VM spike needs real Mac hardware: M3 or newer, macOS 15 or later" text "" "nested virtualization is unsupported on GitHub's free arm64 runners"
fi

rm -rf "$WORK"
# A download that failed or did not verify is a failed run, not a finding: fail the step after everything else
# (the job-summary and upload steps are `if: always()`).
if [ "$DOWNLOAD_FAILED" = 1 ]; then
  echo "macos-vm-spike: a pinned download failed or did not match its sha256; step 1 was NOT TESTED" >&2
  exit 1
fi
exit 0
