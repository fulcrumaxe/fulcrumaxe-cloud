import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

/**
 * A person's "request changes" (a changes_requested transition whose source_ref starts `request_changes:`, reviewer
 * `acceptance`) is not a review verdict. v_kpi_work_items keeps it out of the first verdict and out of
 * n_changes_requested, and counts it in n_person_change_requests.
 */
describe('v_kpi_work_items: person change requests are not review verdicts', () => {
  let adminPool: Pool;
  let appPool: Pool;
  let admin: PoolClient;
  let refs: SeedRefs;
  const item = { personThenPass: randomUUID(), reviewerThenPerson: randomUUID(), personOnly: randomUUID() };
  const d = (s: string) => new Date(s);

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    admin = await adminPool.connect();
    refs = await seedAccount(admin, randomUUID());
    await admin.query('DELETE FROM agent_runs WHERE account_id = $1', [refs.accountId]);
    await admin.query('DELETE FROM work_items WHERE account_id = $1', [refs.accountId]);

    const wi = (id: string, stage: string) =>
      admin.query(
        `INSERT INTO work_items (id, account_id, repo_id, kind, provenance, created_at, stage)
         VALUES ($1, $2, $3, 'feature', 'internal', $4, $5)`,
        [id, refs.accountId, refs.repoId, d('2024-01-01T00:00:00Z'), stage],
      );
    const tr = (id: string, from: string, to: string, at: string, reviewer: string | null, sourceRef: string) =>
      admin.query(
        `INSERT INTO work_item_transitions (account_id, work_item_id, from_stage, to_stage, reviewer, at, source, source_ref)
         VALUES ($1, $2, $3, $4, $5, $6, 'control_plane', $7)`,
        [refs.accountId, id, from, to, reviewer, d(at), sourceRef],
      );

    // A: pr opened, a person asks for changes, then a reviewer passes it and it merges.
    await wi(item.personThenPass, 'merged');
    await tr(item.personThenPass, 'triaged', 'pr_opened', '2024-01-02T00:00:00Z', null, randomUUID());
    await tr(item.personThenPass, 'pr_opened', 'changes_requested', '2024-01-03T00:00:00Z', 'acceptance', `request_changes:${randomUUID()}`);
    await tr(item.personThenPass, 'changes_requested', 'review_passed', '2024-01-04T00:00:00Z', 'security', randomUUID());
    await tr(item.personThenPass, 'review_passed', 'merged', '2024-01-05T00:00:00Z', null, randomUUID());

    // B: a reviewer asks for changes first, a person asks again afterwards.
    await wi(item.reviewerThenPerson, 'changes_requested');
    await tr(item.reviewerThenPerson, 'triaged', 'pr_opened', '2024-01-02T00:00:00Z', null, randomUUID());
    await tr(item.reviewerThenPerson, 'pr_opened', 'changes_requested', '2024-01-03T00:00:00Z', 'code', randomUUID());
    await tr(item.reviewerThenPerson, 'changes_requested', 'changes_requested', '2024-01-04T00:00:00Z', 'acceptance', `request_changes:${randomUUID()}`);

    // C: only a person has spoken.
    await wi(item.personOnly, 'changes_requested');
    await tr(item.personOnly, 'triaged', 'pr_opened', '2024-01-02T00:00:00Z', null, randomUUID());
    await tr(item.personOnly, 'pr_opened', 'changes_requested', '2024-01-03T00:00:00Z', 'acceptance', `request_changes:${randomUUID()}`);
  });

  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end()]);
  });

  async function row(id: string) {
    const { rows } = await withTenant(appPool, refs.accountId, (c) =>
      c.query('SELECT t_first_verdict, first_verdict_stage, n_changes_requested, n_person_change_requests FROM v_kpi_work_items WHERE work_item_id = $1', [id]),
    );
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  it("a person's request before a reviewer's pass is not the first verdict", async () => {
    const r = await row(item.personThenPass);
    expect(r.first_verdict_stage).toBe('review_passed');
    expect(r.t_first_verdict).toEqual(d('2024-01-04T00:00:00Z'));
    expect(Number(r.n_changes_requested)).toBe(0);
    expect(Number(r.n_person_change_requests)).toBe(1);
  });

  it("a reviewer's verdict stays the first verdict and the person's later request is counted apart", async () => {
    const r = await row(item.reviewerThenPerson);
    expect(r.first_verdict_stage).toBe('changes_requested');
    expect(r.t_first_verdict).toEqual(d('2024-01-03T00:00:00Z'));
    expect(Number(r.n_changes_requested)).toBe(1);
    expect(Number(r.n_person_change_requests)).toBe(1);
  });

  it('an item with only a person request has no first verdict', async () => {
    const r = await row(item.personOnly);
    expect(r.first_verdict_stage).toBeNull();
    expect(r.t_first_verdict).toBeNull();
    expect(Number(r.n_changes_requested)).toBe(0);
    expect(Number(r.n_person_change_requests)).toBe(1);
  });

  it('a source_ref that only resembles the prefix is still a reviewer verdict', async () => {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage) VALUES ($1, $2, $3, 'feature', 'internal', 'changes_requested')`,
      [id, refs.accountId, refs.repoId],
    );
    await admin.query(
      `INSERT INTO work_item_transitions (account_id, work_item_id, from_stage, to_stage, reviewer, at, source, source_ref)
       VALUES ($1, $2, 'pr_opened', 'changes_requested', 'code', $3, 'control_plane', 'requestXchanges:1')`,
      [refs.accountId, id, d('2024-01-03T00:00:00Z')],
    );
    const r = await row(id);
    expect(Number(r.n_changes_requested)).toBe(1);
    expect(Number(r.n_person_change_requests)).toBe(0);
  });
});
