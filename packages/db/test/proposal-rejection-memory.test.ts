import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#483 S5-f (0844): rejection memory. The three columns and their CHECKs (S5f-1), the reject definer's kind and date, the
 * restore definer clearing both fields (S5f-3), and resurface_proposals: who may call it, which rows it moves and which it
 * leaves. The import end to end (A-S5-5) is in packages/core/test/proposal-rejection-memory.pg.test.ts.
 */
describe('rejection memory (0844)', () => {
  let adminPool: Pool;
  let appPool: Pool;
  let opsPool: Pool;
  let admin: PoolClient;
  let a: SeedRefs;
  let b: SeedRefs;
  let memberUser: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    admin = await adminPool.connect();
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    memberUser = randomUUID();
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [memberUser, `${memberUser}@example.test`]);
    await admin.query('INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)', [a.accountId, memberUser, 'member']);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end(), opsPool.end()]);
  });

  async function newRepo(r: SeedRefs): Promise<string> {
    const id = randomUUID();
    await admin.query('INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, $4, $5)', [id, r.accountId, r.installationId, Math.floor(Math.random() * 1e9) + 10, 'team']);
    return id;
  }
  async function newImport(r: SeedRefs, repoId: string, state: 'running' | 'succeeded'): Promise<string> {
    const { rows } = await admin.query(
      `INSERT INTO plan_imports (account_id, repo_id, state, ${state === 'running' ? 'started_at' : 'finished_at'}) VALUES ($1, $2, $3, now()) RETURNING id`,
      [r.accountId, repoId, state],
    );
    return rows[0].id;
  }
  async function newProposal(r: SeedRefs, repoId: string, over: Record<string, unknown> = {}): Promise<string> {
    const row = { dedupe_key: `gh:issue:${Math.floor(Math.random() * 1e9) + 1}`, sources: ['github_issue'], title: 'An idea', provenance: 'external', owner_process: 'product', state: 'new', ...over };
    const cols = Object.keys(row);
    const { rows } = await admin.query(
      `INSERT INTO proposals (account_id, repo_id, ${cols.join(', ')}) VALUES ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')}) RETURNING id`,
      [r.accountId, repoId, ...Object.values(row)],
    );
    return rows[0].id;
  }
  const row = async (id: string) =>
    (await admin.query('SELECT state, reject_kind, resurface_after, resurfaced_at, reject_note, decided_at, last_import_id FROM proposals WHERE id = $1', [id])).rows[0];
  const as = <T>(r: SeedRefs, user: string, fn: (c: PoolClient) => Promise<T>, token?: string): Promise<T> => withTenant(appPool, r.accountId, user, token, fn);
  const reject = (r: SeedRefs, id: string, note: string | null, kind?: string, after?: Date | null) =>
    as(r, r.userId, async (c) =>
      kind === undefined
        ? (await c.query('SELECT * FROM reject_proposal($1, $2)', [id, note])).rows[0]
        : (await c.query('SELECT * FROM reject_proposal($1, $2, $3, $4)', [id, note, kind, after ?? null])).rows[0],
    );
  const restore = (r: SeedRefs, id: string) => as(r, r.userId, async (c) => (await c.query('SELECT * FROM restore_proposal($1)', [id])).rows[0]);
  /** The import's write transaction: SET LOCAL ROLE plan_importer inside a tenant transaction. */
  const resurface = (r: SeedRefs, repoId: string, importId: string) =>
    withTenant(appPool, r.accountId, r.userId, async (c) => {
      await c.query('SET LOCAL ROLE plan_importer');
      return Number((await c.query('SELECT resurface_proposals($1, $2) AS n', [repoId, importId])).rows[0].n);
    });
  const day = 86_400_000;

  describe('S5f-1: the columns and their CHECKs', () => {
    it('refuses never with a date, not_now without one, a date without a kind, an unknown kind, and a kind on a row that is not rejected', async () => {
      const repo = await newRepo(a);
      const bad = (over: Record<string, unknown>) => expect(newProposal(a, repo, over)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      const when = new Date(Date.now() + day);
      await bad({ state: 'rejected', decided_at: new Date(), reject_kind: 'never', resurface_after: when });
      await bad({ state: 'rejected', decided_at: new Date(), reject_kind: 'not_now' });
      await bad({ state: 'rejected', decided_at: new Date(), resurface_after: when });
      await bad({ state: 'rejected', decided_at: new Date(), reject_kind: 'later', resurface_after: when });
      await bad({ state: 'new', reject_kind: 'never' });
      await bad({ state: 'new', reject_kind: 'not_now', resurface_after: when });
      await bad({ state: 'rejected', decided_at: new Date(), resurfaced_at: new Date() });
      // The allowed shapes.
      await expect(newProposal(a, repo, { state: 'rejected', decided_at: new Date(), reject_kind: 'never' })).resolves.toBeTruthy();
      await expect(newProposal(a, repo, { state: 'rejected', decided_at: new Date(), reject_kind: 'not_now', resurface_after: when })).resolves.toBeTruthy();
      await expect(newProposal(a, repo, { state: 'new', resurfaced_at: new Date(), decided_at: new Date() })).resolves.toBeTruthy();
      // A row rejected before 0844 has neither field and is still valid.
      await expect(newProposal(a, repo, { state: 'rejected', decided_at: new Date() })).resolves.toBeTruthy();
    });

    it('the import role holds no grant on the new columns: it reaches them only through the definer', async () => {
      const repo = await newRepo(a);
      const p = await newProposal(a, repo, { state: 'rejected', decided_at: new Date(), reject_kind: 'not_now', resurface_after: new Date(Date.now() - day) });
      for (const sql of [
        `UPDATE proposals SET state = 'new', reject_kind = NULL, resurface_after = NULL WHERE id = '${p}'`,
        `UPDATE proposals SET resurface_after = now() WHERE id = '${p}'`,
        `UPDATE proposals SET reject_kind = 'never', resurface_after = NULL WHERE id = '${p}'`,
        `UPDATE proposals SET resurfaced_at = now() WHERE id = '${p}'`,
      ]) {
        await expect(as(a, a.userId, async (c) => { await c.query('SET LOCAL ROLE plan_importer'); return c.query(sql); }), sql).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
      expect((await row(p)).state).toBe('rejected');
    });
  });

  describe('reject_proposal: the kind and the date', () => {
    it('Not now without a date gets 30 days, with a date keeps it, Never has no date, and the audit row names the kind', async () => {
      const repo = await newRepo(a);
      const p1 = await newProposal(a, repo);
      expect(await reject(a, p1, 'later', 'not_now')).toEqual({ state: 'rejected', replayed: false });
      const r1 = await row(p1);
      expect(r1).toMatchObject({ state: 'rejected', reject_kind: 'not_now', reject_note: 'later', resurfaced_at: null });
      const days = (new Date(r1.resurface_after).getTime() - Date.now()) / day;
      expect(days).toBeGreaterThan(29.9);
      expect(days).toBeLessThan(30.1);

      const p2 = await newProposal(a, repo);
      const when = new Date(Date.now() + 5 * day);
      await reject(a, p2, null, 'not_now', when);
      expect(new Date((await row(p2)).resurface_after).getTime()).toBe(when.getTime());

      const p3 = await newProposal(a, repo);
      await reject(a, p3, null, 'never');
      expect(await row(p3)).toMatchObject({ state: 'rejected', reject_kind: 'never', resurface_after: null });

      const audit = (await admin.query(`SELECT payload FROM audit_log WHERE account_id = $1 AND action = 'proposal.rejected' AND payload->>'proposal_id' = $2`, [a.accountId, p3])).rows;
      expect(audit).toHaveLength(1);
      expect(audit[0].payload).toMatchObject({ kind: 'never', resurface_after: null });
    });

    it('a date must be in the future and at most 365 days away; a date with Never, an unknown kind and a long note are refused; nothing is written', async () => {
      const repo = await newRepo(a);
      const p = await newProposal(a, repo);
      await expect(reject(a, p, null, 'not_now', new Date(Date.now() - 1000))).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE, message: 'invalid_resurface_date' });
      await expect(reject(a, p, null, 'not_now', new Date(Date.now() + 366 * day))).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE, message: 'invalid_resurface_date' });
      await expect(reject(a, p, null, 'never', new Date(Date.now() + day))).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      await expect(reject(a, p, null, 'sometime')).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      await expect(reject(a, p, 'x'.repeat(501), 'never')).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      expect(await row(p)).toMatchObject({ state: 'new', reject_kind: null, resurface_after: null });
      // The edge: exactly 365 days (a moment under) is allowed. The database counts calendar days, which are 24 hours long only when no
      // daylight-saving change falls in the year, so the edge is asked of the database's own clock.
      const edge = (await admin.query<{ t: Date }>(`SELECT now() + interval '365 days' - interval '1 minute' AS t`)).rows[0]!.t;
      await reject(a, p, null, 'not_now', edge);
      expect((await row(p)).reject_kind).toBe('not_now');
    });

    it('the two-argument call of the previous deploy still works and means Never; the same decision again is a replay, a different one is not_new', async () => {
      const repo = await newRepo(a);
      const p = await newProposal(a, repo);
      expect(await reject(a, p, 'old caller')).toEqual({ state: 'rejected', replayed: false });
      expect(await row(p)).toMatchObject({ reject_kind: 'never', resurface_after: null });
      expect(await reject(a, p, 'old caller')).toEqual({ state: 'rejected', replayed: true });
      expect(await reject(a, p, 'old caller', 'never')).toEqual({ state: 'rejected', replayed: true });
      await expect(reject(a, p, 'old caller', 'not_now')).rejects.toMatchObject({ code: '55000', message: 'not_new' });

      const q = await newProposal(a, repo);
      const when = new Date(Date.now() + 3 * day);
      await reject(a, q, null, 'not_now', when);
      expect(await reject(a, q, null, 'not_now', when)).toMatchObject({ replayed: true });
      expect(await reject(a, q, null, 'not_now')).toMatchObject({ replayed: true });
      await expect(reject(a, q, null, 'not_now', new Date(when.getTime() + day))).rejects.toMatchObject({ code: '55000', message: 'not_new' });
      await expect(reject(a, q, null, 'never')).rejects.toMatchObject({ code: '55000', message: 'not_new' });
    });

    it('a member session and another tenant are refused as before', async () => {
      const repo = await newRepo(a);
      const p = await newProposal(a, repo);
      await expect(as(a, memberUser, (c) => c.query(`SELECT * FROM reject_proposal($1, NULL, 'not_now', NULL)`, [p]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(as(b, b.userId, (c) => c.query(`SELECT * FROM reject_proposal($1, NULL, 'never', NULL)`, [p]))).rejects.toMatchObject({ code: 'P0002' });
      expect((await row(p)).state).toBe('new');
    });

    it('a resurfaced proposal can be rejected again: the new decision clears resurfaced_at and carries the new kind', async () => {
      const repo = await newRepo(a);
      const p = await newProposal(a, repo, { state: 'new', decided_at: new Date(), resurfaced_at: new Date() });
      await reject(a, p, 'again', 'never');
      expect(await row(p)).toMatchObject({ state: 'rejected', reject_kind: 'never', resurfaced_at: null, reject_note: 'again' });
    });
  });

  describe('S5f-3: Move back to inbox clears both fields, for both kinds', () => {
    it('restore returns a Not now and a Never to new with the kind, the date, the note and the stamp cleared', async () => {
      const repo = await newRepo(a);
      for (const kind of ['not_now', 'never'] as const) {
        const p = await newProposal(a, repo);
        await reject(a, p, 'because', kind);
        expect(await restore(a, p)).toEqual({ state: 'new' });
        expect(await row(p), kind).toMatchObject({ state: 'new', reject_kind: null, resurface_after: null, reject_note: null, decided_at: null, resurfaced_at: null });
        await expect(restore(a, p)).rejects.toMatchObject({ code: '55000', message: 'not_rejected' });
        const audit = (await admin.query(`SELECT payload FROM audit_log WHERE account_id = $1 AND action = 'proposal.restored' AND payload->>'proposal_id' = $2`, [a.accountId, p])).rows;
        expect(audit[0].payload, kind).toMatchObject({ kind });
      }
      // A row rejected before 0844 (no kind) restores too.
      const legacy = await newProposal(a, repo, { state: 'rejected', decided_at: new Date(), reject_note: 'old' });
      expect(await restore(a, legacy)).toEqual({ state: 'new' });
      expect(await row(legacy)).toMatchObject({ state: 'new', reject_kind: null, reject_note: null });
    });
  });

  describe('resurface_proposals', () => {
    const past = () => new Date(Date.now() - day);
    const notNow = (r: SeedRefs, repo: string, over: Record<string, unknown> = {}) =>
      newProposal(r, repo, { state: 'rejected', decided_at: new Date(Date.now() - 3 * day), reject_kind: 'not_now', resurface_after: past(), reject_note: 'maybe later', ...over });

    it('moves exactly the due Not now rows whose source this import saw, keeps the stamp, moves the note into the audit row, and leaves everything else', async () => {
      const repo = await newRepo(a);
      const imp = await newImport(a, repo, 'running');
      const seenBefore = await newImport(a, repo, 'succeeded');
      const due = await notNow(a, repo, { last_import_id: imp });
      const dueTask = await notNow(a, repo, { last_import_id: imp, sources: ['plan_task'], dedupe_key: `plan:${randomUUID().slice(0, 8)}` });
      const notDue = await notNow(a, repo, { last_import_id: imp, resurface_after: new Date(Date.now() + day) });
      const closed = await notNow(a, repo, { last_import_id: seenBefore });
      const noSource = await notNow(a, repo, { last_import_id: imp, sources: ['preview'] });
      const never = await newProposal(a, repo, { state: 'rejected', decided_at: new Date(), reject_kind: 'never', last_import_id: imp });
      const legacy = await newProposal(a, repo, { state: 'rejected', decided_at: new Date(), last_import_id: imp });
      const isNew = await newProposal(a, repo, { last_import_id: imp });
      const dueDecided = (await row(due)).decided_at;

      expect(await resurface(a, repo, imp)).toBe(2);

      expect(await row(due)).toMatchObject({ state: 'new', reject_kind: null, resurface_after: null, reject_note: null });
      expect((await row(due)).resurfaced_at).not.toBeNull();
      expect((await row(due)).decided_at).toEqual(dueDecided);
      expect((await row(dueTask)).state).toBe('new');
      for (const [name, id, state] of [['not due', notDue, 'rejected'], ['closed at the source', closed, 'rejected'], ['a source the importer does not read', noSource, 'rejected'], ['never', never, 'rejected'], ['rejected before 0844', legacy, 'rejected'], ['new', isNew, 'new']] as const) {
        expect((await row(id)).state, name).toBe(state);
        expect((await row(id)).resurfaced_at, name).toBeNull();
      }
      const audit = (await admin.query(`SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'proposal.resurfaced' ORDER BY created_at`, [a.accountId])).rows.filter((x) => [due, dueTask].includes(x.payload.proposal_id));
      expect(audit).toHaveLength(2);
      const mine = audit.find((x) => x.payload.proposal_id === due)!;
      expect(mine.actor).toBe('system:plan_import');
      expect(mine.payload).toMatchObject({ repo_id: repo, import_id: imp, note: 'maybe later' });
      // A second pass over the same import finds nothing more to move.
      expect(await resurface(a, repo, imp)).toBe(0);
    });

    it('is the importer role only: a person session, a token and a direct platform_ops login cannot call it', async () => {
      const repo = await newRepo(a);
      const imp = await newImport(a, repo, 'running');
      await expect(as(a, a.userId, (c) => c.query('SELECT resurface_proposals($1, $2)', [repo, imp]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE, message: expect.stringMatching(/permission denied for function/) });
      const { rows } = await admin.query(`SELECT has_function_privilege('app_user', 'resurface_proposals(uuid, uuid)'::regprocedure, 'EXECUTE') AS app, has_function_privilege('plan_importer', 'resurface_proposals(uuid, uuid)'::regprocedure, 'EXECUTE') AS imp, has_function_privilege(0, 'resurface_proposals(uuid, uuid)'::regprocedure, 'EXECUTE') AS pub`);
      expect(rows[0]).toEqual({ app: false, imp: true, pub: false });
      const client = await opsPool.connect();
      try {
        await expect(client.query('SELECT resurface_proposals($1, $2)', [repo, imp])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      } finally {
        client.release();
      }
    });

    it('needs a RUNNING import of this repo in this tenant', async () => {
      const repo = await newRepo(a);
      const other = await newRepo(a);
      const finished = await newImport(a, repo, 'succeeded');
      const running = await newImport(a, repo, 'running');
      const bRepo = await newRepo(b);
      const bImp = await newImport(b, bRepo, 'running');
      const p = await notNow(a, repo, { last_import_id: running });
      await expect(resurface(a, repo, finished)).rejects.toMatchObject({ code: '55000', message: 'import_not_running' });
      await expect(resurface(a, other, running)).rejects.toMatchObject({ code: '55000', message: 'import_not_running' });
      await expect(resurface(a, repo, bImp)).rejects.toMatchObject({ code: '55000', message: 'import_not_running' });
      await expect(resurface(a, repo, randomUUID())).rejects.toMatchObject({ code: '55000', message: 'import_not_running' });
      await expect(resurface(a, bRepo, bImp)).rejects.toMatchObject({ code: '55000', message: 'import_not_running' });
      expect((await row(p)).state).toBe('rejected');
      // Another tenant's due rows are never touched by a call in this tenant.
      const bDue = await notNow(b, bRepo, { last_import_id: bImp });
      expect(await resurface(a, repo, running)).toBe(1);
      expect((await row(bDue)).state).toBe('rejected');
      expect(await resurface(b, bRepo, bImp)).toBe(1);
    });
  });
});
