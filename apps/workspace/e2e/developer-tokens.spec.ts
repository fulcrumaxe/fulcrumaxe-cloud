// apps/workspace/e2e/developer-tokens.spec.ts
//
// D#37 WS-F7a (corrections C2, C24 section 3, C25): the Developer app, tokens
// half. Two groups of tests live here.
//
//   1. "mocked API" (always runs, desktop + tablet + phone): the built cloud
//      dist served by fixture-server.mjs, with /api/v1/tokens answered by
//      page.route() from the repo's contract fixtures (packages/api/fixtures/
//      v1/**) so each test can force a server response (409, 403, 422 ...) and
//      record the exact requests the app sent. The document carries the
//      production CSP and Trusted Types directives, so a sink in the app fails
//      here for real.
//   2. "live" (opt-in, skipped unless DEVELOPER_LIVE_BASE_URL is set): the real
//      apps/web server (`next build` + `next start`) on real Postgres, with the
//      test-auth sign-in. Needs FX_ENABLE_TEST_AUTH=1, a non-production
//      NODE_ENV, FX_SESSION_SECRET, DATABASE_URL_APP_USER, and
//      DATABASE_URL_PLATFORM_OPS in this process too (the seeding helper
//      writes to Postgres directly). Serve it on http://localhost:<port>: the
//      server builds its redirects from "localhost", and __Host- cookies are
//      accepted on http://localhost. Example:
//        DEVELOPER_LIVE_BASE_URL=http://localhost:4731 \
//          pnpm --filter workspace exec playwright test e2e/developer-tokens.spec.ts
//
// About console errors: Chromium itself logs "Failed to load resource: the
// server responded with a status of 4xx" for every 4xx fetch. Those lines are
// collected apart from the app's own console output, because C25 asks that a
// server refusal is shown without the APP logging an error.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";
import { seedAccountStatus, seedMemberOfAccount } from "./seed-account-status.mjs";
import { bootToDesktop, stepToDesktop } from "./helpers/boot";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const V1 = join(SCRIPT_DIR, "..", "..", "..", "packages", "api", "fixtures", "v1");
const readFixture = (...p: string[]) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
const LIST_FIXTURE = readFixture("listTokens", "200-page.json");
const CREATED_NAMED = readFixture("createToken", "201-created-named.json");

const BOOT_FAST_FORWARD_MS = 15_000;
const CSP =
  "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
// The dock's hover preview (core/taskbar.js showPreview) and the alt-tab strip
// clone a window's DOM, so scope every locator to the real window in
// #windows-container.
const DEV = `#windows-container .fulc-window[data-app-id="developer"]`;
const YES = "#fulc-modal-yes";
const NO = "#fulc-modal-no";

// ── shared helpers ──────────────────────────────────────────────────────

interface Watch {
  appErrors: string[];
  networkLog: string[];
  badResponses: string[];
  violations: () => Promise<string[]>;
}

async function watch(page: Page): Promise<Watch> {
  const w = { appErrors: [] as string[], networkLog: [] as string[], badResponses: [] as string[] };
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    (msg.text().startsWith("Failed to load resource") ? w.networkLog : w.appErrors).push(msg.text());
  });
  page.on("pageerror", (err) => w.appErrors.push(`pageerror: ${err.message}`));
  page.on("response", (res) => {
    if (res.status() >= 400) w.badResponses.push(`${res.status()} ${res.request().method()} ${new URL(res.url()).pathname}`);
  });
  await page.addInitScript(() => {
    const g = window as unknown as { __tt: string[] };
    g.__tt = [];
    document.addEventListener("securitypolicyviolation", (e) => g.__tt.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  return { ...w, violations: () => page.evaluate(() => (window as unknown as { __tt: string[] }).__tt) };
}

async function withCsp(page: Page) {
  await page.route((u) => u.pathname === "/", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": CSP } });
  });
}

async function bootMocked(page: Page) {
  await bootToDesktop(page);
}

/** After a reload the desktop restores windows saved as open, and a dock click on an open window minimizes it: ask the window manager instead. */
async function reopenDeveloper(page: Page) {
  await page.evaluate(() => (window as unknown as { FULCWM: { open: (id: string) => void } }).FULCWM.open("developer"));
  await expect(page.locator(DEV)).toBeVisible();
}

async function openDeveloper(page: Page) {
  await page.locator('.dock-icon[data-app-id="developer"]').click();
  await expect(page.locator(DEV)).toBeVisible();
  await expect(page.locator(DEV)).not.toHaveClass(/opening/); // measured sizes below need the open animation done
}

/** Every string the browser holds for this origin: DOM, form values, both storages, every IndexedDB record. */
async function browserHolds(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const parts: string[] = [document.documentElement.outerHTML, location.href];
    document.querySelectorAll("input, textarea, select").forEach((el) => parts.push((el as HTMLInputElement).value));
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i)!;
        parts.push(k, store.getItem(k) ?? "");
      }
    }
    const dbs = (await indexedDB.databases?.()) ?? [];
    for (const info of dbs) {
      if (!info.name) continue;
      await new Promise<void>((resolve) => {
        const open = indexedDB.open(info.name!);
        open.onerror = () => resolve();
        open.onsuccess = () => {
          const db = open.result;
          const names = Array.from(db.objectStoreNames);
          if (names.length === 0) { db.close(); return resolve(); }
          const tx = db.transaction(names, "readonly");
          let pending = names.length;
          for (const n of names) {
            const all = tx.objectStore(n).getAll();
            all.onsuccess = () => {
              parts.push(JSON.stringify(all.result));
              if (--pending === 0) { db.close(); resolve(); }
            };
            all.onerror = () => {
              if (--pending === 0) { db.close(); resolve(); }
            };
          }
        };
      });
    }
    return parts.join("\n");
  });
}

// ── mocked API ──────────────────────────────────────────────────────────

interface Sent {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | null;
}

interface Mock {
  sent: Sent[];
  tokens: Array<Record<string, unknown>>;
  createReply?: (body: Record<string, unknown>) => { status: number; json: unknown } | undefined;
  signedOut: boolean;
}

async function mockApi(page: Page, opts: { admin?: boolean } = {}): Promise<Mock> {
  const mock: Mock = { sent: [], tokens: structuredClone(LIST_FIXTURE.data), signedOut: false };
  await page.route("**/api/cloud/auth/me", async (route: Route) => {
    if (mock.signedOut) return route.fulfill({ status: 401, contentType: "application/json", body: "" });
    const res = await route.fetch();
    const me = await res.json();
    await route.fulfill({ response: res, json: { ...me, is_admin: !!opts.admin } });
  });
  await page.route("**/api/auth/signout", async (route) => {
    mock.sent.push(await record(route));
    mock.signedOut = true;
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
  });
  await page.route("**/api/v1/tokens**", async (route) => {
    const req = await record(route);
    if (req.method !== "GET") mock.sent.push(req);
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (req.method === "GET") return json(200, { data: mock.tokens, next_cursor: null });
    if (req.method === "POST" && req.path === "/api/v1/tokens") {
      const body = JSON.parse(req.body ?? "{}");
      const forced = mock.createReply?.(body);
      if (forced) return json(forced.status, forced.json);
      const created = { ...CREATED_NAMED, name: body.name ?? null, scopes: body.scopes };
      mock.tokens.unshift({
        id: created.id, display_hint: created.display_hint, name: created.name, scopes: created.scopes,
        created_by: "22222222-2222-4222-8222-222222222222", created_by_me: true, expires_at: created.expires_at,
        created_at: created.created_at, last_used_at: null, revoked_at: null,
      });
      return json(201, created);
    }
    if (req.method === "POST") {
      const n = mock.tokens.filter((t) => t.created_by_me && !t.revoked_at).length;
      mock.tokens.forEach((t) => t.created_by_me && (t.revoked_at = "2026-01-01T00:00:05.000Z"));
      return json(200, { revoked: n });
    }
    const id = req.path.split("/").pop();
    const t = mock.tokens.find((x) => x.id === id);
    if (t) t.revoked_at = "2026-01-01T00:00:05.000Z";
    return route.fulfill({ status: 204 });
  });
  return mock;
}

async function record(route: Route): Promise<Sent> {
  const req = route.request();
  return {
    method: req.method(),
    path: new URL(req.url()).pathname,
    headers: await req.allHeaders(),
    body: req.postData(),
  };
}

async function setup(page: Page, opts: { admin?: boolean } = {}) {
  const w = await watch(page);
  await withCsp(page);
  const mock = await mockApi(page, opts);
  await bootMocked(page);
  await openDeveloper(page);
  await expect(tid(page, "dev-table")).toBeVisible();
  return { w, mock };
}

function expectJsonMutation(s: Sent) {
  expect(s.headers["content-type"]).toBe("application/json");
  expect(s.headers["idempotency-key"]).toBeUndefined();
  // Origin and Sec-Fetch-* are the browser's to send: a route handler cannot
  // see them, so the live tests check them on the real request, and the
  // static test below checks the app never names them.
}

/**
 * Records what is in web storage the instant each document starts, before any
 * shell script runs. After a sign-out this is exactly what the wipe left
 * behind; boot then writes its own `fx-boot-shown` animation flag (no tenant
 * data), so reading storage later would count that instead.
 */
async function recordStorageAtLoad(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __atLoad: unknown }).__atLoad = { local: localStorage.length, session: sessionStorage.length };
  });
}
const storageAtLoad = (page: Page) => page.evaluate(() => (window as unknown as { __atLoad: unknown }).__atLoad);

const tid = (page: Page, id: string) => page.locator(`${DEV} [data-testid="${id}"]`);

function scope(page: Page, id: string) {
  return page.locator(`${DEV} input[type="checkbox"][value="${id}"]`);
}

async function create(page: Page, name: string) {
  await tid(page, "dev-create-open").click();
  if (name) await page.locator(`${DEV} #dev-name`).fill(name);
  await tid(page, "dev-create-submit").click();
}

test.describe("D#37 WS-F7a: Developer app, tokens (mocked API)", () => {
  test("lists name, scopes, hint, creator, expiry and last use; the creator column follows created_by_me", async ({ page }) => {
    const { w } = await setup(page);
    const rows = page.locator(`${DEV} tbody tr`);
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("CI deploy bot");
    await expect(rows.nth(0)).toContainText("read");
    await expect(rows.nth(0)).toContainText("runs:cancel");
    await expect(rows.nth(0)).toContainText("fxat_...oZnk");
    await expect(rows.nth(0).locator("td").nth(3)).toHaveText("You");
    await expect(rows.nth(0).locator("time").first()).toHaveAttribute("datetime", "2026-12-17T12:00:00.000Z");
    // Second token: unnamed, never used, someone else's.
    await expect(rows.nth(1)).toContainText("Unnamed token");
    await expect(rows.nth(1)).toContainText("Never");
    const creator = rows.nth(1).locator("td").nth(3).locator("span");
    await expect(creator).toHaveText("Member 55555555");
    await expect(creator).toHaveAttribute("title", "55555555-5555-4555-8555-555555555555");
    expect(await w.violations()).toEqual([]);
    expect(w.appErrors).toEqual([]);
    expect(w.badResponses).toEqual([]);
  });

  test("create, reveal once, close, reload: the token string is nowhere afterwards", async ({ page, context }, testInfo) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const { w, mock } = await setup(page);
    const afterCreate: string[] = [];
    let created = false;
    page.on("response", async (res) => {
      if (created && res.url().includes("/api/") && res.request().method() === "GET") {
        afterCreate.push(await res.text().catch(() => ""));
      }
    });

    await create(page, "  release bot  ");
    const secret = CREATED_NAMED.token as string;
    await expect(tid(page, "dev-secret")).toHaveText(secret);
    await expect(tid(page, "dev-reveal-warning")).toContainText("only once");
    created = true;

    // The request: trimmed name, default read scope, 90 days, JSON, no idempotency key.
    expect(mock.sent).toHaveLength(1);
    expect(JSON.parse(mock.sent[0].body!)).toEqual({ scopes: ["read"], expires_in_days: 90, name: "release bot" });
    expectJsonMutation(mock.sent[0]);

    await tid(page, "dev-copy").click();
    await expect(tid(page, "dev-copy-note")).toContainText("Copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(secret);

    // The dock's hover preview clones the window's DOM, secret included; the
    // app must sweep that clone away when the panel closes.
    if (testInfo.project.name !== "phone") {
      await page.locator('.dock-icon[data-app-id="developer"]').hover();
      await page.clock.runFor(1_000);
      await expect(page.locator(".dock-preview [data-secret-node]")).toHaveCount(0);
      await page.mouse.move(600, 300);
    }

    await tid(page, "dev-reveal-done").click();
    await expect(tid(page, "dev-reveal")).toHaveCount(0);
    await expect(page.locator("[data-secret-node]")).toHaveCount(0);
    await expect(page.locator(`${DEV} tbody tr`).first()).toContainText("release bot");
    expect(await browserHolds(page)).not.toContain(secret);

    // A fresh boot: nothing anywhere, including the storages and network.
    await page.reload();
    await stepToDesktop(page);
    await reopenDeveloper(page);
    await expect(page.locator(`${DEV} tbody tr`).first()).toContainText("release bot");
    expect(await browserHolds(page)).not.toContain(secret);
    expect(afterCreate.join("\n")).not.toContain(secret);
    expect(await w.violations()).toEqual([]);
    expect(w.appErrors).toEqual([]);
    expect(w.networkLog).toEqual([]);
  });

  test("name: blank is not sent, markup renders literally, maxlength is 64, a 422 on name shows inline", async ({ page }) => {
    const { w, mock } = await setup(page);
    await expect(tid(page, "dev-create-open")).toBeEnabled();
    await create(page, "   ");
    await expect(tid(page, "dev-secret")).toBeVisible();
    expect(JSON.parse(mock.sent[0].body!)).not.toHaveProperty("name");
    await tid(page, "dev-reveal-done").click();
    await expect(page.locator(`${DEV} tbody tr`).first().getByTestId("dev-token-name")).toHaveText("Unnamed token");

    await tid(page, "dev-create-open").click();
    await expect(page.locator(`${DEV} #dev-name`)).toHaveAttribute("maxlength", "64");
    await tid(page, "dev-create-cancel").click();

    await create(page, "<b>x</b>");
    await tid(page, "dev-reveal-done").click();
    const nameCell = page.locator(`${DEV} tbody tr`).first().getByTestId("dev-token-name");
    await expect(nameCell).toHaveText("<b>x</b>");
    expect(await nameCell.locator("b").count()).toBe(0);

    mock.createReply = () => ({
      status: 422,
      json: { error: { code: "validation_failed", message: "invalid", request_id: "r" }, details: [{ path: "name", code: "custom" }] },
    });
    await create(page, "bad\u0007name");
    await expect(tid(page, "dev-name-error")).toContainText("not allowed");
    await expect(tid(page, "dev-secret")).toHaveCount(0);
    expect(w.appErrors).toEqual([]);
    expect(await w.violations()).toEqual([]);
  });

  test("scopes: audit:read is offered only to an owner or admin; a member's 403 is shown quietly", async ({ page }) => {
    const { w, mock } = await setup(page, { admin: false });
    await tid(page, "dev-create-open").click();
    await expect(scope(page, "read")).toBeChecked();
    await expect(scope(page, "runs:cancel")).not.toBeChecked();
    await expect(scope(page, "audit:read")).toHaveCount(0);
    await expect(scope(page, "work_items:write")).toHaveCount(0);
    await expect(scope(page, "discussions:write")).toBeVisible();
    await expect(scope(page, "discussions:write")).not.toBeChecked();
    // No scope chosen: nothing can be submitted.
    await scope(page, "read").uncheck();
    await expect(tid(page, "dev-create-submit")).toBeDisabled();
    await scope(page, "read").check();

    mock.createReply = () => ({
      status: 403,
      json: { error: { code: "insufficient_role", message: "role cannot grant this scope", request_id: "r" } },
    });
    await tid(page, "dev-create-submit").click();
    await expect(tid(page, "dev-form-error")).toContainText("insufficient_role");
    expect(w.appErrors).toEqual([]);
  });

  test("scopes: an owner or admin is offered audit:read and can create with it", async ({ page }) => {
    const { w, mock } = await setup(page, { admin: true });
    await tid(page, "dev-create-open").click();
    await expect(scope(page, "audit:read")).toBeVisible();
    await scope(page, "audit:read").check();
    await tid(page, "dev-create-submit").click();
    await expect(tid(page, "dev-secret")).toBeVisible();
    expect(JSON.parse(mock.sent[0].body!).scopes).toEqual(["read", "audit:read"]);
    expect(w.appErrors).toEqual([]);
    expect(await w.violations()).toEqual([]);
  });

  test("scopes: both write scopes follow audit:read in order; work_items:write is admin-only and nothing is preselected but read", async ({ page }) => {
    const { w, mock } = await setup(page, { admin: true });
    await tid(page, "dev-create-open").click();
    const ids = await page.locator(`${DEV} input[type="checkbox"][value]`).evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
    expect(ids).toEqual(["read", "runs:cancel", "audit:read", "discussions:write", "work_items:write"]);
    await expect(scope(page, "discussions:write")).not.toBeChecked();
    await expect(scope(page, "work_items:write")).not.toBeChecked();
    await scope(page, "discussions:write").check();
    await scope(page, "work_items:write").check();
    await tid(page, "dev-create-submit").click();
    await expect(tid(page, "dev-secret")).toBeVisible();
    expect(JSON.parse(mock.sent[0].body!).scopes).toEqual(["read", "discussions:write", "work_items:write"]);
    expect(w.appErrors).toEqual([]);
  });

  test("409 account_not_active disables Create and says why", async ({ page }) => {
    const { w, mock } = await setup(page);
    mock.createReply = () => ({
      status: 409,
      json: { error: { code: "account_not_active", message: "denied: account_not_active", request_id: "r" } },
    });
    await create(page, "");
    await expect(tid(page, "dev-form-error")).toContainText("account is not active");
    await expect(tid(page, "dev-create-submit")).toBeDisabled();
    await tid(page, "dev-create-cancel").click();
    await expect(tid(page, "dev-blocked")).toContainText("not active");
    await expect(tid(page, "dev-create-open")).toBeDisabled();
    expect(w.appErrors).toEqual([]);
  });

  test("403 tokens_not_available says API tokens aren't available yet", async ({ page }) => {
    const { w, mock } = await setup(page);
    mock.createReply = () => ({
      status: 403,
      json: { error: { code: "tokens_not_available", message: "API tokens are not yet available", request_id: "r" } },
    });
    await create(page, "");
    await expect(tid(page, "dev-form-error")).toHaveText("API tokens aren't available yet.");
    await expect(tid(page, "dev-create-submit")).toBeDisabled();
    expect(w.appErrors).toEqual([]);
  });

  test("revoke: cancel sends nothing; confirm sends DELETE as JSON without an idempotency key", async ({ page }) => {
    const { w, mock } = await setup(page);
    const first = page.locator(`${DEV} tbody tr`).first();
    await first.getByTestId("dev-revoke").click();
    await page.locator(NO).click();
    expect(mock.sent).toHaveLength(0);

    await first.getByTestId("dev-revoke").click();
    await page.locator(YES).click();
    await expect(page.locator(`${DEV} tbody tr`).first()).toHaveAttribute("data-status", "revoked");
    expect(mock.sent).toHaveLength(1);
    expect(mock.sent[0].method).toBe("DELETE");
    expect(mock.sent[0].path).toBe(`/api/v1/tokens/${LIST_FIXTURE.data[0].id}`);
    expectJsonMutation(mock.sent[0]);
    expect(w.appErrors).toEqual([]);
  });

  test("previews: the dock preview and the alt-tab clone mask the secret while the panel is open", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "phone", "no dock hover or Alt+Tab on a phone");
    await setup(page);
    await create(page, "ci bot");
    const secret = CREATED_NAMED.token as string;
    await expect(tid(page, "dev-secret")).toHaveText(secret);

    await page.locator('.dock-icon[data-app-id="developer"]').hover();
    await page.clock.runFor(1_000);
    const preview = page.locator(".dock-preview");
    await expect(preview.locator(".fulc-window-clone")).toHaveCount(1);
    await expect(preview.locator("[data-secret-node]")).toHaveCount(0);
    await expect(preview.locator("[data-preview-mask]")).toHaveCount(1);
    expect(await preview.evaluate((el) => el.outerHTML)).not.toContain(secret);
    expect(await preview.evaluate((el) => el.textContent)).not.toContain(secret);
    await page.mouse.move(600, 300);

    await page.evaluate(() => {
      const wm = (window as unknown as { FULCWM: { open: (id: string) => void; focus: (id: string) => void } }).FULCWM;
      wm.open("themes");
      wm.focus("developer");
    });
    await page.keyboard.down("Alt");
    await page.keyboard.press("Tab");
    const strip = page.locator(".wm-alttab-overlay");
    await expect(strip.locator(".fulc-window-clone")).toHaveCount(2);
    await expect(strip.locator("[data-secret-node]")).toHaveCount(0);
    await expect(strip.locator("[data-preview-mask]")).toHaveCount(1);
    expect(await strip.evaluate((el) => el.outerHTML)).not.toContain(secret);
    await page.keyboard.up("Alt");
    // The real panel still shows it.
    await expect(tid(page, "dev-secret")).toHaveText(secret);
  });

  test("previews: data-no-preview on a subtree or a whole window shows a neutral placeholder in both clones", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "phone", "no dock hover or Alt+Tab on a phone");
    await setup(page);
    await page.evaluate(() => {
      document.querySelector('#windows-container .fulc-window[data-app-id="developer"] .dev-table-wrap')!.setAttribute("data-no-preview", "");
      (window as unknown as { FULCWM: { open: (id: string) => void } }).FULCWM.open("themes");
      document.querySelector('#windows-container .fulc-window[data-app-id="themes"]')!.setAttribute("data-no-preview", "");
    });
    await page.locator('.dock-icon[data-app-id="developer"]').hover();
    await page.clock.runFor(1_000);
    const preview = page.locator(".dock-preview");
    await expect(preview.locator(".fulc-window-clone")).toHaveCount(1);
    await expect(preview.locator(".dev-table-wrap")).toHaveCount(0);
    await expect(preview.locator("[data-preview-placeholder]")).toHaveCount(1);
    await expect(preview.locator('[data-testid="dev-token-name"]')).toHaveCount(0);
    await page.mouse.move(600, 300);

    await page.keyboard.down("Alt");
    await page.keyboard.press("Tab");
    const strip = page.locator(".wm-alttab-overlay");
    await expect(strip.locator(".fulc-window-clone")).toHaveCount(2);
    await expect(strip.locator(".dev-table-wrap")).toHaveCount(0);
    // one for the developer subtree, one for the whole themes window
    await expect(strip.locator("[data-preview-placeholder]")).toHaveCount(2);
    await page.keyboard.up("Alt");
    // The real windows are untouched.
    await expect(page.locator(`${DEV} .dev-table-wrap`)).toBeVisible();
  });

  test("token names are bidi-isolated in the Name cell, the reveal summary, the confirm and the status", async ({ page }) => {
    await setup(page);
    const name = "\u200Fbot \u202Eevil\u200F";
    const FSI = "\u2068";
    const PDI = "\u2069";
    await create(page, name);
    const summary = tid(page, "dev-reveal-summary");
    await expect(summary.locator("bdi")).toHaveText(name);
    await tid(page, "dev-reveal-done").click();
    const row = page.locator(`${DEV} tbody tr`).first();
    await expect(row.getByTestId("dev-token-name").locator("bdi")).toHaveText(name);
    expect(await row.getByTestId("dev-token-name").locator("bdi").evaluate((el) => getComputedStyle(el).unicodeBidi)).toMatch(/isolate/);
    await row.getByTestId("dev-revoke").click();
    await expect(page.locator("#fulc-modal-overlay .fulc-modal-message")).toContainText(`Revoke ${FSI}${name}${PDI} (`);
    await page.locator(YES).click();
    await expect(tid(page, "dev-status")).toHaveText(`Revoked ${FSI}${name}${PDI}.`);
  });

  test("Revoke all my tokens and Sign out everywhere sit together, each with its own confirm", async ({ page }) => {
    const { w, mock } = await setup(page);
    const bulk = tid(page, "dev-bulk");
    const revokeAll = tid(page, "dev-revoke-all");
    const everywhere = tid(page, "dev-signout-everywhere");
    await expect(revokeAll).toBeVisible();
    await expect(everywhere).toBeVisible();
    // Neighbours inside the list header, in that order.
    expect(await bulk.evaluate((el) => (el.children[0] as HTMLElement).dataset.testid)).toBe("dev-revoke-all");
    expect(await bulk.evaluate((el) => (el.children[1] as HTMLElement).dataset.testid)).toBe("dev-signout-everywhere");
    expect(await tid(page, "dev-list-header").locator(`[data-testid="dev-bulk"]`).count()).toBe(1);

    // Each dialog says what it does not do.
    await revokeAll.click();
    await expect(page.locator("#fulc-modal")).toContainText("does not sign you out");
    await page.locator(NO).click();
    await everywhere.click();
    await expect(page.locator("#fulc-modal")).toContainText("API tokens are not affected");
    await page.locator(NO).click();
    expect(mock.sent).toHaveLength(0);

    await revokeAll.click();
    await page.locator(YES).click();
    await expect(tid(page, "dev-status")).toContainText("Revoked 1 token");
    expect(mock.sent).toHaveLength(1);
    expect(mock.sent[0].path).toBe("/api/v1/tokens/revoke-mine");
    expectJsonMutation(mock.sent[0]);
    expect(w.appErrors).toEqual([]);
  });

  test("Sign out everywhere posts everywhere:true once, wipes storage and shows the sign-in screen", async ({ page }) => {
    const { mock } = await setup(page);
    await page.evaluate(() => {
      sessionStorage.setItem("probe", "1");
      localStorage.setItem("fx:probe:key", "1");
    });
    await recordStorageAtLoad(page);
    await tid(page, "dev-signout-everywhere").click();
    await Promise.all([page.waitForEvent("load"), page.locator(YES).click()]);
    await page.clock.install({ time: new Date("2026-01-01T00:00:01Z") });
    await page.clock.runFor(BOOT_FAST_FORWARD_MS);
    await expect(page.locator("#cloud-login-screen")).toBeVisible();
    expect(mock.sent).toHaveLength(1);
    expect(mock.sent[0].path).toBe("/api/auth/signout");
    expect(JSON.parse(mock.sent[0].body!)).toEqual({ everywhere: true });
    expectJsonMutation(mock.sent[0]);
    expect(await storageAtLoad(page)).toEqual({ local: 0, session: 0 });
  });

  test("the user menu's plain Sign out still sends no everywhere flag", async ({ page }) => {
    const { mock } = await setup(page);
    await page.locator("#taskbar-user").click();
    await Promise.all([page.waitForEvent("load"), page.locator("#taskbar-signout").click()]);
    expect(mock.sent).toHaveLength(1);
    expect(JSON.parse(mock.sent[0].body!)).toEqual({});
  });

  test("layout: create replaces the list in the window; phone is list first with 44px targets and no sideways scroll", async ({ page }, testInfo) => {
    await setup(page);
    const content = page.locator(`${DEV} .dev-app`);
    await expect(tid(page, "dev-list")).toBeVisible();
    expect(await content.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const phone = testInfo.project.name === "phone";
    if (phone) {
      // offsetHeight is layout size: unlike a bounding box it ignores the
      // window's opening scale animation.
      for (const id of ["dev-create-open", "dev-revoke-all", "dev-signout-everywhere"]) {
        expect(await tid(page, id).evaluate((el) => (el as HTMLElement).offsetHeight), id).toBeGreaterThanOrEqual(44);
      }
      expect(await tid(page, "dev-revoke").first().evaluate((el) => (el as HTMLElement).offsetHeight)).toBeGreaterThanOrEqual(44);
    }
    await tid(page, "dev-create-open").click();
    await expect(tid(page, "dev-list")).toHaveCount(0);
    const win = (await content.boundingBox())!;
    const panel = (await tid(page, "dev-create").boundingBox())!;
    expect(panel.width).toBeGreaterThan(win.width - 40);
    if (phone) {
      const vp = page.viewportSize()!;
      expect(win.width).toBeGreaterThanOrEqual(vp.width - 2);
    }
    await tid(page, "dev-create-cancel").click();
    await expect(tid(page, "dev-list")).toBeVisible();
  });

  test("the app source never sets Origin, Sec-Fetch-* or Idempotency-Key, and stays off web storage", async () => {
    const dir = join(SCRIPT_DIR, "..", "apps", "developer");
    const code = ["developer-app.js", "developer-tokens.js"]
      .map((f) => readFileSync(join(dir, f), "utf8"))
      .join("\n")
      .replace(/\/\/.*$/gm, ""); // comments explain the rules and may name them
    expect(code).not.toMatch(/sec-fetch|idempotency|["']origin["']|credentials/i);
    expect(code).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|history\.|location\./);
  });

  test("opening and using the app makes no request other than the token list and identity", async ({ page }) => {
    const paths: string[] = [];
    page.on("request", (r) => {
      const p = new URL(r.url()).pathname;
      if (p.startsWith("/api/v1/") || p === "/api/cloud/auth/me") paths.push(`${r.method()} ${p}`);
    });
    await setup(page);
    expect(paths.filter((p) => p !== "GET /api/cloud/auth/me")).toEqual(["GET /api/v1/tokens"]);
  });
});

// ── live: real apps/web, real Postgres ──────────────────────────────────

const LIVE = process.env.DEVELOPER_LIVE_BASE_URL;

interface Ident {
  id: number;
  email: string;
  login: string;
}

/** A fresh identity (and so a fresh account) per call: the tests share one database and re-run against it. */
function ident(): Ident {
  const id = 900_000_000 + Math.floor(Math.random() * 90_000_000);
  return { id, email: `dev37-${id}@example.test`, login: `dev37-${id}` };
}

async function signInLive(page: Page, who: Ident) {
  await page.goto(`/api/auth/test/callback?githubUserId=${who.id}&email=${who.email}&login=${who.login}`);
  await page.waitForFunction(() => (window as unknown as { currentStep?: string }).currentStep === "DESKTOP", null, {
    timeout: 20_000,
  });
}

test.describe("D#37 WS-F7a: Developer app, tokens (live: real Postgres, next start)", () => {
  test.skip(!LIVE, "DEVELOPER_LIVE_BASE_URL not set -- opt-in, see this file's header comment");
  test.use({ baseURL: LIVE });

  test("owner: create, reveal once, reload -> gone everywhere, list, revoke", async ({ page, context }, testInfo) => {
    const owner = ident();
    await seedAccountStatus({ githubUserId: owner.id, email: owner.email, login: owner.login, status: "active" });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const w = await watch(page);
    const afterCreate: string[] = [];
    let created = false;
    page.on("response", async (res) => {
      if (created && res.url().includes("/api/")) afterCreate.push(await res.text().catch(() => ""));
    });
    await signInLive(page, owner);
    await openDeveloper(page);
    await expect(tid(page, "dev-empty")).toBeVisible();

    const name = `live ${testInfo.project.name} <b>x</b>`;
    const createRes = page.waitForResponse((r) => r.url().endsWith("/api/v1/tokens") && r.request().method() === "POST");
    await tid(page, "dev-create-open").click();
    await expect(scope(page, "audit:read")).toHaveCount(1); // the account owner is an admin
    await page.locator(`${DEV} #dev-name`).fill(name);
    await scope(page, "runs:cancel").check();
    await tid(page, "dev-create-submit").click();
    const createResponse = await createRes;
    const secret = (await createResponse.json()).token as string;
    created = true;
    const sent = await createResponse.request().allHeaders();
    expect(sent["content-type"]).toBe("application/json");
    expect(sent["sec-fetch-site"]).toBe("same-origin");
    expect(sent["idempotency-key"]).toBeUndefined();
    expect(secret).toMatch(/^fxat_/);
    await expect(tid(page, "dev-secret")).toHaveText(secret);
    await tid(page, "dev-copy").click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(secret);
    await tid(page, "dev-reveal-done").click();

    const row = page.locator(`${DEV} tbody tr`).first();
    await expect(row.getByTestId("dev-token-name")).toHaveText(name);
    await expect(row).toContainText("runs:cancel");
    await expect(row).toContainText("Never");
    await expect(row.locator("td").nth(3)).toHaveText("You");
    expect(await browserHolds(page)).not.toContain(secret);

    await page.reload();
    await page.waitForFunction(() => (window as unknown as { currentStep?: string }).currentStep === "DESKTOP");
    await reopenDeveloper(page);
    await expect(page.locator(`${DEV} tbody tr`).first().getByTestId("dev-token-name")).toHaveText(name);
    expect(await browserHolds(page)).not.toContain(secret);
    expect(afterCreate.join("\n")).not.toContain(secret);

    // Revoke it; the row stays, marked revoked.
    await page.locator(`${DEV} tbody tr`).first().getByTestId("dev-revoke").click();
    await page.locator(YES).click();
    await expect(page.locator(`${DEV} tbody tr`).first()).toHaveAttribute("data-status", "revoked");
    expect(await w.violations()).toEqual([]);
    expect(w.appErrors).toEqual([]);
    expect(w.networkLog).toEqual([]);
  });

  test("member: only own tokens, no audit:read, a forced audit:read is refused by the server", async ({ page, browser }) => {
    const owner = ident();
    const member = ident();
    await seedAccountStatus({ githubUserId: owner.id, email: owner.email, login: owner.login, status: "active" });
    await seedMemberOfAccount({
      ownerGithubUserId: owner.id,
      memberGithubUserId: member.id,
      memberEmail: member.email,
      memberLogin: member.login,
    });
    const w = await watch(page);
    await signInLive(page, member);
    await openDeveloper(page);
    await tid(page, "dev-create-open").click();
    await expect(scope(page, "audit:read")).toHaveCount(0);
    await expect(scope(page, "work_items:write")).toHaveCount(0);
    await page.route("**/api/v1/tokens", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const body = JSON.parse(route.request().postData() ?? "{}");
      body.scopes = ["read", "audit:read", "work_items:write"]; // what a tampered client would send
      await route.continue({ postData: JSON.stringify(body) });
    });
    await tid(page, "dev-create-submit").click();
    await expect(tid(page, "dev-form-error")).toContainText("insufficient_role");
    expect(w.appErrors).toEqual([]);
    await page.unroute("**/api/v1/tokens");

    // The member makes a token; the owner then sees it as someone else's.
    await page.locator(`${DEV} #dev-name`).fill("member token");
    await tid(page, "dev-create-submit").click();
    await tid(page, "dev-reveal-done").click();
    await expect(page.locator(`${DEV} tbody tr`)).toHaveCount(1);
    await expect(page.locator(`${DEV} tbody tr td`).nth(3)).toHaveText("You");

    const ownerCtx = await browser.newContext({ baseURL: LIVE });
    const ownerPage = await ownerCtx.newPage();
    await signInLive(ownerPage, owner);
    await openDeveloper(ownerPage);
    const seen = ownerPage.locator(`${DEV} tbody tr`, { hasText: "member token" });
    await expect(seen).toHaveCount(1);
    await expect(seen.locator("td").nth(3)).toHaveText(/^Member [0-9a-f]{8}$/);
    await expect(seen.locator("td").nth(3).locator("span")).toHaveAttribute("title", /^[0-9a-f-]{36}$/);
    await ownerCtx.close();
  });

  test("Revoke all my tokens revokes mine and leaves the session alone", async ({ page }) => {
    const owner = ident();
    await seedAccountStatus({ githubUserId: owner.id, email: owner.email, login: owner.login, status: "active" });
    await signInLive(page, owner);
    await openDeveloper(page);
    for (const n of ["one", "two"]) {
      await create(page, n);
      await tid(page, "dev-reveal-done").click();
    }
    await expect(page.locator(`${DEV} tbody tr[data-status="active"]`)).toHaveCount(2);
    await tid(page, "dev-revoke-all").click();
    await page.locator(YES).click();
    await expect(page.locator(`${DEV} tbody tr[data-status="revoked"]`)).toHaveCount(2);
    await expect(tid(page, "dev-status")).toContainText("Revoked 2 tokens");
    const me = await page.request.get("/api/cloud/auth/me");
    expect(me.status()).toBe(200);
  });

  test("Sign out everywhere ends every session; a plain Sign out ends only its own", async ({ page, browser }) => {
    const owner = ident();
    await seedAccountStatus({ githubUserId: owner.id, email: owner.email, login: owner.login, status: "active" });
    const other = await browser.newContext({ baseURL: LIVE });
    const otherPage = await other.newPage();
    const third = await browser.newContext({ baseURL: LIVE });
    const thirdPage = await third.newPage();
    await signInLive(page, owner);
    await signInLive(otherPage, owner);
    await signInLive(thirdPage, owner);

    // Plain sign-out from the user menu (C15): ends this session only.
    const plainBodies: string[] = [];
    thirdPage.on("request", (r) => r.url().endsWith("/api/auth/signout") && plainBodies.push(r.postData() ?? ""));
    await thirdPage.locator("#taskbar-user").click();
    await Promise.all([thirdPage.waitForEvent("load"), thirdPage.locator("#taskbar-signout").click()]);
    expect(JSON.parse(plainBodies[0])).toEqual({});
    expect((await other.request.get("/api/cloud/auth/me")).status()).toBe(200);
    await third.close();

    await openDeveloper(page);
    await recordStorageAtLoad(page);
    const posts: string[] = [];
    page.on("request", (r) => r.url().endsWith("/api/auth/signout") && posts.push(r.postData() ?? ""));
    await tid(page, "dev-signout-everywhere").click();
    await page.locator(NO).click();
    expect(posts).toHaveLength(0);
    await tid(page, "dev-signout-everywhere").click();
    await Promise.all([page.waitForEvent("load"), page.locator(YES).click()]);
    await expect(page.locator("#cloud-login-screen")).toBeVisible({ timeout: 15_000 });
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0])).toEqual({ everywhere: true });
    expect(await storageAtLoad(page)).toEqual({ local: 0, session: 0 });
    // The other browser context's session is dead too.
    expect((await other.request.get("/api/cloud/auth/me")).status()).toBe(401);
    await other.close();
  });
});
