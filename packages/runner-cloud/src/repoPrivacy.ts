import type { PoolClient } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { RunnerHttpError, type RunnerCloudDeps, type SessionPrincipal } from "./http.js";

/** What a repo's visibility read can say. Anything that is not a clear "private" is not enough to put a repo on a runner. */
export type RepoVisibilityAnswer = "private" | "public" | "unknown";

/** Why a repo may not be on a runner right now, or null when it may. The same two codes every runner gate refuses with. */
export type RunnerRepoBlock = "public_repo" | "repo_visibility_unknown";

/**
 * The longest one visibility read may take. The binding path reads inside the transaction that holds a pooled connection and the runner's
 * advisory lock, so a slow or hung GitHub must not hold either: past this the read is "unknown", which refuses (409 repo_visibility_unknown).
 */
export const REPO_VISIBILITY_READ_TIMEOUT_MS = 5_000;

/**
 * The repo's visibility, read live through the app's port. A missing port, a failed read or a read past the timeout is "unknown", which refuses.
 * The port gets an AbortSignal for the same deadline; the race below does not depend on it being honoured, so a port that ignores it still
 * fails closed on time (the abandoned read then finishes or fails on its own and its answer is dropped).
 */
export async function readRepoVisibility(deps: Pick<RunnerCloudDeps, "repoVisibility"> & { repoVisibilityTimeoutMs?: number }, accountId: string, repoId: string, maxMs?: number): Promise<RepoVisibilityAnswer> {
  const ms = Math.max(1, Math.min(deps.repoVisibilityTimeoutMs ?? REPO_VISIBILITY_READ_TIMEOUT_MS, maxMs ?? Infinity));
  const signal = AbortSignal.timeout(ms);
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<RepoVisibilityAnswer>((resolve) => {
    onAbort = () => resolve("unknown");
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const read: Promise<RepoVisibilityAnswer> = Promise.resolve(deps.repoVisibility?.(accountId, repoId, signal)).then((v) => (v === "private" || v === "public" ? v : "unknown"));
    read.catch(() => undefined); // fx-swallow-ok: a read that lost the race must not surface as an unhandled rejection
    return await Promise.race([read, deadline]);
  } catch {
    // fx-swallow-ok: a failed read is "unknown", which refuses (409 repo_visibility_unknown)
    return "unknown";
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export function blockFor(seen: RepoVisibilityAnswer): RunnerRepoBlock | null {
  if (seen === "private") return null;
  return seen === "public" ? "public_repo" : "repo_visibility_unknown";
}

/** The refusal for a repo that may not be on a runner. 409, like every other runner gate's refusal of the same two codes. */
export function blockError(block: RunnerRepoBlock): RunnerHttpError {
  return block === "public_repo"
    ? new RunnerHttpError(409, "public_repo", "a public repository cannot run on a runner")
    : new RunnerHttpError(409, "repo_visibility_unknown", "the repository's visibility could not be read");
}

/**
 * D#6 (runner public guard): a runner is never bound to a repository that is not private. Called before the definer that binds
 * (a registration code, a provisioning token, a runner's repo set), it reads each repo the request ADDS and refuses with 409
 * `public_repo` or `repo_visibility_unknown` before anything is written.
 *
 * Only an owner or admin can add repos, so for anyone else nothing is read here and the definer gives its own refusal (403). A repo id
 * that is not the account's is left to the definer too (its 400 `unknown_repo`). `currentOf` names the runner whose existing set is
 * subtracted first: narrowing a runner's repos never needs GitHub, and a repo already bound that turned public later is refused by
 * the job gates (issue and claim), not here.
 */
export async function refuseNonPrivateRepos(deps: RunnerCloudDeps, principal: SessionPrincipal, repoIds: readonly string[], currentOf?: string): Promise<void> {
  if (repoIds.length === 0) return;
  const toRead = await withTenant(deps.appUserPool, principal.accountId, principal.userId, (client) => reposToRead(client, repoIds, currentOf));
  await refuseUnlessPrivate(deps, principal.accountId, toRead);
}

/** The most one request's visibility reads may take in all, however many repos it adds. No network call runs inside a transaction. */
export const REPO_VISIBILITY_TOTAL_TIMEOUT_MS = 10_000;
const REPO_VISIBILITY_CONCURRENCY = 8;

/**
 * The repos in `ids`, read live (at most 8 at once) under ONE overall deadline. A read still pending when the deadline passes, or never
 * started, is "unknown". Throws the refusal for the first (in order) repo that is not private; returns the set read as private.
 */
async function readAllPrivate(deps: RunnerCloudDeps, accountId: string, ids: readonly string[]): Promise<Set<string>> {
  const until = Date.now() + (deps.repoVisibilityTotalTimeoutMs ?? REPO_VISIBILITY_TOTAL_TIMEOUT_MS);
  const seen = new Map<string, RepoVisibilityAnswer>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < ids.length) {
      const id = ids[next++] as string;
      const left = until - Date.now();
      seen.set(id, left <= 0 ? "unknown" : await readRepoVisibility(deps, accountId, id, left));
    }
  };
  await Promise.all(Array.from({ length: Math.min(REPO_VISIBILITY_CONCURRENCY, ids.length) }, worker));
  const priv = new Set<string>();
  for (const id of ids) {
    const block = blockFor(seen.get(id) ?? "unknown");
    if (block !== null) throw blockError(block);
    priv.add(id);
  }
  return priv;
}

/**
 * Step one of a binding that writes in a transaction: the repos the request would add (see `reposToRead`), read BEFORE the transaction opens, so a
 * slow GitHub holds neither a pooled connection nor the runner's lock. Returns the ids read as private for `refuseUnlessPreRead`.
 */
export async function preReadAddedRepos(deps: RunnerCloudDeps, principal: SessionPrincipal, repoIds: readonly string[], currentOf?: string): Promise<Set<string>> {
  if (repoIds.length === 0) return new Set();
  const toRead = await withTenant(deps.appUserPool, principal.accountId, principal.userId, (client) => reposToRead(client, repoIds, currentOf));
  return readAllPrivate(deps, principal.accountId, toRead);
}

/**
 * Step two, inside the binding transaction under the runner's lock: the added set is computed again from the committed state, and a repo in it that was
 * not read as private beforehand (the set changed in between) is refused as unknown. Reads nothing, so the CWE-367 gap stays closed without network I/O here.
 */
export async function refuseUnlessPreRead(client: PoolClient, repoIds: readonly string[], currentOf: string, preRead: ReadonlySet<string>): Promise<void> {
  if (repoIds.length === 0) return;
  for (const id of await reposToRead(client, repoIds, currentOf)) if (!preRead.has(id)) throw blockError("repo_visibility_unknown");
}

async function refuseUnlessPrivate(deps: RunnerCloudDeps, accountId: string, repoIds: readonly string[]): Promise<void> {
  await readAllPrivate(deps, accountId, repoIds);
}

async function reposToRead(client: PoolClient, repoIds: readonly string[], currentOf?: string): Promise<string[]> {
  const role = (await client.query<{ role: string | null }>("SELECT current_member_role() AS role")).rows[0]?.role;
  if (role !== "owner" && role !== "admin") return [];
  let wanted = [...new Set(repoIds.map((id) => id.toLowerCase()))];
  if (currentOf !== undefined) {
    const runner = (await client.query<{ allowed_repo_ids: string[] }>("SELECT allowed_repo_ids FROM runners WHERE id = $1", [currentOf])).rows[0];
    // A runner this caller cannot see is the definer's refusal (404), not a reason to ask GitHub anything.
    if (!runner) return [];
    const held = new Set(runner.allowed_repo_ids.map((id) => id.toLowerCase()));
    wanted = wanted.filter((id) => !held.has(id));
  }
  if (wanted.length === 0) return [];
  const { rows } = await client.query<{ id: string }>("SELECT id FROM repos WHERE id = ANY ($1::uuid[]) ORDER BY id", [wanted]);
  return rows.map((r) => r.id);
}
