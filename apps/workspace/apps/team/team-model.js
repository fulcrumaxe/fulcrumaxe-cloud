// The Team app's logic, with no DOM (unit-tested with a fake client). The page is team-app.js and only draws what describe() returns.
//
// Rules this file holds, from the engine-bridge lessons:
//  - A gap is never silent: an envelope that reports missing events puts a banner on the app, and the banner has no way to be dismissed.
//  - Every panel carries its data age ("as of HH:MM (N min ago)"). A stale heartbeat adds "last seen N min ago" and the data stays on screen.
//  - An agent is "running" only while the session is live (the bridge heard from the engine in the last 180 s) and its start is under 3 h old;
//    otherwise it reads "unknown", whatever the server said. Both the bridge session and the engine session count: the list's liveness chip
//    is the bridge's view, heard_age_s is the engine's own last word.
//  - A reply that does not have the documented shape is a failed read, never an empty list (fail closed).
//  - The cloud sends facts; this file does no cost, rate or total maths: a dollar figure is drawn as sent, through the one shared formatter, and never added up here.
//    The only arithmetic is ages, counts of rows on screen, and joining consecutive event numbers into ranges.
// Every word that reaches the page is a string made here; nothing is null, undefined or NaN.
import { isRateLimited, retryWords, waitSeconds } from "../_lib/api.js";
import { usd as dollars } from "../_lib/dom.js";
import { PANELS, createTeamApi } from "./team-api.js";
import { NO_OP, agentWords, createOperate, describeHalt, describeOperate, isAgentId, stopOf } from "./team-operate.js";

export const LIVE_EVENT = "engine.changed";
export const REFRESH_MS = 15000;
export const DEBOUNCE_MS = 1000;
export const STALE_HEARD_S = 180;
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
  noAgents: "No agents running",
  noLanes: "No pull requests in the merge lane",
  panelFailed: "This panel couldn't be read.",
  refreshFailed: "Couldn't refresh. Showing the last data received.",
  noData: "no data yet",
  mergedToday: "Merged today",
  settings: "Settings",
  watch: "Watch the engine team on this machine",
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
    sendId: r.repo_id, id: idKey(r.repo_id), name: r.full_name, enabled: r.enabled === true, eligible: r.eligible === true, refusal: typeof r.refusal === "string" ? r.refusal : r.eligible === true ? "" : "other",
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
/** The envelope says the engine has not been heard from within 180 s (or ever), or the list says the session is not live. */
export const isStale = (repo, env) => repo.liveness !== "live" || !env || env.heard_age_s === null || env.heard_age_s > STALE_HEARD_S;
const lastSeenWords = (env) => (!env || env.heard_age_s === null ? "last seen: never" : "last seen " + Math.floor(env.heard_age_s / 60) + " min ago");

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

/** Everything the page draws for one moment. */
export function describe(st, nowMs) {
  if (st.status === "loading") return { kind: "loading", text: WORDS.loading };
  if (st.status === "error" || !st.settings) return { kind: "error", text: WORDS.error };
  const sheet = {
    open: st.sheetOpen, canEdit: st.settings.canEdit, watch: st.draft && st.draft.watch !== undefined ? st.draft.watch : st.settings.watch, saving: st.saving, confirmDelete: st.confirmDelete, notice: st.notice, readOnly: st.settings.canEdit ? "" : WORDS.readOnly,
    repos: st.settings.repos.map((r) => ({ id: r.id, name: r.name, checked: st.draft && Object.hasOwn(st.draft.repos, r.id) ? st.draft.repos[r.id] : r.enabled, refused: !r.eligible && !r.enabled, reason: r.eligible || r.enabled ? "" : WORDS.refusals[r.refusal] || WORDS.refusalOther })),
  };
  const repo = st.repos.find((r) => r.id === st.selectedId);
  const shown = st.draft && st.draft.operate !== undefined ? { ...st, settings: { ...st.settings, operate: st.draft.operate } } : st; // the operate switch the person just chose, while its save is out
  const asOf = (iso) => asOfWords({ as_of: iso }, nowMs);
  const base = { sheet, refreshFailed: st.refreshFailed ? WORDS.refreshFailed : "", failedKeys: st.failedKeys, operate: describeOperate(shown, nowMs, st.settings.watch ? repo : undefined, asOf, null) };
  if (!st.settings.watch) return { kind: "off", text: WORDS.watchOff, ...base };
  if (!repo) return { kind: "norepos", text: WORDS.noRepos, ...base };
  const { agents, lanes, gates, log, plan, stats, usage } = st.panels;
  const stale = (env) => isStale(repo, env);
  const head = (env) => ({ asOf: asOfWords(env, nowMs), warn: stale(env) ? lastSeenWords(env) : "" });
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

export function createTeam({ client = createTeamApi(), signal, onChange = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, setRepeat = setInterval, clearRepeat = clearInterval } = {}) {
  let st = { status: "loading", settings: null, repos: [], selectedId: "", panels: NO_PANELS, log: NO_LOG, planPage: 0, provOpen: [], sheetOpen: false, saving: false, confirmDelete: false, notice: "", refreshFailed: false, failedKeys: [], op: NO_OP, draft: null };
  let busy = false, again = false, pick = 0, debounce = null, stopFn = null, saveVer = 0, hiddenFn = () => false;
  // A save starting or ending moves saveVer. A read remembers it when it starts; if it has moved, or a save is out, by the time the answer lands
  // the answer was asked before the save changed things and is dropped (the read that follows the save shows the server's answer).
  const set = (patch) => { if (("saving" in patch && patch.saving !== st.saving) || (patch.op && patch.op.saving !== st.op.saving)) saveVer += 1; st = { ...st, ...patch }; onChange(); };
  const operate = createOperate({ client, signal, get: () => st, set, refresh: () => refresh(), aborted: (e) => aborted(e, signal) });

  async function read() {
    const ver = saveVer;
    let settings, repos = [];
    try {
      settings = readSettings(await client.settings(signal));
      if (!settings) throw new Error("shape");
      if (settings.watch) {
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
    const selectedId = repos.some((r) => r.id === st.selectedId) ? st.selectedId : repos.length ? repos[0].id : "";
    const changed = selectedId !== st.selectedId;
    set({ status: "ready", settings, repos, selectedId, refreshFailed: selectedId ? st.refreshFailed : false, panels: changed ? NO_PANELS : st.panels, op: changed ? NO_OP : st.op, ...(changed ? { log: NO_LOG, planPage: 0, provOpen: [] } : {}) }); // the note stays up until the panels say otherwise, so a poll that fails again does not clear it and set it again
    if (!selectedId) return;
    const token = pick;
    const stale = () => token !== pick || (signal && signal.aborted); // another repo was chosen, or the window closed, while a read was out
    const opRead = settings.canEdit ? operate.read(selectedId, stale) : Promise.resolve();
    const results = await Promise.allSettled(PANELS.map((k) => client.panel(k, selectedId, signal)));
    await opRead;
    if (stale()) return;
    const next = { ...st.panels };
    let failedKeys = [], first = null;
    for (const [i, k] of PANELS.entries()) {
      const v = results[i].status === "fulfilled" ? results[i].value : undefined;
      let env = k === "plan" ? (v === null ? "none" : readPlan(v)) : k === "stats" ? readStats(v) : k === "usage" ? readUsage(v) : readEnvelope(v);
      if (k === "lanes" && env) env = await moreLanes(env, selectedId);
      if (env) next[k] = env;
      else failedKeys.push(k);
      if (k === "log" && env && st.log.pages <= 1) first = { ...NO_LOG, rows: env.items, cursor: env.cursor, pages: 1 }; // once older pages are open, a refresh leaves the list where the person is
    }
    if (token !== pick || (signal && signal.aborted)) return;
    // One panel that cannot be read marks that panel only (its own failed note, said aloud). The view-wide note is for the reads the whole view stands on: settings and the repo list fail it in read() above, and every panel failing at once fails it here.
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
  async function refresh() {
    if (busy) { again = true; return; }
    busy = true;
    try { await read(); } finally { busy = false; }
    if (again) { again = false; await refresh(); }
  }
  function select(id) {
    if (id === st.selectedId || !st.repos.some((r) => r.id === id)) return;
    pick += 1;
    set({ selectedId: id, panels: NO_PANELS, log: NO_LOG, planPage: 0, provOpen: [], refreshFailed: false, failedKeys: [], op: NO_OP });
    refresh();
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
    if (debounce !== null) clearTimer(debounce);
    debounce = setTimer(() => { debounce = null; refreshVisible(); }, DEBOUNCE_MS);
  }
  const refreshVisible = () => { if (!hiddenFn()) refresh(); }; // a hidden tab reads nothing; one read follows when it is shown again
  function start({ subscribe, listen, hidden = () => false, visibility } = {}) {
    stop();
    hiddenFn = hidden;
    const offs = [typeof subscribe === "function" ? subscribe(refreshVisible) : () => {}, typeof listen === "function" ? listen(LIVE_EVENT, onChanged) : () => {},
      typeof visibility === "function" ? visibility(refreshVisible) : () => {}];
    const timer = setRepeat(refreshVisible, REFRESH_MS);
    stopFn = () => { offs.forEach((off) => off()); clearRepeat(timer); };
  }
  function stop() {
    if (stopFn) stopFn();
    stopFn = null;
    if (debounce !== null) clearTimer(debounce);
    debounce = null;
    again = false;
  }
  return {
    load: refresh, refresh, select, start, stop, loadOlder,
    newest: () => { set({ log: NO_LOG }); refresh(); },
    toggleProv: (id) => set({ provOpen: st.provOpen.includes(id) ? st.provOpen.filter((k) => k !== id) : st.provOpen.concat(id) }),
    planPage: (by) => set({ planPage: Math.max(0, st.planPage + by) }),
    toggleSheet: () => set({ sheetOpen: !st.sheetOpen, confirmDelete: false, notice: "" }),
    setWatch: (on) => put(() => client.saveSettings({ watch_enabled: on }, signal), WORDS.saved, undefined, { watch: on, repos: {} }, (s) => ({ ...s, watch: on })),
    setRepo: (id, on) => put(() => client.saveSettings({ repo_ids: enabledIds(id, on) }, signal), WORDS.saved, undefined, { repos: { [id]: on } }, (s) => ({ ...s, repos: s.repos.map((r) => (r.id === id ? { ...r, enabled: on } : r)) })),
    askDelete: () => set({ confirmDelete: true }),
    cancelDelete: () => set({ confirmDelete: false }),
    operate,
    deleteData: () => put(() => client.deleteData(signal), WORDS.deleted, WORDS.deleteForbidden),
    get state() { return st; },
  };
}
