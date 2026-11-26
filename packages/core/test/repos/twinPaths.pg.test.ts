import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { ForbiddenError, NotFoundError } from '../../src/tenancy/errors.js';
import { InvalidRoleSettingsInputError } from '../../src/role-settings/errors.js';
import { withTenant } from '../../src/tenancy/withTenant.js';
import {
  addTwinInstallPaths, adoptTwinDraft, getTwinPaths, setTwinPaths, twinPrivateGlobs, TwinInstallPathsFullError, TwinPathsConflictError, TwinRemovedError, TWIN_FIXED_PRIVATE,
} from '../../src/repos/twinPaths.js';

/** [pg] D#845 ON-27a3: the app-side guards over the 1103 definers (rule files must be private, the revision, the error mapping), as the real app_user role. */
describe('twin paths, install paths and adopted draft (core) [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let A: SeedRefs;
  let B: SeedRefs;
  let memberA: string;

  const repoFor = async (acct: SeedRefs): Promise<string> => {
    const id = randomUUID();
    await admin.query('INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, $4, $5)', [id, acct.accountId, acct.installationId, Math.floor(Math.random() * 1e9) + 10, 'team']);
    return id;
  };
  const ctx = (acct: SeedRefs, userId = acct.userId) => ({ pool: appPool, principal: { accountId: acct.accountId, userId } });
  const twinFor = async (acct: SeedRefs) => {
    const pub = await repoFor(acct);
    const priv = await repoFor(acct);
    const r = await withTenant(appPool, acct.accountId, acct.userId, async (c: PoolClient) => (await c.query<{ o_id: string }>('SELECT o_id FROM twin_record($1, $2, 888, $3)', [pub, priv, 'w-private'])).rows[0]!);
    return { id: r.o_id, pub, priv };
  };
  const row = (key: string) => ({ row_key: key, title: `Row ${key}`, summary: 'Does a thing.', size: 'M', depends_on: [] as string[], keep: true });

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    A = await seedAccount(admin, randomUUID());
    B = await seedAccount(admin, randomUUID());
    memberA = randomUUID();
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [memberA, `${memberA}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [A.accountId, memberA]);
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appPool.end();
  });

  it('the private set is the fixed roots and secret defaults, then the overlay globs and the install paths', () => {
    expect(twinPrivateGlobs({ overlayGlobs: ['a/**'], installPaths: ['tools/x.sh'] })).toEqual([...TWIN_FIXED_PRIVATE, 'a/**', 'tools/x.sh']);
    expect(TWIN_FIXED_PRIVATE).toEqual(expect.arrayContaining(['.autonomous-team/**', '.claude/**', 'CLAUDE.md', 'CLAUDE.project.md', 'docs/PRD.md', 'epics/**', '.env', '.env.*', '**/*.pem', '**/*.key']));
  });

  it('a rule file under a fixed root needs no glob of its own; one outside the private set is refused, and the refusal is the app check (nothing is written)', async () => {
    const t = await twinFor(A);
    const p = await getTwinPaths(ctx(A), t.id);
    const ok = await setTwinPaths(ctx(A), t.id, p.revision, { identifierRulesPath: '.autonomous-team/ids.txt' });
    expect(ok.identifierRulesPath).toBe('.autonomous-team/ids.txt');
    await expect(setTwinPaths(ctx(A), t.id, ok.revision, { planDataRulesPath: 'public/rules.json' })).rejects.toMatchObject({ field: 'plan_data_rules_path' });
    const covered = await setTwinPaths(ctx(A), t.id, ok.revision, { overlayGlobs: ['public/**'], planDataRulesPath: 'public/rules.json' });
    expect(covered).toMatchObject({ overlayGlobs: ['public/**'], planDataRulesPath: 'public/rules.json' });
    // Dropping the glob that covers a declared rule file is refused.
    await expect(setTwinPaths(ctx(A), t.id, covered.revision, { overlayGlobs: [] })).rejects.toBeInstanceOf(InvalidRoleSettingsInputError);
    expect((await getTwinPaths(ctx(A), t.id)).overlayGlobs).toEqual(['public/**']);
  });

  it('a rule file that the install added is covered by the install paths', async () => {
    const t = await twinFor(A);
    await addTwinInstallPaths(appPool, A.accountId, t.id, ['tools/rules.txt']);
    const p = await getTwinPaths(ctx(A), t.id);
    expect((await setTwinPaths(ctx(A), t.id, p.revision, { identifierRulesPath: 'tools/rules.txt' })).identifierRulesPath).toBe('tools/rules.txt');
  });

  it('refuses bad shapes with the field named, and a stale revision with TwinPathsConflictError', async () => {
    const t = await twinFor(A);
    const p = await getTwinPaths(ctx(A), t.id);
    await expect(setTwinPaths(ctx(A), t.id, p.revision, { overlayGlobs: ['../x'] })).rejects.toMatchObject({ field: 'overlay_globs' });
    await expect(setTwinPaths(ctx(A), t.id, p.revision, { binaryGlobs: ['a', 'a'] })).rejects.toMatchObject({ field: 'binary_globs' });
    await expect(setTwinPaths(ctx(A), t.id, p.revision, { overlayGlobs: Array.from({ length: 101 }, (_, i) => `d${i}`) })).rejects.toMatchObject({ field: 'overlay_globs' });
    await expect(setTwinPaths(ctx(A), t.id, p.revision, { identifierRulesPath: 'rules/*.txt' })).rejects.toMatchObject({ field: 'identifier_rules_path' });
    await setTwinPaths(ctx(A), t.id, p.revision, { binaryGlobs: ['img/*.png'] });
    await expect(setTwinPaths(ctx(A), t.id, p.revision, { binaryGlobs: ['img/*.jpg'] })).rejects.toBeInstanceOf(TwinPathsConflictError);
    expect((await getTwinPaths(ctx(A), t.id)).binaryGlobs).toEqual(['img/*.png']);
  });

  it('owner or admin only, tenant-scoped, and a removed twin is TwinRemovedError', async () => {
    const t = await twinFor(A);
    await expect(getTwinPaths(ctx(A, memberA), t.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setTwinPaths(ctx(A, memberA), t.id, 'x', {})).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getTwinPaths(ctx(B), t.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(addTwinInstallPaths(appPool, B.accountId, t.id, ['a.txt'])).rejects.toBeInstanceOf(NotFoundError);
    await expect(adoptTwinDraft(ctx(B), t.id, randomUUID())).rejects.toBeInstanceOf(NotFoundError);
    const p = await getTwinPaths(ctx(A), t.id);
    await withTenant(appPool, A.accountId, A.userId, (c: PoolClient) => c.query(`SELECT * FROM twin_change($1, 'remove')`, [t.id]));
    await expect(setTwinPaths(ctx(A), t.id, p.revision, { overlayGlobs: ['x/**'] })).rejects.toBeInstanceOf(TwinRemovedError);
    await expect(addTwinInstallPaths(appPool, A.accountId, t.id, ['a.txt'])).rejects.toBeInstanceOf(TwinRemovedError);
  });

  it('install paths: a bad path is refused before the database, and 5,000 fits while one more is TwinInstallPathsFullError', async () => {
    const t = await twinFor(A);
    await expect(addTwinInstallPaths(appPool, A.accountId, t.id, ['ok.txt', 'g*lob'])).rejects.toMatchObject({ field: 'install_paths' });
    expect(await addTwinInstallPaths(appPool, A.accountId, t.id, Array.from({ length: 5000 }, (_, i) => `f/${i}.txt`))).toBe(5000);
    await expect(addTwinInstallPaths(appPool, A.accountId, t.id, ['one-more.txt'])).rejects.toBeInstanceOf(TwinInstallPathsFullError);
    await expect(addTwinInstallPaths(appPool, A.accountId, t.id, Array.from({ length: 5001 }, (_, i) => `g/${i}.txt`))).rejects.toBeInstanceOf(TwinInstallPathsFullError);
  });

  it('adopts the public repo plan: ok with the draft id, then bad_state; no_draft when there is nothing to carry', async () => {
    const t = await twinFor(A);
    const setup = randomUUID();
    await admin.query(`INSERT INTO project_setups (id, account_id, repo_id, kind, phase, created_by) VALUES ($1, $2, $3, 'existing', 'survey', $4)`, [setup, A.accountId, t.priv, A.userId]);
    expect(await adoptTwinDraft(ctx(A), t.id, setup)).toEqual({ ok: false, reason: 'no_draft' });
    await admin.query(`INSERT INTO project_drafts (account_id, repo_id, source, prd_md, roadmap, version) VALUES ($1, $2, 'interview', '# Plan', $3::jsonb, 1)`, [A.accountId, t.pub, JSON.stringify([row('A')])]);
    const r = await adoptTwinDraft(ctx(A), t.id, setup);
    expect(r).toEqual({ ok: true, draftId: expect.any(String) });
    expect(await adoptTwinDraft(ctx(A), t.id, setup)).toEqual({ ok: false, reason: 'bad_state' });
    await expect(adoptTwinDraft(ctx(A, memberA), t.id, setup)).rejects.toMatchObject({ code: '42501' });
  });
});
