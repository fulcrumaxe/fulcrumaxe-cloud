/**
 * H09a: shared types for sandbox orchestration primitives.
 *
 * This is the H09a slice of D#2 H09 ("Per-role run orchestration as
 * Workflow code with a fake sandbox") -- networkPolicy, sandboxPort,
 * fakeSandbox, the tenant-key firewall-policy step, and the agent_runs /
 * work_items state machine (sec-criteria A8). `startAgentRun`, `resume`,
 * `stop`-as-a-plain-function and the `"use workflow"`/`"use step"`
 * wrappers are H09b, built against the port defined here but not part of
 * this PR -- see the PR description for the split rationale.
 *
 * Re-exports the H04 (@fx/runtime) shapes this package builds on top of,
 * rather than redefining them, so the two packages cannot drift apart.
 */
export type {
  AgentHandle,
  AgentRuntime,
  ModelProvider,
  NormalizedEvent,
  NormalizedUsage,
  StartOptions,
} from "@fx/runtime/src/types.js";

/** The two products a repo can be attached to (mirrors @fx/gh-policy's
 * `Product` -- H09a does not depend on @fx/gh-policy for one string union,
 * to keep this package's own dependency surface minimal). */
export type Product = "team" | "sitekit";

/** Role card name, e.g. "executor", "code-reviewer" -- see
 * packages/roles/src/manifest.ts for the full set. Plain `string` here
 * (not a union) because H09a must not need updating every time a role is
 * added or renamed. */
export type Role = string;

/**
 * Where a run's model traffic is brokered to: a tenant's own provider, or the operator's
 * own subscription (the one exception, see @fx/runtime's operatorSubscription.ts). Only
 * the firewall policy and the sandbox env know the third kind exists; a tenant's stored
 * connection can never be it.
 */
export type ConnectionKind = import("@fx/runtime/src/types.js").ModelProvider | "operator_subscription";
