// The Team app: the engine team of a repository, watched from the workspace (agents, merge lanes, the watch switch).
//
// The page draws what describe() in team-model.js returns, and nothing else. Every node is built with h(), so a name from outside (a repo or a runner)
// is a text node, in a <bdi> where it stands inside a sentence, and never markup. Parts that hold a control (the repo list and the settings sheet) are
// rebuilt only when what they show changes, so a refresh never closes an open list or takes focus from a checkbox.
import { h } from "../_lib/dom.js";
import { on, onRefresh } from "../../core/cloud-live.js";
import { WORDS, createTeam, describe } from "./team-model.js";
import { DIAL_CLASSES, HALT_WORDS, OP_WORDS, ROLES, STOP_WORDS, TTL, stopFailNodes } from "./team-operate.js";

const FULC = window.FULC;
if (!FULC || typeof FULC.register !== "function") {
  throw new Error("Team app: the FULC SDK global is missing");
}

const link = (href, text, extra) => (href ? h("a", { class: "tm-link", href, target: "_blank", rel: "noopener noreferrer", "aria-label": text + WORDS.newWindow, ...extra }, text) : h("span", extra, text));

/** Calls `fn` each time the tab is shown again; returns the function that stops it. */
function onVisible(fn) {
  const f = () => { if (!document.hidden) fn(); };
  document.addEventListener("visibilitychange", f);
  return () => document.removeEventListener("visibilitychange", f);
}

function mountApp(contentEl) {
  const ac = new AbortController();
  const team = createTeam({ signal: ac.signal, liveView: true, onChange: () => paint() });
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
  const said = { n: "", b: "", r: "", l: "", f: "", o: "", w: "", g: "", s: "" };
  const hear = (k, v) => (said[k] === v ? "" : (said[k] = v));
  const setText = (el, value) => { if (el.textContent !== value) el.textContent = value; };

  const heading = h("h2", { class: "tm-title", id: "tm-heading", tabindex: "-1", "data-testid": "tm-heading" }, WORDS.title);
  const picker = h("select", { class: "tm-select", "data-testid": "tm-repo", "aria-label": "Repository", onChange: (e) => team.select(e.target.value) });
  const chip = h("span", { class: "tm-chip", "data-testid": "tm-chip" });
  const haltChip = h("span", { class: "tm-chip tm-halt-chip", "data-testid": "tm-halt-chip" });
  const stopChip = h("span", { class: "tm-chip tm-stop-chip", "data-testid": "tm-stop-chip" });
  stopChip.hidden = true;
  const runner = h("span", { class: "tm-runner", "data-testid": "tm-runner" });
  const sheetBtn = h("button", { type: "button", class: "tm-btn", "data-testid": "tm-settings-btn", "aria-expanded": "false", "aria-controls": "tm-sheet", onClick: () => team.toggleSheet() }, WORDS.settings);
  const bar = h("div", { class: "tm-bar" }, picker, chip, haltChip, stopChip, runner, sheetBtn);
  const live = h("p", { class: "tm-live", role: "status", "aria-live": "polite", "data-testid": "tm-live" });
  const watchBar = h("div", { class: "tm-watch", "data-testid": "tm-liveview" });
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
  const stopBox = h("div", { class: "tm-panel tm-stopfail", "data-testid": "tm-stopfail" });
  stopBox.hidden = true;
  root.replaceChildren(h("div", { class: "tm-page" }, heading, bar, stopBox, watchBar, live, banner, notices, note, haltBox, sheet, body, opWrap));

  // A control that cannot be used right now keeps its place in the Tab order (aria-disabled, not disabled): focus stays on it through a save, and a member who tabs to it hears why.
  const box = (attrs, checked, enabled, why, set) => h("input", { type: "checkbox", checked, "aria-disabled": enabled ? null : "true", "aria-describedby": enabled ? null : why, onClick: (e) => { if (!enabled) e.preventDefault(); }, onChange: (e) => set(e.target.checked), ...attrs });
  function switchRow(testid, label, checked, enabled, why) {
    return h("label", { class: "tm-check" }, box({ "data-testid": testid, "data-focus": testid }, checked, enabled, why, (on) => team.setWatch(on)), h("span", { "data-part": "watch-words" }, label));
  }
  // The command, with a button that copies it. The answer (Copied, or why not) is spoken in a status line next to the button.
  const copyBlock = (rw, command, testid) => {
    const say = h("span", { class: "tm-muted", role: "status", "data-testid": "tm-copy-note" });
    const btn = h("button", { type: "button", class: "tm-btn", "data-testid": "tm-copy", onClick: async () => {
      try { await navigator.clipboard.writeText(command); say.textContent = rw.copied; } catch { say.textContent = rw.copyFailed; } // fx-swallow-ok: no clipboard here (an insecure page or a refusal); the command stays selectable and the note says so
    } }, rw.copy);
    return [h("pre", { class: "tm-code", tabindex: "0", "aria-label": "Command to run", "data-testid": testid }, command), btn, say];
  };
  const renameNodes = (rw) => [h("p", { class: "tm-muted", "data-testid": "tm-unnamed" }, rw.unnamed, " "),
    h("button", { type: "button", class: "tm-btn", "data-testid": "tm-rename-runner", onClick: () => window.FULCWM && window.FULCWM.open("runners") }, rw.rename)];
  // Which runner the switch means, its state before the box is ticked, the connecting state, and the one command when no bridge has reported.
  const runnerNodes = (rv) => !rv.words ? [] : [
    rv.choices.length > 1 ? h("label", { class: "tm-check" }, h("span", null, rv.words.pick + ": "),
      h("select", { class: "tm-select", "data-testid": "tm-runner-pick", onChange: (e) => team.pickRunner(e.target.value) }, rv.choices.map((c) => h("option", { value: c.id, selected: c.id === rv.pickedId }, c.name)))) : null,
    h("p", { class: "tm-muted", "data-testid": "tm-runner-status", "data-kind": rv.status.kind }, rv.status.text),
    rv.connecting ? h("p", { class: "tm-muted", role: "status", "data-testid": "tm-connecting" }, rv.connecting) : null,
    ...(rv.command ? copyBlock(rv.words, rv.command, "tm-bridge-command") : []),
    ...(rv.unnamed ? renameNodes(rv.words) : []),
  ];
  const connectNodes = (c, RUNNER_WORDS) => !RUNNER_WORDS ? [] : [
    h("h3", { class: "tm-sub" }, RUNNER_WORDS.connectTitle),
    c.failed ? h("p", { class: "tm-muted", "data-testid": "tm-connect-failed" }, RUNNER_WORDS.unknown) : null,
    c.empty ? h("p", { class: "tm-muted", "data-testid": "tm-connect-empty" }, RUNNER_WORDS.noRunners) : null,
    c.empty ? h("button", { type: "button", class: "tm-btn", "data-testid": "tm-open-runners", onClick: () => window.FULCWM && window.FULCWM.open("runners") }, RUNNER_WORDS.openRunners) : null,
    c.rows.length ? h("ul", { class: "tm-list", role: "list", "data-testid": "tm-connect-rows" }, c.rows.map((r) =>
      h("li", { class: "tm-item", "data-testid": "tm-connect-row", "data-bridged": r.bridged ? "true" : "false" },
        h("bdi", { "data-testid": "tm-connect-name" }, r.name), " · ", r.state, " · ", r.seen, h("br"), h("span", { "data-testid": "tm-connect-bridge" }, r.bridge)))) : null,
    c.rows.length && !c.rows.some((r) => r.bridged) ? h("p", { class: "tm-muted", "data-testid": "tm-connect-fill" }, c.command ? RUNNER_WORDS.fillIn : RUNNER_WORDS.noRepoName) : null,
    ...(c.command && c.rows.length && !c.rows.some((r) => r.bridged) ? copyBlock(RUNNER_WORDS, c.command, "tm-connect-command") : []),
    ...(c.rows.some((r) => r.unnamed) ? renameNodes(RUNNER_WORDS) : []),
  ];
  // The Connect panel keeps one element for good and is redrawn on its own, so the sheet's boxes are never rebuilt when its answer arrives.
  const bridgeBox = h("div", { class: "tm-sheet-part", "data-testid": "tm-bridge-box" });
  // One-click Connect: every sentence and every button comes from the view; a folder the runner offered is drawn as text, never as a link.
  const folderBox = (b, preId) => {
    const out = h("pre", { class: "tm-code", tabindex: "0", "aria-label": "Command to run", "data-testid": preId }, b.command);
    const input = h("input", { type: "text", class: "tm-input", "data-testid": "tm-bridge-folder", "aria-label": b.words.giveFolder, placeholder: b.words.folderHint, autocomplete: "off", spellcheck: "false",
      onInput: (e) => { out.textContent = b.commandFor(e.target.value.trim()) || b.command; } });
    return [h("label", { class: "tm-check" }, h("span", null, b.words.giveFolder + ": "), input), out];
  };
  const pickList = (b) => h("ul", { class: "tm-list", role: "list", "data-testid": "tm-bridge-folders" }, b.rows.map((r) =>
    h("li", { class: "tm-item", "data-testid": "tm-bridge-folder-row" },
      h("label", { class: "tm-check" },
        h("input", { type: "radio", name: "tm-bridge-folder", value: r.path, checked: r.picked, "data-focus": "bridge-folder-" + r.label, onChange: () => team.bridge.pickRoot(r.path) }),
        h("bdi", { "data-testid": "tm-bridge-folder-label" }, r.label)))));
  const bridgeButton = (testid, label, enabled, run, focus) => h("button", { type: "button", class: "tm-btn", "data-testid": testid, "data-focus": focus || testid, "aria-disabled": enabled ? null : "true", onClick: () => { if (enabled) { want = focus || testid; run(); } } }, label);
  const copyDetails = (b, code) => {
    const say = h("span", { class: "tm-muted", role: "status", "data-testid": "tm-bridge-details-note" });
    return [h("button", { type: "button", class: "tm-btn", "data-testid": "tm-bridge-details", onClick: async () => {
      try { await navigator.clipboard.writeText(code); say.textContent = b.words.detailsCopied; } catch { say.textContent = b.words.detailsFailed; } // fx-swallow-ok: no clipboard here; the note says so and the code is shown for copying by hand
    } }, b.words.copyDetails), say, h("code", { class: "tm-code", tabindex: "0", "aria-label": "Details", "data-testid": "tm-bridge-code" }, code)];
  };
  function bridgeNodes(b) {
    if (!b || b.kind === "none") return [];
    const ok = !b.busy;
    const head = [h("h3", { class: "tm-sub" }, b.words.title), b.notice ? h("p", { class: "tm-muted", role: "status", "data-testid": "tm-bridge-notice" }, b.notice) : null];
    const text = (extra) => h("p", Object.assign({ "data-testid": "tm-bridge-text" }, extra || {}), b.text);
    const retry = b.retry ? [bridgeButton("tm-bridge-retry", b.words.tryAgain, ok, () => team.bridge.connect())] : [];
    const picked = b.rows ? b.rows.some((r) => r.picked) : false;
    const wrap = (...kids) => [...head, h("div", { "data-testid": "tm-bridge", "data-state": b.kind }, ...kids.flat().filter(Boolean))];
    const cmd = (id) => copyBlock(b.words, b.command, id);
    switch (b.kind) {
      case "unknown": return wrap(h("p", { class: "tm-muted", "data-testid": "tm-bridge-text" }, b.text));
      case "connected": return wrap(text(), h("p", { class: "tm-muted", "data-testid": "tm-bridge-tip" }, b.tip), b.canDisconnect ? bridgeButton("tm-bridge-disconnect", b.words.disconnect, ok, () => team.bridge.disconnect()) : null);
      case "disconnect_failed": return wrap(text({ role: "status" }), b.canDisconnect ? bridgeButton("tm-bridge-disconnect", b.words.disconnect, ok, () => team.bridge.disconnect()) : null);
      case "connecting": case "disconnecting":
        return wrap(h("p", { role: "status", "data-testid": "tm-bridge-text" }, h("span", { class: "tm-spin", "aria-hidden": "true" }), " ", b.text), b.cancelId ? bridgeButton("tm-bridge-cancel", b.words.cancel, ok, () => team.bridge.cancel(b.cancelId)) : null);
      case "slow": return wrap(text({ role: "status" }), ...(b.cancelId ? [bridgeButton("tm-bridge-cancel", b.words.cancel, ok, () => team.bridge.cancel(b.cancelId))] : []), ...retry, ...(b.command ? cmd("tm-bridge-fallback") : []));
      case "disconnect_refused": return wrap(text({ role: "status" }), b.canDisconnect ? bridgeButton("tm-bridge-disconnect", b.words.disconnect, ok, () => team.bridge.disconnect()) : null);
      case "not_found": return wrap(text(), b.skipped ? h("p", { class: "tm-muted", "data-testid": "tm-bridge-skipped" }, b.skipped) : null,
        b.rows.length ? h("ul", { class: "tm-list", role: "list", "data-testid": "tm-bridge-skipped-folders" }, b.rows.map((r) => h("li", { class: "tm-item" }, h("bdi", { "data-testid": "tm-bridge-folder-label" }, r.label)))) : null, ...retry, ...(b.folderBox ? folderBox(b, "tm-bridge-fallback") : cmd("tm-bridge-fallback")));
      case "ambiguous": case "incomplete": return wrap(text(), b.rows.length ? pickList(b) : null, b.canPick ? bridgeButton("tm-bridge-connect-this", b.words.connectThis, ok && picked, () => team.bridge.connect()) : null);
      case "refused": return wrap(text(), ...copyDetails(b, b.code), ...retry, ...(b.command ? cmd("tm-bridge-fallback") : []));
      case "fallback": return wrap(text(), ...(b.folderBox ? folderBox(b, "tm-bridge-fallback") : cmd("tm-bridge-fallback")));
      default: // idle
        return wrap(b.choices.length > 1 ? h("label", { class: "tm-check" }, h("span", null, b.words.pickRunner + " "),
          h("select", { class: "tm-select", "data-testid": "tm-bridge-runner", "data-focus": "bridge-runner", onChange: (e) => team.bridge.pickRunner(e.target.value) }, b.choices.map((c) => h("option", { value: c.id, selected: c.id === b.picked }, c.name)))) : null,
          b.canEdit ? bridgeButton("tm-bridge-connect", b.words.connect, ok && b.canConnect, () => team.bridge.connect()) : h("p", { class: "tm-muted", "data-testid": "tm-bridge-readonly" }, b.words.readOnly));
    }
  }
  const closeConfirm = () => { want = "delete"; team.cancelDelete(); };
  // The sheet is three parts, each redrawn only when its own data changes. The switch and the repository boxes sit in parts the runner list never touches, so the runner
  // module or the runner list arriving late cannot replace a box under a tap that is already half done.
  const sheetHead = h("div", { class: "tm-sheet-part" }), sheetRunner = h("div", { class: "tm-sheet-part" }), sheetRepos = h("div", { class: "tm-sheet-part" });
  sheet.replaceChildren(sheetHead, sheetRunner, bridgeBox, sheetRepos); // the Connect panel is a part of its own between the runner and the repos; its children take the same 8 px top margin as every part's
  function paintSheet(s) {
    const can = s.canEdit && !s.saving;
    const ro = s.canEdit ? null : "tm-ro";
    swap("sheet:head", sheetHead, { w: s.watch, can, ro, r: s.readOnly }, () => [
      s.readOnly ? h("p", { class: "tm-muted", id: "tm-ro", "data-testid": "tm-readonly" }, s.readOnly) : null,
      switchRow("tm-watch", s.runner.label, s.watch, can, ro),
    ]);
    // The switch's words change when the runner arrives, so they are set on the span and the box stays.
    const words = sheetHead.querySelector("[data-part='watch-words']");
    if (words) setText(words, s.runner.label);
    swap("sheet:runner", sheetRunner, s.runner, () => [...runnerNodes(s.runner), ...connectNodes(s.runner.connect, s.runner.words)]);
    swap("sheet:repos", sheetRepos, { repos: s.repos, can, ro, c: s.canEdit, d: s.confirmDelete, s: s.saving }, () => [
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
    ]);
  }

  // Each panel is built once: a header and a body, each redrawn only when its own data changes, so a refresh never resets the log's scroll position or takes focus from a button.
  const panel = (key, testid) => { const hd = h("div", { class: "tm-panel-head" }), body = h("div", { class: "tm-panel-body" }); return { hd, body, el: h("section", { class: "tm-panel tm-panel-" + key, "data-testid": testid }, hd, body) }; };
  const P = { agents: panel("agents", "tm-agents"), lanes: panel("lanes", "tm-lanes"), plan: panel("plan", "tm-plan"), stats: panel("stats", "tm-stats"), usage: panel("usage", "tm-usage"), log: panel("log", "tm-log") };
  const TITLE = { agents: "Agents", lanes: "Merge lane", plan: "Plan", stats: "Stats", usage: "Cost", log: "Log" };
  // The agents heading can take focus: the stop question hands it back there when the agent it asked about goes away.
  const headNodes = (k, p) => [h("h3", { class: "tm-sub", tabindex: k === "agents" ? "-1" : null, "data-focus": k === "agents" ? "agents-head" : null }, TITLE[k]), h("span", { class: "tm-asof", "data-testid": "tm-" + k + "-asof" }, p.asOf), p.warn ? h("span", { class: "tm-warn", "data-testid": "tm-" + k + "-warn" }, p.warn) : null];
  const failedP = (k) => h("p", { class: "tm-muted", "data-testid": "tm-" + k + "-failed" }, WORDS.panelFailed);
  const dLink = (n, href) => (n ? link(href, "D#" + n, { "data-testid": "tm-d" }) : null);
  const list = (rows, build, extra) => h("ul", { class: "tm-list", role: "list", ...extra }, rows.map(build));
  const closeStop = (id) => { want = "stop-" + id; ops.cancelStop(); };
  const stopButton = (a) => a.stop.pending
    ? h("button", { type: "button", class: "tm-btn tm-stop", "aria-disabled": "true", "data-testid": "tm-stop", "data-focus": "stop-" + a.stopId, "aria-label": "Stop requested for " + a.who + ". " + OP_WORDS.stopPending }, "Stop requested")
    : gated({ class: "tm-btn tm-stop", "data-testid": "tm-stop", "data-focus": "stop-" + a.stopId, "aria-label": OP_WORDS.stop + " " + a.who }, () => { want = "stop-cancel"; ops.askStop(a.stopId); if (!team.state.op.confirmStop) want = null; }, OP_WORDS.stop);
  const agentsBody = (p) => (p.failed ? failedP("agents")
    : p.rows.length === 0 ? h("p", { class: "tm-muted", "data-testid": "tm-agents-empty" }, p.empty)
    : list(p.rows, (a) => h("li", { class: "tm-item", "data-testid": "tm-agent", "data-state": a.state },
        h("strong", { class: "tm-role" }, h("bdi", null, a.role)), " ", dLink(a.discussion, a.link), a.discussion ? " " : null, h("span", { class: "tm-mode" }, a.mode), " ", h("span", { class: "tm-state", "data-testid": "tm-agent-text" }, a.text), a.stop ? stopButton(a) : null)));
  const laneItem = (l) =>
    h("li", { class: "tm-item", "data-testid": "tm-lane", "data-pr": String(l.pr) },
      link(l.prLink, "PR #" + l.pr, { "data-testid": "tm-pr" }), " ", dLink(l.discussion, l.discussionLink), l.discussion ? " " : null, h("span", { class: "tm-state", "data-testid": "tm-lane-state" }, l.state),
      l.gates.length ? h("ul", { class: "tm-gates", role: "list" }, l.gates.map((g) => h("li", { class: "tm-gate", "data-testid": "tm-gate", "data-result": g.result }, g.gate + ": " + g.result))) : null);
  const lanesBody = (p) => (p.failed ? failedP("lanes")
    : [p.open.length === 0 ? h("p", { class: "tm-muted", "data-testid": "tm-lanes-empty" }, p.empty) : list(p.open, laneItem),
       p.merged.length ? h("div", { "data-testid": "tm-merged" }, h("h4", { class: "tm-sub" }, WORDS.mergedToday), list(p.merged, laneItem)) : null]);
  // A control that has nothing to do keeps its place and says so (aria-disabled), so focus never lands on a button that vanished.
  const pageBtn = (testid, focus, label, enabled, run) => h("button", { type: "button", class: "tm-btn", "data-testid": testid, "data-focus": focus, "aria-disabled": enabled ? "false" : "true", onClick: () => { if (enabled) { want = focus; run(); } } }, label);
  function planBody(p) {
    if (p.failed) return failedP("plan");
    if (p.none) return h("p", { class: "tm-muted", "data-testid": "tm-plan-none" }, p.notSynced);
    const v = p.view;
    return [
      v.title ? h("p", { class: "tm-muted", "data-testid": "tm-plan-date" }, v.title) : null,
      v.items.length === 0 ? h("p", { class: "tm-muted", "data-testid": "tm-plan-empty" }, v.empty) : list(v.items, (i) => h("li", { class: "tm-item", "data-testid": "tm-plan-item" }, i.ordinal ? i.ordinal + ". " : null, dLink(i.discussion, i.link), " ", h("span", { class: "tm-state" }, i.state))),
      v.hasRows ? h("h4", { class: "tm-sub" }, WORDS.roadmap) : null,
      v.hasRows ? list(v.rows, (r) => h("li", { class: "tm-item", "data-testid": "tm-roadmap-row" }, h("strong", { class: "tm-role" }, h("bdi", null, r.key)), " ", dLink(r.discussion, r.link), r.discussion ? " " : null, h("span", { class: "tm-state" }, r.status), r.counts ? " · " : null, r.counts ? h("span", { "data-testid": "tm-roadmap-counts" }, r.counts) : null), { class: "tm-list tm-roadmap" }) : null,
      v.span ? h("div", { class: "tm-pager" }, pageBtn("tm-plan-prev", "plan-prev", WORDS.prev, v.hasPrev, () => team.planPage(-1)), h("span", { class: "tm-muted", "data-testid": "tm-plan-span" }, v.span), pageBtn("tm-plan-next", "plan-next", WORDS.next, v.hasNext, () => team.planPage(1))) : null,
    ];
  }
  // A figure's "(from N events)" is a button that opens what the server knows of those events (kinds, count, event numbers per session); focus stays on it when the list opens.
  const fromBtn = (r) => h("button", { type: "button", class: "tm-btn", "data-testid": "tm-stat-from", "data-focus": "prov-" + r.id, "aria-expanded": r.open ? "true" : "false", "aria-controls": "tm-prov-" + r.id, onClick: () => { want = "prov-" + r.id; team.toggleProv(r.id); } }, r.from.trim());
  function statsBody(p) {
    if (p.failed) return failedP("stats");
    return [list(p.view.rows, (r) => h("li", { class: "tm-item", "data-testid": "tm-stat" }, h("strong", { class: "tm-role" }, r.label), ": ", h("bdi", null, r.value), r.prov ? [" ", fromBtn(r), h("ul", { class: "tm-list tm-prov", role: "list", id: "tm-prov-" + r.id, hidden: !r.open, "data-testid": "tm-stat-prov" }, r.prov.map((line) => h("li", null, line)))] : r.from)), p.view.window ? h("p", { class: "tm-muted", "data-testid": "tm-stats-window" }, p.view.window) : null];
  }
  // The cost panel draws the server's figures as sent (the shared formatter made the strings); a row with no figure says why in words.
  function usageBody(p) {
    if (p.failed) return failedP("usage");
    const v = p.view;
    return [h("p", { "data-testid": "tm-usage-headrow" }, h("strong", { class: "tm-role" }, v.headlineLabel), ": ", h("span", { "data-testid": "tm-usage-headline" }, v.headline)),
      v.window ? h("p", { class: "tm-muted", "data-testid": "tm-usage-window" }, v.window) : null,
      v.rows.length === 0 ? h("p", { class: "tm-muted", "data-testid": "tm-usage-empty" }, v.empty) : list(v.rows, (r) => h("li", { class: "tm-item", "data-testid": "tm-usage-row" }, h("bdi", null, r.label), ": ", h("span", { "data-testid": "tm-usage-value" }, r.value))),
      v.more ? h("p", { class: "tm-muted", "data-testid": "tm-usage-more" }, v.more) : null];
  }
  // The log: one scrolling list kept for good (its rows are swapped in place), with the note, the failure line and the two buttons around it.
  // data-preview-keep: a window preview (dock hover, Alt+Tab) keeps only the first 30 of the up to 400 rows.
  const logList = h("ul", { class: "tm-list tm-scroll", role: "list", tabindex: "0", "data-testid": "tm-log-list", "data-preview-keep": "30" });
  const logTop = h("div"), logBar = h("div", { class: "tm-pager" }), logHeld = h("div", { "data-testid": "tm-log-held-box" });
  P.log.body.replaceChildren(logTop, logHeld, logList, logBar);
  const logItem = (l) => h("li", { class: "tm-item", "data-testid": "tm-log-line", "data-id": l.id },
    h("span", { class: "tm-time" }, l.time), " ", h("strong", { class: "tm-role" }, h("bdi", null, l.role)), " ", h("span", { class: "tm-cat" }, l.category),
    l.discussion ? " " : null, dLink(l.discussion, l.discussionLink), l.pr ? " " : null, l.pr ? link(l.prLink, "PR #" + l.pr, { "data-testid": "tm-log-pr" }) : null);
  // The rows are brought up to date without rebuilding the list: lines that left the top are removed, lines already drawn stay, and new lines are added a few at a
  // time with a turn given back to the page between groups, so no single task is long on a slow phone (the list holds up to 400 rows). The first group is drawn at once,
  // so a short list is complete the moment the call returns. A newer call stops the one still adding rows and works from whatever is drawn by then.
  const LOG_CHUNK = 40;
  // A drawn row carries the text of the line it shows as a plain property (fxSig). A WeakMap keyed by 400 DOM nodes made every full garbage collection mark ephemerons for them, which was most of the longest task on a slow machine.
  let logSig = "", logJob = 0;
  const giveTurn = () => (globalThis.scheduler && typeof globalThis.scheduler.yield === "function" ? globalThis.scheduler.yield() : new Promise((r) => setTimeout(r, 0)));
  const drawRow = (l, sig) => { const li = logItem(l); li.fxSig = sig; return li; };
  function syncLogRows(rows, kept) {
    const sigs = rows.map((r) => JSON.stringify(r));
    const all = sigs.join("\n");
    if (all === logSig) return;
    logSig = all;
    const job = ++logJob;
    const have = [...logList.children];
    // Drawn rows that stay: a run of `keep` rows from drawn row `drop`, the same lines in the same order as the new list from its row `front` on. Drawn rows outside
    // the run are removed; rows before `front` are new lines at the top (put in before the kept ones); the rows after the run are added in groups below.
    let drop = -1, front = 0, keep = 0;
    const firstAt = new Map(); // a line's text -> its first row in the new list, so each drawn row is looked up once instead of scanning the whole list for it
    for (let i = sigs.length - 1; i >= 0; i--) firstAt.set(sigs[i], i);
    for (let d = 0; d < have.length && drop < 0; d++) {
      const sig = have[d].fxSig, f = firstAt.has(sig) ? firstAt.get(sig) : -1;
      const run = Math.min(have.length - d, sigs.length - f);
      if (f >= 0 && f <= LOG_CHUNK && have.slice(d, d + run).every((li, i) => li.fxSig === sigs[f + i])) { drop = d; front = f; keep = run; }
    }
    const hadFocus = logList.contains(document.activeElement);
    for (const li of drop < 0 ? have : [...have.slice(0, drop), ...have.slice(drop + keep)]) li.remove();
    if (hadFocus && !logList.contains(document.activeElement)) heading.focus();
    // dom-insert-ok: drawRow() returns h() nodes
    if (front > 0) logList.prepend(...rows.slice(0, front).map((r, i) => drawRow(r, sigs[i])));
    let at = front + keep;
    // The row the person was reading stays where it was. It is put back as soon as it is drawn and the rows drawn reach far enough, and again after each later group until it holds.
    let placed = !kept;
    const place = () => {
      if (!kept) return;
      const el = [...logList.children].find((r) => r.getAttribute("data-id") === kept.id);
      if (!el) return;
      const want = el.offsetTop - kept.at;
      logList.scrollTop = want;
      placed = Math.abs(logList.scrollTop - want) < 1; // the list can only scroll as far as the rows drawn so far reach
    };
    const add = (upTo) => {
      const end = Math.min(rows.length, Math.max(at + LOG_CHUNK, upTo));
      // dom-insert-ok: drawRow() returns h() nodes
      logList.append(...rows.slice(at, end).map((r, i) => drawRow(r, sigs[at + i])));
      at = end;
    };
    // A rebuild draws its first group through the row being read, so that row is there to be put back.
    add(drop < 0 && kept ? rows.findIndex((r) => r.id === kept.id) + 1 : 0);
    place();
    if (at >= rows.length) return;
    (async () => { while (at < rows.length) { await giveTurn(); if (job !== logJob || ac.signal.aborted) return; add(0); if (!placed) place(); } })();
  }
  function paintLog(p) {
    // Lines the runner holds back: counted by the cloud, and "Load older" asks the machine for the ones before the oldest it has uploaded.
    swap("p:log-held", logHeld, p.held, () => (p.held ? [h("p", { class: "tm-muted", "data-testid": "tm-log-held" }, p.held.text, " ",
      h("button", { type: "button", class: "tm-btn", "data-testid": "tm-log-held-older", "data-focus": "log-held-older", onClick: () => team.watch.older(p.held.oldest) }, p.held.button)),
      p.held.note ? h("span", { class: "tm-muted", role: "status", "data-testid": "tm-log-held-note" }, p.held.note) : null] : null));
    swap("p:log-top", logTop, [p.failed, p.rows.length, p.empty, p.note], () => [h("p", { class: "tm-muted", "data-testid": "tm-log-note" }, p.note), p.failed ? failedP("log") : p.rows.length === 0 ? h("p", { class: "tm-muted", "data-testid": "tm-log-empty" }, p.empty) : null]);
    logList.hidden = p.failed || p.rows.length === 0;
    logList.setAttribute("aria-label", p.label);
    // The rows are swapped in place; the row the person was reading stays where it was, however many rows left the top.
    const rows = [...logList.children];
    const top = rows.find((r) => r.offsetTop + r.offsetHeight > logList.scrollTop);
    const kept = top ? { id: top.getAttribute("data-id"), at: top.offsetTop - logList.scrollTop } : null;
    syncLogRows(p.rows, kept);
    swap("p:log-bar", logBar, [p.older, p.canOlder, p.olderFailed, p.newest], () => [
      pageBtn("tm-log-older", "log-older", p.older, p.canOlder, () => team.loadOlder()),
      p.newest ? pageBtn("tm-log-newest", "log-newest", p.newest, true, () => team.newest()) : null,
      p.olderFailed ? h("span", { class: "tm-muted", "data-testid": "tm-log-older-failed" }, p.olderFailed) : null]);
  }
  logList.addEventListener("scroll", () => { if (logList.scrollTop + logList.clientHeight >= logList.scrollHeight - 48) team.loadOlder(); });

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
      hl.by ? h("p", { class: "tm-halt-by", "data-testid": "tm-halt-by" }, hl.by.parts.map((p) => (typeof p === "string" ? p : h("bdi", null, p.bdi)))) : null,
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
  // A stop that did not finish: the chip, and one row (sentence, Try again, what was answered). The click is `() => retry()`, so no event reaches the controller.
  const retry = () => { want = "stop-retry"; ops.retryStop(); };
  function paintStop(sf) {
    stopBox.hidden = stopChip.hidden = !sf;
    const chipText = sf ? sf.chip : "";
    if (stopChip.dataset.stop !== chipText) {
      stopChip.dataset.stop = chipText;
      stopChip.replaceChildren(...(chipText ? [h("span", { class: "tm-vh" }, STOP_WORDS.chipContext), chipText] : []));
    }
    if (!sf && want === "stop-retry") want = null; // the row is gone (the stop was asked again): nothing to put focus back on
    swap("stopfail", stopBox, sf, () => (sf ? stopFailNodes(sf, () => retry()) : null));
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
      runner.replaceChildren(...(d.runner ? ["Runner: ", h("bdi", null, d.runner)] : []), ...(d.rv.connecting ? [d.runner ? " · " : "", h("span", { "data-testid": "tm-connecting-bar" }, d.rv.connecting)] : []));
    }
    // The live view: one status word (Live, Connecting, Updated <time>, Updating every minute); a sentence when the machine is offline, the plan's watchers are all taken, or the view ended, with Try again where a click can ask once more.
    const wv = hasRepos ? d.watch : null;
    watchBar.hidden = !wv;
    swap("watch", watchBar, wv, () => (wv ? [h("span", { class: "tm-pill", "data-testid": "tm-watch-pill", "data-state": wv.state }, wv.pill),
      wv.banner ? h("span", { class: "tm-watch-note", role: "status", "data-testid": "tm-watch-" + (wv.state === "cap" ? "cap" : wv.state === "offline" ? "offline" : "note") }, " " + wv.banner) : null,
      wv.retry ? h("button", { type: "button", class: "tm-btn", "data-testid": "tm-watch-retry", "data-focus": "watch-retry", onClick: () => { want = "watch-retry"; team.watch.again(); } }, wv.retry) : null] : null));
    setText(banner, hasRepos ? d.banner : "");
    banner.hidden = !(hasRepos && d.banner);
    notices.hidden = !(hasRepos && d.notices.length);
    swap("notices", notices, hasRepos ? d.notices : [], () => (hasRepos ? d.notices : []).map((n) => h("li", { class: "tm-notice", "data-testid": "tm-notice" }, n)));
    setText(note, d.refreshFailed || "");
    note.hidden = !d.refreshFailed;
    sheet.hidden = !(d.sheet && d.sheet.open);
    if (d.sheet) paintSheet(d.sheet);
    swap("bridge", bridgeBox, d.bridge || null, () => bridgeNodes(d.bridge));
    // Said once, when it changes: a poll that finds the same banner or the same failure says nothing. A notice is cleared when a save starts, so the same sentence again is a change.
    const o = d.operate && d.operate.show ? d.operate : null;
    const broken = hasRepos ? Object.keys(TITLE).filter((k) => d[k].failed && d.failedKeys.includes(k)).map((k) => TITLE[k] + " panel couldn't be read.").join(" ") : ""; // a panel that fails is announced too, not only drawn; only once a read has reported the failure, so a panel not yet read is not
    const msg = [hear("n", d.sheet ? d.sheet.notice : ""), hear("o", o ? o.notice : ""), outcomeWords(o && o.commands), hear("w", d.halt ? d.halt.note : ""), haltWords(d.halt || null), hear("s", d.stopFail ? d.stopFail.note : ""), hear("b", hasRepos ? d.banner : ""), hear("r", d.refreshFailed || ""), hear("l", hasRepos ? d.log.said : ""), hear("f", broken), hear("g", hasRepos ? d.log.olderFailed : "")].filter(Boolean).join(" ");
    if (msg) live.replaceChildren(h("span", null, msg));
    swap("body", body, d.kind === "ready" ? { k: "ready" } : { k: d.kind, c: d.sheet && d.sheet.canEdit, w: d.sheet && d.sheet.watch, s: d.sheet && d.sheet.saving, r: d.rv }, () => {
      if (d.kind === "ready") {
        for (const k of [...sig.keys()]) if (k.startsWith("p:")) sig.delete(k); // the panels are drawn into a fresh page, so every part draws again
        return h("div", { class: "tm-panels" }, ...Object.values(P).map((x) => x.el));
      }
      if (d.kind === "off") return [h("p", { class: "tm-muted", "data-testid": "tm-off" }, d.text), d.sheet.canEdit ? switchRow("tm-watch-off", d.rv.label, false, !d.sheet.saving) : null, ...runnerNodes(d.rv)];
      if (d.kind === "norepos") return [h("p", { class: "tm-muted", "data-testid": "tm-norepos" }, d.text), h("p", { class: "tm-muted", "data-testid": "tm-watch-on-note" }, WORDS.noReposOn),
        d.sheet.canEdit ? switchRow("tm-watch-off", d.rv.label, true, !d.sheet.saving) : null,
        h("button", { type: "button", class: "tm-btn", "data-testid": "tm-open-settings", onClick: () => { if (!team.state.sheetOpen) team.toggleSheet(); /* live state: this node is not rebuilt when Settings opens or closes */ } }, WORDS.openSettings), ...runnerNodes(d.rv)];
      return h("p", { class: d.kind === "error" ? "tm-error" : "tm-muted", role: d.kind === "error" ? "alert" : "status", "data-testid": "tm-" + d.kind }, d.text);
    });
    if (d.kind === "ready") {
      const bodies = { agents: agentsBody, lanes: lanesBody, plan: planBody, stats: statsBody, usage: usageBody };
      for (const k of Object.keys(bodies)) {
        const { asOf, warn, ...data } = d[k]; // the header has its own signature: a new "as of" time alone must not rebuild the body and drop focus from a link in it
        swap("p:" + k + "-h", P[k].hd, [asOf, warn], () => headNodes(k, d[k]));
        swap("p:" + k, P[k].body, data, () => bodies[k](d[k]));
      }
      swap("p:log-h", P.log.hd, [d.log.asOf, d.log.warn], () => headNodes("log", d.log));
      paintLog(d.log);
    }
    paintOperate(o);
    paintHalt(d.halt || null);
    paintStop(d.stopFail || null);
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

  for (const ev of ["pointerdown", "keydown", "wheel"]) root.addEventListener(ev, () => team.watch.touch(), { passive: true, signal: ac.signal }); // real input keeps the live view's idle clock running
  paint();
  team.load();
  team.start({ subscribe: onRefresh, listen: on, hidden: () => document.hidden, visibility: onVisible });
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
