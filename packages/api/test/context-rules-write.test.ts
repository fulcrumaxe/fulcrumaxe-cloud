import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { ROLE_CONTEXT_DEFAULTS } from '@fx/core/src/context/contextBudget.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { contextRuleDeps, contextRuleRoutes } from '../src/routes/context-rules.js';
import { contextSettingsRoutes } from '../src/routes/context-settings.js';
import { seedAccountWithMember, seedUser } from './helpers/seed.js';

const FX_SESSION_SECRET = 's'.repeat(32);
const HEAD = 'a'.repeat(40);
type Entry = { path: string; type: 'blob' | 'tree' | 'commit'; size?: number };
type Identity = { userId: string; accountId: string };

/** A tree reader that answers in the trees API's shape and refuses what the real one would: a tree request for any commit but the head it handed out. */
class Trees {
  calls = 0;
  entries: Entry[] = [];
  fail = false;
  async headSha() {
    this.calls++;
    if (this.fail) throw new Error('repoTreeSource: status_500 token=ghs_secret acme/widgets');
    return HEAD;
  }
  async tree(sha: string) {
    this.calls++;
    if (sha !== HEAD) throw new Error('repoTreeSource: status_404');
    return { truncated: false, entries: this.entries };
  }
}

/** [pg] D#600 CX-9a: the write routes for context rules and the repository's context budget, over real Postgres with forced row security. */
describe('context rule and context budget write routes (D#600 CX-9a)', { timeout: 120_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  const trees = new Trees();

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = FX_SESSION_SECRET;
    contextRuleDeps.openTree = async () => trees;
  });
  afterEach(() => {
    trees.entries = [];
    trees.fail = false;
    trees.calls = 0;
  });
  afterAll(async () => {
    contextRuleDeps.openTree = null;
    delete process.env.FX_SESSION_SECRET;
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
  });

  async function call(who: Identity, method: string, urlPath: string, body?: unknown): Promise<Response> {
    const headers = new Headers({ cookie: `${SESSION_COOKIE_NAME}=${await signSession(who)}` });
    if (body !== undefined) headers.set('content-type', 'application/json');
    return handleApiRequest(new Request(`http://localhost/api/v1${urlPath}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), appUserPool, platformOpsPool, ROUTES);
  }

  async function world() {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const memberId = randomUUID();
    await seedUser(admin, memberId);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [owner.accountId, memberId]);
    const repoId = randomUUID();
    const itemId = randomUUID();
    const inst = randomUUID();
    await admin.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, 'team')`, [inst, owner.accountId, Math.floor(Math.random() * 1e9)]);
    await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, installation_id, gh_owner, gh_name) VALUES ($1, $2, $3, 'team', $4, 'acme', 'widgets')`, [repoId, owner.accountId, Math.floor(Math.random() * 1e9), inst]);
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, state, provenance) VALUES ($1, $2, $3, 'feature', 'running', 'internal')`, [itemId, owner.accountId, repoId]);
    const member: Identity = { accountId: owner.accountId, userId: memberId };
    const audit = async (like: string) => (await admin.query(`SELECT action, actor, payload FROM audit_log WHERE account_id = $1 AND action LIKE $2 ORDER BY created_at, id`, [owner.accountId, like])).rows;
    const rules = async () => (await admin.query(`SELECT scope, kind, path FROM context_rules WHERE account_id = $1 ORDER BY scope, path`, [owner.accountId])).rows;
    return { owner, member, repoId, itemId, audit, rules };
  }

  it('registers the routes: session only, the right roles, never idempotent', () => {
    expect(contextRuleRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/v1/context-rules', 'PUT /api/v1/context-rules', 'DELETE /api/v1/context-rules/{id}']);
    for (const r of [...contextRuleRoutes, ...contextSettingsRoutes]) {
      expect(ROUTES).toContain(r);
      expect(r.principals ?? ['session']).toEqual(['session']);
      expect(r.idempotency).toBe('never');
    }
    expect(contextRuleRoutes.slice(1).map((r) => [r.minRole, r.rateClass])).toEqual([['member', 'write'], ['member', 'write']]);
    expect(contextSettingsRoutes.map((r) => [r.method, r.path, r.minRole])).toEqual([
      ['GET', '/api/v1/repos/{id}/context-settings', 'member'],
      ['PUT', '/api/v1/repos/{id}/context-settings', 'admin'],
      ['PUT', '/api/v1/repos/{id}/context-settings/roles/{role}', 'admin'],
      ['GET', '/api/v1/work-items/{id}/context-settings', 'member'],
      ['PUT', '/api/v1/work-items/{id}/context-settings', 'admin'],
    ]);
  });

  describe('PUT /context-rules', () => {
    it('criterion 1: a save writes the rule and exactly one audit row; the answer names the rule', async () => {
      const w = await world();
      const res = await call(w.member, 'PUT', '/context-rules', { scope: 'item', work_item_id: w.itemId, kind: 'exclude', path: 'secret/**' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string };
      expect(body).toEqual({ id: expect.any(String), scope: 'item', kind: 'exclude', path: 'secret/**', repo_id: null, work_item_id: w.itemId });
      expect(await w.rules()).toEqual([{ scope: 'item', kind: 'exclude', path: 'secret/**' }]);
      const rows = await w.audit('context_rule.%');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ action: 'context_rule.saved', actor: w.member.userId });
      expect(JSON.stringify(rows[0].payload)).not.toContain('ghs_');
      expect(trees.calls).toBe(0);
    });

    it('a member cannot write repo scope (403); an owner can, and a pin is measured with one tree read', async () => {
      const w = await world();
      trees.entries = [{ path: 'README.md', type: 'blob', size: 100 }];
      const asMember = await call(w.member, 'PUT', '/context-rules', { scope: 'repo', repo_id: w.repoId, kind: 'pin', path: 'README.md' });
      expect(asMember.status).toBe(403);
      expect(await w.rules()).toEqual([]);
      const asOwner = await call(w.owner, 'PUT', '/context-rules', { scope: 'repo', repo_id: w.repoId, kind: 'pin', path: 'README.md' });
      expect(asOwner.status).toBe(200);
      expect(trees.calls).toBe(2);
      expect(await w.audit('context_rule.%')).toHaveLength(1);
    });

    it("account B cannot write account A's repo or item (404, nothing written, no audit row)", async () => {
      const a = await world();
      const b = await world();
      for (const body of [
        { scope: 'repo', repo_id: a.repoId, kind: 'exclude', path: 'x' },
        { scope: 'item', work_item_id: a.itemId, kind: 'exclude', path: 'x' },
      ]) {
        const res = await call(b.owner, 'PUT', '/context-rules', body);
        expect(res.status).toBe(404);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found');
      }
      expect(await a.rules()).toEqual([]);
      expect(await a.audit('context_rule.%')).toEqual([]);
      expect(await b.audit('context_rule.%')).toEqual([]);
    });

    it('invalid_path (422) for a traversal, an absolute path, a control character and a glob in a pin; nothing written and GitHub never asked', async () => {
      const w = await world();
      for (const [kind, path] of [['pin', '../x'], ['exclude', '/etc/passwd'], ['exclude', 'a\u0000b'], ['pin', 'src/*.ts'], ['exclude', 'a//b'], ['exclude', '~foo']] as const) {
        const res = await call(w.owner, 'PUT', '/context-rules', { scope: 'repo', repo_id: w.repoId, kind, path });
        expect(res.status, path).toBe(422);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_path');
      }
      expect(await w.rules()).toEqual([]);
      expect(trees.calls).toBe(0);
    });

    it('pins_exceed_budget (409) writes nothing and no audit row; tree failure is a fixed 503 that carries no GitHub text', async () => {
      const w = await world();
      trees.entries = [{ path: 'big.md', type: 'blob', size: ROLE_CONTEXT_DEFAULTS.executor + 1 }];
      const over = await call(w.owner, 'PUT', '/context-rules', { scope: 'repo', repo_id: w.repoId, kind: 'pin', path: 'big.md' });
      expect(over.status).toBe(409);
      expect(((await over.json()) as { error: { code: string } }).error.code).toBe('pins_exceed_budget');
      trees.fail = true;
      const down = await call(w.owner, 'PUT', '/context-rules', { scope: 'repo', repo_id: w.repoId, kind: 'pin', path: 'big.md' });
      expect(down.status).toBe(503);
      expect(JSON.stringify(await down.json())).not.toMatch(/ghs_|acme|widgets/);
      expect(await w.rules()).toEqual([]);
      expect(await w.audit('context_rule.%')).toEqual([]);
    });

    it('with no tree reader registered a pin answers 503 tree_unavailable and an exclude still saves', async () => {
      const w = await world();
      contextRuleDeps.openTree = null;
      try {
        expect((await call(w.owner, 'PUT', '/context-rules', { scope: 'repo', repo_id: w.repoId, kind: 'pin', path: 'a.md' })).status).toBe(503);
        expect((await call(w.owner, 'PUT', '/context-rules', { scope: 'repo', repo_id: w.repoId, kind: 'exclude', path: 'a.md' })).status).toBe(200);
      } finally {
        contextRuleDeps.openTree = async () => trees;
      }
    });

    it('criterion 3: the 501st exclude is refused with a fixed code and nothing is written; the 500th is accepted', async () => {
      const w = await world();
      await admin.query(
        `INSERT INTO context_rules (account_id, scope, repo_id, kind, path, created_by) SELECT $1, 'repo', $2, 'exclude', 'gen/' || g, $3 FROM generate_series(1, 499) g`,
        [w.owner.accountId, w.repoId, w.owner.userId],
      );
      expect((await call(w.owner, 'PUT', '/context-rules', { scope: 'repo', repo_id: w.repoId, kind: 'exclude', path: 'last' })).status).toBe(200);
      const res = await call(w.owner, 'PUT', '/context-rules', { scope: 'repo', repo_id: w.repoId, kind: 'exclude', path: 'one-too-many' });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('excludes_exceed_cap');
      expect((await w.rules()).length).toBe(500);
      expect(await w.audit('context_rule.%')).toHaveLength(1);
      // Saving a path that already has an exclude replaces it and is never a 501st.
      expect((await call(w.owner, 'PUT', '/context-rules', { scope: 'repo', repo_id: w.repoId, kind: 'exclude', path: 'last' })).status).toBe(200);
    });

    it('criterion 3: a save that would push the pins of one run over the ceiling is refused with pins_exceed_ceiling', async () => {
      const w = await world();
      await admin.query(
        `INSERT INTO context_rules (account_id, scope, repo_id, kind, path, created_by) SELECT $1, 'repo', $2, 'pin', 'gen/' || g, $3 FROM generate_series(1, 500) g`,
        [w.owner.accountId, w.repoId, w.owner.userId],
      );
      const res = await call(w.owner, 'PUT', '/context-rules', { scope: 'repo', repo_id: w.repoId, kind: 'pin', path: 'one-too-many' });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('pins_exceed_ceiling');
      // The repo's pins land in every item's set: an item holding 1 pin of its own plus the 500 would carry 501.
      const item = await call(w.member, 'PUT', '/context-rules', { scope: 'item', work_item_id: w.itemId, kind: 'pin', path: 'item.md' });
      expect(item.status).toBe(409);
      expect((await w.rules()).filter((r) => r.scope === 'item')).toEqual([]);
    });

    it('wants exactly the fields of one scope and nothing else (422)', async () => {
      const w = await world();
      for (const body of [
        { scope: 'repo', work_item_id: w.itemId, kind: 'pin', path: 'a' },
        { scope: 'item', repo_id: w.repoId, kind: 'pin', path: 'a' },
        { scope: 'repo', repo_id: w.repoId, work_item_id: w.itemId, kind: 'pin', path: 'a' },
        { scope: 'repo', repo_id: 'nope', kind: 'pin', path: 'a' },
        { scope: 'repo', repo_id: w.repoId, kind: 'other', path: 'a' },
        { scope: 'repo', repo_id: w.repoId, kind: 'pin', path: '' },
        { scope: 'repo', repo_id: w.repoId, kind: 'pin', path: 'a'.repeat(513) },
        { scope: 'repo', repo_id: w.repoId, kind: 'pin', path: 'a', extra: 1 },
      ]) {
        expect((await call(w.owner, 'PUT', '/context-rules', body)).status, JSON.stringify(body)).toBe(422);
      }
    });
  });

  describe('DELETE /context-rules/{id}', () => {
    it('criterion 2: a remove deletes the rule and writes one audit row that outlives it', async () => {
      const w = await world();
      const saved = (await (await call(w.member, 'PUT', '/context-rules', { scope: 'item', work_item_id: w.itemId, kind: 'exclude', path: 'a' })).json()) as { id: string };
      const res = await call(w.member, 'DELETE', `/context-rules/${saved.id}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ removed: true });
      expect(await w.rules()).toEqual([]);
      expect((await w.audit('context_rule.%')).map((r) => r.action)).toEqual(['context_rule.saved', 'context_rule.removed']);
      expect((await call(w.member, 'DELETE', `/context-rules/${saved.id}`)).status).toBe(404);
      expect(await w.audit('context_rule.%')).toHaveLength(2);
    });

    it("a member cannot remove a repo rule (403); account B cannot remove account A's rule (404)", async () => {
      const a = await world();
      const b = await world();
      const saved = (await (await call(a.owner, 'PUT', '/context-rules', { scope: 'repo', repo_id: a.repoId, kind: 'exclude', path: 'x' })).json()) as { id: string };
      expect((await call(a.member, 'DELETE', `/context-rules/${saved.id}`)).status).toBe(403);
      expect((await call(b.owner, 'DELETE', `/context-rules/${saved.id}`)).status).toBe(404);
      expect((await call(a.owner, 'DELETE', '/context-rules/not-a-uuid')).status).toBe(422);
      expect(await a.rules()).toEqual([{ scope: 'repo', kind: 'exclude', path: 'x' }]);
      expect(await a.audit('context_rule.removed')).toEqual([]);
    });

    it('criterion 2: removing an item exclude that brings a repo pin back over budget answers 409 and removes nothing; confirm removes it, with one audit row', async () => {
      const w = await world();
      await admin.query(`INSERT INTO repo_context_settings (account_id, repo_id, context_budget_bytes, updated_by) VALUES ($1, $2, 5000, $3)`, [w.owner.accountId, w.repoId, w.owner.userId]);
      trees.entries = [{ path: 'big.md', type: 'blob', size: 4000 }, { path: 'small.md', type: 'blob', size: 2000 }];
      const put = async (who: Identity, body: object) => (await call(who, 'PUT', '/context-rules', body)).status;
      expect(await put(w.owner, { scope: 'repo', repo_id: w.repoId, kind: 'pin', path: 'big.md' })).toBe(200);
      const ex = (await (await call(w.member, 'PUT', '/context-rules', { scope: 'item', work_item_id: w.itemId, kind: 'exclude', path: 'big.md' })).json()) as { id: string };
      expect(await put(w.member, { scope: 'item', work_item_id: w.itemId, kind: 'pin', path: 'small.md' })).toBe(200);
      const before = (await w.audit('context_rule.%')).length;

      const warned = await call(w.member, 'DELETE', `/context-rules/${ex.id}`);
      expect(warned.status).toBe(409);
      expect(((await warned.json()) as { error: { code: string } }).error.code).toBe('exclude_readds_pins');
      expect((await w.rules()).find((r) => r.path === 'big.md' && r.scope === 'item')).toBeTruthy();
      expect(await w.audit('context_rule.%')).toHaveLength(before);

      const confirmed = await call(w.member, 'DELETE', `/context-rules/${ex.id}?confirm=true`);
      expect(confirmed.status).toBe(200);
      expect((await w.rules()).find((r) => r.scope === 'item' && r.kind === 'exclude')).toBeUndefined();
      expect((await w.audit('context_rule.%')).slice(before).map((r) => r.action)).toEqual(['context_rule.removed']);
      expect((await call(w.member, 'DELETE', `/context-rules/${randomUUID()}?confirm=maybe`)).status).toBe(422);
    });

    it('a remove that would bring a same-path repo rule back and leave 501 pins or 501 excludes is refused outright, confirm or not, and removes nothing', async () => {
      for (const [repoKind, itemKind, code] of [['pin', 'exclude', 'pins_exceed_ceiling'], ['exclude', 'pin', 'excludes_exceed_cap']] as const) {
        const w = await world();
        await admin.query(
          `INSERT INTO context_rules (account_id, scope, repo_id, kind, path, created_by) SELECT $1, 'repo', $2, $3, 'gen/' || g, $4 FROM generate_series(1, 500) g`,
          [w.owner.accountId, w.repoId, repoKind, w.owner.userId],
        );
        const put = (kind: string, path: string) => call(w.member, 'PUT', '/context-rules', { scope: 'item', work_item_id: w.itemId, kind, path });
        // The item's rule on a repo path replaces it (one fewer of the repo's kind), which leaves room for one more of that kind.
        const shadow = (await (await put(itemKind, 'gen/1')).json()) as { id: string };
        expect((await put(repoKind, 'extra')).status).toBe(200);
        const rulesBefore = await w.rules();
        for (const suffix of ['', '?confirm=true']) {
          const res = await call(w.member, 'DELETE', `/context-rules/${shadow.id}${suffix}`);
          expect(res.status).toBe(409);
          expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code);
        }
        expect(await w.rules()).toEqual(rulesBefore);
        expect(await w.audit('context_rule.removed')).toEqual([]);
      }
    });

    it('with room in the budget, or with the code host down, the remove goes straight through (the warning is advice)', async () => {
      const w = await world();
      trees.entries = [{ path: 'big.md', type: 'blob', size: 100 }];
      await call(w.owner, 'PUT', '/context-rules', { scope: 'repo', repo_id: w.repoId, kind: 'pin', path: 'big.md' });
      const ex = (await (await call(w.member, 'PUT', '/context-rules', { scope: 'item', work_item_id: w.itemId, kind: 'exclude', path: 'big.md' })).json()) as { id: string };
      expect((await call(w.member, 'DELETE', `/context-rules/${ex.id}`)).status).toBe(200);
      const ex2 = (await (await call(w.member, 'PUT', '/context-rules', { scope: 'item', work_item_id: w.itemId, kind: 'exclude', path: 'big.md' })).json()) as { id: string };
      trees.fail = true;
      expect((await call(w.member, 'DELETE', `/context-rules/${ex2.id}`)).status).toBe(200);
    });
  });

  describe('GET and PUT /repos/{id}/context-settings', () => {
    const url = (repoId: string) => `/repos/${repoId}/context-settings`;

    it('a repository that never chose a size reads null with every role default and effective size filled in', async () => {
      const w = await world();
      const body = (await (await call(w.member, 'GET', url(w.repoId))).json()) as Record<string, unknown>;
      expect(body).toMatchObject({ context_budget_bytes: null, min_bytes: 4096, max_bytes: 2097152, role_defaults: ROLE_CONTEXT_DEFAULTS, effective_by_role: ROLE_CONTEXT_DEFAULTS });
      expect(JSON.stringify({ ...body, context_budget_bytes: 0, role_budgets: {} })).not.toContain('null');
    });

    it('criterion 4: an owner writes the range ends, a reset writes NULL, each change writes one audit row and an equal value writes none', async () => {
      const w = await world();
      const put = async (value: number | null) => ((await call(w.owner, 'PUT', url(w.repoId), { context_budget_bytes: value })).json()) as Promise<Record<string, unknown>>;
      expect(await put(4096)).toMatchObject({ context_budget_bytes: 4096, changed: true, pins_status: 'fit', effective_by_role: { executor: 4096, debater: 4096 } });
      expect(await put(2097152)).toMatchObject({ context_budget_bytes: 2097152, changed: true });
      expect(await put(2097152)).toMatchObject({ changed: false });
      expect(await put(null)).toMatchObject({ context_budget_bytes: null, changed: true, effective_by_role: ROLE_CONTEXT_DEFAULTS });
      expect(await put(null)).toMatchObject({ changed: false });
      const rows = await w.audit('context_budget.%');
      expect(rows.map((r) => [r.payload.from, r.payload.to])).toEqual([[null, 4096], [4096, 2097152], [2097152, null]]);
      expect(rows.every((r) => r.actor === w.owner.userId && r.payload.repo_id === w.repoId)).toBe(true);
      const row = await admin.query(`SELECT 1 FROM repo_context_settings WHERE repo_id = $1`, [w.repoId]);
      expect(row.rows).toEqual([]);
    });

    it('is owner or admin only (a member gets 403, nothing written); account B gets 404 on account A', async () => {
      const a = await world();
      const b = await world();
      expect((await call(a.member, 'PUT', url(a.repoId), { context_budget_bytes: 50000 })).status).toBe(403);
      expect((await call(b.owner, 'PUT', url(a.repoId), { context_budget_bytes: 50000 })).status).toBe(404);
      expect((await call(b.owner, 'GET', url(a.repoId))).status).toBe(404);
      expect((await admin.query(`SELECT 1 FROM repo_context_settings WHERE repo_id = $1`, [a.repoId])).rows).toEqual([]);
      expect(await a.audit('context_budget.%')).toEqual([]);
    });

    it('refuses a size outside the CHECK range, a non-integer and any other field (422)', async () => {
      const w = await world();
      for (const body of [{ context_budget_bytes: 4095 }, { context_budget_bytes: 2097153 }, { context_budget_bytes: 5000.5 }, { context_budget_bytes: '5000' }, {}, { context_budget_bytes: 5000, extra: 1 }]) {
        expect((await call(w.owner, 'PUT', url(w.repoId), body)).status, JSON.stringify(body)).toBe(422);
      }
      expect(await w.audit('context_budget.%')).toEqual([]);
    });

    it('criterion 4: a budget lowered below the existing pins is accepted and the answer says over_budget; GitHub down gives not_measured and the write stands', async () => {
      const w = await world();
      trees.entries = [{ path: 'a.md', type: 'blob', size: 6000 }];
      expect((await call(w.owner, 'PUT', '/context-rules', { scope: 'repo', repo_id: w.repoId, kind: 'pin', path: 'a.md' })).status).toBe(200);
      const lowered = await call(w.owner, 'PUT', url(w.repoId), { context_budget_bytes: 5000 });
      expect(lowered.status).toBe(200);
      expect(await lowered.json()).toMatchObject({ context_budget_bytes: 5000, changed: true, pins_status: 'over_budget' });
      expect(await w.rules()).toEqual([{ scope: 'repo', kind: 'pin', path: 'a.md' }]);
      trees.fail = true;
      expect(await (await call(w.owner, 'PUT', url(w.repoId), { context_budget_bytes: 6000 })).json()).toMatchObject({ context_budget_bytes: 6000, pins_status: 'not_measured' });
      trees.fail = false;
      expect(await (await call(w.owner, 'PUT', url(w.repoId), { context_budget_bytes: null })).json()).toMatchObject({ pins_status: 'fit' });
      expect((await w.audit('context_budget.%')).length).toBe(3);
    });
  });
  describe('role and item budgets (D#600 CX-12)', () => {
    const url = (repoId: string) => `/repos/${repoId}/context-settings`;
    const roleUrl = (repoId: string, role: string) => `/repos/${repoId}/context-settings/roles/${role}`;
    const itemUrl = (itemId: string) => `/work-items/${itemId}/context-settings`;
    const json = async (r: Response) => (await r.json()) as Record<string, unknown> & { error: { code: string; message: string }; role_max: Record<string, number> };

    it('an owner sets a role budget and an item budget, reads each back, and resets each; the levels are named and every figure is filled in', async () => {
      const w = await world();
      expect(await json(await call(w.member, 'GET', itemUrl(w.itemId)))).toMatchObject({ item_budget_bytes: null, min_bytes: 4096, max_bytes: 86016, source_by_role: { executor: 'default', debater: 'default' } });
      const role = await json(await call(w.owner, 'PUT', roleUrl(w.repoId, 'executor'), { budget_bytes: 8192 }));
      expect(role).toMatchObject({ changed: true, pins_status: 'fit', context_budget_bytes: null, role_budgets: { executor: 8192, fix: null }, effective_by_role: { executor: 8192, fix: ROLE_CONTEXT_DEFAULTS.fix }, source_by_role: { executor: 'role', fix: 'default' } });
      expect(role.role_max.executor).toBe(ROLE_CONTEXT_DEFAULTS.executor * 2);
      await call(w.owner, 'PUT', url(w.repoId), { context_budget_bytes: 20000 });
      expect(await json(await call(w.member, 'GET', url(w.repoId)))).toMatchObject({ effective_by_role: { executor: 8192, fix: 20000 }, source_by_role: { executor: 'role', fix: 'repo' } });
      const item = await json(await call(w.owner, 'PUT', itemUrl(w.itemId), { budget_bytes: 6000 }));
      expect(item).toMatchObject({ changed: true, item_budget_bytes: 6000, effective_by_role: { executor: 6000, fix: 6000 }, source_by_role: { executor: 'item', debater: 'item' } });
      expect(JSON.stringify(await json(await call(w.member, 'GET', itemUrl(w.itemId))))).not.toMatch(/null|undefined|NaN/);
      // Reset: the item leaves the role and repository levels, the role leaves the repository's.
      expect(await json(await call(w.owner, 'PUT', itemUrl(w.itemId), { budget_bytes: null }))).toMatchObject({ item_budget_bytes: null, effective_by_role: { executor: 8192, fix: 20000 }, source_by_role: { executor: 'role', fix: 'repo' } });
      expect(await json(await call(w.owner, 'PUT', roleUrl(w.repoId, 'executor'), { budget_bytes: null }))).toMatchObject({ role_budgets: { executor: null }, source_by_role: { executor: 'repo' } });
      // Reload: a fresh read shows the same.
      expect(await json(await call(w.member, 'GET', url(w.repoId)))).toMatchObject({ context_budget_bytes: 20000, role_budgets: { executor: null }, source_by_role: { executor: 'repo' } });
    });

    it('each real change writes one audit row with the ids, the role and the old and new size; an equal value or a reset of nothing writes none', async () => {
      const w = await world();
      const put = (p: string, v: number | null) => call(w.owner, 'PUT', p, { budget_bytes: v });
      expect((await json(await put(roleUrl(w.repoId, 'debater'), 10000))).changed).toBe(true);
      expect((await json(await put(roleUrl(w.repoId, 'debater'), 10000))).changed).toBe(false);
      expect((await json(await put(itemUrl(w.itemId), null))).changed).toBe(false);
      await put(itemUrl(w.itemId), 4096);
      await put(roleUrl(w.repoId, 'debater'), null);
      const rows = await w.audit('context_budget.%');
      expect(rows.map((r) => [r.payload.scope, r.payload.role, r.payload.from, r.payload.to])).toEqual([['role', 'debater', null, 10000], ['item', null, null, 4096], ['role', 'debater', 10000, null]]);
      expect(rows.every((r) => r.actor === w.owner.userId)).toBe(true);
      expect(rows[1]!.payload).toMatchObject({ work_item_id: w.itemId, repo_id: null });
    });

    it('bounds: a role to its default times 2, an item to the largest of those, both from 4096; outside is 422 budget_out_of_range with the bound in the message and nothing written', async () => {
      const w = await world();
      const max = ROLE_CONTEXT_DEFAULTS.executor * 2;
      expect((await call(w.owner, 'PUT', roleUrl(w.repoId, 'executor'), { budget_bytes: 4096 })).status).toBe(200);
      expect((await call(w.owner, 'PUT', roleUrl(w.repoId, 'executor'), { budget_bytes: max })).status).toBe(200);
      expect((await call(w.owner, 'PUT', itemUrl(w.itemId), { budget_bytes: 4096 })).status).toBe(200);
      expect((await call(w.owner, 'PUT', itemUrl(w.itemId), { budget_bytes: 86016 })).status).toBe(200);
      const before = (await w.audit('context_budget.%')).length;
      for (const [path, bad, bound] of [[roleUrl(w.repoId, 'executor'), max + 1, max], [roleUrl(w.repoId, 'executor'), 4095, max], [roleUrl(w.repoId, 'code-reviewer'), ROLE_CONTEXT_DEFAULTS['code-reviewer'] * 2 + 1, ROLE_CONTEXT_DEFAULTS['code-reviewer'] * 2], [itemUrl(w.itemId), 86017, 86016], [itemUrl(w.itemId), 0, 86016]] as const) {
        const res = await call(w.owner, 'PUT', path, { budget_bytes: bad });
        expect(res.status, `${path} ${bad}`).toBe(422);
        const body = await json(res);
        expect(body.error.code).toBe('budget_out_of_range');
        expect(body.error.message).toContain(String(bound));
        expect(body.error.message).toContain('4096');
      }
      for (const body of [{ budget_bytes: 5000.5 }, { budget_bytes: '5000' }, {}, { budget_bytes: 5000, extra: 1 }]) expect((await call(w.owner, 'PUT', itemUrl(w.itemId), body)).status, JSON.stringify(body)).toBe(422);
      expect((await w.audit('context_budget.%')).length).toBe(before);
    });

    it('a member gets 403 on every write and may read; another account gets 404 on both, never 403; an unknown role is 404', async () => {
      const a = await world();
      const b = await world();
      expect((await call(a.member, 'PUT', roleUrl(a.repoId, 'executor'), { budget_bytes: 8192 })).status).toBe(403);
      expect((await call(a.member, 'PUT', itemUrl(a.itemId), { budget_bytes: 8192 })).status).toBe(403);
      expect((await call(a.member, 'GET', itemUrl(a.itemId))).status).toBe(200);
      for (const [method, path, body] of [['PUT', roleUrl(a.repoId, 'executor'), { budget_bytes: 8192 }], ['PUT', itemUrl(a.itemId), { budget_bytes: 8192 }], ['GET', itemUrl(a.itemId), undefined]] as const) {
        expect((await call(b.owner, method, path, body)).status, `${method} ${path}`).toBe(404);
      }
      expect((await call(a.owner, 'PUT', roleUrl(a.repoId, 'planner'), { budget_bytes: 8192 })).status).toBe(404);
      expect((await call(a.owner, 'PUT', itemUrl('not-a-uuid'), { budget_bytes: 8192 })).status).toBe(404);
      expect((await admin.query(`SELECT 1 FROM context_budget_overrides WHERE account_id = ANY($1)`, [[a.owner.accountId, b.owner.accountId]])).rows).toEqual([]);
      expect(await a.audit('context_budget.%')).toEqual([]);
    });

    it('a budget set under existing pins is accepted and reported, for a role and for an item; GitHub down gives not_measured and the write stands', async () => {
      const w = await world();
      trees.entries = [{ path: 'a.md', type: 'blob', size: 6000 }];
      expect((await call(w.owner, 'PUT', '/context-rules', { scope: 'repo', repo_id: w.repoId, kind: 'pin', path: 'a.md' })).status).toBe(200);
      expect(await json(await call(w.owner, 'PUT', roleUrl(w.repoId, 'executor'), { budget_bytes: 5000 }))).toMatchObject({ changed: true, pins_status: 'over_budget' });
      expect(await json(await call(w.owner, 'PUT', roleUrl(w.repoId, 'executor'), { budget_bytes: 7000 }))).toMatchObject({ pins_status: 'fit' });
      expect(await json(await call(w.owner, 'PUT', itemUrl(w.itemId), { budget_bytes: 5000 }))).toMatchObject({ item_budget_bytes: 5000, pins_status: 'over_budget' });
      trees.fail = true;
      expect(await json(await call(w.owner, 'PUT', itemUrl(w.itemId), { budget_bytes: 5500 }))).toMatchObject({ item_budget_bytes: 5500, pins_status: 'not_measured' });
      expect(await w.rules()).toEqual([{ scope: 'repo', kind: 'pin', path: 'a.md' }]);
    });

    it('saving a pin is held to the same precedence: an item budget smaller than the pin refuses it (pins_exceed_budget), and removing the item budget lets it save', async () => {
      const w = await world();
      trees.entries = [{ path: 'a.md', type: 'blob', size: 6000 }];
      await call(w.owner, 'PUT', itemUrl(w.itemId), { budget_bytes: 5000 });
      const refused = await call(w.owner, 'PUT', '/context-rules', { scope: 'item', work_item_id: w.itemId, kind: 'pin', path: 'a.md' });
      expect(refused.status).toBe(409);
      expect((await json(refused)).error.code).toBe('pins_exceed_budget');
      expect(await w.rules()).toEqual([]);
      await call(w.owner, 'PUT', itemUrl(w.itemId), { budget_bytes: null });
      expect((await call(w.owner, 'PUT', '/context-rules', { scope: 'item', work_item_id: w.itemId, kind: 'pin', path: 'a.md' })).status).toBe(200);
    });

    it('names the roles whose runs use a budget; a write for a role that uses none is stored and answers that it does not apply, with no pins verdict', async () => {
      const w = await world();
      trees.entries = [{ path: 'a.md', type: 'blob', size: 6000 }];
      await call(w.owner, 'PUT', '/context-rules', { scope: 'repo', repo_id: w.repoId, kind: 'pin', path: 'a.md' });
      expect((await json(await call(w.member, 'GET', url(w.repoId)))).consuming_roles).toEqual(['executor']);
      expect((await json(await call(w.member, 'GET', itemUrl(w.itemId)))).consuming_roles).toEqual(['executor']);
      const calls = trees.calls;
      const fix = await json(await call(w.owner, 'PUT', roleUrl(w.repoId, 'fix'), { budget_bytes: 4096 }));
      expect(fix).toMatchObject({ changed: true, applies_to_runs: false, pins_status: null, role_budgets: { fix: 4096 } });
      expect(trees.calls).toBe(calls); // nothing to measure: GitHub was not asked
      expect(await json(await call(w.owner, 'PUT', roleUrl(w.repoId, 'executor'), { budget_bytes: 5000 }))).toMatchObject({ applies_to_runs: true, pins_status: 'over_budget' });
      expect(await json(await call(w.owner, 'PUT', itemUrl(w.itemId), { budget_bytes: 9000 }))).toMatchObject({ applies_to_runs: true, pins_status: 'fit' });
    });

    it('a repository write measures each item against its own budget: a smaller item budget reads over_budget, a larger one does not make the repository refuse', async () => {
      const w = await world();
      trees.entries = [{ path: 'a.md', type: 'blob', size: 4500 }, { path: 'b.md', type: 'blob', size: 4000 }];
      await call(w.owner, 'PUT', '/context-rules', { scope: 'repo', repo_id: w.repoId, kind: 'pin', path: 'a.md' });
      await call(w.owner, 'PUT', itemUrl(w.itemId), { budget_bytes: 4096 });
      // The repository's own budget holds the pin, but this item's smaller one does not.
      expect(await json(await call(w.owner, 'PUT', url(w.repoId), { context_budget_bytes: 8000 }))).toMatchObject({ pins_status: 'over_budget' });
      await call(w.owner, 'PUT', itemUrl(w.itemId), { budget_bytes: null });
      expect(await json(await call(w.owner, 'PUT', url(w.repoId), { context_budget_bytes: 8000 }))).toMatchObject({ pins_status: 'fit' });
      // An item with a larger budget of its own keeps its item pin: the repository's smaller budget does not measure it.
      await call(w.owner, 'PUT', itemUrl(w.itemId), { budget_bytes: 9000 });
      expect((await call(w.owner, 'PUT', '/context-rules', { scope: 'item', work_item_id: w.itemId, kind: 'pin', path: 'b.md' })).status).toBe(200);
      expect(await json(await call(w.owner, 'PUT', url(w.repoId), { context_budget_bytes: 5000 }))).toMatchObject({ pins_status: 'fit' });
    });

    it('an item with no repository still reads the budget stored for it', async () => {
      const w = await world();
      const loose = randomUUID();
      await admin.query(`INSERT INTO work_items (id, account_id, kind, state, provenance) VALUES ($1, $2, 'feature', 'running', 'internal')`, [loose, w.owner.accountId]);
      await admin.query(`INSERT INTO context_budget_overrides (account_id, scope, work_item_id, bytes, updated_by) VALUES ($1, 'item', $2, 6000, $3)`, [w.owner.accountId, loose, w.owner.userId]);
      expect(await json(await call(w.member, 'GET', itemUrl(loose)))).toMatchObject({ item_budget_bytes: 6000, source_by_role: { executor: 'item' } });
    });

    it('a removed item or repository takes its budgets with it: the item reads 404 and its override row is gone', async () => {
      const w = await world();
      await call(w.owner, 'PUT', itemUrl(w.itemId), { budget_bytes: 6000 });
      await call(w.owner, 'PUT', roleUrl(w.repoId, 'fix'), { budget_bytes: 6000 });
      await admin.query('DELETE FROM context_rules WHERE account_id = $1', [w.owner.accountId]);
      await admin.query('DELETE FROM work_items WHERE id = $1', [w.itemId]);
      expect((await call(w.owner, 'GET', itemUrl(w.itemId))).status).toBe(404);
      expect((await admin.query('SELECT scope FROM context_budget_overrides WHERE account_id = $1', [w.owner.accountId])).rows).toEqual([{ scope: 'role' }]);
    });
  });
});
