import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HetznerError, MachineProviderError, createHetznerClient, createHetznerProvider, toMachineProviderError, type HetznerCode, type MachineErrorCode } from "../src/index.js";
import { newWorld, startStrictHetzner, type FakeWorld, type StrictHetzner } from "./helpers/strictHetzner.js";
import { createMachineFlow } from "./helpers/createFlow.js";

const TOKEN = "fxtest-SENTINEL-token-0123456789abcdef";
let fake: StrictHetzner;
let world: FakeWorld;
const prevEnv = process.env.NODE_ENV;
beforeAll(() => { process.env.NODE_ENV = "test"; });
afterAll(() => { process.env.NODE_ENV = prevEnv; });
beforeEach(async () => { world = newWorld([TOKEN]); fake = await startStrictHetzner(world); });
afterEach(async () => { await fake.close(); });

const provider = () => createHetznerProvider(createHetznerClient({ token: TOKEN, timeoutMs: 2000, sleep: async (ms) => { world.clock.t += ms; }, now: () => world.clock.t, testTarget: { lookup: fake.lookup, port: fake.port, ca: fake.ca } }));
const spec = { name: "box-1", type: "cx22", location: "fsn1", image: "ubuntu-24.04", key: "key-1" };

describe("the Hetzner implementation of the provider interface", () => {
  it("runs the same create flow, with provider-neutral shapes and no Hetzner field names", async () => {
    const p = provider();
    expect(p.kind).toBe("hetzner");
    const r = await createMachineFlow(p, spec);
    expect(r.quote).toMatchObject({ currency: "EUR", monthlyNet: "3.7900", available: true });
    expect(r).toMatchObject({ reused: false, settled: true, machine: { name: "box-1", state: "starting", type: "cx22", location: "fsn1", ipv4: "203.0.113.7", labels: { owner: "acct1" } } });
    expect(Object.keys(r.machine).sort()).toEqual(["id", "ipv4", "ipv6", "labels", "location", "name", "state", "type"]);
    expect(typeof r.machine.id).toBe("string");
    expect((await p.listByLabel("owner=acct1")).map((m) => m.id)).toEqual([r.machine.id]);
    expect((await p.listFirewalls("owner=acct1")).map((f) => f.id)).toEqual([r.firewall.id]);
    const again = await p.create({ name: "box-1", type: "cx22", location: "fsn1", image: "ubuntu-24.04", labels: { owner: "acct1" }, firewallIds: [r.firewall.id], idempotencyKey: "key-1" });
    expect(again).toMatchObject({ reused: true, settled: false, machine: { id: r.machine.id } });
    expect(world.servers).toHaveLength(1);
  });

  it("answers null for an unknown type or location, and for a machine that is gone", async () => {
    const p = provider();
    expect(await p.quote("nope", "fsn1")).toBeNull();
    expect(await p.quote("cx22", "mars")).toBeNull();
    expect(await p.quote("cx32", "nbg1")).toMatchObject({ available: false });
    expect(await p.get("123456")).toBeNull();
    expect(await p.delete("123456")).toBe(false);
    expect(await p.deleteFirewall("123456")).toBe(false);
  });

  it("deletes the machine, then the firewall; the provider refuses the firewall while it is applied", async () => {
    const p = provider();
    const r = await createMachineFlow(p, spec);
    await expect(p.deleteFirewall(r.firewall.id)).rejects.toMatchObject({ name: "MachineProviderError", code: "in_use", extra: { providerCode: "resource_in_use", status: 422 } });
    expect(await p.delete(r.machine.id)).toBe(true);
    expect(await p.deleteFirewall(r.firewall.id)).toBe(true);
    expect(world.servers).toHaveLength(0);
  });

  it("reports a machine as not settled while the create action is still running", async () => {
    world.actionStatus = "running";
    const made = await provider().create({ name: "slow", type: "cx22", location: "fsn1", image: "ubuntu-24.04", idempotencyKey: "slow-1" });
    expect(made).toMatchObject({ reused: false, settled: false });
  });

  it("sends the addresses of a rule on the side its direction names", async () => {
    await provider().createFirewall({ name: "dirs", rules: [{ direction: "in", protocol: "tcp", port: "22", cidrs: ["198.51.100.1/32"] }, { direction: "out", protocol: "udp", port: "53", cidrs: ["203.0.113.0/24"] }] });
    const rules = world.firewalls[0]!.rules as Array<{ source_ips: string[]; destination_ips: string[] }>;
    expect(rules[0]).toMatchObject({ source_ips: ["198.51.100.1/32"], destination_ips: [] });
    expect(rules[1]).toMatchObject({ source_ips: [], destination_ips: ["203.0.113.0/24"] });
  });

  it("refuses an id that is not a number before any request", async () => {
    const p = provider();
    const n = world.requests.length;
    await expect(p.get("12abc")).rejects.toMatchObject({ code: "invalid_input" });
    expect(world.requests.length).toBe(n);
  });
});

describe("the neutral error", () => {
  const table: Array<[HetznerCode, MachineErrorCode, HetznerError["extra"]?]> = [
    ["unauthorized", "unauthorized"], ["forbidden", "unauthorized"], ["resource_limit_exceeded", "unavailable"], ["resource_unavailable", "unavailable"], ["placement_error", "unavailable"],
    ["rate_limit_exceeded", "rate_limited"], ["uniqueness_error", "conflict"], ["invalid_input", "invalid_input"], ["server_error", "unavailable"], ["unavailable", "unavailable"], ["not_found", "not_found"], ["locked", "conflict"],
    ["uniqueness_error", "mismatch", { reason: "create_key_mismatch" }], ["uniqueness_error", "mismatch", { reason: "create_key_ambiguous" }],
    ["unavailable", "in_use", { hetznerCode: "resource_in_use", status: 422 }],
  ];
  it.each(table)("maps %s to %s", (code, neutral, extra) => {
    const out = toMachineProviderError(new HetznerError(code, "m", extra));
    expect(out).toBeInstanceOf(MachineProviderError);
    expect(out).toMatchObject({ code: neutral, extra: { providerCode: extra?.hetznerCode ?? code } });
  });
  it("covers every code the client can throw, and keeps retry hints and status", () => {
    const all: HetznerCode[] = ["unauthorized", "forbidden", "resource_limit_exceeded", "resource_unavailable", "placement_error", "rate_limit_exceeded", "uniqueness_error", "invalid_input", "server_error", "unavailable", "not_found", "locked"];
    for (const c of all) expect(table.some(([h]) => h === c), c).toBe(true);
    expect(toMachineProviderError(new HetznerError("rate_limit_exceeded", "m", { status: 429, retryAfter: 7, ambiguous: false }))).toMatchObject({ code: "rate_limited", extra: { status: 429, retryAfter: 7 } });
    expect(toMachineProviderError(new HetznerError("unavailable", "m", { ambiguous: true }))).toMatchObject({ extra: { ambiguous: true } });
  });
  it("passes a programming error through unchanged", () => {
    const e = new TypeError("bug");
    expect(toMachineProviderError(e)).toBe(e);
  });
  it("throws the neutral error from the provider, never HetznerError", async () => {
    const p = provider();
    world.failNext.push({ status: 401, code: "unauthorized" });
    const e = await p.quote("cx22", "fsn1").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MachineProviderError);
    expect(e).not.toBeInstanceOf(HetznerError);
    expect(e).toMatchObject({ code: "unauthorized", extra: { providerCode: "unauthorized", status: 401 } });
    await expect(p.get("12abc")).rejects.toMatchObject({ name: "MachineProviderError", code: "invalid_input" });
  });
});
