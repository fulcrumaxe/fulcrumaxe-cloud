import type { PoolClient } from "pg";
import { reportError } from "@fx/telemetry";
import { withTenant } from "@fx/db/src/withTenant.js";
import type { RunnerCloudDeps } from "./http.js";
import { requireMemberRole } from "./memberRole.js";
import { RunPullRequestError } from "./runPullRequest.js";

/**
 * D#845 ON-27d4c: Merge on a private twin's card. The person's click merges the twin's open PUBLISH pull request on the public repository (the sync pull request is the engine's to review and merge, so it has no Merge).
 * The number and the repository come from OUR rows (`repo_twins.publish_pr` and the `repos` row of the public side), never from the request, which names nothing but the twin.
 *
 * It is the same merge the install pull request's Merge button makes (`mergeInstall`: the App, one call, squash, pinned to the head it saw), so GitHub itself refuses a merge whose head moved in between (409), and a branch rule or a
 * missing check (405) is "blocked": nothing is forced, and the person finishes those on GitHub. Before the call it reads the pull request back through the App: it must be open (a closed one is `pr_changed`), and its head must be
 * exactly the commit the cloud recorded when it verified the push (`publish_head`). A twin with no recorded head, or a head that moved, is `pr_changed`: the merge is never made unpinned. A pull request already merged is `already`:
 * the pull request webhook records a merge, this route never does.
 *
 * Owner or admin only (a session; the route takes no token). A twin that is not the caller's, or an id that is no uuid, is `not_found`; a twin that is not ready, paused or in conflict is `twin_state`. A GitHub that cannot be asked, or
 * an App with no port, is `github_unavailable` and nothing was merged. A merge this call made writes one `twin.merged` audit row (`twin_merge_record`, migration 1117; payload twin, pr, number); `already` writes none. Once GitHub
 * has merged, the answer is `merged` whatever the audit write does: a write that throws or answers anything but `ok` is reported under the one fixed class `twin.merge_audit_failed` (counted, no text) and the merge stands.
 */
export type TwinMerge =
  | { result: "merged" | "already"; pr: number }
  | { result: "not_found" | "no_open_pr" | "pr_changed" | "pr_blocked" | "github_unavailable" }
  | { result: "twin_state"; state: string };

const MERGEABLE = new Set(["ready", "paused", "conflict"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the report names when the audit row of a merge GitHub already made could not be written: a class and a code, no message. */
export class TwinMergeAuditFailed extends Error {
  static fixedMessage = "twin.merge_audit_failed";
  readonly code = "twin_merge_audit_failed";
}
export const TWIN_MERGE_AUDIT_FAILED_STAGE = "twin.merge_audit_failed";

interface Row { state: string; pr: number | null; head: string | null; repo_id: string | null; gh_owner: string | null; gh_name: string | null }

async function load(client: PoolClient, accountId: string, twinId: string): Promise<Row | null> {
  const { rows } = await client.query<Row>(
    `SELECT t.state, t.publish_pr AS pr, t.publish_head AS head, r.id AS repo_id, r.gh_owner, r.gh_name
       FROM repo_twins t LEFT JOIN repos r ON r.account_id = t.account_id AND r.id = t.public_repo_id
      WHERE t.account_id = $1 AND t.id = $2`,
    [accountId, twinId],
  );
  return rows[0] ?? null;
}

export async function mergeTwinPr(deps: Pick<RunnerCloudDeps, "appUserPool" | "setupInstall">, principal: { accountId: string; userId: string }, twinId: string): Promise<TwinMerge> {
  if (!UUID.test(twinId)) return { result: "not_found" };
  const id = twinId.toLowerCase();
  const found = await withTenant(deps.appUserPool, principal.accountId, principal.userId, async (client) => {
    const role = await requireMemberRole(client);
    if (role !== "owner" && role !== "admin") return "forbidden" as const;
    return load(client, principal.accountId, id);
  });
  if (found === "forbidden") throw Object.assign(new Error("twin merge: owner or admin only"), { code: "42501" });
  if (found === null) return { result: "not_found" };
  if (!MERGEABLE.has(found.state)) return { result: "twin_state", state: found.state };
  if (found.pr === null || found.repo_id === null || found.gh_owner === null || found.gh_name === null) return { result: "no_open_pr" };
  const port = deps.setupInstall ?? null;
  if (port === null) return { result: "github_unavailable" };
  const number = found.pr;
  const repo = { id: found.repo_id, owner: found.gh_owner, name: found.gh_name };
  let out: "merged" | "changed" | "blocked";
  try {
    const pr = await port.installPullRequest({ repo, number });
    if (pr === null || pr.state === "CLOSED") return { result: "pr_changed" };
    if (pr.merged) return { result: "already", pr: number };
    if (found.head === null || pr.headSha !== found.head) return { result: "pr_changed" };
    out = await port.mergeInstall({ repo, number, sha: pr.headSha });
  } catch (error) {
    // fx-swallow-ok: a GitHub failure carries a name or a body at most; the person is told only that GitHub could not be asked
    if (error instanceof RunPullRequestError) return { result: "github_unavailable" };
    throw error;
  }
  if (out === "changed") return { result: "pr_changed" };
  if (out === "blocked") return { result: "pr_blocked" };
  // A person's action: one `twin.merged` audit row (migration 1117), only for the merge this call made. GitHub has merged, so nothing here may turn the answer into a failure.
  try {
    const res = await withTenant(deps.appUserPool, principal.accountId, principal.userId, (client) => client.query<{ o_result: string }>("SELECT o_result FROM twin_merge_record($1::uuid, 'publish', $2::integer)", [id, number]));
    if (res.rows[0]?.o_result !== "ok") reportError(new TwinMergeAuditFailed(), { stage: TWIN_MERGE_AUDIT_FAILED_STAGE });
  } catch {
    // fx-swallow-ok: the merge is done on GitHub; the failed audit write is reported under its one fixed class, with no text from the error
    reportError(new TwinMergeAuditFailed(), { stage: TWIN_MERGE_AUDIT_FAILED_STAGE });
  }
  return { result: "merged", pr: number };
}
