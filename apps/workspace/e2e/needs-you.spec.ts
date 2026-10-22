// apps/workspace/e2e/needs-you.spec.ts
//
// D#598 P8c: the Needs you list on the built cloud dist, served by fixture-server.mjs. Every call the window makes is answered by page.route(). The logic
// half (every state, one request per click, the fixed sentences) is in test/needs-you.test.mjs; this file covers what needs the real DOM and the
// production CSP: agent text is text and never an element (CWE-79), the provider link is only ever on the fixed host list, focus stays on the control
// that was pressed (or moves to the row's heading when the control goes), the outcome is announced once, axe is clean under every theme, and no null,
// undefined or id reaches the page.

import { test, expect, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { waitForDesktop } from "./helpers/boot";

const CSP = "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
const SERVER_TEXT = "server text that must never be shown";
const THEMES = ["classic-crt", "retro-amber", "nord", "corporate", "modern-flat", "crystal", "orchard", "cyberpunk"];
const R1 = "3a1f6c52-7a0e-4c1a-9a53-0b1d2e3f4a55";
const R2 = "3a1f6c52-7a0e-4c1a-9a53-0b1d2e3f4a66";
const S1 = "We check for this every 60 seconds. The item continues by itself once it's done, or press Mark done.";
const S2 = "We can't check this one for you. Press Mark done when it's finished.";
const S3 = "Checking now.";
const S4 = "We checked and it isn't done yet: STRIPE_WEBHOOK_SECRET isn't set on cloud-staging yet. The item is paused again.";
const HOSTILE = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script> **bold** [x](javascript:window.__pwned=3) https://evil.example/a &amp;';

type Req = Record<string, unknown>;
const request = (over: Req = {}): Req => ({
  id: R1, repo_id: "6f1c2f5e-3d8f-4f43-8d6e-8f2f6a9b1c22", work_item_id: "9d2c7b1e-5f3a-4e8b-8a6d-1c2b3a4d5e66", kind: "env_var",
  title: "Add the environment variable STRIPE_WEBHOOK_SECRET to cloud-staging", target: "cloud-staging", env_name: "STRIPE_WEBHOOK_SECRET",
  reason: "The webhook route needs this name set before the build can be checked.", provider_url: "https://vercel.com/docs/environment-variables", check: "env_var_present",
  state: "open", origin: "agent", created_by: null, created_at: "2026-10-16T20:00:00.000Z", resolution: null, resolved_by: null, resolved_at: null, check_reason: null, check_ran_at: null,
  status_sentence: S1, check_interval_seconds: 60, ...over,
});
const A1 = "5c0d9e2a-8b41-4f6e-9a37-2d1e4c6b8a90";
const ask = (over: Req = {}): Req => ({
  id: A1, work_item_id: "9d2c7b1e-5f3a-4e8b-8a6d-1c2b3a4d5e66", decision_type: "dependency_patch_bump", label: "Patch-level dependency updates",
  options: [{ id: "bump_now", label: "Update the dependency now" }, { id: "leave_it", label: "Leave it as it is" }], proposed: "bump_now",
  rationale: "<<UNTRUSTED EXTERNAL CONTENT>>\nThe patch release fixes a crash we hit in the last run.\n<<END UNTRUSTED>>",
  answer_due_at: "2026-10-23T09:00:00.000Z", timeout_outcome: "stop_and_flag", state: "open", ...over,
});
const closed = (state: "done" | "withdrawn", over: Req = {}) => request({ state, status_sentence: null, check_interval_seconds: null, ...over });

interface Mock {
  requests: Req[];
  asks: Req[];
  /** What the answer POST replies: the contract's body, or a number for an error status. */
  answerReply: Req | number;
  /** The bodies the answer POSTs carried, by path. */
  answers: { path: string; body: unknown }[];
  notShown: number;
  listStatus: number;
  /** What a POST answers: a request, or a number for an error status. */
  doneAnswer: Req | number;
  withdrawAnswer: Req | number;
  delay: number;
  retryAfter?: string;
  posts: string[];
}
const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function setup(page: Page, tweak: Partial<Mock> = {}) {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP ${e.violatedDirective}`)));
  const mock: Mock = { requests: [request()], asks: [], answerReply: { ask_id: A1, receipt_id: "e1b7c3d4-2f58-4a09-8c6b-7d3e9f1a2b45", answered_option: "bump_now" }, answers: [], notShown: 0, listStatus: 200, doneAnswer: closed("done"), withdrawAnswer: closed("withdrawn"), delay: 0, posts: [], ...tweak };
  await page.route((u) => u.pathname === "/", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": CSP } });
  });
  await page.route("**/api/v1/events", () => new Promise<void>(() => {}));
  await page.route((u) => u.pathname.startsWith("/api/v1/") && u.pathname !== "/api/v1/events", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if ((req.headers()["accept"] ?? "").includes("text/event-stream")) return route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: idle\ndata: {}\n\n" });
    if (p === "/api/v1/setup-requests" && req.method() === "GET") {
      if (mock.listStatus !== 200) return json(route, mock.listStatus, { error: { code: "server_error", message: SERVER_TEXT, request_id: "r" } });
      return json(route, 200, { requests: mock.requests.filter((r) => r.state === "open"), truncated: false });
    }
    if (p === "/api/v1/decision-asks" && req.method() === "GET") return json(route, 200, { asks: mock.asks, not_shown: mock.notShown });
    const answerMatch = p.match(/^\/api\/v1\/decision-asks\/([^/]+)\/answer$/);
    if (answerMatch && req.method() === "POST") {
      mock.answers.push({ path: p, body: req.postDataJSON() });
      if (mock.delay > 0) await new Promise((r) => setTimeout(r, mock.delay));
      if (typeof mock.answerReply === "number") return json(route, mock.answerReply, { error: { code: mock.answerReply === 403 ? "forbidden" : mock.answerReply === 409 ? "already_answered" : "x", message: SERVER_TEXT, request_id: "r" } });
      mock.asks = mock.asks.filter((a) => a.id !== answerMatch[1]);
      return json(route, 200, mock.answerReply);
    }
    const act = p.match(/^\/api\/v1\/setup-requests\/([^/]+)\/(done|withdraw)$/);
    if (act && req.method() === "POST") {
      // The real API refuses any body on these two routes (packages/api/src/handler.ts), same status, code and message.
      if (req.postData()) return json(route, 400, { error: { code: "invalid_request", message: "this route does not accept a request body", request_id: "r" } });
      mock.posts.push(p);
      if (mock.delay > 0) await new Promise((r) => setTimeout(r, mock.delay));
      const answer = act[2] === "done" ? mock.doneAnswer : mock.withdrawAnswer;
      if (answer === 429) return route.fulfill({ status: 429, contentType: "application/json", headers: { "Retry-After": mock.retryAfter ?? "8" }, body: JSON.stringify({ error: { code: "rate_limited", message: SERVER_TEXT, request_id: "r" } }) });
      if (typeof answer === "number") return json(route, answer, { error: { code: answer === 403 ? "forbidden" : "x", message: SERVER_TEXT, request_id: "r" } });
      mock.requests = mock.requests.map((r) => (r.id === act[1] ? answer : r));
      return json(route, 200, answer);
    }
    return json(route, 404, { error: { code: "not_found", message: SERVER_TEXT, request_id: "r" } });
  });
  await page.goto("/");
  await waitForDesktop(page);
  return { mock, errors };
}

const WIN = `#windows-container .fulc-window[data-app-id="needs-you"]`;
const t = (page: Page, id: string) => page.locator(`${WIN} [data-testid="${id}"]`);
const open = async (page: Page) => {
  await page.locator('.dock-icon[data-app-id="needs-you"]').click();
  const win = page.locator(WIN);
  await expect(win).toBeVisible();
  await expect(win).not.toHaveClass(/opening/);
  await expect(page.locator(`${WIN} [data-testid="ny-loading"]`)).toHaveCount(0);
  return win;
};
const press = async (loc: ReturnType<Page["locator"]>) => {
  if (test.info().project.name === "phone") await loc.tap();
  else await loc.click();
};
async function clean(page: Page, errors: string[]) {
  expect(errors).toEqual([]);
  const text = await page.evaluate(() => document.body.innerText);
  expect(text).not.toMatch(/\bnull\b|undefined|NaN|ApiError|Could not load/);
  expect(text).not.toContain(SERVER_TEXT);
  expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i); // no id stands in for a name
}
async function applyTheme(page: Page, theme: string) {
  await page.evaluate(async (id) => {
    const m = await import(new URL("core/theme-manager.js", document.baseURI).href);
    await m.FULCTheme.apply(id);
  }, theme);
}
async function axeSeriousOrCritical(page: Page) {
  const res = await new AxeBuilder({ page }).include(WIN).exclude(`${WIN} .window-titlebar`).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
  return res.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}
const focusedTestId = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? "");

test.describe("D#598 P8c: Needs you", () => {
  test("an open request names the step and why, states the check in the API's own words, and links only the provider page", async ({ page }) => {
    const { errors } = await setup(page, { requests: [request(), request({ id: R2, title: "App not installed on acme/web", reason: "Install the app so the build can push.", provider_url: "https://github.com/apps/x", check: null, status_sentence: S2, check_interval_seconds: null })] });
    await open(page);
    await expect(page.locator(`${WIN} h2`)).toHaveText("Needs you (2)");
    const rows = t(page, "ny-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0).locator('[data-testid="ny-title"]')).toHaveText("Add the environment variable STRIPE_WEBHOOK_SECRET to cloud-staging");
    await expect(rows.nth(0).locator('[data-testid="ny-reason"]')).toHaveText("The webhook route needs this name set before the build can be checked.");
    await expect(rows.nth(0).locator('[data-testid="ny-sentence"]')).toHaveText(S1);
    await expect(rows.nth(1).locator('[data-testid="ny-sentence"]')).toHaveText(S2);
    const link = rows.nth(0).locator('[data-testid="ny-link"]');
    await expect(link).toHaveText("vercel.com");
    await expect(link).toHaveAttribute("href", "https://vercel.com/docs/environment-variables");
    await expect(link).toHaveAttribute("rel", /noopener/);
    await expect(rows.nth(1).locator('[data-testid="ny-link"]')).toHaveText("github.com");
    // Every control's name says which request it acts on.
    await expect(t(page, "ny-done-" + R1)).toHaveAccessibleName("Mark done: Add the environment variable STRIPE_WEBHOOK_SECRET to cloud-staging");
    await expect(t(page, "ny-withdraw-" + R2)).toHaveAccessibleName("Withdraw: App not installed on acme/web");
    await clean(page, errors);
  });

  test("an agent's text is only ever text: markup, markdown and addresses in the title, reason and status sentence create no element, link or script", async ({ page }) => {
    const { errors } = await setup(page, { requests: [request({ title: HOSTILE, reason: HOSTILE, status_sentence: HOSTILE, provider_url: "https://evil.example/phish" })] });
    await open(page);
    const row = t(page, "ny-row");
    for (const id of ["ny-title", "ny-reason", "ny-sentence"]) await expect(row.locator(`[data-testid="${id}"]`)).toHaveText(HOSTILE);
    await expect(row.locator("img, script, a, b, strong, em, iframe, svg")).toHaveCount(0); // no provider link either: evil.example is not on the list
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    // The reason keeps its line breaks and wraps; it never widens the page.
    const widths = await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      return [el.scrollWidth, el.clientWidth];
    }, `${WIN} .ny-app`);
    expect(widths[0]).toBeLessThanOrEqual(widths[1]);
    expect(errors).toEqual([]); // no CSP violation, no page error
  });

  test("Mark done on a request whose check fails puts it back with the check's reason, announced once, with focus on the same button", async ({ page }) => {
    const { mock, errors } = await setup(page, { doneAnswer: request({ status_sentence: S4, check_reason: "env_var_missing" }), delay: 1200 });
    await open(page);
    const done = t(page, "ny-done-" + R1);
    await press(done);
    await expect(t(page, "ny-sentence")).toHaveText(S3); // while the check runs, the approved sentence 3
    await expect(t(page, "ny-sentence")).toHaveText(S4);
    await expect(t(page, "ny-live")).toHaveText(S4);
    await expect(t(page, "ny-row")).toHaveAttribute("data-state", "open");
    expect(await focusedTestId(page)).toBe("ny-done-" + R1);
    expect(mock.posts).toEqual([`/api/v1/setup-requests/${R1}/done`]);
    await clean(page, errors);
  });

  test("a double press on Mark done is one request", async ({ page }) => {
    const { mock } = await setup(page, { delay: 200 });
    await open(page);
    await t(page, "ny-done-" + R1).dblclick();
    await expect(t(page, "ny-state")).toHaveText("Done");
    expect(mock.posts).toHaveLength(1);
  });

  test("Mark done on a request that passes shows Done, drops the buttons, and moves focus to the row's heading", async ({ page }) => {
    const { errors } = await setup(page);
    await open(page);
    await press(t(page, "ny-done-" + R1));
    await expect(t(page, "ny-state")).toHaveText("Done");
    await expect(t(page, "ny-row")).toHaveAttribute("data-state", "done");
    await expect(t(page, "ny-done-" + R1)).toHaveCount(0);
    await expect(page.locator(`${WIN} h2`)).toHaveText("Needs you (0)");
    expect(await focusedTestId(page)).toBe("ny-title");
    await clean(page, errors);
  });

  test("Mark done on a request with no automatic check never shows Checking now.", async ({ page }) => {
    await setup(page, { requests: [request({ check: null, status_sentence: S2, check_interval_seconds: null })], doneAnswer: closed("done", { check: null }), delay: 200 });
    await open(page);
    await press(t(page, "ny-done-" + R1));
    await expect(t(page, "ny-state")).toHaveText("Done");
    await expect(page.locator(`${WIN}`)).not.toContainText(S3);
  });

  test("Withdraw closes the request as Withdrawn in the list, and a fresh window lists only what is still open", async ({ page }) => {
    const { mock, errors } = await setup(page, { requests: [request(), request({ id: R2, title: "App not installed on acme/web" })] });
    await open(page);
    await press(t(page, "ny-withdraw-" + R1));
    const first = page.locator(`${WIN} [data-testid="ny-row"][data-id="${R1}"]`);
    await expect(first.locator('[data-testid="ny-state"]')).toHaveText("Withdrawn");
    expect(mock.posts).toEqual([`/api/v1/setup-requests/${R1}/withdraw`]);
    await expect(page.locator(`${WIN} h2`)).toHaveText("Needs you (1)");
    // The window closes and opens again: only the request still open is listed, and the withdrawn one is gone with the session.
    await page.evaluate(() => (window as unknown as { FULCWM: { close: (id: string) => void } }).FULCWM.close("needs-you"));
    await expect(page.locator(WIN)).toHaveCount(0);
    await open(page);
    await expect(t(page, "ny-row")).toHaveCount(1);
    await expect(t(page, "ny-title")).toHaveText("App not installed on acme/web");
    await clean(page, errors);
  });

  test("a refused action shows a fixed sentence and keeps the request open and focus where it was", async ({ page }) => {
    const { errors } = await setup(page, { doneAnswer: 403 });
    await open(page);
    await press(t(page, "ny-done-" + R1));
    await expect(t(page, "ny-action-error")).toHaveText("Only owners and admins can do this.");
    await expect(t(page, "ny-row")).toHaveAttribute("data-state", "open");
    expect(await focusedTestId(page)).toBe("ny-done-" + R1);
    await clean(page, errors);
  });

  test("a rate-limited action says how long to wait, from Retry-After, and keeps the request open", async ({ page }) => {
    const { errors } = await setup(page, { doneAnswer: 429, retryAfter: "8" });
    await open(page);
    await press(t(page, "ny-done-" + R1));
    await expect(t(page, "ny-action-error")).toHaveText("Try again in 8 seconds.");
    await expect(t(page, "ny-row")).toHaveAttribute("data-state", "open");
    await clean(page, errors);
  });

  test("the live region and the alert are written once per outcome: a refresh does not insert or write them again", async ({ page }) => {
    await setup(page, { doneAnswer: request({ status_sentence: S4, check_reason: "env_var_missing" }) });
    await page.clock.install();
    await open(page);
    await page.evaluate((sel) => {
      const w = window as unknown as { __live: string[]; __inserted: number };
      w.__live = [];
      w.__inserted = 0;
      const live = () => document.querySelector('[data-testid="ny-live"]') as HTMLElement;
      new MutationObserver((recs) => {
        for (const r of recs) {
          // A live or alert node being inserted again means a redraw re-created it (a screen reader says it again).
          for (const n of r.addedNodes) {
            const e = n as HTMLElement;
            if (e.nodeType === 1 && (e.matches?.('[role="status"][data-testid="ny-live"], [data-testid="ny-action-error"]') || e.querySelector?.('[data-testid="ny-live"], [data-testid="ny-action-error"]'))) w.__inserted += 1;
          }
          const t = r.target as Node;
          if (live() && (t === live() || live().contains(t)) && (live().textContent ?? "") !== "") w.__live.push(live().textContent ?? "");
        }
      }).observe(document.querySelector(sel) as HTMLElement, { childList: true, subtree: true, characterData: true });
    }, `${WIN} .ny-app`);
    await press(t(page, "ny-done-" + R1));
    await expect(t(page, "ny-live")).toHaveText(S4);
    await page.clock.runFor(31_000); // the 30 second refresh redraws the list
    await page.clock.runFor(1_000);
    await expect(t(page, "ny-row")).toBeVisible();
    const seen = await page.evaluate(() => ({ live: (window as unknown as { __live: string[] }).__live, inserted: (window as unknown as { __inserted: number }).__inserted }));
    expect(seen.inserted).toBe(0);
    expect(seen.live).toEqual([S4]);
  });

  test("a failure on the server shows the plain failure sentence, never the server's words", async ({ page }) => {
    const { errors } = await setup(page, { doneAnswer: 500 });
    await open(page);
    await press(t(page, "ny-done-" + R1));
    await expect(t(page, "ny-action-error")).toHaveText("That didn't go through. Try again.");
    await clean(page, errors);
  });

  test("an empty list says so in words", async ({ page }) => {
    const empty = await setup(page, { requests: [] });
    await open(page);
    await expect(t(page, "ny-empty")).toHaveText("Nothing needs you right now.");
    await expect(page.locator(`${WIN} h2`)).toHaveText("Needs you (0)");
    await clean(page, empty.errors);
  });

  test("when the list cannot be read the window says so in words and shows no rows", async ({ page }) => {
    const { errors } = await setup(page, { listStatus: 500 });
    await open(page);
    await expect(t(page, "ny-error")).toHaveText("Needs you isn't available right now.");
    await expect(t(page, "ny-row")).toHaveCount(0);
    await clean(page, errors);
  });

  test("axe finds nothing serious or critical in any state, under every theme", async ({ page }) => {
    await setup(page, { requests: [request(), request({ id: R2, title: HOSTILE, reason: HOSTILE, status_sentence: S4, provider_url: "https://github.com/apps/x" })] });
    await open(page);
    for (const theme of THEMES) {
      await applyTheme(page, theme);
      expect(await axeSeriousOrCritical(page), theme).toEqual([]);
    }
    await press(t(page, "ny-withdraw-" + R1)); // a closed row is checked too
    await expect(t(page, "ny-state")).toHaveText("Withdrawn");
    expect(await axeSeriousOrCritical(page)).toEqual([]);
  });

  test("an ask shows the cloud's name for the decision, the recommended option, the reason as a quotation and one button per option and Deny", async ({ page }) => {
    const { errors } = await setup(page, { requests: [], asks: [ask({ state: "overdue" })], notShown: 2 });
    await open(page);
    await expect(page.locator(`${WIN} h2`)).toHaveText("Needs you (1)");
    await expect(t(page, "ny-title")).toHaveText("Patch-level dependency updates");
    await expect(t(page, "ny-proposed")).toHaveText("Recommended: Update the dependency now");
    await expect(t(page, "ny-overdue")).toHaveText("Overdue");
    await expect(t(page, "ny-reason")).toHaveText("The patch release fixes a crash we hit in the last run.");
    expect(await t(page, "ny-reason").evaluate((el) => el.tagName)).toBe("BLOCKQUOTE");
    await expect(t(page, `ny-choice-${A1}-bump_now`)).toHaveAccessibleName("Update the dependency now (recommended): Patch-level dependency updates");
    await expect(t(page, `ny-choice-${A1}-leave_it`)).toHaveAccessibleName("Leave it as it is: Patch-level dependency updates");
    await expect(t(page, `ny-choice-${A1}-deny`)).toHaveText("Deny");
    await expect(t(page, "ny-not-shown")).toHaveText("2 more aren't shown.");
    await clean(page, errors);
  });

  test("an ask's reason, label and option names are only ever text", async ({ page }) => {
    const { errors } = await setup(page, { requests: [], asks: [ask({ label: HOSTILE, rationale: HOSTILE, options: [{ id: "a", label: HOSTILE }], proposed: "a" })] });
    await open(page);
    await expect(t(page, "ny-reason")).toHaveText(HOSTILE);
    await expect(t(page, "ny-title")).toHaveText(HOSTILE);
    await expect(t(page, "ny-row").locator("img, script, a, b, strong, em, iframe, svg")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    expect(errors).toEqual([]);
  });

  test("choosing an option sends exactly that choice once, shows the answer, announces it once and moves focus to the heading", async ({ page }) => {
    const { mock, errors } = await setup(page, { requests: [], asks: [ask()], delay: 200 });
    await open(page);
    await t(page, `ny-choice-${A1}-bump_now`).dblclick();
    await expect(t(page, "ny-state")).toHaveText("Answered: Update the dependency now");
    await expect(t(page, "ny-live")).toHaveText("Answered: Update the dependency now.");
    expect(mock.answers).toEqual([{ path: `/api/v1/decision-asks/${A1}/answer`, body: { choice: "bump_now" } }]);
    await expect(t(page, `ny-choice-${A1}-bump_now`)).toHaveCount(0);
    await expect(page.locator(`${WIN} h2`)).toHaveText("Needs you (0)");
    expect(await focusedTestId(page)).toBe("ny-title");
    await clean(page, errors);
  });

  test("Deny sends choice deny", async ({ page }) => {
    const { mock } = await setup(page, { requests: [], asks: [ask()], answerReply: { ask_id: A1, receipt_id: "e1b7c3d4-2f58-4a09-8c6b-7d3e9f1a2b45", answered_option: "deny" } });
    await open(page);
    await press(t(page, `ny-choice-${A1}-deny`));
    await expect(t(page, "ny-state")).toHaveText("Answered: Deny");
    expect(mock.answers.map((a) => a.body)).toEqual([{ choice: "deny" }]);
  });

  test("a member's refused answer says so in words, keeps the ask open and focus on the same button", async ({ page }) => {
    const { errors } = await setup(page, { requests: [], asks: [ask()], answerReply: 403 });
    await open(page);
    await press(t(page, `ny-choice-${A1}-leave_it`));
    await expect(t(page, "ny-action-error")).toHaveText("Only owners and admins can do this.");
    await expect(t(page, "ny-row")).toHaveAttribute("data-state", "open");
    expect(await focusedTestId(page)).toBe(`ny-choice-${A1}-leave_it`);
    await clean(page, errors);
  });

  test("an ask someone else already answered shows a fixed sentence and the list is read again", async ({ page }) => {
    const { mock, errors } = await setup(page, { requests: [], asks: [ask()], answerReply: 409 });
    await open(page);
    mock.asks = []; // the other window's answer
    await press(t(page, `ny-choice-${A1}-bump_now`));
    await expect(t(page, "ny-action-error")).toHaveText("That was already answered.");
    await expect(t(page, "ny-empty")).toHaveText("Nothing needs you right now.");
    await clean(page, errors);
  });

  test("axe finds nothing serious or critical on an open and an answered ask, under every theme", async ({ page }) => {
    await setup(page, { requests: [], asks: [ask({ state: "overdue" })] });
    await open(page);
    for (const theme of THEMES) {
      await applyTheme(page, theme);
      expect(await axeSeriousOrCritical(page), theme).toEqual([]);
    }
    await press(t(page, `ny-choice-${A1}-deny`));
    await expect(t(page, "ny-state")).toContainText("Answered");
    expect(await axeSeriousOrCritical(page)).toEqual([]);
  });

  test("the keyboard reaches every control in reading order, and Enter presses it", async ({ page }) => {
    const { mock } = await setup(page);
    await open(page);
    await t(page, "ny-link").focus();
    await page.keyboard.press("Tab");
    expect(await focusedTestId(page)).toBe("ny-done-" + R1);
    await page.keyboard.press("Tab");
    expect(await focusedTestId(page)).toBe("ny-withdraw-" + R1);
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Enter");
    await expect(t(page, "ny-state")).toHaveText("Done");
    expect(mock.posts).toHaveLength(1);
  });

  test("the buttons are at least 44 px tall at every width, and on a narrow window the page does not scroll sideways", async ({ page }) => {
    await setup(page);
    await open(page);
    const wide = await page.evaluate((sel) => (document.querySelector(`${sel} .ny-btn`) as HTMLElement).getBoundingClientRect().height, `${WIN} .ny-app`);
    expect(wide).toBeGreaterThanOrEqual(43.5); // the phone window is drawn at a scale just under 1
    await page.setViewportSize({ width: 360, height: 700 });
    const m = await page.evaluate((sel) => {
      const app = document.querySelector(sel) as HTMLElement;
      const b = document.querySelector(`${sel} .ny-btn`) as HTMLElement;
      return { over: app.scrollWidth > app.clientWidth, h: b.getBoundingClientRect().height, w: app.clientWidth };
    }, `${WIN} .ny-app`);
    expect(m.over).toBe(false);
    expect(m.h).toBeGreaterThanOrEqual(43.5);
  });
});
