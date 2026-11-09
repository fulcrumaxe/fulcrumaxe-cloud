/**
 * D#749 V2b: the daemon's own check that this machine can serve a browser job (the deploy verifier), made by the daemon and never by the model. Three things must hold:
 *  1. a test account is configured (`verify.test_account`), so a browser job has an identity to be checked against;
 *  2. Chrome is running under this user;
 *  3. the Claude in Chrome extension is connected: the extension's native host (`claude --chrome-native-host`, started by Chrome) is alive and has made its socket in the
 *     bridge directory under the temporary directory (`claude-mcp-browser-bridge-<user>/<pid>.sock`). The CLI's `--chrome` flag reaches the extension through that socket.
 *
 * WHAT THE DAEMON CANNOT READ. Which account the page is signed in as (the app's session, e.g. a GitHub login) lives in the browser's cookies; reading it means either driving a
 * page, which is the model's job, or reading the profile's cookie store, which is a credential read this runner does not make. So the probe does NOT claim to have verified
 * the signed-in account. The closest daemon-side checks are the three above. `accountLabel` is a port for a reader that can name the account (a later check, or a test); with
 * none wired, the account is checked from the sign-in evidence the browser job reports, by the stage that judges it (`wrong_account` there), and never passed on trust.
 *
 * WHAT IS UNPROVEN. The bridge directory and the native host's command line are what this machine's installed CLI does today, observed and not documented; a different CLI
 * version may move them, and then this probe says "not connected" (it fails closed) until it is updated. The owner's one-time manual smoke (docs, runner page) is the proof
 * that the whole path, `claude -p --chrome`, attaches.
 *
 * The process list arrives through a port (`processes`; the real one runs `ps` for this user through the engine's own capture, `psProcesses` below), so this file reads no process
 * table itself. Linux only: on any other platform the answer is `unsupported_platform` (not connected), never a guess. The only file reads are `lstat` and a directory listing of
 * a name this file builds itself from the user name; nothing from a job, the cloud or a page reaches a path here.
 */
import { lstatSync, readdirSync, type Stats } from "node:fs";
import path from "node:path";
import type { InstallCapture } from "./engineKit.js";

/** The closed reasons a browser job cannot be served. All of them read as the one sentence `CHROME_NOT_CONNECTED`. */
export type BrowserProbeReason = "not_configured" | "unsupported_platform" | "chrome_not_running" | "bridge_not_connected" | "wrong_account" | "account_unreadable" | "processes_unreadable";
export type BrowserProbeResult = { ok: true } | { ok: false; reason: BrowserProbeReason };

/** The sentence shown wherever the probe's failure is told to a person. */
export const CHROME_NOT_CONNECTED = "chrome not connected";

export interface ProcessInfo {
  pid: number;
  /** The program's name as the kernel keeps it (15 characters). */
  comm: string;
  /** The command line, as one string. Only ever searched for one whole word; never logged or sent. */
  args: string;
}

export interface BrowserProbeDeps {
  /** The configured test account label, read fresh on every probe (a change applies from the next claim). */
  testAccount: () => string | undefined;
  /** The user the daemon runs as. The bridge directory and its sockets must belong to this uid. */
  uid: number;
  username: string;
  platform: NodeJS.Platform;
  /** This user's processes, or undefined when they could not be listed (the probe then fails closed). */
  processes: () => Promise<readonly ProcessInfo[] | undefined>;
  /** The temporary directory the bridge directory is in. Default `/tmp`. */
  tmpRoot?: string;
  /** Replaceable by a test, to give one path another owner (a real file of another user cannot be made without root). Default: `lstat`, null when the name is not there. */
  lstat?: (target: string) => Stats | null;
  /** A daemon-side reader of the signed-in account's label; absent in production (see above). */
  accountLabel?: () => string | undefined;
}

const USERNAME = /^[A-Za-z0-9._-]{1,64}$/;
const SOCKET_NAME = /^(\d{1,10})\.sock$/;
/** The names a Chrome process runs under (the kernel keeps 15 characters of it, so `google-chrome-stable` is `google-chrome-s`); a wrapper may add a leading dot. */
const CHROME_COMM = /^(?:chrome|chromium(?:-browse)?|google-chrome(?:-[a-z])?)(?:-wrapped)?$/;
const NATIVE_HOST_FLAG = "--chrome-native-host";

function lstatOrNull(target: string): Stats | null {
  try {
    return lstatSync(target);
  } catch {
    // fx-swallow-ok: a name that is not there is the answer "no"
    return null;
  }
}

/** The pids of the live native hosts in `list`: the command line holds the flag as a whole word. */
const nativeHostPids = (list: readonly ProcessInfo[]): Set<number> => new Set(list.filter((p) => p.args.split(/\s+/).includes(NATIVE_HOST_FLAG)).map((p) => p.pid));

/** Whether the bridge directory is a private directory of this user and holds a socket made by one of `hosts`. */
function bridgeConnected(uid: number, username: string, tmpRoot: string, hosts: ReadonlySet<number>, lstatOrNull: (target: string) => Stats | null): boolean {
  if (!USERNAME.test(username)) return false;
  const dir = path.join(tmpRoot, `claude-mcp-browser-bridge-${username}`);
  const dirStat = lstatOrNull(dir);
  // A link, another user's directory or one open to others is not the bridge directory this user's Chrome made.
  if (dirStat === null || !dirStat.isDirectory() || dirStat.uid !== uid || (dirStat.mode & 0o077) !== 0) return false;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // fx-swallow-ok: an unreadable directory is "not connected"
    return false;
  }
  return names.some((name) => {
    const match = name.match(SOCKET_NAME);
    if (match === null) return false;
    const socket = lstatOrNull(path.join(dir, name));
    return socket !== null && socket.isSocket() && socket.uid === uid && hosts.has(Number(match[1]));
  });
}

export async function probeBrowser(deps: BrowserProbeDeps): Promise<BrowserProbeResult> {
  const account = deps.testAccount();
  if (account === undefined || account === "") return { ok: false, reason: "not_configured" };
  if (deps.platform !== "linux") return { ok: false, reason: "unsupported_platform" };
  const list = await deps.processes();
  if (list === undefined) return { ok: false, reason: "processes_unreadable" };
  if (!list.some((p) => CHROME_COMM.test(p.comm.replace(/^\./, "")))) return { ok: false, reason: "chrome_not_running" };
  if (!bridgeConnected(deps.uid, deps.username, deps.tmpRoot ?? "/tmp", nativeHostPids(list), deps.lstat ?? lstatOrNull)) return { ok: false, reason: "bridge_not_connected" };
  if (deps.accountLabel !== undefined) {
    const label = deps.accountLabel();
    if (label === undefined) return { ok: false, reason: "account_unreadable" };
    if (label !== account) return { ok: false, reason: "wrong_account" };
  }
  return { ok: true };
}

/** The most output of the process listing that is kept (the end of it). */
const PS_TAIL_CHARS = 2 * 1024 * 1024;
const PS_LINE = /^\s*(\d{1,10})\s+(\S+)(?:\s+(.*))?$/;

/**
 * The real `processes` port: `ps -u <uid> -o pid=,comm=,args=` through the engine's process-group capture, with a fixed environment and a short time limit. Only this user's
 * processes are listed. A listing that fails, times out or gives nothing is `undefined`, so the probe fails closed.
 */
export async function psProcesses(capture: InstallCapture, uid: number, searchPath: string | undefined): Promise<readonly ProcessInfo[] | undefined> {
  const out = await capture("ps", ["-ww", "-u", String(uid), "-o", "pid=,comm=,args="], { PATH: searchPath ?? "/usr/bin:/bin", LC_ALL: "C" }, "/", 10_000, PS_TAIL_CHARS, undefined, undefined);
  if (out.code !== 0 || out.timedOut) return undefined;
  const list: ProcessInfo[] = [];
  for (const line of out.tail.split("\n")) {
    const match = line.match(PS_LINE);
    if (match !== null) list.push({ pid: Number(match[1]), comm: match[2]!, args: match[3] ?? "" });
  }
  return list.length === 0 ? undefined : list;
}
