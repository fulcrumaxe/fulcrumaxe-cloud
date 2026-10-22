// D#598 P8d-3b: the Vercel connection screen. It shows the state the details route derives
// (GET /api/v1/vercel-connection/details) and lets an owner or admin connect, replace and remove the token.
//
// Rules this file keeps (the Model Key app's, for the same reason: the token is a secret):
//   * The token is read from the password input once, at submit, and the input is emptied before the
//     request is sent (and again when it settles). It is never rendered back, logged, put in a URL or
//     kept in web storage; the server never returns it.
//   * Errors are this file's own fixed sentences. error.message is never displayed.
//   * Names come from the server as text; every node is built with the shared h(), so a project named
//     like markup stays text. Ids never reach this screen (the route does not send them).
//   * There is no 401 branch: a lost session is the shell's business.
import { onRefresh } from "../../core/cloud-live.js";
import { h, timeNode, confirmAction } from "../_lib/dom.js";
import { api, ApiFailure, createRetryGate, isRateLimited, retryWords, waitSeconds } from "../_lib/api.js";

const URL_BASE = "/api/v1/vercel-connection";
const FORBIDDEN = "Only owners and admins can change this.";
const GENERIC = "That didn't work. Try again.";
const NETWORK = "The server could not be reached.";
const RATE_LIMITED = "Too many tries. ";
// Fixed sentences for each closed-list code the connect and replace routes answer with.
const TOKEN_SENTENCES = {
  invalid_token_format: "That doesn't look like a Vercel token. Paste it again without spaces.",
  token_rejected: "Vercel didn't accept that token. Check that it hasn't expired and can see your projects.",
};
const TEAM_SENTENCE = "That doesn't look like a Vercel team id. It starts with team_.";
const UNREACHABLE = "We couldn't reach Vercel to check that token. Try again in a minute.";
const ALREADY = "Vercel is already connected. Use Replace token to change it.";

function failureSentence(e) {
  if (!(e instanceof ApiFailure)) return GENERIC;
  if (e.status === 0) return NETWORK;
  if (e.status === 403) return FORBIDDEN;
  if (e.status === 429) return RATE_LIMITED + retryWords(waitSeconds(e));
  return GENERIC;
}

export function mountVercel(host) {
  const abort = new AbortController();
  const state = {
    details: undefined, // undefined = loading, else the details DTO
    loadError: false,
    isAdmin: false,
    form: "", // "" closed, "connect" or "rotate": the paste form is open
    busy: false,
    tokenError: "",
    teamError: "",
  };
  let destroyed = false;
  let generation = 0;
  const uid = "vc" + Math.random().toString(36).slice(2, 8);

  const root = h("div", { class: "vc-app", "data-testid": "vc-app" });
  const noticeEl = h("p", { class: "vc-notice", role: "status", "aria-live": "polite", "data-testid": "vc-notice" });
  const statusHost = h("div", { class: "vc-status-host" });
  const formHost = h("div", { class: "vc-form-host", "data-no-preview": "" });
  root.append(noticeEl, statusHost, formHost);
  host.replaceChildren(root);

  function setNotice(text, isError) {
    noticeEl.textContent = text || "";
    noticeEl.className = "vc-notice" + (text ? " vc-notice-on" : "") + (isError ? " vc-notice-error" : "");
  }

  // After a 429 the write buttons stay disabled until the wait ends (the cap is per account).
  const waiting = () => gate.remaining > 0;
  const gate = createRetryGate({
    onChange(remaining) {
      if (destroyed) return;
      setNotice(remaining > 0 ? RATE_LIMITED + retryWords(remaining) : "", remaining > 0);
      render();
    },
  });

  // ── the paste form: built once, so a live refresh never disturbs what is typed ──
  const tokenInput = h("input", {
    class: "vc-input",
    id: uid + "-token",
    type: "password",
    autocomplete: "off",
    autocapitalize: "off",
    name: "vercel-token",
    "aria-describedby": uid + "-token-err",
    "data-testid": "vc-token",
  });
  tokenInput.setAttribute("spellcheck", "false");
  tokenInput.setAttribute("data-lpignore", "true");
  tokenInput.setAttribute("data-1p-ignore", "true");
  const teamInput = h("input", { class: "vc-input", id: uid + "-team", type: "text", autocomplete: "off", "aria-describedby": uid + "-team-help " + uid + "-team-err", "data-testid": "vc-team" });
  teamInput.setAttribute("spellcheck", "false");
  const teamLabel = h("label", { class: "vc-label", for: uid + "-team" }, "Team id (optional)");
  const teamHelp = h("p", { class: "vc-muted vc-help", id: uid + "-team-help" }, "Only for a token that belongs to a team. It starts with team_.");
  const tokenErr = h("p", { class: "vc-field-error", id: uid + "-token-err", role: "alert", "data-testid": "vc-token-error" });
  const teamErr = h("p", { class: "vc-field-error", id: uid + "-team-err", role: "alert", "data-testid": "vc-team-error" });
  const formTitle = h("h3", { class: "vc-title" });
  const formHelp = h("p", { class: "vc-muted vc-help", "data-testid": "vc-form-help" });
  const saveBtn = h("button", { type: "submit", class: "vc-btn vc-btn-primary", "data-testid": "vc-save" });
  const cancelBtn = h("button", { type: "button", class: "vc-btn", "data-testid": "vc-cancel", onClick: closeForm }, "Cancel");
  const form = h(
    "form",
    { class: "vc-form", "data-testid": "vc-form", autocomplete: "off", noValidate: true, onSubmit: submit },
    formTitle,
    formHelp,
    h("label", { class: "vc-label", for: uid + "-token" }, "Vercel token"),
    tokenInput,
    tokenErr,
    teamLabel,
    teamInput,
    teamHelp,
    teamErr,
    h("div", { class: "vc-actions" }, saveBtn, cancelBtn)
  );

  function updateForm() {
    const rotate = state.form === "rotate";
    formTitle.textContent = rotate ? "Replace the Vercel token" : "Connect Vercel";
    formHelp.textContent = rotate
      ? "Paste a new Vercel token. The current one stays in use until Vercel accepts the new one."
      : "Paste a Vercel token that can read your projects. It is sent once and is never shown again.";
    saveBtn.textContent = rotate ? "Replace token" : "Connect Vercel";
    for (const el of [teamLabel, teamInput, teamHelp]) el.hidden = rotate; // a replacement keeps the stored team
    for (const el of [tokenInput, teamInput, saveBtn, cancelBtn]) el.disabled = state.busy;
    saveBtn.disabled = state.busy || waiting();
    cancelBtn.hidden = state.form === "connect";
    tokenErr.textContent = state.tokenError;
    tokenErr.hidden = !state.tokenError;
    teamErr.textContent = state.teamError;
    teamErr.hidden = rotate || !state.teamError;
    tokenInput.setAttribute("aria-invalid", state.tokenError ? "true" : "false");
    teamInput.setAttribute("aria-invalid", state.teamError ? "true" : "false");
  }

  // ── data ──────────────────────────────────────────────────────────────

  async function load() {
    const mine = ++generation;
    try {
      const details = await api("GET", URL_BASE + "/details", undefined, abort.signal);
      if (mine !== generation || destroyed) return;
      if (details && typeof details === "object") state.details = details;
      state.loadError = !details || typeof details !== "object";
    } catch (e) {
      if (mine !== generation || destroyed || (e && e.name === "AbortError")) return;
      state.loadError = true;
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

  async function run(fn) {
    if (state.busy) return;
    state.busy = true;
    render();
    try {
      await fn();
    } catch (e) {
      if (!destroyed && !(e && e.name === "AbortError")) {
        if (isRateLimited(e)) gate.start(waitSeconds(e));
        else setNotice(failureSentence(e), true);
      }
    } finally {
      state.busy = false;
      render();
      if (!destroyed && (state.tokenError || state.teamError) && form.parentNode === formHost) (state.tokenError ? tokenInput : teamInput).focus();
    }
  }

  function openForm(kind) {
    state.form = kind;
    state.tokenError = state.teamError = "";
    setNotice("");
    render();
    tokenInput.focus();
  }

  function closeForm() {
    state.form = "";
    state.tokenError = state.teamError = "";
    tokenInput.value = teamInput.value = "";
    render();
  }

  function submit(ev) {
    ev.preventDefault();
    if (state.busy || waiting()) return;
    const rotate = state.form === "rotate";
    // The token goes into the request body and the field is emptied at once; nothing else holds it.
    const body = { token: tokenInput.value };
    const team = teamInput.value.trim();
    if (!rotate && team) body.team_id = team;
    tokenInput.value = "";
    state.tokenError = state.teamError = "";
    if (!body.token.trim()) {
      state.tokenError = "Paste a token first.";
      render();
      tokenInput.focus();
      return;
    }
    setNotice("");
    run(async () => {
      try {
        await api(rotate ? "PUT" : "POST", URL_BASE, body, abort.signal);
        state.form = "";
        teamInput.value = "";
        setNotice(rotate ? "Token replaced." : "Vercel is connected.");
        await load();
      } catch (e) {
        if (e && e.name === "AbortError") return;
        // packages/api/src/routes/vercel-connection.ts: details[0].path is "token" or "team_id", code from the closed list.
        const d = e instanceof ApiFailure && Array.isArray(e.details) ? e.details[0] : null;
        if (e instanceof ApiFailure && e.status === 422 && d && d.path === "team_id") state.teamError = TEAM_SENTENCE;
        else if (e instanceof ApiFailure && e.status === 422) state.tokenError = (d && Object.hasOwn(TOKEN_SENTENCES, d.code) && TOKEN_SENTENCES[d.code]) || "The token was not accepted.";
        else if (e instanceof ApiFailure && e.status === 503) setNotice(UNREACHABLE, true);
        else if (e instanceof ApiFailure && e.status === 409) {
          setNotice(ALREADY, true); // somebody connected it first: show the connection, not a second form
          state.form = "";
          await load();
        } else if (isRateLimited(e)) gate.start(waitSeconds(e));
        else setNotice(failureSentence(e), true);
      } finally {
        body.token = "";
        tokenInput.value = "";
      }
    });
  }

  async function disconnect() {
    if (state.busy) return;
    if (!(await confirmAction("Disconnect Vercel? We will stop checking your environment variables until you connect again."))) return;
    if (destroyed) return;
    run(async () => {
      try {
        await api("DELETE", URL_BASE, undefined, abort.signal);
      } catch (e) {
        // Another admin disconnected first: the goal is met, so re-read and show the real state.
        if (!(e instanceof ApiFailure && e.status === 404 && e.code === "not_connected")) throw e;
      }
      state.form = "";
      setNotice("Vercel is disconnected.");
      await load();
    });
  }

  // ── views ─────────────────────────────────────────────────────────────

  const fact = (label, value) => h("div", { class: "vc-row" }, h("dt", { class: "vc-label" }, label), h("dd", { class: "vc-value" }, value));

  function namesFacts(names) {
    if (!names || names.status !== "ok") {
      return [fact("Projects", h("span", { "data-testid": "vc-names-unavailable" }, "The project names could not be loaded right now. The connection itself is not affected."))];
    }
    const projects = names.projects.length
      ? h("ul", { class: "vc-projects", "data-testid": "vc-projects" }, names.projects.map((n) => h("li", null, n)), names.truncated ? h("li", { class: "vc-muted" }, "and more that are not shown") : null)
      : h("span", { "data-testid": "vc-projects" }, "This token can see no projects.");
    return [fact("Vercel team", h("span", { "data-testid": "vc-team-name" }, names.team_name || "Your personal account")), fact("Projects", projects)];
  }

  // cannot_read and unreachable: the route's sentence names the check and the project it was about.
  const checkBanner = (check) =>
    !check || check.result === "read"
      ? null
      : h("p", { class: "vc-banner vc-banner-error", "data-testid": "vc-check-failed" }, h("strong", null, "The last environment check failed. "), check.sentence);

  function actions() {
    if (!state.isAdmin) return h("p", { class: "vc-muted", "data-testid": "vc-readonly" }, "Ask an owner or admin to change this.");
    return h(
      "div",
      { class: "vc-actions", "data-testid": "vc-actions" },
      h("button", { type: "button", class: "vc-btn vc-btn-primary", "data-testid": "vc-replace", disabled: state.busy || state.form === "rotate", onClick: () => openForm("rotate") }, "Replace token"),
      h("button", { type: "button", class: "vc-btn vc-btn-danger", "data-testid": "vc-disconnect", disabled: state.busy, onClick: disconnect }, "Disconnect")
    );
  }

  function statusView() {
    const d = state.details;
    if (d === undefined && !state.loadError) return h("p", { class: "vc-muted", "data-testid": "vc-loading" }, "Loading...");
    const parts = [];
    if (state.loadError) {
      parts.push(
        h("p", { class: "vc-banner vc-banner-error", role: "alert", "data-testid": "vc-load-error" }, "The Vercel connection could not be loaded. ", h("button", { type: "button", class: "vc-btn", "data-testid": "vc-retry", onClick: load }, "Try again"))
      );
    }
    if (!d) return h("div", null, parts);
    if (d.state === "not_connected") {
      parts.push(
        h("p", { class: "vc-banner", "data-testid": "vc-none" }, "Vercel is not connected."),
        h("p", { class: "vc-muted" }, "Connect Vercel and we can check that your project has the environment variables a step asks for. We read variable names only, never their values."),
        state.isAdmin ? null : h("p", { class: "vc-muted", "data-testid": "vc-readonly" }, "Ask an owner or admin to connect it.")
      );
    } else if (d.state === "revoked_or_expired") {
      parts.push(
        h(
          "p",
          { class: "vc-banner vc-banner-error", "data-testid": "vc-revoked" },
          h("strong", null, "Vercel is not accepting this token. "),
          "It may have been revoked or have expired. Until it is replaced, we cannot check your environment variables."
        ),
        d.check ? h("p", { class: "vc-muted", "data-testid": "vc-revoked-check" }, d.check.sentence) : null,
        actions()
      );
    } else {
      parts.push(
        h("p", { class: "vc-banner", "data-testid": "vc-connected" }, "Vercel is connected."),
        checkBanner(d.check),
        h(
          "dl",
          { class: "vc-facts", "data-testid": "vc-facts" },
          ...namesFacts(d.names),
          fact(
            "Last check",
            d.check
              ? h("span", { "data-testid": "vc-check" }, d.check.result === "read" ? d.check.sentence : "Failed.", " ", timeNode(d.check.ran_at, true))
              : h("span", { "data-testid": "vc-check" }, "No environment check has run yet.")
          )
        ),
        actions()
      );
    }
    return h("div", null, parts);
  }

  function render() {
    if (destroyed) return;
    statusHost.replaceChildren(statusView());
    // Owners and admins are asked for a first token; a replacement form opens on request.
    const first = !!state.details && state.details.state === "not_connected";
    if (state.isAdmin && first && !state.form) state.form = "connect";
    if (state.form === "connect" && !first) state.form = "";
    if (state.form === "rotate" && (!state.details || state.details.state === "not_connected")) state.form = "";
    if (state.isAdmin && state.form) {
      updateForm();
      if (form.parentNode !== formHost) formHost.replaceChildren(form);
    } else if (form.parentNode === formHost) {
      tokenInput.value = teamInput.value = "";
      formHost.replaceChildren();
    }
  }

  render();
  load();
  loadRole();

  // A page restored from the back-forward cache must never show a pasted token.
  const clearToken = () => {
    tokenInput.value = "";
  };
  window.addEventListener("pagehide", clearToken);
  const unsubscribe = [onRefresh(() => load())];

  return {
    clearToken,
    destroy() {
      destroyed = true;
      gate.cancel();
      abort.abort();
      for (const off of unsubscribe) off();
      window.removeEventListener("pagehide", clearToken);
      tokenInput.value = "";
      host.replaceChildren();
    },
  };
}

let current = null;
const FULC = window.FULC;
if (!FULC || typeof FULC.register !== "function") {
  throw new Error("Vercel app: the FULC SDK global is missing");
}
FULC.register({
  id: "vercel",
  title: "Vercel",
  icon: "VCL",
  defaultSize: { w: 620, h: 520 },
  onOpen({ contentEl }) {
    if (current) current.destroy();
    current = mountVercel(contentEl);
  },
  onHide() {
    if (current) current.clearToken();
  },
  onClose() {
    if (current) current.destroy();
    current = null;
  },
});
