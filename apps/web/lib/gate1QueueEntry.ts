import type { Pool } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { attestGate1Head, attestQueueEntry, listQueueEntryCandidates, loadReviewContext, parseGate1AttestRepos, type GitHubHttp, type QueueEntryOutcome } from "@fx/pipeline";
import { MERGE_QUEUE_ENTRY_DOCUMENT, type GithubWebhookEventName, type GithubWebhookPayload } from "@fx/github";
import { reportError } from "@fx/telemetry";
import { openInstallationHttp, readRepoAppLogin } from "./github/installationHttp";
import { openForRepo } from "./github/localOnlyHttp";

/**
 * D#6 CLOUD-POSTS-FX-GATE1 PR 1d: the wake for a merge-queue entry commit's `fx-gate1`. GitHub Actions finishing a check suite on a `gh-readonly-queue/<base>/pr-<n>-<sha>`
 * branch of a code repository listed in `FX_GATE1_ATTEST_REPOS` asks the attester (packages/pipeline gate1QueueEntry.ts) about that commit. Push, not poll: one
 * attempt per finished suite, no timer and no cron; a wait posts nothing and the next suite asks again. The branch's trailing sha is the entry's BASE commit
 * (GitHub builds the entry on the base branch's tip or on the entry ahead), never the pull request's head; the attester takes the head from the queue.
 *
 * It reads only structured fields of the verified payload: the action, the suite's app id, its head sha and head branch, the repository's full name. The item is
 * found by OUR record of the public pull request (`plane_pushes`), never by anything the branch or a pull request says about itself beyond its number.
 */
const SHA = /^[0-9a-f]{40}$/;
const FULL_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const QUEUE_BRANCH = /^gh-readonly-queue\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/pr-([1-9][0-9]{0,9})-([0-9a-f]{40})$/;
const ACTIONS_APP_ID = 15368;

export interface QueueEntryWake {
  repoFullName: string;
  base: string;
  prNumber: number;
  /** The entry's base commit, as the branch name gives it. */
  baseSha: string;
  entrySha: string;
}

/** What a delivery says about a queue entry commit, or null. Pure. Only a completed GitHub Actions check suite on a queue branch counts, whatever its conclusion. */
export function readQueueEntryWake(eventName: string, payload: unknown): QueueEntryWake | null {
  if (eventName !== "check_suite") return null;
  const p = (typeof payload === "object" && payload !== null ? payload : {}) as { action?: unknown; repository?: { full_name?: unknown }; check_suite?: { head_sha?: unknown; head_branch?: unknown; app?: { id?: unknown } } };
  const full = p.repository?.full_name;
  const suite = p.check_suite;
  if (p.action !== "completed" || typeof full !== "string" || !FULL_NAME.test(full) || suite?.app?.id !== ACTIONS_APP_ID) return null;
  if (typeof suite.head_sha !== "string" || !SHA.test(suite.head_sha) || typeof suite.head_branch !== "string") return null;
  const m = QUEUE_BRANCH.exec(suite.head_branch);
  if (m === null || m[1]!.includes("..")) return null;
  const prNumber = Number(m[2]);
  if (!Number.isSafeInteger(prNumber) || prNumber >= 2_000_000_000) return null;
  return { repoFullName: full, base: m[1]!, prNumber, baseSha: m[3]!, entrySha: suite.head_sha };
}

export interface Gate1QueueEntryDeps {
  open?: typeof openInstallationHttp;
  repos?: ReadonlySet<string>;
  ourLogin?: (repoId: string) => Promise<string>;
}

/**
 * The one item that owns a public pull request, or null. Every record naming this public pull request is counted first, person-managed ones included: a
 * person-managed match, or two items naming one pull request, is not ours to resolve, and nothing is attested. `head` is the head the platform stamped.
 */
async function ownItem(pool: Pool, accountId: string, repoFullName: string, prNumber: number): Promise<{ workItemId: string; head: string | null } | null> {
  return withTenant(pool, accountId, async (client) => {
    const { rows } = await client.query<{ work_item_id: string; managed: boolean; head_sha: string | null }>(
      "SELECT DISTINCT work_item_id, (managed_by_person_at IS NOT NULL) AS managed, head_sha FROM plane_pushes WHERE account_id = $1 AND lower(code_repo) = lower($2) AND pr_number = $3 LIMIT 3",
      [accountId, repoFullName, prNumber],
    );
    if (rows.some((r) => r.managed !== false)) return null;
    return rows.length === 1 ? { workItemId: rows[0]!.work_item_id, head: rows[0]!.head_sha } : null;
  });
}

/** The webhook's trigger. Answers what the attester did, or null when the delivery is not for a listed code repository's queue entry of one of our items. */
export async function wakeGate1QueueEntry(pool: Pool, event: { accountId: string; eventName: GithubWebhookEventName | string; payload: GithubWebhookPayload | unknown }, deps: Gate1QueueEntryDeps = {}): Promise<QueueEntryOutcome | null> {
  const wake = readQueueEntryWake(event.eventName, event.payload);
  if (wake === null) {
    // A pull request leaving the queue: the entries behind it are asked again (no check suite is left to wake them). Answers nothing itself.
    const exit = readQueueExit(event.eventName, event.payload);
    if (exit !== null) await recheckAfterExit(pool, event.accountId, exit, deps);
    return null;
  }
  return attestWake(pool, event.accountId, wake, deps, null);
}

/** At most this many entries behind a departed pull request are asked again per event. */
export const MAX_EXIT_RECHECKS = 10;

export interface QueueExit {
  repoFullName: string;
  base: string;
  /** The pull request that left (merged, dequeued or closed). */
  prNumber: number;
}

/** What a delivery says about a pull request leaving the merge queue, or null. Pure. `dequeued`, and `closed` (merged or not: a closed pull request is out of the queue too). */
export function readQueueExit(eventName: string, payload: unknown): QueueExit | null {
  if (eventName !== "pull_request") return null;
  const p = (typeof payload === "object" && payload !== null ? payload : {}) as { action?: unknown; repository?: { full_name?: unknown }; pull_request?: { number?: unknown; base?: { ref?: unknown } } };
  if (p.action !== "closed" && p.action !== "dequeued") return null;
  const full = p.repository?.full_name;
  const base = p.pull_request?.base?.ref;
  const n = p.pull_request?.number;
  if (typeof full !== "string" || !FULL_NAME.test(full) || typeof base !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(base) || base.includes("..")) return null;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1 || n >= 2_000_000_000) return null;
  return { repoFullName: full, base, prNumber: n };
}

/**
 * Asks the attester again for the entries still queued on the base branch, front first, capped. The queue is read through the same client the attester uses
 * (opened for any one of our items in that repository); each candidate then goes through the unchanged per-entry path (our record, the attester's own
 * `already` check, `decideQueueEntry`), so a replayed or concurrent exit posts nothing a first one did not, and a group with a head that is not ours still waits.
 */
async function recheckAfterExit(pool: Pool, accountId: string, exit: QueueExit, deps: Gate1QueueEntryDeps): Promise<void> {
  const repos = deps.repos ?? parseGate1AttestRepos(process.env.FX_GATE1_ATTEST_REPOS);
  if (!repos.has(exit.repoFullName.toLowerCase())) return;
  const anyItem = await withTenant(pool, accountId, async (client) => {
    const { rows } = await client.query<{ work_item_id: string }>(
      "SELECT work_item_id FROM plane_pushes WHERE account_id = $1 AND lower(code_repo) = lower($2) AND pr_number IS NOT NULL AND managed_by_person_at IS NULL ORDER BY work_item_id LIMIT 1",
      [accountId, exit.repoFullName],
    );
    return rows[0]?.work_item_id ?? null;
  });
  if (anyItem === null) return;
  const loaded = await loadReviewContext(pool, accountId, anyItem);
  if (!loaded.ok) {
    console.info(JSON.stringify({ event: "gate1_queue_entry", trigger: "queue_exit", exited_pr: exit.prNumber, work_item_id: anyItem, outcome: "skipped", reason: "context_unloadable" }));
    return;
  }
  const [owner, name] = exit.repoFullName.split("/") as [string, string];
  const http: GitHubHttp = await openForRepo(deps.open ?? openInstallationHttp, loaded.ctx.executionMode, "merge_gate", { repoId: loaded.ctx.repoId, owner, name }, { withoutMerge: true, gate1Attest: true });
  const seen = new Set<number>([exit.prNumber]);
  const candidates = (await listQueueEntryCandidates(http, { repos, owner, name, base: exit.base })).filter((c) => !seen.has(c.prNumber) && (seen.add(c.prNumber), true)).slice(0, MAX_EXIT_RECHECKS);
  let firstError: unknown = null;
  for (const c of candidates) {
    // One entry's failed read must not starve the ones behind it; the first failure is thrown after the rest were asked.
    try {
      await attestWake(pool, accountId, { repoFullName: exit.repoFullName, base: exit.base, prNumber: c.prNumber, baseSha: c.baseSha, entrySha: c.entrySha }, deps, exit.prNumber);
    } catch (e) {
      // The first failure is rethrown below (and reported by the delivery); any later one would be lost, so it is reported here.
      if (firstError === null) firstError = e;
      else reportError(e, { stage: "gate1_queue_entry.exit_recheck" });
    }
  }
  if (firstError !== null) throw firstError;
}

async function attestWake(pool: Pool, accountId: string, wake: QueueEntryWake, deps: Gate1QueueEntryDeps, exitedPr: number | null): Promise<QueueEntryOutcome | null> {
  const event = { accountId };
  // The setting first: an unlisted repository gets no read of ours at all, not even of our own records.
  const repos = deps.repos ?? parseGate1AttestRepos(process.env.FX_GATE1_ATTEST_REPOS);
  if (!repos.has(wake.repoFullName.toLowerCase())) return null;
  const found = await ownItem(pool, event.accountId, wake.repoFullName, wake.prNumber);
  const workItemId = found === null ? null : found.workItemId;
  if (workItemId === null) return null;
  const loaded = await loadReviewContext(pool, event.accountId, workItemId);
  if (!loaded.ok) return null;
  const ctx = loaded.ctx;
  const [owner, name] = wake.repoFullName.split("/") as [string, string];
  // PR 1e: both paths. A runner_local item gets the attester's fenced client (A17, A18, A15, A7); a hosted item the plain merge_gate client, which reads
  // the queue through its REST reads and the one pinned entry document it already holds.
  const http: GitHubHttp = await openForRepo(deps.open ?? openInstallationHttp, ctx.executionMode, "merge_gate", { repoId: ctx.repoId, owner, name }, { withoutMerge: true, gate1Attest: true });
  const ourLogin = deps.ourLogin ?? readRepoAppLogin;
  // A group head that is a cloud item's own public pull request, stamped at the head the queue holds, and that lacks our success (its review round ended before the
  // setting went on) is attested by the head attester first. A head that is not one of our items (a team pull request) is left to its own watcher.
  const attestHead = async (e: { prNumber: number; head: string }): Promise<boolean> => {
    const item = await ownItem(pool, event.accountId, wake.repoFullName, e.prNumber);
    if (item === null || item.head !== e.head) return false;
    const l = await loadReviewContext(pool, event.accountId, item.workItemId);
    if (!l.ok) return false;
    const headHttp: GitHubHttp = await openForRepo(deps.open ?? openInstallationHttp, l.ctx.executionMode, "merge_gate", { repoId: l.ctx.repoId, owner, name }, { withoutMerge: true, gate1Attest: true });
    // A queued head cannot move under its entry (a push dequeues the pull request), so the entry's head stands for the live read.
    const r = await attestGate1Head(headHttp, { repos, owner, name, number: e.prNumber, sha: e.head, ourLogin: () => ourLogin(l.ctx.repoId), readHead: async () => e.head });
    return (r.kind === "posted" && r.state === "success") || r.kind === "already";
  };
  const out = await attestQueueEntry(http, { attestHead, repos, owner, name, base: wake.base, prNumber: wake.prNumber, baseSha: wake.baseSha, entrySha: wake.entrySha, ourLogin: () => ourLogin(ctx.repoId), ...(ctx.executionMode === "runner_local" ? {} : { entryDocument: MERGE_QUEUE_ENTRY_DOCUMENT }) });
  console.info(JSON.stringify({ event: "gate1_queue_entry", work_item_id: workItemId, outcome: out.kind, ...(exitedPr === null ? {} : { trigger: "queue_exit", exited_pr: exitedPr, pr_number: wake.prNumber }), ...("reason" in out ? { reason: out.reason } : {}) }));
  return out;
}
