import { declaresCompletion } from "./referenceLine.js";
import { cleanText, type ParsedPlan } from "./roadmapFile.js";

/**
 * D#483 S3 level 1: the status of every task, decided from what GitHub says about the pull requests. Pure.
 *
 * Status comes from GitHub, never from the file's own `status` field (only `pending_spec` is taken from the file: a task whose
 * Spec is not written is never done). For a task `k`, its merged pull requests are the union of
 *   (a) each number in the file's `prs`, kept only if GitHub says that pull request is merged (found by `file`);
 *   (b) each merged pull request whose reference line DECLARES it completes `k` (found by `reference_line`; see referenceLine.ts).
 * A task is done when its merged count is at least `planned_prs` and `planned_prs` is at least 1. Every other task is
 * remaining, labelled `partial` (some merged), `open` (a pull request for it is open) or `not_started`.
 * A file pull request that is not merged on GitHub is listed in `evidenceDropped` with why.
 */
export interface PullFacts {
  number: number;
  title: string;
  state: "open" | "merged" | "closed";
  dLines: readonly string[];
}

export type TaskStatus = "done" | "partial" | "open" | "not_started" | "pending_spec";

export interface EvidenceItem {
  pr: number;
  via: "file" | "reference_line";
}
export interface DroppedEvidence {
  pr: number;
  via: "file";
  reason: "open" | "closed_unmerged" | "not_found";
}

export interface ComputedTask {
  key: string;
  milestoneKey: string;
  discussionNumber: number | null;
  title: string;
  summary: string | null;
  plannedPrs: number;
  mergedPrs: number[];
  openPrs: number[];
  status: TaskStatus;
  parentKey: string | null;
  evidence: EvidenceItem[];
  evidenceDropped: DroppedEvidence[];
}

export interface MilestoneCounts {
  tasks: number;
  done: number;
  remaining: number;
}

export interface ComputedPlan {
  tasks: ComputedTask[];
  perMilestone: Record<string, MilestoneCounts>;
  totals: MilestoneCounts & { partial: number; open: number; not_started: number; pending_spec: number };
}

const TITLE_CHARS = 300;
const SUMMARY_CHARS = 2000;

export function computePlan(plan: ParsedPlan, pulls: readonly PullFacts[]): ComputedPlan {
  const byNumber = new Map<number, PullFacts>();
  for (const p of pulls) byNumber.set(p.number, p);
  const merged = pulls.filter((p) => p.state === "merged");
  const open = pulls.filter((p) => p.state === "open");

  const tasks: ComputedTask[] = [];
  const perMilestone: Record<string, MilestoneCounts> = {};
  for (const m of plan.milestones) perMilestone[m.key] = { tasks: 0, done: 0, remaining: 0 };
  const totals = { tasks: 0, done: 0, remaining: 0, partial: 0, open: 0, not_started: 0, pending_spec: 0 };

  for (const t of plan.tasks) {
    const evidence: EvidenceItem[] = [];
    const dropped: DroppedEvidence[] = [];
    const fileSet = new Set<number>();
    for (const n of [...t.filePrs].sort((a, b) => a - b)) {
      const p = byNumber.get(n);
      fileSet.add(n);
      if (p?.state === "merged") evidence.push({ pr: n, via: "file" });
      else dropped.push({ pr: n, via: "file", reason: p === undefined ? "not_found" : p.state === "open" ? "open" : "closed_unmerged" });
    }
    const mergedNumbers = new Set(evidence.map((e) => e.pr));
    if (t.discussionNumber !== null && t.key.includes(":")) {
      for (const p of merged) {
        if (!mergedNumbers.has(p.number) && declaresCompletion(p, t.key)) {
          mergedNumbers.add(p.number);
          evidence.push({ pr: p.number, via: "reference_line" });
        }
      }
    }
    const mergedPrs = [...mergedNumbers].sort((a, b) => a - b);

    const openNumbers = new Set<number>();
    for (const n of [...t.filePrs, ...t.fileOpenPrs]) if (byNumber.get(n)?.state === "open") openNumbers.add(n);
    if (t.discussionNumber !== null && t.key.includes(":")) {
      for (const p of open) if (declaresCompletion(p, t.key)) openNumbers.add(p.number);
    }
    const openPrs = [...openNumbers].filter((n) => !mergedNumbers.has(n)).sort((a, b) => a - b);

    let status: TaskStatus;
    if (t.fileStatus === "pending_spec") status = "pending_spec";
    else if (t.plannedPrs >= 1 && mergedPrs.length >= t.plannedPrs) status = "done";
    else if (mergedPrs.length > 0) status = "partial";
    else if (openPrs.length > 0) status = "open";
    else status = "not_started";

    const note = t.note ? cleanText(t.note, SUMMARY_CHARS) : "";
    tasks.push({
      key: t.key,
      milestoneKey: t.milestoneKey,
      discussionNumber: t.discussionNumber,
      title: note ? note.slice(0, TITLE_CHARS) : cleanText(t.key, TITLE_CHARS) || "task",
      summary: note || null,
      plannedPrs: t.plannedPrs,
      mergedPrs,
      openPrs,
      status,
      parentKey: t.parentKey,
      evidence,
      evidenceDropped: dropped,
    });

    const c = perMilestone[t.milestoneKey]!;
    c.tasks += 1;
    totals.tasks += 1;
    if (status === "done") {
      c.done += 1;
      totals.done += 1;
    } else {
      c.remaining += 1;
      totals.remaining += 1;
      if (status === "partial") totals.partial += 1;
      else if (status === "open") totals.open += 1;
      else if (status === "pending_spec") totals.pending_spec += 1;
      else totals.not_started += 1;
    }
  }
  return { tasks, perMilestone, totals };
}
