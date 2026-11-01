import { SandboxPortError } from "./vercelSandboxPort.js";

/**
 * D#483 S5-k3b-2c: the provider has no room. A `createSandbox` that answered HTTP 429 (any `error.code`, or none), as the error itself or as the `cause` of a wrapper. This is the one
 * place that says what "capacity full" means for a create (C21); any other status keeps today's failure path and is never queued. It is its own file so `startAgentRun.ts`, which
 * may not import the sandbox port, can call it.
 */
export function providerCapacityOf(err: unknown): SandboxPortError | null {
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 3; e = (e as { cause?: unknown }).cause, depth += 1) {
    if (e instanceof SandboxPortError && e.operation === "createSandbox" && e.status === 429) return e;
  }
  return null;
}
