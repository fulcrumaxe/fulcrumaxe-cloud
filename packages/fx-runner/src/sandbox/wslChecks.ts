/**
 * What `fx-runner doctor` checks on WSL2 (D#587 B-9): the four settings that decide whether the Windows side is reachable from a job.
 * WSL2 is still refused by `detectPlatform`; these checks say what to change so the refusal can be lifted later, and each failure carries a
 * closed code. Everything is read through an injected file reader, so a test fakes `/proc`, `binfmt_misc` and `/etc/wsl.conf` and needs no WSL.
 */
import path from "node:path";
import { cacheRootsFor } from "../daemon/mirror.js";
import { linuxKernel, type WslMachine } from "./platform.js";
import { probeSettings } from "./probe.js";

export const WSL_CODES = ["wsl_interop_enabled", "wsl_drvfs_exposed", "wsl_mnt_path", "wsl_append_windows_path"] as const;
export type WslCode = (typeof WSL_CODES)[number];

export const WSL_CONF = "/etc/wsl.conf";
/** The file systems through which Windows drives (and the WSL host's own shares) reach the Linux side. */
const WINDOWS_FS_TYPES: ReadonlySet<string> = new Set(["9p", "drvfs", "virtiofs"]);
const LISTED_MAX = 5;

/** The part of the machine these checks read: a small file by path (`/etc/wsl.conf`) and the two WSL facts only the entry point can name. Without `wsl`, the interop entry reads as absent and the mount table as empty. */
export interface WslFs {
  readText(target: string): string | undefined;
  wsl?: WslMachine | undefined;
}

export interface WslCheckInput {
  fs: WslFs;
  /** The sandbox's `denyRead` and `denyWrite`, as the job settings give them. */
  denyRead: readonly string[];
  denyWrite: readonly string[];
  /** The directories a job uses or that hold runner data: [what it is, where]. */
  directories: ReadonlyArray<readonly [label: string, dir: string]>;
}

export interface WslFinding {
  code: WslCode;
  ok: boolean;
  /** What to change and why when `ok` is false; what was seen when it is true. */
  detail: string;
}

/** `[section] key = value` lines of `/etc/wsl.conf`, section and key names lower-cased. A key that is not there is undefined. */
export function wslConfValue(text: string | undefined, section: string, key: string): string | undefined {
  let current = "";
  let found: string | undefined;
  for (const raw of (text ?? "").split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, "").trim();
    const header = line.trim().match(/^\[([^\]]+)\]$/);
    if (header !== null) {
      current = header[1]!.trim().toLowerCase();
      continue;
    }
    const pair = line.match(/^([^=]+?)\s*=\s*(.*)$/);
    if (current === section && pair !== null && pair[1]!.toLowerCase() === key.toLowerCase()) found = pair[2]!.replace(/^"(.*)"$/, "$1").trim().toLowerCase();
  }
  return found;
}

/** The mount points of 9p, drvfs and virtiofs file systems in a `mountinfo` text. A line that cannot be read is skipped. */
export function windowsMounts(mountinfo: string): string[] {
  const points: string[] = [];
  for (const line of mountinfo.split("\n")) {
    const split = line.indexOf(" - ");
    if (split < 0) continue;
    const left = line.slice(0, split).split(" ");
    const fsType = line.slice(split + 3).split(" ")[0] ?? "";
    // The kernel writes space, tab, newline and backslash in a path as three octal digits after a backslash.
    const point = left[4]?.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
    if (point !== undefined && point.startsWith("/") && WINDOWS_FS_TYPES.has(fsType)) points.push(path.posix.normalize(point));
  }
  return points;
}

/** Whether `target` is `entry` or lies under it. */
function under(target: string, entry: string): boolean {
  const base = path.posix.normalize(entry).replace(/\/+$/, "");
  return target === base || target.startsWith(`${base}/`);
}

function isMnt(dir: string): boolean {
  return under(path.posix.normalize(dir), "/mnt") && path.posix.normalize(dir) !== "/mnt";
}

function listed(items: readonly string[]): string {
  const unique = [...new Set(items)].sort();
  return unique.length > LISTED_MAX ? `${unique.slice(0, LISTED_MAX).join(", ")} and ${unique.length - LISTED_MAX} more` : unique.join(", ");
}

/**
 * The checks as doctor runs them, or nothing when this is not WSL2. The deny lists are the ones a job would get (`probeSettings`), the
 * directories are the state, workspace and mirrors directories. Without a home directory the deny lists are empty, which fails closed.
 */
export function wslDoctorFindings(facts: { platform: NodeJS.Platform; osrelease: string | undefined; home: string | undefined; stateDir: string; binaryPath: string | undefined; xdgCacheHome: string | undefined; fs: WslFs }): WslFinding[] {
  if (facts.platform !== "linux" || linuxKernel({ osrelease: facts.osrelease, wslInterop: facts.fs.wsl?.interopEntry() }) !== "wsl2") return [];
  let denyRead: string[] = [];
  let denyWrite: string[] = [];
  const directories: Array<[string, string]> = [["state directory", facts.stateDir]];
  if (facts.home !== undefined) {
    const binaryDir = facts.binaryPath === undefined ? path.join(facts.stateDir, "engine") : path.dirname(facts.binaryPath);
    const block = (probeSettings({ platform: facts.platform, home: facts.home, stateDir: facts.stateDir, binaryDir, xdgCacheHome: facts.xdgCacheHome }).filesystem ?? {}) as { denyRead?: string[]; denyWrite?: string[] };
    denyRead = block.denyRead ?? [];
    denyWrite = block.denyWrite ?? [];
    const roots = cacheRootsFor({ home: facts.home, platform: facts.platform, xdgCacheHome: facts.xdgCacheHome });
    directories.push(["workspace directory", roots.workspaceRoot], ["mirrors directory", roots.mirrorsRoot]);
  }
  return wslChecks({ fs: facts.fs, denyRead, denyWrite, directories });
}

/** The four checks, in a fixed order, each answering PASS (`ok`) or a refusal with its code. */
export function wslChecks(input: WslCheckInput): WslFinding[] {
  const conf = input.fs.readText(WSL_CONF);
  const findings: WslFinding[] = [];

  const interopOn = input.fs.wsl?.interopEntry() === true;
  const interopConf = wslConfValue(conf, "interop", "enabled");
  if (interopOn || interopConf !== "false") {
    const why = interopOn ? `the WSLInterop entry exists, so a job could start Windows programs (cmd.exe, powershell.exe)` : `${WSL_CONF} does not set [interop] enabled=false, and the default lets a job start Windows programs`;
    findings.push({ code: "wsl_interop_enabled", ok: false, detail: `${why}. Put "[interop]" and "enabled=false" in ${WSL_CONF}, then run "wsl --shutdown" from Windows and open the distribution again. The cost: no .exe launches from WSL2 while the runner is installed.` });
  } else {
    findings.push({ code: "wsl_interop_enabled", ok: true, detail: "Windows interop is off" });
  }

  // A mount table that cannot be read (or is empty, which a running system never has) says nothing about the drives: that fails closed, never passes.
  const table = input.fs.wsl?.mountinfo();
  const exposed = windowsMounts(table ?? "").filter((mount) => !input.denyRead.some((entry) => under(mount, entry)) || !input.denyWrite.some((entry) => under(mount, entry)));
  if (table === undefined || table.trim() === "") findings.push({ code: "wsl_drvfs_exposed", ok: false, detail: "could not read the mount table, so it is unknown whether Windows drives (9p, drvfs or virtiofs mounts) are reachable from a job. Run doctor as the user who runs the runner, on a machine where the kernel's mount table can be read." });
  else if (exposed.length > 0) findings.push({ code: "wsl_drvfs_exposed", ok: false, detail: `${listed(exposed)} (9p, drvfs or virtiofs) reach the Windows side and are not in both the sandbox's read and write deny lists, so a job could read or change Windows files. They must be denied before WSL2 is accepted.` });
  else findings.push({ code: "wsl_drvfs_exposed", ok: true, detail: "every 9p, drvfs and virtiofs mount is denied for reads and writes" });

  const onWindowsDrive = input.directories.filter(([, dir]) => isMnt(dir));
  if (onWindowsDrive.length > 0) findings.push({ code: "wsl_mnt_path", ok: false, detail: `${onWindowsDrive.map(([label, dir]) => `the ${label} (${dir})`).join(", ")} sits under /mnt, which is a Windows drive: it is slow, Windows programs can change it, and the sandbox cannot protect it. Move it into the Linux file system, for example under your home directory.` });
  else findings.push({ code: "wsl_mnt_path", ok: true, detail: "no runner directory is under /mnt" });

  if (wslConfValue(conf, "interop", "appendwindowspath") !== "false") findings.push({ code: "wsl_append_windows_path", ok: false, detail: `${WSL_CONF} does not set [interop] appendWindowsPath=false, so the Windows PATH is added to a job's PATH and could start Windows programs. Set appendWindowsPath=false under [interop], then run "wsl --shutdown" and open the distribution again.` });
  else findings.push({ code: "wsl_append_windows_path", ok: true, detail: "the Windows PATH is not added" });

  return findings;
}
