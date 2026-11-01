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

// ---- D#483 S5-h: the numbers behind "how much the team may do on its own", on the Autonomy view of the Roles app: how many items build at once
// (the account and the open repo), the weekly auto-start limit, the default margin and how often the repo is discovered again. This file
// reads and writes through the existing routes and decides nothing:
//   * Labels, the sentences about missing estimates, the discovery choices and the cost figures come from the responses. No id is shown.
//   * A change to "Builds at once" is previewed by the server first; Accept sends the preview's hash. A 409 means the figures moved: the
//     fresh preview is fetched and shown in place, and nothing was written.
//   * Every save is one request. Nothing is updated or deleted here: the way back is saving the earlier value, which the server records as
//     a new version. A member sees the same rows with no control.

export const LIM_COPY = {
  heading: "Builds, auto-start and discovery",
  perRepo: "This applies once parallel builds on one repo are supported.",
  unavailable: "This setting isn't available right now.",
  notChanged: "Not changed yet.",
  readOnly: "Only owners and admins can change these settings.",
  stale: "What the preview showed has changed. Check the new figures, then accept again.",
  failed: "That change couldn't be saved. Try again.",
  forbidden: "Only owners and admins can change these settings.",
};
export const BASIS_TEXT = { history: "your recent runs", seed: "the starting estimate", none: "nothing yet, so there is no price" };
export const SOURCE_TEXT = { setting: "Set by you", plan_data: "The default", none: "Nothing added" };
const MAX_INT = 2147483647;
const MAX_WEEKLY = 99999999;

const limWord = (map, key) => (Object.prototype.hasOwnProperty.call(map, key) ? map[key] : "");

// ---- pure rules (unit-tested) ----
export function fmtCents(cents) {
  if (typeof cents !== "number" || !Number.isFinite(cents)) return "";
  return (cents < 0 ? "-" : "") + "$" + (Math.abs(cents) / 100).toFixed(2);
}
export function fmtUsd(usd) {
  return typeof usd === "number" && Number.isFinite(usd) ? fmtCents(Math.round(usd * 100)) : "";
}
export function fmtMinutes(m) {
  if (typeof m !== "number" || !Number.isFinite(m)) return "";
  if (m < 60) return m + (m === 1 ? " minute" : " minutes");
  const hours = Math.floor(m / 60);
  const rest = m % 60;
  return hours + (hours === 1 ? " hour" : " hours") + (rest ? " " + rest + (rest === 1 ? " minute" : " minutes") : "");
}
/** A date and time in the viewer's own zone. */
export function fmtWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "an unknown date";
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
export function historyLine(c) {
  return "Changed from " + c.from + " to " + c.to + " by " + c.changed_by_name + " on " + fmtWhen(c.changed_at);
}
const twoDecimals = (n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
export function parseCount(raw) {
  const s = String(raw).trim();
  if (!/^\d+$/.test(s) || Number(s) < 1 || Number(s) > MAX_INT) return { error: "Builds at once: enter a whole number of 1 or more." };
  return { value: Number(s) };
}
function parseNumber(raw, name, max) {
  const s = String(raw).trim();
  if (!/^\d+(\.\d+)?$/.test(s) || Number(s) > max || !twoDecimals(Number(s))) return { error: name + ": enter a number from 0 to " + max.toLocaleString("en-US") + " with at most two decimals." };
  return { value: Number(s) };
}
export const parseWeekly = (raw) => parseNumber(raw, "Weekly auto-start limit", MAX_WEEKLY);
export const parseMargin = (raw) => parseNumber(raw, "Default margin", 500);

/** The lines of a build-limit preview: only figures the server sent are written. */
export function previewFacts(p) {
  const facts = [];
  if (Number.isFinite(p.clear_minutes_old) && Number.isFinite(p.clear_minutes_new)) {
    facts.push("Time to clear the queue: " + fmtMinutes(p.clear_minutes_old) + " now, " + fmtMinutes(p.clear_minutes_new) + " after this change");
  }
  if (Number.isFinite(p.extra_per_hour_cents)) facts.push("Extra spend per hour: " + fmtCents(p.extra_per_hour_cents));
  if (Number.isFinite(p.extra_per_day_cents)) facts.push("Extra spend per day: " + fmtCents(p.extra_per_day_cents));
  if (Number.isFinite(p.queue_total_cents)) facts.push("Whole queue: " + fmtCents(p.queue_total_cents));
  if (Number.isFinite(p.unpriced_items)) facts.push("Items with no estimate: " + p.unpriced_items);
  const basis = limWord(BASIS_TEXT, p.basis);
  if (basis) facts.push("Priced from: " + basis);
  return facts;
}

/** The figures the person was shown when they accepted a raise, from the stored preview; nothing for a lowering's short record. */
export function shownFacts(c) {
  const facts = c && c.preview && typeof c.preview === "object" ? previewFacts(c.preview) : [];
  return facts.length ? h("ul", { class: "au-list", "data-testid": "lim-shown" }, facts.map((t) => h("li", { class: "au-muted" }, "Shown: " + t))) : null;
}

export function limFailureText(e) {
  if (e && e.status === 422) return e.message;
  if (e && e.status === 403) return LIM_COPY.forbidden;
  if (e && e.status === 400) return e.message;
  return LIM_COPY.failed;
}

const ACCOUNT = "/api/v1/account/";

export function mountLimits(host) {
  let repoId = null;
  let can = false;
  let closed = false;
  let seq = 0;
  let saving = false;
  let d = {}; // acct, acctHist, repo, repoHist, auto, margin, disc: a response, or null when it could not be read
  let loaded = false;
  const drafts = new Map();
  const errors = new Map();
  const previews = new Map(); // "acct" | "repo" -> the preview on screen
  const confirmed = new Set();
  let note = "";

  const status = h("p", { class: "au-status", role: "status", "aria-live": "polite", "data-testid": "lim-status" });
  const body = h("div", { class: "au-body", "data-testid": "lim-body" });
  host.replaceChildren(h("section", { class: "au-section", "aria-labelledby": "lim-h" }, h("h3", { class: "au-h", id: "lim-h" }, LIM_COPY.heading), status, body));

  const draft = (key, fallback) => (drafts.has(key) ? drafts.get(key) : fallback);
  const setDraft = (key) => (ev) => drafts.set(key, ev.target.value);
  const err = (key) => (errors.has(key) ? h("p", { class: "au-error", id: "lim-err-" + key, role: "alert", "data-testid": "lim-error" }, errors.get(key)) : null);
  const bad = (key) => (errors.has(key) ? "true" : null);
  const described = (key) => (errors.has(key) ? "lim-err-" + key : null);
  const unavailable = () => h("span", { class: "au-muted", "data-testid": "lim-unavailable" }, LIM_COPY.unavailable);
  const btn = (label, aria, focus, test, onClick) => h("button", { type: "button", class: "rl-btn", "aria-label": aria, "data-focus": focus, "data-testid": test, onClick }, label);
  const input = (key, label, value, extra) =>
    h("label", { class: "au-field" }, h("span", null, label), h("input", { class: "rl-input", type: "text", inputMode: "decimal", value, "aria-label": label, "aria-invalid": bad(key), "aria-describedby": described(key), "data-focus": key + "-input", "data-testid": "lim-" + key + "-input", onInput: setDraft(key), ...extra }));

  // ---- one row: name, what is in force, the control ----
  const row = (key, name, ...parts) => h("li", { class: "au-item au-row", "data-testid": "lim-row", "data-row": key }, h("span", { class: "au-name" }, name), ...parts, err(key));

  function concurrencyRow(key, name, value, hist) {
    if (!value) return row(key, name, unavailable());
    const base = key === "acct" ? ACCOUNT + "build-concurrency" : repoPath(repoId, "build-concurrency");
    const p = previews.get(key);
    const parts = [
      h("span", { class: "au-value", "data-testid": "lim-" + key + "-value" }, "Now: " + value.value),
      h("span", { class: "au-muted" }, "Starting value: " + value.start_value),
    ];
    if (value.clamp_reason) parts.push(h("span", { class: "au-hint au-muted", "data-testid": "lim-repo-scope" }, LIM_COPY.perRepo));
    if (can) {
      parts.push(
        h("span", { class: "au-control" }, input(key, name + " (new number)", draft(key, String(value.value))), btn("Review change", "Review the change to " + name, key + "-review", "lim-" + key + "-review", () => review(key, base)))
      );
    }
    if (p) {
      parts.push(
        h(
          "div",
          { class: "au-preview", role: "group", "aria-labelledby": "lim-ph-" + key, "data-testid": "lim-" + key + "-preview" },
          h("h4", { class: "au-h", id: "lim-ph-" + key, tabindex: -1, "data-focus": key + "-preview" }, name + ": " + p.from + " to " + p.to + "?"),
          h("ul", { class: "au-list" }, previewFacts(p).map((t) => h("li", { class: "au-item", "data-testid": "lim-fact" }, t))),
          h("ul", { class: "au-list" }, (p.notes || []).map((n) => h("li", { class: "au-item au-muted", "data-testid": "lim-note" }, n.text))),
          h("div", { class: "au-actions" }, btn("Accept and save", "Accept the change to " + name, key + "-accept", "lim-" + key + "-accept", () => accept(key, base)), btn("Cancel", "Cancel the change to " + name, key + "-cancel", "lim-" + key + "-cancel", () => cancel(key)))
        )
      );
    }
    parts.push(
      h("ul", { class: "au-list", "aria-label": "Recent changes to " + name, "data-testid": "lim-" + key + "-history" }, hist && hist.changes.length ? hist.changes.map((c) => h("li", { class: "au-item au-muted", "data-testid": "lim-change" }, historyLine(c), shownFacts(c))) : h("li", { class: "au-item au-muted" }, LIM_COPY.notChanged))
    );
    return row(key, name, ...parts);
  }

  function weeklyRow() {
    const a = d.auto;
    if (!a) return row("auto", "Weekly auto-start limit", unavailable());
    const parts = [
      h("span", { class: "au-value", "data-testid": "lim-auto-value" }, a.enabled ? "Now: " + fmtUsd(a.amount_usd) + " a week. Spent this week: " + fmtUsd(a.spent_this_week_usd) + ". Left: " + fmtUsd(a.remaining_this_week_usd) + "." : a.off_sentence || "Auto-start is off."),
      h("span", { class: "au-hint au-muted" }, a.note),
    ];
    if (can) {
      const amount = draft("auto", a.enabled ? String(a.amount_usd) : "");
      parts.push(
        h(
          "span",
          { class: "au-control" },
          input("auto", "Weekly auto-start limit in dollars", amount),
          h("label", { class: "au-field" }, h("input", { type: "checkbox", checked: confirmed.has("auto"), "data-focus": "auto-confirm", "data-testid": "lim-auto-confirm", onChange: (ev) => (ev.target.checked ? confirmed.add("auto") : confirmed.delete("auto")) }), h("span", null, "I confirm this weekly limit")),
          btn("Save", "Save the weekly auto-start limit", "auto-save", "lim-auto-save", saveWeekly),
          a.enabled ? btn("Turn off", "Turn auto-start off", "auto-off", "lim-auto-off", () => putWeekly(0, false)) : null
        )
      );
    }
    return row("auto", "Weekly auto-start limit", ...parts);
  }

  function marginRow() {
    const m = d.margin;
    if (!m) return row("margin", "Default margin", unavailable());
    const parts = [
      h("span", { class: "au-value", "data-testid": "lim-margin-value" }, m.margin_pct == null ? "Now: no margin is added to an estimate" : "Now: " + m.margin_pct + "%"),
      h("span", { class: "au-muted" }, limWord(SOURCE_TEXT, m.source)),
    ];
    if (can) {
      parts.push(
        h(
          "span",
          { class: "au-control" },
          input("margin", "Default margin in percent", draft("margin", m.margin_pct == null ? "" : String(m.margin_pct))),
          btn("Save", "Save the default margin", "margin-save", "lim-margin-save", saveMargin),
          m.source === "setting" && m.plan_default_pct != null ? btn("Use the default (" + m.plan_default_pct + "%)", "Use the default margin", "margin-default", "lim-margin-default", () => putMargin(m.plan_default_pct)) : null
        )
      );
    }
    return row("margin", "Default margin", ...parts);
  }

  function discoveryRow() {
    const x = d.disc;
    if (!x || !Array.isArray(x.options)) return row("disc", "Discovery frequency", unavailable());
    const parts = [h("span", { class: "au-value", "data-testid": "lim-disc-value" }, "Now: " + x.label)];
    if (can) {
      const chosen = draft("disc", x.frequency);
      parts.push(
        h(
          "span",
          { class: "au-control" },
          h("label", { class: "au-field" }, h("span", null, "Discovery frequency"), h("select", { class: "roles-mode", "aria-label": "Discovery frequency", "aria-invalid": bad("disc"), "aria-describedby": described("disc"), "data-focus": "disc-select", "data-testid": "lim-disc-select", onChange: setDraft("disc") }, x.options.map((o) => h("option", { value: o.value, selected: o.value === chosen }, o.label)))),
          btn("Apply", "Apply the discovery frequency", "disc-apply", "lim-disc-apply", saveDisc)
        )
      );
    }
    return row("disc", "Discovery frequency", ...parts);
  }

  function render() {
    const at = document.activeElement;
    const focusKey = at && body.contains(at) ? at.getAttribute("data-focus") : null;
    status.textContent = note;
    if (!loaded) {
      body.replaceChildren();
      return;
    }
    body.replaceChildren(
      ...(can ? [] : [h("p", { class: "au-line au-muted", "data-testid": "lim-readonly" }, LIM_COPY.readOnly)]),
      h("ul", { class: "au-list", "data-testid": "lim-rows" }, concurrencyRow("acct", "Builds at once (whole account)", d.acct, d.acctHist), concurrencyRow("repo", "Builds at once (this repo)", d.repo, d.repoHist), weeklyRow(), marginRow(), discoveryRow())
    );
    focus(focusKey);
  }
  function focus(key) {
    const el = key ? body.querySelector('[data-focus="' + key + '"]') : null;
    if (el) el.focus();
  }

  // ---- reading ----
  const read = (path, ok) => api("GET", path).then((v) => (v && ok(v) ? v : null), () => null);
  const isConc = (v) => typeof v.value === "number" && typeof v.start_value === "number";
  const isHist = (v) => Array.isArray(v.changes);
  async function refreshConcurrency(key) {
    const base = key === "acct" ? ACCOUNT + "build-concurrency" : repoPath(repoId, "build-concurrency");
    const [v, hist] = await Promise.all([read(base, isConc), read(base + "/history", isHist)]);
    d = { ...d, [key]: v, [key + "Hist"]: hist };
  }
  async function loadAll() {
    const mine = ++seq;
    const [acct, acctHist, repo, repoHist, auto, margin, disc] = await Promise.all([
      read(ACCOUNT + "build-concurrency", isConc),
      read(ACCOUNT + "build-concurrency/history", isHist),
      read(repoPath(repoId, "build-concurrency"), isConc),
      read(repoPath(repoId, "build-concurrency/history"), isHist),
      read(ACCOUNT + "autostart-envelope", (v) => typeof v.amount_usd === "number"),
      read(ACCOUNT + "envelope-margin", (v) => "margin_pct" in v),
      read(repoPath(repoId, "discovery"), (v) => typeof v.frequency === "string"),
    ]);
    if (closed || mine !== seq) return;
    d = { acct, acctHist, repo, repoHist, auto, margin, disc };
    loaded = true;
    render();
  }

  // ---- writing: one request per change ----
  async function commit(key, run, done) {
    if (saving) return false;
    saving = true;
    errors.delete(key);
    note = "";
    body.setAttribute("aria-busy", "true");
    let ok = true;
    try {
      await run();
      drafts.delete(key);
      confirmed.delete(key);
      note = done;
    } catch (e) {
      ok = false;
      errors.set(key, limFailureText(e));
    }
    saving = false;
    body.removeAttribute("aria-busy");
    if (!closed) render();
    return ok;
  }
  async function review(key, base) {
    errors.delete(key);
    const parsed = parseCount(draft(key, String(d[key].value)));
    if (parsed.error) return fail(key, parsed.error, key + "-input");
    if (parsed.value === d[key].value) return fail(key, "Builds at once: that is already the number in force.", key + "-input");
    try {
      previews.set(key, await api("POST", base + "/preview", { max_builds: parsed.value }));
    } catch (e) {
      previews.delete(key);
      errors.set(key, limFailureText(e));
    }
    render();
    focus(previews.has(key) ? key + "-preview" : key + "-review");
  }
  function cancel(key) {
    previews.delete(key);
    errors.delete(key);
    render();
    focus(key + "-review");
  }
  async function accept(key, base) {
    const p = previews.get(key);
    let stale = false;
    const ok = await commit(
      key,
      async () => {
        try {
          await api("PUT", base, { max_builds: p.to, accept: true, preview_hash: p.preview_hash });
        } catch (e) {
          if (e && e.status === 409) {
            stale = true;
            // Nothing was written. Show the figures as they are now; the person decides again.
            previews.set(key, await api("POST", base + "/preview", { max_builds: p.to }));
            throw Object.assign(new Error(LIM_COPY.stale), { status: 0 });
          }
          throw e;
        }
        previews.delete(key);
        await refreshConcurrency(key);
      },
      "Builds at once: saved."
    );
    if (stale) {
      errors.set(key, LIM_COPY.stale);
      render();
      focus(key + "-preview");
    } else if (ok) focus(key + "-review");
  }
  function fail(key, text, focusKey) {
    errors.set(key, text);
    render();
    focus(focusKey);
  }
  function saveWeekly() {
    const parsed = parseWeekly(draft("auto", d.auto.enabled ? String(d.auto.amount_usd) : ""));
    if (parsed.error) return fail("auto", parsed.error, "auto-input");
    if (parsed.value > 0 && !confirmed.has("auto")) return fail("auto", "Weekly auto-start limit: confirm the weekly limit to turn auto-start on.", "auto-confirm");
    return putWeekly(parsed.value, parsed.value > 0);
  }
  const putWeekly = (amount, confirm) =>
    commit("auto", async () => {
      d = { ...d, auto: await api("PUT", ACCOUNT + "autostart-envelope", confirm ? { amount_usd: amount, confirm: true } : { amount_usd: amount }) };
    }, amount > 0 ? "Weekly auto-start limit: saved." : "Auto-start is off. Saved.");
  function saveMargin() {
    const parsed = parseMargin(draft("margin", d.margin.margin_pct == null ? "" : String(d.margin.margin_pct)));
    if (parsed.error) return fail("margin", parsed.error, "margin-input");
    return putMargin(parsed.value);
  }
  const putMargin = (pct) =>
    commit("margin", async () => {
      d = { ...d, margin: await api("PUT", ACCOUNT + "envelope-margin", { margin_pct: pct }) };
    }, "Default margin: saved.");
  const saveDisc = () =>
    commit("disc", async () => {
      d = { ...d, disc: await api("PUT", repoPath(repoId, "discovery"), { frequency: draft("disc", d.disc.frequency) }) };
    }, "Discovery frequency: saved.");

  return {
    /** Called by the Autonomy view whenever it has the open repo's settings. Typed drafts survive; a different repo starts clean. */
    load(id, canChange) {
      if (id !== repoId) {
        drafts.clear();
        errors.clear();
        previews.clear();
        confirmed.clear();
        loaded = false;
        note = "";
      }
      repoId = id;
      can = !!canChange;
      host.hidden = false;
      render();
      return loadAll();
    },
    clear() {
      seq++;
      repoId = null;
      loaded = false;
      host.hidden = true;
      body.replaceChildren();
    },
    destroy() {
      closed = true;
      seq++;
      host.replaceChildren();
    },
  };
}

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
  // D#483 S5-h: the build, auto-start, margin and discovery settings. A section of its own, so this view's redraws leave it (and its focus) alone.
  const limitsHost = h("div", { class: "au-limits", "data-testid": "au-limits", hidden: true });
  const limits = mountLimits(limitsHost);
  host.replaceChildren(
    h("div", { class: "au-app" }, h("div", { class: "roles-head" }, h("h2", { class: "roles-title" }, "Autonomy"), picker), status, body, limitsHost)
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
      if (repoId) limits.load(repoId, canChange());
      else limits.clear();
    } catch (e) {
      if ((e && e.name === "AbortError") || mine !== seq) return;
      dial = null;
      ask = null;
      error = UNAVAILABLE;
      limits.clear();
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
    limits.clear();
    render();
    setItem(ctx.repoKey, id);
    const { mine, signal } = begin();
    try {
      await loadView(signal);
      error = "";
      if (mine === seq) limits.load(id, canChange());
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
      limits.destroy();
      seq++;
      if (ctl) ctl.abort();
      host.replaceChildren();
    },
  };
}
