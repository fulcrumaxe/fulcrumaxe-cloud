// D#483 P5: the Runs detail's "what this run did": its outcome, cost, activity and facts.
//
// Input is the body of GET /api/v1/runs/{id}/insight. The first half is a pure model (no DOM, no network, no clock):
// every sentence is chosen from recorded fields only, and where the record has nothing the model says nothing rather
// than guessing. The second half draws it. Model text (the summary, a finding, an activity line) is only ever given to
// h() as a string child, which makes a text node: nothing here builds markup from it.
//
// One file for both halves because the Runs app has a per-app boot-file ceiling (build/budget.mjs).
import { clockText, h, timeNode } from "../_lib/dom.js";
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
export function costRows(cost, status, runnerUsage, usageNote) {
  const m = isObj(cost) && isObj(cost.model) ? cost.model : {};
  const c = isObj(cost) && isObj(cost.compute) ? cost.compute : {};
  const live = status === "pending" || status === "running";
  if (runnerUsage !== undefined) {
    const u = isObj(runnerUsage) ? runnerUsage : null;
    return [
      // C42-3b: the sentence the server gives a state with no figure ("That is not the same as $0") is shown under it, so a missing figure is never read as a zero.
      { key: "model", label: "Model usage", value: u ? runnerUsageLine(u) : live ? "Counting…" : "Not recorded", bill: null, detail: typeof usageNote === "string" && usageNote !== "" ? usageNote : u ? "Estimate, priced at this run's model" : null },
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
  // D#6 RUNNER-AGENT-NO-FULLCHECK: the job's own memory limit ended the agent (COPY.resourceLimit; a test compares the two).
  resource_limit: () => "This job hit its memory limit on your runner, so the agent was stopped before it finished. Retry, or give jobs more memory on that machine (`fx-runner config set budget.light.memory` or `budget.heavy.memory`).",
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
const STAGE_LINES = { workspace_ready: "The secure sandbox is ready", cloned: "Repository cloned", deps_installed: "Dependencies installed", deps_install_failed: "Dependencies did not install", writing_result: "Writing up the result" };
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
    case "tool_use": {
      // C42-4: a runner that sends the activity of a tool use (a command's first line, a kind) is drawn as the sandbox's lines are.
      const a = isObj(e.activity) ? e.activity : null;
      const cmd = a && typeof a.command === "string" && a.command !== "" ? a.command : null;
      if (a && a.tool === "test") line = cmd ? "Ran tests: " + cmd : "Running the tests";
      else if (a && a.tool === "command") line = cmd ? "Ran: " + cmd : "Running a command";
      else line = "Used " + (tool || "a tool") + (file ? " · " + file : "");
      break;
    }
    case "stage":
      line = STAGE_LINES[e.stage] || "Runner step";
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
  if (r.execution_mode) rows.push(["Runs in", word(r.execution_mode)]);
  // C42-4: where a runner run is, and (live only) when its runner last checked in.
  if (r.runtime === "runner") rows.push(["Runs on", "Your runner"]);
  const seen = clockText(insight.runner_checked_in_at);
  if (r.runtime === "runner" && seen) rows.push(["Runner last checked in", seen, insight.runner_checked_in_at]);
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

// ── D#600 CX-8: the context panel ─────────────────────────────────────────────
// Input is the body of GET /api/v1/runs/{id}/context: integers and fixed names only. Every figure that was not measured is null in the body and
// "Not recorded" here, never 0; one formatter (`figure`) turns a number into words, so no cell can show null, undefined or NaN.

const SECTION_NAMES = {
  card: "Role card",
  boundary: "Boundary",
  map: "Repo map",
  memory_stable: "Memory (account, repo, role)",
  memory_item: "Memory (this item)",
  spec: "Spec",
  note: "Notes",
  corrections: "Corrections",
  findings: "Findings",
  output: "Output block",
  repo_instructions: "Repo instructions",
  pinned: "Pinned files",
};
const TOOL_NAMES = {
  Read: "Files read",
  Grep: "Searches (Grep)",
  Glob: "File lookups (Glob)",
  LS: "Folder listings",
  Bash: "Commands run",
  Edit: "Edits",
  MultiEdit: "Multi-file edits",
  Write: "Files written",
  NotebookEdit: "Notebook edits",
  WebFetch: "Web pages fetched",
  WebSearch: "Web searches",
  Task: "Sub-agents",
  TodoWrite: "To-do updates",
  other: "Other tools",
};
export const CONTEXT_WORDS = {
  loading: "Loading what this run loaded…",
  error: "What this run loaded isn't available right now.",
  retry: "Retry",
  notRecorded: "Not recorded",
  live: "Recorded when this run ends.",
  none: "Not recorded for this run. Runs from before this was kept, and runs on an older runner, have none.",
  runner: "Contents stayed on your machine",
  runnerHelp: "This run ran on your runner, so only sizes and counts reach the cloud.",
  partial: "Estimated: this run's usage was only partly measured, so the shares below are estimates.",
};

/** A byte count in words: "912 B", "5.2 KiB", "1.4 MiB". Null for anything that is not a count. */
export function bytesText(n) {
  if (!Number.isFinite(n) || n < 0) return null;
  if (n < 1024) return n + " B";
  const unit = n < 1048576 ? [n / 1024, "KiB"] : [n / 1048576, "MiB"];
  return String(Math.round(unit[0] * 10) / 10) + " " + unit[1];
}
/** A token count in words, or null. */
const tokenText = (n) => (Number.isFinite(n) && n >= 0 ? n.toLocaleString("en-US") + (n === 1 ? " token" : " tokens") : null);
/** The one place a figure becomes a sentence part: the words, or "Not recorded". */
const figure = (text, estimated) => (text === null ? CONTEXT_WORDS.notRecorded : text + (estimated ? " (estimated)" : ""));
/** A part's share of a whole as { value: 0-100, text: "40%" }; a whole of nothing has no share. */
function share(part, whole) {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null;
  const p = (part / whole) * 100;
  return { value: Math.round(p), text: p > 0 && p < 1 ? "<1%" : Math.round(p) + "%" };
}
const countOrNull = (v) => (Number.isInteger(v) && v >= 0 ? v : null);

/** The body of the context route when it has the shape this file reads, else null (the panel then shows its error and Retry). */
export function readContext(raw) {
  const b = clean(raw);
  if (!isObj(b) || typeof b.run_id !== "string" || typeof b.status !== "string" || typeof b.recorded !== "boolean") return null;
  const sections = (Array.isArray(b.sections) ? b.sections : [])
    .filter((x) => isObj(x) && typeof x.code === "string" && countOrNull(x.bytes) !== null)
    .slice(0, 64)
    .map((x) => ({ code: x.code, bytes: x.bytes, trimmed_bytes: countOrNull(x.trimmed_bytes) ?? 0, ...(typeof x.trimmed_reason === "string" ? { reason: x.trimmed_reason } : {}) }));
  const tools = (Array.isArray(b.tool_output) ? b.tool_output : [])
    .filter((x) => isObj(x) && typeof x.tool === "string" && countOrNull(x.bytes) !== null)
    .slice(0, 32)
    .map((x) => ({ tool: x.tool, bytes: x.bytes }));
  const memory = (Array.isArray(b.recalled_memory) ? b.recalled_memory : [])
    .filter((x) => isObj(x) && typeof x.id === "string" && typeof x.name === "string" && x.name.trim() !== "" && Number.isInteger(x.version) && x.version >= 1)
    .slice(0, 50);
  // D#601 MEM-8b: the item's own records (applied notes, a handoff note) the prompt held; a label and an id, never text.
  const itemSources = (Array.isArray(b.item_sources) ? b.item_sources : [])
    .filter((x) => isObj(x) && typeof x.id === "string" && typeof x.label === "string" && x.label.trim() !== "")
    .slice(0, 6);
  return {
    run_id: b.run_id,
    runtime: typeof b.runtime === "string" ? b.runtime : "",
    status: b.status,
    recorded: b.recorded,
    basis: b.basis === "measured" || b.basis === "partial" ? b.basis : null,
    sections,
    first_turn_input_tokens: countOrNull(b.first_turn_input_tokens),
    peak_context_tokens: countOrNull(b.peak_context_tokens),
    cache_read_tokens: countOrNull(b.cache_read_tokens),
    cache_write_tokens: countOrNull(b.cache_write_tokens),
    memory_tokens: countOrNull(b.memory_tokens),
    tool_output: tools,
    compactions: countOrNull(b.compactions),
    denied_tool_calls: countOrNull(b.denied_tool_calls),
    recalled_memory: memory,
    item_sources: itemSources,
    repo_map_version: typeof b.repo_map_version === "string" && b.repo_map_version !== "" ? b.repo_map_version : null,
  };
}

/**
 * Everything the panel draws, from a read context: its state (`none`, `live`, `partial`, `ready`) and the words. A run on the person's
 * machine is shown as sizes and counts only, plus the memory entries its job carried (the cloud's own rows, D#601 MEM-3b); never a map version, whatever the body holds.
 */
export function contextModel(ctx) {
  if (!ctx.recorded || ctx.basis === null) {
    const live = ctx.status === "pending" || ctx.status === "running";
    // A run on the person's machine with no ledger says where its contents are, not that nothing was kept (it keeps sizes only, and may have sent none).
    if (!live && ctx.runtime === "runner") return { state: "none", text: CONTEXT_WORDS.runner + ". " + CONTEXT_WORDS.runnerHelp };
    return { state: live ? "live" : "none", text: live ? CONTEXT_WORDS.live : CONTEXT_WORDS.none };
  }
  const runner = ctx.runtime === "runner";
  const est = ctx.basis === "partial";
  // D#600 CX-5b: two `pinned` entries are notes about the pins, not prompt text: how many pinned files could not be read, and how far the pins stand over the budget
  // (they are included in full either way). They carry a count or a size in `bytes`, so they are not rows with a share.
  const PIN_NOTE_REASONS = ["pin_missing", "pins_over_budget", "pin_too_large", "pin_excluded"];
  const notes = ctx.sections.filter((x) => PIN_NOTE_REASONS.includes(x.reason));
  const body = ctx.sections.filter((x) => !notes.includes(x));
  const missing = notes.filter((x) => x.reason === "pin_missing").reduce((n, x) => n + x.bytes, 0);
  const over = notes.filter((x) => x.reason === "pins_over_budget").reduce((n, x) => n + x.bytes, 0);
  const sum = (reason) => notes.filter((x) => x.reason === reason).reduce((n, x) => n + x.bytes, 0);
  const files = (n) => (n === 1 ? "1 pinned file was" : n + " pinned files were");
  const pinNotes = [
    missing > 0 ? (missing === 1 ? "1 pinned file was not included: it was missing or not text, or GitHub could not be read." : missing + " pinned files were not included: they were missing or not text, or GitHub could not be read.") : null,
    sum("pin_too_large") > 0 ? files(sum("pin_too_large")) + " not included: over the 190,000-character limit for one pinned file. Pins are never cut." : null,
    sum("pin_excluded") > 0 ? files(sum("pin_excluded")) + " not included: the path is also kept out of context, and keeping out wins over pinning." : null,
    over > 0 ? "Pinned files stand " + bytesText(over) + " over this repository's context budget. They are never cut, so they were included in full." : null,
  ].filter((t) => t !== null);
  const secTotal = body.reduce((n, x) => n + x.bytes, 0);
  const toolTotal = ctx.tool_output.reduce((n, x) => n + x.bytes, 0);
  const row = (key, label, bytes, whole, trimmed) => {
    const s = share(bytes, whole);
    return { key, label, size: figure(bytesText(bytes), false), pct: s ? s.value : null, pctText: s ? s.text + (est ? " (estimated)" : "") : CONTEXT_WORDS.notRecorded, trimmed: trimmed > 0 ? "Trimmed: " + bytesText(trimmed) + " cut" : null };
  };
  const read = ctx.cache_read_tokens;
  const write = ctx.cache_write_tokens;
  const comp = ctx.compactions;
  return {
    state: est ? "partial" : "ready",
    estimated: est,
    runner: runner ? { title: CONTEXT_WORDS.runner, help: CONTEXT_WORDS.runnerHelp } : null,
    sections: body.map((x) => row("section-" + x.code, SECTION_NAMES[x.code] || word(x.code), x.bytes, secTotal, x.trimmed_bytes)),
    pinNotes,
    tools: ctx.tool_output.map((x) => row("tool-" + x.tool, TOOL_NAMES[x.tool] || word(x.tool), x.bytes, toolTotal, 0)),
    // The ledger holds the cache's reads and writes and not the uncached input, so "from cache" is the reads out of all cache traffic.
    cache: read !== null && write !== null ? figure(read.toLocaleString("en-US") + " of " + (read + write).toLocaleString("en-US") + " tokens from cache", est) : "Cache use: " + CONTEXT_WORDS.notRecorded,
    facts: [
      ["First turn", figure(tokenText(ctx.first_turn_input_tokens), est)],
      ["Largest context", figure(tokenText(ctx.peak_context_tokens), est)],
      ["Compacted", comp === null ? CONTEXT_WORDS.notRecorded : comp === 0 ? "Not compacted" : comp === 1 ? "Once" : comp + " times"],
      // D#600 CX-5b: reads and searches refused because a path is kept out of context. Not recorded for a runner run and for a run from before the count; 0 is a measured "none".
      ["Calls refused (kept out of context)", ctx.denied_tool_calls === null ? CONTEXT_WORDS.notRecorded : ctx.denied_tool_calls === 0 ? "None" : ctx.denied_tool_calls === 1 ? "1 tool call" : ctx.denied_tool_calls + " tool calls"],
    ],
    memory: { tokens: ctx.memory_tokens === null ? null : tokenText(ctx.memory_tokens), items: [...ctx.recalled_memory.map((m) => ({ name: m.name, ref: m.id.slice(0, 8) + "@" + m.version, title: m.id + "@" + m.version })), ...(ctx.item_sources ?? []).map((x) => ({ name: x.label + (x.cut === true ? " (cut)" : ""), ref: x.id.slice(0, 8), title: x.id }))] },
    mapVersion: runner ? null : ctx.repo_map_version,
  };
}

function ctxRow(r) {
  return h(
    "li",
    { class: "runs-ctx-row", "data-testid": "runs-ctx-row", "data-key": r.key },
    h("span", { class: "runs-ctx-name" }, r.label),
    h("span", { class: "runs-ctx-size" }, r.size),
    r.pct === null ? null : h("meter", { class: "runs-ctx-bar", min: 0, max: 100, value: r.pct, "aria-label": r.label + " share" }),
    h("span", { class: "runs-ctx-pct", "data-testid": "runs-ctx-pct" }, r.pctText),
    r.trimmed ? h("span", { class: "runs-ctx-trim", "data-testid": "runs-ctx-trim" }, r.trimmed) : null
  );
}

/** The panel. `context` is undefined while it loads, null when it could not be read, else the read body. */
export function contextSection(context, retry) {
  // The heading takes focus when a redraw replaces the control that had it (Retry): `data-keep` marks what hands focus to `data-keep-target`.
  const sec = (state, ...kids) => h("section", { class: "runs-sec runs-ctx", "data-testid": "runs-context", "data-state": state }, h("h4", { class: "runs-sec-title", tabindex: "-1", "data-testid": "runs-ctx-heading", "data-keep": "ctx", "data-keep-target": "ctx" }, "Context"), ...kids);
  if (context === undefined) return sec("loading", h("p", { class: "runs-muted", role: "status", "data-testid": "runs-ctx-loading", "data-keep": "ctx" }, CONTEXT_WORDS.loading));
  if (context === null) {
    return sec("error", h("p", { class: "runs-muted", role: "status", "data-testid": "runs-ctx-error" }, CONTEXT_WORDS.error), h("button", { type: "button", class: "runs-more", "data-testid": "runs-ctx-retry", "data-keep": "ctx", onClick: retry }, CONTEXT_WORDS.retry));
  }
  const m = contextModel(context);
  if (m.state === "none" || m.state === "live") return sec(m.state, h("p", { class: "runs-muted", "data-testid": "runs-ctx-empty" }, m.text));
  const group = (title, rows, testid) => (rows.length ? [h("h5", { class: "runs-sub" }, title), h("ul", { class: "runs-ctx-rows", "data-testid": testid }, rows.map(ctxRow))] : []);
  return sec(
    m.state,
    m.runner ? h("p", { class: "runs-muted", "data-testid": "runs-ctx-runner" }, h("strong", null, m.runner.title), ". " + m.runner.help) : null,
    m.estimated ? h("p", { class: "runs-muted", role: "status", "data-testid": "runs-ctx-estimated" }, CONTEXT_WORDS.partial) : null,
    ...group("What the prompt held", m.sections, "runs-ctx-sections"),
    ...m.pinNotes.map((t) => h("p", { class: "runs-muted", role: "status", "data-testid": "runs-ctx-pin-note" }, t)),
    h("p", { "data-testid": "runs-ctx-cache" }, m.cache),
    h("dl", { class: "runs-factlist", "data-testid": "runs-ctx-facts" }, m.facts.map(([k, v]) => h("div", { class: "runs-fact" }, h("dt", null, k), h("dd", null, v)))),
    ...group("What tools returned", m.tools, "runs-ctx-tools"),
    m.memory && (m.memory.items.length || m.memory.tokens)
      ? h(
          "div",
          { "data-testid": "runs-ctx-memory" },
          h("h5", { class: "runs-sub" }, "Recalled memory" + (m.memory.tokens ? " · " + m.memory.tokens : "")),
          m.memory.items.length ? h("ul", { class: "runs-ctx-rows" }, m.memory.items.map((i) => h("li", { class: "runs-ctx-row" }, i.name, " ", h("code", { title: i.title }, i.ref)))) : null
        )
      : null,
    m.mapVersion ? h("p", { class: "runs-muted", "data-testid": "runs-ctx-map" }, "Repo map version: ", h("code", null, m.mapVersion)) : null
  );
}

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

/**
 * The header total of a run on the person's own machine. It is the API-equivalent figure the cloud computed from the run's tokens: information, never a
 * charge, so the words say it ran on the customer's Claude plan (or own API key). With no figure yet it says whose plan, as the run list does.
 */
export function runnerHeadTotal(insight) {
  if (!insight || !isRunner(insight)) return null;
  const u = isObj(insight.runner_usage) ? insight.runner_usage : null;
  const own = u !== null && u.credential_mode === "api_key";
  const price = u !== null && Number.isFinite(u.api_equivalent_usd) ? usd(u.api_equivalent_usd) : null;
  if (own) return price ? price + " at API prices · on your own API key" : "On your own API key";
  return price ? "API-equivalent " + price + " · on your Claude plan" : "On your Claude plan";
}

const RUN_ID = /^[0-9a-f-]{36}$/i;
export const EXPORT_LABEL = "Export events";

/** Where the export of one run's events is, and the file name it downloads as; null for a run id that is not a UUID. */
export function exportTarget(runId) {
  if (typeof runId !== "string" || !RUN_ID.test(runId)) return null;
  return { href: "/api/v1/runs/" + runId + "/events/export", filename: "run-" + runId + "-events.ndjson" };
}

/** The control that downloads one run's events (the API's NDJSON export), for a runner run and a sandbox run alike. */
export function exportLink(runId) {
  const t = exportTarget(runId);
  if (t === null) return null;
  return h("a", { class: "runs-link", href: t.href, download: t.filename, "data-testid": "runs-export" }, EXPORT_LABEL);
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

const isRunner = (insight) => insight.run.runtime === "runner";
const isLive = (insight) => insight.run.status === "pending" || insight.run.status === "running";

/**
 * C42-4: the lines that say where a run on the person's machine stands, under the header: why it has not started (the server's sentence, a pending run
 * only), when its runner last checked in (a running one only), and the one hint that the machine has its own live view. A sandbox run has none.
 */
export function runnerNotes(insight) {
  if (!isRunner(insight) || !isLive(insight)) return [];
  const notes = [];
  const wait = isObj(insight.wait) && typeof insight.wait.text === "string" && insight.wait.text !== "" ? insight.wait.text : null;
  if (insight.run.status === "pending" && wait) notes.push(h("p", { class: "runs-muted runs-head-meta", role: "status", "data-testid": "runs-wait", "data-reason": String(insight.wait.reason) }, wait));
  const seen = clockText(insight.runner_checked_in_at);
  if (insight.run.status === "running" && seen) notes.push(h("p", { class: "runs-muted runs-head-meta", "data-testid": "runs-checkin" }, "Runner last checked in " + seen));
  notes.push(h("p", { class: "runs-muted runs-head-meta", "data-testid": "runs-attach-hint" }, "You can also watch this run on the runner machine with ", h("code", null, "fx-runner attach"), "."));
  return notes;
}

/** What a run with no activity lines says: "No activity recorded." only once it is over; while it is live, that nothing is recorded yet. */
export function emptyActivityText(insight) {
  if (!isLive(insight)) return "No activity recorded.";
  if (!isRunner(insight)) return "Nothing recorded yet.";
  return insight.run.status === "running" ? "Your runner has started; nothing recorded yet" : "Not started yet; nothing recorded yet.";
}

/** The activity lines, and for a run whose runner was lost one plain line saying so (the run ended because its runner stopped checking in). */
export function activityLines(insight) {
  const lost = isRunner(insight) && insight.failure_reason === "runner_lost";
  return lost ? [...insight.lines, { at: insight.run.ended_at || "", text: "Your runner stopped checking in, so this run was ended. Build again to retry." }] : insight.lines;
}

// D#6 R-CHK-3b: the repository's approved check on a run on the person's machine. Every sentence is chosen from recorded fields; the command and the output are drawn as text.
const SPACE = "␣"; // the open-box mark the Repos app shows in place of each space
/** One argument as the person must see it: quoted, each space marked, so a leading, trailing or doubled space cannot pass for tidy. */
export const showArg = (a) => '"' + String(a).replace(/ /g, SPACE) + '"';
export const CHECK_CHANGED = "check files changed by this branch: ";
// D#6 R-CHK-3d: a check the runner could not run safely carries a closed reason code (the runner protocol's CHECK_NOT_RUN_REASONS); each code has one plain sentence here, kept equal to
// the protocol's CHECK_NOT_RUN_LINES by test. A code this page does not know reads as `other`; the code itself is never drawn.
export const CHECK_REASON_COPY = {
  sandbox_unavailable: "The sandbox could not start the check on your runner, so it was not run.",
  sandbox_refused: "Your runner's sandbox would not run the check with the same limits the agent had (for example a missing sandbox tool or filter), so it was not run.",
  pin_failed: "The files the check names could not be pinned to the default branch's copy (a link, or something that is not a file, is on the path), so it was not run.",
  protected_unreadable: "The runner could not read the protected files of the working folder before the check, so it was not run.",
  protected_changed: "The check changed files it may not change, so its result does not count.",
  not_restored: "The runner could not give the check's files back to the branch afterwards, so the result does not count.",
  start_failed: "The runner could not start the check, so it was not run.",
  not_set_up: "The check is not set up on this runner, so it was not run.",
  base_missing: "The runner could not find the default branch's copy of the check's files, so it was not run.",
  other: "The runner reported that the check could not run safely, so it was not run.",
};
const reasonCopy = (code) => (typeof code === "string" && Object.hasOwn(CHECK_REASON_COPY, code) ? CHECK_REASON_COPY[code] : CHECK_REASON_COPY.other);
// Rows recorded before the code existed (and a runner that does not send one) have no reason: the runner's own refusal words in the summary still tell them apart, as before.
const LEGACY_NOT_SAFE = /^(the sandbox could not start the check|the check was not run:|the check could not be started)/;
export const CHECK_COPY = {
  not_set: ["Not set", "This repository has no approved check, so nothing was run after the agent finished."],
  not_run: ["Not run", "The run ended before the check ran."],
  running: ["Not finished", "The check runs on your runner after the agent finishes. Its result appears here when the run ends."],
  passed: ["Passed", "The check passed."],
  failed: ["Failed", "The check failed, so this run ended without a pull request."],
  timed_out: ["Timed out", "The check was stopped at its time limit, so this run ended without a pull request."],
  no_dev_shell: ["No dev shell", "The check needs the repository's dev shell and none was built, so it was not run and this run ended without a pull request."],
  unsafe: ["Could not run safely", "The check could not run safely: your runner would not run it with weaker rules than the agent had, so it was not run. This run ended without a pull request."],
  runner_too_old: ["Runner too old", "Update your runner to run this repository's check."],
};
const secsText = (s) => (s < 60 ? s + "s" : Math.floor(s / 60) + "m " + String(s % 60).padStart(2, "0") + "s");

/** The Check block as data, or null for a run that is not on the person's machine. The state is told from recorded facts only. */
export function checkView(insight) {
  if (!isRunner(insight)) return null;
  const c = isObj(insight.check) && Array.isArray(insight.check.argv) ? insight.check : null;
  const r = c && isObj(c.result) ? c.result : null;
  const summary = r && typeof r.summary === "string" ? r.summary : "";
  const hasReason = r !== null && r.reason !== null && r.reason !== undefined;
  let state;
  if (!c) state = "not_set";
  else if (c.no_dev_shell === true) state = "no_dev_shell";
  else if (r) state = hasReason ? "unsafe" : r.timed_out === true ? "timed_out" : r.exit_code === 0 ? "passed" : r.exit_code === null && LEGACY_NOT_SAFE.test(summary) ? "unsafe" : "failed";
  else if (isObj(insight.wait) && insight.wait.reason === "runner_too_old_for_check") state = "runner_too_old";
  else state = isLive(insight) ? "running" : "not_run";
  const [label, copy] = CHECK_COPY[state];
  const facts = [];
  if (c) {
    if (c.dev_shell === true) facts.push("Runs in the dev shell");
    if (Number.isInteger(c.timeout_s)) facts.push("Time limit " + secsText(c.timeout_s));
  }
  if (r && state !== "no_dev_shell" && state !== "unsafe") {
    if (state === "failed") facts.push(Number.isInteger(r.exit_code) ? "Exit status " + r.exit_code : "No exit status recorded");
    else if (state === "passed") facts.push("Exit status 0");
    if (Number.isFinite(r.duration_ms)) facts.push("Took " + secsText(Math.round(r.duration_ms / 1000)));
    if (state !== "timed_out") facts.push("Skipped tests: " + (Number.isInteger(r.skipped_tests) ? r.skipped_tests : "Not recorded"));
  }
  let text = state === "runner_too_old" && isObj(insight.wait) && typeof insight.wait.text === "string" && insight.wait.text !== "" ? insight.wait.text : copy;
  if (state === "unsafe" && hasReason) text = reasonCopy(r.reason) + " This run ended without a pull request.";
  const nl = summary.indexOf("\n");
  const first = nl === -1 ? summary : summary.slice(0, nl);
  const changed = first.startsWith(CHECK_CHANGED) ? first : null;
  const tail = changed ? (nl === -1 ? "" : summary.slice(nl + 1)) : summary;
  return { state, label, copy: text, argv: c ? c.argv.filter((a) => typeof a === "string") : [], facts, changed, tail };
}

const CHECK_TONE = { passed: "ok", failed: "bad", timed_out: "bad", unsafe: "bad", no_dev_shell: "bad", runner_too_old: "warn" };
function checkSection(insight) {
  const v = checkView(insight);
  if (!v) return null;
  return section(
    "runs-check",
    "Check",
    h("p", { class: "runs-verdict", "data-testid": "runs-check-state", "data-state": v.state }, h("span", { class: "runs-vchip runs-vchip-" + (CHECK_TONE[v.state] || "plain") }, v.label), " ", v.copy),
    v.argv.length ? h("ol", { class: "runs-check-argv", "aria-label": "Approved command, one argument per line", "data-testid": "runs-check-argv" }, v.argv.map((a) => h("li", null, h("code", { "data-testid": "runs-check-arg" }, showArg(a))))) : null,
    v.facts.length ? h("p", { class: "runs-muted", "data-testid": "runs-check-facts" }, v.facts.join(" · ")) : null,
    v.changed ? h("p", { class: "runs-check-changed", role: "note", "data-testid": "runs-check-changed" }, v.changed) : null,
    v.tail.trim() !== "" ? h("pre", { class: "runs-check-out", tabindex: "0", role: "region", "aria-label": "Check output, last lines", "data-testid": "runs-check-output" }, v.tail) : null
  );
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
  const rows = costRows(insight.cost, insight.run.status, runnerUsageOf(insight), insight.runner_usage_note).map((r) =>
    h(
      "div",
      { class: "runs-cost-row", "data-testid": "runs-cost-" + r.key },
      h("dt", null, r.label),
      h("dd", null, h("span", { class: "runs-cost-val" }, r.value), r.bill ? h("span", { class: "runs-muted" }, r.bill) : null, r.detail ? h("span", { class: "runs-muted" }, r.detail) : null)
    )
  );
  return section("runs-cost", "Cost", h("dl", { class: "runs-cost" }, rows));
}

function activitySection(insight, ui) {
  const lines = activityLines(insight);
  if (lines.length === 0) return section("runs-activity", "Activity", h("p", { class: "runs-muted", "data-testid": "runs-no-activity" }, emptyActivityText(insight)));
  const item = (l) => h("li", { class: "runs-act", "data-testid": "runs-act" }, validTime(l.at) ? h("span", { class: "runs-ev-time" }, timeNode(l.at, true)) : null, h("span", { class: "runs-act-text" }, l.text));
  const head = lines.slice(0, LINES_OPEN);
  const rest = lines.slice(LINES_OPEN);
  return section(
    "runs-activity",
    "Activity",
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

/** The sections under the header, in the approved order: outcome, check (a run on the person's machine only), cost, context, activity, run facts. */
export function renderInsight(insight, { openRun, ui, context, retryContext }) {
  return [outcomeSection(insight), checkSection(insight), costSection(insight), contextSection(context, retryContext), activitySection(insight, ui), factsSection(insight, openRun, ui)];
}
