import type { Claim, SiteContent } from "@fx/sitekit-claims";
import { escapeHtml } from "./html.js";

/** Avoids depending on a separately-exported `Evidence` type name — this
 * package only ever needs "one element of a claim's evidence array". */
type EvidenceEntry = Claim["evidence"][number];

export class MissingClaimError extends Error {
  constructor(claimId: string) {
    super(`claim "${claimId}" is not present in content.claims`);
    this.name = "MissingClaimError";
  }
}

/**
 * Looks a claim id up in content.claims. gateSite has already refused to
 * render if any referenced id were missing (D#2606 K01's "claim-missing"
 * blocker) — this throws only if a caller reached a renderer without going
 * through render.ts's gate-first path.
 */
export function resolveClaim(content: SiteContent, claimId: string): Claim {
  const claim = content.claims.find((c) => c.id === claimId);
  if (!claim) {
    throw new MissingClaimError(claimId);
  }
  return claim;
}

/**
 * The visible evidence link every rendered claim carries (D#2606 K03):
 * `https://github.com/<owner>/<repo>/blob/<sha>/<path>#L<a>-L<b>`. Falls
 * back to a line-less blob link when the evidence has no `lines` (e.g. a
 * figure claim's evidence, which K01 requires a `query` for instead), and
 * to `null` only when the claim carries no evidence at all — which K01's
 * schema permits for an ATTESTED claim (the attestation path never
 * requires evidence.length >= 1).
 */
export function evidenceUrl(repo: string, sha: string, evidence: EvidenceEntry | undefined): string | null {
  if (!evidence) {
    return null;
  }
  const base = `https://github.com/${repo}/blob/${sha}/${evidence.path}`;
  if (evidence.lines) {
    return `${base}#L${evidence.lines.start}-L${evidence.lines.end}`;
  }
  return base;
}

/**
 * Renders one claim as an inline span carrying `data-claim-id` and, when
 * evidence exists, a visible link to it — the traceability the product
 * sells (D#2606 Intent: "every rendered claim links to repo@sha:path#lines").
 * `render.ts` calls `gateSite` before any of this runs, so by the time a
 * renderer reaches a claim id here, it is already known renderable; this
 * function only formats what is safe to show.
 */
export function renderClaimText(content: SiteContent, claimId: string): string {
  const claim = resolveClaim(content, claimId);
  const url = evidenceUrl(content.repo, claim.checked_sha, claim.evidence[0]);
  const text = escapeHtml(claim.text);
  const idAttr = escapeHtml(claim.id);
  if (!url) {
    return `<span data-claim-id="${idAttr}">${text}</span>`;
  }
  return `<span data-claim-id="${idAttr}">${text} <a class="evidence" href="${escapeHtml(url)}">[source]</a></span>`;
}

/** Plain (unescaped) text of a claim — for places like <title> that need
 * text, not markup (the caller escapes it for its own context). */
export function claimText(content: SiteContent, claimId: string): string {
  return resolveClaim(content, claimId).text;
}

/**
 * The site's displayed name (D#2606 K03 constraint): always the resolved
 * `siteNameClaimId` claim's text, never `SiteContent.site` (an internal
 * slug that must never be displayed).
 */
export function siteDisplayName(content: SiteContent): string {
  return claimText(content, content.siteNameClaimId);
}

/** Same name, rendered as a claim (data-claim-id + evidence link) for use
 * in the page header, where the name is a "rendered claim" like any other. */
export function siteDisplayNameHtml(content: SiteContent): string {
  return renderClaimText(content, content.siteNameClaimId);
}
