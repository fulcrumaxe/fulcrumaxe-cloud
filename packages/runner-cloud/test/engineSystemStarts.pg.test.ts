import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { signMachineJob, type MachineJob } from "@fulcrumaxe/runner-protocol";
import { requireEngineCoverage } from "../src/engineSession.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { engineSessionSpendGuard, issueSystemStarts, RunPullRequestError, type SystemStartDeps } from "../src/index.js";
import { harness, newKey, registerKey, type Harness } from "./helpers.js";

const HEAD = "e".repeat(40);

/**
 * [pg] D#845 ON-13c1 (migration 1100): the SQL copy of the coverage gate (parity with `requireEngineCoverage`), the start list, the issuer and its refusals, replay, the role gate, forged bytes, and the pass in TypeScript with
 * the spend guard. Real Postgres, the real roles (platform_ops runs the list and the issuer), row security forced, real Ed25519 signatures. No network: GitHub is a fake that counts its calls.
 */
describe("system engine first start [pg]", () => {
  let h: Harness;
  const keys = generateKeyPairSync("ed25519");
  const signer = { keyId: "job-key-1", signMachineJob: (job: MachineJob) => signMachineJob(job, "job-key-1", keys.privateKey) };
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  interface Rig { who: SeedRefs; runnerId: string; ghRepoId: number; setupId: string }
  /** A fresh account with one repo placed on one machine, a plan of one, watch and operate on (epoch 1), the repo ticked, and its finished install holding `start_pending`; each can be turned off. */
  async function rig(o: { operate?: boolean; tick?: boolean; plan?: number; pending?: boolean; sandbox?: boolean } = {}): Promise<Rig> {
    const who = await seedAccount(h.admin, randomUUID());
    const ghRepoId = Number((await h.admin.query<{ gh_repo_id: string }>("SELECT gh_repo_id FROM repos WHERE id = $1", [who.repoId])).rows[0]!.gh_repo_id);
    await h.admin.query("UPDATE repos SET gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1", [who.repoId]);
    const runnerId = await registerKey(h.admin, who.accountId, who.userId, newKey());
    await h.admin.query("INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')", [who.repoId, who.accountId, runnerId]);
    await h.admin.query("UPDATE accounts SET engine_quantity = $2, stripe_subscription_status = 'active' WHERE id = $1", [who.accountId, o.plan ?? 1]);
    await h.admin.query("INSERT INTO engine_bridge_settings (account_id, watch_enabled, operate_enabled) VALUES ($1, true, $2)", [who.accountId, o.operate !== false]);
    if (o.tick !== false) await h.admin.query("INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)", [who.accountId, who.repoId]);
    const setupId = (await h.admin.query<{ id: string }>("INSERT INTO project_setups (account_id, repo_id, kind, created_by, phase, state, sub_step, engine_version) VALUES ($1, $2, 'existing', $3, 'finish', 'ok', 'pr_merged', '1.2.3') RETURNING id", [who.accountId, who.repoId, who.userId])).rows[0]!.id;
    await h.admin.query("UPDATE project_setups SET phase = 'done', start_pending = $2 WHERE id = $1", [setupId, o.pending !== false]);
    if (o.sandbox === true) await h.admin.query("INSERT INTO runner_sandboxes (runner_id, slot, account_id, name, state, created_at, disk_bytes, snapshot_count) VALUES ($1, 1, $2, $3, 'stopped', now(), 1, 1)", [runnerId, who.accountId, `fx-engine-${ghRepoId}`]);
    return { who, runnerId, ghRepoId, setupId };
  }
  /** A second repo of the same account, placed on a machine of its own at `placedAt`. */
  async function addPlacement(r: Rig, placedAt: string, o: { pending?: boolean; tick?: boolean } = {}): Promise<{ repoId: string; runnerId: string; ghRepoId: number }> {
    const repoId = randomUUID();
    const ghRepoId = r.ghRepoId + 100 + Math.floor(Math.random() * 100_000);
    await h.admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) SELECT $1, account_id, installation_id, $3, product, 'acme', $4 FROM repos WHERE id = $2", [repoId, r.who.repoId, ghRepoId, `r${ghRepoId}`]);
    const runnerId = await registerKey(h.admin, r.who.accountId, r.who.userId, newKey());
    await h.admin.query(`INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by, placed_at) VALUES ($1, $2, $3, 'auto', ${placedAt})`, [repoId, r.who.accountId, runnerId]);
    if (o.tick !== false) await h.admin.query("INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)", [r.who.accountId, repoId]);
    const s = (await h.admin.query<{ id: string }>("INSERT INTO project_setups (account_id, repo_id, kind, created_by, phase, state, sub_step, engine_version) VALUES ($1, $2, 'existing', $3, 'finish', 'ok', 'pr_merged', '1.2.3') RETURNING id", [r.who.accountId, repoId, r.who.userId])).rows[0]!.id;
    await h.admin.query("UPDATE project_setups SET phase = 'done', start_pending = $2 WHERE id = $1", [s, o.pending !== false]);
    return { repoId, runnerId, ghRepoId };
  }
  const pendingOf = async (repoId: string) => (await h.admin.query<{ p: boolean }>("SELECT bool_or(start_pending) AS p FROM project_setups WHERE repo_id = $1", [repoId])).rows[0]!.p;
  const jobs = async (accountId: string, kind = "engine_session_start") =>
    (await h.admin.query<{ id: string; repo_id: string; state: string; setup_id: string | null; job: { job: { args: Record<string, unknown> } } }>("SELECT id, repo_id, state, setup_id, job FROM machine_jobs WHERE account_id = $1 AND kind = $2 ORDER BY issued_at, id", [accountId, kind])).rows;
  const audits = async (accountId: string) => (await h.admin.query<{ actor: string; payload: Record<string, unknown> }>("SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'engine_session.started'", [accountId])).rows;
  const due = async (accountId?: string, repoId?: string) =>
    (await h.opsPool.query<{ o_account: string; o_repo: string; o_runner: string; o_repo_gh_id: string; o_owner: string; o_name: string; o_epoch: number; o_resume: boolean }>("SELECT * FROM engine_system_starts_due($1::uuid, $2::uuid, 500)", [accountId ?? null, repoId ?? null])).rows;
  const insertJob = (r: Rig, kind: string, state: string, repoId = r.who.repoId, runnerId = r.runnerId) => {
    const id = randomUUID();
    const issued = new Date(Date.now() - 60_000);
    const expires = new Date(issued.getTime() + 25 * 60_000);
    const job = signer.signMachineJob({ v: 1, job_id: id, runner_id: runnerId, repo_gh_id: r.ghRepoId, requires_engine: "any", issued_at: issued.toISOString(), expires_at: expires.toISOString(), kind,
      args: kind === "engine_session_start" ? { at_sha: HEAD, resume: false, operate_epoch: 1 } : { reason: "person", operate_epoch: 1 } } as unknown as MachineJob);
    return h.admin.query("INSERT INTO machine_jobs (id, account_id, runner_id, repo_id, kind, job, state, issued_at, expires_at, delivered_at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)", [
      id, r.who.accountId, runnerId, repoId, kind, JSON.stringify(job), state, issued, expires, state === "issued" ? null : issued]);
  };
  type Envelope = { job: Record<string, unknown> & { args: Record<string, unknown> } };
  /** `edit` changes the signed envelope after it was made (a forgery the signer's own schema would not let through). */
  interface Forge { pid?: string; resume?: boolean; epoch?: number; edit?: (e: Envelope) => void; cause?: string | null; accountId?: string; repoId?: string; noJob?: boolean }
  /** The start as the cloud would sign it, with any one field forged, ready for the issuer. */
  async function issue(r: Rig, f: Forge = {}, pool: "ops" | "app" | "admin" = "ops"): Promise<string> {
    const id = f.pid ?? randomUUID();
    const issued = new Date();
    const expires = new Date(issued.getTime() + 1_800_000);
    const resume = f.resume ?? (r.who ? (await h.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM runner_sandboxes WHERE runner_id = $1", [r.runnerId])).rows[0]!.n > 0 : false);
    const job = signer.signMachineJob({
      v: 1, job_id: id, runner_id: r.runnerId, repo_gh_id: r.ghRepoId, requires_engine: "any", issued_at: issued.toISOString(), expires_at: expires.toISOString(),
      kind: "engine_session_start", args: { at_sha: HEAD, resume, operate_epoch: f.epoch ?? 1 },
    } as unknown as MachineJob) as unknown as Envelope;
    f.edit?.(job);
    const p = pool === "ops" ? h.opsPool : pool === "app" ? h.appPool : h.adminPool;
    return (await p.query<{ result: string }>("SELECT engine_system_start_issue($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, $6, $7) AS result", [
      id, f.accountId ?? r.who.accountId, f.repoId ?? r.who.repoId, f.cause === undefined ? "first_start" : f.cause, f.noJob ? null : JSON.stringify(job), issued, expires])).rows[0]!.result;
  }
  const code = async (p: Promise<unknown>) => p.then((v) => `ok:${String(v)}`, (e: { code?: string; message?: string }) => e.code ?? `error:${e.message}`);
  /** Nothing the issuer writes was written: the cause stands, no job, no audit row. */
  async function untouched(r: Rig, repoId = r.who.repoId): Promise<void> {
    expect(await pendingOf(repoId)).toBe(true);
    expect((await jobs(r.who.accountId)).filter((j) => j.repo_id === repoId)).toEqual([]);
    expect((await audits(r.who.accountId)).filter((a) => a.payload.repo_id === repoId)).toEqual([]);
  }

  describe("engine_start_covered equals requireEngineCoverage", () => {
    const tsCovered = async (accountId: string, repoId: string): Promise<boolean> => requireEngineCoverage(h.admin, accountId, repoId).then(() => true, () => false);
    const sqlCovered = async (accountId: string, repoId: string) => (await h.opsPool.query<{ c: boolean }>("SELECT engine_start_covered($1, $2) AS c", [accountId, repoId])).rows[0]!.c;
    it("agrees, with the expected answer, over fourteen fixture accounts", async () => {
      const fixtures: Array<{ name: string; set: string; expected: boolean }> = [
        { name: "active", set: "stripe_subscription_status = 'active'", expected: true },
        { name: "trialing", set: "stripe_subscription_status = 'trialing'", expected: true },
        { name: "past_due 6d23h", set: "stripe_subscription_status = 'past_due', past_due_since = now() - interval '6 days 23 hours'", expected: true },
        { name: "past_due 7d+1m", set: "stripe_subscription_status = 'past_due', past_due_since = now() - interval '7 days 1 minute'", expected: false },
        { name: "past_due, no marker", set: "stripe_subscription_status = 'past_due', past_due_since = NULL", expected: false },
        { name: "canceled", set: "stripe_subscription_status = 'canceled', subscription_ended_at = now()", expected: false },
        { name: "paused", set: "stripe_subscription_status = 'paused'", expected: false },
        { name: "incomplete", set: "stripe_subscription_status = 'incomplete'", expected: false },
        { name: "no subscription", set: "stripe_subscription_status = NULL", expected: false },
        { name: "quantity 0", set: "engine_quantity = 0", expected: false },
        { name: "held", set: "platform_hold_at = now()", expected: false },
        { name: "held and ended", set: "stripe_subscription_status = 'canceled', subscription_ended_at = now(), platform_hold_at = now()", expected: false },
        { name: "partner suspended", set: "partner_suspended_at = now()", expected: false },
        { name: "deleted", set: "deleted_at = now()", expected: false },
      ];
      for (const f of fixtures) {
        const r = await rig();
        await h.admin.query(`UPDATE accounts SET ${f.set} WHERE id = $1`, [r.who.accountId]);
        expect({ f: f.name, sql: await sqlCovered(r.who.accountId, r.who.repoId) }, f.name).toEqual({ f: f.name, sql: f.expected });
        expect({ f: f.name, ts: await tsCovered(r.who.accountId, r.who.repoId) }, f.name).toEqual({ f: f.name, ts: f.expected });
      }
    });
    it("lets only the oldest `quantity` placements start after a downgrade, and every one while live <= quantity", async () => {
      const r = await rig({ plan: 3 });
      await h.admin.query("UPDATE project_placements SET placed_at = now() - interval '3 days' WHERE repo_id = $1", [r.who.repoId]);
      const b = await addPlacement(r, "now() - interval '2 days'");
      const c = await addPlacement(r, "now() - interval '1 day'");
      const repos = [r.who.repoId, b.repoId, c.repoId];
      const answer = async (): Promise<Array<[boolean, boolean]>> => Promise.all(repos.map(async (id): Promise<[boolean, boolean]> => [await sqlCovered(r.who.accountId, id), await tsCovered(r.who.accountId, id)]));
      expect(await answer()).toEqual([[true, true], [true, true], [true, true]]);
      await h.admin.query("UPDATE accounts SET engine_quantity = 2 WHERE id = $1", [r.who.accountId]);
      expect(await answer()).toEqual([[true, true], [true, true], [false, false]]);
      await h.admin.query("UPDATE accounts SET engine_quantity = 1 WHERE id = $1", [r.who.accountId]);
      expect(await answer()).toEqual([[true, true], [false, false], [false, false]]);
      // The same age ties on repo_id, in both copies.
      await h.admin.query("UPDATE project_placements SET placed_at = '2026-01-01' WHERE account_id = $1", [r.who.accountId]);
      const [x, y] = await answer();
      expect([x![0], y![0]]).toEqual([x![1], y![1]]);
      expect(repos.filter((_, i) => (i === 0 ? x : i === 1 ? y : [false])![0]).length).toBeLessThanOrEqual(1);
    });
    it("is false for an account or repo that does not exist, and counts another account's placements for nothing", async () => {
      expect(await sqlCovered(randomUUID(), randomUUID())).toBe(false);
      const a = await rig();
      const b = await rig();
      expect(await sqlCovered(a.who.accountId, b.who.repoId)).toBe(await tsCovered(a.who.accountId, b.who.repoId));
      await addPlacement(b, "now()");
      expect(await sqlCovered(a.who.accountId, a.who.repoId)).toBe(true);
      // No engine plan and nothing placed: zero live engines must not read as "within the quantity".
      const none = await rig({ plan: 0 });
      await h.admin.query("DELETE FROM project_placements WHERE account_id = $1", [none.who.accountId]);
      expect({ sql: await sqlCovered(none.who.accountId, none.who.repoId), ts: await tsCovered(none.who.accountId, none.who.repoId) }).toEqual({ sql: false, ts: false });
    });
  });

  describe("the list (engine_system_starts_due)", () => {
    it("lists a finished install with its pending start, at the current epoch, once", async () => {
      const r = await rig();
      expect(await due(r.who.accountId)).toEqual([{ o_account: r.who.accountId, o_repo: r.who.repoId, o_runner: r.runnerId, o_repo_gh_id: String(r.ghRepoId), o_owner: "acme", o_name: "widgets", o_epoch: 1, o_resume: false }]);
    });
    it("says resume when the machine lists the engine's sandbox, or an earlier start ended", async () => {
      expect((await due((await rig({ sandbox: true })).who.accountId))[0]!.o_resume).toBe(true);
      const r = await rig();
      await insertJob(r, "engine_session_start", "done");
      expect((await due(r.who.accountId))[0]!.o_resume).toBe(true);
    });
    it("lists nothing without a pending start, an unfinished install, a plan, an operated repo, a live machine, or with a start or stop waiting", async () => {
      expect(await due((await rig({ pending: false })).who.accountId)).toEqual([]);
      const unfinished = await rig();
      await h.admin.query("UPDATE project_setups SET phase = 'finish' WHERE id = $1", [unfinished.setupId]);
      expect(await due(unfinished.who.accountId)).toEqual([]);
      expect(await due((await rig({ operate: false })).who.accountId)).toEqual([]);
      expect(await due((await rig({ tick: false })).who.accountId)).toEqual([]);
      expect(await due((await rig({ plan: 0 })).who.accountId)).toEqual([]);
      const ended = await rig();
      await h.admin.query("UPDATE accounts SET stripe_subscription_status = 'canceled', subscription_ended_at = now() WHERE id = $1", [ended.who.accountId]);
      expect(await due(ended.who.accountId)).toEqual([]);
      const revoked = await rig();
      await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [revoked.runnerId]);
      expect(await due(revoked.who.accountId)).toEqual([]);
      const gone = await rig();
      await h.admin.query("UPDATE accounts SET deleted_at = now() WHERE id = $1", [gone.who.accountId]);
      expect(await due(gone.who.accountId)).toEqual([]);
      for (const [kind, state] of [["engine_session_start", "issued"], ["engine_session_start", "delivered"], ["engine_session_stop", "issued"], ["engine_session_stop", "delivered"]] as const) {
        const w = await rig();
        await insertJob(w, kind, state);
        expect(await due(w.who.accountId), `${kind} ${state}`).toEqual([]);
      }
      // A stop or start that ended no longer holds the repo.
      const done = await rig();
      await insertJob(done, "engine_session_stop", "done");
      expect(await due(done.who.accountId)).toHaveLength(1);
    });
    it("lists only the account asked for, and the repo asked for", async () => {
      const a = await rig({ plan: 2 });
      const b = await rig();
      const second = await addPlacement(a, "now()");
      expect((await due(a.who.accountId)).map((x) => x.o_repo).sort()).toEqual([a.who.repoId, second.repoId].sort());
      expect((await due(a.who.accountId, second.repoId)).map((x) => x.o_repo)).toEqual([second.repoId]);
      expect(await due(b.who.accountId, a.who.repoId)).toEqual([]);
      expect(await h.opsPool.query("SELECT * FROM engine_system_starts_due($1::uuid, $2::uuid, 0)", [null, null]).then(() => "ok", (e: { code: string }) => e.code)).toBe("22023");
      expect(await h.opsPool.query("SELECT * FROM engine_system_starts_due(NULL, $1::uuid, 5)", [a.who.repoId]).then(() => "ok", (e: { code: string }) => e.code)).toBe("22023");
    });
  });

  describe("the issuer (engine_system_start_issue)", () => {
    it("issues one start with no setup, clears the cause, and writes one audit row whose actor is the login", async () => {
      const r = await rig({ sandbox: true });
      expect(await issue(r)).toBe("issued");
      const rows = await jobs(r.who.accountId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ repo_id: r.who.repoId, state: "issued", setup_id: null });
      expect(rows[0]!.job.job.args).toEqual({ resume: true, at_sha: HEAD, operate_epoch: 1 });
      expect(await pendingOf(r.who.repoId)).toBe(false);
      const login = (await h.opsPool.query<{ u: string }>("SELECT session_user AS u")).rows[0]!.u;
      expect(await audits(r.who.accountId)).toEqual([{ actor: login, payload: { repo_id: r.who.repoId, job_id: rows[0]!.id, cause: "first_start", resume: true, at_sha: HEAD, operate_epoch: 1 } }]);
    });
    it("answers cause_gone to a replay, issues nothing more, and never lists the repo again", async () => {
      const r = await rig();
      expect(await issue(r)).toBe("issued");
      expect(await issue(r)).toBe("cause_gone");
      expect(await issue(r)).toBe("cause_gone");
      expect(await jobs(r.who.accountId)).toHaveLength(1);
      expect(await audits(r.who.accountId)).toHaveLength(1);
      expect(await due(r.who.accountId)).toEqual([]);
    });
    it("refuses a job id that is already a row (the primary key), whatever the cause", async () => {
      const r = await rig();
      expect(await issue(r)).toBe("issued");
      await h.admin.query("UPDATE project_setups SET start_pending = true WHERE id = $1", [r.setupId]);
      await h.admin.query("UPDATE machine_jobs SET state = 'done', delivered_at = now(), ended_at = now() WHERE account_id = $1", [r.who.accountId]);
      const id = (await jobs(r.who.accountId))[0]!.id;
      expect(await code(issue(r, { pid: id, resume: true }))).toBe("23505");
      expect(await pendingOf(r.who.repoId)).toBe(true);
    });
    it("is for platform_ops alone: app_user, a superuser login, a runner session and a person session are all 42501", async () => {
      const r = await rig();
      expect(await code(issue(r, {}, "app"))).toBe("42501");
      expect(await code(issue(r, {}, "admin"))).toBe("42501");
      for (const setting of ["app.runner_id", "app.user_id"]) {
        const c = await h.opsPool.connect();
        try {
          await c.query("SELECT set_config($1, $2, false)", [setting, randomUUID()]);
          expect(await code(c.query("SELECT engine_system_start_issue($1::uuid, $2::uuid, $3::uuid, 'first_start', '{}'::jsonb, now(), now() + interval '1 minute')", [randomUUID(), r.who.accountId, r.who.repoId])), setting).toBe("42501");
          expect(await code(c.query("SELECT * FROM engine_system_starts_due(NULL, NULL, 5)")), setting).toBe("42501");
        } finally {
          await c.query("RESET ALL");
          c.release();
        }
      }
      expect(await code(h.appPool.query("SELECT * FROM engine_system_starts_due(NULL, NULL, 5)"))).toBe("42501");
      expect(await code(h.appPool.query("SELECT engine_start_covered($1, $2)", [r.who.accountId, r.who.repoId]))).toBe("42501");
      await untouched(r);
    });
    it("refuses a cause outside the closed set, and a missing argument, with 22023 and writes nothing", async () => {
      const r = await rig();
      for (const cause of ["engine_update", "plan", "", "FIRST_START", null]) expect(await code(issue(r, { cause })), String(cause)).toBe("22023");
      expect(await code(issue(r, { noJob: true }))).toBe("22023");
      await untouched(r);
    });
    it("refuses a signed job that does not say what was asked, field by field, with 22023 and writes nothing", async () => {
      const r = await rig();
      const other = await rig();
      const edits: Array<[string, (e: Envelope) => void]> = [
        ["kind stop", (e) => { e.job.kind = "engine_session_stop"; }], ["kind delete", (e) => { e.job.kind = "engine_session_delete"; }], ["kind update", (e) => { e.job.kind = "engine_update"; }], ["no kind", (e) => { delete e.job.kind; }],
        ["job id", (e) => { e.job.job_id = randomUUID(); }], ["runner", (e) => { e.job.runner_id = other.runnerId; }], ["no runner", (e) => { delete e.job.runner_id; }],
        ["repo gh id", (e) => { e.job.repo_gh_id = r.ghRepoId + 1; }], ["gh id as text", (e) => { e.job.repo_gh_id = `${r.ghRepoId}x`; }], ["setup id", (e) => { e.job.setup_id = r.setupId; }],
        ["no sha", (e) => { delete e.job.args.at_sha; }], ["short sha", (e) => { e.job.args.at_sha = "e".repeat(39); }], ["upper sha", (e) => { e.job.args.at_sha = "E".repeat(40); }],
        ["non-hex sha", (e) => { e.job.args.at_sha = "g".repeat(40); }], ["long sha", (e) => { e.job.args.at_sha = "e".repeat(41); }], ["sha as number", (e) => { e.job.args.at_sha = 5; }],
        ["resume flipped", (e) => { e.job.args.resume = true; }], ["no resume", (e) => { delete e.job.args.resume; }], ["resume as text", (e) => { e.job.args.resume = "false"; }],
        ["gh id as a string", (e) => { e.job.repo_gh_id = String(r.ghRepoId); }], ["epoch as a string", (e) => { e.job.args.operate_epoch = "1"; }],
        ["epoch 0", (e) => { e.job.args.operate_epoch = 0; }], ["epoch negative", (e) => { e.job.args.operate_epoch = -1; }], ["epoch text", (e) => { e.job.args.operate_epoch = "1x"; }],
        ["epoch leading zero", (e) => { e.job.args.operate_epoch = "01"; }], ["no epoch", (e) => { delete e.job.args.operate_epoch; }], ["no args", (e) => { delete (e.job as { args?: unknown }).args; }],
        ["job not an object", (e) => { (e as unknown as { job: unknown }).job = "x"; }],
      ];
      for (const [name, edit] of edits) expect(await code(issue(r, { edit })), name).toBe("22023");
      await untouched(r);
      await untouched(other);
    });
    it("answers epoch_moved when the signed epoch is not the one now, and writes nothing", async () => {
      const r = await rig();
      await h.admin.query("UPDATE engine_bridge_settings SET operate_enabled = false WHERE account_id = $1", [r.who.accountId]);
      await h.admin.query("UPDATE engine_bridge_settings SET operate_enabled = true WHERE account_id = $1", [r.who.accountId]);
      expect(await issue(r, { epoch: 1 })).toBe("epoch_moved");
      expect(await issue(r, { epoch: 3 })).toBe("issued");
    });
    it("answers not_placed for a repo with no placement, a revoked machine, a deleted account, and another account's repo", async () => {
      const r = await rig();
      const other = await rig();
      expect(await issue(r, { repoId: other.who.repoId })).toBe("not_placed");
      expect(await issue(r, { accountId: other.who.accountId })).toBe("not_placed");
      await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [r.runnerId]);
      expect(await issue(r)).toBe("not_placed");
      await h.admin.query("DELETE FROM project_placements WHERE repo_id = $1", [other.who.repoId]);
      expect(await issue(other)).toBe("not_placed");
      const gone = await rig();
      await h.admin.query("UPDATE accounts SET deleted_at = now() WHERE id = $1", [gone.who.accountId]);
      expect(await issue(gone)).toBe("not_placed");
      await untouched(r);
      await untouched(other);
      await untouched(gone);
    });
    it("answers cause_gone with no pending start, an unfinished install, operate off, an unticked repo, and the `operate_on` cause (which has no queue before ON-13c2)", async () => {
      expect(await issue(await rig({ pending: false }))).toBe("cause_gone");
      const unfinished = await rig();
      await h.admin.query("UPDATE project_setups SET phase = 'finish' WHERE id = $1", [unfinished.setupId]);
      expect(await issue(unfinished)).toBe("cause_gone");
      const off = await rig();
      await h.admin.query("UPDATE engine_bridge_settings SET operate_enabled = false WHERE account_id = $1", [off.who.accountId]);
      expect(await issue(off, { epoch: 2 })).toBe("cause_gone");
      expect(await issue(await rig({ tick: false }))).toBe("cause_gone");
      const onCause = await rig();
      expect(await issue(onCause, { cause: "operate_on" })).toBe("cause_gone");
      await untouched(onCause);
      await untouched(off);
    });
    it("answers plan when the plan ended, the account is held, or a downgrade left the repo outside the oldest `quantity`; the cause stands", async () => {
      const ended = await rig();
      await h.admin.query("UPDATE accounts SET stripe_subscription_status = 'canceled', subscription_ended_at = now() WHERE id = $1", [ended.who.accountId]);
      expect(await issue(ended)).toBe("plan");
      const held = await rig();
      await h.admin.query("UPDATE accounts SET platform_hold_at = now() WHERE id = $1", [held.who.accountId]);
      expect(await issue(held)).toBe("plan");
      const none = await rig({ plan: 0 });
      expect(await issue(none)).toBe("plan");
      const down = await rig({ plan: 2 });
      await h.admin.query("UPDATE project_placements SET placed_at = now() - interval '3 days' WHERE repo_id = $1", [down.who.repoId]);
      const b = await addPlacement(down, "now() - interval '2 days'");
      const c = await addPlacement(down, "now() - interval '1 day'");
      await h.admin.query("UPDATE accounts SET engine_quantity = 2 WHERE id = $1", [down.who.accountId]);
      expect(await issue({ ...down, runnerId: c.runnerId, ghRepoId: c.ghRepoId }, { repoId: c.repoId })).toBe("plan");
      expect(await issue({ ...down, runnerId: b.runnerId, ghRepoId: b.ghRepoId }, { repoId: b.repoId })).toBe("issued");
      for (const r of [ended, held, none]) await untouched(r);
      expect(await pendingOf(c.repoId)).toBe(true);
    });
    it("answers busy while a start or stop of the repo is issued or delivered, keeps the cause, and issues once that ends", async () => {
      for (const [kind, state] of [["engine_session_start", "issued"], ["engine_session_start", "delivered"], ["engine_session_stop", "issued"], ["engine_session_stop", "delivered"]] as const) {
        const r = await rig();
        await insertJob(r, kind, state);
        expect(await issue(r), `${kind} ${state}`).toBe("busy");
        expect(await pendingOf(r.who.repoId)).toBe(true);
        expect(await audits(r.who.accountId)).toEqual([]);
      }
      const r = await rig();
      await insertJob(r, "engine_session_stop", "done");
      expect(await issue(r)).toBe("issued");
    });
    it("keeps accounts and repos apart: one repo's start clears only its own cause, and a foreign account reads no row", async () => {
      const a = await rig();
      const second = await addPlacement(a, "now()");
      const b = await rig();
      await h.admin.query("UPDATE accounts SET engine_quantity = 2 WHERE id = $1", [a.who.accountId]);
      expect(await issue(a)).toBe("issued");
      expect(await pendingOf(second.repoId)).toBe(true);
      expect(await pendingOf(b.who.repoId)).toBe(true);
      expect((await jobs(a.who.accountId)).map((j) => j.repo_id)).toEqual([a.who.repoId]);
      expect(await jobs(b.who.accountId)).toEqual([]);
      expect(await due(b.who.accountId, second.repoId)).toEqual([]);
      expect(await due(randomUUID())).toEqual([]);
    });
    it("seeds its reconcile row at 60 seconds", async () => {
      expect((await h.admin.query("SELECT interval_seconds FROM reconcile_jobs WHERE name = 'engine_session_starts'")).rows).toEqual([{ interval_seconds: 60 }]);
    });
  });

  describe("the pass (issueSystemStarts) and the spend guard", () => {
    const reports: Array<{ stage: string; code?: string }> = [];
    const fakeGithub = (o: { head?: string | null; fail?: Error } = {}) => {
      const calls = { defaultBranch: 0, branchState: 0 };
      const port = {
        defaultBranch: async () => { calls.defaultBranch += 1; if (o.fail) throw o.fail; return "main"; },
        branchState: async () => { calls.branchState += 1; return { exists: o.head !== null, headOid: o.head === undefined ? HEAD : o.head, aheadBy: 0, defaultBranch: "main" }; },
      };
      return { calls, port: port as unknown as ReturnType<SystemStartDeps["pullRequests"]> };
    };
    const deps = (gh: ReturnType<typeof fakeGithub>, over: Partial<SystemStartDeps> = {}): SystemStartDeps =>
      ({ pool: h.opsPool, engineCommandSigner: async () => signer, pullRequests: () => gh.port, reportError: (_e, c) => void reports.push({ stage: c.stage, ...(c.code ? { code: c.code } : {}) }), ...over });

    it("starts a due repo with its head, once: the second pass lists nothing and reads no GitHub", async () => {
      const r = await rig();
      const gh = fakeGithub();
      const first = await issueSystemStarts(deps(gh), { accountId: r.who.accountId });
      expect(first).toEqual({ not_configured: false, issued: 1, results: [{ account_id: r.who.accountId, repo_id: r.who.repoId, result: "issued" }] });
      expect(gh.calls).toEqual({ defaultBranch: 1, branchState: 1 });
      expect((await jobs(r.who.accountId))[0]!.job.job.args).toMatchObject({ at_sha: HEAD, operate_epoch: 1, resume: false });
      const again = await issueSystemStarts(deps(gh), { accountId: r.who.accountId });
      expect(again).toEqual({ not_configured: false, issued: 0, results: [] });
      expect(gh.calls).toEqual({ defaultBranch: 1, branchState: 1 });
    });
    it("builds no GitHub client when nothing is due, and says not_configured with no signer", async () => {
      const r = await rig({ pending: false });
      const build = vi.fn(() => fakeGithub().port);
      expect(await issueSystemStarts(deps(fakeGithub(), { pullRequests: build }), { accountId: r.who.accountId })).toEqual({ not_configured: false, issued: 0, results: [] });
      expect(build).not.toHaveBeenCalled();
      const due1 = await rig();
      expect(await issueSystemStarts(deps(fakeGithub(), { engineCommandSigner: async () => null }), { accountId: due1.who.accountId })).toMatchObject({ not_configured: true, issued: 0 });
      expect(await pendingOf(due1.who.repoId)).toBe(true);
    });
    it("leaves a repo due when GitHub cannot be read (retryable or refused, no branch, no name) and goes on to the next", async () => {
      const r = await rig();
      const second = await addPlacement(r, "now()");
      await h.admin.query("UPDATE accounts SET engine_quantity = 2 WHERE id = $1", [r.who.accountId]);
      for (const [fail, head, want] of [[new RunPullRequestError("unavailable"), undefined, "github_unavailable"], [new RunPullRequestError("rejected"), undefined, "github_refused"], [undefined, null, "default_branch_empty"], [undefined, "zz", "default_branch_empty"]] as const) {
        const pass = await issueSystemStarts(deps(fakeGithub({ ...(fail ? { fail } : {}), ...(head === undefined ? {} : { head }) })), { accountId: r.who.accountId });
        expect(pass.results.map((x) => x.result), want).toEqual([want, want]);
        expect(pass.issued).toBe(0);
      }
      await h.admin.query("UPDATE repos SET gh_name = NULL WHERE id = $1", [second.repoId]);
      const gh = fakeGithub();
      const pass = await issueSystemStarts(deps(gh), { accountId: r.who.accountId });
      expect(pass.results.map((x) => x.result).sort()).toEqual(["github_refused", "issued"]);
      expect(gh.calls.defaultBranch).toBe(1);
      expect(await pendingOf(second.repoId)).toBe(true);
    });
    it("reports an unexpected error on one repo, ends it `error`, and goes on", async () => {
      const r = await rig();
      await addPlacement(r, "now()");
      await h.admin.query("UPDATE accounts SET engine_quantity = 2 WHERE id = $1", [r.who.accountId]);
      reports.length = 0;
      let n = 0;
      const gh = fakeGithub();
      const port = { ...gh.port, defaultBranch: async () => { if ((n += 1) === 1) throw new Error("boom"); return "main"; } };
      const pass = await issueSystemStarts(deps(gh, { pullRequests: () => port as never }), { accountId: r.who.accountId });
      expect(pass.results.map((x) => x.result).sort()).toEqual(["error", "issued"]);
      expect(reports).toEqual([{ stage: "engine_system_starts.issue", code: "engine_system_start_failed" }]);
    });
    it("stops starting repos when the job's time is spent", async () => {
      const r = await rig();
      const gh = fakeGithub();
      expect(await issueSystemStarts(deps(gh), { accountId: r.who.accountId, msLeft: () => 0 })).toEqual({ not_configured: false, issued: 0, results: [] });
      expect(gh.calls.defaultBranch).toBe(0);
    });
    it("refuses a hosted sandbox before GitHub is read or anything is signed, and never reaches a sandbox factory", async () => {
      const r = await rig();
      const gh = fakeGithub();
      const factory = vi.fn();
      const sign = vi.fn();
      const pass = await issueSystemStarts(deps(gh, { hostedFor: () => 1, engineCommandSigner: async () => ({ signMachineJob: (j: MachineJob) => { sign(); return signer.signMachineJob(j); } }) }), { accountId: r.who.accountId });
      expect(pass).toEqual({ not_configured: false, issued: 0, results: [{ account_id: r.who.accountId, repo_id: r.who.repoId, result: "hosted_engine_unavailable" }] });
      expect(gh.calls).toEqual({ defaultBranch: 0, branchState: 0 });
      expect(sign).not.toHaveBeenCalled();
      expect(factory).not.toHaveBeenCalled();
      await untouched(r);
    });
    it("calls the guard once per account's batch with the batch's size", async () => {
      const a = await rig();
      await addPlacement(a, "now()");
      await h.admin.query("UPDATE accounts SET engine_quantity = 2 WHERE id = $1", [a.who.accountId]);
      const seen: Array<[string, number]> = [];
      await issueSystemStarts(deps(fakeGithub(), { hostedFor: (id) => (seen.push([id, 0]), 0) }), { accountId: a.who.accountId });
      expect(seen).toEqual([[a.who.accountId, 0]]);
    });
    it("the guard itself: ok within any batch of runner machines, refused for any hosted sandbox, and strict about its inputs", () => {
      const id = randomUUID();
      for (const starts of [0, 1, 4, 500]) expect(engineSessionSpendGuard({ accountId: id, starts, hosted: 0 })).toEqual({ ok: true });
      for (const hosted of [1, 2, 99]) expect(engineSessionSpendGuard({ accountId: id, starts: 1, hosted })).toEqual({ ok: false, code: "hosted_engine_unavailable" });
      for (const bad of [-1, 1.5, Number.NaN]) {
        expect(() => engineSessionSpendGuard({ accountId: id, starts: bad, hosted: 0 })).toThrow();
        expect(() => engineSessionSpendGuard({ accountId: id, starts: 1, hosted: bad })).toThrow();
      }
    });
  });
});
