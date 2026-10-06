// apps/workspace/e2e/onboarding-state.spec.ts
//
// ONBOARDING-STATE: steps 1 and 2 of Onboarding follow the current state, and the Onboarding and Repos windows
// re-read on the account's live events. The API is mocked with page.route(); the only thing that changes between
// "before" and "after" is the answer the mock gives and the event the shell's live client hands its subscribers,
// exactly as the server would after the key is removed or the read-only GitHub App is uninstalled.
// Nothing here reloads the page.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { bootToDesktop } from "./helpers/boot";

const DIR = dirname(fileURLToPath(import.meta.url));
const fx = (...p: string[]) => JSON.parse(readFileSync(join(DIR, "..", "..", "..", "packages", "api", "fixtures", "v1", ...p), "utf8"));
const NEW = fx("getOnboarding", "200-new.json");
const NONE_PREVIEW = fx("getOnboardingPreview", "200-none.json");
const PAGE = fx("listRepos", "200-page.json");
const CSP = "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";

/** The server's answer when steps 1..`n` are done and the rest are open. */
const doneUpTo = (n: number) => ({ ...NEW, steps: NEW.steps.map((s: object, i: number) => ({ ...s, completed_at: i < n ? `2026-09-20T09:0${i}:00.000Z` : null })) });
/** Both repos attached to the read-only App, or both detached (what the server lists once it is uninstalled). */
const repos = (installed: boolean) => ({
  ...PAGE,
  data: PAGE.data.map((r: object, i: number) => ({ ...r, install_state: installed ? "installed" : "not_installed", app_kind: installed ? "team_readonly" : null, full_name: i === 0 ? "acme/widgets" : "acme/docs" })),
});

interface Mock { onboarding: unknown; repos: unknown; reads: number; repoReads: number }

async function setup(page: Page, m: Mock) {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(e.message));
  await page.route((u) => u.pathname === "/", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": CSP } });
  });
  await page.route("**/api/cloud/auth/me", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), workspace_access: "no_subscription", is_admin: true } });
  });
  await page.route((u) => u.pathname === "/api/v1/onboarding", (route) => {
    m.reads++;
    return route.fulfill({ json: m.onboarding });
  });
  await page.route((u) => u.pathname === "/api/v1/onboarding/preview", (route) => route.fulfill({ json: NONE_PREVIEW }));
  await page.route((u) => u.pathname === "/api/v1/repos", (route) => {
    m.repoReads++;
    return route.fulfill({ json: m.repos });
  });
  await page.route("**/api/plans", (route) => route.fulfill({ json: { plans: [], viewer: { is_owner: true, partner_billed: false } } }));
  // The stream itself stays idle: the events below are handed to the shell's subscribers directly (see deliver()).
  await page.route("**/api/v1/events", (route) => route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: idle\ndata: {}\n\n" }));
  return problems;
}

/**
 * Hands one account event to the shell's live client the way another tab's leader does: over the BroadcastChannel it
 * listens on (cloud-live.js onChannel -> dispatch). That reaches exactly the subscribers registered with
 * on(type, ...) and, unlike a stream reconnect, triggers none of the refresh callbacks. A window that updates after
 * this call therefore updated because it subscribed to this event type.
 */
const deliver = (page: Page, type: string, data: Record<string, unknown>) =>
  page.evaluate(
    async ([t, d]) => {
      (await import(new URL("core/cloud-live.js", document.baseURI).href)).default.start(); // idempotent: opens the BroadcastChannel it listens on
      const ns = (await import(new URL("core/storage-ns.js", document.baseURI).href)).getNamespace() || "default";
      const ch = new BroadcastChannel("fx-live-" + ns);
      ch.postMessage({ type: "event", event: { id: "evt_1", type: t as string, created_at: "2026-09-20T10:00:00.000Z", data: d } });
      ch.close();
    },
    [type, data] as [string, Record<string, unknown>],
  );
const win = (page: Page, id: string) => page.locator(`.fulc-window[data-app-id="${id}"]`);
const current = (page: Page) => win(page, "onboarding").locator('[data-testid="ob-app"] [aria-current="step"]');

/** Marks the document, and counts main-frame navigations from here on: a reload would clear the mark and add a navigation. */
async function watchNoReload(page: Page) {
  await page.evaluate(() => ((window as unknown as { __noReload: number }).__noReload = 1));
  const navs: string[] = [];
  page.on("framenavigated", (f) => f === page.mainFrame() && navs.push(f.url()));
  return async () => {
    expect(navs).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { __noReload?: number }).__noReload)).toBe(1);
  };
}

test.describe("ONBOARDING-STATE: Onboarding and Repos follow the account without a reload", () => {
  test("removing the model key sends Onboarding back to step 1", async ({ page }) => {
    const m: Mock = { onboarding: doneUpTo(2), repos: repos(true), reads: 0, repoReads: 0 };
    const problems = await setup(page, m);
    await bootToDesktop(page);
    await expect(current(page)).toHaveAttribute("data-testid", "ob-step-preview");
    await expect(win(page, "onboarding").locator('[data-testid="ob-step-model_key"] .ob-state')).toContainText("Done");
    const untouched = await watchNoReload(page);
    const before = m.reads;

    // The key is removed: the server now answers with step 1 open and says so on the stream. Nothing has told the window yet.
    m.onboarding = doneUpTo(0);
    await expect(current(page)).toHaveAttribute("data-testid", "ob-step-preview");
    await deliver(page, "model_connection.changed", { state: "removed" });

    await expect(current(page)).toHaveAttribute("data-testid", "ob-step-model_key");
    await expect(win(page, "onboarding").locator('[data-testid="ob-step-model_key"] .ob-state')).toHaveText("Up next");
    await expect(win(page, "onboarding").locator('[data-testid="ob-step-model_key"]')).not.toContainText("Done");
    await expect(win(page, "onboarding").locator('[data-testid="ob-step-model_key"] [data-testid="ob-open-model-key"]')).toBeVisible();
    expect(m.reads).toBeGreaterThan(before);
    await untouched();
    expect(problems).toEqual([]);
  });

  test("a key that stops working (model_connection.broken) also sends it back to step 1", async ({ page }) => {
    const m: Mock = { onboarding: doneUpTo(2), repos: repos(true), reads: 0, repoReads: 0 };
    await setup(page, m);
    await bootToDesktop(page);
    await expect(current(page)).toHaveAttribute("data-testid", "ob-step-preview");
    m.onboarding = doneUpTo(0);
    await expect(current(page)).toHaveAttribute("data-testid", "ob-step-preview");
    await deliver(page, "model_connection.broken", { code: 401 });
    await expect(current(page)).toHaveAttribute("data-testid", "ob-step-model_key");
  });

  test("uninstalling the read-only GitHub App sends Onboarding back to step 2 and Repos shows Not installed", async ({ page }) => {
    const m: Mock = { onboarding: doneUpTo(2), repos: repos(true), reads: 0, repoReads: 0 };
    const problems = await setup(page, m);
    await bootToDesktop(page);
    await page.locator('.dock-icon[data-app-id="repos"]').click();
    const reposRows = win(page, "repos").locator('[data-testid="repos-state"]');
    await expect(reposRows).toHaveText(["Installed", "Installed"]);
    await expect(current(page)).toHaveAttribute("data-testid", "ob-step-preview");
    const untouched = await watchNoReload(page);
    const [onbBefore, reposBefore] = [m.reads, m.repoReads];

    // The App is uninstalled: the repos detach and step 2 reopens on the server; one event tells the stream.
    m.onboarding = doneUpTo(1);
    m.repos = repos(false);
    await expect(reposRows).toHaveText(["Installed", "Installed"]); // nothing has told the windows yet
    await expect(current(page)).toHaveAttribute("data-testid", "ob-step-preview");
    await deliver(page, "installation.changed", { kind: "team_readonly", state: "deleted" });

    await expect(reposRows).toHaveText(["Not installed", "Not installed"]);
    await expect(current(page)).toHaveAttribute("data-testid", "ob-step-readonly_app");
    await expect(win(page, "onboarding").locator('[data-testid="ob-step-readonly_app"]')).not.toContainText("Done");
    await expect(win(page, "onboarding").locator('[data-testid="ob-step-model_key"] .ob-state')).toContainText("Done"); // step 1 is untouched
    expect(m.reads).toBeGreaterThan(onbBefore);
    expect(m.repoReads).toBeGreaterThan(reposBefore);
    await untouched();
    expect(problems).toEqual([]);
  });

  test("a repo-sync event refreshes the Repos list alone", async ({ page }) => {
    const m: Mock = { onboarding: doneUpTo(1), repos: repos(false), reads: 0, repoReads: 0 };
    await setup(page, m);
    await bootToDesktop(page);
    await page.locator('.dock-icon[data-app-id="repos"]').click();
    const reposRows = win(page, "repos").locator('[data-testid="repos-state"]');
    await expect(reposRows).toHaveText(["Not installed", "Not installed"]);
    await expect(current(page)).toHaveAttribute("data-testid", "ob-step-readonly_app");
    const onbBefore = m.reads;
    m.repos = repos(true);
    await expect(reposRows).toHaveText(["Not installed", "Not installed"]);
    await deliver(page, "repos.changed", { kind: "team_readonly", inserted: 0, detached: 0 });
    await expect(reposRows).toHaveText(["Installed", "Installed"]);
    expect(m.reads).toBe(onbBefore);
  });

  test("installing it again brings step 2 and the Installed state back", async ({ page }) => {
    const m: Mock = { onboarding: doneUpTo(1), repos: repos(false), reads: 0, repoReads: 0 };
    await setup(page, m);
    await bootToDesktop(page);
    await page.locator('.dock-icon[data-app-id="repos"]').click();
    const reposRows = win(page, "repos").locator('[data-testid="repos-state"]');
    await expect(reposRows).toHaveText(["Not installed", "Not installed"]);
    await expect(current(page)).toHaveAttribute("data-testid", "ob-step-readonly_app");
    m.onboarding = doneUpTo(2);
    m.repos = repos(true);
    await deliver(page, "installation.changed", { kind: "team_readonly", state: "installed" });
    await expect(reposRows).toHaveText(["Installed", "Installed"]);
    await expect(current(page)).toHaveAttribute("data-testid", "ob-step-preview");
  });

  test("closing both windows drops their subscriptions, so a later event reads nothing", async ({ page }) => {
    const m: Mock = { onboarding: doneUpTo(2), repos: repos(true), reads: 0, repoReads: 0 };
    await setup(page, m);
    await bootToDesktop(page);
    await page.locator('.dock-icon[data-app-id="repos"]').click();
    await expect(win(page, "repos").locator('[data-testid="repos-state"]')).toHaveCount(2);
    const count = () => page.evaluate(async () => (await import(new URL("core/cloud-live.js", document.baseURI).href)).subscriberCount() as number);
    const open = await count();
    await page.evaluate(() => {
      const w = (window as unknown as { FULCWM: { close(id: string): void } }).FULCWM;
      w.close("onboarding");
      w.close("repos");
    });
    await expect(win(page, "onboarding")).toHaveCount(0);
    await expect(win(page, "repos")).toHaveCount(0);
    // Onboarding holds 5 (four events and the refresh), Repos 3 (two events and the refresh); all of them are released.
    expect(open - (await count())).toBe(5 + 3);
    const [onb, rep] = [m.reads, m.repoReads];
    await deliver(page, "installation.changed", { kind: "team_readonly", state: "deleted" });
    await page.clock.runFor(1_000);
    expect([m.reads, m.repoReads]).toEqual([onb, rep]);
  });
});

test.describe("ONBOARDING-PREVIEW-STALE: step 3's panel follows the installed repos", () => {
  const panel = (page: Page) => win(page, "onboarding");
  const options = (page: Page) => panel(page).locator('[data-testid="ob-repo"] option');
  const start = (page: Page) => panel(page).locator('[data-testid="ob-preview-start"]');
  /** The listing once only the first repo remains installed. */
  const justWidgets = () => ({ ...repos(true), data: [repos(true).data[0]] });

  test("an uninstall hides the panel and its Start button; a reinstall shows only the repos installed now", async ({ page }) => {
    const m: Mock = { onboarding: doneUpTo(2), repos: repos(true), reads: 0, repoReads: 0 };
    const problems = await setup(page, m);
    await bootToDesktop(page);
    await expect(current(page)).toHaveAttribute("data-testid", "ob-step-preview");
    await expect(options(page)).toHaveText(["acme/widgets", "acme/docs"]);
    await expect(start(page)).toBeVisible();
    await expect(start(page)).toBeEnabled();

    // The read-only App is uninstalled: step 2 reopens, and the old panel (repo list, Start) must be gone.
    m.onboarding = doneUpTo(1);
    m.repos = repos(false);
    await deliver(page, "installation.changed", { kind: "team_readonly", state: "deleted" });
    await expect(current(page)).toHaveAttribute("data-testid", "ob-step-readonly_app");
    await expect(start(page)).toHaveCount(0);
    await expect(panel(page).locator('[data-testid="ob-repo"]')).toHaveCount(0);
    await expect(panel(page).locator('[data-testid="ob-step-preview"]')).not.toContainText("acme/");

    // It is installed again, on one repo only: the panel comes back with a fresh list, not the old two.
    m.onboarding = doneUpTo(2);
    m.repos = justWidgets();
    await deliver(page, "installation.changed", { kind: "team_readonly", state: "installed" });
    await expect(current(page)).toHaveAttribute("data-testid", "ob-step-preview");
    await expect(options(page)).toHaveText(["acme/widgets"]);
    await expect(start(page)).toBeEnabled();
    expect(problems).toEqual([]);
  });

  test("a repo change while step 3 is open updates the list; with none left, Start gives way to Open Repos", async ({ page }) => {
    const m: Mock = { onboarding: doneUpTo(2), repos: repos(true), reads: 0, repoReads: 0 };
    await setup(page, m);
    await bootToDesktop(page);
    await expect(options(page)).toHaveText(["acme/widgets", "acme/docs"]);
    await panel(page).locator('[data-testid="ob-repo"]').selectOption({ label: "acme/docs" });

    m.repos = justWidgets(); // the selection changes: the repo the user had picked is no longer installed
    await deliver(page, "repos.changed", { kind: "team_readonly", inserted: 0, detached: 1 });
    await expect(options(page)).toHaveText(["acme/widgets"]);
    await expect(panel(page).locator('[data-testid="ob-repo"]')).toHaveValue(/.+/);

    m.repos = repos(false);
    await deliver(page, "repos.changed", { kind: "team_readonly", inserted: 0, detached: 1 });
    await expect(start(page)).toBeHidden();
    await expect(panel(page).locator('[data-testid="ob-preview-open-repos"]')).toBeVisible();
  });
});
