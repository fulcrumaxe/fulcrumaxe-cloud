import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { insertRunner } from "@fx/db/test/helpers/runnerFixtures.js";
import { capacityOf, getRunWait, getRunWaitReason, listRunners, loadLabel, waitReasonOf, type RawRun, type RunnerRow } from "../src/index.js";
import { harness, respond, type Harness } from "./helpers.js";

const NOW = new Date("2026-10-08T12:00:00.000Z");
const ago = (seconds: number): Date => new Date(NOW.getTime() - seconds * 1000);
const ahead = (seconds: number): Date => new Date(NOW.getTime() + seconds * 1000);

describe("capacityOf and loadLabel (D#6 C43-2b, pure)", () => {
  const none = { light: 0, heavy: 0 };
  it("is null before the first claim, which the screen words as unknown", () => {
    expect(capacityOf(null, none)).toBeNull();
    expect(loadLabel("busy", { light: 1, heavy: 0 }, null)).toBe("Busy · capacity unknown");
  });
  it("reads a runner that declared nothing as one job in total", () => {
    expect(capacityOf({ declared: false, light_limit: null, heavy_limit: null }, { light: 1, heavy: 0 })).toEqual({ light: { limit: 1, in_use: 1 }, heavy: { limit: 1, in_use: 0 }, total_limit: 1, limited_by: null });
  });
  it("keeps a declared one inside the ceilings: light 8, heavy 4, total 8", () => {
    expect(capacityOf({ declared: true, light_limit: 3, heavy_limit: 1 }, none)!.total_limit).toBe(4);
    expect(capacityOf({ declared: true, light_limit: 8, heavy_limit: 4 }, none)!.total_limit).toBe(8);
    expect(capacityOf({ declared: true, light_limit: 20, heavy_limit: 9 }, none)).toEqual({ light: { limit: 8, in_use: 0 }, heavy: { limit: 4, in_use: 0 }, total_limit: 8, limited_by: null });
  });
  it("words a busy runner as 'Busy · 2 of 4' and says nothing for the other states", () => {
    const cap = capacityOf({ declared: true, light_limit: 3, heavy_limit: 1 }, { light: 1, heavy: 1 });
    expect(loadLabel("busy", { light: 1, heavy: 1 }, cap)).toBe("Busy · 2 of 4");
    for (const state of ["online_idle", "offline", "outdated", "revoked"] as const) expect(loadLabel(state, none, cap)).toBeNull();
  });
});

describe("waitReasonOf with a full runner (pure)", () => {
  const row = (over: Partial<RawRun> = {}): RawRun => ({
    id: "r", work_item_id: null, role: "executor", dispatch_repo_id: "x", created_at: NOW, status: "pending", runtime: "runner", initiated_by: "u", approved_by: "u",
    own_reason: null, parent_reason: null, claimable_after: null, runnable_without_approval: true, needs_approval_possible: true, runner_online: true, runner_slot_free: true, slot_limited_by: null, ...over,
  });
  it("is waiting_for_runner_slot only when a runner is online and none has a free slot", () => {
    expect(waitReasonOf(row(), NOW)).toBeNull();
    expect(waitReasonOf(row({ runner_slot_free: false }), NOW)).toBe("waiting_for_runner_slot");
    expect(waitReasonOf(row({ runner_slot_free: false, runner_online: false }), NOW)).toBe("waiting_for_runner");
  });
});

describe("the runner list and wait reason with capacity [pg]", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  const deps = () => h.deps({ now: () => NOW });
  const installations = new Map<string, string>();
  async function repo(f: F2Fixture): Promise<string> {
    let installationId = installations.get(f.accountId);
    if (!installationId) {
      installationId = randomUUID();
      await h.admin.query("INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, floor(random() * 2000000000)::bigint + 1, 'team')", [installationId, f.accountId]);
      installations.set(f.accountId, installationId);
    }
    const repoId = randomUUID();
    await h.admin.query("INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, floor(random() * 2000000000)::bigint + 1, 'team')", [repoId, f.accountId, installationId]);
    return repoId;
  }
  async function runner(f: F2Fixture, repoId: string, cap: { light: number; heavy: number; limitedBy?: string } | "legacy" | null): Promise<string> {
    const id = await insertRunner(h.admin, f.accountId, f.a1, { credentialMode: "api_key" });
    await h.admin.query("UPDATE runners SET last_seen_at = $2, protocol_version = 3, allowed_repo_ids = $3::uuid[] WHERE id = $1", [id, ago(5), [repoId]]);
    if (cap === "legacy") await h.admin.query("INSERT INTO runner_capacity (runner_id, account_id, declared) VALUES ($1, $2, false)", [id, f.accountId]);
    else if (cap) await h.admin.query("INSERT INTO runner_capacity (runner_id, account_id, declared, light_limit, heavy_limit, limited_by) VALUES ($1, $2, true, $3, $4, $5)", [id, f.accountId, cap.light, cap.heavy, cap.limitedBy ?? null]);
    return id;
  }
  async function run(f: F2Fixture, repoId: string, o: { role: string; status?: string; runnerId?: string | null; lease?: Date | null }): Promise<string> {
    const id = randomUUID();
    await h.admin.query(
      `INSERT INTO agent_runs (id, account_id, role, runtime, status, initiated_by, approved_by, runner_id, lease_expires_at, dispatch_repo_id)
       VALUES ($1, $2, $3, 'runner', $4, $5, $5, $6, $7, $8)`,
      [id, f.accountId, o.role, o.status ?? "running", f.a1, o.runnerId ?? null, o.lease === undefined ? ahead(60) : o.lease, repoId],
    );
    return id;
  }
  const mine = async (f: F2Fixture): Promise<Map<string, RunnerRow>> => {
    const res = await respond(() => listRunners(deps(), { accountId: f.accountId, userId: f.a1 }));
    expect(res.status).toBe(200);
    return new Map((res.body as { runners: RunnerRow[] }).runners.map((r) => [r.id, r]));
  };
  const reason = (f: F2Fixture, id: string) => getRunWaitReason(deps(), f.accountId, id);

  it("shows what a runner holds per class, what it can hold, and 'Busy · 2 of 4'", async () => {
    const f = await seedF2(h.admin);
    const r = await repo(f);
    const id = await runner(f, r, { light: 3, heavy: 1 });
    await run(f, r, { role: "code-reviewer", runnerId: id });
    await run(f, r, { role: "executor", runnerId: id });
    await run(f, r, { role: "executor", runnerId: id, lease: ago(1) }); // its lease ran out: neither busy nor in use
    await run(f, r, { role: "code-reviewer", runnerId: id, status: "succeeded" });
    const row = (await mine(f)).get(id)!;
    expect(row.state).toBe("busy");
    expect(row.running).toEqual({ light: 1, heavy: 1 });
    expect(row.capacity).toEqual({ light: { limit: 3, in_use: 1 }, heavy: { limit: 1, in_use: 1 }, total_limit: 4, limited_by: null });
    expect(row.load_label).toBe("Busy · 2 of 4");
  });

  it("an idle runner shows its capacity and no label; one that never claimed shows capacity unknown (null), never an undefined", async () => {
    const f = await seedF2(h.admin);
    const r = await repo(f);
    const idle = await runner(f, r, { light: 2, heavy: 1 });
    const fresh = await runner(f, r, null);
    const rows = await mine(f);
    expect(rows.get(idle)).toMatchObject({ state: "online_idle", running: { light: 0, heavy: 0 }, load_label: null });
    expect(rows.get(idle)!.capacity!.total_limit).toBe(3);
    expect(rows.get(fresh)).toMatchObject({ capacity: null, load_label: null });
    expect(JSON.stringify([...rows.values()])).not.toContain("undefined");
  });

  it("a runner that declared nothing reads as one job in total, and a busy one says 'Busy · 1 of 1'", async () => {
    const f = await seedF2(h.admin);
    const r = await repo(f);
    const id = await runner(f, r, "legacy");
    await run(f, r, { role: "executor", runnerId: id });
    const row = (await mine(f)).get(id)!;
    expect(row.capacity).toMatchObject({ total_limit: 1 });
    expect(row.load_label).toBe("Busy · 1 of 1");
  });

  it("a revoked runner shows no capacity, whatever it declared", async () => {
    const f = await seedF2(h.admin);
    const r = await repo(f);
    const id = await runner(f, r, { light: 3, heavy: 1 });
    await h.admin.query("UPDATE runners SET revoked_at = $2 WHERE id = $1", [id, ago(1)]);
    expect((await mine(f)).get(id)).toMatchObject({ state: "revoked", capacity: null, running: { light: 0, heavy: 0 } });
  });

  describe("waiting_for_runner_slot", () => {
    it("a heavy run waits when the only runner's heavy slot is used, though its light slots are free; a light run does not", async () => {
      const f = await seedF2(h.admin);
      const r = await repo(f);
      const id = await runner(f, r, { light: 3, heavy: 1 });
      await run(f, r, { role: "executor", runnerId: id });
      const heavy = await run(f, r, { role: "executor", status: "pending", runnerId: null, lease: null });
      const light = await run(f, r, { role: "code-reviewer", status: "pending", runnerId: null, lease: null });
      expect(await reason(f, heavy)).toBe("waiting_for_runner_slot");
      expect(await reason(f, light)).toBeNull();
    });

    it("the total ceiling counts: 8 light jobs fill a runner declaring light 8 and heavy 4, so a heavy run waits", async () => {
      const f = await seedF2(h.admin);
      const r = await repo(f);
      const id = await runner(f, r, { light: 8, heavy: 4 });
      for (let i = 0; i < 8; i++) await run(f, r, { role: "code-reviewer", runnerId: id });
      expect(await reason(f, await run(f, r, { role: "executor", status: "pending", runnerId: null, lease: null }))).toBe("waiting_for_runner_slot");
    });

    it("a runner that declared nothing holds one job in total: busy with a light run, a second run waits", async () => {
      const f = await seedF2(h.admin);
      const r = await repo(f);
      const id = await runner(f, r, "legacy");
      await run(f, r, { role: "code-reviewer", runnerId: id });
      expect(await reason(f, await run(f, r, { role: "code-reviewer", status: "pending", runnerId: null, lease: null }))).toBe("waiting_for_runner_slot");
    });

    it("another runner with room for the class ends the wait, and so does one that has not claimed yet", async () => {
      const f = await seedF2(h.admin);
      const r = await repo(f);
      const full = await runner(f, r, { light: 1, heavy: 1 });
      await run(f, r, { role: "executor", runnerId: full });
      const pending = await run(f, r, { role: "executor", status: "pending", runnerId: null, lease: null });
      expect(await reason(f, pending)).toBe("waiting_for_runner_slot");
      const roomy = await runner(f, r, { light: 1, heavy: 2 });
      expect(await reason(f, pending)).toBeNull();
      await h.admin.query("UPDATE runners SET revoked_at = $2 WHERE id = $1", [roomy, ago(1)]);
      expect(await reason(f, pending)).toBe("waiting_for_runner_slot");
      await runner(f, r, null);
      expect(await reason(f, pending)).toBeNull();
    });

    it("says why when the runners gave a cause (paused before memory, cpu, disk, ceiling), and plain waiting_for_runner_slot when none did", async () => {
      const f = await seedF2(h.admin);
      const r = await repo(f);
      const id = await runner(f, r, { light: 1, heavy: 1 });
      await run(f, r, { role: "executor", runnerId: id });
      const pending = await run(f, r, { role: "executor", status: "pending", runnerId: null, lease: null });
      expect(await getRunWait(deps(), f.accountId, pending)).toEqual({ reason: "waiting_for_runner_slot", limited_by: null });
      await h.admin.query("UPDATE runner_capacity SET limited_by = 'memory' WHERE runner_id = $1", [id]);
      expect(await getRunWait(deps(), f.accountId, pending)).toEqual({ reason: "waiting_for_runner_slot", limited_by: "memory" });
      const other = await runner(f, r, { light: 1, heavy: 1, limitedBy: "paused" });
      await run(f, r, { role: "executor", runnerId: other });
      expect(await getRunWait(deps(), f.accountId, pending)).toEqual({ reason: "waiting_for_runner_slot", limited_by: "paused" });
      expect((await mine(f)).get(id)!.capacity!.limited_by).toBe("memory");
    });

    it("a cause belongs to the slot wait only: a run with a free slot carries none", async () => {
      const f = await seedF2(h.admin);
      const r = await repo(f);
      await runner(f, r, { light: 2, heavy: 2, limitedBy: "cpu" });
      const pending = await run(f, r, { role: "executor", status: "pending", runnerId: null, lease: null });
      expect(await getRunWait(deps(), f.accountId, pending)).toEqual({ reason: null, limited_by: null });
    });

    it("derived, not stored: when the job ends the reason is gone, and a runner for another repo does not count", async () => {
      const f = await seedF2(h.admin);
      const r = await repo(f);
      const other = await repo(f);
      const id = await runner(f, r, { light: 1, heavy: 1 });
      const held = await run(f, r, { role: "executor", runnerId: id });
      await runner(f, other, { light: 3, heavy: 3 });
      const pending = await run(f, r, { role: "executor", status: "pending", runnerId: null, lease: null });
      expect(await reason(f, pending)).toBe("waiting_for_runner_slot");
      await h.admin.query("UPDATE agent_runs SET status = 'succeeded' WHERE id = $1", [held]);
      expect(await reason(f, pending)).toBeNull();
    });
  });
});
