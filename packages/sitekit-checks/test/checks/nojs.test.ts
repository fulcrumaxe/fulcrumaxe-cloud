import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run as checkNojs } from "../../src/checks/nojs.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "check-nojs");

describe("check-nojs", () => {
  it("passes a page with real prose in <main> before any script runs", async () => {
    const result = await checkNojs(path.join(FIXTURES, "pass"));
    expect(result.ok).toBe(true);
  });

  it("fails a page that is an empty shell without JavaScript", async () => {
    const result = await checkNojs(path.join(FIXTURES, "fail"));
    expect(result.ok).toBe(false);
    expect(result.findings[0].kind).toBe("thin_without_js");
  });

  it("counts CJK ideographs per-character, not per-line", async () => {
    // 45 CJK characters with no whitespace should count as 45 words, clearing
    // the (generic, non-CJK-tuned) default 40-word bar.
    const os = await import("node:os");
    const fs = await import("node:fs/promises");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sitekit-checks-nojs-"));
    try {
      await fs.writeFile(
        path.join(dir, "zh.html"),
        `<!doctype html><html><head><title>t</title></head><body><main id="main">${"这".repeat(45)}</main></body></html>`,
      );
      const result = await checkNojs(dir);
      expect(result.ok).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
