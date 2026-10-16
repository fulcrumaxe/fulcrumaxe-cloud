import { createHash } from "node:crypto";

/**
 * D#598 P1f-2b: the one copy of the pairing digest. The hosted side stamps it when a build starts (the cloud's core record module, which re-exports
 * this function) and compares it on the pairing, token and report routes; the pairing reply recomputes it from its own fields (a check on the bytes,
 * not authentication). It lives here because this package is the one both sides already import and it imports nothing of ours.
 */

/** The part of a pairing the digest covers. */
export interface PairingForDigest {
  codeRepo: string;
  overlayGlobs: readonly string[];
  identifierRulesPath: string | null;
  planDataRulesPath: string | null;
}

/**
 * A hash of the pairing as read at build start: the repo's full name (case-folded, as GitHub treats it), the overlay globs in their stored order,
 * and the two rule-file paths. JSON of a fixed array shape keeps the encoding unambiguous.
 */
export function pairingDigest(p: PairingForDigest): string {
  return createHash("sha256")
    .update(JSON.stringify([p.codeRepo.toLowerCase(), [...p.overlayGlobs], p.identifierRulesPath, p.planDataRulesPath]))
    .digest("hex");
}
