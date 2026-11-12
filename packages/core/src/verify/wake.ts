import { markWorkPending } from '../pendingWork.js';

/** The one run role whose end the verify stage waits on: the post-merge tester (packages/runner-protocol deployVerifier.ts DEPLOY_VERIFIER_ROLE). */
export const VERIFY_TESTER_ROLE = 'deploy-verifier';

/**
 * D#749: the three points where the verify stage has something new to read (Verify again, a deploy-order report, a finished tester run) wake it the same way: the
 * proposal-verify sweep's marker is set AND the sweep is kicked (a signed request to its own route, see packages/webhooks verifyKick.ts), so the stage advances within
 * seconds instead of at the next 15-minute tick. Fire and forget: it never throws, never waits on the store or the kick, and a lost kick or marker costs only the wait
 * for the cron (the rows are the truth). Without hooks installed (a test, a build step) it does nothing.
 */
export function wakeVerifyStage(): void {
  void markWorkPending('proposal-verify-sweep', { kick: true });
}

/** True for the run status moves that end a run. */
export function isTerminalRunStatus(status: string): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'timed_out' || status === 'killed_spend' || status === 'cancelled' || status === 'refused_spend';
}
