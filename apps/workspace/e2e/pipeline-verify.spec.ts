// apps/workspace/e2e/pipeline-verify.spec.ts
//
// D#749 V4b: the verify section of the Pipeline item card, with real clicks on mocked replies. The mock keeps the repository's verify settings in memory and
// answers GET and PUT /api/v1/repos/{id}/verify-settings the way the route does (strict: an empty or non-https base_url is refused with the route's own
// 422, switching on without an address is refused), and the activity read puts `verify` in only while the setting is on, as the server does. So turning the
// setting off through the route takes the section away on the next refresh and after a reload. The words are in test/pipeline-verify.test.mjs. Every test runs
// on desktop, phone and tablet.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";
import { bootToDesktop, stepToDesktop } from "./helpers/boot";
import { MAX_DIFF_FRACTION, isolatedShot, pixelDiff } from "./helpers/pixel";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const V1 = join(SCRIPT_DIR, "..", "..", "..", "packages", "api", "fixtures", "v1");
const fx = (...p: string[]) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
const LIST = fx("listWorkItems", "200-page.json");
const REPOS = fx("listRepos", "200-page.json");
const TIMELINE = fx("getWorkItemTimeline", "200-ok.json");
const EMPTY = fx("getWorkItemActivity", "200-empty.json");
const SETTINGS_ON = fx("putRepoVerifySettings", "200-ok.json");
const SETTINGS_OFF = fx("putRepoVerifySettings", "200-turned_off.json");
const BASE_URL_INVALID = fx("putRepoVerifySettings", "422-verify_base_url_invalid.json");
const BASE_URL_REQUIRED = fx("putRepoVerifySettings", "422-verify_base_url_required.json");
const ITEM = LIST.data[0].id as string;
const REPO = LIST.data[0].repo_id as string;
const BUG = "6b1f6c1e-3f5a-4e0e-9a55-0a7b1c2d3e11";
const WIN = `#windows-container .fulc-window[data-app-id="pipeline"]`;
const tid = (page: Page, id: string) => page.locator(`${WIN} [data-testid="${id}"]`);
const activityOf = (name: string) => fx("getWorkItemActivity", `200-verify-${name}.json`);

interface Mock {
  requests: string[];
  /** The repository's verify settings, as the route keeps them. */
  settings: { enabled: boolean; base_url: string | null };
  /** The activity answer with its `verify`; the mock leaves `verify` out while the setting is off, as the read does. */
  activity: Record<string, unknown>;
  puts: { body: unknown; status: number }[];
}

async function mockApi(page: Page, activity: Record<string, unknown>): Promise<Mock> {
  const mock: Mock = { requests: [], settings: { enabled: true, base_url: "https://app.example.test" }, activity, puts: [] };
  const send = (route: Route, status: number, json: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(json) });
  await page.route((u) => u.pathname.startsWith("/api/v1/") && u.pathname !== "/api/v1/events", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    mock.requests.push(`${req.method()} ${p}`);
    if (p === `/api/v1/repos/${REPO}/verify-settings`) {
      if (req.method() === "GET") return send(route, 200, { ...SETTINGS_ON, enabled: mock.settings.enabled, base_url: mock.settings.base_url });
      if (req.method() === "PUT") {
        // Strict like the route: a JSON object body; base_url, when sent, is a non-empty https origin; on needs an address.
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(req.postData() ?? "");
        } catch {
          mock.puts.push({ body: req.postData(), status: 422 });
          return send(route, 422, BASE_URL_INVALID);
        }
        const next = { ...mock.settings };
        if ("base_url" in body) {
          const v = body.base_url;
          if (typeof v !== "string" || v.trim() === "" || !/^https:\/\/[a-z0-9.-]+$/i.test(v)) {
            mock.puts.push({ body, status: 422 });
            return send(route, 422, BASE_URL_INVALID);
          }
          next.base_url = v;
        }
        if ("enabled" in body) next.enabled = body.enabled === true;
        if (next.enabled && next.base_url === null) {
          mock.puts.push({ body, status: 422 });
          return send(route, 422, BASE_URL_REQUIRED);
        }
        mock.settings = next;
        mock.puts.push({ body, status: 200 });
        return send(route, 200, next.enabled ? SETTINGS_ON : SETTINGS_OFF);
      }
    }
    if (p === "/api/v1/work-items") return send(route, 200, { data: [{ ...LIST.data[0], stage: "merged" }, { ...LIST.data[0], id: BUG, title: "Verify failed after PR #57: c2", stage: "triaged", issue_number: 43 }], next_cursor: null });
    if (p.endsWith("/timeline")) return send(route, 200, TIMELINE);
    if (p === `/api/v1/work-items/${ITEM}/activity`) {
      const { verify, ...rest } = mock.activity;
      return send(route, 200, mock.settings.enabled ? { ...rest, verify } : rest);
    }
    if (p === `/api/v1/work-items/${BUG}/activity`) return send(route, 200, { ...EMPTY, stage: "triaged" });
    if (p === "/api/v1/repos") return send(route, 200, REPOS);
    if (p === "/api/v1/runs") return send(route, 200, { data: [], next_cursor: null });
    return send(route, 404, { error: { code: "not_found", message: "x", request_id: "req_1" } });
  });
  await page.route("**/api/v1/events", (route) => route.fulfill({ status: 200, contentType: "text/event-stream", headers: { "cache-control": "no-store" }, body: "event: idle\ndata: {}\n\n" }));
  return mock;
}

async function openPipeline(page: Page) {
  await page.evaluate(async () => (await import(new URL("core/cloud-live.js", document.baseURI).href)).default.start());
  await page.evaluate(() => (window as unknown as { FULCWM: Record<string, (id: string) => void> }).FULCWM.open("pipeline"));
  await expect(page.locator(WIN)).toBeVisible();
  await expect(page.locator(WIN)).not.toHaveClass(/opening/);
  await expect(tid(page, "pl-card").first()).toBeVisible();
}

async function press(page: Page, locator: ReturnType<Page["locator"]>) {
  if (test.info().project.name === "phone") await locator.tap();
  else await locator.click();
}

async function openItem(page: Page) {
  await press(page, page.locator(`${WIN} [data-testid="pl-card"][data-id="${ITEM}"]`));
  await expect(tid(page, "pl-live")).toBeVisible();
}

async function setup(page: Page, activity: Record<string, unknown>) {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  const mock = await mockApi(page, activity);
  await bootToDesktop(page);
  await openPipeline(page);
  await openItem(page);
  return { mock, errors };
}

async function reload(page: Page) {
  await page.reload();
  await stepToDesktop(page);
  await openPipeline(page);
  await openItem(page);
}

/** The route, called from the page the way an admin's client would. */
const putSettings = (page: Page, body: unknown) =>
  page.evaluate(async ([path, text]) => {
    const r = await fetch(path as string, { method: "PUT", headers: { "content-type": "application/json" }, body: text as string });
    return { status: r.status, json: await r.json() };
  }, [`/api/v1/repos/${REPO}/verify-settings`, typeof body === "string" ? body : JSON.stringify(body)] as const);

test.describe("D#749 V4b: the verify section on the item card (mocked API)", () => {
  test("a verified row: sentence, method badge, counts, and the same after a reload", async ({ page }) => {
    const { errors } = await setup(page, activityOf("verified"));
    await expect(tid(page, "pl-verify")).toHaveAttribute("data-status", "verified");
    await expect(tid(page, "pl-verify-heading")).toHaveText("Check on the deployed app");
    await expect(tid(page, "pl-verify-status")).toContainText("Verified on the deployed app.");
    await expect(tid(page, "pl-verify-method")).toHaveText("Playwright on your runner");
    await expect(tid(page, "pl-verify-counts")).toHaveText("3 of 3 steps passed.");
    await expect(tid(page, "pl-verify-account")).toHaveText("Signed in as the account set for checking.");
    await expect(tid(page, "pl-verify-bug")).toHaveCount(0);
    await expect(tid(page, "pl-verify")).not.toContainText(/null|undefined|_|[0-9a-f]{8}-[0-9a-f]{4}/);
    await reload(page);
    await expect(tid(page, "pl-verify-status")).toContainText("Verified on the deployed app.");
    await expect(tid(page, "pl-verify-method")).toHaveText("Playwright on your runner");
    expect(errors).toEqual([]);
  });

  test("a verified row whose account was never checked says nothing about the account, and the same after a reload", async ({ page }) => {
    const { errors } = await setup(page, activityOf("verified-no-account-check"));
    await expect(tid(page, "pl-verify-status")).toContainText("Verified on the deployed app.");
    await expect(tid(page, "pl-verify-method")).toHaveText("Chrome on your runner");
    await expect(tid(page, "pl-verify-account")).toHaveCount(0);
    await expect(tid(page, "pl-verify")).not.toContainText(/signed in|account/i);
    await reload(page);
    await expect(tid(page, "pl-verify-status")).toContainText("Verified on the deployed app.");
    await expect(tid(page, "pl-verify-account")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("a failed row links to its bug item; clicking opens that item's card, which has no verify section", async ({ page }) => {
    const { mock, errors } = await setup(page, activityOf("failed"));
    await expect(tid(page, "pl-verify")).toHaveAttribute("data-status", "failed");
    await expect(tid(page, "pl-verify-method")).toHaveText("Chrome on your runner");
    await expect(tid(page, "pl-verify-counts")).toHaveText("1 of 3 steps passed, 2 failed.");
    const bug = tid(page, "pl-verify-bug");
    await expect(bug).toHaveText("Open the bug item");
    await press(page, bug);
    await expect.poll(() => mock.requests.includes(`GET /api/v1/work-items/${BUG}/activity`)).toBe(true);
    await expect(tid(page, "pl-verify")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("an unverified row says why in plain words, never the code", async ({ page }) => {
    const { errors } = await setup(page, activityOf("unverified-wrong-account"));
    await expect(tid(page, "pl-verify")).toHaveAttribute("data-status", "unverified");
    await expect(tid(page, "pl-verify-reason")).toHaveText("The browser was signed in as a different account than the one set for checking, so nothing it did counts.");
    await expect(tid(page, "pl-verify-counts")).toHaveCount(0);
    await expect(tid(page, "pl-verify-bug")).toHaveCount(0);
    await expect(tid(page, "pl-verify")).not.toContainText(/wrong_account|_/);
    expect(errors).toEqual([]);
  });

  test("a row that has not started reads waiting to start, with no reason code and no badge", async ({ page }) => {
    const { errors } = await setup(page, activityOf("waiting"));
    await expect(tid(page, "pl-verify")).toHaveAttribute("data-status", "waiting");
    await expect(tid(page, "pl-verify-status")).toHaveText("Waiting to start.");
    await expect(tid(page, "pl-verify-reason")).toHaveCount(0);
    await expect(tid(page, "pl-verify-method")).toHaveCount(0);
    await expect(tid(page, "pl-verify")).not.toContainText(/pending|deploying|_/);
    expect(errors).toEqual([]);
  });

  test("a row moves from waiting to running to verified on the next refreshes", async ({ page }) => {
    const { mock } = await setup(page, activityOf("waiting"));
    await expect(tid(page, "pl-verify-status")).toHaveText("Waiting to start.");
    mock.activity = activityOf("running");
    await page.clock.runFor(10_000);
    await expect(tid(page, "pl-verify-status")).toContainText("Being checked now.");
    await expect(tid(page, "pl-verify-method")).toHaveText("Playwright on your runner");
    mock.activity = activityOf("verified");
    await page.clock.runFor(10_000);
    await expect(tid(page, "pl-verify-status")).toContainText("Verified on the deployed app.");
  });

  test("an item whose repository has verify off shows no section", async ({ page }) => {
    const { mock } = await setup(page, activityOf("verified"));
    await expect(tid(page, "pl-verify")).toHaveCount(1);
    mock.activity = EMPTY;
    await page.clock.runFor(10_000);
    await expect(tid(page, "pl-verify")).toHaveCount(0);
    await expect(tid(page, "pl-verify-heading")).toHaveCount(0);
  });

  test("undo: turning the setting off through the settings route takes the section away on refresh and after a reload; turning it on brings it back", async ({ page }) => {
    const { mock, errors } = await setup(page, activityOf("verified"));
    await expect(tid(page, "pl-verify")).toHaveCount(1);
    expect(await putSettings(page, { enabled: false })).toMatchObject({ status: 200, json: { enabled: false } });
    expect(mock.settings.enabled).toBe(false);
    await page.clock.runFor(10_000);
    await expect(tid(page, "pl-verify")).toHaveCount(0);
    await reload(page);
    await expect(tid(page, "pl-live")).toBeVisible();
    await expect(tid(page, "pl-verify")).toHaveCount(0);
    expect(await putSettings(page, { enabled: true })).toMatchObject({ status: 200, json: { enabled: true } });
    await page.clock.runFor(10_000);
    await expect(tid(page, "pl-verify-status")).toContainText("Verified on the deployed app.");
    expect(errors).toEqual([]);
  });

  test("the fixture server is strict: an empty, blank, plain-http or credentialed base_url is refused and the section stays", async ({ page }) => {
    const { mock } = await setup(page, activityOf("verified"));
    for (const bad of ["", "   ", "http://app.example.test", "https://user:pw@app.example.test", null]) {
      const r = await putSettings(page, { enabled: true, base_url: bad });
      expect(r.status, JSON.stringify(bad)).toBe(422);
      expect(r.json).toMatchObject({ error: { code: "verify_base_url_invalid" } });
    }
    expect((await putSettings(page, "not json")).status).toBe(422);
    expect(mock.settings).toEqual({ enabled: true, base_url: "https://app.example.test" });
    expect(mock.puts.every((p) => p.status === 422)).toBe(true);
    await page.clock.runFor(10_000);
    await expect(tid(page, "pl-verify")).toHaveCount(1);
    // Switching on with no address on file is refused too.
    mock.settings = { enabled: false, base_url: null };
    expect(await putSettings(page, { enabled: true })).toMatchObject({ status: 422, json: { error: { code: "verify_base_url_required" } } });
    expect(await putSettings(page, { enabled: true, base_url: "https://app.example.test" })).toMatchObject({ status: 200 });
  });

  test("fits without overflow at 375px", async ({ page }) => {
    await setup(page, activityOf("failed"));
    await page.setViewportSize({ width: 375, height: 800 });
    await expect(tid(page, "pl-verify")).toBeVisible();
    const r = await tid(page, "pl-detail").evaluate((el) => {
      const right = el.getBoundingClientRect().right;
      return { s: el.scrollWidth, c: el.clientWidth, wide: [...el.querySelectorAll("*")].filter((n) => n.getBoundingClientRect().width > 0 && n.getBoundingClientRect().right > right + 1).length };
    });
    expect(r.s).toBeLessThanOrEqual(r.c + 1);
    expect(r.wide).toBe(0);
    const box = await tid(page, "pl-verify-bug").boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });
});

// ── the pixel check: the method badge of the same row on two fresh pages, and a badge of another method as the negative control ─────────────────────────────
test.describe("D#749 V4b: pixel check of the method badge", () => {
  test("the same method draws the same badge on a fresh page; another method differs", async ({ page }, info) => {
    const shotOf = async (activity: Record<string, unknown>) => {
      const own = await page.context().newPage();
      try {
        await setup(own, activity);
        return await isolatedShot(own, tid(own, "pl-verify-method"));
      } finally {
        await own.close();
      }
    };
    const verified = activityOf("verified");
    const first = await shotOf(verified);
    const second = await shotOf(verified);
    const other = await shotOf({ ...verified, verify: { ...(verified.verify as object), method: "chrome_runner" } });
    const same = await pixelDiff(page, first, second);
    const control = await pixelDiff(page, other, second);
    const line = `${info.project.name} verify badge: same ${same.differing}/${same.total} px differ (sizes ${same.sizes.join("x")}); control ${control.differing}/${control.total} px differ`;
    console.log("PIXELDIFF " + line);
    info.annotations.push({ type: "pixel-diff", description: line });
    expect(same.sameSize).toBe(true);
    expect(same.differing / same.total).toBeLessThanOrEqual(MAX_DIFF_FRACTION);
    expect(control.differing).toBeGreaterThan(0);
    expect(control.differing).toBeGreaterThan(same.differing);
  });
});
