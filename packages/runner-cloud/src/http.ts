import type { Pool } from "pg";
import { CURRENT_PROTOCOL_VERSION, MAX_CREATED_SKEW_SECONDS, MIN_SUPPORTED_PROTOCOL_VERSION, type ClaimCapacity, type ContextLedgerBody, type DoneCheck, type Job, type LocalOnlyEvent, type SignedJob, type StopReason } from "@fulcrumaxe/runner-protocol";
import { reportError } from "@fx/telemetry";
import type { RunPullRequestPort } from "./runPullRequest.js";
import type { RunnerSeenReader } from "./wakeSeen.js";

/** The framework-free request and response the runner handlers speak. apps/web adapts `Request` and `NextResponse` to these. */
export interface RunnerHttpRequest {
  method: string;
  /** Header fields by lower-case name. */
  headers: Readonly<Record<string, string | undefined>>;
  body: Uint8Array;
  /** The client address the edge saw (display only, never an identity): set by the route from the same headers the rate limit reads. Absent in a test that sends none. */
  clientIp?: string;
}

export interface RunnerHttpResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** A refusal with a fixed status and code. Messages are fixed text, never an argument value or a database message. */
export class RunnerHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string = code,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "RunnerHttpError";
  }
}

export const errorResponse = (error: RunnerHttpError): RunnerHttpResponse => ({
  status: error.status,
  body: { error: { code: error.code, message: error.message }, ...error.extra },
});

/**
 * Runs a handler and turns whatever it throws into the response a route sends. A refusal keeps its fixed status and
 * code; anything else is a bare 500, so no database or library message ever reaches a runner.
 */
export async function toResponse(run: () => Promise<RunnerHttpResponse>): Promise<RunnerHttpResponse> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof RunnerHttpError) return errorResponse(error);
    // The reporter logs the error's name and code, never its message (which may carry values from the request or the database).
    reportError(error, { stage: "runner.unhandled", route: "/api/runner" });
    return errorResponse(new RunnerHttpError(500, "internal", "internal error"));
  }
}

/** Any request body over this gets 413 before its signature is looked at (criterion 9). */
export const MAX_BODY_BYTES = 256 * 1024;
/** A runner key older than this must be re-registered (criterion 6). */
export const MAX_KEY_AGE_DAYS = 90;
/**
 * How long a seen nonce is remembered, derived from the signature's own skew bound. A signature stays acceptable from
 * `created - skew` to `created + skew`, so a request first seen at the early edge can be replayed for twice the skew;
 * add a minute for the second the clock is read in and for clock steps. 180 with the current bound. The database
 * refuses anything shorter than 180 (migration 0724), so lowering the bound cannot quietly shorten the memory below it.
 */
export const NONCE_RETENTION_SECONDS = 2 * MAX_CREATED_SKEW_SECONDS + 60;
/** The protocol version this cloud speaks (one constant in runner-protocol, which fx-runner sends on hello too, so a bump moves both). A `hello` outside `MIN_SUPPORTED_PROTOCOL_VERSION` to current gets 426 (criterion 10). */
export { CURRENT_PROTOCOL_VERSION, MIN_SUPPORTED_PROTOCOL_VERSION };

/** What the handlers need from the outside. Everything that varies in tests is here. */
export interface RunnerCloudDeps {
  /**
   * The web tier's login: tenant work and every SECURITY DEFINER function (0712, 0724). This package never holds the
   * platform_ops login; a test scans the source to keep it that way.
   */
  appUserPool: Pool;
  /** The configured public origin (FX_APP_ORIGIN). The only source of the URL a signature is checked against. */
  origin: string | undefined;
  /** The worker's lease-fail method, or null while no worker is configured. Called after a revoke has committed. */
  failRunnerLeases: FailRunnerLeases | null;
  /**
   * The worker's claim, heartbeat and events methods (D#6 R2b-3), or null while no worker is configured (the routes then answer
   * 503). They write `agent_runs`, which only the worker's login may do, so this package never holds that login.
   */
  leases?: RunnerLeaseOps | null;
  /**
   * The GitHub side of a runner's `done` for an executor run (D#6 R2b-3f): the one object that talks to GitHub about a `runner_local`
   * repository, through the local-only allowlist. Null while it is not configured; an executor's `done` is then 503 `not_configured`
   * and nothing is written. A reviewer's `done` needs no GitHub call and works without it.
   */
  pullRequests?: RunPullRequestPort | null;
  /** D#598 P1f-2: the GitHub access of the public-push routes. Null while it is not configured; those routes then answer 503 `not_configured`. */
  planePush?: PlanePushHostedPort | null;
  /**
   * D#598 P1f-2b: the platform's commit identity for a public push, read from the hosted settings on each call (apps/web supplies it from
   * `readPlanePushIdentity(process.env)`). Null, or absent, while a setting is missing or malformed: the token route then answers 503 `not_configured`
   * BEFORE it writes an attempt row or mints a token.
   */
  planePushIdentity?: (() => { name: string; email: string } | null) | null;
  /**
   * D#6 RUNNER-WAKE R3a: the HMAC key the wake token is minted with (apps/web reads FX_RUNNER_WAKE_KEY on each call, `readWakeKey`). Null, absent or
   * throwing: no grant is minted and hello and claim answer exactly as before.
   */
  wakeKey?: (() => Buffer | null) | null;
  /**
   * D#6 RUNNER-WAKE: reads the cached `seen:<rid>` stamps the wake endpoint writes (wakeSeen.ts), so the fleet read can count a wake-capable
   * runner's checks as contact. Absent: the database stamp alone decides, as before.
   */
  runnerSeen?: RunnerSeenReader | null;
  /** Where `done` writes its one-line JSON diagnostics for a pull request failure (default: `console.warn`). Tests inject a collector. */
  log?: (line: string) => void;
  /** The clock. Tests inject a fixed one. */
  now?: () => Date;
  /** The protocol version `hello` is judged against. Defaults to the constant. */
  currentProtocolVersion?: number;
  /** The oldest protocol version `hello` accepts. Defaults to the constant. */
  minSupportedProtocolVersion?: number;
  /**
   * The most active runners an account on this plan may hold, read from the plan data (D#6 R2b criterion 12; every plan
   * has one since D#605 FL-12a). Throws while the plan data is unavailable or has no figure for the plan: registering then
   * answers 503 and registers nothing. Absent is the same as unavailable. Never a null: no plan is unlimited.
   */
  maxRunners?: (plan: string) => number;
  /**
   * D#6 C42-3: the most runner runs an account may have running at once, in all and of the heavy class (plan data; the figures the claim refuses
   * against). Read only to tell a waiting run that an account cap holds it. Absent, or throwing while the plan data is unavailable, it names no cap.
   */
  accountRunnerCaps?: (accountId: string) => { total: number; heavy: number };
  /**
   * D#605 FL-9: the plan's figure for the runner jobs an account may have running at once, for the fleet page's account line: the runner plan's flat
   * figure (`hosted: false`), or a hosted plan's default, which the account's own setting replaces (`hosted: true`). Throws while the plan data cannot
   * say; the page then shows no limit. Absent is the same.
   */
  accountJobLimit?: (plan: string) => { jobs: number; hosted: boolean };
  /**
   * Whether a repository is private, asked of GitHub (apps/web supplies it). Anything but "private" keeps a repo off a
   * runner. Absent is "unknown".
   */
  repoVisibility?: (accountId: string, repoId: string, signal?: AbortSignal) => Promise<"private" | "public" | "unknown">;
  /** Test seam: the deadline for one visibility read (default `REPO_VISIBILITY_READ_TIMEOUT_MS`). Past it the read is "unknown". */
  repoVisibilityTimeoutMs?: number;
  /** Test seam: the deadline for all of one request's visibility reads together (default `REPO_VISIBILITY_TOTAL_TIMEOUT_MS`). */
  repoVisibilityTotalTimeoutMs?: number;
  /**
   * D#6 R-CHK-1: the text of `.fulcrumaxe/runner-sandbox.json` at the repository's default branch tip, or null when there is none (apps/web supplies it from the
   * read-only plan client). Read only to pre-fill the Repos form with a SUGGESTED check for an owner or admin; nothing it returns is ever used to run anything.
   * Absent, or throwing, the suggestion is "unavailable".
   */
  readAllowanceFile?: (target: { repoId: string; owner: string; name: string }) => Promise<string | null>;
}

/**
 * D#598 P1f-2: the hosted side's GitHub access to a paired PUBLIC repo (apps/web supplies it from `@fx/github`'s `createHostedPlanePush`). The only
 * place a restricted token is minted, and the only place a runner's report is checked against GitHub. Failures are thrown with a fixed `code`
 * (`app_not_installed`, `token_scope_mismatch`, `public_unavailable`). It holds no clone or push code and runs no process.
 */
export interface PlanePushHostedPort {
  /** A fresh, never-cached token for one repository, and the time the runner may rely on it until. */
  mintToken(codeRepo: string, accountId: string): Promise<{ token: string; expiresAt: Date }>;
  /** True only if the branch head is `headSha`, its single parent is `tipSha`, and `tipSha` is in public main's history. */
  verifyPushed(input: { accountId: string; codeRepo: string; branch: string; headSha: string; tipSha: string }): Promise<boolean>;
  /** The pull request's address if it is OPEN with head ref `branch` in `codeRepo` itself, base `main` and an address in `codeRepo`; otherwise null. */
  verifyPullRequest(input: { accountId: string; codeRepo: string; branch: string; number: number }): Promise<{ url: string } | null>;
  /** Revokes a token this side minted and could not hand out. True when it is gone (revoked, or already invalid); never throws. */
  revokeToken(token: string): Promise<boolean>;
}

export type FailRunnerLeases = (input: { accountId: string; runnerId: string; reason: "runner_revoked" }) => Promise<{ runIds: string[]; complete: boolean }>;

/**
 * What the lease routes ask of the worker, as plain data (the shapes of packages/worker `RunnerClaimFacade`, which this
 * package cannot import: the worker depends on it). `accountId` and `runnerId` are always the verified runner's.
 */
export interface RunnerLeaseOps {
  claimRunnerRun(input: { accountId: string; runnerId: string; capacity?: ClaimCapacity }): Promise<
    { kind: "claimed"; signedJob: SignedJob; runId: string; leaseGeneration: number } | { kind: "idle"; retryAfter: number }
  >;
  heartbeatRunnerRun(input: { accountId: string; runnerId: string; runId: string; leaseGeneration: number }): Promise<
    { verdict: "ok"; leaseExpiresAt: Date } | { verdict: string; reason: StopReason }
  >;
  ingestRunnerEvents(input: { accountId: string; runnerId: string; runId: string; leaseGeneration: number; events: readonly LocalOnlyEvent[] }): Promise<
    | { outcome: "accepted"; stored: number; duplicates: number; leaseExpiresAt: Date; /** Why the batch ended the run, when it did (D#6 C43-6 reads `usage_limit`). Absent from an older worker. */ ended?: string | null }
    | { outcome: "seq_order" }
    | { outcome: "seq_not_increasing"; lastAcceptedSeq: number }
    | { outcome: "fenced"; reason: StopReason }
  >;
  /** `done`, first half: the fence, with the lease extended. `proceed`, a stop, or the verdict this runner's earlier `done` stored. */
  beginRunnerDone(input: { accountId: string; runnerId: string; runId: string; leaseGeneration: number }): Promise<
    { kind: "proceed" } | { kind: "fenced"; reason: StopReason } | { kind: "replay"; verdict: RunnerDoneStored }
  >;
  /**
   * `git-ticket`, first half (D#6 R5a-2b, C27 section 1.1): the fence WITHOUT extending the lease, then the run's own facts. A stop, or the
   * role, runtime, own execution mode, dispatch repository and signed job the route decides on.
   */
  gitTicketContext(input: { accountId: string; runnerId: string; runId: string; leaseGeneration: number }): Promise<
    | { kind: "fenced"; reason: StopReason }
    | { kind: "context"; role: string; runtime: string; executionMode: string; repo: { id: string; owner: string; name: string } | null; job: Job | null; boundBranch?: string | null }
  >;
  /** `git-ticket`, second half: the signed ticket, or null while the signing key or the forward host is not configured (the route then answers 503). */
  signGitTicket(input: { issuer: string; runnerId: string; accountId: string; runId: string; leaseGeneration: number; repo: { id: string; owner: string; name: string }; ref: string }): Promise<{ ticket: string; expiresAt: Date; proxyOrigin: string } | null>;
  /**
   * D#598 P1f-2: the public-push token and report routes (see packages/worker `RunnerPlanePushFacade`, which this package cannot import). Absent from an
   * older worker: the routes then answer 503 `not_configured`.
   */
  planePushGrant?(input: { accountId: string; runnerId: string; runId: string; leaseGeneration: number }): Promise<
    | { kind: "fenced"; reason: StopReason }
    | { kind: "not_paired" }
    | { kind: "pairing_changed" }
    | { kind: "already_issued" }
    | { kind: "attempts_exhausted" }
    | { kind: "refused"; code: string }
    | { kind: "granted"; attemptId: string; id: string; codeRepo: string; branch: string; itemTitle: string; prFooter: string | null; issueNumber: number | null; updateOf: string | null }
  >;
  /** D#598 P1f-2b: the repository's live pairing, only while its digest equals the build-start stamp. Read-only; the hook calls it twice. */
  planePushPairing?(input: { accountId: string; runnerId: string; runId: string; leaseGeneration: number }): Promise<
    | { kind: "fenced"; reason: StopReason }
    | { kind: "not_paired" }
    | { kind: "pairing_changed" }
    | { kind: "pairing"; codeRepo: string; overlayGlobs: string[]; identifierRulesPath: string | null; planDataRulesPath: string | null; pairingDigest: string }
  >;
  planePushSettleGrant?(
    input: { accountId: string; runnerId: string; runId: string; leaseGeneration: number; attemptId: string } & ({ issued: true } | { issued: false; code: string }),
  ): Promise<boolean>;
  planePushReportContext?(input: { accountId: string; runnerId: string; runId: string; leaseGeneration: number }): Promise<
    | { kind: "fenced"; reason: StopReason }
    | { kind: "not_paired" }
    | { kind: "context"; plane: { id: string; codeRepo: string; branch: string; state: string; pairingDigest: string }; attempt: { id: string; tokenIssued: boolean; finished: boolean; outcome: string | null } | null }
  >;
  planePushRecordReport?(input: {
    accountId: string;
    runnerId: string;
    runId: string;
    leaseGeneration: number;
    planePushId: string;
    outcome: {
      state: "scanning" | "pushed" | "pr_opened" | "refused" | "pushed_pr_not_opened" | "no_public_change" | "updated";
      code?: string;
      refusals?: ReadonlyArray<{ kind: string; place: string; rule_key: string }>;
      headSha?: string;
      tipSha?: string;
      prNumber?: number;
      prUrl?: string;
    } | null;
    terminal: boolean;
    label: string;
    tokenRevoked?: boolean;
  }): Promise<{ kind: "fenced"; reason: StopReason } | { kind: "not_paired" } | { kind: "recorded"; recorded: boolean }>;
  /**
   * D#599 HO-2b: `done` from a run that has a live handoff finishes the handoff instead of judging the run: the parent ends handed off (it
   * has no result of its own) and the new run is made on the other side. `none` means no handoff was live and the ordinary `done` goes on;
   * `retry` means GitHub could not be asked and nothing was written. Absent from an older worker.
   */
  completeHandoffOnDone?(input: { accountId: string; runnerId: string; runId: string; leaseGeneration: number }): Promise<{ kind: "completed" } | { kind: "none" } | { kind: "retry" } | { kind: "fenced"; reason: StopReason }>;
  /** `done`, second half: records the cloud's verdict under the fence, in one transaction. */
  finishRunnerDone(input: {
    accountId: string;
    runnerId: string;
    runId: string;
    leaseGeneration: number;
    verdict: RunnerDoneStored;
    sessionId?: string;
    agentOutput?: Record<string, unknown>;
    /** The runner's context ledger (D#600 CX-1b), already schema-checked; absent from an older runner. */
    contextLedger?: ContextLedgerBody;
    /** D#6 R-CHK-3: the check result, passed on only when the run's own signed job carried a check; recorded with the verdict. */
    check?: DoneCheck;
  }): Promise<{ kind: "recorded"; verdict: RunnerDoneStored } | { kind: "fenced"; reason: StopReason } | { kind: "replay"; verdict: RunnerDoneStored }>;
}

/** What a finished-by-`done` run stored (the shape of packages/worker `RunnerDoneVerdict`, which this package cannot import). */
export interface RunnerDoneStored {
  outcome: "succeeded" | "failed";
  failureReason: "no_commit" | "scope_unknown" | "scope_violation" | "pr_rejected" | "internal_error" | "taken_over" | "check_failed" | null;
  prNumber: number | null;
  /** The run branch the verdict was judged on (`fx/<run>-g<generation>` for a fresh run, a continuation's own branch otherwise); set exactly when `prNumber` is (C25 section 1.2). */
  branch?: string;
  /** D#598 P1f-5c: the run branch's head as the cloud read it from GitHub when it judged the run (never from the runner). Set with `prNumber`; the branch cleanup deletes the branch only while its head is still this commit. */
  headOid?: string;
  prHttpStatus?: number;
  /** Why a `scope_unknown` ended the run, where that matters to the words shown: a renamed file, or a change type GitHub reported that the port does not know. */
  detail?: "renamed" | "unknown_change_type" | "no_file_list";
}

/** The leases object, or 503 when the worker is not configured. */
export function requireLeases(deps: RunnerCloudDeps): RunnerLeaseOps {
  if (!deps.leases) throw new RunnerHttpError(503, "not_configured", "the runner API has no worker configured");
  return deps.leases;
}

/** A refusal the worker made on purpose (42501: the runner is gone or revoked) is the same 401 as any unverified request. */
export async function asRunner<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (pgCode(error) === "42501") throw new RunnerHttpError(401, "unauthorized", "the request is not signed by a registered runner");
    throw error;
  }
}

/** The body as JSON, or 400. */
export function parseJsonBody(req: RunnerHttpRequest): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(req.body));
  } catch {
    throw new RunnerHttpError(400, "invalid_json", "the body is not valid JSON");
  }
}

/** Parses `value` with a strict message schema, or throws 400. The schema's own error text is never echoed. */
export function parseMessage<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new RunnerHttpError(400, "invalid_message", "the message does not match the protocol");
  return result.data;
}

/** The signed-in user a session route acts for. Always taken from the verified session, never from the request. */
export interface SessionPrincipal {
  accountId: string;
  userId: string;
}

/** The Postgres error code of a thrown error, if it has one. */
export const pgCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : undefined;
