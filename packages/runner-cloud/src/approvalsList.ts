import { withTenant } from "@fx/db/src/withTenant.js";
import { UNNAMED_MEMBER, requireMemberRole } from "./memberRole.js";
import { readUnapprovedRunFacts, waitReasonOf } from "./readModel.js";
import type { RunnerCloudDeps, RunnerHttpResponse, SessionPrincipal } from "./http.js";

/** The most waiting runs one read returns. */
export const APPROVALS_LIMIT = 50;
/** Pending unapproved runs looked at before the reason filter, so a long queue of other waits cannot hide a run that is waiting for approval. */
const SCAN_LIMIT = 500;

export interface ApprovalEntry {
  run_id: string;
  work_item_id: string | null;
  role: string;
  repo_name: string;
  created_at: string;
  /** Registrants of the live subscription runners that cover the run's repo: the people whose click (or consent) lets it run. */
  approvers: Array<{ id: string; name: string }>;
  /** True only when the signed-in user is one of the approvers. */
  can_approve: boolean;
}

/**
 * GET /api/runners/approvals (a session route, any member). The account's runs that read `waiting_for_approval` right now, newest first,
 * at most 50, derived from the same facts and the same decision as `getRunWaitReason` (so a run whose runner, dial or consent would let it
 * go ahead is not listed). It reads through the caller's tenant context only, so another account's run is not here. A name is the member's
 * name, else their GitHub login, else a fixed fallback: never null, empty, an email or an id. `no-store`.
 */
export async function listApprovals(deps: RunnerCloudDeps, principal: SessionPrincipal): Promise<RunnerHttpResponse> {
  const now = (deps.now ?? (() => new Date()))();
  const approvals = await withTenant(deps.appUserPool, principal.accountId, principal.userId, async (client): Promise<ApprovalEntry[]> => {
    await requireMemberRole(client);
    const waiting = (await readUnapprovedRunFacts(client, principal.accountId, now, SCAN_LIMIT))
      .filter((run) => run.dispatch_repo_id !== null && waitReasonOf(run, now) === "waiting_for_approval")
      .slice(0, APPROVALS_LIMIT);
    if (waiting.length === 0) return [];
    const repoIds = [...new Set(waiting.map((run) => run.dispatch_repo_id!))];
    const repos = new Map(
      (
        await client.query<{ id: string; name: string }>(
          "SELECT id, COALESCE(NULLIF(gh_owner || '/' || gh_name, ''), 'a repository') AS name FROM repos WHERE id = ANY($1::uuid[])",
          [repoIds],
        )
      ).rows.map((r) => [r.id, r.name]),
    );
    const byRepo = new Map<string, Map<string, string>>();
    const { rows: approverRows } = await client.query<{ repo_id: string; id: string; name: string }>(
      `SELECT DISTINCT rp AS repo_id, r.registered_by AS id, COALESCE(NULLIF(u.name, ''), NULLIF(u.github_login, ''), $2) AS name
         FROM runners r LEFT JOIN users u ON u.id = r.registered_by
              CROSS JOIN LATERAL unnest(r.allowed_repo_ids) rp
        WHERE r.account_id = $1 AND r.revoked_at IS NULL AND r.credential_mode = 'subscription' AND rp = ANY($3::uuid[])`,
      [principal.accountId, UNNAMED_MEMBER, repoIds],
    );
    for (const a of approverRows) {
      const people = byRepo.get(a.repo_id) ?? new Map<string, string>();
      people.set(a.id, a.name);
      byRepo.set(a.repo_id, people);
    }
    return waiting.map((run) => {
      const people = [...(byRepo.get(run.dispatch_repo_id!) ?? new Map<string, string>())].map(([id, name]) => ({ id, name })).sort((x, y) => x.name.localeCompare(y.name) || x.id.localeCompare(y.id));
      return {
        run_id: run.id,
        work_item_id: run.work_item_id,
        role: run.role,
        repo_name: repos.get(run.dispatch_repo_id!) ?? "a repository",
        created_at: run.created_at.toISOString(),
        approvers: people,
        can_approve: people.some((p) => p.id === principal.userId),
      };
    });
  });
  return { status: 200, body: { approvals }, headers: { "cache-control": "no-store" } };
}
