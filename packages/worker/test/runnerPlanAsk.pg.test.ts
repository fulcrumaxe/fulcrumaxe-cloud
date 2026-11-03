import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256Text, signJob, type Job } from "@fulcrumaxe/runner-protocol";
import { AskAnswerError, answerAsk, listPendingAsks } from "@fx/core/src/decisions/index.js";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { runAskWindowTick } from "../src/askWindowTick.js";
import { createRunnerClaimFacade, type RunnerClaimFacade } from "../src/runnerClaims.js";
import { createRunnerPlanAsk } from "../src/runnerPlanAsk.js";

/**
 * [pg] D#7 DW-R7: a runner run on a member's plan under the repo's "ask" setting raises one ask, only the plan holder answers it, and the run goes on from the
 * answer. Real definers (0757, 0767, 0982), the real ask machinery, the real claim and a real receipt login (app_user + receipt_writer_invoker).
 */
const LOGIN = "fx_runner_plan_ask_test";
const ROLES = ["executor", "code-reviewer"];
const OWNER_SENTENCE = (repo: string, name: string): string => `A run in ${repo} is waiting to use ${name}'s Claude plan. It starts only if ${name} says yes here. If nobody answers in time, it stays stopped.`;

describe("the member-plan ask [pg]", { timeout: 120_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let receiptPool: Pool;
  const key = generateKeyPairSync("ed25519").privateKey;
  const T0 = Math.floor(Date.now() / 1000) * 1000;
  let A: SeedRefs;
  let holder: string;
  let otherAdmin: string;
  let plainMember: string;
  let teammate: string;
  let runner: string;
  let facade: RunnerClaimFacade;
  const raise = (runnerId = runner, roles: readonly string[] = ROLES) => createRunnerPlanAsk(receiptPool)({ accountId: A.accountId, runnerId, roles });

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${LOGIN}') THEN CREATE ROLE ${LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${LOGIN}`);
    const u = new URL(process.env.WORKER_DATABASE_URL_APP_USER!);
    u.username = LOGIN;
    u.password = "";
    receiptPool = createPool(u.toString());
    facade = createRunnerClaimFacade(writerPool, { visibility: { visibility: async () => "private" }, now: () => T0, randomBetween: (min) => min, raiseMemberPlanAsks: (i) => raise(i.runnerId, i.roles) });
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool, receiptPool]) await p.end();
  });

  async function member(role: "member" | "admin", name: string | null): Promise<string> {
    const id = randomUUID();
    await admin.query("INSERT INTO users (id, email, name) VALUES ($1, $2, $3)", [id, `${id}@example.test`, name]);
    await admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)", [A.accountId, id, role]);
    return id;
  }
  async function newRunner(by: string, o: { mode?: string; repos?: string[] } = {}): Promise<string> {
    const id = await insertRunner(admin, A.accountId, by, { credentialMode: o.mode ?? "subscription" });
    await admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[], allowed_roles = $3::text[] WHERE id = $1", [id, o.repos ?? [A.repoId], ROLES]);
    return id;
  }
  /** A pending runner run with a real signed job, started by a teammate. */
  async function pending(o: { initiatedBy?: string | null; approvedBy?: string | null } = {}): Promise<string> {
    const id = randomUUID();
    const job: Job = {
      schema_version: 1, job_id: randomUUID(), run_id: id, repo: { id: A.repoId, owner: "acme", name: "app", private: true }, role: "executor", mode: "local", spec: null,
      task: { kind: "implement", prompt: "p", prompt_sha256: sha256Text("p") }, role_card: { text: "c", sha256: sha256Text("c") }, role_tools_sha256: "a".repeat(64), continues: null,
      branch_prefix: "fx/", model_hint: null, issued_at: new Date(T0 - 1000).toISOString(), expires_at: new Date(T0 + 72 * 3_600_000).toISOString(), key_id: "k1",
    };
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, dispatch_repo_id, work_item_id, job_signed, initiated_by, approved_by, created_at)
       VALUES ($1, $2, 'executor', 'runner', 'pending', 'runner_local', $3, $4, $5::jsonb, $6, $7, now())`,
      [id, A.accountId, A.repoId, A.workItemId, JSON.stringify(signJob(job, key)), o.initiatedBy === undefined ? teammate : o.initiatedBy, o.approvedBy ?? null],
    );
    return id;
  }
  const dial = (disposition: string) =>
    admin.query(
      `INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, version, changed_by)
       VALUES ($1, $2, 'runner_run_on_member_plan', $3, (SELECT COALESCE(max(version), 0) + 1 FROM decision_settings WHERE repo_id = $2 AND decision_type = 'runner_run_on_member_plan'), $4)`,
      [A.accountId, A.repoId, disposition, A.userId],
    );
  const asks = async (runId?: string) => (await admin.query("SELECT * FROM decision_asks WHERE account_id = $1 AND decision_type = 'runner_run_on_member_plan' AND ($2::uuid IS NULL OR run_id = $2) ORDER BY raised_at", [A.accountId, runId ?? null])).rows;
  const links = async () => (await admin.query("SELECT * FROM runner_plan_asks WHERE account_id = $1", [A.accountId])).rows;
  const runRow = async (id: string) => (await admin.query("SELECT status, runner_id, approved_by FROM agent_runs WHERE id = $1", [id])).rows[0];
  const receipts = async (runId: string) => (await admin.query("SELECT class, chosen, actor FROM decision_receipts WHERE run_id = $1 AND decision_type = 'runner_run_on_member_plan'", [runId])).rows;
  const answer = (userId: string, askId: string, choice: string) => answerAsk({ pool: receiptPool, principal: { accountId: A.accountId, userId } }, { askId, choice });
  const claim = (runnerId = runner) => facade.claimRunnerRun({ accountId: A.accountId, runnerId });
  const listed = async (userId: string) => (await listPendingAsks({ pool: receiptPool, principal: { accountId: A.accountId, userId } })).asks.filter((a) => a.decisionType === "runner_run_on_member_plan");

  beforeEach(async () => {
    A = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE repos SET execution_mode = 'runner_local', gh_owner = 'acme', gh_name = 'app' WHERE id = $1", [A.repoId]);
    holder = await member("admin", "Priya Raman");
    otherAdmin = await member("admin", "Sam Okafor");
    plainMember = await member("member", "Lee Wong");
    teammate = await member("member", "Tess Lund");
    runner = await newRunner(holder);
    await dial("ask");
  });

  describe("raising the ask (criterion 1)", () => {
    it("raises exactly one ask for a waiting run, naming the repo and the plan holder, and records whose plan it is", async () => {
      const id = await pending();
      expect(await raise()).toBe(1);
      const [ask] = await asks(id);
      expect(ask).toMatchObject({ state: "open", proposed: "approve", timeout_outcome: "stop_and_flag", run_id: id, work_item_id: A.workItemId });
      expect(ask.options).toEqual([{ id: "approve", label: "Yes, use my plan for this run" }, { id: "decline", label: "No, don't run it" }]);
      expect(ask.rationale).toContain(OWNER_SENTENCE("acme/app", "Priya Raman"));
      expect(ask.rationale).not.toContain(holder);
      expect(ask.rationale + JSON.stringify(ask.options)).not.toMatch(/NaN|undefined|null/);
      expect(await links()).toEqual([expect.objectContaining({ run_id: id, ask_id: ask.id, runner_id: runner, plan_holder: holder })]);
      expect(await runRow(id)).toMatchObject({ status: "pending", approved_by: null });
    });

    it("a repeat claim attempt raises no second ask, however many times or at once, and another runner of the repo does not either", async () => {
      const id = await pending();
      const second = await newRunner(otherAdmin);
      const results = await Promise.all([raise(), raise(), raise(second)]);
      expect(results.reduce((a, b) => a + b, 0)).toBe(1);
      expect(await raise()).toBe(0);
      expect(await raise(second)).toBe(0);
      expect(await asks(id)).toHaveLength(1);
      expect(await links()).toHaveLength(1);
    });

    it("the claim itself raises it when it has nothing to hand out, and the run does not wait silently (the ask is in the list), without changing the claim's answer", async () => {
      const id = await pending();
      expect(await claim()).toMatchObject({ kind: "idle" });
      expect(await asks(id)).toHaveLength(1);
      expect(await claim()).toMatchObject({ kind: "idle" });
      expect(await asks(id)).toHaveLength(1);
      const shown = await listed(holder);
      expect(shown).toHaveLength(1);
      expect(shown[0]).toMatchObject({ decisionType: "runner_run_on_member_plan", planHolder: { id: holder, name: "Priya Raman" }, timeoutOutcome: "stop_and_flag" });
    });

    it.each(["announce", "act"] as const)("dial %s raises nothing (the claim approves instead); no dial row reads as announce", async (d) => {
      await dial(d);
      await pending();
      expect(await raise()).toBe(0);
      expect(await asks()).toEqual([]);
    });

    it("a repo with no dial row raises nothing (the existing default, announce)", async () => {
      await admin.query("DELETE FROM decision_settings WHERE repo_id = $1", [A.repoId]);
      await pending();
      expect(await raise()).toBe(0);
    });

    it("raises nothing for a run its holder started or approved, a runner that is not a live subscription one, a role it cannot take, or a holder who is not an owner or admin", async () => {
      await pending({ initiatedBy: holder });
      await pending({ approvedBy: holder });
      expect(await raise()).toBe(0);
      await pending();
      expect(await raise(runner, ["code-reviewer"])).toBe(0);
      expect(await raise(await newRunner(holder, { mode: "api_key" }))).toBe(0);
      expect(await raise(await newRunner(plainMember))).toBe(0);
      const revoked = await newRunner(holder);
      await admin.query("UPDATE runners SET revoked_at = now(), revoked_reason = 'test' WHERE id = $1", [revoked]);
      expect(await raise(revoked)).toBe(0);
      expect(await asks()).toEqual([]);
    });

    it("the writer is not callable for another person's run or a dial that is not ask, and a login that is not the receipt login cannot write the table", async () => {
      const id = await pending();
      expect(await raise()).toBe(1);
      const [ask] = await asks(id);
      await dial("announce");
      await expect(withTenant(receiptPool, A.accountId, (c) => c.query("SELECT runner_plan_ask_record($1, $2, $3)", [ask.id, id, runner]))).rejects.toThrow(/dial_not_ask/);
      await dial("ask");
      await admin.query("UPDATE agent_runs SET approved_by = $2 WHERE id = $1", [id, holder]);
      await expect(withTenant(receiptPool, A.accountId, (c) => c.query("SELECT runner_plan_ask_record($1, $2, $3)", [ask.id, id, runner]))).rejects.toThrow(/run_not_waiting/);
      const app = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
      try {
        await expect(withTenant(app, A.accountId, (c) => c.query("INSERT INTO runner_plan_asks (account_id, run_id, ask_id, runner_id, plan_holder) VALUES ($1, $2, $3, $4, $5)", [A.accountId, id, ask.id, runner, otherAdmin]))).rejects.toThrow(/permission denied/);
        await expect(withTenant(writerPool, A.accountId, (c) => c.query("INSERT INTO runner_plan_asks (account_id, run_id, ask_id, runner_id, plan_holder) VALUES ($1, $2, $3, $4, $5)", [A.accountId, id, ask.id, runner, otherAdmin]))).rejects.toThrow(/permission denied/);
      } finally {
        await app.end();
      }
    });
  });

  describe("the answer (criterion 2): only the plan holder, and the click is the answer", () => {
    it("the holder's yes approves the run for them, writes one receipt in their name, and the claim then takes it with no second ask or receipt", async () => {
      const id = await pending();
      await raise();
      const [ask] = await asks(id);
      const done = await answer(holder, ask.id, "approve");
      expect(done).toMatchObject({ askId: ask.id, answeredOption: "approve" });
      expect((await asks(id))[0]).toMatchObject({ state: "answered", answered_option: "approve", answered_by: holder });
      expect(await runRow(id)).toMatchObject({ status: "pending", approved_by: holder });
      expect(await receipts(id)).toEqual([{ class: "human_over_the_loop", chosen: "approve", actor: holder }]);
      // The click is the answer: no resume request is filed for it (answer.ts skips run_action_request for this decision type).
      expect((await admin.query("SELECT 1 FROM run_action_requests WHERE account_id = $1 AND target_id = $2", [A.accountId, ask.id])).rowCount).toBe(0);
      expect(await listed(holder)).toEqual([]); // read again: the answered ask is no longer in Needs you
      // The run continues from the click: the claim takes it as it takes any run its registrant approved, and nothing asks again.
      expect(await claim()).toMatchObject({ kind: "claimed", runId: id });
      expect(await runRow(id)).toMatchObject({ status: "running", runner_id: runner, approved_by: holder });
      expect(await asks(id)).toHaveLength(1);
      expect(await receipts(id)).toHaveLength(1);
      expect(await raise()).toBe(0);
    });

    it("another owner or admin, the account owner and a plain member cannot answer; the ask stays open and the run is not approved", async () => {
      const id = await pending();
      await raise();
      const [ask] = await asks(id);
      for (const who of [otherAdmin, A.userId, plainMember]) {
        await expect(answer(who, ask.id, "approve")).rejects.toMatchObject({ code: "forbidden", status: 403 });
        await expect(answer(who, ask.id, "decline")).rejects.toBeInstanceOf(AskAnswerError);
      }
      expect((await asks(id))[0]).toMatchObject({ state: "open", answered_by: null });
      expect(await runRow(id)).toMatchObject({ approved_by: null });
      expect(await receipts(id)).toEqual([]);
    });

    it("the holder's no (and deny) approves nothing, writes the receipt, and the run is not started; no second ask is raised for it", async () => {
      for (const choice of ["decline", "deny"]) {
        const id = await pending();
        await raise();
        const [ask] = (await asks(id)).slice(-1);
        await answer(holder, ask.id, choice);
        expect(await runRow(id)).toMatchObject({ status: "pending", approved_by: null, runner_id: null });
        expect(await receipts(id)).toEqual([{ class: "human_over_the_loop", chosen: choice, actor: holder }]);
        expect(await raise()).toBe(0);
        expect(await asks(id)).toHaveLength(1);
        expect(await listed(holder)).toEqual([]); // read again: answered, so not in Needs you
        expect(await claim()).toMatchObject({ kind: "idle" }); // and the claim's retry does not ask again
        expect(await asks(id)).toHaveLength(1);
        await admin.query("UPDATE agent_runs SET status = 'cancelled' WHERE id = $1", [id]);
      }
    });

    it("a second answer is refused as already answered and writes nothing more", async () => {
      const id = await pending();
      await raise();
      const [ask] = await asks(id);
      await answer(holder, ask.id, "approve");
      await expect(answer(holder, ask.id, "decline")).rejects.toMatchObject({ code: "already_answered", status: 409 });
      expect(await receipts(id)).toHaveLength(1);
      expect(await runRow(id)).toMatchObject({ approved_by: holder });
    });

    it("a choice the ask does not list is refused", async () => {
      await pending();
      await raise();
      const [ask] = await asks();
      await expect(answer(holder, ask.id, "run_it")).rejects.toMatchObject({ code: "invalid_choice", status: 422 });
    });
  });

  describe("every state the ask can be in", () => {
    it("a run cancelled while the ask is open: the ask leaves Needs you (read from the run), a yes is refused as moot, and nothing is approved", async () => {
      const id = await pending();
      await raise();
      const [ask] = await asks(id);
      expect(await listed(holder)).toHaveLength(1);
      await admin.query("UPDATE agent_runs SET status = 'cancelled' WHERE id = $1", [id]);
      expect(await listed(holder)).toEqual([]);
      await expect(answer(holder, ask.id, "approve")).rejects.toMatchObject({ code: "already_answered", status: 409 });
      expect((await asks(id))[0]).toMatchObject({ state: "open" });
      expect(await receipts(id)).toEqual([]);
    });

    it("a run the holder approved on the Runs card meanwhile leaves Needs you too", async () => {
      const id = await pending();
      await raise();
      await withTenant(receiptPool, A.accountId, holder, (c) => c.query("SELECT agent_run_approve($1)", [id]));
      expect(await listed(holder)).toEqual([]);
    });

    it("the dial changed while the ask is open: it stays answerable, the next claim follows the new setting", async () => {
      const id = await pending();
      await raise();
      const [ask] = await asks(id);
      await dial("announce");
      expect(await listed(holder)).toHaveLength(1);
      await answer(holder, ask.id, "approve");
      expect(await runRow(id)).toMatchObject({ approved_by: holder });
      // Another waiting run under announce: no ask, and (with consent) the claim approves it by itself as before.
      const next = await pending();
      expect(await raise()).toBe(0);
      expect(await asks(next)).toEqual([]);
    });

    it("the plan holder absent: removed from the team, nobody else can consent for them; the ask stays and shows their name; silence stops and flags", async () => {
      const id = await pending();
      await raise();
      const [ask] = await asks(id);
      await admin.query("DELETE FROM account_members WHERE account_id = $1 AND user_id = $2", [A.accountId, holder]);
      await expect(answer(otherAdmin, ask.id, "approve")).rejects.toMatchObject({ code: "forbidden" });
      await expect(answer(holder, ask.id, "approve")).rejects.toBeInstanceOf(AskAnswerError);
      expect((await listed(otherAdmin))[0]).toMatchObject({ planHolder: { id: holder, name: "a former team member" } });
      expect(await runRow(id)).toMatchObject({ approved_by: null });
      // The window ends with nobody answering: the ask is flagged overdue and the run is still not approved, not started.
      await admin.query("BEGIN");
      await admin.query("SET LOCAL session_replication_role = replica");
      await admin.query("UPDATE decision_asks SET raised_at = raised_at - interval '30 days', answer_due_at = answer_due_at - interval '30 days' WHERE id = $1", [ask.id]);
      await admin.query("COMMIT");
      await runAskWindowTick({ pool: receiptPool, warn: () => undefined });
      expect((await asks(id))[0]).toMatchObject({ state: "overdue", timeout_outcome: "stop_and_flag" });
      expect(await runRow(id)).toMatchObject({ status: "pending", approved_by: null, runner_id: null });
      expect(await receipts(id)).toEqual([]);
    });

    it("silence while the holder is present also stops and flags: the window ending approves nothing", async () => {
      const id = await pending();
      await raise();
      const [ask] = await asks(id);
      await admin.query("BEGIN");
      await admin.query("SET LOCAL session_replication_role = replica");
      await admin.query("UPDATE decision_asks SET raised_at = raised_at - interval '30 days', answer_due_at = answer_due_at - interval '30 days' WHERE id = $1", [ask.id]);
      await admin.query("COMMIT");
      await runAskWindowTick({ pool: receiptPool, warn: () => undefined });
      expect((await asks(id))[0]).toMatchObject({ state: "overdue", timeout_outcome: "stop_and_flag" });
      expect(await runRow(id)).toMatchObject({ status: "pending", approved_by: null });
      expect(await claim()).toMatchObject({ kind: "idle" });
      // Still answerable after the window, by the holder alone.
      await answer(holder, ask.id, "approve");
      expect(await runRow(id)).toMatchObject({ approved_by: holder });
    });

    it("the runner removed while the ask is open: the holder's yes is refused (nobody's plan to spend) and nothing is approved", async () => {
      const id = await pending();
      await raise();
      const [ask] = await asks(id);
      await admin.query("UPDATE runners SET revoked_at = now(), revoked_reason = 'test' WHERE id = $1", [runner]);
      await expect(answer(holder, ask.id, "approve")).rejects.toMatchObject({ code: "forbidden" });
      expect(await runRow(id)).toMatchObject({ approved_by: null });
      expect((await asks(id))[0]).toMatchObject({ state: "open" });
    });

    it("the listed holder is a name two people can tell apart, never an id or empty: name, then GitHub login, then email", async () => {
      const unnamed = await member("admin", null);
      await admin.query("UPDATE users SET github_login = 'unnamed-dev' WHERE id = $1", [unnamed]);
      const r2 = await newRunner(unnamed);
      await pending();
      expect(await raise(r2)).toBe(1);
      expect((await listed(unnamed))[0]!.planHolder).toEqual({ id: unnamed, name: "unnamed-dev" });
      await admin.query("UPDATE users SET github_login = NULL WHERE id = $1", [unnamed]);
      expect((await listed(unnamed))[0]!.planHolder!.name).toMatch(/@example\.test$/);
    });
  });
});
