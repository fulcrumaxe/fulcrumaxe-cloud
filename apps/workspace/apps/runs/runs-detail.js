// D#483 P5: the Runs detail's "what this run did": its outcome, cost, activity and facts.
//
// Input is the body of GET /api/v1/runs/{id}/insight. The first half is a pure model (no DOM, no network, no clock):
// every sentence is chosen from recorded fields only, and where the record has nothing the model says nothing rather
// than guessing. The second half draws it. Model text (the summary, a finding, an activity line) is only ever given to
// h() as a string child, which makes a text node: nothing here builds markup from it.
//
// One file for both halves because the Runs app has a per-app boot-file ceiling (build/budget.mjs).
import { h, timeNode } from "../_lib/dom.js";
import { crossesBoundary, displayText, nextCarry } from "./runs-display-filter.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const word = (s) => String(s).replace(/[_-]+/g, " ");

const ROLE_WORDS = {
  "project-manager": ["Triage & Spec", "Project manager"],
  "technical-architect": ["Panel", "Technical architect"],
  "product-owner": ["Panel", "Product owner"],
  "performance-expert": ["Panel", "Performance expert"],
  "security-expert": ["Panel", "Security expert"],
  "cost-analyst": ["Panel", "Cost analyst"],
  executor: ["Build", "Executor"],
  "code-reviewer": ["Review", "Code reviewer"],
  "acceptance-tester": ["Review", "Acceptance tester"],
  "security-reviewer": ["Review", "Security reviewer"],
  debater: ["Review", "Debater"],
  "accessibility-reviewer": ["Review", "Accessibility reviewer"],
  "browser-tester": ["Review", "Browser tester"],
};
const REVIEWERS = new Set(["code-reviewer", "acceptance-tester", "security-reviewer", "debater", "accessibility-reviewer", "browser-tester", "security-expert"]);

/** "Review · Code reviewer"; a role this file does not know is shown as its own words. */
export function titleOf(role) {
  const known = ROLE_WORDS[role];
  if (known) return known[0] + " · " + known[1];
  return typeof role === "string" && role ? word(role) : "Agent run";
}

const VERDICTS = {
  pass: { label: "Pass", tone: "ok" },
  "needs-fix": { label: "Needs fix", tone: "warn" },
  fail: { label: "Fail", tone: "bad" },
};
/** The verdict as a chip: the three review verdicts by name; any other recorded word as that word. */
export function verdictView(verdict) {
  if (typeof verdict !== "string" || verdict === "") return null;
  return VERDICTS[verdict] || { label: word(verdict), tone: "plain" };
}

/** "12m 30s" between two instants; a run still going is measured to the server's clock. Null when it never started. */
export function durationText(run, serverTime) {
  const start = Date.parse(run.started_at);
  const end = Date.parse(run.ended_at || serverTime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const s = Math.round((end - start) / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m " + String(s % 60).padStart(2, "0") + "s";
  return Math.floor(m / 60) + "h " + String(m % 60).padStart(2, "0") + "m";
}

const usd = (n) => (Number.isFinite(n) ? "$" + (n !== 0 && Math.abs(n) < 0.01 ? n.toFixed(4) : n.toFixed(2)) : null);
const tokens = (n) => (Number.isFinite(n) ? n.toLocaleString("en-US") : null);

const MODEL_BILL = {
  operator_subscription: "On the operator's subscription",
  customer_gateway: "On your AI Gateway key",
  customer_anthropic: "On your Anthropic key",
};
const COMPUTE_BILL = { sandbox: "Sandbox compute, billed to the workspace", workflow: "Workflow compute, billed to the workspace" };

/**
 * The model-usage line of a run on the person's own machine (D#6 R2b-5b). What it would have cost at API prices: information, never
 * spend, so it is never worded as a charge. `u.api_equivalent_usd` is the cloud's own figure; null means the model has no price row.
 */
export function runnerUsageLine(u) {
  const price = Number.isFinite(u.api_equivalent_usd) ? usd(u.api_equivalent_usd) : null;
  const toks = (tokens(u.tokens_in) || "0") + " in / " + (tokens(u.tokens_out) || "0") + " out tokens";
  if (u.credential_mode === "api_key") return "On your own API key · " + (price ? price + " at API prices" : "no API price for this model") + " · " + toks;
  return "On your Claude plan · " + (price ? "API-equivalent " + price : "no API price for this model") + " · " + toks;
}

/**
 * The two cost lines, separately. Each says what is recorded and, only when the record names it, whose bill it is on.
 * `runnerUsage` is the insight's `runner_usage`: undefined for a sandbox run (its output is unchanged), null for a run on the
 * person's machine that recorded no usage yet, else the object.
 */
export function costRows(cost, status, runnerUsage, usage = {}) {
  const m = isObj(cost) && isObj(cost.model) ? cost.model : {};
  const c = isObj(cost) && isObj(cost.compute) ? cost.compute : {};
  const live = status === "pending" || status === "running";
  if (runnerUsage !== undefined) {
    const u = isObj(runnerUsage) ? runnerUsage : null;
    // D#6 C42-3b: a finished run's state and the sentence for a state with no figure. A missing figure is never drawn as $0.
    const note = typeof usage.note === "string" && usage.note !== "" ? usage.note : null;
    return [
      { key: "model", label: "Model usage", value: u ? runnerUsageLine(u) : live && usage.state !== "not_recorded" ? "Counting…" : "Not recorded", bill: null, detail: u ? note || "Estimate, priced at this run's model" : note },
      { key: "compute", label: "Compute", value: "Ran on your machine: no sandbox compute", bill: null, detail: null },
    ];
  }
  const tok = [tokens(m.tokens_in) && tokens(m.tokens_in) + " in", tokens(m.tokens_out) && tokens(m.tokens_out) + " out"].filter(Boolean).join(", ");
  const modelValue = m.source === "operator_subscription" ? "No per-token charge" : usd(m.usd) || (live ? "Counting…" : "Not recorded");
  const computeValue = usd(c.usd) || (live ? "Settled when the run ends" : "Not recorded");
  return [
    { key: "model", label: "Model usage", value: modelValue, bill: MODEL_BILL[m.source] || null, detail: tok || null },
    { key: "compute", label: "Sandbox compute", value: computeValue, bill: COMPUTE_BILL[c.source] || null, detail: null },
  ];
}

// D#6 R2b-5b: one line for each event the runner sends. The words of the run_ended lines are the runner protocol's copy.ts
// (test/runs-detail.test.mjs pins each against it); nothing here reads model text, a diff or a command line, because none is sent.
const RUN_ENDED_LINES = {
  job_refused: (d) => "Your runner refused this job (" + d + "). Update the runner, then retry.",
  agent_failed: () => "The agent stopped without finishing. Retry, or open the run for details.",
  push_rejected: () => "Your runner could not push to the pull request's branch, because the branch changed while the agent was working. Retry to run on the new head.",
};
const SETUP_LINES = {
  clone_limited: "This repository has used today's download allowance through our proxy. The runner keeps a copy, so this is rare. It resets at 00:00 UTC.",
  push_ref_refused: "The runner would not publish the agent's work, because it was not shaped like a run's branch. Nothing was published. Build again.",
  snapshot_refused: "The runner could not safely copy the agent's work out of its folder (it may be too large), so nothing was published. Build again.",
  push_failed: "The runner could not push the agent's work to GitHub with your git credentials, so nothing was published. Check that git can push to this repository from that machine, then Build again.",
  mirror_failed: "The runner could not update its local copy of this repository, so the run did not start. Check the runner machine's git access to the repository, then Build again.",
  mirror_dir_insecure: "The folder where the runner keeps its repository copies is not private enough to use. Fix its permissions, then Build again.",
  git_version_unsupported: "The git on the runner machine is too old. Update git, then Build again.",
  workspace_failed: "The runner could not prepare a working folder for the agent. Check the disk space and git access on that machine, then Build again.",
  workspace_git_refused: "The runner could not safely read the agent's git folder, so nothing was published. Update fx-runner, then Build again.",
  head_not_from_base: "The agent's work did not start from this run's starting point, so the runner did not publish it. Build again.",
  sandbox_stub_committed: "The agent committed empty placeholder files the sandbox makes, so the runner did not publish it. Build again.",
};
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const num = (v) => (Number.isFinite(v) ? v : null);

function runEndedLine(p) {
  const reason = typeof p.reason === "string" && CODE.test(p.reason) ? p.reason : "";
  const detail = typeof p.detail === "string" && CODE.test(p.detail) ? p.detail : "";
  if (reason === "runner_setup") {
    if (detail === "push_too_large" && Number.isInteger(p.size_mb) && p.size_mb >= 5) return "This push is " + p.size_mb + " MB; the limit through our proxy is 4 MB. A person can push this commit, or you can switch this repo to local-only (auto-merge turns off).";
    return SETUP_LINES[detail] || "Your runner could not start the agent (" + (detail || "other") + "). Check the runner's setup, then retry.";
  }
  if (Object.hasOwn(RUN_ENDED_LINES, reason)) return RUN_ENDED_LINES[reason](detail || "other");
  // wall_clock, runner_shutdown and repo_not_private have no line in copy.ts: the closed reason is shown as words.
  return reason ? "The run ended (" + word(reason) + ")" : "The run ended";
}

/** One runner event (the `payload` of a `runner.event`) as a line. An unknown or malformed `type` is "Runner step". */
export function runnerEventLine(p) {
  const e = isObj(p) ? p : {};
  const tool = typeof e.tool_name === "string" && e.tool_name !== "" ? e.tool_name : null;
  const file = typeof e.file_path === "string" && e.file_path !== "" ? e.file_path : null;
  let line;
  switch (e.type) {
    case "tool_use":
      line = "Used " + (tool || "a tool") + (file ? " · " + file : "");
      break;
    case "file_changed":
      line = "Changed " + (file || "a file");
      break;
    case "command_exit": {
      const secs = num(e.duration_ms) === null ? null : Math.round(e.duration_ms / 100) / 10;
      line = "Command exited" + (num(e.exit_code) === null ? "" : " " + e.exit_code) + (secs === null ? "" : " after " + secs + "s");
      break;
    }
    case "engine_version":
      line = typeof e.engine_version === "string" && e.engine_version !== "" ? "Claude " + e.engine_version : "Engine version";
      break;
    case "usage": {
      // Tokens only: the runner's own `usd` is never shown (the cloud recomputes the figure; the cost block shows that one).
      const u = isObj(e.usage) ? e.usage : {};
      line = (tokens(u.input) || "0") + " in / " + (tokens(u.output) || "0") + " out tokens";
      break;
    }
    case "run_ended":
      line = runEndedLine(e);
      break;
    case "usage_limit_reached": {
      const t = typeof e.reset_at === "string" ? Date.parse(e.reset_at) : NaN;
      line = "Plan usage limit reached" + (Number.isFinite(t) ? "; resumes at " + new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "");
      break;
    }
    case "credential_mismatch":
      line = "The sign-in on your runner is not the one this run was set up with.";
      break;
    case "taken_over":
      line = "Taken over on the machine";
      break;
    default:
      line = "Runner step";
  }
  return displayText(line);
}

/** HH:MM:SS (the viewer's clock) of an ISO instant, or null when it is not one. */
export function clockText(iso) {
  const t = typeof iso === "string" && ISO.test(iso) ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  const two = (n) => String(n).padStart(2, "0");
  return two(d.getHours()) + ":" + two(d.getMinutes()) + ":" + two(d.getSeconds());
}

/** D#6 C42-3b: the sentence for why a queued run on the person's machine is not running yet (the server's own words), or null. */
export const waitSentence = (insight) => (isObj(insight.wait) && typeof insight.wait.text === "string" && insight.wait.text.trim() !== "" ? insight.wait.text : null);

const LIMIT_LABELS = {
  max_run_minutes: ["Time", (v) => v + " min"],
  max_model_calls: ["Model calls", (v) => String(v)],
  per_run_usd: ["Spend", (v) => "$" + v],
  max_turns: ["Turns", (v) => String(v)],
  silence_minutes: ["Silence", (v) => v + " min"],
  max_extensions: ["Extensions", (v) => String(v)],
  max_resumes: ["Resumes", (v) => String(v)],
  auto_resume: ["Auto resume", (v) => (v ? "on" : "off")],
};

/** The run's facts as label/value pairs, only those that were recorded. */
export function factRows(insight) {
  const r = insight.run;
  const rows = [];
  if (r.model) rows.push(["Model", r.model]);
  if (r.runtime === "runner") rows.push(["Runs on", "your runner"]);
  const seen = r.runtime === "runner" ? clockText(insight.runner_checked_in_at) : null;
  if (seen) rows.push(["Runner last checked in", seen]);
  if (r.execution_mode) rows.push(["Runs in", word(r.execution_mode)]);
  if (r.head_sha) rows.push(["Head commit", r.head_sha.slice(0, 7), r.head_sha]);
  const lim = isObj(insight.limits) ? insight.limits : {};
  const limits = Object.keys(LIMIT_LABELS).filter((k) => k in lim).map((k) => LIMIT_LABELS[k][0] + " " + LIMIT_LABELS[k][1](lim[k]));
  if (limits.length) rows.push(["Limits now set for this role", limits.join(" · ")]);
  return rows;
}

const SAFE_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const ghBase = (item) => (item && isObj(item.repo) && SAFE_NAME.test(item.repo.owner) && SAFE_NAME.test(item.repo.name) ? "https://github.com/" + item.repo.owner + "/" + item.repo.name : null);

/** GitHub addresses for the issue and the pull request, each only when the record names the repo and the number. */
export function githubLinks(insight) {
  const base = ghBase(insight.work_item);
  const posInt = (n) => Number.isInteger(n) && n > 0;
  const out = [];
  if (base && posInt(insight.work_item.issue_number)) out.push({ label: "Issue #" + insight.work_item.issue_number, href: base + "/issues/" + insight.work_item.issue_number });
  // The issue and its pull request share one number space: a PR number equal to the issue's is the issue's own number
  // (a dispatch target), never a pull request.
  const issueNo = isObj(insight.work_item) ? insight.work_item.issue_number : null;
  if (base && posInt(insight.pr_number) && insight.pr_number !== issueNo) out.push({ label: "PR #" + insight.pr_number, href: base + "/pull/" + insight.pr_number });
  return out;
}

const isLinked = (l) => isObj(l) && /^[0-9a-f-]{36}$/i.test(l.id) && typeof l.role === "string" && typeof l.status === "string";
const isLine = (l) => isObj(l) && typeof l.at === "string" && typeof l.text === "string";

/** Every string in the value through the display filter (the tool's two-word name is never drawn). */
const clean = (v) => (typeof v === "string" ? displayText(v) : Array.isArray(v) ? v.map(clean) : isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)])) : v);

/**
 * After the sections are in the document: a name split across two text nodes ("Claude" ending one, "Code" starting the
 * next) reads as the tool name once the page is read as text, so a bare "…" goes between them, as the event list does.
 */
export function guardToolName(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  let carry = "";
  for (const n of nodes) {
    const t = n.nodeValue || "";
    if (t.trim() === "") continue;
    const gap = crossesBoundary(carry, t);
    carry = nextCarry(gap ? "" : carry, t);
    if (gap) n.parentNode.insertBefore(h("span", { "aria-hidden": "true" }, "…"), n);
  }
}

/** The body of the insight route when it has the shape this file reads, else null (the detail then says it is unavailable). */
export function readInsight(raw) {
  const body = clean(raw);
  if (!isObj(body) || !isObj(body.run) || typeof body.run.id !== "string" || typeof body.run.role !== "string" || typeof body.run.status !== "string") return null;
  if (!Array.isArray(body.lines) || !isObj(body.cost)) return null;
  return {
    ...body,
    lines: body.lines.filter(isLine),
    parent: isLinked(body.parent) ? body.parent : null,
    escalated_from: isLinked(body.escalated_from) ? body.escalated_from : null,
    children: Array.isArray(body.children) ? body.children.filter(isLinked) : [],
    outcome: isObj(body.outcome)
      ? { ...body.outcome, findings: Array.isArray(body.outcome.findings) ? body.outcome.findings.filter((f) => typeof f === "string") : [] }
      : null,
  };
}

/** Whether a role's outcome is a review (verdict and findings are shown for these). */
export const isReviewer = (role) => REVIEWERS.has(role);

/** How many activity lines show before the rest fold away. */
export const LINES_OPEN = 12;

// ── view ────────────────────────────────────────────────────────────────────

const STATUS_NOTE = {
  pending: "This run has not started yet.",
  running: "This run is still going. What it has done so far is below.",
};

function section(testid, title, ...children) {
  return h("section", { class: "runs-sec", "data-testid": testid }, h("h4", { class: "runs-sec-title" }, title), ...children);
}

/** A collapsible box. Its open/closed state is kept in `ui`, so a redraw (a live update) keeps what the person chose. */
export function foldBox(ui, testid, title, defaultOpen, ...children) {
  const open = Object.hasOwn(ui, testid) ? ui[testid] : defaultOpen;
  return h("details", { class: "runs-fold", "data-testid": testid, open: open || undefined, onToggle: (e) => { ui[testid] = e.currentTarget.open; } }, h("summary", { class: "runs-fold-sum" }, title), ...children);
}

function linkedRun(label, run, openRun) {
  return h(
    "button",
    { type: "button", class: "runs-link", "data-testid": "runs-linked", "data-id": run.id, onClick: () => openRun(run.id) },
    label + ": " + titleOf(run.role) + ", " + word(run.status)
  );
}

/** The header links: back to the work item, out to the issue and the PR. */
export function headLinks(insight, { openPipeline }) {
  const links = [];
  if (insight.work_item && typeof openPipeline === "function") {
    links.push(h("button", { type: "button", class: "runs-link", "data-testid": "runs-open-item", onClick: openPipeline }, "Open the work item in Pipeline"));
  }
  for (const l of githubLinks(insight)) {
    links.push(h("a", { class: "runs-link", href: l.href, target: "_blank", rel: "noopener noreferrer", "data-testid": "runs-gh" }, l.label + " on GitHub"));
  }
  return links.length ? h("div", { class: "runs-links" }, links) : null;
}

/** Why a run failed, in plain words, for each fixed code the runner records. */
const FAILURE_TEXT = {
  sandbox_busy: "Another build is still using this item's sandbox. Wait for it to finish, then build again.",
  sandbox_error: "The sandbox could not be created or started.",
  agent_start_timeout: "The agent did not start in time.",
  clone_failed: "The repository could not be cloned into the sandbox.",
  clone_too_large: "The repository is too large to clone.",
  model_key_broken: "The model key was refused or is no longer valid.",
  sandbox_stopped: "The sandbox was stopped before the run finished.",
  runner_lost: "The runner running this was lost.",
  runner_revoked: "The runner running this was revoked.",
  internal_error: "The run failed because of an internal error before the agent started.",
};

/** One plain sentence saying why the run failed, or null when it did not fail or recorded no reason. Text only. */
export function failureText(insight) {
  const code = insight && typeof insight.failure_reason === "string" ? insight.failure_reason : "";
  if (code === "") return null;
  return Object.hasOwn(FAILURE_TEXT, code) ? FAILURE_TEXT[code] : "The run failed (reason code: " + code.replace(/[^a-z0-9_]/g, "") + ").";
}

/** The sub-line under the title: status note while live, and how long it ran. */
export function headMeta(insight) {
  const d = durationText(insight.run, insight.server_time);
  const note = STATUS_NOTE[insight.run.status];
  const bits = [];
  if (d) bits.push((insight.run.ended_at ? "Took " : "Running for ") + d);
  if (note) bits.push(note);
  return bits.length ? h("p", { class: "runs-muted runs-head-meta", "data-testid": "runs-head-meta" }, bits.join(" · ")) : null;
}

function outcomeSection(insight) {
  const why = failureText(insight);
  const body = outcomeBody(insight, insight.outcome, insight.run.role);
  return section("runs-outcome", "Outcome", ...(why ? [h("p", { class: "runs-failure", role: "alert", "data-testid": "runs-failure" }, why)] : []), ...body);
}

function outcomeBody(insight, o, role) {
  if (!o) {
    const live = insight.run.status === "pending" || insight.run.status === "running";
    return [h("p", { class: "runs-muted", "data-testid": "runs-no-outcome" }, live ? "No result yet. The agent reports one when it finishes." : "This run did not report a result.")];
  }
  const kids = [];
  if (o.summary) kids.push(h("p", { class: "runs-summary", "data-testid": "runs-summary" }, o.summary));
  const v = verdictView(o.verdict);
  if (v && (isReviewer(role) || o.verdict)) {
    kids.push(h("p", { class: "runs-verdict" }, "Verdict: ", h("span", { class: "runs-vchip runs-vchip-" + v.tone, "data-testid": "runs-verdict", "data-verdict": String(o.verdict) }, v.label)));
  }
  if (isReviewer(role)) {
    if (o.findings.length) {
      kids.push(h("p", { class: "runs-sub" }, o.findings.length + (o.findings_truncated ? "+" : "") + " finding" + (o.findings.length === 1 ? "" : "s")));
      kids.push(h("ul", { class: "runs-findings", "data-testid": "runs-findings" }, o.findings.map((f) => h("li", { "data-testid": "runs-finding" }, f))));
      if (o.findings_truncated) kids.push(h("p", { class: "runs-muted" }, "More findings were reported than are shown here."));
    } else {
      kids.push(h("p", { class: "runs-muted", "data-testid": "runs-no-findings" }, "No findings reported."));
    }
  }
  if (role === "executor") {
    const facts = [];
    if (o.branch) facts.push(h("li", { "data-testid": "runs-branch" }, "Branch: ", h("code", null, o.branch)));
    if (Number.isInteger(insight.pr_number)) facts.push(h("li", { "data-testid": "runs-pr" }, "Pull request: #" + insight.pr_number));
    if (facts.length) kids.push(h("ul", { class: "runs-facts-list" }, facts));
  }
  if (kids.length === 0) kids.push(h("p", { class: "runs-muted", "data-testid": "runs-no-outcome" }, "The result had no summary."));
  return kids;
}

/** undefined for a sandbox run; the usage object (or null) for a run on the person's own machine. */
const runnerUsageOf = (insight) => (insight.run.runtime === "runner" ? (isObj(insight.runner_usage) ? insight.runner_usage : null) : undefined);

function costSection(insight) {
  const rows = costRows(insight.cost, insight.run.status, runnerUsageOf(insight), { state: insight.runner_usage_state, note: insight.runner_usage_note }).map((r) =>
    h(
      "div",
      { class: "runs-cost-row", "data-testid": "runs-cost-" + r.key },
      h("dt", null, r.label),
      h("dd", null, h("span", { class: "runs-cost-val" }, r.value), r.bill ? h("span", { class: "runs-muted" }, r.bill) : null, r.detail ? h("span", { class: "runs-muted" }, r.detail) : null)
    )
  );
  return section("runs-cost", "Cost", h("dl", { class: "runs-cost" }, rows));
}

/** What an empty Activity says. "No activity recorded." is for a run that has finished; a run still going has not recorded anything yet. */
export function noActivityView(insight) {
  const status = insight.run.status;
  if (status !== "pending" && status !== "running") return { testid: "runs-no-activity", text: "No activity recorded." };
  if (insight.run.runtime !== "runner") return { testid: "runs-nothing-yet", text: "Nothing recorded yet." };
  if (status === "running") return { testid: "runs-nothing-yet", text: "Your runner has started; nothing recorded yet" };
  return waitSentence(insight) ? null : { testid: "runs-nothing-yet", text: "Not started yet; nothing recorded yet." };
}

/** The lines a live run on the person's machine adds above its activity: why it waits, when the runner last checked in, and how to watch it there. */
function runnerNotes(insight) {
  const wait = waitSentence(insight);
  const seen = insight.run.runtime === "runner" && insight.run.status === "running" ? clockText(insight.runner_checked_in_at) : null;
  return [
    wait ? h("p", { class: "runs-wait", role: "status", "data-testid": "runs-wait" }, wait) : null,
    seen ? h("p", { class: "runs-muted", "data-testid": "runs-checked-in" }, "Runner last checked in " + seen) : null,
    insight.run.runtime === "runner" && insight.run.status === "running" ? h("p", { class: "runs-muted", "data-testid": "runs-attach-hint" }, "You can also watch this run on the runner machine with `fx-runner attach`.") : null,
  ];
}

function activitySection(insight, ui) {
  const lines = insight.lines;
  if (lines.length === 0) {
    const none = noActivityView(insight);
    return section("runs-activity", "Activity", ...runnerNotes(insight), none ? h("p", { class: "runs-muted", "data-testid": none.testid }, none.text) : null);
  }
  const item = (l) => h("li", { class: "runs-act", "data-testid": "runs-act" }, validTime(l.at) ? h("span", { class: "runs-ev-time" }, timeNode(l.at, true)) : null, h("span", { class: "runs-act-text" }, l.text));
  const head = lines.slice(0, LINES_OPEN);
  const rest = lines.slice(LINES_OPEN);
  return section(
    "runs-activity",
    "Activity",
    ...runnerNotes(insight),
    insight.lines_truncated ? h("p", { class: "runs-muted" }, "Only the latest activity is shown.") : null,
    h("ol", { class: "runs-acts" }, head.map(item)),
    rest.length ? foldBox(ui, "runs-activity-more", "Show " + rest.length + " more", false, h("ol", { class: "runs-acts" }, rest.map(item))) : null
  );
}

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/;
const validTime = (iso) => typeof iso === "string" && ISO.test(iso) && !Number.isNaN(Date.parse(iso));

function factsSection(insight, openRun, ui) {
  const rows = factRows(insight).map(([k, v, title]) => h("div", { class: "runs-fact" }, h("dt", null, k), h("dd", title ? { title } : null, v)));
  const links = [];
  if (insight.parent) links.push(linkedRun("Continues", insight.parent, openRun));
  if (insight.escalated_from) links.push(linkedRun("Escalated from", insight.escalated_from, openRun));
  for (const c of insight.children) links.push(linkedRun("Continued by", c, openRun));
  return foldBox(
    ui,
    "runs-facts",
    "Run facts",
    false,
    rows.length ? h("dl", { class: "runs-factlist" }, rows) : h("p", { class: "runs-muted" }, "No facts recorded."),
    links.length ? h("div", { class: "runs-links" }, links) : null
  );
}

/** The sections under the header, in the approved order: outcome, cost, activity, run facts. */
export function renderInsight(insight, { openRun, ui }) {
  return [outcomeSection(insight), costSection(insight), activitySection(insight, ui), factsSection(insight, openRun, ui)];
}
