import { claimBody, performBody, settleBody, type ClaimStepResult, type PerformStepResult, type SettleStepResult } from "@fx/pipeline";
import { getWorker } from "../lib/worker";

/**
 * D#2 H14c-3b: the directive wrapper. The Workflow builder compiles directives in the
 * app's own source only, so the durable steps live here and call the plain bodies in
 * @fx/pipeline. Arguments and results are JSON; a step gets the worker from getWorker().
 */
export async function claimStep(actionId: string): Promise<ClaimStepResult | null> {
  "use step";
  return claimBody(await getWorker(), actionId);
}

export async function performStep(claimed: ClaimStepResult): Promise<PerformStepResult> {
  "use step";
  return performBody(await getWorker(), claimed);
}

export async function settleStep(claimed: ClaimStepResult, outcome: PerformStepResult): Promise<SettleStepResult> {
  "use step";
  return settleBody(await getWorker(), claimed, outcome);
}

/** Pages of progress one workflow run claims in a row; then it ends and the sweep picks the action up. A workflow body cannot import a value from @fx/pipeline (the builder would bundle its node modules), so the limit lives here and a test pins it. */
const MAX_PAGES_PER_WORKFLOW = 20;

export async function runActionWorkflow(actionId: string): Promise<SettleStepResult | null> {
  "use workflow";
  let last: SettleStepResult | null = null;
  // A page of progress claims again at once; past the page limit the workflow ends and the sweep picks the action up.
  for (let page = 0; page < MAX_PAGES_PER_WORKFLOW; page += 1) {
    const claimed = await claimStep(actionId);
    if (!claimed) return last; // a duplicate kick: someone else holds the lease
    last = await settleStep(claimed, await performStep(claimed));
    if (!last.progress) return last;
  }
  return last;
}
