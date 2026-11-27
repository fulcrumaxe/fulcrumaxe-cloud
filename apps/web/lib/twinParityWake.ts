import type { Pool, PoolClient } from "pg";
import { markWorkPending } from "@fx/core/src/pendingWork.js";
import { findTwinsForPush } from "@fx/core/src/repos/twinParityDue.js";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import type { GithubWebhookEventName, GithubWebhookPayload } from "@fx/github";
import { readDefaultBranchPush } from "./planeParityWake";

/**
 * D#845 ON-27d1: the webhook's mark for a private twin's parity check, the twin's side of `wakePlaneParity`. A push to the DEFAULT branch of either repository of a twin finds the account's twins that push concerns and hands their ids
 * to `markDue` (`markTwinParityDue`, the 1112 definer, which re-checks the pushed repository against the twin) with the pushed repository, so the definer can; the twin sweep lists what it marked. It reads only the ref, the default branch name and the repository's full name from the verified payload and
 * makes no outbound call. The sweep is woken only when something was marked. Other events, other branches and repositories no twin has do nothing.
 */
export type TwinDueMarker = (client: PoolClient, input: { accountId: string; twinIds: string[]; repoId: string | null; fullName: string }) => Promise<number>;

export async function wakeTwinParity(pool: Pool, event: { accountId: string; repoId: string; eventName: GithubWebhookEventName; payload: GithubWebhookPayload }, markDue: TwinDueMarker): Promise<number> {
  const fullName = readDefaultBranchPush(event.eventName, event.payload);
  if (fullName === null) return 0;
  const marked = await withTenant(pool, event.accountId, async (client) => {
    const twinIds = await findTwinsForPush(client, { accountId: event.accountId, repoId: event.repoId || null, fullName });
    return twinIds.length === 0 ? 0 : markDue(client, { accountId: event.accountId, twinIds, repoId: event.repoId || null, fullName });
  });
  if (marked > 0) void markWorkPending("setup-request-check");
  return marked;
}
