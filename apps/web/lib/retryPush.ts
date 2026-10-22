import { start } from "workflow/api";
import { retryPushWorkflow, type RetryPushArgs } from "../workflows/retryPush";
import { getWorker } from "./worker";

/**
 * D#598 P1f-6b: the `startRetryPush` port of the work-item action route. Same shape as `createStartAdvance`: the Workflow start is injectable so a test needs no
 * service, and a start that is refused rejects (the route then answers 503 and no attempt was made).
 */
export function createStartRetryPush(deps: { start: (workflow: typeof retryPushWorkflow, args: [RetryPushArgs]) => Promise<unknown> } = { start }): (args: { accountId: string; userId: string; workItemId: string }) => Promise<void> {
  return async ({ accountId, workItemId }) => {
    await deps.start(retryPushWorkflow, [{ accountId, workItemId }]);
  };
}

type OpenResult = { kind: "opened"; prNumber: number } | { kind: "refused"; code: string } | { kind: "skipped" } | { kind: "not_configured" };

/** The `openPublicPullRequest` port: the worker's own call, or `not_configured` when no worker can be built. */
export async function openPublicPullRequestViaWorker(args: { accountId: string; workItemId: string }): Promise<OpenResult> {
  const worker = await getWorker();
  if (worker === null) return { kind: "not_configured" };
  const r = await worker.openPublicPullRequest(args);
  if (r.kind === "opened") return { kind: "opened", prNumber: r.prNumber };
  if (r.kind === "refused") return { kind: "refused", code: r.code };
  return { kind: r.kind === "skipped" ? "skipped" : "not_configured" };
}
