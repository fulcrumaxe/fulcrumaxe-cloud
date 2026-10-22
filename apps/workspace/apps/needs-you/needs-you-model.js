// D#598 P8c: the Needs you list's logic, with no DOM (unit-tested with a fake call()). The page is needs-you-app.js.
//
// A row is one setup request (GET /api/v1/setup-requests). The cloud writes every sentence about a request's check: `status_sentence` and
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
};

const text = (v) => (typeof v === "string" ? v : "");

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
    id: r.id,
    title: r.title,
    reason: text(r.reason),
    state: r.state,
    sentence: text(r.status_sentence),
    hasCheck: Number.isInteger(r.check_interval_seconds),
    link: providerLink(r.provider_url),
  };
}

/** The sentence for a failed action, chosen by status; the server's own message is never shown. */
export function failureSentence(e) {
  if (isRateLimited(e)) return retryWords(waitSeconds(e));
  if (e && e.status === 403) return WORDS.onlyAdmins;
  return WORDS.failed;
}

const cancelled = (e) => !!e && e.name === "AbortError";

/**
 * The list: the open requests the cloud returns, then the ones this person closed in this window, each showing its outcome (a request put back
 * by a failed check is open again and so is simply in the open part). `state` is { status, rows, truncated, announce, error }.
 */
export function createNeedsYou({ call = api, signal, onChange = () => {} } = {}) {
  let st = { status: "loading", rows: [], truncated: false, announce: "", error: "" };
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
      const data = await call("GET", LIST_URL, undefined, signal);
      if (mine !== gen) return;
      if (!data || !Array.isArray(data.requests)) throw new Error("shape");
      open = data.requests.map(readRequest).filter((r) => r && r.state === "open");
      for (const r of open) closed.delete(r.id);
      st = { ...st, status: "ready", truncated: data.truncated === true };
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

  return { load, act, start, stop, clearAnnounce, anyBusy: () => busy.size > 0, busyVerb: (id) => busy.get(id) || "", get state() { return st; } };
}
