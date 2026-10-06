import type { ModelRate } from './pricing.js';

/**
 * D#2605 H05: shared types for spend reservation, metering and caps.
 *
 * Three budgets, kept separate (the binding H05 amendment, 2026-09-17):
 *   - 'model'               spend on the customer's own model key. We
 *                            meter and enforce it; we never pay it.
 *   - 'foreground_compute'  our own sandbox/workflow compute, for
 *                            customer-initiated work (a Feature, a Small,
 *                            a fix round -- anything a person asked for).
 *   - 'background_compute'  our own compute for scheduled work (the loop,
 *                            quality-sweep, the analysts, docs-writer and
 *                            release-manager on a schedule).
 *
 * The independence is the point: exhausting one must never block the
 * other two. Every reservation and ledger row records which one it drew
 * on.
 */
export type Budget = 'model' | 'foreground_compute' | 'background_compute';

/** Legal values of spend_reservations.state (A8; enforced by a DB trigger
 * in migrations/0002_spend_fns.sql -- this type just mirrors it in TS). */
export type ReservationState = 'open' | 'settled' | 'released';

export type PlanId = 'starter' | 'team' | 'scale';

/** What kind of work item is being reserved for, when the caller wants
 * the per-item model cap enforced (H05 pass/fail 1, 6). `null`/omitted
 * when the run has no work item cap to check (e.g. a background sweep). */
export type WorkItemKind = 'feature' | 'small' | null;

/** Whether the work this run does was asked for by a person (foreground)
 * or started by the scheduler (background) -- decides which of the two
 * compute budgets a compute estimate draws on. Never both, never neither,
 * for a call that reserves compute at all. */
export type Trigger = 'foreground' | 'background';

export type Purpose = 'run' | 'preview';

export type ModelId = 'haiku-4.5' | 'sonnet-5' | 'opus-5';

/** Normalized per-message usage. Shape mirrors packages/runtime's
 * NormalizedUsage (H04) so a caller can pass a runtime event straight
 * through, without packages/spend depending on packages/runtime (H05's
 * file scope is packages/spend/** only). */
export interface UsageTokens {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  /** Reasoning tokens billed on top of outputTokens (do not also count them
   * there). Omitted for backends that fold them into output. */
  reasoningTokens?: number;
}

/** Which agent backend a run executes on. ModelId above is the claude-code
 * model set only; other backends are priced through tables/. */
export type Backend = 'claude-code' | 'codex' | 'opencode';

/** Rates keyed by that backend's model id. */
export type BackendPriceTable = Readonly<Record<string, ModelRate>>;

export type DenyReason =
  | 'account_not_active'
  | 'model_connection_not_ok'
  | 'per_spawn_cap_exceeded'
  | 'work_item_cap_exceeded'
  | 'model_budget_exceeded'
  | 'compute_cap_exceeded';

export interface ReservationRef {
  id: string;
  budget: Budget;
  usdReserved: number;
}

export type ReserveResult =
  | { decision: 'admit'; reservations: ReservationRef[] }
  | { decision: 'deny'; reason: DenyReason };

export type MeterDecision = 'continue' | 'kill';
