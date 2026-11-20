import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { CLAIM_PATH, HELLO_PATH, claimRun, runnerHello, type RunnerLeaseOps } from "../src/index.js";
import { harness, newKey, registerKey, respond, signed, type Harness, type TestKey } from "./helpers.js";

/**
 * [pg] D#845 ON-1b: the claim route keeps the machine's load (`runner_facts.host_*`, migration 1045) and the hello keeps `runners.model_auth_present`, both through the real SECURITY DEFINER
 * functions as the runner login the routes use, with row security forced.
 */
describe("host load on the claim and model auth on the hello [pg]", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  const idle = { claimRunnerRun: async () => ({ kind: "idle" as const, retryAfter: 60 }) } as unknown as RunnerLeaseOps;
  const claim = (key: TestKey, body: unknown) => respond(() => claimRun(h.deps({ leases: idle }), signed(key, CLAIM_PATH, body)));
  const hello = (key: TestKey, body: unknown) => respond(() => runnerHello(h.deps(), signed(key, HELLO_PATH, body)));
  const LOAD = { mem_avail_mb: 9100, disk_free_mb: 250000, setups_running: 1 };
  const helloBody = (over: Record<string, unknown> = {}) => ({ protocol_version: 22, binary_version: "0.5.0", model_auth_present: true, isolation: "host_sandbox", facts: { os: "linux", arch: "x64", mem_gb_bucket: 16, cpus: 8, sandbox_engine: "os_sandbox" }, ...over });
  const stored = async (id: string) => (await h.admin.query("SELECT host_mem_avail_mb AS mem, host_disk_free_mb AS disk, host_setups_running AS setups, host_load_at AS at FROM runner_facts WHERE runner_id = $1", [id])).rows[0] ?? null;
  const modelAuth = async (id: string) => (await h.admin.query<{ m: boolean | null }>("SELECT model_auth_present AS m FROM runners WHERE id = $1", [id])).rows[0]!.m;
  const unthrottle = (id: string) => h.admin.query("UPDATE runner_claim_stamps SET last_claim_at = now() - interval '1 hour' WHERE runner_id = $1", [id]);
  async function runnerAt(f: F2Fixture, protocol: number | null): Promise<{ id: string; key: TestKey }> {
    const key = newKey();
    const id = await registerKey(h.admin, f.accountId, f.m1, key);
    if (protocol !== null) await h.admin.query("UPDATE runners SET protocol_version = $2 WHERE id = $1", [id, protocol]);
    return { id, key };
  }

  it("a claim of a protocol 22 runner with facts stores the three numbers and a time, and the next claim moves them", async () => {
    const f = await seedF2(h.admin);
    const r = await runnerAt(f, null);
    expect((await hello(r.key, helloBody())).status).toBe(200);
    expect(await stored(r.id)).toMatchObject({ mem: null, disk: null, setups: null, at: null });
    expect(await claim(r.key, { host_load: LOAD })).toMatchObject({ status: 200 });
    expect(await stored(r.id)).toMatchObject({ mem: 9100, disk: 250000, setups: 1 });
    expect((await stored(r.id)).at).toBeInstanceOf(Date);
    await unthrottle(r.id);
    expect(await claim(r.key, { host_load: { ...LOAD, mem_avail_mb: 4000, setups_running: 0 } })).toMatchObject({ status: 200 });
    expect(await stored(r.id)).toMatchObject({ mem: 4000, disk: 250000, setups: 0 });
  });

  it("a claim without the block changes nothing, and a status poll that carries it stores nothing", async () => {
    const f = await seedF2(h.admin);
    const r = await runnerAt(f, null);
    await hello(r.key, helloBody());
    await claim(r.key, { host_load: LOAD });
    await unthrottle(r.id);
    expect(await claim(r.key, {})).toMatchObject({ status: 200 });
    expect(await stored(r.id)).toMatchObject({ mem: 9100 });
    await unthrottle(r.id);
    expect(await claim(r.key, { sandbox_unavailable: "bwrap_missing", host_load: { ...LOAD, mem_avail_mb: 1 } })).toMatchObject({ status: 200 });
    expect(await stored(r.id)).toMatchObject({ mem: 9100 });
  });

  it("a runner of protocol 21 that sends the block anyway is a 400 and stores nothing", async () => {
    const f = await seedF2(h.admin);
    const r = await runnerAt(f, null);
    await hello(r.key, helloBody({ protocol_version: 21 }));
    expect(await claim(r.key, { host_load: LOAD })).toMatchObject({ status: 400, body: { error: { code: "invalid_message" } } });
    expect(await stored(r.id)).toMatchObject({ mem: null });
  });

  it("a runner that has reported no facts has its claim answered normally and nothing stored", async () => {
    const f = await seedF2(h.admin);
    const r = await runnerAt(f, 22);
    expect(await claim(r.key, { host_load: LOAD })).toMatchObject({ status: 200 });
    expect(await stored(r.id)).toBeNull();
  });

  it("an extra key, a negative or a fraction in the block is refused by the route's schema", async () => {
    const f = await seedF2(h.admin);
    const r = await runnerAt(f, null);
    await hello(r.key, helloBody());
    for (const bad of [{ ...LOAD, hostname: "box" }, { ...LOAD, mem_avail_mb: -1 }, { ...LOAD, disk_free_mb: 1.5 }]) {
      await unthrottle(r.id);
      expect(await claim(r.key, { host_load: bad }), JSON.stringify(bad)).toMatchObject({ status: 400 });
    }
    expect(await stored(r.id)).toMatchObject({ mem: null });
  });

  it("only the signing runner's row moves (a second runner of the same account is untouched)", async () => {
    const f = await seedF2(h.admin);
    const a = await runnerAt(f, null);
    const b = await runnerAt(f, null);
    await hello(a.key, helloBody());
    await hello(b.key, helloBody());
    await claim(a.key, { host_load: LOAD });
    expect(await stored(a.id)).toMatchObject({ mem: 9100 });
    expect(await stored(b.id)).toMatchObject({ mem: null });
  });

  it("the hello stores model_auth_present as sent, on every hello", async () => {
    const f = await seedF2(h.admin);
    const r = await runnerAt(f, null);
    expect(await modelAuth(r.id)).toBeNull();
    expect((await hello(r.key, helloBody({ model_auth_present: true }))).status).toBe(200);
    expect(await modelAuth(r.id)).toBe(true);
    expect((await hello(r.key, helloBody({ model_auth_present: false }))).status).toBe(200);
    expect(await modelAuth(r.id)).toBe(false);
  });
});
