import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { writeReceipt, writeReversalReceipt } from "@fx/db/src/receiptWriter.js";
import { insertCompensation, COMPENSATION_MAX_ATTEMPTS } from "@fx/db/src/reversalCompensation.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { applyMappedEvent, createInstallationHttp, InstallationTokenCache, type AccessTokenRequester, type InstallationHttp } from "@fx/github";
import type { PullsHttp } from "@fx/receipts";
import { ghError } from "../../github/test/helpers/strictGithub.js";
import { startRevertFake, type RevertFake } from "../../github/test/helpers/revertGithubFake.js";
import { startPullsFake, type PullsFake } from "../../receipts/test/helpers/pullsGithubFake.js";
import { runAskWindowTick } from "../src/askWindowTick.js";
import { reconcileHolder } from "../src/prSlotReconcile.js";
import { runReversalCompensations, type ReversalCompensateDeps, type ReversalGitOpeners } from "../src/reversalCompensate.js";

/**
 * [pg] D#7 DP7-2d, the worker step on real Postgres: claim, plan from the build state as it is now, the real GitPort over the REAL installation clients
 * and token minter against strict HTTPS fakes of GitHub (real TLS through Node's connection path, a bearer token, a User-Agent), the move to Needs a
 * person and Build again in the person's name, and the finish. The webhook race is run through the real `applyMappedEvent`.
 * What cannot be faked: GitHub's revert-conflict detection (declared by the fake), the delay before GitHub sends the closed delivery, rate limits.
 */
const LOGIN = "fx_reversal_compensate_test";
const SHA = "a".repeat(40);
const LATER = () => new Date(Date.now() + 400 * 86_400_000); // past every receipt's free window

describe("reversal compensation worker step [pg]", { timeout: 120_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let receiptPool: Pool;
  let appPool: Pool;
  let privateKeyPem: string;
  const servers: Array<PullsFake | RevertFake> = [];

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
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, receiptPool, appPool]) await p.end();
  });

  interface Item extends SeedRefs { itemId: string; branch: string; compensationId: string; name: string }

  /** A runner-built item at `stage` whose run's `done` recorded pull request 7 on `fx/<run>-g1` at SHA, and one pending re-run row for its reversal. */
  async function seed(o: { stage?: string; mode?: string; actor?: "person" | "policy"; repo?: boolean } = {}): Promise<Item> {
    const t = await seedAccount(admin, randomUUID());
    const name = `widgets-${t.repoId.slice(0, 8)}`;
    await admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = $2, execution_mode = $3 WHERE id = $1", [t.repoId, o.repo === false ? null : name, o.mode ?? "runner_local"]);
    const itemId = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'bug', 'internal', $4, 41)`, [itemId, t.accountId, t.repoId, o.stage ?? "pr_opened"]);
    const discussion = randomUUID();
    await admin.query(`INSERT INTO discussions (id, account_id, number, kind, title, root_work_item_id, provenance, created_by_kind) VALUES ($1, $2, 41, 'bug', 't', $3, 'internal', 'user')`, [discussion, t.accountId, itemId]);
    await admin.query("UPDATE work_items SET discussion_id = $1 WHERE id = $2", [discussion, itemId]);
    await admin.query(`INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, 'spec', encode(sha256(convert_to('spec', 'UTF8')), 'hex'), 'system')`, [t.accountId, itemId]);
    const runId = randomUUID();
    const branch = `fx/${runId}-g1`;
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'runner', 'succeeded')`, [runId, t.accountId, itemId]);
    await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'run.status_changed', $3::jsonb)`, [t.accountId, runId, JSON.stringify({ viaRunnerDone: true, to: "succeeded", branch, prNumber: "7", headOid: SHA })]);
    const writer = o.actor === "policy" ? (fn: (c: PoolClient) => Promise<{ id: string; store?: string }>) => withTenant(receiptPool, t.accountId, fn) : (fn: (c: PoolClient) => Promise<{ id: string; store?: string }>) => withTenant(receiptPool, t.accountId, t.userId, fn);
    const orig = await withTenant(receiptPool, t.accountId, t.userId, (c) => writeReceipt(c, { class: "human_over_the_loop", runId, workItemId: itemId, decisionType: "test_strategy_choice", chosen: "unit_tests", rejectedAlternative: "end_to_end_tests", dialVersion: 0, quotedInputs: [] }));
    if (orig.store !== "decision_receipts") throw new Error("expected the durable store");
    const rev = await writer((c) => writeReversalReceipt(c, { reversesReceiptId: orig.id, runId, chosen: "reversed", rejectedAlternative: "reverse_refused", dialVersion: 0 }));
    const { id } = await withTenant(receiptPool, t.accountId, t.userId, (c) => insertCompensation(c, { reversalReceiptId: rev.id, kind: o.stage === "merged" ? "revert_pr" : "rerun", state: "pending" }));
    return { ...t, itemId, branch, compensationId: id, name };
  }

  const requester: AccessTokenRequester = async (p) => ({ token: "ghs_faketoken", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: { metadata: "read", ...(p.permissions as Record<string, string>) }, ...(p.repositories ? { repositories: p.repositories } : {}) });
  const opener = (fetchImpl: typeof fetch, installed: boolean) =>
    createInstallationHttp({ resolveInstallation: async () => (installed ? { installationId: 9, appKind: "team" } : null), appCredentials: () => ({ appId: "app-1", privateKeyPem, webhookSecret: "unused" }), requester, cache: new InstallationTokenCache(), fetchImpl });

  /** The real clients against the fakes. `onClose` runs after GitHub has closed the pull request and before our step records anything. */
  async function github(i: Item, o: { installed?: boolean; onClose?: () => Promise<void>; merged?: boolean } = {}) {
    const pf = await startPullsFake("acme", i.name, [{ number: 7, ref: i.branch, sha: SHA, state: "open" }]);
    const rf = await startRevertFake("acme", i.name, [{ number: 7, nodeId: "PR_kwDOAAAAAc4AAAAH", merged: o.merged ?? true }]);
    servers.push(pf, rf);
    const pulls = opener(pf.fetchImpl, o.installed ?? true);
    const git: ReversalGitOpeners = {
      async openPulls(target) {
        const http: InstallationHttp = await pulls("runner_pr", target);
        const wrapped: PullsHttp = {
          async request(req) {
            const res = await http.request(req);
            if (req.method === "PATCH" && o.onClose) await o.onClose();
            return res;
          },
        };
        return wrapped;
      },
      openRevert: opener(rf.fetchImpl, o.installed ?? true),
    };
    return { pf, rf, git };
  }

  const blocks: string[] = [];
  const deps = (git: ReversalGitOpeners): ReversalCompensateDeps => ({ pool: receiptPool, git, warn: () => undefined, now: LATER, refreshBlock: async (x) => void blocks.push(x.workItemId) });
  const rowOf = async (i: Item) => (await admin.query("SELECT state, reason_code, attempts, pr_number, run_action_id FROM reversal_compensations WHERE id = $1", [i.compensationId])).rows[0];
  const stageOf = async (i: Item) => (await admin.query("SELECT stage FROM work_items WHERE id = $1", [i.itemId])).rows[0].stage as string;
  const advances = async (i: Item) => (await admin.query("SELECT requested_by FROM run_action_requests WHERE target_id = $1 AND kind = 'advance_work_item'", [i.itemId])).rows;
  const seen = (f: PullsFake | RevertFake) => f.requests.map((r) => `${r.method} ${r.path}`);
  /** The pull_request.closed delivery for pull request 7, through the real webhook apply on the app role. */
  const webhookClosed = (i: Item) =>
    withTenant(appPool, i.accountId, (c) =>
      applyMappedEvent(c, { accountId: i.accountId, installationId: i.installationId, repoId: i.repoId, repo: { accountId: i.accountId, repoId: i.repoId, ghRepoId: 1, fullName: `acme/${i.name}` }, deliveryId: randomUUID() },
        { kind: "transition_pr", toStage: "closed_unmerged", at: new Date(), prNumber: 7, linkedIssueNumber: null, trust: "trusted", isFork: false, headRef: i.branch, baseIsDefault: true }));

  describe("after the build: close at the recorded head, then Needs a person and Build again in the person's name", () => {
    it("closes once, keeps the branch, files one advance_work_item as the person, finishes done and re-renders the block", async () => {
      const i = await seed();
      const { pf, git } = await github(i);
      blocks.length = 0;
      expect(await runReversalCompensations(deps(git))).toEqual({ done: 1, failed: 0 });
      expect(seen(pf)).toEqual([`GET /repos/acme/${i.name}/pulls`, `PATCH /repos/acme/${i.name}/pulls/7`]);
      expect(pf.requests.some((r) => r.method === "DELETE" || /\/git\/refs|\/branches\//.test(r.path))).toBe(false);
      expect(await stageOf(i)).toBe("needs_human");
      expect(await advances(i)).toEqual([{ requested_by: `session:${i.userId}` }]);
      expect(await rowOf(i)).toMatchObject({ state: "done", reason_code: null, attempts: 1, pr_number: 7 });
      expect((await rowOf(i)).run_action_id).not.toBeNull();
      expect(blocks).toEqual([i.itemId]);
    });

    it("webhook FIRST: the closed delivery lands after GitHub closed it and before our move; it is held back and the item still ends at Needs a person", async () => {
      const i = await seed();
      const results: unknown[] = [];
      const { git } = await github(i, { onClose: async () => void results.push(await webhookClosed(i)) });
      expect(await runReversalCompensations(deps(git))).toEqual({ done: 1, failed: 0 });
      expect(results).toEqual([{ applied: "skipped", reason: "pull_request.closed: closed by a reversal, which records the move itself" }]);
      expect(await stageOf(i)).toBe("needs_human");
      expect(await advances(i)).toHaveLength(1);
    });

    it("the stale pull-request sweep reading the close before our move is held back the same way", async () => {
      const i = await seed();
      await admin.query("INSERT INTO work_item_transitions (account_id, work_item_id, from_stage, to_stage, at, source, source_ref) VALUES ($1, $2, 'in_progress', 'pr_opened', now() - interval '1 hour', 'control_plane', 'seed-entry')", [i.accountId, i.itemId]);
      const closedPr = { number: 7, state: "closed", merged_at: null, closed_at: new Date().toISOString(), head: { ref: i.branch, sha: SHA, repo: { full_name: `acme/${i.name}` } } };
      const outcomes: string[] = [];
      const runnerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
      try {
        const { git } = await github(i, { onClose: async () => void outcomes.push(await reconcileHolder(runnerPool, async () => ({ request: async () => ({ status: 200, body: [closedPr] }) }), i.accountId, i.itemId)) });
        await runReversalCompensations(deps(git));
      } finally {
        await runnerPool.end();
      }
      expect(outcomes).toEqual(["not_held"]);
      expect(await stageOf(i)).toBe("needs_human");
      expect(await advances(i)).toHaveLength(1);
    });

    it("webhook AFTER: the closed delivery lands once the row is done; it is held back and the item stays at Needs a person", async () => {
      const i = await seed();
      const { git } = await github(i);
      await runReversalCompensations(deps(git));
      expect(await webhookClosed(i)).toEqual({ applied: "skipped", reason: "pull_request.closed: closed by a reversal, which records the move itself" });
      expect(await stageOf(i)).toBe("needs_human");
      expect(await advances(i)).toHaveLength(1);
      // A close of some other pull request of the item is not held.
      const other = await withTenant(appPool, i.accountId, (c) => applyMappedEvent(c, { accountId: i.accountId, installationId: i.installationId, repoId: i.repoId, repo: { accountId: i.accountId, repoId: i.repoId, ghRepoId: 1, fullName: `acme/${i.name}` }, deliveryId: randomUUID() },
        { kind: "transition_pr", toStage: "closed_unmerged", at: new Date(), prNumber: 8, linkedIssueNumber: 41, trust: "trusted", isFork: false, headRef: "fx/issue-41", baseIsDefault: true }));
      expect(other).toMatchObject({ applied: "transitioned" });
    });

    it("a person who may not build (a member now) is refused before anything is closed: failed rerun_refused, GitHub untouched", async () => {
      const i = await seed();
      await admin.query("UPDATE account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2", [i.accountId, i.userId]);
      const { pf, git } = await github(i);
      expect(await runReversalCompensations(deps(git))).toEqual({ done: 0, failed: 1 });
      expect(pf.requests).toEqual([]);
      expect(await stageOf(i)).toBe("pr_opened");
      expect(await rowOf(i)).toMatchObject({ state: "failed", reason_code: "rerun_refused" });
    });

    it("a policy actor ends with no_person_actor and calls nothing (a sandbox item is re-run on a branch of its own: sandboxRerunReversal.pg.test.ts)", async () => {
      const policy = await seed({ actor: "policy" });
      const { pf, git } = await github(policy);
      await runReversalCompensations(deps(git));
      expect(pf.requests).toEqual([]);
      expect(await rowOf(policy)).toMatchObject({ state: "failed", reason_code: "no_person_actor" });
    });
  });

  it("after merge: one draft revert, done with the revert's number", async () => {
    const i = await seed({ stage: "merged" });
    const { rf, pf, git } = await github(i);
    expect(await runReversalCompensations(deps(git))).toEqual({ done: 1, failed: 0 });
    expect(rf.mutations).toHaveLength(1);
    expect(pf.requests).toEqual([]);
    const done = await rowOf(i);
    expect(done).toMatchObject({ state: "done", reason_code: null });
    // The revert's own number (the fake numbers new pull requests from 900), never the original's.
    expect(done.pr_number).toBeGreaterThanOrEqual(900);
  });

  it("criterion 6: the App uninstalled ends failed no_installation, the receipt block is not written, and the row is not retried by itself", async () => {
    const i = await seed();
    const { pf, git } = await github(i, { installed: false });
    blocks.length = 0;
    expect(await runReversalCompensations(deps(git))).toEqual({ done: 0, failed: 1 });
    expect(await rowOf(i)).toMatchObject({ state: "failed", reason_code: "no_installation", attempts: 1 });
    expect(blocks).toEqual([]);
    expect(pf.requests).toEqual([]);
    await runReversalCompensations(deps(git));
    expect(await rowOf(i)).toMatchObject({ attempts: 1 });
    expect(await stageOf(i)).toBe("pr_opened");
  });

  it("a repository row that can no longer be addressed ends failed repo_gone", async () => {
    const i = await seed({ repo: false });
    const { pf, git } = await github(i);
    await runReversalCompensations(deps(git));
    expect(await rowOf(i)).toMatchObject({ state: "failed", reason_code: "repo_gone", attempts: 1 });
    expect(pf.requests).toEqual([]);
  });

  it("criterion 2: a GitHub failure is failed tooling_error, the receipt keeps its row, and the next ticks retry until the cap, then stop", async () => {
    const i = await seed();
    const { pf, git } = await github(i);
    for (let n = 1; n <= COMPENSATION_MAX_ATTEMPTS; n += 1) {
      pf.override.reply = ghError(502, "Bad Gateway");
      // Through the tick itself, so the call in runAskWindowTick is what retries.
      await runAskWindowTick({ pool: receiptPool, warn: () => undefined, reversals: { git, now: LATER } });
      expect(await rowOf(i)).toMatchObject({ state: "failed", reason_code: "tooling_error", attempts: n });
    }
    const before = pf.requests.length;
    await runAskWindowTick({ pool: receiptPool, warn: () => undefined, reversals: { git, now: LATER } });
    expect(pf.requests.length).toBe(before);
    expect((await admin.query("SELECT count(*)::int AS n FROM reversal_compensations c JOIN decision_receipts r ON r.id = c.reversal_receipt_id WHERE c.id = $1", [i.compensationId])).rows[0].n).toBe(1);
    expect(await stageOf(i)).toBe("pr_opened");
  });

  it("criterion 4: two workers ticking at once perform one compensation", async () => {
    const i = await seed();
    const { pf, git } = await github(i);
    const [a, b] = await Promise.all([runReversalCompensations(deps(git)), runReversalCompensations(deps(git))]);
    expect(a.done + b.done).toBe(1);
    expect(pf.requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
    expect(await advances(i)).toHaveLength(1);
  });
});
