import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { readMachineFacts } from "../src/index.js";
import { harness, newKey, registerKey, type Harness } from "./helpers.js";

/**
 * [pg] D#845 ON-1b: the read model of each machine's reported load and model-auth flag, on real Postgres with row security forced. Every query carries its own account predicate; these tests pin
 * the account scoping, the revoked filter, the protocol gate and the fail-closed nulls.
 */
describe("the machine facts read model [pg]", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  async function runner(f: F2Fixture, o: { protocol?: number | null; load?: [number, number, number] | null; facts?: boolean; modelAuth?: boolean | null } = {}): Promise<string> {
    const id = await registerKey(h.admin, f.accountId, f.m1, newKey());
    if (o.protocol !== null) await h.admin.query("UPDATE runners SET protocol_version = $2 WHERE id = $1", [id, o.protocol ?? 22]);
    if (o.modelAuth !== undefined) await h.admin.query("UPDATE runners SET model_auth_present = $2 WHERE id = $1", [id, o.modelAuth]);
    if (o.facts !== false) {
      await h.admin.query("INSERT INTO runner_facts (runner_id, account_id, os, arch, mem_gb_bucket, cpus, sandbox_engine) VALUES ($1, $2, 'linux', 'x64', 16, 8, 'microvm')", [id, f.accountId]);
      if (o.load) await h.admin.query("UPDATE runner_facts SET host_mem_avail_mb = $2, host_disk_free_mb = $3, host_setups_running = $4, host_load_at = now() - interval '2 minutes' WHERE runner_id = $1", [id, ...o.load]);
    }
    return id;
  }
  const read = (f: F2Fixture) => readMachineFacts(h.deps(), f.accountId, f.m1);

  it("returns the three numbers, their age and the flag for a runner that reported them, and nulls for one that did not", async () => {
    const f = await seedF2(h.admin);
    const full = await runner(f, { load: [9100, 250000, 2], modelAuth: true });
    const bare = await runner(f, { facts: false });
    const noLoad = await runner(f, { modelAuth: false });
    const facts = await read(f);
    expect(facts.get(full)).toMatchObject({ runner_id: full, host_load: { mem_avail_mb: 9100, disk_free_mb: 250000, setups_running: 2 }, model_auth_present: true });
    const age = Date.now() - new Date(facts.get(full)!.host_load!.seen_at).getTime();
    expect(age).toBeGreaterThan(100_000);
    expect(age).toBeLessThan(200_000);
    expect(facts.get(bare)).toEqual({ runner_id: bare, host_load: null, model_auth_present: null });
    expect(facts.get(noLoad)).toEqual({ runner_id: noLoad, host_load: null, model_auth_present: false });
  });

  it("never reports a load for a runner whose hello declared a protocol below 22, or none", async () => {
    const f = await seedF2(h.admin);
    const old = await runner(f, { protocol: 21, load: [1, 2, 3] });
    const none = await runner(f, { protocol: null, load: [1, 2, 3] });
    const facts = await read(f);
    expect(facts.get(old)!.host_load).toBeNull();
    expect(facts.get(none)!.host_load).toBeNull();
  });

  it("lists only the account's own live runners: another account's runner and a revoked runner are absent", async () => {
    const f = await seedF2(h.admin);
    const g = await seedF2(h.admin);
    const mine = await runner(f, { load: [1, 1, 1] });
    const revoked = await runner(f, { load: [1, 1, 1] });
    const foreign = await runner(g, { load: [7, 7, 7], modelAuth: true });
    await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [revoked]);
    const facts = await read(f);
    expect([...facts.keys()]).toEqual([mine]);
    expect([...(await read(g)).keys()]).toEqual([foreign]);
    expect(facts.has(foreign)).toBe(false);
  });

  it("a second runner of the same account does not show the first one's numbers", async () => {
    const f = await seedF2(h.admin);
    const a = await runner(f, { load: [100, 200, 3], modelAuth: true });
    const b = await runner(f, { load: [400, 500, 6], modelAuth: false });
    const facts = await read(f);
    expect(facts.get(a)).toMatchObject({ host_load: { mem_avail_mb: 100, disk_free_mb: 200, setups_running: 3 }, model_auth_present: true });
    expect(facts.get(b)).toMatchObject({ host_load: { mem_avail_mb: 400, disk_free_mb: 500, setups_running: 6 }, model_auth_present: false });
  });

  it("read as the app role with a foreign account id, nothing of another account's runners comes back (row security alone)", async () => {
    const f = await seedF2(h.admin);
    const g = await seedF2(h.admin);
    await runner(g, { load: [7, 7, 7], modelAuth: true });
    expect((await readMachineFacts(h.deps(), f.accountId, f.m1)).size).toBe(0);
  });

  it("through a pool that bypasses row security, only the asked account's live runners come back (the query's own account predicate)", async () => {
    const f = await seedF2(h.admin);
    const g = await seedF2(h.admin);
    const mine = await runner(f, { load: [1, 1, 1] });
    const mine2 = await runner(f, { facts: false });
    const revoked = await runner(f, { load: [1, 1, 1] });
    const foreign = await runner(g, { load: [7, 7, 7], modelAuth: true });
    const foreign2 = await runner(g, { facts: false });
    await h.admin.query("UPDATE runners SET revoked_at = now() WHERE id = $1", [revoked]);
    const bypass = h.deps({ appUserPool: h.adminPool });
    const ofF = await readMachineFacts(bypass, f.accountId, f.m1);
    expect([...ofF.keys()].sort()).toEqual([mine, mine2].sort());
    expect([...(await readMachineFacts(bypass, g.accountId, g.m1)).keys()].sort()).toEqual([foreign, foreign2].sort());
  });
});
