/**
 * How an agent run's outcome becomes the job's failure, shared by every engine behind `SandboxPort` (the host sandbox and the microVM one), so the
 * two read an engine's `{ status: "failed", failureReason }` the same way.
 */

/** The agent ended in a failed outcome. `code` is the engine's closed failure reason, so the job runner reports it as is. */
export class AgentRunFailed extends Error {
  constructor(readonly code: string) {
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
