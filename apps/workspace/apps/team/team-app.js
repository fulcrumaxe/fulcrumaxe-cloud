// The Team app: the engine team of a repository, watched from the workspace (agents, merge lanes, the watch switch).
//
// The page draws what describe() in team-model.js returns, and nothing else. Every node is built with h(), so a name from outside (a repo or a runner)
// is a text node, in a <bdi> where it stands inside a sentence, and never markup. Parts that hold a control (the repo list and the settings sheet) are
// rebuilt only when what they show changes, so a refresh never closes an open list or takes focus from a checkbox.
import { h } from "../_lib/dom.js";
import { on, onRefresh } from "../../core/cloud-live.js";
import { WORDS, createTeam, describe } from "./team-model.js";

const FULC = window.FULC;
if (!FULC || typeof FULC.register !== "function") {
  throw new Error("Team app: the FULC SDK global is missing");
}

const link = (href, text, extra) => (href ? h("a", { class: "tm-link", href, target: "_blank", rel: "noopener noreferrer", "aria-label": text + WORDS.newWindow, ...extra }, text) : h("span", extra, text));

function mountApp(contentEl) {
  const ac = new AbortController();
  const team = createTeam({ signal: ac.signal, onChange: () => paint() });
  const root = h("div", { class: "tm-app", "data-testid": "tm-app" });
  contentEl.replaceChildren(root);

  const sig = new Map(); // a part is rebuilt only when its signature changes
  let want = null; // the data-focus key to put focus on after the next rebuild that has it (set by a control that closes or opens a part)
  const swap = (key, parent, value, build) => {
    const s = JSON.stringify(value);
    if (sig.get(key) === s) return;
    sig.set(key, s);
    const hadFocus = parent.contains(document.activeElement);
    const held = want || (parent.contains(document.activeElement) ? document.activeElement.getAttribute("data-focus") : null);
    // dom-insert-ok: every build() returns h() nodes, text, or null/false for an absent part; the filter drops the absent ones
    parent.replaceChildren(...[].concat(build()).filter((n) => n !== null && n !== undefined && n !== false));
    if (held) {
      const again = [...parent.querySelectorAll("[data-focus]")].find((el) => el.getAttribute("data-focus") === held);
      if (again) { again.focus(); if (held === want) want = null; }
    }
    if (hadFocus && !parent.contains(document.activeElement)) heading.focus();
  };
  const said = { n: "", b: "", r: "" };
  const hear = (k, v) => (said[k] === v ? "" : (said[k] = v));
  const setText = (el, value) => { if (el.textContent !== value) el.textContent = value; };

  const heading = h("h2", { class: "tm-title", id: "tm-heading", tabindex: "-1", "data-testid": "tm-heading" }, WORDS.title);
  const picker = h("select", { class: "tm-select", "data-testid": "tm-repo", "aria-label": "Repository", onChange: (e) => team.select(e.target.value) });
  const chip = h("span", { class: "tm-chip", "data-testid": "tm-chip" });
  const runner = h("span", { class: "tm-runner", "data-testid": "tm-runner" });
  const sheetBtn = h("button", { type: "button", class: "tm-btn", "data-testid": "tm-settings-btn", "aria-expanded": "false", "aria-controls": "tm-sheet", onClick: () => team.toggleSheet() }, WORDS.settings);
  const bar = h("div", { class: "tm-bar" }, picker, chip, runner, sheetBtn);
  const live = h("p", { class: "tm-live", role: "status", "aria-live": "polite", "data-testid": "tm-live" });
  const banner = h("p", { class: "tm-banner", "data-testid": "tm-banner", role: "note" });
  const notices = h("ul", { class: "tm-notices", role: "list", "data-testid": "tm-notices" });
  const note = h("p", { class: "tm-muted", "data-testid": "tm-refresh-failed" });
  const sheet = h("div", { class: "tm-sheet", id: "tm-sheet", "data-testid": "tm-sheet" });
  const body = h("div", { class: "tm-body" });
  root.replaceChildren(h("div", { class: "tm-page" }, heading, bar, live, banner, notices, note, sheet, body));

  // A control that cannot be used right now keeps its place in the Tab order (aria-disabled, not disabled): focus stays on it through a save, and a member who tabs to it hears why.
  const box = (attrs, checked, enabled, why, set) => h("input", { type: "checkbox", checked, "aria-disabled": enabled ? null : "true", "aria-describedby": enabled ? null : why, onClick: (e) => { if (!enabled) e.preventDefault(); }, onChange: (e) => set(e.target.checked), ...attrs });
  function switchRow(testid, label, checked, enabled, why) {
    return h("label", { class: "tm-check" }, box({ "data-testid": testid, "data-focus": testid }, checked, enabled, why, (on) => team.setWatch(on)), h("span", null, label));
  }
  const closeConfirm = () => { want = "delete"; team.cancelDelete(); };
  function sheetNodes(s) {
    const can = s.canEdit && !s.saving;
    const ro = s.canEdit ? null : "tm-ro";
    return [
      s.readOnly ? h("p", { class: "tm-muted", id: "tm-ro", "data-testid": "tm-readonly" }, s.readOnly) : null,
      switchRow("tm-watch", WORDS.watch, s.watch, can, ro),
      h("h3", { class: "tm-sub" }, WORDS.repos),
      s.repos.length === 0 ? h("p", { class: "tm-muted" }, WORDS.noSettingsRepos) : h("ul", { class: "tm-list", role: "list" }, s.repos.map((r) =>
        h("li", { class: "tm-item", "data-testid": "tm-repo-row", "data-refused": r.refused ? "true" : "false" },
          h("label", { class: "tm-check" },
            box({ "data-testid": "tm-repo-" + r.id, "data-focus": "repo-" + r.id }, r.checked, can && !r.refused, r.refused ? "tm-why-" + r.id : ro, (on) => team.setRepo(r.id, on)),
            h("bdi", null, r.name)),
          r.refused ? h("span", { class: "tm-reason", id: "tm-why-" + r.id, "data-testid": "tm-refusal" }, r.reason) : null))),
      s.canEdit ? (s.confirmDelete
        ? h("div", { class: "tm-confirm", role: "group", "aria-labelledby": "tm-confirm-h", "data-testid": "tm-confirm", onKeydown: (e) => { if (e.key === "Escape") { e.stopPropagation(); closeConfirm(); } } },
            h("h4", { class: "tm-sub", id: "tm-confirm-h" }, WORDS.deleteData), h("p", null, WORDS.deleteAsk),
            h("button", { type: "button", class: "tm-btn", "data-testid": "tm-delete-yes", "data-focus": "delete-yes", onClick: () => { want = "delete"; team.deleteData(); } }, WORDS.deleteYes),
            h("button", { type: "button", class: "tm-btn", "data-testid": "tm-delete-cancel", "data-focus": "delete-cancel", onClick: closeConfirm }, WORDS.cancel))
        : h("button", { type: "button", class: "tm-btn", "data-testid": "tm-delete", "data-focus": "delete", "aria-disabled": s.saving ? "true" : "false", onClick: () => { if (!s.saving) { want = "delete-cancel"; team.askDelete(); } } }, WORDS.deleteData)) : null,
    ];
  }

  const head = (title, p, testid) => h("div", { class: "tm-panel-head" }, h("h3", { class: "tm-sub" }, title), h("span", { class: "tm-asof", "data-testid": testid + "-asof" }, p.asOf), p.warn ? h("span", { class: "tm-warn", "data-testid": testid + "-warn" }, p.warn) : null);
  const dLink = (n, href) => (n ? link(href, "D#" + n, { "data-testid": "tm-d" }) : null);
  function agentsPanel(p) {
    return h("section", { class: "tm-panel", "data-testid": "tm-agents" }, head("Agents", p, "tm-agents"),
      p.failed ? h("p", { class: "tm-muted", "data-testid": "tm-agents-failed" }, WORDS.panelFailed)
      : p.rows.length === 0 ? h("p", { class: "tm-muted", "data-testid": "tm-agents-empty" }, p.empty)
      : h("ul", { class: "tm-list", role: "list" }, p.rows.map((a) =>
          h("li", { class: "tm-item", "data-testid": "tm-agent", "data-state": a.state },
            h("strong", { class: "tm-role" }, h("bdi", null, a.role)), " ", dLink(a.discussion, a.link), a.discussion ? " " : null, h("span", { class: "tm-mode" }, a.mode), " ", h("span", { class: "tm-state", "data-testid": "tm-agent-text" }, a.text)))));
  }
  const laneItem = (l) =>
    h("li", { class: "tm-item", "data-testid": "tm-lane", "data-pr": String(l.pr) },
      link(l.prLink, "PR #" + l.pr, { "data-testid": "tm-pr" }), " ", dLink(l.discussion, l.discussionLink), l.discussion ? " " : null, h("span", { class: "tm-state", "data-testid": "tm-lane-state" }, l.state),
      l.gates.length ? h("ul", { class: "tm-gates", role: "list" }, l.gates.map((g) => h("li", { class: "tm-gate", "data-testid": "tm-gate", "data-result": g.result }, g.gate + ": " + g.result))) : null);
  function lanesPanel(p) {
    return h("section", { class: "tm-panel", "data-testid": "tm-lanes" }, head("Merge lane", p, "tm-lanes"),
      p.failed ? h("p", { class: "tm-muted", "data-testid": "tm-lanes-failed" }, WORDS.panelFailed)
      : [p.open.length === 0 ? h("p", { class: "tm-muted", "data-testid": "tm-lanes-empty" }, p.empty) : h("ul", { class: "tm-list", role: "list" }, p.open.map(laneItem)),
         p.merged.length ? h("div", { "data-testid": "tm-merged" }, h("h4", { class: "tm-sub" }, WORDS.mergedToday), h("ul", { class: "tm-list", role: "list" }, p.merged.map(laneItem))) : null]);
  }

  function paint() {
    const d = describe(team.state, Date.now());
    const hasRepos = d.kind === "ready";
    picker.hidden = chip.hidden = runner.hidden = !hasRepos;
    sheetBtn.hidden = d.kind === "loading" || d.kind === "error";
    sheetBtn.setAttribute("aria-expanded", d.sheet && d.sheet.open ? "true" : "false");
    const chipText = hasRepos ? d.chip : "";
    if (chip.dataset.liveness !== chipText) {
      chip.dataset.liveness = chipText;
      chip.replaceChildren(...(chipText ? [h("span", { class: "tm-vh" }, WORDS.chipContext), chipText] : []));
    }
    if (hasRepos) {
      swap("repos", picker, d.repos, () => d.repos.map((r) => h("option", { value: r.id, selected: r.selected }, r.name)));
      picker.value = (d.repos.find((r) => r.selected) || d.repos[0]).id;
      runner.replaceChildren(...(d.runner ? ["Runner: ", h("bdi", null, d.runner)] : []));
    }
    setText(banner, hasRepos ? d.banner : "");
    banner.hidden = !(hasRepos && d.banner);
    notices.hidden = !(hasRepos && d.notices.length);
    swap("notices", notices, hasRepos ? d.notices : [], () => (hasRepos ? d.notices : []).map((n) => h("li", { class: "tm-notice", "data-testid": "tm-notice" }, n)));
    setText(note, d.refreshFailed || "");
    note.hidden = !d.refreshFailed;
    sheet.hidden = !(d.sheet && d.sheet.open);
    if (d.sheet) swap("sheet", sheet, d.sheet, () => sheetNodes(d.sheet));
    // Said once, when it changes: a poll that finds the same banner or the same failure says nothing. A notice is cleared when a save starts, so the same sentence again is a change.
    const msg = [hear("n", d.sheet ? d.sheet.notice : ""), hear("b", hasRepos ? d.banner : ""), hear("r", d.refreshFailed || "")].filter(Boolean).join(" ");
    if (msg) live.replaceChildren(h("span", null, msg));
    swap("body", body, d.kind === "ready" ? { a: d.agents, l: d.lanes } : { k: d.kind, c: d.sheet && d.sheet.canEdit, w: d.sheet && d.sheet.watch, s: d.sheet && d.sheet.saving }, () => {
      if (d.kind === "ready") return h("div", { class: "tm-panels" }, agentsPanel(d.agents), lanesPanel(d.lanes));
      if (d.kind === "off") return [h("p", { class: "tm-muted", "data-testid": "tm-off" }, d.text), d.sheet.canEdit ? switchRow("tm-watch-off", WORDS.watch, false, !d.sheet.saving) : null];
      return h("p", { class: d.kind === "error" ? "tm-error" : "tm-muted", role: d.kind === "error" ? "alert" : "status", "data-testid": "tm-" + d.kind }, d.text);
    });
  }

  paint();
  team.load();
  team.start({ subscribe: onRefresh, listen: on, hidden: () => document.hidden });
  return {
    destroy() {
      team.stop();
      ac.abort();
      contentEl.replaceChildren();
    },
  };
}

let current = null;

FULC.register({
  id: "team",
  title: "Team",
  icon: "▤",
  defaultSize: { w: 760, h: 560 },
  onOpen({ contentEl }) {
    if (current) current.destroy();
    current = mountApp(contentEl);
  },
  onClose() {
    if (current) current.destroy();
    current = null;
  },
});
