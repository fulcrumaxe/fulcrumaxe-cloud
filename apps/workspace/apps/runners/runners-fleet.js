// D#605 FL-9: the Runners app's logic, with no DOM (unit-tested with a fake call()). The page is runners-app.js.
//
// One read, GET /api/runners, gives every runner with the words it is shown by: a state, the controls the caller is offered (and the reason
// for each they are not), the account line, and the data "Register this machine again" starts from. The cloud decides all of it; this file
// only words it. A refusal is shown as a sentence chosen by status and code here, never the server's message. Nothing here puts null or
// undefined on a screen: every text function returns a string.
import { api } from "../_lib/api.js";

export const RUNNERS_URL = "/api/runners";
export const TOKENS_URL = "/api/runners/provisioning-tokens";
export const CODES_URL = "/api/runners/registration-codes";
export const REPOS_URL = "/api/v1/repos";
export const actionUrl = (id, action) => RUNNERS_URL + "/" + encodeURIComponent(id) + "/" + action;
export const tokenUrl = (id) => TOKENS_URL + "/" + encodeURIComponent(id);

export const MODE_WORDS = { subscription: "Claude subscription", api_key: "API key" };
// Each state is a mark and words, so no state is shown by colour alone. The mark is decoration (aria-hidden); the words carry the meaning.
export const STATE_MARKS = { online_idle: "●", busy: "◐", paused: "❚❚", draining: "◔", not_responding: "◌", offline: "○", outdated: "▲", revoked: "✕" };
export const STATE_WORDS = { online_idle: "Online", busy: "Busy", paused: "Paused", draining: "Finishing current work", not_responding: "Not responding", offline: "Offline", outdated: "Needs an update", revoked: "Revoked" };
export const ONLY_ADMINS = "Only owners and admins can add a runner.";
export const TTL_CHOICES = [
  { seconds: 3600, words: "1 hour" },
  { seconds: 21600, words: "6 hours" },
  { seconds: 86400, words: "24 hours" },
];
const LABEL = /^[a-z0-9][a-z0-9-]{0,31}$/;
const text = (v) => (typeof v === "string" ? v.trim() : "");
const cancelled = (e) => e && e.name === "AbortError";
const statusOf = (e) => (e && typeof e.status === "number" ? e.status : 0);
// D#6 RUNNER-PING: while a "Check runner now" waits for its answer, the read is repeated this often (the cloud decides within 60 s).
export const CHECK_POLL_MS = 5000;
// D#6 RUNNER-PING: shown on a runner whose check was sent but whose answer could not be read; the re-reads have stopped and the button works again.
export const CHECK_READ_FAILED = "Couldn't check the runner. Try again.";
const CHECK_STATUSES = ["checking", "answered", "no_reply"];

/** One runner of the read, or null when it is not usable. Every text field is a string. */
export function readRunner(r) {
  if (!r || typeof r.id !== "string" || !r.registered_by || typeof r.registered_by.id !== "string" || typeof r.state !== "string") return null;
  const person = text(r.registered_by.name) || "A team member";
  const cap = r.capacity && typeof r.capacity === "object" ? r.capacity : null;
  const prov = r.provisioning && typeof r.provisioning === "object" ? r.provisioning : null;
  return {
    id: r.id,
    name: text(r.name) || "Unnamed runner (" + person + ")",
    hasName: r.has_name === true,
    person,
    state: r.state,
    note: text(r.state_note),
    check: r.check && CHECK_STATUSES.includes(r.check.status) ? r.check.status : "",
    revokedReason: r.revoked_reason === "registrant_left" ? "registrant_left" : "",
    mode: r.credential_mode,
    version: text(r.binary_version),
    lastSeen: typeof r.last_seen_at === "string" ? r.last_seen_at : "",
    loadLabel: text(r.load_label),
    capacity: cap ? { light: cap.light, heavy: cap.heavy, total: cap.total_limit, limitedBy: typeof cap.limited_by === "string" ? cap.limited_by : "" } : null,
    runs: (Array.isArray(r.current_runs) ? r.current_runs : []).filter((x) => x && typeof x.id === "string").map((x) => ({ id: x.id, label: text(x.label) || "A run" })),
    repos: (Array.isArray(r.repos) ? r.repos : []).map((x) => text(x && x.name)).filter(Boolean),
    labels: (Array.isArray(r.labels) ? r.labels : []).map(text).filter(Boolean),
    facts: r.facts && typeof r.facts === "object" ? { os: text(r.facts.os), arch: text(r.facts.arch), engine: text(r.facts.engine), preflight: readPreflight(r.facts.preflight) } : null,
    sandboxes: readSandboxes(r.sandboxes),
    paused: r.paused === true,
    draining: r.draining === true,
    controls: r.controls && typeof r.controls === "object" ? r.controls : null,
    prov: prov ? { by: text(prov.minted_by && prov.minted_by.name) || "A team member", ip: text(prov.first_ip) } : null,
    again: r.register_again && typeof r.register_again === "object" ? { name: text(r.register_again.name), labels: Array.isArray(r.register_again.labels) ? r.register_again.labels.map(text).filter(Boolean) : [], repoIds: Array.isArray(r.register_again.repo_ids) ? r.register_again.repo_ids.filter((x) => typeof x === "string") : [] } : null,
  };
}

/** The whole read, or null unless it has the runners list, the viewer's role and the account line. */
export function readFleet(body) {
  if (!body || !Array.isArray(body.runners) || !body.viewer || !body.account || typeof body.account.capacity !== "number") return null;
  const a = body.account;
  return {
    runners: body.runners.map(readRunner).filter(Boolean),
    role: body.viewer.role,
    isAdmin: body.viewer.role === "owner" || body.viewer.role === "admin",
    account: { limit: typeof a.limit === "number" ? a.limit : null, capacity: a.capacity, running: typeof a.running === "number" ? a.running : 0, count: a.runner_count, most: typeof a.runner_limit === "number" ? a.runner_limit : null },
  };
}

/** "Capacity 16 of account limit 16 · 3 running". The capacity is already held to the limit by the cloud, so it never reads above it. */
export function accountText(a) {
  const running = a.running + " running";
  // The cloud already holds the capacity to the limit; this holds it again, so no stale or odd reply can show more than the limit.
  return a.limit === null ? "Capacity " + a.capacity + " · " + running + " · account limit unavailable" : "Capacity " + Math.min(a.capacity, a.limit) + " of account limit " + a.limit + " · " + running;
}

/** The sentence under the account line when the plan's runner count is reached, or "". */
export function runnerLimitText(a) {
  if (a.most === null || a.count < a.most) return "";
  return a.count > a.most ? "Over your plan's runner limit: remove one to add another" : "You have all " + a.most + " runners your plan allows: remove one to add another";
}

/** The state as { mark, words }: "Paused · Resumes within 5 min", "Finishing current work", "Revoked: registrant left". */
export function stateParts(r) {
  const mark = STATE_MARKS[r.state] || "";
  // D#6 RUNNER-PING: a check in flight reads "Checking…" until the cloud has the answer ("Online · just now" or "Not responding — no reply in 60 s").
  // A runner that already reads Not responding says Checking… too while a new check waits, then gives its answer again, so the press visibly did something.
  if (r.check === "checking" && (r.state === "online_idle" || r.state === "busy" || r.state === "offline" || r.state === "not_responding")) return { mark, words: "Checking…" };
  if (r.state === "not_responding") return { mark, words: ["Not responding", r.note].filter(Boolean).join(" — ") };
  // A wake-capable runner past the 2-minute window but inside its 35-minute slot reads "Online · Last heard 7 min ago" (the note comes from the cloud).
  if (r.state === "busy") return { mark, words: [r.loadLabel || "Busy", r.note].filter(Boolean).join(" · ") };
  if (r.state === "online_idle") return { mark, words: ["Online", r.note].filter(Boolean).join(" · ") };
  if (r.state === "paused") return { mark, words: ["Paused", r.note].filter(Boolean).join(" · ") };
  if (r.state === "revoked") return { mark, words: r.note || "Revoked" };
  return { mark, words: STATE_WORDS[r.state] || "Unknown" };
}

export const versionText = (r) => [r.version || "Version unknown", r.state === "outdated" ? "Update needed" : ""].filter(Boolean).join(" · ");
// How often the open Runners page reads the fleet again on its own, so "Last check-in" and the capacity are what the cloud has now, not what it had when the page opened.
export const FLEET_REFRESH_MS = 30_000;
// The cause a runner gives for holding work back (its `limited_by`), in words; a cause this build does not know says nothing rather than show a code.
export const LIMITED_WORDS = {
  memory: "memory is short",
  cpu: "the CPU is busy",
  disk: "disk space is low",
  paused: "claiming is paused",
  usage_limit: "the Claude usage limit is reached",
  ceiling: "it is at its job limit",
};
/** "Held back: memory is short", or "" when the runner gave no cause (or one this build does not know). */
export function heldBackText(r) {
  if (r.state === "revoked" || r.capacity === null || !Object.hasOwn(LIMITED_WORDS, r.capacity.limitedBy)) return "";
  return LIMITED_WORDS[r.capacity.limitedBy];
}
/** "just now", "5 min ago", "3 h ago", "2 days ago" for an ISO time against `nowMs`; "" when it is not a time. A time a little ahead of the clock reads "just now". */
export function agoText(iso, nowMs) {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "";
  const secs = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (secs < 90) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return mins + " min ago";
  const hours = Math.floor(mins / 60);
  if (hours < 48) return hours + " h ago";
  return Math.floor(hours / 24) + " days ago";
}
export const capacityText = (r) =>
  r.state === "revoked" ? "None" : r.capacity === null ? "Capacity unknown" : "Light " + r.capacity.light.in_use + " of " + r.capacity.light.limit + " · Heavy " + r.capacity.heavy.in_use + " of " + r.capacity.heavy.limit;
// D#845 ON-21b: the preflight codes the machine reported, each with the cloud's one fixed line. null: the machine has not said (an old runner, or none yet); []: every check passed. Anything that is not a
// { code, fix } pair of short strings is dropped, so nothing else can reach the screen.
const readPreflight = (list) => (Array.isArray(list) ? list.filter((x) => x && typeof x.code === "string" && typeof x.fix === "string" && x.fix !== "" && x.fix.length <= 400).slice(0, 40).map((x) => ({ code: x.code, fix: x.fix })) : null);
export const NO_PREFLIGHT = "Not reported yet";
export const PREFLIGHT_OK = "All checks passed";
/** The Machines row's preflight lines: the distinct fixed lines of the reported codes, or null while the machine has not said (the row then says NO_PREFLIGHT), or [] when every check passed. */
export const preflightLines = (r) => (r.facts === null || r.facts.preflight === null ? null : [...new Set(r.facts.preflight.map((p) => p.fix))]);
export const factsText = (r) => (r.facts === null ? "Not reported yet" : [r.facts.os, r.facts.arch, r.facts.engine].filter(Boolean).join(" · ") || "Not reported yet");
export const provText = (r) => (r.prov === null ? "" : "Made from a token by " + r.prov.by + (r.prov.ip ? " · first seen at " + r.prov.ip : ""));

/** Which controls a row shows, in order: [{ action, label }]. A removed runner has none (the register-again button is separate). */
export function controlList(r) {
  if (r.controls === null) return [];
  const held = r.paused || r.draining;
  return [
    ...(held ? [{ action: "resume", label: "Resume" }] : [{ action: "pause", label: "Pause" }, { action: "drain", label: "Finish current work" }]),
    { action: "rename", label: "Rename" },
    { action: "check", label: "Check runner now" },
    { action: "remove", label: "Remove" },
  ].map((c) => ({ ...c, allowed: r.controls[c.action] ? r.controls[c.action].allowed === true : false, reason: r.controls[c.action] && typeof r.controls[c.action].reason === "string" ? r.controls[c.action].reason : "" }));
}

export const ACTION_SENTENCES = {
  403: "You can't do that to this runner.",
  404: "That runner isn't there any more.",
  409: "That runner was already removed.",
  503: "The check couldn't be sent. Try again in a moment.",
  400: "That name isn't allowed. Use 1 to 64 printable characters.",
  other: "That change couldn't be saved. Try again.",
};
const sentence = (table, e) => table[statusOf(e)] || table.other;

/**
 * The fleet: one read, and the actions on a runner. A runner with an action in flight ignores every other click on it, so a double click is one request.
 * `act` resolves to "" on success (the read is repeated, so the row shows what is now true) or the sentence to show.
 */
export function createFleet({ call = api, signal, onChange = () => {}, schedule = (fn, ms) => setTimeout(fn, ms) } = {}) {
  let st = { status: "loading", fleet: null };
  const pending = new Set();
  let gen = 0;
  let polling = false;
  // Runners whose check was waiting when a read failed: the re-reads stop and the row says so until the next press or the next good read.
  const readFailedFor = new Set();
  // One timer at a time, and only while some runner's check or sandbox command is still waiting: an idle page never polls.
  function pollWhileChecking() {
    if (polling || (signal && signal.aborted) || !st.fleet || !st.fleet.runners.some((r) => r.check === "checking" || sandboxCommandWaiting(r))) return;
    polling = true;
    schedule(() => {
      polling = false;
      if (!(signal && signal.aborted)) load();
    }, CHECK_POLL_MS);
  }
  async function load() {
    const mine = ++gen;
    try {
      const fleet = readFleet(await call("GET", RUNNERS_URL, undefined, signal));
      if (mine !== gen) return;
      st = fleet ? { status: "ready", fleet } : { status: st.fleet ? "ready" : "error", fleet: st.fleet };
      if (fleet) readFailedFor.clear();
      else stopWaitingChecks();
    } catch (e) {
      if (mine !== gen || cancelled(e)) return;
      if (st.status !== "ready") st = { status: "error", fleet: null };
      stopWaitingChecks();
    }
    onChange();
    pollWhileChecking();
  }
  // A failed read must not leave "Checking…" on the row for good, nor read again every 5 s: the waiting checks are dropped from the last good read.
  function stopWaitingChecks() {
    if (!st.fleet) return;
    const runners = st.fleet.runners.map((r) => {
      if (r.check !== "checking") return r;
      readFailedFor.add(r.id);
      return { ...r, check: "" };
    });
    st = { ...st, fleet: { ...st.fleet, runners } };
  }
  async function act(id, action, body) {
    if (pending.has(id)) return "";
    readFailedFor.delete(id);
    pending.add(id);
    onChange();
    let result = "";
    try {
      await call("POST", actionUrl(id, action), body === undefined ? {} : body, signal);
    } catch (e) {
      if (cancelled(e)) {
        pending.delete(id);
        return "";
      }
      result = action === SANDBOX_ACTION ? sandboxSentence(e) : sentence(ACTION_SENTENCES, e);
    }
    pending.delete(id);
    await load();
    return result;
  }
  return { load, act, isPending: (id) => pending.has(id), readFailed: (id) => readFailedFor.has(id), get state() { return st; } };
}

// ── Sandboxes (D#587 B-7b-ii) ───────────────────────────────────────────
// What a runner reports about its sandboxes is its own claim, shown as such: every list says how old it is and reads "out of date" once the runner no longer
// reports. The buttons send a typed command (stop, delete or reap); the answer comes back through the same read, one state per command.

export const SANDBOX_ACTION = "sandbox-commands";
export const SANDBOX_STATE_WORDS = { creating: "Starting", running: "Running", stopped: "Stopped", snapshotted: "Saved as a snapshot", error: "Error" };
export const SANDBOX_STATUS_WORDS = {
  never: "This runner hasn't reported any sandboxes.",
  current: "",
  stale_older: "Out of date: this runner no longer reports sandboxes (it is on an older version).",
  stale_engine: "Out of date: this runner has gone back to the standard sandbox and no longer reports these.",
  removed: "Runner removed. These were its last reported sandboxes.",
};
export const SANDBOX_COMMAND_STATE_WORDS = {
  pending: "Waiting for the runner",
  delivered: "Sent, waiting for the runner's answer",
  applied: "Done",
  refused: "Refused",
  expired: "Expired before the runner took it",
  unanswered: "Unanswered: the runner never replied",
  cancelled: "Cancelled",
};
export const SANDBOX_REFUSAL_WORDS = { name_unknown: "the runner has no such sandbox", in_use: "it is in use", unsupported: "this runner can't do that yet", failed: "it failed on the runner" };
export const SANDBOX_NOT_ADMIN = "Only owners and admins can change a runner's sandboxes.";
const SANDBOX_SENTENCES = {
  400: "That sandbox request isn't valid.",
  403: SANDBOX_NOT_ADMIN,
  404: "That runner isn't there any more.",
  429: "Too many sandbox requests are waiting for this runner. Try again once they finish.",
  other: "That request couldn't be sent. Try again.",
};
const SANDBOX_CONFLICTS = { runner_revoked: "That runner was removed.", not_supported: "This runner doesn't take sandbox commands." };
export const sandboxSentence = (e) => (statusOf(e) === 409 ? (e && Object.hasOwn(SANDBOX_CONFLICTS, e.code) ? SANDBOX_CONFLICTS[e.code] : SANDBOX_SENTENCES.other) : sentence(SANDBOX_SENTENCES, e));

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const when = (v) => (typeof v === "string" ? v : "");

/** The sandbox part of one runner of the read, or null when the cloud sent none. */
export function readSandboxes(s) {
  if (!s || typeof s !== "object" || !Object.hasOwn(SANDBOX_STATUS_WORDS, s.status)) return null;
  const lim = s.limits && typeof s.limits === "object" ? s.limits : {};
  return {
    status: s.status,
    seenAt: when(s.seen_at),
    canCommand: s.can_command === true,
    limits: { vms: num(lim.vms), vcpus: num(lim.vcpus), memoryMb: num(lim.memory_mb) },
    boxes: (Array.isArray(s.sandboxes) ? s.sandboxes : []).filter((b) => b && typeof b.name === "string").map((b) => ({ name: b.name, state: text(b.state), created: when(b.created_at), lastUsed: when(b.last_used_at), diskBytes: num(b.disk_bytes) || 0, snapshots: num(b.snapshot_count) || 0, snapshotAgeS: num(b.snapshot_newest_secs) })),
    commands: (Array.isArray(s.commands) ? s.commands : []).filter((c) => c && typeof c.id === "string" && Object.hasOwn(SANDBOX_COMMAND_STATE_WORDS, c.state)).map((c) => ({ id: c.id, kind: text(c.kind), name: text(c.name), state: c.state, refusal: text(c.refusal), issued: when(c.issued_at) })),
  };
}

/** True while a command of this runner waits for the runner or its answer: the page reads again on its own until none does. */
export const sandboxCommandWaiting = (r) => r.sandboxes !== null && r.sandboxes.commands.some((c) => c.state === "pending" || c.state === "delivered");

export function bytesText(n) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return (i === 0 || v >= 100 ? Math.round(v) : Math.round(v * 10) / 10) + " " + units[i];
}
const mbText = (mb) => (mb >= 1024 ? Math.round((mb / 1024) * 10) / 10 + " GB" : mb + " MB");
/** "5 min", "3 h", "2 days" for a number of seconds. */
export function spanText(secs) {
  if (secs < 90) return secs + " s";
  const mins = Math.floor(secs / 60);
  if (mins < 90) return mins + " min";
  const hours = Math.floor(mins / 60);
  return hours < 48 ? hours + " h" : Math.floor(hours / 24) + " days";
}

/** The line above the list: how old it is, and the reason when it is out of date. */
export function sandboxStatusText(s, nowMs) {
  const age = s.seenAt ? "Reported " + agoText(s.seenAt, nowMs) : "";
  return [age, SANDBOX_STATUS_WORDS[s.status]].filter(Boolean).join(" · ");
}

/** The quota lines: sandboxes running against the VM limit, the other limits as the runner gave them, and the disk the listed sandboxes hold. */
export function sandboxQuotaLines(s) {
  const live = s.boxes.filter((b) => b.state === "running" || b.state === "creating").length;
  return [
    s.limits.vms === null ? "Running: " + live + " (limit not reported)" : "Running: " + live + " of " + s.limits.vms + " allowed",
    "Disk in use: " + bytesText(s.boxes.reduce((n, b) => n + b.diskBytes, 0)),
    "vCPU limit: " + (s.limits.vcpus === null ? "not reported" : s.limits.vcpus) + " · Memory limit: " + (s.limits.memoryMb === null ? "not reported" : mbText(s.limits.memoryMb)),
  ];
}

/** One sandbox as { name, state, ages, disk }; a missing field reads "not reported", never blank. */
export function sandboxLine(b, nowMs) {
  const created = b.created ? "Created " + agoText(b.created, nowMs) : "Created: not reported";
  const used = b.lastUsed ? "Last used " + agoText(b.lastUsed, nowMs) : "Never used";
  const snaps = b.snapshots === 0 ? "No snapshots" : b.snapshots + (b.snapshots === 1 ? " snapshot" : " snapshots") + (b.snapshotAgeS === null ? "" : ", newest " + spanText(b.snapshotAgeS) + " old");
  return { name: b.name, state: SANDBOX_STATE_WORDS[b.state] || "Unknown", ages: [created, used].join(" · "), disk: bytesText(b.diskBytes) + " · " + snaps };
}

/** The buttons a sandbox row shows, and the Reap button: [{ action, label, allowed, reason }]. The cloud checks all of it again when the request arrives. */
export function sandboxControls(s, isAdmin, box) {
  const why = !isAdmin ? SANDBOX_NOT_ADMIN : !s.canCommand ? SANDBOX_STATUS_WORDS[s.status] || "This runner doesn't take sandbox commands." : "";
  if (box === undefined) {
    const none = !s.boxes.some((b) => b.state === "stopped" || b.state === "snapshotted");
    return { action: "reap_sandboxes", label: "Reap stopped sandboxes", allowed: why === "" && !none, reason: why || (none ? "No sandbox is stopped." : "") };
  }
  const live = box.state === "running" || box.state === "creating";
  return [
    { action: "stop_sandbox", label: "Stop", allowed: why === "" && live, reason: why || (live ? "" : "Not running.") },
    { action: "delete_sandbox", label: "Delete", allowed: why === "", reason: why },
  ];
}

/** One command as a sentence: "Delete sandbox web-1: Refused (it is in use)". */
export function sandboxCommandText(c) {
  const what = c.kind === "reap_sandboxes" ? "Reap stopped sandboxes" : (c.kind === "stop_sandbox" ? "Stop" : "Delete") + " sandbox " + c.name;
  const refused = c.state === "refused" && c.refusal ? " (" + (SANDBOX_REFUSAL_WORDS[c.refusal] || "no reason given") + ")" : "";
  return what + ": " + SANDBOX_COMMAND_STATE_WORDS[c.state] + refused;
}

/** The confirmation a delete or a reap asks for, in words. */
export const sandboxConfirm = (action, name) =>
  action === "delete_sandbox"
    ? { title: "Delete " + name + "?", body: "The sandbox and its snapshots are removed from the runner's machine. This can't be undone.", button: "Delete sandbox" }
    : { title: "Reap stopped sandboxes?", body: "Every stopped sandbox on this runner, with its snapshots, is removed from the machine. This can't be undone.", button: "Reap sandboxes" };

// ── Add a runner ────────────────────────────────────────────────────────

export const ADD_SENTENCES = {
  403: ONLY_ADMINS,
  409: "You already have {limit} unused tokens. Revoke one first.",
  400: "One of those repos isn't in this account any more. Reload and pick again.",
  other: "That couldn't be made. Try again.",
};
/** A refused repo, by the server's code (409): a runner is never bound to a repo that isn't private. */
export const ADD_REPO_SENTENCES = {
  public_repo: "One of those repos is public. A public repository can't run on a runner, so pick only private ones.",
  repo_visibility_unknown: "A repo's visibility couldn't be read. Try again in a moment.",
};
const addSentence = (e) => (statusOf(e) === 409 && e && Object.hasOwn(ADD_REPO_SENTENCES, e.code) ? ADD_REPO_SENTENCES[e.code] : sentence(ADD_SENTENCES, e));

/** Labels typed as "gpu, macos" to a list, or null when one is not a valid label (1 to 32 of a-z, 0-9 and -, up to 16). */
export function parseLabels(input) {
  const parts = String(input || "").split(/[\s,]+/).filter(Boolean);
  return parts.length <= 16 && parts.every((p) => LABEL.test(p)) ? [...new Set(parts)] : null;
}

/** The copy-ready commands for a made secret. The secret is read from standard input, so it is not an argument of fx-runner and never in the process list. */
export function commandsFor({ secret, origin, mode, name }) {
  const base = "fx-runner register --code-stdin --credential-mode " + mode + " --cloud-url " + shellQuote(origin) + (name ? " --name " + shellQuote(name) : "");
  return { register: " printf '%s' " + shellQuote(secret) + " | " + base, service: "fx-runner service install --system" };
}
/** One shell word in single quotes; a quote inside it is closed, escaped and reopened. */
const shellQuote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";

/**
 * The "Add a runner" sheet's state. Two paths: a one-time code (an interactive machine) and a provisioning token (a machine with no browser).
 * The secret lives in `made` alone and is dropped when the sheet closes, so reopening it shows only the unused tokens' names and expiries.
 */
export function createAdder({ call = api, signal, origin = "", onChange = () => {} } = {}) {
  let st = null;
  // Counts the sheet's openings and closings. A reply that arrives after the sheet it was asked for has closed is dropped, so a secret never comes back.
  let sheet = 0;
  let tokens = { status: "idle", list: [], limit: 5, error: "" };
  const set = (next) => {
    st = next;
    onChange();
  };
  async function loadTokens() {
    tokens = { ...tokens, status: "loading" };
    onChange();
    try {
      const body = await call("GET", TOKENS_URL, undefined, signal);
      const list = body && Array.isArray(body.tokens) ? body.tokens : [];
      tokens = {
        status: "ready",
        limit: body && typeof body.limit === "number" ? body.limit : 5,
        list: list.filter((t) => t && typeof t.id === "string").map((t) => ({ id: t.id, name: text(t.name) || "Unnamed token", by: text(t.minted_by && t.minted_by.name) || "A team member", mode: t.credential_mode, expires: typeof t.expires_at === "string" ? t.expires_at : "" })),
      };
    } catch (e) {
      if (cancelled(e)) return;
      tokens = { ...tokens, status: "error" };
    }
    onChange();
  }
  return {
    get state() { return st; },
    get tokens() { return tokens; },
    /** `again` is a runner's register_again data: its name, labels and repos are the form's starting values. */
    open(again) {
      sheet++;
      st = { path: again ? "token" : "code", mode: "api_key", name: again ? again.name : "", labels: again ? again.labels.join(", ") : "", repoIds: again ? [...again.repoIds] : [], ttl: 3600, phase: "form", error: "", made: null };
      loadTokens();
      onChange();
    },
    close() {
      sheet++;
      st = null; // the secret goes with it
      onChange();
    },
    /** Typing passes quiet, so the sheet is not rebuilt under the caret; the next repaint reads the state. */
    edit(patch, quiet) {
      if (!st || st.phase === "sending") return;
      if (quiet) st = { ...st, ...patch };
      else set({ ...st, ...patch, error: "" });
    },
    async submit() {
      if (!st || st.phase === "sending") return; // a double press is one request
      const labels = parseLabels(st.labels);
      if (st.repoIds.length === 0) return set({ ...st, error: "Pick at least one repo for it to work on." });
      if (st.path === "token" && labels === null) return set({ ...st, error: "Labels are lowercase letters, digits and dashes, up to 16, separated by commas." });
      const asked = st;
      const mine = sheet;
      set({ ...asked, phase: "sending", error: "" });
      try {
        const body = asked.path === "code" ? { credential_mode: asked.mode, allowed_repo_ids: asked.repoIds } : { credential_mode: asked.mode, allowed_repo_ids: asked.repoIds, labels, ttl_seconds: asked.ttl, ...(asked.name.trim() ? { name: asked.name.trim() } : {}) };
        const reply = await call("POST", asked.path === "code" ? CODES_URL : TOKENS_URL, body, signal);
        const secret = asked.path === "code" ? reply && reply.code : reply && reply.token;
        if (mine !== sheet) return; // the sheet closed while this was in flight: the secret is dropped here, unread
        if (typeof secret !== "string" || secret === "") throw new Error("no secret");
        set({ ...asked, phase: "made", error: "", made: { ...commandsFor({ secret, origin, mode: asked.mode, name: asked.path === "token" ? asked.name.trim() : "" }), secret, expires: reply && typeof reply.expires_at === "string" ? reply.expires_at : "" } });
        if (asked.path === "token") loadTokens();
      } catch (e) {
        if (cancelled(e) || mine !== sheet) return;
        set({ ...asked, phase: "form", error: addSentence(e).replace("{limit}", String(tokens.limit)) });
      }
    },
    async revoke(id) {
      try {
        await call("DELETE", tokenUrl(id), undefined, signal);
      } catch (e) {
        if (cancelled(e)) return "";
        if (statusOf(e) !== 404) {
          tokens = { ...tokens, error: "That token couldn't be revoked. Try again." };
          onChange();
          return tokens.error;
        }
      }
      tokens = { ...tokens, error: "" };
      await loadTokens();
      return "";
    },
  };
}

/** Every installed repo as { id, name }, following the cursor. The name is "owner/name", else the product, never an id. */
export async function loadRepoChoices(call = api, signal) {
  const out = [];
  let cursor = "";
  for (let i = 0; i < 50; i++) {
    const page = await call("GET", REPOS_URL + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""), undefined, signal);
    for (const r of page && Array.isArray(page.data) ? page.data : []) {
      if (r && r.install_state === "installed" && typeof r.id === "string") out.push({ id: r.id, name: text(r.full_name) || text(r.product) || "A repository" });
    }
    if (!page || !page.next_cursor) break;
    cursor = page.next_cursor;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// D#845 MC-10a: the Machines tab's logic. It lives in this file so the app adds no boot request.

export const MACHINES_URL = "/api/machines";
export const MACHINES_UNAVAILABLE = "Machines couldn't be loaded";
export const NO_MACHINES = "No machines yet";
export const ONLY_ADMINS_ADD = "Only owners and admins can add a machine.";
export const SERVERS_UNAVAILABLE = "Hetzner Cloud servers aren't available right now";
export const TABS = [["machines", "Machines"], ["servers", "Servers"], ["fleet", "Fleet"]];

/**
 * The isolation chip. A machine that has not said what it can do reads as not reported, never as a guess. A standard machine says "(no KVM)" only when it reported
 * the KVM fact as absent; one that reported nothing (an older runner) says nothing about KVM.
 */
export const tierText = (tier, kvm) =>
  tier === "microvm" ? "MicroVM isolation" : tier === "standard" ? "Standard isolation: one project on this machine" + (kvm === "absent" ? " (no KVM)" : "") : "Isolation not reported yet";

// D#845 FU-225: the vm-install hint a standard machine with KVM shows. The Onboarding app says the same words (onboarding-engine.js, microvm_helper_missing); a test pins that they match.
export const VM_INSTALL_COMMAND = "sudo fx-runner vm install";
export const vmInstallLine = (name) => name + " can run microVMs. Run " + VM_INSTALL_COMMAND + " on it.";
/** The derivation the Onboarding read uses (engineTrack.ts): KVM reported present on a machine running the standard engine. */
export const needsVmInstall = (tier, kvm) => kvm === "present" && tier === "standard";

/** One machine, or null when the row is not a machine. Every text is a string a person can read: no null, undefined or id reaches the screen. */
export function readMachine(m) {
  if (!m || typeof m !== "object" || typeof m.id !== "string" || m.id === "") return null;
  return {
    id: m.id,
    name: typeof m.name === "string" && m.name.trim() !== "" ? m.name : "Unnamed machine",
    kind: "Computer",
    tier: m.tier === "microvm" || m.tier === "standard" ? m.tier : null,
    kvm: m.kvm === "present" || m.kvm === "absent" ? m.kvm : null,
    live: m.live === true,
    claude: m.claude === true,
    running: m.running && typeof m.running.name === "string" && m.running.name !== "" ? m.running.name : m.running ? "a project" : null,
  };
}

/** The whole read, or null when the body is not a machine list. */
export const readMachines = (body) => (body && Array.isArray(body.machines) ? body.machines.map(readMachine).filter(Boolean) : null);

/** The commands the "A computer or server I have" choice shows, in order. `command` is null for a step that is words only. */
export function addSteps(origin) {
  return [
    { text: "Install the claude command, then run claude once and sign in.", command: null },
    { text: "Install the runner:", command: "curl -fsSL " + origin + "/install.sh | sh" },
    { text: "Link it to your account. It prints a code; open " + origin + "/link and type the code there:", command: "fx-runner setup --cloud-url " + origin },
  ];
}
// B-6-VMTOKEN: what a machine in virtual machine mode (engine microvm) with no Claude token shows. The Onboarding app says the same words (onboarding-engine.js); a test pins that they match.
export const VM_TOKEN_COMMAND = "fx-runner credentials set-vm-token";
export const VM_TOKEN_LINE = "Virtual machine mode needs a Claude token on this machine. On that machine run " + VM_TOKEN_COMMAND + ".";
export const VM_TOKEN_STAYS = "The token stays on that machine and is never sent to us.";
/** The notice is for a machine that reports the microvm engine and no usable model credential; any other engine, or one not reported, keeps the old copy. */
export const needsVmToken = (tier, claudePresent) => tier === "microvm" && claudePresent !== true;
export const KVM_NOTE = "On a server with KVM, add sudo fx-runner vm install for microVM isolation.";

/** The machine list: one read at a time, and the last good list stays on screen when a later read fails. */
export function createMachines({ call = api, signal, onChange = () => {} } = {}) {
  let st = { status: "loading", list: [] };
  let gen = 0;
  async function load() {
    const mine = ++gen;
    try {
      const list = readMachines(await call("GET", MACHINES_URL, undefined, signal));
      if (mine !== gen) return;
      st = list ? { status: "ready", list } : { status: st.status === "ready" ? "ready" : "error", list: st.list };
    } catch (e) {
      if (mine !== gen || (e && e.name === "AbortError")) return;
      if (st.status !== "ready") st = { status: "error", list: [] };
    }
    onChange();
  }
  return { get state() { return st; }, load };
}
