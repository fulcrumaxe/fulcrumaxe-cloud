// apps/workspace/e2e/runs.spec.ts
//
// D#37 WS-F2a: the Runs app, the run list and one run's replayed events. The
// built cloud dist is served by fixture-server.mjs; /api/v1/runs and its per-run
// routes are answered by page.route() from the repo's contract fixtures
// (packages/api/fixtures/v1/**), so each test can force a reply and record the
// requests the app sent. 4xx/5xx replies are mocked inline and are not fixture
// files. The document carries the production CSP and Trusted Types directives,
// so a sink in the app or the markdown renderer fails here for real. Every test
// runs under the desktop and phone projects.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";
import { waitForDesktop } from "./helpers/boot";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const V1 = join(SCRIPT_DIR, "..", "..", "..", "packages", "api", "fixtures", "v1");
const readFixture = (...p: string[]) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
const LIST = readFixture("listRuns", "200-page.json");
const RUN = { ...readFixture("getRun", "200-running.json"), usd: 0.5 };
const EVENTS = readFixture("listRunEvents", "200-page.json");

const ID = LIST.data[0].id as string;
const ID2 = "11111111-1111-4111-8111-111111111112";
const CSP =
  "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
const WIN = `#windows-container .fulc-window[data-app-id="runs"]`;
const tid = (page: Page, id: string) => page.locator(`${WIN} [data-testid="${id}"]`);
const CLAUDE_CODE_RE = /claude[\s_\-. ]*code/i;

interface Ev {
  seq: number;
  kind: string;
  at: string;
  payload: unknown;
}
interface Mock {
  requests: string[];
  acceptHeaders: string[];
  list: { data: unknown[]; next_cursor: string };
  page2: { data: unknown[]; next_cursor: string };
  moreStatus: number;
  eventsDelayMs: number;
  runStatus: number;
  eventsStatus: number;
  events: Ev[];
}

const ev = (seq: number, kind: string, payload: unknown): Ev => ({ seq, kind, at: "2026-09-18T12:00:00.000Z", payload });

async function mockApi(page: Page): Promise<Mock> {
  const mock: Mock = {
    requests: [],
    acceptHeaders: [],
    list: LIST,
    moreStatus: 200,
    eventsDelayMs: 0,
    page2: { data: [{ ...LIST.data[0], id: ID2, role: "review", usd: null, status: "running" }], next_cursor: "" },
    runStatus: 200,
    eventsStatus: 200,
    events: EVENTS.data,
  };
  const json = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  const err = (code: string) => ({ error: { code, message: "server text that must never be shown", request_id: "req_1" } });
  await page.route((u) => u.pathname.startsWith("/api/v1/runs"), async (route) => {
    // WS-F2b: a running run opens its live stream. These tests are about the replay, so the stream
    // idles at once and is not logged; runs-live.spec.ts covers the stream itself.
    if ((route.request().headers()["accept"] ?? "").includes("text/event-stream")) {
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: idle\ndata: {}\n\n" });
    }
    const url = new URL(route.request().url());
    mock.requests.push(`${route.request().method()} ${url.pathname}${url.search}`);
    if (url.pathname === "/api/v1/runs") {
      if (!url.searchParams.get("cursor")) return json(route, 200, mock.list);
      return mock.moreStatus !== 200 ? json(route, mock.moreStatus, err("internal_error")) : json(route, 200, mock.page2);
    }
    if (url.pathname.endsWith("/events")) {
      mock.acceptHeaders.push(route.request().headers()["accept"] ?? "");
      if (mock.eventsStatus !== 200) return json(route, mock.eventsStatus, err("internal_error"));
      // The API's JSON cursor is always resumable: here it is the last seq returned.
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const from = Number(url.searchParams.get("cursor") ?? 0);
      const data = mock.events.filter((e) => e.seq > from).slice(0, limit);
      if (mock.eventsDelayMs) await new Promise((r) => setTimeout(r, mock.eventsDelayMs));
      // A request the app aborted meanwhile can no longer be fulfilled; that is not a failure here.
      return json(route, 200, { data, next_cursor: data.length ? String(data[data.length - 1].seq) : String(from) }).catch(() => undefined);
    }
    if (mock.runStatus !== 200) return json(route, mock.runStatus, err(mock.runStatus === 404 ? "not_found" : "internal_error"));
    return json(route, 200, { ...RUN, id: url.pathname.split("/").pop() });
  });
  // The account stream: held open and silent. (An idle reply would make the next click reopen it, and the
  // client refreshes on a reopen: the list-request counts below are about the replay, not the live update.)
  await page.route("**/api/v1/events", () => new Promise<void>(() => {}));
  return mock;
}

async function boot(page: Page) {
  await page.route((u) => u.pathname === "/", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": CSP } });
  });
  await page.goto("/");
  await waitForDesktop(page); // presses RETRY if a loaded machine ran out boot's 5 s mode budget
}

async function openRuns(page: Page) {
  await page.locator('.dock-icon[data-app-id="runs"]').click();
  await expect(page.locator(WIN)).toBeVisible();
  await expect(page.locator(WIN)).not.toHaveClass(/opening/);
}

async function watch(page: Page) {
  const w = { errors: [] as string[] };
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) w.errors.push(m.text());
  });
  page.on("pageerror", (e) => w.errors.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => {
    // WS-F2b: the live client turns a window focus into a list refresh; the replay tests count list requests exactly.
    window.addEventListener("focus", (e) => e.stopImmediatePropagation(), true);
    (window as unknown as { __tt: string[] }).__tt = [];
    document.addEventListener("securitypolicyviolation", (e) => (window as unknown as { __tt: string[] }).__tt.push(e.violatedDirective));
  });
  return { ...w, tt: () => page.evaluate(() => (window as unknown as { __tt: string[] }).__tt) };
}

async function setup(page: Page, tweak?: (m: Mock) => void) {
  const w = await watch(page);
  const mock = await mockApi(page);
  tweak?.(mock);
  await boot(page);
  await openRuns(page);
  return { w, mock };
}

/** A tap on a touch project, a click on the desktop one. */
async function press(page: Page, locator: ReturnType<typeof tid>) {
  if (test.info().project.name === "phone") await locator.tap();
  else await locator.click();
}

async function openFirstRun(page: Page) {
  await expect(tid(page, "runs-row")).toHaveCount(1);
  await press(page, tid(page, "runs-row").first());
  await expect(tid(page, "runs-head")).toBeVisible();
}

// The same assertion claude-code-gate.spec.ts makes, copied so this file does not import that spec.
async function assertNoClaudeCode(page: Page, where: string) {
  expect(await page.title(), `document.title at ${where}`).not.toMatch(CLAUDE_CODE_RE);
  expect(await page.locator("body").innerText(), `innerText at ${where}`).not.toMatch(CLAUDE_CODE_RE);
  const hits = await page.evaluate(() => {
    const out: string[] = [];
    const re = /claude[\s_\-. ]*code/i;
    document.querySelectorAll("[title], [aria-label], [placeholder]").forEach((el) => {
      for (const a of ["title", "aria-label", "placeholder"]) {
        const v = el.getAttribute(a);
        if (v && re.test(v)) out.push(`${a}="${v}" on <${el.tagName.toLowerCase()}>`);
      }
    });
    return out;
  });
  expect(hits, `title/aria-label/placeholder at ${where}`).toEqual([]);
}

test.describe("D#37 WS-F2a: Runs app (mocked API)", () => {
  test("list: one request on open, rows carry role, chip, usd and time, Show more appends and then hides", async ({ page }) => {
    const { w, mock } = await setup(page);
    await expect(tid(page, "runs-row")).toHaveCount(1);
    expect(mock.requests).toEqual(["GET /api/v1/runs?limit=50"]);
    const row = tid(page, "runs-row").first();
    await expect(row).toContainText("fulcrumaxe build");
    await expect(row.locator('[data-testid="runs-chip"]')).toHaveText("Succeeded");
    await expect(row.locator('[data-testid="runs-usd"]')).toHaveText("$1.25");
    await expect(row.locator("time")).toHaveAttribute("datetime", "2026-09-18T12:00:00.000Z");
    await expect(tid(page, "runs-more")).toBeVisible();

    await press(page, tid(page, "runs-more"));
    await expect(tid(page, "runs-row")).toHaveCount(2);
    await expect(tid(page, "runs-row").nth(1)).toContainText("fulcrumaxe review");
    await expect(tid(page, "runs-row").nth(1).locator('[data-testid="runs-usd"]')).toHaveText("—");
    await expect(tid(page, "runs-more")).toBeHidden();
    expect(mock.requests.filter((r) => r.startsWith("GET /api/v1/runs?"))).toHaveLength(2);
    expect(mock.requests[1]).toContain("cursor=");
    expect(w.errors).toEqual([]);
    expect(await w.tt()).toEqual([]);
  });

  test("detail: one run request, JSON events, header, and each kind drawn as text", async ({ page }) => {
    const { w, mock } = await setup(page);
    await openFirstRun(page);
    const runReqs = mock.requests.filter((r) => r === `GET /api/v1/runs/${ID}`);
    expect(runReqs).toHaveLength(1);
    const eventReqs = mock.requests.filter((r) => r.includes("/events"));
    expect(eventReqs).toHaveLength(1);
    expect(mock.acceptHeaders.every((a) => a.includes("application/json"))).toBe(true);

    const head = tid(page, "runs-head");
    await expect(head).toContainText("fulcrumaxe build");
    await expect(head.locator('[data-testid="runs-chip"]')).toHaveText("Running");
    await expect(tid(page, "runs-head-usd")).toHaveText("$0.50");

    const items = tid(page, "run-event");
    await expect(items).toHaveCount(9);
    await expect(items.nth(0)).toContainText("Started: fulcrumaxe build");
    await expect(items.nth(7)).toContainText("tool.invoked");
    await expect(items.nth(7)).not.toContainText("not shown"); // an unknown kind shows no payload
    await expect(items.nth(8)).toContainText("Running → Succeeded");
    // Hostile markdown is inert in a real browser under the production CSP.
    await expect(items.nth(1)).toContainText("[x](javascript:alert(1))");
    await expect(items.nth(3)).toContainText("<img src=x onerror=x>");
    await expect(items.nth(4)).toContainText("[x](javascript:alert)"); // the paren-free script-scheme case
    await expect(page.locator(`${WIN} [data-testid="runs-detail"] a`)).toHaveCount(0);
    await expect(page.locator(`${WIN} [data-testid="runs-detail"] img`)).toHaveCount(0);
    expect(await page.locator(`${WIN} [data-testid="runs-detail"] [onmouseover], ${WIN} [data-testid="runs-detail"] [onerror]`).count()).toBe(0);
    // The two spellings in the fixture are drawn without the tool name.
    await expect(items.nth(5)).toHaveText(/Generated with Claude$/);
    await expect(items.nth(6)).toContainText("the tool is Claude here");
    expect(w.errors).toEqual([]);
    expect(await w.tt()).toEqual([]);
    await assertNoClaudeCode(page, "run detail");
  });

  test("no tool name anywhere in the list, the detail or the page chrome", async ({ page }) => {
    await setup(page);
    await assertNoClaudeCode(page, "run list");
    await openFirstRun(page);
    await assertNoClaudeCode(page, "run detail");
  });

  test("markdown: emphasis, code, lists, and an https link with rel; a name split by emphasis is still filtered", async ({ page }) => {
    await setup(page, (m) => {
      m.events = [
        ev(1, "agent.output", { text: "**bold** and *soft* and `code`\n\n- one\n- two\n\nSee [the docs](https://example.com/docs)." }),
        ev(2, "agent.output", { text: "Made with Claude *Code* and `claude` `code`" }),
        ev(3, "agent.output", { text: "```\nlet a = '<b>x</b>';\n```" }),
      ];
    });
    await openFirstRun(page);
    const items = tid(page, "run-event");
    await expect(items).toHaveCount(3);
    await expect(items.nth(0).locator("strong")).toHaveText("bold");
    await expect(items.nth(0).locator("em")).toHaveText("soft");
    await expect(items.nth(0).locator("li")).toHaveCount(2);
    const link = items.nth(0).locator("a");
    await expect(link).toHaveAttribute("href", "https://example.com/docs");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(items.nth(2).locator("pre")).toHaveText("let a = '<b>x</b>';");
    await expect(items.nth(2).locator("b")).toHaveCount(0);
    await assertNoClaudeCode(page, "markdown");
  });

  test("other kinds: checkpoint, limit_extended, a too-large event, a text-less agent row", async ({ page }) => {
    await setup(page, (m) => {
      m.events = [
        ev(1, "checkpoint", { hash: "abc" }),
        ev(2, "limit_extended", { kind: "per_run_usd" }),
        ev(3, "limit_extended", { kind: "Not Short <b>" }),
        ev(4, "agent.output", { truncated: true, original_bytes: 70000 }),
        ev(5, "agent.output", { note: 1 }),
        ev(6, "weird", null),
        { seq: 7, kind: "run.status_changed", at: "not a date", payload: { from: "queued_x", to: "claude code" } } as Ev,
      ];
    });
    await openFirstRun(page);
    const items = tid(page, "run-event");
    await expect(items).toHaveCount(7);
    await expect(items.nth(0)).toHaveText(/Checkpoint saved$/);
    await expect(items.nth(1)).toContainText("Limit extended (per_run_usd)");
    await expect(items.nth(2)).toHaveText(/Limit extended$/);
    await expect(items.nth(3)).toContainText("This event is too large to show live (70000 bytes).");
    await expect(items.nth(4)).toHaveText(/agent\.output$/);
    await expect(items.nth(5)).toHaveText(/weird$/);
    await expect(items.nth(6)).toContainText("queued_x → Claude");
    await expect(items.nth(6).locator("time")).toHaveCount(0);
    await assertNoClaudeCode(page, "other kinds");
  });

  test("cap: 2,000 events show, with the more-events note; exactly 2,000 shows no note", async ({ page }) => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ev(i + 1, "checkpoint", {}));
    await setup(page, (m) => (m.events = many(2001)));
    await openFirstRun(page);
    await expect(tid(page, "run-event")).toHaveCount(2000);
    await expect(tid(page, "runs-capped")).toHaveText("This run has more events than the window shows.");
  });

  test("cap: exactly 2,000 events has no note", async ({ page }) => {
    await setup(page, (m) => (m.events = Array.from({ length: 2000 }, (_, i) => ev(i + 1, "checkpoint", {}))));
    await openFirstRun(page);
    await expect(tid(page, "run-event")).toHaveCount(2000);
    await expect(tid(page, "runs-capped")).toHaveCount(0);
  });

  test("keyboard: Enter on a row opens the detail, Back returns focus to the row", async ({ page }) => {
    await setup(page);
    await expect(tid(page, "runs-row")).toHaveCount(1);
    await tid(page, "runs-row").first().focus();
    await page.keyboard.press("Enter");
    await expect(tid(page, "runs-head")).toBeVisible();
    await expect(tid(page, "runs-back")).toBeFocused();
    await page.keyboard.press("Enter"); // Back has focus
    await expect(tid(page, "runs-detail")).toBeHidden();
    await expect(tid(page, "runs-row").first()).toBeFocused();
  });

  for (const status of [404, 500]) {
    test(`errors: a ${status} on the detail says so inside the detail and leaves the list alone`, async ({ page }) => {
      const { mock } = await setup(page, (m) => (m.runStatus = status));
      await expect(tid(page, "runs-row")).toHaveCount(1);
      await press(page, tid(page, "runs-row").first());
      await expect(tid(page, "runs-detail-error")).toHaveText("This run isn't available right now.");
      await expect(tid(page, "runs-detail")).not.toContainText("server text that must never be shown");
      await expect(tid(page, "runs-row")).toHaveCount(1); // the list is unaffected
      await expect(tid(page, "runs-status")).toBeEmpty();
      await press(page, tid(page, "runs-back"));
      await expect(tid(page, "runs-detail")).toBeHidden();
      expect(mock.requests.filter((r) => r === "GET /api/v1/runs?limit=50")).toHaveLength(1);
    });
  }

  test("errors: a failed events request gives the same message", async ({ page }) => {
    await setup(page, (m) => (m.eventsStatus = 500));
    await expect(tid(page, "runs-row")).toHaveCount(1);
    await press(page, tid(page, "runs-row").first());
    await expect(tid(page, "runs-detail-error")).toHaveText("This run isn't available right now.");
  });

  test("WS-F2c: only a strict ISO-8601 time is drawn; nothing else reaches a title or datetime", async ({ page }) => {
    const bad = ["Claude Code Jan 1 2026", "2026-13-01T00:00:00Z", ""];
    const good = "2026-09-30T12:00:00Z";
    const uid = (n: number) => `22222222-2222-4222-8222-22222222222${n}`;
    await setup(page, (m) => {
      m.list = { data: [...bad, good].map((created_at, i) => ({ ...LIST.data[0], id: uid(i), created_at })), next_cursor: "" };
      m.events = [...bad, good].map((at, i) => ({ seq: i + 1, kind: "checkpoint", at, payload: {} }));
    });
    await expect(tid(page, "runs-row")).toHaveCount(4);
    await expect(page.locator(`${WIN} [data-testid="runs-list"] time`)).toHaveCount(1);
    await expect(page.locator(`${WIN} [data-testid="runs-list"] time`)).toHaveAttribute("datetime", good);
    await press(page, tid(page, "runs-row").first());
    await expect(tid(page, "run-event")).toHaveCount(4);
    await expect(page.locator(`${WIN} [data-testid="runs-events"] time`)).toHaveCount(1);
    const attrs = await page.locator(`${WIN} [title], ${WIN} [datetime]`).evaluateAll((els) =>
      els.flatMap((el) => [el.getAttribute("title") ?? "", el.getAttribute("datetime") ?? ""])
    );
    expect(attrs.filter((a) => CLAUDE_CODE_RE.test(a) || /Jan 1 2026|2026-13/.test(a))).toEqual([]);
    await assertNoClaudeCode(page, "timestamps");
  });

  test("WS-F2c: neighbouring events never read as the tool name across the item boundary", async ({ page }) => {
    const pairs = [["Claude", "Code"], ["Claude ", " code"], ["Claude_", "-Code"]];
    await setup(page, (m) => {
      m.events = pairs.flatMap((p, i) => p.map((text, j) => ({ seq: i * 2 + j + 1, kind: "agent.output", at: "", payload: { text } })));
    });
    await openFirstRun(page);
    await expect(tid(page, "run-event")).toHaveCount(6);
    await assertNoClaudeCode(page, "event boundary");
    const detail = await tid(page, "runs-detail").innerText();
    expect(detail).not.toMatch(CLAUDE_CODE_RE);
    expect(detail).toMatch(/claude/i);
  });

  test("WS-F2c: a failed Show more says so, stays usable, and a good retry removes the message", async ({ page }) => {
    const { w, mock } = await setup(page, (m) => (m.moreStatus = 500));
    await expect(tid(page, "runs-row")).toHaveCount(1);
    await expect(tid(page, "runs-more-error")).toBeHidden();
    await press(page, tid(page, "runs-more"));
    await expect(tid(page, "runs-more-error")).toHaveText("Couldn't load more runs. Try again.");
    await expect(tid(page, "runs-more")).toBeEnabled();
    await expect(tid(page, "runs-row")).toHaveCount(1);
    await expect(page.locator(WIN)).not.toContainText("Could not load");
    await assertNoClaudeCode(page, "show more failure");
    mock.moreStatus = 200;
    await press(page, tid(page, "runs-more"));
    await expect(tid(page, "runs-row")).toHaveCount(2);
    await expect(tid(page, "runs-more-error")).toBeHidden();
    expect(w.errors).toEqual([]);
  });

  test("WS-F2c: once the run read has failed, no further events page is requested", async ({ page }) => {
    const { mock } = await setup(page, (m) => {
      m.runStatus = 404;
      m.eventsDelayMs = 250;
      m.events = Array.from({ length: 1000 }, (_, i) => ev(i + 1, "checkpoint", {}));
    });
    await expect(tid(page, "runs-row")).toHaveCount(1);
    await press(page, tid(page, "runs-row").first());
    await expect(tid(page, "runs-detail-error")).toHaveText("This run isn't available right now.");
    await page.waitForTimeout(1200); // room for four more pages if paging went on
    expect(mock.requests.filter((r) => r.includes("/events"))).toHaveLength(1); // the one already in flight
  });

  test("phone: the detail takes the whole window, with a Back control", async ({ page }) => {
    test.skip(test.info().project.name !== "phone", "the full-window detail is the phone layout");
    await setup(page);
    await expect(tid(page, "runs-row")).toHaveCount(1);
    await tid(page, "runs-row").first().tap();
    await expect(tid(page, "runs-head")).toBeVisible();
    const app = (await page.locator(`${WIN} [data-testid="runs-app"]`).boundingBox())!;
    const detail = (await tid(page, "runs-detail").boundingBox())!;
    expect(Math.abs(detail.width - app.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(detail.height - app.height)).toBeLessThanOrEqual(2);
    await expect(tid(page, "run-event")).toHaveCount(9);
    await tid(page, "runs-back").tap();
    await expect(tid(page, "runs-detail")).toBeHidden();
    await expect(tid(page, "runs-row")).toHaveCount(1);
  });

  test("desktop: the detail sits beside the list", async ({ page }) => {
    test.skip(test.info().project.name !== "desktop", "the side-by-side layout is the desktop one");
    await setup(page);
    await openFirstRun(page);
    const app = (await page.locator(`${WIN} [data-testid="runs-app"]`).boundingBox())!;
    const detail = (await tid(page, "runs-detail").boundingBox())!;
    expect(detail.width).toBeLessThan(app.width);
    await press(page, tid(page, "runs-back"));
    await expect(tid(page, "runs-detail")).toBeHidden();
  });
});
