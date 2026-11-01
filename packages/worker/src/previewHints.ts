import type { Pool } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import type { PreviewHint } from "@fx/core/src/discovery/run.js";

/**
 * D#483 S4-c2: the discovery run's `previewHints` over an account's finished onboarding preview. The preview stores no classification of its own: its
 * result is the output envelope of its run (`agent_runs.envelope`), computed on read. This reads the newest succeeded one for the repository under the
 * account's tenant and hands the envelope to pipeline's `parsePreviewResult` (injected: this package cannot import @fx/pipeline). An envelope that fails
 * its checks gives no hints, and the run still imports the issues.
 */
export type PreviewResultParser = (envelope: unknown) => { issues: ReadonlyArray<{ number: number; category: string; expected_model_usd: number }> } | { error: string };

export function createPreviewHints(pool: Pool, parse: PreviewResultParser): (accountId: string) => (repoId: string) => Promise<PreviewHint[]> {
  return (accountId) => async (repoId) => {
    const envelope = await withTenant(pool, accountId, async (client) => {
      const { rows } = await client.query<{ envelope: unknown }>(
        `SELECT r.envelope FROM onboarding_previews p JOIN agent_runs r ON r.account_id = p.account_id AND r.id = p.run_id
          WHERE p.account_id = $1 AND p.repo_id = $2 AND r.status = 'succeeded' ORDER BY r.ended_at DESC NULLS LAST LIMIT 1`,
        [accountId, repoId],
      );
      return rows[0]?.envelope;
    });
    if (envelope === undefined || envelope === null) return [];
    const result = parse(envelope);
    return "issues" in result ? result.issues.map((i) => ({ number: i.number, category: i.category, expectedUsd: i.expected_model_usd })) : [];
  };
}
