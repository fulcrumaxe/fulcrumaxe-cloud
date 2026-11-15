import { randomInt, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { sitePreviewDeps, sitePreviewResponseSchema } from '../src/routes/sitePreview.js';
import { generateToken, displayHint } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { seedAccountWithMember, seedUser } from './helpers/seed.js';

interface Identity {
  accountId: string;
  userId: string;
}
interface Fx extends Identity {
  siteId: string;
  installationId: string;
  ghInstallationId: number;
  ghUserId: number;
}

/** D#3 K10: the site preview routes through the real dispatcher against real Postgres. */
describe('D#3 K10: site preview routes', () => {
  // The expected 503 is not an error-level report: nothing about it reaches stdout as a reported error.
  const logged: string[] = [];
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  const originalDeps = { ...sitePreviewDeps };
  const announced: string[] = [];

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
    await Promise.all([adminPool.end(), appUserPool.end(), platformOpsPool.end()]);
  });
  beforeEach(() => {
    announced.length = 0;
    logged.length = 0;
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => (logged.push(String(chunk)), true));
    sitePreviewDeps.available = () => true;
    sitePreviewDeps.announce = async (p) => void announced.push(p.previewId);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    Object.assign(sitePreviewDeps, originalDeps);
  });

  async function send(who: Identity | { bearer: string }, method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
    const headers = new Headers();
    if ('bearer' in who) headers.set('authorization', `Bearer ${who.bearer}`);
    else headers.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(who)}`);
    if (body !== undefined) headers.set('content-type', 'application/json');
    await admin.query("DELETE FROM rate_limit_windows WHERE bucket_key LIKE 'session%'");
    return handleApiRequest(new Request(`http://localhost/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), appUserPool, platformOpsPool, ROUTES);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = async (res: Response) => (await res.json()) as Record<string, any>;
  const code = async (res: Response) => (await json(res)).error.code as string;
  const randInt = () => randomInt(1, 2_000_000_000);
  const CAP = { confirm_model_cap_usd: 20 };

  /** A site on a site-kit installation with an installer record. */
  async function linkSite(accountId: string, siteId: string, ghUserId: number): Promise<{ installationId: string; ghInstallationId: number }> {
    const installationId = randomUUID();
    const ghInstallationId = randInt();
    const repoId = randomUUID();
    await admin.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, 'sitekit')`, [installationId, accountId, ghInstallationId]);
    await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, $4, 'team')`, [repoId, accountId, installationId, randInt()]);
    await admin.query('UPDATE sites SET repo_id = $1 WHERE id = $2', [repoId, siteId]);
    await admin.query(`INSERT INTO installation_installers (gh_installation_id, app_kind, installer_gh_user_id) VALUES ($1, 'sitekit', $2)`, [ghInstallationId, ghUserId]);
    return { installationId, ghInstallationId };
  }
  async function seed(): Promise<Fx> {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const siteId = randomUUID();
    await admin.query('INSERT INTO sites (id, account_id) VALUES ($1, $2)', [siteId, owner.accountId]);
    const ghUserId = randInt();
    return { ...owner, siteId, ghUserId, ...(await linkSite(owner.accountId, siteId, ghUserId)) };
  }
  async function memberOf(f: Fx, role: 'admin' | 'member'): Promise<Identity> {
    const userId = randomUUID();
    await seedUser(admin, userId);
    await admin.query('INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)', [f.accountId, userId, role]);
    return { accountId: f.accountId, userId };
  }
  async function mintToken(who: Identity): Promise<string> {
    const plaintext = generateToken();
    await insertApiToken(appUserPool, {
      accountId: who.accountId, createdBy: who.userId, tokenHash: hashToken(plaintext), displayHint: displayHint(plaintext),
      scopes: ['read'], expiresAt: new Date(Date.now() + 86_400_000),
    });
    return plaintext;
  }
  const preview = (f: Fx) => `/sites/${f.siteId}/preview`;
  const request = (who: Identity | { bearer: string }, f: Fx, body: unknown = CAP) => send(who, 'POST', preview(f), body);
  const stored = async (f: Fx) => (await admin.query('SELECT * FROM sitekit_previews WHERE site_id = $1', [f.siteId])).rows;

  it('an owner asks for the preview with the exact cap: 202, a requested row, the runner told once', async () => {
    const f = await seed();
    const res = await request(f, f);
    expect(res.status).toBe(202);
    const body = await json(res);
    expect(body).toEqual({ preview_id: expect.any(String), state: 'requested' });
    expect(announced).toEqual([body.preview_id]);
    expect(await stored(f)).toHaveLength(1);
  });

  it('answers 503 preview_unavailable and writes nothing while no runner can take it', async () => {
    const f = await seed();
    sitePreviewDeps.available = () => false;
    const res = await request(f, f);
    expect(res.status).toBe(503);
    expect(await code(res)).toBe('preview_unavailable');
    expect(logged.join('')).not.toContain('preview_unavailable');
    expect(await stored(f)).toHaveLength(0);
    expect((await admin.query('SELECT 1 FROM sitekit_preview_stamps WHERE gh_installation_id = $1', [f.ghInstallationId])).rows).toHaveLength(0);
  });

  it.each([{ confirm_model_cap_usd: 19 }, { confirm_model_cap_usd: 40 }, { confirm_model_cap_usd: 20.5 }])('refuses a cap that is not exactly confirmed (%j) with 422 and writes nothing', async (body) => {
    const f = await seed();
    const res = await request(f, f, body);
    expect(res.status).toBe(422);
    expect(await code(res)).toBe('preview_cap_not_confirmed');
    expect(await stored(f)).toHaveLength(0);
  });

  it.each([{}, { confirm_model_cap_usd: '20' }, { confirm_model_cap_usd: 20, extra: 1 }])('refuses a body that does not validate (%j)', async (body) => {
    const f = await seed();
    const res = await request(f, f, body);
    expect(res.status).toBe(422);
    expect(await stored(f)).toHaveLength(0);
  });

  it('a second request is refused with the named 409 preview_used and the text "Preview already used"', async () => {
    const f = await seed();
    expect((await request(f, f)).status).toBe(202);
    const again = await request(f, f);
    expect(again.status).toBe(409);
    const body = await json(again);
    expect(body.error.code).toBe('preview_used');
    expect(body.error.message).toBe('Preview already used');
    expect(await stored(f)).toHaveLength(1);
  });

  it('uninstalling and reinstalling the App does not give another preview', async () => {
    const f = await seed();
    expect((await request(f, f)).status).toBe(202);
    await admin.query('UPDATE installation_installers SET deleted_at = now() WHERE gh_installation_id = $1', [f.ghInstallationId]);
    await admin.query('UPDATE sites SET repo_id = NULL WHERE id = $1', [f.siteId]);
    await admin.query('DELETE FROM repos WHERE installation_id = $1', [f.installationId]);
    await admin.query('DELETE FROM installations WHERE id = $1', [f.installationId]);
    await linkSite(f.accountId, f.siteId, f.ghUserId);
    const res = await request(f, f);
    expect(res.status).toBe(409);
    expect(await code(res)).toBe('preview_used');
  });

  it('a member is 403 insufficient_role and a token is 403 session_required, and nothing is written', async () => {
    const f = await seed();
    const member = await memberOf(f, 'member');
    const denied = await request(member, f);
    expect(denied.status).toBe(403);
    expect(await code(denied)).toBe('insufficient_role');
    const tokened = await request({ bearer: await mintToken(f) }, f);
    expect(tokened.status).toBe(403);
    expect(await code(tokened)).toBe('session_required');
    expect(await stored(f)).toHaveLength(0);
  });

  it("another account's site, a missing site and a site with no site-kit repo are all 404 not_found", async () => {
    const f = await seed();
    const theirs = await seed();
    const bare = randomUUID();
    await admin.query('INSERT INTO sites (id, account_id) VALUES ($1, $2)', [bare, f.accountId]);
    for (const path of [preview(theirs), `/sites/${randomUUID()}/preview`, `/sites/${bare}/preview`]) {
      const res = await send(f, 'POST', path, CAP);
      expect(res.status, path).toBe(404);
      expect(await code(res)).toBe('not_found');
    }
    expect(await stored(theirs)).toHaveLength(0);
  });

  it('refuses at the daily limit of its own counter with 409 preview_capacity, while onboarding reservations at the limit do not block', async () => {
    const f = await seed();
    const reserve = (purpose: string, usd: number) =>
      admin.query(`INSERT INTO spend_reservations (account_id, run_id, usd_reserved, state, budget, purpose) VALUES ($1, NULL, $2, 'open', 'foreground_compute', $3)`, [f.accountId, usd, purpose]);
    await reserve('preview', 10);
    expect((await request(f, f)).status).toBe(202);
    const other = await seed();
    await reserve('sitekit_preview', 10);
    const res = await request(other, other);
    expect(res.status).toBe(409);
    expect(await code(res)).toBe('preview_capacity');
    expect(await stored(other)).toHaveLength(0);
    await admin.query(`DELETE FROM spend_reservations WHERE purpose IN ('preview', 'sitekit_preview')`);
  });

  it('GET with no preview answers null, both caps, and everything locked with "Setup payment required"', async () => {
    const f = await seed();
    const res = await send(f, 'GET', preview(f));
    expect(res.status).toBe(200);
    const body = sitePreviewResponseSchema.parse(await res.json());
    expect(body.preview).toBeNull();
    expect(body.model_cap_usd).toBe(20);
    expect(body.compute_cap_usd).toBe(1);
    for (const lock of Object.values(body.locks)) expect(lock).toEqual({ locked: true, label: 'Setup payment required' });
  });

  it('GET after a finished preview reads the same stored state every time: the line, the render, the locks', async () => {
    const f = await seed();
    const { preview_id } = await json(await request(f, f));
    await admin.query(
      `UPDATE sitekit_previews SET state = 'finished', started_at = now(), finished_at = now(), claims_total = 12, claims_unverifiable = 3, blockers = 1, homepage_html = '<h1>Home</h1>' WHERE id = $1`,
      [preview_id],
    );
    const first = sitePreviewResponseSchema.parse(await (await send(f, 'GET', preview(f))).json());
    const second = sitePreviewResponseSchema.parse(await (await send(f, 'GET', preview(f))).json());
    expect(second).toEqual(first);
    expect(first.preview).toMatchObject({ preview_id, state: 'finished', reason: null, summary: { claims: 12, unverifiable: 3, blockers: 1, line: '12 claims, 3 unverifiable, 1 blockers' }, homepage_url: `/api/v1/sites/${f.siteId}/preview/render` });
    expect(first.locks.full_site).toEqual({ locked: true, label: 'Setup payment required' });
  });

  it('GET never returns a render for a preview that has not finished, and a failed one carries its closed reason', async () => {
    const f = await seed();
    const { preview_id } = await json(await request(f, f));
    const running = sitePreviewResponseSchema.parse(await (await send(f, 'GET', preview(f))).json());
    expect(running.preview).toMatchObject({ state: 'requested', summary: null, homepage_url: null, reason: null });
    await admin.query(`UPDATE sitekit_previews SET state = 'failed', started_at = now(), finished_at = now(), reason = 'agent_failed', homepage_html = '<b>leak</b>' WHERE id = $1`, [preview_id]);
    const failed = sitePreviewResponseSchema.parse(await (await send(f, 'GET', preview(f))).json());
    expect(failed.preview).toMatchObject({ state: 'failed', reason: 'agent_failed', summary: null, homepage_url: null });
  });

  it('serves the stored render from its own route with a policy that gives the page nothing, only for a finished preview', async () => {
    const f = await seed();
    const { preview_id } = await json(await request(f, f));
    const early = await send(f, 'GET', `${preview(f)}/render`);
    expect(early.status).toBe(404);
    await admin.query(`UPDATE sitekit_previews SET state = 'finished', started_at = now(), finished_at = now(), claims_total = 1, claims_unverifiable = 0, blockers = 0, homepage_html = '<h1>Home</h1>' WHERE id = $1`, [preview_id]);
    const res = await send(f, 'GET', `${preview(f)}/render`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<h1>Home</h1>');
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'self'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('the render is not served for a failed preview, another account, a missing site or a token', async () => {
    const f = await seed();
    const theirs = await seed();
    const { preview_id } = await json(await request(f, f));
    await admin.query(`UPDATE sitekit_previews SET state = 'failed', started_at = now(), finished_at = now(), reason = 'agent_failed', homepage_html = '<b>leak</b>' WHERE id = $1`, [preview_id]);
    for (const path of [`${preview(f)}/render`, `${preview(theirs)}/render`, `/sites/${randomUUID()}/preview/render`]) expect((await send(f, 'GET', path)).status, path).toBe(404);
    await admin.query(`UPDATE sitekit_previews SET state = 'finished', reason = NULL, claims_total = 1, claims_unverifiable = 0, blockers = 0 WHERE id = $1`, [preview_id]);
    expect((await send(theirs, 'GET', `${preview(f)}/render`)).status).toBe(404);
    expect((await send({ bearer: await mintToken(f) }, 'GET', `${preview(f)}/render`)).status).toBe(403);
  });

  it('parallel requests for one site: exactly one is accepted and every other is the named 409, never a 500', async () => {
    const f = await seed();
    const results = await Promise.all(Array.from({ length: 6 }, () => request(f, f)));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([202, 409, 409, 409, 409, 409]);
    for (const r of results.filter((x) => x.status === 409)) expect(await code(r)).toBe('preview_used');
    expect(await stored(f)).toHaveLength(1);
  });

  it('the locks open once the site\'s setup payment is recorded, and only for that site', async () => {
    const f = await seed();
    const other = await seed();
    await admin.query('INSERT INTO sitekit_entitlements (account_id, site_id, setup_paid_at, setup_payment_intent_id) VALUES ($1, $2, now(), $3)', [f.accountId, f.siteId, `pi_${randomUUID()}`]);
    const paid = sitePreviewResponseSchema.parse(await (await send(f, 'GET', preview(f))).json());
    for (const lock of Object.values(paid.locks)) expect(lock).toEqual({ locked: false, label: null });
    const unpaid = sitePreviewResponseSchema.parse(await (await send(other, 'GET', preview(other))).json());
    for (const lock of Object.values(unpaid.locks)) expect(lock.locked).toBe(true);
  });

  it("GET of another account's or a missing site is 404, and a token is refused", async () => {
    const f = await seed();
    const theirs = await seed();
    for (const path of [preview(theirs), `/sites/${randomUUID()}/preview`]) {
      const res = await send(f, 'GET', path);
      expect(res.status, path).toBe(404);
    }
    const res = await send({ bearer: await mintToken(f) }, 'GET', preview(f));
    expect(res.status).toBe(403);
  });

  it('no response carries database, repository or adapter text', async () => {
    const f = await seed();
    await request(f, f);
    const refused = await request(f, f);
    const text = JSON.stringify(await json(refused));
    for (const leak of ['PX409', 'sitekit_preview_request', 'sitekit_preview_stamps', 'ERROR', 'detail']) expect(text).not.toContain(leak);
  });
});
