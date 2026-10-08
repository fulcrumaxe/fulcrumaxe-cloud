import type { AgentHandle, NormalizedEvent, StartOptions } from "@fulcrumaxe/runner-protocol";

/**
 * A structural copy of the cloud's `SandboxPort` (the private `@fx/runner` package), kept here because this public
 * package may not import it. Its `test/sandboxPortContract.test.ts` (which imports the cloud runner as a dev dependency) assigns this type to the real one and
 * the real one to this, so `tsc` fails on drift in either direction. Fields this package never reads are typed loosely
 * (`unknown`, `string`); the copy follows the real port in names, optionality and arity.
 */
export interface SandboxHandle extends AgentHandle {
  sandboxName: string;
  sessionId?: string;
}

export interface CreateSandboxOptions {
  sandboxName: string;
  retention: { persistent: boolean; keepLastSnapshots?: number };
  timeoutMs: number;
  limits?: Partial<{ maxTurns: number; maxModelCalls: number; maxRunMs: number; meteringSilenceMs: number }>;
}

/** One allowed network host. A rule that carries a header to inject is never valid on this machine. */
export interface NetworkRule {
  host: string;
  purpose: string;
  authHeader?: string;
  readonly authValue?: string;
}

export interface StartDetachedOptions extends Omit<StartOptions, "onEvent" | "sandboxSpec"> {
  role: string;
  onSession?: (sessionId: string) => void | Promise<void>;
  onStage?: (stage: "sandbox_ready" | "cloned") => void | Promise<void>;
  clone?: { owner: string; name: string };
  networkPolicy: NetworkRule[];
  backend?: string;
  env: Record<string, string>;
  extension?: unknown;
  /** Read-only grants for this job, each checked again by the host sandbox's builder (git path B: one repo mirror's `objects` directory). */
  extraReadPaths?: readonly string[];
  limits?: Partial<{ maxTurns: number; maxModelCalls: number; maxRunMs: number; meteringSilenceMs: number }>;
  onEvent: (event: NormalizedEvent) => void | Promise<void>;
}

export interface StartDetachedResult {
  handle: AgentHandle;
  hookFired: Promise<NormalizedEvent | undefined>;
  launched?: Promise<void>;
}

export interface SandboxSessionUsage {
  sessionId: string;
  memoryMb?: number;
  region?: string;
  durationMs?: number;
  activeCpuMs?: number;
  egressBytes?: number;
}

export interface SandboxCounters {
  sessionId: string;
  cpuMs: number;
  txBytes: number;
  uptimeMs: number;
}

export type SandboxComputeState = "running" | "stopped" | "gone" | "unknown";

/** Thrown by `resume` when the named sandbox is gone. */
export class SandboxNotFoundError extends Error {
  constructor(public readonly sandboxName: string) {
    super(`sandbox not found: "${sandboxName}"`);
    this.name = "SandboxNotFoundError";
  }
}

export interface SandboxPort {
  createSandbox(opts: CreateSandboxOptions): Promise<SandboxHandle>;
  startDetached(handle: SandboxHandle, opts: StartDetachedOptions): StartDetachedResult;
  extendTimeout(handle: SandboxHandle, additionalMs: number): Promise<void>;
  stop(handle: SandboxHandle): Promise<void>;
  resume(handle: SandboxHandle, sessionId: string, prompt: string, opts: StartDetachedOptions): StartDetachedResult;
  deleteSandbox(handle: SandboxHandle, opts?: { deleteSnapshots?: boolean }): Promise<void>;
  measure(handle: SandboxHandle, sessionIds: readonly string[]): Promise<SandboxSessionUsage[]>;
  readCounters(handle: SandboxHandle): Promise<SandboxCounters | undefined>;
  sandboxExists(handle: SandboxHandle): Promise<boolean>;
  sandboxState?(handle: SandboxHandle): Promise<SandboxComputeState>;
}
