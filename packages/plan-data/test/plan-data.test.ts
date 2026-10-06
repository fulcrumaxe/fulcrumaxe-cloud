import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanDataMissingError, loadPlanData, planDataStatus, resetPlanDataCache } from '../src/index.js';

const fixtureText = readFileSync(new URL('../fixtures/plan-data.fixture.json', import.meta.url), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const fixture = (): Json => JSON.parse(fixtureText);

const saved = { data: process.env.FX_PLAN_DATA, node: process.env.NODE_ENV, vercel: process.env.VERCEL_ENV };
beforeEach(() => resetPlanDataCache());
afterEach(() => {
  for (const [k, v] of [
    ['FX_PLAN_DATA', saved.data],
    ['NODE_ENV', saved.node],
    ['VERCEL_ENV', saved.vercel],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetPlanDataCache();
});

function fail(value: unknown): Error {
  process.env.FX_PLAN_DATA = typeof value === 'string' ? value : JSON.stringify(value);
  resetPlanDataCache();
  try {
    loadPlanData();
  } catch (e) {
    expect(e).toBeInstanceOf(PlanDataMissingError);
    return e as Error;
  }
  throw new Error('expected loadPlanData to throw');
}

describe('loadPlanData', () => {
  it('loads and caches the fixture', () => {
    process.env.FX_PLAN_DATA = fixtureText;
    const a = loadPlanData();
    expect(a.plans.team.priceUsdPerMonth).toBe(222.22);
    expect(Object.keys(a.plans)).toEqual(['starter', 'team', 'scale']);
    process.env.FX_PLAN_DATA = 'changed after first read';
    expect(loadPlanData()).toBe(a);
  });

  it('throws PlanDataMissingError naming the variable when unset', () => {
    delete process.env.FX_PLAN_DATA;
    expect(() => loadPlanData()).toThrow(PlanDataMissingError);
    expect(() => loadPlanData()).toThrow(/FX_PLAN_DATA/);
    expect(planDataStatus()).toBe('missing');
  });

  it('treats an empty value as unset', () => {
    process.env.FX_PLAN_DATA = '   ';
    expect(() => loadPlanData()).toThrow(PlanDataMissingError);
  });

  it('throws on invalid JSON, naming the variable and not echoing the value', () => {
    const e = fail('{not json secret-ish');
    expect(e.message).toContain('FX_PLAN_DATA');
    expect(e.message).not.toContain('secret-ish');
  });

  it('names the field path of a missing field', () => {
    const d = fixture();
    delete d.plans.team.apiLimits.perTenantPerMinute;
    const e = fail(d);
    expect(e.message).toContain('FX_PLAN_DATA');
    expect(e.message).toContain('plans.team.apiLimits.perTenantPerMinute');
  });

  it('names a missing model, cap and sandbox field', () => {
    const cases: Array<[(d: Json) => void, string]> = [
      [(d) => delete d.pricing.claude['opus-5'], 'pricing.claude.opus-5'],
      [(d) => delete d.pricing.openai['gpt-5.3-codex'], 'pricing.openai.gpt-5.3-codex'],
      [(d) => delete d.caps.maxFixRounds, 'caps.maxFixRounds'],
      [(d) => delete d.pricing.sandbox.dataTransferUsdPerGb, 'pricing.sandbox.dataTransferUsdPerGb'],
      [(d) => delete d.plans.scale.webhookEndpointLimit, 'plans.scale.webhookEndpointLimit'],
    ];
    for (const [mutate, path] of cases) {
      const d = fixture();
      mutate(d);
      expect(fail(d).message).toContain(path);
    }
  });

  it('names an extra key at the root and nested', () => {
    const cases: Array<[(d: Json) => void, string]> = [
      [(d) => (d.surprise = 1), 'surprise'],
      [(d) => (d.plans.scale.background.extraField = 1), 'plans.scale.background.extraField'],
      [(d) => (d.plans.enterprise = d.plans.team), 'plans.enterprise'],
      [(d) => (d.pricing.claude['mystery-model'] = d.pricing.claude['opus-5']), 'pricing.claude.mystery-model'],
    ];
    for (const [mutate, key] of cases) {
      const d = fixture();
      mutate(d);
      const e = fail(d);
      expect(e.message).toContain('FX_PLAN_DATA');
      expect(e.message).toContain(key);
    }
  });

  it('rejects negative numbers, naming the path', () => {
    const d = fixture();
    d.caps.featureUsd = -1;
    expect(fail(d).message).toContain('caps.featureUsd');
  });

  it('refuses the fixture unless NODE_ENV is test or development and VERCEL_ENV is unset', () => {
    const cases: Array<[string | undefined, string | undefined, boolean]> = [
      ['test', undefined, true],
      ['development', undefined, true],
      ['production', undefined, false],
      [undefined, undefined, false],
      ['staging', undefined, false],
      [undefined, 'production', false],
      ['development', 'preview', false],
      ['test', 'development', false],
    ];
    for (const [nodeEnv, vercelEnv, ok] of cases) {
      resetPlanDataCache();
      process.env.FX_PLAN_DATA = fixtureText;
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
      if (vercelEnv === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = vercelEnv;
      const label = `NODE_ENV=${nodeEnv} VERCEL_ENV=${vercelEnv}`;
      if (ok) expect(planDataStatus(), label).toBe('ok');
      else {
        expect(() => loadPlanData(), label).toThrow(PlanDataMissingError);
        expect(planDataStatus(), label).toBe('missing');
      }
    }
  });

  it('accepts data that is not a fixture in production', () => {
    const d = fixture();
    delete d.fixture;
    process.env.FX_PLAN_DATA = JSON.stringify(d);
    process.env.NODE_ENV = 'production';
    process.env.VERCEL_ENV = 'production';
    expect(loadPlanData().fixture).toBeUndefined();
  });
});

const SENTINEL = 7351924.6817;
const SENTINEL_TEXT = 'SENTINEL-7351924';

describe('redaction: no failure message carries a value from the payload', () => {
  const sites: Array<[string, (d: Json) => unknown]> = [
    ['bad JSON', () => `S-${SENTINEL}`],
    ['missing field', (d) => ((d.plans.team.priceUsdPerMonth = SENTINEL), delete d.plans.team.apiLimits.perTenantPerMinute, d)],
    ['extra key', (d) => ((d.caps.extra = SENTINEL), (d.surprise = SENTINEL_TEXT), d)],
    ['negative number', (d) => ((d.caps.featureUsd = -SENTINEL), d)],
    ['wrong type', (d) => ((d.caps.smallUsd = SENTINEL_TEXT), (d.plans.starter.repoLimit = SENTINEL_TEXT), d)],
    ['bad discriminator', (d) => ((d.plans.scale.background.kind = SENTINEL_TEXT), d)],
    ['non-integer count', (d) => ((d.caps.maxFixRounds = SENTINEL), d)],
  ];
  for (const [name, mutate] of sites) {
    it(`${name}`, () => {
      const logs: unknown[] = [];
      const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((m) =>
        vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a)),
      );
      const e = fail(mutate(fixture()));
      spies.forEach((s) => s.mockRestore());
      const all = JSON.stringify([e.message, e.name, e.stack, logs]);
      expect(all).not.toContain('7351924');
      expect(all).not.toContain(String(SENTINEL));
    });
  }
});

describe('fixture', () => {
  it('is marked as a fixture', () => {
    expect(fixture().fixture).toBe(true);
  });
});
