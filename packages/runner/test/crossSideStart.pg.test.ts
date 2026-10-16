import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import type { ExecutionRun } from "../src/executionTarget.js";
import { RunnerTarget } from "../src/targets/runnerTarget.js";
import { buildExecutionRun, type StartAgentRunInput } from "../src/startAgentRun.js";
import { RUNNER_CONTINUES_BOUND_KIND, readSandboxBoundPullRequest, recordSandboxContinuesBound } from "../src/runStatusWriter.js";
import { seedAccount, seedRepo, seedWorkItem } from "./helpers/seed.js";
import { createFakeJobIssuer, createFakeRunnerLimits, createFakeVisibility } from "./helpers/runnerTargetFakes.js";
import { pgHarness } from "./helpers/pgHarness.js";

/**
 * D#599 PL-2b-2: a round on the other side of a hand-over carries on from the pull request the first side opened. A runner round is issued as a
 * continuation with no session (the issuer binds the pull request); a sandbox round is bound to the recorded pull request in its own create
 * transaction, and the pull request lookup follows that pair instead of `fx/issue-<n>`.
 */
const RUN_BRANCH = "fx/5b0e6c1a-2f4d-4a7e-9c31-8d6f0a1b2c3d-g1";

describe("a cross-side start [pg]", () => {
  const db = pgHarness();

  async function world() {
    const accountId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedRepo(db.admin, accountId, repoId, { executionMode: "runner_local" });
    await seedWorkItem(db.admin, accountId, workItemId, repoId, { ghNumber: 12 });
    return { accountId, repoId, workItemId };
  }
  type World = Awaited<ReturnType<typeof world>>;

  const run = (w: World, over: Partial<ExecutionRun> = {}): ExecutionRun => ({
    id: randomUUID(),
    accountId: w.accountId,
    workItemId: w.workItemId,
    role: "executor",
    product: "team",
    repoId: w.repoId,
    roleCard: "card",
    prompt: "p",
    model: "m",
    capUsd: 1,
    spend: { plan: "starter", estimateComputeUsd: 0, trigger: "foreground" },
    ...over,
  });
  const target = (pool: Pool) => {
    const issuer = createFakeJobIssuer();
    return { target: new RunnerTarget({ limits: createFakeRunnerLimits(), pool, issuer, visibility: createFakeVisibility("private") }), issuer };
  };

  describe("the runner side", () => {
    it("dispatch of a start that continues the item's pull request issues a continuation with no session and the number", async () => {
      const w = await world();
      const parentRunId = randomUUID();
      const r = run(w, { parentRunId, continuesBranch: "fx/issue-12", continuesPrNumber: 41, continuesFresh: true });
      const t = target(db.runWriterPool);
      expect(await t.target.dispatch(r)).toEqual({ queued: true });
      expect(t.issuer.calls).toEqual([{ run: r, continues: { parentRunId, sessionId: null, branch: "fx/issue-12", prNumber: 41 } }]);
    });

    it("a run branch continuation carries no number", async () => {
      const w = await world();
      const parentRunId = randomUUID();
      const r = run(w, { parentRunId, continuesBranch: RUN_BRANCH, continuesFresh: true });
      const t = target(db.runWriterPool);
      await t.target.dispatch(r);
      expect(t.issuer.calls).toEqual([{ run: r, continues: { parentRunId, sessionId: null, branch: RUN_BRANCH } }]);
    });

    it("a plain dispatch is unchanged, and a follow-up resume with no session passes the branch and the number on", async () => {
      const w = await world();
      const plain = run(w);
      const t = target(db.runWriterPool);
      await t.target.dispatch(plain);
      expect(t.issuer.calls).toEqual([{ run: plain }]);
      const parentRunId = randomUUID();
      const followUp = run(w, { parentRunId, continuesBranch: "fx/issue-12", continuesPrNumber: 41 });
      await t.target.resume(followUp, null);
      expect(t.issuer.calls[1]).toEqual({ run: followUp, continues: { parentRunId, sessionId: null, branch: "fx/issue-12", prNumber: 41 } });
    });

    it("the start input's continues becomes the run's continuation fields, and without it nothing is set", () => {
      const base = { accountId: randomUUID(), repoId: randomUUID(), role: "executor", product: "team", roleCard: "c", prompt: "p", model: "m", capUsd: 1, spend: { plan: "starter", estimateComputeUsd: 0, trigger: "foreground" } } as unknown as StartAgentRunInput;
      const withPr = buildExecutionRun(randomUUID(), { ...base, continues: { branch: "fx/issue-12", prNumber: 41 } });
      expect(withPr).toMatchObject({ continuesBranch: "fx/issue-12", continuesPrNumber: 41, continuesFresh: true });
      const runBranch = buildExecutionRun(randomUUID(), { ...base, continues: { branch: RUN_BRANCH } });
      expect(runBranch).toMatchObject({ continuesBranch: RUN_BRANCH, continuesFresh: true });
      expect("continuesPrNumber" in runBranch).toBe(false);
      const none = buildExecutionRun(randomUUID(), base);
      expect(none.continuesBranch).toBeUndefined();
      expect(none.continuesFresh).toBeUndefined();
    });
  });

  describe("the sandbox side: the binding record and the pull request it names", () => {
    async function sandboxRun(w: World, o: { runtime?: string; createdAt: string; mode?: string }): Promise<string> {
      const id = randomUUID();
      await db.admin.query(
        `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, created_at) VALUES ($1, $2, $3, 'executor', $4, 'succeeded', $5, $6::timestamptz)`,
        [id, w.accountId, w.workItemId, o.runtime ?? "production", o.mode ?? (o.runtime === "runner" ? "runner_local" : "sandbox"), o.createdAt],
      );
      return id;
    }
    const record = (w: World, runId: string, prNumber: number, branch: string) =>
      withTenant(db.runWriterPool, w.accountId, (client: PoolClient) => recordSandboxContinuesBound(client, { accountId: w.accountId, runId, prNumber, branch }));
    const read = (w: World) => withTenant(db.runWriterPool, w.accountId, (client: PoolClient) => readSandboxBoundPullRequest(client, { accountId: w.accountId, workItemId: w.workItemId }));

    it("records the pair on the sandbox run, and the read answers it", async () => {
      const w = await world();
      const id = await sandboxRun(w, { createdAt: "2026-10-15T10:00:00Z" });
      await record(w, id, 41, RUN_BRANCH);
      expect(await read(w)).toEqual({ number: 41, branch: RUN_BRANCH });
      const ev = await db.admin.query("SELECT payload FROM run_events WHERE run_id = $1 AND kind = $2", [id, RUNNER_CONTINUES_BOUND_KIND]);
      expect(ev.rows.map((r) => r.payload)).toEqual([{ pr_number: 41, branch: RUN_BRANCH, side: "sandbox" }]);
    });

    it("answers the newest bound sandbox run, and a later plain sandbox round (a resume) leaves it standing", async () => {
      const w = await world();
      const first = await sandboxRun(w, { createdAt: "2026-10-15T10:00:00Z" });
      await record(w, first, 41, RUN_BRANCH);
      await sandboxRun(w, { createdAt: "2026-10-15T11:00:00Z" });
      expect(await read(w)).toEqual({ number: 41, branch: RUN_BRANCH });
    });

    it("answers null once a runner executor run is newer: the runner's own record decides then", async () => {
      const w = await world();
      const first = await sandboxRun(w, { createdAt: "2026-10-15T10:00:00Z" });
      await record(w, first, 41, RUN_BRANCH);
      await sandboxRun(w, { createdAt: "2026-10-15T11:00:00Z", runtime: "runner" });
      expect(await read(w)).toBeNull();
    });

    it("answers null for an item with no bound round, and for a binding written on a runner run", async () => {
      const w = await world();
      expect(await read(w)).toBeNull();
      const runner = await sandboxRun(w, { createdAt: "2026-10-15T10:00:00Z", runtime: "runner" });
      await record(w, runner, 41, RUN_BRANCH);
      expect(await read(w)).toBeNull();
    });

    it("refuses to record a number or a branch that is not the shared shapes", async () => {
      const w = await world();
      const id = await sandboxRun(w, { createdAt: "2026-10-15T10:00:00Z" });
      for (const [n, b] of [[0, "fx/issue-12"], [-1, "fx/issue-12"], [1.5, "fx/issue-12"], [41, "main"], [41, "fx/issue-07"], [41, "fx/docs/x"]] as const) {
        await expect(record(w, id, n, b), `${n} ${b}`).rejects.toThrow(TypeError);
      }
      expect(await read(w)).toBeNull();
    });
  });
});
