import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { setPendingHooks } from '../src/pendingWork.js';
import type { Pool } from 'pg';
import { createRecordingRunActionSignal, requestRunAction, type RunActionSignal } from '../src/runActions/index.js';

/** D#31 API-6a-1 criteria 4 and 5, against a fake pool: no database needed. */
const A = randomUUID();
const principal = { accountId: A, userId: randomUUID() };
const input = { kind: 'cancel_run' as const, targetId: randomUUID(), requestHash: 'h' };

function fakePool(row: { replayed: boolean }, events: string[], failOn?: string): Pool {
  const client = {
    query: async (sql: string) => {
      events.push(sql.split(/[ (]/)[0]!);
      if (failOn && sql.startsWith(failOn)) throw new Error('injected');
      return { rows: sql.includes('run_action_request') ? [{ action_id: 'act-1', state: 'accepted', ...row }] : [] };
    },
    release: () => undefined,
  };
  return { connect: async () => client } as unknown as Pool;
}

describe('requestRunAction marks the run-action sweep', () => {
  afterEach(() => setPendingHooks(null));
  it('sets the pending marker for a new request and not for a replay', async () => {
    const sets: string[] = [];
    setPendingHooks({ store: { get: async () => null, set: async (k: string) => void sets.push(k), delete: async () => undefined } });
    const signal = createRecordingRunActionSignal();
    await requestRunAction({ pool: fakePool({ replayed: true }, []), principal }, input, { signal });
    await new Promise((r) => setTimeout(r, 0));
    expect(sets).toEqual([]);
    await requestRunAction({ pool: fakePool({ replayed: false }, []), principal }, input, { signal });
    await new Promise((r) => setTimeout(r, 0));
    expect(sets).toEqual(['pending:run-action-sweep']);
  });
});

describe('requestRunAction', () => {
  it('signals once, with ids only, after the transaction commits', async () => {
    const events: string[] = [];
    const signal = createRecordingRunActionSignal();
    const wrapped: RunActionSignal = { signal: async (m) => (events.push('SIGNAL'), signal.signal(m)) };
    const res = await requestRunAction({ pool: fakePool({ replayed: false }, events), principal }, input, { signal: wrapped });
    expect(res).toEqual({ actionId: 'act-1', state: 'accepted', replayed: false });
    expect(signal.sent).toEqual([{ actionId: 'act-1', accountId: A, kind: 'cancel_run' }]);
    expect(events.indexOf('SIGNAL')).toBeGreaterThan(events.indexOf('COMMIT'));
  });

  it('sends no signal for a replay', async () => {
    const signal = createRecordingRunActionSignal();
    const res = await requestRunAction({ pool: fakePool({ replayed: true }, []), principal }, input, { signal });
    expect(res.replayed).toBe(true);
    expect(signal.sent).toEqual([]);
  });

  it('a failure inside the transaction rejects and sends no signal', async () => {
    const signal = createRecordingRunActionSignal();
    await expect(requestRunAction({ pool: fakePool({ replayed: false }, [], 'COMMIT'), principal }, input, { signal })).rejects.toThrow('injected');
    expect(signal.sent).toEqual([]);
  });

  it('a throwing signal does not change the result and is logged by id and code only', async () => {
    const logged: unknown[][] = [];
    const signal: RunActionSignal = { signal: async () => Promise.reject(new Error('secret detail')) };
    const res = await requestRunAction({ pool: fakePool({ replayed: false }, []), principal }, input, {
      signal,
      onSignalError: (...args) => logged.push(args),
    });
    expect(res.actionId).toBe('act-1');
    expect(logged).toEqual([['act-1', 'signal_failed']]);
  });

  it('a hanging signal returns within about 2 s', async () => {
    const logged: unknown[][] = [];
    const started = Date.now();
    const res = await requestRunAction({ pool: fakePool({ replayed: false }, []), principal }, input, {
      signal: { signal: () => new Promise(() => undefined) },
      onSignalError: (...args) => logged.push(args),
    });
    expect(res.actionId).toBe('act-1');
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
    expect(Date.now() - started).toBeLessThan(3500);
    expect(logged).toEqual([['act-1', 'signal_timeout']]);
  });
});
