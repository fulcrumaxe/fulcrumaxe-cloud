import { describe, expect, it } from "vitest";
import { MachineProviderError, type Machine, type MachineFirewall, type MachineProvider } from "../src/provider.js";
import { createMachineFlow } from "./helpers/createFlow.js";

/** An in-memory provider that enforces what a real one does: one machine per key, and no deleting a firewall that is still applied. */
function fakeProvider(): MachineProvider & { machines: Map<string, Machine & { key: string; fw: string[] }>; firewalls: Map<string, MachineFirewall> } {
  const machines = new Map<string, Machine & { key: string; fw: string[] }>();
  const firewalls = new Map<string, MachineFirewall>();
  let n = 0;
  const strip = (m: Machine & { key: string; fw: string[] }): Machine => ({ id: m.id, name: m.name, state: m.state, type: m.type, location: m.location, ipv4: m.ipv4, ipv6: m.ipv6, labels: m.labels });
  const match = (labels: Record<string, string>, sel: string): boolean => sel.split(",").every((c) => { const [k, v] = c.split("="); return labels[k!] === v; });
  return {
    machines, firewalls, kind: "fake",
    async quote(type, location) { return type === "small" && ["north", "south"].includes(location) ? { type, location, currency: "EUR", hourlyNet: "0.0100", hourlyGross: "0.0119", monthlyNet: "5.0000", monthlyGross: "5.9500", available: location === "north" } : null; },
    async create(s) {
      const same = [...machines.values()].find((m) => m.key === s.idempotencyKey);
      if (same) return { machine: strip(same), reused: true, settled: true };
      const m = { id: String(++n), name: s.name, state: "starting" as const, type: s.type, location: s.location, ipv4: "203.0.113.9", ipv6: null, labels: { ...s.labels }, key: s.idempotencyKey, fw: [...(s.firewallIds ?? [])] };
      machines.set(m.id, m);
      return { machine: strip(m), reused: false, settled: false };
    },
    async get(id) { const m = machines.get(id); return m ? strip(m) : null; },
    async delete(id) { return machines.delete(id); },
    async listByLabel(sel) { return [...machines.values()].filter((m) => match(m.labels, sel)).map(strip); },
    async createFirewall(i) { const f = { id: `f${++n}`, name: i.name, labels: { ...i.labels } }; firewalls.set(f.id, f); return f; },
    async listFirewalls(sel) { return [...firewalls.values()].filter((f) => !sel || match(f.labels, sel)); },
    async deleteFirewall(id) {
      if ([...machines.values()].some((m) => m.fw.includes(id))) throw new MachineProviderError("in_use", "firewall is still applied", { providerCode: "applied" });
      return firewalls.delete(id);
    },
  };
}
const spec = { name: "box-1", type: "small", location: "north", image: "base", key: "key-1" };

describe("the create flow through the provider interface only", () => {
  it("prices, makes the firewall and the machine, finds it by label, and repeats without a second machine", async () => {
    const p = fakeProvider();
    const first = await createMachineFlow(p, spec);
    expect(first.quote).toMatchObject({ currency: "EUR", monthlyNet: "5.0000", available: true });
    expect(first).toMatchObject({ reused: false, settled: false, machine: { name: "box-1", state: "starting", labels: { owner: "acct1" } } });
    expect(await p.get(first.machine.id)).toMatchObject({ id: first.machine.id });
    expect((await p.listByLabel("owner=acct1")).map((m) => m.id)).toEqual([first.machine.id]);
    expect((await p.listFirewalls("owner=acct1")).map((f) => f.id)).toEqual([first.firewall.id]);
    const again = await p.create({ name: "box-1", type: "small", location: "north", image: "base", idempotencyKey: "key-1" });
    expect(again).toMatchObject({ reused: true, machine: { id: first.machine.id } });
    expect(p.machines.size).toBe(1);
  });

  it("creates nothing when the quote says unknown or unavailable", async () => {
    const p = fakeProvider();
    await expect(createMachineFlow(p, { ...spec, type: "huge" })).rejects.toThrow(/unknown/);
    await expect(createMachineFlow(p, { ...spec, location: "south" })).rejects.toThrow(/not available/);
    expect(p.machines.size + p.firewalls.size).toBe(0);
  });

  it("tears down in order: the machine first, then the firewall it used", async () => {
    const p = fakeProvider();
    const r = await createMachineFlow(p, spec);
    await expect(p.deleteFirewall(r.firewall.id)).rejects.toMatchObject({ name: "MachineProviderError", code: "in_use" });
    expect(await p.delete(r.machine.id)).toBe(true);
    expect(await p.deleteFirewall(r.firewall.id)).toBe(true);
    expect(await p.get(r.machine.id)).toBeNull();
    expect(await p.delete(r.machine.id)).toBe(false);
    expect(await p.deleteFirewall(r.firewall.id)).toBe(false);
  });
});
