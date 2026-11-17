import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { PG_ERROR } from './helpers/pgErrors.js';
import { insertRunner } from './helpers/runnerFixtures.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

const TABLES = ['onboarding_tracks', 'project_setups', 'runner_device_codes', 'project_drafts'] as const;
const hex = (bytes: number): string => randomBytes(bytes).toString('hex');
const row = (key: string, extra: Record<string, unknown> = {}) => ({ row_key: key, title: 'A title', summary: 'What it is', size: 'M', depends_on: [], keep: true, ...extra });
const FACTS = { os: 'linux', arch: 'x64', kvm: true, hostname: 'build-box-1', ip_country: 'DE' };

/** MC-1b (migration 1036): the onboarding and runner tables, their row security, their CHECKs and indexes, the engine release table and the two prunes. */
describe('onboarding tables [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let opsPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  let repoA2: string;
  let repoA3: string;
  let repoB2: string;
  let runnerA: string;
  let setupA1: string;
  let setupA2: string;
  let setupB: string;
  let approvedA: string;
  let approvedB: string;
  let pendingNull: string;
  /** Read before any test runs: a test that grants and then revokes a table privilege would also clear a column grant, and hide it from a later read. */
  const columnPrivileges: Record<string, boolean> = {};

  const asA = <T>(fn: (c: PoolClient) => Promise<T>) => withTenant(appPool, a.accountId, a.userId, fn);
  const asB = <T>(fn: (c: PoolClient) => Promise<T>) => withTenant(appPool, b.accountId, b.userId, fn);
  const setup = async (r: SeedRefs, repo: string, extra = ''): Promise<string> =>
    (await admin.query(`INSERT INTO project_setups (account_id, repo_id, kind, created_by ${extra ? ', ' + extra.split('=')[0] : ''}) VALUES ($1, $2, 'existing', $3 ${extra ? ', ' + extra.split('=')[1] : ''}) RETURNING id`, [r.accountId, repo, r.userId])).rows[0].id;
  const draft = (r: SeedRefs, repo: string, setupId: string | null, over: { prd?: string; roadmap?: unknown; version?: number; status?: string; final?: string; approved?: boolean } = {}): Promise<unknown> =>
    admin.query(
      `INSERT INTO project_drafts (account_id, repo_id, setup_id, source, prd_md, roadmap, version, status, approved_by, approved_at, final_at)
       VALUES ($1, $2, $3, 'survey', $4, $5::jsonb, $6, $7, $8, $9, $10)`,
      [r.accountId, repo, setupId, over.prd ?? 'a plan', JSON.stringify(over.roadmap ?? []), over.version ?? 1, over.status ?? 'draft', over.approved ? r.userId : null, over.approved ? new Date() : null, over.final ?? null],
    );
  /** A device code as the admin role writes it. `created`/`expires` are SQL expressions so a test can place a row in the past. */
  const code = (o: { account?: SeedRefs; status?: string; created?: string; expires?: string; device?: string; user?: string; jkt?: string; facts?: unknown; jwk?: unknown } = {}): Promise<{ rows: Array<{ id: string }> }> =>
    admin.query(
      `INSERT INTO runner_device_codes (account_id, device_code_hash, user_code_hash, jkt, public_key_jwk, facts, status, approved_by, approved_at, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, ${o.created ?? 'now()'}, ${o.expires ?? `now() + interval '10 minutes'`}) RETURNING id`,
      [o.account?.accountId ?? null, o.device ?? hex(32), o.user ?? hex(32), o.jkt ?? randomBytes(32).toString('base64url'), JSON.stringify(o.jwk ?? { kty: 'OKP', crv: 'Ed25519', x: 'abc' }), JSON.stringify(o.facts ?? FACTS), o.status ?? 'pending', o.account ? o.account.userId : null, o.account ? new Date() : null],
    );

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    for (const p of ['INSERT', 'UPDATE']) columnPrivileges[p] = (await admin.query(`SELECT has_any_column_privilege('app_user', 'runner_device_codes', $1) AS ok`, [p])).rows[0].ok;
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    repoA2 = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, 2, 'team')`, [repoA2, a.accountId, a.installationId]);
    repoA3 = randomUUID();
    repoB2 = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, 3, 'team'), ($4, $5, $6, 4, 'team')`, [repoA3, a.accountId, a.installationId, repoB2, b.accountId, b.installationId]);
    runnerA = await insertRunner(admin, a.accountId, a.userId);
    await admin.query(`INSERT INTO onboarding_tracks (account_id, track, chosen_by) VALUES ($1, 'engine', $2), ($3, 'pipeline', $4)`, [a.accountId, a.userId, b.accountId, b.userId]);
    setupA1 = await setup(a, a.repoId);
    setupA2 = await setup(a, repoA2);
    setupB = await setup(b, b.repoId);
    await draft(a, a.repoId, setupA1);
    await draft(a, repoA2, setupA2);
    await draft(b, b.repoId, setupB);
    approvedA = (await code({ account: a, status: 'approved' })).rows[0].id;
    approvedB = (await code({ account: b, status: 'approved' })).rows[0].id;
    pendingNull = (await code()).rows[0].id;
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, appPool, opsPool]) await p.end();
  });

  describe('row security', () => {
    it.each(TABLES)('%s: an account reads only its own rows, with an explicit account predicate, and a foreign account id reads 0', async (t) => {
      const own = await asA((c) => c.query(`SELECT count(*)::int AS n FROM ${t} WHERE account_id = $1`, [a.accountId]));
      expect(own.rows[0].n).toBeGreaterThan(0);
      const foreign = await asA((c) => c.query(`SELECT count(*)::int AS n FROM ${t} WHERE account_id = $1`, [b.accountId]));
      expect(foreign.rows[0].n).toBe(0);
      const unfiltered = await asA((c) => c.query(`SELECT DISTINCT account_id FROM ${t}`));
      expect(unfiltered.rows).toEqual([{ account_id: a.accountId }]);
    });

    it('the same account\'s second repo has its own setup and draft: a read for one repo never returns the other\'s', async () => {
      const s = await asA((c) => c.query(`SELECT id FROM project_setups WHERE account_id = $1 AND repo_id = $2`, [a.accountId, repoA2]));
      expect(s.rows).toEqual([{ id: setupA2 }]);
      const d = await asA((c) => c.query(`SELECT setup_id FROM project_drafts WHERE account_id = $1 AND repo_id = $2`, [a.accountId, a.repoId]));
      expect(d.rows).toEqual([{ setup_id: setupA1 }]);
    });

    it('through the RLS-bypassing admin client, a foreign account id with the other account\'s repo reads 0 rows, and the right account reads the row', async () => {
      for (const t of ['project_setups', 'project_drafts']) {
        expect((await admin.query(`SELECT 1 FROM ${t} WHERE account_id = $1 AND repo_id = $2`, [b.accountId, a.repoId])).rows).toHaveLength(0);
        expect((await admin.query(`SELECT 1 FROM ${t} WHERE account_id = $1 AND repo_id = $2`, [a.accountId, a.repoId])).rows).toHaveLength(1);
      }
      expect((await admin.query(`SELECT 1 FROM runner_device_codes WHERE account_id = $1 AND id = $2`, [b.accountId, approvedA])).rows).toHaveLength(0);
      expect((await admin.query(`SELECT 1 FROM onboarding_tracks WHERE account_id = $1 AND track = 'engine'`, [b.accountId])).rows).toHaveLength(0);
    });

    it('a write into another account is refused, and so is naming another account\'s repo or setup', async () => {
      await expect(asB((c) => c.query(`INSERT INTO onboarding_tracks (account_id, track, chosen_by) VALUES ($1, 'engine', $2)`, [a.accountId, b.userId]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(asB((c) => c.query(`INSERT INTO project_setups (account_id, repo_id, kind, created_by) VALUES ($1, $2, 'new', $3)`, [a.accountId, repoA2, b.userId]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(setup(a, repoB2)).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
      await expect(draft(a, a.repoId, setupB, { version: 9 })).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
      // The same account's setup for a different repo is refused too: a draft names a setup of its own repo only.
      await expect(draft(a, a.repoId, setupA2, { version: 10 })).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
      await expect(setup(a, repoA3, `runner_id='${randomUUID()}'`)).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
    });

    it('the app role can write its own tracks, setups and drafts', async () => {
      await asA((c) => c.query(`UPDATE onboarding_tracks SET chosen_at = now() WHERE account_id = $1 AND track = 'engine'`, [a.accountId]));
      await asA((c) => c.query(`UPDATE project_setups SET sub_step = 'mirror', runner_id = $3, updated_at = now() WHERE account_id = $1 AND id = $2`, [a.accountId, setupA1, runnerA]));
      await asA((c) => c.query(`UPDATE project_drafts SET prd_md = 'edited' WHERE account_id = $1 AND setup_id = $2`, [a.accountId, setupA1]));
      await asA((c) => c.query(`INSERT INTO project_drafts (account_id, repo_id, source, version) VALUES ($1, $2, 'blank', 2)`, [a.accountId, a.repoId]));
    });
  });

  describe('onboarding_tracks and project_setups', () => {
    it('one row per account and track, and only the two tracks', async () => {
      await expect(admin.query(`INSERT INTO onboarding_tracks (account_id, track, chosen_by) VALUES ($1, 'engine', $2)`, [a.accountId, a.userId])).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
      await expect(admin.query(`INSERT INTO onboarding_tracks (account_id, track, chosen_by) VALUES ($1, 'other', $2)`, [a.accountId, a.userId])).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await admin.query(`INSERT INTO onboarding_tracks (account_id, track, chosen_by) VALUES ($1, 'pipeline', $2)`, [a.accountId, a.userId]);
    });

    it('one live setup per repo: a second live setup fails at the database; a finished one frees the repo; another repo is unaffected', async () => {
      await expect(setup(a, a.repoId)).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
      for (const phase of ['done', 'removed']) {
        await admin.query(`UPDATE project_setups SET phase = $2 WHERE id = $1`, [setupA1, phase]);
        const second = await setup(a, a.repoId);
        await expect(setup(a, a.repoId)).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
        await admin.query(`DELETE FROM project_setups WHERE id = $1`, [second]);
      }
      await admin.query(`UPDATE project_setups SET phase = 'plan' WHERE id = $1`, [setupA1]);
      await expect(setup(b, b.repoId)).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
    });

    it('naming another account\'s repo is a foreign key failure even while that repo has a live setup, so the live-setup index tells nothing across accounts', async () => {
      expect((await admin.query(`SELECT 1 FROM project_setups WHERE repo_id = $1 AND phase NOT IN ('done', 'removed')`, [b.repoId])).rows).toHaveLength(1);
      await expect(asA((c) => c.query(`INSERT INTO project_setups (account_id, repo_id, kind, created_by) VALUES ($1, $2, 'new', $3)`, [a.accountId, b.repoId, a.userId]))).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
    });

    it('every enum and code column refuses a value outside its list, and a failure code comes with its time', async () => {
      await admin.query(`UPDATE project_setups SET phase = 'done' WHERE id = $1`, [setupA2]);
      await expect(admin.query(`INSERT INTO project_setups (account_id, repo_id, kind, created_by) VALUES ($1, $2, 'other', $3)`, [a.accountId, repoA3, a.userId])).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      for (const bad of [`phase='nope'`, `state='nope'`, `sub_step='Bad Step'`, `failure_code='Not A Code'`, `engine_version='latest'`, `install_pr=0`, `attempt=0`]) {
        await expect(setup(a, repoA2, bad), bad).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      }
      await expect(setup(a, repoA2, `failure_code='mirror_failed'`)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(setup(a, repoA2, `failure_at=now()`)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await admin.query(`DELETE FROM project_setups WHERE account_id = $1 AND repo_id = $2 AND phase <> 'done'`, [a.accountId, repoA2]);
      await admin.query(`UPDATE project_setups SET phase = 'survey' WHERE id = $1`, [setupA2]);
    });
  });

  describe('runner_device_codes: definer-only while account_id is null', () => {
    it('the app role cannot select a row with no account, by any predicate or none, and sees an approved row of its own account only', async () => {
      expect((await asA((c) => c.query(`SELECT id FROM runner_device_codes WHERE account_id IS NULL`))).rows).toEqual([]);
      expect((await asA((c) => c.query(`SELECT id FROM runner_device_codes WHERE id = $1`, [pendingNull]))).rows).toEqual([]);
      expect((await asB((c) => c.query(`SELECT id FROM runner_device_codes WHERE id = $1`, [pendingNull]))).rows).toEqual([]);
      expect((await asA((c) => c.query(`SELECT id FROM runner_device_codes`))).rows).toEqual([{ id: approvedA }]);
      expect((await asA((c) => c.query(`SELECT id FROM runner_device_codes WHERE id = $1`, [approvedB]))).rows).toEqual([]);
    });

    it('the app role cannot update one: without a grant it is refused, and with UPDATE granted the policy still leaves the row untouched, even when it tries to claim it', async () => {
      await expect(asA((c) => c.query(`UPDATE runner_device_codes SET status = 'approved' WHERE id = $1`, [pendingNull]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await admin.query(`GRANT UPDATE ON runner_device_codes TO app_user`);
      try {
        const r = await asA((c) => c.query(`UPDATE runner_device_codes SET attempts = 99 WHERE id = $1`, [pendingNull]));
        expect(r.rowCount).toBe(0);
        const claim = await asA((c) => c.query(`UPDATE runner_device_codes SET account_id = $2, approved_by = $3, approved_at = now(), status = 'approved' WHERE id = $1`, [pendingNull, a.accountId, a.userId]));
        expect(claim.rowCount).toBe(0);
      } finally {
        await admin.query(`REVOKE UPDATE ON runner_device_codes FROM app_user`);
      }
      const { rows } = await admin.query(`SELECT status, account_id, attempts FROM runner_device_codes WHERE id = $1`, [pendingNull]);
      expect(rows).toEqual([{ status: 'pending', account_id: null, attempts: 0 }]);
    });

    it('the app role cannot insert or delete, and cannot read the hashes, the key or the thumbprint of its own row', async () => {
      // Even a row that names its own account and arrives already approved: an app session must not be able to mint an approved code.
      await expect(asA((c) => c.query(`INSERT INTO runner_device_codes (account_id, status, approved_by, approved_at, device_code_hash, user_code_hash, jkt, public_key_jwk, facts, expires_at) VALUES ($5, 'approved', $6, now(), $1, $2, $3, '{}', $4, now() + interval '5 minutes')`, [hex(32), hex(32), randomBytes(32).toString('base64url'), JSON.stringify(FACTS), a.accountId, a.userId]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(asA((c) => c.query(`DELETE FROM runner_device_codes WHERE id = $1`, [approvedA]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      for (const col of ['device_code_hash', 'user_code_hash', 'jkt', 'public_key_jwk', 'attempts', '*']) {
        await expect(asA((c) => c.query(`SELECT ${col} FROM runner_device_codes WHERE account_id = $1`, [a.accountId])), col).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
      const { rows } = await asA((c) => c.query(`SELECT status, facts FROM runner_device_codes WHERE account_id = $1`, [a.accountId]));
      expect(rows).toEqual([{ status: 'approved', facts: FACTS }]);
    });

    it('a plaintext code cannot be stored: only a 64-character lowercase hex hash is accepted', async () => {
      for (const [device, user] of [['fxrd_' + 'a'.repeat(43), hex(32)], [hex(32), 'BCDF-GHJK'], [hex(31), hex(32)], [hex(32), hex(32).toUpperCase()]]) {
        await expect(code({ device, user }), `${device} ${user}`).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      }
      const dup = hex(32);
      await code({ device: dup });
      await expect(code({ device: dup })).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
      await expect(code({ user: dup })).resolves.toBeTruthy();
      await expect(code({ user: dup })).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
    });

    it('a code lives at most 10 minutes', async () => {
      await expect(code({ expires: `now() + interval '11 minutes'` })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(code({ created: `now()`, expires: `now() - interval '1 second'` })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await code({ expires: `now() + interval '10 minutes'`, created: `now()` });
    });

    it('a pending code has no account; an approved or consumed one has an account, an approver and a time', async () => {
      await expect(code({ account: a, status: 'pending' })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      for (const status of ['approved', 'consumed']) {
        await expect(code({ status })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
        await code({ account: a, status });
      }
      await code({ status: 'denied' });
      await code({ status: 'expired' });
    });

    it('the facts are closed: no extra key, no missing required one, plain short values only', async () => {
      const bad: unknown[] = [
        { ...FACTS, extra: 1 }, { os: 'linux', arch: 'x64' }, { ...FACTS, kvm: 'yes' }, { ...FACTS, ip_country: 'de' }, { ...FACTS, ip_country: 'DEU' },
        { ...FACTS, hostname: 'has space' }, { ...FACTS, hostname: 'line\nbreak' }, { ...FACTS, hostname: 'a'.repeat(64) }, { ...FACTS, os: 'Linux' }, { ...FACTS, arch: 5 },
        [], 'text',
      ];
      for (const facts of bad) await expect(code({ facts }), JSON.stringify(facts)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await code({ facts: { os: 'darwin', arch: 'arm64', kvm: false } });
    });

    it('the key and its thumbprint have a fixed shape', async () => {
      await expect(code({ jkt: 'short' })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(code({ jwk: [] })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(code({ jwk: { x: 'a'.repeat(1100) } })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });
  });

  describe('project_drafts', () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => row(`R${i}`));
    let v = 100;
    const ok = (roadmap: unknown) => draft(a, a.repoId, null, { roadmap, version: ++v });
    const refused = (roadmap: unknown) => expect(draft(a, a.repoId, null, { roadmap, version: ++v }), JSON.stringify(roadmap).slice(0, 80)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });

    it('accepts a closed roadmap: none, one, and the 200-row edge', async () => {
      await ok([]);
      await ok([row('ON-1', { depends_on: ['MC-1B'], summary: '' })]);
      await ok(rows(200));
    });

    it('refuses a roadmap that is not closed', async () => {
      await refused(rows(201));
      await refused({ rows: [] });
      await refused([row('A'), row('A')]);
      await refused([row('a1')]);
      await refused([row('1A')]);
      await refused([row('A'.repeat(17))]);
      await refused([row('A', { extra: 1 })]);
      await refused([{ row_key: 'A', title: 't', summary: 's', size: 'M', depends_on: [] }]);
      await refused([row('A', { title: '' })]);
      await refused([row('A', { title: 't'.repeat(121) })]);
      await refused([row('A', { summary: 's'.repeat(501) })]);
      await refused([row('A', { size: 'XL' })]);
      await refused([row('A', { keep: 'yes' })]);
      await refused([row('A', { title: 5 })]);
      await refused([row('A', { depends_on: 'B' })]);
      await refused([row('A', { depends_on: Array.from({ length: 11 }, (_, i) => `D${i}`) })]);
      await refused([row('A', { depends_on: ['not a key'] })]);
      await refused([row('A', { depends_on: [7] })]);
      await refused(['A']);
      await ok([row('A', { title: 't'.repeat(120), summary: 's'.repeat(500), depends_on: Array.from({ length: 10 }, (_, i) => `D${i}`) })]);
    });

    it('the PRD is at most 200,000 characters', async () => {
      await draft(a, a.repoId, null, { prd: 'x'.repeat(200000), version: ++v });
      await expect(draft(a, a.repoId, null, { prd: 'x'.repeat(200001), version: ++v })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });

    it('approval and finality stamps agree with the status, and a repo has one draft per version', async () => {
      // The stamp is made on this machine and created_at on the server: a minute ahead keeps the final-after-created check out of this test.
      const soon = (): string => new Date(Date.now() + 60000).toISOString();
      await expect(draft(a, a.repoId, null, { status: 'approved', final: soon(), version: ++v })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(draft(a, a.repoId, null, { status: 'approved', approved: true, version: ++v })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(draft(a, a.repoId, null, { status: 'draft', approved: true, final: soon(), version: ++v })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(draft(a, a.repoId, null, { status: 'nope', version: ++v })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await draft(a, a.repoId, null, { status: 'approved', approved: true, final: soon(), version: ++v });
      await draft(a, a.repoId, null, { status: 'discarded', final: soon(), version: ++v });
      await expect(draft(a, a.repoId, null, { version: v })).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
      await draft(a, repoA2, null, { version: v });
    });

    it('a draft cannot be final before it was created, so a backdated stamp cannot be stored', async () => {
      const before = new Date(Date.now() - 86400000).toISOString();
      await expect(draft(a, a.repoId, null, { status: 'discarded', final: before, version: ++v })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(admin.query(`UPDATE project_drafts SET status = 'discarded', final_at = created_at - interval '1 second' WHERE account_id = $1 AND repo_id = $2 AND version = 2`, [a.accountId, a.repoId])).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });
  });

  describe('engine_releases: a platform table', () => {
    const release = (version: string, over: Record<string, unknown> = {}) =>
      opsPool.query(`INSERT INTO engine_releases (version, commit_sha, tarball_sha256, min_runner_protocol, published_by) VALUES ($1, $2, $3, $4, $5)`, [version, over.sha ?? hex(20), over.tar ?? hex(32), over.proto ?? 3, over.by ?? 'publish-script']);

    it('every account\'s session can read it and cannot write it', async () => {
      await release('1.2.3');
      for (const as of [asA, asB]) {
        expect((await as((c) => c.query(`SELECT version FROM engine_releases WHERE version = '1.2.3'`))).rows).toEqual([{ version: '1.2.3' }]);
        await expect(as((c) => c.query(`INSERT INTO engine_releases (version, commit_sha, tarball_sha256, min_runner_protocol, published_by) VALUES ('9.9.9', $1, $2, 1, 'x')`, [hex(20), hex(32)]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
        await expect(as((c) => c.query(`UPDATE engine_releases SET withdrawn_at = now() WHERE version = '1.2.3'`))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
        await expect(as((c) => c.query(`DELETE FROM engine_releases WHERE version = '1.2.3'`))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
      expect((await admin.query(`SELECT count(*)::int AS n FROM engine_releases WHERE version = '9.9.9'`)).rows[0].n).toBe(0);
    });

    it('the publishing login can add a release and withdraw it, and change nothing else', async () => {
      await release('1.2.4');
      await opsPool.query(`UPDATE engine_releases SET withdrawn_at = now() WHERE version = '1.2.4'`);
      await expect(opsPool.query(`UPDATE engine_releases SET tarball_sha256 = $1 WHERE version = '1.2.4'`, [hex(32)])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(opsPool.query(`DELETE FROM engine_releases WHERE version = '1.2.4'`)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(opsPool.query(`UPDATE engine_releases SET withdrawn_at = now() - interval '1 year' WHERE version = '1.2.3'`)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });

    it('a version is unique and every field has a fixed shape', async () => {
      await expect(release('1.2.3')).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
      await expect(release('latest')).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(release('1.2.5', { sha: 'abc' })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(release('1.2.5', { tar: hex(31) })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(release('1.2.5', { proto: 0 })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(release('1.2.5', { by: '' })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });
  });

  describe('prunes', () => {
    const prune = (fn: string, n = 100) => opsPool.query(`SELECT ${fn}($1::int) AS n`, [n]).then((r) => Number(r.rows[0].n));
    const exists = async (t: string, id: string) => (await admin.query(`SELECT 1 FROM ${t} WHERE id = $1`, [id])).rows.length === 1;

    it('device codes: one goes 24 hours after it expired, whether or not it was ever approved; a newer one stays', async () => {
      const at = (hoursSinceExpiry: number) => ({ created: `now() - interval '${hoursSinceExpiry} hours' - interval '9 minutes'`, expires: `now() - interval '${hoursSinceExpiry} hours'` });
      const oldPending = (await code(at(25))).rows[0].id;
      const oldApproved = (await code({ ...at(30), account: b, status: 'consumed' })).rows[0].id;
      const recent = (await code(at(23))).rows[0].id;
      const live = (await code()).rows[0].id;
      expect(await prune('runner_device_codes_prune')).toBeGreaterThanOrEqual(2);
      expect(await exists('runner_device_codes', oldPending)).toBe(false);
      expect(await exists('runner_device_codes', oldApproved)).toBe(false);
      expect(await exists('runner_device_codes', recent)).toBe(true);
      expect(await exists('runner_device_codes', live)).toBe(true);
      expect(await exists('runner_device_codes', pendingNull)).toBe(true);
    });

    it('drafts: one goes 30 days after it became final; a draft in progress and a recent one stay', async () => {
      const mk = async (status: string, daysAgo: number | null): Promise<string> => {
        const r = await admin.query(
          `INSERT INTO project_drafts (account_id, repo_id, source, version, status, approved_by, approved_at, created_at, final_at)
           VALUES ($1, $2, 'blank', $3, $4, $5, $6, now() - interval '90 days', ${daysAgo === null ? 'NULL' : `now() - interval '${daysAgo} days'`}) RETURNING id`,
          [b.accountId, b.repoId, ++mkVersion, status, status === 'approved' ? b.userId : null, status === 'approved' ? new Date() : null],
        );
        return r.rows[0].id;
      };
      let mkVersion = 500;
      const old = await mk('approved', 31);
      const oldDiscarded = await mk('discarded', 45);
      const recent = await mk('approved', 29);
      const inProgress = await mk('draft', null);
      expect(await prune('project_drafts_prune')).toBe(2);
      expect(await exists('project_drafts', old)).toBe(false);
      expect(await exists('project_drafts', oldDiscarded)).toBe(false);
      expect(await exists('project_drafts', recent)).toBe(true);
      expect(await exists('project_drafts', inProgress)).toBe(true);
    });

    it('each takes a batch size in range and nothing else, and is not callable by the app role', async () => {
      for (const fn of ['runner_device_codes_prune', 'project_drafts_prune']) {
        await expect(prune(fn, 0)).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
        await expect(prune(fn, 10001)).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
        await expect(appPool.query(`SELECT ${fn}(10)`)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
    });

    /**
     * The policy and the function each bound the age. With the policy opened to `USING (true)` inside a transaction, only the function's own window is
     * left, so a row inside it must survive even at the largest batch.
     */
    const windowHolds = async (table: string, fn: string, insertYoung: () => Promise<string>): Promise<void> => {
      await admin.query('BEGIN');
      try {
        await admin.query(`DROP POLICY onboarding_ops_prune ON ${table}`);
        await admin.query(`CREATE POLICY onboarding_ops_prune ON ${table} FOR ALL TO onboarding_ops USING (true)`);
        const young = await insertYoung();
        await admin.query(`SELECT ${fn}(10000)`);
        expect((await admin.query(`SELECT 1 FROM ${table} WHERE id = $1`, [young])).rows).toHaveLength(1);
      } finally {
        await admin.query('ROLLBACK');
      }
      expect((await admin.query(`SELECT polqual IS NOT NULL AS has FROM pg_policy WHERE polname = 'onboarding_ops_prune' AND polrelid = '${table}'::regclass`)).rows).toEqual([{ has: true }]);
    };

    it('the device-code function keeps a code 23 hours past expiry on its own, with the policy opened', async () => {
      await windowHolds('runner_device_codes', 'runner_device_codes_prune', async () => (await code({ created: `now() - interval '23 hours' - interval '9 minutes'`, expires: `now() - interval '23 hours'` })).rows[0].id);
    });

    it('the draft function keeps a draft 29 days past final on its own, with the policy opened', async () => {
      await windowHolds('project_drafts', 'project_drafts_prune', async () =>
        (await admin.query(
          `INSERT INTO project_drafts (account_id, repo_id, source, version, status, created_at, final_at) VALUES ($1, $2, 'blank', 900, 'discarded', now() - interval '60 days', now() - interval '29 days') RETURNING id`,
          [b.accountId, b.repoId],
        )).rows[0].id);
    });

    it('a session with a tenant set prunes nothing (the policy needs no tenant)', async () => {
      const old = (await code({ created: `now() - interval '2 days'`, expires: `now() - interval '2 days' + interval '5 minutes'` })).rows[0].id;
      await admin.query(`SELECT set_config('app.account_id', $1, false)`, [a.accountId]);
      expect((await admin.query(`SELECT runner_device_codes_prune(10) AS n`)).rows[0].n).toBe(0);
      await admin.query(`SELECT set_config('app.account_id', '', false)`);
      expect(await exists('runner_device_codes', old)).toBe(true);
      expect((await admin.query(`SELECT runner_device_codes_prune(10) AS n`)).rows[0].n).toBeGreaterThanOrEqual(1);
    });
  });

  describe('privileges, read from the catalog (a missing grant and a row security refusal both answer 42501, so the layers are checked apart)', () => {
    const priv = async (sql: string, args: unknown[]): Promise<boolean> => (await admin.query(`SELECT ${sql} AS ok`, args)).rows[0].ok;

    it('the app role holds no write privilege of any kind on the device codes or the releases, and no column write on the device codes', async () => {
      for (const t of ['engine_releases', 'runner_device_codes']) {
        for (const p of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) expect(await priv('has_table_privilege($1, $2, $3)', ['app_user', t, p]), `${t} ${p}`).toBe(false);
      }
      expect(columnPrivileges, 'column privileges on runner_device_codes').toEqual({ INSERT: false, UPDATE: false });
    });

    it('the publishing login can add a release and withdraw it, and cannot delete one or change its tarball hash', async () => {
      expect(await priv('has_table_privilege($1, $2, $3)', ['platform_ops', 'engine_releases', 'INSERT'])).toBe(true);
      expect(await priv('has_table_privilege($1, $2, $3)', ['platform_ops', 'engine_releases', 'DELETE'])).toBe(false);
      expect(await priv('has_column_privilege($1, $2, $3, $4)', ['platform_ops', 'engine_releases', 'withdrawn_at', 'UPDATE'])).toBe(true);
      expect(await priv('has_column_privilege($1, $2, $3, $4)', ['platform_ops', 'engine_releases', 'tarball_sha256', 'UPDATE'])).toBe(false);
    });
  });

  describe('functions', () => {
    it('no new function is executable by PUBLIC', async () => {
      const { rows } = await admin.query(
        `SELECT p.proname FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname IN ('project_roadmap_valid', 'runner_device_facts_valid', 'runner_device_codes_prune', 'project_drafts_prune')
           AND EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')`,
      );
      expect(rows).toEqual([]);
    });
  });
});
