// apps/workspace/e2e/roles-limits.spec.ts
//
// D#37 WS-F4c (C30, C38 section 1): the Roles app's Run limits view. Two groups:
//   1. "mocked API" (always runs): the built cloud dist behind fixture-server.mjs,
//      which answers the view's opening GET from API-8d's fixture. The PUT and
//      every 4xx are mocked inline per test (C33 section 2).
//   2. "live" (opt-in, skipped unless RUN_LIMITS_LIVE_BASE_URL is set): the real
//      apps/web on Postgres, with the same env as developer-tokens.spec.ts (see its
//      header) plus DATABASE_URL_APP_USER in this process for the run_limits seed.
//      Start the server with `next start -p <port>` and NO `-H <host>`: with -H the
//      middleware rewrite of /api/cloud/auth/me loses its header and every sign-in
//      answers 404. Then: RUN_LIMITS_LIVE_BASE_URL=http://localhost:<port>
//        pnpm --filter workspace exec playwright test e2e/roles-limits.spec.ts

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page, type Route } from "@playwright/test";
import { seedAccountStatus, seedMemberOfAccount } from "./seed-account-status.mjs";
import { bootToDesktop } from "./helpers/boot";

const V1 = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "api", "fixtures", "v1");
const readFixture = (...p: string[]) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
const LIMITS = readFixture("getRunLimits", "200-ok.json");
const REPOS = readFixture("listRepos", "200-page.json");
const ROLE = readFixture("listRoles", "200-ok.json").data[0];
const EXEC = LIMITS.roles[0];

const WIN = `#windows-container .fulc-window[data-app-id="roles"]`;
const tid = (page: Page, id: string) => page.locator(`${WIN} [data-testid="${id}"]`);
const row = (page: Page, role: string) => page.locator(`${WIN} [data-testid="rl-row"][data-role="${role}"]`);
const fact = (page: Page, role: string, key: string) => row(page, role).locator(`[data-field="${key}"] dd`);
const input = (page: Page, key: string) => tid(page, `rl-input-${key}`);
const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const invalid = (message: string, path: string) => ({ error: { code: "invalid_run_limits_input", message, request_id: "r1" }, details: [{ path, code: "invalid" }] });
const wm = (page: Page, act: "open" | "close") =>
  page.evaluate((a) => (window as unknown as { FULCWM: Record<string, (id: string) => void> }).FULCWM[a]("roles"), act);

interface Opts {
  admin?: boolean;
  limits?: () => unknown;
  put?: (route: Route) => Promise<void>;
  patch?: (route: Route) => Promise<void>;
}

async function boot(page: Page, opts: Opts = {}) {
  const seen = { gets: 0, patches: 0, puts: [] as { role: string; body: Record<string, unknown> }[], appErrors: [] as string[] };
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && seen.appErrors.push(m.text()));
  page.on("pageerror", (e) => seen.appErrors.push(`pageerror: ${e.message}`));
  await page.route("**/api/cloud/auth/me", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), is_admin: !!opts.admin } });
  });
  await page.route("**/api/v1/run-limits**", async (route) => {
    if (route.request().method() === "GET") {
      seen.gets++;
      return json(route, 200, opts.limits ? opts.limits() : LIMITS);
    }
    const role = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop()!);
    const body = route.request().postDataJSON();
    seen.puts.push({ role, body });
    if (opts.put) return opts.put(route);
    const base = role === "default" ? LIMITS.default : EXEC;
    const set = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== null));
    return json(route, 200, { ...base, stored: body, resolved: { ...base.resolved, ...set } });
  });
  // The Roles view, for the focus polish: one repo, one role, the PATCH answered by the test.
  await page.route("**/api/v1/repos**", async (route) => {
    if (route.request().method() === "PATCH") {
      seen.patches++;
      return opts.patch ? opts.patch(route) : json(route, 200, ROLE);
    }
    return json(route, 200, /\/roles$/.test(route.request().url()) ? { data: [ROLE] } : REPOS);
  });
  await bootToDesktop(page);
  await openRoles(page);
  return seen;
}

async function openRoles(page: Page) {
  await wm(page, "open");
  await expect(page.locator(WIN)).toBeVisible();
}
async function openLimits(page: Page) {
  await tid(page, "roles-tab-limits").click();
  await expect(tid(page, "rl-list")).toBeVisible();
}
async function edit(page: Page, role: string) {
  await row(page, role).getByTestId("rl-edit").click();
  await expect(tid(page, "rl-form")).toBeVisible();
}
const setInherit = (page: Page, key: string, on: boolean) => tid(page, `rl-inherit-${key}`).setChecked(on);
const live = (page: Page, what: "start" | "count") =>
  page.evaluate(async (w) => {
    const m = await import(new URL("core/cloud-live.js", document.baseURI).href);
    return w === "start" ? m.default.start() : (m.subscriberCount() as number);
  }, what);
const online = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event("online")));

test.describe("D#37 WS-F4c: Roles, Run limits (mocked API)", () => {
  test("two tabs, arrow keys switch them; the view loads on first open with exactly one GET; rows show value and source", async ({ page }) => {
    const seen = await boot(page);
    await expect(page.locator(`${WIN} [role="tablist"] [role="tab"]`)).toHaveText(["Roles", "Run limits"]);
    expect(seen.gets).toBe(0);
    await tid(page, "roles-tab-roles").focus();
    await page.keyboard.press("ArrowRight");
    await expect(tid(page, "roles-tab-limits")).toBeFocused();
    await expect(tid(page, "rl-row")).toHaveCount(2);
    await expect(tid(page, "rl-intro")).toHaveText("These limits apply to every repo in this account.");
    await expect(tid(page, "roles-repo")).toBeHidden();
    await expect(row(page, "default")).toContainText("Account default");
    await expect(row(page, "executor")).toContainText("fulcrumaxe executor");
    await expect(fact(page, "executor", "per_run_usd")).toHaveText("$75.50 set for this role");
    await expect(fact(page, "executor", "max_run_minutes")).toHaveText("120 minutes account default");
    await expect(fact(page, "executor", "max_turns")).toHaveText("100 platform default");
    await expect(tid(page, "rl-what")).toContainText("When a run reaches a limit, its work isn't lost.");
    // A member (no is_admin): no Edit control, one line saying why.
    await expect(tid(page, "rl-note")).toHaveText("Only owners and admins can change these.");
    await expect(tid(page, "rl-edit")).toHaveCount(0);
    await page.keyboard.press("ArrowLeft");
    await expect(tid(page, "roles-row")).toHaveCount(1);
    expect(seen.gets).toBe(1);
    expect(seen.puts).toEqual([]);
    expect(seen.appErrors).toEqual([]);
  });

  test("the form has eight labelled fields in two groups, with hints and bounds from the response", async ({ page }) => {
    await boot(page, { admin: true });
    await openLimits(page);
    await edit(page, "executor");
    await expect(page.locator(`${WIN} fieldset legend`)).toHaveText(["Limits", "When a limit is reached"]);
    await expect(page.locator(`${WIN} [data-testid^="rl-input-"]`)).toHaveCount(8);
    const run = input(page, "max_run_minutes");
    await expect(run).toHaveAttribute("min", String(LIMITS.bounds.max_run_minutes.floor));
    await expect(run).toHaveAttribute("max", String(LIMITS.bounds.max_run_minutes.ceiling));
    await expect(run).toHaveAttribute("inputmode", "numeric");
    await expect(run).toBeDisabled(); // stored null: Inherit is on
    await expect(page.locator(`${WIN} #rl-executor-max_run_minutes-hint`)).toHaveText("Between 5 and 240. Inherits 120 minutes from account default.");
    await expect(input(page, "per_run_usd")).toHaveAttribute("step", "0.01");
    await expect(input(page, "per_run_usd")).toHaveAttribute("inputmode", "decimal");
    await expect(input(page, "per_run_usd")).toHaveValue("75.5");
    await expect(page.locator(`${WIN} label[for="rl-executor-per_run_usd"]`)).toHaveText("Spend per run (USD)");
    await expect(page.locator(`${WIN} label[for="rl-executor-auto_resume"]`)).toHaveText("Continue automatically");
  });

  test("Save sends one PUT with all eight fields, inherited ones null, and the row re-renders from the reply", async ({ page }) => {
    const seen = await boot(page, { admin: true });
    await openLimits(page);
    await edit(page, "executor");
    await setInherit(page, "max_run_minutes", false);
    await input(page, "max_run_minutes").fill("90");
    await tid(page, "rl-save").click();
    await expect(fact(page, "executor", "max_run_minutes")).toHaveText("90 minutes set for this role");
    expect(seen.puts).toEqual([{ role: "executor", body: { ...EXEC.stored, max_run_minutes: 90 } }]);
    expect(Object.keys(seen.puts[0].body)).toHaveLength(8);
    await expect(row(page, "executor").getByTestId("rl-edit")).toBeFocused();
    await edit(page, "executor");
    await setInherit(page, "per_run_usd", true);
    await tid(page, "rl-save").click();
    await expect.poll(() => seen.puts.length).toBe(2);
    expect(seen.puts[1].body.per_run_usd).toBeNull();
  });

  test("a bad value is flagged on its field, linked by aria-describedby, and no request is sent", async ({ page }) => {
    const seen = await boot(page, { admin: true });
    await openLimits(page);
    await edit(page, "executor");
    await setInherit(page, "max_turns", false);
    await input(page, "max_turns").fill("5");
    await input(page, "per_run_usd").fill("1.234");
    await tid(page, "rl-save").click();
    await expect(tid(page, "rl-error-max_turns")).toHaveText("Between 10 and 500.");
    await expect(tid(page, "rl-error-per_run_usd")).toHaveText("Use at most 2 decimals.");
    await expect(input(page, "max_turns")).toBeFocused();
    await expect(input(page, "max_turns")).toHaveAttribute("aria-invalid", "true");
    const id = await tid(page, "rl-error-max_turns").getAttribute("id");
    await expect(input(page, "max_turns")).toHaveAttribute("aria-describedby", new RegExp(`${id}$`));
    expect(seen.puts).toEqual([]);
  });

  test("a 422 puts the server's message on the field its path names, focuses it, and keeps the typed values", async ({ page }) => {
    const message = "Run time is above the platform ceiling.";
    const seen = await boot(page, { admin: true, put: (route) => json(route, 422, invalid(message, "max_run_minutes")) });
    await openLimits(page);
    await edit(page, "executor");
    await setInherit(page, "max_run_minutes", false);
    await input(page, "max_run_minutes").fill("90");
    await tid(page, "rl-save").click();
    await expect(tid(page, "rl-error-max_run_minutes")).toHaveText(message);
    await expect(input(page, "max_run_minutes")).toBeFocused();
    await expect(input(page, "max_run_minutes")).toHaveValue("90");
    await expect(tid(page, "rl-form-error")).toBeHidden();
    expect(seen.puts).toHaveLength(1);
    expect(seen.appErrors).toEqual([]);
  });

  for (const [status, sentence] of [
    [403, "Only owners and admins can change run limits."],
    [500, "That change couldn't be saved. Try again."],
  ] as const) {
    test(`a ${status} shows a fixed sentence, keeps the form and its typed values, and logs no console error`, async ({ page }) => {
      const seen = await boot(page, { admin: true, put: (route) => json(route, status, { error: { code: "x", message: "secret internal detail", request_id: "r1" } }) });
      await openLimits(page);
      await edit(page, "executor");
      await input(page, "per_run_usd").fill("12.5");
      await tid(page, "rl-save").click();
      await expect(tid(page, "rl-form-error")).toHaveText(sentence);
      await expect(input(page, "per_run_usd")).toHaveValue("12.5");
      await expect(page.locator(WIN)).not.toContainText("secret internal detail");
      expect(seen.appErrors).toEqual([]);
    });
  }

  test("the edit, save and error flow works from the keyboard alone", async ({ page }) => {
    const seen = await boot(page, { admin: true, put: (route) => json(route, 422, invalid("Too many extensions.", "max_extensions")) });
    await openLimits(page);
    await row(page, "executor").getByTestId("rl-edit").focus();
    await page.keyboard.press("Enter");
    await expect(input(page, "per_run_usd")).toBeFocused();
    await tid(page, "rl-inherit-max_extensions").focus();
    await page.keyboard.press("Space"); // clears Inherit
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.type("3");
    await page.keyboard.press("Enter"); // submits the form
    await expect(tid(page, "rl-error-max_extensions")).toHaveText("Too many extensions.");
    await expect(input(page, "max_extensions")).toBeFocused();
    expect(seen.puts[0].body.max_extensions).toBe(3);
    await tid(page, "rl-cancel").focus();
    await page.keyboard.press("Enter");
    await expect(row(page, "executor").getByTestId("rl-edit")).toBeFocused();
  });

  test("live: refresh reloads; a form with unsaved edits is kept and a note offers a reload; no subscriber leaks", async ({ page }) => {
    let n = 0;
    const changed = { ...EXEC, resolved: { ...EXEC.resolved, per_run_usd: 55 }, stored: { ...EXEC.stored, per_run_usd: 55 } };
    const seen = await boot(page, { admin: true, limits: () => (++n > 1 ? { ...LIMITS, roles: [changed] } : LIMITS) });
    await live(page, "start");
    await openLimits(page);
    const base = await live(page, "count");
    await online(page);
    await expect(fact(page, "executor", "per_run_usd")).toContainText("$55.00");
    await edit(page, "executor");
    await input(page, "per_run_usd").fill("33");
    const before = seen.gets;
    await page.clock.runFor(60_000);
    await online(page);
    await expect(tid(page, "rl-changed")).toContainText("Changed elsewhere, reload?");
    await expect(input(page, "per_run_usd")).toHaveValue("33");
    expect(seen.gets).toBe(before);
    await tid(page, "rl-reload").click();
    await expect(input(page, "per_run_usd")).toHaveValue("55");
    for (let i = 0; i < 20; i++) {
      await wm(page, "close");
      await page.clock.runFor(1000);
      await openRoles(page);
      await openLimits(page);
    }
    expect(await live(page, "count")).toBe(base);
  });

  test("phone: a row shows the resolved run time and spend per run, and Save and Cancel are a tap away", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "phone", "phone project only");
    await boot(page, { admin: true });
    await openLimits(page);
    await expect(fact(page, "executor", "max_run_minutes")).toBeVisible();
    await expect(fact(page, "executor", "per_run_usd")).toBeVisible();
    await expect(fact(page, "executor", "max_turns")).toBeHidden();
    await edit(page, "executor");
    await expect(tid(page, "rl-save")).toBeVisible();
    await tid(page, "rl-cancel").tap();
    await expect(tid(page, "rl-list")).toBeVisible();
  });

  test("Roles polish: a 422 does not pull focus back when the user has moved on", async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const refusal = { error: { code: "invalid_role_settings_input", message: "Below the floor.", request_id: "r1" }, details: [{ path: "mode", code: "invalid" }] };
    const seen = await boot(page, { admin: true, patch: (route) => gate.then(() => json(route, 422, refusal)) });
    await tid(page, "roles-mode").first().selectOption({ index: 1 });
    await expect.poll(() => seen.patches).toBe(1);
    await tid(page, "roles-tab-limits").focus(); // the user moves on while the save is in flight
    release();
    await expect(tid(page, "roles-row-error")).toHaveText("Below the floor.");
    await expect(tid(page, "roles-tab-limits")).toBeFocused();
  });
});

// C30 criterion 8: axe on the Run limits view in its main states, under every experience the shell
// ships, each applied through the real theme manager. Only serious and critical violations fail;
// anything lesser is printed so a reviewer sees it. The window's own titlebar (its minimize, maximize
// and close buttons) belongs to the shell and is excluded; the view is not.
const THEMES = ["classic-crt", "retro-amber", "nord", "corporate", "modern-flat", "crystal", "orchard", "cyberpunk"];
async function axeSeriousOrCritical(page: Page) {
  const found: string[] = [];
  for (const theme of THEMES) {
    await page.evaluate(async (id) => {
      const m = await import(new URL("core/theme-manager.js", document.baseURI).href);
      await m.FULCTheme.apply(id);
    }, theme);
    const res = await new AxeBuilder({ page })
      .include(WIN)
      .exclude(`${WIN} .window-titlebar`)
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
      .analyze();
    const brief = (v: (typeof res.violations)[number]) => `[${theme}] ${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`;
    const minor = res.violations.filter((v) => v.impact !== "serious" && v.impact !== "critical");
    if (minor.length) console.log(`axe (moderate/minor, not failing): ${minor.map(brief).join(" ;; ")}`);
    found.push(...res.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map(brief));
  }
  return found;
}

test.describe("D#37 WS-F4c: Roles, Run limits (accessibility, axe)", () => {
  test("read-only member view has no serious or critical violations", async ({ page }) => {
    await boot(page);
    await openLimits(page);
    await expect(tid(page, "rl-note")).toBeVisible();
    expect(await axeSeriousOrCritical(page)).toEqual([]);
  });

  test("owner edit form has no serious or critical violations", async ({ page }) => {
    await boot(page, { admin: true });
    await openLimits(page);
    await edit(page, "executor");
    expect(await axeSeriousOrCritical(page)).toEqual([]);
  });

  test("a 422 shown on its field has no serious or critical violations", async ({ page }) => {
    await boot(page, { admin: true, put: (route) => json(route, 422, invalid("Run time is above the platform ceiling.", "max_run_minutes")) });
    await openLimits(page);
    await edit(page, "executor");
    await setInherit(page, "max_run_minutes", false);
    await input(page, "max_run_minutes").fill("90");
    await tid(page, "rl-save").click();
    await expect(tid(page, "rl-error-max_run_minutes")).toBeVisible();
    expect(await axeSeriousOrCritical(page)).toEqual([]);
  });

  test("phone width: the list and the open form have no serious or critical violations", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "phone", "phone project only");
    await boot(page, { admin: true });
    await openLimits(page);
    expect(await axeSeriousOrCritical(page)).toEqual([]);
    await edit(page, "executor");
    expect(await axeSeriousOrCritical(page)).toEqual([]);
  });
});

// ── live: real apps/web, real Postgres ──────────────────────────────────

const LIVE = process.env.RUN_LIMITS_LIVE_BASE_URL;
const ident = () => {
  const id = 900_000_000 + Math.floor(Math.random() * 90_000_000);
  return { id, email: `rl37-${id}@example.test`, login: `rl37-${id}` };
};
async function signIn(page: Page, who: ReturnType<typeof ident>) {
  await page.goto(`/api/auth/test/callback?githubUserId=${who.id}&email=${who.email}&login=${who.login}`);
  await page.waitForFunction(() => (window as unknown as { currentStep?: string }).currentStep === "DESKTOP", null, { timeout: 20_000 });
  await openRoles(page);
  await openLimits(page);
}

test.describe("D#37 WS-F4c: Roles, Run limits (live: real Postgres, next start)", () => {
  test.skip(!LIVE, "RUN_LIMITS_LIVE_BASE_URL not set -- opt-in, see this file's header comment");
  test.use({ baseURL: LIVE });

  test("an owner sets a role's run time; a member sees it read-only; Inherit goes back", async ({ page, browser }) => {
    const owner = ident();
    const member = ident();
    const { accountId } = await seedAccountStatus({ githubUserId: owner.id, email: owner.email, login: owner.login, status: "active" });
    await seedMemberOfAccount({ ownerGithubUserId: owner.id, memberGithubUserId: member.id, memberEmail: member.email, memberLogin: member.login });
    // GET /run-limits lists only roles that have their own row, so a brand-new account shows just
    // "Account default". Give this account an `executor` row that inherits every field (all NULL) and an
    // account default of 120 run minutes, so "Inherit" has an account default to fall back to. Both are
    // written as app_user inside the account's own tenant scope: a plain row insert with no audit row,
    // so the audit count below stays exactly the owner's one save.
    const seed = new pg.Pool({ connectionString: process.env.DATABASE_URL_APP_USER });
    try {
      const c = await seed.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.account_id', $1, true)", [accountId]);
        await c.query("INSERT INTO run_limits (account_id, role, max_run_minutes) VALUES ($1, '*', 120), ($1, 'executor', NULL)", [accountId]);
        await c.query("COMMIT");
      } finally {
        c.release();
      }
    } finally {
      await seed.end();
    }
    await signIn(page, owner);
    await edit(page, "executor");
    await setInherit(page, "max_run_minutes", false);
    await input(page, "max_run_minutes").fill("90");
    await tid(page, "rl-save").click();
    await expect(fact(page, "executor", "max_run_minutes")).toHaveText("90 minutes set for this role");
    const db = new pg.Pool({ connectionString: process.env.DATABASE_URL_PLATFORM_OPS });
    try {
      const audit = await db.query("SELECT count(*)::int AS n FROM audit_log WHERE account_id = $1 AND action = 'run_limits.changed'", [accountId]);
      expect(audit.rows[0].n).toBe(1);
    } finally {
      await db.end();
    }
    const ctx = await browser.newContext({ baseURL: LIVE });
    const other = await ctx.newPage();
    await signIn(other, member);
    await expect(fact(other, "executor", "max_run_minutes")).toHaveText("90 minutes set for this role");
    await expect(tid(other, "rl-edit")).toHaveCount(0);
    await ctx.close();
    await edit(page, "executor");
    await setInherit(page, "max_run_minutes", true);
    const put = page.waitForRequest((r) => r.method() === "PUT" && r.url().endsWith("/api/v1/run-limits/executor"));
    await tid(page, "rl-save").click();
    expect((await put).postDataJSON().max_run_minutes).toBeNull();
    await expect(fact(page, "executor", "max_run_minutes")).toContainText("account default");
  });
});
