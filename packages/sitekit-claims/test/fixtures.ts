import type { Claim, ClaimKind, ClaimVerdict, Evidence, Page, Section, SiteContent } from "../src/schema.js";

export const REPO_SHA = "a".repeat(40);
export const OTHER_SHA = "b".repeat(40);
export const VERSION_ID = "version-1";
export const OTHER_VERSION_ID = "version-2";

export const VALID_EVIDENCE: Evidence = {
  repo_sha: REPO_SHA,
  path: "README.md",
  excerpt: "supports TypeScript out of the box",
};

/**
 * Builds a claim for a given (kind, verdict) pair, filled in with values
 * that satisfy assertRenderable's requirements for that verdict so the
 * table test in gate.test.ts isolates the kind/verdict interaction only.
 */
export function makeClaim(
  kind: ClaimKind,
  verdict: ClaimVerdict,
  overrides: Partial<Claim> = {},
): Claim {
  const base: Claim = {
    id: `claim-${kind}-${verdict}`,
    section: "hero",
    locale: "en",
    text: "some claim text",
    kind,
    evidence: [],
    verdict,
    checked_sha: REPO_SHA,
    checked_at: "2026-09-17T00:00:00Z",
    verifier_run_id: "run-1",
  };

  if (verdict === "VERIFIED") {
    base.evidence = [VALID_EVIDENCE];
    base.checked_sha = REPO_SHA;
  }

  if (verdict === "ATTESTED") {
    base.attestation = {
      user_id: "user-1",
      at: "2026-09-17T00:00:00Z",
      version_id: VERSION_ID,
    };
  }

  return { ...base, ...overrides };
}

/** The id of the auto-injected default site-name claim (see makeSiteContent). */
export const SITE_NAME_CLAIM_ID = "site-name";

function defaultSiteNameClaim(): Claim {
  return makeClaim("feature", "VERIFIED", { id: SITE_NAME_CLAIM_ID, text: "Example" });
}

/**
 * `siteNameClaimId` is required (round 3, item 3): the displayed site name
 * must be a verified claim. To keep the ~90 existing tests that don't care
 * about the site name from tripping a stray claim-missing/duplicate-id,
 * this always makes sure the referenced siteNameClaimId resolves — unless
 * the caller deliberately points it at an id that isn't in `claims`, which
 * is exactly how a test exercises the site-name gate on purpose.
 */
export function makeSiteContent(overrides: Partial<SiteContent> = {}): SiteContent {
  const siteNameClaimId = overrides.siteNameClaimId ?? SITE_NAME_CLAIM_ID;
  const callerClaims = overrides.claims ?? [];
  const claims = callerClaims.some((c) => c.id === siteNameClaimId)
    ? callerClaims
    : [defaultSiteNameClaim(), ...callerClaims];

  return {
    site: "example",
    repo: "owner/example",
    repo_sha: REPO_SHA,
    domains: ["example.com"],
    pages: [],
    ...overrides,
    siteNameClaimId,
    claims,
  };
}

/** A minimal, schema-valid "hero" section. `props` overrides/extends the default. */
export function heroSection(props: Record<string, unknown> = {}): Section {
  return {
    type: "hero",
    props: { titleChrome: "section.hero.title", ...props },
  } as Section;
}

/** A minimal, schema-valid "feature-grid" section referencing the given claim ids. */
export function featureGridSection(featureClaimIds: string[], props: Record<string, unknown> = {}): Section {
  return {
    type: "feature-grid",
    props: { titleChrome: "section.features.title", featureClaimIds, ...props },
  } as Section;
}

export function page(slug: string, sections: Section[]): Page {
  return { slug, sections };
}
