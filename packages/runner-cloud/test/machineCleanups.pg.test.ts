import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MACHINE_JOB_MAX_LIFE_S, signMachineJob, type MachineJob } from "@fulcrumaxe/runner-protocol";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { issueDueCleanups, type RunnerCloudDeps } from "../src/index.js";
import { harness, newKey, registerKey, type Harness } from "./helpers.js";

/**
 * [pg] D#845 ON-16a1: the cleanup definers of migration 1082 on real Postgres with row security forced. `machine_cleanup_due` and `machine_cleanup_issue` run only in a runner session;
 * `machine_cleanup_request` only for an owner or admin. Real Ed25519 signatures on every job (the database reads the job half only). Job states the runner reports are set as the admin
 * role, exactly as the 1066 report definer would leave them.
 */
describe("machine cleanups [pg]", () => {
  let h: Harness;
  const keys = generateKeyPairSync("ed25519");
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  interface Rig { who: SeedRefs; runnerId: string; ghRepoId: number; cleanupId: string }
  type Tx<T> = (client: PoolClient) => Promise<T>;
  const asRunner = <T>(accountId: string, runnerId: string, fn: Tx<T>): Promise<T> =>
    withTenant(h.appPool, accountId, async (c) => {
      await c.query("SELECT set_config('app.runner_id', $1, true)", [runnerId]);
      return fn(c);
    });
  const asPerson = <T>(accountId: string, userId: string, fn: Tx<T>): Promise<T> => withTenant(h.appPool, accountId, userId, fn);

  async function addMember(accountId: string, role: "admin" | "member"): Promise<string> {
    const userId = randomUUID();
    await h.admin.query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
    await h.admin.query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)", [accountId, userId, role]);
    return userId;
  }
  let extra = 0;
  async function secondRepo(r: Rig): Promise<{ repoId: string; ghRepoId: number }> {
    const repoId = randomUUID();
    const offset = 5000 + 1000 * ++extra;
    await h.admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) SELECT $1, account_id, installation_id, gh_repo_id + $3, product, 'acme', 'gadgets' FROM repos WHERE id = $2", [repoId, r.who.repoId, offset]);
    return { repoId, ghRepoId: r.ghRepoId + offset };
  }
  /** A fresh account with one runner and one cleanup request for its repo (operate epoch 3 unless `epoch: null`). */
  async function rig(o: { deleteSandbox?: boolean; epoch?: number | null } = {}): Promise<Rig> {
    const who = await seedAccount(h.admin, randomUUID());
    const ghRepoId = Number((await h.admin.query<{ gh_repo_id: string }>("SELECT gh_repo_id FROM repos WHERE id = $1", [who.repoId])).rows[0]!.gh_repo_id);
    const runnerId = await registerKey(h.admin, who.accountId, who.userId, newKey());
    if (o.epoch !== null) {
      await h.admin.query("INSERT INTO engine_bridge_settings (account_id, watch_enabled, operate_enabled) VALUES ($1, true, true)", [who.accountId]);
      for (let e = 1; e < (o.epoch ?? 3); e++) await h.admin.query("UPDATE engine_bridge_settings SET operate_enabled = NOT operate_enabled WHERE account_id = $1", [who.accountId]);
    }
    const cleanupId = await asPerson(who.accountId, who.userId, async (c) =>
      (await c.query<{ id: string }>("SELECT machine_cleanup_request($1, $2, $3) AS id", [who.repoId, runnerId, o.deleteSandbox ?? true])).rows[0]!.id);
    return { who, runnerId, ghRepoId, cleanupId };
  }

  interface Due { o_cleanup: string; o_repo: string; o_gh_repo_id: string; o_kind: string; o_reason: string; o_epoch: number }
  const due = (r: Rig, runnerId = r.runnerId, accountId = r.who.accountId) => asRunner(accountId, runnerId, async (c) => (await c.query<Due>("SELECT * FROM machine_cleanup_due()")).rows);
  const deps = (): RunnerCloudDeps => h.deps({ engineCommandSigner: async () => ({ keyId: "k1", signEngineCommand: () => { throw new Error("unused"); }, signMachineJob: (job: MachineJob) => signMachineJob(job, "k1", keys.privateKey) }) as never, log: () => undefined });
  const claimIssue = (r: Rig) => asRunner(r.who.accountId, r.runnerId, (c) => issueDueCleanups(c, deps(), { runnerId: r.runnerId }));
  const jobs = async (r: Rig) =>
    (await h.admin.query<{ id: string; kind: string; state: string; issued_at: Date; job: { job: MachineJob } }>("SELECT id, kind, state, issued_at, job FROM machine_jobs WHERE account_id = $1 ORDER BY issued_at, id", [r.who.accountId])).rows;
  const setState = (id: string, state: "delivered" | "done" | "failed" | "expired" | "superseded", endedMinutesAgo = 0) =>
    h.admin.query(
      `UPDATE machine_jobs SET state = $2, delivered_at = CASE WHEN $2 = 'superseded' THEN delivered_at ELSE COALESCE(delivered_at, issued_at) END,
              last_seq = CASE WHEN $2 IN ('done', 'failed') THEN 1 ELSE last_seq END, last_step = CASE $2 WHEN 'done' THEN 'done' WHEN 'failed' THEN 'admission' END,
              failure_code = CASE WHEN $2 = 'failed' THEN 'vm_teardown_incomplete' WHEN $2 = 'expired' THEN 'job_expired' END,
              ended_at = CASE WHEN $2 = 'delivered' THEN NULL ELSE now() - make_interval(mins => $3) END WHERE id = $1`,
      [id, state, endedMinutesAgo],
    );
  const stateOf = async (r: Rig) => (await h.admin.query<{ open: boolean; live: boolean; final_failures: string }>("SELECT open, live, final_failures FROM machine_cleanup_states WHERE id = $1", [r.cleanupId])).rows[0]!;
  const pgErr = async (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string }) => e.code ?? "error");

  /** A signed job for the cleanup's chain, valid unless an override says otherwise. */
  function jobFor(r: Rig, kind: "engine_session_stop" | "engine_session_delete", o: { id?: string; runnerId?: string; ghRepoId?: number; setupId?: string; reason?: string; epoch?: number; lifeS?: number; issuedAt?: Date; requires?: "microvm" | "any" } = {}) {
    const id = o.id ?? randomUUID();
    // A few ms ahead by default, so a job signed in the same millisecond as its request is never read as from before it.
    const issued = o.issuedAt ?? new Date(Date.now() + 5);
    const expires = new Date(issued.getTime() + (o.lifeS ?? MACHINE_JOB_MAX_LIFE_S) * 1000);
    const args = kind === "engine_session_stop" ? { reason: o.reason ?? "remove", operate_epoch: o.epoch ?? 3 } : { operate_epoch: o.epoch ?? 3 };
    const job = { v: 1, job_id: id, runner_id: o.runnerId ?? r.runnerId, repo_gh_id: o.ghRepoId ?? r.ghRepoId, requires_engine: o.requires ?? "any", issued_at: issued.toISOString(), expires_at: expires.toISOString(), kind, args, ...(o.setupId ? { setup_id: o.setupId } : {}) } as MachineJob;
    // The protocol's own signer refuses a life over 30 minutes, so that case is bytes a broken signer could have made: the database must refuse them on its own.
    const signed = (o.lifeS ?? 0) > MACHINE_JOB_MAX_LIFE_S ? { job, key_id: "k1", signature: "A".repeat(86) } : signMachineJob(job, "k1", keys.privateKey);
    return { id, kind, signed, issued, expires };
  }
  const issue = (r: Rig, j: ReturnType<typeof jobFor>, cleanupId = r.cleanupId, runnerId = r.runnerId, accountId = r.who.accountId) =>
    asRunner(accountId, runnerId, (c) => c.query("SELECT machine_cleanup_issue($1, $2, $3, $4::jsonb, $5, $6)", [cleanupId, j.id, j.kind, JSON.stringify(j.signed), j.issued, j.expires]));

  describe("machine_cleanup_due", () => {
    it("returns the chain once (stop, then delete), then nothing while a job of it is issued or delivered", async () => {
      const r = await rig();
      expect((await due(r)).map((d) => [d.o_kind, d.o_reason, Number(d.o_gh_repo_id), d.o_epoch, d.o_repo])).toEqual([
        ["engine_session_stop", "remove", r.ghRepoId, 3, r.who.repoId],
        ["engine_session_delete", "remove", r.ghRepoId, 3, r.who.repoId],
      ]);
      expect(await claimIssue(r)).toBe(2);
      expect(await due(r)).toEqual([]);
      const [stop] = await jobs(r);
      await setState(stop!.id, "delivered");
      expect(await due(r)).toEqual([]);
      expect(await claimIssue(r)).toBe(0);
      expect(await jobs(r)).toHaveLength(2);
    });

    it("counts only jobs issued since the request: an earlier removal's done delete and a live stop from before do not close or hide a new request", async () => {
      const r = await rig();
      await claimIssue(r);
      const [stop, del] = await jobs(r);
      await setState(del!.id, "done");
      expect((await stateOf(r)).open).toBe(false);
      // The stop of that chain is still waiting (never taken) when the repo is removed again: the new request restarts the chain.
      await asPerson(r.who.accountId, r.who.userId, (c) => c.query("SELECT pg_sleep(0.01), machine_cleanup_request($1, $2, true)", [r.who.repoId, r.runnerId]));
      expect(stop!.state).toBe("issued");
      expect((await stateOf(r)).open).toBe(true);
      expect((await due(r)).map((d) => d.o_kind)).toEqual(["engine_session_stop", "engine_session_delete"]);
    });

    it("returns only the stop when the sandbox is kept", async () => {
      const r = await rig({ deleteSandbox: false });
      expect((await due(r)).map((d) => d.o_kind)).toEqual(["engine_session_stop"]);
    });

    it("returns the chain again once both jobs expired or were superseded", async () => {
      const r = await rig();
      await claimIssue(r);
      const [stop, del] = await jobs(r);
      await setState(stop!.id, "expired");
      await setState(del!.id, "superseded");
      expect((await due(r)).map((d) => d.o_kind)).toEqual(["engine_session_stop", "engine_session_delete"]);
    });

    it("waits 60 minutes after the runner reported a failure, then returns the chain again", async () => {
      const r = await rig();
      await claimIssue(r);
      const [stop, del] = await jobs(r);
      await setState(stop!.id, "done", 30);
      await setState(del!.id, "failed", 30);
      expect(await due(r)).toEqual([]);
      await setState(del!.id, "failed", 61);
      expect((await due(r)).map((d) => d.o_kind)).toEqual(["engine_session_stop", "engine_session_delete"]);
    });

    it("returns nothing after three failures of the final job (given up) and nothing after it is done", async () => {
      const given = await rig();
      for (let i = 0; i < 3; i++) {
        await h.admin.query("UPDATE machine_cleanups SET requested_at = requested_at - interval '1 hour' WHERE id = $1", [given.cleanupId]);
        expect(await claimIssue(given)).toBe(2);
        const all = await jobs(given);
        await setState(all[all.length - 2]!.id, "done", 61);
        await setState(all[all.length - 1]!.id, "failed", 61);
      }
      expect(await due(given)).toEqual([]);
      expect(await stateOf(given)).toMatchObject({ open: false, final_failures: "3" });

      const done = await rig();
      await claimIssue(done);
      const [, del] = await jobs(done);
      await setState(del!.id, "done", 61);
      expect(await due(done)).toEqual([]);
      expect((await stateOf(done)).open).toBe(false);
    });

    it("counts only the final kind: a stop that failed three times does not give up a cleanup whose delete is still due", async () => {
      const r = await rig();
      for (let i = 0; i < 3; i++) {
        await h.admin.query("UPDATE machine_cleanups SET requested_at = requested_at - interval '1 hour' WHERE id = $1", [r.cleanupId]);
        await claimIssue(r);
        const all = await jobs(r);
        await setState(all[all.length - 2]!.id, "failed", 61);
        await setState(all[all.length - 1]!.id, "expired", 61);
      }
      expect((await stateOf(r)).open).toBe(true);
      expect((await due(r)).map((d) => d.o_kind)).toEqual(["engine_session_stop", "engine_session_delete"]);
    });

    it("a revoked runner has no session (42501) and its cleanup is closed; another account's runner reads 0 rows of it", async () => {
      const r = await rig();
      const other = await rig();
      expect(await due(other)).toHaveLength(2);
      // Another account's runner session sees only its own account's cleanups, and cannot name this one.
      expect((await due(other)).every((d) => d.o_cleanup === other.cleanupId)).toBe(true);
      expect(await pgErr(issue(r, jobFor(r, "engine_session_stop"), r.cleanupId, other.runnerId, other.who.accountId))).toBe("22023");
      const viaAdminForeign = await h.admin.query("SELECT 1 FROM machine_cleanup_states WHERE id = $1 AND account_id = $2", [r.cleanupId, other.who.accountId]);
      expect(viaAdminForeign.rows).toHaveLength(0);
      expect(await asRunner(other.who.accountId, other.runnerId, async (c) => (await c.query("SELECT 1 FROM machine_cleanup_states WHERE id = $1", [r.cleanupId])).rows)).toHaveLength(0);
      expect(await asRunner(other.who.accountId, other.runnerId, async (c) => (await c.query("SELECT 1 FROM machine_cleanups WHERE id = $1", [r.cleanupId])).rows)).toHaveLength(0);
      await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [r.runnerId]);
      expect(await pgErr(due(r))).toBe("42501");
      expect((await stateOf(r)).open).toBe(false);
    });

    it("a second runner of the same account is not handed this runner's cleanup, and its jobs for the same repo do not count for it", async () => {
      const r = await rig();
      const second = await registerKey(h.admin, r.who.accountId, r.who.userId, newKey());
      expect(await due(r, second)).toEqual([]);
      // A live stop and a done delete of the same repo on the second runner: this runner's cleanup is still open and due.
      const cleanup2 = await asPerson(r.who.accountId, r.who.userId, async (c) => (await c.query<{ id: string }>("SELECT machine_cleanup_request($1, $2, true) AS id", [r.who.repoId, second])).rows[0]!.id);
      const at = Date.now() + 2000;
      await issue(r, jobFor(r, "engine_session_stop", { runnerId: second, issuedAt: new Date(at) }), cleanup2, second);
      const done = jobFor(r, "engine_session_delete", { runnerId: second, issuedAt: new Date(at + 1) });
      await issue(r, done, cleanup2, second);
      await setState(done.id, "done");
      expect((await due(r)).map((d) => d.o_kind)).toEqual(["engine_session_stop", "engine_session_delete"]);
      expect((await stateOf(r)).open).toBe(true);
      expect(await pgErr(issue(r, jobFor(r, "engine_session_stop", { runnerId: second }), r.cleanupId, second))).toBe("22023");
    });

    it("a live stop of a second repo on the same runner neither hides this cleanup nor lets its delete in without its own stop", async () => {
      const r = await rig();
      const two = await secondRepo(r);
      const otherCleanup = await asPerson(r.who.accountId, r.who.userId, async (c) => (await c.query<{ id: string }>("SELECT machine_cleanup_request($1, $2, true) AS id", [two.repoId, r.runnerId])).rows[0]!.id);
      // The second repo's stop, issued now and still waiting: this repo's cleanup stays due.
      // Issued after both requests (2 s ahead, inside the clock window), so it is a chain job of the second repo's request and of no other.
      const otherStop = jobFor({ ...r, ghRepoId: two.ghRepoId }, "engine_session_stop", { issuedAt: new Date(Date.now() + 2000) });
      await issue({ ...r, ghRepoId: two.ghRepoId }, otherStop, otherCleanup);
      expect((await due(r)).filter((d) => d.o_cleanup === r.cleanupId).map((d) => d.o_kind)).toEqual(["engine_session_stop", "engine_session_delete"]);
      // This repo's stop issued and live: its delete is due only as the second job of THAT chain, 1 ms after it.
      const stop = jobFor(r, "engine_session_stop");
      await issue(r, stop);
      expect(await pgErr(issue(r, jobFor(r, "engine_session_delete", { issuedAt: new Date(otherStop.issued.getTime() + 1) })))).toBe("22023");
      expect(await pgErr(issue(r, jobFor(r, "engine_session_delete", { issuedAt: new Date(stop.issued.getTime() + 1) })))).toBe("ok");
      expect(await pgErr(issue(r, jobFor(r, "engine_session_delete", { issuedAt: new Date(stop.issued.getTime() + 1) })))).toBe("22023");
    });
  });

  describe("machine_cleanup_issue", () => {
    it("refuses with 22023 and writes nothing: another runner, another repo, a setup, a reason other than remove, a stale epoch, a 31-minute life, an engine requirement, a kind outside the chain, a stale clock, and a cleanup that is not due", async () => {
      const r = await rig();
      const kept = await rig({ deleteSandbox: false });
      const setupId = (await h.admin.query<{ id: string }>("INSERT INTO project_setups (account_id, repo_id, kind, created_by) VALUES ($1, $2, 'existing', $3) RETURNING id", [r.who.accountId, r.who.repoId, r.who.userId])).rows[0]!.id;
      const second = await registerKey(h.admin, r.who.accountId, r.who.userId, newKey());
      const two = await secondRepo(r);
      const requestedAt = (await h.admin.query<{ requested_at: Date }>("SELECT requested_at FROM machine_cleanups WHERE id = $1", [r.cleanupId])).rows[0]!.requested_at;
      const cases: Array<[string, ReturnType<typeof jobFor>, Rig?]> = [
        ["another runner", jobFor(r, "engine_session_stop", { runnerId: second })],
        ["another repo", jobFor(r, "engine_session_stop", { ghRepoId: two.ghRepoId })],
        ["a setup", jobFor(r, "engine_session_stop", { setupId })],
        ["a person's reason", jobFor(r, "engine_session_stop", { reason: "person" })],
        ["a stale epoch", jobFor(r, "engine_session_stop", { epoch: 2 })],
        ["a 31-minute life", jobFor(r, "engine_session_stop", { lifeS: 31 * 60 })],
        ["a microVM requirement", jobFor(r, "engine_session_stop", { requires: "microvm" })],
        ["issued two minutes ago", jobFor(r, "engine_session_stop", { issuedAt: new Date(Date.now() - 120_000) })],
        ["issued two minutes ahead", jobFor(r, "engine_session_stop", { issuedAt: new Date(Date.now() + 120_000) })],
        ["issued before the request", jobFor(r, "engine_session_stop", { issuedAt: new Date(requestedAt.getTime() - 50) })],
        ["a delete the request did not ask for", jobFor(kept, "engine_session_delete"), kept],
      ];
      for (const [label, j, target] of cases) expect(`${label}: ${await pgErr(issue(target ?? r, j))}`).toBe(`${label}: 22023`);
      expect(await jobs(r)).toEqual([]);
      expect(await jobs(kept)).toEqual([]);
      // Not due: after the chain is out, another stop is refused.
      expect(await claimIssue(r)).toBe(2);
      expect(await pgErr(issue(r, jobFor(r, "engine_session_stop")))).toBe("22023");
      // A kind that is no session kind at all.
      expect(await pgErr(asRunner(r.who.accountId, r.runnerId, (c) => c.query("SELECT machine_cleanup_issue($1, $2, 'project_remove', '{}'::jsonb, now(), now() + interval '1 minute')", [r.cleanupId, randomUUID()])))).toBe("22023");
    });

    it("issues the delete 1 ms after the stop, and machine_job_pending hands the stop over first", async () => {
      const r = await rig();
      await claimIssue(r);
      const [stop, del] = await jobs(r);
      expect([stop!.kind, del!.kind]).toEqual(["engine_session_stop", "engine_session_delete"]);
      expect(del!.issued_at.getTime() - stop!.issued_at.getTime()).toBe(1);
      expect(stop!.job.job).toMatchObject({ kind: "engine_session_stop", runner_id: r.runnerId, repo_gh_id: r.ghRepoId, requires_engine: "any", args: { reason: "remove", operate_epoch: 3 } });
      expect(stop!.job.job.setup_id).toBeUndefined();
      const pending = await asRunner(r.who.accountId, r.runnerId, async (c) => (await c.query<{ o_id: string }>("SELECT o_id FROM machine_job_pending()")).rows.map((x) => x.o_id));
      expect(pending).toEqual([stop!.id, del!.id]);
    });

    it("signs the epoch as it is now, 0 for an account that never had the settings row", async () => {
      const r = await rig({ epoch: null });
      expect((await due(r)).map((d) => d.o_epoch)).toEqual([0, 0]);
      expect(await claimIssue(r)).toBe(2);
    });

    it("rolls a chain back whole when the signer is missing or the issue is refused, and never throws into the claim", async () => {
      const r = await rig();
      const lines: string[] = [];
      expect(await asRunner(r.who.accountId, r.runnerId, (c) => issueDueCleanups(c, h.deps({ log: (l) => lines.push(l) }), { runnerId: r.runnerId }))).toBe(0);
      // A signer that signs a different epoch: the stop is refused, so nothing of the chain is left.
      const wrong = h.deps({ log: (l) => lines.push(l), engineCommandSigner: async () => ({ keyId: "k1", signEngineCommand: () => { throw new Error("unused"); }, signMachineJob: (job: MachineJob) => signMachineJob({ ...job, runner_id: randomUUID() } as MachineJob, "k1", keys.privateKey) }) as never });
      expect(await asRunner(r.who.accountId, r.runnerId, (c) => issueDueCleanups(c, wrong, { runnerId: r.runnerId }))).toBe(0);
      expect(await jobs(r)).toEqual([]);
      expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual([{ event: "machine_cleanup.not_configured", code: "not_configured" }, { event: "machine_cleanup.issue_refused", code: "22023" }]);
    });
  });

  describe("who may call", () => {
    it("the runner definers raise outside a runner session, the request definer inside one or for a member, and app_user cannot write the table", async () => {
      const r = await rig();
      const member = await addMember(r.who.accountId, "member");
      const admin = await addMember(r.who.accountId, "admin");
      const j = jobFor(r, "engine_session_stop");
      expect(await pgErr(asPerson(r.who.accountId, r.who.userId, (c) => c.query("SELECT * FROM machine_cleanup_due()")))).toBe("42501");
      expect(await pgErr(asPerson(r.who.accountId, r.who.userId, (c) => c.query("SELECT machine_cleanup_issue($1, $2, $3, $4::jsonb, $5, $6)", [r.cleanupId, j.id, j.kind, JSON.stringify(j.signed), j.issued, j.expires])))).toBe("42501");
      expect(await pgErr(asRunner(r.who.accountId, r.runnerId, (c) => c.query("SELECT machine_cleanup_request($1, $2, true)", [r.who.repoId, r.runnerId])))).toBe("42501");
      expect(await pgErr(asPerson(r.who.accountId, member, (c) => c.query("SELECT machine_cleanup_request($1, $2, true)", [r.who.repoId, r.runnerId])))).toBe("42501");
      expect(await pgErr(asPerson(r.who.accountId, admin, (c) => c.query("SELECT machine_cleanup_request($1, $2, true)", [r.who.repoId, r.runnerId])))).toBe("ok");
      expect(await pgErr(asPerson(r.who.accountId, r.who.userId, (c) => c.query("INSERT INTO machine_cleanups (account_id, repo_id, runner_id, reason, delete_sandbox, requested_by) VALUES ($1, $2, $3, 'remove', true, $4)", [r.who.accountId, r.who.repoId, r.runnerId, r.who.userId])))).toBe("42501");
      expect(await pgErr(asPerson(r.who.accountId, r.who.userId, (c) => c.query("UPDATE machine_cleanups SET delete_sandbox = false WHERE id = $1", [r.cleanupId])))).toBe("42501");
      expect(await pgErr(asPerson(r.who.accountId, r.who.userId, (c) => c.query("DELETE FROM machine_cleanups WHERE id = $1", [r.cleanupId])))).toBe("42501");
    });

    it("the request refuses another account's repo or runner and a revoked runner (22023), and a second request restarts the chain on the same row", async () => {
      const r = await rig();
      const other = await rig();
      const req = (repo: string, runner: string) => pgErr(asPerson(r.who.accountId, r.who.userId, (c) => c.query("SELECT machine_cleanup_request($1, $2, false)", [repo, runner])));
      expect(await req(other.who.repoId, r.runnerId)).toBe("22023");
      expect(await req(r.who.repoId, other.runnerId)).toBe("22023");
      const before = (await h.admin.query<{ requested_at: Date }>("SELECT requested_at FROM machine_cleanups WHERE id = $1", [r.cleanupId])).rows[0]!.requested_at;
      expect(await req(r.who.repoId, r.runnerId)).toBe("ok");
      const after = (await h.admin.query<{ id: string; requested_at: Date; delete_sandbox: boolean }>("SELECT id, requested_at, delete_sandbox FROM machine_cleanups WHERE account_id = $1", [r.who.accountId])).rows;
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ id: r.cleanupId, delete_sandbox: false });
      expect(after[0]!.requested_at.getTime()).toBeGreaterThanOrEqual(before.getTime());
      await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [r.runnerId]);
      expect(await req(r.who.repoId, r.runnerId)).toBe("22023");
    });
  });
});
