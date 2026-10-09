/**
 * What the cloud answers a runner on its signed routes (`/api/runner/*`; D#6 R2b-3, C21 section 1). This file is the whole
 * reply set: replies to session routes (approve, the runner list, the execution mode) are not protocol and live with their
 * handlers. Every schema is strict, like the messages, and none has a field that could carry a credential. The local runner
 * client is built against these.
 *
 *  - claim: 200 with a signed job and the lease generation the runner must send back on every write, or 200 `{ retry_after }`
 *    (60 seconds when nothing is waiting, 5 to 15 when work is queued but this runner cannot take it yet), or 429 `{ retry_after }`
 *    for a claim sooner than 4 seconds after the last one;
 *  - heartbeat: 200 `{ continue: true, lease_expires_at }`;
 *  - events: 200 `{ continue: true, accepted, duplicates, lease_expires_at }`, where `accepted` counts the events newly written
 *    and `duplicates` the ones the database dropped (an event already stored under that number);
 *  - every stop (heartbeat, events and done): 409 `{ continue: false, reason }`. `reason` is a closed set, derived from the
 *    run's state and never stored;
 *  - an events batch that starts at or below the last accepted number is not a stop: 409 `{ continue: true, error:
 *    "seq_not_increasing", last_accepted_seq }`, nothing in it written, and the runner drops what is at or below that number and
 *    sends the rest;
 *  - done: 200 `{ continue: false, outcome, failure_reason, pr_number }` (a repeat for the same run and generation replays
 *    what was stored), or 503 `{ retry_after }` when GitHub could not be asked and nothing was written. The route is built in a
 *    later PR; its replies are fixed here so the runner client has one set.
 */
import { z } from "zod";
import { SignedJobSchema } from "./job.js";

/** A lease lasts 90 seconds from the claim and from each heartbeat or accepted event batch. */
export const RUNNER_LEASE_SECONDS = 90;
/**
 * The whole run may take at most this long from its start: 2 hours. This is the constant of the runner class (D#6 C14
 * section 4); the worker reads the figure through `runnerLimits`, which the runner plan's data replaces (C21 section 8).
 */
export const RUNNER_MAX_RUN_WALL_CLOCK_MS = 7_200_000;
/** A runner may claim at most once in this many seconds. */
export const CLAIM_MIN_INTERVAL_SECONDS = 4;
/** `retry_after` for a claim that found nothing queued. */
export const CLAIM_IDLE_RETRY_AFTER_SECONDS = 60;
/** `retry_after` (inclusive) for a claim that found work it could not take yet. */
export const CLAIM_QUEUED_RETRY_AFTER_SECONDS = { min: 5, max: 15 } as const;
/** `retry_after` of a `done` that could not reach GitHub. */
export const DONE_RETRY_AFTER_SECONDS = 15;

const safeInt = z.number().int().safe();
const retryAfter = (max: number) => safeInt.min(1).max(max);
/** An ISO 8601 timestamp in UTC (`...Z`). */
const utcTimestamp = z.string().datetime();

/** Nothing for this runner to do right now. */
export const ClaimIdleReply = z.object({ retry_after: retryAfter(3600) }).strict();
export type ClaimIdleReply = z.infer<typeof ClaimIdleReply>;

/**
 * A run was handed out. `lease_generation` is at least 1: it counts claims, and the runner names the run's branch and every
 * later write with it. `run_id` repeats the signed job's own so a runner can key on it before it opens the job.
 */
export const ClaimedReply = z
  .object({ signed_job: SignedJobSchema, run_id: z.string().uuid(), lease_generation: safeInt.min(1) })
  .strict()
  .refine((reply) => reply.signed_job.job.run_id === reply.run_id, { message: "run_id must be the signed job's run" });
export type ClaimedReply = z.infer<typeof ClaimedReply>;

export const ClaimReply = z.union([ClaimedReply, ClaimIdleReply]);
export type ClaimReply = z.infer<typeof ClaimReply>;

/** 429: a second claim inside `CLAIM_MIN_INTERVAL_SECONDS`. */
export const ClaimRateLimitedReply = z.object({ retry_after: retryAfter(CLAIM_MIN_INTERVAL_SECONDS) }).strict();
export type ClaimRateLimitedReply = z.infer<typeof ClaimRateLimitedReply>;

/** 200 from heartbeat: the lease now ends at `lease_expires_at`. */
export const HeartbeatReply = z.object({ continue: z.literal(true), lease_expires_at: utcTimestamp }).strict();
export type HeartbeatReply = z.infer<typeof HeartbeatReply>;

/** 200 from events: `accepted` rows were newly written, `duplicates` were dropped by the database guard. */
export const EventsReply = z
  .object({ continue: z.literal(true), accepted: safeInt.min(0), duplicates: safeInt.min(0), lease_expires_at: utcTimestamp })
  .strict();
export type EventsReply = z.infer<typeof EventsReply>;

/** Why a runner no longer holds a run. Derived from the run's state and the clock; never stored. */
export const STOP_REASONS = ["stale_generation", "lease_expired", "run_terminal", "wall_clock_limit"] as const;
export type StopReason = (typeof STOP_REASONS)[number];

/** 409 from heartbeat, events and done: the runner does not hold this run any more, so it stops and discards its work. */
export const StopReply = z.object({ continue: z.literal(false), reason: z.enum(STOP_REASONS) }).strict();
export type StopReply = z.infer<typeof StopReply>;

/** 409 from events: the batch starts at or below the last accepted number. The runner carries on after trimming it. */
export const SeqNotIncreasingReply = z
  .object({ continue: z.literal(true), error: z.literal("seq_not_increasing"), last_accepted_seq: safeInt.min(0) })
  .strict();
export type SeqNotIncreasingReply = z.infer<typeof SeqNotIncreasingReply>;

/** 200 from done: the cloud's own verdict on the run. A runner reports a hint; this is what the cloud decided. */
export const DoneReply = z
  .object({ continue: z.literal(false), outcome: z.enum(["succeeded", "failed"]), failure_reason: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).nullable(), pr_number: safeInt.min(1).nullable() })
  .strict();
export type DoneReply = z.infer<typeof DoneReply>;

/** 503 from done: GitHub could not be asked, nothing was written, and the runner keeps its lease alive and sends done again. */
export const DoneRetryReply = z.object({ retry_after: retryAfter(3600) }).strict();
export type DoneRetryReply = z.infer<typeof DoneRetryReply>;

/**
 * 200 from git-ticket (D#6 R5a-2b, C27 section 1.2): a compact JWS the cloud signed for this one run, valid for 5 minutes, and the
 * origin of the GitHub proxy it is good for. The cloud issues it and it names one run, so it is not a credential channel from the
 * runner (G1 bars those); the field is called `ticket` for that reason. The runner trusts `proxy_origin` only if its own pinned table lists it.
 */
export const GIT_TICKET_LIFETIME_SECONDS = 300;
export const GitTicketReply = z
  .object({
    ticket: z.string().max(2048).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
    expires_at: utcTimestamp,
    proxy_origin: z.string().max(256).regex(/^https:\/\/[^\s/?#@]+$/),
  })
  .strict();
export type GitTicketReply = z.infer<typeof GitTicketReply>;

/** The complete set of runner-route replies. A test pins these keys. */
export const RUNNER_REPLIES = {
  claim: ClaimReply,
  claim_rate_limited: ClaimRateLimitedReply,
  heartbeat: HeartbeatReply,
  git_ticket: GitTicketReply,
  events: EventsReply,
  stop: StopReply,
  seq_not_increasing: SeqNotIncreasingReply,
  done: DoneReply,
  done_retry: DoneRetryReply,
} as const;
