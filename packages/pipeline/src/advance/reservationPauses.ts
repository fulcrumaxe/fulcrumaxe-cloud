import type { Pool } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";

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
 *
 * `account_not_active` is not a pause: it keeps its existing refusal (the account cannot run anything, and a poll would not change that).
 *
 * Nothing records "this item is paused". Each poll of the wait leaves one `build_waiting` driver fact whose code is the pause (the same fact
 * the slot wait leaves), and the pause is DERIVED from the item's latest such fact: it is a pause only while that fact is fresh, the item is
 * still at a start stage and is not halted. A start that succeeds moves the item on, a different wait writes a different latest fact, a give-up
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

/** The one sentence a person reads for each pause. Fixed text: nothing a model or an author wrote reaches it. */
export const RESERVATION_PAUSE_SENTENCES: Readonly<Record<ReservationPause, string>> = Object.freeze({
  account_budget_reached: "Your monthly model budget is used up. This item starts again on its own when you raise the budget or the month resets.",
  compute_cap_reached: "This month's compute allowance is used up. This item starts again on its own when it renews or your plan allows more.",
  item_cap_reached: "This item reached its spending cap. Raise it in Roles > Limits.",
  run_limit_below_estimate: "This step needs more than the per-run limit in Roles > Limits.",
});

/**
 * How often the workflow asks again while the item is paused for a limit. Each ask that is denied leaves one `refused_spend` run row (the start is
 * keyed per attempt, see `startBuildForItem`), so this is slower than the slot wait: at five minutes a four-hour wait leaves at most 48 rows.
 * apps/web workItemAdvance BUILD_SPEND_POLL_MS; a test holds the two together.
 */
export const RESERVATION_POLL_SECONDS = 300;
/** A pause counts only while its latest `build_waiting` fact is younger than this: three polls. */
export const RESERVATION_PAUSE_WINDOW_SECONDS = 3 * RESERVATION_POLL_SECONDS;

/**
 * The pause an item is in right now, or null. Derived at read time from the item's latest `build_waiting` fact (see the header); takes no lock,
 * so it is a fair picture and not a promise. For the wait sentences S6-b shows.
 */
export async function readReservationPause(pool: Pool, accountId: string, workItemId: string): Promise<ReservationPause | null> {
  return withTenant(pool, accountId, async (client) => {
    const { rows } = await client.query<{ code: string | null }>(
      `SELECT e.code
         FROM work_items w
         JOIN LATERAL (
           SELECT x.code, x.created_at FROM work_item_driver_events x
            WHERE x.account_id = w.account_id AND x.work_item_id = w.id AND x.kind = 'build_waiting'
            ORDER BY x.seq DESC LIMIT 1
         ) e ON true
        WHERE w.id = $2 AND w.account_id = $1
          AND w.stage IN ('spec_ready', 'needs_human') AND w.halted_at IS NULL
          AND e.created_at > now() - make_interval(secs => $3::int)`,
      [accountId, workItemId, RESERVATION_PAUSE_WINDOW_SECONDS],
    );
    const code = rows[0]?.code;
    return isReservationPause(code) ? code : null;
  });
}
