/**
 * D#483 S4-e: the text the stage driver reads for a work item that came from an approved proposal (no GitHub issue).
 *
 * The result is the item's discussion body. It is plain, unfenced text on purpose: every prompt builder (classify, panel seat,
 * short Spec) passes the discussion's title and body through `sanitize`, the one fence, when it builds its prompt, so the
 * fence is applied where the text reaches a prompt and nowhere else. This module therefore never wraps and never trusts:
 * a proposal's summary may come from an outside author's issue, and a person's approval click made the ITEM internal, not
 * the text. D#483 S4-b3 fills the claims and evidence slots from S4-a's tables at the one call site (apps/web/lib/advanceSteps.ts `loadBody`).
 * The labelled blocks are built here and nowhere else (a guard test fails the build otherwise).
 *
 * Each piece of text (the summary, every claim, every evidence ref and excerpt) has its control tokens stripped on its own before the pieces
 * are joined, so an unterminated comment opener in one claim can only erase that claim, never the claims and evidence after it. The prompt
 * builders still apply `sanitize` (the fence) to the joined body afterwards.
 */
import { stripControlTokens } from "@fx/trust";

export interface ProposalIntakeInput {
  summary: string | null;
  /** The texts of the proposal's `supported` claims only (S4-a `proposal_claims`); refuted, unverifiable and pending claims are left out by the reader. */
  claims?: readonly string[];
  /** Every evidence row of the proposal, with the excerpt the system read and stored at the cited commit (S4-a `proposal_evidence`). */
  evidence?: ReadonlyArray<{ ref: string; excerpt: string }>;
}

export const PROPOSAL_INTAKE_MAX_CHARS = 8000;

export function proposalIntakeBody(input: ProposalIntakeInput): string {
  const clean = (t: string): string => stripControlTokens(t).trim();
  const parts: string[] = [];
  const summary = clean(input.summary ?? "");
  if (summary) parts.push(`SUMMARY:\n${summary}`);
  const claims = (input.claims ?? []).map(clean).filter((c) => c.length > 0);
  if (claims.length > 0) parts.push(`CLAIMS:\n${claims.map((c) => `- ${c}`).join("\n")}`);
  const evidence = (input.evidence ?? []).map((e) => ({ ref: clean(e.ref), excerpt: clean(e.excerpt) })).filter((e) => e.excerpt.length > 0);
  if (evidence.length > 0) parts.push(`EVIDENCE:\n${evidence.map((e) => `[${e.ref}]\n${e.excerpt}`).join("\n\n")}`);
  return parts.join("\n\n").slice(0, PROPOSAL_INTAKE_MAX_CHARS);
}
