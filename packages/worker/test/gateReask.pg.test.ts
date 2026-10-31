import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { createGateReask, findGateReaskCandidates, reaskMergeGate, GATE_REASK_CODE } from "../src/gateReask.js";
import type { AdvanceStartArgs } from "../src/advance.js";

/**
 * The merge gate asks itself again [pg]: real rows, the real driver-event store, the real approval decision (`stageApprovalGate`) and the real candidate query. The
 * only stand-in is the workflow starter, which records what it was asked to start. The cases are the states an item can be in when the event arrives.
 */
describe("the merge gate re-ask [pg]", { timeout: 60_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool]) await p.end();
  });

  const HEAD = "a".repeat(40);
  const CODE_REPO = "Acme/widgets-public";
  let n = 9100;

  /** An item at Review passed whose newest gate answer is `reasons`, approved by the account's owner, with a public pull request (#501) recorded for it. */
  async function atGate(o: { reasons?: string[]; code?: string; stage?: string; halted?: boolean; paired?: boolean } = {}) {
    const a: SeedRefs = await seedAccount(admin, randomUUID());
    const w = randomUUID();
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'feature', 'internal', $4, $5)", [w, a.accountId, a.repoId, o.stage ?? "review_passed", n++]);
    if (o.halted) await admin.query("UPDATE work_items SET halted_at = now(), halt_action_id = $2 WHERE id = $1", [w, randomUUID()]);
    const approval = randomUUID();
    await admin.query(
      `INSERT INTO run_action_requests (id, account_id, kind, target_id, requested_by, principal_kind, request_hash, state, finished_at, outcome)
       VALUES ($1, $2, 'advance_work_item', $3, $4, 'session', $5, 'done', now() - interval '1 hour', $6::jsonb)`,
      [approval, a.accountId, w, `session:${a.userId}`, "h".repeat(64), JSON.stringify({ work_item_id: w, advance: "started" })],
    );
    await admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, reasons, head_sha, pr_number, dedupe_key) VALUES ($1, $2, 'merge_gate', $3, $4::text[], $5, 674, $6)", [a.accountId, w, o.code ?? "ready_human_merges", o.reasons ?? ["public_pr_not_open", "auto_merge_not_allowed"], HEAD, randomUUID()]);
    if (o.paired !== false) {
      await admin.query(
        `INSERT INTO plane_pushes (account_id, work_item_id, repo_id, code_repo, pairing_digest, head_sha, tip_sha, pr_number, pr_url, state) VALUES ($1, $2, $3, $4, $5, $6, $7, 501, 'https://github.com/Acme/widgets-public/pull/501', 'pr_opened')`,
        [a.accountId, w, a.repoId, CODE_REPO, "d".repeat(64), "b".repeat(40), "c".repeat(40)],
      );
    }
    return { a, w, approval };
  }

  const ask = (started: AdvanceStartArgs[], w: string, accountId: string, fail = false) =>
    reaskMergeGate(writerPool, { startAdvance: async (args) => (fail ? Promise.reject(new Error("workflow service down")) : void started.push(args)), log: () => undefined }, { accountId, workItemId: w });
  const claims = async (w: string) => Number((await admin.query("SELECT count(*) AS n FROM work_item_driver_events WHERE work_item_id = $1 AND kind = 'stage_waiting' AND code = $2", [w, GATE_REASK_CODE])).rows[0].n);
  const wake = { repoFullName: "acme/widgets-public", prNumbers: [501], headSha: null as string | null };

  it("the public pull request opened (it was not open when the gate ran): the workflow starts once, as the approver, on the approval the item has", async () => {
    const { a, w, approval } = await atGate({ reasons: ["pr_draft", "public_pr_not_open", "auto_merge_not_allowed"] });
    expect(await findGateReaskCandidates(writerPool, { accountId: a.accountId, repoId: a.repoId }, wake)).toEqual([w]);
    const started: AdvanceStartArgs[] = [];
    expect(await ask(started, w, a.accountId)).toEqual({ started: true });
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ accountId: a.accountId, userId: a.userId, workItemId: w, actionId: approval, haltEpoch: 0 });
    expect(await claims(w)).toBe(1);
  });

  it("the checks turned green (ci_not_green): a head match finds the item too, with no pull request number in the event", async () => {
    const { a, w } = await atGate({ reasons: ["ci_not_green"] });
    expect(await findGateReaskCandidates(writerPool, { accountId: a.accountId, repoId: a.repoId }, { repoFullName: CODE_REPO, prNumbers: [], headSha: "b".repeat(40) })).toEqual([w]);
    const started: AdvanceStartArgs[] = [];
    expect((await ask(started, w, a.accountId)).started).toBe(true);
  });

  it("a replay, a second event and two deliveries at once start one workflow: the claim belongs to the gate answer, not the delivery", async () => {
    const { a, w } = await atGate();
    const started: AdvanceStartArgs[] = [];
    const results = await Promise.all([ask(started, w, a.accountId), ask(started, w, a.accountId)]);
    expect(results.filter((r) => r.started)).toHaveLength(1);
    expect(await ask(started, w, a.accountId)).toEqual({ started: false, reason: "already_asked" });
    expect(started).toHaveLength(1);
    expect(await claims(w)).toBe(1);
  });

  it("a gate answer written after the re-ask is a new answer: the next event asks again, once", async () => {
    const { a, w } = await atGate({ reasons: ["ci_not_green"] });
    const started: AdvanceStartArgs[] = [];
    await ask(started, w, a.accountId);
    // The workflow ran and the checks were still running: the gate wrote a fresh answer.
    await admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, reasons, head_sha, pr_number, dedupe_key) VALUES ($1, $2, 'merge_gate', 'ready_human_merges', ARRAY['ci_not_green'], $3, 674, $4)", [a.accountId, w, HEAD, randomUUID()]);
    expect((await ask(started, w, a.accountId)).started).toBe(true);
    expect(started).toHaveLength(2);
    expect((await ask(started, w, a.accountId)).started).toBe(false);
  });

  it("a stop that is not transient is never re-asked: only a person's merge setting is left, or something that still blocks", async () => {
    for (const reasons of [["auto_merge_not_allowed"], ["human_merge_only"], ["head_sha_malformed"], ["ci_not_green", "merge_conflict"], ["a_code_nobody_has_heard_of"]]) {
      const { a, w } = await atGate({ reasons });
      const started: AdvanceStartArgs[] = [];
      expect((await ask(started, w, a.accountId)).started, reasons.join()).toBe(false);
      expect(started).toEqual([]);
      expect(await claims(w)).toBe(0);
    }
  });

  it("an item no longer at the merge gate starts nothing: another newest answer, another stage, halted, a moved head, a review underway, no approval, a live run", async () => {
    const cases: Array<[string, Awaited<ReturnType<typeof atGate>>]> = [
      ["merged", await atGate({ code: "merged" })],
      ["merge_delegated", await atGate({ code: "merge_delegated", reasons: [] })],
      ["stage", await atGate({ stage: "pr_opened" })],
      ["halted", await atGate({ halted: true })],
    ];
    const moved = await atGate();
    await admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, head_sha, pr_number, dedupe_key) VALUES ($1, $2, 'pr_head_pushed', $3, 501, $4)", [moved.a.accountId, moved.w, "e".repeat(40), randomUUID()]);
    cases.push(["head_moved", moved]);
    const reviewing = await atGate();
    await admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, reasons, head_sha, dedupe_key) VALUES ($1, $2, 'review_started', ARRAY['code_reviewer'], $3, $4)", [reviewing.a.accountId, reviewing.w, HEAD, randomUUID()]);
    cases.push(["review_started", reviewing]);
    const noApproval = await atGate();
    await admin.query("DELETE FROM run_action_requests WHERE target_id = $1", [noApproval.w]);
    cases.push(["no_approval", noApproval]);
    const live = await atGate();
    await admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'code-reviewer', 'production', 'running')", [randomUUID(), live.a.accountId, live.w]);
    cases.push(["run_live", live]);
    for (const [name, c] of cases) {
      const started: AdvanceStartArgs[] = [];
      expect((await ask(started, c.w, c.a.accountId)).started, name).toBe(false);
      expect(started, name).toEqual([]);
      expect(await claims(c.w), name).toBe(0);
    }
    // Only the stage and halt cases are also kept out of the candidate list; the rest are decided by the re-ask itself.
    expect(await findGateReaskCandidates(writerPool, { accountId: cases[2]![1].a.accountId, repoId: cases[2]![1].a.repoId }, wake)).toEqual([]);
    expect(await findGateReaskCandidates(writerPool, { accountId: cases[3]![1].a.accountId, repoId: cases[3]![1].a.repoId }, wake)).toEqual([]);
  });

  it("another repository's pull request of the same number, and another account's item, are not candidates", async () => {
    const { a, w } = await atGate();
    const other = await atGate();
    expect(await findGateReaskCandidates(writerPool, { accountId: a.accountId, repoId: a.repoId }, { ...wake, repoFullName: "acme/someone-elses" })).toEqual([]);
    expect(await findGateReaskCandidates(writerPool, { accountId: a.accountId, repoId: a.repoId }, wake)).toEqual([w]);
    expect(await findGateReaskCandidates(writerPool, { accountId: other.a.accountId, repoId: other.a.repoId }, wake)).toEqual([other.w]);
  });

  it("an unpaired repository: a finished check of the pull request the gate answered for finds the item", async () => {
    const { a, w } = await atGate({ paired: false, reasons: ["ci_not_green"] });
    expect(await findGateReaskCandidates(writerPool, { accountId: a.accountId, repoId: a.repoId }, { repoFullName: "acme/widgets", prNumbers: [674], headSha: null })).toEqual([w]);
    // The same number on a different repository of the account is not this item's pull request.
    expect(await findGateReaskCandidates(writerPool, { accountId: a.accountId, repoId: randomUUID() }, { repoFullName: "acme/other", prNumbers: [674], headSha: null })).toEqual([]);
  });

  it("the worker's wake finds the item from a delivery's facts and asks it once; the same delivery again asks nothing", async () => {
    const { a, w } = await atGate({ reasons: ["public_pr_not_open"] });
    const started: AdvanceStartArgs[] = [];
    const facade = createGateReask(writerPool, { startAdvance: async (args) => void started.push(args), log: () => undefined });
    const input = { accountId: a.accountId, repoId: a.repoId, wake };
    expect(await facade.wakeMergeGate(input)).toBe(1);
    expect(await facade.wakeMergeGate(input)).toBe(0);
    expect(started.map((s) => s.workItemId)).toEqual([w]);
  });

  it("the workflow service being down leaves the claim (a wait nothing refreshes, shown as stalled) and never throws into the delivery", async () => {
    const { a, w } = await atGate();
    const started: AdvanceStartArgs[] = [];
    expect(await ask(started, w, a.accountId, true)).toEqual({ started: false, reason: "start_failed" });
    expect(await claims(w)).toBe(1);
    expect(await ask(started, w, a.accountId)).toEqual({ started: false, reason: "already_asked" });
  });
});
