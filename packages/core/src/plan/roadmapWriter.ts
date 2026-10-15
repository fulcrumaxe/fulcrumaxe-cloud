import { isDeepStrictEqual } from "node:util";
import { cleanText, parseRoadmapFile } from "./roadmapFile.js";

/**
 * D#598 P5a: the pure roadmap writer. Given the text of a roadmap file and a list of per-task updates, it returns the new text.
 * No I/O, no clock, no database: the post-merge write-back job (a later row) decides what the updates are and where the text goes.
 *
 * What it edits: `status`, `prs` and `open_prs` of rows in `task_status` that a milestone counts. Nothing else.
 *
 * Byte stability: the text is edited in place. Only the spans of the member values that change (or one inserted member at the
 * end of a row that lacks it) are replaced; every other byte, including every other row, stays as it was. The file is not
 * re-serialized, so key order, spacing and the unicode the file already holds survive.
 *
 * Fail closed: the input must pass `parseRoadmapFile` first; the output must pass it again and must equal the input document with
 * exactly the requested fields changed. Any mismatch throws `PlanWriteError` and no text is returned. Error text is fixed
 * wording plus a cleaned task key, never file content.
 */
export class PlanWriteError extends Error {
  constructor(
    readonly reason:
      | "duplicate_update"
      | "bad_update"
      | "unknown_task"
      | "duplicate_member"
      | "unsupported_layout"
      | "verify_failed",
    readonly key?: string,
  ) {
    super(
      key === undefined
        ? `roadmap write refused: ${reason}`
        : `roadmap write refused: ${reason} for task ${cleanText(key, 200)}`,
    );
    this.name = "PlanWriteError";
  }
}

export interface TaskUpdate {
  /** The `task_status` key, as a milestone lists it. */
  key: string;
  /** Replaces `status` when given. A short snake_case word. */
  status?: string;
  /** Replaces `prs` when given. Stored sorted ascending without repeats. */
  prs?: readonly number[];
  /** Replaces `open_prs` when given. Stored sorted ascending without repeats. An empty list on a row with no `open_prs` adds nothing. */
  openPrs?: readonly number[];
}

const STATUS_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

interface Member {
  key: string;
  keyStart: number;
  valueStart: number;
  valueEnd: number;
}

/** Index after the whitespace that starts at `i`. */
function skipWs(text: string, i: number): number {
  while (i < text.length && (text[i] === " " || text[i] === "\n" || text[i] === "\r" || text[i] === "\t")) i += 1;
  return i;
}

/** End (exclusive) of the string literal that opens at `i`. The input has already parsed as JSON, so it is well formed. */
function stringEnd(text: string, i: number): number {
  let j = i + 1;
  while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
  return j + 1;
}

/** End (exclusive) of the JSON value that starts at `i` (already past whitespace). */
function valueEnd(text: string, i: number): number {
  const c = text[i];
  if (c === '"') return stringEnd(text, i);
  if (c === "{" || c === "[") {
    const close = c === "{" ? "}" : "]";
    let j = skipWs(text, i + 1);
    if (text[j] === close) return j + 1;
    for (;;) {
      if (c === "{") {
        j = stringEnd(text, j);
        j = skipWs(text, j) + 1; // the colon
        j = skipWs(text, j);
      }
      j = valueEnd(text, j);
      j = skipWs(text, j);
      if (text[j] === close) return j + 1;
      j = skipWs(text, j + 1); // the comma
    }
  }
  let j = i;
  while (j < text.length && !",}] \n\r\t".includes(text[j]!)) j += 1;
  return j;
}

/** The members of the object that opens at `objStart`, with the spans of their keys and values. */
function membersOf(text: string, objStart: number): { members: Member[]; close: number } {
  const members: Member[] = [];
  let j = skipWs(text, objStart + 1);
  if (text[j] === "}") return { members, close: j };
  for (;;) {
    const keyStart = j;
    const keyEnd = stringEnd(text, j);
    const key = JSON.parse(text.slice(keyStart, keyEnd)) as string;
    j = skipWs(text, skipWs(text, keyEnd) + 1);
    const end = valueEnd(text, j);
    members.push({ key, keyStart, valueStart: j, valueEnd: end });
    j = skipWs(text, end);
    if (text[j] === "}") return { members, close: j };
    j = skipWs(text, j + 1);
  }
}

function uniqueMember(members: Member[], key: string, taskKey?: string): Member | undefined {
  const found = members.filter((m) => m.key === key);
  if (found.length > 1) throw new PlanWriteError("duplicate_member", taskKey);
  return found[0];
}

function normalizePrs(v: readonly number[], key: string): number[] {
  if (!Array.isArray(v) || v.some((n) => typeof n !== "number" || !Number.isInteger(n) || n < 1)) throw new PlanWriteError("bad_update", key);
  return [...new Set(v)].sort((a, b) => a - b);
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

export function applyTaskUpdates(text: string, updates: readonly TaskUpdate[]): string {
  const before = parseRoadmapFile(text); // the input must already be a valid plan file
  const counted = new Set(before.tasks.map((t) => t.key));

  const seen = new Set<string>();
  const wanted: { key: string; status?: string; prs?: number[]; openPrs?: number[] }[] = [];
  for (const u of updates) {
    if (typeof u.key !== "string" || u.key.length === 0) throw new PlanWriteError("bad_update");
    if (seen.has(u.key)) throw new PlanWriteError("duplicate_update", u.key);
    seen.add(u.key);
    if (!counted.has(u.key)) throw new PlanWriteError("unknown_task", u.key);
    const w: (typeof wanted)[number] = { key: u.key };
    if (u.status !== undefined) {
      if (typeof u.status !== "string" || !STATUS_PATTERN.test(u.status)) throw new PlanWriteError("bad_update", u.key);
      w.status = u.status;
    }
    if (u.prs !== undefined) w.prs = normalizePrs(u.prs, u.key);
    if (u.openPrs !== undefined) w.openPrs = normalizePrs(u.openPrs, u.key);
    wanted.push(w);
  }
  if (wanted.length === 0) return text;

  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const root = membersOf(text, skipWs(text, 0));
  const statusMember = uniqueMember(root.members, "task_status");
  if (!statusMember) throw new PlanWriteError("unsupported_layout");
  const rows = membersOf(text, statusMember.valueStart).members;

  const doc = JSON.parse(text) as { task_status: Record<string, Record<string, unknown>> };
  const expected = JSON.parse(text) as typeof doc;
  const edits: Edit[] = [];

  for (const w of wanted) {
    const rowMember = uniqueMember(rows, w.key, w.key);
    if (!rowMember) throw new PlanWriteError("unknown_task", w.key);
    const { members, close } = membersOf(text, rowMember.valueStart);
    if (members.length === 0) throw new PlanWriteError("unsupported_layout", w.key);

    // Layout of this row: the whitespace before its first key, and before its closing brace.
    const gap = (from: number) => {
      const lastNl = text.lastIndexOf("\n", from - 1);
      const ws = text.slice(lastNl + 1, from);
      return lastNl >= 0 && /^[ \t]*$/.test(ws) ? ws : null;
    };
    const indent = gap(members[0]!.keyStart); // null: the row is written on one line
    const closeIndent = gap(close) ?? "";
    const unit = indent !== null && indent.startsWith(closeIndent) && indent.length > closeIndent.length ? indent.slice(closeIndent.length) : "  ";

    const render = (value: unknown): string => {
      if (!Array.isArray(value)) return JSON.stringify(value);
      if (value.length === 0) return "[]";
      if (indent === null) return `[${value.join(", ")}]`;
      return `[${nl}${value.map((n) => `${indent}${unit}${n}`).join(`,${nl}`)}${nl}${indent}]`;
    };

    const fields: [string, unknown][] = [];
    if (w.status !== undefined) fields.push(["status", w.status]);
    if (w.prs !== undefined) fields.push(["prs", w.prs]);
    if (w.openPrs !== undefined) fields.push(["open_prs", w.openPrs]);

    let appended = "";
    for (const [name, value] of fields) {
      const current = doc.task_status[w.key]![name];
      const member = uniqueMember(members, name, w.key);
      if (member) {
        if (isDeepStrictEqual(current, value)) continue; // already right: leave the bytes alone
        edits.push({ start: member.valueStart, end: member.valueEnd, text: render(value) });
        expected.task_status[w.key]![name] = value;
      } else {
        if (name === "open_prs" && (value as number[]).length === 0) continue; // absent already means none
        const sep = indent === null ? ", " : `,${nl}${indent}`;
        appended += `${sep}${JSON.stringify(name)}: ${render(value)}`;
        expected.task_status[w.key]![name] = value;
      }
    }
    if (appended) {
      const last = members[members.length - 1]!;
      edits.push({ start: last.valueEnd, end: last.valueEnd, text: appended });
    }
  }

  // Apply from the end so earlier offsets stay valid. Edits never overlap: each touches one member value or one row's end.
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);

  // Fail closed: the result must parse as a plan file and equal the input document with only the requested fields changed.
  let reparsed: unknown;
  try {
    parseRoadmapFile(out);
    reparsed = JSON.parse(out);
  } catch {
    // fx-swallow-ok: the verify_failed error is the fixed reason; the parser's message can quote file content
    throw new PlanWriteError("verify_failed");
  }
  if (!isDeepStrictEqual(reparsed, expected)) throw new PlanWriteError("verify_failed");
  return out;
}
