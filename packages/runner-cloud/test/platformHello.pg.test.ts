import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { CURRENT_PROTOCOL_VERSION } from "@fulcrumaxe/runner-protocol";
import { HELLO_PATH, runnerHello } from "../src/index.js";
import { runnersTakePlatform } from "../src/hello.js";
import { listRunners, type RunnerRow } from "../src/index.js";
import { harness, newKey, registerKey, respond, signed, type Harness, type TestKey } from "./helpers.js";

/**
 * [pg] D#587 B-7c: the hello keeps `runner_facts.platform` (migration 1122) through the real definer as the runner login the route uses, and lists `platform_fact` in its reply only to a runner that
 * declared `platform_fact_v1` against a database that has the column. The fleet read then shows the row of the runner's own support table.
 */
describe("the hello stores the platform and the fleet read shows its row [pg]", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  const hello = (key: TestKey, body: unknown) => respond(() => runnerHello(h.deps(), signed(key, HELLO_PATH, body)));
  const facts = (over: Record<string, unknown> = {}) => ({ os: "linux", arch: "x64", mem_gb_bucket: 16, cpus: 8, sandbox_engine: "os_sandbox", ...over });
  const helloBody = (over: Record<string, unknown> = {}) => ({ protocol_version: CURRENT_PROTOCOL_VERSION, binary_version: "0.5.0", model_auth_present: true, isolation: "host_sandbox", facts: facts(), ...over });
  const stored = async (id: string) => (await h.admin.query<{ p: string | null }>("SELECT platform AS p FROM runner_facts WHERE runner_id = $1", [id])).rows[0]!.p;
  async function runnerOf(f: F2Fixture): Promise<{ id: string; key: TestKey }> {
    const key = newKey();
    return { id: await registerKey(h.admin, f.accountId, f.m1, key), key };
  }

  it("stores the platform, replaces it on the next hello, and a hello without it (an old runner) clears it back to unknown", async () => {
    const r = await runnerOf(await seedF2(h.admin));
    expect((await hello(r.key, helloBody({ facts: facts({ platform: "wsl2" }) }))).status).toBe(200);
    expect(await stored(r.id)).toBe("wsl2");
    expect((await hello(r.key, helloBody({ facts: facts({ platform: "linux" }) }))).status).toBe(200);
    expect(await stored(r.id)).toBe("linux");
    expect((await hello(r.key, helloBody())).status).toBe(200);
    expect(await stored(r.id)).toBeNull();
  });

  it("a platform that disagrees with the os is not stored (the hello itself still records), and an unknown platform is a 400 that changes nothing", async () => {
    const r = await runnerOf(await seedF2(h.admin));
    await hello(r.key, helloBody({ facts: facts({ platform: "wsl2" }) }));
    expect((await hello(r.key, helloBody({ facts: facts({ os: "macos", platform: "wsl2" }) }))).status).toBe(200);
    expect(await stored(r.id)).toBeNull();
    for (const bad of ["windows", "wsl1", "", 7]) expect(await hello(r.key, helloBody({ facts: facts({ platform: bad }) })), String(bad)).toMatchObject({ status: 400 });
    expect(await stored(r.id)).toBeNull();
  });

  it("writes only the calling runner's row", async () => {
    const f = await seedF2(h.admin);
    const a = await runnerOf(f);
    const b = await runnerOf(f);
    await hello(b.key, helloBody({ facts: facts({ platform: "wsl2" }) }));
    expect((await hello(a.key, helloBody({ facts: facts({ platform: "linux" }) }))).status).toBe(200);
    expect(await stored(a.id)).toBe("linux");
    expect(await stored(b.id)).toBe("wsl2");
  });

  it("a runner that did NOT declare platform_fact_v1 gets the old reply, and one that did is told platform_fact after the older capabilities", async () => {
    const r = await runnerOf(await seedF2(h.admin));
    expect((await hello(r.key, helloBody())).body).toEqual({ protocol_version: CURRENT_PROTOCOL_VERSION });
    expect((await hello(r.key, helloBody({ capabilities: ["platform_fact_v1"] }))).body).toEqual({ protocol_version: CURRENT_PROTOCOL_VERSION, capabilities: ["platform_fact"] });
    const all = await hello(r.key, helloBody({ capabilities: ["watch_mode_v1", "kvm_fact_v1", "preflight_v1", "platform_fact_v1"] }));
    expect((all.body as { capabilities?: string[] }).capabilities).toEqual(["watch_mode", "kvm_fact", "preflight", "platform_fact"]);
  });

  it("the handshake end to end: the first hello (no platform) stores unknown, the next one stores it", async () => {
    const r = await runnerOf(await seedF2(h.admin));
    expect((await hello(r.key, helloBody({ capabilities: ["platform_fact_v1"] }))).body).toMatchObject({ capabilities: ["platform_fact"] });
    expect(await stored(r.id)).toBeNull();
    expect((await hello(r.key, helloBody({ capabilities: ["platform_fact_v1"], facts: facts({ platform: "wsl2" }) }))).status).toBe(200);
    expect(await stored(r.id)).toBe("wsl2");
  });

  it("follows the database: without the column the capability is not listed and the hello still records (the platform is not written)", async () => {
    const r = await runnerOf(await seedF2(h.admin));
    await h.admin.query("ALTER TABLE runner_facts RENAME COLUMN platform TO platform_off");
    try {
      expect(await runnersTakePlatform(h.deps())).toBe(false);
      const res = await hello(r.key, helloBody({ capabilities: ["survey_v1", "platform_fact_v1"], facts: facts({ platform: "wsl2" }) }));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ protocol_version: CURRENT_PROTOCOL_VERSION });
    } finally {
      await h.admin.query("ALTER TABLE runner_facts RENAME COLUMN platform_off TO platform");
    }
    expect(await runnersTakePlatform(h.deps())).toBe(true);
    expect(await stored(r.id)).toBeNull();
    // The capability the database cannot take yet is not stored with the others: a cloud deployed ahead of its migration still records the hello.
    expect((await h.admin.query<{ c: string[] }>("SELECT capabilities AS c FROM runner_capabilities WHERE runner_id = $1", [r.id])).rows[0]!.c).toEqual(["survey_v1"]);
  });

  it("the declaration is stored with the other capabilities when the database has the migration", async () => {
    const r = await runnerOf(await seedF2(h.admin));
    expect((await hello(r.key, helloBody({ capabilities: ["survey_v1", "platform_fact_v1"] }))).status).toBe(200);
    expect((await h.admin.query<{ c: string[] }>("SELECT capabilities AS c FROM runner_capabilities WHERE runner_id = $1", [r.id])).rows[0]!.c).toEqual(["survey_v1", "platform_fact_v1"]);
  });

  // The fleet read: the row of the support table for `platform ?? os`, never Linux's "supported" for a WSL2 machine and never macOS's for a Linux one.
  it("the fleet read says each machine's own row: Linux and WSL2 supported, macOS a preview, an old runner by its os, and nothing for a runner that has not reported", async () => {
    const f = await seedF2(h.admin);
    const lin = await runnerOf(f);
    const wsl = await runnerOf(f);
    const mac = await runnerOf(f);
    const old = await runnerOf(f);
    const none = await runnerOf(f);
    await hello(lin.key, helloBody({ facts: facts({ platform: "linux" }) }));
    await hello(wsl.key, helloBody({ facts: facts({ platform: "wsl2" }) }));
    await hello(mac.key, helloBody({ facts: facts({ os: "macos", arch: "arm64", platform: "macos" }) }));
    await hello(old.key, helloBody({ facts: facts({ os: "macos", arch: "arm64" }) }));
    const res = await respond(() => listRunners(h.deps(), { accountId: f.accountId, userId: f.m1 }));
    const rows = new Map((res.body as { runners: RunnerRow[] }).runners.map((r) => [r.id, r]));
    const support = (id: string) => rows.get(id)!.facts?.support;
    expect(support(lin.id)).toBe("supported");
    expect(support(wsl.id)).toBe("supported, OS sandbox only, NAT networking");
    expect(support(mac.id)).toBe("supported as a preview, not yet verified");
    expect(support(old.id)).toBe("supported as a preview, not yet verified");
    expect(rows.get(wsl.id)!.facts).toMatchObject({ os: "linux", platform: "wsl2" });
    expect(rows.get(old.id)!.facts).toMatchObject({ os: "macos", platform: null });
    expect(rows.get(none.id)!.facts).toBeNull();
  });
});
