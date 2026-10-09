import { it } from "vitest";

/**
 * The runner sets `FX_RUNNER_JOB=1` in the environment of every job it starts (the job-env marker). Inside such a job the
 * sandbox's seccomp filter refuses socket(AF_UNIX), so a test that has to listen on a Unix socket (the tmux socket stand-in
 * of the watch and attach tests) cannot run there. It is not weakened to fit: it skips inside a runner job and still runs
 * on a developer host and in CI, where the marker is not set.
 */
export const inRunnerJob = (env: NodeJS.ProcessEnv = process.env): boolean => env.FX_RUNNER_JOB === "1";

/** `it`, for a test that needs host Unix sockets: skipped inside an fx-runner job, run everywhere else. */
export function itNeedsHostSockets(name: string, fn: () => unknown, timeout?: number): void {
  (inRunnerJob() ? it.skip : it)(name, fn as () => Promise<void> | void, timeout);
}
