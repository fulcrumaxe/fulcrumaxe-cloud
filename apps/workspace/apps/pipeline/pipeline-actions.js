// D#37 WS-F1c: Cancel and Retry for the runs of one work item, shown in the
// Pipeline detail's Runs section. Two halves: createActions() is the logic
// (no DOM, unit-tested with a fake call() and a fake clock) and
// createRunsPanel() is the view built with h(). Text only.
//
// Rules this file keeps:
//  - Nothing is sent until the person confirms in a dialog.
//  - A retry carries an Idempotency-Key made when Confirm is first pressed;
//    "Try again" after a network failure resends that same key, and a new
//    dialog makes a new one.
//  - What the person reads for a refusal comes from SENTENCES below, never
//    from a server code or message.
//  - No new live subscription: the app hands run.status_changed and refresh
//    to live() from the subscriptions the board already holds.
import { h } from "../_lib/dom.js";
import { api } from "../_lib/api.js";

export const LIVE_STATUSES = ["pending", "running", "paused"];
export const RETRYABLE_STATUSES = ["failed", "timed_out", "killed_spend", "refused_spend", "cancelled"];
const TERMINAL = ["succeeded", ...RETRYABLE_STATUSES];
export const STATUS_WORDS = {
  pending: "Waiting to start", running: "Running", paused: "Paused", succeeded: "Succeeded", failed: "Failed",
  timed_out: "Timed out", killed_spend: "Stopped at the spend limit", refused_spend: "Not started: spend limit", cancelled: "Cancelled",
};
export const POLL_MS = 5000;
export const CEILING_MS = 180000;
const STILL_WORKING = "Still working. Check back shortly.";
/** What the dialog's two buttons say: the confirm answers the question, the dismiss says what staying means. */
const DIALOG_BUTTONS = {
  cancel: { confirm: "Yes, cancel run", dismiss: "Keep the run" },
  retry: { confirm: "Yes, retry run", dismiss: "Don't retry" },
};
let dialogSeq = 0; // each dialog's description id is its own, so two dialogs never share one

/** Every code the cancel and retry routes and the retry performer can answer, as the sentence a person reads. */
export const SENTENCES = {};
const say = (sentence, ...codes) => codes.forEach((c) => (SENTENCES[c] = sentence));
say("Couldn't reach the server.", "network");
say("This run has already stopped.", "not_cancellable");
say("Run actions aren't available right now. Try again later.", "run_actions_unavailable");
say("Sign in again to do this.", "session_required");
say("Your role can't do this.", "insufficient_role", "principal_not_authorised");
say("Your account isn't active, so runs can't be started or stopped.", "account_not_active");
say("The person who opened this work item no longer has access to the repository, so it can't be run again.", "untrusted_author");
say("This run can't be retried right now.", "run_not_retryable", "kind_mismatch", "target_not_found", "kind_not_supported");
say("This work item has used up its fix attempts. A person needs to look at it.", "escalate");
say("Access to the repository couldn't be checked right now. Nothing was started.", "author_check_unavailable");
say("That request was already used. Close this and try again.", "idempotency_key_reused");
say("Retrying isn't available yet.", "retry_unavailable");
say("The original request isn't kept any more, so this run can't be repeated.", "prompt_not_retained");
say("This account isn't set up to start a run for this work item.", "unknown_role", "no_card", "no_repo", "no_installation", "installation_not_writable", "no_model", "model_budget_unset", "limits_exceed_sandbox", "account_not_found", "seat_refused");
say("A spending limit stopped this retry. Nothing was started.", "refused_spend", "model_budget_exceeded", "per_spawn_cap_exceeded", "limit_exceeded", "quota_exceeded", "work_item_cap_exceeded", "compute_cap_exceeded");
const GENERIC = "That didn't work. Nothing was changed.";
export const sentenceFor = (code) => (Object.prototype.hasOwnProperty.call(SENTENCES, code) ? SENTENCES[code] : GENERIC);

const money = (n) => "$" + Number(n).toFixed(2);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const apiUsd = (n) => "$" + (n !== 0 && Math.abs(n) < 0.01 ? n.toFixed(4) : n.toFixed(2));
const tok = (n) => (Number.isFinite(n) ? n.toLocaleString("en-US") : "0");

/**
 * D#6 R2b-5b: a run on the person's own machine, what it would have cost at API prices (information, never spend). The same words
 * as the Runs app's detail (runs-detail.js runnerUsageLine; test/runs-detail.test.mjs pins the two together). A sandbox run has none.
 */
export function runnerUsageText(run) {
  if (!run || run.runtime !== "runner") return null;
  const u = isObj(run.runner_usage) ? run.runner_usage : null;
  if (!u) return null;
  const price = Number.isFinite(u.api_equivalent_usd) ? apiUsd(u.api_equivalent_usd) : null;
  const toks = tok(u.tokens_in) + " in / " + tok(u.tokens_out) + " out tokens";
  if (u.credential_mode === "api_key") return "On your own API key \u00b7 " + (price ? price + " at API prices" : "no API price for this model") + " \u00b7 " + toks;
  return "On your Claude plan \u00b7 " + (price ? "API-equivalent " + price : "no API price for this model") + " \u00b7 " + toks;
}

/** The work item's separate total, shown only when its runs on the person's machine have one. */
export const ownPlanText = (usd) => (Number.isFinite(usd) && usd > 0 ? "On your own plan (API-equivalent): " + apiUsd(usd) : null);

const validRun = (r) => r && typeof r === "object" && typeof r.id === "string" && typeof r.role === "string" && typeof r.status === "string";

/** Cancel for a live run; Retry for a failed-kind run that is the newest of its role. `runs` is newest first. */
export function controlsFor(run, runs, pending = false) {
  if (pending) return { cancel: false, retry: false };
  const newest = runs.find((r) => r.role === run.role);
  return {
    cancel: LIVE_STATUSES.includes(run.status),
    retry: RETRYABLE_STATUSES.includes(run.status) && !!newest && newest.id === run.id,
  };
}

/** The lines a dialog shows, from what it has read so far (info is null until the read answers). */
export function dialogLines(d) {
  if (d.kind === "cancel") {
    if (!d.info) return ["Checking what this run has cost…"];
    return [
      Number.isFinite(d.info.usd) ? "Spent so far: " + money(d.info.usd) : "Spent so far: not known yet",
      "Anything reserved for this run and not spent is released.",
    ];
  }
  const out = [];
  if (!d.info) return ["Checking what a retry usually costs…"];
  if (Number.isFinite(d.info.median)) {
    out.push("Usually about " + money(d.info.median) + " per run");
    if (d.info.caveat) out.push(d.info.caveat);
  } else out.push("The expected spend isn't available right now.");
  out.push("A retry may use a stronger model, which can cost more.");
  return out;
}

export function createActions({ itemId, repoId, call = api, uuid = () => crypto.randomUUID(), onChange = () => {} } = {}) {
  const ac = new AbortController();
  const pend = new Map(); // run id -> { kind, role, actionId, since, timer }
  let destroyed = false;
  let shown = true;
  let seq = 0;
  let st = { list: "loading", runs: [], more: false, dialog: null, notice: null };
  const set = (patch) => {
    if (destroyed) return;
    st = { ...st, ...patch };
    onChange(st);
  };

  function clear(runId) {
    const p = pend.get(runId);
    if (!p) return;
    clearInterval(p.timer);
    pend.delete(runId);
    set({});
  }

  // A retry is over once the list shows a run of the same role newer than the retried one.
  function settleRetries() {
    for (const [runId, p] of [...pend]) {
      if (p.kind !== "retry") continue;
      const at = st.runs.findIndex((r) => r.id === runId);
      if (st.runs.slice(0, at < 0 ? st.runs.length : at).some((r) => r.role === p.role)) clear(runId);
    }
  }

  async function load() {
    if (destroyed) return;
    const mine = ++seq;
    try {
      const body = await call("GET", "/api/v1/runs?work_item_id=" + encodeURIComponent(itemId) + "&limit=10", undefined, ac.signal);
      if (destroyed || mine !== seq) return;
      set({ list: "ready", runs: body && Array.isArray(body.data) ? body.data.filter(validRun) : [], more: !!(body && body.next_cursor) });
      settleRetries();
    } catch {
      if (!destroyed && mine === seq && st.list !== "ready") set({ list: "error" });
    }
  }

  function startPoll(runId) {
    const p = pend.get(runId);
    if (!p || p.timer || !shown) return;
    p.timer = setInterval(() => tick(runId), POLL_MS);
  }

  async function tick(runId) {
    const p = pend.get(runId);
    if (!p) return;
    if (Date.now() - p.since >= CEILING_MS) {
      clear(runId);
      set({ notice: STILL_WORKING });
      return;
    }
    try {
      const a = await call("GET", "/api/v1/run-actions/" + encodeURIComponent(p.actionId), undefined, ac.signal);
      if (destroyed || pend.get(runId) !== p || !a) return;
      if (a.state === "done") {
        clear(runId);
        load();
      } else if (a.state === "refused" || a.state === "failed") {
        clear(runId);
        set({ notice: sentenceFor(a.error_code) });
        load();
      }
    } catch {
      /* the next tick asks again */
    }
  }

  function accept(d, actionId) {
    if (typeof actionId === "string" && ![...pend.values()].some((p) => p.actionId === actionId)) {
      pend.set(d.run.id, { kind: d.kind, role: d.run.role, actionId, since: Date.now(), timer: null });
      startPoll(d.run.id);
    }
    set({ dialog: null });
  }

  function openDialog(kind, run) {
    if (destroyed || st.dialog) return;
    const d = { kind, run, key: null, phase: "ready", info: null, error: null };
    set({ dialog: d, notice: null });
    const read =
      kind === "cancel"
        ? call("GET", "/api/v1/runs/" + run.id, undefined, ac.signal).then((r) => ({ usd: r && r.usd }))
        : call("GET", "/api/v1/repos/" + repoId + "/roles", undefined, ac.signal).then((b) => {
            const role = b && Array.isArray(b.data) ? b.data.find((x) => x && x.role === run.role) : null;
            const s = role && role.expected_spend;
            return s && Number.isFinite(s.median_cost_per_run_usd) ? { median: s.median_cost_per_run_usd, caveat: typeof s.caveat === "string" ? s.caveat : "" } : {};
          });
    read.catch(() => ({})).then((info) => {
      if (st.dialog !== d || destroyed) return;
      d.info = info;
      set({});
    });
  }

  function dismiss() {
    if (st.dialog && st.dialog.phase !== "sending") set({ dialog: null });
  }

  async function confirm() {
    const d = st.dialog;
    if (destroyed || !d || d.phase === "sending") return;
    d.phase = "sending";
    d.error = null;
    set({});
    const retry = d.kind === "retry";
    if (retry && !d.key) d.key = uuid();
    try {
      const res = await call("POST", "/api/v1/runs/" + d.run.id + "/" + d.kind, undefined, ac.signal, retry ? { idempotencyKey: d.key } : undefined);
      if (!destroyed) accept(d, res && res.action_id);
    } catch (e) {
      if (destroyed || (e && e.name === "AbortError")) return;
      if (e && e.status === 401) return set({ dialog: null }); // the shell's live client has taken it from here
      if (e && e.code === "not_cancellable") {
        set({ dialog: null, notice: SENTENCES.not_cancellable });
        return load();
      }
      d.phase = "error";
      d.error = e && e.status === 0 ? "network" : e && e.code;
      set({});
    }
  }

  const first = () => [...pend.values()][0];
  return {
    itemId,
    getState: () => st,
    controls: (run) => controlsFor(run, st.runs, pend.has(run.id)),
    pendingOf: (runId) => pend.get(runId) || null,
    label: () => (first() ? (first().kind === "cancel" ? "Cancelling…" : "Retrying…") : null),
    load,
    openDialog,
    dismiss,
    confirm,
    onRunChanged(data) {
      const p = data && pend.get(data.runId);
      if (p && p.kind === "cancel" && TERMINAL.includes(data.to)) clear(data.runId);
      load();
    },
    hide() {
      shown = false;
      for (const p of pend.values()) {
        clearInterval(p.timer);
        p.timer = null;
      }
    },
    show() {
      shown = true;
      for (const [runId, p] of [...pend]) {
        if (Date.now() - p.since >= CEILING_MS) {
          clear(runId);
          set({ notice: STILL_WORKING });
        } else startPoll(runId);
      }
    },
    liveTimers: () => [...pend.values()].filter((p) => p.timer).length,
    destroy() {
      destroyed = true;
      ac.abort();
      for (const p of pend.values()) clearInterval(p.timer);
      pend.clear();
    },
  };
}

/** The Runs section: `el` goes into the detail; label() is the pending text for the card. */
export function createRunsPanel({ itemId, repoId, call, uuid, onChange = () => {}, ownPlanUsd = () => null }) {
  let lastLabel = null;
  let lastLive = false;
  let dlg = null;
  let parts = null;
  let shownFor = null;
  const ctl = createActions({
    itemId, repoId, call, uuid,
    onChange: (st) => {
      paint(st);
      const l = ctl.label();
      // The parent redraws when the card's label changes, and when the item gains or loses a live run (the approve button depends on it).
      const live = st.runs.some((r) => LIVE_STATUSES.includes(r.status));
      if (l !== lastLabel || live !== lastLive) {
        lastLabel = l;
        lastLive = live;
        announce.textContent = l || "";
        onChange();
      }
    },
  });
  const notice = h("p", { class: "pl-muted", role: "status", "data-testid": "pl-runs-notice" });
  // The card's label is rebuilt on every board paint, so the announcement comes from this one persistent polite region.
  const announce = h("p", { class: "pl-sr", "aria-live": "polite", "data-testid": "pl-announce" });
  const list = h("div", { "data-testid": "pl-runs-list" });
  const el = h("section", { class: "pl-runs", "data-testid": "pl-runs", "aria-labelledby": "pl-runs-h" }, h("h3", { class: "pl-detail-sub", id: "pl-runs-h" }, "Runs"), notice, announce, list);

  function row(run) {
    const c = ctl.controls(run);
    const p = ctl.pendingOf(run.id);
    const btn = (kind, text, testid) =>
      h("button", { type: "button", class: "pl-act", "data-testid": testid, "aria-label": text + ": " + run.role, onClick: () => ctl.openDialog(kind, run) }, text);
    return h(
      "li",
      { class: "pl-run", tabindex: "-1", "data-testid": "pl-run", "data-run-id": run.id, "data-status": run.status, "data-action-id": p ? p.actionId : null },
      h("span", { class: "pl-run-main" }, h("bdi", null, run.role), " · ", STATUS_WORDS[run.status] || "Another status", Number.isFinite(run.usd) ? " · " + money(run.usd) : ""),
      runnerUsageText(run) ? h("span", { class: "pl-run-usage pl-muted", "data-testid": "pl-run-usage" }, runnerUsageText(run)) : null,
      p ? h("span", { class: "pl-run-pending", "data-testid": "pl-run-pending" }, p.kind === "cancel" ? "Cancelling…" : "Retrying…") : null,
      c.cancel ? btn("cancel", "Cancel run", "pl-cancel") : null,
      c.retry ? btn("retry", "Retry run", "pl-retry") : null
    );
  }

  function paintDialog(d) {
    if (!d) {
      if (!dlg) return;
      const run = shownFor.run;
      dlg.close();
      dlg.remove();
      dlg = parts = shownFor = null;
      const back = list.querySelector('[data-run-id="' + run.id + '"]');
      if (back) (back.querySelector("button") || back).focus();
      return;
    }
    if (!dlg) {
      const title = d.kind === "cancel" ? "Cancel this run?" : "Retry this run?";
      const descId = "pl-dlg-d-" + ++dialogSeq;
      parts = {
        info: h("div", { id: descId, "data-testid": "pl-dialog-info" }),
        err: h("p", { class: "pl-dialog-error", role: "alert", tabindex: "-1", "data-testid": "pl-dialog-error" }),
        confirm: h("button", { type: "button", class: "pl-act", "data-testid": "pl-confirm", onClick: () => parts.confirm.getAttribute("aria-disabled") !== "true" && ctl.confirm() }, DIALOG_BUTTONS[d.kind].confirm),
        again: h("button", { type: "button", class: "pl-act", "data-testid": "pl-try-again", onClick: () => ctl.confirm() }, "Try again"),
        close: h("button", { type: "button", class: "pl-act", "data-testid": "pl-dialog-close", onClick: () => ctl.dismiss() }, DIALOG_BUTTONS[d.kind].dismiss),
      };
      dlg = h(
        "dialog",
        { class: "pl-dialog", "data-testid": "pl-dialog", "aria-labelledby": "pl-dlg-h", "aria-describedby": descId, onCancel: (e) => (e.preventDefault(), ctl.dismiss()), onClick: (e) => e.target === dlg && ctl.dismiss() },
        h("div", { class: "pl-dialog-body" }, h("h2", { class: "pl-dialog-title", id: "pl-dlg-h" }, title), parts.info, parts.err, h("div", { class: "pl-dialog-actions" }, parts.close, parts.confirm, parts.again))
      );
      document.body.appendChild(dlg);
      dlg.showModal();
      parts.close.focus();
    }
    shownFor = d;
    parts.info.replaceChildren(...dialogLines(d).map((t) => h("p", null, t)));
    parts.err.textContent = d.error ? sentenceFor(d.error) : "";
    parts.confirm.hidden = d.phase === "error";
    parts.close.textContent = d.phase === "error" ? "Close" : DIALOG_BUTTONS[d.kind].dismiss;
    // aria-disabled, not disabled: a disabled button drops keyboard focus while the request is out.
    parts.confirm.setAttribute("aria-disabled", d.phase === "sending" ? "true" : "false");
    parts.again.hidden = !(d.phase === "error" && d.error === "network");
    // A button that was just hidden took the focus with it: send it to the button still there, or to the error.
    const at = document.activeElement;
    if (!dlg.contains(at) || at.hidden) (d.phase === "error" ? parts.err : parts.confirm).focus();
  }

  function paint(st) {
    notice.textContent = st.notice || "";
    const body =
      st.list === "loading" ? h("p", { class: "pl-muted" }, "Loading runs…")
      : st.list === "error" ? h("p", { class: "pl-muted", "data-testid": "pl-runs-error" }, "Runs aren't available right now.")
      : st.runs.length === 0 ? h("p", { class: "pl-muted" }, "No runs yet.")
      : h("ul", { class: "pl-runlist" }, st.runs.map(row), st.more ? h("li", { class: "pl-muted" }, "Older runs are in the Runs app.") : null);
    const own = st.list === "ready" ? ownPlanText(ownPlanUsd()) : null;
    // Rebuilding the rows must not drop keyboard focus: put it back on the same control of the same run.
    const held = list.contains(document.activeElement) && document.activeElement.closest("[data-run-id]");
    const heldId = held && held.dataset.runId;
    const heldTest = held && document.activeElement.dataset.testid;
    list.replaceChildren(body, ...(own ? [h("p", { class: "pl-muted", "data-testid": "pl-own-plan" }, own)] : []));
    if (held) {
      const again = list.querySelector('[data-run-id="' + heldId + '"]');
      const target = again && ((heldTest && again.querySelector('[data-testid="' + heldTest + '"]')) || again);
      if (target) target.focus();
    }
    paintDialog(st.dialog);
  }

  const onVis = () => (document.visibilityState === "hidden" ? ctl.hide() : ctl.show());
  document.addEventListener("visibilitychange", onVis);
  paint(ctl.getState());
  ctl.load();

  return {
    el,
    itemId,
    label: ctl.label,
    liveTimers: ctl.liveTimers,
    /** True when any run read for this item is pending, running or paused: the approve button is not offered then. */
    hasLive: () => ctl.getState().runs.some((r) => LIVE_STATUSES.includes(r.status)),
    live(type, dto) {
      if (type === "run.status_changed") ctl.onRunChanged(dto && dto.data);
      else if (type === "refresh") ctl.load();
    },
    destroy() {
      document.removeEventListener("visibilitychange", onVis);
      ctl.destroy();
      if (lastLabel) onChange(); // the card's label goes with the panel
      if (dlg) {
        dlg.close();
        dlg.remove();
        dlg = null;
      }
    },
  };
}

// --- Approve and start (folded in from pipeline-approve.js to keep the app within the boot-file budget) ---
// D#483 P1 + P2 + P3: the approve button on the Pipeline detail for an internal work item. One click asks the server to
// start the next part of the pipeline for the item, and WHICH part depends on the stage:
//   Triaged           -> "Approve and start": the agents triage it, the panel discusses it and a Spec is written.
//   Discussing        -> "Try the Spec again": a panel or Spec step that failed leaves the item here with no Spec.
//   Spec ready        -> "Approve the Spec and build": an agent implements the Spec and opens a pull request.
//   In progress       -> "Check the build": nothing is running, so the pipeline looks for the build's pull request. Found, the
//                        reviewers run on it; none, the card moves to Needs human with the agent's own account.
//   Pull request open -> "Approve and review" / "Continue the review" / "Check the merge": the reviewers, the fix rounds
//                        and the merge gate.
// A note under the button says what that stage starts, before the click; one sentence after it says what happened. The
// button is not offered while any run of the item is live (the server refuses that too, with `already_running`).
//
// Rules this file keeps:
//  - The request carries NO body (the route takes none; a body is refused).
//  - What the person reads for each outcome comes from APPROVE_SENTENCES below, never from a server code or message.
//  - One request at a time per card: the button is disabled while it is sending and after it started; opening the card
//    again starts fresh (a classify that failed leaves the item at Triaged, and the person can approve it again).
//  - The request is followed for a few moments after the server accepts it: the worker answers what costs nothing to
//    check (the agent's seat, the model key, the budget, the repository connection) before it starts anything, and a
//    refusal there reaches the sentence. A request still going after that has started.
//  - Text only, built with h().

export const APPROVE_LABEL = "Approve and start";
export const APPROVE_BUILD_LABEL = "Approve the Spec and build";
export const SENDING = "Sending…";

/** Every outcome the route and its network can answer, as the sentence a person reads. */
export const APPROVE_SENTENCES = {};
const approveSay = (sentence, ...codes) => codes.forEach((c) => (APPROVE_SENTENCES[c] = sentence));
approveSay("Started. The agents are reading this issue now, and the card moves when they are done.", "started");
approveSay("Started. An agent is building this now, and the card moves when it opens a pull request.", "started_build");
approveSay("Started. The agents are discussing this again, and a Spec follows when they are done.", "started_spec");
approveSay("Started. The pipeline is checking whether the build opened a pull request, and the card moves when it knows.", "started_check");
approveSay("Started. Reviewers are checking the pull request now, and the card moves when they are done.", "started_review");
approveSay("The agents are already working on this one.", "already_running");
approveSay("This item can't be started from here any more. It has already moved on, or it has no GitHub issue behind it.", "not_approvable", "not_found");
approveSay("This item isn't linked to a repository, so nothing can be started.", "no_repo");
approveSay("This item came from someone outside your team, so a person has to move it.", "external_requires_human");
// The refusals that cost nothing, answered before anything is started: the first agent's seat.
approveSay("This account isn't set up to start this work. Check the repository's roles and its GitHub connection, then try again.", "unknown_role", "no_card", "no_installation", "installation_not_writable", "limits_exceed_sandbox", "account_not_found", "seat_refused");
approveSay("There is no model key for this work yet. Add one in the model settings, then try again.", "no_model");
approveSay("There is no model budget set for this work yet. Set one in the model settings, then try again.", "model_budget_unset");
approveSay("A spending limit stopped this. Nothing was started.", "refused_spend", "spend_refused", "model_budget_exceeded", "per_spawn_cap_exceeded", "limit_exceeded", "quota_exceeded", "work_item_cap_exceeded", "compute_cap_exceeded");
approveSay("This can't be done from here any more. The item has moved on, or it isn't the kind of item this applies to. Open the card again to see where it is.", "action_not_available");
approveSay("The Spec changed since this page loaded. Open the card again to see the current one.", "spec_changed");
approveSay("Only an owner or an admin can start this.", "insufficient_role", "principal_not_authorised");
approveSay("Sign in again to do this.", "session_required");
approveSay("Your account isn't active, so nothing can be started.", "account_not_active");
approveSay("Starting work isn't available right now. Try again later.", "run_actions_unavailable", "advance_unavailable");
approveSay("Couldn't reach the server. Nothing was started.", "network", "offline", "timeout");
approveSay("You're doing that too fast. Try again in a moment.", "rate_limited");
approveSay("That request was already used. Close this and try again.", "idempotency_key_reused");
const APPROVE_GENERIC = "That didn't work. Nothing was started.";
export const approveSentenceFor = (code) => (Object.prototype.hasOwnProperty.call(APPROVE_SENTENCES, code) ? APPROVE_SENTENCES[code] : APPROVE_GENERIC);

/** What each approvable stage starts, in words: shown under the button before the click. */
export const NOTES = {
  triaged:
    "Starts the pipeline for this issue. The agents read it and decide what kind of work it is. Critical, feature and project work then goes to the panel, which writes a Spec. Nothing is built until you approve that Spec. Small, bug and doc work gets a short Spec from the project manager and is built straight away; if the project manager judges the request cannot be built as written, it stops there, and its reason is in the run.",
  discussing: "This runs the panel and the Spec again. If the item already has a Spec, the new one supersedes it.",
  spec_ready: "Starts the build. An agent implements the Spec on its own branch, runs the tests and opens a pull request. The card moves when the pull request opens.",
  in_progress:
    "Checks whether the build opened a pull request. If it did, the reviewers run on it. If it did not, the card moves to Needs a person, with the agent's own account of why.",
  pr_opened:
    "Starts the review. Reviewers check the pull request's latest commit. If they ask for changes, the agent that built it fixes them and they check again. When they all pass, the merge is checked.",
  changes_requested: "Continues the review of the pull request's latest commit. Reviewers that already checked it are not run again.",
  review_passed: "Every reviewer has passed. This checks the merge: the pull request is merged only if the repository allows it and its checks are green.",
};

/** Kinds whose Spec is never built (a question is answered, a project is planned). The server refuses them too. */
const NOT_BUILT = ["question", "project"];

/** The stages that have a pull request to review. */
const PR_STAGES = ["pr_opened", "changes_requested", "review_passed"];

export const LABELS = {
  triaged: APPROVE_LABEL,
  discussing: "Try the Spec again",
  spec_ready: APPROVE_BUILD_LABEL,
  in_progress: "Check the build",
  pr_opened: "Approve and review",
  changes_requested: "Continue the review",
  review_passed: "Check the merge",
};

/** The label of the button for this item's stage. */
export const labelFor = (item) => (item && Object.prototype.hasOwnProperty.call(LABELS, item.stage) ? LABELS[item.stage] : APPROVE_LABEL);

/** Run statuses that mean an agent is working on the item. The server refuses an approval while any run is in one of them. */
export const LIVE_RUN_STATUSES = ["pending", "running", "paused"];

/** True when any of the item's runs is one an agent is working on. `runs` are run DTOs ({ status }). */
export const anyLiveRun = (runs) => Array.isArray(runs) && runs.some((r) => r && LIVE_RUN_STATUSES.includes(r.status));

/** Which "started" sentence a stage gets. */
const startedFor = (item) =>
  item.stage === "spec_ready" ? APPROVE_SENTENCES.started_build : item.stage === "discussing" ? APPROVE_SENTENCES.started_spec : item.stage === "in_progress" ? APPROVE_SENTENCES.started_check : PR_STAGES.includes(item.stage) ? APPROVE_SENTENCES.started_review : APPROVE_SENTENCES.started;

/**
 * The button is offered for an internal item that has a repository and an issue number, at a stage the server can
 * advance from, and with no run of its own live (`liveRun`). At Spec ready the item is the pipeline's root: its kind is
 * the discussion's, and a question or a project has nothing to build. At Discussing only a kind with a panel qualifies.
 * At In progress ("Check the build") and the pull-request stages the server also needs a published Spec; it answers `not_approvable` when there is none.
 */
export function canApprove(item, liveRun = false) {
  if (liveRun === true) return false;
  if (!item || item.provenance !== "internal" || typeof item.repo_id !== "string" || item.repo_id === "" || !Number.isInteger(item.issue_number)) return false;
  if (item.stage === "triaged" || item.stage === "in_progress" || PR_STAGES.includes(item.stage)) return true;
  if (item.stage === "discussing") return item.kind === "critical" || item.kind === "feature";
  return item.stage === "spec_ready" && typeof item.kind === "string" && item.kind !== "" && !NOT_BUILT.includes(item.kind);
}

/** The route's path. The id is encoded; no body goes with it. */
export const approvePath = (id) => "/api/v1/work-items/" + encodeURIComponent(id) + "/approve";
/** Where the request's outcome is read. */
export const actionPath = (id) => "/api/v1/run-actions/" + encodeURIComponent(id);

/** How an accepted request is followed: how many reads, and how long between them. */
export const FOLLOW_POLLS = 8;
export const FOLLOW_GAP_MS = 700;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The error code the worker refused an accepted request with, or null (done, or still going after the reads). A failed read is not a refusal. */
export async function followAccepted(call, sleep, accepted) {
  const id = accepted && typeof accepted.action_id === "string" ? accepted.action_id : null;
  if (id === null) return null;
  for (let i = 0; i < FOLLOW_POLLS; i += 1) {
    let a;
    try {
      a = await call("GET", actionPath(id), undefined);
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      return null;
    }
    if (a && (a.state === "refused" || a.state === "failed")) return typeof a.error_code === "string" && a.error_code !== "" ? a.error_code : "refused";
    if (a && a.state === "done") return null;
    await sleep(FOLLOW_GAP_MS);
  }
  return null;
}

/** The logic (no DOM): one state per open card, `phase` idle | sending | started | error. */
export function createApprove({ call = api, onChange = () => {}, sleep = pause } = {}) {
  let st = { itemId: null, phase: "idle", text: "" };
  const set = (next) => {
    st = next;
    onChange();
  };

  const follow = (accepted) => followAccepted(call, sleep, accepted);

  return {
    get state() {
      return st;
    },
    /** A different card was opened (or the card was closed): start fresh. */
    reset(itemId = null) {
      st = { itemId, phase: "idle", text: "" };
    },
    async approve(item, liveRun = false) {
      if (!canApprove(item, liveRun)) return;
      if (st.itemId === item.id && (st.phase === "sending" || st.phase === "started")) return;
      set({ itemId: item.id, phase: "sending", text: SENDING });
      try {
        // No body: the third argument is undefined, so the request carries no JSON at all.
        const accepted = await call("POST", approvePath(item.id), undefined);
        const refusal = await follow(accepted);
        if (st.itemId === item.id) {
          if (refusal !== null) set({ itemId: item.id, phase: "error", text: approveSentenceFor(refusal) });
          else set({ itemId: item.id, phase: "started", text: startedFor(item) });
        }
      } catch (e) {
        if (e && e.name === "AbortError") return;
        if (st.itemId === item.id) set({ itemId: item.id, phase: "error", text: approveSentenceFor(e && e.status === 429 ? "rate_limited" : e && e.code) });
      }
    },
  };
}

/** The button and its sentence for the open card. */
export function approveView(item, approver, liveRun = false) {
  const st = approver.state;
  const mine = st.itemId === item.id ? st : { phase: "idle", text: "" };
  return h(
    "div",
    { class: "pl-approve", "data-testid": "pl-approve" },
    h(
      "button",
      {
        type: "button",
        class: "pl-approve-btn",
        "data-testid": "pl-approve-btn",
        disabled: mine.phase === "sending" || mine.phase === "started",
        onClick: () => approver.approve(item, liveRun),
      },
      labelFor(item)
    ),
    NOTES[item.stage] ? h("p", { class: "pl-muted", "data-testid": "pl-approve-hint" }, NOTES[item.stage]) : null,
    mine.text ? h("p", { class: "pl-muted", role: "status", "data-testid": "pl-approve-note" }, mine.text) : null
  );
}

// --- Stuck items: Build again, Back to discussion, Treat as a feature, Close (folded in for the same boot-budget reason) ---
// D#483: an item the pipeline cannot move by itself gets buttons for the person who can. THE RULES ARE NOT HERE. The server's
// activity read (`GET /api/v1/work-items/{id}/activity`) lists the `actions` the caller may do to this item right now, computed
// by the one table the action routes ask too (@fx/core work-items/operatorActions.ts); this file draws a button for each
// one it lists, in a fixed order, and nothing else. It never looks at the stage, the kind or the role.
//
//   Build again          -> POST /work-items/{id}/approve (the stage driver's rebuild: a fresh build from the same Spec)
//   Back to discussion   -> POST /work-items/{id}/back-to-discussion (a new panel and a new Spec version)
//   Treat as a feature   -> POST /work-items/{id}/treat-as-feature (a project has no panel; this runs one as a feature)
//   Close                -> POST /work-items/{id}/close, after an in-app confirm dialog (never the browser's confirm())
//
// Rules this file keeps (those of the approve button above): no request carries a body; every sentence a person reads is
// chosen here, never taken from a server code or message; one request at a time per card; an accepted request is followed
// for a few moments so a refusal that costs nothing reaches the sentence. An open pull request has no Close: the server says
// so (`close_on_github`), and the card tells the person to close the pull request on GitHub.

export const OPERATOR_LABELS = { build_again: "Build again", back_to_discussion: "Back to discussion", treat_as_feature: "Treat as a feature", close: "Close", reopen: "Reopen" };
/** The order buttons are drawn in. An action the server lists that is not here is not drawn. */
export const OPERATOR_ORDER = ["build_again", "back_to_discussion", "treat_as_feature", "close", "reopen"];
const OPERATOR_TESTIDS = { build_again: "pl-op-build", back_to_discussion: "pl-op-back", treat_as_feature: "pl-op-feature", close: "pl-op-close", reopen: "pl-op-reopen" };

const itemPath = (id) => "/api/v1/work-items/" + encodeURIComponent(id);
export const OPERATOR_PATHS = {
  build_again: approvePath,
  back_to_discussion: (id) => itemPath(id) + "/back-to-discussion",
  treat_as_feature: (id) => itemPath(id) + "/treat-as-feature",
  close: (id) => itemPath(id) + "/close",
  reopen: (id) => itemPath(id) + "/reopen",
};

/** Under the buttons, before the click: what each one does. */
export const OPERATOR_NOTES = {
  build_again: "Build again starts a new build from the same Spec. An agent opens a fresh pull request, and the reviewers run on it.",
  back_to_discussion: "Back to discussion asks the panel again and writes a new Spec. The new Spec replaces the old one.",
  treat_as_feature: "A project has no panel, so it stops here. Treat as a feature changes it to a feature and runs the panel and the Spec as for any feature.",
  close: "Close ends the work item. No agent will work on it any more.",
  reopen: "Reopen puts a closed work item back in Triaged, where it can be approved again.",
};
export const CLOSE_ON_GITHUB_NOTE = "To close this, close its pull request on GitHub. The card then moves to Closed without a merge.";

/** What a person reads once the server accepted the request. */
export const OPERATOR_STARTED = {
  build_again: "Started. An agent is building this again from the same Spec, and the card moves when it opens a pull request.",
  back_to_discussion: "Sent back to the panel. The agents are discussing it again, and a new Spec follows when they are done.",
  treat_as_feature: "Changed to a feature. The agents are discussing it now, and a Spec follows when they are done.",
  close: "Closed.",
  reopen: "Reopened. The card is back in Triaged.",
};

export const CLOSE_DIALOG = { title: "Close this work item?", lines: ["The card moves to Closed and no agent will work on it any more."], confirm: "Yes, close it", dismiss: "Keep it open" };
export const REOPEN_DIALOG = { title: "Reopen this work item?", lines: ["The card moves back to Triaged. Nothing starts until someone approves it."], confirm: "Yes, reopen it", dismiss: "Keep it closed" };
/** The actions that ask first, in the app's own dialog, and answer at once (no agent is involved). */
const CONFIRMED = { close: CLOSE_DIALOG, reopen: REOPEN_DIALOG };

/** The actions to draw: the server's list, filtered to the ones this file knows, in a fixed order. */
export function operatorActions(data) {
  const listed = data && Array.isArray(data.actions) ? data.actions : [];
  return OPERATOR_ORDER.filter((a) => listed.includes(a));
}
/** True when the server says to point the person at the pull request on the code host instead of offering Close. */
export const closeOnHost = (data) => !!data && data.close_on_github === true;

/** The logic (no DOM): one state per open card. `phase`: idle | sending | started | done | error (`done`: the card has moved on since a press, so its buttons may be pressed again). `confirm` is the Close dialog being open. */
export function createOperator({ call = api, onChange = () => {}, onDone = () => {}, sleep = pause } = {}) {
  let st = { itemId: null, phase: "idle", action: null, text: "", confirm: false };
  const set = (next) => {
    st = next;
    onChange();
  };
  const busy = (id) => st.itemId === id && (st.phase === "sending" || st.phase === "started");

  async function send(item, action) {
    const keepDialog = action in CONFIRMED;
    set({ itemId: item.id, phase: "sending", action, text: SENDING, confirm: keepDialog });
    try {
      // No body: the third argument is undefined, so the request carries no JSON at all.
      const accepted = await call("POST", OPERATOR_PATHS[action](item.id), undefined);
      // Close answers at once (no agent is involved); every other action is a run action that is followed.
      const refusal = action in CONFIRMED ? null : await followAccepted(call, sleep, accepted);
      if (st.itemId !== item.id) return;
      if (refusal !== null) return set({ itemId: item.id, phase: "error", action, text: approveSentenceFor(refusal), confirm: keepDialog });
      set({ itemId: item.id, phase: "started", action, text: OPERATOR_STARTED[action], confirm: false });
      onDone(item.id, action);
    } catch (e) {
      if (e && e.name === "AbortError") return;
      if (st.itemId === item.id) set({ itemId: item.id, phase: "error", action, text: approveSentenceFor(e && e.status === 429 ? "rate_limited" : e && e.code), confirm: keepDialog });
    }
  }

  return {
    get state() {
      return st;
    },
    /** A different card was opened (or the card was closed): start fresh. */
    reset(itemId = null) {
      st = { itemId, phase: "idle", action: null, text: "", confirm: false };
      onChange();
    },
    /** The server's view of the card has moved on since the action was taken: the buttons it lists now may be pressed. */
    settle(itemId) {
      if (st.itemId === itemId && st.phase === "started") set({ ...st, phase: "done" });
    },
    /** A button was pressed. Close only opens the dialog; the rest send at once. */
    press(item, action) {
      if (!item || !OPERATOR_ORDER.includes(action) || busy(item.id)) return;
      if (action in CONFIRMED) return set({ itemId: item.id, phase: "idle", action, text: "", confirm: true });
      return send(item, action);
    },
    /** "Yes, close it" / "Yes, reopen it". */
    confirmClose(item) {
      if (!item || st.itemId !== item.id || !st.confirm || st.phase === "sending" || !(st.action in CONFIRMED)) return;
      return send(item, st.action);
    },
    /** "Keep it open", Escape, or a click outside. Refused while the request is out. */
    dismiss() {
      if (st.confirm && st.phase !== "sending") set({ ...st, phase: st.phase === "error" ? "idle" : st.phase, text: st.phase === "error" ? "" : st.text, confirm: false });
    },
  };
}

/**
 * The buttons, their notes, the sentence after a press, and the Close dialog, for the open card. `show(item, data)` redraws
 * from the latest activity read (it keeps focus on the same button, and does nothing when nothing changed).
 */
export function createOperatorPanel({ call, onDone, sleep } = {}) {
  let item = null;
  let data = null;
  let signature = "";
  let dlg = null;
  let parts = null;
  // What the server listed when an action was taken. The buttons stay locked after a press (no second Build again while
  // the first is starting) only until a later activity read lists something else: then the card has moved on (Reopen and
  // Close move it at once; a build's run started or ended) and the new buttons may be pressed without reopening the card.
  let lockedOn = null;
  const viewOf = (d) => JSON.stringify([d && d.stage, operatorActions(d), closeOnHost(d)]);
  const op = createOperator({ call, sleep, onDone, onChange: () => draw() });
  const el = h("div", { class: "pl-operator", "data-testid": "pl-operator", hidden: true });

  function paintDialog() {
    const st = op.state;
    const open = !!item && st.itemId === item.id && st.confirm;
    if (!open) {
      if (!dlg) return;
      const back = el.querySelector('[data-testid="' + OPERATOR_TESTIDS[st.action || "close"] + '"]') || el.querySelector('[data-testid="pl-op-close"], [data-testid="pl-op-reopen"]');
      dlg.close();
      dlg.remove();
      dlg = parts = null;
      if (back) back.focus();
      return;
    }
    if (!dlg) {
      const words = CONFIRMED[st.action] || CLOSE_DIALOG;
      parts = {
        err: h("p", { class: "pl-dialog-error", role: "alert", tabindex: "-1", "data-testid": "pl-op-dialog-error" }),
        confirm: h("button", { type: "button", class: "pl-act", "data-testid": "pl-op-confirm", onClick: () => parts.confirm.getAttribute("aria-disabled") !== "true" && op.confirmClose(item) }, words.confirm),
        dismiss: h("button", { type: "button", class: "pl-act", "data-testid": "pl-op-keep", onClick: () => op.dismiss() }, words.dismiss),
      };
      dlg = h(
        "dialog",
        { class: "pl-dialog", "data-testid": "pl-op-dialog", "aria-labelledby": "pl-op-dlg-h", "aria-describedby": "pl-op-dlg-d", onCancel: (e) => (e.preventDefault(), op.dismiss()), onClick: (e) => e.target === dlg && op.dismiss() },
        h(
          "div",
          { class: "pl-dialog-body" },
          h("h2", { class: "pl-dialog-title", id: "pl-op-dlg-h" }, words.title),
          h("div", { id: "pl-op-dlg-d" }, words.lines.map((t) => h("p", null, t))),
          parts.err,
          h("div", { class: "pl-dialog-actions" }, parts.dismiss, parts.confirm)
        )
      );
      document.body.appendChild(dlg);
      dlg.showModal();
      // The safe choice has the focus: Enter keeps the item open.
      parts.dismiss.focus();
    }
    parts.err.textContent = st.phase === "error" ? st.text : "";
    // aria-disabled, not disabled: a disabled button drops keyboard focus while the request is out.
    parts.confirm.setAttribute("aria-disabled", st.phase === "sending" ? "true" : "false");
    parts.dismiss.setAttribute("aria-disabled", st.phase === "sending" ? "true" : "false");
  }

  function draw() {
    const st = op.state;
    const mine = !!item && st.itemId === item.id ? st : { phase: "idle", action: null, text: "", confirm: false };
    const actions = item ? operatorActions(data) : [];
    const onHost = item ? closeOnHost(data) : false;
    const sig = JSON.stringify([item && item.id, actions, onHost, mine.phase, mine.text, mine.confirm]);
    if (sig !== signature) {
      signature = sig;
      const held = el.contains(document.activeElement) && document.activeElement.dataset ? document.activeElement.dataset.testid : null;
      const note = mine.text !== "" && !mine.confirm;
      const visible = actions.length > 0 || onHost || note;
      el.hidden = !visible;
      const disabled = mine.phase === "sending" || mine.phase === "started";
      el.replaceChildren(
        ...(visible
          ? [
              h("h3", { class: "pl-detail-sub", id: "pl-op-h" }, "Move this item"),
              ...(actions.length
                ? [
                    h(
                      "div",
                      { class: "pl-op-buttons", role: "group", "aria-labelledby": "pl-op-h" },
                      actions.map((a) => h("button", { type: "button", class: "pl-act", "data-testid": OPERATOR_TESTIDS[a], "data-action": a, "aria-disabled": disabled ? "true" : "false", onClick: () => !disabled && op.press(item, a) }, OPERATOR_LABELS[a]))
                    ),
                    h("div", { class: "pl-op-notes", "data-testid": "pl-op-notes" }, actions.map((a) => h("p", { class: "pl-muted" }, OPERATOR_NOTES[a]))),
                  ]
                : []),
              ...(onHost ? [h("p", { class: "pl-muted", "data-testid": "pl-op-host" }, CLOSE_ON_GITHUB_NOTE)] : []),
              ...(note ? [h("p", { class: "pl-muted", role: "status", "data-testid": "pl-op-note", "data-phase": mine.phase }, mine.text)] : []),
            ]
          : [])
      );
      if (held) {
        const again = el.querySelector('[data-testid="' + held + '"]');
        if (again) again.focus();
      }
    }
    paintDialog();
  }

  return {
    el,
    /** Redraws for `openItem` from the latest activity read (`activity` is null until it has answered). */
    show(openItem, activity) {
      const st = op.state;
      const started = !!openItem && st.itemId === openItem.id && st.phase === "started";
      if (!started) lockedOn = null;
      else if (lockedOn === null) lockedOn = viewOf(data); // the view the action was taken on
      item = openItem;
      data = activity;
      if (started && activity && viewOf(activity) !== lockedOn) {
        lockedOn = null;
        op.settle(openItem.id); // redraws
        return;
      }
      draw();
    },
    /** A different card was opened (or the card was closed). */
    reset(id = null) {
      lockedOn = null;
      op.reset(id);
    },
    state: () => op.state,
    destroy() {
      item = null;
      data = null;
      paintDialog();
    },
  };
}
