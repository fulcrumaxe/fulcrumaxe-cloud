import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { ENGINE_LEASE_CAPABILITY, ENGINE_LEASE_HELLO_CAPABILITY, ENGINE_LEASE_RETRY_AFTER_MAX_SECONDS, MACHINE_ONBOARDING_MIN_PROTOCOL, signMachineJob, type MachineJob } from "@fulcrumaxe/runner-protocol";
import { CLAIM_PATH, HEARTBEAT_PATH, HELLO_PATH, claimRun, clampRetryAfter, heartbeatRun, runnerHello, runnersTakeEngineLease, type RunnerCloudDeps, type RunnerLeaseOps } from "../src/index.js";
import { harness, newKey, registerKey, respond, signed, type Harness, type TestKey } from "./helpers.js";

const HEAD = "a".repeat(40);
const RUN = "11111111-1111-4111-8111-111111111111";
const HELLO = { protocol_version: MACHINE_ONBOARDING_MIN_PROTOCOL, binary_version: "0.5.0", model_auth_present: true, isolation: "host_sandbox" };
const vm = (gh: number, state = "running") => ({ name: `fx-engine-${gh}`, state, created_at: "2026-11-24T10:00:00Z", last_used_at: null, disk_bytes: 2048, snapshot_count: 0, snapshot_age_s: null });

/**
 * [pg] D#845 ON-13c3 (migration 1092): the engine session lease. `engine_lease_renew` is run as the runner's own session, with row security forced, and writes only when every condition holds (the account's repo, placed on
 * THIS runner, operated, plan not ended, a start delivered or done, and that start's signed epoch is the current one). The routes (hello, claim, heartbeat) are the real ones; the lease worker is a stand-in.
 */
describe("engine session lease [pg]", () => {
  let h: Harness;
  const keys = generateKeyPairSync("ed25519");
  const signer = { signMachineJob: (job: MachineJob) => signMachineJob(job, "job-key-1", keys.privateKey) };
  const held = true;
  let nextGh = 500_000;
  const leases = {
    claimRunnerRun: async () => ({ kind: "idle" as const, retryAfter: 60 }),
    heartbeatRunnerRun: async () => (held ? { leaseExpiresAt: new Date("2026-11-24T12:01:30.000Z") } : { reason: "stale_generation" as const }),
  } as unknown as RunnerLeaseOps;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  interface Rig { who: SeedRefs; key: TestKey; runnerId: string; ghRepoId: number }
  /** A fresh account with one repo placed on one machine, an engine plan of one, watch and operate on (epoch 1), the repo ticked and a start delivered at epoch 1; each can be turned off. */
  async function rig(o: { operate?: boolean; tick?: boolean; plan?: number; start?: string | null; place?: boolean; declare?: boolean; protocol?: number } = {}): Promise<Rig> {
    const who = await seedAccount(h.admin, randomUUID());
    // every seeded repo has the same GitHub id, so each rig takes its own: a name that fits two accounts would hide a missing account predicate
    const ghRepoId = (nextGh += 1);
    await h.admin.query("UPDATE repos SET gh_repo_id = $2 WHERE id = $1", [who.repoId, ghRepoId]);
    const key = newKey();
    const runnerId = await registerKey(h.admin, who.accountId, who.userId, key);
    await h.admin.query("UPDATE runners SET protocol_version = $2 WHERE id = $1", [runnerId, o.protocol ?? MACHINE_ONBOARDING_MIN_PROTOCOL]);
    if (o.place !== false) await h.admin.query("INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')", [who.repoId, who.accountId, runnerId]);
    await h.admin.query("UPDATE accounts SET engine_quantity = $2, stripe_subscription_status = 'active' WHERE id = $1", [who.accountId, o.plan ?? 1]);
    await h.admin.query("INSERT INTO engine_bridge_settings (account_id, watch_enabled, operate_enabled) VALUES ($1, true, $2)", [who.accountId, o.operate !== false]);
    if (o.tick !== false) await h.admin.query("INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)", [who.accountId, who.repoId]);
    const r = { who, key, runnerId, ghRepoId };
    if (o.start !== null) await start(r, o.start ?? "delivered");
    if (o.declare !== false) await declare(r, o.protocol ?? MACHINE_ONBOARDING_MIN_PROTOCOL);
    return r;
  }
  /** The stored capability list of the runner's latest hello (the claim and heartbeat routes read it, never the message). */
  const declare = (r: Rig, protocol: number) =>
    h.admin.query("INSERT INTO runner_capabilities (runner_id, account_id, capabilities) VALUES ($1, $2, $3) ON CONFLICT (runner_id) DO UPDATE SET capabilities = EXCLUDED.capabilities", [r.runnerId, r.who.accountId, protocol >= MACHINE_ONBOARDING_MIN_PROTOCOL ? [ENGINE_LEASE_HELLO_CAPABILITY] : []]);
  /** A start row as machine_job_issue would write it, signed at `epoch`. */
  async function start(r: Rig, state: string, o: { epoch?: number; ago?: number; repoId?: string; runnerId?: string; ghRepoId?: number; stop?: boolean } = {}): Promise<string> {
    const id = randomUUID();
    const issued = new Date(Date.now() - (o.ago ?? 60_000));
    const expires = new Date(issued.getTime() + 25 * 60_000);
    const runnerId = o.runnerId ?? r.runnerId;
    const job = signer.signMachineJob({ v: 1, job_id: id, runner_id: runnerId, repo_gh_id: o.ghRepoId ?? r.ghRepoId, requires_engine: "any", issued_at: issued.toISOString(), expires_at: expires.toISOString(), kind: o.stop === true ? "engine_session_stop" : "engine_session_start", args: o.stop === true ? { reason: "person", operate_epoch: o.epoch ?? 1 } : { at_sha: HEAD, resume: false, operate_epoch: o.epoch ?? 1 } } as MachineJob);
    await h.admin.query(
      "INSERT INTO machine_jobs (id, account_id, runner_id, repo_id, kind, job, state, issued_at, expires_at, delivered_at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)",
      [id, r.who.accountId, runnerId, o.repoId ?? r.who.repoId, o.stop === true ? "engine_session_stop" : "engine_session_start", JSON.stringify(job), state, issued, expires, state === "issued" ? null : issued],
    );
    return id;
  }
  /** The renew function as a runner's own session calls it: app_user, the account and the runner named in the session. */
  async function renew(accountId: string, runnerId: string, names: string[]): Promise<Array<{ o_repo_gh_id: string; o_epoch: number; o_until: Date }>> {
    const c: PoolClient = await h.appPool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.account_id', $1, true), set_config('app.runner_id', $2, true)", [accountId, runnerId]);
      const { rows } = await c.query("SELECT * FROM engine_lease_renew($1::text[])", [names]);
      await c.query("COMMIT");
      return rows;
    } catch (error) {
      await c.query("ROLLBACK");
      throw error;
    } finally {
      c.release();
    }
  }
  const mine = (r: Rig, names: string[] = [`fx-engine-${r.ghRepoId}`]) => renew(r.who.accountId, r.runnerId, names);
  const stored = async (accountId: string) => (await h.admin.query<{ repo_id: string; runner_id: string; operate_epoch: number; ttl: number }>("SELECT repo_id, runner_id, operate_epoch, EXTRACT(EPOCH FROM (expires_at - renewed_at))::int AS ttl FROM engine_session_leases WHERE account_id = $1", [accountId])).rows;
  const code = async (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string; message?: string }) => e.code ?? `error:${e.message}`);

  describe("engine_lease_renew", () => {
    it("renews a running session of a placed, operated repo with a delivered start: 15 minutes, the start's epoch, and answers the lease", async () => {
      const r = await rig();
      const got = await mine(r);
      expect(got).toHaveLength(1);
      expect(Number(got[0]!.o_repo_gh_id)).toBe(r.ghRepoId);
      expect(got[0]!.o_epoch).toBe(1);
      expect(got[0]!.o_until.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
      expect(await stored(r.who.accountId)).toEqual([{ repo_id: r.who.repoId, runner_id: r.runnerId, operate_epoch: 1, ttl: 900 }]);
    });

    it("a start that is done renews too, and a second report moves the end, never adds a row", async () => {
      const r = await rig({ start: "done" });
      await mine(r);
      await h.admin.query("UPDATE engine_session_leases SET expires_at = now() + interval '1 minute' WHERE account_id = $1", [r.who.accountId]);
      const again = await mine(r);
      expect(again).toHaveLength(1);
      expect(again[0]!.o_until.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
      expect(await stored(r.who.accountId)).toHaveLength(1);
    });

    it("a report that names nothing running renews nothing, and still answers the lease already held", async () => {
      const r = await rig();
      expect(await mine(r, [])).toEqual([]);
      expect(await stored(r.who.accountId)).toEqual([]);
      await mine(r);
      expect(await mine(r, [])).toHaveLength(1);
    });

    it("an expired lease is not answered", async () => {
      const r = await rig();
      await mine(r);
      await h.admin.query("UPDATE engine_session_leases SET expires_at = now() - interval '1 second' WHERE account_id = $1", [r.who.accountId]);
      expect(await mine(r, [])).toEqual([]);
    });

    const refused: Array<[string, () => Promise<Rig>]> = [
      ["the repo is not placed on any machine", () => rig({ place: false })],
      ["operate is off", () => rig({ operate: false })],
      ["the repo is not ticked", () => rig({ tick: false })],
      ["the plan ended", () => rig({ plan: 1 }).then(async (r) => (await h.admin.query("UPDATE accounts SET stripe_subscription_status = 'canceled', subscription_ended_at = now() WHERE id = $1", [r.who.accountId]), r))],
      ["no start was ever issued", () => rig({ start: null })],
      ["the only start is still issued", () => rig({ start: "issued" })],
      ["the only start was superseded", () => rig({ start: "superseded" })],
      ["the only start failed", () => rig({ start: "failed" })],
    ];
    for (const [name, make] of refused) {
      it(`writes nothing when ${name}`, async () => {
        const r = await make();
        expect(await mine(r)).toEqual([]);
        expect(await stored(r.who.accountId)).toEqual([]);
      });
    }

    it("writes nothing when the epoch moved after the start (operate switched off and on again)", async () => {
      const r = await rig();
      await h.admin.query("UPDATE engine_bridge_settings SET operate_enabled = false WHERE account_id = $1", [r.who.accountId]);
      await h.admin.query("UPDATE engine_bridge_settings SET operate_enabled = true WHERE account_id = $1", [r.who.accountId]);
      expect((await h.admin.query<{ operate_epoch: number }>("SELECT operate_epoch FROM engine_bridge_settings WHERE account_id = $1", [r.who.accountId])).rows[0]!.operate_epoch).toBe(3);
      expect(await mine(r)).toEqual([]);
      expect(await stored(r.who.accountId)).toEqual([]);
      // a start signed at the new epoch renews again, and the newest delivered start is the one that counts
      await start(r, "done", { epoch: 3, ago: 1000 });
      expect((await mine(r))[0]!.o_epoch).toBe(3);
    });

    it("the newest delivered start decides: an older one at the current epoch does not save a newer one at another", async () => {
      const r = await rig();
      await start(r, "done", { epoch: 7, ago: 1000 });
      expect(await mine(r)).toEqual([]);
    });

    it("a wrong runner writes nothing: another machine of the same account, with the repo placed elsewhere", async () => {
      const r = await rig();
      const other = newKey();
      const otherRunner = await registerKey(h.admin, r.who.accountId, r.who.userId, other);
      expect(await renew(r.who.accountId, otherRunner, [`fx-engine-${r.ghRepoId}`])).toEqual([]);
      expect(await stored(r.who.accountId)).toEqual([]);
      // and a start that was delivered to the other machine does not count for this one
      const moved = await rig();
      await h.admin.query("DELETE FROM machine_jobs WHERE account_id = $1", [moved.who.accountId]);
      const again = newKey();
      const elsewhere = await registerKey(h.admin, moved.who.accountId, moved.who.userId, again);
      await start(moved, "delivered", { runnerId: elsewhere });
      expect(await mine(moved)).toEqual([]);
    });

    it("a wrong runner with a start of its own for the repo still writes nothing: the placement is on the other machine", async () => {
      const r = await rig();
      const other = await registerKey(h.admin, r.who.accountId, r.who.userId, newKey());
      await start(r, "done", { runnerId: other, ago: 1000 });
      expect(await renew(r.who.accountId, other, [`fx-engine-${r.ghRepoId}`])).toEqual([]);
      expect(await stored(r.who.accountId)).toEqual([]);
    });

    it("a start of another repo of the same machine, or a stop of this one, is not this repo's start", async () => {
      const r = await rig({ start: null });
      const second = randomUUID();
      await h.admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) SELECT $1, account_id, installation_id, gh_repo_id + 9000, product FROM repos WHERE id = $2", [second, r.who.repoId]);
      await start(r, "delivered", { repoId: second, ghRepoId: r.ghRepoId + 9000 });
      expect(await mine(r)).toEqual([]);
      await start(r, "done", { stop: true, ago: 1000 });
      expect(await mine(r)).toEqual([]);
      expect(await stored(r.who.accountId)).toEqual([]);
    });

    it("the answer is the asking runner's own leases: another machine of the account is told nothing, and a repo moved to it takes the lease over", async () => {
      const r = await rig();
      await mine(r);
      const other = await registerKey(h.admin, r.who.accountId, r.who.userId, newKey());
      expect(await renew(r.who.accountId, other, [])).toEqual([]);
      // the repo is placed on the other machine, which holds a start of its own: its renewal takes the row over, and the first machine no longer hears of it
      await h.admin.query("UPDATE project_placements SET runner_id = $2 WHERE account_id = $1 AND repo_id = $3", [r.who.accountId, other, r.who.repoId]);
      await start(r, "done", { runnerId: other, ago: 1000 });
      expect(await renew(r.who.accountId, other, [`fx-engine-${r.ghRepoId}`])).toHaveLength(1);
      expect((await stored(r.who.accountId)).map((x) => x.runner_id)).toEqual([other]);
      expect(await mine(r, [])).toEqual([]);
    });

    it("a foreign account writes nothing: its runner names the other account's repo, and the other account's session names this runner", async () => {
      const a = await rig();
      const b = await rig();
      expect(await renew(b.who.accountId, b.runnerId, [`fx-engine-${a.ghRepoId}`])).toEqual([]);
      expect(await stored(a.who.accountId)).toEqual([]);
      expect(await stored(b.who.accountId)).toEqual([]);
      // a session that names the account of A with the runner of B is not a live runner of that account
      expect(await code(renew(a.who.accountId, b.runnerId, [`fx-engine-${a.ghRepoId}`]))).toBe("42501");
      expect(await stored(a.who.accountId)).toEqual([]);
      // the lease is read through the RLS-bypassing client with a foreign account id: nothing there
      await mine(a);
      expect((await h.admin.query("SELECT 1 FROM engine_session_leases WHERE account_id = $1", [b.who.accountId])).rows).toEqual([]);
      expect(await renew(b.who.accountId, b.runnerId, [])).toEqual([]);
    });

    it("a second repo of the same account that is not reported is not renewed, and a reported one that is not placed here is not either", async () => {
      const r = await rig();
      const second = randomUUID();
      await h.admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) SELECT $1, account_id, installation_id, gh_repo_id + 9000, product FROM repos WHERE id = $2", [second, r.who.repoId]);
      await h.admin.query("INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)", [r.who.accountId, second]);
      await start(r, "done", { repoId: second, ghRepoId: r.ghRepoId + 9000 });
      const got = await mine(r);
      expect(got.map((x) => Number(x.o_repo_gh_id))).toEqual([r.ghRepoId]);
      // reported but never placed on this machine
      expect(await mine(r, [`fx-engine-${r.ghRepoId + 9000}`])).toHaveLength(1);
      expect((await stored(r.who.accountId)).map((x) => x.repo_id)).toEqual([r.who.repoId]);
    });

    it("names that are not an engine session's are ignored, and more than 200 are refused", async () => {
      const r = await rig();
      expect(await mine(r, ["fx-engine-0", "fx-engine-x", `job-${r.ghRepoId}`, `fx-engine-${r.ghRepoId}-extra`, "fx-engine-01"])).toEqual([]);
      expect(await code(mine(r, Array.from({ length: 201 }, (_, i) => `fx-engine-${i + 1}`)))).toBe("22023");
      expect(await stored(r.who.accountId)).toEqual([]);
    });

    it("refuses a session that is no runner, a revoked runner and a platform_ops login", async () => {
      const r = await rig();
      const c = await h.appPool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.account_id', $1, true)", [r.who.accountId]);
        expect(await code(c.query("SELECT * FROM engine_lease_renew('{}')"))).toBe("42501");
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
      await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [r.runnerId]);
      expect(await code(mine(r))).toBe("42501");
      expect(await code(h.opsPool.query("SELECT * FROM engine_lease_renew('{}')"))).toBe("42501");
    });

    it("refuses a soft-deleted account: nothing is written and the call is refused, as runner_capabilities_record does", async () => {
      const r = await rig();
      expect(await mine(r)).toHaveLength(1);
      await h.admin.query("DELETE FROM engine_session_leases WHERE account_id = $1", [r.who.accountId]);
      await h.admin.query("UPDATE accounts SET deleted_at = now() WHERE id = $1", [r.who.accountId]);
      expect(await code(mine(r))).toBe("42501");
      expect(await code(mine(r, []))).toBe("42501");
      expect(await stored(r.who.accountId)).toEqual([]);
    });

    it("is executable by the runner login alone, and the definer reads nothing outside the session's account", async () => {
      const acl = (await h.admin.query<{ app: boolean; ops: boolean; pub: boolean; owner: string; secdef: boolean; config: string[] }>(
        `SELECT has_function_privilege('app_user', p.oid, 'EXECUTE') AS app, has_function_privilege('platform_ops', p.oid, 'EXECUTE') AS ops, has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
                pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS secdef, p.proconfig AS config FROM pg_proc p WHERE p.proname = 'engine_lease_renew'`)).rows;
      expect(acl).toEqual([{ app: true, ops: false, pub: false, owner: "engine_lease_definer", secdef: true, config: ["search_path=pg_catalog, public, pg_temp"] }]);
      // the role sees no row of another account: with no session account every read is empty, and it holds no column beyond the ones it needs
      const c = await h.adminPool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SET LOCAL ROLE engine_lease_definer");
        for (const table of ["accounts", "runners", "repos", "project_placements", "engine_bridge_settings", "machine_jobs", "engine_session_leases"]) {
          expect((await c.query(`SELECT 1 FROM ${table}`)).rows, table).toEqual([]);
        }
        for (const sql of ["SELECT stripe_customer_id FROM accounts", "SELECT registered_by FROM runners", "SELECT gh_owner FROM repos", "SELECT last_seq FROM machine_jobs"]) {
          await c.query("SAVEPOINT p");
          expect(await code(c.query(sql)), sql).toBe("42501");
          await c.query("ROLLBACK TO SAVEPOINT p");
        }
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
    });
  });

  describe("the routes", () => {
    const hello = (key: TestKey, body: Record<string, unknown>) => respond(() => runnerHello(h.deps(), signed(key, HELLO_PATH, { ...HELLO, ...body })));
    const caps = async (r: Rig, body: Record<string, unknown>) => ((await hello(r.key, body)).body as { capabilities?: string[] }).capabilities;
    const open = (r: Rig) => h.admin.query("UPDATE runner_claim_stamps SET last_claim_at = now() - interval '1 hour' WHERE runner_id = $1", [r.runnerId]);
    const claim = async (r: Rig, body: unknown, over: Partial<RunnerCloudDeps> = {}) => {
      await open(r);
      return respond(() => claimRun(h.deps({ leases, ...over }), signed(r.key, CLAIM_PATH, body)));
    };
    const beat = (r: Rig, body: Record<string, unknown> = {}) => respond(() => heartbeatRun(h.deps({ leases }), signed(r.key, HEARTBEAT_PATH, { run_id: RUN, lease_generation: 1, ...body })));

    it("the hello lists engine_lease only to a runner that declared it at protocol 22, on a database that has the function", async () => {
      const r = await rig({ declare: false });
      expect(await caps(r, { capabilities: [ENGINE_LEASE_HELLO_CAPABILITY] })).toEqual([ENGINE_LEASE_CAPABILITY]);
      expect(await caps(r, { capabilities: [] })).toBeUndefined();
      expect(await caps(r, {})).toBeUndefined();
      expect(await hello(r.key, { protocol_version: MACHINE_ONBOARDING_MIN_PROTOCOL - 1, capabilities: [ENGINE_LEASE_HELLO_CAPABILITY] })).toMatchObject({ status: 400, body: { error: { code: "invalid_message" } } });
      expect((await h.admin.query<{ capabilities: string[] }>("SELECT capabilities FROM runner_capabilities WHERE runner_id = $1", [r.runnerId])).rows[0]!.capabilities).toEqual([]);
    });

    it("a catalog read that fails, or finds no function, lists nothing", async () => {
      const failing = { query: async () => Promise.reject(new Error("down")) } as unknown as RunnerCloudDeps["appUserPool"];
      const none = { query: async () => ({ rows: [{ ok: false }] }) } as unknown as RunnerCloudDeps["appUserPool"];
      expect(await runnersTakeEngineLease(h.deps({ appUserPool: failing }))).toBe(false);
      expect(await runnersTakeEngineLease(h.deps({ appUserPool: none }))).toBe(false);
      expect(await runnersTakeEngineLease(h.deps())).toBe(true);
    });

    it("a claim that reports the session running renews it, answers engine_lease, and clamps retry_after to 300 s or less", async () => {
      const r = await rig();
      const res = await claim(r, { sandboxes: [vm(r.ghRepoId)] });
      expect(res.status).toBe(200);
      const body = res.body as { retry_after: number; engine_lease: { repo_gh_id: number; operate_epoch: number; until: string } };
      expect(body.engine_lease).toMatchObject({ repo_gh_id: r.ghRepoId, operate_epoch: 1 });
      expect(Date.parse(body.engine_lease.until) - Date.now()).toBeGreaterThan(14 * 60_000);
      expect(body.retry_after).toBeLessThanOrEqual(ENGINE_LEASE_RETRY_AFTER_MAX_SECONDS);
      const slow = { claimRunnerRun: async () => ({ kind: "idle" as const, retryAfter: 900 }) } as unknown as RunnerLeaseOps;
      const long = await claim(r, { sandboxes: [vm(r.ghRepoId)] }, { leases: slow });
      expect(long.body).toMatchObject({ retry_after: ENGINE_LEASE_RETRY_AFTER_MAX_SECONDS });
      expect(long.headers?.["retry-after"]).toBe(String(ENGINE_LEASE_RETRY_AFTER_MAX_SECONDS));
      expect(await stored(r.who.accountId)).toHaveLength(1);
    });

    it("the next claim carries no inventory: the held lease is read back, not renewed", async () => {
      const r = await rig();
      await claim(r, { sandboxes: [vm(r.ghRepoId)] });
      await h.admin.query("UPDATE engine_session_leases SET expires_at = now() + interval '5 minutes', renewed_at = now() - interval '10 minutes' WHERE account_id = $1", [r.who.accountId]);
      const res = await claim(r, {});
      const until = Date.parse((res.body as { engine_lease: { until: string } }).engine_lease.until);
      expect(until - Date.now()).toBeLessThan(5 * 60_000 + 5_000);
    });

    it("the clamp leaves a shorter answer alone and a runner with no lease unclamped", async () => {
      expect(clampRetryAfter(60, { repo_gh_id: 1, operate_epoch: 1, until: "2026-11-24T12:00:00.000Z" })).toBe(60);
      expect(clampRetryAfter(900, { repo_gh_id: 1, operate_epoch: 1, until: "2026-11-24T12:00:00.000Z" })).toBe(300);
      expect(clampRetryAfter(900, null)).toBe(900);
      const r = await rig({ start: null });
      const slow = { claimRunnerRun: async () => ({ kind: "idle" as const, retryAfter: 900 }) } as unknown as RunnerLeaseOps;
      const res = await claim(r, { sandboxes: [vm(r.ghRepoId)] }, { leases: slow });
      expect(res.body).toEqual({ retry_after: 900 });
    });

    it("a runner that did not declare it is neither renewed nor told: the reply is the plain one", async () => {
      const r = await rig({ declare: false });
      const res = await claim(r, { sandboxes: [vm(r.ghRepoId)] });
      expect(res.body).toEqual({ retry_after: 60 });
      expect(await stored(r.who.accountId)).toEqual([]);
      expect((await beat(r, { sandboxes: [vm(r.ghRepoId)] })).body).toEqual({ continue: true, lease_expires_at: "2026-11-24T12:01:30.000Z", sandboxes_recorded: true });
      expect(await stored(r.who.accountId)).toEqual([]);
    });

    it("a stopped session, or one that the cloud no longer allows, is not renewed and a claim answers no lease", async () => {
      const r = await rig();
      const res = await claim(r, { sandboxes: [vm(r.ghRepoId, "stopped")] });
      expect(res.body).toEqual({ retry_after: 60 });
      await h.admin.query("UPDATE engine_bridge_settings SET operate_enabled = false WHERE account_id = $1", [r.who.accountId]);
      expect((await claim(r, { sandboxes: [vm(r.ghRepoId)] })).body).toEqual({ retry_after: 60 });
      expect(await stored(r.who.accountId)).toEqual([]);
    });

    it("a heartbeat that carries the inventory renews and answers engine_lease; one that does not, only reads it back", async () => {
      const r = await rig();
      const res = await beat(r, { sandboxes: [vm(r.ghRepoId)] });
      expect(res).toMatchObject({ status: 200, body: { continue: true, sandboxes_recorded: true, engine_lease: { repo_gh_id: r.ghRepoId, operate_epoch: 1 } } });
      const plain = await beat(r);
      expect(plain).toMatchObject({ status: 200, body: { engine_lease: { repo_gh_id: r.ghRepoId } } });
      expect((plain.body as { sandboxes_recorded?: true }).sandboxes_recorded).toBeUndefined();
    });

    it("a lease call that fails costs the lease answer and nothing else: the heartbeat keeps the run and the claim keeps its transaction (the inventory is still stored)", async () => {
      const r = await rig();
      await h.admin.query("REVOKE EXECUTE ON FUNCTION engine_lease_renew(text[]) FROM app_user");
      try {
        const res = await beat(r, { sandboxes: [vm(r.ghRepoId)] });
        expect(res).toEqual({ status: 200, body: { continue: true, lease_expires_at: "2026-11-24T12:01:30.000Z", sandboxes_recorded: true } });
        expect((await claim(r, { sandboxes: [vm(r.ghRepoId), vm(r.ghRepoId + 1)] })).body).toEqual({ retry_after: 60 });
        expect((await h.admin.query("SELECT name FROM runner_sandboxes WHERE runner_id = $1", [r.runnerId])).rows).toHaveLength(2);
      } finally {
        await h.admin.query("GRANT EXECUTE ON FUNCTION engine_lease_renew(text[]) TO app_user");
      }
    });
  });
});
