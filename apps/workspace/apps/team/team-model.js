// The Team app's logic, with no DOM (unit-tested with a fake client). The page is team-app.js and only draws what describe() returns.
//
// Rules this file holds, from the engine-bridge lessons:
//  - A gap is never silent: an envelope that reports missing events puts a banner on the app, and the banner has no way to be dismissed.
//  - Every panel carries its data age ("as of HH:MM (N min ago)"). A stale heartbeat adds "last seen N min ago" and the data stays on screen.
//  - An agent is "running" only while the session is live (the bridge heard from the engine in the last 180 s) and its start is under 3 h old;
//    otherwise it reads "unknown", whatever the server said. Both the bridge session and the engine session count: the list's liveness chip
//    is the bridge's view, heard_age_s is the engine's own last word.
//  - A reply that does not have the documented shape is a failed read, never an empty list (fail closed).
//  - The cloud sends facts; this file does no cost, rate or total maths. The only arithmetic is ages and counts of rows on screen.
// Every word that reaches the page is a string made here; nothing is null, undefined or NaN.
import { isRateLimited, retryWords, waitSeconds } from "../_lib/api.js";
import { PANELS, createTeamApi } from "./team-api.js";
import { NO_OP, agentWords, createOperate, describeOperate, isAgentId, stopOf } from "./team-operate.js";

export const LIVE_EVENT = "engine.changed";
export const REFRESH_MS = 15000;
export const DEBOUNCE_MS = 1000;
export const STALE_HEARD_S = 180;
export const UNKNOWN_AFTER_MS = 3 * 3600 * 1000;
export const SOURCE_ORDER = ["loop", "team_log", "plan", "merge_queue"];
export const SOURCE_LIMIT_S = { loop: 3600, team_log: 7200, plan: 26 * 3600, merge_queue: 6 * 3600 };
const SOURCE_NAME = { loop: "loop", team_log: "team log", plan: "plan", merge_queue: "merge queue" };
export const FINAL_LANE_STATES = ["merged", "failed", "dequeued", "refused"];

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
  sendRefusals: { repo_not_runner_local: "That repository isn't on one of your runners.", public_repo: "A public repository can't be watched." },
};

const LANE_STATE = { queued: "Queued", testing: "Testing", merged: "Merged", failed: "Failed", dequeued: "Removed from the queue", refused: "Refused" };
const GATE_NAME = { gate1: "Gate 1", code_review: "Code review", security_review: "Security review", acceptance: "Acceptance", browser: "Browser", ci_full: "CI full" };
const RESULT = { pass: "pass", fail: "fail", error: "error", skipped: "skipped" };
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
export function readEnvelope(raw) {
  if (!isObj(raw) || !Array.isArray(raw.items) || !Array.isArray(raw.gaps) || !isInt(raw.missing_events)) return null;
  const ages = {};
  if (isObj(raw.source_ages_s)) for (const k of SOURCE_ORDER) if (Number.isFinite(raw.source_ages_s[k]) && raw.source_ages_s[k] >= 0) ages[k] = raw.source_ages_s[k];
  const gaps = raw.gaps.filter((g) => isObj(g) && stamp(g.before_ts) !== null).map((g) => ({ before_ts: g.before_ts }));
  return { items: raw.items.filter(isObj), as_of: stamp(raw.as_of) === null ? "" : raw.as_of, heard_age_s: isInt(raw.heard_age_s) ? raw.heard_age_s : null, source_ages_s: ages, gaps, missing_events: raw.missing_events };
}

const idKey = (v) => (typeof v === "string" || Number.isInteger(v) ? String(v) : "");
export function readRepos(raw) {
  const list = Array.isArray(raw) ? raw : isObj(raw) && Array.isArray(raw.items) ? raw.items : null;
  if (!list) return null;
  return list.filter((r) => isObj(r) && idKey(r.repo_id) !== "" && typeof r.full_name === "string" && r.full_name !== "").map((r) => ({
    id: idKey(r.repo_id), name: r.full_name, runner: typeof r.runner_name === "string" ? r.runner_name : "", liveness: typeof r.liveness === "string" ? r.liveness : "never",
    lastHeard: typeof r.last_heard_at === "string" ? r.last_heard_at : "", operate: r.operate_enabled === true, halted: r.halted === true, haltPending: r.halt_pending === true,
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
    open: st.sheetOpen, canEdit: st.settings.canEdit, watch: st.settings.watch, saving: st.saving, confirmDelete: st.confirmDelete, notice: st.notice, readOnly: st.settings.canEdit ? "" : WORDS.readOnly,
    repos: st.settings.repos.map((r) => ({ id: r.id, name: r.name, checked: r.enabled, refused: !r.eligible && !r.enabled, reason: r.eligible || r.enabled ? "" : WORDS.refusals[r.refusal] || WORDS.refusalOther })),
  };
  const repo = st.repos.find((r) => r.id === st.selectedId);
  const asOf = (iso) => asOfWords({ as_of: iso }, nowMs);
  const base = { sheet, refreshFailed: st.refreshFailed ? WORDS.refreshFailed : "", operate: describeOperate(st, nowMs, st.settings.watch ? repo : undefined, asOf, null) };
  if (!st.settings.watch) return { kind: "off", text: WORDS.watchOff, ...base };
  if (!repo) return { kind: "norepos", text: WORDS.noRepos, ...base };
  const { agents, lanes, gates } = st.panels;
  const stale = (env) => isStale(repo, env);
  const head = (env) => ({ asOf: asOfWords(env, nowMs), warn: stale(env) ? lastSeenWords(env) : "" });
  const live = !stale(agents);
  const lane = lanes ? laneRows(lanes, gates, nowMs, repo.name) : null;
  const rows = agents ? agents.items.map((a) => agentRow(a, live, nowMs, repo.name)).filter((r) => r.state !== "stopped").map((r) => ({ ...r, stop: r.state === "running" ? stopOf(st, r.stopId) : null, who: agentWords(r) })) : [];
  return {
    kind: "ready", ...base, operate: describeOperate(st, nowMs, repo, asOf, rows),
    repos: st.repos.map((r) => ({ id: r.id, name: r.name, selected: r.id === repo.id })),
    chip: chipOf(repo), runner: repo.runner, banner: gapBanner([agents, lanes, gates]), notices: sourceNotices([agents, lanes, gates], lanes),
    agents: { ...head(agents), failed: !agents, rows, empty: WORDS.noAgents },
    lanes: { ...head(lanes), failed: !lanes, open: lane ? lane.open : [], merged: lane ? lane.merged : [], empty: WORDS.noLanes },
  };
}

// ── the controller ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const NO_PANELS = { agents: null, lanes: null, gates: null };
const aborted = (e, signal) => (signal && signal.aborted) || (e && e.name === "AbortError");

export function createTeam({ client = createTeamApi(), signal, onChange = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, setRepeat = setInterval, clearRepeat = clearInterval } = {}) {
  let st = { status: "loading", settings: null, repos: [], selectedId: "", panels: NO_PANELS, sheetOpen: false, saving: false, confirmDelete: false, notice: "", refreshFailed: false, op: NO_OP };
  let busy = false, again = false, pick = 0, debounce = null, stopFn = null;
  const set = (patch) => { st = { ...st, ...patch }; onChange(); };
  const operate = createOperate({ client, signal, get: () => st, set, refresh: () => refresh(), aborted: (e) => aborted(e, signal) });

  async function read() {
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
    const selectedId = repos.some((r) => r.id === st.selectedId) ? st.selectedId : repos.length ? repos[0].id : "";
    const changed = selectedId !== st.selectedId;
    set({ status: "ready", settings, repos, selectedId, refreshFailed: selectedId ? st.refreshFailed : false, panels: changed ? NO_PANELS : st.panels, op: changed ? NO_OP : st.op }); // the note stays up until the panels say otherwise, so a poll that fails again does not clear it and set it again
    if (!selectedId) return;
    const token = pick;
    const stale = () => token !== pick || (signal && signal.aborted); // another repo was chosen, or the window closed, while a read was out
    const opRead = settings.canEdit ? operate.read(selectedId, stale) : Promise.resolve();
    const results = await Promise.allSettled(PANELS.map((k) => client.panel(k, selectedId, signal)));
    await opRead;
    if (stale()) return;
    const next = { ...st.panels };
    let failed = false;
    PANELS.forEach((k, i) => {
      const env = results[i].status === "fulfilled" ? readEnvelope(results[i].value) : null;
      if (env) next[k] = env;
      else failed = true;
    });
    set({ panels: next, refreshFailed: failed });
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
    set({ selectedId: id, panels: NO_PANELS, refreshFailed: false, op: NO_OP });
    refresh();
  }
  async function put(call, ok, forbidden) {
    if (st.saving) return;
    set({ saving: true, notice: "", confirmDelete: false });
    try { await call(); } catch (e) {
      if (!aborted(e, signal)) set({ saving: false, notice: failureSentence(e, forbidden) });
      return;
    }
    set({ saving: false, notice: ok });
    await refresh();
  }
  const enabledIds = (except, on) => st.settings.repos.filter((r) => (r.id === except ? on : r.enabled)).map((r) => r.sendId);
  function onChanged(dto) {
    const rid = dto && isObj(dto.data) ? idKey(dto.data.repo_id) : "";
    if (rid !== "" && st.selectedId !== "" && rid !== st.selectedId) return; // another repo's event: nothing here changed
    if (debounce !== null) clearTimer(debounce);
    debounce = setTimer(() => { debounce = null; refresh(); }, DEBOUNCE_MS);
  }
  function start({ subscribe, listen, hidden = () => false } = {}) {
    stop();
    const offs = [typeof subscribe === "function" ? subscribe(() => refresh()) : () => {}, typeof listen === "function" ? listen(LIVE_EVENT, onChanged) : () => {}];
    const timer = setRepeat(() => { if (!hidden()) refresh(); }, REFRESH_MS);
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
    load: refresh, refresh, select, start, stop,
    toggleSheet: () => set({ sheetOpen: !st.sheetOpen, confirmDelete: false, notice: "" }),
    setWatch: (on) => put(() => client.saveSettings({ watch_enabled: on }, signal), WORDS.saved),
    setRepo: (id, on) => put(() => client.saveSettings({ repo_ids: enabledIds(id, on) }, signal), WORDS.saved),
    askDelete: () => set({ confirmDelete: true }),
    cancelDelete: () => set({ confirmDelete: false }),
    operate,
    deleteData: () => put(() => client.deleteData(signal), WORDS.deleted, WORDS.deleteForbidden),
    get state() { return st; },
  };
}
