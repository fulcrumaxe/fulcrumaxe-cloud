import type { PoolClient } from "pg";

/**
 * D#483 S5-b2c-3 (R7): the one place that says which GitHub issue number and which branch a work item builds on, and which Spec version it is held to.
 *
 *   - A top-level item builds on its own issue, on `fx/issue-<n>`, against the version its newest approval names.
 *   - A planned PR child has no number of its own (its `gh_number` stays null, and a database CHECK keeps it so). It builds on its PARENT's issue, on `fx/<parent#>-<key>`, against the
 *     one version of the parent it was pinned to (`planned_pr_spec_version_id`).
 *
 * Every consumer that needs an issue number or an item branch (fix rounds, check-fix rounds, resume, continuation, the build, the reviews, slot reconcile, branch cleanup, the runner's
 * item-branch binding) asks this module. None reads `work_items.gh_number` or builds an `fx/issue-` name itself; `buildIdentitySourceScan.test.ts` fails the build when one does.
 * This file holds the only definitions of `branchFor` and `childBranchFor`.
 *
 * Two purposes, because two kinds of caller ask different questions:
 *   - `start`: something is about to be started for the item (a fix round, a check-fix round, a resume, a continuation, a build). For a child it re-runs the launch rule's checks 1 to 4
 *     against the rows as they are now. A child that has already started stays valid after its parent is re-approved as long as its key is still in the approved version (R11), and keeps
 *     its pinned version.
 *   - `observe`: something is reading what already happened (slot reconcile, branch cleanup, the bound-branch read). No launch check runs. A child's branch is the one its newest executor
 *     run recorded (`child.binding`); only without a record is it computed from the live parent. An orphan with no record answers `child_orphaned` and nothing is done.
 *
 * Everything is derived on read from current rows. Nothing is stamped.
 */

/** The branch a sandbox build of a top-level item pushes. */
export const branchFor = (number: number): string => `fx/issue-${number}`;

/** The branch of a planned PR child. The key's pattern (`^[a-z0-9-]{1,32}$`, never `fix-` or `check-`) keeps it a safe ref; a run branch is `fx/<uuid>-g<n>`. */
export const childBranchFor = (parentNumber: number, key: string): string => `fx/${parentNumber}-${key}`;

/**
 * SANDBOX-RERUN-BRANCH-a: the branch a sandbox "Build again" pushes: the run's own `agent_runs.id`, lower-case, and the generation fixed at 1 (a sandbox has no lease generation). It has the
 * runner run shape (`RUNNER_RUN_BRANCH`), so every run-branch check already accepts it. A first build keeps the fixed name above. The only place this name is made.
 */
export const sandboxRunBranch = (runId: string): string => `fx/${runId.toLowerCase()}-g1`;

/**
 * The branch a build STARTED now pushes (the one place build.ts asks). A first build, and every build on a runner, is the item's fixed name (`key` is the child's planned PR key, null for a
 * top-level item); a sandbox Build again passes the id its new run will have and gets that run's own branch. Never the newest recorded branch: that is where an earlier attempt's pull request is.
 */
export const startBuildBranch = (identity: Pick<BuildIdentity, "issueNumber">, key: string | null, rerunRunId: string | null): string =>
  rerunRunId !== null ? sandboxRunBranch(rerunRunId) : key === null ? branchFor(identity.issueNumber) : childBranchFor(identity.issueNumber, key);

/** The run event a sandbox executor run's create transaction writes once: `{ branch }`, the branch the run pushes (the fixed name for a first build, the run branch for a rebuild). */
export const BUILD_BRANCH_KIND = "build.branch";

export const BUILD_PURPOSES = ["start", "observe"] as const;
export type BuildPurpose = (typeof BUILD_PURPOSES)[number];

export interface BuildIdentity {
  /** The GitHub issue the item builds on: its own number, or its parent's for a child. */
  issueNumber: number;
  /** The item's branch: `fx/issue-<n>`, or `fx/<parent#>-<key>` for a child. */
  branch: string;
  /**
   * The Spec version the item is held to: a top-level item's is the one its newest approval names (null when it has no approval row: it was approved before the rows existed, and its
   * consumers read their own newest version, as they always did); a child's is its pinned `planned_pr_spec_version_id` (null only for `observe`, after that version was erased).
   */
  specVersionId: string | null;
  isChild: boolean;
}

/** The fixed refusal codes. The sentences are the launch rule's (`childLaunchSentence`) plus `no_issue_link` and `not_found`. */
export const BUILD_IDENTITY_REFUSALS = ["not_found", "no_issue_link", "child_orphaned", "parent_closed", "respec_needs_approval", "key_not_in_approved_spec"] as const;
export type BuildIdentityRefusal = (typeof BUILD_IDENTITY_REFUSALS)[number];
/** `isChild` on a refusal says which kind of item it was refused for (false for a missing item), so a caller can tolerate a top-level item's `no_issue_link` and never a child's. */
export type BuildIdentityResult = { ok: true; identity: BuildIdentity } | { ok: false; reason: BuildIdentityRefusal; isChild: boolean };

/** The refusals of launch checks 1 to 4, and the envelope check a first build adds. Fixed codes. */
export type ChildBuildBlocker = "child_orphaned" | "parent_closed" | "respec_needs_approval" | "key_not_in_approved_spec" | "parent_no_envelope";

/**
 * Launch checks 1 to 4 against the rows as they are now: the parent exists (else `child_orphaned`), is open and in the same repository (else `parent_closed`), its newest approval names its
 * newest unerased Spec version (else `respec_needs_approval`), and the child still belongs to the approved Spec (else `key_not_in_approved_spec`).
 *
 * Check 4 has two forms (R11). A child that has NOT started (stage `triaged`, no run but a cancelled one) needs its pinned version to be the approved one and to hold its key. A child that HAS started
 * stays on its pinned version, so after a re-approval it passes when its key is in the approved version's table; a key that left the table is `key_not_in_approved_spec`.
 *
 * With `envelope` (the default), the build's own extra check follows: the parent has an envelope and the child's is that same one (else `parent_no_envelope`), so a start filed by the generic
 * advance action, which skips the launch gate, cannot build outside the parent's limit. The resolver does not ask for it: a started child's envelope was set at launch.
 *
 * Runs in the caller's tenant transaction, under the child's launch lock (the one the gate takes), so a launch in flight and a start cannot read different rows. It is the launch rule's checks
 * 1 to 4 and 7 again rather than a call to `planned_pr_child_blocker`: that function answers `work_started` first for any child that has a live start request, and the request that brought
 * us here is exactly that.
 */
export async function childBuildBlocker(client: Pick<PoolClient, "query">, accountId: string, childId: string, options: { envelope?: boolean } = {}): Promise<ChildBuildBlocker | null> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`child_launch:${accountId}:${childId}`]);
  const { rows } = await client.query<{
    parent_id: string | null;
    parent_envelope: string | null;
    child_envelope: string | null;
    parent_found: boolean;
    parent_open: boolean | null;
    approved: string | null;
    newest: string | null;
    child_version: string | null;
    key_in_table: boolean | null;
    key_in_approved: boolean | null;
    started: boolean;
  }>(
    `SELECT c.parent_id, p.envelope_id AS parent_envelope, c.envelope_id AS child_envelope, p.id IS NOT NULL AS parent_found, (p.stage <> 'closed' AND p.repo_id IS NOT DISTINCT FROM c.repo_id) AS parent_open,
            ap.spec_version_id AS approved,
            (SELECT s.id FROM spec_versions s WHERE s.account_id = c.account_id AND s.work_item_id = c.parent_id AND s.erased_at IS NULL ORDER BY s.version DESC LIMIT 1) AS newest,
            c.planned_pr_spec_version_id AS child_version,
            (SELECT bool_or((e ->> 'key') = c.planned_pr_key)
               FROM spec_versions sv, LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(sv.frontmatter -> 'planned_prs') = 'array' THEN sv.frontmatter -> 'planned_prs' ELSE '[]'::jsonb END) AS e
              WHERE sv.id = c.planned_pr_spec_version_id AND sv.account_id = c.account_id AND sv.work_item_id = c.parent_id AND sv.erased_at IS NULL) AS key_in_table,
            (SELECT bool_or((e ->> 'key') = c.planned_pr_key)
               FROM spec_versions sv, LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(sv.frontmatter -> 'planned_prs') = 'array' THEN sv.frontmatter -> 'planned_prs' ELSE '[]'::jsonb END) AS e
              WHERE sv.id = ap.spec_version_id AND sv.account_id = c.account_id AND sv.work_item_id = c.parent_id AND sv.erased_at IS NULL) AS key_in_approved,
            (c.stage <> 'triaged' OR EXISTS (SELECT 1 FROM agent_runs r WHERE r.account_id = c.account_id AND r.work_item_id = c.id AND r.status <> 'cancelled')) AS started
       FROM work_items c
       LEFT JOIN work_items p ON p.account_id = c.account_id AND p.id = c.parent_id
       LEFT JOIN LATERAL (SELECT a.spec_version_id FROM work_item_approvals a WHERE a.account_id = c.account_id AND a.work_item_id = c.parent_id ORDER BY a.created_at DESC, a.id DESC LIMIT 1) ap ON true
      WHERE c.id = $1 AND c.account_id = $2 AND c.planned_pr_key IS NOT NULL`,
    [childId, accountId],
  );
  const r = rows[0];
  if (!r || r.parent_id === null || !r.parent_found) return "child_orphaned";
  if (r.parent_open !== true) return "parent_closed";
  if (r.approved === null || r.approved !== r.newest) return "respec_needs_approval";
  if (r.started) {
    if (r.key_in_approved !== true) return "key_not_in_approved_spec";
  } else if (r.child_version !== r.approved || r.key_in_table !== true) {
    return "key_not_in_approved_spec";
  }
  if (options.envelope !== false && (r.parent_envelope === null || r.child_envelope !== r.parent_envelope)) return "parent_no_envelope";
  return null;
}

/** The build's own extra check: the parent has an envelope and the child's is that same one (else `parent_no_envelope`). Null when it holds, or when the item is not a child. */
export async function childEnvelopeBlocker(client: Pick<PoolClient, "query">, accountId: string, childId: string): Promise<"parent_no_envelope" | null> {
  const { rows } = await client.query<{ parent_envelope: string | null; child_envelope: string | null }>(
    `SELECT p.envelope_id AS parent_envelope, c.envelope_id AS child_envelope FROM work_items c LEFT JOIN work_items p ON p.account_id = c.account_id AND p.id = c.parent_id
      WHERE c.id = $1 AND c.account_id = $2 AND c.planned_pr_key IS NOT NULL`,
    [childId, accountId],
  );
  const r = rows[0];
  return r === undefined || (r.parent_envelope !== null && r.child_envelope === r.parent_envelope) ? null : "parent_no_envelope";
}

interface ItemRow {
  planned_pr_key: string | null;
  gh_number: string | null;
  parent_id: string | null;
  parent_found: boolean;
  parent_number: string | null;
  pinned: string | null;
  approved: string | null;
}

/** A recorded child branch, parsed: the parent number and the key. A leading zero or an empty key is not a branch this platform made. */
const RECORDED_CHILD_BRANCH = /^fx\/([1-9][0-9]{0,11})-([a-z0-9-]{1,32})$/;

const positiveInt = (value: string | null): number | null => {
  if (value === null || !/^[1-9][0-9]{0,14}$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
};

/**
 * The branch the item's newest executor run that recorded one used, or null (SANDBOX-RERUN-BRANCH-a). A record is read only when it is this item's own: the run branch of the run that wrote it
 * (`fx/<that run's id>-g1`), the fixed top-level name for this item's number, or a child's `fx/<n>-<this child's key>` (also what an earlier `child.binding` holds). Anything else (another
 * item's number, another key, a malformed uuid, another run's id) is skipped, never read. Nothing is stamped on the item; no record means the caller computes the fixed name.
 */
async function recordedBranch(client: Pick<PoolClient, "query">, accountId: string, itemId: string, own: { fixed: string | null; key: string | null }): Promise<{ branch: string; runShaped: boolean } | null> {
  const { rows } = await client.query<{ run_id: string; branch: string | null }>(
    `SELECT r.id AS run_id, e.payload ->> 'branch' AS branch
       FROM agent_runs r JOIN run_events e ON e.account_id = r.account_id AND e.run_id = r.id AND e.kind = ANY ($3::text[])
      WHERE r.account_id = $1 AND r.work_item_id = $2 AND r.role = 'executor'
      ORDER BY r.created_at DESC, r.id DESC, e.seq DESC LIMIT 50`,
    [accountId, itemId, own.key === null ? [BUILD_BRANCH_KIND] : [BUILD_BRANCH_KIND, "child.binding"]],
  );
  for (const r of rows) {
    const b = r.branch;
    if (typeof b !== "string") continue;
    if (b === sandboxRunBranch(r.run_id)) return { branch: b, runShaped: true };
    if (own.key === null ? b === own.fixed : RECORDED_CHILD_BRANCH.exec(b)?.[2] === own.key) return { branch: b, runShaped: false };
  }
  return null;
}

/**
 * The identity of one work item. `client` must be under the item's tenant (`withTenant`). For a child with `purpose: "start"` it takes the child's launch lock (see `childBuildBlocker`),
 * so call it in a short transaction of its own, not inside a long one.
 *
 * `out.fixed` (optional) is set to the item's fixed branch name (`fx/issue-<n>`, or the child's), whatever the newest run recorded: a reader that pairs EACH run with its own branch (the branch
 * cleanup) needs the name of the runs that have no record. It is not part of the identity.
 */
export async function resolveBuildIdentity(client: Pick<PoolClient, "query">, accountId: string, workItemId: string, purpose: BuildPurpose, out?: { fixed?: string }): Promise<BuildIdentityResult> {
  const found = await client.query<ItemRow>(
    `SELECT w.planned_pr_key, w.gh_number::text AS gh_number, w.parent_id, p.id IS NOT NULL AS parent_found, p.gh_number::text AS parent_number, w.planned_pr_spec_version_id AS pinned,
            (SELECT a.spec_version_id FROM work_item_approvals a WHERE a.account_id = w.account_id AND a.work_item_id = w.id ORDER BY a.created_at DESC, a.id DESC LIMIT 1) AS approved
       FROM work_items w LEFT JOIN work_items p ON p.account_id = w.account_id AND p.id = w.parent_id AND w.planned_pr_key IS NOT NULL
      WHERE w.id = $1 AND w.account_id = $2`,
    [workItemId, accountId],
  );
  const row = found.rows[0];
  if (!row) return { ok: false, reason: "not_found", isChild: false };

  if (row.planned_pr_key === null) {
    const n = positiveInt(row.gh_number);
    if (n === null) return { ok: false, reason: "no_issue_link", isChild: false };
    if (out) out.fixed = branchFor(n);
    const rec = await recordedBranch(client, accountId, workItemId, { fixed: branchFor(n), key: null });
    return { ok: true, identity: { issueNumber: n, branch: rec?.branch ?? branchFor(n), specVersionId: row.approved, isChild: false } };
  }

  const key = row.planned_pr_key;
  if (purpose === "start") {
    const blocked = await childBuildBlocker(client, accountId, workItemId, { envelope: false });
    if (blocked !== null) return { ok: false, reason: blocked as BuildIdentityRefusal, isChild: true };
    const n = positiveInt(row.parent_number);
    if (n === null) return { ok: false, reason: "no_issue_link", isChild: true };
    if (row.pinned === null) return { ok: false, reason: "key_not_in_approved_spec", isChild: true };
    // A start pushes to the pull request already open: the newest run branch if a rebuild made one, else the fixed name computed from the live parent.
    if (out) out.fixed = childBranchFor(n, key);
    const rec = await recordedBranch(client, accountId, workItemId, { fixed: null, key });
    return { ok: true, identity: { issueNumber: n, branch: rec?.runShaped ? rec.branch : childBranchFor(n, key), specVersionId: row.pinned, isChild: true } };
  }

  // observe: no launch checks. What was recorded wins; the live parent is the fallback.
  const recorded = await recordedBranch(client, accountId, workItemId, { fixed: null, key });
  const live = row.parent_id === null || !row.parent_found ? null : positiveInt(row.parent_number);
  const fromRecord = recorded !== null && !recorded.runShaped ? positiveInt(RECORDED_CHILD_BRANCH.exec(recorded.branch)![1]!) : null;
  if (out) out.fixed = live !== null ? childBranchFor(live, key) : recorded !== null && !recorded.runShaped ? recorded.branch : undefined;
  if (recorded !== null && (fromRecord !== null || live !== null)) return { ok: true, identity: { issueNumber: (fromRecord ?? live)!, branch: recorded.branch, specVersionId: row.pinned, isChild: true } };
  if (row.parent_id === null || !row.parent_found || recorded !== null) return { ok: false, reason: "child_orphaned", isChild: true };
  if (live === null) return { ok: false, reason: "no_issue_link", isChild: true };
  return { ok: true, identity: { issueNumber: live, branch: childBranchFor(live, key), specVersionId: row.pinned, isChild: true } };
}
