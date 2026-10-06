import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanForHardcodedValues } from "./lib/hardcodedScan.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..", "..", "..");

/** D#2 spec amendment pass/fail item 3. */
describe("hardcoded-value guard", () => {
  it("finds no hardcoded colour or spacing value in the real surfaces", async () => {
    const violations = await scanForHardcodedValues([
      path.join(REPO_ROOT, "packages", "design", "src"),
      path.join(REPO_ROOT, "packages", "sitekit-template", "src"),
      path.join(REPO_ROOT, "apps", "web", "app"),
    ]);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it("goes red on the deliberate violation fixture", async () => {
    const violations = await scanForHardcodedValues([path.join(HERE, "fixtures")]);
    const kinds = new Set(violations.map((v) => v.kind));
    expect(violations.length).toBeGreaterThan(0);
    expect(kinds.has("hex-color")).toBe(true);
    expect(kinds.has("color-function")).toBe(true);
    expect(kinds.has("raw-length")).toBe(true);
  });

  it("does not flag the documented allowlist (0, 1px hairline borders)", async () => {
    const violations = await scanForHardcodedValues([path.join(HERE, "fixtures")]);
    const flaggedSnippets = violations.map((v) => v.snippet);
    expect(flaggedSnippets).not.toContain("0px");
    expect(flaggedSnippets).not.toContain("1px");
  });
});
