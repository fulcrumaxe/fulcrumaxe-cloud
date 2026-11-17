// The Team app: the engine team of a repository, watched from the workspace (agents, merge lanes, the watch switch).
//
// The page draws what describe() in team-model.js returns, and nothing else. Every node is built with h(), so a name from outside (a repo or a runner)
// is a text node, in a <bdi> where it stands inside a sentence, and never markup. Parts that hold a control (the repo list and the settings sheet) are
// rebuilt only when what they show changes, so a refresh never closes an open list or takes focus from a checkbox.
import { h } from "../_lib/dom.js";
import { on, onRefresh } from "../../core/cloud-live.js";
import { WORDS, createTeam, describe } from "./team-model.js";
import { DIAL_CLASSES, HALT_WORDS, OP_WORDS, ROLES, TTL } from "./team-operate.js";

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
  const said = { n: "", b: "", r: "", o: "", w: "" };
  const hear = (k, v) => (said[k] === v ? "" : (said[k] = v));
  const setText = (el, value) => { if (el.textContent !== value) el.textContent = value; };

  const heading = h("h2", { class: "tm-title", id: "tm-heading", tabindex: "-1", "data-testid": "tm-heading" }, WORDS.title);
  const picker = h("select", { class: "tm-select", "data-testid": "tm-repo", "aria-label": "Repository", onChange: (e) => team.select(e.target.value) });
  const chip = h("span", { class: "tm-chip", "data-testid": "tm-chip" });
  const haltChip = h("span", { class: "tm-chip tm-halt-chip", "data-testid": "tm-halt-chip" });
  const runner = h("span", { class: "tm-runner", "data-testid": "tm-runner" });
  const sheetBtn = h("button", { type: "button", class: "tm-btn", "data-testid": "tm-settings-btn", "aria-expanded": "false", "aria-controls": "tm-sheet", onClick: () => team.toggleSheet() }, WORDS.settings);
  const bar = h("div", { class: "tm-bar" }, picker, chip, haltChip, runner, sheetBtn);
  const live = h("p", { class: "tm-live", role: "status", "aria-live": "polite", "data-testid": "tm-live" });
  const banner = h("p", { class: "tm-banner", "data-testid": "tm-banner", role: "note" });
  const notices = h("ul", { class: "tm-notices", role: "list", "data-testid": "tm-notices" });
  const note = h("p", { class: "tm-muted", "data-testid": "tm-refresh-failed" });
  const sheet = h("div", { class: "tm-sheet", id: "tm-sheet", "data-testid": "tm-sheet" });
  const body = h("div", { class: "tm-body" });
  // The operate half (owners and admins): built once, so what is typed in a field survives every refresh. A control that is locked keeps its place in the
  // Tab order with aria-disabled and names the sentence that says why; syncGates() sets that on every [data-gate] after each paint.
  const gated = (attrs, fn, ...kids) => {
    const el = h("button", { type: "button", class: "tm-btn", "data-gate": "1", ...attrs, onClick: () => { if (el.getAttribute("aria-disabled") !== "true") fn(); } }, ...kids);
    return el;
  };
  const field = (label, control) => h("label", { class: "tm-field" }, h("span", null, label), control);
  const options = (entries) => entries.map(([value, label]) => h("option", { value }, label));
  const pick = (testid, label, entries) => h("select", { class: "tm-select", "data-gate": "1", "data-testid": testid, "aria-label": label }, options(entries));
  const roleSel = pick("tm-op-role", OP_WORDS.role, Object.entries(ROLES));
  const discIn = h("input", { type: "number", class: "tm-input", min: "1", step: "1", "data-gate": "1", "data-testid": "tm-op-discussion", "aria-label": OP_WORDS.discussion, placeholder: "D#" });
  const classSel = pick("tm-op-class", OP_WORDS.dialClass, Object.entries(DIAL_CLASSES));
  const levelSel = pick("tm-op-level", OP_WORDS.level, [1, 2, 3, 4, 5].map((n) => [String(n), String(n)]));
  const ttlSel = pick("tm-op-ttl", OP_WORDS.ttl, Object.entries(TTL));
  const ops = team.operate;
  const opCtl = h("div", { class: "tm-op-ctl", "data-testid": "tm-op-ctl" },
    h("div", { class: "tm-op-row" },
      gated({ "data-testid": "tm-op-start", "data-focus": "op-start" }, () => ops.startDay(), OP_WORDS.startDay),
      gated({ "data-testid": "tm-op-pause", "data-focus": "op-pause" }, () => ops.pause(), OP_WORDS.pause),
      gated({ "data-testid": "tm-op-resume", "data-focus": "op-resume" }, () => ops.resume(), OP_WORDS.resume)),
    h("div", { role: "group", "aria-labelledby": "tm-op-req-h" }, h("h4", { class: "tm-sub", id: "tm-op-req-h" }, OP_WORDS.request),
      h("div", { class: "tm-op-row" }, field(OP_WORDS.role, roleSel), field(OP_WORDS.discussion, discIn),
        gated({ "data-testid": "tm-op-request", "data-focus": "op-request" }, () => ops.requestSpawn(roleSel.value, discIn.value), OP_WORDS.send))),
    h("div", { role: "group", "aria-labelledby": "tm-op-dial-h" }, h("h4", { class: "tm-sub", id: "tm-op-dial-h" }, OP_WORDS.setDial),
      h("div", { class: "tm-op-row" }, field(OP_WORDS.dialClass, classSel), field(OP_WORDS.level, levelSel), field(OP_WORDS.ttl, ttlSel),
        gated({ "data-testid": "tm-op-setdial", "data-focus": "op-setdial" }, () => ops.setDialLevel(classSel.value, levelSel.value, ttlSel.value), OP_WORDS.send)),
      h("p", { class: "tm-muted" }, OP_WORDS.levelHint)));
  const opTop = h("div", { class: "tm-op-top" });
  const opConfirm = h("div", { class: "tm-op-confirm" });
  const opCmds = h("div", { class: "tm-op-cmds", "data-testid": "tm-op-cmds" });
  const opDials = h("div", { class: "tm-op-dials", "data-testid": "tm-op-dials" });
  const opWrap = h("section", { class: "tm-panel tm-op", "data-testid": "tm-operate" }, h("h3", { class: "tm-sub" }, OP_WORDS.operate), opTop, opCtl, opConfirm, opCmds, opDials);
  opWrap.hidden = true;
  const haltBox = h("section", { class: "tm-panel tm-halt", "aria-labelledby": "tm-halt-h", "data-testid": "tm-halt" });
  haltBox.hidden = true;
  root.replaceChildren(h("div", { class: "tm-page" }, heading, bar, live, banner, notices, note, haltBox, sheet, body, opWrap));

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

  const head = (title, p, testid, key) => h("div", { class: "tm-panel-head" }, h("h3", { class: "tm-sub", tabindex: key ? "-1" : null, "data-focus": key || null }, title), h("span", { class: "tm-asof", "data-testid": testid + "-asof" }, p.asOf), p.warn ? h("span", { class: "tm-warn", "data-testid": testid + "-warn" }, p.warn) : null);
  const dLink = (n, href) => (n ? link(href, "D#" + n, { "data-testid": "tm-d" }) : null);
  const closeStop = (id) => { want = "stop-" + id; ops.cancelStop(); };
  const stopButton = (a) => a.stop.pending
    ? h("button", { type: "button", class: "tm-btn tm-stop", "aria-disabled": "true", "data-testid": "tm-stop", "data-focus": "stop-" + a.stopId, "aria-label": "Stop requested for " + a.who + ". " + OP_WORDS.stopPending }, "Stop requested")
    : gated({ class: "tm-btn tm-stop", "data-testid": "tm-stop", "data-focus": "stop-" + a.stopId, "aria-label": OP_WORDS.stop + " " + a.who }, () => { want = "stop-cancel"; ops.askStop(a.stopId); if (!team.state.op.confirmStop) want = null; }, OP_WORDS.stop);
  function agentsPanel(p) {
    return h("section", { class: "tm-panel", "data-testid": "tm-agents" }, head("Agents", p, "tm-agents", "agents-head"),
      p.failed ? h("p", { class: "tm-muted", "data-testid": "tm-agents-failed" }, WORDS.panelFailed)
      : p.rows.length === 0 ? h("p", { class: "tm-muted", "data-testid": "tm-agents-empty" }, p.empty)
      : h("ul", { class: "tm-list", role: "list" }, p.rows.map((a) =>
          h("li", { class: "tm-item", "data-testid": "tm-agent", "data-state": a.state },
            h("strong", { class: "tm-role" }, h("bdi", null, a.role)), " ", dLink(a.discussion, a.link), a.discussion ? " " : null, h("span", { class: "tm-mode" }, a.mode), " ", h("span", { class: "tm-state", "data-testid": "tm-agent-text" }, a.text), a.stop ? stopButton(a) : null))));
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

  // The halt: shown to everyone (a member reads the state, nothing more); an owner or admin also gets Halt or Clear halt behind a question of its own.
  // Focus stays on the one control that stands for the action (data-focus "halt-primary"), whichever of Halt and Clear halt is drawn.
  const closeHalt = () => { want = "halt-primary"; ops.cancelHalt(); };
  const haltBtn = (label, testid, hl, kind) => h("button", { type: "button", class: "tm-btn", "data-testid": testid, "data-focus": "halt-primary", "aria-disabled": hl.locked ? "true" : "false", "aria-describedby": hl.locked ? "tm-halt-why" : null,
    onClick: (e) => { if (e.currentTarget.getAttribute("aria-disabled") === "true") return; want = "halt-cancel"; ops.askHalt(kind); if (!team.state.op.confirmHalt) want = null; } }, label);
  const confirmNode = (c) => h("div", { class: "tm-confirm", role: "group", "aria-labelledby": "tm-halt-q", "data-testid": "tm-halt-confirm", onKeydown: (e) => { if (e.key === "Escape") { e.stopPropagation(); closeHalt(); } } },
    h("h4", { class: "tm-sub", id: "tm-halt-q" }, c.title), h("p", { "data-testid": "tm-halt-confirm-text" }, c.parts.map((p) => (typeof p === "string" ? p : h("bdi", null, p.bdi)))), c.texts.map((t) => h("p", null, t)),
    h("button", { type: "button", class: "tm-btn", "data-testid": "tm-halt-yes", "data-focus": "halt-yes", onClick: () => { want = "halt-primary"; if (c.kind === "halt") ops.halt(); else ops.clearHalt(); } }, c.yes),
    h("button", { type: "button", class: "tm-btn", "data-testid": "tm-halt-cancel", "data-focus": "halt-cancel", onClick: closeHalt }, HALT_WORDS.cancel));
  function paintHalt(hl) {
    const shown = !!hl && (hl.state !== "none" || hl.canHalt);
    haltBox.hidden = !shown;
    setText(haltChip, hl ? hl.chip : "");
    haltChip.dataset.halt = hl ? hl.state : "none";
    haltChip.hidden = !hl || hl.state === "none";
    const hadFocus = haltBox.contains(document.activeElement);
    swap("halt", haltBox, shown ? { ...hl, id: "" } : null, () => (shown ? [
      h("h3", { class: "tm-sub", id: "tm-halt-h", tabindex: "-1", "data-focus": "halt-head" }, HALT_WORDS.head),
      h("p", { class: hl.state === "none" ? "tm-muted" : "tm-halt-state", "data-testid": "tm-halt-text", "data-state": hl.state }, hl.text),
      hl.note ? h("p", { class: "tm-halt-note", role: "note", "data-testid": "tm-halt-note" }, hl.note) : null,
      hl.why ? h("p", { class: "tm-muted", id: "tm-halt-why", "data-testid": "tm-halt-why" }, hl.why) : null,
      hl.confirm ? confirmNode(hl.confirm) : hl.canHalt ? haltBtn(HALT_WORDS.halt, "tm-halt-btn", hl, "halt") : hl.canClear ? haltBtn(HALT_WORDS.clear, "tm-clear-btn", hl, "clear") : null,
    ] : null));
    // The state changed under an open question (another person halted or cleared): it closes, and focus goes to the control that replaced it.
    if (hl && hl.stale) {
      if (hadFocus) want = "halt-primary";
      queueMicrotask(() => ops.cancelHalt());
    }
  }
  // A change of state is said once; the first state of a repo is a baseline, not news.
  let haltSeen = null, haltRepo = null;
  function haltWords(hl) {
    const id = hl ? hl.id : "", st = hl ? hl.state : "none";
    if (id !== haltRepo) { haltRepo = id; haltSeen = st; return ""; }
    if (st === haltSeen) return "";
    haltSeen = st;
    return st === "none" ? HALT_WORDS.clearedSaid : st === "pending" ? HALT_WORDS.pendingSaid : HALT_WORDS.haltedSaid;
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
    const o = d.operate && d.operate.show ? d.operate : null;
    const msg = [hear("n", d.sheet ? d.sheet.notice : ""), hear("o", o ? o.notice : ""), outcomeWords(o && o.commands), hear("w", d.halt ? d.halt.note : ""), haltWords(d.halt || null), hear("b", hasRepos ? d.banner : ""), hear("r", d.refreshFailed || "")].filter(Boolean).join(" ");
    if (msg) live.replaceChildren(h("span", null, msg));
    swap("body", body, d.kind === "ready" ? { a: d.agents, l: d.lanes } : { k: d.kind, c: d.sheet && d.sheet.canEdit, w: d.sheet && d.sheet.watch, s: d.sheet && d.sheet.saving }, () => {
      if (d.kind === "ready") return h("div", { class: "tm-panels" }, agentsPanel(d.agents), lanesPanel(d.lanes));
      if (d.kind === "off") return [h("p", { class: "tm-muted", "data-testid": "tm-off" }, d.text), d.sheet.canEdit ? switchRow("tm-watch-off", WORDS.watch, false, !d.sheet.saving) : null];
      return h("p", { class: d.kind === "error" ? "tm-error" : "tm-muted", role: d.kind === "error" ? "alert" : "status", "data-testid": "tm-" + d.kind }, d.text);
    });
    paintOperate(o);
    paintHalt(d.halt || null);
    if (want) { // a control that closed a part asks for focus on one that lives in another part
      const el = [...root.querySelectorAll("[data-focus]")].find((e) => e.getAttribute("data-focus") === want);
      if (el) { el.focus(); want = null; }
    }
  }

  const cmdItem = (c) => h("li", { class: "tm-item", "data-testid": "tm-cmd", "data-state": c.state },
    h("span", { class: "tm-role" }, c.text), " ", h("strong", { class: "tm-state", "data-testid": "tm-cmd-state" }, c.word), " ", h("span", { class: "tm-cmd-detail", "data-testid": "tm-cmd-detail" }, c.detail),
    c.cancel ? gated({ "data-cancel": "1", "data-testid": "tm-cmd-cancel", "data-focus": "cancel-" + c.id, "aria-label": OP_WORDS.cancel + ": " + c.text }, () => { want = "cmds-head"; ops.cancel(c.id); }, OP_WORDS.cancel) : null);
  const listHead = (title, p, key, testid) => h("div", { class: "tm-panel-head" }, h("h4", { class: "tm-sub", tabindex: "-1", "data-focus": key }, title), h("span", { class: "tm-asof", "data-testid": testid }, p.asOf));
  // A command's outcome is said once, when its state changes to one of these; what was already there when the list was first read is not news.
  const OUTCOMES = new Set(["applied", "refused", "expired", "not_confirmed"]);
  const seen = new Map();
  let baselined = false;
  function outcomeWords(cmds) {
    if (!cmds || cmds.asOf === OP_WORDS.noData) { seen.clear(); baselined = false; return ""; } // nothing read yet (or another repo was chosen)
    const out = [];
    for (const r of cmds.rows) {
      if (baselined && seen.has(r.id) && seen.get(r.id) !== r.state && OUTCOMES.has(r.state)) out.push(r.text + ": " + r.word + ". " + r.detail);
      seen.set(r.id, r.state);
    }
    baselined = true;
    return out.join(" ");
  }
  function paintOperate(o) {
    opWrap.hidden = !o;
    if (!o) return;
    swap("op-top", opTop, { r: o.reason, m: o.removed, f: o.offline, on: o.sw.on, w: o.sw.why }, () => [
      o.reason ? h("p", { class: "tm-op-why", id: "tm-op-why", "data-testid": "tm-op-why" }, o.reason) : null,
      o.removed ? h("p", { class: "tm-muted", "data-testid": "tm-op-removed" }, o.removed) : null,
      o.offline ? h("p", { class: "tm-muted", "data-testid": "tm-op-offline" }, o.offline) : null,
      h("label", { class: "tm-check" },
        h("input", { type: "checkbox", checked: o.sw.on, "data-sw": "1", "data-testid": "tm-op-switch", "data-focus": "op-switch", "aria-describedby": o.sw.why ? "tm-op-sw-why" : null,
          onClick: (e) => { if (e.target.getAttribute("aria-disabled") === "true") e.preventDefault(); }, onChange: (e) => { if (e.target.getAttribute("aria-disabled") === "true") { e.target.checked = o.sw.on; return; } ops.setOperate(e.target.checked); } }),
        h("span", null, OP_WORDS.operateSwitch)),
      o.sw.why ? h("span", { class: "tm-reason", id: "tm-op-sw-why", "data-testid": "tm-op-sw-why" }, o.sw.why) : null,
    ]);
    opCtl.hidden = !!o.removed;
    const confirmHadFocus = opConfirm.contains(document.activeElement);
    swap("op-confirm", opConfirm, o.confirm, () => (o.confirm ? h("div", { class: "tm-confirm", role: "group", "aria-labelledby": "tm-stop-h", "data-testid": "tm-stop-confirm", onKeydown: (e) => { if (e.key === "Escape") { e.stopPropagation(); closeStop(o.confirm.id); } } },
      h("h4", { class: "tm-sub", id: "tm-stop-h" }, o.confirm.title), h("p", { "data-testid": "tm-stop-who" }, "Stop " + o.confirm.who + "."), h("p", null, o.confirm.text),
      h("button", { type: "button", class: "tm-btn", "data-testid": "tm-stop-yes", "data-focus": "stop-yes", onClick: () => { want = "stop-" + o.confirm.id; ops.stop(o.confirm.id); } }, OP_WORDS.stopYes),
      h("button", { type: "button", class: "tm-btn", "data-testid": "tm-stop-cancel", "data-focus": "stop-cancel", onClick: () => closeStop(o.confirm.id) }, OP_WORDS.cancel)) : null));
    // The agent being asked about went away: the question closes (the state with it, once this paint is done) and focus goes to the agents heading.
    if (!o.confirm && team.state.op.confirmStop) {
      if (confirmHadFocus) want = "agents-head";
      queueMicrotask(() => ops.cancelStop());
    }
    swap("op-cmds", opCmds, o.commands && { ...o.commands, asOf: "" }, () => (o.commands ? [listHead(OP_WORDS.commands, o.commands, "cmds-head", "tm-cmds-asof"),
      o.commands.failed ? h("p", { class: "tm-muted", "data-testid": "tm-cmds-failed" }, OP_WORDS.listFailed) : null,
      o.commands.rows.length ? h("ul", { class: "tm-list", role: "list" }, o.commands.rows.map(cmdItem)) : o.commands.failed ? null : h("p", { class: "tm-muted", "data-testid": "tm-cmds-empty" }, o.commands.empty)] : null));
    swap("op-dials", opDials, o.dials && { ...o.dials, asOf: "" }, () => (o.dials ? [listHead(OP_WORDS.dials, o.dials, "dials-head", "tm-dials-asof"),
      o.dials.failed ? h("p", { class: "tm-muted", "data-testid": "tm-dials-failed" }, OP_WORDS.listFailed) : null,
      o.dials.rows.length ? h("ul", { class: "tm-list", role: "list" }, o.dials.rows.map((r) => {
        const choose = h("select", { class: "tm-select", "data-gate": "1", "data-testid": "tm-dial-select", "data-focus": "dial-" + r.type, "aria-label": r.label }, r.options.map((x) => h("option", { value: x.value, selected: x.value === r.value }, x.label)));
        const now = r.options.find((x) => x.value === r.value);
        return h("li", { class: "tm-item", "data-testid": "tm-dial", "data-dial": r.type }, h("span", { class: "tm-role" }, r.label), " ",
          r.adjustable ? [choose, gated({ "data-testid": "tm-dial-apply", "data-focus": "apply-" + r.type, "aria-label": OP_WORDS.apply + ": " + r.label }, () => ops.saveDial(r.type, choose.value), OP_WORDS.apply)] : h("span", { class: "tm-state" }, now ? now.label : r.value));
      })) : o.dials.failed ? null : h("p", { class: "tm-muted", "data-testid": "tm-dials-empty" }, o.dials.empty)] : null));
    // The as-of words tick every minute; they are set in place, so a list is not rebuilt (and an unapplied choice in it not lost) just for the clock.
    for (const [part, key, id] of [[o.commands, opCmds, "tm-cmds-asof"], [o.dials, opDials, "tm-dials-asof"]]) {
      const el = key.querySelector('[data-testid="' + id + '"]');
      if (part && el) setText(el, part.asOf);
    }
    // Lock every control with one rule: the sentence above says why, and a save in flight holds them all (aria-disabled, so focus stays where it is).
    const lock = !!o.reason || o.saving;
    for (const el of root.querySelectorAll("[data-gate]")) { // the Stop buttons in the agents panel too
      // Cancel only takes an action back, so it stays usable while operate is off or the repo is halted; only a save in flight holds it.
      const cancel = el.hasAttribute("data-cancel");
      el.setAttribute("aria-disabled", (cancel ? o.saving : lock) ? "true" : "false");
      if (o.reason && !cancel) el.setAttribute("aria-describedby", "tm-op-why"); else el.removeAttribute("aria-describedby");
    }
    for (const el of opWrap.querySelectorAll("[data-sw]")) el.setAttribute("aria-disabled", o.sw.why || o.saving ? "true" : "false");
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
