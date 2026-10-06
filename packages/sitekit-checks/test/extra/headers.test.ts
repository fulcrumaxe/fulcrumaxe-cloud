import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run as checkHeaders } from "../../src/extra/headers.js";
import { CHECKS } from "../../src/index.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "check-headers");

const cache = { key: "Cache-Control", value: "public, max-age=3600" };
const RULES = [
  { source: "/search-index.json", headers: [cache] },
  { source: "/feed.xml", headers: [{ key: "cache-control", value: "public, max-age=600" }] },
];

describe("check-headers", () => {
  it("is registered under its os-site-v2 name", () => {
    expect(CHECKS["check-headers"]).toBe(checkHeaders);
  });

  it("passes when every served root data file is ruled; either key casing counts; vercel.json is not served", async () => {
    const result = await checkHeaders(path.join(FIXTURES, "pass"), { headers: RULES });
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.summary?.checked).toBe(2);
  });

  it("names each unruled root data file", async () => {
    const result = await checkHeaders(path.join(FIXTURES, "fail"), { headers: [RULES[0]] });
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => [f.kind, f.path])).toEqual([["missing_cache_rule", "/feed.xml"]]);
    expect(result.findings[0].message).toContain("feed.xml");
  });

  it("counts a catch-all cache rule", async () => {
    const result = await checkHeaders(path.join(FIXTURES, "fail"), { headers: [{ source: "/(.*)", headers: [cache] }] });
    expect(result.ok).toBe(true);
  });

  it("does not count a rule that sets other headers but no cache-control", async () => {
    const result = await checkHeaders(path.join(FIXTURES, "fail"), {
      headers: [{ source: "/(.*)", headers: [{ key: "X-Frame-Options", value: "DENY" }] }],
    });
    expect(result.findings.map((f) => f.path)).toEqual(["/feed.xml", "/search-index.json"]);
  });

  it("fails closed when headers is missing or not an array", async () => {
    for (const opts of [undefined, {}, { headers: "nope" }]) {
      const result = await checkHeaders(path.join(FIXTURES, "pass"), opts as never);
      expect(result.ok).toBe(false);
      expect(result.findings.map((f) => f.kind)).toEqual(["headers_config_missing"]);
    }
  });
});
