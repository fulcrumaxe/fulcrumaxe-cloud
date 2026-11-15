import type { ClaimType } from "@fx/sitekit-claims";
import { ExtractError, revalidateClaims, type ExtractedClaim } from "../extract/index.js";
import { buildReport, type Blocker, type MechanicalCheck, type VerifyReport } from "./decide.js";

/** After this many fix-then-reverify cycles, a pass that still blocks goes to the customer. */
export const MAX_FIX_CYCLES = 2;

export interface CycleDeps {
  /** One verify pass over these claims (in its own run). Throws like `runVerify`. */
  verify(claims: readonly ExtractedClaim[], attempt: number): Promise<{ claims: ClaimType[] }>;
  /** The deterministic checks over the site rendered from the decided claims. */
  runChecks(claims: readonly ClaimType[]): Promise<MechanicalCheck[]>;
  /** Proposes corrected claims for the blockers. Called at most `MAX_FIX_CYCLES` times. */
  fix(blockers: readonly Blocker[], claims: readonly ClaimType[]): Promise<ExtractedClaim[]>;
}

export interface CycleOutcome {
  status: "passed" | "handed_to_customer";
  claims: ClaimType[];
  report: VerifyReport;
  /** Verify passes run: 1 plus the fix cycles used. */
  passes: number;
}

/**
 * Verify, run the mechanical checks, and when something blocks, fix and verify again, at most twice. The checks run
 * after every verify pass, as deterministic steps, and a failing one blocks like a FALSE claim. The customer gets
 * the last report whatever it says; a pass that still blocks after the cap is handed over, never retried.
 */
export async function runVerifyCycles(
  deps: CycleDeps,
  start: { claims: readonly ExtractedClaim[]; sha: string; extractorRunId: string; verifierRunIdFor(attempt: number): string },
): Promise<CycleOutcome> {
  // Whatever enters a verify pass has been through the strict claim schema, including what a fix step hands back.
  const valid = (claims: readonly ExtractedClaim[]): ExtractedClaim[] => {
    try {
      return revalidateClaims(claims, start.sha);
    } catch {
      throw new ExtractError("output_invalid");
    }
  };
  let extracted = valid(start.claims);
  for (let attempt = 0; ; attempt += 1) {
    const verifierRunId = start.verifierRunIdFor(attempt);
    if (verifierRunId === start.extractorRunId) throw new ExtractError("input_invalid");
    const verified = await deps.verify(extracted, attempt);
    // The report names the run that made the verdicts: every claim must carry that run's id, and none may be the extractor's.
    if (verified.claims.some((c) => c.verifier_run_id !== verifierRunId)) throw new ExtractError("output_invalid");
    const checks = await deps.runChecks(verified.claims);
    const report = buildReport(verified.claims, checks, { sha: start.sha, verifierRunId });
    if (report.passed) return { status: "passed", claims: verified.claims, report, passes: attempt + 1 };
    if (attempt >= MAX_FIX_CYCLES) return { status: "handed_to_customer", claims: verified.claims, report, passes: attempt + 1 };
    extracted = valid(await deps.fix(report.blockers, verified.claims));
  }
}
