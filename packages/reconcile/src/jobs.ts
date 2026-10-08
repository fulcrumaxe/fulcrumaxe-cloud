import type { ReconcileJob } from './runner.js';
import { errorEventsPrune } from './jobs/errorEventsPrune.js';

/**
 * Every job, in the order a tick takes them. Each name needs a reconcile_jobs row seeded by a migration; a job with no
 * row is never due, so it is never run.
 */
export const RECONCILE_JOBS: readonly ReconcileJob[] = [errorEventsPrune];

/**
 * Every job for one tick: the fixed ones plus the jobs that need an outside client, which the route builds from its
 * environment. The order is the order a tick takes them.
 */
export function buildReconcileJobs(extra: {
  githubInstallations: ReconcileJob;
  githubRepos: ReconcileJob;
  stripeSubscriptions: ReconcileJob;
  modelKeyHealth: ReconcileJob;
  /** The sandbox reaper's jobs (they need the worker, so the route builds them); they follow the fixed jobs. */
  sandbox?: readonly ReconcileJob[];
}): readonly ReconcileJob[] {
  return [...RECONCILE_JOBS, ...(extra.sandbox ?? []), extra.githubInstallations, extra.githubRepos, extra.stripeSubscriptions, extra.modelKeyHealth];
}
