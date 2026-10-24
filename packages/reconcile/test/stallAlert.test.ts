import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { checkStalls, STALL_REPEAT_SECONDS, stallText, type OpsAlertSink } from '../src/stallAlert.js';

const MIN = 60;

/**
 * A stateful stand-in for the four reads readLapTimes/jobsWithWork make plus the alert column. `world` is what the test changes between ticks;
 * `alerted` is the column (seconds since it was set, or absent).
 */
function makeWorld() {
  const world = {
    creditsBroken: false,
    terminalBudget: false,
    lap: 0,
    alerted: new Map<string, number>(),
  };
  const pool = {
    query: async (sql: string, args?: unknown[]) => {
      if (sql.includes('FROM model_connections')) return { rows: [{ broken: world.creditsBroken, age: world.creditsBroken ? 0 : null }] };
      if (sql.includes("FROM reconcile_jobs WHERE name = 'sandbox_reap_terminal'")) return { rows: [{ last_result_code: world.terminalBudget ? 'budget' : 'ok', last_full_pass_at: null }] };
      if (sql.includes('stall_alerted_at IS NOT NULL')) return { rows: [...world.alerted].map(([name, age]) => ({ name, age, at: `T-${name}` })) };
      if (sql.includes('RETURNING name')) {
        const name = String(args?.[0]);
        const current = world.alerted.has(name) ? `T-${name}` : null;
        if (current !== (args?.[1] ?? null)) return { rows: [] };
        if (sql.includes('= now()')) world.alerted.set(name, 0);
        else world.alerted.delete(name);
        return { rows: [{ name }] };
      }
      if (sql.includes('$2::timestamptz')) {
        world.alerted.set(String(args?.[0]), 0);
        return { rows: [] };
      }
      if (sql.includes('stall_alerted_at = NULL')) {
        world.alerted.delete(String(args?.[0]));
        return { rows: [] };
      }
      return {
        rows: [
          { name: 'model_credits_revalidate', interval_seconds: 900, lap: world.lap, never: false, last_result_code: 'ok', last_ok_at: null },
          { name: 'sandbox_reap_terminal', interval_seconds: 900, lap: world.lap, never: false, last_result_code: 'ok', last_ok_at: null },
          { name: 'github_repos', interval_seconds: 21_600, lap: 100 * 3600, never: false, last_result_code: 'ok', last_ok_at: null },
        ],
      };
    },
  } as unknown as Pool;
  return { world, pool };
}

function recordingSink(fail = false) {
  const sent: { kind: string; text: string }[] = [];
  const sink: OpsAlertSink = {
    send: async (n) => {
      if (fail) throw new Error('sink down');
      sent.push(n);
    },
  };
  return { sent, sink };
}

describe('checkStalls', () => {
  it('a breached job with work sends one alert naming the job, the time since its last pass and what is waiting', async () => {
    const { world, pool } = makeWorld();
    const { sent, sink } = recordingSink();
    world.creditsBroken = true;
    world.lap = 75 * MIN;
    const r = await checkStalls({ pool, sink, onSinkError: () => {} });
    expect(r.stalled).toEqual(['model_credits_revalidate']);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.kind).toBe('stalled');
    expect(sent[0]?.text).toContain('model_credits_revalidate');
    expect(sent[0]?.text).toContain('1h 15m');
    expect(sent[0]?.text).toContain('out of credit');
    expect(r.outstanding).toBe(1);
  });

  it('repeat ticks of the same stall send nothing more', async () => {
    const { world, pool } = makeWorld();
    const { sent, sink } = recordingSink();
    world.terminalBudget = true;
    world.lap = 40 * MIN;
    for (let i = 0; i < 5; i++) await checkStalls({ pool, sink, onSinkError: () => {} });
    expect(sent.map((s) => s.kind)).toEqual(['stalled']);
  });

  it('a stall that persists six hours is announced once more', async () => {
    const { world, pool } = makeWorld();
    const { sent, sink } = recordingSink();
    world.terminalBudget = true;
    world.lap = 40 * MIN;
    await checkStalls({ pool, sink, onSinkError: () => {} });
    world.alerted.set('sandbox_reap_terminal', STALL_REPEAT_SECONDS - 1);
    await checkStalls({ pool, sink, onSinkError: () => {} });
    expect(sent).toHaveLength(1);
    world.alerted.set('sandbox_reap_terminal', STALL_REPEAT_SECONDS);
    await checkStalls({ pool, sink, onSinkError: () => {} });
    expect(sent.map((s) => s.kind)).toEqual(['stalled', 'still_stalled']);
    expect(world.alerted.get('sandbox_reap_terminal')).toBe(0);
  });

  it('recovery sends one notice and clears the state, whether the lap came back or the work went away', async () => {
    for (const recover of [(w: ReturnType<typeof makeWorld>['world']) => (w.lap = 5 * MIN), (w: ReturnType<typeof makeWorld>['world']) => (w.creditsBroken = false)]) {
      const { world, pool } = makeWorld();
      const { sent, sink } = recordingSink();
      world.creditsBroken = true;
      world.lap = 75 * MIN;
      await checkStalls({ pool, sink, onSinkError: () => {} });
      recover(world);
      const r = await checkStalls({ pool, sink, onSinkError: () => {} });
      await checkStalls({ pool, sink, onSinkError: () => {} });
      expect(sent.map((s) => s.kind)).toEqual(['stalled', 'recovered']);
      expect(r.outstanding).toBe(0);
      expect(world.alerted.size).toBe(0);
    }
  });

  it('an idle job with an old lap sends nothing, and so does a job with work and a fresh lap', async () => {
    const { world, pool } = makeWorld();
    const { sent, sink } = recordingSink();
    world.lap = 20 * 3600; // far past twice the interval, but neither gated job has work, and github_repos (100 h) has no "work" notion
    expect((await checkStalls({ pool, sink, onSinkError: () => {} })).stalled).toEqual([]);
    world.creditsBroken = true;
    world.lap = 10 * MIN;
    await checkStalls({ pool, sink, onSinkError: () => {} });
    expect(sent).toEqual([]);
  });

  it('a failing sink is reported to the caller, not thrown, leaves the state unset and is retried on the next tick', async () => {
    const { world, pool } = makeWorld();
    const errors: unknown[] = [];
    world.creditsBroken = true;
    world.lap = 75 * MIN;
    const r = await checkStalls({ pool, sink: recordingSink(true).sink, onSinkError: (e) => errors.push(e) });
    expect(errors).toHaveLength(1);
    expect(r.sent).toEqual([]);
    expect(world.alerted.size).toBe(0);
    const ok = recordingSink();
    await checkStalls({ pool, sink: ok.sink, onSinkError: () => {} });
    expect(ok.sent).toHaveLength(1);
  });

  it('with no sink configured it reads nothing and sends nothing', async () => {
    const { world, pool } = makeWorld();
    world.creditsBroken = true;
    world.lap = 75 * MIN;
    expect(await checkStalls({ pool, sink: null, onSinkError: () => {} })).toEqual({ stalled: [], sent: [], outstanding: 0 });
  });

  it('the text carries only the job, durations and fixed wording', () => {
    const text = stallText('still_stalled', { name: 'x_job', lapSeconds: 3 * 3600, intervalSeconds: 900 });
    expect(text).toBe('Still stalled: reconcile job `x_job` has not completed a pass for 3h 0m (its cadence is about 15m). Waiting: work is waiting for it.');
  });
});
