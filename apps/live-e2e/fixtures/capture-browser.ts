/**
 * The browser behind `capture-session`: Playwright's browser in a fresh persistent profile (the owner's capture is
 * headed; tests pass `headless`). It lives here, not under src/, so nothing the offline `plan` path loads can start a
 * browser: the CLI imports this file only when a capture is actually run.
 */
import { chromium } from "@playwright/test";
import { SESSION_COOKIE_NAME } from "../src/store.js";
import type { Launcher } from "../src/sessions.js";
import { bypassRouteHandler } from "./bypass.js";

export const chromiumLauncher: Launcher = async (o) => {
  const context = await chromium.launchPersistentContext(o.profileDir, {
    headless: o.headless,
    serviceWorkers: "block",
    // captureSession handles these signals itself: Playwright's own handler would exit the process while the profile is still on disk.
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  if (o.bypassSecret !== undefined) {
    await context.route("**/*", bypassRouteHandler(o.origin, o.bypassSecret));
  }
  const page = context.pages()[0] ?? (await context.newPage());
  // A redirect chain to github.com interrupts the first navigation; the owner carries on by hand.
  await page.goto(new URL(o.startPath, o.origin).href).catch(() => undefined);
  return {
    cookie: async () => (await context.cookies(o.origin)).find((c) => c.name === SESSION_COOKIE_NAME)?.value,
    close: async () => {
      // Route handlers still in flight (a stylesheet fetch) must not reject into the process once the context goes:
      // drop them first, and never let a close failure carry Playwright's call log (it embeds request headers).
      await context.unrouteAll({ behavior: "ignoreErrors" }).catch(() => undefined);
      await context.close().catch(() => undefined);
    },
  };
};

