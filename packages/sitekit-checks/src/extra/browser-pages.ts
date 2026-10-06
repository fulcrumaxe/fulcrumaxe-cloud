import type { BrowserPage, JsonValue } from "../lib/browser/driver.js";
import {
  assertPageCap,
  BrowserCheckError,
  evaluateJson,
  notApplicable,
  openPage,
  withBrowser,
  type BrowserRunOptions,
} from "../lib/browser/run.js";
import { serveStatic } from "../lib/browser/serve.js";
import { findHtmlFiles, urlFor } from "../lib/walk.js";
import type { CheckOptions, CheckResult, Finding } from "../types.js";

/** Options every check that opens each rendered page in a browser shares. */
export interface BrowserPagesOptions extends CheckOptions, BrowserRunOptions {
  /** Page paths ("/404.html") not to visit. */
  skipPaths?: string[];
}

/** What a check's `visit` gets for one page. */
export interface PageVisit {
  page: BrowserPage;
  path: string;
  /** Navigates to the page and waits for it. False (after a `page_load_failed` finding) when it will not load. */
  load(): Promise<boolean>;
  /** Records an error finding on this page. `message` is capped at 200 characters. */
  fail(kind: string, message: string, hint: string, where?: { viewport?: number; selector?: string }): void;
}

const READY = '() => document.readyState === "complete" && !!document.body';

export const clip = (text: string, max: number): string => (text.length > max ? text.slice(0, max - 1) + "…" : text);

/** An audit result the page produced, checked to be a list of objects. Anything else is `browser_result_invalid`. */
export function asRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "object" || v === null)) {
    throw new BrowserCheckError("browser_result_invalid", "the page audit returned the wrong shape");
  }
  return value as Record<string, unknown>[];
}

/**
 * `evaluateJson` for an audit script. A page that makes the script throw gets a fixed message: the page's
 * own error text never reaches a finding.
 */
export async function evaluateAudit(page: BrowserPage, script: string, arg?: JsonValue): Promise<JsonValue> {
  try {
    return await evaluateJson(page, script, arg);
  } catch (err) {
    if (err instanceof BrowserCheckError) throw err;
    throw new BrowserCheckError("browser_result_invalid", "the page audit could not run on this page");
  }
}

/**
 * Serves `renderedDir` on loopback and calls `visit` for each HTML page (less `skipPaths`), inside the
 * driver's budget and page cap. `visit` returns how many renders it made (default 1).
 */
export function runOnPages(
  renderedDir: string,
  options: BrowserPagesOptions,
  defaultSkip: string[],
  visit: (v: PageVisit) => Promise<number | void>,
): Promise<CheckResult> {
  const skip = new Set(options.skipPaths ?? defaultSkip);
  return withBrowser(options, async (driver) => {
    const paths = (await findHtmlFiles(renderedDir)).map((f) => urlFor(renderedDir, f)).filter((p) => !skip.has(p));
    if (paths.length === 0) return notApplicable("the site has no HTML pages to inspect");
    assertPageCap(paths.length, options);
    const server = await serveStatic(renderedDir);
    const findings: Finding[] = [];
    let renders = 0;
    try {
      const page = await openPage(driver);
      for (const path of paths) {
        const fail: PageVisit["fail"] = (kind, message, hint, where) =>
          findings.push({ path, kind, message: clip(message, 200), severity: "error", hint, ...where, ...(where?.selector ? { selector: clip(where.selector, 80) } : {}) });
        const target = server.origin + path.split("/").map(encodeURIComponent).join("/");
        const load = async (): Promise<boolean> => {
          try {
            await page.goto(target);
            if ((await evaluateAudit(page, READY)) === true) return true;
            throw new Error("the page did not finish loading");
          } catch (err) {
            if (err instanceof BrowserCheckError) throw err;
            const why = err instanceof Error ? (err.message.split("\n")[0] ?? "") : "";
            fail("page_load_failed", `the page did not load: ${clip(why, 120)}`, "Check that this page is served without an error.");
            return false;
          }
        };
        renders += (await visit({ page, path, load, fail })) ?? 1;
      }
    } finally {
      await server.close();
    }
    return { ok: findings.length === 0, findings, summary: { pages: paths.length, renders } };
  });
}
