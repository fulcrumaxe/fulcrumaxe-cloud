import net from "node:net";
import os from "node:os";

/**
 * D#587 B-4a: which resolved addresses the egress proxy will never connect to. Fail closed: a string that is not exactly one IP literal
 * (a zone id, a port, brackets, a hostname) is blocked. This mirrors `isBlockedAddress` in the cloud's net-guard package, which this
 * package cannot take as a dependency, because it ships to a customer machine; `test/vm/egress/address.test.ts` holds the two together over a corpus. It is
 * deliberately a little stricter: every IPv6 range that can carry an IPv4 address (mapped, NAT64, 6to4, Teredo) is blocked whole, not
 * unwrapped, because a name that resolves to one of them is never a legitimate public destination.
 */
const V4_BLOCKED: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];
const V6_BLOCKED: ReadonlyArray<readonly [string, number]> = [
  ["::", 96], ["::1", 128], ["::ffff:0:0", 96], ["::ffff:0:0:0", 96], ["64:ff9b:1::", 48], ["64:ff9b::", 96], ["2002::", 16], ["2001::", 32], ["2001:db8::", 32], ["100::", 64], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
];
// Two lists, because Node checks a plain IPv4 address against IPv6 rules as its mapped form, so the `::ffff:0:0/96` rule would block every IPv4 address.
const BLOCKED_V4 = new net.BlockList();
const BLOCKED_V6 = new net.BlockList();
for (const [base, prefix] of V4_BLOCKED) BLOCKED_V4.addSubnet(base, prefix, "ipv4");
for (const [base, prefix] of V6_BLOCKED) BLOCKED_V6.addSubnet(base, prefix, "ipv6");

/** True when `ip` is not a public unicast address, or is not one clean IP literal. */
export function isBlockedDestination(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 0 || ip.includes("%")) return true;
  try {
    return family === 4 ? BLOCKED_V4.check(ip, "ipv4") : BLOCKED_V6.check(ip, "ipv6");
  } catch {
    // fx-swallow-ok: an address the list cannot judge is blocked, never allowed
    return true;
  }
}

/** The addresses of this host's own interfaces, so a name that resolves to the host itself (its public address too) is refused. */
export function hostAddresses(): Set<string> {
  const found = new Set<string>();
  for (const list of Object.values(os.networkInterfaces())) for (const entry of list ?? []) found.add(entry.address.split("%")[0]!.toLowerCase());
  return found;
}
