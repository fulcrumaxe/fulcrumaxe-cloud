import { MAX_VERIFY_ATTEMPTS, type Verification } from "@fx/core/src/plan/proposalVerification.js";
import type { TriageCategory } from "../plan/categories.js";
import { CiteReadError, resolveClaims, type EvidenceRow, type FileReader, type ResolvedClaim } from "./verifierCites.js";
import { parseVerifierOutput, type VerifierOutputRejection } from "./verifierOutput.js";

/**
 * D#483 S4-b1: from a finished verifier run's envelope to the record `proposal_record_verification` takes.
 *
 * Pure apart from the cite reads. It does not touch the database, the model or the ledger; the worker (S4-b2) claims the proposal,
 * reserves the spend, starts the run and passes the run's output and the pinned sha in. The record's claims and evidence have
 * exactly the definer's argument shape (`p_claims`, `p_evidence`).
 */
export type RecordedVerification = Exclude<Verification, "pending">;

export type CheckFailure = VerifierOutputRejection | "read_failed";

export interface VerificationRecord {
  verification: RecordedVerification;
  /** The pinned commit the verdict rests on. Null for `not_checked` and `check_failed`. */
  verified_sha: string | null;
  claims: ResolvedClaim[];
  evidence: EvidenceRow[];
  /** The verifier's category, or null when the output was refused whole. */
  category: TriageCategory | null;
  /** Why the check failed; set only for `check_failed`. */
  failure?: CheckFailure;
}

/**
 * The roll-up: every claim supported gives `verified`; some, `partly_verified`; none, `refuted`. `unverifiable` counts as not supported.
 * No claims at all is `not_checked` (nothing was attempted; the attempt counter stays).
 */
export function rollUp(claims: ReadonlyArray<{ verdict: "supported" | "refuted" | "unverifiable" }>): "verified" | "partly_verified" | "refuted" | "not_checked" {
  if (claims.length === 0) return "not_checked";
  const supported = claims.filter((c) => c.verdict === "supported").length;
  if (supported === claims.length) return "verified";
  return supported > 0 ? "partly_verified" : "refuted";
}

/** A failed check writes the failure and nothing else: no claims, no evidence. */
export function failedRecord(failure: CheckFailure): VerificationRecord {
  return { verification: "check_failed", verified_sha: null, claims: [], evidence: [], category: null, failure };
}

/**
 * Whether the worker may pick this proposal up: a `pending` one, or a `check_failed` one that has not used its attempts
 * (`MAX_VERIFY_ATTEMPTS`, the constant the read side reports with). Every other verdict is final until the text changes.
 */
export function isVerifyEligible(p: { verification: Verification; verify_attempts: number }): boolean {
  if (p.verification === "pending") return true;
  return p.verification === "check_failed" && p.verify_attempts < MAX_VERIFY_ATTEMPTS;
}

/** Whether a failed check, recorded now, spends the last attempt (the proposal then stays `check_failed` until a person acts). */
export function exhaustsAttempts(p: { verify_attempts: number }): boolean {
  return p.verify_attempts + 1 >= MAX_VERIFY_ATTEMPTS;
}

export async function recordFromOutput(input: { envelope: unknown; sha: string; reader: FileReader }): Promise<VerificationRecord> {
  const parsed = parseVerifierOutput(input.envelope);
  if (!parsed.ok) return failedRecord(parsed.reason);
  const { category, claims } = parsed.output;
  if (claims.length === 0) return { verification: "not_checked", verified_sha: null, claims: [], evidence: [], category };
  try {
    const resolved = await resolveClaims(input.reader, input.sha, claims);
    const verification = rollUp(resolved.claims);
    return { verification, verified_sha: input.sha, claims: resolved.claims, evidence: resolved.evidence, category };
  } catch (err) {
    if (err instanceof CiteReadError) return failedRecord("read_failed");
    throw err;
  }
}
