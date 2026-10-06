import type { Pool, PoolClient } from "pg";
import { withPlatformOps } from "@fx/core/src/tenancy/withPlatformOps.js";
import { emitDomainEvent } from "@fx/core/src/domain-events/emit.js";
import type { AppCredentialsSource, AppKind } from "./appCredentials.js";
import { verifyUserInstallation } from "./userInstallations.js";
import { syncClaimedInstallation, type SyncRepos } from "./syncInstallationRepos.js";
import { recheckInstallationActive, type InstallationRecheck } from "./installationRecheck.js";

/**
 * D#2 H17a: records an installation for a tenant. The route checks the session
 * and signed state; this re-checks the role, verifies the installation against
 * the user's own GitHub access, and writes the row and its audit row in one
 * platform_ops transaction. Nothing here logs; the result is one of a few fixed words.
 *
 * D#2 H17e (C57): only the user who installed the App may claim it. The
 * installer is the verified `installation.created` delivery's sender (see
 * installerRecord.ts); the callback compares GitHub's numeric user id for the
 * signed-in user with it, and a live recheck must show the installation
 * active before anything is written. A callback that beats the delivery
 * leaves a pending claim, which the delivery completes through `bindClaim`.
 */
export type InstallOutcome = "ok" | "failed" | "claimed" | "pay_first" | "pending" | "not_installer" | "inactive";

export interface CompleteInstallInput {
  kind: AppKind;
  accountId: string;
  userId: string;
  /** Untrusted query values. */
  installationId: string | null;
  code: string | null;
}

export interface CompleteInstallDeps {
  platformOpsPool: Pool;
  appCredentials: AppCredentialsSource;
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  recheck?: InstallationRecheck;
  /** H17b-2: repo sync, run after the claim commits; its failure never changes the outcome. */
  syncRepos?: SyncRepos;
  warn?: (message: string) => void;
}

export const PENDING_CLAIM_MINUTES = 30;

export interface BindClaim {
  kind: AppKind;
  accountId: string;
  userId: string;
  ghInstallationId: number;
  installerGhUserId: number;
  path: "callback" | "webhook";
}

/** The role and payment gates, shared by both paths. Null means eligible. */
async function eligibility(client: PoolClient, kind: AppKind, accountId: string, userId: string): Promise<InstallOutcome | null> {
  await client.query("SELECT set_config('app.account_id', $1, true)", [accountId]);
  const member = await client.query<{ role: string }>(
    "SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2",
    [accountId, userId],
  );
  const role = member.rows[0]?.role;
  if (role !== "owner" && role !== "admin") return "failed";
  if (kind === "team") {
    const acct = await client.query<{ status: string }>(
      "SELECT status FROM accounts WHERE id = $1 AND deleted_at IS NULL",
      [accountId],
    );
    if (acct.rows[0]?.status !== "active") return "pay_first";
  }
  return null;
}

/**
 * The one binding function for both paths. The caller has already matched the
 * installer. Inside one platform_ops transaction: the role check, the payment
 * check, the live recheck, then the insert and its audit row.
 */
export async function bindClaim(
  deps: Pick<CompleteInstallDeps, "platformOpsPool" | "appCredentials" | "fetchImpl" | "recheck">,
  claim: BindClaim,
): Promise<InstallOutcome> {
  let creds;
  try {
    creds = deps.appCredentials(claim.kind);
  } catch {
    return "failed";
  }
  // Eligibility, then the live recheck (an HTTP call, so outside any
  // transaction), then the bind transaction, which takes the installation lock
  // and re-checks eligibility.
  const precheck = await withPlatformOps(deps.platformOpsPool, (client) =>
    eligibility(client, claim.kind, claim.accountId, claim.userId),
  );
  if (precheck) return precheck;

  const active = await (deps.recheck ?? recheckInstallationActive)({
    appId: creds.appId,
    privateKeyPem: creds.privateKeyPem,
    ghInstallationId: claim.ghInstallationId,
    fetchImpl: deps.fetchImpl,
  });
  if (!active) return "inactive";

  return withPlatformOps(deps.platformOpsPool, async (client: PoolClient): Promise<InstallOutcome> => {
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [claim.ghInstallationId]);
    const refused = await eligibility(client, claim.kind, claim.accountId, claim.userId);
    if (refused) return refused;

    const inserted = await client.query(
      `INSERT INTO installations (account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3)
       ON CONFLICT (gh_installation_id, app_kind) DO NOTHING`,
      [claim.accountId, claim.ghInstallationId, claim.kind],
    );
    if (inserted.rowCount === 1) {
      await client.query("SELECT audit_write_system($1, 'github_install', 'github.installation_recorded', $2::jsonb)", [
        claim.accountId,
        JSON.stringify({
          app_kind: claim.kind,
          gh_installation_id: claim.ghInstallationId,
          user_id: claim.userId,
          installer_gh_user_id: claim.installerGhUserId,
          path: claim.path,
        }),
      ]);
      // Open Onboarding / Repos windows re-read on this; same transaction, so it exists only if the claim does.
      await emitDomainEvent(client, { type: "installation.changed", accountId: claim.accountId, payload: { kind: claim.kind, state: "installed" } });
      return "ok";
    }
    const owner = await client.query<{ account_id: string }>(
      "SELECT account_id FROM installations WHERE gh_installation_id = $1 AND app_kind = $2",
      [claim.ghInstallationId, claim.kind],
    );
    return owner.rows[0]?.account_id === claim.accountId ? "ok" : "claimed";
  });
}

export async function completeInstall(deps: CompleteInstallDeps, input: CompleteInstallInput): Promise<InstallOutcome> {
  if (!input.code || !input.installationId || !/^[1-9][0-9]{0,15}$/.test(input.installationId)) return "failed";
  const ghInstallationId = Number(input.installationId);
  let appId: string;
  try {
    appId = deps.appCredentials(input.kind).appId;
  } catch {
    return "failed";
  }
  const ghUserId = await verifyUserInstallation({
    kind: input.kind,
    code: input.code,
    ghInstallationId,
    appId,
    env: deps.env,
    fetchImpl: deps.fetchImpl,
  });
  if (ghUserId === null) return "failed";

  const recorded = await withPlatformOps(deps.platformOpsPool, async (client): Promise<InstallOutcome | { installer: number }> => {
    // Serialises with the delivery's installer insert (CWE-362): first statement.
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [ghInstallationId]);
    const refused = await eligibility(client, input.kind, input.accountId, input.userId);
    if (refused) return refused;

    const rec = await client.query<{ installer_gh_user_id: string; deleted_at: Date | null; suspended_at: Date | null }>(
      "SELECT installer_gh_user_id, deleted_at, suspended_at FROM installation_installers WHERE gh_installation_id = $1 AND app_kind = $2",
      [ghInstallationId, input.kind],
    );
    const row = rec.rows[0];
    if (!row) {
      await client.query("DELETE FROM installation_pending_claims WHERE expires_at <= now()");
      await client.query(
        `INSERT INTO installation_pending_claims (gh_installation_id, app_kind, gh_user_id, account_id, user_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6))
         ON CONFLICT (gh_installation_id, app_kind, gh_user_id)
         DO UPDATE SET account_id = EXCLUDED.account_id, user_id = EXCLUDED.user_id, expires_at = EXCLUDED.expires_at`,
        [ghInstallationId, input.kind, ghUserId, input.accountId, input.userId, PENDING_CLAIM_MINUTES],
      );
      return "pending";
    }
    if (Number(row.installer_gh_user_id) !== ghUserId) return "not_installer";
    if (row.deleted_at || row.suspended_at) return "inactive";
    return { installer: ghUserId };
  });
  if (typeof recorded === "string") return recorded;

  const outcome = await bindClaim(deps, {
    kind: input.kind,
    accountId: input.accountId,
    userId: input.userId,
    ghInstallationId,
    installerGhUserId: recorded.installer,
    path: "callback",
  });
  // Post-commit: bindClaim's transaction is over. Never fails the claim.
  if (outcome === "ok") await syncClaimedInstallation(deps, input.kind, ghInstallationId);
  return outcome;
}
