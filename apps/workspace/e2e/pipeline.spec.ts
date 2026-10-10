// apps/workspace/e2e/pipeline.spec.ts
//
// D#37 WS-F1a (corrections C31, C33): the Pipeline app, a read-only board.
// The built cloud dist is served by fixture-server.mjs; /api/v1/work-items,
// /repos and the per-item routes are answered by page.route() from the repo's
// contract fixtures (packages/api/fixtures/v1/**), so each test can force a
// reply and record the exact requests the app sent. 4xx replies are mocked
// inline here and are not fixture files (C33 section 2). The document carries
// the production CSP and Trusted Types directives, so a sink in the app fails
// here for real.
//
// Live events: the shell's live client reads /api/v1/events with fetch(). The
// tests answer that route with one SSE frame and then wake the client with a
// pointerdown, exactly as a user's next input would after an idle close. No
// test hook in the live client is used.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";
import { waitForDesktop } from "./helpers/boot";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const V1 = join(SCRIPT_DIR, "..", "..", "..", "packages", "api", "fixtures", "v1");
const readFixture = (...p: string[]) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
const LIST = readFixture("listWorkItems", "200-page.json");
const REPOS_RAW = readFixture("listRepos", "200-page.json");
// The work item's repo has no full name in the shared fixture; here it has one, as an installed repo does.
const REPOS = { ...REPOS_RAW, data: REPOS_RAW.data.map((r: { product: string }) => (r.product === "docs" ? { ...r, full_name: "acme/docs" } : r)) };
const IN_REVIEW = readFixture("getWorkItem", "200-in-review.json");
const NEEDS_HUMAN = readFixture("getWorkItem", "200-needs-human.json");
const TIMELINE = readFixture("getWorkItemTimeline", "200-ok.json");

const ID = LIST.data[0].id as string;
const ID2 = "55555555-5555-4555-8555-555555555551";
const ID3 = "55555555-5555-4555-8555-555555555552";
const ID4 = "55555555-5555-4555-8555-555555555553";
const ID5 = "55555555-5555-4555-8555-555555555554";
const CSP =
  "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
const WIN = `#windows-container .fulc-window[data-app-id="pipeline"]`;
const tid = (page: Page, id: string) => page.locator(`${WIN} [data-testid="${id}"]`);
const col = (page: Page, id: string) => tid(page, "pl-col-" + id);
const cards = (page: Page, colId: string) => col(page, colId).locator('[data-testid="pl-card"]');
const item = (base: Record<string, unknown>, over: Record<string, unknown>) => ({ ...base, ...over });

interface Mock {
  requests: string[];
  list: { data: unknown[]; next_cursor: string | null };
  listStatus: number;
  reposStatus: number;
  itemReply: Record<string, { status: number; json: unknown }>;
  timelineStatus: number;
  streamFrame: string | null;
}

const count = (m: Mock, prefix: string) => m.requests.filter((r) => r.startsWith(prefix)).length;
const timelineCount = (m: Mock) => m.requests.filter((r) => /\/timeline$/.test(r)).length;

function frame(type: string, data: Record<string, unknown>) {
  return `id: c-${Math.random().toString(36).slice(2)}\nevent: ${type}\ndata: ${JSON.stringify({ id: "e1", type, created_at: "2026-01-01T00:00:00.000Z", data })}\n\n`;
}

async function mockApi(page: Page): Promise<Mock> {
  const mock: Mock = {
    requests: [],
    list: structuredClone(LIST),
    listStatus: 200,
    reposStatus: 200,
    itemReply: {},
    timelineStatus: 200,
    streamFrame: null,
  };
  const json = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  const err = (code: string) => ({ error: { code, message: "server text that must never be shown", request_id: "req_1" } });
  await page.route((u) => u.pathname.startsWith("/api/v1/work-items") || u.pathname === "/api/v1/repos", async (route) => {
    const url = new URL(route.request().url());
    mock.requests.push(`${route.request().method()} ${url.pathname}`);
    if (url.pathname === "/api/v1/repos") return mock.reposStatus === 200 ? json(route, 200, REPOS) : json(route, mock.reposStatus, err("internal"));
    if (url.pathname === "/api/v1/work-items") return mock.listStatus === 200 ? json(route, 200, mock.list) : json(route, mock.listStatus, err("unauthorized"));
    if (url.pathname.endsWith("/timeline")) {
      return mock.timelineStatus === 200 ? json(route, 200, TIMELINE) : json(route, mock.timelineStatus, err("internal"));
    }
    const id = url.pathname.split("/").pop()!;
    const reply = mock.itemReply[id];
    return reply ? json(route, reply.status, reply.json) : json(route, 404, err("not_found"));
  });
  // The account stream: idle by default; one frame when a test sets streamFrame.
  await page.route("**/api/v1/events", async (route) => {
    const body = mock.streamFrame ?? "event: idle\ndata: {}\n\n";
    mock.streamFrame = null;
    await route.fulfill({ status: 200, contentType: "text/event-stream", headers: { "cache-control": "no-store" }, body });
  });
  return mock;
}

async function boot(page: Page) {
  await page.route((u) => u.pathname === "/", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": CSP } });
  });
  // No fake clock here: it replaces performance.mark, and the live client only
  // starts on the boot:desktop-ready mark.
  await page.goto("/");
  await waitForDesktop(page); // presses RETRY if a loaded machine ran out boot's 5 s mode budget
}

async function openPipeline(page: Page) {
  await page.locator('.dock-icon[data-app-id="pipeline"]').click();
  await expect(page.locator(WIN)).toBeVisible();
  await expect(page.locator(WIN)).not.toHaveClass(/opening/);
}

async function watch(page: Page) {
  const w = { errors: [] as string[], violations: [] as string[] };
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) w.errors.push(m.text());
  });
  page.on("pageerror", (e) => w.errors.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => (window as unknown as { __tt: string[] }).__tt.push(e.violatedDirective));
    (window as unknown as { __tt: string[] }).__tt = [];
  });
  return { ...w, tt: () => page.evaluate(() => (window as unknown as { __tt: string[] }).__tt) };
}

async function setup(page: Page, tweak?: (m: Mock) => void) {
  const w = await watch(page);
  const mock = await mockApi(page);
  tweak?.(mock);
  await boot(page);
  await openPipeline(page);
  return { w, mock };
}

/** Deliver one stream frame: the next stream read gets it, and a pointerdown wakes the idle-closed client. */
async function inject(page: Page, mock: Mock, type: string, data: Record<string, unknown>) {
  mock.streamFrame = type === "resync" ? "event: resync\ndata: {}\n\n" : frame(type, data);
  // A pointerdown while the client is mid-close wakes nothing, and the frame would sit here to be overwritten by the next
  // inject. So wake it again until the stream read has taken the frame (the route clears streamFrame when it does).
  await expect
    .poll(async () => {
      if (mock.streamFrame !== null) await page.evaluate(() => window.dispatchEvent(new Event("pointerdown")));
      return mock.streamFrame;
    }, { intervals: [50, 100, 250, 500], timeout: 30_000 })
    .toBeNull();
}

const subscriberCount = (page: Page) =>
  page.evaluate(async () => (await import(new URL("core/cloud-live.js", document.baseURI).href)).subscriberCount() as number);

const SEVEN = [
  item(LIST.data[0], { id: ID, stage: "in_progress" }),
  item(LIST.data[0], { id: ID2, stage: "changes_requested", provenance: "external", issue_number: 7 }),
  item(LIST.data[0], { id: ID3, stage: "review_passed", issue_number: 8 }),
  item(LIST.data[0], { id: ID4, stage: "merged", issue_number: 9 }),
  item(LIST.data[0], { id: ID5, stage: "closed_unmerged", issue_number: 10 }),
  item(LIST.data[0], { id: "55555555-5555-4555-8555-555555555555", stage: "from_the_future", issue_number: 11 }),
];

test.describe("D#37 WS-F1a: Pipeline app (mocked API)", () => {
  test("board: nine columns in order with counts, cards by repo product, no timeline request on load", async ({ page }) => {
    const { w, mock } = await setup(page);
    await expect(cards(page, "in_progress")).toHaveCount(1);
    await expect(tid(page, "pl-columns").locator("h3")).toHaveText([
      "Triaged 0", "Discussing 0", "Spec ready 0", "In progress 1", "PR opened 0",
      "Changes requested 0", "Review passed 0", "Needs a person 0", "Done 0",
    ]);
    const card = cards(page, "in_progress").first();
    await expect(card).toContainText("acme/docs #42");
    await expect(card.locator('[data-testid="pl-card-title"]')).toHaveText("Add a dark mode toggle");
    await expect(card.locator('[data-testid="pl-kind"]')).toHaveText("Feature");
    await expect(card.locator('[data-testid="pl-verdict"]')).toHaveCount(0);
    // The dock click is a user input, which reopens the idle live stream and makes the
    // shell emit one refresh; the coalescing allows at most one more load after the first.
    expect(count(mock, "GET /api/v1/work-items")).toBeLessThanOrEqual(2);
    expect(count(mock, "GET /api/v1/repos")).toBeLessThanOrEqual(2);
    expect(timelineCount(mock)).toBe(0);
    expect(w.errors).toEqual([]);
    expect(await w.tt()).toEqual([]);
    const text = await page.locator(WIN).innerText();
    expect(text).not.toMatch(/Could not load|Claude Code|Terminal/i);
  });

  test("cards: verdict lines from the stage, External tag, Done shows which, unknown stage is in no column", async ({ page }) => {
    await setup(page, (m) => (m.list.data = SEVEN));
    await expect(cards(page, "in_progress")).toHaveCount(1);
    await expect(cards(page, "changes_requested").first()).toContainText("Review asked for changes");
    await expect(cards(page, "changes_requested").first()).toContainText("External");
    await expect(cards(page, "review_passed").first()).toContainText("Review passed");
    await expect(cards(page, "done")).toHaveCount(2);
    await expect(col(page, "done")).toContainText("Merged");
    await expect(col(page, "done")).toContainText("Closed without merging");
    await expect(tid(page, "pl-card")).toHaveCount(5); // the from_the_future card is not shown
    await expect(page.locator(`${WIN} [data-testid="pl-card"]:has-text("#11")`)).toHaveCount(0);
  });

  test("a failed repos request leaves cards labelled #<issue_number> alone and the board renders", async ({ page }) => {
    await setup(page, (m) => (m.reposStatus = 500));
    const card = cards(page, "in_progress").first();
    await expect(card).toBeVisible();
    await expect(card).toContainText("#42");
    await expect(card).not.toContainText("acme/docs");
  });

  test("title: a card and its detail header show repo, number, title and a kind badge; with no title they show the kind and the number", async ({ page }) => {
    const NONE = "55555555-5555-4555-8555-555555555551";
    await setup(page, (m) => (m.list.data = [item(LIST.data[0], { id: ID, stage: "in_progress" }), item(LIST.data[0], { id: NONE, stage: "spec_ready", kind: "bug", issue_number: 595, title: null })]));
    const titled = cards(page, "in_progress").first();
    await expect(titled.locator('[data-testid="pl-card-head"]')).toHaveText("acme/docs #42");
    await expect(titled.locator('[data-testid="pl-card-title"]')).toHaveText("Add a dark mode toggle");
    await expect(titled.locator('[data-testid="pl-kind"]')).toHaveText("Feature");
    const bare = cards(page, "spec_ready").first();
    await expect(bare.locator('[data-testid="pl-card-head"]')).toHaveText("acme/docs #595");
    await expect(bare.locator('[data-testid="pl-card-title"]')).toHaveText("Bug #595");
    await expect(bare.locator('[data-testid="pl-kind"]')).toHaveText("Bug");
    expect(await page.locator(`${WIN} [data-testid="pl-columns"]`).innerText()).not.toMatch(/null|undefined/);
    await bare.click();
    await expect(tid(page, "pl-detail-title")).toHaveText("acme/docs #595");
    await expect(tid(page, "pl-detail-name")).toHaveText("Bug #595");
    await tid(page, "pl-back").click();
    await titled.click();
    await expect(tid(page, "pl-detail-title")).toHaveText("acme/docs #42");
    await expect(tid(page, "pl-detail-name")).toHaveText("Add a dark mode toggle");
  });

  test("title: a hostile title is shown as text, never as markup, on the card and in the detail, and a long one wraps inside the window", async ({ page }) => {
    const HOSTILE = '<img src=x onerror="window.__pwn=1"><b>bold</b>\u0007\r\nsecond line';
    const LONG = "W".repeat(150) + " " + "x".repeat(10);
    const ID6 = "55555555-5555-4555-8555-555555555556";
    const { w } = await setup(page, (m) =>
      (m.list.data = [item(LIST.data[0], { id: ID, stage: "in_progress", title: HOSTILE }), item(LIST.data[0], { id: ID6, stage: "in_progress", issue_number: 43, title: LONG })]),
    );
    const card = cards(page, "in_progress").first();
    await expect(card).toBeVisible();
    await expect(card.locator('[data-testid="pl-card-title"]')).toHaveText('<img src=x onerror="window.__pwn=1"><b>bold</b> second line');
    expect(await page.locator(`${WIN} .pl-app img, ${WIN} .pl-app b`).count()).toBe(0);
    await card.click();
    await expect(tid(page, "pl-detail-name")).toHaveText('<img src=x onerror="window.__pwn=1"><b>bold</b> second line');
    expect(await page.locator(`${WIN} .pl-detail img, ${WIN} .pl-detail b`).count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __pwn?: number }).__pwn)).toBeUndefined();
    expect(await w.tt()).toEqual([]);
    expect(w.errors).toEqual([]);
    await tid(page, "pl-back").click();
    // The long title wraps: no card is wider than its column and the board does not scroll sideways past its window.
    const fits = await page.locator(`${WIN} [data-testid="pl-card"]`).evaluateAll((els) => els.every((el) => el.scrollWidth <= el.clientWidth + 1));
    expect(fits).toBe(true);
  });

  test("detail: a card opens by click or Enter with exactly one timeline request, reviewers are named there only", async ({ page }) => {
    const { mock } = await setup(page, (m) => (m.list.data = SEVEN));
    await expect(tid(page, "pl-card")).toHaveCount(5);
    await expect(tid(page, "pl-columns")).not.toContainText("Code review");
    expect(timelineCount(mock)).toBe(0);
    await cards(page, "review_passed").first().focus();
    await page.keyboard.press("Enter");
    await expect(tid(page, "pl-history-row")).toHaveCount(TIMELINE.transitions.length);
    expect(timelineCount(mock)).toBe(1);
    await expect(tid(page, "pl-history")).toContainText("Code review");
    await expect(tid(page, "pl-history")).toContainText("Merged");
    // The board behind it still carries no reviewer name.
    await expect(tid(page, "pl-columns")).not.toContainText("Code review");
    await tid(page, "pl-back").click();
    await expect(tid(page, "pl-detail")).toBeHidden();
    await cards(page, "in_progress").first().click();
    await expect(tid(page, "pl-history-row").first()).toBeVisible();
    expect(timelineCount(mock)).toBe(2);
  });

  test("detail: a timeline error is a fixed sentence inside the detail and the board is unaffected", async ({ page }) => {
    await setup(page, (m) => (m.timelineStatus = 500));
    await cards(page, "in_progress").first().click();
    await expect(tid(page, "pl-history-error")).toHaveText("History isn't available right now.");
    await expect(page.locator(WIN)).not.toContainText("server text that must never be shown");
    await expect(cards(page, "in_progress")).toHaveCount(1);
    await expect(tid(page, "pl-status")).toBeHidden();
  });

  test("read-only: nothing is draggable, a drag onto another column changes nothing and sends nothing, and no agent or Cancel or Retry control exists", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "phone", "a mouse drag is a desktop gesture");
    const { mock } = await setup(page);
    const card = cards(page, "in_progress").first();
    await expect(card).toBeVisible();
    expect(await page.locator(`${WIN} [draggable="true"]`).count()).toBe(0);
    const before = mock.requests.length;
    await card.dragTo(col(page, "review_passed"));
    await expect(cards(page, "in_progress")).toHaveCount(1);
    await expect(cards(page, "review_passed")).toHaveCount(0);
    expect(mock.requests.length).toBe(before);
    const text = await page.locator(WIN).innerText();
    expect(text).not.toMatch(/Terminal|Cancel|Retry|Run in|agent/i);
    expect(await page.locator(`${WIN} .pl-app button`).allInnerTexts()).toEqual(["acme/docs #42\nAdd a dark mode toggle\nFeature"]);
  });

  test("a mocked 401 on the list shows the app's own error line and never 'Reload the page'", async ({ page }) => {
    await setup(page, (m) => (m.listStatus = 401));
    await expect(tid(page, "pl-status")).toHaveText("Work items aren't available right now.");
    await expect(page.locator(WIN)).not.toContainText(/Reload the page|server text/);
  });

  test("live: work_item.needs_human moves an In progress card to Needs a person with no reload, using the item read", async ({ page }) => {
    const { mock } = await setup(page);
    await expect(cards(page, "in_progress")).toHaveCount(1);
    mock.itemReply[ID] = { status: 200, json: NEEDS_HUMAN };
    await inject(page, mock, "work_item.needs_human", { workItemId: ID, sourceRunId: ID2 });
    await expect(cards(page, "needs_human")).toHaveCount(1);
    await expect(cards(page, "in_progress")).toHaveCount(0);
    await expect(cards(page, "needs_human").first()).toContainText("Needs a person");
    expect(count(mock, `GET /api/v1/work-items/${ID}`)).toBe(1);
  });

  test("live: work_item.stage_changed (every move the driver records) moves the card with no reload; the event's own stage is never trusted", async ({ page }) => {
    const { mock } = await setup(page);
    await expect(cards(page, "in_progress")).toHaveCount(1);
    mock.itemReply[ID] = { status: 200, json: item(IN_REVIEW, { stage: "changes_requested", updated_at: "2026-09-18T12:41:00.000Z" }) };
    // The event claims another stage; the card goes where the item read says.
    await inject(page, mock, "work_item.stage_changed", { workItemId: ID, fromStage: "in_progress", toStage: "merged" });
    await expect(cards(page, "changes_requested")).toHaveCount(1);
    await expect(cards(page, "done")).toHaveCount(0);
    await expect(cards(page, "in_progress")).toHaveCount(0);
    expect(count(mock, `GET /api/v1/work-items/${ID}`)).toBe(1);
    // An event with no usable id is ignored.
    await inject(page, mock, "work_item.stage_changed", { fromStage: "a", toStage: "b" });
    expect(count(mock, `GET /api/v1/work-items/${ID}`)).toBe(1);
  });

  test("live: pr.opened is placed by the returned stage, and a 404 removes the card", async ({ page }) => {
    const { mock } = await setup(page);
    await expect(cards(page, "in_progress")).toHaveCount(1);
    mock.itemReply[ID] = { status: 200, json: item(IN_REVIEW, { stage: "pr_opened", updated_at: "2026-09-18T12:40:00.000Z" }) };
    await inject(page, mock, "pr.opened", { workItemId: ID, prNumber: 7, stage: "merged" });
    await expect(cards(page, "pr_opened")).toHaveCount(1);
    await expect(cards(page, "done")).toHaveCount(0);
    delete mock.itemReply[ID];
    await inject(page, mock, "pr.opened", { workItemId: ID, prNumber: 7 });
    await expect(tid(page, "pl-card")).toHaveCount(0);
  });

  test("live: run.status_changed re-loads the list, an event without a workItemId is ignored", async ({ page }) => {
    const { mock } = await setup(page);
    await expect(cards(page, "in_progress")).toHaveCount(1);
    const items = count(mock, "GET /api/v1/work-items/");
    // The first frame has no workItemId. It is read before the second is (one frame per stream read, in order), so the
    // second frame's effect showing proves the first was handled; the count is checked after that, with no sleep.
    await inject(page, mock, "pr.opened", { prNumber: 1 });
    mock.list.data = [item(LIST.data[0], { stage: "merged", updated_at: "2026-09-18T14:00:00.000Z" })];
    await inject(page, mock, "run.status_changed", { runId: ID2, from: "running", to: "succeeded" });
    await expect(cards(page, "done")).toHaveCount(1);
    await expect(cards(page, "done").first()).toContainText("Merged");
    expect(count(mock, "GET /api/v1/work-items/")).toBe(items);
  });

  test("live: a refresh re-loads the list and the repos, and an open detail stays open", async ({ page }) => {
    const { mock } = await setup(page);
    await cards(page, "in_progress").first().click();
    await expect(tid(page, "pl-history-row").first()).toBeVisible();
    const repos = count(mock, "GET /api/v1/repos");
    mock.list.data = [item(LIST.data[0], { stage: "needs_human", updated_at: "2026-09-18T14:00:00.000Z" })];
    await inject(page, mock, "resync", {});
    await expect(cards(page, "needs_human")).toHaveCount(1);
    expect(count(mock, "GET /api/v1/repos")).toBeGreaterThan(repos);
    await expect(tid(page, "pl-detail")).toBeVisible();
    await expect(tid(page, "pl-detail")).toContainText("Needs a person");
    expect(timelineCount(mock)).toBe(1);
  });

  test("closing the window drops every subscription: 20 open/close cycles end at the baseline count", async ({ page }) => {
    await setup(page);
    await expect(cards(page, "in_progress")).toHaveCount(1);
    await page.evaluate(() => (window as unknown as { FULCWM: { close: (id: string) => void } }).FULCWM.close("pipeline"));
    await expect(page.locator(WIN)).toHaveCount(0);
    const baseline = await subscriberCount(page);
    for (let i = 0; i < 20; i++) {
      await page.evaluate(() => (window as unknown as { FULCWM: { open: (id: string) => void } }).FULCWM.open("pipeline"));
      await expect(page.locator(WIN)).toBeVisible();
      expect(await subscriberCount(page)).toBe(baseline + 5);
      await page.evaluate(() => (window as unknown as { FULCWM: { close: (id: string) => void } }).FULCWM.close("pipeline"));
      await expect(page.locator(WIN)).toHaveCount(0);
    }
    expect(await subscriberCount(page)).toBe(baseline);
  });

  test("phone: one column of stage groups with counts, a tap opens the detail full-window and Back returns", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "phone", "phone layout");
    await setup(page, (m) => (m.list.data = SEVEN));
    await expect(tid(page, "pl-card")).toHaveCount(5);
    // Layout sizes (offset*), not bounding boxes: the window's opening scale animation skews those.
    const appEl = page.locator(`${WIN} .pl-app`);
    const width = () => appEl.evaluate((el) => (el as HTMLElement).offsetWidth);
    await expect.poll(width).toBeLessThanOrEqual(page.viewportSize()!.width); // the phone window settles at full width
    const appWidth = await width();
    const heads = await page.locator(`${WIN} .pl-col`).evaluateAll((els) =>
      els.map((el) => ({ x: (el as HTMLElement).offsetLeft, y: (el as HTMLElement).offsetTop, w: (el as HTMLElement).offsetWidth }))
    );
    expect(heads).toHaveLength(9);
    expect(new Set(heads.map((r) => r.x)).size).toBe(1);
    expect(heads.map((r) => r.y)).toEqual([...heads.map((r) => r.y)].sort((a, b) => a - b));
    expect(new Set(heads.map((r) => r.y)).size).toBe(9);
    expect(heads[0]!.w).toBeGreaterThan(appWidth - 40);
    await expect(col(page, "done").locator(".pl-count")).toHaveText("2");
    await cards(page, "review_passed").first().tap();
    const detail = tid(page, "pl-detail");
    await expect(detail).toBeVisible();
    await expect(tid(page, "pl-history-row").first()).toBeVisible();
    expect(await detail.evaluate((el) => (el as HTMLElement).offsetWidth)).toBeGreaterThanOrEqual(appWidth - 2);
    expect(await tid(page, "pl-back").evaluate((el) => (el as HTMLElement).offsetHeight)).toBeGreaterThanOrEqual(44);
    await tid(page, "pl-back").tap();
    await expect(detail).toBeHidden();
    expect(await page.locator(`${WIN} .pl-board`).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  });

  test("the app source has no HTML sink, no direct network call, no Kanban import, no status-code branch and no write control", async () => {
    const dir = join(SCRIPT_DIR, "..", "apps", "pipeline");
    // The approve code lives at the end of pipeline-actions.js (folded in for the boot-file budget); only that section is checked here, as before.
    const actions = readFileSync(join(dir, "pipeline-actions.js"), "utf8");
    const approveStart = actions.indexOf("// --- Approve and start");
    expect(approveStart, "approve section marker present").toBeGreaterThan(-1);
    // The stuck-item buttons (D#483) follow it in the same file; they are checked below for the same sinks, but they have a dialog of their own (an Escape handler),
    // so the "no Cancel or Retry" line is about the approve code alone.
    const operatorStart = actions.indexOf("// --- Stuck items");
    expect(operatorStart, "stuck-item section marker present").toBeGreaterThan(approveStart);
    const approveCode = actions.slice(approveStart, operatorStart);
    const operatorCode = actions.slice(operatorStart);
    expect(approveCode, "approve section is the real approve code").toContain("createApprove");
    expect(operatorCode, "stuck-item section is the real code").toContain("createOperator");
    const sinks = (c: string) => {
      expect(c).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
      expect(c).not.toMatch(/fetch\(/);
      expect(c.replace(/\/\/.*$/gm, "")).not.toMatch(/draggable|dragstart|\bdrop\b/);
      expect(c).not.toMatch(/401/);
    };
    sinks(operatorCode);
    const code = [readFileSync(join(dir, "pipeline-app.js"), "utf8"), readFileSync(join(dir, "pipeline-storage.js"), "utf8"), approveCode].join("\n");
    expect(code).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(code).not.toMatch(/fetch\(/);
    expect(code).not.toMatch(/apps\/kanban/);
    expect(code).not.toMatch(/401/);
    expect(code).not.toMatch(/draggable|dragstart|drop/);
    expect(code.replace(/\/\/.*$/gm, "")).not.toMatch(/cancel|retry/i);
  });
});
