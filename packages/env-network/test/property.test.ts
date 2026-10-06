import type { EnvSpec } from "@fx/env-spec";
import { describe, expect, it } from "vitest";
import { EnvNetworkError, GITHUB_DOWNLOAD_HOSTS, toPolicy, type NetworkContext } from "../src/index.js";

const CTX: NetworkContext = { githubForwardHost: "gh-proxy.fx.example", modelProvider: "anthropic", vcrHost: "vcr.fx.example" };
const spec = (domains: readonly string[]): EnvSpec =>
  ({ version: 1, setup: [], run: [], env: {}, secrets: [], services: [], network: { domains } }) as unknown as EnvSpec;

/** mulberry32: a seeded generator, so a failure reproduces from the printed seed. */
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const PIECES = [
  "example.com", "registry.npmjs.org", "10.0.0.0/8", "0.0.0.0/0", "192.168.1.1", "0.0.0.0", "::1", "[::1]", "::ffff:10.0.0.1", "2001:db8::/32",
  "*", "*.", "*.example.com", "a.*.com", "https://example.com", "example.com:8080", "example.com/path", "u:p@example.com", "0x7f.1", "2130706433",
  "ＥＸＡＭＰＬＥ.com", "ｇｉｔｈｕｂ.ｃｏｍ", "bücher.de", "gıthub.com", "example。com", "Example.COM.", "a..b", "", ".", "-x.com", "x y.com", "github.com",
  ...GITHUB_DOWNLOAD_HOSTS, "api.github.com", "x.raw.githubusercontent.com",
];
const TAILS = ["", "", ".", ":80", ":443", "/x", "/8", "*", "%2e", "​", "？"];
const CHARS = "ab1.:/*-[]0xf@ %_ｇ。";

function entry(r: () => number): string {
  const pick = <T,>(a: readonly T[]) => a[Math.floor(r() * a.length)]!;
  if (r() < 0.3) return Array.from({ length: 1 + Math.floor(r() * 14) }, () => CHARS[Math.floor(r() * CHARS.length)]).join("");
  return pick(PIECES) + pick(TAILS);
}

const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

describe("criterion 5: hostile specs never yield an address range, IP, port or wildcard", () => {
  it("holds over 3000 seeded random specs (each either refused with EnvNetworkError or clean)", () => {
    const r = rng(0xe6);
    let clean = 0, refused = 0;
    for (let i = 0; i < 3000; i++) {
      const domains = Array.from({ length: 1 + Math.floor(r() * 5) }, () => entry(r));
      let p;
      try { p = toPolicy(spec(domains), CTX); } catch (e) {
        expect(e, `seed 0xe6 iteration ${i}: ${JSON.stringify(domains)}`).toBeInstanceOf(EnvNetworkError);
        refused++;
        continue;
      }
      clean++;
      expect(p.default).toBe("deny");
      for (const rule of p.rules) {
        const ctx = `iteration ${i}: ${JSON.stringify(domains)} -> ${JSON.stringify(rule)}`;
        expect(Object.keys(rule).sort(), ctx).toEqual(rule.purpose === "model" ? ["authHeader", "host", "purpose"] : ["host", "purpose"]);
        expect(rule.host, ctx).toMatch(HOSTNAME);
        expect(rule.host, ctx).not.toMatch(/[*:/\[\]@%\s]/);
        expect(rule.host.split(".").pop()!, ctx).not.toMatch(/^(0x[0-9a-f]*|\d+)$/); // no IPv4 in any spelling
        expect(rule.host.length, ctx).toBeLessThanOrEqual(253);
        // GitHub hosts: only download hosts, only as plain rules (no auth, no forward target), never github.com or api.github.com.
        if (/(^|\.)(github\.com|githubusercontent\.com)$/.test(rule.host)) {
          expect(rule.purpose, ctx).toBe("github_download");
          expect(GITHUB_DOWNLOAD_HOSTS, ctx).toContain(rule.host);
          expect(Object.getOwnPropertyNames(rule).sort(), ctx).toEqual(["host", "purpose"]);
        }
        expect(["github.com", "api.github.com"], ctx).not.toContain(rule.host);
      }
    }
    // The generator must reach both outcomes, or the test proves nothing.
    expect(clean).toBeGreaterThan(50);
    expect(refused).toBeGreaterThan(500);
  });
});
