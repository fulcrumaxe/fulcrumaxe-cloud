// apps/workspace/e2e/developer-webhooks.spec.ts
//
// D#37 WS-F7b (corrections C2, C25, C26): the Developer app's webhooks tab,
// plus the Orchard minimized-thumbnail mask. Two groups of tests live here.
//
//   1. "mocked API" (always runs, desktop + tablet + phone): the built cloud
//      dist served by fixture-server.mjs, with /api/v1/webhook-endpoints
//      answered by page.route() from the repo's contract fixtures
//      (packages/api/fixtures/v1/**) so each test can force a server response
//      (422, 403 ...) and record the exact requests the app sent. The
//      document carries the production CSP and Trusted Types directives, so a
//      sink in the app fails here for real.
//   2. "live" (opt-in, skipped unless DEVELOPER_LIVE_BASE_URL is set): the
//      real apps/web server on real Postgres with the test-auth sign-in. See
//      developer-tokens.spec.ts for the environment it needs. Example:
//        DEVELOPER_LIVE_BASE_URL=http://localhost:4731 \
//          pnpm --filter workspace exec playwright test e2e/developer-webhooks.spec.ts

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";
import { seedAccountStatus, seedMemberOfAccount } from "./seed-account-status.mjs";
import { bootToDesktop, holdClock, stepToDesktop } from "./helpers/boot";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const V1 = join(SCRIPT_DIR, "..", "..", "..", "packages", "api", "fixtures", "v1");
const readFixture = (...p: string[]) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
const ENDPOINTS = readFixture("listWebhookEndpoints", "200-page.json");
const CREATED = readFixture("createWebhookEndpoint", "201-created.json");
const DELIVERIES = readFixture("listWebhookDeliveries", "200-page.json");
const ROTATED = readFixture("rotateWebhookEndpointSecret", "200-rotated.json");
const TESTED = readFixture("testWebhookEndpoint", "200-delivered.json");

const CSP =
  "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
// The dock preview, the alt-tab strip and the Orchard thumbnails clone a
// window's DOM, so scope every locator to the real window.
const DEV = `#windows-container .fulc-window[data-app-id="developer"]`;
const YES = "#fulc-modal-yes";
const NO = "#fulc-modal-no";
const EP_ID = ENDPOINTS.data[0].id as string;

// ── shared helpers ──────────────────────────────────────────────────────

interface Watch {
  appErrors: string[];
  networkLog: string[];
  violations: () => Promise<string[]>;
}

async function watch(page: Page): Promise<Watch> {
  const w = { appErrors: [] as string[], networkLog: [] as string[] };
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    (msg.text().startsWith("Failed to load resource") ? w.networkLog : w.appErrors).push(msg.text());
  });
  page.on("pageerror", (err) => w.appErrors.push(`pageerror: ${err.message}`));
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

async function reopenDeveloper(page: Page) {
  await page.evaluate(() => (window as unknown as { FULCWM: { open: (id: string) => void } }).FULCWM.open("developer"));
  await expect(page.locator(DEV)).toBeVisible();
}

async function openDeveloper(page: Page) {
  await page.locator('.dock-icon[data-app-id="developer"]').click();
  await expect(page.locator(DEV)).toBeVisible();
  await expect(page.locator(DEV)).not.toHaveClass(/opening/);
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

const tid = (page: Page, id: string) => page.locator(`${DEV} [data-testid="${id}"]`);

async function openWebhooksTab(page: Page) {
  await tid(page, "dev-tab-webhooks").click();
  await expect(tid(page, "dev-wh-app")).toBeVisible();
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
  gets: string[];
  endpoints: Array<Record<string, unknown>>;
  deliveries: Array<Record<string, unknown>>;
  createReply?: (body: Record<string, unknown>) => { status: number; json: unknown } | undefined;
  testReply?: { status: number; json: unknown; headers?: Record<string, string> };
  listStatus?: number;
}

async function record(route: Route): Promise<Sent> {
  const req = route.request();
  return { method: req.method(), path: new URL(req.url()).pathname, headers: await req.allHeaders(), body: req.postData() };
}

async function mockApi(page: Page): Promise<Mock> {
  const mock: Mock = {
    sent: [],
    gets: [],
    endpoints: structuredClone(ENDPOINTS.data),
    deliveries: structuredClone(DELIVERIES.data),
  };
  await page.route("**/api/v1/tokens**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [], next_cursor: null }) })
  );
  await page.route("**/api/v1/webhook-endpoints**", async (route) => {
    const req = await record(route);
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (req.method === "GET") {
      mock.gets.push(req.path);
      if (req.path.endsWith("/deliveries")) return json(200, { data: mock.deliveries, next_cursor: null });
      if (mock.listStatus) {
        return json(mock.listStatus, { error: { code: "insufficient_role", message: "owner or admin only", request_id: "r" } });
      }
      return json(200, { data: mock.endpoints, next_cursor: null });
    }
    mock.sent.push(req);
    if (req.method === "POST" && req.path === "/api/v1/webhook-endpoints") {
      const body = JSON.parse(req.body ?? "{}");
      const forced = mock.createReply?.(body);
      if (forced) return json(forced.status, forced.json);
      const row: Record<string, unknown> = { ...CREATED, url: body.url, event_types: body.event_types };
      delete row.secret;
      mock.endpoints.unshift(row);
      return json(201, { ...row, secret: CREATED.secret });
    }
    if (req.method === "POST" && req.path.endsWith("/rotate-secret")) return json(200, ROTATED);
    if (req.method === "POST" && req.path.endsWith("/test")) {
      return mock.testReply
        ? route.fulfill({ status: mock.testReply.status, contentType: "application/json", headers: mock.testReply.headers, body: JSON.stringify(mock.testReply.json) })
        : json(200, TESTED);
    }
    if (req.method === "POST" && req.path.endsWith("/redeliver")) return json(202, { status: "queued" });
    if (req.method === "PATCH") {
      const id = req.path.split("/").pop();
      const ep = mock.endpoints.find((e) => e.id === id)!;
      Object.assign(ep, JSON.parse(req.body ?? "{}"), { disabled_reason: null });
      return json(200, ep);
    }
    return route.fulfill({ status: 204 });
  });
  return mock;
}

async function setup(page: Page) {
  const w = await watch(page);
  await withCsp(page);
  const mock = await mockApi(page);
  await bootMocked(page);
  await openDeveloper(page);
  return { w, mock };
}

async function setupOnTab(page: Page) {
  const s = await setup(page);
  await openWebhooksTab(page);
  await expect(tid(page, "dev-wh-table")).toBeVisible();
  return s;
}

function expectJsonMutation(s: Sent) {
  expect(s.headers["content-type"]).toBe("application/json");
  expect(s.headers["idempotency-key"]).toBeUndefined();
}

async function addEndpoint(page: Page, url: string, events = ["pr.opened", "work_item.needs_human"]) {
  await tid(page, "dev-wh-add-open").click();
  await page.locator(`${DEV} #dev-wh-url`).fill(url);
  for (const ev of events) await page.locator(`${DEV} input[type="checkbox"][value="${ev}"]`).check();
  await tid(page, "dev-wh-add-submit").click();
}

test.describe("D#37 WS-F7b: Developer app, webhooks (mocked API)", () => {
  test("the Webhooks tab loads lazily; URLs are plain text, never links", async ({ page }) => {
    const { w, mock } = await setup(page);
    // Opening the app fetches nothing for webhooks.
    expect(mock.gets).toEqual([]);
    await expect(tid(page, "dev-tab-tokens")).toHaveAttribute("aria-selected", "true");
    await openWebhooksTab(page);
    await expect(tid(page, "dev-wh-table")).toBeVisible();
    expect(mock.gets).toEqual(["/api/v1/webhook-endpoints"]);

    const row = page.locator(`${DEV} [data-testid="dev-wh-table"] tbody tr`);
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId("dev-wh-url")).toHaveText("https://example.com/hooks/fulcrumaxe");
    await expect(row).toContainText("pr.opened");
    await expect(row).toContainText("work_item.needs_human");
    await expect(row.getByTestId("dev-wh-state")).toHaveText("Active");
    await expect(page.locator(`${DEV} [data-testid="dev-wh-app"] a`)).toHaveCount(0);
    expect(await w.violations()).toEqual([]);
    expect(w.appErrors).toEqual([]);

    // Back to tokens: the tokens tab still works and nothing new is fetched.
    await tid(page, "dev-tab-tokens").click();
    await expect(tid(page, "dev-empty")).toBeVisible();
    expect(mock.gets).toEqual(["/api/v1/webhook-endpoints"]);
  });

  test("add endpoint: JSON write, secret revealed once, then gone from DOM, storage and later responses", async ({ page, context }, testInfo) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const { w, mock } = await setupOnTab(page);
    const secret = CREATED.secret as string;
    const afterCreate: string[] = [];
    let created = false;
    page.on("response", async (res) => {
      if (created && res.url().includes("/api/") && res.request().method() === "GET") afterCreate.push(await res.text().catch(() => ""));
    });

    await tid(page, "dev-wh-add-open").click();
    // The submit stays off until a URL and at least one event are chosen.
    await expect(tid(page, "dev-wh-add-submit")).toBeDisabled();
    await page.locator(`${DEV} #dev-wh-url`).fill("  https://hooks.example.org/in  ");
    await page.locator(`${DEV} input[type="checkbox"][value="pr.opened"]`).check();
    await expect(tid(page, "dev-wh-add-submit")).toBeEnabled();
    await page.locator(`${DEV} input[type="checkbox"][value="budget.exhausted"]`).check();
    await tid(page, "dev-wh-add-submit").click();

    await expect(tid(page, "dev-wh-secret")).toHaveText(secret);
    await expect(tid(page, "dev-wh-secret")).toHaveAttribute("data-secret-node", "1");
    await expect(tid(page, "dev-wh-reveal-warning")).toContainText("only once");
    created = true;
    expect(mock.sent).toHaveLength(1);
    expect(mock.sent[0].method).toBe("POST");
    expect(JSON.parse(mock.sent[0].body!)).toEqual({ url: "https://hooks.example.org/in", event_types: ["pr.opened", "budget.exhausted"] });
    expectJsonMutation(mock.sent[0]);

    await tid(page, "dev-wh-copy").click();
    await expect(tid(page, "dev-wh-copy-note")).toContainText("Copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(secret);

    if (testInfo.project.name !== "phone") {
      await page.locator('.dock-icon[data-app-id="developer"]').hover();
      await page.clock.runFor(1_000);
      const preview = page.locator(".dock-preview");
      await expect(preview.locator(".fulc-window-clone")).toHaveCount(1);
      await expect(preview.locator("[data-secret-node]")).toHaveCount(0);
      expect(await preview.evaluate((el) => el.outerHTML)).not.toContain(secret);
      await page.mouse.move(600, 300);
    }

    await tid(page, "dev-wh-reveal-done").click();
    await expect(tid(page, "dev-wh-reveal")).toHaveCount(0);
    await expect(page.locator("[data-secret-node]")).toHaveCount(0);
    await expect(page.locator(`${DEV} [data-testid="dev-wh-table"] tbody tr`).first().getByTestId("dev-wh-url")).toHaveText(
      "https://hooks.example.org/in"
    );
    expect(await browserHolds(page)).not.toContain(secret);

    await page.reload();
    await stepToDesktop(page);
    await reopenDeveloper(page);
    await openWebhooksTab(page);
    await expect(page.locator(`${DEV} [data-testid="dev-wh-table"] tbody tr`).first()).toContainText("hooks.example.org");
    expect(await browserHolds(page)).not.toContain(secret);
    expect(afterCreate.join("\n")).not.toContain(secret);
    expect(await w.violations()).toEqual([]);
    expect(w.appErrors).toEqual([]);
    expect(w.networkLog).toEqual([]);
  });

  test("a 422 invalid_webhook_url shows its reason class inline and keeps the form", async ({ page }) => {
    const { w, mock } = await setupOnTab(page);
    for (const [cls, text] of [
      ["scheme", "Only https:// URLs are accepted."],
      ["blocked_address", "private or reserved"],
      ["dns_failed", "could not be resolved"],
    ] as const) {
      mock.createReply = () => ({
        status: 422,
        json: { error: { code: "invalid_webhook_url", message: `invalid webhook url (${cls})`, request_id: "r" }, details: [{ path: "url", code: cls }] },
      });
      await addEndpoint(page, "http://bad.example/", ["pr.opened"]);
      await expect(tid(page, "dev-wh-url-error")).toContainText(text);
      await expect(tid(page, "dev-wh-url-error")).toContainText(`(${cls})`);
      await expect(tid(page, "dev-wh-secret")).toHaveCount(0);
      await expect(page.locator(`${DEV} #dev-wh-url`)).toHaveValue("http://bad.example/");
      await tid(page, "dev-wh-add-cancel").click();
    }
    expect(w.appErrors).toEqual([]);
    expect(await w.violations()).toEqual([]);
  });

  test("a full plan (409 endpoint_limit_reached) disables Add and says why", async ({ page }) => {
    const { w, mock } = await setupOnTab(page);
    mock.createReply = () => ({
      status: 409,
      json: { error: { code: "endpoint_limit_reached", message: "webhook endpoint limit reached for this plan", request_id: "r" } },
    });
    await addEndpoint(page, "https://hooks.example.org/in", ["pr.opened"]);
    await expect(tid(page, "dev-wh-form-error")).toContainText("limit is reached");
    await expect(tid(page, "dev-wh-add-submit")).toBeDisabled();
    await tid(page, "dev-wh-add-cancel").click();
    await expect(tid(page, "dev-wh-blocked")).toContainText("limit");
    await expect(tid(page, "dev-wh-add-open")).toBeDisabled();
    expect(w.appErrors).toEqual([]);
  });

  test("a member sees who manages webhooks instead of a list", async ({ page }) => {
    const w = await watch(page);
    await withCsp(page);
    const mock = await mockApi(page);
    mock.listStatus = 403;
    await bootMocked(page);
    await openDeveloper(page);
    await openWebhooksTab(page);
    await expect(tid(page, "dev-wh-forbidden")).toContainText("owners and admins");
    await expect(tid(page, "dev-wh-add-open")).toBeDisabled();
    expect(w.appErrors).toEqual([]);
  });

  test("delivery log: time, event, status, code and error class; Redeliver and Send test event", async ({ page }) => {
    const { w, mock } = await setupOnTab(page);
    await tid(page, "dev-wh-manage").click();
    await expect(tid(page, "dev-wh-detail-url")).toHaveText("https://example.com/hooks/fulcrumaxe");
    const rows = page.locator(`${DEV} [data-testid="dev-wh-log"] tbody tr`);
    await expect(rows).toHaveCount(2);
    expect(mock.gets).toContain(`/api/v1/webhook-endpoints/${EP_ID}/deliveries`);

    const headers = await page.locator(`${DEV} [data-testid="dev-wh-log"] thead th`).allTextContents();
    expect(headers).toEqual(["Time", "Event", "Status", "Code", "Error class", "Attempts", ""]);
    expect(headers.join(" ").toLowerCase()).not.toMatch(/body|response|payload/);
    await expect(rows.nth(0).locator("time")).toHaveAttribute("datetime", "2026-09-18T12:00:00.000Z");
    await expect(rows.nth(0)).toContainText("pr.opened");
    await expect(rows.nth(0)).toContainText("succeeded");
    await expect(rows.nth(0)).toContainText("200");
    await expect(rows.nth(1)).toContainText("budget.exhausted");
    await expect(rows.nth(1)).toContainText("dead");
    await expect(rows.nth(1)).toContainText("timeout");

    await rows.nth(1).getByTestId("dev-wh-redeliver").click();
    await expect(tid(page, "dev-wh-status")).toContainText("Queued for redelivery");
    const redeliver = mock.sent.at(-1)!;
    expect(redeliver.method).toBe("POST");
    expect(redeliver.path).toBe(`/api/v1/webhook-endpoints/deliveries/${DELIVERIES.data[1].id}/redeliver`);
    expectJsonMutation(redeliver);

    await tid(page, "dev-wh-test").click();
    await expect(tid(page, "dev-wh-status")).toHaveText("Test event delivered (HTTP 200).");
    const test1 = mock.sent.at(-1)!;
    expect(test1.path).toBe(`/api/v1/webhook-endpoints/${EP_ID}/test`);
    expectJsonMutation(test1);

    mock.testReply = { status: 200, json: { delivered: false, status_code: 500, error_class: "http_status" } };
    await tid(page, "dev-wh-test").click();
    await expect(tid(page, "dev-wh-status")).toHaveText("Test event failed (http_status, HTTP 500).");
    expect(w.appErrors).toEqual([]);
  });

  test("a 429 on Send test event counts down from Retry-After and keeps the button off until it ends", async ({ page }) => {
    const { w, mock } = await setupOnTab(page);
    await tid(page, "dev-wh-manage").click();
    mock.testReply = { status: 429, json: { error: { code: "rate_limited", message: "SECRET-SERVICE-TEXT", request_id: "r" } }, headers: { "Retry-After": "3" } };
    await holdClock(page); // the countdown is page time: only the runFor calls below move it, however slow the machine is
    await tid(page, "dev-wh-test").click();
    await expect(tid(page, "dev-wh-status")).toHaveText("Could not send the test event. Too many tries. Try again in 3 seconds.");
    await expect(tid(page, "dev-wh-test")).toBeDisabled();
    await page.clock.runFor(2_000);
    await expect(tid(page, "dev-wh-status")).toHaveText("Could not send the test event. Too many tries. Try again in 1 second.");
    expect(mock.sent.filter((s) => s.path.endsWith("/test"))).toHaveLength(1);
    await page.clock.runFor(1_000);
    await expect(tid(page, "dev-wh-test")).toBeEnabled();
    await expect(tid(page, "dev-wh-status")).toHaveText("");
    mock.testReply = undefined;
    await tid(page, "dev-wh-test").click();
    await expect(tid(page, "dev-wh-status")).toHaveText("Test event delivered (HTTP 200).");
    expect(await page.locator("body").innerText()).not.toMatch(/SECRET-SERVICE-TEXT|undefined|NaN/);
    expect(w.appErrors).toEqual([]);
  });

  test("rotate secret: the confirm explains the 24 h overlap; the new secret is shown once with the old one's end time", async ({ page }) => {
    const { w, mock } = await setupOnTab(page);
    await tid(page, "dev-wh-manage").click();
    await expect(tid(page, "dev-wh-rotate-note")).toContainText("24 hours");

    await tid(page, "dev-wh-rotate").click();
    await expect(page.locator("#fulc-modal")).toContainText("24 hours");
    await page.locator(NO).click();
    expect(mock.sent).toHaveLength(0);

    await tid(page, "dev-wh-rotate").click();
    await page.locator(YES).click();
    const secret = ROTATED.secret as string;
    await expect(tid(page, "dev-wh-secret")).toHaveText(secret);
    await expect(tid(page, "dev-wh-secret")).toHaveAttribute("data-secret-node", "1");
    await expect(tid(page, "dev-wh-overlap")).toContainText("24 hours");
    await expect(tid(page, "dev-wh-overlap").locator("time")).toHaveAttribute("datetime", ROTATED.previous_secret_expires_at);
    expect(mock.sent).toHaveLength(1);
    expect(mock.sent[0].path).toBe(`/api/v1/webhook-endpoints/${EP_ID}/rotate-secret`);
    expectJsonMutation(mock.sent[0]);

    await tid(page, "dev-wh-reveal-done").click();
    await expect(page.locator("[data-secret-node]")).toHaveCount(0);
    await expect(tid(page, "dev-wh-detail")).toBeVisible();
    expect(await browserHolds(page)).not.toContain(secret);
    expect(w.appErrors).toEqual([]);
  });

  test("an auto-disabled endpoint shows its reason; Re-enable sends PATCH status active as JSON", async ({ page }) => {
    const w = await watch(page);
    await withCsp(page);
    const mock = await mockApi(page);
    Object.assign(mock.endpoints[0], { status: "disabled", disabled_reason: "failing" });
    await bootMocked(page);
    await openDeveloper(page);
    await openWebhooksTab(page);

    const row = page.locator(`${DEV} [data-testid="dev-wh-table"] tbody tr`).first();
    await expect(row.getByTestId("dev-wh-state")).toHaveText("Disabled");
    await expect(row.getByTestId("dev-wh-reason")).toContainText("every recent delivery failed");
    await row.getByTestId("dev-wh-reenable").click();
    await expect(row.getByTestId("dev-wh-state")).toHaveText("Active");
    await expect(row.getByTestId("dev-wh-reenable")).toHaveCount(0);
    await expect(tid(page, "dev-wh-status")).toContainText("re-enabled");
    expect(mock.sent).toHaveLength(1);
    expect(mock.sent[0].method).toBe("PATCH");
    expect(mock.sent[0].path).toBe(`/api/v1/webhook-endpoints/${EP_ID}`);
    expect(JSON.parse(mock.sent[0].body!)).toEqual({ status: "active" });
    expectJsonMutation(mock.sent[0]);
    expect(w.appErrors).toEqual([]);
  });

  test("a disabled endpoint's detail view offers Re-enable and no test event", async ({ page }) => {
    await withCsp(page);
    await watch(page);
    const mock = await mockApi(page);
    Object.assign(mock.endpoints[0], { status: "disabled", disabled_reason: "failing" });
    await bootMocked(page);
    await openDeveloper(page);
    await openWebhooksTab(page);
    await tid(page, "dev-wh-manage").click();
    await expect(tid(page, "dev-wh-detail-state")).toContainText("Disabled");
    await expect(tid(page, "dev-wh-test")).toBeDisabled();
    await tid(page, "dev-wh-reenable").click();
    await expect(tid(page, "dev-wh-detail-state")).toContainText("Active");
    await expect(tid(page, "dev-wh-test")).toBeEnabled();
  });

  test("the tabs refuse to switch while a secret is on screen", async ({ page }) => {
    await setupOnTab(page);
    await addEndpoint(page, "https://hooks.example.org/in", ["pr.opened"]);
    await expect(tid(page, "dev-wh-secret")).toBeVisible();
    await tid(page, "dev-tab-tokens").click();
    await expect(tid(page, "dev-tab-note")).toContainText("Done");
    await expect(tid(page, "dev-tab-webhooks")).toHaveAttribute("aria-selected", "true");
    await expect(tid(page, "dev-wh-secret")).toBeVisible();
    await tid(page, "dev-wh-reveal-done").click();
    await tid(page, "dev-tab-tokens").click();
    await expect(tid(page, "dev-tab-tokens")).toHaveAttribute("aria-selected", "true");
    await expect(tid(page, "dev-tab-note")).toHaveText("");
  });

  test("endpoint URLs are bidi-isolated and never parsed as markup", async ({ page }) => {
    const w = await watch(page);
    await withCsp(page);
    const mock = await mockApi(page);
    const url = "https://x.example/‮evil<b>x</b>";
    mock.endpoints[0].url = url;
    await bootMocked(page);
    await openDeveloper(page);
    await openWebhooksTab(page);
    const cell = page.locator(`${DEV} [data-testid="dev-wh-table"] tbody tr`).first().getByTestId("dev-wh-url");
    await expect(cell.locator("bdi")).toHaveText(url);
    expect(await cell.locator("bdi").evaluate((el) => getComputedStyle(el).unicodeBidi)).toMatch(/isolate/);
    expect(await cell.locator("b").count()).toBe(0);
    await tid(page, "dev-wh-manage").click();
    await tid(page, "dev-wh-rotate").click();
    await expect(page.locator("#fulc-modal-overlay .fulc-modal-message")).toContainText(`⁨${url}⁩`);
    await page.locator(NO).click();
    expect(w.appErrors).toEqual([]);
  });

  test("layout: the add flow replaces the list; phone has 44px targets and no sideways scroll", async ({ page }, testInfo) => {
    await setupOnTab(page);
    const content = tid(page, "dev-wh-app");
    expect(await content.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const phone = testInfo.project.name === "phone";
    if (phone) {
      for (const id of ["dev-tab-tokens", "dev-tab-webhooks", "dev-wh-add-open", "dev-wh-manage"]) {
        expect(await tid(page, id).evaluate((el) => (el as HTMLElement).offsetHeight), id).toBeGreaterThanOrEqual(44);
      }
    }
    await tid(page, "dev-wh-add-open").click();
    await expect(tid(page, "dev-wh-list")).toHaveCount(0);
    const win = (await content.boundingBox())!;
    const panel = (await tid(page, "dev-wh-add").boundingBox())!;
    expect(panel.width).toBeGreaterThan(win.width - 40);
    if (phone) expect(win.width).toBeGreaterThanOrEqual(page.viewportSize()!.width - 2);
    expect(await content.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await tid(page, "dev-wh-add-cancel").click();
    await tid(page, "dev-wh-manage").click();
    expect(await content.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    if (phone) {
      expect(await tid(page, "dev-wh-redeliver").first().evaluate((el) => (el as HTMLElement).offsetHeight)).toBeGreaterThanOrEqual(44);
    }
  });

  test("the webhooks source never touches storage, history, innerHTML or a duplicate-suppression header", async () => {
    const dir = join(SCRIPT_DIR, "..", "apps", "developer");
    const code = ["developer-app.js", "developer-webhooks.js"]
      .map((f) => readFileSync(join(dir, f), "utf8"))
      .join("\n")
      .replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/sec-fetch|idempotency|["']origin["']|credentials/i);
    expect(code).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|history\.|location\./);
    expect(code).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|srcdoc|createContextualFragment|\.href\b|<a[ >]/);
  });
});

test.describe("D#37 WS-F7b: Orchard minimized thumbnail masks the secret (#216 review, Low)", () => {
  test("a secret revealed in a window that is then minimized is absent from the Orchard thumbnail", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "phone", "the Orchard dock is a desktop and tablet surface");
    const w = await watch(page);
    await withCsp(page);
    await mockApi(page);
    await bootMocked(page);
    // Apply the theme through the Themes app, as a person would.
    await page.evaluate(() => (window as unknown as { FULCWM: { open: (id: string) => void } }).FULCWM.open("themes"));
    const themes = page.locator('.fulc-window[data-app-id="themes"]');
    await themes.locator('.theme-card[data-experience-id="orchard"] .theme-card-apply').click();
    await page.waitForFunction(() => document.body.dataset.heritage === "orchard");
    await page.evaluate(() => (window as unknown as { FULCWM: { close: (id: string) => void } }).FULCWM.close("themes"));
    await expect(page.locator("#orchard-dock")).toBeVisible();
    await reopenDeveloper(page);
    await expect(page.locator(DEV)).not.toHaveClass(/opening/);
    await openWebhooksTab(page);
    await addEndpoint(page, "https://hooks.example.org/in", ["pr.opened"]);
    const secret = CREATED.secret as string;
    await expect(tid(page, "dev-wh-secret")).toHaveText(secret);

    // Let the dock take a snapshot of the open window (it does so every 2 s),
    // then minimize it: the thumbnail is built from that snapshot.
    await page.clock.runFor(2_500);
    await page.evaluate(() => (window as unknown as { FULCWM: { minimize: (id: string) => void } }).FULCWM.minimize("developer"));
    await page.clock.runFor(1_000);
    const item = page.locator('.orchard-dock-min-item[data-app-id="developer"]');
    await expect(item).toHaveCount(1);
    await expect(item.locator(".orchard-dock-min-clone")).toHaveCount(1); // a real thumbnail, not the icon fallback
    await expect(item.locator("[data-secret-node]")).toHaveCount(0);
    await expect(item.locator("[data-preview-mask]")).toHaveCount(1);
    expect(await item.evaluate((el) => el.outerHTML)).not.toContain(secret);
    expect(await item.evaluate((el) => el.textContent)).not.toContain(secret);
    expect(await w.violations()).toEqual([]);
  });
});

// ── live: real apps/web, real Postgres ──────────────────────────────────

const LIVE = process.env.DEVELOPER_LIVE_BASE_URL;

interface Ident {
  id: number;
  email: string;
  login: string;
}

function ident(): Ident {
  const id = 900_000_000 + Math.floor(Math.random() * 90_000_000);
  return { id, email: `dev37wh-${id}@example.test`, login: `dev37wh-${id}` };
}

async function signInLive(page: Page, who: Ident) {
  await page.goto(`/api/auth/test/callback?githubUserId=${who.id}&email=${who.email}&login=${who.login}`);
  await page.waitForFunction(() => (window as unknown as { currentStep?: string }).currentStep === "DESKTOP", null, {
    timeout: 20_000,
  });
}

test.describe("D#37 WS-F7b: Developer app, webhooks (live: real Postgres, next start)", () => {
  test.skip(!LIVE, "DEVELOPER_LIVE_BASE_URL not set -- opt-in, see this file's header comment");
  test.use({ baseURL: LIVE });

  test("owner: 422 reason class, add, reveal once, reload -> gone, rotate, test event, re-enable", async ({ page, context }) => {
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
    await openWebhooksTab(page);
    await expect(tid(page, "dev-wh-empty")).toBeVisible();

    // A real 422 from the real validator.
    await addEndpoint(page, "http://example.com/plain", ["pr.opened"]);
    await expect(tid(page, "dev-wh-url-error")).toContainText("(scheme)");
    await tid(page, "dev-wh-add-cancel").click();

    const createRes = page.waitForResponse((r) => r.url().endsWith("/api/v1/webhook-endpoints") && r.request().method() === "POST");
    await addEndpoint(page, "https://example.com/hooks/live", ["pr.opened", "budget.exhausted"]);
    const createResponse = await createRes;
    const secret = (await createResponse.json()).secret as string;
    created = true;
    const sent = await createResponse.request().allHeaders();
    expect(sent["content-type"]).toBe("application/json");
    expect(sent["sec-fetch-site"]).toBe("same-origin");
    expect(sent["idempotency-key"]).toBeUndefined();
    expect(secret).toMatch(/^whsec_/);
    await expect(tid(page, "dev-wh-secret")).toHaveText(secret);
    await tid(page, "dev-wh-copy").click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(secret);
    await tid(page, "dev-wh-reveal-done").click();
    await expect(page.locator(`${DEV} [data-testid="dev-wh-table"] tbody tr`)).toHaveCount(1);
    expect(await browserHolds(page)).not.toContain(secret);

    await page.reload();
    await page.waitForFunction(() => (window as unknown as { currentStep?: string }).currentStep === "DESKTOP");
    await reopenDeveloper(page);
    await openWebhooksTab(page);
    await expect(page.locator(`${DEV} [data-testid="dev-wh-table"] tbody tr`)).toHaveCount(1);
    expect(await browserHolds(page)).not.toContain(secret);
    expect(afterCreate.join("\n")).not.toContain(secret);

    await tid(page, "dev-wh-manage").click();
    await tid(page, "dev-wh-rotate").click();
    await page.locator(YES).click();
    const rotated = await tid(page, "dev-wh-secret").textContent();
    expect(rotated).toMatch(/^whsec_/);
    expect(rotated).not.toBe(secret);
    await expect(tid(page, "dev-wh-overlap")).toContainText("24 hours");
    await tid(page, "dev-wh-reveal-done").click();
    expect(await browserHolds(page)).not.toContain(rotated!);

    // The test event goes out for real; whatever the destination answers, the
    // app reports an outcome and never a response body.
    await tid(page, "dev-wh-test").click();
    await expect(tid(page, "dev-wh-status")).toContainText(/^Test event (delivered|failed)/, { timeout: 20_000 });
    expect(await w.violations()).toEqual([]);
    expect(w.appErrors).toEqual([]);
  });

  test("member: webhooks are for owners and admins", async ({ page }) => {
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
    await openWebhooksTab(page);
    await expect(tid(page, "dev-wh-forbidden")).toBeVisible();
    await expect(tid(page, "dev-wh-add-open")).toBeDisabled();
    expect(w.appErrors).toEqual([]);
  });
});
