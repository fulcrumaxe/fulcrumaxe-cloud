import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { withTenant } from '@fx/core/src/tenancy/withTenant.js';
import { openVerifyRow, readVerifyRow } from '@fx/core/src/verify/rows.js';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { seedAccountWithMember, seedUser } from './helpers/seed.js';

interface Identity {
  accountId: string;
  userId: string;
}
interface ErrorBody {
  error: { code: string; message: string };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (operationId: string, file: string): Record<string, unknown> => JSON.parse(readFileSync(path.join(__dirname, '..', 'fixtures', 'v1', operationId, file), 'utf8')) as Record<string, unknown>;
const URL_OK = 'https://app.example.test';
const SHA = 'a'.repeat(40);

/**
 * D#749 V4a: the admin verify-settings routes through the real handler against real Postgres: the table's owner-or-admin policies (1003), the audit row (1008),
 * the undo path (turning the setting off ends the rows that never started and the stage opens no new one).
 */
describe('D#749 V4a: verify settings routes', () => {
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
    const { rows } = await admin.query<{ id: string }>(`INSERT INTO repos (account_id, installation_id, gh_repo_id, product) VALUES ($1, NULL, $2, 'web') RETURNING id`, [accountId, Math.floor(Math.random() * 1e9)]);
    return rows[0]!.id;
  }
  async function mergedItem(accountId: string, repoId: string): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage) VALUES ($1, $2, $3, 'feature', 'internal', 'merged')`, [id, accountId, repoId]);
    return id;
  }
  async function tokenFor(who: Identity): Promise<string> {
    const plaintext = generateToken();
    await insertApiToken(appUserPool, { accountId: who.accountId, createdBy: who.userId, tokenHash: hashToken(plaintext), displayHint: 'fxat_...test', scopes: ['read', 'work_items:write'], expiresAt: new Date(Date.now() + 86_400_000) });
    return plaintext;
  }
  /** An owner, an admin and a plain member on one account that has two repositories. */
  async function world() {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const adminUser = await addMember(owner.accountId, 'admin');
    const member = await addMember(owner.accountId, 'member');
    return { owner, adminUser, member, repo: await seedRepo(owner.accountId), other: await seedRepo(owner.accountId) };
  }
  const audits = async (accountId: string) =>
    (await admin.query<{ actor: string; payload: { repo_id: string; created: boolean; changes: Record<string, { from: unknown; to: unknown }> } }>(`SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'verify_settings.changed' ORDER BY created_at, id`, [accountId])).rows;
  const rowCount = async (repoId: string) => Number((await admin.query<{ n: string }>(`SELECT count(*) AS n FROM verify_settings WHERE repo_id = $1`, [repoId])).rows[0]!.n);
  const listed = async () => (await admin.query<{ repo_id: string }>(`SELECT repo_id FROM verify_stage_list_enabled(200, NULL)`)).rows.map((r) => r.repo_id);
  const errOf = async (res: Response): Promise<ErrorBody> => (await res.json()) as ErrorBody;
  const url = (repo: string) => `/repos/${repo}/verify-settings`;

  it('V4a-1: an unconfigured repository reads as off with no address, and the body has the fixture shape', async () => {
    const w = await world();
    for (const who of [w.owner, w.adminUser]) {
      const res = await call(who, 'GET', url(w.repo));
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({ ...fixture('getRepoVerifySettings', '200-unconfigured.json'), repo_id: w.repo });
    }
    expect(await rowCount(w.repo)).toBe(0);
  });

  it('V4a-2: a member gets 403 on the read and the write, a token gets session_required, and nothing is written or audited', async () => {
    const w = await world();
    const token = await tokenFor(w.owner);
    for (const [method, body] of [['GET', undefined], ['PUT', { enabled: true, base_url: URL_OK }]] as const) {
      const asMember = await call(w.member, method, url(w.repo), body);
      expect(asMember.status, method).toBe(403);
      expect((await errOf(asMember)).error.code).toBe('insufficient_role');
      const asToken = await call(w.owner, method, url(w.repo), body, token);
      expect(asToken.status, method).toBe(403);
      expect((await errOf(asToken)).error.code).toBe('session_required');
    }
    expect(await rowCount(w.repo)).toBe(0);
    expect(await audits(w.owner.accountId)).toEqual([]);
  });

  it('V4a-3: the table itself refuses a member (42501), so a handler that forgot the role check would still be refused', async () => {
    const w = await world();
    await expect(
      withTenant(appUserPool, w.owner.accountId, w.member.userId, (c) => c.query(`INSERT INTO verify_settings (account_id, repo_id, enabled, base_url, updated_by) VALUES ($1, $2, true, $3, $4)`, [w.owner.accountId, w.repo, URL_OK, w.member.userId])),
    ).rejects.toMatchObject({ code: '42501' });
    // An admin saves one through the route, and the member still cannot change it directly.
    expect((await call(w.adminUser, 'PUT', url(w.repo), { enabled: true, base_url: URL_OK })).status).toBe(200);
    const update = await withTenant(appUserPool, w.owner.accountId, w.member.userId, (c) => c.query(`UPDATE verify_settings SET enabled = false WHERE repo_id = $1`, [w.repo]));
    expect(update.rowCount).toBe(0);
    expect((await admin.query<{ enabled: boolean }>(`SELECT enabled FROM verify_settings WHERE repo_id = $1`, [w.repo])).rows[0]!.enabled).toBe(true);
  });

  it('V4a-4: an admin write leaves exactly one audit row naming who and what changed, and the read shows it after a reload', async () => {
    const w = await world();
    const res = await call(w.adminUser, 'PUT', url(w.repo), { enabled: true, base_url: URL_OK, browser_driver: 'chrome', test_account_label: ' verify-bot ', standing_journeys: [{ id: 'sign_in', text: 'Sign in and open the item card' }] });
    expect(res.status).toBe(200);
    const saved = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(saved).sort()).toEqual(Object.keys(fixture('putRepoVerifySettings', '200-ok.json')).sort());
    expect(saved).toMatchObject({ repo_id: w.repo, configured: true, enabled: true, base_url: URL_OK, browser_driver: 'chrome', test_account_label: 'verify-bot', changed: true, ended_rows: 0 });

    const rows = await audits(w.owner.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe(w.adminUser.userId);
    expect(rows[0]!.payload).toEqual({
      repo_id: w.repo,
      created: true,
      changes: {
        enabled: { from: false, to: true },
        base_url: { from: null, to: URL_OK },
        browser_driver: { from: 'playwright', to: 'chrome' },
        test_account_label: { from: null, to: 'verify-bot' },
        standing_journeys: { from: 0, to: 1 },
      },
    });

    const again = (await (await call(w.owner, 'GET', url(w.repo))).json()) as Record<string, unknown>;
    expect(again).toMatchObject({ configured: true, enabled: true, base_url: URL_OK, browser_driver: 'chrome', test_account_label: 'verify-bot', standing_journeys: [{ id: 'sign_in', text: 'Sign in and open the item card' }] });
    // The audit row names no free text: the journey text is not in it.
    expect(JSON.stringify(rows[0]!.payload)).not.toContain('Sign in and open');
  });

  it('V4a-5: a second save changes only the keys sent, audits only what changed, and a repeat of the saved values writes no row', async () => {
    const w = await world();
    await call(w.owner, 'PUT', url(w.repo), { enabled: true, base_url: URL_OK });
    const second = await call(w.owner, 'PUT', url(w.repo), { browser_driver: 'chrome' });
    expect(await second.json()).toMatchObject({ enabled: true, base_url: URL_OK, browser_driver: 'chrome', changed: true });
    const repeat = await call(w.owner, 'PUT', url(w.repo), { browser_driver: 'chrome', base_url: URL_OK });
    expect(await repeat.json()).toMatchObject({ changed: false, ended_rows: 0 });
    const rows = await audits(w.owner.accountId);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.payload).toEqual({ repo_id: w.repo, created: false, changes: { browser_driver: { from: 'playwright', to: 'chrome' } } });
    // Settings are per repository.
    expect(await (await call(w.owner, 'GET', url(w.other))).json()).toMatchObject({ configured: false, enabled: false });
  });

  it('V4a-6: an empty, credentialed, non-https, ported or pathful base_url is refused with 422, and nothing is written or audited', async () => {
    const w = await world();
    const bad = ['', '   ', 'http://app.example.test', 'https://user:pw@app.example.test', 'https://app.example.test:8443', 'https://app.example.test/app', 'https://app.example.test/?x=1', 'ftp://app.example.test', 'app.example.test', 'https://'];
    for (const base_url of bad) {
      for (const body of [{ base_url }, { enabled: true, base_url }]) {
        const res = await call(w.owner, 'PUT', url(w.repo), body);
        expect(res.status, JSON.stringify(body)).toBe(422);
        expect((await errOf(res)).error.code, JSON.stringify(body)).toBe('verify_base_url_invalid');
      }
    }
    expect(await rowCount(w.repo)).toBe(0);
    expect(await audits(w.owner.accountId)).toEqual([]);
    // A repository with no address cannot be switched on, with the address missing or explicitly null.
    for (const body of [{ enabled: true }, { enabled: true, base_url: null }]) {
      const res = await call(w.owner, 'PUT', url(w.repo), body);
      expect(res.status).toBe(422);
      expect((await errOf(res)).error.code).toBe('verify_base_url_required');
    }
    expect(await rowCount(w.repo)).toBe(0);
    expect(await audits(w.owner.accountId)).toEqual([]);
  });

  it('V4a-7: other bad values are refused whole: an unknown key, a bad driver, an empty body, bad journeys and paths', async () => {
    const w = await world();
    const cases: [unknown, number, string][] = [
      [{}, 422, 'validation_failed'],
      [{ enabled: 'yes' }, 422, 'validation_failed'],
      [{ browser_driver: 'firefox' }, 422, 'validation_failed'],
      [{ deploy_mode: 'runner_command' }, 422, 'validation_failed'],
      // An unknown key beside a good one is refused, not dropped: the batch columns are not settable here.
      [{ enabled: false, batch_size: 5 }, 422, 'validation_failed'],
      [{ standing_journeys: [{ id: 'Bad Id', text: 'x' }] }, 422, 'verify_setting_invalid'],
      [{ standing_journeys: [{ id: 'a', text: 'x' }, { id: 'a', text: 'y' }] }, 422, 'verify_setting_invalid'],
      [{ eligibility_paths: ['../etc'] }, 422, 'verify_setting_invalid'],
      [{ test_account_label: '' }, 422, 'verify_setting_invalid'],
    ];
    for (const [body, status, code] of cases) {
      const res = await call(w.owner, 'PUT', url(w.repo), body);
      expect(res.status, JSON.stringify(body)).toBe(status);
      expect((await errOf(res)).error.code, JSON.stringify(body)).toBe(code);
    }
    // One bad value refuses the whole save: the good value beside it is not written either.
    const mixed = await call(w.owner, 'PUT', url(w.repo), { enabled: false, test_account_label: '' });
    expect(mixed.status).toBe(422);
    expect(await rowCount(w.repo)).toBe(0);
    expect(await audits(w.owner.accountId)).toEqual([]);
  });

  it('V4a-8: turning the setting off ends the rows that never started, the stage opens no new row and does not list the repository; turning it on starts clean', async () => {
    const w = await world();
    expect((await call(w.owner, 'PUT', url(w.repo), { enabled: true, base_url: URL_OK, eligibility: 'all' })).status).toBe(200);
    expect(await listed()).toContain(w.repo);

    const asWorker = <T,>(fn: (c: PoolClient) => Promise<T>) => withTenant(appUserPool, w.owner.accountId, fn);
    const item = await mergedItem(w.owner.accountId, w.repo);
    const opened = await asWorker((c) => openVerifyRow(c, w.owner.accountId, { workItemId: item, prNumber: 7, mergeSha: SHA }));
    expect(opened.opened).toBe(true);
    const rowId = (opened as { rowId: string }).rowId;

    const off = await call(w.adminUser, 'PUT', url(w.repo), { enabled: false });
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ enabled: false, base_url: URL_OK, changed: true, ended_rows: 1 });
    expect(await asWorker((c) => readVerifyRow(c, w.owner.accountId, rowId))).toMatchObject({ status: 'unverified', reason_code: 'verify_disabled' });
    expect(await listed()).not.toContain(w.repo);
    const later = await mergedItem(w.owner.accountId, w.repo);
    expect(await asWorker((c) => openVerifyRow(c, w.owner.accountId, { workItemId: later, prNumber: 8, mergeSha: 'b'.repeat(40) }))).toEqual({ opened: false, reason: 'verify_off' });
    // The address stays for the next time, and the read shows off after a reload.
    expect(await (await call(w.owner, 'GET', url(w.repo))).json()).toMatchObject({ enabled: false, base_url: URL_OK });

    // Saying "off" again ends nothing and audits nothing.
    expect(await (await call(w.owner, 'PUT', url(w.repo), { enabled: false })).json()).toMatchObject({ changed: false, ended_rows: 0 });
    const rows = await audits(w.owner.accountId);
    expect(rows.map((r) => r.payload.changes.enabled)).toEqual([{ from: false, to: true }, { from: true, to: false }]);

    // Back on: new merges open new rows, and the ended one stays ended.
    expect((await call(w.owner, 'PUT', url(w.repo), { enabled: true })).status).toBe(200);
    expect(await listed()).toContain(w.repo);
    expect((await asWorker((c) => openVerifyRow(c, w.owner.accountId, { workItemId: later, prNumber: 8, mergeSha: 'b'.repeat(40) }))).opened).toBe(true);
    expect(await asWorker((c) => readVerifyRow(c, w.owner.accountId, rowId))).toMatchObject({ status: 'unverified', reason_code: 'verify_disabled' });
  });

  it('V4a-9: another account\'s repository, a malformed id and an unknown id answer 404 or 422, never the settings', async () => {
    const w = await world();
    const stranger = await seedAccountWithMember(admin, { role: 'owner' });
    const theirs = await seedRepo(stranger.accountId);
    await call(stranger, 'PUT', url(theirs), { enabled: true, base_url: URL_OK });
    for (const method of ['GET', 'PUT']) {
      const res = await call(w.owner, method, url(theirs), method === 'PUT' ? { enabled: false } : undefined);
      expect([404, 422], method).toContain(res.status);
    }
    expect([404, 422]).toContain((await call(w.owner, 'GET', url('not-a-uuid'))).status);
    expect([404, 422]).toContain((await call(w.owner, 'GET', url(randomUUID()))).status);
    expect((await admin.query<{ enabled: boolean }>(`SELECT enabled FROM verify_settings WHERE repo_id = $1`, [theirs])).rows[0]!.enabled).toBe(true);
    expect(await audits(w.owner.accountId)).toEqual([]);
  });

  it('V4a-10: the fixtures for both operations carry the keys the live responses carry', async () => {
    const w = await world();
    const put = (await (await call(w.owner, 'PUT', url(w.repo), { enabled: true, base_url: URL_OK })).json()) as Record<string, unknown>;
    expect(Object.keys(put).sort()).toEqual(Object.keys(fixture('putRepoVerifySettings', '200-turned_off.json')).sort());
    const get = (await (await call(w.owner, 'GET', url(w.repo))).json()) as Record<string, unknown>;
    expect(Object.keys(get).sort()).toEqual(Object.keys(fixture('getRepoVerifySettings', '200-ok.json')).sort());
    const refused = await errOf(await call(w.owner, 'PUT', url(w.repo), { base_url: 'http://x.example' }));
    expect(refused.error.code).toBe((fixture('putRepoVerifySettings', '422-verify_base_url_invalid.json') as unknown as ErrorBody).error.code);
  });
});
