import { readFileSync } from 'node:fs';
import { resetPlanDataCache } from '@fx/plan-data';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

/** The plan-data test fixture with whole-number rates (USD per million tokens, so micro-USD per token) and, unless null, the assistant cap. Test figures only. */
export function planDataWith(cap: number | null): Json {
  const d: Json = JSON.parse(readFileSync(new URL('../../plan-data/fixtures/plan-data.fixture.json', import.meta.url), 'utf8'));
  d.pricing.claude['sonnet-5'] = { ...d.pricing.claude['sonnet-5'], inputUsdPerMTok: 7, outputUsdPerMTok: 13, cacheWriteUsdPerMTok: 17, cacheReadUsdPerMTok: 19 };
  if (cap !== null) d.assistant = { conversation_cap_usd: cap };
  return d;
}

export function usePlanData(value: Json): void {
  process.env.FX_PLAN_DATA = JSON.stringify(value);
  resetPlanDataCache();
}

export function restorePlanData(saved: string | undefined): void {
  if (saved === undefined) delete process.env.FX_PLAN_DATA;
  else process.env.FX_PLAN_DATA = saved;
  resetPlanDataCache();
}
