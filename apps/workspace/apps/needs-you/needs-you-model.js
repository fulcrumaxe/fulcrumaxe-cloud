// D#598 P8c: the Needs you list's logic, with no DOM (unit-tested with a fake call()). The page is needs-you-app.js.
//
// A row is a pull request waiting for a person to merge it (GET /api/v1/merge-ready, D#598 P8c-2b: a link to GitHub, no buttons; the cloud drops it when the
// pull request is merged or closed), a decision ask (GET /api/v1/decision-asks, D#598 P8c-2a) or a setup request (GET /api/v1/setup-requests). An ask shows the cloud's own name for
// the decision, the option the agent recommends, one button per option and Deny, and the agent's reason as a quotation. Answering is final (the work item
// resumes), so there is no undo here; a second answer from another window is told it was already answered.
// The cloud writes every sentence about a request's check: `status_sentence` and
// `check_interval_seconds` come from the API and are shown as they arrive. This file adds no words about a check of its own, except "Checking now."
// while the person's own Mark done is in flight (the approved sentence 3, only for a request that has an automatic check).
//
// Plain text only (CWE-79): `title`, `target` and `reason` come from an agent and `status_sentence` is filled from the agent's target name, so every one
// of them reaches the page as a text node through h() and nothing here builds markup. The one link a row may hold is `provider_url`, and it is
// checked again here against the fixed host list. Nothing here puts null or undefined on a screen: every text function returns a string.
import { api, isRateLimited, retryWords, waitSeconds } from "../_lib/api.js";

export const LIST_URL = "/api/v1/setup-requests?state=open";
// The done and withdraw routes take no request body at all (the API answers 400 to any body), so these two POSTs are sent bare.
export const actionUrl = (id, verb) => "/api/v1/setup-requests/" + encodeURIComponent(id) + "/" + verb;
export const ASKS_URL = "/api/v1/decision-asks";
export const answerUrl = (id) => "/api/v1/decision-asks/" + encodeURIComponent(id) + "/answer";
export const MERGE_URL = "/api/v1/merge-ready";
export const REFRESH_MS = 30000;
export const PROVIDER_HOSTS = ["github.com", "vercel.com"];
const STATES = ["open", "done", "withdrawn"];

/** The words this screen adds around the API's own sentences. */
export const WORDS = {
  title: "Needs you",
  loading: "Loading…",
  error: "Needs you isn't available right now.",
  empty: "Nothing needs you right now.",
  older: "Older requests aren't shown.",
  markDone: "Mark done",
  withdraw: "Withdraw",
  done: "Done",
  withdrawn: "Withdrawn",
  checkingNow: "Checking now.",
  onlyAdmins: "Only owners and admins can do this.",
  failed: "That didn't go through. Try again.",
  deny: "Deny",
  recommended: "Recommended",
  overdue: "Overdue",
  answered: "Answered",
  alreadyAnswered: "That was already answered.",
  mergeStep: "Merge this pull request on GitHub",
  openPr: "Open pull request",
};

const text = (v) => (typeof v === "string" ? v : "");

/** The line under the list when the cloud sent fewer asks than are waiting. */
export const notShownWords = (n) => (n === 1 ? "1 more isn't shown." : n + " more aren't shown.");

/** The provider link of a row: https on a host from the fixed list, no credentials or port; else null. */
export function providerLink(url) {
  if (typeof url !== "string" || url === "") return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    // fx-swallow-ok: an address that does not parse is simply not drawn as a link
    return null;
  }
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "" || u.port !== "" || !PROVIDER_HOSTS.includes(u.hostname)) return null;
  return { href: u.href, host: u.hostname };
}

/** One request of the read, or null when it is not usable. Every text field is a string. */
export function readRequest(r) {
  if (!r || typeof r.id !== "string" || r.id === "" || typeof r.title !== "string" || r.title === "" || !STATES.includes(r.state)) return null;
  return {
    kind: "setup",
    id: r.id,
    title: r.title,
    reason: text(r.reason),
    state: r.state,
    sentence: text(r.status_sentence),
    hasCheck: Number.isInteger(r.check_interval_seconds),
    link: providerLink(r.provider_url),
  };
}

const FENCE_START = "<<UNTRUSTED EXTERNAL CONTENT>>";
const FENCE_END = "<<END UNTRUSTED>>";

/** The agent's reason as plain text for a quotation: the cloud's untrusted-content fence is taken off the ends, nothing else is changed. */
export function quotedReason(raw) {
  let t = text(raw);
  if (t.startsWith(FENCE_START)) t = t.slice(FENCE_START.length);
  if (t.endsWith(FENCE_END)) t = t.slice(0, t.length - FENCE_END.length);
  return t.replace(/^\n/, "").replace(/\n$/, "");
}

/** One ask of the read, or null when it is not usable. Options keep only entries with a text id and name; `proposedLabel` is the recommended option's name. */
export function readAsk(a) {
  if (!a || typeof a.id !== "string" || a.id === "" || typeof a.label !== "string" || a.label === "" || !Array.isArray(a.options)) return null;
  const options = a.options.filter((o) => o && typeof o.id === "string" && o.id !== "" && typeof o.label === "string" && o.label !== "").map((o) => ({ id: o.id, label: o.label }));
  if (options.length === 0) return null;
  const proposed = options.find((o) => o.id === a.proposed);
  return {
    kind: "ask",
    id: a.id,
    title: a.label,
    reason: quotedReason(a.rationale),
    state: "open",
    overdue: a.state === "overdue",
    options,
    proposed: proposed ? proposed.id : "",
    proposedLabel: proposed ? proposed.label : "",
    sentence: "",
  };
}

/** The pull request link of a merge row: https on github.com, no credentials or port, a /pull/<number> path; else null. */
export function pullRequestLink(url) {
  if (typeof url !== "string" || url === "") return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    // fx-swallow-ok: an address that does not parse is simply not drawn as a link
    return null;
  }
  if (u.protocol !== "https:" || u.hostname !== "github.com" || u.username !== "" || u.password !== "" || u.port !== "" || !/^\/[^/]+\/[^/]+\/pull\/[0-9]+$/.test(u.pathname)) return null;
  return { href: u.href, host: u.hostname };
}

/** One item of the merge-ready read, or null when it is not usable. A row without a title is named by its pull request number; no text is ever null. */
export function readMerge(m) {
  if (!m || typeof m.work_item_id !== "string" || m.work_item_id === "" || !Number.isInteger(m.pr_number) || m.pr_number < 1) return null;
  const title = typeof m.title === "string" && m.title !== "" ? m.title : "Pull request #" + m.pr_number;
  return { kind: "merge", id: "merge-" + m.work_item_id, title, reason: text(m.why), state: "open", sentence: WORDS.mergeStep, link: pullRequestLink(m.pr_url) };
}

/** The sentence for a failed action, chosen by status; the server's own message is never shown. */
export function failureSentence(e) {
  if (isRateLimited(e)) return retryWords(waitSeconds(e));
  if (e && e.status === 403) return WORDS.onlyAdmins;
  if (e && e.status === 409 && e.code === "already_answered") return WORDS.alreadyAnswered;
  return WORDS.failed;
}

const cancelled = (e) => !!e && e.name === "AbortError";

/**
 * The list: the open requests the cloud returns, then the ones this person closed in this window, each showing its outcome (a request put back
 * by a failed check is open again and so is simply in the open part). `state` is { status, rows, truncated, announce, error }.
 */
export function createNeedsYou({ call = api, signal, onChange = () => {} } = {}) {
  let st = { status: "loading", rows: [], truncated: false, notShown: 0, announce: "", error: "" };
  const closed = new Map(); // id -> row closed here, shown until the window closes
  const busy = new Map(); // id -> "done" | "withdraw"
  let open = [];
  let gen = 0;
  const merge = () => {
    st = { ...st, rows: [...open, ...[...closed.values()].filter((c) => !open.some((o) => o.id === c.id))] };
  };

  async function load() {
    const mine = ++gen;
    try {
      // Both reads must answer: a screen that showed only one of them would say nothing is waiting while the other part is unread.
      const [data, asks, merges] = await Promise.all([call("GET", LIST_URL, undefined, signal), call("GET", ASKS_URL, undefined, signal), call("GET", MERGE_URL, undefined, signal)]);
      if (mine !== gen) return;
      if (!data || !Array.isArray(data.requests) || !asks || !Array.isArray(asks.asks) || !merges || !Array.isArray(merges.items)) throw new Error("shape");
      open = [...asks.asks.map(readAsk).filter(Boolean), ...merges.items.map(readMerge).filter(Boolean), ...data.requests.map(readRequest).filter((r) => r && r.state === "open")];
      for (const r of open) closed.delete(r.id);
      st = { ...st, status: "ready", truncated: data.truncated === true, notShown: [asks, merges].reduce((n, r) => n + (Number.isInteger(r.not_shown) && r.not_shown > 0 ? r.not_shown : 0), 0) };
      merge();
    } catch (e) {
      if (mine !== gen || cancelled(e)) return;
      if (st.status !== "ready") st = { ...st, status: "error" };
    }
    onChange();
  }

  /** verb: "done" (Mark done) or "withdraw". A second press while one is in flight is ignored. */
  async function act(id, verb) {
    if (busy.has(id)) return;
    busy.set(id, verb);
    st = { ...st, error: "", announce: "" };
    onChange();
    try {
      const row = readRequest(await call("POST", actionUrl(id, verb), undefined, signal));
      if (!row) throw new Error("shape");
      open = open.filter((r) => r.id !== id);
      closed.delete(id);
      if (row.state === "open") open = [row, ...open];
      else closed.set(id, row);
      st = { ...st, announce: row.sentence };
      merge();
    } catch (e) {
      busy.delete(id);
      if (cancelled(e)) return;
      st = { ...st, error: failureSentence(e) };
      await load(); // a refused action may mean the request changed under the person: show what is true now
      return;
    }
    busy.delete(id);
    onChange();
  }

  /**
   * Answers an ask with one of its option ids or "deny". A second press while one is in flight is ignored, and a choice the ask does not list is not sent.
   * The answer is final: the ask leaves the open part and shows who it was answered with, until the window closes. Any refusal is a fixed sentence, then a re-read.
   */
  async function answer(id, choice) {
    const row = open.find((r) => r.id === id && r.kind === "ask");
    if (!row || busy.has(id)) return;
    if (choice !== "deny" && !row.options.some((o) => o.id === choice)) return;
    busy.set(id, "answer");
    st = { ...st, error: "", announce: "" };
    onChange();
    try {
      const res = await call("POST", answerUrl(id), { choice }, signal);
      if (!res || typeof res.answered_option !== "string") throw new Error("shape");
      const picked = row.options.find((o) => o.id === res.answered_option);
      const name = picked ? picked.label : WORDS.deny;
      open = open.filter((r) => r.id !== id);
      closed.set(id, { ...row, state: "done", sentence: WORDS.answered + ": " + name });
      st = { ...st, announce: WORDS.answered + ": " + name + "." };
      merge();
    } catch (e) {
      busy.delete(id);
      if (cancelled(e)) return;
      st = { ...st, error: failureSentence(e) };
      await load(); // a refused answer may mean the ask changed under the person: show what is true now
      return;
    }
    busy.delete(id);
    onChange();
  }

  /** The app has put the announcement on the page: it is said once, so it is not kept for the next draw. Does not redraw. */
  const clearAnnounce = () => {
    st = { ...st, announce: "" };
  };

  let stopFn = null;
  /**
   * Reads again on the live stream's refresh and every REFRESH_MS, but not while the page is hidden. `subscribe(handler)` returns its off function.
   * Starting twice replaces the first. Nothing is left running after stop().
   */
  function start({ subscribe, setTimer = setInterval, clearTimer = clearInterval, hidden = () => false } = {}) {
    stop();
    const off = typeof subscribe === "function" ? subscribe(() => load()) : () => {};
    const timer = setTimer(() => {
      if (!hidden()) load();
    }, REFRESH_MS);
    stopFn = () => {
      off();
      clearTimer(timer);
    };
  }
  function stop() {
    if (stopFn) stopFn();
    stopFn = null;
  }

  return { load, act, answer, start, stop, clearAnnounce, anyBusy: () => busy.size > 0, busyVerb: (id) => busy.get(id) || "", get state() { return st; } };
}
