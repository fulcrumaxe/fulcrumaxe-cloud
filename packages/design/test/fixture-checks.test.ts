import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkMeta, checkNojs, checkWeight } from "@fx/sitekit-checks";
import { buildFixturePage } from "./lib/fixturePage.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_FILE = path.join(HERE, "..", "fixture", "page.html");

/**
 * D#2 spec amendment pass/fail item 1: fixture/page.html renders with the
 * layer and passes K02's check-nojs, check-weight and check-meta, run in CI
 * as part of `pnpm test`.
 */
describe("fixture/page.html (D#2 spec amendment item 1)", () => {
  it("matches what the current renderers produce — no drift from the checked-in file", async () => {
    const checkedIn = await fs.readFile(FIXTURE_FILE, "utf-8");
    expect(checkedIn).toBe(buildFixturePage());
  });

  it("has no <script> tag — content needs no JavaScript", async () => {
    const doc = await fs.readFile(FIXTURE_FILE, "utf-8");
    expect(doc).not.toMatch(/<script\b/i);
  });

  it("passes check-nojs, check-meta and check-weight", async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "fx-design-fixture-"));
    try {
      await fs.copyFile(FIXTURE_FILE, path.join(outDir, "index.html"));

      const nojs = await checkNojs(outDir);
      expect(nojs.findings, JSON.stringify(nojs.findings)).toEqual([]);
      expect(nojs.ok).toBe(true);

      const meta = await checkMeta(outDir);
      expect(meta.findings.filter((f) => f.severity === "error"), JSON.stringify(meta.findings)).toEqual([]);
      expect(meta.ok).toBe(true);

      const weight = await checkWeight(outDir);
      expect(weight.findings, JSON.stringify(weight.findings)).toEqual([]);
      expect(weight.ok).toBe(true);
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });
});
