import { randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { createRecordingRunActionSignal } from '../src/runActions/index.js';
import {
  PreviewCapacityError,
  PreviewExistsError,
  PreviewNoModelKeyError,
  getLatestPreview,
  getPreview,
  requestPreview,
} from '../src/onboarding/index.js';
import { ForbiddenError, NotFoundError } from '../src/tenancy/errors.js';

/** D#2 H17c-1: requestPreview and getPreview against the real definers (0685). */
describe('onboarding preview services (pg)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    await admin.query(`UPDATE model_connections SET status = 'ok' WHERE account_id = $1`, [a.accountId]);
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appPool.end();
  });

  const ctx = (r: SeedRefs = a, userId = r.userId) => ({ pool: appPool, principal: { accountId: r.accountId, userId } });
  const deps = () => ({ signal: createRecordingRunActionSignal(), available: () => true });
  /** A repo on a live team_readonly installation with its installer record. */
  async function target(r: SeedRefs, kind = 'team_readonly'): Promise<{ repoId: string; ghUserId: number }> {
    const inst = randomUUID();
    const repoId = randomUUID();
    const gh = randomInt(1, 2_000_000_000);
    const ghUserId = randomInt(1, 2_000_000_000);
    await admin.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, $4)`, [inst, r.accountId, gh, kind]);
    await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner) VALUES ($1, $2, $3, 1, 'team', $4)`, [repoId, r.accountId, inst, `o${gh}`]);
    await admin.query(`INSERT INTO installation_installers (gh_installation_id, app_kind, installer_gh_user_id) VALUES ($1, $2, $3)`, [gh, kind, ghUserId]);
    return { repoId, ghUserId };
  }
  const counts = async (r: SeedRefs) =>
    (await admin.query(
      `SELECT (SELECT count(*)::int FROM onboarding_previews WHERE account_id = $1) p,
              (SELECT count(*)::int FROM run_action_requests WHERE account_id = $1 AND kind = 'start_preview') q`,
      [r.accountId],
    )).rows[0];

  it('a new request writes one preview and one action in one transaction, then signals once; a replay adds nothing', async () => {
    const t = await target(a);
    const d = deps();
    const first = await requestPreview(ctx(), { repoId: t.repoId, confirmModelCapUsd: 20, idempotencyKey: 'svc-1' }, d);
    expect(first).toMatchObject({ state: 'accepted', replayed: false });
    expect(d.signal.sent).toEqual([{ actionId: first.actionId, accountId: a.accountId, kind: 'start_preview' }]);
    const row = (await admin.query('SELECT state, gh_user_id, run_action_id FROM onboarding_previews WHERE id = $1', [first.previewId])).rows[0];
    expect(row).toEqual({ state: 'requested', gh_user_id: String(t.ghUserId), run_action_id: first.actionId });
    const again = await requestPreview(ctx(), { repoId: t.repoId, confirmModelCapUsd: 20, idempotencyKey: 'svc-1' }, d);
    expect(again).toEqual({ ...first, replayed: true });
    expect(d.signal.sent).toHaveLength(1);
    expect(await counts(a)).toMatchObject({ p: 1, q: 1 });
  });

  it('a second request for the same installer is PreviewExistsError and leaves no extra row or signal', async () => {
    const before = await counts(a);
    const t = await target(a);
    const d = deps();
    const first = await requestPreview(ctx(), { repoId: t.repoId, confirmModelCapUsd: 20 }, d);
    await expect(requestPreview(ctx(), { repoId: t.repoId, confirmModelCapUsd: 20 }, d)).rejects.toBeInstanceOf(PreviewExistsError);
    expect(d.signal.sent).toHaveLength(1);
    const after = await counts(a);
    expect(after.p - before.p).toBe(1);
    expect(after.q - before.q).toBe(1);
    expect(first.replayed).toBe(false);
  });

  it('a member, a token and another account\'s repo are refused and write nothing', async () => {
    const t = await target(a);
    const before = await counts(a);
    const memberId = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [memberId, `${memberId}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [a.accountId, memberId]);
    const d = deps();
    await expect(requestPreview(ctx(a, memberId), { repoId: t.repoId, confirmModelCapUsd: 20 }, d)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(requestPreview({ pool: appPool, principal: { ...ctx().principal, tokenId: randomUUID() } }, { repoId: t.repoId, confirmModelCapUsd: 20 }, d)).rejects.toBeInstanceOf(ForbiddenError);
    const theirs = await target(b);
    await expect(requestPreview(ctx(), { repoId: theirs.repoId, confirmModelCapUsd: 20 }, d)).rejects.toBeInstanceOf(NotFoundError);
    expect(await counts(a)).toEqual(before);
    expect(d.signal.sent).toEqual([]);
  });

  it('a repo on a team installation is not found', async () => {
    const t = await target(a, 'team');
    await expect(requestPreview(ctx(), { repoId: t.repoId, confirmModelCapUsd: 20 }, deps())).rejects.toBeInstanceOf(NotFoundError);
  });

  it('an account without a validated model key is PreviewNoModelKeyError', async () => {
    const t = await target(b);
    await expect(requestPreview(ctx(b), { repoId: t.repoId, confirmModelCapUsd: 20 }, deps())).rejects.toBeInstanceOf(PreviewNoModelKeyError);
    expect(await counts(b)).toEqual({ p: 0, q: 0 });
  });

  it('once today\'s preview compute reaches 10 USD across accounts, a request is PreviewCapacityError and writes nothing', async () => {
    const t = await target(a);
    const before = await counts(a);
    await admin.query(
      `INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget, purpose) VALUES ($1, $2, 10, 'open', 'foreground_compute', 'preview')`,
      [b.accountId, b.runId],
    );
    const d = deps();
    await expect(requestPreview(ctx(), { repoId: t.repoId, confirmModelCapUsd: 20 }, d)).rejects.toBeInstanceOf(PreviewCapacityError);
    expect(await counts(a)).toEqual(before);
    expect(d.signal.sent).toEqual([]);
    await admin.query(`DELETE FROM spend_reservations WHERE account_id = $1 AND purpose = 'preview'`, [b.accountId]);
    await expect(requestPreview(ctx(), { repoId: t.repoId, confirmModelCapUsd: 20 }, d)).resolves.toMatchObject({ replayed: false });
  });

  it('previews that have finished (compute released by finalize) still count toward the day, so the next request is refused', async () => {
    const t = await target(a);
    await admin.query(
      `INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget, purpose) VALUES ($1, $2, 10, 'open', 'foreground_compute', 'preview')`,
      [b.accountId, b.runId],
    );
    await admin.query(`UPDATE spend_reservations SET state = 'released' WHERE account_id = $1 AND purpose = 'preview'`, [b.accountId]);
    const d = deps();
    await expect(requestPreview(ctx(), { repoId: t.repoId, confirmModelCapUsd: 20 }, d)).rejects.toBeInstanceOf(PreviewCapacityError);
    expect(d.signal.sent).toEqual([]);
    await admin.query(`DELETE FROM spend_reservations WHERE account_id = $1 AND purpose = 'preview'`, [b.accountId]);
  });

  describe('getPreview', () => {
    async function started(): Promise<string> {
      const t = await target(a);
      const { previewId } = await requestPreview(ctx(), { repoId: t.repoId, confirmModelCapUsd: 20 }, deps());
      return previewId;
    }

    it('reads a requested preview; another account\'s id and a random id are NotFound', async () => {
      const id = await started();
      expect(await getPreview(ctx(), id)).toMatchObject({ preview_id: id, state: 'requested', started_at: null, finished_at: null, result: null, void_reason: null, run_status: null });
      await expect(getPreview(ctx(b), id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(getPreview(ctx(), randomUUID())).rejects.toBeInstanceOf(NotFoundError);
    });

    it('takes finished_at and the result from the linked run and stores neither', async () => {
      const id = await started();
      await admin.query(`UPDATE onboarding_previews SET state = 'running', run_id = $2, started_at = now() WHERE id = $1`, [id, a.runId]);
      const project = (env: unknown) => ({ seen: env });
      expect(await getPreview(ctx(), id, { projectResult: project })).toMatchObject({ state: 'running', finished_at: null, result: null, run_status: 'running' });
      await admin.query(`UPDATE agent_runs SET status = 'succeeded', envelope = '{"k":1}'::jsonb WHERE id = $1`, [a.runId]);
      const done = await getPreview(ctx(), id, { projectResult: project });
      const ended = (await admin.query('SELECT ended_at FROM agent_runs WHERE id = $1', [a.runId])).rows[0].ended_at as Date;
      expect(done).toMatchObject({ state: 'finished', run_status: 'succeeded', result: { seen: { k: 1 } }, finished_at: ended.toISOString() });
      await admin.query(`UPDATE agent_runs SET status = 'failed' WHERE id = $1`, [a.runId]);
      expect(await getPreview(ctx(), id, { projectResult: project })).toMatchObject({ state: 'finished', run_status: 'failed', result: null });
      expect((await admin.query('SELECT state FROM onboarding_previews WHERE id = $1', [id])).rows[0].state).toBe('running');
    });

    it('reports a void preview with its reason', async () => {
      const id = await started();
      await admin.query(`UPDATE onboarding_previews SET state = 'void', void_reason = 'preview_unavailable' WHERE id = $1`, [id]);
      expect(await getPreview(ctx(), id)).toMatchObject({ state: 'void', void_reason: 'preview_unavailable', result: null });
    });

    it('refuses a token principal before any SQL, even for a preview of its own account', async () => {
      const id = await started();
      const tokenId = randomUUID();
      await expect(getPreview({ pool: appPool, principal: { ...ctx().principal, tokenId } }, id)).rejects.toBeInstanceOf(ForbiddenError);
      // A pool that cannot be used proves no query ran.
      await expect(getPreview({ pool: null as unknown as Pool, principal: { ...ctx().principal, tokenId } }, id)).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  describe('getLatestPreview', () => {
    async function ownAccount(): Promise<SeedRefs> {
      const r = await seedAccount(admin, randomUUID());
      await admin.query(`UPDATE model_connections SET status = 'ok' WHERE account_id = $1`, [r.accountId]);
      return r;
    }
    async function made(r: SeedRefs, createdAt: string): Promise<string> {
      const t = await target(r);
      const { previewId } = await requestPreview(ctx(r), { repoId: t.repoId, confirmModelCapUsd: 20 }, deps());
      await admin.query('UPDATE onboarding_previews SET created_at = $2 WHERE id = $1', [previewId, createdAt]);
      return previewId;
    }

    it('is null for an account with no preview', async () => {
      expect(await getLatestPreview(ctx(await ownAccount()))).toBeNull();
    });

    it('returns the newest preview, a void one included, and never another account\'s', async () => {
      const mine = await ownAccount();
      const other = await ownAccount();
      await made(mine, '2026-01-01T00:00:00Z');
      const newest = await made(mine, '2026-01-03T00:00:00Z');
      await made(mine, '2026-01-02T00:00:00Z');
      const theirs = await made(other, '2026-02-01T00:00:00Z');
      await admin.query(`UPDATE onboarding_previews SET state = 'void', void_reason = 'preview_unavailable' WHERE id = $1`, [newest]);
      expect(await getLatestPreview(ctx(mine))).toMatchObject({ preview_id: newest, state: 'void', void_reason: 'preview_unavailable' });
      expect((await getLatestPreview(ctx(other)))?.preview_id).toBe(theirs);
    });

    it('breaks a created_at tie by the larger id', async () => {
      const mine = await ownAccount();
      const first = await made(mine, '2026-03-01T00:00:00Z');
      const second = await made(mine, '2026-03-01T00:00:00Z');
      expect((await getLatestPreview(ctx(mine)))?.preview_id).toBe(first > second ? first : second);
    });

    it('applies the projection to a succeeded run', async () => {
      const r = await ownAccount();
      const previewId = await made(r, '2030-01-01T00:00:00Z');
      await admin.query(`UPDATE onboarding_previews SET state = 'running', run_id = $2, started_at = now() WHERE id = $1`, [previewId, r.runId]);
      await admin.query(`UPDATE agent_runs SET status = 'succeeded', envelope = '{"k":2}'::jsonb WHERE id = $1`, [r.runId]);
      expect(await getLatestPreview(ctx(r), { projectResult: (env) => ({ seen: env }) })).toMatchObject({
        preview_id: previewId,
        state: 'finished',
        result: { seen: { k: 2 } },
      });
    });

    it('refuses a token principal before any SQL', async () => {
      const dead = { pool: null as unknown as Pool, principal: { ...ctx().principal, tokenId: randomUUID() } };
      await expect(getLatestPreview(dead)).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});
