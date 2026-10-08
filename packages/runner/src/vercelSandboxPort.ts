import { randomUUID } from "node:crypto";
import { Sandbox } from "@vercel/sandbox";
import { reportError } from "@fx/telemetry";
import type { NetworkPolicy, NetworkPolicyRule as SdkNetworkPolicyRule } from "@vercel/sandbox";
import { GITHUB_FORWARDED_HOSTS, githubForwardUrlForHost, type NetworkPolicyRule } from "./networkPolicy.js";
import type { ModelId } from "@fx/spend";
import { CLONE_EXIT_TOO_LARGE, CLONE_OUTPUT_BUFFER_CHARS, CLONE_TIMEOUT_MS, CloneError, buildCloneCommand, redactedCloneTail } from "./repoClone.js";
import { isKnownStreamJsonType, isMalformedAssistant, normalizeMessage } from "@fx/runtime/src/streamJson.js";
import type { NormalizedEvent } from "./types.js";
import { assertSandboxEnvMatchesRole } from "./fakeSandbox.js";
import { RunLimitError, WARN_FRACTION, createRunGuard, resolveRunLimits, type RunLimits } from "./meteringGuard.js";
import type { RunLimit } from "./executionTarget.js";
import { tryExtend } from "./runLimitDecision.js";
import { CLAUDE_CLI_SHA256, CLAUDE_CLI_VERSION, SANDBOX_IMAGE_REF, resolveSandboxImage } from "./sandboxRuntime.js";
import { BACKENDS, CLAUDE_CODE_BACKEND } from "./backends.js";
import { PIN_CHECK_NAME, PIN_CHECK_SCRIPT, verifyPin, type BackendRegistry } from "@fx/runtime/src/backends/registry.js";
import type { AgentBackend } from "@fx/runtime/src/backends/types.js";

export { CLAUDE_CLI_VERSION, CLAUDE_CLI_SHA256 };
import {
  FX_AGENT_CONFIG_DIR,
  FX_AGENT_MCP_CONFIG,
  FX_AGENT_MCP_PATH,
  agentSettingsFor,
  FX_AGENT_SETTINGS_PATH,
  FX_LIMIT_HOOK_PATH,
  FX_LIMIT_HOOK_SCRIPT,
  FX_RUN_LIMITS_PATH,
  runLimitsFileContent,
  overlapsAgentConfigDir,
} from "./agentConfig.js";
import {
  SandboxBusyError,
  SandboxNotFoundError,
  type CreateSandboxOptions,
  type DeleteSandboxOptions,
  LISTABLE_PREFIXES,
  type ListSandboxesOptions,
  type SandboxListPage,
  type SandboxProviderStatus,
  SANDBOX_MAX_TIMEOUT_MS,
  SANDBOX_TIMEOUT_MARGIN_MS,
  SANDBOX_VCPUS,
  type SandboxHandle,
  type SandboxPort,
  type SandboxSessionUsage,
  type StartDetachedOptions,
  type StartDetachedResult,
} from "./sandboxPort.js";

/**
 * D#2 H14c-2 (C15-1..4): the real `SandboxPort`, backed by `@vercel/sandbox`.
 *
 * Credentials are constructor arguments only (C15-1/2/3). This file never
 * reads the process environment, and every SDK call below passes `teamId`,
 * `projectId` and a freshly fetched `token` explicitly, so the SDK's own
 * environment / OIDC fallback is never reached -- a BYO-team port and the
 * hosted port can live in one process without either landing on the
 * other's team.
 *
 * Nothing thrown from here carries an SDK message, a token, or the sandbox's
 * output: SDK failures are re-thrown as `SandboxPortError` naming only the
 * operation and the HTTP status.
 *
 * Every wait in here is bounded by `callTimeoutMs`: the token fetch, each SDK
 * HTTP call, `kill`, `wait`, and `stop`'s wait for an in-flight start. A
 * stuck provider, token source or log stream cannot hang a port method.
 *
 * The in-sandbox agent is Claude Code's own print mode
 * (`SANDBOX_AGENT_COMMAND`, C44 R1) reading the prompt from stdin. Its stdout
 * is raw `stream-json` and UNTRUSTED (anything inside the VM can write it).
 * Usage and completion are read ONLY from the stdout and exit of the one
 * command `runCommand` returned for the agent (D#2 C46 MP-SRC/MP-PIN): never
 * stderr, never a file in the VM, never the version check's command. It is
 * normalized HERE, outside the VM, by the mapper the local runtime
 * uses; `runId`, `role`, `seq` and `ts` are stamped by this file and never
 * read from a line. A line that is not a JSON object of a known `type` is
 * dropped and counted; an invalid usage or cost field is dropped from its
 * event, which is still delivered.
 *
 * Completion (C44 R3) rests on the command's EXIT as the Sandbox API reports
 * it, never on a stdout line: `hookFired` resolves only after the command
 * exited, with the LAST `result` before exit when the exit code was 0 and
 * that result was not an error, and otherwise with a runner-built `error`
 * event. No hook token or credential enters the sandbox: `opts.env` must be
 * `buildSandboxEnv(role)`.
 *
 * Limits (D#2 H14c-5b-2a, C46 MP-TURNS/MP-CLOCK/MP-SILENT, C48 LIMIT-END):
 * the runner's own clock ends the command at `maxRunMs`, after
 * `meteringSilenceMs` without a metered rise, and past `maxModelCalls`
 * distinct message ids; `hookFired` then rejects with `RunLimitError`. A final
 * `result` with the CLI's max-turns subtype counts as `turns` only when the
 * runner saw at least `maxTurns` distinct ids itself. The argv carries
 * `--max-turns` and `--max-budget-usd` as an in-VM belt only.
 *
 * Spend metering (D#2 H14c-5b-2b, C46/C59): one line can only raise the meter
 * by a bounded amount, the CLI's own cost figure is clamped at settle, and a
 * message is priced at the dearer of the run's and its claimed model. The
 * threat model, what is and is not guaranteed, and (B)'s design are in
 * docs/ops/spend-metering.md.
 *
 * RESIDUAL (C44 R5), named, not solved: code inside the VM with the agent's
 * privileges can still end the agent, print a final `result` carrying a
 * forged AGENT_OUTPUT, and exit 0. A run's verdict can be trusted exactly as
 * far as its sandbox can be trusted. The defences that do not rest on one
 * sandbox are the merge gate's independent reviewer runs (each in its own
 * sandbox), required CI read from GitHub, GitHub's branch protection on the
 * merge, and no hook token or GitHub/model credential inside the VM.
 *
 * Config (D#2 H14c-SS, C59): the agent loads only runner-written files (see
 * `agentConfig.ts` and docs/packages/runner.md), never the workspace's.
 */
export { FX_AGENT_CONFIG_DIR };

/**
 * Claude Code in print mode, the head of its command line. It now lives in the Claude Code backend descriptor
 * (`@fx/runtime`, D#221 R1a); this export is kept for the tests and tools that read it. `--model <model>` (and
 * `--resume <id>`) are appended by the descriptor.
 */
export const SANDBOX_AGENT_COMMAND: readonly string[] = CLAUDE_CODE_BACKEND.baseArgv;

/**
 * C55 §3 / C46 criterion 16: the CLI's `--model` name for each `@fx/spend`
 * price-table id. The price-table ids are not CLI names, so `launch` maps
 * through this table and refuses an id missing from it before any command.
 * `modelIdForCliName` is its inverse, used to price `message.model`.
 * PLACEHOLDER values: confirm against the pinned CLI in H18 (each must be
 * accepted as `--model` and reported back in `message.model`).
 */
export const CLI_MODEL_NAMES: Readonly<Record<ModelId, string>> = {
  "haiku-4.5": "claude-haiku-4-5",
  "sonnet-5": "claude-sonnet-5",
  "opus-5": "claude-opus-5",
};

/** The price-table id whose CLI name is `cliName`, else `undefined`. */
export function modelIdForCliName(cliName: string): ModelId | undefined {
  return (Object.keys(CLI_MODEL_NAMES) as ModelId[]).find((id) => CLI_MODEL_NAMES[id] === cliName);
}

/**
 * How the prompt reaches claude's stdin without being in any argv
 * (@vercel/sandbox 3.5.1's runCommand has no stdin): `sh -c WRAPPER name FILE
 * claude ...` opens FILE on fd 3, deletes it, then execs claude with fd 3 as
 * its stdin. The script is a constant; it contains no data.
 */
export const PROMPT_WRAPPER = 'f="$1"; shift; exec 3<"$f" || exit 97; rm -f -- "$f" || exit 97; exec "$@" <&3 3<&-';
const SAFE_ARG_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,199}$/;

/** Upper bound on any single SDK call, so no port method can hang. */
export const DEFAULT_SDK_CALL_TIMEOUT_MS = 30_000;

/** The pin check reads at most this much stdout (one version line); more than that fails the check, it is never truncated. */
const PIN_OUTPUT_CHARS = 1024;

/** A stdout line longer than this is dropped without being buffered. */
export const MAX_EVENT_LINE_CHARS = 1_048_576;

/** Sanity bounds for one event, far above any real value. */
const MAX_EVENT_TOKENS = 100_000_000;
const MAX_EVENT_COST_USD = 10_000;

export type InvalidEventReason = "not_json" | "oversize" | "shape" | "type" | "usage" | "cost";

/** `createSandbox` with a name that already exists in the target project. */
export class SandboxNameConflictError extends Error {
  constructor(public readonly sandboxName: string) {
    super(`sandbox name already exists: "${sandboxName}"`);
    this.name = "SandboxNameConflictError";
  }
}

/** Any other SDK failure. Carries the operation and status only. */
export class SandboxPortError extends Error {
  constructor(
    public readonly operation: string,
    public readonly status?: number,
  ) {
    super(`vercel sandbox ${operation} failed${status === undefined ? "" : ` (status ${status})`}`);
    this.name = "SandboxPortError";
  }
}

export interface VercelCredentials {
  teamId: string;
  projectId: string;
  token: string;
}

/** The slice of a `@vercel/sandbox` Sandbox the port uses. */
export interface SdkSandbox {
  readonly name: string;
  runCommand(params: {
    cmd: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    detached: true;
    signal?: AbortSignal;
  }): Promise<SdkCommand>;
  writeFiles(files: { path: string; content: string; mode?: number }[], opts?: { signal?: AbortSignal }): Promise<void>;
  updateNetworkPolicy(policy: NetworkPolicy, opts?: { signal?: AbortSignal }): Promise<unknown>;
  extendTimeout(durationMs: number, opts?: { signal?: AbortSignal }): Promise<void>;
  stop(opts?: { signal?: AbortSignal }): Promise<unknown>;
  /** `deleteOrphanSnapshots` is the SDK's own option (@vercel/sandbox 3.5.1, `Sandbox.delete`): also delete the snapshots no other sandbox uses. */
  delete(opts?: { deleteOrphanSnapshots?: boolean; signal?: AbortSignal }): Promise<void>;
  /** The current session's status ("running", "stopped", ...). */
  readonly status: string;
  /**
   * What the sandbox was created with, when the SDK reports it. Read only to decide whether a persistent sandbox found
   * under a taken name may be reused; a value that is not reported counts as a mismatch.
   */
  readonly persistent?: boolean;
  readonly image?: string;
  readonly vcpus?: number;
  readonly keepLastSnapshots?: { count?: number };
  /** The sandbox's own timeout in ms, when the SDK reports it (D#2 H14c-3-2d-2, R-UNK). */
  readonly timeout?: number;
  /**
   * The sandbox's current session. `getCommand` is on the SESSION, deliberately: the Sandbox's own `getCommand`
   * runs inside the SDK's auto-resume wrapper and can start a new, billable session on a stopped sandbox, the
   * session's does not (@vercel/sandbox 3.5.1, dist/session.js `getCommand` vs dist/sandbox.js `withResume`).
   * The real SDK always has it.
   */
  currentSession(): { readonly sessionId: string; getCommand?(cmdId: string, opts?: { signal?: AbortSignal }): Promise<SdkCommand> };
  listSessions(params?: { limit?: number; cursor?: string; sortOrder?: "asc" | "desc"; signal?: AbortSignal }): Promise<SdkSessionPage>;
}

/** The fields of a listed session the port reads (memory MB, duration ms, bytes; CPU and network only once stopped). */
export interface SdkSession {
  id: string;
  memory?: number;
  region?: string;
  duration?: number;
  activeCpuDurationMs?: number;
  networkTransfer?: { ingress: number; egress: number };
}

export interface SdkSessionPage {
  sessions: SdkSession[];
  pagination: { next: string | null };
}

export interface SdkCommand {
  /** The SDK command's id (always set by the real SDK); lets a kill re-find the command under fresh credentials. */
  readonly cmdId?: string;
  logs(): AsyncIterable<{ stream: string; data: unknown }>;
  wait(): Promise<{ exitCode: number }>;
  kill(): Promise<void>;
}

/** The fields of a listed sandbox the port reads; the real SDK's `Sandbox.list` result is assigned to this type, so an SDK change to any of them stops the build. */
export interface SdkListedSandbox {
  name: string;
  persistent: boolean;
  createdAt: number;
  updatedAt: number;
  status: SandboxProviderStatus;
}

export interface SdkSandboxListPage {
  sandboxes: SdkListedSandbox[];
  pagination: { next: string | null };
}

/** The `Sandbox.create` parameters the port sets. */
export interface SdkCreateParams extends VercelCredentials {
  name: string;
  /** The published image, `repository@sha256:digest`. The SDK's legacy `runtime` is never set: the managed runtimes carry no agent CLI. */
  image: string;
  timeout: number;
  persistent: boolean;
  /** Pinned, not an SDK default. The port opens no `ports`. */
  resources: { vcpus: number };
  tags: Record<string, string>;
  keepLastSnapshots?: { count: number };
  signal?: AbortSignal;
}

/** The static surface of the SDK's `Sandbox` class the port uses. Tests
 * pass a fake; the default is the real class. */
export interface VercelSandboxSdk {
  create(params: SdkCreateParams): Promise<SdkSandbox>;
  get(params: { name: string; resume?: boolean; signal?: AbortSignal; fetch?: typeof globalThis.fetch } & VercelCredentials): Promise<SdkSandbox>;
  /** One page of the project's sandboxes (`Sandbox.list`); optional so a test double that never lists needs no body. `fetch` is the SDK's own option and lets a test reach a local server. */
  list?(params: { namePrefix: string; cursor?: string; signal?: AbortSignal; fetch?: typeof globalThis.fetch } & VercelCredentials): Promise<SdkSandboxListPage>;
}

const realSdk: VercelSandboxSdk = {
  create: (params) => Sandbox.create({ ...params }),
  get: (params) => Sandbox.get({ ...params }),
  list: async (params) => {
    const page = await Sandbox.list({ ...params });
    return { sandboxes: page.sandboxes, pagination: { next: page.pagination.next } };
  },
};

export interface CreateVercelSandboxPortOptions {
  /** Test seam for the `fetch` the real SDK's `Sandbox.list` uses (a local server in the contract test); production leaves it unset. */
  fetch?: typeof globalThis.fetch;
  /**
   * The digest-pinned sandbox image. Defaults to the one in `infra/sandbox-image/versions.lock.json`. An unset or
   * unpinned value is refused (`SandboxImageConfigError`), never replaced by a runtime.
   */
  image?: string;
  teamId: string;
  projectId: string;
  /** Called before every SDK call: OIDC tokens rotate. */
  getToken: () => Promise<string>;
  /** Test seam; defaults to the real `@vercel/sandbox`. */
  sdk?: VercelSandboxSdk;
  /** The selectable backends (D#221 R1a). Defaults to the runner's own registry. */
  backends?: BackendRegistry;
  callTimeoutMs?: number;
  /** D#2 PREVIEW-RUNNER-EVENTS: how long a repository clone may take before it is killed. Default `CLONE_TIMEOUT_MS`. */
  cloneTimeoutMs?: number;
  /** Called once per dropped stdout line with a fixed reason code, never
   * the line itself (it is attacker-controlled). */
  onInvalidEvent?: (reason: InvalidEventReason) => void;
  /** Runner-side limits (C46 MP-TURNS/MP-CLOCK/MP-SILENT); omitted fields take
   * `DEFAULT_RUN_LIMITS`. H14c-3 wires per-role values. `maxRunMs` must be
   * below every sandbox `timeoutMs` this port creates. */
  limits?: Partial<RunLimits>;
  /** Pause between `measure`'s reads while a session's figures are not reported yet. Default 2 s. */
  measureRetryDelayMs?: number;
}

/**
 * CS-1b: the one read-only command `readCounters` runs inside the VM. It prints
 * `<uptime s> <cpu ms> <tx bytes>`: CPU from the root cgroup's usage_usec when present, else
 * user+nice+system+irq+softirq+steal jiffies from /proc/stat at CLK_TCK; tx_bytes summed over
 * every interface but `lo`. A constant; no data.
 */
export const COUNTERS_SCRIPT = [
  `up=$(awk '{print $1}' /proc/uptime) || exit 1`,
  `cpu=; if [ -r /sys/fs/cgroup/cpu.stat ]; then cpu=$(awk '$1=="usage_usec"{printf "%.0f", $2/1000}' /sys/fs/cgroup/cpu.stat); fi`,
  `if [ -z "$cpu" ]; then hz=$(getconf CLK_TCK) || exit 1; cpu=$(awk -v hz="$hz" '$1=="cpu"{printf "%.0f", ($2+$3+$4+$7+$8+$9)*1000/hz; exit}' /proc/stat); fi`,
  `tx=$(awk 'NR>2{sub(/:/," "); if ($1!="lo") s+=$10} END{printf "%.0f", s}' /proc/net/dev)`,
  `echo "$up $cpu $tx"`,
].join("\n");

/** The counters read must not hold up a stop for longer than this. */
export const COUNTERS_TIMEOUT_MS = 5_000;

/** `measure` reads the session list at most this many times within one call timeout. */
export const MEASURE_MAX_READS = 3;
/** The most sessions Vercel returns in one list call; a larger `limit` is rejected ("limit should be <= 50"). */
export const LIST_SESSIONS_MAX_LIMIT = 50;
/** Pages read per list (twice the old 20 pages of 100: the same 2000-session reach at the smaller page size). */
const MEASURE_MAX_PAGES = 40;

function figure(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** The usage record for a listed session; a figure the provider has not reported is left out. */
function usageOf(session: SdkSession): SandboxSessionUsage {
  const usage: SandboxSessionUsage = { sessionId: session.id };
  const memoryMb = figure(session.memory);
  const durationMs = figure(session.duration);
  const activeCpuMs = figure(session.activeCpuDurationMs);
  const egressBytes = figure(session.networkTransfer?.egress);
  if (memoryMb !== undefined) usage.memoryMb = memoryMb;
  if (typeof session.region === "string" && session.region !== "") usage.region = session.region;
  if (durationMs !== undefined) usage.durationMs = durationMs;
  if (activeCpuMs !== undefined) usage.activeCpuMs = activeCpuMs;
  if (egressBytes !== undefined) usage.egressBytes = egressBytes;
  return usage;
}

function isComplete(usage: SandboxSessionUsage): boolean {
  return (
    usage.memoryMb !== undefined &&
    usage.region !== undefined &&
    usage.durationMs !== undefined &&
    usage.activeCpuMs !== undefined &&
    usage.egressBytes !== undefined
  );
}

/**
 * The SDK egress policy for `rules`: an allowlist keyed by exact host, with the
 * tenant's key attached as a header transform on the model host ONLY (its rule
 * is the only one carrying `authValue`; every other host gets an empty rule
 * list). A model rule with no key is refused rather than allowed keyless.
 */
export function sdkNetworkPolicy(rules: readonly NetworkPolicyRule[]): NetworkPolicy {
  if (rules.length === 0) return "deny-all";
  const allow: Record<string, SdkNetworkPolicyRule[]> = {};
  // A host is allowed by exactly one rule. An environment rule for `github.com` or `api.github.com` (or a repeat of the
  // model host) must never replace the proxy forwarding or the key injection, so a clash refuses the whole policy,
  // whichever rule came first.
  const claim = (host: string): void => {
    if (Object.hasOwn(allow, host)) throw new Error("createVercelSandboxPort: two network rules name the same host");
  };
  for (const rule of rules) {
    if (rule.purpose === "github_proxy") {
      // SDK 3.5.1 network-policy.d.ts: `forwardURL` (HTTPS, no query or fragment, cannot carry headers or a
      // transform). With no `match` it applies to every request, so nothing reaches GitHub except through the
      // proxy. Vercel's forwarder adds `vercel-sandbox-oidc-token` (aud = this URL) and the `vercel-forwarded-*`
      // headers; the proxy host itself gets NO allow rule, only GitHub's two hosts, exact.
      const forwardURL = githubForwardUrlForHost(rule.host);
      for (const githubHost of GITHUB_FORWARDED_HOSTS) {
        claim(githubHost);
        allow[githubHost] = [{ forwardURL }];
      }
      continue;
    }
    claim(rule.host);
    if (rule.purpose !== "model") {
      allow[rule.host] = [];
      continue;
    }
    if (!rule.authHeader || !rule.authValue) throw new Error("createVercelSandboxPort: the model rule has no key to inject");
    allow[rule.host] = [{ transform: [{ headers: { [rule.authHeader]: rule.authValue } }] }];
  }
  return { allow };
}

const SANDBOX_NAME_RE = /^(ex|rn)-[A-Za-z0-9._-]{1,200}$/;

function statusOf(err: unknown): number | undefined {
  const status = (err as { response?: { status?: unknown } } | null)?.response?.status;
  return typeof status === "number" ? status : undefined;
}

function assertPositiveInt(value: number, what: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`createVercelSandboxPort: ${what} must be a positive integer, got ${String(value)}`);
  }
}

/**
 * Splits untrusted stdout chunks into lines while holding at most
 * `maxLineChars` of an unfinished line. A line that would exceed the cap is
 * dropped as soon as it is known to be too long, and everything up to its
 * newline is discarded unbuffered.
 */
export class LineAssembler {
  private buffer = "";
  private discarding = false;

  constructor(private readonly maxLineChars: number) {}

  get pendingLength(): number {
    return this.buffer.length;
  }

  push(chunk: string, onOversize: () => void): string[] {
    const lines: string[] = [];
    let rest = chunk;
    while (rest.length > 0) {
      const newline = rest.indexOf("\n");
      if (newline < 0) {
        if (this.discarding) return lines;
        if (this.buffer.length + rest.length > this.maxLineChars) {
          this.buffer = "";
          this.discarding = true;
          onOversize();
        } else {
          this.buffer += rest;
        }
        return lines;
      }
      const head = rest.slice(0, newline);
      rest = rest.slice(newline + 1);
      if (this.discarding) {
        this.discarding = false;
        continue;
      }
      if (this.buffer.length + head.length > this.maxLineChars) {
        this.buffer = "";
        onOversize();
        continue;
      }
      const line = (this.buffer + head).trim();
      this.buffer = "";
      if (line) lines.push(line);
    }
    return lines;
  }

  /** The stream ended: the unfinished line, if any and if not being discarded. */
  finish(): string[] {
    const line = this.discarding ? "" : this.buffer.trim();
    this.buffer = "";
    this.discarding = false;
    return line ? [line] : [];
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedInt(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

/**
 * Drops an invalid `usage` or `costUsd` from a normalized event (the event
 * itself stays, for display) so a forged negative / NaN / absurd figure can
 * never reach metering. Reports one reason per dropped field.
 */
function dropInvalidUsage(event: NormalizedEvent, report: (reason: InvalidEventReason) => void): NormalizedEvent {
  const { usage, costUsd } = event;
  if (usage !== undefined) {
    const fields = [usage.inputTokens, usage.outputTokens, usage.cacheWriteTokens, usage.cacheReadTokens, usage.reasoningTokens];
    if (!isPlainObject(usage) || !fields.every((v) => v === undefined || boundedInt(v, MAX_EVENT_TOKENS))) {
      delete event.usage;
      report("usage");
    }
  }
  if (costUsd !== undefined && !(typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd >= 0 && costUsd <= MAX_EVENT_COST_USD)) {
    delete event.costUsd;
    report("cost");
  }
  return event;
}

/** The SDK's `stop()` throws a bare `Error` (no HTTP status) when the
 * sandbox has no live session, i.e. it is already stopped. */
function isNoActiveSession(err: unknown): boolean {
  return err instanceof Error && statusOf(err) === undefined && err.message === "No active session to stop.";
}

export function createVercelSandboxPort(options: CreateVercelSandboxPortOptions): SandboxPort {
  const { teamId, projectId, getToken } = options ?? ({} as CreateVercelSandboxPortOptions);
  if (typeof teamId !== "string" || teamId.trim() === "") {
    throw new Error("createVercelSandboxPort: teamId is required");
  }
  if (typeof projectId !== "string" || projectId.trim() === "") {
    throw new Error("createVercelSandboxPort: projectId is required");
  }
  if (typeof getToken !== "function") {
    throw new Error("createVercelSandboxPort: getToken is required");
  }
  const sandboxImage = resolveSandboxImage("image" in options ? options.image : SANDBOX_IMAGE_REF);
  const sdk = options.sdk ?? realSdk;
  const backends = options.backends ?? BACKENDS;
  const callTimeoutMs = options.callTimeoutMs ?? DEFAULT_SDK_CALL_TIMEOUT_MS;
  const cloneTimeoutMs = options.cloneTimeoutMs ?? CLONE_TIMEOUT_MS;
  assertPositiveInt(cloneTimeoutMs, "cloneTimeoutMs");
  assertPositiveInt(callTimeoutMs, "callTimeoutMs");
  const measureRetryDelayMs = options.measureRetryDelayMs ?? 2_000;
  if (!Number.isSafeInteger(measureRetryDelayMs) || measureRetryDelayMs < 0) {
    throw new Error("createVercelSandboxPort: measureRetryDelayMs must be a non-negative integer");
  }
  /** The port-wide defaults. A launch resolves its own on top (D#2 H14c-3-2d-1, C56 s1). */
  const portLimits = resolveRunLimits(options.limits);
  /** Each sandbox's `timeoutMs` as created here; a launch is checked against it. */
  const sandboxTimeouts = new Map<string, number>();

  const reportInvalid = (reason: InvalidEventReason): void => {
    try {
      options.onInvalidEvent?.(reason);
    } catch (err) {
      // a counting hook must never break a run
      reportError(err, { stage: "run.invalid_event_hook" });
    }
  };

  /** Per-sandbox in-flight start / running command, so `stop` reaches a
   * start that has not finished at the provider yet. */
  interface Run {
    stopped: boolean;
    /** Resolves when `stop` marks the run stopped; ends a blocked log read. */
    stopSignal: Promise<void>;
    signalStop: () => void;
    started: Promise<void>;
    command?: SdkCommand;
    /** The session the command was started in (recorded at launch); a fresh-credential kill is only made against this one. */
    sessionId?: string;
  }
  const runs = new Map<string, Run>();

  /** Rejects with `SandboxPortError(operation)` if `work` outlives
   * `callTimeoutMs`. The abandoned work is left to settle on its own. */
  function bounded<T>(operation: string, work: Promise<T>, limitMs: number = callTimeoutMs): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new SandboxPortError(operation)), limitMs);
      timer.unref?.();
      work.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  /**
   * R-TOKEN-LIFETIME: the command object a launch holds carries the launch-time token, which may have rotated
   * (an OIDC token) by the time a limit, a stop or a failure needs to kill it. So a kill first re-opens the
   * sandbox with credentials fetched NOW and looks the command up there. It does that ONLY when the sandbox is
   * running and its current session is the one the command was started in, and looks the command up on the
   * session (no resume wrapper), so a kill can never wake a stopped sandbox into a new, unrecorded session.
   * In every other case (no `cmdId`, no session id, a stopped or different session, a failed lookup) it kills
   * through the captured command, which never resumes anything.
   */
  async function killQuietly(sandboxName: string, command: SdkCommand, sessionId: string | undefined): Promise<void> {
    await bounded(
      "kill",
      (async () => {
        const fresh = await freshCommand(sandboxName, command, sessionId).catch(() => undefined);
        await (fresh ?? command).kill();
      })(),
    ).catch(() => undefined);
  }

  async function freshCommand(sandboxName: string, command: SdkCommand, sessionId: string | undefined): Promise<SdkCommand | undefined> {
    if (command.cmdId === undefined || sessionId === undefined) return undefined;
    const creds = await credentials();
    const sandbox = await sdk.get({ name: sandboxName, resume: false, signal: signal(), ...creds });
    if (sandbox.name !== sandboxName || sandbox.status !== "running") return undefined;
    const session = sandbox.currentSession();
    if (session.sessionId !== sessionId || session.getCommand === undefined) return undefined;
    return session.getCommand(command.cmdId, { signal: signal() });
  }

  async function credentials(): Promise<VercelCredentials> {
    let token: unknown;
    try {
      token = await bounded("getToken", (async () => getToken())());
    } catch {
      throw new SandboxPortError("getToken");
    }
    if (typeof token !== "string" || token === "") throw new SandboxPortError("getToken");
    return { teamId, projectId, token };
  }

  const signal = () => AbortSignal.timeout(callTimeoutMs);
  /** Only a test sets one (a local server standing in for the provider's API); the real SDK uses its own `fetch` otherwise. */
  const fetchOption = options.fetch ? { fetch: options.fetch } : {};

  async function guarded<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof SandboxNotFoundError || err instanceof SandboxNameConflictError) throw err;
      if (err instanceof SandboxPortError) throw err;
      throw new SandboxPortError(operation, statusOf(err));
    }
  }

  function assertName(name: string): void {
    if (!SANDBOX_NAME_RE.test(name)) {
      throw new Error(`createVercelSandboxPort: sandboxName has an unexpected shape: ${JSON.stringify(name)}`);
    }
  }

  async function open(handle: SandboxHandle, operation: string, resume: boolean): Promise<SdkSandbox> {
    assertName(handle.sandboxName);
    const creds = await credentials();
    const sandbox = await guarded(operation, () =>
      sdk.get({ name: handle.sandboxName, resume, signal: signal(), ...creds, ...fetchOption }),
    );
    // Never act on a sandbox other than the one the handle names.
    if (sandbox.name !== handle.sandboxName) throw new SandboxPortError(operation);
    return sandbox;
  }

  /** Runs `fn` on the named sandbox, treating "already gone" as done. */
  async function tolerateGone(
    handle: SandboxHandle,
    operation: string,
    fn: (s: SdkSandbox) => Promise<unknown>,
  ): Promise<void> {
    try {
      const sandbox = await open(handle, operation, false);
      await guarded(operation, () => fn(sandbox));
    } catch (err) {
      if (err instanceof SandboxPortError && (err.status === 404 || err.status === 410 || err.status === 422)) return;
      throw err;
    }
  }

  /**
   * C44 R1 and D#221 R1a (C1 §2): before EVERY agent command, start and resume, one check command resolves the
   * backend's CLI, compares the SHA-256 of the resolved file with the pin IN THE SHELL, and only then runs it with
   * `--version` (see `PIN_CHECK_SCRIPT`). The digest verdict is the exit status (`cliDigest`), never parsed output; a
   * binary with the wrong digest is never executed. A wrong version fails as `cliVersion`. Output past the cap is a
   * failure, not a truncation. No `cwd` is passed, so nothing in the repo under test is on the path.
   */
  async function checkCliPin(sandbox: SdkSandbox, env: Record<string, string>, backend: AgentBackend): Promise<void> {
    const command = await guarded("runCommand", () =>
      sandbox.runCommand({ cmd: "sh", args: ["-c", PIN_CHECK_SCRIPT, PIN_CHECK_NAME, backend.cli, backend.cliSha256], env, detached: true, signal: signal() }),
    );
    let out = "";
    let overflowed = false;
    const exit = await bounded(
      "cliVersion",
      (async () => {
        for await (const entry of command.logs()) {
          if (entry.stream !== "stdout" || typeof entry.data !== "string") continue;
          if (out.length + entry.data.length > PIN_OUTPUT_CHARS) overflowed = true;
          else out += entry.data;
        }
        return command.wait();
      })(),
    ).catch(async () => {
      await killQuietly(sandbox.name, command, sandbox.currentSession().sessionId);
      return undefined;
    });
    const verdict = verifyPin(backend, exit?.exitCode, out, overflowed);
    if (verdict !== "ok") throw new SandboxPortError(verdict);
  }

  /**
   * D#2 PREVIEW-RUNNER-EVENTS: the shallow clone of a preview's repository into `workdir`, before the agent starts. The
   * command is built by `buildCloneCommand` (fixed script, values as arguments). Its output is drained and never kept.
   * Past the time bound it is killed. Throws `CloneError` with a fixed reason; the launch fails with it.
   */
  async function cloneRepository(sandbox: SdkSandbox, clone: { owner: string; name: string }, workdir: string, env: Record<string, string>): Promise<void> {
    const built = buildCloneCommand(clone, workdir);
    const command = await guarded("runCommand", () =>
      sandbox.runCommand({ cmd: built.cmd, args: built.args, env: { ...env, GIT_TERMINAL_PROMPT: "0" }, detached: true, signal: signal() }),
    );
    // Only the end of the output is held (bounded memory); it is read for the operator only if the clone fails.
    let held = "";
    let truncated = false;
    const exit = await bounded(
      "clone",
      (async () => {
        for await (const entry of command.logs()) {
          if (typeof entry.data !== "string") continue;
          held += entry.data;
          if (held.length > CLONE_OUTPUT_BUFFER_CHARS) {
            held = held.slice(-CLONE_OUTPUT_BUFFER_CHARS);
            truncated = true;
          }
        }
        return command.wait();
      })(),
      cloneTimeoutMs,
    ).catch(async () => {
      await killQuietly(sandbox.name, command, sandbox.currentSession().sessionId);
      return undefined;
    });
    if (exit?.exitCode === CLONE_EXIT_TOO_LARGE) throw new CloneError("clone_too_large");
    if (exit?.exitCode !== 0) {
      // Credential shapes are removed, and so are the env's own values (long ones only: a short value like "1" would shred the text).
      const tail = redactedCloneTail(held, truncated, Object.values(env).filter((v) => v.length >= 12));
      throw new CloneError("clone_failed", { exitCode: exit?.exitCode ?? null, tail });
    }
  }

  function launch(
    handle: SandboxHandle,
    opts: StartDetachedOptions,
    prompt: string,
    sessionId: string | undefined,
  ): StartDetachedResult {
    assertName(handle.sandboxName);
    // D#221 R1a: a backend that is not registered (with the hostile-config contract) is not selectable; nothing starts.
    const backend = backends.select(opts.backend);
    assertSandboxEnvMatchesRole(opts.role, opts.env);
    // This run's limits: the port's defaults under whatever the run carries. Invalid values throw here, before anything starts.
    // A run that carries limits (they come from a tenant's settings) is held to the platform bounds as well.
    const limits = resolveRunLimits({ ...portLimits, ...opts.limits }, { bounded: opts.limits !== undefined });
    // MP-CLOCK, per run: the runner's clock must fire before this sandbox's own timeout.
    const sandboxTimeoutMs = sandboxTimeouts.get(handle.sandboxName);
    if (sandboxTimeoutMs !== undefined && limits.maxRunMs >= sandboxTimeoutMs) {
      throw new Error("createVercelSandboxPort: the run's maxRunMs must be less than the sandbox timeoutMs");
    }
    if (opts.workdir !== undefined && overlapsAgentConfigDir(opts.workdir)) {
      throw new Error("createVercelSandboxPort: workdir must be outside the runner's agent config directory");
    }
    for (const arg of [opts.model, sessionId]) {
      if (arg !== undefined && !SAFE_ARG_RE.test(arg)) throw new Error("createVercelSandboxPort: model or sessionId has an unexpected shape");
    }
    const cliModel = Object.hasOwn(CLI_MODEL_NAMES, opts.model) ? CLI_MODEL_NAMES[opts.model as ModelId] : undefined;
    if (cliModel === undefined) throw new Error("createVercelSandboxPort: model has no CLI model name");
    const resuming = sessionId !== undefined;
    if (!Number.isFinite(opts.capUsd) || opts.capUsd <= 0) throw new Error("createVercelSandboxPort: capUsd must be a positive number");
    // The in-VM belt (C46 F5/MP-TURNS): the runner's own limits are what hold.
    const agentArgv = backend.buildArgv({ cliModel, maxTurns: limits.maxTurns, capUsd: opts.capUsd, ...(sessionId !== undefined && { resumeSessionId: sessionId }) });
    let signalStop!: () => void;
    const stopSignal = new Promise<void>((resolve) => {
      signalStop = resolve;
    });
    const run: Run = { stopped: false, stopSignal, signalStop, started: Promise.resolve() };
    runs.set(handle.sandboxName, run);
    // Settles once the agent command exists, or fails with the launch (see `StartDetachedResult.launched`).
    let markLaunched!: () => void;
    let failLaunch!: (err: unknown) => void;
    const launched = new Promise<void>((resolve, reject) => {
      markLaunched = resolve;
      failLaunch = reject;
    });
    launched.catch(() => undefined); // the caller awaits it; `hookFired` carries the same failure

    const hookFired = (async (): Promise<NormalizedEvent | undefined> => {
      const sandbox = await open(handle, resuming ? "resume" : "startDetached", resuming).catch((err: unknown) => {
        // Resuming a sandbox the platform no longer has is the one case
        // H09b's fallback keys on.
        if (resuming && err instanceof SandboxPortError && (err.status === 404 || err.status === 410)) {
          throw new SandboxNotFoundError(handle.sandboxName);
        }
        throw err;
      });
      if (run.stopped) return undefined;
      // R-UNK: a sandbox this port instance did not create (a restart) has no recorded timeout; ask the SDK.
      // Failing that, fail closed: no extension (an extension is a longer run than the sandbox is known to allow),
      // and no run longer than the port's own default.
      let knownTimeoutMs = sandboxTimeouts.get(handle.sandboxName);
      const sdkTimeoutMs = sandbox.timeout;
      if (knownTimeoutMs === undefined && sdkTimeoutMs !== undefined && Number.isSafeInteger(sdkTimeoutMs) && sdkTimeoutMs > 0) {
        knownTimeoutMs = sdkTimeoutMs;
        sandboxTimeouts.set(handle.sandboxName, sdkTimeoutMs);
      }
      if (knownTimeoutMs !== undefined ? limits.maxRunMs >= knownTimeoutMs : limits.maxRunMs > portLimits.maxRunMs) {
        throw new Error("createVercelSandboxPort: the run's maxRunMs must be less than the sandbox timeoutMs");
      }
      // CS-1: report this run's session before any command starts; fail closed, since an unnamed one would be a hole in its measured cost.
      const runSessionId = sandbox.currentSession().sessionId;
      if (typeof runSessionId !== "string" || runSessionId === "") throw new SandboxPortError(resuming ? "resume" : "startDetached");
      run.sessionId = runSessionId;
      await opts.onSession?.(runSessionId);
      if (run.stopped) return undefined;
      // Egress is the SDK 3.5.1 `NetworkPolicy` shape (H14c-3-1, CARRY-12).
      const policy = sdkNetworkPolicy(opts.networkPolicy);
      await guarded("updateNetworkPolicy", () => sandbox.updateNetworkPolicy(policy, { signal: signal() }));
      if (run.stopped) return undefined;
      await checkCliPin(sandbox, opts.env, backend);
      if (run.stopped) return undefined;
      // The prompt (role card first) goes to a 0600 file the wrapper opens
      // and deletes before claude starts; it is in no argv.
      const promptFile = `/tmp/fx-prompt-${randomUUID()}`;
      const startedMs = Date.now();
      // What the warnings say, computed by the runner (the hook has no clock).
      let timeWarningMinutes: number | undefined;
      let modelCallsRemaining: number | undefined;
      // X-4: the limits in force; an extension raises them (`applied`).
      let inForceLimits: RunLimits = limits;
      const inForce = (): RunLimits => inForceLimits;
      const limitsFile = (): string =>
        runLimitsFileContent({ startedMs, deadlineMs: startedMs + inForce().maxRunMs, maxModelCalls: inForce().maxModelCalls, timeWarningMinutes, modelCallsRemaining });
      // Mid-run rewrites are best effort and serialized, so an older body never lands after a newer one.
      let rewriting: Promise<unknown> = Promise.resolve();
      const rewriteLimits = (): void => {
        rewriting = rewriting
          .then(() => sandbox.writeFiles([{ path: FX_RUN_LIMITS_PATH, content: limitsFile(), mode: 0o444 }], { signal: signal() }))
          .catch(() => undefined);
      };
      await guarded("writeFiles", () =>
        sandbox.writeFiles(
          [
            { path: promptFile, content: `${opts.roleCard}\n\n${prompt}`, mode: 0o600 },
            // Rewritten before EVERY agent command (start and resume): an
            // earlier command runs as the same uid and may have edited them.
            { path: FX_AGENT_SETTINGS_PATH, content: JSON.stringify(agentSettingsFor(opts.role)), mode: 0o444 },
            { path: FX_AGENT_MCP_PATH, content: JSON.stringify(FX_AGENT_MCP_CONFIG), mode: 0o444 },
            // C66: the runner's one hook, and the deadline it warns from (W-1).
            { path: FX_LIMIT_HOOK_PATH, content: FX_LIMIT_HOOK_SCRIPT, mode: 0o444 },
            { path: FX_RUN_LIMITS_PATH, content: limitsFile(), mode: 0o444 },
          ],
          { signal: signal() },
        ),
      );
      // D#2 PREVIEW-RUNNER-EVENTS: the sandbox is up, locked down and loaded; the agent command is next. Best effort:
      // a progress mark that fails to record never fails the launch.
      const mark = async (stage: "sandbox_ready" | "cloned"): Promise<void> => {
        try {
          await opts.onStage?.(stage);
        } catch {
          // fx-swallow-ok: a progress mark is best effort; the launch never depends on it
        }
      };
      await mark("sandbox_ready");
      if (opts.clone !== undefined && !resuming) {
        if (opts.workdir === undefined) throw new Error("createVercelSandboxPort: a clone needs a workdir");
        await cloneRepository(sandbox, opts.clone, opts.workdir, opts.env);
        if (run.stopped) return undefined;
        await mark("cloned");
      }
      const command = await guarded("runCommand", () =>
        sandbox.runCommand({
          cmd: "sh",
          args: ["-c", PROMPT_WRAPPER, "fx-agent", promptFile, ...agentArgv],
          cwd: opts.workdir,
          env: opts.env,
          detached: true,
          signal: signal(),
        }),
      );
      run.command = command;
      markLaunched();
      if (run.stopped) {
        await killQuietly(handle.sandboxName, command, runSessionId);
        return undefined;
      }

      const assembler = new LineAssembler(MAX_EVENT_LINE_CHARS);
      let seq = 0;
      let oversize = false;
      /** The event for the LAST raw `result` message; completion is decided
       * from it only after the command has exited. */
      let lastResult: NormalizedEvent | undefined;
      /** The `subtype` of that raw `result` line; read for nothing else. */
      let lastResultSubtype: unknown;
      /** The first limit the runner's own guard reached (MP-CLOCK/SILENT/TURNS). */
      let limitHit: RunLimit | undefined;
      let callsWarned = false;
      let wakeLoop!: () => void;
      const limitSignal = new Promise<void>((resolve) => {
        wakeLoop = resolve;
      });
      // X-1..X-4: only the runner's own guard reaches an extension, when `run_time` or
      // `model_calls` is hit; an agent's checkpoint envelope never comes through here.
      const extPolicy = knownTimeoutMs === undefined ? undefined : opts.extension;
      let used = 0;
      let ghAtLast = 0;
      let idsAtLast = 0;
      /** The decision `decide` reached, held until the guard applies it. */
      let grant: { d: Extract<Awaited<ReturnType<typeof tryExtend>>, { extend: true }>; ghWrites: number; messageIds: number } | undefined;
      const extension = extPolicy && {
        decisionTimeoutMs: extPolicy.decisionTimeoutMs,
        async decide(limit: RunLimit): Promise<number | undefined> {
          const facts = {
            kind: limit.kind,
            nowMs: Date.now(),
            startedMs,
            lastUsageRiseMs: guard.lastRiseAt(),
            silenceMs: limits.meteringSilenceMs,
            extensionsUsed: used,
            maxExtensions: extPolicy.maxExtensions,
            ghWrites: extPolicy.ghWrites(),
            ghWritesAtLastExtension: ghAtLast,
            // Fail closed: a policy that does not say is a writing role, so ids alone never count as progress.
            roleWrites: extPolicy.roleWrites !== false,
            messageIds: guard.modelCalls(),
            messageIdsAtLastExtension: idsAtLast,
            resolvedLimit: limit.kind === "run_time" ? limits.maxRunMs : limits.maxModelCalls,
            currentLimit: limit.limit,
            meteredUsd: extPolicy.meteredUsd(),
            ceilings: extPolicy.ceilings,
          };
          const d = await tryExtend(facts, extPolicy.reserveExtension);
          if (!d.extend) return undefined;
          // Apply first, record only if applied: nothing is counted or written until the guard
          // takes the new limit (`applied`). A reservation E4 admitted for an extension that never
          // took effect (the run ended meanwhile) is not released here; it settles with the run.
          grant = { d, ghWrites: facts.ghWrites, messageIds: facts.messageIds };
          return d.newLimit;
        },
        applied(limit: RunLimit) {
          if (grant) {
            const g = grant;
            grant = undefined;
            used += 1;
            ghAtLast = g.ghWrites;
            idsAtLast = g.messageIds;
            // Best effort, like every mid-run write: the extension stands even if the event row does not land.
            try {
              void Promise.resolve(extPolicy.onExtended({ kind: g.d.kind, extensionsUsed: used, newLimit: g.d.newLimit, progress: g.d.progress })).catch(() => undefined);
            } catch (err) {
              // a throwing recorder does not undo the extension
              reportError(err, { stage: "run.extension_record" });
            }
          }
          inForceLimits = guard.current();
          // The window changed: warn again from the new one, and rewrite the file (new deadline / calls).
          if (limit.kind === "run_time") {
            timeWarningMinutes = undefined;
            armTimeWarning();
          } else {
            callsWarned = false;
            modelCallsRemaining = undefined;
          }
          rewriteLimits();
        },
      };
      const guard = createRunGuard(
        limits,
        (limit) => {
          limitHit = limit;
          void killQuietly(handle.sandboxName, command, runSessionId);
          wakeLoop();
        },
        extension,
      );
      const deliver = async (line: string): Promise<void> => {
        if (run.stopped || limitHit !== undefined) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          // fx-swallow-ok: a stream line that is not JSON is an expected answer, counted by reportInvalid and never echoed
          reportInvalid("not_json");
          return;
        }
        if (!isPlainObject(parsed)) return reportInvalid("shape");
        if (!isKnownStreamJsonType(parsed)) return reportInvalid("type");
        // An assistant line with a malformed body, or usage it cannot key by
        // message id, is dropped and counted; it never reaches the meter.
        if (isMalformedAssistant(parsed)) return reportInvalid("shape");
        const event = dropInvalidUsage(normalizeMessage({ ...opts, backend: backend.name }, parsed, seq++, opts.workdir), reportInvalid);
        if (parsed.type === "result") {
          lastResult = event;
          lastResultSubtype = parsed.subtype;
        }
        await opts.onEvent(event);
        guard.observe(event);
        // W-2: once, at 80% of the call limit, tell the agent how many remain.
        // Advisory and best effort: the runner's own count is what enforces.
        if (!callsWarned && guard.modelCalls() >= WARN_FRACTION * inForce().maxModelCalls) {
          callsWarned = true;
          modelCallsRemaining = Math.max(inForce().maxModelCalls - guard.modelCalls(), 0);
          rewriteLimits();
        }
      };

      guard.start();
      // W-1: when the runner's own clock passes 80% of the window, say how many minutes remain.
      let timeWarning: ReturnType<typeof setTimeout> | undefined;
      const armTimeWarning = (): void => {
        clearTimeout(timeWarning);
        timeWarning = setTimeout(
          () => {
            timeWarningMinutes = Math.max(Math.ceil((startedMs + inForce().maxRunMs - Date.now()) / 60_000), 0);
            rewriteLimits();
          },
          Math.max(WARN_FRACTION * inForce().maxRunMs - (Date.now() - startedMs), 0),
        );
        timeWarning.unref?.();
      };
      armTimeWarning();
      try {
        const iterator = command.logs()[Symbol.asyncIterator]();
        try {
          while (!run.stopped && limitHit === undefined) {
            const pending = iterator.next();
            pending.catch(() => undefined); // if the stop wins the race, this read is abandoned
            const next = await Promise.race([
              pending,
              run.stopSignal.then(() => "stopped" as const),
              limitSignal.then(() => "stopped" as const),
            ]);
            if (next === "stopped" || next.done) break;
            const entry = next.value;
            if (entry.stream !== "stdout" || typeof entry.data !== "string") continue;
            const lines = assembler.push(entry.data, () => {
              oversize = true;
              reportInvalid("oversize");
            });
            // An over-long line ends the run (EV-CAP), not just that line.
            if (oversize) throw new SandboxPortError("stdout line cap");
            for (const line of lines) {
              await deliver(line);
              if (limitHit !== undefined) break;
            }
          }
          for (const line of assembler.finish()) await deliver(line);
        } finally {
          guard.stop();
          try {
            opts.onModelCalls?.(guard.modelCalls());
          } catch {
            // fx-swallow-ok: the only observer adds to a counter and cannot throw; if it ever did, the count stays a floor and the run ends as it would have
          }
          clearTimeout(timeWarning);
          // Not awaited: on a stream blocked mid-read the close would wait
          // for the read that never finishes.
          void Promise.resolve()
            .then(() => iterator.return?.())
            .catch(() => undefined);
        }
      } catch (err) {
        // `onEvent` throwing is the sanctioned way to abort (see
        // `StartDetachedResult.hookFired`): stop the command, pass it on.
        await killQuietly(handle.sandboxName, command, runSessionId);
        throw err;
      }
      if (run.stopped) return undefined;
      // The runner's own limit ended the command: report it, never "failed".
      if (limitHit !== undefined) throw new RunLimitError(limitHit);
      const finished = await guarded("wait", () => bounded("wait", (async () => command.wait())()));
      // The CLI ran out of turns (its own count): resumable only if the
      // runner's own distinct message-id count agrees, so a forged line
      // cannot turn a failure into a resumable end.
      const turns = guard.turnsLimit(lastResultSubtype);
      if (turns !== undefined) throw new RunLimitError(turns, lastResult?.costUsd);
      // Succeeded = exit 0 AND the last result was not an error. Anything
      // else is a failure event built here, carrying only what that last
      // result reported (if any).
      if (finished.exitCode === 0 && lastResult?.type === "result") return lastResult;
      return {
        runId: opts.runId,
        role: opts.role,
        seq: seq++,
        type: "error",
        ts: new Date().toISOString(),
        backend: backend.name,
        isError: true,
        sessionId: lastResult?.sessionId,
        usage: lastResult?.usage,
        costUsd: lastResult?.costUsd,
        agentOutput: lastResult?.agentOutput,
      };
    })().finally(() => {
      if (runs.get(handle.sandboxName) === run) runs.delete(handle.sandboxName);
    });

    run.started = hookFired.then(
      () => undefined,
      () => undefined,
    );
    // A launch that ended without a command (stopped early, or failed) settles `launched` the same way `hookFired` did.
    hookFired.then(markLaunched, failLaunch);
    return { handle, hookFired, launched };
  }

  function handleOfCreated(opts: CreateSandboxOptions, created: SdkSandbox): SandboxHandle {
    if (created.name !== opts.sandboxName) throw new SandboxPortError("createSandbox");
    sandboxTimeouts.set(opts.sandboxName, opts.timeoutMs);
    const sessionId = created.currentSession().sessionId;
    return {
      runId: "",
      sandboxName: opts.sandboxName,
      ...(typeof sessionId === "string" && sessionId !== "" && { sessionId }),
    };
  }

  /**
   * A fresh executor build whose persistent name already exists (the first build's sandbox, kept so fix rounds can
   * resume it). Three outcomes, decided from what the provider says about it, never from this process's memory:
   *  - not stopped (running, starting, stopping, snapshotting): another session owns it. `SandboxBusyError`; nothing
   *    is touched, so the other session is never stopped, resumed or deleted from here.
   *  - stopped and created with exactly what this run would create (persistent, the pinned image, the pinned vCPUs,
   *    the same timeout and snapshot retention): woken with a new session and reused. The agent launch applies the
   *    network policy, the CLI version check and the clean checkout to it as it does to a new sandbox.
   *  - stopped but any of those differs, or the SDK did not report it: deleted and created again with this run's
   *    settings. A stale image or setting must never run an agent; the cost is the old snapshot, which a fresh build
   *    does not use (it starts from a clean checkout).
   */
  /** Whether a sandbox with this name exists (a state read that never resumes). Any failure of the look reads as "no". */
  async function nameExists(name: string, creds: VercelCredentials): Promise<boolean> {
    try {
      const found = await sdk.get({ name, resume: false, signal: signal(), ...creds });
      return found.name === name;
    } catch {
      return false; // fx-swallow-ok: the caller keeps the create's own error
    }
  }

  async function reusePersistent(opts: CreateSandboxOptions, params: SdkCreateParams, creds: VercelCredentials): Promise<SandboxHandle> {
    const name = opts.sandboxName;
    let existing: SdkSandbox;
    try {
      existing = await sdk.get({ name, resume: false, signal: signal(), ...creds });
    } catch (err) {
      // Gone between the create and the look (deleted by a close): same answer as the conflict it was.
      if (statusOf(err) === 404 || statusOf(err) === 410) throw new SandboxNameConflictError(name);
      throw new SandboxPortError("createSandbox", statusOf(err));
    }
    if (existing.name !== name) throw new SandboxPortError("createSandbox");
    if (existing.status !== "stopped" && existing.status !== "failed" && existing.status !== "aborted") throw new SandboxBusyError(name);
    const wantedSnapshots = params.keepLastSnapshots?.count;
    const matches =
      existing.persistent === true &&
      existing.image === params.image &&
      existing.vcpus === params.resources.vcpus &&
      existing.timeout === params.timeout &&
      (wantedSnapshots === undefined || existing.keepLastSnapshots?.count === wantedSnapshots);
    const recreate = async (from: SdkSandbox): Promise<SandboxHandle> => {
      await guarded("createSandbox", () => from.delete({ signal: signal() }));
      sandboxTimeouts.delete(name);
      let recreated: SdkSandbox;
      try {
        recreated = await sdk.create(params);
      } catch (err) {
        if (statusOf(err) === 409) throw new SandboxNameConflictError(name);
        throw new SandboxPortError("createSandbox", statusOf(err));
      }
      return handleOfCreated(opts, recreated);
    };
    if (!matches) return recreate(existing);
    let woken: SdkSandbox;
    try {
      woken = await sdk.get({ name, resume: true, signal: signal(), ...creds });
    } catch (err) {
      // A stopped sandbox that cannot be woken (its snapshot was deleted or expired) is replaced with a fresh one: the
      // kept state is only a cache. It is looked at again first, so one that another build woke meanwhile is never deleted.
      console.warn(JSON.stringify({ event: "sandbox.wake_failed", status: statusOf(err) ?? null }));
      let again: SdkSandbox;
      try {
        again = await sdk.get({ name, resume: false, signal: signal(), ...creds });
      } catch (lookErr) {
        if (statusOf(lookErr) === 404 || statusOf(lookErr) === 410) throw new SandboxNameConflictError(name);
        throw new SandboxPortError("createSandbox", statusOf(lookErr));
      }
      if (again.status !== "stopped" && again.status !== "failed" && again.status !== "aborted") throw new SandboxBusyError(name);
      return recreate(again);
    }
    // Reused only if it is now a running session of its own (any other status means someone else got there).
    if (woken.status !== "running") throw new SandboxBusyError(name);
    return handleOfCreated(opts, woken);
  }

  return {
    async createSandbox(opts: CreateSandboxOptions): Promise<SandboxHandle> {
      assertName(opts.sandboxName);
      assertPositiveInt(opts.timeoutMs, "timeoutMs");
      // Defence in depth behind the seat's own check: never ask Vercel for more than the plan allows.
      if (opts.timeoutMs > SANDBOX_MAX_TIMEOUT_MS) throw new Error("createVercelSandboxPort: timeoutMs exceeds the plan's maximum sandbox timeout");
      // MP-CLOCK: the runner's clock must fire before the sandbox's own timeout. The run's own limits decide
      // (R-CT), with the margin the seat adds; a sandbox made without them is checked against the port's defaults.
      const runLimits = resolveRunLimits({ ...portLimits, ...opts.limits }, { bounded: opts.limits !== undefined });
      if (opts.limits === undefined ? runLimits.maxRunMs >= opts.timeoutMs : runLimits.maxRunMs + SANDBOX_TIMEOUT_MARGIN_MS > opts.timeoutMs) {
        throw new Error("createVercelSandboxPort: maxRunMs must be less than the sandbox timeoutMs");
      }
      const creds = await credentials();
      const params: SdkCreateParams = {
        name: opts.sandboxName,
        image: sandboxImage,
        timeout: opts.timeoutMs,
        persistent: opts.retention.persistent,
        resources: { vcpus: SANDBOX_VCPUS },
        tags: { "fx-sandbox": opts.sandboxName },
        signal: signal(),
        ...creds,
      };
      if (opts.retention.persistent && opts.retention.keepLastSnapshots !== undefined) {
        params.keepLastSnapshots = { count: opts.retention.keepLastSnapshots };
      }
      let created: SdkSandbox;
      try {
        created = await sdk.create(params);
      } catch (err) {
        // The SDK retries a 5xx on this non-idempotent POST, so a retry can
        // answer 409 for a sandbox our first attempt already created. A name
        // that is not persistent is reported as the same conflict (fail
        // closed), never attached to. A persistent (executor) name is the one
        // case that is reused: see `reusePersistent`.
        // The provider answers a name that is already taken with 400 bad_request (checked live on staging, 2026-10-04),
        // not 409; a 400 is read as a conflict only when a look shows the name really exists.
        if (statusOf(err) === 409 || (statusOf(err) === 400 && (await nameExists(opts.sandboxName, creds)))) {
          if (!opts.retention.persistent) throw new SandboxNameConflictError(opts.sandboxName);
          return reusePersistent(opts, params, creds);
        }
        // The provider's own error code (a short fixed identifier, never its message) says why the create was refused.
        const raw = (err as { json?: { error?: { code?: unknown } } } | null)?.json?.error?.code;
        const code = typeof raw === "string" && /^[a-z0-9_.-]{1,64}$/i.test(raw) ? raw : null;
        console.warn(JSON.stringify({ event: "sandbox.create_failed", status: statusOf(err) ?? null, code, persistent: opts.retention.persistent }));
        throw new SandboxPortError("createSandbox", statusOf(err));
      }
      return handleOfCreated(opts, created);
    },

    startDetached(handle, opts) {
      return launch(handle, opts, opts.prompt, undefined);
    },

    async extendTimeout(handle, additionalMs) {
      assertPositiveInt(additionalMs, "additionalMs");
      const sandbox = await open(handle, "extendTimeout", false);
      await guarded("extendTimeout", () => sandbox.extendTimeout(additionalMs, { signal: signal() }));
    },

    async stop(handle) {
      // Mark the in-flight start (if any) stopped, try to kill its command,
      // and give it at most `callTimeoutMs` to notice. Whatever happens
      // there -- a failing kill, a log stream that never ends, an `onEvent`
      // that never returns -- the provider stop below is always reached,
      // and it is what actually ends the VM.
      const run = runs.get(handle.sandboxName);
      if (run) {
        run.stopped = true;
        run.signalStop();
        await bounded(
          "stop",
          (async () => {
            if (run.command) await killQuietly(handle.sandboxName, run.command, run.sessionId);
            await run.started;
          })(),
        ).catch(() => undefined);
      }
      await tolerateGone(handle, "stop", async (s) => {
        try {
          await s.stop({ signal: signal() });
        } catch (err) {
          if (isNoActiveSession(err)) return; // already stopped
          throw err;
        }
      });
    },

    resume(handle, sessionId, prompt, opts) {
      return launch(handle, opts, prompt, sessionId);
    },

    async deleteSandbox(handle, opts?: DeleteSandboxOptions) {
      await tolerateGone(handle, "deleteSandbox", (s) => s.delete({ ...(opts?.deleteSnapshots === true && { deleteOrphanSnapshots: true }), signal: signal() }));
      runs.delete(handle.sandboxName);
      sandboxTimeouts.delete(handle.sandboxName);
    },

    async readCounters(handle) {
      const held: { command?: SdkCommand; sessionId?: string } = {};
      try {
        return await bounded(
          "counters",
          (async () => {
            const sandbox = await open(handle, "counters", false);
            // Never wake a stopped sandbox: the SDK would start a new, unrecorded session to run this.
            if (sandbox.status !== "running") return undefined;
            const sessionId = sandbox.currentSession().sessionId;
            held.sessionId = sessionId;
            held.command = await sandbox.runCommand({ cmd: "sh", args: ["-c", COUNTERS_SCRIPT], detached: true, signal: AbortSignal.timeout(COUNTERS_TIMEOUT_MS) });
            let out = "";
            for await (const entry of held.command.logs()) {
              if (entry.stream === "stdout" && typeof entry.data === "string" && out.length < 256) out += entry.data;
            }
            if ((await held.command.wait()).exitCode !== 0) return undefined;
            const [up, cpu, tx, ...rest] = out.trim().split(/\s+/).map(Number);
            if (rest.length > 0 || ![up, cpu, tx].every((n) => n !== undefined && Number.isFinite(n) && n >= 0)) return undefined;
            return { sessionId, cpuMs: cpu!, txBytes: tx!, uptimeMs: Math.round(up! * 1000) };
          })(),
          Math.min(COUNTERS_TIMEOUT_MS, callTimeoutMs),
        );
      } catch (err) {
        reportError(err, { stage: "sandbox.counters" });
        if (held.command) await killQuietly(handle.sandboxName, held.command, held.sessionId);
        return undefined;
      }
    },

    async sandboxState(handle) {
      try {
        const sandbox = await open(handle, "sandboxState", false);
        // The SDK's session statuses; anything else (a stop in progress, a snapshot) is "unknown" and looked at again later.
        if (sandbox.status === "running" || sandbox.status === "pending") return "running";
        if (sandbox.status === "stopped" || sandbox.status === "failed" || sandbox.status === "aborted") return "stopped";
        return "unknown";
      } catch (err) {
        // fx-swallow-ok: the provider's failure is the answer ("gone" for a definite 404/410, "unknown" for any doubt); callers act on neither doubt nor a read error
        return err instanceof SandboxPortError && (err.status === 404 || err.status === 410) ? "gone" : "unknown";
      }
    },

    async listSandboxes(opts: ListSandboxesOptions): Promise<SandboxListPage> {
      // Checked before any request: only our own two prefixes are ever asked for, so a caller cannot enumerate the project.
      if (!LISTABLE_PREFIXES.includes(opts?.prefix)) throw new Error(`createVercelSandboxPort: listSandboxes accepts only ${LISTABLE_PREFIXES.map((p) => JSON.stringify(p)).join(" and ")}`);
      if (sdk.list === undefined) throw new SandboxPortError("listSandboxes");
      const creds = await credentials();
      const list = sdk.list.bind(sdk);
      const page = await guarded("listSandboxes", () => bounded("listSandboxes", list({ namePrefix: opts.prefix, ...(opts.cursor !== undefined && { cursor: opts.cursor }), signal: signal(), ...creds, ...fetchOption })));
      // The SDK filters by prefix on the server; a name that does not start with it is dropped rather than trusted.
      return {
        sandboxes: page.sandboxes.filter((s) => s.name.startsWith(opts.prefix)).map(({ name, persistent, status, createdAt, updatedAt }) => ({ name, persistent, status, createdAt, updatedAt })),
        next: page.pagination.next ?? null,
      };
    },

    async sandboxExists(handle) {
      try {
        await open(handle, "sandboxExists", false);
        return true;
      } catch (err) {
        // Only a definite "not found" is "gone"; every other failure (timeout, 5xx, bad answer) counts as "exists".
        const gone = err instanceof SandboxPortError && (err.status === 404 || err.status === 410);
        if (!gone) reportError(err, { stage: "sandbox.exists" });
        return !gone;
      }
    },

    async measure(handle, sessionIds) {
      const wanted = new Set(sessionIds);
      if (wanted.size === 0) return [];
      const sandbox = await open(handle, "measure", false);
      // One deadline for the whole call: at most MEASURE_MAX_READS reads inside it.
      return bounded(
        "measure",
        (async () => {
          let found = new Map<string, SandboxSessionUsage>();
          for (let read = 0; read < MEASURE_MAX_READS; read++) {
            if (read > 0) await new Promise<void>((resolve) => setTimeout(resolve, measureRetryDelayMs).unref?.());
            found = await guarded("measure", async () => {
              const seen = new Map<string, SandboxSessionUsage>();
              let cursor: string | undefined;
              for (let page = 0; page < MEASURE_MAX_PAGES; page++) {
                const result = await sandbox.listSessions({ limit: LIST_SESSIONS_MAX_LIMIT, sortOrder: "desc", signal: signal(), ...(cursor !== undefined && { cursor }) });
                for (const session of result.sessions) if (wanted.has(session.id)) seen.set(session.id, usageOf(session));
                cursor = result.pagination.next ?? undefined;
                if (seen.size === wanted.size || cursor === undefined) break;
              }
              return seen;
            });
            if (found.size === wanted.size && [...found.values()].every(isComplete)) break;
          }
          return [...found.values()];
        })(),
      );
    },
  };
}
