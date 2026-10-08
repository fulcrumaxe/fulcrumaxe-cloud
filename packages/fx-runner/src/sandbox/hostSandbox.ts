import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { AgentHandle, AgentRuntime, NormalizedEvent } from "@fulcrumaxe/runner-protocol";
import { cleanEnv, type CredentialMode } from "../job/cleanEnv.js";
import { NotAPlainSegment, segmentUnder } from "../job/plainSegment.js";
import {
  SandboxNotFoundError,
  type CreateSandboxOptions,
  type SandboxComputeState,
  type SandboxHandle,
  type SandboxPort,
  type StartDetachedOptions,
  type StartDetachedResult,
} from "./port.js";
import { assertEnabledSandbox, sandboxSettings } from "./sandboxSettings.js";

export interface HostSandboxConfig {
  credentials: CredentialMode;
  /**
   * Builds the agent runtime for one job from the `sandbox` block this tier computed for it. The runtime writes the
   * block into the settings file it starts the agent with; nothing else decides what the shell sandbox allows.
   */
  makeRuntime(sandbox: Record<string, unknown>): AgentRuntime;
  /** The user's home directory (absolute). Its reads are denied to the job. */
  home: string;
  /** Per-job temp directories are made under here (0700) and removed with the sandbox. */
  tempRoot: string;
  /** The runner's own state directory (`~/.fx-runner`) and the stored agent binary's directory: the job may not write to either. */
  stateDir: string;
  binaryDir: string;
  /** The repository's declared registry hosts, none by default. */
  registries?: readonly string[];
}

/** Why a sandbox start was refused. Closed set. The message never carries a value from a job. */
export class HostSandboxRefused extends Error {
  constructor(readonly code: "network_rule_forbidden" | "env_not_clean" | "bad_workdir" | "sandbox_busy" | "sandbox_timeout" | "bad_sandbox_name", detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = "HostSandboxRefused";
  }
}

/** The agent ended in a failed outcome. `code` is the engine's closed failure reason, so the job runner reports it as is. */
export class AgentRunFailed extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AgentRunFailed";
  }
}

const REASON = /^[a-z][a-z0-9_]{0,63}$/;

/** The failure reason of an engine outcome (`{ status: "failed", failureReason }`), or `undefined` for a clean end or a runtime that settles with no outcome. */
function failureOf(outcome: unknown): string | undefined {
  if (outcome === null || typeof outcome !== "object" || (outcome as { status?: unknown }).status !== "failed") return undefined;
  const reason = (outcome as { failureReason?: unknown }).failureReason;
  return typeof reason === "string" && REASON.test(reason) ? reason : "agent_exit";
}

interface Entry {
  tempDir: string;
  timeoutMs: number;
  runtime?: AgentRuntime;
  agent?: AgentHandle;
  /** Settles when the agent process exists (or its start failed). A stop waits on this, never on the run's end. */
  agentUp?: Promise<unknown>;
  running: boolean;
  timer?: NodeJS.Timeout;
  expired: boolean;
}

export interface HostSandbox extends SandboxPort {
  /** The sandbox's current wall-clock limit, or `undefined` for a name that is gone. */
  timeoutMsOf(handle: SandboxHandle): number | undefined;
}

function sameEnv(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a).sort();
  const other = Object.keys(b).sort();
  return keys.length === other.length && keys.every((key, i) => key === other[i] && a[key] === b[key]);
}

/**
 * Tier (d): the job runs on this machine under Claude Code's own shell sandbox. This adapter holds the same port
 * contract as every other tier, with the differences a local tier has:
 *  - `env` must equal `cleanEnv(credentials)`: nothing here brokers a credential, so the job gets only what that
 *    allowlist builds;
 *  - the network policy is a host allowlist. A rule that carries a header to inject, or one that points at the cloud's
 *    GitHub forwarder, throws: nothing here injects headers, and pushes happen outside the sandbox;
 *  - no snapshots are kept, so retention keeps nothing and there is nothing to measure.
 */
export function createHostSandbox(config: HostSandboxConfig): HostSandbox {
  const sandboxes = new Map<string, Entry>();

  const noop = (): void => {
    // fx-swallow-ok: this only marks a promise as handled; whoever awaits it still sees the rejection
  };

  function entryOf(handle: SandboxHandle): Entry | undefined {
    return sandboxes.get(handle.sandboxName);
  }

  function arm(entry: Entry): void {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.expired = true;
      void stopEntry(entry);
    }, entry.timeoutMs);
    entry.timer.unref();
  }

  async function stopEntry(entry: Entry): Promise<void> {
    await entry.agentUp?.catch(noop);
    if (entry.runtime !== undefined && entry.agent !== undefined) await entry.runtime.stop(entry.agent).catch(noop);
  }

  function launch(handle: SandboxHandle, opts: StartDetachedOptions, resumeSessionId: string | undefined): StartDetachedResult {
    const entry = entryOf(handle);
    if (entry === undefined) throw new SandboxNotFoundError(handle.sandboxName);
    for (const rule of opts.networkPolicy) {
      if (rule.authHeader !== undefined || rule.authValue !== undefined || rule.purpose === "github_proxy") throw new HostSandboxRefused("network_rule_forbidden");
    }
    if (!sameEnv(opts.env, cleanEnv(config.credentials))) throw new HostSandboxRefused("env_not_clean");
    const workdir = opts.workdir;
    if (workdir === undefined || !path.isAbsolute(workdir)) throw new HostSandboxRefused("bad_workdir");
    if (entry.running) throw new HostSandboxRefused("sandbox_busy");

    const sandbox = sandboxSettings({
      workspace: workdir,
      tempDir: entry.tempDir,
      home: config.home,
      stateDir: config.stateDir,
      binaryDir: config.binaryDir,
      ...(config.registries === undefined ? {} : { registries: config.registries }),
      extraDomains: opts.networkPolicy.map((rule) => rule.host),
    });
    assertEnabledSandbox(sandbox);
    const runtime = config.makeRuntime(sandbox);
    let last: NormalizedEvent | undefined;
    const agentUp = (async () => {
      await opts.onSession?.(handle.sessionId ?? handle.sandboxName);
      try {
        await opts.onStage?.("sandbox_ready");
      } catch {
        // fx-swallow-ok: the stage callback is best effort and never fails a launch
      }
      const { role, roleCard, prompt, model, capUsd } = opts;
      const started = await runtime.start({
        runId: opts.runId, role, roleCard, prompt, model, workdir, capUsd,
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
    // The run ends when the agent's own `done` settles; a runtime that runs to completion inside `start` has none.
    // Its outcome is not dropped: a failed one (a credential mismatch, no init line, an unsupported flag) ends the run as that reason.
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
        if (entry.expired) throw new HostSandboxRefused("sandbox_timeout");
        return last;
      },
      (error: unknown) => {
        finish();
        // A run the wall clock stopped ends in a failed outcome of its own making; the timeout is the cause.
        if (entry.expired && error instanceof AgentRunFailed) throw new HostSandboxRefused("sandbox_timeout");
        throw error;
      },
    );
    const launched = agentUp.then(() => undefined);
    launched.catch(noop);
    return { handle, hookFired, launched };
  }

  return {
    async createSandbox(opts: CreateSandboxOptions): Promise<SandboxHandle> {
      let tempDir: string;
      try {
        tempDir = segmentUnder(config.tempRoot, opts.sandboxName);
      } catch (error) {
        if (error instanceof NotAPlainSegment) throw new HostSandboxRefused("bad_sandbox_name");
        throw error;
      }
      mkdirSync(tempDir, { recursive: true, mode: 0o700 });
      sandboxes.set(opts.sandboxName, { tempDir, timeoutMs: opts.timeoutMs, expired: false, running: false });
      return { runId: "", sandboxName: opts.sandboxName, sessionId: `host-${opts.sandboxName}` };
    },
    startDetached: (handle, opts) => launch(handle, opts, undefined),
    resume: (handle, sessionId, prompt, opts) => launch(handle, { ...opts, prompt }, sessionId),
    async extendTimeout(handle, additionalMs) {
      const entry = entryOf(handle);
      if (entry === undefined) return;
      entry.timeoutMs += additionalMs;
      if (entry.running) arm(entry);
    },
    async stop(handle) {
      const entry = entryOf(handle);
      if (entry !== undefined) await stopEntry(entry);
    },
    async deleteSandbox(handle) {
      const entry = entryOf(handle);
      if (entry === undefined) return;
      await stopEntry(entry);
      clearTimeout(entry.timer);
      sandboxes.delete(handle.sandboxName);
      rmSync(entry.tempDir, { recursive: true, force: true });
    },
    async measure() {
      return [];
    },
    async readCounters() {
      return undefined;
    },
    async sandboxExists(handle) {
      return sandboxes.has(handle.sandboxName);
    },
    async sandboxState(handle): Promise<SandboxComputeState> {
      const entry = entryOf(handle);
      return entry === undefined ? "gone" : entry.running ? "running" : "stopped";
    },
    timeoutMsOf: (handle) => entryOf(handle)?.timeoutMs,
  };
}
