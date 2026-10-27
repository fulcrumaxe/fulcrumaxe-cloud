import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTenant } from '../../src/withTenant.js';
import { seedAccount, type SeedRefs } from './seed.js';

/**
 * A planned-PR parent built the way the product builds one: the Spec version and its Planned PRs table are written, the owner's approval goes through
 * work_item_approval_record (which creates the children), and the item envelope goes through work_item_set_envelope. Nothing here inserts a child, an approval,
 * an envelope link or a dial setting by hand except through the same definers the code uses (the weekly limit and dial rows are plain tenant data).
 */
export const row = (key: string, title = `Title of ${key}`, depends_on: string[] = []) => ({ key, title, depends_on });
export const TABLE = [row('api', 'The API'), row('ui', 'The screen', ['api']), row('docs', 'The docs')];

export interface PlannedFixture {
  t: SeedRefs;
  parent: string;
  specV1: string;
  approvalId: string;
  pmRun: string;
  /** key -> child work item id */
  kids: Record<string, string>;
  /** The parent's item envelope (null when the fixture has none). */
  envelope: string | null;
  weeklyEnvelope: string | null;
}
export interface PlannedOptions {
  provenance?: 'internal' | 'external';
  /** The parent's item envelope amount in USD; null gives the parent none. */
  envelopeUsd?: number | null;
  /** The weekly auto-start limit; null writes none. */
  weeklyUsd?: number | null;
  /** The repo's `launch_sub_item` dial disposition; null writes no row. */
  dial?: 'ask' | 'announce' | 'act' | null;
  table?: unknown;
}

export async function addSpec(admin: PoolClient, t: SeedRefs, workItemId: string, version: number, planned?: unknown): Promise<string> {
  const body = `Spec v${version} ${randomUUID()}`;
  const frontmatter = planned === undefined ? {} : { planned_prs: planned };
  return (await admin.query<{ id: string }>(
    `INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind, frontmatter) VALUES ($1, $2, $3, $4, $5, 'agent', $6::jsonb) RETURNING id`,
    [t.accountId, workItemId, version, body, createHash('sha256').update(body).digest('hex'), JSON.stringify(frontmatter)],
  )).rows[0]!.id;
}

export async function plannedFixture(admin: PoolClient, appPool: Pool, o: PlannedOptions = {}): Promise<PlannedFixture> {
  const t = await seedAccount(admin, randomUUID());
  const parent = (await admin.query<{ id: string }>(
    `INSERT INTO work_items (account_id, repo_id, kind, provenance, title) VALUES ($1, $2, 'feature', $3, 'The parent feature') RETURNING id`,
    [t.accountId, t.repoId, o.provenance ?? 'internal'])).rows[0]!.id;
  const specV1 = await addSpec(admin, t, parent, 1, o.table ?? TABLE);
  let envelope: string | null = null;
  if (o.envelopeUsd !== null) {
    envelope = randomUUID();
    await admin.query(`INSERT INTO approval_envelopes (id, account_id, repo_id, scope, amount_usd, version, created_by) VALUES ($1, $2, NULL, 'batch', $3, 1, $4)`, [envelope, t.accountId, o.envelopeUsd ?? 20, t.userId]);
    await withTenant(appPool, t.accountId, t.userId, (c) => c.query('SELECT work_item_set_envelope($1, $2)', [parent, envelope]));
  }
  const approvalId = await withTenant(appPool, t.accountId, t.userId, async (c) =>
    (await c.query<{ o_approval_id: string }>(`SELECT * FROM work_item_approval_record($1, 'work_item_approve')`, [parent])).rows[0]!.o_approval_id);
  const pmRun = (await admin.query<{ id: string }>(
    `INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, spec_version_id) VALUES ($1, $2, 'project-manager', 'local', 'succeeded', $3) RETURNING id`,
    [t.accountId, parent, specV1])).rows[0]!.id;
  let weeklyEnvelope: string | null = null;
  if (o.weeklyUsd !== null) {
    weeklyEnvelope = randomUUID();
    await admin.query(`INSERT INTO approval_envelopes (id, account_id, repo_id, scope, amount_usd, version, created_by) VALUES ($1, $2, NULL, 'weekly_autostart', $3, 1, $4)`, [weeklyEnvelope, t.accountId, o.weeklyUsd ?? 50, t.userId]);
  }
  if (o.dial !== null) {
    await admin.query(`INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, preset, version, changed_by) VALUES ($1, $2, 'launch_sub_item', $3, 'balanced', 1, $4)`, [t.accountId, t.repoId, o.dial ?? 'act', t.userId]);
  }
  const kids: Record<string, string> = {};
  for (const r of (await admin.query<{ id: string; planned_pr_key: string }>('SELECT id, planned_pr_key FROM work_items WHERE parent_id = $1 AND planned_pr_key IS NOT NULL', [parent])).rows) kids[r.planned_pr_key] = r.id;
  return { t, parent, specV1, approvalId, pmRun, kids, envelope, weeklyEnvelope };
}

/** The owner approves the parent's newest Spec version again (after a re-spec). */
export const reapprove = (appPool: Pool, f: PlannedFixture) =>
  withTenant(appPool, f.t.accountId, f.t.userId, async (c) => (await c.query(`SELECT * FROM work_item_approval_record($1, 'reapprove_after_respec')`, [f.parent])).rows[0]);
