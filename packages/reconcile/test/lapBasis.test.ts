import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { IDLE_RECONCILE_CADENCE_SECONDS, isLapBreach, jobsWithWork, lapBasisSeconds, readLapTimes } from '../src/runner.js';

/**
 * The two 15-minute jobs sit behind the reconcile gate (an idle reconciler connects every fourth hourly slot). While one has work its lap is
 * judged against its own 15-minute interval (breach after 30 minutes, as for any job); only with nothing to do is the idle cadence used.
 */
const MIN = 60;

describe('lapBasisSeconds', () => {
  it.each(['sandbox_reap_terminal', 'model_credits_revalidate'])('%s: own interval with work, idle cadence without', (name) => {
    expect(lapBasisSeconds(name, 900, true)).toBe(900);
    expect(lapBasisSeconds(name, 900, false)).toBe(IDLE_RECONCILE_CADENCE_SECONDS);
  });

  it('other jobs keep their own interval whatever the flag says', () => {
    expect(lapBasisSeconds('github_repos', 21_600, false)).toBe(21_600);
    expect(lapBasisSeconds('t_lap', 3600, true)).toBe(3600);
  });
});

/** A pool that answers the three reads readLapTimes makes. */
function fakePool(opts: { creditsBroken: boolean; terminalBudget: boolean; laps: { name: string; interval_seconds: number; lap: number }[] }): Pool {
  return {
    query: async (sql: string) => {
      if (sql.includes('FROM model_connections')) return { rows: [{ pending: opts.creditsBroken }] };
      if (sql.includes("last_result_code = 'budget'")) return { rows: opts.terminalBudget ? [{ name: 'sandbox_reap_terminal' }] : [] };
      return { rows: opts.laps.map((l) => ({ ...l, never: false, last_result_code: 'ok', last_ok_at: null })) };
    },
  } as unknown as Pool;
}

describe('readLapTimes for the gated 15-minute jobs', () => {
  const laps = (lap: number) => [
    { name: 'model_credits_revalidate', interval_seconds: 900, lap },
    { name: 'sandbox_reap_terminal', interval_seconds: 900, lap },
  ];
  const breaches = async (pool: Pool) => Object.fromEntries((await readLapTimes(pool)).map((l) => [l.name, l.breach]));

  it('with work pending and no pass for 31 minutes: breach (the same 30 minute rule as any 15 minute job)', async () => {
    const pool = fakePool({ creditsBroken: true, terminalBudget: true, laps: laps(31 * MIN) });
    expect(await breaches(pool)).toEqual({ model_credits_revalidate: true, sandbox_reap_terminal: true });
  });

  it('with work pending and a pass 29 minutes ago: no breach', async () => {
    const pool = fakePool({ creditsBroken: true, terminalBudget: true, laps: laps(29 * MIN) });
    expect(await breaches(pool)).toEqual({ model_credits_revalidate: false, sandbox_reap_terminal: false });
  });

  it('idle for 5 hours: no breach, because nothing is waiting', async () => {
    const pool = fakePool({ creditsBroken: false, terminalBudget: false, laps: laps(5 * 3600) });
    expect(await breaches(pool)).toEqual({ model_credits_revalidate: false, sandbox_reap_terminal: false });
  });

  it('idle but stopped for over 8 hours: still a breach', async () => {
    const pool = fakePool({ creditsBroken: false, terminalBudget: false, laps: laps(8 * 3600 + 1) });
    expect(await breaches(pool)).toEqual({ model_credits_revalidate: true, sandbox_reap_terminal: true });
    expect(isLapBreach(8 * 3600 + 1, IDLE_RECONCILE_CADENCE_SECONDS)).toBe(true);
  });

  it('only the job with work gets the strict rule', async () => {
    const pool = fakePool({ creditsBroken: true, terminalBudget: false, laps: laps(31 * MIN) });
    expect(await breaches(pool)).toEqual({ model_credits_revalidate: true, sandbox_reap_terminal: false });
    expect([...(await jobsWithWork(pool))]).toEqual(['model_credits_revalidate']);
  });
});
