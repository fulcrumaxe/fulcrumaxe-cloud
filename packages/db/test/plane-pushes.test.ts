import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * Migration 0831 (D#598 P1f-1): plane_pushes and plane_push_attempts, on a real Postgres with the whole migration chain applied.
 * Covers the unique token per (run, lease generation) for a runner, the cap of three push attempts, the generated branch name,
 * tenant isolation under the app role, and the guards that keep identity fixed.
 */
describe('plane_pushes and plane_push_attempts (migration 0831)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  const DIGEST = 'a'.repeat(64);

  async function freshItem(who: SeedRefs): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, $3, 'feature', 'internal')`, [id, who.accountId, who.repoId]);
    return id;
  }
  async function freshRun(who: SeedRefs, itemId: string): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'local', 'running')`, [id, who.accountId, itemId]);
    return id;
  }
  const insertPush = (who: SeedRefs, itemId: string, over: Record<string, unknown> = {}) => {
    const v = { code_repo: 'acme/pub', pairing_digest: DIGEST, ...over };
    return withTenant(appPool, who.accountId, who.userId, (c) =>
      c.query<{ id: string; branch: string; state: string }>(
        `INSERT INTO plane_pushes (account_id, work_item_id, repo_id, code_repo, pairing_digest) VALUES ($1, $2, $3, $4, $5) RETURNING id, branch, state`,
        [who.accountId, itemId, who.repoId, v.code_repo, v.pairing_digest],
      ),
    );
  };
  const insertAttempt = (who: SeedRefs, pushId: string, over: Record<string, unknown> = {}) => {
    const v = { run_id: null, lease_generation: null, runtime: 'sandbox', kind: 'push', attempt_no: 1, ...over };
    return withTenant(appPool, who.accountId, who.userId, (c) =>
      c.query(
        `INSERT INTO plane_push_attempts (account_id, plane_push_id, run_id, lease_generation, runtime, kind, attempt_no) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [who.accountId, pushId, v.run_id, v.lease_generation, v.runtime, v.kind, v.attempt_no],
      ),
    );
  };

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appPool.end();
  });

  it('stores a row with the generated branch fx/p-<id>, in the building state, one per item and paired repo', async () => {
    const item = await freshItem(a);
    const { rows } = await insertPush(a, item);
    expect(rows[0]!.state).toBe('building');
    expect(rows[0]!.branch).toBe(`fx/p-${rows[0]!.id}`);
    await expect(insertPush(a, item)).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
    // The same item may be paired with a second repo: that is a different row with its own branch.
    const second = await insertPush(a, item, { code_repo: 'acme/other' });
    expect(second.rows[0]!.branch).not.toBe(rows[0]!.branch);
  });

  it('the branch name cannot be written, and it cannot change', async () => {
    const item = await freshItem(a);
    const { rows } = await insertPush(a, item);
    await expect(
      withTenant(appPool, a.accountId, a.userId, (c) => c.query(`UPDATE plane_pushes SET branch = 'main' WHERE id = $1`, [rows[0]!.id])),
    ).rejects.toBeTruthy();
    await expect(
      withTenant(appPool, a.accountId, a.userId, (c) =>
        c.query(`INSERT INTO plane_pushes (account_id, work_item_id, repo_id, code_repo, pairing_digest, branch) VALUES ($1, $2, $3, 'acme/x', $4, 'main')`, [a.accountId, item, a.repoId, DIGEST]),
      ),
    ).rejects.toBeTruthy();
  });

  it('enforces the shapes in the database: repo name, digest, state, code, pr, pushed sha, refusal list', async () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ['no slash', { code_repo: 'widgets' }],
      ['a URL', { code_repo: 'https://github.com/a/b' }],
      ['a dot-dot name', { code_repo: 'acme/..' }],
      ['a short digest', { pairing_digest: 'abc' }],
      ['an upper-case digest', { pairing_digest: 'A'.repeat(64) }],
    ];
    for (const [label, over] of bad) {
      await expect(insertPush(a, await freshItem(a), over), label).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    }
    const item = await freshItem(a);
    const { rows } = await insertPush(a, item);
    const id = rows[0]!.id;
    const sha = 'b'.repeat(40);
    const upd = (set: string, params: unknown[] = []) => withTenant(appPool, a.accountId, a.userId, (c) => c.query(`UPDATE plane_pushes SET ${set} WHERE id = $1`, [id, ...params]));
    const refused: Array<[string, string, unknown[]?]> = [
      ['an unknown state', `state = 'nope'`],
      ['pushed without a head and tip', `state = 'pushed'`],
      ['pr_opened without a PR', `state = 'pr_opened', head_sha = '${sha}', tip_sha = '${sha}'`],
      ['a PR number without a url', `pr_number = 5`],
      ['a url that is not a github pull request', `pr_number = 5, pr_url = 'https://evil.example/a/b/pull/5'`],
      ['a refusal without a code', `state = 'refused'`],
      ['a code outside a refusal', `code = 'overlay_path'`],
      ['a code with spaces or capitals', `state = 'refused', code = 'Overlay Path'`],
      ['a short sha', `head_sha = 'abc'`],
      ['a short source head (migration 0909)', `source_head = 'abc'`],
      ['a refusals value that is not an array', `refusals = '{"a":1}'::jsonb`],
      ['101 refusals', `refusals = (SELECT jsonb_agg(jsonb_build_object('kind', 'x')) FROM generate_series(1, 101))`],
    ];
    for (const [label, set] of refused) await expect(upd(set), label).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    // The valid forms pass.
    await upd(`state = 'refused', code = 'overlay_path', refusals = (SELECT jsonb_agg(jsonb_build_object('kind', 'overlay_path', 'place', 'docs/a.md', 'rule_key', 'overlay')) FROM generate_series(1, 100))`);
    await upd(`state = 'pr_opened', code = NULL, head_sha = '${sha}', tip_sha = '${sha}', pr_number = 7, pr_url = 'https://github.com/acme/pub/pull/7'`);
    await upd(`source_head = '${sha}'`);
    const row = (await admin.query(`SELECT state, pr_number, head_sha, source_head FROM plane_pushes WHERE id = $1`, [id])).rows[0];
    expect(row).toMatchObject({ state: 'pr_opened', pr_number: 7, head_sha: sha, source_head: sha });
  });

  it('identity is fixed after insert (item, repos, owner), and updated_at moves', async () => {
    const item = await freshItem(a);
    const { rows } = await insertPush(a, item);
    const id = rows[0]!.id;
    for (const set of [`work_item_id = '${randomUUID()}'`, `code_repo = 'acme/else'`, `created_at = now() - interval '1 day'`]) {
      await expect(withTenant(appPool, a.accountId, a.userId, (c) => c.query(`UPDATE plane_pushes SET ${set} WHERE id = $1`, [id])), set).rejects.toBeTruthy();
    }
    const before = (await admin.query(`SELECT updated_at FROM plane_pushes WHERE id = $1`, [id])).rows[0].updated_at as Date;
    await new Promise((r) => setTimeout(r, 15));
    await withTenant(appPool, a.accountId, a.userId, (c) => c.query(`UPDATE plane_pushes SET state = 'scanning' WHERE id = $1`, [id]));
    const after = (await admin.query(`SELECT updated_at FROM plane_pushes WHERE id = $1`, [id])).rows[0].updated_at as Date;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it('refuses a second runner attempt for the same (run, lease generation), and allows another generation or another run', async () => {
    const item = await freshItem(a);
    const run = await freshRun(a, item);
    const { rows } = await insertPush(a, item);
    const id = rows[0]!.id;
    await insertAttempt(a, id, { runtime: 'runner', run_id: run, lease_generation: 1, attempt_no: 1 });
    await expect(insertAttempt(a, id, { runtime: 'runner', run_id: run, lease_generation: 1, attempt_no: 2 })).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
    await insertAttempt(a, id, { runtime: 'runner', run_id: run, lease_generation: 2, attempt_no: 2 });
    // The same pair on a second plane push row (another paired repo of the same item) is the same grant: refused too.
    const other = await insertPush(a, item, { code_repo: 'acme/other' });
    await expect(insertAttempt(a, other.rows[0]!.id, { runtime: 'runner', run_id: run, lease_generation: 1, attempt_no: 1 })).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
  });

  it('the (run, lease generation) rule is for runner attempts only: sandbox attempts of one run are not blocked by it', async () => {
    const item = await freshItem(a);
    const run = await freshRun(a, item);
    const { rows } = await insertPush(a, item);
    const id = rows[0]!.id;
    await insertAttempt(a, id, { runtime: 'sandbox', run_id: run, attempt_no: 1 });
    await insertAttempt(a, id, { runtime: 'sandbox', run_id: run, attempt_no: 2 });
    await expect(insertAttempt(a, id, { runtime: 'sandbox', run_id: run, attempt_no: 2 })).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
  });

  it('refuses a fourth push attempt for one row, and a runner attempt without a lease generation (or a sandbox one with)', async () => {
    const item = await freshItem(a);
    const { rows } = await insertPush(a, item);
    const id = rows[0]!.id;
    for (const n of [1, 2, 3]) await insertAttempt(a, id, { attempt_no: n });
    await expect(insertAttempt(a, id, { attempt_no: 4 })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    await expect(insertAttempt(a, id, { attempt_no: 0 })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    await expect(insertAttempt(a, id, { runtime: 'runner', run_id: null, lease_generation: null, attempt_no: 5, kind: 'pr_open' })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    await expect(insertAttempt(a, id, { runtime: 'sandbox', lease_generation: 1, attempt_no: 5, kind: 'pr_open' })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    // A hosted PR-open retry is a different kind and is not held to the push cap.
    await insertAttempt(a, id, { runtime: 'hosted', kind: 'pr_open', attempt_no: 4 });
    // Attempts are numbered per kind (0882): a pr_open row beside the three pushes can start from 1, and the same kind and number is still one row.
    await insertAttempt(a, id, { runtime: 'hosted', kind: 'pr_open', attempt_no: 1 });
    await expect(insertAttempt(a, id, { runtime: 'hosted', kind: 'pr_open', attempt_no: 1 })).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
  });

  it('an attempt keeps its identity, sets its token time once, and records token_revoked only after a token was issued', async () => {
    const item = await freshItem(a);
    const { rows } = await insertPush(a, item);
    const id = rows[0]!.id;
    await insertAttempt(a, id, { attempt_no: 1 });
    const upd = (set: string) => withTenant(appPool, a.accountId, a.userId, (c) => c.query(`UPDATE plane_push_attempts SET ${set} WHERE plane_push_id = $1 AND attempt_no = 1`, [id]));
    await expect(upd(`token_revoked = false`)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    await upd(`token_issued_at = now()`);
    await upd(`token_revoked = false, finished_at = now(), outcome = 'refused'`);
    await expect(upd(`token_issued_at = now() + interval '1 hour'`)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    await expect(upd(`attempt_no = 2`)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    await expect(upd(`outcome = 'Not Fixed Shape'`)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
  });

  it('a row from another account is invisible, unwritable and unreferenceable under the app role (RLS and composite keys)', async () => {
    const item = await freshItem(a);
    const { rows } = await insertPush(a, item);
    const id = rows[0]!.id;
    await insertAttempt(a, id, { attempt_no: 1 });
    const seenByB = await withTenant(appPool, b.accountId, b.userId, (c) => c.query(`SELECT id FROM plane_pushes WHERE id = $1`, [id]));
    expect(seenByB.rows).toHaveLength(0);
    const attemptsSeenByB = await withTenant(appPool, b.accountId, b.userId, (c) => c.query(`SELECT id FROM plane_push_attempts WHERE plane_push_id = $1`, [id]));
    expect(attemptsSeenByB.rows).toHaveLength(0);
    // B cannot update A's row (it matches nothing), and cannot insert a row stamped with A's account.
    const updated = await withTenant(appPool, b.accountId, b.userId, (c) => c.query(`UPDATE plane_pushes SET state = 'scanning' WHERE id = $1`, [id]));
    expect(updated.rowCount).toBe(0);
    await expect(
      withTenant(appPool, b.accountId, b.userId, (c) =>
        c.query(`INSERT INTO plane_pushes (account_id, work_item_id, repo_id, code_repo, pairing_digest) VALUES ($1, $2, $3, 'x/y', $4)`, [a.accountId, item, a.repoId, DIGEST]),
      ),
    ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    // B's own row cannot point at A's work item or repo (the composite foreign keys carry the account).
    await expect(insertPush(b, item)).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
    await expect(
      withTenant(appPool, b.accountId, b.userId, (c) =>
        c.query(`INSERT INTO plane_push_attempts (account_id, plane_push_id, runtime, kind, attempt_no) VALUES ($1, $2, 'sandbox', 'push', 2)`, [b.accountId, id]),
      ),
    ).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
  });

  it('privileges: the app role may read, insert and update but not delete; nobody else gets a grant', async () => {
    const { rows } = await admin.query<{ t: string; priv: string; ok: boolean }>(
      `SELECT t, priv, has_table_privilege('app_user', t, priv) AS ok
         FROM unnest(ARRAY['plane_pushes', 'plane_push_attempts']) AS t, unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS priv`,
    );
    for (const r of rows) expect(r.ok, `${r.t} ${r.priv}`).toBe(r.priv !== 'DELETE');
    const pub = await admin.query<{ relname: string; acl: string[] | null }>(`SELECT relname, relacl::text[] AS acl FROM pg_class WHERE relname IN ('plane_pushes', 'plane_push_attempts')`);
    for (const r of pub.rows) expect((r.acl ?? []).filter((x) => x.startsWith('=')), r.relname).toEqual([]);
  });

  it('is removed with its work item and with its account; a run that is deleted leaves its attempt with no run', async () => {
    const item = await freshItem(a);
    const run = await freshRun(a, item);
    const { rows } = await insertPush(a, item);
    const id = rows[0]!.id;
    await insertAttempt(a, id, { runtime: 'sandbox', run_id: run, attempt_no: 1 });
    await admin.query(`DELETE FROM agent_runs WHERE id = $1`, [run]);
    expect((await admin.query(`SELECT run_id FROM plane_push_attempts WHERE plane_push_id = $1`, [id])).rows[0].run_id).toBeNull();
    await admin.query(`DELETE FROM work_items WHERE id = $1`, [item]);
    expect((await admin.query(`SELECT 1 FROM plane_pushes WHERE id = $1`, [id])).rows).toHaveLength(0);
    expect((await admin.query(`SELECT 1 FROM plane_push_attempts WHERE plane_push_id = $1`, [id])).rows).toHaveLength(0);
  });
});
