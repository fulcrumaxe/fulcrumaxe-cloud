/**
 * How an agent run's outcome becomes the job's failure, shared by every engine behind `SandboxPort` (the host sandbox and the microVM one), so the
 * two read an engine's `{ status: "failed", failureReason }` the same way.
 */

import type { StartFailure } from "./startFailure.js";

/** The agent ended in a failed outcome. `code` is the engine's closed failure reason, so the job runner reports it as is. */
export class AgentRunFailed extends Error {
  /** Set when the agent never started or ended before its first output (already redacted). Only the runner's local log reads it; the job's reported reason is `code`. */
  constructor(readonly code: string, readonly startFailure?: StartFailure, readonly firstLine?: string) {
    super(code);
    this.name = "AgentRunFailed";
  }
}

const REASON = /^[a-z][a-z0-9_]{0,63}$/;

/** The failure reason of an engine outcome (`{ status: "failed", failureReason }`), or `undefined` for a clean end or a runtime that settles with no outcome. */
export function failureOf(outcome: unknown): string | undefined {
  if (outcome === null || typeof outcome !== "object" || (outcome as { status?: unknown }).status !== "failed") return undefined;
  const reason = (outcome as { failureReason?: unknown }).failureReason;
  return typeof reason === "string" && REASON.test(reason) ? reason : "agent_exit";
}

/** The start-failure diagnostic of an engine outcome, when it carries a well-formed one. */
export function startFailureOf(outcome: unknown): StartFailure | undefined {
  const found = (outcome as { startFailure?: unknown } | null)?.startFailure;
  if (found === null || typeof found !== "object") return undefined;
  const cause = (found as { cause?: unknown }).cause;
  return cause === "spawn_failed" || cause === "exited_early" || cause === "signal" ? (found as StartFailure) : undefined;
}

const FIRST_LINE = /^[a-z_]{1,40}\/[a-z_]{1,40}$/;

/** The closed `type/subtype` words of the first line of a `no_init_line` outcome, when it carries a well-formed pair. */
export function firstLineOf(outcome: unknown): string | undefined {
  const found = (outcome as { firstLine?: unknown } | null)?.firstLine;
  return typeof found === "string" && FIRST_LINE.test(found) ? found : undefined;
}
