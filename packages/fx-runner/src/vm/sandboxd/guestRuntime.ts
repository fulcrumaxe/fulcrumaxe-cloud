/**
 * The agent runtime of a microVM guest (D#587 B-5a-RT-3): the Claude CLI runs INSIDE the guest through the guest agent's streaming exec, and its output
 * is read by the same function the host engine reads a child's with (`runAgentStream`, RT-2), so the events, the closed outcomes and the stop behaviour
 * are the host engine's by construction.
 *
 *  - Every guest call goes through one injected `launch(spec)` (the wiring fills it with the token launcher for a token spec and the sandbox's plain
 *    streaming exec for the rest) and one `writeFiles`. The runtime holds no token and builds none: the CLI is the only token launch of a delivery.
 *  - The process environment is `guestEnvOf(...)` and passes `microvmEnvAllowed`; every stream this runtime starts carries it. The token is on no argv,
 *    env field, file or log line here.
 *  - No `auth status` pre-flight (it would spend the single-use delivery): the init line's credential check, inside `runAgentStream`, is the guest's check.
 *  - SIGINT goes to the CLI's own pid, as on the host: the CLI starts under a one-line `sh` that records its pid (the `sh` then `exec`s, so the pid is the CLI's),
 *    and `interrupt` reads that file and signals it with one short guest command. The guest's own `kill` op reaches the whole group and every marked
 *    descendant, which would also interrupt the Bash tool's children, so it is used only by the stop ladder.
 *  - `abort()` of a stream only closes the host's socket, so the stop ladder kills the guest command first (SIGTERM, grace, SIGKILL) and aborts only after that.
 *  - Not supported in v1: API-key mode, browser jobs (playwright or Chrome), take-over (the wiring leaves it off for VM jobs).
 */
import { MAX_LINE_INPUT_SIDE_TOKENS, MAX_LINE_OUTPUT_TOKENS, MAX_METERED_IDS, SESSION_ID_PATTERN, isBrowserJobRole, structuredSchemaFor, type AgentHandle, type AgentRuntime, type LocalOnlyEvent, type StartOptions } from "@fulcrumaxe/runner-protocol";
import { claudeArgv } from "../../engines/claude/argv.js";
import { CLI_MODEL, RUN_ID, type EngineStartOptions, type RunOutcome } from "../../engines/claude/engine.js";
import { confineFileTools } from "../../engines/claude/filePermissions.js";
import { missingFlags, parseVersion, versionSupported, MIN_CLAUDE_VERSION } from "../../engines/claude/pin.js";
import { DEFAULT_KILL_GRACE_MS } from "../../engines/claude/processGroup.js";
import { EngineRefusal } from "../../engines/claude/refusal.js";
import { createRunLog } from "../../engines/claude/stream.js";
import { LOST_STREAM, endOfGuestExit, runAgentStream, textChunks, type AgentStreamEnd, type UsageLimits } from "../../engines/claude/streamRun.js";
import { UnknownRoleError, roleToolsFor } from "../../job/roleTools.js";
import { AgentError } from "./agentError.js";
import { guestEnvOf, microvmEnvAllowed } from "./guestEnv.js";
import { guestJobFiles, type GuestJobFilesInput } from "./guestJobFiles.js";
import { JobTokenError } from "./jobToken.js";
import { VM_BACKSTOP_MS, type InterruptibleRuntime, type MicrovmSandboxConfig } from "./microvmSandbox.js";
import type { StreamSpec } from "./sandboxd.js";
import type { SdkSandbox } from "./sdkSlice.js";
import type { GuestStream } from "./streamCommand.js";

export const GUEST_AGENT_PATH = "/opt/fx/bin/claude";
export const GUEST_JOBS_DIR = "/vercel/fx-job";
/** What a guest-read stream's usage meter is held to: output that is not the person's own CLI is untrusted (FU-162), so the host's lifted ceilings are not used. */
export const GUEST_USAGE_LIMITS: UsageLimits = { maxLineInputSideTokens: MAX_LINE_INPUT_SIDE_TOKENS, maxLineOutputTokens: MAX_LINE_OUTPUT_TOKENS, maxIds: MAX_METERED_IDS };
/**
 * The guest command's own limit when the wiring does not say the port's: a backstop only, the port's timer decides first. The wiring (3c) must pass
 * `timeoutMs`, so the guest's limit follows the port's limit; this fallback exists only so a missing binding never leaves a guest command unbounded.
 */
export const FALLBACK_LIMIT_MS = 24 * 3600_000;
/** The longest a guest command may be told to run, whatever limit is asked for. */
export const MAX_TIMEOUT_S = 7 * 24 * 3600;
const KILL_WAIT_MS = 5000;
/** Records the pid of the command that follows (made the run's temp directory first), then becomes it. */
const WRAP = 'umask 077; mkdir -p "$2" && echo "$$" > "$1" && shift 2 && exec "$@"';
/**
 * Signals the recorded pid. The file is read as text and used only if it is plain digits with no leading zero and is not 1 (a `0`, `00` or `-1` would
 * reach a whole process group or every process of the user, and a pid never has a leading zero); anything else exits 1 with no signal sent.
 */
export const SIGNAL_CLI = 'p=$(cat "$1") || exit 1; case "$p" in ""|*[!0-9]*|0*|1) exit 1;; esac; kill -INT "$p"';
const OOM_EVENTS = "cat /sys/fs/cgroup/fx-token/*/memory.events /sys/fs/cgroup/memory.events 2>/dev/null; true";

export type GuestLaunch = (spec: StreamSpec) => Promise<GuestStream>;
/** What a sandbox remembers about its image between a start and its resumes. */
export interface BinaryMemo { version?: Promise<string> }

export interface GuestRuntimeConfig {
  /** Starts a command in the guest. A spec with `withToken` is the CLI's token launch; every other spec is a plain command as the ordinary user. */
  launch: GuestLaunch;
  writeFiles(files: Array<{ path: string; content: string; mode?: number }>): Promise<void>;
  /** The job's environment (the port's `guestEnvOf` of it); it is passed through `guestEnvOf` and `microvmEnvAllowed` again here. */
  env?: Record<string, string>;
  credentials: { mode: "subscription" };
  agentPath?: string;
  jobsDir?: string;
  /** Raw transcripts, on the host, 0600, redacted like the host engine's. */
  logDir: string;
  killGraceMs?: number;
  /** After SIGKILL, how long the stop waits for the exit frame before it gives the stream up. */
  killWaitMs?: number;
  /** The port's wall-clock limit for this sandbox, when the wiring can say it. */
  timeoutMs?: () => number | undefined;
  onLocalEvent?: (event: LocalOnlyEvent) => void | Promise<void>;
  onNearLimit?: (info: { resetsAtMs?: number }) => void;
  /** Kept per sandbox by `guestMakeRuntime`, so a resume does not ask the guest again. */
  binary?: BinaryMemo;
  /** Test seam: the sandbox block builder. Real runs use the guest's own. */
  sandbox?: GuestJobFilesInput["sandbox"];
}

interface Run {
  stream: GuestStream;
  pidFile: string;
  over: boolean;
  ended: Promise<AgentStreamEnd>;
  stopping?: Promise<void>;
}

const noop = (): void => {
  // fx-swallow-ok: marks a best-effort call as handled; the outcome never depends on it
};
let counter = 0;
const stamp = (): string => `${Date.now().toString(36)}${(counter++).toString(36)}`;

async function within(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work.then(() => true), new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** One frame at a time from the frame reader to one consumer: a consumer that stops reading stops the guest's pipe, and nothing is queued. */
class Channel implements AsyncIterable<Buffer> {
  private item: Buffer | undefined;
  private taken: (() => void) | undefined;
  private wake: (() => void) | undefined;
  private closed = false;
  async push(chunk: Buffer): Promise<void> {
    if (this.closed) return;
    this.item = chunk;
    this.wake?.();
    await new Promise<void>((resolve) => (this.taken = resolve));
  }
  close(): void {
    this.closed = true;
    this.item = undefined;
    this.taken?.();
    this.wake?.();
  }
  [Symbol.asyncIterator](): AsyncIterator<Buffer> {
    return {
      next: async (): Promise<IteratorResult<Buffer>> => {
        while (this.item === undefined) {
          if (this.closed) return { done: true, value: undefined };
          await new Promise<void>((resolve) => (this.wake = resolve));
        }
        const value = this.item;
        this.item = undefined;
        this.taken?.();
        return { done: false, value };
      },
      return: async (): Promise<IteratorResult<Buffer>> => {
        this.close();
        return { done: true, value: undefined };
      },
    };
  }
}

/** Reads every frame into the two channels, and says how the command ended: the exit frame, or lost (never a clean end). */
async function relay(stream: GuestStream, out: Channel, err: Channel): Promise<AgentStreamEnd> {
  try {
    for await (const frame of stream.frames) await (frame.stream === "stdout" ? out : err).push(frame.data);
    return endOfGuestExit(await stream.done);
  } catch {
    // fx-swallow-ok: a stream that broke is a lost command, which the outcome reports as such
    return LOST_STREAM;
  } finally {
    out.close();
    err.close();
  }
}

export function createGuestRuntime(config: GuestRuntimeConfig): AgentRuntime & { interrupt(handle: AgentHandle): Promise<void> } {
  const agentPath = config.agentPath ?? GUEST_AGENT_PATH;
  const jobsDir = config.jobsDir ?? GUEST_JOBS_DIR;
  const graceMs = config.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const killWaitMs = config.killWaitMs ?? KILL_WAIT_MS;
  const memo = config.binary ?? {};
  const runs = new WeakMap<AgentHandle, Run>();

  /** A plain command as the ordinary user (no token): its stdout, and how it ended. Any guest failure rejects with the stream's own closed error. */
  async function ask(cmd: string, args: readonly string[], env: Record<string, string>, maxBytes: number): Promise<{ code: number | null; stdout: string }> {
    const stream = await config.launch({ id: `q${stamp()}`, cmd, args: [...args], cwd: "/tmp", env, timeoutS: 60, user: "ubuntu" });
    const parts: Buffer[] = [];
    let held = 0;
    for await (const frame of stream.frames) {
      if (frame.stream !== "stdout" || held >= maxBytes) continue;
      parts.push(frame.data);
      held += frame.data.length;
    }
    const done = await stream.done;
    return { code: done.timedOut ? null : done.exit, stdout: Buffer.concat(parts).toString("utf8") };
  }

  /** The engine's own checks (`parseVersion`, `versionSupported`, the required-flag scan) over what the guest's binary says, once per sandbox. */
  function binaryVersion(env: Record<string, string>): Promise<string> {
    memo.version ??= (async () => {
      const reported = await ask(agentPath, ["--version"], env, 4096);
      const version = reported.code === 0 ? parseVersion(reported.stdout) : undefined;
      if (version === undefined) throw new EngineRefusal("claude_version_unsupported", `the binary's version could not be read; ${MIN_CLAUDE_VERSION} or newer is needed`);
      if (!versionSupported(version)) throw new EngineRefusal("claude_version_unsupported", `version ${version} is older than ${MIN_CLAUDE_VERSION}`);
      const help = await ask(agentPath, ["--help"], env, 512 * 1024);
      if (help.code !== 0) throw new EngineRefusal("claude_flags_unsupported", "the binary's --help could not be read");
      const missing = missingFlags(help.stdout);
      if (missing.length > 0) throw new EngineRefusal("claude_flags_unsupported", `version ${version} lacks ${missing.join(", ")}`);
      return version;
    })().catch((error: unknown) => {
      memo.version = undefined; // a failure is not remembered
      throw error;
    });
    return memo.version;
  }

  /** True only when the guest's own memory accounting says the kernel killed something for memory. Any doubt is no. */
  async function oomKilled(env: Record<string, string>): Promise<boolean> {
    try {
      const read = await ask("/bin/sh", ["-c", OOM_EVENTS], env, 64 * 1024);
      return [...read.stdout.matchAll(/^oom_kill (\d+)$/gm)].some((m) => Number(m[1]) > 0);
    } catch {
      // fx-swallow-ok: a read that failed is `agent_exit`, never a guess
      return false;
    }
  }

  function stopRun(run: Run): Promise<void> {
    run.stopping ??= (async () => {
      if (run.over) return;
      await run.stream.kill("SIGTERM").catch(noop);
      if (await within(run.ended, graceMs)) return;
      await run.stream.kill("SIGKILL").catch(noop);
      if (await within(run.ended, killWaitMs)) return;
      run.stream.abort(); // the guest has been told twice; the host stops listening, and the read fails as lost
      await run.ended;
    })();
    return run.stopping;
  }

  const lostHandle = (opts: EngineStartOptions, engineVersion: string): { handle: AgentHandle } => ({ handle: { runId: opts.runId, options: opts, done: Promise.resolve<RunOutcome>({ status: "failed", failureReason: "agent_exit", engineVersion }) } });

  async function run(opts: EngineStartOptions, resumeSessionId: string | undefined): Promise<{ handle: AgentHandle }> {
    if ((config.credentials as { mode: string }).mode !== "subscription") throw new EngineRefusal("credential_mismatch");
    let roleTools: readonly string[];
    try {
      roleTools = roleToolsFor(opts.role);
    } catch (error) {
      if (error instanceof UnknownRoleError) throw new EngineRefusal("unknown_role");
      throw error;
    }
    const workdir = opts.workdir;
    const idOk = RUN_ID.test(opts.runId) && CLI_MODEL.test(opts.model) && (resumeSessionId === undefined || (SESSION_ID_PATTERN.test(resumeSessionId) && !resumeSessionId.startsWith("-")));
    if (workdir === undefined || !workdir.startsWith("/") || !idOk) throw new EngineRefusal("bad_start_options");
    if (opts.browserMethod !== undefined || isBrowserJobRole(opts.role)) throw new EngineRefusal("bad_start_options", "browser jobs are not supported in a microVM");
    const env = guestEnvOf(config.env ?? {});
    if (!microvmEnvAllowed(env)) throw new EngineRefusal("bad_start_options", "the environment is outside the microVM table");
    const files = guestJobFiles({ jobsDir, runId: opts.runId, role: opts.role, workdir, excludes: opts.excludes, checkArgv: opts.checkArgv, ...(config.sandbox === undefined ? {} : { sandbox: config.sandbox }) });
    const schema = structuredSchemaFor(opts.role);
    const argv = claudeArgv({ cliModel: opts.model, roleTools, allowRules: confineFileTools(roleTools, workdir), settingsPath: files.settingsPath, mcpPath: files.mcpPath, chrome: false, ...(schema === undefined ? {} : { jsonSchema: schema }), ...(resumeSessionId === undefined ? {} : { resumeSessionId }) });
    const log = createRunLog(config.logDir, opts.runId, []);
    const pidFile = `/tmp/fx-pid-${opts.runId}-${stamp()}`;
    const timeoutS = Math.min(Math.ceil(((config.timeoutMs?.() ?? FALLBACK_LIMIT_MS) + VM_BACKSTOP_MS) / 1000), MAX_TIMEOUT_S);

    let engineVersion = "unknown";
    let stream: GuestStream;
    try {
      engineVersion = await binaryVersion(env);
      await config.writeFiles(files.files);
      stream = await config.launch({ id: `${opts.runId}-${stamp()}`, cmd: "/bin/sh", args: ["-c", WRAP, "fx-run", pidFile, files.tempDir, agentPath, ...argv], cwd: workdir, env, stdin: Buffer.from(opts.prompt), timeoutS, withToken: true, user: "ubuntu" });
    } catch (error) {
      if (error instanceof EngineRefusal || error instanceof JobTokenError) throw error;
      if (error instanceof AgentError && error.code === "unsupported") throw new EngineRefusal("guest_agent_unsupported");
      return lostHandle(opts, engineVersion); // a refused launch or a vanished guest: the run ended, never ok, and the cause is not in the code
    }

    const out = new Channel();
    const err = new Channel();
    const ended = relay(stream, out, err);
    const state: Run = { stream, pidFile, over: false, ended };
    void ended.then(() => void (state.over = true));
    const handle: AgentHandle = { runId: opts.runId, options: opts };
    runs.set(handle, state);
    let sawResult = false;
    try {
      handle.done = runAgentStream({
        options: { ...opts, onEvent: (event) => (event.type === "result" || event.type === "error" ? (sawResult = true) : undefined, opts.onEvent(event)) },
        workdir,
        credentials: config.credentials,
        engineVersion,
        stdout: textChunks(out),
        stderr: textChunks(err),
        ended,
        terminate: () => stopRun(state),
        usageLimits: GUEST_USAGE_LIMITS,
        log,
        ...(config.onLocalEvent === undefined ? {} : { onLocalEvent: config.onLocalEvent }),
        ...(config.onNearLimit === undefined ? {} : { onNearLimit: config.onNearLimit }),
        resourceLimitExceeded: async () => !sawResult && (await oomKilled(env)),
      });
    } catch (error) {
      void stopRun(state); // the transcript could not be opened: the CLI must not run on unobserved
      throw error;
    }
    return { handle };
  }

  return {
    start: (opts: StartOptions) => run(opts as EngineStartOptions, (opts as EngineStartOptions).resumeSessionId),
    async interrupt(handle) {
      const state = runs.get(handle);
      if (state === undefined || state.over) return;
      await ask("/bin/sh", ["-c", SIGNAL_CLI, "fx-int", state.pidFile], guestEnvOf(config.env ?? {}), 1024).catch(noop);
    },
    async stop(handle) {
      const state = runs.get(handle);
      if (state === undefined) return;
      await Promise.all([stopRun(state), Promise.resolve(handle.done)]);
    },
    resume(handle, sessionId, prompt) {
      const previous = handle.options as EngineStartOptions | undefined;
      if (previous === undefined) throw new EngineRefusal("bad_start_options", "handle has no start options");
      return run({ ...previous, prompt }, sessionId);
    },
  };
}

/** The per-guest part of a runtime: how the wiring reaches this sandbox's streaming exec. `writeFiles` is the guest's own. */
export interface GuestBinding {
  launch: GuestLaunch;
  timeoutMs?: () => number | undefined;
  /** The run's own usage and relay sinks (D#587 3c-iii): what the OS-sandbox path passes as `onLocalEvent` and `onNearLimit`, so a guest run's usage reaches the lease and the usage gate. */
  onLocalEvent?: GuestRuntimeConfig["onLocalEvent"];
  onNearLimit?: GuestRuntimeConfig["onNearLimit"];
}

/**
 * `makeRuntime` for `createMicrovmSandbox`. The port calls it for every start and resume, so what must outlive one call (the binary check) is kept
 * here, by sandbox name.
 */
export function guestMakeRuntime(shared: Omit<GuestRuntimeConfig, "launch" | "writeFiles" | "env" | "timeoutMs" | "binary">, bind: (guest: SdkSandbox) => GuestBinding): MicrovmSandboxConfig["makeRuntime"] {
  const memos = new Map<string, BinaryMemo>();
  return (guest, job): InterruptibleRuntime => {
    const memo = memos.get(guest.name) ?? {};
    memos.set(guest.name, memo);
    const binding = bind(guest);
    return createGuestRuntime({ ...shared, ...binding, writeFiles: (files) => guest.writeFiles(files), env: job.env, binary: memo });
  };
}
