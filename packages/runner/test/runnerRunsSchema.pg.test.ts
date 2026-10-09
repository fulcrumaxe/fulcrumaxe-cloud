import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createPool } from "@fx/db/src/pool.js";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { insertAgentRun, writeRunStatus, writeRunnerJob } from "../src/runStatusWriter.js";
import { seedAccount, seedMember, seedRepo } from "./helpers/seed.js";
import { pgHarness } from "./helpers/pgHarness.js";

/**
 * D#6 R3a, migration 0714: the widened `agent_runs_execution_mode_check`, the one-way runtime CHECK, `initiated_by` on
 * insert through `agent_run_create`, and `agent_run_set_runner_job`. Each guard here has a test that fails if the guard is
 * taken out.
 */
describe("0714 runner runs [pg]", () => {
  const db = pgHarness();

  const JOB = { schema_version: 1, job_id: "j1" };

  async function world() {
    const accountId = randomUUID();
    const userId = randomUUID();
    const repoId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedMember(db.admin, accountId, userId);
    await seedRepo(db.admin, accountId, repoId, { executionMode: "runner_local" });
    return { accountId, userId, repoId };
  }

  /** A run through the real writer, so the definer's own rules apply. */
  async function runnerRun(w: { accountId: string; userId: string; repoId: string }, over: { mode?: string | null; runtime?: "runner" | "production" } = {}) {
    const { id } = await insertAgentRun(db.runWriterPool, {
      id: randomUUID(),
      accountId: w.accountId,
      role: "code-reviewer",
      runtime: over.runtime ?? "runner",
      executionMode: over.mode === undefined ? "runner_local" : over.mode,
      dispatchRepoId: w.repoId,
      initiatedBy: w.userId,
    });
    return id;
  }

  const jobOf = async (id: string) => (await db.admin.query(`SELECT job_signed FROM agent_runs WHERE id = $1`, [id])).rows[0].job_signed;

  describe("agent_runs_execution_mode_check", () => {
    const insertWith = (accountId: string, mode: string | null, runtime = "runner") =>
      db.admin.query(`INSERT INTO agent_runs (account_id, role, runtime, status, execution_mode) VALUES ($1, 'code-reviewer', $2, 'pending', $3)`, [accountId, runtime, mode]);

    it("allows sandbox, runner_local, runner_verified (since 0765) and none; refuses anything else", async () => {
      const w = await world();
      await insertWith(w.accountId, "sandbox", "production");
      await insertWith(w.accountId, "runner_local");
      await insertWith(w.accountId, "runner_verified");
      await insertWith(w.accountId, null);
      for (const mode of ["runner", "Runner_Local", "Runner_Verified", ""]) {
        await expect(insertWith(w.accountId, mode), mode).rejects.toThrow(/agent_runs_execution_mode_check/);
      }
    });
  });

  describe("the one-way CHECK: runner_local needs runtime 'runner'", () => {
    const insertWith = (accountId: string, mode: string | null, runtime: string) =>
      db.admin.query(`INSERT INTO agent_runs (account_id, role, runtime, status, execution_mode) VALUES ($1, 'code-reviewer', $2, 'pending', $3)`, [accountId, runtime, mode]);

    it.each(["production", "local"])("a runner_local run with runtime '%s' is refused", async (runtime) => {
      const w = await world();
      await expect(insertWith(w.accountId, "runner_local", runtime)).rejects.toThrow(/agent_runs_runner_local_runtime_check/);
    });

    it("the same refusal comes through the writer, and no row is left", async () => {
      const w = await world();
      await expect(runnerRun(w, { runtime: "production" })).rejects.toThrow(/agent_runs_runner_local_runtime_check/);
      expect((await db.admin.query(`SELECT 1 FROM agent_runs WHERE account_id = $1`, [w.accountId])).rows).toHaveLength(0);
    });

    it("the reverse is not constrained: a 'runner' run may carry sandbox or no mode", async () => {
      const w = await world();
      await insertWith(w.accountId, "sandbox", "runner");
      await insertWith(w.accountId, null, "runner");
      await insertWith(w.accountId, "runner_local", "runner");
    });
  });

  describe("agent_run_create: initiated_by", () => {
    it("is stored for a member of the account", async () => {
      const w = await world();
      const id = await runnerRun(w);
      expect((await db.admin.query(`SELECT initiated_by FROM agent_runs WHERE id = $1`, [id])).rows[0].initiated_by).toBe(w.userId);
    });

    it("is NULL when nobody started the run, and the old 13-argument call shape still works", async () => {
      const w = await world();
      const id = randomUUID();
      await withTenant(db.runWriterPool, w.accountId, (c) =>
        c.query(
          `SELECT agent_run_create($1::uuid, $2::uuid, NULL, NULL, 'code-reviewer', 'production', NULL, NULL, NULL, NULL, NULL, jsonb_build_object('accountId', $2::uuid::text), repeat('a', 64))`,
          [id, w.accountId],
        ),
      );
      expect((await db.admin.query(`SELECT initiated_by FROM agent_runs WHERE id = $1`, [id])).rows[0].initiated_by).toBeNull();
    });

    it("refuses a user who is not a member (42501), a member of another account, and a user who does not exist", async () => {
      const w = await world();
      const other = await world();
      const stranger = randomUUID();
      await db.admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [stranger, `${stranger}@fixture.test`]);
      for (const who of [stranger, other.userId]) {
        await expect(runnerRun({ ...w, userId: who })).rejects.toMatchObject({ code: "42501" });
      }
      await expect(runnerRun({ ...w, userId: randomUUID() })).rejects.toMatchObject({ code: "42501" });
      expect((await db.admin.query(`SELECT 1 FROM agent_runs WHERE account_id = $1`, [w.accountId])).rows).toHaveLength(0);
    });

    it("cannot be changed afterwards, by anyone: a member, no one, a superuser", async () => {
      const w = await world();
      const other = randomUUID();
      await seedMember(db.admin, w.accountId, other);
      const id = await runnerRun(w);
      for (const value of [other, null]) {
        await expect(db.admin.query(`UPDATE agent_runs SET initiated_by = $2 WHERE id = $1`, [id, value])).rejects.toMatchObject({ code: "42501" });
      }
      expect((await db.admin.query(`SELECT initiated_by FROM agent_runs WHERE id = $1`, [id])).rows[0].initiated_by).toBe(w.userId);
    });

    it("the definer is the only way in: a plain app_user login cannot insert or call it", async () => {
      const w = await world();
      await expect(
        withTenant(db.pureAppUserPool, w.accountId, (c) =>
          c.query(`INSERT INTO agent_runs (account_id, role, runtime, status, initiated_by) VALUES ($1, 'code-reviewer', 'runner', 'pending', $2)`, [w.accountId, w.userId]),
        ),
      ).rejects.toMatchObject({ code: "42501" });
    });
  });

  describe("a direct platform_ops login (the web tier's live login) cannot go around the definers", () => {
    let platformOpsPool: Pool;
    beforeAll(() => {
      platformOpsPool = createPool(process.env.RUNNER_DATABASE_URL_PLATFORM_OPS!);
    });
    afterAll(async () => {
      await platformOpsPool.end();
    });

    /** Runs `sql` as the platform_ops login with the tenant context set, in a transaction that is rolled back on failure. */
    async function direct(accountId: string, sql: string, params: unknown[]): Promise<void> {
      const client = await platformOpsPool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.account_id', $1, true)", [accountId]);
        await client.query(sql, params);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    }

    it("a direct UPDATE of job_signed is refused (42501) on a pending runner run and on a sandbox run, and nothing is planted", async () => {
      const w = await world();
      const runner = await runnerRun(w);
      const sandbox = (await db.admin.query<{ id: string }>(`INSERT INTO agent_runs (account_id, role, runtime, status, execution_mode) VALUES ($1, 'code-reviewer', 'production', 'pending', 'sandbox') RETURNING id`, [w.accountId])).rows[0]!.id;
      for (const id of [runner, sandbox]) {
        await expect(direct(w.accountId, `UPDATE agent_runs SET job_signed = '{"x":1}'::jsonb WHERE id = $1`, [id])).rejects.toMatchObject({ code: "42501" });
        expect(await jobOf(id)).toBeNull();
      }
      // The real job can still be written.
      expect(await writeRunnerJob(db.runWriterPool, { accountId: w.accountId, runId: runner, job: JOB })).toBe(true);
    });

    it("a direct INSERT naming a user who is not a member as initiated_by is refused (42501), and no row is left", async () => {
      const w = await world();
      const stranger = randomUUID();
      await db.admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [stranger, `${stranger}@fixture.test`]);
      for (const who of [stranger, w.userId]) {
        await expect(
          direct(w.accountId, `INSERT INTO agent_runs (account_id, role, runtime, status, initiated_by) VALUES ($1, 'code-reviewer', 'runner', 'pending', $2)`, [w.accountId, who]),
        ).rejects.toMatchObject({ code: "42501" });
      }
      expect((await db.admin.query(`SELECT 1 FROM agent_runs WHERE account_id = $1`, [w.accountId])).rows).toHaveLength(0);
    });

    it("both definers refuse the platform_ops login outright (42501)", async () => {
      const w = await world();
      const id = await runnerRun(w);
      await expect(direct(w.accountId, `SELECT agent_run_set_runner_job($1::uuid, $2::uuid, '{}'::jsonb)`, [w.accountId, id])).rejects.toMatchObject({ code: "42501" });
      await expect(
        direct(w.accountId, `SELECT agent_run_create($1::uuid, $2::uuid, NULL, NULL, 'code-reviewer', 'production', NULL, NULL, NULL, NULL, NULL, jsonb_build_object('accountId', $2::uuid::text), repeat('a', 64))`, [randomUUID(), w.accountId]),
      ).rejects.toMatchObject({ code: "42501" });
      expect(await jobOf(id)).toBeNull();
    });
  });

  describe("the two guard trigger functions are not platform_ops's to change (owned by the migration role, invoker)", () => {
    const FUNCS = ["agent_runs_runner_columns_guard", "agent_runs_runner_insert_guard"] as const;
    const TRIGGERS = ["agent_runs_runner_columns_guard", "agent_runs_runner_insert_guard"] as const;
    let opsPool: Pool;
    beforeAll(() => {
      opsPool = createPool(process.env.RUNNER_DATABASE_URL_PLATFORM_OPS!);
    });
    afterAll(async () => {
      await opsPool.end();
    });

    const attempts: Array<[string, (f: string) => string]> = [
      ["DROP", (f) => `DROP FUNCTION ${f}()`],
      ["DROP CASCADE", (f) => `DROP FUNCTION ${f}() CASCADE`],
      ["RENAME", (f) => `ALTER FUNCTION ${f}() RENAME TO ${f}_x`],
      ["OWNER TO", (f) => `ALTER FUNCTION ${f}() OWNER TO CURRENT_USER`],
      ["IMMUTABLE", (f) => `ALTER FUNCTION ${f}() IMMUTABLE`],
      ["STABLE", (f) => `ALTER FUNCTION ${f}() STABLE`],
      ["SECURITY INVOKER", (f) => `ALTER FUNCTION ${f}() SECURITY INVOKER`],
      ["SET search_path", (f) => `ALTER FUNCTION ${f}() SET search_path = public`],
      ["CREATE OR REPLACE", (f) => `CREATE OR REPLACE FUNCTION ${f}() RETURNS trigger LANGUAGE plpgsql AS $b$ BEGIN RETURN NEW; END $b$`],
    ];
    const triggerAttempts: Array<[string, (t: string) => string]> = [
      ["DISABLE TRIGGER", (t) => `ALTER TABLE agent_runs DISABLE TRIGGER ${t}`],
      ["DROP TRIGGER", (t) => `DROP TRIGGER ${t} ON agent_runs`],
    ];

    /** Runs `ddl` as the platform_ops login in a transaction; it must be refused (42501) and the guarded writes must still be refused afterwards. Always rolled back. */
    async function refused(ddl: string): Promise<void> {
      const w = await world();
      const run = await runnerRun(w);
      const client = await opsPool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.account_id', $1, true)", [w.accountId]);
        await client.query("SAVEPOINT attempt");
        let code: string | undefined;
        try {
          await client.query(ddl);
        } catch (err) {
          code = (err as { code?: string }).code;
        }
        await client.query("ROLLBACK TO SAVEPOINT attempt");
        expect(code, ddl).toBe("42501");
        // The guarded writes are still refused after the attempt.
        await client.query("SAVEPOINT w1");
        await expect(client.query(`UPDATE agent_runs SET job_signed = '{"x":1}'::jsonb WHERE id = $1`, [run])).rejects.toMatchObject({ code: "42501" });
        await client.query("ROLLBACK TO SAVEPOINT w1");
        await client.query("SAVEPOINT w2");
        await expect(
          client.query(`INSERT INTO agent_runs (account_id, role, runtime, status, initiated_by) VALUES ($1, 'code-reviewer', 'runner', 'pending', $2)`, [w.accountId, w.userId]),
        ).rejects.toMatchObject({ code: "42501" });
        await client.query("ROLLBACK TO SAVEPOINT w2");
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
    }

    for (const f of FUNCS) {
      for (const [label, ddl] of attempts) {
        it(`${f}: ${label} by a direct platform_ops login is refused and the guard still holds`, async () => {
          await refused(ddl(f));
        });
      }
    }
    for (const t of TRIGGERS) {
      for (const [label, ddl] of triggerAttempts) {
        it(`${t}: ${label} by a direct platform_ops login is refused and the guard still holds`, async () => {
          await refused(ddl(t));
        });
      }
    }

    it("the catalog is untouched: owner is not platform_ops, plain invoker, triggers enabled", async () => {
      const fns = (
        await db.admin.query<{ proname: string; owner: string; prosecdef: boolean }>(
          `SELECT proname, pg_get_userbyid(proowner) AS owner, prosecdef FROM pg_proc WHERE proname = ANY($1) AND pronamespace = 'public'::regnamespace`,
          [[...FUNCS]],
        )
      ).rows;
      expect(fns).toHaveLength(2);
      for (const f of fns) {
        expect(f.owner).not.toBe("platform_ops");
        expect(f.prosecdef).toBe(false);
      }
      const trg = (await db.admin.query<{ tgname: string; tgenabled: string }>(`SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = 'agent_runs'::regclass AND tgname = ANY($1)`, [[...TRIGGERS]])).rows;
      expect(trg).toHaveLength(2);
      for (const t of trg) expect(t.tgenabled).toBe("O");
    });
  });

  describe("each platform_ops refusal holds on its own (the other layers dropped, as a platform_ops session, then rolled back)", () => {
    /** Drops `triggers` as the superuser, becomes platform_ops for the rest of the transaction, runs `sql`, and always rolls back. */
    async function asPlatformOps(accountId: string, triggers: string[], sql: string, params: unknown[]): Promise<void> {
      await db.admin.query("BEGIN");
      try {
        for (const t of triggers) await db.admin.query(`DROP TRIGGER ${t} ON agent_runs`);
        await db.admin.query("SELECT set_config('app.account_id', $1, true)", [accountId]);
        await db.admin.query("SET LOCAL SESSION AUTHORIZATION platform_ops");
        await db.admin.query(sql, params);
      } finally {
        await db.admin.query("ROLLBACK");
      }
    }

    it("the insert trigger refuses a non-NULL initiated_by even with the 0642 insert guard dropped", async () => {
      const w = await world();
      await expect(
        asPlatformOps(w.accountId, ["agent_runs_write_guard"], `INSERT INTO agent_runs (account_id, role, runtime, status, initiated_by) VALUES ($1, 'code-reviewer', 'runner', 'pending', $2)`, [w.accountId, randomUUID()]),
      ).rejects.toMatchObject({ code: "42501" });
    });

    it("agent_run_set_runner_job refuses the login itself, with the column trigger dropped", async () => {
      const w = await world();
      const id = await runnerRun(w);
      await expect(
        asPlatformOps(w.accountId, ["agent_runs_runner_columns_guard"], `SELECT agent_run_set_runner_job($1::uuid, $2::uuid, '{}'::jsonb)`, [w.accountId, id]),
      ).rejects.toMatchObject({ code: "42501" });
    });

    it("agent_run_create refuses the login itself, with both insert guards dropped", async () => {
      const w = await world();
      await expect(
        asPlatformOps(
          w.accountId,
          ["agent_runs_write_guard", "agent_runs_runner_insert_guard"],
          `SELECT agent_run_create($1::uuid, $2::uuid, NULL, NULL, 'code-reviewer', 'production', NULL, NULL, NULL, NULL, NULL, jsonb_build_object('accountId', $2::uuid::text), repeat('a', 64))`,
          [randomUUID(), w.accountId],
        ),
      ).rejects.toMatchObject({ code: "42501" });
    });
  });

  describe("agent_run_set_runner_job", () => {
    it("writes the job once to a pending runner_local runner run, and says so", async () => {
      const w = await world();
      const id = await runnerRun(w);
      expect(await writeRunnerJob(db.runWriterPool, { accountId: w.accountId, runId: id, job: JOB })).toBe(true);
      expect(await jobOf(id)).toEqual(JOB);
    });

    it("never writes over a job already there: the second call says false and the first job stays", async () => {
      const w = await world();
      const id = await runnerRun(w);
      await writeRunnerJob(db.runWriterPool, { accountId: w.accountId, runId: id, job: JOB });
      expect(await writeRunnerJob(db.runWriterPool, { accountId: w.accountId, runId: id, job: { schema_version: 1, job_id: "j2" } })).toBe(false);
      expect(await jobOf(id)).toEqual(JOB);
    });

    it("job_signed is write-once for every role: a superuser cannot replace or clear it", async () => {
      const w = await world();
      const id = await runnerRun(w);
      await writeRunnerJob(db.runWriterPool, { accountId: w.accountId, runId: id, job: JOB });
      await expect(db.admin.query(`UPDATE agent_runs SET job_signed = '{"x":1}'::jsonb WHERE id = $1`, [id])).rejects.toMatchObject({ code: "23514" });
      await expect(db.admin.query(`UPDATE agent_runs SET job_signed = NULL WHERE id = $1`, [id])).rejects.toMatchObject({ code: "23514" });
      expect(await jobOf(id)).toEqual(JOB);
    });

    it("refuses a run that is not pending: nothing is written", async () => {
      const w = await world();
      const id = await runnerRun(w);
      await writeRunStatus(db.runWriterPool, { accountId: w.accountId, runId: id, from: "pending", to: "running" });
      expect(await writeRunnerJob(db.runWriterPool, { accountId: w.accountId, runId: id, job: JOB })).toBe(false);
      expect(await jobOf(id)).toBeNull();
    });

    it("refuses a run whose runtime is not 'runner' (a sandbox run)", async () => {
      const w = await world();
      const id = (await db.admin.query<{ id: string }>(`INSERT INTO agent_runs (account_id, role, runtime, status, execution_mode) VALUES ($1, 'code-reviewer', 'production', 'pending', 'sandbox') RETURNING id`, [w.accountId])).rows[0]!.id;
      expect(await writeRunnerJob(db.runWriterPool, { accountId: w.accountId, runId: id, job: JOB })).toBe(false);
      expect(await jobOf(id)).toBeNull();
    });

    it("holds the runtime rule itself, not only through the one-way CHECK: with the CHECK dropped (in a transaction that is rolled back) a runner_local run stamped 'production' still takes no job", async () => {
      const w = await world();
      const id = randomUUID();
      await db.admin.query("BEGIN");
      try {
        await db.admin.query("ALTER TABLE agent_runs DROP CONSTRAINT agent_runs_runner_local_runtime_check");
        await db.admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode) VALUES ($1, $2, 'code-reviewer', 'production', 'pending', 'runner_local')`, [id, w.accountId]);
        await db.admin.query("SELECT set_config('app.account_id', $1, true)", [w.accountId]);
        const { rows } = await db.admin.query(`SELECT agent_run_set_runner_job($1::uuid, $2::uuid, '{}'::jsonb) AS written`, [w.accountId, id]);
        expect(rows[0].written).toBe(false);
        expect((await db.admin.query(`SELECT job_signed FROM agent_runs WHERE id = $1`, [id])).rows[0].job_signed).toBeNull();
      } finally {
        await db.admin.query("ROLLBACK");
      }
    });

    it("refuses a runner run that is not runner_local", async () => {
      const w = await world();
      for (const mode of ["sandbox", null]) {
        const id = await runnerRun(w, { mode });
        expect(await writeRunnerJob(db.runWriterPool, { accountId: w.accountId, runId: id, job: JOB }), String(mode)).toBe(false);
        expect(await jobOf(id)).toBeNull();
      }
    });

    it("refuses another account's run and a missing run, with no change", async () => {
      const w = await world();
      const other = await world();
      const id = await runnerRun(w);
      expect(await writeRunnerJob(db.runWriterPool, { accountId: other.accountId, runId: id, job: JOB })).toBe(false);
      expect(await writeRunnerJob(db.runWriterPool, { accountId: w.accountId, runId: randomUUID(), job: JOB })).toBe(false);
      expect(await jobOf(id)).toBeNull();
    });

    it("refuses a call whose account is not the caller's tenant context (42501)", async () => {
      const w = await world();
      const other = await world();
      const id = await runnerRun(w);
      await expect(
        withTenant(db.runWriterPool, other.accountId, (c) => c.query(`SELECT agent_run_set_runner_job($1::uuid, $2::uuid, '{}'::jsonb)`, [w.accountId, id])),
      ).rejects.toMatchObject({ code: "42501" });
      expect(await jobOf(id)).toBeNull();
    });

    it.each([["null", null], ["an array", "[1]"], ["a string", '"x"'], ["a number", "1"]])("refuses a job that is %s (22023)", async (_label, job) => {
      const w = await world();
      const id = await runnerRun(w);
      await expect(
        withTenant(db.runWriterPool, w.accountId, (c) => c.query(`SELECT agent_run_set_runner_job($1::uuid, $2::uuid, $3::jsonb)`, [w.accountId, id, job])),
      ).rejects.toMatchObject({ code: "22023" });
      expect(await jobOf(id)).toBeNull();
    });

    it("is SECURITY DEFINER, owned by platform_ops, search_path pinned, EXECUTE only for agent_run_writer; a plain app_user cannot call it", async () => {
      const { rows } = await db.admin.query(
        `SELECT p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig,
                (SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END
                          ORDER BY CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END)
                   FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE')::text[] AS executors
           FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'agent_run_set_runner_job'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ prosecdef: true, owner: "platform_ops", proconfig: ["search_path=pg_catalog, public, pg_temp"], executors: ["agent_run_writer", "platform_ops"] });
      const w = await world();
      const id = await runnerRun(w);
      await expect(
        withTenant(db.pureAppUserPool, w.accountId, (c) => c.query(`SELECT agent_run_set_runner_job($1::uuid, $2::uuid, '{}'::jsonb)`, [w.accountId, id])),
      ).rejects.toMatchObject({ code: "42501" });
    });

    it("agent_run_create keeps the same properties with its new argument", async () => {
      const { rows } = await db.admin.query(
        `SELECT p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig, pg_get_function_arguments(p.oid) AS args,
                (SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END
                          ORDER BY CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END)
                   FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE')::text[] AS executors
           FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'agent_run_create'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ prosecdef: true, owner: "platform_ops", proconfig: ["search_path=pg_catalog, public, pg_temp"], executors: ["agent_run_writer", "platform_ops", "runner_lease_definer"] });
      expect(rows[0].args).toMatch(/p_initiated_by uuid DEFAULT NULL/);
    });
  });
});
