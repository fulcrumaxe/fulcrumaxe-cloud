import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { setPendingHooks } from "@fx/core/src/pendingWork.js";
import { isAdmitDenyReason, type ExecutionRun } from "../src/executionTarget.js";
import {
  RUNNER_QUEUE_TTL_MS,
  RUNNER_WAITING_NOTICE_MS,
  RUNNER_TARGET_ROLES,
  RunnerTarget,
  unwiredRunnerLimits,
  type RepoVisibility,
} from "../src/targets/runnerTarget.js";
import { seedAccount, seedRepo } from "./helpers/seed.js";
import { createFakeJobIssuer, createFakeRunnerLimits, createFakeVisibility } from "./helpers/runnerTargetFakes.js";
import { pgHarness } from "./helpers/pgHarness.js";

/** D#6 R3a: what `RunnerTarget.admit` decides, and what `dispatch`, `resume`, `cancel` and `finalize` do and do not do. */
/** The daily figure these tests inject. Invented, small, and not a plan figure. */
const PER_DAY = 5;

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
    return { target: new RunnerTarget({ limits: createFakeRunnerLimits(PER_DAY), pool, issuer, visibility: port }), issuer, port };
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

  describe("admit: the backend (D#221 R1b)", () => {
    it("the job carries no backend, so only the default (or none) is admitted; any other name is refused before anything is asked or issued", async () => {
      const w = await world();
      const base = await insertRun(w);
      for (const backend of [undefined, "claude-code"]) {
        expect(await target(db.runWriterPool).target.admit({ ...base, backend }, db.admin), String(backend)).toEqual({ admitted: true });
      }
      for (const backend of ["codex", "opencode", "", "Claude-Code", "__proto__"]) {
        const t = target(db.runWriterPool);
        const run = { ...base, backend };
        expect(await t.target.admit(run, db.admin), backend).toEqual({ admitted: false, reason: "backend_not_selectable" });
        expect(t.port.calls).toHaveLength(0);
        await expect(t.target.dispatch(run), backend).rejects.toThrow(/backend is not selectable/);
        await expect(t.target.resume(run, "sess-1"), backend).rejects.toThrow(/backend is not selectable/);
        expect(t.issuer.calls).toHaveLength(0);
      }
    });
  });

  describe("admit: the day's run cap", () => {
    it("the last run the plan allows in a UTC day is admitted and the next is refused as runner_daily_limit", async () => {
      const w = await world();
      for (let i = 0; i < PER_DAY - 1; i++) await insertRun(w);
      const last = await insertRun(w);
      const t = target(db.runWriterPool);
      expect(await t.target.admit(last, db.admin)).toEqual({ admitted: true });

      const over = await insertRun(w);
      expect(await t.target.admit(over, db.admin)).toEqual({ admitted: false, reason: "runner_daily_limit" });
    });

    it("the limit is whatever the injected port says, read on every admit (the plan data, not a constant here)", async () => {
      const w = await world();
      await insertRun(w);
      const second = await insertRun(w);
      const tight = new RunnerTarget({ limits: createFakeRunnerLimits(1), pool: db.runWriterPool, issuer: createFakeJobIssuer(), visibility: createFakeVisibility() });
      expect(await tight.admit(second, db.admin)).toEqual({ admitted: false, reason: "runner_daily_limit" });
      const loose = new RunnerTarget({ limits: createFakeRunnerLimits(2), pool: db.runWriterPool, issuer: createFakeJobIssuer(), visibility: createFakeVisibility() });
      expect(await loose.admit(second, db.admin)).toEqual({ admitted: true });
    });

    it("plan data that cannot be read refuses (fails closed) and asks the repo nothing", async () => {
      const w = await world();
      const run = await insertRun(w);
      const visibility = createFakeVisibility();
      const dark = new RunnerTarget({ limits: unwiredRunnerLimits, pool: db.runWriterPool, issuer: createFakeJobIssuer(), visibility });
      expect(await dark.admit(run, db.admin)).toEqual({ admitted: false, reason: "runner_daily_limit" });
      expect(visibility.calls).toHaveLength(0);
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
      for (let i = 0; i < PER_DAY; i++) await insertRun(w);
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
      const t = new RunnerTarget({ limits: createFakeRunnerLimits(),
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

    it("resume passes the branch a follow-up of a fix round must stay on (C22 section 2), and only when the run names one", async () => {
      const w = await world();
      const parentRunId = randomUUID();
      const run = { ...(await insertRun(w, { role: "executor" })), parentRunId, continuesBranch: "fx/issue-12" };
      const t = target(db.runWriterPool);
      await t.target.resume(run, "session-1");
      expect(t.issuer.calls).toEqual([{ run, continues: { parentRunId, sessionId: "session-1", branch: "fx/issue-12" } }]);
    });

    describe("tells the runner sweeper when the queue time ends (D#6 R2b, the cron's no-database marker)", () => {
      const marks = new Map<string, number>();
      /** The marker write is fire and forget, with a read before it: give it a moment. */
      const settle = () => new Promise((resolve) => setTimeout(resolve, 25));
      beforeEach(() => {
        marks.clear();
        setPendingHooks({ store: { get: async (k) => marks.get(k), set: async (k, v) => void marks.set(k, v), delete: async (k) => void marks.delete(k) } });
      });
      afterEach(() => setPendingHooks(null));

      it("dispatch and resume each mark the sweep due at the 15 minute notice (the earliest thing due), once the job is recorded", async () => {
        const w = await world();
        const t = target(db.runWriterPool);
        const before = Date.now();
        await t.target.dispatch(await insertRun(w));
        await settle();
        const first = marks.get("pending:runner-sweeper");
        expect(first).toBeGreaterThanOrEqual(before + RUNNER_WAITING_NOTICE_MS);
        expect(first).toBeLessThanOrEqual(Date.now() + RUNNER_WAITING_NOTICE_MS);
        marks.clear();
        await t.target.resume(await insertRun(w, { role: "executor" }), "session-1");
        await settle();
        expect(marks.get("pending:runner-sweeper")).toBeGreaterThanOrEqual(before + RUNNER_WAITING_NOTICE_MS);
      });

      it("a dispatch whose job could not be issued marks nothing", async () => {
        const w = await world();
        const t = new RunnerTarget({ limits: createFakeRunnerLimits(), pool: db.runWriterPool, issuer: { issue: async () => Promise.reject(new Error("no key")) }, visibility: createFakeVisibility("private") });
        await expect(t.dispatch(await insertRun(w))).rejects.toThrow("no key");
        await settle();
        expect(marks.size).toBe(0);
      });

      it("a store that fails never fails the dispatch", async () => {
        setPendingHooks({ store: { get: async () => { throw new Error("store down"); }, set: async () => { throw new Error("store down"); }, delete: async () => undefined } });
        const w = await world();
        expect(await target(db.runWriterPool).target.dispatch(await insertRun(w))).toEqual({ queued: true });
      });
    });

    it("an issuer that fails makes dispatch fail: nothing is reported queued without a job behind it", async () => {
      const w = await world();
      const run = await insertRun(w);
      const t = new RunnerTarget({ limits: createFakeRunnerLimits(),
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
      const plain = new RunnerTarget({ limits: createFakeRunnerLimits(), pool, issuer: createFakeJobIssuer(), visibility: createFakeVisibility() });
      expect(plain.queueTtlMs).toBe(259_200_000);
      const hostile = new RunnerTarget({ limits: createFakeRunnerLimits(), pool, issuer: createFakeJobIssuer(), visibility: createFakeVisibility(), queueTtlMs: 5, queueTtl: 5 } as never);
      expect(hostile.queueTtlMs).toBe(259_200_000);
    });
  });
});
