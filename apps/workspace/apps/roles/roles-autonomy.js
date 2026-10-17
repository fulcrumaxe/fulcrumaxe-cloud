// D#7 DP10b: the "Autonomy" view of the Roles app: the one place a customer sets how much the team decides alone. It reads and writes two
// stores through the API and never says so: the decision dials and presets (decision-settings, DP10a) and the answer window, the outcome
// when nobody answers and notify (ask-settings, DP12a-1's storage). Rules this file keeps:
//   * Every node is built with h(), so server text renders as text.
//   * Nothing is decided here. Which dials exist, which choices an entry allows, the window bounds, what a preset moves and what is in
//     effect all come from the responses; the fixed rules come from the same list the server's inventory test reads, and no control is
//     built for them.
//   * Names are the server's `label` fields. An id is never shown.
//   * A write is one POST for one change, and the page shows what the server answered. Nothing is deleted: the way back is another change
//     (a dial set back, a preset applied again, or "Use the default" on an answer setting).
//   * A member sees the same page with no controls. The server's 403 stays authoritative.
//   * A refresh never overwrites a change you have typed but not saved (drafts are drawn in preference to the server's value).
import { h } from "../_lib/dom.js";
import { api } from "../_lib/api.js";
import { onRefresh } from "../../core/cloud-live.js";
import { getItem, setItem } from "../../core/storage-ns.js";

// Draft copy: the customer-facing wording of the two oversight levels, as one block so it can be reviewed and changed in one place.
export const COPY = {
  levels:
    "Two levels of oversight apply here. For the decisions you can set below, the team acts and you monitor it, and you can reverse what it did. For the decisions that always ask you, the team never goes ahead without your approval.",
  rolesPointer: "To set the mode for each role, use the Roles tab.",
  fixed: "These rules are built into the system. They are not settings, and there is nothing to switch.",
  readOnly: "Only owners and admins can change these settings.",
};
export const DISPOSITION_TEXT = { ask: "Ask me first", announce: "Go ahead and tell me", act: "Go ahead" };
export const OUTCOME_TEXT = {
  stop_and_flag: "Keep waiting and flag it as overdue",
  proceed_recommended: "Go ahead with the agent's recommendation",
};
export const NOTIFY_TEXT = { email: "Email me", none: "Don't email me" };
const UNAVAILABLE = "Autonomy settings aren't available right now.";
const SAVE_FAILED = "That change couldn't be saved. Try again.";
const NOT_ALLOWED = "Only owners and admins can change these settings.";
const CHANGED = "That changed while you were saving. The latest settings are shown.";

export const word = (map, key) => (Object.prototype.hasOwnProperty.call(map, key) ? map[key] : key);

// The answer window box: empty means "use the default"; otherwise whole minutes inside the server's bounds.
export function parseWindow(raw, bounds) {
  const s = String(raw).trim();
  if (s === "") return { value: null };
  if (!/^\d+$/.test(s) || Number(s) < bounds.min_minutes || Number(s) > bounds.max_minutes) {
    return { error: "Enter whole minutes from " + bounds.min_minutes + " to " + bounds.max_minutes + ", or leave it empty." };
  }
  return { value: Number(s) };
}

// A failed write: a 422 carries the server's own explanation and the field it belongs to; anything else is a fixed sentence.
export function failureText(e) {
  if (e && e.status === 422) return e.message;
  if (e && e.status === 403) return NOT_ALLOWED;
  if (e && e.status === 409) return CHANGED;
  return SAVE_FAILED;
}

export function sourceText(dial, presets) {
  if (dial.source === "preset") {
    const p = presets.find((x) => x.name === dial.preset);
    return p ? "From the " + p.label + " preset" : "From a preset";
  }
  return dial.source === "override" ? "Changed by you" : "Default";
}

const repoPath = (id, tail) => "/api/v1/repos/" + encodeURIComponent(id) + "/" + tail;

export function mountAutonomy(host, ctx) {
  let repos = [];
  let repoId = null;
  let dial = null; // GET decision-settings
  let ask = null; // GET ask-settings
  let scope = "account";
  let preview = null; // { preset, label, customer_role, moves }
  let error = "";
  let note = ""; // the last save's confirmation
  let loading = false;
  let ctl = null;
  let seq = 0;
  let closed = false;
  let saving = false;
  let stale = false;
  const drafts = new Map(); // key -> typed, unsaved value
  const rowErrors = new Map(); // key -> text

  const status = h("p", { class: "au-status", role: "status", "aria-live": "polite", "data-testid": "au-status" });
  const picker = h("select", { class: "roles-repo", "aria-label": "Repo", "data-testid": "au-repo", onChange: () => choose(picker.value) });
  const body = h("div", { class: "au-body", "data-testid": "au-body" });
  host.replaceChildren(
    h("div", { class: "au-app" }, h("div", { class: "roles-head" }, h("h2", { class: "roles-title" }, "Autonomy"), picker), status, body)
  );

  const canChange = () => !!(dial && dial.can_change && ask && ask.can_change);
  const draft = (key, fallback) => (drafts.has(key) ? drafts.get(key) : fallback);
  const setDraft = (key) => (ev) => drafts.set(key, ev.target.value);

  function rowError(key) {
    const text = rowErrors.get(key);
    return text ? h("p", { class: "au-error", id: "au-err-" + key, role: "alert", "data-testid": "au-error" }, text) : null;
  }

  // ---- presets ----
  function presetSection() {
    const active = dial.presets.find((p) => p.name === dial.active_preset);
    const untouched = dial.dials.filter((d) => d.adjustable).every((d) => d.source === "default");
    const section = h("section", { class: "au-section", "aria-labelledby": "au-h-presets" }, h("h3", { class: "au-h", id: "au-h-presets" }, "Presets"));
    section.append(
      h("p", { class: "au-line", "data-testid": "au-active" }, active ? "Right now: " + active.label : untouched ? "Right now: the default settings." : "Right now: your own mix, which doesn't match a preset.")
    );
    if (!canChange()) {
      section.append(h("ul", { class: "au-list" }, dial.presets.map((p) => h("li", { class: "au-item" }, h("strong", null, p.label), " " + p.customer_role))));
      return section;
    }
    section.append(
      h(
        "div",
        { class: "au-presets", role: "group", "aria-label": "Presets" },
        dial.presets.map((p) =>
          h(
            "button",
            {
              type: "button",
              class: "au-preset",
              "aria-pressed": p.name === dial.active_preset ? "true" : "false",
              "data-focus": "preset-" + p.name,
              "data-testid": "au-preset-" + p.name,
              onClick: () => openPreview(p.name),
            },
            h("span", { class: "au-preset-name" }, p.label),
            h("span", { class: "au-preset-role" }, p.customer_role)
          )
        )
      )
    );
    if (!untouched) {
      section.append(
        h("div", { class: "au-actions" }, h("button", { type: "button", class: "rl-btn", "data-focus": "preset-reset", "data-testid": "au-reset-all", onClick: () => resetDial(null) }, "Use the defaults for all"))
      );
    }
    if (preview) {
      section.append(
        h(
          "div",
          { class: "au-preview", role: "group", "aria-labelledby": "au-preview-h", "data-testid": "au-preview" },
          h("h4", { class: "au-h", id: "au-preview-h", tabindex: -1, "data-focus": "preview" }, "Switch to " + preview.label + "?"),
          preview.moves.length === 0
            ? h("p", { class: "au-line", "data-testid": "au-preview-none" }, "Nothing changes. These decisions already match " + preview.label + ".")
            : h(
                "ul",
                { class: "au-list", "data-testid": "au-moves" },
                preview.moves.map((m) =>
                  h("li", { class: "au-item", "data-testid": "au-move" }, dialLabel(m.decision_type) + ": " + word(DISPOSITION_TEXT, m.from) + " to " + word(DISPOSITION_TEXT, m.to))
                )
              ),
          h("p", { class: "au-line au-muted" }, "Decisions that always ask you stay as they are."),
          h(
            "div",
            { class: "au-actions" },
            h("button", { type: "button", class: "rl-btn", "data-focus": "preview-apply", "data-testid": "au-preview-apply", onClick: applyPreset }, "Switch to " + preview.label),
            h("button", { type: "button", class: "rl-btn", "data-focus": "preview-cancel", "data-testid": "au-preview-cancel", onClick: closePreview }, "Cancel")
          ),
          rowError("preset")
        )
      );
    } else if (rowErrors.has("preset")) section.append(h("div", null, rowError("preset")));
    return section;
  }
  const dialLabel = (type) => {
    const d = dial.dials.find((x) => x.decision_type === type);
    return d ? d.label : "";
  };

  // ---- the decision dials ----
  function dialSection() {
    const adjustable = dial.dials.filter((d) => d.adjustable);
    const section = h("section", { class: "au-section", "aria-labelledby": "au-h-dials" }, h("h3", { class: "au-h", id: "au-h-dials" }, "Decisions you can set"));
    section.append(
      h(
        "ul",
        { class: "au-list", "data-testid": "au-dials" },
        adjustable.map((d) => {
          const key = "dial-" + d.decision_type;
          const chosen = draft(key, d.disposition);
          const control = canChange()
            ? h(
                "span",
                { class: "au-control" },
                h(
                  "select",
                  {
                    class: "roles-mode",
                    "aria-label": d.label,
                    "aria-invalid": rowErrors.has(key) ? "true" : null,
                    "aria-describedby": rowErrors.has(key) ? "au-err-" + key : null,
                    "data-focus": key,
                    "data-testid": "au-dial-select",
                    onChange: setDraft(key),
                  },
                  d.allowed_dispositions.map((v) => h("option", { value: v, selected: v === chosen }, word(DISPOSITION_TEXT, v)))
                ),
                h("button", { type: "button", class: "rl-btn", "aria-label": "Apply for " + d.label, "data-focus": key + "-apply", "data-testid": "au-dial-apply", onClick: () => saveDial(d) }, "Apply"),
                d.source === "default"
                  ? null
                  : h("button", { type: "button", class: "rl-btn", "aria-label": "Use the default for " + d.label, "data-focus": key + "-reset", "data-testid": "au-dial-reset", onClick: () => resetDial(d) }, "Use the default")
              )
            : h("span", { class: "au-value", "data-testid": "au-dial-value" }, word(DISPOSITION_TEXT, d.disposition));
          return h(
            "li",
            { class: "au-item au-row", "data-dial": d.decision_type, "data-testid": "au-dial" },
            h("span", { class: "au-name" }, d.label),
            control,
            h("span", { class: "au-muted" }, sourceText(d, dial.presets)),
            rowError(key)
          );
        })
      )
    );
    const fixed = (title, cls, text) =>
      h(
        "div",
        { class: "au-fixed" },
        h("h4", { class: "au-h" }, title),
        h("ul", { class: "au-list", "data-testid": "au-fixed-" + cls }, dial.dials.filter((d) => d.class === cls).map((d) => h("li", { class: "au-item" }, d.label + ": " + text)))
      );
    section.append(
      fixed("Always asks you", "human_in_the_loop", "the team always asks you first"),
      fixed("Always done for you", "automated_with_monitoring", "done automatically and shown in your digest")
    );
    return section;
  }

  // ---- the fixed rules ----
  function invariantSection() {
    return h(
      "section",
      { class: "au-section", "aria-labelledby": "au-h-fixed" },
      h("h3", { class: "au-h", id: "au-h-fixed" }, "Fixed rules, not settings"),
      h("p", { class: "au-line au-muted" }, COPY.fixed),
      h("ul", { class: "au-list", "data-testid": "au-invariants" }, dial.invariants.map((i) => h("li", { class: "au-item", "data-testid": "au-invariant" }, i.label)))
    );
  }

  // ---- when an agent asks a question ----
  function askSection() {
    const bounds = ask.bounds;
    const wide = scope === "account";
    const section = h("section", { class: "au-section", "aria-labelledby": "au-h-ask" }, h("h3", { class: "au-h", id: "au-h-ask" }, "When an agent asks you a question"));
    const repoName = (repos.find((r) => r.id === repoId) || {}).product || "this repo";
    if (canChange()) {
      section.append(
        h(
          "label",
          { class: "au-field" },
          h("span", null, "Apply to"),
          h(
            "select",
            { class: "roles-mode", "data-focus": "scope", "data-testid": "au-scope", onChange: (ev) => changeScope(ev.target.value) },
            h("option", { value: "account", selected: wide }, "All repos"),
            h("option", { value: "repo", selected: !wide }, repoName)
          )
        )
      );
    }
    const accountStar = ask.rows.find((r) => r.decision_type === "*").account;
    const notifyKey = "notify";
    const notifyNow = draft(notifyKey, (accountStar && accountStar.notify) || ask.notify_default);
    section.append(
      canChange()
        ? h(
            "div",
            { class: "au-row", "data-testid": "au-notify-row" },
            h(
              "label",
              { class: "au-field" },
              h("span", { class: "au-name" }, "Tell me when an agent asks"),
              h(
                "select",
                { class: "roles-mode", "data-focus": notifyKey, "data-testid": "au-notify", onChange: setDraft(notifyKey) },
                ask.notify_values.map((v) => h("option", { value: v, selected: v === notifyNow }, word(NOTIFY_TEXT, v)))
              )
            ),
            h("button", { type: "button", class: "rl-btn", "data-focus": "notify-apply", "data-testid": "au-notify-apply", onClick: () => saveNotify(accountStar) }, "Apply"),
            h("span", { class: "au-muted" }, "Applies to every repo."),
            rowError(notifyKey)
          )
        : h("p", { class: "au-line", "data-testid": "au-notify-value" }, "Notifications: " + word(NOTIFY_TEXT, ask.rows[1].effective.notify)),
      h("p", { class: "au-line au-muted" }, "Nothing is denied because nobody answered. After the answer window the team either keeps waiting, or, only where it is allowed, goes ahead with the agent's recommendation.")
    );
    section.append(
      h(
        "ul",
        { class: "au-list", "data-testid": "au-ask-rows" },
        ask.rows.map((r) => {
          const key = "ask-" + r.decision_type;
          const win = draft(key + "-window", shownWindow(r));
          const out = draft(key + "-outcome", shownOutcome(r));
          const now = r.effective
            ? "In effect: " + r.effective.answer_window_text + ", then " + word(OUTCOME_TEXT, r.effective.timeout_outcome).toLowerCase()
            : "Used by every decision type below unless it has its own.";
          return h(
            "li",
            { class: "au-item au-row au-ask", "data-ask": r.decision_type, "data-testid": "au-ask" },
            h("span", { class: "au-name" }, r.label),
            h("span", { class: "au-muted", "data-testid": "au-now" }, now),
            canChange()
              ? h(
                  "span",
                  { class: "au-control" },
                  h(
                    "label",
                    { class: "au-field" },
                    h("span", null, "Answer window (minutes)"),
                    h("input", {
                      class: "rl-input",
                      type: "text",
                      inputMode: "numeric",
                      value: win,
                      placeholder: "default",
                      "aria-label": "Answer window in minutes for " + r.label,
                      "aria-invalid": rowErrors.has(key) ? "true" : null,
                      "aria-describedby": rowErrors.has(key) ? "au-err-" + key : null,
                      "data-focus": key + "-window",
                      "data-testid": "au-window",
                      onInput: setDraft(key + "-window"),
                    })
                  ),
                  h(
                    "label",
                    { class: "au-field" },
                    h("span", null, "If nobody answers"),
                    h(
                      "select",
                      { class: "roles-mode", "aria-label": "Outcome when nobody answers for " + r.label, "data-focus": key + "-outcome", "data-testid": "au-outcome", onChange: setDraft(key + "-outcome") },
                      h("option", { value: "", selected: out === "" }, "Use the default"),
                      r.allowed_outcomes.map((v) => h("option", { value: v, selected: v === out }, word(OUTCOME_TEXT, v)))
                    )
                  ),
                  h("button", { type: "button", class: "rl-btn", "aria-label": "Save settings for " + r.label, "data-focus": key + "-save", "data-testid": "au-ask-save", onClick: () => saveAsk(r) }, "Save"),
                  h("button", { type: "button", class: "rl-btn", "aria-label": "Use the defaults for " + r.label, "data-focus": key + "-clear", "data-testid": "au-ask-clear", onClick: () => clearAsk(r) }, "Use the default")
                )
              : null,
            h("span", { class: "au-hint au-muted" }, "Window: " + bounds.min_minutes + " to " + bounds.max_minutes + " minutes."),
            rowError(key)
          );
        })
      )
    );
    return section;
  }

  // ---- drawing, keeping focus where the customer was ----
  function render() {
    const at = document.activeElement;
    const focusKey = at && body.contains(at) ? at.getAttribute("data-focus") : null;
    status.textContent = error || note;
    status.classList.toggle("au-failed", !!error);
    picker.replaceChildren(...repos.map((r) => h("option", { value: r.id, selected: r.id === repoId }, r.product)));
    picker.hidden = repos.length === 0;
    if (!dial || !ask) {
      body.replaceChildren();
      return;
    }
    body.replaceChildren(
      h("p", { class: "au-line", "data-testid": "au-levels" }, COPY.levels),
      h("p", { class: "au-line au-muted", "data-testid": "au-roles-pointer" }, COPY.rolesPointer),
      ...(canChange() ? [] : [h("p", { class: "au-line au-muted", "data-testid": "au-readonly" }, COPY.readOnly)]),
      presetSection(),
      dialSection(),
      askSection(),
      invariantSection()
    );
    focusAt(focusKey);
  }
  function focusAt(key) {
    if (!key) return;
    const el = body.querySelector('[data-focus="' + key + '"]');
    if (!el) return;
    el.focus();
    if (el.tagName === "INPUT" && typeof el.value === "string") el.setSelectionRange(el.value.length, el.value.length);
  }

  // ---- loading ----
  function begin() {
    if (ctl) ctl.abort();
    ctl = new AbortController();
    loading = true;
    return { mine: ++seq, signal: ctl.signal };
  }
  async function loadView(signal) {
    const [d, a] = await Promise.all([api("GET", repoPath(repoId, "decision-settings"), undefined, signal), api("GET", repoPath(repoId, "ask-settings"), undefined, signal)]);
    dial = d;
    ask = a;
  }
  async function load() {
    const { mine, signal } = begin();
    try {
      repos = await ctx.loadRepos(signal);
      if (mine !== seq) return;
      const saved = getItem(ctx.repoKey);
      if (!repos.some((r) => r.id === repoId)) repoId = repos.some((r) => r.id === saved) ? saved : repos.length ? repos[0].id : null;
      if (repoId) await loadView(signal);
      else {
        dial = null;
        ask = null;
      }
      if (mine !== seq) return;
      error = repoId ? "" : "No repos are installed yet.";
    } catch (e) {
      if ((e && e.name === "AbortError") || mine !== seq) return;
      dial = null;
      ask = null;
      error = UNAVAILABLE;
    }
    loading = false;
    render();
  }
  async function choose(id) {
    repoId = id;
    dial = null;
    ask = null;
    preview = null;
    drafts.clear();
    rowErrors.clear();
    render();
    setItem(ctx.repoKey, id);
    const { mine, signal } = begin();
    try {
      await loadView(signal);
      error = "";
    } catch (e) {
      if ((e && e.name === "AbortError") || mine !== seq) return;
      error = UNAVAILABLE;
    }
    if (mine === seq) {
      loading = false;
      render();
    }
  }
  function changeScope(value) {
    scope = value === "repo" ? "repo" : "account";
    for (const k of [...drafts.keys()]) if (k.startsWith("ask-")) drafts.delete(k);
    render();
  }

  // ---- writes: one POST for one change ----
  async function write(key, run, done) {
    if (saving || !repoId) return;
    saving = true;
    rowErrors.delete(key);
    note = "";
    status.textContent = "";
    // A refresh already on its way would land over this change: drop it and redo it after.
    if (loading && ctl) {
      ctl.abort();
      seq++;
      loading = false;
      stale = true;
    }
    body.setAttribute("aria-busy", "true");
    let failed = false;
    try {
      await run();
      for (const k of [...drafts.keys()]) if (k === key || k.startsWith(key + "-")) drafts.delete(k);
    } catch (e) {
      failed = true;
      rowErrors.set(key, failureText(e));
      if (e && e.status === 409) stale = true;
    }
    saving = false;
    body.removeAttribute("aria-busy");
    if (closed) return;
    error = "";
    note = !failed && done ? done() : "";
    render();
    if (stale) {
      stale = false;
      load();
    }
  }
  const saveDial = (d) => {
    const key = "dial-" + d.decision_type;
    const value = draft(key, d.disposition);
    return write(key, async () => {
      dial = await api("POST", repoPath(repoId, "decision-settings/dial"), { decision_type: d.decision_type, disposition: value });
      ask = await api("GET", repoPath(repoId, "ask-settings"));
    }, () => d.label + ": " + word(DISPOSITION_TEXT, value) + ". Saved.");
  };
  // "Use the default": the server writes the catalogue default back; the read then says Default. `d` is one dial, or null for every dial.
  const resetDial = (d) => {
    const key = d ? "dial-" + d.decision_type : "preset";
    return write(key, async () => {
      dial = await api("POST", repoPath(repoId, "decision-settings/reset"), d ? { decision_type: d.decision_type } : {});
      ask = await api("GET", repoPath(repoId, "ask-settings"));
    }, () => (d ? d.label + ": back to the default. Saved." : "All decisions are back to the default. Saved."));
  };
  async function openPreview(name) {
    if (saving) return;
    rowErrors.delete("preset");
    try {
      preview = await api("POST", repoPath(repoId, "decision-settings/preset/preview"), { preset: name });
    } catch (e) {
      preview = null;
      rowErrors.set("preset", failureText(e));
    }
    render();
    focusAt(preview ? "preview" : "preset-" + name);
  }
  function closePreview() {
    const back = preview ? "preset-" + preview.preset : null;
    preview = null;
    render();
    focusAt(back);
  }
  const applyPreset = async () => {
    const chosen = preview;
    await write("preset", async () => {
      dial = await api("POST", repoPath(repoId, "decision-settings/preset"), { preset: chosen.preset });
      ask = await api("GET", repoPath(repoId, "ask-settings"));
      preview = null;
    }, () => chosen.label + " applied. " + (dial.moved.length === 1 ? "1 decision changed." : dial.moved.length + " decisions changed."));
    // The Switch button is gone once the preview closes, so focus would drop to the page: put it back on the preset that opened the preview (WCAG 2.4.3).
    if (chosen && !preview && !closed) focusAt("preset-" + chosen.preset);
  };
  // What the chosen scope has stored for a row (null fields inherit), and how the boxes show it before anything is typed.
  const storedAsk = (r) => (scope === "repo" ? r.repo : r.account) || { answer_window_minutes: null, timeout_outcome: null, notify: null };
  const shownWindow = (r) => (storedAsk(r).answer_window_minutes != null ? String(storedAsk(r).answer_window_minutes) : "");
  const shownOutcome = (r) => storedAsk(r).timeout_outcome || "";
  const askBody = (type, patch) => {
    const stored = storedAsk(ask.rows.find((r) => r.decision_type === type));
    return { scope, decision_type: type, answer_window_minutes: stored.answer_window_minutes, timeout_outcome: stored.timeout_outcome, notify: stored.notify, ...patch };
  };
  const postAsk = async (b) => {
    ask = await api("POST", repoPath(repoId, "ask-settings"), b);
  };
  function saveAsk(r) {
    const key = "ask-" + r.decision_type;
    const parsed = parseWindow(draft(key + "-window", shownWindow(r)), ask.bounds);
    if (parsed.error) {
      rowErrors.set(key, parsed.error);
      render();
      focusAt(key + "-window");
      return;
    }
    const outcome = draft(key + "-outcome", shownOutcome(r)) || null;
    return write(key, () => postAsk(askBody(r.decision_type, { answer_window_minutes: parsed.value, timeout_outcome: outcome })), () => r.label + ": saved.");
  }
  function clearAsk(r) {
    const key = "ask-" + r.decision_type;
    for (const k of [key + "-window", key + "-outcome"]) drafts.delete(k);
    return write(key, () => postAsk(askBody(r.decision_type, { answer_window_minutes: null, timeout_outcome: null })), () => r.label + ": using the default.");
  }
  function saveNotify(accountStar) {
    const value = draft("notify", (accountStar && accountStar.notify) || ask.notify_default);
    const stored = accountStar || { answer_window_minutes: null, timeout_outcome: null };
    return write("notify", () => postAsk({ scope: "account", decision_type: "*", answer_window_minutes: stored.answer_window_minutes, timeout_outcome: stored.timeout_outcome, notify: value }), () => word(NOTIFY_TEXT, value) + ". Saved.");
  }

  // A refresh waits for a save in flight. It cannot land over typed, unsaved changes: the page draws a draft in preference to the server's value.
  const off = onRefresh(() => {
    if (saving) stale = true;
    else load();
  });
  load();

  return {
    destroy() {
      closed = true;
      off();
      seq++;
      if (ctl) ctl.abort();
      host.replaceChildren();
    },
  };
}
