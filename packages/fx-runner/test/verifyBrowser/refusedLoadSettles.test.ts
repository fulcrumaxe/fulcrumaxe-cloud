import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { launchDriver, ToolError } from "../../src/verifyBrowser/driver.js";
import { setPlaywrightLoader } from "../../src/verifyBrowser/loadPlaywright.js";
import { parseBase } from "../../src/verifyBrowser/pin.js";

/**
 * A load the pin refuses fails before Chromium has committed its error page, while the page still reads as the old address (about:blank, which is allowed). A call that returned
 * then would leave the error page to land during the caller's next navigation. These tests drive the driver through a fake Playwright to pin the timing, with no browser.
 */
const BASE = "http://127.0.0.1:9";
const dirs: string[] = [];
afterEach(() => {
  setPlaywrightLoader(undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface FakeOpts {
  /** What goto throws for an address outside the base. */
  message: (url: string) => string;
  /** When the page address changes after that goto (never when undefined), and to what. */
  commitMs?: number;
  commitTo?: string;
}

async function driver(o: FakeOpts) {
  let url = "about:blank";
  const waits: string[] = [];
  const page = {
    on: () => undefined,
    url: () => url,
    goto: async (u: string) => {
      if (u === "about:blank" || u.startsWith(BASE)) return void (url = u);
      if (o.commitMs !== undefined) setTimeout(() => void (url = o.commitTo ?? "chrome-error://chromewebdata/"), o.commitMs);
      throw new Error(o.message(u));
    },
    waitForURL: async (want: RegExp | string, opt: { timeout: number }) => {
      waits.push(String(want));
      const t0 = Date.now();
      while (Date.now() - t0 < opt.timeout) {
        if (typeof want === "string" ? url === want : want.test(url)) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("Timeout waiting for URL");
    },
  };
  const ctx = { setDefaultTimeout: () => undefined, setDefaultNavigationTimeout: () => undefined, addInitScript: async () => undefined, route: async () => undefined, routeWebSocket: async () => undefined, newPage: async () => page, on: () => undefined, newCDPSession: async () => ({ on: () => undefined, send: async () => undefined }) };
  const browser = { newContext: async () => ctx, close: async () => undefined };
  setPlaywrightLoader({ load: async () => ({ chromium: { launch: async () => browser } }), available: () => true });
  const jobDir = mkdtempSync(path.join(os.tmpdir(), "refused-load-"));
  dirs.push(jobDir);
  const d = await launchDriver({ base: parseBase(BASE)!, executablePath: "/bin/false", jobDir, hostEnv: {}, onConsole: () => undefined });
  return { d, waits };
}

const blocked = (u: string): string => `page.goto: net::ERR_BLOCKED_BY_CLIENT at ${u}\nCall log:\n  - navigating to "${u}", waiting until "domcontentloaded"`;

describe("a refused load settles before the call returns", () => {
  it("waits for the error page to commit, so it cannot land on the next open", async () => {
    const { d } = await driver({ message: blocked, commitMs: 200 });
    await expect(d.go("http://127.0.0.2:1/redir")).rejects.toMatchObject({ code: "action_failed" });
    expect(d.url()).toMatch(/^chrome-error:/);
    // The caller parks, then opens the next page: nothing is left pending, so both land.
    await d.go("about:blank");
    await d.go(`${BASE}/`);
    expect(d.url()).toBe(`${BASE}/`);
    await new Promise((r) => setTimeout(r, 400));
    expect(d.url()).toBe(`${BASE}/`);
    await d.close();
  });

  it("an error page that never commits ends by timeout, with the original error, and the page unchanged", async () => {
    const { d } = await driver({ message: blocked });
    const t0 = Date.now();
    const err = await d.go("http://127.0.0.2:1/redir").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).code).toBe("action_failed");
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(d.url()).toBe("about:blank");
    await d.close();
  }, 25_000);

  it("another address committing leaves the wait by timeout and shows that address, for the origin check to judge", async () => {
    const { d } = await driver({ message: blocked, commitMs: 100, commitTo: "http://127.0.0.2:1/other" });
    await expect(d.go("http://127.0.0.2:1/redir")).rejects.toMatchObject({ code: "action_failed" });
    expect(d.url()).toBe("http://127.0.0.2:1/other");
    await d.close();
  }, 25_000);

  it("does not wait when only the address in the message holds the error name", async () => {
    const { d, waits } = await driver({ message: (u) => `page.goto: Timeout 30000ms exceeded.\nCall log:\n  - navigating to "${u}/net::ERR_BLOCKED_BY_CLIENT"`, commitMs: 200 });
    const t0 = Date.now();
    await expect(d.go("http://127.0.0.2:1/net::ERR_BLOCKED_BY_CLIENT")).rejects.toMatchObject({ code: "timeout" });
    expect(waits).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(150);
    await d.close();
  });

  it("waits for the error page after other network failures, and not after an abort", async () => {
    const refused = await driver({ message: (u) => `page.goto: net::ERR_CONNECTION_REFUSED at ${u}`, commitMs: 100 });
    await expect(refused.d.go("http://127.0.0.2:1/x")).rejects.toMatchObject({ code: "action_failed" });
    expect(refused.d.url()).toMatch(/^chrome-error:/);
    await refused.d.close();
    const aborted = await driver({ message: (u) => `page.goto: net::ERR_ABORTED at ${u}`, commitMs: 200 });
    await expect(aborted.d.go("http://127.0.0.2:1/x")).rejects.toMatchObject({ code: "action_failed" });
    expect(aborted.waits).toEqual([]);
    await aborted.d.close();
  });
});
