import type { PoolClient } from "pg";
import { withPlatformOps } from "@fx/core/src/tenancy/withPlatformOps.js";
import type { AppKind } from "./appCredentials.js";
import {
  handleGithubWebhookEvent,
  type GithubWebhookDbDeps,
  type GithubWebhookEventName,
  type GithubWebhookPayload,
  type HandleWebhookResult,
} from "./eventMapper.js";

/**
 * D#2 H13e-2: the gate between a VERIFIED delivery and
 * handleGithubWebhookEvent.
 *
 *  - Only the `team` App drives the pipeline. A verified delivery from
 *    `team_readonly` or `sitekit` is acknowledged (200, so GitHub does not
 *    retry) and does nothing, for every event name, `installation.*`
 *    included -- lifecycle handling for those kinds is H17's.
 *  - One exception: `installation_repositories` from `team_readonly`. It
 *    carries repository ids only, and acting on it just detaches that
 *    installation's removed repos and asks for a repo sync, so the free
 *    preview's repo picker follows the owner's repo selection.
 *  - Kind cross-check: a delivery naming an installation whose row is not
 *    of the sending App's kind is also inert, with one warning line
 *    carrying the installation id and nothing else. No row, or no
 *    `installation` field, leaves processing unchanged.
 */
export interface WebhookGateOptions {
  warn?: (line: string) => void;
}

function readInstallationId(payload: unknown): number | null {
  const id = (payload as { installation?: { id?: unknown } } | null)?.installation?.id;
  return typeof id === "number" && Number.isSafeInteger(id) ? id : null;
}

export async function handleGithubWebhookEventForApp(
  deps: GithubWebhookDbDeps,
  eventName: GithubWebhookEventName,
  payload: GithubWebhookPayload,
  deliveryId: string,
  appKind: AppKind,
  opts: WebhookGateOptions = {},
): Promise<HandleWebhookResult> {
  // The read-only App may act on exactly one delivery: installation_repositories (added/removed),
  // which carries repository ids only. Every other delivery from it, and every delivery from the
  // site-kit App, stays inert and never reaches the database.
  if (appKind !== "team" && !(appKind === "team_readonly" && eventName === "installation_repositories")) {
    return { handled: false, reason: "inert_app_kind" };
  }

  const installationId = readInstallationId(payload);
  if (installationId !== null) {
    const kinds = await withPlatformOps(deps.platformOpsPool, async (client: PoolClient) => {
      const { rows } = await client.query<{ app_kind: string }>(
        `SELECT app_kind FROM installations WHERE gh_installation_id = $1`,
        [installationId],
      );
      return rows.map((r) => r.app_kind);
    });
    // The installation row must be of the same kind as the App that sent the delivery.
    if (kinds.some((k) => k !== appKind)) {
      (opts.warn ?? console.warn)(`github webhook: app kind mismatch for installation ${installationId}`);
      return { handled: false, reason: "app_kind_mismatch" };
    }
  }

  return handleGithubWebhookEvent(deps, eventName, payload, deliveryId);
}
