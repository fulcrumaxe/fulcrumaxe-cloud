import type { PoolClient } from "pg";
import { COPY } from "@fulcrumaxe/runner-protocol";
import type { RunnerCloudDeps, RunnerHttpResponse, SessionPrincipal } from "./http.js";
import { readFleet, type ReportedFactsLoader } from "./readModel.js";

/**
 * What each runner reported about its machine on `hello` (os, arch, sandbox engine), for the fleet page to show. This is the one reader of
 * `runner_facts` besides the hello route, and it lives here, apart from readModel.ts, because the request verifier's import graph reaches readModel.ts
 * and must never name the facts (D#605 FL-2 acceptance 4). Display only: nothing reads these values to decide anything.
 */
const readReportedFacts: ReportedFactsLoader = async (client: PoolClient, accountId: string) => {
  const { rows } = await client.query<{ runner_id: string; os: string; arch: string; sandbox_engine: string }>(
    "SELECT runner_id, os, arch, sandbox_engine FROM runner_facts WHERE account_id = $1",
    [accountId],
  );
  return new Map(rows.map((r) => [r.runner_id, { os: r.os, arch: r.arch, engine: r.sandbox_engine }]));
};

/**
 * GET /api/runners (a session route, any member of the account). The runners with their derived state and consent, the caller's role, the account
 * line, and the copy strings the runner screens show, so the UI never retypes them. A runner's key, thumbprint and nonces are not selected, so they
 * cannot be returned. Its repo list is returned as `{ id, name }` pairs, and only for repos the caller's tenant context can read.
 */
export async function listRunners(deps: RunnerCloudDeps, principal: SessionPrincipal): Promise<RunnerHttpResponse> {
  const { runners, viewer, account } = await readFleet(deps, principal.accountId, principal.userId, readReportedFacts);
  return {
    status: 200,
    body: {
      runners,
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
