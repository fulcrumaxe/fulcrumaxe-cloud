import { COPY } from "@fulcrumaxe/runner-protocol";
import { withTenant } from "@fx/db/src/withTenant.js";
import { CLOUD_VERIFIED_COPY_SHA256, LOCAL_AUTO_MERGE_COPY_SHA256, hasUsableKey } from "./executionMode.js";
import { RunnerHttpError, type RunnerCloudDeps, type RunnerHttpResponse, type SessionPrincipal } from "./http.js";
import { requireMemberRole } from "./memberRole.js";
import { blockFor, readRepoVisibility } from "./repoPrivacy.js";

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
  // The local-review auto-merge control (opt-in). `autoMergeWording` is the exact text whose hash is `auto_merge_copy_sha256`.
  autoMergeWording: COPY.localAutoMerge,
  autoMergeTitle: COPY.autoMergeTitle,
  autoMergeIsOn: COPY.autoMergeIsOn,
  autoMergeIsOff: COPY.autoMergeIsOff,
  autoMergeTurnOn: COPY.autoMergeTurnOn,
  autoMergeTurnOff: COPY.autoMergeTurnOff,
  autoMergeSavedOn: COPY.autoMergeSavedOn,
  autoMergeSavedOff: COPY.autoMergeSavedOff,
  autoMergeHumanOnly: COPY.autoMergeHumanOnly,
  autoMergeNotLocal: COPY.autoMergeNotLocal,
} as const;

/**
 * GET /api/runners/repos/:id/execution-mode (a session route, any member of the account; a non-member gets 403, another account's repo 404).
 * What the repo mode picker needs: the repo's current mode, its full name (the picker checks the typed name against it; the server still
 * checks it on the write), whether a usable model key is connected (`key_required` is true when not: a boolean, never key material), the
 * sha256 of the cloud-verified wording this server ships (sent back on the opt-in as `copy_sha256`), whether local-review auto-merge is on
 * (`auto_merge`) and the hash of its wording (`auto_merge_copy_sha256`, sent back when turning it on), whether the caller may change the
 * mode, and the picker's words.
 *
 * `runner_blocked` (D#6 runner public guard): on a repo that is on a runner (local-only or cloud-verified), the visibility is read live
 * and a repo that is public now, or whose visibility cannot be read, answers `public_repo` or `repo_visibility_unknown`: every runner job
 * of it is refused until it is private again or moved to the sandbox, and the picker says so. `null` when nothing blocks it, and always
 * on a sandbox repo (no read is made for one).
 */
export async function getRepoMode(deps: RunnerCloudDeps, principal: SessionPrincipal, repoId: string): Promise<RunnerHttpResponse> {
  if (!UUID.test(repoId)) throw new RunnerHttpError(404, "not_found", "no such repository");
  const { repo, role, usableKey, autoMerge } = await withTenant(deps.appUserPool, principal.accountId, principal.userId, async (client) => {
    const role = await requireMemberRole(client);
    const repo = (await client.query<{ execution_mode: string; gh_owner: string | null; gh_name: string | null }>("SELECT execution_mode, gh_owner, gh_name FROM repos WHERE id = $1", [repoId])).rows[0];
    if (!repo) throw new RunnerHttpError(404, "not_found", "no such repository");
    const optIn = (await client.query<{ on: boolean }>("SELECT EXISTS (SELECT 1 FROM repo_local_review_optins o WHERE o.repo_id = $1) AS on", [repoId])).rows[0];
    return { repo, role, usableKey: await hasUsableKey(client, principal.accountId), autoMerge: optIn?.on === true };
  });
  // Read after the tenant transaction: the visibility read goes to GitHub.
  const onRunner = repo.execution_mode === "runner_local" || repo.execution_mode === "runner_verified";
  const runnerBlocked = onRunner ? blockFor(await readRepoVisibility(deps, principal.accountId, repoId)) : null;
  return {
    status: 200,
    body: {
      repo_id: repoId,
      execution_mode: repo.execution_mode,
      full_name: repo.gh_owner && repo.gh_name ? `${repo.gh_owner}/${repo.gh_name}` : null,
      key_required: !usableKey,
      copy_sha256: CLOUD_VERIFIED_COPY_SHA256,
      auto_merge: autoMerge,
      auto_merge_copy_sha256: LOCAL_AUTO_MERGE_COPY_SHA256,
      can_change: role === "owner" || role === "admin",
      runner_blocked: runnerBlocked,
      copy: PICKER_COPY,
    },
    headers: { "cache-control": "no-store" },
  };
}
