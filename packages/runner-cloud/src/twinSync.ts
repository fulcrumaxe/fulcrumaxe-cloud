import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { MACHINE_JOB_MAX_LIFE_S, TWIN_SYNC_MAX_PATHS, isTwinSyncPath, twinSyncBranch, type MachineJob } from "@fulcrumaxe/runner-protocol";
import { withTenant } from "@fx/db/src/withTenant.js";
import { RunnerHttpError, pgCode, type RunnerCloudDeps } from "./http.js";
import { requireMemberRole } from "./memberRole.js";
import { LocalOnlyGithubError } from "./localOnlyGithub.js";
import { RunPullRequestError, type RunPullRequestPort, type SetupInstallPort } from "./runPullRequest.js";
import { guardTwinVisibility, twinVisibilityError } from "./twinVisibility.js";

/**
 * D#845 ON-27d2: the cloud's halves of a private twin's sync, the public repository's changes coming into the twin (the runner's half is fx-runner's `twinSync.ts`). The sync pull request through the App, the merge handling, the
 * conflict state are ON-27d3 (below, and migration 1115); the reconcile tick that calls these comes with ON-27d4, and until then nothing does and `TWIN_ENABLED` is off.
 *
 *   issueTwinSync   The tick's session (no person) or an owner or admin, given the paths the parity found pending (at most 200; the caller's, never the runner's). Reads the twin's default-branch tip and the public `main` tip through
 *                   the App (metadata only: two refs) and signs a `twin_sync` job: the twin's tip as its base, the public tip, the branch named from the public tip, the paths and the live private set. It writes it through
 *                   `twin_sync_issue` (migration 1111), which re-checks every fact against the rows. The job carries no token and no text: the runner reads the public repository anonymously and asks for the twin's one credential at the token route.
 *   checkTwinSync   The cloud's check of what the runner says it pushed. Once a sync job is `done` it reads the twin's branch through the App (its head, and that the head has exactly one parent, the signed base) and hands the answer
 *                   to `twin_sync_check`, which marks the head verified or refuses the twin. A GitHub that cannot be asked leaves the twin where it is.
 */
const SHA40 = /^[0-9a-f]{40}$/;
const MAX_SET_BYTES = 200 * 1024;
const refuse = (status: number, code: string, message: string): RunnerHttpError => new RunnerHttpError(status, code, message);

interface TwinFacts {
  state: string;
  synced: string | null;
  syncPr: number | null;
  public: { id: string; ghId: number; owner: string | null; name: string | null };
  private: { id: string; ghId: number; owner: string | null; name: string | null };
  runnerId: string | null;
  setupId: string | null;
  set: { overlay_globs: string[]; install_paths: string[]; blob_globs: string[]; identifier_rules_path: string | null; plan_data_rules_path: string | null };
}

async function readFacts(client: PoolClient, accountId: string, twinId: string): Promise<TwinFacts | null> {
  const t = (
    await client.query<{ public_repo_id: string; private_repo_id: string | null; state: string; synced_public_sha: string | null; sync_pr: number | null; binary_globs: string[] } & Omit<TwinFacts["set"], "blob_globs">>(
      `SELECT public_repo_id, private_repo_id, state, synced_public_sha, sync_pr, overlay_globs, install_paths, binary_globs, identifier_rules_path, plan_data_rules_path
         FROM repo_twins WHERE account_id = $1 AND id = $2 AND state <> 'removed'`,
      [accountId, twinId],
    )
  ).rows[0];
  if (!t || t.private_repo_id === null) return null;
  const repo = async (id: string) => {
    const r = (await client.query<{ gh_repo_id: string; gh_owner: string | null; gh_name: string | null }>("SELECT gh_repo_id, gh_owner, gh_name FROM repos WHERE account_id = $1 AND id = $2", [accountId, id])).rows[0];
    return r ? { id, ghId: Number(r.gh_repo_id), owner: r.gh_owner, name: r.gh_name } : null;
  };
  const [pub, prv] = [await repo(t.public_repo_id), await repo(t.private_repo_id)];
  if (!pub || !prv) return null;
  const placed = (await client.query<{ runner_id: string }>("SELECT pl.runner_id FROM project_placements pl JOIN runners r ON r.account_id = pl.account_id AND r.id = pl.runner_id AND r.revoked_at IS NULL WHERE pl.account_id = $1 AND pl.repo_id = $2", [accountId, t.private_repo_id])).rows[0];
  const setup = (await client.query<{ id: string }>("SELECT id FROM project_setups WHERE account_id = $1 AND repo_id = $2 ORDER BY created_at DESC, id LIMIT 1", [accountId, t.private_repo_id])).rows[0];
  return {
    state: t.state, synced: t.synced_public_sha, syncPr: t.sync_pr, public: pub, private: prv, runnerId: placed?.runner_id ?? null, setupId: setup?.id ?? null,
    set: { overlay_globs: t.overlay_globs, install_paths: t.install_paths, blob_globs: t.binary_globs, identifier_rules_path: t.identifier_rules_path, plan_data_rules_path: t.plan_data_rules_path },
  };
}

/** The tip of a branch of a repository, or null when it has none. */
async function tipOf(port: RunPullRequestPort, repo: { id: string; owner: string; name: string }, branch: string): Promise<string | null> {
  const state = await port.branchState({ repo, branch, base: branch });
  return state.exists && state.headOid !== null && SHA40.test(state.headOid) ? state.headOid : null;
}

export type IssuedTwinSync = { outcome: "issued"; job_id: string; attempt: number } | { outcome: "in_sync" };

/** `userId` is null for the tick's own session (no person); a person must be an owner or admin (the definer re-checks). `paths` are the ones the parity found pending, at most 200, each a plain repository path. */
export async function issueTwinSync(deps: RunnerCloudDeps, principal: { accountId: string; userId: string | null }, twinId: string, paths: readonly string[]): Promise<IssuedTwinSync> {
  if (paths.length < 1 || paths.length > TWIN_SYNC_MAX_PATHS || new Set(paths).size !== paths.length || !paths.every(isTwinSyncPath)) throw refuse(400, "bad_paths", "the paths to bring in are not a list of 1 to 200 distinct repository paths");
  const signer = (await deps.engineCommandSigner?.()) ?? null;
  const port = deps.pullRequests ?? null;
  if (signer?.signMachineJob === undefined || port === null) throw refuse(503, "not_configured", "the cloud cannot issue a twin sync now");
  const tenant = <T>(fn: (client: PoolClient) => Promise<T>) => (principal.userId === null ? withTenant(deps.appUserPool, principal.accountId, fn) : withTenant(deps.appUserPool, principal.accountId, principal.userId, fn));
  const id = twinId.toLowerCase();
  const facts = await tenant(async (client) => {
    if (principal.userId !== null) {
      const role = await requireMemberRole(client);
      if (role !== "owner" && role !== "admin") throw refuse(403, "forbidden", "only an owner or admin can start a sync");
    }
    return readFacts(client, principal.accountId, id);
  });
  if (facts === null) throw refuse(404, "not_found", "no such private twin");
  if (facts.state !== "ready") throw refuse(409, "twin_state", "the private twin is not ready to sync");
  if (facts.syncPr !== null) throw refuse(409, "sync_open", "a sync pull request is open; merge or close it first");
  if (facts.public.owner === null || facts.public.name === null || facts.private.owner === null || facts.private.name === null) throw refuse(409, "repo_unnamed", "a repository has no name on record");
  if (facts.setupId === null) throw refuse(409, "setup_not_found", "the private twin has no setup");
  if (facts.runnerId === null) throw refuse(409, "setup_not_placed", "the private twin is not placed on a machine");
  const pub = { id: facts.public.id, owner: facts.public.owner, name: facts.public.name };
  const prv = { id: facts.private.id, owner: facts.private.owner, name: facts.private.name };
  const visible = await guardTwinVisibility(deps, principal, id);
  if (visible !== "ok") throw twinVisibilityError(visible);
  let base: string | null;
  let tip: string | null;
  let publicBranch: string;
  try {
    base = await tipOf(port, prv, await port.defaultBranch(prv));
    publicBranch = await port.defaultBranch(pub);
    tip = publicBranch === "main" ? await tipOf(port, pub, "main") : null;
  } catch (error) {
    if (error instanceof RunPullRequestError) throw refuse(503, "github_unavailable", "GitHub could not be asked");
    throw error;
  }
  // The sync reads the public repo's main, as the publish writes to it: any other default would never be in step with what the twin publishes.
  if (publicBranch !== "main") throw refuse(409, "public_default_branch_not_main", "only a public repository whose default branch is main can be synced");
  if (base === null) throw refuse(409, "default_branch_empty", "the private repository has no commit on its default branch");
  if (tip === null) throw refuse(409, "default_branch_empty", "the public repository has no commit on main");
  if (tip === facts.synced) return { outcome: "in_sync" };
  if (Buffer.byteLength(JSON.stringify(facts.set), "utf8") > MAX_SET_BYTES) throw refuse(409, "private_set_too_large", "the private paths are too many to sync");
  const jobId = randomUUID();
  const issued = (deps.now ?? (() => new Date()))();
  const expires = new Date(issued.getTime() + MACHINE_JOB_MAX_LIFE_S * 1000);
  const signed = signer.signMachineJob({
    v: 1, job_id: jobId, runner_id: facts.runnerId, repo_gh_id: facts.private.ghId, setup_id: facts.setupId, requires_engine: "any", issued_at: issued.toISOString(), expires_at: expires.toISOString(), kind: "twin_sync",
    args: {
      twin_id: id,
      public: { owner: pub.owner, name: pub.name, gh_id: facts.public.ghId, tip },
      private: { owner: prv.owner, name: prv.name, gh_id: facts.private.ghId, base },
      branch: twinSyncBranch(tip),
      paths: [...paths],
      private_set: facts.set,
    },
  } as MachineJob);
  let row: { o_result: string; o_attempt: number | null };
  try {
    row = await tenant(async (client) => (await client.query<{ o_result: string; o_attempt: number | null }>("SELECT o_result, o_attempt FROM twin_sync_issue($1::uuid, $2::uuid, $3::jsonb, $4, $5)", [id, jobId, JSON.stringify(signed), issued, expires])).rows[0]!);
  } catch (error) {
    if (pgCode(error) === "42501") throw refuse(403, "forbidden", "only an owner or admin can start a sync");
    throw error;
  }
  if (row.o_result === "in_sync") return { outcome: "in_sync" };
  const refusals: Record<string, [number, string, string]> = {
    not_found: [404, "not_found", "no such private twin"],
    bad_state: [409, "twin_state", "the private twin is not ready to sync"],
    sync_open: [409, "sync_open", "a sync pull request is open; merge or close it first"],
    repo_unnamed: [409, "repo_unnamed", "a repository has no name on record"],
    no_setup: [409, "setup_not_found", "the private twin has no setup"],
    not_placed: [409, "setup_not_placed", "the private twin is not placed on a machine"],
    job_live: [409, "sync_live", "a job of this twin is already under way, or a sync is waiting to be checked"],
  };
  if (row.o_result !== "ok" || row.o_attempt === null) {
    const [status, code, message] = refusals[row.o_result] ?? [409, "twin_state", "the private twin cannot be synced now"];
    throw refuse(status, code, message);
  }
  return { outcome: "issued", job_id: jobId, attempt: row.o_attempt };
}

export type TwinSyncCheck = "verified" | "refused" | "not_ready" | "not_found" | "github_unavailable";

/** `userId` is null for the tick's own session (no person); a person must be an owner or admin (the definer re-checks). */
export async function checkTwinSync(deps: Pick<RunnerCloudDeps, "appUserPool" | "setupInstall" | "repoVisibility" | "repoVisibilityTimeoutMs">, principal: { accountId: string; userId: string | null }, twinId: string): Promise<TwinSyncCheck> {
  const port = deps.setupInstall ?? null;
  const tenant = <T>(fn: (client: PoolClient) => Promise<T>) => (principal.userId === null ? withTenant(deps.appUserPool, principal.accountId, fn) : withTenant(deps.appUserPool, principal.accountId, principal.userId, fn));
  const id = twinId.toLowerCase();
  const target = await tenant(async (client) => (await client.query<{ o_repo_id: string; o_owner: string; o_name: string; o_branch: string; o_head: string; o_base: string }>("SELECT o_repo_id, o_owner, o_name, o_branch, o_head, o_base FROM twin_sync_to_verify($1::uuid)", [id])).rows[0] ?? null);
  if (target === null) return "not_ready";
  const visible = await guardTwinVisibility(deps, principal, id);
  if (visible !== "ok") return visible === "refused" ? "refused" : "github_unavailable";
  if (port === null) return "github_unavailable";
  const repo = { id: target.o_repo_id, owner: target.o_owner, name: target.o_name };
  let ok = false;
  try {
    // The branch is the signed one and its head the commit the runner reported; the commit has exactly one parent, the twin tip the job was issued against.
    if ((await tipOf(port, repo, target.o_branch)) === target.o_head) {
      const parents = await port.commitParents({ repo, sha: target.o_head });
      ok = parents !== null && parents.length === 1 && parents[0] === target.o_base;
    }
  } catch (error) {
    if (error instanceof RunPullRequestError) return "github_unavailable";
    throw error;
  }
  return tenant(async (client) => (await client.query<{ o_result: TwinSyncCheck }>("SELECT o_result FROM twin_sync_check($1::uuid, $2::boolean)", [id, ok])).rows[0]!.o_result);
}

/**
 * D#845 ON-27d3: the sync pull request. Public facts only: the public repository's name, the paths the job brought in and the logins of the public commits' authors. Paths with a backtick, a control character, a line separator, a bidirectional-control or a zero-width character are counted, not listed.
 * The paths and the authors sit in code fences, where GitHub makes no link or notification of them.
 */
const UNLISTABLE = /[`\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/;
export const TWIN_SYNC_MAX_LISTED = 200;
export const TWIN_SYNC_FOOTER = "Opened by the sync. Look through the files above, then merge to bring them in. Nothing else from the public repository is in this change.";
export function buildTwinSyncText(input: { publicRepo: string; paths: readonly string[]; authors: readonly string[] }): { title: string; body: string } {
  const shown = input.paths.filter((p) => !UNLISTABLE.test(p)).slice(0, TWIN_SYNC_MAX_LISTED);
  const fence = (lines: readonly string[]): string => (lines.length === 0 ? "" : `\n\n\`\`\`\n${lines.join("\n")}\n\`\`\``);
  const more = input.paths.length - shown.length;
  const authors = input.authors.length === 0 ? "" : `\n\nAuthors:${fence(input.authors)}`;
  return {
    title: `Bring in changes made on ${input.publicRepo}`,
    body: `Changes made on ${input.publicRepo} since the last sync.\n\nFiles: ${input.paths.length}${fence(shown)}${more > 0 ? `\n\nand ${more} more not listed here` : ""}${authors}\n\n${TWIN_SYNC_FOOTER}`,
  };
}

/** The change types of a compare that a sync may carry. `renamed` and `copied` name an old path as well; any other string closes the pull request. */
const SYNC_CHANGE_STATUSES: ReadonlySet<string> = new Set(["added", "removed", "modified", "changed", "renamed", "copied"]);
/**
 * The verified commit's changes against its base, as REST compare shows them: every path that changed, old path of a rename or copy included, must be one the signed job named (and so outside the private set), and every change type
 * must be a known one. A list that may be cut short, or no change at all, is not a pass.
 */
async function changesAreNamed(port: SetupInstallPort, repo: { id: string; owner: string; name: string }, base: string, head: string, named: readonly string[]): Promise<boolean> {
  const changes = await port.commitChanges({ repo, base, head });
  if (!changes.complete || changes.files.length === 0) return false;
  return changes.files.every((f) => {
    if (!SYNC_CHANGE_STATUSES.has(f.status)) return false;
    const twoSided = f.status === "renamed" || f.status === "copied";
    if (twoSided !== (f.previousPath !== null)) return false;
    const paths = f.previousPath === null ? [f.path] : [f.previousPath, f.path];
    return paths.every((p) => isTwinSyncPath(p) && named.includes(p));
  });
}

export type TwinSyncPrOpen = "recorded" | "refused" | "not_ready" | "not_found" | "github_unavailable";

/**
 * Opens the pull request for a verified sync branch on the twin, through the App, and records its number (`twin_sync_pr_record`). `userId` is null for the tick's own session; a person must be an owner or admin (the definer re-checks).
 * Draft first, as the install's step is: the branch must still be at the verified head, the pull request's head must be it, and its changed files (every page) must all be paths the signed job named, before the label and the ready mark. A pull
 * request that fails any of these is closed and the twin refused (`head_unconfirmed`); a GitHub that cannot be asked leaves everything where it is, and the next pass reuses the open pull request.
 */
export async function openTwinSyncPr(deps: Pick<RunnerCloudDeps, "appUserPool" | "setupInstall" | "planePush" | "repoVisibility" | "repoVisibilityTimeoutMs">, principal: { accountId: string; userId: string | null }, twinId: string): Promise<TwinSyncPrOpen> {
  const port = deps.setupInstall ?? null;
  const tenant = <T>(fn: (client: PoolClient) => Promise<T>) => (principal.userId === null ? withTenant(deps.appUserPool, principal.accountId, fn) : withTenant(deps.appUserPool, principal.accountId, principal.userId, fn));
  const id = twinId.toLowerCase();
  const t = await tenant(async (client) => (await client.query<{ o_repo_id: string; o_owner: string; o_name: string; o_branch: string; o_head: string; o_base: string; o_public_owner: string; o_public_name: string; o_tip: string; o_synced: string; o_paths: string[] }>("SELECT o_repo_id, o_owner, o_name, o_branch, o_head, o_base, o_public_owner, o_public_name, o_tip, o_synced, o_paths FROM twin_sync_pr_target($1::uuid)", [id])).rows[0] ?? null);
  if (t === null) return "not_ready";
  const visible = await guardTwinVisibility(deps, principal, id);
  if (visible !== "ok") return visible === "refused" ? "refused" : "github_unavailable";
  if (port === null) return "github_unavailable";
  const repo = { id: t.o_repo_id, owner: t.o_owner, name: t.o_name };
  const publicRepo = `${t.o_public_owner}/${t.o_public_name}`;
  let number: number | null = null;
  // The draft once it is open: a refusal that leaves no number must not leave it open (CWE-459).
  let draft: number | null = null;
  try {
    if ((await tipOf(port, repo, t.o_branch)) === t.o_head) {
      let authors: string[] = [];
      try {
        authors = (await deps.planePush?.commitAuthors?.({ accountId: principal.accountId, codeRepo: publicRepo, base: t.o_synced, head: t.o_tip })) ?? [];
      } catch {
        // fx-swallow-ok: the authors are a courtesy line; a public repository that cannot be read for them leaves the list off, and the pull request is the same without it
      }
      const ref = await port.openDraft({ repo, branch: t.o_branch, base: await port.defaultBranch(repo), text: buildTwinSyncText({ publicRepo, paths: t.o_paths, authors }) });
      draft = ref.number;
      // The pull request shows the commit that was verified and changes only the signed paths; anything else is not ours to hand to the engine.
      const files = ref.headSha === t.o_head ? await port.changedFiles({ repo, number: ref.number }) : null;
      let named = files !== null && files.complete && files.files.length > 0 && files.files.every((f) => t.o_paths.includes(f.path));
      // GraphQL names a renamed file by its new path only, so a delete of an unnamed path folded into a rename of a named one passes the check above. The verified commit's own changes, read against its base with REST compare, give the old
      // path too: both sides of a rename or copy must be paths the job named, and a change type that is not known closes the pull request (as the `done` route does).
      if (named) named = await changesAreNamed(port, repo, t.o_base, t.o_head, t.o_paths);
      if (named) {
        await port.labelTwinSync({ repo, number: ref.number });
        await port.markReady({ repo, pullRequest: ref });
        number = ref.number;
      } else {
        await port.close({ repo, number: ref.number });
      }
    }
  } catch (error) {
    if (error instanceof RunPullRequestError && error.retryable) return "github_unavailable";
    // A refusal no retry fixes (the fence, GitHub's 4xx): the twin is refused rather than left leased.
    if (!(error instanceof RunPullRequestError) && !(error instanceof LocalOnlyGithubError)) throw error;
    // No number will be recorded, so Remove could never close this draft: close it now, as well as it can be done. A close that fails too leaves it (the branch and the draft are the twin's own, and the twin is refused either way).
    if (draft !== null && number === null) {
      try {
        await port.close({ repo, number: draft });
      } catch {
        // fx-swallow-ok: best effort; the refusal stands whether or not the close lands, and nothing here can say more than the refusal already does
      }
    }
  }
  return tenant(async (client) => (await client.query<{ o_result: TwinSyncPrOpen }>("SELECT o_result FROM twin_sync_pr_record($1::uuid, $2, $3)", [id, t.o_head, number])).rows[0]!.o_result);
}

export type TwinSyncClose = "closed" | "none" | "github_unavailable";

/**
 * Closes the sync pull request a twin still has open on its private repository (Remove everything, Stop publishing). Read after the removal: the repository and the number are the twin's own rows'. The close is a plain close through the App
 * (the run port's A5; nothing is said on the pull request, the branch is kept). A GitHub that cannot be asked leaves it open; the removed twin ignores its merge.
 */
export async function closeTwinSyncPr(deps: Pick<RunnerCloudDeps, "appUserPool" | "setupInstall">, principal: { accountId: string; userId: string | null }, twinId: string): Promise<TwinSyncClose> {
  const tenant = <T>(fn: (client: PoolClient) => Promise<T>) => (principal.userId === null ? withTenant(deps.appUserPool, principal.accountId, fn) : withTenant(deps.appUserPool, principal.accountId, principal.userId, fn));
  const open = await tenant(async (client) => (await client.query<{ o_repo_id: string; o_owner: string; o_name: string; o_pr: number }>("SELECT o_repo_id, o_owner, o_name, o_pr FROM twin_sync_open_pr($1::uuid)", [twinId.toLowerCase()])).rows[0] ?? null);
  if (open === null) return "none";
  const port = deps.setupInstall ?? null;
  if (port === null) return "github_unavailable";
  try {
    await port.close({ repo: { id: open.o_repo_id, owner: open.o_owner, name: open.o_name }, number: open.o_pr });
    return "closed";
  } catch (error) {
    if (error instanceof RunPullRequestError) return error.retryable ? "github_unavailable" : "none";
    throw error;
  }
}
