/**
 * D#6 R5b-1 (correction C38 section 1): the one list of execution modes whose agents run on the customer's runner. A site that means
 * "on a runner" (claim, job issue, done, the queue sweep, the notices, prompts and cards, the recorded pull request) reads this. A site
 * that means "local-only" keeps the `runner_local` literal: the GitHub fence, the admin-ok SQL, the local-review opt-in and the preview refusal.
 *
 * No imports, so any module of this package (the status writer included) can read it without a cycle.
 */
export const RUNNER_MODES = ["runner_local", "runner_verified"] as const;
export type RunnerMode = (typeof RUNNER_MODES)[number];

export const isRunnerMode = (mode: unknown): mode is RunnerMode => typeof mode === "string" && (RUNNER_MODES as readonly string[]).includes(mode);

/** `RUNNER_MODES` as a SQL list body (`'runner_local', 'runner_verified'`). Built from the constant above and never from input. */
export const RUNNER_MODES_SQL: string = RUNNER_MODES.map((mode) => `'${mode}'`).join(", ");
