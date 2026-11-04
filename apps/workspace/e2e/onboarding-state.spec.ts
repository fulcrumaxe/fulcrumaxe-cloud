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
import AxeBuilder from "@axe-core/playwright";
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

// DW-PRESET-ONBOARD: the autonomy choice at the step-3 repository choice. What the server decides (a repo with no row reads Balanced, what a preset
// writes, what the next start does) is proved against real Postgres in packages/api/test/decision-settings-start.test.ts; the subject here is the page:
// the three presets as the server's table gives them, the preview before saving, the saved state read back after a reload, the way back, and the sizes.
const SETTINGS = fx("getDecisionSettings", "200-ok.json");
interface Autonomy { active: string; touched: boolean; reads: number; previews: string[]; writes: string[]; failSave: boolean; canChange: boolean }
const nameOf = (type: string) => SETTINGS.dials.find((d: { decision_type: string }) => d.decision_type === type).label as string;

/** A stand-in for the three settings routes that keeps one repo's preset, the way the server derives it: from what was last written. */
async function autonomySetup(page: Page, a: Autonomy) {
  const body = () => ({
    ...SETTINGS,
    can_change: a.canChange,
    active_preset: a.active,
    dials: SETTINGS.dials.map((d: object) => ({ ...d, source: a.touched ? "preset" : "default" })),
  });
  await page.route((u) => /^\/api\/v1\/repos\/[^/]+\/decision-settings(\/preset(\/preview)?)?$/.test(u.pathname), async (route) => {
    const path = new URL(route.request().url()).pathname;
    const sent = route.request().postDataJSON()?.preset as string | undefined;
    if (route.request().method() === "GET") {
      a.reads++;
      return route.fulfill({ json: body() });
    }
    if (path.endsWith("/preview")) {
      a.previews.push(sent!);
      const label = SETTINGS.presets.find((p: { name: string }) => p.name === sent).label;
      // The server writes the three start settings on a person's choice even where they already match (the auto-start sweep starts work only on a written row).
      const written = ["start_work_small", "start_work_bug", "start_work_doc"].map((decision_type) => ({ decision_type, from: "announce", to: "announce" }));
      const moves = sent === a.active ? (a.touched ? [] : written) : [{ decision_type: "start_work_small", from: "announce", to: "ask" }, { decision_type: "launch_sub_item", from: "announce", to: "ask" }];
      return route.fulfill({ json: { preset: sent, label, customer_role: "", active_preset: a.active, moves } });
    }
    if (a.failSave) return route.fulfill({ status: 500, json: { error: { code: "internal_error", message: "x" } } });
    a.writes.push(sent!);
    a.active = sent!;
    a.touched = true;
    return route.fulfill({ json: { ...body(), moved: [] } });
  });
}

// The three Playwright projects (desktop, phone, tablet) supply the widths; the sizes asserted below are read from the page it runs in.
{
  test.describe("DW-PRESET-ONBOARD: the picker", () => {
    const picker = (page: Page) => win(page, "onboarding").locator('[data-testid="ob-presets"]');
    const t = (page: Page, id: string) => picker(page).locator(`[data-testid="${id}"]`);
    const box = async (loc: ReturnType<typeof t>) => (await loc.boundingBox())!;

    test("the three presets from the server's table, Balanced (default) for a repo nobody chose for, sizes, and nothing blocks Start", async ({ page }) => {
      const m: Mock = { onboarding: doneUpTo(2), repos: repos(true), reads: 0, repoReads: 0 };
      const a: Autonomy = { active: "balanced", touched: false, reads: 0, previews: [], writes: [], failSave: false, canChange: true };
      const problems = await setup(page, m);
      await autonomySetup(page, a);
      await bootToDesktop(page);
      await expect(picker(page)).toBeVisible();
      await expect(picker(page).locator("legend")).toHaveText("How much do you want to decide?");
      const labels = picker(page).locator("label.ob-preset");
      await expect(labels).toHaveCount(SETTINGS.presets.length);
      for (const [i, p] of SETTINGS.presets.entries()) {
        await expect(labels.nth(i)).toContainText(p.label);
        await expect(labels.nth(i)).toContainText(p.customer_role);
      }
      await expect(t(page, "ob-preset-now")).toHaveText("Right now: Balanced (default)");
      await expect(t(page, "ob-preset-balanced")).toBeChecked();
      // Sizes: every option is a full-width block at least 44 px tall, and the buttons are too.
      const root = await box(picker(page));
      for (let i = 0; i < SETTINGS.presets.length; i++) {
        const b = await box(labels.nth(i));
        expect(b.height, `option ${i} height`).toBeGreaterThanOrEqual(44);
        expect(b.width, `option ${i} width`).toBeGreaterThanOrEqual(Math.min(root.width - 1, 200));
        expect(b.x + b.width, `option ${i} right edge`).toBeLessThanOrEqual(page.viewportSize()!.width);
      }
      const openBox = await box(t(page, "ob-preset-open"));
      expect(openBox.height).toBeGreaterThanOrEqual(44);
      const sizes = { viewport: page.viewportSize(), picker: [Math.round(root.width), Math.round(root.height)], options: await labels.evaluateAll((els) => els.map((e) => [Math.round(e.getBoundingClientRect().width), Math.round(e.getBoundingClientRect().height)])), open: [Math.round(openBox.width), Math.round(openBox.height)] };
      test.info().annotations.push({ type: "sizes", description: JSON.stringify(sizes) });
      console.log("PICKER-SIZES " + JSON.stringify(sizes));
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
      // Looking is not choosing: nothing was written, and Start waits on nothing.
      expect(a.writes).toEqual([]);
      await expect(win(page, "onboarding").locator('[data-testid="ob-preview-start"]')).toBeEnabled();
      expect(problems).toEqual([]);
    });

    test("no serious or critical accessibility violation in the picker, before and after a choice", async ({ page }) => {
      const m: Mock = { onboarding: doneUpTo(2), repos: repos(true), reads: 0, repoReads: 0 };
      const a: Autonomy = { active: "balanced", touched: false, reads: 0, previews: [], writes: [], failSave: false, canChange: true };
      await setup(page, m);
      await autonomySetup(page, a);
      await bootToDesktop(page);
      const scan = async () =>
        (await new AxeBuilder({ page }).include('.fulc-window[data-app-id="onboarding"]').exclude(".window-titlebar").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze()).violations
          .filter((v) => v.impact === "serious" || v.impact === "critical")
          .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
      await expect(picker(page)).toBeVisible();
      expect(await scan()).toEqual([]);
      await t(page, "ob-preset-cautious").check();
      await expect(t(page, "ob-preset-save")).toBeVisible();
      expect(await scan()).toEqual([]);
    });
    test("at 390 px wide the options stay 44 px tall and nothing scrolls sideways", async ({ page }, info) => {
      test.skip(info.project.name !== "phone", "the desktop window is not narrowed by the viewport");
      await page.setViewportSize({ width: 390, height: 844 });
      const m: Mock = { onboarding: doneUpTo(2), repos: repos(true), reads: 0, repoReads: 0 };
      const a: Autonomy = { active: "balanced", touched: false, reads: 0, previews: [], writes: [], failSave: false, canChange: true };
      await setup(page, m);
      await autonomySetup(page, a);
      await bootToDesktop(page);
      await t(page, "ob-preset-cautious").check();
      await expect(t(page, "ob-preset-save")).toBeVisible();
      const sizes = await picker(page).locator("label.ob-preset, button").evaluateAll((els) => els.map((e) => [Math.round(e.getBoundingClientRect().width), Math.round(e.getBoundingClientRect().height)]));
      console.log("PICKER-390 " + JSON.stringify(sizes));
      for (const [w, h] of sizes) {
        expect(h).toBeGreaterThanOrEqual(44);
        expect(w).toBeLessThanOrEqual(390);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    });
    test("choose, see what changes, save, reload and read it back, then go back to Balanced", async ({ page }) => {
      const m: Mock = { onboarding: doneUpTo(2), repos: repos(true), reads: 0, repoReads: 0 };
      const a: Autonomy = { active: "balanced", touched: false, reads: 0, previews: [], writes: [], failSave: false, canChange: true };
      await setup(page, m);
      await autonomySetup(page, a);
      await bootToDesktop(page);
      await t(page, "ob-preset-cautious").check();
      // The preview comes first: it names what changes, and nothing is written yet.
      await expect(t(page, "ob-preset-moves")).toContainText(nameOf("start_work_small") + ": go ahead and tell me to ask me first");
      await expect(t(page, "ob-preset-moves").locator("li")).toHaveCount(2);
      expect(a.previews).toEqual(["cautious"]);
      expect(a.writes).toEqual([]);
      const save = t(page, "ob-preset-save");
      expect((await box(save)).height).toBeGreaterThanOrEqual(44);
      await save.click();
      // The saved state is said in the page and announced in the window's live region.
      await expect(t(page, "ob-preset-msg")).toHaveText("Saved. This repository now runs as Cautious.");
      await expect(win(page, "onboarding").locator('[data-testid="ob-live"]')).toHaveText("Saved. This repository now runs as Cautious.");
      await expect(t(page, "ob-preset-now")).toHaveText("Right now: Cautious");
      expect(a.writes).toEqual(["cautious"]);

      await page.reload();
      await bootToDesktop(page);
      await expect(t(page, "ob-preset-now")).toHaveText("Right now: Cautious");
      await expect(t(page, "ob-preset-cautious")).toBeChecked();

      // The way back is the same two steps, and the history is the server's: this page only asks.
      await t(page, "ob-preset-balanced").check();
      await t(page, "ob-preset-save").click();
      await expect(t(page, "ob-preset-now")).toHaveText("Right now: Balanced");
      expect(a.writes).toEqual(["cautious", "balanced"]);
      // Choosing what already holds changes nothing and offers no save.
      await t(page, "ob-preset-autonomous").check();
      await t(page, "ob-preset-balanced").check();
      await expect(picker(page)).toContainText("Nothing changes: these settings already match Balanced.");
      await expect(t(page, "ob-preset-save")).toHaveCount(0);
    });

    test("choosing Balanced for a repo nobody chose for says what is written and writes it; the arrow keys keep focus on the options, before and after the save", async ({ page }) => {
      const m: Mock = { onboarding: doneUpTo(2), repos: repos(true), reads: 0, repoReads: 0 };
      const a: Autonomy = { active: "balanced", touched: false, reads: 0, previews: [], writes: [], failSave: false, canChange: true };
      await setup(page, m);
      await autonomySetup(page, a);
      await bootToDesktop(page);
      await expect(t(page, "ob-preset-now")).toHaveText("Right now: Balanced (default)");
      // Skipping writes nothing. Choosing Balanced writes the three start settings, and the preview says so.
      await t(page, "ob-preset-autonomous").check();
      await t(page, "ob-preset-balanced").check();
      await expect(t(page, "ob-preset-moves").locator("li")).toHaveCount(3);
      await expect(t(page, "ob-preset-moves")).toContainText(nameOf("start_work_small") + ": go ahead and tell me, saved as your choice");
      expect(a.writes).toEqual([]);
      await t(page, "ob-preset-save").click();
      await expect(t(page, "ob-preset-now")).toHaveText("Right now: Balanced");
      expect(a.writes).toEqual(["balanced"]);
      // The arrow keys move the choice, and focus stays on a radio through the busy re-render and after the save.
      const focused = () => page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName ?? "");
      await t(page, "ob-preset-balanced").focus();
      await page.keyboard.press("ArrowUp");
      await expect(t(page, "ob-preset-cautious")).toBeChecked();
      await expect(t(page, "ob-preset-save")).toBeVisible();
      expect(await focused()).toBe("ob-preset-cautious");
      await t(page, "ob-preset-save").focus();
      await page.keyboard.press("Enter");
      await expect(t(page, "ob-preset-now")).toHaveText("Right now: Cautious");
      await expect(t(page, "ob-preset-cautious")).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(t(page, "ob-preset-balanced")).toBeChecked();
      await expect(t(page, "ob-preset-save")).toBeVisible();
      expect(await focused()).toBe("ob-preset-balanced");
    });

    test("a failed save keeps the choice and its preview; focus order is the repository, the options, Save, then Open Autonomy", async ({ page }) => {
      const m: Mock = { onboarding: doneUpTo(2), repos: repos(true), reads: 0, repoReads: 0 };
      const a: Autonomy = { active: "balanced", touched: false, reads: 0, previews: [], writes: [], failSave: true, canChange: true };
      await setup(page, m);
      await autonomySetup(page, a);
      await bootToDesktop(page);
      await t(page, "ob-preset-autonomous").check();
      await t(page, "ob-preset-save").click();
      await expect(t(page, "ob-preset-msg")).toHaveText("That couldn't be saved. Your choice is still here; try again.");
      await expect(t(page, "ob-preset-autonomous")).toBeChecked();
      await expect(t(page, "ob-preset-save")).toBeVisible();
      expect(a.writes).toEqual([]);
      // Tab order from the repository select.
      const order: string[] = [];
      await win(page, "onboarding").locator('[data-testid="ob-repo"]').focus();
      for (let i = 0; i < 4; i++) {
        await page.keyboard.press("Tab");
        order.push(await page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName ?? ""));
      }
      expect(order).toEqual(["ob-preset-autonomous", "ob-preset-save", "ob-preset-open", "ob-preview-start"]);
    });

    test("a plain member sees the choice read-only, and a repo whose settings cannot be read says so without blocking Start", async ({ page }) => {
      const m: Mock = { onboarding: doneUpTo(2), repos: repos(true), reads: 0, repoReads: 0 };
      const a: Autonomy = { active: "balanced", touched: false, reads: 0, previews: [], writes: [], failSave: false, canChange: false };
      await setup(page, m);
      await autonomySetup(page, a);
      await bootToDesktop(page);
      await expect(picker(page)).toContainText("Only an owner or admin can change this.");
      for (const r of await picker(page).locator("input[type=radio]").all()) await expect(r).toBeDisabled();
      await expect(t(page, "ob-preset-save")).toHaveCount(0);
      await expect(win(page, "onboarding").locator('[data-testid="ob-preview-start"]')).toBeEnabled();
    });
  });
}

test.describe("DW-PRESET-ONBOARD: settings that cannot be read", () => {
  test("a failed read says so, writes nothing, and Start and the plan choice still work", async ({ page }) => {
    const m: Mock = { onboarding: doneUpTo(2), repos: repos(true), reads: 0, repoReads: 0 };
    await setup(page, m);
    await page.route((u) => /decision-settings/.test(u.pathname), (route) => route.fulfill({ status: 500, json: { error: { code: "internal_error", message: "x" } } }));
    await bootToDesktop(page);
    const picker = win(page, "onboarding").locator('[data-testid="ob-presets"]');
    await expect(picker).toContainText("The autonomy choice couldn't be loaded. You can set it later in Autonomy.");
    await expect(picker).not.toContainText(/null|undefined|NaN/);
    await expect(win(page, "onboarding").locator('[data-testid="ob-preview-start"]')).toBeEnabled();
    await expect(win(page, "onboarding").locator('[data-testid="ob-skip-ahead"], [data-testid="ob-skip-preview"]').first()).toBeVisible();
  });
});
