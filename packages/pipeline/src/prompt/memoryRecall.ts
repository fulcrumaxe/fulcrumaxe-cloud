import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { repoScopeRef } from "@fx/core/src/memory/index.js";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { MEMORY_SLOT_DEFAULT_BYTES, MEMORY_SLOT_MAX_BYTES, renderMemorySlot, type MemoryEntry, type MemoryPort, type RenderedMemory } from "./assemblePrompt.js";

/**
 * D#601 MEM-3: the memory store's side of the CX-2 port. It picks the approved entries a run is given, in the order the slot wants them; the
 * assembler's `renderMemorySlot` fences and labels them. Nothing here knows which model backend will read the prompt, so the same approved set
 * gives the same bytes to every one of them.
 *
 * What is recalled: only `approved` entries (a proposed, rejected, expired, retired, deleted, archived or superseded row is never selected),
 * from the account, the run's repository (keyed on its GitHub node id plus its installation, so a repository that moved is a different key),
 * the run's role, and the work item while it is open. An item that is merged or closed recalls nothing of its own; reopening it brings the
 * entries back, because this is read from the item's stage now and nothing is stored about it.
 *
 * What fits: when every entry fits the repository's slot, every entry is used. When not, they are taken in the order item, repo, role, account,
 * then by `ts_rank` of the entry against the item's title and Spec, then by id, and whole entries that do not fit are skipped (a cut command is
 * worse than a missing one). Item entries are chosen first against the whole slot and the stable part gets what they leave, so the two parts
 * together never exceed it. Ranking is full text in Postgres on one entry and one query: nothing in it is a statistic over other tenants' rows.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLE_RE = /^[a-z][a-z0-9_-]{0,63}$/;
/** A work item in one of these stages recalls none of its own entries. */
const CLOSED_STAGES: ReadonlySet<string> = new Set(["merged", "closed_unmerged", "closed"]);
const PRECEDENCE: Readonly<Record<string, number>> = { item: 0, repo: 1, role: 2, account: 3 };
/** The most words of the item's title and Spec that go into the ranking query. */
const QUERY_WORDS_MAX = 120;
const bytesOf = (s: string): number => Buffer.byteLength(s, "utf8");
/** D#601 MEM-8b: how much of an item's own records one run is given, and where each is cut. */
export const CORRECTION_NOTES_MAX = 5;
export const NOTE_CUT_BYTES = 1024;
export const RECEIPT_CUT_BYTES = 512;
export const CUT_MARKER = " [cut]";

/** Cuts `text` to at most `max` bytes at a character boundary and adds the visible marker; text that fits is returned as it is. */
export function cutWithMarker(text: string, max: number): { text: string; cut: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= max) return { text, cut: false };
  let end = max;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
  return { text: buf.subarray(0, end).toString("utf8") + CUT_MARKER, cut: true };
}

/** Characters that look like a delimiter character but are not one, mapped to the one they imitate. NFKC handles the fullwidth forms. */
const LOOKALIKES: Readonly<Record<string, string>> = {
  "∕": "/", "⁄": "/", "╱": "/", "⧸": "/",
  "‹": "<", "⟨": "<", "〈": "<", "«": "<", "›": ">", "⟩": ">", "〉": ">", "»": ">",
  "у": "u", "υ": "u", "ս": "u", "ո": "n", "п": "n", "т": "t", "г": "r", "ѕ": "s", "е": "e", "ԁ": "d",
  "У": "u", "Υ": "u", "Ս": "u", "Ո": "n", "П": "n", "Т": "t", "Г": "r", "Ѕ": "s", "Е": "e", "Ԁ": "d",
};
const spaced = (word: string): string => [...word].join("\\s*");
/** `<<UNTRUSTED EXTERNAL CONTENT>>`, `<<END UNTRUSTED>>` and their neutralised forms, in any letter case with space inside. */
const FENCE_PATTERN = new RegExp(`<\\s*<\\s*(?:${spaced("end")}\\s*)?${spaced("untrusted")}[^<>]{0,80}>\\s*>`, "gi");
/** `<untrusted>` and `</untrusted>`, the runner's block tags. */
const TAG_PATTERN = new RegExp(`<\\s*\\/?\\s*${spaced("untrusted")}\\s*>`, "gi");
export const FENCE_LOOKALIKE_MARKER = "[fence marker removed]";
/** A line that starts with `[scope/kind id@vN]`, the head every recalled line begins with: a body must not be able to pass as another entry. */
const HEAD_PATTERN = /^([ \t]*)\[((?:account|repo|item|role)\/[a-z_-]{1,20}\s+[^\]\n]{1,120}@v\d{1,9})\]/gim;

/**
 * Also turns a line-leading `[scope/kind id@vN]` into parentheses so a body cannot imitate another entry's head. Applied to every entry's text on the way OUT, whatever wrote it and whatever the database holds: a stored body only has the exact delimiters
 * refused, so a differently cased, spaced, fullwidth or lookalike delimiter (or the runner's `</untrusted>` tag) must not reach a prompt as one.
 * The match runs on a normalised copy (NFKC, format characters and combining marks dropped, lookalikes folded). Text with no match is returned
 * byte for byte; text with one comes back normalised with each match replaced by a marker.
 */
export function escapeFenceLookalikes(text: string): string {
  let norm = "";
  for (const char of text) {
    for (const piece of (LOOKALIKES[char] ?? char).normalize("NFKC")) {
      if (/^[\p{Cf}\p{Mn}]$/u.test(piece)) continue;
      norm += LOOKALIKES[piece] ?? piece;
    }
  }
  // A leading head pattern becomes `(scope/kind id@vN)`: still readable as the person's text, no longer a head.
  const out = norm.replace(FENCE_PATTERN, FENCE_LOOKALIKE_MARKER).replace(TAG_PATTERN, FENCE_LOOKALIKE_MARKER).replace(HEAD_PATTERN, "$1($2)");
  return out === norm ? text : out;
}

/** The OR query for `to_tsquery('english', ...)` from an item's title and Spec: plain alphanumeric words only, so nothing in them is query syntax. Null: no usable word. */
export function rankingQueryOf(title: string | null, spec: string | null): string | null {
  const words = `${title ?? ""} ${(spec ?? "").slice(0, 6000)}`.toLowerCase().match(/[a-z0-9]{3,30}/g) ?? [];
  const unique = [...new Set(words)].slice(0, QUERY_WORDS_MAX);
  return unique.length === 0 ? null : unique.join(" | ");
}

/** What the ledger records for a memory slot: about one token to four bytes, rounded up. */
export function memoryTokensOf(...slots: ReadonlyArray<Pick<RenderedMemory, "text"> | undefined>): number {
  return Math.ceil(slots.reduce((n, s) => n + (s === undefined ? 0 : bytesOf(s.text)), 0) / 4);
}

interface Row {
  id: string;
  scope: "account" | "repo" | "role" | "item";
  kind: string;
  body: string;
  why: string | null;
  author_kind: string;
  version: number;
  rank: number;
  /** A promoted receipt (MEM-8b): the receipt's text as it stands now, already cut. Its line is fenced whoever "wrote" the entry: a receipt's text is not a person's own. */
  receiptText?: string;
}

/** A stored entry as the assembler takes it. The trust class follows who wrote the bytes: a person's own text only, everything else is fenced data. */
function toEntry(r: Row): MemoryEntry {
  const body = escapeFenceLookalikes(r.body);
  if (r.receiptText !== undefined) {
    return { id: r.id, version: Number(r.version), name: body.slice(0, 60), origin: "agent", text: `${body} ${escapeFenceLookalikes(r.receiptText)}`, head: `[${r.scope}/${r.kind} ${r.id}@v${Number(r.version)}]` };
  }
  const why = r.why === null ? "" : ` (${escapeFenceLookalikes(r.why)})`;
  const name = body.split("\n", 1)[0]!.replace(/\s+/g, " ").trim().slice(0, 60);
  return {
    id: r.id,
    version: Number(r.version),
    name: name === "" ? `${r.scope}/${r.kind}` : name,
    origin: r.author_kind === "person" ? "person" : r.author_kind === "import" ? "import" : "agent",
    text: `${body}${why}`,
    head: `[${r.scope}/${r.kind} ${r.id}@v${Number(r.version)}]`,
  };
}

/** Rendered order inside a part: a person's lines first, then the rest, each by id, so the same set always gives the same prefix. */
const byRenderOrder = (a: MemoryEntry, b: MemoryEntry): number => (a.origin === "person" ? 0 : 1) - (b.origin === "person" ? 0 : 1) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The rendered size of `list` when it fits whole in `budget`, else null. The assembler's own renderer decides, so the two can never disagree. */
function wholeSize(list: readonly MemoryEntry[], budget: number): number | null {
  const r = renderMemorySlot(list, budget);
  return r.trimmedBytes === 0 && r.recalled.length === list.length ? bytesOf(r.text) : null;
}

/** Picks entries for `budget` bytes: all of them when they fit, else best first, whole entries only. `ranked` is best first. Returns them in render order. */
export function selectWithinBudget(ranked: readonly MemoryEntry[], budget: number): MemoryEntry[] {
  if (budget <= 0 || ranked.length === 0) return [];
  const all = [...ranked].sort(byRenderOrder);
  if (wholeSize(all, budget) !== null) return all;
  const kept: MemoryEntry[] = [];
  let used = 0;
  for (const entry of ranked) {
    // The smallest possible line, fence included, is longer than this: nothing else can fit.
    if (budget - used < 40) break;
    const size = wholeSize([...kept, entry].sort(byRenderOrder), budget);
    if (size === null) continue;
    kept.push(entry);
    used = size;
  }
  return kept.sort(byRenderOrder);
}

const CONTEXT_SQL = `SELECT r.gh_node_id, i.gh_installation_id, s.memory_slot_bytes, w.id AS item_id, w.title, w.stage, sp.body AS spec_body
    FROM repos r
    LEFT JOIN installations i ON i.account_id = r.account_id AND i.id = r.installation_id
    LEFT JOIN repo_context_settings s ON s.account_id = r.account_id AND s.repo_id = r.id
    LEFT JOIN work_items w ON w.account_id = r.account_id AND w.id = $3::uuid AND w.repo_id = r.id
    LEFT JOIN LATERAL (
      SELECT sv.body FROM spec_versions sv WHERE sv.account_id = w.account_id AND sv.work_item_id = w.id AND sv.erased_at IS NULL ORDER BY sv.version DESC LIMIT 1
    ) sp ON true
   WHERE r.account_id = $1 AND r.id = $2`;

const CANDIDATE_SQL = `SELECT id, scope, kind, body, why, author_kind, version,
       CASE WHEN $5::text IS NULL THEN 0 ELSE ts_rank(body_tsv, to_tsquery('english', $5)) END AS rank
    FROM memory_entries
   WHERE account_id = $1 AND status = 'approved' AND NOT (provenance ? 'receipt_id')
     AND (scope = 'account'
          OR (scope = 'repo' AND scope_ref = $2::text)
          OR (scope = 'role' AND scope_ref = $3::text)
          OR (scope = 'item' AND scope_ref = $4::text))`;

/** The account's approved promoted-receipt entries with the receipt's text as it stands now (D#601 MEM-8b, through the `memory_item_sources` view, migration 0884). */
const RECEIPT_SQL = `SELECT source_id AS id, version, author_kind, body, chosen, receipt_missing
    FROM memory_item_sources WHERE account_id = $1 AND source_kind = 'receipt'`;
/** The item's applied run notes, newest first, without the note the run itself applied. */
const CORRECTION_SQL = `SELECT source_id AS id, author_kind, body
    FROM memory_item_sources
   WHERE account_id = $1 AND work_item_id = $2 AND source_kind = 'correction' AND ($3::uuid IS NULL OR exclude_run_id IS DISTINCT FROM $3::uuid)
   ORDER BY at DESC NULLS LAST, source_id LIMIT ${CORRECTION_NOTES_MAX}`;
/** The item's latest completed cloud handoff note. The child run is excluded AFTER choosing the latest, so a newer handoff is never passed over for an older one. */
const HANDOFF_SQL = `SELECT source_id AS id, body, exclude_run_id
    FROM memory_item_sources WHERE account_id = $1 AND work_item_id = $2 AND source_kind = 'handoff'
   ORDER BY at DESC, source_id LIMIT 1`;

/** Best first: scope precedence, then the entry's rank against the item, then id. */
function rankedBy(rows: readonly Row[]): MemoryEntry[] {
  return [...rows]
    .sort((a, b) => (PRECEDENCE[a.scope]! - PRECEDENCE[b.scope]!) || Number(b.rank) - Number(a.rank) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(toEntry);
}

/** One of the item's own records as a line: cut at NOTE_CUT_BYTES with a visible marker, its hash taken of the text as handed over. A person's correction is the person's line; everything else is fenced. */
function sourceEntry(kind: "correction" | "handoff", id: string, body: string, authorKind: string): MemoryEntry {
  const { text, cut } = cutWithMarker(body, NOTE_CUT_BYTES);
  const safe = escapeFenceLookalikes(text);
  return {
    id: `${kind}:${id}`,
    version: 1,
    name: kind === "correction" ? `Correction ${id.slice(0, 8)}` : `Handoff note ${id.slice(0, 8)}`,
    origin: kind === "correction" && authorKind === "person" ? "person" : "agent",
    text: safe,
    head: `[item/${kind} ${id}@v1]`,
    source: { kind, sha256: createHash("sha256").update(safe, "utf8").digest("hex"), cut },
  };
}

interface ReceiptRow {
  id: string;
  version: number;
  author_kind: string;
  body: string;
  chosen: string | null;
  receipt_missing: boolean;
}

/** An entry the port left out on purpose, and why. */
export interface RecallSkip {
  id: string;
  reason: "receipt_missing";
}

/** The promoted-receipt rows that still have their receipt, as account-scope rows carrying the receipt's text cut for the prompt. A row whose receipt is gone is reported and left out. */
function receiptRows(rows: readonly ReceiptRow[], onSkip: (s: RecallSkip) => void): Row[] {
  const out: Row[] = [];
  for (const r of rows) {
    if (r.receipt_missing || r.chosen === null) {
      onSkip({ id: r.id, reason: "receipt_missing" });
      continue;
    }
    out.push({ id: r.id, scope: "account", kind: "decision", body: r.body, why: null, author_kind: r.author_kind, version: Number(r.version), rank: 0, receiptText: cutWithMarker(r.chosen, RECEIPT_CUT_BYTES).text });
  }
  return out;
}

/**
 * The memory port over Postgres. One tenant transaction per call (no user in the session: this is the pipeline's own read), then the
 * returned entries get `last_recalled_at` through `memory_mark_recalled` (migration 0806). The item part also carries the item's own records
 * (D#601 MEM-8b): its applied run notes (at most 5, newest first) and its latest completed cloud handoff note, after the item's approved entries.
 */
export function createMemoryPort(pool: Pool, options: { onSkip?: (s: RecallSkip) => void } = {}): MemoryPort {
  const onSkip = options.onSkip ?? ((): void => undefined);
  return {
    recall: async ({ accountId, repoId, workItemId, role, runId, slot }) => {
      if (slot !== "stable" && slot !== "item") return [];
      if (!UUID_RE.test(accountId) || !UUID_RE.test(repoId) || (workItemId !== undefined && !UUID_RE.test(workItemId)) || (runId !== undefined && !UUID_RE.test(runId))) return [];
      if (slot === "item" && workItemId === undefined) return [];
      return withTenant(pool, accountId, async (client) => {
        const ctx = (
          await client.query<{ gh_node_id: string | null; gh_installation_id: string | null; memory_slot_bytes: number | null; item_id: string | null; title: string | null; stage: string | null; spec_body: string | null }>(
            CONTEXT_SQL,
            [accountId, repoId, workItemId ?? null],
          )
        ).rows[0];
        if (ctx === undefined) return [];
        const budget = Math.min(ctx.memory_slot_bytes === null ? MEMORY_SLOT_DEFAULT_BYTES : Number(ctx.memory_slot_bytes), MEMORY_SLOT_MAX_BYTES);
        const itemOpen = ctx.item_id !== null && ctx.stage !== null && !CLOSED_STAGES.has(ctx.stage);
        // A repository with no node id or no installation has no key, so none of the repo's memory is recalled (never a fallback to another key).
        const repoRef = ctx.gh_node_id !== null && ctx.gh_installation_id !== null ? repoScopeRef(ctx.gh_node_id, ctx.gh_installation_id) : null;
        const { rows } = await client.query<Row>(CANDIDATE_SQL, [
          accountId,
          repoRef,
          role !== undefined && ROLE_RE.test(role) ? role : null,
          itemOpen ? workItemId : null,
          itemOpen ? rankingQueryOf(ctx.title, ctx.spec_body) : null,
        ]);
        const receipts = receiptRows((await client.query<ReceiptRow>(RECEIPT_SQL, [accountId])).rows, onSkip);
        // The item's own records, only while the item is open (closing it stops them, reopening brings them back: nothing is stored about that).
        const sources: MemoryEntry[] = [];
        if (itemOpen) {
          const notes = (await client.query<{ id: string; author_kind: string; body: string }>(CORRECTION_SQL, [accountId, workItemId, runId ?? null])).rows;
          for (const n of notes) sources.push(sourceEntry("correction", n.id, n.body, n.author_kind));
          const handoff = (await client.query<{ id: string; body: string; exclude_run_id: string | null }>(HANDOFF_SQL, [accountId, workItemId])).rows[0];
          if (handoff !== undefined && (runId === undefined || handoff.exclude_run_id !== runId)) sources.push(sourceEntry("handoff", handoff.id, handoff.body, "agent"));
        }
        const itemChosen = selectWithinBudget([...rankedBy(rows.filter((r) => r.scope === "item")), ...sources], budget);
        const chosen =
          slot === "item"
            ? itemChosen
            : selectWithinBudget(rankedBy([...rows.filter((r) => r.scope !== "item"), ...receipts]), budget - (itemChosen.length === 0 ? 0 : bytesOf(renderMemorySlot(itemChosen, budget).text)));
        // Only real entries are stamped: the item's own records are not rows of memory_entries.
        const stamped = chosen.filter((e) => e.source === undefined).map((e) => e.id);
        if (stamped.length > 0) await client.query("SELECT memory_mark_recalled($1::uuid[])", [stamped]);
        return chosen;
      });
    },
  };
}
