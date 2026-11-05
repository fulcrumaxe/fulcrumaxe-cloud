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
      await expect(answer(holder, ask.id, "approve")).rejects.toMatchObject({ code: "runner_gone", status: 409 });
      expect(await runRow(id)).toMatchObject({ approved_by: null });
      expect((await asks(id))[0]).toMatchObject({ state: "open" });
    });

    // Follow-up 2: approved_by is written once, so a yes the holder's runners cannot act on must not write it.
    it("a yes after the runner dropped the repository writes nothing and leaves the ask open; decline still works; adding the repository back lets the same yes through", async () => {
      const id = await pending();
      await raise();
      const [ask] = await asks(id);
      const other = randomUUID();
      await admin.query("UPDATE runners SET allowed_repo_ids = ARRAY[$2::uuid] WHERE id = $1", [runner, other]); // still live, lists another repo only
      await expect(answer(holder, ask.id, "approve")).rejects.toMatchObject({ code: "runner_gone", status: 409 });
      expect(await runRow(id)).toMatchObject({ status: "pending", approved_by: null });
      expect((await asks(id))[0]).toMatchObject({ state: "open", answered_by: null });
      expect(await receipts(id)).toEqual([]);
      expect(await listed(holder)).toHaveLength(1); // still in Needs you, still answerable
      await admin.query("UPDATE runners SET allowed_repo_ids = ARRAY[$2::uuid] WHERE id = $1", [runner, A.repoId]);
      await answer(holder, ask.id, "approve");
      expect(await runRow(id)).toMatchObject({ approved_by: holder });
    });

    it("a yes with another runner of the holder's that still lists the repository goes through (the ask's own runner is gone)", async () => {
      const id = await pending();
      await raise();
      const [ask] = await asks(id);
      await admin.query("UPDATE runners SET revoked_at = now(), revoked_reason = 'test' WHERE id = $1", [runner]);
      await newRunner(holder);
      await answer(holder, ask.id, "approve");
      expect(await runRow(id)).toMatchObject({ approved_by: holder });
    });

    it("a no after the runner dropped the repository is still taken: nothing needs a runner to say no", async () => {
      const id = await pending();
      await raise();
      const [ask] = await asks(id);
      await admin.query("UPDATE runners SET allowed_repo_ids = ARRAY[$2::uuid] WHERE id = $1", [runner, randomUUID()]);
      await answer(holder, ask.id, "decline");
      expect((await asks(id))[0]).toMatchObject({ state: "answered", answered_option: "decline" });
    });

    it("the listed holder is a name two people can tell apart, never an id, empty or an email: name, then GitHub login, then a fixed fallback", async () => {
      const unnamed = await member("admin", null);
      await admin.query("UPDATE users SET github_login = 'unnamed-dev' WHERE id = $1", [unnamed]);
      const r2 = await newRunner(unnamed);
      await pending();
      expect(await raise(r2)).toBe(1);
      expect((await listed(unnamed))[0]!.planHolder).toEqual({ id: unnamed, name: "unnamed-dev" });
      await admin.query("UPDATE users SET github_login = NULL WHERE id = $1", [unnamed]);
      expect((await listed(unnamed))[0]!.planHolder).toEqual({ id: unnamed, name: "a team member" });
    });

    // Follow-up 3: a member must never see another person's email, in the list or in the stored sentence.
    it("a holder with no name and no GitHub login is shown, and written into the ask, as a fixed fallback and never as their email", async () => {
      const unnamed = await member("admin", null);
      const email = (await admin.query("SELECT email FROM users WHERE id = $1", [unnamed])).rows[0].email as string;
      const r2 = await newRunner(unnamed);
      const id = await pending();
      expect(await raise(r2)).toBe(1);
      const [ask] = await asks(id);
      expect(ask.rationale).toContain(OWNER_SENTENCE("acme/app", "a team member"));
      expect(ask.rationale).not.toContain(email);
      for (const who of [plainMember, otherAdmin, unnamed]) expect(JSON.stringify(await listed(who))).not.toContain(email);
    });
  });

  describe("a no stands (follow-up 1)", () => {
    const consent = (by: string, runnerId: string, granted = true) => withTenant(receiptPool, A.accountId, by, (c) => c.query("SELECT * FROM runner_plan_consent_set($1, $2)", [runnerId, granted]));
    const declined = (id: string, pool: Pool = receiptPool) => withTenant(pool, A.accountId, async (c) => (await c.query<{ d: boolean }>("SELECT runner_plan_declined($1) AS d", [id])).rows[0]!.d);

    it("a declined run is not approved by the claim after the dial is loosened to announce or act, with the holder's standing consent on; an unasked run still is", async () => {
      await consent(holder, runner);
      for (const choice of ["decline", "deny"]) {
        for (const loose of ["announce", "act"]) {
          const id = await pending();
          await dial("ask");
          await raise();
          const [ask] = (await asks(id)).slice(-1);
          await answer(holder, ask.id, choice);
          await dial(loose);
          expect(await declined(id)).toBe(true);
          expect(await declined(id, writerPool)).toBe(true);
          expect(await claim()).toMatchObject({ kind: "idle" });
          expect(await runRow(id)).toMatchObject({ status: "pending", approved_by: null, runner_id: null });
          expect((await admin.query("SELECT 1 FROM audit_log WHERE account_id = $1 AND action = 'runner.run_auto_approved' AND payload ->> 'run_id' = $2", [A.accountId, id])).rowCount).toBe(0);
          await admin.query("UPDATE agent_runs SET status = 'cancelled' WHERE id = $1", [id]);
        }
      }
      // The control: a run nobody was asked about is approved at the claim under the same dial and consent, so the refusal is what stopped the others.
      const fresh = await pending();
      expect(await claim()).toMatchObject({ kind: "claimed", runId: fresh });
    });

    it("the claim's own approval function refuses a declined run even when it is handed the run directly (a decline landing between the candidate read and the claim)", async () => {
      await consent(holder, runner);
      await dial("announce");
      const approveAtClaim = (id: string) => withTenant(writerPool, A.accountId, async (c) => (await c.query<{ ok: boolean }>("SELECT agent_run_runner_auto_approve($1::uuid, $2::uuid, now(), 1) AS ok", [id, runner])).rows[0]!.ok);
      const asked = await pending();
      await dial("ask");
      await raise();
      await answer(holder, (await asks(asked))[0].id, "decline");
      await dial("announce");
      expect(await approveAtClaim(asked)).toBe(false);
      expect(await runRow(asked)).toMatchObject({ approved_by: null });
      expect(await approveAtClaim(await pending())).toBe(true); // the control: the same call approves a run nobody declined
    });

    it("the claim's candidate list skips declined runs, so a pile of them never hides a later run", async () => {
      await consent(holder, runner);
      for (let i = 0; i < 6; i++) {
        const id = await pending();
        await raise();
        const [ask] = (await asks(id)).slice(-1);
        await answer(holder, ask.id, "decline");
      }
      await dial("announce");
      const later = await pending();
      expect(await claim()).toMatchObject({ kind: "claimed", runId: later });
    });

    it("a yes, silence and an open ask are not a refusal", async () => {
      const yes = await pending();
      const silent = await pending();
      const open = await pending();
      await raise();
      const [a1, a2] = [(await asks(yes))[0], (await asks(silent))[0]];
      await answer(holder, a1.id, "approve");
      await admin.query("BEGIN");
      await admin.query("SET LOCAL session_replication_role = replica");
      await admin.query("UPDATE decision_asks SET raised_at = raised_at - interval '30 days', answer_due_at = answer_due_at - interval '30 days' WHERE id = $1", [a2.id]);
      await admin.query("COMMIT");
      await runAskWindowTick({ pool: receiptPool, warn: () => undefined });
      for (const id of [yes, silent, open]) expect(await declined(id)).toBe(false);
      expect(await declined(randomUUID())).toBe(false);
    });

    it("what a person can do after a no: Approve on the Runs card, the holder's own click, and the claim then takes the run", async () => {
      await consent(holder, runner);
      const id = await pending();
      await raise();
      const [ask] = await asks(id);
      await answer(holder, ask.id, "decline");
      await dial("announce");
      expect(await claim()).toMatchObject({ kind: "idle" });
      await withTenant(receiptPool, A.accountId, holder, (c) => c.query("SELECT agent_run_approve($1)", [id]));
      expect(await claim()).toMatchObject({ kind: "claimed", runId: id });
      expect(await runRow(id)).toMatchObject({ status: "running", approved_by: holder });
    });

    it("the read model does not call a declined run runnable without approval, and other roles cannot call the function", async () => {
      await consent(holder, runner);
      await dial("announce");
      const id = await pending();
      const runnable = async () => (await withTenant(receiptPool, A.accountId, (c) => c.query<{ r: boolean }>("SELECT EXISTS (SELECT 1 FROM runners r WHERE r.account_id = $1 AND r.revoked_at IS NULL AND r.credential_mode = 'subscription' AND runner_plan_auto_approvable(r.id, $2) AND NOT runner_plan_declined($3)) AS r", [A.accountId, A.repoId, id]))).rows[0]!.r;
      expect(await runnable()).toBe(true);
      await dial("ask");
      await raise();
      await answer(holder, (await asks(id))[0].id, "decline");
      await dial("announce");
      expect(await runnable()).toBe(false);
      const priv = async (role: string) => (await admin.query("SELECT has_function_privilege($1, 'runner_plan_declined(uuid)', 'EXECUTE') AS ok", [role])).rows[0].ok;
      expect([await priv("app_user"), await priv("agent_run_writer"), await priv("runner_auto_approve_definer")]).toEqual([true, true, true]);
      expect([await priv("public"), await priv("platform_ops")]).toEqual([false, false]);
    });
  });

  describe("one run whose ask fails does not starve the rest (follow-up 4)", () => {
    it("the failing run is skipped and reported by its id, the others are asked about, and a later call tries the failing one again", async () => {
      const bad = await pending();
      const good1 = await pending();
      const good2 = await pending();
      await admin.query(`CREATE OR REPLACE FUNCTION fx_bad_ask() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.run_id = '${bad}' THEN RAISE EXCEPTION 'forced failure' USING ERRCODE = 'check_violation'; END IF; RETURN NEW; END $$`);
      await admin.query("CREATE TRIGGER fx_bad_ask BEFORE INSERT ON decision_asks FOR EACH ROW EXECUTE FUNCTION fx_bad_ask()");
      try {
        const failed: { runId: string; code: unknown }[] = [];
        const run = () => createRunnerPlanAsk(receiptPool, { onFailure: (runId, e) => failed.push({ runId, code: (e as { code?: unknown }).code }) })({ accountId: A.accountId, runnerId: runner, roles: ROLES });
        expect(await run()).toBe(2);
        expect(failed).toEqual([{ runId: bad, code: "23514" }]);
        expect((await asks(bad))).toEqual([]);
        expect((await links()).map((l) => l.run_id).sort()).toEqual([good1, good2].sort());
        expect(await run()).toBe(0); // the good ones are not asked twice; the bad one fails again, visibly
        expect(failed).toHaveLength(2);
        // The claim path goes on: its answer is unchanged and the failure does not escape it.
        expect(await claim()).toMatchObject({ kind: "idle" });
        // Once the cause is gone, the same run is asked about.
        await admin.query("DROP TRIGGER fx_bad_ask ON decision_asks");
        expect(await run()).toBe(1);
        expect(await asks(bad)).toHaveLength(1);
      } finally {
        await admin.query("DROP TRIGGER IF EXISTS fx_bad_ask ON decision_asks");
        await admin.query("DROP FUNCTION IF EXISTS fx_bad_ask()");
      }
    });

    it("the work per call is bounded: at most five asks are raised in one call", async () => {
      for (let i = 0; i < 8; i++) await pending();
      expect(await raise()).toBe(5);
      expect(await raise()).toBe(3);
    });
  });

  describe("a busy runner still raises the ask (follow-up check)", () => {
    it("a claim that hands out another run still raises the waiting run's ask", async () => {
      const own = await pending({ initiatedBy: holder });
      const waiting = await pending();
      expect(await claim()).toMatchObject({ kind: "claimed", runId: own });
      expect(await asks(waiting)).toHaveLength(1);
    });
  });
});
