import { describe, expect, it } from "vitest";
import { isBlockedAddress } from "../src/blockedAddress.js";

/**
 * D#66, Spec (Acceptance) criterion 2: every range in D#31's blocked list,
 * plus the specific blocked/not-blocked addresses the Spec calls out by
 * name (including the three IPv4-in-IPv6 embedding forms).
 */

interface RangeCase {
  cidr: string;
  network: string;
  last: string;
}

const IPV4_RANGES: readonly RangeCase[] = [
  { cidr: "0.0.0.0/8", network: "0.0.0.0", last: "0.255.255.255" },
  { cidr: "10.0.0.0/8", network: "10.0.0.0", last: "10.255.255.255" },
  { cidr: "100.64.0.0/10", network: "100.64.0.0", last: "100.127.255.255" },
  { cidr: "127.0.0.0/8", network: "127.0.0.0", last: "127.255.255.255" },
  { cidr: "169.254.0.0/16", network: "169.254.0.0", last: "169.254.255.255" },
  { cidr: "172.16.0.0/12", network: "172.16.0.0", last: "172.31.255.255" },
  { cidr: "192.0.0.0/24", network: "192.0.0.0", last: "192.0.0.255" },
  { cidr: "192.0.2.0/24", network: "192.0.2.0", last: "192.0.2.255" },
  { cidr: "192.168.0.0/16", network: "192.168.0.0", last: "192.168.255.255" },
  { cidr: "198.18.0.0/15", network: "198.18.0.0", last: "198.19.255.255" },
  { cidr: "198.51.100.0/24", network: "198.51.100.0", last: "198.51.100.255" },
  { cidr: "203.0.113.0/24", network: "203.0.113.0", last: "203.0.113.255" },
  { cidr: "224.0.0.0/4", network: "224.0.0.0", last: "239.255.255.255" },
  { cidr: "240.0.0.0/4", network: "240.0.0.0", last: "255.255.255.255" },
];

const IPV6_RANGES: readonly RangeCase[] = [
  { cidr: "::/128", network: "::", last: "::" },
  { cidr: "::1/128", network: "::1", last: "::1" },
  { cidr: "fc00::/7", network: "fc00::", last: "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff" },
  { cidr: "fe80::/10", network: "fe80::", last: "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff" },
  { cidr: "ff00::/8", network: "ff00::", last: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff" },
  { cidr: "100::/64", network: "100::", last: "100::ffff:ffff:ffff:ffff" },
];

describe("isBlockedAddress (D#66, Spec criterion 2)", () => {
  describe("D#31's IPv4 ranges: network and last address are blocked", () => {
    it.each(IPV4_RANGES)("$cidr", ({ network, last }) => {
      expect(isBlockedAddress(network)).toBe(true);
      expect(isBlockedAddress(last)).toBe(true);
    });
  });

  describe("D#31's IPv6 ranges: network and last address are blocked", () => {
    it.each(IPV6_RANGES)("$cidr", ({ network, last }) => {
      expect(isBlockedAddress(network)).toBe(true);
      expect(isBlockedAddress(last)).toBe(true);
    });
  });

  it.each([
    "127.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "64:ff9b::a9fe:a9fe",
    "2002:7f00:1::",
    "fe80::1",
    "fd00::1",
    "0.0.0.0",
    "255.255.255.255",
    "not-an-ip",
    "",
  ])("blocks %j", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(["140.82.112.3", "8.8.8.8", "2606:4700:4700::1111", "::ffff:140.82.112.3"])(
    "does not block %j",
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(false);
    },
  );
});
