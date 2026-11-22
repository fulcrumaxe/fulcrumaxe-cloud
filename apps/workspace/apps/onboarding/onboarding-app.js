// D#37 WS-F9a: the Onboarding app. Two tracks, read from GET /api/v1/onboarding (`tracks`): the pipeline track's six steps (this file) and, since D#845 ON-6,
// the engine track's seven (onboarding-engine.js). The first visit offers the choice; "Add the other track" stays while only one is chosen.
//
// Rules this file keeps:
//   * Progress belongs to the server. The current step is the first one whose completed_at is null, the times shown
//     are the server's, and nothing here computes, stores (no web storage) or writes progress. The app re-reads when
//     its window regains focus (which is how a hand-off returns), when a preview settles, and on the shell's live
//     events for what steps 1 and 2 stand for (the model key, the GitHub App install). Those two steps can reopen,
//     so a step that was done may be open again on the next read. While one is open, step 3's panel is not mounted.
//   * Choosing a plan never waits for the earlier steps. While `pay` is open, a secondary action (on the screen, and on
//     step 3 beside the preview) opens the same plan picker under step 4, whatever step is current. The preview stays
//     optional: once the server reports it skipped (a plan is chosen and no preview finished) it shows "Skipped", has no
//     Start button, and does not count as open. The wording is in TEXT; the two places it is offered are in render().
//   * Steps 1, 2 and 5 only open the app that does the step. Step 3 is onboarding-preview.js. Step 4 is the gate's own
//     plan picker (FULCSubscriptionGate.mountPlans), not a copy. Step 6 opens Runs, where the first pull request shows; it is Done or Up next by its time, with no text of its own.
//   * Every node comes from h(); the server's text is never parsed as markup.
import { h, timeNode } from "../_lib/dom.js";
import { api, ApiFailure } from "../_lib/api.js";
import { isOpenStep, parseTracks, shownTracks } from "../../core/onboarding-mode.js";
import { on, onRefresh } from "../../core/cloud-live.js";
import { mountPreview } from "./onboarding-preview.js";

const LABELS = {
  model_key: "Add your model key",
  readonly_app: "Install the GitHub App (read-only)",
  preview: "Try a free preview",
  pay: "Choose a plan",
  write_app: "Install the GitHub App (write)",
  first_pr: "Get your first pull request",
};
const HANDOFF = { model_key: ["model-key", "Open Model Key"], readonly_app: ["repos", "Open Repos"], write_app: ["repos", "Open Repos"], first_pr: ["runs", "Open Runs"] };
// Domain events after which step 1 or 2 may have changed.
// (D#845: a setup that moved, too: it changes what the engine track's steps show.)
const LIVE_EVENTS = ["model_connection.changed", "model_connection.broken", "installation.changed", "setup.changed"];
// The repo list step 3 offers follows the account's repos too (a detach or a sync changes it without changing a step),
// so this event re-reads that list only, not the steps.
const REPO_EVENT = "repos.changed";
const TEXT = {
  skipAhead: "Skip ahead: choose a plan",
  skipPreview: "Skip the preview and choose a plan",
  skipped: "Skipped",
};
const FORBIDDEN = "Only owners and admins can see setup progress.";
const LOAD_FAILED = "Your setup progress couldn't be loaded.";
const ENGINE_UNREADABLE = "The engine setup couldn't be loaded.";
const CHOICE = { engine: "Run the engine on my machine or server", pipeline: "Let the cloud run builds" };
const ADD_OTHER = "Add the other track";
const CHOICE_FAILED = "Your choice couldn't be saved. Try again.";
// The engine track's words live in onboarding-engine.js, fetched only when that track is on screen (a static import would be one more boot request).
let engineModule = null;
const loadEngine = () => (engineModule = engineModule || import("./onboarding-engine.js").catch((e) => { engineModule = null; throw e; }));
const CHOICE_TITLE = "Choose how to set up your workspace";
/** An optional read: a failure leaves that detail out (the steps then show their generic state); only an abort passes through. */
const soft = (p) => p.catch((e) => { if (e && e.name === "AbortError") throw e; return null; });

function mountOnboarding(host) {
  const abort = new AbortController();
  const st = { steps: null, parsed: null, eng: null, error: "", ctx: {}, price: null, choosing: false, choiceError: "", planBusy: false, planNote: "" };
  let destroyed = false, busy = false, again = false, preview = null, payShown = false;
  // The plan picker opens once, into payHost, and stays until pay is done. The server decides when pay is done.
  function showPlans() {
    if (payShown) return;
    payShown = true;
    if (window.FULCSubscriptionGate) window.FULCSubscriptionGate.mountPlans(payHost, !!window.currentIsAdmin);
  }
  function choosePlan() {
    showPlans();
    render();
    payHost.focus();
    if (payHost.scrollIntoView) payHost.scrollIntoView({ block: "nearest" });
  }
  const planButton = (label, testid) => h("button", { type: "button", class: "ob-btn", "data-testid": testid, onClick: choosePlan }, label);
  const openApp = (id) => window.FULCWM && window.FULCWM.open(id);

  const title = h("h2", { class: "ob-title", tabindex: -1, "data-testid": "ob-title" }, "Set up your workspace");
  const live = h("p", { class: "ob-live", role: "status", "aria-live": "polite", "data-testid": "ob-live" });
  const errorEl = h("div", { class: "ob-error", role: "alert", "data-testid": "ob-error" });
  const body = h("div", { class: "ob-body" });
  const previewHost = h("div", { class: "ob-panel", "data-no-preview": "" });
  const payHost = h("div", { class: "ob-panel", tabindex: -1, "data-testid": "ob-pay-panel" });
  // The scrolling region is itself focusable, so the keyboard can scroll it when no control is on screen.
  host.replaceChildren(h("div", { class: "ob-app", role: "region", "aria-label": "Setup progress", tabindex: 0, "data-testid": "ob-app" }, title, live, errorEl, body));

  function stepAction(step) {
    if (HANDOFF[step]) {
      const [app, label] = HANDOFF[step];
      return h("button", { type: "button", class: "ob-btn ob-btn-primary", "data-testid": "ob-open-" + app, onClick: () => openApp(app) }, label);
    }
    if (step === "preview" && !preview) {
      preview = mountPreview(previewHost, { openApp, announce: (t) => (live.textContent = t), onSettled: load, onChoosePlan: choosePlan, canChoosePlan: () => !!st.steps && st.steps.find((s) => s.step === "pay")?.completed_at === null });
    }
    if (step === "pay") showPlans();
    return null;
  }

  function render() {
    if (destroyed) return;
    errorEl.replaceChildren(...(st.error ? [h("span", null, st.error + " "), h("button", { type: "button", class: "ob-btn", "data-testid": "ob-retry", onClick: load }, "Try again")] : []));
    if (!st.steps) {
      body.replaceChildren(st.error ? "" : h("p", { class: "ob-muted" }, "Loading your setup progress…"));
      return;
    }
    const shown = shownTracks(st.parsed);
    // The track choice on the first visit; otherwise each chosen track in the order it was chosen, with "Add the other track" while one is missing.
    const parts = (pipelineNodes) => [
      ...(shown.length === 0 ? [choiceScreen()] : shown.flatMap((t) => [shown.length > 1 ? h("h3", { class: "ob-sub" }, CHOICE[t]) : "", ...(t === "pipeline" ? pipelineNodes : [st.parsed.engine ? st.eng.engineSection(st.parsed.engine, engineEnv()) : engineUnreadable()])])),
      shown.length === 1 ? h("button", { type: "button", class: "ob-btn", "data-testid": "ob-add-other", "aria-label": ADD_OTHER + ": " + CHOICE[shown[0] === "engine" ? "pipeline" : "engine"], onClick: () => choose(shown[0] === "engine" ? "pipeline" : "engine") }, ADD_OTHER) : "",
    ].filter(Boolean);
    if (!shown.includes("pipeline")) {
      if (preview) { preview.destroy(); preview = null; }
      payShown = false;
      payHost.replaceChildren();
      // dom-insert-ok: parts() builds every entry with h() and drops the empty ones with filter(Boolean)
      body.replaceChildren(...parts([]));
      return;
    }
    const current = st.steps.findIndex(isOpenStep);
    const payOpen = st.steps.find((s) => s.step === "pay").completed_at === null;
    if (!payOpen && payShown) {
      payShown = false; // paid: the picker has done its job
      payHost.replaceChildren();
    }
    // The preview panel exists only while step 3 can be acted on (it is the current step) or has been finished (its
    // result stays on screen). When an earlier step reopens, the panel goes: no stale repo list, no live Start button.
    // It is mounted afresh, and re-reads the repos and the preview, the next time step 3 is current.
    const previewAt = st.steps.findIndex((s) => s.step === "preview");
    // A skipped step keeps the panel only while it shows a preview that exists (one still running when the plan was chosen),
    // so its result lands; a panel that would still offer Start goes, as there is nothing left to start.
    const pv = st.steps[previewAt];
    if (preview && previewAt !== current && pv.completed_at === null && !(pv.skipped && preview.active())) {
      preview.destroy();
      preview = null;
    }
    if (preview) preview.rerender(); // the "Choose a plan" button follows whether pay is still open
    const items = st.steps.map((s, i) => {
      const done = s.completed_at !== null;
      const li = h("li", { class: "ob-step" + (done ? " ob-done" : "") + (i === current ? " ob-current" : ""), "data-testid": "ob-step-" + s.step, "aria-current": i === current ? "step" : null },
        h("div", { class: "ob-step-head" }, h("strong", null, LABELS[s.step]),
          done ? h("span", { class: "ob-state" }, "Done ", timeNode(s.completed_at, true))
            : s.skipped ? h("span", { class: "ob-state", "data-testid": "ob-skipped" }, TEXT.skipped)
            : i === current ? h("span", { class: "ob-state" }, "Up next") : null));
      // Step 6 keeps its button once done: Runs is where the pull request is.
      const action = i === current || (done && s.step === "first_pr") ? stepAction(s.step) : null;
      if (action) li.append(action); // steps 3 and 4 return no node: appending null would print "null"
      if (s.step === "preview" && preview) li.append(previewHost);
      if (s.step === "preview" && i === current && payOpen && !payShown) li.append(planButton(TEXT.skipPreview, "ob-skip-preview"));
      if (s.step === "pay" && payShown && payOpen) li.append(payHost); // under step 4 whether or not it is current
      return li;
    });
    const skipAhead = payOpen && !payShown ? planButton(TEXT.skipAhead, "ob-skip-ahead") : "";
    // dom-insert-ok: parts() builds every entry with h() and drops the empty ones with filter(Boolean)
    body.replaceChildren(...parts([current === -1 ? h("p", { "data-testid": "ob-complete" }, "Setup is complete.") : "", skipAhead, h("ol", { class: "ob-steps", "aria-label": "Setup steps" }, items)]));
  }

  function choiceScreen() {
    return h("div", { class: "ob-choice", "data-testid": "ob-choice" }, h("h3", { class: "ob-sub" }, CHOICE_TITLE),
      ["engine", "pipeline"].map((t) => h("button", { type: "button", class: "ob-btn ob-btn-primary", "data-testid": "ob-choose-" + t, disabled: st.choosing, onClick: () => choose(t) }, CHOICE[t])),
      st.choiceError ? h("p", { class: "ob-error", role: "alert", "data-testid": "ob-choice-error" }, st.choiceError) : "");
  }
  const canOpen = (id) => !!(window.FULCApps && window.FULCApps.get(id)); // an app the unpaid desktop keeps off is not offered
  /** The engine track's own error state: its steps could not be read, the pipeline track beside it is unaffected. */
  const engineUnreadable = () => h("section", { class: "ob-track", "data-testid": "ob-track-engine-error", "aria-label": "Engine setup" },
    h("p", { class: "ob-error", role: "alert", "data-testid": "ob-engine-error" }, ENGINE_UNREADABLE + " "), h("button", { type: "button", class: "ob-btn", "data-testid": "ob-engine-retry", onClick: load }, "Try again"));
  // D#845 ON-6c: the machine's KVM fact and helper_missing come from the machine step itself (the same machine the step's tier is read from), never from a second read.
  const machineFacts = () => {
    const m = st.parsed && st.parsed.engine ? st.parsed.engine[0] : null;
    return m ? { ...(m.kvm ? { kvm: m.kvm } : {}), ...(m.helper_missing ? { helper_missing: true } : {}), ...(m.preflight ? { preflight: m.preflight } : {}) } : {};
  };
  const engineEnv = () => ({ ctx: { ...st.ctx, machine: machineFacts(), origin: window.location.origin, isAdmin: window.currentIsAdmin !== false, price: st.price, planBusy: st.planBusy, planNote: st.planNote }, price: st.price, announce: (t) => (live.textContent = t), canOpen, openApp, runAction: runPlanAction });
  // D#845 ON-22: the project step's purchase buttons. Checkout is the existing one (the server never sells a second subscription: an account that already pays gets the item added, and the answer is its own success path).
  // Returning from Stripe reloads the app, which reads the step again. "Add an engine" changes the quantity on the subscription and reads now; the account follows the provider's confirmation, so the step says so and refreshes when the app is shown again (no timer here).
  const PLAN_REFUSED = { 403: "Only the account owner can change the Engine plan.", 409: "This account's plan can't be changed here. Use Budget & Billing.", 422: "That quantity isn't accepted." };
  const PLAN_FAILED = "The Engine plan couldn't be changed. Try again.";
const ADDED_NOTE = "Engine added. This step updates when the provider confirms the change.";
  async function runPlanAction(id) {
    if (st.planBusy) return;
    st.planBusy = true;
    st.planNote = "";
    render();
    try {
      if (id === "add_engine") {
        const project = st.parsed && st.parsed.engine ? st.parsed.engine.find((x) => x.step === "project") : null;
        const quantity = project && project.engines ? project.engines.quantity + 1 : 1;
        await api("POST", "/api/v1/billing/engine-quantity", { quantity }, abort.signal);
        st.planBusy = false;
        st.planNote = ADDED_NOTE;
        await load();
        return;
      }
      const res = await api("POST", "/api/v1/billing/checkout-session", { plan: "engine", quantity: 1, success_path: "/", cancel_path: "/" }, abort.signal);
      if (!res || typeof res.url !== "string" || !res.url.startsWith("https://")) throw new Error("link");
      window.location.assign(res.url); // Stripe's own page, or this app's success path when the item was added to the existing subscription
      return;
    } catch (e) {
      if (e && e.name === "AbortError") return;
      st.planNote = e instanceof ApiFailure && Object.hasOwn(PLAN_REFUSED, e.status) ? PLAN_REFUSED[e.status] : PLAN_FAILED;
    }
    st.planBusy = false;
    render();
  }
  async function choose(track) {
    if (st.choosing) return;
    st.choosing = true;
    st.choiceError = "";
    render();
    let saved = false;
    try {
      await api("PUT", "/api/v1/onboarding/track", { track }, abort.signal);
      saved = true;
    } catch (e) {
      if (e && e.name === "AbortError") return;
      st.choiceError = e instanceof ApiFailure && e.status === 403 ? FORBIDDEN : CHOICE_FAILED;
    }
    st.choosing = false;
    if (saved) await load();
    else render();
  }
  /** The details the engine track's copy joins in: the machine's name (from the runners list) and the Engine plan's price. Either may be missing. */
  async function readExtras() {
    const [runners, plans] = await Promise.all([soft(api("GET", "/api/runners", undefined, abort.signal)), soft(api("GET", "/api/plans", undefined, abort.signal))]);
    st.ctx = st.eng.machineContext(runners, Date.now());
    st.price = st.eng.enginePrice(plans);
  }

  async function load() {
    if (destroyed) return;
    if (busy) {
      again = true; // a read is in flight and may predate what asked for this one (a settled preview): read once more after it
      return;
    }
    busy = true;
    try {
      const parsed = parseTracks(await api("GET", "/api/v1/onboarding", undefined, abort.signal));
      if (!parsed) throw new Error("shape");
      if (parsed.engine && shownTracks(parsed).includes("engine")) {
        st.eng = await loadEngine();
        await readExtras();
      }
      st.parsed = parsed;
      st.steps = parsed.pipeline;
      st.error = "";
      // WS-F9b: the shell's finish-setup strip follows what this app has just read (owners/admins only; no-op otherwise).
      if (window.FULCOnboardingMode && window.FULCOnboardingMode.reportSteps) window.FULCOnboardingMode.reportSteps(parsed.pipeline);
    } catch (e) {
      if (e && e.name === "AbortError") return;
      st.error = e instanceof ApiFailure && e.status === 403 ? FORBIDDEN : LOAD_FAILED;
    } finally {
      busy = false;
    }
    render();
    if (again) {
      again = false;
      load();
    }
  }

  render();
  load();
  setTimeout(() => title.focus(), 0);
  // The shell's single event client is the only source of live updates; no timer here.
  const offs = [...LIVE_EVENTS.map((type) => on(type, load)), on(REPO_EVENT, () => preview && preview.refreshRepos()), onRefresh(load)];

  return {
    refresh: load,
    destroy() {
      destroyed = true;
      abort.abort();
      for (const off of offs) off();
      if (preview) preview.destroy();
      host.replaceChildren();
    },
  };
}

let current = null;
const FULC = window.FULC;
if (!FULC || typeof FULC.register !== "function") throw new Error("Onboarding app: the FULC SDK global is missing");
const refresh = () => current && current.refresh();
FULC.register({
  id: "onboarding",
  title: "Onboarding",
  icon: "✓",
  defaultSize: { w: 640, h: 560 },
  onOpen({ contentEl }) {
    if (current) current.destroy();
    current = mountOnboarding(contentEl);
  },
  onFocus: refresh,
  onShow: refresh,
  onClose() {
    if (current) current.destroy();
    current = null;
  },
});
