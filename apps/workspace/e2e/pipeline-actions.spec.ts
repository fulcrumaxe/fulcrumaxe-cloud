// apps/workspace/e2e/pipeline-actions.spec.ts
//
// D#37 WS-F1c: Cancel and Retry in the Pipeline detail's Runs section, on mocked replies
// from the repo's contract fixtures (packages/api/fixtures/v1/**). The built cloud dist is
// served by fixture-server.mjs, booted with bootToDesktop under the page clock, so the 5 s
// action poll is driven with page.clock.runFor(). Account-stream events go on the live
// client's own BroadcastChannel, the way a non-leader tab hears them. The document carries
// the production CSP and Trusted Types directives. Every test runs on desktop, phone and tablet.
//
// The logic half (statuses, keys, ceiling, timers) is in test/pipeline-actions.test.mjs; this
// file covers what needs a real DOM: the dialogs, dismissing them, that no code or server
// text ever reaches the page, no leaks on open/close, and the phone layout.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";
import { bootToDesktop } from "./helpers/boot";

const V1 = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "api", "fixtures", "v1");
const fx = (...p: string[]) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
const LIST = fx("listWorkItems", "200-page.json");
const REPOS = fx("listRepos", "200-page.json");
const TIMELINE = fx("getWorkItemTimeline", "200-ok.json");
const WORK = fx("listRuns", "200-work-item.json");
const ROLES = fx("listRoles", "200-ok.json");
const RUN = fx("getRun", "200-running.json");
const ACCEPTED = fx("cancelRun", "202-accepted.json");

const ITEM = LIST.data[0].id as string;
const REPO = LIST.data[0].repo_id as string;
const [LIVE, FAILED_REVIEW] = WORK.data as { id: string; role: string; status: string }[];
const SERVER_TEXT = "server text that must never be shown";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CSP = "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
const WIN = `#windows-container .fulc-window[data-app-id="pipeline"]`;
const tid = (page: Page, id: string) => page.locator(`${WIN} [data-testid="${id}"]`);
const dlg = (page: Page) => page.locator('dialog[data-testid="pl-dialog"]');
const inDlg = (page: Page, id: string) => dlg(page).locator(`[data-testid="${id}"]`);

interface Reply { status: number; json?: unknown; abort?: boolean; delayMs?: number; headers?: Record<string, string> }
interface Mock {
  actionIds: string[]; // the action_id of every accepted POST
  requests: string[];
  posts: { path: string; key: string | undefined }[];
  runs: unknown;
  cancel: Reply;
  retry: Reply;
  action: Reply;
  roles: Reply;
}

const err = (code: string) => ({ error: { code, message: SERVER_TEXT, request_id: "req_1" } });
const reads = (m: Mock, prefix: string) => m.requests.filter((r) => r.startsWith("GET " + prefix)).length;

async function mockApi(page: Page): Promise<Mock> {
  const mock: Mock = {
    requests: [],
    actionIds: [],
    posts: [],
    runs: structuredClone(WORK),
    cancel: { status: 202, json: ACCEPTED },
    retry: { status: 202, json: fx("retryRun", "202-accepted.json") },
    action: { status: 200, json: { ...fx("getRunAction", "200-retry_done.json"), state: "running", outcome: null } },
    roles: { status: 200, json: ROLES },
  };
  const send = async (route: Route, r: Reply) => {
    if (r.delayMs) await new Promise((res) => setTimeout(res, r.delayMs));
    if (r.abort) return route.abort("failed");
    return route.fulfill({ status: r.status, headers: r.headers, contentType: "application/json", body: JSON.stringify(r.json ?? {}) });
  };
  await page.route((u) => u.pathname.startsWith("/api/v1/") && u.pathname !== "/api/v1/events", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    mock.requests.push(`${req.method()} ${p}${url.search}`);
    if (req.method() === "POST") {
      mock.posts.push({ path: p, key: req.headers()["idempotency-key"] });
      const reply = p.endsWith("/cancel") ? mock.cancel : mock.retry;
      if (reply.status === 202) mock.actionIds.push((reply.json as { action_id: string }).action_id);
      return send(route, reply);
    }
    if (p === "/api/v1/work-items") return send(route, { status: 200, json: { data: [{ ...LIST.data[0], stage: "in_progress" }], next_cursor: null } });
    if (p === "/api/v1/repos") return send(route, { status: 200, json: REPOS });
    if (p.endsWith("/timeline")) return send(route, { status: 200, json: TIMELINE });
    if (p === "/api/v1/runs") return send(route, { status: 200, json: mock.runs });
    if (p.endsWith("/roles")) return send(route, mock.roles);
    if (p.startsWith("/api/v1/run-actions/")) return send(route, mock.action);
    if (p.startsWith("/api/v1/runs/")) return send(route, { status: 200, json: RUN });
    return send(route, { status: 404, json: err("not_found") });
  });
  await page.route("**/api/v1/events", (route) => route.fulfill({ status: 200, contentType: "text/event-stream", headers: { "cache-control": "no-store" }, body: "event: idle\ndata: {}\n\n" }));
  return mock;
}

async function setup(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  const mock = await mockApi(page);
  await page.route((u) => u.pathname === "/", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": CSP } });
  });
  await bootToDesktop(page);
  // The page clock stops the shell's boot mark from reaching the live client, so start it here (its public start()).
  await page.evaluate(async () => (await import(new URL("core/cloud-live.js", document.baseURI).href)).default.start());
  return { errors, mock };
}

const fulcwm = (page: Page, fn: "open" | "close") => page.evaluate((f) => (window as unknown as { FULCWM: Record<string, (id: string) => void> }).FULCWM[f]("pipeline"), fn);

async function press(page: Page, locator: ReturnType<Page["locator"]>) {
  if (test.info().project.name === "phone") await locator.tap();
  else await locator.click();
}

async function openWindow(page: Page) {
  await fulcwm(page, "open");
  await expect(page.locator(WIN)).toBeVisible();
  await expect(page.locator(WIN)).not.toHaveClass(/opening/);
  await expect(tid(page, "pl-card")).toHaveCount(1);
}

async function openDetail(page: Page, rows = 3) {
  await press(page, tid(page, "pl-card").first());
  await expect(tid(page, "pl-run")).toHaveCount(rows);
}

async function start(page: Page) {
  const s = await setup(page);
  await openWindow(page);
  await openDetail(page);
  return s;
}

const row = (page: Page, i: number) => tid(page, "pl-run").nth(i);

/** One account-stream event on the live client's channel, as the leader tab would send it. */
async function sendEvent(page: Page, type: string, data: Record<string, unknown>) {
  await page.evaluate(async ([t, d]) => {
    const ns = await import(new URL("core/storage-ns.js", document.baseURI).href);
    const ch = new BroadcastChannel("fx-live-" + (ns.getNamespace() || "default"));
    ch.postMessage({ type: "event", event: { id: "e-" + Math.random(), type: t, created_at: new Date().toISOString(), data: d } });
    ch.close();
  }, [type, data] as const);
}

const subscriberCount = (page: Page) =>
  page.evaluate(async () => (await import(new URL("core/cloud-live.js", document.baseURI).href)).subscriberCount() as number);

async function expectClean(page: Page, errors: string[]) {
  expect(errors).toEqual([]);
  const text = await page.evaluate(() => document.body.innerText);
  expect(text).not.toMatch(/Could not load|ApiError|Claude Code/i);
  expect(text).not.toContain(SERVER_TEXT);
}

test.describe("D#37 WS-F1c: Cancel and Retry (mocked API)", () => {
  test("the Runs section lists the runs with the right controls, and no card holds a button", async ({ page }) => {
    const { errors, mock } = await start(page);
    await expect(row(page, 0)).toContainText("build");
    await expect(row(page, 0)).toContainText("Running");
    await expect(row(page, 0).locator('[data-testid="pl-cancel"]')).toHaveCount(1);
    await expect(row(page, 0).locator('[data-testid="pl-retry"]')).toHaveCount(0);
    await expect(row(page, 1).locator('[data-testid="pl-retry"]')).toHaveCount(1);
    await expect(row(page, 1).locator('[data-testid="pl-cancel"]')).toHaveCount(0);
    await expect(row(page, 2).locator("button")).toHaveCount(0); // an older failed run of a role whose newest run is live
    await expect(page.locator(`${WIN} .pl-card button`)).toHaveCount(0);
    expect(mock.requests).toContain(`GET /api/v1/runs?work_item_id=${ITEM}&limit=10`);
    expect(reads(mock, "/api/v1/runs?")).toBeLessThanOrEqual(2); // one on open; the click's refresh may add one
    await expectClean(page, errors);
  });

  test("Cancel: the dialog reads the spend, dismissing sends nothing, Confirm sends no key, and a status change clears the label", async ({ page }) => {
    const { errors, mock } = await start(page);
    await press(page, row(page, 0).locator('[data-testid="pl-cancel"]'));
    await expect(dlg(page)).toBeVisible();
    await expect(dlg(page)).toContainText("Spent so far: not known yet");
    await expect(dlg(page)).toContainText("Anything reserved for this run and not spent is released.");
    await press(page, inDlg(page, "pl-dialog-close"));
    await expect(dlg(page)).toHaveCount(0);
    expect(mock.posts).toEqual([]);
    await press(page, row(page, 0).locator('[data-testid="pl-cancel"]'));
    await press(page, inDlg(page, "pl-confirm"));
    await expect(dlg(page)).toHaveCount(0);
    await expect(tid(page, "pl-pending")).toHaveText("Cancelling…");
    await expect(row(page, 0)).toHaveAttribute("data-action-id", ACCEPTED.action_id);
    await expect(row(page, 0).locator('[data-testid="pl-cancel"]')).toHaveCount(0);
    expect(mock.posts).toEqual([{ path: `/api/v1/runs/${LIVE.id}/cancel`, key: undefined }]);
    (mock.runs as { data: { status: string }[] }).data[0].status = "cancelled";
    await sendEvent(page, "run.status_changed", { runId: LIVE.id, from: "running", to: "cancelled" });
    await expect(tid(page, "pl-pending")).toHaveCount(0);
    await expect(row(page, 0)).toContainText("Cancelled");
    await expectClean(page, errors);
  });

  test("Retry: the dialog names the usual cost, Confirm sends a fresh UUID key, and the poll's done re-reads the list", async ({ page }) => {
    const { errors, mock } = await start(page);
    await press(page, row(page, 1).locator('[data-testid="pl-retry"]'));
    await expect(dlg(page)).toContainText("Usually about $0.15 per run");
    await expect(dlg(page)).toContainText("A retry may use a stronger model, which can cost more.");
    expect(reads(mock, `/api/v1/repos/${REPO}/roles`)).toBe(1);
    await press(page, inDlg(page, "pl-confirm"));
    await expect(tid(page, "pl-pending")).toHaveText("Retrying…");
    expect(mock.posts).toHaveLength(1);
    expect(mock.posts[0].path).toBe(`/api/v1/runs/${FAILED_REVIEW.id}/retry`);
    expect(mock.posts[0].key).toMatch(UUID_RE);
    mock.action = { status: 200, json: fx("getRunAction", "200-retry_done.json") };
    const before = reads(mock, "/api/v1/runs?");
    await page.clock.runFor(5000);
    await expect(tid(page, "pl-pending")).toHaveCount(0);
    expect(reads(mock, "/api/v1/runs?")).toBeGreaterThan(before);
    await expectClean(page, errors);
  });

  test("Retry refused after the 202 shows its sentence and never the code", async ({ page }) => {
    const { errors, mock } = await start(page);
    await press(page, row(page, 1).locator('[data-testid="pl-retry"]'));
    await press(page, inDlg(page, "pl-confirm"));
    await expect(tid(page, "pl-pending")).toHaveText("Retrying…");
    mock.action = { status: 200, json: fx("getRunAction", "200-retry_refused.json") };
    await page.clock.runFor(5000);
    await expect(tid(page, "pl-pending")).toHaveCount(0);
    await expect(tid(page, "pl-runs-notice")).toHaveText("A spending limit stopped this retry. Nothing was started.");
    expect(await page.locator(WIN).innerText()).not.toContain("model_budget_exceeded");
    await expectClean(page, errors);
  });

  test("a 503 and a 409 on Confirm show their sentences in the dialog and leave no label", async ({ page }) => {
    const { errors, mock } = await start(page);
    mock.retry = { status: 503, json: fx("retryRun", "503-run_actions_unavailable.json") };
    await press(page, row(page, 1).locator('[data-testid="pl-retry"]'));
    await press(page, inDlg(page, "pl-confirm"));
    await expect(inDlg(page, "pl-dialog-error")).toHaveText("Run actions aren't available right now. Try again later.");
    await expect(inDlg(page, "pl-confirm")).toBeHidden();
    await press(page, inDlg(page, "pl-dialog-close"));
    mock.retry = { status: 409, json: fx("retryRun", "409-account_not_active.json") };
    await press(page, row(page, 1).locator('[data-testid="pl-retry"]'));
    await press(page, inDlg(page, "pl-confirm"));
    await expect(inDlg(page, "pl-dialog-error")).toHaveText("Your account isn't active, so runs can't be started or stopped.");
    await press(page, inDlg(page, "pl-dialog-close"));
    await expect(tid(page, "pl-pending")).toHaveCount(0);
    await expectClean(page, errors);
  });

  test("a network failure offers Try again, which resends the same key", async ({ page }) => {
    const { mock } = await start(page);
    mock.retry = { status: 0, abort: true };
    await press(page, row(page, 1).locator('[data-testid="pl-retry"]'));
    await press(page, inDlg(page, "pl-confirm"));
    await expect(inDlg(page, "pl-dialog-error")).toHaveText("Couldn't reach the server.");
    mock.retry = { status: 202, json: fx("retryRun", "202-accepted.json") };
    await press(page, inDlg(page, "pl-try-again"));
    await expect(tid(page, "pl-pending")).toHaveText("Retrying…");
    expect(mock.posts).toHaveLength(2);
    expect(mock.posts[0].key).toMatch(UUID_RE);
    expect(mock.posts[1].key).toBe(mock.posts[0].key);
  });

  test("Escape, Close and a click outside each dismiss either dialog without sending", async ({ page }) => {
    const { mock } = await start(page);
    for (const control of ["pl-cancel", "pl-retry"]) {
      const at = control === "pl-cancel" ? 0 : 1;
      for (const how of ["escape", "close", "outside"]) {
        await press(page, row(page, at).locator(`[data-testid="${control}"]`));
        await expect(dlg(page)).toBeVisible();
        if (how === "escape") await page.keyboard.press("Escape");
        else if (how === "close") await press(page, inDlg(page, "pl-dialog-close"));
        else {
          // Beside the dialog, mid-height: not a screen corner, which the shell treats as a hot corner.
          const b = (await dlg(page).boundingBox())!;
          const [x, y] = [b.x / 2, b.y + b.height / 2];
          if (test.info().project.name === "phone") await page.touchscreen.tap(x, y);
          else await page.mouse.click(x, y);
        }
        await expect(dlg(page)).toHaveCount(0);
      }
    }
    expect(mock.posts).toEqual([]);
  });

  test("a double click on Confirm sends exactly one request", async ({ page }) => {
    const { mock } = await start(page);
    mock.retry = { status: 202, json: fx("retryRun", "202-accepted.json"), delayMs: 400 };
    await press(page, row(page, 1).locator('[data-testid="pl-retry"]'));
    await inDlg(page, "pl-confirm").dblclick();
    await expect(tid(page, "pl-pending")).toHaveText("Retrying…");
    expect(mock.posts).toHaveLength(1);
  });

  test("every code in the sentence table, and an unknown one, shows its sentence and nothing else", async ({ page }) => {
    const { errors, mock } = await start(page);
    const sentences: Record<string, string> = await page.evaluate(async () => {
      const src = (document.querySelector('script[data-app="pipeline"]') as HTMLScriptElement).src;
      return (await import(src.replace("pipeline-app.js", "pipeline-actions.js"))).SENTENCES;
    });
    const codes = Object.keys(sentences);
    expect(codes.length).toBeGreaterThan(15);
    for (const code of [...codes, "from_the_future"]) {
      mock.retry = code === "network" ? { status: 0, abort: true } : { status: 409, json: err(code) };
      await press(page, row(page, 1).locator('[data-testid="pl-retry"]'));
      await press(page, inDlg(page, "pl-confirm"));
      const shown = code === "not_cancellable" ? tid(page, "pl-runs-notice") : inDlg(page, "pl-dialog-error");
      await expect(shown).toHaveText(sentences[code] ?? "That didn't work. Nothing was changed.");
      const seen = await page.evaluate(() => {
        const texts = [document.body.innerText];
        const attrs: string[] = [];
        for (const el of Array.from(document.querySelectorAll("*"))) for (const a of Array.from(el.attributes)) if (a.name.startsWith("aria-") || a.name === "title" || a.name === "alt") attrs.push(a.value);
        return { texts, attrs };
      });
      const all = [...seen.texts, ...seen.attrs].join("\n");
      expect(all, code).not.toContain(SERVER_TEXT);
      expect(all, code).not.toContain(code);
      if (await dlg(page).count()) await press(page, inDlg(page, "pl-dialog-close"));
    }
    await expectClean(page, errors);
  });

  test("no leaks: twenty window cycles, then twenty detail cycles with a pending action, leave no subscriber and no poll", async ({ page }) => {
    const { mock } = await setup(page);
    await openWindow(page);
    const baseline = await subscriberCount(page);
    for (let i = 0; i < 20; i++) {
      await fulcwm(page, "close");
      await expect(page.locator(WIN)).toHaveCount(0);
      await openWindow(page);
    }
    expect(await subscriberCount(page)).toBe(baseline);
    for (let i = 0; i < 20; i++) {
      await openDetail(page);
      await press(page, row(page, 0).locator('[data-testid="pl-cancel"]'));
      await press(page, inDlg(page, "pl-confirm"));
      await expect(tid(page, "pl-pending")).toHaveText("Cancelling…");
      await press(page, tid(page, "pl-back"));
      await expect(tid(page, "pl-run")).toHaveCount(0);
    }
    expect(await subscriberCount(page)).toBe(baseline);
    // One more, closed through the window instead of the detail.
    await openDetail(page);
    await press(page, row(page, 0).locator('[data-testid="pl-cancel"]'));
    await press(page, inDlg(page, "pl-confirm"));
    await expect(tid(page, "pl-pending")).toHaveText("Cancelling…");
    await fulcwm(page, "close");
    await expect(dlg(page)).toHaveCount(0);
    await page.clock.runFor(60_000);
    expect(reads(mock, "/api/v1/run-actions/")).toBe(0);
    expect(await subscriberCount(page)).toBeLessThanOrEqual(baseline);
  });

  test("reopen after close (a): a repeat answer for the same action is one action, the label returns and the poll runs on it", async ({ page }) => {
    const { errors, mock } = await start(page);
    await press(page, row(page, 1).locator('[data-testid="pl-retry"]'));
    await press(page, inDlg(page, "pl-confirm"));
    await expect(tid(page, "pl-pending")).toHaveText("Retrying…");
    await press(page, tid(page, "pl-back"));
    await expect(tid(page, "pl-pending")).toHaveCount(0);
    // The server de-duplicates a second retry while the first is live: 202, the same action_id, a replay header.
    mock.retry = { status: 202, json: fx("retryRun", "202-accepted.json"), headers: { "Idempotent-Replayed": "true" } };
    await openDetail(page);
    await press(page, row(page, 1).locator('[data-testid="pl-retry"]'));
    await press(page, inDlg(page, "pl-confirm"));
    await expect(tid(page, "pl-pending")).toHaveText("Retrying…");
    expect(mock.posts).toHaveLength(2);
    expect(mock.posts[1].key).toMatch(UUID_RE);
    expect(mock.posts[1].key).not.toBe(mock.posts[0].key);
    expect(new Set(mock.actionIds).size).toBe(1);
    const before = reads(mock, `/api/v1/run-actions/${ACCEPTED.action_id}`);
    await page.clock.runFor(5000);
    await expect.poll(() => reads(mock, `/api/v1/run-actions/${ACCEPTED.action_id}`)).toBeGreaterThan(before);
    await expect(dlg(page)).toHaveCount(0);
    await expect(tid(page, "pl-runs-notice")).toHaveText("");
    await expectClean(page, errors);
  });

  test("reopen after close (b): once the retry has made a new run, the old run offers no Retry and the new one is listed", async ({ page }) => {
    const { errors, mock } = await start(page);
    await press(page, row(page, 1).locator('[data-testid="pl-retry"]'));
    await press(page, inDlg(page, "pl-confirm"));
    await expect(tid(page, "pl-pending")).toHaveText("Retrying…");
    await press(page, tid(page, "pl-back"));
    mock.action = { status: 200, json: fx("getRunAction", "200-retry_done.json") };
    const fresh = { ...FAILED_REVIEW, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", status: "running", created_at: "2026-09-18T13:00:00.000Z" };
    mock.runs = { data: [fresh, ...WORK.data], next_cursor: null };
    await openDetail(page, 4);
    await expect(page.locator(`${WIN} [data-run-id="${FAILED_REVIEW.id}"] button`)).toHaveCount(0);
    await expect(page.locator(`${WIN} [data-run-id="${fresh.id}"]`)).toContainText("Running");
    await expect(page.locator(`${WIN} [data-run-id="${fresh.id}"] [data-testid="pl-cancel"]`)).toHaveCount(1);
    await expect(tid(page, "pl-pending")).toHaveCount(0);
    await expectClean(page, errors);
  });

  test("a11y: the card's pending label is announced through a polite live region, the row shows a cue, and no card holds a button", async ({ page }) => {
    await start(page);
    await expect(tid(page, "pl-announce")).toHaveAttribute("aria-live", "polite");
    await expect(tid(page, "pl-announce")).toHaveText("");
    await press(page, row(page, 0).locator('[data-testid="pl-cancel"]'));
    await press(page, inDlg(page, "pl-confirm"));
    await expect(tid(page, "pl-pending")).toHaveText("Cancelling…");
    await expect(tid(page, "pl-announce")).toHaveText("Cancelling…");
    await expect(row(page, 0).locator('[data-testid="pl-run-pending"]')).toBeVisible();
    await expect(row(page, 0).locator('[data-testid="pl-run-pending"]')).toHaveText("Cancelling…");
    await expect(page.locator(`${WIN} .pl-card button`)).toHaveCount(0);
    await sendEvent(page, "run.status_changed", { runId: LIVE.id, from: "running", to: "cancelled" });
    await expect(tid(page, "pl-announce")).toHaveText("");
  });

  test("a11y: a live event and a poll re-render keep keyboard focus on the same control of the same run", async ({ page }) => {
    const { mock } = await start(page);
    await press(page, row(page, 1).locator('[data-testid="pl-retry"]'));
    await press(page, inDlg(page, "pl-confirm"));
    await expect(tid(page, "pl-pending")).toHaveText("Retrying…");
    const focused = () =>
      page.evaluate(() => {
        const a = document.activeElement as HTMLElement;
        return { test: a.dataset.testid, run: a.closest("[data-run-id]")?.getAttribute("data-run-id"), same: a === (window as unknown as { __held: Element }).__held };
      });
    await row(page, 0).locator('[data-testid="pl-cancel"]').focus();
    await page.evaluate(() => ((window as unknown as { __held: Element }).__held = document.activeElement!));
    let n = reads(mock, "/api/v1/runs?");
    await sendEvent(page, "run.status_changed", { runId: "someone-else", from: "pending", to: "running" });
    await expect.poll(() => reads(mock, "/api/v1/runs?")).toBeGreaterThan(n);
    await expect.poll(async () => (await focused()).test).toBe("pl-cancel");
    expect(await focused()).toMatchObject({ run: LIVE.id, same: false }); // the row was rebuilt, and focus came back
    await page.evaluate(() => ((window as unknown as { __held: Element }).__held = document.activeElement!));
    n = reads(mock, "/api/v1/runs?");
    mock.action = { status: 200, json: fx("getRunAction", "200-retry_done.json") };
    await page.clock.runFor(5000);
    await expect(tid(page, "pl-pending")).toHaveCount(0);
    await expect.poll(() => reads(mock, "/api/v1/runs?")).toBeGreaterThan(n);
    expect(await focused()).toMatchObject({ test: "pl-cancel", run: LIVE.id, same: false });
  });

  test("a11y: dialog focus stays inside while sending, moves to the error after a failure, and survives Try again", async ({ page }) => {
    const { mock } = await start(page);
    const inside = () => page.evaluate(() => { const a = document.activeElement as HTMLElement; return { in: !!a.closest("dialog"), test: a.dataset.testid }; });
    mock.retry = { status: 503, json: fx("retryRun", "503-run_actions_unavailable.json"), delayMs: 600 };
    await press(page, row(page, 1).locator('[data-testid="pl-retry"]'));
    await inDlg(page, "pl-confirm").focus();
    await inDlg(page, "pl-confirm").press("Enter");
    await expect(inDlg(page, "pl-confirm")).toHaveAttribute("aria-disabled", "true");
    expect(await inside()).toEqual({ in: true, test: "pl-confirm" });
    await expect(inDlg(page, "pl-dialog-error")).toHaveText("Run actions aren't available right now. Try again later.");
    expect(await inside()).toEqual({ in: true, test: "pl-dialog-error" });
    await press(page, inDlg(page, "pl-dialog-close"));
    mock.retry = { status: 0, abort: true };
    await press(page, row(page, 1).locator('[data-testid="pl-retry"]'));
    await press(page, inDlg(page, "pl-confirm"));
    await expect(inDlg(page, "pl-try-again")).toBeVisible();
    expect((await inside()).in).toBe(true);
    mock.retry = { status: 202, json: fx("retryRun", "202-accepted.json"), delayMs: 600 };
    await inDlg(page, "pl-try-again").focus();
    await inDlg(page, "pl-try-again").press("Enter");
    await expect(inDlg(page, "pl-confirm")).toHaveAttribute("aria-disabled", "true");
    expect((await inside()).in).toBe(true);
    await expect(tid(page, "pl-pending")).toHaveText("Retrying…");
  });

  test("a dialog left open when the window closes is removed, and the page is usable on reopen", async ({ page }) => {
    await start(page);
    await press(page, row(page, 0).locator('[data-testid="pl-cancel"]'));
    await expect(dlg(page)).toBeVisible();
    await fulcwm(page, "close");
    await expect(page.locator(WIN)).toHaveCount(0);
    await expect(dlg(page)).toHaveCount(0);
    await openWindow(page);
    await openDetail(page);
    await expect(dlg(page)).toHaveCount(0);
  });

  test("phone: the Runs section and both dialogs fit 360x740, and Confirm is in view", async ({ page }) => {
    test.skip(test.info().project.name !== "phone", "the 360x740 layout is a phone-project check");
    await page.setViewportSize({ width: 360, height: 740 });
    await start(page);
    const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && Array.from(document.querySelectorAll(".pl-detail")).every((e) => e.scrollWidth <= e.clientWidth));
    expect(await noSideScroll()).toBe(true);
    for (const [control, at] of [["pl-cancel", 0], ["pl-retry", 1]] as const) {
      await row(page, at).locator(`[data-testid="${control}"]`).tap();
      const box = await dlg(page).boundingBox();
      const confirm = await inDlg(page, "pl-confirm").boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(360);
      expect(box!.y + box!.height).toBeLessThanOrEqual(740);
      expect(confirm!.y + confirm!.height).toBeLessThanOrEqual(740);
      expect(await noSideScroll()).toBe(true);
      await inDlg(page, "pl-dialog-close").tap();
    }
    await row(page, 1).locator('[data-testid="pl-retry"]').tap();
    await inDlg(page, "pl-confirm").tap();
    await expect(tid(page, "pl-pending")).toHaveText("Retrying…");
  });
});

test.describe("D#37 WS-F1c-A11Y-MINOR: the dialog's description, button names and edges", () => {
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  test("each dialog is described by the cost line shown on screen", async ({ page }) => {
    await start(page);
    for (const [control, at, shown] of [["pl-cancel", 0, /Spent so far/], ["pl-retry", 1, /Usually about|isn't available right now/]] as const) {
      await press(page, row(page, at).locator(`[data-testid="${control}"]`));
      const line = inDlg(page, "pl-dialog-info").locator("p").first();
      await expect(line).toContainText(shown);
      await expect(dlg(page)).toHaveAccessibleDescription(new RegExp(escapeRe((await line.textContent())!)));
      await press(page, inDlg(page, "pl-dialog-close"));
    }
  });

  test("Yes, cancel run sends one POST and Keep the run sends none", async ({ page }) => {
    const { mock } = await start(page);
    const trigger = row(page, 0).locator('[data-testid="pl-cancel"]');
    await press(page, trigger);
    await press(page, dlg(page).getByRole("button", { name: "Keep the run" }));
    await expect(dlg(page)).toHaveCount(0);
    expect(mock.posts).toEqual([]);
    await press(page, trigger);
    await press(page, dlg(page).getByRole("button", { name: "Yes, cancel run" }));
    await expect(dlg(page)).toHaveCount(0);
    expect(mock.posts).toHaveLength(1);
  });

  test("the button edge is at least 3:1 against the button's own background", async ({ page }) => {
    await start(page);
    const ratio = await row(page, 0).locator(".pl-act").evaluate((el) => {
      const cs = getComputedStyle(el);
      const rgba = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
      const [br, bg, bb, ba = 1] = rgba(cs.backgroundColor);
      const [er, eg, eb, ea = 1] = rgba(cs.borderTopColor);
      const edge = [er, eg, eb].map((c, i) => c * ea + [br, bg, bb][i] * ba * (1 - ea));
      const lum = (c: number[]) => c.map((v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
      const [a, b] = [lum(edge), lum([br, bg, bb])].sort((x, y) => y - x);
      return (a + 0.05) / (b + 0.05);
    });
    console.log(`.pl-act border contrast ${ratio.toFixed(2)}:1`);
    expect(ratio).toBeGreaterThanOrEqual(3);
  });
});
