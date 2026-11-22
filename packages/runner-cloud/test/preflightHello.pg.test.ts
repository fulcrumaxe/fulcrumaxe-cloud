import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedF2, type F2Fixture } from "@fx/db/test/helpers/members.js";
import { CURRENT_PROTOCOL_VERSION, PREFLIGHT_CODES } from "@fulcrumaxe/runner-protocol";
import { HELLO_PATH, runnerHello } from "../src/index.js";
import { runnersTakePreflight } from "../src/hello.js";
import { harness, newKey, registerKey, respond, signed, type Harness, type TestKey } from "./helpers.js";

/**
 * [pg] D#845 ON-21b: the hello keeps `runners.preflight` (migration 1051) through the real definer as the runner login the route uses, with row security forced, and lists `preflight` in its
 * reply only to a runner that declared `preflight_v1` against a database that has the column.
 */
describe("the hello stores the preflight codes [pg]", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  const hello = (key: TestKey, body: unknown) => respond(() => runnerHello(h.deps(), signed(key, HELLO_PATH, body)));
  const facts = (preflight?: unknown) => ({ os: "linux", arch: "x64", mem_gb_bucket: 16, cpus: 8, sandbox_engine: "os_sandbox", ...(preflight === undefined ? {} : { preflight }) });
  const helloBody = (over: Record<string, unknown> = {}) => ({ protocol_version: 22, binary_version: "0.5.0", model_auth_present: true, isolation: "host_sandbox", facts: facts(), ...over });
  const stored = async (id: string) => (await h.admin.query<{ p: string[] | null }>("SELECT preflight AS p FROM runners WHERE id = $1", [id])).rows[0]!.p;
  async function runnerOf(f: F2Fixture): Promise<{ id: string; key: TestKey }> {
    const key = newKey();
    return { id: await registerKey(h.admin, f.accountId, f.m1, key), key };
  }

  it("stores the codes, replaces them on the next hello, and a hello without them (an old runner) clears them to unknown", async () => {
    const r = await runnerOf(await seedF2(h.admin));
    expect(await stored(r.id)).toBeNull();
    expect((await hello(r.key, helloBody({ facts: facts(["kvm_absent", "net_blocked:github"]) }))).status).toBe(200);
    expect(await stored(r.id)).toEqual(["kvm_absent", "net_blocked:github"]);
    expect((await hello(r.key, helloBody({ facts: facts([]) }))).status).toBe(200);
    expect(await stored(r.id)).toEqual([]);
    expect((await hello(r.key, helloBody({ facts: facts(["dns_failed"]) }))).status).toBe(200);
    expect((await hello(r.key, helloBody({ facts: facts() }))).status).toBe(200);
    expect(await stored(r.id)).toBeNull();
    await hello(r.key, helloBody({ facts: facts(["dns_failed"]) }));
    const noFacts = helloBody();
    delete (noFacts as { facts?: unknown }).facts;
    expect((await hello(r.key, noFacts)).status).toBe(200);
    expect(await stored(r.id)).toBeNull();
  });

  it("every code the protocol names is stored as sent (the schema's list and the column's CHECK are the same list)", async () => {
    const r = await runnerOf(await seedF2(h.admin));
    for (const code of PREFLIGHT_CODES) {
      expect((await hello(r.key, helloBody({ facts: facts([code]) }))).status, code).toBe(200);
      expect(await stored(r.id), code).toEqual([code]);
    }
    expect((await hello(r.key, helloBody({ facts: facts([...PREFLIGHT_CODES]) }))).status).toBe(200);
    expect(await stored(r.id)).toEqual([...PREFLIGHT_CODES]);
  });

  it("nothing beyond the enum is stored: a free-text code, a host name, a path, a repeat or a non-list is a 400 and the old list stays", async () => {
    const r = await runnerOf(await seedF2(h.admin));
    await hello(r.key, helloBody({ facts: facts(["clock_skew"]) }));
    for (const bad of [["net_blocked:internal.example"], ["fictional-dir/file"], ["kvm_absent", "kvm_absent"], "kvm_absent", [""], [null], { kvm_absent: true }]) {
      expect(await hello(r.key, helloBody({ facts: facts(bad) })), JSON.stringify(bad)).toMatchObject({ status: 400 });
    }
    expect(await stored(r.id)).toEqual(["clock_skew"]);
  });

  it("writes only the calling runner's row: another runner of the same account and a runner of another account keep theirs", async () => {
    const fa = await seedF2(h.admin);
    const fb = await seedF2(h.admin);
    const a1 = await runnerOf(fa);
    const a2 = await runnerOf(fa);
    const b1 = await runnerOf(fb);
    await hello(a2.key, helloBody({ facts: facts(["disk_low"]) }));
    await hello(b1.key, helloBody({ facts: facts(["dns_failed"]) }));
    expect((await hello(a1.key, helloBody({ facts: facts(["kvm_absent"]) }))).status).toBe(200);
    expect(await stored(a1.id)).toEqual(["kvm_absent"]);
    expect(await stored(a2.id)).toEqual(["disk_low"]);
    expect(await stored(b1.id)).toEqual(["dns_failed"]);
  });

  // The hello reply as runners built before the capability parse it: only `protocol_version` and `wake`, plus `capabilities` they read on their own.
  it("a runner that did NOT declare preflight_v1 gets the old reply byte for byte, whatever codes it sent", async () => {
    const r = await runnerOf(await seedF2(h.admin));
    const res = await hello(r.key, helloBody({ facts: facts(["kvm_absent"]) }));
    expect(res.status).toBe(200);
    expect(Object.keys(res.body as object).sort()).toEqual(["protocol_version"]);
    expect((await hello(r.key, helloBody({ capabilities: ["kvm_fact_v1"] }))).body).toEqual({ protocol_version: CURRENT_PROTOCOL_VERSION, capabilities: ["kvm_fact"] });
  });

  it("a runner that declared preflight_v1 is told preflight, after watch_mode and kvm_fact when it declared those too; the declaration is stored", async () => {
    const r = await runnerOf(await seedF2(h.admin));
    expect((await hello(r.key, helloBody({ capabilities: ["preflight_v1"] }))).body).toEqual({ protocol_version: CURRENT_PROTOCOL_VERSION, capabilities: ["preflight"] });
    expect((await h.admin.query<{ c: string[] }>("SELECT capabilities AS c FROM runner_capabilities WHERE runner_id = $1", [r.id])).rows[0]!.c).toEqual(["preflight_v1"]);
    const all = await hello(r.key, helloBody({ protocol_version: CURRENT_PROTOCOL_VERSION, capabilities: ["watch_mode_v1", "kvm_fact_v1", "preflight_v1"] }));
    expect((all.body as { capabilities?: string[] }).capabilities).toEqual(["watch_mode", "kvm_fact", "preflight"]);
  });

  it("the handshake end to end: the first hello (no codes) stores unknown, the next one stores them", async () => {
    const r = await runnerOf(await seedF2(h.admin));
    expect((await hello(r.key, helloBody({ capabilities: ["preflight_v1"], facts: facts() }))).body).toMatchObject({ capabilities: ["preflight"] });
    expect(await stored(r.id)).toBeNull();
    expect((await hello(r.key, helloBody({ capabilities: ["preflight_v1"], facts: facts(["linger_off"]) }))).status).toBe(200);
    expect(await stored(r.id)).toEqual(["linger_off"]);
  });

  it("follows the database: without the column the capability is not listed and the hello still records (nothing of the preflight is written)", async () => {
    const r = await runnerOf(await seedF2(h.admin));
    await h.admin.query("ALTER TABLE runners RENAME COLUMN preflight TO preflight_off");
    try {
      expect(await runnersTakePreflight(h.deps())).toBe(false);
      const res = await hello(r.key, helloBody({ capabilities: ["preflight_v1"] }));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ protocol_version: CURRENT_PROTOCOL_VERSION });
    } finally {
      await h.admin.query("ALTER TABLE runners RENAME COLUMN preflight_off TO preflight");
    }
    expect(await runnersTakePreflight(h.deps())).toBe(true);
    expect(await stored(r.id)).toBeNull();
  });
});
