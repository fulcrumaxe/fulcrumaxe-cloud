// D#6 R2b-4b: the Runners section of the Repos app, and the runner-run setting in a repo's settings.
// D#6 R5b-2b-iii adds the repo mode picker, and D#6 R2b the local-review auto-merge control under it, at the end of this file.
//
// Two halves in one file, each a controller with no DOM (unit-tested with a fake call()) and a view built with h():
//  - the Runners section lists the account's runners, with each one's repos and whether its owner lets work run on their Claude
//    plan without asking each time. Only a runner's own registrant sees the switch (the server says so with
//    `can_change_plan_consent`). Turning it on or off sends nothing until the dialog's confirm button is pressed, and the switch is
//    never shown on before then.
//  - the setting "Runner runs on a member's plan" (ask / approve and tell me / approve without asking) for one repo. Owners and admins
//    change it (the server says so with `can_change`); everyone else sees the value. It shows the value in force and where it comes from.
// All words that describe approval come from the `copy` of GET /api/runners; what this file says itself is only labels around them.
// A refusal is shown as a sentence of this file's own, chosen by status, never the server's message. Text only.
import { h, timeNode } from "../_lib/dom.js";
import { api, ApiFailure } from "../_lib/api.js";

export const RUNNERS_URL = "/api/runners";
export const consentUrl = (id) => RUNNERS_URL + "/" + encodeURIComponent(id) + "/plan-consent";
export const dialUrl = (repoId) => RUNNERS_URL + "/repos/" + encodeURIComponent(repoId) + "/plan-approval-dial";
export const DISPOSITIONS = ["ask", "announce", "act"];
const DIAL_KEYS = { ask: "dialRunnerRunsAsk", announce: "dialRunnerRunsAnnounce", act: "dialRunnerRunsAct" };
const NEEDED_COPY = ["planConsentText", "dialRunnerRuns", ...Object.values(DIAL_KEYS)];
export const STATE_WORDS = { online_idle: "Online", busy: "Busy", paused: "Paused", draining: "Draining", not_responding: "Not responding", offline: "Offline", outdated: "Needs an update", revoked: "Revoked" };
export const MODE_WORDS = { subscription: "Claude subscription", api_key: "API key" };
export const SWITCH_LABEL = "Run work without asking each time";
export const CONSENT_SENTENCES = {
  403: "Only the person who registered this runner can change this.",
  404: "This runner isn't there any more.",
  other: "That change couldn't be saved. Try again.",
};
export const DIAL_SENTENCES = {
  403: "Only owners and admins can change this.",
  409: "The setting changed while you were saving. The current value is shown.",
  other: "That change couldn't be saved. Try again.",
};
export const OFF_QUESTION = "Ask before each run again?";
export const OFF_TEXT = "Work on this runner's repos will wait for your approval again, unless the repo's setting approves it for you.";
const named = (p) => (p && typeof p.name === "string" && p.name.trim() !== "" ? p.name.trim() : "");
const cancelled = (e) => e && e.name === "AbortError";
const sentence = (table, e) => (e instanceof ApiFailure || (e && typeof e.status === "number") ? table[e.status] : undefined) || table.other;

/** One runner row from GET /api/runners, or null when it is not usable. A registrant without a name is left unnamed, never shown as a blank. */
export function readRunner(r) {
  if (!r || typeof r.id !== "string" || !r.registered_by || typeof r.registered_by.id !== "string") return null;
  const pc = r.plan_consent;
  return {
    id: r.id,
    mode: r.credential_mode,
    state: typeof r.state === "string" ? r.state : "",
    note: typeof r.state_note === "string" && r.state_note.trim() !== "" ? r.state_note.trim() : "",
    person: named(r.registered_by),
    repos: (Array.isArray(r.repos) ? r.repos : []).map(named).filter(Boolean),
    granted: !!pc && pc.granted === true,
    changedAt: pc && typeof pc.changed_at === "string" ? pc.changed_at : null,
    canChange: r.can_change_plan_consent === true,
  };
}

/** The copy strings this file shows, or null unless every one arrived. */
export function readCopy(body) {
  const c = body && body.copy;
  return c && typeof c === "object" && NEEDED_COPY.every((k) => typeof c[k] === "string" && c[k] !== "") ? c : null;
}

/** The runners and the copy, read once and shared by the section and the repo setting. */
export function createRunnerData({ call = api, signal, onChange = () => {} } = {}) {
  let st = { status: "loading", runners: [], copy: null };
  let gen = 0;
  async function load() {
    const mine = ++gen;
    try {
      const body = await call("GET", RUNNERS_URL, undefined, signal);
      if (mine !== gen) return;
      st = { status: "ready", runners: (body && Array.isArray(body.runners) ? body.runners : []).map(readRunner).filter(Boolean), copy: readCopy(body) };
    } catch (e) {
      if (mine !== gen || cancelled(e)) return;
      if (st.status !== "ready") st = { status: "error", runners: [], copy: null };
    }
    onChange();
  }
  return { load, get state() { return st; } };
}

/** Turning the switch on or off for one runner: a question first, then exactly one POST when its confirm button is pressed. */
export function createConsentFlow({ call = api, signal, onChange = () => {}, onSaved = () => {} } = {}) {
  let st = null; // { runnerId, granted, phase: "ask" | "sending" | "error", error }
  const set = (next) => {
    st = next;
    onChange();
  };
  return {
    get state() { return st; },
    /** The switch was pressed: nothing is sent; the question opens for the other value. */
    begin(runner) {
      if (st && st.phase === "sending") return;
      set({ runnerId: runner.id, granted: !runner.granted, phase: "ask", error: "" });
    },
    cancel() {
      if (st && st.phase !== "sending") set(null);
    },
    async confirm() {
      if (!st || st.phase === "sending") return; // a double press is one request
      const asked = st;
      set({ ...asked, phase: "sending", error: "" });
      try {
        await call("POST", consentUrl(asked.runnerId), { granted: asked.granted }, signal);
        set(null);
        onSaved();
      } catch (e) {
        if (cancelled(e)) return;
        set({ ...asked, phase: "error", error: sentence(CONSENT_SENTENCES, e) });
        if (e && e.status === 404) onSaved();
      }
    },
  };
}

/** The runner-run setting of one repo: read, then a PUT per change. A refused or failed save leaves the value the server last gave. */
export function createDialController({ call = api, signal, repoId, onChange = () => {} } = {}) {
  let st = { status: "loading", dial: null, saving: false, error: "" };
  let gen = 0;
  const set = (patch) => {
    st = { ...st, ...patch };
    onChange();
  };
  const read = (b) =>
    b && DISPOSITIONS.includes(b.disposition) && ["default", "preset", "override"].includes(b.source)
      ? { disposition: b.disposition, source: b.source, preset: typeof b.preset === "string" ? b.preset : null, canChange: b.can_change === true }
      : null;
  async function load(quiet) {
    const mine = ++gen;
    try {
      const dial = read(await call("GET", dialUrl(repoId), undefined, signal));
      if (mine !== gen) return;
      set({ status: dial ? "ready" : "error", dial });
    } catch (e) {
      if (mine !== gen || cancelled(e)) return;
      if (!quiet || st.status !== "ready") set({ status: "error" });
    }
  }
  async function save(disposition) {
    if (st.saving || st.status !== "ready" || !st.dial.canChange || !DISPOSITIONS.includes(disposition) || disposition === st.dial.disposition) return;
    gen++; // a read still out must not overwrite this write
    set({ saving: true, error: "" });
    try {
      const dial = read(await call("PUT", dialUrl(repoId), { disposition }, signal));
      set({ saving: false, dial: dial || st.dial, error: dial ? "" : DIAL_SENTENCES.other });
    } catch (e) {
      if (cancelled(e)) return;
      set({ saving: false, error: sentence(DIAL_SENTENCES, e), ...(e && e.status === 403 && st.dial ? { dial: { ...st.dial, canChange: false } } : {}) });
      if (e && e.status === 409) load(true);
    }
  }
  /** "Use the default": the server writes the default back and the next read says so. Nothing to do when it already is. */
  async function reset() {
    if (st.saving || st.status !== "ready" || !st.dial.canChange || st.dial.source === "default") return;
    gen++;
    set({ saving: true, error: "" });
    try {
      const dial = read(await call("PUT", dialUrl(repoId), { reset: true }, signal));
      set({ saving: false, dial: dial || st.dial, error: dial ? "" : DIAL_SENTENCES.other });
    } catch (e) {
      if (cancelled(e)) return;
      set({ saving: false, error: sentence(DIAL_SENTENCES, e), ...(e && e.status === 403 && st.dial ? { dial: { ...st.dial, canChange: false } } : {}) });
      if (e && e.status === 409) load(true);
    }
  }
  return { load, save, reset, get state() { return st; } };
}

/** Where the value in force comes from, in plain words. */
export function sourceWords(dial) {
  if (dial.source === "default") return "This is the default. Nobody has set it for this repo.";
  if (dial.source === "preset") return dial.preset ? "Set by the " + dial.preset.charAt(0).toUpperCase() + dial.preset.slice(1) + " preset." : "Set by a preset.";
  return "Set for this repo.";
}

// ── views ───────────────────────────────────────────────────────────────

const when = (iso) => (iso ? [", ", timeNode(iso, true)] : []);

function consentParts(r, flow) {
  if (r.mode !== "subscription" || r.state === "revoked") return [];
  const who = r.person || "A teammate";
  const parts = [];
  if (r.canChange) {
    const box = h("input", {
      type: "checkbox", role: "switch", id: "repos-consent-" + r.id, class: "repos-switch-input", "data-testid": "repos-consent-switch",
      // Never on before the question is answered: the box always shows what is saved.
      checked: r.granted, "aria-describedby": "repos-consent-state-" + r.id,
      onClick: (e) => {
        e.preventDefault();
        flow.begin(r);
      },
    });
    parts.push(h("label", { class: "repos-toggle", for: "repos-consent-" + r.id }, box, h("span", null, h("strong", null, SWITCH_LABEL))));
  }
  const line = r.granted ? who + " lets work run on their plan without asking" : who + " approves each run";
  parts.push(h("p", { id: "repos-consent-state-" + r.id, class: "repos-runner-line", "data-testid": "repos-consent-state" }, line));
  if (r.changedAt) parts.push(h("p", { class: "repos-muted repos-runner-line", "data-testid": "repos-consent-when" }, r.granted ? "Turned on by " : "Turned off by ", who, ...when(r.changedAt)));
  return parts;
}

export function runnerRow(r, flow) {
  return h(
    "li",
    { class: "repos-runner", "data-testid": "repos-runner", "data-state": r.state },
    h("p", { class: "repos-runner-head" }, h("strong", null, h("bdi", null, r.person ? r.person + "'s runner" : "A runner")), " ",
      h("span", { class: "repos-state", "data-testid": "repos-runner-state" }, [MODE_WORDS[r.mode], STATE_WORDS[r.state]].filter(Boolean).join(" · "))),
    r.note ? h("p", { class: "repos-muted repos-runner-line", "data-testid": "repos-runner-note" }, r.note) : null,
    r.repos.length ? h("p", { class: "repos-muted repos-runner-line", "data-testid": "repos-runner-repos" }, "Repos: ", h("bdi", null, r.repos.join(", "))) : h("p", { class: "repos-muted repos-runner-line", "data-testid": "repos-runner-repos" }, "No repos"),
    ...consentParts(r, flow)
  );
}

/** The Runners section. `el` goes into the app; `data` is the shared read the repo setting also uses. */
export function createRunnersSection({ call = api, signal, doc = document, onData = () => {} } = {}) {
  let dlg = null;
  let parts = null;
  let lastRunner = "";
  const el = h("section", { class: "repos-runners", "aria-labelledby": "repos-runners-h", "data-testid": "repos-runners" });
  const data = createRunnerData({ call, signal, onChange: () => (paint(), onData()) });
  const flow = createConsentFlow({ call, signal, onChange: () => paint(), onSaved: () => data.load() });

  function paintDialog() {
    const d = flow.state;
    if (!d) {
      if (!dlg) return;
      const back = el.querySelector('[id="repos-consent-' + lastRunner + '"]');
      dlg.close();
      dlg.remove();
      dlg = parts = null;
      if (back) back.focus();
      return;
    }
    lastRunner = d.runnerId;
    const runner = data.state.runners.find((r) => r.id === d.runnerId);
    const copy = data.state.copy;
    if (!dlg) {
      parts = {
        title: h("h2", { class: "repos-subtitle", id: "repos-consent-h" }),
        body: h("div", { id: "repos-consent-d" }),
        err: h("p", { class: "repos-error", role: "alert", tabindex: "-1", "data-testid": "repos-consent-error" }),
        yes: h("button", { type: "button", class: "repos-btn", "data-testid": "repos-consent-confirm", onClick: () => parts.yes.getAttribute("aria-disabled") !== "true" && flow.confirm() }),
        no: h("button", { type: "button", class: "repos-btn", "data-testid": "repos-consent-cancel", onClick: () => flow.cancel() }, "Cancel"),
      };
      dlg = h("dialog", { class: "repos-dialog", "data-testid": "repos-consent-dialog", "aria-labelledby": "repos-consent-h", "aria-describedby": "repos-consent-d", onCancel: (e) => (e.preventDefault(), flow.cancel()) },
        h("div", { class: "repos-dialog-body" }, parts.title, parts.body, parts.err, h("div", { class: "repos-actions" }, parts.no, parts.yes)));
      doc.body.appendChild(dlg);
      dlg.showModal();
      parts.no.focus();
    }
    const turningOn = d.granted;
    parts.title.textContent = turningOn ? SWITCH_LABEL : OFF_QUESTION;
    parts.body.replaceChildren(
      ...(turningOn
        ? [h("p", null, copy ? copy.planConsentText : ""), h("p", { class: "repos-muted" }, "Repos on this runner: ", h("bdi", null, runner && runner.repos.length ? runner.repos.join(", ") : "none")), h("p", { class: "repos-muted" }, "Repos added to this runner later come under this too.")]
        : [h("p", null, OFF_TEXT)])
    );
    parts.err.textContent = d.error;
    parts.yes.textContent = turningOn ? "Turn on" : "Ask each time";
    parts.yes.setAttribute("aria-disabled", d.phase === "sending" ? "true" : "false");
    parts.no.textContent = d.phase === "error" ? "Close" : "Cancel";
    if (d.phase === "error") parts.err.focus();
  }

  function paint() {
    const s = data.state;
    const body =
      s.status === "loading" ? h("p", { class: "repos-muted", "data-testid": "repos-runners-loading" }, "Loading runners...")
      : s.status === "error" ? h("p", { class: "repos-error", role: "alert", "data-testid": "repos-runners-error" }, "Runners aren't available right now.")
      : s.runners.length === 0 ? h("p", { class: "repos-muted", "data-testid": "repos-runners-empty" }, "No runners yet. Register one with fx-runner on your machine.")
      : h("ul", { class: "repos-rows" }, s.runners.map((r) => runnerRow(r, flow)));
    const held = el.contains(doc.activeElement) ? doc.activeElement.id : "";
    el.replaceChildren(h("h3", { class: "repos-subtitle", id: "repos-runners-h" }, "Runners"), body);
    if (held) {
      const again = el.querySelector('[id="' + held + '"]');
      if (again) again.focus();
    }
    paintDialog();
  }
  paint();
  return {
    el,
    data,
    load: () => data.load(),
    destroy() {
      if (dlg) {
        dlg.close();
        dlg.remove();
        dlg = null;
      }
    },
  };
}

/** The runner-run setting for one repo. `el` goes into the repo's settings; it repaints itself. */
export function createDialControl({ call = api, signal, repoId, data, doc = document } = {}) {
  const el = h("fieldset", { class: "repos-dial", "data-testid": "repos-dial" });
  const ctl = createDialController({ call, signal, repoId, onChange: () => paint() });
  function paint() {
    const s = ctl.state;
    const copy = data.state.copy;
    if (s.status === "loading" || (data.state.status === "loading" && !copy)) return el.replaceChildren(h("p", { class: "repos-muted", "data-testid": "repos-dial-loading" }, "Loading..."));
    if (s.status === "error" || !s.dial || !copy) return el.replaceChildren(h("p", { class: "repos-error", role: "alert", "data-testid": "repos-dial-error" }, "This setting isn't available right now."));
    const held = el.contains(doc.activeElement) ? doc.activeElement.getAttribute("value") : null;
    const editable = s.dial.canChange;
    const name = "repos-dial-" + repoId;
    el.replaceChildren(
      h("legend", { class: "repos-subtitle" }, copy.dialRunnerRuns),
      ...DISPOSITIONS.map((d) =>
        h("label", { class: "repos-toggle" },
          h("input", { type: "radio", name, value: d, checked: s.dial.disposition === d, disabled: !editable || s.saving, "data-testid": "repos-dial-" + d, "aria-describedby": "repos-dial-source", onChange: () => ctl.save(d) }),
          h("span", null, h("strong", null, copy[DIAL_KEYS[d]])))
      ),
      h("p", { id: "repos-dial-source", class: "repos-muted", "data-testid": "repos-dial-source" }, sourceWords(s.dial)),
      ...(editable && s.dial.source !== "default"
        ? [h("button", { type: "button", class: "repos-btn", disabled: s.saving, "data-testid": "repos-dial-reset", onClick: () => ctl.reset() }, "Use the default")]
        : []),
      ...(editable ? [] : [h("p", { class: "repos-muted", "data-testid": "repos-dial-admin-only" }, "Only owners and admins can change this.")]),
      ...(s.error ? [h("p", { class: "repos-error", role: "alert", "data-testid": "repos-dial-save-error" }, s.error)] : [])
    );
    if (held) {
      const again = el.querySelector('[value="' + held + '"]');
      if (again) again.focus();
    }
  }
  paint();
  return { el, load: () => ctl.load(false), reload: () => ctl.load(true), repaint: paint };
}

// ── D#6 R5b-2b-iii: the repo mode picker (sandbox, local-only or cloud-verified) ─────────────────────────
//
// Same two halves: a controller with no DOM (unit-tested with a fake call()) and a view built with h(). Every word comes from the `copy` of
// GET /api/runners/repos/:id/execution-mode (runner-protocol's COPY); the only two sentences written here are for the moments before that
// answer exists (loading, and a read that failed), when there is no copy to use. A refusal is shown as a sentence chosen by status and
// code, never the server's message. Changing the mode asks for the repository's full name, typed back exactly (the server checks it
// too). Cloud-verified also sends the hash of the wording the server shipped, so the server's 409 `copy_changed` applies, and it is off
// while no usable model key is connected (`key_required`), with the reason wired to the radio by aria-describedby. A repo on a runner that is
// public now, or whose visibility can't be read (`runner_blocked`, read live by the server), shows the matching sentence: its runner jobs are refused.
export const MODES = ["sandbox", "runner_local", "runner_verified"];
const BLOCKS = ["public_repo", "repo_visibility_unknown"];
const LABEL_KEY = { sandbox: "sandbox", runner_local: "localOnly", runner_verified: "cloudVerified" };
const HELP_KEY = { sandbox: "sandboxHelp", runner_local: "localOnlyHelp", runner_verified: "cloudVerifiedHelp" };
const NEEDED = ["title", "sandbox", "sandboxHelp", "localOnly", "localOnlyHelp", "cloudVerified", "cloudVerifiedHelp", "keyRequired", "keyRequiredWhy", "typeName", "apply", "cancel", "saving", "saved", "leaveCancels", "adminOnly", "saveFailed", "nameMismatch", "copyChanged", "keyGone", "publicRepo", "visibilityUnknown"];
export const LOADING_TEXT = "Loading...";
export const UNAVAILABLE_TEXT = "This setting isn't available right now.";
export const modeUrl = (repoId) => "/api/runners/repos/" + encodeURIComponent(repoId) + "/execution-mode";

/** The state read, or null unless every part arrived (a copy with a missing string is not usable). */
export function readView(b) {
  const c = b && b.copy;
  if (!b || !MODES.includes(b.execution_mode) || typeof b.key_required !== "boolean" || typeof b.copy_sha256 !== "string" || !b.copy_sha256) return null;
  if (!c || typeof c !== "object" || !NEEDED.every((k) => typeof c[k] === "string" && c[k] !== "")) return null;
  return { mode: b.execution_mode, fullName: typeof b.full_name === "string" ? b.full_name : null, keyRequired: b.key_required, hash: b.copy_sha256, canChange: b.can_change === true, blocked: BLOCKS.includes(b.runner_blocked) ? b.runner_blocked : null, copy: c };
}

/** The sentence for a refused change, by status and code. `copy` is the picker's copy. */
export function refusalWords(e, copy) {
  const s = e && e.status;
  if (s === 403) return copy.adminOnly;
  if (s === 400 && e.code === "confirmation_mismatch") return copy.nameMismatch;
  if (s === 409 && e.code === "copy_changed") return copy.copyChanged;
  if (s === 409 && e.code === "api_key_required") return copy.keyGone;
  if (s === 409 && e.code === "public_repo") return copy.publicRepo;
  if (s === 409 && e.code === "repo_visibility_unknown") return copy.visibilityUnknown;
  return copy.saveFailed;
}

/**
 * What the picker shows for a state, with no DOM. `st`: { status, view, choice, typed, phase, error }.
 * `choice` is the mode picked and not yet applied (null when none); `phase` is idle | saving | error | saved.
 */
export function pickerModel(st) {
  if (st.status !== "ready" || !st.view) return { kind: st.status === "error" ? "error" : "loading" };
  const v = st.view;
  const busy = st.phase === "saving";
  const target = st.choice;
  const typedOk = v.fullName !== null && st.typed === v.fullName;
  return {
    kind: "ready",
    locked: !v.canChange,
    options: MODES.map((m) => ({
      mode: m,
      label: v.copy[LABEL_KEY[m]],
      help: v.copy[HELP_KEY[m]],
      checked: (target || v.mode) === m,
      // Staying on a verified repo is never blocked by the key; only moving onto cloud-verified needs one.
      keyOff: m === "runner_verified" && v.keyRequired && v.mode !== m,
      disabled: !v.canChange || busy || (m === "runner_verified" && v.keyRequired && v.mode !== m),
    })),
    keyReason: v.keyRequired && v.mode !== "runner_verified" ? [v.copy.keyRequired, v.copy.keyRequiredWhy] : null,
    // A sandbox repo is never blocked: moving it there is the way out.
    blocked: v.mode === "sandbox" || !v.blocked ? "" : v.blocked === "public_repo" ? v.copy.publicRepo : v.copy.visibilityUnknown,
    confirm: target ? { target, showWording: target === "runner_verified", leaveNote: target === "sandbox" && v.mode !== "sandbox" ? v.copy.leaveCancels : "", applyDisabled: !typedOk || busy } : null,
    saving: busy,
    saved: st.phase === "saved",
    error: st.phase === "error" ? st.error : "",
  };
}

/** The mode of one repo: read it, pick, confirm, POST. Nothing is sent until the confirm button is pressed with the exact name typed. */
export function createModeController({ call = api, signal, repoId, onChange = () => {}, onApplied = () => {} } = {}) {
  let st = { status: "loading", view: null, choice: null, typed: "", phase: "idle", error: "" };
  let gen = 0;
  const set = (patch) => {
    st = { ...st, ...patch };
    onChange();
  };
  async function load(quiet) {
    const mine = ++gen;
    try {
      const view = readView(await call("GET", modeUrl(repoId), undefined, signal));
      if (mine !== gen) return;
      if (!view) return quiet && st.view ? undefined : set({ status: "error", view: null });
      set({ status: "ready", view });
    } catch (e) {
      if (mine !== gen || cancelled(e)) return;
      if (!quiet || st.status !== "ready") set({ status: "error" });
    }
  }
  function choose(mode) {
    if (st.status !== "ready" || st.phase === "saving" || !st.view.canChange || !MODES.includes(mode)) return;
    const off = mode === "runner_verified" && st.view.keyRequired && st.view.mode !== mode;
    if (off) return;
    // Picking the current mode again backs out of a pending change.
    set({ choice: mode === st.view.mode ? null : mode, typed: "", phase: "idle", error: "" });
  }
  // Typing repaints nothing (the view only flips the apply button), so focus never leaves the input.
  const type = (text) => {
    if (st.phase !== "saving") st = { ...st, typed: text };
  };
  const cancel = () => st.phase !== "saving" && set({ choice: null, typed: "", phase: "idle", error: "" });
  async function apply() {
    const m = pickerModel(st);
    if (m.kind !== "ready" || !m.confirm || m.confirm.applyDisabled) return; // a double press is one request
    const mode = st.choice;
    const body = { mode, confirm_repo: st.typed, ...(mode === "runner_verified" ? { copy_sha256: st.view.hash } : {}) };
    gen++; // a read still out must not overwrite this write
    set({ phase: "saving", error: "" });
    try {
      const done = await call("POST", modeUrl(repoId), body, signal);
      const next = done && MODES.includes(done.execution_mode) ? done.execution_mode : mode;
      set({ view: { ...st.view, mode: next }, choice: null, typed: "", phase: "saved", error: "" });
      onApplied(); // the auto-merge control under the picker re-reads: leaving local-only turns it off
    } catch (e) {
      if (cancelled(e)) return;
      const copy = st.view.copy;
      set({ phase: "error", error: refusalWords(e, copy), ...(e && e.status === 403 ? { view: { ...st.view, canChange: false }, choice: null } : {}) });
      // The wording, the key or the mode moved under the user: show what is true now, keep their words about it.
      if (e && (e.status === 409 || e.status === 400)) load(true);
    }
  }
  return { load, choose, type, cancel, apply, get state() { return st; } };
}

/** The view. `el` goes into the repo's settings; it repaints itself and keeps focus on the control the user was on. */
export function createModeControl({ call = api, signal, repoId, doc = document, onApplied } = {}) {
  const el = h("fieldset", { class: "repos-mode", "data-testid": "repos-mode" });
  const ctl = createModeController({ call, signal, repoId, onChange: () => paint(), onApplied });
  const id = (s) => "repos-mode-" + s;
  let focusError = false;
  function paint() {
    const m = pickerModel(ctl.state);
    if (m.kind === "loading") return el.replaceChildren(h("p", { class: "repos-muted", "data-testid": "repos-mode-loading" }, LOADING_TEXT));
    if (m.kind === "error") return el.replaceChildren(h("p", { class: "repos-error", role: "alert", "data-testid": "repos-mode-load-error" }, UNAVAILABLE_TEXT));
    const v = ctl.state.view;
    const held = el.contains(doc.activeElement) ? doc.activeElement.id : "";
    const name = id("radio-" + repoId);
    const radios = m.options.map((o) =>
      h("label", { class: "repos-toggle", for: id("opt-" + o.mode) },
        h("input", {
          type: "radio", name, value: o.mode, id: id("opt-" + o.mode), checked: o.checked, disabled: o.disabled, "data-testid": "repos-mode-" + o.mode,
          "aria-describedby": o.keyOff ? id("key-reason") : m.locked ? id("locked") : id("help-" + o.mode),
          onChange: () => ctl.choose(o.mode),
        }),
        h("span", null, h("strong", null, o.label), h("span", { class: "repos-muted", id: id("help-" + o.mode) }, o.help)))
    );
    const parts = [h("legend", { class: "repos-subtitle" }, v.copy.title), h("div", { role: "radiogroup", "aria-label": v.copy.title, "data-testid": "repos-mode-group" }, ...radios)];
    if (m.blocked) parts.push(h("p", { class: "repos-error", role: "status", "data-testid": "repos-mode-blocked" }, m.blocked));
    if (m.keyReason) parts.push(h("p", { id: id("key-reason"), class: "repos-muted", "data-testid": "repos-mode-key-required" }, m.keyReason.join(" ")));
    if (m.locked) parts.push(h("p", { id: id("locked"), class: "repos-muted", "data-testid": "repos-mode-admin-only" }, v.copy.adminOnly));
    if (m.confirm) {
      const input = h("input", {
        type: "text", id: id("name"), class: "repos-allow-name", autocomplete: "off", autocapitalize: "off", spellcheck: "false", value: ctl.state.typed, disabled: m.saving,
        "data-testid": "repos-mode-name", "aria-describedby": id("name-help"),
        onInput: () => {
          ctl.type(input.value);
          const apply = el.querySelector("#" + id("apply"));
          if (apply) apply.setAttribute("aria-disabled", pickerModel(ctl.state).confirm.applyDisabled ? "true" : "false");
        },
      });
      parts.push(h("div", { class: "repos-confirm", role: "group", "aria-label": v.copy.apply, "data-testid": "repos-mode-confirm" },
        ...(m.confirm.showWording ? [h("p", { "data-testid": "repos-mode-wording" }, v.copy.cloudVerifiedHelp)] : []),
        ...(m.confirm.leaveNote ? [h("p", { "data-testid": "repos-mode-leave" }, m.confirm.leaveNote)] : []),
        h("label", { for: id("name"), id: id("name-help") }, v.copy.typeName, " ", h("bdi", null, v.fullName || "")),
        input,
        h("div", { class: "repos-actions" },
          h("button", { type: "button", class: "repos-btn", id: id("apply"), "data-testid": "repos-mode-apply", "aria-disabled": m.confirm.applyDisabled ? "true" : "false", onClick: () => ctl.apply() }, m.saving ? v.copy.saving : v.copy.apply),
          h("button", { type: "button", class: "repos-btn", "data-testid": "repos-mode-cancel", disabled: m.saving, onClick: () => ctl.cancel() }, v.copy.cancel))));
    }
    parts.push(h("p", { class: "repos-muted", role: "status", "data-testid": "repos-mode-saved" }, m.saved ? v.copy.saved : ""));
    parts.push(h("p", { class: "repos-error", role: "alert", tabindex: "-1", id: id("error"), "data-testid": "repos-mode-error" }, m.error));
    el.replaceChildren(...parts);
    // A new error takes focus once; a repaint after it (a re-read) keeps focus there, and one the user has moved off is left alone.
    const toError = m.error && (!focusError || held === id("error"));
    focusError = !!m.error;
    const target = toError ? el.querySelector("#" + id("error")) : held ? el.querySelector('[id="' + held + '"]') : null;
    if (target) {
      target.focus();
      if (!toError && target.tagName === "INPUT" && target.type === "text") target.setSelectionRange(target.value.length, target.value.length);
    }
  }
  paint();
  return { el, load: () => ctl.load(false), reload: () => ctl.load(true) };
}

// ── D#6 R2b: the "Merge after reviews on your machine" control in a repo's settings, shown only while the repo runs on a runner (local-only).
//
// Same two halves as the mode picker above it (it lives in this file so the app's boot makes no extra request): a controller with no DOM (unit-tested with a fake call()) and a view built with h().
// It reads the same route as the picker (GET /api/runners/repos/:id/execution-mode), which also says whether auto-merge is on and carries the
// exact wording an admin reads first and its hash. Every word is the server's copy; this control writes none of its own, and stays hidden
// until it has an answer (the picker above already says when a read failed). Turning it on shows the wording, asks for the repository's full name typed back exactly (the
// server checks it too) and sends the hash of the wording that was shown, so the server's 409 `copy_changed` applies. Turning it off sends
// nothing but the off switch and asks nothing: it is the safe direction. A refusal is a sentence chosen by status and code, never the server's
// message. Owners and admins change it (the server says so with `can_change`); everyone else reads the state and the adminOnly line.
const AM_KEYS = ["autoMergeWording", "autoMergeTitle", "autoMergeIsOn", "autoMergeIsOff", "autoMergeTurnOn", "autoMergeTurnOff", "autoMergeSavedOn", "autoMergeSavedOff", "autoMergeHumanOnly", "autoMergeNotLocal"];

/** The state read, or null unless the picker's part and every auto-merge part arrived. */
export function readAutoMerge(b) {
  const v = readView(b);
  if (!v || typeof b.auto_merge !== "boolean" || typeof b.auto_merge_copy_sha256 !== "string" || !b.auto_merge_copy_sha256) return null;
  if (!AM_KEYS.every((k) => typeof v.copy[k] === "string" && v.copy[k] !== "")) return null;
  return { ...v, autoMerge: b.auto_merge, amHash: b.auto_merge_copy_sha256 };
}

/** The sentence for a refused change, by status and code. `copy` is the server's copy. */
export function autoMergeRefusal(e, copy) {
  const s = e && e.status;
  if (s === 403) return copy.adminOnly;
  if (s === 400 && e.code === "confirmation_mismatch") return copy.nameMismatch;
  if (s === 409 && e.code === "copy_changed") return copy.copyChanged;
  if (s === 409 && e.code === "human_merge_only") return copy.autoMergeHumanOnly;
  if (s === 409 && e.code === "not_runner_local") return copy.autoMergeNotLocal;
  return copy.saveFailed;
}

/** What the control shows for a state, with no DOM. `st`: { status, view, confirming, typed, phase, saved, error }; `phase` is idle | saving | error | saved. */
export function autoMergeModel(st) {
  // Before the answer, after a failed read, or on an answer without the auto-merge parts, there is nothing true to show: the picker above
  // already says when the read failed, so this control stays out of the way instead of repeating it.
  if (st.status !== "ready" || !st.view) return { kind: "hidden" };
  const v = st.view;
  // Only a repo on the local runner has the control; a sandbox or cloud-verified repo has no auto-merge opt-in to show.
  if (v.mode !== "runner_local") return { kind: "hidden" };
  const busy = st.phase === "saving";
  const typedOk = v.fullName !== null && st.typed === v.fullName;
  return {
    kind: "ready",
    on: v.autoMerge,
    locked: !v.canChange,
    statusText: v.autoMerge ? v.copy.autoMergeIsOn : v.copy.autoMergeIsOff,
    wording: v.copy.autoMergeWording,
    canTurnOn: v.canChange && !v.autoMerge && !st.confirming && !busy,
    canTurnOff: v.canChange && v.autoMerge && !busy,
    confirm: st.confirming && !v.autoMerge && v.canChange ? { applyDisabled: !typedOk || busy } : null,
    saving: busy,
    saved: st.phase === "saved" ? st.saved : "",
    error: st.phase === "error" ? st.error : "",
  };
}

/** Auto-merge of one repo: read it, ask for the name, POST. Nothing is sent to turn it on until the confirm button is pressed with the exact name typed. */
export function createAutoMergeController({ call = api, signal, repoId, onChange = () => {} } = {}) {
  let st = { status: "loading", view: null, confirming: false, typed: "", phase: "idle", saved: "", error: "" };
  let gen = 0;
  const set = (patch) => {
    st = { ...st, ...patch };
    onChange();
  };
  async function load(quiet) {
    const mine = ++gen;
    try {
      const view = readAutoMerge(await call("GET", modeUrl(repoId), undefined, signal));
      if (mine !== gen) return;
      if (!view) return quiet && st.view ? undefined : set({ status: "error", view: null });
      // A repo that is no longer on the local runner, or already on, has nothing to confirm.
      set({ status: "ready", view, ...(view.mode !== "runner_local" || view.autoMerge ? { confirming: false, typed: "" } : {}) });
    } catch (e) {
      if (mine !== gen || cancelled(e)) return;
      if (!quiet || st.status !== "ready") set({ status: "error" });
    }
  }
  const begin = () => {
    const m = autoMergeModel(st);
    if (m.kind === "ready" && m.canTurnOn) set({ confirming: true, typed: "", phase: "idle", saved: "", error: "" });
  };
  // Typing repaints nothing (the view only flips the apply button), so focus never leaves the input.
  const type = (text) => {
    if (st.phase !== "saving") st = { ...st, typed: text };
  };
  const cancel = () => st.phase !== "saving" && set({ confirming: false, typed: "", phase: "idle", saved: "", error: "" });
  async function send(body, savedKey) {
    gen++; // a read still out must not overwrite this write
    set({ phase: "saving", error: "", saved: "" });
    try {
      const done = await call("POST", modeUrl(repoId), body, signal);
      const on = done && typeof done.auto_merge === "boolean" ? done.auto_merge : body.auto_merge;
      set({ view: { ...st.view, autoMerge: on }, confirming: false, typed: "", phase: "saved", saved: st.view.copy[savedKey], error: "" });
      load(true); // show what the server says now
    } catch (e) {
      if (cancelled(e)) return;
      const copy = st.view.copy;
      set({ phase: "error", error: autoMergeRefusal(e, copy), ...(e && e.status === 403 ? { view: { ...st.view, canChange: false }, confirming: false } : {}) });
      // The wording, the name or the mode moved under the user: show what is true now, keep their words about it.
      if (e && (e.status === 409 || e.status === 400)) load(true);
    }
  }
  function turnOn() {
    const m = autoMergeModel(st);
    if (m.kind !== "ready" || !m.confirm || m.confirm.applyDisabled) return; // a double press is one request
    return send({ auto_merge: true, confirm_repo: st.typed, copy_sha256: st.view.amHash }, "autoMergeSavedOn");
  }
  function turnOff() {
    const m = autoMergeModel(st);
    if (m.kind !== "ready" || !m.canTurnOff) return;
    return send({ auto_merge: false }, "autoMergeSavedOff");
  }
  return { load, begin, type, cancel, turnOn, turnOff, get state() { return st; } };
}

/** The view. `el` goes into the repo's settings; it repaints itself and keeps focus on the control the user was on. */
export function createAutoMergeControl({ call = api, signal, repoId, doc = document } = {}) {
  const el = h("fieldset", { class: "repos-mode", "data-testid": "repos-automerge" });
  const ctl = createAutoMergeController({ call, signal, repoId, onChange: () => paint() });
  const id = (s) => "repos-automerge-" + s;
  let focusError = false;
  let focusName = false;
  function paint() {
    const m = autoMergeModel(ctl.state);
    el.hidden = m.kind === "hidden";
    if (m.kind === "hidden") return el.replaceChildren();
    const v = ctl.state.view;
    const held = el.contains(doc.activeElement) ? doc.activeElement.id : "";
    const parts = [
      h("legend", { class: "repos-subtitle" }, v.copy.autoMergeTitle),
      h("p", { "data-testid": "repos-automerge-state" }, m.statusText),
      h("p", { class: "repos-muted", id: id("wording"), "data-testid": "repos-automerge-wording" }, m.wording)
    ];
    if (m.locked) parts.push(h("p", { id: id("locked"), class: "repos-muted", "data-testid": "repos-automerge-admin-only" }, v.copy.adminOnly));
    if (!m.locked && !m.confirm) {
      const label = m.on ? v.copy.autoMergeTurnOff : v.copy.autoMergeTurnOn;
      parts.push(h("div", { class: "repos-actions" },
        h("button", { type: "button", class: "repos-btn", id: id("toggle"), "data-testid": "repos-automerge-toggle", "aria-describedby": id("wording"), disabled: m.saving, onClick: () => (m.on ? ctl.turnOff() : ctl.begin()) }, m.saving ? v.copy.saving : label)));
    }
    if (m.confirm) {
      const input = h("input", {
        type: "text", id: id("name"), class: "repos-allow-name", autocomplete: "off", autocapitalize: "off", spellcheck: "false", value: ctl.state.typed, disabled: m.saving,
        "data-testid": "repos-automerge-name", "aria-describedby": id("name-help"),
        onInput: () => {
          ctl.type(input.value);
          const apply = el.querySelector("#" + id("apply"));
          if (apply) apply.setAttribute("aria-disabled", autoMergeModel(ctl.state).confirm.applyDisabled ? "true" : "false");
        },
      });
      parts.push(h("div", { class: "repos-confirm", role: "group", "aria-label": v.copy.autoMergeTurnOn, "data-testid": "repos-automerge-confirm" },
        h("label", { for: id("name"), id: id("name-help") }, v.copy.typeName, " ", h("bdi", null, v.fullName || "")),
        input,
        h("div", { class: "repos-actions" },
          h("button", { type: "button", class: "repos-btn", id: id("apply"), "data-testid": "repos-automerge-apply", "aria-disabled": m.confirm.applyDisabled ? "true" : "false", onClick: () => ctl.turnOn() }, m.saving ? v.copy.saving : v.copy.autoMergeTurnOn),
          h("button", { type: "button", class: "repos-btn", "data-testid": "repos-automerge-cancel", disabled: m.saving, onClick: () => ctl.cancel() }, v.copy.cancel))));
    }
    parts.push(h("p", { class: "repos-muted", role: "status", "data-testid": "repos-automerge-saved" }, m.saved));
    parts.push(h("p", { class: "repos-error", role: "alert", tabindex: "-1", id: id("error"), "data-testid": "repos-automerge-error" }, m.error));
    el.replaceChildren(...parts);
    // A new error takes focus once; opening the question puts focus on the name field; a repaint keeps focus where the user was.
    const toError = m.error && (!focusError || held === id("error"));
    focusError = !!m.error;
    const toName = !!m.confirm && !focusName && !toError;
    focusName = !!m.confirm;
    const target = toError ? el.querySelector("#" + id("error")) : toName ? el.querySelector("#" + id("name")) : held ? el.querySelector('[id="' + held + '"]') : null;
    if (target) {
      target.focus();
      if (target.tagName === "INPUT" && target.type === "text") target.setSelectionRange(target.value.length, target.value.length);
    }
  }
  paint();
  return { el, load: () => ctl.load(false), reload: () => ctl.load(true) };
}

// ── D#694 B7-2: the merge queue line and its help block for the open repo (kept in this file: a new file would pass the boot budget) ──
// The state is derived by the server on each read (never stored): on, off or unreadable; anything else, or a missing field, reads as "could not be read", never as off.
// Every sentence is fixed text drawn as a text node. The help is collapsed until the line's "About the merge queue" link opens it.
export const QUEUE_LINE = Object.freeze({
  on: "Merge queue: on (GitHub merges for you once it is queued)",
  off: "Merge queue: off",
  unreadable: "Merge queue: could not be read",
});
export const QUEUE_ABOUT = "About the merge queue";
export const QUEUE_RETRY = "Try again";

/** Each block of the help: a heading and short plain sentences. */
export const QUEUE_HELP = Object.freeze([
  { heading: "What the product does", text: "The product queues the pull request instead of merging it, whenever the repository has a merge queue. There is nothing to turn on." },
  { heading: "Your CI must run on merge_group", text: "The repository's CI workflows must run on `merge_group`, or queue entries never get checks. GitHub then removes the entry when its timeout passes, and the item shows \"GitHub removed it from the merge queue\"." },
  { heading: "Permissions", text: "The product needs no extra GitHub App permission." },
  { heading: "Human merge only", text: "\"Human merge only\" still wins: nothing is queued while it is on." },
  { heading: "Taking a pull request out", text: "Use \"Remove from queue\" on the item." },
  { heading: "In GitHub's merge queue", text: "On an item, \"In GitHub's merge queue\" means GitHub holds the pull request in its queue and merges it once its checks pass." },
  { heading: "How fresh this line is", text: "This line is read from GitHub at most once every 5 minutes. \"Try again\" within that time shows the same answer." },
]);

/** The settings' merge queue state: on or off only when the server said exactly that. */
export const queueState = (settings) => {
  const s = settings && typeof settings.merge_queue === "object" && settings.merge_queue !== null ? settings.merge_queue.state : undefined;
  return s === "on" || s === "off" ? s : "unreadable";
};

/** The line, its links and (when `open`) the help block. `onToggle` flips the help; `onRetry` re-reads the settings. */
export function queueView(settings, { open, onToggle, onRetry }) {
  const state = queueState(settings);
  const link = (label, testid, onClick, extra) => h("button", { type: "button", class: "repos-link", "data-testid": testid, onClick, ...extra }, label);
  return h("div", { class: "repos-queue", "data-testid": "repos-queue" },
    h("p", { class: "repos-queue-line", "data-testid": "repos-queue-line", "data-state": state }, QUEUE_LINE[state],
      state === "unreadable" ? [" ", link(QUEUE_RETRY, "repos-queue-retry", onRetry)] : [],
      " ", link(QUEUE_ABOUT, "repos-queue-about", onToggle, { "aria-expanded": open ? "true" : "false", ...(open ? { "aria-controls": "repos-queue-help" } : {}) })),
    open
      ? h("div", { id: "repos-queue-help", class: "repos-queue-help repos-muted", "data-testid": "repos-queue-help" },
          QUEUE_HELP.map((b) => h("section", null, h("h4", { class: "repos-queue-heading" }, b.heading), h("p", null, b.text))))
      : []);
}
