import type { Pool } from "pg";
import type { GateWake } from "@fx/worker";
import type { GithubWebhookPayload, GithubWebhookEventName } from "@fx/github";
import { getWorker, type AppWorker } from "./worker";
import { wakeGate1QueueEntry } from "./gate1QueueEntry";

/**
 * The webhook's wake for the merge gate. When the public pull request of a paired item opens, or a check of a pull request finishes green, an item that sits at
 * "Review passed" because its last gate answer was a stop that time clears (the pull request not open yet, the checks not finished) has the gate run again, by the
 * same workflow the person's "Check the merge" starts (packages/worker gateReask.ts holds every rule). Push, not poll: nothing here is timed.
 *
 * It reads only structured fields of the verified payload (numbers, a sha, enum strings, the repository's full name). A finished check that is not green, a
 * pull request closed or pushed to, and every other event start nothing: red stays where it is for a person or a fix round, and a moved head is a new review.
 */

const SHA = /^[0-9a-f]{40}$/;
const FULL_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const PR_OPENED = new Set(["opened", "reopened", "ready_for_review"]);

type Ci = { head_sha?: unknown; conclusion?: unknown; pull_requests?: unknown };

const asNumbers = (list: unknown): number[] =>
  Array.isArray(list) ? list.map((r) => (r as { number?: unknown } | null)?.number).filter((n): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0 && n < 2_000_000_000) : [];

/** What a delivery says about a pull request or a head that may now be ready, or null when it says nothing the gate waits for. Pure. */
export function readGateWake(eventName: string, payload: unknown): GateWake | null {
  const p = (typeof payload === "object" && payload !== null ? payload : {}) as {
    action?: unknown;
    state?: unknown;
    sha?: unknown;
    repository?: { full_name?: unknown };
    pull_request?: { number?: unknown; head?: { sha?: unknown } };
    check_run?: Ci;
    check_suite?: Ci;
  };
  const full = p.repository?.full_name;
  if (typeof full !== "string" || !FULL_NAME.test(full)) return null;
  const sha = (v: unknown): string | null => (typeof v === "string" && SHA.test(v) ? v : null);
  if (eventName === "pull_request") {
    // D#519 MQ4-e1-b: GitHub's merge queue took the pull request out (the item's own record of the cause decides whether anything starts).
    const dequeued = p.action === "dequeued";
    if (typeof p.action !== "string" || (!dequeued && !PR_OPENED.has(p.action))) return null;
    const numbers = asNumbers([p.pull_request]);
    return numbers.length === 1 ? { repoFullName: full, prNumbers: numbers, headSha: sha(p.pull_request?.head?.sha), ...(dequeued ? { dequeued: true } : {}) } : null;
  }
  if (eventName === "check_run" || eventName === "check_suite") {
    const ci = eventName === "check_run" ? p.check_run : p.check_suite;
    if (p.action !== "completed" || ci?.conclusion !== "success") return null;
    return { repoFullName: full, prNumbers: asNumbers(ci?.pull_requests), headSha: sha(ci?.head_sha) };
  }
  if (eventName === "status") return p.state === "success" ? { repoFullName: full, prNumbers: [], headSha: sha(p.sha) } : null;
  return null;
}

export interface GateReaskWakeDeps {
  worker?: Pick<AppWorker, "wakeMergeGate"> | null;
  /** D#6 CLOUD-POSTS-FX-GATE1 PR 1d: the queue entry's fx-gate1 (gate1QueueEntry.ts); injected in tests. */
  queueEntry?: (pool: Pool, event: { accountId: string; eventName: GithubWebhookEventName; payload: GithubWebhookPayload }) => Promise<unknown>;
}

/** The webhook's trigger: how many gates it started. The caller (the delivery) has already committed, and a throw here is logged there as a fixed line. */
export async function wakeGateReask(pool: Pool, event: { accountId: string; repoId: string; eventName: GithubWebhookEventName; payload: GithubWebhookPayload }, deps: GateReaskWakeDeps = {}): Promise<number> {
  // PR 1d: a finished check suite on a merge-queue entry commit also asks the cloud's fx-gate1 attester. Independent of the gate's wake: both run, then a failure of either is thrown.
  const [entry, gates] = await Promise.allSettled([(deps.queueEntry ?? wakeGate1QueueEntry)(pool, event), reask(event, deps)]);
  if (entry.status === "rejected") throw entry.reason;
  if (gates.status === "rejected") throw gates.reason;
  return gates.value;
}

async function reask(event: { accountId: string; repoId: string; eventName: GithubWebhookEventName; payload: GithubWebhookPayload }, deps: GateReaskWakeDeps): Promise<number> {
  const wake = readGateWake(event.eventName, event.payload);
  if (wake === null) return 0;
  const worker = deps.worker === undefined ? await getWorker() : deps.worker;
  if (!worker) return 0;
  return worker.wakeMergeGate({ accountId: event.accountId, repoId: event.repoId, wake });
}
