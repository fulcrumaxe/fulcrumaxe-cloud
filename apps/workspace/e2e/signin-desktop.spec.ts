// apps/workspace/e2e/signin-desktop.spec.ts
//
// D#37 WS-C2. Covers, against the built dist/ served by
// e2e/fixture-server.mjs:
//   - criterion 9: the sign-in screen is GitHub-only (no email/password
//     input, one control navigating to /api/auth/github).
//   - criterion 11: every localStorage key the fork writes after
//     sign-in is fx:<storage_ns>:<name>.
//   - criterion 12: sign-out from the dock/user menu and the command
//     palette, including the second-account case.
//
// Sequencing follows idle-network.spec.ts's established pattern:
// page.clock virtualizes the boot-log animation's setTimeout cascade;
// real fetch()/JSON I/O against the local fixture server resolves in
// real time, unaffected by the fake clock.

import { test, expect, type Page } from "@playwright/test";
import { bootToDesktop, stepToDesktop } from "./helpers/boot";

const BOOT_FAST_FORWARD_MS = 15_000;

async function bootToSignIn(page: Page) {
  await page.route("**/api/cloud/auth/me", (route) => route.fulfill({ status: 401, contentType: "application/json", body: "" }));
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.goto("/");
  await page.clock.runFor(BOOT_FAST_FORWARD_MS);
  await expect(page.locator("#cloud-login-screen")).toBeVisible();
}

test.describe("cloud profile: sign-in screen (D#37 WS-C2 criterion 9)", () => {
  test("exactly one GitHub sign-in control, no password/email input", async ({ page }) => {
    await bootToSignIn(page);

    const links = page.locator("#cloud-login-screen a");
    await expect(links).toHaveCount(1);
    const link = links.first();
    await expect(link).toHaveText("Sign in with GitHub");
    await expect(link).toHaveAttribute("href", "/api/auth/github");

    await expect(page.locator("input")).toHaveCount(0);
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await expect(page.locator('input[type="email"]')).toHaveCount(0);
  });
});

test.describe("cloud profile: signed-in desktop", () => {
  test("empty desktop with Themes in the dock", async ({ page }) => {
    await bootToDesktop(page);
    await expect(page.locator("#desktop-screen")).not.toHaveClass(/hidden/);
    await expect(page.locator('.dock-icon[data-app-id="themes"]')).toBeVisible();
    // No window is open yet -- an "empty" desktop.
    await expect(page.locator("#windows-container [data-app-id]")).toHaveCount(0);
  });
});

test.describe("cloud profile: storage namespacing (D#37 WS-C2 criterion 11)", () => {
  test("every localStorage key is fx:<storage_ns>:<name>, none carry the window title", async ({ page }) => {
    await bootToDesktop(page);

    await page.locator('.dock-icon[data-app-id="themes"]').click();
    const win = page.locator('.fulc-window[data-app-id="themes"]');
    await expect(win).toBeVisible();

    // Move the window (drag its titlebar) -- window-manager.js debounces
    // the persisted-layout write 500ms after the last drag delta.
    const titlebar = win.locator(".window-titlebar");
    const box = await titlebar.boundingBox();
    if (!box) throw new Error("titlebar has no bounding box");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 80, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(700);

    const titleText = (await win.locator(".window-title").textContent())?.trim() ?? "";
    expect(titleText.length).toBeGreaterThan(0);

    const { keys, values } = await page.evaluate(() => {
      const k: string[] = [];
      const v: string[] = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i)!;
        k.push(key);
        v.push(window.localStorage.getItem(key) ?? "");
      }
      return { keys: k, values: v };
    });

    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(k, `key "${k}" is not namespaced fx:ns-idle-e2e:`).toMatch(/^fx:ns-idle-e2e:/);
    }
    for (const v of values) {
      expect(v.includes(titleText), `a stored value contains the window title "${titleText}"`).toBe(false);
    }
  });

  /**
   * D#37 WS-C2 fix round item 3 (W2, CWE-359, correction C15c): the
   * four remaining un-namespaced writers this fix round moves onto
   * storage-ns.js, exercised through the real listeners/DOM each one
   * actually wires up (the SDK-state write is exercised through
   * window.FULC, the same global a real marketplace app would use).
   *
   * Two of the four have no reachable UI in THIS cloud profile build
   * (profiles/cloud.json's app_modules is only ["themes", "activation"]
   * -- keybindings.js belongs to the editor app, which
   * profiles/cloud.json's drop_core excludes entirely, and
   * command-registry.js's alias persistence has no alias-creating
   * command anywhere in the shell to begin with, cloud profile or not).
   * Both still ship real DOM elements/listeners (`#keybindings-overlay`
   * is unconditional in index.html; window.FULCCommands is this
   * module's own exposed API, mirroring window.FULCWM's precedent) --
   * this test reaches them directly rather than through a launcher that
   * doesn't exist in this build, and still exercises the real write
   * path (saveBindings()/saveAliases()), not a synthetic stand-in.
   */
  test("every fix-round writer (SDK state, keybindings, screen-saver, aliases) persists under fx:ns-idle-e2e:", async ({
    page,
  }) => {
    await bootToDesktop(page);

    // 1. SDK state -- window.FULC is globally exposed by the UMD bundle
    // (index.html: "so window.FULC exists synchronously for marketplace
    // apps"). Becomes fx:<ns>:app:<id>:<name>.
    await page.evaluate(() => {
      const fulc = (
        window as unknown as {
          FULC: { register: (o: { id: string; title: string }) => void; state: { set: (k: string, v: unknown) => void } };
        }
      ).FULC;
      fulc.register({ id: "e2e-probe-app", title: "E2E Probe" });
      fulc.state.set("probe", { ok: true });
    });

    // 2. keybindings.js's "RESET ALL" button -- real listener, real
    // saveBindings() write -- reached by revealing the (always-present)
    // overlay directly, since nothing in this profile's UI opens it.
    await page.evaluate(() => document.getElementById("keybindings-overlay")?.classList.remove("hidden"));
    await page.locator("#keybindings-reset-all").click();
    // Re-hide it -- it was only revealed to reach the real button, and
    // an overlay left open would intercept every click below.
    await page.evaluate(() => document.getElementById("keybindings-overlay")?.classList.add("hidden"));

    // 3. screen-saver.js, via the real "Hot Corners..." desktop
    // context-menu entry (core/desktop.js) and its real idle-timeout
    // <select>, unrelated to any specific app_module.
    await page.locator("#desktop-surface").click({ button: "right", position: { x: 400, y: 400 } });
    await page.locator(".fulc-ctx-item", { hasText: "Hot Corners..." }).click();
    await page.locator(".hc-ss-select").selectOption("10");

    // 4. command-registry.js's aliases -- window.FULCCommands is this
    // module's own exposed API (no alias-creating command exists to
    // click through instead).
    await page.evaluate(() => {
      const cmds = (window as unknown as { FULCCommands: { aliases: Record<string, string>; saveAliases: () => void } }).FULCCommands;
      cmds.aliases.ll = "ls -la";
      cmds.saveAliases();
    });

    const keys = await page.evaluate(() => {
      const k: string[] = [];
      for (let i = 0; i < window.localStorage.length; i++) k.push(window.localStorage.key(i)!);
      return k;
    });

    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(k, `key "${k}" is not namespaced fx:ns-idle-e2e:`).toMatch(/^fx:ns-idle-e2e:/);
    }
    // Confirms each writer actually landed a key, not just that
    // whatever DID land happens to be namespaced.
    expect(keys.some((k) => k.startsWith("fx:ns-idle-e2e:app:e2e-probe-app:"))).toBe(true);
    expect(keys.some((k) => k.includes(":fulc_keybindings"))).toBe(true);
    expect(keys.some((k) => k.includes(":hot-corners") || k.includes("fulc-screensaver-timeout"))).toBe(true);
    expect(keys.some((k) => k.includes(":fulc_aliases"))).toBe(true);
  });
});

test.describe("cloud profile: sign-out (D#37 WS-C2 criterion 12)", () => {
  test("from the dock/user menu: local state wiped, sign-in screen shown", async ({ page }) => {
    await bootToDesktop(page);

    await page.evaluate(() => window.sessionStorage.setItem("probe", "1"));

    // D#37 WS-C2 fix round item 1 (correction C15a): this route stub is
    // deliberately scoped to what it actually tests -- the FORK'S OWN
    // client-side reaction to sign-out: it POSTs a real (unstubbed)
    // request to this fixture server's /api/auth/signout (proved below
    // by signoutCalls), then wipes local state and reloads, at which
    // point THIS stub governs what the reloaded boot sequence sees when
    // it re-checks /api/cloud/auth/me. It does NOT, and was previously
    // miscommented as if it did, prove that a real backend actually
    // revoked the session server-side -- this fixture server has no
    // session to revoke at all (see fixture-server.mjs's own signout
    // handler comment). That proof lives against the real handlers: the
    // replay test in apps/web/test/shell-routes.test.ts (fake Postgres)
    // and packages/core/test/pg/identity.test.ts (real Postgres), plus
    // milestone-local.spec.ts's real end-to-end run (criterion 15).
    await page.route("**/api/cloud/auth/me", (route) => route.fulfill({ status: 401, contentType: "application/json", body: "" }));

    let signoutCalls = 0;
    page.on("request", (req) => {
      if (req.url().includes("/api/auth/signout") && req.method() === "POST") signoutCalls++;
    });

    await page.locator("#taskbar-user").click();
    await expect(page.locator("#taskbar-user-menu")).toBeVisible();
    // The "load" listener is registered in the SAME statement as the
    // click that triggers signOut()'s reload -- registering it only
    // after the click resolves risks missing a "load" event that
    // already fired before this script gets to await it.
    await Promise.all([page.waitForEvent("load"), page.locator("#taskbar-signout").click()]);

    await page.clock.install({ time: new Date("2026-01-01T00:00:01Z") });
    await page.clock.runFor(BOOT_FAST_FORWARD_MS);
    await expect(page.locator("#cloud-login-screen")).toBeVisible();

    expect(signoutCalls).toBeGreaterThan(0);
    // D#37 WS-D criterion 1: "fx-boot-shown" is a plain (unnamespaced)
    // sessionStorage flag core/boot.js writes on every boot so the boot
    // animation is skipped on a repeat load in the same tab -- it carries
    // no tenant data, no PII, and nothing account-specific (unlike every
    // OTHER key this test is actually guarding against), so a fresh boot
    // rewriting it moments after sign-out's own wipe doesn't reopen the
    // leak this test exists to catch. Excluded here, not from the wipe
    // logic itself (core/cloud-signout.js still deletes it like any other
    // unprefixed fulc*/fx: key before the reload that recreates it).
    const storageLengths = await page.evaluate(() => ({
      local: window.localStorage.length,
      session: Object.keys(window.sessionStorage).filter((k) => k !== "fx-boot-shown").length,
    }));
    expect(storageLengths.local).toBe(0);
    expect(storageLengths.session).toBe(0);
  });

  test("from the command palette (Ctrl+K)", async ({ page }) => {
    await bootToDesktop(page);

    // Same 401 stub the dock/user-menu test above installs before its own
    // sign-out click. Without it, this fixture server is stateless -- it
    // has no real session to revoke -- so the reloaded boot's own
    // /api/cloud/auth/me gets a 200 signed-in response again and lands
    // back on DESKTOP instead of the sign-in screen. That is the actual
    // source of this test's flake under full parallelism: once back on
    // DESKTOP, showDesktop()'s fetchPreferences() -> FULCTheme.apply()
    // calls storePreference('experience', ...), which is a genuine
    // localStorage write once a namespace is set (theme-manager.js) --
    // a real race against the assertion below, not fixed timing. This
    // stub removes the race at its source by making the post-reload state
    // deterministic (signed out, so no namespace is ever set and that
    // write never happens), the same way the sibling test already relies
    // on it.
    await page.route("**/api/cloud/auth/me", (route) => route.fulfill({ status: 401, contentType: "application/json", body: "" }));

    await page.keyboard.press("Control+k");
    await expect(page.locator("#command-palette")).toBeVisible();
    await page.locator("#command-palette-input").fill("signout");
    await expect(page.locator('.command-palette-item:has-text("signout")')).toBeVisible();
    await Promise.all([
      page.waitForEvent("load"),
      page.locator('.command-palette-item:has-text("signout")').click(),
    ]);

    // Deterministic wait on the condition this test actually asserts --
    // that the reloaded boot has settled on the sign-in screen -- rather
    // than reading storage the instant the "load" event fires. Same
    // clock-install + runFor + visibility wait the dock/user-menu test
    // above uses for the identical reload.
    await page.clock.install({ time: new Date("2026-01-01T00:00:01Z") });
    await page.clock.runFor(BOOT_FAST_FORWARD_MS);
    await expect(page.locator("#cloud-login-screen")).toBeVisible();

    // D#37 WS-D criterion 1: "fx-boot-shown" is a plain (unnamespaced)
    // sessionStorage flag core/boot.js writes on every boot so the boot
    // animation is skipped on a repeat load in the same tab -- it carries
    // no tenant data, no PII, and nothing account-specific (unlike every
    // OTHER key this test is actually guarding against), so a fresh boot
    // rewriting it moments after sign-out's own wipe doesn't reopen the
    // leak this test exists to catch. Excluded here, not from the wipe
    // logic itself (core/cloud-signout.js still deletes it like any other
    // unprefixed fulc*/fx: key before the reload that recreates it).
    const storageLengths = await page.evaluate(() => ({
      local: window.localStorage.length,
      session: Object.keys(window.sessionStorage).filter((k) => k !== "fx-boot-shown").length,
    }));
    expect(storageLengths.local).toBe(0);
    expect(storageLengths.session).toBe(0);
  });

  test("second account: B's desktop carries none of A's layout", async ({ page }) => {
    await bootToDesktop(page); // signs in as the default fixture user ("A", ns-idle-e2e)

    await page.locator('.dock-icon[data-app-id="themes"]').click();
    await expect(page.locator('.fulc-window[data-app-id="themes"]')).toBeVisible();
    await page.waitForTimeout(700); // let window-manager.js's debounced save land

    const aKeys = await page.evaluate(() => Object.keys(window.localStorage));
    expect(aKeys.some((k) => k.startsWith("fx:ns-idle-e2e:"))).toBe(true);

    // Sign in as B (a different username and storage_ns) -- registered
    // BEFORE sign-out is triggered, so it already governs the reload's
    // own re-fetch of /api/cloud/auth/me.
    await page.route("**/api/cloud/auth/me", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        // D#37 WS-L1: boot.js now gates the desktop on workspace_access --
        // see fixture-server.mjs's own identical fix for why this field is
        // required for `currentStep` to ever reach "DESKTOP".
        body: JSON.stringify({
          username: "user-b",
          email: "b@example.test",
          is_admin: false,
          storage_ns: "ns-user-b",
          workspace_access: "open",
        }),
      }),
    );

    await page.locator("#taskbar-user").click();
    await Promise.all([page.waitForEvent("load"), page.locator("#taskbar-signout").click()]);

    await page.clock.install({ time: new Date("2026-01-01T00:00:02Z") });
    await stepToDesktop(page);

    // No window is open for B (an empty desktop), and nothing left
    // over carries A's namespace.
    await expect(page.locator("#windows-container [data-app-id]")).toHaveCount(0);
    const bKeys = await page.evaluate(() => Object.keys(window.localStorage));
    expect(bKeys.some((k) => k.startsWith("fx:ns-idle-e2e:"))).toBe(false);
  });
});

test.describe("cloud profile: sign-out failure (D#37 WS-C2 fix round item 2, W1, CWE-754)", () => {
  test("a 500 from /api/auth/signout wipes no local state, does not reload, and shows an error", async ({ page }) => {
    await bootToDesktop(page);
    await page.evaluate(() => window.localStorage.setItem("fx:ns-idle-e2e:w1-probe", "1"));
    await page.evaluate(() => window.sessionStorage.setItem("w1-probe", "1"));

    await page.route("**/api/auth/signout", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: "{}" }),
    );

    let loadFired = false;
    page.once("load", () => {
      loadFired = true;
    });

    await page.locator("#taskbar-user").click();
    await expect(page.locator("#taskbar-user-menu")).toBeVisible();
    await page.locator("#taskbar-signout").click();

    await expect(page.locator(".fulc-toast__title")).toHaveText("Sign-out failed. Try again.");

    expect(loadFired).toBe(false);
    await expect(page.locator("#desktop-screen")).not.toHaveClass(/hidden/);
    const storage = await page.evaluate(() => ({
      local: window.localStorage.getItem("fx:ns-idle-e2e:w1-probe"),
      session: window.sessionStorage.getItem("w1-probe"),
    }));
    expect(storage.local).toBe("1");
    expect(storage.session).toBe("1");
  });

  test("a network error / aborted /api/auth/signout wipes no local state, does not reload, and shows an error", async ({
    page,
  }) => {
    await bootToDesktop(page);
    await page.evaluate(() => window.localStorage.setItem("fx:ns-idle-e2e:w1-probe", "1"));
    await page.evaluate(() => window.sessionStorage.setItem("w1-probe", "1"));

    // route.abort() fails the request at the network layer -- fetch()
    // rejects, the same shape as a real network error or a timed-out
    // request, which this handler's catch{} branch must handle
    // identically to a non-2xx response.
    await page.route("**/api/auth/signout", (route) => route.abort());

    let loadFired = false;
    page.once("load", () => {
      loadFired = true;
    });

    await page.locator("#taskbar-user").click();
    await expect(page.locator("#taskbar-user-menu")).toBeVisible();
    await page.locator("#taskbar-signout").click();

    await expect(page.locator(".fulc-toast__title")).toHaveText("Sign-out failed. Try again.");

    expect(loadFired).toBe(false);
    await expect(page.locator("#desktop-screen")).not.toHaveClass(/hidden/);
    const storage = await page.evaluate(() => ({
      local: window.localStorage.getItem("fx:ns-idle-e2e:w1-probe"),
      session: window.sessionStorage.getItem("w1-probe"),
    }));
    expect(storage.local).toBe("1");
    expect(storage.session).toBe("1");
  });
});
