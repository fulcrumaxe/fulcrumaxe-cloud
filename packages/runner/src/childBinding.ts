import type { PoolClient } from "pg";
import { RUNNER_RUN_BRANCH } from "@fulcrumaxe/runner-protocol";
import { BUILD_BRANCH_KIND, sandboxRunBranch } from "@fx/core/src/work-items/buildIdentity.js";
import { RUN_EVENTS_SEQ_LOCK_SQL, insertRunEvent, runEventsSeqLockKey } from "./runStatusWriter.js";

/**
 * D#483 S5-b2c-2: the platform's record of which branch (and, once known, which pull request) a planned PR child's executor run opened. It is written on the RUN, as the
 * runner's done record is, and the webhook maps a pull request to the child by it. Two run event kinds, each written once per run:
 *
 *   - `child.binding`     { branch }              when the build run starts (a sandbox build only; a runner run's branch is its own and its done record binds the number)
 *   - `child.binding_pr`  { branch, prNumber }    once the pull request is known: from the platform's own lookup after the run, or from the first webhook that names the branch
 *
 * Set once: both writers take the run's event lock (the same one every run event writer takes for its sequence number), look for the row, and write only when there is
 * none. So a second attempt, from the same or another writer, is a no-op that adds no row.
 */
export const CHILD_BINDING_KIND = "child.binding";
export const CHILD_BINDING_PR_KIND = "child.binding_pr";

const SAFE_BRANCH = /^fx\/[0-9]{1,12}-[a-z0-9-]{1,32}$/;

async function writeOnce(client: PoolClient, accountId: string, runId: string, kind: string, payload: Record<string, unknown>): Promise<boolean> {
  await client.query(RUN_EVENTS_SEQ_LOCK_SQL, [runEventsSeqLockKey(runId)]);
  const have = await client.query("SELECT 1 FROM run_events WHERE account_id = $1 AND run_id = $2 AND kind = $3 LIMIT 1", [accountId, runId, kind]);
  if (have.rows.length > 0) return false;
  await insertRunEvent(client, accountId, runId, kind, payload);
  return true;
}

/**
 * Records the branch a child's build run will use. A second record for the run is a no-op (`false`). SANDBOX-RERUN-BRANCH-a: a run-shaped branch is accepted only when it is THIS run's own
 * (`fx/<this run's id>-g1`), so a pull request on any other run-shaped name maps to nothing.
 */
export async function recordChildBranch(client: PoolClient, accountId: string, runId: string, branch: string): Promise<boolean> {
  if (!SAFE_BRANCH.test(branch) && branch !== sandboxRunBranch(runId)) throw new Error("recordChildBranch: not a child branch");
  return writeOnce(client, accountId, runId, CHILD_BINDING_KIND, { branch });
}

/**
 * SANDBOX-RERUN-BRANCH-a: the branch a sandbox executor run pushes, written once in the run's create transaction (`build.branch`, `{ branch }`): the item's fixed name, or this run's own `fx/<id>-g1`.
 * Nothing else is recorded. A second write for the run is a no-op (`false`).
 */
export async function recordBuildBranch(client: PoolClient, accountId: string, runId: string, branch: string, fixedBranch?: string): Promise<boolean> {
  // Only exact names: this run's own, the item's `fx/issue-<n>`, or the fixed name the caller says the item builds on (a planned PR child's `fx/<parent#>-<key>`, which is the caller's to name: never accepted by shape,
  // so another run's `fx/<uuid>-g1` whose id begins with digits is refused). The caller's name must itself be a fixed-name shape, so it cannot whitelist `main` or a run branch.
  const fixedOk = fixedBranch !== undefined && branch === fixedBranch && (SAFE_BRANCH.test(fixedBranch) || /^fx\/issue-[1-9][0-9]{0,9}$/.test(fixedBranch)) && !RUNNER_RUN_BRANCH.test(fixedBranch);
  if (branch !== sandboxRunBranch(runId) && !/^fx\/issue-[1-9][0-9]{0,9}$/.test(branch) && !fixedOk) throw new Error("recordBuildBranch: not a build branch");
  return writeOnce(client, accountId, runId, BUILD_BRANCH_KIND, { branch });
}

/** Records the pull request number of the branch a child's run recorded. Set once: a run that already has a number keeps it (`false`). */
export async function recordChildPullRequest(client: PoolClient, accountId: string, runId: string, branch: string, prNumber: number): Promise<boolean> {
  if ((!SAFE_BRANCH.test(branch) && branch !== sandboxRunBranch(runId)) || !Number.isSafeInteger(prNumber) || prNumber <= 0) throw new Error("recordChildPullRequest: invalid input");
  return writeOnce(client, accountId, runId, CHILD_BINDING_PR_KIND, { branch, prNumber });
}

const PUBLIC_BRANCH = /^fx\/p-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE_REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

/**
 * D#483 S5-b2c-4 (R9): a PAIRED child's pull request is on the code plane. The publish step records it once its hosted side confirmed the pull request, as `{ branch, prNumber, plane: "code", codeRepo }`:
 * `branch` is the public branch (`fx/p-<push id>`, the push row's), `prNumber` the code repository's number. It is a run event of the executor run like the private binding, set once, and never written from a
 * webhook. The webhook maps a code-plane event to the child only when this record and the child's `plane_pushes` row agree on repository, number and branch.
 */
export async function recordChildCodePullRequest(client: PoolClient, accountId: string, runId: string, input: { branch: string; prNumber: number; codeRepo: string }): Promise<boolean> {
  if (!PUBLIC_BRANCH.test(input.branch) || !Number.isSafeInteger(input.prNumber) || input.prNumber <= 0 || !CODE_REPO.test(input.codeRepo)) throw new Error("recordChildCodePullRequest: invalid input");
  return writeOnce(client, accountId, runId, CHILD_BINDING_PR_KIND, { branch: input.branch, prNumber: input.prNumber, plane: "code", codeRepo: input.codeRepo });
}

/**
 * Binds `prNumber` to the newest executor run of `workItemId` that recorded a branch and has no number yet. A paired child (one with a `plane_pushes` row) is never bound here: its pull request is
 * the code plane's, bound by `recordChildCodePullRequest`, and its private draft maps by the run's `plane.private_pr` marker. Used by the stage driver once its own lookup found the
 * child's pull request on that branch. Null when the item has no such run.
 */
export async function recordChildPullRequestForItem(client: PoolClient, accountId: string, workItemId: string, prNumber: number): Promise<{ recorded: boolean; branch: string } | null> {
  const { rows } = await client.query<{ run_id: string; branch: string }>(
    `SELECT r.id AS run_id, b.payload->>'branch' AS branch
       FROM agent_runs r JOIN run_events b ON b.account_id = r.account_id AND b.run_id = r.id AND b.kind = $3
      WHERE r.account_id = $1 AND r.work_item_id = $2 AND r.role = 'executor'
        AND NOT EXISTS (SELECT 1 FROM run_events n WHERE n.account_id = r.account_id AND n.run_id = r.id AND n.kind = $4)
        AND NOT EXISTS (SELECT 1 FROM plane_pushes pp WHERE pp.account_id = r.account_id AND pp.work_item_id = r.work_item_id)
      ORDER BY r.created_at DESC, r.id DESC LIMIT 1`,
    [accountId, workItemId, CHILD_BINDING_KIND, CHILD_BINDING_PR_KIND],
  );
  const row = rows[0];
  if (!row) return null;
  return { recorded: await recordChildPullRequest(client, accountId, row.run_id, row.branch, prNumber), branch: row.branch };
}

/**
 * The pull request number the child's newest branch-recording executor run already has bound, or null when it has none yet (or the item has no such run). A rebuild is a new
 * run with a new binding, so an earlier run's number never counts here.
 */
export async function readChildBoundPullRequest(client: PoolClient, accountId: string, workItemId: string): Promise<number | null> {
  const { rows } = await client.query<{ n: string | null }>(
    `SELECT n.payload->>'prNumber' AS n
       FROM agent_runs r JOIN run_events b ON b.account_id = r.account_id AND b.run_id = r.id AND b.kind = $3
       LEFT JOIN run_events n ON n.account_id = r.account_id AND n.run_id = r.id AND n.kind = $4 AND COALESCE(n.payload->>'plane', 'private') <> 'code'
      WHERE r.account_id = $1 AND r.work_item_id = $2 AND r.role = 'executor'
      ORDER BY r.created_at DESC, r.id DESC LIMIT 1`,
    [accountId, workItemId, CHILD_BINDING_KIND, CHILD_BINDING_PR_KIND],
  );
  const n = rows[0]?.n;
  return n === undefined || n === null ? null : Number(n);
}
