import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { CREDITS_BACKED_OFF_CADENCE_SECONDS, CREDITS_FAST_WINDOW_SECONDS, IDLE_RECONCILE_CADENCE_SECONDS, isLapBreach, jobsWithWork, lapBasisSeconds, readCreditsBreak, readLapTimes } from '../src/runner.js';

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
function fakePool(opts: { creditsBroken: boolean; creditsAgeSeconds?: number; terminalBudget: boolean; laps: { name: string; interval_seconds: number; lap: number }[] }): Pool {
  return {
    query: async (sql: string) => {
      if (sql.includes('FROM model_connections')) return { rows: [{ broken: opts.creditsBroken, age: opts.creditsBroken ? (opts.creditsAgeSeconds ?? 0) : null }] };
      if (sql.includes("FROM reconcile_jobs WHERE name = 'sandbox_reap_terminal'")) return { rows: [{ last_result_code: opts.terminalBudget ? 'budget' : 'ok', last_full_pass_at: null }] };
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

/** The credits re-check backs off to hourly once the newest break is 2 hours old; the lap rule follows the effective cadence (twice 60 minutes). */
describe('the credits job backed off to hourly', () => {
  const HOUR = 3600;
  const laps = (lap: number) => [
    { name: 'model_credits_revalidate', interval_seconds: 900, lap },
    { name: 'sandbox_reap_terminal', interval_seconds: 900, lap },
  ];
  const credits = async (age: number, lap: number) => {
    const pool = fakePool({ creditsBroken: true, creditsAgeSeconds: age, terminalBudget: true, laps: laps(lap) });
    return Object.fromEntries((await readLapTimes(pool)).map((l) => [l.name, l.breach]));
  };

  it('lapBasisSeconds: 15 minutes inside the window, an hour once backed off, and only for the credits job', () => {
    expect(lapBasisSeconds('model_credits_revalidate', 900, true, false)).toBe(900);
    expect(lapBasisSeconds('model_credits_revalidate', 900, true, true)).toBe(CREDITS_BACKED_OFF_CADENCE_SECONDS);
    expect(lapBasisSeconds('sandbox_reap_terminal', 900, true, true)).toBe(900);
    expect(lapBasisSeconds('model_credits_revalidate', 900, false, true)).toBe(IDLE_RECONCILE_CADENCE_SECONDS);
  });

  it('readCreditsBreak: backed off from exactly 2 hours, not before; nothing broken is neither broken nor backed off', async () => {
    const at = (age: number | null, broken = true) => readCreditsBreak({ query: async () => ({ rows: [{ broken, age }] }) } as unknown as Pool);
    expect(await at(CREDITS_FAST_WINDOW_SECONDS - 1)).toMatchObject({ broken: true, backedOff: false });
    expect(await at(CREDITS_FAST_WINDOW_SECONDS)).toMatchObject({ broken: true, backedOff: true });
    expect(await at(null, false)).toEqual({ broken: false, ageSeconds: null, backedOff: false });
  });

  it('inside the window a 31-minute lap still breaches (15 minute cadence, 2x rule)', async () => {
    expect((await credits(HOUR, 31 * MIN)).model_credits_revalidate).toBe(true);
  });

  it('backed off, a lap of 61 minutes does not breach: that is the normal hourly cadence, not a stuck job', async () => {
    expect((await credits(3 * HOUR, 61 * MIN)).model_credits_revalidate).toBe(false);
    expect((await credits(3 * HOUR, 119 * MIN)).model_credits_revalidate).toBe(false);
  });

  it('backed off, a job with no pass for over 2 hours still alerts (twice the effective cadence)', async () => {
    expect((await credits(3 * HOUR, 2 * HOUR + 1)).model_credits_revalidate).toBe(true);
  });

  it('the back-off belongs to the credits job: the terminal reap job keeps its 30 minute rule', async () => {
    expect((await credits(3 * HOUR, 61 * MIN)).sandbox_reap_terminal).toBe(true);
  });
});
