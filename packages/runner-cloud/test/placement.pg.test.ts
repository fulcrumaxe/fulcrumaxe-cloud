import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@fx/db/src/withTenant.js";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import {
  ENGINE_EVENTS_PATH,
  RunnerHttpError,
  autoPlaceProject,
  ingestEngineEvents,
  moveProject,
  placeProject,
  readMachineCapacity,
  toResponse,
  type EngineCoverageCheck,
} from "../src/index.js";
import { harness, newKey, signed, type Harness, type TestKey } from "./helpers.js";

/**
 * [pg] D#845 MC-9: placement and move on real Postgres with row security forced. One engine per machine is held by the database's unique index, so the race tests run
 * several tenant transactions at once and assert that exactly the right ones win and that no half state is left. Every query names its account; the foreign-account
 * and second-repo cases pin that.
 */
describe("placing and moving a project [pg]", () => {
  let h: Harness;
  let f: F2Fixture;
  let other: F2Fixture;
  let ghSeq = 7_700_000 + Math.floor(Math.random() * 100_000);

  type Tx<T> = (client: PoolClient) => Promise<T>;
  const as = <T>(user: string, fn: Tx<T>, account = f.accountId): Promise<T> => withTenant(h.appPool, account, user, fn);
  const owner = <T>(fn: Tx<T>): Promise<T> => as(f.o1, fn);
  const actor = { accountId: "", userId: "" };

  async function repo(account = f.accountId, name = `r${ghSeq}`): Promise<string> {
    const id = randomUUID();
    await h.admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) VALUES ($1, $2, $3, 'team', 'acme', $4, 'runner_local')`, [id, account, ++ghSeq, name]);
    return id;
  }

  /** A live machine that reported what the options say. By default it is eligible. */
  async function machine(o: { account?: F2Fixture; name?: string; engine?: "microvm" | "os_sandbox"; mem?: number | null; disk?: number; claude?: boolean | null; live?: boolean; revoked?: boolean; key?: TestKey; paused?: boolean; draining?: boolean; loadAgeS?: number } = {}): Promise<string> {
    const a = o.account ?? f;
    const id = await insertRunner(h.admin, a.accountId, a.o1, o.key ? { jwk: o.key.jwk, jkt: o.key.jkt } : {});
    await h.admin.query(`UPDATE runners SET protocol_version = 22, model_auth_present = $2, last_seen_at = now() - $3::interval WHERE id = $1`, [id, o.claude === undefined ? true : o.claude, o.live === false ? "1 hour" : "0 seconds"]);
    if (o.revoked) await h.admin.query(`UPDATE runners SET revoked_at = now() WHERE id = $1`, [id]);
    await h.admin.query(`INSERT INTO runner_facts (runner_id, account_id, os, arch, mem_gb_bucket, cpus, sandbox_engine) VALUES ($1, $2, 'linux', 'x64', 16, 8, $3)`, [id, a.accountId, o.engine ?? "microvm"]);
    if (o.mem !== null) await h.admin.query(`UPDATE runner_facts SET host_mem_avail_mb = $2, host_disk_free_mb = $3, host_setups_running = 0, host_load_at = now() - make_interval(secs => $4) WHERE runner_id = $1`, [id, o.mem ?? 9000, o.disk ?? 50000, o.loadAgeS ?? 0]);
    if (o.name || o.paused || o.draining) await h.admin.query(`INSERT INTO runner_settings (runner_id, account_id, name, paused_at, draining) VALUES ($1, $2, $3, $4, $5)`, [id, a.accountId, o.name ?? null, o.paused ? new Date() : null, o.draining === true]);
    return id;
  }

  const place = (repoId: string, runnerId: string, user = f.o1, extra: { engineCoverage?: EngineCoverageCheck } = {}) =>
    as(user, (c) => placeProject(c, { accountId: f.accountId, userId: user }, { repoId, runnerId, ...extra }));
  const move = (repoId: string, toRunnerId: string, o: { user?: string; carryState?: boolean } = {}) =>
    as(o.user ?? f.o1, (c) => moveProject(c, { accountId: f.accountId, userId: o.user ?? f.o1 }, { repoId, toRunnerId, carryState: o.carryState }));
  const placements = async (account = f.accountId) => (await h.admin.query<{ repo_id: string; runner_id: string; placed_by: string }>(`SELECT repo_id, runner_id, placed_by FROM project_placements WHERE account_id = $1`, [account])).rows;
  const at = async (runnerId: string) => (await h.admin.query<{ repo_id: string }>(`SELECT repo_id FROM project_placements WHERE runner_id = $1`, [runnerId])).rows.map((r) => r.repo_id);
  const allowed = async (runnerId: string) => (await h.admin.query<{ a: string[] }>(`SELECT allowed_repo_ids AS a FROM runners WHERE id = $1`, [runnerId])).rows[0]!.a;
  const grant = (runnerId: string, repoId: string) => h.admin.query(`UPDATE runners SET allowed_repo_ids = array_append(allowed_repo_ids, $2::uuid) WHERE id = $1`, [runnerId, repoId]);
  const code = async (p: Promise<unknown>): Promise<string | number> => {
    try {
      await p;
      return "ok";
    } catch (error) {
      return error instanceof RunnerHttpError ? `${error.status} ${error.code}` : String((error as Error).message);
    }
  };

  beforeAll(async () => {
    h = await harness();
    f = await seedF2(h.admin);
    other = await seedF2(h.admin);
    actor.accountId = f.accountId;
  });
  afterAll(() => h.close());

  describe("what each machine reports", () => {
    it("reads capacity per machine, names the project that holds one, and says why the others are not eligible", async () => {
      const r1 = await repo(f.accountId, "widgets");
      const r2 = await repo(f.accountId, "gadgets");
      const ok = await machine({ name: "ok" });
      const held = await machine({ name: "held" });
      await machine({ name: "quiet", live: false });
      await machine({ name: "noclaude", claude: null });
      await machine({ name: "small", mem: 1000 });
      await machine({ name: "paused", paused: true });
      await machine({ name: "draining", draining: true });
      await machine({ name: "stale", loadAgeS: 600 });
      const bare = await machine({ name: "bare", mem: null });
      await h.admin.query(`INSERT INTO project_placements (account_id, repo_id, runner_id, placed_by) VALUES ($1, $2, $3, 'person')`, [f.accountId, r1, held]);
      const all = await owner((c) => readMachineCapacity(c, f.accountId));
      const byName = new Map(all.map((m) => [m.name, m]));
      expect(byName.get("ok")).toMatchObject({ runner_id: ok, tier: "microvm", eligible: true, reason: null, mem_avail_mb: 9000, disk_free_mb: 50000, running: null });
      // The same account's SECOND repo is not what holds the machine: the name is the placed repo's.
      expect(byName.get("held")).toMatchObject({ reason: "has_project", running: { repo_id: r1, name: "acme/widgets" } });
      expect(JSON.stringify(all)).not.toContain(r2);
      expect(byName.get("quiet")).toMatchObject({ reason: "not_live", live: false });
      expect(byName.get("noclaude")).toMatchObject({ reason: "claude_not_ready", claude: false });
      expect(byName.get("small")).toMatchObject({ reason: "low_memory" });
      expect(byName.get("paused")).toMatchObject({ reason: "paused", paused: true });
      expect(byName.get("draining")).toMatchObject({ reason: "draining", draining: true });
      expect(byName.get("stale")).toMatchObject({ reason: "load_unknown" });
      expect(byName.get("stale")!.load_age_s).toBeGreaterThanOrEqual(600);
      expect(byName.get("ok")!.load_age_s).toBeLessThan(60);
      // What every real runner reports today (nothing), so it is never eligible: the honest state until a build sends host load.
      expect(byName.get("bare")).toMatchObject({ runner_id: bare, reason: "load_unknown", mem_avail_mb: null, disk_free_mb: null, eligible: false });
    });

    it("never lists another account's machine or placement, and a removed machine is not listed", async () => {
      const mine = await machine({ name: "mine-unique" });
      const theirs = await machine({ account: other, name: "theirs" });
      const gone = await machine({ name: "gone", revoked: true });
      const theirRepo = await repo(other.accountId);
      await h.admin.query(`INSERT INTO project_placements (account_id, repo_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')`, [other.accountId, theirRepo, theirs]);
      const ids = (await owner((c) => readMachineCapacity(c, f.accountId))).map((m) => m.runner_id);
      expect(ids).toContain(mine);
      expect(ids).not.toContain(theirs);
      expect(ids).not.toContain(gone);
      // The account predicate itself, through the client that bypasses row security: a foreign account id reads nothing of this account's.
      const foreign = await readMachineCapacity(h.admin, randomUUID());
      expect(foreign).toEqual([]);
      const asOther = await readMachineCapacity(h.admin, other.accountId);
      expect(asOther.map((m) => m.runner_id)).toEqual(expect.arrayContaining([theirs]));
      expect(asOther.map((m) => m.runner_id)).not.toContain(mine);
    });
  });

  describe("placing a project", () => {
    it("puts it on an eligible machine the person picked, and a second project on that machine is 409 machine_single_project", async () => {
      const m = await machine();
      const [r1, r2] = [await repo(), await repo()];
      await place(r1, m);
      expect(await placements().then((p) => p.find((x) => x.repo_id === r1))).toMatchObject({ runner_id: m, placed_by: "person" });
      expect(await code(place(r2, m))).toBe("409 machine_single_project");
      expect(await at(m)).toEqual([r1]);
    });

    it("refuses, with nothing written: a member, a repo or machine of another account, a machine that is not eligible, a repo that already has a machine", async () => {
      const m = await machine();
      const small = await machine({ mem: 100 });
      const r = await repo();
      expect(await code(place(r, m, f.m1))).toBe("403 forbidden");
      expect(await code(place(await repo(other.accountId), m))).toBe("404 not_found");
      expect(await code(place(r, await machine({ account: other })))).toBe("404 not_found");
      expect(await code(place(r, small))).toBe("409 machine_not_eligible");
      expect(await at(m)).toEqual([]);
      await place(r, m);
      expect(await code(place(r, await machine()))).toBe("409 project_already_placed");
    });

    it("asks the plan's coverage check first: its 402 engine_quantity passes through and nothing is written", async () => {
      const m = await machine();
      const r = await repo();
      const full: EngineCoverageCheck = async () => {
        throw new RunnerHttpError(402, "engine_quantity", "every engine you pay for is in use");
      };
      expect(await code(place(r, m, f.o1, { engineCoverage: full }))).toBe("402 engine_quantity");
      expect(await at(m)).toEqual([]);
      const seen: unknown[] = [];
      await place(r, m, f.o1, { engineCoverage: async (_c, i) => void seen.push(i) });
      expect(seen).toEqual([{ accountId: f.accountId, repoId: r }]);
    });

    it("RACE: two tenant transactions put different projects on one machine at once: exactly one wins, the other is 409, one row", async () => {
      const m = await machine();
      const [a, b] = [await repo(), await repo()];
      const results = await Promise.all([code(place(a, m)), code(place(b, m))]);
      expect(results.slice().sort()).toEqual(["409 machine_single_project", "ok"]);
      expect(await at(m)).toHaveLength(1);
    });

    it("RACE: twelve concurrent placements on four machines place exactly four, one per machine, and the rest are refused", async () => {
      const ms = await Promise.all([machine(), machine(), machine(), machine()]);
      const repos = await Promise.all(Array.from({ length: 12 }, () => repo()));
      const outcomes = await Promise.all(repos.map((r, i) => code(place(r, ms[i % 4]!))));
      expect(outcomes.filter((o) => o === "ok")).toHaveLength(4);
      expect(outcomes.filter((o) => o === "409 machine_single_project")).toHaveLength(8);
      for (const m of ms) expect(await at(m)).toHaveLength(1);
    });
  });

  describe("auto-placement", () => {
    it("takes the best eligible machine: microVM first, then the most free memory", async () => {
      const acct = await seedF2(h.admin);
      const ctx = (user: string, fn: Tx<string>) => withTenant(h.appPool, acct.accountId, user, fn);
      const r = randomUUID();
      await h.admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, 'team', 'acme', 'solo')`, [r, acct.accountId, ++ghSeq]);
      const std = await machine({ account: acct, engine: "os_sandbox", mem: 60000 });
      const vm = await machine({ account: acct, engine: "microvm", mem: 8000 });
      await machine({ account: acct, engine: "microvm", mem: 5000 });
      const picked = await ctx(acct.o1, (c) => autoPlaceProject(c, { accountId: acct.accountId, userId: acct.o1 }, { repoId: r }));
      expect(picked).toBe(vm);
      expect(picked).not.toBe(std);
      expect((await h.admin.query(`SELECT placed_by FROM project_placements WHERE repo_id = $1`, [r])).rows[0]).toEqual({ placed_by: "auto" });
    });

    it("answers 409 no_eligible_machine when none is eligible, and never auto-places on a machine that has not reported its load", async () => {
      const acct = await seedF2(h.admin);
      const r = randomUUID();
      await h.admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product) VALUES ($1, $2, $3, 'team')`, [r, acct.accountId, ++ghSeq]);
      await machine({ account: acct, mem: null });
      const run = () => withTenant(h.appPool, acct.accountId, acct.o1, (c) => autoPlaceProject(c, { accountId: acct.accountId, userId: acct.o1 }, { repoId: r }));
      expect(await code(run())).toBe("409 no_eligible_machine");
      expect((await h.admin.query(`SELECT 1 FROM project_placements WHERE account_id = $1`, [acct.accountId])).rows).toHaveLength(0);
    });

    it("RACE: five concurrent auto-placements over three machines place three on three different machines; the other two are refused", async () => {
      const acct = await seedF2(h.admin);
      const ms = await Promise.all([machine({ account: acct, mem: 9000 }), machine({ account: acct, mem: 8000 }), machine({ account: acct, mem: 7000 })]);
      const repos: string[] = [];
      for (let i = 0; i < 5; i++) {
        const id = randomUUID();
        await h.admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product) VALUES ($1, $2, $3, 'team')`, [id, acct.accountId, ++ghSeq]);
        repos.push(id);
      }
      const out = await Promise.all(repos.map((r) => withTenant(h.appPool, acct.accountId, acct.o1, (c) => autoPlaceProject(c, { accountId: acct.accountId, userId: acct.o1 }, { repoId: r })).then((m) => m, (e: unknown) => (e as RunnerHttpError).code)));
      expect(out.filter((o) => ms.includes(o))).toHaveLength(3);
      expect(new Set(out.filter((o) => ms.includes(o))).size).toBe(3);
      expect(out.filter((o) => o === "no_eligible_machine")).toHaveLength(2);
      const rows = (await h.admin.query(`SELECT runner_id FROM project_placements WHERE account_id = $1`, [acct.accountId])).rows;
      expect(rows).toHaveLength(3);
    });
  });

  describe("moving a project", () => {
    const GH = 9_100_000 + Math.floor(Math.random() * 100_000);
    const ingest = async (k: TestKey, instance: string) =>
      toResponse(() =>
        ingestEngineEvents(h.deps(), signed(k, ENGINE_EVENTS_PATH, {
          session: { engine_instance_id: instance, repo_gh_id: GH, engine_version: "1.2.3" },
          events: [{ v: 1, seq: 0, ts: "2026-11-16T10:00:00.000Z", kind: "merged", engine_instance_id: instance, pr: 1, closes: false }],
        })),
      );

    it("changes the placement, moves the repository between the two machines' lists, writes project.moved, and ingest then accepts only the new machine", async () => {
      const acct = await seedF2(h.admin);
      const [kOld, kNew] = [newKey(), newKey()];
      const oldM = await machine({ account: acct, key: kOld });
      const newM = await machine({ account: acct, key: kNew });
      const r = randomUUID();
      await h.admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) VALUES ($1, $2, $3, 'team', 'acme', 'moved', 'runner_local')`, [r, acct.accountId, GH]);
      await h.admin.query(`INSERT INTO engine_bridge_settings (account_id, watch_enabled) VALUES ($1, true) ON CONFLICT (account_id) DO UPDATE SET watch_enabled = true`, [acct.accountId]);
      await h.admin.query(`INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)`, [acct.accountId, r]);
      await h.admin.query(`UPDATE runners SET allowed_repo_ids = ARRAY[$2]::uuid[] WHERE id = $1`, [oldM, r]);
      await h.admin.query(`INSERT INTO project_placements (account_id, repo_id, runner_id, placed_by) VALUES ($1, $2, $3, 'auto')`, [acct.accountId, r, oldM]);
      expect((await ingest(kOld, randomUUID())).status).toBe(200);
      expect((await ingest(kNew, randomUUID())).body).toMatchObject({ error: "engine_repo_not_enabled" });

      const res = await withTenant(h.appPool, acct.accountId, acct.o1, (c) => moveProject(c, { accountId: acct.accountId, userId: acct.o1 }, { repoId: r, toRunnerId: newM }));
      expect(res).toEqual({ from_runner_id: oldM, to_runner_id: newM });
      const row = (await h.admin.query(`SELECT runner_id, placed_by FROM project_placements WHERE repo_id = $1`, [r])).rows;
      expect(row).toEqual([{ runner_id: newM, placed_by: "person" }]);
      expect(await allowed(oldM)).toEqual([]);
      expect(await allowed(newM)).toEqual([r]);
      const audit = (await h.admin.query(`SELECT payload FROM audit_log WHERE account_id = $1 AND action = 'project.moved'`, [acct.accountId])).rows;
      expect(audit).toEqual([{ payload: { repo_id: r, from_runner_id: oldM, to_runner_id: newM, carry: "off" } }]);
      expect((await ingest(kOld, randomUUID())).body).toMatchObject({ error: "engine_repo_not_enabled" });
      expect((await ingest(kNew, randomUUID())).status).toBe(200);
      expect((await h.admin.query(`SELECT 1 FROM project_placements WHERE runner_id = $1`, [oldM])).rows).toHaveLength(0);
    });

    it("refuses with nothing changed: not placed, same machine, a member, carry requested, an occupied or ineligible target, another account's repo", async () => {
      const [a, b, c3] = [await machine(), await machine(), await machine({ mem: 10 })];
      const [rA, rB, rFree] = [await repo(), await repo(), await repo()];
      await place(rA, a);
      await place(rB, b);
      await grant(a, rA);
      const before = JSON.stringify([await placements(), await allowed(a), await allowed(b)]);
      expect(await code(move(rFree, b))).toBe("409 project_not_placed");
      expect(await code(move(rA, a))).toBe("400 invalid_message");
      expect(await code(move(rA, b, { user: f.m1 }))).toBe("403 forbidden");
      expect(await code(move(rA, b, { carryState: true }))).toBe("409 state_carry_unavailable");
      expect(await code(move(rA, b))).toBe("409 machine_single_project");
      expect(await code(move(rA, c3))).toBe("409 machine_not_eligible");
      expect(await code(move(rA, randomUUID()))).toBe("404 not_found");
      expect(await code(move(await repo(other.accountId), a))).toBe("404 not_found");
      expect(JSON.stringify([await placements(), await allowed(a), await allowed(b)])).toBe(before);
      expect((await h.admin.query(`SELECT 1 FROM audit_log WHERE account_id = $1 AND action = 'project.moved' AND payload->>'repo_id' = $2`, [f.accountId, rA])).rows).toHaveLength(0);
    });

    it("rolls the whole move back when a later step fails: the placement is not left on the new machine", async () => {
      const [a, b] = [await machine(), await machine()];
      const r = await repo();
      await place(r, a);
      await grant(a, r);
      // The audit row is the last write; a failing audit action stands in for any late failure.
      await h.admin.query(`CREATE OR REPLACE FUNCTION mc9_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'project.moved' THEN RAISE EXCEPTION 'mc9 late failure'; END IF; RETURN NEW; END $$`);
      await h.admin.query(`CREATE TRIGGER mc9_fail_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION mc9_fail_audit()`);
      try {
        expect(await code(move(r, b))).toContain("mc9 late failure");
      } finally {
        await h.admin.query(`DROP TRIGGER mc9_fail_audit ON audit_log`);
        await h.admin.query(`DROP FUNCTION mc9_fail_audit()`);
      }
      expect(await at(a)).toEqual([r]);
      expect(await at(b)).toEqual([]);
      expect(await allowed(a)).toContain(r);
      expect(await allowed(b)).not.toContain(r);
    });

    it("moves off a machine that has been removed (its list is not edited, it is refused by ingest anyway)", async () => {
      const [dead, b] = [await machine(), await machine()];
      const r = await repo();
      await place(r, dead);
      await h.admin.query(`UPDATE runners SET revoked_at = now() WHERE id = $1`, [dead]);
      await move(r, b);
      expect(await at(b)).toEqual([r]);
      expect(await at(dead)).toEqual([]);
    });

    it("RACE: two projects moved to the same free machine at once: one wins, the other stays where it was, and no machine holds two", async () => {
      const [a, b, target] = [await machine(), await machine(), await machine()];
      const [rA, rB] = [await repo(), await repo()];
      await place(rA, a);
      await place(rB, b);
      const out = await Promise.all([code(move(rA, target)), code(move(rB, target))]);
      expect(out.filter((o) => o === "ok")).toHaveLength(1);
      expect(out.filter((o) => o === "409 machine_single_project")).toHaveLength(1);
      expect(await at(target)).toHaveLength(1);
      const winner = (await at(target))[0]!;
      const loser = winner === rA ? rB : rA;
      expect(await at(loser === rA ? a : b)).toEqual([loser]);
      expect(await at(winner === rA ? a : b)).toEqual([]);
      for (const m of [a, b, target]) expect((await at(m)).length).toBeLessThanOrEqual(1);
    });

    it("RACE: one project moved to two different machines at once: both may succeed one after the other, but it ends on exactly one machine with one row", async () => {
      const [a, t1, t2] = [await machine(), await machine(), await machine()];
      const r = await repo();
      await place(r, a);
      await grant(a, r);
      const out = await Promise.all([code(move(r, t1)), code(move(r, t2))]);
      expect(out.every((o) => o === "ok" || String(o).startsWith("409"))).toBe(true);
      const rows = (await h.admin.query(`SELECT runner_id FROM project_placements WHERE repo_id = $1`, [r])).rows;
      expect(rows).toHaveLength(1);
      expect([a, t1, t2].filter((m) => m !== rows[0]!.runner_id).length).toBe(2);
      for (const m of [a, t1, t2]) expect((await at(m)).length).toBeLessThanOrEqual(1);
      // The repository's coverage follows its placement: only the machine that holds it lists it, so ingest accepts that machine's session alone.
      const listing = [];
      for (const m of [a, t1, t2]) if ((await allowed(m)).includes(r)) listing.push(m);
      expect(listing).toEqual([rows[0]!.runner_id]);
    });

    it("keeps the plan holder's rule: a machine registered by someone else, on a repo whose dial lets work start without asking, is refused to a non-registrant (403 plan_holder_only)", async () => {
      const [a, b] = [await machine(), await machine()];
      const r = await repo();
      await place(r, a);
      await h.admin.query(`INSERT INTO decision_settings (account_id, repo_id, decision_type, disposition, version, changed_by) VALUES ($1, $2, 'runner_run_on_member_plan', 'act', 1, $3)`, [f.accountId, r, f.o1]);
      expect(await code(move(r, b, { user: f.a1 }))).toBe("403 plan_holder_only");
      expect(await at(a)).toEqual([r]);
      expect(await code(move(r, b))).toBe("ok");
    });
  });
});
