import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

/**
 * D#7 start gate: the preset a repo's dial gives a start type. Only the ABSENCE of a dial row is Balanced (owner ruling 10-25); a row whose disposition is not
 * one we know is read the safe way, as ask (Cautious). The column's CHECK keeps such a row out of the database today, so this runs over a faked client: the
 * guard is for a future disposition or a damaged row, and must not turn into an automatic start.
 */
const getCurrentDialSetting = vi.fn();
const recordStartReceipt = vi.fn();
const raiseStartAsk = vi.fn();
vi.mock('@fx/db/src/decisions.js', () => ({ getCurrentDialSetting: (...a: unknown[]) => getCurrentDialSetting(...a) }));
vi.mock('../src/decisions/startGate.js', () => ({
  recordStartReceipt: (...a: unknown[]) => recordStartReceipt(...a),
  raiseStartAsk: (...a: unknown[]) => raiseStartAsk(...a),
}));
vi.mock('../src/tenancy/withTenant.js', () => ({
  withTenant: async (_pool: unknown, _account: unknown, ...rest: unknown[]) => {
    const fn = rest[rest.length - 1] as (c: unknown) => Promise<unknown>;
    const client = {
      query: async (sql: string) => ({ rows: sql.includes('FROM work_items') ? [{ provenance: 'internal', repo_id: 'repo-1', kind: null }] : [] }),
    };
    return fn(client);
  },
}));

import { decideStart } from '../src/decisions/startDecide.js';

const CTX = { pool: {} as Pool, accountId: '11111111-1111-4111-8111-111111111111' };
const WI = '22222222-2222-4222-8222-222222222222';
const run = () => decideStart(CTX, { workItemId: WI, origin: 'unattended', category: 'small' });

beforeEach(() => {
  getCurrentDialSetting.mockReset();
  recordStartReceipt.mockReset().mockResolvedValue({ gateId: 'g', outcome: 'started', askId: null, receiptId: 'r', replayed: false });
  raiseStartAsk.mockReset().mockResolvedValue({ gateId: 'g', outcome: 'asked', askId: 'a', receiptId: null, replayed: false });
});

describe('the preset of a start type (presetFor)', () => {
  it('no dial row is Balanced: the dial starts it with a policy receipt', async () => {
    getCurrentDialSetting.mockResolvedValue(null);
    expect(await run()).toMatchObject({ proceed: true, how: 'policy_receipt', preset: 'balanced' });
    expect(raiseStartAsk).not.toHaveBeenCalled();
  });

  it.each(['future_mode', '', 'ACT'])('a row with the unknown disposition %j asks (Cautious) and records nothing', async (disposition) => {
    getCurrentDialSetting.mockResolvedValue({ disposition, version: 3 });
    expect(await run()).toMatchObject({ proceed: false, reason: 'asked' });
    expect(raiseStartAsk).toHaveBeenCalledWith(CTX, expect.objectContaining({ preset: 'cautious' }));
    expect(recordStartReceipt).not.toHaveBeenCalled();
  });

  it.each([['ask', 'cautious'], ['announce', 'balanced'], ['act', 'autonomous']])('the known disposition %s maps to %s', async (disposition, preset) => {
    getCurrentDialSetting.mockResolvedValue({ disposition, version: 1 });
    await run();
    const call = (disposition === 'ask' ? raiseStartAsk : recordStartReceipt).mock.calls[0]!;
    expect(call[1]).toMatchObject({ preset });
  });
});
