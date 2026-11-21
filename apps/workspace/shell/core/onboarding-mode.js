// D#37 WS-F9a (owner ruling R-F9-GATE (a)): the one place that decides what a signed-in session sees.
//   "open"             -> the full desktop (no onboarding read is made).
//   "no_subscription"  -> ONE GET /api/v1/onboarding. A valid body with a step still open puts the shell in
//                         onboarding mode: a desktop that offers and opens only the four apps below. Every other
//                         outcome (all done, 403, 401, 5xx, network, timeout, a bad body) is today's gate.
//   anything else      -> today's gate, with no read.
// A UI gate only: the server decides every call. Restriction is one-way (see app-registry.js restrictTo).
export const ONBOARDING_APPS = Object.freeze(["onboarding", "model-key", "repos", "themes"]);
export const STEP_IDS = Object.freeze(["model_key", "readonly_app", "preview", "pay", "write_app", "first_pr"]);
export const ENGINE_STEP_IDS = Object.freeze(["machine", "claude", "github_app", "project", "plan", "install", "live"]);
const ENGINE_STATES = Object.freeze(["done", "active", "pending", "failed"]);
const READ_TIMEOUT_MS = 5000;
const AFTER_RESTORE_MS = 300; // script.js restores or opens its first windows 200 ms after DESKTOP

/** A step still to do: not finished and not skipped. A skipped step (the preview, once a plan is chosen) is not waiting on anyone. */
export const isOpenStep = (s) => s.completed_at === null && !s.skipped;

const validTime = (t) => typeof t === "string" && !Number.isNaN(Date.parse(t));
/** The pipeline track's six steps in the server's order, or null when they do not fit. `skipped` is true only on a step with no time; a missing field reads as not skipped. */
function parsePipeline(list) {
  if (!Array.isArray(list) || list.length !== STEP_IDS.length) return null;
  const steps = [];
  for (let i = 0; i < STEP_IDS.length; i++) {
    const s = list[i];
    if (!s || s.step !== STEP_IDS[i]) return null;
    const t = s.completed_at;
    if (t !== null && !validTime(t)) return null;
    const skipped = s.skipped === undefined ? false : s.skipped;
    if (typeof skipped !== "boolean" || (skipped && t !== null)) return null;
    steps.push({ step: s.step, completed_at: t, skipped });
  }
  return steps;
}
/** The engine track's seven steps. A state agrees with the time (only `done` has one) and with the failure (only `failed` carries one). */
function parseEngine(list) {
  if (!Array.isArray(list) || list.length !== ENGINE_STEP_IDS.length) return null;
  const steps = [];
  for (let i = 0; i < ENGINE_STEP_IDS.length; i++) {
    const s = list[i];
    if (!s || s.step !== ENGINE_STEP_IDS[i] || !ENGINE_STATES.includes(s.state)) return null;
    const t = s.completed_at;
    if (t !== null && !validTime(t)) return null;
    if ((s.state === "done") !== (t !== null)) return null;
    const tier = s.tier === undefined ? null : s.tier;
    if (tier !== null && tier !== "microvm" && tier !== "standard") return null;
    const f = s.failure === undefined ? null : s.failure;
    if (f !== null && !(f && typeof f.code === "string" && f.code !== "" && validTime(f.at))) return null;
    if ((s.state === "failed") !== (f !== null)) return null;
    const entry = { step: s.step, state: s.state, completed_at: t, tier, failure: f === null ? null : { code: f.code, at: f.at } };
    // D#845 ON-6c: the machine step's KVM fact and helper_missing, both optional. Anything but the closed values is "the machine has not said", never a failure of the whole track.
    if (s.step === "machine") {
      if (s.kvm === "present" || s.kvm === "absent") entry.kvm = s.kvm;
      if (s.helper_missing === true) entry.helper_missing = true;
      // D#845 ON-21b: the preflight codes with the cloud's one line each; only { code, fix } pairs of short strings are kept, and a value that is not a list is "not said".
      if (Array.isArray(s.preflight)) entry.preflight = s.preflight.filter((p) => p && typeof p.code === "string" && typeof p.fix === "string" && p.fix !== "" && p.fix.length <= 400).slice(0, 40).map((p) => ({ code: p.code, fix: p.fix }));
    }
    steps.push(entry);
  }
  return steps;
}

/**
 * D#845 ON-6: both tracks of a GET /api/v1/onboarding body (`tracks`, pipeline first), or null when the pipeline track or the envelope does not fit.
 * An engine track that does not fit gives `engine: null` (the pipeline track still reads; the app shows the engine track's own error).
 * `chosen` is when the person chose each track, or null while they have not.
 */
export function parseTracks(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.tracks) || body.tracks.length !== 2) return null;
  const [p, e] = body.tracks;
  if (!p || !e || p.track !== "pipeline" || e.track !== "engine") return null;
  const pipeline = parsePipeline(p.steps);
  const engine = parseEngine(e.steps);
  if (!pipeline) return null;
  if (p.chosen_at !== null && !validTime(p.chosen_at)) return null;
  if (e.chosen_at !== null && !validTime(e.chosen_at)) return null;
  return { pipeline, engine, chosen: { pipeline: p.chosen_at, engine: e.chosen_at } };
}

/**
 * Which tracks the Onboarding screen shows, in the order the person chose them. The pipeline track also shows for an account that has already made progress
 * in it (before tracks existed it was the only one), so no one's setup disappears. An empty list is the first visit: the track choice.
 */
export function shownTracks(parsed) {
  const { pipeline, chosen } = parsed;
  const started = pipeline.some((s) => s.completed_at !== null || s.skipped);
  const list = ["pipeline", "engine"].filter((t) => chosen[t] !== null || (t === "pipeline" && started));
  return list.sort((a, b) => (chosen[a] === null ? 0 : Date.parse(chosen[a])) - (chosen[b] === null ? 0 : Date.parse(chosen[b])));
}

/** The pipeline track's six steps (`tracks[0]`), or null when they do not fit. The gate and the strip read only this, so an engine track they do not use can never close the desktop. */
export function parseSteps(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.tracks) || !body.tracks[0] || body.tracks[0].track !== "pipeline") return null;
  return parsePipeline(body.tracks[0].steps);
}

// The steps resolveAccess last parsed, so the setup strip (below) does not read a second time.
let bootSteps = null;

/** @returns {Promise<"desktop" | "onboarding" | "gate">} */
export async function resolveAccess(session, doFetch = (...a) => fetch(...a)) {
  const access = session && session.workspace_access;
  if (access === "open") return "desktop";
  if (access !== "no_subscription") return "gate";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
  try {
    const res = await doFetch("/api/v1/onboarding", { credentials: "include", headers: { Accept: "application/json" }, signal: controller.signal });
    if (!res.ok) return "gate";
    const steps = parseSteps(await res.json());
    bootSteps = steps;
    return steps && steps.some(isOpenStep) ? "onboarding" : "gate";
  } catch (_) {
    return "gate";
  } finally {
    clearTimeout(timer);
  }
}

/** Limits every launcher, dock, icon, switcher and open() call to the four apps. False means it could not: fall back to the gate. */
export function enterOnboardingMode() {
  if (!window.FULCApps || typeof window.FULCApps.restrictTo !== "function") return false;
  window.FULCApps.restrictTo(ONBOARDING_APPS);
  return true;
}

/** Opens (and so focuses) Onboarding once the desktop is up and its first windows are restored. Bounded: gives up after 10 s. */
export function openOnboardingWhenReady() {
  let tries = 0;
  const tick = () => {
    if (window.currentStep === "DESKTOP" && window.FULCWM) {
      setTimeout(() => window.FULCWM.open("onboarding"), AFTER_RESTORE_MS);
    } else if (++tries < 100) {
      setTimeout(tick, 100);
    }
  };
  tick();
}
// ---- WS-F9b: the "finish setup" strip. Owners and admins only; members make no read. ----
// Shown on the whole desktop (open sessions as well as onboarding mode) until every step is done or skipped. One read at
// boot (none when resolveAccess already made it), then only what the Onboarding app reports; no timer.
const DISMISS_KEY = "fulc.setup-strip.dismissed";
const REOPENABLE = ["model_key", "readonly_app"]; // the two steps that follow live state and can open again
const strip = { active: false, steps: null, el: null, dismissed: null, ro: null };

/** "01"-style record of which reopenable steps are open, taken when the strip is dismissed. */
export const stripSnapshot = (steps) => REOPENABLE.map((id) => (steps.find((s) => s.step === id).completed_at === null ? "1" : "0")).join("");
/** The strip shows while a step is open and it was not dismissed. Dismissal ends when a reopenable step opens that was closed at the time. */
export function stripState(steps, dismissed) {
  if (!steps || !steps.some(isOpenStep)) return { show: false, dismissed: null };
  if (dismissed !== null) {
    const now = stripSnapshot(steps);
    if (![...now].some((c, i) => c === "1" && dismissed[i] === "0")) return { show: false, dismissed };
  }
  return { show: true, dismissed: null };
}
function readDismissed() {
  try { const v = window.sessionStorage.getItem(DISMISS_KEY); if (v !== null) return v; } catch (_) { /* storage blocked: memory only */ }
  return strip.dismissed;
}
function writeDismissed(v) {
  strip.dismissed = v;
  try { if (v === null) window.sessionStorage.removeItem(DISMISS_KEY); else window.sessionStorage.setItem(DISMISS_KEY, v); } catch (_) { /* memory only */ }
}
function renderStrip() {
  const st = strip.steps ? stripState(strip.steps, readDismissed()) : { show: false, dismissed: null };
  if (strip.steps && st.dismissed === null && readDismissed() !== null) writeDismissed(null);
  if (!st.show) {
    if (strip.ro) { strip.ro.disconnect(); strip.ro = null; }
    if (strip.el) strip.el.remove();
    strip.el = null;
    reserveStripBand(null);
    return;
  }
  const left = strip.steps.filter(isOpenStep).length;
  const text = "Finish setup: " + left + (left === 1 ? " step left" : " steps left");
  if (strip.el) { strip.el.querySelector(".setup-strip-text").textContent = text; return; }
  const el = document.createElement("section");
  el.className = "setup-strip";
  el.setAttribute("aria-label", "Finish setup");
  el.setAttribute("data-testid", "setup-strip");
  const label = document.createElement("span");
  label.className = "setup-strip-text";
  label.textContent = text;
  const go = document.createElement("button");
  go.type = "button"; go.className = "setup-strip-btn"; go.textContent = "Open Onboarding";
  go.setAttribute("data-testid", "setup-strip-open");
  go.addEventListener("click", () => window.FULCWM && window.FULCWM.open("onboarding"));
  const no = document.createElement("button");
  no.type = "button"; no.className = "setup-strip-btn"; no.textContent = "Dismiss";
  no.setAttribute("aria-label", "Dismiss the finish setup reminder");
  no.setAttribute("data-testid", "setup-strip-dismiss");
  no.addEventListener("click", () => {
    writeDismissed(stripSnapshot(strip.steps));
    renderStrip();
    const next = document.querySelector("#taskbar button");
    if (next) next.focus();
  });
  el.append(label, go, no);
  strip.el = el;
  const host = document.getElementById("windows-container");
  if (host) {
    host.append(el);
    reserveStripBand(el);
    if (typeof ResizeObserver !== "undefined") { strip.ro = new ResizeObserver(() => reserveStripBand(el)); strip.ro.observe(el); }
  } else {
    (document.getElementById("desktop-screen") || document.body).append(el);
  }
}
/** Keeps the work area clear of the strip: the windows container reserves a band as tall as the strip (it wraps on narrow screens). */
function reserveStripBand(el) {
  const host = document.getElementById("windows-container");
  if (!host) return;
  if (!el) { host.classList.remove("has-setup-strip"); host.style.removeProperty("--setup-strip-h"); return; }
  host.style.setProperty("--setup-strip-h", Math.ceil(el.getBoundingClientRect().height) + "px");
  host.classList.add("has-setup-strip");
}
/** What the Onboarding app calls after each read of the steps. Ignored unless this session is showing the strip. */
export function reportSteps(steps) {
  if (!strip.active || !Array.isArray(steps) || steps.length !== STEP_IDS.length) return;
  strip.steps = steps;
  renderStrip();
}
/** Owners and admins only. Never throws and never blocks the desktop: any failure leaves no strip. */
export async function startSetupStrip(session, doFetch = (...a) => fetch(...a)) {
  if (!session || !session.is_admin || strip.active) return false;
  strip.active = true;
  try {
    if (!bootSteps) {
      const res = await doFetch("/api/v1/onboarding", { credentials: "include", headers: { Accept: "application/json" } });
      if (res.ok) bootSteps = parseSteps(await res.json());
    }
    if (bootSteps && !strip.steps) strip.steps = bootSteps;
    renderStrip();
  } catch (_) { /* no strip */ }
  return true;
}

// boot.js reads these from window (a page tag loads this file first), so boot imports nothing new.
if (typeof window !== "undefined") window.FULCOnboardingMode = { resolveAccess, enterOnboardingMode, openOnboardingWhenReady, startSetupStrip, reportSteps };
