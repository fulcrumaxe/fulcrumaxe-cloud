import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { isAdmitDenyReason, type ExecutionRun } from "../src/executionTarget.js";
import {
  RUNNER_QUEUE_TTL_MS,
  RUNNER_RUNS_PER_DAY,
  RUNNER_TARGET_ROLES,
  RunnerTarget,
  type RepoVisibility,
} from "../src/targets/runnerTarget.js";
import { seedAccount, seedRepo } from "./helpers/seed.js";
import { createFakeJobIssuer, createFakeVisibility } from "./helpers/runnerTargetFakes.js";
import { pgHarness } from "./helpers/pgHarness.js";

/** D#6 R3a: what `RunnerTarget.admit` decides, and what `dispatch`, `resume`, `cancel` and `finalize` do and do not do. */
describe("RunnerTarget [pg]", () => {
  const db = pgHarness();

  async function world(): Promise<{ accountId: string; repoId: string }> {
    const accountId = randomUUID();
    const repoId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId, { executionMode: "runner_local" });
    return { accountId, repoId };
  }

  /** Inserts a run row as a superuser (the runs the day's count reads) and returns the `ExecutionRun` for it. */
  async function insertRun(
    w: { accountId: string; repoId: string },
    over: { role?: string; runtime?: string; status?: string; createdAt?: string } = {},
  ): Promise<ExecutionRun> {
    const id = randomUUID();
    const role = over.role ?? "code-reviewer";
    await db.admin.query(
      `INSERT INTO agent_runs (id, account_id, role, runtime, status, created_at) VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()))`,
      [id, w.accountId, role, over.runtime ?? "runner", over.status ?? "pending", over.createdAt ?? null],
    );
    return {
      id,
      accountId: w.accountId,
      role,
      product: "team",
      repoId: w.repoId,
      roleCard: "card",
      prompt: "prompt",
      model: "haiku-4.5",
      capUsd: 5,
      spend: { plan: "starter", estimateComputeUsd: 1, trigger: "foreground" },
    };
  }

  function target(pool: Pool, visibility: RepoVisibility | "throw" = "private") {
    const issuer = createFakeJobIssuer();
    const port = createFakeVisibility(visibility);
    return { target: new RunnerTarget({ pool, issuer, visibility: port }), issuer, port };
  }

  describe("admit: the role", () => {
    it.each(["executor", "docs-writer", "project-manager", "technical-architect", "code-reviewer", "security-reviewer", "acceptance-tester", "debater"])(
      "%s is a role a runner may run (the four reviewers by the owner ruling, C12 section 1)",
      async (role) => {
        const w = await world();
        const run = await insertRun(w, { role });
        expect(await target(db.runWriterPool).target.admit(run, db.admin)).toEqual({ admitted: true });
      },
    );

    it.each(["researcher", "browser-tester", "feedback-scanner", "incident-commander"])("%s is refused as role_not_runner_eligible, before the repo is asked about", async (role) => {
      const w = await world();
      const run = await insertRun(w, { role });
      const t = target(db.runWriterPool);
      expect(await t.target.admit(run, db.admin)).toEqual({ admitted: false, reason: "role_not_runner_eligible" });
      expect(t.port.calls).toHaveLength(0);
    });

    it("the eligible set is the runner-protocol list plus the four reviewers, nothing else", () => {
      expect([...RUNNER_TARGET_ROLES].sort()).toEqual(
        [
          "executor", "project-manager", "technical-architect", "product-owner", "cost-analyst", "performance-expert",
          "security-expert", "docs-writer", "accessibility-reviewer",
          "code-reviewer", "security-reviewer", "acceptance-tester", "debater",
        ].sort(),
      );
    });
  });

  describe("admit: the day's run cap", () => {
    it("the 30th run of a UTC day is admitted and the 31st is refused as runner_daily_limit", async () => {
      const w = await world();
      for (let i = 0; i < RUNNER_RUNS_PER_DAY - 1; i++) await insertRun(w);
      const thirtieth = await insertRun(w);
      const t = target(db.runWriterPool);
      expect(await t.target.admit(thirtieth, db.admin)).toEqual({ admitted: true });

      const thirtyFirst = await insertRun(w);
      expect(await t.target.admit(thirtyFirst, db.admin)).toEqual({ admitted: false, reason: "runner_daily_limit" });
    });

    it("the limit is 30 (provisional, D#6 R2b criterion 12)", () => {
      expect(RUNNER_RUNS_PER_DAY).toBe(30);
    });

    it("runs another account made, runs of another runtime, runs from before today and runs admit already refused do not count", async () => {
      const w = await world();
      const other = await world();
      for (let i = 0; i < 40; i++) await insertRun(other);
      for (let i = 0; i < 40; i++) await insertRun(w, { runtime: "production" });
      for (let i = 0; i < 40; i++) await insertRun(w, { createdAt: new Date(Date.now() - 48 * 3600_000).toISOString() });
      for (let i = 0; i < 40; i++) await insertRun(w, { status: "refused_spend" });
      const run = await insertRun(w);
      expect(await target(db.runWriterPool).target.admit(run, db.admin)).toEqual({ admitted: true });
    });

    it("an over-limit run is refused before the repo is asked about", async () => {
      const w = await world();
      for (let i = 0; i < RUNNER_RUNS_PER_DAY; i++) await insertRun(w);
      const run = await insertRun(w);
      const t = target(db.runWriterPool);
      expect((await t.target.admit(run, db.admin)).admitted).toBe(false);
      expect(t.port.calls).toHaveLength(0);
    });
  });

  describe("admit: the repo's visibility (fails closed)", () => {
    it("a public repo is refused as public_repo", async () => {
      const w = await world();
      const run = await insertRun(w);
      expect(await target(db.runWriterPool, "public").target.admit(run, db.admin)).toEqual({ admitted: false, reason: "public_repo" });
    });

    it.each<RepoVisibility | "throw">(["unknown", "throw"])("a repo whose visibility the port answers %s is refused as repo_visibility_unknown", async (answer) => {
      const w = await world();
      const run = await insertRun(w);
      expect(await target(db.runWriterPool, answer).target.admit(run, db.admin)).toEqual({ admitted: false, reason: "repo_visibility_unknown" });
    });

    it("a port that answers something outside its type is not read as private", async () => {
      const w = await world();
      const run = await insertRun(w);
      const t = new RunnerTarget({
        pool: db.runWriterPool,
        issuer: createFakeJobIssuer(),
        visibility: { visibility: async () => "Private" as never },
      });
      expect(await t.admit(run, db.admin)).toEqual({ admitted: false, reason: "repo_visibility_unknown" });
    });

    it("a run with no repo is refused, and the port is asked about the run's own account and repo", async () => {
      const w = await world();
      const run = await insertRun(w);
      const t = target(db.runWriterPool);
      expect((await t.target.admit({ ...run, repoId: undefined }, db.admin)).admitted).toBe(false);
      await t.target.admit(run, db.admin);
      expect(t.port.calls).toEqual([{ accountId: w.accountId, repoId: w.repoId }]);
    });

    it("every reason admit can give is a member of the closed AdmitDenyReason set", () => {
      for (const reason of ["runner_daily_limit", "public_repo", "repo_visibility_unknown", "role_not_runner_eligible"]) {
        expect(isAdmitDenyReason(reason), reason).toBe(true);
      }
    });
  });

  describe("dispatch, resume, cancel and finalize", () => {
    it("dispatch hands the run to the issuer once and answers { queued: true }", async () => {
      const w = await world();
      const run = await insertRun(w);
      const t = target(db.runWriterPool);
      expect(await t.target.dispatch(run)).toEqual({ queued: true });
      expect(t.issuer.calls).toEqual([{ run }]);
    });

    it("resume dispatches with continues (the run it continues and its session) and answers { queued: true }", async () => {
      const w = await world();
      const parentRunId = randomUUID();
      const run = { ...(await insertRun(w, { role: "executor" })), parentRunId };
      const t = target(db.runWriterPool);
      expect(await t.target.resume(run, "session-1")).toEqual({ queued: true });
      expect(t.issuer.calls).toEqual([{ run, continues: { parentRunId, sessionId: "session-1" } }]);
    });

    it("an issuer that fails makes dispatch fail: nothing is reported queued without a job behind it", async () => {
      const w = await world();
      const run = await insertRun(w);
      const t = new RunnerTarget({
        pool: db.runWriterPool,
        issuer: { issue: async () => Promise.reject(new Error("no key")) },
        visibility: createFakeVisibility("private"),
      });
      await expect(t.dispatch(run)).rejects.toThrow("no key");
    });

    it("cancel and finalize answer zeros and never touch the database (the pool they were built with is unusable)", async () => {
      const w = await world();
      const run = await insertRun(w);
      const unusable = new Proxy({}, { get: () => () => Promise.reject(new Error("the pool must not be used")) }) as unknown as Pool;
      const t = target(unusable);
      expect(await t.target.cancel(run)).toEqual({ settled_usd: 0, released_usd: 0 });
      expect(await t.target.cancel(run)).toEqual({ settled_usd: 0, released_usd: 0 });
      expect(await t.target.finalize(run, { status: "succeeded", usd: 12.5, tokensIn: 5, tokensOut: 6 })).toEqual({ settled_usd: 0, released_usd: 0 });
    });

    it("the queue TTL is 72 hours, a constant of the class that no dependency can change", async () => {
      expect(RUNNER_QUEUE_TTL_MS).toBe(259_200_000);
      const pool = db.runWriterPool;
      const plain = new RunnerTarget({ pool, issuer: createFakeJobIssuer(), visibility: createFakeVisibility() });
      expect(plain.queueTtlMs).toBe(259_200_000);
      const hostile = new RunnerTarget({ pool, issuer: createFakeJobIssuer(), visibility: createFakeVisibility(), queueTtlMs: 5, queueTtl: 5 } as never);
      expect(hostile.queueTtlMs).toBe(259_200_000);
    });
  });
});
