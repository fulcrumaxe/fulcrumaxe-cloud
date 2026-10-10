import { COPY } from "@fulcrumaxe/runner-protocol";
import { withTenant } from "@fx/db/src/withTenant.js";
import { CLOUD_VERIFIED_COPY_SHA256, hasUsableKey } from "./executionMode.js";
import { RunnerHttpError, type RunnerCloudDeps, type RunnerHttpResponse, type SessionPrincipal } from "./http.js";
import { requireMemberRole } from "./memberRole.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The words the picker shows, chosen by key here so the app retypes none of them (D#6 R5b-2b-iii). */
const PICKER_COPY = {
  title: COPY.modeTitle,
  sandbox: COPY.modeSandbox,
  sandboxHelp: COPY.modeSandboxHelp,
  localOnly: COPY.modeLocalOnly,
  localOnlyHelp: COPY.localOnly,
  cloudVerified: COPY.modeCloudVerified,
  cloudVerifiedHelp: COPY.cloudVerified,
  keyRequired: COPY.keyRequired,
  keyRequiredWhy: COPY.modeKeyRequiredWhy,
  typeName: COPY.modeTypeName,
  apply: COPY.modeApply,
  cancel: COPY.modeCancel,
  saving: COPY.modeSaving,
  saved: COPY.modeSaved,
  leaveCancels: COPY.modeLeaveCancels,
  adminOnly: COPY.modeAdminOnly,
  saveFailed: COPY.modeSaveFailed,
  nameMismatch: COPY.modeNameMismatch,
  copyChanged: COPY.modeCopyChanged,
  keyGone: COPY.modeKeyGone,
  publicRepo: COPY.modePublicRepo,
  visibilityUnknown: COPY.modeVisibilityUnknown,
} as const;

/**
 * GET /api/runners/repos/:id/execution-mode (a session route, any member of the account; a non-member gets 403, another account's repo 404).
 * What the repo mode picker needs: the repo's current mode, its full name (the picker checks the typed name against it; the server still
 * checks it on the write), whether a usable model key is connected (`key_required` is true when not: a boolean, never key material), the
 * sha256 of the cloud-verified wording this server ships (sent back on the opt-in as `copy_sha256`), whether the caller may change the
 * mode, and the picker's words.
 */
export async function getRepoMode(deps: RunnerCloudDeps, principal: SessionPrincipal, repoId: string): Promise<RunnerHttpResponse> {
  if (!UUID.test(repoId)) throw new RunnerHttpError(404, "not_found", "no such repository");
  const { repo, role, usableKey } = await withTenant(deps.appUserPool, principal.accountId, principal.userId, async (client) => {
    const role = await requireMemberRole(client);
    const repo = (await client.query<{ execution_mode: string; gh_owner: string | null; gh_name: string | null }>("SELECT execution_mode, gh_owner, gh_name FROM repos WHERE id = $1", [repoId])).rows[0];
    if (!repo) throw new RunnerHttpError(404, "not_found", "no such repository");
    return { repo, role, usableKey: await hasUsableKey(client, principal.accountId) };
  });
  return {
    status: 200,
    body: {
      repo_id: repoId,
      execution_mode: repo.execution_mode,
      full_name: repo.gh_owner && repo.gh_name ? `${repo.gh_owner}/${repo.gh_name}` : null,
      key_required: !usableKey,
      copy_sha256: CLOUD_VERIFIED_COPY_SHA256,
      can_change: role === "owner" || role === "admin",
      copy: PICKER_COPY,
    },
    headers: { "cache-control": "no-store" },
  };
}
