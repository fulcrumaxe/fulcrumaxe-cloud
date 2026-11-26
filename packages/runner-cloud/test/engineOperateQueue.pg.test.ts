import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signMachineJob, type MachineJob } from "@fulcrumaxe/runner-protocol";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { drainOperateQueue, RunPullRequestError, type OperateQueueDeps } from "../src/index.js";
import { startOutcome, stopOutcome } from "../src/engineOperateQueue.js";
import { harness, newKey, registerKey, type Harness } from "./helpers.js";

const HEAD = "e".repeat(40);

/**
 * [pg] D#845 ON-13c2 (migration 1105): the `operate_on` cause of the system start issuer (its queue row, its consumption, its refusals and its replay), the lister, and the drain that calls the stop and start issuers per queue row,
 * at most 4 at once. Real Postgres, the real roles (platform_ops claims and issues), real Ed25519 signatures. No network: GitHub is a fake that counts its calls and samples the queue while it is asked.
 */
describe("operate queue [pg]", () => {
  let h: Harness;
  const keys = generateKeyPairSync("ed25519");
  const signer = { keyId: "job-key-1", signMachineJob: (job: MachineJob) => signMachineJob(job, "job-key-1", keys.privateKey) };
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  interface Rig { who: SeedRefs; runnerId: string; ghRepoId: number }
  /** A fresh account with one repo placed on one machine, a plan of `plan`, watch on, operate on (epoch 1) and the repo ticked, so its `start` row is queued; its install is finished with nothing pending. */
  async function rig(o: { operate?: boolean; plan?: number; setup?: boolean } = {}): Promise<Rig> {
    const who = await seedAccount(h.admin, randomUUID());
    const ghRepoId = Number((await h.admin.query<{ gh_repo_id: string }>("SELECT gh_repo_id FROM repos WHERE id = $1", [who.repoId])).rows[0]!.gh_repo_id);
    await h.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [who.repoId]);
    const runnerId = await registerKey(h.admin, who.accountId, who.userId, newKey());
    await h.admin.query("INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')", [who.repoId, who.accountId, runnerId]);
    await h.admin.query("UPDATE accounts SET engine_quantity = $2, stripe_subscription_status = 'active' WHERE id = $1", [who.accountId, o.plan ?? 12]);
    await h.admin.query("DELETE FROM engine_bridge_settings WHERE account_id = $1", [who.accountId]);
    await h.admin.query("INSERT INTO engine_bridge_settings (account_id, watch_enabled, operate_enabled) VALUES ($1, true, $2)", [who.accountId, o.operate !== false]);
    await h.admin.query("INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)", [who.accountId, who.repoId]);
    if (o.setup !== false) await addSetup(who, who.repoId);
    return { who, runnerId, ghRepoId };
  }
  async function addSetup(who: SeedRefs, repoId: string, pending = false): Promise<void> {
    const id = (await h.admin.query<{ id: string }>("INSERT INTO project_setups (account_id, repo_id, kind, created_by, phase, state, sub_step, engine_version) VALUES ($1, $2, 'existing', $3, 'finish', 'ok', 'pr_merged', '1.2.3') RETURNING id", [who.accountId, repoId, who.userId])).rows[0]!.id;
    await h.admin.query("UPDATE project_setups SET phase = 'done', start_pending = $2 WHERE id = $1", [id, pending]);
  }
  /** Another repo of the account, placed on a machine of its own and ticked (so queued while operate is on). */
  async function addRepo(r: Rig, o: { sandbox?: boolean } = {}): Promise<{ repoId: string; runnerId: string; ghRepoId: number }> {
    const repoId = randomUUID();
    const ghRepoId = r.ghRepoId + 100 + Math.floor(Math.random() * 1_000_000);
    await h.admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) SELECT $1, account_id, installation_id, $3, product, 'acme', $4 FROM repos WHERE id = $2", [repoId, r.who.repoId, ghRepoId, `r${ghRepoId}`]);
    const runnerId = await registerKey(h.admin, r.who.accountId, r.who.userId, newKey());
    await h.admin.query("INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')", [repoId, r.who.accountId, runnerId]);
    await addSetup(r.who, repoId);
    await h.admin.query("INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)", [r.who.accountId, repoId]);
    if (o.sandbox === true) await addSandbox(r.who.accountId, runnerId, ghRepoId);
    return { repoId, runnerId, ghRepoId };
  }
  const addSandbox = (accountId: string, runnerId: string, ghRepoId: number) =>
    h.admin.query("INSERT INTO runner_sandboxes (runner_id, slot, account_id, name, state, created_at, disk_bytes, snapshot_count) VALUES ($1, 1, $2, $3, 'running', now(), 1, 1)", [runnerId, accountId, `fx-engine-${ghRepoId}`]);
  interface QRow { repo_id: string; operate_epoch: number; action: string; state: string; attempts: number }
  const queue = async (accountId: string, where = "true"): Promise<QRow[]> =>
    (await h.admin.query<QRow>(`SELECT repo_id, operate_epoch, action, state, attempts FROM engine_operate_queue WHERE account_id = $1 AND ${where} ORDER BY action, repo_id`, [accountId])).rows;
  const setRow = (r: Rig, state: string, repoId = r.who.repoId, action = "start") =>
    h.admin.query(`UPDATE engine_operate_queue SET state = $4, claimed_at = CASE WHEN $4 = 'running' THEN now() END WHERE account_id = $1 AND repo_id = $2 AND action = $3`, [r.who.accountId, repoId, action, state]);
  const jobs = async (accountId: string, kind = "engine_session_start") =>
    (await h.admin.query<{ id: string; repo_id: string; state: string; job: { job: { args: Record<string, unknown> } } }>("SELECT id, repo_id, state, job FROM machine_jobs WHERE account_id = $1 AND kind = $2 ORDER BY issued_at, id", [accountId, kind])).rows;
  const audits = async (accountId: string) => (await h.admin.query<{ actor: string; payload: Record<string, unknown> }>("SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'engine_session.started'", [accountId])).rows;
  const pendingOf = async (repoId: string) => (await h.admin.query<{ p: boolean }>("SELECT bool_or(start_pending) AS p FROM project_setups WHERE repo_id = $1", [repoId])).rows[0]!.p;
  const due = async (accountId?: string, repoId?: string, pool = h.opsPool) =>
    (await pool.query<{ o_account: string; o_repo: string; o_runner: string; o_epoch: number; o_resume: boolean }>("SELECT * FROM engine_operate_on_starts_due($1::uuid, $2::uuid, 500)", [accountId ?? null, repoId ?? null])).rows;
  const code = async (p: Promise<unknown>) => p.then((v) => `ok:${String(v)}`, (e: { code?: string; message?: string }) => e.code ?? `error:${e.message}`);
  type Envelope = { job: Record<string, unknown> & { args: Record<string, unknown> } };
  interface Forge { resume?: boolean; epoch?: number; cause?: string; accountId?: string; repoId?: string; edit?: (e: Envelope) => void }
  /** The `operate_on` start as the cloud would sign it, ready for the issuer; any one field can be forged. */
  async function issue(r: Rig, f: Forge = {}, pool = h.opsPool): Promise<string> {
    const id = randomUUID();
    const issued = new Date();
    const expires = new Date(issued.getTime() + 1_800_000);
    const job = signer.signMachineJob({
      v: 1, job_id: id, runner_id: r.runnerId, repo_gh_id: r.ghRepoId, requires_engine: "any", issued_at: issued.toISOString(), expires_at: expires.toISOString(),
      kind: "engine_session_start", args: { at_sha: HEAD, resume: f.resume ?? false, operate_epoch: f.epoch ?? 1 },
    } as unknown as MachineJob) as unknown as Envelope;
    f.edit?.(job);
    return (await pool.query<{ result: string }>("SELECT engine_system_start_issue($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, $6, $7) AS result", [
      id, f.accountId ?? r.who.accountId, f.repoId ?? r.who.repoId, f.cause ?? "operate_on", JSON.stringify(job), issued, expires])).rows[0]!.result;
  }
  const untouched = async (r: Rig, repoId = r.who.repoId) => {
    expect((await jobs(r.who.accountId)).filter((j) => j.repo_id === repoId)).toEqual([]);
    expect((await audits(r.who.accountId)).filter((a) => a.payload.repo_id === repoId)).toEqual([]);
  };

  /** A start or stop job another cause already wrote for the repo (a person's), in `state`, issued `agoMs` ago, with the bytes bound the way the table demands. The system first start goes through `issue`. */
  async function addJob(r: Rig, state: "issued" | "delivered" | "done" | "failed", o: { kind?: "engine_session_start" | "engine_session_stop"; agoMs?: number } = {}): Promise<string> {
    const kind = o.kind ?? "engine_session_start";
    const id = randomUUID();
    const issued = new Date(Date.now() - (o.agoMs ?? 0));
    const expires = new Date(issued.getTime() + 1_800_000);
    const args = kind === "engine_session_start" ? { at_sha: HEAD, resume: false, operate_epoch: 1 } : { operate_epoch: 1, reason: "person" };
    const job = signer.signMachineJob({ v: 1, job_id: id, runner_id: r.runnerId, repo_gh_id: r.ghRepoId, requires_engine: "any", issued_at: issued.toISOString(), expires_at: expires.toISOString(), kind, args } as unknown as MachineJob);
    await h.admin.query(
      "INSERT INTO machine_jobs (id, account_id, runner_id, repo_id, setup_id, kind, job, attempt, state, issued_at, expires_at, delivered_at) VALUES ($1, $2, $3, $4, NULL, $5, $6::jsonb, 1, $7, $8, $9, CASE WHEN $7 = 'issued' THEN NULL ELSE $8::timestamptz END)",
      [id, r.who.accountId, r.runnerId, r.who.repoId, kind, JSON.stringify(job), state, issued, expires]);
    return id;
  }
  /** The row was queued `agoMs` ago, so a job issued since then is one that came after it. */
  const queuedAgo = (r: Rig, agoMs: number) => h.admin.query("UPDATE engine_operate_queue SET enqueued_at = now() - ($2::int * interval '1 millisecond') WHERE account_id = $1", [r.who.accountId, agoMs]);

  describe("the operate_on cause of the issuer", () => {
    it("starts a repo whose queue row is running, consumes the row in the same transaction, and audits the cause", async () => {
      const r = await rig();
      await setRow(r, "running");
      expect(await issue(r)).toBe("issued");
      expect((await queue(r.who.accountId))[0]).toMatchObject({ action: "start", operate_epoch: 1, state: "done" });
      const j = await jobs(r.who.accountId);
      expect(j).toHaveLength(1);
      expect(j[0]!.job.job.args).toMatchObject({ at_sha: HEAD, operate_epoch: 1, resume: false });
      expect((await audits(r.who.accountId)).map((a) => [a.actor, a.payload.cause, a.payload.repo_id])).toEqual([["platform_ops", "operate_on", r.who.repoId]]);
    });
    it("answers cause_gone with nothing written when the row is missing, pending or done, or is a stop, or is another epoch's", async () => {
      const r = await rig();
      expect(await issue(r)).toBe("cause_gone");
      await setRow(r, "done");
      expect(await issue(r)).toBe("cause_gone");
      await setRow(r, "running", r.who.repoId, "start");
      await h.admin.query("UPDATE engine_operate_queue SET action = 'stop' WHERE account_id = $1", [r.who.accountId]);
      expect(await issue(r)).toBe("cause_gone");
      await h.admin.query("UPDATE engine_operate_queue SET action = 'start', operate_epoch = 2 WHERE account_id = $1", [r.who.accountId]);
      expect(await issue(r)).toBe("cause_gone");
      await untouched(r);
      expect((await queue(r.who.accountId))[0]!.state).toBe("running");
    });
    it("is replayed to cause_gone: a second start for the same row writes nothing", async () => {
      const r = await rig();
      await setRow(r, "running");
      expect(await issue(r)).toBe("issued");
      expect(await issue(r)).toBe("cause_gone");
      expect(await jobs(r.who.accountId)).toHaveLength(1);
      expect(await audits(r.who.accountId)).toHaveLength(1);
    });
    it("answers epoch_moved for a start signed at another epoch, and keeps the row", async () => {
      const r = await rig();
      await setRow(r, "running");
      expect(await issue(r, { epoch: 2 })).toBe("epoch_moved");
      await untouched(r);
      expect((await queue(r.who.accountId))[0]!.state).toBe("running");
    });
    it("keeps the row when another gate says not yet: plan, busy, not operated", async () => {
      const lapsed = await rig();
      await setRow(lapsed, "running");
      await h.admin.query("UPDATE accounts SET stripe_subscription_status = 'canceled', subscription_ended_at = now() WHERE id = $1", [lapsed.who.accountId]);
      expect(await issue(lapsed)).toBe("plan");
      expect((await queue(lapsed.who.accountId))[0]!.state).toBe("running");
      const busy = await rig();
      await setRow(busy, "running");
      expect(await issue(busy)).toBe("issued");
      await setRow(busy, "running");
      expect(await issue(busy)).toBe("busy");
      expect((await queue(busy.who.accountId))[0]!.state).toBe("running");
      const off = await rig();
      await setRow(off, "running");
      await h.admin.query("DELETE FROM engine_bridge_repos WHERE account_id = $1", [off.who.accountId]);
      expect(await issue(off)).toBe("cause_gone");
      await untouched(off);
    });
    it("clears a finished install's start_pending as well, so one start is not followed by a second; first_start leaves the queue row alone", async () => {
      const r = await rig({ setup: false });
      await addSetup(r.who, r.who.repoId, true);
      await setRow(r, "running");
      expect(await issue(r)).toBe("issued");
      expect(await pendingOf(r.who.repoId)).toBe(false);
      const f = await rig({ setup: false });
      await addSetup(f.who, f.who.repoId, true);
      await setRow(f, "running");
      expect(await issue(f, { cause: "first_start" })).toBe("issued");
      expect(await pendingOf(f.who.repoId)).toBe(false);
      expect((await queue(f.who.accountId))[0]!.state).toBe("running");
    });
    it("refuses a cause outside the closed set, a login that is not platform_ops, and forged bytes", async () => {
      const r = await rig();
      await setRow(r, "running");
      expect(await code(issue(r, { cause: "engine_updated" }))).toBe("22023");
      expect(await code(issue(r, {}, h.appPool))).toBe("42501");
      expect(await code(issue(r, {}, h.adminPool))).toBe("42501");
      expect(await code(issue(r, { edit: (e) => { e.job.args.at_sha = "nothex"; } }))).toBe("22023");
      expect(await code(issue(r, { edit: (e) => { e.job.runner_id = randomUUID(); } }))).toBe("22023");
      await untouched(r);
      expect((await queue(r.who.accountId))[0]!.state).toBe("running");
    });
    it("reads only the account named: another account's running row is no cause, and nothing of it moves", async () => {
      const a = await rig();
      const b = await rig();
      await setRow(b, "running");
      expect(await issue(a)).toBe("cause_gone");
      expect(await issue(a, { accountId: b.who.accountId })).toBe("not_placed");
      expect(await code(issue(a, { repoId: b.who.repoId }))).toBe("ok:not_placed");
      expect((await queue(b.who.accountId))[0]!.state).toBe("running");
      await untouched(b);
      await untouched(a);
    });
    it("does not take a second repo of the same account: its own row is its own cause", async () => {
      const r = await rig();
      const second = await addRepo(r);
      await setRow(r, "running", second.repoId);
      expect(await issue(r)).toBe("cause_gone");
      expect((await queue(r.who.accountId, `repo_id = '${second.repoId}'`))[0]!.state).toBe("running");
    });
  });

  describe("a session that is already up", () => {
    it("ends the row without signing when a start issued after the row was queued is delivered or done: the issuer answers cause_gone and writes nothing", async () => {
      for (const state of ["delivered", "done"] as const) {
        const r = await rig();
        await queuedAgo(r, 60_000);
        await setRow(r, "running");
        await addJob(r, state);
        expect(await issue(r, { resume: state === "done" })).toBe("cause_gone");
        expect((await queue(r.who.accountId))[0]!.state).toBe("done");
        expect(await jobs(r.who.accountId)).toHaveLength(1);
        expect(await audits(r.who.accountId)).toEqual([]);
      }
    });
    it("still starts when the other start is not up: failed, older than the row, or stopped since", async () => {
      const failed = await rig();
      await queuedAgo(failed, 60_000);
      await setRow(failed, "running");
      await addJob(failed, "failed");
      expect(await issue(failed)).toBe("issued");
      const older = await rig();
      await queuedAgo(older, 60_000);
      await setRow(older, "running");
      await addJob(older, "done", { agoMs: 3_600_000 });
      expect(await issue(older, { resume: true })).toBe("issued");
      const stopped = await rig();
      await queuedAgo(stopped, 60_000);
      await setRow(stopped, "running");
      await addJob(stopped, "done", { agoMs: 20_000 });
      await addJob(stopped, "done", { kind: "engine_session_stop", agoMs: 10_000 });
      expect(await issue(stopped, { resume: true })).toBe("issued");
    });
    it("keeps a row whose other start is still only issued, as busy always did", async () => {
      const r = await rig();
      await queuedAgo(r, 60_000);
      await setRow(r, "running");
      await addJob(r, "issued");
      expect(await issue(r)).toBe("busy");
      expect((await queue(r.who.accountId))[0]!.state).toBe("running");
    });
  });

  describe("engine_operate_on_starts_due", () => {
    it("lists a placed, operated repo with a running start row at the current epoch and a finished install, and nothing else", async () => {
      const r = await rig();
      expect(await due(r.who.accountId)).toEqual([]);
      await setRow(r, "running");
      expect(await due(r.who.accountId)).toEqual([expect.objectContaining({ o_account: r.who.accountId, o_repo: r.who.repoId, o_runner: r.runnerId, o_epoch: 1, o_resume: false })]);
      expect(await due(r.who.accountId, r.who.repoId)).toHaveLength(1);
      await setRow(r, "pending");
      expect(await due(r.who.accountId)).toEqual([]);
      await setRow(r, "running");
      await h.admin.query("UPDATE project_setups SET phase = 'finish' WHERE repo_id = $1", [r.who.repoId]);
      expect(await due(r.who.accountId)).toEqual([]);
    });
    it("leaves out a repo whose session a start after the row was queued already brought up, unless a stop came after it", async () => {
      const r = await rig();
      await queuedAgo(r, 60_000);
      await setRow(r, "running");
      expect(await due(r.who.accountId)).toHaveLength(1);
      await addJob(r, "done", { agoMs: 20_000 });
      expect(await due(r.who.accountId)).toEqual([]);
      await addJob(r, "done", { kind: "engine_session_stop", agoMs: 10_000 });
      expect(await due(r.who.accountId)).toHaveLength(1);
    });
    it("still lists a repo whose only start was issued before the row was queued", async () => {
      const r = await rig();
      await queuedAgo(r, 60_000);
      await setRow(r, "running");
      await addJob(r, "done", { agoMs: 120_000 });
      expect(await due(r.who.accountId)).toHaveLength(1);
    });
    it("lists only the repo whose own row is running: a second repo of the account with a pending row is not listed", async () => {
      const r = await rig();
      const second = await addRepo(r);
      await setRow(r, "running");
      expect((await due(r.who.accountId)).map((x) => x.o_repo)).toEqual([r.who.repoId]);
      await setRow(r, "pending");
      await setRow(r, "running", second.repoId);
      expect((await due(r.who.accountId)).map((x) => x.o_repo)).toEqual([second.repoId]);
    });
    it("is not another account's: a foreign account id lists nothing, and a repo needs its account", async () => {
      const a = await rig();
      const b = await rig();
      await setRow(a, "running");
      expect(await due(b.who.accountId)).toEqual([]);
      expect(await due(b.who.accountId, a.who.repoId)).toEqual([]);
      expect(await due(randomUUID())).toEqual([]);
      expect(await code(h.opsPool.query("SELECT * FROM engine_operate_on_starts_due(NULL, $1::uuid, 5)", [a.who.repoId]))).toBe("22023");
    });
    it("resumes a repo whose machine lists its sandbox", async () => {
      const r = await rig();
      await addSandbox(r.who.accountId, r.runnerId, r.ghRepoId);
      await setRow(r, "running");
      expect((await due(r.who.accountId))[0]!.o_resume).toBe(true);
    });
    it("lists nothing for a tenant login, the superuser or a runner session", async () => {
      const r = await rig();
      await setRow(r, "running");
      expect(await code(due(r.who.accountId, undefined, h.appPool))).toBe("42501");
      expect(await code(due(r.who.accountId, undefined, h.adminPool))).toBe("42501");
    });
  });

  describe("the drain (drainOperateQueue)", () => {
    const reports: Array<{ stage: string; code?: string }> = [];
    /** GitHub fake. `during` is called on every head read, so a test can look at the queue while a drain is in the middle of a row. */
    const fakeGithub = (o: { fail?: Error; during?: () => Promise<void> } = {}) => {
      const calls = { defaultBranch: 0, branchState: 0 };
      const port = {
        defaultBranch: async () => { calls.defaultBranch += 1; if (o.fail) throw o.fail; await o.during?.(); return "main"; },
        branchState: async () => { calls.branchState += 1; return { exists: true, headOid: HEAD, aheadBy: 0, defaultBranch: "main" }; },
      };
      return { calls, port: port as unknown as ReturnType<OperateQueueDeps["pullRequests"]> };
    };
    const deps = (gh: ReturnType<typeof fakeGithub>, over: Partial<OperateQueueDeps> = {}): OperateQueueDeps =>
      ({ pool: h.opsPool, engineCommandSigner: async () => signer, pullRequests: () => gh.port, reportError: (_e, c) => void reports.push({ stage: c.stage, ...(c.code ? { code: c.code } : {}) }), ...over });
    const age = (accountId: string) => h.admin.query("UPDATE engine_operate_queue SET claimed_at = now() - interval '10 minutes' WHERE account_id = $1 AND state = 'pending'", [accountId]);

    it("starts every ticked repo of an account that turned operate on, 4 at a time, never more than 4 claimed", async () => {
      const r = await rig();
      for (let i = 0; i < 9; i++) await addRepo(r);
      expect(await queue(r.who.accountId, "state = 'pending'")).toHaveLength(10);
      let max = 0;
      const gh = fakeGithub({ during: async () => { max = Math.max(max, (await queue(r.who.accountId, "state = 'running'")).length); } });
      const issuedAfter: number[] = [];
      for (let pass = 0; pass < 3; pass++) {
        const p = await drainOperateQueue(deps(gh), { accountId: r.who.accountId });
        issuedAfter.push(p.issued);
      }
      expect(issuedAfter).toEqual([4, 4, 2]);
      expect(max).toBe(4);
      expect(await queue(r.who.accountId, "state <> 'done'")).toEqual([]);
      expect(await jobs(r.who.accountId)).toHaveLength(10);
      expect(new Set((await jobs(r.who.accountId)).map((j) => j.repo_id)).size).toBe(10);
      expect(await drainOperateQueue(deps(gh), { accountId: r.who.accountId })).toEqual({ not_configured: false, issued: 0, results: [] });
    });
    it("starts a repo once when its first start went first: the install's start is the only start job after the drain", async () => {
      const r = await rig({ setup: false });
      await queuedAgo(r, 60_000);
      await addSetup(r.who, r.who.repoId, true);
      expect(await issue(r, { cause: "first_start" })).toBe("issued");
      await h.admin.query("UPDATE machine_jobs SET state = 'done', delivered_at = now() WHERE account_id = $1 AND kind = 'engine_session_start'", [r.who.accountId]);
      const gh = fakeGithub();
      const pass = await drainOperateQueue(deps(gh), { accountId: r.who.accountId });
      expect(pass).toMatchObject({ issued: 0, results: [{ action: "start", outcome: "done" }] });
      expect(await jobs(r.who.accountId)).toHaveLength(1);
      expect((await jobs(r.who.accountId))[0]!.job.job.args.resume).toBe(false);
      expect((await queue(r.who.accountId))[0]!.state).toBe("done");
      expect(await drainOperateQueue(deps(gh), { accountId: r.who.accountId })).toEqual({ not_configured: false, issued: 0, results: [] });
      expect(await jobs(r.who.accountId)).toHaveLength(1);
    });
    it("starts a repo once when a person started it first", async () => {
      const r = await rig();
      await queuedAgo(r, 60_000);
      await addJob(r, "done", { agoMs: 10_000 });
      const pass = await drainOperateQueue(deps(fakeGithub()), { accountId: r.who.accountId });
      expect(pass.issued).toBe(0);
      expect(await jobs(r.who.accountId)).toHaveLength(1);
      expect(await audits(r.who.accountId)).toEqual([]);
      expect((await queue(r.who.accountId))[0]!.state).toBe("done");
    });
    it("holds a pass to the repos of its scope, and leaves another account's rows pending", async () => {
      const a = await rig();
      const b = await rig();
      const pass = await drainOperateQueue(deps(fakeGithub()), { accountId: a.who.accountId });
      expect(pass.results.map((x) => [x.account_id, x.result, x.outcome])).toEqual([[a.who.accountId, "issued", "done"]]);
      expect((await queue(b.who.accountId))[0]!.state).toBe("pending");
      expect(await jobs(b.who.accountId)).toEqual([]);
    });
    it("stops a repo once for two causes: operate off, then the repo unticked, make one stop job", async () => {
      const r = await rig();
      const second = await addRepo(r, { sandbox: true });
      await addSandbox(r.who.accountId, r.runnerId, r.ghRepoId);
      await h.admin.query("DELETE FROM engine_operate_queue WHERE account_id = $1", [r.who.accountId]);
      await h.admin.query("UPDATE engine_bridge_settings SET operate_enabled = false WHERE account_id = $1", [r.who.accountId]);
      await h.admin.query("DELETE FROM engine_bridge_repos WHERE account_id = $1 AND repo_id = $2", [r.who.accountId, second.repoId]);
      expect((await queue(r.who.accountId)).map((x) => [x.action, x.operate_epoch])).toEqual([["stop", 2], ["stop", 2]]);
      const pass = await drainOperateQueue(deps(fakeGithub()), { accountId: r.who.accountId });
      expect(pass.issued).toBe(2);
      expect(pass.results.map((x) => [x.action, x.result, x.outcome])).toEqual([["stop", "issued", "done"], ["stop", "issued", "done"]]);
      const stops = await jobs(r.who.accountId, "engine_session_stop");
      expect(stops.map((s) => s.repo_id).sort()).toEqual([r.who.repoId, second.repoId].sort());
      expect(stops.every((s) => s.job.job.args.operate_epoch === 2 && s.job.job.args.reason === "operate_off")).toBe(true);
      expect(await drainOperateQueue(deps(fakeGithub()), { accountId: r.who.accountId })).toEqual({ not_configured: false, issued: 0, results: [] });
      expect(await jobs(r.who.accountId, "engine_session_stop")).toHaveLength(2);
    });
    it("ends a stop row whose repo has nothing running, signing no job", async () => {
      const r = await rig({ operate: false });
      await h.admin.query("UPDATE engine_bridge_settings SET operate_enabled = true WHERE account_id = $1", [r.who.accountId]);
      await h.admin.query("UPDATE engine_bridge_settings SET operate_enabled = false WHERE account_id = $1", [r.who.accountId]);
      await h.admin.query("DELETE FROM engine_operate_queue WHERE account_id = $1 AND action = 'start'", [r.who.accountId]);
      const pass = await drainOperateQueue(deps(fakeGithub()), { accountId: r.who.accountId });
      expect(pass).toMatchObject({ issued: 0, results: [{ action: "stop", result: "cause_gone", outcome: "done" }] });
      expect(await jobs(r.who.accountId, "engine_session_stop")).toEqual([]);
      expect((await queue(r.who.accountId))[0]!.state).toBe("done");
    });
    it("retries a start whose GitHub cannot be read, keeps it for the next tick, and starts it once GitHub answers", async () => {
      const r = await rig();
      for (const [err, want] of [[new RunPullRequestError("unavailable"), "github_unavailable"], [new RunPullRequestError("rejected"), "github_refused"]] as const) {
        const pass = await drainOperateQueue(deps(fakeGithub({ fail: err })), { accountId: r.who.accountId });
        expect(pass.results).toEqual([{ account_id: r.who.accountId, repo_id: r.who.repoId, action: "start", result: want, outcome: "retry" }]);
        expect((await queue(r.who.accountId))[0]).toMatchObject({ state: "pending" });
        await age(r.who.accountId);
      }
      expect((await queue(r.who.accountId))[0]!.attempts).toBe(2);
      expect(await drainOperateQueue(deps(fakeGithub()), { accountId: r.who.accountId })).toMatchObject({ issued: 1 });
      expect((await queue(r.who.accountId))[0]!.state).toBe("done");
    });
    it("waits for the backoff: a retried row is not tried again inside its 30 seconds", async () => {
      const r = await rig();
      await drainOperateQueue(deps(fakeGithub({ fail: new RunPullRequestError("unavailable") })), { accountId: r.who.accountId });
      const gh = fakeGithub();
      expect(await drainOperateQueue(deps(gh), { accountId: r.who.accountId })).toEqual({ not_configured: false, issued: 0, results: [] });
      expect(gh.calls.defaultBranch).toBe(0);
    });
    it("keeps a start whose plan has lapsed, signing nothing", async () => {
      const r = await rig();
      await h.admin.query("UPDATE accounts SET stripe_subscription_status = 'canceled', subscription_ended_at = now() WHERE id = $1", [r.who.accountId]);
      const pass = await drainOperateQueue(deps(fakeGithub()), { accountId: r.who.accountId });
      expect(pass.results.map((x) => [x.result, x.outcome])).toEqual([["plan", "retry"]]);
      expect(await jobs(r.who.accountId)).toEqual([]);
      expect((await queue(r.who.accountId))[0]).toMatchObject({ state: "pending", attempts: 1 });
    });
    it("ends a start whose repo was unticked in between, and one that was never placed", async () => {
      const unticked = await rig();
      await h.admin.query("DELETE FROM engine_bridge_repos WHERE account_id = $1", [unticked.who.accountId]);
      expect(await drainOperateQueue(deps(fakeGithub()), { accountId: unticked.who.accountId })).toMatchObject({ issued: 0 });
      const unplaced = await rig();
      await h.admin.query("DELETE FROM project_placements WHERE account_id = $1", [unplaced.who.accountId]);
      const gh = fakeGithub();
      expect(await drainOperateQueue(deps(gh), { accountId: unplaced.who.accountId })).toMatchObject({ issued: 0, results: [{ result: "cause_gone", outcome: "done" }] });
      expect(gh.calls.defaultBranch).toBe(0);
      for (const r of [unticked, unplaced]) {
        expect((await queue(r.who.accountId, "action = 'start'")).every((x) => x.state === "done")).toBe(true);
        expect(await jobs(r.who.accountId)).toEqual([]);
      }
    });
    it("releases every claimed row untouched when there is no signer or no time, counting no attempt", async () => {
      const r = await rig();
      await addRepo(r);
      const none = await drainOperateQueue(deps(fakeGithub(), { engineCommandSigner: async () => null }), { accountId: r.who.accountId });
      expect(none.not_configured).toBe(true);
      expect(none.results.map((x) => [x.result, x.outcome])).toEqual([["released", "release"], ["released", "release"]]);
      expect((await queue(r.who.accountId)).map((x) => [x.state, x.attempts])).toEqual([["pending", 0], ["pending", 0]]);
      const late = await drainOperateQueue(deps(fakeGithub()), { accountId: r.who.accountId, msLeft: () => 0 });
      expect(late.issued).toBe(0);
      expect((await queue(r.who.accountId)).map((x) => [x.state, x.attempts])).toEqual([["pending", 0], ["pending", 0]]);
      expect(await jobs(r.who.accountId)).toEqual([]);
      expect(await drainOperateQueue(deps(fakeGithub()), { accountId: r.who.accountId })).toMatchObject({ issued: 2 });
    });
    it("reports an unexpected error on one row, retries it, and goes on", async () => {
      const r = await rig();
      await addRepo(r);
      reports.length = 0;
      let n = 0;
      const gh = fakeGithub();
      const port = { ...gh.port, defaultBranch: async () => { if ((n += 1) === 1) throw new Error("boom"); return "main"; } };
      const pass = await drainOperateQueue(deps(gh, { pullRequests: () => port as never }), { accountId: r.who.accountId });
      expect(pass.results.map((x) => [x.result, x.outcome]).sort()).toEqual([["error", "retry"], ["issued", "done"]]);
      expect(reports.map((x) => x.code)).toContain("engine_system_start_failed");
      expect((await queue(r.who.accountId, "state = 'pending'"))).toHaveLength(1);
    });
    it("needs an account for a repo", async () => {
      await expect(drainOperateQueue(deps(fakeGithub()), { repoId: randomUUID() })).rejects.toThrow(/account/);
    });
    it("claims a row once when two drains race", async () => {
      const r = await rig();
      const gh = fakeGithub();
      const [x, y] = await Promise.all([drainOperateQueue(deps(gh), { accountId: r.who.accountId }), drainOperateQueue(deps(gh), { accountId: r.who.accountId })]);
      expect(x.issued + y.issued).toBe(1);
      expect(await jobs(r.who.accountId)).toHaveLength(1);
    });
  });

  describe("what each answer does to a row", () => {
    it("finishes a start on every answer the issuer can give, and a stop likewise", () => {
      expect((["issued", "cause_gone", "not_placed", "epoch_moved", undefined] as const).map((x) => startOutcome(x))).toEqual(Array(5).fill("done"));
      expect(["plan", "busy", "github_unavailable", "github_refused", "default_branch_empty", "hosted_engine_unavailable", "error"].map((x) => startOutcome(x as never))).toEqual(Array(7).fill("retry"));
      expect((["issued", "superseded_only", "cause_gone", "already_stopping", "not_placed", "epoch_moved", undefined] as const).map((x) => stopOutcome(x))).toEqual(Array(7).fill("done"));
      expect(["awaiting_report", "error"].map((x) => stopOutcome(x as never))).toEqual(["retry", "retry"]);
    });
  });
});
