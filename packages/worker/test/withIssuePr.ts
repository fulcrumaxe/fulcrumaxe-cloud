import type { PoolClient } from "pg";
import type { FixRoundHeadPorts } from "../src/fixRoundHeads.js";

/**
 * FIXROUND-BASE-SYNC-SANDBOX: a sandbox review fix round arrives with the pull request the review step just found on GitHub (`{ number, branch: fx/issue-<n> }`),
 * and its branch is synced with its base first. Tests that start such rounds without caring about the sync wrap their module with this: it adds that pull
 * request (the item's own issue branch) to a sandbox-mode round that has none, and `upToDateHeads` is the GitHub port that finds nothing to merge.
 */
export const upToDateHeads = (head: string): FixRoundHeadPorts => ({ privateHead: async () => head, syncBase: async () => ({ kind: "up_to_date", baseSha: "f".repeat(40), baseRef: "main", stacked: false }) });

type Who = { accountId: string; workItemId: string };
type Req = { pr?: { number: number; branch: string } };

export function withIssuePr<M extends { advanceStartFix: (who: never, req: never) => Promise<unknown> }>(module: M, admin: PoolClient): M {
  const inner = module.advanceStartFix as unknown as (who: Who, req: Req) => Promise<unknown>;
  const advanceStartFix = async (who: Who, req: Req) => {
    if (req.pr !== undefined) return inner(who, req);
    const r = await admin.query<{ gh_number: string; execution_mode: string }>(
      "SELECT w.gh_number, CASE w.placement WHEN 'cloud' THEN 'sandbox' WHEN 'runner' THEN 'runner_local' ELSE r.execution_mode END AS execution_mode FROM work_items w JOIN repos r ON r.id = w.repo_id WHERE w.id = $1",
      [who.workItemId],
    );
    const row = r.rows[0];
    return inner(who, row && row.execution_mode === "sandbox" ? { ...req, pr: { number: 41, branch: `fx/issue-${row.gh_number}` } } : req);
  };
  return { ...module, advanceStartFix } as M;
}
