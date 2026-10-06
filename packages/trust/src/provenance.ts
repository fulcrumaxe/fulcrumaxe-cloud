import type { Provenance } from "./work-gate.js";

/**
 * Thrown by `parseProvenance` for anything that isn't exactly one of the
 * two literal strings `"internal"` or `"external"`. A distinct type (not
 * a plain `Error`) so a caller can `instanceof`-check it rather than
 * matching on message text.
 */
export class ProvenanceError extends Error {
  constructor(value: unknown) {
    super(`invalid provenance value: ${JSON.stringify(value)}`);
    this.name = "ProvenanceError";
  }
}

/**
 * The one mapping function at the DB boundary (D#103, README rule 4).
 * Every read of a `work_items.provenance` column must go through this
 * before the value reaches `autoMergeAllowed` — see
 * `packages/db/migrations/0608_work_items_provenance_vocabulary.sql` for
 * the CHECK constraint this mirrors.
 *
 * Deliberately two `===` checks and nothing else: no trimming, no
 * case-folding. Normalizing `"Internal"`/`" internal"`/etc. into
 * `"internal"` here would be exactly the loose handling README rule 4
 * forbids — a bug upstream (a typo, a wrong case, a stray space) must
 * surface as a thrown error, not silently resolve to a value that
 * happens to look right. `autoMergeAllowed` itself already treats
 * anything that isn't the exact literal `"internal"` as external and
 * never throws (see its docstring in `work-gate.ts`) — that is its own
 * last line of defense for values that never came through this function
 * at all. This function exists so a bug THIS FAR upstream — before
 * `autoMergeAllowed` is ever called — is loud instead of silently
 * indistinguishable from a genuinely external work item.
 */
export function parseProvenance(value: unknown): Provenance {
  if (value === "internal") return "internal";
  if (value === "external") return "external";
  throw new ProvenanceError(value);
}
