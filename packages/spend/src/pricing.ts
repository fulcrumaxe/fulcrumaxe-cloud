import { loadPlanData } from '@fx/plan-data';
import type { ModelId, UsageTokens } from './types.js';

/**
 * Per-MTok USD rates, by model. The figures are private: they are read from
 * the plan data (`loadPlanData()`, the FX_PLAN_DATA setting) on every call,
 * never compiled in. When the setting is missing the loader throws
 * PlanDataMissingError and nothing here substitutes a default (D#536).
 */
export interface ModelRate {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  cacheWriteUsdPerMTok: number;
  cacheReadUsdPerMTok: number;
  /** Optional separate rate for reasoning tokens. When absent, reasoning
   * tokens are billed at outputUsdPerMTok (the rule for every table today:
   * vendors bill reasoning as output). */
  reasoningUsdPerMTok?: number;
  /** True only for a pair that was derived rather than posted directly. */
  cacheRatesProvisional?: boolean;
}

/** The claude-code price table, straight from the plan data (the same object each call). */
export function claudePricing(): Readonly<Record<ModelId, ModelRate>> {
  return loadPlanData().pricing.claude;
}

/** When the price tables were last read from the vendors. */
export function pricingFetchedAt(): string {
  return loadPlanData().pricing.fetchedAt;
}

/** The ids of every claude-code model that has a price. */
export function claudeModelIds(): ModelId[] {
  return Object.keys(claudePricing()) as ModelId[];
}

/** True for an id that has a claude-code price (own-property check, so 'constructor' is not one). */
export function isClaudeModelId(model: string): model is ModelId {
  return Object.hasOwn(claudePricing(), model);
}

const MTOK = 1_000_000;

/** USD cost of one usage event, given the model it ran on. Pure apart from
 * the (cached) plan-data read -- meter() calls this per event on a hot path,
 * with no Postgres access needed (Spec H05 pass/fail 3). */
export function computeModelUsd(model: ModelId, usage: UsageTokens): number {
  return computeUsd(claudePricing()[model], usage);
}

/** USD cost of one usage event at an explicit rate. `reasoningTokens` are
 * billed IN ADDITION to outputTokens (the caller must not also count them in
 * outputTokens), at the rate's reasoning rate or, if it has none, its output
 * rate. */
export function computeUsd(rate: ModelRate, usage: UsageTokens): number {
  const usd =
    (usage.inputTokens / MTOK) * rate.inputUsdPerMTok +
    (usage.outputTokens / MTOK) * rate.outputUsdPerMTok +
    ((usage.cacheWriteTokens ?? 0) / MTOK) * rate.cacheWriteUsdPerMTok +
    ((usage.cacheReadTokens ?? 0) / MTOK) * rate.cacheReadUsdPerMTok +
    ((usage.reasoningTokens ?? 0) / MTOK) * (rate.reasoningUsdPerMTok ?? rate.outputUsdPerMTok);
  // Round to the same 4-decimal-place precision as ledger.usd/
  // spend_reservations.usd_reserved (numeric(10,4)).
  return Math.round(usd * 10_000) / 10_000;
}

/** Sandbox compute rates: USD per CPU-hour, per GB-hour of memory, and per GB of data transfer. */
export interface SandboxRates {
  cpuUsdPerHour: number;
  memUsdPerGbHour: number;
  dataTransferUsdPerGb: number;
}

export function sandboxRates(): SandboxRates {
  return loadPlanData().pricing.sandbox;
}

/** USD cost of one run's sandbox+workflow compute usage so far. */
export function computeComputeUsd(seconds: number, vcpu: number, memGb: number): number {
  const rates = sandboxRates();
  const hours = seconds / 3600;
  const usd = hours * (vcpu * rates.cpuUsdPerHour + memGb * rates.memUsdPerGbHour);
  return Math.round(usd * 10_000) / 10_000;
}
