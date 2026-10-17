import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { withTenant } from '@fx/db/src/withTenant.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { setupHoldFor, syncDerivedSetupRequest } from '@fx/core/src/setup-requests/store.js';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { seedAccountWithMember, seedUser } from './helpers/seed.js';

interface Identity {
  accountId: string;
  userId: string;
}
interface Dto {
  id: string;
  repo_id: string;
  work_item_id: string | null;
  kind: string;
  title: string;
  target: string;
  env_name: string | null;
  reason: string;
  provider_url: string | null;
  check: string | null;
  state: string;
  origin: string;
  created_by: string | null;
  resolution: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
}
interface ErrorBody {
  error: { code: string; message: string };
  details?: { path: string; code: string }[];
}

/**
 * D#598 P8a: the setup request routes, called through the real `handleApiRequest` against real Postgres (RLS, the owner/admin policies, the
 * state-machine guard, the CHECK constraints). Nothing here stubs a database answer.
 */
describe('D#598 P8a: setup requests', () => {
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
    const connect = appUserPool.connect.bind(appUserPool) as (...args: unknown[]) => Promise<PoolClient>;
    (appUserPool as unknown as { connect: (...args: unknown[]) => unknown }).connect = async (...args: unknown[]) => {
      if (args.length > 0) return connect(...args);
      const client = await connect();
      if ((client as unknown as { __recorded?: boolean }).__recorded) return client;
      (client as unknown as { __recorded?: boolean }).__recorded = true;
      const query = client.query.bind(client) as (...a: unknown[]) => unknown;
      (client as unknown as { query: (...a: unknown[]) => unknown }).query = (...a: unknown[]) => {
        const first = a[0];
        sql.push(typeof first === 'string' ? first : String((first as { text?: string }).text ?? ''));
        return query(...a);
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
  async function seedItem(accountId: string, repoId: string): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, $3, 'feature', 'internal')`, [id, accountId, repoId]);
    return id;
  }
  async function fixture() {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const repoId = await seedRepo(owner.accountId);
    return { owner, admin: await addMember(owner.accountId, 'admin'), member: await addMember(owner.accountId, 'member'), repoId, itemId: await seedItem(owner.accountId, repoId) };
  }
  const envBody = (f: { repoId: string; itemId: string }, over: Record<string, unknown> = {}) => ({
    kind: 'env_var',
    repo_id: f.repoId,
    work_item_id: f.itemId,
    target: 'cloud-staging',
    env_name: 'STRIPE_WEBHOOK_SECRET',
    reason: 'The webhook route needs this name set.',
    provider_url: 'https://vercel.com/docs/environment-variables',
    check: 'env_var_present',
    ...over,
  });
  const create = async (who: Identity, body: unknown, bearer?: string): Promise<Response> => call(who, 'POST', '/setup-requests', body, bearer);
  const created = async (who: Identity, body: unknown): Promise<Dto> => {
    const res = await create(who, body);
    expect(res.status).toBe(200);
    return (await res.json()) as Dto;
  };
  const rows = async (accountId: string): Promise<Record<string, unknown>[]> => (await admin.query(`SELECT * FROM setup_requests WHERE account_id = $1 ORDER BY created_at, id`, [accountId])).rows;
  const code = async (res: Response): Promise<string> => ((await res.json()) as ErrorBody).error.code;
  const readToken = async (who: Identity, scopes: string[]): Promise<string> => {
    const plaintext = generateToken();
    await insertApiToken(appUserPool, {
      accountId: who.accountId,
      createdBy: who.userId,
      tokenHash: hashToken(plaintext),
      displayHint: 'fxat_...test',
      scopes: scopes as never,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    return plaintext;
  };

  it('AC21: an admin proposes a request; the person, the account and the title come from the session and fixed templates', async () => {
    const f = await fixture();
    const dto = await created(f.admin, envBody(f));
    expect(dto).toMatchObject({
      kind: 'env_var',
      state: 'open',
      origin: 'agent',
      created_by: f.admin.userId,
      title: 'Add the environment variable STRIPE_WEBHOOK_SECRET to cloud-staging',
      env_name: 'STRIPE_WEBHOOK_SECRET',
      provider_url: 'https://vercel.com/docs/environment-variables',
      check: 'env_var_present',
      resolution: null,
    });
    const stored = await rows(f.owner.accountId);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ account_id: f.owner.accountId, created_by: f.admin.userId, state: 'open' });
    // The four other kinds take the Spec's own sentences.
    const titles: [string, string, string][] = [
      ['app_not_installed', 'acme/web', 'App not installed on acme/web'],
      ['branch_pushed_by_person', 'fx/item-1', 'Someone pushed to fx/item-1'],
      ['overlay_path_missing', '.autonomous-team/roadmap.json', 'Add .autonomous-team/roadmap.json to the overlay paths'],
      ['parent_pr_closed', '#12', 'Parent PR closed'],
    ];
    for (const [kind, target, title] of titles) {
      expect((await created(f.owner, { kind, repo_id: f.repoId, target, reason: 'x' })).title, kind).toBe(title);
    }
  });

  it('AC21: a kind outside the list, a derived-only kind, or any value field is refused with nothing written', async () => {
    const f = await fixture();
    const bad: Record<string, unknown>[] = [
      envBody(f, { kind: 'deploy_key' }),
      envBody(f, { kind: 'parity_drift' }),
      envBody(f, { kind: 'secret' }),
      envBody(f, { value: 'sk_live_abc' }),
      envBody(f, { secret: 'hunter2' }),
      envBody(f, { token: 'x' }),
      envBody(f, { account_id: randomUUID() }),
      envBody(f, { created_by: randomUUID() }),
      envBody(f, { origin: 'derived' }),
      envBody(f, { state: 'done' }),
      envBody(f, { env_name: 'NOT A NAME' }),
      envBody(f, { env_name: null }),
      { kind: 'app_not_installed', repo_id: f.repoId, target: 'a/b', reason: 'x', env_name: 'FOO' },
      { kind: 'app_not_installed', repo_id: f.repoId, target: 'a/b', reason: 'x', check: 'env_var_present' },
      envBody(f, { check: 'anything_else' }),
      envBody(f, { target: '' }),
      envBody(f, { target: 'multi\nline' }),
      envBody(f, { reason: '' }),
      envBody(f, { reason: 'x'.repeat(1001) }),
      envBody(f, { reason: 'bell\u0007' }),
    ];
    for (const body of bad) {
      const res = await create(f.admin, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
    // A pasted credential is refused, in the reason and in the target, and is not stored redacted either.
    const key = 'sk-ant-api03-' + 'A'.repeat(40);
    for (const body of [envBody(f, { reason: `use ${key}` }), envBody(f, { target: key })]) {
      const res = await create(f.admin, body);
      expect(res.status).toBe(422);
      expect(((await res.json()) as ErrorBody).details?.[0]?.path).toMatch(/reason|target/);
    }
    expect(await rows(f.owner.accountId)).toHaveLength(0);
  });

  it('AC22: reason is stored and returned as literal plain text; markup and a URL in it are not links, title is not built from it', async () => {
    const f = await fixture();
    const reason = '<img src=x onerror=alert(1)> see https://evil.example/login and [click](https://evil.example)\nline two';
    const dto = await created(f.admin, envBody(f, { reason, provider_url: null }));
    expect(dto.reason).toBe(reason);
    expect(dto.provider_url).toBeNull();
    expect(dto.title).not.toContain('evil');
    expect((await rows(f.owner.accountId))[0]!.reason).toBe(reason);
  });

  it('AC22: the only link is a provider page on github.com or vercel.com; anything else is refused by the API and by the database', async () => {
    const f = await fixture();
    for (const url of ['https://github.com/apps/acme/installations/new', 'https://vercel.com/acme/web/settings/environment-variables']) {
      const dto = await created(f.admin, envBody(f, { provider_url: url, target: url.slice(-8) + randomUUID() }));
      expect(dto.provider_url).toBe(url);
    }
    const refused = [
      'http://github.com/x',
      'https://github.com.evil.com/x',
      'https://evil.com/github.com',
      'https://github.com@evil.com/x',
      'https://user:pw@github.com/x',
      'https://github.com:8443/x',
      'https://gist.github.com/x',
      'https://www.vercel.com/x',
      'javascript:alert(1)',
      'data:text/html,hi',
      '//github.com/x',
      'https://github.com/x y',
      'https://github.com\\@evil.com/',
      'github.com',
      'https://github.com/' + 'a'.repeat(500),
    ];
    for (const url of refused) {
      const res = await create(f.admin, envBody(f, { provider_url: url, target: randomUUID() }));
      expect(res.status, url).toBe(422);
    }
    // Even a writer that skips the API cannot store one.
    for (const url of ['https://evil.com/x', 'http://github.com/x', 'https://github.com.evil.com/']) {
      await expect(
        admin.query(
          `INSERT INTO setup_requests (account_id, repo_id, origin, kind, target, reason, provider_url, created_by)
           VALUES ($1, $2, 'agent', 'app_not_installed', $3, 'x', $4, $5)`,
          [f.owner.accountId, f.repoId, randomUUID(), url, f.admin.userId],
        ),
        url,
      ).rejects.toMatchObject({ code: '23514' });
    }
    expect(await rows(f.owner.accountId)).toHaveLength(2);
  });

  it('the database has no value column and a closed kind list, whatever writes to it', async () => {
    const { rows: cols } = await admin.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'setup_requests'`);
    expect(cols.map((c) => c.column_name).filter((c) => /value|secret|token|password|credential/i.test(c))).toEqual([]);
    const f = await fixture();
    await expect(
      admin.query(`INSERT INTO setup_requests (account_id, repo_id, origin, kind, target, reason, created_by) VALUES ($1, $2, 'agent', 'api_key', 'x', 'x', $3)`, [f.owner.accountId, f.repoId, f.admin.userId]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('the same open step cannot be requested twice (409), and can be again once withdrawn', async () => {
    const f = await fixture();
    const first = await created(f.admin, envBody(f));
    const again = await create(f.admin, envBody(f));
    expect(again.status).toBe(409);
    expect(await code(again)).toBe('setup_request_exists');
    expect((await call(f.admin, 'POST', `/setup-requests/${first.id}/withdraw`)).status).toBe(200);
    expect((await create(f.admin, envBody(f))).status).toBe(200);
    expect(await rows(f.owner.accountId)).toHaveLength(2);
  });

  it('a named work item must belong to the named repo (422), and a foreign repo or item is a 404', async () => {
    const f = await fixture();
    const other = await fixture();
    const otherRepoInAccount = await seedRepo(f.owner.accountId);
    const mismatch = await create(f.admin, envBody(f, { repo_id: otherRepoInAccount }));
    expect(mismatch.status).toBe(422);
    expect((await create(f.admin, envBody(f, { repo_id: other.repoId }))).status).toBe(404);
    expect((await create(f.admin, envBody(f, { work_item_id: other.itemId }))).status).toBe(404);
    expect((await create(f.admin, envBody(f, { work_item_id: randomUUID() }))).status).toBe(404);
    expect(await rows(f.owner.accountId)).toHaveLength(0);
    expect(await rows(other.owner.accountId)).toHaveLength(0);
  });

  it('roles: a member reads but cannot propose, mark done or withdraw; an owner and an admin can', async () => {
    const f = await fixture();
    const dto = await created(f.owner, envBody(f));
    const asMember = await create(f.member, envBody(f, { target: 'other' }));
    expect(asMember.status).toBe(403);
    expect(await code(asMember)).toBe('insufficient_role');
    for (const verb of ['done', 'withdraw']) {
      const res = await call(f.member, 'POST', `/setup-requests/${dto.id}/${verb}`);
      expect(res.status, verb).toBe(403);
      expect(await code(res)).toBe('insufficient_role');
    }
    expect((await call(f.member, 'GET', '/setup-requests')).status).toBe(200);
    expect((await call(f.member, 'GET', `/setup-requests/${dto.id}`)).status).toBe(200);
    expect((await call(f.admin, 'POST', `/setup-requests/${dto.id}/done`)).status).toBe(200);
    expect((await rows(f.owner.accountId)).map((r) => r.state)).toEqual(['done']);
  });

  it('tokens: no token, whatever its scopes, reaches any setup request route', async () => {
    const f = await fixture();
    const dto = await created(f.owner, envBody(f));
    for (const scopes of [['read'], ['read', 'audit:read', 'runs:cancel', 'work_items:write', 'discussions:write', 'corrections:write']]) {
      const bearer = await readToken(f.owner, scopes);
      const attempts: [string, string, unknown?][] = [
        ['GET', '/setup-requests'],
        ['GET', `/setup-requests/${dto.id}`],
        ['POST', '/setup-requests', envBody(f, { target: 'by-token' })],
        ['POST', `/setup-requests/${dto.id}/done`],
        ['POST', `/setup-requests/${dto.id}/withdraw`],
      ];
      for (const [method, path, body] of attempts) {
        const res = await call(f.owner, method, path, body, bearer);
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(await code(res)).toBe('session_required');
      }
    }
    expect((await rows(f.owner.accountId)).map((r) => r.state)).toEqual(['open']);
  });

  it('tenancy: another account sees none of it, and cannot decide on it (404); a body cannot name an account', async () => {
    const a = await fixture();
    const b = await fixture();
    const dto = await created(a.owner, envBody(a));
    expect(((await (await call(b.owner, 'GET', '/setup-requests?state=all')).json()) as { requests: Dto[] }).requests).toEqual([]);
    for (const [method, path] of [['GET', `/setup-requests/${dto.id}`], ['POST', `/setup-requests/${dto.id}/done`], ['POST', `/setup-requests/${dto.id}/withdraw`]] as const) {
      expect((await call(b.owner, method, path)).status, path).toBe(404);
    }
    expect((await call(b.owner, 'GET', '/setup-requests/not-a-uuid')).status).toBe(404);
    expect((await rows(a.owner.accountId)).map((r) => r.state)).toEqual(['open']);
    const spoof = await create(b.owner, envBody(b, { account_id: a.owner.accountId }));
    expect(spoof.status).toBe(422);
    expect(await rows(b.owner.accountId)).toHaveLength(0);
  });

  it('list: open by default, ?state=all adds closed ones, filters by item and repo, newest first', async () => {
    const f = await fixture();
    const second = await seedItem(f.owner.accountId, f.repoId);
    const one = await created(f.owner, envBody(f, { target: 'one' }));
    const two = await created(f.owner, envBody(f, { target: 'two', work_item_id: second }));
    await call(f.owner, 'POST', `/setup-requests/${one.id}/withdraw`);
    const list = async (q: string) => ((await (await call(f.member, 'GET', `/setup-requests${q}`)).json()) as { requests: Dto[]; truncated: boolean });
    expect((await list('')).requests.map((r) => r.id)).toEqual([two.id]);
    expect((await list('?state=all')).requests.map((r) => r.id)).toEqual([two.id, one.id]);
    expect((await list(`?state=all&work_item_id=${f.itemId}`)).requests.map((r) => r.id)).toEqual([one.id]);
    expect((await list(`?repo_id=${f.repoId}`)).truncated).toBe(false);
    expect((await call(f.member, 'GET', '/setup-requests?state=bogus')).status).toBe(422);
    expect((await call(f.member, 'GET', '/setup-requests?work_item_id=nope')).status).toBe(422);
  });

  it('AC (undo): mark done resumes at once; withdraw keeps the item paused; repeats answer 200, the opposite on a closed request is 409', async () => {
    const f = await fixture();
    const hold = () => withTenant(appUserPool, f.owner.accountId, f.owner.userId, (c) => setupHoldFor(c, f.itemId));
    expect(await hold()).toBeNull();
    const a = await created(f.admin, envBody(f, { target: 'a' }));
    expect(await hold()).toBe('setup_request_open');
    const done = await call(f.admin, 'POST', `/setup-requests/${a.id}/done`);
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ state: 'done', resolution: 'marked_done', resolved_by: f.admin.userId });
    expect(await hold()).toBeNull();
    const repeat = await call(f.owner, 'POST', `/setup-requests/${a.id}/done`);
    expect(repeat.status).toBe(200);
    expect(((await repeat.json()) as Dto).resolved_by).toBe(f.admin.userId);
    const wrongWay = await call(f.admin, 'POST', `/setup-requests/${a.id}/withdraw`);
    expect(wrongWay.status).toBe(409);
    expect(await code(wrongWay)).toBe('setup_request_closed');

    const b = await created(f.admin, envBody(f, { target: 'b' }));
    const wd = await call(f.admin, 'POST', `/setup-requests/${b.id}/withdraw`);
    expect(await wd.json()).toMatchObject({ state: 'withdrawn', resolution: 'withdrawn', resolved_by: f.admin.userId });
    expect(await hold()).toBe('setup_request_withdrawn');
    expect((await call(f.admin, 'POST', `/setup-requests/${b.id}/withdraw`)).status).toBe(200);
    expect(await code(await call(f.admin, 'POST', `/setup-requests/${b.id}/done`))).toBe('setup_request_closed');
    // A person's next advance of the item after the withdrawal lifts the hold.
    await admin.query(
      `INSERT INTO run_action_requests (account_id, kind, target_id, requested_by, principal_kind, idempotency_key, request_hash)
       VALUES ($1, 'advance_work_item', $2, $3, 'session', $4, $5)`,
      [f.owner.accountId, f.itemId, f.admin.userId, randomUUID(), 'h'.repeat(8)],
    );
    expect(await hold()).toBeNull();
    // An advance requested BEFORE the withdrawal does not.
    const c = await created(f.admin, envBody(f, { target: 'c' }));
    await call(f.admin, 'POST', `/setup-requests/${c.id}/withdraw`);
    expect(await hold()).toBe('setup_request_withdrawn');
  });

  it('a request without an item pauses nothing; another item of the repo is not held', async () => {
    const f = await fixture();
    const other = await seedItem(f.owner.accountId, f.repoId);
    await created(f.admin, { kind: 'app_not_installed', repo_id: f.repoId, target: 'a/b', reason: 'x' });
    await created(f.admin, envBody(f));
    const hold = (id: string) => withTenant(appUserPool, f.owner.accountId, f.owner.userId, (c) => setupHoldFor(c, id));
    expect(await hold(f.itemId)).toBe('setup_request_open');
    expect(await hold(other)).toBeNull();
  });

  describe('the database, called as app_user without the routes', () => {
    const insertSql = `INSERT INTO setup_requests (account_id, repo_id, origin, kind, target, reason, created_by) VALUES ($1, $2, 'agent', 'app_not_installed', $3, 'x', $4)`;

    it('a member cannot insert, mark done or withdraw; an admin cannot stamp another person; a foreign account is invisible', async () => {
      const f = await fixture();
      const other = await fixture();
      await expect(withTenant(appUserPool, f.owner.accountId, f.member.userId, (c) => c.query(insertSql, [f.owner.accountId, f.repoId, 'm', f.member.userId]))).rejects.toMatchObject({ code: '42501' });
      await expect(withTenant(appUserPool, f.owner.accountId, f.admin.userId, (c) => c.query(insertSql, [f.owner.accountId, f.repoId, 'x', f.owner.userId]))).rejects.toMatchObject({ code: '42501' });
      await expect(withTenant(appUserPool, f.owner.accountId, f.admin.userId, (c) => c.query(insertSql, [other.owner.accountId, other.repoId, 'y', f.admin.userId]))).rejects.toMatchObject({ code: '42501' });
      const dto = await created(f.admin, envBody(f));
      const resolve = (user: Identity, by: string | null) =>
        withTenant(appUserPool, f.owner.accountId, user.userId, (c) =>
          c.query(`UPDATE setup_requests SET state = 'done', resolution = 'marked_done', resolved_by = $2 WHERE id = $1`, [dto.id, by]),
        );
      await expect(resolve(f.member, f.member.userId)).rejects.toMatchObject({ code: '42501' });
      // Another admin's name on the resolution is refused too: resolved_by must be the session's own user.
      await expect(resolve(f.admin, f.owner.userId)).rejects.toMatchObject({ code: '42501' });
      expect((await rows(f.owner.accountId)).map((r) => r.state)).toEqual(['open']);
      const seen = await withTenant(appUserPool, other.owner.accountId, other.owner.userId, (c) => c.query(`SELECT 1 FROM setup_requests`));
      expect(seen.rowCount).toBe(0);
      const crossUpdate = await withTenant(appUserPool, other.owner.accountId, other.owner.userId, (c) => c.query(`UPDATE setup_requests SET state = 'withdrawn' WHERE id = $1`, [dto.id]));
      expect(crossUpdate.rowCount).toBe(0);
    });

    it('stamped terms are frozen for every role, withdrawn is final, a bad transition is refused, nothing can be deleted', async () => {
      const f = await fixture();
      const dto = await created(f.admin, envBody(f));
      const as = (sqlText: string, params: unknown[]) => withTenant(appUserPool, f.owner.accountId, f.admin.userId, (c) => c.query(sqlText, params));
      await expect(as(`UPDATE setup_requests SET kind = 'app_not_installed' WHERE id = $1`, [dto.id])).rejects.toMatchObject({ code: '42501' }); // no column grant
      await expect(admin.query(`UPDATE setup_requests SET kind = 'app_not_installed', env_name = NULL WHERE id = $1`, [dto.id])).rejects.toMatchObject({ code: '23514' });
      await expect(admin.query(`UPDATE setup_requests SET reason = 'rewritten' WHERE id = $1`, [dto.id])).rejects.toMatchObject({ code: '23514' });
      await expect(admin.query(`UPDATE setup_requests SET provider_url = 'https://github.com/x' WHERE id = $1`, [dto.id])).rejects.toMatchObject({ code: '23514' });
      await expect(admin.query(`UPDATE setup_requests SET created_by = $2 WHERE id = $1`, [dto.id, f.owner.userId])).rejects.toMatchObject({ code: '23514' });
      await expect(as(`DELETE FROM setup_requests WHERE id = $1`, [dto.id])).rejects.toMatchObject({ code: '42501' });
      await expect(admin.query(`UPDATE setup_requests SET state = 'open' WHERE id = $1`, [dto.id])).resolves.toBeDefined(); // a no-op, not a transition
      // done -> open needs a check on the request AND a reason from it; this one has a check.
      await call(f.admin, 'POST', `/setup-requests/${dto.id}/done`);
      await expect(admin.query(`UPDATE setup_requests SET state = 'open', resolution = NULL, resolved_by = NULL, resolved_at = NULL WHERE id = $1`, [dto.id])).rejects.toMatchObject({ code: '23514' });
      await as(
        `UPDATE setup_requests SET state = 'open', resolution = NULL, resolved_by = NULL, resolved_at = NULL, check_reason = 'STRIPE_WEBHOOK_SECRET is not set on cloud-staging', check_ran_at = now() WHERE id = $1`,
        [dto.id],
      );
      const back = (await call(f.member, 'GET', `/setup-requests/${dto.id}`).then((r) => r.json())) as Dto & { check_reason: string };
      expect(back).toMatchObject({ state: 'open', resolution: null, check_reason: 'STRIPE_WEBHOOK_SECRET is not set on cloud-staging' });
      await call(f.admin, 'POST', `/setup-requests/${dto.id}/withdraw`);
      await expect(admin.query(`UPDATE setup_requests SET check_reason = 'late' WHERE id = $1`, [dto.id])).rejects.toMatchObject({ code: '23514' });
      await expect(admin.query(`UPDATE setup_requests SET state = 'open', resolution = NULL, resolved_by = NULL, resolved_at = NULL WHERE id = $1`, [dto.id])).rejects.toMatchObject({ code: '23514' });
      // A request with no check never comes back from done.
      const plain = await created(f.admin, { kind: 'app_not_installed', repo_id: f.repoId, target: 'a/b', reason: 'x' });
      await call(f.admin, 'POST', `/setup-requests/${plain.id}/done`);
      await expect(admin.query(`UPDATE setup_requests SET state = 'open', resolution = NULL, resolved_by = NULL, resolved_at = NULL, check_reason = 'r' WHERE id = $1`, [plain.id])).rejects.toMatchObject({ code: '23514' });
    });

    it('a derived request is raised, refreshed and cleared from current state, with no person, and never duplicated', async () => {
      const f = await fixture();
      const run = <T>(user: Identity, fn: (c: PoolClient) => Promise<T>) => withTenant(appUserPool, f.owner.accountId, user.userId, fn);
      const sync = (user: Identity, current: { target: string; reason: string } | null) => run(user, (c) => syncDerivedSetupRequest(c, { repoId: f.repoId, kind: 'parity_drift', current }));
      expect(await sync(f.member, null)).toBeNull();
      const raised = await sync(f.member, { target: 'a.ts, b.ts', reason: 'These paths differ between the private and public code.' });
      expect(raised).toMatchObject({ origin: 'derived', kind: 'parity_drift', state: 'open', createdBy: null, workItemId: null });
      const same = await sync(f.member, { target: 'a.ts, b.ts', reason: 'These paths differ between the private and public code.' });
      expect(same!.id).toBe(raised!.id);
      const refreshed = await sync(f.member, { target: 'a.ts, b.ts, c.ts', reason: 'These paths differ between the private and public code.' });
      expect(refreshed).toMatchObject({ id: raised!.id, target: 'a.ts, b.ts, c.ts' });
      const cleared = await sync(f.member, null);
      expect(cleared).toMatchObject({ id: raised!.id, state: 'done', resolution: 'condition_cleared', resolvedBy: null });
      expect(await sync(f.member, null)).toBeNull();
      // Drift again later is a new request; the cleared one is history and cannot be refreshed.
      const again = await sync(f.member, { target: 'd.ts', reason: 'These paths differ between the private and public code.' });
      expect(again!.id).not.toBe(raised!.id);
      await expect(admin.query(`UPDATE setup_requests SET target = 'z' WHERE id = $1`, [raised!.id])).rejects.toMatchObject({ code: '23514' });
      expect(await rows(f.owner.accountId)).toHaveLength(2);
      // The API lists it with its fixed title, and a person can withdraw it.
      const list = (await (await call(f.member, 'GET', '/setup-requests')).json()) as { requests: Dto[] };
      expect(list.requests).toHaveLength(1);
      expect(list.requests[0]).toMatchObject({ title: 'Public and private code differ: d.ts', origin: 'derived', created_by: null });
      expect((await call(f.admin, 'POST', `/setup-requests/${again!.id}/withdraw`)).status).toBe(200);
    });
  });

  it('every write the routes made is an INSERT or an UPDATE of setup_requests; none deletes', async () => {
    const f = await fixture();
    sql.length = 0;
    const dto = await created(f.admin, envBody(f));
    await call(f.admin, 'POST', `/setup-requests/${dto.id}/done`);
    await call(f.member, 'GET', '/setup-requests?state=all');
    expect(sql.filter((q) => /\bDELETE\b[^;]*setup_requests|TRUNCATE[^;]*setup_requests/i.test(q))).toEqual([]);
    expect(sql.filter((q) => /INSERT\s+INTO\s+setup_requests/i.test(q))).toHaveLength(1);
    expect(sql.filter((q) => /\bUPDATE\s+setup_requests/i.test(q))).toHaveLength(1);
  });
});
