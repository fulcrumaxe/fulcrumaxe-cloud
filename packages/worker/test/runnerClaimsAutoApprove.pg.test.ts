import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sha256Text, signJob, type Job } from "@fulcrumaxe/runner-protocol";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { createRunnerClaimFacade, type RunnerClaimFacade } from "../src/runnerClaims.js";

/**
 * [pg] D#6 R2b-4a (C31 section 2.2 and acceptance 2, 3, 5): the claim approves a run for a subscription runner's registrant by itself, and
 * only when every condition holds. Real definers (0754, 0767), the real receipt writer and a real run-writer login.
 */
describe("claim-time auto-approval [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
  const key = generateKeyPairSync("ed25519").privateKey;
  const T0 = Math.floor(Date.now() / 1000) * 1000;
  let clock = T0;
  let A: SeedRefs;
  let registrant: string;
  let teammate: string;
  let runner: string;
  let facade: RunnerClaimFacade;

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
    facade = createRunnerClaimFacade(writerPool, { visibility: { visibility: async () => "private" }, now: () => clock, randomBetween: (min) => min });
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool, appPool]) await p.end();
  });

  async function member(role: "member" | "admin" = "member"): Promise<string> {
    const id = randomUUID();
    await admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [id, `${id}@example.test`]);
    await admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)", [A.accountId, id, role]);
    return id;
  }
  async function newRunner(o: { by?: string; mode?: string; repos?: string[] } = {}): Promise<string> {
    const id = await insertRunner(admin, A.accountId, o.by ?? registrant, { credentialMode: o.mode ?? "subscription" });
    await admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[], allowed_roles = $3::text[] WHERE id = $1", [id, o.repos ?? [A.repoId], ["executor", "code-reviewer"]]);
    return id;
  }
  beforeEach(async () => {
    clock = T0;
    A = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1", [A.repoId]);
    registrant = await member();
    teammate = await member();
    runner = await newRunner();
  });

  /** A pending runner run with a real signed job and, unless said otherwise, no starter (every pipeline run). */
  async function pending(o: { initiatedBy?: string | null; approvedBy?: string | null; createdAt?: number; claimableAfter?: number | null; repoId?: string } = {}): Promise<string> {
    const id = randomUUID();
    const job: Job = {
      schema_version: 1,
      job_id: randomUUID(),
      run_id: id,
      repo: { id: o.repoId ?? A.repoId, owner: "acme", name: "app", private: true },
      role: "executor",
      mode: "local",
      spec: null,
      task: { kind: "implement", prompt: "p", prompt_sha256: sha256Text("p") },
      role_card: { text: "c", sha256: sha256Text("c") },
      role_tools_sha256: "a".repeat(64),
      continues: null,
      branch_prefix: "fx/",
      model_hint: null,
      issued_at: new Date(T0 - 1000).toISOString(),
      expires_at: new Date(T0 + 72 * 3_600_000).toISOString(),
      key_id: "k1",
    };
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, dispatch_repo_id, work_item_id, job_signed, initiated_by, approved_by, created_at, claimable_after)
       VALUES ($1, $2, 'executor', 'runner', 'pending', 'runner_local', $3, $4, $5::jsonb, $6, $7, to_timestamp($8 / 1000.0), CASE WHEN $9::bigint IS NULL THEN NULL ELSE to_timestamp($9::bigint / 1000.0) END)`,
      [id, A.accountId, o.repoId ?? A.repoId, A.workItemId, JSON.stringify(signJob(job, key)), o.initiatedBy ?? null, o.approvedBy ?? null, o.createdAt ?? T0 - 5000, o.claimableAfter ?? null],
    );
    return id;
  }
  const row = async (id: string) => (await admin.query("SELECT status, runner_id, approved_by, initiated_by FROM agent_runs WHERE id = $1", [id])).rows[0];
  const claim = (runnerId = runner) => facade.claimRunnerRun({ accountId: A.accountId, runnerId });
  const setConsent = (granted: boolean, runnerId = runner, by = registrant) =>
    withTenant(appPool, A.accountId, by, (c) => c.query("SELECT * FROM runner_plan_consent_set($1, $2)", [runnerId, granted]));
  const dial = (disposition: string, repoId = A.repoId) =>
    admin.query(
      `INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, version, changed_by)
       VALUES ($1, $2, 'runner_run_on_member_plan', $3, (SELECT COALESCE(max(version), 0) + 1 FROM decision_settings WHERE repo_id = $2 AND decision_type = 'runner_run_on_member_plan'), $4)`,
      [A.accountId, repoId, disposition, A.userId],
    );
  const autoAudit = async (runId: string) => (await admin.query("SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'runner.run_auto_approved' AND payload ->> 'run_id' = $2", [A.accountId, runId])).rows;
  const receipts = async (runId: string) => (await admin.query("SELECT class, decision_type, chosen, actor FROM decision_receipts WHERE run_id = $1", [runId])).rows;

  describe("the matrix (acceptance 2)", () => {
    const dials = ["ask", "announce", "act", "none"] as const;
    const consents = ["none", "granted", "withdrawn"] as const;
    const cells = dials.flatMap((d) => consents.flatMap((c) => [true, false].flatMap((covers) => [true, false].map((isMember) => ({ d, c, covers, isMember })))));

    it.each(cells)("dial=$d consent=$c covers=$covers registrant member=$isMember", async ({ d, c, covers, isMember }) => {
      const other = await admin.query<{ id: string }>("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, 7, 'team') RETURNING id", [randomUUID(), A.accountId, A.installationId]);
      if (!covers) await admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[] WHERE id = $1", [runner, [other.rows[0]!.id]]);
      if (d !== "none") await dial(d);
      if (c !== "none") await setConsent(true);
      if (c === "withdrawn") await setConsent(false);
      if (!isMember) {
        await admin.query("DELETE FROM account_members WHERE account_id = $1 AND user_id = $2", [A.accountId, registrant]);
        // Removing a member revokes their runners (0712's trigger); put the runner back so the membership condition is what is tested.
        await admin.query("UPDATE runners SET revoked_at = NULL, revoked_reason = NULL WHERE id = $1", [runner]);
      }
      const id = await pending();
      const result = await claim();
      const expected = d !== "ask" && c === "granted" && covers && isMember;
      if (expected) {
        expect(result).toMatchObject({ kind: "claimed", runId: id });
        expect(await row(id)).toMatchObject({ status: "running", runner_id: runner, approved_by: registrant, initiated_by: null });
        expect(await autoAudit(id)).toHaveLength(1);
        expect(await receipts(id)).toEqual([{ class: "human_over_the_loop", decision_type: "runner_run_on_member_plan", chosen: d === "act" ? "act" : "announce", actor: "policy" }]);
      } else {
        expect(result.kind).toBe("idle");
        expect(await row(id)).toMatchObject({ status: "pending", runner_id: null, approved_by: null });
        expect(await autoAudit(id)).toEqual([]);
        expect(await receipts(id)).toEqual([]);
      }
    });
  });

  it("approves a run a teammate started, and leaves initiated_by alone", async () => {
    await setConsent(true);
    const id = await pending({ initiatedBy: teammate });
    expect(await claim()).toMatchObject({ kind: "claimed", runId: id });
    expect(await row(id)).toMatchObject({ approved_by: registrant, initiated_by: teammate });
  });

  it("does not approve a run someone else already approved, and takes the registrant's own run without an auto approval", async () => {
    await setConsent(true);
    const theirs = await pending({ approvedBy: teammate });
    expect((await claim()).kind).toBe("idle");
    expect(await row(theirs)).toMatchObject({ status: "pending", approved_by: teammate });
    const mine = await pending({ initiatedBy: registrant, createdAt: T0 - 1000 });
    expect(await claim()).toMatchObject({ kind: "claimed", runId: mine });
    expect(await autoAudit(mine)).toEqual([]);
    expect(await receipts(mine)).toEqual([]);
  });

  it("does not need consent or the dial for a run the registrant started or approved (the old rule stands)", async () => {
    await dial("ask");
    const started = await pending({ initiatedBy: registrant });
    expect(await claim()).toMatchObject({ kind: "claimed", runId: started });
    await admin.query("UPDATE agent_runs SET status = 'succeeded' WHERE id = $1", [started]);
    const approved = await pending({ approvedBy: registrant });
    expect(await claim()).toMatchObject({ kind: "claimed", runId: approved });
  });

  it("prefers the registrant's own work over an older auto-approvable run, then the older run", async () => {
    await setConsent(true);
    const autoOlder = await pending({ initiatedBy: teammate, createdAt: T0 - 9000 });
    const mine = await pending({ initiatedBy: registrant, createdAt: T0 - 1000 });
    expect(await claim()).toMatchObject({ kind: "claimed", runId: mine });
    await admin.query("UPDATE agent_runs SET status = 'succeeded' WHERE id = $1", [mine]);
    expect(await claim()).toMatchObject({ kind: "claimed", runId: autoOlder });
  });

  it("an api_key runner never auto-approves, writes no approval, and still takes any run", async () => {
    const api = await newRunner({ mode: "api_key" });
    const id = await pending({ initiatedBy: teammate });
    expect(await claim(api)).toMatchObject({ kind: "claimed", runId: id });
    expect(await row(id)).toMatchObject({ approved_by: null });
    expect(await autoAudit(id)).toEqual([]);
  });

  it("consent is per runner: another runner of the same person without consent takes nothing, and a re-registered runner starts off", async () => {
    await setConsent(true);
    const second = await newRunner();
    const id = await pending({ initiatedBy: teammate });
    expect((await claim(second)).kind).toBe("idle");
    expect(await row(id)).toMatchObject({ status: "pending", approved_by: null });
    await admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [runner]);
    const again = await newRunner();
    expect((await claim(again)).kind).toBe("idle");
  });

  it("a usage-limit follow-up is not approved or claimed until its claimable_after (acceptance 3)", async () => {
    await setConsent(true);
    const id = await pending({ claimableAfter: T0 + 3_600_000 });
    expect((await claim()).kind).toBe("idle");
    expect(await row(id)).toMatchObject({ status: "pending", approved_by: null });
    expect(await autoAudit(id)).toEqual([]);
    clock = T0 + 3_600_001;
    expect(await claim()).toMatchObject({ kind: "claimed", runId: id });
    expect(await row(id)).toMatchObject({ approved_by: registrant });
  });

  it("lowering the dial to ask, or withdrawing consent, stops the next claim; a run claimed before keeps running; raising it again resumes (acceptance 5)", async () => {
    await setConsent(true);
    const first = await pending({ createdAt: T0 - 9000 });
    const second = await pending({ createdAt: T0 - 8000 });
    expect(await claim()).toMatchObject({ kind: "claimed", runId: first });
    await dial("ask");
    expect((await claim()).kind).toBe("idle");
    expect(await row(first)).toMatchObject({ status: "running", approved_by: registrant });
    expect(await row(second)).toMatchObject({ status: "pending", approved_by: null });
    await dial("announce");
    await admin.query("UPDATE agent_runs SET status = 'succeeded' WHERE id = $1", [first]);
    await setConsent(false);
    expect((await claim()).kind).toBe("idle");
    expect(await row(second)).toMatchObject({ status: "pending", approved_by: null });
    await setConsent(true);
    expect(await claim()).toMatchObject({ kind: "claimed", runId: second });
  });

  // The claim chooses a candidate, then checks the repo's visibility, then claims. These flip the dial or the consent in that gap (the
  // visibility port runs exactly there), so the claim's own transaction must re-check and refuse, writing nothing.
  it.each([
    ["the dial is lowered to ask", () => dial("ask")],
    ["the consent is withdrawn", () => setConsent(false)],
  ])("stops a claim that was already under way when %s: no approval, audit row or receipt", async (_label, change) => {
    await setConsent(true);
    const id = await pending();
    const racing = createRunnerClaimFacade(writerPool, {
      visibility: {
        visibility: async () => {
          await change();
          return "private";
        },
      },
      now: () => clock,
    });
    expect((await racing.claimRunnerRun({ accountId: A.accountId, runnerId: runner })).kind).toBe("idle");
    expect(await row(id)).toMatchObject({ status: "pending", runner_id: null, approved_by: null });
    expect(await autoAudit(id)).toEqual([]);
    expect(await receipts(id)).toEqual([]);
  });
});
