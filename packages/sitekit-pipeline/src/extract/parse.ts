import { ClaimKind } from "@fx/sitekit-claims";
import type { EvidenceType } from "@fx/sitekit-claims";
import { z } from "zod";

/** More claims than this in one pass is a runaway answer, refused whole. */
export const MAX_CLAIMS = 500;
/** The shape of a claim id the extractor may use; the verifier's prompt checks the same pattern. */
export const CLAIM_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_TEXT = 2000;
const MAX_EXCERPT = 4000;

/** Strict (no extra keys) and ordered: a range that ends before it starts is refused. */
const StrictLines = z.object({ start: z.number().int().positive(), end: z.number().int().positive() }).strict().refine((l) => l.start <= l.end, "lines must not end before they start");

const RepoPath = z
  .string()
  .min(1)
  .max(300)
  .refine((p) => !p.startsWith("/") && !p.split("/").some((s) => s === ".." || s === ""), "evidence path must be a plain repository-relative path");

/**
 * What the agent may say about one claim. `.strict()` is deliberate: a key the agent adds (a `productKind`,
 * a `verdict`, a `repo_sha`) fails the whole answer instead of being read, so nothing the agent invents can
 * stand in for a decision that belongs to the customer or the verifier.
 */
const AgentEvidence = z
  .object({ path: RepoPath, lines: StrictLines.optional(), query: z.string().min(1).max(500).optional(), excerpt: z.string().max(MAX_EXCERPT).refine((s) => s.trim().length > 0, "an excerpt must hold text") })
  .strict();
const AgentClaim = z
  .object({
    id: z.string().regex(CLAIM_ID_RE),
    section: z.string().min(1).max(100),
    locale: z.string().min(1).max(35),
    text: z.string().min(1).max(MAX_TEXT),
    kind: ClaimKind,
    evidence: z.array(AgentEvidence).min(1).max(20),
  })
  .strict();
const AgentAnswer = z.object({ claims: z.array(AgentClaim).max(MAX_CLAIMS) }).strict();

/** A claim as the extract pass leaves it: no verdict, no verifier, evidence stamped with the pinned commit. */
export interface ExtractedClaim {
  id: string;
  section: string;
  locale: string;
  text: string;
  kind: z.infer<typeof ClaimKind>;
  evidence: EvidenceType[];
}

/** The agent's final text to claims. Throws a `ZodError`, a `SyntaxError` or an `Error`; the workflow turns each into `output_invalid`. */
export function parseExtractOutput(raw: string, sha: string): ExtractedClaim[] {
  const answer = AgentAnswer.parse(JSON.parse(raw));
  const seen = new Set<string>();
  return answer.claims.map((c) => {
    if (seen.has(c.id)) throw new Error(`duplicate claim id "${c.id}"`);
    seen.add(c.id);
    // The sha is ours: the commit the checkout was verified to be at, never a value the agent wrote.
    return { ...c, evidence: c.evidence.map((e) => ({ ...e, repo_sha: sha })) };
  });
}

/**
 * Claims that did not come straight from `parseExtractOutput` (a fix step's output, a stored list) go through the same
 * strict schema again before they are used: every evidence entry must already carry the pinned sha, which is then
 * re-stamped, and nothing extra is allowed. Throws like `parseExtractOutput`.
 */
export function revalidateClaims(claims: readonly ExtractedClaim[], sha: string): ExtractedClaim[] {
  const plain = claims.map((c) => ({
    ...c,
    evidence: (Array.isArray(c.evidence) ? c.evidence : []).map((e) => {
      const { repo_sha: pinned, ...rest } = e;
      if (pinned !== sha) throw new Error("evidence is not at the pinned commit");
      return rest;
    }),
  }));
  return parseExtractOutput(JSON.stringify({ claims: plain }), sha);
}
