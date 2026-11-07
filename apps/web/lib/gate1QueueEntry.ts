import type { Pool } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { attestQueueEntry, loadReviewContext, parseGate1AttestRepos, type LocalGitHubHttp, type QueueEntryOutcome } from "@fx/pipeline";
import type { GithubWebhookEventName, GithubWebhookPayload } from "@fx/github";
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

/** The webhook's trigger. Answers what the attester did, or null when the delivery is not for a listed code repository's queue entry of one of our items. */
export async function wakeGate1QueueEntry(pool: Pool, event: { accountId: string; eventName: GithubWebhookEventName | string; payload: GithubWebhookPayload | unknown }, deps: Gate1QueueEntryDeps = {}): Promise<QueueEntryOutcome | null> {
  const wake = readQueueEntryWake(event.eventName, event.payload);
  if (wake === null) return null;
  // The setting first: an unlisted repository gets no read of ours at all, not even of our own records.
  const repos = deps.repos ?? parseGate1AttestRepos(process.env.FX_GATE1_ATTEST_REPOS);
  if (!repos.has(wake.repoFullName.toLowerCase())) return null;
  const workItemId = await withTenant(pool, event.accountId, async (client) => {
    // Every record naming this public pull request is counted first, person-managed ones included: a person-managed match, or two items naming one
    // pull request, is not ours to resolve, and nothing is attested.
    const { rows } = await client.query<{ work_item_id: string; managed: boolean }>(
      "SELECT DISTINCT work_item_id, (managed_by_person_at IS NOT NULL) AS managed FROM plane_pushes WHERE account_id = $1 AND lower(code_repo) = lower($2) AND pr_number = $3 LIMIT 3",
      [event.accountId, wake.repoFullName, wake.prNumber],
    );
    if (rows.some((r) => r.managed !== false)) return null;
    return rows.length === 1 ? rows[0]!.work_item_id : null;
  });
  if (workItemId === null) return null;
  const loaded = await loadReviewContext(pool, event.accountId, workItemId);
  if (!loaded.ok || loaded.ctx.executionMode !== "runner_local") return null;
  const ctx = loaded.ctx;
  const [owner, name] = wake.repoFullName.split("/") as [string, string];
  const http = (await openForRepo(deps.open ?? openInstallationHttp, ctx.executionMode, "merge_gate", { repoId: ctx.repoId, owner, name }, { withoutMerge: true, gate1Attest: true })) as LocalGitHubHttp;
  const ourLogin = deps.ourLogin ?? readRepoAppLogin;
  const out = await attestQueueEntry(http, { repos, owner, name, base: wake.base, prNumber: wake.prNumber, baseSha: wake.baseSha, entrySha: wake.entrySha, ourLogin: () => ourLogin(ctx.repoId) });
  console.info(JSON.stringify({ event: "gate1_queue_entry", work_item_id: workItemId, outcome: out.kind, ...("reason" in out ? { reason: out.reason } : {}) }));
  return out;
}
