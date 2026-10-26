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
import { h, timeNode } from "../_lib/dom.js";
import { api, createRetryGate, isRateLimited, retryWords, waitSeconds } from "../_lib/api.js";
import { STAGE_LABELS } from "./pipeline-storage.js";

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
  // Input counts what the model read in all: the fresh tokens plus those read from or written to the prompt cache (a session re-reads its context every turn).
  const cached = (Number.isFinite(u.cache_read_tokens) ? u.cache_read_tokens : 0) + (Number.isFinite(u.cache_write_tokens) ? u.cache_write_tokens : 0);
  const inAll = (Number.isFinite(u.tokens_in) ? u.tokens_in : 0) + cached;
  const toks = tok(inAll) + " in" + (cached > 0 ? " (" + tok(cached) + " cached)" : "") + " / " + tok(u.tokens_out) + " out tokens";
  if (u.credential_mode === "api_key") return "On your own API key \u00b7 " + (price ? price + " at API prices" : "no API price for this model") + " \u00b7 " + toks;
  return "On your Claude plan \u00b7 " + (price ? "API-equivalent " + price : "no API price for this model") + " \u00b7 " + toks;
}

/** The work item's separate total, shown only when its runs on the person's machine have one. */
export const ownPlanText = (usd) => (Number.isFinite(usd) && usd > 0 ? "On your own plan (API-equivalent): " + apiUsd(usd) : null);

/**
 * C42-5/C42-4: the item's own-plan line from its usage state. A finished run with no usage, or tokens with no price, is said in words and is never
 * drawn as $0; a recorded figure reads as before. An older server (no state) is read as before too.
 */
export function ownPlanLine(item) {
  if (!isObj(item)) return null;
  if (item.own_plan_usage_state === "not_recorded") return "On your own plan: usage was not recorded for a finished run. That is not the same as $0.";
  if (item.own_plan_usage_state === "not_priced") {
    const t = isObj(item.own_plan_tokens) ? item.own_plan_tokens : {};
    const cached = (Number.isFinite(t.cache_read) ? t.cache_read : 0) + (Number.isFinite(t.cache_write) ? t.cache_write : 0);
    return "On your own plan: " + tok((Number.isFinite(t.input) ? t.input : 0) + cached) + " in" + (cached > 0 ? " (" + tok(cached) + " cached)" : "") + " / " + tok(t.output) + " out tokens, with no API price for the model. That is not the same as $0.";
  }
  return ownPlanText(item.own_plan_api_equivalent_usd);
}

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
export function createRunsPanel({ itemId, repoId, call, uuid, onChange = () => {}, ownPlan = () => null }) {
  let lastLabel = null;
  let lastLive = false;
  let lastApprovable = 0;
  let dlg = null;
  let parts = null;
  let shownFor = null;
  let lastKey = "";
  // Runs waiting for a person's approval (D#6 R2b-4b): read for the pending runs of this item, drawn in their rows and on the card.
  const approvals = createApprovals({ call, onChange: () => changed(ctl.getState()) });
  const labelOf = () => ctl.label() || approvals.label(ctl.getState().runs);
  function changed(st) {
    paint(st);
    const l = labelOf();
    // The parent redraws when the card's label changes, and when the item gains or loses a live run (the approve button depends on it).
    const live = st.runs.some((r) => LIVE_STATUSES.includes(r.status));
    const approvable = approvals.approvableIds(st.runs).length;
    if (l !== lastLabel || live !== lastLive || approvable !== lastApprovable) {
      lastLabel = l;
      lastLive = live;
      lastApprovable = approvable;
      announce.textContent = l || "";
      onChange();
    }
    // The approvals are read again only when the runs list changed in a way that matters to them.
    const key = st.runs.map((r) => r.id + r.status + (r.approval || "")).join();
    if (key !== lastKey) {
      lastKey = key;
      approvals.sync(st.runs);
    }
  }
  const ctl = createActions({ itemId, repoId, call, uuid, onChange: changed });
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
      h("span", { class: "pl-run-main" }, h("bdi", null, run.role), " · ", STATUS_WORDS[run.status] || "Another status", run.runtime !== "runner" && Number.isFinite(run.usd) ? " · " + money(run.usd) : ""),
      runnerUsageText(run) ? h("span", { class: "pl-run-usage pl-muted", "data-testid": "pl-run-usage" }, runnerUsageText(run)) : null,
      p ? h("span", { class: "pl-run-pending", "data-testid": "pl-run-pending" }, p.kind === "cancel" ? "Cancelling…" : "Retrying…") : null,
      ...approvalParts(run, approvals),
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
    const own = st.list === "ready" ? ownPlanLine(ownPlan()) : null;
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
    label: labelOf,
    liveTimers: ctl.liveTimers,
    /** True when any run read for this item is pending, running or paused: the approve button is not offered then. */
    hasLive: () => ctl.getState().runs.some((r) => LIVE_STATUSES.includes(r.status)),
    /** How many pending runs of this item this person may approve (the card's button is offered while there is one). */
    approvableCount: () => approvals.approvableIds(ctl.getState().runs).length,
    /** The existing waiting sentence of the waiting run ("This run needs your approval. ..."), or null. */
    waitingLine: () => labelOf(),
    /**
     * The card's button: approve every pending run of this item the person may approve, one POST each, by the same route as the row's
     * button. Resolves { ok, text }: the words come from the copy of GET /api/runners, an error is never swallowed.
     */
    async approveAll() {
      const c = approvals.copy;
      const ids = approvals.approvableIds(ctl.getState().runs);
      for (const id of ids) await approvals.approve(id);
      const outs = ids.map((id) => approvals.outcomeOf(id));
      if (ids.length === 0 || outs.includes("refused")) return { ok: false, text: c ? c.approvalRefused : GENERIC };
      if (outs.includes("failed") || outs.includes(null)) return { ok: false, text: GENERIC };
      return { ok: true, text: c ? c.approvalDone : APPROVED_RUNS };
    },
    live(type, dto) {
      if (type === "run.status_changed") ctl.onRunChanged(dto && dto.data);
      else if (type === "refresh") ctl.load();
      approvals.reload(); // a claim, a cancel or a changed setting can start or end a wait
    },
    destroy() {
      document.removeEventListener("visibilitychange", onVis);
      approvals.destroy();
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

// --- Run approval (D#6 R2b-4b) ---
// A run on a teammate's subscription runner can wait for that person's go-ahead. Which runs wait comes from the account's
// approvals read (the server decides, from the repo's runner-run setting and the plan holder's consent); this file only shows it.
//  - The words come from the `copy` of GET /api/runners, never from here, and a name is filled in without being parsed.
//  - The "Approve run" button is offered only where the server says `can_approve`; one click is one POST, however fast.
//  - 403 and 409 mean this person can no longer approve the run: that sentence is shown and the read is repeated.
//  - A run the claim approved by itself says whose Claude plan it uses (`approvalAuto`).
export const RUN_APPROVALS_PATH = "/api/runners/approvals";
export const RUNNERS_PATH = "/api/runners";
export const runApprovePath = (id) => "/api/runners/runs/" + encodeURIComponent(id) + "/approve";
export const APPROVALS_POLL_MS = 30000;
export const APPROVING = "Approving…";
/** The server's own approvalDone sentence, for the moment its copy has not been read: the answer is never wrong. */
const APPROVED_RUNS = "Approved. Waiting for your runner.";
/** The Runs app's label for the control that approves a waiting run. */
const APPROVE_RUN_LABEL = "Approve run";
const APPROVAL_COPY = ["approval", "approvalMine", "approvalButton", "approvalDone", "approvalRefused", "approvalAuto"];
const named = (p) => (p && typeof p.name === "string" && p.name.trim() !== "" ? p.name.trim() : "");
const isUuid = (v) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** The copy strings from GET /api/runners, or null unless every one is present (a half-set would show holes). */
export function readApprovalCopy(body) {
  const c = body && body.copy;
  return c && typeof c === "object" && APPROVAL_COPY.every((k) => typeof c[k] === "string" && c[k] !== "") ? Object.fromEntries(APPROVAL_COPY.map((k) => [k, c[k]])) : null;
}

/** Run id -> { canApprove, names } from GET /api/runners/approvals. An approver with no name is left out, never shown as a blank. */
export function readApprovals(body) {
  const out = new Map();
  for (const e of body && Array.isArray(body.approvals) ? body.approvals : []) {
    if (!e || !isUuid(e.run_id)) continue;
    out.set(e.run_id, { canApprove: e.can_approve === true, names: (Array.isArray(e.approvers) ? e.approvers : []).map(named).filter(Boolean) });
  }
  return out;
}

/** The waiting sentence for one entry: yours, or the people who can approve. Null when there is nobody to name. */
export function waitingText(entry, copy) {
  if (!entry || !copy) return null;
  if (entry.canApprove) return copy.approvalMine;
  return entry.names.length > 0 ? copy.approval.replace("{person}", () => entry.names.join(" or ")) : null;
}

const autoName = (run) => (run && run.approval === "auto" ? named(run.approved_by) : "");

/** "Approved automatically. It runs on {person}'s Claude plan." for a run the claim approved itself; null otherwise. */
export function autoText(run, copy) {
  const who = autoName(run);
  return who && copy ? copy.approvalAuto.replace("{person}", () => who) : null;
}

export function createApprovals({ call = api, onChange = () => {}, setTimer = setInterval, clearTimer = clearInterval } = {}) {
  const ac = new AbortController();
  const busy = new Set();
  const outcome = new Map(); // run id -> "done" | "refused" | "failed"
  let destroyed = false;
  let entries = new Map();
  let copy = null;
  let copyAsked = false;
  let seq = 0;
  let timer = null;
  let wanted = false; // the item has a pending run, so a live event is worth a read
  const set = () => {
    if (!destroyed) onChange();
  };
  function poll() {
    if (entries.size > 0 && !timer) timer = setTimer(load, APPROVALS_POLL_MS);
    else if (entries.size === 0 && timer) {
      clearTimer(timer);
      timer = null;
    }
  }
  async function loadCopy() {
    if (copy || copyAsked || destroyed) return;
    copyAsked = true;
    try {
      copy = readApprovalCopy(await call("GET", RUNNERS_PATH, undefined, ac.signal));
    } catch {
      /* asked again with the next read */
    }
    if (copy === null) copyAsked = false;
  }
  async function load() {
    if (destroyed) return;
    const mine = ++seq;
    try {
      const next = readApprovals(await call("GET", RUN_APPROVALS_PATH, undefined, ac.signal));
      if (destroyed || mine !== seq) return;
      entries = next;
    } catch {
      if (destroyed || mine !== seq) return; // what is shown stays until the next read
    }
    poll();
    if (entries.size > 0) await loadCopy();
    set();
  }
  async function approve(runId) {
    if (destroyed || busy.has(runId)) return;
    busy.add(runId);
    outcome.delete(runId);
    set();
    try {
      await call("POST", runApprovePath(runId), undefined, ac.signal);
      outcome.set(runId, "done");
    } catch (e) {
      if (destroyed || (e && e.name === "AbortError")) return;
      outcome.set(runId, e && (e.status === 403 || e.status === 409) ? "refused" : "failed");
    }
    busy.delete(runId);
    await load();
  }
  const self = {
    get copy() {
      return copy;
    },
    entryFor: (runId) => entries.get(runId) || null,
    isBusy: (runId) => busy.has(runId),
    /** The pending runs of the list this person may approve right now (the server said so in the approvals read). */
    approvableIds: (runs) => runs.filter((r) => r.status === "pending" && !busy.has(r.id) && entries.has(r.id) && entries.get(r.id).canApprove).map((r) => r.id),
    outcomeOf: (runId) => outcome.get(runId) || null,
    approve,
    /** The card's pending text: the newest run of the list that is waiting for a person. */
    label(runs) {
      const run = copy && runs.find((r) => entries.has(r.id));
      return run ? waitingText(entries.get(run.id), copy) : null;
    },
    /** The runs list changed: read the approvals if a run is pending, forget them if none is, and fetch the copy for an automatic approval. */
    sync(runs) {
      wanted = runs.some((r) => r.status === "pending");
      if (wanted) load();
      else {
        seq++;
        entries = new Map();
        poll();
      }
      if (runs.some((r) => autoName(r))) loadCopy().then(set);
    },
    reload() {
      if (wanted) load();
    },
    destroy() {
      destroyed = true;
      ac.abort();
      if (timer) clearTimer(timer);
      timer = null;
    },
  };
  return self;
}

/** The approval parts of one run's row: the waiting or automatic line, what a click did, and the button when this person may approve. */
export function approvalParts(run, approvals) {
  const copy = approvals.copy;
  if (!copy) return [];
  const entry = approvals.entryFor(run.id);
  const out = [];
  const text = entry ? waitingText(entry, copy) : autoText(run, copy);
  if (text) out.push(h("span", { class: "pl-run-approval", "data-testid": "pl-run-approval" }, text));
  const state = approvals.outcomeOf(run.id);
  const busy = approvals.isBusy(run.id);
  const note = busy ? APPROVING : state === "done" && run.status === "pending" && !entry ? copy.approvalDone : state === "refused" ? copy.approvalRefused : state === "failed" ? GENERIC : null;
  if (note) out.push(h("span", { class: "pl-run-approval-note", role: "status", "data-testid": "pl-run-approval-note" }, note));
  if (entry && entry.canApprove) {
    out.push(
      h(
        "button",
        // aria-disabled, not disabled: a disabled button drops keyboard focus while the request is out.
        { type: "button", class: "pl-act", "data-testid": "pl-approve-run", "aria-label": copy.approvalButton + ": " + run.role, "aria-disabled": busy ? "true" : "false", onClick: () => approvals.approve(run.id) },
        busy ? APPROVING : copy.approvalButton
      )
    );
  }
  return out;
}

// --- Proposal inbox (D#483 S3-L2b; folded in here for the boot-file budget) ---
// D#483 S3-L2b: the Pipeline app's Inbox tab. The proposals of one repository, filtered by state, with the buttons of S3 Spec
// section 1 (Approve, Reject, Move back to inbox, Withdraw approval, Open in Pipeline).
//
// Rules this file keeps, each with a test in test/pipeline-inbox.test.mjs or e2e/pipeline-inbox.spec.ts:
//  - What a person reads for each outcome comes from the sentence tables below, never from a server message or code.
//  - Every button shows a sentence while it is sending and after a refusal. A refusal that means the list is out of date
//    (a 409, a 404) re-reads the list, and the sentence stays where the row was.
//  - Approve carries an Idempotency-Key. The key is kept across a try whose outcome is unknown (offline, timeout, 5xx) so
//    that the next click replays the same decision, and dropped as soon as the server has answered.
//  - A 429 disables every decision button and counts down from Retry-After (createRetryGate); nothing the server wrote is shown.
//  - No text node is ever "null" or "undefined": every value goes through str() or a presence check before it is drawn.
//  - Text only, built with h().

/**
 * The filters (D#483 S4-h): the four sections of new proposals, then the decided ones. A section is asked of the server by `section`
 * (it implies product-owned and state=new); the Inbox never works out a section itself. "Your own loop" shows loop-owned proposals of every state.
 */
export const FILTERS = [
  { key: "new", label: "New", query: "state=new&owner=product&section=new", empty: "Nothing is waiting for a decision. New proposals appear here once they've been checked." },
  { key: "being_checked", label: "Being checked", query: "state=new&owner=product&section=being_checked", intro: "We're checking these against your repository. They move to New when the check is done.", empty: "Nothing is being checked right now." },
  { key: "couldnt_confirm", label: "Couldn't confirm", query: "state=new&owner=product&section=couldnt_confirm", intro: "We couldn't confirm these against your repository. Read what didn't match before you approve one.", empty: "Nothing here. Every proposal we checked was confirmed." },
  { key: "not_checked", label: "Not checked", query: "state=new&owner=product&section=not_checked", empty: "Every proposal has been checked or is being checked." },
  { key: "approved", label: "Approved", query: "state=approved", empty: "Nothing has been approved yet." },
  { key: "rejected", label: "Rejected", query: "state=rejected", empty: "Nothing has been rejected." },
  { key: "withdrawn", label: "Closed at source", query: "state=withdrawn", empty: "Nothing has been closed or finished at its source since the last import." },
  { key: "own_loop", label: "Your own loop", query: "owner=internal_loop", empty: "None of this repository's items belong to your own development loop." },
];

// D#483 S4-h: what a person reads about a proposal's check. Fixed, owner-approved text; the number in the spent-tries line comes from the row's own cap.
export const EXTERNAL_SENTENCE = "From someone without write access. Read it before approving.";
export const PARTLY_SENTENCE = "Part of this was confirmed. Read the parts that weren't before you approve it.";
export const NOT_CHECKED_SENTENCE = "Not checked yet: add a model key or connect a runner";
export const BEING_CHECKED_SENTENCE = "You can approve this once it's been checked.";
export const RETRY_SENTENCE = "The check didn't finish. We'll try again at the next check.";
export const NO_EVIDENCE_SENTENCE = "No evidence was found for this proposal.";
export const NO_CLAIMS_SENTENCE = "There was nothing to check in this proposal.";
// The two sentences above are for a check that finished. While there is no finished check, the detail says so instead.
export const DETAIL_PENDING_SENTENCE = "Not checked yet. Claims and evidence show here once the check is done.";
export const DETAIL_FAILED_SENTENCE = "The check didn't finish, so there are no claims or evidence to show.";

// D#483 S4-b2b: why a pending check is waiting, from the detail's `verify_wait`. `queued` (and anything this build does not know) keeps the
// plain pending sentence above.
export const VERIFY_WAIT_SENTENCES = {
  daily_limit: "Waiting: today's limit for checking outside proposals is reached — it is checked tomorrow.",
  daily_spend: "Waiting: this repository's daily checking budget is used — it is checked tomorrow.",
};

/**
 * The line for a proposal whose check has not produced a result (pending, check failed, not checked); "" once a check has finished.
 * `wait` is the detail's `verify_wait`; it only changes the line of a pending check.
 */
export function unfinishedCheckLine(p, wait) {
  if (p.verification === "pending") return typeof wait === "string" && Object.hasOwn(VERIFY_WAIT_SENTENCES, wait) ? VERIFY_WAIT_SENTENCES[wait] : DETAIL_PENDING_SENTENCE;
  if (p.verification === "check_failed") return DETAIL_FAILED_SENTENCE;
  if (p.verification === "not_checked") return NOT_CHECKED_SENTENCE;
  return "";
}
export const CLAIM_VERDICTS = {
  supported: "Confirmed in the repository.",
  unverifiable: "Couldn't be checked against the repository.",
  pending: "Not checked yet.",
};
export const REFUTE_REASONS = {
  cite_not_found: "Not confirmed: the file or lines it points to aren't in the repository at this commit.",
  cite_mismatch: "Not confirmed: the lines it points to don't say this.",
  contradicted: "Not confirmed: the repository says otherwise.",
};

/** The line for a check that gave up; null when the row has no cap to name. */
export const spentSentence = (max) => (typeof max === "number" && Number.isFinite(max) ? "The check didn't finish after " + max + " tries, so this proposal stays unconfirmed." : null);

/** The sentence beside a claim: its verdict, and for a refusal its reason. "" for a verdict this build does not know. */
export function claimVerdict(c) {
  if (c.verdict === "refuted") return typeof c.refute_code === "string" && has(REFUTE_REASONS, c.refute_code) ? REFUTE_REASONS[c.refute_code] : "";
  return typeof c.verdict === "string" && has(CLAIM_VERDICTS, c.verdict) ? CLAIM_VERDICTS[c.verdict] : "";
}

/**
 * The words naming one piece of evidence, from its kind and `ref` (grammar: `<path>:<a>-<b>`, `<path>:<n>`, `#<n>`). A ref that does not parse
 * is shown as stored, as text. `commit` ("at commit ...") is kept apart so it can follow the link.
 */
export function evidenceLabel(e) {
  const ref = typeof e.ref === "string" ? e.ref : "";
  if (e.kind === "interview_answer") return { label: "From your interview answers", commit: "" };
  if (e.kind === "preview") return { label: "Found in the preview", commit: "" };
  if (e.kind === "issue" || e.kind === "discussion") {
    const n = /^#([1-9][0-9]*)$/.exec(ref);
    return { label: n ? (e.kind === "issue" ? "Issue #" : "Discussion #") + n[1] : ref, commit: "" };
  }
  const m = /^(.+):([1-9][0-9]*)(?:-([1-9][0-9]*))?$/.exec(ref);
  if (!m || (e.kind !== "file_lines" && e.kind !== "doc_passage")) return { label: ref, commit: "" };
  const where = m[3] && m[3] !== m[2] ? "lines " + m[2] + " to " + m[3] : "line " + m[2];
  const sha = typeof e.commit_sha === "string" && /^[0-9a-f]{7,}$/.test(e.commit_sha) ? e.commit_sha.slice(0, 7) : "";
  return e.kind === "doc_passage" ? { label: "From " + m[1] + ", " + where, commit: "" } : { label: m[1] + ", " + where, commit: sha ? "at commit " + sha : "" };
}

/** The sentences under a new proposal about where it came from and how its check went, from its own fields. */
export function checkSentences(p) {
  const out = [];
  if (p.provenance === "external") out.push(EXTERNAL_SENTENCE);
  if (p.verification === "partly_verified") out.push(PARTLY_SENTENCE);
  if (p.verification === "check_failed") {
    const s = p.verify_retry === true ? RETRY_SENTENCE : spentSentence(p.verify_attempts_max);
    if (s) out.push(s);
  }
  return out;
}

/** The sentence that explains a disabled Approve, from the section the server put the proposal in. "" when Approve is open. */
export const approveBlock = (p) => (p.inbox_section === "being_checked" ? BEING_CHECKED_SENTENCE : p.inbox_section === "not_checked" ? NOT_CHECKED_SENTENCE : "");

/** Shown instead of "Enter a higher one" when the remaining monthly budget is below the first run's cost. Fixed text. */
export const LOW_BUDGET_SENTENCE = "Your remaining budget this month is lower than the cost of the first run. Raise the monthly budget to approve this.";

/** The sentence a person reads after a refusal or a failed call, by the code the server (or the network) answered with. */
export const REFUSALS = {
  not_new: "This proposal isn't waiting for a decision any more, so nothing was changed. The list has been refreshed.",
  not_rejected: "This proposal isn't rejected any more, so nothing was changed. The list has been refreshed.",
  not_approved: "This proposal isn't approved any more, so nothing was changed. The list has been refreshed.",
  work_started: "Work has already started on this item, so the approval can't be withdrawn. Cancel the run from its card on the board instead.",
  owned_by_internal_loop: "Your own development loop handles this. fulcrumaxe only shows it, so nothing was changed.",
  repo_not_connected: "This repository isn't connected any more, so nothing was changed. Install the GitHub App on it again to approve its proposals.",
  work_item_wrong_repo: "The work item for this proposal belongs to another repository, so nothing was changed.",
  work_item_wrong_stage: "The work item for this proposal has already moved past Triaged, so nothing was changed.",
  amount_required: "Set a limit for this item: we can't estimate it yet",
  envelope_below_first_run: "That limit is too low to start this item. Enter a higher one.",
  over_account_budget: "That limit is more than this account can still spend this month.",
  insufficient_role: "Only an owner or an admin can decide proposals.",
  session_required: "Sign in again to do this.",
  run_actions_unavailable: "Starting work isn't available right now, so nothing was changed. Try again later.",
  not_found: "This proposal isn't there any more, so nothing was changed. The list has been refreshed.",
  idempotency_key_reused: "That request was already used. Reload the list and try again.",
  idempotency_in_progress: "The last try is still being handled. Wait a moment, then try again.",
  offline: "Couldn't reach the server, so nothing was changed. Check your connection and try again.",
  timeout: "The server took too long to answer. Check the list before you try again.",
  server_error: "Something went wrong on our side. Check the list before you try again.",
};
const INBOX_GENERIC = "That didn't work. Nothing was changed.";
/** Marks a row's sentence as "rate limited": it is drawn from the live countdown, not from a stored string. */
const RATE = Symbol("rate");
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** The sentence for a failed call: a 429 counts down, a known code has its own sentence, anything else is generic. */
export function refusalSentence(e, est) {
  if (isRateLimited(e)) return "You're changing things too fast. " + retryWords(waitSeconds(e));
  const code = e && typeof e.code === "string" ? e.code : "";
  // A higher limit cannot help when what the account has left is itself below the first run's cost.
  if (code === "envelope_below_first_run" && est && isNum(est.remaining) && isNum(est.firstRun) && est.remaining < est.firstRun) return LOW_BUDGET_SENTENCE;
  if (has(REFUSALS, code)) return REFUSALS[code];
  if (e && e.kind === "server_error") return REFUSALS.server_error;
  return INBOX_GENERIC;
}

// D#483 S5-e1: the limit a person gives an item as they approve it.
export const AMOUNT_LABEL = "Limit for this item (USD)";
/** The Spec's sentence for a proposal with no estimate; shown beside the field and again if the server answers `amount_required`. */
export const AMOUNT_SENTENCE = REFUSALS.amount_required;
const AMOUNT_RE = /^\d+(\.\d{1,4})?$/;
const round4 = (n) => Math.round(n * 1e4) / 1e4;
const dollars = (n) => "$" + n.toFixed(2);

/** The pre-fill the server computes (total x (1 + margin), capped at the remaining budget), from the figures the estimate route returns. */
export function prefillAmount(total, marginPct, remaining) {
  const want = round4(total * (1 + (isNum(marginPct) ? marginPct : 0) / 100));
  const cap = Math.floor(Math.max(0, remaining) * 1e4 + 1e-9) / 1e4;
  return want > cap ? cap : want;
}

/**
 * What the field holds, checked before anything is sent. `est` is that proposal's estimate (or undefined when it could not be read).
 * { ok: true, amount } where amount is a number, or null to send no amount (the server pre-fills); else { ok: false, sentence }.
 */
export function checkAmount(text, est) {
  const t = typeof text === "string" ? text.trim() : "";
  if (t === "") return est && est.basis === "none" ? { ok: false, sentence: AMOUNT_SENTENCE } : { ok: true, amount: null };
  if (!AMOUNT_RE.test(t)) return { ok: false, sentence: "Enter a limit in dollars, like 12.50." };
  const n = Number(t);
  if (!(n > 0)) return { ok: false, sentence: "Enter a limit above $0." };
  if (est && isNum(est.remaining) && n > est.remaining) return { ok: false, sentence: "Enter a limit of " + dollars(Math.floor(est.remaining * 100) / 100) + " or less: that is what this account can still spend this month." };
  return { ok: true, amount: n };
}

/** True when the failure leaves the outcome unknown (the call may have been processed), so a retry must replay its key. */
export const outcomeUnknown = (e) => !!e && (e.status === 0 || e.status >= 500);

/** What approve answered, as one sentence: `started`, and why not when it did not. */
export const NOT_STARTED = {
  no_write_install: "Approved. It waits at Triaged because the repository has no write-access GitHub App installed, so nothing was started.",
  not_issue_backed: "Approved onto the roadmap. Work on it starts once the pipeline can take a Discussion or a task as its input, so nothing was started yet.",
  owned_by_internal_loop: "Approved, but your own development loop owns this item, so fulcrumaxe doesn't start it.",
};
export function approvedSentence(res) {
  if (res && res.started === true) return "Approved and started. The agents are reading it now, and its card moves on the board when they are done.";
  const reason = res && typeof res.not_started_reason === "string" ? res.not_started_reason : "";
  return has(NOT_STARTED, reason) ? NOT_STARTED[reason] : "Approved. It waits at Triaged, so nothing was started.";
}

export const INBOX_SENDING = {
  approve: "Approving…",
  reject: "Rejecting…",
  restore: "Moving it back to the inbox…",
  "withdraw-approval": "Withdrawing the approval…",
};
export const INBOX_DONE = {
  reject: "Rejected. It is under Rejected, where you can move it back to the inbox.",
  restore: "Moved back to the inbox.",
  "withdraw-approval": "Approval withdrawn. Its work item was closed and the proposal is back in New.",
};
export const DETACHED_SENTENCE = "This repository isn't connected any more, so it can't be approved. Its proposals stay readable.";
export const LOOP_SENTENCE = "Your own development loop handles this. fulcrumaxe only shows it.";
export const SOURCE_GONE_SENTENCE = "Closed or finished at its source, so it left the inbox. If it reopens, the next import brings it back.";

/** Replaces the children of `el`, leaving out the absent ones: replaceChildren(null) would draw the word "null". */
// dom-insert-ok: the filter drops every absent child before the insert
const fill = (el, ...kids) => el.replaceChildren(...kids.filter((k) => k != null && k !== false));
const str = (v) => (typeof v === "string" ? v : "");
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** A row is drawn only when it has what the row needs; a malformed one is left out rather than drawn with holes. */
export function validProposal(p) {
  return !!p && typeof p === "object" && typeof p.id === "string" && p.id !== "" && typeof p.title === "string" && p.title !== "" &&
    ["new", "approved", "rejected", "withdrawn"].includes(p.state) && Array.isArray(p.sources);
}

/** "Issue #12", "Discussion #483", "Task D#2 · H14a", "Preview", in that order, for the sources a proposal has. */
export function badgesFor(p) {
  const out = [];
  if (isNum(p.gh_number) && p.sources.includes("github_issue")) out.push("Issue #" + p.gh_number);
  if (isNum(p.discussion_number)) out.push("Discussion #" + p.discussion_number);
  if (str(p.task_key)) out.push("Task " + p.task_key.replace(":", " · "));
  if (p.sources.includes("preview")) out.push("Preview");
  return out;
}

/** Category hint, estimate and milestone title, only the ones present. */
export function detailsFor(p) {
  const out = [];
  if (str(p.category_hint)) out.push(p.category_hint);
  if (isNum(p.estimate_usd)) out.push("Estimate $" + p.estimate_usd.toFixed(2));
  const milestone = str(p.milestone_title) || str(p.milestone_key);
  if (milestone) out.push(milestone);
  return out;
}

/** The live stage of an approved row's work item, by its label (never the raw stage key). */
export const stageWords = (stage) => (typeof stage === "string" && has(STAGE_LABELS, stage) ? STAGE_LABELS[stage] : "");

/**
 * Says `text` in a polite live region. A screen reader announces a change, so the region is emptied first and the text set
 * on the next frame: the same sentence twice (a second identical refusal) is then announced twice.
 */
export function sayLive(el, text) {
  el.textContent = "";
  if (el._sayFrame != null) (typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : clearTimeout)(el._sayFrame);
  el._sayFrame = null;
  if (!text) return;
  const set = () => {
    el._sayFrame = null;
    el.textContent = text;
  };
  el._sayFrame = typeof requestAnimationFrame === "function" ? requestAnimationFrame(set) : setTimeout(set, 0);
}

const newKey = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : null);

/**
 * `getRepo()` answers { id, name, connected } for the picked repository (name is owner/name), or null when none is picked.
 * `onOpenWorkItem(id)` is the app's way to show a work item on the board.
 */
/** The Inbox names an auto-started item for a week. Older ones are on the board, and their card says how they started. */
const AUTO_NOTICE_MS = 7 * 24 * 60 * 60 * 1000;
/** Within the last week by the page's own clock; a time in the future, or one that does not parse, is not recent. */
const isRecent = (iso) => {
  const age = Date.now() - Date.parse(iso);
  return age >= 0 && age <= AUTO_NOTICE_MS;
};

export function createInbox({ call = api, getRepo, onOpenWorkItem = () => {} }) {
  const view = h("div", { class: "pl-inbox-view" });
  const live = h("p", { class: "pl-sr", role: "status", "aria-live": "polite", "data-testid": "pl-inbox-live" });
  const root = h("section", { class: "pl-inbox", "aria-labelledby": "pl-inbox-h", "data-testid": "pl-inbox" }, view, live);
  let filter = "new";
  let rows = [];
  let cursor = null;
  let status = "idle"; // idle | loading | ready | error
  let moreBusy = false;
  let moreFailed = false;
  let note = ""; // a sentence for the whole list: the outcome of the last decision
  let limited = 0; // seconds left of a 429
  const rowNote = new Map(); // proposal id -> the sentence under its buttons
  const notes = new Map(); // proposal id -> the reject note being typed
  const keys = new Map(); // proposal id -> the Idempotency-Key of an approve whose outcome is unknown
  const amounts = new Map(); // proposal id -> the limit being typed (a string)
  const estimates = new Map(); // proposal id -> { basis, remaining, ... } from the estimate route; absent when it could not be read
  const opened = new Set(); // proposal ids whose evidence and claims are showing
  const detailsById = new Map(); // proposal id -> { status: loading | ready | error, claims, evidence, stamp }; read once per opening, never by the list
  const sending = new Set();
  let ac = null;
  let seq = 0;
  let destroyed = false;
  let loadedFor = null; // the repo id the rows belong to
  let autoStarted = []; // D#483 S5-b1a-2: items the repo's dial started on its own and announced, newest first: [{ id, title, workItemId }]
  let autostartOff = null; // D#483 S5-b1a-2: the server's own sentence while the weekly auto-start limit is off; null when it is on or could not be read

  const gate = createRetryGate({
    onChange: (remaining) => {
      limited = remaining;
      if (remaining === 0) {
        for (const [id, s] of rowNote) if (s === RATE) rowNote.delete(id);
      }
      if (!destroyed) paint();
    },
  });

  const query = () => FILTERS.find((f) => f.key === filter).query;

  function announce(text) {
    sayLive(live, text);
  }

  async function load({ keepNotes = false } = {}) {
    const repo = getRepo();
    const mine = ++seq;
    if (ac) ac.abort();
    ac = null;
    // A "Show more" that was in flight belongs to the list being replaced: its answer is dropped, so it cannot clear these.
    moreBusy = false;
    moreFailed = false;
    if (!repo) {
      rows = [];
      cursor = null;
      status = "ready";
      loadedFor = null;
      paint();
      return;
    }
    if (loadedFor !== repo.id) {
      rows = [];
      cursor = null;
      loadedFor = repo.id;
      note = "";
      rowNote.clear();
      notes.clear();
      keys.clear();
      amounts.clear();
      estimates.clear();
      opened.clear();
      detailsById.clear();
    }
    if (!keepNotes) note = "";
    ac = new AbortController();
    status = "loading";
    moreFailed = false;
    paint();
    try {
      const body = await call("GET", "/api/v1/proposals?repo_id=" + encodeURIComponent(repo.id) + "&" + query(), undefined, ac.signal);
      if (mine !== seq || destroyed) return;
      rows = body && Array.isArray(body.proposals) ? body.proposals.filter(validProposal) : [];
      cursor = body && typeof body.next_cursor === "string" && body.next_cursor !== "" ? body.next_cursor : null;
      status = "ready";
    } catch (e) {
      if ((e && e.name === "AbortError") || mine !== seq || destroyed) return;
      status = "error";
    }
    paint();
    if (status === "ready") {
      void loadEstimates(repo, mine);
      void loadAutostart(mine);
      void loadAutoStarted(repo, mine);
      // An opened proposal whose check changed since its detail was read is read again; one that left the list is closed.
      for (const id of [...opened]) {
        const p = rows.find((r) => r.id === id);
        if (!p) {
          opened.delete(id);
          detailsById.delete(id);
        } else if (!detailsById.has(id) || (detailsById.get(id).status === "ready" && detailsById.get(id).stamp !== stampOf(p))) void fetchDetail(p);
      }
    }
  }

  const stampOf = (p) => str(p.verified_at) + "|" + str(p.verification);

  /** The claims and evidence of one proposal: the detail route, once per opening. A bad row in the answer is left out, not drawn with holes. */
  async function fetchDetail(p) {
    const stamp = stampOf(p);
    detailsById.set(p.id, { status: "loading", claims: [], evidence: [], stamp });
    paint();
    try {
      const res = await call("GET", "/api/v1/proposals/" + encodeURIComponent(p.id));
      if (destroyed || !opened.has(p.id)) return;
      const got = res && res.proposal && typeof res.proposal === "object" ? res.proposal : null;
      if (!got || !Array.isArray(got.claims) || !Array.isArray(got.evidence)) throw new Error("shape");
      detailsById.set(p.id, {
        status: "ready",
        claims: got.claims.filter((c) => c && typeof c.id === "string" && typeof c.text === "string"),
        evidence: got.evidence.filter((e) => e && typeof e.id === "string" && typeof e.kind === "string"),
        wait: typeof got.verify_wait === "string" ? got.verify_wait : null,
        stamp,
      });
    } catch {
      if (destroyed || !opened.has(p.id)) return;
      detailsById.set(p.id, { status: "error", claims: [], evidence: [], stamp });
    }
    paint();
  }

  function toggle(p) {
    if (opened.has(p.id)) {
      opened.delete(p.id);
      detailsById.delete(p.id);
      paint();
    } else {
      opened.add(p.id);
      void fetchDetail(p);
    }
  }

  /** The weekly auto-start limit, read once per load. While it is off nothing starts on its own, and the Inbox says how to turn it on in the server's own sentence. A failed read shows nothing. */
  async function loadAutostart(mine) {
    try {
      const res = await call("GET", "/api/v1/account/autostart-envelope");
      if (mine !== seq || destroyed) return;
      autostartOff = res && res.enabled === false && typeof res.off_sentence === "string" && res.off_sentence.trim() !== "" ? res.off_sentence.trim() : null;
      paint();
    } catch {
      if (mine !== seq || destroyed) return;
      autostartOff = null;
    }
  }

  /** The approved proposals the dial started on its own and announced (the server marks them `auto_started`), from the first page of the approved list. A failed read shows no notice. */
  async function loadAutoStarted(repo, mine) {
    try {
      const body = await call("GET", "/api/v1/proposals?repo_id=" + encodeURIComponent(repo.id) + "&state=approved&owner=product");
      if (mine !== seq || destroyed) return;
      const list = body && Array.isArray(body.proposals) ? body.proposals : [];
      autoStarted = list
        .filter((p) => validProposal(p) && p.auto_started === true && typeof p.work_item_id === "string" && p.work_item_id !== "" && isRecent(str(p.decided_at)))
        .map((p) => ({ id: p.id, title: p.title, workItemId: p.work_item_id, at: str(p.decided_at) }))
        .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
        .slice(0, 3);
      paint();
    } catch {
      if (mine !== seq || destroyed) return;
      autoStarted = [];
    }
  }

  /** One plain line per auto-started item, with the way to its card. Items that were started by a person, or by the dial on its "act" setting, have none. */
  function autoStartedNotices() {
    if (!autoStarted.length) return null;
    return h(
      "div",
      { class: "pl-inbox-autostarted", role: "status", "data-testid": "pl-inbox-autostarted" },
      autoStarted.map((n) =>
        h("p", { class: "pl-inbox-sentence", "data-testid": "pl-inbox-autostarted-line" }, "Started on its own under your setting: " + n.title + ". ",
          h("button", { type: "button", class: "pl-btn", "data-testid": "pl-inbox-autostarted-open", "data-focus": n.id + ":autostarted", onClick: () => onOpenWorkItem(n.workItemId) }, "Open its card"))
      )
    );
  }

  /** The estimate of every new, product-owned row not yet read, in sets of 50 (the route's limit). A failure leaves the field blank and optional. */
  async function loadEstimates(repo, mine) {
    const wanted = rows.filter((r) => r.state === "new" && r.owner_process !== "internal_loop" && !estimates.has(r.id)).map((r) => r.id);
    for (let i = 0; i < wanted.length; i += 50) {
      const ids = wanted.slice(i, i + 50);
      try {
        const res = await call("GET", "/api/v1/repos/" + encodeURIComponent(repo.id) + "/proposals/estimate?ids=" + ids.map(encodeURIComponent).join(","));
        if (mine !== seq || destroyed) return;
        const list = res && Array.isArray(res.proposals) ? res.proposals : [];
        for (const e of list) {
          if (!e || typeof e.proposal_id !== "string" || !ids.includes(e.proposal_id)) continue;
          const est = { basis: e.basis, remaining: isNum(res.remaining_budget_usd) ? res.remaining_budget_usd : undefined, firstRun: isNum(res.first_run_usd) ? res.first_run_usd : undefined };
          estimates.set(e.proposal_id, est);
          if (e.basis !== "none" && isNum(e.total_usd) && isNum(res.remaining_budget_usd) && !amounts.has(e.proposal_id)) {
            amounts.set(e.proposal_id, String(prefillAmount(e.total_usd, isNum(res.margin_pct) ? res.margin_pct : null, res.remaining_budget_usd)));
          }
        }
        paint();
      } catch {
        if (mine !== seq || destroyed) return;
      }
    }
  }

  async function loadMore() {
    const repo = getRepo();
    if (!repo || !cursor || moreBusy) return;
    moreBusy = true;
    moreFailed = false;
    paint();
    const mine = seq;
    try {
      const body = await call("GET", "/api/v1/proposals?repo_id=" + encodeURIComponent(repo.id) + "&" + query() + "&cursor=" + encodeURIComponent(cursor), undefined, ac ? ac.signal : undefined);
      if (mine !== seq || destroyed) return;
      const seen = new Set(rows.map((r) => r.id));
      for (const p of body && Array.isArray(body.proposals) ? body.proposals : []) if (validProposal(p) && !seen.has(p.id)) rows.push(p);
      cursor = body && typeof body.next_cursor === "string" && body.next_cursor !== "" ? body.next_cursor : null;
    } catch (e) {
      if ((e && e.name === "AbortError") || mine !== seq || destroyed) return;
      moreFailed = true;
    }
    moreBusy = false;
    paint();
    // The rows added by this page get their estimate (and pre-fill) like the first page's.
    if (!moreFailed) void loadEstimates(repo, mine);
  }

  async function act(p, path) {
    if (sending.has(p.id) || limited > 0) return;
    let amount = null;
    if (path === "approve") {
      // Checked before anything is sent: a bad limit never costs a request, and says what to fix.
      const checked = checkAmount(amounts.get(p.id) || "", estimates.get(p.id));
      if (!checked.ok) {
        rowNote.set(p.id, checked.sentence);
        announce(checked.sentence);
        paint();
        return;
      }
      amount = checked.amount;
    }
    sending.add(p.id);
    rowNote.set(p.id, INBOX_SENDING[path]);
    announce(INBOX_SENDING[path]);
    paint();
    const opts = {};
    if (path === "approve") {
      const k = keys.get(p.id) || newKey();
      if (k) {
        keys.set(p.id, k);
        opts.idempotencyKey = k;
      }
    }
    let body;
    if (path === "approve" && amount !== null) body = { amount_usd: amount };
    if (path === "reject") {
      const text = (notes.get(p.id) || "").trim();
      body = { note: text === "" ? null : text };
    }
    try {
      const res = await call("POST", "/api/v1/proposals/" + encodeURIComponent(p.id) + "/" + path, body, undefined, path === "approve" ? opts : undefined);
      keys.delete(p.id);
      notes.delete(p.id);
      amounts.delete(p.id);
      estimates.delete(p.id);
      rowNote.delete(p.id);
      note = path === "approve" ? approvedSentence(res) : INBOX_DONE[path];
      announce(note);
      sending.delete(p.id);
      await load({ keepNotes: true });
    } catch (e) {
      if (e && e.name === "AbortError") {
        sending.delete(p.id);
        rowNote.delete(p.id);
        paint();
        return;
      }
      if (!outcomeUnknown(e)) keys.delete(p.id);
      const sentence = refusalSentence(e, estimates.get(p.id));
      sending.delete(p.id);
      rowNote.set(p.id, isRateLimited(e) ? RATE : sentence);
      if (isRateLimited(e)) gate.start(waitSeconds(e));
      announce(sentence);
      if (e && (e.status === 409 || e.status === 404)) {
        await load({ keepNotes: true });
        // The row may be gone after the re-read (it moved to another filter): the sentence then speaks for the list.
        if (!rows.some((r) => r.id === p.id) && rowNote.get(p.id) === sentence) {
          rowNote.delete(p.id);
          note = sentence;
        }
      }
    }
    sending.delete(p.id);
    paint();
  }

  function button(label, p, path, extra) {
    const repo = getRepo();
    const unchecked = path === "approve" && approveBlock(p) !== "";
    const blocked = sending.has(p.id) || limited > 0 || unchecked || (path === "approve" && !!repo && !repo.connected);
    // aria-disabled, not disabled: a disabled button drops keyboard focus while the request is out. Clicks are ignored instead.
    const describe = path === "approve" || path === "reject" ? { "aria-describedby": "pl-inbox-title-" + p.id + (unchecked ? " pl-inbox-why-" + p.id : "") } : {};
    return h("button", { type: "button", class: "pl-btn", "data-testid": "pl-inbox-" + path, "data-focus": p.id + ":" + path, "aria-disabled": blocked ? "true" : "false", ...describe, onClick: () => !blocked && act(p, path), ...extra }, label);
  }

  function actions(p) {
    const repo = getRepo();
    if (p.owner_process === "internal_loop") return [h("p", { class: "pl-inbox-line", "data-testid": "pl-inbox-loop" }, LOOP_SENTENCE)];
    if (p.state === "new") {
      const id = "pl-note-" + p.id;
      const input = h("input", {
        type: "text",
        id,
        class: "pl-inbox-note",
        maxLength: 500,
        autocomplete: "off",
        placeholder: "Reason (optional)",
        value: notes.get(p.id) || "",
        "data-focus": p.id + ":note",
        "data-testid": "pl-inbox-note",
        onInput: (e) => notes.set(p.id, e.target.value),
      });
      const aid = "pl-amount-" + p.id;
      const est = estimates.get(p.id);
      const amountInput = h("input", {
        type: "text",
        id: aid,
        class: "pl-inbox-amount",
        inputMode: "decimal",
        autocomplete: "off",
        value: amounts.get(p.id) || "",
        "aria-describedby": est && est.basis === "none" ? aid + "-line" : null,
        "data-focus": p.id + ":amount",
        "data-testid": "pl-inbox-amount",
        onInput: (e) => {
          // A different limit is a different request: an Idempotency-Key kept for an unknown outcome would be refused as reused.
          if (e.target.value !== (amounts.get(p.id) || "")) keys.delete(p.id);
          amounts.set(p.id, e.target.value);
        },
      });
      return [
        est && est.basis === "none" ? h("p", { class: "pl-inbox-line", id: aid + "-line", "data-testid": "pl-inbox-amount-line" }, AMOUNT_SENTENCE) : null,
        h("label", { class: "pl-inbox-amountlabel", for: aid }, AMOUNT_LABEL, amountInput),
        button("Approve", p, "approve"),
        approveBlock(p) ? h("p", { class: "pl-inbox-line", id: "pl-inbox-why-" + p.id, "data-testid": "pl-inbox-approve-why" }, approveBlock(p)) : null,
        repo && !repo.connected ? h("p", { class: "pl-inbox-line", "data-testid": "pl-inbox-detached" }, DETACHED_SENTENCE) : null,
        h("label", { class: "pl-inbox-notelabel", for: id }, h("span", { class: "pl-sr" }, "Reason for rejecting " + p.title + " (optional)"), input),
        button("Reject", p, "reject"),
      ];
    }
    if (p.state === "rejected") return [button("Move back to inbox", p, "restore")];
    if (p.state === "approved") {
      return [
        p.work_item_stage === "triaged" ? button("Withdraw approval", p, "withdraw-approval") : null,
        typeof p.work_item_id === "string" && p.work_item_id !== ""
          ? h("button", { type: "button", class: "pl-btn", "data-testid": "pl-inbox-open", "data-focus": p.id + ":open", onClick: () => onOpenWorkItem(p.work_item_id) }, "Open in Pipeline")
          : null,
      ];
    }
    return [h("p", { class: "pl-inbox-line", "data-testid": "pl-inbox-gone" }, SOURCE_GONE_SENTENCE)];
  }

  function stamps(p) {
    const out = [];
    if (p.state === "approved") {
      const stage = stageWords(p.work_item_stage);
      out.push(h("p", { class: "pl-inbox-line", "data-testid": "pl-inbox-approved" }, (isNum(p.roadmap_position) ? "On the roadmap at position " + p.roadmap_position : "On the roadmap") + (stage ? ". Stage: " + stage : "") + "."));
    }
    if (p.state === "rejected") {
      out.push(h("p", { class: "pl-inbox-line", "data-testid": "pl-inbox-rejected" }, "Rejected", str(p.decided_at) ? [" ", timeNode(p.decided_at, true)] : null, str(p.reject_note) ? ". Note: " + p.reject_note : "."));
    } else if (p.state === "approved" && str(p.decided_at)) {
      out.push(h("p", { class: "pl-inbox-line" }, "Approved ", timeNode(p.decided_at, true), "."));
    }
    return out;
  }

  /** The claims (each with its verdict in words) and the evidence of an opened proposal. Text only: an excerpt or a claim is never read as markup. */
  function detailEl(p) {
    const d = detailsById.get(p.id);
    const id = "pl-inbox-detail-" + p.id;
    const wrap = (...kids) => h("div", { class: "pl-inbox-detail", id, "data-testid": "pl-inbox-detail" }, ...kids);
    if (!d || d.status === "loading") return wrap(h("p", { class: "pl-inbox-line", role: "status", "data-testid": "pl-inbox-detail-loading" }, "Loading…"));
    if (d.status === "error")
      return wrap(h("p", { role: "alert", "data-testid": "pl-inbox-detail-error" }, "The proposals couldn't be loaded."), h("button", { type: "button", class: "pl-btn", "data-focus": p.id + ":retry", onClick: () => void fetchDetail(p) }, "Try again"));
    const unfinished = unfinishedCheckLine(p, d.wait);
    // Nothing to list and no finished check: one line about the check, not "nothing to check" / "no evidence". Rows that do exist are still shown.
    if (unfinished && !d.claims.length && !d.evidence.length) return wrap(h("p", { class: "pl-inbox-line", "data-testid": "pl-check-status", "data-verification": str(p.verification) }, unfinished));
    const claims = d.claims.length
      ? h("ul", { class: "pl-claims", "data-testid": "pl-claims" }, d.claims.map((c) => h("li", { class: "pl-claim", "data-testid": "pl-claim", "data-verdict": str(c.verdict) }, h("span", { class: "pl-claim-text" }, c.text), claimVerdict(c) ? h("span", { class: "pl-claim-verdict", "data-testid": "pl-claim-verdict" }, claimVerdict(c)) : null)))
      : unfinished ? null : h("p", { class: "pl-inbox-line", "data-testid": "pl-no-claims" }, NO_CLAIMS_SENTENCE);
    const evidence = d.evidence.length
      ? h("ul", { class: "pl-evidence", "data-testid": "pl-evidence" }, d.evidence.map((e) => {
          const w = evidenceLabel(e);
          // The link is the server's own (built from the repository and the commit); anything but a GitHub https address is shown as plain text.
          const link = typeof e.url === "string" && e.url.startsWith("https://github.com/");
          return h("li", { class: "pl-evi", "data-testid": "pl-evi", "data-kind": e.kind },
            link ? h("a", { href: e.url, target: "_blank", rel: "noopener noreferrer", "data-testid": "pl-evi-link" }, w.label) : h("span", { "data-testid": "pl-evi-label" }, w.label),
            w.commit ? [" ", h("span", { "data-testid": "pl-evi-commit" }, w.commit)] : null,
            str(e.excerpt) ? h("p", { class: "pl-ins-text pl-evi-excerpt", "data-testid": "pl-evi-excerpt" }, e.excerpt) : null);
        }))
      : unfinished ? null : h("p", { class: "pl-inbox-line", "data-testid": "pl-no-evidence" }, NO_EVIDENCE_SENTENCE);
    return wrap(claims, evidence);
  }

  function rowEl(p) {
    const details = detailsFor(p);
    const badges = badgesFor(p);
    const open = opened.has(p.id);
    const checks = p.owner_process === "internal_loop" ? [] : checkSentences(p).filter((s) => p.state === "new" || s === EXTERNAL_SENTENCE);
    return h(
      "li",
      { class: "pl-inbox-row", "data-testid": "pl-inbox-row", "data-id": p.id, "data-state": p.state },
      h(
        "h3",
        { class: "pl-inbox-title", id: "pl-inbox-title-" + p.id },
        // The title opens the evidence and claims, so the control needs no wording of its own.
        h("button", { type: "button", class: "pl-inbox-open", "aria-expanded": String(open), "aria-controls": open ? "pl-inbox-detail-" + p.id : null, "data-focus": p.id + ":toggle", "data-testid": "pl-inbox-toggle", onClick: () => toggle(p) }, p.title)
      ),
      badges.length ? h("p", { class: "pl-inbox-badges", "data-testid": "pl-inbox-badges" }, badges.join(" · ")) : null,
      details.length ? h("p", { class: "pl-inbox-details", "data-testid": "pl-inbox-details" }, details.join(" · ")) : null,
      checks.map((s) => h("p", { class: "pl-inbox-line", "data-testid": "pl-inbox-check" }, s)),
      open ? detailEl(p) : null,
      stamps(p),
      h("div", { class: "pl-inbox-actions" }, actions(p)),
      rowNote.has(p.id) ? h("p", { class: "pl-inbox-sentence", "data-testid": "pl-inbox-sentence" }, rowNote.get(p.id) === RATE ? "You're changing things too fast. " + retryWords(limited) : rowNote.get(p.id)) : null
    );
  }

  function body() {
    const repo = getRepo();
    if (!repo) return h("p", { class: "pl-inbox-line", "data-testid": "pl-inbox-empty" }, "Pick a repository to see its proposals.");
    if (status === "error")
      return h("div", { "data-testid": "pl-inbox-error" }, h("p", { role: "alert" }, "The proposals couldn't be loaded."), h("button", { type: "button", class: "pl-btn", "data-focus": "retry", onClick: () => load() }, "Try again"));
    if (status === "loading" && rows.length === 0) return h("p", { class: "pl-inbox-line", "data-testid": "pl-inbox-loading" }, "Loading proposals…");
    const intro = FILTERS.find((f) => f.key === filter).intro;
    const introEl = intro ? h("p", { class: "pl-inbox-line", "data-testid": "pl-inbox-intro" }, intro) : null;
    if (rows.length === 0) return h("div", {}, introEl, h("p", { class: "pl-inbox-line", "data-testid": "pl-inbox-empty" }, FILTERS.find((f) => f.key === filter).empty));
    return h(
      "div",
      {},
      introEl,
      h("ul", { class: "pl-inbox-list", "aria-label": FILTERS.find((f) => f.key === filter).label }, rows.map(rowEl)),
      cursor
        ? h(
            "div",
            { class: "pl-inbox-more" },
            h("button", { type: "button", class: "pl-btn", "data-focus": "more", "data-testid": "pl-inbox-more", "aria-disabled": moreBusy ? "true" : "false", onClick: () => !moreBusy && loadMore() }, moreBusy ? "Loading…" : "Show more"),
            moreFailed ? h("p", { class: "pl-inbox-sentence", "data-testid": "pl-inbox-more-failed" }, "The next proposals couldn't be loaded. Try again.") : null
          )
        : null
    );
  }

  function paint() {
    if (destroyed) return;
    // Repainting replaces every node, so the focused control is found again by its key afterwards.
    const active = view.contains(document.activeElement) ? document.activeElement : null;
    const key = active && active.getAttribute ? active.getAttribute("data-focus") : null;
    const range = key && active && typeof active.selectionStart === "number" ? [active.selectionStart, active.selectionEnd] : null;
    // The rows before this paint, in order, and the row the focus was in: if that row is gone afterwards, the focus moves on.
    const before = [...view.querySelectorAll("[data-testid='pl-inbox-row']")].map((n) => n.getAttribute("data-id"));
    const rowOfFocus = active && active.closest ? active.closest("[data-testid='pl-inbox-row']") : null;
    const focusRow = rowOfFocus ? rowOfFocus.getAttribute("data-id") : null;
    const repo = getRepo();
    const filters = h(
      "div",
      { class: "pl-inbox-filters", role: "group", "aria-label": "Show proposals that are" },
      FILTERS.map((f) =>
        h("button", { type: "button", class: "pl-filter" + (f.key === filter ? " pl-filter-on" : ""), "aria-pressed": String(f.key === filter), "data-testid": "pl-filter-" + f.key, "data-focus": "filter:" + f.key, onClick: () => select(f.key) }, f.label)
      )
    );
    fill(view,
      h("h2", { id: "pl-inbox-h", class: "pl-panel-title", tabindex: "-1", "data-focus": "heading" }, repo ? "Inbox for " + repo.name : "Inbox"),
      filters,
      note ? h("p", { class: "pl-inbox-sentence", "data-testid": "pl-inbox-note-line" }, note) : null,
      autoStartedNotices(),
      filter === "new" && autostartOff !== null && rows.some((r) => r.state === "new" && r.owner_process !== "internal_loop") ? h("p", { class: "pl-inbox-sentence", "data-testid": "pl-inbox-autostart-off" }, autostartOff + ".") : null,
      body()
    );
    if (key) {
      const again = [...view.querySelectorAll("[data-focus]")].find((n) => n.getAttribute("data-focus") === key);
      if (again && !again.disabled) {
        again.focus();
        if (range && typeof again.setSelectionRange === "function") again.setSelectionRange(range[0], range[1]);
      } else if (!again && focusRow !== null) {
        // The row left the list (decided, or moved to another filter): the next row's first action, else the list heading.
        const present = new Map([...view.querySelectorAll("[data-testid='pl-inbox-row']")].map((n) => [n.getAttribute("data-id"), n]));
        let target = null;
        for (const id of before.slice(before.indexOf(focusRow) + 1)) {
          const row = present.get(id);
          target = row ? row.querySelector(".pl-inbox-actions button[data-focus]") || row.querySelector("button[data-focus]") : null;
          if (target) break;
        }
        if (!target) target = view.querySelector("#pl-inbox-h");
        if (target) target.focus();
      }
    }
  }

  function select(key) {
    if (key === filter) return;
    filter = key;
    opened.clear();
    detailsById.clear();
    rows = [];
    cursor = null;
    note = "";
    rowNote.clear();
    load();
  }

  paint();
  return {
    el: root,
    load: () => load(),
    destroy() {
      destroyed = true;
      if (ac) ac.abort();
      gate.cancel();
      view.replaceChildren();
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
// D#483: the build was accepted but has no build slot yet. The card's own banner says why and what holds the slot.
approveSay("Approved, but the build has not started: it is waiting for a build slot. The reason is on this card, and the build starts by itself when a slot is free.", "waiting_for_slot");
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
// Request changes: the two refusals of its own.
approveSay("This pull request has used all its fix rounds. Review it yourself, then merge or close it on GitHub.", "escalate");
approveSay("Write what to change, in 2,000 characters or fewer. Nothing was sent.", "invalid_note", "validation_failed");
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

/**
 * What the worker answered for an accepted request: `refusal` is the error code it refused with (or null: done, or still going after the reads; a failed read is
 * not a refusal), and `waiting` is true when it finished the request with the build waiting for a build slot (outcome `advance: "waiting"`), which is not "started".
 */
export async function followAcceptedOutcome(call, sleep, accepted) {
  const id = accepted && typeof accepted.action_id === "string" ? accepted.action_id : null;
  if (id === null) return { refusal: null, waiting: false };
  for (let i = 0; i < FOLLOW_POLLS; i += 1) {
    let a;
    try {
      a = await call("GET", actionPath(id), undefined);
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      return { refusal: null, waiting: false };
    }
    if (a && (a.state === "refused" || a.state === "failed")) return { refusal: typeof a.error_code === "string" && a.error_code !== "" ? a.error_code : "refused", waiting: false };
    if (a && a.state === "done") return { refusal: null, waiting: !!a.outcome && a.outcome.advance === "waiting" };
    await sleep(FOLLOW_GAP_MS);
  }
  return { refusal: null, waiting: false };
}

/** The error code the worker refused an accepted request with, or null (done, or still going after the reads). A failed read is not a refusal. */
export async function followAccepted(call, sleep, accepted) {
  return (await followAcceptedOutcome(call, sleep, accepted)).refusal;
}

/** The logic (no DOM): one state per open card, `phase` idle | sending | started | error. */
export function createApprove({ call = api, onChange = () => {}, sleep = pause } = {}) {
  let st = { itemId: null, phase: "idle", text: "" };
  const set = (next) => {
    st = next;
    onChange();
  };

  const follow = (accepted) => followAcceptedOutcome(call, sleep, accepted);

  return {
    get state() {
      return st;
    },
    /** A different card was opened (or the card was closed): start fresh. */
    reset(itemId = null) {
      st = { itemId, phase: "idle", text: "" };
    },
    /** True while the note below the button belongs to a click on waiting runs rather than to a stage start. */
    get forRuns() {
      return st.forRuns === true;
    },
    /** The card's button when runner runs wait for this person: approve them all (see createRunsPanel.approveAll). Never silent. */
    async approveRuns(item, panel) {
      if (!item || !panel) return;
      if (st.itemId === item.id && st.phase === "sending") return;
      set({ itemId: item.id, phase: "sending", text: SENDING, forRuns: true });
      let res;
      try {
        res = await panel.approveAll();
      } catch (e) {
        if (e && e.name === "AbortError") return;
        res = { ok: false, text: APPROVE_GENERIC };
      }
      if (st.itemId === item.id) set({ itemId: item.id, phase: res.ok ? "started" : "error", text: res.text, forRuns: true });
    },
    async approve(item, liveRun = false) {
      if (!canApprove(item, liveRun)) return;
      if (st.itemId === item.id && (st.phase === "sending" || st.phase === "started")) return;
      set({ itemId: item.id, phase: "sending", text: SENDING });
      try {
        // No body: the third argument is undefined, so the request carries no JSON at all.
        const accepted = await call("POST", approvePath(item.id), undefined);
        const { refusal, waiting } = await follow(accepted);
        if (st.itemId === item.id) {
          if (refusal !== null) set({ itemId: item.id, phase: "error", text: approveSentenceFor(refusal) });
          else set({ itemId: item.id, phase: "started", text: waiting ? APPROVE_SENTENCES.waiting_for_slot : startedFor(item) });
        }
      } catch (e) {
        if (e && e.name === "AbortError") return;
        if (st.itemId === item.id) set({ itemId: item.id, phase: "error", text: approveSentenceFor(e && e.status === 429 ? "rate_limited" : e && e.code) });
      }
    },
  };
}

/** The button and its sentence for the open card. */
export function approveView(item, approver, liveRun = false, waiting = null) {
  const st = approver.state;
  const mine = st.itemId === item.id ? st : { phase: "idle", text: "" };
  // Runner runs wait for this person (`waiting` is the runs panel): the same button approves them. With none left, only the answer stays.
  if (waiting && (waiting.approvableCount() > 0 || mine.forRuns)) {
    const left = waiting.approvableCount();
    return h(
      "div",
      { class: "pl-approve", "data-testid": "pl-approve" },
      left > 0
        ? h("button", { type: "button", class: "pl-approve-btn", "data-testid": "pl-approve-btn", "aria-disabled": mine.phase === "sending" ? "true" : "false", onClick: () => approver.approveRuns(item, waiting) }, item.stage === "triaged" ? APPROVE_RUN_LABEL : labelFor(item))
        : null,
      left > 0 && waiting.waitingLine() ? h("p", { class: "pl-muted", "data-testid": "pl-approve-hint" }, waiting.waitingLine()) : null,
      mine.text ? h("p", { class: "pl-muted", role: "status", "data-testid": "pl-approve-note" }, mine.text) : null
    );
  }
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
//   Re-spec              -> POST /work-items/{id}/respec (the project manager adds the file list; the next Spec version has the same text plus the list)
//   Back to discussion   -> POST /work-items/{id}/back-to-discussion (a new panel and a new Spec version)
//   Treat as a feature   -> POST /work-items/{id}/treat-as-feature (a project has no panel; this runs one as a feature)
//   Close                -> POST /work-items/{id}/close, after an in-app confirm dialog (never the browser's confirm())
//   Request changes      -> POST /work-items/{id}/request-changes { note }, after a dialog with a note box (an open pull request only)
//
// Rules this file keeps (those of the approve button above): no request carries a body, except Request changes, whose body
// is the person's note and nothing else; every sentence a person reads is
// chosen here, never taken from a server code or message; one request at a time per card; an accepted request is followed
// for a few moments so a refusal that costs nothing reaches the sentence. An open pull request has no Close: the server says
// so (`close_on_github`), and the card tells the person to close the pull request on GitHub.

export const OPERATOR_LABELS = { request_changes: "Request changes", build_again: "Build again", respec: "Re-spec", back_to_discussion: "Back to discussion", treat_as_feature: "Treat as a feature", close: "Close", reopen: "Reopen", retry_push: "Try the push again", open_pr: "Open the pull request again" };
/** The order buttons are drawn in. An action the server lists that is not here is not drawn. */
export const OPERATOR_ORDER = ["request_changes", "build_again", "respec", "back_to_discussion", "treat_as_feature", "close", "reopen", "retry_push", "open_pr"];
const OPERATOR_TESTIDS = { request_changes: "pl-op-changes", build_again: "pl-op-build", respec: "pl-op-respec", back_to_discussion: "pl-op-back", treat_as_feature: "pl-op-feature", close: "pl-op-close", reopen: "pl-op-reopen", retry_push: "pl-op-retry-push", open_pr: "pl-op-open-pr" };

const itemPath = (id) => "/api/v1/work-items/" + encodeURIComponent(id);
export const OPERATOR_PATHS = {
  request_changes: (id) => itemPath(id) + "/request-changes",
  build_again: approvePath,
  respec: (id) => itemPath(id) + "/respec",
  back_to_discussion: (id) => itemPath(id) + "/back-to-discussion",
  treat_as_feature: (id) => itemPath(id) + "/treat-as-feature",
  close: (id) => itemPath(id) + "/close",
  reopen: (id) => itemPath(id) + "/reopen",
  retry_push: (id) => itemPath(id) + "/retry-push",
  open_pr: (id) => itemPath(id) + "/open-pr",
};

/** Under the buttons, before the click: what each one does. */
export const OPERATOR_NOTES = {
  request_changes: "Request changes sends your note to the agent that built this. It fixes the same pull request, then the reviewers check it again. It uses one of the item's fix rounds.",
  build_again: "Build again starts a new build from the same Spec. An agent opens a fresh pull request, and the reviewers run on it.",
  respec: "Re-spec has the project manager read the repository and add the list of files this Spec allows. The Spec's text stays the same. Then Build again.",
  back_to_discussion: "Back to discussion asks the panel again and writes a new Spec. The new Spec replaces the old one.",
  treat_as_feature: "A project has no panel, so it stops here. Treat as a feature changes it to a feature and runs the panel and the Spec as for any feature.",
  close: "Close ends the work item. No agent will work on it any more.",
  reopen: "Reopen puts a closed work item back in Triaged, where it can be approved again.",
  retry_push: "Try the push again sends the change to the public repository once more. It is tried at most three times in all.",
  open_pr: "Open the pull request again opens the pull request for the branch that was already pushed. Nothing is pushed again.",
};
export const CLOSE_ON_GITHUB_NOTE = "To close this, close its pull request on GitHub. The card then moves to Closed without a merge.";

/** What a person reads once the server accepted the request. */
export const OPERATOR_STARTED = {
  request_changes: "Sent. An agent is making your changes on the same pull request, and the reviewers check it again when it is done.",
  build_again: "Started. An agent is building this again from the same Spec, and the card moves when it opens a pull request.",
  respec: "Started. The project manager is adding the file list. A new Spec version appears when it is done; then press Build again.",
  back_to_discussion: "Sent back to the panel. The agents are discussing it again, and a new Spec follows when they are done.",
  treat_as_feature: "Changed to a feature. The agents are discussing it now, and a Spec follows when they are done.",
  close: "Closed.",
  reopen: "Reopened. The card is back in Triaged.",
  retry_push: "Started. The push is being tried again, and the Public change line shows how it ended. This can take a minute.",
  open_pr: "The pull request is open. The Public change line has its link.",
};
/** Open the pull request again answers with its outcome at once; a refusal leaves the pushed branch as it was. */
export const OPEN_PR_REFUSED = "The pull request could not be opened. The pushed branch is unchanged; the Public change line says what is known. You can try again.";

export const CLOSE_DIALOG = { title: "Close this work item?", lines: ["The card moves to Closed and no agent will work on it any more."], confirm: "Yes, close it", dismiss: "Keep it open" };
export const REOPEN_DIALOG = { title: "Reopen this work item?", lines: ["The card moves back to Triaged. Nothing starts until someone approves it."], confirm: "Yes, reopen it", dismiss: "Keep it closed" };
/** The actions that ask first, in the app's own dialog, and answer at once (no agent is involved). */
const CONFIRMED = { close: CLOSE_DIALOG, reopen: REOPEN_DIALOG };
/** Request changes asks for a note first, in the same dialog with a note box; the stage driver then runs, so it is followed like the other run actions. */
export const NOTE_MAX = 2000;
export const CHANGES_DIALOG = {
  title: "Request changes",
  lines: ["Say what to change. The agent that built this reads your note, fixes the same pull request, and the reviewers check it again."],
  label: "What to change",
  confirm: "Send",
  dismiss: "Cancel",
};
const DIALOGS = { ...CONFIRMED, request_changes: CHANGES_DIALOG };
/** Why Request changes is not offered on an open pull request, as the server says it (`request_changes_blocked`). */
export const CHANGES_BLOCKED = {
  live: "Request changes is not available while agents are working on this item. Try again when they are done.",
  rounds: "Request changes is not available: this pull request has used all its fix rounds. Review it yourself, then merge or close it on GitHub.",
};
/** One line per note sent with Request changes, for the activity. The note is the person's own text, shown as text. */
export const CHANGE_STATE_WORDS = { waiting: "Waiting for the fix round to start.", sent: "Sent to the fix round.", dropped: "Withdrawn." };
export function changeRequestLines(data) {
  const list = data && Array.isArray(data.change_requests) ? data.change_requests : [];
  return list
    .filter((c) => c && typeof c.note === "string")
    .map((c) => ({ text: (c.mine ? "You asked for changes: " : (typeof c.name === "string" && c.name ? c.name : "A former member") + " asked for changes: ") + c.note, state: CHANGE_STATE_WORDS[c.state] || "", at: typeof c.at === "string" ? c.at : null }));
}
/** The server's reason Request changes is held back, or null. */
export const changesBlocked = (data) => (data && Object.prototype.hasOwnProperty.call(CHANGES_BLOCKED, data.request_changes_blocked) ? data.request_changes_blocked : null);

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

  async function send(item, action, note) {
    const keepDialog = action in DIALOGS;
    set({ itemId: item.id, phase: "sending", action, text: SENDING, confirm: keepDialog });
    try {
      // No body (the third argument is undefined, so the request carries no JSON at all), except the note of Request changes.
      const accepted = await call("POST", OPERATOR_PATHS[action](item.id), action === "request_changes" ? { note } : undefined);
      // Close answers at once (no agent is involved); every other action is a run action that is followed.
      const { refusal, waiting } = action in CONFIRMED ? { refusal: null, waiting: false } : await followAcceptedOutcome(call, sleep, accepted);
      if (st.itemId !== item.id) return;
      if (action === "open_pr" && accepted && accepted.result === "refused") return set({ itemId: item.id, phase: "error", action, text: OPEN_PR_REFUSED, confirm: false });
      if (refusal !== null) return set({ itemId: item.id, phase: "error", action, text: approveSentenceFor(refusal), confirm: keepDialog && action in CONFIRMED });
      set({ itemId: item.id, phase: "started", action, text: waiting ? APPROVE_SENTENCES.waiting_for_slot : OPERATOR_STARTED[action], confirm: false });
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
      if (action in DIALOGS) return set({ itemId: item.id, phase: "idle", action, text: "", confirm: true });
      return send(item, action);
    },
    /** "Yes, close it" / "Yes, reopen it" / "Send" (with the note box's text, checked here first: nothing is sent for an empty or long note). */
    confirmClose(item, note) {
      if (!item || st.itemId !== item.id || !st.confirm || st.phase === "sending" || !(st.action in DIALOGS)) return;
      if (st.action === "request_changes") {
        const text = typeof note === "string" ? note.trim() : "";
        if (text === "" || Array.from(text).length > NOTE_MAX) return set({ ...st, phase: "error", text: approveSentenceFor("invalid_note") });
        return send(item, st.action, text);
      }
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
      const back = el.querySelector('[data-testid="' + OPERATOR_TESTIDS[st.action || "close"] + '"]') || el.querySelector('[data-testid="pl-op-close"], [data-testid="pl-op-reopen"], [data-testid="pl-op-changes"]');
      dlg.close();
      dlg.remove();
      dlg = parts = null;
      if (back) back.focus();
      return;
    }
    if (!dlg) {
      const words = DIALOGS[st.action] || CLOSE_DIALOG;
      const withNote = st.action === "request_changes";
      parts = {
        err: h("p", { class: "pl-dialog-error", role: "alert", tabindex: "-1", "data-testid": "pl-op-dialog-error" }),
        note: withNote ? h("textarea", { id: "pl-op-note-box", class: "pl-note-box", rows: "5", maxlength: String(NOTE_MAX), "data-testid": "pl-op-note-box" }) : null,
        confirm: h("button", { type: "button", class: "pl-act", "data-testid": "pl-op-confirm", onClick: () => parts.confirm.getAttribute("aria-disabled") !== "true" && op.confirmClose(item, parts.note ? parts.note.value : undefined) }, words.confirm),
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
          ...(parts.note ? [h("label", { for: "pl-op-note-box", class: "pl-muted" }, words.label), parts.note] : []),
          parts.err,
          h("div", { class: "pl-dialog-actions" }, parts.dismiss, parts.confirm)
        )
      );
      document.body.appendChild(dlg);
      dlg.showModal();
      // The safe choice has the focus: Enter keeps the item open. With a note box, the box has it.
      (parts.note || parts.dismiss).focus();
    }
    parts.err.textContent = st.phase === "error" ? st.text : "";
    // aria-disabled, not disabled: a disabled button drops keyboard focus while the request is out.
    parts.confirm.setAttribute("aria-disabled", st.phase === "sending" ? "true" : "false");
    parts.dismiss.setAttribute("aria-disabled", st.phase === "sending" ? "true" : "false");
    if (parts.note) parts.note.readOnly = st.phase === "sending";
  }

  function draw() {
    const st = op.state;
    const mine = !!item && st.itemId === item.id ? st : { phase: "idle", action: null, text: "", confirm: false };
    const actions = item ? operatorActions(data) : [];
    const onHost = item ? closeOnHost(data) : false;
    const blocked = item ? changesBlocked(data) : null;
    const asked = item ? changeRequestLines(data) : [];
    const sig = JSON.stringify([item && item.id, actions, onHost, blocked, asked, mine.phase, mine.text, mine.confirm]);
    if (sig !== signature) {
      signature = sig;
      const held = el.contains(document.activeElement) && document.activeElement.dataset ? document.activeElement.dataset.testid : null;
      const note = mine.text !== "" && !mine.confirm;
      const visible = actions.length > 0 || onHost || note || blocked !== null || asked.length > 0;
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
              ...(blocked !== null
                ? [
                    h("button", { type: "button", class: "pl-act", "data-testid": "pl-op-changes-off", "aria-disabled": "true", "aria-describedby": "pl-op-changes-why" }, OPERATOR_LABELS.request_changes),
                    h("p", { class: "pl-muted", id: "pl-op-changes-why", "data-testid": "pl-op-changes-why" }, CHANGES_BLOCKED[blocked]),
                  ]
                : []),
              ...(asked.length
                ? [h("ul", { class: "pl-op-asked", "data-testid": "pl-op-asked" }, asked.map((a) => h("li", null, h("p", null, a.text), a.state ? h("p", { class: "pl-muted" }, a.state) : null)))]
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
