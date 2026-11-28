import type { PoolClient } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { COPY, platformRow, preflightView, type PlatformId } from "@fulcrumaxe/runner-protocol";
import type { RunnerCloudDeps, RunnerHttpResponse, SessionPrincipal } from "./http.js";
import { readSandboxViews } from "./fleetSandboxes.js";
import { readFleet, type ReportedFactsLoader } from "./readModel.js";

/**
 * What each runner reported about its machine on `hello` (os, arch, sandbox engine), for the fleet page to show. This is the one reader of
 * `runner_facts` besides the hello route, and it lives here, apart from readModel.ts, because the request verifier's import graph reaches readModel.ts
 * and must never name the facts (D#605 FL-2 acceptance 4). Display only: nothing reads these values to decide anything.
 */
/**
 * D#587 B-7c: how a machine stands, in the words of the runner's own support table (`platformSupport.ts`): the row for what the runner reported (`platform`, else its `os`), so a WSL2 or macOS machine reads its row's label
 * (a preview) and never Linux's "supported". The table's markdown (bold marks, the pointer to the README) is dropped. Null when there is no row: the screen then says nothing about support.
 */
export function supportText(platform: string | null, os: string): string | null {
  try {
    return platformRow((platform ?? os) as PlatformId).label.replaceAll("**", "").replace(" (see below)", "");
  } catch {
    // fx-swallow-ok: a value the table does not know has no row; nothing is claimed
    return null;
  }
}

export const readReportedFacts: ReportedFactsLoader = async (client: PoolClient, accountId: string) => {
  // D#845 ON-21b: the preflight codes sit on the runner's own row; both tables are named by the account, on top of row security. What is shown is only what the closed set names, each with its fixed line.
  const { rows } = await client.query<{ runner_id: string; os: string; arch: string; sandbox_engine: string; platform: string | null; preflight: string[] | null }>(
    `SELECT f.runner_id, f.os, f.arch, f.sandbox_engine, f.platform, r.preflight FROM runner_facts f
       LEFT JOIN runners r ON r.id = f.runner_id AND r.account_id = f.account_id
      WHERE f.account_id = $1`,
    [accountId],
  );
  return new Map(rows.map((r) => [r.runner_id, { os: r.os, arch: r.arch, engine: r.sandbox_engine, platform: r.platform, support: supportText(r.platform, r.os), preflight: r.preflight === null ? null : preflightView(r.preflight) }]));
};

/**
 * When each machine was linked and the address its link request came from (D#845 ON-7a2), for owners and admins only. The table is its own because a column on
 * `runners` would be readable by every member; its policy is owner or admin of the account, and this read names the account on top of it and is skipped for
 * anyone else. No country: nothing here looks an address up anywhere.
 */
async function readLinkFacts(deps: RunnerCloudDeps, principal: SessionPrincipal, role: "owner" | "admin" | "member" | null): Promise<Map<string, { at: string; ip: string | null }>> {
  if (role !== "owner" && role !== "admin") return new Map();
  const { rows } = await withTenant(deps.appUserPool, principal.accountId, principal.userId, (client) =>
    client.query<{ runner_id: string; linked_at: Date; ip: string | null }>("SELECT runner_id, linked_at, host(linked_from_ip) AS ip FROM runner_link_facts WHERE account_id = $1", [principal.accountId]),
  );
  return new Map(rows.map((r) => [r.runner_id, { at: r.linked_at.toISOString(), ip: r.ip }]));
}

/**
 * GET /api/runners (a session route, any member of the account). The runners with their derived state and consent, the caller's role, the account
 * line, and the copy strings the runner screens show, so the UI never retypes them. A runner's key, thumbprint and nonces are not selected, so they
 * cannot be returned. Its repo list is returned as `{ id, name }` pairs, and only for repos the caller's tenant context can read.
 */
export async function listRunners(deps: RunnerCloudDeps, principal: SessionPrincipal): Promise<RunnerHttpResponse> {
  const { runners, viewer, account } = await readFleet(deps, principal.accountId, principal.userId, readReportedFacts);
  // D#587 B-7b-ii: each runner's sandboxes, host limits and recent sandbox commands, for display. Read apart from the fleet so nothing about them reaches a decision.
  const sandboxes = await readSandboxViews(deps, principal.accountId, principal.userId);
  const links = await readLinkFacts(deps, principal, viewer?.role ?? null);
  return {
    status: 200,
    body: {
      runners: runners.map((r) => ({ ...r, sandboxes: sandboxes.get(r.id) ?? null, linked_at: links.get(r.id)?.at ?? null, linked_from_ip: links.get(r.id)?.ip ?? null })),
      viewer,
      account,
      copy: {
        usageLimits: COPY.usageLimits,
        approval: COPY.approval,
        runner: COPY.runner,
        localOnly: COPY.localOnly,
        sandboxUnavailable: COPY.sandboxUnavailable,
        approvalMine: COPY.approvalMine,
        approvalButton: COPY.approvalButton,
        approvalDone: COPY.approvalDone,
        approvalRefused: COPY.approvalRefused,
        approvalAuto: COPY.approvalAuto,
        planConsentText: COPY.planConsentText,
        dialRunnerRuns: COPY.dialRunnerRuns,
        dialRunnerRunsAsk: COPY.dialRunnerRunsAsk,
        dialRunnerRunsAnnounce: COPY.dialRunnerRunsAnnounce,
        dialRunnerRunsAct: COPY.dialRunnerRunsAct,
      },
    },
    headers: { "cache-control": "no-store" },
  };
}
