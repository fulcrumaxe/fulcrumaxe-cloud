import { stripControlTokens } from "@fx/trust";

/**
 * D#483 S3 level 1: the roadmap file's shape, and the counting rule that is the file's own, reproduced exactly. Pure.
 *
 * Accepted shape: `milestones.<key>.tasks` (a list of task keys) and `task_status.<key>` carrying `milestone`, `planned_prs`
 * (an integer of 0 or more), `prs` (pull request numbers) and, optionally, `status`, `split_into`, `parent` and `note`. Every
 * other key is ignored. Only rows that a milestone lists are checked, so history rows kept for the record cannot fail an import.
 *
 * The counting rule:
 *   - the tasks of milestone `m` are the keys in `milestones[m].tasks`;
 *   - a key listed in two milestones, or missing from `task_status`, is `plan_file_inconsistent`, and names the key;
 *   - a split parent (non-empty `split_into`) is not counted.
 */
export class PlanFileShapeError extends Error {
  constructor(readonly problem: string) {
    super(`roadmap.json didn't match the expected shape: ${problem}`);
    this.name = "PlanFileShapeError";
  }
}

export class PlanFileInconsistentError extends Error {
  constructor(readonly key: string, readonly reason: "listed_twice" | "missing_row") {
    super(reason === "listed_twice" ? `task ${key} is listed in two milestones` : `task ${key} is listed in a milestone but has no task_status row`);
    this.name = "PlanFileInconsistentError";
  }
}

export interface PlanMilestone {
  key: string;
  title: string;
  position: number;
  taskKeys: string[];
}

export interface PlanTaskRow {
  key: string;
  milestoneKey: string;
  discussionNumber: number | null;
  plannedPrs: number;
  filePrs: number[];
  fileOpenPrs: number[];
  fileStatus: string | null;
  parentKey: string | null;
  note: string | null;
}

export interface ParsedPlan {
  milestones: PlanMilestone[];
  /** Every counted task (a leaf listed in a milestone), in milestone then list order. */
  tasks: PlanTaskRow[];
}

const MAX_KEY = 200;
const MILESTONE_SENTENCE_CHARS = 80;
export const MAX_PLAN_TASKS = 3000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function prList(v: unknown, where: string): number[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((n) => typeof n !== "number" || !Number.isInteger(n) || n < 1)) throw new PlanFileShapeError(`${where} is not a list of pull request numbers`);
  return [...new Set(v as number[])];
}

/** A one-line, control-token-free, length-bounded form of untrusted text. */
export function cleanText(text: string, max: number): string {
  return stripControlTokens(text.slice(0, max * 4)).replace(/\s+/g, " ").trim().slice(0, max);
}

/** The first sentence of a milestone's definition, cut to 80 characters. */
function firstSentence(definition: unknown): string {
  if (typeof definition !== "string") return "";
  const flat = cleanText(definition, 400);
  const m = /^(.*?[.!?])(?:\s|$)/.exec(flat);
  return (m ? m[1]! : flat).slice(0, MILESTONE_SENTENCE_CHARS).trim();
}

export function parseRoadmapFile(text: string): ParsedPlan {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    // fx-swallow-ok: the shape error carries a fixed problem text; the parser's own message can quote file content
    throw new PlanFileShapeError("the file is not valid JSON");
  }
  if (!isRecord(doc)) throw new PlanFileShapeError("the top level is not an object");
  const ms = doc.milestones;
  if (!isRecord(ms) || Object.keys(ms).length === 0) throw new PlanFileShapeError("milestones is missing or empty");
  const ts = doc.task_status;
  if (!isRecord(ts)) throw new PlanFileShapeError("task_status is missing");

  const milestones: PlanMilestone[] = [];
  const owner = new Map<string, string>();
  const tasks: PlanTaskRow[] = [];
  let position = 0;
  for (const [mkey, m] of Object.entries(ms)) {
    if (mkey.length < 1 || mkey.length > 120) throw new PlanFileShapeError(`milestone key ${JSON.stringify(mkey.slice(0, 40))} is not 1 to 120 characters`);
    if (!isRecord(m) || !Array.isArray(m.tasks)) throw new PlanFileShapeError(`milestones.${mkey}.tasks is not a list`);
    const sentence = firstSentence(m.definition);
    milestones.push({ key: mkey, title: sentence ? `${mkey}: ${sentence}` : mkey, position, taskKeys: [] });
    position += 1;
    for (const k of m.tasks) {
      if (typeof k !== "string" || k.length < 1 || k.length > MAX_KEY) throw new PlanFileShapeError(`milestones.${mkey}.tasks holds a key that is not a string of 1 to ${MAX_KEY} characters`);
      const row = ts[k];
      if (row === undefined) throw new PlanFileInconsistentError(k, "missing_row");
      if (owner.has(k)) throw new PlanFileInconsistentError(k, "listed_twice");
      owner.set(k, mkey);
      if (!isRecord(row)) throw new PlanFileShapeError(`task_status.${k} is not an object`);
      const split = row.split_into;
      if (split !== undefined && !(Array.isArray(split) && split.every((s) => typeof s === "string"))) throw new PlanFileShapeError(`task_status.${k}.split_into is not a list of keys`);
      if (Array.isArray(split) && split.length > 0) continue; // a split parent: kept for history, not counted
      const planned = row.planned_prs;
      if (typeof planned !== "number" || !Number.isInteger(planned) || planned < 0) throw new PlanFileShapeError(`task_status.${k}.planned_prs is not an integer of 0 or more`);
      const status = row.status;
      if (status !== undefined && typeof status !== "string") throw new PlanFileShapeError(`task_status.${k}.status is not a string`);
      const parent = row.parent;
      if (parent !== undefined && typeof parent !== "string") throw new PlanFileShapeError(`task_status.${k}.parent is not a string`);
      const note = row.note;
      if (note !== undefined && typeof note !== "string") throw new PlanFileShapeError(`task_status.${k}.note is not a string`);
      const d = /^D#(\d+)/.exec(k);
      tasks.push({
        key: k,
        milestoneKey: mkey,
        discussionNumber: d ? Number(d[1]) : null,
        plannedPrs: planned,
        filePrs: prList(row.prs, `task_status.${k}.prs`),
        fileOpenPrs: prList(row.open_prs, `task_status.${k}.open_prs`),
        fileStatus: typeof status === "string" ? status : null,
        parentKey: typeof parent === "string" ? parent.slice(0, MAX_KEY) : null,
        note: typeof note === "string" ? note : null,
      });
      milestones[milestones.length - 1]!.taskKeys.push(k);
    }
  }
  return { milestones, tasks };
}
