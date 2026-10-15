import { createHash } from "node:crypto";
import { COPY } from "@fulcrumaxe/runner-protocol";
import { isRunnerMode } from "./runnerModes.js";

/**
 * D#599 PL-2: where an item's runs go. The item's `placement` (`cloud` or `runner`, 0781) wins; an item without one follows its repository
 * (`repos.execution_mode`); a repository without a mode is the cloud. The runner flavour (local or verified) always comes from the repo, so
 * an item can never pick the cloud-verified mode on its own, and `runner` on a repo that is on the cloud means `runner_local`.
 *
 * Placement is a routing input and never a permission. This answers WHERE a run goes; it lets nobody start a run they could not start
 * before, and every run creation re-checks its own guards for the mode this returns (`ExecutionTarget.precheck`, `startAgentRun`).
 */
export function effectiveExecutionMode(placement: string | null | undefined, repoMode: string | null | undefined): string {
  const repo = repoMode ?? "sandbox";
  if (placement === null || placement === undefined) return repo;
  if (placement === "cloud") return "sandbox";
  if (placement === "runner") return isRunnerMode(repo) ? repo : "runner_local";
  // The column's CHECK admits nothing else; a value that got past it must not route anywhere.
  throw new Error("effective execution mode: unknown placement");
}

/**
 * The same resolution as `effectiveExecutionMode`, as a SQL expression over the two table aliases of a query that has joined an item and its
 * repository. Built from fixed words and the aliases the caller names (identifiers it wrote, never input). A unit test holds the two in step.
 */
export function effectiveModeSql(item: string, repo: string): string {
  return (
    `(CASE ${item}.placement WHEN 'cloud' THEN 'sandbox' ` +
    `WHEN 'runner' THEN (CASE WHEN ${repo}.execution_mode IN ('runner_local', 'runner_verified') THEN ${repo}.execution_mode ELSE 'runner_local' END) ` +
    `ELSE COALESCE(${repo}.execution_mode, 'sandbox') END)`
  );
}

/** Which side of the line a mode is on: our sandbox, or the customer's runner. A cross-side fix round cannot resume the other side's session. */
export type Side = "cloud" | "runner";
export const sideOfMode = (mode: string | null | undefined): Side => (isRunnerMode(mode) ? "runner" : "cloud");

/**
 * The sha256 of the cloud-verified wording this server ships. A person who opts a repo into `runner_verified` sends it back to show they
 * saw that wording; the repo stores it, and a run in that mode starts only while the stored hash is still the current one (D#599 PL-2).
 */
export const CLOUD_VERIFIED_COPY_SHA256 = createHash("sha256").update(COPY.cloudVerified, "utf8").digest("hex");
