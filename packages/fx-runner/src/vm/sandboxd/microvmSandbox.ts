/**
 * The microVM engine behind the runner's own `SandboxPort` (D#587 B-5a). It sits next to `createHostSandbox` and is held to the same contract suite
 * (`test/sandbox/engineContract.ts`). It is built on the daemon's SDK slice (`createDaemonSdk`), so names, sessions, the network policy and the
 * daemon's own refusals are decided there, once; this file decides only what the port itself promises.
 *
 *  - A sandbox is created closed (`deny-all`). A job's `networkPolicy` is put in force, and awaited, before anything runs in the guest.
 *  - The agent is started by a runtime the caller builds for the sandbox (`makeRuntime`), given the guest's command slice. Which agent, and how
 *    the job's workspace gets into the guest, is not this file's business.
 *  - Like the host engine, no rule that carries a header to inject (or points at the cloud's GitHub forwarder) is valid on a runner.
 *  - `stop` ends the agent and then the VM. A later start or resume boots the sandbox again (a fresh boot until snapshots are wired in; keeping the
 *    disk across a stop belongs to B-5b item 5).
 *  - A job's environment is checked against the microVM's own closed table (`guestEnv.ts`) before anything is touched; allowances, extra read
 *    paths and a spill directory are refused until B-5b defines how they cross.
 *  - A sandbox does one thing at a time. While an agent runs, or a `runCommand` or `writeFiles` is in flight, every other start, command and file
 *    write is refused (`sandbox_busy`): the marker is set before the first await, so neither order can replace a running agent's network policy.
 *  - The port's timer is armed against one absolute deadline, so a small extension adds exactly its length. The VM's own timer is a backstop that is
 *    kept `VM_BACKSTOP_MS` past that deadline at launch and on every extension, so the port's timer decides first and a run that ran out of time is
 *    reported as `sandbox_timeout`, not as an agent that died. The total a woken VM's timer is armed with is always the port's limit plus the
 *    backstop, set as an absolute value: topping the live timer up for idle time never grows it.
 *  - `readCounters` answers nothing: the daemon measures no CPU time or egress bytes yet, and a figure is never made up.
 */
import type { AgentHandle, AgentRuntime, NormalizedEvent } from "@fulcrumaxe/runner-protocol";
import { AgentRunFailed, failureOf } from "../../sandbox/agentOutcome.js";
import {
  SandboxNotFoundError,
  type CreateSandboxOptions,
  type NetworkRule,
  type RunCommandOptions,
  type RunCommandResult,
  type SandboxComputeState,
  type SandboxHandle,
  type SandboxPort,
  type SandboxSessionUsage,
  type StartDetachedOptions,
  type StartDetachedResult,
} from "../../sandbox/port.js";
import { guestEnvOf, microvmEnvAllowed } from "./guestEnv.js";
import type { LimitControl } from "./sdkAdapter.js";
import type { SdkSandbox, VercelCredentials, VercelSandboxSdk } from "./sdkSlice.js";

/** How much longer the VM's own timer runs than the port's. */
export const VM_BACKSTOP_MS = 30_000;
/** The most each of stdout and stderr that `runCommand` keeps; more sets `truncated`. */
export const RUN_COMMAND_MAX_OUTPUT_CHARS = 256 * 1024;
/** The most a timer may be asked to wait (`setTimeout` overflows past 2^31-1 ms). The limit, and the VM's limit with its backstop, stay at or under it. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** The most the port's own limit may be, in total: the VM's limit (this plus the backstop) must fit a timer too. */
export const MAX_TIMEOUT_MS = MAX_TIMER_MS - VM_BACKSTOP_MS;
const MAX_ARG_CHARS = 4096;
const MEASURE_MAX_PAGES = 5;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
/** The adapter reads none of these (a local VM has no account); the slice's types ask for them. */
const LOCAL: VercelCredentials = { teamId: "local", projectId: "local", token: "local" };

/** Why a start or a call was refused. Closed set; the message never carries a value from a job. */
export class MicrovmSandboxRefused extends Error {
  constructor(readonly code: "network_rule_forbidden" | "bad_workdir" | "env_not_clean" | "sandbox_allowance_forbidden" | "sandbox_busy" | "sandbox_timeout" | "bad_sandbox_name" | "sandbox_exists" | "not_running" | "bad_request") {
    super(code);
    this.name = "MicrovmSandboxRefused";
  }
}

export interface MicrovmSandboxConfig {
  /** `createDaemonSdk(...)`: the slice every sandbox call goes through, and the VM's limit as an absolute value. */
  sdk: Pick<VercelSandboxSdk, "create" | "get"> & LimitControl;
  /** Builds the agent runtime for one job from the guest's own command slice. */
  makeRuntime(guest: SdkSandbox, opts: StartDetachedOptions): InterruptibleRuntime;
}

/** An agent runtime that can also be sent an interrupt (SIGINT: it ends the agent's turn cleanly), as the host engine's can. */
export type InterruptibleRuntime = AgentRuntime & { interrupt?(handle: AgentHandle): void | Promise<void> };

export interface MicrovmSandbox extends SandboxPort {
  /** The sandbox's current wall-clock limit, or `undefined` for a name this port does not hold. */
  timeoutMsOf(handle: SandboxHandle): number | undefined;
  /** Interrupts the sandbox's agent once it exists. Does nothing, and does not throw, for a name that is gone or an agent that has ended. */
  interrupt(handle: SandboxHandle): Promise<void>;
  /**
   * The running guest of this sandbox, for the runner's own steps after the agent (the bundle read; D#587 B-5b). The approved check never runs in it: it runs in a fresh VM. `not_running` when the VM is
   * stopped, and `SandboxNotFoundError` for a name the daemon no longer holds.
   */
  guestOf(handle: SandboxHandle): Promise<SdkSandbox>;
  /** Ends the agent and its process group and leaves the VM running: the quiet point before the runner reads or checks the working copy. Idempotent. */
  quiesce(handle: SandboxHandle): Promise<void>;
}

interface Entry {
  /** The port's limit for a run, in total (the create's plus every extension). */
  timeoutMs: number;
  /** When the current run's limit ends, wall-clock ms: set at launch, moved only by an extension. */
  deadline?: number;
  /** When the VM's own timer is expected to fire, wall-clock ms. Kept at least `VM_BACKSTOP_MS` past `deadline` while a run goes. */
  vmDeadline: number;
  /** When the current run was started, wall-clock ms. */
  launchedAt: number;
  runtime?: InterruptibleRuntime;
  agent?: AgentHandle;
  /** Settles when the agent process exists (or its start failed). A stop waits on this, never on the run's end. */
  agentUp?: Promise<unknown>;
  running: boolean;
  /** A `runCommand` or `writeFiles` is in flight: set before its first await, cleared when it ends. */
  busy: boolean;
  timer?: NodeJS.Timeout;
  expired: boolean;
}

const noop = (): void => {
  // fx-swallow-ok: this only marks a promise as handled; whoever awaits it still sees the rejection
};

const statusOf = (err: unknown): number | undefined => (typeof err === "object" && err !== null ? (err as { response?: { status?: unknown } }).response?.status : undefined) as number | undefined;
const isGone = (err: unknown): boolean => statusOf(err) === 404 || statusOf(err) === 410;

/** What the daemon's egress enforces for a job's rules: the hosts, as a plain list. No rules is closed. */
export function policyOf(rules: readonly NetworkRule[]): unknown {
  return rules.length === 0 ? "deny-all" : { allow: [...new Set(rules.map((rule) => rule.host))] };
}

function assertRules(rules: readonly NetworkRule[]): void {
  for (const rule of rules) {
    if (rule.authHeader !== undefined || rule.authValue !== undefined || rule.purpose === "github_proxy") throw new MicrovmSandboxRefused("network_rule_forbidden");
  }
}

/** What this engine refuses in a job before anything is touched: an environment outside its table, and what B-5b has not yet defined. */
function assertJob(opts: StartDetachedOptions): void {
  if (!microvmEnvAllowed(opts.env)) throw new MicrovmSandboxRefused("env_not_clean");
  if (opts.allowances !== undefined || (opts.extraReadPaths !== undefined && opts.extraReadPaths.length > 0) || opts.spillDir !== undefined) throw new MicrovmSandboxRefused("sandbox_allowance_forbidden");
}

export function createMicrovmSandbox(config: MicrovmSandboxConfig): MicrovmSandbox {
  const { sdk } = config;
  const entries = new Map<string, Entry>();
  const making = new Set<string>();

  /** The SDK's sandbox of this name, woken first when `wake` is set. A name the daemon no longer has drops the entry and is `SandboxNotFoundError`. */
  async function open(name: string, wake: boolean): Promise<SdkSandbox> {
    try {
      return await sdk.get({ name, resume: wake, ...LOCAL });
    } catch (err) {
      if (isGone(err)) {
        const entry = entries.get(name);
        clearTimeout(entry?.timer);
        entries.delete(name);
        throw new SandboxNotFoundError(name);
      }
      throw err;
    }
  }

  function arm(entry: Entry): void {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.expired = true;
      void stopAgent(entry);
    }, Math.min(Math.max((entry.deadline ?? Date.now()) - Date.now(), 0), MAX_TIMER_MS));
    entry.timer.unref();
  }

  async function stopAgent(entry: Entry, surface = false): Promise<void> {
    await entry.agentUp?.catch(noop);
    if (entry.runtime === undefined || entry.agent === undefined) return;
    if (surface) await entry.runtime.stop(entry.agent);
    else await entry.runtime.stop(entry.agent).catch(noop);
  }

  function launch(handle: SandboxHandle, opts: StartDetachedOptions, resumeSessionId: string | undefined): StartDetachedResult {
    const name = handle.sandboxName;
    const entry = entries.get(name);
    if (entry === undefined) throw new SandboxNotFoundError(name);
    assertRules(opts.networkPolicy);
    assertJob(opts);
    const workdir = opts.workdir;
    if (workdir === undefined || !workdir.startsWith("/")) throw new MicrovmSandboxRefused("bad_workdir");
    if (entry.running || entry.busy) throw new MicrovmSandboxRefused("sandbox_busy");
    const job = { ...opts, env: guestEnvOf(opts.env) };

    let last: NormalizedEvent | undefined;
    const agentUp = (async () => {
      // a stopped sandbox boots again, closed; the job's own policy is then in force before the agent exists
      const before = await open(name, false);
      const woke = before.status !== "running";
      const guest = woke ? await open(name, true) : before;
      if (woke) entry.vmDeadline = entry.launchedAt + (guest.timeout ?? 0); // the daemon re-arms a woken VM's timer a moment after this start began, so counting from here never overstates it
      // the VM's timer must outlast the port's deadline by the backstop: the idle time before this start, or a limit extended while the VM was down, may have eaten it
      const need = (entry.deadline ?? Date.now()) + VM_BACKSTOP_MS;
      if (entry.vmDeadline < need) {
        // the live timer is set to that deadline; the total a later wake arms with is not touched (it is the port's limit plus the backstop, always)
        await sdk.armTimeoutAt(name, Math.max(need - Date.now(), 1));
        entry.vmDeadline = need;
      }
      await guest.updateNetworkPolicy(policyOf(opts.networkPolicy));
      await opts.onSession?.(guest.currentSession().sessionId);
      try {
        await opts.onStage?.("sandbox_ready");
      } catch {
        // fx-swallow-ok: the stage callback is best effort and never fails a launch
      }
      const runtime = config.makeRuntime(guest, job);
      const { role, roleCard, prompt, model, capUsd } = opts;
      const started = await runtime.start({
        runId: opts.runId, role, roleCard, prompt, model, workdir, capUsd,
        ...(opts.excludes === undefined || opts.excludes.length === 0 ? {} : { excludes: opts.excludes }),
        ...(opts.checkArgv === undefined || opts.checkArgv.length === 0 ? {} : { checkArgv: opts.checkArgv }),
        ...(opts.browserMethod === undefined ? {} : { browserMethod: opts.browserMethod }),
        ...(opts.contextWindowTokens === undefined ? {} : { contextWindowTokens: opts.contextWindowTokens }),
        ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
        onEvent: (event: NormalizedEvent) => {
          last = event;
          return opts.onEvent(event);
        },
      } as Parameters<AgentRuntime["start"]>[0]);
      entry.runtime = runtime;
      entry.agent = started.handle;
      if (entry.expired) await runtime.stop(started.handle).catch(noop);
      return started.handle;
    })();
    entry.agentUp = agentUp;
    entry.running = true;
    entry.launchedAt = Date.now();
    entry.deadline = entry.launchedAt + entry.timeoutMs;
    const starting = agentUp.then(async (agent) => {
      const failure = failureOf(await agent.done);
      if (failure !== undefined) throw new AgentRunFailed(failure);
    });
    arm(entry);
    const finish = (): void => {
      clearTimeout(entry.timer);
      entry.running = false;
    };
    const hookFired = starting.then(
      () => {
        finish();
        if (entry.expired) throw new MicrovmSandboxRefused("sandbox_timeout");
        return last;
      },
      (error: unknown) => {
        finish();
        // A run the wall clock stopped ends in a failed outcome of its own making; the timeout is the cause.
        if (entry.expired && error instanceof AgentRunFailed) throw new MicrovmSandboxRefused("sandbox_timeout");
        throw error;
      },
    );
    const launched = agentUp.then(() => undefined);
    launched.catch(noop);
    return { handle, hookFired, launched };
  }

  return {
    async createSandbox(opts: CreateSandboxOptions): Promise<SandboxHandle> {
      const name = opts.sandboxName;
      if (!NAME.test(name)) throw new MicrovmSandboxRefused("bad_sandbox_name");
      if (!Number.isSafeInteger(opts.timeoutMs) || opts.timeoutMs <= 0 || opts.timeoutMs > MAX_TIMEOUT_MS) throw new MicrovmSandboxRefused("bad_request");
      if (opts.vcpus !== undefined && (!Number.isSafeInteger(opts.vcpus) || opts.vcpus < 1)) throw new MicrovmSandboxRefused("bad_request");
      if (entries.has(name) || making.has(name)) throw new MicrovmSandboxRefused("sandbox_exists");
      making.add(name);
      try {
        const keep = opts.retention.keepLastSnapshots;
        const sandbox = await sdk
          .create({ ...LOCAL, name, image: "microvm", timeout: opts.timeoutMs + VM_BACKSTOP_MS, persistent: opts.retention.persistent, resources: { vcpus: opts.vcpus ?? 1 }, tags: {}, ...(keep === undefined ? {} : { keepLastSnapshots: { count: keep } }), networkPolicy: "deny-all" })
          .catch((err: unknown) => {
            // the daemon answers a name it already holds as a 400, and so it does a request it refuses: only a name that is there is `sandbox_exists`
            if (statusOf(err) !== 400) throw err;
            return open(name, false).then(
              () => Promise.reject(new MicrovmSandboxRefused("sandbox_exists")),
              () => Promise.reject(new MicrovmSandboxRefused("bad_request")),
            );
          });
        entries.set(name, { timeoutMs: opts.timeoutMs, vmDeadline: Date.now() + opts.timeoutMs + VM_BACKSTOP_MS, launchedAt: 0, running: false, busy: false, expired: false });
        return { runId: "", sandboxName: name, sessionId: sandbox.currentSession().sessionId };
      } finally {
        making.delete(name);
      }
    },
    startDetached: (handle, opts) => launch(handle, opts, undefined),
    resume: (handle, sessionId, prompt, opts) => launch(handle, { ...opts, prompt }, sessionId),
    async extendTimeout(handle, additionalMs) {
      const entry = entries.get(handle.sandboxName);
      if (entry === undefined) return;
      if (!Number.isSafeInteger(additionalMs) || additionalMs <= 0) throw new MicrovmSandboxRefused("bad_request");
      if (additionalMs > MAX_TIMEOUT_MS || entry.timeoutMs + additionalMs > MAX_TIMEOUT_MS) throw new MicrovmSandboxRefused("bad_request");
      entry.timeoutMs += additionalMs;
      if (entry.running && entry.deadline !== undefined) {
        entry.deadline += additionalMs; // one deadline: the extension adds its own length and no more
        arm(entry);
      }
      const guest = await open(handle.sandboxName, false).catch((err: unknown) => (err instanceof SandboxNotFoundError ? undefined : Promise.reject(err)));
      if (guest !== undefined && guest.status === "running") {
        await guest.extendTimeout(additionalMs);
        entry.vmDeadline += additionalMs;
      } else if (guest !== undefined) {
        // a stopped VM has no timer to move: the total its next wake arms with is set instead, so it is still the port's limit plus the backstop
        await sdk.setTimeoutMs(handle.sandboxName, entry.timeoutMs + VM_BACKSTOP_MS);
      }
    },
    async stop(handle) {
      const entry = entries.get(handle.sandboxName);
      if (entry === undefined) return;
      await stopAgent(entry, true);
      const guest = await open(handle.sandboxName, false).catch((err: unknown) => (err instanceof SandboxNotFoundError ? undefined : Promise.reject(err)));
      if (guest !== undefined) await guest.stop();
    },
    async deleteSandbox(handle) {
      const name = handle.sandboxName;
      const entry = entries.get(name);
      if (entry !== undefined) {
        await stopAgent(entry);
        clearTimeout(entry.timer);
      }
      // also for a name this port instance did not make: the daemon may still hold it
      try {
        await (await sdk.get({ name, resume: false, ...LOCAL })).delete();
      } catch (err) {
        if (!isGone(err)) throw err;
      }
      entries.delete(name);
    },
    async writeFiles(handle, files) {
      const entry = entries.get(handle.sandboxName);
      if (entry?.running === true || entry?.busy === true) throw new MicrovmSandboxRefused("sandbox_busy");
      if (entry !== undefined) entry.busy = true; // before the first await: a start that comes now is refused
      try {
        const guest = await open(handle.sandboxName, false);
        if (guest.status !== "running") throw new MicrovmSandboxRefused("not_running");
        await guest.writeFiles(files.map(({ path, content, mode }) => ({ path, content, ...(mode !== undefined && { mode }) })));
      } finally {
        if (entry !== undefined) entry.busy = false;
      }
    },
    async runCommand(handle, opts: RunCommandOptions): Promise<RunCommandResult> {
      if (opts.cmd === "" || !Number.isSafeInteger(opts.timeoutMs) || opts.timeoutMs <= 0 || opts.args.some((a) => a.length > MAX_ARG_CHARS || a.includes("\0"))) throw new MicrovmSandboxRefused("bad_request");
      assertRules(opts.networkPolicy);
      if (!microvmEnvAllowed(opts.env)) throw new MicrovmSandboxRefused("env_not_clean");
      const entry = entries.get(handle.sandboxName);
      // a sandbox does one thing at a time: an agent that runs, or another command or file write in flight, keeps the policy in force for it.
      // The marker is set before the first await, so a start that comes while this command is still being set up is refused too.
      if (entry?.running === true || entry?.busy === true) throw new MicrovmSandboxRefused("sandbox_busy");
      if (entry !== undefined) entry.busy = true;
      try {
        const guest = await open(handle.sandboxName, false);
        if (guest.status !== "running") throw new MicrovmSandboxRefused("not_running");
        const sessionId = guest.currentSession().sessionId;
        await opts.onSession?.(sessionId);
        await guest.updateNetworkPolicy(policyOf(opts.networkPolicy));
        const command = await guest.runCommand({ cmd: opts.cmd, args: [...opts.args], env: guestEnvOf(opts.env), detached: true });
        const held = { stdout: "", stderr: "" };
        let truncated = false;
        let timedOut = false;
        let timer: NodeJS.Timeout | undefined;
        const limit = new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), opts.timeoutMs);
        });
        const finished = (async () => {
          for await (const chunk of command.logs()) {
            if ((chunk.stream !== "stdout" && chunk.stream !== "stderr") || typeof chunk.data !== "string") continue;
            const room = Math.max(RUN_COMMAND_MAX_OUTPUT_CHARS - held[chunk.stream].length, 0);
            if (chunk.data.length > room) truncated = true;
            held[chunk.stream] += chunk.data.slice(0, room);
          }
          return command.wait();
        })();
        finished.catch(noop);
        try {
          const outcome = await Promise.race([finished, limit]);
          if (outcome === "timeout") {
            timedOut = true;
            await command.kill("SIGKILL").catch(noop);
            return { exitCode: null, timedOut, stdout: held.stdout, stderr: held.stderr, truncated, sessionId };
          }
          return { exitCode: outcome.exitCode, timedOut, stdout: held.stdout, stderr: held.stderr, truncated, sessionId };
        } finally {
          clearTimeout(timer);
        }
      } finally {
        if (entry !== undefined) entry.busy = false;
      }
    },
    async measure(handle, sessionIds): Promise<SandboxSessionUsage[]> {
      const wanted = new Set(sessionIds);
      if (wanted.size === 0) return [];
      const guest = await open(handle.sandboxName, false).catch((err: unknown) => (err instanceof SandboxNotFoundError ? undefined : Promise.reject(err)));
      if (guest === undefined) return [];
      const found: SandboxSessionUsage[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MEASURE_MAX_PAGES; page++) {
        const result = await guest.listSessions({ limit: 100, sortOrder: "desc", ...(cursor === undefined ? {} : { cursor }) });
        for (const s of result.sessions) {
          if (!wanted.has(s.id)) continue;
          found.push({ sessionId: s.id, ...(s.memory === undefined ? {} : { memoryMb: s.memory }), ...(s.region === undefined ? {} : { region: s.region }), ...(s.duration === undefined ? {} : { durationMs: s.duration }) });
        }
        if (result.pagination.next === null) break;
        cursor = result.pagination.next;
      }
      return found;
    },
    async readCounters() {
      return undefined;
    },
    async sandboxExists(handle) {
      try {
        await open(handle.sandboxName, false);
        return true;
      } catch (err) {
        // fx-swallow-ok: the answer is the result: only a definite "not found" is gone; any other failure counts as present, as it does on the hosted port
        return !(err instanceof SandboxNotFoundError);
      }
    },
    async sandboxState(handle): Promise<SandboxComputeState> {
      try {
        const status = (await open(handle.sandboxName, false)).status;
        if (status === "running" || status === "pending") return "running";
        if (status === "stopped" || status === "failed" || status === "aborted") return "stopped";
        return "unknown";
      } catch (err) {
        // fx-swallow-ok: the answer is the state: a definite not-found is gone, any doubt is unknown
        return err instanceof SandboxNotFoundError ? "gone" : "unknown";
      }
    },
    timeoutMsOf: (handle) => entries.get(handle.sandboxName)?.timeoutMs,
    async interrupt(handle) {
      const entry = entries.get(handle.sandboxName);
      await entry?.agentUp?.catch(noop); // the agent may still be starting: it is interrupted once it exists
      if (entry?.running === true && entry.runtime !== undefined && entry.agent !== undefined) await entry.runtime.interrupt?.(entry.agent);
    },
    async guestOf(handle) {
      const guest = await open(handle.sandboxName, false);
      if (guest.status !== "running") throw new MicrovmSandboxRefused("not_running");
      return guest;
    },
    async quiesce(handle) {
      const entry = entries.get(handle.sandboxName);
      if (entry !== undefined) await stopAgent(entry, true);
    },
  };
}
