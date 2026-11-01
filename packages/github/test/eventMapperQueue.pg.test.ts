import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPool } from '@fx/db/src/pool.js';
import { withTenant } from '@fx/db/src/withTenant.js';
import { recordDriverEvent } from '@fx/core/src/work-items/driverEvents.js';
import { reportError } from '@fx/telemetry';
import { applyMappedEvent, mapEvent, type ApplyEventCtx, type ApplyResult, type GithubPullRequestPayload } from '../src/eventMapper.js';
import { loadFixture } from './helpers/fixtures.js';
import { seedAccountWithRepo, seedWorkItem, type SeedRefs } from './helpers/seed.js';

vi.mock('@fx/telemetry', async (original) => ({ ...(await original<typeof import('@fx/telemetry')>()), reportError: vi.fn() }));

/**
 * D#694 B6-2 over real Postgres: the host's merge-queue deliveries as driver events. One row per fact however often or in whatever order the deliveries arrive, the merge
 * recorded as `merged_via_queue` only for an item the gate sent to the queue, and the merged head compared with the head the gate sent.
 */
const GATED = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

describe('merge-queue deliveries [pg]', () => {
  let adminPool: Pool;
  let appUserPool: Pool;
  let admin: PoolClient;
  let refs: SeedRefs;
  let nextGh = 5000;

  beforeAll(async () => {
    adminPool = createPool(process.env.GITHUB_DATABASE_URL!);
    appUserPool = createPool(process.env.GITHUB_DATABASE_URL_APP_USER!);
    admin = await adminPool.connect();
    refs = await seedAccountWithRepo(admin, 4747);
  });
  afterAll(async () => {
    admin.release();
    await appUserPool.end();
    await adminPool.end();
  });
  beforeEach(() => vi.mocked(reportError).mockClear());

  const apply = (payload: GithubPullRequestPayload, deliveryId: string): Promise<ApplyResult> => {
    const ctx: ApplyEventCtx = { accountId: refs.accountId, installationId: refs.installationId, repoId: refs.repoId, repo: { accountId: refs.accountId, repoId: refs.repoId, ghRepoId: refs.ghRepoId, fullName: refs.repoFullName }, deliveryId };
    return withTenant(appUserPool, refs.accountId, (c) => applyMappedEvent(c, ctx, mapEvent('pull_request', payload, { allowlist: [] })));
  };
  const payload = (action: string, gh: number, over: { head?: string; merged?: boolean; reason?: unknown; sender?: unknown } = {}): GithubPullRequestPayload => {
    const real = loadFixture<GithubPullRequestPayload>(over.merged ? 'pull_request.closed.merged.json' : 'pull_request.closed.unmerged.json');
    return { ...real, action, ...(over.reason !== undefined ? { reason: over.reason } : {}), ...(over.sender !== undefined ? { sender: over.sender } : {}), pull_request: { ...real.pull_request, number: 800 + gh, body: `Closes #${gh}`, head: { ...real.pull_request.head, sha: over.head ?? GATED } } } as GithubPullRequestPayload;
  };
  /** An item with the gate's own `merge_enqueued` row (what B5 writes), so a later delivery can name its entry. */
  const item = async (withEnqueue = true) => {
    const gh = nextGh++;
    const workItemId = await seedWorkItem(admin, refs.accountId, refs.repoId, { ghNumber: gh, stage: 'pr_opened' });
    if (withEnqueue) await withTenant(appUserPool, refs.accountId, (c) => recordDriverEvent(c, refs.accountId, { workItemId, kind: 'merge_enqueued', dedupeKey: `enqueued:${GATED}`, code: 'queue', headSha: GATED, prNumber: 800 + gh, queueEntryId: 'MQE_kwDOentry' }));
    return { gh, workItemId };
  };
  const events = async (workItemId: string, kind: string) =>
    (await admin.query(`SELECT code, reasons, head_sha, pr_number, queue_entry_id, dedupe_key FROM work_item_driver_events WHERE account_id = $1 AND work_item_id = $2 AND kind = $3 ORDER BY seq`, [refs.accountId, workItemId, kind])).rows;
  const stageOf = async (id: string) => (await admin.query<{ stage: string }>('SELECT stage FROM work_items WHERE id = $1', [id])).rows[0]!.stage;

  it('enqueued by a person records one merge_enqueued for the head; the gate\'s own row for the head is the same row, so a delivery after it adds nothing', async () => {
    const manual = await item(false);
    for (let i = 0; i < 3; i++) await apply(payload('enqueued', manual.gh), `d-${i}-${randomUUID()}`);
    expect(await events(manual.workItemId, 'merge_enqueued')).toMatchObject([{ code: 'queue', head_sha: GATED, queue_entry_id: null }]);
    const gated = await item();
    expect(await apply(payload('enqueued', gated.gh), `d-${randomUUID()}`)).toMatchObject({ applied: 'queue_event_recorded', recorded: false });
    expect(await events(gated.workItemId, 'merge_enqueued')).toHaveLength(1);
  });

  it('dequeued is one row per delivery (a replay x3 adds none), names the entry of that head, keeps the reason as a code and the actor kind; a second removal is a second row', async () => {
    const it1 = await item();
    const dq = payload('dequeued', it1.gh, { reason: 'MERGE_CONFLICT', sender: { type: 'User' } });
    for (let i = 0; i < 3; i++) await apply(dq, 'delivery-one');
    expect(await events(it1.workItemId, 'merge_dequeued')).toMatchObject([{ code: 'merge_conflict', reasons: ['actor_app'], head_sha: GATED, pr_number: 800 + it1.gh, queue_entry_id: 'MQE_kwDOentry' }]);
    await apply(dq, 'delivery-two');
    expect(await events(it1.workItemId, 'merge_dequeued')).toHaveLength(2);
  });

  it('dequeued with no reason is stored as unspecified, a head other than the enqueued one names no entry, and neither moves the stage', async () => {
    const it1 = await item();
    await apply(payload('dequeued', it1.gh, { head: OTHER }), `d-${randomUUID()}`);
    expect(await events(it1.workItemId, 'merge_dequeued')).toMatchObject([{ code: 'unspecified', reasons: ['actor_app'], head_sha: OTHER, queue_entry_id: null }]);
    expect(await stageOf(it1.workItemId)).toBe('pr_opened');
  });

  it('a merge of an item the gate queued records merged_via_queue once per pull request and head, with the entry; a replay x3 adds none', async () => {
    const it1 = await item();
    for (let i = 0; i < 3; i++) await apply(payload('closed', it1.gh, { merged: true }), `d-${randomUUID()}`);
    expect(await stageOf(it1.workItemId)).toBe('merged');
    expect(await events(it1.workItemId, 'merged_via_queue')).toMatchObject([{ head_sha: GATED, pr_number: 800 + it1.gh, queue_entry_id: 'MQE_kwDOentry', dedupe_key: `mergedq:${800 + it1.gh}:${GATED}` }]);
    expect(await events(it1.workItemId, 'escalated')).toEqual([]);
    expect(reportError).not.toHaveBeenCalled();
  });

  it('closed before dequeued, and dequeued before closed: either order ends merged with one row of each kind', async () => {
    for (const order of [['closed', 'dequeued'], ['dequeued', 'closed']] as const) {
      const it1 = await item();
      const deliveries = { closed: payload('closed', it1.gh, { merged: true }), dequeued: payload('dequeued', it1.gh, { reason: 'MERGE' }) };
      for (let round = 0; round < 3; round++) for (const name of order) await apply(deliveries[name], `${name}-${it1.gh}`);
      expect(await stageOf(it1.workItemId)).toBe('merged');
      expect(await events(it1.workItemId, 'merged_via_queue')).toHaveLength(1);
      expect(await events(it1.workItemId, 'merge_dequeued')).toHaveLength(1);
      expect(await events(it1.workItemId, 'merge_enqueued')).toHaveLength(1);
    }
  });

  it('a late delivery after the item was already merged by another read still records the queue merge', async () => {
    const it1 = await item();
    await admin.query(`UPDATE work_items SET stage = 'merged' WHERE id = $1`, [it1.workItemId]);
    await apply(payload('closed', it1.gh, { merged: true }), `d-${randomUUID()}`);
    expect(await events(it1.workItemId, 'merged_via_queue')).toHaveLength(1);
  });

  it('a merge with no merge_enqueued fact (a person, the direct path) records no queue merge, and a pull request closed unmerged records none either', async () => {
    const person = await item(false);
    await apply(payload('closed', person.gh, { merged: true }), `d-${randomUUID()}`);
    expect(await stageOf(person.workItemId)).toBe('merged');
    expect(await events(person.workItemId, 'merged_via_queue')).toEqual([]);
    const closed = await item();
    await apply(payload('closed', closed.gh), `d-${randomUUID()}`);
    expect(await stageOf(closed.workItemId)).toBe('closed_unmerged');
    expect(await events(closed.workItemId, 'merged_via_queue')).toEqual([]);
  });

  it('B6-AUTOMERGE-HEAD-BIND: a merge of another head than the one sent is recorded under the merged head, escalated once, raised once, and the merge stands', async () => {
    const it1 = await item();
    for (let i = 0; i < 3; i++) await apply(payload('closed', it1.gh, { merged: true, head: OTHER }), `d-${randomUUID()}`);
    expect(await stageOf(it1.workItemId)).toBe('merged');
    expect(await events(it1.workItemId, 'merged_via_queue')).toMatchObject([{ head_sha: OTHER }]);
    expect(await events(it1.workItemId, 'escalated')).toMatchObject([{ code: 'merged_head_differs', head_sha: OTHER, pr_number: 800 + it1.gh }]);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('a merge whose delivery states no head cannot be bound to the gated one: it is raised too', async () => {
    const it1 = await item();
    const noHead = payload('closed', it1.gh, { merged: true });
    delete (noHead.pull_request.head as { sha?: string }).sha;
    await apply(noHead, `d-${randomUUID()}`);
    expect(await events(it1.workItemId, 'merged_via_queue')).toMatchObject([{ head_sha: GATED }]);
    expect(await events(it1.workItemId, 'escalated')).toMatchObject([{ code: 'merged_head_differs', head_sha: null }]);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('a fork from an untrusted author, and a pull request naming no work item, record nothing', async () => {
    const it1 = await item();
    const fork = payload('dequeued', it1.gh);
    const forked = { ...fork, pull_request: { ...fork.pull_request, author_association: 'NONE', user: { login: 'stranger' }, head: { ...fork.pull_request.head, repo: { id: 1 } } } } as GithubPullRequestPayload;
    expect(await apply(forked, `d-${randomUUID()}`)).toMatchObject({ applied: 'skipped' });
    expect(await apply(payload('dequeued', 987654), `d-${randomUUID()}`)).toMatchObject({ applied: 'skipped' });
    expect(await events(it1.workItemId, 'merge_dequeued')).toEqual([]);
  });
});
