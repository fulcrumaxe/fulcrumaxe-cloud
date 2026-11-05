import type { ComputedPlan } from "./computePlan.js";
import type { RepoPermission } from "@fx/trust";
import { decideOwnerProcess, PRODUCT_LABEL, type OwnerProcess } from "./ownerProcess.js";
import { cleanText, MAX_PLAN_TASKS } from "./roadmapFile.js";

/**
 * D#483 S3 level 3: a repository with neither a roadmap file nor a Spec task table. Each OPEN issue and each OPEN Discussion
 * becomes one proposal; closed ones count as done, for the totals only (they get no row). There are no plan tasks and no
 * milestones at this level, so the milestone table is empty and the Plan view names the level instead. Pure.
 *
 * Issue text is outsiders' text: titles and summaries are cleaned of control tokens and cut before they are stored. The
 * issues list holds pull requests too; the reader has already split them off (a `pull_request` key), so none arrive here.
 * A number that appears twice (the list shifts while it is paged) is one proposal. An issue follows the repository default
 * (internal_loop where the engine loop is installed), except one whose product label was applied by a maintainer or admin: the caller
 * establishes that (who applied the latest such label, that actor's permission now) and passes the permission by issue number.
 */
export interface IssueFacts {
  number: number;
  title: string;
  state: "open" | "closed";
  /** The issue's label names, when the reader has them (only the product label is looked at). */
  labels?: readonly string[];
}
export interface DiscussionFacts {
  number: number;
  title: string;
  body: string;
  closed: boolean;
}

export interface ItemProposal {
  dedupeKey: string;
  source: "github_issue" | "github_discussion";
  ghNumber: number | null;
  discussionNumber: number | null;
  title: string;
  summary: string | null;
  owner: OwnerProcess;
  /** The permission of the person whose product label made this issue the product's (set only when it did); the import hands an existing proposal over with it. */
  labelPermission?: "maintain" | "admin";
}

export interface IssuesLevelResult {
  proposals: ItemProposal[];
  computed: ComputedPlan;
  truncated: boolean;
}

const MAX_INT = 2147483647;

export function buildIssuesLevel(
  issues: readonly IssueFacts[],
  discussions: readonly DiscussionFacts[],
  repoHasEngineLoop: boolean,
  labelActors: ReadonlyMap<number, RepoPermission> = new Map(),
): IssuesLevelResult {
  const open = new Map<string, ItemProposal>();
  const closed = new Set<string>();
  for (const i of issues) {
    if (i.number > MAX_INT) continue;
    const key = `gh:issue:${i.number}`;
    if (i.state !== "open") {
      open.delete(key);
      closed.add(key);
      continue;
    }
    closed.delete(key);
    const actorPermission = labelActors.get(i.number);
    const owner = decideOwnerProcess({ repoHasEngineLoop, kind: "issue", labels: actorPermission === undefined ? undefined : [{ name: PRODUCT_LABEL, actorPermission }] });
    open.set(key, {
      dedupeKey: key,
      source: "github_issue",
      ghNumber: i.number,
      discussionNumber: null,
      title: cleanText(i.title, 256) || `Issue #${i.number}`,
      summary: null,
      owner,
      ...(repoHasEngineLoop && owner === "product" && (actorPermission === "maintain" || actorPermission === "admin") ? { labelPermission: actorPermission } : {}),
    });
  }
  for (const d of discussions) {
    if (d.number > MAX_INT) continue;
    const key = `gh:discussion:${d.number}`;
    if (d.closed) {
      open.delete(key);
      closed.add(key);
      continue;
    }
    closed.delete(key);
    open.set(key, {
      dedupeKey: key,
      source: "github_discussion",
      ghNumber: null,
      discussionNumber: d.number,
      title: cleanText(d.title, 256) || `Discussion #${d.number}`,
      summary: cleanText(d.body, 2000) || null,
      owner: decideOwnerProcess({ repoHasEngineLoop, kind: "discussion" }),
    });
  }
  const all = [...open.values()];
  const truncated = all.length > MAX_PLAN_TASKS;
  const proposals = truncated ? all.slice(0, MAX_PLAN_TASKS) : all;
  const remaining = proposals.length;
  const done = closed.size;
  return {
    proposals,
    truncated,
    computed: { tasks: [], perMilestone: {}, totals: { tasks: remaining + done, done, remaining, partial: 0, open: 0, not_started: remaining, pending_spec: 0 } },
  };
}
