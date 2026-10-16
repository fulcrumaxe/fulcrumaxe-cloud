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
import { mapWriteError } from '../src/routes/action-rules.js';
import { ApiError } from '../src/errors.js';
import { ActionRulesError } from '@fx/db/src/actionRules.js';
import { seedAccountWithMember, seedUser } from './helpers/seed.js';

interface Identity {
  accountId: string;
  userId: string;
}
interface Rules {
  repo_id: string | null;
  source: 'repo' | 'account' | 'none';
  version: number;
  rules: { rules: unknown[] };
  history: { version: number; rule_count: number; rules_sha256: string; restored_from_version: number | null; author_name: string; created_at: string }[];
}
interface ErrorBody {
  error: { code: string };
  details?: { path: string; code: string }[];
}

const rule = (id: string, outcome: 'approve' | 'deny' | 'ask' = 'ask', tool = 'run') => ({ id, outcome, when: { op: 'equals', field: '/request/tool', value: tool } });
const body = (...rules: unknown[]) => ({ rules: { rules } });

/**
 * D#7 AAP-a2: the approval rules routes, called through the real `handleApiRequest` against real Postgres (RLS, the owner/admin INSERT
 * policy, the next-version trigger, the audit door). Nothing here stubs a database answer.
 */
describe('D#7 AAP-a2: action rules routes', () => {
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

  async function call(identity: Identity, method: string, urlPath: string, payload?: unknown, bearer?: string): Promise<Response> {
    const headers = new Headers();
    if (bearer) headers.set('authorization', `Bearer ${bearer}`);
    else headers.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(identity)}`);
    if (payload !== undefined) headers.set('content-type', 'application/json');
    const req = new Request(`http://localhost/api/v1${urlPath}`, { method, headers, body: payload === undefined ? undefined : JSON.stringify(payload) });
    return handleApiRequest(req, appUserPool, platformOpsPool, ROUTES);
  }

  async function addMember(accountId: string, role: 'admin' | 'member', name: string | null): Promise<Identity> {
    const userId = randomUUID();
    await seedUser(admin, userId);
    if (name) await admin.query(`UPDATE users SET name = $2 WHERE id = $1`, [userId, name]);
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

  async function fixture() {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    return {
      owner,
      admin: await addMember(owner.accountId, 'admin', 'Ada Admin'),
      member: await addMember(owner.accountId, 'member', 'Mia Member'),
      repoId: await seedRepo(owner.accountId),
      otherRepoId: await seedRepo(owner.accountId),
    };
  }

  const get = async (who: Identity, path = '/action-rules'): Promise<Rules> => {
    const res = await call(who, 'GET', path);
    expect(res.status).toBe(200);
    return (await res.json()) as Rules;
  };
  const rows = async (accountId: string) =>
    (await admin.query<{ repo_id: string | null; version: number; changed_by: string }>(`SELECT repo_id, version, changed_by FROM action_rules WHERE account_id = $1 ORDER BY repo_id NULLS FIRST, version`, [accountId])).rows;
  const auditRows = async (accountId: string) =>
    (await admin.query<{ actor: string; payload: Record<string, unknown> }>(`SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'action_rules.changed' ORDER BY created_at, id`, [accountId])).rows;

  it('GET with nothing stored: no rules, source none, an empty history; the page can say that everything asks', async () => {
    const f = await fixture();
    expect(await get(f.owner)).toEqual({ repo_id: null, source: 'none', version: 0, rules: { rules: [] }, history: [] });
    expect(await get(f.owner, `/repos/${f.repoId}/action-rules`)).toEqual({ repo_id: f.repoId, source: 'none', version: 0, rules: { rules: [] }, history: [] });
    expect(await rows(f.owner.accountId)).toHaveLength(0);
  });

  it('POST appends a version and one audit row naming both versions and both hashes; the history names the author, never an id', async () => {
    const f = await fixture();
    const first = await call(f.owner, 'POST', '/action-rules', body(rule('a')));
    expect(first.status).toBe(200);
    const v1 = (await first.json()) as Rules;
    expect(v1).toMatchObject({ repo_id: null, source: 'account', version: 1, rules: { rules: [rule('a')] } });
    const v2 = (await (await call(f.admin, 'POST', '/action-rules', body(rule('a'), rule('b', 'deny', 'rm')))).json()) as Rules;
    expect(v2.version).toBe(2);
    expect(v2.history.map((h) => [h.version, h.rule_count, h.restored_from_version])).toEqual([[2, 2, null], [1, 1, null]]);
    expect(v2.history[0]!.author_name).toBe('Ada Admin');
    expect(v2.history[0]!.rules_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(v2.history[0]!.rules_sha256).not.toBe(v2.history[1]!.rules_sha256);
    const text = JSON.stringify(v2);
    for (const id of [f.owner.userId, f.admin.userId]) expect(text).not.toContain(id);
    expect(text).not.toMatch(/undefined|null"\s*:\s*"null|\[object Object\]/);
    const audit = await auditRows(f.owner.accountId);
    expect(audit).toHaveLength(2);
    expect(audit[1]).toMatchObject({
      actor: f.admin.userId,
      payload: { previous_version: 1, new_version: 2, previous_rules_sha256: v2.history[1]!.rules_sha256, new_rules_sha256: v2.history[0]!.rules_sha256 },
    });
  });

  it('a repo set overrides the account set on that repo only, and each scope keeps its own history', async () => {
    const f = await fixture();
    await call(f.owner, 'POST', '/action-rules', body(rule('acct', 'approve')));
    const repo = (await (await call(f.owner, 'POST', `/repos/${f.repoId}/action-rules`, body(rule('repo', 'deny')))).json()) as Rules;
    expect(repo).toMatchObject({ repo_id: f.repoId, source: 'repo', version: 1, rules: { rules: [rule('repo', 'deny')] } });
    expect(await get(f.owner, `/repos/${f.otherRepoId}/action-rules`)).toMatchObject({ source: 'account', version: 1, history: [] });
    expect((await get(f.owner)).rules.rules).toEqual([rule('acct', 'approve')]);
    expect((await rows(f.owner.accountId)).map((r) => [r.repo_id, r.version])).toEqual([[null, 1], [f.repoId, 1]]);
  });

  it('delete-all is a new empty version, and rollback restores an earlier one as another new version', async () => {
    const f = await fixture();
    await call(f.owner, 'POST', '/action-rules', body(rule('keep')));
    const emptied = (await (await call(f.owner, 'POST', '/action-rules', body())).json()) as Rules;
    expect(emptied).toMatchObject({ source: 'account', version: 2, rules: { rules: [] } });
    const before = await admin.query(`SELECT id, version, rules::text AS rules, rules_sha256 FROM action_rules WHERE account_id = $1 ORDER BY version`, [f.owner.accountId]);
    const res = await call(f.admin, 'POST', '/action-rules/rollback', { to_version: 1 });
    expect(res.status).toBe(200);
    const restored = (await res.json()) as Rules;
    expect(restored).toMatchObject({ version: 3, rules: { rules: [rule('keep')] } });
    expect(restored.history[0]).toMatchObject({ version: 3, restored_from_version: 1, author_name: 'Ada Admin' });
    const after = await admin.query(`SELECT id, version, rules::text AS rules, rules_sha256 FROM action_rules WHERE account_id = $1 ORDER BY version`, [f.owner.accountId]);
    expect(after.rows.slice(0, 2)).toEqual(before.rows);
    expect((await auditRows(f.owner.accountId)).at(-1)!.payload).toMatchObject({ previous_version: 2, new_version: 3, restored_from_version: 1 });
  });

  it('a rollback to a version the scope does not have is a 404 and writes nothing', async () => {
    const f = await fixture();
    await call(f.owner, 'POST', `/repos/${f.repoId}/action-rules`, body(rule('r')));
    for (const [path, to] of [['/action-rules', 1], [`/repos/${f.repoId}/action-rules`, 9]] as const) {
      const res = await call(f.owner, 'POST', `${path}/rollback`, { to_version: to });
      expect(res.status, path).toBe(404);
      expect(((await res.json()) as ErrorBody).error.code).toBe('action_rules_version_not_found');
    }
    expect(await rows(f.owner.accountId)).toHaveLength(1);
  });

  it('refuses an invalid set with the validator codes and the path, and writes nothing', async () => {
    const f = await fixture();
    const cases: [unknown, string, string][] = [
      [{ rules: { rules: [{ id: 'x', outcome: 'ask', when: { op: 'regex', field: '/request/tool', value: 'a' } }] } }, 'regex_operator', '/rules/0/when/op'],
      [{ rules: { rules: [{ id: 'x', outcome: 'ask', when: { op: 'equals', field: '/request/agent_reasoning', value: 'a' } }] } }, 'field_forbidden', '/rules/0/when/field'],
      [{ rules: { rules: [{ id: 'x', outcome: 'approve', when: { op: 'equals', field: '/request/context/a', value: 'a' } }] } }, 'field_forbidden', '/rules/0/when/field'],
      [{ rules: { rules: [{ id: 'x', outcome: 'maybe', when: { op: 'exists', field: '/request/tool' } }] } }, 'bad_outcome', '/rules/0/outcome'],
      [{ rules: { rules: Array.from({ length: 201 }, (_, i) => rule(`r${i}`)) } }, 'too_many_rules', '/rules'],
      [{ rules: { rules: [], note: 'x' } }, 'unknown_key', '/note'],
    ];
    for (const [payload, code, path] of cases) {
      const res = await call(f.owner, 'POST', '/action-rules', payload);
      expect(res.status, code).toBe(422);
      const err = (await res.json()) as ErrorBody;
      expect(err.error.code).toBe('invalid_input');
      expect(err.details).toContainEqual({ code, path });
    }
    for (const payload of [{}, { rules: 'x' }, { rules: { rules: 'x' } }, { rules: { rules: [] }, extra: 1 }]) {
      expect((await call(f.owner, 'POST', '/action-rules', payload)).status, JSON.stringify(payload)).toBe(422);
    }
    expect(await rows(f.owner.accountId)).toHaveLength(0);
    expect(await auditRows(f.owner.accountId)).toHaveLength(0);
  });

  it('a plain member can neither read nor write (403), a token gets session_required on every route, and a missing, malformed or other-tenant repo is one 404', async () => {
    const f = await fixture();
    const other = await fixture();
    const plaintext = generateToken();
    await insertApiToken(appUserPool, {
      accountId: f.owner.accountId,
      createdBy: f.owner.userId,
      tokenHash: hashToken(plaintext),
      displayHint: 'fxat_...test',
      scopes: ['read'],
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const targets: [string, string, unknown][] = [
      ['GET', '/action-rules', undefined],
      ['POST', '/action-rules', body()],
      ['POST', '/action-rules/rollback', { to_version: 1 }],
      ['GET', `/repos/${f.repoId}/action-rules`, undefined],
      ['POST', `/repos/${f.repoId}/action-rules`, body()],
      ['POST', `/repos/${f.repoId}/action-rules/rollback`, { to_version: 1 }],
    ];
    for (const [method, path, payload] of targets) {
      const asMember = await call(f.member, method, path, payload);
      expect(asMember.status, `member ${method} ${path}`).toBe(403);
      expect(((await asMember.json()) as ErrorBody).error.code).toBe('insufficient_role');
      const asToken = await call(f.owner, method, path, payload, plaintext);
      expect(asToken.status, `token ${method} ${path}`).toBe(403);
      expect(((await asToken.json()) as ErrorBody).error.code).toBe('session_required');
    }
    for (const id of [randomUUID(), 'not-a-uuid', other.repoId]) {
      for (const [method, suffix, payload] of [['GET', '', undefined], ['POST', '', body()], ['POST', '/rollback', { to_version: 1 }]] as const) {
        expect((await call(f.owner, method, `/repos/${id}/action-rules${suffix}`, payload)).status, `${method} ${id}${suffix}`).toBe(404);
      }
    }
    expect(await rows(f.owner.accountId)).toHaveLength(0);
  });

  it("another account's rules never show: each account reads only its own", async () => {
    const a = await fixture();
    const b = await fixture();
    await call(a.owner, 'POST', '/action-rules', body(rule('secret-a')));
    expect(await get(b.owner)).toMatchObject({ source: 'none', version: 0, history: [] });
    expect(JSON.stringify(await get(b.owner))).not.toContain('secret-a');
  });

  it('rollback to a stored version that no longer validates is a 422 with the validator codes; nothing is written or audited', async () => {
    const f = await fixture();
    await call(f.owner, 'POST', '/action-rules', body(rule('ok')));
    // A row the validator now refuses (a regex operator), stored as an older release might have allowed.
    const old = JSON.stringify({ rules: [{ id: 'old', outcome: 'ask', when: { op: 'regex', field: '/request/tool', value: 'a.*' } }] });
    await admin.query(
      `INSERT INTO action_rules (account_id, repo_id, version, rules, rule_count, rules_sha256, changed_by)
       VALUES ($1, NULL, 2, $2::jsonb, 1, encode(sha256(convert_to(($2::jsonb)::text, 'UTF8')), 'hex'), $3)`,
      [f.owner.accountId, old, f.owner.userId],
    );
    const rowsBefore = (await rows(f.owner.accountId)).length;
    const auditBefore = (await auditRows(f.owner.accountId)).length;
    const res = await call(f.owner, 'POST', '/action-rules/rollback', { to_version: 2 });
    expect(res.status).toBe(422);
    const err = (await res.json()) as ErrorBody;
    expect(err.error.code).toBe('invalid_input');
    expect(err.details).toContainEqual({ code: 'regex_operator', path: '/rules/0/when/op' });
    expect((await rows(f.owner.accountId)).length).toBe(rowsBefore);
    expect((await auditRows(f.owner.accountId)).length).toBe(auditBefore);
  });

  it('a NUL character or a lone surrogate in a rule value is a 422 invalid_input naming the value, never a 500; nothing is written', async () => {
    const f = await fixture();
    for (const bad of ['a\u0000b', 'x\ud800y', '\udc00']) {
      const payload = body({ id: 'u', outcome: 'ask', when: { op: 'equals', field: '/request/tool', value: bad } });
      for (const path of ['/action-rules', `/repos/${f.repoId}/action-rules`]) {
        const res = await call(f.owner, 'POST', path, payload);
        expect(res.status, `${path} ${JSON.stringify(bad)}`).toBe(422);
        const err = (await res.json()) as ErrorBody;
        expect(err.error.code).toBe('invalid_input');
        expect(err.details).toEqual([{ code: 'value_invalid', path: '/rules/0/when/value' }]);
      }
    }
    expect(await rows(f.owner.accountId)).toHaveLength(0);
    expect(await auditRows(f.owner.accountId)).toHaveLength(0);
    // Ordinary non-ASCII text is fine.
    const ok = await call(f.owner, 'POST', '/action-rules', body({ id: 'u', outcome: 'ask', when: { op: 'equals', field: '/request/tool', value: 'café 😀' } }));
    expect(ok.status).toBe(200);
  });

  it('the writer errors map to the documented answers: a lost race is a 409 action_rules_changed, a missing version a 404', () => {
    const conflict = mapWriteError(new ActionRulesError('action_rules_version_conflict')) as ApiError;
    expect(conflict).toBeInstanceOf(ApiError);
    expect([conflict.status, conflict.code]).toEqual([409, 'action_rules_changed']);
    const missing = mapWriteError(new ActionRulesError('action_rules_version_not_found')) as ApiError;
    expect([missing.status, missing.code]).toEqual([404, 'action_rules_version_not_found']);
    const other = new Error('boom');
    expect(mapWriteError(other)).toBe(other);
  });

  it('append-only at the wire: no UPDATE or DELETE statement against action_rules ever ran as app_user', async () => {
    expect(sql.length).toBeGreaterThan(0);
    for (const s of sql) {
      expect(s, s).not.toMatch(/\bUPDATE\s+action_rules\b/i);
      expect(s, s).not.toMatch(/\bDELETE\s+FROM\s+action_rules\b/i);
    }
    expect(sql.some((s) => /INSERT INTO action_rules/.test(s))).toBe(true);
  });
});
