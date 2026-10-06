// D#37 WS-F7a: API tokens, create / reveal once / list / revoke, plus the
// two bulk actions that sit beside each other in the list header ("Revoke all
// my tokens" and "Sign out everywhere", correction C24 section 3).
//
// Rules this file keeps (D#37 WS-F7a, corrections C2, C24 and C25):
//   * Every node is built with createElement / createTextNode through the shared
//     h() (apps/_lib/dom.js); nothing here parses markup, so a token name renders as
//     literal text and no Trusted Types sink is used.
//   * The secret lives in one closure variable, only while the reveal panel is
//     open. It is never written to web storage, the URL, a data attribute or
//     an input value, and Done (or closing the window) drops it and its node.
//   * Every mutation carries Content-Type: application/json (the server
//     rejects a cookie mutation without it, csrf_rejected) even when it has no
//     body. No request sets Origin, Sec-Fetch-* or Idempotency-Key.
//   * A server refusal is shown in the panel that caused it. The app never
//     logs an expected refusal to the console.
import { signOut } from "../../core/cloud-signout.js";
import { h, timeNode, confirmAction } from "../_lib/dom.js";
import { api, ApiFailure } from "../_lib/api.js";

const TOKENS_URL = "/api/v1/tokens";
const NAME_MAX = 64;
const DEFAULT_EXPIRY_DAYS = 90;
// 365 is the API's ceiling and there is deliberately no "never" choice.
const EXPIRY_CHOICES = [7, 30, 90, 180, 365];

// The v1 scopes, in the order they are offered. audit:read and work_items:write are owner/admin only.
const SCOPES = [
  { id: "read", help: "Read runs, work items and account data.", adminOnly: false, preset: true },
  { id: "runs:cancel", help: "Cancel runs that are in progress.", adminOnly: false, preset: false },
  { id: "audit:read", help: "Read the audit log. Owners and admins only.", adminOnly: true, preset: false },
  { id: "discussions:write", help: "Create and edit discussions and comments.", adminOnly: false, preset: false },
  { id: "work_items:write", help: "Reorder work and set priorities. Owners and admins only.", adminOnly: true, preset: false },
];

let uid = 0;

// A name can carry RLM/RTL or embedded bidi controls. In a DOM node it goes in
// a <bdi> (bidiName); inside a plain string (a confirm message, the status
// line) it is wrapped in FSI ... PDI, with any isolate controls of its own
// removed so it cannot close the isolate early.
const BIDI_ISOLATES = /[\u2066-\u2069]/g;
function isoLabel(t) {
  if (!t.name) return "Unnamed token";
  return "\u2068" + String(t.name).replace(BIDI_ISOLATES, "") + "\u2069";
}
function bidiName(t) {
  return t.name ? h("bdi", null, t.name) : "Unnamed token";
}

function statusOf(t) {
  if (t.revoked_at) return "revoked";
  if (Date.parse(t.expires_at) <= Date.now()) return "expired";
  return "active";
}

function creatorNode(t) {
  if (t.created_by_me === true) return h("span", null, "You");
  // The list's created_by is a raw user id and /me returns a different opaque
  // id, so the UI never compares them (correction C25 section 2a).
  return h("span", { title: t.created_by }, "Member " + String(t.created_by).slice(0, 8));
}

// The shell clones a window's DOM for the dock hover preview and the alt-tab
// strip. A clone made while the reveal panel is open would keep the token in a
// hidden node after the panel closes, so every node that shows the secret is
// marked, and all of them (this document-wide, clones included) are removed
// when the panel closes.
export function scrubSecretNodes() {
  document.querySelectorAll("[data-secret-node]").forEach((n) => {
    n.textContent = "";
    n.remove();
  });
}

export function mountTokens(host) {
  const abort = new AbortController();
  const state = {
    view: "list",
    tokens: [],
    nextCursor: null,
    loading: true,
    loadError: null,
    loadingMore: false,
    isAdmin: false,
    blocked: null, // { text } once the server says creating cannot work
    busy: false,
  };
  let secret = null; // { token, name, scopes, expires_at, display_hint } while the reveal panel is open
  let focusSel = null;
  let generation = 0;
  let destroyed = false;

  const root = h("div", { class: "dev-app", "data-testid": "dev-app" });
  const statusEl = h("div", { class: "dev-status", role: "status", "aria-live": "polite", "data-testid": "dev-status" });
  const viewHost = h("div", { class: "dev-view" });
  root.append(statusEl, viewHost);
  host.replaceChildren(root);

  function setStatus(text, kind) {
    statusEl.textContent = text || "";
    statusEl.className = "dev-status" + (text ? " dev-status-on" : "") + (kind === "error" ? " dev-status-error" : "");
  }

  function render() {
    if (destroyed) return;
    let view;
    if (state.view === "create") view = createView();
    else if (state.view === "reveal") view = revealView();
    else view = listView();
    viewHost.replaceChildren(view);
    if (focusSel) {
      const target = root.querySelector(focusSel);
      if (target) target.focus();
      focusSel = null;
    }
  }

  // ── data ──────────────────────────────────────────────────────────────

  async function loadFirstPage() {
    const mine = ++generation;
    state.loading = true;
    state.loadError = null;
    render();
    try {
      const page = await api("GET", TOKENS_URL, undefined, abort.signal);
      if (mine !== generation || destroyed) return;
      state.tokens = Array.isArray(page && page.data) ? page.data : [];
      state.nextCursor = page && typeof page.next_cursor === "string" ? page.next_cursor : null;
    } catch (e) {
      if (mine !== generation || destroyed || (e && e.name === "AbortError")) return;
      state.loadError = e instanceof ApiFailure ? e.message : "The token list could not be loaded.";
      state.tokens = [];
      state.nextCursor = null;
    }
    state.loading = false;
    render();
  }

  async function loadMore() {
    if (!state.nextCursor || state.loadingMore) return;
    state.loadingMore = true;
    render();
    try {
      const page = await api("GET", TOKENS_URL + "?cursor=" + encodeURIComponent(state.nextCursor), undefined, abort.signal);
      if (destroyed) return;
      state.tokens = state.tokens.concat(Array.isArray(page && page.data) ? page.data : []);
      state.nextCursor = page && typeof page.next_cursor === "string" ? page.next_cursor : null;
    } catch (e) {
      if (destroyed || (e && e.name === "AbortError")) return;
      setStatus("More tokens could not be loaded.", "error");
    }
    state.loadingMore = false;
    render();
  }

  async function loadIdentity() {
    try {
      const me = await api("GET", "/api/cloud/auth/me", undefined, abort.signal);
      if (destroyed) return;
      state.isAdmin = !!(me && me.is_admin === true);
    } catch {
      state.isAdmin = false;
    }
  }

  // ── list ──────────────────────────────────────────────────────────────

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

  function listView() {
    const header = h(
      "header",
      { class: "dev-header", "data-testid": "dev-list-header" },
      h(
        "div",
        { class: "dev-header-top" },
        h("h2", { class: "dev-title" }, "API tokens"),
        button("Create token", {
          primary: true,
          id: "dev-create-open",
          testid: "dev-create-open",
          disabled: state.blocked !== null,
          onClick: async () => {
            // The scope list depends on /me, so wait for it (it is one
            // request, started at mount) before building the form.
            await identityReady;
            if (destroyed) return;
            state.view = "create";
            setStatus("");
            focusSel = "#dev-name";
            render();
          },
        })
      ),
      h(
        "div",
        { class: "dev-bulk", role: "group", "aria-label": "Bulk actions", "data-testid": "dev-bulk" },
        button("Revoke all my tokens", {
          danger: true,
          testid: "dev-revoke-all",
          disabled: state.busy,
          onClick: revokeAllMine,
        }),
        button("Sign out everywhere", {
          danger: true,
          testid: "dev-signout-everywhere",
          disabled: state.busy,
          onClick: signOutEverywhere,
        })
      )
    );

    const parts = [header];
    if (state.blocked) {
      parts.push(h("p", { class: "dev-banner", role: "note", "data-testid": "dev-blocked" }, state.blocked.text));
    }
    parts.push(listBody());
    return h("section", { class: "dev-list", "data-testid": "dev-list" }, parts);
  }

  function listBody() {
    if (state.loading) return h("p", { class: "dev-muted", "data-testid": "dev-loading" }, "Loading tokens...");
    if (state.loadError) {
      return h(
        "div",
        { class: "dev-empty", role: "alert", "data-testid": "dev-load-error" },
        h("p", null, state.loadError),
        button("Try again", { onClick: loadFirstPage })
      );
    }
    if (state.tokens.length === 0) {
      return h("p", { class: "dev-muted", "data-testid": "dev-empty" }, "No API tokens yet.");
    }
    const head = h(
      "thead",
      null,
      h(
        "tr",
        null,
        ["Name", "Scopes", "Token", "Creator", "Expires", "Last used", ""].map((c) =>
          h("th", { scope: "col" }, c)
        )
      )
    );
    const body = h("tbody", null, state.tokens.map(tokenRow));
    const table = h("table", { class: "dev-table", "data-testid": "dev-table" }, head, body);
    const more = state.nextCursor
      ? h(
          "div",
          { class: "dev-more" },
          button(state.loadingMore ? "Loading..." : "Load more", {
            disabled: state.loadingMore,
            testid: "dev-load-more",
            onClick: loadMore,
          })
        )
      : null;
    return h("div", { class: "dev-table-wrap" }, table, more);
  }

  function cell(label, ...kids) {
    return h("td", { "data-label": label }, ...kids);
  }

  function tokenRow(t) {
    const status = statusOf(t);
    const nameCell = t.name
      ? h("span", { class: "dev-name", "data-testid": "dev-token-name" }, bidiName(t))
      : h("span", { class: "dev-name dev-muted", "data-testid": "dev-token-name" }, "Unnamed token");
    const scopes = h(
      "span",
      { class: "dev-chips" },
      (Array.isArray(t.scopes) ? t.scopes : []).map((s) => h("span", { class: "dev-chip" }, s))
    );
    let last;
    if (t.last_used_at) last = timeNode(t.last_used_at, true);
    else last = h("span", { class: "dev-muted" }, "Never");
    let action;
    if (status === "revoked") {
      action = h("span", { class: "dev-muted" }, "Revoked ", timeNode(t.revoked_at, false));
    } else {
      const expired = status === "expired" ? h("span", { class: "dev-muted dev-expired" }, "Expired") : null;
      action = h(
        "span",
        { class: "dev-row-actions" },
        expired,
        button("Revoke", {
          ariaLabel: "Revoke " + isoLabel(t),
          testid: "dev-revoke",
          disabled: state.busy,
          onClick: () => revokeOne(t),
        })
      );
    }
    return h(
      "tr",
      { "data-token-id": t.id, "data-status": status },
      cell("Name", nameCell),
      cell("Scopes", scopes),
      cell("Token", h("code", { class: "dev-hint" }, t.display_hint)),
      cell("Creator", creatorNode(t)),
      cell("Expires", timeNode(t.expires_at, false)),
      cell("Last used", last),
      cell("", action)
    );
  }

  // ── revoke / bulk actions ─────────────────────────────────────────────

  async function revokeOne(t) {
    if (state.busy) return;
    const ok = await confirmAction(
      "Revoke " + isoLabel(t) + " (" + t.display_hint + ")? Anything using it stops working immediately, and this cannot be undone."
    );
    if (!ok || destroyed) return;
    state.busy = true;
    render();
    try {
      await api("DELETE", TOKENS_URL + "/" + encodeURIComponent(t.id), undefined, abort.signal);
      setStatus("Revoked " + isoLabel(t) + ".");
    } catch (e) {
      if (destroyed || (e && e.name === "AbortError")) return;
      if (e instanceof ApiFailure && e.status === 404) setStatus("That token no longer exists.", "error");
      else setStatus("Could not revoke the token: " + failureText(e), "error");
    }
    state.busy = false;
    await loadFirstPage();
  }

  async function revokeAllMine() {
    if (state.busy) return;
    const ok = await confirmAction(
      "Revoke every API token you created? Anything using them stops working immediately. This does not sign you out, and it does not end any session."
    );
    if (!ok || destroyed) return;
    state.busy = true;
    render();
    try {
      const out = await api("POST", TOKENS_URL + "/revoke-mine", undefined, abort.signal);
      const n = out && Number.isInteger(out.revoked) ? out.revoked : 0;
      setStatus(n === 1 ? "Revoked 1 token." : "Revoked " + n + " tokens.");
    } catch (e) {
      if (destroyed || (e && e.name === "AbortError")) return;
      setStatus("Could not revoke your tokens: " + failureText(e), "error");
    }
    state.busy = false;
    await loadFirstPage();
  }

  async function signOutEverywhere() {
    if (state.busy) return;
    const ok = await confirmAction(
      "Sign out everywhere? This ends every session on your account, on every device, including this one, and you will need to sign in again. Your API tokens are not affected and keep working."
    );
    if (!ok || destroyed) return;
    state.busy = true;
    render();
    // On success this wipes client state and reloads. On failure it tells the
    // user itself and returns, so the buttons come back.
    await signOut({ everywhere: true });
    if (destroyed) return;
    state.busy = false;
    render();
  }

  function failureText(e) {
    if (!(e instanceof ApiFailure)) return "unexpected error.";
    if (e.status === 0) return e.message;
    return e.message + " (" + e.code + ")";
  }

  // ── create ────────────────────────────────────────────────────────────

  function createView() {
    const id = ++uid;
    const nameId = "dev-name";
    const nameInput = h("input", {
      id: nameId,
      type: "text",
      class: "dev-input",
      maxlength: String(NAME_MAX),
      autocomplete: "off",
      spellcheck: false,
      "aria-describedby": "dev-name-help dev-name-error",
    });
    const nameError = h("p", { id: "dev-name-error", class: "dev-field-error", role: "alert", "data-testid": "dev-name-error" });

    const boxes = [];
    const scopeItems = SCOPES.filter((s) => !s.adminOnly || state.isAdmin).map((s) => {
      const box = h("input", { type: "checkbox", id: "dev-scope-" + id + "-" + s.id.replace(":", "-"), value: s.id, checked: s.preset });
      boxes.push(box);
      return h(
        "label",
        { class: "dev-scope", for: box.id },
        box,
        h("span", { class: "dev-scope-text" }, h("span", { class: "dev-scope-id" }, s.id), h("span", { class: "dev-muted" }, s.help))
      );
    });

    const expiry = h(
      "select",
      { id: "dev-expiry", class: "dev-input" },
      EXPIRY_CHOICES.map((d) => h("option", { value: String(d), selected: d === DEFAULT_EXPIRY_DAYS }, d + " days"))
    );

    const formError = h("p", { class: "dev-field-error", role: "alert", "data-testid": "dev-form-error" });
    const submit = h(
      "button",
      { type: "submit", class: "dev-btn dev-btn-primary", "data-testid": "dev-create-submit", disabled: state.blocked !== null },
      "Create token"
    );
    if (state.blocked) formError.textContent = state.blocked.text;

    function chosen() {
      return boxes.filter((b) => b.checked).map((b) => b.value);
    }
    function syncSubmit() {
      submit.disabled = state.blocked !== null || state.busy || chosen().length === 0;
    }
    boxes.forEach((b) => b.addEventListener("change", syncSubmit));

    const form = h(
      "form",
      { class: "dev-form", novalidate: true, "data-testid": "dev-create-form" },
      h(
        "div",
        { class: "dev-field" },
        h("label", { for: nameId }, "Name (optional)"),
        nameInput,
        h("p", { id: "dev-name-help", class: "dev-muted dev-help" }, "Up to " + NAME_MAX + " characters. Helps you tell tokens apart."),
        nameError
      ),
      h(
        "fieldset",
        { class: "dev-field dev-fieldset" },
        h("legend", null, "Scopes"),
        h("p", { class: "dev-muted dev-help" }, "Only scopes your role allows are offered."),
        scopeItems
      ),
      h("div", { class: "dev-field" }, h("label", { for: "dev-expiry" }, "Expires after"), expiry),
      formError,
      h(
        "div",
        { class: "dev-actions" },
        submit,
        button("Cancel", {
          testid: "dev-create-cancel",
          onClick: () => {
            state.view = "list";
            focusSel = "#dev-create-open";
            render();
          },
        })
      )
    );

    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      if (state.busy || state.blocked) return;
      const scopes = chosen();
      if (scopes.length === 0) return;
      const body = { scopes, expires_in_days: Number(expiry.value) };
      // The API refuses leading and trailing whitespace, so trim; a name that
      // is blank after trimming is simply not sent.
      const name = nameInput.value.trim();
      if (name) body.name = name;
      state.busy = true;
      submit.disabled = true;
      nameError.textContent = "";
      formError.textContent = "";
      try {
        const out = await api("POST", TOKENS_URL, body, abort.signal);
        if (destroyed) return;
        secret = {
          token: out.token,
          name: out.name,
          scopes: out.scopes,
          expires_at: out.expires_at,
          display_hint: out.display_hint,
        };
        state.busy = false;
        state.view = "reveal";
        focusSel = "#dev-secret";
        render();
      } catch (e) {
        if (destroyed || (e && e.name === "AbortError")) return;
        state.busy = false;
        showCreateError(e, nameInput, nameError, formError);
        syncSubmit();
      }
    });

    syncSubmit();
    return h(
      "section",
      { class: "dev-panel", "data-testid": "dev-create" },
      h("h2", { class: "dev-title" }, "Create an API token"),
      form
    );
  }

  function showCreateError(e, nameInput, nameError, formError) {
    if (!(e instanceof ApiFailure)) {
      formError.textContent = "The token could not be created.";
      return;
    }
    const namePath = Array.isArray(e.details) && e.details.some((d) => d && d.path === "name");
    if (e.status === 422 && namePath) {
      nameError.textContent = "That name is not allowed. Use 1 to " + NAME_MAX + " characters with no control characters.";
      nameInput.focus();
    } else if (e.status === 409) {
      state.blocked = { text: "Tokens cannot be created while your account is not active. (" + e.code + ")" };
      formError.textContent = state.blocked.text;
    } else if (e.status === 403 && e.code === "tokens_not_available") {
      state.blocked = { text: "API tokens aren't available yet." };
      formError.textContent = state.blocked.text;
    } else if (e.status === 403) {
      formError.textContent = "The server refused: " + e.message + " (" + e.code + ")";
    } else if (e.status === 401) {
      // The live client (through _lib/api.js) has already asked the server about
      // the session; if it ended, the sign-in screen replaces this window.
      formError.textContent = "Checking your session...";
    } else if (e.status === 0) {
      formError.textContent = "The request did not complete. Check the token list before trying again, in case the token was created.";
    } else {
      formError.textContent = "The token could not be created: " + e.message + " (" + e.code + ")";
    }
  }

  // ── reveal ────────────────────────────────────────────────────────────

  function revealView() {
    const secretEl = h("code", { id: "dev-secret", class: "dev-secret", tabindex: "-1", "data-testid": "dev-secret", "data-secret-node": "1" }, secret.token);
    const copyNote = h("p", { class: "dev-muted dev-help", "aria-live": "polite", "data-testid": "dev-copy-note" });
    const copy = button("Copy", {
      primary: true,
      testid: "dev-copy",
      onClick: async () => {
        try {
          await navigator.clipboard.writeText(secret.token);
          copyNote.textContent = "Copied to the clipboard.";
        } catch {
          const range = document.createRange();
          range.selectNodeContents(secretEl);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          copyNote.textContent = "Copying was blocked, so the token is selected. Copy it by hand.";
        }
      },
    });
    const done = button("Done", {
      testid: "dev-reveal-done",
      onClick: () => {
        closeReveal();
      },
    });
    return h(
      "section",
      { class: "dev-panel", role: "group", "aria-label": "New API token", "data-testid": "dev-reveal" },
      h("h2", { class: "dev-title" }, "Token created"),
      h(
        "p",
        { class: "dev-warn", "data-testid": "dev-reveal-warning" },
        "Copy this token now. It is shown only once and cannot be looked up again. If you lose it, revoke it and create a new one."
      ),
      secretEl,
      h("div", { class: "dev-actions" }, copy, done),
      copyNote,
      h(
        "p",
        { class: "dev-muted dev-help", "data-testid": "dev-reveal-summary" },
        bidiName(secret),
        " - " + secret.scopes.join(", ") + " - expires ",
        timeNode(secret.expires_at, false)
      )
    );
  }

  function closeReveal() {
    secret = null;
    scrubSecretNodes();
    state.view = "list";
    setStatus("");
    focusSel = "#dev-create-open";
    // Render first so the token node leaves the DOM, then refresh the list.
    render();
    loadFirstPage();
  }

  // ── start / stop ──────────────────────────────────────────────────────

  render();
  const identityReady = loadIdentity();
  loadFirstPage();

  return {
    revealOpen() {
      return secret !== null;
    },
    // Live update (WS-LV2): re-fetch the first page quietly. Never while a
    // create or revoke is in flight (its own finish re-fetches), and never
    // re-render over the create form or the one-time reveal dialog.
    async refresh() {
      if (destroyed || state.busy) return;
      const mine = ++generation;
      try {
        const page = await api("GET", TOKENS_URL, undefined, abort.signal);
        if (mine !== generation || destroyed || state.busy) return;
        state.tokens = Array.isArray(page && page.data) ? page.data : [];
        state.nextCursor = page && typeof page.next_cursor === "string" ? page.next_cursor : null;
        state.loading = false;
        state.loadError = null;
        if (state.view === "list") render();
      } catch {
        // Keep what is on screen; the next event or focus re-fetch tries again.
      }
    },
    destroy() {
      destroyed = true;
      secret = null;
      scrubSecretNodes();
      abort.abort();
      root.replaceChildren();
    },
  };
}
