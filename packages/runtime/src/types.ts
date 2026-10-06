/**
 * H04: Model/runtime adapter — shared interface. The declarations live in `@fulcrumaxe/runner-protocol` (D#6 R1),
 * so the public runner and this package share one definition; this file only re-exports them, so every existing
 * import (including `@fx/runner`'s deep import of `@fx/runtime/src/types.js`) still resolves.
 */
export {
  LocalRunnerRefused,
  SubscriptionCredentialsRefused,
  type AgentHandle,
  type AgentRuntime,
  type ModelConnectionStatus,
  type ModelProvider,
  type NormalizedEvent,
  type NormalizedUsage,
  type SandboxSpec,
  type StartOptions,
} from "@fulcrumaxe/runner-protocol/agentRuntime";
