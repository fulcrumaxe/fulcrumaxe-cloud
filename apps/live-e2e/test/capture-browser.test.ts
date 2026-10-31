/**
 * The real launcher's close, against a stand-in Playwright context: route handlers are dropped first, and a failing
 * close is swallowed. Not faked: a real browser (capture-cleanup.test.ts runs one for the signal paths).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const closed = (what: string): Promise<never> => Promise.reject(new Error(`${what}: Request context disposed. Call log: x-vercel-protection-bypass: sentinel-secret`));

vi.mock("@playwright/test", () => ({
  test: { extend: () => ({}) }, // fixtures/bypass.ts builds its `test` on import; the launcher only needs its handler
  chromium: {
    launchPersistentContext: async () => ({
      route: async () => void calls.push("route"),
      pages: () => [{ goto: async () => undefined }],
      newPage: async () => ({ goto: async () => undefined }),
      cookies: async () => [],
      unrouteAll: async (o: { behavior?: string }) => {
        calls.push(`unrouteAll:${o.behavior}`);
        return closed("unrouteAll");
      },
      close: async () => {
        calls.push("close");
        return closed("close");
      },
    }),
  },
}));

import { chromiumLauncher } from "../fixtures/capture-browser.js";

describe("chromiumLauncher close", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("unroutes with ignoreErrors before closing, and resolves even when both reject", async () => {
    const browser = await chromiumLauncher({ profileDir: "/nonexistent", origin: "https://staging.example.test", startPath: "/", bypassSecret: "sentinel-secret", headless: true });
    await expect(browser.close()).resolves.toBeUndefined();
    // Exactly one route (the bypass handler) and no fence on this context, so dropping every route on close removes nothing else.
    expect(calls).toEqual(["route", "unrouteAll:ignoreErrors", "close"]);
  });
});
