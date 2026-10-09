// D#6 R2b-4b: the Runners section of the Repos app, and the runner-run setting in a repo's settings.
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
export const STATE_WORDS = { online_idle: "Online", busy: "Busy", offline: "Offline", outdated: "Needs an update", revoked: "Revoked" };
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
  return { load, save, get state() { return st; } };
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
