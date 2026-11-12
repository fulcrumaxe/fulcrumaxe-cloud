import type { PoolClient } from 'pg';

/**
 * The "Spending past an item's budget" ask offers `raise_limit`. Core cannot import `@fx/spend`, so the worker's composition root hands in the function that
 * writes the new envelope version; the answer calls it inside its own transaction, so a refused raise rolls the whole answer back and the ask stays open.
 */
export const ENVELOPE_ASK_RAISE = 'raise_limit';

/** What the person was shown: the ask's label carries the exact figure ("Raise the limit to $0.70"). That figure, and nothing larger, is what an answer raises to. */
export function raiseLimitLabel(usd: number): string {
  return `Raise the limit to $${(Math.ceil(usd * 100 - 1e-9) / 100).toFixed(2)}`;
}

/** The dollar figure the person chose, read back from the label they saw; null when the label does not carry exactly one well-formed figure. */
export function raiseLimitFromLabel(label: string): number | null {
  const m = /^Raise the limit to \$(\d{1,9}\.\d{2})$/.exec(label);
  if (m === null) return null;
  const usd = Number(m[1]);
  return Number.isFinite(usd) && usd > 0 ? usd : null;
}

/** `stale`: the envelope moved on (a new version, or none) since the ask was raised, so the old question no longer applies. `conflict`: a settings edit won the race for the next version. */
export type EnvelopeRaiseResult = 'raised' | 'already_covered' | 'over_account_budget' | 'no_envelope' | 'stale' | 'conflict';

export interface EnvelopeRaiseFacts {
  accountId: string;
  workItemId: string;
  /** The ask being answered: the raise applies only to the envelope version it was raised for. */
  askId: string;
  /** The limit the person chose. Never raised past. */
  limitUsd: number;
}
export type EnvelopeRaiser = (client: PoolClient, facts: EnvelopeRaiseFacts) => Promise<EnvelopeRaiseResult>;
