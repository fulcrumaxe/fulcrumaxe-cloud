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
import { h, timeNode } from "../_lib/dom.js";


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

/** One agent run as a section: its phase, a title, whether it starts open, its summary and its newest lines. */
export function runView(run, maxLines = 40) {
  const live = LIVE_STATUSES.has(run.status);
  const lines = Array.isArray(run.lines) ? run.lines : [];
  return {
    key: "r:" + run.id,
    phase: phaseOf(run.role),
    role: roleWord(run.role),
    status: run.status,
    statusWord: statusWord(run.status),
    live,
    openByDefault: live,
    cost: usdText(run.usd),
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
  merged: "Merge gate: merged",
  ready_human_merges: "Merge gate: not merged, a person merges",
  pr_not_open: "Merge gate: the pull request is not open",
  head_moved: "Merge gate: the pull request changed after review",
  refused: "Merge gate: refused",
};
const REASON_WORDS = {
  pr_draft: "the pull request is a draft",
  head_sha_malformed: "the pull request's head could not be read",
  run_timestamp_invalid: "a review run has an invalid time",
  ci_not_green: "CI is not green",
  auto_merge_not_allowed: "auto-merge is not allowed",
  human_merge_only: "the operator set this repository so that a person merges",
  merge_call_refused: "GitHub refused the merge",
};
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
  const reasons = Array.isArray(step.reasons) ? step.reasons.map(reasonWord) : [];
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
  if (n.kind === "no_file_list" || n.kind === "respec_failed") return { kind: n.kind, title: "", lead: "", tail: "", reason: n.reason };
  return null;
}

/** The "Ready to merge" banner, only at review_passed, with the repo's real auto-merge setting. */
export function readyBanner(data) {
  if (!data || data.stage !== "review_passed") return null;
  return {
    title: "Ready to merge",
    detail: "Every required reviewer passed.",
    autoMerge: data.auto_merge === true,
    autoMergeText: data.auto_merge === true ? "Auto-merge is on for this repo: it merges once the merge gate and CI are green." : "Auto-merge is off for this repo: a person merges the pull request on GitHub.",
    url: pullUrl(data),
  };
}

/** Everything the panel draws, from one response. */
export function buildInsight(data) {
  const runs = (Array.isArray(data.runs) ? data.runs : []).map((r) => runView(r));
  const running = runs.filter((r) => r.live);
  const finished = runs.filter((r) => !r.live);
  const spent = (Array.isArray(data.runs) ? data.runs : []).reduce((n, r) => n + (!LIVE_STATUSES.has(r.status) && Number.isFinite(r.usd) ? r.usd : 0), 0);
  return {
    notice: noticeBanner(data),
    banner: readyBanner(data),
    runningText: running.length ? "Running now: " + running.map((r) => r.role).join(", ") : "Nothing is running right now.",
    totalsText: finished.length + " agent run" + (finished.length === 1 ? "" : "s") + " finished" + (finished.length ? " · $" + spent.toFixed(2) + " so far" : ""),
    runs,
    runsTruncated: data.runs_truncated === true,
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
  noActivity: "No activity recorded for this run yet.",
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

  function banner(b) {
    return h(
      "div",
      { class: "pl-ins-ready", "data-testid": "pl-ready", role: "status" },
      h("strong", null, b.title + ". "),
      b.detail + " ",
      h("span", { "data-testid": "pl-ready-merge", "data-auto-merge": b.autoMerge ? "on" : "off" }, b.autoMergeText + " "),
      b.url ? h("a", { href: b.url, target: "_blank", rel: "noopener noreferrer", "data-testid": "pl-ready-link" }, "Open the pull request on GitHub") : null
    );
  }

  function noticeView(n) {
    const needsHuman = n.kind === "needs_human";
    return h(
      "div",
      { class: "pl-ins-notice", "data-testid": needsHuman ? "pl-needs-human" : n.kind === "check_failed" ? "pl-check-failed" : n.kind === "no_file_list" ? "pl-no-file-list" : n.kind === "respec_failed" ? "pl-respec-failed" : "pl-not-feasible", "data-kind": n.kind, role: "status" },
      h("strong", null, n.title),
      n.lead,
      needsHuman ? text(n.reason) : h("span", { "data-testid": "pl-notice-reason" }, n.reason),
      n.tail
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
      r.lines.length
        ? h(
            "ol",
            { class: "pl-ins-feed", "data-testid": "pl-feed" },
            r.hiddenLines ? h("li", { class: "pl-muted" }, "Earlier activity isn't shown.") : null,
            r.lines.map((l) => h("li", null, l))
          )
        : h("p", { class: "pl-muted" }, SENTENCES.noActivity)
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
   * scrolled ancestor, and which section's summary had focus, are saved first and put back after the redraw.
   */
  function render() {
    const saved = [];
    for (let n = el.parentElement; n; n = n.parentElement) if (n.scrollTop > 0) saved.push([n, n.scrollTop]);
    const active = typeof document !== "undefined" ? document.activeElement : null;
    const focusDetails = active && typeof el.contains === "function" && el.contains(active) && typeof active.closest === "function" ? active.closest("details[data-key]") : null;
    const focusKey = focusDetails ? focusDetails.getAttribute("data-key") : null;
    draw();
    if (focusKey !== null) {
      const again = [...el.querySelectorAll("details[data-key]")].find((d) => d.getAttribute("data-key") === focusKey);
      const summary = again && again.querySelector("summary");
      if (summary) summary.focus({ preventScroll: true });
    }
    for (const [n, top] of saved) n.scrollTop = top;
  }

  function draw() {
    if (state.status === "idle" || state.status === "loading") {
      el.replaceChildren(h("p", { class: "pl-muted", role: "status", "data-testid": "pl-live-state" }, SENTENCES.loading));
      return;
    }
    if (state.status === "error" && !state.data) {
      el.replaceChildren(h("p", { class: "pl-muted", role: "status", "data-testid": "pl-live-state" }, SENTENCES.error));
      return;
    }
    const m = buildInsight(state.data);
    // h() skips null children; the native replaceChildren would print "null" for one.
    el.replaceChildren(
      h(
        "div",
        { class: "pl-ins-body" },
      h("h3", { class: "pl-detail-sub" }, "What's happening"),
      state.stale ? h("p", { class: "pl-muted", role: "status", "data-testid": "pl-live-state" }, SENTENCES.stale) : null,
      m.notice ? noticeView(m.notice) : null,
      m.banner ? banner(m.banner) : null,
      h("p", { "data-testid": "pl-running" }, m.runningText),
      h("p", { class: "pl-muted", "data-testid": "pl-totals" }, m.totalsText),
      h("h3", { class: "pl-detail-sub" }, m.runs.length ? "Agent runs (" + m.runs.length + ")" : "Agent runs"),
      m.runs.length ? m.runs.map(runSection) : h("p", { class: "pl-muted", "data-testid": "pl-no-runs" }, SENTENCES.noRuns),
      m.runsTruncated ? h("p", { class: "pl-muted" }, SENTENCES.olderRuns) : null,
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
                  s.at ? [timeNode(s.at, true), " "] : null,
                  s.text,
                  s.reasons.length ? h("span", { class: "pl-muted" }, " — " + s.reasons.join("; ")) : null
                )
              )
            ),
          ]
        : null,
      m.commentCount
        ? fold("panel", false, { class: "pl-ins-panel", "data-testid": "pl-panel" }, [h("strong", null, "Panel discussion"), " · " + m.commentCount + " comment" + (m.commentCount === 1 ? "" : "s")], m.commentsTruncated ? h("p", { class: "pl-muted" }, SENTENCES.olderComments) : null, roundBlock("Round 1", m.rounds.round1), roundBlock("Challenge round", m.rounds.challenge))
        : h("p", { class: "pl-muted", "data-testid": "pl-no-panel" }, SENTENCES.noPanel),
      m.spec
        ? fold("spec", false, { class: "pl-ins-spec", "data-testid": "pl-spec" }, [h("strong", null, "Spec"), " · version " + m.spec.version], text(m.spec.body))
        : h("p", { class: "pl-muted", "data-testid": "pl-no-spec" }, SENTENCES.noSpec)
      )
    );
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
