import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { SANDBOX_COMMAND_CAPABILITY, SANDBOX_INVENTORY_MIN_PROTOCOL } from "@fulcrumaxe/runner-protocol";
import { SANDBOX_COMMAND_MAX_OPEN, enqueueSandboxCommand, listRunners } from "../src/index.js";
import { readSandboxViews, SANDBOX_COMMANDS_SHOWN, type RunnerSandboxView } from "../src/fleetSandboxes.js";
import { harness, newKey, registerKey, respond, type Harness } from "./helpers.js";

/**
 * [pg] D#587 B-7b-ii: what GET /api/runners shows about each runner's sandboxes, host limits and recent sandbox commands, on real Postgres with row security
 * forced. Display only: the inventory is the runner's own claim. These tests also pin the account and runner scoping of each query, one table at a time.
 */
describe("the fleet page's sandbox view [pg]", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  type Listed = { runners: Array<{ id: string; sandboxes: RunnerSandboxView | null }> };
  const view = async (f: F2Fixture, userId: string, runnerId: string): Promise<RunnerSandboxView> => {
    const res = await respond(() => listRunners(h.deps(), { accountId: f.accountId, userId }));
    expect(res.status).toBe(200);
    const mine = (res.body as Listed).runners.find((r) => r.id === runnerId);
    return mine!.sandboxes!;
  };
  const box = (name: string, over: Record<string, unknown> = {}) => ({ name, state: "stopped", created_at: "2026-11-01T10:00:00Z", last_used_at: null as string | null, disk_bytes: 2048, snapshot_count: 1, snapshot_age_s: 90 as number | null, ...over });

  /** A microvm runner of the account at protocol 21 with the capability, a facts row with limits, and a report holding `boxes`. */
  async function runner(f: F2Fixture, o: { boxes?: Array<ReturnType<typeof box>> | null; engine?: string; protocol?: number; capable?: boolean; limits?: boolean } = {}): Promise<string> {
    const id = await registerKey(h.admin, f.accountId, f.m1, newKey());
    await h.admin.query("UPDATE runners SET protocol_version = $2 WHERE id = $1", [id, o.protocol ?? SANDBOX_INVENTORY_MIN_PROTOCOL]);
    await h.admin.query("INSERT INTO runner_capabilities (runner_id, account_id, capabilities) VALUES ($1, $2, $3::text[])", [id, f.accountId, o.capable === false ? [] : [SANDBOX_COMMAND_CAPABILITY]]);
    await h.admin.query(
      "INSERT INTO runner_facts (runner_id, account_id, os, arch, mem_gb_bucket, cpus, sandbox_engine, reported_at, max_vms, max_vcpus, max_memory_mb, bootable_templates) VALUES ($1, $2, 'linux', 'x64', 32, 12, $3, now(), $4, $5, $6, $7::text[])",
      [id, f.accountId, o.engine ?? "microvm", o.limits === false ? null : 4, o.limits === false ? null : 16, o.limits === false ? null : 32768, o.limits === false ? [] : ["base-a"]],
    );
    if (o.boxes !== null) {
      const boxes = o.boxes ?? [];
      await h.admin.query("INSERT INTO runner_sandbox_reports (runner_id, account_id, seen_at, row_count) VALUES ($1, $2, now() - interval '5 minutes', $3)", [id, f.accountId, boxes.length]);
      for (const [slot, b] of boxes.entries()) {
        await h.admin.query("INSERT INTO runner_sandboxes (runner_id, slot, account_id, name, state, created_at, last_used_at, disk_bytes, snapshot_count, snapshot_age_s) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)", [id, slot, f.accountId, b.name, b.state, b.created_at, b.last_used_at, b.disk_bytes, b.snapshot_count, b.snapshot_age_s]);
      }
    }
    return id;
  }
  const command = (f: F2Fixture, runnerId: string, o: { kind?: string; name?: string | null; state?: string; refusal?: string; issuedAgoS?: number; lifeS?: number; by?: string }) => {
    const state = o.state ?? "pending";
    const kind = o.kind ?? "delete_sandbox";
    return h.admin.query(
      `INSERT INTO sandbox_commands (account_id, runner_id, kind, name, issued_by, issued_at, expires_at, state, refusal, delivered_at, acked_at)
       VALUES ($1, $2, $3, $4, $5, now() - make_interval(secs => $6), now() - make_interval(secs => $6) + make_interval(secs => $7), $8, $9,
               CASE WHEN $8 IN ('delivered', 'applied', 'refused') THEN now() - make_interval(secs => $6) END, CASE WHEN $8 IN ('applied', 'refused') THEN now() END)`,
      [f.accountId, runnerId, kind, kind === "reap_sandboxes" ? null : o.name === undefined ? "vm-one" : o.name, o.by ?? f.o1, o.issuedAgoS ?? 10, o.lifeS ?? 300, state, o.refusal ?? null],
    );
  };

  it("lists the sandboxes with their times, disk and snapshots, the host limits, and when the runner last reported; a runner that never reported reads 'never'", async () => {
    const f = await seedF2(h.admin);
    const id = await runner(f, { boxes: [box("alpha", { state: "running", last_used_at: "2026-11-02T10:00:00Z", disk_bytes: 5000000000 }), box("beta", { snapshot_age_s: null, snapshot_count: 0 })] });
    const v = await view(f, f.m1, id);
    expect(v).toMatchObject({ status: "current", can_command: true, limits: { vms: 4, vcpus: 16, memory_mb: 32768, templates: ["base-a"] } });
    expect(v.sandboxes).toEqual([
      { name: "alpha", state: "running", created_at: "2026-11-01T10:00:00.000Z", last_used_at: "2026-11-02T10:00:00.000Z", disk_bytes: 5000000000, snapshot_count: 1, snapshot_newest_secs: 90 },
      { name: "beta", state: "stopped", created_at: "2026-11-01T10:00:00.000Z", last_used_at: null, disk_bytes: 2048, snapshot_count: 0, snapshot_newest_secs: null },
    ]);
    expect(Date.now() - Date.parse(v.seen_at!)).toBeGreaterThan(4 * 60_000);
    const never = await view(f, f.m1, await runner(f, { boxes: null, limits: false }));
    expect(never).toMatchObject({ status: "never", seen_at: null, sandboxes: [], can_command: false, limits: { vms: null, vcpus: null, memory_mb: null, templates: [] } });
  });

  it("marks the list stale for a runner that fell below protocol 21 or went back to os_sandbox, and removed for a removed runner; none of them is offered the buttons", async () => {
    const f = await seedF2(h.admin);
    const old = await runner(f, { boxes: [box("alpha")] });
    const back = await runner(f, { boxes: [box("alpha")] });
    const gone = await runner(f, { boxes: [box("alpha")] });
    await h.admin.query("UPDATE runners SET protocol_version = $2 WHERE id = $1", [old, SANDBOX_INVENTORY_MIN_PROTOCOL - 1]);
    await h.admin.query("UPDATE runner_facts SET sandbox_engine = 'os_sandbox' WHERE runner_id = $1", [back]);
    await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [gone]);
    expect(await view(f, f.o1, old)).toMatchObject({ status: "stale_older", can_command: false, sandboxes: [{ name: "alpha" }] });
    expect(await view(f, f.o1, back)).toMatchObject({ status: "stale_engine", can_command: false, sandboxes: [{ name: "alpha" }] });
    expect(await view(f, f.o1, gone)).toMatchObject({ status: "removed", can_command: false, sandboxes: [{ name: "alpha" }] });
    // A runner that does not list the capability is not offered the buttons either, though its list is current.
    expect(await view(f, f.o1, await runner(f, { boxes: [box("alpha")], capable: false }))).toMatchObject({ status: "current", can_command: false });
  });

  it("shows each command in one state: waiting, sent, done, refused with its reason, expired before pickup, and unanswered once a sent one's life is over", async () => {
    const f = await seedF2(h.admin);
    const id = await runner(f, { boxes: [box("alpha")] });
    await command(f, id, { name: "a-pending", issuedAgoS: 10 });
    await command(f, id, { name: "b-sent", state: "delivered", issuedAgoS: 20 });
    await command(f, id, { name: "c-done", state: "applied", issuedAgoS: 30 });
    await command(f, id, { name: "d-refused", state: "refused", refusal: "in_use", issuedAgoS: 40 });
    await command(f, id, { name: "e-expired", issuedAgoS: 900, lifeS: 300 });
    await command(f, id, { name: "f-unanswered", state: "delivered", issuedAgoS: 1000, lifeS: 300 });
    await command(f, id, { kind: "reap_sandboxes", state: "applied", issuedAgoS: 50 });
    const shown = (await view(f, f.m1, id)).commands.map((c) => [c.name, c.state, c.refusal]);
    expect(shown).toEqual([
      ["a-pending", "pending", null],
      ["b-sent", "delivered", null],
      ["c-done", "applied", null],
      ["d-refused", "refused", "in_use"],
      [null, "applied", null],
      ["e-expired", "expired", null],
      ["f-unanswered", "unanswered", null],
    ]);
  });

  it("shows the newest ten commands of the day for a runner, and none of an older day", async () => {
    const f = await seedF2(h.admin);
    const id = await runner(f);
    for (let n = 0; n < SANDBOX_COMMANDS_SHOWN + 3; n++) await command(f, id, { name: `vm-${n}`, state: "applied", issuedAgoS: 100 + n * 10 });
    // A quiet runner of the same account: its newer commands take no slot of the busy runner's ten, and a command of three days ago is gone from its page.
    const quiet = await runner(f);
    await command(f, quiet, { name: "long-ago", state: "applied", issuedAgoS: 3 * 86400, lifeS: 300 });
    await command(f, quiet, { name: "today", state: "applied", issuedAgoS: 60 });
    const names = (await view(f, f.m1, id)).commands.map((c) => c.name);
    expect(names).toHaveLength(SANDBOX_COMMANDS_SHOWN);
    expect(names[0]).toBe("vm-0");
    expect((await view(f, f.m1, quiet)).commands.map((c) => c.name)).toEqual(["today"]);
  });

  it("keeps runners apart inside one account and accounts apart: a second runner's rows and commands never appear, and a foreign account reads nothing even through the role that skips row security", async () => {
    const f = await seedF2(h.admin);
    const other = await seedF2(h.admin);
    const mine = await runner(f, { boxes: [box("mine-box")] });
    const second = await runner(f, { boxes: [box("second-box")] });
    const theirs = await runner(other, { boxes: [box("their-box")] });
    await command(f, mine, { name: "mine-cmd", state: "applied" });
    await command(f, second, { name: "second-cmd", state: "applied" });
    await command(other, theirs, { name: "their-cmd", state: "applied", by: other.o1 });
    const v = await view(f, f.m1, mine);
    expect(v.sandboxes.map((b) => b.name)).toEqual(["mine-box"]);
    expect(v.commands.map((c) => c.name)).toEqual(["mine-cmd"]);
    // The admin client skips row security: only the explicit account predicates keep the other account out.
    const asAdmin = await readSandboxViews({ appUserPool: h.adminPool }, f.accountId, f.o1);
    expect([...asAdmin.keys()].sort()).toEqual([mine, second].sort());
    expect(asAdmin.get(second)!.sandboxes.map((b) => b.name)).toEqual(["second-box"]);
    expect(asAdmin.get(second)!.commands.map((c) => c.name)).toEqual(["second-cmd"]);
    const foreign = await readSandboxViews({ appUserPool: h.adminPool }, randomUUID(), f.o1);
    expect(foreign.size).toBe(0);
    const theirView = await readSandboxViews({ appUserPool: h.adminPool }, other.accountId, other.o1);
    expect(theirView.get(theirs)!.commands.map((c) => c.name)).toEqual(["their-cmd"]);
    expect([...theirView.keys()]).toEqual([theirs]);
  });

  it("every query of the reader names the account in its own predicate, on top of row security (the runner filter in memory would hide a dropped one)", async () => {
    const f = await seedF2(h.admin);
    await runner(f, { boxes: [box("alpha")] });
    const seen: string[] = [];
    const spy = {
      connect: async () => {
        const client = await h.adminPool.connect();
        const run = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
        (client as unknown as { query: unknown }).query = (...a: unknown[]) => (typeof a[0] === "string" && seen.push(a[0]), run(...a));
        return client;
      },
    };
    await readSandboxViews({ appUserPool: spy as never }, f.accountId, f.o1);
    const mine = (table: RegExp) => seen.filter((q) => table.test(q));
    expect(mine(/FROM runners rn/)).toHaveLength(1);
    expect(mine(/FROM runner_sandboxes\b/)).toHaveLength(1);
    expect(mine(/FROM sandbox_commands c/)).toHaveLength(1);
    expect(mine(/FROM runners rn/)[0]).toMatch(/WHERE rn\.account_id = \$1/);
    expect(mine(/FROM runner_sandboxes\b/)[0]).toMatch(/WHERE account_id = \$1/);
    expect(mine(/FROM sandbox_commands c/)[0]).toMatch(/WHERE c\.account_id = \$1/);
  });

  it("the route's answers, then what the page reads: 403 for a member, 404 for a stranger's or unknown runner, 409 for a removed or incapable runner, 429 at twenty waiting; a queued command reads 'pending'", async () => {
    const f = await seedF2(h.admin);
    const other = await seedF2(h.admin);
    const id = await runner(f, { boxes: [box("alpha", { state: "running" })] });
    const ask = (g: F2Fixture, userId: string, runnerId: string, body: unknown) => respond(() => enqueueSandboxCommand(h.deps(), { accountId: g.accountId, userId }, runnerId, body));
    expect(await ask(f, f.m1, id, { kind: "stop_sandbox", name: "alpha" })).toMatchObject({ status: 403 });
    expect(await ask(other, other.o1, id, { kind: "stop_sandbox", name: "alpha" })).toMatchObject({ status: 404 });
    expect(await ask(f, f.o1, randomUUID(), { kind: "reap_sandboxes" })).toMatchObject({ status: 404 });
    const gone = await runner(f);
    await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [gone]);
    expect(await ask(f, f.o1, gone, { kind: "reap_sandboxes" })).toMatchObject({ status: 409, body: { error: { code: "runner_revoked" } } });
    expect(await ask(f, f.o1, await runner(f, { capable: false }), { kind: "reap_sandboxes" })).toMatchObject({ status: 409, body: { error: { code: "not_supported" } } });
    expect(await ask(f, f.a1, id, { kind: "stop_sandbox", name: "alpha" })).toMatchObject({ status: 200, body: { state: "pending" } });
    expect((await view(f, f.m1, id)).commands).toMatchObject([{ kind: "stop_sandbox", name: "alpha", state: "pending" }]);
    for (let n = 1; n < SANDBOX_COMMAND_MAX_OPEN; n++) await ask(f, f.o1, id, { kind: "delete_sandbox", name: `vm-${n}` });
    expect(await ask(f, f.o1, id, { kind: "delete_sandbox", name: "one-too-many" })).toMatchObject({ status: 429, body: { error: { code: "too_many" } } });
  });
});
