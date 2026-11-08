/**
 * One rule for every place a check run is read for a CI decision: a run that carries a conclusion AND a completion time has finished,
 * whatever its `status` still says. GitHub has answered `in_progress` for such a run for the better part of an hour, and every reader that
 * trusted the status alone waited on a check that was done. Every reader of check runs (the merge port's REST and fenced reads, the
 * Gate 1 attester's two reads, the queue-entry read) passes each run through `settleCheckRun`, and a test fails if one does not.
 */
export interface RawCheckRunState {
  status: string;
  conclusion: string | null;
  /** GitHub's completion time as text; absent or null when the run has not finished (or the read did not ask for it). */
  completedAt?: string | null;
}

/** The fixed telemetry line for an inconsistent run. No check name, no PR text. */
export const CHECK_RUN_INCONSISTENT_EVENT = "ci.check_run_inconsistent";

export function settleCheckRun(run: RawCheckRunState, log: (line: string) => void = (l) => console.info(l)): { status: string; conclusion: string | null } {
  const finished = run.conclusion !== null && typeof run.completedAt === "string" && run.completedAt.length > 0;
  if (finished && run.status !== "completed") {
    log(JSON.stringify({ event: CHECK_RUN_INCONSISTENT_EVENT }));
    return { status: "completed", conclusion: run.conclusion };
  }
  return { status: run.status, conclusion: run.conclusion };
}
