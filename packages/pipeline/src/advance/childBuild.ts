import type { PoolClient } from "pg";
import { cleanWorkItemTitle } from "@fx/core/src/work-items/title.js";

/**
 * D#483 S5-b2c-1 / S5-b2c-2: the pairing guard between the child launch gate and the build.
 *
 * The launch gate (the sweep's child pass, a person's Approve on a planned PR) files a child's start only while this is true. It is true now: `startBuildForItem` builds for a
 * planned PR child (the parent's issue number, the parent's Spec version named by the child, its own branch `childBranchFor`). It stays code, not a setting: no environment
 * variable or database value can turn the gate on ahead of the build.
 */
export const CHILD_BUILD_SUPPORTED = true;

/** The key's pattern (`^[a-z0-9-]{1,32}$`, never `fix-`/`check-`) keeps `fx/<parent#>-<key>` a safe, unique ref: no `issue` prefix is a number, and a runner branch is `fx/<uuid>-g<n>`. */
export const childBranchFor = (parentNumber: number, key: string): string => `fx/${parentNumber}-${key}`;

/** What stands in for a title that is empty, or that would carry a closing keyword into the prompt. */
export const CHILD_TITLE_FALLBACK = "this planned PR";

/** `Closes #1`, `fixed: #2`, `resolves owner/repo#3`, `closes https://github.com/o/r/issues/4`: the words GitHub reads as closing an issue when they sit in a pull request body. */
const CLOSING_KEYWORD = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b[\s:]*(?:(?:https?:\/\/)?(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d|(?:[\w.-]+\/[\w.-]+)?#\d)/i;

/**
 * The child's title as it may appear in a prompt: `cleanWorkItemTitle`'s output (the stored title is not trusted as prompt text), or the fixed fallback when nothing printable
 * is left or the cleaned text would read as a closing keyword. The prompt never names a title any other way.
 */
export function childPromptTitle(stored: unknown): string {
  const cleaned = cleanWorkItemTitle(stored);
  return cleaned === null || CLOSING_KEYWORD.test(cleaned) ? CHILD_TITLE_FALLBACK : cleaned;
}

/** The refusals of section 2 checks 1 to 4, re-run at build start (time passes between the launch and the build). Fixed codes. */
export type ChildBuildBlocker = "child_orphaned" | "parent_closed" | "respec_needs_approval" | "key_not_in_approved_spec" | "parent_no_envelope";

/**
 * Checks 1 to 4 of the launch rule against the rows as they are now: the parent exists (else `child_orphaned`), is open, in the same repository (else `parent_closed`), its
 * newest approval names its newest unerased Spec version (else `respec_needs_approval`), and that version is the child's own and holds the child's key (else
 * `key_not_in_approved_spec`). Then the envelope: the parent has one and the child's is that same one (else `parent_no_envelope`), so a start filed by the generic advance action,
 * which skips the launch gate, cannot build outside the parent's limit. Null: the child may build.
 *
 * Runs in the caller's tenant transaction, under the child's launch lock (the one the gate takes), so a launch in flight and a build start cannot read different rows. It is the
 * launch rule's checks 1 to 4 and 7 again rather than a call to `planned_pr_child_blocker`: that function answers `work_started` first for any child that has a live start request,
 * and the request that brought us here is exactly that, so it could never see the checks behind it.
 */
export async function childBuildBlocker(client: Pick<PoolClient, "query">, accountId: string, childId: string): Promise<ChildBuildBlocker | null> {
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
  }>(
    `SELECT c.parent_id, p.envelope_id AS parent_envelope, c.envelope_id AS child_envelope, p.id IS NOT NULL AS parent_found, (p.stage <> 'closed' AND p.repo_id IS NOT DISTINCT FROM c.repo_id) AS parent_open,
            (SELECT a.spec_version_id FROM work_item_approvals a WHERE a.account_id = c.account_id AND a.work_item_id = c.parent_id ORDER BY a.created_at DESC, a.id DESC LIMIT 1) AS approved,
            (SELECT s.id FROM spec_versions s WHERE s.account_id = c.account_id AND s.work_item_id = c.parent_id AND s.erased_at IS NULL ORDER BY s.version DESC LIMIT 1) AS newest,
            c.planned_pr_spec_version_id AS child_version,
            (SELECT bool_or((e ->> 'key') = c.planned_pr_key)
               FROM spec_versions sv, LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(sv.frontmatter -> 'planned_prs') = 'array' THEN sv.frontmatter -> 'planned_prs' ELSE '[]'::jsonb END) AS e
              WHERE sv.id = c.planned_pr_spec_version_id AND sv.account_id = c.account_id AND sv.work_item_id = c.parent_id AND sv.erased_at IS NULL) AS key_in_table
       FROM work_items c LEFT JOIN work_items p ON p.account_id = c.account_id AND p.id = c.parent_id
      WHERE c.id = $1 AND c.account_id = $2 AND c.planned_pr_key IS NOT NULL`,
    [childId, accountId],
  );
  const r = rows[0];
  if (!r || r.parent_id === null || !r.parent_found) return "child_orphaned";
  if (r.parent_open !== true) return "parent_closed";
  if (r.approved === null || r.approved !== r.newest) return "respec_needs_approval";
  if (r.child_version !== r.approved || r.key_in_table !== true) return "key_not_in_approved_spec";
  if (r.parent_envelope === null || r.child_envelope !== r.parent_envelope) return "parent_no_envelope";
  return null;
}
