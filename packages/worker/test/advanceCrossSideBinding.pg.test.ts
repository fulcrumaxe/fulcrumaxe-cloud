import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DispatchFailedError, JobIssueError, insertAgentRun, writeRunStatus, type CancelResult, type ExecutionRun, type ExecutionTargetRegistry, type StartAgentRunInput } from "@fx/runner";
import { startBuildForItem } from "@fx/pipeline/testing/build";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { createAdvanceModule, type AdvanceModuleDeps } from "../src/advance.js";
import type { RunStarter } from "../src/preview.js";
import type { SeatResult } from "../src/seat.js";

describe("advance: a round that carries on from a pull request the other side opened [pg]", { timeout: 60_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
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
  afterEach(() => vi.restoreAllMocks());

  const SEAT: SeatResult = {
    ok: true,
    seat: {
      repoId: "unused",
      product: "team",
      roleCard: "card",
      model: "haiku-4.5",
      capUsd: 5,
      spend: { plan: "starter", purpose: "run", trigger: "foreground", estimateModelUsd: 5, estimateComputeUsd: 0.5, monthlyModelBudgetUsd: 1000, perSpawnCapUsd: 5 },
      limits: { maxRunMs: 30 * 60_000, maxTurns: 100, maxModelCalls: 300, meteringSilenceMs: 15 * 60_000 },
      timeoutMs: 40 * 60_000,
      maxExtensions: 3,
    } as never,
  };
  const HEAD = "a".repeat(40);
  const registry = { sandbox: { cancel: async (_run: ExecutionRun): Promise<CancelResult> => ({ settled_usd: 0, released_usd: 0 }) } } as unknown as ExecutionTargetRegistry;
  let nextNumber = 9400;
  let nextDiscussion = 940;

  /** Makes the run row the way the platform does, keyed: a key that already names a run answers that run. */
  async function keyedRun(input: StartAgentRunInput, mode: string, parent?: string, leavePending = false): Promise<{ id: string; status: string }> {
    const known = await admin.query<{ run_id: string }>("SELECT run_id FROM agent_run_idempotency_keys WHERE account_id = $1 AND idempotency_key = $2", [input.accountId, input.idempotency!.key]);
    if (known.rows[0]) return { id: known.rows[0].run_id, status: "running" };
    const { id } = await insertAgentRun(writerPool, {
      id: randomUUID(),
      accountId: input.accountId,
      workItemId: input.workItemId,
      ...(parent ? { parentRunId: parent } : {}),
      ...(input.specVersionId ? { specVersionId: input.specVersionId } : {}),
      role: "executor",
      runtime: mode === "sandbox" ? "production" : "runner",
      executionMode: mode,
      dispatchRepoId: input.repoId,
      dispatchPrNumber: input.pr ?? null,
      idempotency: input.idempotency,
      ...(input.inCreateTransaction ? { inCreateTransaction: input.inCreateTransaction } : {}),
    });
    if (leavePending) return { id, status: "pending" };
    await writeRunStatus(writerPool, { accountId: input.accountId, runId: id, from: "pending", to: "running" });
    return { id, status: "running" };
  }

  function module(opts: { starterThrows?: unknown; leavePending?: boolean; fixHeads?: AdvanceModuleDeps["fixHeads"] } = {}) {
    const started: StartAgentRunInput[] = [];
    const resumed: StartAgentRunInput[] = [];
    // The fakes record the mode the real start would resolve for the item: its placement, else the repo's.
    const modeOf = async (input: StartAgentRunInput): Promise<string> =>
      (await admin.query<{ m: string }>("SELECT CASE w.placement WHEN 'cloud' THEN 'sandbox' WHEN 'runner' THEN CASE WHEN r.execution_mode = 'sandbox' THEN 'runner_local' ELSE r.execution_mode END ELSE r.execution_mode END AS m FROM work_items w JOIN repos r ON r.id = w.repo_id WHERE w.id = $1", [input.workItemId])).rows[0]!.m;
    const starter: RunStarter = {
      async start(input) {
        if (opts.starterThrows !== undefined) throw opts.starterThrows;
        started.push(input);
        return { runId: (await keyedRun(input, await modeOf(input), undefined, opts.leavePending === true)).id };
      },
    };
    const deps: AdvanceModuleDeps = {
      starter,
      resolveRunSeat: vi.fn(async () => SEAT),
      startAdvance: async () => undefined,
      triage: null,
      registry,
      build: startBuildForItem,
      // FIXROUND-REFRESH-HEAD: the pull request's branch on GitHub is at the head each round is asked for (fixRoundHeads.pg.test.ts covers a moved one).
      fixHeads: opts.fixHeads ?? { privateHead: async () => HEAD, syncBase: async () => ({ kind: "up_to_date", baseSha: "c".repeat(40), baseRef: "main", stacked: false }) },
      review: {
        load: vi.fn(),
        recordRound: vi.fn(),
        resume: vi.fn(async (_pool: Pool, _registry: ExecutionTargetRegistry, input: StartAgentRunInput) => {
          resumed.push(input);
          return keyedRun(input, await modeOf(input), input.parentRunId ?? undefined);
        }),
        mergeGate: vi.fn(),
      } as never,
    };
    return { module: createAdvanceModule(writerPool, deps), started, resumed };
  }

  async function setup(repoMode = "sandbox") {
    const a: SeedRefs = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets', execution_mode = $2 WHERE id = $1", [a.repoId, repoMode]);
    await admin.query("UPDATE account_members SET role = 'owner' WHERE account_id = $1 AND user_id = $2", [a.accountId, a.userId]);
    const w = randomUUID();
    const n = nextNumber++;
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'issue', 'internal', 'pr_opened', $4)", [w, a.accountId, a.repoId, n]);
    const d = randomUUID();
    await admin.query("INSERT INTO discussions (id, account_id, number, kind, title, root_work_item_id, provenance, created_by_kind) VALUES ($1, $2, $3, 'feature', 't', $4, 'internal', 'user')", [d, a.accountId, nextDiscussion++, w]);
    await admin.query("UPDATE work_items SET discussion_id = $1 WHERE id = $2", [d, w]);
    await admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, 'spec', encode(sha256(convert_to('spec', 'UTF8')), 'hex'), 'system')", [a.accountId, w]);
    const specVersionId = (await admin.query<{ id: string }>("SELECT id FROM spec_versions WHERE work_item_id = $1", [w])).rows[0]!.id;
    return { a, w, n, specVersionId, who: { accountId: a.accountId, userId: a.userId, workItemId: w, haltEpoch: 0 } };
  }

  /** The build the fix round continues: an executor run of the item that finished with a session, in `mode`. */
  async function builtRun(t: Awaited<ReturnType<typeof setup>>, mode: string): Promise<string> {
    const id = randomUUID();
    await admin.query(
      "INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, spec_version_id, cc_session_id, dispatch_repo_id) VALUES ($1, $2, $3, 'executor', $4, 'succeeded', $5, $6, 'cc-1', $7)",
      [id, t.a.accountId, t.w, mode === "sandbox" ? "production" : "runner", mode, t.specVersionId, t.a.repoId],
    );
    return id;
  }
  const fixReq = (t: Awaited<ReturnType<typeof setup>>) => ({ issue: t.n, headSha: HEAD, prompt: "FIX IT", round: 1, actionId: randomUUID(), reviewer: "code" as const, failingRunId: randomUUID() });
  const place = (t: Awaited<ReturnType<typeof setup>>, placement: string | null) => admin.query("UPDATE work_items SET placement = $2 WHERE id = $1", [t.w, placement]);


  const RUN_BRANCH = (run: string) => `fx/${run}-g1`;
  const fixPr = (t: Awaited<ReturnType<typeof setup>>, pr?: { number: number; branch: string }) => ({ ...fixReq(t), ...(pr ? { pr } : {}) });
  const boundEvents = async (runId: string) => (await admin.query("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'runner.continues_bound'", [runId])).rows.map((r) => r.payload);

  /** A runner build that recorded its pull request at done, as a runner run does. */
  async function runnerBuildWithPr(t: Awaited<ReturnType<typeof setup>>, pr = 41): Promise<{ id: string; branch: string }> {
    const id = await builtRun(t, "runner_local");
    await admin.query("UPDATE agent_runs SET status = 'running' WHERE id = $1", [id]);
    await writeRunStatus(writerPool, { accountId: t.a.accountId, runId: id, from: "running", to: "succeeded", runnerDone: { prNumber: pr, branch: RUN_BRANCH(id) } });
    return { id, branch: RUN_BRANCH(id) };
  }

  describe("a runner build, a cloud fix round", () => {
    it("is a fresh sandbox session bound to the recorded pull request in its own create transaction; the lookup then follows that pair; a replay starts nothing", async () => {
      const t = await setup("runner_local");
      const m = module();
      const build = await runnerBuildWithPr(t);
      await place(t, "cloud");
      const req = fixPr(t, { number: 41, branch: build.branch });
      const fix = await m.module.advanceStartFix(t.who, req);
      expect(fix.ok).toBe(true);
      const runId = (fix as { runId: string }).runId;
      expect(m.resumed).toEqual([]);
      expect(m.started).toHaveLength(1);
      expect(m.started[0]!.continues).toBeUndefined();
      expect(m.started[0]!.parentRunId).toBeUndefined();
      expect(typeof m.started[0]!.inCreateTransaction).toBe("function");
      expect(await boundEvents(runId)).toEqual([{ pr_number: 41, branch: build.branch, side: "sandbox" }]);
      expect((await admin.query("SELECT execution_mode, runtime FROM agent_runs WHERE id = $1", [runId])).rows[0]).toEqual({ execution_mode: "sandbox", runtime: "production" });
      // The pull request is the bound one, on the side of the newest executor run, with no fx/issue-<n> lookup.
      expect(await m.module.advanceLoadItem(t.a.accountId, t.w)).toMatchObject({ executionMode: "sandbox", prExecutionMode: "sandbox", recordedPr: { number: 41, branch: build.branch, bound: true } });
      expect(await m.module.advanceStartFix(t.who, req)).toEqual(fix);
      expect(m.started).toHaveLength(1);
      expect(await boundEvents(runId)).toHaveLength(1);
    });

    it("refuses pr_unbound, with nothing started, when the pair is not the one the runner recorded", async () => {
      const t = await setup("runner_local");
      const m = module();
      const build = await runnerBuildWithPr(t);
      await place(t, "cloud");
      for (const pr of [{ number: 42, branch: build.branch }, { number: 41, branch: RUN_BRANCH(randomUUID()) }, { number: 41, branch: "fx/issue-1" }]) {
        expect(await m.module.advanceStartFix(t.who, fixPr(t, pr)), JSON.stringify(pr)).toEqual({ ok: false, reason: "pr_unbound" });
      }
      expect(m.started).toEqual([]);
      expect((await admin.query("SELECT count(*)::int AS n FROM agent_runs WHERE work_item_id = $1 AND status IN ('pending', 'running')", [t.w])).rows[0].n).toBe(0);
    });

    it("refuses pr_unbound when the runner recorded no pull request at all", async () => {
      const t = await setup("runner_local");
      const m = module();
      const id = await builtRun(t, "runner_local");
      await place(t, "cloud");
      expect(await m.module.advanceStartFix(t.who, fixPr(t, { number: 41, branch: RUN_BRANCH(id) }))).toEqual({ ok: false, reason: "pr_unbound" });
    });

    it("a malformed pair is invalid_input before anything is read or written", async () => {
      const t = await setup("runner_local");
      const m = module();
      await runnerBuildWithPr(t);
      await place(t, "cloud");
      for (const pr of [{ number: 0, branch: "fx/issue-1" }, { number: 1.5, branch: "fx/issue-1" }, { number: 41, branch: "main" }, { number: 41, branch: "fx/issue-07" }, { number: 41, branch: "fx/x; rm -rf /" }]) {
        expect(await m.module.advanceStartFix(t.who, fixPr(t, pr)), JSON.stringify(pr)).toEqual({ ok: false, reason: "invalid_input" });
      }
      expect(m.started).toEqual([]);
    });
  });

  describe("a cloud build, a runner fix round", () => {
    it("starts a runner continuation of the item's own pull request branch with its number and the parent run, and writes the binding itself only through the issuer", async () => {
      const t = await setup("sandbox");
      const m = module({ leavePending: true });
      const build = await builtRun(t, "sandbox");
      await place(t, "runner");
      const fix = await m.module.advanceStartFix(t.who, fixPr(t, { number: 41, branch: `fx/issue-${t.n}` }));
      expect(fix.ok).toBe(true);
      expect(m.started).toHaveLength(1);
      expect(m.started[0]!.continues).toEqual({ branch: `fx/issue-${t.n}`, prNumber: 41, baseSha: "c".repeat(40) });
      expect(m.started[0]!.parentRunId).toBe(build);
      // D#7 DP4b-3b: the hook is the decision snapshot write only; the binding is still not written here (asserted below).
    expect(m.started[0]!.inCreateTransaction).toBeTypeOf("function");
      expect(await boundEvents((fix as { runId: string }).runId)).toEqual([]);
    });

    describe("a pull request on a run branch (defence in depth: it must be the pair the item itself recorded)", () => {
      /** A sandbox round that carried on from a runner-opened pull request, bound to it as the worker records it. */
      async function boundSandboxRound(t: Awaited<ReturnType<typeof setup>>, pr: number, branch: string): Promise<void> {
        const id = await builtRun(t, "sandbox");
        await admin.query("INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'runner.continues_bound', $3::jsonb)", [t.a.accountId, id, JSON.stringify({ pr_number: pr, branch, side: "sandbox" })]);
      }

      it("is a continuation without a number when it matches the pair a sandbox round was bound to", async () => {
        const t = await setup("sandbox");
        const m = module({ leavePending: true });
        const branch = RUN_BRANCH(randomUUID());
        await boundSandboxRound(t, 41, branch);
        await place(t, "runner");
        expect((await m.module.advanceStartFix(t.who, fixPr(t, { number: 41, branch }))).ok).toBe(true);
        expect(m.started[0]!.continues).toEqual({ branch });
      });

      it("is a continuation when it matches the pair a runner recorded at done, after a sandbox round that was not itself bound", async () => {
        const t = await setup("runner_local");
        const m = module({ leavePending: true });
        const build = await runnerBuildWithPr(t);
        await builtRun(t, "sandbox");
        await place(t, "runner");
        expect((await m.module.advanceStartFix(t.who, fixPr(t, { number: 41, branch: build.branch }))).ok).toBe(true);
        expect(m.started[0]!.continues).toEqual({ branch: build.branch });
      });

      it("carries the base the sync read when the item has an open public copy (FIXROUND-REPUBLISH R2-c0); a plain item keeps its continuation as it was", async () => {
        const t = await setup("runner_local");
        const m = module({ leavePending: true, fixHeads: { privateHead: async () => HEAD, publicHead: async () => "d".repeat(40), syncBase: async () => ({ kind: "up_to_date", baseSha: "c".repeat(40), baseRef: "main", stacked: false }) } });
        const build = await runnerBuildWithPr(t);
        await builtRun(t, "sandbox");
        await place(t, "runner");
        await admin.query("INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, 'acme/widgets-public', $3)", [t.a.repoId, t.a.accountId, ["private/**"]]);
        await admin.query(
          `INSERT INTO plane_pushes (account_id, work_item_id, repo_id, code_repo, pairing_digest, head_sha, tip_sha, pr_number, pr_url, state) VALUES ($1, $2, $3, 'acme/widgets-public', $4, $5, $6, 7, 'https://github.com/acme/widgets-public/pull/7', 'pr_opened')`,
          [t.a.accountId, t.w, t.a.repoId, "f".repeat(64), "d".repeat(40), "e".repeat(40)],
        );
        expect((await m.module.advanceStartFix(t.who, fixPr(t, { number: 41, branch: build.branch }))).ok).toBe(true);
        expect(m.started[0]!.continues).toEqual({ branch: build.branch, baseSha: "c".repeat(40) });
      });

      it("is refused pr_unbound, with nothing started, when the number or the branch is not the recorded one, or nothing was recorded", async () => {
        const t = await setup("sandbox");
        const m = module({ leavePending: true });
        const branch = RUN_BRANCH(randomUUID());
        await boundSandboxRound(t, 41, branch);
        await place(t, "runner");
        for (const pr of [{ number: 42, branch }, { number: 41, branch: RUN_BRANCH(randomUUID()) }]) {
          expect(await m.module.advanceStartFix(t.who, fixPr(t, pr)), JSON.stringify(pr)).toEqual({ ok: false, reason: "pr_unbound" });
        }
        const bare = await setup("sandbox");
        await builtRun(bare, "sandbox");
        await place(bare, "runner");
        expect(await m.module.advanceStartFix(bare.who, fixPr(bare, { number: 41, branch: RUN_BRANCH(randomUUID()) }))).toEqual({ ok: false, reason: "pr_unbound" });
        expect(m.started).toEqual([]);
      });
    });

    it("the issuer's closed refusal reaches the step as its code, with a fact recorded and no run left live", async () => {
      for (const code of ["continues_pr_not_open", "continues_pr_mismatch", "continues_branch_protected", "continues_base_unavailable"] as const) {
        const t = await setup("sandbox");
        const m = module({ starterThrows: new DispatchFailedError(randomUUID(), new JobIssueError(code)) });
        await builtRun(t, "sandbox");
        await place(t, "runner");
        expect(await m.module.advanceStartFix(t.who, fixPr(t, { number: 41, branch: `fx/issue-${t.n}` })), code).toEqual({ ok: false, reason: code });
        expect((await admin.query("SELECT code FROM work_item_driver_events WHERE work_item_id = $1 AND kind = 'fix_round_refused'", [t.w])).rows, code).toEqual([{ code }]);
        expect((await admin.query("SELECT count(*)::int AS n FROM agent_runs WHERE work_item_id = $1 AND status IN ('pending', 'running')", [t.w])).rows[0].n).toBe(0);
      }
    });

    it("an error that is not a continuation refusal stays resume_failed, and carries no issuer text", async () => {
      const t = await setup("sandbox");
      const m = module({ starterThrows: new DispatchFailedError(randomUUID(), new Error("socket hang up token=abc")) });
      await builtRun(t, "sandbox");
      await place(t, "runner");
      expect(await m.module.advanceStartFix(t.who, fixPr(t, { number: 41, branch: `fx/issue-${t.n}` }))).toEqual({ ok: false, reason: "resume_failed" });
    });
  });

  it("a round with no pull request named is exactly the PL-2 fresh session: no continuation, no binding", async () => {
    const t = await setup("sandbox");
    const m = module();
    await builtRun(t, "sandbox");
    await place(t, "runner");
    const fix = await m.module.advanceStartFix(t.who, fixReq(t));
    expect(fix.ok).toBe(true);
    expect(m.started[0]!.continues).toBeUndefined();
    // D#7 DP4b-3b: the hook is the decision snapshot write only; the binding is still not written here (asserted below).
    expect(m.started[0]!.inCreateTransaction).toBeTypeOf("function");
  });

  it("a same-side round names no pull request to the starter and still resumes", async () => {
    const t = await setup("sandbox");
    const m = module();
    await builtRun(t, "sandbox");
    const fix = await m.module.advanceStartFix(t.who, fixPr(t, { number: 41, branch: `fx/issue-${t.n}` }));
    expect(fix.ok).toBe(true);
    expect(m.started).toEqual([]);
    expect(m.resumed).toHaveLength(1);
  });
});
