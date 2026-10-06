import { describe, expect, it } from "vitest";
import { ALLOWED_UI_CHROME, ATTESTABLE_KINDS, type ClaimKind, type ClaimVerdict, type SiteContent } from "../src/schema.js";
import { assertRenderable, gateSite, type RenderContext } from "../src/gate.js";
import { featureGridSection, heroSection, makeClaim, makeSiteContent, OTHER_VERSION_ID, page, REPO_SHA, VERSION_ID } from "./fixtures.js";

const ALL_KINDS: ClaimKind[] = ["feature", "figure", "status", "pricing", "legal", "security"];
const ALL_VERDICTS: ClaimVerdict[] = [
  "VERIFIED",
  "FALSE",
  "UNVERIFIABLE",
  "CONFLICT",
  "PENDING",
  "ATTESTED",
];

const CONTEXT: RenderContext = { repoSha: REPO_SHA, versionId: VERSION_ID };

describe("assertRenderable — pass/fail item 1 (table test, every verdict x kind)", () => {
  for (const kind of ALL_KINDS) {
    for (const verdict of ALL_VERDICTS) {
      const expected = verdict === "VERIFIED" || (verdict === "ATTESTED" && ATTESTABLE_KINDS.includes(kind));

      it(`kind=${kind} verdict=${verdict} -> ${expected}`, () => {
        const claim = makeClaim(kind, verdict);
        expect(assertRenderable(claim, CONTEXT)).toBe(expected);
      });
    }
  }

  it("goes red: VERIFIED with no evidence is not renderable", () => {
    const claim = makeClaim("feature", "VERIFIED", { evidence: [] });
    expect(assertRenderable(claim, CONTEXT)).toBe(false);
  });

  it("goes red: VERIFIED but checked against a different sha is not renderable", () => {
    const claim = makeClaim("feature", "VERIFIED", { checked_sha: "stale-sha" });
    expect(assertRenderable(claim, CONTEXT)).toBe(false);
  });

  it("goes red: ATTESTED for the wrong version is not renderable", () => {
    const claim = makeClaim("legal", "ATTESTED", {
      attestation: { user_id: "user-1", at: "2026-09-17T00:00:00Z", version_id: OTHER_VERSION_ID },
    });
    expect(assertRenderable(claim, CONTEXT)).toBe(false);
  });

  it("goes red: ATTESTED with no attestation object is not renderable", () => {
    const claim = makeClaim("pricing", "ATTESTED", { attestation: undefined });
    expect(assertRenderable(claim, CONTEXT)).toBe(false);
  });

  it("goes red: ATTESTED on a non-attestable kind is not renderable even with a matching attestation", () => {
    const claim = makeClaim("feature", "ATTESTED");
    expect(assertRenderable(claim, CONTEXT)).toBe(false);
  });
});

describe("gateSite — pass/fail item 2 (never short-circuits)", () => {
  it("reports every distinct blocker in a single pass, not just the first", () => {
    const pendingClaim = makeClaim("feature", "PENDING", { id: "claim-bad" });
    const figureClaim = makeClaim("figure", "VERIFIED", {
      id: "claim-figure",
      evidence: [{ repo_sha: REPO_SHA, path: "src/foo.ts", excerpt: "42 endpoints" }],
    });

    const content = makeSiteContent({
      claims: [pendingClaim, figureClaim],
      pages: [
        page("home", [
          // one section: a missing ref + a claim that resolves but isn't renderable
          featureGridSection(["claim-does-not-exist", pendingClaim.id]),
          // a second, independent section: an unrecognized prop key
          heroSection({ extraProp: "nope" }),
        ]),
      ],
      // plus a completely independent, page-unrelated figure claim problem
    });

    const blockers = gateSite(content, CONTEXT);
    const reasons = blockers.map((b) => b.reason);

    expect(reasons).toContain("claim-missing");
    expect(reasons).toContain("claim-not-renderable");
    expect(reasons).toContain("unknown-prop");
    expect(reasons).toContain("figure-missing-query");
    // four independent problems above, from two different sections plus a
    // page-unrelated claim; a short-circuiting implementation would stop
    // after the first and report fewer than all four.
    expect(blockers.length).toBeGreaterThanOrEqual(4);
  });

  it("returns no blockers for a fully valid site", () => {
    const claim = makeClaim("feature", "VERIFIED", { id: "claim-ok" });
    const content = makeSiteContent({
      claims: [claim],
      pages: [page("home", [featureGridSection([claim.id])])],
    });

    expect(gateSite(content, CONTEXT)).toEqual([]);
  });
});

describe("gateSite — pass/fail item 3 (referenced claim missing from claims)", () => {
  it("blocks when a section references a claim id absent from content.claims", () => {
    const content = makeSiteContent({
      claims: [],
      pages: [page("home", [featureGridSection(["ghost-claim"])])],
    });

    const blockers = gateSite(content, CONTEXT);
    expect(blockers).toContainEqual(
      expect.objectContaining({ reason: "claim-missing", claimId: "ghost-claim" }),
    );
  });

  it("does not block when every referenced claim id resolves", () => {
    const claim = makeClaim("feature", "VERIFIED", { id: "claim-present" });
    const content = makeSiteContent({
      claims: [claim],
      pages: [page("home", [featureGridSection([claim.id])])],
    });

    expect(gateSite(content, CONTEXT).some((b) => b.reason === "claim-missing")).toBe(false);
  });
});

describe("gateSite — pass/fail item 4 (figure claims require query in evidence)", () => {
  it("blocks a figure claim whose evidence has no query", () => {
    const figure = makeClaim("figure", "VERIFIED", {
      id: "claim-figure-noquery",
      evidence: [{ repo_sha: REPO_SHA, path: "src/foo.ts", excerpt: "42" }],
    });
    const content = makeSiteContent({ claims: [figure] });

    const blockers = gateSite(content, CONTEXT);
    expect(blockers).toContainEqual(
      expect.objectContaining({ reason: "figure-missing-query", claimId: "claim-figure-noquery" }),
    );
  });

  it("blocks a figure claim with no evidence at all", () => {
    const figure = makeClaim("figure", "PENDING", { id: "claim-figure-empty", evidence: [] });
    const content = makeSiteContent({ claims: [figure] });

    const blockers = gateSite(content, CONTEXT);
    expect(blockers).toContainEqual(
      expect.objectContaining({ reason: "figure-missing-query", claimId: "claim-figure-empty" }),
    );
  });

  it("does not block a figure claim whose evidence carries a query", () => {
    const figure = makeClaim("figure", "VERIFIED", {
      id: "claim-figure-ok",
      evidence: [
        { repo_sha: REPO_SHA, path: "src/foo.ts", excerpt: "42", query: "count endpoints in src/" },
      ],
    });
    const content = makeSiteContent({ claims: [figure] });

    expect(gateSite(content, CONTEXT).some((b) => b.reason === "figure-missing-query")).toBe(false);
  });

  it("does not apply the figure rule to non-figure claims", () => {
    const feature = makeClaim("feature", "VERIFIED", { id: "claim-feature", evidence: [] });
    const content = makeSiteContent({ claims: [feature] });

    expect(gateSite(content, CONTEXT).some((b) => b.reason === "figure-missing-query")).toBe(false);
  });
});

/**
 * CR fix round 2: props are typed per section type; there is no free-text
 * string prop and no length rule. Each test below is one of the exact
 * bypasses the round-1 length heuristic could not close, reproduced against
 * the typed schema to show it's structurally impossible now (not just
 * harder), plus the false positive (an ordinary tag list) that the length
 * heuristic produced and the typed schema does not.
 */
describe("gateSite — typed section props close the free-text bypasses (CR fix round 2)", () => {
  it("rejects a section type outside the fixed v1 set", () => {
    const content = {
      ...makeSiteContent(),
      pages: [{ slug: "home", sections: [{ type: "footer", props: { credit: "hi" } }] }],
    } as unknown as SiteContent;

    const blockers = gateSite(content, CONTEXT);
    expect(blockers).toContainEqual(expect.objectContaining({ reason: "unknown-section-type" }));
  });

  it("bypass: prose split across object keys {p1,p2,p3} is rejected as unknown props, not scanned as text", () => {
    const content = {
      ...makeSiteContent(),
      pages: [
        {
          slug: "home",
          sections: [
            {
              type: "hero",
              props: {
                titleChrome: "section.hero.title",
                p1: "This paragraph was split into",
                p2: "several oddly named keys so that",
                p3: "no single field alone looks like prose.",
              },
            },
          ],
        },
      ],
    } as unknown as SiteContent;

    const blockers = gateSite(content, CONTEXT);
    const unknownPropKeys = blockers.filter((b) => b.reason === "unknown-prop").map((b) => b.detail);
    expect(unknownPropKeys.some((d) => d.includes('"p1"'))).toBe(true);
    expect(unknownPropKeys.some((d) => d.includes('"p2"'))).toBe(true);
    expect(unknownPropKeys.some((d) => d.includes('"p3"'))).toBe(true);
  });

  it("bypass: nested arrays of arrays (one fragment each) fail the typed claim-id array, not a length check", () => {
    const content = {
      ...makeSiteContent(),
      pages: [
        {
          slug: "home",
          sections: [
            {
              type: "feature-grid",
              props: {
                titleChrome: "section.features.title",
                // each inner array holds one "fragment" — not a string, so
                // it can never satisfy z.array(ClaimIdField) regardless of length
                featureClaimIds: [["fragment-a"], ["fragment-b"]],
              },
            },
          ],
        },
      ],
    } as unknown as SiteContent;

    const blockers = gateSite(content, CONTEXT);
    // A wrong-type array element (round 3, item 6): this is a real value of
    // the wrong shape, not textual prose, so it's invalid-prop-value, not
    // free-text-prop.
    expect(blockers.some((b) => b.reason === "invalid-prop-value")).toBe(true);
  });

  it("bypass: interleaved chrome/claim-id-shaped strings in a claim-ref array just become unresolved claim refs", () => {
    const validClaim = makeClaim("feature", "VERIFIED", { id: "real-claim" });
    const content = makeSiteContent({
      claims: [validClaim],
      pages: [
        page("home", [
          featureGridSection([ALLOWED_UI_CHROME[0], "literal-tag-not-a-claim", validClaim.id]),
        ]),
      ],
    });

    const blockers = gateSite(content, CONTEXT);
    const missingIds = blockers.filter((b) => b.reason === "claim-missing").map((b) => b.claimId);
    expect(missingIds).toContain(ALLOWED_UI_CHROME[0]);
    expect(missingIds).toContain("literal-tag-not-a-claim");
    expect(missingIds).not.toContain(validClaim.id);
  });

  it("bypass: a free-text tag list (old array-of-short-strings bypass) is blocked, one claim-missing per tag, telling the author to make it a claim", () => {
    const tags = ["fast", "simple", "secure", "self-hosted"];
    const content = makeSiteContent({
      claims: [],
      pages: [page("home", [featureGridSection(tags)])],
    });

    const blockers = gateSite(content, CONTEXT);
    for (const tag of tags) {
      expect(blockers).toContainEqual(
        expect.objectContaining({
          reason: "claim-missing",
          claimId: tag,
          detail: expect.stringContaining("make it a claim"),
        }),
      );
    }
  });

  it("fix: a feature grid with an 8-item tag list backed by real claims passes with zero blockers", () => {
    const tagIds = Array.from({ length: 8 }, (_, i) => `tag-${i}`);
    const claims = tagIds.map((id) => makeClaim("feature", "VERIFIED", { id }));
    const content = makeSiteContent({
      claims,
      pages: [page("home", [featureGridSection(tagIds)])],
    });

    // This is exactly the case the round-1 length heuristic false-positived
    // on (an ordinary short tag list joined past 80 chars). Typed props
    // don't look at length at all, so a claim-backed tag list is clean.
    expect(gateSite(content, CONTEXT)).toEqual([]);
  });

  it("rejects an unrecognized prop key even when every other field is valid", () => {
    const content = {
      ...makeSiteContent(),
      pages: [
        {
          slug: "home",
          sections: [{ type: "hero", props: { titleChrome: "section.hero.title", subtitle: "hi" } }],
        },
      ],
    } as unknown as SiteContent;

    const blockers = gateSite(content, CONTEXT);
    expect(blockers).toContainEqual(
      expect.objectContaining({ reason: "unknown-prop", detail: expect.stringContaining('"subtitle"') }),
    );
  });

  it("rejects a chrome field that isn't one of the fixed allowlisted keys", () => {
    const content = {
      ...makeSiteContent(),
      pages: [
        {
          slug: "home",
          sections: [{ type: "hero", props: { titleChrome: "Welcome to our amazing product!" } }],
        },
      ],
    } as unknown as SiteContent;

    const blockers = gateSite(content, CONTEXT);
    expect(blockers.some((b) => b.reason === "free-text-prop")).toBe(true);
  });

  it("accepts a well-formed technical value (ctaHref) and rejects a malformed one", () => {
    const good = {
      ...makeSiteContent(),
      pages: [
        page("home", [heroSection({ ctaHref: "/pricing" })]),
      ],
    };
    expect(gateSite(good, CONTEXT).some((b) => b.reason === "free-text-prop")).toBe(false);

    const bad = {
      ...makeSiteContent(),
      pages: [
        {
          slug: "home",
          sections: [{ type: "hero", props: { titleChrome: "section.hero.title", ctaHref: "not a url" } }],
        },
      ],
    } as unknown as SiteContent;
    expect(gateSite(bad, CONTEXT).some((b) => b.reason === "free-text-prop")).toBe(true);
  });
});

describe("gateSite — duplicate claim ids (CR fix round 1, item 2)", () => {
  it("blocks when two claims share the same id, even if the later one is renderable", () => {
    const unverified = makeClaim("feature", "PENDING", { id: "dup-1" });
    const verified = makeClaim("feature", "VERIFIED", { id: "dup-1" });
    const content = makeSiteContent({ claims: [unverified, verified] });

    const blockers = gateSite(content, CONTEXT);
    expect(blockers).toContainEqual(
      expect.objectContaining({ reason: "duplicate-claim-id", claimId: "dup-1" }),
    );
  });

  it("blocks when the unverified duplicate comes last (order must not matter)", () => {
    const verified = makeClaim("feature", "VERIFIED", { id: "dup-2" });
    const unverified = makeClaim("feature", "PENDING", { id: "dup-2" });
    const content = makeSiteContent({ claims: [verified, unverified] });

    const blockers = gateSite(content, CONTEXT);
    expect(blockers).toContainEqual(
      expect.objectContaining({ reason: "duplicate-claim-id", claimId: "dup-2" }),
    );
  });

  it("reports one blocker per repeated id, alongside every other independent blocker (no short-circuit)", () => {
    const a1 = makeClaim("feature", "VERIFIED", { id: "dup-a" });
    const a2 = makeClaim("feature", "PENDING", { id: "dup-a" });
    const b1 = makeClaim("feature", "VERIFIED", { id: "dup-b" });
    const b2 = makeClaim("feature", "PENDING", { id: "dup-b" });
    const content = makeSiteContent({
      claims: [a1, a2, b1, b2],
      pages: [page("home", [featureGridSection(["ghost"])])],
    });

    const blockers = gateSite(content, CONTEXT);
    const reasons = blockers.filter((b) => b.reason === "duplicate-claim-id").map((b) => b.claimId);
    expect(reasons.sort()).toEqual(["dup-a", "dup-b"]);
    expect(blockers.some((b) => b.reason === "claim-missing")).toBe(true);
  });

  it("does not block claims with distinct ids", () => {
    const claim = makeClaim("feature", "VERIFIED", { id: "unique-1" });
    const content = makeSiteContent({ claims: [claim] });

    expect(gateSite(content, CONTEXT).some((b) => b.reason === "duplicate-claim-id")).toBe(false);
  });
});

/**
 * CR fix round 3. The re-review of the round-2 typed-props rewrite found
 * four real gaps, confirmed by execution: ctaHref accepted anything after a
 * "/" or "https://" prefix; gateSite never looked past `type`/`props`, so a
 * rogue field was invisible; site/page identifiers were unrestricted
 * strings gateSite never checked; and hero had no way to carry a real,
 * product-specific headline.
 */
describe("gateSite — ctaHref is a real URL, not a prefix test (round 3, item 1)", () => {
  it("blocks a long marketing sentence with free-text-prop (shape failure)", () => {
    const sentence =
      "Sign up today and get fifty percent off your first year of our amazing hosting platform, loved by thousands!";
    const content = makeSiteContent({
      pages: [page("home", [heroSection({ ctaHref: sentence })])],
    });

    expect(gateSite(content, CONTEXT)).toContainEqual(
      expect.objectContaining({ reason: "free-text-prop", section: "hero" }),
    );
  });

  it("blocks a dash-encoded marketing sentence in the #fragment with free-text-prop", () => {
    const dashFragment =
      "https://example.com/pricing#this-is-actually-a-long-marketing-sentence-encoded-with-dashes-instead-of-spaces";
    const content = makeSiteContent({
      domains: ["example.com"],
      pages: [page("home", [heroSection({ ctaHref: dashFragment })])],
    });

    expect(gateSite(content, CONTEXT)).toContainEqual(expect.objectContaining({ reason: "free-text-prop" }));
  });

  it("blocks an absolute URL whose host isn't a declared domain, with invalid-prop-value (well-shaped, wrong host)", () => {
    const content = makeSiteContent({
      domains: ["example.com"],
      pages: [page("home", [heroSection({ ctaHref: "https://not-example.com/pricing" })])],
    });

    expect(gateSite(content, CONTEXT)).toContainEqual(
      expect.objectContaining({ reason: "invalid-prop-value", detail: expect.stringContaining("not-example.com") }),
    );
  });

  it("allows an absolute URL whose host is a declared domain", () => {
    const content = makeSiteContent({
      domains: ["example.com"],
      pages: [page("home", [heroSection({ ctaHref: "https://example.com/pricing" })])],
    });

    expect(gateSite(content, CONTEXT).some((b) => b.section === "hero")).toBe(false);
  });

  it("allows a ctaHref pointing at this repo's own github.com/<owner>/<repo> path with no declared domains", () => {
    const content = makeSiteContent({
      repo: "owner/example",
      domains: [],
      pages: [page("home", [heroSection({ ctaHref: "https://github.com/owner/example" })])],
    });

    expect(gateSite(content, CONTEXT).some((b) => b.section === "hero")).toBe(false);
  });

  it("blocks a github.com ctaHref pointing outside this repo's own path", () => {
    const content = makeSiteContent({
      repo: "owner/example",
      domains: [],
      pages: [page("home", [heroSection({ ctaHref: "https://github.com/someone-else/other-repo" })])],
    });

    expect(gateSite(content, CONTEXT)).toContainEqual(expect.objectContaining({ reason: "invalid-prop-value" }));
  });

  it("allows a well-formed root-relative ctaHref", () => {
    const content = makeSiteContent({ pages: [page("home", [heroSection({ ctaHref: "/pricing" })])] });
    expect(gateSite(content, CONTEXT).some((b) => b.section === "hero")).toBe(false);
  });
});

describe("gateSite — a section may only have type and props (round 3, item 2)", () => {
  it("blocks a rogue field on a section (the rawHtml repro) that type/props checks alone would never see", () => {
    const content = {
      ...makeSiteContent(),
      pages: [
        {
          slug: "home",
          sections: [
            {
              type: "hero",
              props: { titleChrome: "section.hero.title" },
              rawHtml: "<script>alert(1)</script>",
            },
          ],
        },
      ],
    } as unknown as SiteContent;

    const blockers = gateSite(content, CONTEXT);
    expect(blockers).toContainEqual(
      expect.objectContaining({ reason: "unknown-section-field", detail: expect.stringContaining('"rawHtml"') }),
    );
  });

  it("still runs every other check on a section with a rogue field (no short-circuit)", () => {
    const content = {
      ...makeSiteContent(),
      pages: [
        {
          slug: "home",
          sections: [
            {
              type: "feature-grid",
              props: { titleChrome: "section.features.title", featureClaimIds: ["ghost"] },
              rawHtml: "<script>",
            },
          ],
        },
      ],
    } as unknown as SiteContent;

    const reasons = gateSite(content, CONTEXT).map((b) => b.reason);
    expect(reasons).toContain("unknown-section-field");
    expect(reasons).toContain("claim-missing");
  });

  it("does not flag an ordinary section with only type and props", () => {
    const content = makeSiteContent({ pages: [page("home", [heroSection()])] });
    expect(gateSite(content, CONTEXT).some((b) => b.reason === "unknown-section-field")).toBe(false);
  });
});

describe("gateSite — site and page identifiers are checked (round 3, item 3)", () => {
  it("blocks a site value that isn't a bounded kebab-case slug", () => {
    const content = { ...makeSiteContent(), site: "My Awesome Product!" } as SiteContent;
    expect(gateSite(content, CONTEXT)).toContainEqual(expect.objectContaining({ reason: "invalid-site-slug" }));
  });

  it("does not flag a well-formed site slug", () => {
    const content = { ...makeSiteContent(), site: "my-product" } as SiteContent;
    expect(gateSite(content, CONTEXT).some((b) => b.reason === "invalid-site-slug")).toBe(false);
  });

  it("blocks a page slug that isn't a bounded kebab-case slug", () => {
    const content = makeSiteContent({ pages: [page("Not A Slug!", [heroSection()])] });
    expect(gateSite(content, CONTEXT)).toContainEqual(
      expect.objectContaining({ reason: "invalid-page-slug", page: "Not A Slug!" }),
    );
  });

  it("blocks when siteNameClaimId doesn't resolve to a claim (the displayed name must be verified)", () => {
    const content = makeSiteContent({ siteNameClaimId: "ghost-site-name", claims: [] });
    expect(gateSite(content, CONTEXT)).toContainEqual(
      expect.objectContaining({ reason: "claim-missing", claimId: "ghost-site-name" }),
    );
  });

  it("blocks when the site-name claim resolves but isn't renderable", () => {
    const nameClaim = makeClaim("feature", "PENDING", { id: "site-name-pending" });
    const content = makeSiteContent({ siteNameClaimId: "site-name-pending", claims: [nameClaim] });
    expect(gateSite(content, CONTEXT)).toContainEqual(
      expect.objectContaining({ reason: "claim-not-renderable", claimId: "site-name-pending" }),
    );
  });

  it("does not flag a well-formed site with a verified site-name claim (the fixtures.ts default)", () => {
    const content = makeSiteContent();
    const reasons = gateSite(content, CONTEXT).map((b) => b.reason);
    expect(reasons).not.toContain("invalid-site-slug");
    expect(reasons).not.toContain("invalid-page-slug");
    expect(reasons).not.toContain("claim-missing");
  });
});

describe("gateSite — hero can carry a real headline via a claim reference (round 3, item 4)", () => {
  it("resolves headlineClaimId and subheadlineClaimId exactly like any other claim reference", () => {
    const headline = makeClaim("feature", "VERIFIED", { id: "headline-1" });
    const content = makeSiteContent({
      claims: [headline],
      pages: [page("home", [heroSection({ headlineClaimId: headline.id })])],
    });

    expect(gateSite(content, CONTEXT).some((b) => b.section === "hero")).toBe(false);
  });

  it("blocks a missing headlineClaimId reference", () => {
    const content = makeSiteContent({
      pages: [page("home", [heroSection({ headlineClaimId: "ghost-headline" })])],
    });

    expect(gateSite(content, CONTEXT)).toContainEqual(
      expect.objectContaining({ reason: "claim-missing", claimId: "ghost-headline" }),
    );
  });

  it("blocks an unrenderable subheadlineClaimId reference", () => {
    const subheadline = makeClaim("feature", "PENDING", { id: "subheadline-1" });
    const content = makeSiteContent({
      claims: [subheadline],
      pages: [page("home", [heroSection({ subheadlineClaimId: subheadline.id })])],
    });

    expect(gateSite(content, CONTEXT)).toContainEqual(
      expect.objectContaining({ reason: "claim-not-renderable", claimId: "subheadline-1" }),
    );
  });
});

describe("gateSite — accurate props-issue reasons, not free-text-prop for everything (round 3, item 6)", () => {
  it("classifies a missing required field as missing-prop", () => {
    const content = {
      ...makeSiteContent(),
      pages: [{ slug: "home", sections: [{ type: "hero", props: {} }] }],
    } as unknown as SiteContent;

    expect(gateSite(content, CONTEXT)).toContainEqual(expect.objectContaining({ reason: "missing-prop" }));
  });

  it("classifies a bad chrome value as free-text-prop", () => {
    const content = {
      ...makeSiteContent(),
      pages: [
        { slug: "home", sections: [{ type: "hero", props: { titleChrome: "Welcome to our product!" } }] },
      ],
    } as unknown as SiteContent;

    expect(gateSite(content, CONTEXT)).toContainEqual(expect.objectContaining({ reason: "free-text-prop" }));
  });

  it("classifies a bad non-chrome enum choice (layout) as invalid-prop-value, not free-text-prop", () => {
    const content = {
      ...makeSiteContent(),
      pages: [
        {
          slug: "home",
          sections: [
            { type: "hero", props: { titleChrome: "section.hero.title", layout: "diagonal" } },
          ],
        },
      ],
    } as unknown as SiteContent;

    const blockers = gateSite(content, CONTEXT);
    expect(blockers).toContainEqual(expect.objectContaining({ reason: "invalid-prop-value" }));
    expect(blockers.some((b) => b.reason === "free-text-prop")).toBe(false);
  });

  it("classifies a malformed anchor slug as invalid-prop-value, not free-text-prop", () => {
    const content = {
      ...makeSiteContent(),
      pages: [
        {
          slug: "home",
          sections: [
            {
              type: "legal-page",
              props: { titleChrome: "section.legal.title", bodyClaimIds: ["c1"], anchor: "Not Valid!!" },
            },
          ],
        },
      ],
    } as unknown as SiteContent;

    const blockers = gateSite(content, CONTEXT);
    expect(blockers).toContainEqual(expect.objectContaining({ reason: "invalid-prop-value" }));
    expect(blockers.some((b) => b.reason === "free-text-prop")).toBe(false);
  });
});

/**
 * CR fix round 4. The re-review confirmed the round-3 URL work holds, and
 * found: Section got .strict() but Page/SiteContent didn't (same rogue-
 * field hole one level up, twice); gateSite crashes instead of reporting a
 * blocker on a non-object section/page/document; and pricing-table has the
 * same "no room for a product-specific lead line" gap hero had.
 */
describe("gateSite — Page and SiteContent get the same rogue-field check as Section (round 4, item 1)", () => {
  it("blocks a rogue field on a page (next to slug/sections)", () => {
    const content = {
      ...makeSiteContent(),
      pages: [{ slug: "home", sections: [heroSection()], extra: "nope" }],
    } as unknown as SiteContent;

    const blockers = gateSite(content, CONTEXT);
    expect(blockers).toContainEqual(
      expect.objectContaining({ reason: "unknown-page-field", detail: expect.stringContaining('"extra"') }),
    );
  });

  it("blocks a rogue field on SiteContent itself", () => {
    const content = { ...makeSiteContent(), rawHtml: "<script>" } as unknown as SiteContent;

    const blockers = gateSite(content, CONTEXT);
    expect(blockers).toContainEqual(
      expect.objectContaining({ reason: "unknown-document-field", detail: expect.stringContaining('"rawHtml"') }),
    );
  });

  it("still runs every other check alongside a rogue page field (no short-circuit)", () => {
    const content = {
      ...makeSiteContent(),
      pages: [{ slug: "home", sections: [featureGridSection(["ghost"])], extra: "nope" }],
    } as unknown as SiteContent;

    const reasons = gateSite(content, CONTEXT).map((b) => b.reason);
    expect(reasons).toContain("unknown-page-field");
    expect(reasons).toContain("claim-missing");
  });

  it("does not flag an ordinary page or SiteContent with only their known fields", () => {
    const content = makeSiteContent({ pages: [page("home", [heroSection()])] });
    const reasons = gateSite(content, CONTEXT).map((b) => b.reason);
    expect(reasons).not.toContain("unknown-page-field");
    expect(reasons).not.toContain("unknown-document-field");
  });
});

describe("gateSite — a non-object section/page/document is a blocker, not a crash (round 4, item 3)", () => {
  it("reports invalid-section instead of throwing on a null section (the exact repro)", () => {
    const content = {
      ...makeSiteContent(),
      pages: [{ slug: "home", sections: [null] }],
    } as unknown as SiteContent;

    let blockers: ReturnType<typeof gateSite> = [];
    expect(() => {
      blockers = gateSite(content, CONTEXT);
    }).not.toThrow();
    expect(blockers).toContainEqual(expect.objectContaining({ reason: "invalid-section", page: "home" }));
  });

  it.each([undefined, "a string", 42, true])("reports invalid-section for a %s section too", (value) => {
    const content = {
      ...makeSiteContent(),
      pages: [{ slug: "home", sections: [value] }],
    } as unknown as SiteContent;

    let blockers: ReturnType<typeof gateSite> = [];
    expect(() => {
      blockers = gateSite(content, CONTEXT);
    }).not.toThrow();
    expect(blockers).toContainEqual(expect.objectContaining({ reason: "invalid-section" }));
  });

  it("still reports every other independent problem alongside a null section (no short-circuit)", () => {
    const content = {
      ...makeSiteContent(),
      pages: [{ slug: "home", sections: [null, featureGridSection(["ghost"])] }],
    } as unknown as SiteContent;

    const reasons = gateSite(content, CONTEXT).map((b) => b.reason);
    expect(reasons).toContain("invalid-section");
    expect(reasons).toContain("claim-missing");
  });

  it("reports invalid-page instead of throwing on a null page", () => {
    const content = { ...makeSiteContent(), pages: [null] } as unknown as SiteContent;

    let blockers: ReturnType<typeof gateSite> = [];
    expect(() => {
      blockers = gateSite(content, CONTEXT);
    }).not.toThrow();
    expect(blockers).toContainEqual(expect.objectContaining({ reason: "invalid-page" }));
  });

  it("reports invalid-document instead of throwing on a null SiteContent", () => {
    let blockers: ReturnType<typeof gateSite> = [];
    expect(() => {
      blockers = gateSite(null as unknown as SiteContent, CONTEXT);
    }).not.toThrow();
    expect(blockers).toEqual([expect.objectContaining({ reason: "invalid-document" })]);
  });

  it.each(["a string", 42, true, undefined])("reports invalid-document for a %s SiteContent too", (value) => {
    let blockers: ReturnType<typeof gateSite> = [];
    expect(() => {
      blockers = gateSite(value as unknown as SiteContent, CONTEXT);
    }).not.toThrow();
    expect(blockers).toContainEqual(expect.objectContaining({ reason: "invalid-document" }));
  });

  it("an array section does not crash either (arrays already behaved; confirms no regression)", () => {
    const content = {
      ...makeSiteContent(),
      pages: [{ slug: "home", sections: [["not", "a", "section"]] }],
    } as unknown as SiteContent;

    expect(() => gateSite(content, CONTEXT)).not.toThrow();
  });
});

describe("gateSite — pricing-table can carry a real lead line via a claim reference (round 4, item 4)", () => {
  it("resolves leadClaimId exactly like any other claim reference", () => {
    const lead = makeClaim("pricing", "VERIFIED", { id: "lead-1" });
    const content = makeSiteContent({
      claims: [lead],
      pages: [
        page("home", [
          {
            type: "pricing-table",
            props: { titleChrome: "section.pricing.title", leadClaimId: lead.id, planClaimIds: [lead.id] },
          } as never,
        ]),
      ],
    });

    expect(gateSite(content, CONTEXT).some((b) => b.section === "pricing-table")).toBe(false);
  });

  it("blocks a missing leadClaimId reference", () => {
    const plan = makeClaim("pricing", "VERIFIED", { id: "plan-1" });
    const content = makeSiteContent({
      claims: [plan],
      pages: [
        page("home", [
          {
            type: "pricing-table",
            props: { titleChrome: "section.pricing.title", leadClaimId: "ghost-lead", planClaimIds: [plan.id] },
          } as never,
        ]),
      ],
    });

    expect(gateSite(content, CONTEXT)).toContainEqual(
      expect.objectContaining({ reason: "claim-missing", claimId: "ghost-lead" }),
    );
  });

  it("blocks an unrenderable leadClaimId reference", () => {
    const lead = makeClaim("pricing", "PENDING", { id: "lead-pending" });
    const plan = makeClaim("pricing", "VERIFIED", { id: "plan-1" });
    const content = makeSiteContent({
      claims: [lead, plan],
      pages: [
        page("home", [
          {
            type: "pricing-table",
            props: { titleChrome: "section.pricing.title", leadClaimId: lead.id, planClaimIds: [plan.id] },
          } as never,
        ]),
      ],
    });

    expect(gateSite(content, CONTEXT)).toContainEqual(
      expect.objectContaining({ reason: "claim-not-renderable", claimId: "lead-pending" }),
    );
  });

  it("still works without leadClaimId (it's optional)", () => {
    const plan = makeClaim("pricing", "VERIFIED", { id: "plan-1" });
    const content = makeSiteContent({
      claims: [plan],
      pages: [
        page("home", [
          {
            type: "pricing-table",
            props: { titleChrome: "section.pricing.title", planClaimIds: [plan.id] },
          } as never,
        ]),
      ],
    });

    expect(gateSite(content, CONTEXT).some((b) => b.section === "pricing-table")).toBe(false);
  });
});
