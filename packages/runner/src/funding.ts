/**
 * D#2 H09b2, correction C16 (PM, 2026-09-18): "H09b2 takes a run-funding
 * seam" -- D#70 (the contributor/sponsor task board) will later run a run
 * "in the maintainer's tenant but on the claimant's model key and budget."
 * C16's design is binding for H09b2; D#70 itself is not built here.
 *
 * `defaultResolvePayer` is the production default: `{kind:'self'}` (or
 * `funding` omitted) resolves to the run's own account, and `{kind:'claim'}`
 * fails closed with `UnsupportedFundingError` until D#70 BRD-4 ships a real
 * resolver. This keeps claim funding a hard "not implemented" rather than a
 * silent fall-through to the maintainer's own account/key/budget.
 */
export type RunFunding = { kind: "self" } | { kind: "claim"; payerAccountId: string; fundingId: string };

/** C16: "{kind:'claim'} throws UnsupportedFundingError. D#70 BRD-4 replaces
 * this default after launch. Until then, claim funding fails closed." */
export class UnsupportedFundingError extends Error {
  constructor() {
    super("claim-funded runs are not supported until D#70 BRD-4 ships a real payer resolver");
    this.name = "UnsupportedFundingError";
  }
}

/** The minimal shape `resolvePayer` needs -- callers pass either a full
 * `ExecutionRun` or (for `startAgentRun`'s own early fail-fast check,
 * before an `ExecutionRun` exists) this same narrow slice. */
export interface FundedRun {
  accountId: string;
  funding?: RunFunding;
}

export function defaultResolvePayer(run: FundedRun): string {
  const funding = run.funding ?? { kind: "self" as const };
  if (funding.kind === "self") return run.accountId;
  throw new UnsupportedFundingError();
}
