// D#601 MEM-4a3: the Memory app's data side. Every call to the memory routes, and the pure rules the screens use (grouping a batch by source,
// counting unopened cards, the one formatter that keeps a null or an undefined off the screen, the sentence for each refusal). No DOM in here,
// so it is unit-tested with a fake get().
//
// The rules themselves (who may decide, one source per batch, opened before batched, the 20-card cap, the secret scan) live in the database and the
// routes. Nothing here repeats one; the app shows what the server answered.
import { api, isRateLimited, retryWords, waitSeconds } from "../_lib/api.js";

export const MEMORY_BODY_MAX_BYTES = 1024;
export const MEMORY_WHY_MAX_BYTES = 256;
export const BATCH_MAX = 20;
/** Kinds the filter offers, with the words a person sees (the same names the server's labels use). */
export const KINDS = [
  ["convention", "Convention"],
  ["command", "Command"],
  ["fact", "Fact"],
  ["gotcha", "Gotcha"],
  ["preference", "Preference"],
  ["decision", "Decision"],
];
export const STATUSES = [
  ["proposed", "Proposed"],
  ["approved", "Approved"],
  ["rejected", "Rejected"],
  ["expired", "Expired"],
  ["retired", "Retired"],
  ["deleted", "Deleted"],
  ["archived", "Archived"],
  ["superseded", "Superseded"],
];
/** A status as text plus an icon, never colour alone. The server names the icon; these are the glyphs. */
export const STATUS_GLYPHS = { inbox: "▤", check: "✓", cross: "✗", clock: "◷", pause: "‖", trash: "⌫", archive: "▣", replace: "↻", question: "?" };
const STATUS_ICON_BY_STATUS = { proposed: "inbox", approved: "check", rejected: "cross", expired: "clock", retired: "pause", deleted: "trash", archived: "archive", superseded: "replace" };

// ── the words (Spec copy where the Spec has it; the rest is listed in the PR for approval) ──
export const COPY = Object.freeze({
  title: "Memory",
  loading: "Loading memory…",
  unavailable: "Memory isn't available right now.",
  retry: "Try again",
  emptyAll: "No memory yet. Approve proposals as they arrive.",
  emptyScope: "No memory here yet.",
  emptyQueue: "Nothing is waiting for review.",
  queueTitle: "Waiting for review",
  listTitle: "All memory",
  unknownSource: "Unknown source",
  deletedEntry: "Deleted entry",
  approve: "Approve",
  editThenApprove: "Edit then approve",
  reject: "Reject",
  openCard: "Open card",
  notOpened: "Not opened yet",
  opened: "Opened",
  failed: "That didn't work. Nothing was changed.",
  secret: "That text looks like it holds a credential, so it was not saved. Take the credential out and try again.",
  forbidden: "Only an owner or admin can do that for this memory.",
  gone: "That memory entry is no longer there. The list was refreshed.",
  countUnavailable: "Count unavailable",
  // D#601 MEM-4b3
  transition: "That entry has already changed, so this can't be done now. The list was refreshed.",
  full: "That place already holds as much memory as it can. Retire or delete something there first.",
  changedSince: "This entry was changed since you opened this page, so nothing was changed. The list was refreshed.",
  noRights: "Only an owner or admin can change repo, account and role memory.",
  noEarlier: "This entry was never edited, so there is no earlier version.",
  checkingAccess: "Checking your access…",
  accessFailed: "Your access couldn't be checked, so changes are turned off. Reload to try again.",
  tooOld: "Deleted more than 30 days ago, so it can't be restored.",
});

/** The one formatter: a string, or the fallback. null, undefined, NaN and the strings "null" and "undefined" never reach a screen. */
export function text(value, fallback = "") {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return fallback;
  const t = value.trim();
  return t === "" || t === "null" || t === "undefined" || t === "NaN" ? fallback : t;
}

/** The status shown as { label, glyph }: the server's words when it sent them, ours otherwise. */
export function statusView(status, label, icon) {
  const s = text(status, "unknown");
  const known = STATUSES.find((x) => x[0] === s);
  const name = text(label, known ? known[1] : "Unknown status");
  const glyph = Object.hasOwn(STATUS_GLYPHS, icon) ? icon : STATUS_ICON_BY_STATUS[s] || "question";
  return { label: name, glyph: STATUS_GLYPHS[glyph], status: s };
}

/** "3 waiting". */
export function waitingWords(n) {
  return Number.isInteger(n) && n >= 0 ? n + " waiting" : COPY.countUnavailable;
}

/** The byte length the server limits (UTF-8). */
export function byteLength(s) {
  return new TextEncoder().encode(String(s)).length;
}

/** What is wrong with an edit before it is sent, or "". The server checks again; this only saves a round trip and names the limit. */
export function checkEdit(body, why) {
  const b = String(body).trim();
  if (b === "") return "Write the memory first.";
  if (byteLength(b) > MEMORY_BODY_MAX_BYTES) return "A memory is at most " + MEMORY_BODY_MAX_BYTES + " bytes. This one is " + byteLength(b) + ".";
  if (byteLength(String(why).trim()) > MEMORY_WHY_MAX_BYTES) return "The reason is at most " + MEMORY_WHY_MAX_BYTES + " bytes.";
  return "";
}

/** The sentence for a refusal. Only the fixed sentences of the memory routes (their messages carry no memory text) and ours are shown. */
export function failureWords(e) {
  if (isRateLimited(e)) return retryWords(waitSeconds(e));
  if (!e) return COPY.failed;
  if (e.code === "must_open_first" || e.code === "mixed_sources" || e.code === "conflict") return text(e.message, COPY.failed);
  if (e.code === "secret_detected") return COPY.secret;
  if (e.code === "invalid_transition") return COPY.transition;
  if (e.code === "memory_full") return COPY.full;
  if (e.status === 403) return COPY.forbidden;
  if (e.status === 404) return COPY.gone;
  if (e.status === 0 || e.kind === "server_error") return text(e.message, COPY.failed);
  return COPY.failed;
}

// ── reads ──
const isUuid = (v) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const arr = (v) => (Array.isArray(v) ? v : []);

export async function loadList(filters = {}, get = api, signal) {
  const q = [];
  if (filters.kinds && filters.kinds.length) q.push("kind=" + filters.kinds.join(","));
  if (filters.statuses && filters.statuses.length) q.push("status=" + filters.statuses.join(","));
  const body = await get("GET", "/api/v1/memory" + (q.length ? "?" + q.join("&") : ""), undefined, signal);
  const groups = arr(body && body.groups).map((g) => ({
    scope: text(g && g.scope, "account"),
    label: text(g && g.label, COPY.unknownSource),
    targetId: g && isUuid(g.target_id) ? g.target_id : null,
    entries: arr(g && g.entries).filter((e) => e && isUuid(e.id)),
  }));
  return { groups, truncated: !!(body && body.truncated) };
}

export async function loadQueue(get = api, signal) {
  const body = await get("GET", "/api/v1/memory/queue", undefined, signal);
  return { cards: arr(body && body.cards).filter((c) => c && c.entry && isUuid(c.entry.id)), truncated: !!(body && body.truncated) };
}

/** The installed repositories (id and owner/name), so a repo with no memory yet still has its header. A failure is an empty list, not an error. */
export async function loadRepos(get = api, signal) {
  try {
    const body = await get("GET", "/api/v1/repos?limit=100", undefined, signal);
    return arr(body && body.data).filter((r) => r && isUuid(r.id) && text(r.full_name) !== "").map((r) => ({ id: r.id, name: text(r.full_name) }));
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    return [];
  }
}

/** The pending counts for the badges: { repos: {id: n}, items: {id: n} }, or null when the route failed (a badge then says it is unavailable). */
export async function loadCounts(repoIds, itemIds, get = api, signal) {
  const repos = [...new Set(repoIds.filter(isUuid))].slice(0, 200);
  const items = [...new Set(itemIds.filter(isUuid))].slice(0, 200);
  if (repos.length === 0 && items.length === 0) return { repos: {}, items: {} };
  const q = [];
  if (repos.length) q.push("repo_ids=" + repos.join(","));
  if (items.length) q.push("item_ids=" + items.join(","));
  try {
    const body = await get("GET", "/api/v1/memory/pending-counts?" + q.join("&"), undefined, signal);
    return { repos: (body && body.repos) || {}, items: (body && body.items) || {} };
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    return null;
  }
}

export async function loadRuns(id, get = api, signal) {
  const body = await get("GET", "/api/v1/memory/" + encodeURIComponent(id) + "/runs", undefined, signal);
  const runs = arr(body && body.runs).filter((r) => r && isUuid(r.id));
  return { total: Number.isInteger(body && body.total) ? body.total : runs.length, runs, truncated: !!(body && body.truncated) };
}

// ── writes ──
export const openCard = (id, get = api) => get("POST", "/api/v1/memory/" + encodeURIComponent(id) + "/open");
export const decideOne = (id, to, get = api) => get("POST", "/api/v1/memory/" + encodeURIComponent(id) + "/decide", { to });
export const decideBatch = (ids, to, get = api) => get("POST", "/api/v1/memory/decide-batch", { ids, to });
export function editEntry(id, { body, why, kind }, get = api) {
  const payload = { body: String(body).trim(), why: String(why).trim() === "" ? null : String(why).trim() };
  if (kind) payload.kind = kind;
  return get("POST", "/api/v1/memory/" + encodeURIComponent(id) + "/edit", payload);
}

// ── D#601 MEM-4b3: undo, delete and restore, history, export ──
export const UNDO_MS = 30000;
export const DELETE_KEEP_DAYS = 30;
const DAY_MS = 86400000;
const id1 = (id) => "/api/v1/memory/" + encodeURIComponent(id);
export const revertEntries = (ids, action, get = api) => get("POST", "/api/v1/memory/revert", { ids, action });
export const deleteEntry = (id, get = api) => get("POST", id1(id) + "/delete");
export const restoreEntry = (id, get = api) => get("POST", id1(id) + "/restore");
export const restorePrevious = (id, get = api) => get("POST", id1(id) + "/restore-previous");

/** The history of one entry: fixed labels, who did it, and the stored versions (empty once the entry was purged; the events stay). */
export async function loadHistory(id, get = api, signal) {
  const body = await get("GET", id1(id) + "/history", undefined, signal);
  return {
    events: arr(body && body.events).filter((e) => e && typeof e.at === "string").map((e) => ({
      at: e.at, label: text(e.label, "Changed"), version: Number.isInteger(e.version) ? e.version : null, actor: text(e.actor_label, "Unknown"), toStatus: e.to_status,
    })),
    versions: arr(body && body.versions).filter((v) => v && isUuid(v.id)),
  };
}

/** Whole days left to restore an entry deleted at `deletedAt` (ISO). null when there is no usable time; 0 when the 30 days are over. */
export function daysLeft(deletedAt, now = Date.now()) {
  const at = typeof deletedAt === "string" ? Date.parse(deletedAt) : NaN;
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at + DELETE_KEEP_DAYS * DAY_MS - now) / DAY_MS)) : null;
}

/**
 * What a row offers. Each action: { key, label, enabled, reason }. A disabled action always carries its reason, and every action is disabled with
 * the rights sentence when the person may not change this entry (repo, account and role memory need an owner or admin; item memory is the server's call).
 * access: "checking" or "failed" (what /auth/me said) turns every action off with its own sentence. A deleted row's days left come from its deleted_at.
 */
export function rowActions(row, { isAdmin = false, access = "ok", now = Date.now() } = {}) {
  const allowed = access === "ok" && (isAdmin || row.scope === "item");
  const why = access === "checking" ? COPY.checkingAccess : access === "failed" ? COPY.accessFailed : COPY.noRights;
  const out = [];
  const add = (key, label, ok = true, reason = "") => out.push({ key, label, enabled: allowed && ok, reason: !allowed ? why : ok ? "" : reason });
  switch (row.status) {
    case "approved":
      add("retire", "Retire");
      add("restore_previous", "Restore previous version", Number.isInteger(row.version) && row.version > 1, COPY.noEarlier);
      add("delete", "Delete");
      break;
    case "rejected": add("reconsider", "Reconsider"); add("delete", "Delete"); break;
    case "expired": add("renew", "Renew"); add("delete", "Delete"); break;
    case "retired": add("restore_retired", "Restore"); add("delete", "Delete"); break;
    case "proposed": add("delete", "Delete"); break;
    case "deleted":
      const days = daysLeft(row.deleted_at, now);
      if (days === 0) add("restore", "Restore", false, COPY.tooOld);
      else add("restore", days === null ? "Restore" : "Restore (" + days + (days === 1 ? " day" : " days") + " left)");
      break;
    default: break;
  }
  return out;
}

/** The export for one repo as { filename, content, entries, omitted }. */
export async function buildExport(repoId, format, get = api, signal) {
  const b = await get("GET", "/api/v1/memory/export?repo_id=" + encodeURIComponent(repoId) + "&format=" + encodeURIComponent(format), undefined, signal);
  const n = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
  return { filename: text(b && b.filename, format === "claude" ? "CLAUDE.md" : "AGENTS.md"), content: typeof (b && b.content) === "string" ? b.content : "", entries: n(b && b.entries), omitted: n(b && b.omitted) };
}

/** "2 entries were left out because they look like they hold a secret." */
export function omittedWords(n) {
  return n === 1 ? "1 entry was left out because it looks like it holds a secret." : n + " entries were left out because they look like they hold a secret.";
}

/** The words of an Undo toast for a decision on these ids. */
export function decidedWords(to, n) {
  const what = n === 1 ? "1 card" : n + " cards";
  return to === "approved" ? "Approved " + what + "." : "Rejected " + what + ".";
}

// ── the queue ──
export const isGated = (card) => !!card && card.open_state !== "not_required";
export const isOpened = (card) => !card || card.open_state !== "unopened";

/**
 * The batches of one scope: cards grouped by source (the author kind and the source line the server sent). A batch is only ever one source, so the
 * route never has to refuse a mix from this screen (it still would). Each batch says whether it is gated and how many cards are still unopened.
 */
export function batchesOf(cards) {
  const byKey = new Map();
  for (const c of cards) {
    const kind = text(c.entry && c.entry.author_kind, "unknown");
    const source = text(c.source, COPY.unknownSource);
    const key = kind + "|" + source;
    if (!byKey.has(key)) byKey.set(key, { key, source, authorKind: kind, cards: [] });
    byKey.get(key).cards.push(c);
  }
  return [...byKey.values()].map((b) => {
    const gated = b.cards.some(isGated);
    const unopened = b.cards.filter((c) => isGated(c) && !isOpened(c)).length;
    return { ...b, gated, unopened, size: b.cards.length };
  });
}

/** The text on a batch button: the action, or why it cannot be pressed yet. */
export function batchButtonWords(batch, verb) {
  if (batch.size > BATCH_MAX) return "Too many to decide at once";
  if (batch.unopened > 0) return "Open each card first (" + batch.unopened + " left)";
  return verb + " all " + batch.size;
}

/** Cards grouped by scope label, in the order the server gave them. */
export function scopesOfCards(cards) {
  const byLabel = new Map();
  for (const c of cards) {
    const label = text(c.scope_label, COPY.unknownSource);
    const scope = text(c.entry && c.entry.scope, "account");
    const key = scope + "|" + label;
    if (!byLabel.has(key)) byLabel.set(key, { key, label, scope, cards: [] });
    byLabel.get(key).cards.push(c);
  }
  return [...byLabel.values()];
}

/** The reading of "Used in N runs": the number from the route (0 when none, never null). */
export function runsWords(row) {
  const n = Number.isInteger(row && row.runs) && row.runs >= 0 ? row.runs : 0;
  // Always the number, so 0 reads "Used in 0 runs" and never a word that could hide it.
  return { n, label: "Used in " + n + (n === 1 ? " run" : " runs") };
}

/** "Run 8b2c5e74": the short name of a run in a list. */
export const runName = (id) => "Run " + String(id).slice(0, 8);
