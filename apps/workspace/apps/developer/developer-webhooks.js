// D#37 WS-F7b: the Developer app's webhooks tab. Add an endpoint (an HTTPS URL
// and events from the v1 catalogue, the signing secret revealed once), read an
// endpoint's delivery log with Redeliver and Send test event, rotate the
// secret (24 h overlap), and re-enable an endpoint the server switched off.
//
// Rules this file keeps (D#37 WS-F7b, corrections C2, C25 and C26):
//   * Every node is built with h() (createElement / createTextNode), so an
//     endpoint URL renders as literal text: no link, no markup, no Trusted
//     Types sink. A URL is always shown inside <bdi>, and inside a string
//     (a confirm message, the status line) between FSI and PDI.
//   * The signing secret lives in one closure variable while the reveal panel
//     is open. Its node carries data-secret-node, so the shell's preview
//     masks apply and Done sweeps every copy. It is never written to web
//     storage, the address bar, a data attribute or an input value.
//   * The delivery log shows time, event, status, code, error class and
//     attempts. The API returns no response body and this file never asks
//     for one.
//   * Every mutation carries Content-Type: application/json (api() in
//     ../_lib/api.js) and none names a duplicate-suppression header; every webhook route
//     rejects one. A server refusal is shown in the panel, never logged.
// This module adds one boot file. It imports the shared DOM and fetch helpers
// from ../_lib/, and the secret scrubber from developer-tokens.js.
import { h, timeNode, confirmAction } from "../_lib/dom.js";
import { api, ApiFailure, createRetryGate, isRateLimited, retryWords, waitSeconds } from "../_lib/api.js";
import { scrubSecretNodes } from "./developer-tokens.js";

const ENDPOINTS_URL = "/api/v1/webhook-endpoints";

// The v1 event catalogue (packages/webhooks payload.ts WEBHOOK_EVENT_TYPES).
const EVENTS = [
  { id: "pr.opened", help: "A pull request was opened." },
  { id: "pr.ready_to_merge", help: "A pull request is ready to merge." },
  { id: "merge_approval.decided", help: "A merge approval was decided." },
  { id: "work_item.needs_human", help: "A work item needs a person." },
  { id: "budget.exhausted", help: "A budget ran out." },
  { id: "model_connection.broken", help: "The model connection stopped working." },
  { id: "webhook_endpoint.disabled", help: "An endpoint was switched off after repeated failures." },
  { id: "endpoint.test", help: "The test event sent by Send test event." },
];

// The reason classes the API returns for a 422 invalid_webhook_url.
const URL_REASONS = {
  invalid_url: "That is not a valid URL.",
  scheme: "Only https:// URLs are accepted.",
  port: "That port is not allowed.",
  userinfo: "Remove the username and password from the URL.",
  url_too_long: "That URL is too long.",
  blocked_hostname: "That hostname cannot be used.",
  blocked_address: "That address is private or reserved, so it cannot be used.",
  dns_failed: "That hostname could not be resolved.",
};

const DISABLED_REASONS = {
  failing: "Switched off automatically: every recent delivery failed.",
};

// A URL can carry bidi controls. In a DOM node it goes in a <bdi>; inside a
// plain string it is wrapped in FSI ... PDI with any isolate controls of its
// own removed so it cannot close the isolate early.
const BIDI_ISOLATES = /[⁦-⁩]/g;
function isoUrl(u) {
  return "⁨" + String(u).replace(BIDI_ISOLATES, "") + "⁩";
}
function urlNode(u) {
  return h("bdi", { class: "dev-url" }, String(u));
}

export function mountWebhooks(host) {
  const abort = new AbortController();
  const state = {
    view: "list", // list | add | detail | reveal
    endpoints: [],
    nextCursor: null,
    loading: true,
    loadError: null,
    forbidden: false,
    blocked: null, // { text } once the server says adding cannot work
    loadingMore: false,
    selected: null, // the endpoint shown in the detail view
    deliveries: [],
    deliveriesCursor: null,
    deliveriesLoading: false,
    deliveriesError: null,
    busy: false,
  };
  let secret = null; // { value, url, previousExpiresAt, back } while the reveal panel is open
  let focusSel = null;
  let generation = 0;
  let deliveriesGeneration = 0;
  let destroyed = false;

  const root = h("div", { class: "dev-app", "data-testid": "dev-wh-app" });
  const statusEl = h("div", { class: "dev-status", role: "status", "aria-live": "polite", "data-testid": "dev-wh-status" });
  const viewHost = h("div", { class: "dev-view" });
  root.append(statusEl, viewHost);
  host.replaceChildren(root);

  function paintStatus(text, kind) {
    statusEl.textContent = text || "";
    statusEl.className = "dev-status" + (text ? " dev-status-on" : "") + (kind === "error" ? " dev-status-error" : "");
  }
  // Any message other than the countdown takes the status line over; the countdown then stops repainting it.
  let waitOwnsStatus = false;
  function setStatus(text, kind) {
    waitOwnsStatus = false;
    paintStatus(text, kind);
  }

  // The wait after a 429 on Send test event: "Try again in N seconds", with that button off until it ends.
  const waiting = () => gate.remaining > 0;
  let announced = false;
  const gate = createRetryGate({
    onChange(remaining) {
      if (destroyed) return;
      if (waitOwnsStatus) {
        // Announce the wait once; the per-second repaints stay out of the screen reader's live region.
        statusEl.setAttribute("aria-live", announced ? "off" : "polite");
        announced = true;
        paintStatus(remaining > 0 ? "Could not send the test event. Too many tries. " + retryWords(remaining) : "", remaining > 0 ? "error" : undefined);
        if (remaining === 0) {
          statusEl.setAttribute("aria-live", "polite");
          waitOwnsStatus = false;
        }
      }
      // Only the test button changes on a tick, so the view is not rebuilt and focus stays put.
      for (const el of root.querySelectorAll('[data-testid="dev-wh-test"]')) el.disabled = state.busy || waiting();
    },
  });

  function render() {
    if (destroyed) return;
    let view;
    if (state.view === "add") view = addView();
    else if (state.view === "reveal") view = revealView();
    else if (state.view === "detail") view = detailView();
    else view = listView();
    viewHost.replaceChildren(view);
    if (focusSel) {
      const target = root.querySelector(focusSel);
      if (target) target.focus();
      focusSel = null;
    }
  }

  function button(label, opts) {
    const o = opts || {};
    return h(
      "button",
      {
        type: "button",
        class: "dev-btn" + (o.primary ? " dev-btn-primary" : "") + (o.danger ? " dev-btn-danger" : ""),
        disabled: !!o.disabled,
        id: o.id,
        "aria-label": o.ariaLabel,
        "data-testid": o.testid,
        onClick: o.onClick,
      },
      label
    );
  }

  function failureText(e) {
    if (!(e instanceof ApiFailure)) return "unexpected error.";
    if (e.status === 0) return e.message;
    return e.message + " (" + e.code + ")";
  }

  // ── data ──────────────────────────────────────────────────────────────

  async function loadFirstPage() {
    const mine = ++generation;
    state.loading = true;
    state.loadError = null;
    render();
    try {
      const page = await api("GET", ENDPOINTS_URL, undefined, abort.signal);
      if (mine !== generation || destroyed) return;
      state.endpoints = Array.isArray(page && page.data) ? page.data : [];
      state.nextCursor = page && typeof page.next_cursor === "string" ? page.next_cursor : null;
      state.forbidden = false;
    } catch (e) {
      if (mine !== generation || destroyed || (e && e.name === "AbortError")) return;
      state.endpoints = [];
      state.nextCursor = null;
      if (e instanceof ApiFailure && e.status === 403) state.forbidden = true;
      else state.loadError = e instanceof ApiFailure ? e.message : "The webhook endpoints could not be loaded.";
    }
    state.loading = false;
    render();
  }

  async function loadMore() {
    if (!state.nextCursor || state.loadingMore) return;
    state.loadingMore = true;
    render();
    try {
      const page = await api("GET", ENDPOINTS_URL + "?cursor=" + encodeURIComponent(state.nextCursor), undefined, abort.signal);
      if (destroyed) return;
      state.endpoints = state.endpoints.concat(Array.isArray(page && page.data) ? page.data : []);
      state.nextCursor = page && typeof page.next_cursor === "string" ? page.next_cursor : null;
    } catch (e) {
      if (destroyed || (e && e.name === "AbortError")) return;
      setStatus("More endpoints could not be loaded.", "error");
    }
    state.loadingMore = false;
    render();
  }

  async function loadDeliveries(more) {
    if (!state.selected) return;
    if (more && (!state.deliveriesCursor || state.deliveriesLoading)) return;
    const mine = ++deliveriesGeneration;
    const base = ENDPOINTS_URL + "/" + encodeURIComponent(state.selected.id) + "/deliveries";
    state.deliveriesLoading = true;
    state.deliveriesError = null;
    if (!more) {
      state.deliveries = [];
      state.deliveriesCursor = null;
    }
    render();
    try {
      const url = more ? base + "?cursor=" + encodeURIComponent(state.deliveriesCursor) : base;
      const page = await api("GET", url, undefined, abort.signal);
      if (mine !== deliveriesGeneration || destroyed) return;
      const rows = Array.isArray(page && page.data) ? page.data : [];
      state.deliveries = more ? state.deliveries.concat(rows) : rows;
      state.deliveriesCursor = page && typeof page.next_cursor === "string" ? page.next_cursor : null;
    } catch (e) {
      if (mine !== deliveriesGeneration || destroyed || (e && e.name === "AbortError")) return;
      state.deliveriesError = e instanceof ApiFailure ? e.message : "The delivery log could not be loaded.";
    }
    state.deliveriesLoading = false;
    render();
  }

  // ── list ──────────────────────────────────────────────────────────────

  function listView() {
    const header = h(
      "header",
      { class: "dev-header", "data-testid": "dev-wh-list-header" },
      h(
        "div",
        { class: "dev-header-top" },
        h("h2", { class: "dev-title" }, "Webhook endpoints"),
        button("Add endpoint", {
          primary: true,
          id: "dev-wh-add-open",
          testid: "dev-wh-add-open",
          disabled: state.blocked !== null || state.forbidden,
          onClick: () => {
            state.view = "add";
            setStatus("");
            focusSel = "#dev-wh-url";
            render();
          },
        })
      )
    );
    const parts = [header];
    if (state.blocked) {
      parts.push(h("p", { class: "dev-banner", role: "note", "data-testid": "dev-wh-blocked" }, state.blocked.text));
    }
    parts.push(listBody());
    return h("section", { class: "dev-list", "data-testid": "dev-wh-list" }, parts);
  }

  function listBody() {
    if (state.loading) return h("p", { class: "dev-muted", "data-testid": "dev-wh-loading" }, "Loading endpoints...");
    if (state.forbidden) {
      return h(
        "p",
        { class: "dev-banner", role: "note", "data-testid": "dev-wh-forbidden" },
        "Webhook endpoints are managed by account owners and admins."
      );
    }
    if (state.loadError) {
      return h(
        "div",
        { class: "dev-empty", role: "alert", "data-testid": "dev-wh-load-error" },
        h("p", null, state.loadError),
        button("Try again", { onClick: loadFirstPage })
      );
    }
    if (state.endpoints.length === 0) {
      return h("p", { class: "dev-muted", "data-testid": "dev-wh-empty" }, "No webhook endpoints yet.");
    }
    const head = h(
      "thead",
      null,
      h("tr", null, ["URL", "Events", "Status", ""].map((c) => h("th", { scope: "col" }, c)))
    );
    const table = h("table", { class: "dev-table", "data-testid": "dev-wh-table" }, head, h("tbody", null, state.endpoints.map(endpointRow)));
    const more = state.nextCursor
      ? h(
          "div",
          { class: "dev-more" },
          button(state.loadingMore ? "Loading..." : "Load more", {
            disabled: state.loadingMore,
            testid: "dev-wh-load-more",
            onClick: loadMore,
          })
        )
      : null;
    return h("div", { class: "dev-table-wrap" }, table, more);
  }

  function cell(label, ...kids) {
    return h("td", { "data-label": label }, ...kids);
  }

  function statusCell(ep) {
    if (ep.status !== "disabled") return h("span", { "data-testid": "dev-wh-state" }, "Active");
    return h(
      "span",
      { class: "dev-disabled" },
      h("span", { "data-testid": "dev-wh-state" }, "Disabled"),
      ep.disabled_reason ? h("span", { class: "dev-muted dev-help", "data-testid": "dev-wh-reason" }, reasonText(ep.disabled_reason)) : null
    );
  }

  function reasonText(code) {
    return DISABLED_REASONS[code] || "Switched off (" + String(code) + ").";
  }

  function eventChips(ep) {
    return h(
      "span",
      { class: "dev-chips" },
      (Array.isArray(ep.event_types) ? ep.event_types : []).map((t) => h("span", { class: "dev-chip" }, t))
    );
  }

  function endpointRow(ep) {
    return h(
      "tr",
      { "data-endpoint-id": ep.id, "data-status": ep.status },
      cell("URL", h("span", { class: "dev-name", "data-testid": "dev-wh-url" }, urlNode(ep.url))),
      cell("Events", eventChips(ep)),
      cell("Status", statusCell(ep)),
      cell(
        "",
        h(
          "span",
          { class: "dev-row-actions" },
          ep.status === "disabled"
            ? button("Re-enable", {
                ariaLabel: "Re-enable " + isoUrl(ep.url),
                testid: "dev-wh-reenable",
                disabled: state.busy,
                onClick: () => reenable(ep),
              })
            : null,
          button("Manage", {
            ariaLabel: "Manage " + isoUrl(ep.url),
            testid: "dev-wh-manage",
            onClick: () => openDetail(ep),
          })
        )
      )
    );
  }

  // ── detail: delivery log, test event, rotate, re-enable ───────────────

  function openDetail(ep) {
    state.selected = ep;
    state.view = "detail";
    setStatus("");
    focusSel = "#dev-wh-back";
    loadDeliveries(false);
  }

  function detailView() {
    const ep = state.selected;
    const disabled = ep.status === "disabled";
    const top = h(
      "header",
      { class: "dev-header" },
      h(
        "div",
        { class: "dev-header-top" },
        h("h2", { class: "dev-title" }, "Endpoint"),
        button("Back to endpoints", {
          id: "dev-wh-back",
          testid: "dev-wh-back",
          onClick: () => {
            state.view = "list";
            state.selected = null;
            deliveriesGeneration++;
            setStatus("");
            focusSel = "#dev-wh-add-open";
            render();
          },
        })
      ),
      h("p", { class: "dev-name", "data-testid": "dev-wh-detail-url" }, urlNode(ep.url)),
      h("div", { class: "dev-chips" }, (ep.event_types || []).map((t) => h("span", { class: "dev-chip" }, t))),
      h("div", { "data-testid": "dev-wh-detail-state" }, statusCell(ep)),
      h(
        "div",
        { class: "dev-bulk", role: "group", "aria-label": "Endpoint actions" },
        disabled
          ? button("Re-enable", { primary: true, testid: "dev-wh-reenable", disabled: state.busy, onClick: () => reenable(ep) })
          : null,
        button("Send test event", { testid: "dev-wh-test", disabled: state.busy || disabled || waiting(), onClick: () => sendTest(ep) }),
        button("Rotate secret", { danger: true, testid: "dev-wh-rotate", disabled: state.busy, onClick: () => rotate(ep) })
      ),
      h(
        "p",
        { class: "dev-muted dev-help", "data-testid": "dev-wh-rotate-note" },
        "Rotating creates a new signing secret. The old secret keeps signing for 24 hours after the rotation, so you can update your receiver without dropping events."
      )
    );
    return h("section", { class: "dev-list", "data-testid": "dev-wh-detail" }, top, h("h3", { class: "dev-subtitle" }, "Delivery log"), deliveryBody());
  }

  function deliveryBody() {
    if (state.deliveriesLoading && state.deliveries.length === 0) {
      return h("p", { class: "dev-muted", "data-testid": "dev-wh-log-loading" }, "Loading deliveries...");
    }
    if (state.deliveriesError) {
      return h(
        "div",
        { class: "dev-empty", role: "alert", "data-testid": "dev-wh-log-error" },
        h("p", null, state.deliveriesError),
        button("Try again", { onClick: () => loadDeliveries(false) })
      );
    }
    if (state.deliveries.length === 0) {
      return h("p", { class: "dev-muted", "data-testid": "dev-wh-log-empty" }, "No deliveries yet.");
    }
    const head = h(
      "thead",
      null,
      h(
        "tr",
        null,
        ["Time", "Event", "Status", "Code", "Error class", "Attempts", ""].map((c) => h("th", { scope: "col" }, c))
      )
    );
    const table = h("table", { class: "dev-table", "data-testid": "dev-wh-log" }, head, h("tbody", null, state.deliveries.map(deliveryRow)));
    const more = state.deliveriesCursor
      ? h(
          "div",
          { class: "dev-more" },
          button(state.deliveriesLoading ? "Loading..." : "Load more", {
            disabled: state.deliveriesLoading,
            testid: "dev-wh-log-more",
            onClick: () => loadDeliveries(true),
          })
        )
      : null;
    return h("div", { class: "dev-table-wrap" }, table, more);
  }

  function deliveryRow(d) {
    const inFlight = d.status === "pending" || d.status === "claimed";
    return h(
      "tr",
      { "data-delivery-id": d.id, "data-status": d.status },
      cell("Time", timeNode(d.created_at, true)),
      cell("Event", h("span", { class: "dev-chip" }, d.event_type)),
      cell("Status", d.status),
      cell("Code", d.last_status_code == null ? h("span", { class: "dev-muted" }, "-") : String(d.last_status_code)),
      cell("Error class", d.last_error_class ? h("code", null, d.last_error_class) : h("span", { class: "dev-muted" }, "-")),
      cell("Attempts", String(d.attempt_count)),
      cell(
        "",
        button("Redeliver", {
          ariaLabel: "Redeliver " + d.event_type + " sent " + d.created_at,
          testid: "dev-wh-redeliver",
          disabled: state.busy || inFlight,
          onClick: () => redeliver(d),
        })
      )
    );
  }

  // ── actions ───────────────────────────────────────────────────────────

  async function redeliver(d) {
    if (state.busy) return;
    state.busy = true;
    render();
    try {
      await api("POST", ENDPOINTS_URL + "/deliveries/" + encodeURIComponent(d.id) + "/redeliver", undefined, abort.signal);
      setStatus("Queued for redelivery. The log updates when the next attempt is made.");
    } catch (e) {
      if (destroyed || (e && e.name === "AbortError")) return;
      if (e instanceof ApiFailure && e.status === 404) setStatus("That delivery no longer exists.", "error");
      else setStatus("Could not queue the redelivery: " + failureText(e), "error");
    }
    state.busy = false;
    await loadDeliveries(false);
  }

  async function sendTest(ep) {
    if (state.busy || waiting()) return;
    state.busy = true;
    setStatus("");
    render();
    try {
      const out = await api("POST", ENDPOINTS_URL + "/" + encodeURIComponent(ep.id) + "/test", undefined, abort.signal);
      if (out && out.delivered === true) {
        setStatus("Test event delivered" + (Number.isInteger(out.status_code) ? " (HTTP " + out.status_code + ")." : "."));
      } else {
        const parts = [];
        if (out && out.error_class) parts.push(String(out.error_class));
        if (out && Number.isInteger(out.status_code)) parts.push("HTTP " + out.status_code);
        setStatus("Test event failed" + (parts.length ? " (" + parts.join(", ") + ")." : "."), "error");
      }
    } catch (e) {
      if (destroyed || (e && e.name === "AbortError")) return;
      if (isRateLimited(e)) {
        announced = false;
        waitOwnsStatus = true;
        gate.start(waitSeconds(e));
      } else {
        setStatus("Could not send the test event: " + failureText(e), "error");
      }
    }
    state.busy = false;
    await loadDeliveries(false);
  }

  async function rotate(ep) {
    if (state.busy) return;
    const ok = await confirmAction(
      "Rotate the signing secret for " +
        isoUrl(ep.url) +
        "? A new secret is created and shown once. The old secret keeps signing for 24 hours, then stops. Update your receiver within that time."
    );
    if (!ok || destroyed) return;
    state.busy = true;
    setStatus("");
    render();
    try {
      const out = await api("POST", ENDPOINTS_URL + "/" + encodeURIComponent(ep.id) + "/rotate-secret", undefined, abort.signal);
      if (destroyed) return;
      secret = {
        value: out.secret,
        url: ep.url,
        previousExpiresAt: typeof out.previous_secret_expires_at === "string" ? out.previous_secret_expires_at : null,
        rotated: true,
      };
      state.busy = false;
      state.view = "reveal";
      focusSel = "#dev-wh-secret";
      render();
      return;
    } catch (e) {
      if (destroyed || (e && e.name === "AbortError")) return;
      setStatus("Could not rotate the secret: " + failureText(e), "error");
    }
    state.busy = false;
    render();
  }

  async function reenable(ep) {
    if (state.busy) return;
    state.busy = true;
    setStatus("");
    render();
    try {
      const out = await api("PATCH", ENDPOINTS_URL + "/" + encodeURIComponent(ep.id), { status: "active" }, abort.signal);
      if (destroyed) return;
      if (out && out.id) {
        state.endpoints = state.endpoints.map((x) => (x.id === out.id ? out : x));
        if (state.selected && state.selected.id === out.id) state.selected = out;
      }
      setStatus("Endpoint re-enabled.");
    } catch (e) {
      if (destroyed || (e && e.name === "AbortError")) return;
      if (e instanceof ApiFailure && e.status === 404) setStatus("That endpoint no longer exists.", "error");
      else setStatus("Could not re-enable the endpoint: " + failureText(e), "error");
    }
    state.busy = false;
    render();
  }

  // ── add ───────────────────────────────────────────────────────────────

  function addView() {
    const urlInput = h("input", {
      id: "dev-wh-url",
      type: "text",
      class: "dev-input dev-input-wide",
      inputmode: "url",
      autocomplete: "off",
      autocapitalize: "off",
      spellcheck: false,
      placeholder: "https://example.com/hooks/fulcrumaxe",
      "aria-describedby": "dev-wh-url-help dev-wh-url-error",
    });
    const urlError = h("p", { id: "dev-wh-url-error", class: "dev-field-error", role: "alert", "data-testid": "dev-wh-url-error" });
    const formError = h("p", { class: "dev-field-error", role: "alert", "data-testid": "dev-wh-form-error" });
    if (state.blocked) formError.textContent = state.blocked.text;

    const boxes = EVENTS.map((ev) =>
      h("input", { type: "checkbox", id: "dev-wh-ev-" + ev.id.replace(/[^a-z]/g, "-"), value: ev.id })
    );
    const eventItems = EVENTS.map((ev, i) =>
      h(
        "label",
        { class: "dev-scope", for: boxes[i].id },
        boxes[i],
        h("span", { class: "dev-scope-text" }, h("span", { class: "dev-scope-id" }, ev.id), h("span", { class: "dev-muted" }, ev.help))
      )
    );

    const submit = h(
      "button",
      { type: "submit", class: "dev-btn dev-btn-primary", "data-testid": "dev-wh-add-submit", disabled: true },
      "Add endpoint"
    );
    const chosen = () => boxes.filter((b) => b.checked).map((b) => b.value);
    function syncSubmit() {
      submit.disabled = state.blocked !== null || state.busy || chosen().length === 0 || urlInput.value.trim() === "";
    }
    boxes.forEach((b) => b.addEventListener("change", syncSubmit));
    urlInput.addEventListener("input", syncSubmit);

    const form = h(
      "form",
      { class: "dev-form", novalidate: true, "data-testid": "dev-wh-add-form" },
      h(
        "div",
        { class: "dev-field" },
        h("label", { for: "dev-wh-url" }, "Endpoint URL"),
        urlInput,
        h("p", { id: "dev-wh-url-help", class: "dev-muted dev-help" }, "An https:// address that can receive POST requests."),
        urlError
      ),
      h(
        "fieldset",
        { class: "dev-field dev-fieldset" },
        h("legend", null, "Events"),
        h("p", { class: "dev-muted dev-help" }, "Choose at least one."),
        eventItems
      ),
      formError,
      h(
        "div",
        { class: "dev-actions" },
        submit,
        button("Cancel", {
          testid: "dev-wh-add-cancel",
          onClick: () => {
            state.view = "list";
            focusSel = "#dev-wh-add-open";
            render();
          },
        })
      )
    );

    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      if (state.busy || state.blocked) return;
      const events = chosen();
      const url = urlInput.value.trim();
      if (events.length === 0 || url === "") return;
      state.busy = true;
      submit.disabled = true;
      urlError.textContent = "";
      formError.textContent = "";
      try {
        const out = await api("POST", ENDPOINTS_URL, { url, event_types: events }, abort.signal);
        if (destroyed) return;
        secret = { value: out.secret, url: out.url, previousExpiresAt: null, rotated: false };
        state.busy = false;
        state.view = "reveal";
        focusSel = "#dev-wh-secret";
        render();
      } catch (e) {
        if (destroyed || (e && e.name === "AbortError")) return;
        state.busy = false;
        showAddError(e, urlInput, urlError, formError);
        syncSubmit();
      }
    });

    return h(
      "section",
      { class: "dev-panel", "data-testid": "dev-wh-add" },
      h("h2", { class: "dev-title" }, "Add a webhook endpoint"),
      form
    );
  }

  function showAddError(e, urlInput, urlError, formError) {
    if (!(e instanceof ApiFailure)) {
      formError.textContent = "The endpoint could not be added.";
      return;
    }
    if (e.status === 422 && e.code === "invalid_webhook_url") {
      const d = Array.isArray(e.details) ? e.details.find((x) => x && x.path === "url") : null;
      const cls = d && typeof d.code === "string" ? d.code : null;
      const known = cls && Object.prototype.hasOwnProperty.call(URL_REASONS, cls) ? URL_REASONS[cls] : "That URL cannot be used.";
      urlError.textContent = known + (cls ? " (" + cls + ")" : "");
      urlInput.focus();
    } else if (e.status === 422) {
      formError.textContent = "The request was not valid: " + e.message + " (" + e.code + ")";
    } else if (e.status === 409 && e.code === "endpoint_limit_reached") {
      state.blocked = { text: "Your plan's webhook endpoint limit is reached. Remove an endpoint or upgrade to add another." };
      formError.textContent = state.blocked.text;
    } else if (e.status === 409) {
      state.blocked = { text: "Endpoints cannot be added while your account is not active. (" + e.code + ")" };
      formError.textContent = state.blocked.text;
    } else if (e.status === 403) {
      formError.textContent = "The server refused: " + e.message + " (" + e.code + ")";
    } else if (e.status === 401) {
      // See developer-tokens.js: the live client handles an ended session.
      formError.textContent = "Checking your session...";
    } else if (e.status === 0) {
      formError.textContent = "The request did not complete. Check the endpoint list before trying again, in case the endpoint was added.";
    } else {
      formError.textContent = "The endpoint could not be added: " + e.message + " (" + e.code + ")";
    }
  }

  // ── reveal ────────────────────────────────────────────────────────────

  function revealView() {
    const secretEl = h(
      "code",
      { id: "dev-wh-secret", class: "dev-secret", tabindex: "-1", "data-testid": "dev-wh-secret", "data-secret-node": "1" },
      secret.value
    );
    const copyNote = h("p", { class: "dev-muted dev-help", "aria-live": "polite", "data-testid": "dev-wh-copy-note" });
    const copy = button("Copy", {
      primary: true,
      testid: "dev-wh-copy",
      onClick: async () => {
        try {
          await navigator.clipboard.writeText(secret.value);
          copyNote.textContent = "Copied to the clipboard.";
        } catch {
          const range = document.createRange();
          range.selectNodeContents(secretEl);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          copyNote.textContent = "Copying was blocked, so the secret is selected. Copy it by hand.";
        }
      },
    });
    const done = button("Done", { testid: "dev-wh-reveal-done", onClick: closeReveal });
    const overlap = secret.rotated
      ? h(
          "p",
          { class: "dev-muted dev-help", "data-testid": "dev-wh-overlap" },
          "The old secret keeps signing for 24 hours",
          secret.previousExpiresAt ? [", until ", timeNode(secret.previousExpiresAt, true)] : null,
          ". Update your receiver to the new secret before then."
        )
      : null;
    return h(
      "section",
      { class: "dev-panel", role: "group", "aria-label": "Signing secret", "data-testid": "dev-wh-reveal" },
      h("h2", { class: "dev-title" }, secret.rotated ? "Secret rotated" : "Endpoint added"),
      h(
        "p",
        { class: "dev-warn", "data-testid": "dev-wh-reveal-warning" },
        "Copy this signing secret now. It is shown only once and cannot be looked up again. If you lose it, rotate the secret to get a new one."
      ),
      secretEl,
      h("div", { class: "dev-actions" }, copy, done),
      copyNote,
      overlap,
      h("p", { class: "dev-muted dev-help", "data-testid": "dev-wh-reveal-summary" }, urlNode(secret.url))
    );
  }

  function closeReveal() {
    const rotated = secret ? secret.rotated : false;
    secret = null;
    scrubSecretNodes();
    setStatus("");
    if (rotated && state.selected) {
      state.view = "detail";
      focusSel = "#dev-wh-back";
      render();
      loadDeliveries(false);
    } else {
      state.view = "list";
      focusSel = "#dev-wh-add-open";
      // Render first so the secret node leaves the DOM, then refresh the list.
      render();
      loadFirstPage();
    }
  }

  // ── start / stop ──────────────────────────────────────────────────────

  render();
  loadFirstPage();

  return {
    revealOpen() {
      return secret !== null;
    },
    // Live update (WS-LV2): re-fetch the endpoint list quietly and keep the
    // open detail view's endpoint current (an auto-disable shows there too).
    // The add form and the one-time secret view are never re-rendered.
    async refresh() {
      if (destroyed || state.busy) return;
      const mine = ++generation;
      try {
        const page = await api("GET", ENDPOINTS_URL, undefined, abort.signal);
        if (mine !== generation || destroyed || state.busy) return;
        state.endpoints = Array.isArray(page && page.data) ? page.data : [];
        state.nextCursor = page && typeof page.next_cursor === "string" ? page.next_cursor : null;
        state.forbidden = false;
        state.loading = false;
        state.loadError = null;
        const fresh = state.selected && state.endpoints.find((x) => x.id === state.selected.id);
        if (fresh) state.selected = fresh;
        if (state.view === "list" || state.view === "detail") render();
      } catch {
        // Keep what is on screen.
      }
    },
    destroy() {
      destroyed = true;
      gate.cancel();
      secret = null;
      scrubSecretNodes();
      abort.abort();
      root.replaceChildren();
    },
  };
}
