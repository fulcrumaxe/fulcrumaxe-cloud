// apps/workspace/e2e/idle-network.spec.ts
//
// D#37 WS-B criterion 5: the built dist/ served by fixture-server.mjs
// (signed-in cloud fixture), left idle for 10 minutes of FAKE time
// (page.clock) after the desktop is ready, makes zero requests and zero
// WebSocket attempts, and logs zero console errors. Runs against both the
// "desktop" and "phone" Playwright projects (see playwright.config.ts).
//
// Sequencing note: core/boot.js's runBoot() awaits several real
// `setTimeout`-based delays before it ever calls fetchMode() (the boot-log
// "typing" animation, ~13 lines at up to 500ms each, plus a 1000ms pause),
// and script.js's showDesktop() wraps its own work in a 1500ms + 200ms
// setTimeout cascade. page.clock.install() virtualizes every one of those
// setTimeout calls (it does NOT touch fetch/WebSocket I/O, which still
// resolves in real wall-clock time against the local fixture server), so
// the test has to explicitly fast-forward through the boot sequence before
// the desktop is "ready" -- only then does it start listening for
// requests/sockets/console errors and fast-forward the 10-minute idle
// window the criterion actually cares about.

import { test, expect } from "@playwright/test";
import { bootToDesktop } from "./helpers/boot";

const BOOT_FAST_FORWARD_MS = 15_000; // covers the boot-log animation + showDesktop's cascade, generously
const IDLE_MS = 10 * 60 * 1000;

test.describe("cloud profile: idle network", () => {
  // The 10-minute fast-forward runs every timer for real. It takes ~85s on a
  // 2-vCPU hosted runner (5s on the phone project), which left 5s of headroom
  // under the config's 90s.
  test.describe.configure({ timeout: 180_000 });

  test("zero requests, zero WebSocket attempts, zero console errors over 10 idle minutes", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => {
      consoleErrors.push(String(err));
    });

    // Drives the fake clock through the boot-log animation and showDesktop()'s
    // setTimeout cascade. Real network I/O (branding, mode, cloud auth,
    // entitlements, profile, preferences, license status) resolves in real
    // time; the helper holds the clock still while one of those is in flight.
    await bootToDesktop(page);
    await expect(page.locator("#desktop-screen")).not.toHaveClass(/hidden/);

    // Boot is done and its (legitimate) fetches have all settled. Any
    // console error captured up to here is a boot-sequence problem, not an
    // idle-network violation -- start the criterion's own clean count from
    // this point forward.
    consoleErrors.length = 0;

    const requestsDuringIdle: string[] = [];
    page.on("request", (req) => {
      requestsDuringIdle.push(`${req.method()} ${req.url()}`);
    });

    const websocketsDuringIdle: string[] = [];
    page.on("websocket", (ws) => {
      websocketsDuringIdle.push(ws.url());
    });

    await page.clock.runFor(IDLE_MS);

    expect(requestsDuringIdle, `unexpected request(s) during idle: ${requestsDuringIdle.join(", ")}`).toEqual([]);
    expect(
      websocketsDuringIdle,
      `unexpected WebSocket attempt(s) during idle: ${websocketsDuringIdle.join(", ")}`
    ).toEqual([]);
    expect(consoleErrors, `unexpected console error(s) during idle: ${consoleErrors.join(", ")}`).toEqual([]);
  });

  // PR #100 review round: core/features.js used to fail OPEN -- any failed
  // /api/mode read resolved to `{}`, and every consumer's `features.X ===
  // false` gate reads `undefined` as "enabled". core/boot.js's own mode
  // read falling back to the plain login-terminal screen (fetchMode()'s
  // catch already returns a `{mode:'server'}` fallback, never throws) means
  // the desktop never renders here -- these four core/*.js modules load and
  // run as ordinary <script> tags regardless of which screen boot.js shows,
  // which is exactly why a failed mode read has to close every gate on its
  // own, not rely on the desktop path to have never started them.
  test("mode read failure: zero requests after the mode read, zero WebSocket attempts", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => {
      consoleErrors.push(String(err));
    });

    await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });

    let modeReads = 0;
    await page.route("**/api/mode", (route) => {
      modeReads++;
      route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
    });

    await page.goto("/");

    // Fast-forward the boot-log animation's real setTimeout cascade -- same
    // budget as the healthy-path test above. fetchMode() runs right after
    // it and resolves against the intercepted (failing) route in real time,
    // not gated by the fake clock.
    await page.clock.runFor(BOOT_FAST_FORWARD_MS);

    // fetchMode()'s own await and every consumer's independent
    // core/features.js read are real I/O settling on a local intercept --
    // no real network RTT to wait out, but give them one turn before
    // asserting "nothing after this".
    await page.waitForTimeout(500);
    expect(modeReads, "expected at least one /api/mode read").toBeGreaterThan(0);

    // The intercepted 500 response(s) for /api/mode itself are expected --
    // the browser logs its own "Failed to load resource" console entry for
    // each one. That is the failure this test deliberately causes, not an
    // idle-network violation; start the clean count from here, same as the
    // healthy-path test above resets its own consoleErrors after boot.
    consoleErrors.length = 0;

    const requestsAfterModeRead: string[] = [];
    page.on("request", (req) => {
      requestsAfterModeRead.push(`${req.method()} ${req.url()}`);
    });
    const websocketsSeen: string[] = [];
    page.on("websocket", (ws) => {
      websocketsSeen.push(ws.url());
    });

    // Fast-forward a full idle window -- on the fail-open bug, presence.js
    // still calls connectWs() unconditionally past its (defeated) gate, and
    // taskbar.js/tray-update-indicator.js's already-registered intervals
    // reach their next tick inside this window.
    await page.clock.runFor(IDLE_MS);

    expect(
      requestsAfterModeRead,
      `unexpected request(s) after the mode read: ${requestsAfterModeRead.join(", ")}`
    ).toEqual([]);
    expect(
      websocketsSeen,
      `unexpected WebSocket attempt(s): ${websocketsSeen.join(", ")}`
    ).toEqual([]);
    expect(consoleErrors, `unexpected console error(s): ${consoleErrors.join(", ")}`).toEqual([]);
  });
});
