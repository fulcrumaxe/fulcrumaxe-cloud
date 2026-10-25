import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { setPendingHooks } from "@fx/core/src/pendingWork.js";
import { recordStage } from "@fx/core/src/work-items/recordStage.js";
import { applyMappedEvent, type MappedEvent } from "@fx/github";
import { BUILD_SLOT_STAGES, BUILD_WAIT_REASONS, PARKED_STAGE_REGISTRY, readBuildWaitReason } from "@fx/pipeline";
import { SLOT_HOLDING_STAGES } from "@fx/core/src/work-items/recordStage.js";
import { createStageResume, SLOT_WAIT_REASONS } from "../src/stageResume.js";
import type { AdvanceStartArgs } from "../src/advance.js";

/**
 * [pg] The slot wake. A build waits for a free slot inside its workflow for at most four hours; when that workflow is gone and the slot frees, the oldest
 * orphaned waiter of the repository that already has a person's approval starts, once, with no polling cron: recordStage marks the parked-stage sweep pending when a
 * slot frees, and the sweep starts the waiter. Real Postgres as the real roles; the slot decision is the pipeline's own `readBuildWaitReason`; the move is the
 * real recordStage (a private merge or close) or the real webhook apply (a merge of the PUBLIC pull request of a paired item). The only fake is the workflow
 * starter, which records what it was asked to start. Not faked faithfully: the workflow engine (a started workflow here takes no slot).
 */
describe("the slot wake [pg]", { timeout: 60_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
  let markers: Map<string, number>;
  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool, appPool]) await p.end();
  });
  beforeEach(() => {
    markers = new Map();
    setPendingHooks({ store: { get: async (k) => markers.get(k) ?? null, set: async (k, v) => void markers.set(k, v), delete: async (k) => void markers.delete(k) } });
  });
  afterEach(() => setPendingHooks(null));

  const entry = PARKED_STAGE_REGISTRY.build!;
  const wakeMarked = () => markers.has("pending:stage-resume-sweep");
  let n = 9000;

  async function account(): Promise<SeedRefs> {
    return seedAccount(admin, randomUUID());
  }
  /** An item holding the repository's only build slot. */
  async function holder(a: SeedRefs, stage = "pr_opened"): Promise<string> {
    const id = randomUUID();
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'feature', 'internal', $4, $5)", [id, a.accountId, a.repoId, stage, n++]);
    return id;
  }
  /** A Spec-ready item whose workflow is gone: a person's performed approval, and a slot-wait fact `ageSeconds` old. */
  async function waiter(a: SeedRefs, o: { ageSeconds?: number; approved?: boolean; createdDaysAgo?: number; reason?: string } = {}): Promise<{ id: string; approval: string }> {
    const id = randomUUID();
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number, created_at) VALUES ($1, $2, $3, 'feature', 'internal', 'spec_ready', $4, now() - make_interval(days => $5::int))", [id, a.accountId, a.repoId, n++, o.createdDaysAgo ?? 0]);
    await admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, 'spec', encode(sha256(convert_to('spec', 'UTF8')), 'hex'), 'system')", [a.accountId, id]);
    await admin.query("UPDATE spec_versions SET created_at = now() - interval '2 days' WHERE work_item_id = $1", [id]);
    const approval = randomUUID();
    if (o.approved !== false) {
      await admin.query(
        `INSERT INTO run_action_requests (id, account_id, kind, target_id, requested_by, principal_kind, request_hash, state, finished_at, outcome)
         VALUES ($1, $2, 'advance_work_item', $3, $4, 'session', $5, 'done', now() - interval '1 day', $6::jsonb)`,
        [approval, a.accountId, id, `session:${a.userId}`, "h".repeat(64), JSON.stringify({ work_item_id: id, advance: "started" })],
      );
    }
    await admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, stage, code, attempt, dedupe_key) VALUES ($1, $2, 'stage_waiting', 'build', $3, 0, $4)", [a.accountId, id, o.reason ?? "one_build_per_repo_until_d598", randomUUID()]);
    await admin.query("UPDATE work_item_driver_events SET created_at = now() - make_interval(secs => $2::int) WHERE work_item_id = $1", [id, o.ageSeconds ?? 3600]);
    return { id, approval };
  }

  /** The slot frees the way a webhook for a private pull request frees it. */
  async function move(a: SeedRefs, workItemId: string, toStage: "merged" | "closed_unmerged", sourceRef = `t:${randomUUID()}`) {
    const result = await withTenant(appPool, a.accountId, (client) => recordStage(client, { workItemId, toStage, at: new Date(), source: "webhook", sourceRef }));
    await Promise.resolve();
    return result;
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
  /** The sweep sees every account on the shared database; a test looks only at its own account. */
  const mine = (started: AdvanceStartArgs[], a: SeedRefs) => started.filter((s) => s.accountId === a.accountId);
  const stageOf = async (id: string) => (await admin.query<{ stage: string }>("SELECT stage FROM work_items WHERE id = $1", [id])).rows[0]!.stage;

  it("the lists it holds equal the pipeline's", () => {
    expect([...SLOT_WAIT_REASONS]).toEqual([...BUILD_WAIT_REASONS]);
    expect([...SLOT_HOLDING_STAGES].sort()).toEqual([...BUILD_SLOT_STAGES].sort());
  });

  it("while the slot is still held nothing starts and nothing is written", async () => {
    const a = await account();
    await holder(a);
    const w = await waiter(a);
    const started: AdvanceStartArgs[] = [];
    const out = await sweeper(started).sweepParkedStages([entry]);
    expect(mine(started, a)).toEqual([]);
    expect(out.slotListed).toBeGreaterThanOrEqual(1);
    const facts = await admin.query("SELECT count(*) AS n FROM work_item_driver_events WHERE work_item_id = $1", [w.id]);
    expect(Number(facts.rows[0].n)).toBe(1);
  });

  it("a private pull request merged frees the slot: the sweep is marked, and the waiter starts once under its own approval, with no person", async () => {
    const a = await account();
    const h = await holder(a);
    const w = await waiter(a);
    const started: AdvanceStartArgs[] = [];
    await sweeper(started).sweepParkedStages([entry]);
    expect(mine(started, a)).toEqual([]);
    expect(wakeMarked()).toBe(false);

    expect((await move(a, h, "merged", "dup:merge")).recorded).toBe(true);
    expect(wakeMarked()).toBe(true);
    await sweeper(started).sweepParkedStages([entry]);
    expect(mine(started, a)).toEqual([{ accountId: a.accountId, userId: a.userId, workItemId: w.id, actionId: w.approval, haltEpoch: 0, specVersion: 1 }]);
    expect(await stageOf(w.id)).toBe("spec_ready"); // the workflow moves it; the sweep does not

    // The same webhook again: a duplicate, no new marker; another pass: the claim is fresh, so nothing starts twice.
    markers.clear();
    expect(await move(a, h, "merged", "dup:merge")).toEqual({ recorded: false, reason: "duplicate" });
    expect(wakeMarked()).toBe(false);
    await sweeper(started).sweepParkedStages([entry]);
    await sweeper(started).sweepParkedStages([entry]);
    expect(mine(started, a)).toHaveLength(1);
  });

  it("a pull request closed without merging frees the slot the same way", async () => {
    const a = await account();
    const h = await holder(a, "changes_requested");
    const w = await waiter(a);
    await move(a, h, "closed_unmerged");
    expect(wakeMarked()).toBe(true);
    const started: AdvanceStartArgs[] = [];
    await sweeper(started).sweepParkedStages([entry]);
    expect(mine(started, a).map((s) => s.workItemId)).toEqual([w.id]);
  });

  it("the merge of the PUBLIC pull request of a paired item frees the slot held by the private item", async () => {
    const a = await account();
    const h = await holder(a, "review_passed");
    const w = await waiter(a);
    const codeRepo = "acme/widgets-public";
    const pushed = await admin.query<{ branch: string }>(
      `INSERT INTO plane_pushes (account_id, work_item_id, repo_id, code_repo, pairing_digest, state, head_sha, tip_sha, pr_number, pr_url)
       VALUES ($1, $2, $3, $4, $5, 'pr_opened', $6, $6, 4242, $7) RETURNING branch`,
      [a.accountId, h, a.repoId, codeRepo, "a".repeat(64), "b".repeat(40), `https://github.com/${codeRepo}/pull/4242`],
    );
    const mapped: MappedEvent = { kind: "transition_pr", toStage: "merged", at: new Date(), prNumber: 4242, linkedIssueNumber: null, trust: "trusted", isFork: false, headRef: pushed.rows[0]!.branch } as MappedEvent;
    const applied = await withTenant(appPool, a.accountId, (client) =>
      applyMappedEvent(client, { accountId: a.accountId, installationId: a.installationId, repoId: a.repoId, repo: { accountId: a.accountId, repoId: a.repoId, ghRepoId: 1, fullName: codeRepo }, deliveryId: `d-${randomUUID()}` }, mapped),
    );
    await Promise.resolve();
    expect(applied).toMatchObject({ applied: "transitioned", workItemId: h, recorded: true });
    expect(wakeMarked()).toBe(true);
    const started: AdvanceStartArgs[] = [];
    await sweeper(started).sweepParkedStages([entry]);
    expect(mine(started, a).map((s) => s.workItemId)).toEqual([w.id]);
  });

  it("two waiters: only the oldest starts, and the other keeps waiting for the next slot", async () => {
    const a = await account();
    const h = await holder(a);
    const younger = await waiter(a, { createdDaysAgo: 1 });
    const oldest = await waiter(a, { createdDaysAgo: 5 });
    await move(a, h, "merged");
    const started: AdvanceStartArgs[] = [];
    await sweeper(started).sweepParkedStages([entry]);
    await sweeper(started).sweepParkedStages([entry]);
    expect(mine(started, a).map((s) => s.workItemId)).toEqual([oldest.id]);
    expect(await stageOf(younger.id)).toBe("spec_ready");
  });

  it("an item that needs a person's approval stays where it is, and the oldest approved one behind it starts", async () => {
    const a = await account();
    const h = await holder(a);
    const unapproved = await waiter(a, { approved: false, createdDaysAgo: 5 });
    const approved = await waiter(a, { createdDaysAgo: 1 });
    await move(a, h, "merged");
    const started: AdvanceStartArgs[] = [];
    await sweeper(started).sweepParkedStages([entry]);
    expect(mine(started, a).map((s) => s.workItemId)).toEqual([approved.id]);
    expect(mine(started, a).some((s) => s.workItemId === unapproved.id)).toBe(false);
  });

  it("a waiter whose workflow is alive (its wait fact is fresh) is left to that workflow", async () => {
    const a = await account();
    const h = await holder(a);
    await waiter(a, { ageSeconds: 30 });
    await move(a, h, "merged");
    const started: AdvanceStartArgs[] = [];
    await sweeper(started).sweepParkedStages([entry]);
    expect(mine(started, a)).toEqual([]);
  });

  it("a halted waiter is not started", async () => {
    const a = await account();
    const h = await holder(a);
    const halted = await waiter(a);
    await admin.query("UPDATE work_items SET halted_at = now(), halt_action_id = $2 WHERE id = $1", [halted.id, randomUUID()]);
    await move(a, h, "merged");
    const started: AdvanceStartArgs[] = [];
    await sweeper(started).sweepParkedStages([entry]);
    expect(mine(started, a)).toEqual([]);
  });
});
