import { randomInt, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { startAgentRun, type StartAgentRunInput } from "../src/startAgentRun.js";
import { SandboxTarget } from "../src/targets/sandboxTarget.js";
import { sandboxNameFor } from "../src/sandboxNaming.js";
import { createSandboxTargetHarness } from "./helpers/sandboxTargetFakes.js";
import { pgHarness } from "./helpers/pgHarness.js";
import { seedAccount, seedMember, seedRepo, seedWorkItem } from "./helpers/seed.js";

/**
 * The sandbox name the runner records, and the gh-proxy's own lookup finding the run by it. [pg]
 *
 * Real database, real migrations, and the proxy's real resolver: `resolve_sandbox_run` (0696), called as a login that
 * is a member of `run_binding_resolver` and of nothing else. The runner side is the real `SandboxTarget` writing
 * through the runner's own login. Nothing is stubbed on the database side.
 */
describe("the run's sandbox name: written by the runner, found by the gh-proxy's resolver [pg]", () => {
  const db = pgHarness();
  const PROXY_LOGIN = "fx_runner_test_proxy";
  let proxyPool: Pool;
  let platformOpsPool: Pool;

  beforeAll(async () => {
    await db.admin.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PROXY_LOGIN}') THEN
          CREATE ROLE ${PROXY_LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        END IF;
      END $$`);
    await db.admin.query(`GRANT run_binding_resolver TO ${PROXY_LOGIN}`);
    const url = new URL(process.env.RUNNER_DATABASE_URL!);
    url.username = PROXY_LOGIN;
    url.password = "";
    proxyPool = createPool(url.toString());
    platformOpsPool = createPool(process.env.RUNNER_DATABASE_URL_PLATFORM_OPS!);
  });
  afterAll(async () => {
    await proxyPool.end();
    await platformOpsPool.end();
  });

  /** A repo the proxy can resolve: an installation, and the GitHub owner and name. */
  async function seed() {
    const accountId = randomUUID();
    const repoId = randomUUID();
    const workItemId = randomUUID();
    await seedAccount(db.admin, accountId);
    await seedMember(db.admin, accountId, randomUUID());
    await seedRepo(db.admin, accountId, repoId);
    const installationId = randomUUID();
    await db.admin.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, 'team')`, [installationId, accountId, randomInt(1, 2_000_000_000)]);
    await db.admin.query(`UPDATE repos SET installation_id = $1, gh_owner = 'acme-corp', gh_name = 'widgets' WHERE id = $2`, [installationId, repoId]);
    await seedWorkItem(db.admin, accountId, workItemId, repoId, { ghNumber: 5 });
    const input: StartAgentRunInput = {
      accountId, repoId, workItemId, role: "code-reviewer", product: "team", roleCard: "rc", prompt: "p", model: "haiku-4.5", capUsd: 5,
      spend: { plan: "starter", estimateComputeUsd: 1, trigger: "foreground" },
    };
    return { accountId, repoId, input };
  }

  const resolve = async (name: string) =>
    (await proxyPool.query(`SELECT role, product, gh_owner, gh_name, gh_installation_id::text AS gh_installation_id, app_kind, is_preview FROM public.resolve_sandbox_run($1)`, [name])).rows;
  const storedName = async (runId: string) => (await db.admin.query(`SELECT sandbox_name FROM agent_runs WHERE id = $1`, [runId])).rows[0].sandbox_name as string | null;

  /** Test-only: the guard holds a recorded name for every role, so the superuser switches it off to reset a run. */
  async function clearName(runId: string) {
    await db.admin.query(`ALTER TABLE agent_runs DISABLE TRIGGER agent_runs_sandbox_name_guard`);
    await db.admin.query(`UPDATE agent_runs SET sandbox_name = NULL WHERE id = $1`, [runId]);
    await db.admin.query(`ALTER TABLE agent_runs ENABLE TRIGGER agent_runs_sandbox_name_guard`);
  }

  /** One call of the runner's write, as the runner's login inside the given tenant context. `name` undefined uses the old 7-argument form. */
  async function mark(accountId: string, runId: string, name: string | undefined, ctxAccountId = accountId) {
    const client = await db.runWriterPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.account_id', $1, true)", [ctxAccountId]);
      if (name === undefined) await client.query("SELECT agent_run_sandbox_mark($1::uuid, $2::uuid, false, null, false, null, null)", [accountId, runId]);
      else await client.query("SELECT agent_run_sandbox_mark($1::uuid, $2::uuid, false, null, false, null, null, $3::text)", [accountId, runId, name]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  it("a started run is findable by the proxy's resolver under exactly the name the sandbox was created with", async () => {
    const { accountId, repoId, input } = await seed();
    const h = createSandboxTargetHarness(db.runWriterPool);
    const result = await startAgentRun(db.runWriterPool, { sandbox: new SandboxTarget(h.deps) }, input);
    if (result.status !== "running") throw new Error("run did not start");
    const created = h.fakeSandbox.state.created[0]!.sandboxName;

    expect(created).toBe(sandboxNameFor({ role: "code-reviewer", runId: result.id, accountId, repoId, pr: undefined }));
    expect(await storedName(result.id)).toBe(created);
    expect(await resolve(created)).toEqual([
      { role: "code-reviewer", product: "team", gh_owner: "acme-corp", gh_name: "widgets", gh_installation_id: expect.any(String), app_kind: "team", is_preview: false },
    ]);
  });

  it("the name is written BEFORE the sandbox exists to make a request", async () => {
    const { input } = await seed();
    const h = createSandboxTargetHarness(db.runWriterPool);
    const seenAtCreate: Array<string | null> = [];
    const port = {
      ...h.deps.sandboxPort,
      async createSandbox(opts: Parameters<typeof h.deps.sandboxPort.createSandbox>[0]) {
        const rows = await resolve(opts.sandboxName);
        seenAtCreate.push(rows.length === 1 ? "resolvable" : null);
        return h.deps.sandboxPort.createSandbox(opts);
      },
    };
    const result = await startAgentRun(db.runWriterPool, { sandbox: new SandboxTarget({ ...h.deps, sandboxPort: port }) }, input);
    expect(result.status).toBe("running");
    expect(seenAtCreate).toEqual(["resolvable"]);
  });

  it("a second executor build on the same issue binds the SAME persistent name once the first has ended, and the proxy resolves only the live one", async () => {
    const { accountId, repoId, input } = await seed();
    const executor: StartAgentRunInput = { ...input, role: "executor", pr: 64 };
    const h = createSandboxTargetHarness(db.runWriterPool);
    const target = new SandboxTarget(h.deps);
    const first = await startAgentRun(db.runWriterPool, { sandbox: target }, executor);
    if (first.status !== "running") throw new Error("first build did not start");
    const name = sandboxNameFor({ role: "executor", runId: first.id, accountId, repoId, pr: 64 });
    expect(await storedName(first.id)).toBe(name);

    // The first build ends (needs_human): its row keeps the name, and is no longer live.
    await db.admin.query(`UPDATE agent_runs SET status = 'failed' WHERE id = $1`, [first.id]);
    const second = await startAgentRun(db.runWriterPool, { sandbox: target }, executor);
    if (second.status !== "running") throw new Error("second build did not start");

    expect(second.id).not.toBe(first.id);
    expect(await storedName(second.id)).toBe(name); // the set-once rule is per run: a new run binds the same name
    expect(await storedName(first.id)).toBe(name); // and the first run's recorded name is untouched
    expect(await resolve(name)).toHaveLength(1); // only the live run is a candidate
  });

  it("a second write cannot overwrite the name: the first stays, and the other name resolves to nothing", async () => {
    const { accountId, repoId, input } = await seed();
    const h = createSandboxTargetHarness(db.runWriterPool);
    const result = await startAgentRun(db.runWriterPool, { sandbox: new SandboxTarget(h.deps) }, input);
    if (result.status !== "running") throw new Error("run did not start");
    const first = (await storedName(result.id))!;
    const other = sandboxNameFor({ role: "reviewer", runId: result.id, accountId, repoId, pr: undefined });

    await mark(accountId, result.id, other);
    await mark(accountId, result.id, first); // writing the same name again is also a no-op

    expect(await storedName(result.id)).toBe(first);
    expect(await resolve(first)).toHaveLength(1);
    expect(await resolve(other)).toEqual([]);
  });

  it("a mark that names no sandbox leaves the stored name alone (the 7-argument form still works)", async () => {
    const { accountId, input } = await seed();
    const h = createSandboxTargetHarness(db.runWriterPool);
    const result = await startAgentRun(db.runWriterPool, { sandbox: new SandboxTarget(h.deps) }, input);
    if (result.status !== "running") throw new Error("run did not start");
    const first = (await storedName(result.id))!;
    await mark(accountId, result.id, undefined);
    expect(await storedName(result.id)).toBe(first);
  });

  it("refuses a name of the wrong shape, and a call outside the caller's own tenant context", async () => {
    const { accountId, input } = await seed();
    const h = createSandboxTargetHarness(db.runWriterPool);
    const result = await startAgentRun(db.runWriterPool, { sandbox: new SandboxTarget(h.deps) }, input);
    if (result.status !== "running") throw new Error("run did not start");
    await expect(mark(accountId, result.id, "not-a-sandbox-name")).rejects.toMatchObject({ code: "23514" });
    await expect(mark(accountId, result.id, "rn-x'; drop table agent_runs; --")).rejects.toMatchObject({ code: "23514" });
    await expect(mark(accountId, result.id, `rn-8-reviewer-${result.id}`, randomUUID())).rejects.toMatchObject({ code: "42501" });
    expect(await storedName(result.id)).not.toContain("not-a-sandbox-name");
  });

  it("an ended run no longer resolves by its name", async () => {
    const a = await seed();
    const h = createSandboxTargetHarness(db.runWriterPool);
    const result = await startAgentRun(db.runWriterPool, { sandbox: new SandboxTarget(h.deps) }, a.input);
    if (result.status !== "running") throw new Error("run did not start");
    const name = (await storedName(result.id))!;
    await db.admin.query(`UPDATE agent_runs SET status = 'failed' WHERE id = $1`, [result.id]);
    expect(await resolve(name)).toEqual([]);
  });

  it("the hotfix function is gone, the real write function is not callable by the proxy login, and agent_run_sandbox_mark has one signature", async () => {
    expect((await db.admin.query(`SELECT to_regprocedure('public.fx_hotfix_set_sandbox_name(uuid, uuid, text)') AS f`)).rows[0].f).toBeNull();
    const sigs = (await db.admin.query(`SELECT pg_get_function_identity_arguments(oid) AS args FROM pg_proc WHERE proname = 'agent_run_sandbox_mark'`)).rows;
    expect(sigs).toHaveLength(1);
    expect(sigs[0].args).toContain("p_sandbox_name text");
    await expect(proxyPool.query(`SELECT agent_run_sandbox_mark($1::uuid, $2::uuid, false, null, false, null, null, 'rn-x')`, [randomUUID(), randomUUID()])).rejects.toMatchObject({ code: "42501" });
    await expect(proxyPool.query(`UPDATE agent_runs SET sandbox_name = 'rn-x'`)).rejects.toMatchObject({ code: "42501" });
  });

  it("refuses a name that belongs to another run or another tenant, even from the runner's own login", async () => {
    const { accountId, repoId, input } = await seed();
    const b = await seed();
    const h = createSandboxTargetHarness(db.runWriterPool);
    const result = await startAgentRun(db.runWriterPool, { sandbox: new SandboxTarget(h.deps) }, input);
    if (result.status !== "running") throw new Error("run did not start");
    await clearName(result.id); // so the refusals below are the binding, not the set-once rule
    const otherRunName = sandboxNameFor({ role: "code-reviewer", runId: randomUUID(), accountId, repoId, pr: undefined });
    await expect(mark(accountId, result.id, otherRunName)).rejects.toMatchObject({ code: "23514" });
    const otherTenantName = sandboxNameFor({ role: "executor", runId: result.id, accountId: b.accountId, repoId: b.repoId, pr: 7 });
    await expect(mark(accountId, result.id, otherTenantName)).rejects.toMatchObject({ code: "23514" });
    const ownName = sandboxNameFor({ role: "executor", runId: result.id, accountId, repoId, pr: 7 });
    // The runner's own executor name for this account is accepted when the run has none recorded.
    await clearName(result.id);
    await mark(accountId, result.id, ownName);
    expect(await storedName(result.id)).toBe(ownName);
  });

  it("a direct platform_ops session cannot write sandbox_name (null or set); the definer writes it once", async () => {
    const { accountId, input } = await seed();
    const h = createSandboxTargetHarness(db.runWriterPool);
    const result = await startAgentRun(db.runWriterPool, { sandbox: new SandboxTarget(h.deps) }, input);
    if (result.status !== "running") throw new Error("run did not start");
    const direct = async (name: string) => {
      const client = await platformOpsPool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.account_id', $1, true)", [accountId]);
        await client.query("UPDATE agent_runs SET sandbox_name = $1 WHERE id = $2", [name, result.id]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    };
    const set = (await storedName(result.id))!;
    await expect(direct("rn-9-attacker-x")).rejects.toMatchObject({ code: "42501" }); // already set
    await clearName(result.id);
    await expect(direct("rn-9-attacker-x")).rejects.toMatchObject({ code: "42501" }); // null
    expect(await storedName(result.id)).toBeNull();
    await mark(accountId, result.id, set); // the definer can, once
    await expect(db.admin.query(`UPDATE agent_runs SET sandbox_name = 'rn-9-other' WHERE id = $1`, [result.id])).rejects.toMatchObject({ code: "23514" });
    expect(await storedName(result.id)).toBe(set);
  });

  it("no fx_hotfix_* function remains", async () => {
    expect((await db.admin.query(`SELECT proname FROM pg_proc WHERE proname LIKE 'fx\\_hotfix\\_%'`)).rows).toEqual([]);
  });
});
