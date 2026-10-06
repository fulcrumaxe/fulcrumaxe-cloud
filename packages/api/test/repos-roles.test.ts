import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { InvalidRoleSettingsInputError } from '@fx/core/src/role-settings/errors.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { handleApiRequest } from '../src/handler.js';
import { mapError } from '../src/errors.js';
import { ROUTES } from '../src/routes/index.js';
import { seedAccountWithMember, seedUser } from './helpers/seed.js';

interface Identity {
  accountId: string;
  userId: string;
}
interface Item {
  id: string;
  install_state: string;
  app_kind: string | null;
  gh_repo_id: number;
  full_name: string | null;
}
interface Role {
  role: string;
  mode: string;
  allowed_modes: string[];
  model: string | null;
  model_floor: string | null;
  allowed_models: string[];
  expected_spend: Record<string, unknown>;
}
interface ErrorBody {
  error: { code: string };
  details?: { path: string; code: string }[];
}

/**
 * D#31 API-8a: repos, settings, roles reads, the settings PATCH and the
 * role-mode PATCH, called through the real `handleApiRequest` against real
 * Postgres (RLS, the SECURITY DEFINER audit function, the real H12 service).
 */
describe('D#31 API-8a: repos, settings and roles', () => {
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
    const req = new Request(`http://localhost/api/v1${urlPath}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
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

  async function seedRepo(
    accountId: string,
    kind: 'team' | 'sitekit' | null,
    createdAt = new Date(),
    names: { owner: string | null; name: string | null } = { owner: null, name: null },
  ): Promise<{ repoId: string; installationId: string | null }> {
    let installationId: string | null = null;
    if (kind) {
      const { rows } = await admin.query<{ id: string }>(
        `INSERT INTO installations (account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3) RETURNING id`,
        [accountId, Math.floor(Math.random() * 1e9), kind],
      );
      installationId = rows[0]!.id;
    }
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO repos (account_id, installation_id, gh_repo_id, product, created_at, gh_owner, gh_name) VALUES ($1, $2, $3, 'web', $4, $5, $6) RETURNING id`,
      [accountId, installationId, Math.floor(Math.random() * 1e9), createdAt, names.owner, names.name],
    );
    return { repoId: rows[0]!.id, installationId };
  }

  async function auditCount(accountId: string, action: string): Promise<number> {
    const { rows } = await admin.query<{ n: string }>(`SELECT count(*) AS n FROM audit_log WHERE account_id = $1 AND action = $2`, [accountId, action]);
    return Number(rows[0]!.n);
  }

  async function settingsOf(repoId: string): Promise<unknown> {
    const { rows } = await admin.query<{ settings: unknown }>(`SELECT settings FROM repos WHERE id = $1`, [repoId]);
    return rows[0]!.settings;
  }

  async function roles(identity: Identity, repoId: string): Promise<Role[]> {
    const res = await call(identity, 'GET', `/repos/${repoId}/roles`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: Role[] }).data;
  }

  it('criterion 1: lists repos with derived install state, keyset-paginated, for a token too', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const t0 = Date.now();
    const a = await seedRepo(owner.accountId, 'team', new Date(t0 - 3000));
    const b = await seedRepo(owner.accountId, 'sitekit', new Date(t0 - 2000));
    const c = await seedRepo(owner.accountId, null, new Date(t0 - 1000));

    const page1 = await call(owner, 'GET', '/repos?limit=2');
    expect(page1.status).toBe(200);
    const body1 = (await page1.json()) as { data: Item[]; next_cursor: string | null };
    expect(body1.data.map((r) => r.id)).toEqual([c.repoId, b.repoId]);
    expect(body1.data[0]).toMatchObject({ install_state: 'not_installed', app_kind: null });
    expect(body1.data[1]).toMatchObject({ install_state: 'installed', app_kind: 'sitekit' });
    expect(Object.keys(body1.data[0]!).sort()).toEqual(['app_kind', 'full_name', 'gh_repo_id', 'id', 'install_state', 'product']);
    expect(body1.next_cursor).not.toBeNull();

    const page2 = await call(owner, 'GET', `/repos?limit=2&cursor=${body1.next_cursor}`);
    const body2 = (await page2.json()) as { data: Item[]; next_cursor: string | null };
    expect(body2.data).toMatchObject([{ id: a.repoId, install_state: 'installed', app_kind: 'team' }]);
    expect(body2.next_cursor).toBeNull();

    const token = await tokenFor(owner);
    const viaToken = await call(owner, 'GET', `/repos/${a.repoId}`, undefined, token);
    expect(viaToken.status).toBe(200);
    expect(((await viaToken.json()) as Item).id).toBe(a.repoId);
  });

  it('criterion 1: full_name is owner/name once a sync wrote both, and null before one or when half is missing', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const synced = await seedRepo(owner.accountId, 'team', new Date(), { owner: 'acme', name: 'widgets' });
    const unsynced = await seedRepo(owner.accountId, 'team');
    const half = await seedRepo(owner.accountId, 'team', new Date(), { owner: 'acme', name: null });
    const get = async (id: string) => ((await (await call(owner, 'GET', `/repos/${id}`)).json()) as Item).full_name;
    expect(await get(synced.repoId)).toBe('acme/widgets');
    expect(await get(unsynced.repoId)).toBeNull();
    expect(await get(half.repoId)).toBeNull();
    const list = (await (await call(owner, 'GET', '/repos')).json()) as { data: Item[] };
    expect(list.data.find((r) => r.id === synced.repoId)!.full_name).toBe('acme/widgets');
  });

  it('criterion 1: a repo whose installation row was deleted reads not_installed', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const { repoId, installationId } = await seedRepo(owner.accountId, 'team');
    expect(((await (await call(owner, 'GET', `/repos/${repoId}`)).json()) as Item).install_state).toBe('installed');
    await admin.query(`DELETE FROM installations WHERE id = $1`, [installationId]);
    expect(await (await call(owner, 'GET', `/repos/${repoId}`)).json()).toMatchObject({ install_state: 'not_installed', app_kind: null });
  });

  it('criterion 2: settings default to the fail-closed values, and read back what was stored', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const { repoId } = await seedRepo(owner.accountId, 'team');
    expect(await (await call(owner, 'GET', `/repos/${repoId}/settings`)).json()).toEqual({ auto_merge: false, block_external_auto_merge: true });
    await admin.query(`UPDATE repos SET settings = '{"autoMerge": true}' WHERE id = $1`, [repoId]);
    expect(await (await call(owner, 'GET', `/repos/${repoId}/settings`)).json()).toEqual({ auto_merge: true, block_external_auto_merge: true });
  });

  it('criterion 3: roles returns all 26 with mode, allowed_modes, the stored model or null, and the spend line', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const { repoId } = await seedRepo(owner.accountId, 'team');
    const before = await roles(owner, repoId);
    expect(before).toHaveLength(26);
    expect(new Set(before.map((r) => r.role)).size).toBe(26);
    for (const r of before) {
      expect(Object.keys(r).sort()).toEqual(['allowed_models', 'allowed_modes','expected_spend', 'mode', 'model', 'model_floor', 'role']);
      expect(r.model).toBeNull();
      expect(r.allowed_modes).toContain(r.mode);
      expect(Object.keys(r.expected_spend).sort()).toEqual(['caveat', 'median_cost_per_run_usd', 'median_source', 'monthly_usd', 'runs_per_month', 'text']);
    }
    // A stored value is returned as-is (the database CHECK from 0645 now only lets a valid id be stored).
    const target = before[0]!;
    await admin.query(
      `INSERT INTO role_settings (account_id, repo_id, role, mode, model) VALUES ($1, $2, $3, $4, 'sonnet-5')`,
      [owner.accountId, repoId, target.role, target.mode],
    );
    const after = await roles(owner, repoId);
    expect(after.find((r) => r.role === target.role)!.model).toBe('sonnet-5');
    expect(after.filter((r) => r.model !== null)).toHaveLength(1);
  });

  it('criterion 4: the external guard is 422 without the acknowledgement, and 200 with one audit row with it', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const { repoId } = await seedRepo(owner.accountId, 'team');
    const url = `/repos/${repoId}/settings`;

    for (const body of [
      { block_external_auto_merge: false },
      { block_external_auto_merge: false, acknowledge_external_risk: false },
    ]) {
      const res = await call(owner, 'PATCH', url, body);
      expect(res.status).toBe(422);
      const err = (await res.json()) as ErrorBody;
      expect(err.error.code).toBe('invalid_role_settings_input');
      expect(err.details).toEqual([{ path: 'acknowledge_external_risk', code: 'invalid' }]);
    }
    expect(await settingsOf(repoId)).toEqual({});
    expect(await auditCount(owner.accountId, 'role_settings.guard_changed')).toBe(0);

    // Only the literal true counts: a string "true" or a number is a body-validation 422.
    for (const ack of ['true', 1]) {
      expect((await call(owner, 'PATCH', url, { block_external_auto_merge: false, acknowledge_external_risk: ack })).status).toBe(422);
    }
    expect(await settingsOf(repoId)).toEqual({});

    const ok = await call(owner, 'PATCH', url, { block_external_auto_merge: false, acknowledge_external_risk: true });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ auto_merge: false, block_external_auto_merge: false });
    expect(await auditCount(owner.accountId, 'role_settings.guard_changed')).toBe(1);
    expect(await (await call(owner, 'GET', url)).json()).toEqual({ auto_merge: false, block_external_auto_merge: false });

    // Turning the guard back on needs no acknowledgement.
    const on = await call(owner, 'PATCH', url, { block_external_auto_merge: true });
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ auto_merge: false, block_external_auto_merge: true });
    expect(await auditCount(owner.accountId, 'role_settings.guard_changed')).toBe(2);
  });

  it('criterion 4: the settings body is strict -- unknown keys, an empty body, a non-boolean and no body are all 422', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const { repoId } = await seedRepo(owner.accountId, 'team');
    const url = `/repos/${repoId}/settings`;
    for (const body of [{}, { nope: true }, { auto_merge: true, extra: 1 }, { auto_merge: 'yes' }, { acknowledge_external_risk: true }]) {
      expect((await call(owner, 'PATCH', url, body)).status, JSON.stringify(body)).toBe(422);
    }
    expect((await call(owner, 'PATCH', url)).status).toBe(422);
    expect(await settingsOf(repoId)).toEqual({});
    expect(await auditCount(owner.accountId, 'role_settings.guard_changed')).toBe(0);
  });

  it('criterion 5: InvalidRoleSettingsInputError maps to 422 with its field as details.path, never 500', () => {
    const withField = mapError(new InvalidRoleSettingsInputError('bad mode', 'mode'), 'req-1');
    expect(withField.status).toBe(422);
    expect(withField.body).toEqual({
      error: { code: 'invalid_role_settings_input', message: 'bad mode', request_id: 'req-1' },
      details: [{ path: 'mode', code: 'invalid' }],
    });
    expect(mapError(new InvalidRoleSettingsInputError('x'), 'req-2').body.details).toEqual([{ path: '', code: 'invalid' }]);
  });

  it('criterion 6: role mode -- a change returns the role item, writes one audit row, and leaves an existing model alone', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const { repoId } = await seedRepo(owner.accountId, 'team');
    const list = await roles(owner, repoId);
    const target = list.find((r) => r.allowed_modes.length > 1)!;
    const other = target.allowed_modes.find((m) => m !== target.mode)!;
    await admin.query(
      `INSERT INTO role_settings (account_id, repo_id, role, mode, model) VALUES ($1, $2, $3, $4, 'opus-5')`,
      [owner.accountId, repoId, target.role, target.mode],
    );

    const res = await call(owner, 'PATCH', `/repos/${repoId}/roles/${target.role}`, { mode: other });
    expect(res.status).toBe(200);
    const item = (await res.json()) as Role;
    expect(item).toMatchObject({ role: target.role, mode: other, model: 'opus-5', allowed_modes: target.allowed_modes });
    expect(item).toEqual((await roles(owner, repoId)).find((r) => r.role === target.role));
    expect(await auditCount(owner.accountId, 'role_settings.mode_changed')).toBe(1);
    const { rows } = await admin.query<{ model: string }>(`SELECT model FROM role_settings WHERE repo_id = $1 AND role = $2`, [repoId, target.role]);
    expect(rows[0]!.model).toBe('opus-5');
  });

  it('criterion 6: a mode outside allowedModes, both mode and model, an unknown role and an empty body are refused with no write', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const { repoId } = await seedRepo(owner.accountId, 'team');
    const list = await roles(owner, repoId);
    const target = list[0]!;
    const url = `/repos/${repoId}/roles/${target.role}`;

    const bad = await call(owner, 'PATCH', url, { mode: 'not-a-mode' });
    expect(bad.status).toBe(422);
    const err = (await bad.json()) as ErrorBody;
    expect(err.error.code).toBe('invalid_role_settings_input');
    expect(err.details).toEqual([{ path: 'mode', code: 'invalid' }]);

    // A real mode that this particular role does not allow.
    const allModes = new Set(list.flatMap((r) => r.allowed_modes));
    const notAllowed = list.flatMap((r) => [...allModes].filter((m) => !r.allowed_modes.includes(m)).map((m) => ({ r, m })))[0];
    if (notAllowed) {
      expect((await call(owner, 'PATCH', `/repos/${repoId}/roles/${notAllowed.r.role}`, { mode: notAllowed.m })).status).toBe(422);
    }

    expect((await call(owner, 'PATCH', url, { mode: target.mode, model: 'opus-5' })).status).toBe(422);
    expect((await call(owner, 'PATCH', url, {})).status).toBe(422);

    const unknown = await call(owner, 'PATCH', `/repos/${repoId}/roles/no-such-role`, { mode: 'x' });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as ErrorBody).error.code).toBe('not_found');

    const { rows } = await admin.query(`SELECT 1 FROM role_settings WHERE repo_id = $1`, [repoId]);
    expect(rows).toHaveLength(0);
    expect(await auditCount(owner.accountId, 'role_settings.mode_changed')).toBe(0);
  });

  it('criteria 4 and 6: a member session is 403 insufficient_role and a token 403 session_required, changing nothing', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const { repoId } = await seedRepo(owner.accountId, 'team');
    const member = await addMember(owner.accountId, 'member');
    const admin2 = await addMember(owner.accountId, 'admin');
    const token = await tokenFor(owner);
    const target = (await roles(owner, repoId))[0]!;
    const writes: [string, unknown][] = [
      [`/repos/${repoId}/settings`, { block_external_auto_merge: false, acknowledge_external_risk: true }],
      [`/repos/${repoId}/roles/${target.role}`, { mode: target.mode }],
    ];
    for (const [url, body] of writes) {
      const asMember = await call(member, 'PATCH', url, body);
      expect(asMember.status).toBe(403);
      expect(((await asMember.json()) as ErrorBody).error.code).toBe('insufficient_role');
      const asToken = await call(owner, 'PATCH', url, body, token);
      expect(asToken.status).toBe(403);
      expect(((await asToken.json()) as ErrorBody).error.code).toBe('session_required');
    }
    expect(await settingsOf(repoId)).toEqual({});
    expect(await auditCount(owner.accountId, 'role_settings.guard_changed')).toBe(0);
    expect(await auditCount(owner.accountId, 'role_settings.mode_changed')).toBe(0);

    // A member may read; an admin may write.
    expect((await call(member, 'GET', `/repos/${repoId}/settings`)).status).toBe(200);
    expect((await call(admin2, 'PATCH', writes[1]![0], writes[1]![1])).status).toBe(200);
  });

  it('criterion 7: another account\'s repo id is 404 on every route, and a non-uuid id is 404 too', async () => {
    const a = await seedAccountWithMember(admin, { role: 'owner' });
    const b = await seedAccountWithMember(admin, { role: 'owner' });
    const bRepo = await seedRepo(b.accountId, 'team');
    const aRepo = await seedRepo(a.accountId, 'team');
    const role = (await roles(b, bRepo.repoId))[0]!;

    const attempts: [string, string, unknown?][] = [
      ['GET', `/repos/${bRepo.repoId}`],
      ['GET', `/repos/${bRepo.repoId}/settings`],
      ['GET', `/repos/${bRepo.repoId}/roles`],
      ['PATCH', `/repos/${bRepo.repoId}/settings`, { block_external_auto_merge: false, acknowledge_external_risk: true }],
      ['PATCH', `/repos/${bRepo.repoId}/roles/${role.role}`, { mode: role.mode }],
    ];
    for (const [method, url, body] of attempts) {
      const res = await call(a, method, url, body);
      expect(res.status, `${method} ${url}`).toBe(404);
      expect(((await res.json()) as ErrorBody).error.code).toBe('not_found');
      const malformed = await call(a, method, url.replace(bRepo.repoId, 'not-a-uuid'), body);
      expect(malformed.status, `${method} ${url} malformed`).toBe(404);
    }
    // B's data is untouched, and A's list shows only A's repo.
    expect(await settingsOf(bRepo.repoId)).toEqual({});
    expect(await auditCount(b.accountId, 'role_settings.guard_changed')).toBe(0);
    expect(await auditCount(a.accountId, 'role_settings.guard_changed')).toBe(0);
    const listed = (await (await call(a, 'GET', '/repos')).json()) as { data: Item[] };
    expect(listed.data.map((r) => r.id)).toEqual([aRepo.repoId]);
  });
  describe('D#31 API-8b: role model with the H22 floor', () => {
    const rowOf = async (repoId: string, role: string) =>
      (await admin.query<{ mode: string; model: string | null }>(`SELECT mode, model FROM role_settings WHERE repo_id = $1 AND role = $2`, [repoId, role])).rows;
    const modelAudit = async (accountId: string) =>
      (await admin.query<{ payload: { repoId: string; role: string; before: string | null; after: string | null } }>(
        `SELECT payload FROM audit_log WHERE account_id = $1 AND action = 'role_settings.model_changed' ORDER BY created_at`,
        [accountId],
      )).rows.map((r) => r.payload);

    it('criteria 1, 2: set, change and clear a model; one audit row each with before and after; mode of an existing row is kept', async () => {
      const owner = await seedAccountWithMember(admin, { role: 'owner' });
      const { repoId } = await seedRepo(owner.accountId, 'team');
      const target = (await roles(owner, repoId)).find((r) => r.allowed_modes.length > 1 && r.model_floor === null)!;
      const url = `/repos/${repoId}/roles/${target.role}`;

      // No row yet: the insert uses the manifest default mode.
      const first = await call(owner, 'PATCH', url, { model: 'opus-5' });
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ role: target.role, mode: target.mode, model: 'opus-5' });
      expect(await rowOf(repoId, target.role)).toEqual([{ mode: target.mode, model: 'opus-5' }]);

      // Repeat of the same value still audits; a mode change in between is untouched by the next model PATCH.
      const other = target.allowed_modes.find((m) => m !== target.mode)!;
      expect((await call(owner, 'PATCH', url, { mode: other })).status).toBe(200);
      expect((await call(owner, 'PATCH', url, { model: 'opus-5' })).status).toBe(200);
      const cleared = await call(owner, 'PATCH', url, { model: null });
      expect(cleared.status).toBe(200);
      expect(await cleared.json()).toMatchObject({ mode: other, model: null });
      expect(await rowOf(repoId, target.role)).toEqual([{ mode: other, model: null }]);
      expect((await roles(owner, repoId)).find((r) => r.role === target.role)!.model).toBeNull();

      const base = { repoId, role: target.role };
      expect(await modelAudit(owner.accountId)).toEqual([
        { ...base, before: null, after: 'opus-5' },
        { ...base, before: 'opus-5', after: 'opus-5' },
        { ...base, before: 'opus-5', after: null },
      ]);
    });

    it('the spend line in the PATCH answer follows the chosen model and mode, and matches the next read', async () => {
      const owner = await seedAccountWithMember(admin, { role: 'owner' });
      const { repoId } = await seedRepo(owner.accountId, 'team');
      const url = `/repos/${repoId}/roles/code-reviewer`;
      const patch = async (body: unknown) => {
        const res = await call(owner, 'PATCH', url, body);
        expect(res.status).toBe(200);
        return ((await res.json()) as Role).expected_spend as { text: string; monthly_usd: number; runs_per_month: number; median_cost_per_run_usd: number; median_source: string; caveat: string };
      };

      // Follows the live table (code-reviewer: sonnet-5) with no override.
      const followed = await patch({ model: null });
      expect(followed).toMatchObject({ median_cost_per_run_usd: 13, median_source: 'seed' });
      const perModel: Record<string, number> = {};
      for (const model of ['haiku-4.5', 'sonnet-5', 'opus-5']) {
        const spend = await patch({ model });
        perModel[model] = spend.median_cost_per_run_usd;
        expect(spend.median_source).toBe('seed');
        expect(spend.caveat).toContain('estimate based on the selected model');
        expect(spend.text).toBe(`expected spend on your model bill: $${spend.monthly_usd.toFixed(2)}/month`);
        expect(spend.text).not.toMatch(/null|undefined|NaN/);
      }
      expect(perModel).toEqual({ 'haiku-4.5': 3.5, 'sonnet-5': 13, 'opus-5': 31 });

      // A mode change moves runs per month and so the monthly figure; the model figure stays.
      const modeUrl = `/repos/${repoId}/roles/security-reviewer`;
      const patchMode = async (mode: string) => {
        const res = await call(owner, 'PATCH', modeUrl, { mode });
        expect(res.status).toBe(200);
        return ((await res.json()) as Role).expected_spend as { monthly_usd: number; runs_per_month: number; median_cost_per_run_usd: number };
      };
      const featureCritical = await patchMode('feature_critical');
      const always = await patchMode('always');
      expect(always.runs_per_month).toBeGreaterThan(featureCritical.runs_per_month);
      expect(always.monthly_usd).toBeGreaterThan(featureCritical.monthly_usd);
      expect(always.median_cost_per_run_usd).toBe(featureCritical.median_cost_per_run_usd);

      // What the PATCH answered is what the next read says.
      expect((await roles(owner, repoId)).find((r) => r.role === 'security-reviewer')!.expected_spend).toEqual(always);
    });

    it('a floored role follows the table at opus-5 until a model is chosen, and its figure moves with the choice', async () => {
      const owner = await seedAccountWithMember(admin, { role: 'owner' });
      const { repoId } = await seedRepo(owner.accountId, 'team');
      const url = `/repos/${repoId}/roles/security-reviewer`;
      const before = (await roles(owner, repoId)).find((r) => r.role === 'security-reviewer')!;
      expect(before.expected_spend.median_cost_per_run_usd).toBe(31);
      const res = await call(owner, 'PATCH', url, { model: 'sonnet-5' });
      expect(((await res.json()) as Role).expected_spend.median_cost_per_run_usd).toBe(13);
      // Below the floor is refused, and the figure stays where it was.
      expect((await call(owner, 'PATCH', url, { model: 'haiku-4.5' })).status).toBe(422);
      expect((await roles(owner, repoId)).find((r) => r.role === 'security-reviewer')!.expected_spend.median_cost_per_run_usd).toBe(13);
    });

    it('a change to the live routing table reaches GET and PATCH: a role with no override is priced on its new table model', async () => {
      const owner = await seedAccountWithMember(admin, { role: 'owner' });
      const { repoId } = await seedRepo(owner.accountId, 'team');
      const setRow = (role: string, model: string) =>
        platformOpsPool.query(
          `UPDATE routing_rows SET model = $2 WHERE role = $1 AND size = 'Feature' AND table_version = (SELECT version FROM routing_tables WHERE status = 'live')`,
          [role, model],
        );
      const per = (list: Role[], role: string) => list.find((r) => r.role === role)!.expected_spend.median_cost_per_run_usd;
      const before = await roles(owner, repoId);
      expect([per(before, 'code-reviewer'), per(before, 'security-reviewer')]).toEqual([13, 31]);
      try {
        // code-reviewer: sonnet-5 -> opus-5. security-reviewer (floored): opus-5 -> sonnet-5, still at its floor.
        await setRow('code-reviewer', 'opus-5');
        await setRow('security-reviewer', 'sonnet-5');
        const read = await roles(owner, repoId);
        expect([per(read, 'code-reviewer'), per(read, 'security-reviewer')]).toEqual([31, 13]);
        // PATCH answers price the table model too: a mode change leaves the model alone.
        const res = await call(owner, 'PATCH', `/repos/${repoId}/roles/code-reviewer`, { mode: 'always' });
        expect(((await res.json()) as Role).expected_spend.median_cost_per_run_usd).toBe(31);
        const res2 = await call(owner, 'PATCH', `/repos/${repoId}/roles/security-reviewer`, { mode: 'always' });
        expect(((await res2.json()) as Role).expected_spend.median_cost_per_run_usd).toBe(13);
        // An override still wins over the table.
        const res3 = await call(owner, 'PATCH', `/repos/${repoId}/roles/code-reviewer`, { model: 'haiku-4.5' });
        expect(((await res3.json()) as Role).expected_spend.median_cost_per_run_usd).toBe(3.5);
      } finally {
        await setRow('code-reviewer', 'sonnet-5');
        await setRow('security-reviewer', 'opus-5');
      }
    });

    it('criterion 1: anything outside the three ids, or both keys, or neither, is 422 with no write', async () => {
      const owner = await seedAccountWithMember(admin, { role: 'owner' });
      const { repoId } = await seedRepo(owner.accountId, 'team');
      const role = (await roles(owner, repoId))[0]!;
      const url = `/repos/${repoId}/roles/${role.role}`;
      for (const body of [{ model: 'gpt-5' }, { model: '' }, { model: 5 }, { model: true }, { model: 'opus-5', mode: role.mode }, {}]) {
        const res = await call(owner, 'PATCH', url, body);
        expect(res.status, JSON.stringify(body)).toBe(422);
      }
      const bad = (await (await call(owner, 'PATCH', url, { model: 'gpt-5' })).json()) as ErrorBody;
      expect(bad.details).toEqual([{ path: 'model', code: 'invalid' }]);
      expect(await rowOf(repoId, role.role)).toEqual([]);
      expect(await modelAudit(owner.accountId)).toEqual([]);
    });

    // The refusal here comes from setRoleModel's ROLE_MODEL_IDS check (only the
    // three exact ids pass), not from the floor allowlist: this pins that no
    // alias, variant or look-alike id reaches role_settings for a floored role.
    it('floored roles: alias, variant and look-alike model ids are 422 with role_settings and audit_log unchanged', async () => {
      const owner = await seedAccountWithMember(admin, { role: 'owner' });
      const { repoId } = await seedRepo(owner.accountId, 'team');
      const auditRows = async () =>
        (await admin.query(`SELECT id FROM audit_log WHERE account_id = $1 ORDER BY id`, [owner.accountId])).rows;
      const ids = [
        'openrouter/auto', 'sonnet', 'claude-x:floor', 'sonnet-5:floor', 'sonnet-5 ', 'Sonnet-5',
        'sonnet‑5', // non-breaking hyphen
        'sonnet-5'.replace('o', 'о'), // Cyrillic o
        'auto', 'gpt-6',
      ];
      for (const role of ['security-reviewer', 'security-expert']) {
        const before = await auditRows();
        for (const model of ids) {
          const res = await call(owner, 'PATCH', `/repos/${repoId}/roles/${role}`, { model });
          expect(res.status, `${role} ${JSON.stringify(model)}`).toBe(422);
        }
        expect(await rowOf(repoId, role)).toEqual([]);
        expect(await auditRows()).toEqual(before);
      }
    });

    it('criterion 3: the floored roles refuse haiku-4.5 (422, path model) and accept sonnet-5 and opus-5; others accept haiku', async () => {
      const owner = await seedAccountWithMember(admin, { role: 'owner' });
      const { repoId } = await seedRepo(owner.accountId, 'team');
      const list = await roles(owner, repoId);
      expect(list.filter((r) => r.model_floor !== null).map((r) => [r.role, r.model_floor]).sort()).toEqual([
        ['security-expert', 'sonnet-5'],
        ['security-reviewer', 'sonnet-5'],
      ]);
      expect(list.filter((r) => r.model_floor === null)).toHaveLength(list.length - 2);

      for (const role of ['security-reviewer', 'security-expert']) {
        const url = `/repos/${repoId}/roles/${role}`;
        const res = await call(owner, 'PATCH', url, { model: 'haiku-4.5' });
        expect(res.status).toBe(422);
        expect(((await res.json()) as ErrorBody).details).toEqual([{ path: 'model', code: 'invalid' }]);
        expect(await rowOf(repoId, role)).toEqual([]);
        expect((await modelAudit(owner.accountId)).filter((a) => a.role === role)).toEqual([]);
        expect((await call(owner, 'PATCH', url, { model: 'sonnet-5' })).status).toBe(200);
        expect((await call(owner, 'PATCH', url, { model: 'opus-5' })).status).toBe(200);
        // Below the floor once a row exists: still refused, row unchanged.
        expect((await call(owner, 'PATCH', url, { model: 'haiku-4.5' })).status).toBe(422);
        expect(await rowOf(repoId, role)).toMatchObject([{ model: 'opus-5' }]);
      }
      const free = list.find((r) => r.model_floor === null)!;
      expect((await call(owner, 'PATCH', `/repos/${repoId}/roles/${free.role}`, { model: 'haiku-4.5' })).status).toBe(200);
      // The read says the same thing the PATCH just did.
      for (const r of list) {
        expect(r.allowed_models, r.role).toEqual(r.model_floor === null ? ['haiku-4.5', 'sonnet-5', 'opus-5'] : ['sonnet-5', 'opus-5']);
      }
    });

    it('criterion 3: a below-floor write that skips the route is refused by the database CHECK', async () => {
      const owner = await seedAccountWithMember(admin, { role: 'owner' });
      const { repoId } = await seedRepo(owner.accountId, 'team');
      const { setRoleModel } = await import('@fx/core/src/role-settings/setModel.js');
      // The core service has no floor of its own; the CHECK is what refuses this.
      await expect(
        setRoleModel({ pool: appUserPool, principal: owner }, { repoId, role: 'security-reviewer', model: 'haiku-4.5' }),
      ).rejects.toMatchObject({ code: '23514' });
      expect(await rowOf(repoId, 'security-reviewer')).toEqual([]);
      expect(await modelAudit(owner.accountId)).toEqual([]);
    });

    it('criterion 4: member 403, token 403 session_required, another account 404, unknown role 404 -- no row, no audit', async () => {
      const owner = await seedAccountWithMember(admin, { role: 'owner' });
      const other = await seedAccountWithMember(admin, { role: 'owner' });
      const { repoId } = await seedRepo(owner.accountId, 'team');
      const member = await addMember(owner.accountId, 'member');
      const token = await tokenFor(owner);
      const role = (await roles(owner, repoId))[0]!.role;
      const url = `/repos/${repoId}/roles/${role}`;

      const asMember = await call(member, 'PATCH', url, { model: 'opus-5' });
      expect(asMember.status).toBe(403);
      expect(((await asMember.json()) as ErrorBody).error.code).toBe('insufficient_role');
      const asToken = await call(owner, 'PATCH', url, { model: 'opus-5' }, token);
      expect(asToken.status).toBe(403);
      expect(((await asToken.json()) as ErrorBody).error.code).toBe('session_required');
      // A below-floor model from a member is still a 403, not a 422.
      expect((await call(member, 'PATCH', `/repos/${repoId}/roles/security-reviewer`, { model: 'haiku-4.5' })).status).toBe(403);

      expect((await call(other, 'PATCH', url, { model: 'opus-5' })).status).toBe(404);
      expect((await call(owner, 'PATCH', `/repos/${repoId}/roles/no-such-role`, { model: 'opus-5' })).status).toBe(404);
      expect(await rowOf(repoId, role)).toEqual([]);
      expect(await modelAudit(owner.accountId)).toEqual([]);
      expect(await modelAudit(other.accountId)).toEqual([]);
    });

    it('criterion 4: concurrent model PATCHes and a concurrent mode PATCH lose no audit row and chain before/after', async () => {
      const owner = await seedAccountWithMember(admin, { role: 'owner' });
      const { repoId } = await seedRepo(owner.accountId, 'team');
      const target = (await roles(owner, repoId)).find((r) => r.allowed_modes.length > 1 && r.model_floor === null)!;
      const other = target.allowed_modes.find((m) => m !== target.mode)!;
      const url = `/repos/${repoId}/roles/${target.role}`;
      const results = await Promise.all([
        call(owner, 'PATCH', url, { model: 'sonnet-5' }),
        call(owner, 'PATCH', url, { model: 'opus-5' }),
        call(owner, 'PATCH', url, { mode: other }),
        call(owner, 'PATCH', url, { model: 'haiku-4.5' }),
      ]);
      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
      expect(await auditCount(owner.accountId, 'role_settings.mode_changed')).toBe(1);
      const audits = await modelAudit(owner.accountId);
      expect(audits).toHaveLength(3);
      // The chain is unbroken: each before is the previous after, starting from null and ending at the stored value.
      const byBefore = new Map(audits.map((a) => [a.before, a]));
      expect(byBefore.size).toBe(3);
      let cur = null as string | null;
      for (let i = 0; i < 3; i++) {
        const step = byBefore.get(cur);
        expect(step).toBeDefined();
        cur = step!.after;
      }
      expect((await rowOf(repoId, target.role))[0]).toEqual({ mode: other, model: cur });
    });
  });
});
