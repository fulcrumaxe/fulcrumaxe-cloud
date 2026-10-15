import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { seedAccountWithMember, seedUser } from './helpers/seed.js';

interface Identity {
  accountId: string;
  userId: string;
}
interface Body {
  id: string;
  runner_routing: unknown;
}

/** D#605 FL-4: PUT /repos/{id}/runner-routing and PUT /work-items/{id}/runner-routing through the real handler against real Postgres (RLS, the definer, its audit row). */
describe('D#605 FL-4: the routing rules routes', () => {
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
  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    admin.release();
    await adminPool.end();
    await platformOpsPool.end();
    await appUserPool.end();
  });

  async function put(identity: Identity, path: string, body: unknown, bearer?: string): Promise<Response> {
    const headers = new Headers({ 'content-type': 'application/json' });
    if (bearer) headers.set('authorization', `Bearer ${bearer}`);
    else headers.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(identity)}`);
    return handleApiRequest(new Request(`http://localhost${path}`, { method: 'PUT', headers, body: JSON.stringify(body) }), appUserPool, platformOpsPool, ROUTES);
  }
  async function addMember(accountId: string, role: 'admin' | 'member'): Promise<Identity> {
    const userId = randomUUID();
    await seedUser(admin, userId);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [accountId, userId, role]);
    return { accountId, userId };
  }
  async function fixture() {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const repoId = randomUUID();
    const itemId = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, 'team', 'acme', 'widgets')`, [repoId, owner.accountId, Math.floor(Math.random() * 1e9) + 1]);
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, gh_number, provenance, stage) VALUES ($1, $2, $3, 'feature', 5, 'internal', 'pr_opened')`, [itemId, owner.accountId, repoId]);
    const runnerId = randomUUID();
    await admin.query(
      `INSERT INTO runners (id, account_id, registered_by, public_key_jwk, jkt, credential_mode) VALUES ($1, $2, $3, '{"kty":"OKP","crv":"Ed25519","x":"x"}'::jsonb, $4, 'api_key')`,
      [runnerId, owner.accountId, owner.userId, randomUUID().replaceAll('-', '').padEnd(43, 'a')],
    );
    return { owner, repoId, itemId, runnerId, repoPath: `/api/v1/repos/${repoId}/runner-routing`, itemPath: `/api/v1/work-items/${itemId}/runner-routing` };
  }
  const stored = async (table: 'repos' | 'work_items', id: string) => (await admin.query(`SELECT runner_routing FROM ${table} WHERE id = $1`, [id])).rows[0].runner_routing;
  const audits = async (accountId: string) => (await admin.query(`SELECT actor FROM audit_log WHERE account_id = $1 AND action = 'runner.routing_set'`, [accountId])).rows;
  const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

  it('an owner and an admin set the rules on a repo and an item, read them back from the reply, and each change is audited', async () => {
    const f = await fixture();
    const adminUser = await addMember(f.owner.accountId, 'admin');
    const rules = { require: { os: 'macos', labels: ['gpu'] }, prefer: [f.runnerId] };
    const res = await put(f.owner, f.repoPath, rules);
    expect(res.status).toBe(200);
    expect((await res.json()) as Body).toEqual({ id: f.repoId, runner_routing: rules });
    expect(await stored('repos', f.repoId)).toEqual(rules);
    const itemRes = await put(adminUser, f.itemPath, { require: { os: 'linux' } });
    expect(itemRes.status).toBe(200);
    expect(await stored('work_items', f.itemId)).toEqual({ require: { os: 'linux' } });
    expect((await audits(f.owner.accountId)).map((r) => r.actor)).toEqual([f.owner.userId, adminUser.userId]);
  });

  it('{} clears the rules (stored as none), which is how an item goes back to the repo default', async () => {
    const f = await fixture();
    await put(f.owner, f.itemPath, { require: { os: 'linux' } });
    const res = await put(f.owner, f.itemPath, {});
    expect(res.status).toBe(200);
    expect(((await res.json()) as Body).runner_routing).toBeNull();
    expect(await stored('work_items', f.itemId)).toBeNull();
    await put(f.owner, f.repoPath, { require: {} });
    expect(await stored('repos', f.repoId)).toBeNull();
  });

  it('AC6: a member calling either route gets 403 and nothing is written', async () => {
    const f = await fixture();
    const member = await addMember(f.owner.accountId, 'member');
    for (const path of [f.repoPath, f.itemPath]) {
      const res = await put(member, path, { require: { os: 'linux' } });
      expect(res.status).toBe(403);
    }
    expect(await stored('repos', f.repoId)).toBeNull();
    expect(await stored('work_items', f.itemId)).toBeNull();
    expect(await audits(f.owner.accountId)).toEqual([]);
  });

  it('AC6: a prefer naming another account\'s runner (or no runner at all), or a label outside the pattern, gets 400 and nothing is written', async () => {
    const f = await fixture();
    const other = await fixture();
    for (const path of [f.repoPath, f.itemPath]) {
      for (const body of [
        { prefer: [other.runnerId] },
        { prefer: [randomUUID()] },
        { require: { labels: ['GPU!'] } },
        { require: { heavy_labels: ['-x'] } },
        { require: { os: 'windows' } },
        { require: { unknown: 1 } },
        { prefer: ['not-a-uuid'] },
        { extra: true },
      ]) {
        const res = await put(f.owner, path, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(await code(res)).toBe('invalid_input');
      }
    }
    expect(await stored('repos', f.repoId)).toBeNull();
    expect(await stored('work_items', f.itemId)).toBeNull();
    expect(await audits(f.owner.accountId)).toEqual([]);
  });

  it('a removed runner cannot be preferred, and the other account\'s repo and item do not exist for the caller', async () => {
    const f = await fixture();
    const other = await fixture();
    await admin.query(`UPDATE runners SET revoked_at = now() WHERE id = $1`, [f.runnerId]);
    expect((await put(f.owner, f.repoPath, { prefer: [f.runnerId] })).status).toBe(400);
    expect((await put(f.owner, other.repoPath, {})).status).toBe(404);
    expect((await put(f.owner, other.itemPath, {})).status).toBe(404);
    expect((await put(f.owner, '/api/v1/repos/not-a-uuid/runner-routing', {})).status).toBe(404);
    expect(await stored('repos', other.repoId)).toBeNull();
  });

  it('an API token can never change the rules, and platform_ops cannot call the function', async () => {
    const f = await fixture();
    const plaintext = generateToken();
    await insertApiToken(appUserPool, { accountId: f.owner.accountId, createdBy: f.owner.userId, tokenHash: hashToken(plaintext), displayHint: 'fxat_...test', scopes: ['read', 'work_items:write'], expiresAt: new Date(Date.now() + 86_400_000) });
    const res = await put(f.owner, f.repoPath, { require: { os: 'linux' } }, plaintext);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await stored('repos', f.repoId)).toBeNull();
    await expect(platformOpsPool.query(`SELECT runner_routing_set('repo', $1, NULL)`, [f.repoId])).rejects.toMatchObject({ code: '42501' });
  });
});
