import type { Pool } from "pg";
import { reportError } from "@fx/telemetry";

/**
 * D#598 PUSH-OWNER-SANDBOX-DEFINER: whether a GitHub installation id is a live team-App installation of the account a sandbox's publish run belongs to.
 *
 * The question goes to the database function `plane_publish_installation_owned` (migration 0908) on the narrow gh-proxy login, the same pool and login as
 * `createPublishTargetResolver`. Its inputs are the sandbox name from the verified OIDC claim and the installation id GitHub named for the paired public
 * repository; it finds the account from the run itself and applies the rule of the shared reader (`createTeamInstallationOwnership` in @fx/core): the
 * installation belongs to that account, and its installer record is neither deleted nor suspended. This module never sees or sends an account id.
 *
 * Fail closed: a malformed input is "not owned" without a query; the function answering anything but a plain `true` is "not owned"; a database error is
 * reported by class and thrown, which the mint turns into a refusal (an unavailable answer, never a token).
 */
export type PublishInstallationOwnership = (sandboxName: string, ghInstallationId: number) => Promise<boolean>;

const QUERY = "SELECT public.plane_publish_installation_owned($1, $2) AS owned";

export function createPublishInstallationOwnership(ghProxyPool: Pool): PublishInstallationOwnership {
  return async function ownsPublishInstallation(sandboxName, ghInstallationId) {
    if (typeof sandboxName !== "string" || sandboxName.length === 0) return false;
    if (!Number.isSafeInteger(ghInstallationId) || ghInstallationId <= 0) return false;
    try {
      const { rows } = await ghProxyPool.query<{ owned: unknown }>(QUERY, [sandboxName, ghInstallationId]);
      return rows.length === 1 && rows[0]!.owned === true;
    } catch (err) {
      // Reported by class only (the error's text is never read); the caller refuses to mint.
      reportError(err, { stage: "github.plane_publish_installation_owned" });
      throw err;
    }
  };
}
