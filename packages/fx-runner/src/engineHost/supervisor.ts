/**
 * EB-12a: the supervisor of the engine's headless Team Lead. One long-lived installed `claude` runs as `claude -p --input-format stream-json
 * --output-format stream-json --verbose`, started in its own process group inside a `systemd-run --user --scope` unit, with its working directory at the
 * repo's main checkout. The supervisor owns these promises:
 *  - it refuses to start unless the bridge is enabled, the cloud's operate switch is on, no halt file says halted, and a scope can be used to prove a kill;
 *  - the host's stdin stays open for the whole life of the session (closing it ends the session and stops the subagents' shells), and is closed only by `stop`;
 *  - a crash restarts it with `--resume <session_id>` after 1, 2, then 5 minutes; a sixth crash within an hour stops it for good (`crash_loop`);
 *  - the stream (stdout and stderr) goes only to a local 0600 log. It is never parsed beyond the session id of an `init` line and, since EB-12b, the outcome,
 *    model and four token totals of a `result` line (what ends a turn); it is never sent anywhere and never written into an event, and the text sent to the host is never logged. A log write that fails stops the host cleanly (`log_failed`);
 *  - a halt always stops the host: the halt file and the bridge state are read again right before the spawn, right after the handle is written and on every
 *    heartbeat, and a host that is halted (or whose operate switch went off, or whose files can no longer be read) is ended through the kill path with
 *    `host_stopped`, whether or not a kill path ran in between. This closes the window where a halt lands after the first check and before there is a handle
 *    or a scope for the kill path to find;
 *  - one supervisor per machine: a lifetime lock is held for the supervisor's whole life, to the last exit path, so a second `start` is refused (`already_running`) even while
 *    the first has no host during a back-off. A handle left by a dead supervisor blocks a start only when its pid is alive and its cgroup is its scope.
 * The host gets no flag that skips permissions; `assertHostArgv` refuses one. Nothing here names a process or a child-process module: bin/fx-runner.mjs hands in
 * the real start, the clock and the kill path.
 *
 * Residual risk, stated plainly: the host inherits `DBUS_SESSION_BUS_ADDRESS` and `XDG_RUNTIME_DIR` (the decide socket needs the second). A tool call can
 * therefore run `systemd-run --user ...` and start a process in a scope of its own, which neither the group kill nor this host's scope kill reaches. Dropping
 * the variables would only be friction, since the agent can rebuild them, so this is a known limit of the scope-based proof and not a boundary. The kill
 * path reports what it could count (`survivors`), and `host_stopped` carries that number after a forced stop.
 */
import { MODEL_ID_PATTERN, USAGE_TOKENS_MAX } from "@fulcrumaxe/runner-protocol";
import { EngineStateError, removeStateFile, writeJsonAtomic } from "../engineBridge/stateFiles.js";
import { ENGINE_HOST_FILE, readHaltFile, readHostHandle, type EngineHostHandle } from "../engineBridge/halt.js";
import type { BridgeState, HostLock, HostLog } from "./hostFiles.js";
import type { SessionStore } from "./session.js";

export type RefusalReason = "bridge_disabled" | "operate_off" | "halted" | "platform_kill_unverified" | "state_unreadable" | "running_as_root" | "already_running";
export type StopReason = "stopped_by_person" | "halted" | "crash_loop" | "operate_off" | "machine_shutdown" | "log_failed" | "host_failed";
/** `survivors` is present when the kill path ran: processes of the host's tree it found still alive afterwards. */
/** `compaction_detected` (EB-12c): the stream said the host's context was compacted; the event's own `ts` is the time. */
export type HostEvent = { kind: "host_started" } | { kind: "host_stopped"; reason: StopReason; survivors?: number } | { kind: "host_heartbeat" } | { kind: "compaction_detected" };

export const BACKOFF_MS: readonly number[] = [60_000, 120_000, 300_000];
export const CRASH_LIMIT = 6;
export const CRASH_WINDOW_MS = 3_600_000;
export const HEARTBEAT_MS = 60_000;
/** The systemd scope (EB-12a's pattern) of the engine host of one repository; an engine session on the standard tier is named the same way. */
export const engineHostUnit = (repoGhId: number | string): string => `fx-engine-host-${String(repoGhId)}`;
/** How often `engine-host.json` gets a fresh `heartbeat_at`. The engine's reader trusts a host for 60 s, so this stays well inside it. */
export const FILE_BEAT_MS = 15_000;
/** After stdin is closed for a clean stop, how long the host gets to leave before the kill path ends it. */
export const STOP_GRACE_MS = 10_000;
/**
 * A resume counts as failed only when the host process exits within this long of its launch, before it printed an `init` line and before any message was sent
 * to it. Whether the installed claude prints `init` before its first input in stream-json input mode is not settled by anything in this repo (every captured
 * stream here comes from a run with a prompt argument, which gets its `init` together with its first output), so "no init yet" alone cannot mean "the resume
 * failed": a host that was resumed fine and is simply waiting for its first message prints nothing, and a crash minutes later must not wipe a good session.
 * A resume of a session that is gone or unreadable ends at once, so 30 seconds is far beyond it and far short of a healthy host's first message.
 */
export const RESUME_FAIL_WITHIN_MS = 30_000;
const SESSION_LINE_MAX = 1 << 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INIT_PREFIX = '{"type":"system","subtype":"init"';
const RESULT_PREFIX = '{"type":"result"';
const SYSTEM_PREFIX = '{"type":"system"';
const COMPACT_MARK = '"compact_boundary"';

/** The host's argument vector after the program. Fixed: no model, tool or permission flag is added, so the repo's and the user's own settings apply. */
export const HOST_ARGS: readonly string[] = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];
const FORBIDDEN_ARG = /permission|dangerous|bypass|allowedtools|allowed-tools|settings|add-dir|mcp-config/i;

/** Refuses an argument vector that adds anything beyond the fixed one and `--resume <uuid>`. */
export function assertHostArgv(args: readonly string[]): void {
  const base = HOST_ARGS.length;
  const fixed = args.slice(0, base).every((a, i) => a === HOST_ARGS[i]);
  const tail = args.slice(base);
  const resumeOk = tail.length === 0 || (tail.length === 2 && tail[0] === "--resume" && UUID.test(tail[1] ?? ""));
  if (!fixed || !resumeOk || args.some((a) => FORBIDDEN_ARG.test(a))) throw new EngineStateError("refusing a host argument vector with extra flags");
}

export interface HostSpawnSpec {
  file: string;
  args: string[];
  cwd: string;
  /** A fixed allowlist of variables, built by the caller; never a copy of the environment, never a credential. */
  env: Record<string, string>;
}

/** What the end of one turn tells the ticker (EB-12b), read from the stream's `result` line and nothing else of it. `usage` is left out unless all four totals are safe ints. */
export interface TurnResult {
  ok: boolean;
  model?: string;
  usage?: { input: number; output: number; cache_read: number; cache_write: number };
}

/** The part of the started host the supervisor uses (a structural type: no child-process import here). */
export interface HostChild {
  /** The pid of the host, the leader of its own process group. Undefined when it could not start. */
  pid: number | undefined;
  /** Writes text to the host's standard input. Never closes it. */
  write(text: string): void;
  closeStdin(): void;
  onStdout(cb: (text: string) => void): void;
  onStderr(cb: (text: string) => void): void;
  /** Called once, after the host has exited AND its output streams have ended (a `close`, not an `exit`): no output follows it, so the redaction tail is flushed there. */
  onExit(cb: () => void): void;
}

export interface SupervisorDeps {
  stateDir: string;
  uid: number;
  platform: NodeJS.Platform;
  /** The path of the installed claude, absolute, from the runner's own resolution (and version-checked by the caller). */
  claudePath: string;
  readBridgeState: () => BridgeState | undefined;
  launch: (spec: HostSpawnSpec) => HostChild;
  env: Record<string, string>;
  /**
   * ON-13b1: the one credential the host may carry, read at each launch and never kept here (the guest supervisor's `token_put` buffer). Left out, the host has none and reads its own login.
   * It is merged over `env` for the child only; it is never logged and never part of a handle or an event.
   */
  secretEnv?: (() => Record<string, string> | undefined) | undefined;
  /**
   * ON-18: further values to keep out of the host log, read at every write because they change while the host runs (the repository token, put after the launch and replaced about hourly). They are matched like
   * `secretEnv`'s values and never reach the child's environment.
   */
  redactValues?: (() => string[]) | undefined;
  /**
   * ON-13b1: how the host is started. Left out (a machine with systemd), `systemd-run --user --scope` makes the scope the kill path proves against. Inside a guest or an engine-session unit there is no
   * systemd to ask and the unit is already the scope, so the caller runs the program directly: the kill path is then the process group.
   */
  wrapLaunch?: ((program: string, args: string[], unit: string) => { file: string; args: string[] }) | undefined;
  log: HostLog;
  emit: (event: HostEvent) => void;
  now: () => number;
  /** Calls `fn` after `ms`; returns a function that cancels it. */
  after: (ms: number, fn: () => void) => () => void;
  /** Whether a pid is a live process (for "already running"). */
  isAlive: (pid: number) => boolean;
  /** When a process started (field 22 of its stat file on Linux), or undefined when it is gone or unreadable. */
  startTimeOf: (pid: number) => string | undefined;
  /** Whether a live pid is the host the handle describes: its cgroup names the handle's scope. A reused pid is not. False when that cannot be shown. */
  isOurHost: (handle: EngineHostHandle) => boolean;
  /** Takes the supervisor's lifetime lock; undefined when another supervisor holds it. The supervisor releases it on every exit path. */
  acquireLock: () => HostLock | undefined;
  /** Whether `systemd-run --user --scope` works on this machine. */
  scopeAvailable: () => Promise<boolean>;
  /** EB-11b's kill path on the recorded handle (process group, then scope). Its result, when it carries `survivors`, is reported. */
  killHost: (handle: EngineHostHandle) => Promise<unknown>;
  /** SIGKILL to what is left in a scope, by unit name only (no pid: a dead host's pid may be reused). */
  killScope: (unit: string) => Promise<void>;
  /** EB-12b: told when a turn ends (a `result` line) and when the running host process exits (a crash restart is a new process). EB-12c: and when the host's context was compacted. */
  observer?: { onTurn(turn: TurnResult): void; onExit(): void; onCompaction?(): void } | undefined;
  /** EB-12c: where the session id lives between processes (and across a reboot). Left out, it lives only as long as this supervisor. */
  sessionStore?: SessionStore | undefined;
  /** EB-12c: this supervisor's own process (pid and start time), written into `engine-host.json` next to the host's pid as `claimer_pid` and `claimer_start`. */
  claimer?: { pid: number; start: string | undefined } | undefined;
}

export interface Supervisor {
  /** Checks every refusal, then starts the host. A refusal starts nothing. */
  start(): Promise<{ ok: true } | { ok: false; reason: RefusalReason }>;
  /** Sends one user message to the host's stdin. False when no host is running. The text is never logged. */
  send(text: string): boolean;
  /** Ends the host cleanly: close stdin, then the kill path after the grace. Idempotent. */
  stop(reason: "stopped_by_person" | "machine_shutdown" | "log_failed" | "halted" | "operate_off"): Promise<void>;
  /** Resolves with the reason once `host_stopped` was emitted. */
  stopped: Promise<StopReason>;
  /** The session id read from the host's last `init` line, once there is one. */
  sessionId(): string | undefined;
  /** The `apiKeySource` of the host's last `init` line (`none` is a login; anything else is a key), or undefined until there is one or when the line had none. */
  keySource(): string | undefined;
  /** How many processes of the host's tree the kill path found still alive (0 when it did not run). */
  survivors(): number;
  /** Log writes that failed; the first one stops the host. */
  logFailures(): number;
  /** Session ids that could not be saved (EB-12c); the host runs on. */
  sessionSaveFailures(): number;
  /** Rewrites the handle's `heartbeat_at` now (the ticker calls it before it claims a command). False when there is no host or the file could not be written (the host is then ended). */
  touch(): boolean;
  /** Removes the handle file and releases the lock and the log, without a kill: the last step of a process that is exiting. Idempotent. */
  cleanup(): void;
}

export function createSupervisor(deps: SupervisorDeps): Supervisor {
  let current: HostChild | undefined;
  let handle: EngineHostHandle | undefined;
  let lock: HostLock | undefined;
  let unit = "";
  let checkout = "";
  let session: string | undefined = deps.sessionStore?.load();
  let sessionSaveFails = 0;
  let keySource: string | undefined;
  /** The process now running was started with `--resume`, has not yet printed its `init` line and has been sent no message. A resume that fails ends the process then, soon after its launch. */
  let resumePending = false;
  let launchedAt = 0;
  let stopping = false;
  let finished = false;
  let crashes: number[] = [];
  let survivorCount = 0;
  let killRan = false;
  let logFails = 0;
  let cancelTimer: (() => void) | undefined;
  let cancelBeat: (() => void) | undefined;
  let cancelFileBeat: (() => void) | undefined;
  const exitWaiters: Array<() => void> = [];
  let resolveStopped!: (r: StopReason) => void;
  const stopped = new Promise<StopReason>((resolve) => (resolveStopped = resolve));

  /** The first refusal that applies, reading the files fresh each time. */
  async function refusal(): Promise<RefusalReason | undefined> {
    if (deps.uid === 0) return "running_as_root";
    if (deps.platform !== "linux" || !(await deps.scopeAvailable())) return "platform_kill_unverified";
    try {
      const state = deps.readBridgeState();
      if (state === undefined || !state.bridge_enabled) return "bridge_disabled";
      if (!state.operate_enabled) return "operate_off";
      if (readHaltFile(deps.stateDir, deps.uid)?.halted === true) return "halted";
      unit = `${engineHostUnit(state.repo_gh_id)}.scope`;
      checkout = state.repo_checkout;
    } catch (error) {
      if (error instanceof EngineStateError) return "state_unreadable";
      throw error;
    }
    return undefined;
  }

  /** The files read again, synchronously, right now: why the host must not run, or undefined. A file that cannot be read safely counts as halted (fail closed). */
  function mustStop(): StopReason | undefined {
    try {
      const state = deps.readBridgeState();
      if (state === undefined || !state.bridge_enabled || !state.operate_enabled) return "operate_off";
      if (readHaltFile(deps.stateDir, deps.uid)?.halted === true) return "halted";
      return undefined;
    } catch (error) {
      if (error instanceof EngineStateError) return "halted";
      throw error;
    }
  }

  /** Removes `engine-host.json` only when this supervisor wrote it: a refused start (another host's handle may be there) never deletes what is not its own. */
  function removeHandle(): void {
    if (handle === undefined) return;
    handle = undefined;
    try {
      removeStateFile(deps.stateDir, ENGINE_HOST_FILE);
    } catch {
      // fx-swallow-ok: a handle file that cannot be removed is judged by the next start (its pid and cgroup must still match before it refuses)
    }
  }

  /** Writes the handle with a fresh `heartbeat_at`. Throws what `writeJsonAtomic` throws. */
  function writeHandle(): void {
    if (handle === undefined) return;
    handle = { ...handle, heartbeat_at: new Date(deps.now()).toISOString() };
    writeJsonAtomic(deps.stateDir, ENGINE_HOST_FILE, handle, deps.uid);
  }

  function fileBeat(): void {
    cancelFileBeat = deps.after(FILE_BEAT_MS, () => {
      if (current === undefined || finished || stopping) return;
      if (api.touch()) fileBeat();
    });
  }

  function release(): void {
    lock?.release();
    lock = undefined;
  }

  function finish(reason: StopReason): void {
    if (finished) return;
    finished = true;
    cancelTimer?.();
    cancelBeat?.();
    cancelFileBeat?.();
    removeHandle();
    deps.log.close();
    release();
    deps.emit(killRan ? { kind: "host_stopped", reason, survivors: survivorCount } : { kind: "host_stopped", reason });
    resolveStopped(reason);
  }

  const reasonFor = (r: RefusalReason): StopReason => (r === "bridge_disabled" || r === "operate_off" ? "operate_off" : "halted");

  function noteKill(result: unknown): void {
    killRan = true;
    const n = (result as { survivors?: unknown } | null | undefined)?.survivors;
    if (typeof n === "number" && Number.isSafeInteger(n) && n > 0) survivorCount = Math.max(survivorCount, n);
  }

  /** Ends the host through the kill path because it must not run: nothing waits for a grace, and the handle is not trusted to be the only record. */
  async function haltStop(reason: StopReason): Promise<void> {
    if (finished || stopping) return;
    stopping = true;
    cancelTimer?.();
    cancelBeat?.();
    cancelFileBeat?.();
    const target = handle ?? (current?.pid === undefined ? undefined : { pid: current.pid, unit });
    try {
      if (target !== undefined) noteKill(await deps.killHost(target));
      if (unit !== "") await deps.killScope(unit);
    } catch {
      // fx-swallow-ok: a kill path that throws must not leave the supervisor half-stopped; it still ends, and the reason stays the fixed one
    }
    finish(reason);
  }

  function beat(): void {
    cancelBeat = deps.after(HEARTBEAT_MS, () => {
      if (current === undefined || finished || stopping) return;
      const why = mustStop();
      if (why !== undefined) {
        void haltStop(why);
        return;
      }
      deps.emit({ kind: "host_heartbeat" });
      beat();
    });
  }

  /**
   * A stream writer for the host log that replaces every exact copy of a secret handed to the launch with `[redacted]`, including a copy split across two chunks (the last `longest - 1` characters of a stream are held back
   * until the next chunk or the end of the host's output). Only values of 8 or more characters are matched (a short one would mangle ordinary text).
   */
  function redactor(secrets: () => readonly string[]): { push: (text: string) => void; flush: () => void } {
    // The list is read at every write, not once: the repository token arrives after the launch and changes while the host runs.
    const current = (): string[] => secrets().filter((v) => v.length >= 8);
    let pending = "";
    const clean = (list: readonly string[], text: string): string => list.reduce((acc, secret) => acc.split(secret).join("[redacted]"), text);
    return {
      push(text) {
        const list = current();
        if (list.length === 0 && pending === "") return logWrite(text);
        const hold = list.length === 0 ? 0 : Math.max(...list.map((v) => v.length)) - 1;
        const all = clean(list, pending + text);
        // never cut inside a replacement: what is held back is the raw tail, cleaned again with the next chunk
        const keep = Math.min(hold, all.length);
        pending = all.slice(all.length - keep);
        const out = all.slice(0, all.length - keep);
        if (out.length > 0) logWrite(out);
      },
      flush() {
        const out = clean(current(), pending);
        pending = "";
        if (out.length > 0) logWrite(out);
      },
    };
  }

  function logWrite(text: string): void {
    let ok = false;
    try {
      ok = deps.log.write(text);
    } catch {
      // fx-swallow-ok: a log that throws is the same as one that failed: counted below, and the host stops
    }
    if (ok) return;
    logFails++;
    if (logFails === 1) void api.stop("log_failed");
  }

  /** One `result` line: only its outcome, model and token totals are read; nothing of its text is kept. */
  function turnEnded(line: string): void {
    let turn: TurnResult = { ok: false };
    try {
      const r = JSON.parse(line) as { subtype?: unknown; is_error?: unknown; usage?: Record<string, unknown>; modelUsage?: Record<string, unknown> };
      turn = { ok: r.subtype === "success" && r.is_error !== true };
      const n = (v: unknown): number | undefined => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= USAGE_TOKENS_MAX ? v : undefined);
      const [input, output, cache_read, cache_write] = [n(r.usage?.input_tokens), n(r.usage?.output_tokens), n(r.usage?.cache_read_input_tokens), n(r.usage?.cache_creation_input_tokens)];
      if (input !== undefined && output !== undefined && cache_read !== undefined && cache_write !== undefined) turn.usage = { input, output, cache_read, cache_write };
      const models = Object.keys(r.modelUsage ?? {});
      if (models.length === 1 && MODEL_ID_PATTERN.test(models[0]!)) turn.model = models[0]!;
    } catch {
      // fx-swallow-ok: a result line that cannot be read still ends the turn, as a failed one with no usage ("not recorded", never zero)
    }
    try {
      deps.observer?.onTurn(turn);
    } catch {
      // fx-swallow-ok: a ticker that throws must not stop the stream from being read or the host from running
    }
  }

  /** The session id of an `init` line, kept and, when it changed, saved. A save that fails is counted and the host runs on: it just cannot be resumed after a reboot. */
  function rememberSession(id: string): void {
    if (session === id) return;
    session = id;
    try {
      deps.sessionStore?.save(id);
    } catch {
      // fx-swallow-ok: a session id that cannot be saved only costs the resume after a reboot; the running host is not touched and no error text is kept
      sessionSaveFails++;
    }
  }

  /** Drops the stored session id (and its file) and says so in the host log in fixed words. */
  function forgetSession(): void {
    resumePending = false;
    session = undefined;
    try {
      deps.sessionStore?.clear();
    } catch {
      // fx-swallow-ok: a session file that cannot be removed is judged again by the next load; the in-memory id is already dropped so this supervisor starts fresh
    }
    logWrite("engine host: the stored session could not be resumed; the next start is a fresh session\n");
  }

  /** One `system` line that names a `compact_boundary`: the host's context was compacted. Only the type and subtype are read. */
  function compacted(line: string): void {
    try {
      const o = JSON.parse(line) as { type?: unknown; subtype?: unknown };
      if (o.type !== "system" || o.subtype !== "compact_boundary") return;
    } catch {
      // fx-swallow-ok: a line that is not JSON is not a compact boundary
      return;
    }
    try {
      deps.emit({ kind: "compaction_detected" });
      deps.observer?.onCompaction?.();
    } catch {
      // fx-swallow-ok: a sink or ticker that throws must not stop the stream from being read or the host from running
    }
  }

  /** Starts one host. A reason is returned (and nothing is started) when the files already say it must not run. */
  function launch(): StopReason | undefined {
    const args = [...HOST_ARGS, ...(session === undefined ? [] : ["--resume", session])];
    assertHostArgv(args);
    resumePending = session !== undefined;
    launchedAt = deps.now();
    keySource = undefined;
    const before = mustStop();
    if (before !== undefined) return before;
    const wrapped = deps.wrapLaunch?.(deps.claudePath, args, unit) ?? { file: "systemd-run", args: ["--user", "--scope", "--quiet", `--unit=${unit.replace(/\.scope$/, "")}`, "--", deps.claudePath, ...args] };
    const secrets = deps.secretEnv?.() ?? {};
    const child = deps.launch({ ...wrapped, cwd: checkout, env: { ...deps.env, ...secrets } });
    current = child;
    const redactions = (): string[] => [...Object.values(secrets), ...(deps.redactValues?.() ?? [])];
    const outLog = redactor(redactions);
    const errLog = redactor(redactions);
    let tail = "";
    let skipping = false;
    child.onStdout((text) => {
      outLog.push(text);
      // Only the session id of an `init` line is read; a line too long to hold is skipped to its end.
      tail += text;
      let nl = tail.indexOf("\n");
      while (nl !== -1) {
        const line = tail.slice(0, nl);
        tail = tail.slice(nl + 1);
        if (!skipping && line.startsWith(INIT_PREFIX)) {
          resumePending = false;
          try {
            const parsed = JSON.parse(line) as { session_id?: unknown; apiKeySource?: unknown };
            keySource = typeof parsed.apiKeySource === "string" && parsed.apiKeySource.length > 0 && parsed.apiKeySource.length <= 64 ? parsed.apiKeySource : undefined;
            const id = parsed.session_id;
            if (typeof id === "string" && UUID.test(id)) rememberSession(id);
          } catch {
            // fx-swallow-ok: a line that is not JSON is not an init line; the session id is simply not updated
          }
        }
        if (!skipping && line.startsWith(RESULT_PREFIX)) turnEnded(line);
        else if (!skipping && line.startsWith(SYSTEM_PREFIX) && line.includes(COMPACT_MARK)) compacted(line);
        skipping = false;
        nl = tail.indexOf("\n");
      }
      if (tail.length > SESSION_LINE_MAX) {
        tail = "";
        skipping = true;
      }
    });
    child.onStderr((text) => errLog.push(text));
    child.onExit(() => {
      outLog.flush();
      errLog.flush();
      onExit(child);
    });
    if (child.pid === undefined) {
      queueMicrotask(() => onExit(child));
      return undefined;
    }
    // The start time goes in the handle so the kill path never signals a pid that has since been reused (it is left out only when the host is already gone).
    const startTime = deps.startTimeOf(child.pid);
    const claimer = deps.claimer;
    handle = {
      pid: child.pid,
      unit,
      ...(startTime === undefined ? {} : { start_time: startTime }),
      ...(claimer === undefined ? {} : { claimer_pid: claimer.pid, ...(claimer.start === undefined ? {} : { claimer_start: claimer.start }) }),
    };
    try {
      writeHandle();
    } catch {
      // fx-swallow-ok: a host that has no handle cannot be found by the kill path later, so it is ended now (through the kill path, by its pid and scope) with a fixed reason
      void haltStop("host_failed");
      return undefined;
    }
    // A halt that landed between the first check and the handle above found nothing for the kill path to end: look again now that there is something to kill.
    const after = mustStop();
    if (after !== undefined) {
      void haltStop(after);
      return undefined;
    }
    deps.emit({ kind: "host_started" });
    beat();
    fileBeat();
    return undefined;
  }

  function onExit(child: HostChild): void {
    if (child !== current) return;
    current = undefined;
    cancelBeat?.();
    cancelFileBeat?.();
    try {
      deps.observer?.onExit();
    } catch {
      // fx-swallow-ok: a ticker that throws must not keep the restart from happening
    }
    for (const w of exitWaiters.splice(0)) w();
    if (stopping) return;
    // A host started with `--resume` that ended soon after its launch, before its `init` line and before it was sent anything, could not resume that session (it is
    // gone or unreadable): the stored id is dropped, so the next start is a fresh session instead of the same failing resume every time until the crash limit.
    // A host that ran longer, or had been sent a message, is an ordinary crash: its session stays and is resumed again.
    if (resumePending && deps.now() - launchedAt < RESUME_FAIL_WITHIN_MS) forgetSession();
    resumePending = false;
    void afterCrash();
  }

  async function afterCrash(): Promise<void> {
    // The dead host's handle must go first: its pid could be reused, and the kill path signals by pid.
    removeHandle();
    try {
      await deps.killScope(unit);
    } catch {
      // fx-swallow-ok: a scope that cannot be cleared is judged again by the next start's checks; the restart goes on
    }
    const why = await refusal();
    if (why !== undefined) return finish(reasonFor(why));
    const at = deps.now();
    crashes = crashes.filter((t) => at - t < CRASH_WINDOW_MS);
    crashes.push(at);
    if (crashes.length >= CRASH_LIMIT) return finish("crash_loop");
    const wait = BACKOFF_MS[Math.min(crashes.length - 1, BACKOFF_MS.length - 1)] ?? 300_000;
    cancelTimer = deps.after(wait, () => {
      void (async () => {
        try {
          if (stopping || finished) return;
          const again = await refusal();
          if (again !== undefined) return finish(reasonFor(again));
          const held = launch();
          if (held !== undefined) finish(held);
        } catch {
          // fx-swallow-ok: nothing may escape a timer; a restart that failed in any way ends the host with a fixed reason (no error text is kept)
          await haltStop("host_failed");
        }
      })();
    });
  }

  const api: Supervisor = {
    stopped,
    sessionId: () => session,
    keySource: () => keySource,
    survivors: () => survivorCount,
    logFailures: () => logFails,
    sessionSaveFailures: () => sessionSaveFails,
    touch() {
      if (current === undefined || finished || stopping || handle === undefined) return false;
      try {
        writeHandle();
        return true;
      } catch {
        // fx-swallow-ok: a heartbeat that cannot be written means the reader will take commands back, so the host must not go on applying them: it is ended with a fixed reason
        void haltStop("host_failed");
        return false;
      }
    },
    cleanup() {
      removeHandle();
      deps.log.close();
      release();
    },
    async start() {
      const why = await refusal();
      if (why !== undefined) return { ok: false, reason: why };
      try {
        lock = deps.acquireLock();
        if (lock === undefined) return { ok: false, reason: "already_running" };
        const recorded = readHostHandle(deps.stateDir, deps.uid);
        // The lock keeps every other supervisor out, so a handle here was left by a dead one. Its host still blocks a start only while it is really there.
        if (recorded !== undefined && deps.isAlive(recorded.pid) && deps.isOurHost(recorded)) {
          release();
          return { ok: false, reason: "already_running" };
        }
      } catch (error) {
        release();
        if (error instanceof EngineStateError) return { ok: false, reason: "state_unreadable" };
        throw error;
      }
      const held = launch();
      if (held !== undefined) {
        release();
        return { ok: false, reason: held === "operate_off" ? "operate_off" : "halted" };
      }
      return { ok: true };
    },
    send(text) {
      if (current === undefined || stopping) return false;
      resumePending = false; // a message went in: from here on an exit is an ordinary crash, not a failed resume
      current.write(`${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`);
      return true;
    },
    async stop(reason) {
      if (finished) return;
      if (stopping) {
        await stopped;
        return;
      }
      stopping = true;
      cancelTimer?.();
      cancelFileBeat?.();
      const child = current;
      if (child !== undefined) {
        const gone = new Promise<void>((resolve) => exitWaiters.push(resolve));
        child.closeStdin();
        let cancelGrace: (() => void) | undefined;
        const timedOut = new Promise<"grace">((resolve) => (cancelGrace = deps.after(STOP_GRACE_MS, () => resolve("grace"))));
        if ((await Promise.race([gone.then(() => "exit" as const), timedOut])) === "grace" && handle !== undefined) {
          noteKill(await deps.killHost(handle));
          await gone;
        }
        cancelGrace?.();
      }
      if (unit !== "") await deps.killScope(unit);
      finish(reason);
    },
  };
  return api;
}
