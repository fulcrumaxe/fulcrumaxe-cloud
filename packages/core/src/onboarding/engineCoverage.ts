import type { PoolClient } from 'pg';
import { countLiveEnginesInTx } from './liveEngines.js';

/**
 * D#845 ON-22 (rulings 31, 32, 35.7 and 36): does the account's plan cover one more engine? The Engine plan is a quantity line item on the account's one subscription; billing mirrors the
 * quantity into `accounts.engine_quantity`, and this reads it with the account's standing and the engines live now. Everything is derived on every read, never stamped, so a renewed or
 * lowered plan changes the answer on the next read. The stored `accounts.status` is not trusted alone: whether the plan ended is computed here from the markers and the clock.
 *
 *   covered          quantity above zero, the account paying, nothing held, and fewer live engines than the quantity: one more engine may be placed.
 *   plan_required    no engine quantity at all (never bought, or no subscription): 402 `plan_required`.
 *   engine_quantity  a quantity above zero with every unit in use: 402 `engine_quantity`.
 *   plan_ended       a quantity was bought and the account is not paying: the subscription ended (`subscription_ended_at`), payment failed past the seven day grace (`past_due_since`, read
 *                    against the clock now, so a stale stored `past_due` does not count), or the subscription is in no paying standing (paused, incomplete). `engine_quantity` survives a
 *                    cancellation, so it is never read alone. Every session the plan covered stops with reason `plan` (ON-13a issues the stops and reads this state).
 *   account_held     a platform hold or a partner suspension: 402 `account_held`, nothing is placed. An owner's own pause is not this: it stays covered, and the placement checks runnability after coverage.
 *   unavailable      the plan would have to be bought and cannot be (no engine price configured or no engine plan in plan data): 503, "not available right now".
 */
export type EngineCoverage =
  | { state: 'covered'; quantity: number; live: number }
  | { state: 'plan_required' }
  | { state: 'engine_quantity'; quantity: number; live: number }
  | { state: 'plan_ended'; quantity: number; live: number }
  | { state: 'account_held' }
  | { state: 'unavailable' };

/** The states that gate a placement; `covered` has no gate. */
export type PlanGate = Exclude<EngineCoverage['state'], 'covered'>;
export const PLAN_GATES: readonly PlanGate[] = ['plan_required', 'engine_quantity', 'plan_ended', 'account_held', 'unavailable'];

export interface EngineCoverageFacts {
  /** Whether the Engine plan can be bought (an engine price configured and a price in plan data). Only matters when something must be bought. */
  offered: boolean;
  /** A platform hold or a partner suspension is set. */
  held: boolean;
  /** The subscription ended or its payment grace ran out, computed at read time (see `readEngineCoverage`). */
  ended: boolean;
  /** The stored subscription's standing is one Stripe bills on: active, trialing, or past due (a past due one whose grace ran out is `ended`, judged against the clock, not here). */
  paying: boolean;
  engineQuantity: number;
  live: number;
}

/** The coverage from its facts. Pure. */
export function engineCoverage(f: EngineCoverageFacts): EngineCoverage {
  if (f.held) return { state: 'account_held' };
  const quantity = Number.isInteger(f.engineQuantity) && f.engineQuantity > 0 ? f.engineQuantity : 0;
  if (quantity > 0 && (f.ended || !f.paying)) return { state: 'plan_ended', quantity, live: f.live };
  if (quantity === 0) return f.offered ? { state: 'plan_required' } : { state: 'unavailable' };
  if (f.live >= quantity) return f.offered ? { state: 'engine_quantity', quantity, live: f.live } : { state: 'unavailable' };
  return { state: 'covered', quantity, live: f.live };
}

/** The gate of a coverage, or null when covered. */
export const planGateOf = (c: EngineCoverage): PlanGate | null => (c.state === 'covered' ? null : c.state);

/**
 * Reads the facts inside the caller's tenant transaction (the account named on every query, on top of row security). The grace is judged by the database's own clock and the same calendar
 * interval the status derivation uses (`past_due_since > now() - interval '7 days'`), on every read, so an account whose stored `status` still says `past_due` after the grace ran out is ended.
 */
export async function readEngineCoverage(client: PoolClient, accountId: string, offered: boolean): Promise<EngineCoverage> {
  const { rows } = await client.query<{ engine_quantity: number; held: boolean; ended: boolean; paying: boolean }>(
    `SELECT engine_quantity,
            (platform_hold_at IS NOT NULL OR partner_suspended_at IS NOT NULL) AS held,
            (subscription_ended_at IS NOT NULL OR (past_due_since IS NOT NULL AND NOT (past_due_since > now() - interval '7 days'))) AS ended,
            (stripe_subscription_status IN ('active', 'trialing')
             OR (stripe_subscription_status = 'past_due' AND past_due_since IS NOT NULL)) AS paying
       FROM accounts WHERE id = $1 AND deleted_at IS NULL`,
    [accountId],
  );
  const account = rows[0];
  if (!account) return { state: 'unavailable' };
  return engineCoverage({ offered, held: account.held, ended: account.ended, paying: account.paying === true, engineQuantity: account.engine_quantity, live: await countLiveEnginesInTx(client, accountId) });
}

/** The API refusal for a coverage that does not cover another engine, with fixed copy; null when covered. A plan that ended answers `plan_required`: nothing covers a new engine. */
export interface EngineRefusal {
  status: 402 | 503;
  code: 'plan_required' | 'engine_quantity' | 'account_held' | 'engine_plan_unavailable';
  message: string;
  /** `engine_quantity` only: the numbers the "Add an engine" prompt needs (counts, no ids). */
  data?: { quantity: number; live: number };
}
export function engineCoverageRefusal(c: EngineCoverage): EngineRefusal | null {
  switch (c.state) {
    case 'covered':
      return null;
    case 'plan_required':
      return { status: 402, code: 'plan_required', message: 'Pick the Engine plan to run an engine' };
    case 'plan_ended':
      return { status: 402, code: 'plan_required', message: 'Your Engine plan ended. Renew it to place an engine' };
    case 'account_held':
      return { status: 402, code: 'account_held', message: 'This account is on hold, so an engine cannot be placed right now' };
    case 'engine_quantity':
      return { status: 402, code: 'engine_quantity', message: 'Every engine on your plan is in use. Add an engine to place another', data: { quantity: c.quantity, live: c.live } };
    case 'unavailable':
      return { status: 503, code: 'engine_plan_unavailable', message: "The Engine plan isn't available right now" };
  }
}
