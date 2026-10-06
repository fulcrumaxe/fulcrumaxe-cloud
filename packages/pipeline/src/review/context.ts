import type { Pool } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import type { WorkItemTier } from "../build/types.js";
import { tierOfKind } from "./reviewPlan.js";

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
  /** `repos.execution_mode`: `runner_local` when the repo's agents run on the customer's machine (D#6). */
  executionMode: string;
  owner: string;
  name: string;
  /** The issue's number (names the executor's branch and sandbox). */
  issue: number;
  tier: WorkItemTier;
  specVersion: number;
  /** The repo's role-setting mode for the debater, or null when it has no row (the debater is then off). */
  debaterMode: string | null;
  /** Raw values of the repository's guard settings; only `@fx/trust` interprets them. */
  autoMerge: unknown;
  blockExternalAutoMerge: unknown;
}

export type ReviewContextRefusal = "not_found" | "external_requires_human" | "no_repo" | "no_issue_link" | "tier_unknown" | "no_spec";
export type LoadReviewContextResult = { ok: true; ctx: ReviewContext } | { ok: false; reason: ReviewContextRefusal };

interface Row {
  stage: string;
  provenance: string;
  repo_id: string | null;
  execution_mode: string | null;
  gh_number: string | null;
  gh_owner: string | null;
  gh_name: string | null;
  kind: string | null;
  version: number | null;
  debater_mode: string | null;
  auto_merge: unknown;
  block_external: unknown;
}

export async function loadReviewContext(pool: Pool, accountId: string, workItemId: string): Promise<LoadReviewContextResult> {
  const row = await withTenant(pool, accountId, async (client) => {
    const { rows } = await client.query<Row>(
      `SELECT w.stage, w.provenance, w.repo_id, r.execution_mode, w.gh_number, r.gh_owner, r.gh_name, d.kind, s.version,
              (SELECT rs.mode FROM role_settings rs WHERE rs.account_id = w.account_id AND rs.repo_id = w.repo_id AND rs.role = 'debater') AS debater_mode,
              r.settings->'autoMerge' AS auto_merge, r.settings->'blockExternalAutoMerge' AS block_external
         FROM work_items w
         LEFT JOIN repos r ON r.account_id = w.account_id AND r.id = w.repo_id
         LEFT JOIN discussions d ON d.account_id = w.account_id AND d.id = w.discussion_id
         LEFT JOIN LATERAL (
           SELECT sv.version FROM spec_versions sv
            WHERE sv.account_id = w.account_id AND sv.work_item_id = w.id AND sv.erased_at IS NULL
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
      executionMode: row.execution_mode ?? "sandbox",
      owner: row.gh_owner,
      name: row.gh_name,
      issue: Number(row.gh_number),
      tier,
      specVersion: Number(row.version),
      debaterMode: row.debater_mode,
      autoMerge: row.auto_merge,
      blockExternalAutoMerge: row.block_external,
    },
  };
}

/** The Spec text of one version, or null when that version is gone (erased) or was replaced as the newest. */
export async function loadSpecText(pool: Pool, accountId: string, workItemId: string, expectedVersion: number): Promise<{ version: number; body: string } | null> {
  return withTenant(pool, accountId, async (client) => {
    const { rows } = await client.query<{ version: number; body: string }>(
      "SELECT version, body FROM spec_versions WHERE account_id = $1 AND work_item_id = $2 AND erased_at IS NULL ORDER BY version DESC LIMIT 1",
      [accountId, workItemId],
    );
    const r = rows[0];
    // The Spec the person approved is the one reviewed: a newer version appearing in between stops the driver.
    return r && Number(r.version) === expectedVersion ? { version: Number(r.version), body: r.body } : null;
  });
}
