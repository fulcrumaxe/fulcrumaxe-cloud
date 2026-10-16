import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount } from '@fx/db/test/helpers/seed.js';
import { createRunWriterTestLogin, runWriterUrlFrom } from '@fx/db/test/support/run-writer-login.js';
import { withTenant } from '../src/tenancy/withTenant.js';
import { workItemOrigin } from '../src/plan/index.js';

/**
 * D#483 S4-e3, acceptance S4e3-1 to S4e3-4 against the real schema and RLS.
 * Rows are written as the admin role; the reader runs as app_user inside a tenant transaction.
 */
describe('workItemOrigin (S4-e3)', () => {
  let adminPool: Pool;
  let appPool: Pool;
  let runWriterPool: Pool;
  let admin: PoolClient;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    // The core project's global setup does not hand out the runner login, so make the same throwaway one the db project uses
    // (idempotent), unless the environment supplies it. It is a member of app_user and agent_run_writer: the only login that may call the definers.
    await createRunWriterTestLogin(process.env.DATABASE_URL!);
    runWriterPool = createPool(process.env.DATABASE_URL_RUN_WRITER ?? runWriterUrlFrom(process.env.DATABASE_URL_APP_USER!));
    admin = await adminPool.connect();
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end(), runWriterPool.end()]);
  });

  type Tenant = { accountId: string; repoId: string };

  async function tenant(): Promise<Tenant> {
    const r = await seedAccount(admin, randomUUID());
    const repoId = randomUUID();
    await admin.query('INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, $4, $5)', [repoId, r.accountId, r.installationId, Math.floor(Math.random() * 1e9) + 10, 'team']);
    return { accountId: r.accountId, repoId };
  }
  async function item(t: Tenant, provenance: 'internal' | 'external', title = 'item'): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, title) VALUES ($1, $2, $3, 'issue', $4, $5)`, [id, t.accountId, t.repoId, provenance, title]);
    return id;
  }
  /** An approved proposal linked to a work item (approval needs a position, a decision stamp and a product owner). */
  async function proposal(t: Tenant, provenance: 'internal' | 'external', workItemId: string): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO proposals (id, account_id, repo_id, dedupe_key, sources, title, provenance, owner_process, state, decided_at, roadmap_position, work_item_id)
       VALUES ($1, $2, $3, $4, ARRAY['github_issue'], 'p', $5, 'product', 'approved', now(), $6, $7)`,
      [id, t.accountId, t.repoId, `gh:issue:${Math.floor(Math.random() * 1e8) + 1}`, provenance, Math.floor(Math.random() * 1e6) + 1, workItemId],
    );
    return id;
  }
  const origin = (accountId: string, workItemId: string) => withTenant(appPool, accountId, (c) => workItemOrigin(c, workItemId));

  it('S4e3-1: an external proposal approved into an internal item reads as external, though the item says internal', async () => {
    const t = await tenant();
    const root = await item(t, 'internal');
    const pid = await proposal(t, 'external', root);
    const stored = await admin.query('SELECT provenance FROM work_items WHERE id = $1', [root]);
    expect(stored.rows[0].provenance).toBe('internal');
    expect(await origin(t.accountId, root)).toEqual({ proposalId: pid, externalSource: true });
  });

  it('S4e3-2: an internal proposal reads as not external; an item with no proposal has no proposal id', async () => {
    const t = await tenant();
    const a = await item(t, 'internal');
    const pid = await proposal(t, 'internal', a);
    expect(await origin(t.accountId, a)).toEqual({ proposalId: pid, externalSource: false });
    const b = await item(t, 'internal');
    expect(await origin(t.accountId, b)).toEqual({ proposalId: null, externalSource: false });
  });

  it('the work item provenance is never read: an external item behind an internal proposal is not external, and a lone external item has no origin', async () => {
    const t = await tenant();
    const extItem = await item(t, 'external');
    const intProposal = await proposal(t, 'internal', extItem);
    expect(await origin(t.accountId, extItem)).toEqual({ proposalId: intProposal, externalSource: false });
    const loneExternal = await item(t, 'external');
    expect(await origin(t.accountId, loneExternal)).toEqual({ proposalId: null, externalSource: false });
  });

  it('S4e3-3: a retired item, repointed through the real retire + follow-root functions, has no proposal on it; the root answers', async () => {
    const t = await tenant();
    // The state triage leaves: an approved external proposal on the first (triaged) item, then a root made in the same repo.
    const retired = await item(t, 'internal');
    const pid = await proposal(t, 'external', retired);
    const root = await item(t, 'internal');
    expect(await origin(t.accountId, retired)).toEqual({ proposalId: pid, externalSource: true });

    // The two real definers, as the runner login in the tenant, in the order issueTriage runs them.
    await withTenant(runWriterPool, t.accountId, (c) => c.query('SELECT retire_superseded_work_item($1::uuid, $2::uuid)', [retired, root]));
    const followed = await withTenant(runWriterPool, t.accountId, (c) => c.query<{ proposal_follow_root: boolean }>('SELECT proposal_follow_root($1::uuid, $2::uuid, $3::uuid)', [pid, retired, root]));
    expect(followed.rows[0]!.proposal_follow_root).toBe(true);

    // Precondition: the retire step really closed it and left its history row and supersede record.
    const stage = await admin.query('SELECT stage FROM work_items WHERE id = $1', [retired]);
    expect(stage.rows[0].stage).toBe('closed');
    const tr = await admin.query(`SELECT source_ref FROM work_item_transitions WHERE work_item_id = $1 AND to_stage = 'closed'`, [retired]);
    expect(tr.rows).toEqual([{ source_ref: `superseded:${root}` }]);
    const rec = await admin.query('SELECT root_work_item_id FROM work_item_supersedes WHERE old_work_item_id = $1', [retired]);
    expect(rec.rows).toEqual([{ root_work_item_id: root }]);

    expect(await origin(t.accountId, retired)).toEqual({ proposalId: null, externalSource: false });
    expect(await origin(t.accountId, root)).toEqual({ proposalId: pid, externalSource: true });
  });

  it("S4e3-4: with another account's tenant context, this account's work item reads as no proposal", async () => {
    const a = await tenant();
    const b = await tenant();
    const root = await item(a, 'internal');
    const pid = await proposal(a, 'external', root);
    expect(await origin(a.accountId, root)).toEqual({ proposalId: pid, externalSource: true });
    expect(await origin(b.accountId, root)).toEqual({ proposalId: null, externalSource: false });
  });
});
