/**
 * H04: Model/runtime adapter — shared interface.
 *
 * One `AgentRuntime` shape, three implementations:
 *   - local   (`src/local`)      — owner's subscription, dev/test only, owner's repos only
 *   - production (`src/production`) — Vercel Sandbox + the tenant's own model key
 *   - fake    (`src/fake`)       — replays a recorded fixture, zero model tokens
 *
 * `selectRuntime` (`src/select.ts`) is the only place that decides which one runs.
 */

/** Per-message token/cost usage, normalized across providers. */
export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
}

/**
 * D#2 PREVIEW-RUNNER-EVENTS: the reduced tool-activity types. Declared here, next to `NormalizedEvent` that carries
 * them. Their functions (the reducers that build them from `stream-json` lines) stay in `@fx/runtime`'s private
 * `toolActivity.ts`, which imports these types from this package and re-exports them.
 */
export type ActivityTool = "read" | "list" | "search" | "test" | "command";

/** One tool-use block, reduced. `writes` marks a block that edits or creates a file; `clone` a shell command that clones a repository. */
export interface ToolUse {
  id: string;
  tool?: ActivityTool;
  path?: string;
  pattern?: string;
  writes?: true;
  clone?: true;
  /** A shell command's first line, capped and without control characters, present only when the whole command is clean (`commandIsClean`). The recorder checks it again. */
  command?: string;
}

/** One tool-result block, reduced: which tool-use it answers and whether it succeeded. */
export interface ToolResult {
  id: string;
  ok: boolean;
}

/**
 * One normalized event in an agent run's event stream. This is the shape
 * every runtime emits through `onEvent`, and the shape fixture `.jsonl`
 * files store one-per-line — the fake runner replays these verbatim.
 */
export interface NormalizedEvent {
  runId: string;
  role: string;
  seq: number;
  type: "system" | "assistant" | "user" | "result" | "error";
  ts: string;
  sessionId?: string;
  /**
   * An `assistant` event's model message id (`message.id` of the raw
   * `stream-json` line). Several lines of one message share it and repeat
   * its usage, so a meter keys on it rather than summing per line.
   */
  messageId?: string;
  /**
   * An `assistant` event's `message.model`, kept only when it is a non-empty
   * string of at most 128 characters. Untrusted: a meter may only use it to
   * price a message HIGHER than the run's own model, never lower.
   */
  messageModel?: string;
  text?: string;
  usage?: NormalizedUsage;
  costUsd?: number;
  isError?: boolean;
  /**
   * The parsed `<!-- AGENT_OUTPUT -->` JSON envelope, present only on the
   * final `result` event of a run that emitted one.
   */
  agentOutput?: Record<string, unknown>;
  /**
   * D#2 PREVIEW-RUNNER-EVENTS: an `assistant` event's tool-use blocks, REDUCED (see `toolActivity.ts`): an id, one of
   * five coarse kinds, and at most a repo-relative path or a short search term. Never raw tool input.
   */
  toolUses?: ToolUse[];
  /** True on an `assistant` event whose text opens the `<!-- AGENT_OUTPUT -->` envelope: the agent has started writing its result. Never the text itself. */
  writesResult?: true;
  /** A `user` event's tool-result blocks, reduced to `{ id, ok }`. Result content is never read. */
  toolResults?: ToolResult[];
}

export type ModelProvider = "ai_gateway" | "anthropic";

/** Where the production runner's sandbox should send model traffic. */
export interface SandboxSpec {
  sandboxName: string;
  provider: ModelProvider;
  /** Model endpoint base URL the sandbox process is configured with. */
  baseUrl: string;
  tenantId: string;
  /**
   * True only for the operator-subscription path: the sandbox's CLI holds the fixed
   * placeholder (never a token) and the firewall injects our own subscription token.
   * The guard allows `CLAUDE_CODE_OAUTH_TOKEN` in `env` only in this mode, only with that
   * placeholder, and only toward the Anthropic API default. See operatorSubscription.ts.
   */
  operatorSubscription?: true;
  /**
   * Env vars the caller intends to set inside the sandbox. The production
   * guard inspects this for a subscription-only credential and refuses
   * construction if one is present — see `src/production/guard.ts`.
   */
  env?: Record<string, string>;
}

export interface StartOptions {
  runId: string;
  role: string;
  roleCard: string;
  prompt: string;
  model: string;
  /** Local runner: a workdir (a clone standing in for the sandbox). */
  workdir?: string;
  /** Production runner: the sandbox to run in. */
  sandboxSpec?: SandboxSpec;
  capUsd: number;
  /** D#2 H09b2 fix round 1 (S-MUST 2): may return a promise. Every
   * `AgentRuntime.start`/`resume` implementation MUST `await` this before
   * moving on to the next event -- a mid-run kill decision now needs a
   * lock-protected Postgres round trip (`sandboxTarget.ts`'s
   * `meterModelUnderLock`) before it can throw to abort, and that only
   * lands in time if the caller waits for it. */
  onEvent: (event: NormalizedEvent) => void | Promise<void>;
}

/** Opaque handle returned by `start`/`resume`. Callers pass it back into
 * `stop`/`resume` unchanged; only the runtime that issued it interprets it. */
export interface AgentHandle {
  runId: string;
  sessionId?: string;
  [key: string]: unknown;
}

export interface AgentRuntime {
  start(opts: StartOptions): Promise<{ handle: AgentHandle }>;
  stop(handle: AgentHandle): Promise<void>;
  resume(
    handle: AgentHandle,
    sessionId: string,
    prompt: string,
  ): Promise<{ handle: AgentHandle }>;
}

/** Thrown by the local runner's constructor when the process env indicates
 * it is not running on the owner's own machine (Spec H04 pass/fail 1). */
export class LocalRunnerRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalRunnerRefused";
  }
}

/** Thrown by the production runner's constructor or `start` when it detects
 * subscription-only credentials, an unrecognized model endpoint, or a
 * tenant model connection that is not `ok` (Spec H04 pass/fail 2). */
export class SubscriptionCredentialsRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubscriptionCredentialsRefused";
  }
}

/** Status of a tenant's stored model connection, as looked up by the
 * caller-supplied `getConnectionStatus` dependency (see `src/production`). */
export type ModelConnectionStatus = "ok" | "unvalidated" | "broken" | "unknown";
