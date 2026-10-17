// D#605 FL-9: the Runners app, the fleet page. One row per runner with its state, version, current runs, capacity, last check-in, repos, credential
// mode, labels and facts; the controls the caller is offered (each disabled one shows its reason); the account line; and the "Add a runner" sheet.
//
// The words and every decision come from GET /api/runners (runners-fleet.js words them). Every node is built with h(), so server text renders as text.
// Controls use aria-disabled, not disabled, so a pressed control keeps focus while its request is in flight, and a second press is ignored.
// After a dialog closes, focus goes back to the control that opened it, found by id because the list is rebuilt after every read.
import { h, timeNode } from "../_lib/dom.js";
import { onRefresh } from "../../core/cloud-live.js";
import {
  MODE_WORDS, ONLY_ADMINS, TTL_CHOICES, accountText, capacityText, controlList, createAdder, createFleet, factsText, loadRepoChoices, provText, runnerLimitText, stateParts, versionText,
} from "./runners-fleet.js";

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
  let repoChoices = { status: "idle", list: [] };
  const rowErrors = new Map();
  const fleet = createFleet({ signal: ac.signal, onChange: () => paint() });
  const adder = createAdder({ signal: ac.signal, origin: window.location.origin, onChange: () => paintSheet() });

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
    const said = rowErrors.get(r.id);
    return h("li", { class: "runners-row", "data-testid": "runners-row", "data-state": r.state, "aria-busy": pending ? "true" : "false" },
      h("h3", { class: "runners-name", "data-testid": "runners-name" }, h("bdi", null, r.name)),
      h("p", { class: "runners-muted" }, "Registered by ", h("bdi", null, r.person)),
      h("p", { class: "runners-state", "data-testid": "runners-state" }, h("span", { "aria-hidden": "true" }, parts.mark), " ", parts.words),
      h("dl", { class: "runners-facts" },
        ...line("Version", versionText(r)),
        ...line("Running now", r.runs.length === 0 ? "Nothing" : r.runs.map((x) => h("button", { type: "button", class: "runners-link", "data-testid": "runners-run", onClick: () => window.FULCWM && window.FULCWM.open("runs", { runId: x.id }) }, x.label))),
        ...line("Capacity", capacityText(r)),
        ...line("Last check-in", r.lastSeen ? timeNode(r.lastSeen, true) : "Never"),
        ...line("Repos", r.state === "revoked" ? "None" : r.repos.length === 0 ? "No repos" : h("bdi", null, r.repos.join(", "))),
        ...line("Credential", MODE_WORDS[r.mode] || "Unknown"),
        ...line("Labels", r.labels.length === 0 ? "None" : h("bdi", null, r.labels.join(", "))),
        ...line("Machine", factsText(r))),
      provText(r) ? h("p", { class: "runners-muted", "data-testid": "runners-prov" }, provText(r)) : null,
      controls.length ? h("div", { class: "runners-controls" }, controls) : null,
      r.again && isAdmin ? button("Register this machine again", { id: "runners-" + r.id + "-again", "data-testid": "runners-again" }, () => openSheet("runners-" + r.id + "-again", r.again)) : null,
      said ? h("p", { class: "runners-error", role: "alert", "data-testid": "runners-row-error" }, said) : null);
  }

  function paint() {
    const doc = root.ownerDocument;
    const held = root.contains(doc.activeElement) ? doc.activeElement.id : "";
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
        head,
        f ? h("p", { class: "runners-account", role: "status", "data-testid": "runners-account" }, accountText(f.account)) : null,
        f && runnerLimitText(f.account) ? h("p", { class: "runners-note", "data-testid": "runners-limit-note" }, runnerLimitText(f.account)) : null,
        body)
    );
    if (held) focusId(held);
    if (sheetEl) paintSheet();
  }

  paint();
  fleet.load();
  const off = onRefresh(() => fleet.load());
  return {
    destroy() {
      off();
      ac.abort();
      adder.close();
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
  title: "Runners",
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
