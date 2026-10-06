import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { setPendingHooks } from '../src/pendingWork.js';
import type { Pool } from 'pg';
import { createRecordingRunActionSignal } from '../src/runActions/index.js';
import {
  PREVIEW_MODEL_CAP_USD,
  PreviewCapNotConfirmedError,
  PreviewCapacityError,
  PreviewExistsError,
  PreviewNoModelKeyError,
  PreviewUnavailableError,
  getPreview,
  requestPreview,
} from '../src/onboarding/index.js';
import { ForbiddenError, NotFoundError } from '../src/tenancy/errors.js';

/** D#2 H17c-1: requestPreview's order of checks and its signal, against a fake pool: no database needed. */
const A = randomUUID();
const principal = { accountId: A, userId: randomUUID() };
const REPO = randomUUID();
const input = { repoId: REPO, confirmModelCapUsd: PREVIEW_MODEL_CAP_USD };

interface World { role?: string | null; appKind?: string | null; modelKey?: boolean; used?: string; replay?: boolean; definerCode?: string; replayed?: boolean }
function fakePool(w: World, log: string[] = []): Pool & { connects: number } {
  const query = async (sql: string) => {
    const tag = sql.trim().split(/[ (\n]/)[0]!;
    const names: [string, string][] = [['onboarding_preview_request', 'DEFINER'], ['current_member_role', 'ROLE'], ['FROM repos', 'REPO'], ['model_connections', 'KEY'], ['preview_daily_compute_usd', 'CAP']];
    log.push(names.find(([needle]) => sql.includes(needle))?.[1] ?? tag);
    if (sql.includes('current_member_role')) return { rows: [{ role: w.role === undefined ? 'owner' : w.role }], rowCount: 1 };
    if (sql.includes('run_action_requests')) return { rows: [], rowCount: w.replay ? 1 : 0 };
    if (sql.includes('FROM repos')) return { rows: w.appKind === null ? [] : [{ app_kind: w.appKind ?? 'team_readonly' }], rowCount: 1 };
    if (sql.includes('model_connections')) return { rows: [], rowCount: w.modelKey === false ? 0 : 1 };
    if (sql.includes('preview_daily_compute_usd')) return { rows: [{ v: w.used ?? '0' }], rowCount: 1 };
    if (sql.includes('onboarding_preview_request')) {
      if (w.definerCode) throw Object.assign(new Error('db'), { code: w.definerCode });
      return { rows: [{ preview_id: 'pv-1', action_id: 'act-1', state: 'accepted', replayed: w.replayed ?? false }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const pool = { connects: 0, connect: async () => ((pool.connects += 1), { query, release: () => undefined }) };
  return pool as unknown as Pool & { connects: number };
}
const deps = (available = true) => ({ signal: createRecordingRunActionSignal(), available: () => available });

describe('requestPreview marks the run-action sweep', () => {
  afterEach(() => setPendingHooks(null));
  const hooked = () => {
    const sets: string[] = [];
    setPendingHooks({ store: { get: async () => null, set: async (k: string) => void sets.push(k), delete: async () => undefined } });
    return sets;
  };
  it('a new preview sets the run-action-sweep pending marker, so the gated cron does not skip it', async () => {
    const sets = hooked();
    await requestPreview({ pool: fakePool({}), principal }, input, deps());
    await new Promise((r) => setTimeout(r, 0));
    expect(sets).toEqual(['pending:run-action-sweep']);
  });
  it('a replayed preview sets no marker', async () => {
    const sets = hooked();
    await requestPreview({ pool: fakePool({ replay: true, replayed: true }), principal }, { ...input, idempotencyKey: 'k1' }, deps());
    await new Promise((r) => setTimeout(r, 0));
    expect(sets).toEqual([]);
  });
});

describe('requestPreview', () => {
  it('refuses a token principal before any SQL', async () => {
    const pool = fakePool({});
    await expect(requestPreview({ pool, principal: { ...principal, tokenId: randomUUID() } }, input, deps())).rejects.toBeInstanceOf(ForbiddenError);
    expect(pool.connects).toBe(0);
  });

  it('refuses when the worker cannot run a preview, before any SQL', async () => {
    const pool = fakePool({});
    const d = deps(false);
    await expect(requestPreview({ pool, principal }, input, d)).rejects.toBeInstanceOf(PreviewUnavailableError);
    expect(pool.connects).toBe(0);
    expect(d.signal.sent).toEqual([]);
  });

  it.each([19, 21, 0, Number.NaN])('refuses a model cap of %s before any SQL', async (cap) => {
    const pool = fakePool({});
    await expect(requestPreview({ pool, principal }, { ...input, confirmModelCapUsd: cap }, deps())).rejects.toBeInstanceOf(PreviewCapNotConfirmedError);
    expect(pool.connects).toBe(0);
  });

  it('refuses a repo id that is not a uuid as not found, before any SQL', async () => {
    const pool = fakePool({});
    await expect(requestPreview({ pool, principal }, { ...input, repoId: 'not-a-uuid' }, deps())).rejects.toBeInstanceOf(NotFoundError);
    expect(pool.connects).toBe(0);
  });

  it.each([
    ['a plain member', { role: 'member' }, ForbiddenError],
    ['a non-member', { role: null }, ForbiddenError],
    ['a repo that is not team_readonly', { appKind: 'team' }, NotFoundError],
    ['a missing repo', { appKind: null }, NotFoundError],
    ['no working model key', { modelKey: false }, PreviewNoModelKeyError],
    ['the daily cap reached', { used: '10' }, PreviewCapacityError],
    ['the daily cap passed', { used: '10.5' }, PreviewCapacityError],
  ] as const)('refuses %s and never reaches the definer or the signal', async (_n, world, err) => {
    const log: string[] = [];
    const d = deps();
    await expect(requestPreview({ pool: fakePool(world, log), principal }, input, d)).rejects.toBeInstanceOf(err);
    expect(log).not.toContain('DEFINER');
    expect(d.signal.sent).toEqual([]);
  });

  it('checks in order: role, repo, model key, daily cap, then the definer; one signal after COMMIT', async () => {
    const log: string[] = [];
    const d = deps();
    const res = await requestPreview({ pool: fakePool({ used: '9.99' }, log), principal }, input, d);
    expect(res).toEqual({ previewId: 'pv-1', actionId: 'act-1', state: 'accepted', replayed: false });
    expect(log.filter((e) => ['ROLE', 'REPO', 'KEY', 'CAP', 'DEFINER', 'COMMIT'].includes(e))).toEqual(['ROLE', 'REPO', 'KEY', 'CAP', 'DEFINER', 'COMMIT']);
    expect(d.signal.sent).toEqual([{ actionId: 'act-1', accountId: A, kind: 'start_preview' }]);
  });

  it('a replayed key skips the state checks and signals nothing', async () => {
    const d = deps();
    const res = await requestPreview(
      { pool: fakePool({ replay: true, replayed: true, used: '50', modelKey: false, appKind: null }), principal },
      { ...input, idempotencyKey: 'k1' },
      d,
    );
    expect(res).toMatchObject({ previewId: 'pv-1', replayed: true });
    expect(d.signal.sent).toEqual([]);
  });

  it.each([
    ['23505', PreviewExistsError],
    ['P0002', NotFoundError],
    ['42501', ForbiddenError],
  ] as const)('maps the definer error %s to a typed error and sends no signal', async (code, err) => {
    const d = deps();
    await expect(requestPreview({ pool: fakePool({ definerCode: code }), principal }, input, d)).rejects.toBeInstanceOf(err);
    expect(d.signal.sent).toEqual([]);
  });

  it('passes any other database error through untouched', async () => {
    await expect(requestPreview({ pool: fakePool({ definerCode: '22023' }), principal }, input, deps())).rejects.toMatchObject({ code: '22023' });
  });
});

describe('getPreview', () => {
  it('reads a malformed id as not found without touching the database', async () => {
    const pool = fakePool({});
    await expect(getPreview({ pool, principal }, 'nope')).rejects.toBeInstanceOf(NotFoundError);
    expect(pool.connects).toBe(0);
  });
});
