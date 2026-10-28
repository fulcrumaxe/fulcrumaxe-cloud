import { getWorker } from "../lib/worker";

/**
 * D#598 P1f-6b: "Try the push again", as a durable job so the 30-second request that pressed the button is not held for a publish sandbox. One step, which
 * calls the worker's `retryPublish`: it re-reads the pairing, refuses `pairing_off` or `retry_limit` as stored codes, or makes the next attempt. The outcome is
 * recorded on the item's push row (the page reads it on its next activity read); this returns only a fixed kind for the log. Arguments are plain ids.
 */
export interface RetryPushArgs {
  accountId: string;
  workItemId: string;
}

export async function retryPushStep(accountId: string, workItemId: string): Promise<{ kind: string; code: string | null; reason?: string }> {
  "use step";
  const worker = await getWorker();
  if (worker === null) return { kind: "not_configured", code: null };
  const result = await worker.retryPublish({ accountId, workItemId });
  const outcome = { kind: result.kind, code: result.kind === "refused" ? result.code : null, ...(result.kind === "refused" && result.reason !== undefined ? { reason: result.reason } : {}) };
  console.info(JSON.stringify({ event: "plane.retry_push", account_id: accountId, work_item_id: workItemId, ...outcome }));
  return outcome;
}

export async function retryPushWorkflow(args: RetryPushArgs): Promise<{ kind: string; code: string | null; reason?: string }> {
  "use workflow";
  return retryPushStep(args.accountId, args.workItemId);
}
