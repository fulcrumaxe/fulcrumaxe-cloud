// D#6 R7d: the Repos app's sandbox allowance panel. An owner or admin picks the reviewed .fulcrumaxe/runner-sandbox.json; this
// browser reads it and sends only its content (the cloud never reads the repo). The panel shows the approved set and the pending
// diff against it, and approving a set with entries needs the repo's full name typed back. Members see the approved set read-only.
// Every node comes from h() (text, never markup); a refusal is a sentence of this file's own, picked by the server's closed
// reason code, never the server's text and never the parser's.
import { h } from "../_lib/dom.js";

export const MAX_FILE_BYTES = 128 * 1024;
const LIMITS = { max_entries: 64, max_command_timeout_s: 1800 };
const FIELDS = ["kind", "value", "access", "reason"];
const NOT_GIVEN = "not given";
export const ADMIN_ONLY = "Only owners and admins can change this.";
const UPLOAD_ERRORS = {
  too_big: "That file is too big to be an allowance file.",
  not_json: "That file isn't valid JSON.",
  malformed: "That file isn't a sandbox allowance file.",
  unreadable: "That file couldn't be read.",
};
const REFUSALS = {
  invalid_shape: "an entry has the wrong shape", access_not_allowed_for_kind: "an entry's access doesn't fit its kind", duplicate_entry: "an entry appears twice",
  timeout_without_entries: "a set with no entries takes no timeout", entries_without_timeout: "a set with entries needs a command timeout",
  path_malformed: "a path is malformed", path_home: "a path is in a home directory", path_credential: "a path holds credentials", path_system: "a path is a system place",
  path_socket: "a path is a socket", path_write_outside_tmp: "writes are only allowed under /tmp", path_bare_tmp: "/tmp itself can't be granted",
  domain_malformed: "a domain is malformed", domain_wildcard: "a domain has a wildcard", domain_address: "a domain is an IP address", domain_private: "a domain is private",
  loopback_value: "the loopback entry has the wrong value",
};

const isText = (v) => typeof v === "string" && v.trim() !== "";
const shown = (v) => (isText(v) ? v : NOT_GIVEN); // an empty or missing value never reaches the screen as a blank
const plural = (n, word) => n + " " + word + (n === 1 ? "" : "s");

/** The set to send from the text of a picked file, or a closed code. Only the four fields of each entry are copied. */
export function parseUpload(text, limits = LIMITS) {
  if (typeof text !== "string" || text.length > MAX_FILE_BYTES) return { ok: false, code: "too_big" };
  let data;
  try { data = JSON.parse(text); } catch { return { ok: false, code: "not_json" }; }
  // D#6 R-CHK-3c: a check in the file is never sent from here (the check form is where one is reviewed and approved), but the panel is told it was there.
  let declaresCheck = false;
  if (data && typeof data === "object" && !Array.isArray(data) && data.check !== null && typeof data.check === "object" && !Array.isArray(data.check)) { declaresCheck = true; data = { ...data }; delete data.check; }
  const keys = data && typeof data === "object" && !Array.isArray(data) ? Object.keys(data).sort().join() : "";
  if (keys !== "entries" && keys !== "command_timeout_s,entries") return { ok: false, code: "malformed" };
  const t = data.command_timeout_s;
  if (!Array.isArray(data.entries) || data.entries.length > limits.max_entries) return { ok: false, code: "malformed" };
  if (t !== undefined && !(Number.isInteger(t) && t >= 1 && t <= limits.max_command_timeout_s)) return { ok: false, code: "malformed" };
  const entries = [];
  for (const e of data.entries) {
    const ok = e && typeof e === "object" && !Array.isArray(e) && Object.keys(e).sort().join() === "access,kind,reason,value" && FIELDS.every((f) => isText(e[f]));
    if (!ok) return { ok: false, code: "malformed" };
    entries.push({ kind: e.kind, value: e.value, access: e.access, reason: e.reason });
  }
  return { ok: true, set: t === undefined ? { entries } : { entries, command_timeout_s: t }, declaresCheck };
}

const keyOf = (e) => [e.kind, e.value, e.access].join("\n");

/** What approving `pending` changes against `approved` (null means none approved yet). Same key with another reason counts as changed. */
export function diffSets(approved, pending) {
  const old = new Map(((approved && approved.entries) || []).map((e) => [keyOf(e), e]));
  const next = new Map(((pending && pending.entries) || []).map((e) => [keyOf(e), e]));
  const added = [...next].filter(([k]) => !old.has(k)).map(([, e]) => e);
  const removed = [...old].filter(([k]) => !next.has(k)).map(([, e]) => e);
  const changed = [...next].filter(([k, e]) => old.has(k) && old.get(k).reason !== e.reason).map(([, e]) => e);
  const from = approved ? approved.command_timeout_s ?? null : null, to = pending ? pending.command_timeout_s ?? null : null;
  const timeout = from === to ? null : { from, to };
  return { added, removed, changed, timeout, same: approved !== null && !added.length && !removed.length && !changed.length && !timeout };
}

/** Rows for display: every field is non-empty text. */
export const entryRows = (entries) => (Array.isArray(entries) ? entries : []).map((e) => Object.fromEntries(FIELDS.map((f) => [f, shown(e && e[f])])));

/** The panel's state, reduced to what the view shows. `s.typed` is the repo name typed so far, `s.phase` is idle | saving | done | error. */
export function panelModel(s) {
  const v = s.view;
  if (s.load === "idle") return { kind: "idle" };
  if (s.load === "loading" || (s.load === "ok" && !v)) return { kind: "loading" };
  if (s.load !== "ok") return { kind: "error" };
  const approved = v.approved ? { entries: v.approved.entries, command_timeout_s: v.approved.command_timeout_s } : null;
  const hasCheck = !!v.approved && !!v.approved.check; // the check form owns it; an upload replaces the whole set, so it would remove it
  const pending = s.upload ? s.upload.set : null;
  const diff = pending ? diffSets(approved, pending) : null;
  const canChange = v.can_change === true;
  const widening = !!pending && pending.entries.length > 0;
  const dropsCheck = !!pending && hasCheck;
  const name = typeof s.repoName === "string" ? s.repoName : "";
  const needsName = widening || dropsCheck; // removing an approved check is confirmed the same way as widening
  const nameOk = !needsName || (name !== "" && s.typed === name);
  const notRunner = widening && v.execution_mode !== "runner_local";
  const setAside = v.set_aside === true;
  // A set-aside set still reads as approved, but the server treats approving it again as a new version, so an identical file is a change then.
  const restores = !!diff && diff.same && setAside && !dropsCheck;
  return {
    kind: "ready", canChange, approved, pending, diff, widening, dropsCheck, declaresCheck: !!(s.upload && s.upload.declaresCheck), notRunner, setAside, restores, inUse: v.in_use === true,
    approvedRows: approved ? entryRows(approved.entries) : null, pendingRows: pending ? entryRows(pending.entries) : null,
    needsName, nameKnown: name !== "",
    approveDisabled: !canChange || !pending || (diff.same && !setAside && !dropsCheck) || s.phase === "saving" || !nameOk || notRunner,
  };
}

/** The sentence for a failed approve, chosen by status, code and the server's closed reason. */
export function approveError(e) {
  const status = e && e.status, code = e && e.code;
  if (status === 403) return ADMIN_ONLY;
  if (status === 400 && code === "sandbox_allowance_refused") {
    const why = Object.prototype.hasOwnProperty.call(REFUSALS, e.reason) ? REFUSALS[e.reason] : "it crosses the sandbox floor";
    return "The server refused this set: " + why + (Number.isInteger(e.index) ? " (entry " + (e.index + 1) + ")." : ".");
  }
  if (status === 400 && code === "confirmation_mismatch") return "The name you typed doesn't match this repo.";
  if (status === 409 && code === "not_runner_local") return "Allowances are only for repos that run on a runner.";
  if (status === 429) return "Too many tries. Wait a moment, then try again.";
  return "That couldn't be saved. Try again.";
}

const pickView = (r) =>
  r && typeof r.can_change === "boolean" && (r.approved === null || (r.approved && Array.isArray(r.approved.entries))) ? r : null;

const rowList = (rows, testid) =>
  h("ul", { class: "repos-allow-list", "data-testid": testid }, rows.map((r) =>
    h("li", { class: "repos-allow-entry", "data-testid": "repos-allow-entry" },
      h("span", { class: "repos-allow-kind" }, r.kind + " " + r.access),
      h("bdi", { class: "repos-allow-value", "data-testid": "repos-allow-value" }, r.value),
      h("span", { class: "repos-muted" }, r.reason))));

/**
 * `call(method, repoId, body)` runs the request. show(repo) loads that repo's allowances.
 * `runnerOutdated(repoFullName)` says whether every runner covering the repo needs an update (for the check form). Returns { el, show, clear }.
 */
export function createAllowancePanel({ call, isCancelled, runnerOutdated = () => false }) {
  const el = h("section", { class: "repos-allow", "aria-label": "Sandbox allowances", "data-testid": "repos-allow" });
  let s = { load: "idle", view: null, upload: null, uploadError: "", typed: "", phase: "idle", notice: "", repoId: null, repoName: "", changed: false };
  let gen = 0;
  const line = (text, testid, cls, role) => h("p", { class: cls, role, "data-testid": testid }, text);
  const check = createCheckSection({
    call, isCancelled, errorText: approveError,
    onView(res) { const next = pickView(res); if (next) { s.view = next; s.upload = null; s.typed = ""; s.notice = ""; render(); } },
  });

  async function onFile(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    s.phase = "idle"; s.notice = "";
    let result;
    if (file.size > MAX_FILE_BYTES) result = { ok: false, code: "too_big" };
    else {
      try { result = parseUpload(await file.text(), (s.view && s.view.limits) || LIMITS); } catch { result = { ok: false, code: "unreadable" }; }
    }
    input.value = "";
    s.upload = result.ok ? { set: result.set, declaresCheck: result.declaresCheck } : null;
    s.uploadError = result.ok ? "" : UPLOAD_ERRORS[result.code];
    s.typed = "";
    render();
  }

  async function approve() {
    const m = panelModel(s);
    if (m.kind !== "ready" || m.approveDisabled) return;
    const id = s.repoId, mine = gen;
    s.phase = "saving"; s.notice = "";
    render();
    try {
      const res = await call("PUT", id, m.needsName ? { set: s.upload.set, confirm_repo: s.typed } : { set: s.upload.set });
      if (mine !== gen || isCancelled()) return;
      const next = pickView(res);
      if (next) s.view = next;
      s.upload = null; s.typed = ""; s.phase = "done"; s.changed = !!res && res.changed === true;
      s.notice = s.changed ? "Approved. It applies from the next job." : "That set was already approved. Nothing changed.";
    } catch (e) {
      if (mine !== gen || isCancelled() || id !== s.repoId || (e && e.name === "AbortError")) return;
      s.phase = "error"; s.notice = approveError(e);
      if (e && e.status === 403 && s.view) s.view = { ...s.view, can_change: false };
    }
    render();
  }

  function syncApprove() {
    const b = el.querySelector('[data-testid="repos-allow-approve"]');
    if (b) b.disabled = panelModel(s).approveDisabled;
  }

  function render() { keepFocus(el, drawPanel); }
  function drawPanel() {
    const m = panelModel(s);
    if (m.kind === "idle") return el.replaceChildren();
    const title = h("h4", { class: "repos-subtitle" }, "Sandbox allowances");
    if (m.kind !== "ready") {
      return el.replaceChildren(title, m.kind === "loading" ? line("Loading allowances...", "repos-allow-loading", "repos-muted")
        : line("Allowances aren't available right now.", "repos-allow-error", "", "alert"));
    }
    const parts = [title, line("Extra places and hosts a runner job may use, approved by an owner or admin from the reviewed .fulcrumaxe/runner-sandbox.json.", "repos-allow-help", "repos-muted")];
    if (m.setAside) parts.push(line("The approved set is set aside because this repo left the runner. Approve it again before it applies.", "repos-allow-aside", "repos-muted"));
    parts.push(h("h5", { class: "repos-allow-head" }, "Approved"));
    if (!m.approved) parts.push(line("Nothing is approved yet.", "repos-allow-none", "repos-muted"));
    else if (m.approvedRows.length === 0) parts.push(line("The approved set is empty: no extra access.", "repos-allow-empty", "repos-muted"));
    else {
      parts.push(rowList(m.approvedRows, "repos-allow-approved"));
      parts.push(line("Command timeout: " + (Number.isInteger(m.approved.command_timeout_s) ? plural(m.approved.command_timeout_s, "second") : NOT_GIVEN) + ".", "repos-allow-timeout", "repos-muted"));
    }
    check.update({ view: s.view, repoId: s.repoId, repoName: s.repoName, runnerOutdated: runnerOutdated(s.repoName) });
    // dom-insert-ok: check.el is the element createCheckSection built with h(); it keeps its own draft across this rebuild
    parts.push(check.el);
    if (!m.canChange) parts.push(line(ADMIN_ONLY, "repos-allow-admin-only", "repos-muted"));
    else {
      const input = h("input", { type: "file", accept: ".json,application/json", class: "repos-allow-file", "aria-label": "Choose the reviewed runner-sandbox.json", "data-testid": "repos-allow-file", disabled: s.phase === "saving" });
      input.addEventListener("change", () => onFile(input));
      parts.push(h("h5", { class: "repos-allow-head" }, "Pending"), input);
      if (s.uploadError) parts.push(line(s.uploadError, "repos-allow-upload-error", "repos-error", "alert"));
      if (m.pending) parts.push(...pendingParts(m));
    }
    if (s.notice) parts.push(line(s.notice, s.phase === "error" ? "repos-allow-save-error" : "repos-allow-done", s.phase === "error" ? "repos-error" : "repos-note", s.phase === "error" ? "alert" : "status"));
    el.replaceChildren(...parts);
  }

  function pendingParts(m) {
    const d = m.diff, out = [];
    if (m.pendingRows.length === 0) out.push(line("This file approves an empty set: no extra access.", "repos-allow-pending-empty", "repos-muted"));
    else out.push(rowList(m.pendingRows, "repos-allow-pending"));
    const bits = [];
    if (d.added.length) bits.push(plural(d.added.length, "entry") + " added");
    if (d.removed.length) bits.push(plural(d.removed.length, "entry") + " removed");
    if (d.changed.length) bits.push(plural(d.changed.length, "reason") + " changed");
    if (d.timeout) bits.push("timeout " + (d.timeout.from ?? NOT_GIVEN) + " to " + (d.timeout.to ?? NOT_GIVEN));
    if (m.dropsCheck) bits.push("the approved check removed");
    out.push(line(m.restores ? "This set was set aside. Approving it again restores it." : d.same && !m.dropsCheck ? "No change from the approved set." : "Changes: " + bits.join(", ") + ".", "repos-allow-diff", "repos-muted"));
    if (d.removed.length) out.push(rowList(entryRows(d.removed), "repos-allow-removed"));
    if (m.dropsCheck) out.push(line((m.declaresCheck ? "This file declares a check, but a check is only approved in the form above. " : "This file declares no check. ") + "Approving it removes the approved check, so runs stop being checked. Type the repo's name to confirm.", "repos-allow-drops-check", "repos-error", "alert"));
    if (m.notRunner) out.push(line("This repo doesn't run on a runner, so a set with entries can't be approved.", "repos-allow-not-runner", "repos-error", "alert"));
    if (m.needsName) {
      const name = h("input", {
        type: "text", class: "repos-allow-name", autocomplete: "off", spellcheck: false, value: s.typed, "data-testid": "repos-allow-name",
        "aria-label": "Type the repo's full name to approve", disabled: !m.nameKnown || s.phase === "saving",
      });
      name.addEventListener("input", () => { s.typed = name.value; syncApprove(); });
      out.push(h("label", { class: "repos-allow-confirm" }, h("span", null, "Type ", h("bdi", null, s.repoName || "the repo's name"), " to approve"), name));
    }
    out.push(h("button", { type: "button", class: "repos-btn", "data-testid": "repos-allow-approve", disabled: m.approveDisabled, onClick: approve }, s.phase === "saving" ? "Approving..." : "Approve"));
    return out;
  }

  async function show(repo) {
    const mine = ++gen;
    s = { load: "loading", view: null, upload: null, uploadError: "", typed: "", phase: "idle", notice: "", repoId: repo.id, repoName: repo.full_name || "", changed: false };
    render();
    try {
      const view = pickView(await call("GET", repo.id));
      if (mine !== gen || isCancelled()) return;
      s.view = view; s.load = view ? "ok" : "error";
    } catch (e) {
      if (mine !== gen || isCancelled() || (e && e.name === "AbortError")) return;
      s.load = "error";
    }
    render();
  }

  render();
  return { el, show, repaint: render, clear() { gen++; s = { ...s, load: "idle", view: null }; check.clear(); el.replaceChildren(); } };
}

// ── D#6 R-CHK-3c: the Repos app's check command form. The check is the one command a runner runs after the agent; an owner or admin approves, edits or
// removes it here. It is part of the same approved set the allowance panel sends (PUT sandbox-allowances replaces the whole set), so every send below
// carries the approved entries and timeout along. A suggestion read from the repo's branch is only ever shown; nothing is approved until the person has
// opened it for review, seen every argument and typed the repo's name. Every node comes from h() (text, never markup); every sentence is this file's own.

export const DEFAULT_LIMITS = { max_argv: 16, max_arg_chars: 256, min_timeout_s: 60, max_timeout_s: 10800 };
export const SPACE = "␣"; // the open-box mark shown in place of each space
export const SOURCE_LINE = "Suggested from .fulcrumaxe/runner-sandbox.json on the default branch tip, which an agent can edit. Nobody has approved it.";
export const COPY = {
  none: "No check is approved. A runner won't run a check after the agent.",
  approved: "Approved. A runner runs it after the agent finishes.",
  setAside: "The approved check is set aside because this repo left the runner. Approve it again before it applies.",
  runnerOld: "Update your runner to run this repository's check.",
  unreadable: "The check in .fulcrumaxe/runner-sandbox.json could not be read.",
  unavailable: "The repo's suggested check isn't available right now.",
  review: "Review every argument below, exactly as a runner will run it. " + SPACE + " marks a space.",
  notRunner: "This repo doesn't run on a runner, so a check can't be approved.",
};
const isArg = (a) => typeof a === "string" && a.length >= 1 && a.length <= DEFAULT_LIMITS.max_arg_chars && /^[\x20-\x7e]+$/.test(a);

/** One argument as the person must see it: quoted, each space marked, so leading, trailing and only-space arguments cannot pass for empty or tidy. */
export const showArg = (a) => '"' + String(a).replace(/ /g, SPACE) + '"';

/** The sentence for a draft the server would refuse, or "" when it is fine. The same bounds as the server's schema. */
export function draftProblem(d, limits = DEFAULT_LIMITS) {
  if (!d.argv.length) return "Add at least one argument.";
  if (d.argv.length > limits.max_argv) return "A check takes at most " + limits.max_argv + " arguments.";
  if (!d.argv.every(isArg)) return "Each argument must be 1 to " + limits.max_arg_chars + " printable characters.";
  const t = d.timeout_s;
  return Number.isInteger(t) && t >= limits.min_timeout_s && t <= limits.max_timeout_s ? "" : "The time limit must be " + limits.min_timeout_s + " to " + limits.max_timeout_s + " seconds.";
}
const sameCheck = (a, b) => !!a && !!b && a.dev_shell === b.dev_shell && a.timeout_s === b.timeout_s && a.argv.length === b.argv.length && a.argv.every((x, i) => x === b.argv[i]);
const readCheck = (c) => (c && Array.isArray(c.argv) && c.argv.every((a) => typeof a === "string") ? { argv: c.argv, dev_shell: c.dev_shell === true, timeout_s: c.timeout_s } : null);

/** What the section shows, reduced from the view (GET) and the draft. `kind` is none | suggested | approved | set_aside; runnerOld is a flag beside it. */
export function checkModel({ view, draft, typed, repoName, phase, runnerOutdated }) {
  const approved = readCheck(view.approved && view.approved.check);
  const sug = view.suggested_check && typeof view.suggested_check === "object" ? view.suggested_check : null;
  const suggested = !approved && sug && sug.status === "ok" ? readCheck(sug.check) : null;
  const canChange = view.can_change === true, setAside = view.set_aside === true;
  const problem = draft ? draftProblem(draft, view.limits && view.limits.max_check_timeout_s ? { ...DEFAULT_LIMITS, max_timeout_s: view.limits.max_check_timeout_s } : DEFAULT_LIMITS) : "";
  const onRunner = view.execution_mode === "runner_local";
  const unchanged = !!draft && sameCheck(draft, approved) && !setAside;
  return {
    kind: approved ? (setAside ? "set_aside" : "approved") : suggested ? "suggested" : "none",
    approved, suggested, canChange, problem, onRunner, unchanged, drafting: !!draft,
    runnerOld: !!approved && !setAside && runnerOutdated === true,
    note: !approved && sug && sug.status === "unreadable" ? COPY.unreadable : !approved && sug && sug.status === "unavailable" ? COPY.unavailable : "",
    approveDisabled: !canChange || !draft || problem !== "" || unchanged || !onRunner || phase === "saving" || !(repoName !== "" && typed === repoName),
  };
}

/** The PUT body: the approved entries and timeout stay as they are, the check is the only thing that moves. `check` null removes it. */
export function checkBody(view, check, typed) {
  const a = view.approved, entries = a && Array.isArray(a.entries) ? a.entries.map((e) => ({ kind: e.kind, value: e.value, access: e.access, reason: e.reason })) : [];
  const set = { entries, ...(entries.length && Number.isInteger(a.command_timeout_s) ? { command_timeout_s: a.command_timeout_s } : {}), ...(check ? { check } : {}) };
  // Entries or a check make the server ask for the repo's name, so a removal from a set with entries sends the name the person already confirmed.
  return check || entries.length ? { set, confirm_repo: typed } : { set };
}

/** Rebuilds `root` with `draw`, then puts focus (and the caret) back on the same control, found by its test id and place among those, so a repaint never drops it mid-draft. */
export function keepFocus(root, draw) {
  const a = document.activeElement, id = a && root.contains(a) ? a.getAttribute("data-testid") : null;
  const at = id ? [...root.querySelectorAll('[data-testid="' + id + '"]')].indexOf(a) : -1;
  const start = at >= 0 && typeof a.selectionStart === "number" ? [a.selectionStart, a.selectionEnd] : null;
  draw();
  if (at < 0) return;
  const next = root.querySelectorAll('[data-testid="' + id + '"]')[at];
  if (!next || next.disabled) return;
  next.focus();
  if (start) try { next.setSelectionRange(start[0], start[1]); } catch { /* number inputs have no caret */ }
}

const argList = (argv, testid) =>
  h("ol", { class: "repos-check-argv", "data-testid": testid }, argv.map((a) => h("li", null, h("code", { class: "repos-check-arg", "data-testid": "repos-check-arg" }, showArg(a)))));
const facts = (c) => h("p", { class: "repos-muted", "data-testid": "repos-check-facts" }, (c.dev_shell ? "Runs in the repo's dev shell." : "Runs outside the dev shell.") + " Time limit: " + c.timeout_s + " seconds.");

/** `call(method, repoId, body)` runs the request; `errorText(e)` is the sentence for a failed one; `onView(next)` hands a successful answer back to the panel. */
export function createCheckSection({ call, isCancelled, errorText, onView }) {
  const el = h("div", { class: "repos-check", "data-testid": "repos-check" });
  let ctx = null, draft = null, typed = "", phase = "idle", notice = "", confirmRemove = false, gen = 0;
  const line = (text, testid, cls, role) => h("p", { class: cls, role, "data-testid": testid }, text);
  const btn = (text, testid, onClick, disabled = false, label) => h("button", { type: "button", class: "repos-btn", "data-testid": testid, disabled, onClick, ...(label ? { "aria-label": label } : {}) }, text);
  const model = () => checkModel({ view: ctx.view, draft, typed, repoName: ctx.repoName, phase, runnerOutdated: ctx.runnerOutdated });
  const open = (c, source) => { draft = { argv: [...c.argv], dev_shell: c.dev_shell, timeout_s: c.timeout_s, source }; typed = ""; notice = ""; confirmRemove = false; paint(); };

  async function send(check) {
    const id = ctx.repoId, mine = ++gen;
    phase = "saving"; notice = "";
    paint();
    try {
      const res = await call("PUT", id, checkBody(ctx.view, check, check ? typed : ctx.repoName));
      if (mine !== gen || isCancelled()) return;
      draft = null; typed = ""; confirmRemove = false; phase = "done";
      notice = check ? (res && res.changed === false ? "That check was already approved. Nothing changed." : "Approved. It applies from the next job.") : "The check is removed. It applies from the next job.";
      onView(res);
    } catch (e) {
      if (mine !== gen || isCancelled() || (e && e.name === "AbortError")) return;
      phase = "error"; notice = errorText(e);
    }
    paint();
  }

  function draftParts(m) {
    const rows = draft.argv.map((a, i) => {
      const code = h("code", { class: "repos-check-arg", "data-testid": "repos-check-arg" }, showArg(a));
      const input = h("input", { type: "text", class: "repos-check-input", value: a, autocomplete: "off", spellcheck: false, "aria-label": "Argument " + (i + 1), "data-testid": "repos-check-input", disabled: phase === "saving" });
      input.addEventListener("input", () => { draft.argv[i] = input.value; code.textContent = showArg(input.value); sync(); });
      return h("li", { class: "repos-check-row" }, input, code, btn("Remove", "repos-check-drop-arg", () => { draft.argv.splice(i, 1); paint(); }, draft.argv.length < 2 || phase === "saving", "Remove argument " + (i + 1)));
    });
    const dev = h("input", { type: "checkbox", checked: draft.dev_shell, "data-testid": "repos-check-devshell", disabled: phase === "saving" });
    dev.addEventListener("change", () => { draft.dev_shell = dev.checked; sync(); });
    const time = h("input", { type: "number", value: String(draft.timeout_s ?? ""), min: 60, "data-testid": "repos-check-timeout", "aria-label": "Time limit in seconds", disabled: phase === "saving" });
    time.addEventListener("input", () => { draft.timeout_s = time.value === "" ? NaN : Number(time.value); sync(); });
    const name = h("input", { type: "text", class: "repos-allow-name", autocomplete: "off", spellcheck: false, value: typed, "data-testid": "repos-check-name", "aria-label": "Type the repo's full name to approve the check", disabled: phase === "saving" || ctx.repoName === "" });
    name.addEventListener("input", () => { typed = name.value; sync(); });
    return [
      ...(draft.source === "suggested" ? [line(SOURCE_LINE, "repos-check-source", "repos-muted")] : []),
      line(COPY.review, "repos-check-review", "repos-muted"),
      h("ol", { class: "repos-check-argv", "data-testid": "repos-check-draft" }, rows),
      btn("Add argument", "repos-check-add-arg", () => { draft.argv.push(""); paint(); }, draft.argv.length >= DEFAULT_LIMITS.max_argv || phase === "saving"),
      h("label", { class: "repos-check-line" }, dev, h("span", null, " Run it in the repo's dev shell")),
      h("label", { class: "repos-check-line" }, h("span", null, "Time limit (seconds) "), time),
      h("p", { class: "repos-error", role: "alert", "data-testid": "repos-check-problem" }, m.problem),
      ...(m.onRunner ? [] : [line(COPY.notRunner, "repos-check-not-runner", "repos-error", "alert")]),
      h("label", { class: "repos-allow-confirm" }, h("span", null, "Type ", h("bdi", null, ctx.repoName || "the repo's name"), " to approve"), name),
      h("div", { class: "repos-actions" },
        btn(phase === "saving" ? "Approving..." : "Approve", "repos-check-approve", () => !model().approveDisabled && send({ argv: [...draft.argv], dev_shell: draft.dev_shell, timeout_s: draft.timeout_s }), m.approveDisabled),
        btn("Cancel", "repos-check-cancel", () => { draft = null; typed = ""; notice = ""; paint(); }, phase === "saving")),
    ];
  }

  function sync() {
    const m = model(), b = el.querySelector('[data-testid="repos-check-approve"]'), p = el.querySelector('[data-testid="repos-check-problem"]');
    if (b) b.disabled = m.approveDisabled;
    if (p) p.textContent = m.problem;
  }

  function paint() { keepFocus(el, drawCheck); }
  function drawCheck() {
    if (!ctx) return el.replaceChildren();
    const m = model(), a = m.approved;
    const parts = [h("h5", { class: "repos-allow-head" }, "Check command")];
    if (!a) parts.push(line(COPY.none, "repos-check-none", "repos-muted"));
    else {
      parts.push(line(m.kind === "set_aside" ? COPY.setAside : COPY.approved, "repos-check-state", "repos-muted"), argList(a.argv, "repos-check-approved"), facts(a));
      if (m.runnerOld) parts.push(line(COPY.runnerOld, "repos-check-runner-old", "repos-error", "alert"));
    }
    if (!m.canChange) parts.push(line("Only owners and admins can change this.", "repos-check-admin-only", "repos-muted"));
    else if (draft) parts.push(...draftParts(m));
    else {
      if (m.note) parts.push(line(m.note, "repos-check-note", "repos-muted"));
      const acts = [];
      if (m.suggested) {
        parts.push(line(SOURCE_LINE, "repos-check-source", "repos-muted"));
        acts.push(btn("Review the suggested check", "repos-check-review-btn", () => open(m.suggested, "suggested")));
      }
      if (a) acts.push(btn("Edit", "repos-check-edit", () => open(a, "edit")), btn("Remove", "repos-check-remove", () => { confirmRemove = true; notice = ""; paint(); }));
      else if (!m.suggested) acts.push(btn("Add a check", "repos-check-add", () => open({ argv: [""], dev_shell: true, timeout_s: 5400 }, "new")));
      if (confirmRemove) {
        parts.push(line("Remove this check? Runs will stop checking after the agent.", "repos-check-remove-ask", "repos-muted"),
          h("div", { class: "repos-actions" }, btn(phase === "saving" ? "Removing..." : "Remove the check", "repos-check-remove-yes", () => send(null), phase === "saving"), btn("Keep it", "repos-check-remove-no", () => { confirmRemove = false; paint(); }, phase === "saving")));
      } else parts.push(h("div", { class: "repos-actions" }, acts));
    }
    if (notice) parts.push(line(notice, phase === "error" ? "repos-check-save-error" : "repos-check-done", phase === "error" ? "repos-error" : "repos-note", phase === "error" ? "alert" : "status"));
    el.replaceChildren(...parts);
  }

  return {
    el,
    /** The panel's view of the repo changed (a load, or an approval of either kind). A different repo drops any draft. */
    update(next) {
      if (!ctx || ctx.repoId !== next.repoId) { draft = null; typed = ""; phase = "idle"; notice = ""; confirmRemove = false; gen++; }
      ctx = next;
      paint();
    },
    clear() { ctx = null; draft = null; gen++; paint(); },
  };
}
