// apps/workspace/e2e/pipeline-reversal.spec.ts
//
// D#7 DP7-2f: the Reverse control on a work item's card, with real clicks on mocked replies. The mock keeps the receipts in memory and
// answers the two write routes the way the server does, so a reload shows what the click did. The state words and the empty-string
// table are in test/pipeline-reversal.test.mjs.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";
import { bootToDesktop, stepToDesktop } from "./helpers/boot";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const V1 = join(SCRIPT_DIR, "..", "..", "..", "packages", "api", "fixtures", "v1");
const fx = (...p: string[]) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
const LIST = fx("listWorkItems", "200-page.json");
const REPOS = fx("listRepos", "200-page.json");
const TIMELINE = fx("getWorkItemTimeline", "200-ok.json");
const ACTIVITY = fx("getWorkItemActivity", "200-receipts.json");
const ITEM = LIST.data[0].id as string;
const WIN = `#windows-container .fulc-window[data-app-id="pipeline"]`;
const tid = (page: Page, id: string) => page.locator(`${WIN} [data-testid="${id}"]`);
const [FREE, PRICED, STUCK, FAILED, WAITING, RETRY] = ["01", "02", "03", "04", "05", "06"].map((n) => `6b1f6c1e-3f5a-4e0e-9a55-0a7b1c2d3e${n}`);

type Reversal = { id: string; state: string; kind: string; reason_code: string | null; estimate_usd: number | null; pr_number: number | null; can_retry?: boolean; text: string };
interface Rx { id: string; label: string; price_kind: string; price_usd: number | null; price_text: string; deadline_text: string; can_reverse: boolean; reversal: Reversal | null }
interface Mock {
  receipts: Rx[];
  posts: { path: string; body: unknown }[];
  /** What the next write answers instead of the normal outcome. */
  fail: { status: number; code: string } | null;
  override: unknown;
  /** The estimate the confirm route holds a reversal to: a figure below it answers 409 with this number. */
  live: number;
}

const row = (id: string, label: string, over: Partial<Rx>): Rx => ({ id, label, price_kind: "not_yet_priced", price_usd: null, price_text: "No price yet.", deadline_text: "No free window.", can_reverse: true, reversal: null, ...over });
const seed = (): Rx[] => [
  row(FREE, "Undoing an earlier decision", { price_kind: "free_until", deadline_text: "Free to reverse until 2026-10-31 14:05:09 UTC." }),
  row(PRICED, "Starting a small piece of work", { price_kind: "estimate", price_usd: 1.5, price_text: "About $1.50 of your model spend so far on this item." }),
  row(STUCK, "A decision that cannot be undone", { price_kind: "unavailable", price_text: "This decision cannot be reversed.", can_reverse: false }),
  row(WAITING, "A reversal waiting for its estimate", {
    can_reverse: false,
    reversal: { id: "c-waiting", state: "awaiting_confirm", kind: "rerun", reason_code: null, estimate_usd: 2.25, pr_number: null, text: "Waiting for you to confirm the estimate. Nothing has been spent." },
  }),
  row(FAILED, "A decision whose revert failed", {
    can_reverse: false,
    reversal: { id: "c-failed", state: "failed", kind: "revert_pr", reason_code: "tooling_error", can_retry: false, estimate_usd: null, pr_number: null, text: "GitHub could not open a revert for this pull request, most likely because later changes conflict with it." },
  }),
  row(RETRY, "A decision whose revert could not start", {
    can_reverse: false,
    reversal: { id: "c-retry", state: "failed", kind: "revert_pr", reason_code: "no_installation", can_retry: true, estimate_usd: null, pr_number: null, text: "The GitHub App is no longer installed on this repository, so nothing was changed. Install it again, then try again." },
  }),
];

function listBody(m: Mock) {
  return {
    total: m.receipts.length,
    receipts: m.receipts.map((r) => ({
      id: r.id, label: r.label, class: 2, at: "2026-10-23T10:00:00.000Z", name: r.label + ", 2026-10-23 10:00:00 UTC", by: "person", chosen: "yes", rejected: "no",
      reverses_receipt_id: null, reverses_text: "", free_until: null, deadline_text: r.deadline_text, price_kind: r.price_kind, price_usd: r.price_usd, price_text: r.price_text, can_reverse: r.can_reverse, reversal: r.reversal,
    })),
  };
}

async function mockApi(page: Page): Promise<Mock> {
  const mock: Mock = { receipts: seed(), posts: [], fail: null, override: null, live: 2.25 };
  const send = (route: Route, status: number, json: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(json) });
  await page.route((u) => u.pathname.startsWith("/api/v1/") && u.pathname !== "/api/v1/events", async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const method = route.request().method();
    if (p === "/api/v1/work-items" && url.searchParams.get("stage") === "needs_human") return send(route, 200, { data: [], next_cursor: null });
    if (method === "POST") {
      const body = JSON.parse(route.request().postData() ?? "{}");
      mock.posts.push({ path: p, body });
      if (mock.fail) return send(route, mock.fail.status, { error: { code: mock.fail.code, message: "server words that must never be shown", request_id: "req_1" } });
      if (mock.override) return send(route, 200, mock.override);
      const rec = (id: string) => mock.receipts.find((r) => r.id === id);
      const outcome = (status: string, message: string, id: string) => ({ status, reversal_id: "c-new", receipt_id: id, kind: "rerun", reason_code: null, estimate_usd: null, ask_id: null, message });
      const rt = p.match(/\/reversals\/([^/]+)\/retry$/);
      if (rt) {
        const r = mock.receipts.find((x) => x.reversal?.id === rt[1]);
        if (!r || !r.reversal) return send(route, 404, { error: { code: "not_found", message: "x", request_id: "r" } });
        if (!r.reversal.can_retry) return send(route, 409, { error: { code: "not_retryable", message: "server words that must never be shown", request_id: "r" } });
        r.reversal = { ...r.reversal, state: "pending", reason_code: null, can_retry: false, text: "Waiting to start." };
        return send(route, 200, outcome("started", "Trying again. It will start shortly.", r.id));
      }
      const cf = p.match(/\/reversals\/([^/]+)\/confirm$/);
      if (cf) {
        const r = mock.receipts.find((x) => x.reversal?.id === cf[1]);
        const sent = (body as { confirmEstimateUsd?: number }).confirmEstimateUsd;
        if (!r || !r.reversal) return send(route, 404, { error: { code: "not_found", message: "x", request_id: "r" } });
        if (typeof sent !== "number" || sent < mock.live) return send(route, 409, { error: { code: "estimate_changed", message: "server words that must never be shown", request_id: "r" }, data: { current_estimate_usd: mock.live } });
        r.reversal = { ...r.reversal, state: "running", estimate_usd: sent, text: "In progress." };
        return send(route, 200, outcome("started", "Reversal recorded.", r.id));
      }
      const rv = p.match(/\/receipts\/([^/]+)\/reverse$/);
      if (rv) {
        const r = rec(rv[1]);
        if (!r) return send(route, 404, { error: { code: "not_found", message: "x", request_id: "r" } });
        const priced = r.price_kind === "estimate";
        const sent = (body as { confirmEstimateUsd?: number }).confirmEstimateUsd;
        r.can_reverse = false;
        r.reversal = priced && sent === undefined
          ? { id: "c-" + r.id, state: "awaiting_confirm", kind: "rerun", reason_code: null, estimate_usd: r.price_usd, pr_number: null, text: "Waiting for you to confirm the estimate. Nothing has been spent." }
          : priced
            ? { id: "c-" + r.id, state: "running", kind: "rerun", reason_code: null, estimate_usd: r.price_usd, pr_number: null, text: "In progress." }
            : { id: "c-" + r.id, state: "done", kind: "none_before_build", reason_code: null, estimate_usd: null, pr_number: null, text: "Reversed before the build started. Nothing on GitHub was changed; decide again when you are ready." };
        return send(route, 200, outcome(r.reversal.state === "done" ? "done" : "started", "Reversal recorded.", r.id));
      }
      return send(route, 404, { error: { code: "not_found", message: "x", request_id: "r" } });
    }
    if (p === "/api/v1/work-items") return send(route, 200, { data: [{ ...LIST.data[0], stage: "in_progress" }], next_cursor: null });
    if (p === "/api/v1/repos") return send(route, 200, REPOS);
    if (p.endsWith("/timeline")) return send(route, 200, TIMELINE);
    if (p.endsWith("/activity")) return send(route, 200, ACTIVITY);
    if (p.endsWith("/receipts")) return send(route, 200, listBody(mock));
    if (p === "/api/v1/runs") return send(route, 200, { data: [], next_cursor: null });
    return send(route, 404, { error: { code: "not_found", message: "x", request_id: "req_1" } });
  });
  await page.route("**/api/v1/events", (route) => route.fulfill({ status: 200, contentType: "text/event-stream", headers: { "cache-control": "no-store" }, body: "event: idle\ndata: {}\n\n" }));
  return mock;
}

async function openCard(page: Page) {
  await page.evaluate(async () => (await import(new URL("core/cloud-live.js", document.baseURI).href)).default.start());
  await page.evaluate(() => (window as unknown as { FULCWM: Record<string, (id: string) => void> }).FULCWM.open("pipeline"));
  await expect(page.locator(WIN)).toBeVisible();
  await expect(page.locator(WIN)).not.toHaveClass(/opening/);
  await expect(tid(page, "pl-card")).toHaveCount(1);
  await tid(page, "pl-card").first().click();
  await expect(tid(page, "pl-receipts")).toBeVisible();
}

async function setup(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  const mock = await mockApi(page);
  await bootToDesktop(page);
  await openCard(page);
  return { mock, errors };
}

async function reload(page: Page) {
  await page.reload();
  await stepToDesktop(page);
  await openCard(page);
}

const line = (page: Page, label: string) => tid(page, "pl-receipt").filter({ hasText: label });

test.describe("D#7 DP7-2f: the Reverse control (mocked API)", () => {
  test("a free receipt shows its deadline and reverses in one click; after a reload it reads Reversed with the original struck through in words", async ({ page }) => {
    const { mock, errors } = await setup(page);
    const free = line(page, "Undoing an earlier decision");
    await expect(free).toContainText("Free to reverse until 2026-10-31 14:05:09 UTC.");
    await free.getByTestId("pl-reverse").click();
    await expect(free.getByTestId("pl-reverse-note")).toHaveText(/Reversal recorded\./);
    expect(mock.posts).toEqual([{ path: `/api/v1/receipts/${FREE}/reverse`, body: {} }]);
    await reload(page);
    const again = line(page, "Undoing an earlier decision");
    await expect(again).toContainText("Reversed. Reversed before the build started.");
    await expect(again.getByTestId("pl-receipt-struck")).toContainText("Undoing an earlier decision.");
    expect(await again.getByTestId("pl-receipt-struck").evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe("line-through");
    await expect(again.getByRole("button")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("a priced receipt shows the estimate first: cancel spends nothing and sends nothing; confirm sends the figure shown and a reload shows its state", async ({ page }) => {
    const { mock, errors } = await setup(page);
    const priced = line(page, "Starting a small piece of work").first();
    await expect(priced).toContainText("About $1.50");
    await priced.getByTestId("pl-reverse").click();
    await expect(priced.getByTestId("pl-reverse-estimate")).toHaveText("A fresh build would use about $1.50 of your model spend. Nothing is spent until you confirm.");
    await priced.getByTestId("pl-reverse-cancel").click();
    await expect(priced.getByTestId("pl-reverse")).toBeVisible();
    await expect(priced.getByTestId("pl-reverse-estimate")).toHaveCount(0);
    expect(mock.posts).toEqual([]);
    await priced.getByTestId("pl-reverse").click();
    await priced.getByTestId("pl-reverse-confirm").click();
    await expect(priced.getByTestId("pl-reverse-note")).toBeVisible();
    expect(mock.posts).toEqual([{ path: `/api/v1/receipts/${PRICED}/reverse`, body: { confirmEstimateUsd: 1.5 } }]);
    await reload(page);
    const again = line(page, "Starting a small piece of work").first();
    await expect(again).toContainText("In progress.");
    await expect(again.getByRole("button")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("an estimate that went up while the reversal waited: the 409's figure is shown, the next Confirm sends it, and then it runs", async ({ page }) => {
    const { mock, errors } = await setup(page);
    const waiting = line(page, "A reversal waiting for its estimate").first();
    await expect(waiting).toContainText("about $2.25");
    mock.live = 3.4;
    await waiting.getByTestId("pl-reverse-confirm-pending").click();
    await expect(waiting.getByTestId("pl-reverse-note")).toContainText("The estimate changed while you were deciding");
    await expect(waiting).toContainText("about $3.40");
    await waiting.getByTestId("pl-reverse-confirm-pending").click();
    await expect(waiting.getByTestId("pl-reverse-note")).toContainText("Reversal recorded.");
    expect(mock.posts).toEqual([
      { path: "/api/v1/reversals/c-waiting/confirm", body: { confirmEstimateUsd: 2.25 } },
      { path: "/api/v1/reversals/c-waiting/confirm", body: { confirmEstimateUsd: 3.4 } },
    ]);
    await reload(page);
    await expect(line(page, "A reversal waiting for its estimate").first()).toContainText("In progress.");
    expect(errors).toEqual([]);
  });

  test("a receipt that cannot be reversed shows its reason and what to do instead, with no control; a failed reversal shows its reason and no control", async ({ page }) => {
    const { errors } = await setup(page);
    const stuck = line(page, "A decision that cannot be undone");
    await expect(stuck).toContainText("This decision cannot be reversed. To change course, ask for the work again.");
    await expect(stuck.getByRole("button")).toHaveCount(0);
    const failed = line(page, "A decision whose revert failed");
    await expect(failed).toContainText("Reversal failed. GitHub could not open a revert for this pull request");
    await expect(failed.getByRole("button")).toHaveCount(0);
    await expect(tid(page, "pl-receipts")).not.toContainText(/null|undefined|revert_refused|[0-9a-f]{8}-[0-9a-f]{4}/);
    expect(errors).toEqual([]);
  });

  test("a failed reversal the server allows to retry shows Try again; one click retries the same reversal, and after a reload it reads Waiting to start with no button", async ({ page }) => {
    const { mock, errors } = await setup(page);
    const failed = line(page, "A decision whose revert could not start");
    await expect(failed).toContainText("Reversal failed. The GitHub App is no longer installed on this repository");
    await failed.getByTestId("pl-reverse-retry").click();
    await expect(failed.getByTestId("pl-reverse-note")).toContainText("Trying again. It will start shortly.");
    expect(mock.posts).toEqual([{ path: "/api/v1/reversals/c-retry/retry", body: {} }]);
    const count = mock.receipts.length;
    await reload(page);
    const again = line(page, "A decision whose revert could not start");
    await expect(again).toContainText("Waiting to start.");
    await expect(again.getByRole("button")).toHaveCount(0);
    await expect(tid(page, "pl-receipt")).toHaveCount(count);
    await expect(tid(page, "pl-receipts")).not.toContainText(/null|undefined|no_installation|[0-9a-f]{8}-[0-9a-f]{4}/);
    expect(errors).toEqual([]);
  });

  test("a failed reversal the worker will retry by itself shows no Try again; a member's press gets the owner-or-admin sentence and nothing changes; a stale press says to refresh", async ({ page }) => {
    const { mock, errors } = await setup(page);
    await expect(line(page, "A decision whose revert failed").getByRole("button")).toHaveCount(0);
    const failed = line(page, "A decision whose revert could not start");
    mock.fail = { status: 403, code: "forbidden" };
    await failed.getByTestId("pl-reverse-retry").click();
    await expect(failed.getByTestId("pl-reverse-note")).toHaveText("Only an owner or an admin can retry a reversal.");
    await expect(failed.getByTestId("pl-reverse-retry")).toBeVisible();
    mock.fail = { status: 409, code: "not_retryable" };
    await failed.getByTestId("pl-reverse-retry").click();
    await expect(failed.getByTestId("pl-reverse-note")).toContainText("can't be tried again from here");
    await expect(tid(page, "pl-receipts")).not.toContainText("server words");
    expect(mock.receipts.find((r) => r.id === RETRY)?.reversal?.state).toBe("failed");
    expect(errors).toEqual([]);
  });

  test("Try again at 375px: nothing scrolls sideways, and it is reached by keyboard with a visible focus ring and pressed with Enter", async ({ page }) => {
    const { mock, errors } = await setup(page);
    await page.setViewportSize({ width: 375, height: 800 });
    const fit = await tid(page, "pl-detail").evaluate((el) => {
      const box = el as HTMLElement;
      const right = box.getBoundingClientRect().right;
      const wide = [...box.querySelectorAll("*")].filter((n) => n.getBoundingClientRect().width > 0 && n.getBoundingClientRect().right > right + 1).map((n) => n.tagName);
      return { scrollW: box.scrollWidth, clientW: box.clientWidth, doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, wide };
    });
    expect(fit.scrollW).toBeLessThanOrEqual(fit.clientW);
    expect(fit.doc).toBeLessThanOrEqual(0);
    expect(fit.wide).toEqual([]);
    await tid(page, "pl-receipts-heading").evaluate((el) => {
      el.setAttribute("tabindex", "-1");
      (el as HTMLElement).focus();
    });
    let reached = false;
    for (let i = 0; i < 16 && !reached; i++) {
      await page.keyboard.press("Tab");
      reached = await page.evaluate((id) => document.activeElement?.getAttribute("data-rx") === id + ":pl-reverse-retry", RETRY);
    }
    expect(reached).toBe(true);
    const ring = await page.evaluate(() => {
      const cs = getComputedStyle(document.activeElement as Element);
      return { width: parseFloat(cs.outlineWidth), style: cs.outlineStyle, matches: (document.activeElement as Element).matches(":focus-visible") };
    });
    expect(ring.matches).toBe(true);
    expect(ring.style).not.toBe("none");
    expect(ring.width).toBeGreaterThanOrEqual(2);
    await page.keyboard.press("Enter");
    await expect.poll(() => mock.posts.length).toBe(1);
    expect(mock.posts[0].path).toBe("/api/v1/reversals/c-retry/retry");
    expect(errors).toEqual([]);
  });

  test("a member's click gets the owner-or-admin sentence and nothing changes; an over-cap answer points to Needs you", async ({ page }) => {
    const { mock, errors } = await setup(page);
    const free = line(page, "Undoing an earlier decision");
    mock.fail = { status: 403, code: "forbidden" };
    await free.getByTestId("pl-reverse").click();
    await expect(free.getByTestId("pl-reverse-note")).toHaveText("Only an owner or an admin can reverse a decision.");
    await expect(free.getByTestId("pl-reverse")).toBeVisible();
    await expect(tid(page, "pl-receipts")).not.toContainText("server words");
    mock.fail = null;
    mock.override = { status: "needs_ask", reversal_id: null, receipt_id: FREE, kind: null, reason_code: null, estimate_usd: null, ask_id: "a1", message: "This work has already been reversed twice. A question is waiting for you in Needs you; nothing has been reversed." };
    await free.getByTestId("pl-reverse").click();
    await expect(free.getByTestId("pl-reverse-note")).toContainText("A question is waiting for you in Needs you");
    expect(errors).toEqual([]);
  });

  test("at 375px nothing scrolls sideways, and the control is reached by keyboard with a visible focus ring", async ({ page }) => {
    const { mock, errors } = await setup(page);
    await page.setViewportSize({ width: 375, height: 800 });
    const priced = line(page, "Starting a small piece of work").first();
    await priced.getByTestId("pl-reverse").click();
    await expect(priced.getByTestId("pl-reverse-confirm")).toBeVisible();
    const fit = await tid(page, "pl-detail").evaluate((el) => {
      const box = el as HTMLElement;
      const right = box.getBoundingClientRect().right;
      const wide = [...box.querySelectorAll("*")].filter((n) => n.getBoundingClientRect().width > 0 && n.getBoundingClientRect().right > right + 1).map((n) => n.tagName);
      return { scrollW: box.scrollWidth, clientW: box.clientWidth, doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, wide };
    });
    expect(fit.scrollW).toBeLessThanOrEqual(fit.clientW);
    expect(fit.doc).toBeLessThanOrEqual(0);
    expect(fit.wide).toEqual([]);
    await priced.getByTestId("pl-reverse-cancel").click();
    // Tab from the heading until the free receipt's Reverse button has focus, then read its ring and press it.
    await tid(page, "pl-receipts-heading").evaluate((el) => {
      el.setAttribute("tabindex", "-1");
      (el as HTMLElement).focus();
    });
    let reached = false;
    for (let i = 0; i < 12 && !reached; i++) {
      await page.keyboard.press("Tab");
      reached = await page.evaluate((id) => document.activeElement?.getAttribute("data-rx") === id + ":pl-reverse", FREE);
    }
    expect(reached).toBe(true);
    const ring = await page.evaluate(() => {
      const cs = getComputedStyle(document.activeElement as Element);
      return { width: parseFloat(cs.outlineWidth), style: cs.outlineStyle, matches: (document.activeElement as Element).matches(":focus-visible") };
    });
    expect(ring.matches).toBe(true);
    expect(ring.style).not.toBe("none");
    expect(ring.width).toBeGreaterThanOrEqual(2);
    await page.keyboard.press("Enter");
    await expect.poll(() => mock.posts.length).toBe(1);
    expect(mock.posts[0].path).toBe(`/api/v1/receipts/${FREE}/reverse`);
    expect(errors).toEqual([]);
  });
});
