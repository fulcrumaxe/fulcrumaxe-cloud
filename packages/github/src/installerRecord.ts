import { reportError } from "@fx/telemetry";
import type { Pool } from "pg";
import { withPlatformOps } from "@fx/core/src/tenancy/withPlatformOps.js";
import { emitDomainEvent } from "@fx/core/src/domain-events/emit.js";
import { withTenant } from "@fx/db/src/withTenant.js";
import type { AppKind } from "./appCredentials.js";
import { syncClaimedInstallation } from "./syncInstallationRepos.js";
import { bindClaim, type CompleteInstallDeps } from "./installCallback.js";

/**
 * D#2 H17e (C57 R1, R3): the installer record. A VERIFIED `installation`
 * delivery (the caller has already checked the per-App HMAC) updates
 * `installation_installers` for its App kind: `created` stores the sender's
 * numeric GitHub user id once (a replay changes nothing), `deleted` and
 * `suspend`/`unsuspend` set and clear the flags. For `team_readonly` and
 * `sitekit` this record is the only effect of the delivery.
 *
 * `deleted` and `suspend` also DETACH the installation's repos (installation_id set NULL, never deleted), as the
 * tenant's app_user inside this same advisory-locked transaction, so a repo is never listed as installed under
 * an installation that is gone or paused. `unsuspend` re-syncs (below). Each change emits one
 * `installation.changed` event (on the outer transaction); a detach emits one `repos.changed` on the tenant
 * transaction that did the detach, so the two commit together. That is what makes the open Onboarding and Repos
 * windows re-read.
 *
 * After a `created`, any live pending claim whose GitHub user id equals the
 * sender completes through the same `bindClaim` as the callback. A failure
 * there is swallowed: the user's next callback binds directly. Nothing logs.
 */
export type InstallerRecordDeps = Pick<CompleteInstallDeps, "platformOpsPool" | "appCredentials" | "fetchImpl" | "recheck" | "syncRepos" | "warn"> & {
  /** The tenant pool the detach runs through (repos is writable only by app_user), as the repo sync uses it. */
  appUserPool: Pool;
};

const ACTIONS = new Set(["created", "deleted", "suspend", "unsuspend"]);
const posInt = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null);

export async function recordInstallationLifecycle(
  deps: InstallerRecordDeps,
  kind: AppKind,
  payload: unknown,
  /** The reconciler's call meter for the un-suspend re-sync (D#454 C2-H2c-1). The webhook path passes none. */
  meter?: { take(n?: number): boolean },
): Promise<void> {
  const p = payload as { action?: unknown; installation?: { id?: unknown }; sender?: { id?: unknown } } | null;
  const action = typeof p?.action === "string" && ACTIONS.has(p.action) ? p.action : null;
  const ghInstallationId = posInt(p?.installation?.id);
  if (!action || ghInstallationId === null) return;
  const senderId = posInt(p?.sender?.id);

  if (action !== "created") {
    const set = action === "deleted" ? "deleted_at = now()" : action === "suspend" ? "suspended_at = now()" : "suspended_at = NULL";
    const state = action === "deleted" ? "deleted" : action === "suspend" ? "suspended" : "unsuspended";
    await withPlatformOps(deps.platformOpsPool, async (client) => {
      // H17b-2: the lock a sync's write phase holds, so a state change and a sync write are ordered.
      await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [ghInstallationId]);
      await client.query(`UPDATE installation_installers SET ${set}, repo_list_etags = NULL WHERE gh_installation_id = $1 AND app_kind = $2`, [ghInstallationId, kind]);
      const rows = await client.query<{ id: string; account_id: string }>(
        "SELECT id, account_id FROM installations WHERE gh_installation_id = $1 AND app_kind = $2",
        [ghInstallationId, kind],
      );
      for (const inst of rows.rows) {
        if (action !== "unsuspend") {
          // Detach (never delete) under the lock held above; repos are tenant-owned, so this runs as the tenant.
          // repos.changed is emitted on this same tenant client, so the detach and its event commit together even
          // if the outer platform_ops transaction later fails (as syncInstallationRepos does).
          await withTenant(deps.appUserPool, inst.account_id, async (tenant) => {
            const res = await tenant.query(
              "UPDATE repos SET installation_id = NULL, updated_at = now() WHERE account_id = $1 AND installation_id = $2",
              [inst.account_id, inst.id],
            );
            const detached = res.rowCount ?? 0;
            if (detached > 0) await emitDomainEvent(tenant, { type: "repos.changed", accountId: inst.account_id, subjectId: inst.id, payload: { kind, detached } });
          });
        }
        await emitDomainEvent(client, { type: "installation.changed", accountId: inst.account_id, subjectId: inst.id, payload: { kind, state } });
      }
    });
    if (action === "unsuspend" && (kind === "team" || kind === "team_readonly")) await syncClaimedInstallation(deps, kind, ghInstallationId, meter);
    return;
  }
  if (senderId === null) return;

  const claims = await withPlatformOps(deps.platformOpsPool, async (client) => {
    // Serialises with the callback's installer read and pending insert (CWE-362): first statement.
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [ghInstallationId]);
    await client.query(
      `INSERT INTO installation_installers (gh_installation_id, app_kind, installer_gh_user_id) VALUES ($1, $2, $3)
       ON CONFLICT (gh_installation_id, app_kind) DO NOTHING`,
      [ghInstallationId, kind, senderId],
    );
    // Read back the stored installer, not the sender: a replay from someone else changes nothing.
    const stored = await client.query<{ installer_gh_user_id: string }>(
      "SELECT installer_gh_user_id FROM installation_installers WHERE gh_installation_id = $1 AND app_kind = $2",
      [ghInstallationId, kind],
    );
    if (Number(stored.rows[0]?.installer_gh_user_id) !== senderId) return [];
    const pending = await client.query<{ account_id: string; user_id: string }>(
      `SELECT account_id, user_id FROM installation_pending_claims
        WHERE gh_installation_id = $1 AND app_kind = $2 AND gh_user_id = $3 AND expires_at > now()`,
      [ghInstallationId, kind, senderId],
    );
    return pending.rows;
  });

  for (const c of claims) {
    try {
      const outcome = await bindClaim(deps, {
        kind,
        accountId: c.account_id,
        userId: c.user_id,
        ghInstallationId,
        installerGhUserId: senderId,
        path: "webhook",
      });
      if (outcome === "ok") {
        await withPlatformOps(deps.platformOpsPool, (client) =>
          client.query("DELETE FROM installation_pending_claims WHERE gh_installation_id = $1 AND app_kind = $2", [ghInstallationId, kind]),
        );
        // Both kinds list repos: the read-only install feeds the free preview's repo picker.
        if (kind === "team" || kind === "team_readonly") await syncClaimedInstallation(deps, kind, ghInstallationId);
      }
    } catch (err) {
      reportError(err, { stage: "github.bind_pending_claim" });
      // The user's next callback binds directly.
    }
  }
}

/**
 * D#454 H2b2: the owner's restore of an installation the reconciler found listed by GitHub while we hold it as deleted
 * (`deleted_but_listed`). It is the one change a webhook delivery never makes (GitHub sends no such action), so it is its own
 * function, but it takes the same advisory lock, writes the same table, emits the same `installation.changed` event and then
 * runs the same repo re-sync as an un-suspend. The CALLER must have confirmed with a fresh lookup, using that kind's own App
 * JWT, that GitHub answers 200 for this very installation id; nothing here talks to GitHub for that.
 *
 * Returns false when there was nothing to restore (no deleted record).
 */
export async function restoreInstallation(
  deps: InstallerRecordDeps,
  kind: AppKind,
  ghInstallationId: number,
  /** The restore request's own call allowance for the repo re-sync (C2-H2c-1); on run-out the RepoListBudgetError is thrown AFTER the restore itself committed. */
  meter?: { take(n?: number): boolean },
): Promise<boolean> {
  if (posInt(ghInstallationId) === null) return false;
  const restored = await withPlatformOps(deps.platformOpsPool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [ghInstallationId]);
    const res = await client.query(
      "UPDATE installation_installers SET deleted_at = NULL, repo_list_etags = NULL WHERE gh_installation_id = $1 AND app_kind = $2 AND deleted_at IS NOT NULL",
      [ghInstallationId, kind],
    );
    if ((res.rowCount ?? 0) === 0) return false;
    const rows = await client.query<{ id: string; account_id: string }>(
      "SELECT id, account_id FROM installations WHERE gh_installation_id = $1 AND app_kind = $2",
      [ghInstallationId, kind],
    );
    for (const inst of rows.rows) {
      await emitDomainEvent(client, { type: "installation.changed", accountId: inst.account_id, subjectId: inst.id, payload: { kind, state: "restored" } });
    }
    return true;
  });
  if (restored && (kind === "team" || kind === "team_readonly")) await syncClaimedInstallation(deps, kind, ghInstallationId, meter);
  return restored;
}
