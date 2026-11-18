/**
 * The WSL2 gate (D#587 B-9b): WSL2 runs jobs only after every check in `wslChecks.ts` passes and the live probes below pass on this machine, in
 * this process. `run` calls it before any claim and `doctor` calls it for its lines. It sets `WslMachine.clearance` on success and nowhere else,
 * and `detectPlatform` refuses WSL2 without it, so a caller that forgets the gate is refused, not let through.
 *
 * The probes start the machine's own sandbox tool with the job's rules (the one shared builder, with the Windows-side denies added) and answer from
 * what it prints. Each probe has controls, because a probe that "fails" for the wrong reason would pass:
 *  - the sandbox wrapper runs a marker command successfully, and every sandboxed probe prints an exit-status marker, so a tool that never ran is not a denial;
 *  - the canary read of `/mnt/c/Users` succeeds outside the sandbox (no Windows drive to test with: refused, never skipped);
 *  - `cmd.exe` exists at its real path on the Windows drive (structural: item 3 keeps interop off, so it cannot be asked to run outside the sandbox).
 *    The sandbox hides `/mnt`, so this probe cannot see live interop by itself; the `binfmt_misc` entry check (`wsl_interop_enabled`) is what covers a live state that
 *    differs from the wsl.conf file (no `wsl --shutdown` since the change).
 * Any probe that cannot run refuses: there is no start without an answer.
 */
import path from "node:path";
import { cleanEnv } from "../job/cleanEnv.js";
import { linuxKernel } from "./platform.js";
import { PROBE_MARKER, probeSettings, sandboxLaunch, type SandboxHost, type SandboxProbeInput } from "./probe.js";
import { WSL_CONF, wslDenyPaths, wslDoctorFindings, type WslCode } from "./wslChecks.js";

export const WSL_PROBE_CODES = ["wsl_no_windows_drive", "wsl_canary_readable", "wsl_exe_launchable", "wsl_probe_unrun"] as const;
export type WslProbeCode = (typeof WSL_PROBE_CODES)[number];

export const CANARY_DIR = "/mnt/c/Users";
export const CMD_EXE = "/mnt/c/Windows/System32/cmd.exe";
export const CMD_MARKER = "fx-wsl-cmd";
const EXIT_MARKER = /fx-exit:(\d+)$/;
/** What the canary script prints: an exit status only after `ls` has run on `/`. */
const LS_STATUS = /^fx-exit:(\d+)$/;
/** The status GNU `ls` ends with when it cannot access a path ("serious trouble"). */
const LS_CANNOT_ACCESS = "2";
const PROBE_TIMEOUT_MS = 10_000;

export interface WslGateItem {
  code: WslCode | WslProbeCode;
  ok: boolean;
  detail: string;
}

export interface WslGateResult {
  /** Whether this machine is WSL2 at all; false means nothing was checked and `items` is empty. */
  wsl2: boolean;
  cleared: boolean;
  items: WslGateItem[];
  /** Whether a loopback allowance may be granted: only when `wslinfo` says the networking mode is NAT. Mirrored mode, or an answer that cannot be had, shares loopback with Windows. */
  loopback: boolean;
}

export interface WslGateFacts {
  platform: NodeJS.Platform;
  osrelease: string | undefined;
  home: string | undefined;
  stateDir: string;
  binaryPath: string | undefined;
  xdgCacheHome: string | undefined;
  searchPath: string;
  host: SandboxHost;
}

const unrun = (detail: string): WslGateItem => ({ code: "wsl_probe_unrun", ok: false, detail: `${detail}. WSL2 does not start without every live probe answering.` });

/** Runs every WSL2 check and live probe. Sets `host.wsl.clearance` only when all of them pass; clears it first, so each call decides afresh. */
export async function clearWsl(facts: WslGateFacts): Promise<WslGateResult> {
  const { host } = facts;
  if (host.wsl !== undefined) host.wsl.clearance = undefined;
  if (facts.platform !== "linux" || linuxKernel({ osrelease: facts.osrelease, wslInterop: host.wsl?.interopEntry() }) !== "wsl2") return { wsl2: false, cleared: false, items: [], loopback: false };
  const items: WslGateItem[] = wslDoctorFindings({ platform: facts.platform, osrelease: facts.osrelease, home: facts.home, stateDir: facts.stateDir, binaryPath: facts.binaryPath, xdgCacheHome: facts.xdgCacheHome, searchPath: facts.searchPath, fs: host });
  const result = (loopback = false): WslGateResult => ({ wsl2: true, cleared: items.every((item) => item.ok) && host.wsl?.clearance !== undefined, items, loopback });
  if (items.some((item) => !item.ok)) return result();
  const wsl = host.wsl;
  if (wsl === undefined || wsl.mountinfo() === undefined) {
    items.push(unrun("the mount table cannot be read"));
    return result();
  }
  if (facts.home === undefined || !path.isAbsolute(facts.home)) {
    items.push(unrun("the home directory is not known"));
    return result();
  }

  const denyPaths = wslDenyPaths(wsl);
  const binaryDir = facts.binaryPath === undefined ? path.join(facts.stateDir, "engine") : path.dirname(facts.binaryPath);
  const input: SandboxProbeInput = { platform: facts.platform, home: facts.home, stateDir: facts.stateDir, binaryDir, xdgCacheHome: facts.xdgCacheHome, searchPath: facts.searchPath, wslDenyPaths: denyPaths };
  const env: Record<string, string> = { PATH: facts.searchPath || (cleanEnv({ mode: "subscription" }).PATH ?? ""), LC_ALL: "C" };
  const settings = probeSettings(input);
  // The probes need the sandbox tool, which `detectPlatform` hands out for WSL2 only when cleared. They get a copy of the host that carries a trial clearance;
  // the shared machine object is never touched until every check and probe has passed, so a failure of any kind leaves no clearance behind.
  const trialHost: SandboxHost = { ...host, wsl: { ...wsl, clearance: { denyPaths, loopback: false } } };
  try {
    const sandboxed = async (script: string): Promise<{ code: number | null; stdout: string } | undefined> => {
      const launch = sandboxLaunch(input, settings, env.PATH ?? "", ["/bin/sh", "-c", script], trialHost);
      if (!launch.ok) return undefined;
      const out = await host.run(launch.tool, launch.args, env, PROBE_TIMEOUT_MS);
      return out.timedOut ? undefined : { code: out.code, stdout: out.stdout };
    };
    const plain = async (script: string): Promise<{ code: number | null; stdout: string }> => {
      const out = await host.run("/bin/sh", ["-c", script], env, PROBE_TIMEOUT_MS);
      return { code: out.timedOut ? null : out.code, stdout: out.stdout };
    };

    // Controls first: outside the sandbox the canary directory must be readable and cmd.exe must really be where it should be; inside, a marker command must run.
    const drive = await plain(`ls -A ${CANARY_DIR}`);
    if (drive.code !== 0 || drive.stdout.trim() === "") {
      items.push({ code: "wsl_no_windows_drive", ok: false, detail: `no Windows drive to test with: ${CANARY_DIR} cannot be read outside the sandbox, so a denial there would prove nothing. Turn automounting of the C: drive on in ${WSL_CONF} ([automount] enabled=true).` });
      return result();
    }
    const exe = await plain(`test -f ${CMD_EXE} && readlink -f ${CMD_EXE}`);
    if (exe.code !== 0 || exe.stdout.trim() !== CMD_EXE) {
      items.push({ code: "wsl_no_windows_drive", ok: false, detail: `no Windows drive to test with: ${CMD_EXE} is not a file at that real path, so the program-launch probe would prove nothing` });
      return result();
    }
    const wrapper = await sandboxed(`printf %s ${PROBE_MARKER}`);
    if (wrapper === undefined || wrapper.code !== 0 || wrapper.stdout.trim() !== PROBE_MARKER) {
      items.push(unrun("the sandbox tool did not run the test command"));
      return result();
    }

    // The canary: `ls` must first run in the sandbox (listing `/`), and only its own "cannot access" status (2) is a denial. A shell that could not find or start `ls` (126, 127), a
    // minor status (1) or anything else is no answer; a listing that succeeds, empty or not, is a readable drive (a hollow stand-in is not a denial either).
    const canary = ((await sandboxed(`ls -A / >/dev/null 2>&1 || { printf 'fx-ls-broken'; exit 0; }; ls -A ${CANARY_DIR} >/dev/null 2>&1; printf 'fx-exit:%s' "$?"`))?.stdout ?? "").match(LS_STATUS);
    if (canary === null) items.push(unrun(`the canary read of ${CANARY_DIR} gave no answer from \`ls\``));
    else if (canary[1] === LS_CANNOT_ACCESS) items.push({ code: "wsl_canary_readable", ok: true, detail: `${CANARY_DIR} is readable outside the sandbox and denied inside it` });
    else if (canary[1] === "0") items.push({ code: "wsl_canary_readable", ok: false, detail: `a job could read ${CANARY_DIR}, the Windows user profiles: the sandbox does not hide the Windows drives. They must be denied before WSL2 is accepted.` });
    else items.push(unrun(`the canary read of ${CANARY_DIR} ended with status ${canary[1]}, which is not \`ls\`'s "cannot access" answer`));

    const launched = (await sandboxed(`${CMD_EXE} /c echo ${CMD_MARKER} 2>&1; printf 'fx-exit:%s' "$?"`))?.stdout ?? "";
    const exit = launched.match(EXIT_MARKER);
    if (exit === null) items.push(unrun("the program-launch probe gave no exit status"));
    else if (exit[1] === "0" || launched.includes(CMD_MARKER)) items.push({ code: "wsl_exe_launchable", ok: false, detail: "a job could start cmd.exe: Windows interop is live. Set [interop] enabled=false in /etc/wsl.conf and run wsl --shutdown from Windows." });
    else items.push({ code: "wsl_exe_launchable", ok: true, detail: "cmd.exe cannot be started from the job's sandbox" });

    // Not a gate: loopback allowances are granted only when the networking mode is known to be NAT.
    const mode = await plain("wslinfo --networking-mode");
    const loopback = mode.code === 0 && mode.stdout.trim() === "nat";
    // Only now, with every check and probe passed, does the shared machine get its clearance.
    if (items.every((item) => item.ok)) wsl.clearance = { denyPaths, loopback };
    return result(loopback);
  } catch {
    // fx-swallow-ok: a probe that threw is a probe that did not run: reported as such, with no error text, and nothing starts
    items.push(unrun("a live probe could not be run"));
    return result();
  }
}
