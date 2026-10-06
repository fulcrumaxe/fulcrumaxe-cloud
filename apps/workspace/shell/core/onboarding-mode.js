// D#37 WS-F9a (owner ruling R-F9-GATE (a)): the one place that decides what a signed-in session sees.
//   "open"             -> the full desktop (no onboarding read is made).
//   "no_subscription"  -> ONE GET /api/v1/onboarding. A valid body with a step still open puts the shell in
//                         onboarding mode: a desktop that offers and opens only the four apps below. Every other
//                         outcome (all done, 403, 401, 5xx, network, timeout, a bad body) is today's gate.
//   anything else      -> today's gate, with no read.
// A UI gate only: the server decides every call. Restriction is one-way (see app-registry.js restrictTo).
export const ONBOARDING_APPS = Object.freeze(["onboarding", "model-key", "repos", "themes"]);
export const STEP_IDS = Object.freeze(["model_key", "readonly_app", "preview", "pay", "write_app", "first_pr"]);
const READ_TIMEOUT_MS = 5000;
const AFTER_RESTORE_MS = 300; // script.js restores or opens its first windows 200 ms after DESKTOP

/** A step still to do: not finished and not skipped. A skipped step (the preview, once a plan is chosen) is not waiting on anyone. */
export const isOpenStep = (s) => s.completed_at === null && !s.skipped;

/**
 * The six steps of a GET /api/v1/onboarding body in the server's order, or null when the body does not fit.
 * `skipped` is true only on a step with no time; a body without the field reads as not skipped.
 */
export function parseSteps(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.steps) || body.steps.length !== STEP_IDS.length) return null;
  const steps = [];
  for (let i = 0; i < STEP_IDS.length; i++) {
    const s = body.steps[i];
    if (!s || s.step !== STEP_IDS[i]) return null;
    const t = s.completed_at;
    if (t !== null && !(typeof t === "string" && !Number.isNaN(Date.parse(t)))) return null;
    const skipped = s.skipped === undefined ? false : s.skipped;
    if (typeof skipped !== "boolean" || (skipped && t !== null)) return null;
    steps.push({ step: s.step, completed_at: t, skipped });
  }
  return steps;
}

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
// boot.js reads these from window (a page tag loads this file first), so boot imports nothing new.
if (typeof window !== "undefined") window.FULCOnboardingMode = { resolveAccess, enterOnboardingMode, openOnboardingWhenReady };
