// D#37 WS-F2a: the Runs app. The account's runs as a list, and one run's events
// replayed in a detail pane; WS-F2b keeps both live (the open run's stream, and
// the account stream's status changes for the list). Read-only:
// there is no Cancel or Retry (those are WS-F1c's). Text only, built with h().
//
// Registration goes through the FULC global (see the Developer app's header
// comment: an ES import of the SDK would blow the boot request budget).
import { h, timeNode } from "../_lib/dom.js";
import { renderMarkdown } from "../_lib/markdown.js";
import { crossesBoundary, displayText, hasToolName, nextCarry } from "./runs-display-filter.js";
import { openRunStream } from "../_lib/stream.js";
import { foldBox, guardToolName, headLinks, headMeta, readInsight, renderInsight, runnerEventLine, titleOf } from "./runs-detail.js";
import {
  EVENT_CAP, STATUS_LABELS, coalesce, formatUsd, isLiveStatus, isTruncated, loadRun, loadRunDetail, loadRunEvent, loadRunInsight, loadRunsPage, mergeFirstPage, upsertRow, watchAccount,
} from "./runs-storage.js";

const FULC = window.FULC;
if (!FULC || typeof FULC.register !== "function") {
  throw new Error("Runs app: the FULC SDK global is missing");
}

// How run data is drawn. Everything is a text node or a createElement node built
// with h(); every string taken from run data goes through the display filter
// first. An event is drawn by its `kind` alone, and a kind this build does not
// know is one bare line, never an error. (These live in this file, not their
// own: every literal import counts as a boot file, and the app is at its 5, the per-app ceiling.)
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const short = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);

/** A status as words: our label, or the (filtered, shortened) status itself. */
function statusLabel(status) {
  if (typeof status !== "string" || status === "") return "Unknown";
  return Object.hasOwn(STATUS_LABELS, status) ? STATUS_LABELS[status] : short(displayText(status), 40);
}

function statusChip(status) {
  const s = typeof status === "string" ? status.replace(/[^a-z_]/g, "") : "";
  return h("span", { class: "runs-chip runs-chip-" + (s || "unknown"), "data-testid": "runs-chip", "data-status": s }, statusLabel(status));
}

/** "fulcrumaxe <role>": the name a person sees for a run's role. */
function roleName(role) {
  return "fulcrumaxe " + (typeof role === "string" && role ? short(displayText(role), 60) : "run");
}

/** Strict ISO-8601 with a zone (the value goes into title and datetime). */
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/;
const validTime = (iso) => typeof iso === "string" && ISO.test(iso) && !Number.isNaN(Date.parse(iso));

function plainLine(text, testid) {
  return h("p", { class: "runs-ev-line", "data-testid": testid || "run-event-text" }, text);
}

// The text of a rendered markdown tree, checked as one string: a name split by
// emphasis marks ("Claude *Code*") is two text nodes the per-string filter never
// sees together. If it would still read as the tool name, show the flat text instead.
function markdownBody(text) {
  const tree = renderMarkdown(text, displayText);
  if (!hasToolName(tree.textContent)) return tree;
  return h("div", { class: "md" }, h("p", null, displayText(tree.textContent)));
}

function body(ev) {
  const p = ev.payload;
  if (isTruncated(p)) {
    return plainLine("This event is too large to show live (" + p.original_bytes + " bytes).", "run-event-truncated");
  }
  switch (ev.kind) {
    case "run.created":
      return plainLine(isObj(p) && typeof p.role === "string" ? "Started: " + roleName(p.role) : "Started");
    case "run.status_changed":
      return plainLine(isObj(p) ? statusLabel(p.from) + " → " + statusLabel(p.to) : "Status changed");
    case "checkpoint":
      return plainLine("Checkpoint saved");
    case "limit_extended":
      return plainLine(isObj(p) && typeof p.kind === "string" && /^[a-z_]{1,32}$/.test(p.kind) ? "Limit extended (" + displayText(p.kind) + ")" : "Limit extended");
    case "agent.output":
      if (isObj(p) && typeof p.text === "string") return markdownBody(p.text);
      return plainLine(short(displayText(ev.kind), 80));
    case "runner.event":
      return plainLine(runnerEventLine(p));
    default:
      return plainLine(short(displayText(ev.kind), 80));
  }
}

/** One <li> for one event. A malformed event still draws (as a bare line). */
function eventItem(ev) {
  const e = isObj(ev) ? ev : {};
  const kind = typeof e.kind === "string" ? e.kind : "";
  return h(
    "li",
    { class: "runs-ev", "data-testid": "run-event", "data-seq": Number.isFinite(e.seq) ? String(e.seq) : "" },
    validTime(e.at) ? h("span", { class: "runs-ev-time" }, timeNode(e.at, true)) : null,
    body({ kind, payload: e.payload })
  );
}

/** The <li>s; a bare "…" item goes where two would read as the tool name. */
function eventItems(events) {
  let carry = "";
  return events.flatMap((ev) => {
    const li = eventItem(ev);
    const gap = crossesBoundary(carry, li.textContent);
    carry = nextCarry(gap ? "" : carry, li.textContent);
    return gap ? [h("li", { "aria-hidden": "true" }, "…"), li] : [li];
  });
}
const UNAVAILABLE = "This run isn't available right now.";
const CAPPED = "This run has more events than the window shows.";
const INSIGHT_UNAVAILABLE = "What this run did isn't available right now. Its events are below.";

let current = null;

function teardown() {
  if (current) {
    current.destroy();
    current = null;
  }
}

function mountApp(contentEl) {
  let rows = []; // the runs loaded so far, in the order the server gave them
  let next = ""; // next_cursor of the last list page; "" = no more
  let listState = "loading"; // loading | ready | error
  let more = null; // a Show more request in flight
  let openId = null;
  let detail = null; // { status: loading | ready | error, run, events, capped }
  let listAc = null;
  let detailAc = null;
  let stream = null; // the open run's live stream
  let extended = false; // Show more ran: a refresh keeps its cursor
  let queued = false;
  const liveAc = new AbortController(); // every live GET

  const status = h("p", { class: "runs-status", role: "status", "data-testid": "runs-status" });
  const list = h("ul", { class: "runs-list", "data-testid": "runs-list" });
  const moreBtn = h("button", { type: "button", class: "runs-more", "data-testid": "runs-more", hidden: true, onClick: showMore }, "Show more");
  const moreErr = h("p", { class: "runs-muted", role: "status", "data-testid": "runs-more-error", hidden: true }, "Couldn't load more runs. Try again.");
  const pane = h("aside", { class: "runs-detail", "aria-label": "Run detail", "data-testid": "runs-detail", hidden: true });
  const root = h(
    "div",
    { class: "runs-app", "data-testid": "runs-app" },
    h("div", { class: "runs-main" }, h("h2", { class: "runs-title" }, "Runs"), status, list, moreBtn, moreErr),
    pane
  );
  contentEl.replaceChildren(root);

  function row(run) {
    return h(
      "li",
      null,
      h(
        "button",
        { type: "button", class: "runs-row", "data-testid": "runs-row", "data-id": run.id, onClick: () => open(run.id) },
        h("span", { class: "runs-row-name" }, roleName(run.role)),
        statusChip(run.status),
        h("span", { class: "runs-row-usd", "data-testid": "runs-usd" }, formatUsd(run.usd)),
        validTime(run.created_at) ? h("span", { class: "runs-row-time" }, timeNode(run.created_at, true)) : null
      )
    );
  }

  function paintList() {
    const focusId = contentEl.contains(document.activeElement) && document.activeElement.dataset ? document.activeElement.dataset.id : null;
    status.textContent =
      listState === "loading" ? "Loading runs…" : listState === "error" ? "Runs aren't available right now." : rows.length === 0 ? "No runs yet." : "";
    status.dataset.state = listState;
    list.replaceChildren(...rows.map(row));
    moreBtn.hidden = listState !== "ready" || next === "";
    moreBtn.disabled = more !== null;
    if (focusId) {
      const el = list.querySelector('[data-id="' + focusId + '"]');
      if (el) el.focus();
    }
  }

  function loadFirst() {
    const ac = (listAc = new AbortController());
    loadRunsPage("", undefined, ac.signal).then(
      (page) => {
        if (ac.signal.aborted) return;
        rows = page.rows;
        next = page.next;
        listState = "ready";
        paintList();
      },
      () => {
        if (ac.signal.aborted) return;
        listState = "error";
        paintList();
      }
    );
  }

  function showMore() {
    if (more || next === "") return;
    const ac = (more = new AbortController());
    loadRunsPage(next, undefined, ac.signal).then(
      (page) => {
        if (ac.signal.aborted) return;
        more = null;
        extended = true;
        moreErr.hidden = true;
        const seen = new Set(rows.map((r) => r.id));
        rows = rows.concat(page.rows.filter((r) => !seen.has(r.id)));
        next = page.next;
        paintList();
      },
      () => {
        if (ac.signal.aborted) return;
        more = null;
        moreErr.hidden = false;
        paintList();
      }
    );
    paintList();
  }

  function paintDetail() {
    if (!openId) {
      pane.hidden = true;
      pane.replaceChildren();
      return;
    }
    const back = h("button", { type: "button", class: "runs-back", "data-testid": "runs-back", onClick: close }, "← Back");
    let content;
    if (detail.status === "loading") content = h("p", { class: "runs-muted", role: "status" }, "Loading run…");
    else if (detail.status === "error") content = h("p", { class: "runs-muted", role: "status", "data-testid": "runs-detail-error" }, UNAVAILABLE);
    else {
      const run = detail.run;
      const ins = detail.insight;
      const insight = h(
        "div",
        { class: "runs-insight", "data-testid": "runs-insight" },
        ins === undefined
          ? h("p", { class: "runs-muted", role: "status" }, "Loading what this run did…")
          : ins === null
            ? h("p", { class: "runs-muted", role: "status", "data-testid": "runs-insight-error" }, INSIGHT_UNAVAILABLE)
            : renderInsight(ins, { openRun: open, ui: detail.ui })
      );
      content = [
        h(
          "div",
          { class: "runs-head", "data-testid": "runs-head" },
          h("h3", { class: "runs-head-name" }, ins ? titleOf(ins.run.role) : roleName(run.role)),
          statusChip(run.status),
          h("span", { class: "runs-head-usd", "data-testid": "runs-head-usd" }, formatUsd(run.usd))
        ),
        ins ? headMeta(ins) : null,
        ins ? headLinks(ins, { openPipeline: () => window.FULCWM && window.FULCWM.open("pipeline", { workItemId: ins.work_item.id }) }) : null,
        insight,
        foldBox(
          detail.ui,
          "runs-eventlog",
          "Event log",
          true,
          detail.events.length === 0 ? h("p", { class: "runs-muted", "data-testid": "runs-no-events" }, "No events yet.") : null,
          h("ol", { class: "runs-events", "data-testid": "runs-events" }, eventItems(detail.events)),
          detail.capped ? h("p", { class: "runs-muted", "data-testid": "runs-capped" }, CAPPED) : null
        ),
      ];
    }
    pane.replaceChildren(h("div", { class: "runs-detail-body" }, back, content));
    if (detail.status === "ready") guardToolName(pane);
    pane.hidden = false;
  }

  const stopStream = () => { if (stream) stream.close(); stream = null; };
  function repaintKeepFocus() {
    const a = document.activeElement;
    const had = pane.contains(a);
    const top = pane.scrollTop;
    // A focused fold header (Run facts, Event log ...) stays focused across the redraw; anything else falls back to Back.
    const fold = had && a.tagName === "SUMMARY" && a.parentElement ? a.parentElement.dataset.testid : "";
    paintDetail();
    pane.scrollTop = top;
    if (!had) return;
    const again = fold ? pane.querySelector('[data-testid="' + fold + '"] > summary') : null;
    (again || pane.querySelector(".runs-back")).focus({ preventScroll: true });
  }
  const refresh = coalesce(() =>
    loadRunsPage("", undefined, liveAc.signal).then((page) => {
      rows = mergeFirstPage(rows, page.rows);
      if (!extended) next = page.next;
      listState = "ready";
      paintList();
    }, () => {})
  );
  const unwatch = watchAccount({
    onStatus: (id) => loadRun(id, undefined, liveAc.signal).then((run) => {
      if (listState === "ready" && run && run.id === id) { rows = upsertRow(rows, run); paintList(); }
    }, () => {}),
    onRefresh: refresh,
  });
  function paintEvents() {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (!detail || detail.status !== "ready") return;
      const ol = pane.querySelector('[data-testid="runs-events"]');
      if (ol && detail.events.length > 1) ol.replaceChildren(...eventItems(detail.events));
      else repaintKeepFocus();
    });
  }
  // What the run did so far, re-read while it runs (at most every 5 s) and once more when it ends.
  function loadInsight(mine, id) {
    const ac = detailAc;
    loadRunInsight(id, undefined, ac.signal).then(
      (body) => {
        if (ac.signal.aborted || detail !== mine) return;
        const next = readInsight(body);
        if (next === null && mine.insight) return; // a bad reply never wipes what is shown
        mine.insight = next;
        repaintKeepFocus();
      },
      () => {
        if (ac.signal.aborted || detail !== mine || mine.insight) return;
        mine.insight = null;
        repaintKeepFocus();
      }
    );
  }
  function onLive(ev, mine) {
    if (detail !== mine || mine.events.length >= EVENT_CAP) return;
    mine.events.push(ev);
    if (mine.reinsight) mine.reinsight();
    paintEvents();
    if (!isTruncated(ev.payload)) return;
    loadRunEvent(openId, ev.seq, undefined, detailAc.signal).then((full) => {
      const i = full && detail === mine ? mine.events.findIndex((e) => e.seq === ev.seq) : -1;
      if (i >= 0) { mine.events[i] = full; paintEvents(); }
    }, () => {});
  }

  function open(id) {
    stopStream();
    if (detail && detail.reinsight) detail.reinsight.cancel();
    if (detailAc) detailAc.abort();
    openId = id;
    detail = { status: "loading" };
    paintDetail();
    pane.querySelector(".runs-back").focus();
    const ac = (detailAc = new AbortController());
    loadRunDetail(id, undefined, ac.signal).then(
      (d) => {
        if (ac.signal.aborted) return;
        const mine = (detail = { status: "ready", run: d.run, events: d.events.slice(0, EVENT_CAP), capped: d.capped, insight: undefined, ui: {} });
        mine.reinsight = coalesce(() => loadInsight(mine, id), 5000);
        mine.reinsight();
        paintDetail();
        pane.querySelector(".runs-back").focus();
        if (isLiveStatus(d.run.status) && !d.capped) {
          const lastSeq = mine.events.reduce((m, e) => (e && e.seq > m ? e.seq : m), 0);
          stream = openRunStream(id, {
            lastSeq,
            onEvent: (ev) => onLive(ev, mine),
            onEnd: (st) => { stream = null; if (detail === mine && st) { mine.run = { ...mine.run, status: st }; repaintKeepFocus(); loadInsight(mine, id); } },
          });
        }
      },
      () => {
        if (ac.signal.aborted) return;
        detail = { status: "error" };
        paintDetail();
        pane.querySelector(".runs-back").focus();
      }
    );
  }

  function close() {
    const id = openId;
    stopStream();
    if (detail && detail.reinsight) detail.reinsight.cancel();
    if (detailAc) detailAc.abort();
    detailAc = null;
    openId = detail = null;
    paintDetail();
    const el = id && list.querySelector('[data-id="' + id + '"]');
    if (el) el.focus();
  }

  paintList();
  loadFirst();

  return {
    destroy() {
      stopStream();
      unwatch();
      refresh.cancel();
      liveAc.abort();
      if (listAc) listAc.abort();
      if (more) more.abort();
      if (detailAc) detailAc.abort();
      contentEl.replaceChildren();
    },
  };
}

FULC.register({
  id: "runs",
  title: "Runs",
  icon: "▶",
  defaultSize: { w: 980, h: 600 },
  onOpen({ contentEl }) {
    teardown();
    current = mountApp(contentEl);
  },
  onClose() {
    teardown();
  },
});
