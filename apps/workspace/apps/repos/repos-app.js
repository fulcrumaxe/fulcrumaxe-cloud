// D#37 WS-F3: the Repos app. Lists the account's repos with their install state,
// shows a repo's two auto-merge settings, and starts the GitHub App install.
// Every node comes from the shared h() and every request from api() (apps/_lib),
// so no markup is parsed and session loss is left to api(). A refusal is shown
// as a sentence of this app's own, chosen by status or details.path, never the
// server's message. The install URL carries a signed state: it is navigated to
// and never written into the page, storage or a log. Live: the list re-reads on
// refresh and on the install / repo-sync events.
import { h } from "../_lib/dom.js";
import { api, ApiFailure, createRetryGate, isRateLimited, retryWords, waitSeconds } from "../_lib/api.js";
import { on, onRefresh } from "../../core/cloud-live.js";
import { autoMergeDisabled, lockNote } from "./repos-lock.js";
import { createAllowancePanel } from "./repos-allowances.js";
import { createDialControl, createRunnersSection } from "./repos-runners.js";

const REPOS_URL = "/api/v1/repos";
const allowancesUrl = (id) => "/api/runners/repos/" + encodeURIComponent(id) + "/sandbox-allowances";
const LIVE_EVENTS = ["installation.changed", "repos.changed"];
const MAX_PAGES = 50;
const ADMIN_ONLY = "Only owners and admins can change this.";
const ACK_MISSING = "Tick this box to confirm before turning the guard off.";
const SAVE_FAILED = "That change couldn't be saved. Try again.";
const INSTALL_FAILED = "Couldn't start the install. Try again.";
const KINDS = [
  { kind: "team_readonly", label: "Install the GitHub App (read-only)" },
  { kind: "team", label: "Install the GitHub App (write)" },
];
// The ?install= value the GitHub install callback redirects back with.
const RETURN_NOTES = {
  ok: "The GitHub App is installed.",
  failed: "The GitHub App install didn't finish. Try it again.",
  claimed: "That GitHub installation already belongs to another account.",
  pay_first: "Start your subscription first, then install the write App.",
  rate_limited: "Too many tries. Wait a minute, then install again.",
};

const FULC = window.FULC;
if (!FULC || typeof FULC.register !== "function") throw new Error("Repos app: the FULC SDK global is missing");

/** The note for the ?install= value the page was opened with; the value is removed so it shows once. */
function consumeInstallNote() {
  try {
    const url = new URL(window.location.href);
    const value = url.searchParams.get("install");
    if (value === null) return "";
    url.searchParams.delete("install");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    return Object.prototype.hasOwnProperty.call(RETURN_NOTES, value) ? RETURN_NOTES[value] : "";
  } catch {
    return "";
  }
}

/** Only an https://github.com address is ever navigated to. */
function githubUrl(raw) {
  try {
    const u = new URL(String(raw));
    return u.protocol === "https:" && u.hostname === "github.com" ? u.href : "";
  } catch {
    return "";
  }
}

const pickSettings = (s) =>
  s && typeof s.auto_merge === "boolean" && typeof s.block_external_auto_merge === "boolean"
    ? { auto_merge: s.auto_merge, block_external_auto_merge: s.block_external_auto_merge, human_merge_only: s.human_merge_only === true }
    : null;
const isRepo = (r) => r && typeof r.id === "string" && typeof r.product === "string";
const cancelled = (e) => e && e.name === "AbortError";
const isAckError = (e) =>
  e instanceof ApiFailure && e.status === 422 && e.code === "invalid_role_settings_input" &&
  (e.details || []).some((d) => d && d.path === "acknowledge_external_risk");
const line = (text, testid, cls, role) => h("p", { class: cls, role, "data-testid": testid }, text);

function mountRepos(host, installNote) {
  const abort = new AbortController();
  const st = {
    repos: [], loading: true, loadFailed: false, isAdmin: false,
    openId: null, settings: null, settingsState: "idle", // idle | loading | ok | error
    saving: false, saveError: "", pendingOff: false, ack: false, ackError: false,
    installBusy: false, note: installNote || "",
  };
  let destroyed = false, listGen = 0, settingsGen = 0;
  // D#6 R7d: the sandbox allowance panel for the open repo. Its own state survives the detail pane being rebuilt.
  const allowances = createAllowancePanel({ call: (method, id, body) => api(method, allowancesUrl(id), body, abort.signal), isCancelled: () => destroyed });

  const root = h("div", { class: "repos-app", "data-testid": "repos-app" });
  const headEl = h("div", { class: "repos-head" });
  const noteEl = h("p", { class: "repos-note", role: "status", "aria-live": "polite", "data-testid": "repos-note" });
  const listEl = h("section", { class: "repos-list", "aria-label": "Repos" });
  const detailEl = h("section", { class: "repos-detail", "aria-label": "Repo settings" });
  root.append(headEl, noteEl, h("div", { class: "repos-body" }, listEl, detailEl));
  host.replaceChildren(root);

  // D#6 R2b-4b: the Runners section below the repos, and the runner-run setting in the open repo's settings (it reads the same runners answer).
  let dial = null;
  const runners = createRunnersSection({ signal: abort.signal, onData: () => dial && dial.repaint() });
  // dom-insert-ok: runners.el is the section element createRunnersSection built with h()
  root.append(runners.el);
  const makeDial = () => {
    dial = st.openId ? createDialControl({ signal: abort.signal, repoId: st.openId, data: runners.data }) : null;
    if (dial) dial.load();
  };

  // ── the wait after a 429 on the install link: "Try again in N seconds", the install buttons off until it ends ──
  const waiting = () => gate.remaining > 0;
  let waitOwnsNote = false;
  const gate = createRetryGate({
    onChange(remaining) {
      if (destroyed) return;
      if (waitOwnsNote) {
        st.note = remaining > 0 ? "Too many tries. " + retryWords(remaining) : "";
        noteEl.textContent = st.note;
        // The note is a live region: the first sentence is announced, the per-second repaints are not.
        noteEl.setAttribute("aria-live", remaining > 0 && st.noteAnnounced ? "off" : "polite");
        st.noteAnnounced = remaining > 0;
        if (remaining === 0) waitOwnsNote = false;
      }
      // Only the install buttons change on a tick, so the view is not rebuilt and focus stays put.
      for (const el of root.querySelectorAll('[data-testid^="repos-install-"]')) {
        if (el.tagName === "BUTTON") el.disabled = !st.isAdmin || st.installBusy || waiting();
      }
    },
  });

  const settingsUrl = (id) => REPOS_URL + "/" + encodeURIComponent(id) + "/settings";
  const openRepo = () => st.repos.find((r) => r.id === st.openId);
  const button = (label, testid, onClick, extra) =>
    h("button", { type: "button", class: "repos-btn", "data-testid": testid, onClick, ...extra }, label);
  const focusTestId = (id) => {
    const el = root.querySelector('[data-testid="' + id + '"]');
    if (el) el.focus();
  };

  // ── rendering ────────────────────────────────────────────────────────
  function renderHead() {
    // replaceChildren(null) would write the text "null", so the optional parts are left out, not passed as null.
    headEl.replaceChildren(
      h("h2", { class: "repos-title" }, "Repos"),
      h("div", { class: "repos-install", role: "group", "aria-label": "Install the GitHub App" },
        KINDS.map((k) => button(k.label, "repos-install-" + k.kind, () => startInstall(k.kind), {
          disabled: !st.isAdmin || st.installBusy || waiting(), "aria-describedby": st.isAdmin ? null : "repos-admin-only",
        }))),
      ...(st.isAdmin ? [] : [h("p", { id: "repos-admin-only", class: "repos-muted", "data-testid": "repos-install-admin-only" }, ADMIN_ONLY)])
    );
    noteEl.textContent = st.note;
  }

  function renderList() {
    if (st.loading) return listEl.replaceChildren(line("Loading repos...", "repos-loading", "repos-muted"));
    if (st.loadFailed) {
      return listEl.replaceChildren(line("Repos aren't available right now.", "repos-load-error", "", "alert"), button("Try again", "repos-retry", loadRepos));
    }
    if (st.repos.length === 0) return listEl.replaceChildren(line("No repos yet. Install the GitHub App to add some.", "repos-empty", "repos-muted"));
    listEl.replaceChildren(h("ul", { class: "repos-rows" }, st.repos.map((r) =>
      h("li", { class: "repos-row", "data-testid": "repos-row" },
        h("button", { type: "button", class: "repos-open", "aria-pressed": r.id === st.openId ? "true" : "false", "data-testid": "repos-open", onClick: () => selectRepo(r.id) },
          h("bdi", { class: "repos-name" }, r.full_name || r.product),
          h("span", { class: "repos-state", "data-testid": "repos-state" }, r.install_state === "installed" ? "Installed" : "Not installed")),
        r.app_kind === "team_readonly" ? line("Read-only. Install the write App to run work.", "repos-readonly", "repos-muted repos-readonly") : null)
    )));
  }

  function toggle(label, help, checked, testid, onChange, disabled) {
    const box = h("input", {
      type: "checkbox", checked, disabled: disabled === undefined ? !st.isAdmin || st.saving : disabled, "data-testid": testid,
      "aria-describedby": st.isAdmin ? null : "repos-admin-only-detail", onChange: () => onChange(box.checked),
    });
    return h("label", { class: "repos-toggle" }, box, h("span", null, h("strong", null, label), h("span", { class: "repos-muted" }, help)));
  }

  function guardChanged(on) {
    st.ack = false; st.ackError = false;
    if (!on) { st.pendingOff = true; renderDetail(); return focusTestId("repos-ack"); }
    st.pendingOff = false;
    if (!st.settings.block_external_auto_merge) return patch({ block_external_auto_merge: true });
    renderDetail();
  }

  function renderConfirm() {
    const ackBox = h("input", {
      type: "checkbox", checked: st.ack, disabled: st.saving, id: "repos-ack", "data-testid": "repos-ack",
      "aria-invalid": st.ackError ? "true" : null, "aria-describedby": st.ackError ? "repos-ack-error" : null,
      onChange: () => { st.ack = ackBox.checked; st.ackError = false; renderDetail(); focusTestId("repos-ack"); },
    });
    const turnOff = () => patch(st.ack ? { block_external_auto_merge: false, acknowledge_external_risk: true } : { block_external_auto_merge: false });
    const cancel = () => { st.pendingOff = false; st.ack = false; st.ackError = false; renderDetail(); focusTestId("repos-guard"); };
    return h("div", { class: "repos-confirm", role: "group", "aria-label": "Turn the guard off", "data-testid": "repos-confirm" },
      h("label", { class: "repos-toggle", for: "repos-ack" }, ackBox, h("span", null, "I understand that pull requests from outside contributors can then be merged automatically.")),
      st.ackError ? h("p", { id: "repos-ack-error", class: "repos-error", role: "alert", "data-testid": "repos-ack-error" }, ACK_MISSING) : null,
      h("div", { class: "repos-actions" },
        button("Turn the guard off", "repos-guard-off", turnOff, { disabled: st.saving }),
        button("Cancel", "repos-guard-cancel", cancel, { disabled: st.saving }))
    );
  }

  function renderDetail() {
    const repo = openRepo();
    if (!repo) return detailEl.replaceChildren(line("Pick a repo to see its settings.", "repos-pick", "repos-muted"));
    const title = h("h3", { class: "repos-subtitle" }, "Settings for ", h("bdi", null, repo.full_name || repo.product));
    if (st.settingsState === "loading") return detailEl.replaceChildren(title, line("Loading settings...", "repos-settings-loading", "repos-muted"));
    if (st.settingsState !== "ok" || !st.settings) return detailEl.replaceChildren(title, line("Settings aren't available right now.", "repos-settings-error", "", "alert"));
    detailEl.replaceChildren(
      title,
      ...(lockNote(st.settings) ? [line(lockNote(st.settings), "repos-human-merge-only", "repos-muted")] : []),
      toggle("Auto-merge", "Merge a pull request automatically once it passes review.", st.settings.auto_merge, "repos-auto-merge", (on) => patch({ auto_merge: on }),
        autoMergeDisabled(st.settings, { isAdmin: st.isAdmin, saving: st.saving })),
      toggle("Block auto-merge for outside contributors", "Pull requests from people outside your account are never merged automatically.",
        st.settings.block_external_auto_merge && !st.pendingOff, "repos-guard", guardChanged),
      ...(st.pendingOff ? [renderConfirm()] : []),
      // dom-insert-ok: dial.el is the fieldset createDialControl built with h()
      ...(dial ? [dial.el] : []),
      ...(st.isAdmin ? [] : [h("p", { id: "repos-admin-only-detail", class: "repos-muted", "data-testid": "repos-settings-admin-only" }, ADMIN_ONLY)]),
      ...(st.saveError ? [line(st.saveError, "repos-save-error", "repos-error", "alert")] : [])
    );
    // dom-insert-ok: allowances.el is the section element createAllowancePanel built with h(); it keeps its own state across this rebuild
    detailEl.append(allowances.el);
  }

  function render() {
    if (destroyed) return;
    const active = document.activeElement;
    const keep = active && root.contains(active) ? active.getAttribute("data-testid") : null;
    renderHead();
    renderList();
    renderDetail();
    if (keep && !root.contains(document.activeElement)) focusTestId(keep);
  }

  // ── data ─────────────────────────────────────────────────────────────
  async function loadRepos() {
    const gen = ++listGen;
    try {
      const all = [];
      let cursor = null;
      for (let i = 0; i < MAX_PAGES; i++) {
        const page = await api("GET", cursor ? REPOS_URL + "?cursor=" + encodeURIComponent(cursor) : REPOS_URL, undefined, abort.signal);
        if (gen !== listGen || destroyed) return;
        if (page && Array.isArray(page.data)) all.push(...page.data.filter(isRepo));
        cursor = page && typeof page.next_cursor === "string" && page.next_cursor ? page.next_cursor : null;
        if (!cursor) break;
      }
      st.repos = all;
      st.loadFailed = false;
    } catch (e) {
      if (gen !== listGen || destroyed || cancelled(e)) return;
      st.loadFailed = true;
    }
    st.loading = false;
    if (st.openId && !openRepo()) { st.openId = null; dial = null; }
    render();
  }

  async function loadMe() {
    try {
      const me = await api("GET", "/api/cloud/auth/me", undefined, abort.signal);
      st.isAdmin = !!(me && me.is_admin === true);
    } catch (e) {
      if (cancelled(e)) return;
      st.isAdmin = false; // the server's 403 stays the real answer
    }
    render();
  }

  async function loadSettings(id, quiet) {
    const gen = ++settingsGen;
    if (!quiet) { st.settingsState = "loading"; st.settings = null; render(); }
    try {
      const s = pickSettings(await api("GET", settingsUrl(id), undefined, abort.signal));
      if (gen !== settingsGen || destroyed) return;
      st.settings = s;
      st.settingsState = s ? "ok" : "error";
    } catch (e) {
      if (gen !== settingsGen || destroyed || cancelled(e)) return;
      if (!quiet) st.settingsState = "error";
    }
    render();
  }

  function selectRepo(id) {
    if (id === st.openId) return;
    st.openId = id;
    st.pendingOff = false; st.ack = false; st.ackError = false; st.saveError = "";
    makeDial();
    loadSettings(id, false);
    allowances.show(openRepo());
  }

  async function patch(body) {
    const id = st.openId;
    if (!id || st.saving) return;
    st.saving = true; st.saveError = ""; st.ackError = false;
    settingsGen++; // a read still in flight must not overwrite this write
    render();
    try {
      const next = pickSettings(await api("PATCH", settingsUrl(id), body, abort.signal));
      if (next && id === st.openId) { st.settings = next; st.pendingOff = false; st.ack = false; }
    } catch (e) {
      if (cancelled(e)) return;
      if (e instanceof ApiFailure && e.status === 403) { st.isAdmin = false; st.saveError = ADMIN_ONLY; } // demoted under us: read-only view
      else if (isAckError(e)) st.ackError = true;
      else st.saveError = SAVE_FAILED;
    }
    st.saving = false;
    render();
  }

  async function startInstall(kind) {
    if (st.installBusy || waiting()) return;
    st.installBusy = true; st.note = ""; waitOwnsNote = false;
    render();
    try {
      const res = await api("GET", "/api/v1/github/install-url?app_kind=" + kind, undefined, abort.signal);
      const target = githubUrl(res && res.url);
      if (target) window.location.assign(target);
      else st.note = INSTALL_FAILED;
    } catch (e) {
      if (cancelled(e)) return;
      if (isRateLimited(e)) { waitOwnsNote = true; st.noteAnnounced = false; gate.start(waitSeconds(e)); }
      else if (e instanceof ApiFailure && e.status === 403) { st.isAdmin = false; st.note = ADMIN_ONLY; }
      else if (e instanceof ApiFailure && e.code === "github_app_not_configured") st.note = "Installing the GitHub App isn't available right now.";
      else st.note = INSTALL_FAILED;
    }
    st.installBusy = false;
    render();
  }

  const unsubscribe = onRefresh(() => {
    loadRepos();
    runners.load();
    if (dial) dial.reload();
    if (st.openId && !st.pendingOff && !st.saving) loadSettings(st.openId, true); // a pending confirmation is never overwritten
  });
  // The install state is derived on the server, so an install, uninstall, suspend or repo sync only needs a re-read of the list.
  const offEvents = LIVE_EVENTS.map((type) => on(type, loadRepos));
  render();
  loadMe();
  loadRepos();
  runners.load();

  return {
    destroy() {
      destroyed = true;
      allowances.clear();
      runners.destroy();
      gate.cancel();
      abort.abort();
      unsubscribe();
      for (const off of offEvents) off();
      host.replaceChildren();
    },
  };
}

let current = null;
const teardown = () => {
  if (current) current.destroy();
  current = null;
};

FULC.register({
  id: "repos",
  title: "Repos",
  icon: "⎇",
  defaultSize: { w: 780, h: 540 },
  onOpen({ contentEl }) {
    teardown();
    current = mountRepos(contentEl, consumeInstallNote());
  },
  onClose: teardown,
});
