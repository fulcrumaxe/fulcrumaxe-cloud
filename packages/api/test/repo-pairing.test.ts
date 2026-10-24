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
import { repoPairingDeps, type PairingRepoInspector } from '../src/routes/repoPairing.js';
import { createTeamInstallationOwnership } from '../../github/src/teamInstallationOwnership.js';
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
  pr_footer: string | null;
  code_repo_app_installed: boolean | null;
}
interface ErrorBody {
  error: { code: string };
  details?: { path: string; code: string }[];
  data?: { branch: string | null };
}
/** The audit row keeps the stored settings only: the live install state is read from GitHub, never stored. */
const withoutLive = ({ code_repo_app_installed, ...rest }: Pairing): Omit<Pairing, 'code_repo_app_installed'> => (void code_repo_app_installed, rest);
/** What GitHub (and our rows) say about one repo: its visibility and default branch, and whose installation of the write App serves it ('caller' = the asker's own). */
type World = { visibility: 'public' | 'not_public'; defaultBranch: string | null; install: 'caller' | number | null } | 'unavailable' | 'not_configured' | 'renamed' | 'unusable';

const OFF: Pairing = { enabled: false, code_repo: null, overlay_globs: [], identifier_rules_path: null, plan_data_rules_path: null, pr_footer: null, code_repo_app_installed: null };
/** What the world holds for a repo no test spoke of: public, default branch main, the caller's own App installed. */
const PLAIN = { visibility: 'public', defaultBranch: 'main', install: 'caller' } as const;
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

  const facts = new Map<string, World>();
  /** Every question the fake was asked, in order: `lookup <name>` first (as the real reader does), then `read <name>` with `+hint` when a stored installation was given. */
  const asked: string[] = [];
  const failure = (code: string) => Object.assign(new Error(`publicRepoInspect: ${code}`), { name: 'PublicRepoInspectError', code });
  /** The production ownership rule, against the real tables (own account, `team`, live installer record). */
  const owns = (accountId: string, gh: number): Promise<boolean> => createTeamInstallationOwnership(platformOpsPool)(accountId, gh);
  /** The same sequence the real reader runs: the installation lookup first, ownership from our rows, then the read; a repo that is not public reads the same whoever has it installed. */
  const fake: PairingRepoInspector = {
    async inspect(name, accountId, opts) {
      asked.push(`lookup ${name}`);
      if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(name)) throw failure('github_unavailable');
      const w = facts.get(name.toLowerCase()) ?? PLAIN;
      if (w === 'unavailable') throw failure('github_unavailable');
      if (w === 'not_configured') throw failure('not_configured');
      if (w === 'renamed') throw failure('repo_renamed');
      // GitHub refuses the mint from a stored installation (suspended or gone): only a read through a stored installation can hit it.
      if (w === 'unusable') {
        if (opts?.hint) throw failure('installation_unusable');
        return { visibility: 'public', defaultBranch: 'main', appInstalled: false };
      }
      const owned = w.install === 'caller' || (typeof w.install === 'number' && (await owns(accountId, w.install)));
      asked.push(`read ${name}${opts?.hint ? '+hint' : ''}`);
      if (opts?.signal) asked.push(`deadline ${name}`);
      if (w.visibility !== 'public') return { visibility: 'not_public', defaultBranch: null, appInstalled: false };
      return { visibility: 'public', defaultBranch: w.defaultBranch, appInstalled: owned };
    },
  };

  beforeAll(async () => {
    repoPairingDeps.getInspector = () => fake;
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = 's'.repeat(32);
  });

  afterAll(async () => {
    repoPairingDeps.getInspector = () => null;
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
    const expected: Pairing = { enabled: true, ...GOOD, identifier_rules_path: null, plan_data_rules_path: null, pr_footer: null, code_repo_app_installed: true };
    expect(await res.json()).toEqual(expected);
    expect(await get(owner, repoId)).toEqual(expected);
    const stored = withoutLive(expected);
    const storedOff = withoutLive(OFF);
    expect(await audits(owner.accountId)).toEqual([{ action: 'repo_pairing.set', payload: { repo_id: repoId, before: storedOff, after: stored } }]);
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
    const expected: Pairing = { enabled: true, ...second, identifier_rules_path: null, plan_data_rules_path: null, pr_footer: null, code_repo_app_installed: true };
    expect(await get(owner, repoId)).toEqual(expected);
    const log = await audits(owner.accountId);
    expect(log.map((l) => l.action)).toEqual(['repo_pairing.set', 'repo_pairing.set']);
    expect(log[1]!.payload.before).toMatchObject({ code_repo: 'acme/widgets-public', identifier_rules_path: 'rules/identifiers.txt' });
    expect(log[1]!.payload.after).toEqual(withoutLive(expected));
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
      ['an unknown footer placeholder', { ...GOOD, pr_footer: 'Refs D#{discussion}' }, 'pr_footer'],
      ['a footer over 200 characters', { ...GOOD, pr_footer: 'x'.repeat(201) }, 'pr_footer'],
      ['a two-line footer', { ...GOOD, pr_footer: 'a\nb' }, 'pr_footer'],
      ['a footer link to another site', { ...GOOD, pr_footer: 'see https://example.com/x' }, 'pr_footer'],
      ['a footer link to the private repo', { ...GOOD, pr_footer: 'see https://github.com/acme/widgets' }, 'pr_footer'],
      ['a footer with a mention', { ...GOOD, pr_footer: 'cc @someone' }, 'pr_footer'],
      ['a footer holding a token', { ...GOOD, pr_footer: 'key ghp_abcdefghijklmnopqrstuvwxyz0123' }, 'pr_footer'],
      ['a footer holding a long opaque string', { ...GOOD, pr_footer: 'x ' + 'Ab3'.repeat(12) }, 'pr_footer'],
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

  it('stores a footer template, returns it, audits it, and clears it with null, empty text or an omitted field (a replace)', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const repoId = await seedRepo(owner.accountId, { owner: 'acme', name: 'widgets' });
    const url = `/repos/${repoId}/pairing`;
    for (const footer of ['Refs D#6', 'Refs D#{issue_number} run {run_id}', 'See https://github.com/acme/widgets-public/issues/1']) {
      const res = await call(owner, 'PUT', url, { ...GOOD, pr_footer: footer });
      expect(res.status, footer).toBe(200);
      expect(((await res.json()) as Pairing).pr_footer).toBe(footer);
      expect((await get(owner, repoId)).pr_footer).toBe(footer);
    }
    const log = await audits(owner.accountId);
    expect(log[log.length - 1]!.payload.after).toMatchObject({ pr_footer: 'See https://github.com/acme/widgets-public/issues/1' });
    for (const cleared of [{ pr_footer: null }, { pr_footer: '' }, { pr_footer: '   ' }, {}]) {
      await call(owner, 'PUT', url, { ...GOOD, pr_footer: 'Refs D#6' });
      const res = await call(owner, 'PUT', url, { ...GOOD, ...cleared });
      expect(res.status, JSON.stringify(cleared)).toBe(200);
      expect(((await res.json()) as Pairing).pr_footer, JSON.stringify(cleared)).toBeNull();
      expect((await admin.query(`SELECT pr_footer FROM repo_pairing WHERE repo_id = $1`, [repoId])).rows[0].pr_footer).toBeNull();
    }
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

  describe('the public repo checks (not public, default branch, install state, picker)', () => {
    const url = (repoId: string) => `/repos/${repoId}/pairing`;
    const put = async (who: Identity, repoId: string, body: unknown = GOOD) => call(who, 'PUT', url(repoId), body);
    const errorOf = async (res: Response) => (await res.json()) as ErrorBody;
    /** A write-App installation of the account, with the installer record production keeps for it (live, deleted or suspended; none when false). */
    const installTeam = async (accountId: string, installer: true | false | 'deleted' | 'suspended' = true, kind: 'team' | 'team_readonly' = 'team'): Promise<number> => {
      const gh = Math.floor(Math.random() * 1e9) + 1;
      await admin.query(`INSERT INTO installations (account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3)`, [accountId, gh, kind]);
      if (installer) {
        await admin.query(`INSERT INTO installation_installers (gh_installation_id, app_kind, installer_gh_user_id, deleted_at, suspended_at) VALUES ($1, $2, 1, $3, $4)`, [
          gh, kind, installer === 'deleted' ? new Date() : null, installer === 'suspended' ? new Date() : null,
        ]);
      }
      return gh;
    };

    it('refuses a public repo whose default branch is not main, naming the branch, and writes and audits nothing', async () => {
      const owner = await seedAccountWithMember(admin, { role: 'owner' });
      const repoId = await seedRepo(owner.accountId, { owner: 'acme', name: 'widgets' });
      facts.set('acme/widgets-public', { ...PLAIN, defaultBranch: 'master' });
      const res = await put(owner, repoId);
      expect(res.status).toBe(422);
      const err = await errorOf(res);
      expect(err.error.code).toBe('public_default_branch_not_main');
      expect(err.details).toEqual([{ path: 'code_repo', code: 'default_branch_not_main' }]);
      expect(err.data).toEqual({ branch: 'master' });
      // A default branch that is not a plain name reads as null, which is never main.
      facts.set('acme/widgets-public', { ...PLAIN, defaultBranch: null });
      const odd = await put(owner, repoId);
      expect(odd.status).toBe(422);
      expect((await errorOf(odd)).data).toEqual({ branch: null });
      expect(await rowCount(repoId)).toBe(0);
      expect(await audits(owner.accountId)).toEqual([]);
      facts.set('acme/widgets-public', PLAIN);
      expect((await put(owner, repoId)).status).toBe(200);
    });

    it('refuses a repo that is not public with one code, the same for a private name, a missing one and one installed under another account; nothing leaks about the installation', async () => {
      const owner = await seedAccountWithMember(admin, { role: 'owner' });
      const other = await seedAccountWithMember(admin, { role: 'owner' });
      const otherGh = await installTeam(other.accountId);
      const repoId = await seedRepo(owner.accountId, { owner: 'acme', name: 'widgets' });
      const bodies: string[] = [];
      for (const [label, world] of [
        ['a private repo nobody has installed', { visibility: 'not_public', defaultBranch: null, install: null }],
        ['a private repo installed under another account', { visibility: 'not_public', defaultBranch: null, install: otherGh }],
        ['a private repo installed under the caller', { visibility: 'not_public', defaultBranch: null, install: 'caller' }],
        ['a missing repo', { visibility: 'not_public', defaultBranch: null, install: null }],
      ] as const) {
        facts.set('acme/widgets-public', world);
        const res = await put(owner, repoId);
        expect(res.status, label).toBe(422);
        const err = await errorOf(res);
        expect(err.error.code, label).toBe('code_repo_not_public');
        expect(err.details, label).toEqual([{ path: 'code_repo', code: 'not_public' }]);
        bodies.push(JSON.stringify({ ...err, error: { ...err.error, request_id: '-' } }));
      }
      expect(new Set(bodies).size).toBe(1);
      expect(await rowCount(repoId)).toBe(0);
      expect(await audits(owner.accountId)).toEqual([]);
    });

    it('reports installed only for the caller\'s own write-App installation; a public repo installed under another account reads false', async () => {
      const owner = await seedAccountWithMember(admin, { role: 'owner' });
      const other = await seedAccountWithMember(admin, { role: 'owner' });
      const otherGh = await installTeam(other.accountId);
      const ownGh = await installTeam(owner.accountId);
      const repoId = await seedRepo(owner.accountId, { owner: 'acme', name: 'widgets' });
      facts.set('acme/widgets-public', { ...PLAIN, install: otherGh });
      const saved = (await (await put(owner, repoId)).json()) as Pairing;
      expect(saved.code_repo_app_installed).toBe(false);
      expect((await get(owner, repoId)).code_repo_app_installed).toBe(false);
      // The other account's own view of the same GitHub state is true: only whose rows hold the installation differs.
      const otherRepo = await seedRepo(other.accountId, { owner: 'acme', name: 'elsewhere' });
      expect(((await (await put(other, otherRepo)).json()) as Pairing).code_repo_app_installed).toBe(true);
      // Installed under the caller's own account: true; not installed anywhere: false.
      facts.set('acme/widgets-public', { ...PLAIN, install: ownGh });
      expect((await get(owner, repoId)).code_repo_app_installed).toBe(true);
      facts.set('acme/widgets-public', { ...PLAIN, install: null });
      expect((await get(owner, repoId)).code_repo_app_installed).toBe(false);
      // An installation whose row is not a team one does not count.
      const ro = await installTeam(owner.accountId, true, 'team_readonly');
      facts.set('acme/widgets-public', { ...PLAIN, install: ro });
      expect((await get(owner, repoId)).code_repo_app_installed).toBe(false);
      facts.clear();
    });

    it("an installation whose installer record is suspended, deleted or missing is not the caller's: the route reads false for each", async () => {
      const owner = await seedAccountWithMember(admin, { role: 'owner' });
      const repoId = await seedRepo(owner.accountId, { owner: 'acme', name: 'widgets' });
      expect((await put(owner, repoId)).status).toBe(200);
      for (const installer of [false, 'deleted', 'suspended'] as const) {
        facts.set('acme/widgets-public', { ...PLAIN, install: await installTeam(owner.accountId, installer) });
        expect((await get(owner, repoId)).code_repo_app_installed, String(installer)).toBe(false);
        expect(((await (await put(owner, repoId)).json()) as Pairing).code_repo_app_installed, String(installer)).toBe(false);
      }
      facts.set('acme/widgets-public', { ...PLAIN, install: await installTeam(owner.accountId) });
      expect((await get(owner, repoId)).code_repo_app_installed).toBe(true);
      facts.clear();
    });

    it('an old row that points at a repo that is no longer public reads null, not true or false; it stays null when off', async () => {
      const owner = await seedAccountWithMember(admin, { role: 'owner' });
      const member = await addMember(owner.accountId, 'member');
      const repoId = await seedRepo(owner.accountId, { owner: 'acme', name: 'widgets' });
      expect((await get(owner, repoId)).code_repo_app_installed).toBeNull();
      expect((await put(owner, repoId)).status).toBe(200);
      facts.set('acme/widgets-public', { visibility: 'not_public', defaultBranch: null, install: 'caller' });
      expect((await get(owner, repoId)).code_repo_app_installed).toBeNull();
      expect((await get(member, repoId)).code_repo_app_installed).toBeNull();
      facts.clear();
    });

    it('GitHub failing, a renamed repo or an App that is not configured never fails a read: the install state is null', async () => {
      const owner = await seedAccountWithMember(admin, { role: 'owner' });
      const repoId = await seedRepo(owner.accountId, { owner: 'acme', name: 'widgets' });
      expect((await put(owner, repoId)).status).toBe(200);
      for (const f of ['unavailable', 'not_configured', 'renamed'] as const) {
        facts.set('acme/widgets-public', f);
        const res = await call(owner, 'GET', url(repoId));
        expect(res.status, f).toBe(200);
        expect(((await res.json()) as Pairing).code_repo_app_installed, f).toBeNull();
      }
      repoPairingDeps.getInspector = () => null;
      try {
        expect((await get(owner, repoId)).code_repo_app_installed).toBeNull();
      } finally {
        repoPairingDeps.getInspector = () => fake;
        facts.clear();
      }
    });

    it('fails closed when the repo cannot be checked, and names a renamed repo: nothing written, nothing audited', async () => {
      const owner = await seedAccountWithMember(admin, { role: 'owner' });
      const repoId = await seedRepo(owner.accountId, { owner: 'acme', name: 'widgets' });
      const cases: Array<[World, number, string]> = [
        ['unavailable', 503, 'github_unavailable'],
        ['not_configured', 503, 'github_app_not_configured'],
        ['renamed', 422, 'code_repo_renamed'],
      ];
      for (const [world, status, code] of cases) {
        facts.set('acme/widgets-public', world);
        const res = await put(owner, repoId);
        expect(res.status, code).toBe(status);
        const err = await errorOf(res);
        expect(err.error.code).toBe(code);
        if (code === 'code_repo_renamed') expect(err.details).toEqual([{ path: 'code_repo', code: 'renamed' }]);
      }
      repoPairingDeps.getInspector = () => null;
      try {
        expect((await put(owner, repoId)).status).toBe(503);
      } finally {
        repoPairingDeps.getInspector = () => fake;
        facts.clear();
      }
      expect(await rowCount(repoId)).toBe(0);
      expect(await audits(owner.accountId)).toEqual([]);
    });

    it("asks GitHub nothing for a bad shape, another account's repo, a member or a token", async () => {
      const a = await seedAccountWithMember(admin, { role: 'owner' });
      const b = await seedAccountWithMember(admin, { role: 'owner' });
      const aRepo = await seedRepo(a.accountId, { owner: 'acme', name: 'widgets' });
      const bRepo = await seedRepo(b.accountId);
      const member = await addMember(a.accountId, 'member');
      const token = await tokenFor(a);
      asked.length = 0;
      expect((await put(a, aRepo, { ...GOOD, overlay_globs: [] })).status).toBe(422);
      expect((await put(a, bRepo)).status).toBe(404);
      expect((await put(a, 'not-a-uuid')).status).toBe(404);
      expect((await put(member, aRepo)).status).toBe(403);
      expect((await call(a, 'PUT', url(aRepo), GOOD, token)).status).toBe(403);
      expect((await call(member, 'GET', `${url(aRepo)}/candidates`)).status).toBe(403);
      expect((await call(a, 'GET', `${url(aRepo)}/candidates`, undefined, token)).status).toBe(403);
      expect((await call(a, 'GET', `${url(bRepo)}/candidates`)).status).toBe(404);
      expect(asked).toEqual([]);
    });

    describe('the picker', () => {
      async function seedInstalled(accountId: string, names: [string, string][], kind: 'team' | 'team_readonly' = 'team'): Promise<number> {
        const gh = Math.floor(Math.random() * 1e9) + 1;
        const { rows: inst } = await admin.query<{ id: string }>(`INSERT INTO installations (account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3) RETURNING id`, [accountId, gh, kind]);
        for (const [o, n] of names) {
          await admin.query(`INSERT INTO repos (account_id, gh_repo_id, product, gh_owner, gh_name, installation_id) VALUES ($1, $2, 'web', $3, $4, $5)`, [accountId, Math.floor(Math.random() * 1e9), o, n, inst[0]!.id]);
        }
        return gh;
      }

      it("lists the account's other installed repos that are public, with default branch and the caller's own install state, and no private one", async () => {
        const owner = await seedAccountWithMember(admin, { role: 'owner' });
        const other = await seedAccountWithMember(admin, { role: 'owner' });
        const repoId = await seedRepo(owner.accountId, { owner: 'acme', name: 'widgets' });
        await seedInstalled(owner.accountId, [['acme', 'site'], ['acme', 'docs'], ['acme', 'secret'], ['acme', 'Widgets']]);
        // Installed through the read-only App only: still a candidate, read through its stored installation, and not "installed" for pairing.
        await seedInstalled(owner.accountId, [['acme', 'viewer']], 'team_readonly');
        // A repo with no installation, and another account's installed repo, are never candidates.
        await seedRepo(owner.accountId, { owner: 'acme', name: 'not-installed' });
        const otherGh = await seedInstalled(other.accountId, [['rival', 'theirs']]);
        facts.set('acme/docs', { ...PLAIN, defaultBranch: 'master', install: null });
        facts.set('acme/secret', { visibility: 'not_public', defaultBranch: null, install: 'caller' });
        facts.set('acme/viewer', { ...PLAIN, install: otherGh });
        asked.length = 0;
        const res = await call(owner, 'GET', `${url(repoId)}/candidates`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          data: [
            { full_name: 'acme/docs', visibility: 'public', default_branch: 'master', app_installed: false },
            { full_name: 'acme/site', visibility: 'public', default_branch: 'main', app_installed: true },
            { full_name: 'acme/viewer', visibility: 'public', default_branch: 'main', app_installed: false },
          ],
          truncated: false,
        });
        // Every candidate was read with the installation our own rows hold for it, never anonymously.
        expect(asked.filter((q) => q.startsWith('read '))).toHaveLength(4);
        expect(asked.filter((q) => q.startsWith('read ')).every((q) => q.endsWith('+hint'))).toBe(true);
        // And all of them under the picker's one deadline.
        expect(asked.filter((q) => q.startsWith('deadline '))).toHaveLength(4);
        facts.clear();
      });

      it('leaves out a candidate whose stored installation is suspended or gone and lists the live ones; a 5xx on a mint still fails the list', async () => {
        const owner = await seedAccountWithMember(admin, { role: 'owner' });
        const repoId = await seedRepo(owner.accountId, { owner: 'acme', name: 'widgets' });
        await seedInstalled(owner.accountId, [['acme', 'live-one'], ['acme', 'live-two']]);
        await seedInstalled(owner.accountId, [['acme', 'suspended']], 'team_readonly');
        facts.set('acme/suspended', 'unusable');
        const res = await call(owner, 'GET', `${url(repoId)}/candidates`);
        expect(res.status).toBe(200);
        expect(((await res.json()) as { data: { full_name: string }[] }).data.map((d) => d.full_name)).toEqual(['acme/live-one', 'acme/live-two']);
        facts.set('acme/live-two', 'unavailable');
        expect((await call(owner, 'GET', `${url(repoId)}/candidates`)).status).toBe(503);
        facts.clear();
      });

      it('lists a repo on both Apps once', async () => {
        const owner = await seedAccountWithMember(admin, { role: 'owner' });
        const repoId = await seedRepo(owner.accountId, { owner: 'acme', name: 'widgets' });
        await seedInstalled(owner.accountId, [['acme', 'site']], 'team_readonly');
        await seedInstalled(owner.accountId, [['acme', 'site']]);
        const body = (await (await call(owner, 'GET', `${url(repoId)}/candidates`)).json()) as { data: unknown[] };
        expect(body.data).toHaveLength(1);
      });

      it('leaves out a stored name GitHub says was renamed; one other GitHub failure fails the whole list with a fixed 503', async () => {
        const owner = await seedAccountWithMember(admin, { role: 'owner' });
        const repoId = await seedRepo(owner.accountId, { owner: 'acme', name: 'widgets' });
        await seedInstalled(owner.accountId, [['acme', 'old-name'], ['acme', 'kept']]);
        facts.set('acme/old-name', 'renamed');
        const ok = (await (await call(owner, 'GET', `${url(repoId)}/candidates`)).json()) as { data: { full_name: string }[] };
        expect(ok.data.map((d) => d.full_name)).toEqual(['acme/kept']);
        facts.set('acme/kept', 'unavailable');
        const down = await call(owner, 'GET', `${url(repoId)}/candidates`);
        expect(down.status).toBe(503);
        expect((await errorOf(down)).error.code).toBe('github_unavailable');
        facts.clear();
      });

      it('looks at no more than 30 repos and says so', async () => {
        const owner = await seedAccountWithMember(admin, { role: 'owner' });
        const repoId = await seedRepo(owner.accountId, { owner: 'acme', name: 'widgets' });
        await seedInstalled(owner.accountId, Array.from({ length: 31 }, (_, i) => ['acme', `r${String(i).padStart(2, '0')}`] as [string, string]));
        asked.length = 0;
        const body = (await (await call(owner, 'GET', `${url(repoId)}/candidates`)).json()) as { data: unknown[]; truncated: boolean };
        expect(body.data).toHaveLength(30);
        expect(body.truncated).toBe(true);
        expect(asked.filter((q) => q.startsWith('lookup '))).toHaveLength(30);
      });

      it('has its own limit of 6 a minute per account, apart from the pairing routes', async () => {
        const owner = await seedAccountWithMember(admin, { role: 'owner' });
        const repoId = await seedRepo(owner.accountId, { owner: 'acme', name: 'widgets' });
        for (let i = 0; i < 6; i++) expect((await call(owner, 'GET', `${url(repoId)}/candidates`)).status, `call ${i + 1}`).toBe(200);
        const over = await call(owner, 'GET', `${url(repoId)}/candidates`);
        expect(over.status).toBe(429);
        expect(over.headers.get('retry-after')).not.toBeNull();
        expect((await get(owner, repoId)).enabled).toBe(false);
      });
    });
  });
});
