import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MACHINE_JOB_CLAIM_PATH, signMachineJob, verifyMachineJob, type MachineJob } from "@fulcrumaxe/runner-protocol";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import {
  CLAIM_PATH, HELLO_PATH, cleanupOpen, claimRun, issueDueCleanups, issueEngineSessionStart, issueEngineSessionStop, machineJobClaimRun, moveEngineProject, readRepoRemovals, removeProjectIn, runnerHello, toResponse,
  type RunnerCloudDeps, type RunnerLeaseOps, type RunPullRequestPort,
} from "../src/index.js";
import { placedOn } from "../src/engineMove.js";
import { RunPullRequestError } from "../src/runPullRequest.js";
import { harness, newKey, registerKey, respond, signed, type Harness, type TestKey } from "./helpers.js";

const HEAD = "e".repeat(40);

/**
 * [pg] D#845 MC-9b1: the move orchestration on real Postgres, row security forced, real Ed25519 job signatures, the real definers (migrations 1082 and 1083) and the real claim route. Every refusal is checked to have
 * changed nothing (the placement, both lists, the job rows and the cleanup rows), and the old machine's side is driven through its own claim, as a runner does.
 */
describe("moving an engine to another machine [pg]", () => {
  let h: Harness;
  const jobKeys = generateKeyPairSync("ed25519");
  const keyring = { "job-key-1": jobKeys.publicKey };
  beforeAll(async () => {
    h = await harness();
  });
  // The run shares one database and other files read `engine_sessions` without naming an account: what a heartbeat here wrote must not outlive its test.
  const accounts: string[] = [];
  afterEach(async () => {
    await h.admin.query("DELETE FROM engine_sessions WHERE account_id = ANY ($1::uuid[])", [accounts.splice(0)]);
  });
  afterAll(() => h.close());

  const github = (o: { head?: string | null; fail?: "retryable" | "refused" } = {}): RunPullRequestPort =>
    ({
      defaultBranch: async () => "main",
      branchState: async () => {
        if (o.fail) throw new RunPullRequestError(o.fail === "retryable" ? "unavailable" : "rejected");
        const head = o.head === undefined ? HEAD : o.head;
        return { exists: head !== null, headOid: head, aheadBy: 0, defaultBranch: "main" };
      },
    }) as unknown as RunPullRequestPort;
  const unused = async (): Promise<never> => {
    throw new Error("not used by these tests");
  };
  const idleLeases = (): RunnerLeaseOps => ({ claimRunnerRun: async () => ({ kind: "idle", retryAfter: 60 }), heartbeatRunnerRun: unused, ingestRunnerEvents: unused, beginRunnerDone: unused, finishRunnerDone: unused, gitTicketContext: unused, signGitTicket: unused });
  const depsFor = (over: Partial<RunnerCloudDeps> = {}): RunnerCloudDeps =>
    h.deps({
      leases: idleLeases(),
      pullRequests: github(),
      log: () => undefined,
      engineCommandSigner: async () => ({ keyId: "job-key-1", signEngineCommand: () => { throw new Error("unused"); }, signMachineJob: (job: MachineJob) => signMachineJob(job, "job-key-1", jobKeys.privateKey) }) as never,
      ...over,
    });

  interface Rig { who: SeedRefs; key: TestKey; runnerId: string; ghRepoId: number; admin: string; member: string }
  async function addMember(accountId: string, role: "admin" | "member"): Promise<string> {
    const userId = randomUUID();
    await h.admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
    await h.admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)", [accountId, userId, role]);
    return userId;
  }
  /** A machine that said hello at protocol 22 with the session capability and reported enough memory and disk, so it is eligible once it holds no project. */
  async function machine(who: SeedRefs, o: { mem?: number; key?: TestKey } = {}): Promise<{ runnerId: string; key: TestKey }> {
    const key = o.key ?? newKey();
    const runnerId = await registerKey(h.admin, who.accountId, who.userId, key);
    const hello = await respond(() => runnerHello(h.deps(), signed(key, HELLO_PATH, {
      protocol_version: 22, binary_version: "0.5.0", model_auth_present: true, isolation: "host_sandbox", capabilities: ["engine_session_v1"], facts: { os: "linux", arch: "x64", mem_gb_bucket: 16, cpus: 8, sandbox_engine: "os_sandbox" },
    })));
    expect(hello.status).toBe(200);
    await h.admin.query("UPDATE runners SET last_seen_at = now() WHERE id = $1", [runnerId]);
    await h.admin.query("UPDATE runner_facts SET host_mem_avail_mb = $2, host_disk_free_mb = 50000, host_setups_running = 0, host_load_at = now() WHERE runner_id = $1", [runnerId, o.mem ?? 9000]);
    await h.admin.query("INSERT INTO runner_settings (runner_id, account_id, name) VALUES ($1, $2, $3)", [runnerId, who.accountId, "Studio box"]);
    return { runnerId, key };
  }
  /** A fresh account: one repo placed on one machine (its engine's sandbox listed unless `session: false`), an engine plan of one, and operate on (epoch 1). */
  async function rig(o: { operate?: boolean; plan?: number | null; session?: boolean } = {}): Promise<Rig> {
    const who = await seedAccount(h.admin, randomUUID());
    accounts.push(who.accountId);
    await h.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [who.repoId]);
    const ghRepoId = Number((await h.admin.query<{ gh_repo_id: string }>("SELECT gh_repo_id FROM repos WHERE id = $1", [who.repoId])).rows[0]!.gh_repo_id);
    const { runnerId, key } = await machine(who);
    await h.admin.query("INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')", [who.repoId, who.accountId, runnerId]);
    if (o.plan !== null) await h.admin.query("UPDATE accounts SET engine_quantity = $2, stripe_subscription_status = 'active' WHERE id = $1", [who.accountId, o.plan ?? 1]);
    await h.admin.query("INSERT INTO engine_bridge_settings (account_id, watch_enabled, operate_enabled) VALUES ($1, true, $2)", [who.accountId, o.operate !== false]);
    await h.admin.query("INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)", [who.accountId, who.repoId]);
    await h.admin.query("UPDATE runners SET allowed_repo_ids = ARRAY[$2::uuid] WHERE id = $1", [runnerId, who.repoId]);
    if (o.session !== false) await h.admin.query("INSERT INTO runner_sandboxes (runner_id, slot, account_id, name, state, created_at, disk_bytes, snapshot_count) VALUES ($1, 0, $2, $3, 'running', now() - interval '1 hour', 1000, 1)", [runnerId, who.accountId, `fx-engine-${ghRepoId}`]);
    return { who, key, runnerId, ghRepoId, admin: await addMember(who.accountId, "admin"), member: await addMember(who.accountId, "member") };
  }
  const as = (r: Rig, who: "owner" | "admin" | "member" = "owner") => ({ accountId: r.who.accountId, userId: who === "owner" ? r.who.userId : who === "admin" ? r.admin : r.member });
  const move = (r: Rig, to: string, over: Partial<RunnerCloudDeps> = {}, who: "owner" | "admin" | "member" = "owner", carryState?: boolean) =>
    moveEngineProject(depsFor(over), as(r, who), { repoId: r.who.repoId, toRunnerId: to, carryState });
  const refusal = async (p: Promise<unknown>) => p.then(() => "ok", (e: { status?: number; code?: string }) => `${e.status} ${e.code}`);
  type Row = { id: string; kind: string; state: string; runner_id: string; job: { job: MachineJob; key_id: string } };
  const jobs = async (r: Rig) => (await h.admin.query<Row>("SELECT id, kind, state, runner_id, job FROM machine_jobs WHERE account_id = $1 ORDER BY issued_at, id", [r.who.accountId])).rows;
  const placement = async (r: Rig) => (await h.admin.query<{ runner_id: string }>("SELECT runner_id FROM project_placements WHERE account_id = $1 AND repo_id = $2", [r.who.accountId, r.who.repoId])).rows[0]?.runner_id;
  const cleanups = async (r: Rig) => (await h.admin.query<{ repo_id: string; runner_id: string; reason: string; delete_sandbox: boolean }>("SELECT repo_id, runner_id, reason, delete_sandbox FROM machine_cleanups WHERE account_id = $1 ORDER BY runner_id", [r.who.accountId])).rows;
  /** The old machine's claim: the cleanups it owes, in its runner session. */
  const asRunner = <T>(accountId: string, runnerId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> =>
    withTenant(h.appPool, accountId, async (c) => {
      await c.query("SELECT set_config('app.runner_id', $1, true)", [runnerId]);
      return fn(c);
    });
  const claimIssue = (r: Rig, runnerId = r.runnerId, over: Partial<RunnerCloudDeps> = {}) => asRunner(r.who.accountId, runnerId, (c) => issueDueCleanups(c, depsFor(over), { runnerId }));
  const due = (r: Rig, runnerId = r.runnerId, accountId = r.who.accountId) => asRunner(accountId, runnerId, async (c) => (await c.query<{ o_repo: string; o_kind: string; o_reason: string }>("SELECT o_repo, o_kind, o_reason FROM machine_cleanup_due()")).rows);
  const finish = (id: string, state: "done" | "failed" | "expired", endedMinutesAgo = 0) =>
    h.admin.query(
      `UPDATE machine_jobs SET state = $2, delivered_at = CASE WHEN $2 = 'expired' THEN delivered_at ELSE COALESCE(delivered_at, issued_at) END,
              last_seq = CASE WHEN $2 IN ('done', 'failed') THEN 1 ELSE last_seq END, last_step = CASE $2 WHEN 'done' THEN 'done' WHEN 'failed' THEN 'admission' END,
              start_mode = CASE WHEN $2 = 'done' AND kind = 'engine_session_start' THEN 'created' END,
              failure_code = CASE WHEN $2 = 'failed' THEN 'vm_teardown_incomplete' WHEN $2 = 'expired' THEN 'job_expired' END, ended_at = now() - make_interval(mins => $3) WHERE id = $1`,
      [id, state, endedMinutesAgo],
    );
  const heartbeat = (r: Rig, runnerId: string, ageMin = 0, repoId = r.who.repoId) =>
    h.admin.query("INSERT INTO engine_sessions (account_id, runner_id, repo_id, engine_instance_id, engine_version, last_heartbeat_at) VALUES ($1, $2, $3, $4, '1.0.0', now() - make_interval(mins => $5))", [r.who.accountId, runnerId, repoId, randomUUID(), ageMin]);
  /** Everything a refused move must leave as it was. */
  const snapshot = async (r: Rig) => JSON.stringify({ placement: await placement(r), cleanups: await cleanups(r), jobs: (await jobs(r)).map((j) => [j.id, j.state]), lists: (await h.admin.query("SELECT id, allowed_repo_ids FROM runners WHERE account_id = $1 ORDER BY id", [r.who.accountId])).rows });
  /** A job row as a runner's reports would leave it, its bytes bound to its columns (the table's CHECK). Inserted as the admin role. */
  async function rawJob(r: Rig, o: { runnerId: string; kind: "engine_session_stop" | "engine_session_delete"; state: "issued" | "done"; at: Date; repoId?: string }): Promise<string> {
    const id = randomUUID();
    const expires = new Date(o.at.getTime() + 600_000);
    const job = { job: { job_id: id, kind: o.kind, runner_id: o.runnerId, issued_at: o.at.toISOString(), expires_at: expires.toISOString() } };
    await h.admin.query(
      `INSERT INTO machine_jobs (id, account_id, runner_id, repo_id, kind, job, state, issued_at, expires_at, delivered_at, last_seq, last_step, ended_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13)`,
      [id, r.who.accountId, o.runnerId, o.repoId ?? r.who.repoId, o.kind, JSON.stringify(job), o.state, o.at, expires, o.state === "issued" ? null : o.at, o.state === "done" ? 1 : null, o.state === "done" ? "done" : null, o.state === "done" ? o.at : null],
    );
    return id;
  }
  const byKind = (rows: Row[], kind: string) => rows.filter((j) => j.kind === kind);

  describe("the move", () => {
    it("moves the placement, starts the new machine at the default branch head with no resume, and leaves the old machine a move request, with no stop or delete signed yet", async () => {
      const r = await rig();
      const to = await machine(r.who);
      const out = await move(r, to.runnerId);
      expect(out).toMatchObject({ from_runner_id: r.runnerId, to_runner_id: to.runnerId, operate_epoch: 1, old_copy: "queued" });
      expect(await placement(r)).toBe(to.runnerId);
      const rows = await jobs(r);
      expect(rows.map((j) => [j.kind, j.runner_id, j.id])).toEqual([["engine_session_start", to.runnerId, out.start_job_id]]);
      expect(verifyMachineJob(rows[0]!.job, keyring, to.runnerId)).toMatchObject({ kind: "engine_session_start", repo_gh_id: r.ghRepoId, args: { at_sha: HEAD, resume: false, operate_epoch: 1 } });
      expect(await cleanups(r)).toEqual([{ repo_id: r.who.repoId, runner_id: r.runnerId, reason: "move", delete_sandbox: true }]);
      const audit = (await h.admin.query<{ action: string }>("SELECT action FROM audit_log WHERE account_id = $1 AND action IN ('project.moved', 'engine_session.started') ORDER BY action", [r.who.accountId])).rows;
      expect(audit.map((a) => a.action)).toEqual(["engine_session.started", "project.moved"]);
      const lists = await h.admin.query<{ id: string; a: string[] }>("SELECT id, allowed_repo_ids AS a FROM runners WHERE account_id = $1", [r.who.accountId]);
      expect(lists.rows.find((x) => x.id === r.runnerId)!.a).toEqual([]);
      expect(lists.rows.find((x) => x.id === to.runnerId)!.a).toEqual([r.who.repoId]);
    });

    it("an admin may move; a member may not (403) and nothing changes", async () => {
      const r = await rig();
      const to = await machine(r.who);
      const before = await snapshot(r);
      expect(await refusal(move(r, to.runnerId, {}, "member"))).toBe("403 forbidden");
      expect(await snapshot(r)).toBe(before);
      await expect(move(r, to.runnerId, {}, "admin")).resolves.toMatchObject({ to_runner_id: to.runnerId });
    });

    it("a machine that never ran this engine has nothing to clean: no request, only the placement and the start", async () => {
      const r = await rig({ session: false });
      const to = await machine(r.who);
      const out = await move(r, to.runnerId);
      expect(out.old_copy).toBe("none");
      expect(await cleanups(r)).toEqual([]);
      expect((await jobs(r)).map((j) => j.kind)).toEqual(["engine_session_start"]);
    });

    it("a machine that was removed has nothing to stop: the move is the placement and the start, with no request", async () => {
      const r = await rig();
      const to = await machine(r.who);
      await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [r.runnerId]);
      const out = await move(r, to.runnerId);
      expect(out.old_copy).toBe("none");
      expect((await jobs(r)).map((j) => [j.kind, j.runner_id])).toEqual([["engine_session_start", to.runnerId]]);
      expect(await cleanups(r)).toEqual([]);
      expect(await placement(r)).toBe(to.runnerId);
    });

    it("a start the old machine has not been handed is taken back; one it holds is left, and the old machine still gets its request", async () => {
      const undelivered = await rig({ session: false });
      const to1 = await machine(undelivered.who);
      const first = await issueEngineSessionStart(depsFor(), as(undelivered), undelivered.who.repoId);
      const out1 = await move(undelivered, to1.runnerId);
      const rows1 = await jobs(undelivered);
      expect(rows1.find((j) => j.id === first.job_id)!.state).toBe("superseded");
      expect(rows1.find((j) => j.id === out1.start_job_id)!.state).toBe("issued");
      expect(out1.old_copy).toBe("queued");

      const delivered = await rig({ session: false });
      const to2 = await machine(delivered.who);
      const held = await issueEngineSessionStart(depsFor(), as(delivered), delivered.who.repoId);
      await h.admin.query("UPDATE machine_jobs SET state = 'delivered', delivered_at = now() WHERE id = $1", [held.job_id]);
      const out2 = await move(delivered, to2.runnerId);
      expect((await jobs(delivered)).find((j) => j.id === held.job_id)!.state).toBe("delivered");
      expect(out2.old_copy).toBe("queued");
    });

    it("is atomic: a signer that fails on the start leaves the placement, the lists, the jobs and the cleanup as they were", async () => {
      const r = await rig();
      const to = await machine(r.who);
      const before = await snapshot(r);
      const failing = { engineCommandSigner: async () => ({ keyId: "job-key-1", signMachineJob: () => { throw new Error("sign failed"); } }) as never };
      await expect(move(r, to.runnerId, failing)).rejects.toThrow("sign failed");
      expect(await snapshot(r)).toBe(before);
      expect((await h.admin.query("SELECT 1 FROM audit_log WHERE account_id = $1 AND action = 'project.moved'", [r.who.accountId])).rowCount).toBe(0);
    });

    it("two moves of one repo at once make one move", async () => {
      const r = await rig();
      const a = await machine(r.who);
      const b = await machine(r.who);
      const results = await Promise.all([move(r, a.runnerId), move(r, b.runnerId)].map((p) => refusal(p)));
      expect(results.filter((x) => x === "ok")).toHaveLength(1);
      expect(results.find((x) => x !== "ok")).toMatch(/^409 (session_changed|machine_single_project)/);
      expect(byKind(await jobs(r), "engine_session_start")).toHaveLength(1);
      expect(await cleanups(r)).toHaveLength(1);
    });
  });

  describe("refusals change nothing", () => {
    const cases: Array<[string, (r: Rig) => Promise<{ to: string; over?: Partial<RunnerCloudDeps>; carry?: boolean }>, string]> = [
      ["a machine that is not the account's", async () => ({ to: randomUUID() }), "404 not_found"],
      ["a machine that is too small", async (r) => ({ to: (await machine(r.who, { mem: 1000 })).runnerId }), "409 machine_not_eligible"],
      ["the machine it is already on", async (r) => ({ to: r.runnerId }), "400 invalid_message"],
      ["a machine that already runs a project", async (r) => {
        const taken = await machine(r.who);
        const other = randomUUID();
        await h.admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) SELECT $1, account_id, installation_id, gh_repo_id + 4242, product, 'acme', 'gadgets' FROM repos WHERE id = $2", [other, r.who.repoId]);
        await h.admin.query("INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')", [other, r.who.accountId, taken.runnerId]);
        return { to: taken.runnerId };
      }, "409 machine_single_project"],
      ["the state carry (MC-9b2)", async (r) => ({ to: (await machine(r.who)).runnerId, carry: true }), "409 state_carry_unavailable"],
      ["GitHub unreadable (retryable)", async (r) => ({ to: (await machine(r.who)).runnerId, over: { pullRequests: github({ fail: "retryable" }) } }), "503 github_unavailable"],
      ["GitHub refusing", async (r) => ({ to: (await machine(r.who)).runnerId, over: { pullRequests: github({ fail: "refused" }) } }), "502 github_refused"],
      ["an empty default branch", async (r) => ({ to: (await machine(r.who)).runnerId, over: { pullRequests: github({ head: null }) } }), "409 default_branch_empty"],
      ["no GitHub port", async (r) => ({ to: (await machine(r.who)).runnerId, over: { pullRequests: null } }), "503 not_configured"],
      ["no signer", async (r) => ({ to: (await machine(r.who)).runnerId, over: { engineCommandSigner: async () => null } }), "503 not_configured"],
    ];
    for (const [name, make, expected] of cases) {
      it(`${name}: ${expected}`, async () => {
        const r = await rig();
        const c = await make(r);
        const before = await snapshot(r);
        expect(await refusal(move(r, c.to, c.over ?? {}, "owner", c.carry))).toBe(expected);
        expect(await snapshot(r)).toBe(before);
      });
    }

    it("operate off: 409 operate_off, and a repo whose own tick is off is the same", async () => {
      const off = await rig({ operate: false });
      const to = await machine(off.who);
      const before = await snapshot(off);
      expect(await refusal(move(off, to.runnerId))).toBe("409 operate_off");
      expect(await snapshot(off)).toBe(before);
      const unticked = await rig();
      const to2 = await machine(unticked.who);
      await h.admin.query("DELETE FROM engine_bridge_repos WHERE account_id = $1", [unticked.who.accountId]);
      expect(await refusal(move(unticked, to2.runnerId))).toBe("409 operate_off");
    });

    it("no covering plan: 402 plan_required", async () => {
      const r = await rig({ plan: null });
      const to = await machine(r.who);
      const before = await snapshot(r);
      expect(await refusal(move(r, to.runnerId))).toBe("402 plan_required");
      expect(await snapshot(r)).toBe(before);
    });

    it("a repo that is not placed, one of another account, and a malformed id", async () => {
      const r = await rig();
      const to = await machine(r.who);
      await h.admin.query("DELETE FROM project_placements WHERE account_id = $1", [r.who.accountId]);
      expect(await refusal(move(r, to.runnerId))).toBe("409 project_not_placed");
      const foreign = await rig();
      expect(await refusal(moveEngineProject(depsFor(), as(r), { repoId: foreign.who.repoId, toRunnerId: to.runnerId }))).toBe("404 not_found");
      expect(await refusal(moveEngineProject(depsFor(), as(r), { repoId: "nope", toRunnerId: to.runnerId }))).toBe("404 not_found");
      expect(await refusal(moveEngineProject(depsFor(), as(r), { repoId: r.who.repoId, toRunnerId: "nope" }))).toBe("404 not_found");
    });

    it("moving back to the old machine before its delete has run: 409 removal_pending, and allowed once the delete is done", async () => {
      const r = await rig();
      const to = await machine(r.who);
      await move(r, to.runnerId);
      await h.admin.query("UPDATE machine_jobs SET state = 'done', ended_at = now(), delivered_at = now(), last_seq = 1, last_step = 'done', start_mode = 'created' WHERE account_id = $1 AND kind = 'engine_session_start'", [r.who.accountId]);
      const before = await snapshot(r);
      expect(await refusal(move(r, r.runnerId))).toBe("409 removal_pending");
      expect(await snapshot(r)).toBe(before);
      await heartbeat(r, to.runnerId);
      await claimIssue(r);
      const [stop, del] = [byKind(await jobs(r), "engine_session_stop")[0]!, byKind(await jobs(r), "engine_session_delete")[0]!];
      await finish(stop.id, "done");
      await finish(del.id, "done");
      await expect(move(r, r.runnerId)).resolves.toMatchObject({ to_runner_id: r.runnerId });
    });
  });

  describe("the old machine's side, through its own claim", () => {
    it("is due the stop at once, and the delete only after the NEW session's first heartbeat", async () => {
      const r = await rig();
      const to = await machine(r.who);
      await move(r, to.runnerId);
      expect((await due(r)).map((d) => [d.o_kind, d.o_reason])).toEqual([["engine_session_stop", "move"]]);
      expect(await claimIssue(r)).toBe(1);
      const stop = byKind(await jobs(r), "engine_session_stop")[0]!;
      expect(verifyMachineJob(stop.job, keyring, r.runnerId)).toMatchObject({ kind: "engine_session_stop", repo_gh_id: r.ghRepoId, args: { reason: "move", operate_epoch: 1 } });
      await finish(stop.id, "done");
      expect(await due(r)).toEqual([]);
      // Not the old machine's own session, not one from before the move, not another repo's.
      await heartbeat(r, r.runnerId);
      await heartbeat(r, to.runnerId, 60);
      expect(await due(r)).toEqual([]);
      expect(await claimIssue(r)).toBe(0);
      await heartbeat(r, to.runnerId);
      expect((await due(r)).map((d) => d.o_kind)).toEqual(["engine_session_delete"]);
      expect(await claimIssue(r)).toBe(1);
      const del = byKind(await jobs(r), "engine_session_delete")[0]!;
      expect(verifyMachineJob(del.job, keyring, r.runnerId)).toMatchObject({ kind: "engine_session_delete", runner_id: r.runnerId, repo_gh_id: r.ghRepoId, args: { operate_epoch: 1 } });
      expect(await due(r)).toEqual([]);
      await finish(del.id, "done");
      expect(await cleanupOpen(h.admin, r.who.accountId, r.who.repoId, r.runnerId)).toBe(false);
      expect(await claimIssue(r)).toBe(0);
    });

    it("an old machine that was offline through the heartbeat gets both jobs, the stop first, on its next claim", async () => {
      const r = await rig();
      const to = await machine(r.who);
      await move(r, to.runnerId);
      await heartbeat(r, to.runnerId);
      expect(await claimIssue(r)).toBe(2);
      const rows = (await jobs(r)).filter((j) => j.runner_id === r.runnerId);
      expect(rows.map((j) => j.kind)).toEqual(["engine_session_stop", "engine_session_delete"]);
    });

    it("an expired stop is issued again, a failed one waits 60 minutes, and an expired delete is issued again", async () => {
      const r = await rig();
      const to = await machine(r.who);
      await move(r, to.runnerId);
      await claimIssue(r);
      await finish(byKind(await jobs(r), "engine_session_stop")[0]!.id, "expired");
      expect((await due(r)).map((d) => d.o_kind)).toEqual(["engine_session_stop"]);
      expect(await claimIssue(r)).toBe(1);
      const stop2 = byKind(await jobs(r), "engine_session_stop")[1]!;
      await finish(stop2.id, "failed", 5);
      expect(await due(r)).toEqual([]);
      await finish(stop2.id, "failed", 61);
      expect((await due(r)).map((d) => d.o_kind)).toEqual(["engine_session_stop"]);
      await claimIssue(r);
      await finish(byKind(await jobs(r), "engine_session_stop")[2]!.id, "done");
      await heartbeat(r, to.runnerId);
      await claimIssue(r);
      await finish(byKind(await jobs(r), "engine_session_delete")[0]!.id, "expired");
      expect((await due(r)).map((d) => d.o_kind)).toEqual(["engine_session_delete"]);
    });

    it("only this repo's stops and deletes on THIS machine since the request count: another machine's live stop, an older done stop and a done delete from before the move do not hide or close it", async () => {
      const r = await rig();
      const to = await machine(r.who);
      await rawJob(r, { runnerId: r.runnerId, kind: "engine_session_stop", state: "done", at: new Date(Date.now() - 3_600_000) });
      await rawJob(r, { runnerId: r.runnerId, kind: "engine_session_delete", state: "done", at: new Date(Date.now() - 3_600_000) });
      await move(r, to.runnerId);
      // A live stop of this repo on the machine it moved to is that machine's, not the old one's.
      await rawJob(r, { runnerId: to.runnerId, kind: "engine_session_stop", state: "issued", at: new Date(Date.now() + 1000) });
      expect((await due(r)).map((d) => d.o_kind)).toEqual(["engine_session_stop"]);
      expect(await cleanupOpen(h.admin, r.who.accountId, r.who.repoId, r.runnerId)).toBe(true);
    });

    it("the delete waits for the repo's CURRENT machine, not the cleanup's, and for an engine session, not the runner's bridge", async () => {
      const r = await rig();
      const to = await machine(r.who);
      await move(r, to.runnerId);
      await claimIssue(r);
      await finish(byKind(await jobs(r), "engine_session_stop")[0]!.id, "done");
      // The repo's placement is (wrongly) back on the cleanup's own machine: its own session's heartbeat is not the new one's.
      await h.admin.query("UPDATE project_placements SET runner_id = $3 WHERE account_id = $1 AND repo_id = $2", [r.who.accountId, r.who.repoId, r.runnerId]);
      await heartbeat(r, r.runnerId);
      expect(await due(r)).toEqual([]);
      await h.admin.query("UPDATE project_placements SET runner_id = $3 WHERE account_id = $1 AND repo_id = $2", [r.who.accountId, r.who.repoId, to.runnerId]);
      // The new machine's bridge session (the runner's own facts) is not an engine session.
      await h.admin.query("INSERT INTO engine_sessions (account_id, runner_id, repo_id, engine_instance_id, engine_version, session_kind, last_heartbeat_at) VALUES ($1, $2, $3, $4, '1.0.0', 'bridge', now())", [r.who.accountId, to.runnerId, r.who.repoId, randomUUID()]);
      expect(await due(r)).toEqual([]);
      await heartbeat(r, to.runnerId);
      expect((await due(r)).map((d) => d.o_kind)).toEqual(["engine_session_delete"]);
    });

    it("a removed project is deleted from the old machine even while another repo of the account is placed", async () => {
      const r = await rig({ plan: 2 });
      const second = randomUUID();
      await h.admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) SELECT $1, account_id, installation_id, gh_repo_id + 9003, product, 'acme', 'gizmos' FROM repos WHERE id = $2", [second, r.who.repoId]);
      const other = await machine(r.who);
      await h.admin.query("INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')", [second, r.who.accountId, other.runnerId]);
      const to = await machine(r.who);
      await move(r, to.runnerId);
      await claimIssue(r);
      await finish(byKind(await jobs(r), "engine_session_stop")[0]!.id, "done");
      await h.admin.query("DELETE FROM project_placements WHERE account_id = $1 AND repo_id = $2", [r.who.accountId, r.who.repoId]);
      expect((await due(r)).map((d) => [d.o_repo, d.o_kind])).toEqual([[r.who.repoId, "engine_session_delete"]]);
    });

    it("a start that never comes up leaves the old copy alone", async () => {
      const r = await rig();
      const to = await machine(r.who);
      const out = await move(r, to.runnerId);
      await claimIssue(r);
      await finish(byKind(await jobs(r), "engine_session_stop")[0]!.id, "done");
      await finish(out.start_job_id, "failed");
      for (let i = 0; i < 3; i += 1) expect(await claimIssue(r)).toBe(0);
      expect(byKind(await jobs(r), "engine_session_delete")).toHaveLength(0);
    });

    it("a project with no placement any more (removed) has its old copy deleted without waiting for a heartbeat", async () => {
      const r = await rig();
      const to = await machine(r.who);
      await move(r, to.runnerId);
      await claimIssue(r);
      await finish(byKind(await jobs(r), "engine_session_stop")[0]!.id, "done");
      await h.admin.query("DELETE FROM project_placements WHERE account_id = $1", [r.who.accountId]);
      expect((await due(r)).map((d) => d.o_kind)).toEqual(["engine_session_delete"]);
    });

    it("the real claim route issues the stop and hands it over; another machine's claim never gets this machine's cleanup", async () => {
      const r = await rig();
      const to = await machine(r.who);
      await move(r, to.runnerId);
      const reply = async (key: TestKey) => {
        await h.admin.query("DELETE FROM runner_claim_stamps WHERE runner_id IN (SELECT id FROM runners WHERE account_id = $1)", [r.who.accountId]);
        return toResponse(() => claimRun(depsFor(), signed(key, CLAIM_PATH, {}, { nonce: randomBytes(16).toString("base64url") })));
      };
      expect((await reply(r.key)).body).toMatchObject({ machine_job: true });
      const picked = await respond(() => machineJobClaimRun(depsFor(), signed(r.key, MACHINE_JOB_CLAIM_PATH, {})));
      expect((picked.body as { signed_job: { job: MachineJob } }).signed_job.job).toMatchObject({ kind: "engine_session_stop", runner_id: r.runnerId, args: { reason: "move" } });
      // The new machine's claim is offered its own start, and never an old machine's stop or delete.
      const other = await respond(() => machineJobClaimRun(depsFor(), signed(to.key, MACHINE_JOB_CLAIM_PATH, {})));
      expect((other.body as { signed_job: { job: MachineJob } }).signed_job.job).toMatchObject({ kind: "engine_session_start", runner_id: to.runnerId });
      expect((await jobs(r)).filter((j) => j.runner_id === to.runnerId).map((j) => j.kind)).toEqual(["engine_session_start"]);
    });

    it("a signer that cannot sign issues nothing and never fails the claim", async () => {
      const r = await rig();
      const to = await machine(r.who);
      await move(r, to.runnerId);
      expect(await claimIssue(r, r.runnerId, { engineCommandSigner: async () => null })).toBe(0);
      expect(await claimIssue(r, r.runnerId, { engineCommandSigner: async () => ({ keyId: "job-key-1", signMachineJob: () => { throw new Error("sign failed"); } }) as never })).toBe(0);
      expect(byKind(await jobs(r), "engine_session_stop")).toHaveLength(0);
      expect(await claimIssue(r)).toBe(1);
    });

    it("the Repos read never shows a move as a removal", async () => {
      const r = await rig();
      const to = await machine(r.who);
      await move(r, to.runnerId);
      const shown = await withTenant(h.appPool, r.who.accountId, r.who.userId, (c) => readRepoRemovals(c, r.who.accountId, [r.who.repoId]));
      expect(shown.size).toBe(0);
    });

    it("a removal of the moved project removes its own cleanup on the new machine and leaves the move's request on the old one", async () => {
      const r = await rig();
      const to = await machine(r.who);
      await move(r, to.runnerId);
      await h.admin.query("INSERT INTO runner_sandboxes (runner_id, slot, account_id, name, state, created_at, disk_bytes, snapshot_count) VALUES ($1, 0, $2, $3, 'running', now(), 1, 0)", [to.runnerId, r.who.accountId, `fx-engine-${r.ghRepoId}`]);
      await withTenant(h.appPool, r.who.accountId, r.who.userId, (c) => removeProjectIn(c, as(r), r.who.repoId, { deleteSandbox: true, removalPr: false, machineParts: true }));
      expect((await cleanups(r)).map((c) => [c.runner_id === r.runnerId ? "old" : "new", c.reason]).sort()).toEqual([["new", "remove"], ["old", "move"]]);
    });
  });

  describe("tenant predicates", () => {
    it("two repos of one account: the second's heartbeat, stop and request never stand in for the first's", async () => {
      const r = await rig({ plan: 2 });
      const second = randomUUID();
      await h.admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) SELECT $1, account_id, installation_id, gh_repo_id + 9001, product, 'acme', 'gadgets' FROM repos WHERE id = $2", [second, r.who.repoId]);
      const other = await machine(r.who);
      await h.admin.query("INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')", [second, r.who.accountId, other.runnerId]);
      const to = await machine(r.who);
      await move(r, to.runnerId);
      await claimIssue(r);
      await finish(byKind(await jobs(r), "engine_session_stop")[0]!.id, "done");
      // The second repo reports a heartbeat on the very machine the first repo moved to.
      await heartbeat(r, to.runnerId, 0, second);
      expect(await due(r)).toEqual([]);
      expect(await cleanupOpen(h.admin, r.who.accountId, second, r.runnerId)).toBe(false);
      expect(await cleanupOpen(h.admin, r.who.accountId, r.who.repoId, r.runnerId)).toBe(true);
      expect((await placedOn(h.admin, r.who.accountId, second)).runnerId).toBe(other.runnerId);
      expect((await placedOn(h.admin, r.who.accountId, r.who.repoId)).runnerId).toBe(to.runnerId);
      // The old machine is free: the second repo is placed there and its own stop is live, filed after the move. It does not stand in for the first's.
      await finish(byKind(await jobs(r), "engine_session_stop")[0]!.id, "expired");
      await h.admin.query("UPDATE project_placements SET runner_id = $3 WHERE account_id = $1 AND repo_id = $2", [r.who.accountId, second, r.runnerId]);
      await h.admin.query("INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)", [r.who.accountId, second]);
      await issueEngineSessionStop(depsFor(), as(r), second, "person");
      expect((await due(r)).map((d) => [d.o_repo, d.o_kind])).toEqual([[r.who.repoId, "engine_session_stop"]]);
    });

    it("another account's runner and the RLS-bypassing client with a foreign account read nothing", async () => {
      const r = await rig();
      const to = await machine(r.who);
      await move(r, to.runnerId);
      const foreign = await rig();
      expect(await due(r, foreign.runnerId, foreign.who.accountId)).toEqual([]);
      expect(await cleanupOpen(h.admin, foreign.who.accountId, r.who.repoId, r.runnerId)).toBe(false);
      await expect(placedOn(h.admin, foreign.who.accountId, r.who.repoId)).rejects.toMatchObject({ status: 404 });
    });

    it("another account's tenant session cannot see or write the cleanup row, and cannot request one for a repo or machine that is not its own", async () => {
      const r = await rig();
      const to = await machine(r.who);
      await move(r, to.runnerId);
      const foreign = await rig();
      const seen = await withTenant(h.appPool, foreign.who.accountId, foreign.who.userId, (c) => c.query("SELECT 1 FROM machine_cleanups WHERE repo_id = $1", [r.who.repoId]));
      expect(seen.rowCount).toBe(0);
      const request = (repo: string, runner: string) => withTenant(h.appPool, foreign.who.accountId, foreign.who.userId, (c) => c.query("SELECT machine_cleanup_request_move($1, $2)", [repo, runner]));
      await expect(request(r.who.repoId, foreign.runnerId)).rejects.toMatchObject({ code: "22023" });
      await expect(request(foreign.who.repoId, r.runnerId)).rejects.toMatchObject({ code: "22023" });
    });
  });

  describe("machine_cleanup_request_move (the definer)", () => {
    const request = (r: Rig, who: string, repo: string, runner: string) => withTenant(h.appPool, r.who.accountId, who, (c) => c.query("SELECT machine_cleanup_request_move($1, $2) AS id", [repo, runner]));
    it("refuses a member, a runner session, and the machine the project is placed on", async () => {
      const r = await rig();
      const to = await machine(r.who);
      await expect(request(r, r.member, r.who.repoId, to.runnerId)).rejects.toMatchObject({ code: "42501" });
      await expect(asRunner(r.who.accountId, r.runnerId, (c) => c.query("SELECT machine_cleanup_request_move($1, $2)", [r.who.repoId, to.runnerId]))).rejects.toMatchObject({ code: "42501" });
      await expect(request(r, r.who.userId, r.who.repoId, r.runnerId)).rejects.toMatchObject({ code: "22023" });
      expect(await cleanups(r)).toEqual([]);
      await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [to.runnerId]);
      await h.admin.query("UPDATE project_placements SET runner_id = $3 WHERE account_id = $1 AND repo_id = $2", [r.who.accountId, r.who.repoId, (await machine(r.who)).runnerId]);
      await expect(request(r, r.who.userId, r.who.repoId, to.runnerId)).rejects.toMatchObject({ code: "22023" });
    });

    it("a second request restarts the chain, and the issue definer holds a move's stop to reason 'move' and a delete to the heartbeat", async () => {
      const r = await rig();
      const to = await machine(r.who);
      await move(r, to.runnerId);
      const sign = (kind: "engine_session_stop" | "engine_session_delete", reason: string) => {
        const id = randomUUID();
        const issued = new Date(Date.now() + 5);
        const expires = new Date(issued.getTime() + 20 * 60 * 1000);
        const args = kind === "engine_session_stop" ? { reason, operate_epoch: 1 } : { operate_epoch: 1 };
        const job = { v: 1, job_id: id, runner_id: r.runnerId, repo_gh_id: r.ghRepoId, requires_engine: "any", issued_at: issued.toISOString(), expires_at: expires.toISOString(), kind, args } as MachineJob;
        return { id, kind, issued, expires, signed: signMachineJob(job, "job-key-1", jobKeys.privateKey) };
      };
      const issue = (j: ReturnType<typeof sign>) =>
        asRunner(r.who.accountId, r.runnerId, async (c) => {
          const id = (await c.query<{ id: string }>("SELECT id FROM machine_cleanups WHERE repo_id = $1", [r.who.repoId])).rows[0]!.id;
          return c.query("SELECT machine_cleanup_issue($1, $2, $3, $4::jsonb, $5, $6)", [id, j.id, j.kind, JSON.stringify(j.signed), j.issued, j.expires]);
        });
      await expect(issue(sign("engine_session_stop", "remove"))).rejects.toMatchObject({ code: "22023" });
      await expect(issue(sign("engine_session_delete", "move"))).rejects.toMatchObject({ code: "22023" });
      await expect(issue(sign("engine_session_stop", "move"))).resolves.toBeTruthy();
      await expect(issue(sign("engine_session_stop", "move"))).rejects.toMatchObject({ code: "22023" });
      await heartbeat(r, to.runnerId);
      await expect(issue(sign("engine_session_delete", "move"))).resolves.toBeTruthy();
    });
  });
});
