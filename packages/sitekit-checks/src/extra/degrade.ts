import { BrowserCheckError } from "../lib/browser/run.js";
import type { CheckResult } from "../types.js";
import { clip, evaluateAudit, runOnPages, type BrowserPagesOptions } from "./browser-pages.js";

/**
 * Port of the check in os-site-v2/tools/check-degrade.mjs, made generic: with the site's runtime API calls
 * blocked, does each page still say something a reader can use? The original's per-page selector table is
 * replaced by the text of <main>. The browser comes in through `options.driver`.
 */
export interface DegradeOptions extends BrowserPagesOptions {
  /** Same-origin path globs to abort while the page loads. Default ["/api/*"]. */
  blockPaths?: string[];
  /** How long to let the page settle after it loads, in ms. Default 3000. */
  settleMs?: number;
}

/** Wording that means the page gave up without telling anybody anything (as in the original). */
const USELESS = /^(loading|reading|…|\.\.\.|\s*)$/i;
const MIN_LENGTH = 15;
const WAIT = "(ms) => new Promise((resolve) => setTimeout(() => resolve(true), ms))";
const MAIN_TEXT = "() => { const m = document.querySelector('main'); return { hasMain: !!m, text: m ? m.innerText.trim().slice(0, 200) : '' }; }";

export async function run(renderedDir: string, options: DegradeOptions = {}): Promise<CheckResult> {
  const blockPaths = options.blockPaths ?? ["/api/*"];
  const settleMs = options.settleMs ?? 3000;
  return runOnPages(renderedDir, options, [], async ({ page, load, fail }) => {
    await page.blockUrls(blockPaths);
    if (!(await load())) return;
    await evaluateAudit(page, WAIT, settleMs);
    const main = (await evaluateAudit(page, MAIN_TEXT)) as Record<string, unknown>;
    if (typeof main?.hasMain !== "boolean" || typeof main.text !== "string") {
      throw new BrowserCheckError("browser_result_invalid", "the page audit returned the wrong shape");
    }
    if (!main.hasMain) {
      fail("degrade_no_main", "the page has no <main> to read", "Put the page's content in <main>.");
      return;
    }
    const text = main.text.trim();
    if (text.length <= MIN_LENGTH || USELESS.test(text) || /^(loading|reading)\b/i.test(text)) {
      fail(
        "degrade_no_useful_text",
        `with its API calls blocked, <main> says: "${clip(text, 80)}"`,
        "Ship the readable content in the HTML, or show a clear message when a request fails.",
        { selector: "main" },
      );
    }
  });
}
