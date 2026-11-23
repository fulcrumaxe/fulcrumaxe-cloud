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

/** Forgets every remembered answer. For tests; nothing in the app calls it. */
export function clearPickerVisibilityCache(): void {
  cache.clear();
}

export interface PickerRepo {
  id: string;
  name: string;
  visibility: RepoVisibilityAnswer;
  /** The preset every class 2 dial of this repo matches, derived as GET /api/v1/repos/{id}/decision-settings does it; null is "Custom". */
  active_preset: string | null;
}

export async function listPickerRepos(deps: RunnerCloudDeps, principal: SessionPrincipal): Promise<RunnerHttpResponse> {
  const { accountId, userId } = principal;
  const found = await withTenant(deps.appUserPool, accountId, userId, async (client) => {
    if ((await requireMemberRole(client)) === "member") throw new RunnerHttpError(403, "forbidden", "only an owner or admin can pick a project");
    const { rows } = await client.query<{ id: string; name: string }>(
      `SELECT id, COALESCE(NULLIF(gh_owner || '/' || gh_name, ''), 'a repository') AS name FROM repos WHERE account_id = $1 ORDER BY 2, id LIMIT ${PICKER_MAX_REPOS}`,
      [accountId],
    );
    const presets = await activePresetsFor(client, accountId, rows.map((r) => r.id));
    return rows.map((r) => ({ ...r, active_preset: presets.get(r.id) ?? null }));
  });

  // After the transaction: no network call holds a pooled connection.
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

  const repos: PickerRepo[] = found.map((r) => ({ id: r.id, name: r.name, visibility: seen.get(r.id) ?? "unknown", active_preset: r.active_preset }));
  return { status: 200, body: { repos }, headers: { "cache-control": "no-store" } };
}
