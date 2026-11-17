// D#598 P8c: the Needs you list's logic, with no DOM (unit-tested with a fake call()). The page is needs-you-app.js.
//
// A row is a work item that stopped on its own (GET /api/v1/stalled-items: what stopped in the cloud's words, and one button that does what the card's top button
// does, POST /api/v1/work-items/{id}/approve; the cloud drops the row when the item moves), a pull request waiting for a person to merge it
// (GET /api/v1/merge-ready, D#598 P8c-2b: a link to GitHub, no buttons; the cloud drops it when the
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

// The open requests, plus the "someone pushed" ones a person answered with Keep whose branch is still marked as managed (so the undo stays on the list).
export const LIST_URL = "/api/v1/setup-requests?state=needs_you";
// The done and withdraw routes take no request body at all (the API answers 400 to any body), so these two POSTs are sent bare.
export const actionUrl = (id, verb) => "/api/v1/setup-requests/" + encodeURIComponent(id) + "/" + verb;
/** The undo of Keep: clears "Public branch managed by a person" for one item. */
export const releaseUrl = (workItemId) => "/api/v1/work-items/" + encodeURIComponent(workItemId) + "/public-branch/release";
export const ASKS_URL = "/api/v1/decision-asks";
export const answerUrl = (id) => "/api/v1/decision-asks/" + encodeURIComponent(id) + "/answer";
/** The asks arrive in pages (API-1 cursor); this many pages are read before the screen says the rest are not shown. */
export const MAX_ASK_PAGES = 5;
export const ASKS_FIRST_URL = ASKS_URL + "?limit=200";
export const MERGE_URL = "/api/v1/merge-ready";
export const STALLED_URL = "/api/v1/stalled-items";
/** D#749: the repositories whose post-merge check needs the checking account signed in again on a runner. */
export const SIGN_IN_URL = "/api/v1/verify-sign-in";
/** Work items that need a person: read page by page like the asks, so an item the stalled list does not carry still has a row. */
export const NEEDS_HUMAN_URL = "/api/v1/work-items?stage=needs_human&limit=200";
export const ME_URL = "/api/cloud/auth/me";
/** The live events that make the list read again (C28 rule (i): the shell's one stream, no new subscription). */
export const LIVE_EVENTS = ["decision.ask_answered", "decision.ask_overdue", "work_item.needs_human", "work_item.stage_changed", "work_item.closed", "pr.opened"];
/**
 * EB-6c: the engine's open asks, read through the engine bridge's read API (ids, enums and times only; nothing the engine wrote as free text).
 * `engine.changed` is its own live event (ids only): it reads only the engine asks, 1 s after the first event, so a burst is one read.
 */
export const ENGINE_REPOS_URL = "/api/v1/engine/repos";
export const engineAsksUrl = (repoId) => "/api/v1/engine/repos/" + encodeURIComponent(repoId) + "/asks?state=open&limit=200";
export const ENGINE_CHANGED = "engine.changed";
export const ENGINE_DEBOUNCE_MS = 1000;
export const ENGINE_MAX_REPOS = 20;
export const ENGINE_MAX_PAGES = 3;
/** An ask raised longer ago than this says it may be stale. */
export const ENGINE_STALE_ASK_MS = 7 * 24 * 3600 * 1000;
/** L2: the machine is "last seen" once it has been quiet longer than this; a source older than its limit says so (the asks come from the team log). */
export const ENGINE_HEARTBEAT_STALE_S = 180;
export const ENGINE_TEAM_LOG_LIMIT_S = 2 * 3600;
/** The card's top button: the approve route. The id is encoded; no body goes with it (the route takes none). */
export const approveUrl = (id) => "/api/v1/work-items/" + encodeURIComponent(id) + "/approve";
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
  moreAsks: "More decisions are waiting than this list shows.",
  moreItems: "More items need a person than this list shows.",
  waitingAdmin: "Waiting for an owner or admin to answer.",
  personSentence: "This item needs a person. Open its card to see why and choose what happens next.",
  open: "Open",
  entry: "Needs you",
  entryNone: "Nothing needs you",
  proceedUnnamed: "If nobody answers in time, the agent goes ahead with its recommended option.",
  stopOpen: "If nobody answers in time, the work stays paused until someone answers.",
  stopOverdue: "The work is paused until someone answers.",
  planStopOpen: "If nobody answers in time, this run is not started on that plan.",
  planStopOverdue: "This run is not started on that plan until it is answered.",
  markDone: "Mark done",
  withdraw: "Withdraw",
  keep: "Keep their version",
  replace: "Replace with this item's version",
  replaceYes: "Yes, replace it",
  cancel: "Cancel",
  release: "Let the cloud update it again",
  headMoved: "The branch moved again, so nothing was replaced. The new head is shown; check it and choose again.",
  replaceQueued: "Done. Their version is replaced the next time the item publishes an update. Until then you can still keep it instead.",
  branchAnswered: "That request was already answered another way, so your choice was not applied. The list now shows what is current.",
  keptNotManaged: "Done. The pull request is no longer open on this branch, so nothing is marked as managed.",
  released: "The cloud can update this branch again.",
  releasedNothing: "Nothing was marked as managed any more.",
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
  raiseOverBudget: "That limit is more than your account can still spend this month, so it was not raised. Nothing changed; the question is still here.",
  raiseConflict: "The limit was changed at the same moment, so it was not raised. Look at the new limit and answer again.",
  raiseStale: "The limit on this item changed after this question was asked, so this answer no longer applies. Nothing changed. Check the item's limit, or stop the item.",
  raiseUnavailable: "This item no longer has a spend limit to raise. Nothing changed.",
  runMovedOn: "That run has already moved on, so there is nothing to answer.",
  runnerGone: "You have no live runner on your plan that lists this repository (it may have been removed, or never set up), so this run can't start on your plan. Add the repository to a runner on your plan, or set one up, then say yes again. Nothing was started.",
  mergeStep: "Merge this pull request on GitHub",
  signInWaiting: "A check of a merged change is waiting for the checking account to be signed in again on the runner. It runs by itself once the runner has a fresh sign-in. Run this on the runner's machine:",
  signInExpired: "The checking account's saved sign-in on the runner has ended, so the next check of this repository would not be made. Run this on the runner's machine:",
  signInMissing: "The runner has no saved sign-in for the checking account, so the next check of this repository would not be made. Run this on the runner's machine:",
  signInExpiring: "The checking account's saved sign-in on the runner ends within two hours. Run this on the runner's machine before then:",
  signInRepo: "A repository",
  openPr: "Open pull request",
  stalledStarted: "Started. The card moves when it is done.",
  stalledGone: "This item has moved on, so there is nothing to start. Open its card to see where it is.",
  stalledBusy: "The agents are already working on this one.",
  stalledNoAction: "Open this item's card to choose what happens next.",
  startedByAnswer: "Started. The card moves when it is done.",
  heldByAnswer: "Held. Nothing starts until a person starts it from the card.",
  engineError: "Engine asks could not be loaded",
  moreEngine: "More engine asks are waiting than this list shows.",
  engineRepo: "A repository",
  engineStale: "This ask is over 7 days old and may be stale.",
  engineNoHeartbeat: "The machine has not been heard from; this ask may already be answered.",
};

/** One fixed sentence per kind of engine ask (the enum is never shown). An ask kind this page does not know reads as "other". */
export const ENGINE_KIND_WORDS = {
  owner_decision: "The engine is waiting for you to decide something.",
  merge_blocked: "The engine cannot merge a pull request until you step in.",
  credential: "The engine needs a login or a key from you.",
  budget: "The engine stopped on a spending limit and needs you.",
  review_blocked: "A review is blocked until you step in.",
  decision: "The engine is asking you to approve or decline a step.",
  other: "The engine raised a question that needs you.",
};
export const engineKindWords = (kind) => (typeof kind === "string" && Object.hasOwn(ENGINE_KIND_WORDS, kind) ? ENGINE_KIND_WORDS[kind] : ENGINE_KIND_WORDS.other);

const DUE_FORMAT = { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
const dueMs = (iso) => (typeof iso === "string" ? Date.parse(iso) : NaN);

/** `answer_due_at` in the viewer's time zone, or "" when it is missing or does not parse (never "Invalid Date"). */
export function dueTime(iso) {
  const ms = dueMs(iso);
  return Number.isFinite(ms) ? new Intl.DateTimeFormat(undefined, DUE_FORMAT).format(new Date(ms)) : "";
}

/** A member-plan ask waits for its plan holder alone (D#7 DW-R7): the name is theirs, never an id. */
export const waitingHolderWords = (name) => "Waiting for " + name + " to answer. It is their Claude plan, so only they can say yes or no.";

/** The sentence for an ask that goes ahead with its recommended option when nobody answers. */
export const proceedWords = (name) => "If nobody answers in time, the agent goes ahead with: " + name + ".";

/** What happens if nobody answers, from `timeout_outcome`; "" when there is nothing to say. */
export function timeoutSentence(outcome, overdue, proposedLabel, plan = false) {
  if (outcome === "stop_and_flag" && plan) return overdue ? WORDS.planStopOverdue : WORDS.planStopOpen;
  if (outcome === "proceed_recommended") return overdue ? "" : proposedLabel ? proceedWords(proposedLabel) : WORDS.proceedUnnamed;
  if (outcome === "stop_and_flag") return overdue ? WORDS.stopOverdue : WORDS.stopOpen;
  return "";
}

/** The decision types a start gate raises asks for (D#7 start gate). An answer to one of these starts the item or holds it; any other ask keeps the generic "Answered" words. */
export const START_ASK_TYPES = ["start_work_small", "start_work_bug", "start_work_doc", "start_parent_item", "start_after_reclassify"];
/** The sentence after a start ask is answered: the id `start` starts the item, every other choice (the second option, or Deny) holds it. */
export const startAnswerWords = (choice) => (choice === "start" ? WORDS.startedByAnswer : WORDS.heldByAnswer);

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

/** A commit id is shown by its first twelve characters, enough to tell two heads apart; a value that is not a commit id is not shown. */
export const shortHead = (v) => (typeof v === "string" && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(v) ? v.slice(0, 12) : "");
export const nowAtWords = (head) => (shortHead(head) === "" ? "" : "The branch is now at " + shortHead(head) + ".");
export const confirmWords = (head) => "This puts the item's version over what was pushed" + (shortHead(head) === "" ? "" : " (the branch is at " + shortHead(head) + ")") + ". If someone pushes again before the update, nothing is overwritten and you are asked again. Replace it?";
export const isBranchRow = (row) => row.setupKind === "branch_pushed_by_person";

/** Whether the row offers Mark done: a "someone pushed to the branch" request is not answered by it (the API refuses it), so no button is drawn. */
export const canMarkDone = (row) => row.setupKind !== "branch_pushed_by_person";

/** One request of the read, or null when it is not usable. Every text field is a string. */
export function readRequest(r) {
  if (!r || typeof r.id !== "string" || r.id === "" || typeof r.title !== "string" || r.title === "" || !STATES.includes(r.state)) return null;
  return {
    kind: "setup",
    // The kind of the request, as the API names it: "someone pushed to the branch" is not answered by Mark done.
    setupKind: typeof r.kind === "string" ? r.kind : "",
    id: r.id,
    title: r.title,
    reason: text(r.reason),
    state: r.state,
    sentence: text(r.status_sentence),
    hasCheck: Number.isInteger(r.check_interval_seconds),
    link: providerLink(r.provider_url),
    workItemId: typeof r.work_item_id === "string" ? r.work_item_id : "",
    seenHead: shortHead(r.seen_head) === "" ? "" : r.seen_head,
    branchManaged: r.branch_managed === true,
    replacePending: r.replace_pending === true,
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
  const overdue = a.state === "overdue";
  const due = dueTime(a.answer_due_at);
  return {
    kind: "ask",
    startAsk: START_ASK_TYPES.includes(a.decision_type),
    id: a.id,
    workItemId: text(a.work_item_id),
    due: due === "" ? "" : (overdue ? "Was due " : "Answer by ") + due,
    dueMs: dueMs(a.answer_due_at),
    timeout: timeoutSentence(a.timeout_outcome, overdue, proposed ? proposed.label : "", a.decision_type === "runner_run_on_member_plan"),
    title: a.label,
    reason: quotedReason(a.rationale),
    state: "open",
    overdue,
    options,
    proposed: proposed ? proposed.id : "",
    proposedLabel: proposed ? proposed.label : "",
    // D#7 DW-R7: a "run on a member's plan" ask is answered by that person alone; the cloud says whose plan it is and whether the viewer is them.
    ...(a.plan_holder && typeof a.plan_holder.name === "string" && a.plan_holder.name !== "" ? { planHolder: { name: a.plan_holder.name, isYou: a.plan_holder.is_you === true } } : {}),
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
  return { kind: "merge", id: "merge-" + m.work_item_id, workItemId: m.work_item_id, title, reason: text(m.why), state: "open", sentence: WORDS.mergeStep, link: pullRequestLink(m.pr_url) };
}

const SIGN_IN_SENTENCES = { waiting: "signInWaiting", expired: "signInExpired", missing: "signInMissing", expiring_soon: "signInExpiring" };
/** The one command a sign-in row shows: the fixed words and an address of https (or http on a loopback host) with nothing after it that could start another command. */
const SIGN_IN_COMMAND = /^fx-runner verify-login --base-url https?:\/\/[A-Za-z0-9.\-:]+(?:\/[A-Za-z0-9._~\-/]*)?$/;

/** One item of the verify-sign-in read, or null when it is not usable (an unknown kind, or a command that is not the fixed one). The repository name is untrusted text: shown as text only. */
export function readSignIn(m) {
  if (!m || typeof m.repo_id !== "string" || m.repo_id === "" || !Object.hasOwn(SIGN_IN_SENTENCES, m.kind)) return null;
  if (typeof m.command !== "string" || m.command.length > 300 || !SIGN_IN_COMMAND.test(m.command)) return null;
  const id = "signin-" + m.repo_id;
  return { kind: "signin", id, workItemId: id, title: typeof m.repo === "string" && m.repo !== "" ? m.repo : WORDS.signInRepo, reason: "", state: "open", sentence: WORDS[SIGN_IN_SENTENCES[m.kind]], command: m.command, sinceMs: dueMs(m.since) };
}

/**
 * The sign-in rows' read. It is the one read of this list that may fail without failing the list: it is a warning beside the other rows, and a cloud that has not got the route yet (it is
 * deployed before the page that asks) or a read that fails once must not blank the decisions and pull requests a person has to act on. A failed or malformed read is no sign-in rows. A
 * cancelled read still cancels.
 */
async function readSignInItems(call, signal) {
  try {
    const res = await call("GET", SIGN_IN_URL, undefined, signal);
    return res && Array.isArray(res.items) ? res.items : [];
  } catch (e) {
    if (cancelled(e)) throw e;
    // fx-swallow-ok: the warning rows are optional (see above); every other read of the list still fails the list
    return [];
  }
}

/**
 * One item of the stalled read, or null when it is not usable. `why` and `action_label` are the cloud's own sentences. A row the caller may not act on, or
 * whose stage has no automatic step, has no button (`action` is ""), and says to open the card instead.
 */
export function readStalled(m) {
  if (!m || typeof m.work_item_id !== "string" || m.work_item_id === "") return null;
  const title = typeof m.title === "string" && m.title !== "" ? m.title : "Work item";
  const label = typeof m.action_label === "string" ? m.action_label : "";
  const canAct = m.can_act === true && label !== "";
  return {
    kind: "stalled",
    id: "stalled-" + m.work_item_id,
    workItemId: m.work_item_id,
    sinceMs: dueMs(m.since),
    title,
    reason: text(m.why),
    state: "open",
    sentence: canAct ? "" : WORDS.stalledNoAction,
    action: canAct ? label : "",
  };
}

/** One needs_human work item, or null when it is not usable. The title is untrusted text; a row without one is "Work item". */
export function readPerson(w) {
  if (!w || typeof w.id !== "string" || w.id === "") return null;
  return { kind: "person", id: "person-" + w.id, workItemId: w.id, title: typeof w.title === "string" && w.title !== "" ? w.title : "Work item", reason: "", state: "open", sentence: WORDS.personSentence, sinceMs: dueMs(w.updated_at) };
}

const ms = (n) => (Number.isFinite(n) ? n : Infinity);

/**
 * One row per work item, in one fixed order. Precedence: open ask, stalled row, needs-a-person row, merge row (a second ask of one item is a
 * second decision, so asks are all kept). Order: asks (overdue first, then due time, then id), then stalled and needs-a-person rows together
 * oldest first, then merge rows, then setup requests. Sorts are stable, so the server's order breaks every remaining tie.
 */
export function arrangeRows({ asks, stalled, people, merges, requests, signIns = [], engine = [] }) {
  const taken = new Set(asks.map((a) => a.workItemId));
  const fresh = (rows) => rows.filter((r) => !taken.has(r.workItemId) && taken.add(r.workItemId));
  const s = fresh(stalled);
  const p = fresh(people);
  const m = fresh(merges);
  const sortedAsks = [...asks].sort((a, b) => Number(b.overdue) - Number(a.overdue) || ms(a.dueMs) - ms(b.dueMs) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const person = [...s, ...p].sort((a, b) => ms(a.sinceMs) - ms(b.sinceMs));
  return [...sortedAsks, ...person, ...signIns, ...engine, ...m, ...requests];
}

/** The sentence for a failed action, chosen by status; the server's own message is never shown. */
export function failureSentence(e) {
  if (isRateLimited(e)) return retryWords(waitSeconds(e));
  if (e && e.status === 403) return WORDS.onlyAdmins;
  if (e && e.status === 409 && e.code === "already_answered") return WORDS.alreadyAnswered;
  if (e && e.status === 409 && e.code === "runner_gone") return WORDS.runnerGone;
  if (e && e.status === 409 && e.code === "raise_over_budget") return WORDS.raiseOverBudget;
  if (e && e.status === 409 && e.code === "raise_conflict") return WORDS.raiseConflict;
  if (e && e.status === 409 && e.code === "raise_stale") return WORDS.raiseStale;
  if (e && e.status === 409 && e.code === "raise_unavailable") return WORDS.raiseUnavailable;
  if (e && e.status === 409 && e.code === "run_moved_on") return WORDS.runMovedOn;
  return WORDS.failed;
}

/** The sentence for a refused press of a stalled row's button: the approve route's own refusals have their own words; the rest are the common ones. */
export function stalledFailureSentence(e) {
  if (e && e.status === 409 && e.code === "already_running") return WORDS.stalledBusy;
  if (e && (e.status === 404 || (e.status === 409 && e.code === "not_approvable"))) return WORDS.stalledGone;
  return failureSentence(e);
}

const cancelled = (e) => !!e && e.name === "AbortError";

/** Reads a cursor-paged list (`data`, `next_cursor`) up to MAX_ASK_PAGES pages. `more` is true when the page limit was reached with more still waiting. A page of the wrong shape is an error, not an empty list. */
export async function readPages(call, firstUrl, signal) {
  const data = [];
  let url = firstUrl;
  for (let page = 0; page < MAX_ASK_PAGES; page += 1) {
    const res = await call("GET", url, undefined, signal);
    if (!res || !Array.isArray(res.data) || !(res.next_cursor === null || typeof res.next_cursor === "string")) throw new Error("shape");
    data.push(...res.data);
    if (res.next_cursor === null) return { data, more: false };
    url = firstUrl + "&cursor=" + encodeURIComponent(res.next_cursor);
  }
  return { data, more: true };
}

const GITHUB_NAME = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;

/** A link to a Discussion (`segment` "discussions") or a pull request ("pull") of a repo, built from the cloud's own repo name; null when the name or number is not usable. */
export function engineLink(fullName, segment, n) {
  if (typeof fullName !== "string" || !GITHUB_NAME.test(fullName) || !Number.isInteger(n) || n < 1) return null;
  const [owner, name] = fullName.split("/");
  if (owner === "." || owner === ".." || name === "." || name === "..") return null;
  return { href: "https://github.com/" + owner + "/" + name + "/" + segment + "/" + n, text: (segment === "pull" ? "PR #" : "D#") + n };
}

/** One engine ask of a repo's read, or null when it is not usable. `env` is the read's envelope (as_of, heard_age_s, source_ages_s); `readAt` is when it was read. */
export function readEngineAsk(repo, env, a, readAt) {
  if (!a || typeof a.ask_id !== "string" || a.ask_id === "" || a.ask_id.length > 64) return null;
  const raisedMs = dueMs(a.raised_at);
  if (!Number.isFinite(raisedMs)) return null;
  const asOfMs = dueMs(env.as_of);
  const teamLog = env.source_ages_s && Number.isFinite(env.source_ages_s.team_log) ? env.source_ages_s.team_log : null;
  return {
    kind: "engine",
    id: "engine-" + repo.repo_id + "-" + a.ask_id,
    workItemId: "",
    // The repo's name is a cloud-side name that a person typed on GitHub: the page puts it in <bdi>.
    title: repo.full_name !== "" ? repo.full_name : WORDS.engineRepo,
    reason: "",
    state: "open",
    sentence: engineKindWords(a.ask_kind),
    links: [engineLink(repo.full_name, "discussions", a.discussion), engineLink(repo.full_name, "pull", a.pr)].filter(Boolean),
    raisedMs,
    asOfMs: Number.isFinite(asOfMs) ? asOfMs : readAt,
    heardAgeS: Number.isFinite(env.heard_age_s) ? env.heard_age_s : null,
    teamLogAgeS: teamLog,
    readAt,
  };
}

const wholeMinutes = (s) => Math.max(0, Math.floor(s / 60));
/** "N min" under two hours, "N h" under two days, else "N days"; the time since something, never negative. */
export function ageWords(seconds) {
  const m = wholeMinutes(Number.isFinite(seconds) ? seconds : 0);
  if (m < 120) return m + " min";
  if (m < 2880) return Math.floor(m / 60) + " h";
  return Math.floor(m / 1440) + " days";
}
const CLOCK = { hour: "2-digit", minute: "2-digit" };
/** The sentences an engine row shows about its own age and its data's age (L2), worked out at draw time so they stay true between reads. "" means there is nothing to say. */
export function engineWords(row, now = Date.now()) {
  const sinceRaised = (now - row.raisedMs) / 1000;
  const heard = row.heardAgeS === null ? null : row.heardAgeS + Math.max(0, now - row.readAt) / 1000;
  const teamLog = row.teamLogAgeS === null ? null : row.teamLogAgeS + Math.max(0, now - row.readAt) / 1000;
  return {
    raised: sinceRaised < 60 ? "Raised just now" : "Raised " + ageWords(sinceRaised) + " ago",
    stale: now - row.raisedMs > ENGINE_STALE_ASK_MS ? WORDS.engineStale : "",
    asOf: "As of " + new Intl.DateTimeFormat(undefined, CLOCK).format(new Date(row.asOfMs)) + " (" + ageWords((now - row.asOfMs) / 1000) + " ago)",
    machine: heard === null ? WORDS.engineNoHeartbeat : heard > ENGINE_HEARTBEAT_STALE_S ? "Machine last seen " + ageWords(heard) + " ago; this ask may already be answered." : "",
    source: teamLog !== null && teamLog > ENGINE_TEAM_LOG_LIMIT_S ? "Team log not updated for " + Math.floor(teamLog / 3600) + " h." : "",
  };
}

/** One repo's open asks, page by page up to ENGINE_MAX_PAGES. The first page's envelope speaks for the repo's freshness. */
async function readRepoAsks(call, repo, signal) {
  const first = engineAsksUrl(repo.repo_id);
  const items = [];
  let env = null;
  let url = first;
  for (let page = 0; page < ENGINE_MAX_PAGES; page += 1) {
    const res = await call("GET", url, undefined, signal);
    if (!res || !Array.isArray(res.items) || !(res.next_cursor === null || typeof res.next_cursor === "string")) throw new Error("shape");
    env ||= res;
    items.push(...res.items);
    if (res.next_cursor === null) return { env, items, more: false };
    url = first + "&cursor=" + encodeURIComponent(res.next_cursor);
  }
  return { env, items, more: true };
}

const byAge = (a, b) => a.raisedMs - b.raisedMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The engine's open asks, as rows. This read never fails the list: a failed read is `failed: true` and the rows of the last good read of that repo stay (their age
 * then shows how old they are). A cloud without the engine routes (404 on the repo list) has no engine asks and no error. A cancelled read still cancels.
 * `cache` (repo id -> rows) is the caller's, kept between reads.
 */
export async function readEngine(call, signal, cache, now = Date.now()) {
  let repos;
  try {
    const res = await call("GET", ENGINE_REPOS_URL, undefined, signal);
    if (!res || !Array.isArray(res.items)) throw new Error("shape");
    repos = res.items.filter((r) => r && typeof r.repo_id === "string" && r.repo_id !== "" && typeof r.full_name === "string" && r.watch_enabled !== false).map((r) => ({ repo_id: r.repo_id, full_name: r.full_name }));
  } catch (e) {
    if (cancelled(e)) throw e;
    if (e && e.status === 404) {
      cache.clear();
      return { rows: [], failed: false, more: false };
    }
    return { rows: [...cache.values()].flat().sort(byAge), failed: true, more: false };
  }
  const listed = repos.slice(0, ENGINE_MAX_REPOS);
  for (const id of [...cache.keys()]) if (!listed.some((r) => r.repo_id === id)) cache.delete(id);
  const readAt = now;
  const settled = await Promise.allSettled(listed.map((r) => readRepoAsks(call, r, signal)));
  let failed = false;
  let more = repos.length > ENGINE_MAX_REPOS;
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") {
      more = more || s.value.more;
      cache.set(listed[i].repo_id, s.value.items.map((a) => readEngineAsk(listed[i], s.value.env, a, readAt)).filter(Boolean));
    } else if (cancelled(s.reason)) {
      throw s.reason;
    } else if (s.reason && s.reason.status === 404) {
      cache.delete(listed[i].repo_id); // the repo is no longer ticked
    } else {
      failed = true;
    }
  });
  return { rows: [...cache.values()].flat().sort(byAge), failed, more };
}

/** Puts engine rows into an arranged list: after the rows that come before them in arrangeRows (asks, stalled, needs-a-person, sign-in), before the merge rows and requests. */
export function insertEngine(rows, engine) {
  const rest = rows.filter((r) => r.kind !== "engine");
  const at = rest.findIndex((r) => r.kind === "merge" || r.kind === "setup");
  return at < 0 ? [...rest, ...engine] : [...rest.slice(0, at), ...engine, ...rest.slice(at)];
}

/** What a person hears when the engine asks change between two reads: "" when nothing changed. Counts only, never text from an ask. */
export function engineChangeWords(before, after, wasFailed, nowFailed) {
  const added = after.filter((id) => !before.includes(id)).length;
  const gone = before.filter((id) => !after.includes(id)).length;
  const parts = [];
  if (added > 0) parts.push(added === 1 ? "1 new engine ask." : added + " new engine asks.");
  if (gone > 0) parts.push(gone === 1 ? "1 engine ask cleared." : gone + " engine asks cleared.");
  if (nowFailed && !wasFailed) parts.push(WORDS.engineError + ".");
  return parts.join(" ");
}

/** The five reads behind the list, and the rows they make (the one place the row rules live; the Pipeline board's count calls it too). Any failed read rejects. */
export async function readAll(call, signal, engineCache = new Map(), now = Date.now()) {
  const [data, asks, merges, stalled, items, signIn, engine] = await Promise.all([call("GET", LIST_URL, undefined, signal), readPages(call, ASKS_FIRST_URL, signal), call("GET", MERGE_URL, undefined, signal), call("GET", STALLED_URL, undefined, signal), readPages(call, NEEDS_HUMAN_URL, signal), readSignInItems(call, signal), readEngine(call, signal, engineCache, now)]);
  if (!data || !Array.isArray(data.requests) || !merges || !Array.isArray(merges.items) || !stalled || !Array.isArray(stalled.items)) throw new Error("shape");
  const rows = arrangeRows({
    asks: asks.data.map(readAsk).filter(Boolean),
    stalled: stalled.items.map(readStalled).filter(Boolean),
    people: items.data.map(readPerson).filter(Boolean),
    merges: merges.items.map(readMerge).filter(Boolean),
    signIns: signIn.map(readSignIn).filter(Boolean),
    engine: engine.rows,
    requests: data.requests.map(readRequest).filter((r) => r && (r.state === "open" || r.branchManaged || r.replacePending)),
  });
  const notShown = [merges, stalled].reduce((n, r) => n + (Number.isInteger(r.not_shown) && r.not_shown > 0 ? r.not_shown : 0), 0);
  return { rows, truncated: data.truncated === true, moreAsks: asks.more, moreItems: items.more, notShown, engineFailed: engine.failed, engineMore: engine.more };
}

/** The Pipeline board's number: the same reads and row rules as the list. `more` is true when a page cap was reached or rows are not shown. */
export async function readNeedsYouCount(call = api, signal) {
  const r = await readAll(call, signal);
  // A line that only offers the undo of an answer (Keep, or a Replace waiting for its update) is not something that needs a person, so it is not counted.
  return { count: r.rows.filter((row) => !row.branchManaged && !row.replacePending).length + r.notShown, more: r.moreAsks || r.moreItems || r.notShown > 0 || r.engineFailed || r.engineMore };
}

/** The board button's words: no number while the count is unknown (loading or failed). */
export function entryLabel(c) {
  if (!c) return WORDS.entry;
  if (c.count === 0 && !c.more) return WORDS.entryNone;
  return WORDS.entry + " (" + c.count + (c.more ? "+" : "") + ")";
}

/**
 * The list: the open requests the cloud returns, then the ones this person closed in this window, each showing its outcome (a request put back
 * by a failed check is open again and so is simply in the open part). `state` is { status, rows, truncated, announce, error }.
 */
export function createNeedsYou({ call = api, signal, onChange = () => {}, now = Date.now } = {}) {
  let st = { status: "loading", rows: [], truncated: false, moreAsks: false, moreItems: false, notShown: 0, engineFailed: false, engineMore: false, isAdmin: false, announce: "", focusId: null, focusAct: null, error: "" };
  // EB-6c: the engine asks' last good read per repo, and the ids heard about last (null until the first read, so the first draw says nothing).
  const engineCache = new Map();
  let engineSeen = null;
  /** The engine part of a read, added to the state: what changed is said once, and the first read says nothing. */
  const takeEngine = (rows, failed, more) => {
    const ids = rows.map((r) => r.id);
    // The first read says nothing about the asks (they are just there), but a failed first read is said: the line it leaves is easy to miss.
    const said = engineSeen === null ? (failed ? WORDS.engineError + "." : "") : engineChangeWords(engineSeen, ids, st.engineFailed, failed);
    engineSeen = ids;
    st = { ...st, engineFailed: failed, engineMore: more, announce: said === "" ? st.announce : st.announce === "" ? said : st.announce + " " + said };
  };
  // Who may answer is read once per window open, beside the first list read. A failed read means "not an admin", never the list's error.
  let adminRead = null;
  const keys = new Map(); // ask id -> { choice, key }: the Idempotency-Key of an answer that has not settled yet
  const closed = new Map(); // id -> row closed here, shown until the window closes
  const busy = new Map(); // id -> "done" | "withdraw" | "keep" | "replace" | "release"
  const confirming = new Map(); // id -> the head the person is being asked to replace (what is on screen)
  let open = [];
  let gen = 0;
  const merge = () => {
    st = { ...st, rows: [...open, ...[...closed.values()].filter((c) => !open.some((o) => o.id === c.id))] };
  };

  async function load() {
    const mine = ++gen;
    try {
      // Every read must answer: a screen that showed only some of them would say nothing is waiting while another part is unread.
      adminRead ||= Promise.resolve(call("GET", ME_URL, undefined, signal)).then((me) => !!me && me.is_admin === true, () => false);
      const [all, isAdmin] = await Promise.all([readAll(call, signal, engineCache, now()), adminRead]);
      if (mine !== gen) return;
      open = all.rows;
      for (const r of open) closed.delete(r.id);
      // A confirmation is only valid for the head it was shown with: if the request has moved on, or is gone, the question is withdrawn and the new head is on screen.
      for (const [cid, head] of [...confirming]) {
        const now = open.find((r) => r.id === cid);
        if (!now || now.seenHead !== head) {
          confirming.delete(cid);
          if (now) st = { ...st, announce: WORDS.headMoved };
        }
      }
      st = { ...st, status: "ready", isAdmin, truncated: all.truncated, moreAsks: all.moreAsks, moreItems: all.moreItems, notShown: all.notShown };
      takeEngine(all.rows.filter((r) => r.kind === "engine"), all.engineFailed, all.engineMore);
      merge();
    } catch (e) {
      if (mine !== gen || cancelled(e)) return;
      if (st.status !== "ready") st = { ...st, status: "error" };
    }
    onChange();
  }

  /** EB-6c: reads only the engine asks (on `engine.changed`) and swaps them into the list. A full read that started after this one began wins. */
  async function loadEngine() {
    const mine = gen;
    try {
      const eng = await readEngine(call, signal, engineCache, now());
      if (mine !== gen || st.status !== "ready") return;
      open = insertEngine(open, eng.rows);
      takeEngine(eng.rows, eng.failed, eng.more);
      merge();
    } catch (e) {
      if (cancelled(e)) return;
      // fx-swallow-ok: readEngine answers failures itself (they are `failed`); anything else is a defect in this read and the next full read shows the truth
      return;
    }
    onChange();
  }

  /** verb: "done" (Mark done), "withdraw" or "keep". A second press while one is in flight is ignored. */
  async function act(id, verb, body, said) {
    if (busy.has(id)) return;
    busy.set(id, verb);
    st = { ...st, error: "", announce: "" };
    onChange();
    try {
      const row = readRequest(await call("POST", actionUrl(id, verb), body, signal));
      if (!row) throw new Error("shape");
      confirming.delete(id);
      open = open.filter((r) => r.id !== id);
      closed.delete(id);
      if (row.state === "open") open = [row, ...open];
      else closed.set(id, row);
      // Keep says what it did: the managed line, or that nothing was marked because the pull request is no longer open on this branch.
      const sentence = said ? said(row) : row.sentence;
      if (said) row.sentence = sentence;
      // The answer leaves a row with one control that takes it back (Keep: the undo; Replace waiting for its update: Keep). Focus goes there, as it does when Replace asks again.
      st = { ...st, announce: sentence, focusAct: isBranchRow(row) && row.branchManaged ? { id, act: "release" } : isBranchRow(row) && row.replacePending ? { id, act: "keep" } : st.focusAct };
      merge();
    } catch (e) {
      busy.delete(id);
      if (cancelled(e)) return;
      confirming.delete(id);
      st = { ...st, error: e && e.status === 409 && e.code === "setup_request_head_changed" ? WORDS.headMoved : e && e.status === 409 && e.code === "setup_request_closed" && (verb === "keep" || verb === "replace") ? WORDS.branchAnswered : failureSentence(e) };
      await load(); // a refused action may mean the request changed under the person: show what is true now
      return;
    }
    busy.delete(id);
    onChange();
  }

  /** Keep their version: one bare POST; the answer names whether the branch is now marked as managed. */
  const keep = (id) => act(id, "keep", undefined, (row) => (row.branchManaged ? row.sentence || WORDS.keptNotManaged : WORDS.keptNotManaged));

  /** The first step of Replace: ask once more, showing the head the question is about. Nothing is sent. */
  function askReplace(id) {
    const row = open.find((r) => r.id === id && isBranchRow(r) && r.state === "open");
    if (!row || busy.has(id) || row.seenHead === "") return;
    confirming.set(id, row.seenHead);
    st = { ...st, error: "", announce: "", focusAct: { id, act: "replace-yes" } };
    onChange();
  }
  function cancelReplace(id) {
    if (!confirming.delete(id)) return;
    st = { ...st, focusAct: { id, act: "replace" } };
    onChange();
  }
  /** The second step: sends the head that was on screen with the explicit confirmation. A branch that moved is refused by the cloud and the page reads again. */
  function replace(id) {
    const head = confirming.get(id);
    if (head === undefined) return Promise.resolve();
    return act(id, "replace", { shown_head: head, confirm: true }, (row) => (row.replacePending ? row.sentence || WORDS.replaceQueued : WORDS.replaceQueued));
  }

  /** The undo of Keep: the row leaves the list. */
  async function release(id) {
    const row = [...open, ...closed.values()].find((r) => r.id === id && r.branchManaged && r.workItemId !== "");
    if (!row || busy.has(id)) return;
    busy.set(id, "release");
    st = { ...st, error: "", announce: "" };
    onChange();
    try {
      const res = await call("POST", releaseUrl(row.workItemId), undefined, signal);
      if (!res || typeof res.released !== "boolean") throw new Error("shape");
      open = open.filter((r) => r.id !== id);
      closed.delete(id);
      merge();
      st = { ...st, announce: res.released ? WORDS.released : WORDS.releasedNothing, focusId: "" };
    } catch (e) {
      busy.delete(id);
      if (cancelled(e)) return;
      st = { ...st, error: failureSentence(e) };
      await load();
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
    if (!row || busy.has(id) || !st.isAdmin || (row.planHolder && !row.planHolder.isYou)) return;
    if (choice !== "deny" && !row.options.some((o) => o.id === choice)) return;
    // One key per ask and choice, kept until the answer settles: a press again after a network error or a 5xx replays the same answer.
    let k = keys.get(id);
    if (!k || k.choice !== choice) keys.set(id, (k = { choice, key: crypto.randomUUID() }));
    busy.set(id, "answer");
    st = { ...st, error: "", announce: "" };
    onChange();
    try {
      const res = await call("POST", answerUrl(id), { choice }, signal, { idempotencyKey: k.key });
      if (!res || typeof res.answered_option !== "string") throw new Error("shape");
      keys.delete(id);
      // The outcome is the response's option (a replay names the first answer), said once; the row is gone and focus goes to the next one.
      const picked = row.options.find((o) => o.id === res.answered_option);
      const at = st.rows.findIndex((r) => r.id === id);
      open = open.filter((r) => r.id !== id);
      merge();
      const next = st.rows[at];
      st = { ...st, announce: row.startAsk ? startAnswerWords(res.answered_option) : WORDS.answered + ": " + (picked ? picked.label : WORDS.deny) + ".", focusId: next ? next.id : "" };
    } catch (e) {
      busy.delete(id);
      if (cancelled(e)) return;
      if (e && e.status >= 400 && e.status < 500) keys.delete(id); // a refusal settles the key
      st = { ...st, error: failureSentence(e) };
      await load(); // a refused answer may mean the ask changed under the person: show what is true now
      return;
    }
    busy.delete(id);
    onChange();
  }

  /**
   * The button of a stalled row: the card's top button, one request with no body. A second press while one is in flight is ignored. Accepted, the person is
   * told it started and the list is read again (the cloud drops the row once the item is moving). Any refusal is a fixed sentence, then a re-read.
   */
  async function unstick(id) {
    const row = open.find((r) => r.id === id && r.kind === "stalled");
    if (!row || row.action === "" || busy.has(id)) return;
    busy.set(id, "unstick");
    st = { ...st, error: "", announce: "" };
    onChange();
    try {
      const res = await call("POST", approveUrl(row.workItemId), undefined, signal);
      if (!res || typeof res.action_id !== "string") throw new Error("shape");
      st = { ...st, announce: WORDS.stalledStarted };
    } catch (e) {
      busy.delete(id);
      if (cancelled(e)) return;
      st = { ...st, error: stalledFailureSentence(e) };
      await load(); // a refused press may mean the item changed under the person: show what is true now
      return;
    }
    busy.delete(id);
    await load();
  }

  /** The app has put the announcement on the page: it is said once, so it is not kept for the next draw. Does not redraw. */
  const clearAnnounce = () => {
    st = { ...st, announce: "", focusId: null, focusAct: null };
  };

  // Live events and the timer read through refresh(): one read in flight, and events that arrive during it cause one more read after it.
  // `engine.changed` asks for the engine part only (EB-6c); a full read that is wanted at the same time covers it.
  let reading = false;
  let wantFull = false;
  let wantEngine = false;
  let running = false;
  async function drain() {
    if (reading) return;
    reading = true;
    try {
      while (running && (wantFull || wantEngine)) {
        const full = wantFull;
        wantFull = false;
        wantEngine = false;
        await (full ? load() : loadEngine());
      }
    } finally {
      reading = false;
    }
  }
  function refresh() {
    if (!running) return Promise.resolve();
    wantFull = true;
    return drain();
  }
  function refreshEngine() {
    if (!running) return Promise.resolve();
    wantEngine = true;
    return drain();
  }
  let stopFn = null;
  /**
   * Reads again on the live stream's refresh, on each of LIVE_EVENTS and every REFRESH_MS, but not on the timer while the page is hidden.
   * `subscribe(handler)` and `listen(type, handler)` return their off function. Starting twice replaces the first. Nothing is left running after stop().
   */
  function start({ subscribe, listen, setTimer = setInterval, clearTimer = clearInterval, setDelay = setTimeout, clearDelay = clearTimeout, hidden = () => false } = {}) {
    stop();
    running = true;
    const offs = [typeof subscribe === "function" ? subscribe(() => refresh()) : () => {}];
    if (typeof listen === "function") for (const type of LIVE_EVENTS) offs.push(listen(type, () => refresh()));
    // `engine.changed`: the first event of a burst starts a 1 s wait, the rest join it, and one engine read follows.
    let pending = null;
    if (typeof listen === "function")
      offs.push(
        listen(ENGINE_CHANGED, () => {
          if (pending !== null) return;
          pending = setDelay(() => {
            pending = null;
            refreshEngine();
          }, ENGINE_DEBOUNCE_MS);
        })
      );
    const timer = setTimer(() => {
      if (!hidden()) refresh();
    }, REFRESH_MS);
    stopFn = () => {
      offs.forEach((off) => off());
      clearTimer(timer);
      if (pending !== null) clearDelay(pending);
      pending = null;
    };
  }
  function stop() {
    running = false;
    wantFull = false;
    wantEngine = false;
    if (stopFn) stopFn();
    stopFn = null;
  }

  return { load, loadEngine, act, keep, askReplace, cancelReplace, replace, release, confirmingHead: (id) => confirming.get(id) ?? "", answer, unstick, start, stop, clearAnnounce, anyBusy: () => busy.size > 0, busyVerb: (id) => busy.get(id) || "", get state() { return st; } };
}
