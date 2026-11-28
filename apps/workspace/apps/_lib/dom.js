import { api, isRateLimited, retryWords, waitSeconds } from "./api.js";
// Shared DOM helpers for first-party apps (D#37 WS-F0b). Moved from the
// Developer app; no app copies them or imports another app's files.

// A minimal DOM builder: h("div", { class: "x", onClick: fn }, child, ...).
// It only ever calls createElement / createTextNode / setAttribute, so
// children are text, never markup. (The shell has the same helper in
// runtime/h.js; importing it would cost one more boot request, so the apps
// share this one.)
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const key of Object.keys(props)) {
      const v = props[key];
      if (v == null || v === false) continue;
      if (key === "class") el.className = String(v);
      else if (key.startsWith("on") && typeof v === "function") el.addEventListener(key.slice(2).toLowerCase(), v);
      else if (key in el) el[key] = v;
      else el.setAttribute(key, String(v));
    }
  }
  const add = (c) => {
    if (c == null || c === false || c === true) return;
    if (Array.isArray(c)) c.forEach(add);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  };
  children.forEach(add);
  return el;
}

function formatDate(iso, withTime) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return withTime
    ? d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : d.toLocaleDateString(undefined, { dateStyle: "medium" });
}

export function timeNode(iso, withTime) {
  return h("time", { datetime: iso, title: iso }, formatDate(iso, withTime));
}

export async function confirmAction(message) {
  // Refuse rather than proceed unconfirmed if the themed dialog is missing.
  if (typeof window.fulcConfirm !== "function") return false;
  return (await window.fulcConfirm(message)) === true;
}

/** "10:03:30 UTC" for an ISO time, or null when it is not one. UTC, like the other times the runner screens word (a reset time). */
export function clockText(iso) {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString().slice(11, 19) + " UTC" : null;
}

/**
 * The one currency formatter of the workspace apps (here because a new _lib file would cost a boot request). A dollar figure the server sends is drawn exactly
 * as sent, up to the four decimals the cloud keeps: 600 -> $600.00, 12.3456 -> $12.3456, 0.0042 -> $0.0042. Budget & Billing, the Pipeline and Runs API-equivalent
 * lines and the Team app's Cost panel all use it, so one figure never reads two ways. A value that is not a finite number reads "Unavailable", never $0 or NaN.
 */
export function usd(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "Unavailable";
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

// ───────── D#600 CX-9b: the context rules panel ─────────
// D#600 CX-9b: the context rules panel, shared by the Repos app (a repository's rules and its budget) and the Pipeline item pane (one item's rules).
// Lives in this file because each new app file costs a boot request and the boot budget is full. A pin keeps a file in the run's prompt; an exclude keeps a path out of what the
// agent may read. Paths are typed (no route lists a repository's files) and checked here with the same rules the server applies; the server stays the
// judge. Every sentence is in the tables below, chosen by the closed wire code, never the server's text. The lists and the budget are re-read after
// every write, so the screen cannot disagree with what is stored. Nothing here reads a file; an empty or missing value never reaches the screen.

/** Files read per run. The same number as PINS_MAX_READ in packages/runner-protocol/src/pinRules.ts; a test fails if the two differ. */
export const PINS_MAX_READ = 40;
export const UNDO_MS = 10000;
const RULES_URL = "/api/v1/context-rules";
const settingsUrl = (id) => "/api/v1/repos/" + encodeURIComponent(id) + "/context-settings";
const itemUrl = (id) => "/api/v1/work-items/" + encodeURIComponent(id) + "/context-settings";
export const ADMIN_ONLY = "Only owners and admins can change this.";
const GENERIC = "That change couldn't be saved. Try again.";

/** Every fixed sentence of the panel. A function entry builds a sentence from a name or a number the person can see. */
export const COPY = {
  title: "Context rules", applies: "Applies from the next run", pin: "Pinned", exclude: "Kept out of context",
  help: "Not a security boundary: tests and shell commands can still read it",
  scopeItem: "This item", scopeRepo: "Whole repo", scopeLabel: "Applies to",
  bracket: "In an exclude, [id] is glob syntax, so it does not match a folder named [id]. Use ? or *, or exclude the parent.",
  pathMissing: (sha) => "Path not found at " + String(sha).slice(0, 7),
  sameName: (folder) => "Same file name as another rule. Told apart by the folder " + folder + ".", topLevel: "the top level",
  empty: "No rules yet. Pin a file to always include it, or keep a path out of context.",
  loading: "Loading rules...", loadFailed: "Rules aren't available right now.",
  readLimit: (n) => "A run reads at most " + n + " of the pinned files. The rest are saved but not read.",
  readdsPins: "Removing this exclude puts pinned files back in this item's runs, and they no longer fit the budget. Remove it anyway?",
  removeAnyway: "Remove anyway", keepIt: "Keep it", retry: "Retry", undo: "Undo", remove: "Remove", add: "Add rule",
  pathLabel: "Repository path", kindLabel: "Rule", kindPin: "Pin (always include)", kindExclude: "Keep out of context", adminOnly: ADMIN_ONLY,
  keepOut: "Keep out of context", added: (path) => "Saved " + path + ".", removed: (path) => "Removed " + path + ".", restored: (path) => "Restored " + path + ".", tooMany: "Too many changes.",
  budgetTitle: "Context budget", budgetLoading: "Loading budget...", budgetFailed: "The budget isn't available right now.",
  budgetNow: (bytes, scope = "repo") => (bytes === null ? (scope === "repo" ? "Now: each role's default." : "Now: none set for this " + scope + ".") : "Now: " + bytes + " bytes."), budgetField: "Budget in bytes",
  consumers: "Today only the build's prompt uses a budget.", budgetFor: "Budget for", levelRepo: "Whole repository", levelItem: "This item",
  sources: { item: "set for this item", role: "set for this role", repo: "set for this repository", default: "role default" },
  budgetRange: (lo, hi) => "Enter a whole number from " + lo + " to " + hi + ".", save: "Save budget", reset: "Reset to default", defaults: "What each role is held to now",
  saved: "Budget saved. Applies from the next run.", fit: "Your pins fit this budget.",
  overBudget: "Your pins are over this budget. They are never cut to fit it during a run.",
  changedElsewhere: "This rule was changed somewhere else, so it was not restored. The list now shows what is there.",
  notMeasured: "Your pins couldn't be checked against this budget just now. The budget was saved.",
};
const ROLE_NAMES = { executor: "Executor", fix: "Fix", "code-reviewer": "Code reviewer", "acceptance-tester": "Acceptance tester", "security-reviewer": "Security reviewer", debater: "Debater" };
/** The sentence for each refusal, keyed on the codes the routes send. */
export const REFUSALS = {
  pins_exceed_budget: "These pins would not fit this repository's context budget, so nothing was saved. Raise the budget or pin fewer files.",
  pins_exceed_ceiling: "This would pass the most pinned files a run can carry, so nothing was saved.",
  excludes_exceed_cap: "This would pass the most excluded paths a run can hold, so nothing was saved.",
  exclude_readds_pins: COPY.readdsPins,
  budget_out_of_range: "That size is outside the allowed range, so nothing was saved.",
  invalid_path: "That path can't be used. Use a path inside the repository, such as src/app.ts. A pin can't contain * or ?.",
  context_rules_busy: "Another change to this repository's rules is in progress. Try again in a moment.",
  tree_truncated: "This repository is too large to check its pins, so nothing was saved.",
  tree_unavailable: "The repository couldn't be read just now, so nothing was saved. Try again.",
  repo_not_connected: "This repository isn't connected, so nothing was saved.",
  insufficient_role: ADMIN_ONLY,
  not_found: "That rule, item or repository no longer exists. Reload to see what is there now.",
};

/** The sentence for a failed call: by code, then by status; a 429 counts down; anything else is the generic one. */
export function refusalSentence(e) {
  if (isRateLimited(e)) return COPY.tooMany + " " + retryWords(waitSeconds(e));
  const code = e && e.code;
  if (typeof code === "string" && Object.hasOwn(REFUSALS, code)) return REFUSALS[code];
  return e && e.status === 403 ? REFUSALS.insufficient_role : e && e.status === 404 ? REFUSALS.not_found : GENERIC;
}

/** The server's path rules, for a first answer without a request: repository-relative, 512 characters at most, and a pin holds no * or ?. */
export function checkPath(path, kind) {
  if (typeof path !== "string" || path === "" || [...path].length > 512 || /[\p{Cc}\\]/u.test(path) || path.startsWith("/") || path.startsWith("~")) return false;
  if (path.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return false;
  return kind !== "pin" || !/[*?]/.test(path);
}

const pickRule = (r) =>
  r && typeof r.id === "string" && (r.kind === "pin" || r.kind === "exclude") && (r.scope === "repo" || r.scope === "item") && typeof r.path === "string" && r.path !== ""
    ? { id: r.id, kind: r.kind, scope: r.scope, path: r.path, ...(r.kind === "pin" && typeof r.missing_at === "string" && /^[0-9a-f]{7,40}$/.test(r.missing_at) ? { missing_at: r.missing_at } : {}) } : null;

/** The folder (with its trailing slash) and the file name of a path. */
export function splitPath(path) {
  const i = path.lastIndexOf("/");
  return { dir: path.slice(0, i + 1), name: path.slice(i + 1) };
}

/** For rules that share a file name: the nearest folder (as few trailing segments as will do) that tells each from the others. A Map of rule key to folder text. */
export function distinguishing(rules) {
  const byName = new Map();
  for (const r of rules) byName.set(splitPath(r.path).name, [...(byName.get(splitPath(r.path).name) || []), r]);
  const out = new Map();
  for (const group of byName.values()) {
    const paths = [...new Set(group.map((r) => r.path))];
    if (paths.length < 2) continue;
    const dirs = paths.map((p) => p.split("/").slice(0, -1));
    const tail = (d, k) => d.slice(Math.max(0, d.length - k)).join("/");
    for (const r of group) {
      const mine = r.path.split("/").slice(0, -1);
      let k = 1;
      while (k <= mine.length && dirs.some((d) => d !== dirs[paths.indexOf(r.path)] && tail(d, k) === tail(mine, k))) k++;
      out.set(r.scope + ":" + r.path, mine.length === 0 ? COPY.topLevel : tail(mine, Math.min(k, mine.length)) + "/");
    }
  }
  return out;
}

/** What the list shows: rows sorted by path, each with the display parts and whether this person may change it. */
export function ruleRows(rules, { isAdmin }) {
  const told = distinguishing(rules);
  return [...rules].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.scope < b.scope ? -1 : 1)).map((r) => {
    const key = r.scope + ":" + r.path;
    return { ...r, key, ...splitPath(r.path), told: told.get(key) || "", bracket: r.kind === "exclude" && r.path.includes("["), canEdit: r.scope === "item" || isAdmin };
  });
}

/** The read-limit sentence when the set holds more pins than a run reads, else "" (exactly the limit shows none). */
export const readLimitLine = (rules) => (rules.filter((r) => r.kind === "pin").length > PINS_MAX_READ ? COPY.readLimit(PINS_MAX_READ) : "");

/** The budget's sentence after a write, by the answer's pins_status. */
export const budgetStatusLine = (status) => (status === "over_budget" ? COPY.overBudget : status === "not_measured" ? COPY.notMeasured : status === "fit" ? COPY.fit : "");

/** The whole bytes typed for the budget, or "" with the reason when it isn't one in range. */
export function budgetInput(text, view) {
  const n = /^\d{1,9}$/.test(String(text).trim()) ? Number(String(text).trim()) : NaN;
  return n >= view.min_bytes && n <= view.max_bytes ? { ok: true, bytes: n } : { ok: false, text: COPY.budgetRange(view.min_bytes, view.max_bytes) };
}
const intOrNull = (x) => x === null || Number.isInteger(x);
/** The repository's answer (its own size and each role's) or an item's (its own size), as the levels a person can set and the size each role is held to, with the level that said so. */
function pickView(v) {
  if (!v || !Number.isInteger(v.min_bytes) || !Number.isInteger(v.max_bytes) || !v.role_defaults || typeof v.role_defaults !== "object" || !v.effective_by_role || !v.source_by_role || !Array.isArray(v.consuming_roles) || v.consuming_roles.length === 0) return null;
  // Only roles whose runs use a budget today are shown or offered; the server names them.
  const effective = Object.entries(v.effective_by_role).filter(([role, n]) => Number.isInteger(n) && v.consuming_roles.includes(role)).map(([role, n]) => [role, n, COPY.sources[v.source_by_role[role]] || COPY.sources.default]);
  const defaults = Object.entries(v.role_defaults).filter(([role, n]) => Number.isInteger(n) && v.consuming_roles.includes(role));
  const common = { min_bytes: v.min_bytes, max_bytes: v.max_bytes, defaults, effective };
  if ("item_budget_bytes" in v) return intOrNull(v.item_budget_bytes) ? { ...common, bytes: v.item_budget_bytes, levels: [{ key: "item", scope: "item", label: COPY.levelItem, bytes: v.item_budget_bytes, min: v.min_bytes, max: v.max_bytes }] } : null;
  if (!intOrNull(v.context_budget_bytes) || !v.role_budgets || !v.role_max) return null;
  const roles = effective.map(([role]) => ({ key: role, scope: "role", label: ROLE_NAMES[role] || role, bytes: Number.isInteger(v.role_budgets[role]) ? v.role_budgets[role] : null, min: v.min_bytes, max: Number.isInteger(v.role_max[role]) ? v.role_max[role] : v.max_bytes }));
  return { ...common, bytes: v.context_budget_bytes, levels: [{ key: "repo", scope: "repo", label: COPY.levelRepo, bytes: v.context_budget_bytes, min: v.min_bytes, max: v.max_bytes }, ...roles] };
}
const sizeText = (n) => (n % 1024 === 0 ? n / 1024 + " KiB" : n + " bytes");
const cancelled = (e) => !!e && e.name === "AbortError";

/**
 * The rules' state and writes, no DOM. target is { repoId } for a repository's rules or { repoId, itemId } for an item's (the list then holds the rules in
 * force for the item, each with its scope). call(method, path, body) runs a request. A write returns "ok", "warned" (a removal that needs a confirmation) or
 * "failed" (state.error holds the sentence and the retry). state.error is cleared by the next action.
 */
export function createRulesController({ call, getAdmin, target, onChange = () => {} }) {
  const s = { load: "idle", rules: [], isAdmin: false, busy: false, error: null, warn: null, scope: target.itemId ? "item" : "repo" };
  let gen = 0;
  const listUrl = () => RULES_URL + "?" + (target.itemId ? "work_item_id=" + encodeURIComponent(target.itemId) : "repo_id=" + encodeURIComponent(target.repoId));
  const body = (scope, kind, path) => (scope === "item" ? { scope, work_item_id: target.itemId, kind, path } : { scope, repo_id: target.repoId, kind, path });
  const changed = () => onChange(s);

  async function load(quiet) {
    const mine = ++gen;
    if (!quiet) { s.load = "loading"; changed(); }
    try {
      const res = await call("GET", listUrl());
      if (mine !== gen) return;
      s.rules = Array.isArray(res && res.data) ? res.data.map(pickRule).filter(Boolean) : [];
      s.load = "ok";
    } catch (e) {
      if (cancelled(e) || mine !== gen) return;
      s.load = "error";
    }
    changed();
  }
  async function start() {
    s.isAdmin = await getAdmin();
    return load(false);
  }
  /** Runs one write, then re-reads. fn may return { warn } to stop at a confirmation. */
  async function attempt(fn, retry) {
    if (s.busy) return "failed";
    s.busy = true; s.error = null; s.warn = null; changed();
    try {
      const r = await fn();
      s.busy = false;
      if (r && r.warn) { s.warn = r.warn; changed(); return "warned"; }
    } catch (e) {
      s.busy = false;
      if (cancelled(e)) return "failed";
      if (e && e.status === 403) s.isAdmin = false; // demoted under us: the read-only view
      s.error = { text: refusalSentence(e), code: e && e.code, retry };
      changed();
      return "failed";
    }
    await load(true);
    return s.load === "ok" ? "ok" : "failed";
  }
  const refuseHere = () => { s.error = { text: REFUSALS.invalid_path, code: "invalid_path", retry: null }; s.warn = null; changed(); return "failed"; };
  /** retry, when given, is what the Retry button runs (the view's own, so a retried save ends the way a first try does). */
  const add = (path, kind, scope, retry) => {
    const p = String(path).trim();
    return checkPath(p, kind) ? attempt(() => call("PUT", RULES_URL, body(scope, kind, p)), retry || (() => add(path, kind, scope))) : refuseHere();
  };
  /** The other kind on the same path in the same scope (the route replaces the rule). A glob exclude can't become a pin. */
  const toggle = (rule) => {
    const kind = rule.kind === "pin" ? "exclude" : "pin";
    return checkPath(rule.path, kind) ? attempt(() => call("PUT", RULES_URL, body(rule.scope, kind, rule.path)), () => toggle(rule)) : refuseHere();
  };
  /** Undo: re-read the list first. If anything now sits at that scope and path, another tab changed it, so nothing is written and the list is shown as it is. */
  const restore = async (rule, retry) => {
    let clash = false;
    const out = await attempt(async () => {
      const res = await call("GET", listUrl());
      const now = Array.isArray(res && res.data) ? res.data.map(pickRule).filter(Boolean) : [];
      if (now.some((r) => r.scope === rule.scope && r.path === rule.path)) { clash = true; throw new Error("rule changed elsewhere"); }
      if (!checkPath(rule.path, rule.kind)) throw Object.assign(new Error("bad path"), { code: "invalid_path" });
      await call("PUT", RULES_URL, body(rule.scope, rule.kind, rule.path));
    }, retry || (() => restore(rule)));
    if (clash) { s.error = { text: COPY.changedElsewhere, code: "rule_changed_elsewhere", retry: null }; await load(true); }
    return out;
  };
  const remove = (rule, confirm, retry) =>
    attempt(async () => {
      try { await call("DELETE", RULES_URL + "/" + encodeURIComponent(rule.id) + (confirm ? "?confirm=true" : "")); }
      catch (e) { if (!confirm && e && e.status === 409 && e.code === "exclude_readds_pins") return { warn: { rule } }; throw e; }
    }, retry || (() => remove(rule, confirm)));
  return { state: s, start, load, add, toggle, remove, restore, dismiss() { s.warn = null; s.error = null; changed(); } };
}

/** The budget's state and writes, no DOM. save(bytes) and reset() write, then re-read; state.status is the last write's pins_status. */
export function createBudgetController({ call, getAdmin, repoId, itemId, onChange = () => {} }) {
  const s = { load: "idle", view: null, isAdmin: false, busy: false, error: null, status: "", saved: false, level: "" };
  // With an itemId the controller sets that item's own size; otherwise the repository's, or one role's in it (setLevel).
  const level = () => (s.view ? s.view.levels.find((l) => l.key === s.level) || s.view.levels[0] : null);
  const urlFor = (lv) => (itemId ? itemUrl(itemId) : lv.scope === "role" ? settingsUrl(repoId) + "/roles/" + encodeURIComponent(lv.key) : settingsUrl(repoId));
  const changed = () => onChange(s);
  async function load() {
    try { s.view = pickView(await call("GET", itemId ? itemUrl(itemId) : settingsUrl(repoId))); s.load = s.view ? "ok" : "error"; } catch (e) { if (cancelled(e)) return; s.load = "error"; }
    changed();
  }
  async function start() {
    s.isAdmin = await getAdmin();
    s.load = "loading"; changed();
    return load();
  }
  async function write(bytes) {
    if (s.busy) return false;
    s.busy = true; s.error = null; s.status = ""; s.saved = false; changed();
    try {
      const lv = level();
      const res = await call("PUT", urlFor(lv), lv.scope === "repo" ? { context_budget_bytes: bytes } : { budget_bytes: bytes });
      s.busy = false; s.saved = true; s.status = res && typeof res.pins_status === "string" ? res.pins_status : "";
    } catch (e) {
      s.busy = false;
      if (cancelled(e)) return false;
      if (e && e.status === 403) s.isAdmin = false;
      s.error = { text: refusalSentence(e), retry: () => write(bytes) };
      changed();
      return false;
    }
    await load();
    return true;
  }
  const save = (text) => { const lv = level(), v = lv && budgetInput(text, { min_bytes: lv.min, max_bytes: lv.max }); if (!v || !v.ok) { s.error = { text: v ? v.text : GENERIC, retry: null }; s.saved = false; changed(); return false; } return write(v.bytes); };
  return { state: s, start, load, save, level, reset: () => write(null), setLevel(key) { s.level = key; s.saved = false; s.error = null; s.status = ""; changed(); } };
}

// ── the view ──────────────────────────────────────────────────────────
const CSS = `
.ctx{margin-top:14px;padding-top:10px;border-top:1px solid var(--border,rgba(26,255,128,.3));min-width:0;overflow-wrap:anywhere}
.ctx-sub{margin:10px 0 4px;font-size:.85rem}.ctx-muted{color:var(--text-muted,rgba(26,255,128,.55))}.ctx p{margin:4px 0}
.ctx-err{color:#ff6b6b}.ctx-err:empty,.ctx-note:empty,.ctx-toasts:empty{display:none}
.ctx-rows{margin:6px 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px}
.ctx-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:4px 8px;border:1px solid var(--border,rgba(26,255,128,.3));background:var(--bg-surface,#0a0a0a)}
.ctx-path{flex:1 1 100%;min-width:0}.ctx-dir{color:var(--text-muted,rgba(26,255,128,.55))}.ctx-name{font-weight:600}
.ctx-badge{padding:0 6px;border:1px solid var(--border,rgba(26,255,128,.3));font-size:.78rem}.ctx-row p{flex:1 1 100%;font-size:.78rem}
.ctx-btn,.ctx-field{box-sizing:border-box;min-height:44px;padding:4px 10px;background:var(--bg-surface,#0a0a0a);border:1px solid var(--border,rgba(26,255,128,.3));border-radius:var(--border-radius-sm,0);color:inherit;font:inherit}
.ctx-btn{cursor:pointer}.ctx-btn[aria-checked=true]{border-color:var(--accent,#1aff80);font-weight:600}.ctx-btn:hover{border-color:var(--accent,#1aff80)}
.ctx-btn:focus-visible,.ctx-field:focus-visible,.ctx input:focus-visible{outline:2px solid var(--accent,#1aff80);outline-offset:2px}
.ctx-form,.ctx-budget-row{display:flex;flex-wrap:wrap;align-items:flex-end;gap:8px}.ctx-form label,.ctx-budget-row label{display:flex;flex-direction:column;gap:2px;min-width:0}
.ctx-form .ctx-grow{flex:1 1 200px}.ctx-field{max-width:100%}.ctx fieldset{margin:6px 0;padding:0;border:0;display:flex;flex-wrap:wrap;gap:4px 14px}.ctx legend{padding:0;margin-bottom:2px}
.ctx-toast{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin:6px 0;padding:6px 10px;border:1px solid var(--accent,#1aff80);background:var(--bg-surface,#0a0a0a)}
.ctx-defaults{display:grid;grid-template-columns:auto minmax(0,1fr);justify-content:start;gap:2px 14px;margin:4px 0}.ctx-defaults dt,.ctx-defaults dd{margin:0}
`;
let sheetDone = false;
/** One constructed stylesheet for every panel (a CSSOM sheet is not blocked by a style-src that forbids inline style). */
function addStyles() {
  if (sheetDone || typeof CSSStyleSheet === "undefined" || !document.adoptedStyleSheets) return;
  sheetDone = true;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(CSS);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}

const line = (text, testid, extra) => h("p", { "data-testid": testid, ...extra }, text);
const btn = (text, testid, onClick, extra) => h("button", { type: "button", class: "ctx-btn", "data-testid": testid, onClick, ...extra }, text);
let uid = 0;

/** Mounts the rules panel (and, with budget, the budget block) into host. Returns { destroy }. clock is { set, clear } for the Undo timer. */
function mountPanel(host, { target, withBudget, heading, clock = { set: (f, ms) => setTimeout(f, ms), clear: (t) => clearTimeout(t) } }) {
  addStyles();
  const id = "ctx" + ++uid;
  const abort = new AbortController();
  const call = (m, p, b) => api(m, p, b, abort.signal);
  // Whether this person is an owner or admin; the server's 403 stays the real answer, so a failed read means "no".
  const adminRead = call("GET", "/api/cloud/auth/me").then((me) => !!me && me.is_admin === true, () => false);
  const getAdmin = () => adminRead;
  const rules = createRulesController({ call, getAdmin, target, onChange: () => paint() });
  const budget = withBudget ? createBudgetController({ call, getAdmin, repoId: target.repoId, itemId: target.itemId, onChange: () => paintBudget() }) : null;
  const s = rules.state;
  let destroyed = false, rows = [], shownForm = "";

  const budgetEl = h("div", { class: "ctx-budget", "data-testid": "ctx-budget" });
  const errEl = h("div", { class: "ctx-err", role: "alert", "data-testid": "ctx-error" });
  const noteEl = h("p", { class: "ctx-note", role: "status", "data-testid": "ctx-note" });
  const toastEl = h("div", { class: "ctx-toasts", role: "status", "aria-live": "polite", "data-testid": "ctx-toasts" });
  const formEl = h("div", { class: "ctx-formslot" });
  const warnEl = h("div", { class: "ctx-warn", "data-testid": "ctx-warn" });
  const listEl = h("div", { class: "ctx-list", "data-testid": "ctx-list" });
  const input = h("input", { type: "text", class: "ctx-field", id: id + "-path", autocomplete: "off", "data-testid": "ctx-path", "aria-describedby": id + "-hint" });
  input.setAttribute("spellcheck", "false"); // h() skips a false value, so the attribute is set here
  const kind = h("select", { class: "ctx-field", id: id + "-kind", "data-testid": "ctx-kind", onChange: paintHint },
    h("option", { value: "pin" }, COPY.kindPin), h("option", { value: "exclude" }, COPY.kindExclude));
  const hintEl = h("div", { id: id + "-hint", class: "ctx-muted", "data-testid": "ctx-hint" });
  const submit = (e) => { e.preventDefault(); addRule(input.value, kind.value, target.itemId ? s.scope : "repo"); };
  const form = h("form", { class: "ctx-form", "data-testid": "ctx-form", onSubmit: submit },
    h("label", { class: "ctx-grow", for: id + "-path" }, COPY.pathLabel, input), h("label", { for: id + "-kind" }, COPY.kindLabel, kind),
    h("button", { type: "submit", class: "ctx-btn", "data-testid": "ctx-add" }, COPY.add));
  input.addEventListener("input", paintHint);
  host.replaceChildren(h("section", { class: "ctx", "aria-label": COPY.title, "data-testid": "ctx" },
    h(heading, { class: "ctx-sub" }, COPY.title), ...(withBudget ? [budgetEl] : []), line(COPY.applies, "ctx-applies", { class: "ctx-muted" }),
    formEl, hintEl, errEl, noteEl, warnEl, toastEl, listEl));
  rules.start();
  if (budget) budget.start();

  function paintHint() {
    const ex = kind.value === "exclude";
    hintEl.replaceChildren(...(ex ? [h("p", null, COPY.exclude + ". " + COPY.help + ".")] : []), ...(ex && input.value.includes("[") ? [h("p", { "data-testid": "ctx-bracket" }, COPY.bracket)] : []));
  }
  /** The row control that holds focus, so a repaint can put it back. */
  const held = () => { const a = document.activeElement, li = a && a.closest && a.closest("[data-key]"); return li && listEl.contains(li) ? { key: li.dataset.key, ctl: a.dataset.ctl } : null; };
  function focusRow(key, ctl) {
    const li = key ? [...listEl.querySelectorAll("[data-key]")].find((e) => e.dataset.key === key) : null;
    const el = li && (li.querySelector('[data-ctl="' + (ctl || "switch") + '"]') || li.querySelector("[data-ctl]"));
    (el || input).focus();
  }

  function paint() {
    if (destroyed) return;
    const keep = held();
    const canAdd = !target.itemId ? s.isAdmin : true;
    rows = ruleRows(s.rules, { isAdmin: s.isAdmin });
    const formKey = canAdd + ":" + s.isAdmin;
    if (formKey !== shownForm) { // not rebuilt on every repaint, so a held focus in the form stays
      shownForm = formKey;
      formEl.replaceChildren(...(canAdd ? [form, ...(target.itemId ? [scopeControl()] : [])] : [line(COPY.adminOnly, "ctx-admin-only", { class: "ctx-muted" })]));
    }
    errEl.replaceChildren(...(s.error ? [h("span", { "data-testid": "ctx-error-text" }, s.error.text), ...(s.error.retry ? [" ", btn(COPY.retry, "ctx-retry", () => s.error.retry())] : [])] : []));
    warnEl.replaceChildren(...(s.warn ? [h("div", { role: "alert", "data-testid": "ctx-warn-box" }, h("p", null, COPY.readdsPins),
      btn(COPY.keepIt, "ctx-keep", () => { const r = s.warn.rule; rules.dismiss(); focusRow(r.scope + ":" + r.path); }), " ", btn(COPY.removeAnyway, "ctx-confirm", () => removeRule(s.warn.rule, true)))] : []));
    paintList();
    if (keep && !listEl.contains(document.activeElement)) focusRow(keep.key, keep.ctl);
  }
  function scopeControl() {
    const mk = (value, label, disabled) => h("label", null, h("input", { type: "radio", name: id + "-scope", value, checked: s.scope === value, disabled, "data-testid": "ctx-scope-" + value, onChange: () => (s.scope = value) }), " " + label);
    return h("fieldset", { "data-testid": "ctx-scope" }, h("legend", null, COPY.scopeLabel), mk("item", COPY.scopeItem, false),
      s.isAdmin ? mk("repo", COPY.scopeRepo, false) : h("span", { class: "ctx-muted", "data-testid": "ctx-scope-repo-locked" }, COPY.scopeRepo + ": " + COPY.adminOnly));
  }
  function paintList() {
    if (s.load === "idle" || s.load === "loading") return listEl.replaceChildren(line(COPY.loading, "ctx-loading", { class: "ctx-muted" }));
    if (s.load === "error") return listEl.replaceChildren(line(COPY.loadFailed, "ctx-load-error", { role: "alert" }), btn(COPY.retry, "ctx-load-retry", () => rules.load(false)));
    if (rows.length === 0) return listEl.replaceChildren(line(COPY.empty, "ctx-empty", { class: "ctx-muted" }));
    const limit = readLimitLine(s.rules);
    listEl.replaceChildren(
      ...(rows.some((r) => r.kind === "exclude") ? [line(COPY.exclude + ". " + COPY.help + ".", "ctx-help", { class: "ctx-muted", id: id + "-help" })] : []),
      ...(limit ? [line(limit, "ctx-read-limit", { role: "status" })] : []),
      h("ul", { class: "ctx-rows", "aria-label": COPY.title, onKeydown: onKey }, rows.map((r) => rowEl(r))));
  }
  function rowEl(r) {
    const ex = r.kind === "exclude";
    return h("li", { class: "ctx-row", "data-key": r.key, "data-testid": "ctx-row" },
      h("div", { class: "ctx-path" }, h("bdi", null, h("span", { class: "ctx-dir" }, r.dir), h("span", { class: "ctx-name" }, r.name))),
      h("span", { class: "ctx-badge", "data-testid": "ctx-badge" }, ex ? COPY.exclude : COPY.pin),
      h("span", { class: "ctx-badge ctx-muted", "data-testid": "ctx-scope-tag" }, r.scope === "item" ? COPY.scopeItem : COPY.scopeRepo),
      ...(r.canEdit ? [
        h("button", { type: "button", class: "ctx-btn", role: "switch", "aria-checked": ex ? "true" : "false", "aria-label": COPY.keepOut + ": " + r.path, "aria-describedby": rows.some((x) => x.kind === "exclude") ? id + "-help" : null,
          "data-ctl": "switch", "data-testid": "ctx-switch", onClick: () => rules.toggle(r) }, COPY.keepOut),
        h("button", { type: "button", class: "ctx-btn", "aria-label": COPY.remove + " " + r.path, "data-ctl": "remove", "data-testid": "ctx-remove", onClick: () => removeRule(r, false) }, COPY.remove)] : []),
      ...(r.missing_at ? [h("p", { class: "ctx-muted", "data-testid": "ctx-path-missing" }, COPY.pathMissing(r.missing_at))] : []),
      ...(r.bracket ? [h("p", { "data-testid": "ctx-bracket-row" }, COPY.bracket)] : []),
      ...(r.told ? [h("p", { class: "ctx-muted", "data-testid": "ctx-same-name" }, COPY.sameName(r.told))] : []));
  }
  function onKey(e) {
    const li = e.target.closest && e.target.closest("[data-key]");
    const r = li && rows.find((x) => x.key === li.dataset.key);
    if (e.key === "Delete" && r && r.canEdit) { e.preventDefault(); removeRule(r, false); }
  }
  async function addRule(path, k, scope) {
    if ((await rules.add(path, k, scope, () => addRule(path, k, scope))) !== "ok" || destroyed) return;
    if (input.value === path) { input.value = ""; paintHint(); }
    noteEl.textContent = COPY.added(path.trim());
    input.focus();
  }
  async function removeRule(rule, confirm) {
    const i = rows.findIndex((r) => r.key === rule.scope + ":" + rule.path);
    const next = rows[i + 1] || rows[i - 1];
    const out = await rules.remove(rule, confirm, () => removeRule(rule, confirm));
    if (destroyed) return;
    if (out === "warned") return (warnEl.querySelector('[data-testid="ctx-keep"]') || input).focus();
    if (out === "ok") { focusRow(next && next.key, "switch"); showToast(rule); }
  }
  /** Undo is a real save of the same rule. */
  async function undoRule(rule) {
    if ((await rules.restore(rule, () => undoRule(rule))) === "ok" && !destroyed) { noteEl.textContent = COPY.restored(rule.path); focusRow(rule.scope + ":" + rule.path, "switch"); }
  }
  function showToast(rule) {
    let timer = 0;
    const done = () => { clock.clear(timer); el.remove(); };
    const el = h("div", { class: "ctx-toast", "data-testid": "ctx-toast" }, h("span", { "data-testid": "ctx-toast-text" }, COPY.removed(rule.path) + " " + COPY.applies + "."),
      btn(COPY.undo, "ctx-undo", () => { done(); return undoRule(rule); }));
    toastEl.append(el);
    timer = clock.set(() => el.remove(), UNDO_MS);
  }

  function paintBudget() {
    if (destroyed || !budget) return;
    const b = budget.state, v = b.view;
    const status = b.saved ? [budgetStatusLine(b.status) || COPY.saved] : [];
    if (b.load !== "ok") {
      return budgetEl.replaceChildren(h("h4", { class: "ctx-sub" }, COPY.budgetTitle), b.load === "error"
        ? h("div", { role: "alert", "data-testid": "ctx-budget-error" }, COPY.budgetFailed, " ", btn(COPY.retry, "ctx-budget-retry", () => budget.start()))
        : line(COPY.budgetLoading, "ctx-budget-loading", { class: "ctx-muted" }));
    }
    const lv = budget.level();
    const field = h("input", { type: "number", class: "ctx-field", id: id + "-budget", min: lv.min, max: lv.max, step: 1, value: lv.bytes === null ? "" : String(lv.bytes), "data-testid": "ctx-budget-input", "aria-describedby": id + "-budget-now" });
    const pick = v.levels.length < 2 ? [] : [h("label", { for: id + "-level" }, COPY.budgetFor, h("select", { id: id + "-level", class: "ctx-field", "data-testid": "ctx-budget-level",
      onChange: (e) => { budget.setLevel(e.target.value); budgetEl.querySelector('[data-testid="ctx-budget-level"]')?.focus(); } }, v.levels.map((l) => h("option", { value: l.key, selected: l.key === lv.key }, l.label))))];
    budgetEl.replaceChildren(h("h4", { class: "ctx-sub" }, COPY.budgetTitle), line(COPY.budgetNow(lv.bytes, lv.scope), "ctx-budget-now", { id: id + "-budget-now" }),
      h("dl", { class: "ctx-defaults", "aria-label": COPY.defaults, "data-testid": "ctx-defaults" }, v.effective.flatMap(([role, n, src]) => [h("dt", null, ROLE_NAMES[role] || role), h("dd", null, sizeText(n) + " · " + src)])),
      line(COPY.consumers, "ctx-budget-consumers", { class: "ctx-muted" }),
      ...(b.isAdmin ? [h("div", { class: "ctx-budget-row" }, ...pick, h("label", { for: id + "-budget" }, COPY.budgetField, field),
        btn(COPY.save, "ctx-budget-save", () => budget.save(field.value)), btn(COPY.reset, "ctx-budget-reset", () => lv.bytes !== null && budget.reset(), { "aria-disabled": lv.bytes === null ? "true" : null }))]
        : [line(COPY.adminOnly, "ctx-budget-admin-only", { class: "ctx-muted" })]),
      h("p", { role: "status", "data-testid": "ctx-budget-status" }, ...status),
      ...(b.error ? [h("div", { role: "alert", class: "ctx-err", "data-testid": "ctx-budget-error" }, b.error.text, ...(b.error.retry ? [" ", btn(COPY.retry, "ctx-budget-retry", () => b.error.retry())] : []))] : []));
    if (b.saved || b.error) budgetEl.querySelector('[data-testid="ctx-budget-input"]')?.focus();
  }

  return { destroy() { destroyed = true; abort.abort(); host.replaceChildren(); } };
}

/** A repository's rules and its budget, for the Repos app. */
export const mountRepoRules = (host, { repoId }) => mountPanel(host, { target: { repoId }, withBudget: true, heading: "h4" });
/** One item's rules (with the repository's in force), for the Pipeline item pane. */
export const mountItemRules = (host, { repoId, itemId }) => mountPanel(host, { target: { repoId, itemId }, withBudget: true, heading: "h3" });

// D#845 ON-27a/ON-27e: the private twin's words and view-model, shared by Onboarding (the choice card, the create steps, the track rows) and Repos (the twin card).
// Pure: no DOM, no storage, no request. Every sentence the server could influence (names, numbers) is checked here and joined as text by the caller's h().
/** What each state of a private twin says, in plain words (no state name, no internal label). */
const TWIN_WORDS = {
  creating: "Creating the private repo…",
  not_connected: "The private repo exists. Add it to the GitHub app so we can copy your code into it.",
  seeding: "Copying your code into the private repo…",
  ready: "Your work happens in the private repo. Merged work comes back as a pull request you merge.",
  paused: "Paused. Nothing is published or synced, and the engine keeps working in the private repo.",
  conflict: "Your public repo and the private repo changed in the same place. The sync pull request needs a hand.",
  refused: "A change was held back because it looked like it contained something private.",
  failed: "The twin stopped.",
  removed: "Stopped. The private repo is still on GitHub.",
};
/** FU-319/FU-319b: a twin refused because its private repo turned public says how to come back; the note is for a public repo that turned private (the twin keeps working). */
export const TWIN_NOT_PRIVATE = "The private repo is public now, so nothing is published or synced and the engine is held. Make it private again on GitHub, then Pause and Resume here.";
const TWIN_NOTES = { public_repo_private: "Your public repo is private now. The twin keeps working, but there is nothing public to publish to until it is public again." };
const TWIN_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const TWIN_OWNER_RE = /^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const TWIN_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TWIN_COUNT = (n) => Number.isInteger(n) && n >= 0;
const TWIN_UNCHECKED = "not checked yet";
const TWIN_PR_NO = (n) => Number.isInteger(n) && n > 0;
/** The three track rows the create shows before the normal survey, plan, install and live rows. */
export const TWIN_ROW_LABELS = ["Private twin created", "Copying your code…", "Ready"];
/** Where each state stands among the three rows: the index of the row that is current (3 = all done). */
const TWIN_STAGE = { creating: 0, not_connected: 1, seeding: 1, failed: 1, ready: 3, paused: 3, conflict: 3, refused: 3 };
/** { id, label, state: "done" | "active" | "failed" | "pending" } for each of the three rows; none for a removed twin. */
export function twinRows(state) {
  if (!Object.hasOwn(TWIN_STAGE, state)) return [];
  return TWIN_ROW_LABELS.map((label, i) => ({ id: ["created", "copying", "ready"][i], label, state: i < TWIN_STAGE[state] ? "done" : i > TWIN_STAGE[state] ? "pending" : state === "failed" ? "failed" : "active" }));
}
/**
 * D#845 ON-27a: the private twin's card from a twin row (the item of GET /api/v1/repos/:id/twin), the public repo's owner login and, optionally, the public repo's full name.
 * A missing row, or a state this does not know, is empty. Returns { twin: { state, lines, actions: [{ id, label }], private_url, rows } }. The actions are the undo routes: Pause or Resume,
 * Stop publishing, and Cancel before the seed (which leaves the empty private repo on GitHub and says so). An open publish or sync pull request adds a line; nothing here merges one.
 */
export function twinDetail(row, owner, publicName) {
  if (!row || typeof row.state !== "string" || !Object.hasOwn(TWIN_WORDS, row.state) || typeof row.private_name !== "string" || !TWIN_NAME_RE.test(row.private_name)) return {};
  const url = typeof owner === "string" && TWIN_OWNER_RE.test(owner) ? "https://github.com/" + owner + "/" + row.private_name : "";
  const lines = [row.state === "refused" && row.failure_code === "twin_not_private" ? TWIN_NOT_PRIVATE : TWIN_WORDS[row.state]];
  const actions = [];
  const seeded = typeof row.published_private_sha === "string" && row.published_private_sha !== "";
  const pub = typeof publicName === "string" && publicName !== "" ? publicName : "Your public repo";
  const live = row.state === "ready" || row.state === "paused" || row.state === "conflict"; // the states a parity check and a merge apply to
  if (row.state === "not_connected") actions.push({ id: "add_to_app", label: "Add " + row.private_name + " to the GitHub app" });
  if (row.state === "paused") actions.push({ id: "resume", label: "Resume" });
  else if (row.state !== "removed") actions.push({ id: "pause", label: "Pause" });
  if (row.state === "ready" || row.state === "conflict") actions.push({ id: "check", label: "Check again" });
  if (live && TWIN_PR_NO(row.publish_pr)) actions.push({ id: "merge", label: "Merge publish PR #" + row.publish_pr });
  if (row.state !== "removed") actions.push(seeded ? { id: "stop", label: "Stop publishing" } : { id: "cancel", label: "Cancel" });
  if (row.state === "removed" || (!seeded && row.state !== "ready")) lines.push("Delete " + row.private_name + " on GitHub if you don't want it. We never delete a repo.");
  if (row.state !== "removed" && row.note === "public_repo_private") lines.push(TWIN_NOTES.public_repo_private);
  // The counts come from the last parity check; a twin that has not been checked yet has null counts, and says so rather than showing zero.
  const n = (c, one, many) => (TWIN_COUNT(c) ? c + " " + (c === 1 ? one : many) : "");
  if (live && TWIN_PR_NO(row.publish_pr)) lines.push("Publish PR #" + row.publish_pr + " is open: merge it on GitHub");
  else if (live) lines.push("Waiting to publish: " + (n(row.merged_count, "merged change", "merged changes") || TWIN_UNCHECKED));
  if (live && TWIN_PR_NO(row.sync_pr)) lines.push(pub + " has " + (n(row.new_changes_count, "new change", "new changes") || "new changes") + ": bringing them in (PR #" + row.sync_pr + " on the private repo)");
  else if (live) lines.push(TWIN_COUNT(row.new_changes_count) ? pub + " has " + n(row.new_changes_count, "new change", "new changes") : "New changes on " + pub + ": " + TWIN_UNCHECKED);
  return { twin: { state: row.state, lines, actions, private_url: url, rows: twinRows(row.state) } };
}
/** An item of GET /api/v1/repos/:id/twin, kept only when it fits (ids are UUIDs, the state is known, the name is a repo name); anything else is "no twin". */
export function readTwin(body) {
  const t = body && typeof body === "object" ? body.twin : null;
  if (!t || typeof t.id !== "string" || !TWIN_UUID_RE.test(t.id) || typeof t.public_repo_id !== "string" || !TWIN_UUID_RE.test(t.public_repo_id)) return null;
  if (!Object.hasOwn(TWIN_WORDS, t.state) || typeof t.private_name !== "string" || !TWIN_NAME_RE.test(t.private_name)) return null;
  const priv = typeof t.private_repo_id === "string" && TWIN_UUID_RE.test(t.private_repo_id) ? t.private_repo_id.toLowerCase() : null;
  return { id: t.id.toLowerCase(), public_repo_id: t.public_repo_id.toLowerCase(), private_repo_id: priv, private_name: t.private_name, state: t.state, published_private_sha: typeof t.published_private_sha === "string" ? t.published_private_sha : null,
    publish_pr: TWIN_PR_NO(t.publish_pr) ? t.publish_pr : null, sync_pr: TWIN_PR_NO(t.sync_pr) ? t.sync_pr : null,
    failure_code: t.failure_code === "twin_not_private" ? t.failure_code : null, note: Object.hasOwn(TWIN_NOTES, t.note) ? t.note : null,
    merged_count: TWIN_COUNT(t.merged_count) ? t.merged_count : null, new_changes_count: TWIN_COUNT(t.new_changes_count) ? t.new_changes_count : null };
}
/** Whether a twin's plan may be carried from the public repo: the server refuses anything else, and so does the page. */
export const twinCanAdopt = (row) => !!row && (row.state === "ready" || row.state === "paused");

/** The choice card for a public repo that has no twin (the picker, 4.1). `name` is the repo's own name. */
export const twinChoice = (owner, name) => {
  const mine = owner + "/" + name + "-private", pub = owner + "/" + name;
  return {
    make: "Make a private twin (recommended)",
    makeText: "We'll create " + mine + ", copy your code into it, and run the engine there. Plans, Discussions and work stay private. Merged work comes back to " + pub + " as a pull request you merge.",
    stay: "Stay public-only",
    stayText: "The engine surveys this public repo and drafts a plan you review item by item. It can't run here yet.",
  };
};
export const TWIN_COST = "CI on the private repo uses your GitHub Actions minutes (GitHub Free includes 2,000 a month). Public repos run Actions free.";
export const ADOPT_COPY = { use: "Use my approved plan", again: "Survey again" };
const TWIN_BY_CODE = {
  twin_exists: "This repo already has a private twin.", pairing_exists: "This repo is paired with a public code repo. Remove the pairing first.", install_first: "Install the GitHub app first.",
  twin_repo_not_public: "A private twin is made for a public repo.", rate_limited: "You've created a lot of repos lately. Try again later.", github_unavailable: "GitHub couldn't be reached. Try again in a minute.",
  github_app_not_configured: "Creating a repo isn't available right now.", account_not_active: "This account isn't active, so a repo can't be created right now.",
  validation_failed: "That name isn't a valid repo name. Use letters, numbers, dots, dashes and underscores.", twin_state: "The twin's state changed. Read it again.", twin_not_ready: "The private repo isn't ready yet. Try again when it is.",
  twin_paths_changed: "The private paths changed in another window. They were read again; make your change again.",
  twin_no_pr: "That pull request isn't open any more. The card was read again.",
  twin_pr_changed: "The pull request was closed or changed on GitHub. The card was read again; look it over, then merge.",
  twin_pr_blocked: "GitHub will not merge this yet; it may need a passing check or a review first. Finish those on GitHub, then try again.",
  twin_not_private: TWIN_NOT_PRIVATE,
  issue_not_open: "That issue is closed or is a pull request, so it can't be brought. The list was read again.",
  issue_bring_in_progress: "That issue is being brought in right now. Look again in a moment.",
};
/** The words for a refused twin call (by closed code, then status); never the server's own text. */
export function twinRefusal(e) {
  const code = e && typeof e.code === "string" ? e.code : "";
  if (Object.hasOwn(TWIN_BY_CODE, code)) return TWIN_BY_CODE[code];
  if (e && e.status === 403) return "Only an owner or admin can change this.";
  return "That didn't go through. Try again.";
}
/** What the page's address says about a twin create that just returned (`?twin=`): a sentence, or "" for ok and for anything unknown. */
export const TWIN_RETURN = { not_found: "The repo wasn't found.", pairing_exists: TWIN_BY_CODE.pairing_exists, twin_exists: TWIN_BY_CODE.twin_exists, failed: "The private twin couldn't be recorded. Try again." };
/** The adopt answer ({ adopted, reason }) in words. */
export const adoptWords = (res) => (res && res.adopted === true ? "Your approved plan was carried over. Review it in the plan step."
  : res && res.reason === "no_draft" ? "Your public repo has no plan to carry over, so the survey drafts one." : "This project's survey has already started, so the plan can't be carried over.");
/** The Private paths editor's lists, one path per line. */
export const pathLines = (list) => (Array.isArray(list) ? list.join("\n") : "");
export const parsePathLines = (text) => String(text).split("\n").map((s) => s.trim()).filter(Boolean);
/** The paths in `before` that `after` no longer lists: narrowing the private set lets those files be published. */
export const droppedPaths = (before, after) => before.filter((p) => !after.includes(p));
/** The warning shown before narrowing the private set. */
export const narrowWarning = (dropped) => "Removing " + dropped.length + (dropped.length === 1 ? " path" : " paths") + " means files they covered would be published the next time they change.";
