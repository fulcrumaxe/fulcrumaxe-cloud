// apps/workspace/e2e/context-rules.spec.ts
//
// D#600 CX-9b: the context rules panel in the Repos app (a repository's rules and its budget) and in the Pipeline item pane (one item's rules), on the
// built cloud dist at the desktop, tablet and phone projects. The five routes are a stateful stand-in (e2e/helpers/context-mock.ts) that enforces what the
// real routes do; its bodies are the packages/api/fixtures/v1 shapes. The document carries the production CSP and Trusted Types. Every action is
// exercised, checked again after a reload, and undone where it can be.

import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page, type Route } from "@playwright/test";
import { bootToDesktop, stepToDesktop, waitForDesktop } from "./helpers/boot";
import { ITEM_ID, REPO_ID, installContextRoutes, newContextMock, ruleOf, serverText, type ContextMock } from "./helpers/context-mock";

const HERE = dirname(fileURLToPath(import.meta.url));
const V1 = join(HERE, "..", "..", "..", "packages", "api", "fixtures", "v1");
const readFixture = (...p: string[]) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
const REPOS = readFixture("listRepos", "200-page.json");
const SETTINGS = readFixture("getRepoSettings", "200-ok.json");
const LIST = readFixture("listWorkItems", "200-page.json");
const TIMELINE = readFixture("getWorkItemTimeline", "200-ok.json");
const PINS_MAX_READ = Number(readFileSync(join(HERE, "..", "..", "..", "packages", "runner-protocol", "src", "pinRules.ts"), "utf8").match(/export const PINS_MAX_READ = (\d+);/)![1]);
const CSP = "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
const REPO_APP = `#windows-container .fulc-window[data-app-id="repos"]`;
const PL_APP = `#windows-container .fulc-window[data-app-id="pipeline"]`;
const measure = (what: Record<string, unknown>) => appendFileSync(process.env.CX9B_MEASURE_FILE ?? "/dev/null", JSON.stringify({ project: test.info().project.name, ...what }) + "\n");

const ctx = (page: Page, app: string) => page.locator(`${app} [data-testid="ctx"]`);
const t = (page: Page, app: string, id: string) => ctx(page, app).locator(`[data-testid="${id}"]`);
const rowsOf = (page: Page, app: string) => t(page, app, "ctx-row");
const sw = (page: Page, app: string, i: number) => rowsOf(page, app).nth(i).locator('[data-ctl="switch"]');
const CONTROLS = 'button, select, input:not([type="radio"]):not([type="checkbox"])';
const names = (page: Page, app: string) => rowsOf(page, app).locator(".ctx-name");

async function watch(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP ${e.violatedDirective}`)));
  await page.route((u) => u.pathname === "/", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": CSP } });
  });
  return errors;
}

// ── Repos ───────────────────────────────────────────────────────────────
async function openRepo(page: Page) {
  if (!(await page.locator(REPO_APP).isVisible())) await page.locator('.dock-icon[data-app-id="repos"]').click();
  await expect(page.locator(REPO_APP)).toBeVisible();
  await page.locator(`${REPO_APP} [data-testid="repos-open"]`).first().click();
  await expect(t(page, REPO_APP, "ctx-applies")).toBeVisible();
  await expect(t(page, REPO_APP, "ctx-loading")).toHaveCount(0);
}
async function setupRepos(page: Page, m: ContextMock) {
  const errors = await watch(page);
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/v1/repos**", (route) => json(route, 200, new URL(route.request().url()).pathname.endsWith("/settings") ? SETTINGS : REPOS));
  await installContextRoutes(page, m);
  await bootToDesktop(page);
  await page.locator('.dock-icon[data-app-id="repos"]').click();
  await openRepo(page);
  return errors;
}
async function reloadRepos(page: Page) {
  await page.reload();
  await stepToDesktop(page);
  await openRepo(page);
}
const add = async (page: Page, app: string, path: string, kind: "pin" | "exclude" = "pin") => {
  await t(page, app, "ctx-kind").selectOption(kind);
  await t(page, app, "ctx-path").fill(path);
  await t(page, app, "ctx-add").click();
};

test.describe("D#600 CX-9b: the Repos app's context rules (mocked API)", () => {
  test("empty, then one, then many: paths with the folder dimmed, the badge and help line, the [id] hint, same-name folders, and the rows are still there after a reload", async ({ page }) => {
    const m = newContextMock();
    const errors = await setupRepos(page, m);
    await expect(t(page, REPO_APP, "ctx-empty")).toHaveText("No rules yet. Pin a file to always include it, or keep a path out of context.");
    await expect(t(page, REPO_APP, "ctx-applies")).toHaveText("Applies from the next run");
    await add(page, REPO_APP, "src/app/page.tsx");
    await expect(rowsOf(page, REPO_APP)).toHaveCount(1);
    const first = rowsOf(page, REPO_APP).first();
    await expect(first.locator(".ctx-dir")).toHaveText("src/app/");
    await expect(first.locator(".ctx-name")).toHaveText("page.tsx");
    const colors = await first.evaluate((li) => [getComputedStyle(li.querySelector(".ctx-dir")!).color, getComputedStyle(li.querySelector(".ctx-name")!).color]);
    expect(colors[0], "the folder is dimmed: its colour differs from the file name's").not.toBe(colors[1]);
    await expect(t(page, REPO_APP, "ctx-path")).toHaveValue(""); // cleared after a saved add
    await expect(t(page, REPO_APP, "ctx-note")).toHaveText("Saved src/app/page.tsx.");
    // the [id] hint shows in the form for an exclude whose path holds a bracket, and on the saved row
    await t(page, REPO_APP, "ctx-kind").selectOption("exclude");
    await t(page, REPO_APP, "ctx-path").fill("app/[id]/page.tsx");
    await expect(t(page, REPO_APP, "ctx-bracket")).toContainText("[id] is glob syntax");
    await t(page, REPO_APP, "ctx-add").click();
    await expect(rowsOf(page, REPO_APP)).toHaveCount(2);
    const ex = rowsOf(page, REPO_APP).filter({ hasText: "[id]" });
    await expect(ex.locator('[data-testid="ctx-badge"]').first()).toHaveText("Kept out of context");
    await expect(ex.locator('[data-testid="ctx-bracket-row"]')).toContainText("Use ? or *, or exclude the parent");
    await expect(t(page, REPO_APP, "ctx-help")).toHaveText("Kept out of context. Not a security boundary: tests and shell commands can still read it.");
    await expect(rowsOf(page, REPO_APP).filter({ hasText: "page.tsx" }).filter({ hasNotText: "[id]" }).locator('[data-testid="ctx-bracket-row"]')).toHaveCount(0);
    // same-name files name their nearest distinguishing folder
    await add(page, REPO_APP, "docs/README.md");
    await add(page, REPO_APP, "src/README.md");
    await expect(rowsOf(page, REPO_APP)).toHaveCount(4);
    await expect(rowsOf(page, REPO_APP).filter({ hasText: "docs/README.md" }).locator('[data-testid="ctx-same-name"]')).toContainText("folder docs/.");
    await expect(rowsOf(page, REPO_APP).filter({ hasText: "src/README.md" }).locator('[data-testid="ctx-same-name"]')).toContainText("folder src/.");
    // what the page showed is what the route holds, and a reload shows it again
    expect(m.rules.map((r) => r.path).sort()).toEqual(["app/[id]/page.tsx", "docs/README.md", "src/README.md", "src/app/page.tsx"]);
    await reloadRepos(page);
    await expect(rowsOf(page, REPO_APP)).toHaveCount(4);
    expect(errors).toEqual([]);
  });

  test("keyboard: Space toggles, Delete removes and focus moves to the next row; the 10 s Undo toast restores the rule with a real save; after the toast the rule stays gone", async ({ page }) => {
    const m = newContextMock({ rules: ["a/one.ts", "a/two.ts", "a/three.ts"].map((p) => ruleOf("repo", "pin", p)) });
    await setupRepos(page, m);
    await expect(rowsOf(page, REPO_APP)).toHaveCount(3);
    await expect(names(page, REPO_APP)).toHaveText(["one.ts", "three.ts", "two.ts"]);
    // Space toggles pin <-> kept out of context (a save of the other kind)
    await sw(page, REPO_APP, 0).focus();
    await page.keyboard.press("Space");
    await expect(sw(page, REPO_APP, 0)).toHaveAttribute("aria-checked", "true");
    await expect(rowsOf(page, REPO_APP).first().locator('[data-testid="ctx-badge"]').first()).toHaveText("Kept out of context");
    await expect(sw(page, REPO_APP, 0)).toBeFocused();
    expect(m.bodies.at(-1)).toEqual({ scope: "repo", repo_id: REPO_ID, kind: "exclude", path: "a/one.ts" });
    await page.keyboard.press("Space");
    await expect(sw(page, REPO_APP, 0)).toHaveAttribute("aria-checked", "false");
    expect(m.rules.find((r) => r.path === "a/one.ts")!.kind).toBe("pin");
    // Delete removes the focused row and focus lands on the next row's switch
    await sw(page, REPO_APP, 1).focus();
    await page.keyboard.press("Delete");
    await expect(rowsOf(page, REPO_APP)).toHaveCount(2);
    await expect(names(page, REPO_APP)).toHaveText(["one.ts", "two.ts"]);
    await expect(sw(page, REPO_APP, 1)).toBeFocused();
    expect(m.rules.map((r) => r.path).sort()).toEqual(["a/one.ts", "a/two.ts"]);
    const toast = t(page, REPO_APP, "ctx-toast");
    await expect(toast).toContainText("Removed a/three.ts. Applies from the next run.");
    // Delete on the last row: focus goes to the previous row
    await page.keyboard.press("Delete");
    await expect(rowsOf(page, REPO_APP)).toHaveCount(1);
    await expect(sw(page, REPO_APP, 0)).toBeFocused();
    await expect(toast).toHaveCount(2);
    // Undo the first removal: a real save of the same rule, the row is back and has the focus
    const savesBefore = m.bodies.length;
    await toast.first().getByTestId("ctx-undo").focus();
    await page.keyboard.press("Enter");
    await expect(rowsOf(page, REPO_APP)).toHaveCount(2);
    expect(m.bodies.length).toBe(savesBefore + 1);
    expect(m.bodies.at(-1)).toEqual({ scope: "repo", repo_id: REPO_ID, kind: "pin", path: "a/three.ts" });
    await expect(sw(page, REPO_APP, 1)).toBeFocused();
    await expect(t(page, REPO_APP, "ctx-note")).toHaveText("Restored a/three.ts.");
    await expect(toast).toHaveCount(1);
    await reloadRepos(page);
    await expect(names(page, REPO_APP)).toHaveText(["one.ts", "three.ts"]);
    // The other removal's Undo is gone with the page; a fresh removal's toast ends after 10 s and the rule stays removed
    await sw(page, REPO_APP, 1).focus();
    await page.keyboard.press("Delete");
    await expect(t(page, REPO_APP, "ctx-toast")).toHaveCount(1);
    await page.clock.runFor(9_000);
    await expect(t(page, REPO_APP, "ctx-toast")).toHaveCount(1);
    await page.clock.runFor(1_500);
    await expect(t(page, REPO_APP, "ctx-toast")).toHaveCount(0, { timeout: 1_500 });
    await reloadRepos(page);
    await expect(names(page, REPO_APP)).toHaveText(["one.ts"]);
  });

  test("the last row removed leaves the path field focused, and a removal that fails keeps the row with Retry", async ({ page }) => {
    const m = newContextMock({ rules: [ruleOf("repo", "pin", "only.ts")] });
    await setupRepos(page, m);
    m.forced.DELETE = [{ status: 500, code: "server_error" }];
    await sw(page, REPO_APP, 0).focus();
    await page.keyboard.press("Delete");
    await expect(rowsOf(page, REPO_APP)).toHaveCount(1);
    await expect(t(page, REPO_APP, "ctx-error")).toContainText("That change couldn't be saved. Try again.");
    await expect(t(page, REPO_APP, "ctx-error")).not.toContainText("server");
    await expect(t(page, REPO_APP, "ctx-toast")).toHaveCount(0);
    await t(page, REPO_APP, "ctx-retry").click();
    await expect(rowsOf(page, REPO_APP)).toHaveCount(0);
    await expect(t(page, REPO_APP, "ctx-path")).toBeFocused();
    await expect(t(page, REPO_APP, "ctx-empty")).toBeVisible();
    await expect(t(page, REPO_APP, "ctx-error")).toHaveText("");
  });

  test("a save that fails keeps the row and shows Retry; the retry is the same save", async ({ page }) => {
    const m = newContextMock({ rules: [ruleOf("repo", "pin", "src/a.ts")] });
    await setupRepos(page, m);
    m.forced.PUT = [{ status: 503, code: "tree_unavailable" }];
    await sw(page, REPO_APP, 0).focus();
    await page.keyboard.press("Space");
    const err = t(page, REPO_APP, "ctx-error");
    await expect(err).toContainText("The repository couldn't be read just now, so nothing was saved. Try again.");
    await expect(err).not.toContainText(serverText("tree_unavailable"));
    await expect(rowsOf(page, REPO_APP)).toHaveCount(1);
    await expect(sw(page, REPO_APP, 0)).toHaveAttribute("aria-checked", "false");
    await t(page, REPO_APP, "ctx-retry").click();
    await expect(sw(page, REPO_APP, 0)).toHaveAttribute("aria-checked", "true");
    await expect(err).toHaveText("");
    expect(m.rules[0]!.kind).toBe("exclude");
  });

  test("a refusal pins_exceed_budget is announced with role=alert, and nothing is saved", async ({ page }) => {
    const m = newContextMock({ budget: 4096, size: { "big/file.ts": 5000 } });
    await setupRepos(page, m);
    await add(page, REPO_APP, "big/file.ts");
    const alert = page.locator(`${REPO_APP} [role="alert"][data-testid="ctx-error"]`);
    await expect(alert).toContainText("These pins would not fit this repository's context budget, so nothing was saved.");
    expect(await alert.getAttribute("role")).toBe("alert");
    expect(m.rules).toEqual([]);
    await expect(t(page, REPO_APP, "ctx-path")).toHaveValue("big/file.ts"); // what was typed is kept for another try
    // a pin with * and a path outside the repository are refused before any request, with the invalid_path sentence
    const puts = m.bodies.length;
    await t(page, REPO_APP, "ctx-path").fill("src/*.ts");
    await t(page, REPO_APP, "ctx-add").click();
    await expect(alert).toContainText("That path can't be used.");
    expect(m.bodies.length).toBe(puts);
  });

  test("the read-limit line shows at one pin over what a run reads, not at the limit, and goes when one pin is removed", async ({ page }) => {
    const pins = Array.from({ length: PINS_MAX_READ }, (_, i) => ruleOf("repo", "pin", `files/f${String(i).padStart(2, "0")}.ts`));
    const m = newContextMock({ rules: pins, size: Object.fromEntries(pins.map((r) => [r.path, 10])) });
    await setupRepos(page, m);
    await expect(rowsOf(page, REPO_APP)).toHaveCount(PINS_MAX_READ);
    await expect(t(page, REPO_APP, "ctx-read-limit")).toHaveCount(0);
    await add(page, REPO_APP, "files/f99.ts");
    await expect(rowsOf(page, REPO_APP)).toHaveCount(PINS_MAX_READ + 1);
    await expect(t(page, REPO_APP, "ctx-read-limit")).toHaveText(`A run reads at most ${PINS_MAX_READ} of the pinned files. The rest are saved but not read.`);
    await reloadRepos(page);
    await expect(t(page, REPO_APP, "ctx-read-limit")).toHaveCount(1);
    await sw(page, REPO_APP, 0).focus();
    await page.keyboard.press("Delete");
    await expect(rowsOf(page, REPO_APP)).toHaveCount(PINS_MAX_READ);
    await expect(t(page, REPO_APP, "ctx-read-limit")).toHaveCount(0);
  });

  test("a failed read is the error state with Try again, never an empty list", async ({ page }) => {
    const m = newContextMock({ rules: [ruleOf("repo", "pin", "a.ts")] });
    const errors = await watch(page);
    const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    await page.route("**/api/v1/repos**", (route) => json(route, 200, new URL(route.request().url()).pathname.endsWith("/settings") ? SETTINGS : REPOS));
    await installContextRoutes(page, m);
    m.forced["GET list"] = [{ status: 500, code: "server_error" }];
    await bootToDesktop(page);
    await page.locator('.dock-icon[data-app-id="repos"]').click();
    await page.locator(`${REPO_APP} [data-testid="repos-open"]`).first().click();
    await expect(t(page, REPO_APP, "ctx-load-error")).toHaveText("Rules aren't available right now.");
    await expect(t(page, REPO_APP, "ctx-empty")).toHaveCount(0);
    await t(page, REPO_APP, "ctx-load-retry").click();
    await expect(rowsOf(page, REPO_APP)).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test("budget: role defaults read-only, a number field, Reset to default writes null, and a lowered budget says pins are never cut", async ({ page }) => {
    const pins = [ruleOf("repo", "pin", "a/x.ts"), ruleOf("repo", "pin", "a/y.ts")];
    const m = newContextMock({ rules: pins, size: { "a/x.ts": 3000, "a/y.ts": 3000 } });
    await setupRepos(page, m);
    const defaults = t(page, REPO_APP, "ctx-defaults");
    await expect(defaults.locator("dt")).toHaveText(["Executor"]); // CX-12: only roles whose runs use a budget
    await expect(defaults.locator("dd")).toHaveText(["35 KiB · role default"]);
    await expect(defaults.locator("input, button")).toHaveCount(0); // read-only
    await expect(t(page, REPO_APP, "ctx-budget-now")).toHaveText("Now: each role's default.");
    await expect(t(page, REPO_APP, "ctx-budget-reset")).toHaveAttribute("aria-disabled", "true");
    const field = t(page, REPO_APP, "ctx-budget-input");
    // out of range: refused in the page, nothing sent
    await field.fill("100");
    await t(page, REPO_APP, "ctx-budget-save").click();
    await expect(page.locator(`${REPO_APP} [data-testid="ctx-budget-error"]`)).toContainText("Enter a whole number from 4096 to 2097152.");
    expect(m.bodies).toEqual([]);
    // lowered below the pins: accepted, pins_status over_budget, and the sentence
    await field.fill("4096");
    await t(page, REPO_APP, "ctx-budget-save").click();
    await expect(t(page, REPO_APP, "ctx-budget-status")).toHaveText("Your pins are over this budget. They are never cut to fit it during a run.");
    await expect(t(page, REPO_APP, "ctx-budget-now")).toHaveText("Now: 4096 bytes.");
    expect(m.bodies).toEqual([{ context_budget_bytes: 4096 }]);
    await reloadRepos(page);
    await expect(t(page, REPO_APP, "ctx-budget-now")).toHaveText("Now: 4096 bytes.");
    await expect(t(page, REPO_APP, "ctx-budget-input")).toHaveValue("4096");
    // a pin over the lowered budget is refused (the other way round: save-time only)
    await add(page, REPO_APP, "a/z.ts");
    await expect(t(page, REPO_APP, "ctx-error")).toContainText("would not fit");
    // Reset to default writes null; the screen shows the default again, also after a reload
    await t(page, REPO_APP, "ctx-budget-reset").click();
    await expect(t(page, REPO_APP, "ctx-budget-now")).toHaveText("Now: each role's default.");
    expect(m.bodies.at(-1)).toEqual({ context_budget_bytes: null });
    expect(m.budget).toBeNull();
    await expect(t(page, REPO_APP, "ctx-budget-status")).toHaveText("Your pins fit this budget.");
    await reloadRepos(page);
    await expect(t(page, REPO_APP, "ctx-budget-now")).toHaveText("Now: each role's default.");
    await expect(t(page, REPO_APP, "ctx-budget-input")).toHaveValue("");
  });

  test("a failed budget save keeps the old number and offers Retry; a failed budget read has its own Retry", async ({ page }) => {
    const m = newContextMock({ budget: 8192 });
    await setupRepos(page, m);
    m.forced["PUT settings"] = [{ status: 500, code: "server_error" }];
    await t(page, REPO_APP, "ctx-budget-input").fill("9000");
    await t(page, REPO_APP, "ctx-budget-save").click();
    const err = page.locator(`${REPO_APP} [data-testid="ctx-budget-error"]`);
    await expect(err).toContainText("That change couldn't be saved. Try again.");
    await expect(t(page, REPO_APP, "ctx-budget-now")).toHaveText("Now: 8192 bytes.");
    await err.getByTestId("ctx-budget-retry").click();
    await expect(t(page, REPO_APP, "ctx-budget-now")).toHaveText("Now: 9000 bytes.");
    expect(m.budget).toBe(9000);
    m.forced["GET settings"] = [{ status: 500, code: "server_error" }];
    await reloadRepos(page);
    await expect(t(page, REPO_APP, "ctx-budget-error")).toContainText("The budget isn't available right now.");
    await t(page, REPO_APP, "ctx-budget-retry").click();
    await expect(t(page, REPO_APP, "ctx-budget-now")).toHaveText("Now: 9000 bytes.");
  });

  test("a member sees the rules and the defaults read-only: no add form, no switches, no remove, no editable budget", async ({ page }) => {
    const m = newContextMock({ isAdmin: false, budget: 8192, rules: [ruleOf("repo", "pin", "a/x.ts"), ruleOf("repo", "exclude", "secrets/**")] });
    await setupRepos(page, m);
    await expect(rowsOf(page, REPO_APP)).toHaveCount(2);
    await expect(t(page, REPO_APP, "ctx-admin-only")).toHaveText("Only owners and admins can change this.");
    await expect(t(page, REPO_APP, "ctx-budget-admin-only")).toHaveText("Only owners and admins can change this.");
    for (const id of ["ctx-path", "ctx-kind", "ctx-add", "ctx-budget-input", "ctx-budget-save", "ctx-budget-reset", "ctx-switch", "ctx-remove"]) await expect(t(page, REPO_APP, id)).toHaveCount(0);
    await expect(t(page, REPO_APP, "ctx-budget-now")).toHaveText("Now: 8192 bytes.");
    await expect(t(page, REPO_APP, "ctx-defaults").locator("dt")).toHaveCount(1);
  });

  test("demoted under the screen: the server's 403 turns the controls into the read-only view", async ({ page }) => {
    const m = newContextMock({ rules: [ruleOf("repo", "pin", "a.ts")] });
    await setupRepos(page, m);
    m.isAdmin = false;
    await sw(page, REPO_APP, 0).focus();
    await page.keyboard.press("Space");
    await expect(t(page, REPO_APP, "ctx-error")).toContainText("Only owners and admins can change this.");
    await expect(t(page, REPO_APP, "ctx-switch")).toHaveCount(0);
    await expect(t(page, REPO_APP, "ctx-path")).toHaveCount(0);
  });

  test("many rows: no sideways scroll, every state free of null, undefined and NaN, axe clean, and the measurements", async ({ page }) => {
    const rules = [
      ...Array.from({ length: 80 }, (_, i) => ruleOf("repo", i % 3 === 0 ? "exclude" : "pin", `packages/very-long-package-name-${i}/src/components/a-really-deeply-nested-folder/that-keeps-going/index.tsx`)),
      ruleOf("repo", "pin", "docs/README.md"), ruleOf("repo", "pin", "src/README.md"), ruleOf("repo", "exclude", "app/[id]/page.tsx"),
    ];
    const m = newContextMock({ rules, size: Object.fromEntries(rules.map((r) => [r.path, 10])), budget: 2097152 });
    await setupRepos(page, m);
    await expect(rowsOf(page, REPO_APP)).toHaveCount(83);
    m.forced.PUT = [{ status: 409, code: "pins_exceed_budget" }];
    await add(page, REPO_APP, "x/y.ts");
    await expect(t(page, REPO_APP, "ctx-error")).toContainText("would not fit");
    await expect(t(page, REPO_APP, "ctx-read-limit")).toBeVisible();
    const text = (await ctx(page, REPO_APP).innerText()) + (await ctx(page, REPO_APP).locator("input").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value).join(" ")));
    expect(text).not.toMatch(/\b(null|undefined|NaN)\b/);
    const m1 = await page.evaluate(([app, controls]) => {
      const panel = document.querySelector(`${app} [data-testid="ctx"]`) as HTMLElement;
      const win = document.querySelector(`${app} .repos-app`) as HTMLElement;
      const rows = [...panel.querySelectorAll<HTMLElement>('[data-testid="ctx-row"]')];
      return {
        viewport: window.innerWidth, panelWidth: Math.round(panel.getBoundingClientRect().width), appScroll: [win.scrollWidth, win.clientWidth], pageScroll: [document.documentElement.scrollWidth, window.innerWidth],
        widestRow: Math.max(...rows.map((r) => Math.round(r.scrollWidth))), rowClient: Math.max(...rows.map((r) => r.clientWidth)),
        controls: panel.querySelectorAll("button, input, select, [tabindex]").length,
        smallest: Math.min(...[...panel.querySelectorAll<HTMLElement>(controls)].map((b) => Math.round(b.getBoundingClientRect().height))),
      };
    }, [REPO_APP, CONTROLS] as const);
    measure({ test: "many rows", ...m1 });
    expect(m1.appScroll[0], "the app does not scroll sideways").toBeLessThanOrEqual(m1.appScroll[1]);
    expect(m1.pageScroll[0], "the page does not scroll sideways").toBeLessThanOrEqual(m1.pageScroll[1]);
    expect(m1.widestRow).toBeLessThanOrEqual(m1.rowClient);
    expect(m1.smallest, "every button, field and select is at least 44 px tall").toBeGreaterThanOrEqual(44);
    // 83 rows x (switch + remove), path + kind + add, budget level + input + save + reset, and the error's Retry
    expect(m1.controls).toBe(83 * 2 + 3 + 4 + 1);
    const axe = await new AxeBuilder({ page }).include(`${REPO_APP} [data-testid="ctx"]`).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
  });

  test("at 375 px a long unbroken path does not scroll sideways, every control is 44 px tall, and the path field is not spell-checked", async ({ page }) => {
    const long = "x".repeat(200) + ".ts";
    const m = newContextMock({ rules: [ruleOf("repo", "pin", long), ruleOf("repo", "exclude", "y".repeat(240) + "/index.tsx"), ruleOf("repo", "pin", "docs/a.md")], size: { [long]: 10 } });
    await setupRepos(page, m);
    await page.setViewportSize({ width: 375, height: 800 });
    await expect(rowsOf(page, REPO_APP)).toHaveCount(3);
    await expect(t(page, REPO_APP, "ctx-path")).toHaveAttribute("spellcheck", "false");
    const fit = await page.evaluate(([app, controls]) => {
      const panel = document.querySelector(`${app} [data-testid="ctx"]`) as HTMLElement;
      const win = document.querySelector(`${app} .repos-app`) as HTMLElement;
      const right = panel.getBoundingClientRect().right;
      const rows = [...panel.querySelectorAll<HTMLElement>('[data-testid="ctx-row"]')];
      return {
        viewport: window.innerWidth, panelWidth: Math.round(panel.getBoundingClientRect().width), panelScroll: [panel.scrollWidth, panel.clientWidth], appScroll: [win.scrollWidth, win.clientWidth],
        doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, rowScroll: Math.max(...rows.map((r) => r.scrollWidth - r.clientWidth)),
        past: [...panel.querySelectorAll("*")].filter((n) => n.getBoundingClientRect().width > 0 && n.getBoundingClientRect().right > right + 1).map((n) => n.tagName),
        smallest: Math.min(...[...panel.querySelectorAll<HTMLElement>(controls)].map((b) => Math.round(b.getBoundingClientRect().height))),
      };
    }, [REPO_APP, CONTROLS] as const);
    measure({ test: "375 long path", ...fit });
    expect(fit.panelScroll[0]).toBeLessThanOrEqual(fit.panelScroll[1]);
    expect(fit.appScroll[0]).toBeLessThanOrEqual(fit.appScroll[1]);
    expect(fit.doc).toBeLessThanOrEqual(0);
    expect(fit.rowScroll).toBeLessThanOrEqual(0);
    expect(fit.past).toEqual([]);
    expect(fit.smallest).toBeGreaterThanOrEqual(44);
  });

  test("Undo re-reads first: a rule another tab put at that path is not overwritten, a fixed sentence is shown, and the list shows what is there", async ({ page }) => {
    const m = newContextMock({ rules: [ruleOf("repo", "pin", "a/one.ts"), ruleOf("repo", "pin", "a/two.ts")] });
    await setupRepos(page, m);
    await sw(page, REPO_APP, 0).focus();
    await page.keyboard.press("Delete");
    await expect(t(page, REPO_APP, "ctx-toast")).toHaveCount(1);
    m.rules.push(ruleOf("repo", "exclude", "a/one.ts")); // another tab keeps the same path out of context meanwhile
    const saves = m.bodies.length;
    await t(page, REPO_APP, "ctx-undo").click();
    await expect(t(page, REPO_APP, "ctx-error-text")).toHaveText("This rule was changed somewhere else, so it was not restored. The list now shows what is there.");
    expect(m.bodies.length).toBe(saves);
    await expect(rowsOf(page, REPO_APP).first().locator('[data-testid="ctx-badge"]').first()).toHaveText("Kept out of context");
    expect(m.rules.find((r) => r.path === "a/one.ts")!.kind).toBe("exclude");
  });

  test("the accessible name of each control, counted (one pin, one exclude, admin)", async ({ page }) => {
    const m = newContextMock({ rules: [ruleOf("repo", "pin", "a/x.ts"), ruleOf("repo", "exclude", "b/y.ts")] });
    await setupRepos(page, m);
    const found = await page.evaluate((app) => {
      const panel = document.querySelector(`${app} [data-testid="ctx"]`)!;
      const nameOf = (el: Element) => {
        const lab = el.getAttribute("aria-label");
        if (lab) return lab;
        const id = el.getAttribute("id");
        const l = id ? panel.querySelector(`label[for="${id}"]`) : null;
        return (l ? l.firstChild?.textContent : el.textContent)?.trim() ?? "";
      };
      return [...panel.querySelectorAll("button, input, select")].map((el) => ({ tag: el.tagName.toLowerCase(), role: el.getAttribute("role"), name: nameOf(el) }));
    }, REPO_APP);
    measure({ test: "names", controls: found.length, found });
    expect(found).toEqual([
      { tag: "select", role: null, name: "Budget for" },
      { tag: "input", role: null, name: "Budget in bytes" },
      { tag: "button", role: null, name: "Save budget" },
      { tag: "button", role: null, name: "Reset to default" },
      { tag: "input", role: null, name: "Repository path" },
      { tag: "select", role: null, name: "Rule" },
      { tag: "button", role: null, name: "Add rule" },
      { tag: "button", role: "switch", name: "Keep out of context: a/x.ts" },
      { tag: "button", role: null, name: "Remove a/x.ts" },
      { tag: "button", role: "switch", name: "Keep out of context: b/y.ts" },
      { tag: "button", role: null, name: "Remove b/y.ts" },
    ]);
  });
});

// ── Pipeline item pane ────────────────────────────────────────────────────
const ITEM = LIST.data[0] as { id: string; repo_id: string };

async function setupPipeline(page: Page, m: ContextMock) {
  const errors = await watch(page);
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route((u) => u.pathname.startsWith("/api/v1/work-items") || u.pathname === "/api/v1/repos", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/repos") return json(route, 200, REPOS);
    if (url.pathname === "/api/v1/work-items") return json(route, 200, url.searchParams.get("stage") === "needs_human" ? { data: [], next_cursor: null } : LIST);
    if (url.pathname.endsWith("/timeline")) return json(route, 200, TIMELINE);
    return json(route, 404, { error: { code: "not_found", message: "not found", request_id: "r1" } });
  });
  await page.route("**/api/v1/events", (route) => route.fulfill({ status: 200, contentType: "text/event-stream", headers: { "cache-control": "no-store" }, body: "event: idle\ndata: {}\n\n" }));
  await installContextRoutes(page, m);
  await page.goto("/");
  await waitForDesktop(page);
  await page.locator('.dock-icon[data-app-id="pipeline"]').click();
  await expect(page.locator(PL_APP)).toBeVisible();
  await page.locator(`${PL_APP} [data-testid="pl-card"]`).first().click();
  await expect(t(page, PL_APP, "ctx-applies")).toBeVisible();
  await expect(t(page, PL_APP, "ctx-loading")).toHaveCount(0);
  return errors;
}
const mine = (scope: "repo" | "item", kind: "pin" | "exclude", path: string) => ruleOf(scope, kind, path, { repo: ITEM.repo_id, item: ITEM.id });

test.describe("D#600 CX-9b: this item's context rules in the Pipeline item pane (mocked API)", () => {
  test("this item or whole repo: an admin chooses the scope; the list holds the item's rules and the repo's, each tagged", async ({ page }) => {
    const m = newContextMock({ rules: [mine("repo", "pin", "docs/guide.md"), mine("item", "exclude", "legacy/**")] });
    const errors = await setupPipeline(page, m);
    expect(ITEM_ID).toBe(ITEM.id);
    await expect(rowsOf(page, PL_APP)).toHaveCount(2);
    await expect(rowsOf(page, PL_APP).filter({ hasText: "docs/guide.md" }).locator('[data-testid="ctx-scope-tag"]')).toHaveText("Whole repo");
    await expect(rowsOf(page, PL_APP).filter({ hasText: "legacy/**" }).locator('[data-testid="ctx-scope-tag"]')).toHaveText("This item");
    await expect(t(page, PL_APP, "ctx-scope-item")).toBeChecked();
    await add(page, PL_APP, "src/item-only.ts");
    await expect(rowsOf(page, PL_APP)).toHaveCount(3);
    expect(m.bodies.at(-1)).toEqual({ scope: "item", work_item_id: ITEM.id, kind: "pin", path: "src/item-only.ts" });
    await t(page, PL_APP, "ctx-scope-repo").check();
    await add(page, PL_APP, "src/for-all.ts");
    expect(m.bodies.at(-1)).toEqual({ scope: "repo", repo_id: ITEM.repo_id, kind: "pin", path: "src/for-all.ts" });
    await expect(rowsOf(page, PL_APP).filter({ hasText: "for-all.ts" }).locator('[data-testid="ctx-scope-tag"]')).toHaveText("Whole repo");
    // an item rule overrides the repo rule on the same path
    await t(page, PL_APP, "ctx-scope-item").check();
    await add(page, PL_APP, "src/for-all.ts", "exclude");
    await expect(rowsOf(page, PL_APP).filter({ hasText: "for-all.ts" })).toHaveCount(1);
    await expect(rowsOf(page, PL_APP).filter({ hasText: "for-all.ts" }).locator('[data-testid="ctx-scope-tag"]')).toHaveText("This item");
    // removing the item rule falls back to the repo rule
    await rowsOf(page, PL_APP).filter({ hasText: "for-all.ts" }).locator('[data-ctl="remove"]').click();
    await expect(rowsOf(page, PL_APP).filter({ hasText: "for-all.ts" }).locator('[data-testid="ctx-scope-tag"]')).toHaveText("Whole repo");
    await page.reload();
    await waitForDesktop(page);
    expect(errors).toEqual([]);
  });

  test("a member sets item rules only: the whole-repo choice is locked and a repo rule has no controls", async ({ page }) => {
    const m = newContextMock({ isAdmin: false, rules: [mine("repo", "pin", "docs/guide.md"), mine("item", "pin", "a.ts")] });
    await setupPipeline(page, m);
    await expect(t(page, PL_APP, "ctx-path")).toBeVisible();
    await expect(t(page, PL_APP, "ctx-scope-repo")).toHaveCount(0);
    await expect(t(page, PL_APP, "ctx-scope-repo-locked")).toHaveText("Whole repo: Only owners and admins can change this.");
    await expect(rowsOf(page, PL_APP).filter({ hasText: "guide.md" }).locator("button")).toHaveCount(0);
    await expect(rowsOf(page, PL_APP).filter({ hasText: "a.ts" }).locator("button")).toHaveCount(2);
    await add(page, PL_APP, "b.ts");
    expect(m.bodies.at(-1)).toEqual({ scope: "item", work_item_id: ITEM.id, kind: "pin", path: "b.ts" });
    await expect(t(page, PL_APP, "ctx-budget-admin-only")).toHaveText("Only owners and admins can change this."); // CX-12: the item's budget is read-only for a member
  });

  test("removing an item exclude that would put pinned files over budget warns (role=alert) and removes nothing; Keep it leaves it; the confirm repeats with confirm=true", async ({ page }) => {
    // A case the real route answers: the repo pin legacy/old.md is covered by the item's exclude, so only z.ts is read (2000 of 4096 bytes);
    // removing the exclude brings the repo pin back (3000 + 2000 > 4096), so the route asks for a confirmation.
    const ex = mine("item", "exclude", "legacy/**");
    const m = newContextMock({ rules: [mine("repo", "pin", "legacy/old.md"), ex, mine("item", "pin", "z.ts")], budget: 4096, size: { "legacy/old.md": 3000, "z.ts": 2000 } });
    await setupPipeline(page, m);
    await expect(rowsOf(page, PL_APP)).toHaveCount(3);
    const row = rowsOf(page, PL_APP).filter({ hasText: "legacy/**" });
    await row.locator('[data-ctl="switch"]').focus();
    await page.keyboard.press("Delete");
    const box = page.locator(`${PL_APP} [data-testid="ctx-warn-box"]`);
    await expect(box).toHaveAttribute("role", "alert");
    await expect(box).toContainText("Removing this exclude puts pinned files back in this item's runs, and they no longer fit the budget. Remove it anyway?");
    await expect(rowsOf(page, PL_APP)).toHaveCount(3);
    expect(m.requests.filter((r) => r.startsWith("DELETE"))).toEqual([`DELETE /api/v1/context-rules/${ex.id}`]);
    await expect(t(page, PL_APP, "ctx-keep")).toBeFocused();
    const axe = await new AxeBuilder({ page }).include(`${PL_APP} [data-testid="ctx"]`).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
    await t(page, PL_APP, "ctx-keep").click();
    await expect(box).toHaveCount(0);
    await expect(row.locator('[data-ctl="switch"]')).toBeFocused();
    expect(m.rules.some((r) => r.id === ex.id)).toBe(true);
    await page.keyboard.press("Delete");
    await t(page, PL_APP, "ctx-confirm").click();
    await expect(rowsOf(page, PL_APP)).toHaveCount(2);
    expect(m.requests.filter((r) => r.startsWith("DELETE"))).toEqual([`DELETE /api/v1/context-rules/${ex.id}`, `DELETE /api/v1/context-rules/${ex.id}`, `DELETE /api/v1/context-rules/${ex.id}?confirm=true`]);
    // undo: a real save of the same exclude
    await t(page, PL_APP, "ctx-undo").click();
    await expect(rowsOf(page, PL_APP)).toHaveCount(3);
    expect(m.bodies.at(-1)).toEqual({ scope: "item", work_item_id: ITEM.id, kind: "exclude", path: "legacy/**" });
  });

  test("every refusal the save can answer has its sentence in the pane, with no layout break (rate limit counts down)", async ({ page }) => {
    const m = newContextMock();
    await setupPipeline(page, m);
    const cases: [number, string, RegExp][] = [
      [409, "pins_exceed_ceiling", /most pinned files a run can carry/],
      [409, "excludes_exceed_cap", /most excluded paths a run can hold/],
      [409, "context_rules_busy", /Another change to this repository's rules is in progress/],
      [422, "invalid_path", /That path can't be used/],
      [404, "not_found", /no longer exists/],
      [403, "insufficient_role", /Only owners and admins/],
      [429, "rate_limited", /Too many changes\. Try again in 7 seconds\./],
    ];
    for (const [status, code, re] of cases) {
      m.forced.PUT = [{ status, code, headers: status === 429 ? { "retry-after": "7" } : undefined }];
      await t(page, PL_APP, "ctx-path").fill("p/q.ts");
      await t(page, PL_APP, "ctx-add").click();
      await expect(t(page, PL_APP, "ctx-error")).toContainText(re);
      await expect(t(page, PL_APP, "ctx-error")).not.toContainText(serverText(code));
      m.isAdmin = true;
    }
    const w = await page.evaluate((app) => { const d = document.querySelector(`${app} [data-testid="pl-detail"]`)!; return [d.scrollWidth, d.clientWidth]; }, PL_APP);
    expect(w[0]).toBeLessThanOrEqual(w[1]);
  });
});

// ── D#600 CX-12: a budget per role and per item ────────────────────────────
const dd = (page: Page, app: string) => t(page, app, "ctx-defaults").locator("dd");
const level = (page: Page, app: string) => t(page, app, "ctx-budget-level");
const save = async (page: Page, app: string, value: string) => {
  await t(page, app, "ctx-budget-input").fill(value);
  await t(page, app, "ctx-budget-save").click();
};
/** Every budget control's height and the box the block takes, for the report; the block must not scroll sideways. */
const budgetFit = (page: Page, app: string, inner: string) =>
  page.evaluate(([a, inner, controls]) => {
    const block = document.querySelector(`${a} [data-testid="ctx-budget"]`) as HTMLElement;
    const win = document.querySelector(`${a} ${inner}`) as HTMLElement;
    const right = block.getBoundingClientRect().right;
    const els = [...block.querySelectorAll<HTMLElement>(controls)];
    return {
      viewport: window.innerWidth, blockWidth: Math.round(block.getBoundingClientRect().width), blockScroll: [block.scrollWidth, block.clientWidth], appScroll: [win.scrollWidth, win.clientWidth],
      doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, past: [...block.querySelectorAll("*")].filter((n) => n.getBoundingClientRect().width > 0 && n.getBoundingClientRect().right > right + 1).map((n) => n.tagName),
      controls: els.length, smallest: Math.min(...els.map((b) => Math.round(b.getBoundingClientRect().height))), widest: Math.max(...els.map((b) => Math.round(b.getBoundingClientRect().width))),
      order: els.map((b) => b.getAttribute("data-testid") ?? b.tagName.toLowerCase()),
    };
  }, [app, inner, CONTROLS] as const);

test.describe("D#600 CX-12: a role's budget in the Repos app (mocked API)", () => {
  test("pick a role, set it within its bound, reload and read it back, then reset it; the screen names the level of every number", async ({ page }) => {
    const m = newContextMock({ budget: 20000 });
    const errors = await setupRepos(page, m);
    await expect(level(page, REPO_APP).locator("option")).toHaveText(["Whole repository", "Executor"]);
    await expect(dd(page, REPO_APP).first()).toHaveText("20000 bytes · set for this repository");
    await level(page, REPO_APP).selectOption("executor");
    await expect(t(page, REPO_APP, "ctx-budget-now")).toHaveText("Now: none set for this role.");
    await expect(t(page, REPO_APP, "ctx-budget-reset")).toHaveAttribute("aria-disabled", "true");
    await expect(t(page, REPO_APP, "ctx-budget-input")).toHaveAttribute("max", "71680");
    await save(page, REPO_APP, "8192");
    await expect(t(page, REPO_APP, "ctx-budget-status")).toHaveText("Your pins fit this budget.");
    await expect(t(page, REPO_APP, "ctx-budget-now")).toHaveText("Now: 8192 bytes.");
    await expect(dd(page, REPO_APP)).toHaveText(["8 KiB · set for this role"]);
    expect(m.roles.executor).toBe(8192);
    expect(m.bodies).toEqual([{ budget_bytes: 8192 }]);
    await reloadRepos(page);
    await level(page, REPO_APP).selectOption("executor");
    await expect(t(page, REPO_APP, "ctx-budget-input")).toHaveValue("8192");
    await expect(dd(page, REPO_APP).first()).toHaveText("8 KiB · set for this role");
    // Undo: Reset removes this role's override only; the repository's number stays.
    await t(page, REPO_APP, "ctx-budget-reset").click();
    await expect(t(page, REPO_APP, "ctx-budget-now")).toHaveText("Now: none set for this role.");
    await expect(dd(page, REPO_APP).first()).toHaveText("20000 bytes · set for this repository");
    expect(m.roles.executor).toBeNull();
    expect(m.budget).toBe(20000);
    expect(m.bodies.at(-1)).toEqual({ budget_bytes: null });
    expect(errors).toEqual([]);
  });

  test("each level is held to its own bound: a role's is its default times 2, the repository's is unchanged; a server refusal keeps the old number", async ({ page }) => {
    const m = newContextMock({ roles: { executor: 9000 } });
    await setupRepos(page, m);
    await level(page, REPO_APP).selectOption("executor");
    await expect(t(page, REPO_APP, "ctx-budget-input")).toHaveValue("9000");
    for (const [value, range] of [["71681", "4096 to 71680"], ["4095", "4096 to 71680"]] as const) {
      await save(page, REPO_APP, value);
      await expect(t(page, REPO_APP, "ctx-budget-error")).toHaveText(`Enter a whole number from ${range}.`);
    }
    expect(m.bodies).toEqual([]); // nothing was sent
    await save(page, REPO_APP, "71680");
    await expect(t(page, REPO_APP, "ctx-budget-now")).toHaveText("Now: 71680 bytes.");
    await save(page, REPO_APP, "4096");
    await expect(t(page, REPO_APP, "ctx-budget-now")).toHaveText("Now: 4096 bytes.");
    m.forced["PUT role"] = [{ status: 422, code: "budget_out_of_range" }];
    await save(page, REPO_APP, "5000");
    await expect(t(page, REPO_APP, "ctx-budget-error")).toContainText("That size is outside the allowed range, so nothing was saved.");
    await expect(t(page, REPO_APP, "ctx-budget-now")).toHaveText("Now: 4096 bytes.");
    await level(page, REPO_APP).selectOption("repo");
    await expect(t(page, REPO_APP, "ctx-budget-error")).toHaveCount(0);
    await expect(t(page, REPO_APP, "ctx-budget-input")).toHaveAttribute("max", "2097152");
    await save(page, REPO_APP, "2097152");
    await expect(t(page, REPO_APP, "ctx-budget-now")).toHaveText("Now: 2097152 bytes.");
  });

  test("a budget set below the pins is accepted and reported, never refused", async ({ page }) => {
    const m = newContextMock({ rules: [ruleOf("repo", "pin", "a/x.ts")], size: { "a/x.ts": 6000 } });
    await setupRepos(page, m);
    await level(page, REPO_APP).selectOption("executor");
    await save(page, REPO_APP, "5000");
    await expect(t(page, REPO_APP, "ctx-budget-status")).toHaveText("Your pins are over this budget. They are never cut to fit it during a run.");
    expect(m.roles.executor).toBe(5000);
  });

  test("a member sees every number and its level, and no field, select or save", async ({ page }) => {
    const m = newContextMock({ isAdmin: false, budget: 20000, roles: { executor: 7000 } });
    await setupRepos(page, m);
    await expect(t(page, REPO_APP, "ctx-budget-admin-only")).toHaveText("Only owners and admins can change this.");
    await expect(dd(page, REPO_APP).first()).toHaveText("7000 bytes · set for this role");
    await expect(level(page, REPO_APP)).toHaveCount(0);
    await expect(t(page, REPO_APP, "ctx-budget-input")).toHaveCount(0);
  });

  test("the budget block fits, scrolls nowhere sideways, and every control is 44 px tall in a sensible order; axe is clean; no null, undefined or NaN", async ({ page }) => {
    const m = newContextMock({ budget: 20000, roles: { executor: 8192 } });
    await setupRepos(page, m);
    await level(page, REPO_APP).selectOption("executor");
    await save(page, REPO_APP, "71681");
    const text = await t(page, REPO_APP, "ctx-budget").innerText();
    expect(text).not.toMatch(/\b(null|undefined|NaN)\b/);
    const fit = await budgetFit(page, REPO_APP, ".repos-app");
    measure({ test: "role budget block", ...fit });
    expect(fit.blockScroll[0]).toBeLessThanOrEqual(fit.blockScroll[1]);
    expect(fit.appScroll[0]).toBeLessThanOrEqual(fit.appScroll[1]);
    expect(fit.doc).toBeLessThanOrEqual(0);
    expect(fit.past).toEqual([]);
    expect(fit.smallest).toBeGreaterThanOrEqual(44);
    expect(fit.order).toEqual(["ctx-budget-level", "ctx-budget-input", "ctx-budget-save", "ctx-budget-reset"]);
    await page.setViewportSize({ width: 375, height: 800 });
    const narrow = await budgetFit(page, REPO_APP, ".repos-app");
    measure({ test: "role budget block 375", ...narrow });
    expect(narrow.blockScroll[0]).toBeLessThanOrEqual(narrow.blockScroll[1]);
    expect(narrow.doc).toBeLessThanOrEqual(0);
    expect(narrow.past).toEqual([]);
    expect(narrow.smallest).toBeGreaterThanOrEqual(44);
    const axe = await new AxeBuilder({ page }).include(`${REPO_APP} [data-testid="ctx-budget"]`).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
  });
});

test.describe("D#600 CX-12: only roles whose runs use a budget are shown (mocked API)", () => {
  const OTHER = ["Fix", "Code reviewer", "Acceptance tester", "Security reviewer", "Debater"];
  test("Repos: the plain sentence is shown, the select offers the repository and the executor only, and no other role appears anywhere in the block", async ({ page }) => {
    const m = newContextMock({ budget: 20000, roles: { fix: 7000 } }); // a stored number for a role nobody reads yet
    await setupRepos(page, m);
    await expect(t(page, REPO_APP, "ctx-budget-consumers")).toHaveText("Today only the build's prompt uses a budget.");
    await expect(level(page, REPO_APP).locator("option")).toHaveText(["Whole repository", "Executor"]);
    await expect(dd(page, REPO_APP)).toHaveCount(1);
    const text = await t(page, REPO_APP, "ctx-budget").innerText();
    for (const name of OTHER) expect(text, name).not.toContain(name);
    measure({ test: "consumers sentence", options: 2, rows: 1 });
  });

  test("Pipeline: the item's block carries the same sentence and lists the executor only", async ({ page }) => {
    const m = newContextMock({ budget: 20000 });
    await setupPipeline(page, m);
    await expect(t(page, PL_APP, "ctx-budget-consumers")).toHaveText("Today only the build's prompt uses a budget.");
    await expect(dd(page, PL_APP)).toHaveCount(1);
    await expect(t(page, PL_APP, "ctx-defaults").locator("dt")).toHaveText(["Executor"]);
    const text = await t(page, PL_APP, "ctx-budget").innerText();
    for (const name of OTHER) expect(text, name).not.toContain(name);
  });
});

test.describe("D#600 CX-12: an item's budget in the Pipeline item pane (mocked API)", () => {
  async function reopenItem(page: Page) {
    await page.reload();
    await waitForDesktop(page);
    await page.locator('.dock-icon[data-app-id="pipeline"]').click();
    await expect(page.locator(PL_APP)).toBeVisible();
    await page.locator(`${PL_APP} [data-testid="pl-card"]`).first().click();
    await expect(t(page, PL_APP, "ctx-applies")).toBeVisible();
    await expect(t(page, PL_APP, "ctx-loading")).toHaveCount(0);
  }

  test("set the item's budget, see every role held to it with the level named, reload and read it back, then reset it", async ({ page }) => {
    const m = newContextMock({ budget: 20000, roles: { executor: 8192 } });
    const errors = await setupPipeline(page, m);
    await expect(level(page, PL_APP)).toHaveCount(0); // one level here
    await expect(t(page, PL_APP, "ctx-budget-now")).toHaveText("Now: none set for this item.");
    await expect(dd(page, PL_APP).first()).toHaveText("8 KiB · set for this role");
    await expect(t(page, PL_APP, "ctx-budget-reset")).toHaveAttribute("aria-disabled", "true");
    await expect(t(page, PL_APP, "ctx-budget-input")).toHaveAttribute("max", "86016");
    await save(page, PL_APP, "6000");
    await expect(t(page, PL_APP, "ctx-budget-now")).toHaveText("Now: 6000 bytes.");
    await expect(dd(page, PL_APP)).toHaveText(["6000 bytes · set for this item"]);
    expect(m.itemBudget).toBe(6000);
    expect(m.bodies.at(-1)).toEqual({ budget_bytes: 6000 });
    await reopenItem(page);
    await expect(t(page, PL_APP, "ctx-budget-input")).toHaveValue("6000");
    await expect(dd(page, PL_APP).first()).toHaveText("6000 bytes · set for this item");
    await t(page, PL_APP, "ctx-budget-reset").click();
    await expect(t(page, PL_APP, "ctx-budget-now")).toHaveText("Now: none set for this item.");
    await expect(dd(page, PL_APP).first()).toHaveText("8 KiB · set for this role"); // the role's number comes back; the repository's stays under it
    expect(m.itemBudget).toBeNull();
    expect(m.roles.executor).toBe(8192);
    expect(errors).toEqual([]);
  });

  test("the item's bound is the largest role bound; the shown run is held to its own role's limit; a failed save keeps the old number", async ({ page }) => {
    const m = newContextMock();
    await setupPipeline(page, m);
    await save(page, PL_APP, "86017");
    await expect(t(page, PL_APP, "ctx-budget-error")).toHaveText("Enter a whole number from 4096 to 86016.");
    expect(m.bodies).toEqual([]);
    await save(page, PL_APP, "86016");
    await expect(t(page, PL_APP, "ctx-budget-now")).toHaveText("Now: 86016 bytes.");
    // The item's number is held to the running role's own limit (the executor's is 71680), and that is what the run is shown with.
    await expect(dd(page, PL_APP)).toHaveText(["70 KiB · set for this item"]);
    m.forced["PUT item settings"] = [{ status: 500, code: "internal" }];
    await save(page, PL_APP, "5000");
    await expect(t(page, PL_APP, "ctx-budget-error")).toContainText("That change couldn't be saved. Try again.");
    await expect(t(page, PL_APP, "ctx-budget-now")).toHaveText("Now: 86016 bytes.");
  });

  test("a member reads the item's numbers and the admin-only sentence, with no field; the pane fits at every width with 44 px controls and axe clean", async ({ page }) => {
    const m = newContextMock({ isAdmin: false, itemBudget: 6000 });
    await setupPipeline(page, m);
    await expect(t(page, PL_APP, "ctx-budget-admin-only")).toHaveText("Only owners and admins can change this.");
    await expect(dd(page, PL_APP).first()).toHaveText("6000 bytes · set for this item");
    await expect(t(page, PL_APP, "ctx-budget-input")).toHaveCount(0);
    m.isAdmin = true;
    await reopenItem(page);
    const fit = await budgetFit(page, PL_APP, '[data-testid="pl-detail"]');
    measure({ test: "item budget block", ...fit });
    expect(fit.blockScroll[0]).toBeLessThanOrEqual(fit.blockScroll[1]);
    expect(fit.past).toEqual([]);
    expect(fit.smallest).toBeGreaterThanOrEqual(44);
    expect(fit.order).toEqual(["ctx-budget-input", "ctx-budget-save", "ctx-budget-reset"]);
    const axe = await new AxeBuilder({ page }).include(`${PL_APP} [data-testid="ctx-budget"]`).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
  });
});
