import type { Pool, PoolClient } from "pg";
import { listDueBranchCleanups, BRANCH_CLEANUP_LIST_LIMIT } from "@fx/db/src/branchCleanupLister.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import { BUILD_BRANCH_KIND, resolveBuildIdentity } from "@fx/core/src/work-items/buildIdentity.js";
import { deleteBranchWithToken, mintBranchDeleteToken, BranchDeleteTokenError, DELETABLE_BRANCH, InstallationHttpError, type BranchDeleteDeps, type BranchDeleteOutcome, type BranchDeleteGrant, type RunnerGitTicketSigner } from "@fx/github";
import { PLANE_PUBLISH_ROLE } from "@fx/runner";
import { closePrivateCopy, PrCloseError, PublicPrStillOpen, type PrCloseOpen, type PrCloseOutcome, type PublicPrState } from "./privatePrClose.js";

/**
 * D#598 P1f-5d: the branch cleanup sweep, the cron's body. When a paired item reaches `merged`, `closed_unmerged` or `closed`, the private branches the
 * platform pushed for it are removed, if and only if each still points at the commit the platform recorded:
 *   - sandbox build: the item's own branch (its build identity's: `fx/issue-<n>`, or a planned PR child's `fx/<parent#>-<key>`), the commit is `publish.private_head` in the envelope of the item's publish run;
 *   - runner run: `fx/<run id>-g<generation>` (or the item's own branch when the run continued it), the commit is the `headOid` the cloud read
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
 * Before a branch is removed, the private pull request the run opened for it (the number the run recorded at `done`) is closed when the item's public pull
 * request has merged or closed (privatePrClose.ts): only while it is open at exactly the recorded head, never while the public one is open, never for an
 * item whose public branch a person took over. Its outcome is recorded under `pr:<number>` next to the branches, so a replay closes nothing twice. This
 * step runs only when the caller gave a pull-request client (`closePr`); without one the sweep is what it was.
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
  /** Private pull requests closed. */
  prsClosed: number;
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
  /** Opens the client that lists and closes the private copy's pull request (apps/web binds it; fenced for a `runner_local` repository). Absent: the step does not run. */
  closePr?: PrCloseOpen;
  now?: () => number;
  log?: (line: string) => void;
}

interface Candidate {
  grant: BranchDeleteGrant;
  at: Date;
  /** The branch already has its outcome from an earlier pass of this close. */
  branchDone: boolean;
  /** The pull request the run recorded for this branch, if any, and whether an earlier pass of this close already settled it. */
  pr: number | null;
  prDone: boolean;
  /** The side that built the pull request (it decides the fence). */
  mode: string;
}

type Outcome = { branch: string; outcome: BranchDeleteOutcome | PrCloseOutcome | "no_installation" | "gave_up" };

/** What a pass starts from: the close it covers, the branches recorded for the item, and what an earlier failed pass already reached for this close. */
interface ItemState {
  transitionId: string | null;
  candidates: Candidate[];
  priorAttempts: number;
  prior: Outcome[];
  publicState: PublicPrState;
}

const TERMINAL = ["merged", "closed_unmerged", "closed"];
const SHA = /^[0-9a-f]{40}$/;

/** The branches of one item and the head recorded for each, newest record first, one per (repository, branch). Empty when the item is no longer paired and closed. */
async function readState(client: PoolClient, accountId: string, workItemId: string): Promise<ItemState | null> {
  const { rows: gate } = await client.query<{ one: number }>(
    `SELECT 1 AS one FROM work_items w
      WHERE w.account_id = $1 AND w.id = $2 AND w.stage = ANY ($3::text[])
        AND EXISTS (SELECT 1 FROM plane_pushes p WHERE p.account_id = w.account_id AND p.work_item_id = w.id)`,
    [accountId, workItemId, TERMINAL],
  );
  if (gate.length === 0) return null;
  // D#483 S5-b2c-3 (R7, R10): the item's own branch is the build identity's. This reads what already happened, so it runs no launch check: an orphan whose branch was recorded is still cleaned
  // once its pull request has merged or closed, and one with no record has no item branch (only its runs' own branches are looked at). It is never the parent's `fx/issue-<n>` and never a sibling's.
  // SANDBOX-RERUN-BRANCH-a: an item re-run in the sandbox has more than one branch. Each succeeded publish run is paired with the branch of the executor run it came from (the run's own recorded
  // `build.branch`, found up its parent chain, and read only when it is that run's own branch or the fixed name) and with ITS head; a run with no record is on the fixed name.
  const named: { fixed?: string } = {};
  const identity = await resolveBuildIdentity(client, accountId, workItemId, "observe", named);
  const itemBranch = identity.ok ? (named.fixed ?? null) : null;
  const { rows } = await client.query<{ run_id: string; repo_id: string; owner: string; name: string; branch: string; sha: string; at: Date; pr: string | null; mode: string; own_run: boolean }>(
    `SELECT COALESCE(own.owner, r.id) AS run_id, rp.id AS repo_id, rp.gh_owner AS owner, rp.gh_name AS name, COALESCE(own.b, $3::text) AS branch, r.envelope->'publish'->>'private_head' AS sha, r.created_at AS at, NULL::text AS pr, r.execution_mode AS mode,
            starts_with(COALESCE(own.b, $3::text), 'fx/' || COALESCE(own.owner, r.id)::text || '-g') AS own_run
       FROM agent_runs r JOIN repos rp ON rp.account_id = r.account_id AND rp.id = r.dispatch_repo_id
       LEFT JOIN LATERAL (
         WITH RECURSIVE chain AS (SELECT r.id, r.parent_run_id, 0 AS d UNION ALL SELECT p.id, p.parent_run_id, c.d + 1 FROM chain c JOIN agent_runs p ON p.account_id = r.account_id AND p.id = c.parent_run_id AND p.work_item_id = r.work_item_id WHERE c.d < 8)
         SELECT e.run_id AS owner, e.payload->>'branch' AS b FROM chain c JOIN run_events e ON e.account_id = r.account_id AND e.run_id = c.id AND e.kind = '${BUILD_BRANCH_KIND}'
          WHERE e.payload->>'branch' = 'fx/' || e.run_id::text || '-g1' OR e.payload->>'branch' = $3::text ORDER BY c.d, e.seq DESC LIMIT 1) own ON true
      WHERE r.account_id = $1 AND r.work_item_id = $2 AND r.role = $4 AND r.status = 'succeeded' AND r.envelope->'publish'->>'private_head' IS NOT NULL
     UNION ALL
     SELECT r.id, rp.id, rp.gh_owner, rp.gh_name, e.payload->>'branch', e.payload->>'headOid', e.created_at, e.payload->>'prNumber', r.execution_mode, starts_with(e.payload->>'branch', 'fx/' || r.id::text || '-g')
       FROM run_events e JOIN agent_runs r ON r.account_id = e.account_id AND r.id = e.run_id JOIN repos rp ON rp.account_id = r.account_id AND rp.id = r.dispatch_repo_id
      WHERE e.account_id = $1 AND r.work_item_id = $2 AND e.kind = 'run.status_changed' AND e.payload->>'viaRunnerDone' = 'true' AND e.payload->>'headOid' IS NOT NULL
      ORDER BY 7 DESC, 1 LIMIT 200`,
    [accountId, workItemId, itemBranch, PLANE_PUBLISH_ROLE],
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
  // The public pull request, from the push record. A person's takeover wins over a merge or close; anything not yet merged or closed counts as open.
  const { rows: pub } = await client.query<{ state: string; managed: boolean }>(
    `SELECT p.state, (p.managed_by_person_at IS NOT NULL OR p.state = 'managed_by_person') AS managed
       FROM plane_pushes p WHERE p.account_id = $1 AND p.work_item_id = $2 ORDER BY p.created_at DESC, p.id DESC LIMIT 1`,
    [accountId, workItemId],
  );
  const publicState: PublicPrState = pub[0]?.managed ? "person_managed" : pub[0] && (pub[0].state === "pr_merged" || pub[0].state === "pr_closed") ? "done" : "open";
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const r of rows) {
    const key = `${r.repo_id}/${r.branch}`;
    // Only the two shapes, and a run branch only for the run that recorded it; the item branch only for this item's own number.
    const ok = typeof r.branch === "string" && DELETABLE_BRANCH.test(r.branch) && SHA.test(String(r.sha)) && ((itemBranch !== null && r.branch === itemBranch) || r.own_run);
    const pr = ok && typeof r.pr === "string" && /^[1-9][0-9]{0,9}$/.test(r.pr) && Number.isSafeInteger(Number(r.pr)) ? Number(r.pr) : null;
    const branchDone = done.has(r.branch);
    const prDone = pr === null || done.has(`pr:${pr}`);
    if (!ok || seen.has(key) || (branchDone && prDone)) continue;
    seen.add(key);
    out.push({ at: r.at, branchDone, pr, prDone, mode: r.mode ?? "sandbox", grant: { accountId, workItemId, repo: { id: r.repo_id, owner: r.owner, name: r.name }, branch: r.branch, sha: r.sha } });
    if (out.length === MAX_BRANCHES) break;
  }
  return { transitionId, candidates: out, priorAttempts: earlier[0]?.attempts ?? 0, prior, publicState };
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
  const counts: BranchCleanupCounts = { configured: deps.signer !== null, listed: 0, deleted: 0, left: 0, prsClosed: 0, recorded: 0, failed: 0, nextDueAt: null };
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
        if (deps.closePr && c.pr !== null && !c.prDone) {
          const key = `pr:${c.pr}`;
          try {
            const outcome = await closePrivateCopy(deps.closePr, state.publicState, { repo: c.grant.repo, number: c.pr, branch: c.grant.branch, sha: c.grant.sha, executionMode: c.mode });
            outcomes.push({ branch: key, outcome });
            if (outcome === "private_pr_closed") counts.prsClosed += 1;
          } catch (error) {
            // fx-swallow-ok: a public pull request still open is not a failure (the item is looked at again after the backoff); anything else is logged by item id and a fixed code
            unfinished.push(key);
            if (!(error instanceof PublicPrStillOpen)) log(JSON.stringify({ event: "branch_cleanup.pr_close_failed", work_item_id: item.workItemId, code: error instanceof PrCloseError ? error.code : ((error as { reason?: string } | null)?.reason ?? "error") }));
          }
        }
        if (c.branchDone) continue;
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
