import { z } from "zod";
import { COPY } from "@fulcrumaxe/runner-protocol";
import { listReadyToMerge } from "@fx/core/src/work-items/readyToMerge.js";
import type { RouteEntry } from "../registry.js";

/**
 * D#598 P8c-2b: the pull requests a person has to merge on GitHub, read for the Needs you list. List only: there is no approve, withdraw or merge route
 * here (merging in the product is a separate decision). Session only, any member can read. Nothing is stored for the list: an item is on it while its newest
 * merge-gate outcome is "ready, a person merges" and its stage is not terminal, so a merged or closed pull request drops off by itself.
 */

/** The most items one read returns; the rest are counted in `not_shown`. */
export const MERGE_READY_LIST_LIMIT = 100;

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

/** The pull request's address on github.com, built from the repository on record and the number the gate recorded; null when either is unusable. */
export function pullRequestUrl(repo: { owner: string; name: string } | null, prNumber: number): string | null {
  if (repo === null || !OWNER_RE.test(repo.owner) || !NAME_RE.test(repo.name) || repo.name === "." || repo.name === ".." || !Number.isInteger(prNumber) || prNumber < 1) return null;
  return `https://github.com/${repo.owner}/${repo.name}/pull/${prNumber}`;
}

/** The sentence for why the merge is a person's: the caps have their own words, every other gate outcome gets the plain one. */
function whySentence(reasons: string[]): string {
  if (reasons.includes("review_round_cap")) return COPY.reviewRoundCap;
  if (reasons.includes("review_compute_cap")) return COPY.reviewComputeCap;
  return "The checks are done. A person merges this pull request on GitHub.";
}

const itemSchema = z.object({
  work_item_id: z.string(),
  /** Untrusted text from the issue, already cleaned to one line: show it as text only. Null when the item has none. */
  title: z.string().nullable(),
  pr_number: z.number().int(),
  /** The pull request on github.com, or null when the item has no repository on record. */
  pr_url: z.string().nullable(),
  /** Why a person merges it, in the cloud's own words. */
  why: z.string(),
  since: z.string(),
});

const listResponseSchema = z.object({ items: z.array(itemSchema), not_shown: z.number().int().min(0) });

export const mergeReadyRoutes: RouteEntry[] = [
  {
    method: "GET",
    path: "/api/v1/merge-ready",
    operationId: "listMergeReady",
    summary: "The pull requests waiting for a person to merge them on GitHub, newest first",
    description: "Session only, any member. At most 100 items; `not_shown` counts the rest. An item leaves the list when its pull request is merged or closed. Read only: merging happens on GitHub.",
    minRole: "member",
    idempotency: "never",
    rateClass: "read",
    responseSchema: listResponseSchema,
    async handler(ctx) {
      const { accountId, userId } = ctx.principal;
      const { items, total } = await listReadyToMerge({ pool: ctx.pool, principal: { accountId, userId } }, { limit: MERGE_READY_LIST_LIMIT });
      return {
        items: items.map((i) => ({
          work_item_id: i.workItemId,
          title: i.title,
          pr_number: i.prNumber,
          pr_url: pullRequestUrl(i.repo, i.prNumber),
          why: whySentence(i.reasons),
          since: i.since.toISOString(),
        })),
        not_shown: Math.max(0, total - items.length),
      };
    },
  },
];
