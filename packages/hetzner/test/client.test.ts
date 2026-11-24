import { inspect } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CREATE_KEY_LABEL, HetznerError, createHetznerClient, type HetznerOptions } from "../src/index.js";
import { generateSelfSignedCert } from "../../webhooks/test/helpers/selfSignedCert.js";
import { newWorld, startStrictHetzner, type FakeWorld, type StrictHetzner } from "./helpers/strictHetzner.js";

const TOKEN = "fxtest-SENTINEL-token-0123456789abcdef";
let fake: StrictHetzner;
let world: FakeWorld;
const prevEnv = process.env.NODE_ENV;

beforeAll(() => { process.env.NODE_ENV = "test"; });
afterAll(() => { process.env.NODE_ENV = prevEnv; });
beforeEach(async () => { world = newWorld([TOKEN]); fake = await startStrictHetzner(world); });
afterEach(async () => { await fake.close(); });

const sleeps: number[] = [];
const make = (o: Partial<HetznerOptions> = {}) =>
  createHetznerClient({
    token: TOKEN, maxRetries: 2, timeoutMs: 2000,
    sleep: async (ms) => { sleeps.push(ms); world.clock.t += ms; },
    now: () => world.clock.t,
    testTarget: { lookup: fake.lookup, port: fake.port, ca: fake.ca },
    ...o,
  });
const thrown = async (p: Promise<unknown>): Promise<HetznerError> => { try { await p; } catch (e) { if (e instanceof HetznerError) return e; throw e; } throw new Error("did not throw"); };
const create = (key: string, name = `srv-${key}`) => ({ name, serverType: "cx22", location: "fsn1", image: "ubuntu-24.04", idempotencyKey: key });
beforeEach(() => { sleeps.length = 0; });

describe("typed calls", () => {
  it("reads locations, server types and pricing as decimal strings", async () => {
    const c = make();
    expect((await c.listLocations()).map((l) => l.name)).toEqual(["fsn1", "nbg1"]);
    const types = await c.listServerTypes();
    expect(types[0]).toMatchObject({ name: "cx22", cores: 2 });
    expect(types[0]!.prices[0]).toMatchObject({ location: "fsn1", hourlyGross: "0.0070", monthlyNet: "3.7900" });
    expect(types[1]!.locations.find((l) => l.name === "nbg1")!.available).toBe(false);
    const pricing = await c.getPricing();
    expect(pricing.primaryIps.find((p) => p.type === "ipv4")!.prices[0]).toMatchObject({ location: "fsn1", monthlyNet: "0.5000" });
  });

  it("covers servers, firewalls, SSH keys and actions, and reads every page of a list", async () => {
    const c = make();
    const key = await c.createSshKey({ name: "k", publicKey: "ssh-ed25519 AAAAC3Nza-example-key-0001" });
    const fw = await c.createFirewall({ name: "fw", rules: [{ direction: "in", protocol: "tcp", port: "22", sourceIps: ["198.51.100.1/32"] }] });
    expect(fw.rules[0]).toMatchObject({ direction: "in", port: "22", sourceIps: ["198.51.100.1/32"] });
    const made = await c.createServer({ ...create("k1"), sshKeys: [String(key.id)], firewalls: [fw.id], userData: "#cloud-config\n", labels: { team: "a" } });
    expect(made).toMatchObject({ reused: false, server: { name: "srv-k1", status: "initializing", ipv4: "203.0.113.7", labels: { team: "a", [CREATE_KEY_LABEL]: "k1" } }, action: { status: "success" } });
    expect((await c.getServer(made.server.id)).id).toBe(made.server.id);
    expect((await c.listFirewalls({ name: "fw" }))).toHaveLength(1);
    expect((await c.listSshKeys({ fingerprint: key.fingerprint }))).toHaveLength(1);
    expect((await c.getFirewall(fw.id)).name).toBe("fw");
    expect((await c.getActions([7, 8])).map((a) => a.id)).toEqual([7, 8]);
    expect((await c.getAction(5)).command).toBe("x");
    expect((await c.rebootServer(made.server.id)).command).toBe("reboot_server");
    expect((await c.powerOffServer(made.server.id)).command).toBe("poweroff_server");
    expect((await c.powerOnServer(made.server.id)).command).toBe("poweron_server");
    expect((await c.renameServer(made.server.id, "renamed")).name).toBe("renamed");
    for (let i = 0; i < 59; i++) world.servers.push({ ...world.servers[0]!, id: 5000 + i, name: `bulk-${i}`, labels: {} });
    expect(await c.listServers()).toHaveLength(60);
    expect(world.requests.filter((r) => r.path.startsWith("/v1/servers?")).length).toBeGreaterThanOrEqual(2);
    expect(await c.listServers({ labelSelector: `${CREATE_KEY_LABEL}=k1` })).toHaveLength(1);
  });

  it("deletes idempotently and refuses a bad id before sending anything", async () => {
    const c = make();
    const made = await c.createServer(create("d1"));
    expect((await c.deleteServer(made.server.id))!.command).toBe("delete_server");
    expect(await c.deleteServer(made.server.id)).toBeNull();
    expect(await c.deleteFirewall(99)).toBe(false);
    expect(await c.deleteSshKey(99)).toBe(false);
    const n = world.requests.length;
    expect((await thrown(c.getServer(-1))).code).toBe("invalid_input");
    expect(world.requests.length).toBe(n);
  });

  it("turns a malformed action reply into unavailable, not a raw parse error, for delete, reboot, power on and power off", async () => {
    const c = make();
    const made = await c.createServer(create("d3"));
    world.malformedAction = true;
    const calls: Array<[string, () => Promise<unknown>]> = [
      ["reboot", () => c.rebootServer(made.server.id)], ["power on", () => c.powerOnServer(made.server.id)],
      ["power off", () => c.powerOffServer(made.server.id)], ["delete", () => c.deleteServer(made.server.id)], // last: the fake removes the server on delete
    ];
    for (const [name, call] of calls) {
      const e = await thrown(call());
      expect(e, name).toMatchObject({ code: "unavailable" });
      expect(e.message, name).toMatch(/shape we do not understand/);
    }
  });

  it("accepts a successful delete that carries no action", async () => {
    const c = make();
    const made = await c.createServer(create("d2"));
    world.deleteOmitsAction = true;
    expect(await c.deleteServer(made.server.id)).toBeNull();
    expect(world.servers).toHaveLength(0);
  });

  it("reads a firewall with no labels as having none", async () => {
    const c = make();
    const fw = await c.createFirewall({ name: "nolabels", rules: [] });
    delete world.firewalls[0]!.labels;
    expect((await c.getFirewall(fw.id)).labels).toEqual({});
    expect((await c.listFirewalls())[0]!.labels).toEqual({});
  });

  it("refuses to delete a firewall that is still applied to a server (422 resource_in_use), and deletes it once the server is gone", async () => {
    const c = make();
    const fw = await c.createFirewall({ name: "applied", rules: [] });
    const made = await c.createServer({ ...create("fw1"), firewalls: [fw.id] });
    const e = await thrown(c.deleteFirewall(fw.id));
    expect(e).toMatchObject({ code: "unavailable", status: 422, extra: { hetznerCode: "resource_in_use" } });
    expect(world.firewalls).toHaveLength(1);
    await c.deleteServer(made.server.id);
    expect(await c.deleteFirewall(fw.id)).toBe(true);
    expect(world.firewalls).toHaveLength(0);
  });

  it("checks the placement before a create, and verifies the token", async () => {
    const c = make();
    await c.verifyToken();
    await c.checkPlacement("cx22", "fsn1");
    expect((await thrown(c.checkPlacement("nope", "fsn1"))).code).toBe("invalid_input");
    expect((await thrown(c.checkPlacement("cx22", "mars"))).code).toBe("invalid_input");
    expect((await thrown(c.checkPlacement("cx32", "nbg1"))).code).toBe("resource_unavailable");
    expect((await thrown(make({ token: "wrong-token-0123456789" }).verifyToken())).code).toBe("unauthorized");
  });

  it("waits for a server to be running or deleted, within a bound", async () => {
    const c = make();
    const s = (await c.createServer(create("w1"))).server;
    const poll = vi.fn();
    const slow = make({ sleep: async (ms) => { poll(); world.clock.t += ms; world.servers[0]!.status = "running"; } });
    await slow.waitForServer(s.id, "running", { intervalMs: 10 });
    expect(poll).toHaveBeenCalledTimes(1);
    await c.deleteServer(s.id);
    await c.waitForServer(s.id, "deleted");
    world.servers.push({ ...s, status: "initializing" });
    expect((await thrown(c.waitForServer(s.id, "running", { timeoutMs: 20, intervalMs: 10 }))).code).toBe("unavailable");
  });
});

describe("the contract", () => {
  it("sends the User-Agent and a bearer token, and refuses an unknown certificate", async () => {
    await make().listLocations();
    expect(world.requests[0]!.headers["user-agent"]).toBe("fulcrumaxe-cloud/0.1.0");
    expect(world.requests[0]!.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    await make({ version: "9.9.9" }).listLocations();
    expect(world.requests[1]!.headers["user-agent"]).toBe("fulcrumaxe-cloud/9.9.9");
    const stranger = generateSelfSignedCert("api.hetzner.cloud", 1, { dnsNames: ["api.hetzner.cloud"] });
    const before = world.requests.length;
    const e = await thrown(make({ testTarget: { lookup: fake.lookup, port: fake.port, ca: stranger.certPem }, maxRetries: 0 }).listLocations());
    expect(e.code).toBe("unavailable");
    expect(e.extra.reason).toMatch(/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/);
    expect(world.requests.length).toBe(before);
  });

  it("refuses the test target outside tests, when the client is built and again on each request", async () => {
    const c = make();
    process.env.NODE_ENV = "production";
    try {
      expect((await thrown(c.listLocations())).code).toBe("unavailable");
      expect(() => make()).toThrow(/test target is refused/);
      expect(() => createHetznerClient({ token: TOKEN })).not.toThrow();
    } finally { process.env.NODE_ENV = "test"; }
  });

  it("maps Hetzner's codes, and an unknown one to unavailable", async () => {
    const c = make({ maxRetries: 0 });
    const cases: Array<[number, string, string]> = [[401, "unauthorized", "unauthorized"], [403, "forbidden", "forbidden"], [403, "resource_limit_exceeded", "resource_limit_exceeded"], [412, "resource_unavailable", "resource_unavailable"], [422, "placement_error", "placement_error"], [409, "uniqueness_error", "uniqueness_error"], [422, "invalid_input", "invalid_input"], [500, "server_error", "server_error"], [404, "not_found", "not_found"], [423, "locked", "locked"], [403, "maintenance", "unavailable"], [418, "brand_new_code", "unavailable"], [503, "unavailable", "unavailable"]];
    for (const [status, code, want] of cases) {
      world.failNext.push({ status, code });
      const e = await thrown(c.listLocations());
      expect([code, e.code, e.status]).toEqual([code, want, status]);
    }
  });

  it("shows Hetzner's account-limit error plainly, with the raw code kept", async () => {
    world.serverLimit = 0;
    const e = await thrown(make().createServer(create("lim")));
    expect(e).toMatchObject({ code: "resource_limit_exceeded", status: 403 });
    expect(e.extra.hetznerCode).toBe("resource_limit_exceeded");
    expect(e.message).toBe("server limit exceeded");
  });

  it("maps a 429 to rate_limit_exceeded with retry_after from the reset header, without retrying a wait that is too long", async () => {
    world.remaining = 0;
    world.limit = 3600;
    const e = await thrown(make({ maxWaitMs: 100, maxRetries: 0 }).listLocations());
    expect(e).toMatchObject({ code: "rate_limit_exceeded", status: 429 });
    expect(e.retryAfter).toBe(1);
    expect(e.extra.resetAt).toBeGreaterThan(world.clock.t);
    world.limit = 10;
    world.remaining = 0;
    const slow = await thrown(make({ maxWaitMs: 1000, maxRetries: 3 }).listLocations());
    expect(slow.retryAfter).toBe(360);
    expect(sleeps).toEqual([]);
  });

  it("waits for the refill when the last answer said none were left, and when a 429 is short", async () => {
    const c = make();
    world.remaining = 1;
    await c.listLocations(); // takes the last one; the answer says 0 remaining
    await c.listLocations(); // waits one refill interval instead of sending into a 429
    expect(sleeps).toEqual([1000]);
    expect(world.requests.filter((r) => r.path === "/v1/locations?page=1&per_page=50")).toHaveLength(2);
    world.remaining = 0;
    sleeps.length = 0;
    await make().listLocations();
    expect(sleeps).toEqual([1000]);
  });

  it("drops the create response's root_password: no field, no trace", async () => {
    const made = await make().createServer(create("pw"));
    expect(JSON.stringify(made)).not.toMatch(/SECRET|root_password|password/i);
    expect(Object.keys(made.server)).not.toContain("root_password");
  });

  it("is strict about shapes: a missing or mistyped field is unavailable", async () => {
    world.servers.push({ id: "nope", name: "x" });
    const e = await thrown(make().listServers());
    expect(e.code).toBe("unavailable");
    expect(e.message).toMatch(/shape we do not understand/);
  });
});

describe("timeouts and retries", () => {
  it("retries a read after a 5xx or a dropped connection, within the bound", async () => {
    world.failNext.push({ status: 502, code: "bad_gateway" }, { drop: true });
    await make().listLocations();
    expect(world.requests).toHaveLength(3);
    world.requests.length = 0;
    world.failNext.push({ status: 500 }, { status: 500 }, { status: 500 });
    expect((await thrown(make().listLocations())).code).toBe("server_error");
    expect(world.requests).toHaveLength(3);
  });

  it("bounds a hung request by the per-attempt timeout", async () => {
    world.failNext.push({ hang: true });
    const e = await thrown(make({ timeoutMs: 100, maxRetries: 0 }).listLocations());
    expect(e).toMatchObject({ code: "unavailable", extra: { ambiguous: true, reason: "timeout" } });
  });

  it("repeats a write after a 429 (it did nothing), waiting for the refill", async () => {
    const c = make();
    world.remaining = 1;
    const made = await c.createServer(create("rl"));
    expect(made.reused).toBe(false);
    expect(world.servers).toHaveLength(1);
    expect(sleeps.length).toBeGreaterThan(0);
  });

  it("does not repeat a write after an ambiguous failure, but does after a 429", async () => {
    const c = make();
    world.failNext.push({ status: 500 });
    expect((await thrown(c.createFirewall({ name: "f1", rules: [] }))).code).toBe("server_error");
    expect(world.firewalls).toHaveLength(0);
    world.remaining = 1;
    await c.createFirewall({ name: "f2", rules: [] }); // 1 left -> 0: the next write waits
    await c.createFirewall({ name: "f3", rules: [] });
    expect(world.firewalls.map((f) => f.name)).toEqual(["f2", "f3"]);
  });
});

describe("an idempotent create", () => {
  it("makes one server for a double click, and a repeat returns the first", async () => {
    const c = make();
    const [a, b] = await Promise.all([c.createServer(create("dbl")), c.createServer(create("dbl"))]);
    expect(world.servers).toHaveLength(1);
    expect(a.server.id).toBe(b.server.id);
    expect([a.reused, b.reused].sort()).toEqual([false, true]);
    expect((await c.createServer(create("dbl"))).reused).toBe(true);
  });

  it("finds the server a lost response created, and retries a create that never landed", async () => {
    const c = make();
    world.failNext.push({ status: 500 }, { drop: true }); // the pre-check meets a 5xx and is repeated; the POST is dropped before it takes effect
    const made = await c.createServer(create("lost"));
    expect(world.servers).toHaveLength(1);
    expect(made.reused).toBe(false);
    const landed = { ...world.servers[0]!, id: 777, name: "third", labels: { [CREATE_KEY_LABEL]: "gone" } };
    world.servers.push(landed);
    expect((await c.createServer(create("gone", "third"))).server.id).toBe(777);
    expect(world.servers).toHaveLength(2);
  });

  describe("adopting a server by its create key", () => {
    const want = () => ({ ...create("ck", "adopt"), labels: { owner: "acct1" } });
    const seeded = async (over: Record<string, unknown> = {}, labels: Record<string, string> = { [CREATE_KEY_LABEL]: "ck", owner: "acct1" }) => {
      const c = make();
      await c.createServer({ ...create("tmp", "tmpname") });
      const t = world.servers.pop()!;
      world.servers.push({ ...t, id: 900, name: "adopt", labels, ...over });
      return c;
    };
    const refused = async (c: ReturnType<typeof make>, reason: string) => {
      const n = world.servers.length;
      const e = await thrown(c.createServer(want()));
      expect(e).toMatchObject({ code: "uniqueness_error", extra: { reason } });
      expect(world.servers).toHaveLength(n);
      expect(world.requests.some((r) => r.method === "POST" && r.body.includes('"ck"'))).toBe(false);
    };

    it("adopts one server that matches the name, type, location and every label", async () => {
      const c = await seeded();
      const r = await c.createServer(want());
      expect(r).toMatchObject({ reused: true, action: null, server: { id: 900 } });
    });
    it("refuses more than one match", async () => {
      const c = await seeded();
      const t = world.servers[0]!;
      world.servers.push({ ...t, id: 901, name: "adopt2" });
      await refused(c, "create_key_ambiguous");
    });
    it("refuses a different name", async () => { await refused(await seeded({ name: "other" }), "create_key_mismatch"); });
    it("refuses a different server type", async () => {
      const c = await seeded();
      world.servers[0]!.server_type = { id: 23, name: "cx32" };
      await refused(c, "create_key_mismatch");
    });
    it("refuses a different location", async () => {
      const c = await seeded();
      world.servers[0]!.location = { id: 2, name: "nbg1" };
      await refused(c, "create_key_mismatch");
    });
    it("refuses a missing or different caller label", async () => {
      await refused(await seeded({}, { [CREATE_KEY_LABEL]: "ck" }), "create_key_mismatch");
      world.servers.length = 0;
      await refused(await seeded({}, { [CREATE_KEY_LABEL]: "ck", owner: "someone-else" }), "create_key_mismatch");
    });
  });

  it("does not hide a real name clash, and refuses a bad key or oversized user_data locally", async () => {
    const c = make();
    await c.createServer(create("a1", "same"));
    expect((await thrown(c.createServer(create("a2", "same")))).code).toBe("uniqueness_error");
    const n = world.requests.length;
    expect((await thrown(c.createServer(create("bad key!")))).code).toBe("invalid_input");
    expect((await thrown(c.createServer({ ...create("big"), userData: "x".repeat(32 * 1024 + 1) }))).code).toBe("invalid_input");
    expect(world.requests.length).toBe(n);
  });
});

describe("a create whose first send ended ambiguously", () => {
  // The first POST may still land, so whatever the re-send or the look-up answers afterwards, nobody can say the server was not made.
  const refusals: Array<[number, string]> = [[403, "resource_limit_exceeded"], [412, "resource_unavailable"], [422, "placement_error"], [409, "uniqueness_error"]];
  for (const [status, code] of refusals) {
    it(`rethrows a re-send refused with ${code} as ambiguous, keeping its code and status`, async () => {
      const c = make({ maxRetries: 1 });
      world.failNext.push({ method: "POST", path: "/servers", status: 500 }, { method: "POST", path: "/servers", status, code });
      const e = await thrown(c.createServer(create("amb1")));
      expect(e).toMatchObject({ code, extra: { ambiguous: true, status } });
      expect(world.requests.filter((r) => r.method === "POST")).toHaveLength(2);
      expect(world.servers).toHaveLength(0);
    });
  }
  it("rethrows a look-up 401 after a uniqueness refusal as ambiguous, keeping the 401", async () => {
    const c = make({ maxRetries: 1 });
    world.failNext.push({ method: "POST", path: "/servers", status: 500 }, { method: "POST", path: "/servers", status: 409, code: "uniqueness_error" }, { method: "GET", path: "/servers", status: 401, code: "unauthorized", skip: 2 });
    const e = await thrown(c.createServer(create("amb2")));
    expect(e).toMatchObject({ code: "unauthorized", extra: { ambiguous: true, status: 401 } });
  });
  it("leaves a refusal on the only send as a plain, non-ambiguous refusal", async () => {
    const c = make({ maxRetries: 1 });
    world.failNext.push({ method: "POST", path: "/servers", status: 403, code: "resource_limit_exceeded" });
    const e = await thrown(c.createServer(create("amb3")));
    expect(e.code).toBe("resource_limit_exceeded");
    expect(e.ambiguous).toBe(false);
    expect(world.requests.filter((r) => r.method === "POST")).toHaveLength(1);
  });
});

describe("the token never leaves", () => {
  it("is absent from every error, stack, inspection, stdout and log, on every path", async () => {
    const out: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(" "))));
    const w1 = vi.spyOn(process.stdout, "write").mockImplementation((s: unknown) => (out.push(String(s)), true));
    const w2 = vi.spyOn(process.stderr, "write").mockImplementation((s: unknown) => (out.push(String(s)), true));
    const errors: unknown[] = [];
    const run = async (p: Promise<unknown>): Promise<void> => { try { await p; } catch (e) { errors.push(e); } };
    const c = make({ maxRetries: 0 });
    for (const status of [401, 403, 404, 422, 429, 500, 503]) {
      world.failNext.push({ status, code: status === 429 ? "rate_limit_exceeded" : "invalid_input", message: `echo ${TOKEN} and Authorization: Bearer ${TOKEN}` });
      await run(c.listServers());
    }
    await run(make({ token: "wrong-token-0123456789", maxRetries: 0 }).listLocations()); // 401 from the fake
    world.servers.push({ id: "bad" });
    await run(c.listServers()); // shape error
    world.servers.length = 0;
    for (const call of [() => c.createFirewall({ name: "f", rules: [] }), () => c.listFirewalls(), () => c.getFirewall(1), () => c.deleteFirewall(1), () => c.createSshKey({ name: "k", publicKey: "ssh-ed25519 AAAA-example" }), () => c.listSshKeys(), () => c.deleteSshKey(1), () => c.getActions([1]), () => c.rebootServer(1), () => c.powerOnServer(1), () => c.powerOffServer(1), () => c.renameServer(1, "n")]) {
      world.failNext.push({ status: 500, message: `echo ${TOKEN}` });
      await run(call());
    }
    world.failNext.push({ hang: true });
    await run(make({ timeoutMs: 50, maxRetries: 0 }).listLocations());
    world.failNext.push({ drop: true });
    await run(c.listLocations());
    const stranger = generateSelfSignedCert("api.hetzner.cloud", 1, { dnsNames: ["api.hetzner.cloud"] });
    await run(make({ testTarget: { lookup: fake.lookup, port: fake.port, ca: stranger.certPem } }).listLocations());
    await run(c.createServer({ ...create("bad key"), idempotencyKey: `bad ${TOKEN}` }));
    for (const bad of [`${TOKEN} with space`, `${TOKEN}\nx`, "", undefined as unknown as string]) await run(Promise.resolve().then(() => make({ token: bad })));
    spies.forEach((s) => s.mockRestore());
    w1.mockRestore();
    w2.mockRestore();
    expect(errors.length).toBeGreaterThanOrEqual(27);
    for (const e of errors) {
      expect(e).toBeInstanceOf(HetznerError);
      const text = [String((e as Error).message), String((e as Error).stack), String(e), inspect(e, { depth: 6, showHidden: true }), JSON.stringify(e, Object.getOwnPropertyNames(e))].join("\n");
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain("SENTINEL");
    }
    expect(out.join("\n")).not.toContain("SENTINEL");
    const shown = [inspect(c, { depth: 6, showHidden: true }), JSON.stringify(c), String(c)].join("\n");
    expect(shown).not.toContain("SENTINEL");
  });
});

// The recorded drift run needs a real Hetzner token (it needs a real token). Skipped with its reason: it must never count as a pass.
describe.skip("drift against the live API (unrecorded fakes; needs a real token)", () => {
  it("compares the fields the parsers read with a recorded response", () => {});
});
