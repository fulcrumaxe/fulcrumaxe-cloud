import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALLOWED_UI_CHROME, PRODUCT_KINDS, SiteContent, type RenderContext } from "@fx/sitekit-claims";
import { checkA11y, checkLinks, checkMeta, checkNojs, checkRedaction, checkWeight } from "@fx/sitekit-checks";
import { CHROME_BY_KIND, chrome } from "../src/chrome.js";
import { RenderBlockedError, renderSite, writeRenderedSite } from "../src/render.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures");
const ASSET_ROOT = path.join(FIXTURES, "assets");

const BANNED = [/open source/i, /open-source/i, /free to modify/i, /redistribute/i];

function load(name: string) {
  const content = SiteContent.parse(JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf-8")));
  const context: RenderContext = { repoSha: content.repo_sha, versionId: "fixture-v1" };
  return { content, context };
}

/** Every file the build writes: each page's HTML plus the shared stylesheet. */
async function renderedFiles(name: string): Promise<Array<{ file: string; text: string }>> {
  const { content, context } = load(name);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "sitekit-kind-"));
  try {
    await writeRenderedSite(renderSite(content, context, ASSET_ROOT), outDir);
    const files: Array<{ file: string; text: string }> = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(html|css)$/.test(entry.name)) files.push({ file: path.relative(outDir, full), text: fs.readFileSync(full, "utf-8") });
      }
    };
    walk(outDir);
    return files;
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

describe("K-KIND item 2: code_visible_paid has its own footer and licence line", () => {
  it("renders the licence line and badge from its own dictionary, on every page", () => {
    const { content, context } = load("site.code-visible.json");
    expect(content.productKind).toBe("code_visible_paid");
    const rendered = renderSite(content, context, ASSET_ROOT);
    expect(rendered.pages.length).toBeGreaterThan(0);
    for (const page of rendered.pages) {
      expect(page.html, page.outputPath).toContain(
        '<p class="site-licence"><span class="kind-badge">Code-visible</span> The source code is public to read. Using it requires a paid plan.</p>',
      );
      expect(page.html).toContain("Built with fulcrumaxe site kit");
    }
  });

  it("uses the paid kind's own section labels (Plans, Licence), not the open_source ones", () => {
    const { content, context } = load("site.code-visible.json");
    const pricing = renderSite(content, context, ASSET_ROOT).pages.find((p) => p.outputPath === "pricing/index.html")!;
    expect(pricing.html).toContain(">Plans</h1>");
    expect(pricing.html).not.toContain(">Pricing<");
  });

  it("contains none of the open-source phrases in any rendered file, case-insensitively", async () => {
    const files = await renderedFiles("site.code-visible.json");
    expect(files.map((f) => f.file).sort()).toEqual(
      ["assets/site.css", "index.html", "legal/index.html", "pricing/index.html"].sort(),
    );
    for (const { file, text } of files) {
      for (const re of BANNED) expect(text, `${file} matches ${re}`).not.toMatch(re);
    }
  });

  it("the scan can fail: the open_source fixture's own claim text trips it", async () => {
    const files = await renderedFiles("site.json");
    expect(files.some(({ text }) => BANNED.some((re) => re.test(text)))).toBe(true);
  });

  it("no string in the paid chrome dictionary is a banned phrase", () => {
    for (const [key, value] of Object.entries(CHROME_BY_KIND.code_visible_paid)) {
      for (const re of BANNED) expect(value, key).not.toMatch(re);
    }
  });

  it("passes the same mechanical checks the open_source fixture passes", async () => {
    const { content, context } = load("site.code-visible.json");
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "sitekit-kind-checks-"));
    try {
      await writeRenderedSite(renderSite(content, context, ASSET_ROOT), outDir);
      for (const [name, result] of [
        ["nojs", await checkNojs(outDir)],
        ["meta", await checkMeta(outDir)],
        ["weight", await checkWeight(outDir)],
        ["links", await checkLinks(outDir, { siteDomains: [] })],
        ["redaction", await checkRedaction(outDir, { denyHosts: [], denyAccounts: [] })],
        ["a11y", await checkA11y(outDir)],
      ] as const) {
        expect(result.findings.filter((f) => f.severity === "error"), name).toEqual([]);
        expect(result.ok, name).toBe(true);
      }
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("refuses to render a paid site whose pricing is not attested, producing no HTML", () => {
    const { content, context } = load("site.code-visible.json");
    const claims = content.claims.map((c) =>
      c.id === "c-plan-1"
        ? { ...c, verdict: "VERIFIED" as const, attestation: undefined, evidence: [{ repo_sha: c.checked_sha, path: "pricing.json", excerpt: "x" }] }
        : c,
    );
    let thrown: unknown;
    try {
      renderSite({ ...content, claims }, context, ASSET_ROOT);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RenderBlockedError);
    expect((thrown as RenderBlockedError).blockers.map((b) => b.reason)).toEqual(["pricing-not-attested"]);
    expect((thrown as RenderBlockedError).claimIds).toEqual(["c-plan-1"]);
  });
});

describe("chrome dictionaries", () => {
  it("every kind has copy for every chrome key", () => {
    for (const kind of PRODUCT_KINDS) {
      for (const key of ALLOWED_UI_CHROME) {
        expect(typeof CHROME_BY_KIND[kind][key], `${kind}/${key}`).toBe("string");
      }
    }
  });

  it("chrome() defaults to open_source, and open_source has no licence line or badge", () => {
    expect(chrome("section.pricing.title")).toBe("Pricing");
    expect(chrome("footer.licence", "open_source")).toBe("");
    expect(chrome("footer.badge", "open_source")).toBe("");
    expect(chrome("footer.licence", "code_visible_paid")).toBe("The source code is public to read. Using it requires a paid plan.");
    expect(chrome("footer.badge", "code_visible_paid")).toBe("Code-visible");
  });

  it("the open_source output has no licence line", () => {
    const { content, context } = load("site.json");
    for (const page of renderSite(content, context, ASSET_ROOT).pages) {
      expect(page.html).not.toContain("site-licence");
      expect(page.html).not.toContain("kind-badge");
    }
  });
});
