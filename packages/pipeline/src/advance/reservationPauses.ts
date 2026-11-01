import type { Pool } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { WAITING_STAGE_POSITIONS, type WaitingStage } from "./waitingStages.js";

/**
 * D#483 S5-k1: named pauses for the reservation denials that exist today.
 *
 * When the build's run start is denied by the spend check (`reserve()`), the item does not fail. It waits, shows the limit's own name and
 * sentence, and starts when a later reservation is admitted. The four denials, and the name each one gets:
 *
 *   model_budget_exceeded    -> account_budget_reached      the account's monthly model budget
 *   compute_cap_exceeded     -> compute_cap_reached         the account's monthly compute allowance
 *   work_item_cap_exceeded   -> item_cap_reached            this item's own spending cap
 *   per_spawn_cap_exceeded   -> run_limit_below_estimate    the per-run limit is below what this step needs
 *   envelope_exceeded        -> envelope_reached            the spend envelope the person set for this approval (D#483 S5-d)
 *   model_credits_exhausted  -> model_credits_exhausted     the customer's own model credits ran out (D#483 S5-k2): the provider said so on a run, the
 *                                                           connection is recorded broken for credits, and a reconcile pass re-validates it
 *
 * `account_not_active` is not a pause: it keeps its existing refusal (the account cannot run anything, and a poll would not change that).
 *
 * Nothing records "this item is paused". Each ask of the wait leaves one waiting driver fact (`stage_waiting`, stage `build`, since D#483 S5-k1b; `build_waiting` before it) whose code is the
 * pause (the same fact the slot wait leaves), and the pause is DERIVED from the item's latest such fact: it is a pause only while that fact is fresh,
 * the item is still at a start stage and is not halted. A start that succeeds moves the item on, a different wait writes a different latest fact, a give-up
 * stops the polls, and in every case the pause is gone within the window without anyone clearing it. The wait never changes the item's stage
 * and never writes `halted_at` (a person's halt is a separate thing).
 *
 * A run already in flight is never stopped by this check: it only decides whether a NEW run may start.
 */

/** The admit denial -> the pause it becomes. A record, so a new pause fails tsc until its sentence is written. */
export const RESERVATION_DENIAL_PAUSES = Object.freeze({
  model_budget_exceeded: "account_budget_reached",
  compute_cap_exceeded: "compute_cap_reached",
  work_item_cap_exceeded: "item_cap_reached",
  per_spawn_cap_exceeded: "run_limit_below_estimate",
  envelope_exceeded: "envelope_reached",
  model_credits_exhausted: "model_credits_exhausted",
} as const);

export type ReservationDenial = keyof typeof RESERVATION_DENIAL_PAUSES;
export type ReservationPause = (typeof RESERVATION_DENIAL_PAUSES)[ReservationDenial];

export const RESERVATION_PAUSE_REASONS: readonly ReservationPause[] = Object.freeze(Object.values(RESERVATION_DENIAL_PAUSES));

export const isReservationPause = (reason: unknown): reason is ReservationPause =>
  typeof reason === "string" && (RESERVATION_PAUSE_REASONS as readonly string[]).includes(reason);

/** The pause a denial becomes, or null for anything else (`account_not_active` and every non-spend refusal keep their own handling). */
export function pauseForDenial(denial: unknown): ReservationPause | null {
  return typeof denial === "string" && Object.hasOwn(RESERVATION_DENIAL_PAUSES, denial) ? RESERVATION_DENIAL_PAUSES[denial as ReservationDenial] : null;
}

/**
 * D#483 S5-k3b-2b: a start the provider's capacity queue holds back is a wait of its own, beside the spend pauses and NOT inside `RESERVATION_DENIAL_PAUSES`. That table
 * drives spend-only things (the limit sentences, the sweep's headroom read, the four-hour first look, the merge queue's `refused_spend`), none of which apply to a wait for
 * room on our servers, so `readReservationPause` stays null for it. A start's answer is read through `startWaitFor`; a headroom check keeps `pauseForDenial`.
 * Nothing returns this reason until the gate is switched on (S5-k3b-2c).
 */
export const CAPACITY_WAIT = "waiting_for_capacity" as const;
export const CAPACITY_WAIT_REASONS: readonly (typeof CAPACITY_WAIT)[] = Object.freeze([CAPACITY_WAIT]);
export type StartWait = ReservationPause | typeof CAPACITY_WAIT;

/** The wait a START's answer becomes: the spend pause, or the capacity wait, or null for anything else (which keeps its own handling). */
export function startWaitFor(reason: unknown): StartWait | null {
  return reason === CAPACITY_WAIT ? CAPACITY_WAIT : pauseForDenial(reason);
}

/** The one sentence a person reads for each pause. Fixed text: nothing a model or an author wrote reaches it. */
export const RESERVATION_PAUSE_SENTENCES: Readonly<Record<ReservationPause, string>> = Object.freeze({
  account_budget_reached: "Your monthly model budget is used up. This item starts again on its own when you raise the budget or the month resets.",
  compute_cap_reached: "This month's compute allowance is used up. This item starts again on its own when it renews or your plan allows more.",
  item_cap_reached: "This item reached its spending cap. Raise it in Roles > Limits.",
  run_limit_below_estimate: "This step needs more than the per-run limit in Roles > Limits.",
  envelope_reached: "Paused: this item reached its spending limit. Raise the limit to continue, or stop the item.",
  model_credits_exhausted: "Your model credits ran out. Top up, and work resumes on its own.",
});

/**
 * A reviewer the runner refused for its daily run limit is a wait of its own, not a spend pause: the limit counts runs since the last UTC midnight
 * (runnerTarget.ts `runsToday`), so nothing a reviewer or a person does frees it before the day rolls over. It is deliberately NOT in `RESERVATION_PAUSE_REASONS`:
 * the workflow does not re-ask every five minutes for it and the sweep does not read the spend headroom for it. The workflow records one waiting fact and ends
 * `review_paused:runner_daily_limit`; the existing 15-minute sweep resumes the review once a UTC midnight has passed since that fact (a plain time comparison).
 * Only the review stage uses it. Every other not-started refusal keeps stopping the round.
 */
export const RUNNER_DAILY_LIMIT_PAUSE = "runner_daily_limit" as const;
export type ReviewLimitWait = typeof RUNNER_DAILY_LIMIT_PAUSE;

/** The one sentence a person reads while a review waits for the runner's daily limit. Fixed text. */
export const RUNNER_DAILY_LIMIT_SENTENCE = "This review is waiting for the runner's daily run limit. It starts again on its own after the limit resets at midnight UTC.";

/** The next UTC midnight after `from`: when the runner's daily count starts again at zero. */
export function runnerLimitResetAt(from: Date): Date {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + 1));
}

/** Whether a wait recorded at `waitedAt` has seen its reset by `now`. Pure; the sweep's whole decision for this wait. */
export const runnerLimitHasReset = (waitedAt: Date, now: Date): boolean => runnerLimitResetAt(waitedAt).getTime() <= now.getTime();

/** The envelope pause with the person's own figure in it. Fixed text and a number; a non-finite or negative amount falls back to the figureless sentence. */
export function envelopeReachedSentence(amountUsd: number): string {
  return Number.isFinite(amountUsd) && amountUsd >= 0 ? `Paused: this item reached its $${amountUsd.toFixed(2)} limit. Raise the limit to continue, or stop the item.` : RESERVATION_PAUSE_SENTENCES.envelope_reached;
}

/**
 * How often the workflow asks again while the item is paused for a limit. Each ask that is denied leaves one `refused_spend` run row (the start is
 * keyed per attempt, see `startBuildForItem`), so this is slower than the slot wait: at five minutes a four-hour wait leaves at most 48 rows.
 * apps/web workItemAdvance BUILD_SPEND_POLL_MS; a test holds the two together.
 */
export const RESERVATION_POLL_SECONDS = 300;
/**
 * D#483 S5-k1b: how often the parked-stage sweep looks again at an item whose workflow gave up waiting (apps/web vercel.json; a test holds the two together).
 * The sweep refreshes the item's waiting fact on every pass while a limit still denies the start, so the fact is never older than one pass.
 */
export const RESERVATION_SWEEP_SECONDS = 900;
/** A pause counts only while its latest waiting fact is younger than this: three sweep passes (45 minutes). A workflow in its wait refreshes it every five minutes, a parked item every fifteen. */
export const RESERVATION_PAUSE_WINDOW_SECONDS = 3 * RESERVATION_SWEEP_SECONDS;
/** A fact at least this old (two asks of the wait) has no live workflow behind it: the sweep may resume the item. */
export const RESERVATION_ORPHAN_AFTER_SECONDS = 2 * RESERVATION_POLL_SECONDS;

/**
 * The pause an item is in right now at one stage (the build by default), or null. Derived at read time from the item's latest waiting fact, of either kind
 * (`stage_waiting`, or the `build_waiting` that S5-k1 wrote, which reads as the build stage); takes no lock, so it is a fair picture and not a promise.
 * The fact counts only while it names THIS stage, the item still sits at one of that stage's positions and is not halted. For the wait sentences S6-b shows.
 */
export async function readReservationPause(pool: Pool, accountId: string, workItemId: string, stage: WaitingStage = "build"): Promise<ReservationPause | null> {
  return withTenant(pool, accountId, async (client) => {
    const { rows } = await client.query<{ code: string | null }>(
      `SELECT e.code
         FROM work_items w
         JOIN LATERAL (
           SELECT x.code, x.stage, x.created_at FROM work_item_driver_events x
            WHERE x.account_id = w.account_id AND x.work_item_id = w.id AND x.kind IN ('build_waiting', 'stage_waiting')
            ORDER BY x.seq DESC LIMIT 1
         ) e ON true
        WHERE w.id = $2 AND w.account_id = $1
          AND w.stage = ANY($4::text[]) AND w.halted_at IS NULL
          AND COALESCE(e.stage, 'build') = $5::text
          AND e.created_at > now() - make_interval(secs => $3::int)`,
      [accountId, workItemId, RESERVATION_PAUSE_WINDOW_SECONDS, [...WAITING_STAGE_POSITIONS[stage]], stage],
    );
    const code = rows[0]?.code;
    return isReservationPause(code) ? code : null;
  });
}
