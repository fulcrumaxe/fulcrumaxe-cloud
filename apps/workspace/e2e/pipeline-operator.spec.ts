// apps/workspace/e2e/pipeline-operator.spec.ts
//
// D#483: the buttons for a stuck item in the Pipeline detail (Build again, Back to discussion, Treat as a feature,
// Close) and the "Open the work item in Pipeline" link from the Runs app, on mocked replies from the repo's contract
// fixtures (packages/api/fixtures/v1). The built cloud dist is served by fixture-server.mjs and booted under the page
// clock. The document carries the production CSP and Trusted Types directives. Every test runs on desktop, phone and
// tablet.
//
// The logic half (what each press sends, the sentences, one request at a time, no rule of the server copied into the
// app) is in test/pipeline-operator.test.mjs; this file covers what needs a real DOM: the buttons a server list
// draws, the in-app Close dialog (never the browser's own), what a refusal looks like, and the deep link into a board
// that is not loaded yet, an app that is already open and an id that is not on the board.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";
import { bootToDesktop } from "./helpers/boot";


const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// The two sentences are read from the runner protocol's copy file as text (the workspace app does not depend on that package): the server sends exactly these.
const COPY_SRC = readFileSync(join(SCRIPT_DIR, "..", "..", "..", "packages", "runner-protocol", "src", "copy.ts"), "utf8");
const copyOf = (key: string): string => new RegExp(`${key}:\\s*"([^"]+)"`).exec(COPY_SRC)![1]!;
const COPY = { specHasNoFileList: copyOf("specHasNoFileList"), respecListUnreadable: copyOf("respecListUnreadable") };
const V1 = join(SCRIPT_DIR, "..", "..", "..", "packages", "api", "fixtures", "v1");
const fx = (...p: string[]) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
const LIST = fx("listWorkItems", "200-page.json");
const REPOS = fx("listRepos", "200-page.json");
const TIMELINE = fx("getWorkItemTimeline", "200-ok.json");
const NEEDS_HUMAN = fx("getWorkItemActivity", "200-needs-human.json");
const EMPTY = fx("getWorkItemActivity", "200-empty.json");
const REVIEW_PASSED = fx("getWorkItemActivity", "200-review-passed.json");
const RUN = fx("getRun", "200-running.json");
const RUN_LIST = fx("listRuns", "200-page.json");
const REVIEW_INSIGHT = fx("getRunInsight", "200-review-needs-fix.json");

const ITEM = LIST.data[0].id as string;
const SERVER_TEXT = "server text that must never be shown";
const CSP = "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
const PIPE = `#windows-container .fulc-window[data-app-id="pipeline"]`;
const RUNS = `#windows-container .fulc-window[data-app-id="runs"]`;
const tid = (page: Page, id: string) => page.locator(`${PIPE} [data-testid="${id}"]`);
const rtid = (page: Page, id: string) => page.locator(`${RUNS} [data-testid="${id}"]`);
const dlg = (page: Page) => page.locator('dialog[data-testid="pl-op-dialog"]');
const ACCEPTED = { action_id: "77777777-7777-4777-8777-777777777777", state: "accepted" };
const DONE = { action_id: ACCEPTED.action_id, kind: "advance_work_item", target_id: ITEM, state: "done", outcome: null, error_code: null, created_at: "2026-10-03T10:00:00.000Z", finished_at: "2026-10-03T10:00:01.000Z" };
const uuidN = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;

interface Reply {
  status: number;
  json: unknown;
}
interface Mock {
  requests: string[];
  /** Every POST: the path, its body (null when it carried none) and its Idempotency-Key. */
  posts: { path: string; body: string | null }[];
  stage: string;
  kind: string;
  activity: Reply;
  /** What each action route answers (the path's last segment). */
  replies: Record<string, Reply>;
  /** More cards on the board (the deep link has to scroll to one). */
  extra: number;
  /** The work item the Runs app's insight names. */
  insightItem: string;
  /** Items that the single-item read answers 404 for. */
  gone: Set<string>;
  /** The open item's runs (the Runs section's list read). */
  itemRuns: unknown[];
}

const activityFor = (base: Record<string, unknown>, stage: string, actions: string[], closeOnGithub = false) => ({ ...base, stage, actions, close_on_github: closeOnGithub });

async function mockApi(page: Page, init: { stage: string; kind: string; activity: Reply }): Promise<Mock> {
  const mock: Mock = {
    requests: [],
    posts: [],
    stage: init.stage,
    kind: init.kind,
    activity: init.activity,
    replies: {},
    extra: 0,
    insightItem: ITEM,
    gone: new Set(),
    itemRuns: [],
  };
  const send = (route: Route, status: number, json: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(json) }).catch(() => undefined);
  const items = () => [
    { ...LIST.data[0], stage: mock.stage, kind: mock.kind },
    ...Array.from({ length: mock.extra }, (_, i) => ({ ...LIST.data[0], id: uuidN(i + 1), issue_number: 100 + i, stage: mock.stage, kind: mock.kind })),
  ];
  await page.route((u) => u.pathname.startsWith("/api/v1/") && u.pathname !== "/api/v1/events", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    mock.requests.push(`${req.method()} ${p}`);
    if (req.method() === "POST") {
      mock.posts.push({ path: p, body: req.postData() });
      const last = p.split("/").pop()!;
      const r = mock.replies[last];
      if (r) return send(route, r.status, r.json);
      if (last === "close") mock.stage = "closed";
      if (last === "reopen") mock.stage = "triaged";
      if (last === "reopen") return send(route, 200, { work_item_id: ITEM, stage: "triaged" });
      return last === "close" ? send(route, 200, { work_item_id: ITEM, stage: "closed" }) : send(route, 202, ACCEPTED);
    }
    if (p.startsWith("/api/v1/run-actions/")) return send(route, 200, DONE);
    if (p === "/api/v1/work-items") return send(route, 200, { data: items(), next_cursor: null });
    if (/^\/api\/v1\/work-items\/[^/]+$/.test(p)) {
      const id = p.split("/").pop()!;
      const found = items().find((i) => i.id === id);
      return found && !mock.gone.has(id) ? send(route, 200, found) : send(route, 404, { error: { code: "not_found", message: SERVER_TEXT, request_id: "req_1" } });
    }
    if (p === "/api/v1/repos") return send(route, 200, REPOS);
    if (p.endsWith("/timeline")) return send(route, 200, TIMELINE);
    if (p.endsWith("/activity")) return send(route, mock.activity.status, mock.activity.json);
    if (p === "/api/v1/runs") return send(route, 200, url.searchParams.has("work_item_id") ? { data: mock.itemRuns, next_cursor: null } : { data: [{ ...RUN, id: RUN_LIST.data[0].id, status: "succeeded" }], next_cursor: null });
    if (p.endsWith("/insight")) return send(route, 200, { ...REVIEW_INSIGHT, work_item: { ...REVIEW_INSIGHT.work_item, id: mock.insightItem } });
    if (p.endsWith("/events")) return send(route, 200, { data: [], next_cursor: "0" });
    if (p.startsWith("/api/v1/runs/")) return send(route, 200, { ...RUN, id: p.split("/").pop(), status: "succeeded" });
    return send(route, 404, { error: { code: "not_found", message: SERVER_TEXT, request_id: "req_1" } });
  });
  await page.route("**/api/v1/events", (route) => route.fulfill({ status: 200, contentType: "text/event-stream", headers: { "cache-control": "no-store" }, body: "event: idle\ndata: {}\n\n" }));
  return mock;
}

async function boot(page: Page, init: { stage: string; kind: string; activity: Reply }) {
  const errors: string[] = [];
  const browserDialogs: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  // The browser's own confirm()/alert() must never appear: any that does is recorded, and dismissed so the test can fail on it.
  page.on("dialog", (d) => {
    browserDialogs.push(`${d.type()}: ${d.message()}`);
    void d.dismiss();
  });
  await page.addInitScript(() => {
    (window as unknown as { __tt: string[] }).__tt = [];
    document.addEventListener("securitypolicyviolation", (e) => (window as unknown as { __tt: string[] }).__tt.push(e.violatedDirective));
  });
  const mock = await mockApi(page, init);
  await page.route((u) => u.pathname === "/", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": CSP } });
  });
  await bootToDesktop(page);
  await page.evaluate(async () => (await import(new URL("core/cloud-live.js", document.baseURI).href)).default.start());
  return { errors, browserDialogs, mock, tt: () => page.evaluate(() => (window as unknown as { __tt: string[] }).__tt) };
}

async function openPipeline(page: Page, arg?: Record<string, unknown>) {
  await page.evaluate((a) => (window as unknown as { FULCWM: { open: (id: string, arg?: unknown) => void } }).FULCWM.open("pipeline", a), arg);
  await expect(page.locator(PIPE)).toBeVisible();
  await expect(page.locator(PIPE)).not.toHaveClass(/opening/);
}

async function setup(page: Page, init: { stage: string; kind: string; activity: Reply }) {
  const env = await boot(page, init);
  await openPipeline(page);
  await expect(tid(page, "pl-card")).toHaveCount(1);
  return env;
}

async function press(page: Page, locator: ReturnType<Page["locator"]>) {
  if (test.info().project.name === "phone") await locator.tap();
  else await locator.click();
}

async function openDetail(page: Page) {
  await press(page, tid(page, "pl-card").first());
  await expect(tid(page, "pl-live")).toBeVisible();
  // The activity read has answered once the loading sentence is gone.
  await expect(tid(page, "pl-live").locator('[data-testid="pl-live-state"]')).toHaveCount(0);
}

async function expectNoOverflow(page: Page) {
  const r = await tid(page, "pl-detail").evaluate((el) => {
    const box = el as HTMLElement;
    const right = box.getBoundingClientRect().right;
    const wide = [...box.querySelectorAll("*")].filter((n) => n.getBoundingClientRect().width > 0 && n.getBoundingClientRect().right > right + 1).map((n) => n.tagName + "." + (n as HTMLElement).className);
    return { scrollW: box.scrollWidth, clientW: box.clientWidth, wide };
  });
  expect(r.scrollW).toBeLessThanOrEqual(r.clientW + 1);
  expect(r.wide).toEqual([]);
}

const STUCK = activityFor(NEEDS_HUMAN, "needs_human", ["build_again", "back_to_discussion", "close"]);
const PROJECT = activityFor(EMPTY, "discussing", ["treat_as_feature", "close"]);

test.describe("D#483: the buttons for a stuck item (mocked API)", () => {
  test("Needs a person: Build again, Back to discussion and Close, with exactly these words; no Treat as a feature", async ({ page }) => {
    const { errors, browserDialogs, tt } = await setup(page, { stage: "needs_human", kind: "feature", activity: { status: 200, json: STUCK } });
    await openDetail(page);
    await expect(tid(page, "pl-operator")).toBeVisible();
    await expect(tid(page, "pl-operator").locator("button")).toHaveText(["Build again", "Back to discussion", "Close"]);
    await expect(tid(page, "pl-op-feature")).toHaveCount(0);
    // each button has a note that says what it does
    await expect(tid(page, "pl-op-notes")).toContainText("starts a new build from the same Spec");
    await expect(tid(page, "pl-op-notes")).toContainText("asks the panel again");
    await expectNoOverflow(page);
    expect(browserDialogs).toEqual([]);
    expect(await tt()).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("Build again sends one POST to the approve route with NO body, then says it started", async ({ page }) => {
    const { mock } = await setup(page, { stage: "needs_human", kind: "feature", activity: { status: 200, json: STUCK } });
    await openDetail(page);
    await press(page, tid(page, "pl-op-build"));
    await expect(tid(page, "pl-op-note")).toContainText("Started. An agent is building this again from the same Spec");
    expect(mock.posts).toEqual([{ path: `/api/v1/work-items/${ITEM}/approve`, body: null }]);
    // one request at a time: the buttons stop taking presses once it started
    await expect(tid(page, "pl-op-build")).toHaveAttribute("aria-disabled", "true");
    await tid(page, "pl-op-build").dispatchEvent("click");
    await tid(page, "pl-op-back").dispatchEvent("click");
    expect(mock.posts).toHaveLength(1);
    // the run action was followed
    expect(mock.requests.some((r) => r.startsWith("GET /api/v1/run-actions/"))).toBe(true);
  });

  test("Back to discussion sends one POST to its own route with NO body", async ({ page }) => {
    const { mock } = await setup(page, { stage: "needs_human", kind: "feature", activity: { status: 200, json: STUCK } });
    await openDetail(page);
    await press(page, tid(page, "pl-op-back"));
    await expect(tid(page, "pl-op-note")).toContainText("Sent back to the panel");
    expect(mock.posts).toEqual([{ path: `/api/v1/work-items/${ITEM}/back-to-discussion`, body: null }]);
  });

  test("a project at Discussing: Treat as a feature and Close; Treat as a feature sends one POST with NO body", async ({ page }) => {
    const { mock } = await setup(page, { stage: "discussing", kind: "project", activity: { status: 200, json: PROJECT } });
    await openDetail(page);
    await expect(tid(page, "pl-operator").locator("button")).toHaveText(["Treat as a feature", "Close"]);
    await expect(tid(page, "pl-op-build")).toHaveCount(0);
    await expect(tid(page, "pl-op-back")).toHaveCount(0);
    await press(page, tid(page, "pl-op-feature"));
    await expect(tid(page, "pl-op-note")).toContainText("Changed to a feature");
    expect(mock.posts).toEqual([{ path: `/api/v1/work-items/${ITEM}/treat-as-feature`, body: null }]);
  });

  test("Close asks in the app's own dialog first: nothing is sent until Yes, close it; the browser's confirm never appears", async ({ page }) => {
    const { mock, browserDialogs, errors } = await setup(page, { stage: "needs_human", kind: "feature", activity: { status: 200, json: STUCK } });
    await openDetail(page);
    await press(page, tid(page, "pl-op-close"));
    await expect(dlg(page)).toBeVisible();
    await expect(dlg(page).locator("h2")).toHaveText("Close this work item?");
    await expect(dlg(page).locator("button")).toHaveText(["Keep it open", "Yes, close it"]);
    // the safe choice has the focus
    await expect(dlg(page).locator('[data-testid="pl-op-keep"]')).toBeFocused();
    expect(mock.posts).toEqual([]);
    await press(page, dlg(page).locator('[data-testid="pl-op-confirm"]'));
    await expect(dlg(page)).toHaveCount(0);
    // The work is over: the detail goes away, the board is back, and the card is in its new place, highlighted for a moment.
    await expect(tid(page, "pl-detail")).toBeHidden();
    await expect(tid(page, "pl-columns")).toBeVisible();
    await expect(tid(page, "pl-card")).toHaveCount(1);
    await expect(tid(page, "pl-card")).toHaveClass(/pl-card-moved/);
    await expect(tid(page, "pl-card")).toContainText("Closed");
    expect(mock.posts).toEqual([{ path: `/api/v1/work-items/${ITEM}/close`, body: null }]);
    // Close answers at once: no run action is followed
    expect(mock.requests.some((r) => r.startsWith("GET /api/v1/run-actions/"))).toBe(false);
    expect(browserDialogs).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("a closed item offers Reopen: it asks in the app's own dialog, sends one POST with no body, and the card is back in Triaged", async ({ page }) => {
    const closed = activityFor(NEEDS_HUMAN, "closed", ["reopen"]);
    const { mock, browserDialogs, errors } = await setup(page, { stage: "closed", kind: "feature", activity: { status: 200, json: closed } });
    await openDetail(page);
    await expect(tid(page, "pl-operator").locator("button")).toHaveText(["Reopen"]);
    await press(page, tid(page, "pl-op-reopen"));
    await expect(dlg(page).locator("h2")).toHaveText("Reopen this work item?");
    await expect(dlg(page).locator("button")).toHaveText(["Keep it closed", "Yes, reopen it"]);
    expect(mock.posts).toEqual([]);
    await press(page, dlg(page).locator('[data-testid="pl-op-confirm"]'));
    await expect(dlg(page)).toHaveCount(0);
    await expect(tid(page, "pl-op-note")).toHaveText("Reopened. The card is back in Triaged.");
    expect(mock.posts).toEqual([{ path: `/api/v1/work-items/${ITEM}/reopen`, body: null }]);
    expect(mock.requests.some((r) => r.startsWith("GET /api/v1/run-actions/"))).toBe(false);
    expect(browserDialogs).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("after Reopen the card's new buttons can be pressed at once: Close opens its dialog without reopening the card", async ({ page }) => {
    const closed = activityFor(NEEDS_HUMAN, "closed", ["reopen"]);
    const { mock, errors } = await setup(page, { stage: "closed", kind: "feature", activity: { status: 200, json: closed } });
    await openDetail(page);
    // What the server lists once the item is back in Triaged (the read the Reopen asks for).
    mock.activity = { status: 200, json: activityFor(NEEDS_HUMAN, "triaged", ["close"]) };
    await press(page, tid(page, "pl-op-reopen"));
    await press(page, dlg(page).locator('[data-testid="pl-op-confirm"]'));
    await expect(tid(page, "pl-op-note")).toHaveText("Reopened. The card is back in Triaged.");
    await expect(tid(page, "pl-operator").locator("button")).toHaveText(["Close"]);
    await expect(tid(page, "pl-op-close")).toHaveAttribute("aria-disabled", "false");
    await press(page, tid(page, "pl-op-close"));
    await expect(dlg(page).locator("h2")).toHaveText("Close this work item?");
    expect(errors).toEqual([]);
  });

  test("after Build again the buttons stay locked while the server still lists the same ones (no second start)", async ({ page }) => {
    const { mock } = await setup(page, { stage: "needs_human", kind: "feature", activity: { status: 200, json: STUCK } });
    await openDetail(page);
    await press(page, tid(page, "pl-op-build"));
    await expect(tid(page, "pl-op-note")).toHaveAttribute("data-phase", "started");
    await page.clock.runFor(10_500); // a later read that lists the very same buttons
    await expect(tid(page, "pl-op-build")).toHaveAttribute("aria-disabled", "true");
    await tid(page, "pl-op-build").dispatchEvent("click"); // a press anyway (Playwright will not click an aria-disabled button)
    expect(mock.posts.filter((p) => p.path.endsWith("/approve"))).toHaveLength(1);
  });

  test("Keep it open, Escape and a click outside all close the dialog without sending anything; focus returns to Close", async ({ page }) => {
    test.skip(test.info().project.name === "phone", "Escape and an outside click are desktop gestures");
    const { mock } = await setup(page, { stage: "needs_human", kind: "feature", activity: { status: 200, json: STUCK } });
    await openDetail(page);
    await press(page, tid(page, "pl-op-close"));
    await press(page, dlg(page).locator('[data-testid="pl-op-keep"]'));
    await expect(dlg(page)).toHaveCount(0);
    await expect(tid(page, "pl-op-close")).toBeFocused();
    await press(page, tid(page, "pl-op-close"));
    await expect(dlg(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dlg(page)).toHaveCount(0);
    await expect(tid(page, "pl-op-close")).toBeFocused();
    await press(page, tid(page, "pl-op-close"));
    await page.mouse.click(5, 5); // the backdrop, outside the dialog's box
    await expect(dlg(page)).toHaveCount(0);
    expect(mock.posts).toEqual([]);
  });

  test("a refused Close keeps the dialog open with a fixed sentence, never the server's words", async ({ page }) => {
    const { mock } = await setup(page, { stage: "needs_human", kind: "feature", activity: { status: 200, json: STUCK } });
    mock.replies.close = { status: 409, json: { error: { code: "action_not_available", message: SERVER_TEXT, request_id: "req_1" } } };
    await openDetail(page);
    await press(page, tid(page, "pl-op-close"));
    await press(page, dlg(page).locator('[data-testid="pl-op-confirm"]'));
    await expect(dlg(page).locator('[data-testid="pl-op-dialog-error"]')).toContainText("This can't be done from here any more");
    await expect(page.locator("body")).not.toContainText(SERVER_TEXT);
    await press(page, dlg(page).locator('[data-testid="pl-op-keep"]'));
    await expect(dlg(page)).toHaveCount(0);
    await expect(tid(page, "pl-op-note")).toHaveCount(0);
  });

  for (const [name, reply, sentence] of [
    ["already_running", { status: 409, json: { error: { code: "already_running", message: SERVER_TEXT, request_id: "r" } } }, "The agents are already working on this one."],
    ["insufficient_role", { status: 403, json: { error: { code: "insufficient_role", message: SERVER_TEXT, request_id: "r" } } }, "Only an owner or an admin can start this."],
    ["action_not_available", { status: 409, json: { error: { code: "action_not_available", message: SERVER_TEXT, request_id: "r" } } }, "This can't be done from here any more"],
  ] as const) {
    test(`a refusal (${name}) reaches the card as a fixed sentence, and the buttons stay`, async ({ page }) => {
      const { mock } = await setup(page, { stage: "needs_human", kind: "feature", activity: { status: 200, json: STUCK } });
      mock.replies.approve = reply;
      await openDetail(page);
      await press(page, tid(page, "pl-op-build"));
      await expect(tid(page, "pl-op-note")).toContainText(sentence);
      await expect(page.locator("body")).not.toContainText(SERVER_TEXT);
      await expect(tid(page, "pl-op-build")).toHaveAttribute("aria-disabled", "false");
    });
  }

  test("an open pull request has no Close: the card says to close the pull request on GitHub, and offers no button", async ({ page }) => {
    await setup(page, { stage: "review_passed", kind: "feature", activity: { status: 200, json: activityFor(REVIEW_PASSED, "review_passed", [], true) } });
    await openDetail(page);
    await expect(tid(page, "pl-op-host")).toContainText("close its pull request on GitHub");
    await expect(tid(page, "pl-operator").locator("button")).toHaveCount(0);
    await expect(tid(page, "pl-op-close")).toHaveCount(0);
  });

  test("a person who may do nothing here (the server lists no action) sees no section at all", async ({ page }) => {
    await setup(page, { stage: "needs_human", kind: "feature", activity: { status: 200, json: activityFor(NEEDS_HUMAN, "needs_human", []) } });
    await openDetail(page);
    await expect(tid(page, "pl-operator")).toBeHidden();
    await expect(tid(page, "pl-operator").locator("button")).toHaveCount(0);
  });

  test("an action the app does not know, or one the server did not list, is never drawn", async ({ page }) => {
    await setup(page, { stage: "needs_human", kind: "feature", activity: { status: 200, json: activityFor(NEEDS_HUMAN, "needs_human", ["close", "delete_everything", "__proto__"]) } });
    await openDetail(page);
    await expect(tid(page, "pl-operator").locator("button")).toHaveText(["Close"]);
  });

  test("the buttons follow the server's list: when the next read lists other actions, the card shows those", async ({ page }) => {
    const { mock } = await setup(page, { stage: "needs_human", kind: "feature", activity: { status: 200, json: STUCK } });
    await openDetail(page);
    await expect(tid(page, "pl-operator").locator("button")).toHaveText(["Build again", "Back to discussion", "Close"]);
    mock.activity = { status: 200, json: activityFor(NEEDS_HUMAN, "in_progress", ["close"]) };
    await page.clock.runFor(10_500);
    await expect(tid(page, "pl-operator").locator("button")).toHaveText(["Close"]);
  });

  test("when a cancelled run ends, the buttons are read again at once: no reopening the card, no waiting for the next refresh", async ({ page }) => {
    const LIVE_RUN = { ...RUN, id: RUN_LIST.data[0].id, status: "running" };
    const { mock, errors } = await setup(page, { stage: "needs_human", kind: "feature", activity: { status: 200, json: activityFor(NEEDS_HUMAN, "needs_human", []) } });
    mock.itemRuns = [LIVE_RUN]; // read when the detail opens
    await openDetail(page);
    await expect(tid(page, "pl-run")).toHaveAttribute("data-status", "running");
    await expect(tid(page, "pl-operator").locator("button")).toHaveCount(0);
    // Stop the page clock from running on in real time: from here only runFor moves it, so the activity's own 10 s
    // refresh (started when the detail opened) cannot be what brings the buttons.
    const now = await page.evaluate(() => Date.now());
    await page.clock.pauseAt(now + 1_000); // a margin the page can not outrun under load (pauseAt refuses a time already past)
    const reads = mock.requests.filter((r) => r.endsWith("/activity")).length;
    // The person cancels the run (the owner's case on staging): the cancel is followed until the run has ended, and the
    // server now lists the stuck-item actions.
    mock.activity = { status: 200, json: STUCK };
    mock.itemRuns = [{ ...LIVE_RUN, status: "cancelled" }]; // what the run list answers once the cancel is done
    await press(page, tid(page, "pl-cancel"));
    await press(page, page.locator('dialog[data-testid="pl-dialog"] [data-testid="pl-confirm"]'));
    // The follow-up poll is only started once the cancel's POST has answered (the dialog closes then). With the page clock
    // paused, running it on before that moves no timer, so wait for the real state change first.
    await expect(page.locator('dialog[data-testid="pl-dialog"]')).toBeHidden();
    await page.clock.runFor(5_500); // one follow-up read of the cancelled run; well before the activity's own 10 s refresh
    await expect(tid(page, "pl-operator").locator("button")).toHaveText(["Build again", "Back to discussion", "Close"]);
    expect(mock.requests.filter((r) => r.endsWith("/activity")).length).toBe(reads + 1); // exactly the one read the run's end asked for
    expect(errors).toEqual([]);
  });

  test("the buttons are not carried over to another card", async ({ page }) => {
    const { mock } = await setup(page, { stage: "needs_human", kind: "feature", activity: { status: 200, json: STUCK } });
    mock.extra = 1;
    await openDetail(page);
    await expect(tid(page, "pl-op-build")).toBeVisible();
    mock.activity = { status: 200, json: EMPTY };
    await press(page, tid(page, "pl-back"));
    await page.clock.runFor(21_000);
    await expect(tid(page, "pl-card")).toHaveCount(2);
    await press(page, page.locator(`${PIPE} [data-id="${uuidN(1)}"]`));
    await expect(tid(page, "pl-live")).toBeVisible();
    await expect(tid(page, "pl-op-build")).toHaveCount(0);
  });

  test("hostile text from the server never reaches the page, and the document keeps the production CSP", async ({ page }) => {
    const { errors, tt, mock } = await setup(page, { stage: "needs_human", kind: "feature", activity: { status: 200, json: STUCK } });
    mock.replies.approve = { status: 500, json: { error: { code: "<img src=x onerror=alert(1)>", message: "<script>alert(1)</script>", request_id: "r" } } };
    await openDetail(page);
    await press(page, tid(page, "pl-op-build"));
    // The note is the app's own fixed sentence; nothing the server sent became markup (the needs-person fixture's own account
    // is hostile model text too, and is shown as plain text: no element came of it).
    await expect(tid(page, "pl-op-note")).toHaveText("That didn't work. Nothing was started.");
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("<script>");
    expect(await tt()).toEqual([]);
    expect(errors).toEqual([]);
  });
});

test.describe("D#483: Open the work item in Pipeline, from the Runs app (mocked API)", () => {
  async function openRuns(page: Page) {
    await page.evaluate(() => (window as unknown as { FULCWM: { open: (id: string) => void } }).FULCWM.open("runs"));
    await expect(page.locator(RUNS)).toBeVisible();
    await expect(page.locator(RUNS)).not.toHaveClass(/opening/);
    await expect(rtid(page, "runs-row")).toHaveCount(1);
    await press(page, rtid(page, "runs-row").first());
    await expect(rtid(page, "runs-open-item")).toBeVisible();
  }

  test("Pipeline not open yet: it opens with that work item selected, its card scrolled into view, and its detail open", async ({ page }) => {
    const { mock, errors } = await boot(page, { stage: "triaged", kind: "feature", activity: { status: 200, json: EMPTY } });
    mock.extra = 60;
    const target = uuidN(60);
    mock.insightItem = target;
    await openRuns(page);
    await press(page, rtid(page, "runs-open-item"));
    await expect(page.locator(PIPE)).toBeVisible();
    await expect(tid(page, "pl-detail")).toBeVisible();
    await expect(tid(page, "pl-detail")).toContainText("#159");
    // the card is one of 61, far down its column: it was scrolled to
    await expect(page.locator(`${PIPE} [data-id="${target}"]`)).toBeInViewport();
    expect(mock.requests).toContain(`GET /api/v1/work-items/${target}/activity`);
    expect(errors).toEqual([]);
  });

  test("Pipeline already open on another card: the same press switches it to that work item", async ({ page }) => {
    const { mock } = await boot(page, { stage: "triaged", kind: "feature", activity: { status: 200, json: EMPTY } });
    mock.extra = 60;
    await openPipeline(page);
    await expect(tid(page, "pl-card")).toHaveCount(61);
    await press(page, tid(page, "pl-card").first());
    await expect(tid(page, "pl-detail")).toContainText("#42");
    const target = uuidN(45);
    mock.insightItem = target;
    await openRuns(page);
    await press(page, rtid(page, "runs-open-item"));
    await expect(tid(page, "pl-detail")).toContainText("#144");
    await expect(tid(page, "pl-detail")).not.toContainText("#42");
    await expect(page.locator(`${PIPE} [data-id="${target}"]`)).toBeInViewport();
    expect(mock.requests).toContain(`GET /api/v1/work-items/${target}/activity`);
  });

  test("the same card already open is still scrolled into view", async ({ page }) => {
    const { mock } = await boot(page, { stage: "triaged", kind: "feature", activity: { status: 200, json: EMPTY } });
    mock.extra = 60;
    const target = uuidN(60);
    mock.insightItem = target;
    await openPipeline(page, { workItemId: target });
    await expect(tid(page, "pl-detail")).toContainText("#159");
    await page.locator(`${PIPE} .pl-board`).evaluate((el) => (el.scrollTop = 0));
    await openRuns(page);
    await press(page, rtid(page, "runs-open-item"));
    await expect(page.locator(`${PIPE} [data-id="${target}"]`)).toBeInViewport();
  });

  test("a work item that is not on the board says so and opens nothing", async ({ page }) => {
    const { mock } = await boot(page, { stage: "triaged", kind: "feature", activity: { status: 200, json: EMPTY } });
    mock.insightItem = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await openRuns(page);
    await press(page, rtid(page, "runs-open-item"));
    await expect(tid(page, "pl-status")).toHaveText("That work item isn't on the board.");
    await expect(tid(page, "pl-detail")).toBeHidden();
    await expect(page.locator("body")).not.toContainText(SERVER_TEXT);
  });

  test("an argument that is not a work item id opens Pipeline and nothing else", async ({ page }) => {
    const { mock, errors } = await boot(page, { stage: "triaged", kind: "feature", activity: { status: 200, json: EMPTY } });
    await openPipeline(page, { workItemId: "<img src=x onerror=alert(1)>" });
    await expect(tid(page, "pl-card")).toHaveCount(1);
    await expect(tid(page, "pl-detail")).toBeHidden();
    await page.evaluate(() => (window as unknown as { FULCWM: { open: (id: string, arg?: unknown) => void } }).FULCWM.open("pipeline", { workItemId: 7 }));
    await page.evaluate(() => (window as unknown as { FULCWM: { open: (id: string, arg?: unknown) => void } }).FULCWM.open("pipeline", ["x"]));
    await expect(tid(page, "pl-detail")).toBeHidden();
    expect(mock.requests.filter((r) => r.endsWith("/activity"))).toEqual([]);
    expect(errors).toEqual([]);
  });
});

// D#6 R4d-5b (C34 sections 2.3 and 2.4): Re-spec, in both states, with the file-list sentences the server sends (the runner protocol's copy).
test.describe("D#6 R4d-5b: Re-spec (mocked API)", () => {
  const states = [
    { stage: "spec_ready", base: EMPTY, actions: ["respec", "close"], notice: { kind: "no_file_list", reason: COPY.specHasNoFileList }, testid: "pl-no-file-list", buttons: ["Re-spec", "Close"] },
    { stage: "needs_human", base: NEEDS_HUMAN, actions: ["build_again", "respec", "back_to_discussion", "close"], notice: { kind: "no_file_list", reason: COPY.specHasNoFileList }, testid: "pl-no-file-list", buttons: ["Build again", "Re-spec", "Back to discussion", "Close"] },
    { stage: "needs_human", base: NEEDS_HUMAN, actions: ["build_again", "respec", "back_to_discussion", "close"], notice: { kind: "respec_failed", reason: COPY.respecListUnreadable }, testid: "pl-respec-failed", buttons: ["Build again", "Re-spec", "Back to discussion", "Close"] },
  ] as const;

  for (const st of states) {
    test(`${st.stage} / ${st.notice.kind}: the button is Re-spec, the notice is exactly the protocol copy, and nothing is restated`, async ({ page }) => {
      const activity = { ...activityFor(st.base, st.stage, [...st.actions]), notice: st.notice };
      const { errors, browserDialogs, tt } = await setup(page, { stage: st.stage, kind: "feature", activity: { status: 200, json: activity } });
      await openDetail(page);
      await expect(tid(page, "pl-operator").locator("button")).toHaveText([...st.buttons]);
      await expect(tid(page, st.testid)).toHaveText(st.notice.reason);
      await expect(tid(page, "pl-op-notes")).toContainText("add the list of files this Spec allows");
      await expectNoOverflow(page);
      expect(browserDialogs).toEqual([]);
      expect(await tt()).toEqual([]);
      expect(errors).toEqual([]);
    });
  }

  test("pressing Re-spec sends one POST to the respec route with NO body, then says it started and locks the buttons", async ({ page }) => {
    const activity = { ...activityFor(EMPTY, "spec_ready", ["respec", "close"]), notice: { kind: "no_file_list", reason: COPY.specHasNoFileList } };
    const { mock } = await setup(page, { stage: "spec_ready", kind: "feature", activity: { status: 200, json: activity } });
    await openDetail(page);
    await press(page, tid(page, "pl-op-respec"));
    await expect(tid(page, "pl-op-note")).toContainText("The project manager is adding the file list");
    expect(mock.posts).toEqual([{ path: `/api/v1/work-items/${ITEM}/respec`, body: null }]);
    await expect(tid(page, "pl-op-respec")).toHaveAttribute("aria-disabled", "true");
  });
});
