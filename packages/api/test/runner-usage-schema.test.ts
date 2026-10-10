import { describe, expect, it } from 'vitest';
import { runResponseSchema, runnerUsageSchema } from '../src/routes/runs.js';
import { runInsightResponseSchema } from '../src/routes/run-insight.js';
import { workItemResponseSchema } from '../src/routes/work-items.js';
import { usageResponseSchema } from '../src/routes/billing.js';

/**
 * Schema-level checks for the runner usage figures. The worker's Postgres test
 * (packages/worker/test/runnerUsage.pg.test.ts) used to parse the DTOs it built
 * against these schemas; that package does not depend on @fx/api, so the schema
 * side of those assertions lives here and the worker test keeps the DB side.
 */
const usage = {
  credential_mode: 'subscription',
  model: 'sonnet-4.5',
  tokens_in: 1000,
  tokens_out: 200,
  cache_read_tokens: 5000,
  cache_write_tokens: 0,
  api_equivalent_usd: 0.0123,
  price_table_version: '2026-10-01',
};

describe('runner usage schemas', () => {
  it('runnerUsageSchema accepts a priced and an unpriced figure and refuses a bad credential mode', () => {
    expect(runnerUsageSchema.safeParse(usage).success).toBe(true);
    expect(runnerUsageSchema.safeParse({ ...usage, model: null, api_equivalent_usd: null, price_table_version: null }).success).toBe(true);
    expect(runnerUsageSchema.safeParse({ ...usage, credential_mode: 'oauth' }).success).toBe(false);
  });

  it('a run and its insight carry runner_usage as optional and nullable (a sandbox run has none)', () => {
    for (const schema of [runResponseSchema, runInsightResponseSchema]) {
      const field = schema.shape.runner_usage;
      expect(field.safeParse(usage).success).toBe(true);
      expect(field.safeParse(null).success).toBe(true);
      expect(field.safeParse(undefined).success).toBe(true);
      expect(field.safeParse({ ...usage, tokens_in: 'x' }).success).toBe(false);
    }
  });

  it('a work item carries own_plan_api_equivalent_usd as a required number-or-null with a usage state, and the month as a required number', () => {
    const item = workItemResponseSchema.shape;
    expect(item.own_plan_api_equivalent_usd.safeParse(null).success).toBe(true);
    expect(item.own_plan_api_equivalent_usd.safeParse(undefined).success).toBe(false);
    expect(item.own_plan_usage_state.safeParse('not_priced').success).toBe(true);
    expect(item.own_plan_usage_state.safeParse('zero').success).toBe(false);
    for (const schema of [usageResponseSchema]) {
      const field = schema.shape.own_plan_api_equivalent_usd;
      expect(field.safeParse(1.25).success).toBe(true);
      expect(field.safeParse(undefined).success).toBe(false);
      expect(field.safeParse(null).success).toBe(false);
    }
  });
});
