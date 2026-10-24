// D#601 MEM-4a3: the Memory app. A review queue of proposals (approve, edit then approve, reject, batch inside one source), and below it all
// memory grouped by scope: a repo as owner/name, an item as its number and title, the account, a role. Each repo and item header carries the number
// of proposals waiting, read from the pending-counts route (the queue's own count), and each row says how many runs used the entry and links to them.
//
// Registration goes through the FULC global (see the Runs app's header comment: an ES import of the SDK would blow the boot request budget).
import { h, timeNode } from "../_lib/dom.js";
import { mountQueue, mountToasts } from "./memory-queue.js";
import { api } from "../_lib/api.js";
import {
  COPY, KINDS, STATUSES, DELETE_KEEP_DAYS, buildExport, omittedWords, decidedWords, deleteEntry, failureWords, loadCounts, loadHistory, loadList, loadQueue, loadRepos, loadRuns, restoreEntry,
  restorePrevious, revertEntries, rowActions, runName, runsWords, statusView, text, waitingWords,
} from "./memory-storage.js";

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/;
const validTime = (iso) => typeof iso === "string" && ISO.test(iso) && !Number.isNaN(Date.parse(iso));

// ── the Undo toasts, the history of one entry and the export (in this file: each app file costs a boot request, and the whole boot is at its budget) ──
/** p: { phase: loading | ready | error, events, versions }. What happened, oldest first, then the texts still stored. */
function historyNode(p) {
  if (p.phase === "loading") return h("p", { class: "mem-muted", role: "status" }, "Loading history…");
  if (p.phase === "error") return h("p", { class: "mem-error", role: "alert" }, "The history isn't available right now.");
  return h(
    "div",
    { class: "mem-history", "data-testid": "mem-history" },
    p.events.length === 0
      ? h("p", { class: "mem-muted" }, "Nothing has happened to this entry yet.")
      : h("ol", { class: "mem-events" }, p.events.map((e) => h("li", { "data-testid": "mem-event" }, e.label, e.version === null ? "" : " (version " + e.version + ")", " · ", e.actor, validTime(e.at) ? [" · ", timeNode(e.at, true)] : null))),
    p.versions.length === 0
      ? h("p", { class: "mem-muted", "data-testid": "mem-no-versions" }, "The text of this entry is no longer stored (it is removed 30 days after a delete). What happened to it stays here.")
      : h("ul", { class: "mem-versions" }, p.versions.map((v) => h("li", { "data-testid": "mem-version" }, h("strong", null, "Version " + text(v.version) + (v.status === "superseded" ? " (replaced)" : "") + ": "), text(v.body, COPY.unknownSource))))
  );
}

const FORMATS = [["agents", "AGENTS.md"], ["claude", "CLAUDE.md"]];

/** The Export section: pick a repo and a file style, make the text, download or copy it. Nothing is written into a repo or a workspace. */
function mountExport({ host, signal }) {
  let repos = [];
  let state = { phase: "idle" }; // idle | loading | ready | error
  let note = "";
  const repoSel = h("select", { id: "mem-x-repo", class: "mem-input", "data-testid": "mem-export-repo", onChange: () => ((state = { phase: "idle" }), (note = ""), paint()) });
  const fmtSel = h("select", { id: "mem-x-format", class: "mem-input", "data-testid": "mem-export-format", onChange: () => ((state = { phase: "idle" }), (note = ""), paint()) }, FORMATS.map(([v, l]) => h("option", { value: v }, l)));
  const out = h("div", { "data-testid": "mem-export-result" });
  const go = h("button", { type: "button", class: "mem-btn", "data-testid": "mem-export-go", onClick: make }, "Make the file");
  const reason = h("p", { class: "mem-muted", "data-testid": "mem-export-reason" });
  host.replaceChildren(
    h("h2", { class: "mem-h" }, "Export"),
    h("p", { class: "mem-muted" }, "The approved memory of one repo as a file you can add to the repo yourself. Nothing is written to your repo."),
    h("div", { class: "mem-filters" }, h("label", { for: "mem-x-repo" }, "Repo"), repoSel, h("label", { for: "mem-x-format" }, "File"), fmtSel, go),
    reason,
    out
  );

  async function make() {
    if (go.getAttribute("aria-disabled") === "true" || !repoSel.value) return;
    state = { phase: "loading" };
    note = "";
    paint();
    try {
      state = { phase: "ready", data: await buildExport(repoSel.value, fmtSel.value, undefined, signal) };
    } catch (e) {
      if (e && e.name === "AbortError") return;
      state = { phase: "error", words: e && e.status === 404 ? "That repo isn't available any more." : failureWords(e) };
    }
    paint();
  }

  function download(d) {
    const url = URL.createObjectURL(new Blob([d.content], { type: "text/markdown;charset=utf-8" }));
    const a = h("a", { href: url, download: d.filename });
    host.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    note = "Downloaded " + d.filename + ".";
    paint();
  }

  async function copy(d) {
    try {
      await navigator.clipboard.writeText(d.content);
      note = "Copied.";
    } catch {
      note = "Copying isn't allowed here. Select the text above and copy it yourself.";
    }
    paint();
  }

  function paint() {
    const none = repos.length === 0;
    const busy = state.phase === "loading";
    go.setAttribute("aria-disabled", none || busy ? "true" : "false");
    reason.textContent = none ? "Connect a repo first; there is nothing to export yet." : "";
    if (state.phase === "idle") out.replaceChildren();
    else if (busy) out.replaceChildren(h("p", { class: "mem-muted", role: "status" }, "Making the file…"));
    else if (state.phase === "error") out.replaceChildren(h("p", { class: "mem-error", role: "alert", "data-testid": "mem-export-error" }, state.words));
    else {
      const d = state.data;
      out.replaceChildren(
        h("p", { "data-testid": "mem-export-count" }, d.entries === 1 ? "1 approved entry in " + d.filename + "." : d.entries + " approved entries in " + d.filename + "."),
        ...(d.omitted > 0 ? [h("p", { class: "mem-error", role: "status", "data-testid": "mem-export-omitted" }, omittedWords(d.omitted))] : []),
        h("label", { for: "mem-x-text" }, "File text"),
        h("textarea", { id: "mem-x-text", class: "mem-input", rows: 8, readOnly: true, "data-testid": "mem-export-text" }, d.content),
        h("div", { class: "mem-actions" }, h("button", { type: "button", class: "mem-btn", "data-testid": "mem-export-download", onClick: () => download(d) }, "Download " + d.filename), h("button", { type: "button", class: "mem-btn", "data-testid": "mem-export-copy", onClick: () => copy(d) }, "Copy text")),
        ...(note ? [h("p", { class: "mem-muted", role: "status", "data-testid": "mem-export-note" }, note)] : [])
      );
    }
  }

  return {
    set(list) {
      repos = list;
      const keep = repoSel.value;
      repoSel.replaceChildren(...repos.map((r) => h("option", { value: r.id, selected: r.id === keep }, r.name)));
      paint();
    },
  };
}

const FULC = window.FULC;
if (!FULC || typeof FULC.register !== "function") {
  throw new Error("Memory app: the FULC SDK global is missing");
}

let current = null;

function teardown() {
  if (current) {
    current.destroy();
    current = null;
  }
}

function mountApp(contentEl) {
  const ac = new AbortController();
  let phase = "loading"; // loading | ready | error
  let list = { groups: [], truncated: false };
  let queue = { cards: [], truncated: false };
  let repos = [];
  let counts = null; // { repos, items } or null when the route failed
  let places = new Map(); // "scope|label" -> { kind, id }
  const filters = { kinds: [], statuses: [] };
  const runPanels = new Map(); // entry id -> { phase: loading | ready | error, runs, total, truncated }
  const histPanels = new Map(); // entry id -> { phase, events, versions }
  const rowBusy = new Set();
  const rowErr = new Map();
  let isAdmin = false;
  let access = "checking"; // checking | ok | failed: what /auth/me has said so far
  let seq = 0;

  const status = h("p", { class: "mem-status", role: "status", "aria-live": "polite", "data-testid": "mem-status" });
  const queueHost = h("section", { class: "mem-section", "aria-label": COPY.queueTitle });
  const listBody = h("div", { "data-testid": "mem-list" });
  const kindSel = h("select", { id: "mem-f-kind", class: "mem-input", "data-testid": "mem-filter-kind", onChange: () => (filters.kinds = kindSel.value ? [kindSel.value] : [], load(false)) }, h("option", { value: "" }, "All kinds"), KINDS.map(([v, l]) => h("option", { value: v }, l)));
  const statusSel = h("select", { id: "mem-f-status", class: "mem-input", "data-testid": "mem-filter-status", onChange: () => (filters.statuses = statusSel.value ? [statusSel.value] : [], load(false)) }, h("option", { value: "" }, "Any status"), STATUSES.map(([v, l]) => h("option", { value: v }, l)));
  const toastHost = h("div", { class: "mem-toasts", "aria-live": "polite", "data-testid": "mem-toasts" });
  const exportHost = h("section", { class: "mem-section", "aria-label": "Export" });
  const toasts = mountToasts(toastHost);
  const root = h(
    "div",
    { class: "mem-app", "data-testid": "mem-app" },
    toastHost,
    h("div", { class: "mem-main" },
      h("h1", { class: "mem-title-h" }, COPY.title),
      status,
      queueHost,
      h("section", { class: "mem-section", "aria-label": COPY.listTitle },
        h("h2", { class: "mem-h" }, COPY.listTitle),
        h("div", { class: "mem-filters" }, h("label", { for: "mem-f-kind" }, "Kind"), kindSel, h("label", { for: "mem-f-status" }, "Status"), statusSel),
        h("p", { class: "mem-muted", "data-testid": "mem-deleted-note", hidden: true }, "Deleted entries are kept " + DELETE_KEEP_DAYS + " days, then removed for good."),
        listBody),
      exportHost)
  );
  contentEl.replaceChildren(root);

  const q = mountQueue({
    host: queueHost,
    countFor: (place, cards) => {
      if (!place) return cards.length;
      if (counts === null) return null;
      const n = (place.kind === "repo" ? counts.repos : counts.items)[place.id];
      return Number.isInteger(n) ? n : null;
    },
    reload: (focusId, quiet) => load(true, focusId, quiet),
    onDecided: ({ ids, to }) => {
      const back = to === "approved" ? "undo_approve" : "reconsider";
      toasts.show({ message: decidedWords(to, ids.length), onUndo: () => undo(() => revertEntries(ids, back), "Put back in the review queue.", ids[0]) });
    },
  });
  const exp = mountExport({ host: exportHost, signal: ac.signal });

  /** Run an Undo: the words to show either way, then re-read the lists so the screen matches the server. */
  async function undo(fn, done, focusId) {
    let r;
    try {
      await fn();
      r = { ok: true, message: done };
    } catch (e) {
      r = { ok: false, message: e && e.code === "conflict" ? COPY.changedSince : failureWords(e) };
    }
    await load(true, r.ok ? focusId : undefined, true);
    return r;
  }

  function indexPlaces() {
    places = new Map();
    for (const r of repos) places.set("repo|" + r.name, { kind: "repo", id: r.id });
    for (const g of list.groups) if (g.targetId && (g.scope === "repo" || g.scope === "item")) places.set(g.scope + "|" + g.label, { kind: g.scope, id: g.targetId });
  }

  async function load(silent, focusId, quietQueue) {
    const my = ++seq;
    if (!silent && phase !== "ready") {
      phase = "loading";
      paint();
    }
    try {
      const [l, qu, rp] = await Promise.all([loadList(filters, undefined, ac.signal), loadQueue(undefined, ac.signal), loadRepos(undefined, ac.signal)]);
      if (my !== seq) return;
      list = l;
      queue = qu;
      repos = rp;
      exp.set(repos);
      indexPlaces();
      const repoIds = [...new Set([...repos.map((r) => r.id), ...[...places.values()].filter((p) => p.kind === "repo").map((p) => p.id)])];
      const itemIds = [...places.values()].filter((p) => p.kind === "item").map((p) => p.id);
      counts = await loadCounts(repoIds, itemIds, undefined, ac.signal);
      if (my !== seq) return;
      phase = "ready";
    } catch (e) {
      if (e && e.name === "AbortError") return;
      if (my !== seq) return;
      if (phase !== "ready") phase = "error";
      else if (!quietQueue) status.textContent = COPY.unavailable;
    }
    paint();
    if (focusId !== undefined) q.focus(focusId);
  }

  async function whoAmI() {
    try {
      const me = await api("GET", "/api/cloud/auth/me", undefined, ac.signal);
      isAdmin = !!(me && me.is_admin === true);
      access = "ok";
    } catch (e) {
      if (e && e.name === "AbortError") return;
      isAdmin = false;
      access = "failed";
    }
    paint();
  }

  // ── what a row can do ──
  async function runAction(row, key) {
    if (rowBusy.has(row.id)) return;
    rowBusy.add(row.id);
    rowErr.delete(row.id);
    paint();
    const id = row.id;
    const note = (message, onUndo) => toasts.show({ message, onUndo });
    try {
      if (key === "retire") {
        await revertEntries([id], "retire");
        note("Retired. It is no longer used in runs.", () => undo(() => revertEntries([id], "restore_retired"), "Restored.", id));
      } else if (key === "delete") {
        await deleteEntry(id);
        note("Deleted. You can restore it for " + DELETE_KEEP_DAYS + " days.", () => undo(() => restoreEntry(id), "Restored.", id));
      } else if (key === "restore") {
        await restoreEntry(id);
        note("Restored.");
      } else if (key === "restore_previous") {
        await restorePrevious(id);
        note("The earlier version is the current one again.");
      } else {
        const done = { reconsider: "Back in the review queue.", renew: "Renewed. It is waiting for review again for 14 days.", restore_retired: "Restored." };
        await revertEntries([id], key);
        note(done[key]);
      }
    } catch (e) {
      rowErr.set(id, e && e.code === "conflict" ? COPY.changedSince : failureWords(e));
    }
    rowBusy.delete(id);
    histPanels.delete(id);
    await load(true, undefined, true);
  }

  async function toggleHistory(row) {
    if (histPanels.has(row.id)) {
      histPanels.delete(row.id);
      return paint();
    }
    histPanels.set(row.id, { phase: "loading", events: [], versions: [] });
    paint();
    try {
      histPanels.set(row.id, { phase: "ready", ...(await loadHistory(row.id, undefined, ac.signal)) });
    } catch (e) {
      if (e && e.name === "AbortError") return;
      histPanels.set(row.id, { phase: "error", events: [], versions: [] });
    }
    paint();
  }

  function actionBar(row) {
    const acts = rowActions(row, { isAdmin, access });
    const busy = rowBusy.has(row.id);
    const reasons = [...new Set(acts.filter((a) => !a.enabled).map((a) => a.reason))];
    const open = histPanels.has(row.id);
    return h(
      "div",
      { class: "mem-row-actions" },
      h("div", { class: "mem-actions" },
        acts.map((a) => h("button", { type: "button", class: "mem-btn", "data-testid": "mem-act-" + a.key, "aria-disabled": a.enabled && !busy ? "false" : "true", "aria-describedby": a.enabled ? null : "mem-why-" + row.id, onClick: () => a.enabled && !busy && runAction(row, a.key) }, a.label)),
        h("button", { type: "button", class: "mem-btn mem-btn-quiet", "data-testid": "mem-history-toggle", "aria-expanded": open ? "true" : "false", onClick: () => toggleHistory(row) }, "History")),
      reasons.length ? h("p", { class: "mem-muted", id: "mem-why-" + row.id, "data-testid": "mem-reason" }, reasons.join(" ")) : null,
      busy ? h("p", { class: "mem-muted", role: "status" }, "Working…") : null,
      rowErr.has(row.id) ? h("p", { class: "mem-error", role: "alert", "data-testid": "mem-row-error" }, rowErr.get(row.id)) : null,
      open ? historyNode(histPanels.get(row.id)) : null
    );
  }

  // ── all memory, grouped by scope ──
  function badgeFor(place) {
    if (!place) return null;
    const n = counts === null ? null : (place.kind === "repo" ? counts.repos : counts.items)[place.id];
    return h("span", { class: "mem-badge", "data-testid": "mem-badge", "data-count": Number.isInteger(n) ? String(n) : "" }, waitingWords(n));
  }

  function runsControl(row) {
    const { n, label } = runsWords(row);
    if (n === 0) return h("span", { class: "mem-muted", "data-testid": "mem-runs", "data-runs": "0" }, label);
    const panel = runPanels.get(row.id);
    return h(
      "span",
      { class: "mem-runs" },
      h("button", { type: "button", class: "mem-link", "data-testid": "mem-runs", "data-runs": String(n), "aria-expanded": panel ? "true" : "false", onClick: () => toggleRuns(row) }, label),
      panel ? runPanel(panel) : null
    );
  }

  function openRun(id) {
    if (window.FULCWM && typeof window.FULCWM.open === "function") window.FULCWM.open("runs", { runId: id });
  }

  function runPanel(p) {
    if (p.phase === "loading") return h("p", { class: "mem-muted", role: "status" }, "Loading runs…");
    if (p.phase === "error") return h("p", { class: "mem-error", role: "alert" }, "The runs aren't available right now.");
    return h(
      "ul",
      { class: "mem-run-list", "data-testid": "mem-run-list" },
      p.runs.map((r) => h("li", null, h("button", { type: "button", class: "mem-link", "data-testid": "mem-run-link", "data-run-id": r.id, onClick: () => openRun(r.id) }, runName(r.id), validTime(r.recorded_at) ? [" · ", timeNode(r.recorded_at, true)] : null))),
      p.truncated ? h("li", { class: "mem-muted" }, "Showing the newest " + p.runs.length + " of " + p.total + ".") : null
    );
  }

  async function toggleRuns(row) {
    if (runPanels.has(row.id)) {
      runPanels.delete(row.id);
      return paint();
    }
    runPanels.set(row.id, { phase: "loading", runs: [], total: 0, truncated: false });
    paint();
    try {
      const r = await loadRuns(row.id, undefined, ac.signal);
      // One run: go straight to its page. Several: the short list.
      if (r.runs.length === 1 && r.total === 1) {
        runPanels.delete(row.id);
        paint();
        return openRun(r.runs[0].id);
      }
      runPanels.set(row.id, { phase: "ready", runs: r.runs, total: r.total, truncated: r.truncated });
    } catch (e) {
      if (e && e.name === "AbortError") return;
      runPanels.set(row.id, { phase: "error", runs: [], total: 0, truncated: false });
    }
    paint();
  }

  function entryRow(row) {
    const sv = statusView(row.status, row.status_label, row.status_icon);
    return h(
      "li",
      { class: "mem-row", "data-testid": "mem-row", "data-id": row.id, "data-status": sv.status },
      h("span", { class: "mem-status-chip", "data-testid": "mem-row-status" }, h("span", { "aria-hidden": "true" }, sv.glyph + " "), sv.label),
      h("span", { class: "mem-chip" }, text(row.kind_label, "Memory")),
      h("span", { class: "mem-row-title" }, text(row.title, COPY.unknownSource)),
      h("span", { class: "mem-muted" }, text(row.source, COPY.unknownSource) + " · " + text(row.age)),
      runsControl(row),
      actionBar(row)
    );
  }

  function group(g, extraPlace) {
    const place = extraPlace || (g.targetId && (g.scope === "repo" || g.scope === "item") ? { kind: g.scope, id: g.targetId } : null);
    return h(
      "section",
      { class: "mem-scope", "aria-label": g.label, "data-testid": "mem-group", "data-scope": g.scope },
      h("h3", { class: "mem-h3", "data-testid": "mem-group-head" }, h("bdi", null, g.label), " ", badgeFor(place)),
      g.entries.length === 0 ? h("p", { class: "mem-muted", "data-testid": "mem-group-empty" }, COPY.emptyScope) : h("ul", { class: "mem-rows" }, g.entries.map(entryRow))
    );
  }

  function paint() {
    status.textContent = phase === "loading" ? COPY.loading : phase === "error" ? COPY.unavailable : "";
    status.dataset.state = phase;
    root.querySelector('[data-testid="mem-deleted-note"]').hidden = filters.statuses[0] !== "deleted";
    q.set({ cards: queue.cards, truncated: queue.truncated, phase, places });
    if (phase === "loading") listBody.replaceChildren();
    else if (phase === "error") listBody.replaceChildren(h("button", { type: "button", class: "mem-btn", "data-testid": "mem-retry", onClick: () => load(false) }, COPY.retry));
    else {
      const named = new Set(list.groups.filter((g) => g.scope === "repo").map((g) => g.label));
      const extra = repos.filter((r) => !named.has(r.name)).map((r) => group({ scope: "repo", label: r.name, targetId: r.id, entries: [] }, { kind: "repo", id: r.id }));
      const groups = list.groups.map((g) => group(g));
      const any = list.groups.some((g) => g.entries.length > 0);
      listBody.replaceChildren(
        ...(any || extra.length > 0 || queue.cards.length > 0 ? [] : [h("p", { class: "mem-muted", "data-testid": "mem-empty" }, COPY.emptyAll)]),
        ...groups,
        ...extra,
        ...(list.truncated ? [h("p", { class: "mem-muted" }, "More memory matches than this shows. Narrow it with a kind or a status.")] : [])
      );
    }
  }

  paint();
  load(false);
  whoAmI();

  return {
    destroy() {
      ac.abort();
      toasts.destroy();
      q.destroy();
      contentEl.replaceChildren();
    },
  };
}

FULC.register({
  id: "memory",
  title: "Memory",
  icon: "M",
  defaultSize: { w: 980, h: 640 },
  onOpen({ contentEl }) {
    teardown();
    current = mountApp(contentEl);
  },
  onClose() {
    teardown();
  },
});
