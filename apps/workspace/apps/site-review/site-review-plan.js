// D#3 K09b: the "Site kit plan" panel of the Site review app, loaded with
// import() so it is not one of the app's boot files. It shows what one site has
// paid for (setup payment, sync subscription) and the expected model spend, all
// from GET /api/v1/sites/{id}/billing. Owners and admins get the buttons (the
// flag only hides them; the server decides). Pay setup and Start sync open the
// returned Checkout url in this tab; nothing here reads a Stripe id, because
// the API never returns one. Every failure is one fixed sentence.
import { h, confirmAction } from "../_lib/dom.js";
import { api, createRetryGate, isRateLimited, retryWords, waitSeconds } from "../_lib/api.js";

const UNAVAILABLE = "The plan isn't available right now.";
const FAILED = "That didn't go through. Try again.";
const SENTENCES = {
  sitekit_prices_provisional: "Site kit prices are still provisional, so checkout is closed for now.",
  setup_already_paid: "The setup payment is already paid.",
  sync_already_active: "Sync is already running for this site.",
  sync_not_active: "This site has no running sync to stop.",
};
const SYNC_TEXT = {
  active: "active",
  trialing: "in its trial",
  past_due: "payment overdue",
  canceled: "ended",
  unpaid: "ended, unpaid",
  incomplete: "waiting for the first payment",
  incomplete_expired: "never started",
  paused: "paused",
};
const RUNNING = new Set(["active", "trialing", "past_due"]);
const ENDED = new Set(["canceled", "unpaid", "incomplete_expired"]);

function failure(e) {
  if (e && e.status === 403) return "Only owners and admins can do that.";
  if (e && e.status === 404) return "That site wasn't found.";
  const table = e && e.status === 409 ? SENTENCES : {};
  return e && Object.hasOwn(table, e.code) ? table[e.code] : FAILED;
}

const day = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : "");

function syncLine(sync) {
  if (!sync.status) return "Sync: not started";
  const label = Object.hasOwn(SYNC_TEXT, sync.status) ? SYNC_TEXT[sync.status] : "not running";
  if (!RUNNING.has(sync.status) || !sync.current_period_end) return "Sync: " + label;
  return "Sync: " + label + (sync.cancel_at_period_end ? ", ends " : ", renews ") + day(sync.current_period_end);
}

export function mountPlan(host) {
  let siteId = "";
  let admin = false;
  let plan = null;
  let note = "";
  let busy = false;
  let closed = false;
  let seq = 0;
  let ctl = null;

  // The wait after a 429 on Pay setup, Start sync or Stop sync (one Stripe budget per account): "Try again in
  // N seconds", with the three buttons off until it ends.
  let waitOwnsNote = false;
  const waiting = () => gate.remaining > 0;
  const gate = createRetryGate({
    onChange(remaining) {
      if (closed) return;
      if (waitOwnsNote) {
        note = remaining > 0 ? "Too many tries. " + retryWords(remaining) : "";
        if (remaining === 0) waitOwnsNote = false;
        const status = host.querySelector('[data-testid="sr-plan-status"]');
        if (status) status.textContent = note;
      }
      // Only the buttons and the status line change on a tick, so the panel is not rebuilt and focus stays put.
      for (const el of host.querySelectorAll("button.sr-btn")) el.disabled = busy || remaining > 0;
    },
  });
  function startWait(e) {
    waitOwnsNote = true;
    gate.start(waitSeconds(e));
  }

  const url = (suffix) => "/api/v1/sites/" + siteId + "/billing" + suffix;
  const button = (key, label, onClick) =>
    h("button", { class: "sr-btn", type: "button", "data-key": key, "data-testid": key, disabled: busy || waiting(), onClick }, label);

  function render() {
    if (closed) return;
    const kids = [h("h3", { class: "sr-heading" }, "Site kit plan")];
    if (plan) {
      const paid = plan.setup.paid;
      const live = RUNNING.has(plan.sync.status || "");
      const canStart = !plan.sync.status || ENDED.has(plan.sync.status);
      if (!paid) kids.push(h("p", { "data-testid": "sr-plan-lock" }, "Publishing needs the setup payment"));
      kids.push(h("p", { "data-testid": "sr-plan-setup" }, paid ? "Setup: paid on " + day(plan.setup.paid_at) : "Setup: not paid"));
      kids.push(h("p", { "data-testid": "sr-plan-sync" }, syncLine(plan.sync)));
      if (plan.prices_provisional) kids.push(h("p", null, "Prices are provisional."));
      kids.push(h("p", null, "Expected spend on your own model bill:"));
      kids.push(h("ul", { class: "sr-list", "data-testid": "sr-plan-spend" }, plan.expected_spend.map((line) => h("li", null, line))));
      if (admin && !paid) kids.push(button("sr-plan-pay", "Pay setup", () => checkout("setup-checkout")));
      if (admin && paid && canStart) kids.push(button("sr-plan-start", "Start sync", () => checkout("sync-checkout")));
      if (admin && live && !plan.sync.cancel_at_period_end) kids.push(button("sr-plan-stop", "Stop sync at period end", stop));
    }
    kids.push(h("p", { role: "status", "aria-live": "polite", "data-testid": "sr-plan-status" }, note));
    host.replaceChildren(...kids);
  }

  async function load() {
    if (ctl) ctl.abort();
    ctl = new AbortController();
    const mine = ++seq;
    try {
      const next = await api("GET", url(""), undefined, ctl.signal);
      if (mine !== seq) return;
      plan = next;
    } catch (e) {
      if ((e && e.name === "AbortError") || mine !== seq) return;
      plan = null;
      note = e && e.status === 404 ? "That site wasn't found." : UNAVAILABLE;
    }
    render();
  }

  async function checkout(suffix) {
    if (busy || waiting()) return;
    busy = true;
    note = "";
    waitOwnsNote = false;
    render();
    try {
      const back = window.location.pathname;
      const out = await api("POST", url("/" + suffix), { success_path: back, cancel_path: back });
      if (out && typeof out.url === "string" && out.url.startsWith("https://")) {
        window.location.assign(out.url);
        return;
      }
      note = FAILED;
    } catch (e) {
      if (isRateLimited(e)) startWait(e);
      else note = failure(e);
    }
    busy = false;
    await load();
  }

  async function stop() {
    if (busy) return;
    if (!(await confirmAction("Stop sync at the end of the paid period? Your published site stays as it is."))) return;
    if (waiting()) return;
    busy = true;
    note = "";
    waitOwnsNote = false;
    render();
    try {
      await api("POST", url("/sync-cancel"));
      note = "Sync will stop at the end of the paid period.";
    } catch (e) {
      if (isRateLimited(e)) startWait(e);
      else note = failure(e);
    }
    busy = false;
    await load();
  }

  return {
    // Reads again only when the site changes; the app calls this after every report read.
    show(id, isAdmin) {
      admin = isAdmin === true;
      if (id !== siteId) {
        siteId = id;
        plan = null;
        note = "";
        load();
      }
      render();
    },
    destroy() {
      closed = true;
      gate.cancel();
      seq++;
      if (ctl) ctl.abort();
      host.replaceChildren();
    },
  };
}

// ───────── D#3 K10: the "Read-only preview" panel of the Site review app, loaded with import() like the plan panel so it is not a
// boot file. It asks for a site's one preview (GET and POST /api/v1/sites/{id}/preview), shows the homepage render with
// "N claims, M unverifiable, K blockers", and says what stays locked until setup is paid. Owners and admins get the
// button (the flag only hides it; the server decides). Every state and every refusal is a sentence from the tables
// below, chosen by a closed wire code: nothing the server wrote is shown, and no value that is missing prints as
// "null" or "undefined". The render is a page built from repository text, so it only ever goes into a sandboxed frame.
// (Lives in this file: each new app file costs a boot request, and the boot budget and the per-app file limit are full.)

const PREVIEW_UNAVAILABLE = "The preview isn't available right now.";
const LOCK_LABEL = "Setup payment required";
const POLL_MS = 5000;

// One sentence for each refusal the POST can answer, by the server's error code.
export const REFUSALS = {
  preview_used: "Preview already used",
  preview_capacity: "Today's preview allowance is used up. Try again tomorrow.",
  preview_cap_not_confirmed: "The spending cap wasn't confirmed, so nothing was started.",
  preview_unavailable: "Previews can't run yet. Nothing was started.",
  insufficient_role: "Only owners and admins can start the preview.",
  session_required: "Only owners and admins can start the preview.",
  not_found: "That site wasn't found, or it isn't connected through the site kit App.",
};

// Why a preview stopped, by the closed reason the server stored.
export const REASONS = {
  capacity: "today's preview allowance was used up",
  not_requested: "it was not in the requested state",
  input_invalid: "the repository details were not usable",
  spend_refused: "the model spend could not be reserved",
  policy_invalid: "the sandbox rules were not usable",
  sandbox_failed: "the sandbox could not be created",
  clone_failed: "the repository could not be read",
  policy_failed: "the sandbox network could not be restricted",
  agent_failed: "the read stopped before it finished",
  over_cap: "the read would have gone past the spending cap",
  output_invalid: "the read's answer could not be used",
  render_failed: "the homepage could not be drawn",
  run_failed: "something went wrong on our side",
  setup_payment_required: "setup payment is required",
};

const STATE_NAMES = ["requested", "running", "finished", "failed", "void"];

/** The frame's address: only the render route of this very site, never a path the server named otherwise. "" when there is none. */
export function renderPath(siteId, url) {
  const want = "/api/v1/sites/" + siteId + "/preview/render";
  return typeof siteId === "string" && /^[0-9a-f-]{36}$/i.test(siteId) && url === want ? want : "";
}

export function reasonSentence(code) {
  return typeof code === "string" && Object.hasOwn(REASONS, code) ? REASONS[code] : "it stopped early";
}

/** A refused or failed request as one fixed sentence. A 429 is the wait; anything not listed is the generic sentence. */
export function refusalSentence(e) {
  if (isRateLimited(e)) return "Too many tries. " + retryWords(waitSeconds(e));
  if (e && e.status === 403 && !Object.hasOwn(REFUSALS, e.code)) return REFUSALS.insufficient_role;
  if (e && e.status === 404) return REFUSALS.not_found;
  if (e && typeof e.code === "string" && Object.hasOwn(REFUSALS, e.code)) return REFUSALS[e.code];
  return FAILED;
}

/** "Full site: Setup payment required" for a locked feature, "Full site: open" for one that is not. The label is ours, never the server's. */
export function lockLine(name, lock) {
  const locked = !lock || lock.locked !== false;
  return name + ": " + (locked ? LOCK_LABEL : "open");
}

const capText = (cap) => (Number.isFinite(cap) && cap > 0 ? "$" + cap : "the spending cap");

/** What the person is asked to confirm before anything is spent. */
export function confirmSentence(cap) {
  return "This preview reads your repository's README and top-level docs with your own model key. It may spend up to " + capText(cap) + " of that key. Start it?";
}

/** The state line for the newest preview (or none), as one sentence. */
export function stateSentence(preview) {
  if (!preview) return "No preview yet. One preview per GitHub account and per installation.";
  const state = STATE_NAMES.includes(preview.state) ? preview.state : "";
  if (state === "requested") return "Preview requested. Waiting for it to start.";
  if (state === "running") return "Preview running. This can take a few minutes.";
  if (state === "finished") return preview.summary && typeof preview.summary.line === "string" ? preview.summary.line : "Preview finished.";
  if (state === "failed") return "The preview stopped because " + reasonSentence(preview.reason) + ". The one-time preview is used.";
  if (state === "void") return "The preview didn't start because " + reasonSentence(preview.reason) + ". Nothing was spent, and you can ask again.";
  return "The preview's state isn't known.";
}

/** The button is offered when there is no preview, or the last one never started. */
export function canAsk(data) {
  return !data.preview || data.preview.state === "void";
}

export function mountPreview(host) {
  let siteId = "";
  let admin = false;
  let data = null;
  let note = "";
  let loadNote = "";
  let busy = false;
  let closed = false;
  let seq = 0;
  let ctl = null;
  let timer = null;

  const url = "/api/v1/sites/";
  const stopTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  function render() {
    if (closed) return;
    const kids = [h("h3", { class: "sr-heading" }, "Read-only preview")];
    if (data) {
      kids.push(h("p", { "data-testid": "sr-preview-state" }, stateSentence(data.preview)));
      if (data.preview && data.preview.state === "finished" && renderPath(siteId, data.preview.homepage_url) !== "") {
        // The page is served by its own route under a policy of its own; sandbox="" gives it no script, form, popup or same-origin access.
        kids.push(h("iframe", { class: "sr-frame", title: "Homepage preview", sandbox: "", src: renderPath(siteId, data.preview.homepage_url), "data-testid": "sr-preview-frame" }));
      }
      if (canAsk(data)) {
        kids.push(
          admin
            ? h("button", { class: "sr-btn", type: "button", disabled: busy, "data-key": "sr-preview-start", "data-testid": "sr-preview-start", onClick: ask }, "Preview")
            : h("p", { "data-testid": "sr-preview-readonly" }, REFUSALS.insufficient_role)
        );
      }
      const locks = data.locks || {};
      kids.push(
        h(
          "ul",
          { class: "sr-list", "data-testid": "sr-preview-locks" },
          h("li", null, lockLine("Full site", locks.full_site)),
          h("li", null, lockLine("Downloads", locks.downloads)),
          h("li", null, lockLine("Publish", locks.publish))
        )
      );
    }
    const say = note || loadNote;
    kids.push(h("p", { role: "status", "aria-live": "polite", "data-testid": "sr-preview-status" }, say));
    host.replaceChildren(...kids);
  }

  function schedule() {
    stopTimer();
    if (closed || !data || !data.preview) return;
    if (data.preview.state === "requested" || data.preview.state === "running") timer = setTimeout(load, POLL_MS);
  }

  async function load() {
    stopTimer();
    if (ctl) ctl.abort();
    ctl = new AbortController();
    const mine = ++seq;
    try {
      const next = await api("GET", url + siteId + "/preview", undefined, ctl.signal);
      if (mine !== seq) return;
      data = next;
      loadNote = "";
    } catch (e) {
      if ((e && e.name === "AbortError") || mine !== seq) return;
      data = null;
      loadNote = e && e.status === 404 ? REFUSALS.not_found : PREVIEW_UNAVAILABLE;
    }
    render();
    schedule();
  }

  async function ask() {
    if (busy || !data) return;
    const cap = data.model_cap_usd;
    if (!(await confirmAction(confirmSentence(cap)))) return;
    busy = true;
    note = "";
    render();
    try {
      // The number sent is the cap the person just saw; the server refuses anything but its own cap.
      await api("POST", url + siteId + "/preview", { confirm_model_cap_usd: cap });
      note = "Preview requested.";
    } catch (e) {
      note = refusalSentence(e);
    }
    busy = false;
    await load();
  }

  return {
    // Reads again only when the site changes; the app calls this after every report read.
    show(id, isAdmin) {
      admin = isAdmin === true;
      if (id !== siteId) {
        siteId = id;
        data = null;
        note = "";
        loadNote = "";
        load();
      }
      render();
    },
    destroy() {
      closed = true;
      stopTimer();
      seq++;
      if (ctl) ctl.abort();
      host.replaceChildren();
    },
  };
}
