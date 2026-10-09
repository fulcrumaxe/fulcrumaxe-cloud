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
  return { ok: true, set: t === undefined ? { entries } : { entries, command_timeout_s: t } };
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
  const pending = s.upload ? s.upload.set : null;
  const diff = pending ? diffSets(approved, pending) : null;
  const canChange = v.can_change === true;
  const widening = !!pending && pending.entries.length > 0;
  const name = typeof s.repoName === "string" ? s.repoName : "";
  const nameOk = !widening || (name !== "" && s.typed === name);
  const notRunner = widening && v.execution_mode !== "runner_local";
  const setAside = v.set_aside === true;
  // A set-aside set still reads as approved, but the server treats approving it again as a new version, so an identical file is a change then.
  const restores = !!diff && diff.same && setAside;
  return {
    kind: "ready", canChange, approved, pending, diff, widening, notRunner, setAside, restores, inUse: v.in_use === true,
    approvedRows: approved ? entryRows(approved.entries) : null, pendingRows: pending ? entryRows(pending.entries) : null,
    needsName: widening, nameKnown: name !== "",
    approveDisabled: !canChange || !pending || (diff.same && !setAside) || s.phase === "saving" || !nameOk || notRunner,
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
 * Returns { el, show, clear }.
 */
export function createAllowancePanel({ call, isCancelled }) {
  const el = h("section", { class: "repos-allow", "aria-label": "Sandbox allowances", "data-testid": "repos-allow" });
  let s = { load: "idle", view: null, upload: null, uploadError: "", typed: "", phase: "idle", notice: "", repoId: null, repoName: "", changed: false };
  let gen = 0;
  const line = (text, testid, cls, role) => h("p", { class: cls, role, "data-testid": testid }, text);

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
    s.upload = result.ok ? { set: result.set } : null;
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
      const res = await call("PUT", id, m.widening ? { set: s.upload.set, confirm_repo: s.typed } : { set: s.upload.set });
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

  function render() {
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
    out.push(line(m.restores ? "This set was set aside. Approving it again restores it." : d.same ? "No change from the approved set." : "Changes: " + bits.join(", ") + ".", "repos-allow-diff", "repos-muted"));
    if (d.removed.length) out.push(rowList(entryRows(d.removed), "repos-allow-removed"));
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
  return { el, show, clear() { gen++; s = { ...s, load: "idle", view: null }; el.replaceChildren(); } };
}
