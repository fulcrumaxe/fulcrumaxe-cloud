import type { ClaimType } from "@fx/sitekit-claims";
import { ExtractError, checkPassInput, runSandboxedPass, type ExtractDeps, type ExtractedClaim, type PassMode } from "../extract/index.js";
import { decideClaims } from "./decide.js";
import { parseVerifyOutput } from "./parse.js";
import { buildVerifyPrompt } from "./prompt.js";

export interface VerifyInput {
  accountId: string;
  /** The verifier's own run id. It must differ from the extractor's. */
  runId: string;
  extractorRunId: string;
  owner: string;
  name: string;
  sha: string;
  mode: PassMode;
  capUsd?: number;
  claims: readonly ExtractedClaim[];
  checkedAt: string;
}

export interface VerifyPassResult {
  claims: ClaimType[];
  usedUsd: number;
  cleanupFailed: string[];
}

/**
 * One verify pass, in a run of its own: a different run id and the other role than the extractor's, the same pinned
 * checkout, the same sandbox, policy and spend rules (`runSandboxedPass`). The prompt carries the claims without their
 * evidence and the verdicts come only from `decideClaims`, so nothing the agent writes can set a verdict outside its schema.
 */
export async function runVerify(deps: ExtractDeps, input: VerifyInput): Promise<VerifyPassResult> {
  const capUsd = checkPassInput(input);
  if (input.runId === input.extractorRunId) throw new ExtractError("input_invalid");
  const prompt = buildVerifyPrompt({ owner: input.owner, name: input.name, sha: input.sha, claims: input.claims });
  const askedIds = input.claims.map((c) => c.id);
  const pass = await runSandboxedPass(deps, {
    role: "site-verifier",
    accountId: input.accountId,
    runId: input.runId,
    owner: input.owner,
    name: input.name,
    sha: input.sha,
    mode: input.mode,
    capUsd,
    prompt,
    parse: (output) => parseVerifyOutput(output, input.sha, askedIds),
  });
  const claims = decideClaims(input.claims, pass.value, { sha: input.sha, verifierRunId: input.runId, checkedAt: input.checkedAt });
  return { claims, usedUsd: pass.usedUsd, cleanupFailed: pass.cleanupFailed };
}
