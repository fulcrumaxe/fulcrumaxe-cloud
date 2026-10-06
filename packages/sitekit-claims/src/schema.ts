import { z } from "zod";

/**
 * Claim schema for site kit (D#2606 K01).
 *
 * This module is pure: it does not read files, make network calls, or call
 * a model. It only defines shapes and validates values already in memory.
 */

export const ClaimKind = z.enum([
  "feature",
  "figure",
  "status",
  "pricing",
  "legal",
  "security",
]);
export type ClaimKind = z.infer<typeof ClaimKind>;

export const ClaimVerdict = z.enum([
  "VERIFIED",
  "FALSE",
  "UNVERIFIABLE",
  "CONFLICT",
  "PENDING",
  "ATTESTED",
]);
export type ClaimVerdict = z.infer<typeof ClaimVerdict>;

/** Kinds that may reach VERIFIED-equivalent render eligibility via human attestation
 * instead of an automated verifier run. */
export const ATTESTABLE_KINDS: readonly ClaimKind[] = ["legal", "pricing", "security"];

export const LineRange = z.object({
  start: z.number().int().positive(),
  end: z.number().int().positive(),
});
export type LineRange = z.infer<typeof LineRange>;

export const Evidence = z.object({
  repo_sha: z.string().min(1),
  path: z.string().min(1),
  lines: LineRange.optional(),
  query: z.string().min(1).optional(),
  excerpt: z.string().min(1),
});
export type Evidence = z.infer<typeof Evidence>;

export const Attestation = z.object({
  user_id: z.string().min(1),
  at: z.string().min(1),
  version_id: z.string().min(1),
});
export type Attestation = z.infer<typeof Attestation>;

export const Claim = z.object({
  id: z.string().min(1),
  section: z.string().min(1),
  locale: z.string().min(1),
  text: z.string().min(1),
  kind: ClaimKind,
  evidence: z.array(Evidence),
  verdict: ClaimVerdict,
  checked_sha: z.string().min(1),
  checked_at: z.string().min(1),
  verifier_run_id: z.string().min(1),
  attestation: Attestation.optional(),
});
export type Claim = z.infer<typeof Claim>;

/**
 * Section props, typed (D#2606 K01 fix round 2, tightened round 3).
 *
 * The original design let a section carry `props: Record<string, unknown>`
 * and tried to catch smuggled prose with a length heuristic on string
 * values. That heuristic was fundamentally unwinnable: container-type
 * guessing can never tell a prose fragment from a short label.
 *
 * So there is no length rule, and no free-text string prop at all. Every
 * section type has its own closed props schema. A string prop may only be:
 *   (a) a claim reference — a claim id, gated exactly like any other claim
 *       reference (assertRenderable, claim-missing/claim-not-renderable);
 *   (b) a fixed UI-chrome dictionary key (ALLOWED_UI_CHROME) for a generic,
 *       non-product-specific label — the template maps the key to localized
 *       copy, so the key itself carries no prose;
 *   (c) a narrowly typed technical value: a repo-relative/allowed-domain
 *       https URL, an image asset path, an anchor slug, or a closed enum.
 * Facts (feature names, tag labels, FAQ questions, plan names, headlines,
 * ...) are not prop values at all — they are claims, referenced by id.
 */

/**
 * Fixed set of UI chrome dictionary keys. These are keys, not literal
 * copy — the site template (K03) maps each one to a localized string. This
 * package only ever sees and validates the key. Chrome is for boilerplate
 * section labels ("Features", "Get started") that are the same shape for
 * any site — never for a product-specific headline, which needs a claim
 * (see headlineClaimId below).
 */
export const ALLOWED_UI_CHROME = [
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
] as const;
export type ChromeKey = (typeof ALLOWED_UI_CHROME)[number];
export const ChromeKeySchema = z.enum(ALLOWED_UI_CHROME);

/** A claim reference: validated here for shape only (a non-empty id).
 * Whether it resolves to a real, renderable claim is gateSite's job. */
const ClaimIdField = z.string().min(1);

/** Lowercase kebab-case slug shape, shared by site ids, page slugs,
 * anchors, and URL path/fragment segments — one pattern, several bounded
 * lengths depending on where it's used. */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isSlug(value: string, maxLen: number): boolean {
  return value.length > 0 && value.length <= maxLen && SLUG_RE.test(value);
}

function slugSchema(maxLen: number, label: string) {
  return z.string().refine((value) => isSlug(value, maxLen), {
    message: `must be a lowercase kebab-case ${label} (letters, digits, single dashes, max ${maxLen} chars)`,
  });
}

export const SITE_SLUG_MAX_LEN = 40;
export const PAGE_SLUG_MAX_LEN = 60;
export const ANCHOR_MAX_LEN = 40;
const URL_SEGMENT_MAX_LEN = 40;
const URL_MAX_SEGMENTS = 6;
const URL_MAX_LEN = 200;

/** Item 5: AnchorSlug now has a max length, using the shared slug helper. */
const AnchorSlug = slugSchema(ANCHOR_MAX_LEN, "anchor slug");

/**
 * Item 7 (round 3): an image asset path, used where hero needs a
 * background image. Tightened in round 4: the original character class
 * (`[\w./-]`) included a literal dot, so `/images/../../../etc/passwd.png`
 * passed — K03's build step is likely to join this against an asset
 * directory, which makes an accepted traversal an arbitrary-file-read at
 * generation time, not just a broken image link.
 *
 * Fix: every directory segment and the filename stem must be a plain slug
 * (the same alphabet as everywhere else in this package — lowercase
 * letters, digits, single dashes). That alphabet has no dot in it at all,
 * so `..`, `.`, and any percent-encoded variant (`%2e%2e` contains `%`,
 * which isn't in the alphabet either) are rejected the same way a random
 * non-slug segment would be — there's no separate "reject dot-segments"
 * rule to get right or wrong. The filename must be exactly
 * `<slug>.<extension>` — more than one dot (a double extension, e.g.
 * `shell.php.png`) is rejected outright.
 *
 * Extension allowlist is png/jpg/jpeg/webp — deliberately NOT svg. SVG can
 * carry `<script>` and event-handler attributes, and this package can't
 * know whether K03 ends up only ever referencing the path via `<img src>`
 * (where a browser won't execute embedded script) or inlining the file's
 * markup into the page (where it will). Until that's a settled, sanitized
 * path in K03, treating "SVG" and "safe image path" as the same type here
 * would be a guess this package isn't in a position to make.
 */
export const ASSET_ALLOWED_EXTENSIONS = ["png", "jpg", "jpeg", "webp"] as const;
export const ASSET_PATH_MAX_LEN = 200;
const ASSET_SEGMENT_MAX_LEN = 40;

export function isAssetPath(value: string): boolean {
  if (value.length === 0 || value.length > ASSET_PATH_MAX_LEN || !value.startsWith("/")) {
    return false;
  }

  const segments = value.slice(1).split("/");
  const fileSegment = segments[segments.length - 1];
  const dirSegments = segments.slice(0, -1);

  for (const segment of dirSegments) {
    if (!isSlug(segment, ASSET_SEGMENT_MAX_LEN)) {
      return false;
    }
  }

  if (fileSegment === undefined) return false; // split() always yields one element; narrows the type
  const fileParts = fileSegment.split(".");
  if (fileParts.length !== 2) {
    // Zero dots (no extension) or two-or-more (a double extension like
    // shell.php.png, or a dot-segment sitting in the filename slot) are
    // both rejected the same way.
    return false;
  }
  const [name, extension] = fileParts;
  if (name === undefined || extension === undefined) return false; // length is 2 here; narrows the type
  if (!isSlug(name, ASSET_SEGMENT_MAX_LEN)) {
    return false;
  }
  return (ASSET_ALLOWED_EXTENSIONS as readonly string[]).includes(extension.toLowerCase());
}

const AssetPath = z.string().refine(isAssetPath, {
  message: `must be a root-relative path with slug-only segments and an extension in: ${ASSET_ALLOWED_EXTENSIONS.join(", ")}`,
});

/**
 * Shape-only result of parsing a "technical URL" value (round 3, item 1).
 * Two distinct failure reasons, because they get reported differently:
 *   - "not-url-like": doesn't look like a URL/path at all, or a path/
 *     fragment segment fails the slug shape or length cap — this is what a
 *     free-text string (a marketing sentence, or one dash-encoded to look
 *     slug-ish) collapses to, so gate.ts reports it as free-text-prop.
 *   - "policy": a *well-formed* URL that violates a specific technical rule
 *     (non-https, userinfo, port, a query string) — reported as
 *     invalid-prop-value, since the value isn't textual, just disallowed.
 * Host-allowlist membership is deliberately NOT decided here: an absolute
 * URL's host can only be judged against a specific SiteContent's declared
 * domains, which this shape-only, field-level parser doesn't have. That
 * check lives in isRepoUrlHostAllowed, run by SiteContent's superRefine and
 * by gateSite, both of which have the whole document in scope.
 */
export type RepoUrlShape =
  | { ok: true; host: string | null; segments: string[]; fragment: string | null }
  | { ok: false; reason: "not-url-like" | "policy"; message: string };

function checkSegments(pathPart: string): string[] | null {
  const segments = pathPart.length === 0 ? [] : pathPart.split("/");
  if (segments.length > URL_MAX_SEGMENTS) {
    return null;
  }
  for (const segment of segments) {
    if (!isSlug(segment, URL_SEGMENT_MAX_LEN)) {
      return null;
    }
  }
  return segments;
}

export function parseRepoUrlShape(value: string): RepoUrlShape {
  if (value.length === 0 || value.length > URL_MAX_LEN || /\s/.test(value)) {
    return { ok: false, reason: "not-url-like", message: "must be a URL or root-relative path, no whitespace" };
  }

  let pathAndFragment: string;
  let host: string | null = null;

  if (value.startsWith("/")) {
    pathAndFragment = value.slice(1);
  } else if (/^https?:\/\//i.test(value)) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return { ok: false, reason: "not-url-like", message: "not a parseable URL" };
    }
    if (parsed.protocol !== "https:") {
      return { ok: false, reason: "policy", message: "must be https, not " + parsed.protocol };
    }
    if (parsed.username || parsed.password) {
      return { ok: false, reason: "policy", message: "must not include userinfo (user:pass@)" };
    }
    if (parsed.port) {
      return { ok: false, reason: "policy", message: "must not include an explicit port" };
    }
    if (parsed.search) {
      return { ok: false, reason: "policy", message: "must not include a query string" };
    }
    host = parsed.hostname;
    pathAndFragment = parsed.pathname.replace(/^\//, "") + parsed.hash;
  } else {
    return { ok: false, reason: "not-url-like", message: "must start with / or https://" };
  }

  const hashParts = pathAndFragment.split("#");
  if (hashParts.length > 2) {
    return { ok: false, reason: "not-url-like", message: "at most one #anchor-slug fragment is allowed" };
  }
  const [pathPart, fragmentPart] = hashParts;
  if (pathPart === undefined) return { ok: false, reason: "not-url-like", message: "empty path" }; // split() always yields one element; narrows the type

  if (pathPart.includes("?")) {
    return { ok: false, reason: "policy", message: "must not include a query string" };
  }

  const segments = checkSegments(pathPart);
  if (segments === null) {
    return {
      ok: false,
      reason: "not-url-like",
      message: `path segments must be short lowercase kebab-case slugs (max ${URL_SEGMENT_MAX_LEN} chars each, max ${URL_MAX_SEGMENTS} segments)`,
    };
  }

  let fragment: string | null = null;
  if (fragmentPart !== undefined && fragmentPart.length > 0) {
    if (!isSlug(fragmentPart, URL_SEGMENT_MAX_LEN)) {
      return {
        ok: false,
        reason: "not-url-like",
        message: `fragment must be a short lowercase kebab-case slug (max ${URL_SEGMENT_MAX_LEN} chars)`,
      };
    }
    fragment = fragmentPart;
  }

  return { ok: true, host, segments, fragment };
}

/**
 * Given a shape-valid parse, decide whether an absolute URL's host is
 * allowed for this site: one of its declared `domains`, or github.com but
 * only under this repo's own /<owner>/<repo> path. Root-relative values
 * (host === null) are always allowed — they can only point within the site
 * being rendered.
 */
export function isRepoUrlHostAllowed(
  parsed: { host: string | null; segments: readonly string[] },
  domains: readonly string[],
  repo: string,
): boolean {
  if (parsed.host === null) {
    return true;
  }
  if (parsed.host === "github.com") {
    const [owner, name] = repo.split("/");
    if (owner && name && parsed.segments[0] === owner && parsed.segments[1] === name) {
      return true;
    }
  }
  return domains.includes(parsed.host);
}

/** A technical link target — see parseRepoUrlShape for the shape rules.
 * Host-allowlist membership is checked separately (SiteContent-level and
 * gateSite), since it needs the whole document, not just this field. */
const RepoUrl = z.string().superRefine((value, ctx) => {
  const result = parseRepoUrlShape(value);
  if (!result.ok) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.message, params: { reason: result.reason } });
  }
});

export const SectionType = z.enum([
  "hero",
  "feature-grid",
  "roadmap-list",
  "changelog",
  "docs-index",
  "pricing-table",
  "legal-page",
  "faq",
]);
export type SectionType = z.infer<typeof SectionType>;

const HeroProps = z
  .object({
    titleChrome: ChromeKeySchema,
    subtitleChrome: ChromeKeySchema.optional(),
    ctaChrome: ChromeKeySchema.optional(),
    ctaHref: RepoUrl.optional(),
    backgroundImage: AssetPath.optional(),
    layout: z.enum(["centered", "split"]).optional(),
    statusClaimId: ClaimIdField.optional(),
    /** Item 4: a hero needs a product-specific headline, which a fixed
     * chrome key can never carry — so it's a claim, gated like any other. */
    headlineClaimId: ClaimIdField.optional(),
    subheadlineClaimId: ClaimIdField.optional(),
  })
  .strict();

const FeatureGridProps = z
  .object({
    titleChrome: ChromeKeySchema,
    featureClaimIds: z.array(ClaimIdField).min(1),
  })
  .strict();

const RoadmapListProps = z
  .object({
    titleChrome: ChromeKeySchema,
    itemClaimIds: z.array(ClaimIdField).min(1),
  })
  .strict();

const ChangelogProps = z
  .object({
    titleChrome: ChromeKeySchema,
    entryClaimIds: z.array(ClaimIdField).min(1),
  })
  .strict();

const DocsIndexProps = z
  .object({
    titleChrome: ChromeKeySchema,
    docClaimIds: z.array(ClaimIdField).min(1),
    anchor: AnchorSlug.optional(),
  })
  .strict();

const PricingTableProps = z
  .object({
    titleChrome: ChromeKeySchema,
    /** Round 4, item 4: a pricing section commonly carries a short,
     * product-specific lead line (e.g. "free for open source, $9/mo for
     * teams") above the plan list. That's exactly the kind of statement the
     * Spec requires customer attestation for (pricing is an ATTESTABLE_KINDS
     * claim kind) — a chrome key can't hold it, mirroring hero's
     * headlineClaimId. */
    leadClaimId: ClaimIdField.optional(),
    planClaimIds: z.array(ClaimIdField).min(1),
  })
  .strict();

/**
 * Round 4, item 4 re-check: legal-page does NOT get a leadClaimId. Unlike a
 * hero headline or a pricing lead line, legal text has no standalone
 * "statement above the substance" — bodyClaimIds already IS the substance
 * (each paragraph is a claim), and titleChrome ("Privacy Policy", "Terms of
 * Service") is boilerplate that doesn't need to be product-specific the way
 * a lead line does. Nothing to add here.
 */
const LegalPageProps = z
  .object({
    titleChrome: ChromeKeySchema,
    bodyClaimIds: z.array(ClaimIdField).min(1),
    anchor: AnchorSlug.optional(),
  })
  .strict();

const FaqProps = z
  .object({
    titleChrome: ChromeKeySchema,
    qnaClaimIds: z.array(ClaimIdField).min(1),
  })
  .strict();

/**
 * Item 4 audit (round 3, revisited round 4): hero and pricing-table are the
 * two of the 8 v1 types with a standalone, product-specific "lead
 * statement" gap a chrome key can't hold (headlineClaimId/
 * subheadlineClaimId on hero; leadClaimId on pricing-table — pricing copy
 * is explicitly one of the ATTESTABLE_KINDS, so it needs the same
 * claim-gated path). The other six (feature-grid, roadmap-list, changelog,
 * docs-index, legal-page, faq) carry their factual content entirely through
 * a claim-id list already, and their titleChrome is a boilerplate section
 * label ("Features", "FAQ") that's the same shape on any site.
 */
export const SECTION_PROPS_SCHEMA = {
  hero: HeroProps,
  "feature-grid": FeatureGridProps,
  "roadmap-list": RoadmapListProps,
  changelog: ChangelogProps,
  "docs-index": DocsIndexProps,
  "pricing-table": PricingTableProps,
  "legal-page": LegalPageProps,
  faq: FaqProps,
} satisfies Record<SectionType, z.ZodTypeAny>;

/**
 * Which props fields on each section type hold claim references, and
 * whether the field is a single id or an array of ids. gateSite reads this
 * to find every claim a section depends on, instead of re-guessing shapes
 * from string content.
 */
export const CLAIM_REF_FIELDS: Record<SectionType, readonly string[]> = {
  hero: ["statusClaimId", "headlineClaimId", "subheadlineClaimId"],
  "feature-grid": ["featureClaimIds"],
  "roadmap-list": ["itemClaimIds"],
  changelog: ["entryClaimIds"],
  "docs-index": ["docClaimIds"],
  "pricing-table": ["leadClaimId", "planClaimIds"],
  "legal-page": ["bodyClaimIds"],
  faq: ["qnaClaimIds"],
};

/** Which props fields on each section type hold a technical URL, checked
 * for host-allowlist membership (see isRepoUrlHostAllowed) by both
 * SiteContent's superRefine and gateSite. */
export const URL_FIELDS: Record<SectionType, readonly string[]> = {
  hero: ["ctaHref"],
  "feature-grid": [],
  "roadmap-list": [],
  changelog: [],
  "docs-index": [],
  "pricing-table": [],
  "legal-page": [],
  faq: [],
};

function sectionVariant<T extends SectionType>(type: T, props: (typeof SECTION_PROPS_SCHEMA)[T]) {
  // Item 2: strict on the OUTER object too — a section may only ever have
  // `type` and `props`. Without .strict() here, zod's discriminatedUnion
  // silently drops any extra key (e.g. a smuggled `rawHtml` field) instead
  // of rejecting it, which is worse than not checking at all: the content
  // looks clean after SiteContent.parse() even though a field the schema
  // never saw is still sitting on the object gateSite/the template read
  // directly off `section` (not off the parsed-and-stripped result).
  return z.object({ type: z.literal(type), props }).strict();
}

export const Section = z.discriminatedUnion("type", [
  sectionVariant("hero", HeroProps),
  sectionVariant("feature-grid", FeatureGridProps),
  sectionVariant("roadmap-list", RoadmapListProps),
  sectionVariant("changelog", ChangelogProps),
  sectionVariant("docs-index", DocsIndexProps),
  sectionVariant("pricing-table", PricingTableProps),
  sectionVariant("legal-page", LegalPageProps),
  sectionVariant("faq", FaqProps),
]);
export type Section = z.infer<typeof Section>;

export const Page = z
  .object({
    /** Item 3 (round 3): a bounded kebab-case slug, not an unrestricted string. */
    slug: slugSchema(PAGE_SLUG_MAX_LEN, "page slug"),
    sections: z.array(Section),
  })
  // Item 1 (round 4): strict for the same reason Section is — a rogue field
  // next to slug/sections would otherwise be silently dropped by zod
  // instead of rejected, and be invisible to gateSite's defensive check too
  // if content skipped .parse(). See gate.ts's PAGE_OBJECT_KEYS check.
  .strict();
export type Page = z.infer<typeof Page>;

/**
 * Walks every section's URL_FIELDS values and reports a custom zod issue
 * for any absolute URL whose host isn't allowed for this site. Shared
 * between SiteContent's own superRefine (parse-time) and gateSite's
 * defensive re-check (gate.ts), which is why it takes ctx as a plain
 * callback rather than being written twice.
 */
function checkUrlHosts(content: { repo: string; domains: readonly string[]; pages: readonly Page[] }, ctx: z.RefinementCtx): void {
  content.pages.forEach((page, pageIndex) => {
    page.sections.forEach((section, sectionIndex) => {
      const fields = URL_FIELDS[section.type] ?? [];
      for (const field of fields) {
        const value = (section.props as Record<string, unknown>)[field];
        if (typeof value !== "string") {
          continue;
        }
        const parsed = parseRepoUrlShape(value);
        if (parsed.ok && !isRepoUrlHostAllowed(parsed, content.domains, content.repo)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["pages", pageIndex, "sections", sectionIndex, "props", field],
            message: `host "${parsed.host}" is not one of this site's declared domains`,
            params: { reason: "disallowed-host" },
          });
        }
      }
    });
  });
}

export const SiteContent = z
  .object({
    /** Short internal slug identifier — never rendered as the product name.
     * See siteNameClaimId for the displayed name. */
    site: slugSchema(SITE_SLUG_MAX_LEN, "site slug"),
    /** The claim carrying the product's displayed name (kind feature or
     * similar) — verified like any other claim, never a bare prop string,
     * since the name is rendered prominently on every generated site. */
    siteNameClaimId: ClaimIdField,
    repo: z.string().min(1),
    repo_sha: z.string().min(1),
    /** Hostnames this site is allowed to link to from any prop URL (its own
     * homepage, docs domain, ...). github.com is always implicitly allowed
     * too, but only under this repo's own /<owner>/<repo> path — see
     * isRepoUrlHostAllowed. Never hardcoded here: it's data on the document,
     * supplied by whoever builds it (K05), not by this package. */
    domains: z.array(z.string().min(1)).default([]),
    pages: z.array(Page),
    claims: z.array(Claim),
  })
  // Item 1 (round 4): strict for the same reason Section/Page are — see
  // gate.ts's DOCUMENT_OBJECT_KEYS check for the defensive-path mirror.
  .strict()
  .superRefine(checkUrlHosts);
export type SiteContent = z.infer<typeof SiteContent>;
