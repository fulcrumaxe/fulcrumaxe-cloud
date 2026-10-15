import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ALLOWED_UI_CHROME,
  ClaimKind,
  DEFAULT_PRODUCT_KIND,
  PRODUCT_KINDS,
  ProductKind,
  REQUIRED_SECTIONS,
  SectionChromeKeySchema,
  SectionType,
  SiteContent,
} from "../src/schema.js";
import { gateSite, type RenderContext } from "../src/gate.js";
import { heroSection, makeClaim, makeSiteContent, page, REPO_SHA, VERSION_ID } from "./fixtures.js";

const CONTEXT: RenderContext = { repoSha: REPO_SHA, versionId: VERSION_ID };

/** A raw document, as the parser sees it (no productKind unless the test adds one). */
function rawDocument(extra: Record<string, unknown> = {}) {
  return {
    site: "example",
    siteNameClaimId: "site-name",
    repo: "owner/example",
    repo_sha: REPO_SHA,
    domains: ["example.com"],
    pages: [],
    claims: [makeClaim("feature", "VERIFIED", { id: "site-name", text: "Example" })],
    ...extra,
  };
}

function pricingSection(planClaimIds: string[], leadClaimId?: string) {
  return {
    type: "pricing-table",
    props: { titleChrome: "section.pricing.title", planClaimIds, ...(leadClaimId ? { leadClaimId } : {}) },
  } as never;
}

/** Parse a hero section whose one chrome field is set to `key`. */
function SectionProps(field: "titleChrome" | "subtitleChrome" | "ctaChrome", key: string) {
  const props = field === "titleChrome" ? { titleChrome: key } : { titleChrome: "section.hero.title", [field]: key };
  return SiteContent.safeParse(
    rawDocument({ pages: [{ slug: "home", sections: [{ type: "hero", props }] }] }),
  );
}

describe("K-KIND item 1: productKind parses strictly and defaults to open_source", () => {
  it("yields open_source when the document has no productKind", () => {
    expect(SiteContent.parse(rawDocument()).productKind).toBe("open_source");
    expect(DEFAULT_PRODUCT_KIND).toBe("open_source");
  });

  it("keeps both valid kinds as given", () => {
    for (const kind of PRODUCT_KINDS) {
      expect(SiteContent.parse(rawDocument({ productKind: kind })).productKind).toBe(kind);
    }
  });

  it("fails with a zod error naming productKind for a value outside the two kinds", () => {
    for (const bad of ["closed_source", "", "OPEN_SOURCE", null, 3]) {
      const result = SiteContent.safeParse(rawDocument({ productKind: bad }));
      expect(result.success, String(bad)).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path[0] === "productKind")).toBe(true);
        expect(result.error).toBeInstanceOf(z.ZodError);
      }
    }
  });

  it("offers exactly the two kinds", () => {
    expect([...ProductKind.options]).toEqual(["open_source", "code_visible_paid"]);
  });

  it("gateSite blocks an unparsed document with a kind outside the two, and names it", () => {
    const content = { ...makeSiteContent(), productKind: "closed_source" } as unknown as SiteContent;
    const blockers = gateSite(content, CONTEXT);
    expect(blockers.filter((b) => b.reason === "invalid-product-kind")).toHaveLength(1);
    // No kind-specific rule is applied when there is no kind to apply.
    expect(blockers.some((b) => b.reason === "required-section-missing")).toBe(false);
  });

  it("gateSite does not call productKind an unknown document field", () => {
    const blockers = gateSite(makeSiteContent({ productKind: "code_visible_paid" }), CONTEXT);
    expect(blockers.some((b) => b.reason === "unknown-document-field")).toBe(false);
  });
});

describe("K-KIND item 3: required sections and attested pricing per kind", () => {
  const attestedPlan = (id: string) => makeClaim("pricing", "ATTESTED", { id });

  it("open_source requires no section", () => {
    expect(REQUIRED_SECTIONS.open_source).toEqual([]);
    const content = makeSiteContent({ productKind: "open_source", pages: [page("home", [heroSection()])] });
    expect(gateSite(content, CONTEXT)).toEqual([]);
  });

  it("code_visible_paid with no pricing-table fails with a named blocker", () => {
    const content = makeSiteContent({ productKind: "code_visible_paid", pages: [page("home", [heroSection()])] });
    const blockers = gateSite(content, CONTEXT);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({ reason: "required-section-missing", section: "pricing-table" });
    expect(blockers[0]?.detail).toContain("pricing-table");
  });

  it("code_visible_paid with no pages at all also fails", () => {
    const blockers = gateSite(makeSiteContent({ productKind: "code_visible_paid" }), CONTEXT);
    expect(blockers.map((b) => b.reason)).toEqual(["required-section-missing"]);
  });

  it("code_visible_paid passes with a pricing-table whose claims are all attested", () => {
    const content = makeSiteContent({
      productKind: "code_visible_paid",
      claims: [attestedPlan("lead"), attestedPlan("plan-a"), attestedPlan("plan-b")],
      pages: [page("pricing", [pricingSection(["plan-a", "plan-b"], "lead")])],
    });
    expect(gateSite(content, CONTEXT)).toEqual([]);
  });

  it("a pricing claim that is machine-verified but not attested fails, naming the claim", () => {
    const content = makeSiteContent({
      productKind: "code_visible_paid",
      claims: [attestedPlan("plan-a"), makeClaim("pricing", "VERIFIED", { id: "plan-b" })],
      pages: [page("pricing", [pricingSection(["plan-a", "plan-b"])])],
    });
    const blockers = gateSite(content, CONTEXT);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({ reason: "pricing-not-attested", claimId: "plan-b" });
  });

  it("an attestation made for another version is not renderable", () => {
    const stale = makeClaim("pricing", "ATTESTED", {
      id: "plan-a",
      attestation: { user_id: "u", at: "2026-09-17T00:00:00Z", version_id: "some-other-version" },
    });
    const content = makeSiteContent({
      productKind: "code_visible_paid",
      claims: [stale],
      pages: [page("pricing", [pricingSection(["plan-a"])])],
    });
    expect(gateSite(content, CONTEXT).map((b) => b.reason)).toEqual(["claim-not-renderable"]);
  });

  it("the same VERIFIED pricing claim is fine for open_source (the attested rule is the paid kind's only)", () => {
    const content = makeSiteContent({
      productKind: "open_source",
      claims: [makeClaim("pricing", "VERIFIED", { id: "plan-a" })],
      pages: [page("pricing", [pricingSection(["plan-a"])])],
    });
    expect(gateSite(content, CONTEXT)).toEqual([]);
  });

  it("blocks an unattested pricing claim in a faq, feature-grid or hero section too", () => {
    const sections: Array<[string, unknown]> = [
      ["faq", { type: "faq", props: { titleChrome: "section.faq.title", qnaClaimIds: ["plan-a"] } }],
      ["feature-grid", { type: "feature-grid", props: { titleChrome: "section.features.title", featureClaimIds: ["plan-a"] } }],
      ["hero", heroSection({ headlineClaimId: "plan-a" })],
    ];
    for (const [type, section] of sections) {
      const content = makeSiteContent({
        productKind: "code_visible_paid",
        claims: [makeClaim("pricing", "VERIFIED", { id: "plan-a" })],
        pages: [page("home", [section as never]), page("pricing", [pricingSection(["plan-a"])])],
      });
      const blockers = gateSite(content, CONTEXT).filter((b) => b.reason === "pricing-not-attested" && b.section === type);
      expect(blockers, type).toHaveLength(1);
      expect(blockers[0]?.claimId).toBe("plan-a");
    }
  });

  it("lets an attested pricing claim through in a faq section, and non-pricing claims are unaffected", () => {
    const content = makeSiteContent({
      productKind: "code_visible_paid",
      claims: [attestedPlan("plan-a"), makeClaim("feature", "VERIFIED", { id: "feat-a" })],
      pages: [
        page("home", [
          { type: "feature-grid", props: { titleChrome: "section.features.title", featureClaimIds: ["feat-a"] } } as never,
          { type: "faq", props: { titleChrome: "section.faq.title", qnaClaimIds: ["plan-a"] } } as never,
        ]),
        page("pricing", [pricingSection(["plan-a"])]),
      ],
    });
    expect(gateSite(content, CONTEXT)).toEqual([]);
  });

  it("keeps the footer licence line and badge out of section titles, subtitles and CTA labels", () => {
    for (const key of ["footer.licence", "footer.badge"]) {
      expect(SectionChromeKeySchema.safeParse(key).success, key).toBe(false);
      expect(ALLOWED_UI_CHROME).toContain(key);
      expect(SectionProps("titleChrome", key).success, `title ${key}`).toBe(false);
      expect(SectionProps("subtitleChrome", key).success, `subtitle ${key}`).toBe(false);
      expect(SectionProps("ctaChrome", key).success, `cta ${key}`).toBe(false);
    }
    expect(SectionProps("titleChrome", "section.hero.title").success).toBe(true);
  });

  it("reports a missing pricing claim once (claim-missing), not also as not-attested", () => {
    const content = makeSiteContent({
      productKind: "code_visible_paid",
      pages: [page("pricing", [pricingSection(["ghost"])])],
    });
    expect(gateSite(content, CONTEXT).map((b) => b.reason)).toEqual(["claim-missing"]);
  });
});

describe("K-KIND item 4: no new ClaimKind and no new SectionType", () => {
  it("ClaimKind deep-equals main's enum", () => {
    expect([...ClaimKind.options]).toEqual(["feature", "figure", "status", "pricing", "legal", "security"]);
  });

  it("SectionType deep-equals main's enum", () => {
    expect([...SectionType.options]).toEqual([
      "hero",
      "feature-grid",
      "roadmap-list",
      "changelog",
      "docs-index",
      "pricing-table",
      "legal-page",
      "faq",
    ]);
  });

  it("every required section is one of the existing section types", () => {
    for (const kind of PRODUCT_KINDS) {
      for (const section of REQUIRED_SECTIONS[kind]) expect(SectionType.options).toContain(section);
    }
  });

  it("the new chrome keys are the only additions to the chrome key set", () => {
    expect([...ALLOWED_UI_CHROME]).toEqual([
      "section.hero.title",
      "section.hero.subtitle",
      "section.hero.cta",
      "section.features.title",
      "section.roadmap.title",
      "section.changelog.title",
      "section.docs.title",
      "section.pricing.title",
      "section.legal.title",
      "section.faq.title",
      "footer.credit",
      "footer.licence",
      "footer.badge",
    ]);
  });
});
