import type { Pool } from "pg";
import { startBuildForItem as realStartBuildForItem, type StartBuildOptions } from "./build.js";

/**
 * Test-only: `startBuildForItem` with an empty live-secrets list unless a test passes one. The real function requires the source (D#601 MEM-RECALL-RESCAN);
 * production code never imports this file.
 */
export function startBuildForItem(
  pool: Pool,
  accountId: string,
  workItemId: string,
  approvalId: string,
  ports: Parameters<typeof realStartBuildForItem>[4],
  options: Omit<StartBuildOptions, "liveSecrets"> & { liveSecrets?: StartBuildOptions["liveSecrets"] } = {},
): ReturnType<typeof realStartBuildForItem> {
  return realStartBuildForItem(pool, accountId, workItemId, approvalId, ports, { liveSecrets: () => [], ...options });
}
