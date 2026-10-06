import type { Pool } from "pg";
import type { ExecutionTargetRegistry } from "@fx/runner";
import { createRunActionFacade, type RunActionFacade } from "../../src/runActions.js";

/**
 * The real run-action facade over a caller-supplied run-writer pool and a fake registry, for
 * other packages' [pg] tests (packages/pipeline drives it through its structural port).
 * Test-only: the production path builds the facade inside createWorker. A pool given here
 * is the test's own login, never the runner login.
 */
export function realRunActionFacade(runWriterPool: Pool, registry: ExecutionTargetRegistry): RunActionFacade {
  return createRunActionFacade(runWriterPool, registry);
}
