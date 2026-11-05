import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPool } from '@fx/db/src/pool.js';
import { withTenant } from '@fx/db/src/withTenant.js';
import { DEQUEUE_SUCCESS_CODES, recordDriverEvent } from '@fx/core/src/work-items/driverEvents.js';
import { QUEUE_SUCCESS_DEQUEUE_CODES } from '@fx/db/src/mergeReceipt.js';
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
    // The review run the merge's receipt points at (D#7 DW-R4); without one the receipt is reported as missing.
    await admin.query(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, head_sha) VALUES ($1, $2, 'code-reviewer', 'production', 'succeeded', $3)`, [refs.accountId, workItemId, GATED]);
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

  it('B6-5: a removal within ten minutes of a Remove press of that head is the person\'s own (actor_you); no press, an older press, a press of another head or another pull request, a Queue again press, and the queue\'s success reason are not', async () => {
    const press = (it1: { gh: number; workItemId: string }, over: { minutesAgo?: number; head?: string; pr?: number; action?: string } = {}) =>
      admin.query(`INSERT INTO audit_log (account_id, actor, action, payload, created_at) VALUES ($1, 'tester', 'work_item.sent_back', $2::jsonb, now() - make_interval(mins => $3))`, [
        refs.accountId,
        JSON.stringify({ action: over.action ?? 'queue_remove', work_item_id: it1.workItemId, pr_number: over.pr ?? 800 + it1.gh, head_sha: over.head ?? GATED }),
        over.minutesAgo ?? 1,
      ]);
    const removed = async (it1: { gh: number; workItemId: string }, reason = 'MANUAL') => {
      await apply(payload('dequeued', it1.gh, { reason, sender: { type: 'User' } }), `d-${randomUUID()}`);
      return (await events(it1.workItemId, 'merge_dequeued')).map((e: { reasons: string[] }) => e.reasons[0]);
    };
    const pressed = await item();
    await press(pressed);
    expect(await removed(pressed)).toEqual(['actor_you']);
    const none = await item();
    expect(await removed(none)).toEqual(['actor_user']);
    const old = await item();
    await press(old, { minutesAgo: 11 });
    expect(await removed(old)).toEqual(['actor_user']);
    const other = await item();
    await press(other, { head: OTHER });
    await press(other, { pr: 1 });
    await press(other, { action: 'queue_again' });
    expect(await removed(other, 'CI_FAILURE')).toEqual(['actor_app']);
    const merged = await item();
    await press(merged);
    expect(await removed(merged, 'MERGE')).toEqual(['actor_app']);
  });

  it('B6-5: Remove, GitHub answers not queued (the no-op row naming that press), GitHub then removes within ten minutes: the removal reads as GitHub\'s, not yours; a later Remove press counts again', async () => {
    const audit = async (it1: { gh: number; workItemId: string }, action: string, minutesAgo: number, answers?: string): Promise<string> =>
      (
        await admin.query<{ id: string }>(`INSERT INTO audit_log (account_id, actor, action, payload, created_at) VALUES ($1, 'tester', 'work_item.sent_back', $2::jsonb, now() - make_interval(mins => $3)) RETURNING id`, [
          refs.accountId,
          JSON.stringify({ action, work_item_id: it1.workItemId, pr_number: 800 + it1.gh, head_sha: GATED, ...(answers ? { answers } : {}) }),
          minutesAgo,
        ])
      ).rows[0]!.id;
    const first = async (it1: { gh: number; workItemId: string }, reason: string) => {
      await apply(payload('dequeued', it1.gh, { reason, sender: { type: 'App' } }), `d-${randomUUID()}`);
      return (await events(it1.workItemId, 'merge_dequeued')).map((e: { reasons: string[] }) => e.reasons[0]);
    };
    const noop = await item();
    await audit(noop, 'queue_remove_noop', 2, await audit(noop, 'queue_remove', 3));
    expect(await first(noop, 'CI_FAILURE')).toEqual(['actor_app']);
    const again = await item();
    await audit(again, 'queue_remove_noop', 3, await audit(again, 'queue_remove', 4));
    await audit(again, 'queue_remove', 1);
    expect(await first(again, 'CI_FAILURE')).toEqual(['actor_you']);
    // The double press: A's Remove dequeued it, B's Remove a moment later was told "not queued". B's no-op names B's row, so A's press still stands and
    // GitHub's removal is yours (a no-op that names nobody, or another item's press, answers nothing either).
    const double = await item();
    await audit(double, 'queue_remove', 3);
    await audit(double, 'queue_remove_noop', 1, await audit(double, 'queue_remove', 2));
    await audit(double, 'queue_remove_noop', 1);
    await audit(double, 'queue_remove_noop', 1, randomUUID());
    expect(await first(double, 'CI_FAILURE')).toEqual(['actor_you']);
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

describe('D#7 DW-R4: the receipt behind a merge the host queue made [pg]', () => {
  let adminPool: Pool;
  let appUserPool: Pool;
  let admin: PoolClient;
  let refs: SeedRefs;
  let nextGh = 9000;

  beforeAll(async () => {
    adminPool = createPool(process.env.GITHUB_DATABASE_URL!);
    appUserPool = createPool(process.env.GITHUB_DATABASE_URL_APP_USER!);
    admin = await adminPool.connect();
    refs = await seedAccountWithRepo(admin, 4748);
  });
  afterAll(async () => {
    admin.release();
    await appUserPool.end();
    await adminPool.end();
  });
  beforeEach(() => vi.mocked(reportError).mockClear());

  const apply = (p: GithubPullRequestPayload): Promise<ApplyResult> => {
    const ctx: ApplyEventCtx = { accountId: refs.accountId, installationId: refs.installationId, repoId: refs.repoId, repo: { accountId: refs.accountId, repoId: refs.repoId, ghRepoId: refs.ghRepoId, fullName: refs.repoFullName }, deliveryId: `d-${randomUUID()}` };
    return withTenant(appUserPool, refs.accountId, (c) => applyMappedEvent(c, ctx, mapEvent('pull_request', p, { allowlist: [] })));
  };
  const merged = (gh: number, head: string): GithubPullRequestPayload => {
    const real = loadFixture<GithubPullRequestPayload>('pull_request.closed.merged.json');
    return { ...real, action: 'closed', pull_request: { ...real.pull_request, number: 800 + gh, body: `Closes #${gh}`, head: { ...real.pull_request.head, sha: head } } } as GithubPullRequestPayload;
  };
  /** Appends the next version of the repository's merge dial (versions are shared by the tests below, so each sets the dial it needs). */
  const setDial = async (disposition: string) => {
    const version = ((await admin.query<{ v: number }>(`SELECT coalesce(max(version), 0) + 1 AS v FROM decision_settings WHERE repo_id = $1 AND decision_type = 'merge_after_reviews'`, [refs.repoId])).rows[0]!.v);
    const user = randomUUID();
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [user, `${user}@example.test`]);
    await admin.query(
      `INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, preset, version, changed_by) VALUES ($1, $2, 'merge_after_reviews', $3, NULL, $4, $5)`,
      [refs.accountId, refs.repoId, disposition, version, user],
    );
  };
  /** The version of the merge dial now (0: no row), which is what the gate reads when it decides. */
  const dialNow = async () => (await admin.query<{ v: number }>(`SELECT coalesce(max(version), 0) AS v FROM decision_settings WHERE repo_id = $1 AND decision_type = 'merge_after_reviews'`, [refs.repoId])).rows[0]!.v;
  /** An item with a review run on GATED. `enqueue`: 'gate' (default) = the gate queued it, writing its merge_gate fact and its enqueue fact with the dial version it read; 'manual' = only the webhook's
   * enqueue fact (a person pressed GitHub's own "Merge when ready"); 'before_0990' = the gate's facts with no version; false = no enqueue at all (a hand merge). */
  const gated = async (opts: { enqueue?: boolean | 'gate' | 'manual' | 'before_0990' } = {}) => {
    const gh = nextGh++;
    const workItemId = await seedWorkItem(admin, refs.accountId, refs.repoId, { ghNumber: gh, stage: 'pr_opened' });
    await admin.query(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, head_sha) VALUES ($1, $2, 'code-reviewer', 'production', 'succeeded', $3)`, [refs.accountId, workItemId, GATED]);
    const mode = opts.enqueue === undefined || opts.enqueue === true ? 'gate' : opts.enqueue;
    if (mode !== false) {
      const dialVersion = mode === 'gate' ? await dialNow() : undefined;
      await withTenant(appUserPool, refs.accountId, async (c) => {
        if (mode !== 'manual') await recordDriverEvent(c, refs.accountId, { workItemId, kind: 'merge_gate', dedupeKey: `${GATED}:merge_enqueued`, code: 'merge_enqueued', headSha: GATED, prNumber: 800 + gh, ...(dialVersion !== undefined ? { dialVersion } : {}) });
        await recordDriverEvent(c, refs.accountId, { workItemId, kind: 'merge_enqueued', dedupeKey: `enqueued:${GATED}`, code: 'queue', headSha: GATED, prNumber: 800 + gh, ...(dialVersion !== undefined ? { dialVersion } : {}) });
      });
    }
    return { gh, workItemId };
  };
  const receipts = async (workItemId: string) => (await admin.query(`SELECT chosen, dial_version, actor, class FROM decision_receipts WHERE work_item_id = $1 AND decision_type = 'merge_after_reviews'`, [workItemId])).rows;

  it('a merge of an item the gate queued leaves one receipt, a replay x3 adds none, and the dial is the one that stood at the enqueue: moving it to ask afterwards takes nothing away', async () => {
    await setDial('announce');
    const it1 = await gated();
    await setDial('ask');
    for (let i = 0; i < 3; i++) await apply(merged(it1.gh, GATED));
    expect(await receipts(it1.workItemId)).toEqual([{ chosen: 'announce', dial_version: expect.any(Number), actor: 'policy', class: 'human_over_the_loop' }]);
    expect(vi.mocked(reportError)).not.toHaveBeenCalled();
  });

  it('a person\'s hand merge (no merge_enqueued fact from the gate) leaves no receipt', async () => {
    await setDial('act');
    const hand = await gated({ enqueue: false });
    await apply(merged(hand.gh, GATED));
    expect(await receipts(hand.workItemId)).toEqual([]);
  });

  it('a person pressed GitHub\'s own Merge when ready (the webhook\'s enqueue fact and no gate fact): the merge is theirs, as a hand merge is: the item moves to merged, the queue merge is recorded, and no policy receipt is written, however many times the delivery comes', async () => {
    await setDial('act');
    const manual = await gated({ enqueue: 'manual' });
    for (let i = 0; i < 2; i++) await apply(merged(manual.gh, GATED));
    expect(await receipts(manual.workItemId)).toEqual([]);
    expect((await admin.query(`SELECT stage FROM work_items WHERE id = $1`, [manual.workItemId])).rows).toEqual([{ stage: 'merged' }]);
    expect((await admin.query(`SELECT count(*)::int AS n FROM work_item_driver_events WHERE work_item_id = $1 AND kind = 'merged_via_queue'`, [manual.workItemId])).rows).toEqual([{ n: 1 }]);
    expect(vi.mocked(reportError)).not.toHaveBeenCalled();
  });

  it('gate facts written before migration 0990 (no dial version) keep the time-based read: the dial that stood at the enqueue, and no manual enqueue is mistaken for them', async () => {
    await setDial('announce');
    const old = await gated({ enqueue: 'before_0990' });
    await setDial('ask');
    await apply(merged(old.gh, GATED));
    expect(await receipts(old.workItemId)).toEqual([{ chosen: 'announce', dial_version: expect.any(Number), actor: 'policy', class: 'human_over_the_loop' }]);
  });

  it('the head GitHub merged is the head the fact records: a merged head other than the enqueued one is receipted at that head, with the run found on the head the gate sent', async () => {
    await setDial('act');
    const it1 = await gated();
    await apply(merged(it1.gh, OTHER));
    expect((await admin.query(`SELECT head_sha FROM work_item_driver_events WHERE work_item_id = $1 AND kind = 'merged_via_queue'`, [it1.workItemId])).rows).toEqual([{ head_sha: OTHER }]);
    expect(await receipts(it1.workItemId)).toHaveLength(1);
  });

  it('a person who takes the pull request out of the queue and then merges it by hand gets no policy receipt; a re-enqueue by the gate after the removal makes the merge the gate\'s again; GitHub\'s own success dequeue changes nothing', async () => {
    await setDial('act');
    const removed = await gated();
    await withTenant(appUserPool, refs.accountId, (c) => recordDriverEvent(c, refs.accountId, { workItemId: removed.workItemId, kind: 'merge_dequeued', dedupeKey: 'dq:user', code: 'manual', reasons: ['actor_user'], headSha: GATED, prNumber: 800 + removed.gh }));
    await apply(merged(removed.gh, GATED));
    expect(await receipts(removed.workItemId)).toEqual([]);

    const again = await gated();
    await withTenant(appUserPool, refs.accountId, (c) => recordDriverEvent(c, refs.accountId, { workItemId: again.workItemId, kind: 'merge_dequeued', dedupeKey: 'dq:app', code: 'merge_conflict', reasons: ['actor_app'], headSha: GATED, prNumber: 800 + again.gh }));
    // The gate's own retry after the removal: its merge_gate fact and its enqueue fact, both with the dial version it read.
    const retryVersion = await dialNow();
    await withTenant(appUserPool, refs.accountId, async (c) => {
      await recordDriverEvent(c, refs.accountId, { workItemId: again.workItemId, kind: 'merge_gate', dedupeKey: 'retry:merge_enqueued', code: 'merge_enqueued', headSha: GATED, prNumber: 800 + again.gh, dialVersion: retryVersion });
      await recordDriverEvent(c, refs.accountId, { workItemId: again.workItemId, kind: 'merge_enqueued', dedupeKey: 'enqueued:second', code: 'queue', headSha: GATED, prNumber: 800 + again.gh, dialVersion: retryVersion });
    });
    await apply(merged(again.gh, GATED));
    expect(await receipts(again.workItemId)).toHaveLength(1);

    const success = await gated();
    await withTenant(appUserPool, refs.accountId, (c) => recordDriverEvent(c, refs.accountId, { workItemId: success.workItemId, kind: 'merge_dequeued', dedupeKey: 'dq:merge', code: 'merge', reasons: ['actor_app'], headSha: GATED, prNumber: 800 + success.gh }));
    await apply(merged(success.gh, GATED));
    expect(await receipts(success.workItemId)).toHaveLength(1);
  });

  it('the success reasons the receipt helper skips are the ones the event mapper treats as success', () => {
    expect([...QUEUE_SUCCESS_DEQUEUE_CODES].sort()).toEqual([...DEQUEUE_SUCCESS_CODES].sort());
  });

  it('a failed receipt write does not fail the delivery or lose the fact and the stage move, and is reported', async () => {
    await setDial('act');
    const it1 = await gated();
    await admin.query('REVOKE EXECUTE ON FUNCTION merge_receipt_write(uuid, text, uuid, text, text, integer, integer) FROM app_user');
    try {
      expect(await apply(merged(it1.gh, GATED))).toMatchObject({ applied: expect.any(String) });
    } finally {
      await admin.query('GRANT EXECUTE ON FUNCTION merge_receipt_write(uuid, text, uuid, text, text, integer, integer) TO app_user');
    }
    expect((await admin.query(`SELECT stage FROM work_items WHERE id = $1`, [it1.workItemId])).rows).toEqual([{ stage: 'merged' }]);
    expect((await admin.query(`SELECT 1 FROM work_item_driver_events WHERE work_item_id = $1 AND kind = 'merged_via_queue'`, [it1.workItemId])).rowCount).toBe(1);
    expect(await receipts(it1.workItemId)).toEqual([]);
    expect(vi.mocked(reportError)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ code: 'merge_receipt_failed' }));
  });
});
