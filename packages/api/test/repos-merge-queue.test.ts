import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { mergeQueueModeDeps, type MergeQueueModeReader } from '../src/routes/mergeQueueMode.js';
import { seedAccountWithMember } from './helpers/seed.js';

/**
 * D#694 B7-2: the repo settings read carries `merge_queue.state`, derived on each read and never stored. It is `not_installed` for a repo with no installation (the reader is not asked) and `unreadable` (never `off`) when no
 * reader is set, or the reader fails or answers something else. Through the real `handleApiRequest` against real Postgres.
 */
describe('D#694 B7-2: merge_queue on the repo settings', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = 's'.repeat(32);
  });
  afterEach(() => {
    mergeQueueModeDeps.getReader = () => null;
  });
  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    admin.release();
    await adminPool.end();
    await platformOpsPool.end();
    await appUserPool.end();
  });

  async function seed(installed: boolean): Promise<{ identity: { accountId: string; userId: string }; repoId: string }> {
    const identity = await seedAccountWithMember(admin, { role: 'owner' });
    let installationId: string | null = null;
    if (installed) {
      installationId = (await admin.query<{ id: string }>(`INSERT INTO installations (account_id, gh_installation_id, app_kind) VALUES ($1, $2, 'team') RETURNING id`, [identity.accountId, Math.floor(Math.random() * 1e9) + 1])).rows[0]!.id;
    }
    const repoId = (await admin.query<{ id: string }>(`INSERT INTO repos (account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, 'web', 'acme', 'widgets') RETURNING id`, [identity.accountId, installationId, Math.floor(Math.random() * 1e9) + 1])).rows[0]!.id;
    return { identity, repoId };
  }
  async function state(identity: { accountId: string; userId: string }, repoId: string): Promise<unknown> {
    const headers = new Headers({ cookie: `${SESSION_COOKIE_NAME}=${await signSession(identity)}` });
    const res = await handleApiRequest(new Request(`http://localhost/api/v1/repos/${repoId}/settings`, { method: 'GET', headers }), appUserPool, platformOpsPool, ROUTES);
    expect(res.status).toBe(200);
    return ((await res.json()) as { merge_queue?: { state?: unknown } }).merge_queue;
  }
  const reader = (answer: () => Promise<never | string>): MergeQueueModeReader => ({ read: answer as MergeQueueModeReader['read'] });

  it('is the reader\'s on or off for an installed repo, and the reader is asked with the caller\'s own account and repo', async () => {
    const { identity, repoId } = await seed(true);
    const asked: unknown[] = [];
    for (const answer of ['on', 'off', 'runner']) {
      mergeQueueModeDeps.getReader = () => reader(async () => (asked.push(answer), answer));
      expect(await state(identity, repoId)).toEqual({ state: answer });
    }
    expect(asked).toEqual(['on', 'off', 'runner']);
  });

  it('is not_installed for a repo with no installation, in every execution mode, and the reader is never asked (D#694 C10-1)', async () => {
    let asked = 0;
    mergeQueueModeDeps.getReader = () => reader(async () => (asked++, 'on'));
    for (const mode of ['sandbox', 'runner_local']) {
      const bare = await seed(false);
      await admin.query(`UPDATE repos SET execution_mode = $2 WHERE id = $1`, [bare.repoId, mode]);
      expect(await state(bare.identity, bare.repoId), mode).toEqual({ state: 'not_installed' });
    }
    expect(asked).toBe(0);
  });

  it('an installed runner_local repo still answers runner, whatever the reader says (D#694 C10-2)', async () => {
    const { identity, repoId } = await seed(true);
    await admin.query(`UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1`, [repoId]);
    mergeQueueModeDeps.getReader = () => reader(async () => 'runner');
    expect(await state(identity, repoId)).toEqual({ state: 'runner' });
  });

  it('is unreadable with no reader set, and when the reader fails or answers something else', async () => {
    const installed = await seed(true);
    expect(await state(installed.identity, installed.repoId)).toEqual({ state: 'unreadable' });
    mergeQueueModeDeps.getReader = () => reader(async () => Promise.reject(new Error('GitHub said token ghs_secret')));
    expect(await state(installed.identity, installed.repoId)).toEqual({ state: 'unreadable' });
    for (const odd of ['maybe', '', 'ON']) {
      mergeQueueModeDeps.getReader = () => reader(async () => odd);
      expect(await state(installed.identity, installed.repoId), odd).toEqual({ state: 'unreadable' });
    }
  });
});
