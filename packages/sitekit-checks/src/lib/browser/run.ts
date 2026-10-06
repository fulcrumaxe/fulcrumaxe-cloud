import type { CheckResult, Finding } from "../../types.js";
import type { BrowserDriver, BrowserPage, JsonValue } from "./driver.js";

export interface BrowserRunOptions {
  driver?: BrowserDriver;
  /** Wall-clock budget for the whole check, in ms. Default 120 000. */
  budgetMs?: number;
  /** Most pages a check may visit. Default 200. */
  pageCap?: number;
}

export const MAX_RESULT_BYTES = 256 * 1024;

/** A "could not run" outcome. Always turns into `ok: false`. */
export class BrowserCheckError extends Error {
  constructor(
    readonly kind: "browser_driver_missing" | "browser_unavailable" | "check_timeout" | "page_cap_exceeded" | "browser_result_invalid",
    message: string,
  ) {
    super(message);
  }
}

function failed(kind: string, message: string): CheckResult {
  const f: Finding = { path: "/", kind, message: message.slice(0, 200), severity: "error" };
  return { ok: false, findings: [f], summary: { checked: 0 } };
}

/** A check that found the feature it tests absent. Passes with one advisory and `checked = 0` (R3). */
export function notApplicable(reason: string): CheckResult {
  return {
    ok: true,
    findings: [{ path: "/", kind: "not_applicable", message: reason.slice(0, 200), severity: "advisory" }],
    summary: { checked: 0 },
  };
}

/** Throws `page_cap_exceeded` rather than silently visiting fewer pages. */
export function assertPageCap(pages: number, options: BrowserRunOptions): void {
  const cap = options.pageCap ?? 200;
  if (pages > cap) throw new BrowserCheckError("page_cap_exceeded", `${pages} pages exceed the cap of ${cap}`);
}

/** Evaluate a constant script and accept only a JSON-serialisable result of at most 256 KiB. */
export async function evaluateJson(page: BrowserPage, script: string, arg?: JsonValue): Promise<JsonValue> {
  const raw = await page.evaluate(script, arg);
  let text: string | undefined;
  try {
    text = JSON.stringify(raw);
  } catch {
    text = undefined;
  }
  if (text === undefined) throw new BrowserCheckError("browser_result_invalid", "evaluate returned a non-JSON value");
  if (Buffer.byteLength(text) > MAX_RESULT_BYTES) {
    throw new BrowserCheckError("browser_result_invalid", "evaluate returned more than 256 KiB");
  }
  return JSON.parse(text) as JsonValue;
}

/**
 * Runs `body` with the injected driver and fails closed: a missing driver, a
 * driver that will not open, a blown budget or a thrown error is `ok: false`,
 * never a pass. The driver is closed on every path.
 */
export async function withBrowser(
  options: BrowserRunOptions | undefined,
  body: (driver: BrowserDriver) => Promise<CheckResult>,
): Promise<CheckResult> {
  const driver = options?.driver;
  if (!driver || typeof driver.open !== "function") {
    return failed("browser_driver_missing", "options.driver (a BrowserDriver) is required and was not provided");
  }
  const budgetMs = options?.budgetMs ?? 120_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BrowserCheckError("check_timeout", `exceeded the ${budgetMs} ms budget`)), budgetMs);
  });
  try {
    return await Promise.race([body(driver), timeout]);
  } catch (err) {
    if (err instanceof BrowserCheckError) return failed(err.kind, err.message);
    return failed("browser_unavailable", err instanceof Error ? err.message : "browser error");
  } finally {
    clearTimeout(timer);
    await driver.close().catch(() => undefined);
  }
}

/** Opens a page, mapping a failure to open into `browser_unavailable`. */
export async function openPage(driver: BrowserDriver): Promise<BrowserPage> {
  try {
    return await driver.open();
  } catch (err) {
    throw new BrowserCheckError("browser_unavailable", err instanceof Error ? err.message : "driver.open failed");
  }
}
