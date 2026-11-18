/**
 * Engine bridge EB-11b: the kill path. When the cloud says a repo's engine is halted (a higher `halt_epoch` on a pull), or a person runs
 * `fx-runner engine-host stop` on the machine, the runner ends everything the engine host started, and says how sure it is.
 *
 * Order, and why:
 *  1. `engine-halt.json` is written FIRST ({halted:true, halt_epoch, at}), before anything else is read or validated. The engine's hooks refuse on it, so
 *     even a host that survives the rest of this cannot start a spawn or a merge. It is atomic, 0600 and written without following a link (a planted link
 *     is replaced by the rename, never written through). A halt file or host file that cannot be read never stops this write or the kill that follows:
 *     an unreadable halt file is "halted at an unknown epoch" and is overwritten.
 *  2. SIGTERM to the host's process group, SIGKILL to what is left after 10 s (processGroup.ts's `terminateGroup`). The group is only signalled when
 *     it is the host's: the pid must be its own group leader (`pgid === pid`), and on Linux with a unit its cgroup must be that unit. A group whose
 *     leader has exited is still the host's group while it has members (a group id is not reused while any member lives), so it is still signalled.
 *  3. On Linux, the host's systemd user scope is killed (`systemctl --user kill --signal=SIGKILL <unit>`, repeated while the scope still has
 *     processes) and its `cgroup.procs` is read until it is empty. A process that called setsid, or a background task that left the group, is still in the
 *     scope, so this is what makes "no process of the host's tree is alive" a checked fact (`method: "scope"`). The unit is pinned to the supervisor's
 *     own naming (`fx-engine-host-<repo id>.scope`), never a desktop's `app-*.scope`, and never this runner's own scope.
 *  4. Where there is no scope (macOS, or no user systemd) only the group is killed, survivors are counted by a process-group scan, and the method is
 *     `group_only`: a process that left the group is not found and the app says so.
 *  5. Where nothing could be checked (no host handle and no way to find the host, or a handle that did not match what it names) the method is `none` and
 *     survivors is 1: unknown counts as alive, so a halt is never reported cleaner than it was checked.
 *
 * Nothing here talks to the cloud: the caller sends `halt_applied` with what this returns (`haltAppliedPayload`). The local stop uses the same function
 * with no cloud call. A clear rewrites the file to halted:false at the same epoch and never restarts the host; a person starts it again.
 */
import { EngineStateError, readJsonNoFollow, writeJsonAtomic } from "./stateFiles.js";

export const ENGINE_HALT_FILE = "engine-halt.json";
export const ENGINE_HOST_FILE = "engine-host.json";
/** How long the host's group gets to exit on SIGTERM before SIGKILL. */
export const HALT_TERM_GRACE_MS = 10_000;
/** How long the scope's `cgroup.procs` is polled for emptiness after the SIGKILL. */
export const SCOPE_EMPTY_WAIT_MS = 5_000;
/** How many 50 ms polls pass between two SIGKILLs to a scope that still has processes (a process that forked after the first one is caught by the next). */
const SCOPE_RE_KILL_EVERY = 4;

export interface EngineHaltFile {
  halted: boolean;
  halt_epoch: number;
  /** ISO time the file was written. */
  at: string;
  /** Present (true) only when a person stopped the host on this machine with `engine-host stop`: a stop a cloud control cannot clear. */
  local_stop?: true;
}

/** What the runner knows about the running host: its pid (the leader of its own process group) and, on Linux, the systemd user scope it was started in. */
export interface EngineHostHandle {
  pid: number;
  unit?: string;
  /**
   * When the host process started (Linux: field 22 of its stat file; elsewhere `ps -o lstart=`), written by the supervisor. The kill path signals a pid's group only
   * while the process now holding that pid still started at this time, so a pid reused by an unrelated group leader is never signalled. Absent in a handle written
   * by anything older: then the other checks (group leader, cgroup) apply alone.
   */
  start_time?: string;
  /**
   * When the supervisor last said the host is alive (ISO time), rewritten every few seconds while a host runs, also while it applies a command. The engine's
   * reader hands commands to the host only while this is no older than 60 s, and takes them back when it is. Absent in a handle written by anything older.
   */
  heartbeat_at?: string;
}

/** What a start time may look like on file: digits (Linux ticks) or a `ps` date line. Anything else is refused. */
const START_TIME = /^[A-Za-z0-9 :._-]{1,64}$/;

/** `none`: nothing could be checked (survivors is 1). The wire event knows only the other two; `haltAppliedPayload` maps it. */
export type HaltMethod = "scope" | "group_only" | "none";
export interface KillOutcome {
  method: HaltMethod;
  /** Processes of the host's tree still alive after the kill path: counted in the scope's cgroup, or by a process-group scan for `group_only`. 1 for `none`. */
  survivors: number;
  /** What was refused or could not be checked, in words for the person at the terminal. Never sent to the cloud. */
  refused?: string[];
}
/** What a halt returns to its caller: `halt_epoch`, the outcome and (for the person) what was refused. */
export interface HaltApplied extends KillOutcome {
  halt_epoch: number;
}

/** The `halt_applied` event's fields (EB-1 knows two methods): `none` goes out as `group_only` with its one unproven survivor. */
export function haltAppliedPayload(applied: HaltApplied): { halt_epoch: number; method: "scope" | "group_only"; survivors: number } {
  return { halt_epoch: applied.halt_epoch, method: applied.method === "scope" ? "scope" : "group_only", survivors: applied.survivors };
}

/** The halt file could not be written. The kill was still attempted, and its result is here. */
export class HaltFileWriteError extends EngineStateError {
  constructor(
    readonly applied: HaltApplied,
    readonly reason: string,
  ) {
    super(`the halt file could not be written (${reason}); the kill path ran anyway`);
    this.name = "HaltFileWriteError";
  }
}

export interface RunResult {
  code: number | null;
  stdout: string;
}

/** The part of the by-name program runner this file uses, so nothing under src/ names the module: bin/fx-runner.mjs hands the real one in. */
export type FileRunner = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number; env: Record<string, string> },
  callback: (error: (Error & { code?: unknown }) | null, stdout: string) => void,
) => unknown;

/** What the kill path needs from the machine. `haltDepsFrom` builds it from the real functions bin/fx-runner.mjs holds; tests build it from real ones too. */
export interface HaltDeps {
  platform: NodeJS.Platform;
  uid: number;
  /** This runner's own pid, so the kill path can refuse to signal its own process group or scope. */
  ownPid: number;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  /** Runs a program by name with an argument vector (never a shell). Resolves with its exit code, or null when it could not start. */
  capture: (file: string, args: readonly string[]) => Promise<RunResult>;
  /** The text of a file, or undefined when it cannot be read. */
  readText: (path: string) => string | undefined;
  /** The cgroup file of a process (Linux), or undefined when it cannot be read. Supplied by bin/fx-runner.mjs: src/ never names the process table's paths. */
  readPidCgroup: (pid: number) => string | undefined;
  /** A process's start time on Linux (field 22 of its stat file), or undefined when it is gone or unreadable. Supplied by bin/fx-runner.mjs. Off Linux `ps -o lstart=` is used. */
  readPidStart?: ((pid: number) => string | undefined) | undefined;
  /** The `cgroup.procs` file of a control group (a path below the cgroup root, as systemd reports it). Supplied by bin/fx-runner.mjs, which names the cgroup mount. */
  cgroupProcsFile: (controlGroup: string) => string;
  /** SIGTERM to the process group, SIGKILL to what is left after `graceMs`; resolves when the group is empty (processGroup.ts's `terminateGroup`). */
  terminateGroup: (pgid: number, graceMs: number) => Promise<void>;
  termGraceMs: number;
  scopeEmptyWaitMs: number;
}

export interface HaltHost {
  platform: NodeJS.Platform;
  uid: number | undefined;
  ownPid: number;
  runFile: FileRunner;
  readFile: (path: string, encoding: "utf8") => string;
  readPidCgroup: (pid: number) => string | undefined;
  readPidStart?: ((pid: number) => string | undefined) | undefined;
  cgroupProcsFile: (controlGroup: string) => string;
  terminateGroup: (pgid: number, graceMs: number) => Promise<void>;
  /** The few variables `ps` and `systemctl --user` need, already looked up by name by the caller. Undefined ones are left out. */
  env: Readonly<Record<string, string | undefined>>;
}

export function haltDepsFrom(host: HaltHost): HaltDeps {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(host.env)) if (v !== undefined) env[k] = v;
  return {
    platform: host.platform,
    uid: host.uid ?? -1,
    ownPid: host.ownPid,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    capture: (file, args) =>
      new Promise((resolve) => {
        host.runFile(file, [...args], { timeout: 15_000, maxBuffer: 1 << 20, env }, (error, stdout) => {
          const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
          resolve({ code, stdout: String(stdout ?? "") });
        });
      }),
    readText: (p) => {
      try {
        return host.readFile(p, "utf8");
      } catch {
        // fx-swallow-ok: an unreadable cgroup file is "cannot verify", which the caller treats as one survivor it could not count
        return undefined;
      }
    },
    readPidCgroup: host.readPidCgroup,
    readPidStart: host.readPidStart,
    cgroupProcsFile: host.cgroupProcsFile,
    terminateGroup: host.terminateGroup,
    termGraceMs: HALT_TERM_GRACE_MS,
    scopeEmptyWaitMs: SCOPE_EMPTY_WAIT_MS,
  };
}

// ---- the files ----------------------------------------------------------------------------------------------------------------------------

/** Writes the halt file. A planted link at the name is replaced by the rename (nothing is written through it). */
export function writeHaltFile(stateDir: string, file: EngineHaltFile, uid: number): void {
  writeJsonAtomic(stateDir, ENGINE_HALT_FILE, file, uid, { replaceLink: true });
}

/** The halt file, or undefined when there is none. A file that does not have the exact shape is refused rather than guessed at. */
export function readHaltFile(stateDir: string, uid: number): EngineHaltFile | undefined {
  const raw = readJsonNoFollow(stateDir, ENGINE_HALT_FILE, uid);
  if (raw === undefined) return undefined;
  const o = raw as Record<string, unknown> | null;
  if (o === null || typeof o !== "object" || Array.isArray(o)) throw new EngineStateError("engine-halt.json is not an object");
  const keys = Object.keys(o).sort().join(",");
  const shapeOk = keys === "at,halt_epoch,halted" || (keys === "at,halt_epoch,halted,local_stop" && o.local_stop === true);
  if (!shapeOk || typeof o.halted !== "boolean" || !Number.isSafeInteger(o.halt_epoch) || (o.halt_epoch as number) < 0 || typeof o.at !== "string") {
    throw new EngineStateError("engine-halt.json has an unexpected shape");
  }
  if (o.local_stop === true && o.halted !== true) throw new EngineStateError("engine-halt.json has an unexpected shape");
  return o.local_stop === true ? { halted: o.halted, halt_epoch: o.halt_epoch as number, at: o.at, local_stop: true } : { halted: o.halted, halt_epoch: o.halt_epoch as number, at: o.at };
}

/** The supervisor's unit naming (EB-12a): one scope per repo, named for the repo's GitHub id. Nothing else is ever signalled as a scope. */
const UNIT = /^fx-engine-host-[1-9][0-9]{0,18}\.scope$/;

/** The unit the supervisor names for a repo's engine host, or undefined when the id is not a plain positive integer. */
export function conventionalUnit(repoGhId: number | string): string | undefined {
  const unit = `fx-engine-host-${String(repoGhId)}.scope`;
  return UNIT.test(unit) ? unit : undefined;
}

/** The host handle the supervisor (EB-12a) writes to `engine-host.json`: `{pid, unit?}`. Refused unless exactly that, with a real pid and the supervisor's own unit name. */
export function readHostHandle(stateDir: string, uid: number): EngineHostHandle | undefined {
  const raw = readJsonNoFollow(stateDir, ENGINE_HOST_FILE, uid);
  if (raw === undefined) return undefined;
  const o = raw as Record<string, unknown> | null;
  if (o === null || typeof o !== "object" || Array.isArray(o)) throw new EngineStateError("engine-host.json is not an object");
  const extra = Object.keys(o).filter((k) => k !== "pid" && k !== "unit" && k !== "start_time" && k !== "heartbeat_at");
  if (extra.length > 0 || !Number.isSafeInteger(o.pid) || (o.pid as number) <= 1) throw new EngineStateError("engine-host.json has an unexpected shape");
  if (o.unit !== undefined && (typeof o.unit !== "string" || !UNIT.test(o.unit))) throw new EngineStateError("engine-host.json names a unit that is not an engine host scope");
  if (o.start_time !== undefined && (typeof o.start_time !== "string" || !START_TIME.test(o.start_time))) throw new EngineStateError("engine-host.json has an unexpected start time");
  if (o.heartbeat_at !== undefined && (typeof o.heartbeat_at !== "string" || o.heartbeat_at.length > 40 || !Number.isFinite(Date.parse(o.heartbeat_at)))) throw new EngineStateError("engine-host.json has an unexpected heartbeat time");
  return {
    pid: o.pid as number,
    ...(o.unit === undefined ? {} : { unit: o.unit as string }),
    ...(o.start_time === undefined ? {} : { start_time: o.start_time as string }),
    ...(o.heartbeat_at === undefined ? {} : { heartbeat_at: o.heartbeat_at as string }),
  };
}

/** When the process now holding `pid` started, or undefined when there is none or it cannot be read. Linux: the injected stat reader; elsewhere: `ps -o lstart=`. */
export async function startTimeOf(pid: number, deps: Pick<HaltDeps, "platform" | "capture" | "readPidStart">): Promise<string | undefined> {
  if (deps.platform === "linux") return deps.readPidStart?.(pid);
  const r = await deps.capture("ps", ["-o", "lstart=", "-p", String(pid)]);
  const text = r.stdout.trim().replace(/\s+/g, " ");
  return r.code === 0 && text !== "" ? text : undefined;
}

// ---- the kill path ------------------------------------------------------------------------------------------------------------------------

/** The process group id of a process, or undefined when it is gone. Read with `ps`, never from a file a caller could write. */
async function pgidOf(pid: number, deps: HaltDeps): Promise<number | undefined> {
  const r = await deps.capture("ps", ["-o", "pgid=", "-p", String(pid)]);
  const n = Number(r.stdout.trim());
  return r.code === 0 && Number.isSafeInteger(n) && n > 1 ? n : undefined;
}

/** The pids in a process group, by a scan of the process table; undefined when the scan could not be made. */
async function groupPids(pgid: number, deps: HaltDeps): Promise<number[] | undefined> {
  const r = await deps.capture("ps", ["-A", "-o", "pid=,pgid="]);
  if (r.code !== 0) return undefined;
  const pids: number[] = [];
  for (const line of r.stdout.split("\n")) {
    const [pid, group] = line.trim().split(/\s+/).map(Number);
    if (group === pgid && pid !== undefined && Number.isSafeInteger(pid)) pids.push(pid);
  }
  return pids;
}

/** True when one of the process's cgroup lines names a cgroup whose last component is exactly the unit. */
function inUnit(cgroupText: string | undefined, unit: string): boolean {
  if (cgroupText === undefined) return false;
  return cgroupText.split("\n").some((line) => {
    const path = line.split(":").slice(2).join(":").trim();
    return path.split("/").pop() === unit;
  });
}

type ScopeState = { kind: "gone" } | { kind: "unavailable" } | { kind: "present"; procsFile: string };

async function scopeState(unit: string, deps: HaltDeps): Promise<ScopeState> {
  const r = await deps.capture("systemctl", ["--user", "show", "--property=LoadState,ControlGroup", "--", unit]);
  if (r.code === null) return { kind: "unavailable" };
  const props = new Map(r.stdout.split("\n").map((l) => [l.slice(0, Math.max(0, l.indexOf("="))), l.slice(l.indexOf("=") + 1)] as const));
  if (r.code !== 0) return { kind: "unavailable" };
  if (props.get("LoadState") === "not-found") return { kind: "gone" };
  const cg = props.get("ControlGroup") ?? "";
  // The control group is a path below the cgroup root; "" means the scope has no processes left.
  if (cg === "") return { kind: "gone" };
  if (!cg.startsWith("/") || cg.split("/").includes("..")) return { kind: "unavailable" };
  return { kind: "present", procsFile: deps.cgroupProcsFile(cg) };
}

function countProcs(text: string | undefined): number {
  if (text === undefined) return -1;
  return text.split("\n").filter((l) => /^\d+$/.test(l.trim())).length;
}

/**
 * Kills everything in a unit's scope and counts what is left. SIGKILL is sent again while the scope still has processes, so one that forked after the
 * first signal is caught. Undefined when systemd cannot be asked (the caller falls back to the group).
 */
async function killScope(unit: string, deps: HaltDeps): Promise<KillOutcome | undefined> {
  const before = await scopeState(unit, deps);
  if (before.kind === "gone") return { method: "scope", survivors: 0 };
  if (before.kind !== "present") return undefined;
  const killed = await deps.capture("systemctl", ["--user", "kill", "--signal=SIGKILL", "--", unit]);
  if (killed.code === null) return undefined;
  const deadline = deps.now().getTime() + deps.scopeEmptyWaitMs;
  let left = countProcs(deps.readText(before.procsFile));
  for (let polls = 1; left !== 0 && deps.now().getTime() < deadline; polls++) {
    await deps.sleep(50);
    if (left > 0 && polls % SCOPE_RE_KILL_EVERY === 0) await deps.capture("systemctl", ["--user", "kill", "--signal=SIGKILL", "--", unit]);
    left = countProcs(deps.readText(before.procsFile));
  }
  // A scope whose cgroup directory has gone is empty: the file is unreadable because there is nothing left to read.
  if (left === -1 && (await scopeState(unit, deps)).kind === "gone") left = 0;
  return { method: "scope", survivors: left === -1 ? 1 : left };
}

/**
 * Whether the host's process group may be signalled, with a reason when it may not. The host is its own group leader, so its group id is its pid:
 *  - never this runner's own pid or group;
 *  - a leader that is alive must really be a group leader (`pgid === pid`), and with a unit on Linux must be inside that unit;
 *  - a leader that has exited leaves a group that is still the host's while it has members, which (with a unit) must all be inside that unit.
 * `signal: false` with no refusal means the group is empty: nothing to signal.
 */
async function groupVerdict(pid: number, unit: string | undefined, startTime: string | undefined, deps: HaltDeps): Promise<{ signal: boolean; refusal?: string }> {
  if (pid === deps.ownPid || (await pgidOf(deps.ownPid, deps)) === pid) return { signal: false, refusal: "the recorded pid is this runner's own process group" };
  const leaderPgid = await pgidOf(pid, deps);
  if (leaderPgid !== undefined) {
    // The handle names when its host started: a live process at that pid that started at another time (or whose start cannot be read) is a reused pid.
    if (startTime !== undefined && (await startTimeOf(pid, deps)) !== startTime) return { signal: false, refusal: "the recorded pid belongs to a process that started at a different time (a reused pid), so it was not signalled" };
    if (leaderPgid !== pid) return { signal: false, refusal: "the recorded pid is not the leader of its own process group, so it was not signalled" };
    if (unit !== undefined && !inUnit(deps.readPidCgroup(pid), unit)) return { signal: false, refusal: "the recorded pid is not inside the engine host's scope (a stale pid?), so its group was not signalled" };
    return { signal: true };
  }
  // The leader is gone, or `ps` could not answer: look at the group itself.
  const members = await groupPids(pid, deps);
  if (members === undefined) return { signal: false, refusal: "the process table could not be scanned" };
  if (members.length === 0) return { signal: false };
  if (unit !== undefined && !members.every((m) => inUnit(deps.readPidCgroup(m), unit))) return { signal: false, refusal: "members of the recorded group are not inside the engine host's scope, so it was not signalled" };
  return { signal: true };
}

/**
 * Ends the host and everything it started that can be found. Returns the method used and the survivors counted afterwards (a count that could not be made is
 * reported as 1, one survivor unproven, so a halt is never reported cleaner than it was checked). Throws EngineStateError for a handle that is not a plain
 * host handle; anything that merely does not match the machine is refused and listed in `refused`.
 */
export async function killEngineHost(handle: EngineHostHandle, deps: HaltDeps): Promise<KillOutcome> {
  if (!Number.isSafeInteger(handle.pid) || handle.pid <= 1) throw new EngineStateError("refusing to signal that pid");
  if (handle.unit !== undefined && !UNIT.test(handle.unit)) throw new EngineStateError("refusing that scope name");
  const refused: string[] = [];
  const done = (outcome: KillOutcome): KillOutcome => (refused.length === 0 ? outcome : { ...outcome, refused });

  let unit = deps.platform === "linux" ? handle.unit : undefined;
  if (unit !== undefined && inUnit(deps.readPidCgroup(deps.ownPid), unit)) {
    refused.push("the recorded unit is this runner's own scope, so it was not killed");
    unit = undefined;
  }

  // 1. The host's own process group: TERM, then KILL after the grace.
  const verdict = await groupVerdict(handle.pid, unit, handle.start_time, deps);
  if (verdict.refusal !== undefined) refused.push(verdict.refusal);
  if (verdict.signal) await deps.terminateGroup(handle.pid, deps.termGraceMs);

  // 2. On Linux, the scope: SIGKILL everything in it, then read the cgroup until it is empty. This is a checked fact about the whole tree.
  if (unit !== undefined) {
    const scope = await killScope(unit, deps);
    if (scope !== undefined) return done(scope);
  }

  // 3. No scope to check: the group only, counted by a scan. A group that was refused was not killed and cannot be vouched for.
  if (verdict.refusal !== undefined) return done({ method: "none", survivors: 1 });
  const members = await groupPids(handle.pid, deps);
  return done({ method: "group_only", survivors: members === undefined ? 1 : members.length });
}

// ---- the three entry points -------------------------------------------------------------------------------------------------------------

/** What the caller knows beyond the handle. */
export interface HaltOptions {
  /** Mark the file as a person's stop on this machine (a cloud control cannot clear it). */
  localStop?: boolean;
  /** The repo's GitHub id, when known: with no handle on Linux the conventional unit `fx-engine-host-<id>.scope` is looked up, killed and counted. */
  repoGhId?: number | string;
  /** True only when the caller knows no host was ever started for this repo; only then is "no handle" a clean `group_only` with 0 survivors. */
  knownNoHost?: boolean;
  /** Why the handle is missing when it could not be read (a malformed `engine-host.json`): reported, and the outcome is `none`. */
  handleProblem?: string;
}

async function killWithoutHandle(deps: HaltDeps, opts: HaltOptions): Promise<KillOutcome> {
  const reason = opts.handleProblem;
  if (deps.platform === "linux" && opts.repoGhId !== undefined) {
    const unit = conventionalUnit(opts.repoGhId);
    if (unit !== undefined && !inUnit(deps.readPidCgroup(deps.ownPid), unit)) {
      const scope = await killScope(unit, deps);
      if (scope !== undefined) return reason === undefined ? scope : { ...scope, refused: [reason] };
    }
  }
  if (opts.knownNoHost === true && reason === undefined) return { method: "group_only", survivors: 0 };
  return { method: "none", survivors: 1, refused: [reason ?? "no engine host is recorded, so nothing could be checked"] };
}

/**
 * A halt: the file first, then the kill. Returns the `halt_applied` payload for the caller to send. The file is written before anything is read or validated, and
 * a failure to write it does not stop the kill: the kill runs and then HaltFileWriteError carries its result. A failure in the kill leaves the file written,
 * which is the safe half: the engine's hooks keep refusing.
 */
export async function applyHalt(stateDir: string, handle: EngineHostHandle | undefined, haltEpoch: number, deps: HaltDeps, opts: HaltOptions = {}): Promise<HaltApplied> {
  let writeFailure: string | undefined;
  try {
    const file: EngineHaltFile = { halted: true, halt_epoch: haltEpoch, at: deps.now().toISOString() };
    writeHaltFile(stateDir, opts.localStop === true ? { ...file, local_stop: true } : file, deps.uid);
  } catch (error) {
    // fx-swallow-ok: the failure is not lost: its message is carried to the caller in HaltFileWriteError, and the kill below still runs
    writeFailure = error instanceof Error ? error.message : "unknown error";
  }
  let outcome: KillOutcome;
  if (handle === undefined) outcome = await killWithoutHandle(deps, opts);
  else {
    try {
      outcome = await killEngineHost(handle, deps);
    } catch (error) {
      // fx-swallow-ok: fail closed: a kill that threw is reported as survivors:1 with the message in `refused`, so the caller sees it was not confirmed
      outcome = { method: "none", survivors: 1, refused: [error instanceof Error ? error.message : "the kill path failed"] };
    }
  }
  const applied: HaltApplied = { halt_epoch: haltEpoch, ...outcome };
  if (writeFailure !== undefined) throw new HaltFileWriteError(applied, writeFailure);
  return applied;
}

/** A clear: the file is rewritten to halted:false at the SAME epoch. The host is not restarted. */
export function applyClear(stateDir: string, haltEpoch: number, deps: Pick<HaltDeps, "now" | "uid">): void {
  writeHaltFile(stateDir, { halted: false, halt_epoch: haltEpoch, at: deps.now().toISOString() }, deps.uid);
}

export interface ControlView {
  halt_epoch: number;
  halted: boolean;
}

/**
 * What one pull's control for a repo asks of the runner. `local` is the halt file as read (undefined when there is none: epoch 0, not halted).
 *
 * Without a local stop: a HIGHER epoch than the local file is a halt, whether or not it has been cleared since (a halt that was cleared before this pull
 * still happened, and the host is killed). The same epoch with `halted:false` while the local file says halted is a clear. Anything else changes nothing.
 *
 * With a local stop (a person ran `engine-host stop` here), the stop stands against every control but one: an OBSERVED `halted:true` at a higher epoch, a
 * new halt a person raised after the stop, hands control to the cloud ("halt"). A control that is `halted:false` at any epoch, a higher one included, can
 * never clear it: at a higher epoch the stop is kept and re-written at that epoch, and the host is killed again ("stay_stopped"). The local file's epoch can
 * lag behind the cloud's (the machine was offline), so a higher epoch alone proves nothing about what a person did after the stop.
 */
export function haltAction(local: EngineHaltFile | undefined, control: ControlView): "halt" | "clear" | "stay_stopped" | "none" {
  const localEpoch = local?.halt_epoch ?? 0;
  if (local?.local_stop === true) {
    if (control.halt_epoch <= localEpoch) return "none";
    return control.halted ? "halt" : "stay_stopped";
  }
  if (control.halt_epoch > localEpoch) return "halt";
  if (control.halt_epoch === localEpoch && !control.halted && local?.halted === true) return "clear";
  if (control.halt_epoch === localEpoch && control.halted && local?.halted !== true && localEpoch > 0) return "halt";
  return "none";
}

/**
 * Handles one control from a pull, before anything else of that pull is written. Returns the `halt_applied` payload when a halt was applied (the caller sends it),
 * or undefined. A halt that was already cleared in the cloud is killed first and then cleared locally, so the file ends at halted:false. A halt file that cannot be
 * read is "stopped by a person at an unknown epoch": the kill runs and the file is overwritten as a local stop at the control's epoch (only `engine-host resume` lifts it).
 */
export async function handleControl(stateDir: string, handle: EngineHostHandle | undefined, control: ControlView, deps: HaltDeps, opts: HaltOptions = {}): Promise<HaltApplied | undefined> {
  let local: EngineHaltFile | undefined;
  let unreadable = false;
  try {
    local = readHaltFile(stateDir, deps.uid);
  } catch {
    // fx-swallow-ok: an unreadable halt file is treated as halted at an unknown epoch: fail closed, and the kill below runs
    unreadable = true;
  }
  // An unreadable file may have been a person's local stop, so it is rewritten as one: a corrupted stop is never lifted without `engine-host resume`.
  if (unreadable) return applyHalt(stateDir, handle, control.halt_epoch, deps, { ...opts, localStop: true });
  const action = haltAction(local, control);
  if (action === "clear") {
    applyClear(stateDir, control.halt_epoch, deps);
    return undefined;
  }
  if (action === "none") return undefined;
  if (action === "stay_stopped") return applyHalt(stateDir, handle, control.halt_epoch, deps, { ...opts, localStop: true });
  const applied = await applyHalt(stateDir, handle, control.halt_epoch, deps, opts);
  if (!control.halted) applyClear(stateDir, control.halt_epoch, deps);
  return applied;
}

/**
 * `fx-runner engine-host stop`: the same kill path, with no cloud call. The epoch is the local file's, or 0 when there is none or it cannot be read. The file is
 * written first, `{halted:true, local_stop:true}`, before the host file or the old halt file is read; it is a stop a cloud control cannot clear.
 */
export async function stopEngineHostLocally(stateDir: string, deps: HaltDeps, opts: HaltOptions = {}): Promise<{ applied: HaltApplied; hostFound: boolean; noHostRecorded: boolean; haltFileError?: string }> {
  let epoch = 0;
  try {
    epoch = readHaltFile(stateDir, deps.uid)?.halt_epoch ?? 0;
  } catch {
    // fx-swallow-ok: an unreadable halt file is overwritten below, halted at an unknown epoch (0)
  }
  let handle: EngineHostHandle | undefined;
  let handleProblem: string | undefined;
  try {
    handle = readHostHandle(stateDir, deps.uid);
  } catch (error) {
    // fx-swallow-ok: the problem is reported, not dropped: it becomes `handleProblem`, which makes the kill outcome `none` with the reason in `refused`
    handleProblem = error instanceof EngineStateError ? error.message : "engine-host.json could not be read";
  }
  const hostFound = handle !== undefined;
  const noHostRecorded = handle === undefined && handleProblem === undefined;
  const merged: HaltOptions = { ...opts, localStop: true, ...(handleProblem === undefined ? {} : { handleProblem }) };
  try {
    const applied = await applyHalt(stateDir, handle, epoch, deps, merged);
    return { applied, hostFound, noHostRecorded };
  } catch (error) {
    if (error instanceof HaltFileWriteError) return { applied: error.applied, hostFound, noHostRecorded, haltFileError: error.reason };
    throw error;
  }
}

/** `fx-runner engine-host resume`: a person lifts a local stop. The file goes to halted:false at the same epoch; nothing is started. A cloud halt (no `local_stop`) is not lifted here. */
export function resumeEngineHostLocally(stateDir: string, deps: Pick<HaltDeps, "now" | "uid">): "resumed" | "not_stopped" | "cloud_halt" {
  const file = readHaltFile(stateDir, deps.uid);
  if (file === undefined || !file.halted) return "not_stopped";
  if (file.local_stop !== true) return "cloud_halt";
  writeHaltFile(stateDir, { halted: false, halt_epoch: file.halt_epoch, at: deps.now().toISOString() }, deps.uid);
  return "resumed";
}
