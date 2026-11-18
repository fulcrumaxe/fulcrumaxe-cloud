import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Text, signJob, type Job } from "@fulcrumaxe/runner-protocol";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { createRunnerClaimFacade, type RunnerClaimFacade } from "../src/runnerClaims.js";

/**
 * [pg] ON-2: a runner made by device approval has no repositories, and the claim gives it no job, even with a queued run waiting and the
 * executor role allowed. Giving it the repository (what placing a project on it will do) is the only change that lets it claim, so
 * the empty list is the reason. Real Postgres, the real definers and the real claim query.
 */
describe("a runner linked by device code claims nothing until a project is placed on it [pg]", () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  const key = generateKeyPairSync("ed25519").privateKey;
  const T0 = Math.floor(Date.now() / 1000) * 1000;
  let A: SeedRefs;
  let facade: RunnerClaimFacade;

  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
    facade = createRunnerClaimFacade(writerPool, { visibility: { visibility: async () => "private" }, now: () => T0, randomBetween: (min) => min });
    A = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1", [A.repoId]);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool]) await p.end();
  });

  /** Starts a code and approves it as the account's owner, through the two definers, in one transaction with the session settings the web tier sets. */
  async function linked(): Promise<string> {
    const user = randomBytes(32).toString("hex");
    const jwk = { kty: "OKP", crv: "Ed25519", x: randomBytes(32).toString("base64url") };
    await admin.query("BEGIN");
    try {
      await admin.query("SELECT set_config('app.account_id', $1, true), set_config('app.user_id', $2, true)", [A.accountId, A.userId]);
      await admin.query("SELECT runner_device_start($1, $2, $3::jsonb, $4, $5::jsonb, $6, 100, 100000)", [
        randomBytes(32).toString("hex"),
        user,
        JSON.stringify(jwk),
        randomBytes(32).toString("base64url"),
        JSON.stringify({ os: "linux", arch: "x64", kvm: false }),
        randomBytes(32).toString("hex"),
      ]);
      const out = (await admin.query("SELECT outcome, runner_id FROM runner_device_approve($1, NULL, 1000)", [user])).rows[0];
      expect(out.outcome).toBe("ok");
      await admin.query("COMMIT");
      return out.runner_id as string;
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  }

  async function pending(): Promise<string> {
    const id = randomUUID();
    const job: Job = {
      schema_version: 1,
      job_id: randomUUID(),
      run_id: id,
      repo: { id: A.repoId, owner: "acme", name: "app", private: true },
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
      `INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, dispatch_repo_id, job_signed, initiated_by)
       VALUES ($1, $2, 'executor', 'runner', 'pending', 'runner_local', $3, $4::jsonb, $5)`,
      [id, A.accountId, A.repoId, JSON.stringify(signJob(job, key)), A.userId],
    );
    return id;
  }

  it("claims no job while it has no repositories, and claims the queued run once the repository is on its list", async () => {
    const runner = await linked();
    const row = (await admin.query("SELECT allowed_repo_ids FROM runners WHERE id = $1 AND account_id = $2", [runner, A.accountId])).rows[0];
    expect(row.allowed_repo_ids).toEqual([]);
    // Everything else a claim needs is in place, so the empty repository list is the only thing that can be the reason.
    await admin.query("UPDATE runners SET allowed_roles = $2::text[], protocol_version = 30 WHERE id = $1", [runner, ["executor"]]);
    const job = await pending();
    expect((await facade.claimRunnerRun({ accountId: A.accountId, runnerId: runner })).kind).toBe("idle");
    expect((await admin.query("SELECT status, runner_id FROM agent_runs WHERE id = $1", [job])).rows[0]).toEqual({ status: "pending", runner_id: null });
    await admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[] WHERE id = $1", [runner, [A.repoId]]);
    expect(await facade.claimRunnerRun({ accountId: A.accountId, runnerId: runner })).toMatchObject({ kind: "claimed", runId: job });
  });
});
