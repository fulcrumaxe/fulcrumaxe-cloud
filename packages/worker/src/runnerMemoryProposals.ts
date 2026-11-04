import type { Pool } from "pg";
import { ingestRunnerMemoryProposals, type RunnerMemoryInput, type RunnerMemoryResult } from "./memoryIntake.js";

/**
 * D#601 MEM-6: the worker's half of `POST /api/runner/memory-proposals`. One method; the runner login's pool is captured here and never exposed. The route has already
 * verified the signature and the proposals' hashes; everything about the run (owner, state, repository, item, role) is read from our rows by `ingestRunnerMemoryProposals`.
 */
export interface RunnerMemoryProposalsFacade {
  memoryProposals(input: Omit<RunnerMemoryInput, "pool" | "liveSecrets">): Promise<RunnerMemoryResult>;
}

export function createRunnerMemoryProposalsFacade(runnerPool: Pool): RunnerMemoryProposalsFacade {
  return { memoryProposals: (input) => ingestRunnerMemoryProposals({ ...input, pool: runnerPool }) };
}
