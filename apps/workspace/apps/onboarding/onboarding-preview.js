// D#37 WS-F9a: step 3 of Onboarding, the free preview. Lists the account's read-only repos, starts one preview
// (POST /api/v1/onboarding/preview, one Idempotency-Key per user intent, reused when the same intent is retried),
// then reads GET /api/v1/onboarding/preview on a bounded timer until it is finished or void.
// The result is model output derived from repository text: every piece of it is set through textContent, never as markup.
// The app never marks a step done; the server does, and the caller re-reads progress when this settles.
import { h } from "../_lib/dom.js";
import { api, ApiFailure, createRetryGate, isRateLimited, retryWords, waitSeconds } from "../_lib/api.js";

const REPOS_URL = "/api/v1/repos";
const PREVIEW_URL = "/api/v1/onboarding/preview";
const CAP_USD = 20;
// Polling is bounded: every 3 seconds for the first two minutes, every 15 seconds for ten more, then it stops and says so.
const POLL_MS = 3000;
const FAST_POLLS = 40;
const SLOW_POLL_MS = 15000;
const MAX_POLLS = 80;
const TICK_MS = 1000;
const MAX_PAGES = 10;
const MAX_FEED = 30;
const STATES = ["requested", "running", "finished", "void"];
const OUTCOMES = ["queued", "starting", "running", "finished", "failed", "cancelled", "sandbox_stopped", "agent_never_started", "void"];
const STAGE_IDS = ["queued", "sandbox", "clone", "read", "plan", "write", "done"];
const STAGE_STATUS = ["done", "active", "pending", "failed"];
const LIVE_OUTCOMES = ["queued", "starting", "running"];
const WHOSE = ["operator", "ai_gateway", "anthropic", "customer"];
// Every word this panel adds lives here. {repo}, {n}, {usd}, {cap} are filled in as text, never as markup.
// Compute is always ours on the hosted plane: no line here may call it free.
const TEXT = {
  notYet: "A free preview isn't available yet.",
  busy: "Previews are busy right now. Try again later.",
  noKey: "Add a model key first, then start the preview.",
  other409: "A free preview can't be started for this account.",
  generic: "The preview couldn't be started. Try again.",
  loadFailed: "The preview couldn't be loaded. Reopen this window to try again.",
  slow: "The preview is taking longer than usual and is still running here. Reopen this window to check again.",
  running: "Your preview is running. This can take a few minutes.",
  failed: "Your preview couldn't finish",
  badOutput: "The preview finished, but its output couldn't be shown.",
  noRepos: "Install the read-only GitHub App first, then pick a repository here.",
  gone: "That repository isn't available any more. Pick another one.",
  outcome: {
    queued: "Your preview is queued. It starts as soon as a secure sandbox is ready.",
    starting: "Starting a secure sandbox for your repository.",
    running: "The agent is working through your repository.",
    finished: "The agent has finished. Here is what it found.",
    cancelled: "Your preview was cancelled before it finished.",
    sandbox_stopped: "The secure sandbox stopped before the agent finished. Nothing you did caused it.",
    sandbox_not_started: "This didn't start on our side. Your free preview isn't used up; try again.",
    agent_never_started: "This didn't start on our side. Your free preview isn't used up; try again.",
    agent_never_started_used: "The agent never started in the sandbox. This free preview is used up.",
  },
  usedUp: "This free preview is used up.",
  retryFreed: "You can start the preview again.",
  retrySkip: "This free preview can't be started again. You can skip it and choose a plan to continue.",
  noIssuesHeading: "No open issues found",
  noIssues: "The agent found no open issues it could read in this repository. The repository may have none, or issues may not be readable. You can still choose a plan.",
  slowNote: "This is taking longer than usual. It is still running, and this panel keeps checking.",
  reasons: {
    model_key_broken: "Your model key stopped working during the preview. Check it in Model Key.",
    timed_out: "The preview ran out of time before it finished.",
    killed_spend: "The preview stopped at its spending limit.",
    refused_spend: "The preview couldn't start within its spending limit.",
    internal_error: "Something went wrong on our side.",
    sandbox_error: "The secure sandbox hit an error on our side.",
    clone_failed: "We couldn't copy your repository into the preview sandbox.",
    clone_too_large: "This repository is too large for a free preview (over 200 MB).",
    sandbox_stopped: "The secure sandbox was stopped from outside before the agent finished.",
    runner_lost: "The secure sandbox was lost before the agent finished.",
    agent_start_timeout: "The agent didn't start in time.",
    preview_unavailable: "Previews aren't available right now.",
    preview_capacity: "Previews are busy right now.",
  },
  stages: {
    queued: "Waiting for a secure sandbox",
    sandbox: "Starting a secure sandbox",
    clone: "Cloning {repo}",
    read: "Agent reading the code",
    plan: "Planning",
    write: "Writing the result",
    done: "Done",
  },
  stageWords: { done: "done", active: "in progress", pending: "waiting", failed: "stopped here" },
  timelineLabel: "Preview progress",
  elapsed: "Elapsed",
  repoFallback: "your repository",
  feedHeading: "What the agent is doing",
  feedLabel: "Recent agent activity",
  feedEmpty: "Nothing to show yet. Activity appears here as the agent works.",
  numbersHeading: "So far",
  filesRead: "Files read: {n}",
  computeNone: "Sandbox compute: none yet. It runs on our infrastructure and counts against the preview's {cap} dollar compute allowance.",
  computeEstimate: "Sandbox compute so far: about {usd}, an estimate from run time. It's our cost and counts against the preview's {cap} dollar allowance.",
  computeRecorded: "Sandbox compute: {usd}, recorded. It's our cost and counted against the preview's {cap} dollar allowance.",
  modelOperator: "Model usage: operator subscription",
  modelNone: "Model usage: none recorded yet, {whose}",
  modelUsed: "Model usage: {usd} {whose}",
  whose: { ai_gateway: "on your Vercel AI Gateway key", anthropic: "on your Anthropic key", customer: "on your model key" },
  payoffHeading: "Next step",
  payoff: "That was your free preview. To keep going, choose a plan.",
  choosePlan: "Choose a plan",
  announceRunning: "Your preview is running.",
  announceDone: "Your preview has finished.",
  announceStopped: "Your preview stopped.",
};

const cancelled = (e) => e && e.name === "AbortError";
/** An element whose text is set through textContent only. A missing value is empty text, never the word "null". */
function txt(tag, cls, value) {
  const el = h(tag, { class: cls });
  el.textContent = value == null ? "" : String(value);
  return el;
}
const isText = (v) => typeof v === "string" && v !== "";

function resultView(r) {
  const issues = Array.isArray(r.issues) ? r.issues.slice(0, 50) : [];
  const spec = r.sample_spec && typeof r.sample_spec === "object" ? r.sample_spec : null;
  const list = h("ul", { class: "ob-issues", "data-testid": "ob-issues" });
  for (const i of issues) {
    if (!i || typeof i !== "object") continue;
    const cost = Number.isFinite(i.expected_model_usd) ? "Expected cost: $" + i.expected_model_usd.toFixed(2) : "";
    const heading = [Number.isInteger(i.number) ? "#" + i.number : "", isText(i.title) ? i.title : ""].filter(Boolean).join(" ");
    if (!heading) continue; // nothing to name the issue by
    list.append(h("li", { class: "ob-issue" }, txt("strong", "ob-issue-title", heading), txt("span", "ob-muted", [isText(i.category) ? i.category : "", cost].filter(Boolean).join(" · "))));
  }
  // A run that succeeded with no readable issues says so, instead of a heading over nothing.
  const none = list.childNodes.length === 0;
  const parts = [h("h3", { class: "ob-sub" }, none ? TEXT.noIssuesHeading : "Issues it found")];
  if (none) {
    const note = txt("p", "ob-muted", TEXT.noIssues);
    note.setAttribute("data-testid", "ob-no-issues");
    parts.push(note);
  } else {
    parts.push(list);
  }
  if (spec && isText(spec.body)) {
    parts.push(h("h3", { class: "ob-sub" }, Number.isInteger(spec.issue_number) ? "Sample spec for issue #" + spec.issue_number : "Sample spec"), txt("pre", "ob-spec", spec.body));
  }
  return h("div", { "data-testid": "ob-result" }, parts);
}

const num = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);

/** m:ss, or h:mm:ss. A missing or negative value is 0:00, never "null" or "NaN". */
function clock(seconds) {
  const s = Math.max(0, Math.floor(num(seconds)));
  const m = Math.floor(s / 60);
  const pad = (n) => String(n).padStart(2, "0");
  return m >= 60 ? Math.floor(m / 60) + ":" + pad(m % 60) + ":" + pad(s % 60) : m + ":" + pad(s % 60);
}
/** US dollars: four decimals under a cent so a small real figure doesn't show as $0.00. */
function usd(n) {
  const v = Math.max(0, num(n));
  return "$" + (v > 0 && v < 0.01 ? v.toFixed(4) : v.toFixed(2));
}
const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? "" : String(vars[k])));

/** The server's progress object, checked and normalised; null when it isn't usable (the panel then falls back to the plain view). */
function parseProgress(raw) {
  if (!raw || typeof raw !== "object" || !OUTCOMES.includes(raw.outcome)) return null;
  const stages = Array.isArray(raw.stages) ? raw.stages.filter((s) => s && STAGE_IDS.includes(s.id) && STAGE_STATUS.includes(s.status)) : [];
  if (stages.length !== STAGE_IDS.length) return null;
  const feed = (Array.isArray(raw.feed) ? raw.feed : []).filter((l) => l && isText(l.text)).slice(-MAX_FEED).map((l) => String(l.text).slice(0, 100));
  const n = raw.numbers && typeof raw.numbers === "object" ? raw.numbers : {};
  const compute = n.compute && typeof n.compute === "object" ? n.compute : {};
  const model = n.model && typeof n.model === "object" ? n.model : {};
  return {
    outcome: raw.outcome,
    reason: isText(raw.reason) ? raw.reason : "",
    slow: raw.slow === true,
    slotFreed: raw.slot_freed === true,
    elapsed: Number.isFinite(raw.elapsed_seconds) ? raw.elapsed_seconds : null,
    repo: isText(raw.repo_name) ? raw.repo_name : "",
    stages: STAGE_IDS.map((id) => stages.find((s) => s.id === id)),
    feed,
    filesRead: Math.max(0, Math.floor(num(n.files_read))),
    compute: { usd: num(compute.usd), basis: ["estimate", "recorded"].includes(compute.basis) ? compute.basis : "none", cap: num(compute.cap_usd, 1) },
    model: { whose: WHOSE.includes(model.whose) ? model.whose : "customer", usd: Number.isFinite(model.usd) ? model.usd : null },
  };
}

function computeText(c) {
  const vars = { usd: usd(c.usd), cap: String(c.cap) };
  return fill(c.basis === "recorded" ? TEXT.computeRecorded : c.basis === "estimate" ? TEXT.computeEstimate : TEXT.computeNone, vars);
}
function modelText(m) {
  if (m.whose === "operator") return TEXT.modelOperator;
  const whose = TEXT.whose[m.whose];
  return m.usd !== null && m.usd > 0 ? fill(TEXT.modelUsed, { usd: usd(m.usd), whose }) : fill(TEXT.modelNone, { whose });
}

export function mountPreview(host, { openApp, announce, onSettled, onChoosePlan, canChoosePlan }) {
  const abort = new AbortController();
  const uid = "obp" + Math.random().toString(36).slice(2, 8);
  const st = { repos: undefined, preview: undefined, progress: null, busy: false, message: "", needKey: false };
  // The running timer counts from the server's own elapsed figure at the moment it arrived, so a wrong local clock can't skew it.
  let destroyed = false, timer = null, polls = 0, intent = null, lastState = "", settled = false, repoRead = 0;
  let tickId = null, timerEl = null, base = { secs: 0, at: 0 }, shown = "";

  const select = h("select", { class: "ob-input", id: uid + "-repo", "data-testid": "ob-repo" });
  const startBtn = h("button", { type: "button", class: "ob-btn ob-btn-primary", "data-testid": "ob-preview-start", onClick: start },
    "Start the free preview");
  const form = h("div", { class: "ob-form", hidden: true },
    h("label", { class: "ob-label", for: uid + "-repo" }, "Repository"), select,
    h("p", { class: "ob-muted" }, "This preview may spend up to " + CAP_USD + " US dollars of model usage from your model key."), startBtn);
  const noRepos = h("div", { hidden: true }, h("p", { class: "ob-muted" }, TEXT.noRepos),
    h("button", { type: "button", class: "ob-btn", "data-testid": "ob-preview-open-repos", onClick: () => openApp("repos") }, "Open Repos"));
  const previewEl = h("div", { "data-testid": "ob-preview-state" });
  const msgEl = h("p", { class: "ob-msg", "data-testid": "ob-preview-msg" });
  const keyBtn = h("button", { type: "button", class: "ob-btn", hidden: true, "data-testid": "ob-open-model-key", onClick: () => openApp("model-key") }, "Open Model Key");
  host.replaceChildren(form, noRepos, previewEl, msgEl, keyBtn);

  // The wait after a 429 on Start: "Try again in N seconds", with the Start button off until it ends.
  let waitOwnsMsg = false;
  const gate = createRetryGate({
    onChange(remaining) {
      if (destroyed) return;
      if (waitOwnsMsg) {
        st.message = remaining > 0 ? "Too many tries. " + retryWords(remaining) : "";
        msgEl.textContent = st.message;
        if (remaining === 0) waitOwnsMsg = false;
      }
      startBtn.disabled = st.busy || remaining > 0;
    },
  });

  function say(state, text) {
    if (state !== lastState) announce(text);
    lastState = state;
  }

  const elapsedNow = () => base.secs + (Date.now() - base.at) / 1000;
  function tick() {
    if (timerEl) timerEl.textContent = clock(elapsedNow());
  }
  function stopTicking() {
    clearInterval(tickId);
    tickId = null;
  }

  function stageList(pr) {
    const repo = pr.repo || TEXT.repoFallback;
    return h("ol", { class: "ob-stages", "aria-label": TEXT.timelineLabel, "data-testid": "ob-stages" },
      pr.stages.map((s) => h("li", { class: "ob-stage ob-stage-" + s.status, "data-testid": "ob-stage-" + s.id, "data-status": s.status, "aria-current": s.status === "active" ? "step" : null },
        txt("span", "ob-stage-name", fill(TEXT.stages[s.id], { repo })), txt("span", "ob-stage-word", TEXT.stageWords[s.status]))));
  }

  /** The feed keeps its scroll: pinned to the newest line unless the reader scrolled up. */
  function feedList(pr) {
    const ul = h("ul", { class: "ob-feed", tabindex: 0, "aria-label": TEXT.feedLabel, "data-testid": "ob-feed" });
    if (pr.feed.length === 0) ul.append(txt("li", "ob-feed-empty", TEXT.feedEmpty));
    for (const line of pr.feed) ul.append(txt("li", "ob-feed-line", line));
    const old = previewEl.querySelector('[data-testid="ob-feed"]');
    const pinned = !old || old.scrollHeight - old.scrollTop - old.clientHeight < 8;
    const keep = old ? old.scrollTop : 0;
    queueMicrotask(() => { ul.scrollTop = pinned ? ul.scrollHeight : keep; });
    return ul;
  }

  function numbersList(pr) {
    return h("ul", { class: "ob-numbers", "data-testid": "ob-numbers" },
      txt("li", "ob-number", fill(TEXT.filesRead, { n: pr.filesRead })),
      txt("li", "ob-number", computeText(pr.compute)), // the compute line is always ours, never free
      txt("li", "ob-number", modelText(pr.model)));
  }

  /** The panel for a preview with usable progress: the headline for its screen, the timeline, the feed and the numbers. */
  function progressView(pr, headline, failed) {
    const live = LIVE_OUTCOMES.includes(pr.outcome);
    const reasonKey = pr.outcome === "failed" || pr.outcome === "void" || pr.outcome === "sandbox_stopped" || pr.outcome === "agent_never_started" ? pr.reason : "";
    const reason = reasonKey && Object.hasOwn(TEXT.reasons, reasonKey) ? TEXT.reasons[reasonKey] : "";
    // A failure after the agent started, or a cancel, uses the one free preview up; ours before it started does not.
    const used = (pr.outcome === "failed" || pr.outcome === "cancelled" || pr.outcome === "sandbox_stopped") && !pr.slotFreed;
    const head = [txt("p", "ob-headline", headline)];
    if (failed) head[0].setAttribute("data-testid", "ob-preview-failed");
    else head[0].setAttribute("data-testid", "ob-outcome");
    if (reason) head.push(txt("p", "ob-muted", reason));
    if (used) head.push(txt("p", "ob-muted", TEXT.usedUp));
    if (failed) head.push(retryGuidance(pr.slotFreed));
    if (live && pr.slow) head.push(h("p", { class: "ob-slow", role: "status", "data-testid": "ob-slow" }, TEXT.slowNote));
    let timerRow = "";
    timerEl = null;
    if (pr.elapsed !== null) {
      timerEl = h("span", { class: "ob-timer", "data-testid": "ob-timer" }, clock(pr.elapsed));
      timerRow = h("p", { class: "ob-muted" }, TEXT.elapsed + " ", timerEl);
    }
    return h("div", { class: "ob-progress", "data-testid": "ob-progress", "data-outcome": pr.outcome },
      head, timerRow, stageList(pr),
      h("h3", { class: "ob-sub" }, TEXT.feedHeading), feedList(pr),
      h("h3", { class: "ob-sub" }, TEXT.numbersHeading), numbersList(pr));
  }

  /** What to do after a stopped preview: start again when the free preview was handed back, else skip to a plan. */
  function retryGuidance(slotFreed) {
    return h("p", { class: "ob-muted", "data-testid": "ob-preview-retry" }, slotFreed ? TEXT.retryFreed : TEXT.retrySkip);
  }

  /** The headline of a stopped preview. "Not used up" is said only when the preview row says the slot was handed back. */
  function stoppedHeadline(pr) {
    if (pr.slotFreed) return TEXT.outcome.agent_never_started;
    if (pr.outcome === "agent_never_started") return TEXT.outcome.agent_never_started_used;
    return pr.outcome === "failed" || pr.outcome === "void" || pr.outcome === "finished" ? TEXT.failed : TEXT.outcome[pr.outcome];
  }

  function previewView(p) {
    const pr = st.progress;
    const live = p.state === "requested" || p.state === "running";
    if (live && (!pr || LIVE_OUTCOMES.includes(pr.outcome))) {
      say("running", TEXT.announceRunning);
      if (!pr) return h("p", { class: "ob-muted" }, TEXT.running);
      return progressView(pr, TEXT.outcome[pr.outcome], false);
    }
    // A stopped preview: its own screen from the server's outcome, else the plain wording.
    const stopped = pr && !LIVE_OUTCOMES.includes(pr.outcome) && pr.outcome !== "finished";
    const r = p.state === "finished" ? p.result : null;
    if (stopped || !r || typeof r !== "object") {
      say("failed", TEXT.announceStopped);
      return pr ? progressView(pr, stoppedHeadline(pr), true) : h("div", null, h("p", { "data-testid": "ob-preview-failed" }, TEXT.failed), retryGuidance(false));
    }
    if (r.error === "invalid_output") {
      say("bad", TEXT.badOutput);
      return pr ? progressView(pr, TEXT.badOutput, false) : h("p", { "data-testid": "ob-preview-bad" }, TEXT.badOutput);
    }
    say("done", TEXT.announceDone);
    const payoff = h("div", { class: "ob-payoff", "data-testid": "ob-payoff" }, h("h3", { class: "ob-sub" }, TEXT.payoffHeading));
    if (canChoosePlan && canChoosePlan()) {
      payoff.append(txt("p", "ob-muted", TEXT.payoff),
        h("button", { type: "button", class: "ob-btn ob-btn-primary", "data-testid": "ob-choose-plan", onClick: () => onChoosePlan && onChoosePlan() }, TEXT.choosePlan));
    }
    return h("div", null, pr ? progressView(pr, TEXT.outcome.finished, false) : "", resultView(r), payoff.childNodes.length > 1 ? payoff : "");
  }

  function render() {
    if (destroyed) return;
    const p = st.preview;
    // A preview that failed on our side before the agent started did not use up the free preview: Start is offered again.
    form.hidden = !(startable() && st.repos && st.repos.length > 0);
    noRepos.hidden = !(startable() && st.repos && st.repos.length === 0);
    startBtn.disabled = st.busy || gate.remaining > 0;
    select.disabled = st.busy;
    // Rebuilt only when what it shows changed (the elapsed figure is kept current by the timer), so a poll that
    // brings nothing new doesn't reset the feed's scroll or take keyboard focus out of it.
    const sig = p ? JSON.stringify([p, st.progress && { ...st.progress, elapsed: 0 }, !!(canChoosePlan && canChoosePlan())]) : "";
    if (sig !== shown) {
      shown = sig;
      timerEl = null;
      previewEl.replaceChildren(...(p ? [previewView(p)] : []));
    }
    msgEl.textContent = st.message;
    keyBtn.hidden = !st.needKey;
    // The timer ticks only while the preview is live and only its text changes; a stopped preview shows a fixed figure.
    const live = !!p && (p.state === "requested" || p.state === "running") && (!st.progress || LIVE_OUTCOMES.includes(st.progress.outcome));
    if (live && !tickId && timerEl) tickId = setInterval(tick, TICK_MS);
    if (!live || !timerEl) stopTicking();
  }

  async function loadRepos() {
    const mine = ++repoRead; // a newer read supersedes this one, so an old answer never puts a removed repo back
    const repos = [];
    let cursor = null;
    for (let i = 0; i < MAX_PAGES; i++) {
      const page = await api("GET", cursor ? REPOS_URL + "?cursor=" + encodeURIComponent(cursor) : REPOS_URL, undefined, abort.signal);
      for (const r of (page && Array.isArray(page.data) ? page.data : [])) {
        if (r && typeof r.id === "string" && r.app_kind === "team_readonly" && r.install_state === "installed") repos.push(r);
      }
      cursor = page && typeof page.next_cursor === "string" && page.next_cursor ? page.next_cursor : null;
      if (!cursor) break;
    }
    if (mine !== repoRead) return;
    const chosen = select.value;
    select.replaceChildren(...repos.map((r) => h("option", { value: r.id }, String(r.full_name || r.product))));
    if (repos.some((r) => r.id === chosen)) select.value = chosen;
    st.repos = repos;
  }

  /** No preview yet, or the last one failed on our side before the agent started (the free preview is not used up). */
  const startable = () => st.preview === null || (!!st.preview && !!st.progress && st.progress.slotFreed);

  /** Re-reads the repo list (the account's repos changed). A failed read shows no list rather than an old one. */
  async function refreshRepos() {
    if (destroyed || !startable()) return; // no preview read yet, or one exists that used the free preview up, so no repo is picked
    try {
      await loadRepos();
      if (st.message === TEXT.loadFailed) st.message = "";
    } catch (e) {
      if (cancelled(e) || destroyed) return;
      st.repos = undefined;
      select.replaceChildren();
      st.message = TEXT.loadFailed;
    }
    render();
  }

  async function loadPreview() {
    const body = await api("GET", PREVIEW_URL, undefined, abort.signal);
    const p = body && body.preview;
    if (p !== null && !(p && STATES.includes(p.state))) throw new Error("shape");
    st.preview = p;
    st.progress = p ? parseProgress(body.progress) : null;
    if (st.progress && st.progress.elapsed !== null) base = { secs: st.progress.elapsed, at: Date.now() };
    st.message = "";
    render();
    if (!p) return;
    if (p.state === "finished" || p.state === "void") {
      if (!settled) {
        settled = true;
        onSettled();
      }
    } else if (polls < MAX_POLLS) {
      timer = setTimeout(poll, polls < FAST_POLLS ? POLL_MS : SLOW_POLL_MS);
    } else {
      st.message = TEXT.slow;
      render();
      stopTicking(); // polling has stopped, so the figures are no longer being kept current
    }
  }

  async function poll() {
    polls++;
    try {
      await loadPreview();
    } catch (e) {
      if (cancelled(e) || destroyed) return;
      if (polls < MAX_POLLS) {
        timer = setTimeout(poll, polls < FAST_POLLS ? POLL_MS : SLOW_POLL_MS); // a failed read does not end the wait; MAX_POLLS does
      } else {
        st.message = TEXT.loadFailed;
        render();
        stopTicking();
      }
    }
  }

  function startFailure(e) {
    const code = e instanceof ApiFailure ? e.code : "";
    const status = e instanceof ApiFailure ? e.status : 0;
    if (status === 503 && code === "preview_unavailable") return TEXT.notYet;
    if (status === 409 && code === "model_key_required") {
      st.needKey = true;
      return TEXT.noKey;
    }
    if (status === 409 && code === "preview_capacity") return TEXT.busy;
    if (status === 409 && code === "preview_exists") return "";
    if (status === 404) return TEXT.gone;
    return status === 409 ? TEXT.other409 : TEXT.generic;
  }

  async function start() {
    if (st.busy || !select.value || gate.remaining > 0) return;
    // One key per user intent. A retry after a failure the server may not have seen keeps it.
    if (!intent || intent.repoId !== select.value || !intent.retry) intent = { repoId: select.value, key: crypto.randomUUID(), retry: false };
    st.busy = true;
    st.message = "";
    st.needKey = false;
    render();
    try {
      await api("POST", PREVIEW_URL, { repo_id: intent.repoId, confirm_model_cap_usd: CAP_USD }, abort.signal, { idempotencyKey: intent.key });
    } catch (e) {
      if (cancelled(e) || destroyed) return;
      st.busy = false;
      // Only a failure the server may not have seen keeps the key for the retry.
      if (e instanceof ApiFailure && e.status > 0 && e.status < 500) intent = null;
      else intent.retry = true;
      if (isRateLimited(e)) {
        waitOwnsMsg = true;
        gate.start(waitSeconds(e));
      } else {
        waitOwnsMsg = false;
        st.message = startFailure(e);
      }
      render();
      if (e instanceof ApiFailure && e.code === "preview_exists") await poll(); // show the one that exists
      if (e instanceof ApiFailure && e.status === 404) await refreshRepos(); // the repo went away: drop it from the list
      return;
    }
    intent = null;
    st.busy = false;
    settled = false; // a fresh preview after one that did not use up the free preview
    polls = 0;
    await poll();
  }

  (async () => {
    st.message = "Loading…";
    render();
    try {
      await loadPreview();
      if (startable()) await loadRepos();
      if (st.preview === null) st.message = "";
    } catch (e) {
      if (cancelled(e) || destroyed) return;
      st.message = TEXT.loadFailed;
    }
    render();
  })();

  return {
    /** True once a preview exists (running, finished or void): the panel then shows it and offers no Start. */
    active: () => st.preview != null,
    refreshRepos,
    rerender: render,
    destroy() {
      destroyed = true;
      gate.cancel();
      clearTimeout(timer);
      stopTicking();
      abort.abort();
      host.replaceChildren();
    },
  };
}
