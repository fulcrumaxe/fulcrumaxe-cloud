import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { plannedFixture, type PlannedFixture } from "@fx/db/test/helpers/plannedChildren.js";
import { setPendingHooks } from "@fx/core/src/pendingWork.js";
import type { ChildLaunchDeps } from "@fx/core/src/decisions/childLaunch.js";
import { applyMappedEvent, type MappedEvent } from "@fx/github";
import { recordChildBranch, recordChildPullRequest } from "@fx/runner";
import { childEnvelopeRoom } from "@fx/spend";
import { PARKED_STAGE_REGISTRY, readBuildWaitReason } from "@fx/pipeline";
import { runQueueTick } from "../../pipeline/src/mergeQueue/index.js";
import { startQueueRepo, type QueueRepo } from "../../pipeline/test/mergeQueue/helpers/queueRepo.js";
import { createAutoStartSweep } from "../src/autoStartSweep.js";
import { createStageResume } from "../src/stageResume.js";
import type { AdvanceStartArgs } from "../src/advance.js";

/**
 * [pg] D#519 MQ-WIRE-1: a PR the merge queue merges is recorded on its work item at once, with no pull_request webhook delivered. The queue tick is the real
 * one, over the pipeline's strict TLS GitHub fake (User-Agent, Authorization, real certificate chain); the stage move is the real recordStage in the tick's
 * own transaction; the slot wake is the real parked-stage sweep; the sibling release is the real auto-start gate. Nothing below delivers a webhook before the
 * tick. Then the same webhook is replayed through the real applyMappedEvent and must change nothing. The only fakes are the GitHub server (it models one
 * pull request per number and cannot model rate limits or every error wording) and the workflow starter (a started workflow here takes no slot).
 */
const LOGIN = "fx_queue_merge_stage_test";
const PARENT_NUMBER = 41;
const PR = 7;
const BRANCH = `fx/${PARENT_NUMBER}-api`;

describe("the queue merge records the work item merged [pg]", { timeout: 90_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
  let receiptPool: Pool;
  let markers: Map<string, number>;
  let repos: QueueRepo[] = [];
  let sweep: ReturnType<typeof createAutoStartSweep>;
  const child: ChildLaunchDeps = {
    buildSupported: true,
    room: async (client, input) => {
      const r = await childEnvelopeRoom(client, { accountId: input.accountId, envelopeId: input.envelopeId, childId: input.childId, firstRunUsd: 1 });
      return { fits: r.fits, remainingUsd: r.remainingUsd, priceUsd: 1 };
    },
  };

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${LOGIN}') THEN CREATE ROLE ${LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${LOGIN}`);
    const u = new URL(process.env.WORKER_DATABASE_URL_APP_USER!);
    u.username = LOGIN;
    u.password = "";
    receiptPool = createPool(u.toString());
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
    sweep = createAutoStartSweep({ receiptPool, firstRunUsd: async () => 1, child, warn: () => {} });
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), receiptPool.end(), writerPool.end(), appPool.end()]);
  });
  beforeEach(() => {
    markers = new Map();
    setPendingHooks({ store: { get: async (k) => markers.get(k) ?? null, set: async (k, v) => void markers.set(k, v), delete: async (k) => void markers.delete(k) } });
  });
  afterEach(async () => {
    setPendingHooks(null);
    await Promise.all(repos.map((r) => r.close()));
    repos = [];
  });

  const entry = PARKED_STAGE_REGISTRY.build!;
  const stageOf = async (id: string) => (await admin.query<{ stage: string }>("SELECT stage FROM work_items WHERE id = $1", [id])).rows[0]!.stage;
  const mergedRows = async (id: string) => Number((await admin.query("SELECT count(*) AS n FROM work_item_transitions WHERE work_item_id = $1 AND to_stage = 'merged'", [id])).rows[0].n);

  /** The planned parent with its api child at a pull request (the queue's item), the ui child waiting on it, and a build waiting for the repository's slot. */
  async function world(): Promise<{ f: PlannedFixture; api: string; waiter: { id: string; approval: string }; queue: QueueRepo }> {
    const f = await plannedFixture(admin, appPool, { dial: "act", envelopeUsd: 20 });
    const api = f.kids.api!;
    await admin.query("UPDATE work_items SET gh_number = $2 WHERE id = $1", [f.parent, PARENT_NUMBER]);
    await admin.query("UPDATE work_items SET stage = 'pr_opened' WHERE id = $1", [api]);
    // The child's build recorded its branch and its pull request, as the webhook mapper looks them up.
    const run = (await admin.query<{ id: string }>(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, execution_mode, spec_version_id) VALUES ($1, $2, 'executor', 'production', 'succeeded', 'sandbox', $3) RETURNING id`, [f.t.accountId, api, f.specV1])).rows[0]!.id;
    await withTenant(appPool, f.t.accountId, async (c) => {
      await recordChildBranch(c, f.t.accountId, run, BRANCH);
      await recordChildPullRequest(c, f.t.accountId, run, BRANCH, PR);
    });
    const waiterId = randomUUID();
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'feature', 'internal', 'spec_ready', $4)", [waiterId, f.t.accountId, f.t.repoId, 9100 + Math.floor(Math.random() * 800)]);
    await admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, 'spec', encode(sha256(convert_to('spec', 'UTF8')), 'hex'), 'system')", [f.t.accountId, waiterId]);
    await admin.query("UPDATE spec_versions SET created_at = now() - interval '2 days' WHERE work_item_id = $1", [waiterId]);
    const approval = randomUUID();
    await admin.query(
      `INSERT INTO run_action_requests (id, account_id, kind, target_id, requested_by, principal_kind, request_hash, state, finished_at, outcome)
       VALUES ($1, $2, 'advance_work_item', $3, $4, 'session', $5, 'done', now() - interval '1 day', $6::jsonb)`,
      [approval, f.t.accountId, waiterId, `session:${f.t.userId}`, "h".repeat(64), JSON.stringify({ work_item_id: waiterId, advance: "started" })],
    );
    await admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, stage, code, attempt, dedupe_key) VALUES ($1, $2, 'stage_waiting', 'build', 'one_build_per_repo_until_d598', 0, $3)", [f.t.accountId, waiterId, randomUUID()]);
    await admin.query("UPDATE work_item_driver_events SET created_at = now() - interval '1 hour' WHERE work_item_id = $1", [waiterId]);

    const queue = await startQueueRepo({ admin, runWriterPool: writerPool, pureAppUserPool: appPool }, { existing: { accountId: f.t.accountId, repoId: f.t.repoId } });
    repos.push(queue);
    await queue.addItem(PR, { existingWorkItemId: api });
    return { f, api, waiter: { id: waiterId, approval }, queue };
  }

  function sweeper(started: AdvanceStartArgs[]) {
    return createStageResume(writerPool, {
      resolveRunSeat: async () => {
        throw new Error("the slot wake never asks for a seat");
      },
      startAdvance: async (args) => void started.push(args),
      buildWaitReason: (accountId, workItemId) => readBuildWaitReason(writerPool, accountId, workItemId),
      log: () => undefined,
    });
  }
  const mine = (started: AdvanceStartArgs[], accountId: string) => started.filter((s) => s.accountId === accountId);

  it("the tick's merge moves the item to merged, marks both sweeps, starts the waiting build and the dependent sibling, and the webhook that follows changes nothing", async () => {
    const { f, api, waiter, queue } = await world();

    // Before: the slot is held and the sibling waits for the api child. No webhook has been delivered, and none is below until the replay.
    const started: AdvanceStartArgs[] = [];
    await sweeper(started).sweepParkedStages([entry]);
    expect(mine(started, f.t.accountId)).toEqual([]);
    expect(await sweep.gateChild(f.t.accountId, f.kids.ui!)).toEqual({ outcome: "held_by_rule", code: "waiting_on_planned_pr" });
    markers.clear();

    const out = await runQueueTick(queue.deps(), queue);
    expect(out.steps.map((s) => s.step)).toEqual(["merged", "idle"]);
    expect(queue.mergeCalls()).toEqual([PR]);
    await Promise.resolve();

    // 1. the stage is recorded by the tick, from the queue (not from a webhook delivery).
    expect(await stageOf(api)).toBe("merged");
    expect((await queue.entry(PR)).state).toBe("merged");
    const trail = await admin.query<{ source: string; source_ref: string }>("SELECT source, source_ref FROM work_item_transitions WHERE work_item_id = $1 AND to_stage = 'merged'", [api]);
    expect(trail.rows).toEqual([{ source: "webhook", source_ref: `merge_queue:${queue.items.get(PR)!.entryId}` }]);
    // 2. both wake markers are set.
    expect(markers.has("pending:stage-resume-sweep")).toBe(true);
    expect(markers.has("pending:branch-cleanup")).toBe(true);
    // 3. the waiting build starts within one stage-resume pass, once, under its own approval.
    await sweeper(started).sweepParkedStages([entry]);
    expect(mine(started, f.t.accountId)).toEqual([{ accountId: f.t.accountId, userId: f.t.userId, workItemId: waiter.id, actionId: waiter.approval, haltEpoch: 0, specVersion: 1 }]);
    // 5. the planned-PR sibling that depends on this item is released.
    expect(markers.has("pending:proposal-verify-sweep")).toBe(true);
    expect(await sweep.gateChild(f.t.accountId, f.kids.ui!)).toEqual({ outcome: "started" });

    // 4. The pull_request closed+merged webhook for the same PR, delivered afterwards, is a no-op.
    markers.clear();
    const mapped = { kind: "transition_pr", toStage: "merged", at: new Date(), prNumber: PR, linkedIssueNumber: null, trust: "trusted", isFork: false, headRef: BRANCH, baseIsDefault: true } as MappedEvent;
    const applied = await withTenant(appPool, f.t.accountId, (client) =>
      applyMappedEvent(client, { accountId: f.t.accountId, installationId: f.t.installationId, repoId: f.t.repoId, repo: { accountId: f.t.accountId, repoId: f.t.repoId, ghRepoId: 1, fullName: "acme/widgets" }, deliveryId: `d-${randomUUID()}` }, mapped),
    );
    await Promise.resolve();
    expect(applied).toMatchObject({ applied: "transitioned", workItemId: api, recorded: false });
    expect(await stageOf(api)).toBe("merged");
    expect(await mergedRows(api)).toBe(1);
    expect(markers.size).toBe(0);
    await sweeper(started).sweepParkedStages([entry]);
    expect(mine(started, f.t.accountId)).toHaveLength(1);
  });

  it("a clock ahead of the database (recordStage refuses the time) never rolls back the entry's merge; the item stays for the webhook and the sweep", async () => {
    const { api, queue } = await world();
    const ahead = new Date(Date.now() + 60 * 60_000);
    const out = await runQueueTick(queue.deps({ now: () => ahead }), queue);
    expect(out.steps.map((s) => s.step)).toEqual(["merged", "idle"]);
    expect(queue.mergeCalls()).toEqual([PR]);
    expect((await queue.entry(PR)).state).toBe("merged");
    expect(await stageOf(api)).toBe("pr_opened");
    expect(await mergedRows(api)).toBe(0);
  });

  it("an item that is not at a pull-request stage keeps its stage; the entry is still merged", async () => {
    const { api, queue } = await world();
    await admin.query("UPDATE work_items SET stage = 'closed' WHERE id = $1", [api]);
    const out = await runQueueTick(queue.deps(), queue);
    expect(out.steps.map((s) => s.step)).toEqual(["merged", "idle"]);
    expect((await queue.entry(PR)).state).toBe("merged");
    expect(await stageOf(api)).toBe("closed");
    expect(await mergedRows(api)).toBe(0);
  });
});
