import { createHmac, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '@fx/db/src/pool.js';
import { withTenant } from '@fx/db/src/withTenant.js';
import { recordDriverEvent } from '@fx/core/src/work-items/driverEvents.js';
import type { GithubWebhookPayload } from '../src/eventMapper.js';
import { handleGithubWebhookEventForApp } from '../src/webhookGate.js';
import { verifyWebhookSignature } from '../src/webhookSignature.js';
import { loadFixture } from './helpers/fixtures.js';
import { seedAccountWithRepo, type SeedRefs } from './helpers/seed.js';

/**
 * D#694 B7-1, survey item 3 [pg]: a delivery for a paired item's PUBLIC pull request (on the code repository, matched by the push record's repository, number and
 * generated branch) is linked to the item for `enqueued`, `dequeued` and `closed`. Each delivery is a body signed with the webhook secret, checked with the same
 * `verifyWebhookSignature` the route uses (a changed byte fails), and then handled by the route's own `handleGithubWebhookEventForApp` over real Postgres: the
 * resolved tenant, the item lookup and the writes are all the real ones.
 *
 * Not covered here, said in the PR: the Next.js request shell around those two calls (apps/web/app/api/github/webhook/handler.test.ts holds it, with a fake
 * `handle`, because that package has no Postgres).
 */
const SECRET = 'paired-queue-webhook-secret';
const HEAD = 'c'.repeat(40);
const PR = 12;
const CODE_REPO = 'acme/widgets-public';

describe('a paired public pull request: queue deliveries reach the item [pg]', () => {
  let adminPool: Pool;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let admin: PoolClient;
  let refs: SeedRefs;
  let privateRepoId: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.GITHUB_DATABASE_URL!);
    appUserPool = createPool(process.env.GITHUB_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.GITHUB_DATABASE_URL_PLATFORM_OPS!);
    admin = await adminPool.connect();
    // The account's repository 9001 is the CODE repository here (a delivery from it resolves the tenant); the item is built in a private one.
    refs = await seedAccountWithRepo(admin, 7_800_000);
    privateRepoId = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, 9002, 'team')`, [privateRepoId, refs.accountId, refs.installationId]);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [appUserPool, platformOpsPool, adminPool]) await p.end();
  });

  /** An item with a platform-managed public pull request: its `plane_pushes` row names the code repository, the number and (generated) the branch. */
  async function pairedItem(): Promise<{ workItemId: string; branch: string; number: number }> {
    const workItemId = randomUUID();
    const number = PR + Math.floor(Math.random() * 100_000);
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, gh_number, provenance, stage) VALUES ($1, $2, $3, 'feature', NULL, 'internal', 'pr_opened')`, [workItemId, refs.accountId, privateRepoId]);
    const { rows } = await admin.query<{ branch: string }>(
      `INSERT INTO plane_pushes (account_id, work_item_id, repo_id, code_repo, pairing_digest, state, head_sha, tip_sha, pr_number, pr_url, source_head)
       VALUES ($1, $2, $3, $4, $5, 'pr_opened', $6, $6, $7, $8, $9) RETURNING branch`,
      [refs.accountId, workItemId, privateRepoId, CODE_REPO, 'd'.repeat(64), HEAD, number, `https://github.com/${CODE_REPO}/pull/${number}`, 'a'.repeat(40)],
    );
    return { workItemId, branch: rows[0]!.branch, number };
  }

  /** The delivery, as GitHub sends it: the exact bytes, signed with the secret, checked, then handled. A redelivery has the same delivery id. */
  async function deliver(item: { branch: string; number: number }, action: string, over: { merged?: boolean; reason?: string; delivery?: string } = {}) {
    const real = loadFixture<Record<string, unknown>>(over.merged ? 'pull_request.closed.merged.json' : 'pull_request.closed.unmerged.json');
    const pr = real.pull_request as Record<string, unknown>;
    const payload = {
      ...real,
      action,
      ...(over.reason !== undefined ? { reason: over.reason } : {}),
      installation: { id: refs.ghInstallationId },
      repository: { ...(real.repository as object), id: refs.ghRepoId, full_name: CODE_REPO },
      pull_request: { ...pr, number: item.number, body: 'Mirrors a private change.', head: { ...(pr.head as Record<string, unknown>), ref: item.branch, sha: HEAD }, merged: over.merged === true },
    };
    const body = JSON.stringify(payload);
    const signature = `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
    expect(verifyWebhookSignature(body, signature, SECRET)).toBe(true);
    expect(verifyWebhookSignature(`${body} `, signature, SECRET), 'one extra byte fails the signature').toBe(false);
    return handleGithubWebhookEventForApp({ appUserPool, platformOpsPool, hooks: {} }, 'pull_request', JSON.parse(body) as GithubWebhookPayload, over.delivery ?? `d-${randomUUID()}`, 'team');
  }
  const events = async (workItemId: string, kind: string) =>
    (await admin.query(`SELECT code, head_sha, pr_number, queue_entry_id, dedupe_key FROM work_item_driver_events WHERE account_id = $1 AND work_item_id = $2 AND kind = $3 ORDER BY seq`, [refs.accountId, workItemId, kind])).rows;
  const stageOf = async (id: string) => (await admin.query<{ stage: string }>('SELECT stage FROM work_items WHERE id = $1', [id])).rows[0]!.stage;

  it('enqueued: one merge_enqueued for the PUBLIC number and head, however often it is delivered', async () => {
    const item = await pairedItem();
    for (let i = 0; i < 3; i++) await deliver(item, 'enqueued', { delivery: 'same-delivery' });
    expect(await events(item.workItemId, 'merge_enqueued')).toEqual([{ code: 'queue', head_sha: HEAD, pr_number: item.number, queue_entry_id: null, dedupe_key: `enqueued:${HEAD}` }]);
  });

  it('enqueued after the cloud recorded its own enqueue (the runner path): the same dedupe key, so there is one row, and it keeps the entry id', async () => {
    const item = await pairedItem();
    await withTenant(appUserPool, refs.accountId, (c) =>
      recordDriverEvent(c, refs.accountId, { workItemId: item.workItemId, kind: 'merge_enqueued', dedupeKey: `enqueued:${HEAD}`, code: 'queue', headSha: HEAD, prNumber: item.number, queueEntryId: 'MQE_kwDOentry' }),
    );
    expect(await deliver(item, 'enqueued')).toMatchObject({ handled: true, result: { applied: 'queue_event_recorded', recorded: false } });
    expect(await events(item.workItemId, 'merge_enqueued')).toEqual([{ code: 'queue', head_sha: HEAD, pr_number: item.number, queue_entry_id: 'MQE_kwDOentry', dedupe_key: `enqueued:${HEAD}` }]);
  });

  it('dequeued: one merge_dequeued per delivery, with the public number and head, naming the entry of the enqueued head', async () => {
    const item = await pairedItem();
    await deliver(item, 'enqueued');
    await withTenant(appUserPool, refs.accountId, (c) =>
      recordDriverEvent(c, refs.accountId, { workItemId: item.workItemId, kind: 'merge_enqueued', dedupeKey: `enqueued:${HEAD}:x`, code: 'queue', headSha: HEAD, prNumber: item.number, queueEntryId: 'MQE_kwDOentry' }),
    );
    for (let i = 0; i < 2; i++) await deliver(item, 'dequeued', { reason: 'MERGE_CONFLICT', delivery: 'dq-one' });
    expect(await events(item.workItemId, 'merge_dequeued')).toMatchObject([{ code: 'merge_conflict', head_sha: HEAD, pr_number: item.number, queue_entry_id: 'MQE_kwDOentry' }]);
  });

  it('closed (merged): the item moves to merged, and a queued item records merged_via_queue with the public number and head', async () => {
    const item = await pairedItem();
    await deliver(item, 'enqueued');
    expect(await deliver(item, 'closed', { merged: true })).toMatchObject({ handled: true });
    expect(await stageOf(item.workItemId)).toBe('merged');
    expect(await events(item.workItemId, 'merged_via_queue')).toMatchObject([{ head_sha: HEAD, pr_number: item.number }]);
    // Closed without a merge is linked too: the item is found (the stage follows the pull request), and a queue merge is not recorded for it.
    const other = await pairedItem();
    expect(await deliver(other, 'closed')).toMatchObject({ handled: true });
    expect(await events(other.workItemId, 'merged_via_queue')).toEqual([]);
  });

  it('a delivery for another number or another branch of the code repository is linked to no item', async () => {
    const item = await pairedItem();
    expect(await deliver({ branch: item.branch, number: item.number + 1 }, 'enqueued')).toMatchObject({ handled: true, result: { applied: 'skipped' } });
    expect(await deliver({ branch: 'fx/p-00000000-0000-4000-8000-000000000000', number: item.number }, 'enqueued')).toMatchObject({ handled: true, result: { applied: 'skipped' } });
    expect(await events(item.workItemId, 'merge_enqueued')).toEqual([]);
  });
});
