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
interface Change {
  version: number;
  frequency: string;
  label: string;
  previous_frequency: string;
  previous_label: string;
  changed_by: string;
  changed_at: string;
}
interface Discovery {
  repo_id: string;
  can_change: boolean;
  frequency: string;
  label: string;
  source: 'default' | 'set';
  version: number | null;
  options: { value: string; label: string }[];
  changes: Change[];
}
interface ErrorBody {
  error: { code: string };
  details?: { path: string; code: string }[];
}

/**
 * D#483 S5-g1: the discovery frequency routes, called through the real `handleApiRequest` against real Postgres (RLS, the owner/admin
 * INSERT policy, the next-version trigger, the audit function). Nothing here stubs a database answer.
 */
describe('D#483 S5-g1: discovery frequency routes', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  const sql: string[] = [];

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = 's'.repeat(32);
    // Record every statement the app_user connections issue, so the append-only claim is checked against what actually ran.
    const connect = appUserPool.connect.bind(appUserPool) as (...args: unknown[]) => Promise<PoolClient>;
    (appUserPool as unknown as { connect: (...args: unknown[]) => unknown }).connect = async (...args: unknown[]) => {
      if (args.length > 0) return connect(...args);
      const client = await connect();
      // A pooled client comes back on every checkout: wrap it once, or each statement is recorded once per earlier checkout.
      if ((client as unknown as { __recorded?: boolean }).__recorded) return client;
      (client as unknown as { __recorded?: boolean }).__recorded = true;
      const query = client.query.bind(client) as (...args: unknown[]) => unknown;
      (client as unknown as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
        const first = args[0];
        sql.push(typeof first === 'string' ? first : String((first as { text?: string }).text ?? ''));
        return query(...args);
      };
      return client;
    };
  });

  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    admin.release();
    await adminPool.end();
    await platformOpsPool.end();
    await appUserPool.end();
  });

  async function call(identity: Identity, method: string, urlPath: string, body?: unknown, bearer?: string): Promise<Response> {
    const headers = new Headers();
    if (bearer) headers.set('authorization', `Bearer ${bearer}`);
    else headers.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(identity)}`);
    if (body !== undefined) headers.set('content-type', 'application/json');
    const req = new Request(`http://localhost/api/v1${urlPath}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return handleApiRequest(req, appUserPool, platformOpsPool, ROUTES);
  }

  async function addMember(accountId: string, role: 'admin' | 'member'): Promise<Identity> {
    const userId = randomUUID();
    await seedUser(admin, userId);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [accountId, userId, role]);
    return { accountId, userId };
  }

  async function seedRepo(accountId: string): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO repos (account_id, installation_id, gh_repo_id, product) VALUES ($1, NULL, $2, 'web') RETURNING id`,
      [accountId, Math.floor(Math.random() * 1e9)],
    );
    return rows[0]!.id;
  }

  async function fixture(): Promise<{ owner: Identity; admin: Identity; member: Identity; repoId: string; otherRepoId: string }> {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    return {
      owner,
      admin: await addMember(owner.accountId, 'admin'),
      member: await addMember(owner.accountId, 'member'),
      repoId: await seedRepo(owner.accountId),
      otherRepoId: await seedRepo(owner.accountId),
    };
  }

  const get = async (who: Identity, repoId: string, bearer?: string): Promise<Discovery> => {
    const res = await call(who, 'GET', `/repos/${repoId}/discovery`, undefined, bearer);
    expect(res.status).toBe(200);
    return (await res.json()) as Discovery;
  };
  const put = (who: Identity, repoId: string, body: unknown, bearer?: string): Promise<Response> => call(who, 'PUT', `/repos/${repoId}/discovery`, body, bearer);
  const versions = async (accountId: string): Promise<{ repo_id: string; frequency: string; version: number; changed_by: string }[]> =>
    (await admin.query(`SELECT repo_id, frequency, version, changed_by FROM discovery_settings WHERE account_id = $1 ORDER BY repo_id, version`, [accountId])).rows;
  const auditRows = async (accountId: string): Promise<{ actor: string; payload: { repo_id: string; version: number; previous: string; new: string } }[]> =>
    (await admin.query(`SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'discovery_setting.changed' ORDER BY created_at, id`, [accountId])).rows;
  const readToken = async (f: { owner: Identity }): Promise<string> => {
    const plaintext = generateToken();
    await insertApiToken(appUserPool, {
      accountId: f.owner.accountId,
      createdBy: f.owner.userId,
      tokenHash: hashToken(plaintext),
      displayHint: 'fxat_...test',
      scopes: ['read'],
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    return plaintext;
  };

  it('GET with nothing stored: daily by default, three named choices, no raw id in any label', async () => {
    const f = await fixture();
    const d = await get(f.owner, f.repoId);
    expect(d).toMatchObject({ repo_id: f.repoId, can_change: true, frequency: 'daily', label: 'Every day', source: 'default', version: null, changes: [] });
    expect(d.options).toEqual([
      { value: 'daily', label: 'Every day' },
      { value: 'weekly', label: 'Every week' },
      { value: 'off', label: 'Off' },
    ]);
    for (const o of d.options) expect(o.label).not.toMatch(/_|undefined|null/);
    expect(await versions(f.owner.accountId)).toHaveLength(0);
  });

  it('a PUT appends one version and one audit row naming the actor and both values; the GET shows it and the change list', async () => {
    const f = await fixture();
    const res = await put(f.owner, f.repoId, { frequency: 'weekly' });
    expect(res.status).toBe(200);
    const d = (await res.json()) as Discovery;
    expect(d).toMatchObject({ frequency: 'weekly', label: 'Every week', source: 'set', version: 1 });
    expect(d.changes).toEqual([
      expect.objectContaining({ version: 1, frequency: 'weekly', label: 'Every week', previous_frequency: 'daily', previous_label: 'Every day', changed_by: f.owner.userId }),
    ]);
    expect(Number.isNaN(Date.parse(d.changes[0]!.changed_at))).toBe(false);
    // An admin can change it too, and the other repo of the account is untouched.
    const off = (await (await put(f.admin, f.repoId, { frequency: 'off' })).json()) as Discovery;
    expect(off).toMatchObject({ frequency: 'off', version: 2 });
    expect(off.changes.map((c) => [c.version, c.previous_frequency, c.frequency, c.changed_by])).toEqual([
      [2, 'weekly', 'off', f.admin.userId],
      [1, 'daily', 'weekly', f.owner.userId],
    ]);
    expect((await get(f.owner, f.otherRepoId)).frequency).toBe('daily');
    expect((await versions(f.owner.accountId)).map((r) => [r.version, r.frequency, r.changed_by])).toEqual([
      [1, 'weekly', f.owner.userId],
      [2, 'off', f.admin.userId],
    ]);
    const audit = await auditRows(f.owner.accountId);
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ actor: f.owner.userId, payload: { repo_id: f.repoId, version: 1, previous: 'daily', new: 'weekly' } });
    expect(audit[1]).toMatchObject({ actor: f.admin.userId, payload: { version: 2, previous: 'weekly', new: 'off' } });
  });

  it('choosing the value already in force (the default included) writes nothing and answers 200', async () => {
    const f = await fixture();
    expect((await put(f.owner, f.repoId, { frequency: 'daily' })).status).toBe(200);
    expect(await versions(f.owner.accountId)).toHaveLength(0);
    await put(f.owner, f.repoId, { frequency: 'off' });
    const again = await put(f.owner, f.repoId, { frequency: 'off' });
    expect(again.status).toBe(200);
    expect(((await again.json()) as Discovery).version).toBe(1);
    expect(await versions(f.owner.accountId)).toHaveLength(1);
    expect(await auditRows(f.owner.accountId)).toHaveLength(1);
  });

  it('undo is a new version: choosing daily again lifts "off", and the history keeps both', async () => {
    const f = await fixture();
    await put(f.owner, f.repoId, { frequency: 'off' });
    const back = (await (await put(f.owner, f.repoId, { frequency: 'daily' })).json()) as Discovery;
    expect(back).toMatchObject({ frequency: 'daily', source: 'set', version: 2 });
    expect(back.changes.map((c) => [c.version, c.previous_label, c.label])).toEqual([[2, 'Off', 'Every day'], [1, 'Every day', 'Off']]);
    expect((await auditRows(f.owner.accountId)).at(-1)!.payload).toMatchObject({ previous: 'off', new: 'daily' });
  });

  it('the change list is bounded to the 20 newest, and the oldest listed one still names what it replaced', async () => {
    const f = await fixture();
    for (let i = 0; i < 23; i++) await put(f.owner, f.repoId, { frequency: i % 2 === 0 ? 'off' : 'weekly' });
    const d = await get(f.owner, f.repoId);
    expect(d.version).toBe(23);
    expect(d.changes).toHaveLength(20);
    expect(d.changes[0]!.version).toBe(23);
    const oldest = d.changes.at(-1)!;
    expect(oldest.version).toBe(4);
    expect(oldest.previous_frequency).toBe('off');
    expect(oldest.frequency).toBe('weekly');
    expect(await versions(f.owner.accountId)).toHaveLength(23);
  });

  it('refuses a bad body with nothing written', async () => {
    const f = await fixture();
    for (const body of [{ frequency: 'hourly' }, { frequency: 'OFF' }, { frequency: null }, {}, { frequency: 'off', extra: 1 }, { frequency: 7 }]) {
      const res = await put(f.owner, f.repoId, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
    expect(await versions(f.owner.accountId)).toHaveLength(0);
    expect(await auditRows(f.owner.accountId)).toHaveLength(0);
  });

  it('a plain member reads but cannot write; a token reads but cannot write; a missing, malformed or other-tenant repo is one 404', async () => {
    const f = await fixture();
    const other = await fixture();
    const plaintext = await readToken(f);
    expect((await get(f.member, f.repoId)).can_change).toBe(false);
    const asMember = await put(f.member, f.repoId, { frequency: 'off' });
    expect(asMember.status).toBe(403);
    expect(((await asMember.json()) as ErrorBody).error.code).toBe('insufficient_role');
    const asToken = await put(f.owner, f.repoId, { frequency: 'off' }, plaintext);
    expect(asToken.status).toBe(403);
    expect(((await asToken.json()) as ErrorBody).error.code).toBe('session_required');
    expect((await get(f.owner, f.repoId, plaintext)).frequency).toBe('daily');
    for (const id of [randomUUID(), 'not-a-uuid', other.repoId]) {
      expect((await call(f.owner, 'GET', `/repos/${id}/discovery`)).status, id).toBe(404);
      expect((await put(f.owner, id, { frequency: 'off' })).status, id).toBe(404);
    }
    expect(await versions(f.owner.accountId)).toHaveLength(0);
    expect(await versions(other.owner.accountId)).toHaveLength(0);
  });

  it('the database refuses a member session even if the route check were bypassed', async () => {
    const f = await fixture();
    const { writeDiscoverySetting } = await import('@fx/db/src/discoverySettings.js');
    await expect(
      writeDiscoverySetting({ pool: appUserPool, principal: f.member.userId }, { accountId: f.member.accountId, repoId: f.repoId, frequency: 'off' }),
    ).rejects.toMatchObject({ code: '42501' });
    expect(await versions(f.owner.accountId)).toHaveLength(0);
  });

  it('two writers racing for one version: the loser gets 409 discovery_changed, not 500', async () => {
    const f = await fixture();
    let raced = false;
    const connect = appUserPool.connect.bind(appUserPool) as (...args: unknown[]) => Promise<PoolClient>;
    const original = (appUserPool as unknown as { connect: unknown }).connect;
    (appUserPool as unknown as { connect: (...args: unknown[]) => unknown }).connect = async (...args: unknown[]) => {
      if (args.length > 0) return connect(...args);
      const client = await connect();
      const query = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
      (client as unknown as { query: (...a: unknown[]) => unknown }).query = async (...a: unknown[]) => {
        const first = a[0];
        const text = typeof first === 'string' ? first : String((first as { text?: string }).text ?? '');
        if (!raced && /^\s*INSERT INTO discovery_settings/.test(text)) {
          raced = true;
          await admin.query(`INSERT INTO discovery_settings (account_id, repo_id, frequency, version, changed_by) VALUES ($1, $2, 'weekly', 1, $3)`, [f.owner.accountId, f.repoId, f.owner.userId]);
        }
        return query(...a);
      };
      return client;
    };
    try {
      const res = await put(f.owner, f.repoId, { frequency: 'off' });
      expect(raced).toBe(true);
      expect(res.status).toBe(409);
      expect(((await res.json()) as ErrorBody).error.code).toBe('discovery_changed');
    } finally {
      (appUserPool as unknown as { connect: unknown }).connect = original;
    }
    expect((await get(f.owner, f.repoId)).frequency).toBe('weekly');
    expect(await auditRows(f.owner.accountId)).toHaveLength(0);
  });

  it('never issues an UPDATE or DELETE against discovery_settings: every write the routes made is an INSERT', async () => {
    const f = await fixture();
    sql.length = 0;
    await put(f.owner, f.repoId, { frequency: 'weekly' });
    await put(f.owner, f.repoId, { frequency: 'off' });
    await get(f.owner, f.repoId);
    expect(sql.filter((q) => /INSERT\s+INTO\s+discovery_settings/i.test(q)).length).toBe(2);
    expect(sql.filter((q) => /\b(UPDATE|DELETE\s+FROM|TRUNCATE)\b[^;]*discovery_settings/i.test(q))).toEqual([]);
    expect(sql.filter((q) => /discovery_settings/i.test(q) && /FOR\s+(UPDATE|SHARE)/i.test(q))).toEqual([]);
  });
});
