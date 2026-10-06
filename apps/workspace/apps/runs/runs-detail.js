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

/** The two cost lines, separately. Each says what is recorded and, only when the record names it, whose bill it is on. */
export function costRows(cost, status) {
  const m = isObj(cost) && isObj(cost.model) ? cost.model : {};
  const c = isObj(cost) && isObj(cost.compute) ? cost.compute : {};
  const live = status === "pending" || status === "running";
  const tok = [tokens(m.tokens_in) && tokens(m.tokens_in) + " in", tokens(m.tokens_out) && tokens(m.tokens_out) + " out"].filter(Boolean).join(", ");
  const modelValue = m.source === "operator_subscription" ? "No per-token charge" : usd(m.usd) || (live ? "Counting…" : "Not recorded");
  const computeValue = usd(c.usd) || (live ? "Settled when the run ends" : "Not recorded");
  return [
    { key: "model", label: "Model usage", value: modelValue, bill: MODEL_BILL[m.source] || null, detail: tok || null },
    { key: "compute", label: "Sandbox compute", value: computeValue, bill: COMPUTE_BILL[c.source] || null, detail: null },
  ];
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

function costSection(insight) {
  const rows = costRows(insight.cost, insight.run.status).map((r) =>
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
  const lines = insight.lines;
  if (lines.length === 0) return section("runs-activity", "Activity", h("p", { class: "runs-muted", "data-testid": "runs-no-activity" }, "No activity recorded."));
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

/** The sections under the header, in the approved order: outcome, cost, activity, run facts. */
export function renderInsight(insight, { openRun, ui }) {
  return [outcomeSection(insight), costSection(insight), activitySection(insight, ui), factsSection(insight, openRun, ui)];
}
