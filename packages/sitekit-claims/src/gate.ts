import {
  ATTESTABLE_KINDS,
  CLAIM_REF_FIELDS,
  isRepoUrlHostAllowed,
  isSlug,
  PAGE_SLUG_MAX_LEN,
  parseRepoUrlShape,
  SECTION_PROPS_SCHEMA,
  SectionType,
  SITE_SLUG_MAX_LEN,
  URL_FIELDS,
  type Claim,
  type SiteContent,
} from "./schema.js";
import type { ZodIssue } from "zod";

export interface RenderContext {
  /** The site's current repo_sha (SiteContent.repo_sha). */
  repoSha: string;
  /** The site_versions id currently being rendered, if any (needed for ATTESTED claims). */
  versionId?: string;
}

/**
 * A claim is renderable only when it has been machine-verified against the
 * exact sha being rendered, or — for legal/pricing/security claims only —
 * a human has attested it for the current version.
 */
export function assertRenderable(claim: Claim, context: RenderContext): boolean {
  if (
    claim.verdict === "VERIFIED" &&
    claim.evidence.length >= 1 &&
    claim.checked_sha === context.repoSha
  ) {
    return true;
  }

  if (
    ATTESTABLE_KINDS.includes(claim.kind) &&
    claim.verdict === "ATTESTED" &&
    claim.attestation !== undefined &&
    context.versionId !== undefined &&
    claim.attestation.version_id === context.versionId
  ) {
    return true;
  }

  return false;
}

export type BlockReason =
  | "claim-not-renderable"
  | "claim-missing"
  | "figure-missing-query"
  | "duplicate-claim-id"
  | "unknown-section-type"
  | "unknown-section-field"
  | "unknown-page-field"
  | "unknown-document-field"
  | "invalid-section"
  | "invalid-page"
  | "invalid-document"
  | "unknown-prop"
  | "missing-prop"
  | "invalid-prop-value"
  | "free-text-prop"
  | "invalid-site-slug"
  | "invalid-page-slug";

export interface Blocker {
  reason: BlockReason;
  claimId?: string;
  page?: string;
  section?: string;
  detail: string;
}

const SECTION_OBJECT_KEYS = new Set(["type", "props"]);
const PAGE_OBJECT_KEYS = new Set(["slug", "sections"]);
const DOCUMENT_OBJECT_KEYS = new Set([
  "site",
  "siteNameClaimId",
  "repo",
  "repo_sha",
  "domains",
  "pages",
  "claims",
]);

/**
 * True for a plain, non-null object — including arrays, deliberately: an
 * array in a section/page/document slot is still something Object.keys and
 * property access work on without throwing, so it "already behaves" (it'll
 * fail type/shape checks downstream and get reported normally). What must
 * NOT reach a bare `Object.keys(...)` or `.foo` access below is null,
 * undefined, or a primitive — those throw or silently read as undefined in
 * ways that surface as a crash rather than a blocker (round 4, item 3).
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function describeType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}
/** Chrome fields are the only place an enum failure means "you put a
 * literal label/sentence where a dictionary key belongs" — every other
 * enum field (e.g. hero.layout) is a plain closed choice, not a chrome
 * slot, so a bad value there is just a wrong value, not smuggled prose. */
const CHROME_FIELD_SUFFIX = "Chrome";

/**
 * Maps one zod issue from a section's props validation to the accurate
 * BlockReason for it (round 3, item 6) — `unrecognized_keys` is handled by
 * the caller (one blocker per key), everything else lands here:
 *   - a required field simply absent -> missing-prop
 *   - a chrome-* field holding something outside ALLOWED_UI_CHROME, or a
 *     RepoUrl-shaped field holding something that isn't URL/path-shaped at
 *     all (params.reason "not-url-like") -> free-text-prop: both are the
 *     signature of prose smuggled into a field that isn't supposed to hold
 *     any (a literal chrome label, or a marketing sentence disguised as a
 *     slug/URL)
 *   - anything else (wrong element type in a claim-id array, a malformed
 *     anchor/asset path, a well-formed-but-policy-violating URL, a bad
 *     non-chrome enum choice) -> invalid-prop-value: a real value was
 *     supplied, it's just the wrong one
 */
function classifyPropsIssue(issue: ZodIssue): Exclude<BlockReason, "unknown-prop"> {
  if (issue.code === "invalid_type" && issue.received === "undefined") {
    return "missing-prop";
  }

  const lastSegment = issue.path[issue.path.length - 1];
  const isChromeField = typeof lastSegment === "string" && lastSegment.endsWith(CHROME_FIELD_SUFFIX);
  if (isChromeField && issue.code === "invalid_enum_value") {
    return "free-text-prop";
  }

  if (issue.code === "custom") {
    const reason = (issue.params as { reason?: string } | undefined)?.reason;
    if (reason === "not-url-like") {
      return "free-text-prop";
    }
    return "invalid-prop-value";
  }

  return "invalid-prop-value";
}

/**
 * Reads out every claim id embedded in a (schema-valid) section's props,
 * using the type's declared claim-ref fields (CLAIM_REF_FIELDS) rather than
 * scanning string values — the field list, not the string shape, is what
 * says "this is a claim reference".
 */
function extractClaimRefs(type: SectionType, props: Record<string, unknown>): string[] {
  const fields = CLAIM_REF_FIELDS[type] ?? [];
  const ids: string[] = [];
  for (const field of fields) {
    const value = props[field];
    if (typeof value === "string") {
      ids.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") {
          ids.push(item);
        }
      }
    }
  }
  return ids;
}

/**
 * Checks every claim; the site's own slug and displayed-name claim; every
 * page's slug; every section's exact field set, type, props, and the claim
 * references and URLs embedded in those props; and every figure claim's
 * evidence. Returns the full list of blockers — it never stops at the
 * first one, so one gate run tells you everything that has to be fixed
 * before a site can render.
 *
 * Section shape is re-validated here (not just trusted from SiteContent's
 * static type) because gateSite is the defensive boundary: it has to catch
 * a structurally invalid section — a rogue field zod's discriminated union
 * would otherwise strip silently, an unknown type, an unrecognized prop
 * key, a prop that doesn't match its field's typed shape — even when the
 * caller didn't route the content through SiteContent.parse() first.
 */
export function gateSite(content: SiteContent, context: RenderContext): Blocker[] {
  const blockers: Blocker[] = [];

  // Item 3 (round 4), document level: a non-object SiteContent can't be
  // inspected at all — every field access below would throw instead of
  // reporting a blocker. Nothing else in this function can run.
  if (!isPlainRecord(content)) {
    return [
      {
        reason: "invalid-document",
        detail: `SiteContent must be an object, got ${describeType(content)}`,
      },
    ];
  }
  const rawContent = content as unknown as Record<string, unknown>;

  // Item 1 (round 4), document level: a rogue field on SiteContent itself
  // (mirrors the section-level and now page-level check below).
  for (const key of Object.keys(rawContent)) {
    if (!DOCUMENT_OBJECT_KEYS.has(key)) {
      blockers.push({
        reason: "unknown-document-field",
        detail: `SiteContent has an unrecognized field "${key}" — it may only have: ${[...DOCUMENT_OBJECT_KEYS].join(", ")}`,
      });
    }
  }

  const claimsValue = rawContent.claims;
  if (!Array.isArray(claimsValue)) {
    blockers.push({
      reason: "invalid-document",
      detail: `SiteContent.claims must be an array, got ${describeType(claimsValue)}`,
    });
  }
  const claims: Claim[] = Array.isArray(claimsValue) ? claimsValue : [];
  const claimsById = new Map(claims.map((claim) => [claim.id, claim]));

  const idCounts = new Map<string, number>();
  for (const claim of claims) {
    idCounts.set(claim.id, (idCounts.get(claim.id) ?? 0) + 1);
  }
  for (const [id, count] of idCounts) {
    if (count > 1) {
      blockers.push({
        reason: "duplicate-claim-id",
        claimId: id,
        detail: `claim id "${id}" appears ${count} times in content.claims; ids must be unique`,
      });
    }
  }

  // Item 3 (round 3): the site's own slug and its displayed-name claim.
  const siteValue = rawContent.site;
  if (typeof siteValue !== "string" || !isSlug(siteValue, SITE_SLUG_MAX_LEN)) {
    blockers.push({
      reason: "invalid-site-slug",
      detail: `SiteContent.site "${String(siteValue)}" is not a bounded kebab-case slug`,
    });
  }
  {
    const siteNameClaimId = rawContent.siteNameClaimId;
    const nameClaim = typeof siteNameClaimId === "string" ? claimsById.get(siteNameClaimId) : undefined;
    if (!nameClaim) {
      blockers.push({
        reason: "claim-missing",
        claimId: typeof siteNameClaimId === "string" ? siteNameClaimId : undefined,
        detail: `siteNameClaimId "${String(siteNameClaimId)}" is not present in content.claims — the displayed site name must be a verified claim`,
      });
    } else if (!assertRenderable(nameClaim, context)) {
      blockers.push({
        reason: "claim-not-renderable",
        claimId: nameClaim.id,
        detail: `siteNameClaimId claim "${nameClaim.id}" (kind=${nameClaim.kind}, verdict=${nameClaim.verdict}) is not renderable`,
      });
    }
  }

  const pagesValue = rawContent.pages;
  if (!Array.isArray(pagesValue)) {
    blockers.push({
      reason: "invalid-document",
      detail: `SiteContent.pages must be an array, got ${describeType(pagesValue)}`,
    });
  }
  const pages: unknown[] = Array.isArray(pagesValue) ? pagesValue : [];

  for (const page of pages) {
    // Item 3 (round 4), page level: mirrors the section-level guard — a
    // non-object page entry (null, a string, ...) can't be inspected.
    if (!isPlainRecord(page)) {
      blockers.push({
        reason: "invalid-page",
        detail: `a page entry must be an object, got ${describeType(page)}`,
      });
      continue;
    }
    const rawPage = page;
    const pageSlugValue = rawPage.slug;
    const pageSlug = typeof pageSlugValue === "string" ? pageSlugValue : undefined;

    // Item 1 (round 4), page level: a rogue field on a page (next to
    // slug/sections) — the same reasoning as the section-level check.
    for (const key of Object.keys(rawPage)) {
      if (!PAGE_OBJECT_KEYS.has(key)) {
        blockers.push({
          reason: "unknown-page-field",
          page: pageSlug,
          detail: `${pageSlug ?? String(pageSlugValue)} has an unrecognized field "${key}" — pages may only have "slug" and "sections"`,
        });
      }
    }

    // Item 3 (round 3): page slug.
    if (typeof pageSlugValue !== "string" || !isSlug(pageSlugValue, PAGE_SLUG_MAX_LEN)) {
      blockers.push({
        reason: "invalid-page-slug",
        page: pageSlug,
        detail: `page slug "${String(pageSlugValue)}" is not a bounded kebab-case slug`,
      });
    }

    const sectionsValue = rawPage.sections;
    if (!Array.isArray(sectionsValue)) {
      blockers.push({
        reason: "invalid-page",
        page: pageSlug,
        detail: `${pageSlug ?? String(pageSlugValue)}.sections must be an array, got ${describeType(sectionsValue)}`,
      });
    }
    const sections: unknown[] = Array.isArray(sectionsValue) ? sectionsValue : [];

    for (const section of sections) {
      // Item 3 (round 4), section level: the reported repro — a null (or
      // other non-object) section threw a TypeError out of Object.keys()
      // instead of being reported as a blocker.
      if (!isPlainRecord(section)) {
        blockers.push({
          reason: "invalid-section",
          page: pageSlug,
          detail: `a section entry on ${pageSlug ?? String(pageSlugValue)} must be an object, got ${describeType(section)}`,
        });
        continue;
      }
      const rawSection = section;

      // Item 2 (round 3): the section object itself may only ever have
      // "type" and "props" — a rogue field here (e.g. rawHtml) would
      // otherwise be invisible to every check below, which only ever look
      // at type/props.
      for (const key of Object.keys(rawSection)) {
        if (!SECTION_OBJECT_KEYS.has(key)) {
          blockers.push({
            reason: "unknown-section-field",
            page: pageSlug,
            detail: `${pageSlug ?? String(pageSlugValue)} has a section with an unrecognized field "${key}" — sections may only have "type" and "props"`,
          });
        }
      }

      const typeCheck = SectionType.safeParse(rawSection.type);
      if (!typeCheck.success) {
        blockers.push({
          reason: "unknown-section-type",
          page: pageSlug,
          section: String(rawSection.type),
          detail: `${pageSlug ?? String(pageSlugValue)} uses section type "${String(rawSection.type)}", which is outside the fixed v1 set`,
        });
        continue;
      }

      const type = typeCheck.data;
      const propsSchema = SECTION_PROPS_SCHEMA[type];
      const propsCheck = propsSchema.safeParse(rawSection.props);

      if (!propsCheck.success) {
        for (const issue of propsCheck.error.issues) {
          if (issue.code === "unrecognized_keys") {
            for (const key of issue.keys) {
              blockers.push({
                reason: "unknown-prop",
                page: pageSlug,
                section: type,
                detail: `${pageSlug ?? String(pageSlugValue)}/${type} has an unrecognized prop "${key}" — every prop must be typed for this section; facts must enter as claims`,
              });
            }
          } else {
            const path = issue.path.join(".") || "(root)";
            blockers.push({
              reason: classifyPropsIssue(issue),
              page: pageSlug,
              section: type,
              detail: `${pageSlug ?? String(pageSlugValue)}/${type} prop "${path}": ${issue.message}`,
            });
          }
        }
        continue;
      }

      const props = propsCheck.data as Record<string, unknown>;

      // Item 1 (round 3): host-allowlist membership for any URL-typed prop.
      // Shape is already guaranteed by propsCheck above; this is the part
      // that needs the whole SiteContent (domains, repo), so it can't live
      // in the static per-type props schema.
      for (const field of URL_FIELDS[type] ?? []) {
        const value = props[field];
        if (typeof value !== "string") {
          continue;
        }
        const parsed = parseRepoUrlShape(value);
        if (parsed.ok && !isRepoUrlHostAllowed(parsed, Array.isArray(rawContent.domains) ? rawContent.domains : [], typeof rawContent.repo === "string" ? rawContent.repo : "")) {
          blockers.push({
            reason: "invalid-prop-value",
            page: pageSlug,
            section: type,
            detail: `${pageSlug ?? String(pageSlugValue)}/${type} prop "${field}": host "${parsed.host}" is not one of this site's declared domains`,
          });
        }
      }

      const claimIds = extractClaimRefs(type, props);
      for (const claimId of claimIds) {
        const claim = claimsById.get(claimId);
        if (!claim) {
          blockers.push({
            reason: "claim-missing",
            claimId,
            page: pageSlug,
            section: type,
            detail: `"${claimId}" is referenced by ${pageSlug ?? String(pageSlugValue)}/${type} but is not present in content.claims — make it a claim (with evidence), not a literal string`,
          });
          continue;
        }
        if (!assertRenderable(claim, context)) {
          blockers.push({
            reason: "claim-not-renderable",
            claimId,
            page: pageSlug,
            section: type,
            detail: `claim "${claimId}" (kind=${claim.kind}, verdict=${claim.verdict}) is not renderable`,
          });
        }
      }
    }
  }

  for (const claim of claims) {
    if (claim.kind !== "figure") {
      continue;
    }
    const missingQuery = claim.evidence.length === 0 || claim.evidence.some((e) => !e.query);
    if (missingQuery) {
      blockers.push({
        reason: "figure-missing-query",
        claimId: claim.id,
        detail: `figure claim "${claim.id}" has evidence without a query`,
      });
    }
  }

  return blockers;
}
