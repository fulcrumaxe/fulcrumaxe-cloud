import { BrowserCheckError } from "../lib/browser/run.js";
import type { CheckResult } from "../types.js";
import { asRecords, evaluateAudit, runOnPages, type BrowserPagesOptions } from "./browser-pages.js";

/**
 * Port of the animation sweep in os-site-v2/tools/check-motion.mjs: with the visitor asking for reduced
 * motion, does anything on the page still animate or transition? The focus-ring half of the original is
 * not ported. The browser comes in through `options.driver`.
 */
export type MotionOptions = BrowserPagesOptions;

/** Most findings one page reports; the rest are only counted in `summary.not_reported`. */
const PAGE_CAP = 20;
/** Time the page gets after it loads to start its animations. */
const SETTLE_MS = 500;
/** More items than this from one page is not an audit, it is a page tampering with the result. */
const MAX_RETURNED = PAGE_CAP * 5;
/** The only wording a finding gets: nothing the page returns is put into a message. */
const MESSAGES = {
  animation: "an animation still runs with reduced motion requested",
  transition: "a transition still runs with reduced motion requested",
} as const;
const HINT = "Under prefers-reduced-motion: reduce, set animation and transition durations to 0 (or none).";

const WAIT = "(ms) => new Promise((resolve) => setTimeout(() => resolve(true), ms))";

/**
 * Runs in the page. An animation counts when its name is not `none` and it lasts over 0.01 s; a transition
 * when any duration in the list is over 0.01 s. Returns at most `cap` elements and the full count.
 */
const AUDIT = String.raw`(cap) => {
  const secs = (list) => list.split(',').map((v) => parseFloat(v) || 0);
  const sel = (el) => el.tagName.toLowerCase()
    + (el.id ? '#' + el.id : '')
    + (el.className && typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/)[0] : '');
  const items = [];
  let total = 0;
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    const names = cs.animationName.split(',').map((n) => n.trim());
    const durations = secs(cs.animationDuration);
    const animated = names.some((n, i) => n !== 'none' && durations[i % durations.length] > 0.01);
    const transitioned = secs(cs.transitionDuration).some((d) => d > 0.01);
    if (!animated && !transitioned) continue;
    total++;
    if (items.length < cap) items.push({ selector: sel(el), what: animated ? 'animation' : 'transition' });
  }
  return { total, items };
}`;

const invalid = (): BrowserCheckError => new BrowserCheckError("browser_result_invalid", "the page audit returned the wrong shape");

/**
 * The page's audit result, checked field by field. Anything unexpected (a missing or inherited field, a
 * `what` outside the two known kinds, a non-string selector, a count that is not a whole number, more
 * items than the cap allows) is `browser_result_invalid`, so a hostile page gets one fixed finding.
 */
function readAudit(audit: unknown): { total: number; items: { selector: string; what: keyof typeof MESSAGES }[] } {
  if (typeof audit !== "object" || audit === null || !Object.hasOwn(audit, "total") || !Object.hasOwn(audit, "items")) throw invalid();
  const { total, items: raw } = audit as Record<string, unknown>;
  if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) throw invalid();
  if (Array.isArray(raw) && raw.length > MAX_RETURNED) throw invalid();
  const items = asRecords(raw).map((item): { selector: string; what: keyof typeof MESSAGES } => {
    const { selector, what } = item;
    if (!Object.hasOwn(item, "selector") || !Object.hasOwn(item, "what") || typeof selector !== "string") throw invalid();
    if (what !== "animation" && what !== "transition") throw invalid();
    return { selector, what };
  });
  if (total < items.length) throw invalid();
  return { total, items };
}

export async function run(renderedDir: string, options: MotionOptions = {}): Promise<CheckResult> {
  let notReported = 0;
  const result = await runOnPages(renderedDir, options, [], async ({ page, load, fail }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    if (!(await load())) return;
    await evaluateAudit(page, WAIT, SETTLE_MS);
    const { total, items } = readAudit(await evaluateAudit(page, AUDIT, PAGE_CAP));
    const reported = items.slice(0, PAGE_CAP);
    for (const item of reported) {
      fail("motion_not_reduced", MESSAGES[item.what], HINT, { selector: item.selector });
    }
    notReported += total - reported.length;
  });
  if (result.summary) result.summary.not_reported = notReported;
  return result;
}
