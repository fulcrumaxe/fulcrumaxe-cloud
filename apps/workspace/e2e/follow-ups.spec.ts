// apps/workspace/e2e/follow-ups.spec.ts
//
// D#483 S5-b2d-2c (C28-2c-2): the Follow-ups list on the Pipeline item card and the Roles app's "Follow-ups become their own items" switch. The built
// cloud dist is served by fixture-server.mjs; the API is a small stateful fake (page.route) built on the committed fixtures, so a change survives a
// reload. What the server decides (who may make an item, the audit row, the replay, the closed parent) is proved against real Postgres in
// packages/api/test/followUps.test.ts; here the subject is the page: real clicks, the one request each action sends, every state, and no
// `null`, `undefined` or `NaN` on screen.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";
import { bootToDesktop, waitForDesktop } from "./helpers/boot";

const V1 = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "api", "fixtures", "v1");
const fx = (...p: string[]) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
const REPOS = fx("listRepos", "200-page.json");
const DIALS = fx("getDecisionSettings", "200-ok.json");
const ASK = fx("getAskSettings", "200-ok.json");
const LIST = fx("listWorkItems", "200-page.json");
const TIMELINE = fx("getWorkItemTimeline", "200-ok.json");

const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const NEVER = /undefined|null|NaN|\[object|[a-z]+_[a-z]+/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const wm = (page: Page, app: string, act: "open" | "close") => page.evaluate(([a, id]) => (window as unknown as { FULCWM: Record<string, (id: string) => void> }).FULCWM[a!](id!), [act, app]);

interface Write {
  method: string;
  path: string;
  body: unknown;
  key: string | undefined;
}

// ---- Roles: the Autonomy switch ----
const RWIN = `#windows-container .fulc-window[data-app-id="roles"]`;
const rt = (page: Page, id: string) => page.locator(`${RWIN} [data-testid="${id}"]`);

async function bootRoles(page: Page, over: { canChange?: boolean; failPut?: number } = {}) {
  const w = { canChange: over.canChange ?? true, children: true, writes: [] as Write[] };
  await page.route("**/api/v1/account/**", (route) => json(route, 404, { error: { code: "not_found", message: "no" } }));
  await page.route("**/api/v1/repos**", async (route) => {
    const m = new URL(route.request().url()).pathname.match(/^\/api\/v1\/repos\/([^/]+)\/(.+)$/);
    if (!m) return json(route, 200, REPOS);
    const method = route.request().method();
    if (m[2] === "decision-settings") return json(route, 200, { ...DIALS, can_change: w.canChange });
    if (m[2] === "ask-settings") return json(route, 200, { ...ASK, can_change: w.canChange });
    if (m[2] === "follow-ups/setting") {
      if (method === "PUT") {
        const body = route.request().postDataJSON();
        w.writes.push({ method, path: m[2], body, key: route.request().headers()["idempotency-key"] });
        if (over.failPut) return json(route, over.failPut, { error: { code: "insufficient_role", message: "server text that must never be shown" } });
        w.children = body.children;
      }
      return json(route, 200, { children: w.children, default: w.writes.length === 0 });
    }
    return json(route, 200, { data: [] });
  });
  await bootToDesktop(page);
  await openRoles(page);
  return w;
}
async function openRoles(page: Page) {
  await wm(page, "roles", "open");
  await expect(page.locator(RWIN)).toBeVisible();
  await rt(page, "roles-tab-autonomy").click();
  await expect(rt(page, "lim-rows")).toBeVisible();
}
const followRow = (page: Page) => page.locator(`${RWIN} [data-testid="lim-row"][data-row="follow"]`);

test.describe("D#483 S5-b2d-2c: the Follow-ups switch in Roles", () => {
  test("toggles off, reloads to the same value, toggles back; each change is one keyed request", async ({ page }) => {
    const w = await bootRoles(page);
    const row = followRow(page);
    const box = row.getByTestId("lim-follow-switch");
    await expect(row.getByTestId("lim-follow-value")).toHaveText("Now: On");
    await expect(box).toBeChecked();
    await expect(box).toBeEnabled();
    await expect(row.getByTestId("lim-follow-help")).toHaveText("When this is off, follow-ups stay as notes on the item.");

    await box.uncheck();
    await expect(row.getByTestId("lim-follow-value")).toHaveText("Now: Off");
    expect(w.writes).toHaveLength(1);
    expect(w.writes[0]).toMatchObject({ method: "PUT", path: "follow-ups/setting", body: { children: false } });
    expect(w.writes[0]!.key).toMatch(UUID);

    await page.reload();
    await waitForDesktop(page);
    await openRoles(page);
    await expect(followRow(page).getByTestId("lim-follow-value")).toHaveText("Now: Off");
    await expect(followRow(page).getByTestId("lim-follow-switch")).not.toBeChecked();

    await followRow(page).getByTestId("lim-follow-switch").check();
    await expect(followRow(page).getByTestId("lim-follow-value")).toHaveText("Now: On");
    expect(w.writes.map((x) => (x.body as { children: boolean }).children)).toEqual([false, true]);
    expect(w.writes[1]!.key).not.toBe(w.writes[0]!.key);
    expect(await followRow(page).innerText()).not.toMatch(NEVER);
  });

  test("a member sees it disabled with the admin-only sentence and sends nothing", async ({ page }) => {
    const w = await bootRoles(page, { canChange: false });
    const row = followRow(page);
    await expect(row.getByTestId("lim-follow-switch")).toBeDisabled();
    await expect(row.getByTestId("lim-follow-switch")).toBeChecked();
    await expect(row.getByTestId("lim-follow-help")).toContainText("Only owners and admins can change these settings.");
    expect(w.writes).toEqual([]);
  });

  test("a refused change shows a fixed sentence, never the server's text, and the box keeps what the server holds", async ({ page }) => {
    const w = await bootRoles(page, { failPut: 403 });
    const row = followRow(page);
    // click(), not uncheck(): uncheck() would click again because the box (correctly) snaps back.
    await row.getByTestId("lim-follow-switch").click();
    await expect(row.getByTestId("lim-error")).toHaveText("Only owners and admins can change these settings.");
    await expect(row.getByTestId("lim-follow-switch")).toBeChecked();
    await expect(row.getByTestId("lim-follow-value")).toHaveText("Now: On");
    expect(w.writes).toHaveLength(1);
  });
});

// ---- Pipeline: the Follow-ups list on the card ----
const PWIN = `#windows-container .fulc-window[data-app-id="pipeline"]`;
const pt = (page: Page, id: string) => page.locator(`${PWIN} [data-testid="${id}"]`);
const ITEM = LIST.data[0].id as string;
const CHILD = "55555555-5555-4555-8555-5555555555c1";
const FU = ["66666666-6666-4666-8666-666666666601", "66666666-6666-4666-8666-666666666602", "66666666-6666-4666-8666-666666666603", "66666666-6666-4666-8666-666666666604"];
const HOSTILE = '<img src=x onerror="window.__pwn=1"><b>bold</b>';

function followUps(canMake: boolean, madeChild: boolean, available: boolean) {
  const row = (i: number, title: string, why: string, state: string, extra: Record<string, unknown> = {}) => ({
    id: FU[i],
    title,
    why,
    disposition: state === "note" ? "note" : "child",
    source_role: "code-reviewer",
    source_label: "Code reviewer",
    created_at: "2026-11-01T10:0" + i + ":00.000Z",
    state,
    ...extra,
  });
  return {
    work_item_id: ITEM,
    can_make_item: canMake,
    make_item_available: available,
    follow_ups: [
      row(0, "Add a retry", "The upload fails on a flaky network.", "item", { child_id: CHILD, child_stage: "triaged" }),
      row(1, HOSTILE, "", madeChild ? "item" : "note", madeChild ? { child_id: CHILD, child_stage: "triaged" } : {}),
      row(2, "Waits for the sweep", "Marked as a child.", "pending"),
      row(3, "Parent closed first", "", "parent_closed"),
    ],
  };
}

async function bootPipeline(page: Page, canMake: boolean, follow404 = false, available = true) {
  const w = { made: false, writes: [] as Write[], errors: [] as string[], follow404 };
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && w.errors.push(m.text()));
  page.on("pageerror", (e) => w.errors.push(`pageerror: ${e.message}`));
  await page.route((u) => u.pathname.startsWith("/api/v1/work-items") || u.pathname === "/api/v1/repos", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === "/api/v1/repos") return json(route, 200, REPOS);
    if (url.pathname === "/api/v1/work-items") return json(route, 200, url.searchParams.get("stage") === "needs_human" ? { data: [], next_cursor: null } : LIST);
    if (url.pathname.endsWith("/timeline")) return json(route, 200, TIMELINE);
    if (url.pathname === `/api/v1/work-items/${ITEM}/follow-ups`) return w.follow404 ? json(route, 404, { error: { code: "not_found", message: "server text" } }) : json(route, 200, followUps(canMake, w.made, available));
    if (method === "POST" && url.pathname === `/api/v1/work-items/${ITEM}/follow-ups/${FU[1]}/make-item`) {
      w.writes.push({ method, path: url.pathname, body: route.request().postData(), key: route.request().headers()["idempotency-key"] });
      w.made = true;
      return json(route, 200, { work_item_id: ITEM, follow_up_id: FU[1], child_id: CHILD, created: true });
    }
    return json(route, 404, { error: { code: "not_found", message: "x" } });
  });
  await page.route("**/api/v1/events", (route) => route.fulfill({ status: 200, contentType: "text/event-stream", headers: { "cache-control": "no-store" }, body: "event: idle\ndata: {}\n\n" }));
  await page.goto("/");
  await waitForDesktop(page);
  await page.locator('.dock-icon[data-app-id="pipeline"]').click();
  await expect(page.locator(PWIN)).toBeVisible();
  await pt(page, "pl-card").first().click();
  await expect(pt(page, "pl-detail-name")).toBeVisible();
  return w;
}

test.describe("D#483 S5-b2d-2c: Follow-ups on the item card", () => {
  test("child, pending, note and closed-parent rows read from fixed sentences; titles are text, never markup", async ({ page }) => {
    const w = await bootPipeline(page, true);
    const rows = pt(page, "pl-fu-row");
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0).getByTestId("pl-fu-state")).toHaveText("Its own item · Triaged");
    await expect(rows.nth(1).getByTestId("pl-fu-state")).toHaveText("Kept as a note");
    await expect(rows.nth(2).getByTestId("pl-fu-state")).toHaveText("Marked to become its own item");
    await expect(rows.nth(3).getByTestId("pl-fu-state")).toHaveText("The item closed before this follow-up became its own item.");
    // The hostile title is shown as characters.
    await expect(rows.nth(1).getByTestId("pl-fu-title")).toHaveText(HOSTILE);
    await expect(rows.nth(1).locator("img, b")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __pwn?: number }).__pwn)).toBeUndefined();
    // Only the note row has the button; only the item row has the link.
    await expect(pt(page, "pl-fu-make")).toHaveCount(1);
    await expect(pt(page, "pl-fu-open")).toHaveCount(1);
    expect(await pt(page, "pl-followups").innerText()).not.toMatch(/undefined|null|NaN|\[object/);
    expect(w.errors).toEqual([]);
  });

  test("Make it an item sends one keyed POST with no body, then the row reads as an item", async ({ page }) => {
    const w = await bootPipeline(page, true);
    const rows = pt(page, "pl-fu-row");
    await rows.nth(1).getByTestId("pl-fu-make").click();
    await expect(rows.nth(1).getByTestId("pl-fu-state")).toHaveText("Its own item · Triaged");
    await expect(pt(page, "pl-fu-make")).toHaveCount(0);
    expect(w.writes).toHaveLength(1);
    expect(w.writes[0]!.key).toMatch(UUID);
    expect(w.writes[0]!.body).toBeNull();
    expect(w.errors).toEqual([]);
  });

  test("a member sees the list with no button", async ({ page }) => {
    const w = await bootPipeline(page, false);
    await expect(pt(page, "pl-fu-row")).toHaveCount(4);
    await expect(pt(page, "pl-fu-make")).toHaveCount(0);
    expect(w.writes).toEqual([]);
  });

  test("C29: while follow-ups cannot become items the button is disabled with a fixed sentence and nothing is sent", async ({ page }) => {
    const w = await bootPipeline(page, true, false, false);
    const make = pt(page, "pl-fu-make");
    await expect(make).toHaveCount(1);
    await expect(make).toBeDisabled();
    await expect(pt(page, "pl-fu-later")).toHaveText("Follow-ups become items in a later release.");
    await expect(pt(page, "pl-fu-row")).toHaveCount(4); // the list still renders
    await make.click({ force: true });
    expect(w.writes).toEqual([]);
    expect(await pt(page, "pl-followups").innerText()).not.toMatch(/undefined|null|NaN|\[object/);
  });

  test("an unreadable list shows one fixed sentence", async ({ page }) => {
    await bootPipeline(page, true, true);
    await expect(pt(page, "pl-fu-unavailable")).toHaveText("Follow-ups aren't available right now.");
    await expect(pt(page, "pl-followups")).not.toContainText("server text");
  });
});
