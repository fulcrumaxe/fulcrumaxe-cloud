// D#37 WS-F2a: the Runs app's data side. Read-only: it lists runs, loads one
// run and pages its events (JSON mode). WS-F2b adds the live helpers at the end. No DOM in here, so it is unit-tested
// with a fake get().
import { on, onRefresh } from "../../core/cloud-live.js";
import { api } from "../_lib/api.js";

export const LIST_LIMIT = 50;
export const EVENT_PAGE = 200; // the API's maximum page
export const EVENT_CAP = 2000;
const MAX_PAGES = 30; // a hard stop on top of the cap: 2,000 events is 10 full pages

/** What a run status is called on a chip. An unknown status shows as its own (filtered) text. */
export const STATUS_LABELS = {
  pending: "Waiting",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  timed_out: "Timed out",
  killed_spend: "Stopped at the spend limit",
  refused_spend: "Not started: spend limit",
  cancelled: "Cancelled",
};

export const isUuid = (v) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** "$1.25", or an em dash when the run has no cost yet. Small amounts keep 4 places so they don't read as free. */
export function formatUsd(usd) {
  if (typeof usd !== "number" || !Number.isFinite(usd)) return "—";
  return "$" + (usd !== 0 && Math.abs(usd) < 0.01 ? usd.toFixed(4) : usd.toFixed(2));
}

/** One page of runs. `cursor` is the previous page's next_cursor, or empty for the first page. */
export async function loadRunsPage(cursor, get = api, signal) {
  const url = "/api/v1/runs?limit=" + LIST_LIMIT + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
  const body = await get("GET", url, undefined, signal);
  const rows = body && Array.isArray(body.data) ? body.data.filter((r) => r && isUuid(r.id)).slice(0, LIST_LIMIT) : [];
  const next = body && typeof body.next_cursor === "string" && body.next_cursor !== "" && body.next_cursor !== cursor ? body.next_cursor : "";
  return { rows, next };
}

/**
 * Page a run's events from the start (Accept: application/json), following
 * next_cursor, up to EVENT_CAP. The JSON cursor is always resumable (an empty
 * page echoes its position), so the loop ends on an empty or short page, an
 * empty or repeated cursor, or the cap. `capped` is true only when at least
 * one more event exists past the cap.
 */
export async function loadRunEvents(id, get = api, signal) {
  const base = "/api/v1/runs/" + encodeURIComponent(id) + "/events?limit=";
  const events = [];
  let cursor = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    if (signal?.aborted) throw new Error("aborted");
    const want = Math.min(EVENT_PAGE, EVENT_CAP - events.length);
    const body = await get("GET", base + want + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""), undefined, signal);
    const rows = body && Array.isArray(body.data) ? body.data : [];
    events.push(...rows);
    const next = body && typeof body.next_cursor === "string" ? body.next_cursor : "";
    const more = rows.length === want && next !== "" && next !== cursor;
    if (!more) return { events, capped: false };
    cursor = next;
    if (events.length >= EVENT_CAP) break;
  }
  // The cap is reached: one probe row says whether the window really cuts something off.
  const probe = await get("GET", base + "1&cursor=" + encodeURIComponent(cursor), undefined, signal);
  return { events, capped: !!(probe && Array.isArray(probe.data) && probe.data.length > 0) };
}

/** One GET for the run and the paged events. Rejects if either fails (the detail shows one message). */
export async function loadRunDetail(id, get = api, signal) {
  const stop = new AbortController();
  signal?.addEventListener("abort", () => stop.abort());
  const runRead = get("GET", "/api/v1/runs/" + encodeURIComponent(id), undefined, stop.signal).catch((e) => {
    stop.abort();
    throw e;
  });
  const [run, ev] = await Promise.all([runRead, loadRunEvents(id, get, stop.signal)]);
  if (!run || typeof run !== "object") throw new Error("empty run");
  return { run, events: ev.events, capped: ev.capped };
}

// ── live (D#37 WS-F2b) ──────────────────────────────────────────────────────
/** Only these statuses open a stream (a terminal or unknown one does not). */
export const isLiveStatus = (s) => s === "pending" || s === "running";

/** The marker the server sends in place of an over-cap event. */
export const isTruncated = (p) => p !== null && typeof p === "object" && !Array.isArray(p) && p.truncated === true && Number.isFinite(p.original_bytes) && Object.keys(p).length === 2;

/** One event by seq, whole (JSON mode, one row after seq-1); null when it isn't there. */
export async function loadRunEvent(id, seq, get = api, signal) {
  const body = await get("GET", "/api/v1/runs/" + encodeURIComponent(id) + "/events?after_seq=" + (seq - 1) + "&limit=1", undefined, signal);
  const ev = body && Array.isArray(body.data) ? body.data[0] : null;
  return ev && ev.seq === seq ? ev : null;
}

/** What one run did, cost and shows (D#483 P5), raw: the detail validates it. Rejects on any failure. */
export const loadRunInsight = (id, get = api, signal) => get("GET", "/api/v1/runs/" + encodeURIComponent(id) + "/insight", undefined, signal);

/** One run for a list row. */
export const loadRun = (id, get = api, signal) => get("GET", "/api/v1/runs/" + encodeURIComponent(id), undefined, signal);

/** A changed run replaces its row, or goes on top when absent. */
export const upsertRow = (rows, run) => (rows.some((r) => r.id === run.id) ? rows.map((r) => (r.id === run.id ? run : r)) : [run, ...rows]);

/** A fresh first page on top; rows loaded by Show more stay below it. */
export const mergeFirstPage = (rows, fresh) => fresh.concat(rows.filter((r) => !fresh.some((f) => f.id === r.id)));

/** Run fn now, and once more at the window's end if asked again: 5 calls in 1 s make 2 runs. */
export function coalesce(fn, ms = 1000) {
  let timer = null, again = false;
  const run = () => { fn(); timer = setTimeout(() => { timer = null; if (again) { again = false; run(); } }, ms); };
  const trigger = () => (timer ? void (again = true) : run());
  trigger.cancel = () => { clearTimeout(timer); timer = null; again = false; };
  return trigger;
}

/** Account stream: a status change for a valid run id, and a refresh. Returns one unsubscribe. */
export function watchAccount({ onStatus, onRefresh: refresh }, live = { on, onRefresh }) {
  const offs = [live.on("run.status_changed", (dto) => { const id = dto && dto.data && dto.data.runId; if (isUuid(id)) onStatus(id); }), live.onRefresh(refresh)];
  return () => offs.forEach((off) => off());
}
