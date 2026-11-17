import type { MachineProvider } from "../../src/provider.js";

/** The create flow a caller builds on the seam: price it, refuse what cannot be made, make the firewall, then the machine. It touches the interface only. */
export async function createMachineFlow(p: MachineProvider, i: { name: string; type: string; location: string; image: string; key: string }) {
  const quote = await p.quote(i.type, i.location);
  if (!quote) throw new Error("unknown type or location");
  if (!quote.available) throw new Error("not available there");
  const firewall = await p.createFirewall({ name: `${i.name}-fw`, labels: { owner: "acct1" }, rules: [{ direction: "in", protocol: "tcp", port: "22", cidrs: ["198.51.100.1/32"] }] });
  const made = await p.create({ name: i.name, type: i.type, location: i.location, image: i.image, labels: { owner: "acct1" }, firewallIds: [firewall.id], idempotencyKey: i.key });
  return { quote, firewall, ...made };
}
