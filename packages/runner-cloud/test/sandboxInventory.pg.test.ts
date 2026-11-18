import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { SANDBOX_INVENTORY_MIN_PROTOCOL } from "@fulcrumaxe/runner-protocol";
import { CLAIM_PATH, HELLO_PATH, claimRun, runnerHello, type RunnerLeaseOps } from "../src/index.js";
import { harness, newKey, registerKey, respond, signed, type Harness, type TestKey } from "./helpers.js";

const row = (name: string, over: Record<string, unknown> = {}) => ({ name, state: "stopped", created_at: "2026-11-01T10:00:00Z", last_used_at: null, disk_bytes: 1024, snapshot_count: 1, snapshot_age_s: 60, ...over });
const HELLO = { protocol_version: SANDBOX_INVENTORY_MIN_PROTOCOL, binary_version: "0.5.0", model_auth_present: true, isolation: "host_sandbox" };
const FACTS = { os: "linux", arch: "x64", mem_gb_bucket: 32, cpus: 12, sandbox_engine: "microvm" };

/**
 * [pg] D#587 B-7a: the sandbox inventory and the host limits, through the real claim and hello routes and the real definers, as the runner login the routes use, with row security
 * forced. The inventory is routing and display data: these tests also show what is stored, per runner and per account, and that the cloud refuses what it must.
 */
describe("sandbox inventory and host limits [pg]", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  const idle = { claimRunnerRun: async () => ({ kind: "idle" as const, retryAfter: 60 }) } as unknown as RunnerLeaseOps;
  const open = (id: string) => h.admin.query("UPDATE runner_claim_stamps SET last_claim_at = now() - interval '1 hour' WHERE runner_id = $1", [id]);
  const claim = async (r: { id: string; key: TestKey }, body: unknown) => {
    await open(r.id);
    return respond(() => claimRun(h.deps({ leases: idle }), signed(r.key, CLAIM_PATH, body)));
  };
  const hello = (key: TestKey, body: unknown) => respond(() => runnerHello(h.deps(), signed(key, HELLO_PATH, body)));
  const names = async (id: string) => (await h.admin.query<{ name: string }>("SELECT name FROM runner_sandboxes WHERE runner_id = $1 ORDER BY slot", [id])).rows.map((r) => r.name);
  const report = async (id: string) => (await h.admin.query<{ seen_at: Date; row_count: number }>("SELECT seen_at, row_count FROM runner_sandbox_reports WHERE runner_id = $1", [id])).rows[0] ?? null;
  async function runner(f: F2Fixture, protocol: number | null = SANDBOX_INVENTORY_MIN_PROTOCOL): Promise<{ id: string; key: TestKey }> {
    const key = newKey();
    const id = await registerKey(h.admin, f.accountId, f.m1, key);
    if (protocol !== null) await h.admin.query("UPDATE runners SET protocol_version = $2 WHERE id = $1", [id, protocol]);
    return { id, key };
  }

  it("stores the list, replaces it whole on the next one, and keeps the time of the last report; an empty list is a report too", async () => {
    const f = await seedF2(h.admin);
    const r = await runner(f);
    expect(await report(r.id)).toBeNull();
    expect(await claim(r, { sandboxes: [row("alpha"), row("beta", { state: "running", last_used_at: "2026-11-02T10:00:00Z", snapshot_age_s: null })] })).toMatchObject({ status: 200 });
    expect(await names(r.id)).toEqual(["alpha", "beta"]);
    const first = await report(r.id);
    expect(first?.row_count).toBe(2);
    expect((await h.admin.query("SELECT state, last_used_at, snapshot_age_s FROM runner_sandboxes WHERE runner_id = $1 AND name = 'beta'", [r.id])).rows[0]).toMatchObject({ state: "running", snapshot_age_s: null });
    expect(await claim(r, { sandboxes: [row("gamma")] })).toMatchObject({ status: 200 });
    expect(await names(r.id)).toEqual(["gamma"]);
    expect((await report(r.id))!.seen_at.getTime()).toBeGreaterThanOrEqual(first!.seen_at.getTime());
    expect(await claim(r, { sandboxes: [] })).toMatchObject({ status: 200 });
    expect(await names(r.id)).toEqual([]);
    expect((await report(r.id))?.row_count).toBe(0);
  });

  it("a claim without the block leaves the list and the seen time as they were", async () => {
    const f = await seedF2(h.admin);
    const r = await runner(f);
    await claim(r, { sandboxes: [row("alpha")] });
    const before = await report(r.id);
    expect(await claim(r, {})).toMatchObject({ status: 200 });
    expect(await names(r.id)).toEqual(["alpha"]);
    expect((await report(r.id))!.seen_at).toEqual(before!.seen_at);
  });

  it("refuses unknown keys (on the block, on a row), a bad name, a bad state, a repeated name and 201 rows as 400, and changes nothing", async () => {
    const f = await seedF2(h.admin);
    const r = await runner(f);
    await claim(r, { sandboxes: [row("keep")] });
    const bad: unknown[] = [
      { sandboxes: [row("a"), { ...row("b"), log_tail: "x" }] },
      { sandboxes: [{ ...row("a"), path: "/srv/x" }] },
      { sandboxes: [row("A_B")] },
      { sandboxes: [row("-a")] },
      { sandboxes: [row("a".repeat(41))] },
      { sandboxes: [row("a", { state: "exploding" })] },
      { sandboxes: [row("a"), row("a")] },
      { sandboxes: Array.from({ length: 201 }, (_v, i) => row(`s${i}`)) },
      { sandboxes: [row("a", { disk_bytes: -1 })] },
      { sandboxes: [row("a", { created_at: "yesterday" })] },
      // Passes the schema's shape but is not a date: the database refuses it (22008) and the route answers 400, not 500.
      { sandboxes: [row("a", { created_at: "2026-13-45T10:00:00Z" })] },
      { sandboxes: [row("a", { last_used_at: "2026-02-31T25:61:61Z" })] },
      { sandboxes: [row("a")], extra: 1 },
    ];
    for (const body of bad) expect(await claim(r, body), JSON.stringify(body).slice(0, 80)).toMatchObject({ status: 400 });
    expect(await names(r.id)).toEqual(["keep"]);
  });

  it("accepts exactly 200 rows, and the table cannot hold a 201st for one runner whatever wrote it", async () => {
    const f = await seedF2(h.admin);
    const r = await runner(f);
    expect(await claim(r, { sandboxes: Array.from({ length: 200 }, (_v, i) => row(`s${i}`)) })).toMatchObject({ status: 200 });
    expect((await names(r.id)).length).toBe(200);
    await expect(h.admin.query("INSERT INTO runner_sandboxes (runner_id, slot, account_id, name, state, created_at, disk_bytes, snapshot_count) VALUES ($1, 200, $2, 'extra', 'stopped', now(), 0, 0)", [r.id, f.accountId])).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses the block from a runner whose hello declared less than the gate, and from a revoked runner (401)", async () => {
    const f = await seedF2(h.admin);
    const old = await runner(f, SANDBOX_INVENTORY_MIN_PROTOCOL - 1);
    expect(await claim(old, { sandboxes: [row("a")] })).toMatchObject({ status: 400 });
    expect(await claim(old, {})).toMatchObject({ status: 200 });
    expect(await names(old.id)).toEqual([]);
    const gone = await runner(f);
    await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [gone.id]);
    expect(await claim(gone, { sandboxes: [row("a")] })).toMatchObject({ status: 401 });
    expect(await names(gone.id)).toEqual([]);
  });

  it("a status poll still takes the block only when it passed the throttle, and a throttled claim stores nothing", async () => {
    const f = await seedF2(h.admin);
    const r = await runner(f);
    await claim(r, { sandboxes: [row("one")] });
    const again = await respond(() => claimRun(h.deps({ leases: idle }), signed(r.key, CLAIM_PATH, { sandboxes: [row("two")] })));
    expect(again.status).toBe(429);
    expect(await names(r.id)).toEqual(["one"]);
  });

  it("is per runner and per account: another runner of the same account, and another account, never see or change it", async () => {
    const fa = await seedF2(h.admin);
    const fb = await seedF2(h.admin);
    const a1 = await runner(fa);
    const a2 = await runner(fa);
    const b1 = await runner(fb);
    await claim(a1, { sandboxes: [row("shared-name"), row("only-a1")] });
    await claim(a2, { sandboxes: [row("shared-name")] });
    await claim(b1, { sandboxes: [row("shared-name"), row("only-b")] });
    expect(await names(a1.id)).toEqual(["shared-name", "only-a1"]);
    expect(await names(a2.id)).toEqual(["shared-name"]);
    await claim(a2, { sandboxes: [] });
    expect(await names(a1.id)).toEqual(["shared-name", "only-a1"]);
    expect(await names(b1.id)).toEqual(["shared-name", "only-b"]);
    // Read as the application login in account B's context: account A's rows do not exist; and with the superuser reading B's id as a predicate, A's rows are not B's.
    const client = await h.appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.account_id', $1, true)", [fb.accountId]);
      const seen = await client.query<{ name: string; runner_id: string }>("SELECT name, runner_id FROM runner_sandboxes");
      expect(seen.rows.map((x) => x.runner_id)).toEqual(expect.not.arrayContaining([a1.id, a2.id]));
      expect(seen.rows.length).toBe(2);
      expect((await client.query("SELECT 1 FROM runner_sandbox_reports WHERE runner_id = $1", [a1.id])).rowCount).toBe(0);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect((await h.admin.query("SELECT 1 FROM runner_sandboxes WHERE account_id = $1 AND runner_id = ANY($2)", [fb.accountId, [a1.id, a2.id]])).rowCount).toBe(0);
  });

  it("the application login cannot write either table or call the definer outside a runner session", async () => {
    const f = await seedF2(h.admin);
    const r = await runner(f);
    await expect(h.appPool.query("INSERT INTO runner_sandboxes (runner_id, slot, account_id, name, state, created_at, disk_bytes, snapshot_count) VALUES ($1, 0, $2, 'x', 'stopped', now(), 0, 0)", [r.id, f.accountId])).rejects.toMatchObject({ code: "42501" });
    await expect(h.appPool.query("SELECT runner_sandboxes_record('[]'::jsonb)")).rejects.toMatchObject({ code: "42501" });
    await expect(h.opsPool.query("SELECT runner_sandboxes_record('[]'::jsonb)")).rejects.toMatchObject({ code: "42501" });
  });

  describe("host limits on hello", () => {
    const limits = { max_vms: 4, max_vcpus: 16, max_memory_mb: 32768, bootable_templates: ["fx-agent", "fx-agent-gpu"] };
    const stored = async (id: string) => (await h.admin.query("SELECT max_vms, max_vcpus, max_memory_mb, bootable_templates FROM runner_facts WHERE runner_id = $1", [id])).rows[0] ?? null;

    it("stores them with the facts, rewrites them on the next hello, and clears them when they are no longer sent", async () => {
      const f = await seedF2(h.admin);
      const r = await runner(f, null);
      expect(await hello(r.key, { ...HELLO, facts: { ...FACTS, ...limits } })).toMatchObject({ status: 200 });
      expect(await stored(r.id)).toEqual({ max_vms: 4, max_vcpus: 16, max_memory_mb: 32768, bootable_templates: ["fx-agent", "fx-agent-gpu"] });
      expect(await hello(r.key, { ...HELLO, facts: { ...FACTS, max_vms: 2 } })).toMatchObject({ status: 200 });
      expect(await stored(r.id)).toEqual({ max_vms: 2, max_vcpus: null, max_memory_mb: null, bootable_templates: [] });
    });

    it("refuses limits with an unknown key, a bad template id or a protocol below the gate as 400, and keeps the old row", async () => {
      const f = await seedF2(h.admin);
      const r = await runner(f, null);
      await hello(r.key, { ...HELLO, facts: { ...FACTS, ...limits } });
      for (const bad of [{ ...limits, hostname: "box" }, { ...limits, bootable_templates: ["Bad Id"] }, { ...limits, max_vms: 257 }, { ...limits, bootable_templates: ["a", "a"] }]) {
        expect((await hello(r.key, { ...HELLO, facts: { ...FACTS, ...bad } })).status, JSON.stringify(bad)).toBe(400);
      }
      expect((await hello(r.key, { ...HELLO, protocol_version: SANDBOX_INVENTORY_MIN_PROTOCOL - 1, facts: { ...FACTS, ...limits } })).status).toBe(400);
      expect(await stored(r.id)).toMatchObject({ max_vms: 4 });
    });
  });
});
