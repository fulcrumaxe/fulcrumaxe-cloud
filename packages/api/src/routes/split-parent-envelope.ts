import type { PoolClient } from "pg";
import { AmountRequiredError } from "../errors.js";
import { planEnvelope } from "./proposal-envelopes.js";

/** The kinds `estimateItem` can price; a work item's own `kind` is one of them once triage has run, else its discussion's kind is. */
const PRICED_KINDS: ReadonlySet<string> = new Set(["critical", "feature", "small", "bug", "doc"]);

/**
 * The spend limit a person's approval gives a split parent: a parent whose approved Spec version planned two or more pull requests.
 *
 * Its children draw on the parent's envelope, so a parent with none holds every child (`parent_no_envelope`). The card's approval is the only
 * place a person can attach one, and by then the item is past Triaged, which the setter normally refuses; the setter (migration 0929) lets exactly this
 * call through: the item has no envelope, and the approval was written in this same transaction with at least two children.
 *
 * The amount is the proposal approval's rule, unchanged: the item is priced by `estimateItem` (its kind as the category), times (1 + the account's margin),
 * capped at what the account can still spend this month. Runs inside the approval's transaction, so a refusal rolls the approval back.
 *
 * Returns the attached envelope id, or null when nothing was attached (the item already has an envelope, it is not a split parent, or it cannot be priced).
 */
export async function attachSplitParentEnvelope(client: PoolClient, input: { accountId: string; workItemId: string }): Promise<string | null> {
  const { rows } = await client.query<{ repo_id: string | null; title: string; kind: string; discussion_kind: string | null; envelope_id: string | null; children: string }>(
    `SELECT w.repo_id, w.title, w.kind, (SELECT d.kind FROM discussions d WHERE d.id = w.discussion_id) AS discussion_kind, w.envelope_id,
            (SELECT count(*) FROM work_items c
              WHERE c.parent_id = w.id AND c.planned_pr_key IS NOT NULL
                AND c.planned_pr_spec_version_id = (SELECT a.spec_version_id FROM work_item_approvals a WHERE a.work_item_id = w.id ORDER BY a.created_at DESC, a.id DESC LIMIT 1)) AS children
       FROM work_items w WHERE w.id = $1`,
    [input.workItemId],
  );
  const item = rows[0];
  if (!item || item.envelope_id !== null || item.repo_id === null || Number(item.children) < 2) return null;
  const category = PRICED_KINDS.has(item.kind) ? item.kind : item.discussion_kind;
  try {
    const attach = await planEnvelope({ accountId: input.accountId, scope: "item" })(client, [
      { id: input.workItemId, repo_id: item.repo_id, title: item.title, summary: null, category_hint: category },
    ]);
    return (await attach(client, input.workItemId)).envelope_id;
  } catch (err) {
    // An item that cannot be priced has no pre-fill and this click takes no amount: the approval stands, as it did before, and the children stay held.
    if (err instanceof AmountRequiredError) return null;
    throw err;
  }
}
