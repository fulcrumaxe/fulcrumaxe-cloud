import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MACHINE_JOB_CLAIM_PATH, signMachineJob, verifyMachineJob, type MachineJob } from "@fulcrumaxe/runner-protocol";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import {
  HELLO_PATH, issueEngineSessionDelete, issueEngineSessionStart, issueEngineSessionStop, machineJobClaimRun, runnerHello, startEngine,
  type RunnerCloudDeps, type RunPullRequestPort,
} from "../src/index.js";
import { hadSession, loadSessionTarget, pendingJob, readOperate } from "../src/engineSession.js";
import { harness, newKey, registerKey, respond, signed, type Harness, type TestKey } from "./helpers.js";

const HEAD = "d".repeat(40);

/**
 * [pg] D#845 ON-13a2: the three engine session issuers, the gates in front of a start (coverage, then operate under `SELECT ... FOR SHARE`), the Start engine function, the per-repo tick, the downgrade rule and the
 * `engine_session_sandboxes` view. Real Ed25519 signatures, the real definers, row security forced, and the real claim route for the pickup. The GitHub port is a fake that answers what `branchState` answers.
 */
describe("engine session issuers and gates [pg]", () => {
  let h: Harness;
  const jobKeys = generateKeyPairSync("ed25519");
  const keyring = { "job-key-1": jobKeys.publicKey };
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  const github = (o: { head?: string | null; fail?: "retryable" | "refused" } = {}): RunPullRequestPort =>
    ({
      defaultBranch: async () => "main",
      branchState: async () => {
        if (o.fail) throw Object.assign(new Error("github"), { name: "RunPullRequestError", retryable: o.fail === "retryable" });
        const head = o.head === undefined ? HEAD : o.head;
        return { exists: head !== null, headOid: head, aheadBy: 0, defaultBranch: "main" };
      },
    }) as unknown as RunPullRequestPort;
  const depsFor = (over: Partial<RunnerCloudDeps> = {}): RunnerCloudDeps =>
    h.deps({
      pullRequests: github(),
      engineCommandSigner: async () => ({ keyId: "job-key-1", signMachineJob: (job: MachineJob) => signMachineJob(job, "job-key-1", jobKeys.privateKey) }) as never,
      ...over,
    });

  let extra = 0;
  interface Rig { who: SeedRefs; key: TestKey; runnerId: string; ghRepoId: number; admin: { userId: string }; member: { userId: string } }
  const SESSION_CAPS = ["engine_session_v1"];
  async function addMember(accountId: string, role: "admin" | "member"): Promise<string> {
    const userId = randomUUID();
    await h.admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
    await h.admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)", [accountId, userId, role]);
    return userId;
  }
  /** A fresh account: one repo placed on one machine (hello at protocol 22 listing the session capability), an engine plan of `plan` engines, and operate on (epoch 1) unless said otherwise. */
  async function rig(o: { plan?: number | null; operate?: boolean | null; place?: boolean; tick?: boolean } = {}): Promise<Rig> {
    const who = await seedAccount(h.admin, randomUUID());
    await h.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [who.repoId]);
    const ghRepoId = Number((await h.admin.query<{ gh_repo_id: string }>("SELECT gh_repo_id FROM repos WHERE id = $1", [who.repoId])).rows[0]!.gh_repo_id);
    const key = newKey();
    const runnerId = await registerKey(h.admin, who.accountId, who.userId, key);
    const hello = await respond(() => runnerHello(h.deps(), signed(key, HELLO_PATH, {
      protocol_version: 22, binary_version: "0.5.0", model_auth_present: true, isolation: "host_sandbox", capabilities: SESSION_CAPS, facts: { os: "linux", arch: "x64", mem_gb_bucket: 16, cpus: 8, sandbox_engine: "os_sandbox" },
    })));
    expect(hello.status).toBe(200);
    if (o.place !== false) await h.admin.query("INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')", [who.repoId, who.accountId, runnerId]);
    const plan = o.plan === undefined ? 1 : o.plan;
    if (plan !== null) await h.admin.query("UPDATE accounts SET engine_quantity = $2, stripe_subscription_status = 'active' WHERE id = $1", [who.accountId, plan]);
    if (o.operate !== null) await h.admin.query("INSERT INTO engine_bridge_settings (account_id, watch_enabled, operate_enabled) VALUES ($1, true, $2)", [who.accountId, o.operate !== false]);
    if (o.operate !== null && o.tick !== false) await h.admin.query("INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)", [who.accountId, who.repoId]);
    return { who, key, runnerId, ghRepoId, admin: { userId: await addMember(who.accountId, "admin") }, member: { userId: await addMember(who.accountId, "member") } };
  }
  /** A second repo of the same account, placed on a second machine. */
  async function secondRepo(r: Rig): Promise<{ repoId: string; ghRepoId: number; runnerId: string }> {
    const repoId = randomUUID();
    const offset = 1000 * ++extra;
    await h.admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) SELECT $1, account_id, installation_id, gh_repo_id + $3, product, 'acme', 'gadgets' FROM repos WHERE id = $2", [repoId, r.who.repoId, offset]);
    const runnerId = await registerKey(h.admin, r.who.accountId, r.who.userId, newKey());
    await h.admin.query("INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')", [repoId, r.who.accountId, runnerId]);
    await h.admin.query("UPDATE accounts SET engine_quantity = engine_quantity + 1 WHERE id = $1", [r.who.accountId]);
    await h.admin.query("INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)", [r.who.accountId, repoId]);
    return { repoId, ghRepoId: r.ghRepoId + offset, runnerId };
  }
  const as = (r: Rig, who: "owner" | "admin" | "member" = "owner") => ({ accountId: r.who.accountId, userId: who === "owner" ? r.who.userId : who === "admin" ? r.admin.userId : r.member.userId });
  const refusal = async (p: Promise<unknown>) => p.then(() => ({ status: 0, code: "none" }), (e: { status: number; code: string }) => ({ status: e.status, code: e.code }));
  const jobRow = async (id: string) => (await h.admin.query<{ job: { job: MachineJob; key_id: string }; state: string; kind: string; repo_id: string; setup_id: string | null; runner_id: string }>("SELECT job, state, kind, repo_id, setup_id, runner_id FROM machine_jobs WHERE id = $1", [id])).rows[0]!;
  const jobsOf = async (accountId: string, kind: string) => (await h.admin.query<{ id: string; repo_id: string; state: string }>("SELECT id, repo_id, state FROM machine_jobs WHERE account_id = $1 AND kind = $2 ORDER BY issued_at, id", [accountId, kind])).rows;
  const setOperate = (r: Rig, on: boolean) => h.admin.query("UPDATE engine_bridge_settings SET operate_enabled = $2 WHERE account_id = $1", [r.who.accountId, on]);
  const epochOf = async (r: Rig) => (await h.admin.query<{ operate_epoch: number }>("SELECT operate_epoch FROM engine_bridge_settings WHERE account_id = $1", [r.who.accountId])).rows[0]!.operate_epoch;
  const sandbox = (r: Rig, o: { repoId?: string; ghRepoId?: number; runnerId?: string; state?: string; slot?: number } = {}) =>
    h.admin.query("INSERT INTO runner_sandboxes (runner_id, slot, account_id, name, state, created_at, disk_bytes, snapshot_count) VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', 1000, 1)", [
      o.runnerId ?? r.runnerId, o.slot ?? 0, r.who.accountId, `fx-engine-${o.ghRepoId ?? r.ghRepoId}`, o.state ?? "running",
    ]);
  const start = (r: Rig, who: "owner" | "admin" | "member" = "owner", over: Partial<RunnerCloudDeps> = {}) => issueEngineSessionStart(depsFor(over), as(r, who), r.who.repoId);

  describe("start", () => {
    it("issues a signed start the runner's keyring verifies, with the operate epoch, the default branch head and no setup, and the real claim route hands over those exact bytes", async () => {
      const r = await rig();
      const out = await start(r);
      expect(out).toMatchObject({ kind: "engine_session_start", operate_epoch: 1, already_issued: false });
      const row = await jobRow(out.job_id);
      expect(row).toMatchObject({ state: "issued", kind: "engine_session_start", repo_id: r.who.repoId, setup_id: null, runner_id: r.runnerId });
      const job = verifyMachineJob(row.job, keyring, r.runnerId);
      expect(job).toMatchObject({ kind: "engine_session_start", repo_gh_id: r.ghRepoId, requires_engine: "any", args: { at_sha: HEAD, resume: false, operate_epoch: 1 } });
      expect(job.setup_id).toBeUndefined();
      const picked = await respond(() => machineJobClaimRun(h.deps(), signed(r.key, MACHINE_JOB_CLAIM_PATH, {})));
      expect(picked.status).toBe(200);
      expect((picked.body as { signed_job: unknown }).signed_job).toEqual(row.job);
      const audit = (await h.admin.query<{ payload: Record<string, unknown> }>("SELECT payload FROM audit_log WHERE account_id = $1 AND action = 'engine_session.started'", [r.who.accountId])).rows;
      expect(audit.map((a) => a.payload)).toEqual([{ repo_id: r.who.repoId, job_id: out.job_id, resume: false }]);
    });

    it("signs the epoch the account's settings row holds: it rises on each switch and the next start signs the new one", async () => {
      const r = await rig();
      await setOperate(r, false);
      await setOperate(r, true);
      expect(await epochOf(r)).toBe(3);
      const out = await start(r, "admin");
      expect(out.operate_epoch).toBe(3);
      const job = verifyMachineJob((await jobRow(out.job_id)).job, keyring, r.runnerId);
      if (job.kind !== "engine_session_start") throw new Error("kind");
      expect(job.args.operate_epoch).toBe(await epochOf(r));
    });

    it("resumes when the machine lists the engine's sandbox, or has started it before; otherwise it is a first start", async () => {
      const listed = await rig();
      await sandbox(listed, { state: "stopped" });
      const a = await start(listed);
      expect(verifyMachineJob((await jobRow(a.job_id)).job, keyring, listed.runnerId)).toMatchObject({ args: { resume: true } });
      const before = await rig();
      const first = await start(before);
      await h.admin.query("UPDATE machine_jobs SET state = 'done', delivered_at = now(), last_progress_at = now(), last_seq = 1, last_step = 'done', start_mode = 'created', ended_at = now() WHERE id = $1", [first.job_id]);
      const again = await start(before);
      expect(verifyMachineJob((await jobRow(again.job_id)).job, keyring, before.runnerId)).toMatchObject({ args: { resume: true } });
      const other = await rig();
      await sandbox(other, { ghRepoId: other.ghRepoId + 7, state: "stopped" });
      expect(verifyMachineJob((await jobRow((await start(other)).job_id)).job, keyring, other.runnerId)).toMatchObject({ args: { resume: false } });
    });

    it("refuses without a covering plan before anything is signed: 402 plan_required for no plan and for a plan that ended, 402 account_held for a hold", async () => {
      const none = await rig({ plan: null });
      expect(await refusal(start(none))).toEqual({ status: 402, code: "plan_required" });
      const zero = await rig({ plan: 0 });
      expect(await refusal(start(zero))).toEqual({ status: 402, code: "plan_required" });
      const ended = await rig();
      await h.admin.query("UPDATE accounts SET subscription_ended_at = now() WHERE id = $1", [ended.who.accountId]);
      expect(await refusal(start(ended))).toEqual({ status: 402, code: "plan_required" });
      const lapsed = await rig();
      await h.admin.query("UPDATE accounts SET stripe_subscription_status = 'past_due', past_due_since = now() - interval '8 days' WHERE id = $1", [lapsed.who.accountId]);
      expect(await refusal(start(lapsed))).toEqual({ status: 402, code: "plan_required" });
      const held = await rig();
      await h.admin.query("UPDATE accounts SET platform_hold_at = now() WHERE id = $1", [held.who.accountId]);
      expect(await refusal(start(held))).toEqual({ status: 402, code: "account_held" });
      for (const x of [none, zero, ended, lapsed, held]) expect(await jobsOf(x.who.accountId, "engine_session_start")).toEqual([]);
    });

    it("counts the engine being started in the plan: every unit in use is no refusal, because the engine is one of them", async () => {
      const r = await rig({ plan: 1 });
      expect(await h.admin.query("SELECT count(*)::int AS n FROM project_placements WHERE account_id = $1", [r.who.accountId]).then((x) => x.rows[0].n)).toBe(1);
      expect((await start(r)).already_issued).toBe(false);
    });

    it("refuses 409 operate_off when operate is off or the account has no settings row, and checks coverage first", async () => {
      const off = await rig({ operate: false });
      expect(await refusal(start(off))).toEqual({ status: 409, code: "operate_off" });
      const never = await rig({ operate: null });
      expect(await refusal(start(never))).toEqual({ status: 409, code: "operate_off" });
      const both = await rig({ plan: null, operate: false });
      expect(await refusal(start(both))).toEqual({ status: 402, code: "plan_required" });
      for (const x of [off, never, both]) expect(await jobsOf(x.who.accountId, "engine_session_start")).toEqual([]);
    });

    it("refuses a repo that is not placed, one whose machine was removed, another account's repo and a member's call", async () => {
      const unplaced = await rig({ place: false });
      expect(await refusal(start(unplaced))).toEqual({ status: 409, code: "not_placed" });
      const gone = await rig();
      await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [gone.runnerId]);
      expect(await refusal(start(gone))).toEqual({ status: 409, code: "runner_removed" });
      const mine = await rig();
      const theirs = await rig();
      expect(await refusal(issueEngineSessionStart(depsFor(), as(mine), theirs.who.repoId))).toEqual({ status: 404, code: "not_found" });
      expect(await refusal(start(mine, "member"))).toEqual({ status: 403, code: "forbidden" });
      expect(await refusal(startEngine(depsFor(), as(mine), "not-a-uuid"))).toEqual({ status: 404, code: "not_found" });
      for (const x of [unplaced, gone, mine, theirs]) expect(await jobsOf(x.who.accountId, "engine_session_start")).toEqual([]);
    });

    it("refuses when the cloud cannot sign or read GitHub, and maps a failed or empty read", async () => {
      const r = await rig();
      expect(await refusal(start(r, "owner", { engineCommandSigner: async () => null }))).toEqual({ status: 503, code: "not_configured" });
      expect(await refusal(start(r, "owner", { pullRequests: null }))).toEqual({ status: 503, code: "not_configured" });
      expect(await refusal(start(r, "owner", { pullRequests: github({ head: null }) }))).toEqual({ status: 409, code: "default_branch_empty" });
      expect(await refusal(start(r, "owner", { pullRequests: github({ head: "not-a-sha" }) }))).toEqual({ status: 409, code: "default_branch_empty" });
      expect(await jobsOf(r.who.accountId, "engine_session_start")).toEqual([]);
    });

    it("issues one start per repo at a time: a second is 409 start_pending, another repo of the account is not held up, and the next is allowed once the first ended", async () => {
      const r = await rig();
      const b = await secondRepo(r);
      const first = await start(r);
      expect(await refusal(start(r))).toEqual({ status: 409, code: "start_pending" });
      const second = await issueEngineSessionStart(depsFor(), as(r), b.repoId);
      expect(second.job_id).not.toBe(first.job_id);
      await h.admin.query("UPDATE machine_jobs SET state = 'failed', delivered_at = now(), last_progress_at = now(), last_seq = 1, failure_code = 'vm_boot_failed', ended_at = now() WHERE id = $1", [first.job_id]);
      // Two clicks at once issue one start.
      const both = await Promise.allSettled([start(r), start(r)]);
      expect(both.filter((x) => x.status === "fulfilled")).toHaveLength(1);
      expect(both.filter((x) => x.status === "rejected").map((x) => (x as PromiseRejectedResult).reason.code)).toEqual(["start_pending"]);
      expect((await jobsOf(r.who.accountId, "engine_session_start")).filter((j) => j.repo_id === r.who.repoId && j.state === "issued")).toHaveLength(1);
    });

    it("answers the Start engine function with the issued job, no-store", async () => {
      const r = await rig();
      const res = await respond(() => startEngine(depsFor(), as(r), r.who.repoId.toUpperCase()));
      expect(res.status).toBe(200);
      expect(res.headers?.["cache-control"]).toBe("no-store");
      expect(res.body).toMatchObject({ kind: "engine_session_start", operate_epoch: 1, already_issued: false });
      const denied = await respond(() => startEngine(depsFor(), as(r), randomUUID()));
      expect(denied.status).toBe(404);
      const noOperate = await rig({ operate: false });
      const off = await respond(() => startEngine(depsFor(), as(noOperate), noOperate.who.repoId));
      expect(off.status).toBe(409);
      expect(off.body).toMatchObject({ error: { code: "operate_off" } });
      const noPlan = await rig({ plan: null });
      const unpaid = await respond(() => startEngine(depsFor(), as(noPlan), noPlan.who.repoId));
      expect(unpaid.status).toBe(402);
      expect(unpaid.body).toMatchObject({ error: { code: "plan_required" } });
    });
  });

  describe("the operate lock", () => {
    it("takes the settings row FOR SHARE under an owner and an admin session, so a switch off waits for the issue; a member and a token session cannot lock and read it as off", async () => {
      const r = await rig();
      const lockOf = async (userId: string, tokenId?: string) => {
        let blocked: string | null = null;
        await withTenant(h.appPool, r.who.accountId, userId, tokenId, async (client: PoolClient) => {
          const op = await readOperate(client, r.who.accountId, true);
          // While this transaction holds the row, another session's write to the same row waits.
          const rival = await h.adminPool.connect();
          try {
            await rival.query("BEGIN");
            await rival.query("SET LOCAL lock_timeout = '300ms'");
            await rival.query("UPDATE engine_bridge_settings SET updated_at = now() WHERE account_id = $1", [r.who.accountId]);
            blocked = "no";
          } catch (error) {
            blocked = (error as { code?: string }).code ?? "error";
          } finally {
            await rival.query("ROLLBACK");
            rival.release();
          }
          expect(op).toBeDefined();
          return op;
        });
        return blocked;
      };
      expect(await lockOf(r.who.userId)).toBe("55P03");
      expect(await lockOf(r.admin.userId)).toBe("55P03");
      const asMember = await withTenant(h.appPool, r.who.accountId, r.member.userId, (client) => readOperate(client, r.who.accountId, true));
      expect(asMember).toEqual({ enabled: false, epoch: 0 });
      const token = await withTenant(h.appPool, r.who.accountId, r.who.userId, randomUUID(), (client) => readOperate(client, r.who.accountId, true));
      expect(token).toEqual({ enabled: false, epoch: 0 });
      // Without the lock the same rows read through, which is why the issuer takes it only after it has checked the role.
      const plain = await withTenant(h.appPool, r.who.accountId, r.member.userId, (client) => readOperate(client, r.who.accountId, false));
      expect(plain).toEqual({ enabled: true, epoch: 1 });
    });

    it("serializes an issue and a switch off: an off that starts while a start holds the lock waits, and then supersedes that start (issued first), or finds operate off (off first)", async () => {
      const r = await rig();
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let reached: () => void = () => undefined;
      const atGate = new Promise<void>((resolve) => { reached = resolve; });
      const second = issueEngineSessionStart(depsFor(), as(r), r.who.repoId, { afterGate: async () => { reached(); await held; } });
      await atGate;
      const rival = await h.adminPool.connect();
      let offDone = false;
      const off = (async () => {
        await rival.query("BEGIN");
        await rival.query("UPDATE engine_bridge_settings SET operate_enabled = false WHERE account_id = $1", [r.who.accountId]);
        await rival.query("COMMIT");
        offDone = true;
      })();
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(offDone).toBe(false);
      release();
      const issued = await second;
      await off;
      rival.release();
      expect(offDone).toBe(true);
      expect(issued.operate_epoch).toBe(1);
      expect((await h.admin.query<{ state: string }>("SELECT state FROM machine_jobs WHERE id = $1", [issued.job_id])).rows[0]!.state).toBe("superseded");
      expect(await epochOf(r)).toBe(2);
      expect(await refusal(start(r))).toEqual({ status: 409, code: "operate_off" });
    });
  });

  describe("stop and delete", () => {
    it("signs a stop with its reason and the epoch now, never gated: operate off, no plan and a held account all stop", async () => {
      const r = await rig({ plan: null });
      await setOperate(r, false);
      await h.admin.query("UPDATE accounts SET platform_hold_at = now() WHERE id = $1", [r.who.accountId]);
      const out = await issueEngineSessionStop(depsFor(), as(r, "admin"), r.who.repoId, "halt");
      expect(out).toMatchObject({ kind: "engine_session_stop", operate_epoch: 2, already_issued: false });
      expect(verifyMachineJob((await jobRow(out.job_id)).job, keyring, r.runnerId)).toMatchObject({ kind: "engine_session_stop", repo_gh_id: r.ghRepoId, args: { reason: "halt", operate_epoch: 2 } });
      const none = await rig({ operate: null });
      const bare = await issueEngineSessionStop(depsFor(), as(none), none.who.repoId, "person");
      expect(verifyMachineJob((await jobRow(bare.job_id)).job, keyring, none.runnerId)).toMatchObject({ args: { reason: "person", operate_epoch: 0 } });
      const audit = (await h.admin.query<{ payload: Record<string, unknown> }>("SELECT payload FROM audit_log WHERE account_id = $1 AND action = 'engine_session.stopped'", [r.who.accountId])).rows;
      expect(audit.map((a) => a.payload)).toEqual([{ repo_id: r.who.repoId, job_id: out.job_id, reason: "halt" }]);
    });

    it("returns a stop or delete that is already waiting instead of issuing a second, and issues again once it ended", async () => {
      const r = await rig();
      const a = await issueEngineSessionStop(depsFor(), as(r), r.who.repoId, "person");
      const b = await issueEngineSessionStop(depsFor(), as(r), r.who.repoId, "halt");
      expect(b).toMatchObject({ job_id: a.job_id, already_issued: true });
      await h.admin.query("UPDATE machine_jobs SET state = 'done', delivered_at = now(), last_progress_at = now(), last_seq = 1, last_step = 'done', ended_at = now() WHERE id = $1", [a.job_id]);
      expect((await issueEngineSessionStop(depsFor(), as(r), r.who.repoId, "person")).already_issued).toBe(false);
      const d = await issueEngineSessionDelete(depsFor(), as(r), r.who.repoId);
      expect(verifyMachineJob((await jobRow(d.job_id)).job, keyring, r.runnerId)).toMatchObject({ kind: "engine_session_delete", args: { operate_epoch: 1 } });
      expect((await issueEngineSessionDelete(depsFor(), as(r), r.who.repoId)).job_id).toBe(d.job_id);
      // One audit row for the delete, ids only like the stop's; the second call that returned the waiting job wrote none.
      const audit = (await h.admin.query<{ payload: Record<string, unknown> }>("SELECT payload FROM audit_log WHERE account_id = $1 AND action = 'engine_session.deleted'", [r.who.accountId])).rows;
      expect(audit.map((x) => x.payload)).toEqual([{ repo_id: r.who.repoId, job_id: d.job_id }]);
    });

    it("refuses a member, an unplaced repo, a removed machine, another account's repo and an unconfigured signer", async () => {
      const r = await rig();
      expect(await refusal(issueEngineSessionStop(depsFor(), as(r, "member"), r.who.repoId, "person"))).toEqual({ status: 403, code: "forbidden" });
      expect(await refusal(issueEngineSessionDelete(depsFor(), as(r, "member"), r.who.repoId))).toEqual({ status: 403, code: "forbidden" });
      expect(await refusal(issueEngineSessionStop(depsFor({ engineCommandSigner: async () => null }), as(r), r.who.repoId, "person"))).toEqual({ status: 503, code: "not_configured" });
      const other = await rig();
      expect(await refusal(issueEngineSessionStop(depsFor(), as(r), other.who.repoId, "person"))).toEqual({ status: 404, code: "not_found" });
      const unplaced = await rig({ place: false });
      expect(await refusal(issueEngineSessionStop(depsFor(), as(unplaced), unplaced.who.repoId, "person"))).toEqual({ status: 409, code: "not_placed" });
      const gone = await rig();
      await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [gone.runnerId]);
      expect(await refusal(issueEngineSessionDelete(depsFor(), as(gone), gone.who.repoId))).toEqual({ status: 409, code: "runner_removed" });
      for (const x of [r, other, unplaced, gone]) expect(await jobsOf(x.who.accountId, "engine_session_stop")).toEqual([]);
    });
  });

  describe("a person's stop reasons", () => {
    it("throws for operate_off and plan, which are the system's alone, and issues nothing", async () => {
      const r = await rig();
      for (const reason of ["operate_off", "plan", "token_refresh_failed"]) {
        await expect(issueEngineSessionStop(depsFor(), as(r), r.who.repoId, reason as never)).rejects.toThrow(/system-only/);
      }
      expect(await jobsOf(r.who.accountId, "engine_session_stop")).toEqual([]);
      for (const reason of ["person", "halt", "move", "remove"] as const) {
        const out = await issueEngineSessionStop(depsFor(), as(r), r.who.repoId, reason);
        await h.admin.query("UPDATE machine_jobs SET state = 'done', delivered_at = now(), last_progress_at = now(), last_seq = 1, last_step = 'done', ended_at = now() WHERE id = $1", [out.job_id]);
      }
    });
  });

  describe("the per-repo tick", () => {
    it("refuses 409 operate_off for a repo that is not ticked, on the action and on the Start engine function, and starts the ticked one of the same account", async () => {
      const r = await rig({ tick: false });
      const b = await secondRepo(r);
      expect(await refusal(start(r))).toEqual({ status: 409, code: "operate_off" });
      const res = await respond(() => startEngine(depsFor(), as(r), r.who.repoId));
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: { code: "operate_off" } });
      expect(await jobsOf(r.who.accountId, "engine_session_start")).toEqual([]);
      expect((await issueEngineSessionStart(depsFor(), as(r), b.repoId)).already_issued).toBe(false);
      await h.admin.query("INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)", [r.who.accountId, r.who.repoId]);
      expect((await start(r)).already_issued).toBe(false);
    });

    it("refuses a repo untick that lands between the early look and the locked one", async () => {
      const r = await rig();
      const flip = { ...github(), branchState: async () => { await h.admin.query("DELETE FROM engine_bridge_repos WHERE account_id = $1", [r.who.accountId]); return { exists: true, headOid: HEAD, aheadBy: 0, defaultBranch: "main" }; } } as unknown as RunPullRequestPort;
      expect(await refusal(start(r, "owner", { pullRequests: flip }))).toEqual({ status: 409, code: "operate_off" });
      expect(await jobsOf(r.who.accountId, "engine_session_start")).toEqual([]);
    });
  });

  describe("a downgrade: more placements than the plan holds", () => {
    /** Three repos placed in a known order (oldest first: a, b, c) on a plan of `plan` engines. */
    async function threeRepos(plan: number) {
      const a = await rig({ plan });
      const b = await secondRepo(a);
      const c = await secondRepo(a);
      await h.admin.query("UPDATE accounts SET engine_quantity = $2 WHERE id = $1", [a.who.accountId, plan]);
      await h.admin.query("UPDATE project_placements SET placed_at = '2026-01-01T00:00:00Z' WHERE repo_id = $1", [a.who.repoId]);
      await h.admin.query("UPDATE project_placements SET placed_at = '2026-01-02T00:00:00Z' WHERE repo_id = $1", [b.repoId]);
      await h.admin.query("UPDATE project_placements SET placed_at = '2026-01-03T00:00:00Z' WHERE repo_id = $1", [c.repoId]);
      return { a, b, c };
    }
    const startOf = (r: Rig, repoId: string) => issueEngineSessionStart(depsFor(), as(r), repoId);
    const refusalWithBody = (p: Promise<unknown>) => p.then(() => null, (e: { status: number; code: string; extra: unknown }) => ({ status: e.status, code: e.code, extra: e.extra }));

    it("lets a repo ranked within the quantity start and refuses the others 402 engine_quantity with the counts, and stops no running session", async () => {
      const { a, b, c } = await threeRepos(2);
      await sandbox(a, { state: "running" });
      await sandbox(a, { repoId: c.repoId, ghRepoId: c.ghRepoId, runnerId: c.runnerId, state: "running" });
      expect((await startOf(a, a.who.repoId)).already_issued).toBe(false);
      expect((await startOf(a, b.repoId)).already_issued).toBe(false);
      expect(await refusalWithBody(startOf(a, c.repoId))).toEqual({ status: 402, code: "engine_quantity", extra: { quantity: 2, live: 3 } });
      const res = await respond(() => startEngine(depsFor(), as(a), c.repoId));
      expect(res.status).toBe(402);
      expect(res.body).toMatchObject({ error: { code: "engine_quantity" }, quantity: 2, live: 3 });
      expect(await jobsOf(a.who.accountId, "engine_session_start").then((j) => j.map((x) => x.repo_id).sort())).toEqual([a.who.repoId, b.repoId].sort());
      // Nothing was stopped: no stop job, and the running sandboxes are as they were.
      expect(await jobsOf(a.who.accountId, "engine_session_stop")).toEqual([]);
      expect((await h.admin.query("SELECT state FROM runner_sandboxes WHERE account_id = $1", [a.who.accountId])).rows).toEqual([{ state: "running" }, { state: "running" }]);
    });

    it("breaks a tie in placed_at by repo id", async () => {
      const { a, b, c } = await threeRepos(1);
      await h.admin.query("UPDATE project_placements SET placed_at = '2026-01-01T00:00:00Z' WHERE account_id = $1", [a.who.accountId]);
      const first = [a.who.repoId, b.repoId, c.repoId].sort()[0]!;
      const others = [a.who.repoId, b.repoId, c.repoId].filter((x) => x !== first);
      expect((await startOf(a, first)).already_issued).toBe(false);
      for (const id of others) expect(await refusal(startOf(a, id))).toEqual({ status: 402, code: "engine_quantity" });
    });

    it("passes every repo when live equals the quantity, and a repo of another account is not ranked", async () => {
      const { a, b, c } = await threeRepos(3);
      for (const id of [a.who.repoId, b.repoId, c.repoId]) expect((await startOf(a, id)).already_issued).toBe(false);
      const other = await rig({ plan: 1 });
      expect((await start(other)).already_issued).toBe(false);
    });
  });

  describe("the account and repo predicates", () => {
    it("every read names the account: a foreign account id finds nothing through the RLS-bypassing client", async () => {
      const mine = await rig();
      await sandbox(mine, { state: "running" });
      const started = await start(mine);
      await h.admin.query("UPDATE machine_jobs SET state = 'done', delivered_at = now(), last_progress_at = now(), last_seq = 1, last_step = 'done', start_mode = 'created', ended_at = now() WHERE id = $1", [started.job_id]);
      const second = await start(mine);
      await h.admin.query("UPDATE machine_jobs SET state = 'delivered', delivered_at = now() WHERE id = $1", [second.job_id]);
      const foreign = randomUUID();
      expect(await pendingJob(h.admin, mine.who.accountId, mine.who.repoId, "engine_session_start")).toBe(second.job_id);
      expect(await pendingJob(h.admin, foreign, mine.who.repoId, "engine_session_start")).toBeNull();
      const target = await loadSessionTarget(h.admin, mine.who.accountId, mine.who.repoId);
      expect(await hadSession(h.admin, mine.who.accountId, target)).toBe(true);
      expect(await hadSession(h.admin, foreign, target)).toBe(false);
    });

    it("refuses a start when operate goes off between the early look and the locked one", async () => {
      const r = await rig();
      const flip = { ...github(), branchState: async () => { await setOperate(r, false); return { exists: true, headOid: HEAD, aheadBy: 0, defaultBranch: "main" }; } } as unknown as RunPullRequestPort;
      expect(await refusal(start(r, "owner", { pullRequests: flip }))).toEqual({ status: 409, code: "operate_off" });
      expect(await jobsOf(r.who.accountId, "engine_session_start")).toEqual([]);
    });

    it("reads nothing of another account through the RLS-bypassing client, and nothing of another repo of the same account", async () => {
      const mine = await rig();
      const b = await secondRepo(mine);
      const theirs = await rig();
      await sandbox(mine, { state: "running" });
      await sandbox(mine, { repoId: b.repoId, ghRepoId: b.ghRepoId, runnerId: b.runnerId, state: "running" });
      await sandbox(theirs, { state: "running" });
      await h.admin.query("UPDATE accounts SET engine_quantity = 1 WHERE id = $1", [theirs.who.accountId]);
      // The superuser client skips row security, so only the queries' own account predicate can keep these apart.
      await expect(loadSessionTarget(h.admin, mine.who.accountId, theirs.who.repoId)).rejects.toMatchObject({ status: 404, code: "not_found" });
      await expect(loadSessionTarget(h.admin, theirs.who.accountId, mine.who.repoId)).rejects.toMatchObject({ status: 404, code: "not_found" });
      expect(await loadSessionTarget(h.admin, mine.who.accountId, b.repoId)).toMatchObject({ repoId: b.repoId, runnerId: b.runnerId });
      expect(await readOperate(h.admin, randomUUID(), false)).toEqual({ enabled: false, epoch: 0 });
      expect((await h.admin.query("SELECT repo_id FROM engine_session_sandboxes WHERE account_id = $1", [randomUUID()])).rows).toEqual([]);
      // A pending start of repo A never holds up repo B, and a stop of one is not another's.
      const a = await start(mine);
      expect((await issueEngineSessionStart(depsFor(), as(mine), b.repoId)).job_id).not.toBe(a.job_id);
      const stopA = await issueEngineSessionStop(depsFor(), as(mine), mine.who.repoId, "person");
      expect((await issueEngineSessionStop(depsFor(), as(mine), b.repoId, "person")).job_id).not.toBe(stopA.job_id);
      expect(await jobsOf(theirs.who.accountId, "engine_session_start")).toEqual([]);
    });
  });

  describe("the engine_session_sandboxes view", () => {
    const viewOf = async (r: Rig, repoId = r.who.repoId) =>
      (await withTenant(h.appPool, r.who.accountId, r.who.userId, (c) =>
        c.query("SELECT * FROM engine_session_sandboxes WHERE account_id = $1 AND repo_id = $2", [r.who.accountId, repoId]))).rows;
    const endStart = (id: string, mode: string, at: string) =>
      h.admin.query("UPDATE machine_jobs SET state = 'done', delivered_at = now(), last_progress_at = now(), last_seq = 1, last_step = 'done', start_mode = $2, ended_at = $3 WHERE id = $1", [id, mode, at]);

    it("lists the engine's sandbox with its repo, machine, tier, state and the last start's mode, one test per mode", async () => {
      for (const mode of ["created", "resumed", "fresh"]) {
        const r = await rig();
        await sandbox(r, { state: "running" });
        const out = await start(r);
        await endStart(out.job_id, mode, "2026-11-23T10:00:00Z");
        const [row] = await viewOf(r);
        expect(row).toMatchObject({ repo_id: r.who.repoId, runner_id: r.runnerId, sandbox_name: `fx-engine-${r.ghRepoId}`, tier: "standard", state: "running", snapshot_count: 1, last_start_mode: mode, stopped_reason: null });
        expect(new Date(row.last_start_at).toISOString()).toBe("2026-11-23T10:00:00.000Z");
        expect(Number(row.disk_bytes)).toBe(1000);
      }
    });

    it("shows a snapshotted sandbox as stopped with the reason of the stop that ended after the last start, and not an older one", async () => {
      const r = await rig();
      await sandbox(r, { state: "snapshotted" });
      const s1 = await start(r);
      await endStart(s1.job_id, "created", "2026-11-23T10:00:00Z");
      const stop = await issueEngineSessionStop(depsFor(), as(r), r.who.repoId, "halt");
      await h.admin.query("UPDATE machine_jobs SET state = 'done', delivered_at = now(), last_progress_at = now(), last_seq = 2, last_step = 'done', ended_at = '2026-11-23T11:00:00Z' WHERE id = $1", [stop.job_id]);
      expect(await viewOf(r)).toMatchObject([{ state: "stopped", stopped_reason: "halt", last_start_mode: "created" }]);
      const s2 = await start(r);
      await endStart(s2.job_id, "resumed", "2026-11-23T12:00:00Z");
      await h.admin.query("UPDATE runner_sandboxes SET state = 'running' WHERE account_id = $1", [r.who.accountId]);
      expect(await viewOf(r)).toMatchObject([{ state: "running", stopped_reason: null, last_start_mode: "resumed" }]);
      await h.admin.query("UPDATE runner_sandboxes SET state = 'stopped' WHERE account_id = $1", [r.who.accountId]);
      expect(await viewOf(r)).toMatchObject([{ state: "stopped", stopped_reason: null }]);
    });

    it("has no row for a repo with no sandbox (deleted), and none of another repo's or another account's sandbox", async () => {
      const r = await rig();
      const b = await secondRepo(r);
      await sandbox(r, { repoId: b.repoId, ghRepoId: b.ghRepoId, runnerId: b.runnerId, state: "running" });
      expect(await viewOf(r)).toEqual([]);
      expect(await viewOf(r, b.repoId)).toHaveLength(1);
      const stranger = await rig();
      expect(await withTenant(h.appPool, stranger.who.accountId, stranger.who.userId, async (c) => (await c.query("SELECT repo_id FROM engine_session_sandboxes")).rows)).toEqual([]);
    });

    it("lets app_user read stop_reason and still nothing of the signed bytes", async () => {
      const r = await rig();
      const stop = await issueEngineSessionStop(depsFor(), as(r), r.who.repoId, "person");
      const seen = await withTenant(h.appPool, r.who.accountId, r.who.userId, async (c) => (await c.query<{ stop_reason: string }>("SELECT stop_reason FROM machine_jobs WHERE id = $1", [stop.job_id])).rows[0]!.stop_reason);
      expect(seen).toBe("person");
      await expect(withTenant(h.appPool, r.who.accountId, r.who.userId, (c) => c.query("SELECT job FROM machine_jobs WHERE id = $1", [stop.job_id]))).rejects.toMatchObject({ code: "42501" });
    });
  });
});
