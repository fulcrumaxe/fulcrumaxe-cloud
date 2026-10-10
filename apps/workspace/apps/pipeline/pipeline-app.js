// D#37 WS-F1a: the Pipeline app. A board of the account's work items, one column
// per stage, kept current by the shell's live client. There is no drag and no
// control that moves a work item between stages by drag. The only controls are Cancel and
// Retry on a run (pipeline-actions.js, WS-F1c), the approve button for an internal item
// (pipeline-actions.js, D#483 P1) and, for a stuck item, the buttons the server lists:
// Build again, Back to discussion, Treat as a feature and Close (D#483). Text only, built with h().
//
// Registration goes through the FULC global (see the Developer app's header
// comment: an ES import of the SDK would blow the boot request budget).
import { h, timeNode } from "../_lib/dom.js";
import { on, onRefresh } from "../../core/cloud-live.js";
import {
  COLUMNS,
  REVIEWER_LABELS,
  STAGE_LABELS,
  createBoard,
  groupByColumn,
  isUuid,
  loadTimeline,
  itemHeading,
  kindLabel,
  verdictFor,
} from "./pipeline-storage.js";
import { createOperatorPanel, createRunsPanel } from "./pipeline-actions.js";
import { api } from "../_lib/api.js";
import { createInsightPanel } from "./pipeline-insight.js";
import { approveView, canApprove, createApprove } from "./pipeline-actions.js";

const FULC = window.FULC;
if (!FULC || typeof FULC.register !== "function") {
  throw new Error("Pipeline app: the FULC SDK global is missing");
}

let current = null;

function teardown() {
  if (current) {
    current.destroy();
    current = null;
  }
}

function mountApp(contentEl, launchArg) {
  let boardNote = ""; // a sentence for the status line that the board's own state does not give (the work item asked for is not there)
  let openId = null; // the card whose detail is showing
  let openItem = null; // its last known data, kept if a re-load leaves it out
  let history = null; // { status: "loading" | "ready" | "error", data }
  let historyAc = null;
  let runs = null; // the open detail's Runs panel (pipeline-actions.js)
  let activity = null; // the open item's last activity read: the action buttons are drawn from its `actions`
  // What the pipeline is doing for the open item (pipeline-insight.js). Every answer also feeds the action buttons.
  const insight = createInsightPanel({
    call: api,
    onData: (data, id) => {
      if (id === openId) {
        activity = data;
        syncOperator();
      }
    },
  });
  // Build again, Back to discussion, Treat as a feature and Close (pipeline-actions.js). Which ones show comes from the server.
  const operator = createOperatorPanel({
    call: api,
    onDone: (id, action) => {
      // Close ends the work: there is nothing left to watch in the detail, so once the board has the card in its new column
      // the detail closes (as Back does) and the card is shown there, briefly highlighted. The other actions start a run the
      // person follows in the detail, so they stay open.
      if (action === "close" && id === openId) {
        Promise.resolve(board.applyItem(id)).then(() => {
          if (openId !== id) return;
          close();
          showMoved(id);
        });
        return;
      }
      board.applyItem(id);
      if (id === openId) insight.refresh();
    },
  });

  const approver = createApprove({ onChange: () => paintDetail() }); // "Approve and start" for the open card
  const board = createBoard({ onChange: () => keepScroll(paint) });
  const status = h("p", { class: "pl-status", role: "status", "data-testid": "pl-status" });
  const columns = h("div", { class: "pl-columns", "data-testid": "pl-columns" });
  const detail = h("aside", { class: "pl-detail", "aria-label": "Work item detail", "data-testid": "pl-detail", hidden: true });
  const root = h(
    "div",
    { class: "pl-app", "data-testid": "pl-app" },
    h("div", { class: "pl-board" }, h("h2", { class: "pl-title" }, "Pipeline"), status, columns),
    detail
  );
  contentEl.replaceChildren(root);

  // A redraw replaces the children of the board and the detail, which shortens them for a moment and makes the browser
  // clamp their scroll back toward the top. The board re-reads itself on a timer (the fallback for a missed live event),
  // so a person reading further down must not be moved: the two scrolled boxes are saved and put back after the redraw.
  const scrolled = [root.firstChild, detail];
  function keepScroll(fn) {
    const saved = scrolled.map((n) => [n, n.scrollTop, n.scrollLeft]);
    fn();
    for (const [n, top, left] of saved) {
      if (n.scrollTop !== top) n.scrollTop = top;
      if (n.scrollLeft !== left) n.scrollLeft = left;
    }
  }

  function card(item, repos) {
    const { repo, number, title, kind } = itemHeading(item, repos);
    const verdict = verdictFor(item.stage);
    return h(
      "li",
      null,
      h(
        "button",
        { type: "button", class: "pl-card", "data-testid": "pl-card", "data-id": item.id, onClick: () => open(item) },
        h("span", { class: "pl-card-head", "data-testid": "pl-card-head" }, repo ? [h("bdi", null, repo), number ? " " : null] : null, number),
        // The title is a GitHub issue's: untrusted text, set as text by h() and nothing else.
        h("span", { class: "pl-card-title", "data-testid": "pl-card-title" }, h("bdi", null, title)),
        h(
          "span",
          { class: "pl-card-meta" },
          h("span", { class: "pl-tag pl-kind", "data-testid": "pl-kind" }, kind),
          item.provenance === "external" ? h("span", { class: "pl-tag" }, "External") : null,
          item.stage === "merged" || item.stage === "closed_unmerged" || item.stage === "closed"
            ? h("span", { class: "pl-tag pl-tag-done" }, STAGE_LABELS[item.stage])
            : null
        ),
        verdict ? h("span", { class: "pl-verdict", "data-testid": "pl-verdict" }, verdict) : null,
        runs && runs.itemId === item.id && runs.label() ? h("span", { class: "pl-verdict", "data-testid": "pl-pending" }, runs.label()) : null
      )
    );
  }

  function paint() {
    const st = board.getState();
    const focusId = contentEl.contains(document.activeElement) && document.activeElement.dataset ? document.activeElement.dataset.id : null;
    status.textContent =
      st.status === "loading" ? "Loading work items…"
      : st.status === "error" ? "Work items aren't available right now."
      : st.items.size === 0 ? "No work items yet."
      : boardNote;
    status.dataset.state = st.status;
    const groups = groupByColumn(st.items.values());
    columns.replaceChildren(
      ...(st.status === "error" ? [] : COLUMNS.map((col) =>
        h(
          "section",
          { class: "pl-col", "data-testid": "pl-col-" + col.id, "aria-labelledby": "pl-h-" + col.id },
          h("h3", { class: "pl-col-head", id: "pl-h-" + col.id }, col.label, " ", h("span", { class: "pl-count", "data-testid": "pl-count" }, String(groups[col.id].length))),
          h("ul", { class: "pl-list" }, groups[col.id].map((item) => card(item, st.repos)))
        )
      ))
    );
    if (focusId) {
      const el = columns.querySelector('[data-id="' + focusId + '"]');
      if (el) el.focus();
    }
    // An open detail stays open; it is redrawn only when its item changed.
    if (openId) {
      const fresh = st.items.get(openId);
      if (fresh && (fresh.updated_at !== openItem.updated_at || fresh.stage !== openItem.stage)) {
        const moved = fresh.stage !== openItem.stage;
        openItem = fresh;
        keepScroll(paintDetail);
        // The buttons follow the stage: read what may be done now rather than wait for the timer.
        if (moved) insight.refresh();
      }
    }
    settle();
  }

  // The detail scrolls inside its window. On a phone the window can be taller than what is actually visible (the
  // browser's own bars, the on-screen keyboard), so its bottom would sit off screen and the last rows could not be
  // reached. Cap its height to the visible part of the screen below its own top edge.
  function fitDetail() {
    if (detail.hidden) return;
    const vv = window.visualViewport;
    const visible = Math.min(window.innerHeight || Infinity, vv && vv.height ? vv.height : Infinity);
    const room = Number.isFinite(visible) ? Math.floor(visible - detail.getBoundingClientRect().top) : 0;
    detail.style.maxHeight = room >= 160 ? room + "px" : "";
  }
  const onViewportChange = () => fitDetail();
  window.addEventListener("resize", onViewportChange);
  if (window.visualViewport) window.visualViewport.addEventListener("resize", onViewportChange);

  // The approve button lives in a slot of its own, so a change of "a run is live" redraws it WITHOUT rebuilding the Runs
  // section beside it (a rebuild there would lose the keyboard focus a person holds on a run's control).
  const approveSlot = h("div", { "data-testid": "pl-approve-slot" });
  function syncApprove() {
    const live = !!runs && runs.hasLive();
    // dom-insert-ok: approveView always returns an element
    approveSlot.replaceChildren(...(openItem && canApprove(openItem, live) ? [approveView(openItem, approver, live)] : []));
  }

  // The action buttons live in a slot of their own, like the approve button, so a redraw of the Runs section beside it
  // does not rebuild them (and a held focus stays).
  function syncOperator() {
    operator.show(openItem, openItem && activity);
  }

  function paintDetail() {
    if (!openItem) {
      detail.hidden = true;
      detail.replaceChildren();
      return;
    }
    const { repo, number, title } = itemHeading(openItem, board.getState().repos);
    const hadFocus = detail.contains(document.activeElement) && document.activeElement.dataset.testid === "pl-back";
    let body;
    if (!history || history.status === "loading") body = h("p", { class: "pl-muted" }, "Loading history…");
    else if (history.status === "error") body = h("p", { class: "pl-muted", role: "status", "data-testid": "pl-history-error" }, "History isn't available right now.");
    else {
      const rows = Array.isArray(history.data.transitions) ? history.data.transitions : [];
      body = h(
        "ol",
        { class: "pl-history", "data-testid": "pl-history" },
        rows.map((t) =>
          h(
            "li",
            { "data-testid": "pl-history-row" },
            h("span", { class: "pl-history-stage" }, STAGE_LABELS[t.to_stage] || "Another stage"),
            " ",
            timeNode(t.at, true),
            REVIEWER_LABELS[t.reviewer] ? h("span", { class: "pl-reviewer" }, REVIEWER_LABELS[t.reviewer]) : null
          )
        ),
        history.data.truncated ? h("li", { class: "pl-muted" }, "Older history isn't shown.") : null
      );
    }
    syncApprove();
    detail.replaceChildren(
      h("button", { type: "button", class: "pl-back", "data-testid": "pl-back", onClick: close }, "← Back"),
      h("h2", { class: "pl-detail-title", "data-testid": "pl-detail-title" }, repo ? [h("bdi", null, repo), number ? " " : null] : null, number),
      h("p", { class: "pl-detail-name", "data-testid": "pl-detail-name" }, h("bdi", null, title)),
      h(
        "p",
        { class: "pl-detail-meta" },
        STAGE_LABELS[openItem.stage] || "Another stage",
        " · ",
        kindLabel(openItem.kind),
        openItem.provenance === "external" ? " · External" : ""
      ),
      ...(verdictFor(openItem.stage) ? [h("p", { class: "pl-verdict" }, verdictFor(openItem.stage))] : []),
      // dom-insert-ok: createInsightPanel (pipeline-insight.js) always returns a panel with its el set
      insight.el,
      approveSlot,
      // dom-insert-ok: createOperatorPanel (pipeline-actions.js) always returns a panel with its el set
      operator.el,
      // dom-insert-ok: createRunsPanel (pipeline-actions.js) always returns a panel with its el set
      ...(runs ? [runs.el] : []),
      h("h3", { class: "pl-detail-sub" }, "History"),
      body
    );
    detail.hidden = false;
    fitDetail();
    if (hadFocus) detail.querySelector(".pl-back").focus();
  }

  function open(item) {
    if (historyAc) historyAc.abort();
    openId = item.id;
    openItem = item;
    history = { status: "loading" };
    approver.reset(item.id);
    operator.reset(item.id);
    activity = null;
    syncOperator(); // no buttons from the previous card while this one's activity is being read
    if (runs) runs.destroy();
    // The board repaints on a label change; the detail (the approve button hides while a run is live) on a change of that too.
    // The action buttons come from the activity read, and the server offers them only while no run is live: when a run starts
    // or ends (a cancel, a finish), the activity is read again at once so the buttons follow without reopening the card.
    let wasLive = null;
    let panel = null;
    panel = runs = createRunsPanel({
      itemId: item.id,
      repoId: item.repo_id,
      ownPlanUsd: () => (openItem && openItem.id === item.id ? openItem.own_plan_api_equivalent_usd : null),
      onChange: () => {
        paint();
        syncApprove();
        if (!panel) return;
        const live = panel.hasLive();
        if (wasLive !== null && live !== wasLive && openId === item.id) insight.refresh();
        wasLive = live;
      },
    });
    insight.start(item.id);
    paintDetail();
    detail.querySelector(".pl-back").focus();
    const ac = (historyAc = new AbortController());
    loadTimeline(item.id, undefined, ac.signal).then(
      (data) => {
        if (ac.signal.aborted) return;
        history = data && typeof data === "object" ? { status: "ready", data } : { status: "error" };
        paintDetail();
      },
      () => {
        if (ac.signal.aborted) return;
        history = { status: "error" };
        paintDetail();
      }
    );
  }

  // The card that just moved is scrolled into view and highlighted for a moment. Done after the current redraw, as reveal() is.
  function showMoved(id) {
    queueMicrotask(() => {
      const card = columns.querySelector('[data-id="' + id + '"]');
      if (!card) return;
      if (typeof card.scrollIntoView === "function") card.scrollIntoView({ block: "center", inline: "nearest" });
      card.classList.add("pl-card-moved");
      setTimeout(() => card.classList.remove("pl-card-moved"), 2500);
    });
  }

  function close() {
    const id = openId;
    if (historyAc) historyAc.abort();
    historyAc = null;
    approver.reset();
    operator.reset();
    activity = null;
    if (runs) runs.destroy();
    insight.stop();
    openId = openItem = history = runs = null;
    syncOperator();
    paintDetail();
    const el = id && columns.querySelector('[data-id="' + id + '"]');
    if (el) el.focus();
  }

  // Another app (the Runs app's "Open the work item in Pipeline") asks for one work item by id: its card is scrolled into
  // view and its detail opened. It works when this app has just been opened (the id arrives as the launch argument) and when
  // it is already open (the shell hands it to onLaunch). The board may not have loaded yet, so the wish is kept and settled
  // as soon as the item is on the board; an item the list does not hold is read once by id, and if it is not there either
  // the status line says so. The argument is untrusted: only a UUID is used.
  let wanted = null;
  // Done after the current redraw: keepScroll() puts the scroll back to where it was when a redraw ends, which would undo it.
  function reveal(id) {
    queueMicrotask(() => {
      const card = columns.querySelector('[data-id="' + id + '"]');
      if (card && typeof card.scrollIntoView === "function") card.scrollIntoView({ block: "center", inline: "nearest" });
    });
  }
  function settle() {
    if (wanted === null) return;
    const id = wanted;
    const st = board.getState();
    const item = st.items.get(id);
    if (item) {
      wanted = null;
      if (openId !== id) open(item);
      reveal(id);
      return;
    }
    if (st.status === "error") wanted = null;
    if (st.status !== "ready" || asked.has(id)) return;
    asked.add(id);
    // Not in the list: read it once by id. Its arrival repaints the board, which settles again.
    Promise.resolve(board.applyItem(id)).then(() => {
      if (wanted === id && !board.getState().items.has(id)) {
        wanted = null;
        boardNote = "That work item isn't on the board.";
        paint();
      }
    });
  }
  const asked = new Set();
  function select(id) {
    if (!isUuid(id)) return;
    wanted = id;
    boardNote = "";
    asked.delete(id);
    settle();
  }

  paint();
  const tap = (type, dto) => runs && runs.live(type, dto);
  board.connectLive({ on: (t, f) => on(t, (d) => (tap(t, d), f(d))), onRefresh: (f) => onRefresh((...a) => (tap("refresh"), f(...a))) });
  board.load();
  if (launchArg && typeof launchArg === "object") select(launchArg.workItemId);

  return {
    select,
    destroy() {
      window.removeEventListener("resize", onViewportChange);
      if (window.visualViewport) window.visualViewport.removeEventListener("resize", onViewportChange);
      insight.stop();
      operator.destroy();
      if (historyAc) historyAc.abort();
      if (runs) runs.destroy();
      board.destroy();
      contentEl.replaceChildren();
    },
  };
}

FULC.register({
  id: "pipeline",
  title: "Pipeline",
  icon: "▤",
  defaultSize: { w: 980, h: 600 },
  onOpen({ contentEl, launchArg }) {
    teardown();
    current = mountApp(contentEl, launchArg);
  },
  // Opened again from another app while it is already open: go to that work item.
  onLaunch({ launchArg }) {
    if (current && launchArg && typeof launchArg === "object") current.select(launchArg.workItemId);
  },
  onClose() {
    teardown();
  },
});
