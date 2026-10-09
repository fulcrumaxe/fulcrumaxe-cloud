// D#37 WS-F6: the Budget & Billing app. Shows the plan, the three monthly budgets with
// spend against each, the plan list, the billing standing, and the "share public figures"
// switch; an owner or admin can change the model budget, and an owner can subscribe.
//
// Rules this file keeps (D#37 C19e / C21 / C28 / C31 / C39):
//   * Every number shown comes from the API (usage, budgets, account, the plan list). This
//     file adds, subtracts and compares none of them; it only formats them.
//   * Errors are this file's own fixed sentences. error.message is never displayed.
//   * There is no 401 branch: a lost session is the shell's business.
//   * The live client is the only source of updates: `budget.exhausted` re-reads usage,
//     `refresh` re-reads everything. No timer of its own. Both subscriptions end when the
//     shell hides the window and come back (with one re-read) when it is shown again.
//   * Owner-only and admin-only controls are not rendered for anyone else. The server's 403
//     stays the enforcement.
//   * Every node is built with the shared h(); nothing here parses markup.
import { on, onRefresh } from "../../core/cloud-live.js";
import { h } from "../_lib/dom.js";
import { api, ApiFailure, createRetryGate, isRateLimited, retryWords, waitSeconds } from "../_lib/api.js";

const USAGE = "/api/v1/usage";
const BUDGETS = "/api/v1/budgets";
const ACCOUNT = "/api/v1/account";
const SETTINGS = "/api/v1/account/settings";
const PLANS = "/api/plans";
const CHECKOUT = "/api/v1/billing/checkout-session";
const PORTAL = "/api/v1/billing/portal-session";
// Fixed relative paths: the server accepts only plain absolute paths on this app.
const BACK_PATH = "/";

const GENERIC = "That didn't work. Try again.";
const NETWORK = "The server could not be reached.";
const FORBIDDEN = "Only owners and admins can change this.";
const RATE_LIMITED = "Too many tries. ";
const BUDGET_RANGE = "Enter an amount from 1.00 to 100,000.00 with at most 2 decimals.";
const LOAD_FAILED = "Some of this page could not be loaded.";
// The plan data setting is missing on the server: not a load failure to retry, a state to show (D#536).
const PLANS_UNAVAILABLE = "Plans are unavailable right now.";

const STATUS_TEXT = {
  active: "Active",
  past_due: "Payment overdue",
  paused: "Paused",
  model_key_broken: "Model key broken",
  unsubscribed: "No subscription",
  cancelled: "Cancelled",
};
// D#69 B18: the reason text is keyed by the status the account read returns.
const STATUS_BANNER = {
  past_due: "A payment failed. The workspace stays open for a short grace period. Update the payment method to keep it open.",
  paused: "This account is paused. No new work starts until it is resumed.",
  model_key_broken: "The model key is broken. Replace it in the Model Key app to get work running again.",
};
const EXHAUSTED = "A budget is used up. Work that needs it is refused until the budget is raised or the month resets.";

const BUDGET_VIEWS = [
  ["model", "Model"],
  ["foreground_compute", "Foreground compute"],
  ["background_compute", "Background compute"],
];

/** Formatting only: 600 -> $600.00, 12.3456 -> $12.3456. */
function money(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "Unavailable";
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

function failureSentence(e) {
  if (!(e instanceof ApiFailure)) return GENERIC;
  if (e.status === 0) return NETWORK;
  if (e.status === 403) return FORBIDDEN;
  if (e.status === 429) return RATE_LIMITED + retryWords(waitSeconds(e));
  return GENERIC;
}

const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

/** "2026-10-01T00:00:00.000Z" -> "Oct 1, 2026" (UTC, so the day is the same for everyone); "" when it is not a date. */
function dateWords(iso) {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

const MODEL_NOT_SET = "Not set";
const RESERVED_WORDS = "Reserved is money held for work that is still running. It is released when that work finishes.";

function planLimits(p) {
  const parts = [p.repo_limit === null ? "Unlimited repos" : "Up to " + p.repo_limit + (p.repo_limit === 1 ? " repo" : " repos")];
  if (p.always_on_security_reviewer) parts.push("always-on security reviewer");
  if (p.priority_queue) parts.push("priority queue");
  return parts.join(", ");
}

export function mountBudgetBilling(host) {
  const abort = new AbortController();
  const state = {
    usage: undefined,
    budgets: undefined,
    account: undefined,
    plans: undefined,
    plansUnavailable: false,
    failed: {},
    isAdmin: false,
    busy: false,
    exhausted: false,
    dirty: false,
    modelError: "",
  };
  const gen = {};
  let destroyed = false;
  const uid = "bb" + Math.random().toString(36).slice(2, 8);

  // Focusable so a keyboard user can scroll it even when nothing inside is interactive (a member's view).
  const root = h("div", { class: "bb-app", role: "region", "aria-label": "Budget and billing", tabindex: "0", "data-testid": "bb-app" });
  const noticeEl = h("p", { class: "bb-notice", role: "status", "aria-live": "polite", "data-testid": "bb-notice" });
  const bannerHost = h("div", { "data-testid": "bb-banners" });
  // Live regions stay in the page and only their text changes, so a redraw never announces the same thing twice.
  const statusLive = h("div", { role: "status", "aria-live": "polite", "data-testid": "bb-status-live" });
  const exhaustedEl = h("p", { class: "bb-banner bb-banner-error", role: "alert", "data-testid": "bb-exhausted" });
  const loadErrText = document.createTextNode("");
  const loadErrEl = h(
    "p",
    { class: "bb-banner", role: "alert", "data-testid": "bb-load-error" },
    loadErrText,
    h("button", { type: "button", class: "bb-btn", "data-testid": "bb-retry", onClick: () => loadAll() }, "Try again")
  );
  const partnerEl = h("div", { class: "bb-muted", role: "status", "aria-live": "polite", "data-testid": "bb-partner" });
  const planHost = h("div");
  const usageHost = h("div");
  const modelHost = h("div");
  const plansHost = h("div");
  const shareHost = h("div");
  root.append(noticeEl, bannerHost, planHost, usageHost, modelHost, partnerEl, plansHost, shareHost);
  host.replaceChildren(root);

  function paintNotice(text, isError) {
    noticeEl.textContent = text || "";
    noticeEl.className = "bb-notice" + (text ? " bb-notice-on" : "") + (isError ? " bb-notice-error" : "");
  }
  // Any message other than the countdown takes the notice over; the countdown then stops repainting it.
  let waitOwnsNotice = false;
  function setNotice(text, isError) {
    waitOwnsNotice = false;
    paintNotice(text, isError);
  }

  // ── the wait after a 429 on Subscribe or Manage billing: "Try again in N seconds", those buttons off until it ends ──
  // The server's cap is per account and shared by both, so neither can succeed during the wait.
  const waiting = () => gate.remaining > 0;
  let announced = false;
  const gate = createRetryGate({
    onChange(remaining) {
      if (destroyed) return;
      if (waitOwnsNotice) {
        // Announce the wait once; the per-second repaints stay out of the screen reader's live region.
        noticeEl.setAttribute("aria-live", announced ? "off" : "polite");
        announced = true;
        paintNotice(remaining > 0 ? RATE_LIMITED + retryWords(remaining) : "", remaining > 0);
        if (remaining === 0) {
          noticeEl.setAttribute("aria-live", "polite");
          waitOwnsNotice = false;
        }
      }
      syncWaitControls();
    },
  });
  function startWait(e) {
    announced = false;
    waitOwnsNotice = true;
    gate.start(waitSeconds(e));
  }
  /** Only the two controls change on a tick, so the view is not rebuilt and focus stays where it is. */
  function syncWaitControls() {
    for (const el of root.querySelectorAll('[data-testid="bb-portal"], [data-testid="bb-resume"], [data-testid^="bb-subscribe-"], [data-testid^="bb-change-"]')) el.disabled = state.busy || waiting();
  }

  // ── data ──────────────────────────────────────────────────────────────

  async function read(key, path) {
    const mine = (gen[key] = (gen[key] || 0) + 1);
    try {
      const v = await api("GET", path, undefined, abort.signal);
      if (destroyed || mine !== gen[key]) return;
      state[key] = v;
      state.failed[key] = false;
      if (key === "plans") state.plansUnavailable = false;
    } catch (e) {
      if (destroyed || mine !== gen[key] || (e && e.name === "AbortError")) return;
      if (key === "plans" && e && e.code === "plan_data_unavailable") {
        state.plans = undefined;
        state.plansUnavailable = true;
        state.failed[key] = false;
        return;
      }
      state.failed[key] = true;
    }
  }

  async function loadRole() {
    try {
      const me = await api("GET", "/api/cloud/auth/me", undefined, abort.signal);
      if (!destroyed) state.isAdmin = !!(me && me.is_admin === true);
    } catch {
      state.isAdmin = false; // cosmetic only: the server's 403 stays authoritative
    }
    render();
  }

  const loadAll = () =>
    Promise.all([read("usage", USAGE), read("budgets", BUDGETS), read("account", ACCOUNT), read("plans", PLANS)]).then(render);
  const loadUsage = () => read("usage", USAGE).then(render);

  // ── actions ───────────────────────────────────────────────────────────

  async function run(fn, focusId) {
    if (state.busy) return;
    state.busy = true;
    render();
    try {
      await fn();
    } catch (e) {
      if (!destroyed && !(e && e.name === "AbortError")) setNotice(failureSentence(e), true);
    } finally {
      state.busy = false;
      render();
      // Only a save that failed returns to the field; a stale error must not pull focus off the switch or the portal button.
      const id = state.modelError && focusId === "bb-model-save" ? "bb-model-input" : focusId;
      const target = id && root.querySelector(`[data-testid="${id}"]`);
      if (target && !destroyed) target.focus();
    }
  }

  function goTo(url) {
    // Only Stripe's https links are followed.
    if (typeof url === "string" && url.startsWith("https://")) window.location.assign(url);
    else throw new ApiFailure(0, "bad_link", GENERIC);
  }

  function subscribePlan(id) {
    run(async () => {
      setNotice("");
      try {
        const res = await api("POST", CHECKOUT, { plan: id, success_path: BACK_PATH, cancel_path: BACK_PATH }, abort.signal);
        goTo(res && res.url);
      } catch (e) {
        if (isRateLimited(e)) {
          startWait(e);
        } else if (e instanceof ApiFailure && e.status === 409) {
          setNotice("This account already has a subscription. Use Manage billing to change it.", true);
        } else if (e instanceof ApiFailure && e.status === 403) {
          setNotice("Only the account owner can subscribe.", true);
        } else if (e && e.name !== "AbortError") {
          setNotice("Checkout couldn't be opened. Try again.", true);
        }
      }
    }, "bb-subscribe-" + id);
  }

  // `flow` is "change_plan" for a plan switch: the same portal, opened on its plan-change screen. Anything else is the portal home.
  function openPortal(flow, focusId) {
    run(async () => {
      setNotice("");
      try {
        const res = await api("POST", PORTAL, flow === "change_plan" ? { return_path: BACK_PATH, flow } : { return_path: BACK_PATH }, abort.signal);
        goTo(res && res.url);
      } catch (e) {
        if (isRateLimited(e)) startWait(e);
        else if (e instanceof ApiFailure && e.status === 403) setNotice("Only the account owner can open billing.", true);
        else if (e instanceof ApiFailure && e.status === 409) setNotice("This account has no billing account yet.", true);
        else if (e && e.name !== "AbortError") setNotice("The billing page couldn't be opened. Try again.", true);
      }
    }, focusId || "bb-portal");
  }

  function setShare(value) {
    run(async () => {
      setNotice("");
      const res = await api("PATCH", SETTINGS, { share_public_figures: value }, abort.signal);
      state.account = { ...state.account, share_public_figures: !!(res && res.share_public_figures) };
      setNotice(state.account.share_public_figures ? "Public figures are shared." : "Public figures are not shared.");
    }, "bb-share");
  }

  function saveModel(ev) {
    ev.preventDefault();
    if (state.busy) return;
    const raw = modelInput.value.trim();
    // The route's rules: 1.00 to 100000.00, at most two decimals.
    const n = /^\d{1,6}(\.\d{1,2})?$/.test(raw) ? Number(raw) : NaN;
    if (!(n >= 1 && n <= 100000)) {
      state.modelError = BUDGET_RANGE;
      render();
      modelInput.focus();
      return;
    }
    state.modelError = "";
    run(async () => {
      try {
        state.budgets = await api("PATCH", BUDGETS, { model_usd_month: n }, abort.signal);
        state.dirty = false;
        state.exhausted = false;
        setNotice("Model budget saved.");
        loadUsage();
      } catch (e) {
        if (e && e.name === "AbortError") throw e;
        if (e instanceof ApiFailure && e.status === 422) state.modelError = BUDGET_RANGE;
        else throw e;
      }
    }, "bb-model-save");
  }

  // ── the model budget form: built once, so a live refresh never disturbs what is typed ──

  const modelInput = h("input", {
    class: "bb-input",
    id: uid + "-model",
    type: "text",
    inputmode: "decimal",
    autocomplete: "off",
    "aria-describedby": uid + "-model-help " + uid + "-model-err",
    "data-testid": "bb-model-input",
    onInput: () => {
      state.dirty = true;
    },
  });
  const modelErr = h("p", { class: "bb-field-error", id: uid + "-model-err", role: "alert", "data-testid": "bb-model-error" });
  const modelSave = h("button", { type: "submit", class: "bb-btn bb-btn-primary", "data-testid": "bb-model-save" }, "Save budget");
  const modelForm = h(
    "form",
    { class: "bb-form", "data-testid": "bb-model-form", noValidate: true, onSubmit: saveModel },
    h("label", { class: "bb-label", for: uid + "-model" }, "Monthly model budget (USD)"),
    h("div", { class: "bb-inline" }, modelInput, modelSave),
    h("p", { class: "bb-muted", id: uid + "-model-help" }, "From 1.00 to 100,000.00, at most 2 decimals."),
    modelErr
  );

  // ── views ─────────────────────────────────────────────────────────────

  const row = (label, value, testid, title) =>
    h("div", { class: "bb-row" }, h("dt", { class: "bb-label", title: title || null }, label), h("dd", { class: "bb-value", "data-testid": testid }, value));

  const planOf = (id) => (state.plans && Array.isArray(state.plans.plans) ? state.plans.plans.find((p) => p.id === id) : undefined);
  const viewer = () => (state.plans && state.plans.viewer) || {};
  const partnerBilled = () => !!(state.account && state.account.partner_billed) || viewer().partner_billed === true;

  // Only the owner opens the billing portal (the server allows no one else); everyone else is pointed at the owner.
  const isOwner = () => viewer().is_owner === true;

  // An account holds a subscription to change when it is active or past due. A paused or key-broken account is
  // one only when a paid period was synced (those statuses are also set for accounts that never subscribed),
  // and an unsubscribed or cancelled one has nothing to change: it subscribes through Checkout.
  const subscribed = () => {
    const a = state.account;
    if (!a) return false;
    if (a.status === "active" || a.status === "past_due") return true;
    return (a.status === "paused" || a.status === "model_key_broken") && typeof a.current_period_end === "string";
  };
  const ending = () => subscribed() && !!state.account && state.account.cancel_at_period_end === true;
  const endsWords = () => {
    const d = dateWords(state.account && state.account.current_period_end);
    return d ? "Ends on " + d : "Ends at the end of the current period";
  };

  function portalButton() {
    if (!isOwner() || partnerBilled()) return null;
    return h(
      "button",
      { type: "button", class: "bb-btn", "data-testid": "bb-portal", disabled: state.busy || waiting(), onClick: () => openPortal() },
      "Manage billing"
    );
  }

  const statusText = h("p");
  const statusSlot = h("div");
  const statusBanner = h("div", { class: "bb-banner bb-banner-error", "data-testid": "bb-status-banner" }, statusText, statusSlot);
  const portalAsk = h("p", { "data-testid": "bb-portal-ask" }, "Ask an owner to manage billing.");

  const setText = (node, text) => {
    if (node.textContent !== text) node.textContent = text;
  };
  // Put exactly these nodes in this host, in order, touching only what differs, so a node that stays is never re-inserted.
  function reconcile(hostEl, nodes) {
    nodes.forEach((n, i) => {
      if (hostEl.children[i] !== n) hostEl.insertBefore(n, hostEl.children[i] || null);
    });
    while (hostEl.children.length > nodes.length) hostEl.lastElementChild.remove();
  }

  function syncBanners() {
    const a = state.account;
    const text = a && STATUS_BANNER[a.status];
    if (text) {
      setText(statusText, text);
      statusBanner.setAttribute("data-status", a.status);
      const control = partnerBilled() ? null : portalButton() || portalAsk;
      statusSlot.replaceChildren(...(control ? [control] : []));
    }
    reconcile(statusLive, text ? [statusBanner] : []);
    const nodes = [statusLive];
    if (state.exhausted) {
      setText(exhaustedEl, EXHAUSTED);
      nodes.push(exhaustedEl);
    }
    if (Object.values(state.failed).some(Boolean)) {
      if (loadErrText.data !== LOAD_FAILED + " ") loadErrText.data = LOAD_FAILED + " ";
      nodes.push(loadErrEl);
    }
    reconcile(bannerHost, nodes);
    setText(partnerEl, state.account && state.plans && Array.isArray(state.plans.plans) && partnerBilled() ? "A partner bills this account, so there is nothing to buy here." : "");
  }

  function planView() {
    const a = state.account;
    if (!a) return h("p", { class: "bb-muted", "data-testid": "bb-loading" }, "Loading...");
    const p = planOf(a.plan);
    const banner = STATUS_BANNER[a.status];
    return h(
      "section",
      { class: "bb-card", "aria-labelledby": uid + "-plan" },
      h("h3", { class: "bb-title", id: uid + "-plan" }, "Plan"),
      h(
        "dl",
        { class: "bb-facts" },
        row("Plan", p ? cap(p.id) + " (" + money(p.price_usd_month) + " / month)" : cap(a.plan), "bb-plan"),
        row("Status", h("span", { class: "bb-pill bb-pill-" + a.status }, STATUS_TEXT[a.status] || "Unknown"), "bb-status"),
        ending() ? row("Subscription", endsWords(), "bb-ends") : null
      ),
      ending() && isOwner() && !partnerBilled()
        ? h(
            "button",
            { type: "button", class: "bb-btn", "data-testid": "bb-resume", "aria-label": "Resume the subscription", disabled: state.busy || waiting(), onClick: () => openPortal(undefined, "bb-resume") },
            "Resume"
          )
        : null,
      banner ? null : portalButton()
    );
  }

  // A model budget of 0 means none is set (the column default), which is not "you may spend nothing".
  // H3b hook: when a default model budget is applied at account creation, limit_usd arrives non-zero and this
  // stays false; nothing else here needs to change.
  const modelBudgetUnset = () => !!state.usage && !!state.usage.model && state.usage.model.limit_usd === 0;
  const operatorModel = () => !!state.account && state.account.model_source === "operator_subscription";

  /** The line under an unset model budget, and (for an owner or admin on their own key) the way to set one. */
  function modelNotSet() {
    if (operatorModel()) {
      return h("p", { class: "bb-muted", "data-testid": "bb-model-unset" }, "No model budget is needed: runs on this account use the operator subscription.");
    }
    const words = "Runs that use your own model key need a budget before they can start.";
    return h(
      "div",
      { "data-testid": "bb-model-unset" },
      h("p", { class: "bb-muted" }, state.isAdmin ? words : words + " Ask an owner or admin to set one."),
      state.isAdmin
        ? h(
            "button",
            { type: "button", class: "bb-btn", "data-testid": "bb-model-set", disabled: state.busy, onClick: () => modelInput.focus() },
            "Set budget"
          )
        : null
    );
  }

  function budgetCard([key, title]) {
    const b = state.usage[key];
    const unset = key === "model" && modelBudgetUnset();
    const scaling = key === "background_compute" ? planOf((state.budgets && state.budgets.plan) || (state.account && state.account.plan)) : undefined;
    const bg = scaling && scaling.background_compute;
    return h(
      "section",
      { class: "bb-card", "data-testid": "bb-budget-" + key, "aria-labelledby": uid + "-" + key },
      h("h3", { class: "bb-title", id: uid + "-" + key }, title),
      h(
        "dl",
        { class: "bb-facts" },
        row("Spent", money(b.spent_usd), "bb-spent"),
        row("Reserved", money(b.reserved_usd), "bb-reserved", RESERVED_WORDS),
        row("Limit", unset ? MODEL_NOT_SET : money(b.limit_usd), "bb-limit")
      ),
      unset ? modelNotSet() : null,
      bg && bg.kind === "scaling"
        ? h(
            "p",
            { class: "bb-muted", "data-testid": "bb-scaling" },
            "The plan sets " + money(bg.base_usd_month) + " plus " + money(bg.per_repo_usd_month) + " per repo, up to " + money(bg.ceiling_usd_month) + ". The limit above is for your current repo count."
          )
        : null
    );
  }

  function usageView() {
    if (!state.usage) return state.failed.usage ? null : h("p", { class: "bb-muted" }, "Loading...");
    return h(
      "section",
      { "aria-labelledby": uid + "-usage" },
      h("h2", { class: "bb-heading", id: uid + "-usage" }, "This month"),
      h("p", { class: "bb-muted" }, "Month starting " + String(state.usage.period_start).slice(0, 10) + "."),
      h("p", { class: "bb-muted", "data-testid": "bb-reserved-note" }, RESERVED_WORDS),
      h("div", { class: "bb-grid" }, BUDGET_VIEWS.map(budgetCard)),
      // D#6 R2b-5b: what this month's runs on the person's own machine would have cost at API prices. Information, apart from the budgets.
      Number.isFinite(state.usage.own_plan_api_equivalent_usd) && state.usage.own_plan_api_equivalent_usd > 0
        ? h("p", { class: "bb-muted", "data-testid": "bb-own-plan" }, "On your own plan (API-equivalent): " + money(state.usage.own_plan_api_equivalent_usd))
        : null
    );
  }

  function modelView() {
    if (!state.budgets) return null;
    const set = state.budgets.model_usd_month;
    if (!state.isAdmin) {
      return h("p", { class: "bb-muted", "data-testid": "bb-model-readonly" }, "Monthly model budget: " + (set === 0 ? "Not set" : money(set)) + ". Only owners and admins can change it.");
    }
    if (!state.dirty) modelInput.value = set === 0 ? "" : String(set);
    modelErr.textContent = state.modelError;
    modelErr.hidden = !state.modelError;
    modelInput.setAttribute("aria-invalid", state.modelError ? "true" : "false");
    modelInput.disabled = modelSave.disabled = state.busy;
    return modelForm;
  }

  /** What a plan row offers its viewer. The one place that decides, so no state can show two answers. */
  function planAction(p, owner) {
    const a = state.account;
    if (!subscribed()) {
      return owner
        ? h(
            "button",
            { type: "button", class: "bb-btn", "data-testid": "bb-subscribe-" + p.id, "aria-label": "Subscribe to " + cap(p.id), disabled: state.busy || waiting(), onClick: () => subscribePlan(p.id) },
            "Subscribe"
          )
        : h("span", { class: "bb-muted", "data-testid": "bb-ask-" + p.id }, "Ask an owner");
    }
    // Subscribed: a second checkout is never offered (the server refuses it). Plan changes go through the billing portal.
    if (p.id === a.plan) {
      return h("span", { class: "bb-pill bb-pill-active", "data-testid": "bb-current-" + p.id }, "Current plan");
    }
    if (!owner) return null;
    if (ending()) return h("span", { class: "bb-muted", "data-testid": "bb-change-blocked-" + p.id }, "Resume to change plan");
    if (a.status === "past_due") return h("span", { class: "bb-muted", "data-testid": "bb-change-blocked-" + p.id }, "Update payment first");
    const cur = planOf(a.plan);
    const verb = cur && p.price_usd_month < cur.price_usd_month ? "Downgrade" : cur && p.price_usd_month > cur.price_usd_month ? "Upgrade" : "Change plan";
    return h(
      "button",
      { type: "button", class: "bb-btn", "data-testid": "bb-change-" + p.id, "aria-label": verb + " to " + cap(p.id), disabled: state.busy || waiting(), onClick: () => openPortal("change_plan", "bb-change-" + p.id) },
      verb
    );
  }

  function plansView() {
    if (state.plansUnavailable) {
      return h(
        "section",
        { "aria-labelledby": uid + "-plans" },
        h("h2", { class: "bb-heading", id: uid + "-plans" }, "Plans"),
        h("p", { class: "bb-muted", role: "status", "data-testid": "bb-plans-unavailable" }, PLANS_UNAVAILABLE)
      );
    }
    if (!state.plans || !Array.isArray(state.plans.plans) || !state.account) return null;
    if (partnerBilled()) return null; // the partner message lives in its own live region (partnerEl)
    const head = h("h2", { class: "bb-heading", id: uid + "-plans" }, "Plans");
    const owner = isOwner();
    return h(
      "section",
      { "aria-labelledby": uid + "-plans" },
      head,
      subscribed() && !owner ? h("p", { class: "bb-muted", "data-testid": "bb-plans-note" }, "Only an owner can change the plan.") : null,
      h(
        "ul",
        { class: "bb-plans", "data-testid": "bb-plans" },
        state.plans.plans.map((p) =>
          h(
            "li",
            { class: "bb-plan", "data-testid": "bb-plan-" + p.id },
            h("strong", null, cap(p.id)),
            h("span", null, money(p.price_usd_month) + " / month"),
            h("span", { class: "bb-muted" }, planLimits(p)),
            subscribed() && ending() && p.id === state.account.plan ? h("span", { class: "bb-muted", "data-testid": "bb-plan-ends" }, endsWords()) : null,
            planAction(p, owner)
          )
        )
      )
    );
  }

  function shareView() {
    if (!state.account) return null;
    const on_ = state.account.share_public_figures === true;
    return h(
      "section",
      { class: "bb-card", "aria-labelledby": uid + "-share" },
      h("h3", { class: "bb-title", id: uid + "-share" }, "Public figures"),
      state.isAdmin
        ? h(
            "label",
            { class: "bb-switch", for: uid + "-share-input" },
            h("input", {
              type: "checkbox",
              id: uid + "-share-input",
              "data-testid": "bb-share",
              checked: on_,
              disabled: state.busy,
              onChange: (ev) => setShare(ev.target.checked),
            }),
            " Share public figures"
          )
        : h("p", { "data-testid": "bb-share-state" }, "Share public figures: " + (on_ ? "On" : "Off") + ". Only owners and admins can change this."),
      h("p", { class: "bb-muted" }, "Off by default. When on, this account's public figures may be shown publicly.")
    );
  }

  // Replacing a node with itself would drop focus and whatever is being typed, so a host keeps its node.
  const put = (hostEl, node) => {
    if (node && hostEl.firstChild === node && hostEl.childNodes.length === 1) return;
    hostEl.replaceChildren(...(node ? [node] : []));
  };

  function render() {
    if (destroyed) return;
    // A redraw must not take the keyboard away from the control that has it.
    const active = document.activeElement;
    const focusId = active && root.contains(active) ? active.getAttribute("data-testid") : null;
    syncBanners();
    put(planHost, planView());
    put(usageHost, usageView());
    put(modelHost, modelView());
    put(plansHost, plansView());
    put(shareHost, shareView());
    if (focusId && document.activeElement !== active) {
      const target = root.querySelector(`[data-testid="${focusId}"]`);
      if (target && !target.disabled) target.focus();
    }
  }

  // ── live: the shell's client is the only source of updates ──────────────
  let subs = [];
  function subscribe() {
    if (subs.length || destroyed) return;
    subs = [
      on("budget.exhausted", () => {
        state.exhausted = true;
        render();
        loadUsage();
      }),
      onRefresh(loadAll),
    ];
  }
  function unsubscribe() {
    for (const off of subs) off();
    subs = [];
  }

  render();
  loadAll();
  loadRole();
  subscribe();

  return {
    // The shell hid the window: stop listening. Shown again: listen, and read once for what was missed.
    pause: unsubscribe,
    resume() {
      if (destroyed) return;
      subscribe();
      loadAll();
    },
    destroy() {
      destroyed = true;
      gate.cancel();
      abort.abort();
      unsubscribe();
      host.replaceChildren();
    },
  };
}

let current = null;
const FULC = window.FULC;
if (!FULC || typeof FULC.register !== "function") {
  throw new Error("Budget & Billing app: the FULC SDK global is missing");
}
FULC.register({
  id: "budget-billing",
  title: "Budget & Billing",
  icon: "$",
  defaultSize: { w: 760, h: 620 },
  onOpen({ contentEl }) {
    if (current) current.destroy();
    current = mountBudgetBilling(contentEl);
  },
  onHide() {
    if (current) current.pause();
  },
  onShow() {
    if (current) current.resume();
  },
  onClose() {
    if (current) current.destroy();
    current = null;
  },
});
