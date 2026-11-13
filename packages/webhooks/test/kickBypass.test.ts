import { describe, expect, it } from 'vitest';
import {
  BYPASS_HEADER,
  bypassSecretFor,
  createApiSweepKicker,
  createVerifySweepKicker,
  apiSweepKickerFromEnv,
  ownHosts,
  readBypassSecret,
  reportRefusedKick,
  verifySweepKickerFromEnv,
} from '../src/index.js';

/**
 * Deployment Protection for the two sweep kicks: the bypass secret goes as a header to this project's own host only (exact match), and a refused kick is reported by
 * status. The secret must never show up in a report.
 */
const BYPASS = 'bypass-secret-for-the-unit-test';
const CRON = 'cron-secret-for-the-unit-test';
const OWN = 'cloud-staging-own.vercel.app';
const KICK = `https://${OWN}/api/internal/run-actions/kick`;
const base = { RUN_ACTION_KICK_URL: KICK, CRON_SECRET: CRON, VERCEL_AUTOMATION_BYPASS_SECRET: BYPASS };

type Sent = { url: string; headers: Record<string, string> };
function capture(status = 202): { sent: Sent[]; fetchImpl: typeof fetch } {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), headers: init.headers as Record<string, string> });
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

describe('ownHosts / readBypassSecret / bypassSecretFor', () => {
  it('own hosts are the platform variables and the list, case-folded; junk is dropped', () => {
    const hosts = ownHosts({ VERCEL_URL: 'A.vercel.app', VERCEL_BRANCH_URL: 'https://b.vercel.app', VERCEL_PROJECT_PRODUCTION_URL: 'c.vercel.app', FX_VERIFY_OWN_HOSTS: 'D.example.com, 10.0.0.1 ,localhost' });
    expect([...hosts].sort()).toEqual(['a.vercel.app', 'c.vercel.app', 'd.example.com']);
  });

  it('the secret must be printable ASCII of at most 256 characters', () => {
    expect(readBypassSecret({ VERCEL_AUTOMATION_BYPASS_SECRET: 'ok-secret' })).toBe('ok-secret');
    expect(readBypassSecret({ VERCEL_AUTOMATION_BYPASS_SECRET: 'has space' })).toBeUndefined();
    expect(readBypassSecret({ VERCEL_AUTOMATION_BYPASS_SECRET: 'a'.repeat(257) })).toBeUndefined();
    expect(readBypassSecret({ VERCEL_AUTOMATION_BYPASS_SECRET: '' })).toBeUndefined();
    expect(readBypassSecret({})).toBeUndefined();
  });

  it('matches the host exactly: no suffix, no sibling, no subdomain', () => {
    const env = { VERCEL_URL: OWN, VERCEL_AUTOMATION_BYPASS_SECRET: BYPASS };
    expect(bypassSecretFor(new URL(`https://${OWN}/x`), env)).toBe(BYPASS);
    expect(bypassSecretFor(new URL(`https://${OWN.toUpperCase()}/x`), env)).toBe(BYPASS);
    expect(bypassSecretFor(new URL('https://someone-else.vercel.app/x'), env)).toBeUndefined();
    expect(bypassSecretFor(new URL(`https://evil.${OWN}/x`), env)).toBeUndefined();
    expect(bypassSecretFor(new URL(`https://x${OWN}/x`), env)).toBeUndefined();
    expect(bypassSecretFor(new URL(`https://${OWN}/x`), { VERCEL_URL: OWN })).toBeUndefined();
  });
});

describe.each([
  ['verify-sweep kick', verifySweepKickerFromEnv, createVerifySweepKicker, 'verify_sweep_kick.refused'],
  ['api-sweep kick', apiSweepKickerFromEnv, createApiSweepKicker, 'api_sweep_kick.refused'],
] as const)('%s', (_name, fromEnv, create, refusedStage) => {
  it('sends the bypass header to a host the platform variables name', async () => {
    const { sent, fetchImpl } = capture();
    const kicker = (create as typeof createVerifySweepKicker)({ url: `https://${OWN}/p`, secret: 'k', bypassSecret: BYPASS, sleep: async () => {}, fetchImpl });
    await kicker.kick();
    expect(sent[0]!.headers[BYPASS_HEADER]).toBe(BYPASS);
    expect(sent[0]!.url).not.toContain(BYPASS);
    expect(sent[0]!.headers['x-vercel-set-bypass-cookie']).toBeUndefined();
  });

  it('sends no header without a bypass secret', async () => {
    const { sent, fetchImpl } = capture();
    await (create as typeof createVerifySweepKicker)({ url: `https://${OWN}/p`, secret: 'k', sleep: async () => {}, fetchImpl }).kick();
    expect(sent[0]!.headers[BYPASS_HEADER]).toBeUndefined();
  });

  it('from the environment: a foreign *.vercel.app kick URL gets no bypass; a named own host does', async () => {
    const calls: Array<{ headers: Record<string, string> }> = [];
    const spy = globalThis.fetch;
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      calls.push({ headers: init.headers as Record<string, string> });
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    try {
      const sleepless = async (k: { kick(): Promise<void> } | null) => {
        // The env builder owns its sleep; give the real timer the 1.5 s it asks for.
        await k!.kick();
      };
      await sleepless(fromEnv({ ...base, RUN_ACTION_KICK_URL: 'https://someone-else.vercel.app/api/internal/run-actions/kick', VERCEL_URL: OWN }));
      expect(calls[0]!.headers[BYPASS_HEADER]).toBeUndefined();
      await sleepless(fromEnv({ ...base, VERCEL_URL: OWN }));
      expect(calls[1]!.headers[BYPASS_HEADER]).toBe(BYPASS);
      await sleepless(fromEnv({ ...base, RUN_ACTION_KICK_URL: 'https://custom.example.com/api/internal/run-actions/kick', FX_VERIFY_OWN_HOSTS: 'custom.example.com' }));
      expect(calls[2]!.headers[BYPASS_HEADER]).toBe(BYPASS);
    } finally {
      globalThis.fetch = spy;
    }
  }, 15000);

  it('reports a refused answer by status, never with a secret', async () => {
    const reports: Array<{ message: string; stage: string }> = [];
    const { fetchImpl } = capture(401);
    await (create as typeof createVerifySweepKicker)({ url: `https://${OWN}/p`, secret: 'k', bypassSecret: BYPASS, sleep: async () => {}, fetchImpl, reportError: (e, stage) => reports.push({ message: (e as Error).message, stage }) }).kick();
    expect(reports).toEqual([{ message: `${refusedStage} refused: status 401`, stage: refusedStage }]);
    expect(JSON.stringify(reports)).not.toContain(BYPASS);
  });

  it('reports nothing for an accepted kick', async () => {
    const reports: string[] = [];
    const { fetchImpl } = capture(202);
    await (create as typeof createVerifySweepKicker)({ url: `https://${OWN}/p`, secret: 'k', sleep: async () => {}, fetchImpl, reportError: (_e, s) => reports.push(s) }).kick();
    expect(reports).toEqual([]);
  });
});

describe('reportRefusedKick', () => {
  it('is silent for ok and tolerates no reporter', () => {
    const seen: string[] = [];
    reportRefusedKick({ ok: true, status: 202 }, 's', (_e, s) => seen.push(s));
    reportRefusedKick({ ok: false, status: 500 }, 's');
    expect(seen).toEqual([]);
  });
});
