import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool } from '@fx/db/src/pool.js';
import { pagedListing, strictGithubFetch } from './helpers/strictGithub.js';
import { captureReports } from './helpers/captureReports.js';
import {
  InstallationTokenCache,
  createCustomerRepo,
  descriptionHash,
  mintCreateRepoState,
  type CreateRepoDeps,
  type CreateRepoOutcome,
} from '../src/index.js';

// Flip the second-to-last character (all six bits significant in base64url, unlike the
// last one) to a different one, so the result is guaranteed to differ from the input.
const tamper = (s: string): string => {
  const out = `${s.slice(0, -2)}${s.at(-2) === 'A' ? 'B' : 'A'}${s.slice(-1)}`;
  expect(out).not.toBe(s);
  return out;
};

/**
 * D#2 RC-1a against real Postgres. GitHub is a recorded fake: every request is
 * captured so the tests can assert what was and was never sent.
 */
describe('createCustomerRepo (D#2 RC-1a)', () => {
  let adminPool: Pool;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let admin: PoolClient;
  let pem: string;
  let nextGh = 9_600_000;
  const SECRET = 'state-secret-state-secret-state-secret!!';
  const USER_TOKEN = 'ghu_sentinel_user_token_zz9';
  const ENV = { GITHUB_INSTALL_STATE_SECRET: SECRET, GITHUB_APP_TEAM_CLIENT_ID: 'cid', GITHUB_APP_TEAM_CLIENT_SECRET: 'csecret' };

  beforeAll(async () => {
    adminPool = createPool(process.env.GITHUB_DATABASE_URL!);
    appUserPool = createPool(process.env.GITHUB_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.GITHUB_DATABASE_URL_PLATFORM_OPS!);
    admin = await adminPool.connect();
    pem = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
      .privateKey as unknown as string;
  });
  afterAll(async () => {
    admin.release();
    await appUserPool.end();
    await platformOpsPool.end();
    await adminPool.end();
  });

  async function setup(role = 'owner', withInstall = true) {
    const accountId = randomUUID();
    const userId = randomUUID();
    await admin.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`, [accountId, `cus_${accountId}`]);
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [accountId, userId, role]);
    const inst = { id: randomUUID(), gh: nextGh++ };
    if (withInstall) {
      await admin.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, 'team')`, [inst.id, accountId, inst.gh]);
      await admin.query(`INSERT INTO installation_installers (gh_installation_id, app_kind, installer_gh_user_id) VALUES ($1, 'team', 1)`, [inst.gh]);
    }
    return { accountId, userId, inst };
  }

  interface Opts {
    entries?: unknown[];
    create?: { status: number; body?: unknown; headers?: Record<string, string> };
    listNew?: boolean;
    exchangeToken?: string;
  }
  const NEW_ID = 424242;

  function harness(s: Awaited<ReturnType<typeof setup>>, o: Opts = {}, account = { id: 500, login: 'acme', type: 'User' }) {
    const reqs: Array<{ method: string; url: string; body?: string }> = [];
    const entries = o.entries ?? [{ id: s.inst.gh, app_id: 7, account }];
    const fetchImpl = vi.fn(strictGithubFetch(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      reqs.push({ method, url: u, body: typeof init?.body === 'string' ? init.body : undefined });
      if (u.endsWith('/login/oauth/access_token')) return Response.json({ access_token: o.exchangeToken ?? USER_TOKEN });
      if (u.endsWith('/user')) return Response.json({ id: 500 });
      if (u.includes('/user/installations?')) return pagedListing('installations', entries, u);
      if (method === 'POST' && /\/(user|orgs\/[^/]+)\/repos$/.test(u)) {
        const c = o.create ?? { status: 201, body: { id: NEW_ID } };
        return new Response(JSON.stringify(c.body ?? { id: NEW_ID }), { status: c.status, headers: c.headers });
      }
      if (u.includes('/installation/repositories')) {
        const repositories = o.listNew === false ? [] : [{ id: NEW_ID, name: 'widgets', owner: { login: account.login } }];
        return pagedListing('repositories', repositories, u);
      }
      return new Response('unexpected', { status: 500 });
    })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    const deps: CreateRepoDeps = {
      platformOpsPool,
      appUserPool,
      appCredentials: () => ({ appId: '7', privateKeyPem: pem, webhookSecret: '' }),
      requester: async () => ({ token: 'ghs_install_token', expiresAt: new Date(Date.now() + 3_600_000).toISOString() }),
      cache: new InstallationTokenCache(),
      fetchImpl,
      warn: () => undefined,
      env: ENV,
    };
    return { deps, reqs };
  }

  const stateFor = (s: Awaited<ReturnType<typeof setup>>, over: Record<string, unknown> = {}) =>
    mintCreateRepoState(
      { account_id: s.accountId, user_id: s.userId, owner_gh_id: 500, name: 'widgets', visibility: 'private', description_sha256: descriptionHash(null), auto_init: true, ...over } as never,
      SECRET,
    );
  const run = (h: ReturnType<typeof harness>, s: Awaited<ReturnType<typeof setup>>, state = stateFor(s), extra: Record<string, unknown> = {}) =>
    createCustomerRepo(h.deps, { accountId: s.accountId, userId: s.userId, code: 'one-time-code', state, ...extra });
  const rows = async (table: string, accountId: string, where = '') =>
    (await admin.query(`SELECT * FROM ${table} WHERE account_id = $1 ${where}`, [accountId])).rows;

  it.each<[string, Opts, CreateRepoOutcome]>([
    ['201 and GitHub lists it', { listNew: true }, 'ok'],
    ['201 but the installation does not list it', { listNew: false }, 'created_not_connected'],
    ['422 name exists', { create: { status: 422, body: { message: 'x', errors: [{ message: 'name already exists on this account' }] } } }, 'name_taken'],
    ['422 visibility', { create: { status: 422, body: { message: 'Visibility can not be public' } } }, 'visibility_not_allowed'],
    ['422 anything else', { create: { status: 422, body: { message: 'weird' } } }, 'failed'],
    ['403 no right', { create: { status: 403, body: { message: 'Forbidden' } } }, 'refused'],
    ['404', { create: { status: 404, body: {} } }, 'refused'],
    ['403 secondary rate limit', { create: { status: 403, body: { message: 'You have exceeded a secondary rate limit' } } }, 'github_busy'],
    ['429', { create: { status: 429, body: {} } }, 'github_busy'],
    ['500', { create: { status: 500, body: { message: 'boom' } } }, 'failed'],
  ])('outcome table: %s -> %s, with no add-to-installation PUT and no DELETE in any outcome', async (_n, o, want) => {
    const s = await setup();
    const h = harness(s, o);
    const res = await run(h, s);
    expect(res.outcome).toBe(want);
    expect(h.reqs.filter((r) => r.method === 'PUT' || r.method === 'DELETE' || r.url.includes('/user/installations/'))).toEqual([]);
    expect(JSON.stringify(res)).not.toContain('boom');
    expect(JSON.stringify(res)).not.toContain('secondary');
  });

  it('H1b: a sync step that throws after the repo was created is reported as a coded class and ends created_not_connected', async () => {
    const s = await setup();
    const h = harness(s);
    const reports = captureReports();
    h.deps.requester = async () => {
      throw Object.assign(new Error('mint down for acme/widgets: ghs_FAKE_h1b_sync_token'), { code: 'ECONNRESET' });
    };
    const res = await run(h, s);
    expect(res.outcome).toBe('created_not_connected');
    expect(reports.classes).toEqual([{ service: 'test', route: '/', stage: 'github.create_repo.sync', code: 'other' }]);
    expect(reports.everything()).not.toMatch(/acme|widgets|ghs_FAKE_h1b_sync_token/);
  });

  it('H1b: a refusal whose audit row cannot be written still answers refused, and the write failure is reported by SQLSTATE only', async () => {
    const s = await setup();
    const h = harness(s, { create: { status: 403, body: { message: 'Forbidden' } } });
    const reports = captureReports();
    const failingAudit = {
      connect: async () => {
        const client = await platformOpsPool.connect();
        // A proxy, so the pooled connection itself is never altered for the next test.
        return new Proxy(client, {
          get: (target, prop) => {
            if (prop !== 'query') {
              const v = Reflect.get(target, prop) as unknown;
              return typeof v === 'function' ? v.bind(target) : v;
            }
            return (...a: unknown[]) =>
              typeof a[0] === 'string' && a[0].includes('audit_write_system') && JSON.stringify(a[1]).includes('github.repo_create_refused')
                ? Promise.reject(Object.assign(new Error('audit write failed FAKE-h1b-audit-secret'), { code: '57P01' }))
                : (target.query as (...x: unknown[]) => Promise<unknown>)(...a);
          },
        });
      },
    } as unknown as Pool;
    h.deps.platformOpsPool = failingAudit;
    const res = await run(h, s);
    expect(res.outcome).toBe('refused');
    expect(reports.classes).toEqual([{ service: 'test', route: '/', stage: 'github.create_repo.audit', code: '57P01' }]);
    expect(reports.everything()).not.toContain('FAKE-h1b-audit-secret');
  });

  it('H1b: an attempt that throws answers failed and is reported as a coded class with no text', async () => {
    const s = await setup();
    const h = harness(s);
    const reports = captureReports();
    const underlying = h.deps.fetchImpl as typeof fetch;
    h.deps.fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/login/oauth/access_token')) throw new Error('exchange failed for code one-time-code with csecret FAKE-h1b-client-secret');
      return underlying(url, init);
    }) as typeof fetch;
    const res = await run(h, s);
    expect(res.outcome).toBe('failed');
    expect(reports.classes).toHaveLength(1);
    expect(reports.classes[0]).toMatchObject({ service: 'test', route: '/', stage: 'github.create_repo' });
    expect(reports.everything()).not.toMatch(/one-time-code|FAKE-h1b-client-secret|csecret/);
  });

  it('created_not_connected returns the repo URL and a personal-account deep link built from the recorded installation id', async () => {
    const s = await setup();
    const res = await run(harness(s, { listNew: false }), s);
    expect(res).toEqual({
      outcome: 'created_not_connected',
      repoUrl: 'https://github.com/acme/widgets',
      installationUrl: `https://github.com/settings/installations/${s.inst.gh}`,
    });
    const a = await rows('audit_log', s.accountId, `AND action = 'github.repo_created'`);
    expect(a[0].payload).toMatchObject({ connected: false, gh_repo_id: NEW_ID });
  });

  it('org path posts to /orgs/{login}/repos and links the org settings page; the user path posts to /user/repos', async () => {
    const s = await setup();
    const org = harness(s, { listNew: false }, { id: 500, login: 'acme-org', type: 'Organization' });
    const res = await run(org, s);
    expect(org.reqs.filter((r) => r.method === 'POST' && r.url.includes('/repos')).map((r) => r.url)).toEqual(['https://api.github.com/orgs/acme-org/repos']);
    expect(res.installationUrl).toBe(`https://github.com/organizations/acme-org/settings/installations/${s.inst.gh}`);
    const s2 = await setup();
    const user = harness(s2);
    await run(user, s2);
    expect(user.reqs.filter((r) => r.method === 'POST' && r.url.includes('/repos')).map((r) => r.url)).toEqual(['https://api.github.com/user/repos']);
    expect(JSON.parse(user.reqs.find((r) => r.url.endsWith('/user/repos'))!.body!)).toEqual({ name: 'widgets', private: true, auto_init: true });
  });

  it('criterion 6b: the link uses the recorded installation, not GitHub text; a hostile login stops before any create', async () => {
    const s = await setup();
    const decoy = { id: s.inst.gh + 777, app_id: 7, account: { id: 500, login: 'acme', type: 'User' }, html_url: 'https://evil.example/x' };
    const real = { id: s.inst.gh, app_id: 7, account: { id: 500, login: 'acme', type: 'User' }, html_url: 'https://evil.example/y' };
    const res = await run(harness(s, { entries: [decoy, real], listNew: false }), s);
    expect(res.installationUrl).toBe(`https://github.com/settings/installations/${s.inst.gh}`);
    const hostile = harness(s, { entries: [{ ...real, account: { id: 500, login: 'a/../evil', type: 'Organization' } }] });
    expect((await run(hostile, s, stateFor(s))).outcome).toBe('failed');
    expect(hostile.reqs.some((r) => r.method === 'POST' && r.url.includes('/repos'))).toBe(false);
  });

  it('[pg] success leaves exactly one repos row and one audit row; a replay of the same state creates nothing', async () => {
    const s = await setup();
    const h = harness(s);
    const state = stateFor(s);
    expect((await run(h, s, state)).outcome).toBe('ok');
    expect((await run(h, s, state)).outcome).toBe('failed');
    expect(h.reqs.filter((r) => r.method === 'POST' && r.url.endsWith('/user/repos'))).toHaveLength(1);
    expect(await rows('repos', s.accountId, `AND gh_repo_id = ${NEW_ID}`)).toHaveLength(1);
    const a = await rows('audit_log', s.accountId, `AND action = 'github.repo_created'`);
    expect(a).toHaveLength(1);
    expect(a[0].payload).toMatchObject({ gh_owner_id: 500, gh_repo_id: NEW_ID, name: 'widgets', visibility: 'private', connected: true, by: s.userId });
  });

  it('a refused attempt writes a refused audit row carrying the outcome word only', async () => {
    const s = await setup();
    await run(harness(s, { create: { status: 422, body: { message: 'name already exists on this account' } } }), s);
    const a = await rows('audit_log', s.accountId, `AND action = 'github.repo_create_refused'`);
    expect(a.map((r) => r.payload)).toEqual([{ outcome: 'name_taken' }]);
  });

  it('never leaks the user token: not in the result, the audit rows, the installation-token requests or any console output', async () => {
    const s = await setup();
    const spy = vi.spyOn(console, 'warn');
    const log = vi.spyOn(console, 'log');
    const h = harness(s);
    const res = await run(h, s);
    const everything = JSON.stringify([res, await rows('audit_log', s.accountId), spy.mock.calls, log.mock.calls]);
    expect(everything).not.toContain(USER_TOKEN);
    // The token goes only to the user endpoints of the fake, never into a body.
    expect(h.reqs.filter((r) => (r.body ?? '').includes(USER_TOKEN))).toEqual([]);
    spy.mockRestore();
    log.mockRestore();
  });

  it('token-kind guard: a non-user token from the exchange stops before any create call', async () => {
    const s = await setup();
    const h = harness(s, { exchangeToken: 'ghs_an_installation_token' });
    expect((await run(h, s)).outcome).toBe('failed');
    expect(h.reqs.some((r) => r.method === 'POST' && r.url.includes('/repos'))).toBe(false);
  });

  it('state, role and owner gates each stop before any create call', async () => {
    const s = await setup();
    const other = await setup();
    const cases: Array<[string, Awaited<ReturnType<typeof setup>>, string, Record<string, unknown>?]> = [
      ['tampered', s, tamper(stateFor(s))],
      ['minted for another user of the same account', s, stateFor(s, { user_id: other.userId })],
      ['description that does not match the hash', s, stateFor(s), { description: 'sneaked in' }],
      ['bad name in state', s, stateFor(s, { name: 'x.git' })],
    ];
    for (const [, who, state, extra] of cases) {
      const h = harness(who);
      expect((await run(h, who, state, extra)).outcome).toBe('failed');
      expect(h.reqs).toEqual([]);
    }
    const expired = mintCreateRepoState({ account_id: s.accountId, user_id: s.userId, owner_gh_id: 500, name: 'widgets', visibility: 'private', description_sha256: descriptionHash(null), auto_init: true }, SECRET, new Date(Date.now() - 3_600_000));
    const he = harness(s);
    expect((await run(he, s, expired)).outcome).toBe('failed');
    expect(he.reqs).toEqual([]);

    const member = await setup('member');
    const hm = harness(member);
    expect((await run(hm, member)).outcome).toBe('failed');
    expect(hm.reqs).toEqual([]);

    const wrongOwner = harness(s, { entries: [{ id: s.inst.gh, app_id: 7, account: { id: 999, login: 'someone', type: 'User' } }] });
    expect((await run(wrongOwner, s)).outcome).toBe('install_first');
    const notRecorded = harness(s, { entries: [{ id: s.inst.gh + 1, app_id: 7, account: { id: 500, login: 'acme', type: 'User' } }] });
    expect((await run(notRecorded, s, stateFor(s))).outcome).toBe('failed');
    for (const h of [wrongOwner, notRecorded]) expect(h.reqs.some((r) => r.method === 'POST' && r.url.includes('/repos'))).toBe(false);
  });

  it('install_first: an account with no recorded active team installation gets no GitHub call at all', async () => {
    const s = await setup('owner', false);
    const h = harness(s);
    expect((await run(h, s)).outcome).toBe('install_first');
    expect(h.reqs).toEqual([]);
  });

  it('rate: the 11th attempt in an hour is rate_limited before any GitHub call, counting reservations', async () => {
    const s = await setup();
    for (let i = 0; i < 10; i++) await admin.query(`SELECT audit_write_system($1, 'github_install', 'github.repo_create_reserved', $2::jsonb)`, [s.accountId, JSON.stringify({ nonce: `n${i}` })]);
    const h = harness(s);
    expect((await run(h, s)).outcome).toBe('rate_limited');
    expect(h.reqs).toEqual([]);
  });

  it('rate: the 51st attempt in a day is rate_limited even when the hour is quiet', async () => {
    const s = await setup();
    for (let i = 0; i < 50; i++) await admin.query(`SELECT audit_write_system($1, 'github_install', 'github.repo_create_reserved', $2::jsonb)`, [s.accountId, JSON.stringify({ nonce: `d${i}` })]);
    await admin.query(`UPDATE audit_log SET created_at = now() - interval '2 hours' WHERE account_id = $1`, [s.accountId]);
    const h = harness(s);
    expect((await run(h, s)).outcome).toBe('rate_limited');
    expect(h.reqs).toEqual([]);
  });

  it('an account that is not active is refused before any GitHub call', async () => {
    const s = await setup();
    await admin.query(`UPDATE accounts SET owner_paused_at = now() WHERE id = $1`, [s.accountId]);
    const h = harness(s);
    expect((await run(h, s)).outcome).toBe('failed');
    expect(h.reqs).toEqual([]);
  });

  it('W2: a bad state, a member, an inactive account and a replay spend none of the owners quota', async () => {
    const s = await setup();
    const member = await setup('member');
    const paused = await setup();
    await admin.query(`UPDATE accounts SET owner_paused_at = now() WHERE id = $1`, [paused.accountId]);
    await run(harness(s), s, tamper(stateFor(s)));
    await run(harness(member), member);
    await run(harness(paused), paused);
    const state = stateFor(s);
    await run(harness(s), s, state);
    await run(harness(s), s, state);
    for (const who of [member, paused]) expect(await rows('audit_log', who.accountId, `AND action = 'github.repo_create_refused'`)).toEqual([]);
    expect(await rows('audit_log', s.accountId, `AND action = 'github.repo_create_refused'`)).toEqual([]);
    // A real refusal from GitHub still counts.
    await run(harness(s, { create: { status: 403, body: {} } }), s);
    expect(await rows('audit_log', s.accountId, `AND action = 'github.repo_create_refused'`)).toHaveLength(1);
  });

  it('RC-1c: 15 concurrent callbacks against the 10/hour cap make exactly 10 reservations and 10 creates', async () => {
    const s = await setup();
    const hs = Array.from({ length: 15 }, () => harness(s));
    const results = await Promise.all(hs.map((h) => run(h, s)));
    expect(results.filter((r) => r.outcome === 'rate_limited')).toHaveLength(5);
    expect(results.filter((r) => r.outcome === 'ok')).toHaveLength(10);
    expect(await rows('audit_log', s.accountId, `AND action = 'github.repo_create_reserved'`)).toHaveLength(10);
    expect(hs.flatMap((h) => h.reqs).filter((r) => r.method === 'POST' && r.url.endsWith('/user/repos'))).toHaveLength(10);
  });

  it('RC-1c: the lock is not held across the GitHub call: a slow create blocks neither another account nor the same account', async () => {
    const s = await setup();
    const other = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = harness(s);
    const inner = slow.deps.fetchImpl as unknown as typeof fetch;
    let inCreate = 0;
    slow.deps.fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST' && String(url).endsWith('/user/repos')) {
        inCreate++;
        await gate;
      }
      return inner(url, init);
    }) as typeof fetch;
    const first = run(slow, s);
    while (inCreate === 0) await new Promise((r) => setTimeout(r, 10));
    expect((await run(harness(other), other)).outcome).toBe('ok');
    const sameHarness = harness(s);
    expect((await run(sameHarness, s)).outcome).toBe('ok');
    release();
    expect((await first).outcome).toBe('ok');
    expect(await rows('audit_log', s.accountId, `AND action = 'github.repo_create_reserved'`)).toHaveLength(2);
  });

  it('RC-1c: a reservation is written for a real attempt, and none for a replay, a member, an inactive account or no installation', async () => {
    const s = await setup();
    const member = await setup('member');
    const paused = await setup();
    const bare = await setup('owner', false);
    await admin.query(`UPDATE accounts SET owner_paused_at = now() WHERE id = $1`, [paused.accountId]);
    const state = stateFor(s);
    await run(harness(s), s, state);
    await run(harness(s), s, state);
    await run(harness(member), member);
    await run(harness(paused), paused);
    await run(harness(bare), bare);
    const count = async (who: typeof s) => (await rows('audit_log', who.accountId, `AND action = 'github.repo_create_reserved'`)).length;
    expect([await count(s), await count(member), await count(paused), await count(bare)]).toEqual([1, 0, 0, 0]);
    // The reservation exists before the outcome: a GitHub refusal still leaves it counted.
    const refused = await setup();
    await run(harness(refused, { create: { status: 403, body: {} } }), refused);
    expect(await count(refused)).toBe(1);
  });

  it('W3: if the repo_created audit row cannot be written the attempt fails closed, and nothing is deleted', async () => {
    const s = await setup();
    const h = harness(s);
    const own = createPool(process.env.GITHUB_DATABASE_URL_PLATFORM_OPS!);
    h.deps.platformOpsPool = {
      connect: async () => {
        const c = await own.connect();
        const query = c.query.bind(c) as (...a: unknown[]) => Promise<unknown>;
        (c as unknown as { query: unknown }).query = (text: unknown, params?: unknown[]) =>
          typeof text === 'string' && text.includes('audit_write_system') && params?.[1] === 'github.repo_created' ? Promise.reject(new Error('audit down')) : query(text, params);
        return c;
      },
    } as unknown as Pool;
    const res = await run(h, s);
    await own.end();
    expect(res).toEqual({ outcome: 'failed' });
    expect(h.reqs.filter((r) => r.method === 'POST' && r.url.endsWith('/user/repos'))).toHaveLength(1);
    expect(h.reqs.some((r) => r.method === 'DELETE')).toBe(false);
    expect(await rows('audit_log', s.accountId, `AND action = 'github.repo_created'`)).toEqual([]);
  });

  it('the description travels in the signed state and reaches GitHub; a description that disagrees with the hash is refused', async () => {
    const s = await setup();
    const h = harness(s);
    const state = stateFor(s, { description: 'Our widgets', description_sha256: descriptionHash('Our widgets') });
    expect((await run(h, s, state)).outcome).toBe('ok');
    expect(JSON.parse(h.reqs.find((r) => r.url.endsWith('/user/repos'))!.body!)).toMatchObject({ description: 'Our widgets' });
    const bad = harness(s);
    expect((await run(bad, s, stateFor(s, { description: 'Our widgets' }))).outcome).toBe('failed');
    expect(bad.reqs).toEqual([]);
  });
});
