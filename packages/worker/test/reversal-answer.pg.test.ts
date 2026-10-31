import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { writeReceipt } from "@fx/db/src/receiptWriter.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { REVERSAL_ASK_ALLOW, answerAsk, recordReversal } from "@fx/core/src/decisions/index.js";
import { createInstallationHttp, InstallationTokenCache, type AccessTokenRequester, type InstallationHttp } from "@fx/github";
import { createReversalPlanner, type PullsHttp } from "@fx/receipts";
import { startRevertFake, type RevertFake } from "../../github/test/helpers/revertGithubFake.js";
import { startPullsFake, type PullsFake } from "../../receipts/test/helpers/pullsGithubFake.js";
import { runReversalCompensations, type ReversalGitOpeners } from "../src/reversalCompensate.js";

/**
 * [pg] D#7 DP7-2e (R4, criterion 5) with the REAL planner and the REAL worker step: an item that merged between the ask and the answer ends with a revert
 * pull request, not a re-run; an item still unmerged waits for the person to confirm the estimate and the worker touches nothing until then.
 * What cannot be faked: GitHub's revert-conflict detection (declared by the fake).
 */
const LOGIN = "fx_reversal_answer_test";
const SHA = "a".repeat(40);
const LATER = () => new Date(Date.now() + 400 * 86_400_000); // past every receipt's free window

describe("allowing an over-cap reversal [pg]", { timeout: 120_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let receiptPool: Pool;
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
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });
  afterAll(async () => {
    // The files of this package share one database, and other files delete every ask; the foreign key from a row to its ask would stop them.
    await admin.query("DELETE FROM reversal_compensations WHERE ask_id IS NOT NULL");
    admin.release();
    for (const p of [adminPool, receiptPool]) await p.end();
  });

  interface Item extends SeedRefs { itemId: string; runId: string; askId: string; name: string }

  /** A runner-built item at `pr_opened` whose run recorded pull request 7, with three reversals on it: the third raised the ask. */
  async function seed(): Promise<Item> {
    const t = await seedAccount(admin, randomUUID());
    const name = `widgets-${t.repoId.slice(0, 8)}`;
    await admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = $2, execution_mode = 'runner_local' WHERE id = $1", [t.repoId, name]);
    const itemId = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'bug', 'internal', 'pr_opened', 41)`, [itemId, t.accountId, t.repoId]);
    const runId = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'runner', 'succeeded')`, [runId, t.accountId, itemId]);
    await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'run.status_changed', $3::jsonb)`, [t.accountId, runId, JSON.stringify({ viaRunnerDone: true, to: "succeeded", branch: `fx/${runId}-g1`, prNumber: "7", headOid: SHA })]);
    let askId: string | null = null;
    for (let n = 0; n < 3; n++) {
      const orig = await withTenant(receiptPool, t.accountId, t.userId, (c) => writeReceipt(c, { class: "human_over_the_loop", runId, workItemId: itemId, decisionType: "test_strategy_choice", chosen: "unit_tests", rejectedAlternative: "end_to_end_tests", dialVersion: 0, quotedInputs: [] }));
      if (orig.store !== "decision_receipts") throw new Error("expected the durable store");
      const r = await recordReversal({ pool: receiptPool, accountId: t.accountId, userId: t.userId }, { reversesReceiptId: orig.id, runId, chosen: "reversed", rejectedAlternative: "reverse_refused", dialVersion: 0 });
      askId = r.askId;
    }
    return { ...t, itemId, runId, askId: askId!, name };
  }

  const requester: AccessTokenRequester = async (p) => ({ token: "ghs_faketoken", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: { metadata: "read", ...(p.permissions as Record<string, string>) }, ...(p.repositories ? { repositories: p.repositories } : {}) });
  const opener = (fetchImpl: typeof fetch) =>
    createInstallationHttp({ resolveInstallation: async () => ({ installationId: 9, appKind: "team" }), appCredentials: () => ({ appId: "app-1", privateKeyPem, webhookSecret: "unused" }), requester, cache: new InstallationTokenCache(), fetchImpl });

  async function github(i: Item) {
    const pf = await startPullsFake("acme", i.name, [{ number: 7, ref: `fx/${i.runId}-g1`, sha: SHA, state: "open" }]);
    const rf = await startRevertFake("acme", i.name, [{ number: 7, nodeId: "PR_kwDOAAAAAc4AAAAH", merged: true }]);
    servers.push(pf, rf);
    const pulls = opener(pf.fetchImpl);
    const git: ReversalGitOpeners = {
      async openPulls(target) {
        const http: InstallationHttp = await pulls("runner_pr", target);
        const wrapped: PullsHttp = { request: (req) => http.request(req) };
        return wrapped;
      },
      openRevert: opener(rf.fetchImpl),
    };
    return { pf, rf, git };
  }

  const allow = (i: Item) => answerAsk({ pool: receiptPool, principal: { accountId: i.accountId, userId: i.userId }, reversal: createReversalPlanner(receiptPool, LATER) }, { askId: i.askId, choice: REVERSAL_ASK_ALLOW });
  const rowOf = async (i: Item) => (await admin.query("SELECT kind, state, reason_code, pr_number, estimate_usd, ask_id FROM reversal_compensations WHERE work_item_id = $1", [i.itemId])).rows;
  const advances = async (i: Item) => (await admin.query("SELECT 1 FROM run_action_requests WHERE target_id = $1 AND kind = 'advance_work_item'", [i.itemId])).rows;
  const resumes = async (i: Item) => (await admin.query("SELECT 1 FROM run_action_requests WHERE target_id = $1 AND kind = 'resume_decision'", [i.askId])).rows;

  it("an item that merged between the ask and the answer ends with a revert pull request, not a re-run", async () => {
    const i = await seed();
    await admin.query("UPDATE work_items SET stage = 'merged' WHERE id = $1", [i.itemId]);
    await allow(i);
    expect(await rowOf(i)).toEqual([expect.objectContaining({ kind: "revert_pr", state: "pending", ask_id: i.askId, estimate_usd: null })]);
    const { pf, rf, git } = await github(i);
    expect(await runReversalCompensations({ pool: receiptPool, git, warn: () => undefined, now: LATER })).toEqual({ done: 1, failed: 0 });
    const [row] = await rowOf(i);
    expect(row).toMatchObject({ kind: "revert_pr", state: "done", reason_code: null });
    expect(row.pr_number).toBeGreaterThan(0);
    expect(rf.requests.length).toBeGreaterThan(0);
    // The original pull request is not closed and no new build is requested.
    expect(pf.requests.filter((r) => r.method === "PATCH")).toEqual([]);
    expect(await advances(i)).toEqual([]);
    expect(await resumes(i)).toEqual([]);
  });

  it("an item still unmerged is priced: the row waits for the person's confirmation with the live estimate, and the worker does nothing with it", async () => {
    const i = await seed();
    const runId = (await admin.query("SELECT id FROM agent_runs WHERE work_item_id = $1", [i.itemId])).rows[0].id as string;
    await admin.query("INSERT INTO ledger (account_id, run_id, kind, source, usd) VALUES ($1, $2, 'model', 'customer_gateway', 2.5)", [i.accountId, runId]);
    await allow(i);
    expect(await rowOf(i)).toEqual([expect.objectContaining({ kind: "rerun", state: "awaiting_confirm", estimate_usd: "2.5000", ask_id: i.askId })]);
    const { pf, rf, git } = await github(i);
    expect(await runReversalCompensations({ pool: receiptPool, git, warn: () => undefined, now: LATER })).toEqual({ done: 0, failed: 0 });
    expect(pf.requests).toEqual([]);
    expect(rf.requests).toEqual([]);
    expect(await advances(i)).toEqual([]);
    expect(await resumes(i)).toEqual([]);
  });
});
