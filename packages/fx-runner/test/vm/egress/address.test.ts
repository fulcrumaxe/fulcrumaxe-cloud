import { isBlockedAddress } from "@fx/net-guard";
import { describe, expect, it } from "vitest";
import { hostAddresses, isBlockedDestination } from "../../../src/vm/egress/address.js";

const BLOCKED = [
  "127.0.0.1", "127.255.255.254", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "169.254.0.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "192.0.2.1",
  "198.18.0.1", "198.19.255.255", "192.0.0.9", "203.0.113.7", "198.51.100.7", "240.0.0.1",
  "100::1", "100::ffff:1", "64:ff9b:1::1", "64:ff9b:1:ffff::1", "::7f00:1", "::a00:1", "::1.2.3.4", "::ffff:0:1.2.3.4", "::ffff:0:0102:0304", "::ffff:1.2.3.4", "64:ff9b::1.2.3.4",
  "::", "::1", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "64:ff9b::7f00:1", "2002:7f00:1::1", "2001::1", "2001:db8::1",
  // not one clean literal: all blocked
  "", "localhost", "example.com", "127.1", "0x7f000001", "2130706433", "127.0.0.1:443", "[::1]", "fe80::1%eth0", "2606:4700:4700::1111%eth0", "1.1.1.1%eth0"," 1.1.1.1", "1.1.1.1 ", "1.1.1.256", "::g",
];
const PUBLIC = ["93.184.216.34", "1.1.1.1", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "2a00:1450:4001:81b::200e"];

describe("isBlockedDestination", () => {
  it.each(BLOCKED)("blocks %j", (ip) => {
    expect(isBlockedDestination(ip)).toBe(true);
  });
  it.each(PUBLIC)("allows the public address %s", (ip) => {
    expect(isBlockedDestination(ip)).toBe(false);
  });
  it("blocks everything the cloud's net-guard blocks, and allows what it allows among public addresses", () => {
    for (const ip of [...BLOCKED, ...PUBLIC]) if (isBlockedAddress(ip)) expect(isBlockedDestination(ip), ip).toBe(true);
    for (const ip of PUBLIC) expect(isBlockedAddress(ip), ip).toBe(false);
  });
  it("lists this host's own interface addresses, lower-cased and without a zone", () => {
    const own = hostAddresses();
    expect(own.has("127.0.0.1")).toBe(true);
    for (const a of own) expect(a).toBe(a.toLowerCase());
    for (const a of own) expect(a.includes("%")).toBe(false);
  });
});
