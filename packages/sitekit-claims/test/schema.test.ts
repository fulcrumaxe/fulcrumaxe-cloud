import { describe, expect, it } from "vitest";
import { Claim, Evidence, Section, SiteContent } from "../src/schema.js";
import {
  featureGridSection,
  heroSection,
  makeClaim,
  makeSiteContent,
  page,
  REPO_SHA,
} from "./fixtures.js";

/** A minimal, schema-valid props object for each of the 8 fixed section types. */
const MINIMAL_PROPS: Record<string, Record<string, unknown>> = {
  hero: { titleChrome: "section.hero.title" },
  "feature-grid": { titleChrome: "section.features.title", featureClaimIds: ["c1"] },
  "roadmap-list": { titleChrome: "section.roadmap.title", itemClaimIds: ["c1"] },
  changelog: { titleChrome: "section.changelog.title", entryClaimIds: ["c1"] },
  "docs-index": { titleChrome: "section.docs.title", docClaimIds: ["c1"] },
  "pricing-table": { titleChrome: "section.pricing.title", planClaimIds: ["c1"] },
  "legal-page": { titleChrome: "section.legal.title", bodyClaimIds: ["c1"] },
  faq: { titleChrome: "section.faq.title", qnaClaimIds: ["c1"] },
};

describe("schema", () => {
  it("accepts a well-formed claim", () => {
    const claim = makeClaim("feature", "VERIFIED");
    expect(() => Claim.parse(claim)).not.toThrow();
  });

  it("rejects a claim with an invalid kind", () => {
    const claim = { ...makeClaim("feature", "VERIFIED"), kind: "not-a-kind" };
    expect(() => Claim.parse(claim)).toThrow();
  });

  it("rejects a claim with an invalid verdict", () => {
    const claim = { ...makeClaim("feature", "VERIFIED"), verdict: "MAYBE" };
    expect(() => Claim.parse(claim)).toThrow();
  });

  it("accepts a well-formed SiteContent with an empty site", () => {
    expect(() => SiteContent.parse(makeSiteContent())).not.toThrow();
  });

  it("rejects a SiteContent missing repo_sha", () => {
    const content = makeSiteContent();
    // @ts-expect-error deliberately omitting a required field
    delete content.repo_sha;
    expect(() => SiteContent.parse(content)).toThrow();
  });

  // CR fix round 1, item 3: an empty excerpt must not count as evidence.
  it("rejects evidence with an empty excerpt", () => {
    const evidence = { repo_sha: REPO_SHA, path: "README.md", excerpt: "" };
    expect(() => Evidence.parse(evidence)).toThrow();
  });

  it("accepts evidence with a non-empty excerpt", () => {
    const evidence = { repo_sha: REPO_SHA, path: "README.md", excerpt: "x" };
    expect(() => Evidence.parse(evidence)).not.toThrow();
  });

  // Item 3 (CR fix round 2): the product/site name comes from SiteContent.site,
  // its own top-level field — never a section prop.
  it("rejects a SiteContent missing site", () => {
    const content: Record<string, unknown> = { ...makeSiteContent() };
    delete content.site;
    expect(() => SiteContent.parse(content)).toThrow();
  });

  // Round 3, item 3: site becomes a bounded slug, and the displayed name is
  // its own required claim reference — never a bare prop string.
  it("rejects a SiteContent missing siteNameClaimId", () => {
    const content: Record<string, unknown> = { ...makeSiteContent() };
    delete content.siteNameClaimId;
    expect(() => SiteContent.parse(content)).toThrow();
  });

  it("rejects a site value that isn't a bounded kebab-case slug", () => {
    expect(() => SiteContent.parse({ ...makeSiteContent(), site: "My Awesome Product!" })).toThrow();
    expect(() => SiteContent.parse({ ...makeSiteContent(), site: "a".repeat(41) })).toThrow();
  });

  it("accepts a well-formed site slug", () => {
    expect(() => SiteContent.parse({ ...makeSiteContent(), site: "my-product" })).not.toThrow();
  });

  it("rejects a page slug that isn't a bounded kebab-case slug", () => {
    expect(() =>
      SiteContent.parse({ ...makeSiteContent(), pages: [page("Home Page!", [heroSection()])] }),
    ).toThrow();
    expect(() =>
      SiteContent.parse({ ...makeSiteContent(), pages: [page("a".repeat(61), [heroSection()])] }),
    ).toThrow();
  });

  it("accepts a well-formed page slug", () => {
    expect(() =>
      SiteContent.parse({ ...makeSiteContent(), pages: [page("getting-started", [heroSection()])] }),
    ).not.toThrow();
  });

  it("defaults domains to an empty array when omitted", () => {
    const content: Record<string, unknown> = { ...makeSiteContent() };
    delete content.domains;
    const parsed = SiteContent.parse(content);
    expect(parsed.domains).toEqual([]);
  });

  // Round 3, item 1: host-allowlist membership is enforced at SiteContent
  // parse time too (not just gateSite), via superRefine — it needs the
  // whole document (domains, repo), so it can't live in the per-type props
  // schema alone.
  it("rejects a ctaHref whose absolute host isn't a declared domain or this repo's own github.com path", () => {
    expect(() =>
      SiteContent.parse({
        ...makeSiteContent({ domains: ["example.com"] }),
        pages: [page("home", [heroSection({ ctaHref: "https://not-example.com/pricing" })])],
      }),
    ).toThrow();
  });

  it("accepts a ctaHref whose absolute host is a declared domain", () => {
    expect(() =>
      SiteContent.parse({
        ...makeSiteContent({ domains: ["example.com"] }),
        pages: [page("home", [heroSection({ ctaHref: "https://example.com/pricing" })])],
      }),
    ).not.toThrow();
  });

  it("accepts a ctaHref pointing at this repo's own github.com/<owner>/<repo> path, without it being in domains", () => {
    expect(() =>
      SiteContent.parse({
        ...makeSiteContent({ repo: "owner/example", domains: [] }),
        pages: [page("home", [heroSection({ ctaHref: "https://github.com/owner/example" })])],
      }),
    ).not.toThrow();
  });

  it("rejects a ctaHref on github.com pointing outside this repo's own path", () => {
    expect(() =>
      SiteContent.parse({
        ...makeSiteContent({ repo: "owner/example", domains: [] }),
        pages: [page("home", [heroSection({ ctaHref: "https://github.com/someone-else/other-repo" })])],
      }),
    ).toThrow();
  });

  // Round 3, item 2: a section is strict on the OUTER object too — a rogue
  // field (e.g. a raw HTML escape hatch) doesn't parse, rather than being
  // silently stripped by the discriminated union.
  it("rejects a section carrying an unrecognized field alongside type/props", () => {
    expect(() =>
      Section.parse({ type: "hero", props: { titleChrome: "section.hero.title" }, rawHtml: "<script>" }),
    ).toThrow();
  });
});

// CR fix round 2: typed section props. There is no generic free-text string
// prop any more — every section type has its own closed (`.strict()`) props
// schema, and an unknown section type doesn't parse at all.
describe("Section — typed props per section type (CR fix round 2)", () => {
  for (const [type, props] of Object.entries(MINIMAL_PROPS)) {
    it(`accepts a minimal valid "${type}" section`, () => {
      expect(() => Section.parse({ type, props })).not.toThrow();
    });
  }

  it("rejects a section type outside the fixed v1 set", () => {
    expect(() => Section.parse({ type: "footer", props: {} })).toThrow();
  });

  it("rejects an unrecognized prop key", () => {
    expect(() =>
      Section.parse({ type: "hero", props: { titleChrome: "section.hero.title", subtitle: "hi" } }),
    ).toThrow();
  });

  it("rejects a chrome field that isn't one of the fixed allowlisted keys", () => {
    expect(() => Section.parse({ type: "hero", props: { titleChrome: "Welcome!" } })).toThrow();
  });

  it("rejects a claim-ref array holding a non-string element", () => {
    expect(() =>
      Section.parse({
        type: "feature-grid",
        props: { titleChrome: "section.features.title", featureClaimIds: [["nested"]] },
      }),
    ).toThrow();
  });

  it("rejects an empty claim-ref array (at least one reference required)", () => {
    expect(() =>
      Section.parse({ type: "feature-grid", props: { titleChrome: "section.features.title", featureClaimIds: [] } }),
    ).toThrow();
  });

  it("accepts a well-formed optional ctaHref on hero", () => {
    expect(() =>
      Section.parse({ type: "hero", props: { titleChrome: "section.hero.title", ctaHref: "/pricing" } }),
    ).not.toThrow();
    expect(() =>
      Section.parse({
        type: "hero",
        props: { titleChrome: "section.hero.title", ctaHref: "https://example.com/docs" },
      }),
    ).not.toThrow();
  });

  it("rejects a malformed ctaHref", () => {
    expect(() =>
      Section.parse({ type: "hero", props: { titleChrome: "section.hero.title", ctaHref: "not a url" } }),
    ).toThrow();
  });

  it("accepts a well-formed anchor slug on legal-page and rejects a malformed one", () => {
    expect(() =>
      Section.parse({
        type: "legal-page",
        props: { titleChrome: "section.legal.title", bodyClaimIds: ["c1"], anchor: "privacy-policy" },
      }),
    ).not.toThrow();
    expect(() =>
      Section.parse({
        type: "legal-page",
        props: { titleChrome: "section.legal.title", bodyClaimIds: ["c1"], anchor: "Not Valid!!" },
      }),
    ).toThrow();
  });

  it("accepts the fixtures.ts helper output directly (sanity check for the test suite itself)", () => {
    expect(() => Section.parse(heroSection())).not.toThrow();
    expect(() => Section.parse(featureGridSection(["c1", "c2"]))).not.toThrow();
  });

  // Round 3, item 1: ctaHref is parsed as a real URL/path, not a prefix
  // test. Reproduces the reviewer's exact repros.
  describe("ctaHref — parsed as a URL, not a prefix test (round 3, item 1)", () => {
    it("rejects a long marketing sentence (the reviewer's exact repro, a ~150-char sentence)", () => {
      const sentence =
        "Sign up today and get fifty percent off your first year of our amazing hosting platform, trusted by thousands of happy customers worldwide!";
      expect(sentence.length).toBeGreaterThan(80);
      expect(() =>
        Section.parse({ type: "hero", props: { titleChrome: "section.hero.title", ctaHref: sentence } }),
      ).toThrow();
    });

    it("rejects a dash-encoded marketing sentence smuggled into the fragment", () => {
      const dashFragment =
        "https://example.com/pricing#this-is-actually-a-long-marketing-sentence-encoded-with-dashes-instead-of-spaces-to-look-like-a-slug";
      expect(() =>
        Section.parse({ type: "hero", props: { titleChrome: "section.hero.title", ctaHref: dashFragment } }),
      ).toThrow();
    });

    it("rejects a dash-encoded marketing sentence smuggled into a root-relative path", () => {
      const dashPath =
        "/this-is-actually-a-long-marketing-sentence-encoded-with-dashes-instead-of-spaces-to-look-like-a-slug";
      expect(() =>
        Section.parse({ type: "hero", props: { titleChrome: "section.hero.title", ctaHref: dashPath } }),
      ).toThrow();
    });

    it("rejects more than one #fragment", () => {
      expect(() =>
        Section.parse({
          type: "hero",
          props: { titleChrome: "section.hero.title", ctaHref: "/pricing#one#two" },
        }),
      ).toThrow();
    });

    it("rejects too many path segments", () => {
      expect(() =>
        Section.parse({
          type: "hero",
          props: { titleChrome: "section.hero.title", ctaHref: "/a/b/c/d/e/f/g" },
        }),
      ).toThrow();
    });

    it("accepts a well-formed single #anchor-slug fragment", () => {
      expect(() =>
        Section.parse({
          type: "hero",
          props: { titleChrome: "section.hero.title", ctaHref: "https://example.com/docs#getting-started" },
        }),
      ).not.toThrow();
    });

    it("rejects a query string on a root-relative path", () => {
      expect(() =>
        Section.parse({ type: "hero", props: { titleChrome: "section.hero.title", ctaHref: "/pricing?ref=ad" } }),
      ).toThrow();
    });

    it("rejects a query string on an absolute URL", () => {
      expect(() =>
        Section.parse({
          type: "hero",
          props: { titleChrome: "section.hero.title", ctaHref: "https://example.com/pricing?ref=ad" },
        }),
      ).toThrow();
    });

    it("rejects userinfo in an absolute URL", () => {
      expect(() =>
        Section.parse({
          type: "hero",
          props: { titleChrome: "section.hero.title", ctaHref: "https://user:pass@example.com/docs" },
        }),
      ).toThrow();
    });

    it("rejects an explicit port in an absolute URL", () => {
      expect(() =>
        Section.parse({
          type: "hero",
          props: { titleChrome: "section.hero.title", ctaHref: "https://example.com:8080/docs" },
        }),
      ).toThrow();
    });

    it("rejects http (must be https)", () => {
      expect(() =>
        Section.parse({
          type: "hero",
          props: { titleChrome: "section.hero.title", ctaHref: "http://example.com/docs" },
        }),
      ).toThrow();
    });
  });

  // Round 3, item 4: hero can now carry a product-specific headline via a
  // claim reference, alongside (not instead of) chrome keys for generic
  // labels.
  it("accepts optional headlineClaimId and subheadlineClaimId on hero", () => {
    expect(() =>
      Section.parse({
        type: "hero",
        props: { titleChrome: "section.hero.title", headlineClaimId: "c1", subheadlineClaimId: "c2" },
      }),
    ).not.toThrow();
  });

  // Round 3, item 7: AssetPath is used for hero's background image.
  it("accepts a well-formed backgroundImage asset path on hero and rejects a non-image path", () => {
    expect(() =>
      Section.parse({
        type: "hero",
        props: { titleChrome: "section.hero.title", backgroundImage: "/images/hero.png" },
      }),
    ).not.toThrow();
    expect(() =>
      Section.parse({
        type: "hero",
        props: { titleChrome: "section.hero.title", backgroundImage: "/images/hero.pdf" },
      }),
    ).toThrow();
  });

  // Round 3, item 5: AnchorSlug now has a max length.
  it("rejects an anchor slug over the max length", () => {
    expect(() =>
      Section.parse({
        type: "legal-page",
        props: { titleChrome: "section.legal.title", bodyClaimIds: ["c1"], anchor: "a".repeat(41) },
      }),
    ).toThrow();
  });

  // Round 4, item 2: backgroundImage is a real path-traversal-proof asset
  // path now, not a loose character class with a dot in it.
  describe("backgroundImage — traversal-proof asset path (round 4, item 2)", () => {
    it("rejects a literal path traversal", () => {
      expect(() =>
        Section.parse({
          type: "hero",
          props: { titleChrome: "section.hero.title", backgroundImage: "/images/../../../etc/passwd.png" },
        }),
      ).toThrow();
    });

    it("rejects a percent-encoded traversal segment", () => {
      expect(() =>
        Section.parse({
          type: "hero",
          props: { titleChrome: "section.hero.title", backgroundImage: "/images/%2e%2e/etc/passwd.png" },
        }),
      ).toThrow();
    });

    it("rejects a bare dot-segment even without a full traversal chain", () => {
      expect(() =>
        Section.parse({
          type: "hero",
          props: { titleChrome: "section.hero.title", backgroundImage: "/images/./hero.png" },
        }),
      ).toThrow();
    });

    it("rejects a double extension", () => {
      expect(() =>
        Section.parse({
          type: "hero",
          props: { titleChrome: "section.hero.title", backgroundImage: "/images/shell.php.png" },
        }),
      ).toThrow();
    });

    it("rejects a 500-char path", () => {
      const longPath = "/images/" + "a".repeat(492) + ".png";
      expect(longPath.length).toBeGreaterThan(500);
      expect(() =>
        Section.parse({ type: "hero", props: { titleChrome: "section.hero.title", backgroundImage: longPath } }),
      ).toThrow();
    });

    it("rejects .svg (deliberately excluded — see schema.ts comment)", () => {
      expect(() =>
        Section.parse({
          type: "hero",
          props: { titleChrome: "section.hero.title", backgroundImage: "/images/logo.svg" },
        }),
      ).toThrow();
    });

    it("accepts each allowed extension, case-insensitively", () => {
      for (const ext of ["png", "jpg", "jpeg", "webp", "PNG", "JPG"]) {
        expect(() =>
          Section.parse({
            type: "hero",
            props: { titleChrome: "section.hero.title", backgroundImage: `/images/hero.${ext}` },
          }),
        ).not.toThrow();
      }
    });

    it("accepts a well-formed nested path", () => {
      expect(() =>
        Section.parse({
          type: "hero",
          props: { titleChrome: "section.hero.title", backgroundImage: "/images/marketing/hero-banner.png" },
        }),
      ).not.toThrow();
    });
  });

  // Round 4, item 4: pricing-table gets an optional leadClaimId, mirroring
  // hero's headlineClaimId; legal-page deliberately does not (see schema.ts
  // comment above LegalPageProps for the reasoning).
  it("accepts an optional leadClaimId on pricing-table", () => {
    expect(() =>
      Section.parse({
        type: "pricing-table",
        props: { titleChrome: "section.pricing.title", leadClaimId: "c1", planClaimIds: ["c2"] },
      }),
    ).not.toThrow();
  });

  it("rejects leadClaimId on legal-page (not part of its schema — a deliberate choice, not an oversight)", () => {
    expect(() =>
      Section.parse({
        type: "legal-page",
        props: { titleChrome: "section.legal.title", bodyClaimIds: ["c1"], leadClaimId: "c2" },
      }),
    ).toThrow();
  });
});

// Round 4, item 1: Page and SiteContent are strict on their outer object
// too, for the same reason Section is (round 3) — a rogue field must not
// parse clean.
describe("Page and SiteContent are strict on rogue fields (round 4, item 1)", () => {
  it("rejects a page carrying an unrecognized field alongside slug/sections", () => {
    expect(() =>
      SiteContent.parse({
        ...makeSiteContent(),
        pages: [{ slug: "home", sections: [heroSection()], extra: "nope" }],
      }),
    ).toThrow();
  });

  it("rejects a SiteContent carrying an unrecognized field", () => {
    expect(() => SiteContent.parse({ ...makeSiteContent(), rawHtml: "<script>" })).toThrow();
  });

  it("still accepts a well-formed page and SiteContent (no false positive)", () => {
    expect(() =>
      SiteContent.parse({ ...makeSiteContent(), pages: [page("home", [heroSection()])] }),
    ).not.toThrow();
  });
});
