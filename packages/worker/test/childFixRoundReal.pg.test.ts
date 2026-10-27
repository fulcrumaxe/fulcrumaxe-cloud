import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { insertAgentRun, writeRunStatus, type CancelResult, type ExecutionRun, type ExecutionTargetRegistry, type StartAgentRunInput } from "@fx/runner";
import { createPool } from "@fx/db/src/pool.js";
import { plannedFixture, type PlannedFixture } from "@fx/db/test/helpers/plannedChildren.js";
import { debaterEnabledFor, findPullRequestForItem, loadReviewContext, type GitHubHttp } from "@fx/pipeline";
import { createAdvanceModule, type AdvanceModuleDeps, type AdvanceReviewDeps } from "../src/advance.js";
import type { FixRoundHeadPorts } from "../src/fixRoundHeads.js";
import type { RunStarter } from "../src/preview.js";
import type { SeatResult } from "../src/seat.js";

/**
 * [pg] D#483 S5-b2c-3, acceptance 5, through the REAL review-fix path: the pipeline's `loadReviewContext` (the identity), the worker's `advanceLoadReview`, the pipeline's
 * pull request lookup on the branch the context names, the web step `startFixBody` (which builds the prompt: nothing here types one), and the worker's `advanceStartFix`.
 * What is asserted is what was STORED: the run's start prompt, its pinned Spec version, the branch every GitHub read named. The GitHub reads are a strict stand-in that answers
 * only the child's own branch. The resume is the pipeline's as a stand-in that writes the keyed run row with the prompt it was given and the pin it inherits.
 */
describe("a planned PR child's review fix round, through loadReviewContext and startFixBody [pg]", { timeout: 90_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
  let startFixBody: (worker: unknown, who: unknown, ctx: unknown, pr: unknown, actionId: string, round: number, failing: ReadonlyArray<{ role: string; runId: string }>) => Promise<{ ok: boolean; runId: string | null; reason: string | null }>;
  let reviewLoadBody: (worker: unknown, who: unknown, pinned: number | null) => Promise<Record<string, unknown> & { ok: boolean }>;
  beforeAll(async () => {
    const lib = (file: string) => fileURLToPath(new URL(`../../../apps/web/lib/${file}`, import.meta.url));
    const steps = (await import(/* @vite-ignore */ lib("advanceReviewSteps.ts"))) as { startFixBody: typeof startFixBody; reviewLoadBody: typeof reviewLoadBody };
    ({ startFixBody, reviewLoadBody } = steps);
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool, appPool]) await p.end();
  });

  const SEAT: SeatResult = {
    ok: true,
    seat: {
      repoId: "unused", product: "team", roleCard: "card", model: "haiku-4.5", capUsd: 5,
      spend: { plan: "starter", purpose: "run", trigger: "foreground", estimateModelUsd: 5, estimateComputeUsd: 0.5, monthlyModelBudgetUsd: 1000, perSpawnCapUsd: 5 },
      limits: { maxRunMs: 30 * 60_000, maxTurns: 100, maxModelCalls: 300, meteringSilenceMs: 15 * 60_000 }, timeoutMs: 40 * 60_000, maxExtensions: 3,
    } as never,
  };
  const ASKED = "a".repeat(40);
  const BASE = "f".repeat(40);
  const PR = 9;
  const PARENT_NUMBER = 41;
  const registry = { sandbox: { cancel: async (_run: ExecutionRun): Promise<CancelResult> => ({ settled_usd: 0, released_usd: 0 }) } } as unknown as ExecutionTargetRegistry;

  /** Every branch GitHub was asked about, from the lookup, the head read and the base sync. */
  const asked: string[] = [];
  const heads: FixRoundHeadPorts = {
    publicHead: async () => "d".repeat(40),
    privateHead: async ({ branch }) => (asked.push(`head ${branch}`), branch === "fx/41-api" ? ASKED : (() => { throw new Error(`unexpected read of ${branch}`); })()),
    syncBase: async ({ branch, prNumber }) => {
      asked.push(`sync ${branch}#${prNumber}`);
      if (branch !== "fx/41-api" || prNumber !== PR) throw new Error(`unexpected sync of ${branch}`);
      return { kind: "up_to_date", baseSha: BASE, baseRef: "main", stacked: false };
    },
  };
  /** The pulls list as GitHub answers it, for the child's own branch only; any other request fails the test. */
  const http = {
    request: async (req: { method: string; path: string; query?: Record<string, string | number> }) => {
      const head = (req.query as { head?: string } | undefined)?.head ?? "";
      asked.push(`list ${head}`);
      if (req.method !== "GET" || !req.path.endsWith("/pulls") || head !== "acme:fx/41-api") throw new Error(`unexpected request ${req.method} ${req.path} ${head}`);
      return { status: 200, body: [{ number: PR, state: "open", head: { sha: ASKED, ref: "fx/41-api", repo: { full_name: "acme/widgets" } }, base: { ref: "main", sha: BASE, repo: { full_name: "acme/widgets" } } }] };
    },
  } as unknown as GitHubHttp;

  function harness() {
    const resumed: StartAgentRunInput[] = [];
    const resume = vi.fn(async (_pool: Pool, _registry: ExecutionTargetRegistry, input: StartAgentRunInput) => {
      resumed.push(input);
      const { id } = await insertAgentRun(writerPool, {
        id: randomUUID(), accountId: input.accountId, workItemId: input.workItemId, parentRunId: input.parentRunId, specParentRunId: input.parentRunId ?? null, role: "executor", runtime: "production",
        executionMode: "sandbox", dispatchRepoId: input.repoId, dispatchPrNumber: input.pr ?? null, idempotency: input.idempotency, startPrompt: input.prompt, inCreateTransaction: input.inCreateTransaction,
      });
      await writeRunStatus(writerPool, { accountId: input.accountId, runId: id, from: "pending", to: "running" });
      return { id, status: "running" };
    });
    // The worker's review load is the product's: the pipeline's loader, mapped as apps/web/lib/advanceReview.ts maps it.
    const review: AdvanceReviewDeps = {
      load: async (pool: Pool, accountId: string, workItemId: string) => {
        const r = await loadReviewContext(pool, accountId, workItemId);
        if (!r.ok) return { ok: false, reason: r.reason };
        const c = r.ctx;
        return { ok: true, ctx: { workItemId: c.workItemId, stage: c.stage, repoId: c.repoId, owner: c.owner, name: c.name, issue: c.issue, branch: c.branch, ...(c.child ? { child: true as const } : {}), tier: c.tier, specVersion: c.specVersion, fixRoundsStarted: c.fixRoundsStarted, debaterEnabled: debaterEnabledFor(c.debaterMode, c.tier), personRequestPending: c.personRequestPending, executionMode: c.executionMode } } as never;
      },
      recordRound: vi.fn(), resume, mergeGate: vi.fn(),
    } as never;
    const starter: RunStarter = { async start() { throw new Error("a same-side round never starts a fresh session"); } };
    const deps: AdvanceModuleDeps = { starter, resolveRunSeat: vi.fn(async () => SEAT), startAdvance: async () => undefined, triage: null, registry, review, fixHeads: heads };
    return { module: createAdvanceModule(writerPool, deps), resumed };
  }

  async function child(o: { binding?: boolean } = {}): Promise<{ f: PlannedFixture; id: string; build: string; reviewer: string }> {
    const f = await plannedFixture(admin, appPool, { dial: null, weeklyUsd: null });
    await admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets', execution_mode = 'sandbox' WHERE id = $1", [f.t.repoId]);
    await admin.query("UPDATE work_items SET gh_number = $2 WHERE id = $1", [f.parent, PARENT_NUMBER]);
    await admin.query("UPDATE agent_runs SET status = 'cancelled' WHERE account_id = $1 AND status IN ('pending', 'running')", [f.t.accountId]);
    const id = f.kids.api!;
    await admin.query("UPDATE work_items SET stage = 'pr_opened' WHERE id = $1", [id]);
    const { id: build } = await insertAgentRun(writerPool, { id: randomUUID(), accountId: f.t.accountId, workItemId: id, specVersionId: f.specV1, role: "executor", runtime: "production", executionMode: "sandbox", dispatchRepoId: f.t.repoId, dispatchPrNumber: PARENT_NUMBER });
    await writeRunStatus(writerPool, { accountId: f.t.accountId, runId: build, from: "pending", to: "running" });
    await writeRunStatus(writerPool, { accountId: f.t.accountId, runId: build, from: "running", to: "succeeded", result: { sessionId: "cc-session-1", envelope: { summary: "built" } } });
    if (o.binding !== false) await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 900, 'child.binding', $3::jsonb)`, [f.t.accountId, build, JSON.stringify({ branch: "fx/41-api" })]);
    const { id: reviewer } = await insertAgentRun(writerPool, { id: randomUUID(), accountId: f.t.accountId, workItemId: id, specVersionId: f.specV1, role: "code-reviewer", runtime: "production", executionMode: "sandbox", dispatchRepoId: f.t.repoId });
    await writeRunStatus(writerPool, { accountId: f.t.accountId, runId: reviewer, from: "pending", to: "running" });
    await writeRunStatus(writerPool, { accountId: f.t.accountId, runId: reviewer, from: "running", to: "succeeded", result: { envelope: { verdict: "needs-fix", findings: ["src/a.ts:3 - off by one"], summary: "one problem" } } });
    return { f, id, build, reviewer };
  }

  it.each([{ binding: true }, { binding: false }])("S5b2c3-5 (build recorded its branch: $binding): the stored prompt names fx/41-<key> and Refs #41, holds no closing keyword, the run is pinned to the child's version, and GitHub was asked about no other branch", async ({ binding }) => {
    const c = await child({ binding });
    asked.length = 0;
    const h = harness();
    const who = { accountId: c.f.t.accountId, userId: c.f.t.userId, workItemId: c.id, haltEpoch: 0 };
    const loaded = await reviewLoadBody(h.module, who, null);
    expect(loaded).toMatchObject({ ok: true, issue: PARENT_NUMBER, branch: "fx/41-api", child: true });
    const found = await findPullRequestForItem(http, { owner: String(loaded.owner), name: String(loaded.name), branch: String(loaded.branch), executionMode: String(loaded.executionMode), recordedPr: null });
    expect(found).toMatchObject({ ok: true, pr: { number: PR, branch: "fx/41-api" } });
    const out = await startFixBody(h.module, who, loaded, { number: PR, headSha: ASKED, branch: (found as { pr: { branch: string } }).pr.branch }, randomUUID(), 1, [{ role: "code-reviewer", runId: c.reviewer }]);
    expect(out.ok, String(out.reason)).toBe(true);
    // what was stored
    const stored = (await admin.query<{ payload: { prompt: string } }>("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'run.input'", [out.runId])).rows[0]!.payload.prompt;
    expect(stored).toContain("fx/41-api");
    expect(stored).toContain("Refs #41");
    expect(stored).not.toContain("fx/issue-41");
    expect(stored).not.toMatch(/\b(?:Closes|Fixes|Resolves) #/i);
    expect((await admin.query("SELECT spec_version_id FROM agent_runs WHERE id = $1", [out.runId])).rows[0].spec_version_id).toBe(c.f.specV1);
    expect(asked).toEqual(["list acme:fx/41-api", "head fx/41-api", "sync fx/41-api#9"]);
    expect(h.resumed[0]).toMatchObject({ workItemId: c.id, pr: PARENT_NUMBER });
  });
});
