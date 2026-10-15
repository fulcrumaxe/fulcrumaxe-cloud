import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SiteContent, type RenderContext } from "@fx/sitekit-claims";
import { renderSite, SITE_CSS } from "../src/render.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures");
const SNAPSHOTS = path.join(HERE, "__snapshots__", "open-source");

/**
 * K-KIND item 2: the `open_source` fixture's rendered files are byte-identical
 * to what main rendered before `productKind` existed. The files under
 * `__snapshots__/open-source/` were written by main's renderer at the commit
 * before this change; this test only reads and compares, it never rewrites
 * them. Both the fixture with no `productKind` and one that names
 * `open_source` explicitly must match.
 */
function render(raw: unknown) {
  const content = SiteContent.parse(raw);
  const context: RenderContext = { repoSha: content.repo_sha, versionId: "fixture-v1" };
  return renderSite(content, context, path.join(FIXTURES, "assets"));
}

const raw = JSON.parse(fs.readFileSync(path.join(FIXTURES, "site.json"), "utf-8"));

describe("open_source output is byte-identical to main (snapshot)", () => {
  for (const [label, input] of [
    ["no productKind", raw],
    ["productKind: open_source", { ...raw, productKind: "open_source" }],
  ] as const) {
    it(`renders every page and the stylesheet unchanged (${label})`, () => {
      const rendered = render(input);
      const names = fs.readdirSync(SNAPSHOTS).sort();
      const expectedNames = [...rendered.pages.map((p) => p.outputPath.replace(/\//g, "__")), "site.css"].sort();
      expect(names).toEqual(expectedNames);
      for (const page of rendered.pages) {
        const snap = fs.readFileSync(path.join(SNAPSHOTS, page.outputPath.replace(/\//g, "__")), "utf-8");
        expect(page.html, page.outputPath).toBe(snap);
      }
      expect(SITE_CSS).toBe(fs.readFileSync(path.join(SNAPSHOTS, "site.css"), "utf-8"));
    });
  }
});
