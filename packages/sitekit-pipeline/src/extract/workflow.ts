import { ProductKind } from "@fx/sitekit-claims";
import { buildExtractPrompt, type SeedFile } from "./prompt.js";
import { parseExtractOutput, type ExtractedClaim } from "./parse.js";
import { AgentRunError, ExtractError, assertRepoCoordinates } from "./errors.js";

/** Model spend one pass may reserve unless the customer sets another cap: a full pass, and a pass scoped to a diff. */
export const DEFAULT_PASS_CAP_USD: Readonly<Record<PassMode, number>> = Object.freeze({ full: 225, diff: 20 });

export type PassMode = "full" | "diff";

/** One allowed destination. Exact hosts only: a rule that is a pattern is refused before the sandbox exists. */
export interface PolicyRule {
  host: string;
  purpose: "model" | "github_proxy";
}

export interface ExtractSandboxHandle {
  sandboxName: string;
}

/**
 * The sandbox as this pass needs it, in the order it is used. The live adapter over the runner's sandbox port
 * is wired with the live path (after the preview row); a recording fake stands in for it in tests.
 */
export interface ExtractSandbox {
  /** The sandbox is created already carrying `policy`: it is never allow-all, not even briefly. */
  create(opts: { sandboxName: string; policy: readonly PolicyRule[] }): Promise<ExtractSandboxHandle>;
  /** Clones the repository and checks out `sha`. Throws unless HEAD equals `sha` afterwards. */
  clone(handle: ExtractSandboxHandle, target: { owner: string; name: string; sha: string; workdir: string }): Promise<void>;
  setNetworkPolicy(handle: ExtractSandboxHandle, policy: readonly PolicyRule[]): Promise<void>;
  /**
   * Runs the extractor and returns its final text and the model spend it metered. A failure after the agent was started
   * (a timeout, a crash) is thrown as an `AgentRunError` carrying the spend metered so far, when the adapter knows it.
   */
  startAgent(
    handle: ExtractSandboxHandle,
    opts: { role: "site-extractor"; runId: string; prompt: string; workdir: string; capUsd: number },
  ): Promise<{ output: string; usedUsd: number }>;
  deleteSandbox(handle: ExtractSandboxHandle): Promise<void>;
}

/** Reservation and metering of the pass's model spend, on the customer's own key. */
export interface SpendPort {
  reserve(p: { accountId: string; runId: string; mode: PassMode; capUsd: number }): Promise<{ ok: true; reservationId: string } | { ok: false }>;
  settle(reservationId: string, usedUsd: number): Promise<void>;
  release(reservationId: string): Promise<void>;
}

export interface ExtractDeps {
  sandbox: ExtractSandbox;
  spend: SpendPort;
  /** What the sandbox may reach while it clones, and what it may reach once the agent can run. */
  policies: { clone: readonly PolicyRule[]; agent: readonly PolicyRule[] };
  /** Where a failure that must not change the pass's outcome is reported (a cleanup or a settlement that threw). */
  report(stage: "delete_sandbox" | "settle" | "release", err: unknown): void;
}

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

const WORKDIR = "/vercel/sandbox/repo";
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The two policies, checked before anything is created. While cloning: the model host and the GitHub proxy
 * only. Once the agent can run: the model host alone, one rule, so the checkout it reads can send nothing anywhere else.
 */
export function validatePolicies(p: ExtractDeps["policies"]): void {
  const exact = (r: PolicyRule): boolean => HOST_RE.test(r.host) && (r.purpose === "model" || r.purpose === "github_proxy");
  if (p.clone.length === 0 || !p.clone.every(exact)) throw new ExtractError("policy_invalid");
  if (p.agent.length !== 1 || !exact(p.agent[0]!) || p.agent[0]!.purpose !== "model") throw new ExtractError("policy_invalid");
}

function checkInput(i: ExtractInput): number {
  assertRepoCoordinates(i.owner, i.name, i.sha);
  const ok = ID_RE.test(i.accountId) && ID_RE.test(i.runId) && ProductKind.safeParse(i.productKind).success && (i.mode === "full" || i.mode === "diff");
  const cap = i.capUsd ?? DEFAULT_PASS_CAP_USD[i.mode];
  if (!ok || !Number.isFinite(cap) || cap <= 0) throw new ExtractError("input_invalid");
  return cap;
}

/**
 * One extract pass. Order, always: reserve the pass's spend, create the sandbox under the clone policy, clone and
 * pin the commit, narrow the policy to the model host alone, then start the agent. A refusal before the agent
 * starts leaves nothing running and releases the reservation. From the moment the agent is started, the reservation
 * is only ever settled, never released, because a failed run may still have spent money: it settles the spend the
 * adapter reported, and the whole reserved cap when that is missing, negative or not a number. Whatever happens, the
 * sandbox is deleted, and a cleanup that throws is reported without replacing the pass's own outcome.
 */
export async function runExtract(deps: ExtractDeps, input: ExtractInput): Promise<ExtractResult> {
  const capUsd = checkInput(input);
  validatePolicies(deps.policies);
  const reserved = await deps.spend.reserve({ accountId: input.accountId, runId: input.runId, mode: input.mode, capUsd });
  if (!reserved.ok) throw new ExtractError("spend_refused");
  let handle: ExtractSandboxHandle | undefined;
  let agentStarted = false;
  let metered: number | undefined;
  const cleanupFailed: string[] = [];
  try {
    try {
      handle = await deps.sandbox.create({ sandboxName: `sk-extract-${input.runId}`, policy: deps.policies.clone });
    } catch {
      throw new ExtractError("sandbox_failed");
    }
    try {
      await deps.sandbox.clone(handle, { owner: input.owner, name: input.name, sha: input.sha, workdir: WORKDIR });
    } catch {
      throw new ExtractError("clone_failed");
    }
    // Fail closed: a policy that cannot be narrowed means the agent never starts.
    try {
      await deps.sandbox.setNetworkPolicy(handle, deps.policies.agent);
    } catch {
      throw new ExtractError("policy_failed");
    }
    const prompt = buildExtractPrompt({ owner: input.owner, name: input.name, sha: input.sha, productKind: input.productKind, seed: input.seed ?? [] });
    agentStarted = true;
    let ran: { output: string; usedUsd: number };
    try {
      ran = await deps.sandbox.startAgent(handle, { role: "site-extractor", runId: input.runId, prompt, workdir: WORKDIR, capUsd });
    } catch (err) {
      if (err instanceof AgentRunError) metered = err.usedUsd;
      throw new ExtractError("agent_failed");
    }
    metered = ran.usedUsd;
    if (!Number.isFinite(metered) || metered < 0 || metered > capUsd) throw new ExtractError("over_cap");
    let claims: ExtractedClaim[];
    try {
      claims = parseExtractOutput(ran.output, input.sha);
    } catch {
      throw new ExtractError("output_invalid");
    }
    return { productKind: input.productKind, sha: input.sha, claims, usedUsd: metered, cleanupFailed };
  } finally {
    if (handle !== undefined) {
      try {
        await deps.sandbox.deleteSandbox(handle);
      } catch (err) {
        // fx-swallow-ok: reported through deps.report and flagged in cleanupFailed; cleanup never replaces the pass's outcome
        cleanupFailed.push("delete_sandbox");
        deps.report("delete_sandbox", err);
      }
    }
    try {
      if (agentStarted) {
        const amount = metered !== undefined && Number.isFinite(metered) && metered >= 0 ? metered : capUsd;
        await deps.spend.settle(reserved.reservationId, amount);
      } else {
        await deps.spend.release(reserved.reservationId);
      }
    } catch (err) {
      // fx-swallow-ok: reported through deps.report and flagged in cleanupFailed; settlement trouble never replaces the pass's outcome
      const stage = agentStarted ? "settle" : "release";
      cleanupFailed.push(stage);
      deps.report(stage, err);
    }
  }
}
