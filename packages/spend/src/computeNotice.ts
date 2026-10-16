import type { BudgetUsage } from './usage.js';

/**
 * D#483 S5-k3: the notice at 80% of the compute allowance.
 *
 * This is information, not a limit. It never pauses anything: it does not change an item's stage, does not write `halted_at`, and is not
 * read by `reserve()`, so no reservation is ever denied because of it. The 100% line is the existing `compute_cap_exceeded` denial (shown
 * to the person as the `compute_cap_reached` pause); the notice and that pause never both show.
 *
 * Nothing is stored. The notice is derived from the month's usage and the cap on every read, so raising the cap above the usage removes it
 * at once, lowering the cap brings it back, and a new month (a new usage window) clears it with no one acting.
 */

/** What the notice is called. One notice exists today. */
export type ComputeNoticeCode = 'compute_allowance_80';

/** The one sentence a person reads for each notice. Fixed text: nothing a model or an author wrote reaches it. Read from here, never retyped. */
export const COMPUTE_NOTICE_SENTENCES: Readonly<Record<ComputeNoticeCode, string>> = Object.freeze({
  compute_allowance_80:
    'You have used 80% of your compute allowance this month. Work continues. Change your plan in Budget & Billing if you want more room.',
});

export interface ComputeNotice {
  code: ComputeNoticeCode;
  message: string;
}

/** The share of the cap at which the notice starts (inclusive), in whole percent. The 100% line belongs to the pause, not to this notice. */
export const COMPUTE_NOTICE_FROM_PERCENT = 80;
const CAP_PERCENT = 100;

/** Whole units of 0.0001 USD (the ledger's scale), so the 80% and 100% lines are compared exactly and not through float division. */
const units = (usd: number): number => Math.round(usd * 1e4);

/** Where a budget stands: 'none' below the line, 'notice' from 80% up to (not including) the cap, 'cap' at or past the cap. */
function standing(b: BudgetUsage): 'none' | 'notice' | 'cap' {
  const cap = units(b.limit_usd);
  if (!(cap > 0)) return 'none'; // no cap to be near
  const used = units(b.spent_usd) + units(b.reserved_usd);
  if (used * 100 >= cap * CAP_PERCENT) return 'cap';
  return used * 100 >= cap * COMPUTE_NOTICE_FROM_PERCENT ? 'notice' : 'none';
}

/**
 * The notice an account shows right now, or null. The compute allowance is the one `reserve()` enforces: a foreground and a background
 * compute budget. The notice shows when either is at 80% or more and neither has reached its cap; once a budget reaches its cap the pause is
 * what the person sees, so the notice is replaced and never shown beside it.
 */
export function computeNoticeFor(usage: { foreground_compute: BudgetUsage; background_compute: BudgetUsage }): ComputeNotice | null {
  const marks = [standing(usage.foreground_compute), standing(usage.background_compute)];
  if (marks.includes('cap') || !marks.includes('notice')) return null;
  return { code: 'compute_allowance_80', message: COMPUTE_NOTICE_SENTENCES.compute_allowance_80 };
}
