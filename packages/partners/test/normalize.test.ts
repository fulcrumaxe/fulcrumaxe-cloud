import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HOSTNAME_PATTERN, normalizeHostname } from "../src/host/index.js";

describe("normalizeHostname (the one shared rule)", () => {
  it("lowercases, drops the port and drops one trailing dot", () => {
    expect(normalizeHostname("Partner.Example.COM.:443")).toBe("partner.example.com");
    expect(normalizeHostname("PARTNER.example.com")).toBe("partner.example.com");
    expect(normalizeHostname("partner.example.com:8080")).toBe("partner.example.com");
    expect(normalizeHostname("partner.example.com.")).toBe("partner.example.com");
    expect(normalizeHostname("localhost")).toBe("localhost");
    expect(normalizeHostname("xn--bcher-kva.example")).toBe("xn--bcher-kva.example");
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty", ""],
    ["only a port", ":443"],
    ["only a dot", "."],
    ["two trailing dots", "partner.example.com.."],
    ["an empty label", "partner..example.com"],
    ["a leading dot", ".partner.example.com"],
    ["a space", "partner example.com"],
    ["a trailing space", "partner.example.com "],
    ["a comma-chained list", "a.example.com, b.example.com"],
    ["a path", "partner.example.com/x"],
    ["userinfo", "ours@evil.example"],
    ["a scheme", "https://partner.example.com"],
    ["a backslash", "partner.example.com\\evil"],
    ["an IPv6 literal", "[::1]:3000"],
    ["two ports", "partner.example.com:80:80"],
    ["a port above 65535", "partner.example.com:70000"],
    ["an underscore", "par_tner.example.com"],
    ["a label starting with a hyphen", "-partner.example.com"],
    ["a label of 64 characters", `${"a".repeat(64)}.example.com`],
    ["a name over 253 characters", `${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.${"e".repeat(20)}.com`],
    ["a percent escape", "partner%2eexample.com"],
    ["a non-ASCII label", "bücher.example"],
  ])("refuses %s", (_name, value) => {
    expect(normalizeHostname(value as string | null | undefined)).toBeNull();
  });

  it("is idempotent", () => {
    const once = normalizeHostname("Partner.Example.COM.:443");
    expect(normalizeHostname(once)).toBe(once);
  });

  it("states the same label rule as partner_domains.hostname's CHECK in migration 0200", () => {
    const sql = readFileSync(new URL("../../db/migrations/0200_partners.sql", import.meta.url), "utf8");
    const check = /CHECK \(hostname ~ '([^']+)'\)/.exec(sql);
    expect(check).not.toBeNull();
    // SQL doubles nothing inside this literal; the escape for the dot is the same in both dialects.
    expect(HOSTNAME_PATTERN.source.replace(/\\\./g, "\\.")).toBe(check![1]!.replace(/\\\./g, "\\."));
  });
});
