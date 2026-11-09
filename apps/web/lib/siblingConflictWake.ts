import type { Pool } from "pg";
import type { GithubWebhookPayload, GithubWebhookEventName } from "@fx/github";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { reportError } from "@fx/telemetry";
import { getWorker, type AppWorker } from "./worker";
import { openInstallationHttp } from "./github/installationHttp";
import { openForRepo } from "./github/localOnlyHttp";

/**
 * The webhook's wake for pull requests that a merge left conflicting. When a pull request merges into the repository's default branch, the other open pull requests
 * of that repository that have already reached the merge gate and are not being worked on are looked at once: GitHub is asked whether each still merges cleanly, and
 * only one it now calls conflicting has its review workflow started, which makes the gate answer `merge_conflict` and starts the conflict fix round. Every rule about
 * which items and how often is in packages/worker siblingConflictWake.ts; this file reads the delivery and holds the one GitHub read.
 *
 * It reads only structured fields (numbers, a state word, booleans, the repository's full name). It never reads a title, a body or a label.
 */

const FULL_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const MAX_PR = 2_000_000_000;

export interface MergedSibling {
  repoFullName: string;
  prNumber: number;
}

/** What a delivery says merged, or null. Only a pull request that merged into the repository's default branch can leave another one conflicting with its base. Pure. */
export function readSiblingMerge(eventName: string, payload: unknown): MergedSibling | null {
  if (eventName !== "pull_request") return null;
  const p = (typeof payload === "object" && payload !== null ? payload : {}) as {
    action?: unknown;
    repository?: { full_name?: unknown; default_branch?: unknown };
    pull_request?: { number?: unknown; merged?: unknown; base?: { ref?: unknown } };
  };
  if (p.action !== "closed" || p.pull_request?.merged !== true) return null;
  const full = p.repository?.full_name;
  const number = p.pull_request?.number;
  if (typeof full !== "string" || !FULL_NAME.test(full)) return null;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1 || number > MAX_PR) return null;
  const base = p.pull_request?.base?.ref;
  const main = p.repository?.default_branch;
  // A merge into another branch (a stacked pull request's parent) does not move the branch the others merge into.
  // Fail closed: a delivery that does not name both is not known to be a merge into the default branch.
  if (typeof base !== "string" || typeof main !== "string" || base === "" || base !== main) return null;
  return { repoFullName: full, prNumber: number };
}

export interface PullReadHttp {
  request(req: { method: "GET"; path: string }): Promise<{ status: number; body: unknown }>;
}

export interface ConflictReadOptions {
  /** Reads while GitHub is still computing `mergeable` (it answers `null` at first, soon after a merge). */
  reads?: number;
  gapMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Whether GitHub now says this open pull request does not merge cleanly. True: `mergeable` is false or the state is `dirty`. False: it merges. Null: it cannot say (still
 * computing after the bounded reads, not open or already merged, not found, or a response of the wrong shape): the caller leaves the item alone. A non-2xx answer is a throw, so
 * a failed read is never taken for "clean" or for "conflicting".
 */
export async function readPullConflicting(http: PullReadHttp, repo: { owner: string; name: string }, prNumber: number, options: ConflictReadOptions = {}): Promise<boolean | null> {
  const reads = Math.max(1, options.reads ?? 3);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let i = 0; i < reads; i++) {
    const res = await http.request({ method: "GET", path: `/repos/${repo.owner}/${repo.name}/pulls/${prNumber}` });
    if (res.status === 404) return null;
    if (res.status !== 200) throw new Error(`sibling conflict read: GitHub answered ${res.status}`);
    const body = res.body as { state?: unknown; merged?: unknown; mergeable?: unknown; mergeable_state?: unknown } | null;
    if (typeof body !== "object" || body === null || (body.state !== "open" && body.state !== "closed")) return null;
    if (body.state !== "open" || body.merged === true) return null;
    if (body.mergeable === false || body.mergeable_state === "dirty") return true;
    if (body.mergeable === true) return false;
    if (body.mergeable !== null) return null;
    if (i + 1 < reads) await sleep(options.gapMs ?? 1500);
  }
  return null;
}

export interface SiblingWakeDeps {
  worker?: Pick<AppWorker, "wakeConflictingSiblings"> | null;
  /** The GitHub read for one pull request of the delivery's repository. Absent: the installation's `read` client. */
  readConflicting?: (pool: Pool, target: { accountId: string; repoId: string }, prNumber: number) => Promise<boolean | null>;
}

async function readWithInstallation(pool: Pool, target: { accountId: string; repoId: string }, prNumber: number): Promise<boolean | null> {
  const repo = await withTenant(pool, target.accountId, async (c) =>
    (await c.query<{ gh_owner: string | null; gh_name: string | null; execution_mode: string }>("SELECT gh_owner, gh_name, execution_mode FROM repos WHERE account_id = $1 AND id = $2", [target.accountId, target.repoId])).rows[0],
  );
  // A repository the cloud does not read (no owner and name, or `runner_local`, whose list reads carry no mergeability) is left to the gate.
  if (!repo?.gh_owner || !repo.gh_name || repo.execution_mode === "runner_local") return null;
  const http = (await openForRepo(openInstallationHttp, repo.execution_mode, "read", { repoId: target.repoId, owner: repo.gh_owner, name: repo.gh_name })) as PullReadHttp;
  return readPullConflicting(http, { owner: repo.gh_owner, name: repo.gh_name }, prNumber);
}

/** The webhook's trigger: how many review workflows it started. The delivery has already committed, and a throw is logged by the caller as a fixed line. */
export async function wakeSiblingConflicts(pool: Pool, event: { accountId: string; repoId: string; eventName: GithubWebhookEventName; payload: GithubWebhookPayload }, deps: SiblingWakeDeps = {}): Promise<number> {
  const merged = readSiblingMerge(event.eventName, event.payload);
  if (merged === null) return 0;
  const worker = deps.worker === undefined ? await getWorker() : deps.worker;
  if (!worker) return 0;
  const read = deps.readConflicting ?? readWithInstallation;
  try {
    return await worker.wakeConflictingSiblings({
      accountId: event.accountId,
      repoId: event.repoId,
      merged,
      isConflicting: (prNumber) => read(pool, { accountId: event.accountId, repoId: event.repoId }, prNumber),
    });
  } catch (err) {
    reportError(err, { stage: "advance.sibling_conflict_wake" });
    throw err;
  }
}
