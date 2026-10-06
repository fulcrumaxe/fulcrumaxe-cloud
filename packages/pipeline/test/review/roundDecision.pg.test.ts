import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ExecutionTargetRegistry } from "@fx/runner";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { recordStage } from "@fx/core/src/work-items/recordStage.js";
import { listDriverEvents, recordDriverEvent } from "@fx/core/src/work-items/driverEvents.js";
import { fixRoundsStarted, maxFixRounds, recordRound } from "../../src/review/roundDecision.js";
import type { GatheredVerdict } from "../../src/review/verdicts.js";
import { createFakeExecutionTarget } from "../build/helpers/fakeExecutionTarget.js";
import { seedAccount, seedRepo, seedWorkItem } from "../build/helpers/seed.js";
import { pgHarness } from "../helpers/pgHarness.js";

/**
 * D#483 P3: one review round recorded against real Postgres. The point of the file is the live bug: an item showed
 * "ready to merge" with a needs-fix pending, because the verdicts were recorded one at a time in the order they finished
 * and a pass recorded last won. Every verdict is gathered first and recorded passes first.
 */
describe("recordRound [pg]", () => {
  const db = pgHarness();
  const HEAD = "a".repeat(40);

  async function seed(): Promise<{ accountId: string; workItemId: string; registry: ExecutionTargetRegistry }> {
    const accountId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    await seedWorkItem(db.admin, accountId, workItemId, repoId, { ghNumber: 7 });
    for (const toStage of ["spec_ready", "in_progress", "pr_opened"] as const) {
      await withTenant(db.runWriterPool, accountId, (c) => recordStage(c, { workItemId, toStage, at: new Date(), source: "control_plane", sourceRef: `seed-${toStage}` }));
    }
    return { accountId, workItemId, registry: { sandbox: createFakeExecutionTarget().target } };
  }

  async function reviewerRun(accountId: string, workItemId: string, role: string, verdict: string): Promise<string> {
    const id = randomUUID();
    await db.admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, envelope, head_sha) VALUES ($1, $2, $3, $4, 'production', 'succeeded', $5::jsonb, $6)`,
      [id, accountId, workItemId, role, JSON.stringify({ verdict }), HEAD],
    );
    return id;
  }

  const stageOf = async (accountId: string, workItemId: string) => (await db.admin.query<{ stage: string }>("SELECT stage FROM work_items WHERE account_id = $1 AND id = $2", [accountId, workItemId])).rows[0]!.stage;
  const transitions = async (workItemId: string) =>
    (await db.admin.query<{ to_stage: string; reviewer: string | null }>("SELECT to_stage, reviewer FROM work_item_transitions WHERE work_item_id = $1 AND to_stage IN ('changes_requested', 'review_passed') ORDER BY created_at, id", [workItemId])).rows;
  const events = (accountId: string, workItemId: string) => withTenant(db.runWriterPool, accountId, (c) => listDriverEvents(c, workItemId));

  const gather = async (accountId: string, workItemId: string, spec: Array<[GatheredVerdict["role"], "pass" | "needs-fix" | "fail"]>): Promise<GatheredVerdict[]> =>
    Promise.all(spec.map(async ([role, verdict]) => ({ role, verdict, runId: await reviewerRun(accountId, workItemId, role, verdict) })));

  const REQUIRED = ["code-reviewer", "acceptance-tester"] as const;

  it("every required role passed: all_passed, the item is at review_passed, and the verdicts are one driver event", async () => {
    const { accountId, workItemId, registry } = await seed();
    const verdicts = await gather(accountId, workItemId, [["code-reviewer", "pass"], ["acceptance-tester", "pass"]]);
    const out = await recordRound(db.runWriterPool, registry, { accountId, workItemId, headSha: HEAD, prNumber: 41, requiredRoles: REQUIRED, verdicts });
    expect(out.decision).toBe("all_passed");
    expect(await stageOf(accountId, workItemId)).toBe("review_passed");
    const ev = (await events(accountId, workItemId)).filter((e) => e.kind === "review_verdicts");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ head_sha: HEAD, pr_number: 41, reasons: ["code_reviewer_pass", "acceptance_tester_pass"] });
  });

  it.each([
    ["the needs-fix finishes first", [["code-reviewer", "needs-fix"], ["acceptance-tester", "pass"]]],
    ["the pass finishes first", [["acceptance-tester", "pass"], ["code-reviewer", "needs-fix"]]],
  ] as const)("a needs-fix and a pass on one head (%s): the item ends at changes_requested, never review_passed (the live bug)", async (_n, spec) => {
    const { accountId, workItemId, registry } = await seed();
    const verdicts = await gather(accountId, workItemId, spec.map(([r, v]) => [r, v]) as never);
    const out = await recordRound(db.runWriterPool, registry, { accountId, workItemId, headSha: HEAD, prNumber: 41, requiredRoles: REQUIRED, verdicts });
    expect(out.decision).toBe("fix");
    expect(out.nextRound).toBe(1);
    expect(await stageOf(accountId, workItemId)).toBe("changes_requested");
    // The pass was recorded first and the needs-fix last.
    expect((await transitions(workItemId)).map((t) => t.to_stage)).toEqual(["review_passed", "changes_requested"]);
    expect(out.recorded.map((r) => `${r.role}:${r.outcome}`)).toEqual(["acceptance-tester:passed", "code-reviewer:fix_needed"]);
  });

  it("two reviewers asking for changes on one head are ONE round (the transitions are two, the rounds are counted by fix rounds started)", async () => {
    const { accountId, workItemId, registry } = await seed();
    const verdicts = await gather(accountId, workItemId, [["code-reviewer", "needs-fix"], ["acceptance-tester", "fail"]]);
    // a fail beside a needs-fix is a reviewer_fail; use two needs-fix for the round count
    const two = await gather(accountId, workItemId, [["code-reviewer", "needs-fix"], ["acceptance-tester", "needs-fix"]]);
    const out = await recordRound(db.runWriterPool, registry, { accountId, workItemId, headSha: "b".repeat(40), prNumber: 41, requiredRoles: REQUIRED, verdicts: two });
    expect(out.decision).toBe("fix");
    expect(out.round).toBe(0);
    expect((await transitions(workItemId)).filter((t) => t.to_stage === "changes_requested")).toHaveLength(2);
    void verdicts;
  });

  it("the round after the limit is escalated: needs_human, the escalation event, and a driver event; rounds are the fix rounds that STARTED", async () => {
    const { accountId, workItemId, registry } = await seed();
    await withTenant(db.runWriterPool, accountId, async (c) => {
      for (let i = 1; i <= maxFixRounds(); i++) await recordDriverEvent(c, accountId, { workItemId, kind: "fix_round_started", dedupeKey: `r${i}`, round: i });
    });
    expect(await fixRoundsStarted(db.runWriterPool, accountId, workItemId)).toBe(maxFixRounds());
    const verdicts = await gather(accountId, workItemId, [["code-reviewer", "needs-fix"], ["acceptance-tester", "pass"]]);
    const out = await recordRound(db.runWriterPool, registry, { accountId, workItemId, headSha: HEAD, prNumber: 41, requiredRoles: REQUIRED, verdicts });
    expect(out.decision).toBe("escalated");
    expect(out.round).toBe(maxFixRounds());
    expect(await stageOf(accountId, workItemId)).toBe("needs_human");
    const esc = (await events(accountId, workItemId)).filter((e) => e.kind === "escalated");
    expect(esc).toHaveLength(1);
    expect(esc[0]).toMatchObject({ code: "max_fix_rounds", head_sha: HEAD });
    const domain = await db.admin.query("SELECT 1 FROM domain_events WHERE account_id = $1 AND subject_id = $2 AND type = 'work_item.needs_human'", [accountId, workItemId]);
    expect(domain.rowCount).toBe(1);
  });

  it("the third round is still allowed", async () => {
    const { accountId, workItemId, registry } = await seed();
    await withTenant(db.runWriterPool, accountId, async (c) => {
      for (const i of [1, 2]) await recordDriverEvent(c, accountId, { workItemId, kind: "fix_round_started", dedupeKey: `r${i}`, round: i });
    });
    const verdicts = await gather(accountId, workItemId, [["code-reviewer", "needs-fix"], ["acceptance-tester", "pass"]]);
    const out = await recordRound(db.runWriterPool, registry, { accountId, workItemId, headSha: HEAD, prNumber: 41, requiredRoles: REQUIRED, verdicts });
    expect(out).toMatchObject({ decision: "fix", round: 2, nextRound: 3 });
    expect(await stageOf(accountId, workItemId)).toBe("changes_requested");
  });

  it("a reviewer's fail stops the driver: changes_requested stays, no needs_human, and the stop is a driver event", async () => {
    const { accountId, workItemId, registry } = await seed();
    const verdicts = await gather(accountId, workItemId, [["code-reviewer", "pass"], ["acceptance-tester", "fail"]]);
    const out = await recordRound(db.runWriterPool, registry, { accountId, workItemId, headSha: HEAD, prNumber: 41, requiredRoles: REQUIRED, verdicts });
    expect(out.decision).toBe("reviewer_fail");
    expect(await stageOf(accountId, workItemId)).toBe("changes_requested");
    const esc = (await events(accountId, workItemId)).filter((e) => e.kind === "escalated");
    expect(esc).toHaveLength(1);
    expect(esc[0]).toMatchObject({ code: "reviewer_fail" });
  });

  it("an incomplete round (a required reviewer has no verdict) records no pass, so the card never says passed with a reviewer missing", async () => {
    const { accountId, workItemId, registry } = await seed();
    const verdicts = await gather(accountId, workItemId, [["code-reviewer", "pass"]]);
    const out = await recordRound(db.runWriterPool, registry, { accountId, workItemId, headSha: HEAD, prNumber: 41, requiredRoles: REQUIRED, verdicts });
    expect(out.decision).toBe("incomplete");
    expect(out.recorded).toEqual([]);
    expect(await stageOf(accountId, workItemId)).toBe("pr_opened");
    // ... but the verdict is still a recorded fact.
    expect((await events(accountId, workItemId)).filter((e) => e.kind === "review_verdicts")).toHaveLength(1);
  });

  it("an incomplete round still records a non-pass it has", async () => {
    const { accountId, workItemId, registry } = await seed();
    const verdicts = await gather(accountId, workItemId, [["code-reviewer", "needs-fix"]]);
    const out = await recordRound(db.runWriterPool, registry, { accountId, workItemId, headSha: HEAD, prNumber: 41, requiredRoles: REQUIRED, verdicts });
    expect(out.decision).toBe("incomplete");
    expect(await stageOf(accountId, workItemId)).toBe("changes_requested");
  });

  it("a replay of the same round writes nothing twice and answers the same decision", async () => {
    const { accountId, workItemId, registry } = await seed();
    const verdicts = await gather(accountId, workItemId, [["code-reviewer", "needs-fix"], ["acceptance-tester", "pass"]]);
    const input = { accountId, workItemId, headSha: HEAD, prNumber: 41, requiredRoles: REQUIRED, verdicts };
    const first = await recordRound(db.runWriterPool, registry, input);
    const again = await recordRound(db.runWriterPool, registry, input);
    expect(again.decision).toBe(first.decision);
    expect(again.recorded.map((r) => r.outcome)).toEqual(["duplicate", "duplicate"]);
    expect((await transitions(workItemId)).filter((t) => t.to_stage === "changes_requested")).toHaveLength(1);
    expect((await events(accountId, workItemId)).filter((e) => e.kind === "review_verdicts")).toHaveLength(1);
  });

  it("recording never dispatches a resume and never throws for a missing resume input: the driver starts the fix round itself", async () => {
    const { accountId, workItemId } = await seed();
    const { target, calls } = createFakeExecutionTarget();
    const verdicts = await gather(accountId, workItemId, [["code-reviewer", "needs-fix"], ["acceptance-tester", "needs-fix"]]);
    const out = await recordRound(db.runWriterPool, { sandbox: target }, { accountId, workItemId, headSha: HEAD, prNumber: 41, requiredRoles: REQUIRED, verdicts });
    expect(out.decision).toBe("fix");
    expect(calls).toEqual([]);
  });

  it("a debater's needs-fix is recorded as the code review it debated", async () => {
    const { accountId, workItemId, registry } = await seed();
    const verdicts = await gather(accountId, workItemId, [["code-reviewer", "pass"], ["acceptance-tester", "pass"], ["debater", "needs-fix"]]);
    const out = await recordRound(db.runWriterPool, registry, { accountId, workItemId, headSha: HEAD, prNumber: 41, requiredRoles: [...REQUIRED, "debater"], verdicts });
    expect(out.decision).toBe("fix");
    expect(await stageOf(accountId, workItemId)).toBe("changes_requested");
    expect((await transitions(workItemId)).at(-1)).toEqual({ to_stage: "changes_requested", reviewer: "code" });
  });
});
