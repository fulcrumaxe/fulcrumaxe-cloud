import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Text, signJob, type Job } from "@fulcrumaxe/runner-protocol";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { approveRun, getRunWaitReason } from "@fx/runner-cloud";
import { createRunnerClaimFacade, type RunnerClaimFacade } from "../src/runnerClaims.js";

/**
 * [pg] D#6 R2b-4a (C31 acceptance 4 and C30 acceptance 4): the read model and the claim agree. For a matrix of runners and runs,
 * `getRunWaitReason` says waiting_for_approval exactly when the claim refuses the unapproved run to every live runner while at least one
 * live subscription runner covers its repo. Both sides are the real code against the real database; the claim runs for each live runner and
 * the answer is compared with what the read model said BEFORE any claim.
 */
describe("the read model and the claim agree [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  let appPool: Pool;
  const key = generateKeyPairSync("ed25519").privateKey;
  const T0 = Math.floor(Date.now() / 1000) * 1000;
  let facade: RunnerClaimFacade;

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    appPool = createPool(process.env.WORKER_DATABASE_URL_APP_USER!);
    facade = createRunnerClaimFacade(writerPool, { visibility: { visibility: async () => "private" }, now: () => Date.now(), randomBetween: (min) => min });
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool, appPool]) await p.end();
  });

  interface World {
    A: SeedRefs;
    otherRepo: string;
    u1: string;
    u2: string;
    u3: string;
  }
  async function world(): Promise<World> {
    const A = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1", [A.repoId]);
    const otherRepo = randomUUID();
    await admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, execution_mode) VALUES ($1, $2, $3, 9, 'team', 'runner_local')", [otherRepo, A.accountId, A.installationId]);
    const users: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = randomUUID();
      await admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [id, `${id}@example.test`]);
      await admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')", [A.accountId, id]);
      users.push(id);
    }
    return { A, otherRepo, u1: users[0]!, u2: users[1]!, u3: users[2]! };
  }
  interface RunnerCfg {
    mode: "api_key" | "subscription";
    live: boolean;
    covers: boolean;
    by: "u1" | "u2" | "u3";
    consent: boolean;
  }
  async function addRunner(w: World, cfg: RunnerCfg): Promise<string> {
    const by = w[cfg.by];
    const id = await insertRunner(admin, w.A.accountId, by, { credentialMode: cfg.mode });
    await admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[], allowed_roles = '{executor}', last_seen_at = now(), revoked_at = $3 WHERE id = $1", [id, [cfg.covers ? w.A.repoId : w.otherRepo], cfg.live ? null : new Date()]);
    if (cfg.consent && cfg.live) await withTenant(appPool, w.A.accountId, by, (c) => c.query("SELECT * FROM runner_plan_consent_set($1, true)", [id]));
    return id;
  }
  async function addRun(w: World, o: { initiatedBy: string | null; approvedBy?: string | null }): Promise<string> {
    const id = randomUUID();
    const job: Job = {
      schema_version: 1,
      job_id: randomUUID(),
      run_id: id,
      repo: { id: w.A.repoId, owner: "acme", name: "app", private: true },
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
      `INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, dispatch_repo_id, work_item_id, job_signed, initiated_by, approved_by)
       VALUES ($1, $2, 'executor', 'runner', 'pending', 'runner_local', $3, $4, $5::jsonb, $6, $7)`,
      [id, w.A.accountId, w.A.repoId, w.A.workItemId, JSON.stringify(signJob(job, key)), o.initiatedBy, o.approvedBy ?? null],
    );
    return id;
  }
  const dialAsk = (w: World) =>
    admin.query(`INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, version, changed_by) VALUES ($1, $2, 'runner_run_on_member_plan', 'ask', 1, $3)`, [w.A.accountId, w.A.repoId, w.A.userId]);
  const reasonOf = (w: World, runId: string) => getRunWaitReason({ appUserPool: appPool } as never, w.A.accountId, runId);

  /** Reads the reason, then lets every live runner try to claim, and returns both. */
  async function observe(w: World, runnerIds: Array<{ id: string; live: boolean }>, runId: string): Promise<{ reason: string | null; claimed: boolean }> {
    const reason = await reasonOf(w, runId);
    let claimed = false;
    for (const r of runnerIds.filter((x) => x.live)) {
      if ((await facade.claimRunnerRun({ accountId: w.A.accountId, runnerId: r.id })).kind === "claimed") {
        claimed = true;
        break;
      }
    }
    return { reason, claimed };
  }

  const modes = ["api_key", "subscription"] as const;
  const bys = ["u1", "u2", "u3"] as const;
  const cells = modes.flatMap((mode) =>
    [true, false].flatMap((live) =>
      [true, false].flatMap((covers) =>
        bys.flatMap((by) =>
          [true, false].flatMap((consent) =>
            [true, false].flatMap((ask) =>
              ([null, "u1", "u3"] as const).map((initiated) => ({ cfg: { mode, live, covers, by, consent } satisfies RunnerCfg, ask, initiated })),
            ),
          ),
        ),
      ),
    ),
  );

  it("agrees on every cell of one runner x run x dial (288 cells, unapproved runs)", { timeout: 120_000 }, async () => {
    const disagreements: string[] = [];
    let approvalCells = 0;
    for (const { cfg, ask, initiated } of cells) {
      const w = await world();
      const id = await addRunner(w, cfg);
      if (ask) await dialAsk(w);
      const run = await addRun(w, { initiatedBy: initiated ? w[initiated] : null });
      const { reason, claimed } = await observe(w, [{ id, live: cfg.live }], run);
      const coveringSubscription = cfg.live && cfg.mode === "subscription" && cfg.covers;
      const expected = !claimed && coveringSubscription;
      if (expected) approvalCells++;
      if ((reason === "waiting_for_approval") !== expected) disagreements.push(`${JSON.stringify(cfg)} ask=${ask} initiated=${initiated}: read model ${reason}, claimed=${claimed}`);
    }
    expect(disagreements).toEqual([]);
    // Not vacuous: the matrix has cells of every kind.
    expect(approvalCells).toBeGreaterThan(20);
    expect(approvalCells).toBeLessThan(cells.length / 2);
  });

  it("agrees with several runners at once: a revoked api_key runner, a non-covering one and a consenting subscription runner", async () => {
    const w = await world();
    const ids = [
      { id: await addRunner(w, { mode: "api_key", live: false, covers: true, by: "u1", consent: false }), live: false },
      { id: await addRunner(w, { mode: "api_key", live: true, covers: false, by: "u2", consent: false }), live: true },
      { id: await addRunner(w, { mode: "subscription", live: true, covers: true, by: "u3", consent: true }), live: true },
    ];
    const run = await addRun(w, { initiatedBy: w.u1 });
    expect(await observe(w, ids, run)).toEqual({ reason: null, claimed: true });
    const w2 = await world();
    const ids2 = [{ id: await addRunner(w2, { mode: "subscription", live: true, covers: true, by: "u3", consent: false }), live: true }];
    expect(await observe(w2, ids2, await addRun(w2, { initiatedBy: w2.u1 }))).toEqual({ reason: "waiting_for_approval", claimed: false });
    // An api_key runner that does not list the repo takes nothing, so it does not hide the wait for approval.
    const w3 = await world();
    const ids3 = [
      { id: await addRunner(w3, { mode: "api_key", live: true, covers: false, by: "u2", consent: false }), live: true },
      { id: await addRunner(w3, { mode: "subscription", live: true, covers: true, by: "u3", consent: false }), live: true },
    ];
    expect(await observe(w3, ids3, await addRun(w3, { initiatedBy: w3.u1 }))).toEqual({ reason: "waiting_for_approval", claimed: false });
  });

  it("a run someone already approved never reads waiting_for_approval (the button is not offered again), whoever's runner covers it", async () => {
    for (const covers of [true, false]) {
      const w = await world();
      const id = await addRunner(w, { mode: "subscription", live: true, covers, by: "u3", consent: false });
      const run = await addRun(w, { initiatedBy: w.u1, approvedBy: w.u2 });
      const { reason, claimed } = await observe(w, [{ id, live: true }], run);
      expect(claimed).toBe(false);
      expect(reason).not.toBe("waiting_for_approval");
    }
  });

  it("approving the run by hand makes it claimable by the approver's runner, and a member whose runner does not cover the repo cannot (C30 acceptance 4)", async () => {
    const w = await world();
    const stuck = await addRunner(w, { mode: "subscription", live: true, covers: false, by: "u2", consent: false });
    const good = await addRunner(w, { mode: "subscription", live: true, covers: true, by: "u3", consent: false });
    const run = await addRun(w, { initiatedBy: w.u1 });
    const deps = { appUserPool: appPool } as never;
    await expect(approveRun(deps, { accountId: w.A.accountId, userId: w.u2 }, run)).rejects.toMatchObject({ status: 409, code: "runner_not_for_repo" });
    expect((await admin.query("SELECT approved_by FROM agent_runs WHERE id = $1", [run])).rows[0].approved_by).toBeNull();
    expect(await reasonOf(w, run)).toBe("waiting_for_approval");
    expect((await facade.claimRunnerRun({ accountId: w.A.accountId, runnerId: stuck })).kind).toBe("idle");
    await expect(approveRun(deps, { accountId: w.A.accountId, userId: w.u3 }, run)).resolves.toMatchObject({ status: 200, body: { approved: true, changed: true } });
    expect(await reasonOf(w, run)).toBeNull();
    expect(await facade.claimRunnerRun({ accountId: w.A.accountId, runnerId: good })).toMatchObject({ kind: "claimed", runId: run });
  });
});
