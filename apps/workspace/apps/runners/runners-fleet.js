// D#605 FL-9: the Runners app's logic, with no DOM (unit-tested with a fake call()). The page is runners-app.js.
//
// One read, GET /api/runners, gives every runner with the words it is shown by: a state, the controls the caller is offered (and the reason
// for each they are not), the account line, and the data "Register this machine again" starts from. The cloud decides all of it; this file
// only words it. A refusal is shown as a sentence chosen by status and code here, never the server's message. Nothing here puts null or
// undefined on a screen: every text function returns a string.
import { api, createRetryGate, waitSeconds } from "../_lib/api.js";

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

// ── D#845 MC-10b1: the Servers tab, the Hetzner credential and the create dialog ──────────────────────────────────────────────────────────────────────────────
// Every refusal is worded here from the status and the closed code; nothing the server wrote is shown. A price is never guessed: it is the live quote or nothing.
// The token is typed into one box, sent once and cleared; this file holds only its last four characters, which the cloud sends back.

export const CREDENTIAL_URL = "/api/v1/machine-credentials/hetzner";
export const SERVERS_URL = "/api/v1/machine-servers";
const enc = encodeURIComponent;
export const catalogUrl = (location) => SERVERS_URL + "/catalog" + (location ? "?location=" + enc(location) : "");
export const quoteUrl = (type, location) => SERVERS_URL + "/quote?server_type=" + enc(type) + "&location=" + enc(location);

/** The statement that comes before any price. They are the cloud's own words (the quote carries the same ones); a test pins that they match. */
export const TIER_NOTICE =
  "Hetzner Cloud servers can't run microVMs (Hetzner doesn't offer nested virtualization on cloud servers). This server will use Standard isolation and host one project. For microVM isolation, add a server you already have that has KVM (see 'A computer or server I have').";
export const BILLED_BY = "Hetzner bills you directly";
export const HETZNER_STEPS = [
  "Create a project named fulcrumaxe in the Hetzner Cloud Console.",
  "Open Security, then API tokens, and generate a token with Read & Write access.",
  "Paste it here.",
  "You can revoke it in Hetzner at any time. Removing it here deletes our copy.",
];
export const ONLY_ADMINS_HETZNER = "Only owners and admins can connect Hetzner.";
export const ONLY_ADMINS_SEE = "Only owners and admins can see servers.";
export const ONLY_ADMINS_CREATE = "Only owners and admins can create a server.";
export const CONNECT_FIRST = "Connect Hetzner first.";
export const HETZNER_REFUSED = "Hetzner refused this token. It may have been revoked";
export const HETZNER_DOWN = "Hetzner didn't answer. Try again in a minute";
export const PRICES_FAILED = "Prices couldn't be loaded";
export const PRICE_CHANGED = "The price changed. Check the new price and confirm again";
export const SLOW_DOWN = "That was too fast.";
export const SERVER_WORDS = {
  creating: "Creating", booting: "Starting up", installing: "Installing", registering: "Registering", needs_claude_login: "Needs a Claude sign-in", ready: "Ready",
  offline: "Offline", deleting: "Deleting…", failed: "Failed", orphaned: "A server we created that isn't linked any more",
};

const CONNECT_BY_CODE = {
  token_read_only: "This token is Read only. Nothing was saved. Make a Read & Write token and try again",
  token_invalid: HETZNER_REFUSED,
  invalid_token_format: "That doesn't look like a Hetzner token. Check that you copied all of it",
  already_connected: "A token is already connected. Remove it first",
  provider_unreachable: HETZNER_DOWN,
  not_configured: SERVERS_UNAVAILABLE,
  machine_kek_unset: SERVERS_UNAVAILABLE,
};
/** The sentence for a refused connect, by closed code first and then by status. */
export const connectSentence = (e) =>
  statusOf(e) === 429 ? SLOW_DOWN
  : e && Object.hasOwn(CONNECT_BY_CODE, e.code) ? CONNECT_BY_CODE[e.code]
  : statusOf(e) === 403 ? ONLY_ADMINS_HETZNER
  : "That token couldn't be saved. Try again.";
export const removeSentence = (e) => (statusOf(e) === 403 ? ONLY_ADMINS_HETZNER : "That token couldn't be removed. Try again.");

const FULL = (where) => "That size isn't available in " + where + " right now. Choose another size or location";
const CREATE_BY_CODE = (where) => ({
  price_changed: PRICE_CHANGED,
  price_unavailable: PRICES_FAILED,
  hetzner_resource_limit_exceeded: "Hetzner's server limit for your Hetzner account was reached. Ask Hetzner to raise it, or delete a server",
  hetzner_resource_unavailable: FULL(where),
  hetzner_placement_error: FULL(where),
  hetzner_unauthorized: HETZNER_REFUSED + ". Remove it and add a new one",
  hetzner_forbidden: "The Hetzner token can't do that. It needs Read & Write access",
  hetzner_server_error: HETZNER_DOWN,
  hetzner_unavailable: HETZNER_DOWN,
  hetzner_locked: "Hetzner reports the item is busy. Try again in a minute",
  credential_invalid: HETZNER_REFUSED + ". Remove it and add a new one",
  not_connected: "Hetzner isn't connected. Connect it first",
  not_configured: SERVERS_UNAVAILABLE,
  machine_kek_unset: SERVERS_UNAVAILABLE,
});
/** The sentence for a refused create, or "" for a 429 (the page shows the countdown). `where` is the location as the person saw it. */
export function createSentence(e, where) {
  if (statusOf(e) === 429) return "";
  const table = CREATE_BY_CODE(where);
  return e && Object.hasOwn(table, e.code) ? table[e.code] : statusOf(e) === 403 ? ONLY_ADMINS_CREATE : "That server couldn't be created. Try again.";
}

// Money is a decimal string from Hetzner. It is added in whole millionths, never as a float, and drawn exactly, with two to six decimals.
const MONEY = /^[0-9]{1,6}(\.[0-9]{1,6})?$/;
const millionths = (s) => {
  const [i, f = ""] = s.split(".");
  return BigInt(i) * 1000000n + BigInt(f.padEnd(6, "0"));
};
export function moneyText(currency, ...amounts) {
  const total = amounts.reduce((n, a) => n + millionths(a), 0n);
  const frac = String(total % 1000000n).padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return (currency === "EUR" ? "€" : currency + " ") + String(total / 1000000n) + "." + frac;
}
/** The live quote's prices, or null when the answer is not a price for exactly this size and place. */
export function readQuote(b, type, location) {
  const p = b && typeof b === "object" ? [b.hourly_gross, b.monthly_gross, b.ipv4_monthly_gross] : [];
  if (!b || b.server_type !== type || b.location !== location || typeof b.currency !== "string" || !/^[A-Z]{3}$/.test(b.currency) || !p.every((v) => typeof v === "string" && MONEY.test(v))) return null;
  return { available: b.available === true, price: { currency: b.currency, hourly_gross: p[0], monthly_gross: p[1], ipv4_monthly_gross: p[2] } };
}
export const priceLine = (p) => moneyText(p.currency, p.monthly_gross) + " a month for the server and " + moneyText(p.currency, p.ipv4_monthly_gross) + " a month for its IPv4";
/** What the Create button shows: the server and its IPv4, added. */
export const totalText = (p) => moneyText(p.currency, p.monthly_gross, p.ipv4_monthly_gross) + " a month";

/** The credential read: connected, invalid or none, with the last four characters of the token. */
export function readCredential(b) {
  if (!b || !["connected", "invalid", "none"].includes(b.status)) return null;
  return { status: b.status, hint: typeof b.token_hint === "string" ? b.token_hint.slice(-4) : "" };
}
export const connectedText = (c) => "Connected" + (c.hint ? " (token …" + c.hint + ")" : "");
export const unlabelledText = (n) => "This Hetzner project has " + n + (n === 1 ? " server" : " servers") + " we didn't create. We never change them.";

/** One server of the list, or null. Its status is words, never the stored word. */
export function readServer(s) {
  if (!s || typeof s !== "object" || typeof s.id !== "string" || s.id === "") return null;
  const str = (v) => (typeof v === "string" ? v : "");
  return { id: s.id, name: str(s.name).trim() || "Unnamed server", status: Object.hasOwn(SERVER_WORDS, s.status) ? SERVER_WORDS[s.status] : "Status not reported", size: str(s.server_type), location: str(s.location), created: str(s.created_at) };
}
export const readServers = (b) => (b && Array.isArray(b.servers) ? b.servers.map(readServer).filter(Boolean) : null);

/** The catalog: the locations, every type with where it is offered, and the cloud's own Small and Medium picks for the location asked for. */
export function readCatalog(b) {
  if (!b || !Array.isArray(b.locations) || !Array.isArray(b.server_types)) return null;
  const word = (v) => (typeof v === "string" ? v : "");
  const locations = b.locations.filter((l) => l && word(l.name)).map((l) => ({ name: l.name, label: [word(l.city) || l.name, word(l.country)].filter(Boolean).join(", ") + " (" + l.name + ")" }));
  const types = b.server_types
    .filter((t) => t && word(t.name) && Number.isFinite(t.cores) && Number.isFinite(t.memory_gb) && Number.isFinite(t.disk_gb) && Array.isArray(t.locations))
    .map((t) => ({
      name: t.name, label: word(t.description) || t.name, cores: t.cores, memory: t.memory_gb, disk: t.disk_gb, arch: t.architecture === "arm" ? "Arm" : t.architecture === "x86" ? "x86" : "",
      at: t.locations.filter((x) => x && word(x.location)).map((x) => ({ location: x.location, available: x.available === true })),
    }))
    .sort((a, z) => a.cores - z.cores || a.memory - z.memory || a.name.localeCompare(z.name));
  const pick = (n) => (typeof n === "string" && n ? n : null);
  return { locations, types, presets: { small: pick(b.presets && b.presets.small), medium: pick(b.presets && b.presets.medium) } };
}
export const offeredIn = (t, location) => t.at.some((x) => x.location === location);
export const availableIn = (t, location) => t.at.some((x) => x.location === location && x.available);
export const specsText = (t) => t.cores + " vCPU, " + t.memory + " GB memory, " + t.disk + " GB disk" + (t.arch ? ", " + t.arch : "");

/** The credential and the server list: two reads that keep their last good answer, and the connect and remove actions. */
export function createServers({ call = api, signal, onChange = () => {} } = {}) {
  let cred = { status: "loading", value: null, unlabelled: null };
  let list = { status: "loading", items: [] };
  let busy = false;
  let wait = 0;
  const gens = { c: 0, l: 0 };
  const gate = createRetryGate({ onChange: (n) => ((wait = n), onChange()) });
  async function loadCredential() {
    const mine = ++gens.c;
    try {
      const v = readCredential(await call("GET", CREDENTIAL_URL, undefined, signal));
      if (mine !== gens.c) return;
      cred = v ? { ...cred, status: "ready", value: v } : { ...cred, status: cred.status === "ready" ? "ready" : "error" };
    } catch (e) {
      if (mine !== gens.c || cancelled(e)) return;
      cred = statusOf(e) === 403 ? { status: "forbidden", value: null, unlabelled: null } : cred.status === "ready" ? cred : { ...cred, status: "error" };
    }
    onChange();
  }
  async function loadList() {
    const mine = ++gens.l;
    try {
      const items = readServers(await call("GET", SERVERS_URL, undefined, signal));
      if (mine !== gens.l) return;
      list = items ? { status: "ready", items } : { status: list.status === "ready" ? "ready" : "error", items: list.items };
    } catch (e) {
      if (mine !== gens.l || cancelled(e)) return;
      if (statusOf(e) === 403) list = { status: "forbidden", items: [] };
      else if (list.status !== "ready") list = { status: "error", items: [] };
    }
    onChange();
  }
  /** Sends the token once. It resolves to "" when saved, else the sentence to show. Nothing about the token is kept. */
  async function connect(token) {
    if (busy || wait > 0) return "";
    busy = true;
    const before = cred;
    cred = { ...cred, status: "checking" };
    onChange();
    let said = "";
    try {
      const b = await call("POST", CREDENTIAL_URL, { token }, signal);
      const n = b && Number.isInteger(b.unlabelled_server_count) && b.unlabelled_server_count > 0 ? b.unlabelled_server_count : null;
      cred = { status: "ready", value: { status: b && b.status === "ok" ? "connected" : "invalid", hint: String((b && b.token_hint) || "").slice(-4) }, unlabelled: n };
    } catch (e) {
      said = cancelled(e) ? "" : connectSentence(e);
      cred = before;
      if (statusOf(e) === 429) gate.start(waitSeconds(e));
    }
    busy = false;
    onChange();
    if (said) await loadCredential(); // the stored state may be what the refusal says (a token already there)
    return said;
  }
  /** Removes our copy of the token. Its servers stay. A token already gone counts as removed. */
  async function remove() {
    if (busy) return "";
    busy = true;
    let said = "";
    try {
      await call("DELETE", CREDENTIAL_URL, undefined, signal);
    } catch (e) {
      if (!cancelled(e) && !(statusOf(e) === 404 && e.code === "not_connected")) said = removeSentence(e);
    }
    busy = false;
    if (!said) cred = { status: "ready", value: { status: "none", hint: "" }, unlabelled: null };
    onChange();
    await loadList();
    return said;
  }
  return { loadCredential, loadList, connect, remove, stop: () => gate.cancel(), get cred() { return cred; }, get list() { return list; }, get wait() { return wait; } };
}

/** The one sentence for a create whose outcome nobody knows: the cloud may have made the server. The same words follow a reused key. */
export const UNKNOWN_OUTCOME = "We couldn't tell whether your last server was made. Check the list below before trying again.";
/** After an unknown outcome, answers that never reached the create (rate limit, session, anything in front of it) keep the key; these are their sentences. */
export const TOO_MANY_TRIES = "Too many tries, wait a moment, then press Create again.";
export const SIGN_IN_AGAIN = "Your session has ended. Sign in again, then press Create again.";
export const SERVER_BEING_CREATED = "A server is already being created for this account. Check the list below.";
/**
 * The answers that say nothing was made, and so end an attempt: the server's own clean refusals (its REFUSED set, as `hetzner_<code>` on the wire; a test pins the two lists
 * together) and the refusals the create handler writes before any Hetzner call. Everything else keeps the key and the lock: a 5xx, `hetzner_locked`, `hetzner_rate_limit_exceeded`,
 * any other `hetzner_*`, `server_outcome_unknown`, a code nobody here knows. An allowlist, never a denylist: a code added later is unknown until it is listed.
 */
export const CLEAN_REFUSALS = new Set([
  "hetzner_unauthorized", "hetzner_forbidden", "hetzner_resource_limit_exceeded", "hetzner_resource_unavailable", "hetzner_placement_error", "hetzner_invalid_input", "hetzner_uniqueness_error", "hetzner_not_found",
  "price_changed", "price_unavailable", "credential_invalid", "not_connected", "not_configured", "machine_kek_unset",
]);

/**
 * The create dialog's state, null while it is closed. One read of the live catalog, one of the live quote for the size and place chosen, and the create.
 * The newest read wins, so a slow answer for an earlier choice is dropped. The button is live only for an available size with a quote in hand. A refused price
 * leaves the dialog open with the new quote and nothing created, so the next press is the second click.
 *
 * One attempt is one Idempotency-Key and one body. It lives until the cloud gives a definite answer: made (201), or a refusal that says nothing was made. While
 * its outcome is unknown (offline, timeout, 5xx, 409 idempotency_in_progress or 409 server_creating) the dialog is locked to that size, place and price, a press sends the same key and
 * body again, and the attempt survives Cancel and reopening. Only a 201 or a clean refusal (CLEAN_REFUSALS) ends an attempt, on the first press as on any later one:
 * a 429, a 401 or a 403 from in front of the create, `hetzner_locked`, `server_outcome_unknown`, or any other answer, keeps the key and the lock. A 422 idempotency_key_reused never gets a new key silently: the person chooses "Create a new one".
 * Each answer carries the generation of the dialog that sent it, so a late answer never changes or closes a newer dialog (the caller refreshes the list instead).
 */
export function createCreator({ call = api, signal, onChange = () => {}, uuid = () => crypto.randomUUID() } = {}) {
  let st = null;
  let seq = 0;
  let gen = 0; // one per open and per close: which dialog a create answer belongs to
  let attempt = null; // { key, body, where, inflight, unknown, reused, everUnknown, note }
  const gate = createRetryGate({ onChange: (n) => { if (st) st = { ...st, wait: n }; onChange(); } });
  const set = (patch) => {
    st = { ...st, ...patch };
    onChange();
  };
  const noCatalog = (status) => ({ status, locations: [], types: [], presets: { small: null, medium: null } });
  const chooseType = (c, location, current) => {
    const ok = (n) => (n ? c.types.find((t) => t.name === n && availableIn(t, location)) : undefined);
    return (ok(current) || ok(c.presets.small) || ok(c.presets.medium) || { name: "" }).name;
  };
  async function quote() {
    const my = ++seq;
    const { type, location } = st;
    set({ quote: { status: "loading" } });
    let q = null;
    try {
      q = readQuote(await call("GET", quoteUrl(type, location), undefined, signal), type, location);
    } catch (e) {
      if (cancelled(e)) return;
    }
    if (my === seq && st) set({ quote: q ? { status: "ready", ...q } : { status: "error" } });
  }
  async function pick(location) {
    const my = ++seq;
    const current = st.type;
    set({ location, type: "", error: "", quote: { status: "idle" }, catalog: { ...st.catalog, status: "loading" } });
    let c = null;
    try {
      c = readCatalog(await call("GET", catalogUrl(location), undefined, signal));
    } catch (e) {
      if (cancelled(e)) return;
    }
    if (my !== seq || !st) return;
    if (!c) return set({ catalog: { ...st.catalog, status: "error" } });
    // A locked dialog shows the size, place and price that were sent, whatever the catalog says now.
    if (attempt) return set({ catalog: { ...c, status: "ready" }, type: attempt.body.server_type, quote: { status: "ready", available: true, price: attempt.body.quoted } });
    set({ catalog: { ...c, status: "ready" }, type: chooseType(c, location, current) });
    if (st.type) await quote();
  }
  /** The first read names the locations; the second, for the first of them (or the locked one), names Small and Medium there. */
  async function start() {
    const my = ++seq;
    set({ catalog: noCatalog("loading") });
    let c = null;
    try {
      c = readCatalog(await call("GET", catalogUrl(), undefined, signal));
    } catch (e) {
      if (cancelled(e)) return;
    }
    if (my !== seq || !st) return;
    if (!c || c.locations.length === 0) return set({ catalog: noCatalog("error") });
    set({ catalog: { ...c, status: "loading" } });
    await pick(attempt ? attempt.body.location : c.locations[0].name);
  }
  function open() {
    seq++;
    gen++;
    gate.cancel();
    st = { catalog: noCatalog("loading"), location: attempt ? attempt.body.location : "", type: "", all: false, quote: { status: "idle" }, error: "", wait: 0 };
    onChange();
    return start();
  }
  function close() {
    seq++;
    gen++;
    gate.cancel();
    st = null; // an attempt stays: its key is kept until the cloud answers for certain
  }
  /**
   * Sends the create. It resolves to { ok, code, unknown, stale }: the closed code of the refusal ("" when there was none), whether the outcome is unknown (the
   * list should be read again), and whether the dialog that sent it has gone (then nothing here was changed in the dialog now open).
   */
  async function submit() {
    const s = st;
    if (!s || s.wait > 0 || (attempt && (attempt.inflight || attempt.reused))) return { ok: false, code: "", unknown: false, stale: false };
    if (!attempt) {
      if (s.quote.status !== "ready" || !s.quote.available || !s.type) return { ok: false, code: "", unknown: false, stale: false };
      const where = (s.catalog.locations.find((l) => l.name === s.location) || { label: s.location }).label;
      attempt = { key: uuid(), body: { server_type: s.type, location: s.location, quoted: s.quote.price }, where, inflight: false, unknown: false, reused: false, everUnknown: false, note: "" };
    }
    const mine = attempt;
    const sentIn = gen;
    mine.inflight = true;
    mine.unknown = false;
    st = { ...st, error: "" };
    onChange();
    let failure = null;
    try {
      await call("POST", SERVERS_URL, mine.body, signal, { idempotencyKey: mine.key });
    } catch (e) {
      failure = e || {};
    }
    const stale = sentIn !== gen;
    if (failure === null) {
      if (attempt === mine) attempt = null;
      // A dialog reopened while this was in the air is locked to this attempt, which is now made: it closes (the caller shows the notice) and never offers Create again.
      if (stale && st) close();
      onChange();
      return { ok: true, code: "", unknown: false, stale };
    }
    if (cancelled(failure) && signal && signal.aborted) return { ok: false, code: "", unknown: false, stale: true }; // the page itself is gone
    // An abort the page did not ask for is the write deadline: the cloud may still be working.
    const code = failure.code || "";
    const status = statusOf(failure);
    mine.inflight = false;
    if (code === "idempotency_key_reused") mine.reused = true;
    else if (status === 0 || status >= 500 || code === "idempotency_in_progress" || code === "server_creating") mine.unknown = mine.everUnknown = true;
    else if (!CLEAN_REFUSALS.has(code)) {
      // Not an answer the create gives when it made nothing: the outcome stays unknown, so the key and the lock stay, on the first press as on any later one.
      mine.unknown = mine.everUnknown = true;
      mine.note = status === 429 ? TOO_MANY_TRIES : status === 401 ? SIGN_IN_AGAIN : status === 403 ? ONLY_ADMINS_CREATE : "";
    } else if (attempt === mine) attempt = null; // the create answered and nothing was made under this key
    if (mine.reused || mine.unknown) {
      if (code === "server_creating") mine.note = SERVER_BEING_CREATED;
      else if (code === "idempotency_in_progress" || status === 0 || status >= 500) mine.note = "";
      if (status === 429 && mine.unknown && !stale) gate.start(waitSeconds(failure));
      onChange();
      return { ok: false, code, unknown: true, stale };
    }
    if (stale) {
      onChange();
      return { ok: false, code, unknown: false, stale: true };
    }
    set({ error: createSentence(failure, mine.where) });
    if (statusOf(failure) === 429) gate.start(waitSeconds(failure));
    else if (["price_changed", "hetzner_resource_unavailable", "hetzner_placement_error"].includes(code)) await quote();
    return { ok: false, code, unknown: false, stale: false };
  }
  /** After a reused key: forget the old attempt on purpose and read the price again, so the next press is a new create with a new key. */
  function startOver() {
    if (!st || !attempt || !attempt.reused) return undefined;
    attempt = null;
    set({ error: "" });
    return st.type ? quote() : undefined;
  }
  const locked = () => attempt !== null;
  return {
    open, close, submit, startOver, requote: () => (st && !locked() ? quote() : undefined),
    retry: () => (st && st.location ? pick(st.location) : start()),
    pick: (location) => (st && !locked() && location !== st.location ? pick(location) : undefined),
    choose: (type) => (st && !locked() && type !== st.type ? (set({ type, error: "" }), quote()) : undefined),
    toggleAll: () => st && set({ all: !st.all }),
    /** The dialog's state, with what the attempt says laid over it: sending, locked to the attempt, and the sentence for an unknown outcome. */
    get state() {
      if (!st) return null;
      const a = attempt;
      return { ...st, sending: !!(a && a.inflight), locked: a !== null, reused: !!(a && a.reused), error: a && (a.unknown || a.reused) ? a.note || UNKNOWN_OUTCOME : st.error };
    },
  };
}
