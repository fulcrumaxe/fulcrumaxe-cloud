import { withTenant } from "@fx/db/src/withTenant.js";
import { activePresetsFor } from "@fx/db/src/dialPreset.js";
import type { RunnerCloudDeps, RunnerHttpResponse, SessionPrincipal } from "./http.js";
import { RunnerHttpError } from "./http.js";
import { requireMemberRole } from "./memberRole.js";
import { readVisibilities, type RepoVisibilityAnswer } from "./repoPrivacy.js";

/**
 * D#845 ON-7a2: GET /api/runners/repos/picker. The account's repositories for the project picker, each with what GitHub says about its visibility right now and the D#7 preset
 * its dials currently match. Owner or admin only (it is the picker for placing a project, which only they can do).
 *
 * Visibility is asked of GitHub per request through the same bounded reader the runner gates use (8 at once, one 10 s deadline) and is kept in this process's memory for at most
 * 60 s so a person reopening the picker does not ask again. Nothing is stored. A definite answer only is kept: "unknown" (any failure, a missing reader, a read past the deadline)
 * is never remembered, so the next request tries again. The place route reads GitHub live and stays the guard; this answer is for display.
 */
export const PICKER_VISIBILITY_TTL_MS = 60_000;
/** The most repositories one picker read lists. */
export const PICKER_MAX_REPOS = 1000;
const CACHE_MAX_ENTRIES = 5000;

const cache = new Map<string, { at: number; answer: "public" | "private" }>();

/** D#845 ON-7b (Ruling 87.1): the owners a repo can be created under. Asked of GitHub live, kept per account in this process for at most 60 s, never stored. */
export const PICKER_OWNERS_TTL_MS = 60_000;
/** All of one picker read's installation reads together. Past it the owners are unknown. */
export const PICKER_OWNERS_TIMEOUT_MS = 10_000;
const OWNERS_CONCURRENCY = 4;
/** The most team installations one picker read asks GitHub about. */
export const PICKER_MAX_INSTALLATIONS = 20;
const ownersCache = new Map<string, { at: number; owners: PickerOwner[] }>();

/** Forgets every remembered answer. For tests; nothing in the app calls it. */
export function clearPickerVisibilityCache(): void {
  cache.clear();
  ownersCache.clear();
}

export interface PickerOwner {
  gh_id: number;
  login: string;
}

export interface PickerRepo {
  id: string;
  name: string;
  visibility: RepoVisibilityAnswer;
  /** The preset every class 2 dial of this repo matches, derived as GET /api/v1/repos/{id}/decision-settings does it; null is "Custom". */
  active_preset: string | null;
}

/** Every installation read, under one deadline and at most 4 at once. Any failure, a missing reader or the deadline gives `null` (owners unknown); nothing partial is shown. */
async function readOwners(deps: RunnerCloudDeps, ids: readonly number[]): Promise<PickerOwner[] | null> {
  if (ids.length === 0) return [];
  const read = deps.installationAccount;
  if (!read) return null;
  const signal = AbortSignal.timeout(Math.max(1, deps.installationAccountTimeoutMs ?? PICKER_OWNERS_TIMEOUT_MS));
  const found = new Map<number, PickerOwner>();
  let failed = false;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (!failed && !signal.aborted && next < ids.length) {
      const id = ids[next++] as number;
      let onAbort: (() => void) | undefined;
      try {
        const deadline = new Promise<never>((_, reject) => {
          onAbort = () => reject(new Error("deadline"));
          signal.addEventListener("abort", onAbort, { once: true });
        });
        const pending = Promise.resolve(read(id, signal));
        pending.catch(() => undefined); // fx-swallow-ok: a read that lost the race must not surface as an unhandled rejection
        const got = await Promise.race([pending, deadline]);
        if (got && Number.isSafeInteger(got.gh_id) && got.gh_id > 0 && typeof got.login === "string" && got.login !== "") found.set(got.gh_id, { gh_id: got.gh_id, login: got.login });
      } catch {
        // fx-swallow-ok: a failed read is "owners unknown" for this picker read; the person is told and can try again
        failed = true;
      } finally {
        if (onAbort) signal.removeEventListener("abort", onAbort);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(OWNERS_CONCURRENCY, ids.length) }, worker));
  if (failed || signal.aborted) return null;
  return [...found.values()].sort((a, b) => a.login.localeCompare(b.login) || a.gh_id - b.gh_id);
}

export async function listPickerRepos(deps: RunnerCloudDeps, principal: SessionPrincipal): Promise<RunnerHttpResponse> {
  const { accountId, userId } = principal;
  const picked = await withTenant(deps.appUserPool, accountId, userId, async (client) => {
    if ((await requireMemberRole(client)) === "member") throw new RunnerHttpError(403, "forbidden", "only an owner or admin can pick a project");
    const { rows } = await client.query<{ id: string; name: string }>(
      `SELECT id, COALESCE(NULLIF(gh_owner || '/' || gh_name, ''), 'a repository') AS name FROM repos WHERE account_id = $1 ORDER BY 2, id LIMIT ${PICKER_MAX_REPOS}`,
      [accountId],
    );
    const presets = await activePresetsFor(client, accountId, rows.map((r) => r.id));
    // The team App's installations on this account (the rows `create-intent` gates on); who they sit on is asked of GitHub below.
    const inst = await client.query<{ gh_installation_id: string }>(
      `SELECT gh_installation_id FROM installations WHERE account_id = $1 AND app_kind = 'team' ORDER BY gh_installation_id LIMIT ${PICKER_MAX_INSTALLATIONS}`,
      [accountId],
    );
    return { repos: rows.map((r) => ({ ...r, active_preset: presets.get(r.id) ?? null })), installations: inst.rows.map((r) => Number(r.gh_installation_id)) };
  });

  // After the transaction: no network call holds a pooled connection.
  const found = picked.repos;
  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  const seen = new Map<string, RepoVisibilityAnswer>();
  const toRead: string[] = [];
  for (const r of found) {
    const hit = cache.get(`${accountId}:${r.id}`);
    if (hit && nowMs - hit.at >= 0 && nowMs - hit.at < PICKER_VISIBILITY_TTL_MS) seen.set(r.id, hit.answer);
    else toRead.push(r.id);
  }
  const fresh = await readVisibilities(deps, accountId, toRead);
  for (const [id, answer] of fresh) {
    seen.set(id, answer);
    if (answer === "unknown") cache.delete(`${accountId}:${id}`);
    else {
      if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
      cache.set(`${accountId}:${id}`, { at: nowMs, answer });
    }
  }

  let owners: PickerOwner[] | null;
  const heldOwners = ownersCache.get(accountId);
  if (heldOwners && nowMs - heldOwners.at >= 0 && nowMs - heldOwners.at < PICKER_OWNERS_TTL_MS) owners = heldOwners.owners;
  else {
    owners = await readOwners(deps, picked.installations);
    if (owners === null || owners.length === 0) ownersCache.delete(accountId); // an empty answer is not kept, so a person who has just installed the App sees it at once
    else {
      if (ownersCache.size >= CACHE_MAX_ENTRIES) ownersCache.delete(ownersCache.keys().next().value as string);
      ownersCache.set(accountId, { at: nowMs, owners });
    }
  }

  const repos: PickerRepo[] = found.map((r) => ({ id: r.id, name: r.name, visibility: seen.get(r.id) ?? "unknown", active_preset: r.active_preset }));
  return { status: 200, body: { repos, owners: owners ?? [], ...(owners === null ? { owners_unknown: true } : {}) }, headers: { "cache-control": "no-store" } };
}
