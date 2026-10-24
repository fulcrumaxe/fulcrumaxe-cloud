import { spawnSync } from "node:child_process";
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

/** True when a fresh python3 cannot create an AF_UNIX socket. */
export const pythonCannotMakeUnixSocket = (): boolean => spawnSync("python3", ["-I", "-c", "import socket; socket.socket(socket.AF_UNIX)"]).status !== 0;

/**
 * Whether a suite that listens on a Unix socket must skip. Both must hold: a sandbox marker (`FX_RUNNER_CHECK=1` in the runner's check, or
 * `FX_RUNNER_JOB=1` in an agent job; both sandboxes refuse every socket family but a connected pair), and a socket that really cannot be made.
 * The probe runs only when a marker is set, so a developer host or CI never skips.
 */
export function unixSocketsRefused(env: NodeJS.ProcessEnv = process.env, probe: () => boolean = pythonCannotMakeUnixSocket): boolean {
  return (env.FX_RUNNER_CHECK === "1" || inRunnerJob(env)) && probe();
}
