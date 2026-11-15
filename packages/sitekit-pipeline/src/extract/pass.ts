import { AgentRunError, ExtractError } from "./errors.js";

/** The two roles site kit runs. A pass is for exactly one of them. */
export type SiteRole = "site-extractor" | "site-verifier";

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
 * The sandbox as a pass needs it, in the order it is used. The live adapter over the runner's sandbox port
 * is wired with the live path (after the preview row); a recording fake stands in for it in tests.
 */
export interface ExtractSandbox {
  /** The sandbox is created already carrying `policy`: it is never allow-all, not even briefly. */
  create(opts: { sandboxName: string; policy: readonly PolicyRule[] }): Promise<ExtractSandboxHandle>;
  /** Clones the repository and checks out `sha`. Throws unless HEAD equals `sha` afterwards. */
  clone(handle: ExtractSandboxHandle, target: { owner: string; name: string; sha: string; workdir: string }): Promise<void>;
  setNetworkPolicy(handle: ExtractSandboxHandle, policy: readonly PolicyRule[]): Promise<void>;
  /**
   * Runs the agent and returns its final text and the model spend it metered. A failure after the agent was started
   * (a timeout, a crash) is thrown as an `AgentRunError` carrying the spend metered so far, when the adapter knows it.
   */
  startAgent(
    handle: ExtractSandboxHandle,
    opts: { role: SiteRole; runId: string; prompt: string; workdir: string; capUsd: number },
  ): Promise<{ output: string; usedUsd: number }>;
  deleteSandbox(handle: ExtractSandboxHandle): Promise<void>;
}

/** Reservation and metering of a pass's model spend, on the customer's own key. */
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

export const WORKDIR = "/vercel/sandbox/repo";
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

export interface PassSpec<T> {
  role: SiteRole;
  accountId: string;
  runId: string;
  owner: string;
  name: string;
  sha: string;
  mode: PassMode;
  /** Already validated; the spend reserved and the agent's own limit. */
  capUsd: number;
  /** Already built (and so already validated) before anything is reserved or created. */
  prompt: string;
  /** The agent's final text to the pass's value. Any throw is `output_invalid`. */
  parse(output: string): T;
}

export interface PassResult<T> {
  value: T;
  usedUsd: number;
  /** Cleanup stages that failed and were reported; the pass's own outcome is unaffected. */
  cleanupFailed: string[];
}

/**
 * One agent pass, for either site role. Order, always: reserve the pass's spend, create the sandbox under the clone
 * policy, clone and pin the commit, narrow the policy to the model host alone, then start the agent. A refusal before
 * the agent starts leaves nothing running and releases the reservation. From the moment the agent is started, the
 * reservation is only ever settled, never released, because a failed run may still have spent money: it settles the
 * spend the adapter reported, and the whole reserved cap when that is missing, negative or not a number. Whatever
 * happens, the sandbox is deleted, and a cleanup that throws is reported without replacing the pass's own outcome.
 */
export async function runSandboxedPass<T>(deps: ExtractDeps, spec: PassSpec<T>): Promise<PassResult<T>> {
  validatePolicies(deps.policies);
  const reserved = await deps.spend.reserve({ accountId: spec.accountId, runId: spec.runId, mode: spec.mode, capUsd: spec.capUsd });
  if (!reserved.ok) throw new ExtractError("spend_refused");
  let handle: ExtractSandboxHandle | undefined;
  let agentStarted = false;
  let metered: number | undefined;
  const cleanupFailed: string[] = [];
  try {
    try {
      handle = await deps.sandbox.create({ sandboxName: `sk-${spec.role === "site-extractor" ? "extract" : "verify"}-${spec.runId}`, policy: deps.policies.clone });
    } catch {
      throw new ExtractError("sandbox_failed");
    }
    try {
      await deps.sandbox.clone(handle, { owner: spec.owner, name: spec.name, sha: spec.sha, workdir: WORKDIR });
    } catch {
      throw new ExtractError("clone_failed");
    }
    // Fail closed: a policy that cannot be narrowed means the agent never starts.
    try {
      await deps.sandbox.setNetworkPolicy(handle, deps.policies.agent);
    } catch {
      throw new ExtractError("policy_failed");
    }
    agentStarted = true;
    let ran: { output: string; usedUsd: number };
    try {
      ran = await deps.sandbox.startAgent(handle, { role: spec.role, runId: spec.runId, prompt: spec.prompt, workdir: WORKDIR, capUsd: spec.capUsd });
    } catch (err) {
      if (err instanceof AgentRunError) metered = err.usedUsd;
      throw new ExtractError("agent_failed");
    }
    metered = ran.usedUsd;
    if (!Number.isFinite(metered) || metered < 0 || metered > spec.capUsd) throw new ExtractError("over_cap");
    let value: T;
    try {
      value = spec.parse(ran.output);
    } catch {
      throw new ExtractError("output_invalid");
    }
    return { value, usedUsd: metered, cleanupFailed };
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
        const amount = metered !== undefined && Number.isFinite(metered) && metered >= 0 ? metered : spec.capUsd;
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
