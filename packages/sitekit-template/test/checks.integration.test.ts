import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SiteContent, type RenderContext } from "@fx/sitekit-claims";
import { checkA11y, checkLinks, checkMeta, checkNojs, checkRedaction, checkWeight } from "@fx/sitekit-checks";
import { renderSite, writeRenderedSite } from "../src/render.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures");
const ASSET_ROOT = path.join(FIXTURES, "assets");

/**
 * D#2606 K03 pass/fail item 5: K02's check-meta, check-weight, check-links
 * and check-redaction all pass on the fixture output. check-nojs is
 * covered by pass/fail item 1's own build:fixture requirement, and
 * re-checked here too since we already have a rendered directory handy.
 */
describe("K02 mechanical checks against the rendered fixture (D#2606 K03 item 5)", () => {
  it("passes check-nojs, check-meta, check-weight, check-links and check-redaction", async () => {
    const raw = JSON.parse(fs.readFileSync(path.join(FIXTURES, "site.json"), "utf-8"));
    const content = SiteContent.parse(raw);
    const context: RenderContext = { repoSha: content.repo_sha, versionId: "fixture-v1" };
    const rendered = renderSite(content, context, ASSET_ROOT);

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "sitekit-template-K03-"));
    try {
      await writeRenderedSite(rendered, outDir);

      const nojs = await checkNojs(outDir);
      expect(nojs.findings, JSON.stringify(nojs.findings)).toEqual([]);
      expect(nojs.ok).toBe(true);

      const meta = await checkMeta(outDir);
      expect(meta.findings.filter((f) => f.severity === "error"), JSON.stringify(meta.findings)).toEqual([]);
      expect(meta.ok).toBe(true);

      const weight = await checkWeight(outDir);
      expect(weight.findings, JSON.stringify(weight.findings)).toEqual([]);
      expect(weight.ok).toBe(true);

      const links = await checkLinks(outDir, { siteDomains: [] });
      expect(links.findings.filter((f) => f.severity === "error"), JSON.stringify(links.findings)).toEqual([]);
      expect(links.ok).toBe(true);

      const redaction = await checkRedaction(outDir, {
        denyHosts: [],
        denyAccounts: [],
      });
      expect(redaction.findings, JSON.stringify(redaction.findings)).toEqual([]);
      expect(redaction.ok).toBe(true);

      // K03a: K12a's static a11y check (skip link, one h1) with default options.
      const a11y = await checkA11y(outDir);
      expect(a11y.findings.filter((f) => f.severity === "error"), JSON.stringify(a11y.findings)).toEqual([]);
      expect(a11y.ok).toBe(true);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe("check-redaction on a fixture with full-length commit ids (D3-REDACT)", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";

  it("passes with the evidence-commit option and fails without it, so the option is load-bearing", async () => {
    // The fixture's short 12-char ids never reach the 40-hex rule; this copy swaps in a real-shaped one.
    const raw = fs.readFileSync(path.join(FIXTURES, "site.json"), "utf-8").split("a1b2c3d4e5f6").join(SHA);
    const content = SiteContent.parse(JSON.parse(raw));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "sitekit-template-D3-"));
    try {
      await writeRenderedSite(renderSite(content, { repoSha: content.repo_sha, versionId: "fixture-v1" }, ASSET_ROOT), outDir);

      const without = await checkRedaction(outDir);
      expect(without.ok).toBe(false);
      expect(without.findings.every((f) => f.message.startsWith("40+ char hex blob: "))).toBe(true);

      const withOption = await checkRedaction(outDir, { evidenceCommits: { host: "github.com", repo: content.repo, shas: [SHA] } });
      expect(withOption.findings, JSON.stringify(withOption.findings)).toEqual([]);
      expect(withOption.ok).toBe(true);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
