import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { signMachineJob, verifyMachineJob, type MachineJob } from "@fulcrumaxe/runner-protocol";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { createStateCarrySealer, machineKekSource } from "@fx/model-connection";
import { HELLO_PATH, issueDueCleanups, issueEngineSessionStart, issueSystemStarts, moveEngineProject, moveProjectRoute, runnerHello, type RunnerCloudDeps, type RunPullRequestPort, type SystemStartDeps } from "../src/index.js";
import { harness, newKey, registerKey, respond, signed, type Harness, type TestKey } from "./helpers.js";

const HEAD = "e".repeat(40);
const WHOLE = "d".repeat(64);
const SEALER = createStateCarrySealer(machineKekSource({ FX_MACHINE_KEK_V1: Buffer.alloc(32, 7).toString("base64") }));
const NO_KEK = createStateCarrySealer(machineKekSource({}));

/**
 * [pg] D#845 MC-9b2d (migration 1124): the move that asks for the team's memory (a request, no start), the old machine's claim signing the carry stop, and the system issuer that signs the start once the carry is sealed.
 * Real Postgres, row security forced, the real roles (platform_ops runs the lister and the issuer), real Ed25519 signatures and the real hello route for the machines' capabilities. The carry's seal is the database's
 * own state (the upload routes have their own suite, stateCarry.pg.test.ts); GitHub is a fake that counts its calls.
 */
describe("moving the team's memory with a project [pg]", () => {
  let h: Harness;
  const jobKeys = generateKeyPairSync("ed25519");
  const keyring = { "job-key-1": jobKeys.publicKey };
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
  const startDeps = (over: Partial<SystemStartDeps> = {}): SystemStartDeps => ({ pool: h.opsPool, engineCommandSigner: async () => signer, pullRequests: () => github() as never, reportError: (e) => reports.push(e), ...over });
  const pass = (accountId: string, over: Partial<SystemStartDeps> = {}) => issueSystemStarts(startDeps(over), { accountId, cause: "state_carry" });

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
  const refusal = (p: Promise<unknown>) => p.then(() => "ok", (e: { status?: number; code?: string; extra?: { reason?: string } }) => [e.status, e.code, e.extra?.reason].filter((x) => x !== undefined).join(" "));
  type Row = { id: string; kind: string; state: string; runner_id: string; job: { job: MachineJob; key_id: string } };
  const jobs = async (r: Rig) => (await h.admin.query<Row>("SELECT id, kind, state, runner_id, job FROM machine_jobs WHERE account_id = $1 ORDER BY issued_at, id", [r.who.accountId])).rows;
  const carries = async (r: Rig) => (await h.admin.query<{ id: string; from_runner_id: string; to_runner_id: string; cleanup_id: string; failure_code: string | null; closed_reason: string | null; sealed_at: Date | null }>("SELECT id, from_runner_id, to_runner_id, cleanup_id, failure_code, closed_reason, sealed_at FROM state_carries WHERE account_id = $1 ORDER BY requested_at", [r.who.accountId])).rows;
  const cleanups = async (r: Rig) => (await h.admin.query<{ id: string; runner_id: string; reason: string }>("SELECT id, runner_id, reason FROM machine_cleanups WHERE account_id = $1 ORDER BY runner_id", [r.who.accountId])).rows;
  const placement = async (r: Rig, repoId = r.who.repoId) => (await h.admin.query<{ runner_id: string }>("SELECT runner_id FROM project_placements WHERE account_id = $1 AND repo_id = $2", [r.who.accountId, repoId])).rows[0]?.runner_id;
  const snapshot = async (r: Rig) => JSON.stringify({ placement: await placement(r), cleanups: await cleanups(r), carries: await carries(r), jobs: (await jobs(r)).map((j) => [j.id, j.state]), lists: (await h.admin.query("SELECT id, allowed_repo_ids FROM runners WHERE account_id = $1 ORDER BY id", [r.who.accountId])).rows });
  const asRunner = <T>(accountId: string, runnerId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> =>
    withTenant(h.appPool, accountId, async (c) => {
      await c.query("SELECT set_config('app.runner_id', $1, true)", [runnerId]);
      return fn(c);
    });
  const claim = (r: Rig, runnerId = r.runnerId) => asRunner(r.who.accountId, runnerId, (c) => issueDueCleanups(c, depsFor(), { runnerId }));
  /** The state the old machine's upload and seal leave: the three facts and the seal (the routes themselves are stateCarry.pg.test.ts's). */
  const seal = (carryId: string, bytes = 5) =>
    h.admin.query("UPDATE state_carries SET bytes = $2, chunks = 1, sha256 = $3, begun_at = now(), sealed_at = now() WHERE id = $1", [carryId, bytes, WHOLE]);
  /** A machine-less second repo of the same account, placed on a machine of its own, ticked. */
  async function otherRepo(r: Rig): Promise<{ repoId: string; ghRepoId: number; runnerId: string }> {
    const repoId = randomUUID();
    const ghRepoId = r.ghRepoId + 100 + Math.floor(Math.random() * 100_000);
    await h.admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) SELECT $1, account_id, installation_id, $3, product, 'acme', $4 FROM repos WHERE id = $2", [repoId, r.who.repoId, ghRepoId, `r${ghRepoId}`]);
    const { runnerId } = await machine(r.who);
    await h.admin.query("INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')", [repoId, r.who.accountId, runnerId]);
    await h.admin.query("INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)", [r.who.accountId, repoId]);
    return { repoId, ghRepoId, runnerId };
  }
  /** A signed carry start for the definer, with whatever the test wants wrong. */
  const carryJob = (o: { runnerId: string; ghRepoId: number; carry: { id: string; bytes?: number; chunks?: number; sha256?: string }; args?: Record<string, unknown> }, id = randomUUID()) => {
    const issued = new Date();
    const job: Record<string, unknown> = {
      v: 1, job_id: id, runner_id: o.runnerId, repo_gh_id: o.ghRepoId, requires_engine: "any", issued_at: issued.toISOString(), expires_at: new Date(issued.getTime() + 600_000).toISOString(),
      kind: "engine_session_start", args: { at_sha: HEAD, resume: false, operate_epoch: 1, carry: { bytes: 5, chunks: 1, sha256: WHOLE, ...o.carry }, ...o.args },
    };
    // not signed: the definer reads the job's own fields, and a forged job must reach it even where the protocol's parse would refuse it first
    return { id, issued, expires: new Date(issued.getTime() + 600_000), signed: { job, key_id: "job-key-1", signature: "forged" } };
  };
  const issueDirect = async (r: Rig, repoId: string, carryId: string, j: ReturnType<typeof carryJob>) =>
    (await h.opsPool.query<{ r: string }>("SELECT state_carry_start_issue($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::jsonb, $6, $7) AS r", [j.id, r.who.accountId, repoId, carryId, JSON.stringify(j.signed), j.issued, j.expires])).rows[0]!.r;
  const issueCode = (p: Promise<unknown>) => p.then((v) => String(v), (e: { code?: string }) => `raised ${e.code}`);

  describe("the move", () => {
    it("writes the placement, the old machine's move request, the carry and project.moved (carry on) in one transaction, signs no start and reads no GitHub", async () => {
      const r = await rig();
      const to = await machine(r.who);
      calls.github = 0;
      const out = await move(r, to.runnerId, { pullRequests: null, engineCommandSigner: async () => null });
      expect(out).toMatchObject({ from_runner_id: r.runnerId, to_runner_id: to.runnerId, start_job_id: null, old_copy: "queued", carry: { id: expect.any(String) } });
      expect(calls.github).toBe(0);
      expect(await placement(r)).toBe(to.runnerId);
      expect(await jobs(r)).toEqual([]);
      const [cleanup] = await cleanups(r);
      expect(cleanup).toMatchObject({ runner_id: r.runnerId, reason: "move" });
      expect(await carries(r)).toEqual([expect.objectContaining({ id: out.carry!.id, from_runner_id: r.runnerId, to_runner_id: to.runnerId, cleanup_id: cleanup!.id, failure_code: null, closed_reason: null, sealed_at: null })]);
      const moved = (await h.admin.query<{ payload: Record<string, unknown> }>("SELECT payload FROM audit_log WHERE account_id = $1 AND action = 'project.moved'", [r.who.accountId])).rows;
      expect(moved.map((m) => m.payload)).toEqual([expect.objectContaining({ repo_id: r.who.repoId, from_runner_id: r.runnerId, to_runner_id: to.runnerId, carry: "on" })]);
    });

    it("the move route answers the carry (and 409 with the reason body for a refused tick)", async () => {
      const r = await rig();
      const to = await machine(r.who);
      const ok = await moveProjectRoute(depsFor(), as(r), r.who.repoId, { to_runner_id: to.runnerId, carry_state: true });
      expect(ok).toMatchObject({ status: 200, body: { repo_id: r.who.repoId, from_runner_id: r.runnerId, to_runner_id: to.runnerId, old_copy: "queued", carry: { id: (await carries(r))[0]!.id } } });
      const weak = await rig();
      const wto = await machine(weak.who, { caps: ["engine_session_v1"] });
      const refused = await respond(() => moveProjectRoute(depsFor(), as(weak), weak.who.repoId, { to_runner_id: wto.runnerId, carry_state: true }));
      expect(refused).toMatchObject({ status: 409, body: { error: { code: "state_carry_unavailable" }, reason: "runner_update_needed" } });
    });

    it("is atomic: a fault after the request leaves the placement, lists, cleanup, carry and audit as they were", async () => {
      const r = await rig();
      const to = await machine(r.who);
      const before = await snapshot(r);
      await h.admin.query("CREATE FUNCTION fx_carry_fault() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'injected'; END $f$");
      await h.admin.query("CREATE TRIGGER fx_carry_fault AFTER INSERT ON state_carries FOR EACH ROW EXECUTE FUNCTION fx_carry_fault()");
      try {
        await expect(move(r, to.runnerId)).rejects.toThrow("injected");
      } finally {
        await h.admin.query("DROP TRIGGER fx_carry_fault ON state_carries");
        await h.admin.query("DROP FUNCTION fx_carry_fault()");
      }
      expect(await snapshot(r)).toBe(before);
      expect((await h.admin.query("SELECT 1 FROM audit_log WHERE account_id = $1 AND action = 'project.moved'", [r.who.accountId])).rowCount).toBe(0);
    });

    it("a move without the tick is unchanged: a start is signed, carry is off and null", async () => {
      const r = await rig();
      const to = await machine(r.who);
      const out = await move(r, to.runnerId, {}, false);
      expect(out).toMatchObject({ start_job_id: expect.any(String), carry: null });
      expect((await jobs(r)).map((j) => j.kind)).toEqual(["engine_session_start"]);
      expect(await carries(r)).toEqual([]);
      expect((await h.admin.query<{ payload: { carry: string } }>("SELECT payload FROM audit_log WHERE account_id = $1 AND action = 'project.moved'", [r.who.accountId])).rows[0]!.payload.carry).toBe("off");
    });

    describe("a tick that cannot be honoured is refused with one closed reason and changes nothing", () => {
      const cases: Array<[string, (r: Rig) => Promise<{ to: string; over?: Partial<RunnerCloudDeps> }>, string]> = [
        ["the old machine was removed", async (r) => (await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [r.runnerId]), { to: (await machine(r.who)).runnerId }), "409 state_carry_unavailable source_removed"],
        ["the old machine never ran this engine", async () => ({ to: "" }), "409 state_carry_unavailable no_session"],
        ["the new machine's hello lacks the capability", async (r) => ({ to: (await machine(r.who, { caps: ["engine_session_v1"] })).runnerId }), "409 state_carry_unavailable runner_update_needed"],
        ["the old machine's hello lacks the capability", async (r) => (await h.admin.query("UPDATE runner_capabilities SET capabilities = ARRAY['engine_session_v1'] WHERE runner_id = $1", [r.runnerId]), { to: (await machine(r.who)).runnerId }), "409 state_carry_unavailable runner_update_needed"],
        ["the machine key is unset", async (r) => ({ to: (await machine(r.who)).runnerId, over: { stateCarrySealer: NO_KEK } }), "409 state_carry_unavailable machine_kek_unset"],
        ["no sealer is wired", async (r) => ({ to: (await machine(r.who)).runnerId, over: { stateCarrySealer: null } }), "409 state_carry_unavailable machine_kek_unset"],
      ];
      for (const [name, make, expected] of cases) {
        it(`${name}: ${expected}`, async () => {
          const r = await rig({ session: name.includes("never ran") ? false : true });
          const c = await make(r);
          const to = c.to === "" ? (await machine(r.who)).runnerId : c.to;
          const before = await snapshot(r);
          expect(await refusal(move(r, to, c.over ?? {}))).toBe(expected);
          expect(await snapshot(r)).toBe(before);
        });
      }
    });

    it("a second move re-targets the open carry (its source stays) and a move without the tick is refused while a carry is open", async () => {
      const r = await rig();
      const b = await machine(r.who);
      const c = await machine(r.who);
      const first = await move(r, b.runnerId);
      const again = await move(r, c.runnerId);
      expect(again.carry).toEqual(first.carry);
      expect(await carries(r)).toEqual([expect.objectContaining({ id: first.carry!.id, from_runner_id: r.runnerId, to_runner_id: c.runnerId })]);
      expect(await placement(r)).toBe(c.runnerId);
      expect((await cleanups(r)).map((x) => x.runner_id)).toEqual([r.runnerId]);
      // no tick: the carry owns the next start
      const d = await machine(r.who);
      const before = await snapshot(r);
      expect(await refusal(move(r, d.runnerId, {}, false))).toBe("409 carry_pending");
      expect(await snapshot(r)).toBe(before);
    });

    it("a move back to the carry's source while the carry is open is refused (the source still has to finish moving off) and changes nothing", async () => {
      const r = await rig();
      const b = await machine(r.who);
      await move(r, b.runnerId);
      const before = await snapshot(r);
      expect(await refusal(move(r, r.runnerId))).toBe("409 removal_pending");
      expect(await snapshot(r)).toBe(before);
    });

    it("a re-target to a machine that cannot carry is refused and the carry stays where it was", async () => {
      const r = await rig();
      const b = await machine(r.who);
      await move(r, b.runnerId);
      const weak = await machine(r.who, { caps: ["engine_session_v1"] });
      const before = await snapshot(r);
      expect(await refusal(move(r, weak.runnerId))).toBe("409 state_carry_unavailable runner_update_needed");
      expect(await snapshot(r)).toBe(before);
    });

    it("a person's Start is refused 409 carry_pending while a carry is open, sealed or not", async () => {
      const r = await rig();
      const to = await machine(r.who);
      const out = await move(r, to.runnerId);
      expect(await refusal(issueEngineSessionStart(depsFor(), as(r), r.who.repoId))).toBe("409 carry_pending");
      await seal(out.carry!.id);
      expect(await refusal(issueEngineSessionStart(depsFor(), as(r), r.who.repoId))).toBe("409 carry_pending");
      expect(await jobs(r)).toEqual([]);
    });
  });

  describe("the old machine's claim", () => {
    it("signs the stop with exactly the carry's id, and no delete while the carry is open", async () => {
      const r = await rig();
      const to = await machine(r.who);
      const out = await move(r, to.runnerId);
      expect(await claim(r)).toBe(1);
      const rows = await jobs(r);
      expect(rows.map((j) => [j.kind, j.runner_id])).toEqual([["engine_session_stop", r.runnerId]]);
      expect(verifyMachineJob(rows[0]!.job, keyring, r.runnerId)).toMatchObject({ kind: "engine_session_stop", args: { reason: "move", operate_epoch: 1, carry: { id: out.carry!.id } } });
    });

    it("a machine that lost the capability since the move gets a plain stop, and the carry fails runner_update_needed, open", async () => {
      const r = await rig();
      const to = await machine(r.who);
      const out = await move(r, to.runnerId);
      await h.admin.query("UPDATE runner_capabilities SET capabilities = ARRAY['engine_session_v1'] WHERE runner_id = $1", [r.runnerId]);
      expect(await claim(r)).toBe(1);
      const stop = (await jobs(r))[0]!;
      expect((verifyMachineJob(stop.job, keyring, r.runnerId) as { args: Record<string, unknown> }).args).toEqual({ reason: "move", operate_epoch: 1 });
      expect(await carries(r)).toEqual([expect.objectContaining({ id: out.carry!.id, failure_code: "runner_update_needed", closed_reason: null })]);
      // it keeps blocking the start, and the old copy stays
      expect(await refusal(issueEngineSessionStart(depsFor(), as(r), r.who.repoId))).toBe("409 carry_pending");
      expect((await pass(r.who.accountId)).issued).toBe(0);
    });
  });

  describe("the start the system signs once the carry is sealed", () => {
    it("signs one start for the target machine with the carry's facts, resume false and the default branch head, writes the audit with cause move_carry, and signs it once", async () => {
      const r = await rig();
      const to = await machine(r.who);
      const out = await move(r, to.runnerId);
      await seal(out.carry!.id);
      calls.github = 0;
      expect(await pass(r.who.accountId)).toEqual({ not_configured: false, issued: 1, results: [{ account_id: r.who.accountId, repo_id: r.who.repoId, result: "issued" }] });
      expect(calls.github).toBe(1);
      const [start] = await jobs(r);
      expect(start).toMatchObject({ kind: "engine_session_start", runner_id: to.runnerId, state: "issued" });
      expect(verifyMachineJob(start!.job, keyring, to.runnerId)).toMatchObject({
        kind: "engine_session_start", repo_gh_id: r.ghRepoId, args: { at_sha: HEAD, resume: false, operate_epoch: 1, carry: { id: out.carry!.id, bytes: 5, chunks: 1, sha256: WHOLE } },
      });
      const audit = (await h.admin.query<{ actor: string; payload: Record<string, unknown> }>("SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'engine_session.started'", [r.who.accountId])).rows;
      expect(audit).toEqual([{ actor: "platform_ops", payload: expect.objectContaining({ cause: "move_carry", job_id: start!.id, resume: false, at_sha: HEAD }) }]);
      expect(await pass(r.who.accountId)).toEqual({ not_configured: false, issued: 0, results: [] });
      // the carry itself is the runner's to close: the start does not
      expect((await carries(r))[0]).toMatchObject({ closed_reason: null, failure_code: null });
    });

    it("never signs while the carry is open and not sealed, or failed, however often it is asked", async () => {
      const r = await rig();
      const to = await machine(r.who);
      const out = await move(r, to.runnerId);
      for (let i = 0; i < 2; i += 1) expect(await pass(r.who.accountId)).toEqual({ not_configured: false, issued: 0, results: [] });
      await seal(out.carry!.id);
      await h.admin.query("UPDATE state_carries SET failure_code = 'expired' WHERE id = $1", [out.carry!.id]);
      expect(await pass(r.who.accountId)).toEqual({ not_configured: false, issued: 0, results: [] });
      expect(await jobs(r)).toEqual([]);
      // the definer says the same when it is called with signed bytes by hand
      const j = carryJob({ runnerId: to.runnerId, ghRepoId: r.ghRepoId, carry: { id: out.carry!.id } });
      expect(await issueCode(issueDirect(r, r.who.repoId, out.carry!.id, j))).toBe("carry_gone");
      const unsealed = await rig();
      const to2 = await machine(unsealed.who);
      const open = await move(unsealed, to2.runnerId);
      const j2 = carryJob({ runnerId: to2.runnerId, ghRepoId: unsealed.ghRepoId, carry: { id: open.carry!.id } });
      expect(await issueCode(issueDirect(unsealed, unsealed.who.repoId, open.carry!.id, j2))).toBe("carry_gone");
      expect(await jobs(unsealed)).toEqual([]);
    });

    it("signs only for the carry's target machine: not the old one, not a machine the project has since left, not a job naming another machine", async () => {
      const r = await rig();
      const b = await machine(r.who);
      const c = await machine(r.who);
      const out = await move(r, b.runnerId);
      await seal(out.carry!.id);
      // a job for the old machine, and for a machine that is not the placement
      expect(await issueCode(issueDirect(r, r.who.repoId, out.carry!.id, carryJob({ runnerId: r.runnerId, ghRepoId: r.ghRepoId, carry: { id: out.carry!.id } })))).toBe("raised 22023");
      expect(await issueCode(issueDirect(r, r.who.repoId, out.carry!.id, carryJob({ runnerId: c.runnerId, ghRepoId: r.ghRepoId, carry: { id: out.carry!.id } })))).toBe("raised 22023");
      // the project moves on to c (the carry follows it): the issuer lists and signs for c alone
      await move(r, c.runnerId);
      expect(await issueCode(issueDirect(r, r.who.repoId, out.carry!.id, carryJob({ runnerId: b.runnerId, ghRepoId: r.ghRepoId, carry: { id: out.carry!.id } })))).toBe("raised 22023");
      expect((await pass(r.who.accountId)).issued).toBe(1);
      expect((await jobs(r)).map((j) => [j.kind, j.runner_id])).toEqual([["engine_session_start", c.runnerId]]);
      // a carry whose target is not the placement any more: the placement moved without the carry (a plain move is refused, so it is done by hand)
      const q = await rig();
      const qb = await machine(q.who);
      const qc = await machine(q.who);
      const qo = await move(q, qb.runnerId);
      await seal(qo.carry!.id);
      await h.admin.query("UPDATE project_placements SET runner_id = $2 WHERE account_id = $1", [q.who.accountId, qc.runnerId]);
      expect(await issueCode(issueDirect(q, q.who.repoId, qo.carry!.id, carryJob({ runnerId: qc.runnerId, ghRepoId: q.ghRepoId, carry: { id: qo.carry!.id } })))).toBe("not_placed");
      // the lister does not even name it
      expect(await pass(q.who.accountId)).toEqual({ not_configured: false, issued: 0, results: [] });
    });

    it("binds the carry to its repo: a carry of repo X is never attached to a start for repo Y, by the pass or by hand", async () => {
      const r = await rig();
      const y = await otherRepo(r);
      const to = await machine(r.who);
      const out = await move(r, to.runnerId); // X = r.who.repoId
      await seal(out.carry!.id);
      // Y's start naming X's carry, signed correctly for Y's machine
      const forY = carryJob({ runnerId: y.runnerId, ghRepoId: y.ghRepoId, carry: { id: out.carry!.id } });
      expect(await issueCode(issueDirect(r, y.repoId, out.carry!.id, forY))).toBe("carry_gone");
      // X's start naming X's carry but carrying Y's repo identity
      const wrongRepo = carryJob({ runnerId: to.runnerId, ghRepoId: y.ghRepoId, carry: { id: out.carry!.id } });
      expect(await issueCode(issueDirect(r, r.who.repoId, out.carry!.id, wrongRepo))).toBe("raised 22023");
      expect((await h.admin.query("SELECT 1 FROM machine_jobs WHERE account_id = $1", [r.who.accountId])).rowCount).toBe(0);
      // the lister never names X's carry for Y
      const listed = (await h.opsPool.query<{ o_repo: string; o_carry: string }>("SELECT o_repo, o_carry FROM state_carry_starts_due($1::uuid, NULL, 500)", [r.who.accountId])).rows;
      expect(listed).toEqual([{ o_repo: r.who.repoId, o_carry: out.carry!.id }]);
      expect((await h.opsPool.query("SELECT 1 FROM state_carry_starts_due($1::uuid, $2::uuid, 500)", [r.who.accountId, y.repoId])).rowCount).toBe(0);
      // and the pass starts X only
      expect((await pass(r.who.accountId)).issued).toBe(1);
      expect((await jobs(r)).map((j) => [j.kind, j.runner_id, j.job.job.repo_gh_id])).toEqual([["engine_session_start", to.runnerId, r.ghRepoId]]);
    });

    it("refuses a job that does not say exactly what the carry says: another size, chunk count, sha256, a resume, an extra key or no carry", async () => {
      const r = await rig();
      const to = await machine(r.who);
      const out = await move(r, to.runnerId);
      await seal(out.carry!.id);
      const base = { runnerId: to.runnerId, ghRepoId: r.ghRepoId, carry: { id: out.carry!.id } };
      const bad: Array<ReturnType<typeof carryJob>> = [
        carryJob({ ...base, carry: { id: out.carry!.id, bytes: 6 } }),
        carryJob({ ...base, carry: { id: out.carry!.id, chunks: 2 } }),
        carryJob({ ...base, carry: { id: out.carry!.id, sha256: "e".repeat(64) } }),
        carryJob({ ...base, args: { resume: true } }),
        carryJob({ ...base, args: { extra: 1 } }),
        carryJob({ ...base, carry: { id: randomUUID() } }),
        carryJob({ ...base, args: { carry: undefined } }),
      ];
      for (const j of bad) expect(await issueCode(issueDirect(r, r.who.repoId, out.carry!.id, j))).toBe("raised 22023");
      expect(await jobs(r)).toEqual([]);
    });

    it("stops starting after 3 failed carry starts: the carry fails import_failed, open; two failures still start", async () => {
      const r = await rig();
      const to = await machine(r.who);
      const out = await move(r, to.runnerId);
      await seal(out.carry!.id);
      const fail = async () => {
        const id = (await jobs(r)).at(-1)!.id;
        await h.admin.query("UPDATE machine_jobs SET state = 'failed', delivered_at = issued_at, last_seq = 1, last_step = 'seed', failure_code = 'vm_workspace_failed', ended_at = now() WHERE id = $1", [id]);
      };
      for (let i = 0; i < 2; i += 1) {
        expect((await pass(r.who.accountId)).issued).toBe(1);
        await fail();
      }
      expect((await pass(r.who.accountId)).issued).toBe(1);
      await fail();
      expect(await pass(r.who.accountId)).toMatchObject({ issued: 0, results: [{ result: "import_failed" }] });
      expect((await carries(r))[0]).toMatchObject({ failure_code: "import_failed", closed_reason: null });
      expect((await jobs(r)).filter((j) => j.kind === "engine_session_start")).toHaveLength(3);
      expect(await pass(r.who.accountId)).toEqual({ not_configured: false, issued: 0, results: [] });
    });

    it("waits for operate and the plan: nothing is signed with operate off, and the carry stays open", async () => {
      const r = await rig();
      const to = await machine(r.who);
      const out = await move(r, to.runnerId);
      await seal(out.carry!.id);
      await h.admin.query("UPDATE engine_bridge_settings SET operate_enabled = false WHERE account_id = $1", [r.who.accountId]);
      expect(await pass(r.who.accountId)).toEqual({ not_configured: false, issued: 0, results: [] });
      await h.admin.query("UPDATE engine_bridge_settings SET operate_enabled = true WHERE account_id = $1", [r.who.accountId]);
      expect((await pass(r.who.accountId)).issued).toBe(1);
    });

    it("a project re-targeted after the seal starts on the new machine only", async () => {
      const r = await rig();
      const b = await machine(r.who);
      const c = await machine(r.who);
      const out = await move(r, b.runnerId);
      await seal(out.carry!.id);
      await move(r, c.runnerId);
      expect((await pass(r.who.accountId)).issued).toBe(1);
      expect((await jobs(r)).map((j) => [j.kind, j.runner_id])).toEqual([["engine_session_start", c.runnerId]]);
    });
  });

  describe("the claim's failing of a carry belongs to the carry's source machine", () => {
    it("another machine of the same account, with another machine's cleanup id, is refused 22023 and the carry is unchanged", async () => {
      const r = await rig();
      const to = await machine(r.who);
      const out = await move(r, to.runnerId);
      const before = JSON.stringify(await carries(r));
      const cleanup = (await cleanups(r))[0]!.id;
      const call = (runnerId: string) => asRunner(r.who.accountId, runnerId, (c) => c.query("SELECT state_carry_unsupported($1::uuid)", [cleanup]));
      await expect(call(to.runnerId)).rejects.toMatchObject({ code: "22023" });
      expect(JSON.stringify(await carries(r))).toBe(before);
      await call(r.runnerId);
      expect((await carries(r))[0]).toMatchObject({ id: out.carry!.id, failure_code: "runner_update_needed" });
    });
  });

  describe("who may run the lister and the issuer", () => {
    it("platform_ops alone: not PUBLIC, not app_user, not a person's or a runner's session", async () => {
      const row = (await h.admin.query<{ f: string; pub: boolean; app: boolean; ops: boolean }>(
        `SELECT p.proname AS f, has_function_privilege('public', p.oid, 'EXECUTE') AS pub, has_function_privilege('app_user', p.oid, 'EXECUTE') AS app, has_function_privilege('platform_ops', p.oid, 'EXECUTE') AS ops
           FROM pg_proc p WHERE p.proname IN ('state_carry_starts_due', 'state_carry_start_issue') ORDER BY p.proname`,
      )).rows;
      expect(row).toEqual([{ f: "state_carry_start_issue", pub: false, app: false, ops: true }, { f: "state_carry_starts_due", pub: false, app: false, ops: true }]);
      const r = await rig();
      await expect(withTenant(h.appPool, r.who.accountId, r.who.userId, (c) => c.query("SELECT * FROM state_carry_starts_due($1::uuid, NULL, 5)", [r.who.accountId]))).rejects.toMatchObject({ code: "42501" });
      await expect(withTenant(h.appPool, r.who.accountId, r.who.userId, (c) => c.query("SELECT state_carry_start_issue($1::uuid, $1::uuid, $1::uuid, $1::uuid, '{}'::jsonb, now(), now())", [r.who.accountId]))).rejects.toMatchObject({ code: "42501" });
      // the in-body check: a platform_ops login holding the grant is still refused when its session names a runner or a user
      const r2 = await rig();
      const to2 = await machine(r2.who);
      const out2 = await move(r2, to2.runnerId);
      await seal(out2.carry!.id);
      const j = carryJob({ runnerId: to2.runnerId, ghRepoId: r2.ghRepoId, carry: { id: out2.carry!.id } });
      for (const setting of ["app.runner_id", "app.user_id"]) {
        const c = await h.opsPool.connect();
        try {
          await c.query("SELECT set_config($1, $2, false)", [setting, randomUUID()]);
          await expect(c.query("SELECT state_carry_start_issue($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::jsonb, $6, $7)", [j.id, r2.who.accountId, r2.who.repoId, out2.carry!.id, JSON.stringify(j.signed), j.issued, j.expires])).rejects.toMatchObject({ code: "42501" });
          await expect(c.query("SELECT * FROM state_carry_starts_due($1::uuid, NULL, 5)", [r2.who.accountId])).rejects.toMatchObject({ code: "42501" });
        } finally {
          await c.query("RESET ALL");
          c.release();
        }
      }
      expect(await jobs(r2)).toEqual([]);
      // the claim's own function is the runner session's: app_user only
      const f = (await h.admin.query<{ pub: boolean; app: boolean; ops: boolean }>("SELECT has_function_privilege('public', 'state_carry_unsupported(uuid)', 'EXECUTE') AS pub, has_function_privilege('app_user', 'state_carry_unsupported(uuid)', 'EXECUTE') AS app, has_function_privilege('platform_ops', 'state_carry_unsupported(uuid)', 'EXECUTE') AS ops")).rows[0]!;
      expect(f).toEqual({ pub: false, app: true, ops: false });
    });
  });
});
