// D#37 WS-F1a: the Pipeline board's data side. Read-only: it lists work items
// and repos, groups them into columns by stage, and keeps them current from the
// live client's events. No DOM in here, so it is unit-tested with fakes.
import { api } from "../_lib/api.js";

/** Board columns, left to right. `Done` holds three stages; the card says which. */
export const COLUMNS = [
  { id: "triaged", label: "Triaged", stages: ["triaged"] },
  { id: "discussing", label: "Discussing", stages: ["discussing"] },
  { id: "spec_ready", label: "Spec ready", stages: ["spec_ready"] },
  { id: "in_progress", label: "In progress", stages: ["in_progress"] },
  { id: "pr_opened", label: "PR opened", stages: ["pr_opened"] },
  { id: "changes_requested", label: "Changes requested", stages: ["changes_requested"] },
  { id: "review_passed", label: "Review passed", stages: ["review_passed"] },
  { id: "needs_human", label: "Needs a person", stages: ["needs_human"] },
  { id: "done", label: "Done", stages: ["merged", "closed_unmerged", "closed"] },
];

/** What a stage is called on a card and in its detail history (all 11 stages). */
export const STAGE_LABELS = {
  triaged: "Triaged",
  discussing: "Discussing",
  spec_ready: "Spec ready",
  in_progress: "In progress",
  pr_opened: "PR opened",
  changes_requested: "Changes requested",
  review_passed: "Review passed",
  needs_human: "Needs a person",
  merged: "Merged",
  closed_unmerged: "Closed without merging",
  closed: "Closed",
};

// The verdict line comes from the stage alone; the timeline is never read for it.
const VERDICTS = {
  changes_requested: "Review asked for changes",
  review_passed: "Review passed",
  needs_human: "Needs a person",
};

export const REVIEWER_LABELS = {
  code: "Code review",
  security: "Security review",
  acceptance: "Acceptance review",
};

const COLUMN_OF = new Map(COLUMNS.flatMap((c) => c.stages.map((s) => [s, c.id])));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PAGES = 40;

export const isUuid = (v) => typeof v === "string" && UUID.test(v);
/** A stage this build does not know maps to no column. */
export const columnOf = (stage) => COLUMN_OF.get(stage) || null;
export const verdictFor = (stage) => VERDICTS[stage] || null;

/** Items grouped by column id, newest update first. Unknown stages are left out. */
export function groupByColumn(items) {
  const out = Object.fromEntries(COLUMNS.map((c) => [c.id, []]));
  for (const item of items) {
    const col = columnOf(item.stage);
    if (col) out[col].push(item);
  }
  const at = (i) => Date.parse(i.updated_at) || 0;
  for (const list of Object.values(out)) list.sort((a, b) => at(b) - at(a) || (a.id < b.id ? -1 : 1));
  return out;
}

/** GET a list route and follow next_cursor to the end. */
export async function getAllPages(path, get = api, signal) {
  const rows = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = cursor ? path + "?cursor=" + encodeURIComponent(cursor) : path;
    const body = await get("GET", url, undefined, signal);
    if (body && Array.isArray(body.data)) rows.push(...body.data);
    const next = body && typeof body.next_cursor === "string" ? body.next_cursor : null;
    if (!next || next === cursor) break;
    cursor = next;
  }
  return rows;
}

export const loadTimeline = (id, get = api, signal) => get("GET", "/api/v1/work-items/" + id + "/timeline", undefined, signal);

/**
 * The stages at which an item is mid-pipeline: something is about to move it (an agent, a webhook, the merge gate, a
 * person's click), so the board keeps re-reading while one is on it. Done and Needs a person are resting places.
 */
export const ACTIVE_STAGES = new Set(["triaged", "discussing", "spec_ready", "in_progress", "pr_opened", "changes_requested", "review_passed"]);
/** How often the board re-reads itself while any item is in an active stage (the fallback for a stage change no live event announced). */
export const POLL_MS = 20000;

/** True when the two lists hold the same rows (compared by value, in any order). */
export function sameItems(a, b) {
  if (a.size !== b.size) return false;
  for (const [id, row] of b) {
    const have = a.get(id);
    if (!have || JSON.stringify(have) !== JSON.stringify(row)) return false;
  }
  return true;
}

const validItem = (i) => i && typeof i === "object" && isUuid(i.id) && typeof i.stage === "string";
const stamp = (i) => Date.parse(i && i.updated_at) || 0;

/**
 * The board model. `getState()` returns the current state, which is replaced
 * (never mutated) on every change and handed to `onChange`. Timers are the
 * global ones, so a test drives them with a fake clock.
 */
export function createBoard({ get = api, onChange = () => {}, coalesceMs = 1000, pollMs = POLL_MS, hidden = () => typeof document !== "undefined" && document.hidden } = {}) {
  const ac = new AbortController();
  const disposers = [];
  const inflight = new Map(); // work item id -> { again }
  let destroyed = false;
  let listSeq = 0;
  let cooling = false;
  let pending = false;
  let pendingRepos = false;
  let cooldown = null;
  let pollTimer = null;
  let polling = false;
  let state = { status: "loading", items: new Map(), repos: new Map() };

  const set = (patch) => {
    if (destroyed) return;
    state = { ...state, ...patch };
    onChange(state);
  };

  // `quiet` is the poll's read: an answer that is the same as what is showing changes nothing and redraws nothing, so a
  // scrolled column, an open card and the focus stay where they are.
  async function loadList(quiet = false) {
    const seq = ++listSeq;
    try {
      const rows = await getAllPages("/api/v1/work-items", get, ac.signal);
      if (destroyed || seq !== listSeq) return;
      const items = new Map();
      for (const row of rows) {
        if (!validItem(row)) continue;
        const have = state.items.get(row.id);
        items.set(row.id, have && stamp(have) > stamp(row) ? have : row);
      }
      if (quiet && state.status === "ready" && sameItems(state.items, items)) return;
      set({ status: "ready", items });
    } catch {
      // A failed re-load keeps the board that is already showing.
      if (!destroyed && seq === listSeq && state.status !== "ready") set({ status: "error" });
    }
  }

  // Repos only label the cards: a failure leaves the labels as they were.
  async function loadRepos() {
    try {
      const rows = await getAllPages("/api/v1/repos", get, ac.signal);
      if (destroyed) return;
      const repos = new Map();
      for (const r of rows) if (r && typeof r.id === "string" && typeof r.product === "string") repos.set(r.id, r.product);
      set({ repos });
    } catch {
      /* cards fall back to #<issue_number> */
    }
  }

  const load = () => Promise.all([loadList(), loadRepos()]);

  async function applyItem(id) {
    if (destroyed || !isUuid(id)) return;
    const rec = inflight.get(id);
    if (rec) {
      rec.again = true;
      return;
    }
    const mine = { again: false };
    inflight.set(id, mine);
    try {
      do {
        mine.again = false;
        try {
          const item = await get("GET", "/api/v1/work-items/" + id, undefined, ac.signal);
          if (destroyed) return;
          if (validItem(item)) {
            const have = state.items.get(item.id);
            if (!have || stamp(item) >= stamp(have)) set({ items: new Map(state.items).set(item.id, item) });
          }
        } catch (e) {
          if (destroyed) return;
          if (e && e.status === 404 && state.items.has(id)) {
            const items = new Map(state.items);
            items.delete(id);
            set({ items });
          }
        }
      } while (mine.again && !destroyed);
    } finally {
      inflight.delete(id);
    }
  }

  // One list load now and at most one more when the cooldown ends, however many triggers arrive.
  function run(withRepos) {
    cooling = true;
    cooldown = setTimeout(() => {
      cooling = false;
      if (pending) {
        const again = pendingRepos;
        pending = pendingRepos = false;
        run(again);
      }
    }, coalesceMs);
    loadList();
    if (withRepos) loadRepos();
  }
  function trigger(withRepos) {
    if (destroyed) return;
    if (cooling) {
      pending = true;
      pendingRepos = pendingRepos || withRepos;
    } else run(withRepos);
  }

  /**
   * The fallback for a lost live connection (and for a stage change nothing announced): while any item is in an active
   * stage, the list is read again every pollMs, and the board is redrawn only when the answer differs. Skipped while the
   * page is hidden or the last read is still going. The events stay the fast path; this only catches what they miss.
   */
  async function poll() {
    if (destroyed || polling || hidden()) return;
    if (![...state.items.values()].some((i) => ACTIVE_STAGES.has(i.stage))) return;
    polling = true;
    try {
      await loadList(true);
    } finally {
      polling = false;
    }
  }

  function connectLive({ on, onRefresh }) {
    if (pollTimer === null) pollTimer = setInterval(poll, pollMs);
    const onItem = (dto) => {
      const id = dto && dto.data && dto.data.workItemId;
      if (isUuid(id)) applyItem(id);
    };
    // The event's own `stage` is never trusted: the item is read again and placed by what comes back.
    disposers.push(on("pr.opened", onItem), on("work_item.needs_human", onItem), on("work_item.stage_changed", onItem));
    disposers.push(on("run.status_changed", () => trigger(false)));
    disposers.push(onRefresh(() => trigger(true)));
  }

  function destroy() {
    destroyed = true;
    clearTimeout(cooldown);
    if (pollTimer !== null) clearInterval(pollTimer);
    pollTimer = null;
    ac.abort();
    while (disposers.length) disposers.pop()();
  }

  return { getState: () => state, load, poll, applyItem, connectLive, destroy };
}
