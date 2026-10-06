// apps/workspace/e2e/runs-live.spec.ts
//
// D#37 WS-F2b: the Runs app, live. The built cloud dist is served by
// fixture-server.mjs; every /api/v1 call is answered by page.route() from the
// repo's contract fixtures (packages/api/fixtures/v1/**), so each test can force
// a reply and record what the app sent. The SSE helper below serialises the
// listRunEvents fixture into frames and serves them when the request asks for
// text/event-stream (no .sse fixture file). Account-stream events are put on the
// live client's own BroadcastChannel, the way a non-leader tab hears them (the
// same hook developer-live.spec.ts uses). The document carries the production
// CSP and Trusted Types directives. Every test runs under desktop, phone, tablet.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect, type Page } from "@playwright/test";

const V1 = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "api", "fixtures", "v1");
const readFixture = (...p: string[]) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
const LIST = readFixture("listRuns", "200-page.json");
const RUN = readFixture("getRun", "200-running.json");
const EVENTS = readFixture("listRunEvents", "200-page.json").data as Ev[];

const ID = LIST.data[0].id as string;
const ID2 = "11111111-1111-4111-8111-111111111112";
const CSP = "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
const WIN = `#windows-container .fulc-window[data-app-id="runs"]`;
const tid = (page: Page, id: string) => page.locator(`${WIN} [data-testid="${id}"]`);
const CLAUDE_CODE_RE = /claude[\s_\-. ]*code/i;

interface Ev { seq: number; kind: string; at: string; payload: unknown }
const ev = (seq: number, kind: string, payload: unknown): Ev => ({ seq, kind, at: "2026-09-18T12:00:00.000Z", payload });

/** The SSE helper: fixture events as frames (id, event: run_event, data), then an optional end frame. */
const frames = (events: Ev[], end?: string) =>
  events.map((e) => `id: ${e.seq}\nevent: run_event\ndata: ${JSON.stringify(e)}\n\n`).join("") + (end ? `event: end\ndata: ${JSON.stringify({ status: end })}\n\n` : "");

interface Mock {
  requests: string[];
  streams: { path: string; lastEventId: string }[];
  open: number;
  maxOpen: number;
  hold: boolean; // the stream request stays pending until the client aborts it
  runStatus: string; // what GET /api/v1/runs/{id} says
  listStatus: string;
  json: Ev[]; // what the JSON pages serve
  replay: number; // the first JSON page holds this many events
  sse: Ev[]; // what the stream serves
  end: string;
  rereadStatus: number;
}

async function mockApi(page: Page): Promise<Mock> {
  const mock: Mock = { requests: [], streams: [], open: 0, maxOpen: 0, hold: false, runStatus: "running", listStatus: "running", json: EVENTS, replay: 4, sse: EVENTS, end: "succeeded", rereadStatus: 200 };
  const json = (route: import("@playwright/test").Route, status: number, body: unknown) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  page.on("requestfailed", (r) => { if (/^\/api\/v1\/runs\/[^/]+\/events$/.test(new URL(r.url()).pathname) && (r.headers()["accept"] ?? "").includes("text/event-stream")) mock.open--; });
  await page.route((u) => u.pathname.startsWith("/api/v1/runs"), async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    mock.requests.push(`${req.method()} ${url.pathname}${url.search}`);
    if (url.pathname === "/api/v1/runs") {
      if (url.searchParams.get("cursor")) return json(route, 200, { data: [{ ...LIST.data[0], id: ID2, role: "review", usd: null, status: "running" }], next_cursor: "" });
      return json(route, 200, { data: [{ ...LIST.data[0], status: mock.listStatus }], next_cursor: LIST.next_cursor });
    }
    if (url.pathname.endsWith("/events")) {
      if ((req.headers()["accept"] ?? "").includes("text/event-stream")) {
        mock.streams.push({ path: url.pathname, lastEventId: req.headers()["last-event-id"] ?? "" });
        mock.maxOpen = Math.max(mock.maxOpen, ++mock.open);
        if (mock.hold) return new Promise<void>(() => {});
        mock.open--;
        // The server resumes after Last-Event-ID; the mock also resends that one event, so the overlap must be dropped.
        const from = Number(req.headers()["last-event-id"] ?? 0);
        return route.fulfill({ status: 200, contentType: "text/event-stream", body: frames(mock.sse.filter((e) => e.seq >= from), mock.end) }).catch(() => undefined);
      }
      const after = url.searchParams.get("after_seq") ?? url.searchParams.get("cursor");
      if (after !== null && url.searchParams.get("after_seq") !== null && mock.rereadStatus !== 200) return json(route, mock.rereadStatus, { error: { code: "internal_error", message: "server text that must never be shown", request_id: "r" } });
      const limit = Number(url.searchParams.get("limit") ?? 50);
      let data = mock.json.filter((e) => e.seq > Number(after ?? 0)).slice(0, limit);
      if (after === null) data = data.slice(0, mock.replay);
      return json(route, 200, { data, next_cursor: data.length ? String(data[data.length - 1].seq) : String(after ?? 0) });
    }
    return json(route, 200, { ...RUN, id: url.pathname.split("/").pop(), status: mock.runStatus });
  });
  await page.route("**/api/v1/events", (route) => route.fulfill({ status: 200, contentType: "text/event-stream", headers: { "cache-control": "no-store" }, body: "event: idle\ndata: {}\n\n" }));
  return mock;
}

async function watch(page: Page) {
  const w = { errors: [] as string[] };
  page.on("console", (m) => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) w.errors.push(m.text()); });
  page.on("pageerror", (e) => w.errors.push(`pageerror: ${e.message}`));
  return w;
}

async function boot(page: Page) {
  await page.route((u) => u.pathname === "/", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": CSP } });
  });
  await page.goto("/");
  await page.waitForFunction(() => (window as unknown as { currentStep?: string }).currentStep === "DESKTOP", null, { timeout: 30_000 });
}

const wm = (page: Page, fn: "open" | "close") => page.evaluate((f) => (window as unknown as { FULCWM: Record<string, (id: string) => void> }).FULCWM[f]("runs"), fn);
async function openRuns(page: Page) {
  await wm(page, "open");
  await expect(page.locator(WIN)).toBeVisible();
  await expect(page.locator(WIN)).not.toHaveClass(/opening/);
}

async function setup(page: Page, tweak?: (m: Mock) => void) {
  const w = await watch(page);
  const mock = await mockApi(page);
  tweak?.(mock);
  await boot(page);
  await openRuns(page);
  return { w, mock };
}

async function press(page: Page, locator: ReturnType<typeof tid>) {
  if (test.info().project.name === "phone") await locator.tap();
  else await locator.click();
}
async function openFirstRun(page: Page) {
  await expect(tid(page, "runs-row").first()).toBeVisible();
  await press(page, tid(page, "runs-row").first());
  await expect(tid(page, "runs-head")).toBeVisible();
}
const seqs = (page: Page) => tid(page, "run-event").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.seq));

/** One account-stream event on the live client's channel, as the leader tab would send it. */
async function sendEvent(page: Page, type: string, data: Record<string, unknown>) {
  await page.evaluate(async ([t, d]) => {
    const ns = await import(new URL("core/storage-ns.js", document.baseURI).href);
    const ch = new BroadcastChannel("fx-live-" + (ns.getNamespace() || "default"));
    ch.postMessage({ type: "event", event: { id: "e-" + Math.random(), type: t, created_at: new Date().toISOString(), data: d } });
    ch.close();
  }, [type, data] as const);
}
const subscriberCount = (page: Page) => page.evaluate(async () => (await import(new URL("core/cloud-live.js", document.baseURI).href)).subscriberCount());

async function assertClean(page: Page, w: { errors: string[] }, where: string) {
  expect(w.errors, `console at ${where}`).toEqual([]);
  const text = await page.locator("body").innerText();
  expect(text, `ApiError at ${where}`).not.toMatch(/ApiError|Could not load/);
  expect(text, `innerText at ${where}`).not.toMatch(CLAUDE_CODE_RE);
  expect(await page.title()).not.toMatch(CLAUDE_CODE_RE);
  const hits = await page.evaluate(() => {
    const out: string[] = [];
    document.querySelectorAll("[title], [aria-label], [placeholder]").forEach((el) => {
      for (const a of ["title", "aria-label", "placeholder"]) if (/claude[\s_\-. ]*code/i.test(el.getAttribute(a) ?? "")) out.push(a);
    });
    return out;
  });
  expect(hits).toEqual([]);
}

test.describe("D#37 WS-F2b: Runs app live (mocked API)", () => {
  test("the detail replays, then the stream adds the rest with no duplicate, and the end frame settles the chip", async ({ page }) => {
    const { w, mock } = await setup(page);
    await openFirstRun(page);
    await expect(tid(page, "run-event")).toHaveCount(EVENTS.length);
    expect(await seqs(page)).toEqual(EVENTS.map((e) => String(e.seq)));
    // The stream was opened once, after the replay, from the last replayed seq.
    expect(mock.streams).toEqual([{ path: `/api/v1/runs/${ID}/events`, lastEventId: "4" }]);
    await expect(tid(page, "runs-head").locator('[data-testid="runs-chip"]')).toHaveText("Succeeded");
    await page.waitForTimeout(500);
    expect(mock.streams).toHaveLength(1); // end is terminal: no reconnect
    await assertClean(page, w, "live detail");
    expect(await seqs(page)).toEqual(EVENTS.map((e) => String(e.seq))); // still no duplicates
  });

  test("a terminal run opens no stream", async ({ page }) => {
    const { mock } = await setup(page, (m) => { m.runStatus = "succeeded"; m.replay = 200; });
    await openFirstRun(page);
    await expect(tid(page, "run-event")).toHaveCount(EVENTS.length);
    await page.waitForTimeout(500);
    expect(mock.streams).toEqual([]);
  });

  test("a truncated frame is re-read once, and the whole event replaces the line", async ({ page }) => {
    const full = ev(10, "agent.output", { text: "The whole event, read again." });
    const { w, mock } = await setup(page, (m) => {
      m.json = [...EVENTS, full];
      m.sse = [...EVENTS, ev(10, "agent.output", { truncated: true, original_bytes: 70000 })];
      m.replay = 9;
      m.end = "";
    });
    await openFirstRun(page);
    await expect(tid(page, "run-event")).toHaveCount(10);
    await expect(tid(page, "run-event").last()).toContainText("The whole event, read again.");
    await expect(tid(page, "run-event-truncated")).toHaveCount(0);
    expect(mock.requests.filter((r) => r.includes("after_seq=9&limit=1"))).toHaveLength(1);
    await assertClean(page, w, "truncated re-read");
  });

  test("when the re-read fails the 'too large' line stays", async ({ page }) => {
    const { w, mock } = await setup(page, (m) => {
      m.json = EVENTS;
      m.sse = [...EVENTS, ev(10, "agent.output", { truncated: true, original_bytes: 70000 })];
      m.replay = 9;
      m.end = "";
      m.rereadStatus = 500;
    });
    await openFirstRun(page);
    await expect(tid(page, "run-event-truncated")).toContainText("70000 bytes");
    await expect.poll(() => mock.requests.filter((r) => r.includes("after_seq=9&limit=1")).length).toBe(1);
    await page.waitForTimeout(300);
    await expect(tid(page, "run-event-truncated")).toHaveCount(1);
    await assertClean(page, w, "failed re-read");
  });

  test("a string from the re-read goes through the display filter", async ({ page }) => {
    const { w } = await setup(page, (m) => {
      m.json = [...EVENTS, ev(10, "agent.output", { text: "Started Claude   Code today." })];
      m.sse = [...EVENTS, ev(10, "agent.output", { truncated: true, original_bytes: 70000 })];
      m.replay = 9;
      m.end = "";
    });
    await openFirstRun(page);
    await expect(tid(page, "run-event").last()).toContainText("Started Claude today.");
    await assertClean(page, w, "filtered re-read");
  });

  test("at most one run stream is open: focusing another run closes the first", async ({ page }) => {
    const { mock } = await setup(page, (m) => { m.hold = true; });
    await openFirstRun(page);
    await expect.poll(() => mock.open).toBe(1);
    await press(page, tid(page, "runs-back"));
    await expect.poll(() => mock.open).toBe(0); // closing the detail closes its stream
    await press(page, tid(page, "runs-more"));
    await expect(tid(page, "runs-row")).toHaveCount(2);
    await press(page, tid(page, "runs-row").first());
    await expect.poll(() => mock.open).toBe(1);
    await tid(page, "runs-row").nth(1).evaluate((el) => (el as HTMLElement).click()); // a second run, without going Back (the pane covers the list)
    await expect.poll(() => mock.streams.length).toBe(2);
    await expect.poll(() => mock.open).toBe(1);
    expect(mock.maxOpen).toBe(1);
  });

  test("closing the window closes the run stream; 20 open/close cycles leave the subscriber count at baseline", async ({ page }) => {
    test.setTimeout(180_000);
    const { mock } = await setup(page, (m) => { m.hold = true; });
    await wm(page, "close");
    await expect(page.locator(WIN)).toHaveCount(0);
    const baseline = await subscriberCount(page);
    for (let i = 0; i < 20; i++) {
      await openRuns(page);
      await expect.poll(() => subscriberCount(page)).toBeGreaterThan(baseline);
      await openFirstRun(page);
      await expect.poll(() => mock.streams.length).toBe(i + 1);
      await wm(page, "close");
      await expect(page.locator(WIN)).toHaveCount(0);
      await expect.poll(() => subscriberCount(page)).toBe(baseline);
    }
    await expect.poll(() => mock.open).toBe(0);
    expect(mock.maxOpen).toBe(1);
  });

  test("run.status_changed moves the list chip with no reload; a bad id is ignored; an unseen run is added on top", async ({ page }) => {
    const { w, mock } = await setup(page);
    await expect(tid(page, "runs-row")).toHaveCount(1);
    await expect(tid(page, "runs-chip").first()).toHaveText("Running");
    const listGets = () => mock.requests.filter((r) => r.startsWith("GET /api/v1/runs?")).length;
    const before = listGets();
    await sendEvent(page, "run.status_changed", { runId: "not-a-uuid" });
    await sendEvent(page, "run.status_changed", { runId: "x/y" });
    await page.waitForTimeout(400);
    expect(mock.requests.filter((r) => /^GET \/api\/v1\/runs\/[^/?]+$/.test(r))).toHaveLength(0);
    mock.runStatus = "succeeded";
    await sendEvent(page, "run.status_changed", { runId: ID });
    await expect(tid(page, "runs-chip").first()).toHaveText("Succeeded");
    expect(mock.requests.filter((r) => r === `GET /api/v1/runs/${ID}`)).toHaveLength(1);
    expect(listGets()).toBe(before); // one run GET, no list reload
    await sendEvent(page, "run.status_changed", { runId: ID2 });
    await expect(tid(page, "runs-row")).toHaveCount(2);
    await expect(tid(page, "runs-row").first()).toHaveAttribute("data-id", ID2);
    await assertClean(page, w, "status change");
  });

  test("a refresh re-fetches the first page, keeps the open detail and the rows Show more added", async ({ page }) => {
    const { w, mock } = await setup(page, (m) => { m.hold = true; });
    await press(page, tid(page, "runs-more"));
    await expect(tid(page, "runs-row")).toHaveCount(2);
    await openFirstRun(page);
    await expect.poll(() => mock.open).toBe(1);
    await page.waitForTimeout(10_500); // the client's backstop runs at most once per 10 s, and boot already used one
    const before = mock.requests.filter((r) => r === "GET /api/v1/runs?limit=50").length;
    mock.listStatus = "succeeded";
    await page.evaluate(() => window.dispatchEvent(new Event("focus"))); // the client's backstop tells subscribers to refresh
    await expect.poll(() => mock.requests.filter((r) => r === "GET /api/v1/runs?limit=50").length).toBe(before + 1);
    await expect(tid(page, "runs-row").first().locator('[data-testid="runs-chip"]')).toHaveText("Succeeded");
    await expect(tid(page, "runs-row")).toHaveCount(2);
    await expect(tid(page, "runs-head")).toBeVisible();
    expect(mock.open).toBe(1); // the detail's stream was not touched
    await assertClean(page, w, "refresh");
  });

  test("a hidden tab closes the run stream within 10 s and a return reopens it from the last seq", async ({ page }) => {
    const { mock } = await setup(page, (m) => { m.hold = true; });
    await openFirstRun(page);
    await expect.poll(() => mock.open).toBe(1);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect.poll(() => mock.open, { timeout: 10_000 }).toBe(0);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect.poll(() => mock.open).toBe(1);
    expect(mock.streams.at(-1)!.lastEventId).toBe("4");
  });
});
