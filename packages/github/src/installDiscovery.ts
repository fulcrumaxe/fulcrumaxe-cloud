import type { Pool } from "pg";
import { withPlatformOps } from "@fx/core/src/tenancy/withPlatformOps.js";
import { queueDiscoveries } from "@fx/db/src/discoveryRuns.js";

/**
 * D#483 S4-c: the one reference both install paths queue `installation_created` under. The delivery can arrive before the callback
 * has recorded the installation, or between the claim and the repository sync, and then it finds no repository to queue; the
 * callback (after its sync) queues the same trigger. With one reference per installation, whichever runs second is a no-op under the
 * unique key (repo, trigger, reference), and a repository the first one missed is still queued by the second.
 */
export function installationDiscoveryRef(ghInstallationId: number): string {
  return `installation:${ghInstallationId}`;
}

/**
 * Queues the installation's discovery after its repositories are synced. Only the full `team` app has product repositories to read.
 * Never throws and never changes the install outcome: a failure logs one fixed line, and the delivery path or the next trigger retries.
 */
export async function queueInstallDiscovery(
  deps: { platformOpsPool: Pool; appUserPool?: Pool; warn?: (message: string) => void },
  kind: string,
  accountId: string,
  ghInstallationId: number,
): Promise<void> {
  if (kind !== "team" || !deps.appUserPool) return;
  try {
    const id = await withPlatformOps(deps.platformOpsPool, async (c) => {
      const r = await c.query<{ id: string }>("SELECT id FROM installations WHERE gh_installation_id = $1 AND app_kind = $2 AND account_id = $3", [ghInstallationId, kind, accountId]);
      return r.rows[0]?.id ?? null;
    });
    if (!id) return;
    await queueDiscoveries(deps.appUserPool, accountId, { kind: "installation", installationId: id }, "installation_created", installationDiscoveryRef(ghInstallationId));
  } catch {
    // fx-swallow-ok: the claim already committed; a fixed line is logged (no id, no name) and the delivery path or a later trigger discovers
    (deps.warn ?? console.warn)("github install: queuing discovery failed");
  }
}
