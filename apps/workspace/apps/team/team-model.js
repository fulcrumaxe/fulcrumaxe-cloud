// The Team app's logic, with no DOM (unit-tested with a fake client). The page is team-app.js and only draws what describe() returns.
//
// Rules this file holds, from the engine-bridge lessons:
//  - A gap is never silent: an envelope that reports missing events puts a banner on the app, and the banner has no way to be dismissed.
//  - Every panel carries its data age ("as of HH:MM (N min ago)"). A stale heartbeat adds "last seen N min ago" and the data stays on screen.
//  - An agent is "running" only while the session is live (the bridge heard from the engine in the last 450 s) and its start is under 3 h old;
//    otherwise it reads "unknown", whatever the server said. Both the bridge session and the engine session count: the list's liveness chip
//    is the bridge's view, heard_age_s is the engine's own last word.
//  - A reply that does not have the documented shape is a failed read, never an empty list (fail closed).
//  - Reads follow notices, not a timer: a notice names the parts that changed (createCoalescer, noticeNames), each part is read at most once in 10 s, a missing or unknown
//    name reads everything, a 120 s safety read covers a notice that never came, and a hidden tab reads nothing. The data age follows the status read's last-heard time with the clock.
//  - The cloud sends facts; this file does no cost, rate or total maths: a dollar figure is drawn as sent, through the one shared formatter, and never added up here.
//    The only arithmetic is ages, counts of rows on screen, and joining consecutive event numbers into ranges.
// Every word that reaches the page is a string made here; nothing is null, undefined or NaN.
import { api, isRateLimited, retryWords, waitSeconds } from "../_lib/api.js";
import { usd as dollars } from "../_lib/dom.js";
import { readFleet } from "../runners/runners-fleet.js";
import { NO_OP, agentWords, createOperate, describeHalt, describeOperate, isAgentId, stopOf } from "./team-operate.js";

// The Team app's one door to the cloud, below: every URL and every request the app makes, written against the engine routes' documented shapes (the per-repo list envelope, the
// settings read, the settings write, the command channel and the decision dials). The model and the page never build a path of their own. It lives in this file so the app stays
// inside the boot budget's per-app file ceiling.
export const REPOS_URL = "/api/v1/engine/repos";
export const SETTINGS_URL = "/api/v1/engine/settings";
export const RUNNERS_URL = "/api/runners";
export const DELETE_URL = "/api/v1/engine/settings/delete-data";
/** The per-repo panels this app reads. Gates are read without a PR so one call covers every PR in a lane. */
export const PANELS = ["agents", "lanes", "gates", "log", "plan", "stats", "usage"];
export const LOG_LIMIT = 100;
const PANEL_PATH = { agents: "/agents?state=running", lanes: "/lanes", gates: "/gates", log: "/log?limit=" + LOG_LIMIT, plan: "/plan", stats: "/stats", usage: "/usage" };
const enc = (v) => encodeURIComponent(String(v));
export const panelUrl = (kind, repoId) => REPOS_URL + "/" + enc(repoId) + PANEL_PATH[kind];
export const logUrl = (repoId, cursor) => panelUrl("log", repoId) + "&cursor=" + enc(cursor);
export const lanesUrl = (repoId, cursor) => panelUrl("lanes", repoId) + "?cursor=" + enc(cursor);
export const commandsUrl = (repoId) => REPOS_URL + "/" + enc(repoId) + "/commands";
export const commandUrl = (id) => "/api/v1/engine/commands/" + enc(id);
export const bridgeUrl = (repoId) => REPOS_URL + "/" + enc(repoId) + "/bridge";
export const haltUrl = (repoId) => REPOS_URL + "/" + enc(repoId) + "/halt";
export const clearHaltUrl = (repoId) => haltUrl(repoId) + "/clear";
export const dialsUrl = (repoId) => "/api/v1/repos/" + enc(repoId) + "/decision-settings";
export const dialUrl = (repoId) => dialsUrl(repoId) + "/dial";

/** `call(method, path, body, signal)` is api() in the page; a test passes a fake with the same shape. */
export function createTeamApi(call = api) {
  return {
    repos: (signal) => call("GET", REPOS_URL, undefined, signal),
    runners: (signal) => call("GET", RUNNERS_URL, undefined, signal),
    settings: (signal) => call("GET", SETTINGS_URL, undefined, signal),
    panel: (kind, repoId, signal) => call("GET", panelUrl(kind, repoId), undefined, signal),
    older: (repoId, cursor, signal) => call("GET", logUrl(repoId, cursor), undefined, signal),
    lanesPage: (repoId, cursor, signal) => call("GET", lanesUrl(repoId, cursor), undefined, signal),
    saveSettings: (body, signal) => call("PUT", SETTINGS_URL, body, signal),
    deleteData: (signal) => call("PUT", DELETE_URL, undefined, signal),
    commands: (repoId, signal) => call("GET", commandsUrl(repoId) + "?limit=50", undefined, signal),
    issue: (repoId, kind, args, signal) => call("POST", commandsUrl(repoId), { kind, args }, signal),
    cancel: (id, signal) => call("DELETE", commandUrl(id), undefined, signal),
    bridge: (repoId, signal) => call("GET", bridgeUrl(repoId), undefined, signal),
    connectBridge: (repoId, body, signal) => call("POST", bridgeUrl(repoId), body, signal),
    disconnectBridge: (repoId, signal) => call("DELETE", bridgeUrl(repoId), undefined, signal),
    halt: (repoId, signal) => call("POST", haltUrl(repoId), {}, signal),
    clearHalt: (repoId, signal) => call("POST", clearHaltUrl(repoId), {}, signal),
    dials: (repoId, signal) => call("GET", dialsUrl(repoId), undefined, signal),
    setDial: (repoId, type, disposition, signal) => call("POST", dialUrl(repoId), { decision_type: type, disposition }, signal),
  };
}

export const LIVE_EVENT = "engine.changed";
/** A notice settles for this long before its panels are read (the server has already waited its own second). */
export const DEBOUNCE_MS = 1000;
/** A panel is read again at most once in this long, however many notices name it; the names that arrive inside the window are read together. */
export const PANEL_GATE_MS = 10000;
/** The safety read: every part is read this often while the tab is visible, whatever has or has not arrived. */
export const SAFETY_MS = 120000;
/** The closed set of names a notice may carry (`data.panels`). `asks` is a name the Team app has no reader for. */
export const NOTICE_PANELS = ["agents", "lanes", "gates", "asks", "log", "plan", "stats", "usage", "status"];
/** What this app can read: the seven panels, the status (settings, repos, halt) and the operate half (commands and dials). */
export const READ_NAMES = [...PANELS, "status", "operate"];
/**
 * A repo is stale when it was last heard from longer ago than this. An idle bridge sends only a slim "alive" status every HEARTBEAT_MS (300 s,
 * packages/fx-runner/src/engineBridge/loop.ts), so the threshold is 1.5 of those intervals: a live, idle engine is never marked stale between two of them.
 */
export const STALE_HEARD_S = 450;
/** While a command is waiting for the machine, its answer is read this often (the runner's report raises no notice). */
export const OP_POLL_MS = 10000;
export const RETRY_MS = 10000;
export const UNKNOWN_AFTER_MS = 3 * 3600 * 1000;
export const SOURCE_ORDER = ["loop", "team_log", "plan", "merge_queue"];
export const SOURCE_LIMIT_S = { loop: 3600, team_log: 7200, plan: 26 * 3600, merge_queue: 6 * 3600 };
const SOURCE_NAME = { loop: "loop", team_log: "team log", plan: "plan", merge_queue: "merge queue" };
export const FINAL_LANE_STATES = ["merged", "failed", "dequeued", "refused"];
export const LOG_WINDOW = 400; // log rows held (and drawn) at any time; older pages push the newest out
export const ROADMAP_PAGE = 100;
export const PLAN_STALE_S = 26 * 3600;
export const LANE_PAGES = 5; // the merged count reads this many lane pages at most
export const MERGED_WINDOW_MS = 30 * 24 * 3600 * 1000;

export const WORDS = {
  title: "Team",
  loading: "Loading…",
  error: "The Team app isn't available right now.",
  watchOff: "Engine watch is off",
  noRepos: "No repositories are enabled for engine watch.",
  noReposOn: "Choose a repository in Settings to start watching.", openSettings: "Open Settings",
  noAgents: "No agents running",
  noLanes: "No pull requests in the merge lane",
  panelFailed: "This panel couldn't be read.",
  refreshFailed: "Couldn't refresh. Showing the last data received.",
  noData: "no data yet",
  mergedToday: "Merged today",
  settings: "Settings",
  watchAny: "Watch the engine team on your runner", // the switch before the runner words (team-runners.js, loaded by import()) have arrived; the same words as RUNNER_WORDS.watchAny
  connecting: "Connecting to ",
  connectingTail: "… waiting for it to report in.",
  readOnly: "Only an owner or admin can change these settings.",
  repos: "Repositories",
  noSettingsRepos: "No repositories are connected.",
  deleteData: "Delete engine data",
  deleteAsk: "Delete every engine record for this account? This cannot be undone.",
  deleteYes: "Yes, delete",
  cancel: "Cancel",
  newWindow: " (opens in a new window)",
  chipContext: "Engine connection: ",
  saved: "Saved.",
  deleted: "Engine data deleted.",
  forbidden: "Only an owner or admin can change this.",
  deleteForbidden: "Only the account owner can delete engine data.",
  saveFailed: "That didn't save. Try again.",
  refusals: { repo_not_runner_local: "Not on one of your runners", public_repo: "Public repository" },
  refusalOther: "Not available",
  noLog: "No log lines yet", logNote: "Log text stays on your machine; the cloud receives only what kind of line it was.", logLabel: "Log lines",
  older: "Load older", olderLoading: "Loading older lines…", olderNone: "No older lines", olderFailed: "Older lines couldn't be loaded.", newest: "Back to newest",
  noPlan: "Plan not synced yet", noPlanItems: "No items in this plan", noKey: "(no key)", roadmap: "Roadmap", prev: "Previous rows", next: "Next rows", noFigures: "no figures yet",
  mergedWindow: "merged in the last 30 days",
  noFigure: "no figure", noUsage: "No usage reported yet", usageMore: "More rows exist than are shown.", usageWindow: "Window: ",
  allUsage: "API-equivalent for the window",
  sendRefusals: { repo_not_runner_local: "That repository isn't on one of your runners.", public_repo: "A public repository can't be watched." },
};

const LANE_STATE = { queued: "Queued", testing: "Testing", merged: "Merged", failed: "Failed", dequeued: "Removed from the queue", refused: "Refused" };
const GATE_NAME = { gate1: "Gate 1", code_review: "Code review", security_review: "Security review", acceptance: "Acceptance", browser: "Browser", ci_full: "CI full" };
const RESULT = { pass: "pass", fail: "fail", error: "error", skipped: "skipped" };
// A plan item has its own states (the plan route's enum); the roadmap's STATUS words below are a different list.
const ITEM_STATE = { planned: "Planned", in_progress: "In progress", pr_open: "Pull request open", merged: "Merged", blocked: "Blocked", dropped: "Dropped" };
const USAGE_STATE = { recorded: "Recorded", not_priced: "No API price for this model", not_recorded: "Usage was not recorded" };
const CREDENTIAL = { subscription: "your Claude plan", api_key: "your API key" };
const STATUS = { not_started: "Not started", in_progress: "In progress", done: "Done", blocked: "Blocked", deferred: "Deferred", split: "Split", removed: "Removed", superseded: "Superseded" };
const CHIP = { live: "Live", runner_removed: "Runner removed", never: "Never connected" };

// ── small readers ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isInt = (v) => Number.isInteger(v) && v >= 0;
const stamp = (v) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);
const pad = (n) => String(n).padStart(2, "0");
/** HH:MM in the person's own time, or "" for a value that is not a time. */
export function hm(iso) {
  const t = stamp(iso);
  if (t === null) return "";
  const d = new Date(t);
  return pad(d.getHours()) + ":" + pad(d.getMinutes());
}
const minutesSince = (iso, nowMs) => {
  const t = stamp(iso);
  return t === null ? null : Math.max(0, Math.floor((nowMs - t) / 60000));
};
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
/** A link to a Discussion or pull request of the repo, built from the repo's own name; null when either part is not usable. */
export function githubLink(fullName, kind, n) {
  return typeof fullName === "string" && REPO_NAME.test(fullName) && !fullName.split("/").some((p) => p === "." || p === "..") && (kind === "discussions" || kind === "pull") && Number.isInteger(n) && n >= 1 ? "https://github.com/" + fullName + "/" + kind + "/" + n : null;
}

/** The per-repo list envelope. Missing the list, the gap list or the missing count is a failed read: a gap must never be hidden by a default. */
export function readEnvelope(raw, listed = true) {
  if (!isObj(raw) || (listed && !Array.isArray(raw.items)) || !Array.isArray(raw.gaps) || !isInt(raw.missing_events)) return null;
  const ages = {};
  if (isObj(raw.source_ages_s)) for (const k of SOURCE_ORDER) if (Number.isFinite(raw.source_ages_s[k]) && raw.source_ages_s[k] >= 0) ages[k] = raw.source_ages_s[k];
  const gaps = raw.gaps.filter((g) => isObj(g) && stamp(g.before_ts) !== null).map((g) => ({ before_ts: g.before_ts }));
  return { items: listed ? raw.items.filter(isObj) : [], cursor: typeof raw.next_cursor === "string" ? raw.next_cursor : "", as_of: stamp(raw.as_of) === null ? "" : raw.as_of, heard_age_s: isInt(raw.heard_age_s) ? raw.heard_age_s : null, source_ages_s: ages, gaps, missing_events: raw.missing_events };
}

/** The plan route's body (a 204 never gets here: the caller treats null as "not synced"). The roadmap list is part of the shape. */
export function readPlan(raw) {
  const env = readEnvelope(raw);
  if (!env || !Array.isArray(raw.roadmap)) return null;
  return { ...env, date: typeof raw.plan_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.plan_date) ? raw.plan_date : "", age_s: isInt(raw.age_s) ? raw.age_s : null, roadmap: raw.roadmap.filter(isObj) };
}
/** The stats route's body: the envelope fields plus figures, each kept exactly as sent with the count of events behind it. */
export function readStats(raw) {
  const env = readEnvelope(raw, false);
  if (!env) return null;
  const events = (o) => (isObj(o) && isObj(o.provenance) && isInt(o.provenance.count) ? { count: o.provenance.count, kinds: (Array.isArray(o.provenance.kinds) ? o.provenance.kinds : []).filter((k) => typeof k === "string" && k !== "").map(word), seqs: seqRanges(o.provenance.seqs) } : null);
  const num = (v) => (Number.isFinite(v) ? String(v) : "");
  const roles = isObj(raw.agents_by_role) && isObj(raw.agents_by_role.value) ? Object.entries(raw.agents_by_role.value).filter(([, n]) => isInt(n)) : null;
  const dur = raw.duration_s, gate = raw.gate_pass_rate;
  return {
    ...env, from: isObj(raw.window) && stamp(raw.window.from) !== null ? raw.window.from.slice(0, 10) : "", to: isObj(raw.window) && stamp(raw.window.to) !== null ? raw.window.to.slice(0, 10) : "",
    roles, rolesEvents: events(raw.agents_by_role), dur: isObj(dur) ? { n: isInt(dur.n) ? String(dur.n) : "", median: num(dur.median), p90: num(dur.p90) } : null, durEvents: events(dur),
    merges: isObj(raw.merges) && isInt(raw.merges.value) ? String(raw.merges.value) : "", mergeEvents: events(raw.merges),
    gates: isObj(gate) && isInt(gate.numerator) && isInt(gate.denominator) ? { passed: String(gate.numerator), of: String(gate.denominator) } : null, gateEvents: events(gate),
  };
}

/**
 * The parts a notice asks for. Only a non-empty list made of names from the closed set narrows the read; a missing, empty, mistyped or unknown entry
 * means everything (a forged or future notice costs one more read, never a stale screen). `asks` has no reader in this app, so it names nothing here.
 */
export function noticeNames(data) {
  const p = isObj(data) ? data.panels : undefined;
  if (!Array.isArray(p) || p.length === 0 || p.some((n) => typeof n !== "string" || !NOTICE_PANELS.includes(n))) return READ_NAMES.slice();
  return [...new Set(p)].filter((n) => READ_NAMES.includes(n));
}

/**
 * Decides when a part may be read again. `note(names)` says a part has changed; `run(names)` is called with every part that is due, together. A part
 * is due `settleMs` after it was first named, and never less than `gateMs` after its own last read, so any number of notices make at most one read of a
 * part in each window, and the names that arrive inside the window are read in the one call at its end. `mark(names)` records a read made some other
 * way (a full read) and drops those parts from the queue, because that read covered them.
 */
export function createCoalescer({ run, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, settleMs = DEBOUNCE_MS, gateMs = PANEL_GATE_MS } = {}) {
  const last = new Map();
  const ready = new Map(); // name -> the time it may be read
  let timer = null, timerAt = Infinity;
  function arm() {
    const next = ready.size ? Math.min(...ready.values()) : Infinity;
    if (next === timerAt && timer !== null) return;
    if (timer !== null) clearTimer(timer);
    timer = null;
    timerAt = next;
    if (next !== Infinity) timer = setTimer(fire, Math.max(0, next - now()));
  }
  function fire() {
    timer = null;
    timerAt = Infinity;
    const t = now();
    const due = [...ready].filter(([, at]) => at <= t).map(([n]) => n);
    for (const n of due) { ready.delete(n); last.set(n, t); }
    arm();
    if (due.length) run(due);
  }
  return {
    note(names) {
      const t = now();
      for (const n of names) if (!ready.has(n)) ready.set(n, Math.max(t + settleMs, last.has(n) ? last.get(n) + gateMs : 0));
      arm();
    },
    mark(names) {
      const t = now();
      for (const n of names) { last.set(n, t); ready.delete(n); }
      arm();
    },
    cancel() { ready.clear(); arm(); },
    pending: () => [...ready.keys()],
  };
}

const idKey = (v) => (typeof v === "string" || Number.isInteger(v) ? String(v) : "");
export function readRepos(raw) {
  const list = Array.isArray(raw) ? raw : isObj(raw) && Array.isArray(raw.items) ? raw.items : null;
  if (!list) return null;
  return list.filter((r) => isObj(r) && idKey(r.repo_id) !== "" && typeof r.full_name === "string" && r.full_name !== "").map((r) => ({
    id: idKey(r.repo_id), name: r.full_name, runner: typeof r.runner_name === "string" ? r.runner_name : "", liveness: typeof r.liveness === "string" ? r.liveness : "never",
    lastHeard: typeof r.last_heard_at === "string" ? r.last_heard_at : "", operate: r.operate_enabled === true, halted: r.halted === true, haltPending: r.halt_pending === true,
    haltedAt: typeof r.halted_at === "string" ? r.halted_at : "", haltedBy: isObj(r.halted_by) && typeof r.halted_by.display_name === "string" && r.halted_by.display_name !== "" ? r.halted_by.display_name : "",
  }));
}
export function readSettings(raw) {
  if (!isObj(raw) || typeof raw.watch_enabled !== "boolean" || typeof raw.can_edit !== "boolean" || !Array.isArray(raw.repos)) return null;
  const repos = raw.repos.filter((r) => isObj(r) && idKey(r.repo_id) !== "" && typeof r.full_name === "string" && r.full_name !== "").map((r) => ({
    sendId: r.repo_id, id: idKey(r.repo_id), name: r.full_name, enabled: r.enabled === true, eligible: r.eligible === true, runnerId: typeof r.bridged_runner_id === "string" ? r.bridged_runner_id : "", refusal: typeof r.refusal === "string" ? r.refusal : r.eligible === true ? "" : "other",
  }));
  return { watch: raw.watch_enabled, operate: raw.operate_enabled === true, canEdit: raw.can_edit, repos };
}

// ── what the page draws ─────────────────────────────────────────────────────────────────────────────────────────────────────
export function chipOf(repo) {
  if (repo.liveness === "stale") return repo.lastHeard && hm(repo.lastHeard) ? "Stale since " + hm(repo.lastHeard) : "Stale";
  return CHIP[repo.liveness] || "Unknown";
}
/** "as of HH:MM (N min ago)" from the envelope's own time. */
export function asOfWords(env, nowMs) {
  const m = env ? minutesSince(env.as_of, nowMs) : null;
  return m === null ? WORDS.noData : "as of " + hm(env.as_of) + " (" + m + " min ago)";
}
/** The envelope says the engine has not been heard from within 450 s (or ever), or the list says the session is not live. */
/** The list's own word (the status read) ages with the clock: a repo last heard long ago reads stale even when no panel has been read since. */
const unheardS = (repo, nowMs) => { const at = stamp(repo.lastHeard); return Number.isFinite(nowMs) && at !== null ? Math.max(0, Math.floor((nowMs - at) / 1000)) : null; };
export const isStale = (repo, env, nowMs) => repo.liveness !== "live" || !env || env.heard_age_s === null || env.heard_age_s > STALE_HEARD_S || (unheardS(repo, nowMs) ?? 0) > STALE_HEARD_S;
const lastSeenWords = (env, repo, nowMs) => (!env || env.heard_age_s === null ? "last seen: never" : "last seen " + Math.floor(Math.max(env.heard_age_s, repo ? unheardS(repo, nowMs) ?? 0 : 0) / 60) + " min ago");

/** One agent row. `live` is false when the session is stale; `running` is then never shown, nor after 3 h without a stop. */
export function agentRow(a, live, nowMs, repoName) {
  const started = stamp(a.started_at);
  const since = hm(a.started_at);
  const claimed = a.state === "stopped" ? "stopped" : a.state === "running" ? "running" : "unknown";
  const state = claimed === "running" && (!live || started === null || nowMs - started >= UNKNOWN_AFTER_MS) ? "unknown" : claimed;
  const role = typeof a.role === "string" && a.role !== "" ? a.role : "other";
  return {
    id: idKey(a.agent_id) || role + since, stopId: isAgentId(a.agent_id) ? a.agent_id : "", role, state, since, discussion: Number.isInteger(a.discussion) && a.discussion >= 1 ? a.discussion : 0,
    link: githubLink(repoName, "discussions", a.discussion), mode: a.background === true ? "background" : "foreground",
    text: state === "unknown" ? "unknown: started " + (since || "at an unknown time") + ", no stop seen" : "since " + since,
  };
}

/** Lanes with their gate chips (gates grouped by PR on this side), and the PRs that merged today set apart. */
export function laneRows(lanes, gates, nowMs, repoName) {
  const byPr = new Map();
  for (const g of gates ? gates.items : []) {
    if (!Number.isInteger(g.pr)) continue;
    if (!byPr.has(g.pr)) byPr.set(g.pr, []);
    byPr.get(g.pr).push({ gate: GATE_NAME[g.gate] || "Other gate", result: RESULT[g.result] || "unknown" });
  }
  const today = new Date(nowMs).toDateString();
  const rows = [];
  for (const l of lanes ? lanes.items : []) {
    if (!Number.isInteger(l.pr) || l.pr < 1) continue;
    const merged = l.state === "merged";
    const at = stamp(l.updated_at);
    if (merged && at !== null && new Date(at).toDateString() !== today) continue; // merged on an earlier day: not shown here
    rows.push({ pr: l.pr, merged, state: LANE_STATE[l.state] || "Unknown", discussion: Number.isInteger(l.discussion) && l.discussion >= 1 ? l.discussion : 0, prLink: githubLink(repoName, "pull", l.pr), discussionLink: githubLink(repoName, "discussions", l.discussion), gates: byPr.get(l.pr) || [] });
  }
  rows.sort((a, b) => a.pr - b.pr);
  return { open: rows.filter((r) => !r.merged), merged: rows.filter((r) => r.merged) };
}
const hasOpenLane = (lanes) => !!lanes && lanes.items.some((l) => !FINAL_LANE_STATES.includes(l.state));


/** The event numbers a figure was drawn from, per session: consecutive numbers join into one range ("3–7, 9"); sessions are named by order, never by id. */
function seqRanges(list) {
  const by = new Map();
  for (const s of Array.isArray(list) ? list : []) if (isObj(s) && typeof s.session_id === "string" && isInt(s.seq)) by.set(s.session_id, (by.get(s.session_id) || []).concat(s.seq));
  return [...by.values()].map((q, i) => {
    const out = [];
    for (const n of q.sort((a, b) => a - b)) { const last = out[out.length - 1]; if (last && n <= last[1] + 1) last[1] = Math.max(last[1], n); else out.push([n, n]); }
    return "Session " + (i + 1) + ": seq " + out.map(([a, b]) => (a === b ? String(a) : a + "–" + b)).join(", ");
  });
}
const word = (v) => (typeof v === "string" && /^[a-z][a-z0-9_]{0,31}$/.test(v) ? v.replace(/_/g, " ") : "other");
const numberOf = (v) => (Number.isInteger(v) && v >= 1 ? v : 0);
/** One log line: its time (with the day when it is not today), who, the kind of line, and D# / PR links. The cloud never holds a line's text. */
export function logRow(l, i, repoName, nowMs) {
  const t = stamp(l.ts);
  const d = t === null ? null : new Date(t);
  const day = d && d.toDateString() !== new Date(nowMs).toDateString() ? pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " : "";
  return {
    id: idKey(l.line_id) || "row" + i, time: day + (hm(l.ts) || "unknown time"), role: typeof l.actor_role === "string" && l.actor_role !== "" ? l.actor_role : "other", category: word(l.category),
    discussion: numberOf(l.discussion), discussionLink: githubLink(repoName, "discussions", l.discussion), pr: numberOf(l.pr), prLink: githubLink(repoName, "pull", l.pr),
  };
}
/** Today's plan and the roadmap rows. The merged count is the PRs the lane list shows merged for that row's Discussion in the last 30 days (no lifetime figure exists). */
export function planView(plan, lanes, nowMs, repoName, page) {
  const merged = new Map();
  for (const l of lanes ? lanes.items : []) {
    const at = stamp(l.updated_at);
    if (l.state === "merged" && numberOf(l.discussion) && at !== null && nowMs - at <= MERGED_WINDOW_MS) merged.set(l.discussion, (merged.get(l.discussion) || 0) + 1);
  }
  const pages = Math.max(1, Math.ceil(plan.roadmap.length / ROADMAP_PAGE));
  const at = Math.min(Math.max(0, page), pages - 1);
  const rows = plan.roadmap.slice(at * ROADMAP_PAGE, (at + 1) * ROADMAP_PAGE).map((r) => {
    const d = numberOf(r.discussion);
    const done = d && lanes ? (lanes.cursor ? "at least " : "") + (merged.get(d) || 0) + " " + WORDS.mergedWindow : "";
    const planned = isInt(r.planned_prs) ? r.planned_prs + " planned" : "";
    return { key: typeof r.row_key === "string" && r.row_key !== "" ? r.row_key : WORDS.noKey, discussion: d, link: githubLink(repoName, "discussions", r.discussion), status: Object.hasOwn(STATUS, r.status) ? STATUS[r.status] : "Unknown", counts: [done, planned].filter(Boolean).join(" · ") };
  });
  const items = plan.items.filter((i) => numberOf(i.discussion)).map((i) => ({ discussion: i.discussion, link: githubLink(repoName, "discussions", i.discussion), ordinal: isInt(i.ordinal) ? String(i.ordinal) : "", state: Object.hasOwn(ITEM_STATE, i.state) ? ITEM_STATE[i.state] : "Unknown" }));
  const stale = plan.age_s !== null && plan.age_s > PLAN_STALE_S;
  return {
    title: plan.date ? (stale ? "Plan from " : "Plan for ") + plan.date : stale ? "Plan is out of date" : "", items, rows, empty: WORDS.noPlanItems, hasRows: plan.roadmap.length > 0, hasPrev: at > 0, hasNext: at < pages - 1,
    span: plan.roadmap.length > ROADMAP_PAGE ? "Rows " + (at * ROADMAP_PAGE + 1) + "–" + (at * ROADMAP_PAGE + rows.length) + " of " + plan.roadmap.length : "",
  };
}
/** The figures as the server sent them, each with the number of events behind it (a disclosure listing what the server knows of them); one that did not come reads "no figures yet". */
export function statsView(s, open = []) {
  const from = (n) => (n === null ? "" : " (from " + n.count + (n.count === 1 ? " event)" : " events)"));
  const prov = (n) => (n === null ? null : [n.kinds.length ? "Event kinds: " + n.kinds.join(", ") : "Event kinds: none listed", "Events: " + n.count].concat(n.seqs));
  const rows = [
    ["roles", "Agents by role", s.roles === null ? "" : s.roles.map(([k, n]) => k + " " + n).join(", "), s.rolesEvents],
    ["duration", "Duration", s.dur && s.dur.median !== "" ? "median " + s.dur.median + " s, p90 " + s.dur.p90 + " s" : "", s.durEvents],
    ["merges", "Merges", s.merges, s.mergeEvents],
    ["gates", "Gates passed", s.gates && s.gates.of !== "0" ? s.gates.passed + " of " + s.gates.of : "", s.gateEvents],
  ].map(([id, label, value, n]) => ({ id, label, value: value === "" ? WORDS.noFigures : value, from: value === "" ? "" : from(n), prov: value === "" ? null : prov(n), open: open.includes(id) }));
  return { rows, window: s.from && s.to ? "Window: " + s.from + " to " + s.to : "" };
}

/** The cost route's body: the envelope, the window and the one total the server worked out. A total that is not a number is an unreadable reply, never $0. */
export function readUsage(raw) {
  const env = readEnvelope(raw);
  if (!env || !isObj(raw.totals) || !Number.isFinite(raw.totals.api_equivalent_usd)) return null;
  return { ...env, from: isObj(raw.window) && stamp(raw.window.from) !== null ? raw.window.from.slice(0, 10) : "", to: isObj(raw.window) && stamp(raw.window.to) !== null ? raw.window.to.slice(0, 10) : "", sent: raw.totals.api_equivalent_usd };
}
/** Each figure is drawn as sent; a row without one says why in the server's note or the state's words, and never reads $0. */
export function usageView(u) {
  const rows = u.items.map((i, n) => {
    const model = typeof i.model === "string" && i.model !== "" ? i.model : "unknown model";
    const mode = Object.hasOwn(CREDENTIAL, i.credential_mode) ? " · on " + CREDENTIAL[i.credential_mode] : "";
    const note = typeof i.note === "string" && i.note !== "" ? i.note : "";
    return { id: "u" + n, label: (i.subject_kind === "tick" ? "Tick" : "Agent") + " · " + model + mode, value: Number.isFinite(i.api_equivalent_usd) ? dollars(i.api_equivalent_usd) : note || (Object.hasOwn(USAGE_STATE, i.state) ? USAGE_STATE[i.state] : "") || WORDS.noFigure };
  });
  return { headline: dollars(u.sent), headlineLabel: WORDS.allUsage, rows, empty: WORDS.noUsage, more: u.cursor ? WORDS.usageMore : "", window: u.from && u.to ? WORDS.usageWindow + u.from + " to " + u.to : "" };
}

/** The banner for the worst gap any panel reports, or "" when none. */
export function gapBanner(envs) {
  let worst = null;
  for (const e of envs) if (e && e.missing_events > (worst ? worst.missing_events : 0)) worst = e;
  if (!worst) return "";
  const times = worst.gaps.map((g) => stamp(g.before_ts)).filter((t) => t !== null);
  const since = times.length ? hm(new Date(Math.min(...times)).toISOString()) : "";
  return "Events missing" + (since ? " since " + since : "") + " (" + worst.missing_events + (worst.missing_events === 1 ? " event)" : " events)");
}
/** A source that has not reported within its limit. The merge queue only counts while a pull request in the lane is not final. */
export function sourceNotices(envs, lanes) {
  const out = [];
  for (const src of SOURCE_ORDER) {
    if (src === "merge_queue" && !hasOpenLane(lanes)) continue;
    const ages = envs.filter(Boolean).map((e) => e.source_ages_s[src]).filter((n) => n !== undefined);
    const age = ages.length ? Math.max(...ages) : -1;
    if (age > SOURCE_LIMIT_S[src]) out.push(SOURCE_NAME[src] + " not updated for " + Math.floor(age / 3600) + " h");
  }
  return out;
}

export function failureSentence(e, forbidden = WORDS.forbidden) {
  if (isRateLimited(e)) return retryWords(waitSeconds(e));
  if (e && e.status === 403) return forbidden;
  if (e && e.status === 409 && typeof e.code === "string" && Object.hasOwn(WORDS.sendRefusals, e.code)) return WORDS.sendRefusals[e.code];
  return WORDS.saveFailed;
}

/** The repo the sheet's Connect panel is about: the one chosen on the page, else the first the settings list shows. */
export function bridgeRepo(st) {
  const chosen = st.repos.find((r) => r.id === st.selectedId);
  const list = st.settings ? st.settings.repos.filter((r) => r.enabled || r.eligible) : [];
  const named = chosen ? list.find((r) => r.name === chosen.name) : null;
  return named || list.find((r) => r.enabled) || list[0] || null;
}
const bridgeTarget = (st) => { const r = bridgeRepo(st); return r ? r.name : ""; };

const NO_RUNNER_VIEW = Object.freeze({ words: null, label: WORDS.watchAny, runnerName: "", choices: [], pickedId: "", status: { kind: "unknown", text: "" }, command: "", connect: { failed: false, empty: false, command: "", rows: [] } });

/** Everything the page draws for one moment. */
export function describe(st, nowMs) {
  if (st.status === "loading") return { kind: "loading", text: WORDS.loading };
  if (st.status === "error" || !st.settings) return { kind: "error", text: WORDS.error };
  const sheet = {
    open: st.sheetOpen, canEdit: st.settings.canEdit, watch: st.draft && st.draft.watch !== undefined ? st.draft.watch : st.settings.watch, saving: st.saving, confirmDelete: st.confirmDelete, notice: st.notice, readOnly: st.settings.canEdit ? "" : WORDS.readOnly,
    repos: st.settings.repos.map((r) => ({ id: r.id, name: r.name, checked: st.draft && Object.hasOwn(st.draft.repos, r.id) ? st.draft.repos[r.id] : r.enabled, refused: !r.eligible && !r.enabled, reason: r.eligible || r.enabled ? "" : WORDS.refusals[r.refusal] || WORDS.refusalOther })),
  };
  const repo = st.repos.find((r) => r.id === st.selectedId);
  // The runner words and the connect panel's data live in team-runners.js, fetched by import() only when a screen shows the runners; until it lands the switch says WORDS.watchAny and draws no runner lines.
  const reported = st.bridge && st.bridge.data && st.bridge.data.connected ? st.bridge.data.connected.root : "";
  const rv = st.runnersMod ? st.runnersMod.runnerView({ settings: st.settings, fleet: st.fleet, repoName: repo ? repo.name : "", pickId: st.runnerPick, nowMs, root: reported }) : NO_RUNNER_VIEW;
  // Asked for, not yet answered: the switch was just turned on (the save is out), or it is on and the runner has never reported in.
  const connecting = (st.saving && st.draft && st.draft.watch === true) || (st.settings.watch && repo && repo.liveness === "never") ? WORDS.connecting + (repo && repo.runner ? repo.runner : rv.runnerName || "your runner") + WORDS.connectingTail : "";
  sheet.runner = { ...rv, connecting };
  // The Connect panel is drawn on its own (not inside `sheet`), so its answer arriving never rebuilds the boxes above it.
  const bridgeV = st.bridgeMod && st.sheetOpen ? st.bridgeMod.bridgeView(st.bridge, { repoName: bridgeTarget(st), canEdit: st.settings.canEdit, nowMs }) : null;
  const shown = st.draft && st.draft.operate !== undefined ? { ...st, settings: { ...st.settings, operate: st.draft.operate } } : st; // the operate switch the person just chose, while its save is out
  const asOf = (iso) => asOfWords({ as_of: iso }, nowMs);
  const base = { sheet, bridge: bridgeV, rv: sheet.runner, refreshFailed: st.refreshFailed ? WORDS.refreshFailed : "", failedKeys: st.failedKeys, operate: describeOperate(shown, nowMs, st.settings.watch ? repo : undefined, asOf, null) };
  if (!st.settings.watch) return { kind: "off", text: WORDS.watchOff, ...base };
  if (!repo) return { kind: "norepos", text: WORDS.noRepos, ...base };
  const { agents, lanes, gates, log, plan, stats, usage } = st.panels;
  const stale = (env) => isStale(repo, env, nowMs);
  const head = (env) => ({ asOf: asOfWords(env, nowMs), warn: stale(env) ? lastSeenWords(env, repo, nowMs) : "" });
  const live = !stale(agents);
  const envs = [agents, lanes, gates, log, plan, stats, usage].filter(isObj); // plan is the word "none" when the route answered 204
  const lg = st.log;
  const planned = isObj(plan) ? planView(plan, lanes, nowMs, repo.name, st.planPage) : null;
  const lane = lanes ? laneRows(lanes, gates, nowMs, repo.name) : null;
  const rows = agents ? agents.items.map((a) => agentRow(a, live, nowMs, repo.name)).filter((r) => r.state !== "stopped").map((r) => ({ ...r, stop: r.state === "running" ? stopOf(st, r.stopId) : null, who: agentWords(r) })) : [];
  return {
    kind: "ready", ...base, operate: describeOperate(shown, nowMs, repo, asOf, rows), halt: describeHalt(st, repo, nowMs),
    repos: st.repos.map((r) => ({ id: r.id, name: r.name, selected: r.id === repo.id })),
    chip: chipOf(repo), runner: repo.runner, banner: gapBanner(envs), notices: sourceNotices(envs, lanes),
    agents: { ...head(agents), failed: !agents, rows, empty: WORDS.noAgents },
    lanes: { ...head(lanes), failed: !lanes, open: lane ? lane.open : [], merged: lane ? lane.merged : [], empty: WORDS.noLanes },
    plan: { ...(plan === "none" ? { asOf: WORDS.noData, warn: "" } : head(plan)), failed: !plan, none: plan === "none", view: planned, notSynced: WORDS.noPlan },
    stats: { ...head(stats), failed: !stats, view: isObj(stats) ? statsView(stats, st.provOpen) : null },
    usage: { ...head(usage), failed: !usage, view: isObj(usage) ? usageView(usage) : null },
    log: {
      ...head(log), failed: !log, rows: lg.rows.map((l, i) => logRow(l, i, repo.name, nowMs)), empty: WORDS.noLog, note: WORDS.logNote, label: WORDS.logLabel,
      older: lg.loading ? WORDS.olderLoading : lg.cursor ? WORDS.older : WORDS.olderNone, canOlder: !!lg.cursor && !lg.loading, olderFailed: lg.failed ? WORDS.olderFailed : "",
      newest: lg.released > 0 ? WORDS.newest + " (" + lg.released + " newer lines not shown)" : "", said: lg.said,
    },
  };
}

// ── the controller ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const NO_PANELS = { agents: null, lanes: null, gates: null, log: null, plan: null, stats: null, usage: null };
const NO_LOG = { rows: [], cursor: "", pages: 0, released: 0, loading: false, failed: false, said: "" };
const aborted = (e, signal) => (signal && signal.aborted) || (e && e.name === "AbortError");

export function createTeam({ client = createTeamApi(), signal, onChange = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, setRepeat = setInterval, clearRepeat = clearInterval, now = Date.now } = {}) {
  let st = { status: "loading", settings: null, repos: [], selectedId: "", panels: NO_PANELS, log: NO_LOG, planPage: 0, provOpen: [], sheetOpen: false, saving: false, confirmDelete: false, notice: "", refreshFailed: false, failedKeys: [], op: NO_OP, draft: null, fleet: null, runnerPick: "", runnersMod: null, bridge: { repoId: "", data: null, failed: false, busy: false, notice: "", runnerPick: "", rootPick: "" }, bridgeMod: null };
  let safetyTimer = null, started = false, retryTimer = null, busy = false, queued = new Set(), lastFull = -Infinity, pick = 0, stopFn = null, saveVer = 0, hiddenFn = () => false;
  // Which parts a notice asked for, and when each may be read again. Every read, whoever asked for it, is marked here, so no part is read twice inside the gate.
  const gate = createCoalescer({ now, setTimer, clearTimer, run: (names) => { if (!hiddenFn()) refresh(new Set(names)); } });
  // A save starting or ending moves saveVer. A read remembers it when it starts; if it has moved, or a save is out, by the time the answer lands
  // the answer was asked before the save changed things and is dropped (the read that follows the save shows the server's answer).
  const set = (patch) => { if (("saving" in patch && patch.saving !== st.saving) || (patch.op && patch.op.saving !== st.op.saving)) saveVer += 1; st = { ...st, ...patch }; onChange(); };
  const operate = createOperate({ client, signal, get: () => st, set, refresh: () => refresh(), aborted: (e) => aborted(e, signal) });
  // One-click Connect lives in its own module, fetched the first time the Settings sheet opens (the page does not need it before). A module that cannot be fetched leaves the sheet without the panel.
  let bridgeCtl = null;
  async function bridgeOn() {
    if (bridgeCtl) return bridgeCtl;
    try {
      const m = await import("./team-runners.js");
      bridgeCtl = m.createBridge({ client, signal, get: () => st, set, aborted: (e) => aborted(e, signal) });
      set({ bridgeMod: m });
    } catch { bridgeCtl = null; } // fx-swallow-ok: the module could not be fetched; the sheet then shows no Connect panel and the rest works
    return bridgeCtl;
  }
  /** Reads where Connect stands for the repo the sheet is about. */
  async function showBridge() {
    const repo = bridgeRepo(st);
    if (!st.sheetOpen || !repo || (signal && signal.aborted)) return;
    const ctl = await bridgeOn();
    if (ctl && st.sheetOpen) await ctl.show(repo.id);
  }
  const bridgePoll = () => { if (!hiddenFn() && st.sheetOpen && bridgeCtl && bridgeCtl.waiting() && !st.bridge.busy) showBridge(); };
  const bridgeDo = (name) => (...args) => (bridgeCtl ? bridgeCtl[name](...args) : undefined);

  /**
   * Reads the parts named in `want` (a Set of READ_NAMES); everything when it holds them all, or when nothing has been loaded yet.
   * `status` is the settings and the repo list; when settings are already known and watch is on, only the repo list is read (liveness, last heard, halt),
   * because a heartbeat cannot change the settings. `operate` is the commands and the dials, read only for a member who can edit.
   */
  /** The runner list is a help, never a need: a read that fails leaves the app working and says so in the runner lines. */
  async function readFleetSafe() {
    const mod = import("./team-runners.js").then((m) => { st = { ...st, runnersMod: m }; }, () => {}); // a module that cannot be fetched leaves the switch on its plain words
    try { const raw = await client.runners(signal); await mod; return readFleet(raw); } catch (e) {
      await mod;
      if (aborted(e, signal)) throw e;
      return null;
    }
  }
  async function read(want) {
    const ver = saveVer;
    if (!st.settings || st.status !== "ready" || READ_NAMES.every((n) => want.has(n))) want = new Set(READ_NAMES);
    const everything = READ_NAMES.every((n) => want.has(n));
    let settings = st.settings, repos = st.repos, selectedId = st.selectedId, fleet = st.fleet;
    if (everything || want.has("status")) {
      try {
        if (everything || !settings.watch) {
          settings = readSettings(await client.settings(signal));
          if (!settings) throw new Error("shape");
          repos = [];
          if (!settings.watch || st.sheetOpen) fleet = await readFleetSafe(); // only a screen that shows the runners asks for them
          if (settings.watch) {
            repos = readRepos(await client.repos(signal));
            if (!repos) throw new Error("shape");
          }
        } else {
          repos = readRepos(await client.repos(signal));
          if (!repos) throw new Error("shape");
        }
      } catch (e) {
        if (aborted(e, signal)) return;
        set(st.settings ? { refreshFailed: true } : { status: "error" });
        return;
      }
      if (ver !== saveVer || st.saving || st.op.saving) return;
      // The same answer as the last one keeps the same objects, so nothing that shows them is redrawn.
      if (st.settings && JSON.stringify(st.settings) === JSON.stringify(settings)) settings = st.settings;
      if (JSON.stringify(st.repos) === JSON.stringify(repos)) repos = st.repos;
      selectedId = repos.some((r) => r.id === st.selectedId) ? st.selectedId : repos.length ? repos[0].id : "";
      const changed = selectedId !== st.selectedId;
      if (changed) want = new Set(READ_NAMES); // another repo is shown now: all of it is read
      set({ status: "ready", settings, repos, fleet, selectedId, refreshFailed: selectedId ? st.refreshFailed : false, panels: changed ? NO_PANELS : st.panels, op: changed ? NO_OP : st.op, ...(changed ? { log: NO_LOG, planPage: 0, provOpen: [] } : {}) }); // the note stays up until the panels say otherwise, so a poll that fails again does not clear it and set it again
    }
    if (!selectedId) return;
    const token = pick;
    const stale = () => token !== pick || (signal && signal.aborted); // another repo was chosen, or the window closed, while a read was out
    const names = PANELS.filter((k) => want.has(k));
    const opRead = want.has("operate") && settings.canEdit ? operate.read(selectedId, stale) : Promise.resolve();
    const results = await Promise.allSettled(names.map((k) => client.panel(k, selectedId, signal)));
    await opRead;
    if (stale()) return;
    if (names.length === 0) { // only the status (or the operate half) was read: the note says what the last panel reads said
      if (st.refreshFailed !== (st.failedKeys.length === PANELS.length)) set({ refreshFailed: st.failedKeys.length === PANELS.length });
      return;
    }
    const next = { ...st.panels };
    let failedNow = [], first = null;
    for (const [i, k] of names.entries()) {
      const v = results[i].status === "fulfilled" ? results[i].value : undefined;
      let env = k === "plan" ? (v === null ? "none" : readPlan(v)) : k === "stats" ? readStats(v) : k === "usage" ? readUsage(v) : readEnvelope(v);
      if (k === "lanes" && env) env = await moreLanes(env, selectedId);
      if (env) next[k] = env;
      else failedNow.push(k);
      if (k === "log" && env && st.log.pages <= 1) first = { ...NO_LOG, rows: env.items, cursor: env.cursor, pages: 1 }; // once older pages are open, a refresh leaves the list where the person is
    }
    if (token !== pick || (signal && signal.aborted)) return;
    // One panel that cannot be read marks that panel only (its own failed note, said aloud). The view-wide note is for the reads the whole view stands on: settings and the repo list fail it in read() above, and every panel failing at once fails it here.
    const failedKeys = PANELS.filter((k) => (names.includes(k) ? failedNow.includes(k) : st.failedKeys.includes(k))); // a part not read this time keeps what it said last time
    set({ panels: next, failedKeys, refreshFailed: failedKeys.length === PANELS.length, ...(first ? { log: first } : {}) });
  }
  /** The merged count needs every lane the server has, so up to LANE_PAGES pages are read, following the cursor. A page that cannot be read leaves its cursor in place, so the count still says "at least". */
  async function moreLanes(env, id) {
    let all = env;
    for (let n = 1; n < LANE_PAGES && all.cursor; n++) {
      let page = null;
      try { page = readEnvelope(await client.lanesPage(id, all.cursor, signal)); } catch (e) { if (aborted(e, signal)) return all; }
      if (!page) break;
      all = { ...all, items: all.items.concat(page.items), cursor: page.cursor };
    }
    return all;
  }
  async function loadOlder() {
    const l = st.log, id = st.selectedId;
    if (l.loading || !l.cursor || !id) return;
    const token = pick;
    set({ log: { ...l, loading: true, failed: false } });
    let env = null;
    try { env = readEnvelope(await client.older(id, l.cursor, signal)); } catch (e) { if (aborted(e, signal)) return; }
    if (token !== pick || (signal && signal.aborted)) return;
    if (!env) { set({ log: { ...st.log, loading: false, failed: true } }); return; }
    const all = st.log.rows.concat(env.items);
    const over = Math.max(0, all.length - LOG_WINDOW); // the newest rows leave the window, so the list never holds more than LOG_WINDOW
    set({ log: { rows: all.slice(over), cursor: env.cursor, pages: st.log.pages + 1, released: st.log.released + over, loading: false, failed: false, said: "Older log lines loaded (page " + (st.log.pages + 1) + ")." } });
  }
  /** A read that failed is tried once more after RETRY_MS, for the parts that failed, rather than waiting for the next notice or the safety read. */
  function retryFailed(names, wasRetry) {
    if (wasRetry || retryTimer !== null || hiddenFn()) return;
    const failed = new Set(PANELS.filter((k) => names.has(k) && st.failedKeys.includes(k)));
    if (st.refreshFailed && failed.size === 0) for (const n of names) failed.add(n); // the status read itself failed: everything asked for again
    if (failed.size === 0) return;
    retryTimer = setTimer(() => { retryTimer = null; if (!hiddenFn()) refresh(failed, true); }, RETRY_MS);
  }
  /** A command is unsettled until the runner has reported back (applied with its acknowledgement) or it has ended another way. */
  const unsettled = () => !!st.settings && st.settings.canEdit && (st.op.commands || []).some((c) => c.state === "pending" || c.state === "delivered" || (c.state === "applied" && c.ackedAt === ""));
  /** Reads the parts in `want` (a Set of READ_NAMES), or everything. A read asked for while another is out is queued, and the names asked for meanwhile are read together afterwards. */
  async function refresh(want, retry = false) {
    const names = want instanceof Set ? want : new Set(READ_NAMES);
    if (busy) { for (const n of names) queued.add(n); return; }
    busy = true;
    gate.mark(names); // these parts are read now, so none of them is read again inside the gate
    if (READ_NAMES.every((n) => names.has(n))) { lastFull = now(); armSafety(); }
    try { await read(names); } finally { busy = false; }
    retryFailed(names, retry);
    if (queued.size) { const next = queued; queued = new Set(); await refresh(next); }
  }
  function select(id) {
    if (id === st.selectedId || !st.repos.some((r) => r.id === id)) return;
    pick += 1;
    set({ selectedId: id, panels: NO_PANELS, log: NO_LOG, planPage: 0, provOpen: [], refreshFailed: false, failedKeys: [], op: NO_OP });
    refresh();
    showBridge();
  }
  /** `draft` is what the person just chose: it stays on screen while the save is out, and is dropped if the save fails (the last server value comes back). */
  async function put(call, ok, forbidden, draft = null, commit = null) {
    if (st.saving) return;
    set({ saving: true, notice: "", confirmDelete: false, draft });
    try { await call(); } catch (e) {
      if (!aborted(e, signal)) set({ saving: false, draft: null, notice: failureSentence(e, forbidden) });
      return;
    }
    // The choice becomes the shown value at once; the read that follows replaces it with the server's own answer.
    set({ saving: false, draft: null, notice: ok, ...(commit && st.settings ? { settings: commit(st.settings) } : {}) });
    await refresh();
  }
  const enabledIds = (except, on) => st.settings.repos.filter((r) => (r.id === except ? on : r.enabled)).map((r) => r.sendId);
  function onChanged(dto) {
    const rid = dto && isObj(dto.data) ? idKey(dto.data.repo_id) : "";
    if (rid !== "" && st.selectedId !== "" && rid !== st.selectedId) return; // another repo's event: nothing here changed
    if (hiddenFn()) return; // a hidden tab ignores notices; one catch-up read follows when it is shown again
    const names = noticeNames(dto && dto.data);
    if (unsettled() && !names.includes("operate")) names.push("operate"); // the runner's report on a command raises no notice of its own
    gate.note(names);
  }
  const opPoll = () => { if (!hiddenFn() && unsettled() && !busy) refresh(new Set(["operate"])); };
  const refreshVisible = () => { if (!hiddenFn()) refresh(); };
  /** The safety read is one timer, set SAFETY_MS after each full read whatever caused it, so the gap between full reads never passes SAFETY_MS. A hidden tab holds none; showing it reads everything, which sets it again. */
  function armSafety() {
    if (safetyTimer !== null) { clearTimer(safetyTimer); safetyTimer = null; }
    if (!started || hiddenFn()) return;
    safetyTimer = setTimer(() => { safetyTimer = null; if (!hiddenFn()) refresh(); }, SAFETY_MS);
  }
  // The live stream's own nudge (the fallback poll, or the shell's backstop on a click) names nothing, so it asks for everything, and only when
  // no full read has been made for a safety interval: the shell sends one at most every 10 s while the person is working, which would otherwise be a poll.
  // A resync (the server says events were missed, or the stream came back) is read in full at once, not after a settle: nothing is queued behind a notice that may
  // never come, and the shell lets one through at most every 10 s. The read starts its parts' windows, so a notice right behind it is read when they end.
  const nudged = (why) => {
    if (hiddenFn()) return;
    if (why === "resync") refresh();
    else if (now() - lastFull >= SAFETY_MS) gate.note(READ_NAMES);
  };
  function start({ subscribe, listen, hidden = () => false, visibility } = {}) {
    stop();
    hiddenFn = hidden;
    const offs = [typeof subscribe === "function" ? subscribe(nudged) : () => {}, typeof listen === "function" ? listen(LIVE_EVENT, onChanged) : () => {},
      typeof visibility === "function" ? visibility(refreshVisible) : () => {}];
    started = true;
    armSafety();
    const poll = setRepeat(() => { opPoll(); bridgePoll(); }, OP_POLL_MS); // one repeat for both: the runner's report on a command raises no notice
    stopFn = () => { offs.forEach((off) => off()); clearRepeat(poll); started = false; armSafety(); };
  }
  function stop() {
    if (stopFn) stopFn();
    stopFn = null;
    gate.cancel();
    if (retryTimer !== null) { clearTimer(retryTimer); retryTimer = null; }
    queued = new Set();
  }
  return {
    load: refresh, refresh, select, start, stop, loadOlder,
    newest: () => { set({ log: NO_LOG }); refresh(); },
    toggleProv: (id) => set({ provOpen: st.provOpen.includes(id) ? st.provOpen.filter((k) => k !== id) : st.provOpen.concat(id) }),
    planPage: (by) => set({ planPage: Math.max(0, st.planPage + by) }),
    pickRunner: (id) => set({ runnerPick: id }),
    toggleSheet: () => {
      set({ sheetOpen: !st.sheetOpen, confirmDelete: false, notice: "" });
      if (st.sheetOpen && st.settings && st.settings.watch) readFleetSafe().then((fleet) => { if (!(signal && signal.aborted)) set({ fleet }); }, () => {});
      if (st.sheetOpen) showBridge();
    },
    bridge: { connect: bridgeDo("connect"), disconnect: bridgeDo("disconnect"), cancel: bridgeDo("cancel"), pickRunner: bridgeDo("pickRunner"), pickRoot: bridgeDo("pickRoot") },
    setWatch: (on) => put(() => client.saveSettings({ watch_enabled: on }, signal), WORDS.saved, undefined, { watch: on, repos: {} }, (s) => ({ ...s, watch: on })),
    setRepo: (id, on) => put(() => client.saveSettings({ repo_ids: enabledIds(id, on) }, signal), WORDS.saved, undefined, { repos: { [id]: on } }, (s) => ({ ...s, repos: s.repos.map((r) => (r.id === id ? { ...r, enabled: on } : r)) })),
    askDelete: () => set({ confirmDelete: true }),
    cancelDelete: () => set({ confirmDelete: false }),
    operate,
    deleteData: () => put(() => client.deleteData(signal), WORDS.deleted, WORDS.deleteForbidden),
    get state() { return st; },
  };
}
