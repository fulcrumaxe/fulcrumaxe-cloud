import type { PoolClient } from "pg";
import { DEQUEUE_SUCCESS_CODES, dequeueReasonCode } from "@fx/core/src/work-items/driverEvents.js";
import { requeueCiStopped, settleHostDequeue, settlePullRequest } from "./store.js";

/**
 * D#519 MQ3-b: what a verified GitHub webhook delivery does to a repo's merge queue. Reads only structured fields (numbers, shas, enum
 * strings), never text a person wrote. It writes nothing for an event that cannot change what the queue should do, and it is
 * idempotent: a replayed delivery finds the entries already settled or already requeued and changes nothing.
 *
 *  - `pull_request` closed: the entry is settled (merged by a person, or closed), so its dependants become eligible or stop, and a
 *    slot it held is freed. A merge by the gate itself finds the entry already merged and does nothing.
 *  - `pull_request` dequeued (D#694 B6-2): the host's queue removed the pull request. An entry waiting there for that head stops (its slot is released) unless the
 *    reason is the queue's own success (the merge's `closed` settles that). A head the item has moved on from, a final entry and a replay change nothing.
 *  - `check_run` / `check_suite` completed, `status` not pending: a `ci_not_green` entry on that pull request or head returns to the
 *    queue at its original place. Every other stop stays a stop.
 *  - `pull_request` pushed to, edited, reopened, drafted; a push to any branch: nothing is written, but the queue is worth a tick.
 *
 * Answers whether the repo has a live entry, i.e. whether the sweep should be told there is work.
 */

export interface QueueEvent {
  eventName: string;
  payload: unknown;
}

const PR_ACTIONS = new Set(["synchronize", "closed", "edited", "reopened", "ready_for_review", "converted_to_draft", "dequeued"]);
const SHA = /^[0-9a-f]{40}$/;

type Ci = { head_sha?: unknown; pull_requests?: unknown };

export async function applyQueueEvent(client: PoolClient, input: { accountId: string; repoId: string } & QueueEvent): Promise<boolean> {
  const { accountId, repoId, eventName } = input;
  const p = (typeof input.payload === "object" && input.payload !== null ? input.payload : {}) as { action?: unknown; state?: unknown; sha?: unknown; reason?: unknown; pull_request?: { number?: unknown; merged?: unknown; head?: { sha?: unknown } }; check_run?: Ci; check_suite?: Ci };
  const ciDone = ((eventName === "check_run" || eventName === "check_suite") && p.action === "completed") || (eventName === "status" && typeof p.state === "string" && p.state !== "pending");
  const prNumber = p.pull_request?.number;
  const closed = eventName === "pull_request" && p.action === "closed" && typeof prNumber === "number" && Number.isSafeInteger(prNumber) && prNumber > 0;
  const dequeuedHead = p.pull_request?.head?.sha;
  const dequeued = eventName === "pull_request" && p.action === "dequeued" && typeof prNumber === "number" && Number.isSafeInteger(prNumber) && prNumber > 0 && typeof dequeuedHead === "string" && SHA.test(dequeuedHead);
  const relevant = ciDone || closed || eventName === "push" || (eventName === "pull_request" && typeof p.action === "string" && PR_ACTIONS.has(p.action));
  if (!relevant) return false;

  if (closed) await settlePullRequest(client, { accountId, repoId, prNumber: prNumber as number, merged: p.pull_request?.merged === true });
  if (dequeued && !DEQUEUE_SUCCESS_CODES.includes(dequeueReasonCode(p.reason))) {
    await settleHostDequeue(client, { accountId, repoId, prNumber: prNumber as number, headSha: dequeuedHead as string });
  }
  if (ciDone) {
    const ci = p.check_run ?? p.check_suite;
    const sha = ci?.head_sha ?? p.sha;
    const prs = Array.isArray(ci?.pull_requests) ? (ci.pull_requests as Array<{ number?: unknown }>) : [];
    await requeueCiStopped(client, {
      accountId,
      repoId,
      prNumbers: prs.map((r) => r.number).filter((n): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0),
      ...(typeof sha === "string" && SHA.test(sha) ? { headSha: sha } : {}),
    });
  }
  const { rows } = await client.query(`SELECT 1 FROM merge_queue_entries WHERE account_id = $1 AND repo_id = $2 AND state IN ('queued', 'in_flight', 'awaiting_work') LIMIT 1`, [accountId, repoId]);
  return rows.length > 0;
}
