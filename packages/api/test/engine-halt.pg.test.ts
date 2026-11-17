import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { ENGINE_COMMAND_KINDS } from '@fulcrumaxe/runner-protocol';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { handleApiRequest } from '../src/handler.js';
import { runnerWorkKeyFor, setPendingHooks } from '@fx/core/src/pendingWork.js';
import { ROUTES } from '../src/routes/index.js';
import { seedAccountWithMember, seedUser } from './helpers/seed.js';

interface Identity {
  accountId: string;
  userId: string;
}
interface ErrorBody {
  error: { code: string; message: string };
}

/**
 * Engine bridge EB-11a: the halt and clear routes through the real handler against real Postgres (RLS, the definer functions of 1031, audit_write).
 * Only a person clears a halt: an owner or admin on a session. L3: unauthenticated 401, another account 404, a member 403, a token 403.
 */
describe('EB-11a: engine halt routes', () => {
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
    await Promise.all([adminPool.end(), platformOpsPool.end(), appUserPool.end()]);
  });

  async function call(identity: Identity | null, method: string, urlPath: string, body?: unknown, bearer?: string, headers: Record<string, string> = {}): Promise<Response> {
    const h = new Headers(headers);
    if (bearer) h.set('authorization', `Bearer ${bearer}`);
    else if (identity) h.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(identity)}`);
    h.set('content-type', 'application/json');
    const req = new Request(`http://localhost/api/v1${urlPath}`, { method, headers: h, body: JSON.stringify(body ?? {}) });
    return handleApiRequest(req, appUserPool, platformOpsPool, ROUTES);
  }
  async function addMember(accountId: string, role: 'admin' | 'member'): Promise<Identity> {
    const userId = randomUUID();
    await seedUser(admin, userId);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [accountId, userId, role]);
    return { accountId, userId };
  }
  async function seedRepo(accountId: string): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(`INSERT INTO repos (account_id, installation_id, gh_repo_id, product) VALUES ($1, NULL, $2, 'web') RETURNING id`, [accountId, Math.floor(Math.random() * 1e12)]);
    return rows[0]!.id;
  }
  async function tokenFor(who: Identity, scopes: ('read' | 'work_items:write')[] = ['read']): Promise<string> {
    const plaintext = generateToken();
    await insertApiToken(appUserPool, { accountId: who.accountId, createdBy: who.userId, tokenHash: hashToken(plaintext), displayHint: 'fxat_...test', scopes, expiresAt: new Date(Date.now() + 86_400_000) });
    return plaintext;
  }
  async function fixture() {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const adminUser = await addMember(owner.accountId, 'admin');
    const member = await addMember(owner.accountId, 'member');
    const repoId = await seedRepo(owner.accountId);
    const other = await seedAccountWithMember(admin, { role: 'owner' });
    return { owner, adminUser, member, repoId, other };
  }
  const audits = async (accountId: string) =>
    (await admin.query<{ action: string; actor: string; payload: Record<string, unknown> }>(`SELECT action, actor, payload FROM audit_log WHERE account_id = $1 AND action LIKE 'engine_halt.%' ORDER BY created_at, id`, [accountId])).rows;
  const marker = async (repoId: string) =>
    (await admin.query<{ halted: boolean; halt_epoch: number }>(`SELECT halted_at IS NOT NULL AS halted, halt_epoch FROM engine_repo_controls WHERE repo_id = $1`, [repoId])).rows[0];
  const errOf = async (res: Response): Promise<ErrorBody> => (await res.json()) as ErrorBody;

  it('halt: an owner halts; the reply, the marker and one engine_halt.set audit row agree; a repeat is 200 with no epoch change and no second audit row', async () => {
    const f = await fixture();
    const res = await call(f.owner, 'POST', `/engine/repos/${f.repoId}/halt`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ halt_epoch: 1, halted: true, applied: false });
    expect(await marker(f.repoId)).toEqual({ halted: true, halt_epoch: 1 });
    const rows = await audits(f.owner.accountId);
    expect(rows.map((r) => r.action)).toEqual(['engine_halt.set']);
    expect(rows[0]!.payload).toEqual({ repo_id: f.repoId, halt_epoch: 1 });

    const again = await call(f.owner, 'POST', `/engine/repos/${f.repoId}/halt`);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ halt_epoch: 1, halted: true, applied: false });
    expect(await marker(f.repoId)).toEqual({ halted: true, halt_epoch: 1 });
    expect(await audits(f.owner.accountId)).toHaveLength(1);
  });

  it('clear: an admin clears; the epoch stays; one engine_halt.cleared row; a clear when not halted is 200 and writes nothing; the next halt is epoch 2', async () => {
    const f = await fixture();
    await call(f.owner, 'POST', `/engine/repos/${f.repoId}/halt`);
    const res = await call(f.adminUser, 'POST', `/engine/repos/${f.repoId}/halt/clear`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ halt_epoch: 1, halted: false });
    expect(await marker(f.repoId)).toEqual({ halted: false, halt_epoch: 1 });
    expect((await audits(f.owner.accountId)).map((r) => r.action)).toEqual(['engine_halt.set', 'engine_halt.cleared']);
    expect((await audits(f.owner.accountId))[1]!.actor).toContain(f.adminUser.userId);

    const idle = await call(f.owner, 'POST', `/engine/repos/${f.repoId}/halt/clear`);
    expect(idle.status).toBe(200);
    expect(await idle.json()).toEqual({ halt_epoch: 1, halted: false });
    expect(await audits(f.owner.accountId)).toHaveLength(2);

    const second = await call(f.owner, 'POST', `/engine/repos/${f.repoId}/halt`);
    expect(await second.json()).toEqual({ halt_epoch: 2, halted: true, applied: false });
  });

  it('a halt and a clear that change something each wake the account\'s runner; a repeat halt and a clear when not halted do not', async () => {
    const sets: string[] = [];
    setPendingHooks({ store: { get: async () => null, set: async (key) => { sets.push(key); }, delete: async () => {} } });
    try {
      const f = await fixture();
      const wake = runnerWorkKeyFor(f.owner.accountId);
      const woken = async (): Promise<number> => {
        await new Promise((r) => setTimeout(r, 150)); // the wake is fired after the commit and not awaited
        return sets.filter((k) => k === wake).length;
      };
      expect((await call(f.owner, 'POST', `/engine/repos/${f.repoId}/halt`)).status).toBe(200);
      expect(await woken()).toBe(1);
      expect((await call(f.owner, 'POST', `/engine/repos/${f.repoId}/halt`)).status).toBe(200);
      expect(await woken(), 'a repeat halt changes nothing').toBe(1);
      expect((await call(f.owner, 'POST', `/engine/repos/${f.repoId}/halt/clear`)).status).toBe(200);
      expect(await woken()).toBe(2);
      expect((await call(f.owner, 'POST', `/engine/repos/${f.repoId}/halt/clear`)).status).toBe(200);
      expect(await woken(), 'a clear when not halted changes nothing').toBe(2);
      // A refused call (a plain member) wakes nothing.
      expect((await call(f.member, 'POST', `/engine/repos/${f.repoId}/halt`)).status).toBe(403);
      expect(await woken()).toBe(2);
    } finally {
      setPendingHooks(null);
    }
  });

  const both = (repoId: string): [string, string][] => [
    ['POST', `/engine/repos/${repoId}/halt`],
    ['POST', `/engine/repos/${repoId}/halt/clear`],
  ];

  it('L3: no credential is 401 on both routes', async () => {
    const f = await fixture();
    for (const [method, url] of both(f.repoId)) {
      const res = await call(null, method, url);
      expect(res.status, url).toBe(401);
    }
    expect(await marker(f.repoId)).toBeUndefined();
  });

  it('L3: a plain member gets 403 on both routes, and nothing is written', async () => {
    const f = await fixture();
    await call(f.owner, 'POST', `/engine/repos/${f.repoId}/halt`);
    for (const [method, url] of both(f.repoId)) {
      const res = await call(f.member, method, url);
      expect(res.status, url).toBe(403);
      expect((await errOf(res)).error.code).toBe('insufficient_role');
    }
    expect(await marker(f.repoId)).toEqual({ halted: true, halt_epoch: 1 });
    expect(await audits(f.owner.accountId)).toHaveLength(1);
  });

  it('only a person clears: an API token (any scope, even the owner\'s own) gets 403 session_required on both routes and the halt stands', async () => {
    const f = await fixture();
    await call(f.owner, 'POST', `/engine/repos/${f.repoId}/halt`);
    for (const scopes of [['read'], ['read', 'work_items:write']] as ('read' | 'work_items:write')[][]) {
      const token = await tokenFor(f.owner, scopes);
      for (const [method, url] of both(f.repoId)) {
        const res = await call(f.owner, method, url, {}, token);
        expect(res.status, `${url} ${scopes}`).toBe(403);
        expect((await errOf(res)).error.code).toBe('session_required');
      }
    }
    expect(await marker(f.repoId)).toEqual({ halted: true, halt_epoch: 1 });
    expect((await audits(f.owner.accountId)).map((r) => r.action)).toEqual(['engine_halt.set']);
  });

  it('only a person clears: a runner or engine credential is not a way in (no bearer of that kind authenticates here), and no command kind names a halt', async () => {
    const f = await fixture();
    await call(f.owner, 'POST', `/engine/repos/${f.repoId}/halt`);
    const runnerShaped = { signature: 'sig1=:AAAA:', 'signature-input': 'sig1=("@method");keyid="runner"', authorization: 'Runner AAAA' };
    for (const [method, url] of both(f.repoId)) {
      const res = await call(null, method, url, {}, undefined, runnerShaped);
      expect(res.status, url).toBe(401);
      const fakeToken = await call(null, method, url, {}, 'fxrt_' + 'a'.repeat(40));
      expect(fakeToken.status, url).toBe(401);
    }
    // The command channel (EB-8a) can carry only these kinds; none of them is, or can be added to, a halt or clear.
    expect([...ENGINE_COMMAND_KINDS].filter((k) => /halt|clear|kill/.test(k))).toEqual([]);
    expect(await marker(f.repoId)).toEqual({ halted: true, halt_epoch: 1 });
  });

  it('L3: another account\'s owner gets 404 on both routes for this repo, and creates no marker; a repo id that is not a uuid is 404 too', async () => {
    const f = await fixture();
    for (const [method, url] of both(f.repoId)) {
      const res = await call(f.other, method, url);
      expect(res.status, url).toBe(404);
    }
    for (const [method, url] of both('not-a-uuid')) expect((await call(f.owner, method, url)).status, url).toBe(404);
    for (const [method, url] of both(randomUUID())) expect((await call(f.owner, method, url)).status, url).toBe(404);
    expect(await marker(f.repoId)).toBeUndefined();
    expect(await audits(f.owner.accountId)).toEqual([]);
    expect(await audits(f.other.accountId)).toEqual([]);
  });

  it('a body with a field is refused (422) and changes nothing', async () => {
    const f = await fixture();
    const res = await call(f.owner, 'POST', `/engine/repos/${f.repoId}/halt`, { halt_epoch: 9 });
    expect(res.status).toBe(422);
    expect(await marker(f.repoId)).toBeUndefined();
  });

  it('a halted repo refuses a decide-shaped insert at the database, and a clear lifts it (the route and the 1031 trigger agree)', async () => {
    const f = await fixture();
    const probe = 'eh_route_probe';
    await admin.query(`CREATE TABLE IF NOT EXISTS ${probe} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, repo_id uuid NOT NULL)`);
    await admin.query(`DROP TRIGGER IF EXISTS ${probe}_halt ON ${probe}`);
    await admin.query(`CREATE TRIGGER ${probe}_halt BEFORE INSERT ON ${probe} FOR EACH ROW EXECUTE FUNCTION engine_decisions_refuse_halted()`);
    try {
      const insert = () => admin.query(`INSERT INTO ${probe} (account_id, repo_id) VALUES ($1, $2)`, [f.owner.accountId, f.repoId]);
      await expect(insert()).resolves.toBeDefined();
      await call(f.owner, 'POST', `/engine/repos/${f.repoId}/halt`);
      await expect(insert()).rejects.toMatchObject({ code: 'HX409', message: 'engine_halted' });
      await call(f.owner, 'POST', `/engine/repos/${f.repoId}/halt/clear`);
      await expect(insert()).resolves.toBeDefined();
    } finally {
      await admin.query(`DROP TABLE IF EXISTS ${probe}`);
    }
  });
});
