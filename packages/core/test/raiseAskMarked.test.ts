import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { DEFAULT_ASK_POLICY } from '@fx/db/src/decisionAsks.js';
import { MARKER_HORIZON_MS, MAX_FUTURE_MARKER_TTL_SECONDS, SWEEP_SCHEDULE_MS, readTickGate, setPendingHooks } from '../src/pendingWork.js';
import { raiseAskMarked } from '../src/decisions/raiseAskMarked.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * ASK-WIRE-1 (1 and 4): raising an ask dates the invariant sweep's marker at the ask's `answer_due_at`, and the Needs you promise ("the agent goes
 * ahead") is kept within one cron slot of the window's end. The client answers like the database does: the raise function returns an id and the row
 * holds `answer_due_at = now + the window the raise was given`.
 */
const ASK_ID = '11111111-1111-4111-8111-111111111111';
const OPTIONS = [{ id: 'apply', label: 'Apply the change' }, { id: 'skip', label: 'Skip it' }];

function fakeClient(now: number) {
  const seen: { windowMinutes: number | null } = { windowMinutes: null };
  const client = {
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes('decision_ask_raise')) {
        seen.windowMinutes = params[8] as number;
        return { rows: [{ id: ASK_ID }] };
      }
      if (sql.includes('answer_due_at')) return { rows: [{ due: new Date(now + (seen.windowMinutes ?? 0) * 60_000) }] };
      throw new Error('unexpected query');
    },
  } as unknown as PoolClient;
  return { client, seen };
}

const base = { class: 'human_over_the_loop' as const, decisionType: 'test_strategy_choice', workItemId: ASK_ID, runId: null, options: OPTIONS, proposed: 'apply', rationale: 'because', quotedInputs: [{ trust: 'trusted' as const, storedBody: 'x' }] };
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

describe('raiseAskMarked', () => {
  const store = new Map<string, number>();
  let writes: Array<{ key: string; value: number; ttl: number }>;
  beforeEach(() => {
    store.clear();
    writes = [];
    setPendingHooks({
      store: {
        get: async (k) => store.get(k),
        set: async (k, v, ttl) => { store.set(k, v); writes.push({ key: k, value: v, ttl }); },
        delete: async (k) => { store.delete(k); },
      },
    });
  });
  afterEach(() => setPendingHooks(null));

  it('marks invariant-sweep with since = answer_due_at (a future time, not now)', async () => {
    const now = Date.now();
    const { client } = fakeClient(now);
    await expect(raiseAskMarked(client, { ...base, policy: { answerWindowMinutes: 15, onTimeout: 'proceed_recommended' } })).resolves.toBe(ASK_ID);
    await settle();
    expect(store.get('pending:invariant-sweep')).toBe(now + 15 * 60_000);
  });

  it('a second ask with a later window does not push an earlier marker out', async () => {
    const now = Date.now();
    await raiseAskMarked(fakeClient(now).client, { ...base, policy: { answerWindowMinutes: 20, onTimeout: 'stop_and_flag' } });
    await settle();
    await raiseAskMarked(fakeClient(now).client, { ...base, policy: { answerWindowMinutes: 60, onTimeout: 'stop_and_flag' } });
    await settle();
    expect(store.get('pending:invariant-sweep')).toBe(now + 20 * 60_000);
  });

  it('a window ending in a day is stored for longer than a day, or the store would drop the marker before it is due', async () => {
    await raiseAskMarked(fakeClient(Date.now()).client, { ...base, policy: { answerWindowMinutes: 1440, onTimeout: 'proceed_recommended' } });
    await settle();
    const w = writes.find((x) => x.key === 'pending:invariant-sweep')!;
    expect(w.ttl).toBeGreaterThan(24 * 3600);
  });

  it('a 72 hour window (the class-3 default) is marked at the horizon, with a life that outlasts it; a window inside the horizon is marked exactly', async () => {
    const now = Date.now();
    await raiseAskMarked(fakeClient(now).client, { ...base, policy: { answerWindowMinutes: 72 * 60, onTimeout: 'stop_and_flag' } });
    await settle();
    const w = writes.find((x) => x.key === 'pending:invariant-sweep')!;
    expect(w.value - now).toBe(MARKER_HORIZON_MS);
    expect(w.ttl).toBeLessThanOrEqual(MAX_FUTURE_MARKER_TTL_SECONDS);
    expect(w.ttl * 1000).toBeGreaterThan(w.value - now);
    store.clear();
    await raiseAskMarked(fakeClient(now).client, { ...base, policy: { answerWindowMinutes: 46 * 60, onTimeout: 'stop_and_flag' } });
    await settle();
    expect(store.get('pending:invariant-sweep')).toBe(now + 46 * 3_600_000);
  });

  it('with no hooks installed it raises and marks nothing', async () => {
    setPendingHooks(null);
    await expect(raiseAskMarked(fakeClient(Date.now()).client, { ...base, policy: { answerWindowMinutes: 15, onTimeout: 'stop_and_flag' } })).resolves.toBe(ASK_ID);
    expect(writes).toEqual([]);
  });

  it('copy promise: for the real default window, the first cron slot that connects is within one slot of the window end', async () => {
    // The sentence the Needs you app shows for this ask is still the promise this test holds (the model file pulls in the app's generated client, so it is read as text).
    const copy = readFileSync(fileURLToPath(new URL('../../../apps/workspace/apps/needs-you/needs-you-model.js', import.meta.url)), 'utf8');
    expect(copy).toContain('If nobody answers in time, the agent goes ahead with: ');

    // The cron fires on whole slots.
    const slot = SWEEP_SCHEDULE_MS['invariant-sweep'];
    const start = Math.floor(Date.now() / slot) * slot + 17_000;
    const { client } = fakeClient(start);
    // The customer's default window, not a number picked for the test.
    await raiseAskMarked(client, { ...base, policy: { ...DEFAULT_ASK_POLICY, onTimeout: 'proceed_recommended' } });
    await settle();
    const due = start + DEFAULT_ASK_POLICY.answerWindowMinutes * 60_000;
    // The sweep connected recently at every tick, so only the marker (not the backstop) can open the gate.
    let firstConnect: number | null = null;
    for (let t = Math.floor(start / slot) * slot + slot; t <= due + 2 * slot; t += slot) {
      store.set('lastrun:invariant-sweep', t);
      const gate = await readTickGate('invariant-sweep', t, false);
      if (gate.connect) {
        expect(gate.reason).toBe('marker');
        firstConnect = t;
        break;
      }
    }
    expect(firstConnect).not.toBeNull();
    expect(firstConnect! - due).toBeGreaterThanOrEqual(0);
    expect(firstConnect! - due).toBeLessThanOrEqual(slot);
  });
});
