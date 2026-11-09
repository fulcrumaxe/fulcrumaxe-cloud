import { createHash, randomUUID } from "node:crypto";
import { Sandbox } from "@vercel/sandbox";
import { reportError } from "@fx/telemetry";
import type { NetworkPolicy, NetworkPolicyRule as SdkNetworkPolicyRule } from "@vercel/sandbox";
import { GITHUB_FORWARDED_HOSTS, githubForwardUrlForHost, type NetworkPolicyRule } from "./networkPolicy.js";
import { contextWindowTokensFor, type ModelId } from "@fx/spend";
import { CLI_MODEL_NAMES, CONTEXT_WARN_PCT, ContextLedgerCapture, endsWithEnvelopeBlock, extractAgentOutputEnvelope, contextPct, contextSpillWrites, modelIdForCliName } from "@fulcrumaxe/runner-protocol";
import {
  DETECT_NONE,
  DETECT_NPM,
  DETECT_PNPM,
  DETECT_SCRIPT,
  DETECT_SKIP,
  INSTALL_OUTPUT_BUFFER_CHARS,
  INSTALL_SCRIPT,
  INSTALL_TAIL_MAX_CHARS,
  INSTALL_TIMEOUT_MS,
  depsPromptLine,
  installEnv,
  type DepsOutcome,
} from "./depsInstall.js";
import { CLONE_EXIT_TOO_LARGE, CLONE_OUTPUT_BUFFER_CHARS, CLONE_TIMEOUT_MS, CloneError, buildCloneCommand, redactedCloneTail, type CloneTarget } from "./repoClone.js";
import { isKnownStreamJsonType, isMalformedAssistant, normalizeMessage } from "@fx/runtime/src/streamJson.js";
import type { AgentHandle, NormalizedEvent } from "./types.js";
import { assertSandboxEnvMatchesRole } from "./fakeSandbox.js";
import { RUN_COMMAND_MAX_OUTPUT_CHARS, assertNoAgentInPublishSandbox, assertRunCommandOptions, assertWriteFiles, vcpusForCreate } from "./runCommand.js";
import { RunLimitError, WARN_FRACTION, createRunGuard, resolveRunLimits, type RunLimits } from "./meteringGuard.js";
import type { RunLimit } from "./executionTarget.js";
import { tryExtend } from "./runLimitDecision.js";
import { RECORD_READ_CAP, acceptRecords, evaluateRead, isTampered, nextHeadStreak, readArgv, trailerMatchesWait, type AcceptedRecord, type ReadFault, type ReadOutcome, type Trailer } from "./recordParser.js";
import { createSideEffects, mergeSideEffects, recordExtension, tailStateBytes, TAIL_STATE_MAX_BYTES, type LastResultState, type PortReaderState } from "./readerState.js";
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
  disabledToolsFor,
  toolsForRole,
  FX_AGENT_SETTINGS_PATH,
  FX_LIMIT_HOOK_PATH,
  FX_LIMIT_HOOK_SCRIPT,
  FX_RECORDER_PATH,
  FX_RECORDER_SCRIPT,
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
  type SandboxHandle,
  type ReaderFlag,
  type ReadSliceOptions,
  SliceAttachError,
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
 * stderr, never a file in the VM, never the version check's command. (The
 * run-log reader changes this, from RLR-3b on: the source is the recorder's
 * framed, contiguous record file (read by `readRecords`, judged only by
 * `recordParser.ts`), cross-checked at exit against the recorder command's own
 * stdout (`crossCheckEcho`, metering the larger of the two). The agent command
 * itself gets no log subscriber before it has exited; the new invariant is
 * written out in docs/ops/spend-metering.md.) It is
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
 * C55 §3 / C46 criterion 16: the CLI's `--model` name for each `@fx/spend` price-table id. The price-table ids are not CLI
 * names, so `launch` maps through this table and refuses an id missing from it before any command. `modelIdForCliName` is its
 * inverse, used to price `message.model`. The table lives in `@fulcrumaxe/runner-protocol` (`cliModels.ts`), shared with the
 * local runner; it is re-exported here for the callers and tests that read it from the port. Each value was confirmed against the
 * installed CLI on 2026-10-09: accepted as `--model`, and reported back in `message.model`.
 */
export { CLI_MODEL_NAMES, modelIdForCliName };

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

/** The provider's error codes are short fixed identifiers; anything else is not kept (it could carry text). */
const PROVIDER_CODE_RE = /^[a-z0-9_.-]{1,64}$/i;

/** The code when it is a short fixed identifier, else null. */
export function providerCodeOf(raw: unknown): string | null {
  return typeof raw === "string" && PROVIDER_CODE_RE.test(raw) ? raw : null;
}

/** Any other SDK failure. Carries the operation, the status and, when the provider named one, its short error code (never its message). */
export class SandboxPortError extends Error {
  /** The provider's own error code, only when it matches the fixed-identifier pattern; otherwise undefined. */
  public readonly code?: string;
  constructor(
    public readonly operation: string,
    public readonly status?: number,
    code?: string | null,
  ) {
    super(`vercel sandbox ${operation} failed${status === undefined ? "" : ` (status ${status})`}`);
    this.name = "SandboxPortError";
    const ok = providerCodeOf(code);
    if (ok !== null) this.code = ok;
  }
}

/** A sandbox create without a network policy. Thrown before any SDK call: no sandbox exists, so nothing is left to clean up. */
export class SandboxPolicyRequiredError extends Error {
  constructor() {
    super("createVercelSandboxPort: a sandbox is never created without its network policy");
    this.name = "SandboxPolicyRequiredError";
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
  logs(opts?: { signal?: AbortSignal }): AsyncIterable<{ stream: string; data: unknown }>;
  /** The real `wait` takes `{ signal }` and rejects with the signal's reason when it aborts first (@vercel/sandbox 3.5.1, command.js). */
  wait(params?: { signal?: AbortSignal }): Promise<{ exitCode: number }>;
  /** The real `kill` takes the signal to send, SIGTERM by default (@vercel/sandbox 3.5.1, command.js). */
  kill(signal?: "SIGTERM" | "SIGKILL"): Promise<void>;
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
  /** The SDK's create-time egress policy (`BaseCreateSandboxParams.networkPolicy`, 3.5.1). Always set: the platform default is allow-all. */
  networkPolicy: NetworkPolicy;
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
  /** D#6 C44-6b: how long the dependency install may run before it is killed and counted as failed. Default `INSTALL_TIMEOUT_MS`. */
  installTimeoutMs?: number;
  /** Called once per dropped stdout line with a fixed reason code, never
   * the line itself (it is attacker-controlled). */
  onInvalidEvent?: (reason: InvalidEventReason) => void;
  /** Runner-side limits (C46 MP-TURNS/MP-CLOCK/MP-SILENT); omitted fields take
   * `DEFAULT_RUN_LIMITS`. H14c-3 wires per-role values. `maxRunMs` must be
   * below every sandbox `timeoutMs` this port creates. */
  limits?: Partial<RunLimits>;
  /** Pause between `measure`'s reads while a session's figures are not reported yet. Default 2 s. */
  measureRetryDelayMs?: number;
  /** D#2 RLR-3b: the run-log reader's waits (tests shorten them). Defaults: `PROBE_EXIT_MS`, `TRAILER_WAIT_MS`, `ECHO_REPLAY_TIMEOUT_MS`, `EXIT_WAIT_MS`. */
  reader?: { probeMs?: number; trailerWaitMs?: number; echoTimeoutMs?: number; exitWaitMs?: number };
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
    // D#221 OM-2: the report tag rides next to the key, outside the VM; only an ai_gateway model rule carries one.
    allow[rule.host] = [{ transform: [{ headers: { [rule.authHeader]: rule.authValue, ...(rule.reportTag && { "ai-reporting-tags": rule.reportTag }) } }] }];
  }
  return { allow };
}

const SANDBOX_NAME_RE = /^(ex|rn|pp)-[A-Za-z0-9._-]{1,200}$/;

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

/** Rejects with `SandboxPortError(operation)` if `work` outlives `limitMs`. The abandoned work is left to settle on its own. */
function boundedBy<T>(operation: string, work: Promise<T>, limitMs: number): Promise<T> {
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

/** Runs an SDK call; whatever it throws becomes a `SandboxPortError` naming the operation and the HTTP status only. */
async function guardedCall<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SandboxNotFoundError || err instanceof SandboxNameConflictError) throw err;
    if (err instanceof SandboxPortError) throw err;
    throw new SandboxPortError(operation, statusOf(err));
  }
}

// ---- D#2 RLR-3b: the run-log reader's port functions (design Round 3 B1-B4, the RLR-0c conditions, the 2026-11-09 amendments) -------------------
//
// The agent command is the recorder (`FX_RECORDER_SCRIPT`), which frames the CLI's stdout lines into a file and echoes the same
// records to its own stdout. NOTHING subscribes to that command's logs() until it has exited: every read is a NEW short command with
// one subscriber held to its end, and the echo is replayed once, after exit, as the cross-check. These functions take the SDK
// objects as arguments so the strict fake in the tests can drive each of them on its own.

/** Where a run's record file lives. The recorder creates it with O_EXCL, so each run (each fix round is one) needs its own path. */
export const RUN_RECORD_DIR = "/fx/run";
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export function recordPathFor(runId: string): string {
  if (!RUN_ID_RE.test(runId)) throw new Error("createVercelSandboxPort: runId has an unexpected shape");
  return `${RUN_RECORD_DIR}/${runId}.rec`;
}

/** How long a probe waits for the command to exit before reading it as "still running". */
export const PROBE_EXIT_MS = 1_500;
/** A trailer counts only if `wait()` resolves within this long of it (RLR-0c condition 6); a trailer on a running command is a forgery. */
export const TRAILER_WAIT_MS = 5_000;
/** After a kill the reader waits at most this long for the command to exit before it replays the echo (RLR-0c condition 8). */
export const EXIT_WAIT_MS = 8_000;
/** The exit replay of the recorder's echo is bounded; 50 MB replayed in about 2 s in the spike. */
export const ECHO_REPLAY_TIMEOUT_MS = 120_000;
/** Reads that fail in a row, with the command still running, before the reader gives up (`reader_unavailable`). */
export const READ_FAILURE_LIMIT = 3;
/** After the command has exited the reader asks for what is left at most this many times. */
export const DRAIN_READS = 4;
/** What a read's stdout may hold beyond its cap: the 0xff byte, `@` and up to 15 digits. */
const READ_SUFFIX_ROOM = 32;

/**
 * The recorder script and the directory its file goes in: written with the settings files before EVERY agent command (an earlier command runs
 * as the same uid and may have edited them). `/fx/run/.keep` makes the directory exist: the recorder does not create it, and exits 98 without it.
 */
export function agentRecorderFiles(): Array<{ path: string; content: string; mode: number }> {
  return [
    { path: FX_RECORDER_PATH, content: FX_RECORDER_SCRIPT, mode: 0o444 },
    { path: `${RUN_RECORD_DIR}/.keep`, content: "", mode: 0o444 },
  ];
}

/** The agent command's argv: the prompt wrapper (fd 3), then the recorder, then the CLI. */
export function agentCommandArgs(p: { promptFile: string; runId: string; agentArgv: readonly string[] }): string[] {
  return ["-c", PROMPT_WRAPPER, "fx-agent", p.promptFile, "node", FX_RECORDER_PATH, recordPathFor(p.runId), p.runId, "--", ...p.agentArgv];
}

/** B1: starts the agent command under the recorder. It returns the command and attaches NO `logs()` subscriber, ever; the reads use their own commands. */
export async function startAgentCommand(
  sandbox: SdkSandbox,
  p: { promptFile: string; runId: string; agentArgv: readonly string[]; cwd?: string; env: Record<string, string>; timeoutMs: number },
): Promise<SdkCommand> {
  const args = agentCommandArgs(p);
  return guardedCall("runCommand", () => sandbox.runCommand({ cmd: "sh", args, cwd: p.cwd, env: p.env, detached: true, signal: AbortSignal.timeout(p.timeoutMs) }));
}

/**
 * The vendor hands a log's data over as a string, decoding the bytes as UTF-8. Records and the echo are ASCII, so every ASCII character is its byte
 * and anything else is damage, mapped to 0x80 (which the parser refuses as non-ASCII, so it can never pass for data).
 */
export function logBytes(text: string): Buffer {
  const out = Buffer.allocUnsafe(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    out[i] = c < 0x80 ? c : 0x80;
  }
  return out;
}

/**
 * A read's whole output as bytes. The read script ends with a 0xff byte and `@<size>`; the vendor's UTF-8 decoding turns that one invalid byte into
 * U+FFFD. Only a U+FFFD that is directly followed by `@<digits>` to the end of the text is turned back into 0xff. Any other non-ASCII character,
 * including any other U+FFFD, is damage and stays 0x80. The offsets the parser returns are counted on these bytes (one per character), never on the string.
 * A suffix that is split, altered or missing leaves no 0xff, which `evaluateRead` reports as a failed read.
 */
export function readBytes(text: string): Buffer {
  const m = /\ufffd(@\d{1,15})$/.exec(text);
  if (!m) return logBytes(text);
  return Buffer.concat([logBytes(text.slice(0, m.index)), Buffer.from([0xff]), Buffer.from(m[1]!, "latin1")]);
}

/** A slice commits at least this often while it works (the lease lasts 60 s). */
export const SLICE_CHECKPOINT_MS = 10_000;
/** While the exit sequence runs (no save is due, and it can take minutes) the lease is renewed this often, a third of its lifetime. */
export const SLICE_RENEW_MS = 20_000;
/** The most reads the exit makes to read the record file again (8 MiB each; the file is held to 200 MiB). */
const REBUILD_MAX_READS = 64;
/** The digest of a record whose file side cannot be trusted: it equals no echo record's. */
const UNTRUSTED_DIGEST = Buffer.alloc(8);

/** What a sliced reader's promise carries when the slice ended and the run did not: the time came, or the lease was lost. */
type SliceEnd = { readonly sliceEnd: "slice" | "lost" };

const failedRead = (fault: ReadFault): ReadOutcome => ({ records: [], run: null, bytes: 0, stop: null, trailer: null, size: null, fault, headViolation: false });

/**
 * B2: one read. A NEW command with fixed argv, ONE `logs()` subscriber held to its end, then `wait()` with exit code 0 required, then the bytes judged by
 * `evaluateRead` (the one parser). A read that could not be made (no command, a timeout, a non-zero exit, a lost stream) is the fault `read_failed`;
 * the caller counts them. This function does not throw.
 */
export async function readRecords(
  sandbox: Pick<SdkSandbox, "runCommand">,
  p: { recordPath: string; offset: number; nextSeq: number; cap?: number; timeoutMs: number; abandon?: (command: SdkCommand) => Promise<void> },
): Promise<ReadOutcome> {
  const cap = p.cap ?? RECORD_READ_CAP;
  let command: SdkCommand | undefined;
  try {
    return await boundedBy(
      "readRecords",
      (async (): Promise<ReadOutcome> => {
        command = await guardedCall("runCommand", () => sandbox.runCommand({ cmd: "sh", args: readArgv(p.offset, p.recordPath, cap), detached: true, signal: AbortSignal.timeout(p.timeoutMs) }));
        const chunks: string[] = [];
        let total = 0;
        for await (const entry of command.logs()) {
          if (entry.stream !== "stdout" || typeof entry.data !== "string") continue;
          total += entry.data.length;
          if (total > cap + READ_SUFFIX_ROOM) return failedRead("read_exceeds_cap"); // bounds memory whatever the stream sends
          chunks.push(entry.data);
        }
        const done = await command.wait();
        if (done.exitCode !== 0) return failedRead("read_failed");
        return evaluateRead(readBytes(chunks.join("")), { offset: p.offset, nextSeq: p.nextSeq, cap });
      })(),
      p.timeoutMs,
    );
  } catch {
    // fx-swallow-ok: a read that could not be made is the answer (`read_failed`); the caller counts consecutive ones and the run ends on the third
    if (command) await (p.abandon ?? ((c) => c.kill()))(command).catch(() => undefined);
    return failedRead("read_failed");
  }
}

export type ExitProbe = { exited: true; exitCode: number } | { exited: false };
const isAbortReason = (err: unknown): boolean => err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");

/**
 * B4 step 1: has the command exited? `wait()` with a signal that aborts after `withinMs`. An aborted wait (`AbortError`, or `TimeoutError`, the name
 * `AbortSignal.timeout` gives its reason) means the command is still running. `getCommand().exitCode` is never used: it stays null until a wait completes.
 */
export async function probeExit(command: SdkCommand, withinMs: number = PROBE_EXIT_MS): Promise<ExitProbe> {
  try {
    const done = await command.wait({ signal: AbortSignal.timeout(withinMs) });
    if (!Number.isInteger(done.exitCode) || done.exitCode < 0 || done.exitCode > 255) throw new SandboxPortError("wait");
    return { exited: true, exitCode: done.exitCode };
  } catch (err) {
    if (isAbortReason(err)) return { exited: false };
    if (err instanceof SandboxPortError) throw err;
    throw new SandboxPortError("wait", statusOf(err));
  }
}

const digestOf = (r: AcceptedRecord): Buffer => createHash("sha256").update(`${r.seq}:${r.kind}:${r.n}:`).update(r.data).digest().subarray(0, 8);

/** What was accepted from the file: the count, a running hash, and one 8-byte digest per record (so a differing echo record can be found). */
export class RecordLedger {
  /** Records represented, the `from` ones included. */
  count: number;
  /** How many leading records this ledger holds no digest for (an earlier slice consumed them), and the chain it saved over them. */
  readonly base: number;
  readonly savedChain: string;
  private chain: Buffer;
  private digests = Buffer.alloc(8 * 1024);
  /**
   * `from` (RLR-4): a ledger that continues one an earlier slice saved as its count and chain. It has no digest for those first records (`at` gives
   * undefined for them) and is `partial` until the whole file has been read again.
   */
  constructor(from?: { count: number; chain: string }) {
    this.base = from?.count ?? 0;
    this.count = this.base;
    this.savedChain = from?.chain ?? "";
    this.chain = from ? Buffer.from(from.chain, "hex") : Buffer.alloc(32);
  }
  add(r: AcceptedRecord): void {
    this.addDigest(digestOf(r));
  }
  addDigest(d: Buffer): void {
    const at = (this.count - this.base) * 8;
    if (at + 8 > this.digests.length) {
      const grown = Buffer.alloc(this.digests.length * 2);
      this.digests.copy(grown);
      this.digests = grown;
    }
    d.copy(this.digests, at);
    this.count++;
    this.chain = createHash("sha256").update(this.chain).update(d).digest();
  }
  at(i: number): Buffer | undefined {
    return i >= this.base && i < this.count ? this.digests.subarray((i - this.base) * 8, (i - this.base) * 8 + 8) : undefined;
  }
  /** The chain over every digest so far: each step hashes the previous value with the next digest, so a saved (count, chain) can be continued or re-derived. */
  hash(): string {
    return this.chain.toString("hex");
  }
  get partial(): boolean {
    return this.base > 0;
  }
  state(): { count: number; chain: string } {
    return { count: this.count, chain: this.hash() };
  }
}

export interface EchoCheck {
  /** The echo could not be read (a failed or timed-out replay); the other fields are then only what was seen before it failed. */
  unavailable: boolean;
  /** The echo and the file differ: a record, the count, the hash or the trailer. */
  mismatch: boolean;
  /** The echo held a valid header record. A command that started recording has at least that. */
  hasHeader: boolean;
  /** The echo's trailer, when it has a valid one. */
  trailer: Trailer | null;
  count: number;
}

const sameTrailer = (a: Trailer | null, b: Trailer | null): boolean =>
  a === null || b === null ? a === b : a.code === b.code && a.sig === b.sig && a.lines === b.lines && a.bytes === b.bytes && a.seq === b.seq;

/**
 * B4 step 3 (RLR-0c condition 7): the one post-exit `logs()` replay of the recorder command's echo, the first subscriber it ever had, so the
 * store is whole. It is parsed by the same acceptance rule, as it streams. Each record is compared with the file's by seq; one the file lacks
 * or has differently (`o`, `tail`, `big`) goes to `onEchoOnly`, so the caller meters `max(file, echo)` and can only raise the bill. The count, the
 * hash and the trailer are compared as well. An error thrown by `onEchoOnly` (a spend kill) is the caller's own and propagates.
 * With `upToSeq`, only a record at or below that seq goes to `onEchoOnly`: after a kill the reader hands over what the file lacked of the part it had consumed
 * and nothing past it.
 */
export async function crossCheckEcho(
  command: SdkCommand,
  file: { ledger: RecordLedger; trailer: Trailer | null },
  o: { timeoutMs?: number; onEchoOnly: (r: AcceptedRecord) => Promise<void>; upToSeq?: number },
): Promise<EchoCheck> {
  const echo = new RecordLedger();
  let trailer: Trailer | null = null;
  let hasHeader = false;
  let mismatch = false;
  let pending: Buffer = Buffer.alloc(0);
  /** Set while an over-long partial line is being dropped: its bytes are skipped up to the next newline. */
  let skipping = false;
  let over = false;
  let callerError: { err: unknown } | undefined;
  /**
   * One complete line. It is judged by the parser on its own, under the seq it claims, so a line the rule refuses is skipped and the lines after it are
   * still read (the meter keeps the maximum per message id, so no order has to be protected). A record the file does not have as the echo does, at
   * the seq it claims, goes to `onEchoOnly` whether or not it is the next one in the echo's own chain: a record that repeats a seq is metered as well.
   */
  const take = async (line: Buffer): Promise<void> => {
    let claimed: unknown;
    try {
      claimed = (JSON.parse(line.toString("latin1")) as { s?: unknown } | null)?.s;
    } catch {
      // fx-swallow-ok: a line that is not JSON is a line the echo should not have; it is skipped and the echo counts as differing
    }
    const seq = typeof claimed === "number" && Number.isSafeInteger(claimed) && claimed >= 0 ? claimed : undefined;
    const acc = seq === undefined ? undefined : acceptRecords(Buffer.concat([line, Buffer.from("\n")]), seq);
    const r = acc?.records[0];
    if (!r || acc?.stop !== null) {
      mismatch = true;
      return;
    }
    hasHeader ||= r.kind === "h";
    if (r.kind === "x" && acc?.trailer) {
      if (trailer !== null && !sameTrailer(trailer, acc.trailer)) mismatch = true;
      trailer ??= acc.trailer;
    }
    if (!digestOf(r).equals(file.ledger.at(r.seq) ?? Buffer.alloc(0))) {
      mismatch = true;
      if ((r.kind === "o" || r.kind === "tail" || r.kind === "big") && (o.upToSeq === undefined || r.seq <= o.upToSeq)) {
        try {
          await o.onEchoOnly(r);
        } catch (err) {
          callerError = { err };
          throw err;
        }
      }
    }
    if (r.seq === echo.count) echo.add(r);
    else mismatch = true; // out of order, repeated or a gap: not the recorder's own echo
  };
  try {
    await boundedBy(
      "crossCheckEcho",
      (async () => {
        for await (const entry of command.logs()) {
          if (over) return; // the replay was given up on: nothing more is metered from it
          if (entry.stream !== "stdout" || typeof entry.data !== "string") continue;
          let chunk = logBytes(entry.data);
          if (skipping) {
            const nl = chunk.indexOf(0x0a);
            if (nl < 0) continue;
            chunk = chunk.subarray(nl + 1);
            skipping = false;
          }
          pending = Buffer.concat([pending, chunk]);
          let from = 0;
          for (let nl = pending.indexOf(0x0a, from); nl >= 0; nl = pending.indexOf(0x0a, from)) {
            const line = pending.subarray(from, nl);
            from = nl + 1;
            if (line.length > RECORD_READ_CAP) mismatch = true;
            else if (line.length > 0) await take(line);
          }
          pending = pending.subarray(from);
          // A partial line longer than any record can be is dropped up to its newline, and the lines after it are still read.
          if (pending.length > RECORD_READ_CAP) {
            pending = Buffer.alloc(0);
            skipping = true;
            mismatch = true;
          }
        }
        if (pending.length > 0) mismatch = true; // an unterminated last line is not a record
      })(),
      o.timeoutMs ?? ECHO_REPLAY_TIMEOUT_MS,
    );
  } catch (err) {
    over = true;
    if (callerError) throw callerError.err;
    reportError(err, { stage: "run.echo_replay" });
    return { unavailable: true, mismatch, hasHeader, trailer, count: echo.count };
  }
  if (echo.count !== file.ledger.count || echo.hash() !== file.ledger.hash() || !sameTrailer(trailer, file.trailer)) mismatch = true;
  return { unavailable: false, mismatch, hasHeader, trailer, count: echo.count };
}

/** The token each opened sandbox object carries (a rotated token is not on an object opened before the rotation). */
const sandboxTokens = new WeakMap<SdkSandbox, string>();

/** The opening marker of a verdict envelope; any message holding one, parsed or not, decides the fallback. */
const ENVELOPE_MARKER = /<!--\s*AGENT_OUTPUT\s*-->/;

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
  const installTimeoutMs = options.installTimeoutMs ?? INSTALL_TIMEOUT_MS;
  assertPositiveInt(installTimeoutMs, "installTimeoutMs");
  assertPositiveInt(callTimeoutMs, "callTimeoutMs");
  const measureRetryDelayMs = options.measureRetryDelayMs ?? 2_000;
  if (!Number.isSafeInteger(measureRetryDelayMs) || measureRetryDelayMs < 0) {
    throw new Error("createVercelSandboxPort: measureRetryDelayMs must be a non-negative integer");
  }
  // Every wait in here is bounded by `callTimeoutMs`, so the reader's two waits default to no more than it.
  const probeMs = options.reader?.probeMs ?? Math.min(PROBE_EXIT_MS, callTimeoutMs);
  const trailerWaitMs = options.reader?.trailerWaitMs ?? Math.min(TRAILER_WAIT_MS, callTimeoutMs);
  const echoTimeoutMs = options.reader?.echoTimeoutMs ?? ECHO_REPLAY_TIMEOUT_MS;
  assertPositiveInt(probeMs, "reader.probeMs");
  assertPositiveInt(trailerWaitMs, "reader.trailerWaitMs");
  assertPositiveInt(echoTimeoutMs, "reader.echoTimeoutMs");
  const exitWaitMs = options.reader?.exitWaitMs ?? Math.min(EXIT_WAIT_MS, callTimeoutMs);
  assertPositiveInt(exitWaitMs, "reader.exitWaitMs");
  /** The port-wide defaults. A launch resolves its own on top (D#2 H14c-3-2d-1, C56 s1). */
  const portLimits = resolveRunLimits(options.limits);
  /** Each sandbox's `timeoutMs` as created here; a launch is checked against it. */
  const sandboxTimeouts = new Map<string, number>();
  /**
   * A digest of the policy each sandbox is known to carry (set at create, or after a confirmed update). A policy that is already in
   * force is not applied again: an update is a window the sandbox is not guaranteed to be enforcing in. A failed update clears the
   * entry, so the next apply really runs. A digest, not the policy: it holds the tenant's key.
   */
  const appliedPolicy = new Map<string, string>();
  const policyDigest = (policy: NetworkPolicy): string => createHash("sha256").update(JSON.stringify(policy)).digest("hex");
  async function applyPolicy(sandbox: SdkSandbox, policy: NetworkPolicy, always = false): Promise<void> {
    const digest = policyDigest(policy);
    if (!always && appliedPolicy.get(sandbox.name) === digest) return;
    appliedPolicy.delete(sandbox.name);
    await guarded("updateNetworkPolicy", () => sandbox.updateNetworkPolicy(policy, { signal: signal() }));
    appliedPolicy.set(sandbox.name, digest);
  }

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

  /** `boundedBy` with the port-wide call timeout as its default. */
  const bounded = <T,>(operation: string, work: Promise<T>, limitMs: number = callTimeoutMs): Promise<T> => boundedBy(operation, work, limitMs);

  /**
   * R-TOKEN-LIFETIME: the command object a launch holds carries the launch-time token, which may have rotated
   * (an OIDC token) by the time a limit, a stop or a failure needs to kill it. So a kill first re-opens the
   * sandbox with credentials fetched NOW and looks the command up there. It does that ONLY when the sandbox is
   * running and its current session is the one the command was started in, and looks the command up on the
   * session (no resume wrapper), so a kill can never wake a stopped sandbox into a new, unrecorded session.
   * In every other case (no `cmdId`, no session id, a stopped or different session, a failed lookup) it kills
   * through the captured command, which never resumes anything.
   */
  async function killQuietly(sandboxName: string, command: SdkCommand, sessionId: string | undefined, signalName?: "SIGKILL"): Promise<void> {
    await bounded(
      "kill",
      (async () => {
        const fresh = await freshCommand(sandboxName, command, sessionId).catch(() => undefined);
        // SIGTERM (the SDK's default) first; the second kill of the ladder (RLR-0c condition 8) names SIGKILL.
        await (fresh ?? command).kill(...(signalName === undefined ? [] : [signalName]));
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

  const guarded = guardedCall;

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
    sandboxTokens.set(sandbox, creds.token);
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
  async function cloneRepository(sandbox: SdkSandbox, clone: CloneTarget, workdir: string, env: Record<string, string>): Promise<void> {
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

  /** One sh script in the workspace, bounded by `limitMs`; the end of its output is held (bounded). `exitCode` is undefined when it was killed at the limit. */
  async function runScript(
    sandbox: SdkSandbox,
    script: { name: string; text: string; args: string[] },
    where: { env: Record<string, string> },
    limitMs: number,
  ): Promise<{ exitCode: number | undefined; held: string; truncated: boolean }> {
    const command = await guarded("runCommand", () =>
      sandbox.runCommand({ cmd: "sh", args: ["-c", script.text, script.name, ...script.args], env: where.env, detached: true, signal: signal() }),
    );
    let held = "";
    let truncated = false;
    const exit = await bounded(
      script.name,
      (async () => {
        for await (const entry of command.logs()) {
          if (typeof entry.data !== "string") continue;
          held += entry.data;
          if (held.length > INSTALL_OUTPUT_BUFFER_CHARS) {
            held = held.slice(-INSTALL_OUTPUT_BUFFER_CHARS);
            truncated = true;
          }
        }
        return command.wait();
      })(),
      limitMs,
    ).catch(async () => {
      await killQuietly(sandbox.name, command, sandbox.currentSession().sessionId);
      return undefined;
    });
    return { exitCode: exit?.exitCode ?? undefined, held, truncated };
  }

  /**
   * D#6 C44-6b: the dependency install between the clone and the agent. Order, always: detect (no network change); then, only
   * if an install is due, firewall(install), install, firewall(run); the agent command is issued by the caller afterwards.
   * The run firewall is put back in a `finally`, so a failed or timed-out install never leaves the install rules open; if it
   * cannot be put back (twice), the launch fails (the agent must not start under the install rules). An install that fails is an
   * outcome, not an error: `failed`, which the caller names to the agent and the run.
   */
  async function installDependencies(
    sandbox: SdkSandbox,
    opts: StartDetachedOptions,
    workdir: string,
    resuming: boolean,
  ): Promise<{ outcome: DepsOutcome; exitCode?: number | null; tail?: string }> {
    const where = { env: installEnv(workdir) };
    let detected: number | undefined;
    try {
      detected = (await runScript(sandbox, { name: "fx-deps-detect", text: DETECT_SCRIPT, args: [workdir, resuming ? "resume" : "fresh"] }, where, callTimeoutMs)).exitCode;
    } catch {
      // fx-swallow-ok: a failed detect is reported as a failed install below; nothing was changed
      detected = undefined;
    }
    if (detected === DETECT_NONE) return { outcome: "none" };
    if (detected === DETECT_SKIP) return { outcome: "skipped" };
    if (detected !== DETECT_PNPM && detected !== DETECT_NPM) return { outcome: "failed", exitCode: detected ?? null, tail: "" };

    let installRules: NetworkPolicyRule[];
    try {
      installRules = await opts.installPolicy!();
    } catch {
      // fx-swallow-ok: the install policy could not be built; no rule was applied, so the install is reported as failed
      return { outcome: "failed", exitCode: null, tail: "" };
    }
    const applyRun = async (): Promise<void> => {
      await applyPolicy(sandbox, sdkNetworkPolicy(opts.networkPolicy));
    };
    let result: { outcome: DepsOutcome; exitCode?: number | null; tail?: string };
    try {
      await applyPolicy(sandbox, sdkNetworkPolicy(installRules));
      const ran = await runScript(sandbox, { name: "fx-deps-install", text: INSTALL_SCRIPT, args: [workdir, detected === DETECT_PNPM ? "pnpm" : "npm"] }, where, installTimeoutMs);
      result =
        ran.exitCode === 0
          ? { outcome: "installed" }
          : {
              outcome: "failed",
              exitCode: ran.exitCode ?? null,
              tail: redactedCloneTail(ran.held, ran.truncated, Object.values(opts.env).filter((v) => v.length >= 12)).slice(-INSTALL_TAIL_MAX_CHARS),
            };
    } catch {
      // fx-swallow-ok: a failed policy change or command is the install failing; the run policy is restored below either way
      result = { outcome: "failed", exitCode: null, tail: "" };
    } finally {
      try {
        await applyRun();
      } catch {
        // fx-swallow-ok: the first restore failed; the retry below is the one whose failure counts
        await applyRun(); // one more try; a second failure propagates and the launch fails before any agent command
      }
    }
    return result;
  }

  function launch(
    handle: SandboxHandle,
    opts: StartDetachedOptions,
    prompt: string,
    sessionId: string | undefined,
    attach?: ReadSliceOptions,
    phase?: { attached: boolean },
  ): { handle: AgentHandle; hookFired: Promise<NormalizedEvent | undefined | SliceEnd>; launched: Promise<void> } {
    assertName(handle.sandboxName);
    // D#221 R1a: a backend that is not registered (with the hostile-config contract) is not selectable; nothing starts.
    const backend = backends.select(opts.backend);
    // D#598 P1f-5a: no agent is ever launched in a publish sandbox (any role), and the publish role has no model connection (any sandbox).
    assertNoAgentInPublishSandbox(handle.sandboxName, opts.role);
    // A re-attach carries no environment: it starts no process the environment could reach.
    if (attach === undefined) assertSandboxEnvMatchesRole(opts.role, opts.env);
    // A role with no tool list is refused here (UnknownRoleError, `unknown_role`), before any agent file is written or command run.
    toolsForRole(opts.role);
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
    recordPathFor(opts.runId); // a run id the recorder's path cannot carry is refused before anything starts
    const cliModel = Object.hasOwn(CLI_MODEL_NAMES, opts.model) ? CLI_MODEL_NAMES[opts.model as ModelId] : undefined;
    if (cliModel === undefined) throw new Error("createVercelSandboxPort: model has no CLI model name");
    // D#600 CX-6a: the model's window, for the context warning. A model with no figure (or a price table that cannot be read) has no window, and the run gets no context_pct.
    let windowTokens: number | undefined;
    try {
      windowTokens = contextWindowTokensFor(opts.model);
    } catch {
      // fx-swallow-ok: the window drives an advisory warning only; with no window there is no warning
    }
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

    const hookFired = (async (): Promise<NormalizedEvent | undefined | SliceEnd> => {
      const sandbox = await open(handle, attach ? "readSlice" : resuming ? "resume" : "startDetached", resuming).catch((err: unknown) => {
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
      // RLR-4: a slice re-attaches to the command an earlier invocation started; it clones, installs and writes nothing.
      if (attach !== undefined && runSessionId !== attach.sessionId) throw new SandboxPortError("readSlice");
      // The command's start: the guard's saved one when a slice restores, else what the caller knew, else now.
      const startedMs = attach === undefined ? Date.now() : attach.restore && attach.restore.guard.startedMs > 0 ? attach.restore.guard.startedMs : (attach.startedMs ?? Date.now());
      // What the warnings say, computed by the runner (the hook has no clock).
      let timeWarningMinutes: number | undefined;
      let modelCallsRemaining: number | undefined;
      // CX-6a: the whole percent of the window the latest turn fills, set only from CONTEXT_WARN_PCT up (it falls back to undefined after a compaction).
      let contextPctNow: number | undefined;
      // X-4: the limits in force; an extension raises them (`applied`).
      let inForceLimits: RunLimits = attach?.restore ? { ...limits, ...attach.restore.guard.limits } : limits;
      const inForce = (): RunLimits => inForceLimits;
      const limitsFile = (): string =>
        runLimitsFileContent({ startedMs, deadlineMs: startedMs + inForce().maxRunMs, maxModelCalls: inForce().maxModelCalls, timeWarningMinutes, modelCallsRemaining, contextPct: contextPctNow });
      // Mid-run rewrites are best effort and serialized, so an older body never lands after a newer one.
      let rewriting: Promise<unknown> = Promise.resolve();
      const rewriteLimits = (): void => {
        rewriting = rewriting
          .then(() => sandbox.writeFiles([{ path: FX_RUN_LIMITS_PATH, content: limitsFile(), mode: 0o444 }], { signal: signal() }))
          .catch(() => undefined);
      };
      /** Everything before the agent command exists: policy, pin, files, clone, install, the command. `undefined`: the run was stopped meanwhile. */
      const startFresh = async (): Promise<SdkCommand | undefined> => {
        // Egress is the SDK 3.5.1 `NetworkPolicy` shape (H14c-3-1, CARRY-12).
        const policy = sdkNetworkPolicy(opts.networkPolicy);
        // Re-applied even when it equals the create-time policy (a resumed or woken session starts from whatever the last one left).
        await applyPolicy(sandbox, policy, true);
        if (run.stopped) return undefined;
        await checkCliPin(sandbox, opts.env, backend);
        if (run.stopped) return undefined;
        // The prompt (role card first) goes to a 0600 file the wrapper opens
        // and deletes before claude starts; it is in no argv.
        const promptFile = `/tmp/fx-prompt-${randomUUID()}`;
        // The prompt and the agent's config, as one batch. Written here, and written again after the dependency install (D#6 C44-6b):
        // the install runs the repo's lifecycle scripts as the same uid, so it is an "earlier command" in the sense below.
        // D#600 CX-4a: the text the prompt cut goes to /fx/context/<code>.md first (fixed names, one writeFiles call, outside the checkout). If it cannot be
        // written, the prompt that goes out is the uncut one: a cut never happens without a readable file.
        let promptText = prompt;
        // The spill files, once the first write succeeded: they are rewritten with the agent's other files after the install (CWE-345), because the
        // prompt sends the agent to them and a repo's lifecycle script could replace them.
        let spillRewrite: Array<{ path: string; content: string; mode: number }> = [];
        if (opts.spill !== undefined) {
          let written = false;
          try {
            const spillWrites = contextSpillWrites(opts.spill);
            await guarded("writeFiles", () => sandbox.writeFiles(spillWrites, { signal: signal() }));
            written = true;
            spillRewrite = spillWrites;
          } catch {
            // fx-swallow-ok: a spill that cannot be written is the uncut prompt, below; it never fails the launch
          }
          if (run.stopped) return undefined;
          if (!written) promptText = opts.spill.uncut.prompt;
          opts.onSpill?.(written);
        }
        let promptBody = `${opts.roleCard}\n\n${promptText}`;
        const writeAgentFiles = (): Promise<void> =>
          guarded("writeFiles", () =>
            sandbox.writeFiles(
              [
                { path: promptFile, content: promptBody, mode: 0o600 },
                // Rewritten before EVERY agent command (start and resume): an
                // earlier command runs as the same uid and may have edited them.
                { path: FX_AGENT_SETTINGS_PATH, content: JSON.stringify(agentSettingsFor(opts.role, opts.excludes)), mode: 0o444 },
                { path: FX_AGENT_MCP_PATH, content: JSON.stringify(FX_AGENT_MCP_CONFIG), mode: 0o444 },
                // C66: the runner's one hook, and the deadline it warns from (W-1).
                { path: FX_LIMIT_HOOK_PATH, content: FX_LIMIT_HOOK_SCRIPT, mode: 0o444 },
                { path: FX_RUN_LIMITS_PATH, content: limitsFile(), mode: 0o444 },
                // D#2 RLR-3b: the recorder the agent command runs under, and the directory its record file goes in.
                ...agentRecorderFiles(),
                // D#600 CX-4a: the text the prompt cut, from the runner's own copy, never trusted from before the install.
                ...spillRewrite,
              ],
              { signal: signal() },
            ),
          );
        await writeAgentFiles();
        // D#2 PREVIEW-RUNNER-EVENTS: the sandbox is up, locked down and loaded; the agent command is next. Best effort:
        // a progress mark that fails to record never fails the launch.
        const mark = async (stage: "sandbox_ready" | "cloned" | "deps_installed" | "deps_install_failed"): Promise<void> => {
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
        if (opts.installPolicy !== undefined && opts.workdir !== undefined) {
          const deps = await installDependencies(sandbox, opts, opts.workdir, resuming);
          if (run.stopped) return undefined;
          const line = depsPromptLine(deps.outcome);
          if (line !== undefined) {
            // Repo scripts ran as the agent's own user (which can sudo): what the agent will be started from is checked again and
            // rewritten from the runner's own text, never trusted from before the install. A CLI that no longer matches its pin
            // refuses the launch (SandboxPortError); changed config files are overwritten, the prompt gains its one fixed line.
            await checkCliPin(sandbox, opts.env, backend);
            if (run.stopped) return undefined;
            promptBody = `${promptBody}\n\n${line}`;
            await writeAgentFiles();
            await mark(deps.outcome === "failed" ? "deps_install_failed" : "deps_installed");
            try {
              opts.onInstall?.({ outcome: deps.outcome === "failed" ? "failed" : deps.outcome === "skipped" ? "skipped" : "installed", ...(deps.exitCode !== undefined && { exitCode: deps.exitCode }), ...(deps.tail !== undefined && { tail: deps.tail }) });
            } catch {
              // fx-swallow-ok: an observer never fails the launch
            }
          }
        }
        // D#2 RLR-3b: the agent command is the recorder; no `logs()` subscriber is ever attached to it before it has exited.
        return startAgentCommand(sandbox, { promptFile, runId: opts.runId, agentArgv, cwd: opts.workdir, env: opts.env, timeoutMs: callTimeoutMs });
      };
      let command: SdkCommand;
      if (attach === undefined) {
        const started = await startFresh();
        if (started === undefined) return undefined;
        command = started;
      } else {
        // The command is looked up on the SESSION it ran in (never the sandbox's resume wrapper, which could wake a stopped sandbox into a new session).
        const session = sandbox.currentSession();
        if (session.getCommand === undefined) throw new SandboxPortError("readSlice");
        command = await guarded("getCommand", () => session.getCommand!(attach.cmdId, { signal: signal() }));
        if (command.cmdId !== attach.cmdId) throw new SandboxPortError("readSlice"); // the lookup answered another command: never read or killed as ours
      }
      run.command = command;
      if (phase) phase.attached = true;
      markLaunched();
      if (run.stopped) {
        await killQuietly(handle.sandboxName, command, runSessionId);
        return undefined;
      }

      // RLR-4: what a slice carries over from the one before it (nothing, for a launch or a first slice).
      const restored = attach?.restore?.reader;
      let seq = restored?.seq ?? 0;
      /** The event for the LAST raw `result` message; completion is decided
       * from it only after the command has exited. */
      let lastResult: NormalizedEvent | undefined =
        restored?.lastResult == null
          ? undefined
          : ({ runId: opts.runId, role: opts.role, seq: 0, ts: new Date().toISOString(), ...restored.lastResult, backend: backend.name } as NormalizedEvent);
      /**
       * Fallback verdict for a run whose last turn spoke after the envelope (a background task finished, the agent
       * woke and added a closing line, and the final `result` has no envelope though the verdict was given).
       * It is the envelope of the LAST main-thread message (assistant text or result) that carried an
       * `AGENT_OUTPUT` marker, and only if that message parsed to a non-checkpoint envelope: a later message with a
       * marker that does not parse sets it back to undefined (last marker wins, or nothing), as envelope.ts treats
       * a malformed last block. Subagent lines (`parent_tool_use_id` set), user/tool lines and error runs never
       * feed or use it.
       * RESIDUAL RISK: an envelope quoted mid-run (a diff or log the agent echoed) followed only by prose with no
       * marker looks the same as the real case (verdict, then a closing line); the stream carries no wake-up
       * signal from a background task that we could require, so such a quote can become the verdict. A quote
       * followed by any later marker, even a malformed one, fails closed.
       */
      let lastEnvelope: Record<string, unknown> | undefined = restored?.lastEnvelope ?? undefined;
      /** The `subtype` of that raw `result` line; read for nothing else. */
      let lastResultSubtype: unknown = restored?.lastResultSubtype ?? undefined;
      /** The first limit the runner's own guard reached (MP-CLOCK/SILENT/TURNS). */
      let limitHit: RunLimit | undefined;
      // RLR-2: the effects that leave this process (warnings, extensions, the kill) live in one monotone record a reader can checkpoint.
      const fx = createSideEffects();
      if (attach?.restore) Object.assign(fx, mergeSideEffects(fx, attach.restore.sideEffects));
      let wakeLoop!: () => void;
      const limitSignal = new Promise<void>((resolve) => {
        wakeLoop = resolve;
      });
      // X-1..X-4: only the runner's own guard reaches an extension, when `run_time` or
      // `model_calls` is hit; an agent's checkpoint envelope never comes through here.
      const extPolicy = knownTimeoutMs === undefined ? undefined : opts.extension;
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
            extensionsUsed: fx.extensionsUsed,
            maxExtensions: extPolicy.maxExtensions,
            ghWrites: extPolicy.ghWrites(),
            ghWritesAtLastExtension: fx.ghAtLast,
            // Fail closed: a policy that does not say is a writing role, so ids alone never count as progress.
            roleWrites: extPolicy.roleWrites !== false,
            messageIds: guard.modelCalls(),
            messageIdsAtLastExtension: fx.idsAtLast,
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
            recordExtension(fx, g.d.kind, { ghWrites: g.ghWrites, messageIds: g.messageIds });
            // Best effort, like every mid-run write: the extension stands even if the event row does not land.
            try {
              void Promise.resolve(extPolicy.onExtended({ kind: g.d.kind, extensionsUsed: fx.extensionsUsed, newLimit: g.d.newLimit, progress: g.d.progress })).catch(() => undefined);
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
            fx.callsWarned = false;
            modelCallsRemaining = undefined;
          }
          rewriteLimits();
        },
      };
      const guard = createRunGuard(
        limits,
        (limit) => {
          limitHit = limit;
          fx.killIssued = true;
          void killQuietly(handle.sandboxName, command, runSessionId);
          wakeLoop();
        },
        extension,
        attach?.restore?.guard,
      );
      if (attach?.restore) {
        // A limit the guard had already reached ended the run in the slice before: it is the end here too, and the command is told again (a kill is idempotent).
        const reached = attach.restore.guard.fired;
        if (reached !== null) {
          limitHit = reached;
          void killQuietly(handle.sandboxName, command, runSessionId);
        }
        // The warnings are said once; what they said is worked out again from the clock and the count, for the file a later change rewrites.
        if (fx.timeWarned) timeWarningMinutes = Math.max(Math.ceil((startedMs + inForce().maxRunMs - Date.now()) / 60_000), 0);
        if (fx.callsWarned) modelCallsRemaining = Math.max(inForce().maxModelCalls - guard.modelCalls(), 0);
      }
      // D#600 CX-1a: measures this command's context from the same lines the meter reads; integers only.
      const ledger = new ContextLedgerCapture(disabledToolsFor(opts.excludes));
      let lastFigure = 0;
      const deliver = async (line: string, catchingUp = false, sourceLine?: number): Promise<void> => {
        if (!catchingUp && (run.stopped || limitHit !== undefined)) return;
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
        ledger.observe(parsed);
        const event = dropInvalidUsage(normalizeMessage({ ...opts, backend: backend.name }, parsed, seq++, opts.workdir), reportInvalid);
        const text = event.type === "assistant" || parsed.type === "result" ? event.text : undefined;
        if (parsed.parent_tool_use_id == null && typeof text === "string" && ENVELOPE_MARKER.test(text) && endsWithEnvelopeBlock(text)) {
          const found = extractAgentOutputEnvelope(text);
          lastEnvelope = found?.verdict === "checkpoint" ? undefined : found;
        }
        if (parsed.type === "result") {
          lastResult = event;
          lastResultSubtype = parsed.subtype;
        }
        checkTail();
        await opts.onEvent(event, sourceLine === undefined ? undefined : { sourceLine });
        guard.observe(event);
        // CX-6a: after a main-thread turn, say how full the window is. The file is rewritten only when the figure crosses in, changes or drops out.
        if (parsed.type === "assistant") {
          // CX-9b: the same figure goes to the cloud's row when a turn changed it, so the run page and the item card can show it while the run goes on.
          const nowTokens = ledger.lastContextTokens();
          if (nowTokens !== lastFigure) {
            lastFigure = nowTokens;
            try {
              opts.onContextFigure?.(nowTokens, windowTokens);
            } catch {
              // fx-swallow-ok: the only observer queues a best-effort write and cannot throw; a figure is never worth ending a run for
            }
          }
          const pct = windowTokens === undefined ? undefined : contextPct(nowTokens, windowTokens);
          const next = pct !== undefined && pct >= CONTEXT_WARN_PCT ? pct : undefined;
          if (next !== contextPctNow) {
            contextPctNow = next;
            rewriteLimits();
          }
        }
        // W-2: once, at 80% of the call limit, tell the agent how many remain.
        // Advisory and best effort: the runner's own count is what enforces.
        if (!fx.callsWarned && guard.modelCalls() >= WARN_FRACTION * inForce().maxModelCalls) {
          fx.callsWarned = true;
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
            fx.timeWarned = true;
            timeWarningMinutes = Math.max(Math.ceil((startedMs + inForce().maxRunMs - Date.now()) / 60_000), 0);
            rewriteLimits();
          },
          Math.max(WARN_FRACTION * inForce().maxRunMs - (Date.now() - startedMs), 0),
        );
        timeWarning.unref?.();
      };
      if (!fx.timeWarned) armTimeWarning(); // a slice that restores a time warning already said does not say it again
      // D#2 RLR-3b: the reader, one parser (`recordParser.ts`) and one path. Reads of the record file (each a new command with one held subscriber), a probe
      // for the exit, a drain to the trailer, the trailer checked against `wait()`, then the one replay of the recorder's echo. The agent command itself
      // never gets a `logs()` subscriber before it has exited.
      const recordPath = recordPathFor(opts.runId);
      // R-TOKEN-LIFETIME, for the reader: the sandbox and the command this launch holds carry the launch-time token, which may have rotated by the time a read
      // or a probe is due (a run is long). When the token has changed, the sandbox is opened again with the new one (never resumed: it must be running, in the
      // session the command started in) and the command is looked up on that session by id.
      let liveToken = sandboxTokens.get(sandbox);
      let liveSandbox = sandbox;
      let liveCommand = command;
      const live = async (): Promise<{ sandbox: SdkSandbox; command: SdkCommand }> => {
        const creds = await credentials();
        if (command.cmdId === undefined || creds.token === liveToken || liveToken === undefined) return { sandbox: liveSandbox, command: liveCommand };
        const fresh = await sdk.get({ name: handle.sandboxName, resume: false, signal: signal(), ...creds, ...fetchOption });
        const session = fresh.currentSession();
        if (fresh.name !== handle.sandboxName || fresh.status !== "running" || session.sessionId !== runSessionId || session.getCommand === undefined) throw new SandboxPortError("reopen");
        const found = await session.getCommand(command.cmdId, { signal: signal() });
        if (found.cmdId !== command.cmdId) throw new SandboxPortError("reopen"); // the lookup answered another command: never read or killed as ours
        liveCommand = found;
        liveSandbox = fresh;
        liveToken = creds.token;
        return { sandbox: liveSandbox, command: liveCommand };
      };
      const unreadableEcho: EchoCheck = { unavailable: true, mismatch: false, hasHeader: false, trailer: null, count: 0 };
      const fileRecords = new RecordLedger(restored?.file.count ? restored.file : undefined);
      let fileTrailer: Trailer | null = restored?.trailer ?? null;
      let offset = attach?.cursor.byteOffset ?? 0;
      let nextSeq = attach?.cursor.nextSeq ?? 0;
      let headStreak = 0;
      // A streak of failed reads is carried across slices (the saved count), so many short slices that all fail still reach the limit.
      let failedReads = attach?.cursor.readFailures ?? 0;
      let exitCode: number | undefined;
      let trailerMissing = false;
      let launchRefused = false;
      let echoUnreadable = false;
      /** RLR-4: the record file's consumed part was found changed at exit (`record_file_tampered`): the run does not succeed. */
      let fileAltered = false;
      let faulted = false;
      const raised = new Set<ReaderFlag>();
      const raiseFlag = (flag: ReaderFlag): void => {
        if (raised.has(flag)) return;
        raised.add(flag);
        try {
          opts.onReaderFlag?.(flag);
        } catch (err) {
          // a flag hook must never break a run
          reportError(err, { stage: "run.reader_flag_hook" });
        }
      };
      /** Ends the run on a reader fault: the flag, then a throw (the catch below kills the command). */
      function fail(flag: ReaderFlag, operation: string): never {
        faulted = true;
        raiseFlag(flag);
        throw new SandboxPortError(operation);
      }
      /** One accepted record's effect. A line goes to `deliver`; an over-long one ends the run (EV-CAP); the header and the trailer carry no line. */
      const deliverRecord = async (r: AcceptedRecord): Promise<void> => {
        if (r.kind === "big") {
          reportInvalid("oversize");
          throw new SandboxPortError("stdout line cap");
        }
        if (r.kind !== "o" && r.kind !== "tail") return;
        const line = r.data.toString("utf8").trim();
        if (line) await deliver(line, false, attach === undefined ? undefined : r.seq);
      };
      // ---- RLR-4: slices. Everything below is inert for a launch (`attach` undefined).
      /** Thrown by a checkpoint the lease no longer covers; the slice stops at once and does nothing else (no kill, no catch-up, no finalize). */
      const leaseLost = new Error("reader lease lost");
      let sliceEnd: "slice" | "lost" | undefined;
      /** Set once the command has exited: the exit sequence is never cut short by the slice's time. */
      let exiting = false;
      let consumedInSlice = 0;
      let lastCommitMs = Date.now();
      const sliceOver = (): boolean => attach !== undefined && !exiting && (Date.now() >= attach.untilMs || (attach.maxRecords !== undefined && consumedInSlice >= attach.maxRecords));
      /** Set once the verdict a later slice would build the end from outgrew what the state column holds: the run is ending as unreadable, and the saved state drops it. */
      let tailTooLarge = false;
      const tailOf = (): { lr: LastResultState | null; env: Record<string, unknown> | null } => {
        const lr: LastResultState | null =
          lastResult === undefined
            ? null
            : {
                type: lastResult.type === "result" ? "result" : "error",
                ...(lastResult.isError !== undefined && { isError: lastResult.isError }),
                ...(lastResult.sessionId !== undefined && { sessionId: lastResult.sessionId }),
                ...(lastResult.costUsd !== undefined && { costUsd: lastResult.costUsd }),
                ...(lastResult.usage !== undefined && { usage: { ...lastResult.usage } as Record<string, number> }),
                ...(lastResult.agentOutput !== undefined && { agentOutput: lastResult.agentOutput }),
              };
        return { lr, env: lastEnvelope ?? null };
      };
      /**
       * The verdict a later slice builds the end from is bounded by what the state column holds, MEASURED THE WAY jsonb PRINTS IT (a number such as 1e300 is 301
       * characters there and 5 in JSON). One that does not fit is a reader that cannot do its job: the run ends as `reader_unavailable` at the moment the verdict
       * grows, inside the read (so the end is the run's own and not a save that fails for ever). From then on the saved state carries no verdict, so the last save fits.
       */
      const checkTail = (): void => {
        if (attach === undefined || tailTooLarge) return;
        const { lr, env } = tailOf();
        if (tailStateBytes(lr, env) > TAIL_STATE_MAX_BYTES) {
          tailTooLarge = true;
          fail("reader_unavailable", "reader state too large");
        }
      };
      const portState = (): PortReaderState => {
        const { lr, env } = tailTooLarge ? { lr: null, env: null } : tailOf();
        return {
          file: fileRecords.state(),
          trailer: fileTrailer,
          seq,
          lastResult: lr,
          lastEnvelope: env,
          lastResultSubtype: typeof lastResultSubtype === "string" ? lastResultSubtype : null,
        };
      };
      /** One checkpoint: the cursor, the guard, the monotone effects and the port's own state, committed by the caller together with its parts. */
      let commitFailures = 0;
      const checkpoint = async (final: boolean): Promise<void> => {
        if (attach === undefined) return;
        const cp = { nextSeq, byteOffset: offset, readFailures: failedReads, guard: guard.snapshot(), sideEffects: { ...fx }, reader: portState(), final };
        let held: boolean;
        try {
          held = await attach.commit(cp);
          commitFailures = 0;
        } catch (err) {
          // A save that errors is tried again at the next checkpoint (nothing was lost: the caller keeps what it had not saved). Three in a row, or one at the
          // very end, means the lease cannot be shown to be held: the slice stops as if it were lost, and whoever takes it over replays from the last save.
          if (final) throw err;
          reportError(err, { stage: "run.slice_checkpoint" });
          if (++commitFailures >= READ_FAILURE_LIMIT) throw leaseLost;
          lastCommitMs = Date.now();
          return;
        }
        lastCommitMs = Date.now();
        if (!held) throw leaseLost;
      };
      const maybeCheckpoint = async (): Promise<void> => {
        if (attach !== undefined && Date.now() - lastCommitMs >= (attach.checkpointEveryMs ?? SLICE_CHECKPOINT_MS)) await checkpoint(false);
      };
      /**
       * The exit sequence (the kill ladder, the rebuild of the consumed prefix, the echo replay) saves nothing until its last checkpoint and can outlast the lease:
       * a heartbeat renews it meanwhile, so the end is saved and finalized by the reader that ran it. A renewal that finds the lease gone changes nothing here; the
       * last checkpoint's fenced save is what says so.
       */
      let beat: ReturnType<typeof setInterval> | undefined;
      const startBeat = (): void => {
        const renew = attach?.renew;
        if (attach === undefined || renew === undefined || beat !== undefined) return;
        beat = setInterval(() => {
          renew().catch((err: unknown) => reportError(err, { stage: "run.slice_renew" }));
        }, attach.renewEveryMs ?? SLICE_RENEW_MS);
        beat.unref?.();
      };
      const stopBeat = (): void => {
        clearInterval(beat);
        beat = undefined;
      };
      /** One read and what it means. A fault that is not a plain failed read ends the run here. */
      const step = async (): Promise<{ progressed: boolean; caughtUp: boolean; failed: boolean } | "stopped"> => {
        const held = await orStopped(bounded("reader_live", live())).catch(() => undefined);
        if (held === "stopped") return "stopped";
        if (held === undefined) return { progressed: false, caughtUp: false, failed: true };
        // Only the read itself races a stop or a limit; what it returned is processed to the end, so a kill thrown from `onEvent` is never lost to a stop.
        const out = await orStopped(readRecords(held.sandbox, { recordPath, offset, nextSeq, timeoutMs: callTimeoutMs, abandon: (c) => killQuietly(handle.sandboxName, c, runSessionId) }));
        if (out === "stopped") return "stopped";
        if (out.fault === "read_failed") return { progressed: false, caughtUp: false, failed: true };
        if (out.fault === "log_oversize") fail("log_oversize", "record file oversize");
        if (out.fault !== null) fail("record_file_tampered", `record file ${out.fault}`); // truncated, or a read the script cannot make
        if (nextSeq === 0 && out.records.length > 0 && out.run !== opts.runId) fail("record_file_tampered", "record file run id");
        headStreak = nextHeadStreak(headStreak, out);
        if (isTampered(headStreak, out)) fail("record_file_tampered", "record file head");
        for (const r of out.records) {
          fileRecords.add(r);
          await deliverRecord(r);
          // The cursor moves record by record, so a checkpoint (or the end of a slice) can fall between any two records.
          offset += r.size;
          nextSeq++;
          consumedInSlice++;
          if (r.kind === "x" && out.trailer) fileTrailer = out.trailer;
          if (limitHit !== undefined || sliceOver()) break;
          await maybeCheckpoint();
        }
        return { progressed: out.records.length > 0, caughtUp: out.size !== null && offset >= out.size, failed: false };
      };
      /** `work`, or "stopped" when `stop()` or the runner's own limit comes first (the abandoned work is left to settle). */
      const orStopped = async <T,>(work: Promise<T>): Promise<T | "stopped"> => {
        let failure: { err: unknown } | undefined;
        work.catch((err: unknown) => void (failure = { err }));
        const first = await Promise.race([work, run.stopSignal.then(() => "stopped" as const), limitSignal.then(() => "stopped" as const)]);
        if (first === "stopped") {
          // A stop and an abort from `onEvent` (a spend kill stops the sandbox first) arrive in the same turn: the abort wins, as it did when the loop awaited each line.
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (failure) throw failure.err;
        }
        return first;
      };
      /**
       * RLR-0c condition 8, for an exit that does not take the cross-check above and was not the runner's own enforcement (a reader fault, a stop): the
       * command is waited for, bounded, and the echo is replayed with whatever the file lacks metered, so usage taken out of the unread part of the file
       * is still counted. It runs once. `swallow` is for an exit that ends the run with its own answer: an error from the meter there is not allowed to
       * replace it. A spend kill, a limit and an over-long line are the runner's own enforcement and keep today's end: nothing after them is consumed.
       */
      let caughtUp = false;
      const meterRecord = async (r: AcceptedRecord): Promise<void> => {
        if (r.kind === "big") return reportInvalid("oversize"); // counted; the run is ending already
        if (r.kind !== "o" && r.kind !== "tail") return;
        const line = r.data.toString("utf8").trim();
        if (line) await deliver(line, true, attach === undefined ? undefined : r.seq);
      };
      /**
       * RLR-4: the file side of the exit cross-check. A launch holds every digest in memory. A slice that restored holds only the chain of the records an
       * earlier slice consumed, so it reads the record file again from the start for them; the file is agent-writable, so what comes back is trusted for
       * nothing until its first `base` records give exactly the saved (count, chain). If they do, those digests are the file side, as in-process. If they do
       * not (or too few come back), the file was changed after it was consumed: `record_file_tampered`, and every echo record in that part is metered
       * (`prefixTrusted: false`), which the per-message-id maximum dedupes. A file that cannot be read again at all is treated exactly the same way (nothing in it
       * is trusted: the echo is still replayed and metered in full for that part) and is told apart only by `unreadable`, which the exit raises as
       * `reader_unavailable` and which stops the run from succeeding. It never skips the echo.
       */
      let crossed: { ledger: RecordLedger; prefixTrusted: boolean; base: number; unreadable: boolean } | undefined;
      const untrustedCross = (base: number, unreadable: boolean): NonNullable<typeof crossed> => {
        const merged = new RecordLedger();
        for (let i = 0; i < base; i++) merged.addDigest(UNTRUSTED_DIGEST);
        for (let i = base; i < fileRecords.count; i++) merged.addDigest(fileRecords.at(i)!);
        return (crossed = { ledger: merged, prefixTrusted: false, base, unreadable });
      };
      const crossLedger = async (): Promise<NonNullable<typeof crossed>> => {
        if (crossed) return crossed;
        const base = fileRecords.base;
        if (base === 0) return (crossed = { ledger: fileRecords, prefixTrusted: true, base, unreadable: false });
        const held = await bounded("reader_live", live()).catch(() => undefined);
        if (held === undefined) return untrustedCross(base, true);
        const prefix: Buffer[] = [];
        let off = 0;
        let want = 0;
        let ok = true;
        try {
          await bounded(
            "reader_rebuild",
            (async () => {
              for (let reads = 0; want < base && reads < REBUILD_MAX_READS; reads++) {
                const out = await readRecords(held.sandbox, { recordPath, offset: off, nextSeq: want, timeoutMs: callTimeoutMs, abandon: (c) => killQuietly(handle.sandboxName, c, runSessionId) });
                if (out.fault !== null) {
                  if (out.fault === "read_failed") throw new SandboxPortError("readRecords");
                  ok = false; // a file that is shorter, oversize or not the recorder's: not the file that was consumed
                  return;
                }
                for (const r of out.records) {
                  if (want >= base) break;
                  prefix.push(digestOf(r));
                  off += r.size;
                  want++;
                }
                if (out.records.length === 0) return;
              }
            })(),
            echoTimeoutMs,
          );
        } catch {
          // fx-swallow-ok: a file that cannot be read again is the answer (untrusted and unreadable): the exit then raises reader_unavailable, replays the echo in full for that part, and the run does not succeed
          return untrustedCross(base, true);
        }
        const merged = new RecordLedger();
        const check = new RecordLedger();
        for (const d of prefix) check.addDigest(d);
        const trusted = ok && prefix.length === base && check.hash() === fileRecords.savedChain;
        for (let i = 0; i < base; i++) merged.addDigest(trusted ? prefix[i]! : UNTRUSTED_DIGEST);
        for (let i = base; i < fileRecords.count; i++) merged.addDigest(fileRecords.at(i)!);
        if (!trusted) {
          raiseFlag("record_file_tampered");
          fileAltered = true;
        }
        return (crossed = { ledger: merged, prefixTrusted: trusted, base, unreadable: false });
      };
      /** RLR-0c condition 8: the exit of an ended command is waited for; if SIGTERM (sent by whoever ended it) has not done it in time, SIGKILL, and wait once more. */
      const awaitExit = async (held: { command: SdkCommand }): Promise<ExitProbe | undefined> => {
        const first = await bounded("reader_exit", probeExit(held.command, exitWaitMs), exitWaitMs + callTimeoutMs).catch(() => undefined);
        if (first?.exited) return first;
        await killQuietly(handle.sandboxName, command, runSessionId, "SIGKILL");
        return bounded("reader_exit", probeExit(held.command, exitWaitMs), exitWaitMs + callTimeoutMs).catch(() => undefined);
      };
      /**
       * The same record for an end the runner itself enforced (a limit, a spend kill, an over-long line): the usage in it reaches the caller's meter and nothing
       * else is done with it. No text, no tool activity and no envelope is passed on, the guard does not see it, and the run's last result is not replaced.
       */
      const meterOnly = async (r: AcceptedRecord): Promise<void> => {
        if (r.kind === "big") return reportInvalid("oversize");
        if (r.kind !== "o" && r.kind !== "tail") return;
        const line = r.data.toString("utf8").trim();
        if (!line) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          // fx-swallow-ok: a recorded line that is not JSON is counted by reportInvalid and never echoed
          return reportInvalid("not_json");
        }
        if (!isPlainObject(parsed)) return reportInvalid("shape");
        if (!isKnownStreamJsonType(parsed)) return reportInvalid("type");
        if (isMalformedAssistant(parsed)) return reportInvalid("shape");
        const event = dropInvalidUsage(normalizeMessage({ ...opts, backend: backend.name }, parsed, seq, opts.workdir), reportInvalid);
        if (event.usage === undefined && event.costUsd === undefined) return;
        const { runId, role, seq: eventSeq, type, ts, backend: eventBackend, sessionId, messageId, messageModel, usage, costUsd } = event;
        try {
          await opts.onEvent({ runId, role, seq: eventSeq, type, ts, ...(eventBackend !== undefined && { backend: eventBackend }), ...(sessionId !== undefined && { sessionId }), ...(messageId !== undefined && { messageId }), ...(messageModel !== undefined && { messageModel }), ...(usage !== undefined && { usage }), ...(costUsd !== undefined && { costUsd }) }, { meterOnly: true });
        } catch (err) {
          // The run is ending already; the meter's own abort must not stop the records after this one from being counted.
          reportError(err, { stage: "run.meter_only" });
        }
      };
      /**
       * `enforced`: the end was the runner's own kill. Only what the file lacked of the part this reader had consumed is metered (`upToSeq`), through `meterOnly`;
       * whatever the echo has after the killing record stays unconsumed and unmetered. Finding any of it raises `record_mismatch`.
       */
      const catchUp = async (swallow: boolean, enforced = false): Promise<void> => {
        if (caughtUp) return;
        caughtUp = true;
        let hidden = false;
        try {
          const held = await bounded("reader_live", live()).catch(() => undefined);
          const gone = held === undefined ? undefined : await awaitExit(held);
          if (held === undefined || !gone?.exited) return raiseFlag("reader_unavailable");
          const file = await crossLedger();
          // A consumed part that cannot be read again is "untrusted", not "skipped": the echo below is still replayed and metered for it.
          if (file.unreadable) raiseFlag("reader_unavailable");
          const replayMs = Math.min(echoTimeoutMs, Math.max(callTimeoutMs - exitWaitMs, 1_000));
          const echo = await crossCheckEcho(
            held.command,
            { ledger: file.ledger, trailer: fileTrailer },
            enforced
              ? {
                  timeoutMs: replayMs,
                  upToSeq: fileRecords.count - 1,
                  onEchoOnly: async (r) => {
                    hidden = true;
                    await meterOnly(r);
                  },
                }
              : { timeoutMs: replayMs, onEchoOnly: (r) => (file.prefixTrusted || r.seq >= file.base ? meterRecord(r) : meterOnly(r)) },
          );
          if (echo.unavailable) raiseFlag("reader_unavailable");
        } catch (err) {
          if (!swallow) throw err; // the meter's own abort (a spend kill)
          reportError(err, { stage: "run.catch_up" });
        } finally {
          if (hidden) raiseFlag("record_mismatch");
        }
      };
      let endedByStop = false;
      try {
        try {
          for (;;) {
            if (run.stopped || limitHit !== undefined) break;
            if (sliceOver()) {
              sliceEnd = "slice"; // the time (or the record budget) is up: hand over from the cursor, the command running on
              break;
            }
            await maybeCheckpoint();
            if (fileTrailer === null) {
              const r = await step();
              if (r === "stopped" || limitHit !== undefined) break;
              failedReads = r.failed ? failedReads + 1 : 0;
              if (sliceOver()) {
                sliceEnd = "slice"; // the budget ran out inside the read: hand over before asking the command, the next slice picks up from the cursor
                break;
              }
              if (r.progressed && !r.caughtUp) continue; // more is waiting: read again at once
            }
            // Caught up, or the read failed, or the trailer is in: ask the command. While it runs the probe is the pause between reads.
            const probe = await orStopped(bounded("reader_live", live()).then((h) => probeExit(h.command, fileTrailer === null ? probeMs : trailerWaitMs)).catch(() => undefined));
            if (probe === "stopped") break;
            if (probe?.exited) {
              exitCode = probe.exitCode;
              exiting = true;
              break;
            }
            if (probe === undefined) failedReads++;
            else if (fileTrailer !== null) fail("record_file_tampered", "trailer on a running command"); // RLR-0c condition 6: wait() did not agree within seconds
            if (failedReads >= READ_FAILURE_LIMIT) fail("reader_unavailable", "reader unavailable");
          }
          if (sliceEnd === undefined) startBeat(); // the loop ended for good: what follows is the exit sequence, which keeps the lease alive
          if (exitCode !== undefined && !run.stopped && limitHit === undefined) {
            // The command has exited: read what is left, up to the trailer.
            // A read that fails is tried again (as in the loop above, up to READ_FAILURE_LIMIT in a row) before the trailer is given up on.
            for (let reads = 0, failures = 0; reads < DRAIN_READS && fileTrailer === null; ) {
              const r = await step();
              if (r === "stopped" || limitHit !== undefined) break;
              if (r.failed) {
                if (++failures >= READ_FAILURE_LIMIT) break;
                continue;
              }
              failures = 0;
              if (!r.progressed) break;
              reads++;
            }
          }
          if (exitCode !== undefined && !run.stopped && limitHit === undefined) {
            if (fileTrailer !== null && !trailerMatchesWait(fileTrailer, exitCode)) raiseFlag("record_mismatch");
            // B4 step 3 (condition 7): the first-ever replay of the echo, compared with the file; anything only the echo has is metered too.
            const replay = async (timeoutMs: number): Promise<EchoCheck | "stopped"> => {
              const held = await orStopped(bounded("reader_live", live())).catch(() => undefined);
              if (held === "stopped") return "stopped";
              if (held === undefined) return unreadableEcho;
              const file = await orStopped(crossLedger().catch(() => untrustedCross(fileRecords.base, true)));
              if (file === "stopped") return "stopped";
              // Records in the part an earlier slice consumed, when the file's copy of it can no longer be trusted, are metered and nothing more.
              return orStopped(crossCheckEcho(held.command, { ledger: file.ledger, trailer: fileTrailer }, { timeoutMs, onEchoOnly: (r) => (file.prefixTrusted || r.seq >= file.base ? deliverRecord(r) : meterOnly(r)) }));
            };
            // An echo that cannot be read is tried once more inside the same bound; if it still cannot be, the run is not a success (the meter stays at what was read).
            const echoDeadline = Date.now() + echoTimeoutMs;
            let echo = await replay(echoTimeoutMs);
            if (echo !== "stopped" && echo.unavailable && limitHit === undefined && echoDeadline - Date.now() > 0) echo = await replay(echoDeadline - Date.now());
            if (echo !== "stopped" && limitHit === undefined) {
              // The echo was replayed either way; a consumed part that could not be re-read is still a reader that could not do its job.
              if (crossed?.unreadable) {
                raiseFlag("reader_unavailable");
                echoUnreadable = true;
              }
              if (echo.unavailable) {
                raiseFlag("reader_unavailable");
                echoUnreadable = true;
              }
              if (echo.mismatch) raiseFlag("record_mismatch");
              if (fileTrailer === null) {
                // A command that never wrote a header or a trailer was refused at launch (whatever its exit code, which a child can fake); one that did, and then lost its trailer, was cut off.
                launchRefused = fileRecords.count === 0 && !echo.unavailable && !echo.hasHeader && echo.trailer === null;
                trailerMissing = !launchRefused;
                raiseFlag(launchRefused ? "record_launch_refused" : "record_trailer_missing");
              }
            }
          }
          // The end is decided here, before any catch-up: a stop requested while the hidden part is counted must not turn a limit or a spend kill into a stop.
          endedByStop = run.stopped;
          if (limitHit !== undefined) {
            guard.stop(); // the limit is reached; nothing more is enforced while the hidden part is counted
            await catchUp(true, true);
          } else if (run.stopped) await catchUp(false);
        } catch (err) {
          // A lease lost mid-slice is not an end of the run: nothing is killed, counted or finalized here.
          if (err === leaseLost) {
            sliceEnd = "lost";
            throw err;
          }
          // Kill the command; after a reader fault or any other end the runner enforced, count what the file did not show; then pass the failure on.
          startBeat();
          await killQuietly(handle.sandboxName, command, runSessionId);
          guard.stop();
          await catchUp(true, !faulted);
          throw err;
        } finally {
          guard.stop();
          clearTimeout(timeWarning);
          stopBeat();
          if (sliceEnd !== "lost") {
            // The slice's last checkpoint: after any catch-up, so what the run ended with (and the rows of its last lines) is saved before it is reported.
            try {
              await checkpoint(true);
            } catch (err) {
              if (err === leaseLost) sliceEnd = "lost";
              else reportError(err, { stage: "run.slice_checkpoint" });
            }
          }
          // The run's totals are reported once, by the slice that ends it. The context measure of a sliced run is not carried across slices, so only a run that
          // never restored (one slice from the start) reports it.
          if (sliceEnd === undefined) {
            try {
              opts.onModelCalls?.(guard.modelCalls());
            } catch {
              // fx-swallow-ok: the only observer adds to a counter and cannot throw; if it ever did, the count stays a floor and the run ends as it would have
            }
            if (attach?.restore === undefined) {
              try {
                opts.onContextLedger?.({ ...ledger.snapshot(), denied_tool_calls: ledger.deniedToolCalls(), ...(windowTokens === undefined ? {} : { window_tokens: windowTokens }) });
              } catch {
                // fx-swallow-ok: the only observer stores the measure on the run's bookkeeping and cannot throw; a ledger is never worth ending a run for
              }
            }
          }
        }
      } catch (err) {
        if (err === leaseLost || sliceEnd === "lost") return { sliceEnd: "lost" };
        // `onEvent` throwing is the sanctioned way to abort (see
        // `StartDetachedResult.hookFired`): stop the command, pass it on.
        await killQuietly(handle.sandboxName, command, runSessionId);
        throw err;
      }
      if (sliceEnd !== undefined) return { sliceEnd };
      if (endedByStop) return undefined;
      // The runner's own limit ended the command: report it, never "failed".
      if (limitHit !== undefined) throw new RunLimitError(limitHit);
      if (exitCode === undefined) throw new SandboxPortError("wait");
      const finished = { exitCode };
      // The CLI ran out of turns (its own count): resumable only if the
      // runner's own distinct message-id count agrees, so a forged line
      // cannot turn a failure into a resumable end.
      const turns = guard.turnsLimit(lastResultSubtype);
      if (turns !== undefined) throw new RunLimitError(turns, lastResult?.costUsd);
      // Succeeded = exit 0 AND the last result was not an error. Anything
      // else is a failure event built here, carrying only what that last
      // result reported (if any).
      if (finished.exitCode === 0 && lastResult?.type === "result" && !trailerMissing && !launchRefused && !echoUnreadable && !fileAltered) {
        return lastResult.agentOutput === undefined && lastEnvelope !== undefined ? { ...lastResult, agentOutput: lastEnvelope } : lastResult;
      }
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
      appliedPolicy.set(recreated.name, policyDigest(params.networkPolicy));
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
    // A woken sandbox carries whatever policy its last session left; put this run's in force, confirmed, before any caller gets the handle.
    appliedPolicy.delete(name);
    await applyPolicy(woken, params.networkPolicy);
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
      // Before any SDK call (and before a token is fetched): the platform's default is allow-all, so a create carries its policy or does not happen.
      if (opts.networkPolicy === undefined) throw new SandboxPolicyRequiredError();
      const createPolicy = sdkNetworkPolicy(opts.networkPolicy);
      const vcpus = vcpusForCreate(opts);
      const creds = await credentials();
      const params: SdkCreateParams = {
        name: opts.sandboxName,
        image: sandboxImage,
        timeout: opts.timeoutMs,
        persistent: opts.retention.persistent,
        resources: { vcpus },
        tags: { "fx-sandbox": opts.sandboxName },
        networkPolicy: createPolicy,
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
        const code = providerCodeOf((err as { json?: { error?: { code?: unknown } } } | null)?.json?.error?.code);
        console.warn(JSON.stringify({ event: "sandbox.create_failed", status: statusOf(err) ?? null, code, persistent: opts.retention.persistent }));
        throw new SandboxPortError("createSandbox", statusOf(err), code);
      }
      appliedPolicy.set(created.name, policyDigest(createPolicy));
      return handleOfCreated(opts, created);
    },

    startDetached(handle, opts) {
      return launch(handle, opts, opts.prompt, undefined) as StartDetachedResult;
    },

    /**
     * D#2 RLR-4: one slice of the run-log reader. It runs the very reader `startDetached` runs (so there is one parser and one set of decisions), but
     * re-attaches to a command an earlier invocation started and begins from the saved cursor. It resolves with how the slice ended; an abort (a spend
     * kill, a limit, a reader fault) rejects exactly as `hookFired` does.
     */
    async readSlice(handle, o) {
      if (!Number.isSafeInteger(o.untilMs)) throw new Error("createVercelSandboxPort: untilMs must be an integer");
      // The reader needs only these; the rest of a launch's options (prompt, env, policy, spill, clone) has no part in a re-attach.
      const opts: StartDetachedOptions = { ...o, prompt: "", roleCard: "", networkPolicy: [], env: {}, capUsd: 1 };
      const phase = { attached: false };
      const { hookFired } = launch(handle, opts, "", undefined, o, phase);
      const ended = await hookFired.catch((err: unknown) => {
        // Before the reader has the command, a failure is a failed attach (the caller tries again), never the run's end.
        throw phase.attached ? err : new SliceAttachError(err instanceof Error ? err.name : "unknown");
      });
      if (ended !== undefined && "sliceEnd" in ended) return { kind: ended.sliceEnd };
      return { kind: "ended", event: ended };
    },

    /**
     * D#598 P1f-5a: one command to its end, no agent: the network policy (the GitHub proxy rule alone), then the program run directly with
     * its argv (no shell). A stopped sandbox is never woken. Each output stream is held to a cap and the command is killed at `timeoutMs`;
     * a failing command is a result (its exit code), a provider failure throws.
     */
    async runCommand(handle, opts) {
      assertRunCommandOptions(opts);
      assertSandboxEnvMatchesRole(opts.role, opts.env);
      if (!handle.sandboxName.startsWith("pp-")) throw new Error("createVercelSandboxPort: runCommand runs only in a pp- sandbox");
      const sandbox = await open(handle, "runCommand", false);
      if (sandbox.status !== "running") throw new SandboxPortError("runCommand");
      const sessionId = sandbox.currentSession().sessionId;
      if (typeof sessionId !== "string" || sessionId === "") throw new SandboxPortError("runCommand");
      await opts.onSession?.(sessionId);
      // The sandbox was created with this policy, so normally nothing is applied here; a different one is applied and awaited first.
      await applyPolicy(sandbox, sdkNetworkPolicy(opts.networkPolicy));
      const command = await guarded("runCommand", () => sandbox.runCommand({ cmd: opts.cmd, args: [...opts.args], env: opts.env, detached: true, signal: signal() }));
      const held = { stdout: "", stderr: "" };
      let truncated = false;
      let timedOut = false;
      const exit = await bounded(
        "runCommand",
        (async () => {
          for await (const entry of command.logs()) {
            if ((entry.stream !== "stdout" && entry.stream !== "stderr") || typeof entry.data !== "string") continue;
            const room = Math.max(RUN_COMMAND_MAX_OUTPUT_CHARS - held[entry.stream].length, 0);
            if (entry.data.length > room) truncated = true;
            held[entry.stream] += entry.data.slice(0, room);
          }
          return command.wait();
        })(),
        opts.timeoutMs,
      ).catch(async (err: unknown) => {
        timedOut = err instanceof SandboxPortError && err.status === undefined;
        await killQuietly(handle.sandboxName, command, sessionId);
        return undefined;
      });
      return { exitCode: exit?.exitCode ?? null, timedOut, stdout: held.stdout, stderr: held.stderr, truncated, sessionId };
    },

    async writeFiles(handle, files) {
      assertWriteFiles(handle.sandboxName, files);
      const sandbox = await open(handle, "writeFiles", false);
      if (sandbox.status !== "running") throw new SandboxPortError("writeFiles");
      const list = files.map(({ path, content, mode }) => ({ path, content, ...(mode !== undefined && { mode }) }));
      await guarded("writeFiles", () => sandbox.writeFiles(list, { signal: signal() }));
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
      return launch(handle, opts, prompt, sessionId) as StartDetachedResult;
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
