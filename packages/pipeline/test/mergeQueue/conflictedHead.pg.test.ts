import type { PoolClient } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { endRound, finishWork, recordRoundHead, runQueueTick, startConflictWork, type QueueTickDeps } from "../../src/mergeQueue/index.js";
import { pgHarness } from "../helpers/pgHarness.js";
import { shaOf, startQueueRepo, type QueueItem, type QueueRepo } from "./helpers/queueRepo.js";

/**
 * D#483: a head that a conflict round produced and that conflicted again was never reviewed. If the entry waits on it and the conflict then clears, the tick must not refresh it
 * or number it from there (a refresh row would carry across the unread head); it goes back to review unless a reviewer already passed that very head. Real Postgres, strict
 * GitHub fake over TLS.
 */
const DIR = "packages/db/migrations";
const mig = (...keys: number[]) => keys.map((k) => `${DIR}/${String(k).padStart(4, "0")}_m.sql`);
const added = (...paths: string[]) => paths.map((filename) => ({ filename, status: "added" }));
const ROUND_FROM = "a".repeat(40);

let repos: QueueRepo[] = [];
afterEach(async () => {
  await Promise.all(repos.map((r) => r.close()));
  repos = [];
});

describe("D#483 an entry waiting on a head that conflicted again [pg]", () => {
  const db = pgHarness();
  const tenant = <T>(r: QueueRepo, fn: (c: PoolClient) => Promise<T>) => withTenant(db.pureAppUserPool, r.accountId, fn);
  let deltaStarts = 0;
  let renumbers = 0;
  const start = async () => {
    deltaStarts = 0;
    renumbers = 0;
    const r = await startQueueRepo(db, { onDeltaReview: async () => (deltaStarts++, { started: false as const, reason: "worker_unavailable" as const }) });
    repos.push(r);
    return r;
  };
  /** The entry's stored head is the result of a round 1 that ended `conflicted_again`; `passed` keeps the reviewer passes the test world records on the head. */
  const conflictedAgain = async (r: QueueRepo, a: QueueItem, passed = false) => {
    if (!passed) await db.admin.query("DELETE FROM agent_runs WHERE account_id = $1 AND work_item_id = $2", [r.accountId, a.workItemId]);
    await tenant(r, async (c) => {
      const s = await startConflictWork(c, { accountId: r.accountId, entryId: a.entryId, fromSha: ROUND_FROM, baseSha: shaOf(a.pr, "tip"), baseRef: "main", conflictFiles: ["src/a.ts"] });
      if (!s.ok) throw new Error(s.reason);
      await recordRoundHead(c, { accountId: r.accountId, roundId: s.round.id, toSha: a.head });
      await endRound(c, { accountId: r.accountId, roundId: s.round.id, outcome: "conflicted_again" });
      await finishWork(c, { accountId: r.accountId, entryId: a.entryId, headSha: a.head });
    });
  };
  const rounds = async (r: QueueRepo) => Number((await db.admin.query("SELECT count(*)::int AS n FROM merge_conflict_rounds WHERE account_id = $1", [r.accountId])).rows[0].n);
  const withRenumber = (r: QueueRepo, over: Partial<QueueTickDeps> = {}) => r.deps({ ordered: true, onRenumber: async () => (renumbers++, true), ...over });

  it("behind the default branch with overlapping files: back to review, no refresh, no delta review, no merge", async () => {
    const r = await start();
    const a = await r.addItem(7, { world: { behindBy: 1, files: [{ filename: "src/a.ts" }], mainFiles: [{ filename: "src/a.ts" }] } });
    await conflictedAgain(r, a);
    const out = await runQueueTick(r.deps(), r);
    expect(out.steps[0]).toMatchObject({ step: "released", why: "head_unreviewed" });
    expect(await r.entry(7)).toMatchObject({ state: "in_review", slotHolder: null, headSha: a.head });
    expect(a.g.world.updates).toEqual([]);
    expect(a.g.world.merges).toEqual([]);
    expect(deltaStarts).toBe(0);
    expect(await db.admin.query("SELECT 1 FROM head_refreshes WHERE account_id = $1", [r.accountId]).then((q) => q.rowCount)).toBe(0);
  });

  it("disjoint files and an ordered-resource failure: back to review, no renumber round", async () => {
    const r = await start();
    const a = await r.addItem(7, { world: { behindBy: 1, pullFiles: added(...mig(710)) } });
    r.setTip(7, shaOf(7, "tip"), mig(709, 711, 712));
    // The refresh is a clean merge of the head and the tip: its tree is the tip's.
    a.g.world.trees[a.fresh] = a.g.world.trees[shaOf(7, "tip")]!;
    await conflictedAgain(r, a);
    const before = await rounds(r);
    const out = await runQueueTick(withRenumber(r), r);
    expect(out.steps[0]).toMatchObject({ step: "released", why: "head_unreviewed" });
    expect(await r.entry(7)).toMatchObject({ state: "in_review" });
    expect([renumbers, await rounds(r) - before, a.g.world.updates.length, a.g.world.merges.length]).toEqual([0, 0, 0, 0]);
  });

  it("a head that a full review later passed is legitimately queued with that same round row: it proceeds as before", async () => {
    const r = await start();
    const a = await r.addItem(7);
    await conflictedAgain(r, a, true);
    expect((await runQueueTick(r.deps(), r)).steps.map((s) => s.step)).toEqual(["merged", "idle"]);
    expect(a.g.world.merges).toEqual([{ sha: a.head, method: "squash" }]);
    // The same with an ordered-resource failure: the pass lets the normal path (here a renumber round) take it.
    const r2 = await start();
    const b = await r2.addItem(7, { world: { pullFiles: added(...mig(710)) } });
    r2.setTip(7, shaOf(7, "tip"), mig(709, 711, 712));
    await conflictedAgain(r2, b, true);
    expect((await runQueueTick(withRenumber(r2), r2)).steps[0]).toMatchObject({ why: "ordered_resource_renumbering" });
    expect(renumbers).toBe(1);
  });

  it("the evidence read fails: back to review, nothing is refreshed", async () => {
    const r = await start();
    const a = await r.addItem(7, { world: { behindBy: 1, files: [{ filename: "src/a.ts" }], mainFiles: [{ filename: "src/a.ts" }] } });
    await conflictedAgain(r, a, true);
    const base = r.deps();
    const failing: QueueTickDeps = {
      ...base,
      inTenant: (id, fn) =>
        base.inTenant(id, (c) =>
          fn(
            new Proxy(c, {
              get: (t, p) => (p === "query" ? (sql: unknown, ...rest: unknown[]) => (/FROM agent_runs/.test(String(sql)) ? Promise.reject(new Error("evidence read failed")) : (t.query as (...a: unknown[]) => unknown)(sql, ...rest)) : Reflect.get(t, p)),
            }),
          ),
        ),
    };
    const out = await runQueueTick(failing, r);
    expect(out.steps[0]).toMatchObject({ step: "released", why: "head_unreviewed" });
    expect(await r.entry(7)).toMatchObject({ state: "in_review" });
    expect([a.g.world.updates.length, a.g.world.merges.length, deltaStarts]).toEqual([0, 0, 0]);
  });

  // D#483 S5-j2f: the same rule the gate uses (every role it requires, on the head), not "some role passed".
  it("a head that only some of the required roles passed is still unread: back to review", async () => {
    const r = await start();
    const a = await r.addItem(7, { world: { behindBy: 1, files: [{ filename: "src/a.ts" }], mainFiles: [{ filename: "src/a.ts" }] } });
    await conflictedAgain(r, a, true);
    await db.admin.query("DELETE FROM agent_runs WHERE account_id = $1 AND work_item_id = $2 AND role = 'acceptance-tester'", [r.accountId, a.workItemId]);
    const out = await runQueueTick(r.deps(), r);
    expect(out.steps[0]).toMatchObject({ step: "released", why: "head_unreviewed" });
    expect(await r.entry(7)).toMatchObject({ state: "in_review" });
    expect([a.g.world.updates.length, a.g.world.merges.length, deltaStarts]).toEqual([0, 0, 0]);
  });

  it("the roles come from the plan port, asked about this entry and head; a plan that cannot be read means unread", async () => {
    const r = await start();
    const a = await r.addItem(7);
    await conflictedAgain(r, a, true);
    const asked: Array<{ id: string; head: string }> = [];
    // Only the code reviewer is required here, and it passed: the head is read.
    const one = await runQueueTick(r.deps({ reviewPlan: async ({ entry, headSha }) => (asked.push({ id: entry.id, head: headSha }), { ok: true as const, roles: ["code-reviewer"] }) }), r);
    expect(one.steps.map((s) => s.step)).toEqual(["merged", "idle"]);
    expect(asked).toEqual([{ id: a.entryId, head: a.head }]);
    const r2 = await start();
    const b = await r2.addItem(7);
    await conflictedAgain(r2, b, true);
    const two = await runQueueTick(r2.deps({ reviewPlan: async () => ({ ok: false as const, reason: "invalid_input" }) }), r2);
    expect(two.steps[0]).toMatchObject({ step: "released", why: "head_unreviewed" });
    const r3 = await start();
    const c = await r3.addItem(7);
    await conflictedAgain(r3, c, true);
    const three = await runQueueTick(r3.deps({ reviewPlan: async () => { throw new Error("plan read failed"); } }), r3);
    expect(three.steps[0]).toMatchObject({ step: "released", why: "head_unreviewed" });
    expect(c.g.world.merges).toEqual([]);
  });

  /** Runs of a runner that no owner or admin registered: the gate does not count them (`run_not_production_*` under cloud review, `runner_not_trusted_*` under local review). */
  const untrusted = async (r: QueueRepo, a: QueueItem, roles: readonly string[]) => {
    await db.admin.query("DELETE FROM agent_runs WHERE account_id = $1 AND work_item_id = $2", [r.accountId, a.workItemId]);
    for (const role of roles) {
      await db.admin.query(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, envelope, head_sha, execution_mode) VALUES ($1, $2, $3, 'runner', 'succeeded', '{"verdict":"pass"}'::jsonb, $4, 'runner_local')`, [r.accountId, a.workItemId, role, a.head]);
    }
  };
  const BEHIND = { behindBy: 1, files: [{ filename: "src/a.ts" }], mainFiles: [{ filename: "src/a.ts" }] };
  const untouched = (a: QueueItem) => [a.g.world.updates.length, a.g.world.merges.length, deltaStarts];

  // D#483 S5-j2f: reviews the gate does not count are not "unread" (reviewing again cannot change that), and they are not a pass either: no refresh may start from this head.
  it("untrusted passes on every required role, behind with overlapping files: the entry stops for a person with the gate's reason; no update, no merge", async () => {
    const r = await start();
    const a = await r.addItem(7, { world: BEHIND });
    await conflictedAgain(r, a, true);
    await untrusted(r, a, ["code-reviewer", "acceptance-tester"]);
    const out = await runQueueTick(r.deps(), r);
    expect(out.steps[0]).toMatchObject({ step: "released", why: "run_not_production_code_reviewer" });
    expect(await r.entry(7)).toMatchObject({ state: "stopped", reason: "run_not_production_code_reviewer", slotHolder: null, headSha: a.head });
    expect(untouched(a)).toEqual([0, 0, 0]);
    expect(await db.admin.query("SELECT 1 FROM head_refreshes WHERE account_id = $1", [r.accountId]).then((q) => q.rowCount)).toBe(0);
  });

  it("the review mode is the item's real one: under local review the same rows give the gate's local reason", async () => {
    const r = await start();
    const a = await r.addItem(7, { world: BEHIND });
    await conflictedAgain(r, a, true);
    await untrusted(r, a, ["code-reviewer", "acceptance-tester"]);
    const out = await runQueueTick(r.deps({ reviewJudgement: async () => ({ mode: "runner_local_on" as const, flagged: false }) }), r);
    expect(out.steps[0]).toMatchObject({ step: "released", why: "runner_not_trusted_code_reviewer" });
    expect(await r.entry(7)).toMatchObject({ state: "stopped", reason: "runner_not_trusted_code_reviewer" });
    expect(untouched(a)).toEqual([0, 0, 0]);
  });

  it("one untrusted pass and another required role with no run: unread, back to review", async () => {
    const r = await start();
    const a = await r.addItem(7, { world: BEHIND });
    await conflictedAgain(r, a, true);
    await untrusted(r, a, ["code-reviewer"]);
    const out = await runQueueTick(r.deps(), r);
    expect(out.steps[0]).toMatchObject({ step: "released", why: "head_unreviewed" });
    expect(await r.entry(7)).toMatchObject({ state: "in_review", slotHolder: null });
    expect(untouched(a)).toEqual([0, 0, 0]);
  });

  it("one untrusted pass and another required role whose counted run did not pass: unread, back to review", async () => {
    const r = await start();
    const a = await r.addItem(7, { world: BEHIND });
    await conflictedAgain(r, a, true);
    await untrusted(r, a, ["code-reviewer"]);
    await db.admin.query(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, envelope, head_sha) VALUES ($1, $2, 'acceptance-tester', 'production', 'succeeded', '{"verdict":"needs-fix"}', $3)`, [r.accountId, a.workItemId, a.head]);
    const out = await runQueueTick(r.deps(), r);
    expect(out.steps[0]).toMatchObject({ step: "released", why: "head_unreviewed" });
    expect(await r.entry(7)).toMatchObject({ state: "in_review" });
    expect(untouched(a)).toEqual([0, 0, 0]);
  });

  // The gate counts a rejection by a role it does not require as a veto, and an uncounted row of such a role as a stop. Every required role passed, so the head was read; the entry stops for a person
  // with the gate's reason (before this change a needs-fix went back to review and an uncounted row went on to the refresh).
  it("every required role passed and a role the plan does not require has a rejection, or a row the gate does not count: the entry stops for a person with the gate's reason", async () => {
    const r = await start();
    const a = await r.addItem(7, { world: BEHIND });
    await conflictedAgain(r, a, true);
    await db.admin.query(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, envelope, head_sha) VALUES ($1, $2, 'security-reviewer', 'production', 'succeeded', '{"verdict":"needs-fix"}', $3)`, [r.accountId, a.workItemId, a.head]);
    const out = await runQueueTick(r.deps(), r);
    expect(out.steps[0]).toMatchObject({ step: "released", why: "verdict_not_pass_security_reviewer" });
    expect(await r.entry(7)).toMatchObject({ state: "stopped", reason: "verdict_not_pass_security_reviewer" });
    expect(untouched(a)).toEqual([0, 0, 0]);
    const r2 = await start();
    const b = await r2.addItem(7, { world: BEHIND });
    await conflictedAgain(r2, b, true);
    await db.admin.query(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, envelope, head_sha, execution_mode) VALUES ($1, $2, 'debater', 'runner', 'succeeded', '{"verdict":"pass"}', $3, 'runner_local')`, [r2.accountId, b.workItemId, b.head]);
    const two = await runQueueTick(r2.deps(), r2);
    expect(two.steps[0]).toMatchObject({ step: "released", why: "run_not_production_debater" });
    expect(await r2.entry(7)).toMatchObject({ state: "stopped", reason: "run_not_production_debater" });
    expect(untouched(b)).toEqual([0, 0, 0]);
  });

  it("the plan port is asked with the security flag the gate reads, and the roles it then names decide: a flagged head with no security pass is unread", async () => {
    const r = await start();
    const a = await r.addItem(7, { world: BEHIND });
    await conflictedAgain(r, a, true);
    const asked: Array<boolean | undefined> = [];
    const out = await runQueueTick(
      r.deps({
        reviewJudgement: async () => ({ mode: "cloud" as const, flagged: true }),
        reviewPlan: async ({ flagged }) => (asked.push(flagged), { ok: true as const, roles: flagged === true ? ["code-reviewer", "acceptance-tester", "security-reviewer"] : ["code-reviewer", "acceptance-tester"] }),
      }),
      r,
    );
    expect(asked).toEqual([true]);
    expect(out.steps[0]).toMatchObject({ step: "released", why: "head_unreviewed" });
    expect(await r.entry(7)).toMatchObject({ state: "in_review" });
    expect(untouched(a)).toEqual([0, 0, 0]);
  });

  it("the judgement read fails: back to review", async () => {
    const r = await start();
    const a = await r.addItem(7, { world: BEHIND });
    await conflictedAgain(r, a, true);
    const out = await runQueueTick(r.deps({ reviewJudgement: async () => { throw new Error("judgement read failed"); } }), r);
    expect(out.steps[0]).toMatchObject({ step: "released", why: "head_unreviewed" });
    expect(await r.entry(7)).toMatchObject({ state: "in_review" });
    expect(untouched(a)).toEqual([0, 0, 0]);
  });

  it("the read of the conflict rounds fails: the entry goes back to review and does not keep the slot", async () => {
    const r = await start();
    const a = await r.addItem(7);
    await conflictedAgain(r, a, true);
    const base = r.deps();
    let failed = 0;
    const failing: QueueTickDeps = {
      ...base,
      inTenant: (id, fn) =>
        base.inTenant(id, (c) =>
          fn(
            new Proxy(c, {
              get: (t, p) => (p === "query" ? (sql: unknown, ...rest: unknown[]) => (failed === 0 && /FROM merge_conflict_rounds/.test(String(sql)) ? (failed++, Promise.reject(new Error("rounds read failed"))) : (t.query as (...a: unknown[]) => unknown)(sql, ...rest)) : Reflect.get(t, p)),
            }),
          ),
        ),
    };
    const out = await runQueueTick(failing, r);
    expect(failed).toBe(1);
    expect(out.steps[0]).toMatchObject({ step: "released", why: "head_unreviewed" });
    expect(await r.entry(7)).toMatchObject({ state: "in_review", slotHolder: null });
    expect([a.g.world.merges.length, deltaStarts]).toEqual([0, 0]);
  });
});
