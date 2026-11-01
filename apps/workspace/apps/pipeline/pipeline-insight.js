// D#483 P4: what the Pipeline detail shows about a work item's live pipeline: a pure model, and the panel that draws it.
//
// Input is the body of GET /api/v1/work-items/{id}/activity. Nothing here touches the DOM, the network or the
// clock, so every state (no discussion, no Spec, no runs, running, failed, a long text) is a unit test. Every
// sentence about the pipeline is chosen from recorded fields only (a status, a stage, the repo's auto-merge
// setting, a fixed code); where the record has nothing, the model says nothing rather than guessing.
//
// Model text (comments, the Spec, a run summary, a command line) is passed through as strings and is shown by the
// view with textContent only. This file never builds markup from it.
//
// The file has two halves: the pure model (no DOM, no network) and, below the divider, the panel that draws it. They
// share one file because the Pipeline app has a per-app boot-file ceiling (build/budget.mjs).
import { clockText, h, timeNode } from "../_lib/dom.js";
import { api, createRetryGate, isRateLimited, retryWords, waitSeconds } from "../_lib/api.js";
import { sayLive, stageWords } from "./pipeline-actions.js";


/** Agent roles by the phase they belong to. A role not listed is labelled "Run". */
export const PHASES = {
  "project-manager": "Triage & Spec",
  "technical-architect": "Panel",
  "product-owner": "Panel",
  "performance-expert": "Panel",
  "security-expert": "Panel",
  "cost-analyst": "Panel",
  executor: "Build",
  "code-reviewer": "Review",
  "acceptance-tester": "Review",
  "security-reviewer": "Review",
  debater: "Review",
  "accessibility-reviewer": "Review",
  "browser-tester": "Review",
};

const ROLE_WORDS = {
  "project-manager": "Project manager",
  "technical-architect": "Technical architect",
  "product-owner": "Product owner",
  "performance-expert": "Performance expert",
  "security-expert": "Security expert",
  "cost-analyst": "Cost analyst",
  executor: "Executor",
  "code-reviewer": "Code reviewer",
  "acceptance-tester": "Acceptance tester",
  "security-reviewer": "Security reviewer",
  debater: "Debater",
  "accessibility-reviewer": "Accessibility reviewer",
  "browser-tester": "Browser tester",
};

export const phaseOf = (role) => PHASES[role] || "Run";
export const roleWord = (role) => ROLE_WORDS[role] || (typeof role === "string" && role ? role : "Agent");

/** Run statuses that are still going: these sections open by default. */
export const LIVE_STATUSES = new Set(["pending", "running", "paused"]);
const STATUS_WORDS = {
  pending: "starting",
  running: "running",
  paused: "paused",
  succeeded: "finished",
  failed: "failed",
  timed_out: "timed out",
  cancelled: "cancelled",
  killed_spend: "stopped at the spend limit",
  refused_spend: "not started: spend limit",
};
export const statusWord = (status) => STATUS_WORDS[status] || "ended";

/** The first non-empty line of a text, cut to `max` characters (one line, for a collapsed row). */
export function firstLine(text, max = 110) {
  const line = String(text == null ? "" : text).split("\n").map((l) => l.trim()).find((l) => l.length > 0) || "";
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

/**
 * The panel's signed comments split into rounds. A role's first comment is Round 1; its second and later comments
 * are the challenge round. (The record carries no round number, so this is the same rule the panel itself follows.)
 */
export function groupRounds(comments) {
  const seen = new Map();
  const round1 = [];
  const challenge = [];
  (Array.isArray(comments) ? comments : []).forEach((c, i) => {
    const key = c && typeof c.role === "string" ? c.role : "agent";
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    const row = { key: "c:" + key + ":" + n, role: c.role, who: roleWord(c.role), body: String(c.body == null ? "" : c.body), preview: firstLine(c.body), at: c.created_at, index: i };
    (n >= 2 ? challenge : round1).push(row);
  });
  return { round1, challenge };
}

/** "$1.23" for a run's recorded cost, or "" when none. */
export function usdText(usd) {
  return Number.isFinite(usd) ? "$" + usd.toFixed(2) : "";
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const apiUsd = (n) => "$" + (n !== 0 && Math.abs(n) < 0.01 ? n.toFixed(4) : n.toFixed(2));

/**
 * C42-4: a run on the person's machine has no spend of its own, so its cost is the estimate at API prices and its state, never a bare "$0".
 * `head` is the short text after the title; `note` is the server's sentence for a state with no figure ("not the same as $0"). A live run has neither yet.
 */
export function runnerCost(run) {
  const u = isObj(run.runner_usage) ? run.runner_usage : null;
  const note = typeof run.runner_usage_note === "string" && run.runner_usage_note !== "" ? run.runner_usage_note : null;
  if (u && Number.isFinite(u.api_equivalent_usd)) return { head: "≈ " + apiUsd(u.api_equivalent_usd) + " at API prices · " + (u.credential_mode === "api_key" ? "on your own API key" : "on your plan"), note: null };
  if (run.runner_usage_state === "not_priced" || u) return { head: "usage not priced", note };
  if (run.runner_usage_state === "not_recorded") return { head: "usage not recorded", note };
  return { head: "", note: null };
}

/** What a run with no lines says: "No activity recorded." only once it is over. */
export function noActivityText(run) {
  if (!LIVE_STATUSES.has(run.status)) return SENTENCES.noActivity;
  if (run.runtime !== "runner") return "Nothing recorded yet.";
  return run.status === "running" ? "Your runner has started; nothing recorded yet" : "Not started yet; nothing recorded yet.";
}

/** One agent run as a section: its phase, a title, whether it starts open, its summary and its newest lines. */
export function runView(run, maxLines = 40) {
  const live = LIVE_STATUSES.has(run.status);
  const lines = Array.isArray(run.lines) ? run.lines : [];
  const runner = run.runtime === "runner";
  const rc = runner ? runnerCost(run) : null;
  const waitText = runner && run.status === "pending" && isObj(run.wait) && typeof run.wait.text === "string" && run.wait.text !== "" ? run.wait.text : null;
  const seen = runner && run.status === "running" ? clockText(run.runner_checked_in_at) : null;
  return {
    runner,
    emptyText: noActivityText(run),
    costNote: rc ? rc.note : null,
    waitText,
    checkedIn: seen ? "Runner checked in " + seen : null,
    attachHint: runner && live,
    id: typeof run.id === "string" ? run.id : "",
    key: "r:" + run.id,
    phase: phaseOf(run.role),
    role: roleWord(run.role),
    status: run.status,
    statusWord: statusWord(run.status),
    live,
    openByDefault: live,
    cost: rc ? rc.head : usdText(run.usd),
    at: run.created_at,
    summary: typeof run.summary === "string" && run.summary.trim() ? run.summary : null,
    lines: lines.slice(-maxLines).map((l) => String(l.text)),
    hiddenLines: Math.max(0, lines.length - maxLines),
  };
}

const KIND_WORDS = {
  continue_work_item: "Continue request",
  cancel_work_item: "Cancel request",
  cancel_run: "Cancel request for a run",
  retry_run: "Retry request",
  start_preview: "Preview request",
};
const STATE_WORDS = { accepted: "waiting to start", claimed: "being handled", done: "done", refused: "refused", failed: "failed" };
const RESULT_WORDS = {
  started: "the pipeline started",
  waiting: "the build is waiting for a build slot",
  merged: "Merge gate: merged",
  ready_human_merges: "Merge gate: not merged, a person merges",
  merge_enqueued: "Merge gate: queued in GitHub's merge queue",
  merge_delegated: "Merging on your runner",
  pr_not_open: "Merge gate: the pull request is not open",
  head_moved: "Merge gate: the pull request changed after review",
  refused: "Merge gate: refused",
};
const REASON_WORDS = {
  pr_draft: "the pull request is a draft",
  one_build_per_repo_until_d598: "this repository builds one item at a time",
  waiting_for_build_slot_repo: "this repository's build slots are all taken",
  waiting_for_build_slot_account: "your account's build slots are all taken",
  head_sha_malformed: "the pull request's head could not be read",
  run_timestamp_invalid: "a review run has an invalid time",
  ci_not_green: "CI is not green",
  auto_merge_not_allowed: "auto-merge is not allowed",
  human_merge_only: "the operator set this repository so that a person merges",
  local_reviews_passed_advisory: "Reviews passed on your machine. A person merges this pull request.",
  merge_call_refused: "GitHub refused the merge",
  // Two planes: a paired repository merges its public pull request, so these two say why a person does.
  public_pr_not_open: "The public pull request is not open (not opened yet, closed or merged).",
  // Two planes, a runner_local repository: the merge goes through the customer's own runner, and these say why a person merges instead.
  runner_merge_timeout: "Your runner did not finish the merge in time (60 minutes). A person merges the public pull request.",
  runner_merge_failed: "Your runner could not finish the merge. A person merges the public pull request.",
  runner_report_mismatch: "Your runner reported a merge that GitHub does not show. A person looks at the public pull request.",
  public_branch_person_managed: "A person took over the public branch, so the merge is theirs. A person merges the public pull request.",
  public_head_unrecorded: "The public pull request's head is not the one the platform pushed. A person looks at it before it merges.",
  public_head_not_reviewed: "The public pull request does not hold exactly what was reviewed. A person looks at it before it merges.",
  no_pull_request: "The platform has no pull request on record for this item to merge. A person looks.",
  go_not_applicable: "The merge could not go through your runner for this item. A person merges the public pull request.",
  pairing_changed: "The public repository's pairing changed while the merge waited. A person merges the public pull request.",
  runner_merge_unavailable: "Everything else is met. A person merges the public pull request, because it is not merged from the cloud for a repository that runs on your machine.",
  // D#598 P3b (C3 R-598-P5b-6). Read through `stackedWords`, which puts the parent's number in; this is the sentence for a stop that carries none.
  stacked_on_open_pr: "This builds on a pull request that hasn't merged yet.",
};
const STACKED_PR_CODE = /^stacked_on_pr_([1-9][0-9]{0,8})$/;

/** The gate's stacked stop in words: with the parent's number when the record carries it, and never a bare "#undefined". Every `stacked_on_pr_*` code is absorbed, valid or not. */
function stackedWords(codes) {
  const list = Array.isArray(codes) ? codes : [];
  const n = list.map((c) => STACKED_PR_CODE.exec(String(c))).find(Boolean);
  const stacked = list.includes("stacked_on_open_pr");
  return { codes: list.filter((c) => !/^stacked_on_pr_/.test(String(c))), sentence: stacked && n ? "This builds on #" + n[1] + ", which hasn't merged yet." : null };
}
const ROLE_CODES = { code_reviewer: "code review", security_reviewer: "security review", acceptance_tester: "acceptance test", debater: "debate" };

const plainCode = (code) => String(code).replace(/_/g, " ");

/** A fixed gate reason code in words. Codes this file does not know are shown with underscores as spaces. */
export function reasonWord(code) {
  if (REASON_WORDS[code]) return REASON_WORDS[code];
  const m = /^(missing_run|run_not_succeeded|run_not_production|verdict_not_pass)_(.+)$/.exec(String(code));
  if (m && ROLE_CODES[m[2]]) {
    const what = ROLE_CODES[m[2]];
    return { missing_run: "no " + what + " run on this commit", run_not_succeeded: "the " + what + " did not finish", run_not_production: "the " + what + " was not a production run", verdict_not_pass: "the " + what + " did not pass" }[m[1]];
  }
  return plainCode(code);
}

/** One recorded run action as a row of text, or null when it carries nothing to say. Recorded fields only. */
export function stepView(step) {
  if (!step || typeof step.kind !== "string") return null;
  const parts = [KIND_WORDS[step.kind] || plainCode(step.kind), STATE_WORDS[step.state] || plainCode(step.state)];
  if (step.result) parts.push(RESULT_WORDS[step.result] || plainCode(step.result));
  if (step.code) parts.push("reason: " + plainCode(step.code));
  const stacked = stackedWords(step.reasons);
  const reasons = stacked.codes.map((c) => (c === "stacked_on_open_pr" && stacked.sentence ? stacked.sentence : reasonWord(c)));
  return { at: step.at, text: parts.join(" · "), reasons };
}

const SAFE_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * The PR's address when the record names the repo and the PR, else null. Only validated parts are joined. `pr_number` is the
 * real pull request (the server reads it from a reviewer's run, never from the build's, which names the issue). Issues and
 * pull requests share one number space in a repository, so a PR number equal to the issue's is the issue's number leaking
 * through, and /pull/<issue> would open the issue: it is not trusted. Without a real PR number the link is GitHub's search
 * for the executor's branch (fx/issue-<n>), which finds the pull request.
 */
export function pullUrl(data) {
  if (!data || !data.repo || !SAFE_NAME.test(data.repo.owner) || !SAFE_NAME.test(data.repo.name)) return null;
  const base = "https://github.com/" + data.repo.owner + "/" + data.repo.name;
  if (Number.isInteger(data.pr_number) && data.pr_number >= 1 && data.pr_number !== data.issue_number) return base + "/pull/" + data.pr_number;
  if (Number.isInteger(data.issue_number) && data.issue_number >= 1) return base + "/pulls?q=is%3Apr+head%3Afx%2Fissue-" + data.issue_number;
  return null;
}

const PUBLIC_REPO = /^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/;
const PUBLIC_BRANCH = /^[A-Za-z0-9._/-]{1,200}$/;

/**
 * D#598 P1f-6a: the "Public change" block, from the activity's `public_change`. The server writes the sentence (fixed words);
 * the repo, branch and pull request are shown only when they have the shape of a GitHub name, and the one anchor only when its
 * address is exactly https://github.com/{repo}/pull/{pr_number}. A missing part is left out, never printed as a word for nothing.
 */
export function publicChangeView(data) {
  const p = data && data.public_change;
  if (!p || typeof p.sentence !== "string" || !p.sentence || typeof p.repo !== "string" || !PUBLIC_REPO.test(p.repo)) return null;
  return {
    sentence: p.sentence,
    repo: p.repo,
    branch: typeof p.branch === "string" && PUBLIC_BRANCH.test(p.branch) ? p.branch : null,
    prText: Number.isInteger(p.pr_number) && p.pr_number >= 1 ? "Pull request #" + p.pr_number : null,
    // The one anchor leads to exactly this pull request of the paired repository, and to nothing else a record might hold.
    prUrl: Number.isInteger(p.pr_number) && p.pr_number >= 1 && typeof p.pr_url === "string" && p.pr_url.toLowerCase() === ("https://github.com/" + p.repo + "/pull/" + p.pr_number).toLowerCase() ? p.pr_url : null,
  };
}

/**
 * The short-Spec step's refusal codes, each with its fixed sentence (the notice kind `spec_refused` carries the code, never text). Nothing was published in any of
 * these cases, and a person's way forward is the same: fix the request on GitHub and approve again, or close it. An unknown code reads as SPEC_REFUSED_GENERIC.
 */
export const SPEC_REFUSED_TAIL = " Nothing was saved. Edit the issue on GitHub and approve again, or close it.";
export const SPEC_REFUSED_SENTENCES = Object.freeze({
  invalid_spec_output: "The Spec writer's output was incomplete, so no Spec was published." + SPEC_REFUSED_TAIL,
  invalid_file_scope: "The Spec writer didn't give a readable list of the files the change may touch, so no Spec was published." + SPEC_REFUSED_TAIL,
  invalid_planned_prs: "The Spec writer's list of planned pull requests couldn't be read, so no Spec was published." + SPEC_REFUSED_TAIL,
  planned_prs_too_large: "The Spec writer planned more pull requests than one Spec may hold, so no Spec was published." + SPEC_REFUSED_TAIL,
  planned_split_missing: "The Spec writer said the work should be split into several pull requests but gave no list of them, so no Spec was published." + SPEC_REFUSED_TAIL,
  planned_split_unflagged: "The Spec writer listed several pull requests without saying the work should be split, so no Spec was published." + SPEC_REFUSED_TAIL,
  spec_too_large: "The Spec came out larger than a Spec may be, so it was not published." + SPEC_REFUSED_TAIL,
  item_halted: "This item is halted, so no Spec was published. Approve it again when you want it to continue, or close it.",
  publish_failed: "The Spec couldn't be saved just now, so it was not published." + SPEC_REFUSED_TAIL,
  // The Spec writer's own run failed before it could answer. Approving again starts a fresh run, so nothing needs editing first.
  empty_agent_output: "The Spec writer finished without giving an answer, so no Spec was published. Approve again to try once more, or close it.",
  clone_failed: "The Spec writer couldn't get a copy of the repository, so no Spec was published. Approve again to try once more, or close it.",
});
/** A request the pipeline retired in favour of its tracked item: the one fixed sentence, and the label of the link to that item. */
export const SUPERSEDED_SENTENCE = "This request moved to its tracked item, which carries the work from here.";
export const SUPERSEDED_LINK_LABEL = "Open the tracked item";
const ITEM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SPEC_REFUSED_GENERIC = "The Spec step stopped before publishing a Spec." + SPEC_REFUSED_TAIL;

/**
 * D#6: a review parked for the runner's daily run limit. The server sends the fixed sentence and the instant the limit starts again (`resets_at`, an ISO instant);
 * the card adds that instant in the VIEWER's zone (`timeZone` undefined: the browser's own; a test passes one). A missing or malformed instant adds nothing.
 */
export function limitResetTail(iso, timeZone) {
  const t = typeof iso === "string" ? new Date(iso) : null;
  if (t === null || Number.isNaN(t.getTime())) return "";
  return ` The limit resets at ${t.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short", ...(timeZone === undefined ? {} : { timeZone }) })}.`;
}

/**
 * The notice banner: why the pipeline stopped and wants a person. `reason` is model text, returned as plain text and drawn
 * as a text node or a <pre> only, never markup. Any other kind, or a malformed notice, draws nothing.
 */
export function noticeBanner(data) {
  const n = data && data.notice;
  if (!n || typeof n.reason !== "string") return null;
  if (n.kind === "not_feasible") return { kind: "not_feasible", title: "Stopped before building. ", lead: "The project manager says this can't be built as written: ", tail: " Edit the issue on GitHub and approve again, or close it.", reason: n.reason };
  if (n.kind === "check_failed") return { kind: "check_failed", title: "Couldn't check the build. ", lead: "", tail: "", reason: n.reason };
  if (n.kind === "needs_human") return { kind: "needs_human", title: "Needs a person. ", lead: "The build stopped without a pull request. The executor's own account: ", tail: "", reason: n.reason };
  // D#6 R4d-5b: the server sends the whole sentence (the runner protocol's copy); the card adds no words of its own around it.
  if (n.kind === "no_file_list" || n.kind === "respec_failed" || n.kind === "build_slot_wait") return { kind: n.kind, title: "", lead: "", tail: "", reason: n.reason };
  if (n.kind === "review_limit_wait") return { kind: n.kind, title: "", lead: "", tail: limitResetTail(n.resets_at), reason: n.reason };
  // `reason` is the tracked item's id (same account, checked by the server) or empty: the link is drawn only for a well-formed id, and the sentence never carries it.
  if (n.kind === "superseded") return { kind: "superseded", title: "", lead: "", tail: "", reason: SUPERSEDED_SENTENCE, rootId: ITEM_ID.test(n.reason) ? n.reason.toLowerCase() : null };
  if (n.kind === "spec_refused") return { kind: "spec_refused", title: "Stopped before building. ", lead: "", tail: "", reason: Object.hasOwn(SPEC_REFUSED_SENTENCES, n.reason) ? SPEC_REFUSED_SENTENCES[n.reason] : SPEC_REFUSED_GENERIC };
  return null;
}

/**
 * What state the item is in beyond its stage (D#7 DP8-f1): halted by a customer, and parked on an agent's question. Each is
 * drawn only when the record says exactly `true`, so an older server that sends neither draws nothing. "Waiting for your
 * answer" is approved wording; the "Halted" label is PROPOSED and held for the owner's copy approval.
 */
export const FLAG_WORDS = { halted: "Halted", waiting_on_answer: "Waiting for your answer" };
/** The "Needs you" app's id, and the label of the link to it. The link is drawn only while that app is registered. */
export const NEEDS_YOU_APP = "needs-you";
export const NEEDS_YOU_LABEL = "Needs you";
const NEEDS_YOU_TESTID = "pl-flag-needs-you";
export function stateFlags(data) {
  const out = [];
  if (data && data.halted === true) out.push({ kind: "halted", text: FLAG_WORDS.halted });
  if (data && data.waiting_on_answer === true) out.push({ kind: "waiting_on_answer", text: FLAG_WORDS.waiting_on_answer });
  return out;
}

/**
 * D#598 P8c-3: the pause line for an item a setup request holds. The server sends `setup_pause` only while a request holds the item, with the
 * request's own status sentence; the line shows that sentence as text. A request with no sentence (a withdrawn one) gets a generic line, and a
 * malformed `setup_pause` draws nothing: the line is never blank. The generic wording is recommended copy under the 10-17 delegation.
 */
export const SETUP_PAUSE_WORDS = {
  open: "Paused: this item is waiting for a setup step from a person.",
  withdrawn: "Paused: the setup request was withdrawn. The item starts again when a person advances it.",
};
export function setupPauseLine(data) {
  const p = data && data.setup_pause;
  if (!p || (p.state !== "open" && p.state !== "withdrawn")) return null;
  const sentence = typeof p.sentence === "string" ? p.sentence.trim() : "";
  return { state: p.state, text: sentence !== "" ? sentence : SETUP_PAUSE_WORDS[p.state] };
}

/**
 * D#7 start gate (c): how the item's start was decided, for the card. The server sends `start_decision` only for an item that went through the start gate,
 * with a fixed sentence and, once decided, when. The line shows that sentence and the time (the receipt of the decision: who or which setting, and when). A
 * sentence that is missing or blank falls back to the words below by state; a state this build does not know, or anything malformed, gets the generic line
 * or nothing. A code never reaches the screen.
 */
export const START_DECISION_WORDS = {
  asked: "Waiting for an owner or admin to answer in Needs you: a setting asks before this starts.",
  started: "This item was started.",
  declined: "This item was held. It does not start until a person starts it.",
  withdrawn: "The question about starting this was withdrawn before anyone answered. It is decided again the next time this item comes up to start.",
  unknown: "A decision about starting this item is on record.",
};
export function startDecisionLine(data) {
  const d = data && data.start_decision;
  if (!isObj(d)) return null;
  const state = typeof d.state === "string" && Object.hasOwn(START_DECISION_WORDS, d.state) ? d.state : "unknown";
  const sentence = typeof d.sentence === "string" ? d.sentence.trim() : "";
  const when = typeof d.at === "string" ? formatWhen(d.at) : "";
  return { state, text: (sentence !== "" ? sentence : START_DECISION_WORDS[state]) + (when !== "" ? " " + when + "." : "") };
}

/**
 * D#7 DW-R5: the decisions recorded for the item (class 2 and 3 receipts), for the card. The server sends `receipts` only when the item has some: each entry has a
 * fixed `label`, `at`, `by` (`policy` or `person`) and two option ids. A line is always words: a missing label reads "A decision", a missing or bad time and a `by` this
 * build does not know are left out, an option id that is missing or not shown is left out, and anything that is not an object is skipped. Two receipts of the same
 * type are told apart by their times. No code, id or database value is added to what the server sent.
 */
export const RECEIPTS_HEADING = "Decisions recorded for this item";
export function receiptsSection(data) {
  const list = data && data.receipts;
  if (!Array.isArray(list)) return null;
  const items = [];
  for (const r of list) {
    if (!isObj(r)) continue;
    const plain = (v) => (typeof v === "string" && v.trim() !== "" && v.trim() !== "(not shown)" ? v.trim() : "");
    const label = plain(r.label) || "A decision";
    const by = r.by === "policy" ? "your setting" : r.by === "person" ? "a person" : "";
    const when = typeof r.at === "string" ? formatWhen(r.at) : "";
    const chosen = plain(r.chosen);
    const rejected = plain(r.rejected);
    const text =
      label + "." +
      (chosen ? " Chosen: " + chosen + "." : "") +
      (rejected ? " Not chosen: " + rejected + "." : "") +
      (by ? " Decided by " + by + (when ? ", " + when : "") + "." : when ? " " + when + "." : "");
    items.push({ text, class: r.class === 3 ? 3 : r.class === 2 ? 2 : 0 });
  }
  if (items.length === 0) return null;
  const total = Number.isInteger(data.receipts_total) ? data.receipts_total : 0;
  return { heading: RECEIPTS_HEADING, items, more: total > items.length ? "Showing the newest " + items.length + " of " + total + "." : null };
}

/**
 * D#483 S5-b2c-2: why a planned PR child does not start yet, for its card. The server derives `child_launch` on each read (nothing is stored on it, so it clears when
 * the thing it names clears) and sends it only for a child that has not started, with a fixed sentence. `code` and `sentence` are null when the child may start and only
 * the `warning` (it waits on a sibling; a person may still start it) is left. The line shows the sentence as sent; a missing or blank sentence shows nothing, and a code
 * never reaches the screen.
 */
export function childLaunchLine(data) {
  const c = data && data.child_launch;
  if (!isObj(c)) return null;
  const sentence = typeof c.sentence === "string" ? c.sentence.trim() : "";
  const w = isObj(c.warning) && typeof c.warning.sentence === "string" ? c.warning.sentence.trim() : "";
  if (sentence === "" && w === "") return null;
  return { blocked: sentence !== "", text: sentence !== "" ? sentence : "", warning: w, offers: c.offers === "close" || c.offers === "parent" ? c.offers : null };
}

/**
 * The gate reasons that leave only a person's press on Merge. A copy of packages/core/src/work-items/mergeReadiness.ts (a core test pins the two equal).
 * An answer with no reasons, or only these, is ready; any other reason, a code this list does not know included, still blocks the merge.
 */
export const PERSON_MERGES_REASONS = [
  "auto_merge_not_allowed",
  "human_merge_only",
  "local_review_not_enabled",
  "local_reviews_passed_advisory",
  "runner_merge_unavailable",
  "runner_merge_timeout",
  "runner_merge_failed",
  "runner_report_mismatch",
  "public_branch_person_managed",
  "review_round_cap",
  "review_compute_cap",
];

/** One fixed sentence per blocking gate reason. Only the cloud's own words: never model text, GitHub text or a raw code. */
export const BLOCKING_SENTENCES = {
  public_pr_not_open: "The public pull request isn't open yet",
  pr_draft: "The pull request is a draft",
  ci_not_green: "Checks haven't passed yet",
  repo_ci_missing: "The repository has no checks of its own yet",
  no_branch_protection: "The base branch has no protection rules yet",
  head_sha_malformed: "The pull request's latest commit could not be read",
  run_timestamp_invalid: "A review has an invalid time, so it can't be counted yet",
  public_head_unrecorded: "The public pull request's latest commit isn't the one the platform pushed",
  public_head_not_reviewed: "The public pull request doesn't hold exactly what was reviewed",
  stacked_on_open_pr: "It builds on a pull request that hasn't merged yet",
  merge_call_refused: "GitHub refused the merge",
  merge_conflict: "The pull request has a merge conflict",
  branch_behind: "The branch is behind its base branch",
  branch_protection_refused: "Branch protection refused the merge",
  merge_queue_waiting: "The pull request is waiting in the merge queue",
  ordered_resource_out_of_order: "Another change has to merge before this one",
  merge_dependency_closed: "The pull request it builds on was closed without merging",
  history_rewritten: "The branch history was rewritten after review",
  pairing_changed: "The public repository's pairing changed",
  no_pull_request: "There is no pull request on record to merge",
  go_not_applicable: "The merge could not go through your runner",
};
export const REVIEW_BLOCK_SENTENCE = "A required review hasn't passed on the latest commit";
export const UNKNOWN_BLOCK_SENTENCE = "Something still blocks the merge";
export const PUBLIC_REFUSED_SENTENCE = "The public change was refused, so there is no pull request to merge";

/** The one sentence for a blocking reason code. */
export function blockingSentence(code) {
  if (Object.hasOwn(BLOCKING_SENTENCES, code)) return BLOCKING_SENTENCES[code];
  if (/^stacked_on_pr_/.test(String(code))) return BLOCKING_SENTENCES.stacked_on_open_pr;
  if (/^(missing_run|run_not_succeeded|run_not_production|runner_not_trusted|verdict_not_pass)_/.test(String(code))) return REVIEW_BLOCK_SENTENCE;
  return UNKNOWN_BLOCK_SENTENCE;
}

/** The reasons of the newest gate answer "a person decides" among the steps, or null when no step carries one. */
function newestGateReasons(data) {
  const steps = Array.isArray(data.steps) ? data.steps : [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (isObj(s) && s.result === "ready_human_merges") return Array.isArray(s.reasons) ? s.reasons.filter((r) => typeof r === "string") : [];
  }
  return null;
}

/**
 * Why the merge is not a person's to press yet, as one fixed sentence, or null when it is. A paired item whose public change is refused or has no public pull
 * request is never ready, whatever the gate's reasons. Otherwise the newest gate answer must hold no reasons, or only "a person presses merge" ones; the public
 * pull request not being open is named before the rest, because the other reasons are about a pull request that is not there.
 */
export function mergeBlockSentence(data) {
  const p = data && data.public_change;
  if (isObj(p)) {
    if (p.state === "refused") return PUBLIC_REFUSED_SENTENCE;
    if (!(Number.isInteger(p.pr_number) && p.pr_number >= 1)) return BLOCKING_SENTENCES.public_pr_not_open;
  }
  const reasons = newestGateReasons(data);
  if (reasons === null) return null;
  const blocking = reasons.filter((r) => !PERSON_MERGES_REASONS.includes(r));
  if (blocking.length === 0) return null;
  return blockingSentence(blocking.includes("public_pr_not_open") ? "public_pr_not_open" : blocking[0]);
}

/** D#694 B6-3: the label and subtitle of an item waiting in GitHub's merge queue (a core test pins both to packages/core/src/work-items/mergeReadiness.ts). */
export const QUEUED_TO_MERGE_LABEL = "Queued to merge";
export const QUEUED_TO_MERGE_SUBTITLE = "Waiting for GitHub's merge queue to build and merge it";

/** Whether the newest gate answer among the steps put the pull request in GitHub's merge queue. A later "a person decides" answer replaces it. Never true without a pull request link. */
export function queuedToMerge(data) {
  const steps = data && Array.isArray(data.steps) ? data.steps : [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const r = isObj(steps[i]) ? steps[i].result : null;
    if (r === "merge_enqueued") return pullUrl(data) !== null;
    if (r === "ready_human_merges" || r === "merged" || r === "merge_delegated") return false;
  }
  return false;
}

/** The "Ready to merge" banner, only at review_passed, with the repo's real auto-merge setting. When something still blocks the merge it says what, in fixed words, and offers no link. */
export function readyBanner(data) {
  if (!data || data.stage !== "review_passed") return null;
  // D#694 B6-3: waiting in GitHub's merge queue is not "ready for you to merge": nothing is left for a person to press.
  if (queuedToMerge(data)) return { blocked: false, queued: true, title: QUEUED_TO_MERGE_LABEL, detail: QUEUED_TO_MERGE_SUBTITLE, autoMerge: false, autoMergeText: "", url: pullUrl(data) };
  const blocked = mergeBlockSentence(data);
  if (blocked !== null) return { blocked: true, title: "Not ready to merge yet", detail: blocked + ".", autoMerge: false, autoMergeText: "", url: null };
  return {
    blocked: false,
    title: "Ready to merge",
    detail: "Every required reviewer passed.",
    autoMerge: data.auto_merge === true,
    autoMergeText: data.auto_merge === true ? "Auto-merge is on for this repo: it merges once the merge gate and CI are green." : "Auto-merge is off for this repo: a person merges the pull request on GitHub.",
    url: pullUrl(data),
  };
}

const SLOT_CAUSE_WORDS = {
  memory: "memory is short",
  cpu: "the CPU is busy",
  disk: "disk space is low",
  paused: "the runner is paused",
  ceiling: "the runner is at its job limit",
  usage_limit: "the Claude usage limit is reached",
};

/**
 * "Waiting for your runner: Code reviewer, Acceptance tester (memory is short)": the runner runs not yet claimed, with the cause the runner gave for a
 * full slot, else the cloud's own sentence for why they wait. `views` are the runs' views and `raw` the matching wire runs.
 */
export function waitingLine(views, raw) {
  const roles = views.map((v) => v.role).join(", ");
  const causes = new Set();
  const sentences = new Set();
  for (const run of raw) {
    const wait = isObj(run.wait) ? run.wait : null;
    if (!wait) continue;
    if (typeof wait.limited_by === "string" && Object.hasOwn(SLOT_CAUSE_WORDS, wait.limited_by)) causes.add(SLOT_CAUSE_WORDS[wait.limited_by]);
    else if (typeof wait.text === "string" && wait.text !== "") sentences.add(wait.text);
  }
  const why = causes.size ? " (" + [...causes].join("; ") + ")" : sentences.size ? " · " + [...sentences].join("; ") : "";
  return "Waiting for your runner: " + roles + why;
}

/** Everything the panel draws, from one response. */
export function buildInsight(data) {
  const runs = (Array.isArray(data.runs) ? data.runs : []).map((r) => runView(r));
  // The context button's accessible name is unique per run: runs of one role (a build and its fix rounds) are told apart by their place among them.
  const sameRole = new Map();
  for (const r of runs) sameRole.set(r.role, (sameRole.get(r.role) || 0) + 1);
  const seenRole = new Map();
  for (const r of runs) {
    const nth = (seenRole.get(r.role) || 0) + 1;
    seenRole.set(r.role, nth);
    r.contextLabel = "What this run loaded: " + r.role + (sameRole.get(r.role) > 1 ? ", run " + nth + " of " + sameRole.get(r.role) : "");
  }
  const rawRuns = Array.isArray(data.runs) ? data.runs : [];
  // A runner run that is still pending has not been claimed: it is not running. It is told apart, with the runner's reason, instead of read as "Running now".
  const waiting = runs.filter((r, i) => r.runner && r.status === "pending" && isObj(rawRuns[i]));
  const waitingRaw = waiting.map((r) => rawRuns[runs.indexOf(r)]);
  const running = runs.filter((r) => r.live && !waiting.includes(r));
  const finished = runs.filter((r) => !r.live);
  const spent = (Array.isArray(data.runs) ? data.runs : []).reduce((n, r) => n + (!LIVE_STATUSES.has(r.status) && Number.isFinite(r.usd) ? r.usd : 0), 0);
  return {
    flags: stateFlags(data),
    notice: noticeBanner(data),
    setupPause: setupPauseLine(data),
    startDecision: startDecisionLine(data),
    receipts: receiptsSection(data),
    childLaunch: childLaunchLine(data),
    banner: readyBanner(data),
    runningText: running.length ? "Running now: " + running.map((r) => r.role).join(", ") : "Nothing is running right now.",
    waitingText: waiting.length ? waitingLine(waiting, waitingRaw) : null,
    totalsText: finished.length + " agent run" + (finished.length === 1 ? "" : "s") + " finished" + (finished.length ? " · $" + spent.toFixed(2) + " so far" : ""),
    runs,
    runsTruncated: data.runs_truncated === true,
    publicChange: publicChangeView(data),
    // D#598 P7c: the review section's line for a head that is only a merge of the base branch. The server writes the sentence; no reviewer run exists for it.
    recheck: data.review_recheck && data.review_recheck.kind === "merge_only" && typeof data.review_recheck.sentence === "string" ? data.review_recheck.sentence : null,
    rounds: groupRounds(data.comments),
    commentCount: Array.isArray(data.comments) ? data.comments.length : 0,
    commentsTruncated: data.comments_truncated === true,
    spec: data.spec && typeof data.spec.body === "string" ? { version: data.spec.version, body: data.spec.body } : null,
    steps: (Array.isArray(data.steps) ? data.steps : []).map(stepView).filter(Boolean),
  };
}

// ── the panel ───────────────────────────────────────────────────────────────────────────────────────
// It reads GET /api/v1/work-items/{id}/activity, redraws only its own element every REFRESH_MS while an item is open,
// and keeps which sections the person opened or closed across those redraws. Everything is built with h(), so model
// text (comments, the Spec, run summaries, command lines) is only ever a text node or a <pre>'s text: never markup.

export const REFRESH_MS = 10000;
export const SENTENCES = {
  loading: "Loading what the pipeline is doing…",
  error: "What the pipeline is doing isn't available right now.",
  stale: "Couldn't refresh just now. Showing the last update.",
  noRuns: "No agent has run on this item yet.",
  noActivity: "No activity recorded.",
  noPanel: "No panel discussion yet.",
  noSpec: "No Spec yet.",
  olderRuns: "Older runs aren't shown.",
  olderComments: "Older comments aren't shown.",
};

const text = (t) => h("pre", { class: "pl-ins-text" }, t);

/**
 * @param {{ call: (method: string, url: string, body?: unknown, signal?: AbortSignal) => Promise<any>, setInterval?: Function, clearInterval?: Function }} deps
 */
export function createInsightPanel(deps) {
  /** Told of every answer that was read (not an unchanged redraw's skip): the Pipeline detail draws its action buttons from it. */
  const onData = typeof deps.onData === "function" ? deps.onData : () => {};
  const setTimer = deps.setInterval || ((fn, ms) => setInterval(fn, ms));
  const clearTimer = deps.clearInterval || ((t) => clearInterval(t));
  const el = h("section", { class: "pl-live pl-ins", "data-testid": "pl-live" });
  let itemId = null;
  let state = { status: "idle", data: null, stale: false };
  let timer = null;
  let ac = null;
  let signature = "";
  let skeleton = null; // { body, live, rest } of the full section; null whenever a loading or error sentence replaced it
  /** Sections the person opened (true) or closed (false); a section not in here follows its default. */
  const toggled = new Map();

  const fold = (key, defaultOpen, attrs, summaryChildren, ...children) => {
    const node = h(
      "details",
      {
        ...attrs,
        "data-key": key,
        open: (toggled.has(key) ? toggled.get(key) : defaultOpen) ? true : null,
      },
      h(
        "summary",
        {
          class: "pl-ins-summary",
          // A click on the summary is the person's choice; a redraw that sets `open` is not recorded as one.
          onClick: () => toggled.set(key, !node.open),
        },
        ...summaryChildren
      ),
      ...children
    );
    return node;
  };

  function publicChangeBlock(c) {
    return h(
      "section",
      { class: "pl-ins-public", "data-testid": "pl-public-change" },
      h("h3", { class: "pl-detail-sub" }, "Public change"),
      h("p", { role: "status", "data-testid": "pl-public-change-sentence" }, c.sentence),
      h("p", { class: "pl-muted", "data-testid": "pl-public-change-where" }, c.repo, c.branch ? " · " + c.branch : "", c.prText ? " · " + c.prText : ""),
      c.prUrl ? h("a", { href: c.prUrl, target: "_blank", rel: "noopener noreferrer", "data-testid": "pl-public-change-link" }, "Open the public pull request on GitHub") : null
    );
  }

  function banner(b) {
    if (b.blocked) return h("div", { class: "pl-ins-ready", "data-testid": "pl-ready-blocked", role: "status" }, h("strong", null, b.title + ". "), b.detail);
    if (b.queued) {
      return h(
        "div",
        { class: "pl-ins-ready", "data-testid": "pl-queued", role: "status" },
        h("strong", null, b.title + ". "),
        b.detail + ". ",
        b.url ? h("a", { href: b.url, target: "_blank", rel: "noopener noreferrer", "data-testid": "pl-queued-link" }, "Open the pull request on GitHub") : null
      );
    }
    return h(
      "div",
      { class: "pl-ins-ready", "data-testid": "pl-ready", role: "status" },
      h("strong", null, b.title + ". "),
      b.detail + " ",
      h("span", { "data-testid": "pl-ready-merge", "data-auto-merge": b.autoMerge ? "on" : "off" }, b.autoMergeText + " "),
      b.url ? h("a", { href: b.url, target: "_blank", rel: "noopener noreferrer", "data-testid": "pl-ready-link" }, "Open the pull request on GitHub") : null
    );
  }

  /** The flags, as the children of the one live region (see `skeleton`): fixed words only, never record text. */
  function flagNodes(flags) {
    const needsYou = typeof window !== "undefined" && window.FULCWM && window.FULCApps && window.FULCApps.get(NEEDS_YOU_APP);
    return flags.map((f) =>
      h(
        "span",
        { class: "pl-flag pl-flag-" + f.kind, "data-testid": "pl-flag-" + f.kind },
        f.text,
        f.kind === "waiting_on_answer" && needsYou ? [" ", h("button", { type: "button", class: "pl-act", "data-testid": NEEDS_YOU_TESTID, onClick: () => window.FULCWM.open(NEEDS_YOU_APP) }, NEEDS_YOU_LABEL)] : null
      )
    );
  }

  function noticeView(n) {
    const needsHuman = n.kind === "needs_human";
    return h(
      "div",
      { class: "pl-ins-notice", "data-testid": needsHuman ? "pl-needs-human" : n.kind === "check_failed" ? "pl-check-failed" : n.kind === "no_file_list" ? "pl-no-file-list" : n.kind === "respec_failed" ? "pl-respec-failed" : n.kind === "spec_refused" ? "pl-spec-refused" : n.kind === "superseded" ? "pl-superseded" : "pl-not-feasible", "data-kind": n.kind, role: "status" },
      h("strong", null, n.title),
      n.lead,
      needsHuman ? text(n.reason) : h("span", { "data-testid": "pl-notice-reason" }, n.reason),
      n.tail,
      n.rootId && deps.onOpenItem ? [" ", h("button", { type: "button", class: "pl-act", "data-testid": "pl-superseded-link", onClick: () => deps.onOpenItem(n.rootId) }, SUPERSEDED_LINK_LABEL)] : null
    );
  }

  function runSection(r) {
    const head = [
      h("span", { class: "pl-muted" }, r.phase + " · "),
      r.role + " (" + r.statusWord + ")",
      r.cost ? h("span", { class: "pl-muted" }, " · " + r.cost) : null,
    ];
    return fold(
      r.key,
      r.openByDefault,
      { class: "pl-ins-run", "data-testid": "pl-ins-run", "data-phase": r.phase, "data-status": r.status },
      head,
      r.summary ? h("div", { class: "pl-ins-run-summary", "data-testid": "pl-ins-run-summary" }, h("strong", null, "Summary"), text(r.summary)) : null,
      r.waitText ? h("p", { class: "pl-muted", role: "status", "data-testid": "pl-run-wait" }, r.waitText) : null,
      r.checkedIn ? h("p", { class: "pl-muted", "data-testid": "pl-run-checkin" }, r.checkedIn) : null,
      r.costNote ? h("p", { class: "pl-muted", "data-testid": "pl-run-cost-note" }, r.costNote) : null,
      r.attachHint ? h("p", { class: "pl-muted", "data-testid": "pl-run-attach-hint" }, "You can also watch this run on the runner machine with ", h("code", null, "fx-runner attach"), ".") : null,
      // D#600 CX-8: the Runs app's detail holds the context panel; this opens that run there.
      r.id ? h("button", { type: "button", class: "pl-act", "data-testid": "pl-run-context", "aria-label": r.contextLabel || "What this run loaded: " + r.role, onClick: () => window.FULCWM && window.FULCWM.open("runs", { runId: r.id }) }, "What this run loaded") : null,
      r.lines.length
        ? h(
            "ol",
            { class: "pl-ins-feed", "data-testid": "pl-feed" },
            r.hiddenLines ? h("li", { class: "pl-muted" }, "Earlier activity isn't shown.") : null,
            r.lines.map((l) => h("li", null, l))
          )
        : h("p", { class: "pl-muted", "data-testid": "pl-run-no-activity" }, r.emptyText)
    );
  }

  function commentRow(c) {
    return fold(c.key, false, { class: "pl-ins-comment", "data-testid": "pl-comment" }, [h("strong", null, c.who), " — ", h("span", { class: "pl-muted" }, c.preview)], text(c.body));
  }

  function roundBlock(title, rows) {
    return rows.length ? h("div", { class: "pl-ins-round", "data-testid": "pl-round" }, h("h4", { class: "pl-ins-round-title" }, title + " (" + rows.length + ")"), rows.map(commentRow)) : null;
  }

  /**
   * A redraw replaces the section's children, which shortens the page for a moment and makes the browser clamp every
   * scrolled ancestor (the detail, the app, the window frame) back toward the top. So the scroll position of each
   * scrolled ancestor, and which section's summary (or the Needs you button) had focus, are saved first and put back after the redraw.
   */
  function render() {
    const saved = [];
    for (let n = el.parentElement; n; n = n.parentElement) if (n.scrollTop > 0) saved.push([n, n.scrollTop]);
    const active = typeof document !== "undefined" ? document.activeElement : null;
    const focusDetails = active && typeof el.contains === "function" && el.contains(active) && typeof active.closest === "function" ? active.closest("details[data-key]") : null;
    const focusKey = focusDetails ? focusDetails.getAttribute("data-key") : null;
    const focusNeedsYou = !!active && typeof el.contains === "function" && el.contains(active) && typeof active.getAttribute === "function" && active.getAttribute("data-testid") === NEEDS_YOU_TESTID;
    draw();
    if (focusNeedsYou) {
      const again = [...el.querySelectorAll("[data-testid]")].find((n) => n.getAttribute("data-testid") === NEEDS_YOU_TESTID);
      if (again) again.focus({ preventScroll: true });
    }
    if (focusKey !== null) {
      const again = [...el.querySelectorAll("details[data-key]")].find((d) => d.getAttribute("data-key") === focusKey);
      const summary = again && again.querySelector("summary");
      if (summary) summary.focus({ preventScroll: true });
    }
    for (const [n, top] of saved) n.scrollTop = top;
  }

  function draw() {
    if (state.status === "idle" || state.status === "loading") {
      skeleton = null;
      el.replaceChildren(h("p", { class: "pl-muted", role: "status", "data-testid": "pl-live-state" }, SENTENCES.loading));
      return;
    }
    if (state.status === "error" && !state.data) {
      skeleton = null;
      el.replaceChildren(h("p", { class: "pl-muted", role: "status", "data-testid": "pl-live-state" }, SENTENCES.error));
      return;
    }
    const m = buildInsight(state.data);
    // The flags live in one polite live region that is created once and kept across redraws, so a flag that arrives
    // on a refresh is announced; only its text is rewritten. The rest of the section is rebuilt as before.
    if (!skeleton) {
      const live = h("div", { class: "pl-ins-flags", "data-testid": "pl-flags", role: "status", "aria-live": "polite" });
      const rest = h("div", { class: "pl-ins-rest" });
      const body = h("div", { class: "pl-ins-body" }, h("h3", { class: "pl-detail-sub" }, "What's happening"), live, rest);
      skeleton = { body, live, rest };
      el.replaceChildren(body);
    }
    skeleton.live.replaceChildren(...flagNodes(m.flags));
    // h() skips null children; the native replaceChildren would print "null" for one.
    const restKids = [
      state.stale ? h("p", { class: "pl-muted", role: "status", "data-testid": "pl-live-state" }, SENTENCES.stale) : [],
      m.notice ? noticeView(m.notice) : [],
      m.setupPause ? h("p", { class: "pl-ins-notice", role: "status", "data-testid": "pl-setup-pause", "data-state": m.setupPause.state }, m.setupPause.text) : [],
      m.startDecision ? h("p", { class: "pl-ins-notice", role: "status", "data-testid": "pl-start-decision", "data-state": m.startDecision.state }, m.startDecision.text) : [],
      m.childLaunch && m.childLaunch.text !== "" ? h("p", { class: "pl-ins-notice", role: "status", "data-testid": "pl-child-launch", "data-offers": m.childLaunch.offers || "" }, m.childLaunch.text) : [],
      m.childLaunch && m.childLaunch.warning !== "" ? h("p", { class: "pl-ins-notice", role: "status", "data-testid": "pl-child-launch-warning" }, m.childLaunch.warning) : [],
      m.banner ? banner(m.banner) : [],
      h("p", { "data-testid": "pl-running" }, m.runningText),
      m.waitingText ? h("p", { role: "status", "data-testid": "pl-waiting-runner" }, m.waitingText) : [],
      h("p", { class: "pl-muted", "data-testid": "pl-totals" }, m.totalsText),
      h("h3", { class: "pl-detail-sub" }, m.runs.length ? "Agent runs (" + m.runs.length + ")" : "Agent runs"),
      m.runs.length ? m.runs.map(runSection) : h("p", { class: "pl-muted", "data-testid": "pl-no-runs" }, SENTENCES.noRuns),
      m.runsTruncated ? h("p", { class: "pl-muted" }, SENTENCES.olderRuns) : [],
      m.recheck ? h("p", { class: "pl-muted", role: "status", "data-testid": "pl-review-recheck" }, m.recheck) : [],
      m.publicChange ? publicChangeBlock(m.publicChange) : [],
      m.receipts
        ? [
            h("h3", { class: "pl-detail-sub", "data-testid": "pl-receipts-heading" }, m.receipts.heading),
            h("ul", { class: "pl-ins-feed", "data-testid": "pl-receipts" }, m.receipts.items.map((i) => h("li", { "data-testid": "pl-receipt", "data-class": String(i.class) }, i.text))),
            m.receipts.more ? h("p", { class: "pl-muted", "data-testid": "pl-receipts-more" }, m.receipts.more) : [],
          ]
        : [],
      m.steps.length
        ? [
            h("h3", { class: "pl-detail-sub" }, "Pipeline steps"),
            h(
              "ol",
              { class: "pl-ins-steps", "data-testid": "pl-steps" },
              m.steps.map((s) =>
                h(
                  "li",
                  { "data-testid": "pl-step" },
                  s.at ? [timeNode(s.at, true), " "] : [],
                  s.text,
                  s.reasons.length ? h("span", { class: "pl-muted" }, " — " + s.reasons.join("; ")) : []
                )
              )
            ),
          ]
        : [],
      m.commentCount
        ? fold("panel", false, { class: "pl-ins-panel", "data-testid": "pl-panel" }, [h("strong", null, "Panel discussion"), " · " + m.commentCount + " comment" + (m.commentCount === 1 ? "" : "s")], m.commentsTruncated ? h("p", { class: "pl-muted" }, SENTENCES.olderComments) : [], roundBlock("Round 1", m.rounds.round1), roundBlock("Challenge round", m.rounds.challenge))
        : h("p", { class: "pl-muted", "data-testid": "pl-no-panel" }, SENTENCES.noPanel),
      m.spec
        ? fold("spec", false, { class: "pl-ins-spec", "data-testid": "pl-spec" }, [h("strong", null, "Spec"), " · version " + m.spec.version], text(m.spec.body))
        : h("p", { class: "pl-muted", "data-testid": "pl-no-spec" }, SENTENCES.noSpec)
    ].flat(Infinity).filter((c) => c != null && c !== false);
    // dom-insert-ok: restKids is flattened and stripped of null, undefined and false just above.
    skeleton.rest.replaceChildren(...restKids);
  }

  async function load() {
    const id = itemId;
    if (id === null) return;
    if (ac) ac.abort();
    const mine = (ac = new AbortController());
    try {
      const data = await deps.call("GET", "/api/v1/work-items/" + encodeURIComponent(id) + "/activity", undefined, mine.signal);
      if (mine.signal.aborted || itemId !== id) return;
      if (!data || typeof data !== "object" || !Array.isArray(data.runs) || !Array.isArray(data.comments)) throw new Error("shape");
      // An unchanged answer is not redrawn, so an open section keeps its scroll position and any text selection.
      const sig = JSON.stringify(data);
      const changed = sig !== signature || state.status !== "ready" || state.stale;
      signature = sig;
      state = { status: "ready", data, stale: false };
      if (changed) render();
      onData(data, itemId);
    } catch {
      if (mine.signal.aborted || itemId !== id) return;
      state = { status: "error", data: state.data, stale: state.data !== null };
      signature = "";
      render();
    }
  }

  return {
    el,
    /** Starts showing `id`: loads now and then every REFRESH_MS while the page is visible. */
    start(id) {
      this.stop();
      itemId = id;
      toggled.clear();
      signature = "";
      state = { status: "loading", data: null, stale: false };
      render();
      load();
      timer = setTimer(() => {
        if (typeof document === "undefined" || !document.hidden) load();
      }, REFRESH_MS);
    },
    stop() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      if (ac) ac.abort();
      ac = null;
      itemId = null;
    },
    /** Reads the activity again now (after an action, or when the item's stage changed), without waiting for the timer. */
    refresh() {
      if (itemId !== null) load();
    },
    /** For tests: the current view-state. */
    getState: () => state,
  };
}

// --- Plan tab (D#483 S3-L2b; folded in here for the boot-file budget) ---
// D#483 S3-L2b: the Pipeline app's Plan tab. A repository's imported plan: the Import plan button, the line for the latest
// import, the milestone table (each row opens to its tasks), what the import asked GitHub, "Approved in fulcrumaxe", and the
// undo, Remove imported plan.
//
// Rules this file keeps, each with a test in test/pipeline-plan.test.mjs or e2e/pipeline-plan.spec.ts:
//  - Every state has its own sentence: never imported, queued, importing, stopped, succeeded (and at which level when it is
//    a fallback), cut short, failed (one sentence for each of the fourteen error codes), repository detached, empty.
//  - What a person reads never comes from a server message. The only server text drawn is `error_detail`, which the
//    importer writes itself (the first problem found in the roadmap file), and only for the two codes that name one.
//  - The numbers on screen come from the API (the import's counts, the milestone table), never from this text.
//  - A failed import leaves the previous plan on screen with its import time; the next start is allowed at once.
//  - No text node is ever "null" or "undefined": every value goes through str() or a presence check before it is drawn.
//  - Text only, built with h().

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
/** Replaces the children of `el`, leaving out the absent ones: replaceChildren(null) would draw the word "null". */
// dom-insert-ok: the filter drops every absent child before the insert
const fill = (el, ...kids) => el.replaceChildren(...kids.filter((k) => k != null && k !== false));
const str = (v) => (typeof v === "string" ? v : "");
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** How each import level is worded. Every value the API can answer has an entry; an unknown one reads as "the repository". */
export const LEVEL_WORDS = {
  roadmap_file: "the roadmap file",
  spec_tables: "the Spec task tables in your Discussions",
  issues_discussions: "your open issues and Discussions",
};
export const levelWords = (level) => (typeof level === "string" && has(LEVEL_WORDS, level) ? LEVEL_WORDS[level] : "the repository");

/** Why a plan was read at a level below the roadmap file, in words; null for the roadmap file itself. */
export function fallbackSentence(level, detail) {
  const skipped = str(detail) ? " The roadmap file was skipped because: " + str(detail).slice(0, 300) + (/[.!?]$/.test(str(detail).trim()) ? "" : ".") : "";
  if (level === "spec_tables") return "No usable roadmap file was found, so the plan was read from the Spec task tables in your Discussions." + skipped;
  if (level === "issues_discussions")
    return "No usable roadmap file or Spec task tables were found, so the plan is your open issues and Discussions. Each one is a proposal in the Inbox, and there are no milestones at this level." + skipped;
  return null;
}

/** The sentence for each of the fourteen error codes. `detail` is the importer's own first problem, used by the two codes that name one. */
export const FAILURE_CODES = [
  "repo_not_connected",
  "app_permission_missing",
  "discussions_disabled",
  "plan_file_inconsistent",
  "plan_file_too_large",
  "token_not_read_only",
  "github_unavailable",
  "rate_limited_by_github",
  "plan_file_missing",
  "plan_file_shape",
  "interrupted",
  "internal_error",
  "request_budget_exhausted",
  "plan_source_too_large",
];
const FAILURES = {
  repo_not_connected: () => "This repository isn't connected any more, so nothing was imported. Install the GitHub App on it again, then import.",
  app_permission_missing: () =>
    "The GitHub App doesn't have a permission the import needs (read access to Discussions). Open the App's settings on GitHub, accept the new permissions on this installation, then import again. Nothing was changed.",
  discussions_disabled: () => "Discussions are turned off for this repository, so its Spec tables can't be read. Turn them on in the repository's settings on GitHub, or add a roadmap file, then import again. Nothing was changed.",
  plan_file_inconsistent: (d) => "The roadmap file contradicts itself, so nothing was changed." + (str(d) ? " " + str(d).slice(0, 300) : "") + " Fix the file on GitHub, then import again.",
  plan_file_too_large: () => "The roadmap file is larger than one import can read, so nothing was changed. Trim or split it on GitHub, then import again.",
  token_not_read_only: () => "GitHub gave the import a token that could write, so it stopped before reading anything. Nothing was changed. Check the permissions of the GitHub App.",
  github_unavailable: () => "GitHub didn't answer, so nothing was changed. Try again in a few minutes.",
  rate_limited_by_github: () => "GitHub is limiting requests for this installation, so nothing was changed. Try again in a few minutes.",
  plan_file_missing: () => "The roadmap file couldn't be found, so nothing was changed.",
  plan_file_shape: (d) => "roadmap.json didn't match the expected shape" + (str(d) ? ": " + str(d).slice(0, 300) : ".") + (str(d) && !/[.!?]$/.test(str(d).trim()) ? "." : "") + " Nothing was changed.",
  interrupted: () => "The last import stopped before it finished, so nothing was changed. Import again.",
  internal_error: () => "Something went wrong on our side during the import, so nothing was changed. Try again in a moment.",
  request_budget_exhausted: () => "Reading your repo took more requests than one import is allowed, so nothing was changed.",
  plan_source_too_large: () =>
    "Your repo has more planning Discussions or Correction comments than one import can read, so nothing was changed. Hiding spam comments on GitHub brings the count back down.",
};
const FAILURE_GENERIC = "The last import failed, so nothing was changed. Try again in a moment.";
export const failureSentence = (code, detail) => (typeof code === "string" && has(FAILURES, code) ? FAILURES[code](detail) : FAILURE_GENERIC);

/** The sentences for an import start or a plan removal that was refused or failed. */
export const IMPORT_REFUSALS = {
  import_running: "An import is already running for this repository. This page updates when it finishes.",
  repo_not_connected: "This repository isn't connected any more, so nothing was imported. Install the GitHub App on it again.",
  insufficient_role: "Only an owner or an admin can import a plan.",
  session_required: "Sign in again to do this.",
  plan_import_unavailable: "Importing a plan isn't available on this server yet. Nothing was changed.",
  not_found: "This repository isn't in your account any more.",
  offline: "Couldn't reach the server, so nothing was changed. Check your connection and try again.",
  timeout: "The server took too long to answer. Check the page before you try again.",
  server_error: "Something went wrong on our side. Check the page before you try again.",
};
export function importRefusal(e) {
  if (isRateLimited(e)) return "Too many imports for this repository in the last hour. " + retryWords(waitSeconds(e));
  const code = e && typeof e.code === "string" ? e.code : "";
  if (has(IMPORT_REFUSALS, code)) return IMPORT_REFUSALS[code];
  if (e && e.kind === "server_error") return IMPORT_REFUSALS.server_error;
  return "That didn't work. Nothing was changed.";
}
export const REMOVE_REFUSALS = {
  ...IMPORT_REFUSALS,
  import_running: "An import is running, so the plan can't be removed yet. Try again when it has finished.",
};
export function removeRefusal(e) {
  const code = e && typeof e.code === "string" ? e.code : "";
  if (has(REMOVE_REFUSALS, code)) return REMOVE_REFUSALS[code];
  if (e && e.kind === "server_error") return REMOVE_REFUSALS.server_error;
  return "That didn't work. Nothing was removed.";
}

export const NEVER_SENTENCE = "Nothing has been imported for this repository yet. Import its plan to see its milestones and tasks.";
export const QUEUED_SENTENCE = "The import is queued. This page updates when it starts.";
export const RUNNING_SENTENCE = "Importing the plan from GitHub. This page updates when it finishes.";
export const STALE_SENTENCE = "The last import stopped without finishing, so nothing was changed. Import again to start over.";
export const TRUNCATED_SENTENCE = "The import stopped at a size limit, so some tasks or items may be missing.";
export const DETACHED_SENTENCE = "This repository isn't connected any more. Its plan and proposals stay readable here, but importing is turned off.";
export const EMPTY_SENTENCE = "The import found no tasks and no open items to propose.";
export const ISSUES_LEVEL_EMPTY = "This repository has no task plan, so there are no milestones to show. Any open issues and Discussions it had are in the Inbox as proposals.";
/** An import that is still queued or running after this long is treated as dead: the server closes it as interrupted on the next start. */
export const STALE_MS = 10 * 60 * 1000;
export const POLL_MS = 3000;

export const TASK_STATUS_WORDS = { done: "Done", partial: "Partly done", open: "In progress", not_started: "Not started", pending_spec: "Waiting for a Spec" };
export const taskStatusWords = (s) => (typeof s === "string" && has(TASK_STATUS_WORDS, s) ? TASK_STATUS_WORDS[s] : "");

export function formatWhen(iso) {
  const d = new Date(str(iso));
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** True when an import row is still going: queued or running and not older than STALE_MS. */
export function importIsLive(imp, now = Date.now()) {
  if (!imp || (imp.state !== "queued" && imp.state !== "running")) return false;
  const t = Date.parse(str(imp.started_at));
  return !(Number.isFinite(t) && now - t > STALE_MS);
}
const importIsStale = (imp, now) => !!imp && (imp.state === "queued" || imp.state === "running") && !importIsLive(imp, now);

const when = (iso) => {
  const w = formatWhen(iso);
  return w ? ", " + w : "";
};
/** "Imported from the roadmap file .autonomous-team/roadmap.json, Oct 15, 2:02 PM: 520 tasks, 242 done, 278 remaining." */
export function succeededLine(imp) {
  const c = imp.counts && typeof imp.counts === "object" ? imp.counts : {};
  const where = imp.level === "roadmap_file" && str(imp.source_path) ? "the roadmap file " + imp.source_path : levelWords(imp.level);
  const numbers = isNum(c.tasks) && isNum(c.done) && isNum(c.remaining) ? ": " + c.tasks + " tasks, " + c.done + " done, " + c.remaining + " remaining" : "";
  return "Imported from " + where + when(imp.finished_at) + numbers + ".";
}

/**
 * The sentences for the latest import, in the order they are shown. `from` is the newest import that succeeded (the one the
 * rows on screen came from). A failed latest import keeps the previous plan on screen and says so.
 */
export function importSentences(latest, from, now = Date.now()) {
  if (!latest) return [NEVER_SENTENCE];
  if (latest.state === "queued" && importIsLive(latest, now)) return [QUEUED_SENTENCE];
  if (latest.state === "running" && importIsLive(latest, now)) return [RUNNING_SENTENCE];
  const out = [];
  if (importIsStale(latest, now)) out.push(STALE_SENTENCE);
  else if (latest.state === "failed") out.push(failureSentence(latest.error_code, latest.error_detail));
  else if (latest.state === "succeeded") {
    out.push(succeededLine(latest));
    const why = fallbackSentence(latest.level, latest.error_detail);
    if (why) out.push(why);
    if (latest.truncated === true) out.push(TRUNCATED_SENTENCE);
    return out;
  }
  if (from && from.id !== latest.id) out.push("Your previous plan, imported" + (formatWhen(from.finished_at) ? " " + formatWhen(from.finished_at) : "") + ", is still shown.");
  else if (!from) out.push("There is no earlier plan, so nothing is shown below.");
  return out;
}

/**
 * `getRepo()` answers { id, name, connected } for the picked repository, or null. `onChange` is told when the approved list
 * changes. A plan is read with GET /repos/{id}/plan; the approved proposals with GET /proposals?state=approved.
 */
export function createPlan({ call = api, getRepo, setTimer = setTimeout, clearTimer = clearTimeout, now = () => Date.now() }) {
  const view = h("div", { class: "pl-plan-view" });
  const live = h("p", { class: "pl-sr", role: "status", "aria-live": "polite", "data-testid": "pl-plan-live" });
  const root = h("section", { class: "pl-plan", "aria-labelledby": "pl-plan-h", "data-testid": "pl-plan" }, view, live);
  let plan = null; // the GET /plan answer
  let approved = null; // [] of proposals, or null while unread
  let approvedFailed = false;
  let status = "idle"; // idle | loading | ready | error
  let errorSentence = "";
  let note = ""; // the outcome of the last click
  let importing = false;
  let removing = false;
  let confirming = false;
  let showEvidence = false;
  let limited = 0;
  const open = new Map(); // milestone key -> { status: loading|ready|error, tasks, next, more }
  let poll = null;
  let ac = null;
  let seq = 0;
  let destroyed = false;
  let loadedFor = null;
  // True from stop() (the tab was left) until show() (it was opened again): nothing is read and no poll is armed meanwhile.
  let stopped = false;
  let lastStatus = null; // the import sentences last painted, so a change is announced once

  const gate = createRetryGate({
    onChange: (remaining) => {
      limited = remaining;
      if (remaining === 0 && note.startsWith("Too many imports")) note = "";
      paint();
    },
  });

  const repoId = () => {
    const r = getRepo();
    return r ? r.id : null;
  };
  const stopPoll = () => {
    if (poll !== null) clearTimer(poll);
    poll = null;
  };
  // Leaving the tab: stop the timer, drop the request that is out, and keep any load that finishes later from arming it again.
  const stop = () => {
    stopped = true;
    stopPoll();
    if (ac) ac.abort();
    ac = null;
    seq++;
  };
  // Opening the tab again: reads the plan and, while an import is live, polls.
  const show = () => {
    stopped = false;
    lastStatus = null;
    return load();
  };
  const announce = (text) => {
    sayLive(live, text);
  };

  async function load({ quiet = false } = {}) {
    stopPoll();
    if (stopped) return;
    const repo = getRepo();
    const mine = ++seq;
    if (ac) ac.abort();
    ac = null;
    if (!repo) {
      plan = approved = null;
      status = "ready";
      loadedFor = null;
      paint();
      return;
    }
    if (loadedFor !== repo.id) {
      plan = approved = null;
      loadedFor = repo.id;
      lastStatus = null;
      note = "";
      open.clear();
      showEvidence = false;
      confirming = false;
    }
    ac = new AbortController();
    const signal = ac.signal;
    if (!quiet || !plan) {
      status = "loading";
      paint();
    }
    try {
      const p = await call("GET", "/api/v1/repos/" + encodeURIComponent(repo.id) + "/plan", undefined, signal);
      if (mine !== seq || destroyed) return;
      plan = p && typeof p === "object" && Array.isArray(p.milestones) ? p : null;
      if (!plan) throw new Error("malformed plan");
      status = "ready";
      errorSentence = "";
      if (!quiet) open.clear();
    } catch (e) {
      if ((e && e.name === "AbortError") || mine !== seq || destroyed) return;
      status = "error";
      errorSentence = e && e.code === "not_found" ? IMPORT_REFUSALS.not_found : "The plan couldn't be loaded.";
      paint();
      return;
    }
    paint();
    await loadApproved(repo.id, signal, mine);
    if (mine !== seq || destroyed) return;
    paint();
    const latest = plan && plan.latest_import;
    if (!stopped && importIsLive(latest, now())) poll = setTimer(() => load({ quiet: true }), POLL_MS);
  }

  async function loadApproved(id, signal, mine) {
    const rows = [];
    let cursor = null;
    try {
      for (let page = 0; page < 20; page++) {
        const body = await call("GET", "/api/v1/proposals?repo_id=" + encodeURIComponent(id) + "&state=approved" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""), undefined, signal);
        if (mine !== seq || destroyed) return;
        for (const p of body && Array.isArray(body.proposals) ? body.proposals : []) if (p && typeof p.id === "string" && str(p.title)) rows.push(p);
        cursor = body && typeof body.next_cursor === "string" && body.next_cursor !== "" ? body.next_cursor : null;
        if (!cursor) break;
      }
      approved = rows.sort((a, b) => (isNum(a.roadmap_position) ? a.roadmap_position : 1e9) - (isNum(b.roadmap_position) ? b.roadmap_position : 1e9));
      approvedFailed = false;
    } catch (e) {
      if ((e && e.name === "AbortError") || mine !== seq || destroyed) return;
      approvedFailed = true;
      approved = approved || [];
    }
  }

  async function startImport() {
    const id = repoId();
    if (!id || importing) return;
    importing = true;
    note = "Starting the import…";
    announce(note);
    paint();
    try {
      await call("POST", "/api/v1/repos/" + encodeURIComponent(id) + "/plan-imports", undefined);
      note = "";
      importing = false;
      await load({ quiet: true });
      return;
    } catch (e) {
      if (e && e.name === "AbortError") {
        note = "";
      } else {
        note = importRefusal(e);
        if (isRateLimited(e)) gate.start(waitSeconds(e));
        announce(note);
        if (e && e.code === "import_running") {
          importing = false;
          await load({ quiet: true });
          return;
        }
      }
    }
    importing = false;
    paint();
  }

  async function removePlan() {
    const id = repoId();
    if (!id || removing) return;
    removing = true;
    confirming = false;
    note = "Removing the imported plan…";
    announce(note);
    paint();
    try {
      const res = await call("DELETE", "/api/v1/repos/" + encodeURIComponent(id) + "/plan", undefined);
      const r = res && res.removed && typeof res.removed === "object" ? res.removed : {};
      const parts = [];
      if (isNum(r.tasks_removed)) parts.push(r.tasks_removed + (r.tasks_removed === 1 ? " task" : " tasks"));
      if (isNum(r.proposals_removed)) parts.push(r.proposals_removed + (r.proposals_removed === 1 ? " undecided proposal" : " undecided proposals"));
      note = "The imported plan was removed" + (parts.length ? " (" + parts.join(" and ") + ")" : "") + ". Approved and rejected proposals were kept. You can import it again at any time.";
      announce(note);
      removing = false;
      await load();
      return;
    } catch (e) {
      note = e && e.name === "AbortError" ? "" : removeRefusal(e);
      announce(note);
    }
    removing = false;
    paint();
  }

  async function expand(m) {
    const have = open.get(m.key);
    if (have) {
      open.delete(m.key);
      paint();
      return;
    }
    open.set(m.key, { status: "loading", tasks: [], next: null, more: false });
    paint();
    await readTasks(m.key, null);
  }

  async function readTasks(key, cursor) {
    const id = repoId();
    if (!id) return;
    const mine = seq;
    const entry = open.get(key);
    if (!entry) return;
    try {
      const body = await call("GET", "/api/v1/repos/" + encodeURIComponent(id) + "/plan?milestone=" + encodeURIComponent(key) + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""), undefined, ac ? ac.signal : undefined);
      if (mine !== seq || destroyed || open.get(key) !== entry) return;
      const rows = body && Array.isArray(body.tasks) ? body.tasks.filter((t) => t && str(t.task_key) && str(t.title)) : [];
      entry.tasks = cursor ? entry.tasks.concat(rows) : rows;
      entry.next = body && typeof body.next_cursor === "string" && body.next_cursor !== "" ? body.next_cursor : null;
      entry.status = "ready";
    } catch (e) {
      if ((e && e.name === "AbortError") || mine !== seq || destroyed || open.get(key) !== entry) return;
      entry.status = "error";
    }
    paint();
  }

  // ---- drawing ----

  function evidence(imp) {
    if (!imp || !showEvidence) return null;
    const reqs = Array.isArray(imp.github_requests) ? imp.github_requests.filter((r) => r && str(r.method) && str(r.path)) : [];
    const perms = imp.token_permissions && typeof imp.token_permissions === "object" ? imp.token_permissions : {};
    return h(
      "div",
      { class: "pl-plan-evidence", id: "pl-plan-evidence", "data-testid": "pl-plan-evidence" },
      h("h3", {}, "What the import asked GitHub (" + reqs.length + (reqs.length === 1 ? " request)" : " requests)")),
      reqs.length
        ? h("ul", {}, reqs.map((r) => h("li", { class: "pl-plan-req", "data-method": r.method }, r.method + " " + r.path + (isNum(r.status) ? " → " + r.status : ""))))
        : h("p", { class: "pl-plan-line" }, "It made no requests."),
      h("h3", {}, "Token permissions GitHub reported"),
      Object.keys(perms).length
        ? h("ul", {}, Object.keys(perms).sort().map((k) => h("li", { class: "pl-plan-perm", "data-level": str(perms[k]) }, k + ": " + str(perms[k]))))
        : h("p", { class: "pl-plan-line" }, "GitHub reported none.")
    );
  }

  function taskList(m, entry) {
    if (entry.status === "loading") return h("p", { class: "pl-plan-line" }, "Loading the tasks…");
    if (entry.status === "error")
      return h("div", {}, h("p", { role: "alert" }, "The tasks couldn't be loaded."), h("button", { type: "button", class: "pl-btn", onClick: () => ((entry.status = "loading"), paint(), readTasks(m.key, null)) }, "Try again"));
    if (entry.tasks.length === 0) return h("p", { class: "pl-plan-line" }, "This milestone has no tasks.");
    return h(
      "div",
      {},
      h(
        "ul",
        { class: "pl-plan-tasks", "aria-label": "Tasks in " + (str(m.title) || m.key) },
        entry.tasks.map((t) => {
          const words = taskStatusWords(t.status);
          const planned = isNum(t.planned_prs) && t.planned_prs > 0 && Array.isArray(t.merged_prs) ? " · " + t.merged_prs.length + " of " + t.planned_prs + " pull requests merged" : "";
          return h("li", { class: "pl-plan-task", "data-testid": "pl-plan-task", "data-status": str(t.status) }, h("span", { class: "pl-plan-task-title" }, t.title), h("span", { class: "pl-plan-task-meta" }, t.task_key + (words ? " · " + words : "") + planned));
        })
      ),
      entry.next ? h("button", { type: "button", class: "pl-btn", "data-testid": "pl-plan-more", onClick: () => readTasks(m.key, entry.next) }, "Show more tasks") : null
    );
  }

  const detailId = (key) => "pl-plan-detail-" + String(key).replace(/[^A-Za-z0-9_-]/g, "_");

  function table() {
    if (!plan || plan.milestones.length === 0) return null;
    const rows = [];
    for (const m of plan.milestones) {
      if (!m || !str(m.key) || !isNum(m.tasks) || !isNum(m.done) || !isNum(m.remaining)) continue;
      const entry = open.get(m.key);
      const label = str(m.title) || m.key;
      rows.push(
        h(
          "tr",
          { "data-testid": "pl-plan-milestone", "data-key": m.key },
          h(
            "th",
            { scope: "row" },
            h(
              "button",
              { type: "button", class: "pl-plan-toggle", "aria-expanded": String(!!entry), "aria-controls": detailId(m.key), "data-focus": "ms:" + m.key, onClick: () => expand(m) },
              h("span", { "aria-hidden": "true" }, entry ? "▾ " : "▸ "),
              label
            )
          ),
          h("td", {}, String(m.tasks)),
          h("td", {}, String(m.done)),
          h("td", {}, String(m.remaining))
        )
      );
      if (entry) rows.push(h("tr", { class: "pl-plan-detail", id: detailId(m.key) }, h("td", { colspan: "4" }, taskList(m, entry))));
    }
    const t = plan.totals && typeof plan.totals === "object" ? plan.totals : null;
    return h(
      "table",
      { class: "pl-plan-table", "data-testid": "pl-plan-table" },
      h("caption", { class: "pl-sr" }, "Milestones of the imported plan"),
      h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Milestone"), h("th", { scope: "col" }, "Tasks"), h("th", { scope: "col" }, "Done"), h("th", { scope: "col" }, "Remaining"))),
      h("tbody", {}, rows),
      t && isNum(t.tasks) && isNum(t.done) && isNum(t.remaining)
        ? h("tfoot", {}, h("tr", {}, h("th", { scope: "row" }, "Total"), h("td", {}, String(t.tasks)), h("td", {}, String(t.done)), h("td", {}, String(t.remaining))))
        : null
    );
  }

  function roadmap() {
    if (approved === null) return null;
    return h(
      "div",
      { class: "pl-plan-roadmap", "data-testid": "pl-plan-roadmap" },
      h("h3", {}, "Approved in fulcrumaxe"),
      approvedFailed ? h("p", { role: "alert" }, "The approved list couldn't be loaded.") : null,
      approved.length === 0 && !approvedFailed
        ? h("p", { class: "pl-plan-line", "data-testid": "pl-plan-roadmap-empty" }, "Nothing has been approved yet. Approve a proposal in the Inbox to put it here.")
        : h(
            "ol",
            { class: "pl-plan-approved", "aria-label": "Approved in fulcrumaxe" },
            approved.map((p) => {
              const stage = stageWords(p.work_item_stage);
              const ms = str(p.milestone_title) || str(p.milestone_key);
              return h("li", { "data-testid": "pl-plan-approved", "data-id": p.id }, h("span", { class: "pl-plan-task-title" }, p.title), h("span", { class: "pl-plan-task-meta" }, [stage ? "Stage: " + stage : "", ms].filter(Boolean).join(" · ")));
            })
          )
    );
  }

  function emptyState() {
    if (!plan || plan.milestones.length > 0) return null;
    const from = plan.imported_from;
    if (!from) return null;
    return h("p", { class: "pl-plan-line", "data-testid": "pl-plan-empty" }, from.level === "issues_discussions" ? ISSUES_LEVEL_EMPTY : EMPTY_SENTENCE);
  }

  function paint() {
    if (destroyed) return;
    const active = view.contains(document.activeElement) ? document.activeElement : null;
    const key = active && active.getAttribute ? active.getAttribute("data-focus") : null;
    const repo = getRepo();
    const head = h("h2", { id: "pl-plan-h", class: "pl-panel-title", tabindex: "-1", "data-focus": "heading" }, repo ? "Plan for " + repo.name : "Plan");
    if (!repo) {
      fill(view, head, h("p", { class: "pl-plan-line", "data-testid": "pl-plan-empty" }, "Pick a repository to see its plan."));
      return;
    }
    if (status === "loading" && !plan) {
      fill(view, head, h("p", { class: "pl-plan-line", "data-testid": "pl-plan-loading" }, "Loading the plan…"));
      return;
    }
    if (status === "error" && !plan) {
      fill(view,
        head,
        h("div", { "data-testid": "pl-plan-error" }, h("p", { role: "alert" }, errorSentence || "The plan couldn't be loaded."), h("button", { type: "button", class: "pl-btn", "data-focus": "retry", onClick: () => load() }, "Try again"))
      );
      return;
    }
    const latest = plan ? plan.latest_import : null;
    const liveNow = importIsLive(latest, now());
    const connected = repo.connected;
    const sentences = importSentences(latest, plan ? plan.imported_from : null, now());
    const canRemove = !!latest || (plan && plan.milestones.length > 0);
    const busy = importing || liveNow || !connected || limited > 0;
    // The import status changes by polling and the block is rebuilt on every paint, so a change is said once in the live region.
    const statusText = sentences.join(" ");
    if (lastStatus !== null && statusText !== lastStatus) announce(statusText);
    lastStatus = statusText;
    fill(view,
      head,
      !connected ? h("p", { class: "pl-plan-line", "data-testid": "pl-plan-detached" }, DETACHED_SENTENCE) : null,
      h(
        "div",
        { class: "pl-plan-head" },
        h("button", { type: "button", class: "pl-btn", "data-testid": "pl-plan-import", "data-focus": "import", "aria-disabled": busy ? "true" : "false", onClick: () => !busy && startImport() }, "Import plan"),
        latest ? h("button", { type: "button", class: "pl-btn", "data-testid": "pl-plan-evidence-toggle", "data-focus": "evidence", "aria-expanded": String(showEvidence), "aria-controls": "pl-plan-evidence", onClick: () => ((showEvidence = !showEvidence), paint()) }, showEvidence ? "Hide what it asked GitHub" : "Show what it asked GitHub") : null,
        canRemove && !confirming ? h("button", { type: "button", class: "pl-btn", "data-testid": "pl-plan-remove", "data-focus": "remove", "aria-disabled": removing || liveNow ? "true" : "false", onClick: () => !(removing || liveNow) && ((confirming = true), paint()) }, "Remove imported plan") : null
      ),
      confirming
        ? h(
            "div",
            { class: "pl-plan-confirm", role: "group", "aria-label": "Remove the imported plan?", "data-testid": "pl-plan-confirm" },
            h("p", {}, "Remove the imported plan for " + repo.name + "? Its milestones and tasks go, and so do the proposals nobody has decided on. Approved and rejected proposals stay, and no work item is touched. Importing again brings the plan back."),
            h("button", { type: "button", class: "pl-btn", "data-testid": "pl-plan-remove-yes", "data-focus": "remove-yes", "aria-disabled": removing ? "true" : "false", onClick: () => !removing && removePlan() }, "Yes, remove the plan"),
            h("button", { type: "button", class: "pl-btn", "data-testid": "pl-plan-remove-no", "data-focus": "remove-no", onClick: () => ((confirming = false), paint()) }, "Keep it")
          )
        : null,
      h("div", { class: "pl-plan-status", "data-testid": "pl-plan-status" }, sentences.map((s) => h("p", { class: "pl-plan-line" }, s))),
      note ? h("p", { class: "pl-plan-sentence", "data-testid": "pl-plan-note" }, note) : null,
      status === "error" ? h("p", { role: "alert" }, errorSentence || "The plan couldn't be loaded.") : null,
      evidence(latest),
      emptyState(),
      table(),
      roadmap()
    );
    if (key) {
      const again = [...view.querySelectorAll("[data-focus]")].find((n) => n.getAttribute("data-focus") === key);
      const fallback = confirming ? "remove-no" : key === "remove-yes" || key === "remove-no" ? "remove" : null;
      // The button is gone (the plan was removed, so is its button): the safe next stop is the one after it, else the heading.
      const target = again || (fallback ? [...view.querySelectorAll("[data-focus]")].find((n) => n.getAttribute("data-focus") === fallback) : null) || view.querySelector("#pl-plan-h");
      if (target) target.focus();
    }
  }

  paint();
  return {
    el: root,
    load: show,
    show,
    stop,
    destroy() {
      destroyed = true;
      stopPoll();
      if (ac) ac.abort();
      gate.cancel();
      view.replaceChildren();
    },
  };
}
