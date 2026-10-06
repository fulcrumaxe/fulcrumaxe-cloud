// apps/workspace/e2e/heritage-themes.spec.ts
//
// D#37 Correction C19 (discussioncomment 18606574), task WS-TH1, C19b
// criterion 6. Reuses the exact harness tt-walk.spec.ts and
// milestone-local.spec.ts stood up: real Postgres, `next build` then
// `next start`, real Chromium, the test-auth sign-in through
// FX_GITHUB_AUTHORIZE_URL, and the app's real, already-ENFORCED CSP
// (`require-trusted-types-for 'script'; trusted-types 'none'` -- WS-C4
// merged this as the permanent header, not a Report-Only flag this file
// needs to opt into). Skipped without MILESTONE_BASE_URL (same opt-in
// convention). Run with `http://localhost:<port>` (not 127.0.0.1 --
// Chromium treats "localhost" as a secure context, so __Host-fx_session
// is kept without a TLS terminator; confirmed by tt-walk.spec.ts's own
// header comment and #153's security review).
//
// D#37 WS-TH1 fix round 1 (owner ruling 2026-09-25): Aero+ (windows-aero)
// and Yaru+ (ubuntu-gnome) are not fully worked and do not ship in cloud --
// removed from this suite along with the CASES they drove. The remaining
// two heritage-fidelity themes are applied in turn through the real Themes
// app UI (dock icon -> theme-card-apply button, same as tt-walk.spec.ts's
// own Themes-app walk), and asserts C19b's table for each:
//
//   Theme (id)   heritage-adapter   body[data-heritage]
//   orchard      orchard            "orchard"
//   crystal      crystal            "crystal"
//
// D#37 WS-D criterion 8 (OPEN OWNER DECISION 2, C19e): the two theme ids
// below were renamed from macos-sonoma/windows-fluent to orchard/crystal
// (the same ids their heritage adapters already used) -- updated here per
// C19e's own instruction that a rename landing after WS-TH1 updates this
// file's theme-id constant.
//
// Every theme also gets: body's computed --accent equals that theme's own
// tokens.accent (root cause 2/criterion 5's fix -- the whole point of this
// suite catching a regression there); the heritage taskbar/menubar-or-dock
// present and native #taskbar hidden; and #rain-bg not visible.
//
// PR #163 review (blocking item 1): a stale `data-theme` left over from an
// earlier legacy-mapped theme can shadow a LATER theme's own tokens once a
// heritage adapter's `restoreDataTheme()` writes it back after
// theme-manager.js has already moved on. The SWITCH_SEQUENCES block below
// reproduces the reviewer's exact live measurements on 2715c1e (all three
// gave the SOURCE theme's stale accent instead of the destination theme's
// own) and fails on that head; it passes once style.css's legacy blocks
// are keyed on data-experience too and restoreDataTheme() only restores
// its own sentinel (orchard-adapter.js / crystal-adapter.js).
//
// PR #163 review (blocking item 2): a positive control (tt-walk.spec.ts's
// own pattern) proves the CSP listener actually catches a violation, so
// the "zero violations" count below isn't vacuous.
//
// PR #163 review (should-fix): this file and jpos-parity.spec.ts both
// start a fake GitHub-authorize server on the same hardcoded port: with
// playwright.config.ts's "desktop" and "phone" projects both selected
// (the default, no --project flag) and fullyParallel:true, that's an
// EADDRINUSE race (reproduced by the reviewer). Nothing here is
// viewport-dependent, so the phone project's run is a pure duplicate --
// skipped below rather than serialized.
//
// Across the WHOLE run: zero `securitypolicyviolation` events and zero
// console errors before the positive control -- proof the heritage
// adapters' rewritten DOM-builder code (this task's Trusted Types sink
// removal) actually runs clean under the enforced policy, not just that
// the CSP is still set.

import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeGithubAuthorize } from "./fake-github-authorize.mjs";

const BASE_URL = process.env.MILESTONE_BASE_URL;
const FAKE_AUTHORIZE_PORT = process.env.MILESTONE_FAKE_AUTHORIZE_PORT
  ? Number(process.env.MILESTONE_FAKE_AUTHORIZE_PORT)
  : 4610;

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const THEMES_DIR = join(TEST_DIR, "..", "shell", "core", "themes");

interface ThemeCase {
  id: string;
  heritage: "orchard" | "crystal";
}

const CASES: ThemeCase[] = [
  { id: "crystal", heritage: "crystal" },
  { id: "orchard", heritage: "orchard" },
];

// PR #163 review, blocking item 1. Each sequence's last step is the theme
// whose accent must win; the earlier steps set up the stale `data-theme`
// this fix closes. Live on 2715c1e (reviewer's measurement): all three
// gave the FIRST step's accent instead (Nord's #00D4FF, twice, and
// Cyberpunk's #FF4141) -- `themeAccent()` below reads the expected value
// from the same theme JSON the app itself fetches, so this doesn't
// hardcode a hex value that could drift from the token file.
const SWITCH_SEQUENCES: string[][] = [
  ["nord", "crystal", "classic-crt"],
  ["nord", "crystal", "retro-amber"],
  ["cyberpunk", "orchard", "corporate"],
];

function themeAccent(id: string): string {
  const json = JSON.parse(readFileSync(join(THEMES_DIR, `${id}.json`), "utf8"));
  return json.tokens.accent;
}

async function signInAndReachDesktop(page: Page): Promise<void> {
  const base = BASE_URL!;
  // See tt-walk.spec.ts's own signInAndReachDesktop for why
  // "domcontentloaded" (not the default "load") is used here.
  await page.goto(base + "/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#cloud-login-screen")).toBeVisible({ timeout: 15_000 });
  await page.locator("#cloud-login-screen a").first().click();
  await expect(page.locator("#cloud-login-screen")).toBeHidden({ timeout: 15_000 });
  await page.waitForFunction(() => (window as unknown as { currentStep?: string }).currentStep === "DESKTOP", {
    timeout: 15_000,
  });
  await expect(page.locator("#desktop-screen")).not.toHaveClass(/hidden/);
}

async function openThemesApp(page: Page) {
  await page.locator('.dock-icon[data-app-id="themes"]').click();
  const win = page.locator('#windows-container .fulc-window[data-app-id="themes"]');
  await expect(win).toBeVisible({ timeout: 10_000 });
  return win;
}

async function applyTheme(page: Page, win: ReturnType<Page["locator"]>, id: string) {
  const applyBtn = win.locator(`.theme-card[data-experience-id="${id}"] .theme-card-apply`);
  // Already-active card's button reads "★ Active" and has no click handler
  // attached (themesRenderGallery only wires it for exp.id !== currentId)
  // -- skip the click in that case, the assertions below still hold.
  const label = await applyBtn.textContent();
  if (label && label.includes("Active")) return;
  await applyBtn.click();
  await page.waitForFunction(
    (expId) => document.body.dataset.experience === expId,
    id,
    { timeout: 10_000 },
  );
}

async function bodyAccent(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.body).getPropertyValue("--accent").trim());
}

test.describe("D#37 WS-TH1 criterion 6: theme fidelity under the enforced CSP", () => {
  test.skip(!BASE_URL, "MILESTONE_BASE_URL not set -- opt-in only, see this file's header comment");
  test.setTimeout(120_000);

  test("Fluent+ and Cupertino+ carry the right tokens and chrome; switching sequences don't leak a stale accent; CSP violations are zero plus one proven control", async ({}, testInfo) => {
    // See this file's header comment (should-fix): desktop and phone would
    // otherwise both bind FAKE_AUTHORIZE_PORT at once. Nothing this test
    // checks is viewport-dependent, so the phone run is a pure duplicate.
    test.skip(testInfo.project.name === "phone", "desktop-only: avoids colliding with the desktop project on the fake-authorize port (see header comment)");

    const base = BASE_URL!;
    const fakeAuthorize = await startFakeGithubAuthorize({ port: FAKE_AUTHORIZE_PORT, callbackBase: base });
    const browser: Browser = await chromium.launch();
    try {
      const cspViolations: string[] = [];
      const consoleErrors: string[] = [];

      const context = await browser.newContext();
      const page = await context.newPage();
      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });
      await page.exposeFunction("__heritageCspReport", (detail: string) => {
        cspViolations.push(detail);
      });
      await page.addInitScript(() => {
        document.addEventListener("securitypolicyviolation", (e) => {
          (window as unknown as { __heritageCspReport: (s: string) => void }).__heritageCspReport(
            `${e.violatedDirective}: ${e.blockedURI}`,
          );
        });
      });

      await signInAndReachDesktop(page);
      const win = await openThemesApp(page);

      for (const { id, heritage } of CASES) {
        await applyTheme(page, win, id);

        const accent = await bodyAccent(page);
        expect(accent, `body --accent for ${id}`).toBe(themeAccent(id));

        const dataHeritage = await page.evaluate(() => document.body.dataset.heritage ?? null);
        expect(dataHeritage, `body[data-heritage] for ${id}`).toBe(heritage);

        if (heritage === "orchard") {
          await expect(page.locator("#orchard-menubar")).toBeVisible();
          await expect(page.locator("#orchard-dock")).toBeVisible();
          await expect(page.locator("#taskbar")).toBeHidden();
          await expect(page.locator("#crystal-taskbar")).toHaveCount(0);
        } else {
          await expect(page.locator("#crystal-taskbar")).toBeVisible();
          await expect(page.locator("#taskbar")).toBeHidden();
          await expect(page.locator("#orchard-menubar")).toHaveCount(0);
          await expect(page.locator("#orchard-dock")).toHaveCount(0);
        }

        await expect(page.locator("#rain-bg"), `rain hidden for ${id}`).not.toBeVisible();
      }

      // ── Switching sequences (PR #163 review, blocking item 1) ──────────
      // Each sequence reloads first: whether a leak reproduces depends on
      // exactly which theme a heritage adapter's overrideDataTheme() saved
      // as "the value to restore" on its OWN most recent activation, which
      // depends on the CASES loop and any earlier sequence's history --
      // without resetting, a later sequence can accidentally land back on
      // a value that happens to match its own destination (confirmed: run
      // sequentially without a reload after this test's own CASES loop,
      // sequence 1 alone passed even on unfixed 2715c1e purely by that
      // coincidence). localStorage is cleared before each reload -- the
      // CASES loop above just stored "orchard" as the preferred
      // experience, and without clearing it a reload boots straight back
      // into orchard, which hides the desktop's #desktop-icon
      // grid AND its .dock-icon elements by design (orchard has its own
      // dock) -- openThemesApp()'s dock-icon click then waits forever
      // (confirmed: this hung the whole test at the test-level timeout,
      // not a clean assertion failure). Clearing storage first guarantees
      // the same boot.js default (classic-crt, no heritage adapter) every
      // reload gets, exactly like a genuinely fresh page load would.
      for (const steps of SWITCH_SEQUENCES) {
        await page.evaluate(() => {
          try {
            localStorage.clear();
          } catch {
            /* ignore */
          }
        });
        await page.goto(base + "/", { waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => (window as unknown as { currentStep?: string }).currentStep === "DESKTOP", {
          timeout: 15_000,
        });
        const seqWin = await openThemesApp(page);

        for (const stepId of steps) {
          await applyTheme(page, seqWin, stepId);
        }
        const finalId = steps[steps.length - 1];
        const accent = await bodyAccent(page);
        expect(accent, `body --accent after ${steps.join(" -> ")}`).toBe(themeAccent(finalId));
      }

      expect(cspViolations, `CSP violations: ${JSON.stringify(cspViolations)}`).toEqual([]);
      expect(consoleErrors, `console errors: ${JSON.stringify(consoleErrors)}`).toEqual([]);

      // ── Positive control (PR #163 review, blocking item 2) ─────────────
      // Mirrors tt-walk.spec.ts's own control: proves the listener actually
      // catches a violation, so the zero counts above aren't vacuous (an
      // unattached listener, or a page that silently stopped receiving
      // events, would also report "zero").
      const beforeControl = cspViolations.length;
      await page.evaluate(() => {
        const el = document.createElement("div");
        try {
          el.innerHTML = "<b>heritage-themes-positive-control</b>";
        } catch {
          // expected under the enforced policy -- see tt-walk.spec.ts's own comment.
        }
      });
      await page.waitForTimeout(500);
      expect(
        cspViolations.length,
        "positive control: assigning a string to .innerHTML must fire at least one securitypolicyviolation -- otherwise the zero count above is vacuous",
      ).toBeGreaterThan(beforeControl);
    } finally {
      await browser.close();
      await fakeAuthorize.stop();
    }
  });
});
