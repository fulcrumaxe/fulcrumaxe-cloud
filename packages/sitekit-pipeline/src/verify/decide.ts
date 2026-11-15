import { Claim, type ClaimType, type ClaimVerdictType, type EvidenceType } from "@fx/sitekit-claims";
import type { ExtractedClaim } from "../extract/index.js";
import type { VerifierResult } from "./parse.js";

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
const key = (e: Pick<EvidenceType, "path" | "excerpt">): string => `${e.path}\u0000${norm(e.excerpt)}`;

/** True when the verifier found at least one of the places the extractor cited (same file, same text apart from whitespace). */
export function evidenceMatches(extracted: readonly EvidenceType[], rederived: readonly EvidenceType[]): boolean {
  // An excerpt with no text in it is no evidence: it never matches, not even another empty one.
  const holdsText = (e: Pick<EvidenceType, "excerpt">): boolean => norm(e.excerpt).length > 0;
  const cited = new Set(extracted.filter(holdsText).map(key));
  return rederived.filter(holdsText).some((e) => cited.has(key(e)));
}

export interface DecideContext {
  sha: string;
  /** The verifier's own run id, recorded on every claim. */
  verifierRunId: string;
  checkedAt: string;
}

/**
 * Extractor claims plus the verifier's results to final claims. The rule, and the only way to VERIFIED:
 * the verifier says VERIFIED and the evidence it found itself matches evidence the extractor cited. Said VERIFIED
 * with evidence that matches nothing the extractor cited: CONFLICT. FALSE stays FALSE. UNVERIFIABLE, and a claim
 * the verifier did not answer, stay UNVERIFIABLE. A claim keeps the evidence the verifier found when VERIFIED,
 * and the extractor's own citations otherwise, so the customer sees what was cited. No path reaches
 * PENDING or ATTESTED: the first is not an outcome of a pass and the second is a person's act.
 */
export function decideClaims(extracted: readonly ExtractedClaim[], results: readonly VerifierResult[], ctx: DecideContext): ClaimType[] {
  const byId = new Map(results.map((r) => [r.id, r]));
  return extracted.map((c) => {
    const r = byId.get(c.id);
    let verdict: ClaimVerdictType = "UNVERIFIABLE";
    let evidence = c.evidence;
    if (r !== undefined) {
      if (r.verdict === "FALSE") verdict = "FALSE";
      else if (r.verdict === "VERIFIED") {
        if (evidenceMatches(c.evidence, r.evidence)) {
          verdict = "VERIFIED";
          evidence = r.evidence;
        } else verdict = "CONFLICT";
      }
    }
    return Claim.parse({ ...c, evidence, verdict, checked_sha: ctx.sha, checked_at: ctx.checkedAt, verifier_run_id: ctx.verifierRunId });
  });
}

/** One deterministic check run over the rendered site after the claims are decided (weight, links, no-JS and the rest). */
export interface MechanicalCheck {
  name: string;
  ok: boolean;
}

export type Blocker = { kind: "claim"; id: string; verdict: "FALSE" | "CONFLICT" } | { kind: "check"; name: string };

export interface VerifyReport {
  sha: string;
  verifierRunId: string;
  counts: Record<ClaimVerdictType, number>;
  blockers: Blocker[];
  /** True when nothing blocks. UNVERIFIABLE claims do not block: they are simply not rendered unless a person attests them. */
  passed: boolean;
}

/** The report stored with the version. A failing mechanical check blocks exactly as a FALSE claim does. */
export function buildReport(claims: readonly ClaimType[], checks: readonly MechanicalCheck[], ctx: Pick<DecideContext, "sha" | "verifierRunId">): VerifyReport {
  const counts: Record<ClaimVerdictType, number> = { VERIFIED: 0, FALSE: 0, UNVERIFIABLE: 0, CONFLICT: 0, PENDING: 0, ATTESTED: 0 };
  const blockers: Blocker[] = [];
  for (const c of claims) {
    counts[c.verdict] += 1;
    if (c.verdict === "FALSE" || c.verdict === "CONFLICT") blockers.push({ kind: "claim", id: c.id, verdict: c.verdict });
  }
  for (const k of checks) if (!k.ok) blockers.push({ kind: "check", name: k.name });
  return { sha: ctx.sha, verifierRunId: ctx.verifierRunId, counts, blockers, passed: blockers.length === 0 };
}
