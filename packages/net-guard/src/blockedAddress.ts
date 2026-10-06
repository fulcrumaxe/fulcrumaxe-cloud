import net from "node:net";

/**
 * D#66: the address classifier the Discussion's motivating problem needed
 * -- a denylist over HOSTNAMES can never be complete (attacker domains,
 * wildcard-DNS lookalikes like `127.0.0.1.nip.io`, internal names), so
 * this module classifies the RESOLVED IP instead, against D#31's exact
 * blocked-range list
 * (D#31 comment 18494161).
 * `resolveChecked.ts` is what actually resolves a host and calls this on
 * every returned address.
 *
 * `isBlockedAddress` is fail-closed by construction: anything `net.isIP`
 * does not accept as a syntactically valid IPv4/IPv6 literal counts as
 * blocked, and an embedded-IPv4 form that doesn't cleanly unwrap is left
 * to the direct IPv6 range check (never treated as "not embedded, so
 * allow").
 */

interface Ipv4Range {
  /** The range's base address, as a big-endian uint32. */
  readonly base: number;
  readonly prefixLength: number;
}

interface Ipv6Range {
  /** The range's base address, as a big-endian 128-bit unsigned integer. */
  readonly base: bigint;
  readonly prefixLength: number;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value << 8) | n;
  }
  return value >>> 0;
}

function ipv4Range(addr: string, prefixLength: number): Ipv4Range {
  const base = ipv4ToInt(addr);
  if (base === null) throw new Error(`net-guard: invalid IPv4 range base ${addr}`);
  return { base, prefixLength };
}

/** D#31's IPv4 blocked-range list, exactly. */
const IPV4_BLOCKED_RANGES: readonly Ipv4Range[] = [
  ipv4Range("0.0.0.0", 8),
  ipv4Range("10.0.0.0", 8),
  ipv4Range("100.64.0.0", 10),
  ipv4Range("127.0.0.0", 8),
  ipv4Range("169.254.0.0", 16),
  ipv4Range("172.16.0.0", 12),
  ipv4Range("192.0.0.0", 24),
  ipv4Range("192.0.2.0", 24),
  ipv4Range("192.168.0.0", 16),
  ipv4Range("198.18.0.0", 15),
  ipv4Range("198.51.100.0", 24),
  ipv4Range("203.0.113.0", 24),
  ipv4Range("224.0.0.0", 4),
  ipv4Range("240.0.0.0", 4),
];

function ipv4Mask(prefixLength: number): number {
  if (prefixLength <= 0) return 0;
  if (prefixLength >= 32) return 0xffffffff;
  return (0xffffffff << (32 - prefixLength)) >>> 0;
}

function isBlockedIpv4Int(value: number): boolean {
  return IPV4_BLOCKED_RANGES.some((range) => (value & ipv4Mask(range.prefixLength)) === (range.base & ipv4Mask(range.prefixLength)));
}

function ipv6Range(addr: string, prefixLength: number): Ipv6Range {
  const groups = expandIpv6Literal(addr);
  if (!groups) throw new Error(`net-guard: invalid IPv6 range base ${addr}`);
  return { base: groupsToBigInt(groups), prefixLength };
}

/** D#31's IPv6 blocked-range list, exactly. */
const IPV6_BLOCKED_RANGES: readonly Ipv6Range[] = [
  ipv6Range("::", 128),
  ipv6Range("::1", 128),
  ipv6Range("fc00::", 7),
  ipv6Range("fe80::", 10),
  ipv6Range("ff00::", 8),
  ipv6Range("100::", 64),
];

function groupsToBigInt(groups: readonly number[]): bigint {
  let value = 0n;
  for (const g of groups) {
    value = (value << 16n) | BigInt(g);
  }
  return value;
}

function ipv6Mask(prefixLength: number): bigint {
  if (prefixLength <= 0) return 0n;
  if (prefixLength >= 128) return (1n << 128n) - 1n;
  return ((1n << BigInt(prefixLength)) - 1n) << BigInt(128 - prefixLength);
}

function isBlockedIpv6Value(value: bigint): boolean {
  return IPV6_BLOCKED_RANGES.some((range) => (value & ipv6Mask(range.prefixLength)) === (range.base & ipv6Mask(range.prefixLength)));
}

/** Converts a dotted-quad IPv4 literal into the two 16-bit hextets it
 * occupies when embedded in an IPv6 address (`::ffff:a.b.c.d`'s last
 * group, for example). */
function ipv4ToHextets(v4: string): readonly [number, number] | null {
  const n = ipv4ToInt(v4);
  if (n === null) return null;
  return [(n >>> 16) & 0xffff, n & 0xffff];
}

/** Expands a syntactically valid IPv6 literal (already accepted by
 * `net.isIPv6`) into its 8 16-bit groups, resolving `::` compression and a
 * trailing embedded-IPv4 dotted-quad group (`::ffff:127.0.0.1`) into
 * hextets first. Returns `null` only if the literal turns out not to
 * parse cleanly despite `net.isIPv6` accepting it -- callers fail closed
 * on that. */
function expandIpv6Literal(ip: string): number[] | null {
  let working = ip;

  const lastColonIdx = working.lastIndexOf(":");
  const possibleV4 = working.slice(lastColonIdx + 1);
  if (possibleV4.includes(".")) {
    const hextets = ipv4ToHextets(possibleV4);
    if (!hextets) return null;
    working = `${working.slice(0, lastColonIdx + 1)}${hextets[0].toString(16)}:${hextets[1].toString(16)}`;
  }

  const doubleColonIdx = working.indexOf("::");
  const headPart = doubleColonIdx !== -1 ? working.slice(0, doubleColonIdx) : working;
  const tailPart = doubleColonIdx !== -1 ? working.slice(doubleColonIdx + 2) : "";

  const headGroups = headPart.length > 0 ? headPart.split(":") : [];
  const tailGroups = tailPart.length > 0 ? tailPart.split(":") : [];

  let allGroupStrs: string[];
  if (doubleColonIdx !== -1) {
    const missing = 8 - headGroups.length - tailGroups.length;
    if (missing < 0) return null;
    allGroupStrs = [...headGroups, ...Array(missing).fill("0"), ...tailGroups];
  } else {
    allGroupStrs = headGroups;
  }

  if (allGroupStrs.length !== 8) return null;

  const nums: number[] = [];
  for (const g of allGroupStrs) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    nums.push(parseInt(g, 16));
  }
  return nums;
}

/** `null` when `groups` isn't shaped like one of D#31's three
 * IPv4-in-IPv6 embeddings (IPv4-mapped `::ffff:0:0/96`, NAT64
 * `64:ff9b::/96`, or 6to4 `2002::/16`); otherwise the embedded IPv4
 * address, as a uint32. */
function extractEmbeddedIpv4(groups: readonly number[]): number | null {
  // ::ffff:0:0/96 -- IPv4-mapped: groups[0..4] are 0, groups[5] is 0xffff,
  // groups[6..7] carry the embedded address.
  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff) {
    return ((groups[6]! << 16) | groups[7]!) >>> 0;
  }
  // 64:ff9b::/96 -- NAT64 well-known prefix: groups[0..1] are 0064:ff9b,
  // groups[2..5] are 0, groups[6..7] carry the embedded address.
  if (
    groups[0] === 0x0064 &&
    groups[1] === 0xff9b &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0
  ) {
    return ((groups[6]! << 16) | groups[7]!) >>> 0;
  }
  // 2002::/16 -- 6to4: groups[0] is 0x2002, groups[1..2] carry the
  // embedded address (RFC 3056's 2002:V4ADDR::/48 layout).
  if (groups[0] === 0x2002) {
    return ((groups[1]! << 16) | groups[2]!) >>> 0;
  }
  return null;
}

/**
 * True when `ip` is blocked: a loopback, private, link-local, metadata,
 * reserved, multicast or otherwise non-public address from D#31's exact
 * range list (directly, or unwrapped from an IPv4-mapped/NAT64/6to4 IPv6
 * embedding) -- or anything `net.isIP` does not accept as a valid literal
 * at all (fail closed).
 */
export function isBlockedAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) {
    const value = ipv4ToInt(ip);
    if (value === null) return true;
    return isBlockedIpv4Int(value);
  }
  if (family === 6) {
    const groups = expandIpv6Literal(ip);
    if (!groups) return true;
    if (isBlockedIpv6Value(groupsToBigInt(groups))) return true;
    const embedded = extractEmbeddedIpv4(groups);
    if (embedded !== null) return isBlockedIpv4Int(embedded);
    return false;
  }
  return true;
}
