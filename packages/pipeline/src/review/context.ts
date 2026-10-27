import type { Pool } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { effectiveModeSql } from "@fx/runner";
import type { WorkItemTier } from "../build/types.js";
import { tierOfKind } from "./reviewPlan.js";
import { childBranchFor } from "../advance/childBuild.js";

/**
 * D#483 P3: what the review stage reads about a work item before it starts anything, in one tenant-scoped read. Facts
 * only: the repository's coordinates (from its own table), the item's tier (the discussion's kind), the newest published
 * Spec's version, the repository's debater role setting and its auto-merge guard settings. The Spec's TEXT is not in the
 * small context the workflow keeps; `loadSpecText` reads it inside the step that builds a prompt.
 */

export interface ReviewContext {
  workItemId: string;
  stage: string;
  provenance: string;
  repoId: string;
  /** `repos.gh_repo_id`, the numeric GitHub repository id (D#6 M1G-a: what the operator's human-merge-only list names). Null when unreadable. */
  ghRepoId: string | null;
  /** The EFFECTIVE mode (D#599 PL-2): the item's placement, else `repos.execution_mode`. `runner_local` when the item's agents run on the customer's machine (D#6). */
  executionMode: string;
  owner: string;
  name: string;
  /** The issue's number (names the executor's branch and sandbox). For a planned PR child it is the PARENT's. */
  issue: number;
  /** D#483 S5-b2c-2: a planned PR child's own branch (`fx/<parent#>-<key>`), which its reviews and fix rounds use. Absent for every other item (`fx/issue-<n>`). */
  branch?: string;
  tier: WorkItemTier;
  specVersion: number;
  /** Fix rounds already started for the item (the driver events): review round N is the one after N-1 fix rounds. */
  fixRoundsStarted: number;
  /** The repo's role-setting mode for the debater, or null when it has no row (the debater is then off). */
  debaterMode: string | null;
  /** Raw values of the repository's guard settings; only `@fx/trust` interprets them. */
  autoMerge: unknown;
  blockExternalAutoMerge: unknown;
  /**
   * A person pressed Request changes and the fix round that carries their note has not taken it yet: a transition into Changes requested whose source
   * names a run note (`request_changes:<id>`) that is still `accepted`. Derived from the rows, never stamped: the fix run stamps the note `applied`.
   */
  personRequestPending: boolean;
}

export type ReviewContextRefusal = "not_found" | "external_requires_human" | "no_repo" | "no_issue_link" | "tier_unknown" | "no_spec";
export type LoadReviewContextResult = { ok: true; ctx: ReviewContext } | { ok: false; reason: ReviewContextRefusal };

interface Row {
  stage: string;
  provenance: string;
  repo_id: string | null;
  gh_repo_id: string | null;
  execution_mode: string | null;
  gh_number: string | null;
  gh_owner: string | null;
  gh_name: string | null;
  kind: string | null;
  version: number | null;
  planned_pr_key: string | null;
  fix_rounds: string | null;
  debater_mode: string | null;
  auto_merge: unknown;
  block_external: unknown;
  person_request: boolean;
}

export async function loadReviewContext(pool: Pool, accountId: string, workItemId: string): Promise<LoadReviewContextResult> {
  const row = await withTenant(pool, accountId, async (client) => {
    const { rows } = await client.query<Row>(
      `SELECT w.stage, w.provenance, w.repo_id, r.gh_repo_id, ${effectiveModeSql("w", "r")} AS execution_mode, CASE WHEN w.planned_pr_key IS NULL THEN w.gh_number ELSE p.gh_number END AS gh_number, r.gh_owner, r.gh_name,
              CASE WHEN w.planned_pr_key IS NULL THEN d.kind ELSE w.kind END AS kind, s.version, w.planned_pr_key,
              (SELECT count(*)::text FROM work_item_driver_events e WHERE e.account_id = w.account_id AND e.work_item_id = w.id AND e.kind = 'fix_round_started') AS fix_rounds,
              (SELECT rs.mode FROM role_settings rs WHERE rs.account_id = w.account_id AND rs.repo_id = w.repo_id AND rs.role = 'debater') AS debater_mode,
              r.settings->'autoMerge' AS auto_merge, r.settings->'blockExternalAutoMerge' AS block_external,
              EXISTS (SELECT 1 FROM work_item_transitions t
                        JOIN work_item_corrections c ON c.account_id = t.account_id AND c.work_item_id = t.work_item_id AND t.source_ref = 'request_changes:' || c.id::text
                       WHERE t.account_id = w.account_id AND t.work_item_id = w.id AND t.to_stage = 'changes_requested'
                         AND c.kind = 'run_note' AND c.status = 'accepted') AS person_request
         FROM work_items w
         LEFT JOIN work_items p ON p.account_id = w.account_id AND p.id = w.parent_id AND w.planned_pr_key IS NOT NULL
         LEFT JOIN repos r ON r.account_id = w.account_id AND r.id = w.repo_id
         LEFT JOIN discussions d ON d.account_id = w.account_id AND d.id = w.discussion_id
         LEFT JOIN LATERAL (
           SELECT sv.version FROM spec_versions sv
            WHERE sv.account_id = w.account_id AND sv.erased_at IS NULL
              AND (CASE WHEN w.planned_pr_key IS NULL THEN sv.work_item_id = w.id ELSE sv.id = w.planned_pr_spec_version_id AND sv.work_item_id = w.parent_id END)
            ORDER BY sv.version DESC LIMIT 1
         ) s ON true
        WHERE w.id = $1 AND w.account_id = $2`,
      [workItemId, accountId],
    );
    return rows[0] ?? null;
  });
  if (row === null) return { ok: false, reason: "not_found" };
  // Fail closed, as the intake gate does: only the exact literal "internal" is internal.
  if (row.provenance !== "internal") return { ok: false, reason: "external_requires_human" };
  if (!row.repo_id || !row.gh_owner || !row.gh_name) return { ok: false, reason: "no_repo" };
  if (row.gh_number === null) return { ok: false, reason: "no_issue_link" };
  const tier = tierOfKind(row.kind);
  if (tier === null) return { ok: false, reason: "tier_unknown" };
  if (row.version === null) return { ok: false, reason: "no_spec" };
  return {
    ok: true,
    ctx: {
      workItemId,
      stage: row.stage,
      provenance: row.provenance,
      repoId: row.repo_id,
      ghRepoId: row.gh_repo_id === null || row.gh_repo_id === undefined ? null : String(row.gh_repo_id),
      executionMode: row.execution_mode ?? "sandbox",
      owner: row.gh_owner,
      name: row.gh_name,
      issue: Number(row.gh_number),
      ...(row.planned_pr_key === null ? {} : { branch: childBranchFor(Number(row.gh_number), row.planned_pr_key) }),
      tier,
      specVersion: Number(row.version),
      fixRoundsStarted: Number(row.fix_rounds ?? "0"),
      debaterMode: row.debater_mode,
      autoMerge: row.auto_merge,
      blockExternalAutoMerge: row.block_external,
      personRequestPending: row.person_request === true,
    },
  };
}

/** The Spec text of one version, or null when that version is gone (erased) or was replaced as the newest. */
export async function loadSpecText(pool: Pool, accountId: string, workItemId: string, expectedVersion: number): Promise<{ version: number; body: string } | null> {
  return withTenant(pool, accountId, async (client) => {
    // A planned PR child reviews against the Spec version it names (a version of its parent); everything else against its own newest.
    const { rows } = await client.query<{ version: number; body: string }>(
      `SELECT sv.version, sv.body FROM work_items w JOIN spec_versions sv ON sv.account_id = w.account_id AND sv.erased_at IS NULL
          AND (CASE WHEN w.planned_pr_key IS NULL THEN sv.work_item_id = w.id ELSE sv.id = w.planned_pr_spec_version_id AND sv.work_item_id = w.parent_id END)
        WHERE w.id = $2 AND w.account_id = $1 ORDER BY sv.version DESC LIMIT 1`,
      [accountId, workItemId],
    );
    const r = rows[0];
    // The Spec the person approved is the one reviewed: a newer version appearing in between stops the driver.
    return r && Number(r.version) === expectedVersion ? { version: Number(r.version), body: r.body } : null;
  });
}
