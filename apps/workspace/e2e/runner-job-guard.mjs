// apps/workspace/e2e/runner-job-guard.mjs
//
// The real-browser e2e cannot be relied on inside the runner's sandbox. The runner marks every agent job with
// FX_RUNNER_JOB=1 and its repo check with FX_RUNNER_CHECK=1. A reviewer who started `playwright test` from its own shell
// in a job waited out its whole time cap with both fixture servers up, the test runner idle and no browser process, and
// nothing failed or skipped. A suite that can hang must not be left to hang, so inside a marked process the run ends
// at once with the reason printed; the staging verify stage covers the real browser after deploy.
//
// A developer host and CI never set the markers, so the suite runs there exactly as before.

/** The one sentence printed when the guard fires. */
export const RUNNER_JOB_SKIP_REASON =
  "[skip] real-browser e2e cannot run inside the runner's sandbox; the staging verify stage covers it";

/** True when the process runs inside a runner job or the runner's check. Only the value "1" counts, like the runner's own tests. */
export function insideRunnerSandbox(env = process.env) {
  return env.FX_RUNNER_JOB === "1" || env.FX_RUNNER_CHECK === "1";
}

/**
 * Call first in a Playwright config. Inside a runner job or check it prints the reason and ends the process with exit 0
 * (a named skip) before any fixture server starts; elsewhere it does nothing. `exit` is injectable for the tests.
 */
export function skipInsideRunnerSandbox(env = process.env, exit = process.exit, log = console.info) {
  if (!insideRunnerSandbox(env)) return false;
  log(RUNNER_JOB_SKIP_REASON);
  exit(0);
  return true;
}
