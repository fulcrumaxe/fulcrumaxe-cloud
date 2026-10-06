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
