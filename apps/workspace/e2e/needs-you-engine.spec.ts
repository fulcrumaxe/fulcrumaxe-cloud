// apps/workspace/e2e/needs-you-engine.spec.ts
//
// EB-6c: the engine's open asks inside the Needs you list, on the built cloud dist served by fixture-server.mjs. Every call the window makes is answered by
// page.route(). The logic half is in test/needs-you-engine.test.mjs; this file covers what needs the real DOM and the production CSP: the repo's name is text in
// <bdi> and never an element (CWE-79), the list is a real list, the rows have no button, a live `engine.changed` reads the asks again without a reload, the
// announcement is made on a change only, focus stays on the link that holds it across a refresh, the focus ring meets 3:1 against its row in every theme, and axe is
// clean under every theme. It runs on all three projects (desktop, phone, tablet).

import { test, expect, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { waitForDesktop } from "./helpers/boot";

const CSP = "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
const SERVER_TEXT = "server text that must never be shown";
const THEMES = ["classic-crt", "retro-amber", "nord", "corporate", "modern-flat", "crystal", "orchard", "cyberpunk"];
const R1 = "6f1c2f5e-3d8f-4f43-8d6e-8f2f6a9b1c22";
const R2 = "6f1c2f5e-3d8f-4f43-8d6e-8f2f6a9b1c33";
const HOSTILE = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script> **bold** [x](javascript:window.__pwned=3) &amp;';

type Obj = Record<string, unknown>;
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const ask = (over: Obj = {}): Obj => ({ ask_id: "0123456789abcdef", ask_kind: "owner_decision", source: "team_log", discussion: 42, pr: 7, raised_at: hoursAgo(3), cleared_at: null, how: null, ...over });
const repo = (over: Obj = {}): Obj => ({ repo_id: R1, full_name: "acme-labs/widgets", liveness: "live", watch_enabled: true, ...over });

interface Mock {
  repos: Obj[];
  asks: Record<string, Obj[]>;
  /** Freshness of every repo's read. */
  heardAgeS: number | null;
  asOf: string;
  sourceAges: Obj;
  /** The routes that answer 500. */
  fail: string[];
  streaming: boolean;
  streamFrame: string | null;
  reads: string[];
}
const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function setup(page: Page, tweak: Partial<Mock> = {}) {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP ${e.violatedDirective}`)));
  const mock: Mock = { repos: [repo()], asks: { [R1]: [ask()] }, heardAgeS: 20, asOf: minutesAgo(1), sourceAges: { loop: 60, team_log: 120 }, fail: [], streaming: false, streamFrame: null, reads: [], ...tweak };
  await page.route((u) => u.pathname === "/", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": CSP } });
  });
  await page.route("**/api/v1/events", async (route) => {
    if (!mock.streaming) return new Promise<void>(() => {});
    const body = mock.streamFrame ?? "event: idle\ndata: {}\n\n";
    mock.streamFrame = null;
    await route.fulfill({ status: 200, contentType: "text/event-stream", headers: { "cache-control": "no-store" }, body });
  });
  await page.route("**/api/cloud/auth/me", async (route) => {
    const res = await route.fetch();
    const headers = { ...res.headers() };
    delete headers["content-length"];
    await route.fulfill({ status: res.status(), headers, json: { ...(await res.json()), is_admin: true } });
  });
  await page.route((u) => u.pathname.startsWith("/api/v1/") && u.pathname !== "/api/v1/events", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.method() !== "GET") return json(route, 404, { error: { code: "not_found", message: SERVER_TEXT, request_id: "r" } });
    if ((req.headers()["accept"] ?? "").includes("text/event-stream")) return route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: idle\ndata: {}\n\n" });
    if (p.startsWith("/api/v1/engine/")) mock.reads.push(p);
    if (mock.fail.some((f) => p === f || p.endsWith(f))) return json(route, 500, { error: { code: "server_error", message: SERVER_TEXT, request_id: "r" } });
    const fresh = { next_cursor: null, as_of: mock.asOf, heard_age_s: mock.heardAgeS, source_ages_s: mock.sourceAges, gaps: [], missing_events: 0 };
    if (p === "/api/v1/engine/repos") return json(route, 200, { items: mock.repos, ...fresh });
    const m = p.match(/^\/api\/v1\/engine\/repos\/([^/]+)\/asks$/);
    if (m) return json(route, 200, { items: mock.asks[m[1]!] ?? [], ...fresh });
    if (p === "/api/v1/setup-requests") return json(route, 200, { requests: [], truncated: false });
    if (p === "/api/v1/decision-asks" || p === "/api/v1/work-items") return json(route, 200, { data: [], next_cursor: null });
    if (p === "/api/v1/merge-ready" || p === "/api/v1/stalled-items") return json(route, 200, { items: [], not_shown: 0 });
    if (p === "/api/v1/verify-sign-in") return json(route, 200, { items: [] });
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
const countIs = (page: Page, n: number) => expect(page.locator(`${WIN} h2`)).toHaveText(`Needs you (${n})`);
const frame = (type: string) => `id: c-${Math.random().toString(36).slice(2)}\nevent: ${type}\ndata: ${JSON.stringify({ id: "e1", type, created_at: new Date().toISOString(), data: { repo_id: R1, session_id: R2, last_seq: 9 } })}\n\n`;
/** Hands the page one live event and waits until the stream has taken it (the live client reopens on input). */
async function sendEvent(page: Page, mock: Mock, type: string) {
  mock.streamFrame = frame(type);
  await expect.poll(async () => { if (mock.streamFrame !== null) await page.evaluate(() => window.dispatchEvent(new Event("pointerdown"))); return mock.streamFrame; }, { timeout: 30_000 }).toBeNull();
}
async function clean(page: Page, errors: string[]) {
  expect(errors).toEqual([]);
  const text = await page.evaluate(() => document.body.innerText);
  expect(text).not.toMatch(/\bnull\b|undefined|NaN|Invalid Date|ApiError/);
  expect(text).not.toMatch(/owner_decision|merge_blocked|review_blocked|team_log/); // no enum on the screen
  expect(text).not.toContain(SERVER_TEXT);
  expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
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
const focusedAct = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute("data-act") ?? "");

test.describe("EB-6c: engine asks in Needs you", () => {
  test("an open ask shows the repo, a sentence for its kind, its D# and PR # links, how long ago, and the data's age, with no button", async ({ page }) => {
    const { errors } = await setup(page);
    await open(page);
    await countIs(page, 1);
    const row = t(page, "ny-row");
    await expect(row).toHaveAttribute("data-kind", "engine");
    await expect(row.locator('[data-testid="ny-title"]')).toHaveText("acme-labs/widgets");
    await expect(row.locator('[data-testid="ny-sentence"]')).toHaveText("The engine is waiting for you to decide something.");
    await expect(t(page, "ny-engine-link-0")).toHaveText("D#42 (opens in a new tab)");
    await expect(t(page, "ny-engine-link-0")).toHaveAttribute("href", "https://github.com/acme-labs/widgets/discussions/42");
    await expect(t(page, "ny-engine-link-1")).toHaveText("PR #7 (opens in a new tab)");
    // The hint is real text for a screen reader and is not drawn (clipped to 1 px), and it is not the link's whole name by accident: the link's own words come first.
    for (const i of [0, 1]) {
      const hint = t(page, "ny-engine-link-hint-" + i);
      await expect(hint).toHaveText(" (opens in a new tab)");
      const box = await hint.evaluate((el) => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height }; });
      expect(box.w).toBeLessThanOrEqual(1);
      expect(box.h).toBeLessThanOrEqual(1);
      await expect(t(page, "ny-engine-link-" + i)).toHaveAttribute("target", "_blank");
    }
    await expect(t(page, "ny-engine-link-1")).toHaveAttribute("href", "https://github.com/acme-labs/widgets/pull/7");
    await expect(t(page, "ny-engine-link-1")).toHaveAttribute("rel", /noopener/);
    await expect(t(page, "ny-raised")).toHaveText(/^Raised 3 h ago$/);
    await expect(t(page, "ny-asof")).toHaveText(/^As of \d{1,2}:\d{2}.* \(\d+ min ago\)$/);
    // watch only: nothing to press but the links, and a fresh machine says nothing about being away
    await expect(row.locator("button")).toHaveCount(0);
    await expect(t(page, "ny-machine")).toHaveCount(0);
    await expect(t(page, "ny-stale")).toHaveCount(0);
    await expect(t(page, "ny-source")).toHaveCount(0);
    await expect(t(page, "ny-engine-error")).toHaveCount(0);
    await clean(page, errors);
  });

  test("every kind of ask reads as its own sentence", async ({ page }) => {
    const kinds = ["owner_decision", "merge_blocked", "credential", "budget", "review_blocked", "other", "decision", "a_kind_added_later"];
    const { errors } = await setup(page, { asks: { [R1]: kinds.map((k, i) => ask({ ask_id: "a" + i, ask_kind: k, pr: null, discussion: null })) } });
    await open(page);
    await countIs(page, kinds.length);
    const sentences = await t(page, "ny-sentence").allTextContents();
    expect(new Set(sentences).size).toBe(kinds.length - 1); // the unknown kind reads as "other"
    expect(sentences[7]).toBe(sentences[5]);
    await expect(t(page, "ny-refs")).toHaveCount(0);
    await clean(page, errors);
  });

  test("the list is a real list, in one fixed order with the oldest ask first", async ({ page }) => {
    await setup(page, { asks: { [R1]: [ask({ ask_id: "new", raised_at: minutesAgo(30) }), ask({ ask_id: "old", raised_at: hoursAgo(5) })] } });
    await open(page);
    await countIs(page, 2);
    await expect(page.locator(`${WIN} [data-testid="ny-rows"]`)).toHaveAttribute("role", "list");
    await expect(page.locator(`${WIN} [role="list"] > li`)).toHaveCount(2);
    await expect(t(page, "ny-raised").nth(0)).toHaveText("Raised 5 h ago");
    await expect(t(page, "ny-raised").nth(1)).toHaveText("Raised 30 min ago");
  });

  test("a repo's name is text in <bdi>: no markup, no element, no script", async ({ page }) => {
    const { errors } = await setup(page, { repos: [repo({ full_name: HOSTILE })] });
    await open(page);
    await countIs(page, 1);
    const title = t(page, "ny-title");
    await expect(title).toHaveText(HOSTILE);
    await expect(title.locator("bdi")).toHaveCount(1);
    await expect(title.locator("bdi")).toHaveText(HOSTILE);
    await expect(t(page, "ny-row").locator("img, script, b, strong, em, iframe, svg")).toHaveCount(0);
    await expect(t(page, "ny-row").locator("a")).toHaveCount(0); // the name does not build a link
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    expect(errors).toEqual([]);
  });

  test("L2: a quiet machine, a quiet team log and an old ask each say so, and keep the ask on screen", async ({ page }) => {
    const { errors } = await setup(page, { heardAgeS: 600, sourceAges: { team_log: 3 * 3600 + 30 }, asks: { [R1]: [ask({ raised_at: hoursAgo(24 * 8) })] } });
    await open(page);
    await countIs(page, 1);
    await expect(t(page, "ny-machine")).toHaveText("Machine last seen 10 min ago; this ask may already be answered.");
    await expect(t(page, "ny-source")).toHaveText("Team log not updated for 3 h.");
    await expect(t(page, "ny-stale")).toHaveText("This ask is over 7 days old and may be stale.");
    await expect(t(page, "ny-raised")).toHaveText("Raised 8 days ago");
    await clean(page, errors);
  });

  test("L2: a machine that was never heard from says that, not a time", async ({ page }) => {
    const { errors } = await setup(page, { heardAgeS: null });
    await open(page);
    await expect(t(page, "ny-machine")).toHaveText("The machine has not been heard from; this ask may already be answered.");
    await clean(page, errors);
  });

  test("a failed read of the engine's asks is one line, and the rest of the list is still there", async ({ page }) => {
    const { errors } = await setup(page, { fail: ["/api/v1/engine/repos"] });
    await open(page);
    await expect(t(page, "ny-engine-error")).toHaveText("Engine asks could not be loaded");
    await expect(t(page, "ny-engine-error")).toHaveCount(1);
    await expect(t(page, "ny-empty")).toHaveCount(0); // "nothing needs you" would not be true
    await expect(t(page, "ny-error")).toHaveCount(0); // the list itself did not fail
    await expect(t(page, "ny-live")).toHaveText("Engine asks could not be loaded.");
    await clean(page, errors);
  });

  test("a repo with nothing open reads as empty, with no line about the engine", async ({ page }) => {
    const { errors } = await setup(page, { asks: { [R1]: [] } });
    await open(page);
    await expect(t(page, "ny-empty")).toHaveText("Nothing needs you right now.");
    await expect(t(page, "ny-engine-error")).toHaveCount(0);
    await clean(page, errors);
  });

  test("a cloud that has no engine routes yet is no engine asks and no error", async ({ page }) => {
    const { errors } = await setup(page, { repos: [] });
    await page.route("**/api/v1/engine/repos", (route) => json(route, 404, { error: { code: "not_found", message: SERVER_TEXT, request_id: "r" } }));
    await open(page);
    await expect(t(page, "ny-empty")).toBeVisible();
    await expect(t(page, "ny-engine-error")).toHaveCount(0);
    await clean(page, errors);
  });

  test("engine.changed reads the asks again without a reload: a new ask appears and a cleared one leaves, each announced once, and focus stays on its link", async ({ page }) => {
    const { mock, errors } = await setup(page, { streaming: true, asks: { [R1]: [ask({ ask_id: "one" })] } });
    await open(page);
    await countIs(page, 1);
    await expect(t(page, "ny-live")).toHaveText(""); // the first read says nothing
    // focus a link, then a new ask arrives
    await t(page, "ny-engine-link-0").focus();
    expect(await focusedAct(page)).toBe("link-0");
    mock.asks[R1] = [ask({ ask_id: "one" }), ask({ ask_id: "two", ask_kind: "budget", raised_at: minutesAgo(2) })];
    mock.reads.length = 0;
    await sendEvent(page, mock, "engine.changed");
    await countIs(page, 2);
    await expect(t(page, "ny-live")).toHaveText("1 new engine ask.");
    expect(mock.reads.filter((p) => p === "/api/v1/engine/repos")).toHaveLength(1); // one read for the event
    // the redraw kept focus on the same link of the same row
    expect(await focusedAct(page)).toBe("link-0");
    await expect(page.locator(`${WIN} [data-id$="-one"] [data-act="link-0"]`)).toBeFocused();
    // an unrelated refresh (the next one) with nothing changed says nothing more
    // the first ask is cleared
    mock.asks[R1] = [ask({ ask_id: "two", ask_kind: "budget", raised_at: minutesAgo(2) })];
    await sendEvent(page, mock, "engine.changed");
    await countIs(page, 1);
    await expect(t(page, "ny-live")).toHaveText("1 engine ask cleared.");
    // focus was on a row that left: it goes to the list heading, not to the page
    await expect(page.locator(`${WIN} #ny-heading`)).toBeFocused();
    await clean(page, errors);
  });

  test("the live region says nothing when a read finds nothing changed", async ({ page }) => {
    const { mock, errors } = await setup(page, { streaming: true });
    await open(page);
    await countIs(page, 1);
    mock.reads.length = 0;
    await sendEvent(page, mock, "engine.changed");
    await expect.poll(() => mock.reads.filter((p) => p === "/api/v1/engine/repos").length, { timeout: 15_000 }).toBe(1);
    await expect(t(page, "ny-live")).toHaveText("");
    await clean(page, errors);
  });

  test("the focus ring is 3 px and meets 3:1 against its row in every theme", async ({ page }) => {
    await setup(page);
    await open(page);
    await countIs(page, 1);
    for (const theme of THEMES) {
      await applyTheme(page, theme);
      await t(page, "ny-engine-link-0").focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab"); // keyboard focus, so :focus-visible applies
      const r = await page.evaluate((sel) => {
        const link = document.querySelector(sel) as HTMLElement;
        const row = link.closest("li") as HTMLElement;
        const cs = getComputedStyle(link);
        const parse = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 4).map(Number);
        const lum = ([r, g, b]: number[]) => {
          const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
          return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
        };
        // The colour behind the ring is the row's own background, or the window's when the row has none.
        let bg = parse(getComputedStyle(row).backgroundColor);
        let el: HTMLElement | null = row;
        while (bg.length === 4 && bg[3] === 0 && el?.parentElement) {
          el = el.parentElement;
          bg = parse(getComputedStyle(el).backgroundColor);
        }
        const ring = parse(cs.outlineColor);
        const [a, b] = [lum(ring), lum(bg)];
        return { focused: document.activeElement === link, width: parseFloat(cs.outlineWidth), style: cs.outlineStyle, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
      }, `${WIN} [data-testid="ny-engine-link-0"]`);
      expect(r.focused, theme).toBe(true);
      expect(r.style, theme).toBe("solid");
      expect(r.width, theme).toBeGreaterThanOrEqual(3);
      expect(r.ratio, theme).toBeGreaterThanOrEqual(3);
    }
  });

  test("axe finds nothing serious or critical on engine rows, a stale row and the failure line, under every theme", async ({ page }) => {
    await setup(page, { heardAgeS: 900, sourceAges: { team_log: 4 * 3600 }, asks: { [R1]: [ask({ raised_at: hoursAgo(24 * 9) }), ask({ ask_id: "two", ask_kind: "credential", pr: null })] } });
    await open(page);
    await countIs(page, 2);
    for (const theme of THEMES) {
      await applyTheme(page, theme);
      expect(await axeSeriousOrCritical(page), theme).toEqual([]);
    }
  });

  test("axe finds nothing serious or critical when only the failure line is shown, under every theme", async ({ page }) => {
    await setup(page, { fail: ["/api/v1/engine/repos"] });
    await open(page);
    await expect(t(page, "ny-engine-error")).toBeVisible();
    for (const theme of THEMES) {
      await applyTheme(page, theme);
      expect(await axeSeriousOrCritical(page), theme).toEqual([]);
    }
  });

  test("two repos give rows named for their own repo, and the phone width does not scroll sideways", async ({ page }) => {
    const { errors } = await setup(page, { repos: [repo(), repo({ repo_id: R2, full_name: "acme-labs/a-repository-with-a-very-long-name-that-has-to-wrap-somewhere-on-a-phone" })], asks: { [R1]: [ask({ ask_id: "a" })], [R2]: [ask({ ask_id: "b", raised_at: hoursAgo(9) })] } });
    await open(page);
    await countIs(page, 2);
    await expect(t(page, "ny-title").nth(0)).toContainText("a-repository-with-a-very-long-name");
    await expect(t(page, "ny-title").nth(1)).toHaveText("acme-labs/widgets");
    const widths = await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      return [el.scrollWidth, el.clientWidth];
    }, `${WIN} .ny-app`);
    expect(widths[0]).toBeLessThanOrEqual(widths[1]);
    await clean(page, errors);
  });
});
