import type { ComputedPlan } from "./computePlan.js";
import { decideOwnerProcess, type OwnerProcess } from "./ownerProcess.js";
import { cleanText, MAX_PLAN_TASKS } from "./roadmapFile.js";

/**
 * D#483 S3 level 3: a repository with neither a roadmap file nor a Spec task table. Each OPEN issue and each OPEN Discussion
 * becomes one proposal; closed ones count as done, for the totals only (they get no row). There are no plan tasks and no
 * milestones at this level, so the milestone table is empty and the Plan view names the level instead. Pure.
 *
 * Issue text is outsiders' text: titles and summaries are cleaned of control tokens and cut before they are stored. The
 * issues list holds pull requests too; the reader has already split them off (a `pull_request` key), so none arrive here.
 * A number that appears twice (the list shifts while it is paged) is one proposal. A product label on an issue is not read at
 * this level, so an issue follows the repository default (internal_loop where the engine loop is installed).
 */
export interface IssueFacts {
  number: number;
  title: string;
  state: "open" | "closed";
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
}

export interface IssuesLevelResult {
  proposals: ItemProposal[];
  computed: ComputedPlan;
  truncated: boolean;
}

const MAX_INT = 2147483647;

export function buildIssuesLevel(issues: readonly IssueFacts[], discussions: readonly DiscussionFacts[], repoHasEngineLoop: boolean): IssuesLevelResult {
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
    open.set(key, {
      dedupeKey: key,
      source: "github_issue",
      ghNumber: i.number,
      discussionNumber: null,
      title: cleanText(i.title, 256) || `Issue #${i.number}`,
      summary: null,
      owner: decideOwnerProcess({ repoHasEngineLoop, kind: "issue" }),
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
