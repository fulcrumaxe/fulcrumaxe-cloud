import { loadPlanData } from '@fx/plan-data';
import { computeUsd, type ModelRate } from '../pricing.js';
import type { Backend, BackendPriceTable, UsageTokens } from '../types.js';

/** A rate plus where and when it was read. */
export interface SourcedModelRate extends ModelRate {
  sourceUrl: string;
  fetchedAt: string;
}

const EMPTY: BackendPriceTable = Object.freeze({});

/** Price table per backend, read from the plan data on each call. claude-code
 * IS the claude table (same object, not a copy) so MP-MODEL and the S7 bound
 * in the runner read one source. opencode has no table yet: every opencode
 * model is unpriced and refused at admit. */
export function priceTableFor(backend: Backend): BackendPriceTable {
  const { claude, openai } = loadPlanData().pricing;
  switch (backend) {
    case 'claude-code':
      return claude;
    case 'codex':
      return openai;
    default:
      return EMPTY;
  }
}

/** Rate for (backend, model id), or undefined. Never falls back to another
 * backend's table; own-property lookup so 'constructor' etc. are unpriced. */
export function priceFor(backend: Backend, modelId: string): ModelRate | undefined {
  const table = priceTableFor(backend);
  return Object.hasOwn(table, modelId) ? table[modelId] : undefined;
}

/** What admit calls: true only when a rate exists for the pair. */
export function isPriced(backend: Backend, modelId: string): boolean {
  return priceFor(backend, modelId) !== undefined;
}

/** USD for one usage event on any backend. Throws on an unpriced pair: callers
 * must have passed isPriced at admit, and a silent 0 would under-bill. */
export function computeBackendModelUsd(backend: Backend, model: string, usage: UsageTokens): number {
  const rate = priceFor(backend, model);
  if (!rate) throw new Error(`unpriced model: ${backend}/${model}`);
  return computeUsd(rate, usage);
}
