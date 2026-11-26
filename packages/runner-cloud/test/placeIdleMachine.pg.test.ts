import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { runnerWorkKeyFor, setPendingHooks } from "@fx/core/src/pendingWork.js";
import { HOST_LOAD_MIN_INTERVAL_SECONDS } from "@fulcrumaxe/runner-protocol";
import { CLAIM_PATH, HELLO_PATH, LOAD_STALE_AFTER_INTERVALS, RunnerHttpError, claimRun, placeProjectRoute, runnerHello, toResponse, type RunnerCloudDeps, type RunnerLeaseOps } from "../src/index.js";
import { harness, newKey, registerKey, respond, signed, type Harness, type TestKey } from "./helpers.js";

/**
 * [pg] An idle, healthy machine takes a project, and a refusal says why. The refusal for a load the cloud has not heard lately wakes the account's runners (a push into the no-database
 * wake store, no poll), the runner's next claim carries a fresh reading, and the same confirm then goes through. Every other reason is named and wakes nothing.
 */
describe("confirming a project on an idle machine [pg]", () => {
  let h: Harness;
  let seq = 8_300_000 + Math.floor(Math.random() * 100_000);
  const marks: string[] = [];
  const vis: Partial<RunnerCloudDeps> = { repoVisibility: async () => "private" };
  const STALE_S = LOAD_STALE_AFTER_INTERVALS * HOST_LOAD_MIN_INTERVAL_SECONDS;

  beforeAll(async () => {
    h = await harness();
  });
  afterEach(() => {
    setPendingHooks(null);
    marks.length = 0;
  });
  afterAll(async () => {
    await h.admin.query(`DELETE FROM engine_sessions WHERE account_id = ANY($1::uuid[])`, [accounts.map((a) => a.accountId)]);
    await h.close();
  });
  const accounts: F2Fixture[] = [];

  /** The wake store: it records the writes and answers nothing, like an empty cache. */
  const watchWake = () => setPendingHooks({ store: { get: async () => null, set: async (k: string) => void marks.push(k), delete: async () => undefined } as never });
  const settle = () => new Promise((r) => setTimeout(r, 60));

  async function world() {
    const a = await seedF2(h.admin);
    accounts.push(a);
    const repoId = randomUUID();
    await h.admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) VALUES ($1, $2, $3, 'team', 'acme', 'widgets', 'sandbox')`, [repoId, a.accountId, ++seq]);
    return { a, repoId };
  }
  type World = Awaited<ReturnType<typeof world>>;

  /** An idle, live, Claude-ready machine with room to spare; `loadAgeS` is how old its last load is (null: it never reported one). */
  async function machine(w: World, o: { loadAgeS?: number | null; mem?: number; disk?: number; claude?: boolean; paused?: boolean; draining?: boolean; seenAgo?: string } = {}): Promise<string> {
    const id = await insertRunner(h.admin, w.a.accountId, w.a.o1);
    await h.admin.query(`UPDATE runners SET protocol_version = 22, model_auth_present = $2, last_seen_at = now() - $3::interval WHERE id = $1`, [id, o.claude ?? true, o.seenAgo ?? "0 seconds"]);
    await h.admin.query(`INSERT INTO runner_facts (runner_id, account_id, os, arch, mem_gb_bucket, cpus, sandbox_engine) VALUES ($1, $2, 'linux', 'x64', 16, 8, 'microvm')`, [id, w.a.accountId]);
    if (o.loadAgeS !== null) {
      await h.admin.query(`UPDATE runner_facts SET host_mem_avail_mb = $2, host_disk_free_mb = $3, host_setups_running = 0, host_load_at = now() - make_interval(secs => $4) WHERE runner_id = $1`, [id, o.mem ?? 7900, o.disk ?? 175000, o.loadAgeS ?? 0]);
    }
    if (o.paused || o.draining) await h.admin.query(`INSERT INTO runner_settings (runner_id, account_id, paused_at, draining) VALUES ($1, $2, $3, $4)`, [id, w.a.accountId, o.paused ? new Date() : null, o.draining === true]);
    return id;
  }

  const confirm = (w: World, runnerId: string) => placeProjectRoute(h.deps(vis), { accountId: w.a.accountId, userId: w.a.o1 }, w.repoId, { kind: "existing", runner_id: runnerId });
  /** What the route answers: the status, the code and the reason a person is shown. */
  const answer = async (w: World, runnerId: string) => {
    const res = await toResponse(() => confirm(w, runnerId));
    const body = res.body as { error?: { code: string }; reason?: string };
    return { status: res.status, code: body.error?.code ?? null, reason: body.reason ?? null };
  };
  const written = async (w: World) => ({
    setups: (await h.admin.query(`SELECT id FROM project_setups WHERE account_id = $1`, [w.a.accountId])).rows.length,
    placements: (await h.admin.query(`SELECT repo_id FROM project_placements WHERE account_id = $1`, [w.a.accountId])).rows.length,
  });

  it("an idle machine whose last load is older than the stale limit is refused as load_unknown, nothing is written, and the account's runners are woken", async () => {
    watchWake();
    const w = await world();
    const m = await machine(w, { loadAgeS: 600 });
    expect(await answer(w, m)).toEqual({ status: 409, code: "machine_not_eligible", reason: "load_unknown" });
    expect(await written(w)).toEqual({ setups: 0, placements: 0 });
    await settle();
    expect(marks).toEqual([runnerWorkKeyFor(w.a.accountId)]);
  });

  it("the same machine with a load one second inside the limit is accepted", async () => {
    const w = await world();
    const m = await machine(w, { loadAgeS: STALE_S - 1 });
    expect(await answer(w, m)).toMatchObject({ status: 201 });
  });

  it("a machine just restarted, whose first claim has not arrived, is refused as load_unknown; its first claim carries the load, and the next confirm goes through", async () => {
    watchWake();
    const w = await world();
    const key: TestKey = newKey();
    const id = await registerKey(h.admin, w.a.accountId, w.a.m1, key);
    const hello = await respond(() => runnerHello(h.deps(), signed(key, HELLO_PATH, { protocol_version: 22, binary_version: "0.5.0", model_auth_present: true, isolation: "host_sandbox", facts: { os: "linux", arch: "x64", mem_gb_bucket: 16, cpus: 8, sandbox_engine: "os_sandbox" }, capabilities: [] })));
    expect(hello.status).toBe(200);
    // Fifteen seconds after the restart: live (it just said hello), signed in, with room, and no load yet.
    expect(await answer(w, id)).toEqual({ status: 409, code: "machine_not_eligible", reason: "load_unknown" });
    await settle();
    expect(marks).toContain(runnerWorkKeyFor(w.a.accountId));
    // The wake makes the runner claim; the claim carries its first load.
    const idle = { claimRunnerRun: async () => ({ kind: "idle" as const, retryAfter: 60 }) } as unknown as RunnerLeaseOps;
    const claimed = await respond(() => claimRun(h.deps({ leases: idle }), signed(key, CLAIM_PATH, { host_load: { mem_avail_mb: 7900, disk_free_mb: 175000, setups_running: 0 } })));
    expect(claimed.status).toBe(200);
    expect(await answer(w, id)).toMatchObject({ status: 201 });
  });

  it("a claim that carried no load leaves the machine refused, so a runner that never reports is never placed", async () => {
    watchWake();
    const w = await world();
    const key: TestKey = newKey();
    const id = await registerKey(h.admin, w.a.accountId, w.a.m1, key);
    await respond(() => runnerHello(h.deps(), signed(key, HELLO_PATH, { protocol_version: 22, binary_version: "0.5.0", model_auth_present: true, isolation: "host_sandbox", facts: { os: "linux", arch: "x64", mem_gb_bucket: 16, cpus: 8, sandbox_engine: "os_sandbox" }, capabilities: [] })));
    const idle = { claimRunnerRun: async () => ({ kind: "idle" as const, retryAfter: 60 }) } as unknown as RunnerLeaseOps;
    expect((await respond(() => claimRun(h.deps({ leases: idle }), signed(key, CLAIM_PATH, {})))).status).toBe(200);
    expect(await answer(w, id)).toMatchObject({ status: 409, reason: "load_unknown" });
  });

  it("the thresholds are not weakened: low memory and low disk are refused with their own reasons, and wake nothing", async () => {
    watchWake();
    const w = await world();
    expect(await answer(w, await machine(w, { loadAgeS: 0, mem: 4095 }))).toEqual({ status: 409, code: "machine_not_eligible", reason: "low_memory" });
    expect(await answer(w, await machine(w, { loadAgeS: 0, disk: 10239 }))).toEqual({ status: 409, code: "machine_not_eligible", reason: "low_disk" });
    await settle();
    expect(marks).toEqual([]);
  });

  it("each other reason is named in the refusal: not_live, paused, draining, claude_not_ready; none wakes anything", async () => {
    watchWake();
    const w = await world();
    const cases: Array<[string, Parameters<typeof machine>[1]]> = [
      ["not_live", { loadAgeS: 0, seenAgo: "1 hour" }],
      ["paused", { loadAgeS: 0, paused: true }],
      ["draining", { loadAgeS: 0, draining: true }],
      ["claude_not_ready", { loadAgeS: 0, claude: false }],
    ];
    for (const [reason, o] of cases) expect(await answer(w, await machine(w, o)), reason).toEqual({ status: 409, code: "machine_not_eligible", reason });
    await settle();
    expect(marks).toEqual([]);
  });

  it("a machine that already runs a project keeps its own code, with no reason beside it", async () => {
    watchWake();
    const w = await world();
    const m = await machine(w, { loadAgeS: 0 });
    expect(await answer(w, m)).toMatchObject({ status: 201 });
    const second = randomUUID();
    await h.admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) VALUES ($1, $2, $3, 'team', 'acme', 'gadgets', 'sandbox')`, [second, w.a.accountId, ++seq]);
    const res = await toResponse(() => placeProjectRoute(h.deps(vis), { accountId: w.a.accountId, userId: w.a.o1 }, second, { kind: "existing", runner_id: m }));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { code: "machine_single_project", message: "this machine already runs a project" } });
  });

  it("the wake is for the caller's own account: another account's idle machine refused at the same time marks only its own key", async () => {
    watchWake();
    const w1 = await world();
    const w2 = await world();
    await answer(w1, await machine(w1, { loadAgeS: 600 }));
    await answer(w2, await machine(w2, { loadAgeS: 600 }));
    await settle();
    expect([...marks].sort()).toEqual([runnerWorkKeyFor(w1.a.accountId), runnerWorkKeyFor(w2.a.accountId)].sort());
  });

  it("a refusal of any kind leaves the error a RunnerHttpError with a closed reason word", async () => {
    const w = await world();
    const m = await machine(w, { loadAgeS: 600 });
    const error = await confirm(w, m).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(RunnerHttpError);
    expect((error as RunnerHttpError).extra).toEqual({ reason: "load_unknown" });
  });
});
