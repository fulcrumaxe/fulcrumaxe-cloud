/**
 * `fx-runner engine-host start | stop | status | resume`.
 *  - `start` (EB-12a) runs the supervised headless Team Lead in the foreground until it ends (Ctrl-C or SIGTERM ends it cleanly).
 *  - `stop` ends the engine host on this machine now through the same kill path a cloud halt uses, with no cloud call. It writes `engine-halt.json` first
 *    (so the engine's hooks refuse while it runs), kills the host's process group and, on Linux, its systemd user scope, and prints what it could prove.
 *  - `status` prints what is recorded, from the two local files.
 * Only fixed sentences reach the terminal: never the stream, a path, an argument or a credential.
 */
import { CliError } from "../cliError.js";
import type { CommandContext } from "../context.js";
import { readHaltFile, readHostHandle, resumeEngineHostLocally, stopEngineHostLocally, type EngineHostHandle, type HaltDeps } from "../engineBridge/halt.js";
import { engineStateDir, EngineStateError } from "../engineBridge/stateFiles.js";
import { acquireHostLock, openHostLog, readBridgeState } from "../engineHost/hostFiles.js";
import { createSupervisor, type HostChild, type HostEvent, type HostSpawnSpec, type RefusalReason, type StopReason } from "../engineHost/supervisor.js";

/** What `engine-host start` needs from the machine. Only `bin/fx-runner.mjs` supplies it. */
export interface EngineHostRuntime {
  platform: NodeJS.Platform;
  /**
   * The installed claude's absolute path, found the way the job runner finds it (`resolveClaudePath` over the runner's own clean search path, never the shell's
   * PATH); throws when there is none. The runner stores no path at setup: `run` resolves it once at its own start.
   */
  locateClaude: () => string;
  /** The same version and required-flags check every job gets (`storedBinarySource`'s `inspectBinary`): true only when the build is supported and lists every flag. */
  inspectClaude: (binaryPath: string, stateDir: string) => Promise<boolean>;
  /** This process's pid, for the lifetime lock. */
  ownPid: number;
  /** When a process started (its stat file's start time on Linux), or undefined when it is gone. */
  processStart: (pid: number) => string | undefined;
  /** The text of a process's cgroup file, or undefined when it cannot be read. */
  readCgroup: (pid: number) => string | undefined;
  /** Calls `fn` once when this process is exiting, whatever the path (a last, synchronous, best-effort cleanup). */
  onProcessExit: (fn: () => void) => void;
  launch: (spec: HostSpawnSpec) => HostChild;
  /** A fixed allowlist of variables, built by the caller. No credential is among them. */
  env: Record<string, string>;
  isAlive: (pid: number) => boolean;
  scopeAvailable: () => Promise<boolean>;
  killHost: (handle: EngineHostHandle) => Promise<unknown>;
  killScope: (unit: string) => Promise<void>;
  now: () => number;
  after: (ms: number, fn: () => void) => () => void;
  /** Resolves when the person or the machine asks the host to end (Ctrl-C, SIGTERM, or the terminal closing: SIGHUP). */
  shutdown: () => Promise<"stopped_by_person" | "machine_shutdown">;
  /** Where events go (EB-3a/EB-8b wire the real emitter); left out, started and stopped are printed. */
  emit?: ((event: HostEvent) => void) | undefined;
}

export interface EngineHostOptions {
  /** `AUTONOMOUS_TEAM_STATE_DIR`, looked up by name by the caller. */
  engineStateDirOverride?: string | undefined;
  home: string | undefined;
  deps: HaltDeps | undefined;
  runtime?: EngineHostRuntime | undefined;
}

export const REFUSALS: Record<RefusalReason, string> = {
  bridge_disabled: "The bridge is not enabled for this repo, so the engine host will not start.",
  operate_off: "Operate is off for this repo in the workspace, so the engine host will not start.",
  halted: "The engine is halted (a halt file says so), so the engine host will not start. Clear the halt first.",
  platform_kill_unverified: "This machine cannot run the host in a systemd user scope, so a kill could not be proven (platform_kill_unverified). The engine host will not start.",
  state_unreadable: "The engine bridge's local files could not be read safely, so the engine host will not start.",
  running_as_root: "The engine host does not run as root.",
  already_running: "An engine host is already running on this machine.",
};
const STOPS: Record<StopReason, string> = {
  stopped_by_person: "Engine host stopped.",
  machine_shutdown: "Engine host stopped for machine shutdown.",
  halted: "Engine host stopped: the engine is halted.",
  operate_off: "Engine host stopped: operate was turned off.",
  crash_loop: "Engine host stopped after repeated crashes (crash_loop). It stays stopped until you start it again.",
  log_failed: "Engine host stopped: its log could not be written (log_failed).",
  host_failed: "Engine host stopped: it could not be started or recorded safely (host_failed).",
};
const NO_CLAUDE = "no runnable claude CLI was found; run fx-runner doctor";
const SURVIVORS = (n: number): string => `Engine host stop ended, but ${n} process(es) of its tree are still alive. Run fx-runner engine-host stop.`;

export async function engineHostCommand(positionals: readonly string[], ctx: CommandContext, options: EngineHostOptions): Promise<number> {
  const sub = positionals[0];
  if ((sub !== "stop" && sub !== "resume" && sub !== "start" && sub !== "status") || positionals.length !== 1) throw new CliError("usage: fx-runner engine-host start | stop | status | resume", 2);
  if (options.deps === undefined) throw new CliError("engine-host is only available from the fx-runner program");
  if (options.home === undefined) throw new CliError("cannot find the home directory");
  let dir: string;
  try {
    dir = engineStateDir({ AUTONOMOUS_TEAM_STATE_DIR: options.engineStateDirOverride }, options.home);
    if (sub === "status") return engineHostStatus(dir, ctx, options.deps.uid);
    if (sub === "start") return await startHost(dir, ctx, options.deps, options.runtime);
    if (sub === "resume") {
      const result = resumeEngineHostLocally(dir, options.deps);
      ctx.out(
        result === "resumed"
          ? "The local stop is lifted. Nothing was started; start the engine host again yourself."
          : result === "cloud_halt"
            ? "The halt was set from the workspace, so only the workspace can clear it."
            : "The engine is not stopped on this machine.",
      );
      return result === "cloud_halt" ? 1 : 0;
    }
    const { applied, noHostRecorded, haltFileError } = await stopEngineHostLocally(dir, options.deps);
    if (haltFileError !== undefined) ctx.err(`The halt file could not be written (${haltFileError}). The kill path ran anyway; the engine's hooks may not refuse until that is fixed.`);
    for (const line of noHostRecorded ? [] : (applied.refused ?? [])) ctx.err(`Not checked: ${line}.`);
    if (noHostRecorded && applied.method === "none") {
      ctx.out("No engine host is recorded on this machine, so no process was checked. The halt file is written, so the engine's hooks refuse until it is cleared.");
    } else if (applied.method === "none") ctx.out("Engine host stop was attempted, but nothing could be checked, so its tree is counted as still running.");
    else if (applied.survivors === 0 && applied.method === "scope") ctx.out("Engine host stopped. No process of its tree is left (checked in its systemd scope).");
    else if (applied.survivors === 0) ctx.out("Engine host stopped. Its process group is empty; detached processes not verified on this machine.");
    else ctx.out(`Engine host stopped, but ${applied.survivors} process(es) of its tree are still alive (${applied.method === "scope" ? "counted in its systemd scope" : "counted in its process group"}).`);
    if (haltFileError !== undefined) return 1;
    // A machine with no host recorded has nothing to count against: the halt file is the brake, and the message above says nothing was checked.
    if (noHostRecorded && applied.method === "none") return 0;
    return applied.survivors === 0 ? 0 : 1;
  } catch (error) {
    if (error instanceof EngineStateError) throw new CliError(error.message);
    throw error;
  }
}

function engineHostStatus(dir: string, ctx: CommandContext, uid: number): number {
  const halt = readHaltFile(dir, uid);
  const handle = readHostHandle(dir, uid);
  ctx.out(handle === undefined ? "Engine host: no host is recorded on this machine." : `Engine host: recorded (pid ${handle.pid}${handle.unit === undefined ? "" : `, scope ${handle.unit}`}).`);
  ctx.out(halt?.halted === true ? `Halt: halted${halt.local_stop === true ? " by a local stop" : ""} (epoch ${halt.halt_epoch}).` : "Halt: not halted.");
  return 0;
}

/** Runs the supervisor in the foreground until it ends. */
async function startHost(dir: string, ctx: CommandContext, deps: HaltDeps, rt: EngineHostRuntime | undefined): Promise<number> {
  if (rt === undefined) throw new CliError("engine-host start is only available from the fx-runner program");
  let claudePath: string;
  try {
    claudePath = rt.locateClaude();
  } catch {
    // fx-swallow-ok: reported as one fixed sentence; the search path is not echoed
    throw new CliError(NO_CLAUDE);
  }
  if (!(await rt.inspectClaude(claudePath, ctx.stateDir))) throw new CliError(NO_CLAUDE);
  const log = openHostLog(dir, deps.uid);
  const supervisor = createSupervisor({
    stateDir: dir,
    uid: deps.uid,
    platform: rt.platform,
    claudePath,
    readBridgeState: () => readBridgeState(dir, deps.uid),
    launch: rt.launch,
    env: rt.env,
    log,
    emit:
      rt.emit ??
      ((e) => {
        if (e.kind === "host_started") ctx.out("Engine host started.");
        else if (e.kind === "host_stopped") ctx.out(e.survivors !== undefined && e.survivors > 0 ? SURVIVORS(e.survivors) : STOPS[e.reason]);
      }),
    now: rt.now,
    after: rt.after,
    isAlive: rt.isAlive,
    // The pid must be alive and its cgroup must end in the recorded scope: a pid reused by an unrelated process is not our host.
    isOurHost: (handle) => handle.unit !== undefined && (rt.readCgroup(handle.pid) ?? "").split("\n").some((line) => line.endsWith(`/${handle.unit}`)),
    startTimeOf: rt.processStart,
    acquireLock: () => acquireHostLock(dir, deps.uid, { ownPid: rt.ownPid, isAlive: rt.isAlive, startOf: rt.processStart }),
    scopeAvailable: rt.scopeAvailable,
    killHost: rt.killHost,
    killScope: rt.killScope,
  });
  // Whatever way this process ends, the handle file and the lock go: a dead supervisor must not leave a handle naming a pid that could be reused.
  // The hook is registered only once this supervisor owns the files (a refused start must not delete another host's handle); a start that throws cleans what it wrote.
  let started: Awaited<ReturnType<typeof supervisor.start>>;
  try {
    started = await supervisor.start();
  } catch (error) {
    supervisor.cleanup();
    throw error;
  }
  if (started.ok) rt.onProcessExit(() => supervisor.cleanup());
  if (!started.ok) {
    log.close();
    ctx.out(REFUSALS[started.reason]);
    return 1;
  }
  void rt.shutdown().then((reason) => supervisor.stop(reason));
  const reason = await supervisor.stopped;
  return (reason === "stopped_by_person" || reason === "machine_shutdown") && supervisor.survivors() === 0 ? 0 : 1;
}
