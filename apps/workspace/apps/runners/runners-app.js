// D#845 MC-10a: the app is now Machines, with three tabs: Machines (what each machine is and what it runs), Servers (MC-10b) and Fleet (the page below).
// D#605 FL-9: the Runners app, the fleet page. One row per runner with its state, version, current runs, capacity, last check-in, repos, credential
// mode, labels and facts; the controls the caller is offered (each disabled one shows its reason); the account line; and the "Add a runner" sheet.
//
// The words and every decision come from GET /api/runners (runners-fleet.js words them). Every node is built with h(), so server text renders as text.
// Controls use aria-disabled, not disabled, so a pressed control keeps focus while its request is in flight, and a second press is ignored.
// After a dialog closes, focus goes back to the control that opened it, found by id because the list is rebuilt after every read.
import { h, timeNode } from "../_lib/dom.js";
import { onRefresh } from "../../core/cloud-live.js";
import {
  CHECK_READ_FAILED, SANDBOX_ACTION, MODE_WORDS, ONLY_ADMINS, TTL_CHOICES, FLEET_REFRESH_MS, accountText, agoText, capacityText, controlList, createAdder, createFleet, factsText, NO_PREFLIGHT, PREFLIGHT_OK, preflightLines, heldBackText, loadRepoChoices, provText, runnerLimitText, sandboxCommandText, sandboxConfirm, sandboxControls, sandboxLine, sandboxQuotaLines, sandboxStatusText, stateParts, versionText,
  KVM_NOTE, MACHINES_UNAVAILABLE, NO_MACHINES, ONLY_ADMINS_ADD, TABS, addSteps, createMachines, tierText, needsVmInstall, vmInstallLine, VM_INSTALL_COMMAND, needsVmToken, VM_TOKEN_COMMAND, VM_TOKEN_LINE, VM_TOKEN_STAYS,
  BILLED_BY, CONNECT_FIRST, HETZNER_REFUSED, HETZNER_STEPS, ONLY_ADMINS_CREATE, ONLY_ADMINS_HETZNER, ONLY_ADMINS_SEE, PRICES_FAILED, SLOW_DOWN, TIER_NOTICE, availableIn, connectedText, createCreator, createSentence, createServers, offeredIn, priceLine, specsText, totalText, unlabelledText,
} from "./runners-fleet.js";
import { LOGOUT_SENTENCE, ONLY_ADMINS_ACT, REBOOT_SENTENCE, SERVER_WORDS, SLOW_WORDS, createSignIn, deleteSentence, isStuck, moveProject, moveTargets, notConnectedYet, orphanSentence, serverAct, serverActions, serverLines } from "./runners-fleet.js";
import { retryWords } from "../_lib/api.js";

const FULC = window.FULC;
if (!FULC || typeof FULC.register !== "function") {
  throw new Error("Runners app: the FULC SDK global is missing");
}

const UNAVAILABLE = "Runners aren't available right now.";
const ADD_ID = "runners-add";
const copyText = async (value) => {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    // fx-swallow-ok: no clipboard here (an insecure page or a refusal); the text stays selectable in the box beside the button
    return false;
  }
};

function mountApp(contentEl) {
  const ac = new AbortController();
  let returnTo = ADD_ID; // the id of the control that opened the dialog now open
  let dialog = null; // { dlg, close }
  let sheetEl = null;
  let tab = "machines";
  let repoChoices = { status: "idle", list: [] };
  const rowErrors = new Map();
  let serversWaiting = false; // the Servers tab opened before the fleet read said who the caller is
  const fleet = createFleet({ signal: ac.signal, onChange: () => (paint(), serversWaiting && fleet.state.status !== "loading" && ((serversWaiting = false), loadServers())) });
  const machines = createMachines({ signal: ac.signal, onChange: () => paint() });
  const adder = createAdder({ signal: ac.signal, origin: window.location.origin, onChange: () => paintSheet() });
  const servers = createServers({ signal: ac.signal, onChange: () => (paint(), syncConnect && syncConnect()) });
  const creator = createCreator({ signal: ac.signal, onChange: () => paintCreate() });
  let createEl = null; // the create dialog's container, repainted as the catalog and the quote arrive
  let syncConnect = null; // brings the open connect dialog in line with the rate-limit wait
  let created = false; // a create was accepted: the list says so until the next read

  const root = h("div", { class: "runners-app", "data-testid": "runners-app" });
  contentEl.replaceChildren(root);

  const focusId = (id) => {
    const el = id && root.ownerDocument.getElementById(id);
    if (el) el.focus();
  };
  const button = (label, props, onClick) => h("button", { type: "button", class: "runners-btn", ...props, onClick }, label);

  // ── a dialog: a <dialog> opened modally; Escape and Cancel close it; focus returns to `from` ──
  function openDialog({ title, from, body, actions, labelId }) {
    closeDialog();
    returnTo = from;
    const dlg = h("dialog", { class: "runners-dialog", "aria-labelledby": labelId, onCancel: (e) => (e.preventDefault(), closeDialog()) }, h("div", { class: "runners-dialog-body" }, h("h2", { id: labelId, class: "runners-subtitle" }, title), body, h("div", { class: "runners-actions" }, actions)));
    root.ownerDocument.body.appendChild(dlg);
    dlg.showModal();
    dialog = { dlg };
    return dlg;
  }
  function closeDialog() {
    if (!dialog) return;
    const { dlg } = dialog;
    dialog = null;
    sheetEl = null;
    createEl = null;
    syncConnect = null;
    creator.close();
    adder.close(); // the secret goes with the sheet
    dlg.close();
    dlg.remove();
    focusId(returnTo);
  }

  function rename(r) {
    const input = h("input", { type: "text", id: "runners-rename-input", class: "runners-input", maxLength: 64, autocomplete: "off", value: r.hasName ? r.name : "", "aria-describedby": "runners-rename-help" });
    const err = h("p", { class: "runners-error", role: "alert", tabindex: "-1" });
    const save = button("Save name", { "data-testid": "runners-rename-save" }, async () => {
      if (save.getAttribute("aria-disabled") === "true") return;
      save.setAttribute("aria-disabled", "true");
      const said = await fleet.act(r.id, "rename", { name: input.value });
      if (said === "") return closeDialog();
      save.setAttribute("aria-disabled", "false");
      err.textContent = said;
      err.focus();
    });
    // The way back to "Unnamed runner (...)": offered only on a runner that has a name.
    const clear = button("Remove the name", { "data-testid": "runners-rename-clear" }, async () => {
      if (clear.getAttribute("aria-disabled") === "true") return;
      clear.setAttribute("aria-disabled", "true");
      const said = await fleet.act(r.id, "rename", { name: null });
      if (said === "") return closeDialog();
      clear.setAttribute("aria-disabled", "false");
      err.textContent = said;
      err.focus();
    });
    openDialog({
      title: "Rename runner", from: "runners-" + r.id + "-rename", labelId: "runners-rename-h",
      body: h("div", null, h("label", { for: "runners-rename-input" }, "Name"), input, h("p", { id: "runners-rename-help", class: "runners-muted" }, "1 to 64 characters. People see this name in the fleet and when they pick a runner."), err),
      actions: [save, ...(r.hasName ? [clear] : []), button("Cancel", null, closeDialog)],
    });
    input.focus();
  }

  function remove(r) {
    const err = h("p", { class: "runners-error", role: "alert", tabindex: "-1" });
    const yes = button("Remove runner", { "data-testid": "runners-remove-confirm" }, async () => {
      if (yes.getAttribute("aria-disabled") === "true") return;
      yes.setAttribute("aria-disabled", "true");
      const said = await fleet.act(r.id, "remove");
      if (said === "") {
        returnTo = ADD_ID; // the row has no Remove button now
        return closeDialog();
      }
      yes.setAttribute("aria-disabled", "false");
      err.textContent = said;
      err.focus();
    });
    openDialog({
      title: "Remove " + r.name + "?", from: "runners-" + r.id + "-remove", labelId: "runners-remove-h",
      body: h("div", null, h("p", null, "It stops taking work at once and can't be undone. Work it is running is not killed from here; the cloud follows it up. To use the machine again, register it again."), err),
      actions: [yes, button("Cancel", null, closeDialog)],
    });
    focusId("runners-remove-confirm");
  }

  // ── sandboxes (D#587 B-7b-ii): each button enqueues a command; Delete and Reap ask in the page first, never with a browser dialog ──
  function confirmSandbox(r, body, from) {
    const words = sandboxConfirm(body.kind, body.name);
    const err = h("p", { class: "runners-error", role: "alert", tabindex: "-1" });
    const yes = button(words.button, { "data-testid": "runners-sandbox-confirm" }, async () => {
      if (yes.getAttribute("aria-disabled") === "true") return;
      yes.setAttribute("aria-disabled", "true");
      const said = await fleet.act(r.id, SANDBOX_ACTION, body);
      if (said === "") return closeDialog();
      yes.setAttribute("aria-disabled", "false");
      err.textContent = said;
      err.focus();
    });
    openDialog({ title: words.title, from, labelId: "runners-sandbox-h", body: h("div", null, h("p", null, words.body), err), actions: [yes, button("Cancel", { "data-testid": "runners-sandbox-cancel" }, closeDialog)] });
    focusId("runners-sandbox-cancel");
  }
  function sandboxButton(r, c, body, id, pending, label) {
    const off = !c.allowed || pending;
    return h("span", { class: "runners-control" },
      h("button", {
        type: "button", class: "runners-btn", id, "aria-disabled": off ? "true" : "false", "aria-describedby": !c.allowed && c.reason ? id + "-why" : null, "aria-label": label, "data-testid": "runners-sandbox-" + c.action,
        onClick: async () => {
          if (!c.allowed || fleet.isPending(r.id)) return;
          if (c.action !== "stop_sandbox") return confirmSandbox(r, body, id);
          rowErrors.delete(r.id);
          const said = await fleet.act(r.id, SANDBOX_ACTION, body);
          if (said) rowErrors.set(r.id, said);
          paint();
        },
      }, c.label),
      !c.allowed && c.reason ? h("span", { class: "runners-reason runners-muted", id: id + "-why", "data-testid": "runners-reason" }, c.reason) : null);
  }
  function sandboxSection(r, isAdmin, pending) {
    const s = r.sandboxes;
    const now = Date.now();
    const reap = sandboxControls(s, isAdmin);
    return h("section", { class: "runners-sandboxes", "data-testid": "runners-sandboxes", "data-status": s.status, "aria-label": "Sandboxes of " + r.name },
      h("h4", { class: "runners-subtitle" }, "Sandboxes"),
      h("p", { class: "runners-muted", "data-testid": "runners-sandbox-status" }, sandboxStatusText(s, now) || "Not reported yet"),
      s.status === "never" ? null : h("ul", { class: "runners-quota", "data-testid": "runners-sandbox-quota" }, sandboxQuotaLines(s).map((l) => h("li", null, l))),
      s.boxes.length === 0 ? null : h("ul", { class: "runners-boxes", "data-testid": "runners-sandbox-list" }, s.boxes.map((b) => {
        const line = sandboxLine(b, now);
        return h("li", { class: "runners-box", "data-testid": "runners-sandbox" },
          h("strong", null, h("bdi", null, line.name)), " · ", h("span", { "data-testid": "runners-sandbox-state" }, line.state),
          h("div", { class: "runners-muted" }, line.ages), h("div", { class: "runners-muted" }, line.disk),
          h("div", { class: "runners-controls" }, sandboxControls(s, isAdmin, b).map((c) => sandboxButton(r, c, { kind: c.action, name: b.name }, "runners-" + r.id + "-sb-" + b.name + "-" + c.action, pending, c.label + " " + b.name))));
      })),
      s.boxes.length === 0 && s.commands.length === 0 ? null : h("div", { class: "runners-controls" }, sandboxButton(r, reap, { kind: "reap_sandboxes" }, "runners-" + r.id + "-sb-reap", pending, reap.label)),
      s.commands.length === 0 ? null : h("ul", { class: "runners-commands", "data-testid": "runners-sandbox-commands" }, s.commands.map((c) => h("li", { "data-testid": "runners-sandbox-command", "data-state": c.state }, sandboxCommandText(c), " ", c.issued ? [timeNode(c.issued, true)] : ""))));
  }

  // ── the "Add a runner" sheet ──
  function openSheet(from, again) {
    adder.open(again);
    if (repoChoices.status === "idle") {
      repoChoices = { status: "loading", list: [] };
      loadRepoChoices(undefined, ac.signal).then(
        (list) => ((repoChoices = { status: "ready", list }), paintSheet()),
        (e) => e && e.name !== "AbortError" && ((repoChoices = { status: "error", list: [] }), paintSheet())
      );
    }
    sheetEl = h("div", { "data-testid": "runners-sheet" });
    openDialog({ title: "Add a runner", from, body: sheetEl, actions: [], labelId: "runners-sheet-h" });
    paintSheet();
    focusId("runners-sheet-path-code");
  }

  function paintSheet() {
    const s = adder.state;
    if (!sheetEl || !s) return;
    const held = sheetEl.contains(root.ownerDocument.activeElement) ? root.ownerDocument.activeElement.id : "";
    const fleetState = fleet.state.fleet;
    if (!fleetState || !fleetState.isAdmin) {
      sheetEl.replaceChildren(h("p", { class: "runners-muted" }, ONLY_ADMINS), button("Close", { id: "runners-sheet-close" }, closeDialog));
      return;
    }
    if (s.phase === "made") {
      const secretBox = h("input", { type: "text", readOnly: true, id: "runners-secret", class: "runners-input", value: s.made.secret, "aria-label": "Shown once", "data-testid": "runners-secret" });
      const copyBtn = (label, value, id) => button(label, { id }, () => copyText(value));
      sheetEl.replaceChildren(h("div", null,
        h("p", { role: "status" }, s.path === "code" ? "Your one-time code. It works once and expires in 10 minutes." : "Your provisioning token. It works once and is shown only now."),
        secretBox,
        copyBtn("Copy " + (s.path === "code" ? "code" : "token"), s.made.secret, "runners-copy-secret"),
        s.made.expires ? h("p", { class: "runners-muted" }, "Expires ", timeNode(s.made.expires, true)) : null,
        h("p", { class: "runners-muted" }, "On the machine, run this. The secret goes in on standard input, so it never shows in the process list. The leading space keeps most shells from saving the line."),
        h("pre", { class: "runners-code", tabindex: "0", "aria-label": "Register command", "data-testid": "runners-register-command" }, s.made.register),
        copyBtn("Copy command", s.made.register, "runners-copy-command"),
        s.path === "token" ? h("p", { class: "runners-muted" }, "To keep it running after you log out, then run: ") : null,
        s.path === "token" ? h("pre", { class: "runners-code", tabindex: "0", "aria-label": "Service command" }, s.made.service) : null,
        button("Done", { id: "runners-sheet-close", "data-testid": "runners-sheet-done" }, closeDialog)
      ));
      focusId(held || "runners-secret");
      return;
    }
    const sending = s.phase === "sending";
    const radio = (path, label, help) =>
      h("label", { class: "runners-choice", for: "runners-sheet-path-" + path },
        h("input", { type: "radio", name: "runners-path", id: "runners-sheet-path-" + path, value: path, checked: s.path === path, onChange: () => adder.edit({ path }) }),
        h("span", null, h("strong", null, label), " ", h("span", { class: "runners-muted" }, help)));
    const repos = repoChoices.status === "ready" && repoChoices.list.length > 0
      ? repoChoices.list.map((r) => h("label", { class: "runners-choice" }, h("input", { type: "checkbox", id: "runners-repo-" + r.id, checked: s.repoIds.includes(r.id), onChange: (e) => adder.edit({ repoIds: e.target.checked ? [...s.repoIds, r.id] : s.repoIds.filter((x) => x !== r.id) }) }), h("span", null, r.name)))
      : [h("p", { class: "runners-muted" }, repoChoices.status === "error" ? "Repos aren't available right now." : repoChoices.status === "ready" ? "No repos are installed yet. Install one first." : "Loading repos...")];
    const field = (id, label, props) => [h("label", { for: id }, label), h("input", { id, class: "runners-input", autocomplete: "off", ...props })];
    sheetEl.replaceChildren(h("div", null,
      h("fieldset", { class: "runners-fieldset" }, h("legend", null, "How will you register it?"),
        radio("code", "One-time code", "for a machine you are sitting at"), radio("token", "Provisioning token", "for a machine with no browser, such as a server")),
      h("label", { for: "runners-sheet-mode" }, "Credential mode"),
      h("select", { id: "runners-sheet-mode", class: "runners-input", onChange: (e) => adder.edit({ mode: e.target.value }) }, Object.keys(MODE_WORDS).map((m) => h("option", { value: m, selected: s.mode === m }, MODE_WORDS[m]))),
      ...(s.path === "token" ? [
        ...field("runners-sheet-name", "Name (optional)", { type: "text", maxLength: 64, value: s.name, onInput: (e) => adder.edit({ name: e.target.value }, true) }),
        ...field("runners-sheet-labels", "Labels (optional, separated by commas)", { type: "text", value: s.labels, onInput: (e) => adder.edit({ labels: e.target.value }, true) }),
        h("label", { for: "runners-sheet-ttl" }, "Valid for"),
        h("select", { id: "runners-sheet-ttl", class: "runners-input", onChange: (e) => adder.edit({ ttl: Number(e.target.value) }) }, TTL_CHOICES.map((c) => h("option", { value: String(c.seconds), selected: s.ttl === c.seconds }, c.words))),
      ] : []),
      h("fieldset", { class: "runners-fieldset" }, h("legend", null, "Repos it may work on"), ...repos),
      s.error ? h("p", { class: "runners-error", role: "alert", id: "runners-sheet-error", tabindex: "-1" }, s.error) : null,
      h("div", { class: "runners-actions" }, button(sending ? "Making..." : s.path === "code" ? "Make a code" : "Make a token", { id: "runners-sheet-make", "aria-disabled": sending ? "true" : "false", "data-testid": "runners-sheet-make" }, () => adder.submit()), button("Cancel", { id: "runners-sheet-close" }, closeDialog)),
      h("h3", { class: "runners-subtitle" }, "Unused tokens (", String(adder.tokens.list.length), " of ", String(adder.tokens.limit), ")"),
      adder.tokens.status === "error" || adder.tokens.error ? h("p", { class: "runners-error", role: "alert", "data-testid": "runners-tokens-error" }, adder.tokens.error || "Tokens aren't available right now.") : null,
      h("ul", { class: "runners-tokens", "data-testid": "runners-tokens" }, adder.tokens.list.map((t) =>
        h("li", null, h("span", null, t.name, " · ", MODE_WORDS[t.mode] || "", " · by ", t.by, " · expires "), t.expires ? timeNode(t.expires, true) : "", " ",
          button("Revoke", { id: "runners-revoke-" + t.id, "aria-label": "Revoke " + t.name }, async () => {
            await adder.revoke(t.id);
            focusId("runners-sheet-make"); // the revoked token's button is gone
          }))))
    ));
    if (s.error && !held) focusId("runners-sheet-error");
    else if (held) focusId(held);
  }

  // ── the "Add a machine" sheet: two choices (D#845 MC-10a) ──
  function openAddMachine(from) {
    const origin = window.location.origin;
    const steps = addSteps(origin).map((x) => h("li", null, x.text, x.command === null ? null : [h("pre", { class: "runners-code", tabindex: "0", "aria-label": "Command" }, x.command), button("Copy command", null,() => copyText(x.command))]));
    openDialog({
      title: "Add a machine", from, labelId: "runners-addm-h",
      body: h("div", { "data-testid": "runners-addm" },
        h("section", { "aria-labelledby": "runners-addm-own" }, h("h3", { id: "runners-addm-own", class: "runners-subtitle" }, "A computer or server I have"), h("ol", null, steps), h("p", { class: "runners-muted", "data-testid": "runners-addm-kvm" }, KVM_NOTE)),
        h("section", { "aria-labelledby": "runners-addm-hz" }, h("h3", { id: "runners-addm-hz", class: "runners-subtitle" }, "A new Hetzner Cloud server"), h("p", { class: "runners-muted" }, "Hetzner makes the server and bills you directly."),
          button("Open Servers", { id: "runners-addm-servers", "data-testid": "runners-addm-servers" }, () => (closeDialog(), selectTab("servers"), focusId("runners-tab-servers"))))),
      actions: [button("Close", { id: "runners-addm-close" }, closeDialog)],
    });
    focusId("runners-addm-close");
  }

  // ── the tabs ──
  // The Servers reads are made while that tab is showing, so a member (who cannot read the credential) and a page that never opens it ask for nothing.
  function loadServers() {
    const f = fleet.state.fleet;
    if (fleet.state.status === "loading") return void (serversWaiting = true);
    // The credential and the list are owner and admin reads. Only a fleet answer that names an owner or admin asks for them: a member asks for neither, and
    // neither does a page whose fleet read failed (the role is not known), which shows that failure instead.
    if (!f || !f.isAdmin) return;
    servers.loadCredential();
    // A server that waits for a Claude sign-in has its request read once, so a page opened mid-sign-in shows where it is; a live one is then followed by the panel itself.
    servers.loadList().then(() => servers.list.items.filter((s) => s.runnerId && needsSignIn(s)).forEach((s) => signin.load(s.runnerId, s.statusAt)));
  }
  function selectTab(id) {
    tab = id;
    created = false;
    paint();
    if (id === "servers") loadServers();
  }
  const tabBar = () =>
    h("div", { class: "runners-tabs", role: "tablist", "aria-label": "Machines sections" }, TABS.map(([id, label], i) =>
      h("button", {
        type: "button", role: "tab", id: "runners-tab-" + id, class: "runners-btn", "aria-selected": tab === id ? "true" : "false", "aria-controls": "runners-panel", "data-testid": "runners-tab-" + id,
        onClick: () => selectTab(id),
        onKeydown: (e) => {
          const to = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
          if (to === 0) return;
          e.preventDefault();
          selectTab(TABS[(i + to + TABS.length) % TABS.length][0]);
          focusId("runners-tab-" + tab);
        },
      }, label)));
  const panel = (...kids) => h("div", { id: "runners-panel", role: "tabpanel", "aria-labelledby": "runners-tab-" + tab }, ...kids);

  function machineRow(m) {
    return h("li", { class: "runners-row", "data-testid": "runners-machine", "data-state": m.live ? "live" : "offline" },
      h("h3", { class: "runners-name", "data-testid": "runners-machine-name" }, h("bdi", null, m.name)),
      h("p", { class: "runners-state" }, h("span", { "data-testid": "runners-machine-tier" }, tierText(m.tier, m.kvm)), " · ", h("span", { "data-testid": "runners-machine-live" }, m.live ? "Online" : "Offline")),
      h("dl", { class: "runners-facts" }, ...line("Kind", m.kind), ...line(m.tier === "microvm" ? "Claude token" : "Claude", m.claude ? "yes" : "no"), ...line("Capacity", h("span", { "data-testid": "runners-machine-capacity" }, m.running === null ? "Free" : ["Running ", h("bdi", null, m.running)]))),
      needsVmInstall(m.tier, m.kvm) ? h("div", { class: "runners-vminstall", "data-testid": "runners-machine-vminstall" }, h("p", null, vmInstallLine(m.name)),
        h("pre", { class: "runners-code", tabindex: "0", "aria-label": "Command" }, VM_INSTALL_COMMAND), button("Copy command", { "data-testid": "runners-machine-vminstall-copy" }, () => copyText(VM_INSTALL_COMMAND))) : null,
      needsVmToken(m.tier, m.claude) ? h("div", { class: "runners-vmtoken", "data-testid": "runners-machine-vmtoken" }, h("p", null, VM_TOKEN_LINE), h("p", { class: "runners-muted" }, VM_TOKEN_STAYS),
        h("pre", { class: "runners-code", tabindex: "0", "aria-label": "Command" }, VM_TOKEN_COMMAND), button("Copy command", { "data-testid": "runners-machine-vmtoken-copy" }, () => copyText(VM_TOKEN_COMMAND))) : null);
  }
  function paintMachines() {
    const f = fleet.state.fleet;
    const s = machines.state;
    const body =
      s.status === "loading" ? h("p", { class: "runners-muted", "data-testid": "runners-machines-loading" }, "Loading machines...")
      : s.status === "error" ? h("div", null, h("p", { class: "runners-error", role: "alert", "data-testid": "runners-machines-error" }, MACHINES_UNAVAILABLE), button("Retry", { id: "runners-machines-retry", "data-testid": "runners-machines-retry" }, () => machines.load()))
      : s.list.length === 0 ? h("p", { class: "runners-muted", "data-testid": "runners-machines-empty" }, NO_MACHINES)
      : h("ul", { class: "runners-rows", "data-testid": "runners-machines" }, s.list.map(machineRow));
    const off = !f || !f.isAdmin; // also off while the fleet is still loading: the role is not known yet
    return panel(h("div", { class: "runners-head" }, h("h2", { class: "runners-title" }, "Machines"),
      h("span", { class: "runners-actions" }, button("Refresh", { id: "runners-machines-refresh" }, () => (machines.load(), fleet.load())),
        button("Add a machine", { id: "runners-addm", "aria-disabled": off ? "true" : "false", "aria-describedby": f && off ? "runners-addm-why" : null, "data-testid": "runners-addm-open" }, () => f && f.isAdmin && openAddMachine("runners-addm"))),
      f && off ? h("span", { id: "runners-addm-why", class: "runners-reason runners-muted", "data-testid": "runners-reason" }, ONLY_ADMINS_ADD) : null), body);
  }

  // ── the Servers tab: the Hetzner credential, the create dialog and the list (D#845 MC-10b1) ──
  function connectHetzner(from) {
    const input = h("input", { type: "password", id: "runners-hz-token", class: "runners-input", autocomplete: "off", "aria-describedby": "runners-hz-msg", "data-testid": "runners-hz-token" });
    const msg = h("p", { id: "runners-hz-msg", class: "runners-error", role: "alert", tabindex: "-1", "data-testid": "runners-hz-error" });
    const status = h("p", { class: "runners-muted", role: "status", "data-testid": "runners-hz-status" });
    let sending = false;
    function sync() {
      const w = servers.wait;
      save.setAttribute("aria-disabled", sending || w > 0 ? "true" : "false");
      status.textContent = sending ? "Checking…" : w > 0 ? retryWords(w) : "";
    }
    const save = button("Check and save", { id: "runners-hz-save", "data-testid": "runners-hz-save" }, async () => {
      if (save.getAttribute("aria-disabled") === "true") return;
      const token = input.value.trim();
      input.value = ""; // the box holds the token only until it is sent
      if (token === "") return (msg.textContent = "Paste your Hetzner token first."), msg.focus();
      sending = true;
      msg.textContent = "";
      sync();
      const said = await servers.connect(token);
      sending = false;
      if (said === "") return (returnTo = "runners-srv-create"), closeDialog();
      msg.textContent = said;
      sync();
      msg.focus();
    });
    syncConnect = sync;
    input.addEventListener("keydown", (e) => e.key === "Enter" && save.click());
    openDialog({
      title: "Connect Hetzner", from, labelId: "runners-hz-h",
      body: h("div", { "data-testid": "runners-hz-sheet" }, h("ol", { class: "runners-steps" }, HETZNER_STEPS.map((x) => h("li", null, x))), h("label", { for: "runners-hz-token" }, "Hetzner API token"), input, status, msg),
      actions: [save, button("Cancel", { id: "runners-hz-cancel", "data-testid": "runners-hz-cancel" }, closeDialog)],
    });
    focusId("runners-hz-token");
  }

  function removeHetzner(from) {
    const err = h("p", { class: "runners-error", role: "alert", tabindex: "-1", "data-testid": "runners-hz-remove-error" });
    const yes = button("Remove token", { id: "runners-hz-remove-confirm", "data-testid": "runners-hz-remove-confirm" }, async () => {
      if (yes.getAttribute("aria-disabled") === "true") return;
      yes.setAttribute("aria-disabled", "true");
      const said = await servers.remove();
      if (said === "") return (returnTo = "runners-hz-connect"), closeDialog();
      yes.setAttribute("aria-disabled", "false");
      err.textContent = said;
      err.focus();
    });
    openDialog({
      title: "Remove the Hetzner token?", from, labelId: "runners-hz-remove-h",
      body: h("div", null, h("p", null, "This deletes our copy of the token. Servers already made stay at Hetzner. You can connect a token again at any time."), err),
      actions: [yes, button("Cancel", { id: "runners-hz-remove-cancel" }, closeDialog)],
    });
    focusId("runners-hz-remove-cancel");
  }

  function openCreate(from) {
    created = false;
    createEl = h("div", { class: "runners-create", "data-testid": "runners-create" });
    openDialog({ title: "Create a server", from, body: createEl, actions: [], labelId: "runners-create-h" });
    creator.open();
    paintCreate();
    focusId("runners-create-loc");
  }

  function paintCreate() {
    const c = creator.state;
    if (!createEl || !c) return;
    const held = createEl.contains(root.ownerDocument.activeElement) ? root.ownerDocument.activeElement.id : "";
    const cat = c.catalog;
    const q = c.quote;
    const where = (cat.locations.find((l) => l.name === c.location) || { label: c.location }).label;
    const radio = (t, words, off) =>
      h("label", { class: "runners-choice", for: "runners-size-" + t.name },
        h("input", { type: "radio", name: "runners-size", id: "runners-size-" + t.name, value: t.name, checked: c.type === t.name, disabled: off || c.locked, onChange: () => creator.choose(t.name) }),
        h("span", null, words, off ? " · Not available in " + where : ""));
    const preset = (word, name) => {
      const t = name && cat.types.find((x) => x.name === name);
      return t ? radio(t, word + " · " + t.label + " · " + specsText(t), !availableIn(t, c.location)) : h("p", { class: "runners-muted", "data-testid": "runners-size-none" }, word + ": not available in " + where);
    };
    const rest = cat.types.filter((t) => offeredIn(t, c.location) && t.name !== cat.presets.small && t.name !== cat.presets.medium);
    const loading = cat.status === "loading" || q.status === "loading" || (c.type !== "" && q.status === "idle");
    const ready = !loading && q.status === "ready" && q.available && c.type !== "";
    const price =
      loading ? "Loading price…"
      : q.status === "error" ? [PRICES_FAILED, " ", button("Retry", { id: "runners-create-requote", "data-testid": "runners-create-requote" }, () => creator.requote())]
      : c.type === "" ? "Choose a size."
      : !q.available ? createSentence({ status: 409, code: "hetzner_resource_unavailable" }, where)
      : priceLine(q.price) + ". " + BILLED_BY;
    const said = c.wait > 0 ? SLOW_DOWN + " " + retryWords(c.wait) : c.error;
    const off = !ready || c.sending || c.wait > 0 || c.reused;
    createEl.replaceChildren(h("div", null,
      h("p", { "data-testid": "runners-create-tier" }, TIER_NOTICE),
      cat.status === "error"
        ? h("div", null, h("p", { class: "runners-error", role: "alert", "data-testid": "runners-create-error" }, "Locations couldn't be loaded"), button("Retry", { id: "runners-create-retry", "data-testid": "runners-create-retry" }, () => creator.retry()))
        : h("div", null,
          h("label", { for: "runners-create-loc" }, "Location"),
          h("select", { id: "runners-create-loc", class: "runners-input", "data-testid": "runners-create-loc", disabled: c.locked, onChange: (e) => creator.pick(e.target.value) }, cat.locations.map((l) => h("option", { value: l.name, selected: l.name === c.location }, l.label))),
          h("fieldset", { class: "runners-fieldset" }, h("legend", null, "Size"), preset("Small", cat.presets.small), preset("Medium", cat.presets.medium),
            button(c.all ? "Show fewer types" : "Show all types", { id: "runners-create-all", "aria-expanded": c.all ? "true" : "false", "data-testid": "runners-create-all" }, () => creator.toggleAll()),
            c.all ? h("div", { "data-testid": "runners-create-types" }, rest.map((t) => radio(t, t.label + " · " + specsText(t), !availableIn(t, c.location)))) : null),
          h("p", { class: "runners-price", role: "status", "data-testid": "runners-create-price" }, price)),
      said ? h("p", { class: "runners-error", role: "alert", "data-testid": "runners-create-error" }, said) : null,
      h("div", { class: "runners-actions" },
        button(c.sending ? "Creating…" : ready ? "Create server, " + totalText(q.price) : loading ? "Loading price…" : "Create server", { id: "runners-create-go", "aria-disabled": off ? "true" : "false", "data-testid": "runners-create-go" }, async () => {
          if (off) return;
          const r = await creator.submit();
          // The dialog that sent this may be gone, and another open now: a late answer only reads the list again and never touches the dialog on screen.
          // Made, even when the dialog that sent it was cancelled: the notice shows, and a reopened create dialog (locked to this attempt) closes. Another dialog is left alone.
          if (r.ok) return (created = true), createEl ? ((returnTo = "runners-srv-create"), closeDialog(), servers.loadList()) : (paint(), servers.loadList());
          if (r.stale || r.unknown) return servers.loadList();
          if (["hetzner_unauthorized", "credential_invalid", "not_connected"].includes(r.code)) servers.loadCredential();
        }),
        c.reused ? button("Create a new one", { id: "runners-create-new", "data-testid": "runners-create-new" }, () => creator.startOver()) : null,
        button("Cancel", { id: "runners-create-cancel", "data-testid": "runners-create-cancel" }, closeDialog))));
    if (held) focusId(held);
  }

  // ── D#845 MC-10b2: what each server card adds: its elapsed-time lines, projects, Claude sign-in panel and buttons ──
  const isAdmin = () => !!(fleet.state.fleet && fleet.state.fleet.isAdmin);
  const machineOf = (s) => (s.runnerId ? machines.state.list.find((m) => m.id === s.runnerId) : undefined);
  const offlineOf = (s) => s.state === "ready" && !!machineOf(s) && !machineOf(s).live;
  const rowStatus = (s) => (offlineOf(s) ? SERVER_WORDS.offline : s.status);
  const needsSignIn = (s) => s.state === "needs_claude_login" || (s.state === "ready" && s.claudeIn === "no");
  const notes = new Map(); // a server id: what its last action said, until the next Refresh
  const drafts = new Map(); // a runner id: the code typed so far, kept across repaints
  const signin = createSignIn({ signal: ac.signal, onChange: () => paint() });
  const sid = (s, part) => "runners-srv-" + s.id + "-" + part;
  const note = (s, text, bad) => (notes.set(s.id, { text, bad: !!bad }), paint());

  /** A sheet that says in a plain sentence what pressing the button does and costs. `run` resolves to "" when done, else the sentence to show. */
  function confirmSheet({ from, back, title, body, label, run, done, off }) {
    const err = h("p", { class: "runners-error", role: "alert", tabindex: "-1", "data-testid": "runners-confirm-error" });
    const yes = button(label, { id: "runners-confirm-yes", "aria-disabled": off ? "true" : "false", "data-testid": "runners-confirm-yes" }, async () => {
      if (yes.getAttribute("aria-disabled") === "true") return;
      yes.setAttribute("aria-disabled", "true");
      const said = await run();
      if (said === "") return (returnTo = back || from), closeDialog(), done();
      yes.setAttribute("aria-disabled", "false");
      err.textContent = said;
      err.focus();
    });
    openDialog({ title, from, labelId: "runners-confirm-h", body: h("div", null, body, err), actions: [yes, button("Cancel", { id: "runners-confirm-cancel", "data-testid": "runners-confirm-cancel" }, closeDialog)] });
    focusId("runners-confirm-cancel");
    return yes;
  }
  const afterAction = (s, text) => () => (note(s, text), servers.loadList());
  /** Keep it changes nothing at Hetzner, so it needs no sheet. The card then says so from `kept`, and the focus moves to the button that is left. */
  async function keepIt(s) {
    const said = await serverAct("keep", s.id, { signal: ac.signal });
    if (said) return note(s, said, true);
    notes.delete(s.id);
    await servers.loadList();
    focusId(sid(s, "delete-orphan"));
  }
  function reboot(s, from) {
    confirmSheet({ from, title: "Reboot " + s.name + "?", body: h("p", null, REBOOT_SENTENCE), label: "Reboot", run: () => serverAct("reboot", s.id, { signal: ac.signal }), done: afterAction(s, "Reboot sent to Hetzner.") });
  }
  /** kind: "delete", "retry" (Delete and retry) or "delete-orphan". The name is typed first; a server with projects needs them moved or the box ticked. */
  function deleteSheet(s, kind, from) {
    const orphan = kind === "delete-orphan";
    const placed = s.placed || [];
    const typed = h("input", { type: "text", id: "runners-del-name", class: "runners-input", autocomplete: "off", "aria-describedby": "runners-del-why", "data-testid": "runners-del-name", onInput: () => sync() });
    const tick = placed.length ? h("input", { type: "checkbox", id: "runners-del-projects", "data-testid": "runners-del-projects", onChange: () => sync() }) : null;
    const why = h("p", { id: "runners-del-why", class: "runners-muted", "data-testid": "runners-del-why" });
    const need = () => (typed.value !== s.name ? "Type the server's name to confirm." : tick && !tick.checked ? "Tick the box to remove its projects with it, or move them to another machine first." : "");
    const sync = () => (yes.setAttribute("aria-disabled", need() ? "true" : "false"), (why.textContent = need()));
    const label = orphan ? "Delete it in Hetzner" : kind === "retry" ? "Delete and retry" : "Delete server";
    const yes = confirmSheet({
      from, back: "runners-srv-create", title: (kind === "retry" ? "Delete and retry " : "Delete ") + s.name + "?", label, off: true,
      body: h("div", null, h("p", null, orphan ? orphanSentence(s.cost) : deleteSentence(s.cost)),
        placed.length ? h("div", { "data-testid": "runners-del-projects-list" }, h("p", null, "These projects run on it:"), h("ul", null, placed.map((p) => h("li", null, h("bdi", null, p.name)))),
          h("label", { class: "runners-choice", for: "runners-del-projects" }, tick, h("span", null, "Also remove these projects. Their work on this server is lost."))) : null,
        h("label", { for: "runners-del-name" }, "Type " + s.name + " to confirm"), typed, why),
      run: () => serverAct(orphan ? "delete-orphan" : "delete", s.id, { signal: ac.signal, removeProjects: !!(tick && tick.checked) }),
      done: afterAction(s, kind === "retry" ? "Deleted. Press Create server to try again." : "Deleting…"),
    });
    sync();
    focusId("runners-del-name");
  }
  function moveSheet(s, p, from) {
    const targets = moveTargets(machines.state.list, s.runnerId);
    const pick = h("select", { id: "runners-move-to", class: "runners-input", "data-testid": "runners-move-to" }, targets.map((m) => h("option", { value: m.id }, m.name)));
    confirmSheet({
      from, title: "Move " + p.name + " to another machine?", label: "Move project", off: targets.length === 0,
      body: targets.length
        ? h("div", null, h("p", null, p.name + " stops running on " + s.name + " and starts on the machine you choose. Its team memory is not carried along; it starts fresh there."), h("label", { for: "runners-move-to" }, "Move to"), pick)
        : h("p", { "data-testid": "runners-move-none" }, "No other machine is online with room for it. Add a machine first."),
      run: () => moveProject(p.id, pick.value, { signal: ac.signal }), done: () => (note(s, p.name + " was moved."), servers.loadList(), machines.load()),
    });
  }
  function signOut(s, from) {
    confirmSheet({ from, title: "Sign " + s.name + " out of Claude?", body: h("p", null, LOGOUT_SENTENCE), label: "Sign out", run: async () => ((await signin.logout(s.runnerId)) ? "" : signin.get(s.runnerId).error || "That didn't work. Try again."), done: afterAction(s, "Sign-out sent. This updates when the server next reports.") });
  }
  function signInPanel(s, admin) {
    const id = s.runnerId;
    const box = (...kids) => h("div", { class: "runners-signin", "data-testid": "runners-signin" }, ...kids);
    if (!id) return box(h("p", { "data-testid": "runners-signin-wait" }, notConnectedYet(s.name)));
    const v = signin.get(id);
    const off = !admin || v.busy;
    const start = (label) => h("span", { class: "runners-control" }, button(label, { id: sid(s, "signin"), "aria-disabled": off ? "true" : "false", "aria-describedby": admin ? null : sid(s, "signin-why"), "data-testid": "runners-signin-start" }, () => !off && signin.start(id)),
      admin ? null : h("span", { id: sid(s, "signin-why"), class: "runners-reason runners-muted", "data-testid": "runners-reason" }, ONLY_ADMINS_ACT));
    const send = async () => {
      const code = input.value.trim();
      if (!code || off) return;
      input.value = ""; // cleared as soon as it is sent
      drafts.delete(id);
      await signin.sendCode(id, code);
    };
    const input = h("input", { type: "text", id: sid(s, "code"), class: "runners-input", autocomplete: "off", autocapitalize: "off", maxLength: 512, value: drafts.get(id) || "", "data-testid": "runners-signin-code",
      onInput: (e) => drafts.set(id, e.target.value), onKeydown: (e) => e.key === "Enter" && send() });
    const said = v.error ? h("p", { class: "runners-error", role: "alert", "data-testid": "runners-signin-error" }, v.error) : null;
    if (v.status === "pending") return box(h("p", { role: "status", "data-testid": "runners-signin-status" }, "Starting the sign-in on " + s.name + "…"), said);
    if (v.status === "code_ready") return box(h("p", { role: "status", "data-testid": "runners-signin-status" }, "Code sent. Waiting for " + s.name + "…"), said);
    if (v.status === "done") return box(h("p", { role: "status", "data-testid": "runners-signin-status" }, "Signed in. This updates in a moment."), said);
    if (v.status === "awaiting_code") {
      return box(v.authUrl ? h("a", { href: v.authUrl, target: "_blank", rel: "noopener noreferrer", class: "runners-link", "data-testid": "runners-signin-open" }, "Open Claude sign-in") : h("p", { "data-testid": "runners-signin-nolink" }, "Waiting for the link…"),
        h("label", { for: sid(s, "code") }, "Code from the sign-in page"), input, h("span", { class: "runners-actions" }, button("Send code", { id: sid(s, "send"), "aria-disabled": off ? "true" : "false", "data-testid": "runners-signin-send" }, send)), said);
    }
    return box(v.words ? h("p", { class: "runners-error", role: "alert", "data-testid": "runners-signin-words" }, v.words) : null, start(v.words ? "Start again" : "Sign in to Claude on " + s.name), said);
  }
  function serverExtras(s) {
    const admin = isAdmin();
    if (s.runnerId && s.state === "ready" && s.claudeIn === "yes") signin.forget(s.runnerId); // the list shows it signed in: what was seen of its request is spent
    const stuck = isStuck(s, Date.now());
    const n = notes.get(s.id);
    const acts = serverActions(s, { stuck, isAdmin: admin }).map((a) => {
      const from = sid(s, a.id);
      const go = () => (a.id === "keep" ? keepIt(s) : a.id === "reboot" ? reboot(s, from) : deleteSheet(s, a.id, from));
      return h("span", { class: "runners-control" }, button(a.label, { id: from, "aria-disabled": a.why ? "true" : "false", "aria-describedby": a.why ? from + "-why" : null, "data-testid": "runners-srv-" + a.id }, () => !a.why && go()),
        a.why ? h("span", { id: from + "-why", class: "runners-reason runners-muted", "data-testid": "runners-reason" }, a.why) : null);
    });
    if (s.state === "ready" && s.claudeIn === "yes" && s.runnerId && admin) acts.push(button("Sign out of Claude", { id: sid(s, "signout"), "data-testid": "runners-srv-signout" }, () => signOut(s, sid(s, "signout"))));
    const hosted = !s.placedKnown || !["ready", "needs_claude_login"].includes(s.state) ? null
      : s.placed.length === 0 ? h("p", { "data-testid": "runners-srv-noprojects" }, "No projects" + (s.cost ? " · " + s.cost : ""))
      : h("ul", { class: "runners-tokens", "data-testid": "runners-srv-projects" }, s.placed.map((p) => h("li", null, h("bdi", null, p.name), h("span", { class: "runners-control" }, button("Move to another machine", { id: sid(s, "move-" + p.id), "aria-label": "Move to another machine: " + p.name, "aria-disabled": admin ? "false" : "true", "aria-describedby": admin ? null : sid(s, "move-" + p.id) + "-why", "data-testid": "runners-srv-move" }, () => admin && moveSheet(s, p, sid(s, "move-" + p.id))),
        admin ? null : h("span", { id: sid(s, "move-" + p.id) + "-why", class: "runners-reason runners-muted", "data-testid": "runners-reason" }, ONLY_ADMINS_ACT)))));
    return [
      ...serverLines(s, offlineOf(s), Date.now()).map((t) => h("p", { class: t === SLOW_WORDS ? "runners-note" : "runners-muted", "data-testid": "runners-server-line" }, t)),
      hosted, needsSignIn(s) ? signInPanel(s, admin) : null,
      acts.length ? h("div", { class: "runners-controls" }, acts) : null,
      n ? h("p", { class: n.bad ? "runners-error" : "runners-muted", role: n.bad ? "alert" : "status", "data-testid": "runners-server-note" }, n.text) : null,
    ];
  }

  function serverRow(s) {
    return h("li", { class: "runners-row", "data-testid": "runners-server" },
      h("h3", { class: "runners-name", "data-testid": "runners-server-name" }, h("bdi", null, s.name)),
      h("p", { class: "runners-state", "data-testid": "runners-server-status" }, rowStatus(s)),
      s.why ? h("p", { class: "runners-error", "data-testid": "runners-server-why" }, s.why) : null,
      h("p", { class: "runners-muted" }, [s.size, s.location].filter(Boolean).join(" in "), s.created ? [" · created ", timeNode(s.created, true)] : ""),
      ...serverExtras(s));
  }
  function paintServers() {
    const f = fleet.state.fleet;
    const c = servers.cred;
    const l = servers.list;
    const v = c.value;
    const member = (f && !f.isAdmin) || c.status === "forbidden";
    const fleetDown = !f && fleet.state.status === "error"; // who the caller is was never read, so nothing about servers was asked
    const checking = c.status === "loading" || c.status === "checking";
    const connected = !member && c.status === "ready" && v !== null && v.status === "connected";
    const why = member ? ONLY_ADMINS_CREATE : fleetDown ? UNAVAILABLE : connected ? "" : checking ? "Checking Hetzner…" : CONNECT_FIRST;
    const text = (words, props) => h("p", { "data-testid": "runners-cred-text", ...props }, words);
    const credBody =
      member ? [text(ONLY_ADMINS_HETZNER, { class: "runners-muted" })]
      : fleetDown ? [text(UNAVAILABLE, { class: "runners-error", role: "alert", "data-testid": "runners-servers-fleet-error" }), button("Retry", { id: "runners-servers-fleet-retry", "data-testid": "runners-servers-fleet-retry" }, () => ((serversWaiting = true), fleet.load()))]
      : checking ? [text("Checking…", { role: "status" })]
      : c.status === "error" || v === null ? [text("Hetzner status couldn't be loaded", { class: "runners-error", role: "alert" }), button("Retry", { id: "runners-cred-retry", "data-testid": "runners-cred-retry" }, () => servers.loadCredential())]
      : v.status === "none" ? [text("No Hetzner token is connected."), button("Connect Hetzner", { id: "runners-hz-connect", "data-testid": "runners-hz-connect" }, () => connectHetzner("runners-hz-connect"))]
      : [text(v.status === "invalid" ? HETZNER_REFUSED : connectedText(v), v.status === "invalid" ? { class: "runners-error", role: "alert" } : null),
        v.status === "invalid" ? h("p", { class: "runners-muted" }, "Remove it, then connect a new one.") : null,
        c.unlabelled ? h("p", { class: "runners-note", "data-testid": "runners-hz-unlabelled" }, unlabelledText(c.unlabelled)) : null,
        button("Remove", { id: "runners-hz-remove", "aria-label": "Remove the Hetzner token", "data-testid": "runners-hz-remove" }, () => removeHetzner("runners-hz-remove"))];
    const body =
      fleetDown ? h("p", { class: "runners-muted" }, "Servers show here once the page can tell who you are.")
      : member || l.status === "forbidden" ? h("p", { class: "runners-muted", "data-testid": "runners-servers-forbidden" }, ONLY_ADMINS_SEE)
      : l.status === "loading" ? h("p", { class: "runners-muted", "data-testid": "runners-servers-loading" }, "Loading servers…")
      : l.status === "error" ? h("div", null, h("p", { class: "runners-error", role: "alert", "data-testid": "runners-servers-error" }, "Servers couldn't be loaded"), button("Retry", { id: "runners-servers-retry", "data-testid": "runners-servers-retry" }, () => servers.loadList()))
      : l.items.length === 0 ? h("p", { class: "runners-muted", "data-testid": "runners-servers-empty" }, "No servers yet")
      : h("ul", { class: "runners-rows", "data-testid": "runners-servers" }, l.items.map(serverRow));
    return panel(
      h("div", { class: "runners-head" }, h("h2", { class: "runners-title" }, "Servers"),
        h("span", { class: "runners-actions" }, button("Refresh", { id: "runners-servers-refresh", "data-testid": "runners-servers-refresh" }, () => ((created = false), notes.clear(), loadServers())),
          button("Create server", { id: "runners-srv-create", "aria-disabled": why ? "true" : "false", "aria-describedby": why ? "runners-srv-create-why" : null, "data-testid": "runners-srv-create" }, () => !why && openCreate("runners-srv-create"))),
        why ? h("span", { id: "runners-srv-create-why", class: "runners-reason runners-muted", "data-testid": "runners-reason" }, why) : null),
      h("section", { class: "runners-cred", "data-testid": "runners-cred", "aria-label": "Hetzner Cloud" }, h("h3", { class: "runners-subtitle" }, "Hetzner Cloud"), ...credBody),
      created ? h("p", { role: "status", "data-testid": "runners-servers-created" }, "Your server is being created. It shows below as soon as Hetzner has it.") : null,
      body);
  }

  // ── the list ──
  function line(label, ...value) {
    return [h("dt", null, label), h("dd", null, ...value)];
  }
  function row(r, isAdmin) {
    const parts = stateParts(r);
    const pending = fleet.isPending(r.id);
    const controls = controlList(r).map((c) => {
      const id = "runners-" + r.id + "-" + c.action;
      const off = !c.allowed || pending;
      return h("span", { class: "runners-control" },
        h("button", {
          type: "button", class: "runners-btn", id, "aria-disabled": off ? "true" : "false", "aria-describedby": !c.allowed && c.reason ? id + "-why" : null, "data-testid": "runners-" + c.action,
          onClick: async () => {
            if (!c.allowed || fleet.isPending(r.id)) return;
            if (c.action === "rename") return rename(r);
            if (c.action === "remove") return remove(r);
            rowErrors.delete(r.id);
            const said = await fleet.act(r.id, c.action);
            if (said) rowErrors.set(r.id, said);
            paint();
          },
        }, c.label),
        !c.allowed && c.reason ? h("span", { class: "runners-reason runners-muted", id: id + "-why", "data-testid": "runners-reason" }, c.reason) : null);
    });
    const said = rowErrors.get(r.id) || (fleet.readFailed(r.id) ? CHECK_READ_FAILED : "");
    return h("li", { class: "runners-row", "data-testid": "runners-row", "data-state": r.state, "aria-busy": pending ? "true" : "false" },
      h("h3", { class: "runners-name", "data-testid": "runners-name" }, h("bdi", null, r.name)),
      h("p", { class: "runners-muted" }, "Registered by ", h("bdi", null, r.person)),
      h("p", { class: "runners-state", "data-testid": "runners-state" }, h("span", { "aria-hidden": "true" }, parts.mark), " ", parts.words),
      h("dl", { class: "runners-facts" },
        ...line("Version", versionText(r)),
        ...line("Running now", r.runs.length === 0 ? "Nothing" : r.runs.map((x) => h("button", { type: "button", class: "runners-link", "data-testid": "runners-run", onClick: () => window.FULCWM && window.FULCWM.open("runs", { runId: x.id }) }, x.label))),
        ...line("Capacity", capacityText(r)),
        ...(heldBackText(r) ? line("Held back", heldBackText(r)) : []),
        ...line("Last check-in", r.lastSeen ? [timeNode(r.lastSeen, true), " (" + agoText(r.lastSeen, Date.now()) + ")"] : "Never"),
        ...line("Repos", r.state === "revoked" ? "None" : r.repos.length === 0 ? "No repos" : h("bdi", null, r.repos.join(", "))),
        ...line("Credential", MODE_WORDS[r.mode] || "Unknown"),
        ...line("Labels", r.labels.length === 0 ? "None" : h("bdi", null, r.labels.join(", "))),
        ...line("Machine", factsText(r)),
        ...line("Preflight", preflightLines(r) === null ? NO_PREFLIGHT : preflightLines(r).length === 0 ? PREFLIGHT_OK : h("ul", { class: "runners-preflight", "data-testid": "runners-preflight" }, preflightLines(r).map((t) => h("li", null, t))))),
      provText(r) ? h("p", { class: "runners-muted", "data-testid": "runners-prov" }, provText(r)) : null,
      r.sandboxes ? sandboxSection(r, isAdmin, pending) : null,
      controls.length ? h("div", { class: "runners-controls" }, controls) : null,
      r.again && isAdmin ? button("Register this machine again", { id: "runners-" + r.id + "-again", "data-testid": "runners-again" }, () => openSheet("runners-" + r.id + "-again", r.again)) : null,
      said ? h("p", { class: "runners-error", role: "alert", "data-testid": "runners-row-error" }, said) : null);
  }

  function paint() {
    const doc = root.ownerDocument;
    const held = root.contains(doc.activeElement) ? doc.activeElement.id : "";
    if (tab === "fleet") paintFleet();
    else root.replaceChildren(h("div", { class: "runners-page" }, tabBar(), tab === "machines" ? paintMachines() : paintServers()));
    if (held) focusId(held);
    if (sheetEl) paintSheet();
  }

  function paintFleet() {
    const s = fleet.state;
    const f = s.fleet;
    const head = h("div", { class: "runners-head" }, h("h2", { class: "runners-title" }, "Runners"),
      h("span", { class: "runners-actions" },
        button("Refresh", { id: "runners-refresh" }, () => fleet.load()),
        button("Add a runner", { id: ADD_ID, "aria-disabled": f && !f.isAdmin ? "true" : "false", "aria-describedby": f && !f.isAdmin ? "runners-add-why" : null, "data-testid": "runners-add" }, () => f && f.isAdmin && openSheet(ADD_ID))),
      f && !f.isAdmin ? h("span", { id: "runners-add-why", class: "runners-reason runners-muted", "data-testid": "runners-reason" }, ONLY_ADMINS) : null);
    const body =
      s.status === "loading" ? h("p", { class: "runners-muted", "data-testid": "runners-loading" }, "Loading runners...")
      : s.status === "error" ? h("p", { class: "runners-error", role: "alert", "data-testid": "runners-error" }, UNAVAILABLE)
      : f.runners.length === 0 ? h("p", { class: "runners-muted", "data-testid": "runners-empty" }, "No runners yet. Use Add a runner to register your first machine.")
      : h("ul", { class: "runners-rows" }, f.runners.map((r) => row(r, f.isAdmin)));
    root.replaceChildren(
      h("div", { class: "runners-page" },
        tabBar(),
        panel(head,
        f ? h("p", { class: "runners-account", role: "status", "data-testid": "runners-account" }, accountText(f.account)) : null,
        f && runnerLimitText(f.account) ? h("p", { class: "runners-note", "data-testid": "runners-limit-note" }, runnerLimitText(f.account)) : null,
        body))
    );
  }

  paint();
  fleet.load();
  machines.load();
  const off = onRefresh(() => (fleet.load(), machines.load(), tab === "servers" && loadServers()));
  // Read again on its own while the page is open and showing, so the check-in time and capacity never go stale on screen.
  const refreshTimer = setInterval(() => {
    if (root.ownerDocument.hidden) return;
    fleet.load();
    machines.load();
    if (tab === "servers") loadServers();
  }, FLEET_REFRESH_MS);
  return {
    destroy() {
      clearInterval(refreshTimer);
      off();
      ac.abort();
      adder.close();
      servers.stop();
      signin.stop();
      creator.close();
      if (dialog) {
        dialog.dlg.close();
        dialog.dlg.remove();
        dialog = null;
      }
      contentEl.replaceChildren();
    },
  };
}

let current = null;

FULC.register({
  id: "runners",
  title: "Machines",
  keywords: ["Runners"],
  icon: "▣",
  defaultSize: { w: 900, h: 620 },
  onOpen({ contentEl }) {
    if (current) current.destroy();
    current = mountApp(contentEl);
  },
  onClose() {
    if (current) current.destroy();
    current = null;
  },
});
