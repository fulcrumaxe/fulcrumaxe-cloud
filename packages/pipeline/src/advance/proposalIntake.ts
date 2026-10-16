/**
 * D#483 S4-e: the text the stage driver reads for a work item that came from an approved proposal (no GitHub issue).
 *
 * The result is the item's discussion body. It is plain, unfenced text on purpose: every prompt builder (classify, panel seat,
 * short Spec) passes the discussion's title and body through `sanitize`, the one fence, when it builds its prompt, so the
 * fence is applied where the text reaches a prompt and nowhere else. This module therefore never wraps and never trusts:
 * a proposal's summary may come from an outside author's issue, and a person's approval click made the ITEM internal, not
 * the text. Claims and evidence excerpts have a slot so the row that wires S4-a's tables in changes this call site only.
 */
export interface ProposalIntakeInput {
  summary: string | null;
  /** Claim texts (S4-a). Not read anywhere yet; the slot is tested. */
  claims?: readonly string[];
  /** Evidence excerpts with their refs (S4-a). Not read anywhere yet; the slot is tested. */
  evidence?: ReadonlyArray<{ ref: string; excerpt: string }>;
}

export const PROPOSAL_INTAKE_MAX_CHARS = 8000;

export function proposalIntakeBody(input: ProposalIntakeInput): string {
  const parts: string[] = [];
  const summary = (input.summary ?? "").trim();
  if (summary) parts.push(`SUMMARY:\n${summary}`);
  const claims = (input.claims ?? []).map((c) => c.trim()).filter((c) => c.length > 0);
  if (claims.length > 0) parts.push(`CLAIMS:\n${claims.map((c) => `- ${c}`).join("\n")}`);
  const evidence = (input.evidence ?? []).filter((e) => e.excerpt.trim().length > 0);
  if (evidence.length > 0) parts.push(`EVIDENCE:\n${evidence.map((e) => `[${e.ref}]\n${e.excerpt.trim()}`).join("\n\n")}`);
  return parts.join("\n\n").slice(0, PROPOSAL_INTAKE_MAX_CHARS);
}
