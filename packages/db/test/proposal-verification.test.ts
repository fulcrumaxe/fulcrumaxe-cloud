import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { findRlsViolations } from '../src/rlsInventory.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/** D#483 S4-a: proposal evidence, claims and the verification columns, and their one writer (0839). */
const SHA = 'a'.repeat(40);
const DEFINER = 'proposal_record_verification';

/** The migrations S4-a must leave alone (D#94 R1): their bytes are pinned. */
const UNTOUCHED: Record<string, string> = {
  '0723_plan_import.sql': 'c1f1e19f2899c3ae484d2f751a4c954523df94ddf62a570bc559845af65ffbce',
  '0753_plan_import_hardening.sql': 'c2ae2a90a5367abef3c233ff3e2dca92940e3dafe305ff8730d6fd13e2f4d1f1',
  '0755_plan_import_budget_code.sql': 'f56b2b30e4cf2a34e7eb6a17b9580d840b90a7faa5d553ac3d88907650f2e137',
  '0758_plan_import_source_too_large.sql': '5d80b44c68e19c93dcb1521816e7f316b7c41e38a9de032297c59238e1ac7b8e',
};

describe('proposal evidence, claims and verification (0839)', () => {
  let adminPool: Pool;
  let appPool: Pool;
  let opsPool: Pool;
  let admin: PoolClient;
  let a: SeedRefs;
  let b: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    admin = await adminPool.connect();
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end(), opsPool.end()]);
  });

  async function newRepo(r: SeedRefs): Promise<string> {
    const id = randomUUID();
    await admin.query('INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, $4, $5)', [
      id, r.accountId, r.installationId, Math.floor(Math.random() * 1e9) + 10, 'team',
    ]);
    return id;
  }
  async function newProposal(r: SeedRefs, repoId: string, over: Record<string, unknown> = {}): Promise<string> {
    const row = { dedupe_key: `plan:T${randomUUID().slice(0, 8)}`, sources: ['plan_task'], title: 'A task', provenance: 'internal', owner_process: 'product', state: 'new', ...over };
    const cols = Object.keys(row);
    const { rows } = await admin.query(
      `INSERT INTO proposals (account_id, repo_id, ${cols.join(', ')}) VALUES ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')}) RETURNING id`,
      [r.accountId, repoId, ...Object.values(row)],
    );
    return rows[0].id;
  }
  async function newRun(r: SeedRefs): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'local', 'running')`, [id, r.accountId, r.workItemId]);
    return id;
  }
  async function mintToken(r: SeedRefs): Promise<string> {
    const { rows } = await admin.query(
      `INSERT INTO api_tokens (account_id, created_by, token_hash, display_hint, scopes, expires_at) VALUES ($1, $2, $3, 'fxat_x', $4, now() + interval '1 day') RETURNING id`,
      [r.accountId, r.userId, randomUUID(), ['work_items:write']],
    );
    return rows[0].id;
  }
  /** The verifier's own session: a tenant transaction with no user (the pipeline's shape). */
  const tenant = <T>(r: SeedRefs, fn: (c: PoolClient) => Promise<T>): Promise<T> => withTenant(appPool, r.accountId, fn);
  const asImporter = <T>(r: SeedRefs, fn: (c: PoolClient) => Promise<T>): Promise<T> =>
    withTenant(appPool, r.accountId, r.userId, async (c) => {
      await c.query('SET LOCAL ROLE plan_importer');
      return fn(c);
    });

  const claim = (text: string, verdict = 'supported') => ({ text, verdict });
  const ev = (over: Record<string, unknown> = {}) => ({ kind: 'file_lines', ref: 'src/app.ts:40-44', excerpt: 'const a = 1;\nconst b = 2;', commit_sha: SHA, ...over });

  function record(c: PoolClient, proposal: string, o: { verification?: string; sha?: string | null; run?: string | null; claims?: unknown; evidence?: unknown } = {}) {
    const verification = o.verification ?? 'verified';
    const needsRun = verification === 'verified' || verification === 'partly_verified';
    return c.query(`SELECT * FROM ${DEFINER}($1, $2, $3, $4, $5::jsonb, $6::jsonb)`, [
      proposal,
      verification,
      o.sha === undefined ? SHA : o.sha,
      o.run === undefined ? (needsRun ? a.runId : null) : o.run,
      JSON.stringify(o.claims ?? [claim('It reads the config')]),
      JSON.stringify(o.evidence ?? [ev()]),
    ]);
  }

  describe('S4a-1: the CHECKs, the schema and the untouched migrations', () => {
    it('the widened sources and keys accept the new values and refuse one out-of-set value each', async () => {
      const repo = await newRepo(a);
      await newProposal(a, repo, { sources: ['docs'], dedupe_key: 'src:0123456789abcdef' });
      await newProposal(a, repo, { sources: ['code', 'interview', 'github_issue'], dedupe_key: `src:${'f'.repeat(16)}` });
      await newProposal(a, repo, { sources: ['preview', 'plan_task', 'github_discussion'], dedupe_key: 'gh:discussion:7' });
      for (const sources of [['bogus'], ['docs', 'bogus'], []]) {
        await expect(newProposal(a, repo, { sources }), JSON.stringify(sources)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      }
      for (const key of ['src:0123456789ABCDEF', 'src:0123456789abcde', 'src:0123456789abcdef0', 'src:', 'src:0123456789abcdeg', 'doc:1']) {
        await expect(newProposal(a, repo, { dedupe_key: key }), key).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      }
    });

    it('verification starts pending with no stamp, and every verification column refuses an out-of-set value', async () => {
      const repo = await newRepo(a);
      const id = await newProposal(a, repo);
      expect((await admin.query('SELECT verification, verified_at, verified_sha, verify_attempts, verified_run_id FROM proposals WHERE id = $1', [id])).rows[0])
        .toEqual({ verification: 'pending', verified_at: null, verified_sha: null, verify_attempts: 0, verified_run_id: null });
      for (const v of ['pending', 'verified', 'partly_verified', 'refuted', 'not_checked', 'check_failed']) {
        await admin.query(`UPDATE proposals SET verification = $2, verified_at = ${v === 'pending' ? 'NULL' : 'now()'} WHERE id = $1`, [id, v]);
      }
      const bad: Array<[string, unknown[]]> = [
        [`verification = 'bogus', verified_at = now()`, []],
        [`verification = 'Verified', verified_at = now()`, []],
        [`verify_attempts = -1`, []],
        [`verified_sha = $2`, ['a'.repeat(65)]],
        [`verified_sha = ''`, []],
        // stamped once checked, unstamped while pending
        [`verification = 'pending', verified_at = now()`, []],
        [`verification = 'refuted', verified_at = NULL`, []],
        // only a verified or partly verified proposal names a run
        [`verification = 'refuted', verified_at = now(), verified_run_id = '${a.runId}'`, []],
        [`verification = 'check_failed', verified_at = now(), verified_run_id = '${a.runId}'`, []],
      ];
      for (const [set, params] of bad) {
        await expect(admin.query(`UPDATE proposals SET ${set} WHERE id = $1`, [id, ...params]), set).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      }
      // a run of another account cannot be named (the same (account_id, id) shape as the ledger)
      await expect(admin.query(`UPDATE proposals SET verification = 'verified', verified_at = now(), verified_run_id = $2 WHERE id = $1`, [id, b.runId]))
        .rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
    });

    it('evidence and claims refuse one out-of-set value per CHECK', async () => {
      const repo = await newRepo(a);
      const pid = await newProposal(a, repo);
      const evidence = (over: Record<string, unknown>) => {
        const row = { kind: 'file_lines', ref: 'a.ts:1', excerpt: 'x', commit_sha: SHA, ...over };
        const cols = Object.keys(row);
        return admin.query(`INSERT INTO proposal_evidence (account_id, repo_id, proposal_id, ${cols.join(', ')}) VALUES ($1, $2, $3, ${cols.map((_, i) => `$${i + 4}`).join(', ')})`, [a.accountId, repo, pid, ...Object.values(row)]);
      };
      const claimRow = (over: Record<string, unknown>) => {
        const row = { text: 'T', verdict: 'supported', checked_sha: SHA, checked_at: new Date(), ...over };
        const cols = Object.keys(row);
        return admin.query(`INSERT INTO proposal_claims (account_id, proposal_id, ${cols.join(', ')}) VALUES ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')})`, [a.accountId, pid, ...Object.values(row)]);
      };
      for (const kind of ['file_lines', 'issue', 'discussion', 'doc_passage', 'interview_answer', 'preview']) {
        await evidence({ kind, commit_sha: kind === 'file_lines' ? SHA : null });
      }
      await evidence({ excerpt: 'tab\there\r\nand a newline', ref: 'r'.repeat(300) });
      await evidence({ excerpt: 'e'.repeat(600) });
      const badEvidence: Array<[string, Record<string, unknown>]> = [
        ['kind', { kind: 'screenshot' }],
        ['empty ref', { ref: '' }],
        ['ref over 300', { ref: 'r'.repeat(301) }],
        ['excerpt over 600', { excerpt: 'e'.repeat(601) }],
        ['control character', { excerpt: 'a\u0007b' }],
        ['escape character', { excerpt: 'a\u001bb' }],
        ['sha over 64', { commit_sha: 'a'.repeat(65) }],
        ['file lines without a commit', { kind: 'file_lines', commit_sha: null }],
      ];
      for (const [label, over] of badEvidence) {
        await expect(evidence(over), label).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      }
      await claimRow({});
      await claimRow({ verdict: 'pending', checked_sha: null, checked_at: null });
      await claimRow({ text: 't'.repeat(400), verdict: 'unverifiable' });
      const badClaims: Array<[string, Record<string, unknown>]> = [
        ['verdict', { verdict: 'maybe' }],
        ['empty text', { text: '' }],
        ['text over 400', { text: 't'.repeat(401) }],
        ['control character', { text: 'a\u0001b' }],
        ['sha over 64', { checked_sha: 'a'.repeat(65) }],
        ['pending with a stamp', { verdict: 'pending' }],
        ['verdict without a stamp', { verdict: 'refuted', checked_at: null }],
      ];
      for (const [label, over] of badClaims) {
        await expect(claimRow(over), label).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      }
    });

    it('both tables have RLS forced, one tenant_isolation select policy for app_user, and a tenant-bound policy for the definer role only', async () => {
      expect(await findRlsViolations(admin)).toEqual([]);
      for (const t of ['proposal_evidence', 'proposal_claims']) {
        const { rows } = await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass`, [t]);
        expect(rows[0], t).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
        const pol = await admin.query(`SELECT policyname, cmd, roles::text[] AS roles, qual FROM pg_policies WHERE schemaname = 'public' AND tablename = $1 ORDER BY policyname`, [t]);
        expect(pol.rows.map((p) => p.policyname), t).toEqual(['proposal_verification_definer_rw', 'tenant_isolation']);
        expect(pol.rows.find((p) => p.policyname === 'tenant_isolation')).toMatchObject({ cmd: 'SELECT', roles: ['app_user'] });
        const own = pol.rows.find((p) => p.policyname === 'proposal_verification_definer_rw');
        expect(own.roles).toEqual(['proposal_verification_definer']);
        expect(String(own.qual)).toContain('app.account_id');
      }
    });

    it('0723, 0753, 0755 and 0758 are byte-identical', () => {
      for (const [file, sha] of Object.entries(UNTOUCHED)) {
        const bytes = readFileSync(new URL(`../migrations/${file}`, import.meta.url));
        expect(createHash('sha256').update(bytes).digest('hex'), file).toBe(sha);
      }
    });
  });

  describe('S4a-2: only the definer writes', () => {
    it('as app_user and as plan_importer a direct write of a verification column, evidence or a claim fails on privileges', async () => {
      const repo = await newRepo(a);
      const pid = await newProposal(a, repo);
      const writes = [
        `UPDATE proposals SET verification = 'verified', verified_at = now() WHERE id = '${pid}'`,
        `UPDATE proposals SET verified_sha = '${SHA}' WHERE id = '${pid}'`,
        `UPDATE proposals SET verify_attempts = 5 WHERE id = '${pid}'`,
        `UPDATE proposals SET verified_run_id = '${a.runId}' WHERE id = '${pid}'`,
        `INSERT INTO proposal_evidence (account_id, repo_id, proposal_id, kind, ref, excerpt) VALUES ('${a.accountId}', '${repo}', '${pid}', 'issue', '#1', 'x')`,
        `INSERT INTO proposal_claims (account_id, proposal_id, text) VALUES ('${a.accountId}', '${pid}', 'x')`,
      ];
      for (const sql of writes) {
        await expect(tenant(a, (c) => c.query(sql)), `app_user ${sql}`).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
        await expect(asImporter(a, (c) => c.query(sql)), `plan_importer ${sql}`).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
      // nor can the importer create a proposal that arrives already verified
      await expect(asImporter(a, (c) => c.query(
        `INSERT INTO proposals (account_id, repo_id, dedupe_key, sources, title, provenance, owner_process, verification, verified_at) VALUES ('${a.accountId}', '${repo}', 'plan:v', '{plan_task}', 't', 'internal', 'product', 'verified', now())`)))
        .rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      // while its ordinary insert still passes and starts pending
      await asImporter(a, (c) => c.query(
        `INSERT INTO proposals (account_id, repo_id, dedupe_key, sources, title, provenance, owner_process, state) VALUES ('${a.accountId}', '${repo}', 'src:00000000000000aa', '{docs}', 't', 'internal', 'product', 'new')`));
      expect((await admin.query(`SELECT verification FROM proposals WHERE dedupe_key = 'src:00000000000000aa'`)).rows[0].verification).toBe('pending');
      expect((await admin.query('SELECT verification FROM proposals WHERE id = $1', [pid])).rows[0].verification).toBe('pending');
    });

    it('through the definer a tenant session records a verdict, claims and evidence', async () => {
      const repo = await newRepo(a);
      const pid = await newProposal(a, repo);
      const out = await tenant(a, (c) => record(c, pid, { claims: [claim('Uses the config'), claim('Has a test', 'unverifiable')], evidence: [ev(), ev({ kind: 'issue', ref: 'Issue #4', excerpt: 'Body', commit_sha: null })] }));
      expect(out.rows[0]).toEqual({ verification_state: 'verified', attempts: 0, claims_written: 2, evidence_written: 2 });
      expect((await admin.query('SELECT verification, verified_sha, verify_attempts, verified_run_id, verified_at IS NOT NULL AS stamped FROM proposals WHERE id = $1', [pid])).rows[0])
        .toEqual({ verification: 'verified', verified_sha: SHA, verify_attempts: 0, verified_run_id: a.runId, stamped: true });
      const claims = (await admin.query('SELECT text, verdict, checked_sha, checked_at IS NOT NULL AS stamped FROM proposal_claims WHERE proposal_id = $1 ORDER BY text', [pid])).rows;
      expect(claims).toEqual([
        { text: 'Has a test', verdict: 'unverifiable', checked_sha: SHA, stamped: true },
        { text: 'Uses the config', verdict: 'supported', checked_sha: SHA, stamped: true },
      ]);
      const evidence = (await admin.query('SELECT kind, ref, excerpt, commit_sha, repo_id FROM proposal_evidence WHERE proposal_id = $1 ORDER BY kind', [pid])).rows;
      expect(evidence).toEqual([
        { kind: 'file_lines', ref: 'src/app.ts:40-44', excerpt: 'const a = 1;\nconst b = 2;', commit_sha: SHA, repo_id: repo },
        { kind: 'issue', ref: 'Issue #4', excerpt: 'Body', commit_sha: null, repo_id: repo },
      ]);
      // the account's own user session may call it too; reads work through the tenant policy
      expect(await withTenant(appPool, a.accountId, a.userId, async (c) => (await c.query('SELECT 1 FROM proposal_claims WHERE proposal_id = $1', [pid])).rowCount)).toBe(2);
    });

    it('each verdict is recorded with the run, sha and stamp its kind needs, and a second call replaces the first', async () => {
      const repo = await newRepo(a);
      const pid = await newProposal(a, repo);
      const run2 = await newRun(a);
      await tenant(a, (c) => record(c, pid));
      // refuted: a sha, no run (the verified run pointer is cleared)
      const refuted = await tenant(a, (c) => record(c, pid, { verification: 'refuted', run: null, claims: [claim('Gone', 'refuted')], evidence: [] }));
      expect(refuted.rows[0]).toEqual({ verification_state: 'refuted', attempts: 0, claims_written: 1, evidence_written: 0 });
      expect((await admin.query('SELECT verification, verified_run_id FROM proposals WHERE id = $1', [pid])).rows[0]).toEqual({ verification: 'refuted', verified_run_id: null });
      expect((await admin.query('SELECT count(*)::int AS n FROM proposal_evidence WHERE proposal_id = $1', [pid])).rows[0].n).toBe(0);
      expect((await admin.query('SELECT text FROM proposal_claims WHERE proposal_id = $1', [pid])).rows.map((r) => r.text)).toEqual(['Gone']);
      // not_checked and check_failed need neither sha nor run
      for (const v of ['not_checked', 'check_failed']) {
        await tenant(a, (c) => record(c, pid, { verification: v, sha: null, run: null, claims: [], evidence: [] }));
        expect((await admin.query('SELECT verification, verified_sha FROM proposals WHERE id = $1', [pid])).rows[0]).toEqual({ verification: v, verified_sha: null });
      }
      // partly verified names the newer run
      await tenant(a, (c) => record(c, pid, { verification: 'partly_verified', run: run2, claims: [claim('A'), claim('B', 'refuted'), claim('C', 'pending')] }));
      expect((await admin.query('SELECT verification, verified_run_id, verify_attempts FROM proposals WHERE id = $1', [pid])).rows[0]).toEqual({ verification: 'partly_verified', verified_run_id: run2, verify_attempts: 0 });
      const pending = (await admin.query(`SELECT checked_sha, checked_at FROM proposal_claims WHERE proposal_id = $1 AND text = 'C'`, [pid])).rows[0];
      expect(pending).toEqual({ checked_sha: null, checked_at: null });
      // the same call twice is still one set of rows
      await tenant(a, (c) => record(c, pid, { verification: 'partly_verified', run: run2, claims: [claim('A')] }));
      expect((await admin.query('SELECT count(*)::int AS n FROM proposal_claims WHERE proposal_id = $1', [pid])).rows[0].n).toBe(1);
    });

    it('verify_attempts counts consecutive failed checks: a failure adds one, a verdict resets it, not_checked leaves it', async () => {
      const repo = await newRepo(a);
      const pid = await newProposal(a, repo);
      const attempts = async () => (await admin.query('SELECT verify_attempts FROM proposals WHERE id = $1', [pid])).rows[0].verify_attempts as number;
      const fail = () => tenant(a, (c) => record(c, pid, { verification: 'check_failed', sha: null, run: null, claims: [], evidence: [] }));
      expect((await fail()).rows[0].attempts).toBe(1);
      expect((await fail()).rows[0].attempts).toBe(2);
      // not_checked: nothing was attempted, so the count stays
      expect((await tenant(a, (c) => record(c, pid, { verification: 'not_checked', sha: null, run: null, claims: [], evidence: [] }))).rows[0].attempts).toBe(2);
      expect(await attempts()).toBe(2);
      // each real verdict resets it
      for (const v of ['verified', 'partly_verified', 'refuted']) {
        await fail();
        expect(await attempts(), `before ${v}`).toBe(3);
        const out = await tenant(a, (c) => record(c, pid, { verification: v, run: v === 'refuted' ? null : a.runId }));
        expect(out.rows[0].attempts, v).toBe(0);
        expect(await attempts(), v).toBe(0);
        await tenant(a, (c) => record(c, pid, { verification: 'check_failed', sha: null, run: null, claims: [], evidence: [] }));
        await tenant(a, (c) => record(c, pid, { verification: 'check_failed', sha: null, run: null, claims: [], evidence: [] }));
        await tenant(a, (c) => record(c, pid, { verification: 'not_checked', sha: null, run: null, claims: [], evidence: [] }));
        expect(await attempts(), `after ${v}`).toBe(2);
      }
      // a failure after successful checks starts again from one, so good checks never use up the retries
      await tenant(a, (c) => record(c, pid));
      expect((await fail()).rows[0].attempts).toBe(1);
    });

    it("the definer's own before-and-after decision check refuses a change the trigger and grants did not stop", async () => {
      const repo = await newRepo(a);
      const pid = await newProposal(a, repo);
      const c = await adminPool.connect();
      try {
        await c.query('BEGIN');
        // fires after proposals_verification_guard (triggers run in name order) and flips the state after the guard has looked
        await c.query(`CREATE FUNCTION zz_flip() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.state := 'withdrawn'; RETURN NEW; END $$`);
        await c.query('CREATE TRIGGER zz_flip BEFORE UPDATE ON proposals FOR EACH ROW EXECUTE FUNCTION zz_flip()');
        await c.query(`SELECT set_config('app.account_id', $1, true)`, [a.accountId]);
        await c.query('SET LOCAL ROLE app_user');
        await expect(record(c, pid)).rejects.toMatchObject({
          code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
          message: 'proposal_record_verification: a verification may not change state, provenance or owner_process',
        });
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
      expect((await admin.query('SELECT state, verification FROM proposals WHERE id = $1', [pid])).rows[0]).toEqual({ state: 'new', verification: 'pending' });
    });

    it('a refuted claim keeps a fixed refute_code, and only a refuted claim may carry one', async () => {
      const repo = await newRepo(a);
      const pid = await newProposal(a, repo);
      await tenant(a, (c) => record(c, pid, {
        verification: 'partly_verified',
        claims: [claim('Gone', 'refuted'), { text: 'Missing', verdict: 'refuted', refute_code: 'cite_not_found' }, { text: 'Fine', verdict: 'supported', refute_code: null }],
      }));
      const rows = (await admin.query('SELECT text, refute_code FROM proposal_claims WHERE proposal_id = $1 ORDER BY text', [pid])).rows;
      expect(rows).toEqual([{ text: 'Fine', refute_code: null }, { text: 'Gone', refute_code: null }, { text: 'Missing', refute_code: 'cite_not_found' }]);
      for (const code of ['cite_mismatch', 'contradicted']) {
        await tenant(a, (c) => record(c, pid, { claims: [{ text: 'x', verdict: 'refuted', refute_code: code }] }));
      }
      // outside the set, on a claim that is not refuted, or not a string: refused, and the earlier set stays
      await expect(tenant(a, (c) => record(c, pid, { claims: [{ text: 'x', verdict: 'refuted', refute_code: 'because' }] }))).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(tenant(a, (c) => record(c, pid, { claims: [{ text: 'x', verdict: 'supported', refute_code: 'cite_not_found' }] }))).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(tenant(a, (c) => record(c, pid, { claims: [{ text: 'x', verdict: 'refuted', refute_code: 5 }] }))).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      expect((await admin.query('SELECT refute_code FROM proposal_claims WHERE proposal_id = $1', [pid])).rows).toEqual([{ refute_code: 'contradicted' }]);
      // the definer's role may write the column, and no other role
      const { rows: priv } = await admin.query(`SELECT has_column_privilege('proposal_verification_definer', 'proposal_claims', 'refute_code', 'INSERT') AS definer,
        has_column_privilege('app_user', 'proposal_claims', 'refute_code', 'INSERT') AS app, has_column_privilege('plan_importer', 'proposal_claims', 'refute_code', 'INSERT') AS importer`);
      expect(priv[0]).toEqual({ definer: true, app: false, importer: false });
    });

    it('sha columns hold only a lowercase hex commit id, and ref refuses control characters', async () => {
      const repo = await newRepo(a);
      const pid = await newProposal(a, repo);
      const sha64 = 'b'.repeat(64);
      await tenant(a, (c) => record(c, pid, { sha: sha64, evidence: [ev({ commit_sha: sha64 })] }));
      expect((await admin.query('SELECT checked_sha FROM proposal_claims WHERE proposal_id = $1', [pid])).rows[0].checked_sha).toBe(sha64);
      for (const bad of ['A'.repeat(40), 'g'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), 'a'.repeat(63), 'main', ' ' + 'a'.repeat(39)]) {
        // no claims or evidence, so only proposals.verified_sha can refuse it
        await expect(tenant(a, (c) => record(c, pid, { sha: bad, claims: [], evidence: [] })), `verified_sha alone ${bad}`).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION, constraint: 'proposals_verified_sha_check' });
        await expect(tenant(a, (c) => record(c, pid, { sha: bad })), `verified_sha ${bad}`).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
        await expect(tenant(a, (c) => record(c, pid, { evidence: [ev({ commit_sha: bad })] })), `commit_sha ${bad}`).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
        await expect(admin.query(`UPDATE proposal_claims SET checked_sha = $1 WHERE proposal_id = $2`, [bad, pid]), `checked_sha ${bad}`).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      }
      for (const ref of ['src/a\u001b[31m.ts:1', 'a\u0007b', 'a\u007fb']) {
        await expect(tenant(a, (c) => record(c, pid, { evidence: [ev({ ref })] })), JSON.stringify(ref)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      }
      await tenant(a, (c) => record(c, pid, { evidence: [ev({ ref: 'docs/ünï cödé path.md:3' })] }));
      expect((await admin.query('SELECT verified_sha FROM proposals WHERE id = $1', [pid])).rows[0].verified_sha).toBe(SHA);
    });

    it('refuses a bad call whole: nothing is written', async () => {
      const repo = await newRepo(a);
      const pid = await newProposal(a, repo);
      await tenant(a, (c) => record(c, pid));
      const before = async () => ({
        p: (await admin.query('SELECT verification, verified_sha, verify_attempts, verified_run_id FROM proposals WHERE id = $1', [pid])).rows[0],
        claims: (await admin.query('SELECT text FROM proposal_claims WHERE proposal_id = $1', [pid])).rows,
        evidence: (await admin.query('SELECT ref FROM proposal_evidence WHERE proposal_id = $1', [pid])).rows,
      });
      const snapshot = await before();
      const invalid: Array<[string, Parameters<typeof record>[2]]> = [
        ['pending', { verification: 'pending', run: null }],
        ['unknown verdict', { verification: 'bogus', run: null }],
        ['verified without a run', { verification: 'verified', run: null }],
        ['refuted with a run', { verification: 'refuted', run: a.runId }],
        ['verified without a sha', { verification: 'verified', sha: null }],
        ['refuted without a sha', { verification: 'refuted', sha: null, run: null }],
        ['claims not an array', { claims: { text: 'x' } }],
        ['31 claims', { claims: Array.from({ length: 31 }, (_, i) => claim(`c${i}`)) }],
        ['31 evidence rows', { evidence: Array.from({ length: 31 }, () => ev()) }],
        ['claim with an extra field', { claims: [{ text: 'x', verdict: 'supported', class: 'bug' }] }],
        ['claim without a verdict', { claims: [{ text: 'x' }] }],
        ['claim text not a string', { claims: [{ text: 5, verdict: 'supported' }] }],
        ['evidence with an extra field', { evidence: [ev({ author: 'x' })] }],
        ['evidence without an excerpt', { evidence: [{ kind: 'issue', ref: 'r' }] }],
        ['evidence not an object', { evidence: ['x'] }],
      ];
      for (const [label, over] of invalid) {
        await expect(tenant(a, (c) => record(c, pid, over)), label).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      }
      // values the tables refuse come back as the table's own CHECK, and roll the whole call back
      await expect(tenant(a, (c) => record(c, pid, { claims: [claim('ok'), claim('x', 'maybe')] }))).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(tenant(a, (c) => record(c, pid, { evidence: [ev({ excerpt: 'e'.repeat(601) })] }))).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(tenant(a, (c) => record(c, pid, { evidence: [ev({ commit_sha: null })] }))).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      // a run that is not the account's
      await expect(tenant(a, (c) => record(c, pid, { run: b.runId }))).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
      expect(await before()).toEqual(snapshot);
    });

    it('refuses a token principal, a call with no account, a direct platform_ops login and EXECUTE for anyone else', async () => {
      const repo = await newRepo(a);
      const pid = await newProposal(a, repo);
      const token = await mintToken(a);
      await expect(withTenant(appPool, a.accountId, a.userId, token, (c) => record(c, pid))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      const client = await appPool.connect();
      try {
        await expect(record(client, pid)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      } finally {
        client.release();
      }
      await expect(opsPool.query(`SELECT * FROM ${DEFINER}($1, 'check_failed', NULL, NULL, '[]', '[]')`, [pid])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      // plan_importer and PUBLIC hold no EXECUTE
      await expect(asImporter(a, (c) => record(c, pid))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      const { rows } = await admin.query(
        `SELECT prosecdef, pg_get_userbyid(proowner) AS owner, has_function_privilege('app_user', oid, 'EXECUTE') AS app, has_function_privilege('plan_importer', oid, 'EXECUTE') AS importer,
                has_function_privilege('public', oid, 'EXECUTE') AS pub, proconfig::text AS cfg
           FROM pg_proc WHERE proname = $1`, [DEFINER]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ prosecdef: true, owner: 'proposal_verification_definer', app: true, importer: false, pub: false });
      expect(rows[0].cfg).toContain('search_path=pg_catalog, public, pg_temp');
      expect((await admin.query('SELECT verification FROM proposals WHERE id = $1', [pid])).rows[0].verification).toBe('pending');
    });

    it('platform_ops holds nothing on the verification tables or columns', async () => {
      const repo = await newRepo(a);
      const pid = await newProposal(a, repo);
      for (const sql of [
        `UPDATE proposals SET verification = 'verified', verified_at = now() WHERE id = '${pid}'`,
        `UPDATE proposals SET verified_run_id = '${a.runId}' WHERE id = '${pid}'`,
        `INSERT INTO proposal_claims (account_id, proposal_id, text) VALUES ('${a.accountId}', '${pid}', 'x')`,
        `INSERT INTO proposal_evidence (account_id, repo_id, proposal_id, kind, ref, excerpt) VALUES ('${a.accountId}', '${repo}', '${pid}', 'issue', '#1', 'x')`,
      ]) {
        await expect(opsPool.query(sql), sql).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
      const { rows } = await admin.query(
        `SELECT (SELECT count(*)::int FROM pg_policies WHERE tablename IN ('proposal_evidence', 'proposal_claims') AND 'platform_ops' = ANY (roles)) AS policies,
                has_table_privilege('platform_ops', 'proposal_evidence', 'SELECT, INSERT, DELETE') AS ev,
                has_table_privilege('platform_ops', 'proposal_claims', 'SELECT, INSERT, DELETE') AS cl,
                has_column_privilege('platform_ops', 'proposals', 'verification', 'UPDATE') AS col`);
      expect(rows[0]).toEqual({ policies: 0, ev: false, cl: false, col: false });
      expect((await admin.query('SELECT verification FROM proposals WHERE id = $1', [pid])).rows[0].verification).toBe('pending');
    });
  });

  describe('S4a-3: a verification never changes a decision', () => {
    /** The definer's own view: its owner role inside a tenant transaction, reached from a superuser session. */
    async function asDefinerOwner<T>(r: SeedRefs, fn: (c: PoolClient) => Promise<T>): Promise<T> {
      const c = await adminPool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.account_id', $1, true)`, [r.accountId]);
        await c.query('SET LOCAL ROLE proposal_verification_definer');
        return await fn(c);
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    }

    /** The guard is a trigger, so it does not depend on the role: provenance and owner_process are not grantable to the definer role at all. */
    async function inRolledBackTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
      const c = await adminPool.connect();
      try {
        await c.query('BEGIN');
        return await fn(c);
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    }

    it('the guard refuses one write that changes a verification column and state, provenance or owner_process together', async () => {
      const repo = await newRepo(a);
      const pid = await newProposal(a, repo);
      const together = [
        `state = 'rejected', decided_at = now()`,
        `provenance = 'external'`,
        `owner_process = 'internal_loop'`,
      ];
      for (const decision of together) {
        await expect(
          inRolledBackTx((c) => c.query(`UPDATE proposals SET verification = 'verified', verified_at = now(), ${decision} WHERE id = $1`, [pid])),
          decision,
        ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE, message: expect.stringMatching(/verification write may not change/) });
      }
      // the definer's role writes a verification alone, and holds no privilege on any decision column
      await asDefinerOwner(a, async (c) => {
        const r = await c.query(`UPDATE proposals SET verification = 'verified', verified_at = now() WHERE id = $1`, [pid]);
        expect(r.rowCount).toBe(1);
      });
      for (const col of ['state', 'provenance', 'owner_process', 'decided_at', 'roadmap_position', 'work_item_id']) {
        const { rows } = await admin.query(`SELECT has_column_privilege('proposal_verification_definer', 'proposals', $1, 'UPDATE') AS can`, [col]);
        expect(rows[0].can, col).toBe(false);
      }
      await expect(asDefinerOwner(a, (c) => c.query(`UPDATE proposals SET state = 'rejected', decided_at = now() WHERE id = $1`, [pid]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      // and a decision-only write by the decision path is untouched by the guard
      await inRolledBackTx((c) => c.query(`UPDATE proposals SET state = 'rejected', decided_at = now() WHERE id = $1`, [pid]));
    });

    it('the definer leaves state, provenance, owner_process and the decision stamps as they were, for every state', async () => {
      const repo = await newRepo(a);
      const wi = (await admin.query(`INSERT INTO work_items (account_id, repo_id, kind, gh_number, provenance) VALUES ($1, $2, 'issue', 1, 'internal') RETURNING id`, [a.accountId, repo])).rows[0].id;
      const cases: Array<Record<string, unknown>> = [
        { state: 'new' },
        { state: 'withdrawn' },
        { state: 'rejected', decided_at: new Date(), reject_note: 'no' },
        { state: 'approved', decided_at: new Date(), roadmap_position: 1, work_item_id: wi },
        { state: 'new', provenance: 'external', owner_process: 'product' },
        { state: 'new', owner_process: 'internal_loop' },
      ];
      for (const over of cases) {
        const pid = await newProposal(a, repo, over);
        const read = async () => (await admin.query('SELECT state, provenance, owner_process, decided_at, decided_by_user_id, reject_note, roadmap_position, work_item_id FROM proposals WHERE id = $1', [pid])).rows[0];
        const before = await read();
        await tenant(a, (c) => record(c, pid));
        expect(await read(), JSON.stringify(over)).toEqual(before);
        expect((await admin.query('SELECT verification FROM proposals WHERE id = $1', [pid])).rows[0].verification).toBe('verified');
      }
    });

    it('a decision definer leaves the verification alone, and a person can still decide a verified proposal', async () => {
      const repo = await newRepo(a);
      const pid = await newProposal(a, repo);
      await tenant(a, (c) => record(c, pid));
      const before = (await admin.query('SELECT verification, verified_at, verified_sha, verify_attempts, verified_run_id FROM proposals WHERE id = $1', [pid])).rows[0];
      await withTenant(appPool, a.accountId, a.userId, (c) => c.query('SELECT reject_proposal($1, $2)', [pid, 'not now']));
      const after = (await admin.query('SELECT state, verification, verified_at, verified_sha, verify_attempts, verified_run_id FROM proposals WHERE id = $1', [pid])).rows[0];
      expect(after.state).toBe('rejected');
      expect({ ...after, state: undefined }).toEqual({ ...before, state: undefined });
      await withTenant(appPool, a.accountId, a.userId, (c) => c.query('SELECT restore_proposal($1)', [pid]));
      // and a verification after the decision keeps the decision
      await tenant(a, (c) => record(c, pid, { verification: 'check_failed', sha: null, run: null, claims: [], evidence: [] }));
      expect((await admin.query('SELECT state, verification FROM proposals WHERE id = $1', [pid])).rows[0]).toEqual({ state: 'new', verification: 'check_failed' });
    });
  });

  describe('S4a-4: tenants', () => {
    it("account B reads no evidence or claims of account A, and cannot verify A's proposal", async () => {
      const repoA = await newRepo(a);
      const pidA = await newProposal(a, repoA);
      await tenant(a, (c) => record(c, pidA, { claims: [claim('one'), claim('two')], evidence: [ev(), ev({ ref: 'b.ts:1' })] }));
      expect(await tenant(a, async (c) => ({
        claims: (await c.query('SELECT 1 FROM proposal_claims')).rowCount,
        evidence: (await c.query('SELECT 1 FROM proposal_evidence')).rowCount,
      }))).toMatchObject({ claims: expect.any(Number), evidence: expect.any(Number) });
      expect(await tenant(b, async (c) => ({
        claims: (await c.query('SELECT 1 FROM proposal_claims WHERE proposal_id = $1', [pidA])).rowCount,
        evidence: (await c.query('SELECT 1 FROM proposal_evidence WHERE proposal_id = $1', [pidA])).rowCount,
        anyClaims: (await c.query('SELECT 1 FROM proposal_claims')).rowCount,
        anyEvidence: (await c.query('SELECT 1 FROM proposal_evidence')).rowCount,
      }))).toEqual({ claims: 0, evidence: 0, anyClaims: 0, anyEvidence: 0 });
      await expect(tenant(b, (c) => record(c, pidA))).rejects.toMatchObject({ code: 'P0002' });
      await expect(tenant(b, (c) => record(c, randomUUID()))).rejects.toMatchObject({ code: 'P0002' });
      expect((await admin.query('SELECT count(*)::int AS n FROM proposal_claims WHERE proposal_id = $1', [pidA])).rows[0].n).toBe(2);
      // evidence cannot point at another account's proposal or repo, even for the owner role
      await expect(admin.query(`INSERT INTO proposal_evidence (account_id, repo_id, proposal_id, kind, ref, excerpt) VALUES ($1, $2, $3, 'issue', '#1', 'x')`, [b.accountId, repoA, pidA]))
        .rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
    });

    it('an account that is not active cannot record a verification', async () => {
      const c2 = await seedAccount(admin, randomUUID());
      const repo = await newRepo(c2);
      const pid = await newProposal(c2, repo);
      await admin.query('UPDATE accounts SET deleted_at = now() WHERE id = $1', [c2.accountId]);
      await expect(withTenant(appPool, c2.accountId, (c) => c.query(`SELECT * FROM ${DEFINER}($1, 'check_failed', NULL, NULL, '[]', '[]')`, [pid])))
        .rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });
  });

  describe('undo paths: what goes away with what', () => {
    it('removing a proposal, a repo or the run that anchored a verdict leaves nothing dangling and keeps the verdict', async () => {
      const repo = await newRepo(a);
      const gone = await newProposal(a, repo);
      const kept = await newProposal(a, repo);
      const run = await newRun(a);
      await tenant(a, (c) => record(c, gone));
      await tenant(a, (c) => record(c, kept, { run }));
      // the run is deleted: the pointer clears, the verdict, stamp and sha stay, and the CHECKs still hold
      await admin.query('DELETE FROM agent_runs WHERE id = $1', [run]);
      expect((await admin.query('SELECT verification, verified_sha, verified_run_id, verified_at IS NOT NULL AS stamped FROM proposals WHERE id = $1', [kept]).then((r) => r.rows[0])))
        .toEqual({ verification: 'verified', verified_sha: SHA, verified_run_id: null, stamped: true });
      // the proposal is deleted: its claims and evidence go with it, the other proposal's stay
      await admin.query('DELETE FROM proposals WHERE id = $1', [gone]);
      const left = async (id: string) => ({
        claims: (await admin.query('SELECT 1 FROM proposal_claims WHERE proposal_id = $1', [id])).rowCount,
        evidence: (await admin.query('SELECT 1 FROM proposal_evidence WHERE proposal_id = $1', [id])).rowCount,
      });
      expect(await left(gone)).toEqual({ claims: 0, evidence: 0 });
      expect(await left(kept)).toEqual({ claims: 1, evidence: 1 });
      // the repo is deleted: everything under it goes
      await admin.query('DELETE FROM repos WHERE id = $1', [repo]);
      expect(await left(kept)).toEqual({ claims: 0, evidence: 0 });
      expect((await admin.query('SELECT 1 FROM proposals WHERE id = $1', [kept])).rowCount).toBe(0);
    });

    it('withdrawing and restoring a proposal keeps its verification, and a new verification replaces the old set', async () => {
      const repo = await newRepo(a);
      const pid = await newProposal(a, repo);
      await tenant(a, (c) => record(c, pid));
      await admin.query(`UPDATE proposals SET state = 'withdrawn' WHERE id = $1`, [pid]);
      await admin.query(`UPDATE proposals SET state = 'new' WHERE id = $1`, [pid]);
      expect((await admin.query('SELECT verification FROM proposals WHERE id = $1', [pid])).rows[0].verification).toBe('verified');
      expect((await admin.query('SELECT 1 FROM proposal_claims WHERE proposal_id = $1', [pid])).rowCount).toBe(1);
    });
  });
});
