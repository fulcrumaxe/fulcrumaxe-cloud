// apps/workspace/e2e/tt-walk.spec.ts
//
// D#37 Correction C18 (discussioncomment 18604630), task WS-C5 criterion 6:
// the committed, opt-in Report-Only walk. Reuses the exact harness
// milestone-local.spec.ts stood up for WS-C2/criterion 15 -- real Postgres,
// `next build` then `next start`, real Chromium, and the test-auth sign-in
// through FX_GITHUB_AUTHORIZE_URL -- but drives every C18a surface instead
// of just sign-in/sign-out, and counts `securitypolicyviolation` events
// instead of asserting session behaviour.
//
// Skipped without MILESTONE_BASE_URL (same opt-in convention as
// milestone-local.spec.ts). WS-C4 re-runs this file against its own branch
// (the enforced CSP) per C18d. Unlike milestone-local.spec.ts, this walk
// needs no TLS terminator: plain `http://localhost` works, confirmed live
// by #153's security review (`pnpm exec playwright test
// e2e/tt-walk.spec.ts --project desktop` against a plain `next start`) --
// Chromium treats `localhost` (not `127.0.0.1`) as a secure context, so
// the `__Host-fx_session` cookie is still set and kept without TLS. Run
// MILESTONE_BASE_URL as `http://localhost:<port>`, not `127.0.0.1`.
//
// C18a's 10-file, 21-site table, and how this file reaches each site:
//   - "UI": a real user action (click, right-click, keyboard) a person
//     could actually perform in the cloud profile.
//   - "direct": the site has no shipped UI caller in the cloud profile
//     (the app that would call it is withheld, or a feature/mode flag
//     gates it off entirely), so this file calls the already-loaded
//     module's own exposed function directly -- still the real shipped
//     code, running under the real page's real CSP, just not reachable by
//     clicking anything.
//
// WS-C4 correction (#153 security review, "should-fix" item 2): the
// committed spec previously called system-tray.js and presence.js "not
// reachable" with "no exposed entry point". That was wrong for both:
// `FULCSystemTray.init`/`refreshStatus` and `FULCPresence.init` (plus
// `window.FULCPresence`) are all exposed. Both are genuinely gated
// server-side (system-tray behind `/api/mode`'s `mode !== 'local'`,
// presence behind `features.presence === false`), so reaching them for
// real means `page.route`-ing that server response and driving the
// exposed entry point, not clicking anything a real cloud-profile user
// could reach. system-tray.js has no "already initialized" guard, so its
// exposed `init()` can be called again, later in this same page, once
// `/api/mode` is routed to `'local'`. presence.js DOES have a one-shot
// guard (`if (initialized) return;`), set by its own auto-init at
// DOMContentLoaded before this file ever gets a chance to route
// `/api/mode` -- so presence.js is driven by routing `/api/mode` and a
// hostile `page.routeWebSocket` fixture for `/api/ws/presence`, THEN
// `page.reload()`-ing so the real auto-init runs fresh and picks up the
// routed response on its own. Both fixtures use SSID/display-name/color
// payloads that would be live XSS if the site's own `textContent`-only
// rendering (WS-C5) ever regressed to a sink.
//
// Positive control: after the whole walk records zero violations, one
// `page.evaluate` assigns a string to a fresh, unattached element's
// `.innerHTML` and asserts the listener actually saw it -- proof the zero
// above is not vacuous (an unattached listener, or a page that silently
// stopped receiving events, would also report "zero").
//
// Criterion 7 (server-side delivery, #153 security review "should-fix"
// item 1): the delivery check runs INSIDE this test, while the page and
// browser are still open, right after the positive control and before
// `browser.close()` -- closing the browser first (as the original,
// separate `test()` did) discards any in-flight `/api/csp-report` request
// before it can be sent, and its own 90s poll equalled Playwright's
// default 90s per-test timeout (playwright.config.ts), so the test timed
// out and failed instead of ever reaching its "no report" fallback. This
// test now calls `test.setTimeout()` to give itself enough budget for the
// interactive walk PLUS the up-to-90s poll. It polls the `next start`
// process log (path from MILESTONE_SERVER_LOG, written by whatever starts
// the server) for up to 90s for a `{"event":"csp_report"...}` line naming
// `require-trusted-types-for`. If none arrives, it still passes --
// criterion 6's DOM count is the authority (C18c) -- but records which
// case this run hit (delivered / never-reached / rejected) so the PR can
// report it accurately. A 403/413/415 rejection is a stop-and-report case
// per C18 criterion 7; this file surfaces it as a failed expectation
// rather than silently swallowing it.
//
// D#37 Correction C17b / WS-C4 criterion 4: a second, separately opt-in
// describe block below proves the real control -- enforced
// `require-trusted-types-for 'script'` -- actually blocks the three
// regex evasions C17b names (indirect eval, `Reflect.construct(Function,
// ...)`, a concatenated computed key), plus the original `.innerHTML`
// case and `setAttribute('src', ...)` on a script element. It only makes
// sense once the ENFORCED policy actually carries
// `require-trusted-types-for` (WS-C4 step 2) -- run it with
// MILESTONE_TT_ENFORCED=1 against that build; running it against the
// Report-Only parent build would fail every assertion, since Report-Only
// never blocks anything.

import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { startFakeGithubAuthorize, FAKE_IDENTITY } from "./fake-github-authorize.mjs";
import { seedAccountStatus } from "./seed-account-status.mjs";

const BASE_URL = process.env.MILESTONE_BASE_URL;
const FAKE_AUTHORIZE_PORT = process.env.MILESTONE_FAKE_AUTHORIZE_PORT
  ? Number(process.env.MILESTONE_FAKE_AUTHORIZE_PORT)
  : 4610;
const SERVER_LOG_PATH = process.env.MILESTONE_SERVER_LOG;

interface SiteRow {
  file: string;
  lines: string;
  reached: boolean;
  how: string;
}

// C18a's table, 10 files / 21 sites. `reached`/`how` are filled in by the
// walk below (setReached), never guessed ahead of time.
const SITES: SiteRow[] = [
  { file: "core/window-manager.js", lines: "347", reached: false, how: "" },
  { file: "apps/themes/themes-app.js", lines: "34, 67, 103", reached: false, how: "" },
  { file: "apps/themes/themes-preview.js", lines: "16", reached: false, how: "" },
  { file: "core/system-tray.js", lines: "129, 232, 269, 292, 305, 320, 329", reached: false, how: "" },
  { file: "core/hot-corners.js", lines: "155, 175, 218", reached: false, how: "" },
  { file: "keybindings.js", lines: "141, 277", reached: false, how: "" },
  { file: "core/upgrade-modal.js", lines: "28", reached: false, how: "" },
  { file: "core/channel-switcher.js", lines: "219", reached: false, how: "" },
  { file: "core/presence.js", lines: "186", reached: false, how: "" },
  { file: "sdk/fulc-sdk.umd.js", lines: "1025", reached: false, how: "" },
];

function setReached(file: string, how: string): void {
  const row = SITES.find((s) => s.file === file);
  if (!row) throw new Error(`tt-walk.spec.ts: unknown site file "${file}" -- table/walk drifted apart`);
  row.reached = true;
  row.how = how;
}

function printSiteTable(): void {
  const lines = ["", "WS-C5 tt-walk.spec.ts: 21-site reached/unreachable table", "-".repeat(70)];
  for (const row of SITES) {
    const status = row.how.startsWith("not reachable") ? row.how : `reached (${row.how})`;
    lines.push(`${row.file} (lines ${row.lines}): ${status}`);
  }
  lines.push("-".repeat(70), "");
  console.log(lines.join("\n"));
}

async function signInAndReachDesktop(page: Page): Promise<void> {
  const base = BASE_URL!;
  // "domcontentloaded" rather than the default "load": this local
  // verification run's throwaway TLS proxy (a plain Node pipe, not a real
  // reverse proxy) does not reliably settle every keep-alive subresource
  // connection the way a production TLS terminator would, so waiting for
  // the "load" event can hang past the navigation timeout even once the
  // page itself is fully interactive. Every assertion below already waits
  // explicitly (`toBeVisible`, `waitForFunction`) rather than relying on
  // "load" having fired, so this does not weaken what the walk checks.
  await page.goto(base + "/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#cloud-login-screen")).toBeVisible({ timeout: 15_000 });
  const links = page.locator("#cloud-login-screen a");
  await links.first().click();
  await expect(page.locator("#cloud-login-screen")).toBeHidden({ timeout: 15_000 });
  await page.waitForFunction(() => (window as unknown as { currentStep?: string }).currentStep === "DESKTOP", {
    timeout: 15_000,
  });
  await expect(page.locator("#desktop-screen")).not.toHaveClass(/hidden/);
}

async function runWalk(browser: Browser): Promise<{
  cspViolations: string[];
  consoleErrors: string[];
  failedRequests: string[];
  beforeControl: number;
  consoleErrorsBeforeControl: number;
}> {
  const cspViolations: string[] = [];
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("requestfailed", (req) => {
    failedRequests.push(`${req.method()} ${req.url()} -- ${req.failure()?.errorText}`);
  });
  page.on("response", (res) => {
    if (res.status() >= 400) failedRequests.push(`${res.status()} ${res.request().method()} ${res.url()}`);
  });
  // Same mechanism milestone-local.spec.ts uses: securitypolicyviolation
  // fires on the page's `document` for every violation of EITHER the
  // enforced or the Report-Only policy, independent of report delivery --
  // this is criterion 6's authoritative count (C18c).
  await page.exposeFunction("__ttWalkCspReport", (detail: string) => {
    cspViolations.push(detail);
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      (window as unknown as { __ttWalkCspReport: (s: string) => void }).__ttWalkCspReport(
        `${e.violatedDirective}: ${e.blockedURI} (${e.disposition})`,
      );
    });
  });

  // ── Sign in, reach the desktop ──────────────────────────────────────
  await signInAndReachDesktop(page);

  // ── Open Themes from the dock (window-manager.js:347, every window open) ──
  await page.locator('.dock-icon[data-app-id="themes"]').click();
  const themesWindow = page.locator('#windows-container .fulc-window[data-app-id="themes"]');
  await expect(themesWindow).toBeVisible({ timeout: 10_000 });
  setReached("core/window-manager.js", "opened the Themes window from the dock");

  // ── Let the gallery render (themes-preview.js:16, once per card) ──────
  const cards = themesWindow.locator(".theme-card");
  await expect(cards.first()).toBeVisible({ timeout: 10_000 });
  expect(await cards.count()).toBeGreaterThan(0);
  setReached("apps/themes/themes-preview.js", "gallery rendered at least one theme card");
  setReached("apps/themes/themes-app.js", "themesRender + themesRenderGallery ran when the window opened");

  // ── Click Apply on a theme that is not current ──────────────────────
  const inactiveApply = themesWindow.locator(".theme-card:not(.theme-card--active) .theme-card-apply").first();
  await expect(inactiveApply).toBeVisible({ timeout: 10_000 });
  await inactiveApply.click();
  // Applying re-renders the gallery (fulc-theme-change) -- card membership
  // in :not(.theme-card--active) shifts, so just confirm the gallery is
  // still healthy rather than asserting on a specific card.
  await expect(cards.first()).toBeVisible();

  // ── Use the quick settings section (themes-app.js:103) ───────────────
  await themesWindow.locator('.themes-tab[data-panel="quick"]').click();
  await expect(themesWindow.locator(".themes-quick-select").first()).toBeVisible({ timeout: 10_000 });
  setReached("apps/themes/themes-app.js", "themesRenderQuick ran via the Quick Settings tab (line 103)");

  // ── Close the window and reopen it ──────────────────────────────────
  await themesWindow.locator(".window-close").click();
  await expect(themesWindow).toBeHidden({ timeout: 10_000 });
  await page.locator('.dock-icon[data-app-id="themes"]').click();
  await expect(page.locator('#windows-container .fulc-window[data-app-id="themes"]')).toBeVisible({ timeout: 10_000 });

  // ── Hot corners panel: right-click the desktop, "Hot Corners..." ─────
  // A fixed position clear of both the Themes window's default cascade
  // position (window content starts at x>=60,y>=40 and only shifts
  // further right/down on each subsequent open) and the taskbar/dock
  // (bottom edge of the viewport, where a pinned running app's dock icon
  // otherwise intercepts the click -- confirmed live: (10,10) hit the
  // dock, not the desktop) so this click always lands on the desktop
  // surface itself.
  await page.locator("#desktop-surface").click({ button: "right", position: { x: 900, y: 300 } });
  const hotCornersItem = page.locator(".fulc-context-menu .fulc-ctx-item", { hasText: "Hot Corners" });
  await expect(hotCornersItem).toBeVisible({ timeout: 10_000 });
  await hotCornersItem.click();
  const hcDialog = page.locator(".hc-dialog");
  await expect(hcDialog).toBeVisible({ timeout: 10_000 });
  // hc-diagram-grid / hc-screensaver-section are both built when the dialog
  // opens (lines 175 and 218); the titlebar (line 155) is built with it.
  await expect(hcDialog.locator(".hc-diagram-grid")).toBeVisible();
  await expect(hcDialog.locator(".hc-screensaver-section")).toBeVisible();
  await hcDialog.locator(".hc-dialog-close").click();
  await expect(hcDialog).toBeHidden({ timeout: 10_000 });
  setReached("core/hot-corners.js", 'right-clicked the desktop and opened "Hot Corners..." from the context menu');

  // ── Keybindings overlay + bottom bar: no shipped caller in the cloud ──
  // profile (the Code Editor app that normally binds Ctrl+, and populates
  // .editor-shortcuts is dropped in profiles/cloud.json's drop_core). The
  // module itself still ships (index.html loads keybindings.js
  // unconditionally as core), so this drives it directly through its own
  // exposed API -- the exact code path a shipped caller would run, just
  // without a UI trigger to click.
  await page.evaluate(async () => {
    const mod = await import("/keybindings.js");
    mod.FULCKeys.open();
    mod.FULCKeys.updateEditorShortcutBar();
  });
  await expect(page.locator("#keybindings-overlay")).not.toHaveClass(/hidden/);
  await expect(page.locator("#keybindings-body .keybindings-row").first()).toBeVisible({ timeout: 10_000 });
  await page.evaluate(async () => {
    const mod = await import("/keybindings.js");
    mod.FULCKeys.close();
  });
  setReached(
    "keybindings.js",
    "called FULCKeys.open()/updateEditorShortcutBar() directly -- no shipped caller binds Ctrl+, in the cloud profile (Code Editor app is drop_core)",
  );

  // ── Upgrade modal: entitlement-gated action, simulated decision ──────
  // The cloud profile's default entitlements don't happen to deny
  // anything the walk's own path exercises, so this simulates the
  // UpgradeRequired decision FULCUpgradeModal.open() is actually called
  // with in production (core/window-manager.js's own entitlement gate,
  // see its FULCEntitlements.decision() check) -- same open() the real
  // gate calls, same DOM it builds.
  await page.evaluate(() => {
    (window as unknown as { FULCUpgradeModal: { open: (arg: unknown) => void } }).FULCUpgradeModal.open({
      capability: "app.tt-walk-probe",
      decision: { type: "UpgradeRequired", required_plan: "pro", prompt: null },
    });
  });
  await expect(page.locator("#fulc-upgrade-modal")).not.toHaveClass(/hidden/);
  await page.evaluate(() => {
    (window as unknown as { FULCUpgradeModal: { close: () => void } }).FULCUpgradeModal.close();
  });
  setReached(
    "core/upgrade-modal.js",
    "called window.FULCUpgradeModal.open() with a simulated UpgradeRequired decision -- the same entry point the real entitlement gate calls",
  );

  // ── Channel switcher: no shipped caller in the cloud profile (only ───
  // the withheld Updates/App Store/Cloud Manage surfaces call render()).
  // Drives it directly against a throwaway host element.
  await page.evaluate(() => {
    const host = document.createElement("div");
    host.id = "tt-walk-channel-switcher-host";
    document.body.appendChild(host);
    (
      window as unknown as {
        FULCChannelSwitcher: { render: (host: HTMLElement, opts: Record<string, unknown>) => void };
      }
    ).FULCChannelSwitcher.render(host, { surface: "tt-walk-probe", current: "stable" });
  });
  await expect(page.locator("#tt-walk-channel-switcher-host.fulc-channel-switcher")).toBeVisible({ timeout: 10_000 });
  await page.evaluate(() => {
    document.getElementById("tt-walk-channel-switcher-host")?.remove();
  });
  setReached(
    "core/channel-switcher.js",
    "called window.FULCChannelSwitcher.render() directly -- no shipped app in the cloud profile calls it (Updates/App Store/Cloud Manage are withheld)",
  );

  // ── SDK settings-panel container clear: no marketplace app installed ──
  // in this walk to trigger it through FULC.register(), so this calls
  // config.renderSettingsPanel() directly with an inline schema (passing
  // a schema skips the appId/manifest lookup entirely, so no app context
  // is needed to exercise the container.replaceChildren() clear at the
  // top of the function).
  await page.evaluate(async () => {
    const host = document.createElement("div");
    host.id = "tt-walk-sdk-config-host";
    document.body.appendChild(host);
    // config.getAll() (called internally, after the container clear this
    // site exercises) requires a resolved app id -- confirmed live: with
    // none set, renderSettingsPanel throws past the sink line. No
    // marketplace app is registered in this walk, so this sets the same
    // global a real marketplace launcher would (see fulc-sdk.umd.js's own
    // getAppIdOrNull) rather than widening the SDK's own requirement.
    (window as unknown as { __FULC_BASEAPP_ID__: string }).__FULC_BASEAPP_ID__ = "com.example.tt-walk-probe";
    await (
      window as unknown as {
        FULC: { config: { renderSettingsPanel: (host: HTMLElement, schema: Record<string, unknown>) => Promise<void> } };
      }
    ).FULC.config.renderSettingsPanel(host, { exampleField: { type: "string", label: "Example", default: "x" } });
  });
  await expect(page.locator("#tt-walk-sdk-config-host.fulc-config-panel")).toBeVisible({ timeout: 10_000 });
  await page.evaluate(() => {
    document.getElementById("tt-walk-sdk-config-host")?.remove();
  });
  setReached(
    "sdk/fulc-sdk.umd.js",
    "called FULC.config.renderSettingsPanel() directly with an inline schema -- no marketplace app is registered in this walk",
  );

  // ── System tray: gated by /api/mode returning "cloud", not "local" ───
  // (system-tray.js's own init() returns before creating any DOM when
  // mode !== 'local'). FULCSystemTray DOES expose init/refreshStatus
  // (Object.assign at the bottom of the file), with no "already
  // initialized" guard, so calling the exposed init() again here -- after
  // routing /api/mode to 'local' -- runs the real code for real. #153's
  // security review drove exactly this live.
  //
  // The "click Apply on a theme that is not current" step above can land
  // on a preset that sets body[data-taskbar-style="slim-icons"] or
  // body[data-taskbar-position="left"/"right"], either of which hides
  // #taskbar-tray entirely via core/taskbar.css -- independent of Trusted
  // Types, confirmed live with a diagnostic dump of the matched CSS
  // rules. Reset both so this probe isn't at the mercy of which theme
  // card happened to be first.
  await page.evaluate(() => {
    document.body.removeAttribute("data-taskbar-style");
    document.body.removeAttribute("data-taskbar-position");
  });
  await page.route("**/api/mode", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        mode: "local",
        features: { presence: false, liveEntitlements: false, messages: false, updates: false },
      }),
    }),
  );
  await page.route("**/api/system/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        wifi: { hasDevice: true, connected: true, ssid: "tt-walk-wifi" },
        volume: 50,
        muted: false,
        battery: { capacity: 80, charging: false },
      }),
    }),
  );
  // Hostile ssid/security -- system-tray.js's showWifiPopup renders both
  // through .textContent only (WS-C5); if that ever regressed to a sink,
  // this fixture would execute.
  await page.route("**/api/system/wifi/list", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          ssid: '"><img src=x onerror=window.__ttWalkPwn=1>',
          security: "<svg onload=window.__ttWalkPwn=1>",
          signal: 80,
          active: false,
        },
      ]),
    }),
  );
  await page.evaluate(async () => {
    const mod = await import("/core/system-tray.js");
    mod.FULCSystemTray.init();
  });
  await expect(page.locator("#system-tray-indicators")).toBeAttached({ timeout: 10_000 });
  const wifiBtn = page.locator("#system-tray-indicators .st-wifi");
  await expect(wifiBtn).toBeVisible({ timeout: 10_000 });
  await wifiBtn.click();
  const wifiItem = page.locator(".st-wifi-item").first();
  await expect(wifiItem).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".st-wifi-name").first()).toHaveText('"><img src=x onerror=window.__ttWalkPwn=1>');
  await expect(page.locator(".st-wifi-security").first()).toHaveText("<svg onload=window.__ttWalkPwn=1>");
  expect(
    await page.evaluate(() => (window as unknown as { __ttWalkPwn?: number }).__ttWalkPwn),
    "hostile ssid/security must render as literal text, never execute",
  ).toBeUndefined();
  await page.keyboard.press("Escape");
  await expect(page.locator(".st-popup")).toHaveCount(0);
  await page.unroute("**/api/system/wifi/list");
  await page.unroute("**/api/system/status");
  setReached(
    "core/system-tray.js",
    "routed /api/mode to 'local' and called the exposed FULCSystemTray.init() directly, then opened the Wi-Fi popup with a hostile ssid/security fixture (page.route) -- rendered as literal text, no injected element, payload never ran",
  );

  // ── Presence: features.presence is false by default in this cloud ────
  // profile, and FULCPresence's own init() has a one-shot "already
  // initialized" guard set by its real auto-init at DOMContentLoaded --
  // calling the exposed init() again (the way system-tray.js above is
  // driven) is a no-op here. Reaching it for real means routing
  // /api/mode + a hostile WebSocket snapshot BEFORE the next boot, then
  // reloading so the guard is fresh. FULCPresence IS exposed
  // (window.FULCPresence, plus the ESM export).
  await page.route("**/api/mode", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        mode: "cloud",
        features: { presence: true, liveEntitlements: false, messages: false, updates: false },
      }),
    }),
  );
  await page.routeWebSocket(/\/api\/ws\/presence/, (ws) => {
    ws.onMessage(() => {
      // Client heartbeat/cursor messages -- ignored; this fixture only
      // ever pushes the one hostile snapshot below.
    });
    ws.send(
      JSON.stringify({
        JsonPatch: [
          {
            op: "replace",
            path: "/peers",
            value: [
              {
                email: "tt-walk-hostile@example.test",
                display_name: "<img src=x onerror=window.__ttWalkPwn=1>",
                status: "online",
                // CSSOM (style.background =) rejects a value carrying
                // extra declarations/URLs outright -- WS-C5's review
                // confirmed this live for the same fixture shape.
                color: "red;background-image:url(javascript:window.__ttWalkPwn=1)",
              },
            ],
          },
        ],
      }),
    );
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (window as unknown as { currentStep?: string }).currentStep === "DESKTOP", {
    timeout: 15_000,
  });
  // The persisted layout setting (theme-layout.js's own storage-ns entry)
  // survives the reload and re-applies itself -- same
  // data-taskbar-style/-position reset as the system-tray section above,
  // needed again here because #presence-avatars is inserted inside
  // #taskbar-tray (see presence.js's own comment), which the same CSS
  // rule can hide.
  await page.evaluate(() => {
    document.body.removeAttribute("data-taskbar-style");
    document.body.removeAttribute("data-taskbar-position");
  });
  const avatar = page.locator("#presence-avatars .presence-avatar").first();
  await expect(avatar).toBeVisible({ timeout: 10_000 });
  expect(
    await page.evaluate(() => (window as unknown as { __ttWalkPwn?: number }).__ttWalkPwn),
    "hostile display_name/color must never execute",
  ).toBeUndefined();
  expect(
    await avatar.evaluate((el) => el.querySelector("img") !== null),
    "hostile display_name must render as text (initials), never create an <img>",
  ).toBe(false);
  const presenceBg = await avatar.evaluate((el) => (el as HTMLElement).style.background);
  expect(presenceBg, "CSSOM must reject the javascript: URL component of the hostile color").not.toContain(
    "javascript:",
  );
  await page.unroute("**/api/mode");
  setReached(
    "core/presence.js",
    "routed /api/mode to features.presence:true plus a hostile page.routeWebSocket /api/ws/presence snapshot, then reloaded so the real auto-init (gated by a one-shot 'initialized' flag; a second direct init() call is a no-op) picked it up fresh -- hostile display_name/color rendered safely, no injected element, payload never ran",
  );

  // ── Positive control ──────────────────────────────────────────────────
  // Under Report-Only this assignment succeeds and only reports; once
  // enforced (WS-C4), the same assignment also throws synchronously (caught
  // here, so this walk works unmodified in both regimes) AND Chromium logs
  // it as a console error in addition to firing the securitypolicyviolation
  // event this control checks for -- confirmed live. consoleErrorsBeforeControl
  // isolates that expected, self-inflicted error the same way beforeControl
  // isolates the control's own securitypolicyviolation event, so the
  // walk's own "zero console errors" assertion below still means "zero
  // outside this control", not "zero, including our own control".
  const beforeControl = cspViolations.length;
  const consoleErrorsBeforeControl = consoleErrors.length;
  await page.evaluate(() => {
    const el = document.createElement("div");
    try {
      el.innerHTML = "<b>tt-walk-positive-control</b>";
    } catch {
      // expected under enforcement -- see comment above.
    }
  });
  await page.waitForTimeout(500);
  expect(
    cspViolations.length,
    "positive control: assigning a string to .innerHTML must fire at least one securitypolicyviolation -- otherwise the zero count above is vacuous",
  ).toBeGreaterThan(beforeControl);

  return { cspViolations, consoleErrors, failedRequests, beforeControl, consoleErrorsBeforeControl };
}

// Criterion 7 (server-side delivery, moved here from its own separate
// `test()` -- see this file's header comment for why): called from inside
// the main test's `try`, while the page/browser are still open. Does not
// gate the walk's own pass/fail -- criterion 6's DOM count is the
// authority (C18c) -- except for the one stop-and-report case (reached
// and rejected).
async function checkServerSideDelivery(): Promise<void> {
  if (!SERVER_LOG_PATH) {
    console.log("criterion 7: MILESTONE_SERVER_LOG not set -- this sub-check is skipped, not failed (C18c)");
    return;
  }

  const deadline = Date.now() + 90_000;
  let found: string | null = null;
  let rejected: string | null = null;
  while (Date.now() < deadline) {
    let text = "";
    try {
      text = readFileSync(SERVER_LOG_PATH, "utf8");
    } catch {
      // log not written yet
    }
    const reportLine = text.split("\n").find((l) => l.includes('"event":"csp_report"') && l.includes("require-trusted-types-for"));
    if (reportLine) {
      found = reportLine;
      break;
    }
    const rejectLine = text
      .split("\n")
      .find((l) => /POST \/api\/csp-report.*\b(403|413|415)\b/.test(l) || /\b(403|413|415)\b.*POST \/api\/csp-report/.test(l));
    if (rejectLine) {
      rejected = rejectLine;
      break;
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }

  if (rejected) {
    // C18 criterion 7: reached-and-rejected is a stop-and-report case,
    // not a silently recorded limitation -- fail loudly with the evidence.
    throw new Error(`criterion 7: /api/csp-report reached and rejected -- STOP AND REPORT: ${rejected}`);
  }

  if (found) {
    console.log(`criterion 7: server-side delivery confirmed -- ${found}`);
  } else {
    console.log(
      "criterion 7: no csp_report line observed within 90s -- recorded as a Chromium delivery limitation per C18c; " +
        "criterion 6's DOM securitypolicyviolation count remains authoritative and is unaffected.",
    );
  }
}

test.describe("D#37 Correction C18 / WS-C5 criterion 6: Report-Only walk, 0 violations", () => {
  test.skip(!BASE_URL, "MILESTONE_BASE_URL not set -- opt-in only, see this file's header comment");

  test("signs in, drives every C18a surface the cloud profile can reach, and records zero non-control violations", async () => {
    // Interactive walk (~20-30s) plus criterion 7's own up-to-90s poll,
    // run sequentially below while the page stays open -- playwright.config.ts's
    // default per-test timeout (90_000) covers neither the poll alone nor
    // both together, so this test needs its own larger budget.
    test.setTimeout(210_000);

    const base = BASE_URL!;
    const fakeAuthorize = await startFakeGithubAuthorize({ port: FAKE_AUTHORIZE_PORT, callbackBase: base });

    // D#37 WS-L1 (correction C19c criterion 8): same reasoning as
    // milestone-local.spec.ts -- this walk's fixture account must be
    // subscribed BEFORE sign-in, or it lands on the subscription-gate
    // screen instead of the desktop every site in SITES below assumes.
    await seedAccountStatus({ githubUserId: FAKE_IDENTITY.githubUserId, status: "active" });

    const browser = await chromium.launch();
    let result: {
      cspViolations: string[];
      consoleErrors: string[];
      failedRequests: string[];
      beforeControl: number;
      consoleErrorsBeforeControl: number;
    };
    try {
      result = await runWalk(browser);
      // Criterion 7: while the page/browser are still open -- closing the
      // browser first would discard any in-flight csp-report request
      // before it could be sent.
      await checkServerSideDelivery();
    } finally {
      await browser.close();
      await fakeAuthorize.stop();
    }

    printSiteTable();

    // Every one of the 21 sites is accounted for -- either reached, or
    // explicitly marked not reachable with a reason. None left blank.
    for (const row of SITES) {
      expect(row.how, `${row.file} was never classified reached/unreachable -- walk/table drifted apart`).not.toBe("");
    }

    // Criterion 8 (scope stop rule): every violation must be the positive
    // control's own -- nothing else in the walk (all 21 sites' worth of
    // real navigation) may fire one. A Trusted-Types securitypolicyviolation
    // event carries no payload info (blockedURI is always the literal
    // string "trusted-types-sink", never the actual value that was
    // assigned), so the control's own event can only be isolated by count
    // -- everything recorded before `beforeControl` was captured is the
    // walk's own, and must be empty.
    const nonControlViolations = result.cspViolations.slice(0, result.beforeControl);
    expect(
      nonControlViolations,
      `non-control CSP violations (criterion 8: any of these outside the 21-site table is a stop-and-report): ${JSON.stringify(nonControlViolations)}`,
    ).toEqual([]);

    // Same isolation as nonControlViolations above: once enforced, the
    // positive control's own caught TypeError is ALSO logged as a console
    // error by Chromium (confirmed live) -- expected and self-inflicted,
    // not a walk failure. Everything before consoleErrorsBeforeControl was
    // captured is the walk's own, and must be empty.
    const nonControlConsoleErrors = result.consoleErrors.slice(0, result.consoleErrorsBeforeControl);
    expect(
      nonControlConsoleErrors,
      `non-control console errors: ${JSON.stringify(nonControlConsoleErrors)}`,
    ).toEqual([]);
    expect(result.failedRequests, `failed/error requests: ${JSON.stringify(result.failedRequests)}`).toEqual([]);

    console.log(`tt-walk.spec.ts: total securitypolicyviolation events (incl. positive control): ${result.cspViolations.length}`);
  });
});

// D#37 Correction C17b / WS-C4 criterion 4. Opt-in on its own flag,
// MILESTONE_TT_ENFORCED=1, in addition to MILESTONE_BASE_URL: these
// assertions only hold once require-trusted-types-for 'script' is in the
// ENFORCED Content-Security-Policy (WS-C4 step 2). Running this against
// the Report-Only parent build (where nothing is blocked, only reported)
// would fail every case, which is why it is gated separately from the
// walk above rather than folded into it.
test.describe("D#37 Correction C17b / WS-C4 criterion 4: enforced Trusted Types blocks every regex evasion at runtime", () => {
  test.skip(!BASE_URL, "MILESTONE_BASE_URL not set -- opt-in only, see this file's header comment");
  test.skip(
    process.env.MILESTONE_TT_ENFORCED !== "1",
    "MILESTONE_TT_ENFORCED not set to '1' -- run this against the ENFORCED build (WS-C4 step 2), not the Report-Only parent",
  );

  test("each C17b evasion form is blocked at runtime, not just missed by the regex", async () => {
    const base = BASE_URL!;
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await context.newPage();

      const cspViolations: string[] = [];
      await page.exposeFunction("__ttEvasionCspReport", (detail: string) => {
        cspViolations.push(detail);
      });
      await page.addInitScript(() => {
        document.addEventListener("securitypolicyviolation", (e) => {
          (window as unknown as { __ttEvasionCspReport: (s: string) => void }).__ttEvasionCspReport(
            `${e.violatedDirective}: ${e.blockedURI} (${e.disposition})`,
          );
        });
      });

      // No sign-in needed: the enforced CSP is on every response
      // SHELL_SECURITY_HEADERS matches (`/`, `/s/:path*`, `/api/:path*`),
      // including the signed-out login screen this navigates to.
      const initialResponse = await page.goto(base + "/", { waitUntil: "domcontentloaded" });
      await expect(page.locator("#cloud-login-screen")).toBeVisible({ timeout: 15_000 });
      // Reused verbatim for the probe pages below rather than a second
      // hand-copied literal of WORKSPACE_CSP -- if the real header ever
      // changes, this stays correct with no second place to edit, and the
      // probe is provably running under the EXACT policy `/` just served,
      // not a maintainer's guess at it.
      const enforcedCsp = initialResponse?.headers()["content-security-policy"] ?? "";
      expect(enforcedCsp, "could not read the real Content-Security-Policy header off '/' -- probe pages below would run unenforced").toContain(
        "require-trusted-types-for",
      );

      type EvasionResult = { threw: boolean; message: string | null; sideEffect: boolean };

      // D#37 discussioncomment 18606024: the two eval-class cases below
      // (indirect eval, Reflect.construct(Function, ...)) must NOT run
      // inside page.evaluate() -- that is CDP Runtime.evaluate, which
      // Chromium permits to call eval/Function regardless of the page's
      // CSP script-src, so both looked "unblocked" there for reasons that
      // have nothing to do with the shipped policy.
      //
      // The obvious fix -- page.addScriptTag({ url }) -- turns out not to
      // work either, and not for a harness reason this time: Playwright's
      // own addScriptTag implementation injects the tag by setting
      // `script.src` as a DOM property from within the page, which is
      // itself exactly the TrustedScriptURL sink `trusted-types 'none'`
      // forbids (confirmed live: it throws "Failed to set the 'src'
      // property on 'HTMLScriptElement': This document requires
      // 'TrustedScriptURL' assignment" -- the same enforcement
      // setAttribute('src', ...) below is deliberately testing). With
      // `trusted-types 'none'`, no policy can ever be created to satisfy
      // that sink, so no DYNAMIC script-tag insertion API can load a
      // script at all, from any context -- that is the control working
      // correctly, not a second harness bug.
      //
      // What Trusted Types does NOT cover is the browser's HTML parser
      // building a document from bytes the server sent: a <script src>
      // element that is part of the ORIGINAL markup runs as ordinary
      // page-origin script, no sink involved, same as any shipped script
      // tag. So each probe is served as a full same-origin HTML document
      // (via page.route) whose only content is a static <script src>
      // pointing at a same-origin probe .js (also page.route-served, also
      // carrying the exact enforced CSP captured above) -- page.goto()
      // there, then page.evaluate() only to read the result back off
      // `window.__ttEvasionResult`, same as the rest of this file.
      const evasionProbeScripts: Record<string, string> = {
        "/__tt-evasion-probe/indirect-eval.js": `
          (() => {
            const w = window;
            delete w.__ttPwn;
            let threw = false;
            let message = null;
            try {
              (0, eval)("window.__ttPwn = true;");
            } catch (e) {
              threw = true;
              message = String(e);
            }
            w.__ttEvasionResult = { threw, message, sideEffect: w.__ttPwn === true };
          })();
        `,
        "/__tt-evasion-probe/reflect-construct-function.js": `
          (() => {
            const w = window;
            delete w.__ttPwn;
            let threw = false;
            let message = null;
            try {
              const f = Reflect.construct(Function, ["window.__ttPwn = true;"]);
              f();
            } catch (e) {
              threw = true;
              message = String(e);
            }
            w.__ttEvasionResult = { threw, message, sideEffect: w.__ttPwn === true };
          })();
        `,
      };
      const evasionProbePages: Record<string, string> = {
        "/__tt-evasion-probe/indirect-eval.html":
          '<!doctype html><meta charset="utf-8"><script src="/__tt-evasion-probe/indirect-eval.js"></script>',
        "/__tt-evasion-probe/reflect-construct-function.html":
          '<!doctype html><meta charset="utf-8"><script src="/__tt-evasion-probe/reflect-construct-function.js"></script>',
      };
      await page.route("**/__tt-evasion-probe/*", (route) => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname.endsWith(".js")) {
          const body = evasionProbeScripts[pathname];
          if (body === undefined) {
            return route.fulfill({ status: 404, contentType: "text/plain", body: "not found" });
          }
          return route.fulfill({
            status: 200,
            contentType: "application/javascript",
            headers: { "content-security-policy": enforcedCsp },
            body,
          });
        }
        const html = evasionProbePages[pathname];
        if (html === undefined) {
          return route.fulfill({ status: 404, contentType: "text/plain", body: "not found" });
        }
        return route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          headers: { "content-security-policy": enforcedCsp },
          body: html,
        });
      });
      // Navigates to a probe HTML page (parser-inserted <script src>, so
      // no Trusted Types sink is ever called), reads the result off
      // `window.__ttEvasionResult` the probe script set, then navigates
      // back to the base page so every later case (setAttribute('src'))
      // still runs against the original document, unaffected by this
      // detour -- matching this test's behavior before this fix.
      const runEvasionProbe = async (path: string): Promise<EvasionResult> => {
        await page.goto(base + path, { waitUntil: "load" });
        const result = await page.evaluate(
          () => (window as unknown as { __ttEvasionResult?: EvasionResult }).__ttEvasionResult!,
        );
        await page.goto(base + "/", { waitUntil: "domcontentloaded" });
        return result;
      };

      const cases: Array<{ name: string; run: () => Promise<EvasionResult> }> = [
        {
          // The original, regex-caught case -- a control for the other four.
          name: "el.innerHTML = str",
          run: () =>
            page.evaluate(() => {
              const el = document.createElement("div");
              let threw = false;
              let message: string | null = null;
              try {
                el.innerHTML = "<b>tt-evasion-1</b>";
              } catch (e) {
                threw = true;
                message = String(e);
              }
              return { threw, message, sideEffect: el.innerHTML !== "" };
            }),
        },
        {
          // Concatenated computed key -- evades TRUSTED_TYPES_SINK_RE's
          // quote-matched computed-member form.
          name: "el['inner' + 'HTML'] = str",
          run: () =>
            page.evaluate(() => {
              const el = document.createElement("div");
              let threw = false;
              let message: string | null = null;
              try {
                (el as unknown as Record<string, string>)["inner" + "HTML"] = "<b>tt-evasion-2</b>";
              } catch (e) {
                threw = true;
                message = String(e);
              }
              return { threw, message, sideEffect: el.innerHTML !== "" };
            }),
        },
        {
          // Indirect eval -- evades the regex's \beval\s*\( form (no
          // identifier named "eval" appears at the call site). Run from a
          // page-origin script (D#37 discussioncomment 18606024), not
          // page.evaluate: CDP Runtime.evaluate permits eval/Function
          // regardless of the page's CSP, which is a harness artifact,
          // not a property of the shipped policy.
          name: "(0, eval)(str)",
          run: () => runEvasionProbe("/__tt-evasion-probe/indirect-eval.html"),
        },
        {
          // Function constructor via Reflect -- evades \bFunction\s*\(.
          // Same page-origin-script requirement as the indirect-eval case
          // above, and for the same reason.
          name: "Reflect.construct(Function, [str])",
          run: () => runEvasionProbe("/__tt-evasion-probe/reflect-construct-function.html"),
        },
        {
          // C17a's new regex form, exercised as a live evasion target too:
          // setAttribute('src', ...) on a created <script> element.
          // Deliberately never appended to the DOM -- the point is whether
          // *setting the attribute* is blocked, not whether a network
          // fetch would separately be prevented.
          name: "script.setAttribute('src', str)",
          run: () =>
            page.evaluate(() => {
              const w = window as unknown as { __ttPwn?: boolean };
              delete w.__ttPwn;
              const script = document.createElement("script");
              let threw = false;
              let message: string | null = null;
              try {
                script.setAttribute("src", "data:text/javascript,window.__ttPwn=true;");
              } catch (e) {
                threw = true;
                message = String(e);
              }
              return { threw, message, sideEffect: w.__ttPwn === true };
            }),
        },
      ];

      for (const { name, run } of cases) {
        const before = cspViolations.length;
        const r = await run();
        await page.waitForTimeout(300); // let any async securitypolicyviolation event land
        const violated = cspViolations.length > before;

        expect(
          r.sideEffect,
          `${name}: the payload's side effect happened -- Trusted Types did NOT block this, STOP AND REPORT (result: ${JSON.stringify(r)})`,
        ).toBe(false);
        expect(
          r.threw || violated,
          `${name}: neither a thrown error nor a securitypolicyviolation was observed -- STOP AND REPORT (result: ${JSON.stringify(r)})`,
        ).toBe(true);

        console.log(`tt-walk.spec.ts evasion check -- ${name}: ${JSON.stringify(r)}, violation observed: ${violated}`);
      }
    } finally {
      await browser.close();
    }
  });
});
