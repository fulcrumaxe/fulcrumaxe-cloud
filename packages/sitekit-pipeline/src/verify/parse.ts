import type { EvidenceType } from "@fx/sitekit-claims";
import { z } from "zod";
import { MAX_CLAIMS } from "../extract/index.js";

/**
 * The only verdicts a verifier may give. CONFLICT is decided by us (the verifier's evidence disagrees with the
 * extractor's), PENDING and ATTESTED are not machine outcomes, so none of the three can appear in an answer.
 */
export const AGENT_VERDICTS = ["VERIFIED", "FALSE", "UNVERIFIABLE"] as const;
export type AgentVerdict = (typeof AGENT_VERDICTS)[number];

const Lines = z.object({ start: z.number().int().positive(), end: z.number().int().positive() }).strict().refine((l) => l.start <= l.end, "lines must not end before they start");
const RepoPath = z
  .string()
  .min(1)
  .max(300)
  .refine((p) => !p.startsWith("/") && !p.split("/").some((s) => s === ".." || s === ""), "evidence path must be a plain repository-relative path");
const Ev = z.object({ path: RepoPath, lines: Lines.optional(), query: z.string().min(1).max(500).optional(), excerpt: z.string().max(4000).refine((s) => s.trim().length > 0, "an excerpt must hold text") }).strict();

const Result = z
  .object({ id: z.string().min(1).max(64), verdict: z.enum(AGENT_VERDICTS), evidence: z.array(Ev).max(20) })
  .strict()
  .refine((r) => r.verdict !== "VERIFIED" || r.evidence.length >= 1, "VERIFIED needs evidence");
const Answer = z.object({ results: z.array(Result).max(MAX_CLAIMS) }).strict();

export interface VerifierResult {
  id: string;
  verdict: AgentVerdict;
  evidence: EvidenceType[];
}

/**
 * The verifier's final text to results, strictly: an unknown key, a verdict outside the three, a claim id the pass
 * did not ask about, or an id answered twice fails the whole answer. A claim left unanswered is not an error here;
 * `decideClaims` treats it as UNVERIFIABLE. Evidence is stamped with the pinned sha by us.
 */
export function parseVerifyOutput(raw: string, sha: string, askedIds: readonly string[]): VerifierResult[] {
  const answer = Answer.parse(JSON.parse(raw));
  const asked = new Set(askedIds);
  const seen = new Set<string>();
  return answer.results.map((r) => {
    if (!asked.has(r.id)) throw new Error("a result names a claim that was not asked about");
    if (seen.has(r.id)) throw new Error("a claim is answered twice");
    seen.add(r.id);
    return { id: r.id, verdict: r.verdict, evidence: r.evidence.map((e) => ({ ...e, repo_sha: sha })) };
  });
}
