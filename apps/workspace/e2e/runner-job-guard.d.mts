/** Types for runner-job-guard.mjs. */
export const RUNNER_JOB_SKIP_REASON: string;
export function insideRunnerSandbox(env?: Record<string, string | undefined>): boolean;
export function skipInsideRunnerSandbox(
  env?: Record<string, string | undefined>,
  exit?: (code: number) => unknown,
  log?: (message: string) => void,
): boolean;
