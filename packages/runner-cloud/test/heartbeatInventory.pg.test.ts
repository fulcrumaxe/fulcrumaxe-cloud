import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { HEARTBEAT_INVENTORY_CAPABILITY, HEARTBEAT_INVENTORY_HELLO_CAPABILITY, SANDBOX_INVENTORY_MIN_PROTOCOL } from "@fulcrumaxe/runner-protocol";
import { HEARTBEAT_PATH, HELLO_PATH, heartbeatRun, runnerHello, type RunnerLeaseOps } from "../src/index.js";
import { harness, newKey, registerKey, respond, signed, type Harness, type TestKey } from "./helpers.js";

const row = (name: string, over: Record<string, unknown> = {}) => ({ name, state: "running", created_at: "2026-11-21T10:00:00Z", last_used_at: null, disk_bytes: 2048, snapshot_count: 0, snapshot_age_s: null, ...over });
const HELLO = { protocol_version: SANDBOX_INVENTORY_MIN_PROTOCOL, binary_version: "0.5.0", model_auth_present: true, isolation: "host_sandbox" };
const RUN = "11111111-1111-4111-8111-111111111111";

/**
 * [pg] D#587 FU-179: a runner that holds a run sends no claim, so its sandbox inventory rides the heartbeat. Through the real heartbeat and hello routes and the real definer, as the runner login the routes use, with
 * row security forced. The lease worker is a stand-in (it is not under test): `held` says whether the run is still the runner's.
 */
describe("sandbox inventory on the heartbeat [pg]", () => {
  let h: Harness;
  let held = true;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  const leases = {
    heartbeatRunnerRun: async () => (held ? { leaseExpiresAt: new Date("2026-11-21T12:01:30.000Z") } : { reason: "stale_generation" as const }),
  } as unknown as RunnerLeaseOps;
  const beat = (r: { key: TestKey }, extra: Record<string, unknown> = {}) => respond(() => heartbeatRun(h.deps({ leases }), signed(r.key, HEARTBEAT_PATH, { run_id: RUN, lease_generation: 1, ...extra })));
  const hello = (key: TestKey, body: unknown) => respond(() => runnerHello(h.deps(), signed(key, HELLO_PATH, body)));
  const names = async (id: string) => (await h.admin.query<{ name: string }>("SELECT name FROM runner_sandboxes WHERE runner_id = $1 ORDER BY slot", [id])).rows.map((x) => x.name);
  const reports = async (id: string) => (await h.admin.query<{ row_count: number }>("SELECT row_count FROM runner_sandbox_reports WHERE runner_id = $1", [id])).rows[0] ?? null;
  async function runner(f: F2Fixture, protocol: number = SANDBOX_INVENTORY_MIN_PROTOCOL): Promise<{ id: string; key: TestKey }> {
    const key = newKey();
    const id = await registerKey(h.admin, f.accountId, f.m1, key);
    await h.admin.query("UPDATE runners SET protocol_version = $2 WHERE id = $1", [id, protocol]);
    return { id, key };
  }

  it("a job VM appears in the inventory while the run is held, and is gone after the heartbeat that says so", async () => {
    held = true;
    const f = await seedF2(h.admin);
    const r = await runner(f);
    const up = await beat(r, { sandboxes: [row("job-vm-1")] });
    expect(up).toMatchObject({ status: 200, body: { continue: true, sandboxes_recorded: true } });
    expect(await names(r.id)).toEqual(["job-vm-1"]);
    // The next heartbeat carries nothing (nothing changed): the list stays.
    expect(await beat(r)).toMatchObject({ status: 200 });
    expect(await names(r.id)).toEqual(["job-vm-1"]);
    // The VM was destroyed: the list is replaced whole, and an empty one is a report too.
    expect(await beat(r, { sandboxes: [] })).toMatchObject({ status: 200, body: { sandboxes_recorded: true } });
    expect(await names(r.id)).toEqual([]);
    expect((await reports(r.id))?.row_count).toBe(0);
  });

  it("a heartbeat without the block answers the old reply byte for byte", async () => {
    held = true;
    const f = await seedF2(h.admin);
    const r = await runner(f);
    expect(await beat(r)).toEqual({ status: 200, body: { continue: true, lease_expires_at: "2026-11-21T12:01:30.000Z" } });
    expect(await reports(r.id)).toBeNull();
  });

  it("a run the runner no longer holds is the stop answer and stores nothing", async () => {
    held = false;
    const f = await seedF2(h.admin);
    const r = await runner(f);
    expect(await beat(r, { sandboxes: [row("late")] })).toMatchObject({ status: 409, body: { continue: false } });
    expect(await names(r.id)).toEqual([]);
    expect(await reports(r.id)).toBeNull();
  });

  it("an inventory the definer refuses (a runner below the inventory protocol minimum) does not cost the lease: OK without sandboxes_recorded", async () => {
    held = true;
    const f = await seedF2(h.admin);
    const r = await runner(f, SANDBOX_INVENTORY_MIN_PROTOCOL - 1);
    const res = await beat(r, { sandboxes: [row("x")] });
    expect(res).toEqual({ status: 200, body: { continue: true, lease_expires_at: "2026-11-21T12:01:30.000Z" } });
    expect(await names(r.id)).toEqual([]);
  });

  it("the schema refuses an unknown key in a row and more rows than the cap, as a claim does", async () => {
    held = true;
    const f = await seedF2(h.admin);
    const r = await runner(f);
    expect(await beat(r, { sandboxes: [{ ...row("a"), host: "box" }] })).toMatchObject({ status: 400, body: { error: { code: "invalid_message" } } });
    expect(await beat(r, { sandboxes: Array.from({ length: 201 }, (_, i) => row(`v${i}`)) })).toMatchObject({ status: 400 });
    expect(await names(r.id)).toEqual([]);
  });

  it("one runner's heartbeat never writes another runner's list", async () => {
    held = true;
    const f = await seedF2(h.admin);
    const a = await runner(f);
    const b = await runner(f);
    await beat(b, { sandboxes: [row("b-vm")] });
    await beat(a, { sandboxes: [row("a-vm")] });
    expect(await names(a.id)).toEqual(["a-vm"]);
    expect(await names(b.id)).toEqual(["b-vm"]);
  });

  describe("the hello lists heartbeat_inventory only to a runner that declared it", () => {
    const caps = async (r: { key: TestKey }, body: Record<string, unknown>) => ((await hello(r.key, { ...HELLO, ...body })).body as { capabilities?: string[] }).capabilities;
    it("declared at protocol 21: listed", async () => {
      const r = await runner(await seedF2(h.admin));
      expect(await caps(r, { capabilities: [HEARTBEAT_INVENTORY_HELLO_CAPABILITY] })).toEqual([HEARTBEAT_INVENTORY_CAPABILITY]);
    });
    it("not declared: the reply is the one it always was", async () => {
      const r = await runner(await seedF2(h.admin));
      expect(await caps(r, { capabilities: [] })).toBeUndefined();
      expect(await caps(r, {})).toBeUndefined();
    });
    it("declared below protocol 21: the hello is refused as invalid", async () => {
      const r = await runner(await seedF2(h.admin));
      expect(await hello(r.key, { ...HELLO, protocol_version: SANDBOX_INVENTORY_MIN_PROTOCOL - 1, capabilities: [HEARTBEAT_INVENTORY_HELLO_CAPABILITY] })).toMatchObject({ status: 400, body: { error: { code: "invalid_message" } } });
    });
  });
});
