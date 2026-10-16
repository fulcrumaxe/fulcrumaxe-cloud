import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { NotFoundError } from '../src/tenancy/errors.js';
import { withTenant } from '../src/tenancy/withTenant.js';
import { readStackParent, setStackParent, StackLinkError } from '../src/work-items/stackParent.js';
import { readStackParentPull } from '../src/work-items/stackParentPull.js';

/** D#598 P3a against a real Postgres cluster: the write path, its typed refusals, and that it is not limited to any one repo. */
describe('setStackParent (D#598 P3a)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  let secondRepo: string;

  async function item(account: SeedRefs, repoId: string | null): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, $3, 'feature', 'internal')`,
      [id, account.accountId, repoId],
    );
    return id;
  }

  const run = <T>(account: SeedRefs, fn: (c: PoolClient) => Promise<T>) => withTenant(appUserPool, account.accountId, fn);

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    secondRepo = randomUUID();
    await admin.query(
      `INSERT INTO repos (id, account_id, installation_id, gh_repo_id, gh_owner, gh_name, product) VALUES ($1, $2, $3, 4242, 'some-customer', 'their-app', 'team')`,
      [secondRepo, a.accountId, a.installationId],
    );
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  it('sets, reads, re-sets (no change) and clears a link', async () => {
    const parent = await item(a, a.repoId);
    const child = await item(a, a.repoId);
    expect(await run(a, (c) => readStackParent(c, child))).toBeNull();
    expect(await run(a, (c) => setStackParent(c, { workItemId: child, stackParentId: parent }))).toEqual({
      workItemId: child,
      stackParentId: parent,
      changed: true,
    });
    expect(await run(a, (c) => readStackParent(c, child))).toBe(parent);
    expect((await run(a, (c) => setStackParent(c, { workItemId: child, stackParentId: parent }))).changed).toBe(false);
    expect(await run(a, (c) => setStackParent(c, { workItemId: child, stackParentId: null }))).toEqual({
      workItemId: child,
      stackParentId: null,
      changed: true,
    });
    expect((await run(a, (c) => setStackParent(c, { workItemId: child, stackParentId: null }))).changed).toBe(false);
    expect(await run(a, (c) => readStackParent(c, child))).toBeNull();
  });

  it('works for a customer repo with its own name, no pairing and no special account (fixture customer repo)', async () => {
    const parent = await item(a, secondRepo);
    const child = await item(a, secondRepo);
    const res = await run(a, (c) => setStackParent(c, { workItemId: child, stackParentId: parent }));
    expect(res.changed).toBe(true);
    expect(await run(a, (c) => readStackParent(c, child))).toBe(parent);
  });

  it('refuses a cycle with code cycle and writes nothing', async () => {
    const x = await item(a, a.repoId);
    const y = await item(a, a.repoId);
    const z = await item(a, a.repoId);
    await run(a, (c) => setStackParent(c, { workItemId: y, stackParentId: x }));
    await run(a, (c) => setStackParent(c, { workItemId: z, stackParentId: y }));
    await expect(run(a, (c) => setStackParent(c, { workItemId: x, stackParentId: z }))).rejects.toMatchObject({
      name: 'StackLinkError',
      code: 'cycle',
    });
    expect(await run(a, (c) => readStackParent(c, x))).toBeNull();
  });

  it('refuses a parent in another repo with code cross_repo', async () => {
    const parent = await item(a, secondRepo);
    const child = await item(a, a.repoId);
    const err = await run(a, (c) => setStackParent(c, { workItemId: child, stackParentId: parent })).catch((e) => e);
    expect(err).toBeInstanceOf(StackLinkError);
    expect(err.code).toBe('cross_repo');
    expect(await run(a, (c) => readStackParent(c, child))).toBeNull();
  });

  it('refuses self and malformed ids before any query', async () => {
    const id = await item(a, a.repoId);
    await expect(run(a, (c) => setStackParent(c, { workItemId: id, stackParentId: id }))).rejects.toMatchObject({ code: 'self' });
    await expect(run(a, (c) => setStackParent(c, { workItemId: 'nope', stackParentId: null }))).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(run(a, (c) => setStackParent(c, { workItemId: id, stackParentId: 'nope' }))).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('another tenant\'s item and a missing item read as not found, on either end', async () => {
    const mine = await item(a, a.repoId);
    const theirs = await item(b, b.repoId);
    await expect(run(a, (c) => setStackParent(c, { workItemId: mine, stackParentId: theirs }))).rejects.toBeInstanceOf(NotFoundError);
    await expect(run(a, (c) => setStackParent(c, { workItemId: theirs, stackParentId: mine }))).rejects.toBeInstanceOf(NotFoundError);
    await expect(run(a, (c) => setStackParent(c, { workItemId: randomUUID(), stackParentId: null }))).rejects.toBeInstanceOf(NotFoundError);
    await expect(run(a, (c) => setStackParent(c, { workItemId: mine, stackParentId: randomUUID() }))).rejects.toBeInstanceOf(NotFoundError);
    await expect(run(a, (c) => readStackParent(c, theirs))).rejects.toBeInstanceOf(NotFoundError);
    expect(await run(a, (c) => readStackParent(c, mine))).toBeNull();
  });

  it('a deleted parent leaves the child unlinked (next run starts from main)', async () => {
    const parent = await item(a, a.repoId);
    const child = await item(a, a.repoId);
    await run(a, (c) => setStackParent(c, { workItemId: child, stackParentId: parent }));
    await admin.query(`DELETE FROM work_items WHERE id = $1`, [parent]);
    expect(await run(a, (c) => readStackParent(c, child))).toBeNull();
  });

  it("P3b: the parent's pull request number comes from the newest run that names one, and is null when none does (any repo, any account)", async () => {
    const parent = await item(a, secondRepo);
    const child = await item(a, secondRepo);
    expect(await run(a, (c) => readStackParentPull(c, child))).toBeNull();
    await run(a, (c) => setStackParent(c, { workItemId: child, stackParentId: parent }));
    expect(await run(a, (c) => readStackParentPull(c, child))).toEqual({ parentId: parent, parentRepoId: secondRepo, prNumber: null });
    const review = (n: number, at: string) =>
      admin.query(
        `INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, dispatch_repo_id, dispatch_pr_number, created_at) VALUES ($1, $2, 'code-reviewer', 'production', 'succeeded', $3, $4, $5)`,
        [a.accountId, parent, secondRepo, n, at],
      );
    await review(30, '2026-01-01T00:00:00Z');
    await review(31, '2026-01-02T00:00:00Z');
    expect(await run(a, (c) => readStackParentPull(c, child))).toMatchObject({ prNumber: 31 });
    // Another account cannot see the child at all.
    expect(await run(b, (c) => readStackParentPull(c, child))).toBeNull();
  });

  describe('no repo, plan or account gate on this path (static scan)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sources = [
      join(here, '../src/work-items/stackParent.ts'),
      join(here, '../src/work-items/stackParentPull.ts'),
      join(here, '../../db/migrations/0821_work_items_stack_parent.sql'),
    ];
    // Code only: comments may explain what the path does not do.
    function codeOf(path: string): string {
      return readFileSync(path, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((l) => l.replace(/^\s*--.*$/, '').replace(/\s\/\/.*$/, ''))
        .join('\n');
    }
    it.each(sources)('%s names no repo, no pairing, no plan and no account list', (path) => {
      const code = codeOf(path);
      expect(code).not.toMatch(/fulcrumaxe|code_repo|repo_pairing|gh_owner|gh_name|allowlist|plan_id|account_plan/i);
    });
  });
});
