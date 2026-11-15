import { ProductKind } from "@fx/sitekit-claims";
import { buildExtractPrompt, type SeedFile } from "./prompt.js";
import { parseExtractOutput, type ExtractedClaim } from "./parse.js";
import { ExtractError, assertRepoCoordinates } from "./errors.js";
import { runSandboxedPass, type ExtractDeps, type PassMode } from "./pass.js";

/** Model spend one pass may reserve unless the customer sets another cap: a full pass, and a pass scoped to a diff. */
export const DEFAULT_PASS_CAP_USD: Readonly<Record<PassMode, number>> = Object.freeze({ full: 225, diff: 20 });

export interface ExtractInput {
  accountId: string;
  /** The extractor's own run id. The verifier gets a different one. */
  runId: string;
  owner: string;
  name: string;
  sha: string;
  productKind: ProductKind;
  mode: PassMode;
  /** The customer's cap for this pass; absent takes `DEFAULT_PASS_CAP_USD[mode]`. */
  capUsd?: number;
  seed?: readonly SeedFile[];
  /** A shallow pass reads the README and the top-level documentation only (the preview). */
  shallow?: boolean;
}

export interface ExtractResult {
  /** The customer's choice, copied from the input. Nothing the agent wrote can change it. */
  productKind: ProductKind;
  sha: string;
  claims: ExtractedClaim[];
  usedUsd: number;
  /** Cleanup stages that failed and were reported; the pass's own outcome is unaffected. */
  cleanupFailed: string[];
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** The cap a pass reserves, after the ids, the mode and the cap itself are checked. Shared by both site roles. */
export function checkPassInput(i: { accountId: string; runId: string; owner: string; name: string; sha: string; mode: PassMode; capUsd?: number }): number {
  assertRepoCoordinates(i.owner, i.name, i.sha);
  const cap = i.capUsd ?? DEFAULT_PASS_CAP_USD[i.mode];
  if (!ID_RE.test(i.accountId) || !ID_RE.test(i.runId) || (i.mode !== "full" && i.mode !== "diff") || !Number.isFinite(cap) || cap <= 0) throw new ExtractError("input_invalid");
  return cap;
}

/**
 * One extract pass: the sandbox, spend and policy rules are `runSandboxedPass`'s (see there). The prompt is built, and
 * so its inputs validated, before anything is reserved or created.
 */
export async function runExtract(deps: ExtractDeps, input: ExtractInput): Promise<ExtractResult> {
  const capUsd = checkPassInput(input);
  if (!ProductKind.safeParse(input.productKind).success) throw new ExtractError("input_invalid");
  const prompt = buildExtractPrompt({ owner: input.owner, name: input.name, sha: input.sha, productKind: input.productKind, seed: input.seed ?? [], shallow: input.shallow === true });
  const pass = await runSandboxedPass(deps, {
    role: "site-extractor",
    accountId: input.accountId,
    runId: input.runId,
    owner: input.owner,
    name: input.name,
    sha: input.sha,
    mode: input.mode,
    capUsd,
    prompt,
    parse: (output) => parseExtractOutput(output, input.sha),
  });
  return { productKind: input.productKind, sha: input.sha, claims: pass.value, usedUsd: pass.usedUsd, cleanupFailed: pass.cleanupFailed };
}
