import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { usageResponseSchema } from '../src/routes/billing.js';

const FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL('../fixtures/v1/getUsage/200-ok.json', import.meta.url)), 'utf8'),
) as Record<string, unknown>;

describe('usageResponseSchema: role_breakdown', () => {
  it('accepts the updated getUsage fixture', () => {
    expect(usageResponseSchema.safeParse(FIXTURE).success).toBe(true);
  });

  it('refuses a body with role_breakdown absent', () => {
    const { role_breakdown: _omit, ...rest } = FIXTURE;
    expect(usageResponseSchema.safeParse(rest).success).toBe(false);
  });

  it('refuses a body whose role_breakdown is not an array', () => {
    expect(usageResponseSchema.safeParse({ ...FIXTURE, role_breakdown: {} }).success).toBe(false);
    expect(usageResponseSchema.safeParse({ ...FIXTURE, role_breakdown: null }).success).toBe(false);
    expect(usageResponseSchema.safeParse({ ...FIXTURE, role_breakdown: 'none' }).success).toBe(false);
  });

  it('refuses a row with a non-numeric spend_usd', () => {
    const bad = [{ role: 'executor', runs: 1, spend_usd: '4.00', own_plan_api_equivalent_usd: 0 }];
    expect(usageResponseSchema.safeParse({ ...FIXTURE, role_breakdown: bad }).success).toBe(false);
  });
});
