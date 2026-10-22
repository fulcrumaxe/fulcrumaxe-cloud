import type { Pool, PoolClient } from "pg";
import { listDueBranchCleanups, BRANCH_CLEANUP_LIST_LIMIT } from "@fx/db/src/branchCleanupLister.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { deleteBranchWithToken, mintBranchDeleteToken, BranchDeleteTokenError, DELETABLE_BRANCH, InstallationHttpError, type BranchDeleteDeps, type BranchDeleteOutcome, type BranchDeleteGrant, type RunnerGitTicketSigner } from "@fx/github";
import { PLANE_PUBLISH_ROLE } from "@fx/runner";

/**
 * D#598 P1f-5d: the branch cleanup sweep, the cron's body. When a paired item reaches `merged`, `closed_unmerged` or `closed`, the private branches the
 * platform pushed for it are removed, if and only if each still points at the commit the platform recorded:
 *   - sandbox build: `fx/issue-<n>`, the commit is `publish.private_head` in the envelope of the item's publish run;
 *   - runner run: `fx/<run id>-g<generation>` (or the item's own `fx/issue-<n>` when the run continued it), the commit is the `headOid` the cloud read
 *     from GitHub when it judged the run (the `run.status_changed` row of the run's `done`).
 * The stage is read every time; nothing is stamped when an item closes. The cross-tenant list is the definer of migration 0886, and each item is then read,
 * deleted and recorded one at a time under its own tenant, with no database connection held while GitHub is asked.
 *
 * Each branch is removed through a one-use signed grant (`@fx/github` branchDeleteToken): it names the branch and its recorded head, opens a client that can read
 * and delete only that ref, and is revoked afterwards. A branch whose head moved, that is protected, or that is the default branch is LEFT and the reason is
 * recorded on the item (`branch_cleanups.outcomes`); a branch that is already gone counts as deleted, so a replay deletes nothing twice. A branch GitHub could not
 * be asked about writes nothing and the item is listed again. An item with several branches gets its row only when every branch has a final outcome.
 *
 * What is recorded (`branch_cleanups`, migration 0886) is the cleanup of one CLOSE of the item, keyed to its newest move into a final stage: an item that is
 * reopened, pushes again and closes again has a new close and is listed again. A repository whose installation or repository is gone is a final outcome
 * (`no_installation`, `repo_gone`). When GitHub cannot be asked the row keeps the outcomes already reached and backs off (15, 30, 60, 120 minutes); the fifth
 * failed attempt is final with `gave_up`, so an item that keeps failing stops being listed and cannot hold up the items beside it.
 *
 * With no signing key the pass does nothing and records nothing (the health check names it); the pending-work marker keeps an idle platform from calling.
 */

/** A pass stops starting items after this long, leaving the rest to the next tick (the route has a 60 second limit). */
export const CLEANUP_PASS_BUDGET_MS = 40_000;
/** An item that could not be finished is asked for again after this long (the marker; the standard backstop still looks now and then). */
export const CLEANUP_RETRY_AFTER_MS = 15 * 60_000;
/** A cleanup that could not reach GitHub is tried this many times in all; the last failed one is final (`gave_up`). */
const MAX_ATTEMPTS = 5;
/** The wait before the next attempt, by attempts so far: 15, 30, 60, 120 minutes. */
const backoffSeconds = (attempts: number): number => 15 * 60 * 2 ** (attempts - 1);
/** The most branches one item is cleaned of in a pass. */
const MAX_BRANCHES = 20;

export interface BranchCleanupCounts {
  configured: boolean;
  listed: number;
  deleted: number;
  /** Branches left for a stated reason (head moved, protected, default branch) or already gone. */
  left: number;
  /** Items that got their row. */
  recorded: number;
  /** Items not finished (GitHub or the database could not answer); listed again later. */
  failed: number;
  nextDueAt: number | null;
}

/** What the sweep needs from GitHub: the client for one repository and (for the delete kind) one branch. */
export type BranchCleanupGithub = BranchDeleteDeps["open"];

export interface BranchCleanupDeps {
  pool: Pool;
  signer: RunnerGitTicketSigner | null;
  /** The GitHub client opener (apps/web binds `openInstallationHttp`). */
  github: BranchCleanupGithub;
  now?: () => number;
  log?: (line: string) => void;
}

interface Candidate {
  grant: BranchDeleteGrant;
  at: Date;
}

type Outcome = { branch: string; outcome: BranchDeleteOutcome | "no_installation" | "gave_up" };

/** What a pass starts from: the close it covers, the branches recorded for the item, and what an earlier failed pass already reached for this close. */
interface ItemState {
  transitionId: string | null;
  candidates: Candidate[];
  priorAttempts: number;
  prior: Outcome[];
}

const TERMINAL = ["merged", "closed_unmerged", "closed"];
const SHA = /^[0-9a-f]{40}$/;

/** The branches of one item and the head recorded for each, newest record first, one per (repository, branch). Empty when the item is no longer paired and closed. */
async function readState(client: PoolClient, accountId: string, workItemId: string): Promise<ItemState | null> {
  const { rows: gate } = await client.query<{ issue: string }>(
    `SELECT w.gh_number::text AS issue FROM work_items w
      WHERE w.account_id = $1 AND w.id = $2 AND w.stage = ANY ($3::text[])
        AND EXISTS (SELECT 1 FROM plane_pushes p WHERE p.account_id = w.account_id AND p.work_item_id = w.id)`,
    [accountId, workItemId, TERMINAL],
  );
  if (gate.length === 0) return null;
  const issue = gate[0]!.issue;
  const { rows } = await client.query<{ run_id: string; repo_id: string; owner: string; name: string; branch: string; sha: string; at: Date }>(
    `SELECT r.id AS run_id, rp.id AS repo_id, rp.gh_owner AS owner, rp.gh_name AS name, 'fx/issue-' || $3::text AS branch, r.envelope->'publish'->>'private_head' AS sha, r.created_at AS at
       FROM agent_runs r JOIN repos rp ON rp.account_id = r.account_id AND rp.id = r.dispatch_repo_id
      WHERE r.account_id = $1 AND r.work_item_id = $2 AND r.role = $4 AND r.status = 'succeeded' AND r.envelope->'publish'->>'private_head' IS NOT NULL
     UNION ALL
     SELECT r.id, rp.id, rp.gh_owner, rp.gh_name, e.payload->>'branch', e.payload->>'headOid', e.created_at
       FROM run_events e JOIN agent_runs r ON r.account_id = e.account_id AND r.id = e.run_id JOIN repos rp ON rp.account_id = r.account_id AND rp.id = r.dispatch_repo_id
      WHERE e.account_id = $1 AND r.work_item_id = $2 AND e.kind = 'run.status_changed' AND e.payload->>'viaRunnerDone' = 'true' AND e.payload->>'headOid' IS NOT NULL
      ORDER BY 7 DESC, 1 LIMIT 200`,
    [accountId, workItemId, issue, PLANE_PUBLISH_ROLE],
  );
  const { rows: closes } = await client.query<{ id: string }>(
    `SELECT id FROM work_item_transitions WHERE account_id = $1 AND work_item_id = $2 AND to_stage = ANY ($3::text[]) ORDER BY created_at DESC, id DESC LIMIT 1`,
    [accountId, workItemId, TERMINAL],
  );
  const transitionId = closes[0]?.id ?? null;
  const { rows: earlier } = await client.query<{ state: string; attempts: number; outcomes: Outcome[] }>(
    `SELECT state, attempts, outcomes FROM branch_cleanups WHERE account_id = $1 AND work_item_id = $2 AND COALESCE(transition_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`,
    [accountId, workItemId, transitionId],
  );
  // A final row for this close means there is nothing left (the list does not return such an item; this covers a pass that raced another).
  if (earlier[0]?.state === "final") return null;
  const prior = earlier[0]?.outcomes ?? [];
  const done = new Set(prior.map((o) => o.branch));
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const r of rows) {
    const key = `${r.repo_id}/${r.branch}`;
    // Only the two shapes, and a run branch only for the run that recorded it; the item branch only for this item's own number.
    const ok = typeof r.branch === "string" && DELETABLE_BRANCH.test(r.branch) && SHA.test(String(r.sha)) && (r.branch === `fx/issue-${issue}` || r.branch.startsWith(`fx/${r.run_id}-g`));
    if (!ok || seen.has(key) || done.has(r.branch)) continue;
    seen.add(key);
    out.push({ at: r.at, grant: { accountId, workItemId, repo: { id: r.repo_id, owner: r.owner, name: r.name }, branch: r.branch, sha: r.sha } });
    if (out.length === MAX_BRANCHES) break;
  }
  return { transitionId, candidates: out, priorAttempts: earlier[0]?.attempts ?? 0, prior };
}

/** Writes the cleanup of this close: final, or retrying with its backoff (the fifth failed attempt is final with `gave_up`). */
async function record(client: PoolClient, item: { accountId: string; workItemId: string }, s: ItemState, outcomes: Outcome[], unfinished: string[]): Promise<void> {
  const attempts = s.priorAttempts + 1;
  const giveUp = unfinished.length > 0 && attempts >= MAX_ATTEMPTS;
  const final = unfinished.length === 0 || giveUp;
  const all = giveUp ? [...outcomes, ...unfinished.map((branch): Outcome => ({ branch, outcome: "gave_up" }))] : outcomes;
  await client.query(
    `INSERT INTO branch_cleanups (account_id, work_item_id, transition_id, state, attempts, next_attempt_at, outcomes)
     VALUES ($1, $2, $3, $4::text, $5, CASE WHEN $4::text = 'retrying' THEN now() + make_interval(secs => $6::integer) END, $7::jsonb)
     ON CONFLICT (account_id, work_item_id, (COALESCE(transition_id, '00000000-0000-0000-0000-000000000000'::uuid)))
     DO UPDATE SET state = EXCLUDED.state, attempts = EXCLUDED.attempts, next_attempt_at = EXCLUDED.next_attempt_at, outcomes = EXCLUDED.outcomes, updated_at = now()
     WHERE branch_cleanups.state = 'retrying'`,
    [item.accountId, item.workItemId, s.transitionId, final ? "final" : "retrying", Math.min(attempts, MAX_ATTEMPTS), backoffSeconds(attempts), JSON.stringify(all)],
  );
}

export async function sweepBranchCleanups(deps: BranchCleanupDeps): Promise<BranchCleanupCounts> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.info(line));
  const counts: BranchCleanupCounts = { configured: deps.signer !== null, listed: 0, deleted: 0, left: 0, recorded: 0, failed: 0, nextDueAt: null };
  // A missing signing key reads no row and writes none: the items stay listed for when it is set (the backstop looks again).
  if (deps.signer === null) return counts;
  const startedAt = now();
  let due;
  try {
    due = await listDueBranchCleanups(deps.pool, { limit: BRANCH_CLEANUP_LIST_LIMIT });
  } catch (error) {
    // fx-swallow-ok: counted and logged with a fixed code (never the driver's message, which can carry a host); the next tick looks again
    counts.failed += 1;
    log(JSON.stringify({ event: "branch_cleanup.list_failed", code: (error as { code?: string } | null)?.code ?? "error" }));
    counts.nextDueAt = startedAt + CLEANUP_RETRY_AFTER_MS;
    return counts;
  }
  counts.listed = due.length;
  for (const item of due) {
    if (now() - startedAt > CLEANUP_PASS_BUDGET_MS) {
      counts.nextDueAt = startedAt + 60_000;
      break;
    }
    try {
      const state = await withTenant(deps.pool, item.accountId, (client) => readState(client, item.accountId, item.workItemId));
      if (state === null) continue;
      const outcomes: Outcome[] = [...state.prior];
      const unfinished: string[] = [];
      for (const c of state.candidates) {
        try {
          const token = await mintBranchDeleteToken(c.grant, deps.signer, new Date(now()));
          const outcome = await deleteBranchWithToken(token, { signer: deps.signer, open: deps.github, now: () => new Date(now()) });
          outcomes.push({ branch: c.grant.branch, outcome });
          if (outcome === "deleted") counts.deleted += 1;
          else counts.left += 1;
        } catch (error) {
          // fx-swallow-ok: an installation that is gone is final for this close; anything else is logged by item id and a fixed code and the branch is tried again later
          if (error instanceof InstallationHttpError && error.reason === "no_installation") {
            outcomes.push({ branch: c.grant.branch, outcome: "no_installation" });
            counts.left += 1;
          } else {
            unfinished.push(c.grant.branch);
            const code = error instanceof BranchDeleteTokenError ? error.code : ((error as { code?: string; reason?: string } | null)?.code ?? (error as { reason?: string } | null)?.reason ?? "error");
            log(JSON.stringify({ event: "branch_cleanup.failed", work_item_id: item.workItemId, code }));
          }
        }
      }
      await withTenant(deps.pool, item.accountId, (client) => record(client, item, state, outcomes, unfinished));
      if (unfinished.length === 0) counts.recorded += 1;
      else {
        counts.failed += 1;
        counts.nextDueAt = startedAt + CLEANUP_RETRY_AFTER_MS;
      }
    } catch (error) {
      // fx-swallow-ok: one item's failure is counted and logged by id and a fixed code; the pass goes on and the item is listed again
      counts.failed += 1;
      const code = error instanceof BranchDeleteTokenError ? error.code : ((error as { code?: string; reason?: string } | null)?.code ?? (error as { reason?: string } | null)?.reason ?? "error");
      log(JSON.stringify({ event: "branch_cleanup.failed", work_item_id: item.workItemId, code }));
    }
  }
  if (counts.failed > 0 && counts.nextDueAt === null) counts.nextDueAt = startedAt + CLEANUP_RETRY_AFTER_MS;
  if (due.length >= BRANCH_CLEANUP_LIST_LIMIT && counts.nextDueAt === null) counts.nextDueAt = startedAt + 60_000;
  return counts;
}
