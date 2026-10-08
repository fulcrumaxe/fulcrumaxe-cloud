import type { NetworkContext, NetworkFragment } from "@fx/env-network";
import type { Plan } from "@fx/env-build";

/**
 * Every effect `ensureEnvironment` and `replay` have is one of these ports; this package opens no file, socket
 * or database. The caller binds them to a tenant-scoped connection, the GitHub proxy and the builder.
 */

/** The budgets a build draws on (the ledger's names, D#5 OD-7). */
export type BuildBudget = "foreground_compute" | "background_compute" | "emergency";

/** The run an environment is being resolved for. */
export interface RunCtx {
  readonly accountId: string;
  readonly repoId: string;
  /** The commit the run checks out. Every repo read is at this commit, never at a branch tip. */
  readonly commitSha: string;
  /** The budget a build for this run would draw on. */
  readonly budget: BuildBudget;
}

/** The path every repo's environment lives at. */
export const ENV_FILE = ".fulcrumaxe/env.yaml";

export interface VersionRecord {
  readonly envVersionId: string;
  readonly builtImageDigest: string;
  readonly baseImageDigest: string;
  readonly canonicalSpec: string;
}

export interface NewVersion extends VersionRecord {
  readonly source: "repo" | "proposal";
}

/** The environment tables, for one tenant (RLS does the scoping; no account id travels in the calls). */
export interface EnvStore {
  getVersion(repoId: string, envVersionId: string): Promise<VersionRecord | null>;
  /** Insert-only. A repeat of (repo, version) rejects with a unique violation, which the caller reads as a cache hit. */
  insertVersion(repoId: string, v: NewVersion): Promise<void>;
  startBuild(envVersionId: string, budget: BuildBudget): Promise<{ id: string }>;
  /** A build closes once; closing a closed build changes nothing. */
  finishBuild(
    buildId: string,
    outcome: { status: "succeeded" | "failed" | "killed"; failingStep?: string; logRef?: string; costUsd: number },
  ): Promise<void>;
}

/** The C12 dollar reservation, taken before the build sandbox is created. `reservedUsd` is the amount held. */
export type Reservation =
  | { readonly ok: true; readonly id: string; readonly reservedUsd: number }
  | { readonly ok: false; readonly reason: string };

/** What the builder reports. `step` names where it stopped; `costUsd` is what the build used. */
export type BuildOutcome =
  | { readonly ok: true; readonly builtImageDigest: string; readonly costUsd: number; readonly logRef?: string }
  | { readonly ok: false; readonly status: "failed" | "killed"; readonly step: string; readonly costUsd: number; readonly logRef?: string };

export interface EnsurePorts {
  /** The file's text at the run's commit, or null when it is not there. */
  readRepoFile(ctx: RunCtx, path: string): Promise<string | null>;
  /** The stored proposal's YAML for this repo, or null. Read only when the repo has no file at the commit (C15). */
  readProposal(ctx: RunCtx): Promise<string | null>;
  /** Platform facts for the egress fragment: never customer input. */
  networkContext(ctx: RunCtx): NetworkContext;
  store: EnvStore;
  reserve(ctx: RunCtx, buildId: string): Promise<Reservation>;
  /** Builds the plan's image in the builder sandbox, under the reservation. */
  build(ctx: RunCtx, plan: Plan, reservation: { id: string }): Promise<BuildOutcome>;
  /** Hands back what the build did not use. Called on every path after a reservation was taken. */
  settle(reservationId: string, costUsd: number): Promise<void>;
}

/** The sandbox for the run phase. `persistent` is the literal `false`: nothing here can ask for another value (C1). */
export interface RunSandboxRequest {
  readonly imageDigest: string;
  readonly persistent: false;
  readonly network: NetworkFragment;
}

export interface RunSandboxPort {
  create(request: RunSandboxRequest): Promise<{ readonly sandboxName: string }>;
}
