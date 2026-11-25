import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MACHINE_JOB_CLAIM_PATH, signMachineJob, verifyMachineJob, type MachineJob } from "@fulcrumaxe/runner-protocol";
import { readEngineCoverage } from "@fx/core/src/onboarding/engineCoverage.js";
import { setEngineBridgeSettings } from "@fx/db/src/engineBridge.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { HELLO_PATH, issueEngineSessionStart, issueEngineSessionStop, issueSystemStops, machineJobClaimRun, runnerHello, type RunnerCloudDeps, type RunPullRequestPort, type SystemStopDeps } from "../src/index.js";
import { harness, newKey, registerKey, signed, respond, type Harness, type TestKey } from "./helpers.js";

const HEAD = "e".repeat(40);

/**
 * [pg] D#845 ON-13a5 (migration 1077): the plan and operated predicates, the system stop list, the issuer, the deliver check, the pass in TypeScript and the lock it shares with a person's start. Real Postgres, the real roles
 * (platform_ops runs the list and the issuer, app_user the runner's claim and the person's start), row security forced and real Ed25519 signatures. Nothing here reaches a network.
 */
describe("system engine stops [pg]", () => {
  let h: Harness;
  const keys = generateKeyPairSync("ed25519");
  const keyring = { "job-key-1": keys.publicKey };
  const signer = { keyId: "job-key-1", signMachineJob: (job: MachineJob) => signMachineJob(job, "job-key-1", keys.privateKey) };
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  const github = (): RunPullRequestPort =>
    ({ defaultBranch: async () => "main", branchState: async () => ({ exists: true, headOid: HEAD, aheadBy: 0, defaultBranch: "main" }) }) as unknown as RunPullRequestPort;
  const personDeps = (): RunnerCloudDeps => h.deps({ pullRequests: github(), engineCommandSigner: async () => signer as never });
  const reports: Array<{ stage: string; code?: string }> = [];
  const stopDeps = (over: Partial<SystemStopDeps> = {}): SystemStopDeps => ({ pool: h.opsPool, engineCommandSigner: async () => signer, reportError: (_e, c) => void reports.push({ stage: c.stage, ...(c.code ? { code: c.code } : {}) }), ...over });

  interface Rig { who: SeedRefs; key: TestKey; runnerId: string; ghRepoId: number }
  /** A fresh account with one repo placed on one machine, an engine plan of one, watch and operate on (epoch 1), the repo ticked and its engine's sandbox running; each can be turned off. */
  async function rig(o: { operate?: boolean; watch?: boolean; tick?: boolean; plan?: number; sandbox?: string | null; seen?: boolean } = {}): Promise<Rig> {
    const who = await seedAccount(h.admin, randomUUID());
    const ghRepoId = Number((await h.admin.query<{ gh_repo_id: string }>("SELECT gh_repo_id FROM repos WHERE id = $1", [who.repoId])).rows[0]!.gh_repo_id);
    await h.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [who.repoId]);
    const key = newKey();
    const runnerId = await registerKey(h.admin, who.accountId, who.userId, key);
    await h.admin.query("INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')", [who.repoId, who.accountId, runnerId]);
    await h.admin.query("UPDATE accounts SET engine_quantity = $2, stripe_subscription_status = 'active' WHERE id = $1", [who.accountId, o.plan ?? 1]);
    const watch = o.watch !== false;
    await h.admin.query("INSERT INTO engine_bridge_settings (account_id, watch_enabled, operate_enabled) VALUES ($1, $2, $3)", [who.accountId, watch, watch && o.operate !== false]);
    if (o.tick !== false) await h.admin.query("INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)", [who.accountId, who.repoId]);
    const r = { who, key, runnerId, ghRepoId };
    if (o.sandbox !== null) await sandbox(r, o.sandbox ?? "running");
    if (o.seen !== false) await report(r);
    return r;
  }
  /** The machine's hello at protocol 22 listing the session capability, so the real claim route offers it session jobs. */
  async function hello(r: Rig): Promise<void> {
    const res = await respond(() => runnerHello(h.deps(), signed(r.key, HELLO_PATH, {
      protocol_version: 22, binary_version: "0.5.0", model_auth_present: true, isolation: "host_sandbox", capabilities: ["engine_session_v1"], facts: { os: "linux", arch: "x64", mem_gb_bucket: 16, cpus: 8, sandbox_engine: "os_sandbox" },
    })));
    expect(res.status).toBe(200);
  }
  const sandbox = (r: Rig, state: string, ghRepoId = r.ghRepoId) =>
    h.admin.query("INSERT INTO runner_sandboxes (runner_id, slot, account_id, name, state, created_at, disk_bytes, snapshot_count) VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', 1000, 1)", [r.runnerId, ghRepoId % 150, r.who.accountId, `fx-engine-${ghRepoId}`, state]);
  /** The machine's inventory report, stamped at `at` (default: now). */
  const report = (r: Rig, at = "now()") =>
    h.admin.query(`INSERT INTO runner_sandbox_reports (runner_id, account_id, seen_at, row_count) VALUES ($1, $2, ${at}, 1) ON CONFLICT (runner_id) DO UPDATE SET seen_at = EXCLUDED.seen_at`, [r.runnerId, r.who.accountId]);
  const operate = (r: Rig, on: boolean) => h.admin.query("UPDATE engine_bridge_settings SET operate_enabled = $2 WHERE account_id = $1", [r.who.accountId, on]);
  const epochOf = async (r: Rig) => (await h.admin.query<{ operate_epoch: number }>("SELECT operate_epoch FROM engine_bridge_settings WHERE account_id = $1", [r.who.accountId])).rows[0]!.operate_epoch;
  const jobs = async (accountId: string, kind: string) =>
    (await h.admin.query<{ id: string; repo_id: string; state: string; stop_reason: string | null; job: { job: MachineJob; key_id: string } }>("SELECT id, repo_id, state, stop_reason, job FROM machine_jobs WHERE account_id = $1 AND kind = $2 ORDER BY issued_at, id", [accountId, kind])).rows;
  const due = async (accountId?: string, repoId?: string) =>
    (await h.opsPool.query<{ o_account: string; o_repo: string; o_runner: string; o_repo_gh_id: string; o_reason: string; o_epoch: number; o_issued_starts: number }>("SELECT * FROM engine_system_stops_due($1::uuid, $2::uuid, 500)", [accountId ?? null, repoId ?? null])).rows;
  /** A start row as machine_job_issue would write it. */
  async function issuedStart(r: Rig, state = "issued", repoId = r.who.repoId, runnerId = r.runnerId, ghRepoId = r.ghRepoId): Promise<string> {
    const id = randomUUID();
    const issued = new Date(Date.now() - 60_000);
    const expires = new Date(issued.getTime() + 25 * 60_000);
    const job = signer.signMachineJob({ v: 1, job_id: id, runner_id: runnerId, repo_gh_id: ghRepoId, requires_engine: "any", issued_at: issued.toISOString(), expires_at: expires.toISOString(), kind: "engine_session_start", args: { at_sha: HEAD, resume: false, operate_epoch: 1 } } as MachineJob);
    await h.admin.query(
      "INSERT INTO machine_jobs (id, account_id, runner_id, repo_id, kind, job, state, issued_at, expires_at, delivered_at) VALUES ($1, $2, $3, $4, 'engine_session_start', $5::jsonb, $6, $7, $8, $9)",
      [id, r.who.accountId, runnerId, repoId, JSON.stringify(job), state, issued, expires, state === "issued" ? null : issued],
    );
    return id;
  }
  /** A stop as the cloud would sign it, ready for the issuer. */
  function stopJob(r: Rig, o: { reason?: string; epoch?: number; kind?: string; runnerId?: string; ghRepoId?: number; jobId?: string } = {}): { id: string; json: string; issued: Date; expires: Date } {
    const id = o.jobId ?? randomUUID();
    const issued = new Date();
    const expires = new Date(issued.getTime() + 1_800_000);
    const job = signer.signMachineJob({
      v: 1, job_id: id, runner_id: o.runnerId ?? r.runnerId, repo_gh_id: o.ghRepoId ?? r.ghRepoId, requires_engine: "any", issued_at: issued.toISOString(), expires_at: expires.toISOString(),
      kind: o.kind ?? "engine_session_stop", args: o.kind === "engine_session_start" ? { at_sha: HEAD, resume: false, operate_epoch: o.epoch ?? 1 } : { reason: o.reason ?? "operate_off", operate_epoch: o.epoch ?? 1 },
    } as unknown as MachineJob);
    return { id, json: JSON.stringify(job), issued, expires };
  }
  async function issue(r: Rig, o: Parameters<typeof stopJob>[1] & { asReason?: string; accountId?: string; repoId?: string; pool?: "ops" | "app" } = {}): Promise<string> {
    const j = stopJob(r, o);
    const pool = o.pool === "app" ? h.appPool : h.opsPool;
    return (await pool.query<{ result: string }>("SELECT engine_system_stop_issue($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, $6, $7) AS result", [
      j.id, o.accountId ?? r.who.accountId, o.repoId ?? r.who.repoId, o.asReason ?? o.reason ?? "operate_off", j.json, j.issued, j.expires,
    ])).rows[0]!.result;
  }
  const code = async (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string; message?: string }) => e.code ?? `error:${e.message}`);

  describe("engine_plan_ended equals the coverage state plan_ended", () => {
    it("agrees with readEngineCoverage over twelve fixture accounts", async () => {
      const fixtures: Array<{ name: string; set: string; expected: boolean }> = [
        { name: "active", set: "stripe_subscription_status = 'active'", expected: false },
        { name: "trialing", set: "stripe_subscription_status = 'trialing'", expected: false },
        { name: "past_due 6d23h", set: "stripe_subscription_status = 'past_due', past_due_since = now() - interval '6 days 23 hours'", expected: false },
        { name: "past_due 7d+1m", set: "stripe_subscription_status = 'past_due', past_due_since = now() - interval '7 days 1 minute'", expected: true },
        { name: "past_due, no marker", set: "stripe_subscription_status = 'past_due', past_due_since = NULL", expected: true },
        { name: "canceled", set: "stripe_subscription_status = 'canceled', subscription_ended_at = now()", expected: true },
        { name: "paused", set: "stripe_subscription_status = 'paused'", expected: true },
        { name: "incomplete", set: "stripe_subscription_status = 'incomplete'", expected: true },
        { name: "no subscription", set: "stripe_subscription_status = NULL", expected: true },
        { name: "quantity 0", set: "engine_quantity = 0", expected: false },
        { name: "held and ended", set: "stripe_subscription_status = 'canceled', subscription_ended_at = now(), platform_hold_at = now()", expected: false },
        { name: "partner suspended and ended", set: "stripe_subscription_status = 'canceled', subscription_ended_at = now(), partner_suspended_at = now()", expected: false },
      ];
      expect(fixtures.length).toBeGreaterThanOrEqual(9);
      for (const f of fixtures) {
        const r = await rig();
        await h.admin.query(`UPDATE accounts SET ${f.set} WHERE id = $1`, [r.who.accountId]);
        const sql = (await h.admin.query<{ ended: boolean }>("SELECT engine_plan_ended($1) AS ended", [r.who.accountId])).rows[0]!.ended;
        const ts = (await readEngineCoverage(h.admin, r.who.accountId, true)).state === "plan_ended";
        expect({ f: f.name, sql }, f.name).toEqual({ f: f.name, sql: f.expected });
        expect({ f: f.name, ts }, f.name).toEqual({ f: f.name, ts: f.expected });
      }
    });

    it("is false for an account that does not exist and for a deleted one", async () => {
      expect((await h.admin.query<{ e: boolean }>("SELECT engine_plan_ended($1) AS e", [randomUUID()])).rows[0]!.e).toBe(false);
      const r = await rig();
      await h.admin.query("UPDATE accounts SET stripe_subscription_status = 'canceled', subscription_ended_at = now(), deleted_at = now() WHERE id = $1", [r.who.accountId]);
      expect((await h.admin.query<{ e: boolean }>("SELECT engine_plan_ended($1) AS e", [r.who.accountId])).rows[0]!.e).toBe(false);
    });
  });

  describe("engine_repo_operated", () => {
    const operated = async (r: Rig, repoId = r.who.repoId) => (await h.admin.query<{ o: boolean }>("SELECT engine_repo_operated($1, $2) AS o", [r.who.accountId, repoId])).rows[0]!.o;
    it("needs watch, operate and the repo's tick; each missing one gives false", async () => {
      expect(await operated(await rig())).toBe(true);
      expect(await operated(await rig({ operate: false }))).toBe(false);
      expect(await operated(await rig({ watch: false }))).toBe(false);
      expect(await operated(await rig({ tick: false }))).toBe(false);
      const none = await rig();
      await h.admin.query("DELETE FROM engine_bridge_settings WHERE account_id = $1", [none.who.accountId]);
      expect(await operated(none)).toBe(false);
    });
    it("does not read another account's tick, and does not count another repo of the same account", async () => {
      const a = await rig();
      const b = await rig();
      expect(await operated(a, b.who.repoId)).toBe(false);
      await h.admin.query("INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)", [b.who.accountId, b.who.repoId]).catch((): void => undefined);
      const sibling = randomUUID();
      await h.admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) SELECT $1, account_id, installation_id, gh_repo_id + 5000, product FROM repos WHERE id = $2", [sibling, a.who.repoId]);
      expect(await operated(a, sibling)).toBe(false);
    });
  });

  describe("the list (engine_system_stops_due)", () => {
    it("lists an operate off with a running sandbox at the current epoch, once", async () => {
      const r = await rig();
      expect(await due(r.who.accountId)).toEqual([]);
      await operate(r, false);
      expect(await due(r.who.accountId)).toEqual([{ o_account: r.who.accountId, o_repo: r.who.repoId, o_runner: r.runnerId, o_repo_gh_id: String(r.ghRepoId), o_reason: "operate_off", o_epoch: 2, o_issued_starts: 0 }]);
    });
    it("lists only the repo that was unticked, with operate still on", async () => {
      const r = await rig();
      const other = randomUUID();
      const runner2 = await registerKey(h.admin, r.who.accountId, r.who.userId, newKey());
      await h.admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) SELECT $1, account_id, installation_id, gh_repo_id + 7000, product FROM repos WHERE id = $2", [other, r.who.repoId]);
      await h.admin.query("INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')", [other, r.who.accountId, runner2]);
      await h.admin.query("INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)", [r.who.accountId, other]);
      await h.admin.query("INSERT INTO runner_sandboxes (runner_id, slot, account_id, name, state, created_at, disk_bytes, snapshot_count) VALUES ($1, 0, $2, $3, 'running', now(), 1, 0)", [runner2, r.who.accountId, `fx-engine-${r.ghRepoId + 7000}`]);
      await h.admin.query("DELETE FROM engine_bridge_repos WHERE account_id = $1 AND repo_id = $2", [r.who.accountId, r.who.repoId]);
      const rows = await due(r.who.accountId);
      expect(rows.map((x) => [x.o_repo, x.o_reason])).toEqual([[r.who.repoId, "operate_off"]]);
    });
    it("names `plan` when the plan ended, even with operate off, and nothing for a covered, operated account", async () => {
      const ended = await rig({ operate: false });
      await h.admin.query("UPDATE accounts SET stripe_subscription_status = 'canceled', subscription_ended_at = now() WHERE id = $1", [ended.who.accountId]);
      expect((await due(ended.who.accountId)).map((x) => x.o_reason)).toEqual(["plan"]);
      const fine = await rig();
      expect(await due(fine.who.accountId)).toEqual([]);
    });
    it("lists nothing for a stopped or snapshotted sandbox, a machine with no sandbox, a revoked machine and a deleted account", async () => {
      for (const state of ["stopped", "snapshotted", "error"]) {
        const r = await rig({ operate: false, sandbox: state });
        expect(await due(r.who.accountId), state).toEqual([]);
      }
      expect(await due((await rig({ operate: false, sandbox: null })).who.accountId)).toEqual([]);
      const revoked = await rig({ operate: false });
      await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [revoked.runnerId]);
      expect(await due(revoked.who.accountId)).toEqual([]);
      const gone = await rig({ operate: false });
      await h.admin.query("UPDATE accounts SET deleted_at = now() WHERE id = $1", [gone.who.accountId]);
      expect(await due(gone.who.accountId)).toEqual([]);
    });
    it("lists a repo that has only an issued start, and counts it", async () => {
      const r = await rig({ operate: false, sandbox: null });
      await issuedStart(r);
      expect(await due(r.who.accountId)).toMatchObject([{ o_reason: "operate_off", o_issued_starts: 1 }]);
    });
    it("lists nothing while a person's stop is waiting, however it was issued", async () => {
      for (const state of ["issued", "delivered"]) {
        const r = await rig({ operate: false });
        const j = stopJob(r, { reason: "person" });
        await h.admin.query("INSERT INTO machine_jobs (id, account_id, runner_id, repo_id, kind, job, state, issued_at, expires_at, delivered_at) VALUES ($1, $2, $3, $4, 'engine_session_stop', $5::jsonb, $6, $7, $8, $9)", [
          j.id, r.who.accountId, r.runnerId, r.who.repoId, j.json, state, j.issued, j.expires, state === "issued" ? null : j.issued,
        ]);
        // Even a machine that reported long after the stop was issued has it waiting: it is the pending one that blocks, not the report.
        await report(r, "now() + interval '1 hour'");
        expect(await due(r.who.accountId), state).toEqual([]);
      }
    });
    it("lists a repo again only after the machine reports past the stop it was issued", async () => {
      const r = await rig({ operate: false, seen: false });
      await report(r, "now() - interval '2 hours'");
      expect(await due(r.who.accountId)).toHaveLength(1);
      const j = stopJob(r);
      await h.admin.query("INSERT INTO machine_jobs (id, account_id, runner_id, repo_id, kind, job, state, issued_at, expires_at) VALUES ($1, $2, $3, $4, 'engine_session_stop', $5::jsonb, 'expired', $6, $7)", [j.id, r.who.accountId, r.runnerId, r.who.repoId, j.json, j.issued, j.expires]);
      expect(await due(r.who.accountId), "the stop was issued after the last report").toEqual([]);
      await report(r, "now() + interval '1 minute'");
      expect(await due(r.who.accountId), "the machine reported since").toHaveLength(1);
    });
    it("treats a machine that never reported as having reported before every stop", async () => {
      const r = await rig({ operate: false, seen: false });
      expect(await due(r.who.accountId)).toHaveLength(1);
      const j = stopJob(r);
      await h.admin.query("INSERT INTO machine_jobs (id, account_id, runner_id, repo_id, kind, job, state, issued_at, expires_at) VALUES ($1, $2, $3, $4, 'engine_session_stop', $5::jsonb, 'expired', $6, $7)", [j.id, r.who.accountId, r.runnerId, r.who.repoId, j.json, j.issued, j.expires]);
      expect(await due(r.who.accountId)).toEqual([]);
    });
    it("judges each repo by its own sessions: a sibling repo's issued start, another machine's report and a sandbox left on a machine the repo moved off do not list it", async () => {
      const r = await rig({ operate: false, sandbox: null });
      // The account's second repo has an issued start; this repo has nothing of its own.
      const sibling = randomUUID();
      const runner2 = await registerKey(h.admin, r.who.accountId, r.who.userId, newKey());
      await h.admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) SELECT $1, account_id, installation_id, gh_repo_id + 6000, product FROM repos WHERE id = $2", [sibling, r.who.repoId]);
      await h.admin.query("INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')", [sibling, r.who.accountId, runner2]);
      await issuedStart(r, "issued", sibling, runner2, r.ghRepoId + 6000);
      await h.admin.query("INSERT INTO runner_sandbox_reports (runner_id, account_id, seen_at, row_count) VALUES ($1, $2, now() + interval '1 hour', 0)", [runner2, r.who.accountId]);
      expect((await due(r.who.accountId)).map((x) => x.o_repo), "only the sibling is listed, once").toEqual([sibling]);
      // This repo's engine sandbox still runs on a machine it moved off (its placement is on a third machine, which lists nothing).
      const moved = await rig({ operate: false, sandbox: "running" });
      const runner3 = await registerKey(h.admin, moved.who.accountId, moved.who.userId, newKey());
      await h.admin.query("UPDATE project_placements SET runner_id = $2 WHERE repo_id = $1", [moved.who.repoId, runner3]);
      expect(await due(moved.who.accountId), "the old machine's sandbox is not the placed machine's").toEqual([]);
    });
    it("scopes to one account and one repo, bounds the limit, and refuses a repo with no account", async () => {
      const a = await rig({ operate: false });
      const b = await rig({ operate: false });
      expect((await due(a.who.accountId)).map((x) => x.o_account)).toEqual([a.who.accountId]);
      expect((await due(a.who.accountId, b.who.repoId))).toEqual([]);
      expect((await due()).map((x) => x.o_account)).toEqual(expect.arrayContaining([a.who.accountId, b.who.accountId]));
      for (const args of [[null, a.who.repoId, 10], [null, null, 0], [null, null, 501], [null, null, null]]) {
        expect(await code(h.opsPool.query("SELECT * FROM engine_system_stops_due($1::uuid, $2::uuid, $3::integer)", args)), JSON.stringify(args)).toBe("22023");
      }
    });
    it("is refused to app_user, to a runner session and to a platform_ops session that carries a person", async () => {
      const r = await rig({ operate: false });
      expect(await code(h.appPool.query("SELECT * FROM engine_system_stops_due(NULL, NULL, 10)"))).toBe("42501");
      for (const setting of ["app.user_id", "app.runner_id"]) {
        const c = await h.opsPool.connect();
        try {
          await c.query("BEGIN");
          await c.query("SELECT set_config($1, $2, true)", [setting, r.who.userId]);
          expect(await code(c.query("SELECT * FROM engine_system_stops_due(NULL, NULL, 10)")), setting).toBe("42501");
        } finally {
          await c.query("ROLLBACK");
          c.release();
        }
      }
    });
  });

  describe("the issuer (engine_system_stop_issue)", () => {
    it("issues a stop the keyring verifies, writes the audit row as platform_ops, and leaves the job's columns equal to its bytes", async () => {
      const r = await rig({ operate: false });
      const epoch = await epochOf(r);
      const j = stopJob(r, { epoch });
      const result = (await h.opsPool.query<{ result: string }>("SELECT engine_system_stop_issue($1::uuid, $2, $3, 'operate_off', $4::jsonb, $5, $6) AS result", [j.id, r.who.accountId, r.who.repoId, j.json, j.issued, j.expires])).rows[0]!.result;
      expect(result).toBe("issued");
      const [row] = await jobs(r.who.accountId, "engine_session_stop");
      expect(row).toMatchObject({ id: j.id, state: "issued", stop_reason: "operate_off" });
      expect(verifyMachineJob(row!.job, keyring, r.runnerId)).toMatchObject({ kind: "engine_session_stop", repo_gh_id: r.ghRepoId, args: { reason: "operate_off", operate_epoch: epoch } });
      const audit = (await h.admin.query<{ actor: string; payload: Record<string, unknown> }>("SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'engine_session.stopped'", [r.who.accountId])).rows;
      expect(audit).toEqual([{ actor: "platform_ops", payload: { repo_id: r.who.repoId, job_id: j.id, reason: "operate_off" } }]);
    });

    it("answers each result: cause_gone, epoch_moved, already_stopping, awaiting_report, superseded_only and not_placed, and writes nothing for them", async () => {
      const gone = await rig();
      expect(await issue(gone, { epoch: 1 })).toBe("cause_gone");
      const planGone = await rig({ operate: false });
      expect(await issue(planGone, { reason: "plan", epoch: await epochOf(planGone) })).toBe("cause_gone");
      const moved = await rig({ operate: false });
      expect(await issue(moved, { epoch: (await epochOf(moved)) + 1 })).toBe("epoch_moved");
      const twice = await rig({ operate: false });
      const e = await epochOf(twice);
      expect(await issue(twice, { epoch: e })).toBe("issued");
      expect(await issue(twice, { epoch: e })).toBe("already_stopping");
      const awaiting = await rig({ operate: false });
      const ea = await epochOf(awaiting);
      expect(await issue(awaiting, { epoch: ea })).toBe("issued");
      await h.admin.query("UPDATE machine_jobs SET state = 'expired' WHERE account_id = $1 AND kind = 'engine_session_stop'", [awaiting.who.accountId]);
      await report(awaiting, "now() - interval '1 minute'");
      expect(await issue(awaiting, { epoch: ea })).toBe("awaiting_report");
      const idle = await rig({ operate: false, sandbox: null });
      expect(await issue(idle, { epoch: await epochOf(idle) })).toBe("superseded_only");
      const foreign = await rig({ operate: false });
      const other = await rig({ operate: false });
      expect(await issue(foreign, { epoch: await epochOf(foreign), repoId: other.who.repoId })).toBe("not_placed");
      for (const x of [gone, planGone, moved, idle, foreign]) expect(await jobs(x.who.accountId, "engine_session_stop"), "writes nothing").toEqual([]);
      expect(await jobs(awaiting.who.accountId, "engine_session_stop")).toHaveLength(1);
      expect(await jobs(twice.who.accountId, "engine_session_stop")).toHaveLength(1);
    });

    it("does not stop a revoked machine's repo, and answers not_placed for an unplaced one", async () => {
      const revoked = await rig({ operate: false });
      await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [revoked.runnerId]);
      expect(await issue(revoked, { epoch: await epochOf(revoked) })).toBe("not_placed");
      const unplaced = await rig({ operate: false });
      await h.admin.query("DELETE FROM project_placements WHERE repo_id = $1", [unplaced.who.repoId]);
      expect(await issue(unplaced, { epoch: await epochOf(unplaced) })).toBe("not_placed");
    });

    it("refuses with 22023, and writes nothing, for a signed job that is a start, a person's reason, another runner, another job id, another repo or another reason", async () => {
      const r = await rig({ operate: false });
      const epoch = await epochOf(r);
      const otherRunner = await registerKey(h.admin, r.who.accountId, r.who.userId, newKey());
      const attempts: Array<[string, Parameters<typeof issue>[1]]> = [
        ["a start", { kind: "engine_session_start", epoch: epoch + 1 }],
        ["a person's reason in the bytes", { reason: "person", epoch, asReason: "operate_off" }],
        ["a person's reason asked for", { reason: "person", epoch, asReason: "person" }],
        ["another runner", { runnerId: otherRunner, epoch }],
        ["another repo id", { ghRepoId: r.ghRepoId + 1, epoch }],
        ["another reason than asked", { reason: "plan", epoch, asReason: "operate_off" }],
      ];
      for (const [name, o] of attempts) expect(await code(issue(r, o)), name).toBe("22023");
      // The job id in the bytes is not the id asked for.
      const j = stopJob(r, { epoch });
      expect(await code(h.opsPool.query("SELECT engine_system_stop_issue($1::uuid, $2, $3, 'operate_off', $4::jsonb, $5, $6)", [randomUUID(), r.who.accountId, r.who.repoId, j.json, j.issued, j.expires]))).toBe("22023");
      // A setup id smuggled into the bytes.
      const withSetup = JSON.parse(j.json) as { job: Record<string, unknown> };
      withSetup.job.setup_id = randomUUID();
      expect(await code(h.opsPool.query("SELECT engine_system_stop_issue($1::uuid, $2, $3, 'operate_off', $4::jsonb, $5, $6)", [j.id, r.who.accountId, r.who.repoId, JSON.stringify(withSetup), j.issued, j.expires]))).toBe("22023");
      // Times that are not the bytes' times are refused by the table's own CHECK.
      expect(await code(h.opsPool.query("SELECT engine_system_stop_issue($1::uuid, $2, $3, 'operate_off', $4::jsonb, $5, $6)", [j.id, r.who.accountId, r.who.repoId, j.json, new Date(j.issued.getTime() + 1000), j.expires]))).toBe("23514");
      expect(await jobs(r.who.accountId, "engine_session_stop")).toEqual([]);
    });

    it("refuses a null argument and a reason outside the two with 22023", async () => {
      const r = await rig({ operate: false });
      const j = stopJob(r, { epoch: await epochOf(r) });
      for (const reason of ["person", "halt", "move", "remove", "park", "", null]) {
        expect(await code(h.opsPool.query("SELECT engine_system_stop_issue($1::uuid, $2, $3, $4, $5::jsonb, $6, $7)", [j.id, r.who.accountId, r.who.repoId, reason, j.json, j.issued, j.expires])), String(reason)).toBe("22023");
      }
      expect(await code(h.opsPool.query("SELECT engine_system_stop_issue(NULL, $1, $2, 'plan', $3::jsonb, $4, $5)", [r.who.accountId, r.who.repoId, j.json, j.issued, j.expires]))).toBe("22023");
    });

    it("supersedes the repo's issued starts and leaves delivered starts, other repos and other accounts alone", async () => {
      const r = await rig({ operate: false });
      const other = await rig({ operate: false });
      const issuedA = await issuedStart(r);
      const issuedB = await issuedStart(r);
      const delivered = await issuedStart(r, "delivered");
      const otherIssued = await issuedStart(other);
      // A second repo of the same account, on a second machine.
      const sibling = randomUUID();
      const runner2 = await registerKey(h.admin, r.who.accountId, r.who.userId, newKey());
      await h.admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) SELECT $1, account_id, installation_id, gh_repo_id + 9000, product FROM repos WHERE id = $2", [sibling, r.who.repoId]);
      await h.admin.query("INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')", [sibling, r.who.accountId, runner2]);
      const siblingIssued = await issuedStart(r, "issued", sibling, runner2, r.ghRepoId + 9000);
      expect(await issue(r, { epoch: await epochOf(r) })).toBe("issued");
      const states = async () => Object.fromEntries((await h.admin.query<{ id: string; state: string }>("SELECT id, state FROM machine_jobs WHERE id = ANY($1::uuid[])", [[issuedA, issuedB, delivered, otherIssued, siblingIssued]])).rows.map((x) => [x.id, x.state]));
      expect(await states()).toEqual({ [issuedA]: "superseded", [issuedB]: "superseded", [delivered]: "delivered", [otherIssued]: "issued", [siblingIssued]: "issued" });
    });

    it("tidies an issued start and issues no stop when nothing is live", async () => {
      const r = await rig({ operate: false, sandbox: null });
      const start = await issuedStart(r);
      expect(await issue(r, { epoch: await epochOf(r) })).toBe("superseded_only");
      expect((await h.admin.query<{ state: string }>("SELECT state FROM machine_jobs WHERE id = $1", [start])).rows[0]!.state).toBe("superseded");
      expect(await jobs(r.who.accountId, "engine_session_stop")).toEqual([]);
      expect(await due(r.who.accountId), "and the repo is no longer listed").toEqual([]);
    });

    it("does not stop a repo whose engine sandbox runs only on a machine it moved off", async () => {
      const moved = await rig({ operate: false, sandbox: "running" });
      const runner3 = await registerKey(h.admin, moved.who.accountId, moved.who.userId, newKey());
      await h.admin.query("UPDATE project_placements SET runner_id = $2 WHERE repo_id = $1", [moved.who.repoId, runner3]);
      expect(await issue(moved, { epoch: await epochOf(moved), runnerId: runner3 })).toBe("superseded_only");
      expect(await jobs(moved.who.accountId, "engine_session_stop")).toEqual([]);
    });

    it("stops a repo whose start was delivered and has not yet created its sandbox", async () => {
      const r = await rig({ operate: false, sandbox: null });
      await issuedStart(r, "delivered");
      expect(await issue(r, { epoch: await epochOf(r) })).toBe("issued");
    });

    it("operate turned back on between the list and the issue gives cause_gone and no row, and an epoch bump gives epoch_moved", async () => {
      const r = await rig({ operate: false });
      const listed = (await due(r.who.accountId))[0]!;
      await operate(r, true);
      expect(await issue(r, { epoch: listed.o_epoch })).toBe("epoch_moved");
      expect(await issue(r, { epoch: await epochOf(r) })).toBe("cause_gone");
      expect(await jobs(r.who.accountId, "engine_session_stop")).toEqual([]);
      // Off again: the epoch moved on, so the listed one is stale, and the current one issues.
      await operate(r, false);
      expect(await issue(r, { epoch: listed.o_epoch })).toBe("epoch_moved");
      expect(await issue(r, { epoch: await epochOf(r) })).toBe("issued");
    });

    it("answers 42501 to app_user, to a runner session, and to a platform_ops session that carries a person or a runner", async () => {
      const r = await rig({ operate: false });
      const epoch = await epochOf(r);
      expect(await code(issue(r, { epoch, pool: "app" }))).toBe("42501");
      const j = stopJob(r, { epoch });
      const args = [j.id, r.who.accountId, r.who.repoId, j.json, j.issued, j.expires];
      const asRunner = withTenant(h.appPool, r.who.accountId, async (c: PoolClient) => {
        await c.query("SELECT set_config('app.runner_id', $1, true)", [r.runnerId]);
        await c.query("SELECT engine_system_stop_issue($1::uuid, $2, $3, 'operate_off', $4::jsonb, $5, $6)", args);
      });
      expect(await code(asRunner)).toBe("42501");
      for (const setting of ["app.user_id", "app.runner_id"]) {
        const c = await h.opsPool.connect();
        try {
          await c.query("BEGIN");
          await c.query("SELECT set_config($1, $2, true)", [setting, r.who.userId]);
          expect(await code(c.query("SELECT engine_system_stop_issue($1::uuid, $2, $3, 'operate_off', $4::jsonb, $5, $6)", args)), setting).toBe("42501");
        } finally {
          await c.query("ROLLBACK");
          c.release();
        }
      }
      expect(await code(h.admin.query("SELECT engine_system_stop_issue($1::uuid, $2, $3, 'operate_off', $4::jsonb, $5, $6)", args)), "a session that is not platform_ops").toBe("42501");
      expect(await jobs(r.who.accountId, "engine_session_stop")).toEqual([]);
    });
  });

  describe("the next grace end (engine_system_stop_next_due)", () => {
    const next = async () => (await h.opsPool.query<{ t: Date | null }>("SELECT engine_system_stop_next_due() AS t")).rows[0]!.t;
    it("is the earliest grace end of an account with a placed engine, and nothing for the others", async () => {
      const soon = await rig();
      const later = await rig();
      await h.admin.query("UPDATE accounts SET stripe_subscription_status = 'past_due', past_due_since = now() - interval '6 days' WHERE id = $1", [soon.who.accountId]);
      await h.admin.query("UPDATE accounts SET stripe_subscription_status = 'past_due', past_due_since = now() - interval '2 days' WHERE id = $1", [later.who.accountId]);
      const t = (await next())!;
      const expected = (await h.admin.query<{ t: Date }>("SELECT past_due_since + interval '7 days' AS t FROM accounts WHERE id = $1", [soon.who.accountId])).rows[0]!.t;
      // Other accounts of the shared database may hold an earlier one; none can hold one before this account's.
      expect(t.getTime()).toBeLessThanOrEqual(expected.getTime());
      for (const [name, set] of [["grace already ran out", "past_due_since = now() - interval '8 days'"], ["held", "platform_hold_at = now()"], ["ended", "subscription_ended_at = now()"], ["quantity 0", "engine_quantity = 0"], ["active", "stripe_subscription_status = 'active', past_due_since = NULL"]] as const) {
        const x = await rig();
        await h.admin.query(`UPDATE accounts SET stripe_subscription_status = 'past_due', past_due_since = now() - interval '3 days' WHERE id = $1`, [x.who.accountId]);
        await h.admin.query(`UPDATE accounts SET ${set} WHERE id = $1`, [x.who.accountId]);
        const own = (await h.opsPool.query<{ n: number }>("SELECT count(*)::int AS n FROM accounts a WHERE a.id = $1 AND a.past_due_since + interval '7 days' = (SELECT engine_system_stop_next_due())", [x.who.accountId])).rows[0]!.n;
        expect(own, name).toBe(0);
      }
    });
    it("is refused to app_user and to a session that carries a person", async () => {
      expect(await code(h.appPool.query("SELECT engine_system_stop_next_due()"))).toBe("42501");
    });
  });

  describe("machine_job_deliver: a start whose cause is gone is superseded, never delivered", () => {
    const deliver = async (r: Rig, id: string) => withTenant(h.appPool, r.who.accountId, async (c: PoolClient) => {
      await c.query("SELECT set_config('app.runner_id', $1, true)", [r.runnerId]);
      return (await c.query<{ job: unknown }>("SELECT machine_job_deliver($1::uuid) AS job", [id])).rows[0]!.job;
    });
    const stateOf = async (id: string) => (await h.admin.query<{ state: string; ended_at: Date | null }>("SELECT state, ended_at FROM machine_jobs WHERE id = $1", [id])).rows[0]!;

    it("delivers a start issued while the plan covers and the repo is operated, unchanged", async () => {
      const r = await rig({ sandbox: null });
      const id = await issuedStart(r);
      const row = (await h.admin.query<{ job: unknown }>("SELECT job FROM machine_jobs WHERE id = $1", [id])).rows[0]!.job;
      expect(await deliver(r, id)).toEqual(row);
      expect((await stateOf(id)).state).toBe("delivered");
    });
    it("supersedes a start whose plan ended before the claim, answers NULL, and stamps the end", async () => {
      const r = await rig({ sandbox: null });
      const id = await issuedStart(r);
      await h.admin.query("UPDATE accounts SET stripe_subscription_status = 'canceled', subscription_ended_at = now() WHERE id = $1", [r.who.accountId]);
      expect(await deliver(r, id)).toBeNull();
      expect(await stateOf(id)).toMatchObject({ state: "superseded", ended_at: expect.any(Date) });
    });
    it("supersedes a start after an untick (which does not move the epoch), after operate off and after watch off", async () => {
      for (const how of ["untick", "operate", "watch"]) {
        const r = await rig({ sandbox: null });
        const id = await issuedStart(r);
        const before = await epochOf(r);
        if (how === "untick") await h.admin.query("DELETE FROM engine_bridge_repos WHERE account_id = $1", [r.who.accountId]);
        else if (how === "operate") await operate(r, false);
        else await h.admin.query("UPDATE engine_bridge_settings SET watch_enabled = false, operate_enabled = false WHERE account_id = $1", [r.who.accountId]);
        if (how === "untick") expect(await epochOf(r), "an untick does not move the epoch").toBe(before);
        expect(await deliver(r, id), how).toBeNull();
        expect((await stateOf(id)).state, how).toBe("superseded");
      }
    });
    it("always delivers a stop, and every other kind of job, whatever the cause", async () => {
      const r = await rig({ operate: false });
      await h.admin.query("UPDATE accounts SET stripe_subscription_status = 'canceled', subscription_ended_at = now() WHERE id = $1", [r.who.accountId]);
      expect(await issue(r, { epoch: await epochOf(r), reason: "plan" })).toBe("issued");
      const [stop] = await jobs(r.who.accountId, "engine_session_stop");
      expect(await deliver(r, stop!.id)).toEqual(stop!.job);
    });
    it("leaves another account's start alone, and a start of a repo that is still operated", async () => {
      const gone = await rig({ sandbox: null });
      const kept = await rig({ sandbox: null });
      const keptStart = await issuedStart(kept);
      await operate(gone, false);
      const goneStart = await issuedStart(gone);
      expect(await deliver(gone, goneStart)).toBeNull();
      expect(await deliver(kept, keptStart)).not.toBeNull();
    });
    it("a second repo on the same account is judged by its own tick", async () => {
      const r = await rig({ sandbox: null });
      const sibling = randomUUID();
      const runner2 = await registerKey(h.admin, r.who.accountId, r.who.userId, newKey());
      await h.admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) SELECT $1, account_id, installation_id, gh_repo_id + 9500, product FROM repos WHERE id = $2", [sibling, r.who.repoId]);
      await h.admin.query("INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')", [sibling, r.who.accountId, runner2]);
      const second = await issuedStart({ ...r, runnerId: runner2 }, "issued", sibling, runner2, r.ghRepoId + 9500);
      // The sibling is not ticked: its start dies while the ticked repo's start is delivered.
      expect(await withTenant(h.appPool, r.who.accountId, async (c: PoolClient) => {
        await c.query("SELECT set_config('app.runner_id', $1, true)", [runner2]);
        return (await c.query<{ job: unknown }>("SELECT machine_job_deliver($1::uuid) AS job", [second])).rows[0]!.job;
      })).toBeNull();
      const first = await issuedStart(r);
      expect(await deliver(r, first)).not.toBeNull();
    });
    it("the real claim route skips the superseded start and hands over nothing", async () => {
      const r = await rig({ sandbox: null });
      await hello(r);
      await issuedStart(r);
      await h.admin.query("UPDATE accounts SET stripe_subscription_status = 'canceled', subscription_ended_at = now() WHERE id = $1", [r.who.accountId]);
      const res = await respond(() => machineJobClaimRun(h.deps(), signed(r.key, MACHINE_JOB_CLAIM_PATH, {})));
      expect(res.status).toBe(200);
      expect((res.body as { signed_job?: unknown }).signed_job).toBeUndefined();
    });
  });

  describe("issueSystemStops (TypeScript)", () => {
    it("signs args equal to the listed reason and epoch, and the result verifies under the signer's key", async () => {
      const r = await rig({ operate: false });
      const pass = await issueSystemStops(stopDeps(), { accountId: r.who.accountId });
      expect(pass).toEqual({ not_configured: false, issued: 1, results: [{ account_id: r.who.accountId, repo_id: r.who.repoId, reason: "operate_off", result: "issued" }] });
      const [row] = await jobs(r.who.accountId, "engine_session_stop");
      expect(verifyMachineJob(row!.job, keyring, r.runnerId)).toMatchObject({ kind: "engine_session_stop", args: { reason: "operate_off", operate_epoch: await epochOf(r) }, repo_gh_id: r.ghRepoId, requires_engine: "any" });
      expect(row).toMatchObject({ state: "issued", stop_reason: "operate_off" });
    });
    it("is idempotent: a second pass finds nothing due, and one stop exists", async () => {
      const r = await rig({ operate: false });
      expect((await issueSystemStops(stopDeps(), { accountId: r.who.accountId })).issued).toBe(1);
      expect(await issueSystemStops(stopDeps(), { accountId: r.who.accountId })).toEqual({ not_configured: false, issued: 0, results: [] });
      expect(await jobs(r.who.accountId, "engine_session_stop")).toHaveLength(1);
    });
    it("with no signer lists nothing and writes nothing", async () => {
      const r = await rig({ operate: false });
      for (const none of [async () => null, async () => ({}) as never]) {
        expect(await issueSystemStops(stopDeps({ engineCommandSigner: none }), { accountId: r.who.accountId })).toEqual({ not_configured: true, issued: 0, results: [] });
      }
      expect(await jobs(r.who.accountId, "engine_session_stop")).toEqual([]);
    });
    it("one failing repo does not stop the others", async () => {
      const bad = await rig({ operate: false });
      const good = await rig({ operate: false });
      reports.length = 0;
      const flaky = { keyId: "job-key-1", signMachineJob: (job: MachineJob) => { if (job.runner_id === bad.runnerId) throw new Error("signer down"); return signer.signMachineJob(job); } };
      const pass = await issueSystemStops(stopDeps({ engineCommandSigner: async () => flaky }), {});
      const mine = pass.results.filter((x) => x.account_id === bad.who.accountId || x.account_id === good.who.accountId);
      expect(mine.map((x) => [x.account_id === bad.who.accountId ? "bad" : "good", x.result]).sort()).toEqual([["bad", "error"], ["good", "issued"]]);
      expect(reports.some((x) => x.stage === "engine_system_stops.issue" && x.code === "engine_system_stop_failed")).toBe(true);
      expect(await jobs(bad.who.accountId, "engine_session_stop")).toEqual([]);
      expect(await jobs(good.who.accountId, "engine_session_stop")).toHaveLength(1);
    });
    it("retries an epoch that moved between the list and the issue, once, with the epoch now", async () => {
      const r = await rig({ operate: false });
      let listed = 0;
      const pool = new Proxy(h.opsPool, {
        get(target, prop, receiver) {
          if (prop === "query") {
            return async (sql: string, params: unknown[]) => {
              const res = await target.query(sql, params);
              // After the first list: operate goes on and off again, so the epoch the list carried is stale and the cause holds again.
              if (String(sql).includes("engine_system_stops_due") && ++listed === 1) {
                await operate(r, true);
                await operate(r, false);
              }
              return res;
            };
          }
          const value = Reflect.get(target, prop, receiver) as unknown;
          return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
      const first = (await due(r.who.accountId))[0]!.o_epoch;
      const pass = await issueSystemStops(stopDeps({ pool }), { accountId: r.who.accountId });
      expect(pass.results).toEqual([{ account_id: r.who.accountId, repo_id: r.who.repoId, reason: "operate_off", result: "issued" }]);
      const [row] = await jobs(r.who.accountId, "engine_session_stop");
      const epoch = (verifyMachineJob(row!.job, keyring, r.runnerId).args as { operate_epoch: number }).operate_epoch;
      expect(epoch).toBe(await epochOf(r));
      expect(epoch).toBe(first + 2);
    });
    it("stops at the time budget and refuses a repo with no account", async () => {
      const r = await rig({ operate: false });
      expect((await issueSystemStops(stopDeps(), { accountId: r.who.accountId, msLeft: () => 0 })).results).toEqual([]);
      await expect(issueSystemStops(stopDeps(), { repoId: r.who.repoId })).rejects.toThrow(/needs its account/);
    });
    it("never stops another account's session when the pass is scoped to one account and repo", async () => {
      const a = await rig({ operate: false });
      const b = await rig({ operate: false });
      const pass = await issueSystemStops(stopDeps(), { accountId: a.who.accountId, repoId: a.who.repoId });
      expect(pass.results.map((x) => x.account_id)).toEqual([a.who.accountId]);
      expect(await jobs(b.who.accountId, "engine_session_stop")).toEqual([]);
    });
  });

  describe("end to end: a plan ending or an off, then one tick, stops the sessions", () => {
    it("a subscription that ended gives a plan stop the machine claims and verifies", async () => {
      const r = await rig();
      await hello(r);
      expect(await issueSystemStops(stopDeps(), { accountId: r.who.accountId })).toMatchObject({ issued: 0 });
      await h.admin.query("UPDATE accounts SET stripe_subscription_status = 'canceled', subscription_ended_at = now() WHERE id = $1", [r.who.accountId]);
      const pass = await issueSystemStops(stopDeps(), { accountId: r.who.accountId });
      expect(pass.results).toEqual([{ account_id: r.who.accountId, repo_id: r.who.repoId, reason: "plan", result: "issued" }]);
      const claimed = await respond(() => machineJobClaimRun(h.deps(), signed(r.key, MACHINE_JOB_CLAIM_PATH, {})));
      const job = verifyMachineJob((claimed.body as { signed_job: { job: MachineJob; key_id: string } }).signed_job, keyring, r.runnerId);
      expect(job).toMatchObject({ kind: "engine_session_stop", args: { reason: "plan" } });
    });
    it("the clock moving past the grace gives the same, with no webhook", async () => {
      const r = await rig();
      await h.admin.query("UPDATE accounts SET stripe_subscription_status = 'past_due', past_due_since = now() - interval '6 days 23 hours 59 minutes' WHERE id = $1", [r.who.accountId]);
      expect(await due(r.who.accountId)).toEqual([]);
      await h.admin.query("UPDATE accounts SET past_due_since = now() - interval '7 days 1 minute' WHERE id = $1", [r.who.accountId]);
      expect((await issueSystemStops(stopDeps(), { accountId: r.who.accountId })).results).toMatchObject([{ reason: "plan", result: "issued" }]);
    });
    it("operate off stops every ticked repo's session, and unticking one repo stops only that one", async () => {
      const r = await rig();
      const second = randomUUID();
      const runner2 = await registerKey(h.admin, r.who.accountId, r.who.userId, newKey());
      await h.admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) SELECT $1, account_id, installation_id, gh_repo_id + 4000, product FROM repos WHERE id = $2", [second, r.who.repoId]);
      await h.admin.query("INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')", [second, r.who.accountId, runner2]);
      await h.admin.query("UPDATE accounts SET engine_quantity = 2 WHERE id = $1", [r.who.accountId]);
      await h.admin.query("INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)", [r.who.accountId, second]);
      await h.admin.query("INSERT INTO runner_sandboxes (runner_id, slot, account_id, name, state, created_at, disk_bytes, snapshot_count) VALUES ($1, 0, $2, $3, 'running', now(), 1, 0)", [runner2, r.who.accountId, `fx-engine-${r.ghRepoId + 4000}`]);
      await h.admin.query("DELETE FROM engine_bridge_repos WHERE account_id = $1 AND repo_id = $2", [r.who.accountId, second]);
      const one = await issueSystemStops(stopDeps(), { accountId: r.who.accountId });
      expect(one.results.map((x) => [x.repo_id, x.result])).toEqual([[second, "issued"]]);
      await operate(r, false);
      const all = await issueSystemStops(stopDeps(), { accountId: r.who.accountId });
      expect(all.results.map((x) => [x.repo_id, x.result])).toEqual([[r.who.repoId, "issued"]]);
      expect(await jobs(r.who.accountId, "engine_session_stop")).toHaveLength(2);
    });
  });

  it("seeds the reconcile job that runs the pass, every 60 seconds", async () => {
    expect((await h.admin.query("SELECT interval_seconds FROM reconcile_jobs WHERE name = 'engine_session_stops'")).rows).toEqual([{ interval_seconds: 60 }]);
  });

  describe("tenant predicates", () => {
    it("a foreign account's id through the admin client reads no rows of this account, and the issuer cannot be pointed at another account's repo", async () => {
      const a = await rig({ operate: false });
      const b = await rig({ operate: false });
      // Through the RLS-bypassing client with another account's id: nothing of A's repo appears under B's id.
      const rows = (await h.admin.query("SELECT * FROM engine_system_stops_due($1::uuid, $2::uuid, 10)", [b.who.accountId, a.who.repoId]).catch(() => ({ rows: [] }))).rows;
      expect(rows).toEqual([]);
      expect(await due(b.who.accountId, a.who.repoId)).toEqual([]);
      expect(await issue(a, { epoch: await epochOf(a), accountId: b.who.accountId })).toBe("not_placed");
      expect(await issue(a, { epoch: await epochOf(a), repoId: b.who.repoId })).toBe("not_placed");
      expect(await jobs(a.who.accountId, "engine_session_stop")).toEqual([]);
      expect(await jobs(b.who.accountId, "engine_session_stop")).toEqual([]);
    });
    it("one account's sandbox, report or stop never counts for another account's repo with the same names", async () => {
      const a = await rig({ operate: false, sandbox: null });
      const b = await rig({ operate: false });
      // b's engine sandbox is up and a's is not; a's list is empty even though the sandbox name pattern is the same shape, and b's stop does not block a.
      expect(await due(a.who.accountId)).toEqual([]);
      expect(await due(b.who.accountId)).toHaveLength(1);
      expect(await issue(b, { epoch: await epochOf(b) })).toBe("issued");
      await sandbox(a, "running");
      expect(await due(a.who.accountId), "b's stop does not block a").toHaveLength(1);
    });
  });

  describe("the lock it shares with a person's start", () => {
    const waitingOnAdvisory = async (): Promise<number> => (await h.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted")).rows[0]!.n;
    async function until(fn: () => Promise<boolean>): Promise<void> {
      for (let i = 0; i < 200; i += 1) {
        if (await fn()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("timed out waiting");
    }
    it("a system stop waits for a person's start that holds the repo, then supersedes the start it issued and stops the session", async () => {
      const r = await rig();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let inside!: () => void;
      const entered = new Promise<void>((resolve) => { inside = resolve; });
      const start = issueEngineSessionStart(personDeps(), { accountId: r.who.accountId, userId: r.who.userId }, r.who.repoId, { afterGate: async () => { inside(); await gate; } });
      await entered;
      // The tick is taken off behind the start's back (a raw delete takes no bridge lock), so the cause holds while the start still thinks the repo is operated.
      await h.admin.query("DELETE FROM engine_bridge_repos WHERE account_id = $1", [r.who.accountId]);
      const pass = issueSystemStops(stopDeps(), { accountId: r.who.accountId, repoId: r.who.repoId });
      await until(async () => (await waitingOnAdvisory()) >= 1);
      expect(await jobs(r.who.accountId, "engine_session_stop"), "the stop waits for the repo's lock").toEqual([]);
      release();
      const issued = await start;
      expect((await pass).results).toEqual([{ account_id: r.who.accountId, repo_id: r.who.repoId, reason: "operate_off", result: "issued" }]);
      expect((await h.admin.query<{ state: string }>("SELECT state FROM machine_jobs WHERE id = $1", [issued.job_id])).rows[0]!.state).toBe("superseded");
      const [stop] = await jobs(r.who.accountId, "engine_session_stop");
      expect(verifyMachineJob(stop!.job, keyring, r.runnerId).args).toEqual({ reason: "operate_off", operate_epoch: issued.operate_epoch });
    });
    it("a start in flight holds the account's switches: an untick waits for it, and the start it issued is closed at delivery", async () => {
      const r = await rig({ sandbox: null });
      await hello(r);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let inside!: () => void;
      const entered = new Promise<void>((resolve) => { inside = resolve; });
      const start = issueEngineSessionStart(personDeps(), { accountId: r.who.accountId, userId: r.who.userId }, r.who.repoId, { afterGate: async () => { inside(); await gate; } });
      await entered;
      // The untick, through the writer every route uses: it takes the bridge lock exclusively and so waits for the start.
      const untick = withTenant(h.appPool, r.who.accountId, r.who.userId, (c) => setEngineBridgeSettings(c, r.who.userId, { repo_ids: [] }, new Map()));
      await until(async () => (await waitingOnAdvisory()) >= 1);
      expect((await h.admin.query("SELECT 1 FROM engine_bridge_repos WHERE account_id = $1", [r.who.accountId])).rowCount, "the tick is still there while the start holds it").toBe(1);
      release();
      const issued = await start;
      await untick;
      expect((await h.admin.query("SELECT 1 FROM engine_bridge_repos WHERE account_id = $1", [r.who.accountId])).rowCount).toBe(0);
      // The start was issued before the untick landed; the claim closes it (the epoch did not move), and the pass tidies the row.
      expect((await h.admin.query<{ state: string }>("SELECT state FROM machine_jobs WHERE id = $1", [issued.job_id])).rows[0]!.state).toBe("issued");
      const claimed = await respond(() => machineJobClaimRun(h.deps(), signed(r.key, MACHINE_JOB_CLAIM_PATH, {})));
      expect((claimed.body as { signed_job?: unknown }).signed_job).toBeUndefined();
      expect((await h.admin.query<{ state: string }>("SELECT state FROM machine_jobs WHERE id = $1", [issued.job_id])).rows[0]!.state).toBe("superseded");
    });
    it("an untick that lands first makes the start refuse with operate_off", async () => {
      const r = await rig({ sandbox: null });
      await withTenant(h.appPool, r.who.accountId, r.who.userId, (c) => setEngineBridgeSettings(c, r.who.userId, { repo_ids: [] }, new Map()));
      await expect(issueEngineSessionStart(personDeps(), { accountId: r.who.accountId, userId: r.who.userId }, r.who.repoId)).rejects.toMatchObject({ status: 409, code: "operate_off" });
    });
    it("the person issuers still refuse the system reasons, so only the definer writes them", async () => {
      const r = await rig({ operate: false });
      for (const reason of ["operate_off", "plan"]) {
        await expect(issueEngineSessionStop(personDeps(), { accountId: r.who.accountId, userId: r.who.userId }, r.who.repoId, reason as never)).rejects.toThrow(/system-only/);
      }
    });
  });
});
