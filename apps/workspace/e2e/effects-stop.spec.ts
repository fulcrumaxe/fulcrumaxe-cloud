// apps/workspace/e2e/effects-stop.spec.ts
//
// D#37 WS-E criterion 5 (PR #187 review round 1, MUST 2): Playwright proof
// that rain.js's setTimeout-driven loop and theme-effects.js's grain
// requestAnimationFrame loop both actually stop scheduling new callbacks
// when (a) the tab goes document.hidden, (b) prefers-reduced-motion
// engages, and (c) under the "phone" Playwright project -- plus a positive
// control proving both DO keep scheduling on desktop with motion allowed
// and the page visible.
//
// Instrumentation: window.setTimeout / window.requestAnimationFrame are
// wrapped by an init script installed before any page script runs (see
// instrumentEffectTimers() below). Each wrapper inspects its own call
// stack for the scheduling file's name -- rain.js and core/theme-effects.js
// are served unbundled, one <script type="module"> per file (see
// shell/index.html), so the calling file's name is always present in the
// stack of whatever scheduled the timer/frame. This counts real calls the
// app itself makes; it never modifies rain.js's or theme-effects.js's own
// source.
//
// Deliberately does NOT use page.clock.runFor() to observe these effects
// (only to fast-forward the boot sequence, same as every other e2e spec
// here) -- see rain.js's own top-of-file comment: a long runFor() call
// pumps a real paint tick per pending requestAnimationFrame callback,
// which is what made an earlier rAF-based rain implementation time out
// idle-network.spec.ts. The observation windows below are short (a few
// multiples of one frame interval), so a real (non-virtual)
// page.waitForTimeout is used instead -- the same fake-clock-boot-then-
// real-time-observe mix phone-perf.spec.ts already uses.
//
// The default "classic-crt" theme ships with effect-grain: "0" (grain
// off), so grain never starts on a stock boot regardless of device --
// that would make "grain never starts on phone" vacuous (it is already
// off for everyone). Every test below first turns grain on via a nonzero
// effect-grain token (retro-amber's own value, 0.3 -- see
// core/themes/retro-amber.json) applied through the exact live
// FULCEffects module instance the page's own <script type="module">
// already loaded (grabbed by dynamic import() of that script tag's
// resolved URL -- module specifiers de-duplicate by URL, so this is the
// same singleton, not a second independent instance).

import { test, expect, type Page } from "@playwright/test";
import { bootToDesktop } from "./helpers/boot";

const GRAIN_VALUE = "0.3"; // retro-amber's effect-grain token
const OBSERVE_MS = 300; // several multiples of rain's 33ms tick and a display's ~16ms frame
const SETTLE_MS = 150; // lets an async mq.addEventListener('change', ...) listener actually run before we start counting

// The boot (helpers/boot.ts) wraps window.setTimeout/requestAnimationFrame via its beforeGoto hook.
// The wrap MUST be installed via addInitScript AFTER page.clock.install()
// (not before): page.clock installs its own init script that replaces
// window.setTimeout/requestAnimationFrame with its virtualized versions, so a
// wrapper added before it is instantly discarded, wrapping nothing real. Init
// scripts run in the order they were added, so registering the wrap second
// guarantees it sits on top of whatever page.clock installed underneath -- it
// is only the actual browser-visible window.setTimeout /
// window.requestAnimationFrame that matters for this test, not which
// implementation backs it (empirically verified: with the fake clock paused
// after boot's runFor(), grain's requestAnimationFrame calls still land at the
// real display refresh rate, not on a virtual cadence). The helper's
// beforeGoto hook runs between its clock install and its navigation.

// Wraps window.setTimeout/requestAnimationFrame so it sees every call
// rain.js and theme-effects.js make from boot onward. Must be called after
// page.clock.install() -- see bootToDesktop's comment above.
async function instrumentEffectTimers(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __rainTimeoutCalls: number; __grainRafCalls: number };
    w.__rainTimeoutCalls = 0;
    w.__grainRafCalls = 0;

    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if ((new Error().stack || "").includes("/rain.js")) w.__rainTimeoutCalls++;
      return nativeSetTimeout(handler as never, timeout, ...args);
    }) as typeof window.setTimeout;

    const nativeRaf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      if ((new Error().stack || "").includes("/theme-effects.js")) w.__grainRafCalls++;
      return nativeRaf(cb);
    }) as typeof window.requestAnimationFrame;
  });
}

async function counts(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as { __rainTimeoutCalls: number; __grainRafCalls: number };
    return { rain: w.__rainTimeoutCalls, grain: w.__grainRafCalls };
  });
}

// Turns grain on via the page's own already-loaded FULCEffects module
// instance -- see module comment above for why a nonzero value has to be
// injected at all, and why dynamic import() of the script tag's own
// resolved URL reaches the same singleton rather than a fresh one.
async function enableGrain(page: Page) {
  await page.evaluate(async (grainValue) => {
    const script = document.querySelector('script[src="core/theme-effects.js"]');
    if (!script) throw new Error("core/theme-effects.js script tag not found");
    const url = new URL(script.getAttribute("src") || "", document.baseURI).href;
    const mod = (await import(url)) as { FULCEffects: { apply: (tokens: Record<string, string>) => void } };
    mod.FULCEffects.apply({ "effect-grain": grainValue });
  }, GRAIN_VALUE);
}

test.describe("D#37 WS-E criterion 5: rain and grain stop scheduling", () => {
  test("positive control (desktop): both keep scheduling with motion allowed and the page visible", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "desktop-only control");
    await bootToDesktop(page, { beforeGoto: instrumentEffectTimers });
    await enableGrain(page);

    const before = await counts(page);
    await page.waitForTimeout(OBSERVE_MS);
    const after = await counts(page);

    expect(after.rain, "rain should keep scheduling setTimeout ticks").toBeGreaterThan(before.rain);
    expect(after.grain, "grain should keep scheduling requestAnimationFrame").toBeGreaterThan(before.grain);
  });

  test("(a) document.hidden: both stop scheduling new callbacks", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "device-independent state; desktop avoids redundant runs");
    await bootToDesktop(page, { beforeGoto: instrumentEffectTimers });
    await enableGrain(page);

    await page.waitForTimeout(OBSERVE_MS);
    const running = await counts(page);
    expect(running.rain, "rain must actually be running before this proves it stops").toBeGreaterThan(0);
    expect(running.grain, "grain must actually be running before this proves it stops").toBeGreaterThan(0);

    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { value: true, configurable: true });
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    const before = await counts(page);
    await page.waitForTimeout(OBSERVE_MS);
    const after = await counts(page);

    expect(after.rain, "no new rain setTimeout calls once hidden").toBe(before.rain);
    expect(after.grain, "no new grain requestAnimationFrame calls once hidden").toBe(before.grain);
  });

  test("(b) prefers-reduced-motion: both stop scheduling new callbacks", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "device-independent state; desktop avoids redundant runs");
    await bootToDesktop(page, { beforeGoto: instrumentEffectTimers });
    await enableGrain(page);

    await page.waitForTimeout(OBSERVE_MS);
    const running = await counts(page);
    expect(running.rain, "rain must actually be running before this proves it stops").toBeGreaterThan(0);
    expect(running.grain, "grain must actually be running before this proves it stops").toBeGreaterThan(0);

    await page.emulateMedia({ reducedMotion: "reduce" });

    // Unlike document.hidden (checked synchronously inside the already-
    // scheduled callback itself), grain only stops via an async
    // mq.addEventListener('change', ...) listener calling
    // cancelAnimationFrame -- give that listener a settle window to
    // actually run before snapshotting "before", so this doesn't race the
    // CDP media-emulation round-trip against an in-flight frame.
    await page.waitForTimeout(SETTLE_MS);

    const before = await counts(page);
    await page.waitForTimeout(OBSERVE_MS);
    const after = await counts(page);

    expect(after.rain, "no new rain setTimeout calls once reduced motion engages").toBe(before.rain);
    expect(after.grain, "no new grain requestAnimationFrame calls once reduced motion engages").toBe(before.grain);
  });

  test("(c) phone project: neither ever schedules, even when grain is turned on", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "phone", "phone-only assertion");
    await bootToDesktop(page, { beforeGoto: instrumentEffectTimers });
    await enableGrain(page);

    await page.waitForTimeout(OBSERVE_MS);
    const after = await counts(page);

    expect(after.rain, "rain must never schedule on the phone project").toBe(0);
    expect(after.grain, "grain must never schedule on the phone project, even when enabled").toBe(0);
  });
});
