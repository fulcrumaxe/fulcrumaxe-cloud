import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { signMachineJob, type MachineJob } from "@fulcrumaxe/runner-protocol";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { createStateCarrySealer, machineKekSource } from "@fx/model-connection";
import { HELLO_PATH, abandonCarryRoute, moveEngineProject, readRepoCarries, retryCarryRoute, runnerHello, type RunnerCloudDeps, type RunPullRequestPort } from "../src/index.js";
import { harness, newKey, registerKey, respond, signed, type Harness, type TestKey } from "./helpers.js";

const HEAD = "e".repeat(40);
const WHOLE = "d".repeat(64);
const SEALER = createStateCarrySealer(machineKekSource({ FX_MACHINE_KEK_V1: Buffer.alloc(32, 7).toString("base64") }));

/**
 * [pg] D#845 MC-9b2e: the person's two controls over a carry that did not finish (Try again, Start without the memory), who may use them, and the carry field a repo's read shows. Real Postgres, row security forced, the real roles
 * and the real hello route for the machines' capabilities; the carry's own state is set the way the upload routes and the sweep leave it (their suites are stateCarry.pg.test.ts and stateCarrySweep.pg.test.ts).
 */
describe("the person's controls over a carry [pg]", () => {
  let h: Harness;
  const jobKeys = generateKeyPairSync("ed25519");
  const signer = { keyId: "job-key-1", signMachineJob: (job: MachineJob) => signMachineJob(job, "job-key-1", jobKeys.privateKey) };
  beforeAll(async () => {
    h = await harness();
  });
  const accounts: string[] = [];
  afterEach(async () => {
    await h.admin.query("DELETE FROM engine_sessions WHERE account_id = ANY ($1::uuid[])", [accounts.splice(0)]);
    expect(reports.splice(0)).toEqual([]); // the pass reports an error of its own only for a fault, never for a refusal
  });
  afterAll(() => h.close());

  const calls = { github: 0 };
  const reports: unknown[] = [];
  const github = (): RunPullRequestPort =>
    ({
      defaultBranch: async () => (calls.github++, "main"),
      branchState: async () => ({ exists: true, headOid: HEAD, aheadBy: 0, defaultBranch: "main" }),
    }) as unknown as RunPullRequestPort;
  const idle = async (): Promise<never> => {
    throw new Error("not used by these tests");
  };
  const depsFor = (over: Partial<RunnerCloudDeps> = {}): RunnerCloudDeps =>
    h.deps({
      leases: { claimRunnerRun: async () => ({ kind: "idle", retryAfter: 60 }), heartbeatRunnerRun: idle, ingestRunnerEvents: idle, beginRunnerDone: idle, finishRunnerDone: idle, gitTicketContext: idle, signGitTicket: idle },
      pullRequests: github(),
      log: () => undefined,
      stateCarrySealer: SEALER,
      engineCommandSigner: async () => signer as never,
      ...over,
    });

  interface Rig { who: SeedRefs; key: TestKey; runnerId: string; ghRepoId: number; admin: string }
  /** A machine that said hello (protocol 22) with these capabilities; eligible for a project once it holds none. */
  async function machine(who: SeedRefs, o: { caps?: string[]; key?: TestKey } = {}): Promise<{ runnerId: string; key: TestKey }> {
    const key = o.key ?? newKey();
    const runnerId = await registerKey(h.admin, who.accountId, who.userId, key);
    const hello = await respond(() => runnerHello(h.deps(), signed(key, HELLO_PATH, {
      protocol_version: 22, binary_version: "0.5.0", model_auth_present: true, isolation: "host_sandbox", capabilities: o.caps ?? ["engine_session_v1", "engine_carry_v1"], facts: { os: "linux", arch: "x64", mem_gb_bucket: 16, cpus: 8, sandbox_engine: "os_sandbox" },
    })));
    expect(hello.status).toBe(200);
    await h.admin.query("UPDATE runners SET last_seen_at = now() WHERE id = $1", [runnerId]);
    await h.admin.query("UPDATE runner_facts SET host_mem_avail_mb = 9000, host_disk_free_mb = 50000, host_setups_running = 0, host_load_at = now() WHERE runner_id = $1", [runnerId]);
    await h.admin.query("INSERT INTO runner_settings (runner_id, account_id, name) VALUES ($1, $2, $3)", [runnerId, who.accountId, "Studio box"]);
    return { runnerId, key };
  }
  /** A fresh account: one repo placed on one machine (its engine's sandbox listed unless `session: false`), an engine plan of one, operate on (epoch 1). */
  async function rig(o: { session?: boolean; caps?: string[] } = {}): Promise<Rig> {
    const who = await seedAccount(h.admin, randomUUID());
    accounts.push(who.accountId);
    await h.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [who.repoId]);
    const ghRepoId = Number((await h.admin.query<{ gh_repo_id: string }>("SELECT gh_repo_id FROM repos WHERE id = $1", [who.repoId])).rows[0]!.gh_repo_id);
    const { runnerId, key } = await machine(who, { caps: o.caps });
    await h.admin.query("INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')", [who.repoId, who.accountId, runnerId]);
    await h.admin.query("UPDATE accounts SET engine_quantity = 3, stripe_subscription_status = 'active' WHERE id = $1", [who.accountId]);
    await h.admin.query("INSERT INTO engine_bridge_settings (account_id, watch_enabled, operate_enabled) VALUES ($1, true, true)", [who.accountId]);
    await h.admin.query("INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)", [who.accountId, who.repoId]);
    await h.admin.query("UPDATE runners SET allowed_repo_ids = ARRAY[$2::uuid] WHERE id = $1", [runnerId, who.repoId]);
    if (o.session !== false) await h.admin.query("INSERT INTO runner_sandboxes (runner_id, slot, account_id, name, state, created_at, disk_bytes, snapshot_count) VALUES ($1, 0, $2, $3, 'running', now() - interval '1 hour', 1000, 1)", [runnerId, who.accountId, `fx-engine-${ghRepoId}`]);
    const admin = randomUUID();
    await h.admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [admin, `${admin}@example.test`]);
    await h.admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'admin')", [who.accountId, admin]);
    return { who, key, runnerId, ghRepoId, admin };
  }
  const as = (r: Rig) => ({ accountId: r.who.accountId, userId: r.who.userId });
  const move = (r: Rig, to: string, over: Partial<RunnerCloudDeps> = {}, carryState = true) => moveEngineProject(depsFor(over), as(r), { repoId: r.who.repoId, toRunnerId: to, carryState });
  type Row = { id: string; kind: string; state: string; runner_id: string; job: { job: MachineJob; key_id: string } };
  const jobs = async (r: Rig) => (await h.admin.query<Row>("SELECT id, kind, state, runner_id, job FROM machine_jobs WHERE account_id = $1 ORDER BY issued_at, id", [r.who.accountId])).rows;
  const carries = async (r: Rig) => (await h.admin.query<{ id: string; from_runner_id: string; to_runner_id: string; cleanup_id: string; failure_code: string | null; closed_reason: string | null; sealed_at: Date | null }>("SELECT id, from_runner_id, to_runner_id, cleanup_id, failure_code, closed_reason, sealed_at FROM state_carries WHERE account_id = $1 ORDER BY requested_at", [r.who.accountId])).rows;
  const cleanups = async (r: Rig) => (await h.admin.query<{ id: string; runner_id: string; reason: string }>("SELECT id, runner_id, reason FROM machine_cleanups WHERE account_id = $1 ORDER BY runner_id", [r.who.accountId])).rows;
  const placement = async (r: Rig, repoId = r.who.repoId) => (await h.admin.query<{ runner_id: string }>("SELECT runner_id FROM project_placements WHERE account_id = $1 AND repo_id = $2", [r.who.accountId, repoId])).rows[0]?.runner_id;
  const snapshot = async (r: Rig) => JSON.stringify({ placement: await placement(r), cleanups: await cleanups(r), carries: await carries(r), jobs: (await jobs(r)).map((j) => [j.id, j.state]), lists: (await h.admin.query("SELECT id, allowed_repo_ids FROM runners WHERE account_id = $1 ORDER BY id", [r.who.accountId])).rows });
  const as2 = (r: Rig, userId: string) => ({ accountId: r.who.accountId, userId });
  const failWith = (carryId: string, code = "export_failed") => h.admin.query("UPDATE state_carries SET failure_code = $2 WHERE id = $1", [carryId, code]);
  /** A project moved with the tick: the carry is open, the new machine holds no start. */
  async function moved(): Promise<{ r: Rig; to: string; carryId: string }> {
    const r = await rig();
    const to = (await machine(r.who)).runnerId;
    const out = await move(r, to);
    return { r, to, carryId: out.carry!.id };
  }
  const member = async (r: Rig, role: "member" | "admin" = "member"): Promise<string> => {
    const id = randomUUID();
    await h.admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [id, `${id}@example.test`]);
    await h.admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)", [r.who.accountId, id, role]);
    return id;
  };
  const closed = async (carryId: string) => (await h.admin.query<{ closed_reason: string | null }>("SELECT closed_reason FROM state_carries WHERE id = $1", [carryId])).rows[0]!.closed_reason;
  async function otherRepoOf(r: Rig): Promise<string> {
    const repoId = randomUUID();
    await h.admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) SELECT $1, account_id, installation_id, $3, product, 'acme', $4 FROM repos WHERE id = $2", [repoId, r.who.repoId, r.ghRepoId + 7919, "second"]);
    return repoId;
  }

  describe("Start without the memory", () => {
    it("closes the carry abandoned and signs the plain start for the new machine, once", async () => {
      const { r, to, carryId } = await moved();
      await failWith(carryId);
      const out = await abandonCarryRoute(depsFor(), as(r), r.who.repoId, {});
      expect(out).toMatchObject({ status: 200, body: { job_id: expect.any(String) } });
      expect(await closed(carryId)).toBe("abandoned");
      const started = (await jobs(r)).filter((j) => j.kind === "engine_session_start");
      expect(started).toEqual([expect.objectContaining({ runner_id: to, state: "issued" })]);
      expect(JSON.stringify(started[0]!.job.job)).not.toContain("carry");
      expect(await respond(() => abandonCarryRoute(depsFor(), as(r), r.who.repoId, {}))).toMatchObject({ status: 409, body: { error: { code: "no_carry" } } });
    });

    it("is refused for a member, another account and a platform_ops session, and the carry is untouched", async () => {
      const { r, carryId } = await moved();
      await failWith(carryId);
      const before = await snapshot(r);
      const plain = await member(r);
      expect(await respond(() => abandonCarryRoute(depsFor(), as2(r, plain), r.who.repoId, {}))).toMatchObject({ status: 403, body: { error: { code: "forbidden" } } });
      const other = await rig();
      expect(await respond(() => abandonCarryRoute(depsFor(), as(other), r.who.repoId, {}))).toMatchObject({ status: 409, body: { error: { code: "no_carry" } } });
      // platform_ops: the definer itself refuses it, whatever route reached it
      const ops = await h.opsPool.connect();
      try {
        await ops.query("BEGIN");
        await ops.query("SELECT set_config('app.account_id', $1, true), set_config('app.user_id', $2, true)", [r.who.accountId, r.who.userId]);
        await expect(ops.query("SELECT state_carry_abandon($1::uuid)", [carryId])).rejects.toMatchObject({ code: "42501" });
      } finally {
        await ops.query("ROLLBACK");
        ops.release();
      }
      expect(await snapshot(r)).toBe(before);
      expect(await respond(() => abandonCarryRoute(depsFor(), as(r), r.who.repoId, { x: 1 }))).toMatchObject({ status: 400 });
      expect(await respond(() => abandonCarryRoute(depsFor(), as(r), "not-a-uuid", {}))).toMatchObject({ status: 404 });
    });

    it("leaves the carry closed when the start is then refused, so the person's own Start engine is the way on", async () => {
      const { r, carryId } = await moved();
      await h.admin.query("UPDATE engine_bridge_settings SET operate_enabled = false WHERE account_id = $1", [r.who.accountId]);
      expect(await respond(() => abandonCarryRoute(depsFor(), as(r), r.who.repoId, {}))).toMatchObject({ status: 409, body: { error: { code: "operate_off" } } });
      expect(await closed(carryId)).toBe("abandoned");
    });
  });

  describe("Try again", () => {
    it("closes the failed carry retried and opens a new one for the same machines", async () => {
      const { r, to, carryId } = await moved();
      await failWith(carryId, "import_failed");
      const out = await retryCarryRoute(depsFor(), as(r), r.who.repoId, {});
      const now = await carries(r);
      expect(out).toMatchObject({ status: 200, body: { carry: { id: expect.any(String) } } });
      expect(await closed(carryId)).toBe("retried");
      expect(now.filter((c) => c.closed_reason === null)).toEqual([expect.objectContaining({ id: (out.body as { carry: { id: string } }).carry.id, from_runner_id: r.runnerId, to_runner_id: to, failure_code: null })]);
      expect((await jobs(r)).filter((j) => j.kind === "engine_session_start")).toEqual([]);
    });

    it("is refused for a carry that is still running, nothing open, a member, and a machine that lost the capability (with its reason)", async () => {
      const { r, carryId } = await moved();
      expect(await respond(() => retryCarryRoute(depsFor(), as(r), r.who.repoId, {}))).toMatchObject({ status: 409, body: { error: { code: "carry_not_failed" } } });
      await failWith(carryId);
      const plain = await member(r);
      expect(await respond(() => retryCarryRoute(depsFor(), as2(r, plain), r.who.repoId, {}))).toMatchObject({ status: 403 });
      await h.admin.query("UPDATE runner_capabilities SET capabilities = ARRAY['engine_session_v1'] WHERE runner_id = $1", [r.runnerId]);
      expect(await respond(() => retryCarryRoute(depsFor(), as(r), r.who.repoId, {}))).toMatchObject({ status: 409, body: { error: { code: "state_carry_unavailable" }, reason: "runner_update_needed" } });
      expect(await closed(carryId)).toBeNull();
      const other = await rig();
      expect(await respond(() => retryCarryRoute(depsFor(), as(other), r.who.repoId, {}))).toMatchObject({ status: 409, body: { error: { code: "no_carry" } } });
    });

    it("refuses once the old machine was removed: only Start without the memory is left", async () => {
      const { r, carryId } = await moved();
      await failWith(carryId, "source_removed");
      await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [r.runnerId]);
      expect(await respond(() => retryCarryRoute(depsFor(), as(r), r.who.repoId, {}))).toMatchObject({ status: 409 });
      expect(await closed(carryId)).toBeNull();
    });
  });

  describe("the repo's carry field", () => {
    const read = (r: Rig, ids = [r.who.repoId]) => withTenant(h.appPool, r.who.accountId, (c) => readRepoCarries(c, r.who.accountId, ids));
    it("is absent for a repo with no open carry, and for another account's repo", async () => {
      const r = await rig();
      expect((await read(r)).size).toBe(0);
      const { r: m } = await moved();
      expect((await read(r, [m.who.repoId])).size).toBe(0);
      // Through the client that bypasses row security, the account predicate alone keeps another account's carry out.
      expect((await readRepoCarries(h.admin, r.who.accountId, [m.who.repoId])).size).toBe(0);
      expect((await readRepoCarries(h.admin, m.who.accountId, [m.who.repoId])).size).toBe(1);
    });

    it("waits for an offline old machine, then exports with its parts, then starts once sealed, and says failed with the code", async () => {
      const { r, carryId } = await moved();
      await h.admin.query("UPDATE runners SET last_seen_at = now() - interval '2 days' WHERE id = $1", [r.runnerId]);
      expect((await read(r)).get(r.who.repoId)).toEqual({ state: "waiting_machine", failure_code: null, from_name: "Studio box", to_name: "Studio box", parts_done: null, parts_total: null });
      await h.admin.query("UPDATE runners SET last_seen_at = now() WHERE id = $1", [r.runnerId]);
      expect((await read(r)).get(r.who.repoId)).toMatchObject({ state: "exporting", parts_done: null, parts_total: null });
      await h.admin.query("UPDATE state_carries SET bytes = 9000000, chunks = 3, sha256 = $2, begun_at = now() WHERE id = $1", [carryId, WHOLE]);
      await h.admin.query("INSERT INTO state_carry_chunks (account_id, carry_id, idx, size, sha256, kek_version, nonce, wrapped_dek, ciphertext) VALUES ($1, $2, 0, 4194304, $3, 1, '\\x01', '\\x01', '\\x01')", [r.who.accountId, carryId, WHOLE]);
      expect((await read(r)).get(r.who.repoId)).toMatchObject({ state: "exporting", parts_done: 1, parts_total: 3 });
      await h.admin.query("UPDATE state_carries SET sealed_at = now() WHERE id = $1", [carryId]);
      expect((await read(r)).get(r.who.repoId)).toMatchObject({ state: "starting", failure_code: null, parts_done: null });
      await failWith(carryId, "expired");
      expect((await read(r)).get(r.who.repoId)).toMatchObject({ state: "failed", failure_code: "expired" });
    });

    it("an online old machine that is paused or draining is waiting, and one that went offline after it began is still exporting with its parts", async () => {
      const { r, carryId } = await moved();
      for (const set of ["paused_at = now()", "draining = true"]) {
        await h.admin.query(`UPDATE runner_settings SET ${set} WHERE runner_id = $1`, [r.runnerId]);
        expect((await read(r)).get(r.who.repoId)).toMatchObject({ state: "waiting_machine" });
        await h.admin.query("UPDATE runner_settings SET paused_at = NULL, draining = false WHERE runner_id = $1", [r.runnerId]);
      }
      expect((await read(r)).get(r.who.repoId)).toMatchObject({ state: "exporting" });
      await h.admin.query("UPDATE state_carries SET bytes = 9000000, chunks = 3, sha256 = $2, begun_at = now() WHERE id = $1", [carryId, WHOLE]);
      await h.admin.query("UPDATE runners SET last_seen_at = now() - interval '2 days' WHERE id = $1", [r.runnerId]);
      expect((await read(r)).get(r.who.repoId)).toMatchObject({ state: "exporting", parts_done: 0, parts_total: 3 });
    });

    it("never shows a second repo of the same account the first one's carry", async () => {
      const { r } = await moved();
      const second = await otherRepoOf(r);
      expect([...(await read(r, [r.who.repoId, second])).keys()]).toEqual([r.who.repoId]);
      expect([...(await readRepoCarries(h.admin, r.who.accountId, [second])).keys()]).toEqual([]); // the repo predicate alone, with row security out of the way
    });
  });
});
