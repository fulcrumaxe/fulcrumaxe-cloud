// shell pack. W1: the workspace shell boots for the signed-in owner and the parts a person reaches first work (dock,
// a window, the command palette, a context menu), with no 4xx/5xx, failed request, console error, page error or CSP
// violation on the way. W2: the subscription gate, for an account that has no subscription (the unpaid state). Which of
// the two applies is read from the account (`workspace_access`), never assumed; the other one skips with its reason.
// Nothing here writes: no setting, theme or preference is changed. Runs on all three device projects.
import { expect, test } from "../../fixtures/session.js";
import type { Page } from "@playwright/test";
import type { ApiClient } from "../../src/client.js";
import { accessViolations, badStatusEvent, clip, labelUrl, problemLines, type PageEvent } from "./expected.js";

test.use({ sessionRole: "owner" });

const BOOT_DEADLINE_MS = 60_000;

async function workspaceAccess(api: ApiClient): Promise<string> {
  const res = await api.get("/api/cloud/auth/me", { headers: { accept: "application/json" } });
  expect(res.status, "/api/cloud/auth/me").toBe(200);
  return String((JSON.parse(res.body) as { workspace_access?: unknown }).workspace_access);
}

/** Records what a clean boot must not produce. Wired before the first navigation so nothing slips past. */
async function watch(page: Page, origin: string): Promise<PageEvent[]> {
  const events: PageEvent[] = [];
  // A string, not a function: this package has no DOM types, and the script runs in the page, not in Node.
  await page.addInitScript(
    'document.addEventListener("securitypolicyviolation", function (e) { (window.__fxCsp = window.__fxCsp || []).push(e.violatedDirective); });',
  );
  page.on("console", (m) => {
    if (m.type() === "error") events.push({ kind: "console-error", detail: clip(m.text()) });
  });
  page.on("pageerror", (e) => events.push({ kind: "page-error", detail: clip(e.message) }));
  page.on("response", (r) => {
    const bad = badStatusEvent(r.status(), r.request().method(), r.url(), origin);
    if (bad !== null) events.push(bad);
  });
  page.on("requestfailed", (r) => {
    if (labelUrl(r.url()).startsWith(origin)) events.push({ kind: "failed-request", detail: `${r.method()} ${labelUrl(r.url())} (${r.failure()?.errorText ?? "unknown"})` });
  });
  return events;
}

async function cspViolations(page: Page): Promise<PageEvent[]> {
  const seen = (await page.evaluate("window.__fxCsp ?? []")) as string[];
  return seen.map((d) => ({ kind: "csp-violation" as const, detail: clip(d) }));
}

/** Waits for the desktop on the real clock, with a deadline. Resolves false when it did not come up (the gate case). */
async function reachedDesktop(page: Page): Promise<boolean> {
  try {
    await page.waitForFunction('window.currentStep === "DESKTOP"', undefined, { timeout: BOOT_DEADLINE_MS });
    return true;
  } catch {
    return false;
  }
}

test.describe("W1 shell on an open workspace", () => {
  test("boots to the desktop with no 4xx, failed request, console error or CSP violation", async ({ page, session, target }) => {
    test.skip((await workspaceAccess(session.api)) !== "open", "the owner account is not subscribed; W2 covers this state");
    const events = await watch(page, target.origin);
    await page.goto("/");
    expect(await reachedDesktop(page), "the desktop did not come up").toBe(true);
    await expect(page.locator("#subscription-gate-screen")).toHaveCount(0);
    // Not networkidle: the shell holds a live event stream open, so the network never goes idle. A short settle instead.
    await page.waitForTimeout(3_000);
    expect(problemLines([...events, ...(await cspViolations(page))])).toEqual([]);
  });

  test("the dock lists apps and opens one in a window", async ({ page, session }) => {
    test.skip((await workspaceAccess(session.api)) !== "open", "the owner account is not subscribed; W2 covers this state");
    await page.goto("/");
    expect(await reachedDesktop(page), "the desktop did not come up").toBe(true);
    const apps = await page.locator(".dock-icon[data-app-id]").evaluateAll((els) => els.map((e) => e.getAttribute("data-app-id") ?? ""));
    expect(apps.length, "the dock has no app icon").toBeGreaterThan(0);
    expect(apps).toContain("themes");
    await page.locator('.dock-icon[data-app-id="themes"]').first().click();
    await expect(page.locator('#windows-container .fulc-window[data-app-id="themes"]')).toBeVisible();
    expect(await page.evaluate("document.body.dataset.experience ?? ''"), "no theme is applied").not.toBe("");
  });

  test("the command palette opens on Ctrl/Cmd+K and closes on Escape; a context menu opens and closes", async ({ page, session }) => {
    test.skip((await workspaceAccess(session.api)) !== "open", "the owner account is not subscribed; W2 covers this state");
    await page.goto("/");
    expect(await reachedDesktop(page), "the desktop did not come up").toBe(true);
    await page.keyboard.press("ControlOrMeta+K");
    await expect(page.locator("#command-palette")).toBeVisible();
    await expect(page.locator("#command-palette-input")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#command-palette")).toHaveCount(0);

    // A synthetic contextmenu event: it works the same on a touch device, where a right click has no meaning.
    await page.locator("#desktop-surface").dispatchEvent("contextmenu", { clientX: 40, clientY: 40 });
    await expect(page.locator(".fulc-context-menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".fulc-context-menu")).toHaveCount(0);
  });
});

test.describe("W2 subscription gate", () => {
  test("an account without a subscription gets the gate or the onboarding desktop, never the full desktop", async ({ page, session }) => {
    const access = await workspaceAccess(session.api);
    test.skip(access === "open", "the owner account is subscribed; W2 needs the unpaid state (fresh-state:unpaid)");
    await page.goto("/");
    const desktop = await reachedDesktop(page);
    if (!desktop) await expect(page.locator("#subscription-gate-screen")).toBeVisible({ timeout: 10_000 });
    const gate = (await page.locator("#subscription-gate-screen").count()) > 0;
    const dockApps = desktop ? await page.locator(".dock-icon[data-app-id]").evaluateAll((els) => els.map((e) => e.getAttribute("data-app-id") ?? "")) : [];
    expect(accessViolations(access, { gate, desktop, dockApps })).toEqual([]);
  });
});
