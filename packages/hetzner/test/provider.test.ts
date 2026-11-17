import { describe, expect, it } from "vitest";
import { createMachineFlow } from "./helpers/createFlow.js";
import { fakeProvider } from "./helpers/fakeProvider.js";

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
