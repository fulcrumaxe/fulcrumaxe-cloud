// apps/workspace/e2e/helpers/boot.ts
//
// One way to boot the workspace under the page clock and reach the desktop.
//
// Why it is not "install the clock, goto, runFor(15 s), wait 10 s": core/boot.js fetches /api/mode under
// a 5 s abort timer (MODE_FETCH_TIMEOUT_MS). A single 15 s fast-forward fires that timer at once when the
// fetch is still in flight, which on a loaded machine happens about one boot in a dozen. The page then
// shows its fail-closed screen and currentStep never leaves COMMAND. Fast-forwarding is only safe while no
// boot request is in flight, so the clock moves in small steps and stands still while one is.

import type { Page, Request } from "@playwright/test";

const STEP_MS = 500;
const BOUND_MS = 60_000;
// currentStep flips to DESKTOP 200 ms before script.js restores (or opens) the first windows, and the dock
// and window animations follow. The old 15 s fast-forward ran all of that; one more step does it here.
const SETTLE_MS = 1_000;

// The shell's own boot calls. /api/v1/* is the product API (and the live event stream), not boot.
const bootRequest = (r: Request) => {
  const p = new URL(r.url()).pathname;
  return p.startsWith("/api/") && !p.startsWith("/api/v1/");
};

const inFlight = new WeakMap<Page, Set<Request>>();
/** Pages whose clock bootToDesktop holds still until the desktop is up (stepToDesktop then lets it run again). */
const heldStill = new WeakSet<Page>();
/** Pages whose latest /api/mode request has been answered; boot aborts that request after 5 s of page time. */
const modeAnswered = new WeakSet<Page>();
const isMode = (r: Request) => new URL(r.url()).pathname === "/api/mode";

function watch(page: Page): Set<Request> {
  const set = inFlight.get(page);
  if (set) return set;
  const open = new Set<Request>();
  inFlight.set(page, open);
  page.on("request", (r) => {
    if (isMode(r)) modeAnswered.delete(page);
    if (bootRequest(r)) open.add(r);
  });
  const answered = (r: Request) => {
    open.delete(r);
    if (isMode(r)) modeAnswered.add(page);
  };
  page.on("requestfinished", answered);
  page.on("requestfailed", answered);
  return open;
}

/** Steps the page clock until currentStep is DESKTOP and the first windows are up; also the way to wait after a reload. */
export async function stepToDesktop(page: Page, opts: { boundMs?: number; stepMs?: number } = {}): Promise<void> {
  const open = watch(page);
  const startedAt = Date.now();
  const deadline = startedAt + (opts.boundMs ?? BOUND_MS);
  for (;;) {
    const seen = await page.evaluate(() => ({
      step: (window as unknown as { currentStep?: string }).currentStep ?? "(unset)",
      failClosed: !!document.getElementById("fail-closed-screen"),
    }));
    if (seen.step === "DESKTOP") {
      await page.clock.runFor(SETTLE_MS);
      if (heldStill.delete(page)) await page.clock.resume(); // from here the clock runs as it always did after this helper
      return;
    }
    if (Date.now() > deadline) {
      const waiting = [...open].map((r) => new URL(r.url()).pathname).join(", ") || "none";
      throw new Error(
        `boot did not reach DESKTOP within ${opts.boundMs ?? BOUND_MS} ms; last currentStep: ${seen.step}` +
          `${seen.failClosed ? " (fail-closed screen showing)" : ""}; boot requests still in flight: ${waiting}`,
      );
    }
    // Never move the clock while /api/mode is unanswered. The page's own fetch can be served from the HTML preload, which
    // shows up here as one request that is already finished, so "nothing in flight" alone does not say the page has its
    // answer; and a loaded machine can take longer than boot's 5 s abort in real time to give it.
    // (If no /api/mode request is ever seen at all, e.g. a page that did not boot from the network, the old rule applies after 10 s.)
    if (open.size === 0 && (modeAnswered.has(page) || Date.now() - startedAt > 10_000)) await page.clock.runFor(opts.stepMs ?? STEP_MS);
    else await page.waitForTimeout(25);
  }
}

/**
 * Installs the page clock, opens the app and waits for the desktop. beforeGoto runs after the clock is installed and
 * before the navigation: init scripts run in the order they were added, so one added there sits on top of the clock's.
 */
export async function bootToDesktop(
  page: Page,
  opts: {
    time?: string;
    url?: string;
    boundMs?: number;
    stepMs?: number;
    beforeGoto?: (page: Page) => Promise<void>;
    /** Leave the page clock stopped once the desktop is up (default: let it run), for a test that drives it with runFor alone. */
    keepPaused?: boolean;
  } = {},
): Promise<void> {
  watch(page);
  // Installed a second early and paused at the wanted time: the page then boots at exactly that time and its clock moves
  // only when stepToDesktop moves it (a running clock would make boot's 5 s mode timer a race against the machine's load).
  const at = new Date(opts.time ?? "2026-01-01T00:00:00Z");
  await page.clock.install({ time: new Date(at.getTime() - 1_000) });
  await page.clock.pauseAt(at);
  if (!opts.keepPaused) heldStill.add(page);
  await opts.beforeGoto?.(page);
  await page.goto(opts.url ?? "/");
  await stepToDesktop(page, opts);
}

/**
 * Stops the page clock (bootToDesktop leaves it running), so that from here only runFor moves it: a countdown or a poll
 * is then driven by the test and not by how slow the machine is. pauseAt refuses a time that is already past, and on a
 * loaded machine the clock can run on between reading it and asking, so the margin grows until the pause is accepted.
 */
export async function holdClock(page: Page): Promise<void> {
  for (let margin = 1_000; ; margin *= 4) {
    const now = await page.evaluate(() => Date.now());
    try {
      await page.clock.pauseAt(now + margin);
      return;
    } catch (e) {
      if (margin > 60_000) throw e;
    }
  }
}

/**
 * For specs that open the app on the real page clock (no fake clock, e.g. because the live client starts on a
 * performance mark the fake one replaces). Boot gives /api/mode 5 s of page time, which a loaded machine can run out
 * in real time, and then shows the fail-closed screen. That screen is the app working as designed, and its RETRY button
 * reloads the page, so this does what a person would: it presses RETRY and waits again. Nothing is slept.
 */
export async function waitForDesktop(page: Page, opts: { boundMs?: number } = {}): Promise<void> {
  const bound = opts.boundMs ?? BOUND_MS;
  const deadline = Date.now() + bound;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`boot did not reach DESKTOP within ${bound} ms`);
    const state = await page
      .waitForFunction(
        () =>
          (window as unknown as { currentStep?: string }).currentStep === "DESKTOP"
            ? "desktop"
            : document.getElementById("fail-closed-screen")
              ? "failed"
              : false,
        null,
        { timeout: left },
      )
      .then((h) => h.jsonValue())
      .catch(() => {
        throw new Error(`boot did not reach DESKTOP within ${bound} ms`);
      });
    if (state === "desktop") return;
    await Promise.all([page.waitForEvent("load"), page.locator("#fail-closed-retry").click()]);
  }
}
