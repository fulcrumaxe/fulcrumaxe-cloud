import type { Pool } from "pg";
import { markWorkPending } from "@fx/core/src/pendingWork.js";
import { markPlaneParityDue } from "@fx/core/src/repos/planeParityChecks.js";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import type { GithubWebhookEventName, GithubWebhookPayload } from "@fx/github";

/**
 * D#598 P1d-3: the webhook's mark for the plane parity check. A push to the DEFAULT branch of either repo of a pairing (the private repo, found by its row;
 * the public repo, found by the pairing's `code_repo` inside the account of the installation that delivered it) marks that pairing due 60 seconds ahead.
 * It reads only the ref, the default branch name and the repository's full name from the verified payload, and makes no outbound call. The check itself runs in
 * the existing setup-request-check sweep, which the marker wakes. Other events, other branches and unpaired repos do nothing.
 */
const FULL_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

/** The pushed repository's full name when the event is a push to its default branch, else null. Pure. */
export function readDefaultBranchPush(eventName: string, payload: unknown): string | null {
  if (eventName !== "push" || typeof payload !== "object" || payload === null) return null;
  const p = payload as { ref?: unknown; repository?: { full_name?: unknown; default_branch?: unknown } };
  const branch = p.repository?.default_branch;
  const full = p.repository?.full_name;
  if (typeof p.ref !== "string" || typeof branch !== "string" || branch === "" || p.ref !== `refs/heads/${branch}`) return null;
  return typeof full === "string" && FULL_NAME.test(full) ? full : null;
}

export async function wakePlaneParity(pool: Pool, event: { accountId: string; repoId: string; eventName: GithubWebhookEventName; payload: GithubWebhookPayload }): Promise<number> {
  const fullName = readDefaultBranchPush(event.eventName, event.payload);
  if (fullName === null) return 0;
  const marked = await withTenant(pool, event.accountId, (client) => markPlaneParityDue(client, { accountId: event.accountId, repoId: event.repoId || null, fullName }));
  if (marked > 0) void markWorkPending("setup-request-check");
  return marked;
}
