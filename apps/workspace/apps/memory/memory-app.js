// D#601 MEM-4a3: the Memory app. All memory grouped by scope: a repo as owner/name, an item as its number and title, the account, a role. Each repo
// and item header carries the number of proposals waiting, read from the pending-counts route (the queue's own count), and each row says how many
// runs used the entry and links to them. The review queue is the next change.
//
// Registration goes through the FULC global (see the Runs app's header comment: an ES import of the SDK would blow the boot request budget).
import { h, timeNode } from "../_lib/dom.js";
import {
  COPY, KINDS, STATUSES, loadCounts, loadList, loadRepos, loadRuns, runName, runsWords, statusView, text, waitingWords,
} from "./memory-storage.js";

const FULC = window.FULC;
if (!FULC || typeof FULC.register !== "function") {
  throw new Error("Memory app: the FULC SDK global is missing");
}

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/;
const validTime = (iso) => typeof iso === "string" && ISO.test(iso) && !Number.isNaN(Date.parse(iso));
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
  let repos = [];
  let counts = null; // { repos, items } or null when the route failed
  let places = new Map(); // "scope|label" -> { kind, id }
  const filters = { kinds: [], statuses: [] };
  const runPanels = new Map(); // entry id -> { phase: loading | ready | error, runs, total, truncated }
  let seq = 0;

  const status = h("p", { class: "mem-status", role: "status", "aria-live": "polite", "data-testid": "mem-status" });
  const listBody = h("div", { "data-testid": "mem-list" });
  const kindSel = h("select", { id: "mem-f-kind", class: "mem-input", "data-testid": "mem-filter-kind", onChange: () => (filters.kinds = kindSel.value ? [kindSel.value] : [], load(false)) }, h("option", { value: "" }, "All kinds"), KINDS.map(([v, l]) => h("option", { value: v }, l)));
  const statusSel = h("select", { id: "mem-f-status", class: "mem-input", "data-testid": "mem-filter-status", onChange: () => (filters.statuses = statusSel.value ? [statusSel.value] : [], load(false)) }, h("option", { value: "" }, "Any status"), STATUSES.map(([v, l]) => h("option", { value: v }, l)));
  const root = h(
    "div",
    { class: "mem-app", "data-testid": "mem-app" },
    h("div", { class: "mem-main" },
      h("h1", { class: "mem-title-h" }, COPY.title),
      status,
      h("section", { class: "mem-section", "aria-label": COPY.listTitle },
        h("h2", { class: "mem-h" }, COPY.listTitle),
        h("div", { class: "mem-filters" }, h("label", { for: "mem-f-kind" }, "Kind"), kindSel, h("label", { for: "mem-f-status" }, "Status"), statusSel),
        listBody))
  );
  contentEl.replaceChildren(root);

  function indexPlaces() {
    places = new Map();
    for (const r of repos) places.set("repo|" + r.name, { kind: "repo", id: r.id });
    for (const g of list.groups) if (g.targetId && (g.scope === "repo" || g.scope === "item")) places.set(g.scope + "|" + g.label, { kind: g.scope, id: g.targetId });
  }

  async function load(silent) {
    const my = ++seq;
    if (!silent && phase !== "ready") {
      phase = "loading";
      paint();
    }
    try {
      const [l, rp] = await Promise.all([loadList(filters, undefined, ac.signal), loadRepos(undefined, ac.signal)]);
      if (my !== seq) return;
      list = l;
      repos = rp;
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
      else status.textContent = COPY.unavailable;
    }
    paint();
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
      runsControl(row)
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
    if (phase === "loading") listBody.replaceChildren();
    else if (phase === "error") listBody.replaceChildren(h("button", { type: "button", class: "mem-btn", "data-testid": "mem-retry", onClick: () => load(false) }, COPY.retry));
    else {
      const named = new Set(list.groups.filter((g) => g.scope === "repo").map((g) => g.label));
      const extra = repos.filter((r) => !named.has(r.name)).map((r) => group({ scope: "repo", label: r.name, targetId: r.id, entries: [] }, { kind: "repo", id: r.id }));
      const groups = list.groups.map((g) => group(g));
      const any = list.groups.some((g) => g.entries.length > 0);
      listBody.replaceChildren(
        ...(any || extra.length > 0 ? [] : [h("p", { class: "mem-muted", "data-testid": "mem-empty" }, COPY.emptyAll)]),
        ...groups,
        ...extra,
        ...(list.truncated ? [h("p", { class: "mem-muted" }, "More memory matches than this shows. Narrow it with a kind or a status.")] : [])
      );
    }
  }

  paint();
  load(false);

  return {
    destroy() {
      ac.abort();
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
