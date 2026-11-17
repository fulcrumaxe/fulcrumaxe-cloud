import { MachineProviderError, type Machine, type MachineFirewall, type MachineProvider, type MachineSnapshot } from "../../src/provider.js";

/** An in-memory provider that enforces what a real one does: one machine per key, and no deleting a firewall that is still applied. */
export function fakeProvider(): MachineProvider & { machines: Map<string, Machine & { key: string; fw: string[] }>; firewalls: Map<string, MachineFirewall>; snapshots: Map<string, MachineSnapshot & { key: string; locked?: boolean }>; calls: string[] } {
  const machines = new Map<string, Machine & { key: string; fw: string[] }>();
  const firewalls = new Map<string, MachineFirewall>();
  const snapshots = new Map<string, MachineSnapshot & { key: string; locked?: boolean }>();
  const calls: string[] = [];
  let n = 0;
  const strip = (m: Machine & { key: string; fw: string[] }): Machine => ({ id: m.id, name: m.name, state: m.state, type: m.type, location: m.location, ipv4: m.ipv4, ipv6: m.ipv6, labels: m.labels });
  const match = (labels: Record<string, string>, sel: string): boolean => sel.split(",").every((c) => { const [k, v] = c.split("="); return labels[k!] === v; });
  return {
    machines, firewalls, snapshots, calls, kind: "fake",
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
    async createSnapshot(machineId, s) {
      calls.push("createSnapshot");
      if (!machines.has(machineId)) throw new MachineProviderError("not_found", "no such machine");
      const same = [...snapshots.values()].find((x) => x.key === s.key);
      if (same) return { snapshot: { ...same }, actionId: null, reused: true };
      const snap = { id: String(++n), key: s.key, status: "creating" as const, sizeGb: null, createdAt: "2026-01-01T00:00:00Z", labels: { ...s.labels, [s.keyLabel ?? "fx-create-key"]: s.key }, description: s.description, machineId };
      snapshots.set(snap.id, snap);
      return { snapshot: { ...snap }, actionId: `a${snap.id}`, reused: false };
    },
    async waitForAction(actionId) { calls.push("waitForAction"); const snap = snapshots.get(actionId.slice(1)); if (snap) { snap.status = "available"; snap.sizeGb = 2.5; } },
    async listSnapshots(sel) { return [...snapshots.values()].filter((x) => !sel || match(x.labels, sel)).map((x) => ({ ...x })); },
    async getSnapshot(id) { const x = snapshots.get(id); return x ? { ...x } : null; },
    async deleteSnapshot(id) {
      calls.push("deleteSnapshot");
      if (snapshots.get(id)?.locked) throw new MachineProviderError("conflict", "snapshot is locked", { providerCode: "locked" });
      return snapshots.delete(id);
    },
    async createFromSnapshot(s) {
      calls.push("createFromSnapshot");
      const snap = snapshots.get(s.snapshotId);
      if (!snap || snap.status !== "available") throw new MachineProviderError("invalid_input", "the snapshot is not available");
      const same = [...machines.values()].find((m) => m.key === s.idempotencyKey);
      if (same) return { machine: strip(same), reused: true, settled: true };
      const m = { id: String(++n), name: s.name, state: "starting" as const, type: s.type, location: s.location, ipv4: "203.0.113.10", ipv6: null, labels: { ...s.labels }, key: s.idempotencyKey, fw: [...(s.firewallIds ?? [])] };
      machines.set(m.id, m);
      return { machine: strip(m), reused: false, settled: false };
    },
  };
}
