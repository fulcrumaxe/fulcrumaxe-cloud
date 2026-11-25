import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGithubRepoVisibility, type RepoReadHttp } from "@fx/runner";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { ghError, strictGithubFetch } from "../../github/test/helpers/strictGithub.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { setEngineBridgeSettings } from "@fx/db/src/engineBridge.js";
import { signMachineJob, type MachineJob } from "@fulcrumaxe/runner-protocol";
import { firstLiveSetup } from "../src/projectConfirm.js";
import { lockRunners } from "../src/placement.js";
import { ENGINE_EVENTS_PATH, RunnerHttpError, ingestEngineEvents, moveProject, moveProjectRoute, placeProjectRoute, toResponse, type RunnerCloudDeps, type RunPullRequestPort } from "../src/index.js";
import { harness, newKey, signed, type Harness, type TestKey } from "./helpers.js";

/**
 * [pg] D#845 ON-7a: confirming a project is one transaction. Every write is made to raise in turn (a trigger that fails that one write), and nothing may be left behind.
 * GitHub's visibility answer is read through the real `GET /repos/{owner}/{repo}` contract on the strict fake (a 404 and a 5xx are `unknown`).
 */
describe("confirming a project [pg]", () => {
  let h: Harness;
  let seq = 8_100_000 + Math.floor(Math.random() * 100_000);
  const accounts: F2Fixture[] = [];
  const vis = (v: "private" | "public" | "unknown"): Partial<RunnerCloudDeps> => ({ repoVisibility: async () => v });

  beforeAll(async () => {
    h = await harness();
  });
  afterAll(async () => {
    // The [pg] files share one database, and the ingest file reads engine_sessions and engine_session_gaps without an account filter: leave no session of ours behind.
    for (const a of accounts) {
      await h.admin.query(`DELETE FROM engine_sessions WHERE account_id = $1`, [a.accountId]);
      await h.admin.query(`DELETE FROM engine_repo_quota WHERE account_id = $1`, [a.accountId]);
    }
    await h.close();
  });

  /** A fresh account with a sandbox repo, a second repo, and one eligible microVM machine. */
  async function world(o: { engine?: "microvm" | "os_sandbox"; key?: TestKey } = {}) {
    const a = await seedF2(h.admin);
    accounts.push(a);
    const repo = async (name: string, mode = "sandbox"): Promise<string> => {
      const id = randomUUID();
      await h.admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) VALUES ($1, $2, $3, 'team', 'acme', $4, $5)`, [id, a.accountId, ++seq, name, mode]);
      return id;
    };
    const machine = async (key?: TestKey, engine = o.engine ?? "microvm"): Promise<string> => {
      const id = await insertRunner(h.admin, a.accountId, a.o1, key ? { jwk: key.jwk, jkt: key.jkt } : {});
      await h.admin.query(`UPDATE runners SET protocol_version = 22, model_auth_present = true, last_seen_at = now() WHERE id = $1`, [id]);
      await h.admin.query(`INSERT INTO runner_facts (runner_id, account_id, os, arch, mem_gb_bucket, cpus, sandbox_engine, host_mem_avail_mb, host_disk_free_mb, host_setups_running, host_load_at) VALUES ($1, $2, 'linux', 'x64', 16, 8, $3, 9000, 50000, 0, now())`, [id, a.accountId, engine]);
      return id;
    };
    return { a, repo, machine, r1: await repo("widgets"), r2: await repo("gadgets"), m1: await machine(o.key) };
  }
  type World = Awaited<ReturnType<typeof world>>;

  const confirm = (w: World, repoId: string, body: Record<string, unknown>, o: { user?: string; deps?: Partial<RunnerCloudDeps> } = {}) =>
    placeProjectRoute(h.deps({ ...vis("private"), ...o.deps }), { accountId: w.a.accountId, userId: o.user ?? w.a.o1 }, repoId, { kind: "existing", ...body });
  const code = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
      return "ok";
    } catch (e) {
      return e instanceof RunnerHttpError ? `${e.status} ${e.code}` : String((e as Error).message);
    }
  };
  const q = async (sql: string, args: unknown[]) => (await h.admin.query(sql, args)).rows;
  /** Everything one confirm writes, for one account, as plain data (so "nothing changed" is a deep equality). */
  const snapshot = async (w: World) => ({
    modes: await q(`SELECT id, execution_mode FROM repos WHERE account_id = $1 ORDER BY id`, [w.a.accountId]),
    lists: await q(`SELECT id, allowed_repo_ids FROM runners WHERE account_id = $1 ORDER BY id`, [w.a.accountId]),
    placements: await q(`SELECT repo_id, runner_id FROM project_placements WHERE account_id = $1`, [w.a.accountId]),
    setups: await q(`SELECT id FROM project_setups WHERE account_id = $1`, [w.a.accountId]),
    ticks: await q(`SELECT repo_id FROM engine_bridge_repos WHERE account_id = $1`, [w.a.accountId]),
    switches: await q(`SELECT watch_enabled, operate_enabled FROM engine_bridge_settings WHERE account_id = $1`, [w.a.accountId]),
    audits: await q(`SELECT action FROM audit_log WHERE account_id = $1 AND (action LIKE 'project.%' OR action LIKE 'engine_bridge.%' OR action LIKE 'repo.execution%' OR action = 'runner.repos_set') ORDER BY id`, [w.a.accountId]),
  });

  it("writes every part together: runner mode, the machine's list, the placement, the tick with watch on, the setup at survey, and the audit rows", async () => {
    const w = await world();
    const res = await confirm(w, w.r1, { runner_id: w.m1 });
    expect(res.status).toBe(201);
    const setupId = (res.body as { setup_id: string }).setup_id;
    expect(res.body).toMatchObject({ repo_id: w.r1, runner_id: w.m1, kind: "existing", phase: "survey", operate_enabled: false });
    const s = await snapshot(w);
    expect(s.modes).toContainEqual({ id: w.r1, execution_mode: "runner_local" });
    expect(s.modes).toContainEqual({ id: w.r2, execution_mode: "sandbox" });
    expect(s.lists).toEqual([{ id: w.m1, allowed_repo_ids: [w.r1] }]);
    expect(s.placements).toEqual([{ repo_id: w.r1, runner_id: w.m1 }]);
    expect(s.ticks).toEqual([{ repo_id: w.r1 }]);
    expect(s.switches).toEqual([{ watch_enabled: true, operate_enabled: false }]);
    expect(await q(`SELECT phase, runner_id, kind FROM project_setups WHERE id = $1`, [setupId])).toEqual([{ phase: "survey", runner_id: w.m1, kind: "existing" }]);
    const audit = await q(`SELECT payload FROM audit_log WHERE account_id = $1 AND action = 'project.setup_started'`, [w.a.accountId]);
    expect(audit).toHaveLength(1);
    expect(audit[0].payload).toMatchObject({ setup_id: setupId, repo_id: w.r1, runner_id: w.m1, kind: "existing" });
    expect(s.audits.map((r: { action: string }) => r.action)).toEqual(expect.arrayContaining(["repo.execution_mode.changed", "runner.repos_set", "engine_bridge.settings_changed", "project.setup_started"]));
  });

  it("a new repo starts at plan with no survey, and no machine named means the best eligible one", async () => {
    const w = await world();
    const res = await confirm(w, w.r1, { kind: "new" });
    expect(res.body).toMatchObject({ kind: "new", phase: "plan", runner_id: w.m1 });
  });

  it("makes each write raise in turn and leaves nothing behind", async () => {
    const w = await world();
    const acct = w.a.accountId;
    const before = await snapshot(w);
    const writes: Array<[string, string, string]> = [
      ["the setup row", "project_setups", `NEW.account_id = '${acct}'`],
      ["the runner mode", "repos", `NEW.account_id = '${acct}' AND NEW.execution_mode IS DISTINCT FROM OLD.execution_mode`],
      ["the mode audit row", "audit_log", `NEW.account_id = '${acct}' AND NEW.action = 'repo.execution_mode.changed'`],
      ["the placement", "project_placements", `NEW.account_id = '${acct}'`],
      ["the machine's list", "runners", `NEW.account_id = '${acct}' AND NEW.allowed_repo_ids IS DISTINCT FROM OLD.allowed_repo_ids`],
      ["the bridge tick", "engine_bridge_repos", `NEW.account_id = '${acct}'`],
      ["the bridge switches", "engine_bridge_settings", `NEW.account_id = '${acct}'`],
      ["the setup's machine", "project_setups", `NEW.account_id = '${acct}' AND NEW.runner_id IS DISTINCT FROM OLD.runner_id`],
      ["the bridge audit row", "audit_log", `NEW.account_id = '${acct}' AND NEW.action LIKE 'engine_bridge.%'`],
      ["the setup audit row", "audit_log", `NEW.account_id = '${acct}' AND NEW.action = 'project.setup_started'`],
    ];
    await h.admin.query(`CREATE OR REPLACE FUNCTION on7_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'on7_injected_failure'; END $$`);
    for (const [name, table, when] of writes) {
      await h.admin.query(`CREATE TRIGGER on7_fail BEFORE ${when.includes("OLD.") ? "UPDATE" : "INSERT OR UPDATE"} ON ${table} FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION on7_fail()`);
      try {
        expect(await code(confirm(w, w.r1, { runner_id: w.m1 })), name).toBe("on7_injected_failure");
      } finally {
        await h.admin.query(`DROP TRIGGER on7_fail ON ${table}`);
      }
      expect(await snapshot(w), `${name}: nothing changed`).toEqual(before);
    }
    // And with every trigger gone it goes through, so the failures above were the injected ones and not a broken setup.
    expect(await code(confirm(w, w.r1, { runner_id: w.m1 }))).toBe("ok");
  });

  it("a deadlock (SQLSTATE 40P01) on any write is 409 placement_busy with the retry sentence, and nothing is left behind", async () => {
    const w = await world();
    const before = await snapshot(w);
    await h.admin.query(`CREATE OR REPLACE FUNCTION on7_deadlock() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'deadlock detected' USING ERRCODE = '40P01'; END $$`);
    for (const body of [{ runner_id: w.m1 }, {}]) {
      await h.admin.query(`CREATE TRIGGER on7_deadlock BEFORE INSERT ON project_placements FOR EACH ROW WHEN (NEW.account_id = '${w.a.accountId}') EXECUTE FUNCTION on7_deadlock()`);
      try {
        const err = await confirm(w, w.r1, body).catch((e: RunnerHttpError) => e);
        expect(err, JSON.stringify(body)).toMatchObject({ status: 409, code: "placement_busy", message: "Another change to this machine is in progress. Try again." });
      } finally {
        await h.admin.query(`DROP TRIGGER on7_deadlock ON project_placements`);
      }
      expect(await snapshot(w)).toEqual(before);
    }
    // Retrying works: the 409 was the deadlock's, not a stuck state.
    expect(await code(confirm(w, w.r1, { runner_id: w.m1 }))).toBe("ok");
  });

  it("CWE-833, move side: a deadlock (40P01) in the move route is 409 placement_busy with the same sentence as confirm, and the move writes nothing", async () => {
    const w = await world();
    const m2 = await w.machine();
    expect((await confirm(w, w.r1, { runner_id: w.m1 })).status).toBe(201);
    const principal = { accountId: w.a.accountId, userId: w.a.o1 };
    // The move starts the engine on the new machine, so it needs a plan, operate on, the repo's tick, the job signer and GitHub's default branch.
    await h.admin.query(`UPDATE accounts SET engine_quantity = 5, stripe_subscription_status = 'active' WHERE id = $1`, [w.a.accountId]);
    await h.admin.query(`INSERT INTO engine_bridge_settings (account_id, watch_enabled, operate_enabled) VALUES ($1, true, true) ON CONFLICT (account_id) DO UPDATE SET watch_enabled = true, operate_enabled = true`, [w.a.accountId]);
    await h.admin.query(`INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [w.a.accountId, w.r1]);
    const jobKey = generateKeyPairSync("ed25519").privateKey;
    const github = { defaultBranch: async () => "main", branchState: async () => ({ exists: true, headOid: "a".repeat(40), aheadBy: 0, defaultBranch: "main" }) } as unknown as RunPullRequestPort;
    const moveDeps = () => h.deps({ pullRequests: github, engineCommandSigner: async () => ({ keyId: "k1", signMachineJob: (job: MachineJob) => signMachineJob(job, "k1", jobKey) }) as never });
    const before = await snapshot(w);
    const move = () => moveProjectRoute(moveDeps(), principal, w.r1, { to_runner_id: m2 });
    await h.admin.query(`CREATE OR REPLACE FUNCTION on7_deadlock() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'deadlock detected' USING ERRCODE = '40P01'; END $$`);
    await h.admin.query(`CREATE TRIGGER on7_move_deadlock BEFORE UPDATE ON project_placements FOR EACH ROW WHEN (NEW.account_id = '${w.a.accountId}') EXECUTE FUNCTION on7_deadlock()`);
    try {
      expect(await move().catch((e: RunnerHttpError) => e)).toMatchObject({ status: 409, code: "placement_busy", message: "Another change to this machine is in progress. Try again." });
    } finally {
      await h.admin.query(`DROP TRIGGER on7_move_deadlock ON project_placements`);
    }
    expect(await snapshot(w)).toEqual(before);
    // Retrying works, and another failure is still not mapped to a busy answer.
    expect((await move()).status).toBe(200);
    expect(await code(moveProjectRoute(moveDeps(), principal, w.r1, { to_runner_id: randomUUID() }))).toBe("404 not_found");
  });

  it("lock order: a confirm onto a machine takes the machine's locks before its placement, so a change holding them first cannot deadlock it", async () => {
    const w = await world();
    const m2 = await w.machine();
    const other = await w.repo("third", "runner_local");
    // The other writer (a move takes its locks the same way) holds the machine's lock, then writes a placement onto it after the confirm has started.
    let enter!: () => void;
    const holding = new Promise<void>((r) => { enter = r; });
    let go!: () => void;
    const later = new Promise<void>((r) => { go = r; });
    const writer = withTenant(h.appPool, w.a.accountId, w.a.o1, async (c) => {
      await lockRunners(c, [m2]);
      enter();
      await later;
      await c.query(`INSERT INTO project_placements (account_id, repo_id, runner_id, placed_by) VALUES ($1, $2, $3, 'person')`, [w.a.accountId, other, m2]);
    });
    await holding;
    const confirming = code(confirm(w, w.r1, { runner_id: m2 }));
    await new Promise((r) => setTimeout(r, 700));
    go();
    await writer; // no 40P01 for the writer
    // The confirm waited on the machine's lock, so it read the machine after the writer finished: taken, and nothing of the confirm is written.
    expect(await confirming).toBe("409 machine_single_project");
    expect((await snapshot(w)).setups).toEqual([]);
    expect((await snapshot(w)).placements).toEqual([{ repo_id: other, runner_id: m2 }]);
  }, 30_000);

  it("a confirm and a move onto the same machine, at once, each answers ok or 409 machine_single_project and never a deadlock", async () => {
    for (let i = 0; i < 4; i++) {
      const w = await world();
      const m2 = await w.machine();
      await confirm(w, w.r2, { runner_id: w.m1 });
      const actor = { accountId: w.a.accountId, userId: w.a.o1 };
      const moved = withTenant(h.appPool, w.a.accountId, w.a.o1, (c) => moveProject(c, actor, { repoId: w.r2, toRunnerId: m2 }));
      const out = await Promise.all([code(confirm(w, w.r1, { runner_id: m2 })), code(moved)]);
      for (const o of out) expect(["ok", "409 machine_single_project"], `${i}: ${out.join(" / ")}`).toContain(o);
      expect(out.filter((o) => o === "ok"), `${i}: exactly one gets the machine`).toHaveLength(1);
    }
  }, 60_000);

  it("a settings change and a confirm serialise on the same per-account lock: the confirm waits for the change, then judges its consent against it", async () => {
    const w = await world();
    const m2 = await w.machine();
    await h.admin.query(`INSERT INTO engine_bridge_settings (account_id, watch_enabled, operate_enabled) VALUES ($1, true, false)`, [w.a.accountId]);
    await h.admin.query(`INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)`, [w.a.accountId, w.r2]);
    const r3 = randomUUID();
    await h.admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) VALUES ($1, $2, $3, 'team', 'acme', 'third', 'runner_local')`, [r3, w.a.accountId, ++seq]);
    // The PUT's write is open (its transaction holds the lock); the person confirmed having been shown exactly [r2].
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let entered!: () => void;
    const inside = new Promise<void>((r) => { entered = r; });
    const put = withTenant(h.appPool, w.a.accountId, w.a.o1, async (c) => {
      await setEngineBridgeSettings(c, w.a.o1, { repo_ids: [w.r2, r3] }, new Map());
      entered();
      await held;
    });
    await inside;
    let settled = false;
    const confirming = code(confirm(w, w.r1, { runner_id: m2, turn_on_operate: true, operate_others: [w.r2] })).finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 700));
    expect(settled, "the confirm is waiting on the change, not racing it").toBe(false);
    release();
    await put;
    // It saw r3 ticked, so the list the person saw is stale: no consent, operate stays off, nothing of the confirm is written.
    expect(await confirming).toBe("409 operate_consent_stale");
    expect(await q(`SELECT operate_enabled FROM engine_bridge_settings WHERE account_id = $1`, [w.a.accountId])).toEqual([{ operate_enabled: false }]);
    expect((await snapshot(w)).setups).toEqual([]);
    // With the list the person now sees, it goes through: operate is on for exactly the repos named.
    expect((await confirm(w, w.r1, { runner_id: m2, turn_on_operate: true, operate_others: [w.r2, r3].sort() })).body).toMatchObject({ operate_enabled: true });
  });

  it("a second live setup for the repo is 409 setup_exists with the first's id; a removed one frees the repo again", async () => {
    const w = await world();
    const m2 = await w.machine();
    const first = (await confirm(w, w.r1, { runner_id: w.m1 })).body as { setup_id: string };
    const err = await confirm(w, w.r1, { runner_id: m2 }).catch((e: RunnerHttpError) => e);
    expect(err).toMatchObject({ status: 409, code: "setup_exists", extra: { setup_id: first.setup_id } });
    expect((await snapshot(w)).lists.find((l: { id: string }) => l.id === m2)).toMatchObject({ allowed_repo_ids: [] });
    // The second repo of the same account is its own setup: the first one's does not answer for it.
    expect(await code(confirm(w, w.r2, { runner_id: m2 }))).toBe("ok");
    // The predicates themselves, read through the client that bypasses row security: a foreign account, or the account's other repo, finds nothing.
    expect(await firstLiveSetup(h.admin, randomUUID(), w.r1)).toBeNull();
    expect(await firstLiveSetup(h.admin, w.a.accountId, randomUUID())).toBeNull();
    expect(await firstLiveSetup(h.admin, w.a.accountId, w.r1)).toBe(first.setup_id);
    // Undo: the project is removed (setup removed, placement and tick gone), and the repo can be confirmed again.
    await h.admin.query(`UPDATE project_setups SET phase = 'removed' WHERE id = $1`, [first.setup_id]);
    await h.admin.query(`DELETE FROM project_placements WHERE repo_id = $1`, [w.r1]);
    expect(await code(confirm(w, w.r1, { runner_id: w.m1 }))).toBe("ok");
  });

  it("two confirms of one repo at once: one setup, one 409 setup_exists", async () => {
    const w = await world();
    const m2 = await w.machine();
    const both = await Promise.all([code(confirm(w, w.r1, { runner_id: w.m1 })), code(confirm(w, w.r1, { runner_id: m2 }))]);
    expect(both.sort()).toEqual(["409 setup_exists", "ok"]);
    expect((await snapshot(w)).setups).toHaveLength(1);
    expect((await snapshot(w)).placements).toHaveLength(1);
  });

  it("a machine that already hosts a project is 409 machine_single_project on either tier, and nothing is written", async () => {
    for (const engine of ["microvm", "os_sandbox"] as const) {
      const w = await world({ engine });
      await confirm(w, w.r1, { runner_id: w.m1 });
      const before = await snapshot(w);
      expect(await code(confirm(w, w.r2, { runner_id: w.m1 })), engine).toBe("409 machine_single_project");
      expect(await snapshot(w), engine).toEqual(before);
    }
  });

  it("visibility: private and public are accepted; unknown, a rejected read and a missing reader are 409 repo_visibility_unknown with nothing written", async () => {
    const w = await world();
    const before = await snapshot(w);
    const refused: Array<[string, Partial<RunnerCloudDeps>]> = [
      ["unknown", vis("unknown")],
      ["rejected", { repoVisibility: async () => Promise.reject(new Error("github down")) }],
      ["throws", { repoVisibility: () => { throw new Error("no client"); } }],
      ["missing reader", { repoVisibility: undefined }],
    ];
    for (const [name, deps] of refused) {
      const err = await confirm(w, w.r1, { runner_id: w.m1 }, { deps }).catch((e: RunnerHttpError) => e);
      expect(err, name).toMatchObject({ status: 409, code: "repo_visibility_unknown", message: "GitHub didn't say whether acme/widgets is public or private. Try again in a minute" });
      expect(await snapshot(w), name).toEqual(before);
    }
    expect(await code(confirm(w, w.r1, { runner_id: w.m1 }, { deps: vis("public") }))).toBe("ok");
    expect(await code(confirm(w, w.r2, { runner_id: await w.machine() }, { deps: vis("private") }))).toBe("ok");
  });

  it("visibility through the real GET /repos contract: 200 private or public, a 404 and a 5xx read as unknown", async () => {
    const w = await world();
    const answers: Array<[number, unknown]> = [];
    const strict = strictGithubFetch((async () => {
      const [status, body] = answers.shift()!;
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch);
    const http: RepoReadHttp = {
      async request(req) {
        const res = await strict(`https://api.github.com${req.path}`, { headers: { authorization: "Bearer ghs_fake", "user-agent": "fx-test", accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" } });
        return { status: res.status, body: await res.json().catch(() => null) };
      },
    };
    const reader = createGithubRepoVisibility({ resolveRepo: async () => ({ owner: "acme", name: "widgets" }), open: async () => http });
    const deps = { repoVisibility: (accountId: string, repoId: string) => reader.visibility({ accountId, repoId }) };
    const gone = JSON.parse(ghError(404, "Not Found").body) as unknown;
    const boom = JSON.parse(ghError(503, "Service Unavailable").body) as unknown;
    for (const [status, body] of [[404, gone], [503, boom]] as const) {
      answers.push([status, body]);
      expect(await code(confirm(w, w.r1, { runner_id: w.m1 }, { deps })), String(status)).toBe("409 repo_visibility_unknown");
    }
    answers.push([200, { full_name: "acme/widgets", private: false }]);
    expect(await code(confirm(w, w.r1, { runner_id: w.m1 }, { deps }))).toBe("ok");
  });

  it("operate is never turned on by itself; with the switch off it goes on only with consent naming the other operated repos", async () => {
    // Switch already on: the box does nothing.
    const on = await world();
    await h.admin.query(`INSERT INTO engine_bridge_settings (account_id, watch_enabled, operate_enabled) VALUES ($1, true, true)`, [on.a.accountId]);
    expect((await confirm(on, on.r1, { runner_id: on.m1, turn_on_operate: true })).body).toMatchObject({ operate_enabled: true });

    // Switch off, no other ticked repo: not asked, so it stays off; asked, so it goes on.
    const solo = await world();
    expect((await confirm(solo, solo.r1, { runner_id: solo.m1 })).body).toMatchObject({ operate_enabled: false });
    const solo2 = await world();
    expect((await confirm(solo2, solo2.r1, { runner_id: solo2.m1, turn_on_operate: true })).body).toMatchObject({ operate_enabled: true });
    expect(await q(`SELECT operate_enabled FROM engine_bridge_settings WHERE account_id = $1`, [solo2.a.accountId])).toEqual([{ operate_enabled: true }]);

    // Switch off with other ticked repos: it also operates them, so the person must have been shown exactly those.
    const many = await world();
    const m2 = await many.machine();
    await h.admin.query(`INSERT INTO engine_bridge_settings (account_id, watch_enabled, operate_enabled) VALUES ($1, true, false)`, [many.a.accountId]);
    await h.admin.query(`INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)`, [many.a.accountId, many.r2]);
    const before = await snapshot(many);
    for (const others of [[], [randomUUID()], [many.r2, many.r1]]) {
      expect(await code(confirm(many, many.r1, { runner_id: many.m1, turn_on_operate: true, operate_others: others })), JSON.stringify(others)).toBe("409 operate_consent_stale");
      expect(await snapshot(many)).toEqual(before);
    }
    expect((await confirm(many, many.r1, { runner_id: m2, turn_on_operate: true, operate_others: [many.r2] })).body).toMatchObject({ operate_enabled: true });
    expect(await q(`SELECT operate_enabled FROM engine_bridge_settings WHERE account_id = $1`, [many.a.accountId])).toEqual([{ operate_enabled: true }]);
  });

  it("operate on a public repo is 409 operate_public_pending with nothing written; watch-only placement of a public repo, and private repos, are unchanged", async () => {
    const w = await world();
    const m2 = await w.machine();
    const visOf = (pub: string[]): Partial<RunnerCloudDeps> => ({ repoVisibility: async (_a: string, id: string) => (pub.includes(id) ? "public" : "private") });
    // This repo is public and the person asks for operate: refused.
    let before = await snapshot(w);
    expect(await code(confirm(w, w.r1, { runner_id: w.m1, turn_on_operate: true }, { deps: visOf([w.r1]) }))).toBe("409 operate_public_pending");
    expect(await snapshot(w)).toEqual(before);
    // Watch-only: the same public repo places.
    expect((await confirm(w, w.r1, { runner_id: w.m1 }, { deps: visOf([w.r1]) })).body).toMatchObject({ operate_enabled: false });
    // A second repo, private, asking for operate while the first (public) is ticked: it would also operate the public one.
    before = await snapshot(w);
    expect(await code(confirm(w, w.r2, { runner_id: m2, turn_on_operate: true, operate_others: [w.r1] }, { deps: visOf([w.r1]) }))).toBe("409 operate_public_pending");
    expect(await snapshot(w)).toEqual(before);
    // Private is unchanged: with nothing public, the same request goes through.
    expect((await confirm(w, w.r2, { runner_id: m2, turn_on_operate: true, operate_others: [w.r1] }, { deps: visOf([]) })).body).toMatchObject({ operate_enabled: true });
    // Operate already on: a public repo cannot be added to it, a private one can.
    const on = await world();
    await h.admin.query(`INSERT INTO engine_bridge_settings (account_id, watch_enabled, operate_enabled) VALUES ($1, true, true)`, [on.a.accountId]);
    expect(await code(confirm(on, on.r1, { runner_id: on.m1 }, { deps: visOf([on.r1]) }))).toBe("409 operate_public_pending");
    expect(await code(confirm(on, on.r1, { runner_id: on.m1 }, { deps: visOf([]) }))).toBe("ok");
  });

  it("refuses a member, another account's repo, an unknown machine, a paused account and a malformed body, each with nothing written", async () => {
    const w = await world();
    const foreign = await world();
    const before = await snapshot(w);
    expect(await code(confirm(w, w.r1, { runner_id: w.m1 }, { user: w.a.m1 }))).toBe("403 forbidden");
    expect(await code(confirm(w, foreign.r1, { runner_id: w.m1 }))).toBe("404 not_found");
    expect(await code(confirm(w, w.r1, { runner_id: foreign.m1 }))).toBe("404 not_found");
    expect(await code(confirm(w, randomUUID(), {}))).toBe("404 not_found");
    for (const bad of [{ kind: "other" }, { runner_id: "x" }, { extra: 1 }, { turn_on_operate: "yes" }, { operate_others: ["x"] }]) expect(await code(confirm(w, w.r1, bad)), JSON.stringify(bad)).toBe("400 invalid_message");
    await h.admin.query(`UPDATE accounts SET platform_hold_at = now() WHERE id = $1`, [w.a.accountId]);
    expect(await code(confirm(w, w.r1, { runner_id: w.m1 }))).toBe("409 account_not_active");
    await h.admin.query(`UPDATE accounts SET platform_hold_at = NULL WHERE id = $1`, [w.a.accountId]);
    expect(await snapshot(w)).toEqual(before);
    // The foreign account saw none of it either.
    expect((await snapshot(foreign)).placements).toEqual([]);
  });

  it("a public repo's event batch is accepted by ingest and its stored rows hold ids and enums only", async () => {
    const key = newKey();
    const w = await world({ key });
    const gh = Number((await q(`SELECT gh_repo_id FROM repos WHERE id = $1`, [w.r1]))[0].gh_repo_id);
    await confirm(w, w.r1, { runner_id: w.m1 }, { deps: vis("public") });
    const instance = randomUUID();
    const res = await toResponse(() =>
      ingestEngineEvents(h.deps(), signed(key, ENGINE_EVENTS_PATH, {
        session: { engine_instance_id: instance, repo_gh_id: gh, engine_version: "1.2.3" },
        events: [{ v: 1, seq: 0, ts: "2026-11-16T10:00:00.000Z", kind: "merged", engine_instance_id: instance, pr: 1, closes: false }],
      })),
    );
    expect(res.status).toBe(200);
    const rows = await q(`SELECT kind, body FROM engine_events WHERE account_id = $1`, [w.a.accountId]);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0].body)).toMatch(/^\{("[a-z_]+":(\d+|true|false|"[a-z0-9_.-]*"),?)*\}$/);
  });

  // D#845 ON-10b2: after the confirm commits, an existing project starts its survey; a new one starts none; the confirm never depends on it.
  describe("the survey after the confirm (ON-10b2)", () => {
    const RUN = "44444444-4444-4444-8444-444444444444";
    const HEAD = "e".repeat(40);
    const github = { defaultBranch: async () => "main", branchState: async () => ({ exists: true, headOid: HEAD, aheadBy: 0, defaultBranch: "main" }) } as unknown as NonNullable<RunnerCloudDeps["pullRequests"]>;
    function surveyDeps(o: { answer?: "ok" | "refused" | "throws" } = {}) {
      const starts: Array<{ setupId: string; userId: string; headSha: string; runnerId: string }> = [];
      const deadlines: string[] = [];
      const deps: Partial<RunnerCloudDeps> = {
        pullRequests: github,
        surveyRuns: async () => ({
          startSurveyRun: async (input) => {
            starts.push({ setupId: input.setupId, userId: input.userId, headSha: input.headSha, runnerId: input.runnerId });
            if (o.answer === "throws") throw new Error("boom: secret-detail");
            return o.answer === "refused" ? { ok: false, status: 409, code: "survey_not_started", reason: "model_budget_unset" } : { ok: true, runId: RUN };
          },
          endSurveyAtDeadline: async () => ({ final: true }),
        }),
        surveyDeadline: { start: async (args) => void deadlines.push(args.runId) },
      };
      return { deps, starts, deadlines };
    }

    it("an existing confirm starts one survey after the commit, as the person, on the placed machine, and the body carries its run", async () => {
      const w = await world();
      const s = surveyDeps();
      const res = await confirm(w, w.r1, { runner_id: w.m1 }, { deps: s.deps });
      expect(res.status).toBe(201);
      const setupId = (await q(`SELECT id FROM project_setups WHERE account_id = $1`, [w.a.accountId]))[0].id;
      expect(res.body).toMatchObject({ kind: "existing", survey: { run_id: RUN } });
      expect(s.starts).toEqual([{ setupId, userId: w.a.o1, headSha: HEAD, runnerId: w.m1 }]);
      expect(s.deadlines).toEqual([RUN]);
    });

    it("a new confirm starts none and its body has no survey field", async () => {
      const w = await world();
      const s = surveyDeps();
      const res = await confirm(w, w.r1, { kind: "new" }, { deps: s.deps });
      expect(res.status).toBe(201);
      expect(res.body).not.toHaveProperty("survey");
      expect(s.starts).toEqual([]);
      expect(s.deadlines).toEqual([]);
    });

    it("a refusal of the start still gives the 201 confirm, with its closed code and every confirm write in place", async () => {
      const w = await world();
      const res = await confirm(w, w.r1, { runner_id: w.m1 }, { deps: surveyDeps({ answer: "refused" }).deps });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ survey: { started: false, code: "survey_not_started" } });
      expect(await q(`SELECT phase FROM project_setups WHERE account_id = $1`, [w.a.accountId])).toEqual([{ phase: "survey" }]);
      expect(await q(`SELECT runner_id FROM project_placements WHERE account_id = $1`, [w.a.accountId])).toEqual([{ runner_id: w.m1 }]);
    });

    it("a public repo is confirmed and its survey is not started by itself: public_survey_consent_required, with no start and no deadline, on a machine that lists survey_public_v1 or not (D#845 ON-10e2a); an unexpected error is the code internal with nothing of it in the body", async () => {
      const pub = await world();
      const s = surveyDeps();
      const res = await confirm(pub, pub.r1, { runner_id: pub.m1 }, { deps: { ...s.deps, ...vis("public") } });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ survey: { started: false, code: "public_survey_consent_required" } });
      expect(s.starts).toEqual([]);
      expect(s.deadlines).toEqual([]);
      // The confirm's own writes stand, and an `existing` project waits at the survey step for the person's consent.
      expect(await q(`SELECT phase, survey_run_id FROM project_setups WHERE account_id = $1`, [pub.a.accountId])).toEqual([{ phase: "survey", survey_run_id: null }]);
      const w = await world();
      const bad = await confirm(w, w.r1, { runner_id: w.m1 }, { deps: surveyDeps({ answer: "throws" }).deps });
      expect(bad.status).toBe(201);
      expect(bad.body).toMatchObject({ survey: { started: false, code: "internal" } });
      expect(JSON.stringify(bad.body)).not.toContain("secret-detail");
    });

    it("a confirm that is refused starts no survey", async () => {
      const w = await world();
      const s = surveyDeps();
      expect(await code(confirm(w, w.r1, { runner_id: w.m1 }, { user: w.a.m1, deps: s.deps }))).toBe("403 forbidden");
      expect(s.starts).toEqual([]);
    });
  });
});
