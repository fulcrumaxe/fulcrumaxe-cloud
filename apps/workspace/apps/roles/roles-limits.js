// D#37 WS-F4c: the "Run limits" view of the Roles app. Rules this file keeps:
//   * Every node is built with h(), so server text renders as text.
//   * Floors, ceilings, defaults and resolved values come only from the
//     GET /api/v1/run-limits response. Nothing is computed or hard-coded here.
//   * A save is one PUT with all eight fields; an inherited field is null.
//   * A refresh never overwrites a form with unsaved edits.
import { h } from "../_lib/dom.js";
import { api } from "../_lib/api.js";
import { onRefresh } from "../../core/cloud-live.js";

export const INTRO = "These limits apply to every repo in this account.";
export const WHAT_HAPPENS =
  "When a run reaches a limit, its work isn't lost. If it's still making progress and your spend caps allow, it's extended, up to the extensions you set. Otherwise it stops with a checkpoint and continues in a new run: automatically, up to the automatic-continue count, or when you press Continue in Pipeline. Limits never go above your monthly budget or the platform ceilings.";
export const MEMBER_NOTE = "Only owners and admins can change these.";
export const NOT_ALLOWED = "Only owners and admins can change run limits.";
const UNAVAILABLE = "Run limits aren't available right now.";
const SAVE_FAILED = "That change couldn't be saved. Try again.";
const CHANGED = "Changed elsewhere, reload?";

// group 0 is "Limits", group 1 "When a limit is reached". `shown` fields are on
// every list row; shown 1 is what a phone row keeps.
export const FIELDS = [
  { key: "max_run_minutes", label: "Run time", unit: "minutes", group: 0, shown: 1 },
  { key: "max_turns", label: "Turns", unit: "", group: 0, shown: 2 },
  { key: "max_model_calls", label: "Model calls", unit: "", group: 0, shown: 2 },
  { key: "silence_minutes", label: "Silence", unit: "minutes", group: 0, shown: 2 },
  { key: "per_run_usd", label: "Spend per run", unit: "USD", usd: true, group: 0, shown: 1 },
  { key: "max_extensions", label: "Extensions per run", unit: "", group: 1 },
  { key: "max_resumes", label: "Automatic continues", unit: "", group: 1 },
  { key: "auto_resume", label: "Continue automatically", bool: true, group: 1 },
];
const GROUPS = ["Limits", "When a limit is reached"];

export const roleLabel = (r) => (r.role === "default" ? "Account default" : "fulcrumaxe " + r.role);

// Where a row's resolved value comes from, read off the response's stored values.
export function sourceOf(data, r, key) {
  if (r.role !== "default" && r.stored[key] != null) return "set for this role";
  return data.default.stored[key] != null ? "account default" : "platform default";
}

// What "Inherit" would give this row, and from where.
export function inheritsFrom(data, r, key) {
  if (r.role === "default") return { value: data.bounds[key].default, source: "platform default" };
  return { value: data.default.resolved[key], source: data.default.stored[key] != null ? "account default" : "platform default" };
}

export function show(f, value) {
  if (f.bool) return value ? "on" : "off";
  if (f.usd) return "$" + Number(value).toFixed(2);
  return f.unit ? value + " " + f.unit : String(value);
}

// One typed number, against the response's bounds for that field.
export function check(f, raw, bounds) {
  const s = String(raw).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return { error: "Enter a number." };
  if (!f.usd && !/^\d+$/.test(s)) return { error: "Use a whole number." };
  if (f.usd && !/^\d+(\.\d{1,2})?$/.test(s)) return { error: "Use at most 2 decimals." };
  const n = Number(s);
  if (n < bounds.floor || n > bounds.ceiling) return { error: "Between " + bounds.floor + " and " + bounds.ceiling + "." };
  return { value: n };
}

// The form's starting values: a null stored value is "inherit".
export function initialValues(r) {
  const out = {};
  for (const f of FIELDS) {
    const v = r.stored[f.key];
    out[f.key] = f.bool ? (v == null ? "inherit" : v ? "on" : "off") : { inherit: v == null, raw: v == null ? "" : String(v) };
  }
  return out;
}

// The PUT body: all eight keys, null where inherited. Nothing is sent if `errors` has anything.
export function buildBody(values, bounds) {
  const body = {};
  const errors = {};
  for (const f of FIELDS) {
    const v = values[f.key];
    if (f.bool) body[f.key] = v === "on" ? true : v === "off" ? false : null;
    else if (v.inherit) body[f.key] = null;
    else {
      const r = check(f, v.raw, bounds[f.key]);
      if (r.error) errors[f.key] = r.error;
      else body[f.key] = r.value;
    }
  }
  return { body, errors };
}

// A failed save: a 422 belongs to the field its path names (its message is the
// server's own explanation); anything else is a fixed sentence of this app's.
export function failureFor(e) {
  if (e && e.status === 422) {
    const path = e.details && e.details[0] && e.details[0].path;
    return { field: FIELDS.some((f) => f.key === path) ? path : null, text: e.message };
  }
  return { field: null, text: e && e.status === 403 ? NOT_ALLOWED : SAVE_FAILED };
}

// What a `refresh` does: never while saving, never over unsaved edits.
export function refreshAction({ editing, dirty, saving }) {
  if (saving) return "later";
  return editing && dirty ? "note" : "load";
}

async function loadIsAdmin(signal) {
  try {
    return !!(await api("GET", "/api/cloud/auth/me", undefined, signal)).is_admin;
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    return false;
  }
}

function mountRunLimits(host) {
  let data = null;
  let isAdmin = false;
  let editing = null; // the role being edited; null shows the list
  let [dirty, saving, stale, force, closed] = [false, false, false, false, false];
  let [seq, ctl, fields] = [0, null, {}];

  const status = h("p", { class: "rl-status", role: "status", "aria-live": "polite", "data-testid": "rl-status" });
  const note = h("p", { class: "rl-note", "data-testid": "rl-note" });
  const body = h("div", { class: "rl-body" });
  const what = h("section", { class: "rl-what", "data-testid": "rl-what", "aria-labelledby": "rl-what-h" }, h("h3", { id: "rl-what-h", class: "rl-h" }, "What happens at a limit"), h("p", null, WHAT_HAPPENS));
  host.replaceChildren(h("p", { class: "rl-intro", "data-testid": "rl-intro" }, INTRO), status, note, body, what);

  const all = () => [data.default, ...data.roles];
  const btn = (text, testid, onClick, type = "button") => h("button", { type, class: "rl-btn", "data-testid": testid, onClick }, text);

  function render() {
    note.textContent = data && !isAdmin ? MEMBER_NOTE : "";
    const r = editing && data && all().find((x) => x.role === editing);
    if (!r) editing = null;
    host.classList.toggle("rl-editing", !!editing);
    body.replaceChildren(r ? form(r) : data ? list() : "");
  }

  function list() {
    return h("ul", { class: "rl-list", "data-testid": "rl-list" }, all().map((r) =>
      h("li", { class: "rl-row", "data-role": r.role, "data-testid": "rl-row" },
        h("span", { class: "rl-name" }, roleLabel(r)),
        isAdmin ? h("button", { type: "button", class: "rl-btn", "data-testid": "rl-edit", "aria-label": "Edit " + roleLabel(r), onClick: () => edit(r.role) }, "Edit") : null,
        h("dl", { class: "rl-facts" }, FIELDS.filter((f) => f.shown).map((f) =>
          h("div", { class: "rl-fact rl-fact-" + f.shown, "data-field": f.key }, h("dt", null, f.label),
            h("dd", null, show(f, r.resolved[f.key]), h("span", { class: "rl-source" }, " " + sourceOf(data, r, f.key))))
        ))
      )
    ));
  }

  function field(f, r, v) {
    const id = "rl-" + r.role + "-" + f.key;
    const b = data.bounds[f.key];
    const inh = inheritsFrom(data, r, f.key);
    const err = h("p", { class: "rl-field-error", id: id + "-err", role: "alert", hidden: true, "data-testid": "rl-error-" + f.key });
    const hint = h("span", { class: "rl-hint", id: id + "-hint" }, (f.bool ? "" : "Between " + b.floor + " and " + b.ceiling + ". ") + "Inherits " + show(f, inh.value) + " from " + inh.source + ".");
    const common = { id, class: "rl-input", "aria-describedby": id + "-hint " + id + "-err", "data-testid": "rl-input-" + f.key };
    let input;
    let inherit = null;
    if (f.bool) {
      input = h("select", common, ["inherit", "on", "off"].map((o) => h("option", { value: o, selected: o === v }, o === "inherit" ? "Inherit" : o === "on" ? "On" : "Off")));
    } else {
      input = h("input", { ...common, type: "number", min: b.floor, max: b.ceiling, step: f.usd ? "0.01" : "1", inputmode: f.usd ? "decimal" : "numeric", value: v.raw, disabled: v.inherit });
      inherit = h("input", { type: "checkbox", checked: v.inherit, "data-testid": "rl-inherit-" + f.key, onChange: (ev) => { input.disabled = ev.target.checked; setError(f.key, ""); } });
    }
    fields[f.key] = { input, inherit, err };
    return h("div", { class: "rl-field" }, h("label", { for: id, class: "rl-label" }, f.label + (f.unit ? " (" + f.unit + ")" : "")), input,
      inherit ? h("label", { class: "rl-inherit" }, inherit, " Inherit") : null, hint, err);
  }

  function form(r) {
    fields = {};
    const values = initialValues(r);
    const el = h("form", { class: "rl-form", novalidate: true, "aria-labelledby": "rl-form-h", "data-testid": "rl-form", onSubmit: (ev) => submit(ev, r) },
      h("h3", { id: "rl-form-h", class: "rl-h" }, "Edit " + roleLabel(r)),
      h("p", { class: "rl-changed", role: "status", hidden: true, "data-testid": "rl-changed" }, CHANGED + " ", btn("Reload", "rl-reload", reload)),
      GROUPS.map((g, i) => h("fieldset", { class: "rl-group" }, h("legend", null, g), FIELDS.filter((f) => f.group === i).map((f) => field(f, r, values[f.key])))),
      h("p", { class: "rl-form-error", role: "alert", hidden: true, "data-testid": "rl-form-error" }),
      h("div", { class: "rl-actions" }, btn("Save", "rl-save", undefined, "submit"), btn("Cancel", "rl-cancel", () => close(r.role)))
    );
    el.addEventListener("input", () => (dirty = true));
    el.addEventListener("change", () => (dirty = true));
    return el;
  }

  function setError(key, text) {
    const f = fields[key];
    if (!f) return;
    f.err.textContent = text;
    f.err.hidden = !text;
    f.input.setAttribute("aria-invalid", text ? "true" : "false");
  }

  function edit(role) {
    editing = role;
    dirty = false;
    stale = false;
    status.textContent = "";
    render();
    const first = body.querySelector(".rl-input:not(:disabled)");
    if (first) first.focus();
  }

  function close(role) {
    editing = null;
    dirty = false;
    render();
    const el = body.querySelector('[data-role="' + role + '"] [data-testid="rl-edit"]');
    if (el) el.focus();
    if (stale) load();
  }

  async function submit(ev, r) {
    ev.preventDefault();
    if (saving) return;
    const values = {};
    for (const f of FIELDS) {
      const c = fields[f.key];
      values[f.key] = f.bool ? c.input.value : { inherit: c.inherit.checked, raw: c.input.value };
    }
    const { body: put, errors } = buildBody(values, data.bounds);
    for (const f of FIELDS) setError(f.key, errors[f.key] || "");
    const formError = body.querySelector(".rl-form-error");
    formError.hidden = true;
    const bad = FIELDS.find((f) => errors[f.key]);
    if (bad) return fields[bad.key].input.focus();
    saving = true;
    try {
      const next = await api("PUT", "/api/v1/run-limits/" + encodeURIComponent(r.role), put);
      saving = false;
      if (closed) return;
      if (r.role === "default") data.default = next;
      else data.roles = data.roles.map((x) => (x.role === r.role ? next : x));
      close(r.role);
      status.textContent = "Saved";
      // The account default feeds every role's inherited values.
      if (r.role === "default") load();
    } catch (e) {
      saving = false;
      if (closed) return;
      const f = failureFor(e);
      if (f.field) {
        setError(f.field, f.text);
        fields[f.field].input.focus();
      } else {
        formError.textContent = f.text;
        formError.hidden = false;
      }
      if (stale) body.querySelector(".rl-changed").hidden = false;
    }
  }

  async function load() {
    if (ctl) ctl.abort();
    ctl = new AbortController();
    const mine = ++seq;
    stale = false;
    try {
      const [next, admin] = await Promise.all([api("GET", "/api/v1/run-limits", undefined, ctl.signal), loadIsAdmin(ctl.signal)]);
      if (mine !== seq) return;
      const was = editing && all().find((x) => x.role === editing);
      const now = editing && [next.default, ...next.roles].find((x) => x.role === editing);
      data = next;
      isAdmin = admin;
      if (status.textContent === UNAVAILABLE) status.textContent = "";
      // A form the user has not touched stays put unless its own values changed.
      if (was && now && !force && !dirty && JSON.stringify(was.stored) === JSON.stringify(now.stored)) return;
      force = false;
    } catch (e) {
      if ((e && e.name === "AbortError") || mine !== seq) return;
      if (!data) status.textContent = UNAVAILABLE;
    }
    render();
  }

  function reload() {
    dirty = false;
    force = true;
    load();
  }

  const off = onRefresh(() => {
    const a = refreshAction({ editing, dirty, saving });
    if (a === "load") return load();
    stale = true;
    const c = body.querySelector(".rl-changed");
    if (a === "note" && c) c.hidden = false;
  });
  load();

  return {
    destroy() {
      closed = true;
      off();
      seq++;
      if (ctl) ctl.abort();
      host.replaceChildren();
    },
  };
}

// Wraps the Roles app's own content in a "Roles" panel and adds the "Run limits"
// tab beside it. The Run limits view mounts (and its one GET goes out) the first
// time its tab opens.
export function addRunLimitsView(app) {
  const panel = (id, ...kids) => h("div", { class: "roles-panel", id: "roles-panel-" + id, role: "tabpanel", "aria-labelledby": "roles-tab-" + id }, ...kids);
  const views = [
    { id: "roles", label: "Roles", panel: panel("roles", ...Array.from(app.childNodes)) },
    { id: "limits", label: "Run limits", panel: panel("limits") },
  ];
  let mounted = null;
  const pick = (v, focus) => {
    for (const o of views) {
      o.tab.setAttribute("aria-selected", String(o === v));
      o.tab.tabIndex = o === v ? 0 : -1;
      o.panel.hidden = o !== v;
    }
    if (v.id === "limits" && !mounted) mounted = mountRunLimits(v.panel);
    if (focus) v.tab.focus();
  };
  views.forEach((v, i) => {
    const step = (ev) => {
      const n = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: views.length - 1 }[ev.key];
      if (n === undefined) return;
      ev.preventDefault();
      pick(views[(n + views.length) % views.length], true);
    };
    v.tab = h("button", { type: "button", class: "roles-tab", role: "tab", id: "roles-tab-" + v.id, "aria-controls": "roles-panel-" + v.id, "data-testid": "roles-tab-" + v.id, onClick: () => pick(v, false), onKeydown: step }, v.label);
  });
  // dom-insert-ok: the loop above set a tab on every view, and each view's panel is built with panel()
  app.replaceChildren(h("div", { class: "roles-tabs", role: "tablist", "aria-label": "Roles views" }, views.map((v) => v.tab)), ...views.map((v) => v.panel));
  pick(views[0], false);
  return { destroy: () => mounted && mounted.destroy() };
}
