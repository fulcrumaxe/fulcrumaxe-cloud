/**
 * The daemon's signed calls to the cloud's runner routes: claim, heartbeat, events and done. Each request body is built with
 * the protocol's message schema and each reply parsed with its reply schema (replies.ts), so a field the protocol does not
 * list is never sent and a reply it does not describe is never believed: it is an error with a closed code.
 */
import {
  ClaimMessage, ClaimRateLimitedReply, HelloMessage, HelloReply, ClaimReply, WAKE_CAPABILITY, type WakeGrant, DoneMessage, DoneReply, DoneRetryReply, EventsMessage, EventsReply, HeartbeatMessage,
  GitTicketMessage, GitTicketReply, GIT_TICKET_PATH, HeartbeatReply, SeqNotIncreasingReply, StopReply,
  PLANE_MERGE_CAPABILITY, PLANE_MERGE_CLAIM_PATH, PLANE_MERGE_REPORT_PATH, PLANE_MERGE_VERIFY_PATH, PlaneMergeClaimMessage, PlaneMergeClaimReply, PlaneMergeReportMessage, PlaneMergeReportReply, PlaneMergeRetryReply, PlaneMergeVerifyMessage, PlaneMergeVerifyReply,
  PLANE_PUSH_PAIRING_PATH, PLANE_PUSH_REPORT_PATH, PLANE_PUSH_TOKEN_PATH, PlanePushPairingMessage, PlanePushPairingReply, PlanePushReportMessage, PlanePushReportReply, PlanePushTokenMessage, PlanePushTokenReply, type ClaimCapacity, type ContextLedgerWire, type DoneCheck, type LocalOnlyEvent, type SandboxUnavailableReason, type SignedJob, type StopReason,
} from "@fulcrumaxe/runner-protocol";
import { errorCodeOf, signedGet, signedPost, type CloudReply } from "../cloud.js";
import { WAKE_PATH, parseWakeReply } from "./wake.js";
import type { RunnerKey } from "../keys.js";

export const HELLO_PATH = "/api/runner/hello";
export const CLAIM_PATH = "/api/runner/claim";
export const HEARTBEAT_PATH = "/api/runner/heartbeat";
export const eventsPath = (runId: string): string => `/api/runner/runs/${runId}/events`;
export const donePath = (runId: string): string => `/api/runner/runs/${runId}/done`;

/** Status 0 means the cloud could not be reached. `code` is the server's short error word, or `invalid_reply` for a reply no schema describes. */
export interface CallError {
  kind: "error";
  status: number;
  code?: string;
}

/** `wake` is the grant the reply carried (D#6 RUNNER-WAKE), absent when it carried none. */
export type Claimed = { kind: "claimed"; signedJob: SignedJob; runId: string; leaseGeneration: number; wake?: WakeGrant; mergeOrder?: true };
export type ClaimResult = Claimed | { kind: "idle"; retryAfter: number; wake?: WakeGrant; mergeOrder?: true } | { kind: "rate_limited"; retryAfter: number } | CallError;
/** D#6 RUNNER-WAKE: a wake check's answer: the account's wake epoch and the earliest due time, both ms (due null when none). */
export type WakeResult = { kind: "wake"; epoch: number; dueAt: number | null } | CallError;
/** `handoff` is present only when the cloud asked for the run to move to the other side; `deadline` is the UTC instant after which it takes the last pushed commit. */
export type HeartbeatResult = { kind: "ok"; leaseExpiresAt: string; handoff?: { deadline: string } } | { kind: "stop"; reason: StopReason } | CallError;
export type EventsResult =
  | { kind: "ok"; accepted: number; duplicates: number; leaseExpiresAt: string }
  | { kind: "stop"; reason: StopReason }
  | { kind: "seq_not_increasing"; lastAcceptedSeq: number }
  | CallError;
export type DoneResult =
  | { kind: "done"; outcome: "succeeded" | "failed"; failureReason: string | null; prNumber: number | null }
  | { kind: "stop"; reason: StopReason }
  | { kind: "retry"; retryAfter: number }
  | CallError;

/** A git ticket for a cloud-verified run (D#6 R5a-3): the compact JWS, when it expires, and the proxy origin it is good for (checked against the build's pin by the caller). */
export type GitTicketResult = { kind: "ticket"; ticket: string; expiresAt: string; proxyOrigin: string } | { kind: "stop"; reason: StopReason } | CallError;

/** D#598 P1f-3: the repository's pairing as the cloud has it now (a read, no side effect). `not_paired` is the answer for a run that has no public repository. */
export type PlanePushPairingResult =
  | { kind: "pairing"; pairing: PlanePushPairingReply }
  | { kind: "not_paired" }
  | { kind: "pairing_changed" }
  | { kind: "stop"; reason: StopReason }
  | CallError;
/** D#598 P1f-3: the one restricted token, the pull request text and the commit identity. `refused` carries the closed code the cloud answered with. */
export type PlanePushTokenResult =
  | { kind: "token"; reply: PlanePushTokenReply }
  | { kind: "not_paired" }
  | { kind: "refused"; code: string }
  | { kind: "stop"; reason: StopReason }
  | CallError;
/** D#598 P1f-3: a report is a hint; `recorded` is all the reply says. */
export type PlanePushReportResult = { kind: "recorded" } | { kind: "not_paired" } | { kind: "stop"; reason: StopReason } | CallError;

/** D#6 PUBLIC-MERGE PR3: an order claimed with its bound facts and read credential. Held in memory only; nothing here is logged. */
export type PlaneMergeOrder = Extract<PlaneMergeClaimReply, { order_id: string }>;
export type PlaneMergeClaimResult = { kind: "order"; order: PlaneMergeOrder } | { kind: "none"; retryAfter: number } | { kind: "fenced" } | CallError;
export type PlaneMergeVerifyResult =
  | { kind: "go"; token: string; expiresAt: string; sha: string }
  | { kind: "no_go"; reasons: string[] }
  | { kind: "head_moved" }
  /** 409: the order is not this runner's any more (fenced, mismatch, or a credential already issued). Nothing more may be done with it. */
  | { kind: "fenced"; code?: string }
  | CallError;
export type PlaneMergeReportResult = { kind: "recorded" } | { kind: "retry"; retryAfter: number } | { kind: "fenced"; code?: string } | CallError;

/** The closed codes a token request can be refused with; any other 4xx or 5xx word is a plain `CallError`. */
const TOKEN_REFUSALS: ReadonlySet<string> = new Set(["pairing_changed", "already_issued", "attempts_exhausted", "app_not_installed", "token_scope_mismatch", "public_unavailable", "not_configured", "republish_base_missing"]);

export interface DoneInput {
  runId: string;
  leaseGeneration: number;
  sessionId?: string | undefined;
  agentOutput?: Record<string, unknown> | undefined;
  /** D#600 CX-1b: the wire form of the run's context ledger. Left out when an older cloud has refused it. */
  contextLedger?: ContextLedgerWire | undefined;
  /** D#6 R-CHK-2: how the repository's approved check ended. Present only for a job that carried a check. */
  check?: DoneCheck | undefined;
}

export interface RunnerClient {
  /** D#605 FL-2: says what this build and machine are. Best effort: the caller keeps going on any answer, and a cloud that predates `facts` answers 400. */
  hello(message: HelloMessage): Promise<{ kind: "ok"; wake?: WakeGrant } | CallError>;
  /** D#6 RUNNER-WAKE: the no-database wake check, with the token of the grant held. Never a claim: it hands out nothing. */
  wake(token: string): Promise<WakeResult>;
  /**
   * Asks for a run. With `sandboxUnavailable` it is the status poll of a runner that cannot sandbox a job (C16 section 1.3): the reply is
   * `retry_after` only, and a reply that carries a job is an error, never a claim, so nothing a misbehaving cloud sends can be run.
   */
  claim(sandboxUnavailable?: SandboxUnavailableReason, capacity?: ClaimCapacity): Promise<ClaimResult>;
  heartbeat(runId: string, leaseGeneration: number): Promise<HeartbeatResult>;
  events(runId: string, leaseGeneration: number, events: readonly LocalOnlyEvent[]): Promise<EventsResult>;
  done(input: DoneInput): Promise<DoneResult>;
  gitTicket(runId: string, leaseGeneration: number): Promise<GitTicketResult>;
  /** D#598 P1f-3. The run-end hook of an executor run on a repository paired with a public repository. */
  planePushPairing(runId: string, leaseGeneration: number): Promise<PlanePushPairingResult>;
  planePushToken(runId: string, leaseGeneration: number): Promise<PlanePushTokenResult>;
  planePushReport(message: PlanePushReportMessage): Promise<PlanePushReportResult>;
  /** D#6 PUBLIC-MERGE PR3. The three signed calls of a merge order on this runner. Used only after a claim reply said `merge_order`. */
  planeMergeClaim(): Promise<PlaneMergeClaimResult>;
  planeMergeVerify(message: PlaneMergeVerifyMessage): Promise<PlaneMergeVerifyResult>;
  planeMergeReport(message: PlaneMergeReportMessage): Promise<PlaneMergeReportResult>;
}

export interface RunnerClientConfig {
  origin: string;
  key: RunnerKey;
  now: () => Date;
  fetchFn: typeof fetch;
  /** The Vercel protection bypass secret, if set; passed to every call and sent only to `origin`. */
  bypass?: string | undefined;
}

export function createRunnerClient(config: RunnerClientConfig): RunnerClient {
  /** Set once a `done` carrying `context_ledger` is refused as an invalid message: that cloud predates the field. */
  let cloudRefusesLedger = false;
  /** One signed POST; undefined when the cloud could not be reached. */
  async function send(path: string, body: unknown): Promise<CloudReply | undefined> {
    try {
      return await signedPost({ origin: config.origin, path, body, key: config.key, now: config.now(), fetchFn: config.fetchFn, bypass: config.bypass });
    } catch {
      // fx-swallow-ok: signedPost reports a network failure in fixed words; the caller sees it as status 0 and decides whether to retry
      return undefined;
    }
  }
  const fail = (reply: CloudReply | undefined, code?: string): CallError => {
    const known = code ?? (reply === undefined ? undefined : errorCodeOf(reply.body));
    return { kind: "error", status: reply?.status ?? 0, ...(known === undefined ? {} : { code: known }) };
  };

  return {
    async hello(message) {
      const parsed = HelloMessage.parse(message);
      let reply = await send(HELLO_PATH, parsed);
      // D#6 RUNNER-WAKE: a cloud from before `wake_v1` refuses the unknown capability with 400 invalid_message and records nothing, so the same
      // hello goes again without it, and the runner works as it did before (plain claims, no grant).
      // The same for `plane_merge_v1` (D#6 PUBLIC-MERGE), in two steps so a cloud that knows `wake_v1` but not `plane_merge_v1` keeps its wake grant: the newer
      // capability is dropped alone first, and `wake_v1` goes too only if the hello is still refused.
      const refused = (r: CloudReply | undefined): boolean => r?.status === 400 && errorCodeOf(r.body) === "invalid_message";
      let dropped: string[] = [];
      for (const drop of [PLANE_MERGE_CAPABILITY, WAKE_CAPABILITY]) {
        if (!refused(reply) || !(parsed.capabilities ?? []).includes(drop)) continue;
        dropped = [...dropped, drop];
        reply = await send(HELLO_PATH, { ...parsed, capabilities: (parsed.capabilities ?? []).filter((c) => !dropped.includes(c)) });
      }
      if (reply?.status !== 200) return fail(reply);
      // The hello is best effort: a 200 whose body is not a protocol reply still counts, it just brings no grant.
      const body = HelloReply.safeParse(reply.body);
      return body.success && body.data.wake !== undefined ? { kind: "ok", wake: body.data.wake } : { kind: "ok" };
    },

    async wake(token) {
      let reply: CloudReply | undefined;
      try {
        reply = await signedGet({ origin: config.origin, path: WAKE_PATH, key: config.key, now: config.now(), fetchFn: config.fetchFn, bypass: config.bypass, headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
      } catch {
        // fx-swallow-ok: signedGet reports a network failure in fixed words; the caller counts it as a failed check
        reply = undefined;
      }
      if (reply?.status === 200) {
        const parsed = parseWakeReply(reply.body);
        return parsed === undefined ? fail(reply, "invalid_reply") : { kind: "wake", epoch: parsed.epoch, dueAt: parsed.due_at };
      }
      return fail(reply);
    },

    async claim(sandboxUnavailable, capacity) {
      // A status poll (closed sandbox) takes no job, so it declares no capacity; every other claim says what the runner could take now (D#6 C43-4).
      const reply = await send(CLAIM_PATH, ClaimMessage.parse(sandboxUnavailable !== undefined ? { sandbox_unavailable: sandboxUnavailable } : capacity === undefined ? {} : { capacity }));
      if (reply?.status === 200) {
        const parsed = ClaimReply.safeParse(reply.body);
        if (!parsed.success) return fail(reply, "invalid_reply");
        // A status poll takes no job: a reply with one is refused here, so no code path past this point can run it.
        if (sandboxUnavailable !== undefined && "signed_job" in parsed.data) return fail(reply, "invalid_reply");
        // The reply schema also refuses a claim whose `run_id` differs from the signed job's own.
        const wake = { ...(parsed.data.wake === undefined ? {} : { wake: parsed.data.wake }), ...(parsed.data.merge_order === true ? { mergeOrder: true as const } : {}) };
        return "signed_job" in parsed.data
          ? { kind: "claimed", signedJob: parsed.data.signed_job, runId: parsed.data.run_id, leaseGeneration: parsed.data.lease_generation, ...wake }
          : { kind: "idle", retryAfter: parsed.data.retry_after, ...wake };
      }
      if (reply?.status === 429) {
        const parsed = ClaimRateLimitedReply.safeParse(reply.body);
        return parsed.success ? { kind: "rate_limited", retryAfter: parsed.data.retry_after } : fail(reply, "invalid_reply");
      }
      return fail(reply);
    },

    async heartbeat(runId, leaseGeneration) {
      const reply = await send(HEARTBEAT_PATH, HeartbeatMessage.parse({ run_id: runId, lease_generation: leaseGeneration }));
      if (reply?.status === 200) {
        const parsed = HeartbeatReply.safeParse(reply.body);
        return parsed.success ? { kind: "ok", leaseExpiresAt: parsed.data.lease_expires_at, ...(parsed.data.handoff === undefined ? {} : { handoff: { deadline: parsed.data.handoff.deadline } }) } : fail(reply, "invalid_reply");
      }
      if (reply?.status === 409) {
        const parsed = StopReply.safeParse(reply.body);
        return parsed.success ? { kind: "stop", reason: parsed.data.reason } : fail(reply, "invalid_reply");
      }
      return fail(reply);
    },

    async gitTicket(runId, leaseGeneration) {
      const reply = await send(GIT_TICKET_PATH, GitTicketMessage.parse({ run_id: runId, lease_generation: leaseGeneration }));
      if (reply?.status === 200) {
        const parsed = GitTicketReply.safeParse(reply.body);
        return parsed.success ? { kind: "ticket", ticket: parsed.data.ticket, expiresAt: parsed.data.expires_at, proxyOrigin: parsed.data.proxy_origin } : fail(reply, "invalid_reply");
      }
      if (reply?.status === 409) {
        const parsed = StopReply.safeParse(reply.body);
        return parsed.success ? { kind: "stop", reason: parsed.data.reason } : fail(reply, "invalid_reply");
      }
      return fail(reply);
    },

    async planePushPairing(runId, leaseGeneration) {
      const reply = await send(PLANE_PUSH_PAIRING_PATH, PlanePushPairingMessage.parse({ run_id: runId, lease_generation: leaseGeneration }));
      if (reply?.status === 200) {
        // The reply schema recomputes the digest from the other fields: a pairing that disagrees with its own digest is an invalid reply.
        const parsed = PlanePushPairingReply.safeParse(reply.body);
        return parsed.success ? { kind: "pairing", pairing: parsed.data } : fail(reply, "invalid_reply");
      }
      if (reply?.status === 403 && errorCodeOf(reply.body) === "not_paired") return { kind: "not_paired" };
      if (reply?.status === 409) {
        const stop = StopReply.safeParse(reply.body);
        if (stop.success) return { kind: "stop", reason: stop.data.reason };
        if (errorCodeOf(reply.body) === "pairing_changed") return { kind: "pairing_changed" };
      }
      return fail(reply);
    },

    async planePushToken(runId, leaseGeneration) {
      const reply = await send(PLANE_PUSH_TOKEN_PATH, PlanePushTokenMessage.parse({ run_id: runId, lease_generation: leaseGeneration }));
      if (reply?.status === 200) {
        const parsed = PlanePushTokenReply.safeParse(reply.body);
        return parsed.success ? { kind: "token", reply: parsed.data } : fail(reply, "invalid_reply");
      }
      if (reply?.status === 403 && errorCodeOf(reply.body) === "not_paired") return { kind: "not_paired" };
      if (reply?.status === 409) {
        const stop = StopReply.safeParse(reply.body);
        if (stop.success) return { kind: "stop", reason: stop.data.reason };
      }
      const code = reply === undefined ? undefined : errorCodeOf(reply.body);
      if (reply !== undefined && [409, 502, 503].includes(reply.status) && code !== undefined && TOKEN_REFUSALS.has(code)) return { kind: "refused", code };
      return fail(reply);
    },

    async planePushReport(message) {
      const parsed = PlanePushReportMessage.safeParse(message);
      if (!parsed.success) return fail(undefined, "invalid_message");
      const reply = await send(PLANE_PUSH_REPORT_PATH, parsed.data);
      if (reply?.status === 200) return PlanePushReportReply.safeParse(reply.body).success ? { kind: "recorded" } : fail(reply, "invalid_reply");
      if (reply?.status === 403 && errorCodeOf(reply.body) === "not_paired") return { kind: "not_paired" };
      if (reply?.status === 409) {
        const stop = StopReply.safeParse(reply.body);
        if (stop.success) return { kind: "stop", reason: stop.data.reason };
      }
      return fail(reply);
    },

    async planeMergeClaim() {
      const reply = await send(PLANE_MERGE_CLAIM_PATH, PlaneMergeClaimMessage.parse({}));
      if (reply?.status === 200) {
        const parsed = PlaneMergeClaimReply.safeParse(reply.body);
        if (!parsed.success) return fail(reply, "invalid_reply");
        return "order_id" in parsed.data ? { kind: "order", order: parsed.data } : { kind: "none", retryAfter: parsed.data.retry_after };
      }
      if (reply?.status === 409) return { kind: "fenced" };
      return fail(reply);
    },

    async planeMergeVerify(message) {
      const parsed = PlaneMergeVerifyMessage.safeParse(message);
      if (!parsed.success) return fail(undefined, "invalid_message");
      const reply = await send(PLANE_MERGE_VERIFY_PATH, parsed.data);
      if (reply?.status === 200) {
        const body = PlaneMergeVerifyReply.safeParse(reply.body);
        if (!body.success) return fail(reply, "invalid_reply");
        const d = body.data;
        if (d.go) return { kind: "go", token: d.token, expiresAt: d.expires_at, sha: d.sha };
        return "head_moved" in d ? { kind: "head_moved" } : { kind: "no_go", reasons: d.reasons };
      }
      if (reply?.status === 409) {
        const code = errorCodeOf(reply.body);
        return { kind: "fenced", ...(code === undefined ? {} : { code }) };
      }
      return fail(reply);
    },

    async planeMergeReport(message) {
      const parsed = PlaneMergeReportMessage.safeParse(message);
      if (!parsed.success) return fail(undefined, "invalid_message");
      const reply = await send(PLANE_MERGE_REPORT_PATH, parsed.data);
      if (reply?.status === 200) return PlaneMergeReportReply.safeParse(reply.body).success ? { kind: "recorded" } : fail(reply, "invalid_reply");
      if (reply?.status === 503) {
        const retry = PlaneMergeRetryReply.safeParse(reply.body);
        if (retry.success) return { kind: "retry", retryAfter: retry.data.retry_after };
      }
      if (reply?.status === 409) {
        const code = errorCodeOf(reply.body);
        return { kind: "fenced", ...(code === undefined ? {} : { code }) };
      }
      return fail(reply);
    },

    async events(runId, leaseGeneration, events) {
      const reply = await send(eventsPath(runId), EventsMessage.parse({ run_id: runId, lease_generation: leaseGeneration, events }));
      if (reply?.status === 200) {
        const parsed = EventsReply.safeParse(reply.body);
        return parsed.success ? { kind: "ok", accepted: parsed.data.accepted, duplicates: parsed.data.duplicates, leaseExpiresAt: parsed.data.lease_expires_at } : fail(reply, "invalid_reply");
      }
      if (reply?.status === 409) {
        const stop = StopReply.safeParse(reply.body);
        if (stop.success) return { kind: "stop", reason: stop.data.reason };
        const behind = SeqNotIncreasingReply.safeParse(reply.body);
        return behind.success ? { kind: "seq_not_increasing", lastAcceptedSeq: behind.data.last_accepted_seq } : fail(reply, "invalid_reply");
      }
      return fail(reply);
    },

    async done(input) {
      const base = { run_id: input.runId, lease_generation: input.leaseGeneration, ...(input.sessionId === undefined ? {} : { session_id: input.sessionId }), ...(input.check === undefined ? {} : { check: input.check }) };
      // The ledger is advisory too: one the protocol refuses is left out, and so is it once an older cloud has refused the field.
      const ledger = input.contextLedger !== undefined && !cloudRefusesLedger ? { context_ledger: input.contextLedger } : {};
      const build = (extra: Record<string, unknown>) => {
        // The envelope is advisory: one the protocol refuses (too large or too deep) is left out rather than failing the run.
        const withOutput = input.agentOutput === undefined ? undefined : DoneMessage.safeParse({ ...base, ...extra, agentOutput: input.agentOutput });
        return withOutput?.success ? withOutput : DoneMessage.safeParse({ ...base, ...extra });
      };
      let message = build(ledger);
      if (!message.success && "context_ledger" in ledger) message = build({});
      if (!message.success) return fail(undefined, "invalid_message");
      let reply = await send(donePath(input.runId), message.data);
      // A cloud from before CX-1b refuses the unknown key with 400 invalid_message before it looks at the run (nothing is written), so the
      // same `done` goes again without it, and the runner stops sending it to this cloud.
      if (reply?.status === 400 && message.data.context_ledger !== undefined && errorCodeOf(reply.body) === "invalid_message") {
        cloudRefusesLedger = true;
        const without = build({});
        if (without.success) reply = await send(donePath(input.runId), without.data);
      }
      if (reply?.status === 200) {
        const parsed = DoneReply.safeParse(reply.body);
        return parsed.success ? { kind: "done", outcome: parsed.data.outcome, failureReason: parsed.data.failure_reason, prNumber: parsed.data.pr_number } : fail(reply, "invalid_reply");
      }
      if (reply?.status === 409) {
        const parsed = StopReply.safeParse(reply.body);
        return parsed.success ? { kind: "stop", reason: parsed.data.reason } : fail(reply, "invalid_reply");
      }
      if (reply?.status === 503) {
        const parsed = DoneRetryReply.safeParse(reply.body);
        // A 503 with an error body (no worker configured) is not the "GitHub could not be asked" reply: it falls through to an error.
        if (parsed.success) return { kind: "retry", retryAfter: parsed.data.retry_after };
      }
      return fail(reply);
    },
  };
}
