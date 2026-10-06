import { BrowserCheckError } from "../lib/browser/run.js";
import type { CheckResult } from "../types.js";
import { asRecords, evaluateAudit, runOnPages, type BrowserPagesOptions } from "./browser-pages.js";

/**
 * Port of the audit in os-site-v2/tools/check-a11y-structure.mjs: the accessibility that markup regexes
 * (check-a11y) cannot see, decided on the rendered page: heading order, landmarks, image alt text and
 * controls with no accessible name. The browser comes in through `options.driver`.
 */
export type A11yStructureOptions = BrowserPagesOptions;

const HINTS: Record<string, string> = {
  h1_count: "Give the page exactly one <h1>.",
  heading_jump: "Do not skip a heading level; add the missing level or change this one.",
  missing_main: "Wrap the page's main content in <main>.",
  missing_nav: "Wrap the site navigation links in <nav>.",
  skip_link_target_missing: "Point the skip link at an element that exists, e.g. <main id=\"main\">.",
  img_missing_alt: "Add an alt attribute; use alt=\"\" if the image is decoration.",
  alt_is_filename: "Describe the image in the alt text instead of repeating its file name.",
  unlabelled_control: "Give this control visible text or an aria-label.",
};

/** Runs in the page. Returns `{ kind, selector, detail }` per problem; quoted page text is cut at 80 characters. */
const AUDIT = String.raw`() => {
  const out = [];
  const sel = (el) => el.tagName.toLowerCase()
    + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/)[0] : '');
  const shown = (el) => el.offsetParent !== null || el.getClientRects().length > 0;
  const h1s = document.querySelectorAll('h1');
  if (h1s.length !== 1) out.push({ kind: 'h1_count', selector: 'h1', detail: 'has ' + h1s.length + ' h1 elements, expected 1' });
  let last = 0;
  for (const h of Array.from(document.querySelectorAll('main h1, main h2, main h3, main h4, main h5, main h6')).filter(shown)) {
    const level = Number(h.tagName[1]);
    if (last && level > last + 1) {
      out.push({ kind: 'heading_jump', selector: sel(h), detail: 'jumps from h' + last + ' to h' + level + ' at "' + h.textContent.trim().slice(0, 80) + '"' });
    }
    last = level;
  }
  if (!document.querySelector('main')) out.push({ kind: 'missing_main', selector: 'main', detail: 'no <main> landmark' });
  if (!document.querySelector('nav')) out.push({ kind: 'missing_nav', selector: 'nav', detail: 'no <nav> landmark' });
  const skip = document.querySelector('.skip-link');
  if (skip) {
    let target = null;
    try { target = document.querySelector(skip.getAttribute('href')); } catch (e) { target = null; }
    if (!target) out.push({ kind: 'skip_link_target_missing', selector: sel(skip), detail: 'the skip link points at nothing' });
  }
  for (const img of document.querySelectorAll('img')) {
    const alt = img.getAttribute('alt');
    if (alt === null) out.push({ kind: 'img_missing_alt', selector: sel(img), detail: 'image with no alt: ' + (img.getAttribute('src') || '').slice(-60) });
    else if (/\.(png|jpe?g|svg|webp|gif)$/i.test(alt.trim())) out.push({ kind: 'alt_is_filename', selector: sel(img), detail: 'alt text is a file name: "' + alt.slice(0, 80) + '"' });
  }
  for (const el of document.querySelectorAll('button, a[href]')) {
    if (!shown(el)) continue;
    const name = (el.textContent || '').trim() || el.getAttribute('aria-label') || el.getAttribute('title')
      || (el.querySelector('img') || {}).alt || (el.querySelector('.sr-only') || {}).textContent;
    if (!name || !String(name).trim()) out.push({ kind: 'unlabelled_control', selector: sel(el), detail: 'a control has no accessible name' });
  }
  return out;
}`;

export async function run(renderedDir: string, options: A11yStructureOptions = {}): Promise<CheckResult> {
  return runOnPages(renderedDir, options, [], async ({ page, load, fail }) => {
    if (!(await load())) return;
    for (const f of asRecords(await evaluateAudit(page, AUDIT))) {
      const hint = Object.hasOwn(HINTS, String(f.kind)) ? HINTS[String(f.kind)] : undefined;
      if (!hint) throw new BrowserCheckError("browser_result_invalid", "the page audit returned an unknown kind");
      fail(String(f.kind), String(f.detail), hint, { selector: String(f.selector) });
    }
  });
}
