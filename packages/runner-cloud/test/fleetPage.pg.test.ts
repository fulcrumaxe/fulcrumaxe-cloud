import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { REVOKED_REGISTRANT_LEFT_NOTE, listRunners, type AccountLine, type RunnerRow } from "../src/index.js";
import { NOT_YOUR_RUNNER_REASON, SET_BY_SOMEONE_ELSE_REASON } from "../src/fleetView.js";
import { harness, respond, type Harness } from "./helpers.js";

/**
 * [pg] D#605 FL-9: what GET /api/runners adds for the fleet page, on real Postgres with row security forced: the name, labels and facts, the runs a
 * runner holds, the controls each caller is offered, the account line, and the "Register this machine again" data for a runner whose registrant left.
 */
const NOW = new Date("2026-10-15T12:00:00.000Z");
const ago = (s: number) => new Date(NOW.getTime() - s * 1000);

describe("the fleet page read [pg]", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  const fresh = (): Promise<F2Fixture> => seedF2(h.admin);
  const deps = (over: Parameters<Harness["deps"]>[0] = {}) => h.deps({ now: () => NOW, ...over });
  type Body = { runners: RunnerRow[]; viewer: { role: string } | null; account: AccountLine };
  const list = async (f: F2Fixture, userId: string, over: Parameters<Harness["deps"]>[0] = {}): Promise<Body> => {
    const res = await respond(() => listRunners(deps(over), { accountId: f.accountId, userId }));
    expect(res.status).toBe(200);
    return res.body as Body;
  };

  const installations = new Map<string, string>();
  async function newRepo(f: F2Fixture, name = `app-${randomUUID().slice(0, 6)}`): Promise<string> {
    let installationId = installations.get(f.accountId);
    if (!installationId) {
      installationId = randomUUID();
      await h.admin.query("INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, floor(random() * 2000000000)::bigint + 1, 'team')", [installationId, f.accountId]);
      installations.set(f.accountId, installationId);
    }
    const id = randomUUID();
    await h.admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, floor(random() * 2000000000)::bigint + 1, 'team', 'acme', $4)", [id, f.accountId, installationId, name]);
    return id;
  }
  async function runner(f: F2Fixture, by: string, over: { lastSeen?: Date; repos?: string[]; capacity?: [number, number]; revokedReason?: string } = {}): Promise<string> {
    const id = await insertRunner(h.admin, f.accountId, by);
    await h.admin.query("UPDATE runners SET last_seen_at = $2, protocol_version = 3, binary_version = '0.9.1', allowed_repo_ids = $3::uuid[], revoked_at = $4, revoked_reason = $5 WHERE id = $1", [
      id,
      over.lastSeen ?? ago(5),
      over.repos ?? [],
      over.revokedReason ? ago(1) : null,
      over.revokedReason ?? null,
    ]);
    if (over.capacity) await h.admin.query("INSERT INTO runner_capacity (runner_id, account_id, declared, light_limit, heavy_limit) VALUES ($1, $2, true, $3, $4)", [id, f.accountId, over.capacity[0], over.capacity[1]]);
    return id;
  }
  const setting = (id: string, f: F2Fixture, over: { name?: string; labels?: string[]; pausedBy?: string; drainedBy?: string }) =>
    h.admin.query("INSERT INTO runner_settings (runner_id, account_id, name, labels, paused_at, paused_by, draining, drained_by) VALUES ($1, $2, $3, $4::text[], $5, $6, $7, $8)", [
      id, f.accountId, over.name ?? null, over.labels ?? [], over.pausedBy ? ago(10) : null, over.pausedBy ?? null, over.drainedBy !== undefined, over.drainedBy ?? null,
    ]);

  it("returns the name, labels and facts a runner has; a runner nobody named reads Unnamed runner (registrant) and its facts are null until it reports them", async () => {
    const f = await fresh();
    const named = await runner(f, f.a1);
    const bare = await runner(f, f.a1);
    await setting(named, f, { name: "Desktop", labels: ["gpu", "macos"] });
    await h.admin.query("INSERT INTO runner_facts (runner_id, account_id, os, arch, mem_gb_bucket, cpus, sandbox_engine, reported_at) VALUES ($1, $2, 'macos', 'arm64', 32, 12, 'os_sandbox', now())", [named, f.accountId]);
    const rows = new Map((await list(f, f.m1)).runners.map((r) => [r.id, r]));
    expect(rows.get(named)).toMatchObject({ name: "Desktop", labels: ["gpu", "macos"], facts: { os: "macos", arch: "arm64", engine: "os_sandbox" } });
    expect(rows.get(bare)).toMatchObject({ name: expect.stringMatching(/^Unnamed runner \(.+\)$/), has_name: false, labels: [], facts: null, current_runs: [] });
    expect(JSON.stringify(rows.get(bare)!.name)).not.toMatch(/null|undefined/);
  });

  it("lists the runs a runner holds with a live lease, named by role and repository, and not a run whose lease ran out or another runner's", async () => {
    const f = await fresh();
    const repo = await newRepo(f, "web");
    const mine = await runner(f, f.a1, { repos: [repo] });
    const other = await runner(f, f.a1, { repos: [repo] });
    const live = randomUUID();
    const lost = randomUUID();
    const elsewhere = randomUUID();
    for (const [id, runnerId, lease] of [[live, mine, new Date(NOW.getTime() + 60_000)], [lost, mine, NOW], [elsewhere, other, new Date(NOW.getTime() + 60_000)]] as const) {
      await h.admin.query("INSERT INTO agent_runs (id, account_id, role, runtime, status, runner_id, lease_expires_at, dispatch_repo_id) VALUES ($1, $2, 'executor', 'runner', 'running', $3, $4, $5)", [id, f.accountId, runnerId, lease, repo]);
    }
    const rows = new Map((await list(f, f.m1)).runners.map((r) => [r.id, r]));
    expect(rows.get(mine)!.current_runs).toEqual([{ id: live, label: "fulcrumaxe executor · acme/web" }]);
    expect(rows.get(other)!.current_runs).toEqual([{ id: elsewhere, label: "fulcrumaxe executor · acme/web" }]);
  });

  it("offers each caller only what the database would allow, with the reason for the rest (FL-8 role rules)", async () => {
    const f = await fresh();
    const id = await runner(f, f.m1);
    const as = async (user: string) => (await list(f, user)).runners.find((r) => r.id === id)!.controls!;
    // The registrant: everything. Another member: nothing, with the reason. An admin: everything.
    expect(await as(f.m1)).toMatchObject({ pause: { allowed: true, reason: null }, drain: { allowed: true }, rename: { allowed: true }, remove: { allowed: true }, resume: { allowed: false, reason: "Not paused." } });
    expect(await as(f.m2)).toMatchObject({ pause: { allowed: false, reason: NOT_YOUR_RUNNER_REASON }, remove: { allowed: false, reason: NOT_YOUR_RUNNER_REASON } });
    expect((await as(f.a2)).resume).toMatchObject({ allowed: false });
    // An owner pauses it: the registrant may not resume it (403 at the database), an admin may.
    await setting(id, f, { pausedBy: f.o1 });
    expect((await as(f.m1)).resume).toEqual({ allowed: false, reason: SET_BY_SOMEONE_ELSE_REASON });
    expect((await as(f.m1)).pause).toMatchObject({ allowed: false });
    expect((await as(f.a1)).resume).toEqual({ allowed: true, reason: null });
    // A pause the registrant set themselves, they may end.
    await h.admin.query("UPDATE runner_settings SET paused_by = $2 WHERE runner_id = $1", [id, f.m1]);
    expect((await as(f.m1)).resume).toEqual({ allowed: true, reason: null });
  });

  it("holds the account line to the limit: summed live capacity 20 against a limit of 16 reads 16, and paused, offline and removed runners add nothing", async () => {
    const f = await fresh();
    for (const cap of [[8, 0], [8, 4], [4, 0]] as Array<[number, number]>) await runner(f, f.a1, { capacity: cap });
    const paused = await runner(f, f.a1, { capacity: [8, 0] });
    await setting(paused, f, { pausedBy: f.a1 });
    await runner(f, f.a1, { capacity: [8, 0], lastSeen: ago(300) });
    await runner(f, f.a1, { capacity: [8, 0], revokedReason: "revoked" });
    // 8 + 8 (light 8 + heavy 4 is held to the per-runner 8 in all) + 4 = 20 online and unpaused.
    const runnerPlan = { accountJobLimit: () => ({ jobs: 16, hosted: false }), maxRunners: () => 5 };
    expect((await list(f, f.m1, runnerPlan)).account).toEqual({ limit: 16, capacity: 16, running: 0, runner_count: 5, runner_limit: 5 });
    expect((await list(f, f.m1, { ...runnerPlan, accountJobLimit: () => ({ jobs: 32, hosted: false }) })).account).toMatchObject({ limit: 32, capacity: 20 });
  });

  it("takes a hosted account's own setting over the plan default, and reports no limit (not zero) while the plan data cannot say", async () => {
    const f = await fresh();
    await runner(f, f.a1, { capacity: [8, 0] });
    const hosted = { accountJobLimit: () => ({ jobs: 4, hosted: true }) };
    expect((await list(f, f.m1, hosted)).account).toMatchObject({ limit: 4, capacity: 4 });
    await h.admin.query("INSERT INTO account_runner_concurrency (account_id, total_jobs, per_repo_jobs, updated_by) VALUES ($1, 12, 2, $2)", [f.accountId, f.o1]);
    expect((await list(f, f.m1, hosted)).account).toMatchObject({ limit: 12, capacity: 8 });
    const unavailable = { accountJobLimit: () => { throw new Error("no plan data"); }, maxRunners: () => { throw new Error("no plan data"); } };
    expect((await list(f, f.m1, unavailable)).account).toMatchObject({ limit: null, capacity: 8, runner_limit: null });
  });

  it("shows a runner revoked because its registrant left as 'Revoked: registrant left' with the data to register it again, to an owner or admin only; any other removal reads plain Revoked", async () => {
    const f = await fresh();
    const repo = await newRepo(f, "api");
    const gone = await runner(f, f.m2, { repos: [repo], revokedReason: "member_demoted" });
    const removed = await runner(f, f.m2, { repos: [repo], revokedReason: "revoked" });
    await setting(gone, f, { name: "Old laptop", labels: ["gpu"] });
    const byAdmin = new Map((await list(f, f.a1)).runners.map((r) => [r.id, r]));
    expect(byAdmin.get(gone)).toMatchObject({ state: "revoked", state_note: REVOKED_REGISTRANT_LEFT_NOTE, revoked_reason: "registrant_left", controls: null, repos: [], register_again: { name: "Old laptop", labels: ["gpu"], repo_ids: [repo] } });
    expect(byAdmin.get(removed)).toMatchObject({ state: "revoked", state_note: null, revoked_reason: null, controls: null, register_again: null });
    const byMember = new Map((await list(f, f.m1)).runners.map((r) => [r.id, r]));
    expect(byMember.get(gone)).toMatchObject({ state_note: REVOKED_REGISTRANT_LEFT_NOTE, controls: null, register_again: null });
  });

  it("never shows another account's runner, and gives a non-member 403", async () => {
    const f = await fresh();
    const g = await fresh();
    await runner(g, g.a1);
    expect((await list(f, f.m1)).runners).toEqual([]);
    expect(await respond(() => listRunners(deps(), { accountId: f.accountId, userId: g.a1 }))).toMatchObject({ status: 403 });
  });
});
