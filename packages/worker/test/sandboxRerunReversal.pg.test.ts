import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { writeReceipt, writeReversalReceipt } from "@fx/db/src/receiptWriter.js";
import { insertCompensation } from "@fx/db/src/reversalCompensation.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { plannedFixture } from "@fx/db/test/helpers/plannedChildren.js";
import { createInstallationHttp, InstallationTokenCache, type AccessTokenRequester } from "@fx/github";
import { insertAgentRun, writeRunStatus, type CancelResult, type ExecutionRun, type ExecutionTargetRegistry } from "@fx/runner";
import { findPullRequestForItem, loadReviewContext, type GitHubHttp } from "@fx/pipeline";
import { startBuildForItem } from "@fx/pipeline/testing/build";
import type { PullsHttp } from "@fx/receipts";
import { startPullsFake, type PullsFake } from "../../receipts/test/helpers/pullsGithubFake.js";
import { createAdvanceModule } from "../src/advance.js";
import type { RunStarter } from "../src/preview.js";
import type { SeatResult } from "../src/seat.js";
import { runReversalCompensations, type ReversalGitOpeners } from "../src/reversalCompensate.js";

/**
 * [pg] SANDBOX-RERUN-BRANCH-b, criteria 1, 3, 4 and 5 end to end: a sandbox item built on its fixed branch with an open pull request, a reversal asked by a person, the pull request closed, the item at Needs a
 * person, Build again filed and started (the real build step, the real step key), a new run on `fx/<run id>-g1`, its pull request found by the review's real context and lookup, and the ORIGINAL branch still on
 * the fake GitHub at its original head. The fake GitHub refuses a push to an existing name and any ref update or delete on the original (422, recorded in `refused`), over real TLS through the real installation
 * client; the test fails if the rebuild's prompt, the reversal's ports or the fake's log show one. Real Postgres, the real reversal step. What a fake cannot show: a sandbox actually running the prompt's push line.
 */
const LOGIN = "fx_sandbox_rerun_reversal_test";
const SHA = "a".repeat(40);
const RUN2_HEAD = "c".repeat(40);
const LATER = () => new Date(Date.now() + 400 * 86_400_000);
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

describe("a sandbox reversal's re-run keeps the original branch [pg]", { timeout: 120_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let receiptPool: Pool;
  let writerPool: Pool;
  let appPool: Pool;
  let privateKeyPem: string;
  const servers: PullsFake[] = [];

  beforeAll(async () => {
    privateKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey as unknown as string;
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${LOGIN}') THEN CREATE ROLE ${LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${LOGIN}`);
    const u = new URL(process.env.WORKER_DATABASE_URL_APP_USER!);
    u.username = LOGIN;
    u.password = "";
    receiptPool = createPool(u.toString());
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, receiptPool, writerPool, appPool]) await p.end();
  });

  interface World { t: SeedRefs; itemId: string; name: string; branch: string; compensationId: string; pf: PullsFake; git: ReversalGitOpeners; http: () => Promise<GitHubHttp> }

  const requester: AccessTokenRequester = async (p) => ({ token: "ghs_faketoken", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: { metadata: "read", ...(p.permissions as Record<string, string>) }, ...(p.repositories ? { repositories: p.repositories } : {}) });

  /** A sandbox-built item at pr_opened: run 1 pushed `branch` (recorded as `build.branch`), its pull request 7 is open at SHA on the fake, and one pending re-run row for a person's reversal. */
  async function world(o: { actor?: "person" | "policy"; child?: { parent: string } } = {}): Promise<World> {
    let t: SeedRefs;
    let itemId: string;
    let branch = "fx/issue-41";
    if (o.child) {
      const f = await plannedFixture(admin, appPool, { dial: null, weeklyUsd: null });
      t = f.t;
      itemId = f.kids.api!;
      await admin.query("UPDATE work_items SET gh_number = 41 WHERE id = $1", [f.parent]);
      await admin.query("UPDATE work_items SET stage = 'pr_opened' WHERE id = $1", [itemId]);
      branch = "fx/41-api";
    } else {
      t = await seedAccount(admin, randomUUID());
      itemId = randomUUID();
      await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'bug', 'internal', 'pr_opened', 41)", [itemId, t.accountId, t.repoId]);
      const d = randomUUID();
      await admin.query("INSERT INTO discussions (id, account_id, number, kind, title, root_work_item_id, provenance, created_by_kind) VALUES ($1, $2, 41, 'bug', 't', $3, 'internal', 'user')", [d, t.accountId, itemId]);
      await admin.query("UPDATE work_items SET discussion_id = $1 WHERE id = $2", [d, itemId]);
      await admin.query("INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, frontmatter, created_by_kind) VALUES ($1, $2, 1, 'spec', encode(sha256(convert_to('spec', 'UTF8')), 'hex'), $3::jsonb, 'system')", [t.accountId, itemId, JSON.stringify({ acceptance_files: ["src/a.ts"] })]);
    }
    const name = `widgets-${t.repoId.slice(0, 8)}`;
    await admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = $2, execution_mode = 'sandbox' WHERE id = $1", [t.repoId, name]);
    await admin.query("UPDATE account_members SET role = 'owner' WHERE account_id = $1 AND user_id = $2", [t.accountId, t.userId]);
    const runId = randomUUID();
    await admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, envelope) VALUES ($1, $2, $3, 'executor', 'production', 'succeeded', $4::jsonb)", [runId, t.accountId, itemId, JSON.stringify({ pr_number: "7", publish: { private_head: SHA } })]);
    await admin.query("INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'build.branch', $3::jsonb)", [t.accountId, runId, JSON.stringify({ branch })]);
    const orig = await withTenant(receiptPool, t.accountId, t.userId, (c) => writeReceipt(c, { class: "human_over_the_loop", runId, workItemId: itemId, decisionType: "test_strategy_choice", chosen: "unit_tests", rejectedAlternative: "end_to_end_tests", dialVersion: 0, quotedInputs: [] }));
    if (orig.store !== "decision_receipts") throw new Error("expected the durable store");
    const asWho = o.actor === "policy" ? (fn: (c: PoolClient) => Promise<{ id: string }>) => withTenant(receiptPool, t.accountId, fn) : (fn: (c: PoolClient) => Promise<{ id: string }>) => withTenant(receiptPool, t.accountId, t.userId, fn);
    const rev = await asWho((c) => writeReversalReceipt(c, { reversesReceiptId: orig.id, runId, chosen: "reversed", rejectedAlternative: "reverse_refused", dialVersion: 0 }));
    const { id } = await withTenant(receiptPool, t.accountId, t.userId, (c) => insertCompensation(c, { reversalReceiptId: rev.id, kind: "rerun", state: "pending" }));

    const pf = await startPullsFake("acme", name, [{ number: 7, ref: branch, sha: SHA, state: "open" }]);
    servers.push(pf);
    pf.refs.set(branch, SHA);
    pf.protectedRefs.add(branch);
    const open = createInstallationHttp({ resolveInstallation: async () => ({ installationId: 9, appKind: "team" }), appCredentials: () => ({ appId: "app-1", privateKeyPem, webhookSecret: "unused" }), requester, cache: new InstallationTokenCache(), fetchImpl: pf.fetchImpl });
    const git: ReversalGitOpeners = {
      openPulls: async (target) => (await open("runner_pr", target)) as unknown as PullsHttp,
      openRevert: async () => {
        throw new Error("a re-run opens no revert");
      },
    };
    return { t, itemId, name, branch, compensationId: id, pf, git, http: async () => (await open("runner_pr", { repoId: t.repoId, owner: "acme", name })) as unknown as GitHubHttp };
  }

  const run = (w: World) => runReversalCompensations({ pool: receiptPool, git: w.git, warn: () => undefined, now: LATER });
  const rowOf = async (w: World) => (await admin.query("SELECT state, reason_code, pr_number FROM reversal_compensations WHERE id = $1", [w.compensationId])).rows[0];
  const stageOf = async (w: World) => (await admin.query("SELECT stage FROM work_items WHERE id = $1", [w.itemId])).rows[0].stage as string;

  /** The sandbox build step, with the starter doing what the platform's does with the input (a keyed insert that honours the chosen run id). */
  function build(w: World) {
    const started: Array<{ prompt: string; runId?: string }> = [];
    const registry = { sandbox: { cancel: async (_run: ExecutionRun): Promise<CancelResult> => ({ settled_usd: 0, released_usd: 0 }) } } as unknown as ExecutionTargetRegistry;
    const starter: RunStarter = {
      async start(input) {
        started.push(input as never);
        const known = await admin.query<{ run_id: string }>("SELECT run_id FROM agent_run_idempotency_keys WHERE account_id = $1 AND idempotency_key = $2", [input.accountId, input.idempotency!.key]);
        if (known.rows[0]) return { runId: known.rows[0].run_id };
        const { id } = await insertAgentRun(writerPool, { id: input.runId ?? randomUUID(), accountId: input.accountId, workItemId: input.workItemId, ...(input.specVersionId ? { specVersionId: input.specVersionId } : {}), role: "executor", runtime: "production", executionMode: "sandbox", dispatchRepoId: input.repoId, dispatchPrNumber: input.pr ?? null, idempotency: input.idempotency, inCreateTransaction: input.inCreateTransaction });
        await writeRunStatus(writerPool, { accountId: input.accountId, runId: id, from: "pending", to: "running" });
        return { runId: id };
      },
    };
    const m = createAdvanceModule(writerPool, { starter, resolveRunSeat: vi.fn(async () => SEAT), startAdvance: async () => undefined, triage: null, registry, build: startBuildForItem });
    return { started, again: () => m.advanceBuild({ accountId: w.t.accountId, userId: w.t.userId, workItemId: w.itemId, haltEpoch: 0 }, randomUUID()) };
  }

  it("criteria 3 and 4: the original branch is still there at its original head after the reversal, the rebuild and the review; nothing issued a ref update or a delete", async () => {
    const w = await world();
    expect(await run(w)).toEqual({ done: 1, failed: 0 });
    // The pull request was closed through the item's recorded branch (a list and a close, nothing else), and the item is at Needs a person with Build again filed.
    expect(w.pf.requests.map((r) => `${r.method} ${r.path.replace(w.name, "<repo>")}`)).toEqual(["GET /repos/acme/<repo>/pulls", "PATCH /repos/acme/<repo>/pulls/7"]);
    expect(w.pf.pulls.map((p) => p.state)).toEqual(["closed"]);
    expect(await stageOf(w)).toBe("needs_human");
    expect(await rowOf(w)).toMatchObject({ state: "done", reason_code: null, pr_number: 7 });
    expect((await admin.query("SELECT 1 FROM run_action_requests WHERE target_id = $1 AND kind = 'advance_work_item'", [w.itemId])).rowCount).toBe(1);

    // Build again (the filed action's job): a new run on a branch of its own, plainly pushed.
    const b = build(w);
    const out = (await b.again()) as { status: string; runId: string; branch: string };
    expect(out).toMatchObject({ status: "started", branch: `fx/${out.runId}-g1` });
    const prompt = b.started[0]!.prompt;
    expect(prompt).not.toMatch(/--force|checkout -B|earlier attempt at this issue may have left|git branch -D|push[^\n]*--delete|push origin :/);
    const pushes = prompt.match(/git push[^\n(]*/g) ?? [];
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain(`origin ${out.branch}`);
    expect(w.pf.push(out.branch, RUN2_HEAD)).toBe("ok");
    w.pf.pulls.push({ number: 8, ref: out.branch, sha: RUN2_HEAD, state: "open" });

    // The review finds run 2's pull request through the real context and lookup.
    const ctx = await loadReviewContext(writerPool, w.t.accountId, w.itemId);
    if (!ctx.ok) throw new Error(ctx.reason);
    expect(ctx.ctx.branch).toBe(out.branch);
    expect(await findPullRequestForItem(await w.http(), { owner: "acme", name: w.name, branch: ctx.ctx.branch, executionMode: ctx.ctx.executionMode, recordedPr: null })).toMatchObject({ ok: true, pr: { number: 8, branch: out.branch } });

    // The original is untouched, and no write that GitHub would refuse was attempted by anything.
    expect(w.pf.refs.get(w.branch)).toBe(SHA);
    expect(w.pf.refused).toEqual([]);
    expect(w.pf.requests.some((r) => r.method === "DELETE" || /\/git\/refs|\/branches\//.test(r.path))).toBe(false);
    expect(w.pf.pulls.map((p) => `${p.number}:${p.ref === w.branch ? "original" : "run2"}:${p.state}`)).toEqual(["7:original:closed", "8:run2:open"]);

    // Controls: the fake really does refuse what the old forced rebuild would have done, and a delete of the original, so the empty log above means something.
    expect(w.pf.push(w.branch, RUN2_HEAD, { force: true })).toBe("non_fast_forward");
    const del = await w.pf.fetchImpl(`https://api.github.com/repos/acme/${w.name}/git/refs/heads/${w.branch}`, { method: "DELETE", headers: { authorization: "Bearer ghs_faketoken", accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" } });
    expect(del.status).toBe(422);
    expect(w.pf.refused).toEqual([`FORCE push ${w.branch}`, `DELETE ${w.branch}`]);
    expect(w.pf.refs.get(w.branch)).toBe(SHA);
  });

  it("criterion 5: a second reversal, of run 2's pull request, closes it by run 2's recorded branch and leaves run 1's closed pull request and the original branch alone", async () => {
    const w = await world();
    await run(w);
    const b = build(w);
    const out = (await b.again()) as { runId: string; branch: string };
    w.pf.push(out.branch, RUN2_HEAD);
    w.pf.pulls.push({ number: 8, ref: out.branch, sha: RUN2_HEAD, state: "open" });
    // Run 2 finished with pull request 8: its envelope says so, as run 1's did for 7.
    await admin.query("UPDATE agent_runs SET status = 'succeeded', envelope = $2::jsonb WHERE id = $1", [out.runId, JSON.stringify({ pr_number: "8", publish: { private_head: RUN2_HEAD } })]);
    await admin.query("UPDATE work_items SET stage = 'pr_opened' WHERE id = $1", [w.itemId]);
    const second = await withTenant(receiptPool, w.t.accountId, w.t.userId, async (c) => {
      const orig = await writeReceipt(c, { class: "human_over_the_loop", runId: out.runId, workItemId: w.itemId, decisionType: "test_strategy_choice", chosen: "unit_tests", rejectedAlternative: "end_to_end_tests", dialVersion: 0, quotedInputs: [] });
      if (orig.store !== "decision_receipts") throw new Error("expected the durable store");
      const rev = await writeReversalReceipt(c, { reversesReceiptId: orig.id, runId: out.runId, chosen: "reversed", rejectedAlternative: "reverse_refused", dialVersion: 0 });
      return insertCompensation(c, { reversalReceiptId: rev.id, kind: "rerun", state: "pending" });
    });
    w.pf.requests.length = 0;
    expect(await run(w)).toEqual({ done: 1, failed: 0 });
    expect(new URLSearchParams(w.pf.requests[0]!.query).get("head")).toBe(`acme:${out.branch}`);
    expect(w.pf.requests.map((r) => r.method)).toEqual(["GET", "PATCH"]);
    expect(w.pf.pulls.map((p) => `${p.number}:${p.state}`)).toEqual(["7:closed", "8:closed"]);
    expect((await admin.query("SELECT pr_number FROM reversal_compensations WHERE id = $1", [second.id])).rows[0].pr_number).toBe(8);
    expect(w.pf.refs.get(w.branch)).toBe(SHA);
    expect(w.pf.refs.get(out.branch)).toBe(RUN2_HEAD);
    expect(w.pf.refused).toEqual([]);
  });

  it("a person's policy-recorded reversal is still refused with no_person_actor, and nothing is called", async () => {
    const w = await world({ actor: "policy" });
    await run(w);
    expect(w.pf.requests).toEqual([]);
    expect(await rowOf(w)).toMatchObject({ state: "failed", reason_code: "no_person_actor" });
  });

  it("R4 case 2: a planned PR child whose build identity does not resolve (its parent is gone) is refused rerun_would_overwrite_branch, with no GitHub call; with its parent the branch is not what refuses it", async () => {
    const orphan = await world({ child: { parent: "x" } });
    const parent = (await admin.query<{ parent_id: string }>("SELECT parent_id FROM work_items WHERE id = $1", [orphan.itemId])).rows[0]!.parent_id;
    await admin.query("DELETE FROM work_items WHERE id = $1", [parent]);
    await run(orphan);
    expect(orphan.pf.requests).toEqual([]);
    expect(await rowOf(orphan)).toMatchObject({ state: "failed", reason_code: "rerun_would_overwrite_branch" });
    expect(await stageOf(orphan)).toBe("pr_opened");

    // With its parent the child's identity resolves, so the branch refusal is not the answer. What Build again's own table says of a child (it has no issue of its own, so `no_issue`) is the existing
    // answer, given before anything is closed: rerun_refused with GitHub untouched. The branch lookup for a child is covered at the port in git-adapter.test.ts.
    const live = await world({ child: { parent: "x" } });
    await run(live);
    expect(await rowOf(live)).toMatchObject({ state: "failed", reason_code: "rerun_refused" });
    expect(live.pf.requests).toEqual([]);
    expect(live.pf.refused).toEqual([]);
  });
});
