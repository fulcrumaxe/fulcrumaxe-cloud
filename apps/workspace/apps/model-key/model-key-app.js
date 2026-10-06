// D#37 WS-F5: the Model Key app. Shows the account's model connection (provider,
// status, last check, the 4-character "Key check" fingerprint), keeps it live, and
// lets an owner or admin paste, test, replace and remove the key.
//
// Rules this file keeps (D#37 C31 / C33 / C34, WS-F5):
//   * The key is a secret. It is read from the password input once, at submit, and
//     the input is emptied before the request is sent (and again when it settles).
//     It is never rendered back, logged, put in a URL, stored in web storage, or
//     kept in a variable that outlives the submit handler. The server never returns
//     it; only the fingerprint is shown.
//   * Errors are shown as this file's own fixed sentences. error.message is
//     never displayed (it is a service string, and could carry anything).
//   * There is no 401 branch: a lost session is the shell's business.
//   * The app calls no FULC.state/config/window/backend/events (C34 section 4).
//   * Every node is built with the shared h(); nothing here parses markup.
import { on, onRefresh } from "../../core/cloud-live.js";
import { h, timeNode, confirmAction } from "../_lib/dom.js";
import { api, ApiFailure, createRetryGate, isRateLimited, retryWords, waitSeconds } from "../_lib/api.js";

const CONN_URL = "/api/v1/model-connection";
const PROVIDERS = [
  { id: "ai_gateway", label: "Vercel AI Gateway" },
  { id: "anthropic", label: "Anthropic" },
];
const providerLabel = (id) => (PROVIDERS.find((p) => p.id === id) || { label: "Unknown provider" }).label;

const STATUS_TEXT = { ok: "Working", broken: "Broken", unvalidated: "Not checked yet" };
const FORBIDDEN = "Only owners and admins can change this.";
const GENERIC = "That didn't work. Try again.";
const NETWORK = "The server could not be reached.";
const RATE_LIMITED = "Too many tries. ";
// A 422 invalid_model_key names its field in details[].path and the reason in details[].code.
const KEY_SENTENCES = {
  invalid_key_format: "That doesn't look like a key for this provider.",
  rejected: "The provider rejected this key.",
};
const PROVIDER_DISABLED = "Anthropic keys aren't available yet. Use a Vercel AI Gateway key for now.";

function failureSentence(e) {
  if (!(e instanceof ApiFailure)) return GENERIC;
  if (e.status === 0) return NETWORK;
  if (e.status === 403) return FORBIDDEN;
  if (e.status === 429) return RATE_LIMITED + retryWords(waitSeconds(e));
  return GENERIC;
}

/** last_error_code in words: the provider's 401/403 means the key itself was refused. */
function brokenWords(code) {
  if (code === "401" || code === "403") return "The key was rejected.";
  return "The provider could not be reached to check the key.";
}

export function mountModelKey(host) {
  const abort = new AbortController();
  const state = {
    conn: undefined, // undefined = loading, null = no connection, object = the status DTO
    loadError: false,
    isAdmin: false,
    replacing: false, // the paste form is open over an existing connection
    busy: false,
    keyError: "",
    providerError: "",
  };
  let destroyed = false;
  let generation = 0;
  // A result the user just caused outranks any status fetch still in flight.
  const setConn = (conn) => {
    generation++;
    state.conn = conn;
  };
  const uid = "mk" + Math.random().toString(36).slice(2, 8);

  const root = h("div", { class: "mk-app", "data-testid": "mk-app" });
  const noticeEl = h("p", { class: "mk-notice", role: "status", "aria-live": "polite", "data-testid": "mk-notice" });
  const statusHost = h("div", { class: "mk-status-host" });
  const formHost = h("div", { class: "mk-form-host", "data-no-preview": "" });
  root.append(noticeEl, statusHost, formHost);
  host.replaceChildren(root);

  function paintNotice(text, isError) {
    noticeEl.textContent = text || "";
    noticeEl.className = "mk-notice" + (text ? " mk-notice-on" : "") + (isError ? " mk-notice-error" : "");
  }
  // Any message other than the countdown takes the notice over; the countdown then stops repainting it.
  let waitOwnsNotice = false;
  function setNotice(text, isError) {
    waitOwnsNotice = false;
    paintNotice(text, isError);
  }

  // ── the wait after a 429: "Try again in N seconds", with the calling buttons disabled until it ends ──
  // The server's cap is per account, so while it runs neither Test key nor Save key can succeed.
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
  /** Only the controls that depend on the wait change, so a tick never rebuilds the view or steals focus. */
  function syncWaitControls() {
    const testBtn = statusHost.querySelector('[data-testid="mk-test"]');
    if (testBtn) testBtn.disabled = state.busy || waiting();
    saveBtn.disabled = state.busy || waiting();
  }

  // ── the paste form: built once, so a live refresh never disturbs what is typed ──
  const providerSel = h(
    "select",
    { class: "mk-input", id: uid + "-provider", "aria-describedby": uid + "-prov-help " + uid + "-prov-err", "data-testid": "mk-provider" },
    PROVIDERS.map((p) => h("option", { value: p.id }, p.label))
  );
  const keyInput = h("input", {
    class: "mk-input",
    id: uid + "-key",
    type: "password",
    autocomplete: "off",
    autocapitalize: "off",
    name: "model-key",
    "aria-describedby": uid + "-key-err",
    "data-testid": "mk-key",
  });
  keyInput.setAttribute("spellcheck", "false"); // h() skips false props, so it is set as an attribute
  keyInput.setAttribute("data-lpignore", "true");
  keyInput.setAttribute("data-1p-ignore", "true");
  const providerErr = h("p", { class: "mk-field-error", id: uid + "-prov-err", role: "alert", "data-testid": "mk-provider-error" });
  const keyErr = h("p", { class: "mk-field-error", id: uid + "-key-err", role: "alert", "data-testid": "mk-key-error" });
  const formTitle = h("h3", { class: "mk-title" });
  const saveBtn = h("button", { type: "submit", class: "mk-btn mk-btn-primary", "data-testid": "mk-save" }, "Save key");
  const cancelBtn = h("button", { type: "button", class: "mk-btn", "data-testid": "mk-cancel", onClick: closeForm }, "Cancel");
  const form = h(
    "form",
    { class: "mk-form", "data-testid": "mk-form", autocomplete: "off", noValidate: true, onSubmit: submit },
    formTitle,
    h("label", { class: "mk-label", for: uid + "-provider" }, "Provider"),
    providerSel,
    h("p", { class: "mk-muted mk-help", id: uid + "-prov-help" }, "Choose the service that issued this key."),
    providerErr,
    h("label", { class: "mk-label", for: uid + "-key" }, "Model key"),
    keyInput,
    keyErr,
    h("p", { class: "mk-muted mk-help" }, "The key is sent once and is never shown again."),
    h("div", { class: "mk-actions" }, saveBtn, cancelBtn)
  );

  function updateForm() {
    formTitle.textContent = state.conn ? "Replace the model key" : "Connect a model key";
    cancelBtn.hidden = !state.conn;
    for (const el of [providerSel, keyInput, saveBtn, cancelBtn]) el.disabled = state.busy;
    saveBtn.disabled = state.busy || waiting();
    keyErr.textContent = state.keyError;
    keyErr.hidden = !state.keyError;
    providerErr.textContent = state.providerError;
    providerErr.hidden = !state.providerError;
    keyInput.setAttribute("aria-invalid", state.keyError ? "true" : "false");
    providerSel.setAttribute("aria-invalid", state.providerError ? "true" : "false");
  }

  // ── data ──────────────────────────────────────────────────────────────

  async function load() {
    const mine = ++generation;
    try {
      const conn = await api("GET", CONN_URL, undefined, abort.signal);
      if (mine !== generation || destroyed) return;
      state.conn = conn && typeof conn === "object" ? conn : null;
      state.loadError = false;
    } catch (e) {
      if (mine !== generation || destroyed || (e && e.name === "AbortError")) return;
      if (e instanceof ApiFailure && e.status === 404) {
        // The ordinary "no key connected yet" answer, not a failure.
        state.conn = null;
        state.loadError = false;
      } else {
        state.loadError = true;
        if (state.conn === undefined) state.conn = null;
      }
    }
    render();
  }

  async function loadRole() {
    try {
      const me = await api("GET", "/api/cloud/auth/me", undefined, abort.signal);
      if (destroyed) return;
      state.isAdmin = !!(me && me.is_admin === true);
    } catch {
      state.isAdmin = false; // cosmetic only: the server's 403 stays authoritative
    }
    render();
  }

  // ── actions ───────────────────────────────────────────────────────────

  // focusId: the data-testid of the control that was acted on. render() rebuilds it, so focus is put back;
  // when it is gone (the key was removed) the paste form's key field takes it.
  async function run(fn, focusId) {
    if (state.busy) return;
    state.busy = true;
    render();
    try {
      await fn();
    } catch (e) {
      if (!destroyed && !(e && e.name === "AbortError")) {
        if (isRateLimited(e)) startWait(e);
        else setNotice(failureSentence(e), true);
      }
    } finally {
      state.busy = false;
      render();
      if (state.keyError && form.parentNode === formHost) keyInput.focus();
      else if (state.providerError && form.parentNode === formHost) providerSel.focus();
      else if (!destroyed && focusId) {
        const target = statusHost.querySelector(`[data-testid="${focusId}"]`) || (form.parentNode === formHost ? keyInput : null);
        if (target) target.focus();
      }
    }
  }

  function openForm() {
    state.replacing = true;
    state.keyError = state.providerError = "";
    setNotice("");
    render();
    keyInput.focus();
  }

  function closeForm() {
    state.replacing = false;
    state.keyError = state.providerError = "";
    keyInput.value = "";
    render();
  }

  function submit(ev) {
    ev.preventDefault();
    if (state.busy || waiting()) return;
    // The key goes into the request body and the field is emptied at once; nothing else holds it.
    const body = { provider: providerSel.value, key: keyInput.value };
    keyInput.value = "";
    state.keyError = state.providerError = "";
    if (!body.key.trim()) {
      state.keyError = "Paste a key first.";
      render();
      keyInput.focus();
      return;
    }
    setNotice("");
    run(async () => {
      try {
        const conn = await api("PUT", CONN_URL, body, abort.signal);
        setConn(conn);
        state.replacing = false;
        state.loadError = false;
        setNotice("Key saved.");
      } catch (e) {
        if (e && e.name === "AbortError") return;
        // packages/api/src/routes/model-connection.ts: 422 invalid_model_key, details path "key" or "provider".
        const d = e instanceof ApiFailure && e.status === 422 && Array.isArray(e.details) ? e.details[0] : null;
        if (d && d.code === "provider_disabled") state.providerError = PROVIDER_DISABLED;
        else if (d && d.path === "provider") state.providerError = "This provider isn't available right now.";
        else if (d && d.path === "key") state.keyError = (Object.hasOwn(KEY_SENTENCES, d.code) && KEY_SENTENCES[d.code]) || "The key was not accepted.";
        else if (isRateLimited(e)) startWait(e);
        else setNotice(failureSentence(e), true);
      } finally {
        body.key = "";
        keyInput.value = "";
      }
    }, "mk-replace");
  }

  function testKey() {
    if (waiting()) return;
    run(async () => {
      const conn = await api("POST", CONN_URL + "/test", undefined, abort.signal);
      setConn(conn);
      if (conn && conn.status === "ok") setNotice("The key works.");
      else setNotice(brokenWords(conn && conn.last_error_code), true);
    }, "mk-test");
  }

  async function removeKey() {
    if (state.busy) return;
    if (!(await confirmAction("Remove the model key? Work on this account stops until a new key is pasted."))) return;
    if (destroyed) return;
    run(async () => {
      await api("DELETE", CONN_URL, undefined, abort.signal);
      setConn(null);
      state.replacing = false;
      setNotice("Key removed.");
    }, "mk-remove");
  }

  // ── views ─────────────────────────────────────────────────────────────

  const fact = (label, value) =>
    h("div", { class: "mk-row" }, h("dt", { class: "mk-label" }, label), h("dd", { class: "mk-value" }, value));

  function statusView() {
    if (state.conn === undefined) return h("p", { class: "mk-muted", "data-testid": "mk-loading" }, "Loading...");
    const parts = [];
    if (state.loadError) {
      parts.push(
        h(
          "p",
          { class: "mk-banner mk-banner-error", role: "alert", "data-testid": "mk-load-error" },
          "The model key status could not be loaded. ",
          h("button", { type: "button", class: "mk-btn", "data-testid": "mk-retry", onClick: load }, "Try again")
        )
      );
    }
    const conn = state.conn;
    if (!conn) {
      if (!state.loadError) {
        parts.push(
          h("p", { class: "mk-banner", "data-testid": "mk-none" }, "No model key is connected."),
          h("p", { class: "mk-muted" }, state.isAdmin ? "Paste a key below to let this account run work." : "Ask an owner or admin to connect one.")
        );
      }
      return h("div", null, parts);
    }
    const broken = conn.status === "broken";
    if (broken) {
      parts.push(
        h(
          "p",
          { class: "mk-banner mk-banner-error", "data-testid": "mk-broken" },
          h("strong", null, "This key is broken. "),
          brokenWords(conn.last_error_code),
          state.isAdmin ? " Replace it to get work running again." : " Ask an owner or admin to replace it."
        )
      );
    }
    parts.push(
      h(
        "dl",
        { class: "mk-facts", "data-testid": "mk-facts" },
        fact("Provider", providerLabel(conn.provider)),
        fact("Status", h("span", { class: "mk-pill mk-pill-" + conn.status, "data-testid": "mk-state" }, STATUS_TEXT[conn.status] || "Unknown")),
        fact("Last checked", conn.last_validated_at ? timeNode(conn.last_validated_at, true) : "Never"),
        fact("Key check", h("code", { "data-testid": "mk-fingerprint" }, conn.fingerprint))
      )
    );
    if (state.isAdmin) {
      parts.push(
        h(
          "div",
          { class: "mk-actions", "data-testid": "mk-actions" },
          h("button", { type: "button", class: "mk-btn", "data-testid": "mk-test", disabled: state.busy || waiting(), onClick: testKey }, "Test key"),
          h(
            "button",
            { type: "button", class: "mk-btn" + (broken ? " mk-btn-primary" : ""), "data-testid": "mk-replace", disabled: state.busy || state.replacing, onClick: openForm },
            "Replace key"
          ),
          h("button", { type: "button", class: "mk-btn mk-btn-danger", "data-testid": "mk-remove", disabled: state.busy, onClick: removeKey }, "Remove key")
        )
      );
    }
    return h("div", null, parts);
  }

  function render() {
    if (destroyed) return;
    statusHost.replaceChildren(statusView());
    // Owners and admins are asked for a first key; a replacement form opens on request.
    const showForm = state.isAdmin && state.conn !== undefined && (state.replacing || (state.conn === null && !state.loadError));
    if (showForm) {
      updateForm();
      if (form.parentNode !== formHost) formHost.replaceChildren(form);
    } else if (form.parentNode === formHost) {
      keyInput.value = "";
      formHost.replaceChildren();
    }
  }

  render();
  load();
  loadRole();

  // ── live: a key that broke elsewhere, and the shell's re-fetch backstop ──
  // A page restored from the back-forward cache must never show a pasted key.
  const clearKey = () => {
    keyInput.value = "";
  };
  window.addEventListener("pagehide", clearKey);
  const unsubscribe = [on("model_connection.broken", () => load()), onRefresh(() => load())];

  return {
    // The shell hid the window: what was typed does not wait behind it.
    clearKey,
    destroy() {
      destroyed = true;
      gate.cancel();
      abort.abort();
      for (const off of unsubscribe) off();
      window.removeEventListener("pagehide", clearKey);
      keyInput.value = "";
      host.replaceChildren();
    },
  };
}

let current = null;
const FULC = window.FULC;
if (!FULC || typeof FULC.register !== "function") {
  throw new Error("Model Key app: the FULC SDK global is missing");
}
FULC.register({
  id: "model-key",
  title: "Model Key",
  icon: "KEY",
  defaultSize: { w: 620, h: 520 },
  onOpen({ contentEl }) {
    if (current) current.destroy();
    current = mountModelKey(contentEl);
  },
  onHide() {
    if (current) current.clearKey();
  },
  onClose() {
    if (current) current.destroy();
    current = null;
  },
});
