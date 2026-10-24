import { RUNNER_LEASE_SECONDS } from "@fulcrumaxe/runner-protocol";
import type { RunnerReplyHints } from "@fx/core/src/pendingWork.js";

/**
 * D#6 RUNNER-PING: telling a runner that does not answer from one that is just quiet.
 *
 * A wake runner claims only on work or at its 30-minute safety slot, so its liveness window is 35 minutes, and a machine that died just after a
 * claim used to read "Online" for all of that. Two things now ask it to answer, and both are judged lazily on the next read, from values already
 * stored (the check from the no-database store, the work from the rows). Nothing polls, and an idle account writes nothing:
 *  - "Check runner now" (a person's click): the click records `sent_at` for the runner and bumps the account's wake epoch. A live runner sees the
 *    bump on its next wake check (every ~20 s) and claims. Until 60 s have passed the check is `checking`; then it is `answered` when the runner
 *    was heard from at or after `sent_at`, else `no_reply`, which stays until the runner is next heard from.
 *  - work becoming claimable: a wake runner that has left claimable work unanswered for 90 s is not answering work. That is judged in SQL, by
 *    `runnerIgnoringWorkSql` (@fx/runner), the same rule the claim's routing, the waiting notice and the wait reason use, so the fleet screen and
 *    those consumers cannot disagree. The fleet read selects it as a column; nothing here knows the 90 s.
 *
 * "Heard from" here means a request that reached the database: a hello or a claim (`runners.last_seen_at`), or a heartbeat or event batch, which
 * moves a live lease to 90 s after it. The cached wake check (`seen:<rid>`) does not count: a runner that checks but never claims is not taking work.
 * A cache miss or a failed read gives no check, and no check never flags anything: the failure mode is the behaviour before this existed.
 */

/** How long a "Check runner now" waits for a reply. */
export const RUNNER_CHECK_REPLY_MS = 60_000;

export type RunnerCheckStatus = "checking" | "answered" | "no_reply";

/** The words under "Not responding", by cause. */
export const NO_REPLY_TO_CHECK_NOTE = "no reply in 60 s";
export const NO_REPLY_TO_WORK_NOTE = "didn't pick up new work within 90 s";
/** What an answered check adds to "Online". */
export const ANSWERED_NOTE = "just now";

/** Pure. The latest time the database heard from the runner: its stamp, or a live lease's last extension (each one is 90 s from its request). */
export function lastRequestAt(lastSeenAt: Date | null, leaseUntil: Date | null): number | null {
  const fromLease = leaseUntil === null ? null : leaseUntil.getTime() - RUNNER_LEASE_SECONDS * 1000;
  const fromStamp = lastSeenAt === null ? null : lastSeenAt.getTime();
  if (fromLease === null) return fromStamp;
  if (fromStamp === null) return fromLease;
  return Math.max(fromLease, fromStamp);
}

/** Pure. Where a person's check stands, or null when none was sent (or the store lost it). */
export function checkStatusOf(sentAt: number | null, heardAt: number | null, now: number): RunnerCheckStatus | null {
  if (sentAt === null || sentAt > now) return null;
  if (heardAt !== null && heardAt >= sentAt) return "answered";
  return now - sentAt < RUNNER_CHECK_REPLY_MS ? "checking" : "no_reply";
}

/** The per-runner answer the read model applies: a check's status, and why the runner is not responding (null when it is). */
export interface RunnerReply {
  check: { status: RunnerCheckStatus; sent_at: string } | null;
  noReply: "check" | "work" | null;
}

/**
 * Pure. The reply facts of one runner from the account's hints and the SQL rule's answer (`ignoringWork`). An older runner (no wake grant) is left exactly as before: it claims every minute
 * on its own, its 120-second window already says when it stops, and a check could not make it answer any sooner.
 */
export function runnerReplyOf(input: { runnerId: string; wakeCapable: boolean; ignoringWork: boolean; lastSeenAt: Date | null; leaseUntil: Date | null; hints: RunnerReplyHints; now: Date }): RunnerReply {
  if (!input.wakeCapable) return { check: null, noReply: null };
  const now = input.now.getTime();
  const heardAt = lastRequestAt(input.lastSeenAt, input.leaseUntil);
  const sentAt = input.hints.checks.get(input.runnerId) ?? null;
  const status = checkStatusOf(sentAt, heardAt, now);
  const check = status === null || sentAt === null ? null : { status, sent_at: new Date(sentAt).toISOString() };
  if (status === "no_reply") return { check, noReply: "check" };
  return { check, noReply: input.ignoringWork ? "work" : null };
}
