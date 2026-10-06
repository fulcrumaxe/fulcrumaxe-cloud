import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run as checkLinks } from "../../src/checks/links.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "check-links");

describe("check-links", () => {
  it("passes a fixture with only resolvable internal links", async () => {
    const result = await checkLinks(path.join(FIXTURES, "pass"), { siteDomains: ["example.com"] });
    expect(result.ok).toBe(true);
    expect(result.findings.filter((f) => f.severity === "error")).toHaveLength(0);
  });

  it("fails a fixture with a broken link, a relative path and a missing anchor", async () => {
    const result = await checkLinks(path.join(FIXTURES, "fail"));
    expect(result.ok).toBe(false);
    const kinds = result.findings.map((f) => f.kind);
    expect(kinds).toContain("broken_link");
    expect(kinds).toContain("relative_path");
    expect(kinds).toContain("missing_anchor");
  });

  it("flags an external link outside the site's own domains as needs_review, not an error", async () => {
    const result = await checkLinks(path.join(FIXTURES, "pass"), { siteDomains: [] });
    const external = result.findings.find((f) => f.kind === "external_needs_review");
    expect(external).toBeDefined();
    expect(external?.severity).toBe("advisory");
  });

  it("never makes a network call — no fetch/http import anywhere in the module", async () => {
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../../src/checks/links.ts", import.meta.url), "utf-8"),
    );
    expect(src).not.toMatch(/\bfetch\(|require\(["']https?["']\)|from ["']node:https?["']/);
  });
});
