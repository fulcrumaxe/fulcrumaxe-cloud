import type { ReconcileJob } from './runner.js';
import { errorEventsPrune } from './jobs/errorEventsPrune.js';
import { memorySweep } from './jobs/memorySweep.js';
import { engineEventsPrune } from './jobs/engineEventsPrune.js';
import { machinePrune } from './jobs/machinePrune.js';
import { onboardingPrune } from './jobs/onboardingPrune.js';
import { stateCarrySweep } from './jobs/stateCarrySweep.js';

/**
 * Every job, in the order a tick takes them. Each name needs a reconcile_jobs row seeded by a migration; a job with no
 * row is never due, so it is never run.
 */
export const RECONCILE_JOBS: readonly ReconcileJob[] = [errorEventsPrune, memorySweep, engineEventsPrune, machinePrune, onboardingPrune, stateCarrySweep];

/**
 * Every job for one tick: the fixed ones plus the jobs that need an outside client, which the route builds from its
 * environment. The order is the order a tick takes them.
 */
export function buildReconcileJobs(extra: {
  githubInstallations: ReconcileJob;
  githubRepos: ReconcileJob;
  stripeSubscriptions: ReconcileJob;
  modelKeyHealth: ReconcileJob;
  /** D#483 S5-k2: re-validates connections broken for out-of-credit, every 15 minutes. */
  modelCreditsRevalidate: ReconcileJob;
  /** The sandbox reaper's jobs (they need the worker, so the route builds them); they follow the fixed jobs. */
  sandbox?: readonly ReconcileJob[];
  /** D#845 MC-7: the Hetzner server sweep (it needs a way to start a queued job, so the route builds it). */
  machine?: readonly ReconcileJob[];
  /** D#845 ON-8f2a: the install pull request step (it needs the GitHub port and the app database, so the route builds it). */
  setupInstall?: ReconcileJob;
  /** D#845 ON-13a4: the finish phase (Discussions and the team-log issue; it needs the GitHub port and the app database, so the route builds it). */
  setupFinish?: ReconcileJob;
  /** D#845 ON-13c1: the system first start. It follows the finish phase, so a setup that finishes on a tick is started on the same tick. */
  engineStarts?: ReconcileJob;
}): readonly ReconcileJob[] {
  return [...RECONCILE_JOBS, ...(extra.sandbox ?? []), ...(extra.machine ?? []), ...(extra.setupInstall ? [extra.setupInstall] : []), ...(extra.setupFinish ? [extra.setupFinish] : []), ...(extra.engineStarts ? [extra.engineStarts] : []), extra.githubInstallations, extra.githubRepos, extra.stripeSubscriptions, extra.modelKeyHealth, extra.modelCreditsRevalidate];
}
