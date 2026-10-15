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
interface Pairing {
  enabled: boolean;
  code_repo: string | null;
  overlay_globs: string[];
  identifier_rules_path: string | null;
  plan_data_rules_path: string | null;
}
interface ErrorBody {
  error: { code: string };
  details?: { path: string; code: string }[];
}

const OFF: Pairing = { enabled: false, code_repo: null, overlay_globs: [], identifier_rules_path: null, plan_data_rules_path: null };
const GOOD = { code_repo: 'acme/widgets-public', overlay_globs: ['.autonomous-team/**', 'docs/ops/*.md'] };

/**
 * Repo pairing (off by default): the read, the set/replace and the clear, called through the real `handleApiRequest` against real
 * Postgres (RLS, the CHECK constraints, the SECURITY DEFINER audit function, the real service).
 */
describe('repo pairing API', () => {
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

  async function tokenFor(identity: Identity): Promise<string> {
    const plaintext = generateToken();
    await insertApiToken(appUserPool, {
      accountId: identity.accountId,
      createdBy: identity.userId,
      tokenHash: hashToken(plaintext),
      displayHint: 'fxat_...test',
      scopes: ['read'],
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    return plaintext;
  }

  async function seedRepo(accountId: string, names: { owner: string; name: string } | null = null): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO repos (account_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, 'web', $3, $4) RETURNING id`,
      [accountId, Math.floor(Math.random() * 1e9), names?.owner ?? null, names?.name ?? null],
    );
    return rows[0]!.id;
  }

  async function audits(accountId: string): Promise<{ action: string; payload: { repo_id: string; before: Pairing; after?: Pairing } }[]> {
    const { rows } = await admin.query(
      `SELECT action, payload FROM audit_log WHERE account_id = $1 AND action LIKE 'repo_pairing.%' ORDER BY created_at, id`,
      [accountId],
    );
    return rows;
  }

  const rowCount = async (repoId: string) => (await admin.query(`SELECT 1 FROM repo_pairing WHERE repo_id = $1`, [repoId])).rows.length;
  const get = async (who: Identity, repoId: string) => (await (await call(who, 'GET', `/repos/${repoId}/pairing`)).json()) as Pairing;

  it('is off by default: no row, enabled false, nothing null-ish on screen, and the repo itself reads as before', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const repoId = await seedRepo(owner.accountId);
    const res = await call(owner, 'GET', `/repos/${repoId}/pairing`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual(OFF);
    expect(await rowCount(repoId)).toBe(0);
    expect((await call(owner, 'GET', `/repos/${repoId}`)).status).toBe(200);
    expect((await call(owner, 'GET', `/repos/${repoId}/settings`)).status).toBe(200);
  });

  it('sets a pairing, reads it back, and writes one audit row with the before and after', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const repoId = await seedRepo(owner.accountId, { owner: 'acme', name: 'widgets' });
    const res = await call(owner, 'PUT', `/repos/${repoId}/pairing`, GOOD);
    expect(res.status).toBe(200);
    const expected: Pairing = { enabled: true, ...GOOD, identifier_rules_path: null, plan_data_rules_path: null };
    expect(await res.json()).toEqual(expected);
    expect(await get(owner, repoId)).toEqual(expected);
    expect(await audits(owner.accountId)).toEqual([{ action: 'repo_pairing.set', payload: { repo_id: repoId, before: OFF, after: expected } }]);
    const { rows } = await admin.query(`SELECT updated_by FROM repo_pairing WHERE repo_id = $1`, [repoId]);
    expect(rows[0].updated_by).toBe(owner.userId);
  });

  it('replaces a pairing wholesale (rule files included) and audits the change; a changed pairing is not stamped anywhere else', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const repoId = await seedRepo(owner.accountId);
    await call(owner, 'PUT', `/repos/${repoId}/pairing`, { ...GOOD, identifier_rules_path: 'rules/identifiers.txt', plan_data_rules_path: 'rules/plan-data.json' });
    const second = { code_repo: 'acme/other-public', overlay_globs: ['private/**'] };
    const res = await call(owner, 'PUT', `/repos/${repoId}/pairing`, second);
    expect(res.status).toBe(200);
    // A PUT is a replace: the rule files left out are cleared, not kept.
    const expected: Pairing = { enabled: true, ...second, identifier_rules_path: null, plan_data_rules_path: null };
    expect(await get(owner, repoId)).toEqual(expected);
    const log = await audits(owner.accountId);
    expect(log.map((l) => l.action)).toEqual(['repo_pairing.set', 'repo_pairing.set']);
    expect(log[1]!.payload.before).toMatchObject({ code_repo: 'acme/widgets-public', identifier_rules_path: 'rules/identifiers.txt' });
    expect(log[1]!.payload.after).toEqual(expected);
    expect(await rowCount(repoId)).toBe(1);
  });

  it('refuses bad input with a 422 naming the field, writing nothing and auditing nothing', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const repoId = await seedRepo(owner.accountId, { owner: 'acme', name: 'widgets' });
    const url = `/repos/${repoId}/pairing`;
    const cases: [string, unknown, string][] = [
      ['no slash', { ...GOOD, code_repo: 'widgets' }, 'code_repo'],
      ['a full URL', { ...GOOD, code_repo: 'https://github.com/acme/widgets' }, 'code_repo'],
      ['a dot-dot name', { ...GOOD, code_repo: 'acme/..' }, 'code_repo'],
      ['an owner starting with a hyphen', { ...GOOD, code_repo: '-acme/x' }, 'code_repo'],
      ['the repo itself', { ...GOOD, code_repo: 'Acme/Widgets' }, 'code_repo'],
      ['no private paths', { ...GOOD, overlay_globs: [] }, 'overlay_globs'],
      ['an empty path', { ...GOOD, overlay_globs: [''] }, 'overlay_globs'],
      ['an absolute path', { ...GOOD, overlay_globs: ['/etc/**'] }, 'overlay_globs'],
      ['a climbing path', { ...GOOD, overlay_globs: ['docs/../secrets'] }, 'overlay_globs'],
      ['a backslash', { ...GOOD, overlay_globs: ['docs\\ops'] }, 'overlay_globs'],
      ['a space', { ...GOOD, overlay_globs: ['my docs/**'] }, 'overlay_globs'],
      ['a newline', { ...GOOD, overlay_globs: ['docs\n**'] }, 'overlay_globs'],
      ['an empty segment', { ...GOOD, overlay_globs: ['docs//ops'] }, 'overlay_globs'],
      ['a path over 200 characters', { ...GOOD, overlay_globs: ['a'.repeat(201)] }, 'overlay_globs'],
      ['a path listed twice', { ...GOOD, overlay_globs: ['docs/**', 'docs/**'] }, 'overlay_globs'],
      ['a glob in a rule file path', { ...GOOD, identifier_rules_path: 'rules/*.txt' }, 'identifier_rules_path'],
      ['an absolute rule file path', { ...GOOD, plan_data_rules_path: '/rules.json' }, 'plan_data_rules_path'],
      ['an empty rule file path', { ...GOOD, plan_data_rules_path: '' }, 'plan_data_rules_path'],
    ];
    for (const [label, body, field] of cases) {
      const res = await call(owner, 'PUT', url, body);
      expect(res.status, label).toBe(422);
      const err = (await res.json()) as ErrorBody;
      expect(err.error.code, label).toBe('invalid_role_settings_input');
      expect(err.details, label).toEqual([{ path: field, code: 'invalid' }]);
    }
    // Shape errors (body validation): unknown key, wrong types, too many paths, no body.
    const tooMany = Array.from({ length: 101 }, (_, i) => `p${i}/**`);
    for (const body of [{ ...GOOD, extra: 1 }, { code_repo: 5, overlay_globs: ['x'] }, { code_repo: 'a/b' }, { ...GOOD, overlay_globs: tooMany }, { ...GOOD, overlay_globs: [1] }]) {
      expect((await call(owner, 'PUT', url, body)).status, JSON.stringify(body).slice(0, 60)).toBe(422);
    }
    expect((await call(owner, 'PUT', url)).status).toBe(422);
    expect(await rowCount(repoId)).toBe(0);
    expect(await audits(owner.accountId)).toEqual([]);
  });

  it('accepts glob characters in the private paths and the largest allowed list', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const repoId = await seedRepo(owner.accountId);
    const globs = ['**/*.{md,txt}', 'docs/ops/?.md', '.github/**', 'a-b_c.d/e@f+g=h~i', ...Array.from({ length: 96 }, (_, i) => `dir${i}/**`)];
    expect(globs).toHaveLength(100);
    const res = await call(owner, 'PUT', `/repos/${repoId}/pairing`, { code_repo: 'a/b', overlay_globs: globs });
    expect(res.status).toBe(200);
    expect((await get(owner, repoId)).overlay_globs).toEqual(globs);
  });

  it('clears a pairing: back to off, one audit row, and clearing again is a quiet no-op', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const repoId = await seedRepo(owner.accountId);
    await call(owner, 'PUT', `/repos/${repoId}/pairing`, GOOD);
    const del = await call(owner, 'DELETE', `/repos/${repoId}/pairing`);
    expect(del.status).toBe(204);
    expect(await get(owner, repoId)).toEqual(OFF);
    expect(await rowCount(repoId)).toBe(0);
    expect((await call(owner, 'DELETE', `/repos/${repoId}/pairing`)).status).toBe(204);
    const log = await audits(owner.accountId);
    expect(log.map((l) => l.action)).toEqual(['repo_pairing.set', 'repo_pairing.cleared']);
    expect(log[1]!.payload.before).toMatchObject({ enabled: true, code_repo: 'acme/widgets-public' });
    // It can be turned on again from scratch.
    expect((await call(owner, 'PUT', `/repos/${repoId}/pairing`, GOOD)).status).toBe(200);
  });

  it('removing the repo removes its pairing', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const repoId = await seedRepo(owner.accountId);
    await call(owner, 'PUT', `/repos/${repoId}/pairing`, GOOD);
    await admin.query(`DELETE FROM repos WHERE id = $1`, [repoId]);
    expect(await rowCount(repoId)).toBe(0);
  });

  it('a member and a token may read; only a session owner or admin may change, and a refusal changes nothing', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const repoId = await seedRepo(owner.accountId);
    const member = await addMember(owner.accountId, 'member');
    const admin2 = await addMember(owner.accountId, 'admin');
    const token = await tokenFor(owner);
    const url = `/repos/${repoId}/pairing`;

    for (const [method, body] of [['PUT', GOOD], ['DELETE', undefined]] as const) {
      const asMember = await call(member, method, url, body);
      expect(asMember.status, method).toBe(403);
      expect(((await asMember.json()) as ErrorBody).error.code).toBe('insufficient_role');
      const asToken = await call(owner, method, url, body, token);
      expect(asToken.status, method).toBe(403);
      expect(((await asToken.json()) as ErrorBody).error.code).toBe('session_required');
    }
    expect(await rowCount(repoId)).toBe(0);
    expect(await audits(owner.accountId)).toEqual([]);

    expect((await call(member, 'GET', url)).status).toBe(200);
    expect((await call(owner, 'GET', url, undefined, token)).status).toBe(200);
    expect((await call(admin2, 'PUT', url, GOOD)).status).toBe(200);
    expect((await audits(owner.accountId))[0]).toMatchObject({ action: 'repo_pairing.set' });
  });

  it("another account's repo id is 404 on all three routes (and a non-uuid id too), and its pairing is untouched", async () => {
    const a = await seedAccountWithMember(admin, { role: 'owner' });
    const b = await seedAccountWithMember(admin, { role: 'owner' });
    const bRepo = await seedRepo(b.accountId);
    await call(b, 'PUT', `/repos/${bRepo}/pairing`, GOOD);
    for (const [method, body] of [['GET', undefined], ['PUT', { ...GOOD, code_repo: 'evil/x' }], ['DELETE', undefined]] as const) {
      const res = await call(a, method, `/repos/${bRepo}/pairing`, body);
      expect(res.status, method).toBe(404);
      expect(((await res.json()) as ErrorBody).error.code).toBe('not_found');
      expect((await call(a, method, `/repos/not-a-uuid/pairing`, body)).status, `${method} malformed`).toBe(404);
    }
    expect(await get(b, bRepo)).toMatchObject({ enabled: true, code_repo: 'acme/widgets-public' });
    expect(await audits(a.accountId)).toEqual([]);
  });
});
