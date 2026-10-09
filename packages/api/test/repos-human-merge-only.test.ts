import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { seedAccountWithMember } from './helpers/seed.js';

/**
 * D#6 M1G-a: the operator's human-merge-only lock on the repo guard settings, through the real `handleApiRequest` against
 * real Postgres. A listed repo answers 409 `human_merge_only` to `auto_merge: true` and writes nothing (no row change, no
 * audit row); turning auto-merge off is always allowed; an unlisted repo behaves exactly as before.
 */
const ENV = 'FX_HUMAN_MERGE_ONLY_REPO_IDS';

describe('D#6 M1G-a: human merge only on the repo settings', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  const saved = process.env[ENV];

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = 's'.repeat(32);
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
  });

  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    admin.release();
    await adminPool.end();
    await platformOpsPool.end();
    await appUserPool.end();
  });

  async function call(identity: { accountId: string; userId: string }, method: string, urlPath: string, body?: unknown): Promise<Response> {
    const headers = new Headers({ cookie: `${SESSION_COOKIE_NAME}=${await signSession(identity)}` });
    if (body !== undefined) headers.set('content-type', 'application/json');
    return handleApiRequest(new Request(`http://localhost/api/v1${urlPath}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), appUserPool, platformOpsPool, ROUTES);
  }

  async function seedRepo(accountId: string): Promise<{ repoId: string; ghRepoId: number }> {
    const ghRepoId = Math.floor(Math.random() * 1e9) + 1;
    const { rows } = await admin.query<{ id: string }>(`INSERT INTO repos (account_id, gh_repo_id, product) VALUES ($1, $2, 'web') RETURNING id`, [accountId, ghRepoId]);
    return { repoId: rows[0]!.id, ghRepoId };
  }
  const settingsOf = async (repoId: string) => (await admin.query<{ settings: unknown }>(`SELECT settings FROM repos WHERE id = $1`, [repoId])).rows[0]!.settings;
  const audits = async (accountId: string) => Number((await admin.query<{ n: string }>(`SELECT count(*) AS n FROM audit_log WHERE account_id = $1 AND action = 'role_settings.guard_changed'`, [accountId])).rows[0]!.n);

  it('a listed repo: GET carries human_merge_only: true; PATCH auto_merge: true is 409 with no row change and no audit row', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const { repoId, ghRepoId } = await seedRepo(owner.accountId);
    process.env[ENV] = `7,${ghRepoId}`;
    const url = `/repos/${repoId}/settings`;

    expect(await (await call(owner, 'GET', url)).json()).toEqual({ auto_merge: false, block_external_auto_merge: true, human_merge_only: true });
    const before = await settingsOf(repoId);
    const refused = await call(owner, 'PATCH', url, { auto_merge: true });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('human_merge_only');
    expect(await settingsOf(repoId)).toEqual(before);
    expect(await audits(owner.accountId)).toBe(0);
    // A combined change is refused whole: the guard toggle in the same body is not applied either.
    expect((await call(owner, 'PATCH', url, { auto_merge: true, block_external_auto_merge: true })).status).toBe(409);
    expect(await settingsOf(repoId)).toEqual(before);
  });

  it('a listed repo: turning auto-merge off, and the guard toggle, are still allowed (the gate ignores a stored on)', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const { repoId, ghRepoId } = await seedRepo(owner.accountId);
    await admin.query(`UPDATE repos SET settings = '{"autoMerge": true}' WHERE id = $1`, [repoId]);
    process.env[ENV] = String(ghRepoId);
    const url = `/repos/${repoId}/settings`;
    expect(await (await call(owner, 'GET', url)).json()).toMatchObject({ auto_merge: true, human_merge_only: true });
    const off = await call(owner, 'PATCH', url, { auto_merge: false });
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ auto_merge: false, block_external_auto_merge: true, human_merge_only: true });
    expect(await audits(owner.accountId)).toBe(1);
  });

  it('an unlisted repo behaves exactly as before: no human_merge_only key, auto-merge can be turned on', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const { repoId, ghRepoId } = await seedRepo(owner.accountId);
    process.env[ENV] = String(ghRepoId + 1);
    const url = `/repos/${repoId}/settings`;
    expect(await (await call(owner, 'GET', url)).json()).toEqual({ auto_merge: false, block_external_auto_merge: true });
    const on = await call(owner, 'PATCH', url, { auto_merge: true });
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ auto_merge: true, block_external_auto_merge: true });
    delete process.env[ENV];
    expect(await (await call(owner, 'GET', url)).json()).toEqual({ auto_merge: true, block_external_auto_merge: true });
  });

  it('a malformed value locks every repo (fail closed), listed or not', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const { repoId } = await seedRepo(owner.accountId);
    for (const bad of ['abc', '1,,2', ' 1', '-1']) {
      process.env[ENV] = bad;
      const url = `/repos/${repoId}/settings`;
      expect(await (await call(owner, 'GET', url)).json()).toMatchObject({ human_merge_only: true });
      expect((await call(owner, 'PATCH', url, { auto_merge: true })).status, bad).toBe(409);
    }
    expect(await settingsOf(repoId)).toEqual({});
  });

  it('another account\'s repo is still 404, listed or not', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const other = await seedAccountWithMember(admin, { role: 'owner' });
    const { repoId, ghRepoId } = await seedRepo(owner.accountId);
    process.env[ENV] = String(ghRepoId);
    expect((await call(other, 'PATCH', `/repos/${repoId}/settings`, { auto_merge: true })).status).toBe(404);
    expect((await call(other, 'GET', `/repos/${randomUUID()}/settings`)).status).toBe(404);
  });
});
