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
    capacity: cap ? { light: cap.light, heavy: cap.heavy, total: cap.total_limit } : null,
    runs: (Array.isArray(r.current_runs) ? r.current_runs : []).filter((x) => x && typeof x.id === "string").map((x) => ({ id: x.id, label: text(x.label) || "A run" })),
    repos: (Array.isArray(r.repos) ? r.repos : []).map((x) => text(x && x.name)).filter(Boolean),
    labels: (Array.isArray(r.labels) ? r.labels : []).map(text).filter(Boolean),
    facts: r.facts && typeof r.facts === "object" ? { os: text(r.facts.os), arch: text(r.facts.arch), engine: text(r.facts.engine) } : null,
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
  if (r.check === "checking" && (r.state === "online_idle" || r.state === "busy" || r.state === "offline")) return { mark, words: "Checking…" };
  if (r.state === "not_responding") return { mark, words: ["Not responding", r.note].filter(Boolean).join(" — ") };
  // A wake-capable runner past the 2-minute window but inside its 35-minute slot reads "Online · Last heard 7 min ago" (the note comes from the cloud).
  if (r.state === "busy") return { mark, words: [r.loadLabel || "Busy", r.note].filter(Boolean).join(" · ") };
  if (r.state === "online_idle") return { mark, words: ["Online", r.note].filter(Boolean).join(" · ") };
  if (r.state === "paused") return { mark, words: ["Paused", r.note].filter(Boolean).join(" · ") };
  if (r.state === "revoked") return { mark, words: r.note || "Revoked" };
  return { mark, words: STATE_WORDS[r.state] || "Unknown" };
}

export const versionText = (r) => [r.version || "Version unknown", r.state === "outdated" ? "Update needed" : ""].filter(Boolean).join(" · ");
export const capacityText = (r) =>
  r.state === "revoked" ? "None" : r.capacity === null ? "Capacity unknown" : "Light " + r.capacity.light.in_use + " of " + r.capacity.light.limit + " · Heavy " + r.capacity.heavy.in_use + " of " + r.capacity.heavy.limit;
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
  // One timer at a time, and only while some runner's check is still waiting: an idle page never polls.
  function pollWhileChecking() {
    if (polling || (signal && signal.aborted) || !st.fleet || !st.fleet.runners.some((r) => r.check === "checking")) return;
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
    } catch (e) {
      if (mine !== gen || cancelled(e)) return;
      if (st.status !== "ready") st = { status: "error", fleet: null };
    }
    onChange();
    pollWhileChecking();
  }
  async function act(id, action, body) {
    if (pending.has(id)) return "";
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
      result = sentence(ACTION_SENTENCES, e);
    }
    pending.delete(id);
    await load();
    return result;
  }
  return { load, act, isPending: (id) => pending.has(id), get state() { return st; } };
}

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
