import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run as checkWeight } from "../../src/checks/weight.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "check-weight");

describe("check-weight", () => {
  it("passes a light page under both the total and JS budgets", async () => {
    const result = await checkWeight(path.join(FIXTURES, "pass"));
    expect(result.ok).toBe(true);
  });

  it("fails a page whose scripts alone exceed the JS budget", async () => {
    const result = await checkWeight(path.join(FIXTURES, "fail"));
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.kind)).toContain("over_js_budget");
  });

  it("never counts a lazy-loaded image against the first-visit budget", async () => {
    const os = await import("node:os");
    const fs = await import("node:fs/promises");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sitekit-checks-weight-"));
    try {
      await fs.writeFile(
        path.join(dir, "index.html"),
        '<!doctype html><html><head><title>t</title></head><body><img src="/big.png" loading="lazy"></body></html>',
      );
      await fs.writeFile(path.join(dir, "big.png"), Buffer.alloc(500 * 1024, 1));
      const result = await checkWeight(dir);
      expect(result.ok).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
