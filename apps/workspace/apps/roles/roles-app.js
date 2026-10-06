// D#37 WS-F4a/F4b: the Roles app. A repo picker (installed repos only) and,
// for the chosen repo, one row per "fulcrumaxe <role>": its mode, its model and
// the expected spend the server computed. An owner or admin changes a mode or a
// model with the row's select; each change is one PATCH with only that field.
//
// Rules this file keeps:
//   * Every node is built with h(), so server text renders as text.
//   * No number is computed here: the spend line is expected_spend.text and
//     its caveat is the tooltip.
//   * A failure shows a fixed sentence of this app's own. The one exception is
//     a 422, whose message is the server's own explanation of the refused
//     value (a floor or an allowed mode), shown as text on the row.
//   * Session expiry is not handled here: a shared helper owns it.
//   * The chosen repo is remembered through core/storage-ns.js, not the SDK's
//     per-page state (C34 section 4).
//   * Live: only `refresh` (the stream reconnecting or the tab waking) reloads,
//     and never while a save is in flight.
import { h } from "../_lib/dom.js";
import { api } from "../_lib/api.js";
import { onRefresh } from "../../core/cloud-live.js";
import { getItem, setItem } from "../../core/storage-ns.js";
import { addRunLimitsView } from "./roles-limits.js";

const FULC = window.FULC;
if (!FULC || typeof FULC.register !== "function") {
  throw new Error("Roles app: the FULC SDK global is missing");
}

const REPO_KEY = "roles:repo";
const MAX_PAGES = 50;
const UNAVAILABLE = "Roles aren't available right now.";
const NOT_ALLOWED = "Only owners and admins can change roles.";
const SAVE_FAILED = "That change couldn't be saved. Try again.";
const FOLLOWS = "Follows the routing table";
// What a failed save shows, and which control it belongs to.
function failure(e, field) {
  if (e && e.status === 422) {
    const path = e.details && e.details[0] && e.details[0].path;
    return { field: path === "mode" || path === "model" ? path : field, text: e.message };
  }
  return { field, text: e && e.status === 403 ? NOT_ALLOWED : SAVE_FAILED };
}

// Every installed repo, following next_cursor to the end.
async function loadRepos(signal) {
  const out = [];
  let cursor = "";
  for (let i = 0; i < MAX_PAGES; i++) {
    const path = "/api/v1/repos" + (cursor ? "?cursor=" + encodeURIComponent(cursor) : "");
    const page = await api("GET", path, undefined, signal);
    for (const r of page.data) if (r.install_state === "installed") out.push(r);
    if (!page.next_cursor) break;
    cursor = page.next_cursor;
  }
  return out;
}

// Owner and admin only, and cosmetic: the server's 403 stays authoritative.
async function loadIsAdmin(signal) {
  try {
    const me = await api("GET", "/api/cloud/auth/me", undefined, signal);
    return !!(me && me.is_admin);
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    return false;
  }
}

// x: { canEdit, busy, err: {field, text} | null, change(role, field, value),
//      key(event, role), pointer(), blur(role) }
// The controls are never disabled for a save: the one in use keeps focus.
function roleRow(role, x) {
  const errId = "roles-err-" + role.role;
  const floorId = "roles-floor-" + role.role;
  const bad = x.err ? x.err.field : "";
  const control = (field, cls, label, testid, options) =>
    h(
      "select",
      {
        class: cls,
        disabled: !x.canEdit,
        "aria-label": label + " for fulcrumaxe " + role.role,
        "aria-invalid": bad === field ? "true" : null,
        "aria-describedby": [field === "model" && role.model_floor ? floorId : null, bad === field ? errId : null].filter(Boolean).join(" ") || null,
        "data-testid": testid,
        "data-field": field,
        onChange: (ev) => x.change(role.role, field, ev.target.value),
        onKeydown: (ev) => x.key(ev, role.role),
        onPointerdown: () => x.pointer(),
        onBlur: () => x.blur(role.role),
      },
      options
    );
  const mode = control(
    "mode",
    "roles-mode",
    "Mode",
    "roles-mode",
    role.allowed_modes.map((m) => h("option", { value: m, selected: m === role.mode }, m))
  );
  mode.setAttribute("data-can-edit", x.canEdit ? "true" : "false");
  const floorHint = role.model_floor ? h("span", { class: "roles-floor", id: floorId }, " (at least " + role.model_floor + ")") : null;
  let model;
  if (x.canEdit) {
    // The server decides which models this role may use; a missing list offers nothing.
    const ids = role.allowed_models || [];
    const stored = role.model && !ids.includes(role.model) ? role.model : null;
    model = h(
      "span",
      { class: "roles-model", "data-testid": "roles-model" },
      control(
        "model",
        "roles-mode roles-model-select",
        "Model",
        "roles-model-select",
        [
          h("option", { value: "", selected: !role.model }, FOLLOWS),
          ...ids.map((id) => h("option", { value: id, selected: id === role.model }, id)),
          stored ? h("option", { value: stored, selected: true, disabled: true }, stored) : null,
        ]
      ),
      floorHint
    );
  } else {
    model = h("span", { class: "roles-model", "data-testid": "roles-model" }, role.model || FOLLOWS, floorHint);
  }
  const spend = h(
    "span",
    { class: "roles-spend", title: role.expected_spend.caveat, tabindex: 0, "data-testid": "roles-spend" },
    role.expected_spend.text
  );
  return h(
    "li",
    { class: "roles-row", "data-role": role.role, "data-testid": "roles-row", "aria-busy": x.busy ? "true" : null },
    h("span", { class: "roles-name" }, "fulcrumaxe " + role.role),
    mode,
    model,
    spend,
    x.err ? h("p", { class: "roles-row-error", id: errId, role: "alert", "data-testid": "roles-row-error" }, x.err.text) : null
  );
}

function mountApp(contentEl) {
  let repos = [];
  let repoId = null;
  let roles = null;
  let isAdmin = false;
  let error = "";
  let ctl = null;
  let seq = 0;
  let closed = false;
  let stale = false;
  let loading = false;
  let viaKey = false;
  const busy = new Set();
  const errs = new Map();
  const held = new Map();
  const queued = new Map();

  const status = h("p", { class: "roles-status", role: "status", "aria-live": "polite", "data-testid": "roles-status" });
  const picker = h("select", {
    class: "roles-repo",
    "aria-label": "Repo",
    "data-testid": "roles-repo",
    onChange: () => choose(picker.value),
  });
  const note = h("p", { class: "roles-note", "data-testid": "roles-note" });
  const list = h("ul", { class: "roles-list", "data-testid": "roles-list" });
  const app = h("div", { class: "roles-app" }, h("div", { class: "roles-head" }, h("h2", { class: "roles-title" }, "Roles"), picker), status, note, list);
  contentEl.replaceChildren(app);
  // C30: a second view, "Run limits", beside the per-repo roles.
  const limits = addRunLimitsView(app);

  function render() {
    status.textContent = error;
    status.classList.toggle("roles-error", !!error && !!repoId);
    picker.replaceChildren(...repos.map((r) => h("option", { value: r.id, selected: r.id === repoId }, r.product)));
    picker.hidden = repos.length === 0;
    note.textContent = roles && !isAdmin ? NOT_ALLOWED : "";
    renderList();
  }

  function rowProps(r) {
    return { canEdit: isAdmin, busy: busy.has(r.role), err: errs.get(r.role) || null, change, key, pointer, blur };
  }

  function renderList() {
    picker.disabled = busy.size > 0;
    list.replaceChildren(...(roles ? roles.map((r) => roleRow(r, rowProps(r))) : []));
  }

  // Redraws one row in place. Focus goes back only if it was on that row (or
  // nowhere), so a save never pulls it away from wherever the user moved.
  function paint(role, field) {
    const old = list.querySelector('[data-role="' + role + '"]');
    const r = roles && roles.find((x) => x.role === role);
    if (!old || !r) return;
    const at = document.activeElement;
    const own = !!at && old.contains(at);
    // A 422 sends focus back to its field only if focus was on the row or nowhere.
    const back = own || !at || at === document.body;
    const target = errs.has(role) ? (back ? errs.get(role).field : null) : own ? at.getAttribute("data-field") : back ? field : null;
    old.replaceWith(roleRow(r, rowProps(r)));
    const el = target && list.querySelector('[data-role="' + role + '"] [data-field="' + target + '"]');
    if (el) el.focus();
  }

  // A change made with the keyboard is held until Enter or leaving the control,
  // so stepping through options saves only where the user stops. Pointer and
  // touch changes save at once.
  function change(role, field, value) {
    if (!viaKey) {
      held.delete(role);
      return save(role, field, value);
    }
    held.set(role, { field, value });
    status.textContent = "Press Enter or move on to save.";
  }
  function key(ev, role) {
    viaKey = true;
    if (ev.key === "Enter") commit(role);
  }
  function pointer() {
    viaKey = false;
  }
  function blur(role) {
    commit(role);
  }
  function commit(role) {
    const hold = held.get(role);
    if (!hold) return;
    held.delete(role);
    save(role, hold.field, hold.value);
  }

  // One PATCH with the changed field only. On any failure the row goes back to
  // what the server last said and shows why.
  async function save(role, field, value) {
    if (!repoId) return;
    if (busy.has(role)) {
      queued.set(role, { field, value });
      return;
    }
    // A refresh already on its way would land over this edit: drop it, redo it after.
    if (loading && ctl) {
      ctl.abort();
      seq++;
      loading = false;
      stale = true;
    }
    errs.delete(role);
    busy.add(role);
    status.textContent = "";
    picker.disabled = true;
    const row = list.querySelector('[data-role="' + role + '"]');
    if (row) row.setAttribute("aria-busy", "true");
    let failed = null;
    try {
      const body = field === "mode" ? { mode: value } : { model: value === "" ? null : value };
      const next = await api("PATCH", "/api/v1/repos/" + encodeURIComponent(repoId) + "/roles/" + encodeURIComponent(role), body);
      if (roles) roles = roles.map((r) => (r.role === role ? next : r));
    } catch (e) {
      failed = failure(e, field);
      errs.set(role, failed);
    }
    busy.delete(role);
    if (closed) return;
    const again = queued.get(role);
    queued.delete(role);
    if (again && !failed) {
      save(role, again.field, again.value);
      return;
    }
    picker.disabled = busy.size > 0;
    paint(role, field);
    if (!failed) status.textContent = "Saved";
    if (stale && busy.size === 0 && held.size === 0) {
      stale = false;
      load();
    }
  }

  async function loadRoles(signal) {
    const res = await api("GET", "/api/v1/repos/" + encodeURIComponent(repoId) + "/roles", undefined, signal);
    roles = res.data;
  }

  // Starts a fresh load and drops the response of any older one.
  function begin() {
    if (ctl) ctl.abort();
    ctl = new AbortController();
    loading = true;
    return { mine: ++seq, signal: ctl.signal };
  }

  async function load() {
    const { mine, signal } = begin();
    try {
      const [nextRepos, admin] = await Promise.all([loadRepos(signal), loadIsAdmin(signal)]);
      if (mine !== seq) return;
      repos = nextRepos;
      isAdmin = admin;
      const saved = getItem(REPO_KEY);
      if (!repos.some((r) => r.id === repoId)) repoId = repos.some((r) => r.id === saved) ? saved : repos.length ? repos[0].id : null;
      if (repoId) await loadRoles(signal);
      else roles = null;
      if (mine !== seq) return;
      error = repoId ? "" : "No repos are installed yet.";
    } catch (e) {
      if ((e && e.name === "AbortError") || mine !== seq) return;
      roles = null;
      error = UNAVAILABLE;
    }
    loading = false;
    render();
  }

  async function choose(id) {
    repoId = id;
    // The old repo's rows must not stay editable while the new one loads.
    roles = null;
    errs.clear();
    held.clear();
    queued.clear();
    renderList();
    setItem(REPO_KEY, id);
    const { mine, signal } = begin();
    try {
      await loadRoles(signal);
      error = "";
    } catch (e) {
      if ((e && e.name === "AbortError") || mine !== seq) return;
      roles = null;
      error = UNAVAILABLE;
    }
    if (mine === seq) {
      loading = false;
      render();
    }
  }

  // A refresh waits for a save in flight rather than redrawing under it.
  const off = onRefresh(() => {
    if (busy.size > 0 || held.size > 0) stale = true;
    else load();
  });
  load();

  return {
    destroy() {
      closed = true;
      off();
      limits.destroy();
      seq++;
      if (ctl) ctl.abort();
      contentEl.replaceChildren();
    },
  };
}

let current = null;

FULC.register({
  id: "roles",
  title: "Roles",
  icon: "R",
  defaultSize: { w: 820, h: 560 },
  onOpen({ contentEl }) {
    if (current) current.destroy();
    current = mountApp(contentEl);
  },
  onClose() {
    if (current) current.destroy();
    current = null;
  },
});
