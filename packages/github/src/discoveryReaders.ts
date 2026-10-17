import { PlanReadError, type PlanReadClient } from "./planReadClient.js";
import { DISCOVERY_DISCUSSIONS_QUERY } from "./planQueries.js";
import { ISSUES_PER_PAGE, MAX_BODY_CHARS, MAX_TITLE_CHARS } from "./planReaders.js";

/**
 * D#483 S4-c: the install and payment discovery's reads. The N most recently updated OPEN issues and Discussions, together.
 *
 *   Issues       GET /repos/{o}/{n}/issues?state=open&sort=updated&direction=desc. That endpoint returns pull requests too (an
 *                item with a `pull_request` key is one); they are dropped here, so a page can hold fewer issues than its size and
 *                the read follows the Link header (at most MAX_PAGES pages) until it has `limit` issues or the list ends.
 *   Discussions  one allowlisted GraphQL query (planQueries.ts): open only, UPDATED_AT descending, first `limit`.
 *
 * Both lists are merged newest first and cut to `limit`, so the result is the `limit` most recently updated across both.
 * Reads only; text is cut where it is read and cleaned again before it is stored.
 */
export const DISCOVERY_LIMIT = 50;
const MAX_PAGES = 5;

export interface RecentItem {
  kind: "issue" | "discussion";
  number: number;
  title: string;
  /** A Discussion's body; null for an issue (issue bodies are not kept). */
  body: string | null;
  updatedAt: string;
}

interface RepoRef {
  owner: string;
  name: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const unexpected = (): never => {
  throw new PlanReadError("github_unavailable");
};
const isStamp = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));

export async function listRecentOpenItems(client: PlanReadClient, repo: RepoRef, limit: number = DISCOVERY_LIMIT): Promise<{ items: RecentItem[] }> {
  const issues: RecentItem[] = [];
  for (let page = 1; page <= MAX_PAGES && issues.length < limit; page += 1) {
    const res = await client.request({
      method: "GET",
      path: `/repos/${repo.owner}/${repo.name}/issues`,
      query: { state: "open", sort: "updated", direction: "desc", per_page: ISSUES_PER_PAGE, page },
    });
    if (res.status === 404) throw new PlanReadError("repo_not_connected");
    if (res.status !== 200) return unexpected();
    let list: unknown;
    try {
      list = JSON.parse(res.text);
    } catch {
      // fx-swallow-ok: a non-JSON listing is GitHub misbehaving
      return unexpected();
    }
    if (!Array.isArray(list)) return unexpected();
    for (const item of list) {
      if (!isRecord(item) || typeof item.number !== "number" || !Number.isSafeInteger(item.number) || !isStamp(item.updated_at)) return unexpected();
      if (isRecord(item.pull_request)) continue; // the issues list also holds pull requests
      if (item.state !== "open") continue;
      issues.push({ kind: "issue", number: item.number, title: typeof item.title === "string" ? item.title.slice(0, MAX_TITLE_CHARS) : "", body: null, updatedAt: item.updated_at });
      if (issues.length >= limit) break;
    }
    if (!/rel="next"/.test(res.headers["link"] ?? "")) break;
  }

  const data: unknown = await client.graphqlDocument(DISCOVERY_DISCUSSIONS_QUERY, { owner: repo.owner, name: repo.name, first: limit });
  const r = isRecord(data) ? data.repository : undefined;
  if (r === null) throw new PlanReadError("app_permission_missing");
  if (!isRecord(r)) return unexpected();
  const discussions: RecentItem[] = [];
  // Discussions switched off is an empty list here (the issues are still read), not a failure.
  if (r.hasDiscussionsEnabled === true) {
    const conn = r.discussions;
    if (!isRecord(conn) || !Array.isArray(conn.nodes)) return unexpected();
    for (const n of conn.nodes) {
      if (!isRecord(n) || typeof n.number !== "number" || !Number.isSafeInteger(n.number) || !isStamp(n.updatedAt)) return unexpected();
      if (n.closed === true) continue;
      discussions.push({
        kind: "discussion",
        number: n.number,
        title: typeof n.title === "string" ? n.title.slice(0, MAX_TITLE_CHARS) : "",
        body: typeof n.body === "string" ? n.body.slice(0, MAX_BODY_CHARS) : "",
        updatedAt: n.updatedAt,
      });
    }
  }

  const items = [...issues, ...discussions]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.number - a.number || (a.kind < b.kind ? -1 : 1))
    .slice(0, limit);
  return { items };
}
