import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutionTargetRegistry } from "@fx/runner";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { recordStage } from "@fx/core/src/work-items/recordStage.js";
import type { CiGate } from "../../src/review/ciWait.js";
import { recordRunFollowUps } from "../../src/review/followUps.js";
import { recordRound } from "../../src/review/roundDecision.js";
import { recordVerdictsInOrder, type GatheredVerdict } from "../../src/review/verdicts.js";
import { createFakeExecutionTarget } from "../build/helpers/fakeExecutionTarget.js";
import { seedAccount, seedRepo, seedWorkItem } from "../build/helpers/seed.js";
import { pgHarness } from "../helpers/pgHarness.js";

/**
 * [pg] D#483 S5-b2d-1: a review round records each reviewer run's follow-ups after its verdicts (C27-b2d1-1 through the real call site), and a
 * follow-up write that fails never touches the verdict or the stage and leaves one fixed log line (C27-b2d1-5). Envelopes are fixtures.
 */
describe("follow-ups recorded with a review round [pg]", () => {
  const db = pgHarness();
  const HEAD = "c".repeat(40);
  const SETTLED: CiGate = { read: async () => ({ state: "settled", reasons: [] }) };
  afterEach(() => vi.restoreAllMocks());

  async function seed(): Promise<{ accountId: string; workItemId: string; registry: ExecutionTargetRegistry }> {
    const accountId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId);
    await seedWorkItem(db.admin, accountId, workItemId, repoId, { ghNumber: 9 });
    for (const toStage of ["spec_ready", "in_progress", "pr_opened"] as const) {
      await withTenant(db.runWriterPool, accountId, (c) => recordStage(c, { workItemId, toStage, at: new Date(), source: "control_plane", sourceRef: `seed-${toStage}` }));
    }
    return { accountId, workItemId, registry: { sandbox: createFakeExecutionTarget().target } };
  }
  async function reviewerRun(accountId: string, workItemId: string, role: string, envelope: Record<string, unknown>): Promise<string> {
    const id = randomUUID();
    await db.admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, envelope, head_sha) VALUES ($1, $2, $3, $4, 'production', 'succeeded', $5::jsonb, $6)`,
      [id, accountId, workItemId, role, JSON.stringify(envelope), HEAD],
    );
    return id;
  }
  const followUps = async (workItemId: string) =>
    (await db.admin.query<{ title: string; disposition: string; source_role: string }>("SELECT title, disposition, source_role FROM work_item_follow_ups WHERE work_item_id = $1 ORDER BY title", [workItemId])).rows;
  const stageOf = async (workItemId: string) => (await db.admin.query<{ stage: string }>("SELECT stage FROM work_items WHERE id = $1", [workItemId])).rows[0]!.stage;
  const passes = (accountId: string, workItemId: string): Promise<GatheredVerdict[]> =>
    Promise.all([
      reviewerRun(accountId, workItemId, "code-reviewer", { verdict: "pass", follow_ups: [{ title: "Add a retry", why: "flaky" }, { title: "Log the timeout", why: "" }] }),
      reviewerRun(accountId, workItemId, "security-reviewer", { verdict: "pass", follow_ups: [{ title: " add  a RETRY ", why: "same one" }] }),
      reviewerRun(accountId, workItemId, "debater", { verdict: "pass", follow_ups: [{ title: "Never stored", why: "" }] }),
    ]).then(([c, s, d]) => [
      { role: "code-reviewer", runId: c, verdict: "pass" },
      { role: "security-reviewer", runId: s, verdict: "pass" },
      { role: "debater", runId: d, verdict: "pass", debatedRole: "code-reviewer" },
    ]);

  it("C27-b2d1-1/2 through recordRound: each reviewer run's follow-ups are recorded once, deduplicated across reviewers; the debater's are not", async () => {
    const { accountId, workItemId, registry } = await seed();
    const verdicts = await passes(accountId, workItemId);
    const input = { accountId, workItemId, headSha: HEAD, prNumber: 3, requiredRoles: ["code-reviewer", "security-reviewer"] as const, verdicts };
    expect((await recordRound(db.runWriterPool, registry, input, SETTLED)).decision).toBe("all_passed");
    expect(await followUps(workItemId)).toEqual([
      { title: "Add a retry", disposition: "child", source_role: "code-reviewer" },
      { title: "Log the timeout", disposition: "child", source_role: "code-reviewer" },
    ]);
    // A replay of the same round records nothing more.
    await recordRound(db.runWriterPool, registry, input, SETTLED);
    expect(await followUps(workItemId)).toHaveLength(2);
  });

  it("emoji text: a good item beside an over-long emoji item is recorded, the over-long one is dropped, and nothing fails (no 22P02)", async () => {
    const { accountId, workItemId, registry } = await seed();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const exact = "😀".repeat(120);
    const runId = await reviewerRun(accountId, workItemId, "code-reviewer", {
      verdict: "pass",
      follow_ups: [{ title: "Add a retry 🔁", why: "flaky 📶" }, { title: "😀".repeat(400), why: "" }, { title: exact, why: "🧪".repeat(600) }],
    });
    await recordVerdictsInOrder(db.runWriterPool, registry, { accountId, workItemId, headSha: HEAD, prNumber: 3, round: 0, verdicts: [{ role: "code-reviewer", runId, verdict: "pass" }] });
    expect(warn).not.toHaveBeenCalled();
    const rows = (await db.admin.query<{ title: string; why: string; n: number }>("SELECT title, why, char_length(title)::int AS n FROM work_item_follow_ups WHERE work_item_id = $1 ORDER BY n", [workItemId])).rows;
    expect(rows).toEqual([
      { title: "Add a retry 🔁", why: "flaky 📶", n: 13 },
      { title: exact, why: "🧪".repeat(600), n: 120 },
    ]);
  });

  it("C27-b2d1-5: a follow-up write that throws leaves the verdicts and the stage as they would be, and logs one fixed line with the run id only", async () => {
    const { accountId, workItemId, registry } = await seed();
    const verdicts = await passes(accountId, workItemId);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // The fault: the database refuses the connection, with error text that must never reach the log.
    const broken = { connect: async () => { throw new Error("connection refused: secret-ish detail"); } } as unknown as Pool;
    const out = await recordVerdictsInOrder(db.runWriterPool, registry, { accountId, workItemId, headSha: HEAD, prNumber: 3, round: 0, verdicts }, (_pool, acct, runId) => recordRunFollowUps(broken, acct, runId));
    expect(out.recorded.map((r) => `${r.role}:${r.verdict}`)).toEqual(["code-reviewer:pass", "security-reviewer:pass", "debater:pass"]);
    expect(await stageOf(workItemId)).toBe("review_passed");
    expect(await followUps(workItemId)).toEqual([]);
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines).toEqual([verdicts[0]!.runId, verdicts[1]!.runId].map((id) => JSON.stringify({ event: "follow_ups.record_failed", run_id: id })));
    expect(lines.join("\n")).not.toMatch(/secret|refused|retry/i);
  });

  it("a writer that throws past its own catch is still outside the verdict writes: everything was recorded before it ran", async () => {
    const { accountId, workItemId, registry } = await seed();
    const verdicts = await passes(accountId, workItemId);
    await expect(recordVerdictsInOrder(db.runWriterPool, registry, { accountId, workItemId, headSha: HEAD, prNumber: 3, round: 0, verdicts }, async () => { throw new Error("x"); })).rejects.toThrow();
    expect(await stageOf(workItemId)).toBe("review_passed");
    const ev = await db.admin.query("SELECT count(*)::int AS n FROM work_item_driver_events WHERE work_item_id = $1 AND kind = 'review_verdicts'", [workItemId]);
    expect(ev.rows[0].n).toBe(1);
  });
});
