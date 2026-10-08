import { classifyAuthor, type RepoPermission } from "@fx/trust";
import { cleanText, type ParsedPlan, type PlanMilestone, type PlanTaskRow } from "./roadmapFile.js";

/**
 * D#483 S3 level 2: the plan read from the Spec task tables of a repository's Discussions, for a repo with no roadmap file.
 * Pure: it is given what was read and answers with the same `ParsedPlan` that level 1 produces, so the counting rule, the
 * done rule (a pull request must DECLARE a task complete) and the writer are shared.
 *
 * Which Discussions: the body has a `## Spec` heading, or a `STATUS:` line of SPEC_READY, IMPLEMENTING, REVIEWING or DONE.
 * Tables: every markdown table whose header has an id column (`Task`, `ID`, `PR` or `#`). Planned PRs come from a column named
 * `planned` or `PRs` (default 1); the description is the first other column that is not an estimate or dependency column.
 * Corrections: a comment whose first line is `## Correction C<n>` or `### Correction C<n>`, from a TRUSTED author, applied in
 * time order. A row whose id already exists replaces that row. A new row whose id is an existing id plus a suffix makes that
 * existing row a split parent (kept out of the counts, as level 1 does), and the new row its child.
 * Each Discussion with at least one counted task is one milestone, "D#<n> <title>"; a task is `D#<n>:<id>`.
 *
 * Not read: the estimate and dependency columns. Nothing in S3 stores them, and the done rule never uses a dependency.
 */
export interface SpecDiscussion {
  number: number;
  title: string;
  body: string;
}
export interface SpecComment {
  body: string;
  createdAt: string;
  authorLogin: string | null;
}

const SPEC_HEADING = /^##\s+Spec\b/m;
const SPEC_STATUS = /^[\s>*_-]*STATUS:?[\s*_]*(?:SPEC_READY|IMPLEMENTING|REVIEWING|DONE)\b/m;
const CORRECTION_FIRST_LINE = /^#{2,3}\s+Correction\s+C\d+\b/;
const ID_HEADERS = new Set(["task", "id", "pr", "#"]);
const ID_VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DESCRIPTION_CHARS = 300;

export function isSpecDiscussion(body: string): boolean {
  return SPEC_HEADING.test(body) || SPEC_STATUS.test(body);
}

/** True when the first non-empty line is a Correction heading (the body is still untrusted until its author is checked). */
export function isCorrectionComment(body: string): boolean {
  return CORRECTION_FIRST_LINE.test(body.replace(/^\s+/, "").split(/\r?\n/, 1)[0] ?? "");
}

interface Row {
  id: string;
  planned: number;
  description: string;
  parent: string | null;
}

function cellsOf(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}
const isTableLine = (line: string): boolean => line.trim().startsWith("|") && line.includes("|", line.indexOf("|") + 1);
const isSeparator = (line: string): boolean => isTableLine(line) && cellsOf(line).every((c) => /^:?-{2,}:?$/.test(c));
const plain = (cell: string): string => cell.replace(/[*_`]/g, "").trim();

/** Every table of `text` that has an id column, as rows in order. */
function tablesOf(text: string): Row[][] {
  const lines = text.split(/\r?\n/);
  const tables: Row[][] = [];
  for (let i = 0; i + 1 < lines.length; i += 1) {
    if (!isTableLine(lines[i]!) || !isSeparator(lines[i + 1]!)) continue;
    const header = cellsOf(lines[i]!).map((h) => plain(h).toLowerCase());
    const idCol = header.findIndex((h) => ID_HEADERS.has(h));
    let j = i + 2;
    const rows: Row[] = [];
    for (; j < lines.length && isTableLine(lines[j]!); j += 1) {
      if (idCol === -1) continue;
      const cells = cellsOf(lines[j]!);
      const id = plain(cells[idCol] ?? "");
      if (!ID_VALUE.test(id)) continue;
      const words = (h: string) => h.split(/[^a-z#]+/);
      let planned = 1;
      let description = "";
      header.forEach((h, c) => {
        if (c === idCol) return;
        const w = words(h);
        if (w.includes("planned") || w.includes("prs")) {
          const n = /^\d+$/.test(plain(cells[c] ?? "")) ? Number(plain(cells[c]!)) : NaN;
          if (Number.isSafeInteger(n)) planned = n;
        } else if (w.some((x) => ["estimate", "lines", "size", "depends", "after", "needs"].includes(x))) {
          // read by no one in S3
        } else if (description === "") {
          description = cleanText(cells[c] ?? "", DESCRIPTION_CHARS);
        }
      });
      rows.push({ id, planned, description, parent: null });
    }
    tables.push(rows);
    i = j - 1;
  }
  return tables;
}

/** The longest existing id that `id` extends by a suffix (`P1` does not parent `P10`), or null. */
function parentOf(id: string, existing: Iterable<string>): string | null {
  let best: string | null = null;
  for (const p of existing) {
    if (id.length <= p.length || !id.startsWith(p)) continue;
    if (/\d$/.test(p) && /^\d/.test(id.slice(p.length))) continue;
    if (best === null || p.length > best.length) best = p;
  }
  return best;
}

/**
 * `comments` per Discussion number; `trusted` holds the lower-cased logins whose real repository permission makes their
 * Corrections count (decided by `trustedCorrectionAuthors`). An untrusted Correction is ignored whole.
 */
export function parseSpecTables(
  discussions: readonly SpecDiscussion[],
  comments: ReadonlyMap<number, readonly SpecComment[]>,
  trusted: ReadonlySet<string>,
): ParsedPlan {
  const milestones: PlanMilestone[] = [];
  const tasks: PlanTaskRow[] = [];
  for (const d of [...discussions].sort((a, b) => a.number - b.number)) {
    if (!isSpecDiscussion(d.body)) continue;
    const rows = new Map<string, Row>();
    const splitParents = new Set<string>();
    for (const t of tablesOf(d.body)) for (const r of t) rows.set(r.id, r);
    const corrections = (comments.get(d.number) ?? [])
      .filter((c) => isCorrectionComment(c.body) && c.authorLogin !== null && trusted.has(c.authorLogin.toLowerCase()))
      .map((c, order) => ({ c, order }))
      .sort((a, b) => (a.c.createdAt < b.c.createdAt ? -1 : a.c.createdAt > b.c.createdAt ? 1 : a.order - b.order));
    for (const { c } of corrections) {
      for (const t of tablesOf(c.body)) {
        for (const r of t) {
          const existing = rows.get(r.id);
          if (existing) {
            rows.set(r.id, { ...r, parent: existing.parent });
            continue;
          }
          const parent = parentOf(r.id, rows.keys());
          if (parent !== null) splitParents.add(parent);
          rows.set(r.id, { ...r, parent });
        }
      }
    }
    const mkey = `D#${d.number}`;
    const title = cleanText(d.title, 150);
    const taskKeys: string[] = [];
    for (const r of rows.values()) {
      if (splitParents.has(r.id)) continue; // a split parent: not counted
      const key = `${mkey}:${r.id}`;
      taskKeys.push(key);
      tasks.push({
        key,
        milestoneKey: mkey,
        discussionNumber: d.number,
        plannedPrs: r.planned,
        filePrs: [],
        fileOpenPrs: [],
        fileStatus: null,
        parentKey: r.parent === null ? null : `${mkey}:${r.parent}`,
        note: r.description || `${title} ${r.id}`.trim(),
      });
    }
    if (taskKeys.length > 0) milestones.push({ key: mkey, title: `${mkey} ${title}`.trim().slice(0, 200), position: milestones.length, taskKeys });
  }
  return { milestones, tasks };
}

export interface CorrectionAuthorSource {
  authorPermission(login: string): Promise<RepoPermission>;
}

/**
 * The lower-cased logins, among the authors of Correction comments, that author-trust.ts calls trusted (admin or maintain on
 * the repository, from the real permission API; the body is never consulted). One lookup per distinct login. Everyone else,
 * and anyone whose lookup cannot be made because the request budget is spent, is untrusted.
 */
export async function trustedCorrectionAuthors(
  comments: ReadonlyMap<number, readonly SpecComment[]>,
  source: CorrectionAuthorSource,
  onBudget: () => void,
): Promise<Set<string>> {
  const logins = new Set<string>();
  for (const list of comments.values()) for (const c of list) if (c.authorLogin && isCorrectionComment(c.body)) logins.add(c.authorLogin);
  const trusted = new Set<string>();
  for (const login of [...logins].sort()) {
    let repoPermission: RepoPermission;
    try {
      repoPermission = await source.authorPermission(login);
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === "request_budget_exceeded") {
        onBudget();
        break;
      }
      throw err;
    }
    if (classifyAuthor({ login, repoPermission, allowlist: [] }) === "trusted") trusted.add(login.toLowerCase());
  }
  return trusted;
}
