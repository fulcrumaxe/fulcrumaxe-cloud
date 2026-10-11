/**
 * The daemon's signed calls to the cloud's runner routes: claim, heartbeat, events and done. Each request body is built with
 * the protocol's message schema and each reply parsed with its reply schema (replies.ts), so a field the protocol does not
 * list is never sent and a reply it does not describe is never believed: it is an error with a closed code.
 */
import {
  ClaimMessage, ClaimRateLimitedReply, HelloMessage, ClaimReply, DoneMessage, DoneReply, DoneRetryReply, EventsMessage, EventsReply, HeartbeatMessage,
  GitTicketMessage, GitTicketReply, GIT_TICKET_PATH, HeartbeatReply, SeqNotIncreasingReply, StopReply, type ClaimCapacity, type LocalOnlyEvent, type SandboxUnavailableReason, type SignedJob, type StopReason,
} from "@fulcrumaxe/runner-protocol";
import { errorCodeOf, signedPost, type CloudReply } from "../cloud.js";
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

export type Claimed = { kind: "claimed"; signedJob: SignedJob; runId: string; leaseGeneration: number };
export type ClaimResult = Claimed | { kind: "idle"; retryAfter: number } | { kind: "rate_limited"; retryAfter: number } | CallError;
export type HeartbeatResult = { kind: "ok"; leaseExpiresAt: string } | { kind: "stop"; reason: StopReason } | CallError;
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

export interface DoneInput {
  runId: string;
  leaseGeneration: number;
  sessionId?: string | undefined;
  agentOutput?: Record<string, unknown> | undefined;
}

export interface RunnerClient {
  /** D#605 FL-2: says what this build and machine are. Best effort: the caller keeps going on any answer, and a cloud that predates `facts` answers 400. */
  hello(message: HelloMessage): Promise<{ kind: "ok" } | CallError>;
  /**
   * Asks for a run. With `sandboxUnavailable` it is the status poll of a runner that cannot sandbox a job (C16 section 1.3): the reply is
   * `retry_after` only, and a reply that carries a job is an error, never a claim, so nothing a misbehaving cloud sends can be run.
   */
  claim(sandboxUnavailable?: SandboxUnavailableReason, capacity?: ClaimCapacity): Promise<ClaimResult>;
  heartbeat(runId: string, leaseGeneration: number): Promise<HeartbeatResult>;
  events(runId: string, leaseGeneration: number, events: readonly LocalOnlyEvent[]): Promise<EventsResult>;
  done(input: DoneInput): Promise<DoneResult>;
  gitTicket(runId: string, leaseGeneration: number): Promise<GitTicketResult>;
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
      const reply = await send(HELLO_PATH, HelloMessage.parse(message));
      return reply?.status === 200 ? { kind: "ok" } : fail(reply);
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
        return "signed_job" in parsed.data
          ? { kind: "claimed", signedJob: parsed.data.signed_job, runId: parsed.data.run_id, leaseGeneration: parsed.data.lease_generation }
          : { kind: "idle", retryAfter: parsed.data.retry_after };
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
        return parsed.success ? { kind: "ok", leaseExpiresAt: parsed.data.lease_expires_at } : fail(reply, "invalid_reply");
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
      const base = { run_id: input.runId, lease_generation: input.leaseGeneration, ...(input.sessionId === undefined ? {} : { session_id: input.sessionId }) };
      // The envelope is advisory: one the protocol refuses (too large or too deep) is left out rather than failing the run.
      const withOutput = input.agentOutput === undefined ? undefined : DoneMessage.safeParse({ ...base, agentOutput: input.agentOutput });
      const message = withOutput?.success ? withOutput : DoneMessage.safeParse(base);
      if (!message.success) return fail(undefined, "invalid_message");
      const reply = await send(donePath(input.runId), message.data);
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
