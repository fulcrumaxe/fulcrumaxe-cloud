import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GIT_TICKET_PATH } from "@fulcrumaxe/runner-protocol";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import {
  CLAIM_PATH,
  FLEET_SETTING_ACTIONS,
  HEARTBEAT_PATH,
  applyRunnerSetting,
  claimRun,
  eventsPath,
  gitTicketRun,
  heartbeatRun,
  ingestEvents,
  listRunners,
  removeRunner,
  setRunnerRepos,
  type FailRunnerLeases,
  type FleetSettingAction,
  type RunnerLeaseOps,
} from "../src/index.js";
import { harness, newKey, registerKey, respond, signed, type Harness } from "./helpers.js";

/**
 * [pg] D#605 FL-8: the fleet control routes, on real Postgres with row security forced and the real definers (0783, 0790). Who may do what is the
 * database's rule, so each case here asks as a real user of the account and reads the rows back as the admin role.
 */
describe("fleet control routes [pg]", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  const fresh = (): Promise<F2Fixture> => seedF2(h.admin);
  const installations = new Map<string, string>();
  async function newRepo(f: F2Fixture): Promise<string> {
    let installationId = installations.get(f.accountId);
    if (!installationId) {
      installationId = randomUUID();
      await h.admin.query("INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, floor(random() * 2000000000)::bigint + 1, 'team')", [installationId, f.accountId]);
      installations.set(f.accountId, installationId);
    }
    const id = randomUUID();
    await h.admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, floor(random() * 2000000000)::bigint + 1, 'team', 'acme', $4)", [id, f.accountId, installationId, `app-${id.slice(0, 8)}`]);
    return id;
  }
  const runner = (f: F2Fixture, by: string): Promise<string> => insertRunner(h.admin, f.accountId, by);
  const settings = async (id: string) =>
    (await h.admin.query("SELECT name, labels, rank, paused_at IS NOT NULL AS paused, paused_by, draining, drained_by FROM runner_settings WHERE runner_id = $1", [id])).rows[0] ?? null;
  const repoIds = async (id: string): Promise<string[]> => (await h.admin.query("SELECT allowed_repo_ids FROM runners WHERE id = $1", [id])).rows[0].allowed_repo_ids;
  const auditRows = async (f: F2Fixture, action: string) => (await h.admin.query("SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = $2 ORDER BY created_at", [f.accountId, action])).rows;
  const act = (f: F2Fixture, user: string, id: string, action: FleetSettingAction, body: unknown = null) => respond(() => applyRunnerSetting(h.deps(), { accountId: f.accountId, userId: user }, id, action, body));
  const repos = (f: F2Fixture, user: string, id: string, ids: unknown) => respond(() => setRunnerRepos(h.deps(), { accountId: f.accountId, userId: user }, id, { repo_ids: ids }));
  const recorder = () => {
    const calls: Array<{ accountId: string; runnerId: string; reason: string }> = [];
    const fail: FailRunnerLeases = async (input) => {
      calls.push(input);
      return { runIds: [randomUUID()], complete: true };
    };
    return { calls, fail };
  };
  const remove = (f: F2Fixture, user: string, id: string, fail: FailRunnerLeases | null) => respond(() => removeRunner(h.deps({ failRunnerLeases: fail }), { accountId: f.accountId, userId: user }, id));

  describe("pause, drain and resume (acceptance 2, 5)", () => {
    it("lets the registrant pause and drain their own runner, and a member who is not the registrant gets 403 and changes nothing", async () => {
      const f = await fresh();
      const id = await runner(f, f.m1);
      expect(await act(f, f.m2, id, "pause")).toMatchObject({ status: 403, body: { error: { code: "forbidden" } } });
      expect(await act(f, f.m2, id, "drain")).toMatchObject({ status: 403 });
      expect(await settings(id)).toBeNull();
      expect(await act(f, f.m1, id, "pause")).toMatchObject({ status: 200, body: { runner_id: id, paused: true, draining: false, name: null, rank: 0 } });
      expect(await act(f, f.m1, id, "drain", {})).toMatchObject({ status: 200, body: { paused: true, draining: true } });
      expect(await settings(id)).toMatchObject({ paused: true, paused_by: f.m1, draining: true, drained_by: f.m1 });
    });

    it("a registrant's resume of an owner-set pause is 403 and of their own is 200; an owner pause after a registrant pause takes paused_by", async () => {
      const f = await fresh();
      const id = await runner(f, f.m1);
      await act(f, f.m1, id, "pause");
      expect(await act(f, f.o1, id, "pause")).toMatchObject({ status: 200 });
      expect(await settings(id)).toMatchObject({ paused_by: f.o1 });
      expect(await act(f, f.m1, id, "resume")).toMatchObject({ status: 403 });
      expect(await settings(id)).toMatchObject({ paused: true, paused_by: f.o1 });
      expect(await act(f, f.a1, id, "resume")).toMatchObject({ status: 200, body: { paused: false, draining: false } });
      await act(f, f.m1, id, "pause");
      expect(await act(f, f.m1, id, "resume")).toMatchObject({ status: 200, body: { paused: false } });
    });

    it("a non-admin registrant's resume of an owner-set drain is 403 and of their own drain is 200", async () => {
      const f = await fresh();
      const id = await runner(f, f.m1);
      await act(f, f.o1, id, "drain");
      expect(await settings(id)).toMatchObject({ draining: true, drained_by: f.o1 });
      expect(await act(f, f.m1, id, "resume")).toMatchObject({ status: 403 });
      expect(await settings(id)).toMatchObject({ draining: true, drained_by: f.o1 });
      expect(await act(f, f.o2, id, "resume")).toMatchObject({ status: 200 });
      await act(f, f.m1, id, "drain");
      expect(await act(f, f.m1, id, "resume")).toMatchObject({ status: 200, body: { draining: false } });
    });

    it("a drain on a runner holding two running runs leaves both running, the next claim answers idle, and after both end the state reads paused", async () => {
      const f = await fresh();
      const key = newKey();
      const id = await registerKey(h.admin, f.accountId, f.m1, key);
      const repo = await newRepo(f);
      const running: string[] = [];
      for (let i = 0; i < 2; i++) {
        const runId = randomUUID();
        running.push(runId);
        await h.admin.query(
          "INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, runner_id, lease_generation, lease_expires_at, dispatch_repo_id) VALUES ($1, $2, 'executor', 'runner', 'running', 'runner_verified', $3, 1, now() + interval '10 minutes', $4)",
          [runId, f.accountId, id, repo],
        );
      }
      const state = async () => {
        const body = (await respond(() => listRunners(h.deps(), { accountId: f.accountId, userId: f.o1 }))).body as { runners: Array<{ id: string; state: string }> };
        return body.runners.find((r) => r.id === id)!.state;
      };
      expect(await act(f, f.m1, id, "drain")).toMatchObject({ status: 200, body: { draining: true } });
      const statuses = async () => (await h.admin.query("SELECT status FROM agent_runs WHERE runner_id = $1 ORDER BY id", [id])).rows.map((r) => r.status);
      expect(await statuses()).toEqual(["running", "running"]);
      expect(await state()).toBe("draining");
      const asked: string[] = [];
      const leases = { claimRunnerRun: async () => (asked.push("claim"), { kind: "idle" as const, retryAfter: 60 }) } as unknown as RunnerLeaseOps;
      const claim = await respond(() => claimRun(h.deps({ leases }), signed(key, CLAIM_PATH, {})));
      expect(claim).toMatchObject({ status: 200, body: { retry_after: 300 } });
      expect(asked).toEqual([]);
      await h.admin.query("UPDATE agent_runs SET status = 'succeeded' WHERE runner_id = $1", [id]);
      expect(await state()).toBe("paused");
    });
  });

  describe("rename, labels and rank", () => {
    it("lets the registrant rename; labels and rank are for an owner or admin; a bad value is 400 and writes nothing", async () => {
      const f = await fresh();
      const id = await runner(f, f.m1);
      expect(await act(f, f.m1, id, "rename", { name: "Ada's laptop" })).toMatchObject({ status: 200, body: { name: "Ada's laptop" } });
      expect(await act(f, f.m2, id, "rename", { name: "mine now" })).toMatchObject({ status: 403 });
      expect(await act(f, f.m1, id, "labels", { labels: ["gpu"] })).toMatchObject({ status: 403 });
      expect(await act(f, f.m1, id, "rank", { rank: 5 })).toMatchObject({ status: 403 });
      expect(await act(f, f.a1, id, "labels", { labels: ["gpu", "fast-disk"] })).toMatchObject({ status: 200, body: { labels: ["gpu", "fast-disk"] } });
      expect(await act(f, f.o1, id, "rank", { rank: 7 })).toMatchObject({ status: 200, body: { rank: 7 } });
      for (const [action, body] of [
        ["rename", { name: "bad\u0007name" }],
        ["rename", { name: "x".repeat(65) }],
        ["rename", { name: "   " }],
        ["labels", { labels: ["Not Valid"] }],
        ["labels", { labels: ["a", "a"] }],
        ["rank", { rank: 1001 }],
        ["rank", { rank: -1 }],
      ] as const) {
        expect(await act(f, f.o1, id, action, body), `${action} ${JSON.stringify(body)}`).toMatchObject({ status: 400, body: { error: { code: "invalid_message" } } });
      }
      expect(await settings(id)).toMatchObject({ name: "Ada's laptop", labels: ["gpu", "fast-disk"], rank: 7 });
    });

    it("refuses a body that is not exactly what the route takes, before the database is asked", async () => {
      const f = await fresh();
      const id = await runner(f, f.m1);
      for (const [action, body] of [
        ["rename", null], ["rename", {}], ["rename", { name: 5 }], ["rename", { name: "a", extra: 1 }], ["rename", ["a"]],
        ["labels", { labels: "gpu" }], ["labels", { labels: [1] }], ["labels", { labels: Array.from({ length: 17 }, (_v, i) => `l${i}`) }],
        ["rank", { rank: 1.5 }], ["rank", { rank: "3" }],
        ["pause", { move: "cloud" }], ["drain", { x: 1 }], ["resume", [1]],
      ] as const) {
        expect((await act(f, f.o1, id, action, body)).status, `${action} ${JSON.stringify(body)}`).toBe(400);
      }
      expect(await settings(id)).toBeNull();
      expect(await auditRows(f, "runner.renamed")).toEqual([]);
    });

    it("answers 404 for a malformed id, an unknown runner and another account's runner, and 403 to a non-member", async () => {
      const f = await fresh();
      const other = await fresh();
      const theirs = await runner(other, other.m1);
      const mine = await runner(f, f.m1);
      expect((await act(f, f.o1, "not-a-uuid", "pause")).status).toBe(404);
      expect((await act(f, f.o1, randomUUID(), "pause")).status).toBe(404);
      expect((await act(f, f.o1, theirs, "pause")).status).toBe(404);
      expect((await act(f, other.o1, mine, "pause")).status).toBe(403);
      expect(await settings(theirs)).toBeNull();
      expect(await settings(mine)).toBeNull();
    });
  });

  describe("repos (acceptance 4)", () => {
    it("lets the registrant narrow but not widen, and an owner or admin set any set of the account's repos", async () => {
      const f = await fresh();
      const [r1, r2, r3] = [await newRepo(f), await newRepo(f), await newRepo(f)];
      const id = await runner(f, f.m1);
      await h.admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[] WHERE id = $1", [id, [r1, r2]]);
      expect(await repos(f, f.m1, id, [r1, r2, r3])).toMatchObject({ status: 403 });
      expect(await repos(f, f.m1, id, [r3])).toMatchObject({ status: 403 });
      expect([...(await repoIds(id))].sort()).toEqual([r1, r2].sort());
      expect(await repos(f, f.m2, id, [r1])).toMatchObject({ status: 403 });
      expect(await repos(f, f.m1, id, [r1])).toMatchObject({ status: 200, body: { runner_id: id, repo_ids: [r1] } });
      expect(await repos(f, f.m1, id, [r1, r1])).toMatchObject({ status: 200, body: { repo_ids: [r1] } });
      expect(await repos(f, f.a1, id, [r3, r1, r2])).toMatchObject({ status: 200 });
      expect([...(await repoIds(id))].sort()).toEqual([r1, r2, r3].sort());
      expect(await repos(f, f.m1, id, [])).toMatchObject({ status: 200, body: { repo_ids: [] } });
      const rows = await auditRows(f, "runner.repos_set");
      expect(rows.map((r) => r.actor)).toEqual([f.m1, f.m1, f.a1, f.m1]);
      expect(rows[0]!.payload).toMatchObject({ runner_id: id, added: [], removed: [r2] });
      expect(rows[2]!.payload).toMatchObject({ added: [r2, r3].sort(), removed: [] });
    });

    it("refuses a repo of another account, and a list that is not a list of uuids, and writes nothing", async () => {
      const f = await fresh();
      const other = await fresh();
      const mine = await newRepo(f);
      const theirs = await newRepo(other);
      const id = await runner(f, f.m1);
      await h.admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[] WHERE id = $1", [id, [mine]]);
      expect(await repos(f, f.o1, id, [mine, theirs])).toMatchObject({ status: 400, body: { error: { code: "invalid_message" } } });
      expect(await repos(f, f.o1, id, [randomUUID()])).toMatchObject({ status: 400 });
      for (const bad of ["x", [1], ["nope"], [null], Array.from({ length: 101 }, () => randomUUID())]) expect((await repos(f, f.o1, id, bad)).status, JSON.stringify(bad)).toBe(400);
      expect((await respond(() => setRunnerRepos(h.deps(), { accountId: f.accountId, userId: f.o1 }, id, null))).status).toBe(400);
      expect(await repoIds(id)).toEqual([mine]);
      expect(await auditRows(f, "runner.repos_set")).toEqual([]);
    });
  });

  describe("a removed runner answers 409 runner_revoked on every route (C-605-1)", () => {
    const everything = async (f: F2Fixture, user: string, id: string) => {
      const out: Array<[string, number, unknown]> = [];
      for (const action of FLEET_SETTING_ACTIONS) {
        const body = action === "rename" ? { name: "again" } : action === "labels" ? { labels: ["x"] } : action === "rank" ? { rank: 1 } : null;
        const res = await act(f, user, id, action, body);
        out.push([action, res.status, (res.body as { error?: { code: string } }).error?.code]);
      }
      const r = await repos(f, user, id, []);
      out.push(["repos", r.status, (r.body as { error?: { code: string } }).error?.code]);
      return out;
    };

    it("by an owner, an admin or the registrant, with 0 rows changed and no audit row", async () => {
      const f = await fresh();
      const repo = await newRepo(f);
      const id = await runner(f, f.m1);
      await h.admin.query("UPDATE runners SET allowed_repo_ids = $2::uuid[], revoked_at = now(), revoked_reason = 'revoked' WHERE id = $1", [id, [repo]]);
      const before = (await h.admin.query("SELECT count(*)::int AS n FROM audit_log WHERE account_id = $1", [f.accountId])).rows[0].n;
      for (const user of [f.o1, f.a1, f.m1]) {
        for (const [name, status, code] of await everything(f, user, id)) expect([name, status, code]).toEqual([name, 409, "runner_revoked"]);
      }
      expect(await settings(id)).toBeNull();
      expect(await repoIds(id)).toEqual([repo]);
      expect((await h.admin.query("SELECT count(*)::int AS n FROM audit_log WHERE account_id = $1", [f.accountId])).rows[0].n).toBe(before);
      const rec = recorder();
      const again = await remove(f, f.o1, id, rec.fail);
      expect(again).toMatchObject({ status: 409, body: { error: { code: "runner_revoked" } } });
    });

    it("after the registrant is removed from the account: their routes are 403, everyone else's 409, and the runner is revoked by the existing trigger", async () => {
      const f = await fresh();
      const id = await runner(f, f.m1);
      await act(f, f.m1, id, "pause");
      await h.admin.query("DELETE FROM account_members WHERE account_id = $1 AND user_id = $2", [f.accountId, f.m1]);
      expect((await h.admin.query("SELECT revoked_at FROM runners WHERE id = $1", [id])).rows[0].revoked_at).not.toBeNull();
      for (const [name, status] of await everything(f, f.m1, id)) expect([name, status]).toEqual([name, 403]);
      for (const [name, status, code] of await everything(f, f.o1, id)) expect([name, status, code]).toEqual([name, 409, "runner_revoked"]);
      expect(await settings(id)).toMatchObject({ paused: true, paused_by: f.m1, name: null });
      expect((await remove(f, f.m1, id, recorder().fail)).status).toBe(403);
    });
  });

  describe("remove (acceptance 1)", () => {
    it("revokes through the existing path: revoked_at set, one audit row, the leases failed after the commit; other members are 403", async () => {
      const f = await fresh();
      const id = await runner(f, f.m1);
      const rec = recorder();
      expect(await remove(f, f.m2, id, rec.fail)).toMatchObject({ status: 403 });
      expect((await h.admin.query("SELECT revoked_at FROM runners WHERE id = $1", [id])).rows[0].revoked_at).toBeNull();
      expect(rec.calls).toEqual([]);
      expect(await remove(f, f.m1, id, rec.fail)).toMatchObject({ status: 200, body: { runner_id: id, removed: true, runs_failed: 1 } });
      expect(rec.calls).toEqual([{ accountId: f.accountId, runnerId: id, reason: "runner_revoked" }]);
      const row = (await h.admin.query("SELECT revoked_at, revoked_reason FROM runners WHERE id = $1", [id])).rows[0];
      expect(row.revoked_at).not.toBeNull();
      expect(await auditRows(f, "runner.revoked")).toEqual([{ actor: f.m1, payload: { runner_id: id, reason: "revoked", registered_by: f.m1 } }]);
      // A repeat is 409, and still fails the leases (the retry path after a 503).
      expect(await remove(f, f.a1, id, rec.fail)).toMatchObject({ status: 409, body: { error: { code: "runner_revoked" }, runs_failed: 1 } });
      expect(rec.calls).toHaveLength(2);
      expect((await remove(f, f.o1, "nope", rec.fail)).status).toBe(404);
      expect((await remove(f, f.o1, randomUUID(), rec.fail)).status).toBe(404);
    });

    it("keeps the removal in force when the leases cannot be failed, and says so", async () => {
      const f = await fresh();
      const id = await runner(f, f.o1);
      expect(await remove(f, f.o1, id, null)).toMatchObject({ status: 503, body: { error: { code: "leases_not_failed" }, revoked: true } });
      expect((await h.admin.query("SELECT revoked_at FROM runners WHERE id = $1", [id])).rows[0].revoked_at).not.toBeNull();
    });

    it("the runner's next claim, heartbeat, events and git ticket are 401, and the git proxy's resolver refuses its unexpired lease", async () => {
      const f = await fresh();
      const key = newKey();
      const id = await registerKey(h.admin, f.accountId, f.m1, key);
      const repo = await newRepo(f);
      const runId = randomUUID();
      await h.admin.query(
        "INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, runner_id, lease_generation, lease_expires_at, dispatch_repo_id) VALUES ($1, $2, 'executor', 'runner', 'running', 'runner_verified', $3, 1, now() + interval '10 minutes', $4)",
        [runId, f.accountId, id, repo],
      );
      const calls: string[] = [];
      const leases = {
        claimRunnerRun: async () => (calls.push("claim"), { kind: "idle", retryAfter: 60 }),
        heartbeatRunnerRun: async () => (calls.push("heartbeat"), { verdict: "ok", leaseExpiresAt: new Date(Date.now() + 60_000) }),
        ingestRunnerEvents: async () => (calls.push("events"), { outcome: "accepted", stored: 0, duplicates: 0, leaseExpiresAt: new Date(Date.now() + 60_000) }),
        gitTicketContext: async () => (calls.push("ticket"), (() => { throw new Error("not reached"); })()),
        signGitTicket: async () => (calls.push("ticket"), (() => { throw new Error("not reached"); })()),
      } as unknown as RunnerLeaseOps;
      const deps = h.deps({ leases });
      const asks = [
        () => respond(() => claimRun(deps, signed(key, CLAIM_PATH, {}))),
        () => respond(() => heartbeatRun(deps, signed(key, HEARTBEAT_PATH, { run_id: runId, lease_generation: 1 }))),
        () => respond(() => ingestEvents(deps, signed(key, eventsPath(runId), { run_id: runId, lease_generation: 1, events: [] }), runId)),
        () => respond(() => gitTicketRun(deps, signed(key, GIT_TICKET_PATH, { run_id: runId, lease_generation: 1 }))),
      ];
      const resolve = async () => (await h.admin.query("SELECT verdict FROM resolve_runner_git_request($1, $2, $3, 1, $4, false)", [id, f.accountId, runId, repo])).rows[0].verdict;
      // Before: the same signed requests reach the worker, so the 401s below are the removal and nothing else.
      expect((await asks[0]!()).status).toBe(200);
      expect((await asks[1]!()).status).toBe(200);
      expect(await resolve()).toBe("ok");
      expect((await remove(f, f.m1, id, recorder().fail)).status).toBe(200);
      calls.length = 0;
      for (const res of await Promise.all(asks.map((ask) => ask()))) expect(res).toMatchObject({ status: 401, body: { error: { code: "unauthorized" } } });
      expect(calls).toEqual([]);
      expect(await resolve()).toBe("revoked");
    });
  });

  describe("an audit row for every action", () => {
    it("writes one row per settings action, by the caller, in the transaction of the change", async () => {
      const f = await fresh();
      const id = await runner(f, f.m1);
      await act(f, f.m1, id, "rename", { name: "Ada's laptop" });
      await act(f, f.m1, id, "rename", { name: "Ada's desk" });
      await act(f, f.o1, id, "labels", { labels: ["gpu"] });
      await act(f, f.o1, id, "rank", { rank: 3 });
      await act(f, f.m1, id, "pause");
      await act(f, f.m1, id, "drain");
      await act(f, f.m1, id, "resume");
      expect((await auditRows(f, "runner.renamed")).map((r) => [r.actor, r.payload.name, r.payload.previous_name])).toEqual([[f.m1, "Ada's laptop", null], [f.m1, "Ada's desk", "Ada's laptop"]]);
      expect(await auditRows(f, "runner.labels_set")).toEqual([{ actor: f.o1, payload: { runner_id: id, registered_by: f.m1, labels: ["gpu"] } }]);
      expect(await auditRows(f, "runner.rank_set")).toEqual([{ actor: f.o1, payload: { runner_id: id, registered_by: f.m1, rank: 3 } }]);
      expect(await auditRows(f, "runner.paused")).toEqual([{ actor: f.m1, payload: { runner_id: id, registered_by: f.m1 } }]);
      expect(await auditRows(f, "runner.drain_started")).toEqual([{ actor: f.m1, payload: { runner_id: id, registered_by: f.m1 } }]);
      expect(await auditRows(f, "runner.resumed")).toEqual([{ actor: f.m1, payload: { runner_id: id, registered_by: f.m1, ended_pause: true, ended_drain: true } }]);
    });

    it("writes none for a refused action", async () => {
      const f = await fresh();
      const id = await runner(f, f.m1);
      await act(f, f.m2, id, "pause");
      await act(f, f.m1, id, "rename", { name: "bad\u0007" });
      expect((await h.admin.query("SELECT count(*)::int AS n FROM audit_log WHERE account_id = $1 AND action LIKE 'runner.%'", [f.accountId])).rows[0].n).toBe(0);
    });

    it("platform_ops cannot call either function and the app role cannot write the audit table itself", async () => {
      const f = await fresh();
      const id = await runner(f, f.m1);
      const ops = await h.opsPool.connect();
      try {
        await expect(ops.query("SELECT runner_repos_set($1, '{}'::uuid[])", [id])).rejects.toMatchObject({ code: "42501" });
        await expect(ops.query("SELECT runner_settings_apply($1, 'pause', NULL, NULL, NULL)", [id])).rejects.toMatchObject({ code: "42501" });
      } finally {
        ops.release();
      }
      await expect(h.appPool.query("INSERT INTO audit_log (account_id, actor, action, payload) VALUES ($1, 'x', 'runner.paused', '{}')", [f.accountId])).rejects.toMatchObject({ code: "42501" });
    });
  });
});
