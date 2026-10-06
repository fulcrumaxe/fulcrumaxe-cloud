import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run as checkMeta } from "../../src/checks/meta.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "check-meta");

describe("check-meta", () => {
  it("passes a fixture with unique, present titles and descriptions", async () => {
    const result = await checkMeta(path.join(FIXTURES, "pass"));
    expect(result.ok).toBe(true);
  });

  it("fails a fixture with a missing title and a duplicated description", async () => {
    const result = await checkMeta(path.join(FIXTURES, "fail"));
    expect(result.ok).toBe(false);
    const kinds = result.findings.map((f) => f.kind);
    expect(kinds).toContain("missing_title");
    expect(kinds).toContain("duplicate_description");
  });

  it("treats length outside the recommended bounds as advisory, never a failure", async () => {
    const result = await checkMeta(path.join(FIXTURES, "pass"), { titleMax: 5 });
    const advisory = result.findings.find((f) => f.kind === "title_length");
    expect(advisory?.severity).toBe("advisory");
    expect(result.ok).toBe(true);
  });
});
