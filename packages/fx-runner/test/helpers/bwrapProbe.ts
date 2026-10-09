import { spawnSync } from "node:child_process";

/**
 * Whether bubblewrap can really create the namespaces the runner's own views ask for, here. Finding a `bwrap` binary is not enough: a host that has one but
 * forbids user namespaces (the self-hosted NixOS runner's systemd service) answers "No permissions to create a new namespace", and a test that only checks for
 * a non-null exit status would run and fail. This runs bwrap with the same unshare flags as `buildNixView` plus a trivial command, and requires exit status 0
 * and the expected output.
 *
 * Test-only: `FX_TEST_BWRAP_PROBE_BIN` replaces the binary the probe runs, so a test can simulate a host without namespaces (point it at a script that exits 1).
 */
const MARKER = "fx-bwrap-probe-ok";

export function bwrapCanCreateNamespaces(bwrap: string | undefined): boolean {
  const bin = process.env["FX_TEST_BWRAP_PROBE_BIN"] ?? bwrap;
  if (bin === undefined) return false;
  const out = spawnSync(
    bin,
    [
      "--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try", "--clearenv",
      "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev",
      "--", process.execPath, "-e", `process.stdout.write(${JSON.stringify(MARKER)})`,
    ],
    { encoding: "utf8", timeout: 20_000 },
  );
  const ok = out.status === 0 && out.stdout === MARKER;
  if (!ok) console.info(`[skip] ${BWRAP_SKIP_REASON} (exit ${String(out.status)})`);
  return ok;
}

/** Why a suite skipped, printed when the probe fails. */
export const BWRAP_SKIP_REASON = "bwrap cannot create namespaces here";
