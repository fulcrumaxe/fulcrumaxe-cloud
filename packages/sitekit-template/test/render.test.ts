import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SiteContent, type RenderContext } from "@fx/sitekit-claims";
import { renderSite } from "../src/render.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures");
const ASSET_ROOT = path.join(FIXTURES, "assets");

function loadHappyFixture() {
  const raw = JSON.parse(fs.readFileSync(path.join(FIXTURES, "site.json"), "utf-8"));
  const content = SiteContent.parse(raw);
  const context: RenderContext = { repoSha: content.repo_sha, versionId: "fixture-v1" };
  return { content, context };
}

describe("renderSite — the happy fixture", () => {
  it("renders one page per SiteContent.pages, mapping the home slug to index.html", () => {
    const { content, context } = loadHappyFixture();
    const rendered = renderSite(content, context, ASSET_ROOT);
    expect(rendered.pages.map((p) => p.outputPath).sort()).toEqual(
      ["docs/index.html", "index.html", "legal/index.html", "pricing/index.html", "roadmap/index.html"].sort(),
    );
  });

  it("wraps every rendered claim in data-claim-id and a visible evidence link to the checked sha", () => {
    const { content, context } = loadHappyFixture();
    const rendered = renderSite(content, context, ASSET_ROOT);
    const home = rendered.pages.find((p) => p.outputPath === "index.html")!;

    // c-feat-1: evidence at src/import.ts lines 10-22, checked_sha a1b2c3d4e5f6.
    expect(home.html).toContain('data-claim-id="c-feat-1"');
    expect(home.html).toContain(
      'href="https://github.com/acme/widget-kit/blob/a1b2c3d4e5f6/src/import.ts#L10-L22"',
    );

    // c-status likewise.
    expect(home.html).toContain('data-claim-id="c-status"');
    expect(home.html).toContain(
      'href="https://github.com/acme/widget-kit/blob/a1b2c3d4e5f6/CHANGELOG.md#L1-L1"',
    );
  });

  it("renders the ATTESTED legal claims with data-claim-id and their own evidence link", () => {
    const { content, context } = loadHappyFixture();
    const rendered = renderSite(content, context, ASSET_ROOT);
    const legal = rendered.pages.find((p) => p.outputPath === "legal/index.html")!;

    expect(legal.html).toContain('data-claim-id="c-legal-1"');
    expect(legal.html).toContain("https://github.com/acme/widget-kit/blob/a1b2c3d4e5f6/LICENSE#L1-L3");
  });

  it("renders the displayed site name from siteNameClaimId's claim text, never from the internal `site` slug", () => {
    const { content, context } = loadHappyFixture();
    const rendered = renderSite(content, context, ASSET_ROOT);

    for (const page of rendered.pages) {
      expect(page.html).toContain("Widget Kit Pro"); // c-name's claim text
      expect(page.html).not.toContain("widget-kit-internal"); // SiteContent.site, never displayed
    }
  });

  it("renders ctaHref only as a link target — the URL string never appears as visible text", () => {
    const { content, context } = loadHappyFixture();
    const rendered = renderSite(content, context, ASSET_ROOT);
    const home = rendered.pages.find((p) => p.outputPath === "index.html")!;

    expect(home.html).toContain('href="/docs"');
    // Strip every attribute value, then confirm the raw href string is gone
    // from what's left — i.e. it never appears anywhere except as href="...".
    const withoutAttrs = home.html.replace(/="[^"]*"/g, '=""');
    expect(withoutAttrs).not.toContain("/docs");
    // The visible CTA label is the chrome copy, not the URL.
    expect(home.html).toContain(">Get started</a>");
  });

  it("resolves backgroundImage against the sandboxed asset root and records it for copying", () => {
    const { content, context } = loadHappyFixture();
    const rendered = renderSite(content, context, ASSET_ROOT);
    const home = rendered.pages.find((p) => p.outputPath === "index.html")!;

    expect(home.html).toContain('src="/images/hero-bg.png"');
    expect(rendered.assets.get("/images/hero-bg.png")).toBe(
      path.join(ASSET_ROOT, "images", "hero-bg.png"),
    );
    expect(fs.existsSync(rendered.assets.get("/images/hero-bg.png")!)).toBe(true);
  });

  it("has no <script> tag anywhere — content never requires client JS", () => {
    const { content, context } = loadHappyFixture();
    const rendered = renderSite(content, context, ASSET_ROOT);
    for (const page of rendered.pages) {
      expect(page.html).not.toMatch(/<script\b/i);
    }
  });

  it("emits distinct <title> and description across pages", () => {
    const { content, context } = loadHappyFixture();
    const rendered = renderSite(content, context, ASSET_ROOT);
    const titles = rendered.pages.map((p) => /<title>([\s\S]*?)<\/title>/.exec(p.html)?.[1]);
    const descs = rendered.pages.map((p) => /<meta name="description" content="([\s\S]*?)">/.exec(p.html)?.[1]);
    expect(new Set(titles).size).toBe(titles.length);
    expect(new Set(descs).size).toBe(descs.length);
  });
});

describe("renderSite — skip link and heading levels (K03a)", () => {
  it('puts the skip link first in <body> and gives every page <main id="main"> and one <h1>', () => {
    const { content, context } = loadHappyFixture();
    for (const page of renderSite(content, context, ASSET_ROOT).pages) {
      expect(page.html, page.outputPath).toMatch(/<body>\s*<a class="skip-link" href="#main">[^<]+<\/a>/);
      expect(page.html).toContain('<main id="main">');
      expect(page.html.match(/<h1[ >]/g) ?? [], page.outputPath).toHaveLength(1);
    }
  });

  it("renders the second and later sections as h2.section-heading", () => {
    const { content, context } = loadHappyFixture();
    const pages = renderSite(content, context, ASSET_ROOT).pages;
    const multi = pages.filter((p) => (p.html.match(/class="section-heading"/g) ?? []).length > 1);
    expect(multi.length).toBeGreaterThan(0);
    for (const page of multi) {
      const tags = [...page.html.matchAll(/<(h\d) class="section-heading">/g)].map((m) => m[1]);
      expect(tags[0]).toBe("h1");
      expect(tags.slice(1).every((t) => t === "h2")).toBe(true);
    }
  });

  it("renders a zero-section page with exactly one <h1> holding the page label", () => {
    const { content, context } = loadHappyFixture();
    const empty = { ...content, pages: [{ ...content.pages[0]!, sections: [] }] };
    const page = renderSite(empty, context, ASSET_ROOT).pages[0]!;
    expect(page.html.match(/<h1[ >]/g) ?? []).toHaveLength(1);
    expect(page.html).toContain(`<h1 class="section-heading">${content.pages[0]!.slug}</h1>`);
  });
});
