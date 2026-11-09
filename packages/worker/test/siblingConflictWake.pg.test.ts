import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { createSiblingConflictWake, findSiblingCandidates, requestSiblingAdvance, SIBLING_WAKE_CODE } from "../src/siblingConflictWake.js";
import type { AdvanceStartArgs } from "../src/advance.js";

/**
 * A merge wakes the repository's other open pull requests that now conflict [pg]: real rows, the real driver-event store, the real approval decision and the real candidate
 * query. The stand-ins are the workflow starter (it records what it was asked to start) and GitHub's answer about each pull request. What the started workflow does next (the
 * gate answering `merge_conflict` and the conflict fix round) is the existing machinery, covered by its own tests; here the boundary is that the workflow is started, once,
 * for the conflicting item and for no other.
 */
describe("a merge wakes the pull requests it left conflicting [pg]", { timeout: 90_000 }, () => {
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
  let n = 9500;

  interface Item { id: string; approval: string; pr: number }
  /** An item at `stage` of this account's repository whose newest gate answer was for pull request `pr`, approved by the account's owner. */
  async function item(a: SeedRefs, pr: number, o: { stage?: string; halted?: boolean; approved?: boolean; liveRun?: boolean; approvedAgo?: string; paired?: { codeRepo?: string; state?: string } } = {}): Promise<Item> {
    const id = randomUUID();
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'feature', 'internal', $4, $5)", [id, a.accountId, a.repoId, o.stage ?? "review_passed", n++]);
    if (o.halted) await admin.query("UPDATE work_items SET halted_at = now(), halt_action_id = $2 WHERE id = $1", [id, randomUUID()]);
    const approval = randomUUID();
    if (o.approved !== false) {
      await admin.query(
        `INSERT INTO run_action_requests (id, account_id, kind, target_id, requested_by, principal_kind, request_hash, state, finished_at, outcome)
         VALUES ($1, $2, 'advance_work_item', $3, $4, 'session', $5, 'done', now() - $7::interval, $6::jsonb)`,
        [approval, a.accountId, id, `session:${a.userId}`, "h".repeat(64), JSON.stringify({ work_item_id: id, advance: "started" }), o.approvedAgo ?? "1 hour"],
      );
    }
    await admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, reasons, head_sha, pr_number, dedupe_key) VALUES ($1, $2, 'merge_gate', 'ready_human_merges', ARRAY['auto_merge_not_allowed'], $3, $4, $5)", [a.accountId, id, HEAD, pr, randomUUID()]);
    if (o.paired) {
      await admin.query(
        `INSERT INTO plane_pushes (account_id, work_item_id, repo_id, code_repo, pairing_digest, head_sha, tip_sha, pr_number, pr_url, state) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [a.accountId, id, a.repoId, o.paired.codeRepo ?? CODE_REPO, "d".repeat(64), "b".repeat(40), "c".repeat(40), pr, `https://github.com/${o.paired.codeRepo ?? CODE_REPO}/pull/${pr}`, o.paired.state ?? "pr_opened"],
      );
    }
    if (o.liveRun) await admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'local', 'running')", [randomUUID(), a.accountId, id]);
    return { id, approval, pr };
  }

  /** Moves the item into Needs a person `ago` ago, and records the escalation that holds it there `escalatedAgo` ago. */
  async function escalate(a: SeedRefs, id: string, code: string, ago: string, escalatedAgo: string): Promise<void> {
    await admin.query("INSERT INTO work_item_transitions (account_id, work_item_id, from_stage, to_stage, at, source, source_ref, created_at) VALUES ($1, $2, 'review_passed', 'needs_human', now() - $3::interval, 'control_plane', $4, now() - $3::interval)", [a.accountId, id, ago, randomUUID()]);
    await admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, dedupe_key, created_at) VALUES ($1, $2, 'escalated', $3, $4, now() - $5::interval)", [a.accountId, id, code, randomUUID(), escalatedAgo]);
  }
  const HOLDS = ["reviewer_no_verdict", "merge_queue_retry_used", "merge_queue_no_answer"];
  const ask = (a: SeedRefs, i: Item) => requestSiblingAdvance(writerPool, { startAdvance: async () => undefined, log: () => undefined }, { accountId: a.accountId, workItemId: i.id, prNumber: i.pr, merged: merged(700) });

  const merged = (prNumber: number, repoFullName = "acme/widgets") => ({ repoFullName, prNumber });
  /** A starter that records, and a wake whose GitHub answer for each pull request number comes from `conflicting`. */
  function harness(conflicting: Record<number, boolean | null | "throw">) {
    const started: AdvanceStartArgs[] = [];
    const asked: number[] = [];
    const wake = createSiblingConflictWake(writerPool, { startAdvance: async (args) => void started.push(args), log: () => undefined });
    const run = (a: SeedRefs, m = merged(700)) =>
      wake.wakeConflictingSiblings({
        accountId: a.accountId,
        repoId: a.repoId,
        merged: m,
        isConflicting: async (pr) => {
          asked.push(pr);
          const v = conflicting[pr];
          if (v === "throw") throw new Error("GitHub unavailable");
          return v === undefined ? null : v;
        },
      });
    return { started, asked, run };
  }
  const claims = async (id: string) => (await admin.query<{ reasons: string[]; pr_number: number | null; attempt: number }>("SELECT reasons, pr_number, attempt FROM work_item_driver_events WHERE work_item_id = $1 AND kind = 'stage_waiting' AND code = $2 ORDER BY seq", [id, SIBLING_WAKE_CODE])).rows;

  it("wakes the conflicting item once, as its approver, on the approval it has; the clean one is not disturbed", async () => {
    const a = await seedAccount(admin, randomUUID());
    const conflicted = await item(a, 701);
    const clean = await item(a, 702);
    const h = harness({ 701: true, 702: false });
    expect(await h.run(a)).toBe(1);
    expect(h.asked.sort()).toEqual([701, 702]);
    expect(h.started).toHaveLength(1);
    expect(h.started[0]).toMatchObject({ accountId: a.accountId, userId: a.userId, workItemId: conflicted.id, actionId: conflicted.approval, haltEpoch: 0 });
    // The claim names what the conflict came after, and nothing was written for the clean item.
    expect(await claims(conflicted.id)).toEqual([{ reasons: ["after_pr_700"], pr_number: 701, attempt: 0 }]);
    expect(await claims(clean.id)).toEqual([]);
  });

  it("a replayed delivery, or two at once, start nothing more; the next merge is a new reason and asks again", async () => {
    const a = await seedAccount(admin, randomUUID());
    const it1 = await item(a, 711);
    const h = harness({ 711: true });
    const both = await Promise.all([h.run(a), h.run(a)]);
    expect(both.reduce((x, y) => x + y, 0)).toBe(1);
    expect(await h.run(a)).toBe(0);
    expect(h.started).toHaveLength(1);
    expect(await claims(it1.id)).toHaveLength(1);
    // The same number in another repository is another merge, and so is the next number in this one.
    expect(await h.run(a, merged(703))).toBe(1);
    expect(await h.run(a, merged(700, "other/widgets"))).toBe(1);
    expect(h.started).toHaveLength(3);
    expect((await claims(it1.id)).map((c) => c.reasons[0]).sort()).toEqual(["after_pr_700", "after_pr_700", "after_pr_703"]);
  });

  it("GitHub not able to say (still computing, not open) or failing to answer leaves the item alone; one unreadable pull request does not stop the others", async () => {
    const a = await seedAccount(admin, randomUUID());
    const computing = await item(a, 721);
    const broken = await item(a, 722);
    const real = await item(a, 723);
    const h = harness({ 721: null, 722: "throw", 723: true });
    expect(await h.run(a)).toBe(1);
    expect(h.started.map((s) => s.workItemId)).toEqual([real.id]);
    expect(await claims(computing.id)).toEqual([]);
    expect(await claims(broken.id)).toEqual([]);
  });

  it("the merged pull request's own item is never a candidate, and neither is an item whose pull request is another repository's", async () => {
    const a = await seedAccount(admin, randomUUID());
    const same = await item(a, 700);
    const paired = await item(a, 731, { paired: { codeRepo: "Acme/other-public" } });
    const found = await findSiblingCandidates(writerPool, a, merged(700, "acme/widgets-public"));
    expect(found.map((c) => c.workItemId)).not.toContain(same.id);
    expect(found.map((c) => c.workItemId)).not.toContain(paired.id);
  });

  it("an item with a public copy is found by the copy's repository and number, case-insensitively; a closed or merged copy is not", async () => {
    const a = await seedAccount(admin, randomUUID());
    const open = await item(a, 741, { paired: {} });
    const closed = await item(a, 742, { paired: { state: "pr_closed" } });
    const found = await findSiblingCandidates(writerPool, a, merged(700, "acme/widgets-public"));
    expect(found).toEqual([{ workItemId: open.id, prNumber: 741 }]);
    expect(found.map((c) => c.workItemId)).not.toContain(closed.id);
  });

  it("an item that is merged, closed, halted, has no approval, or has a run live is not started", async () => {
    const a = await seedAccount(admin, randomUUID());
    const skipped = [await item(a, 751, { stage: "merged" }), await item(a, 752, { stage: "closed" }), await item(a, 753, { halted: true }), await item(a, 754, { approved: false }), await item(a, 755, { liveRun: true })];
    const h = harness(Object.fromEntries(skipped.map((s) => [s.pr, true])));
    expect(await h.run(a)).toBe(0);
    expect(h.started).toEqual([]);
    for (const s of skipped) expect(await claims(s.id), String(s.pr)).toEqual([]);
  });

  it("every pull-request stage is woken, and Needs a person only when it is held for a missing verdict (any other cause is a build, not this review)", async () => {
    const a = await seedAccount(admin, randomUUID());
    const staged = [await item(a, 761, { stage: "pr_opened" }), await item(a, 762, { stage: "review_passed" }), await item(a, 763, { stage: "changes_requested" })];
    const stuck = await item(a, 764, { stage: "needs_human" });
    const h = harness({ 761: true, 762: true, 763: true, 764: true });
    expect(await h.run(a)).toBe(3);
    expect(h.started.map((s) => s.workItemId).sort()).toEqual(staged.map((s) => s.id).sort());
    expect(await claims(stuck.id)).toEqual([]);
  });

  it("a starter that fails leaves the claim and reports it, and does not throw into the delivery", async () => {
    const a = await seedAccount(admin, randomUUID());
    const it1 = await item(a, 771);
    const out = await requestSiblingAdvance(writerPool, { startAdvance: async () => Promise.reject(new Error("workflow service down")), log: () => undefined }, { accountId: a.accountId, workItemId: it1.id, prNumber: 771, merged: merged(700) });
    expect(out).toEqual({ started: false, reason: "start_failed" });
    expect(await claims(it1.id)).toHaveLength(1);
  });

  it("no starter configured starts nothing and claims nothing", async () => {
    const a = await seedAccount(admin, randomUUID());
    const it1 = await item(a, 781);
    expect(await requestSiblingAdvance(writerPool, { startAdvance: null, log: () => undefined }, { accountId: a.accountId, workItemId: it1.id, prNumber: 781, merged: merged(700) })).toEqual({ started: false, reason: "advance_unavailable" });
    expect(await claims(it1.id)).toEqual([]);
  });

  it.each(HOLDS)("Needs a person held by %s with an approval that PREDATES the escalation is not woken (the old approval was for an earlier build), and nothing is claimed", async (code) => {
    const a = await seedAccount(admin, randomUUID());
    const held = await item(a, 801, { stage: "needs_human", approvedAgo: "2 hours" });
    await escalate(a, held.id, code, "1 hour", "30 minutes");
    expect(await ask(a, held)).toEqual({ started: false, reason: "approval_predates_escalation" });
    const h = harness({ 801: true });
    expect(await h.run(a)).toBe(0);
    expect(h.started).toEqual([]);
    expect(await claims(held.id)).toEqual([]);
  });

  it.each(HOLDS)("Needs a person held by %s with an approval given AFTER the escalation is woken, once, on that approval", async (code) => {
    const a = await seedAccount(admin, randomUUID());
    const held = await item(a, 811, { stage: "needs_human", approvedAgo: "2 hours" });
    await escalate(a, held.id, code, "1 hour", "30 minutes");
    // The store stamps its own times on the move and the escalation, so the person's approval is what is placed after them.
    await admin.query("UPDATE run_action_requests SET finished_at = now() + interval '1 second' WHERE id = $1", [held.approval]);
    const h = harness({ 811: true });
    expect(await h.run(a)).toBe(1);
    expect(h.started).toHaveLength(1);
    expect(h.started[0]).toMatchObject({ workItemId: held.id, actionId: held.approval });
    expect(await h.run(a)).toBe(0);
  });

  it("an item whose last workflow ended in a stop or an escalation for a person after the last gate answer is not restarted; a newer gate answer makes it eligible again", async () => {
    const a = await seedAccount(admin, randomUUID());
    const stopped = await item(a, 821);
    await admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, dedupe_key) VALUES ($1, $2, 'stopped', 'merge_gate', $3)", [a.accountId, stopped.id, randomUUID()]);
    expect(await ask(a, stopped)).toEqual({ started: false, reason: "moved_on" });
    const escalated = await item(a, 822);
    await admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, dedupe_key) VALUES ($1, $2, 'escalated', 'reviewer_fail', $3)", [a.accountId, escalated.id, randomUUID()]);
    expect(await ask(a, escalated)).toEqual({ started: false, reason: "moved_on" });
    // A workflow that ran again wrote a new gate answer after the stop: the stop is no longer the newest word.
    await admin.query("INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, reasons, head_sha, pr_number, dedupe_key) VALUES ($1, $2, 'merge_gate', 'ready_human_merges', ARRAY['auto_merge_not_allowed'], $3, 821, $4)", [a.accountId, stopped.id, HEAD, randomUUID()]);
    expect(await ask(a, stopped)).toEqual({ started: true });
  });

  it("the claim carries the head the last gate answer was for, also when the start fails, so a head-bound parked review that finds it as the newest wait still has its head", async () => {
    const a = await seedAccount(admin, randomUUID());
    const it1 = await item(a, 831);
    const out = await requestSiblingAdvance(writerPool, { startAdvance: async () => Promise.reject(new Error("workflow service down")), log: () => undefined }, { accountId: a.accountId, workItemId: it1.id, prNumber: 831, merged: merged(700) });
    expect(out).toEqual({ started: false, reason: "start_failed" });
    expect((await admin.query("SELECT head_sha FROM work_item_driver_events WHERE work_item_id = $1 AND code = $2", [it1.id, SIBLING_WAKE_CODE])).rows).toEqual([{ head_sha: HEAD }]);
  });
});
