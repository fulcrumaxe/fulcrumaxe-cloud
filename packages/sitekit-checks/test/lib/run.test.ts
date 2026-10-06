import { describe, expect, it } from "vitest";
import type { CheckResult } from "../../src/types.js";
import {
  assertPageCap,
  evaluateJson,
  notApplicable,
  openPage,
  withBrowser,
  type BrowserRunOptions,
} from "../../src/lib/browser/run.js";
import { fakeDriver } from "./fake-driver.js";

/** A stand-in check: opens a page, evaluates one constant script, passes. */
async function stubCheck(options: BrowserRunOptions & { pages?: number } = {}): Promise<CheckResult> {
  return withBrowser(options, async (driver) => {
    assertPageCap(options.pages ?? 1, options);
    const page = await openPage(driver);
    await evaluateJson(page, "() => document.title");
    return { ok: true, findings: [], summary: { checked: 1 } };
  });
}

const kinds = (r: CheckResult) => r.findings.map((f) => f.kind);

describe("withBrowser fails closed", () => {
  it("missing driver -> browser_driver_missing", async () => {
    const r = await stubCheck({});
    expect(r.ok).toBe(false);
    expect(kinds(r)).toEqual(["browser_driver_missing"]);
  });

  it("driver.open throws -> browser_unavailable", async () => {
    const r = await stubCheck({ driver: fakeDriver({ openError: new Error("no chromium") }) });
    expect(r.ok).toBe(false);
    expect(kinds(r)).toEqual(["browser_unavailable"]);
  });

  it("budget exceeded -> check_timeout, and the driver is closed", async () => {
    const driver = fakeDriver({ hang: true });
    const r = await stubCheck({ driver, budgetMs: 50 });
    expect(r.ok).toBe(false);
    expect(kinds(r)).toEqual(["check_timeout"]);
    expect(driver.closed).toBe(1);
  });

  it("more pages than pageCap -> page_cap_exceeded, never truncated", async () => {
    const r = await stubCheck({ driver: fakeDriver(), pageCap: 3, pages: 4 });
    expect(r.ok).toBe(false);
    expect(kinds(r)).toEqual(["page_cap_exceeded"]);
    expect((await stubCheck({ driver: fakeDriver(), pageCap: 3, pages: 3 })).ok).toBe(true);
  });

  it.each([
    ["a function", () => () => 1],
    ["a circular object", () => { const o: Record<string, unknown> = {}; o.self = o; return o; }],
    ["undefined", () => undefined],
    ["a value over 256 KiB", () => "x".repeat(256 * 1024 + 1)],
  ])("evaluate returning %s -> browser_result_invalid", async (_name, make) => {
    const r = await stubCheck({ driver: fakeDriver({ evaluate: make }) });
    expect(r.ok).toBe(false);
    expect(kinds(r)).toEqual(["browser_result_invalid"]);
  });

  it("closes the driver on a passing run too", async () => {
    const driver = fakeDriver({ evaluate: () => "t" });
    expect((await stubCheck({ driver })).ok).toBe(true);
    expect(driver.closed).toBe(1);
  });

  it("notApplicable -> ok, one advisory not_applicable carrying the reason, checked 0", () => {
    const r = notApplicable("Skipped: your site has no search page");
    expect(r.ok).toBe(true);
    expect(r.findings).toEqual([
      { path: "/", kind: "not_applicable", message: "Skipped: your site has no search page", severity: "advisory" },
    ]);
    expect(r.summary?.checked).toBe(0);
  });
});
