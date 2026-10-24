import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { applyMappedEvent, type ApplyEventCtx, type BranchSyncOutcome } from "@fx/github";
import { withTenant } from "@fx/db/src/withTenant.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { insertAgentRun, writeRunStatus, type CancelResult, type ExecutionRun, type ExecutionTargetRegistry, type StartAgentRunInput } from "@fx/runner";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { PUBLIC_BRANCH_MOVED } from "@fx/core/src/repos/planePushRecord.js";
import { lineFor } from "@fx/core/src/onboarding/previewProgress.js";
import { createAdvanceModule, type AdvanceModuleDeps, type AdvanceReviewDeps } from "../src/advance.js";
import { startCheckFixRound } from "../src/checkFix.js";
import { BASE_SYNC_CONFLICT_SENTENCE } from "@fx/core/src/work-items/baseSync.js";
import { BASE_SYNCED_STAGE, syncRunBranch } from "../src/fixRoundBase.js";
import { getWorkItemActivity } from "@fx/core/src/work-items/activity.js";
import { generateKeyPairSync } from "node:crypto";
import { InstallationTokenCache, createBranchSyncPort, createInstallationHttp, type AccessTokenRequester } from "@fx/github";
import { BRANCH_MOVED_STAGE, checkPublicBranch, type FixRoundHeadPorts } from "../src/fixRoundHeads.js";
import type { RunStarter } from "../src/preview.js";
import type { SeatResult } from "../src/seat.js";

/**
 * [pg] FIXROUND-REFRESH-HEAD: every fix round reads its branches on GitHub before it starts. Real rows and real keys; the GitHub reads are stand-ins with the
 * contract of the real ports (`ContinuationBasePort.headOid` and the hosted `branchHead`: a sha, null for no such branch, a throw when GitHub cannot answer),
 * whose own calls are exercised over TLS in apps/web runnerPullRequest tests and packages/github planePushHosted.test.ts. The resume is the pipeline's as a
 * stand-in that writes the keyed run row the real one writes.
 */
describe("fix round: the branch heads on GitHub before a round starts [pg]", { timeout: 60_000 }, () => {
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
  const ASKED = "a".repeat(40);
  const LIVE = "c".repeat(40);
  const PUSHED = "d".repeat(40);
  const TIP = "e".repeat(40);
  const PR = 41;
  let nextNumber = 9600;
  let nextDiscussion = 960;
  const registry = { sandbox: { cancel: async (_run: ExecutionRun): Promise<CancelResult> => ({ settled_usd: 0, released_usd: 0 }) } } as unknown as ExecutionTargetRegistry;

  /** A round whose branch is already up to date with its base (204), so the rounds below that are not about the sync see no sync. */
  const upToDate = async (): Promise<BranchSyncOutcome> => ({ kind: "up_to_date" });
  function harness(given: FixRoundHeadPorts | null, seatResult: SeatResult | { ok: false; reason: string } = SEAT) {
    const heads = given && given.privateHead && !("syncBase" in given) ? { ...given, syncBase: upToDate } : given;
    const resumed: StartAgentRunInput[] = [];
    const resume = vi.fn(async (_pool: Pool, _registry: ExecutionTargetRegistry, input: StartAgentRunInput) => {
      resumed.push(input);
      const { id } = await insertAgentRun(writerPool, {
        id: randomUUID(),
        accountId: input.accountId,
        workItemId: input.workItemId,
        parentRunId: input.parentRunId,
        role: "executor",
        runtime: "production",
        executionMode: "sandbox",
        dispatchRepoId: input.repoId,
        dispatchPrNumber: input.pr ?? null,
        idempotency: input.idempotency,
      });
      await writeRunStatus(writerPool, { accountId: input.accountId, runId: id, from: "pending", to: "running" });
      return { id, status: "running" };
    });
    const review: AdvanceReviewDeps = { load: vi.fn(), recordRound: vi.fn(), resume, mergeGate: vi.fn() } as never;
    const starter: RunStarter = { async start() { throw new Error("a same-side round never starts a fresh session"); } };
    const deps: AdvanceModuleDeps = { starter, resolveRunSeat: vi.fn(async () => seatResult as SeatResult), startAdvance: async () => undefined, triage: null, registry, review, ...(heads ? { fixHeads: heads } : {}) };
    return { module: createAdvanceModule(writerPool, deps), resume, resumed };
  }

  /** A runner_local item at `pr_opened` whose build ended through `done` with its pull request on a run branch, as a runner build does. */
  async function runnerItem(): Promise<{ a: SeedRefs; w: string; n: number; branch: string }> {
    const a = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets', execution_mode = 'runner_local' WHERE id = $1", [a.repoId]);
    await admin.query("UPDATE agent_runs SET status = 'cancelled' WHERE account_id = $1", [a.accountId]);
    const w = randomUUID();
    const n = nextNumber++;
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'issue', 'internal', 'pr_opened', $4)", [w, a.accountId, a.repoId, n]);
    const d = randomUUID();
    await admin.query("INSERT INTO discussions (id, account_id, number, kind, title, root_work_item_id, provenance, created_by_kind) VALUES ($1, $2, $3, 'feature', 't', $4, 'internal', 'user')", [d, a.accountId, nextDiscussion++, w]);
    await admin.query("UPDATE work_items SET discussion_id = $1 WHERE id = $2", [d, w]);
    await admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, 'spec', encode(sha256(convert_to('spec', 'UTF8')), 'hex'), 'system')", [a.accountId, w]);
    const spec = (await admin.query<{ id: string }>("SELECT id FROM spec_versions WHERE work_item_id = $1", [w])).rows[0]!.id;
    const { id: build } = await insertAgentRun(writerPool, { id: randomUUID(), accountId: a.accountId, workItemId: w, specVersionId: spec, role: "executor", runtime: "runner", executionMode: "runner_local", dispatchRepoId: a.repoId, dispatchPrNumber: n });
    const branch = `fx/${build}-g1`;
    await writeRunStatus(writerPool, { accountId: a.accountId, runId: build, from: "pending", to: "running" });
    await writeRunStatus(writerPool, { accountId: a.accountId, runId: build, from: "running", to: "succeeded", result: { sessionId: "cc-session-1", envelope: { summary: "built" } }, runnerDone: { prNumber: PR, branch } });
    return { a, w, n, branch };
  }
  /** The item's pairing, and the record of what the platform pushed to the public repo for it. */
  async function paired(t: { a: SeedRefs; w: string }, over: { managed?: boolean } = {}): Promise<void> {
    await admin.query("INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, 'acme/widgets-public', $3)", [t.a.repoId, t.a.accountId, ["private/**"]]);
    await admin.query(
      `INSERT INTO plane_pushes (account_id, work_item_id, repo_id, code_repo, pairing_digest, head_sha, tip_sha, pr_number, pr_url, state, managed_by_person_at)
       VALUES ($1, $2, $3, 'acme/widgets-public', $4, $5, $6, 7, 'https://github.com/acme/widgets-public/pull/7', 'pr_opened', $7)`,
      [t.a.accountId, t.w, t.a.repoId, "f".repeat(64), PUSHED, TIP, over.managed ? new Date() : null],
    );
  }
  const who = (t: { a: SeedRefs; w: string }) => ({ accountId: t.a.accountId, userId: t.a.userId, workItemId: t.w, haltEpoch: 0 });
  const fixReq = (t: { n: number }) => ({ issue: t.n, headSha: ASKED, prompt: "fix it", round: 1, actionId: randomUUID(), reviewer: "code" as const, failingRunId: randomUUID() });
  const facts = async (w: string) =>
    (await admin.query<{ kind: string; code: string | null; head_sha: string | null; pr_number: number | null }>("SELECT kind, code, head_sha, pr_number FROM work_item_driver_events WHERE work_item_id = $1 ORDER BY seq", [w])).rows;
  const stages = async (runId: string) => (await admin.query<{ stage: string }>("SELECT payload->>'stage' AS stage FROM run_events WHERE run_id = $1 AND kind = 'run.stage'", [runId])).rows.map((r) => r.stage);
  const stageOf = async (w: string) => (await admin.query<{ stage: string }>("SELECT stage FROM work_items WHERE id = $1", [w])).rows[0]!.stage;
  const liveRuns = async (w: string) => (await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM agent_runs WHERE work_item_id = $1 AND status IN ('pending', 'running')", [w])).rows[0]!.n;

  describe("the private pull request (A)", () => {
    it("a branch that moved on GitHub is recorded as the webhook would, and the round starts from it, with the activity line on the run", async () => {
      const t = await runnerItem();
      const privateHead = vi.fn(async () => LIVE);
      const h = harness({ privateHead });
      const out = await h.module.advanceStartFix(who(t), fixReq(t));
      expect(out.ok).toBe(true);
      // The read is of the item's own recorded pull request branch, in its own repository.
      expect(privateHead).toHaveBeenCalledWith({ repo: { id: t.a.repoId, owner: "acme", name: "widgets" }, branch: t.branch });
      expect(await facts(t.w)).toEqual(
        expect.arrayContaining([
          { kind: "pr_head_pushed", code: "observed", head_sha: LIVE, pr_number: PR },
          expect.objectContaining({ kind: "fix_round_started" }),
        ]),
      );
      const runId = (out as { runId: string }).runId;
      expect(await stages(runId)).toEqual([BRANCH_MOVED_STAGE]);
      expect(lineFor("run.stage", { stage: BRANCH_MOVED_STAGE })).toBe("The pull request's branch had moved; the fix round started from its latest commit.");
      expect(h.resume).toHaveBeenCalledTimes(1);
    });

    it("a branch at the head the round was asked for changes nothing: no fact, no line, the round starts as before", async () => {
      const t = await runnerItem();
      const h = harness({ privateHead: async () => ASKED });
      const out = await h.module.advanceStartFix(who(t), fixReq(t));
      expect(out.ok).toBe(true);
      expect((await facts(t.w)).map((f) => f.kind)).not.toContain("pr_head_pushed");
      expect(await stages((out as { runId: string }).runId)).toEqual([]);
    });

    it("GitHub that cannot be read, a port that is missing, or a branch that is gone refuses the round by name and starts nothing", async () => {
      for (const [heads, code] of [
        [{ privateHead: async () => { throw Object.assign(new Error("connect ECONNREFUSED token=ghs_x"), { retryable: true }); } }, "pr_head_unavailable"],
        [null, "pr_head_unavailable"],
        [{ privateHead: async () => null }, "pr_branch_missing"],
      ] as const) {
        const t = await runnerItem();
        const h = harness(heads);
        expect(await h.module.advanceStartFix(who(t), fixReq(t)), code).toEqual({ ok: false, reason: code });
        expect(h.resume).not.toHaveBeenCalled();
        expect((await facts(t.w)).map((f) => [f.kind, f.code])).toEqual([["fix_round_refused", code]]);
        expect(await stageOf(t.w)).toBe("pr_opened");
        expect(await liveRuns(t.w)).toBe(0);
      }
    });
  });

  describe("the paired public pull request (C)", () => {
    it("a public branch changed outside the cloud refuses public_branch_moved, records the live head, leaves the stamp, and starts nothing", async () => {
      const t = await runnerItem();
      await paired(t);
      const publicHead = vi.fn(async () => LIVE);
      const privateHead = vi.fn(async () => ASKED);
      const h = harness({ privateHead, publicHead });
      expect(await h.module.advanceStartFix(who(t), fixReq(t))).toEqual({ ok: false, reason: PUBLIC_BRANCH_MOVED });
      expect(publicHead).toHaveBeenCalledWith({ codeRepo: "acme/widgets-public", branch: expect.stringMatching(/^fx\/p-[0-9a-f-]{36}$/) });
      expect(h.resume).not.toHaveBeenCalled();
      expect(privateHead).not.toHaveBeenCalled();
      const f = await facts(t.w);
      expect(f).toContainEqual({ kind: "stopped", code: PUBLIC_BRANCH_MOVED, head_sha: LIVE, pr_number: 7 });
      expect(f).toContainEqual(expect.objectContaining({ kind: "fix_round_refused", code: PUBLIC_BRANCH_MOVED }));
      // Only a verified push moves the stamp: resetting the branch to it is what clears the refusal.
      expect((await admin.query("SELECT head_sha, state FROM plane_pushes WHERE work_item_id = $1", [t.w])).rows[0]).toEqual({ head_sha: PUSHED, state: "pr_opened" });
      expect(await stageOf(t.w)).toBe("pr_opened");
      expect(await liveRuns(t.w)).toBe(0);

      // The branch put back where the platform left it: the next round starts.
      publicHead.mockResolvedValue(PUSHED);
      expect((await h.module.advanceStartFix(who(t), fixReq(t))).ok).toBe(true);
    });

    it("a public branch that was deleted is a change too; one GitHub cannot read is public_head_unavailable; a port that is missing refuses the same way", async () => {
      for (const [heads, code] of [
        [{ privateHead: async () => ASKED, publicHead: async () => null }, PUBLIC_BRANCH_MOVED],
        [{ privateHead: async () => ASKED, publicHead: async () => { throw new Error("public_unavailable"); } }, "public_head_unavailable"],
        // An answer that is neither a commit id nor "no such branch" is not an answer (fail closed).
        [{ privateHead: async () => ASKED, publicHead: async () => "main" }, "public_head_unavailable"],
        [{ privateHead: async () => ASKED }, "public_head_unavailable"],
      ] as const) {
        const t = await runnerItem();
        await paired(t);
        const h = harness(heads);
        expect(await h.module.advanceStartFix(who(t), fixReq(t)), code).toEqual({ ok: false, reason: code });
        expect(h.resume).not.toHaveBeenCalled();
      }
    });

    it("is not asked for an item with no public push, or one a person took over (the platform pushes nothing there)", async () => {
      const bare = await runnerItem();
      const publicHead = vi.fn(async () => LIVE);
      expect((await harness({ privateHead: async () => ASKED, publicHead }).module.advanceStartFix(who(bare), fixReq(bare))).ok).toBe(true);
      const managed = await runnerItem();
      await paired(managed, { managed: true });
      expect((await harness({ privateHead: async () => ASKED, publicHead }).module.advanceStartFix(who(managed), fixReq(managed))).ok).toBe(true);
      expect(publicHead).not.toHaveBeenCalled();
    });

    it("a check fix round of a paired item is held to the same rule before anything starts", async () => {
      const t = await runnerItem();
      await paired(t);
      const failed = randomUUID();
      await admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode, dispatch_repo_id, cc_session_id) VALUES ($1, $2, $3, 'executor', 'runner', 'failed', 'runner_local', $4, 'sess-1')", [failed, t.a.accountId, t.w, t.a.repoId]);
      await admin.query("INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'run.status_changed', $3::jsonb)", [t.a.accountId, failed, JSON.stringify({ from: "running", to: "failed", failureReason: "check_failed" })]);
      const resume = vi.fn();
      const out = await startCheckFixRound(
        { pool: writerPool, registry, resume, resolveRunSeat: async () => SEAT, beforeStart: () => checkPublicBranch(writerPool, { publicHead: async () => LIVE }, { accountId: t.a.accountId, workItemId: t.w }) },
        { accountId: t.a.accountId, workItemId: t.w },
        failed,
      );
      expect(out).toEqual({ ok: false, reason: PUBLIC_BRANCH_MOVED });
      expect(resume).not.toHaveBeenCalled();
    });
  });

  /** The card's notice for an item, read through the real activity read (not a hand-made fact). */
  const noticeOf = async (t: { a: SeedRefs; w: string }) => (await getWorkItemActivity({ pool: adminPool, principal: { accountId: t.a.accountId, userId: t.a.userId } }, t.w)).notice;

  describe("FIXROUND-BASE-SYNC: the base is merged into the private branch before a review fix round", () => {
    const BASE = "f".repeat(40);
    const MERGE = "9".repeat(40);
    const merged = (over: Partial<Extract<BranchSyncOutcome, { kind: "merged" }>> = {}): BranchSyncOutcome => ({ kind: "merged", sha: MERGE, parents: [ASKED, BASE], baseSha: BASE, baseRef: "main", ...over });
    const syncFacts = async (w: string) => (await facts(w)).filter((f) => f.kind !== "fix_round_refused" && (f.code === "base_synced" || f.code === "base_sync_conflict" || f.code === "base_sync_unavailable"));
    const runs = async (w: string) => (await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM agent_runs WHERE work_item_id = $1", [w])).rows[0]!.n;

    it("main moved: one merge on the item's branch, one fact, and a replay writes no second one; the round starts from the merge", async () => {
      const t = await runnerItem();
      const syncBase = vi.fn(async () => merged());
      const h = harness({ privateHead: async () => ASKED, syncBase });
      const req = fixReq(t);
      const out = await h.module.advanceStartFix(who(t), req);
      expect(out.ok).toBe(true);
      expect(syncBase).toHaveBeenCalledWith({ repo: { id: t.a.repoId, owner: "acme", name: "widgets" }, branch: t.branch, prNumber: PR });
      expect(await syncFacts(t.w)).toEqual([{ kind: "pr_head_pushed", code: "base_synced", head_sha: MERGE, pr_number: PR }]);
      expect(await stages((out as { runId: string }).runId)).toEqual([BASE_SYNCED_STAGE]);
      expect(lineFor("run.stage", { stage: BASE_SYNCED_STAGE })).toBe("The branch was brought up to date with its base before this fix round.");
      // The same ask again finds the run it started: GitHub is not asked, and no second fact is written.
      expect(await h.module.advanceStartFix(who(t), req)).toEqual(out);
      expect(syncBase).toHaveBeenCalledTimes(1);
      expect(await syncFacts(t.w)).toHaveLength(1);
    });

    it("asks only the private-repository port: no public branch read or token is part of the sync", async () => {
      const t = await runnerItem();
      await paired(t);
      const publicHead = vi.fn(async () => PUSHED);
      const syncBase = vi.fn(async () => merged());
      expect(await syncRunBranch(writerPool, { publicHead, syncBase }, { accountId: t.a.accountId, workItemId: t.w }, { repo: { id: t.a.repoId, owner: "acme", name: "widgets" }, pr: { number: PR, branch: t.branch }, liveHead: ASKED, moveToNeedsPerson: true, attempt: "a1" })).toEqual({ ok: true, synced: true });
      expect(syncBase).toHaveBeenCalledTimes(1);
      expect(publicHead).not.toHaveBeenCalled();
    });

    it("a push between the head check and the merge is recorded too, as the webhook would", async () => {
      const t = await runnerItem();
      const h = harness({ privateHead: async () => ASKED, syncBase: async () => merged({ parents: [LIVE, BASE] }) });
      expect((await h.module.advanceStartFix(who(t), fixReq(t))).ok).toBe(true);
      expect((await facts(t.w)).filter((f) => f.kind === "pr_head_pushed")).toEqual([
        { kind: "pr_head_pushed", code: "observed", head_sha: LIVE, pr_number: PR },
        { kind: "pr_head_pushed", code: "base_synced", head_sha: MERGE, pr_number: PR },
      ]);
    });

    it("main did not move (204): no fact, no line, and the round starts from the checked head", async () => {
      const t = await runnerItem();
      const h = harness({ privateHead: async () => ASKED, syncBase: upToDate });
      const out = await h.module.advanceStartFix(who(t), fixReq(t));
      expect(out.ok).toBe(true);
      expect(await syncFacts(t.w)).toEqual([]);
      expect(await stages((out as { runId: string }).runId)).toEqual([]);
    });

    it("a conflict: no run, the item in Needs a person, the escalation recorded, and the branch untouched", async () => {
      const t = await runnerItem();
      const h = harness({ privateHead: async () => ASKED, syncBase: async () => ({ kind: "conflict", baseSha: BASE, baseRef: "main" }) });
      const before = await runs(t.w);
      expect(await h.module.advanceStartFix(who(t), fixReq(t))).toEqual({ ok: false, reason: "base_sync_conflict" });
      expect(h.resume).not.toHaveBeenCalled();
      expect(await runs(t.w)).toBe(before);
      expect(await stageOf(t.w)).toBe("needs_human");
      expect(await syncFacts(t.w)).toEqual([{ kind: "escalated", code: "base_sync_conflict", head_sha: ASKED, pr_number: PR }]);
      expect(await liveRuns(t.w)).toBe(0);
      // The card, read the way a person reads it: the fact and the move share a transaction (one stamp), and the sentence still shows.
      expect(await noticeOf(t)).toEqual({ kind: "needs_human", reason: BASE_SYNC_CONFLICT_SENTENCE });
    });

    it("a repeated conflict at the same head, after the item left Needs a person, moves it back and shows the sentence again", async () => {
      const t = await runnerItem();
      const h = harness({ privateHead: async () => ASKED, syncBase: async () => ({ kind: "conflict", baseSha: BASE, baseRef: "main" }) });
      expect(await h.module.advanceStartFix(who(t), fixReq(t))).toEqual({ ok: false, reason: "base_sync_conflict" });
      expect(await stageOf(t.w)).toBe("needs_human");
      // A person presses Approve: the item is back under review, and the branch and its base have not moved.
      await admin.query("UPDATE work_items SET stage = 'pr_opened' WHERE id = $1", [t.w]);
      expect(await h.module.advanceStartFix(who(t), fixReq(t))).toEqual({ ok: false, reason: "base_sync_conflict" });
      expect(await stageOf(t.w)).toBe("needs_human");
      expect((await syncFacts(t.w)).map((f) => f.code)).toEqual(["base_sync_conflict", "base_sync_conflict"]);
      expect(await noticeOf(t)).toEqual({ kind: "needs_human", reason: BASE_SYNC_CONFLICT_SENTENCE });
    });

    it("the cheap refusals come first: a seat refusal means GitHub is never asked, so no merge lands for a refused round", async () => {
      const t = await runnerItem();
      const syncBase = vi.fn(async () => merged());
      const h = harness({ privateHead: async () => ASKED, syncBase }, { ok: false, reason: "no_model" });
      expect(await h.module.advanceStartFix(who(t), fixReq(t))).toEqual({ ok: false, reason: "no_model" });
      expect(syncBase).not.toHaveBeenCalled();
      expect(await syncFacts(t.w)).toEqual([]);
    });

    it("through the real port and client: exactly one branch_sync token, for the private repository, no public token, and the merge is the one asked for", async () => {
      const t = await runnerItem();
      const privateKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey as unknown as string;
      const mints: Array<Parameters<AccessTokenRequester>[0]> = [];
      const calls: string[] = [];
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
        const u = new URL(String(input));
        calls.push(`${init?.method ?? "GET"} ${u.pathname}`);
        if (u.pathname === `/repos/acme/widgets/pulls/${PR}`) return json(200, { state: "open", head: { ref: t.branch, repo: { id: 5 } }, base: { ref: "main", repo: { id: 5 } } });
        if (u.pathname === "/repos/acme/widgets/git/ref/heads/main") return json(200, { object: { sha: BASE } });
        if (u.pathname === "/repos/acme/widgets/merges") return json(201, { sha: MERGE, parents: [{ sha: ASKED }, { sha: BASE }] });
        return new Response(null, { status: 204 });
      }) as unknown as typeof fetch;
      const open = createInstallationHttp({
        resolveInstallation: async () => ({ installationId: 9, appKind: "team" }),
        appCredentials: () => ({ appId: "app-1", privateKeyPem, webhookSecret: "unused" }),
        requester: async (p) => (mints.push(p), { token: "fake-token", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: { metadata: "read", contents: "write", pull_requests: "read" }, repositories: ["widgets"] }),
        cache: new InstallationTokenCache(),
        fetchImpl,
      });
      const publicHead = vi.fn(async () => PUSHED);
      const sync = createBranchSyncPort(open);
      const h = harness({ privateHead: async () => ASKED, publicHead, syncBase: (i) => sync.sync(i) });
      expect((await h.module.advanceStartFix(who(t), fixReq(t))).ok).toBe(true);
      expect(mints).toHaveLength(1);
      expect(mints[0]).toMatchObject({ repositories: ["widgets"], permissions: { contents: "write", pull_requests: "read" } });
      expect(publicHead).not.toHaveBeenCalled();
      expect(calls).toEqual([`GET /repos/acme/widgets/pulls/${PR}`, "GET /repos/acme/widgets/git/ref/heads/main", "POST /repos/acme/widgets/merges", "DELETE /installation/token"]);
      expect(await syncFacts(t.w)).toEqual([{ kind: "pr_head_pushed", code: "base_synced", head_sha: MERGE, pr_number: PR }]);
    });

    it("GitHub that cannot be asked, a bad reply or a missing port refuses the round: nothing starts and the item stays where it was", async () => {
      const bad: Array<FixRoundHeadPorts["syncBase"]> = [
        async () => { throw new Error("connect ECONNREFUSED token=ghs_x"); },
        async () => merged({ parents: [ASKED, "e".repeat(40)] }),
        async () => merged({ parents: [BASE, ASKED] }),
        async () => merged({ sha: "main" }),
        undefined,
      ];
      for (const syncBase of bad) {
        const t = await runnerItem();
        const h = harness({ privateHead: async () => ASKED, syncBase: syncBase as never });
        const before = await runs(t.w);
        expect(await h.module.advanceStartFix(who(t), fixReq(t))).toEqual({ ok: false, reason: "base_sync_unavailable" });
        expect(h.resume).not.toHaveBeenCalled();
        expect(await runs(t.w)).toBe(before);
        expect(await stageOf(t.w)).toBe("pr_opened");
        expect((await syncFacts(t.w)).map((f) => [f.kind, f.code])).toEqual([["stopped", "base_sync_unavailable"]]);
      }
    });

    it("the sync's own synchronize webhook starts no second round and no review: it records a push and nothing else", async () => {
      const t = await runnerItem();
      const h = harness({ privateHead: async () => ASKED, syncBase: async () => merged() });
      const out = await h.module.advanceStartFix(who(t), fixReq(t));
      expect(out.ok).toBe(true);
      const runsBefore = await runs(t.w);
      const kindsBefore = (await facts(t.w)).map((f) => f.kind);
      // GitHub tells us about the merge commit (the delivery the sync causes), while the round is running.
      const ctx = { accountId: t.a.accountId, installationId: "unused", repoId: t.a.repoId, repo: { accountId: t.a.accountId, repoId: t.a.repoId, ghRepoId: 1, fullName: "acme/widgets" }, deliveryId: `d-${randomUUID()}` } as unknown as ApplyEventCtx;
      const applied = await withTenant(writerPool, t.a.accountId, (client) => applyMappedEvent(client, ctx, { kind: "record_pr_push", prNumber: PR, headSha: MERGE, linkedIssueNumber: t.n, trust: "trusted", isFork: false } as never));
      expect(applied).toMatchObject({ applied: "pr_push_recorded", workItemId: t.w, recorded: true });
      // One new fact (the push); no run, no review, no stage change; the round the sync started is still the only live one.
      expect(await runs(t.w)).toBe(runsBefore);
      expect((await facts(t.w)).map((f) => f.kind)).toEqual([...kindsBefore, "pr_head_pushed"]);
      expect(await liveRuns(t.w)).toBe(1);
      expect(await stageOf(t.w)).toBe("changes_requested");
      // And a second round asked for while the first runs is refused by the one-live-executor rule, whatever the webhook said.
      expect(await h.module.advanceStartFix(who(t), { ...fixReq(t), headSha: MERGE })).toEqual({ ok: false, reason: "already_running" });
    });
  });
});
