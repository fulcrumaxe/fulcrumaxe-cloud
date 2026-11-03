import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { insertAgentRun, writeRunStatus, type CancelResult, type ExecutionRun, type ExecutionTargetRegistry, type StartAgentRunInput } from "@fx/runner";
import { createAdvanceModule, type AdvanceModuleDeps, type AdvanceReviewDeps } from "../src/advance.js";
import type { SeatResult } from "../src/seat.js";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount } from "@fx/db/test/helpers/seed.js";
import { PUBLIC_BRANCH_MOVED, readPlanePush, recordUpdatedHead } from "@fx/core/src/repos/planePushRecord.js";
import { advanceActionFor } from "@fx/core/src/work-items/advance.js";
import { REPUBLISH_BRANCH_MOVED } from "@fx/core/src/work-items/baseSync.js";
import { readBranchAnswerRound, readReviewHold } from "@fx/core/src/work-items/reviewHold.js";
import { keepBranch, releaseBranch, replaceBranch } from "@fx/core/src/setup-requests/branchPushedAnswer.js";
import { statusSentence } from "@fx/core/src/setup-requests/copy.js";
import { listSetupRequests } from "@fx/core/src/setup-requests/store.js";
import { REPLACE_ROUND_SENTENCE } from "@fx/pipeline";
import { checkPublicBranch, raiseAfterLeaseFailure, type FixRoundHeadPorts } from "../src/fixRoundHeads.js";
import { FIX_BASE_EVENT, recordRepublishRefusal } from "../src/fixRoundBase.js";

/**
 * [pg] D#598 P1g-3a: a person's Replace (and Keep), taken from the request the platform really raised, through the next fix round, to the lease push
 * on a REAL bare git remote. The earlier update tests set the authorization column directly; here the answer functions write it, the round-start check reads it,
 * and the push is `git push --force-with-lease` against the head the person was shown, so a push after the confirmation is refused by the remote itself.
 * (The product's own transport is covered by pipeline/test/build/planePushRoute.test.ts; what this adds is the chain around it.)
 */
describe("Replace and Keep, from the raised request to the lease push on a bare remote [pg]", { timeout: 120_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appUser: Pool;
  const dirs: string[] = [];
  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    appUser = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool, appUser]) await p.end();
  });
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).trim();

  /** A paired item whose pull request is open: the push row, a bare remote holding the platform's commit on the row's branch, and a work clone to make more commits. */
  async function scene(stage: string) {
    const a = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE work_items SET stage = $2 WHERE id = $1", [a.workItemId, stage]);
    await admin.query("INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, 'acme/widgets-public', $3)", [a.repoId, a.accountId, ["private/**"]]);
    const root = mkdtempSync(join(tmpdir(), "fx-replace-"));
    dirs.push(root);
    const bare = join(root, "remote.git");
    const work = join(root, "work");
    mkdirSync(work);
    git(root, "init", "-q", "--bare", "-b", "main", bare);
    git(work, "init", "-q", "-b", "main");
    writeFileSync(join(work, "base.txt"), "base\n");
    git(work, "add", "base.txt");
    git(work, "commit", "-q", "-m", "public main");
    git(work, "remote", "add", "origin", bare);
    git(work, "push", "-q", "origin", "main");
    const mainTip = git(work, "rev-parse", "HEAD");
    const { rows } = await admin.query<{ id: string; branch: string }>(
      `INSERT INTO plane_pushes (account_id, work_item_id, repo_id, code_repo, pairing_digest, head_sha, tip_sha, pr_number, pr_url, state)
       VALUES ($1, $2, $3, 'acme/widgets-public', $4, $5, $6, 7, 'https://github.com/acme/widgets-public/pull/7', 'pr_opened') RETURNING id, branch`,
      [a.accountId, a.workItemId, a.repoId, "f".repeat(64), mainTip, mainTip],
    );
    const branch = rows[0]!.branch;
    const commit = (name: string, base: string, text: string): string => {
      git(work, "checkout", "-q", "--detach", base);
      writeFileSync(join(work, `${name}.txt`), text);
      git(work, "add", `${name}.txt`);
      git(work, "commit", "-q", "-m", name);
      return git(work, "rev-parse", "HEAD");
    };
    // The platform's own push: one commit on the public tip, on the row's branch.
    const platform = commit("platform", mainTip, "the item\n");
    git(work, "push", "-q", "origin", `${platform}:refs/heads/${branch}`);
    await admin.query("UPDATE plane_pushes SET head_sha = $2 WHERE id = $1", [rows[0]!.id, platform]);
    const head = () => {
      try {
        return git(bare, "rev-parse", "--verify", "-q", `refs/heads/${branch}`);
      } catch {
        return null;
      }
    };
    const ports = { publicHead: async () => head() };
    /** A person pushes on top of whatever is there. */
    const personPushes = (name: string): string => {
      const sha = commit(name, head()!, `theirs ${name}\n`);
      git(work, "push", "-q", "origin", `${sha}:refs/heads/${branch}`);
      return sha;
    };
    /** The round's publish: ONE commit on the public tip, pushed with the lease on the head the record says to replace (what the push route does). Throws when the remote refuses. */
    const leasePush = (lease: string): string => {
      const next = commit("round", mainTip, "the item, updated\n");
      git(work, "push", "-q", `--force-with-lease=refs/heads/${branch}:${lease}`, "origin", `${next}:refs/heads/${branch}`);
      return next;
    };
    return { a, ports, platform, mainTip, head, personPushes, leasePush, pushId: rows[0]!.id };
  }
  type Scene = Awaited<ReturnType<typeof scene>>;

  const who = (s: Scene) => ({ accountId: s.a.accountId, workItemId: s.a.workItemId });
  const check = (s: Scene) => checkPublicBranch(writerPool, s.ports, who(s));
  const row = (s: Scene) => withTenant(writerPool, s.a.accountId, (c) => readPlanePush(c, s.a.accountId, s.a.workItemId));
  const openRequest = async (s: Scene) => (await admin.query<{ id: string; seen_head: string }>("SELECT id, seen_head FROM setup_requests WHERE work_item_id = $1 AND kind = 'branch_pushed_by_person' AND state = 'open'", [s.a.workItemId])).rows;
  const personArgs = (s: Scene, id: string) => ({ accountId: s.a.accountId, userId: s.a.userId, id });
  const actionAt = async (s: Scene, stage: string) =>
    advanceActionFor({ stage, discussion_id: randomUUID(), kind: "feature", has_spec: true, no_verdict_hold: stage === "needs_human" ? await withTenant(writerPool, s.a.accountId, (c: PoolClient) => readReviewHold(c, s.a.workItemId)) : false });

  it("raised at round start, stage changes_requested: Replace resumes the review, the next round passes the start check and its lease push replaces their commit; the authorization is then spent", async () => {
    const s = await scene("changes_requested");
    const theirs = s.personPushes("one");
    expect(await check(s)).toBe(PUBLIC_BRANCH_MOVED);
    const [req] = await openRequest(s);
    expect(req!.seen_head).toBe(theirs);
    await replaceBranch({ pool: appUser }, { ...personArgs(s, req!.id), shownHead: theirs });
    expect(await actionAt(s, "changes_requested")).toEqual({ ok: true, action: "review" });
    expect(await check(s)).toBeNull();
    const authorized = (await row(s))!.replaceAuthorizedHead!;
    expect(authorized).toBe(theirs);
    const next = s.leasePush(authorized);
    expect(s.head()).toBe(next);
    await withTenant(writerPool, s.a.accountId, (c) => recordUpdatedHead(c, { accountId: s.a.accountId, id: s.pushId, headSha: next, tipSha: s.mainTip, sourceHead: null }));
    expect(await row(s)).toMatchObject({ state: "pr_opened", headSha: next, replaceAuthorizedHead: null });
    expect(await check(s)).toBeNull();
    expect(await openRequest(s)).toEqual([]);
  });

  it("a push after the confirmation: the start check asks again and, if it were skipped, the remote refuses the lease and keeps the newer commit", async () => {
    const s = await scene("changes_requested");
    const first = s.personPushes("one");
    await check(s);
    const [req] = await openRequest(s);
    await replaceBranch({ pool: appUser }, { ...personArgs(s, req!.id), shownHead: first });
    const second = s.personPushes("two");
    expect(() => s.leasePush(first)).toThrow();
    expect(s.head()).toBe(second);
    expect(await check(s)).toBe(PUBLIC_BRANCH_MOVED);
    expect(await openRequest(s)).toMatchObject([{ seen_head: second }]);
    expect((await row(s))!.replaceAuthorizedHead).toBeNull();
  });

  it("Keep after Replace, before the round: the authorization is gone, the round start passes without reading the branch, and the platform has no public copy to update", async () => {
    const s = await scene("changes_requested");
    const theirs = s.personPushes("one");
    await check(s);
    const [req] = await openRequest(s);
    await replaceBranch({ pool: appUser }, { ...personArgs(s, req!.id), shownHead: theirs });
    const kept = await keepBranch({ pool: appUser }, personArgs(s, req!.id));
    expect(kept.changed).toBe(true);
    expect(await row(s)).toMatchObject({ state: "managed_by_person", replaceAuthorizedHead: null });
    let reads = 0;
    expect(await checkPublicBranch(writerPool, { publicHead: async () => (reads++, s.head()) }, who(s))).toBeNull();
    expect(reads).toBe(0);
    expect(s.head()).toBe(theirs);
  });

  it("Keep while a round already holds the lease on their head: the push still lands, the update is recorded with the new head, the managed line says their commit was replaced, and the undo asks nobody", async () => {
    const s = await scene("changes_requested");
    const theirs = s.personPushes("one");
    await check(s);
    const [req] = await openRequest(s);
    await replaceBranch({ pool: appUser }, { ...personArgs(s, req!.id), shownHead: theirs });
    // The round starts: the start check passes and the lease is taken on the head the person was shown.
    expect(await check(s)).toBeNull();
    const lease = (await row(s))!.replaceAuthorizedHead!;
    // Keep arrives while the round runs; the round does not look again and its push succeeds against the lease.
    await keepBranch({ pool: appUser }, personArgs(s, req!.id));
    const next = s.leasePush(lease);
    expect(s.head()).toBe(next);
    const landed = await withTenant(writerPool, s.a.accountId, (c) => recordUpdatedHead(c, { accountId: s.a.accountId, id: s.pushId, headSha: next, tipSha: s.mainTip, sourceHead: null }));
    expect(landed).not.toBeNull();
    // Keep's managed state stands; the record holds the head that is really on the branch.
    expect(await row(s)).toMatchObject({ state: "managed_by_person", headSha: next });
    expect((await row(s))!.managedByPersonAt).not.toBeNull();
    const listed = await withTenant(appUser, s.a.accountId, (c) => listSetupRequests(c, { state: "needs_you" }));
    const [line] = listed.requests;
    expect(line).toMatchObject({ id: req!.id, branchManaged: true });
    const said = statusSentence(line!, { checksAvailable: false })!;
    expect(said).toContain("before your Keep was seen");
    expect(said).toContain(theirs.slice(0, 7));
    expect(said).toContain(next.slice(0, 7));
    expect(said).toContain("pull request");
    expect(line!.reason).not.toContain("Nothing was overwritten");
    // The undo: the branch is where the record says it is, so nobody is asked and the cloud's own commit is not called theirs.
    expect(await releaseBranch({ pool: appUser }, { accountId: s.a.accountId, userId: s.a.userId, workItemId: s.a.workItemId })).toBe(true);
    expect(await check(s)).toBeNull();
    expect(await openRequest(s)).toEqual([]);
    expect(await row(s)).toMatchObject({ state: "pr_opened", headSha: next, keptHead: null, keptReplacedAt: null });
  });

  describe("raised by a lease failure, so the item is at Needs a person", () => {
    /** The round finished, its update was refused at the push (the lease failed): the refusal moves the item to Needs a person and the request is raised from the branch as it is. */
    async function leaseFailure() {
      const s = await scene("changes_requested");
      const theirs = s.personPushes("one");
      await withTenant(writerPool, s.a.accountId, (c) => recordRepublishRefusal(c, who(s), { code: REPUBLISH_BRANCH_MOVED, prNumber: null, moveToNeedsPerson: true, attempt: randomUUID() }));
      await raiseAfterLeaseFailure(writerPool, s.ports.publicHead, who(s));
      const [req] = await openRequest(s);
      expect(req!.seen_head).toBe(theirs);
      expect((await admin.query("SELECT stage FROM work_items WHERE id = $1", [s.a.workItemId])).rows[0].stage).toBe("needs_human");
      return { s, theirs, req: req! };
    }

    it("Replace authorizes the head shown and the round start would pass (the data side of the answer works on this path)", async () => {
      const { s, theirs, req } = await leaseFailure();
      await replaceBranch({ pool: appUser }, { ...personArgs(s, req.id), shownHead: theirs });
      expect(await check(s)).toBeNull();
      expect((await row(s))!.replaceAuthorizedHead).toBe(theirs);
    });

    // The answer files `advance_work_item`; at Needs a person it resolves to `review` when the answer is the one this stop is waiting for (`readReviewHold` counts it), and the
    // derived trigger (`readBranchAnswerRound`, carried to the driver by `loadReviewContext`) is what starts ONE fix round there (leaseAnswerRound.pg.test.ts runs that round).
    const trigger = async (s: Scene) => withTenant(writerPool, s.a.accountId, (c: PoolClient) => readBranchAnswerRound(c, s.a.workItemId));

    it("before any answer the stop is a rebuild and the trigger is off: an open request is not an answer", async () => {
      const { s } = await leaseFailure();
      expect(await trigger(s)).toBe(false);
      expect(await actionAt(s, "needs_human")).toEqual({ ok: true, action: "rebuild" });
    });

    it("Replace resumes through the trigger: the action is review and the trigger is on (it is a fix round, not a bare review)", async () => {
      const { s, theirs, req } = await leaseFailure();
      await replaceBranch({ pool: appUser }, { ...personArgs(s, req.id), shownHead: theirs });
      expect(await trigger(s)).toBe(true);
      expect(await actionAt(s, "needs_human")).toEqual({ ok: true, action: "review" });
    });

    it("Keep resumes with a plain review: the action is review and the round trigger is OFF (nothing can publish to their branch, so a paid round would do nothing)", async () => {
      const { s, req } = await leaseFailure();
      await keepBranch({ pool: appUser }, personArgs(s, req.id));
      expect(await trigger(s)).toBe(false);
      expect(await actionAt(s, "needs_human")).toEqual({ ok: true, action: "review" });
    });

    it("a withdrawn request is not an answer: back to a rebuild", async () => {
      const { s, req } = await leaseFailure();
      await admin.query("UPDATE setup_requests SET state = 'withdrawn', resolution = 'withdrawn', resolved_by = $2, resolved_at = now() WHERE id = $1", [req.id, s.a.userId]);
      expect(await trigger(s)).toBe(false);
      expect(await actionAt(s, "needs_human")).toEqual({ ok: true, action: "rebuild" });
    });

    it("Keep undone ends the answer: the stop is a rebuild again", async () => {
      const { s, req } = await leaseFailure();
      await keepBranch({ pool: appUser }, personArgs(s, req.id));
      expect(await actionAt(s, "needs_human")).toEqual({ ok: true, action: "review" });
      await admin.query("UPDATE account_members SET role = 'owner' WHERE account_id = $1 AND user_id = $2", [s.a.accountId, s.a.userId]);
      await releaseBranch({ pool: appUser }, { accountId: s.a.accountId, userId: s.a.userId, workItemId: s.a.workItemId });
      expect(await trigger(s)).toBe(false);
      expect(await actionAt(s, "needs_human")).toEqual({ ok: true, action: "rebuild" });
    });

    it("an answer given before the stop is not this stop's answer: a later lease failure needs its own", async () => {
      const { s, theirs, req } = await leaseFailure();
      await replaceBranch({ pool: appUser }, { ...personArgs(s, req.id), shownHead: theirs });
      expect(await trigger(s)).toBe(true);
      // The round was refused again (a new stop at Needs a person): the old answer does not count for it.
      await admin.query("UPDATE work_items SET stage = 'changes_requested' WHERE id = $1", [s.a.workItemId]);
      await withTenant(writerPool, s.a.accountId, (c) => recordRepublishRefusal(c, who(s), { code: REPUBLISH_BRANCH_MOVED, prNumber: null, moveToNeedsPerson: true, attempt: randomUUID() }));
      expect(await trigger(s)).toBe(false);
    });
  });

  /**
   * The same stop, through the REAL round start: the web app's production review load (the derived trigger travels through every layer), the web step that builds the
   * prompt, and the worker's `advanceStartFix` with its stage rule, public-branch check, base sync and republish record. Only the executor is a stand-in (its resume writes the
   * keyed run row), and the publish is the real `git push --force-with-lease` the push route makes, against the bare remote.
   */
  describe("one fix round from the answer, through the real round start", () => {
    const BASE = "e".repeat(40);
    const PRIVATE_HEAD = "a".repeat(40);
    let web: { createReviewDeps: () => AdvanceReviewDeps };
    let steps: {
      reviewLoadBody: (worker: unknown, who: unknown, pinned: number | null) => Promise<Record<string, unknown> & { ok: boolean }>;
      startFixBody: (worker: unknown, who: unknown, ctx: unknown, pr: unknown, actionId: string, round: number, failing: ReadonlyArray<{ role: string; runId: string }>, retry?: number, spendAttempt?: number, person?: boolean) => Promise<{ ok: boolean; runId: string | null; reason: string | null }>;
    };
    beforeAll(async () => {
      const lib = (file: string) => fileURLToPath(new URL(`../../../apps/web/lib/${file}`, import.meta.url));
      web = (await import(/* @vite-ignore */ lib("advanceReview.ts"))) as typeof web;
      steps = (await import(/* @vite-ignore */ lib("advanceReviewSteps.ts"))) as typeof steps;
    });

    const SEAT: SeatResult = {
      ok: true,
      seat: { repoId: "unused", product: "team", roleCard: "card", model: "haiku-4.5", capUsd: 5, spend: { plan: "starter", purpose: "run", trigger: "foreground", estimateModelUsd: 5, estimateComputeUsd: 0.5, monthlyModelBudgetUsd: 1000, perSpawnCapUsd: 5 }, limits: { maxRunMs: 30 * 60_000, maxTurns: 100, maxModelCalls: 300, meteringSilenceMs: 15 * 60_000 }, timeoutMs: 40 * 60_000, maxExtensions: 3 } as never,
    };
    const registry = { sandbox: { cancel: async (_run: ExecutionRun): Promise<CancelResult> => ({ settled_usd: 0, released_usd: 0 }) } } as unknown as ExecutionTargetRegistry;

    /** The scene of a paired sandbox item with a finished build session, whose fix round the lease failure refused. */
    async function roundScene(stage: string) {
      const s = await scene(stage);
      const { accountId, userId, workItemId, repoId } = s.a;
      await admin.query("UPDATE agent_runs SET status = 'cancelled' WHERE account_id = $1 AND status IN ('pending', 'running')", [accountId]);
      await admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets', execution_mode = 'sandbox' WHERE id = $1", [repoId]);
      await admin.query("UPDATE account_members SET role = 'owner' WHERE account_id = $1 AND user_id = $2", [accountId, userId]);
      await admin.query("UPDATE work_items SET provenance = 'internal', gh_number = 77 WHERE id = $1", [workItemId]);
      const d = randomUUID();
      await admin.query("INSERT INTO discussions (id, account_id, number, kind, title, root_work_item_id, provenance, created_by_kind) VALUES ($1, $2, 4402, 'feature', 't', $3, 'internal', 'user')", [d, accountId, workItemId]);
      await admin.query("UPDATE work_items SET discussion_id = $1 WHERE id = $2", [d, workItemId]);
      const spec = await admin.query<{ id: string }>("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, 'spec', encode(sha256(convert_to('spec', 'UTF8')), 'hex'), 'system') RETURNING id", [accountId, workItemId]);
      const { id: build } = await insertAgentRun(writerPool, { id: randomUUID(), accountId, workItemId, specVersionId: spec.rows[0]!.id, role: "executor", runtime: "production", executionMode: "sandbox", dispatchRepoId: repoId });
      await writeRunStatus(writerPool, { accountId, runId: build, from: "pending", to: "running" });
      await writeRunStatus(writerPool, { accountId, runId: build, from: "running", to: "succeeded", result: { sessionId: "cc-session-1", envelope: { summary: "built" } } });
      const resume = vi.fn(async (_pool: Pool, _registry: ExecutionTargetRegistry, input: StartAgentRunInput) => {
        const { id } = await insertAgentRun(writerPool, { id: randomUUID(), accountId: input.accountId, workItemId: input.workItemId, parentRunId: input.parentRunId, specParentRunId: input.parentRunId ?? null, role: "executor", runtime: "production", executionMode: "sandbox", dispatchRepoId: input.repoId, dispatchPrNumber: input.pr ?? null, idempotency: input.idempotency, startPrompt: input.prompt, inCreateTransaction: input.inCreateTransaction });
        await writeRunStatus(writerPool, { accountId: input.accountId, runId: id, from: "pending", to: "running" });
        return { id, status: "running" };
      });
      const heads: FixRoundHeadPorts = { publicHead: s.ports.publicHead, privateHead: async () => PRIVATE_HEAD, syncBase: async () => ({ kind: "up_to_date", baseSha: BASE, baseRef: "main", stacked: false }) };
      const deps: AdvanceModuleDeps = { starter: { async start() { throw new Error("a same-side round never starts a fresh session"); } }, resolveRunSeat: vi.fn(async () => SEAT), startAdvance: async () => undefined, triage: null, registry, review: { ...web.createReviewDeps(), resume } as never, fixHeads: heads };
      const module = createAdvanceModule(writerPool, deps);
      const stepWho = { accountId, userId, workItemId, haltEpoch: 0 };
      /** What the workflow does for the answered stop: load the review (the trigger arrives with it), then ask for the person's round. `round` is the 1-based round asked. */
      const load = () => steps.reviewLoadBody(module, stepWho, null);
      const ask = async (round = 2, actionId: string = randomUUID()) => { const loaded = await load(); return steps.startFixBody(module, stepWho, loaded.branchAnswerPending === true ? { ...loaded, replaceRound: true } : loaded, { number: 7, headSha: PRIVATE_HEAD, branch: "fx/issue-77" }, actionId, round, [], 0, 0, true); };
      const stageNow = async () => (await admin.query<{ stage: string }>("SELECT stage FROM work_items WHERE id = $1", [workItemId])).rows[0]!.stage;
      const startedRounds = async () => Number((await admin.query<{ n: string }>("SELECT count(*) AS n FROM work_item_driver_events WHERE work_item_id = $1 AND kind = 'fix_round_started'", [workItemId])).rows[0]!.n);
      const republishBases = async () => Number((await admin.query<{ n: string }>("SELECT count(*) AS n FROM run_events WHERE account_id = $1 AND kind = $2", [accountId, FIX_BASE_EVENT])).rows[0]!.n);
      return { s, load, ask, stageNow, startedRounds, republishBases };
    }
    type RoundScene = Awaited<ReturnType<typeof roundScene>>;

    /** A person pushes during the round, so the round's own update meets a branch it did not leave: the lease fails at the remote, the refusal moves the item, the request is raised. */
    async function leaseFails(h: RoundScene) {
      const theirs = h.s.personPushes("one");
      expect(() => h.s.leasePush(h.s.platform)).toThrow();
      await withTenant(writerPool, h.s.a.accountId, (c) => recordRepublishRefusal(c, who(h.s), { code: REPUBLISH_BRANCH_MOVED, prNumber: null, moveToNeedsPerson: true, attempt: randomUUID() }));
      await raiseAfterLeaseFailure(writerPool, h.s.ports.publicHead, who(h.s));
      const [req] = await openRequest(h.s);
      expect(req!.seen_head).toBe(theirs);
      expect(await h.stageNow()).toBe("needs_human");
      return { theirs, req: req! };
    }
    const pending = async (h: RoundScene) => (await h.load()).branchAnswerPending === true;

    it("Replace: ONE round is started from the answer, its update lands with the lease on the authorized head, and that spends the authorization", async () => {
      const h = await roundScene("changes_requested");
      const { theirs, req } = await leaseFails(h);
      // Nothing is answered yet: the open request holds the item, so the load refuses and no round can be asked for.
      expect(await h.load()).toMatchObject({ ok: false, reason: "setup_request_open" });
      const marked = await replaceBranch({ pool: appUser }, { ...personArgs(h.s, req.id), shownHead: theirs });
      expect(marked.restart).not.toBeNull();
      expect(await pending(h)).toBe(true);
      const started = await h.ask();
      expect(started, String(started.reason)).toMatchObject({ ok: true });
      // The prompt is the fixed Replace sentence: no person, no note, no finding, nothing from the request or the commits.
      const prompt = (await admin.query<{ payload: { prompt: string } }>("SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'run.input'", [started.runId])).rows[0]!.payload.prompt;
      expect(prompt).toContain(REPLACE_ROUND_SENTENCE);
      expect(prompt).toContain("An earlier fix round finished on pull request");
      expect(prompt).not.toMatch(/person who owns|asked for changes|their note|the notes after|REVIEWER FINDINGS/);
      expect(prompt).not.toContain(theirs);
      expect(await h.stageNow()).toBe("changes_requested");
      expect(await h.startedRounds()).toBe(1);
      // Signed with the base the round was synced with, so the update can be made at its end.
      expect(await h.republishBases()).toBe(1);
      // One round: the trigger is spent, and a repeat of the answer files nothing.
      expect(await pending(h)).toBe(false);
      const again = await replaceBranch({ pool: appUser }, { ...personArgs(h.s, req.id), shownHead: theirs });
      expect(again).toMatchObject({ changed: false, restart: null });
      expect(await h.startedRounds()).toBe(1);
      // The round's update: the lease is on the head the person was shown, the remote takes it, and the record spends the authorization.
      const authorized = (await row(h.s))!.replaceAuthorizedHead!;
      expect(authorized).toBe(theirs);
      const next = h.s.leasePush(authorized);
      expect(h.s.head()).toBe(next);
      await withTenant(writerPool, h.s.a.accountId, (c) => recordUpdatedHead(c, { accountId: h.s.a.accountId, id: h.s.pushId, headSha: next, tipSha: h.s.mainTip, sourceHead: null }));
      expect(await row(h.s)).toMatchObject({ state: "pr_opened", headSha: next, replaceAuthorizedHead: null });
      expect(await openRequest(h.s)).toEqual([]);
    });

    it("a replay of the same press finds the same round and starts no second", async () => {
      const h = await roundScene("changes_requested");
      const { theirs, req } = await leaseFails(h);
      await replaceBranch({ pool: appUser }, { ...personArgs(h.s, req.id), shownHead: theirs });
      const action = randomUUID();
      const first = await h.ask(2, action);
      expect(first.ok).toBe(true);
      // The workflow was replayed after the stage had already moved: the keyed run is found, not repeated.
      const second = await h.ask(2, action);
      expect(second.runId).toBe(first.runId);
      expect(await h.startedRounds()).toBe(1);
    });

    it("a person pushes after the confirmation: the round is refused, the remote refuses the lease, the request is raised again and no round is waiting", async () => {
      const h = await roundScene("changes_requested");
      const { theirs, req } = await leaseFails(h);
      await replaceBranch({ pool: appUser }, { ...personArgs(h.s, req.id), shownHead: theirs });
      const second = h.s.personPushes("two");
      expect(await h.ask()).toMatchObject({ ok: false, reason: PUBLIC_BRANCH_MOVED });
      expect(() => h.s.leasePush(theirs)).toThrow();
      expect(h.s.head()).toBe(second);
      expect(await h.stageNow()).toBe("needs_human");
      expect(await h.startedRounds()).toBe(0);
      expect((await row(h.s))!.replaceAuthorizedHead).toBeNull();
      expect(await openRequest(h.s)).toMatchObject([{ seen_head: second }]);
      // The old answer does not start a round for the new question.
      expect(await pending(h)).toBe(false);
    });

    it("Keep: a plain review, no executor round: nothing is started, nothing is published, their commit stays, and the review's merge gate stops for a person", async () => {
      const h = await roundScene("changes_requested");
      const { theirs, req } = await leaseFails(h);
      await keepBranch({ pool: appUser }, personArgs(h.s, req.id));
      // The stage table says review (the private change already exists), the load does NOT ask for a round, and a round asked for anyway is refused where it stands.
      expect(await actionAt(h.s, "needs_human")).toEqual({ ok: true, action: "review" });
      expect(await pending(h)).toBe(false);
      expect(await h.ask()).toMatchObject({ ok: false, reason: "stage_needs_human" });
      expect(await h.startedRounds()).toBe(0);
      expect(await h.republishBases()).toBe(0);
      expect(await row(h.s)).toMatchObject({ state: "managed_by_person", replaceAuthorizedHead: null });
      expect(h.s.head()).toBe(theirs);
      // After the review passes the merge gate answers `public_branch_person_managed` with no status (mergeGatePairedLocal.pg.test.ts): ready, a person merges.
    });

    it("Replace and Keep pressed together: Keep wins whichever comes first, no round is started and nothing is overwritten", async () => {
      const h = await roundScene("changes_requested");
      const { theirs, req } = await leaseFails(h);
      await Promise.allSettled([replaceBranch({ pool: appUser }, { ...personArgs(h.s, req.id), shownHead: theirs }), keepBranch({ pool: appUser }, personArgs(h.s, req.id))]);
      expect(await row(h.s)).toMatchObject({ state: "managed_by_person", replaceAuthorizedHead: null });
      expect(await pending(h)).toBe(false);
      expect(await h.ask()).toMatchObject({ ok: false, reason: "stage_needs_human" });
      expect(await h.startedRounds()).toBe(0);
      expect(await h.republishBases()).toBe(0);
      expect(h.s.head()).toBe(theirs);
      const restarts = await admin.query("SELECT 1 FROM run_action_requests WHERE target_id = $1 AND kind = 'advance_work_item'", [h.s.a.workItemId]);
      expect(restarts.rowCount).toBeLessThanOrEqual(1);
    });

    it("the fix-round cap: a round past it is refused where it stands, nothing is written, the item stays at Needs a person and the answer stays waiting", async () => {
      const h = await roundScene("changes_requested");
      const { theirs, req } = await leaseFails(h);
      await replaceBranch({ pool: appUser }, { ...personArgs(h.s, req.id), shownHead: theirs });
      expect(await h.ask(20)).toMatchObject({ ok: false, reason: "max_fix_rounds" });
      expect(await h.stageNow()).toBe("needs_human");
      expect(await h.startedRounds()).toBe(0);
      expect(await pending(h)).toBe(true);
      expect((await row(h.s))!.replaceAuthorizedHead).toBe(theirs);
      expect(h.s.head()).toBe(theirs);
    });

    it("a repeated Approve at the cap writes nothing and spends nothing", async () => {
      const h = await roundScene("changes_requested");
      const { theirs, req } = await leaseFails(h);
      await replaceBranch({ pool: appUser }, { ...personArgs(h.s, req.id), shownHead: theirs });
      const counts = async () => (await admin.query("SELECT (SELECT count(*) FROM work_item_driver_events WHERE work_item_id = $1) AS ev, (SELECT count(*) FROM agent_runs WHERE work_item_id = $1) AS runs, (SELECT count(*) FROM setup_requests WHERE work_item_id = $1) AS reqs, (SELECT count(*) FROM work_item_transitions WHERE work_item_id = $1) AS tr", [h.s.a.workItemId])).rows[0];
      expect(await h.ask(20)).toMatchObject({ ok: false, reason: "max_fix_rounds" });
      const before = await counts();
      for (let i = 0; i < 3; i++) expect(await h.ask(20)).toMatchObject({ ok: false, reason: "max_fix_rounds" });
      expect(await counts()).toEqual(before);
      expect(await h.stageNow()).toBe("needs_human");
      expect(await pending(h)).toBe(true);
      expect((await row(h.s))!.replaceAuthorizedHead).toBe(theirs);
      expect(await openRequest(h.s)).toEqual([]);
      expect(h.s.head()).toBe(theirs);
    });
  });
});
