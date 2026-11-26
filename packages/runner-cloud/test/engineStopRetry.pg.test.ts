import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { signMachineJob, verifyMachineJob, type MachineJob } from "@fulcrumaxe/runner-protocol";
import { readEngineRepos } from "@fx/core/src/engine/panels.js";
import { readStopFacts } from "@fx/core/src/engine/stopFailed.js";
import { setPendingHooks } from "@fx/core/src/pendingWork.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { retryEngineStop, type RunnerCloudDeps } from "../src/index.js";
import { harness, newKey, registerKey, type Harness } from "./helpers.js";

/**
 * [pg] D#845 ON-13c4a: `stop_failed` on the engine repos read and the retry-stop route's logic, against real Postgres with the real roles, row security forced and real Ed25519 signatures. Both read the repo's newest session job
 * through one shared rule (`stopFailedOf`); the cases below pin every reason, every error code, a second repo of the same account, a foreign account, a member, and a double click.
 */
describe("failed engine stop: read and Try again [pg]", () => {
  let h: Harness;
  const keys = generateKeyPairSync("ed25519");
  const keyring = { "job-key-1": keys.publicKey };
  const signer = { keyId: "job-key-1", signMachineJob: (job: MachineJob) => signMachineJob(job, "job-key-1", keys.privateKey) };
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());
  afterEach(() => setPendingHooks(null));

  const depsFor = (over: Partial<RunnerCloudDeps> = {}): RunnerCloudDeps => h.deps({ engineCommandSigner: async () => signer as never, ...over });

  /** The reconcile marker writes the store sees, so a test can count how many times the tick was woken. */
  function watchMarker(): string[] {
    const writes: string[] = [];
    setPendingHooks({ store: { get: async () => null, set: async (key) => void writes.push(key), delete: async () => undefined } });
    return writes;
  }

  interface Rig { who: SeedRefs; runnerId: string; ghRepoId: number; admin: string; member: string }
  async function addMember(accountId: string, role: "admin" | "member"): Promise<string> {
    const userId = randomUUID();
    await h.admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
    await h.admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)", [accountId, userId, role]);
    return userId;
  }
  /** A fresh account: one repo placed on one machine with its engine's sandbox running, a covering plan of one engine, watch and operate on (epoch 1) and the repo ticked. */
  async function rig(o: { sandbox?: string | null; place?: boolean; operate?: boolean; watch?: boolean } = {}): Promise<Rig> {
    const who = await seedAccount(h.admin, randomUUID());
    await h.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [who.repoId]);
    const ghRepoId = Number((await h.admin.query<{ gh_repo_id: string }>("SELECT gh_repo_id FROM repos WHERE id = $1", [who.repoId])).rows[0]!.gh_repo_id);
    const runnerId = await registerKey(h.admin, who.accountId, who.userId, newKey());
    if (o.place !== false) await h.admin.query("INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')", [who.repoId, who.accountId, runnerId]);
    await h.admin.query("UPDATE accounts SET engine_quantity = 1, stripe_subscription_status = 'active' WHERE id = $1", [who.accountId]);
    const watch = o.watch !== false;
    await h.admin.query("INSERT INTO engine_bridge_settings (account_id, watch_enabled, operate_enabled) VALUES ($1, $2, $3)", [who.accountId, watch, watch && o.operate !== false]);
    await h.admin.query("INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)", [who.accountId, who.repoId]);
    const r = { who, runnerId, ghRepoId, admin: await addMember(who.accountId, "admin"), member: await addMember(who.accountId, "member") };
    if (o.sandbox !== null) await sandbox(r, o.sandbox ?? "running");
    return r;
  }
  const sandbox = (r: Rig, state: string, runnerId = r.runnerId, ghRepoId = r.ghRepoId) =>
    h.admin.query("INSERT INTO runner_sandboxes (runner_id, slot, account_id, name, state, created_at, disk_bytes, snapshot_count) VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', 1000, 1)", [runnerId, ghRepoId % 150, r.who.accountId, `fx-engine-${ghRepoId}`, state]);
  /** A second repo of the same account, placed on a second machine, ticked, with its own sandbox running. */
  async function secondRepo(r: Rig): Promise<{ repoId: string; ghRepoId: number; runnerId: string }> {
    const repoId = randomUUID();
    const ghRepoId = r.ghRepoId + 4242;
    await h.admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) SELECT $1, account_id, installation_id, $3, product, 'acme', 'gadgets' FROM repos WHERE id = $2", [repoId, r.who.repoId, ghRepoId]);
    const runnerId = await registerKey(h.admin, r.who.accountId, r.who.userId, newKey());
    await h.admin.query("INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')", [repoId, r.who.accountId, runnerId]);
    await h.admin.query("INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)", [r.who.accountId, repoId]);
    await sandbox(r, "running", runnerId, ghRepoId);
    return { repoId, ghRepoId, runnerId };
  }

  type JobState = "failed" | "expired" | "issued" | "delivered" | "done" | "superseded";
  /** A session job row as the definers would have written it, signed for real, `ago` minutes in the past. */
  async function job(r: Rig, o: { kind?: "engine_session_start" | "engine_session_stop" | "engine_session_delete"; reason?: string; state?: JobState; code?: string | null; ago?: number; repoId?: string; runnerId?: string; ghRepoId?: number } = {}): Promise<string> {
    const kind = o.kind ?? "engine_session_stop";
    const state = o.state ?? "failed";
    const id = randomUUID();
    const issued = new Date(Date.now() - (o.ago ?? 10) * 60_000);
    const expires = new Date(issued.getTime() + 25 * 60_000);
    const args = kind === "engine_session_stop" ? { reason: o.reason ?? "person", operate_epoch: 1 } : kind === "engine_session_start" ? { at_sha: "e".repeat(40), resume: false, operate_epoch: 1 } : { operate_epoch: 1 };
    const signedJob = signer.signMachineJob({ v: 1, job_id: id, runner_id: o.runnerId ?? r.runnerId, repo_gh_id: o.ghRepoId ?? r.ghRepoId, requires_engine: "any", issued_at: issued.toISOString(), expires_at: expires.toISOString(), kind, args } as MachineJob);
    const ended = state === "failed" || state === "expired" || state === "done" ? new Date(issued.getTime() + 60_000) : null;
    const code = state === "failed" || state === "expired" ? (o.code === undefined ? (state === "expired" ? "job_expired" : "snapshot_failed") : o.code) : null;
    await h.admin.query(
      `INSERT INTO machine_jobs (id, account_id, runner_id, repo_id, kind, job, state, issued_at, expires_at, delivered_at, ended_at, failure_code)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12)`,
      [id, r.who.accountId, o.runnerId ?? r.runnerId, o.repoId ?? r.who.repoId, kind, JSON.stringify(signedJob), state, issued, expires, state === "issued" || state === "expired" || state === "superseded" ? null : issued, ended, code],
    );
    return id;
  }
  const as = (r: Rig, who: "owner" | "admin" | "member" = "owner") => ({ accountId: r.who.accountId, userId: who === "owner" ? r.who.userId : who === "admin" ? r.admin : r.member });
  const retry = (r: Rig, who: "owner" | "admin" | "member" = "owner", over: Partial<RunnerCloudDeps> = {}, repoId = r.who.repoId) => retryEngineStop(depsFor(over), as(r, who), repoId);
  const refusal = async (p: Promise<unknown>) => p.then(() => ({ status: 0, code: "none" }), (e: { status: number; code: string }) => ({ status: e.status, code: e.code }));
  const stopJobs = async (accountId: string) =>
    (await h.admin.query<{ id: string; repo_id: string; state: string; stop_reason: string; job: { job: MachineJob; key_id: string } }>("SELECT id, repo_id, state, stop_reason, job FROM machine_jobs WHERE account_id = $1 AND kind = 'engine_session_stop' ORDER BY issued_at, id", [accountId])).rows;
  const failedOf = async (r: Rig, who: "owner" | "member" = "owner", repoId = r.who.repoId) =>
    (await withTenant(h.appPool, r.who.accountId, who === "owner" ? r.who.userId : r.member, (c) => readEngineRepos(c, r.who.accountId))).find((i) => i.repo_id === repoId)?.stop_failed;
  const operate = (r: Rig, on: boolean) => h.admin.query("UPDATE engine_bridge_settings SET operate_enabled = $2 WHERE account_id = $1", [r.who.accountId, on]);

  describe("the read: stop_failed on the repos list", () => {
    it("reads a stop that failed while the sandbox is running: its signed reason, its closed failure code and a time", async () => {
      const r = await rig();
      await job(r, { reason: "person", code: "snapshot_failed", ago: 5 });
      const sf = await failedOf(r);
      expect(sf).toMatchObject({ reason: "person", code: "snapshot_failed" });
      expect(Math.abs(Date.parse(sf!.at) - (Date.now() - 4 * 60_000))).toBeLessThan(30_000);
    });

    it("reads one per reason, and a failure with no code as code null", async () => {
      const r = await rig({ operate: false });
      for (const reason of ["person", "halt", "move", "remove", "operate_off"]) {
        await h.admin.query("DELETE FROM machine_jobs WHERE account_id = $1", [r.who.accountId]);
        await job(r, { reason, code: reason === "halt" ? null : "vm_teardown_incomplete" });
        expect(await failedOf(r), reason).toMatchObject({ reason, code: reason === "halt" ? null : "vm_teardown_incomplete" });
      }
    });

    it("reads an expired stop like a failed one, with the expiry's own code", async () => {
      const r = await rig();
      await job(r, { state: "expired", code: "job_silent" });
      expect(await failedOf(r)).toMatchObject({ reason: "person", code: "job_silent" });
    });

    it("reads null while the sandbox is not up (stopped, snapshotted, missing, or only another repo's is up), and shows it for creating", async () => {
      for (const state of ["stopped", "snapshotted", "error"]) {
        const r = await rig({ sandbox: state });
        await job(r);
        expect(await failedOf(r), state).toBeNull();
      }
      const none = await rig({ sandbox: null });
      await job(none);
      expect(await failedOf(none)).toBeNull();
      const creating = await rig({ sandbox: "creating" });
      await job(creating);
      expect(await failedOf(creating)).toMatchObject({ reason: "person" });
    });

    it("reads null once anything newer happened: a start, a Try again stop waiting or done, or a delete; a superseded start is not newer news", async () => {
      for (const newer of [{ kind: "engine_session_start", state: "issued" }, { kind: "engine_session_start", state: "done" }, { kind: "engine_session_stop", state: "issued" }, { kind: "engine_session_stop", state: "delivered" }, { kind: "engine_session_stop", state: "done" }, { kind: "engine_session_delete", state: "issued" }] as const) {
        const r = await rig();
        await job(r, { ago: 20 });
        expect(await failedOf(r)).not.toBeNull();
        await job(r, { ...newer, ago: 2 });
        expect(await failedOf(r), `${newer.kind} ${newer.state}`).toBeNull();
      }
      const r = await rig();
      await job(r, { ago: 20 });
      await job(r, { kind: "engine_session_start", state: "superseded", ago: 2 });
      expect(await failedOf(r)).not.toBeNull();
    });

    it("reads null for a stop that is still on its way or done, and for an account with no job at all", async () => {
      for (const state of ["issued", "delivered", "done"] as const) {
        const r = await rig();
        await job(r, { state });
        expect(await failedOf(r), state).toBeNull();
      }
      expect(await failedOf(await rig())).toBeNull();
    });

    it("hides operate_off once operate (with watch) is back on, and shows it while operate or watch is off", async () => {
      const r = await rig({ operate: false });
      await job(r, { reason: "operate_off" });
      expect(await failedOf(r)).toMatchObject({ reason: "operate_off" });
      await operate(r, true);
      expect(await failedOf(r)).toBeNull();
      const noWatch = await rig({ watch: false });
      await job(noWatch, { reason: "operate_off" });
      expect(await failedOf(noWatch)).toMatchObject({ reason: "operate_off" });
    });

    it("hides a plan stop while the plan covers the account, and shows it once the plan ended", async () => {
      const r = await rig();
      await job(r, { reason: "plan" });
      expect(await failedOf(r)).toBeNull();
      await h.admin.query("UPDATE accounts SET subscription_ended_at = now() WHERE id = $1", [r.who.accountId]);
      expect(await failedOf(r)).toMatchObject({ reason: "plan", code: "snapshot_failed" });
    });

    it("keeps a second repo of the same account apart: its failed stop never reads on the first, and each reads its own", async () => {
      const r = await rig();
      const other = await secondRepo(r);
      await job(r, { repoId: other.repoId, runnerId: other.runnerId, ghRepoId: other.ghRepoId, reason: "halt", code: "vm_teardown_incomplete" });
      expect(await failedOf(r)).toBeNull();
      expect(await failedOf(r, "owner", other.repoId)).toMatchObject({ reason: "halt", code: "vm_teardown_incomplete" });
      await job(r, { reason: "person", code: "job_overran" });
      expect(await failedOf(r)).toMatchObject({ reason: "person", code: "job_overran" });
      expect(await failedOf(r, "owner", other.repoId)).toMatchObject({ reason: "halt" });
    });

    it("keeps a sandbox of the second repo from making the first repo's stop show", async () => {
      const r = await rig({ sandbox: "stopped" });
      const other = await secondRepo(r);
      await job(r);
      expect(other.repoId).not.toBe(r.who.repoId);
      expect(await failedOf(r)).toBeNull();
    });

    it("never shows another account's failed stop, even to the RLS-bypassing read with a foreign account id", async () => {
      const mine = await rig();
      const theirs = await rig();
      await job(theirs, { reason: "halt" });
      expect(await failedOf(mine)).toBeNull();
      const foreign = await readStopFacts(h.admin, mine.who.accountId, theirs.who.repoId);
      expect(foreign.job).toBeNull();
      expect(foreign.sandboxUp).toBe(false);
      expect((await readStopFacts(h.admin, theirs.who.accountId, theirs.who.repoId)).job).toMatchObject({ kind: "engine_session_stop", state: "failed", stopReason: "halt" });
      expect(JSON.stringify(await withTenant(h.appPool, mine.who.accountId, mine.who.userId, (c) => readEngineRepos(c, mine.who.accountId)))).not.toContain(theirs.who.repoId);
    });

    it("reads the same for a member as for an owner", async () => {
      const r = await rig();
      await job(r, { reason: "halt" });
      expect(await failedOf(r, "member")).toMatchObject({ reason: "halt" });
    });
  });

  describe("the route: retry-stop", () => {
    it("answers 404 for a bad id and for another account's repo, and 403 to a member before anything is read, even on a project that is not placed", async () => {
      const r = await rig();
      const other = await rig();
      expect(await refusal(retryEngineStop(depsFor(), as(r), "not-a-uuid"))).toEqual({ status: 404, code: "not_found" });
      expect(await refusal(retry(r, "owner", {}, randomUUID()))).toEqual({ status: 404, code: "not_found" });
      expect(await refusal(retry(r, "owner", {}, other.who.repoId))).toEqual({ status: 404, code: "not_found" });
      await job(r);
      expect(await refusal(retry(r, "member"))).toEqual({ status: 403, code: "forbidden" });
      const unplaced = await rig({ place: false });
      expect(await refusal(retry(unplaced, "member"))).toEqual({ status: 403, code: "forbidden" });
      expect(await refusal(retry(unplaced))).toEqual({ status: 409, code: "not_placed" });
      expect(await stopJobs(r.who.accountId)).toHaveLength(1);
    });

    it("answers 409 runner_removed when the machine was removed", async () => {
      const r = await rig();
      await job(r);
      await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [r.runnerId]);
      expect(await refusal(retry(r))).toEqual({ status: 409, code: "runner_removed" });
    });

    it("reissues a person's stop as a person's, signed with the epoch now, audited with the reason, for an owner and for an admin", async () => {
      for (const who of ["owner", "admin"] as const) {
        const r = await rig();
        await job(r, { reason: "person" });
        const res = await retry(r, who);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ kind: "engine_session_stop", operate_epoch: 1, already_issued: false });
        const rows = await stopJobs(r.who.accountId);
        expect(rows).toHaveLength(2);
        const fresh = rows.find((x) => x.id === (res.body as { job_id: string }).job_id)!;
        expect(fresh).toMatchObject({ state: "issued", stop_reason: "person", repo_id: r.who.repoId });
        expect(verifyMachineJob(fresh.job, keyring, r.runnerId)).toMatchObject({ kind: "engine_session_stop", args: { reason: "person", operate_epoch: 1 } });
        const audit = (await h.admin.query<{ payload: Record<string, unknown> }>("SELECT payload FROM audit_log WHERE account_id = $1 AND action = 'engine_session.stopped'", [r.who.accountId])).rows;
        expect(audit.map((a) => a.payload)).toEqual([{ repo_id: r.who.repoId, job_id: fresh.id, reason: "person" }]);
        expect(await failedOf(r)).toBeNull();
      }
    });

    it("reissues a halt's stop as a halt's, never a person's, and leaves the halt flag alone", async () => {
      const r = await rig();
      await h.admin.query("INSERT INTO engine_repo_controls (account_id, repo_id, halted_at, halt_action_id, halt_epoch) VALUES ($1, $2, now(), gen_random_uuid(), 1)", [r.who.accountId, r.who.repoId]);
      await job(r, { reason: "halt", state: "expired", code: "job_overran" });
      const res = await retry(r);
      expect(res.body).toMatchObject({ kind: "engine_session_stop", already_issued: false });
      const fresh = (await stopJobs(r.who.accountId)).find((x) => x.id === (res.body as { job_id: string }).job_id)!;
      expect(fresh.stop_reason).toBe("halt");
      expect(verifyMachineJob(fresh.job, keyring, r.runnerId)).toMatchObject({ args: { reason: "halt" } });
      const flag = (await h.admin.query<{ halted_at: Date | null; halt_epoch: number }>("SELECT halted_at, halt_epoch FROM engine_repo_controls WHERE repo_id = $1", [r.who.repoId])).rows[0]!;
      expect(flag.halted_at).not.toBeNull();
      expect(flag.halt_epoch).toBe(1);
    });

    it("makes two clicks one stop: the second answers the same job with already_issued", async () => {
      const r = await rig();
      await job(r, { reason: "person" });
      const [a, b] = await Promise.all([retry(r), retry(r, "admin")]);
      const bodies = [a.body, b.body] as Array<{ job_id: string; already_issued: boolean }>;
      expect(bodies.map((x) => x.already_issued).sort()).toEqual([false, true]);
      expect(bodies[0]!.job_id).toBe(bodies[1]!.job_id);
      expect((await stopJobs(r.who.accountId)).filter((x) => x.state === "issued")).toHaveLength(1);
      const third = await retry(r);
      expect(third.status).toBe(200);
      expect(third.body).toMatchObject({ already_issued: true, job_id: bodies[0]!.job_id });
      expect(await stopJobs(r.who.accountId)).toHaveLength(2);
    });

    it("answers 200 already_issued for a stop that is delivered and not yet ended, with no failed stop beside it", async () => {
      const r = await rig();
      const id = await job(r, { state: "delivered" });
      const res = await retry(r);
      expect(res.body).toEqual({ job_id: id, kind: "engine_session_stop", operate_epoch: null, already_issued: true });
    });

    it("answers 409 nothing_to_retry when the newest job is not a failed stop or the sandbox is not up, and signs nothing", async () => {
      const none = await rig();
      expect(await refusal(retry(none))).toEqual({ status: 409, code: "nothing_to_retry" });
      const done = await rig();
      await job(done, { state: "done" });
      expect(await refusal(retry(done))).toEqual({ status: 409, code: "nothing_to_retry" });
      const started = await rig();
      await job(started, { ago: 20 });
      await job(started, { kind: "engine_session_start", state: "done", ago: 2 });
      expect(await refusal(retry(started))).toEqual({ status: 409, code: "nothing_to_retry" });
      const down = await rig({ sandbox: "stopped" });
      await job(down);
      expect(await refusal(retry(down))).toEqual({ status: 409, code: "nothing_to_retry" });
      for (const r of [none, done, started, down]) expect((await stopJobs(r.who.accountId)).filter((x) => x.state === "issued")).toEqual([]);
    });

    it("does not retry on another repo's failed stop: the first repo has none, the second has one", async () => {
      const r = await rig();
      const other = await secondRepo(r);
      await job(r, { repoId: other.repoId, runnerId: other.runnerId, ghRepoId: other.ghRepoId });
      expect(await refusal(retry(r))).toEqual({ status: 409, code: "nothing_to_retry" });
      const res = await retry(r, "owner", {}, other.repoId);
      expect(res.status).toBe(200);
      const rows = await stopJobs(r.who.accountId);
      expect(rows.filter((x) => x.state === "issued").map((x) => x.repo_id)).toEqual([other.repoId]);
    });

    it("wakes the reconcile tick once for an operate_off stop while operate is still off, and signs nothing, even with no signer", async () => {
      const r = await rig({ operate: false });
      await job(r, { reason: "operate_off" });
      const writes = watchMarker();
      const res = await retry(r, "owner", { engineCommandSigner: async () => null });
      expect(res).toMatchObject({ status: 200, body: { queued: true } });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(writes.filter((k) => k === "pending:reconcile")).toHaveLength(1);
      expect((await stopJobs(r.who.accountId)).filter((x) => x.state === "issued")).toEqual([]);
    });

    it("answers 409 cause_gone for an operate_off stop once operate is back on, and wakes nothing", async () => {
      const r = await rig({ operate: false });
      await job(r, { reason: "operate_off" });
      await operate(r, true);
      const writes = watchMarker();
      expect(await refusal(retry(r))).toEqual({ status: 409, code: "cause_gone" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(writes).toEqual([]);
      expect((await stopJobs(r.who.accountId)).filter((x) => x.state === "issued")).toEqual([]);
    });

    it("treats a plan stop the same way: queued while the plan has ended, cause_gone once it covers the account", async () => {
      const ended = await rig();
      await job(ended, { reason: "plan", state: "expired", code: "job_expired" });
      await h.admin.query("UPDATE accounts SET subscription_ended_at = now() WHERE id = $1", [ended.who.accountId]);
      const writes = watchMarker();
      expect(await retry(ended)).toMatchObject({ status: 200, body: { queued: true } });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(writes.filter((k) => k === "pending:reconcile")).toHaveLength(1);
      const covered = await rig();
      await job(covered, { reason: "plan" });
      expect(await refusal(retry(covered))).toEqual({ status: 409, code: "cause_gone" });
      for (const r of [ended, covered]) expect((await stopJobs(r.who.accountId)).filter((x) => x.state === "issued")).toEqual([]);
    });

    it("answers 409 not_retryable for a move and a remove stop, and signs nothing", async () => {
      for (const reason of ["move", "remove"]) {
        const r = await rig();
        await job(r, { reason });
        const writes = watchMarker();
        expect(await refusal(retry(r)), reason).toEqual({ status: 409, code: "not_retryable" });
        expect(writes).toEqual([]);
        expect((await stopJobs(r.who.accountId)).filter((x) => x.state === "issued")).toEqual([]);
      }
    });

    it("answers 503 not_configured for a person's stop when the cloud has no signer, and issues nothing", async () => {
      const r = await rig();
      await job(r, { reason: "halt" });
      expect(await refusal(retry(r, "owner", { engineCommandSigner: async () => null }))).toEqual({ status: 503, code: "not_configured" });
      expect(await stopJobs(r.who.accountId)).toHaveLength(1);
    });

    it("is never gated: it reissues with the plan ended and operate off", async () => {
      const r = await rig({ operate: false });
      await h.admin.query("UPDATE accounts SET subscription_ended_at = now() WHERE id = $1", [r.who.accountId]);
      await job(r, { reason: "person" });
      const res = await retry(r);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ already_issued: false });
    });
  });
});
