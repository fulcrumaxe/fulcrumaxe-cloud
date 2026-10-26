/**
 * D#483 S5-b2b: the "Planned PRs" table of a product Spec. The project manager offers rows (key, title, depends on); this is the one parser the Spec step, the Spec
 * store and the tests share. The store (`spec_versions.frontmatter.planned_prs`) is written only from what this accepts, and the database checks the keys again when an
 * approval creates the child items, so model text is never a key without passing the pattern below.
 *
 * A table with fewer than two rows is not a split: it reads as `none` (after its rows are checked), and the item stays one item with one pull request.
 */
export const PLANNED_PR_KEY_RE = /^[a-z0-9-]{1,32}$/;
/** `fix-<round>` and `check-<run>` are the sub-item keys the driver itself launches (a fix round, a check fix round); a planned PR may not use their names. */
export const RESERVED_PLANNED_PR_PREFIXES = ["fix-", "check-"] as const;
export const MAX_PLANNED_PRS = 12;
export const MAX_PLANNED_PR_TITLE = 120;
/** One printable line with nothing that would break a markdown table cell. */
const TITLE_RE = /^[^\p{Cc}\p{Cs}\p{Cf}\p{Zl}\p{Zp}|`]{1,120}$/u;

export interface PlannedPr {
  key: string;
  title: string;
  depends_on: string[];
}

export type PlannedPrsParse = { kind: "none" } | { kind: "ok"; rows: PlannedPr[] } | { kind: "invalid" } | { kind: "too_large" };

export function isPlannedPrKey(key: unknown): key is string {
  return typeof key === "string" && PLANNED_PR_KEY_RE.test(key) && !RESERVED_PLANNED_PR_PREFIXES.some((p) => key.startsWith(p));
}

/** An own data property only: an inherited or accessor property reads as absent. */
function own(o: object, name: string): unknown {
  const d = Object.getOwnPropertyDescriptor(o, name);
  return d !== undefined && "value" in d ? d.value : undefined;
}

/** `value` is the model's `planned_prs` (or the stored frontmatter field). Absent, null or an empty array is `none`. Anything unreadable is `invalid`; the whole table is refused, never a part of it. */
export function parsePlannedPrs(value: unknown): PlannedPrsParse {
  if (value === undefined || value === null) return { kind: "none" };
  if (!Array.isArray(value)) return { kind: "invalid" };
  if (value.length === 0) return { kind: "none" };
  if (value.length > MAX_PLANNED_PRS) return { kind: "too_large" };
  const rows: PlannedPr[] = [];
  for (const raw of value as unknown[]) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { kind: "invalid" };
    const key = own(raw, "key");
    const title = own(raw, "title");
    const deps = own(raw, "depends_on") ?? [];
    if (!isPlannedPrKey(key) || typeof title !== "string") return { kind: "invalid" };
    const t = title.trim();
    if (!TITLE_RE.test(t)) return { kind: "invalid" };
    if (!Array.isArray(deps) || deps.length > MAX_PLANNED_PRS || !deps.every((d) => typeof d === "string")) return { kind: "invalid" };
    rows.push({ key, title: t, depends_on: Array.from(deps as string[]) });
  }
  const keys = new Set(rows.map((r) => r.key));
  if (keys.size !== rows.length) return { kind: "invalid" };
  for (const r of rows) {
    if (new Set(r.depends_on).size !== r.depends_on.length) return { kind: "invalid" };
    if (r.depends_on.some((d) => d === r.key || !keys.has(d))) return { kind: "invalid" };
  }
  // A cycle would leave rows that can never start: refuse it here, once.
  const left = new Map(rows.map((r) => [r.key, new Set(r.depends_on)]));
  for (let progressed = true; left.size > 0 && progressed; ) {
    progressed = false;
    for (const [k, deps] of left) {
      if (![...deps].some((d) => left.has(d))) {
        left.delete(k);
        progressed = true;
      }
    }
  }
  if (left.size > 0) return { kind: "invalid" };
  return rows.length < 2 ? { kind: "none" } : { kind: "ok", rows };
}

/** The section the pipeline writes into the Spec body, from rows `parsePlannedPrs` accepted (the person reads it before approving). */
export function plannedPrsSection(rows: readonly PlannedPr[]): string[] {
  return [
    "",
    "### Planned PRs",
    "",
    "Approving this Spec creates one item for each row below; each item is built as its own pull request.",
    "",
    "| Key | Title | Depends on |",
    "| --- | --- | --- |",
    ...rows.map((r) => `| ${r.key} | ${r.title} | ${r.depends_on.length === 0 ? "none" : r.depends_on.join(", ")} |`),
  ];
}
