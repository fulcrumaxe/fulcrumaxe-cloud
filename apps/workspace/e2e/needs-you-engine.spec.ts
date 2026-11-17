// apps/workspace/e2e/needs-you-engine.spec.ts
//
// EB-6c: the engine's open asks inside the Needs you list, on the built cloud dist served by fixture-server.mjs. Every call the window makes is answered by
// page.route(). The logic half is in test/needs-you-engine.test.mjs; this file covers what needs the real DOM and the production CSP: the repo's name is text in
// <bdi> and never an element (CWE-79), the list is a real list, a live `engine.changed` reads the asks again without a reload, the
// announcement is made on a change only, focus stays on the link that holds it across a refresh, the focus ring meets 3:1 against its row in every theme, and axe is
// clean under every theme. EB-13b adds the answer controls (Approve, Decline, Defer and a note), their locks, the sent and settled states, and the same focus, announcement and
// contrast rules for them. It runs on all three projects (desktop, phone, tablet).

import { test, expect, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { waitForDesktop } from "./helpers/boot";

const CSP = "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
const SERVER_TEXT = "server text that must never be shown";
const THEMES = ["classic-crt", "retro-amber", "nord", "corporate", "modern-flat", "crystal", "orchard", "cyberpunk"];
const R1 = "6f1c2f5e-3d8f-4f43-8d6e-8f2f6a9b1c22";
const R2 = "6f1c2f5e-3d8f-4f43-8d6e-8f2f6a9b1c33";
const CMD = "11111111-2222-4333-8444-555555555555";
// A note holds no bracket or angle (the engine host refuses them), so the hostile note has none: it checks that nothing typed is ever read as markup.
const HOSTILE_NOTE = 'img src=x onerror="window.__pwned=1" script window.__pwned=2 **bold** (x)(javascript:window.__pwned=3) &amp;';
const HOSTILE = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script> **bold** [x](javascript:window.__pwned=3) &amp;';

type Obj = Record<string, unknown>;
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const ask = (over: Obj = {}): Obj => ({ ask_id: "0123456789abcdef", ask_kind: "owner_decision", source: "team_log", discussion: 42, pr: 7, raised_at: hoursAgo(3), cleared_at: null, how: null, ...over });
const repo = (over: Obj = {}): Obj => ({ repo_id: R1, full_name: "acme-labs/widgets", liveness: "live", watch_enabled: true, operate_enabled: true, halted: false, ...over });

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
  /** EB-13b: whether the viewer is an owner or admin, every POST the page sent, the engine's report of the command, and a refusal for the command route. */
  admin: boolean;
  posts: { path: string; body: unknown; key: string | undefined }[];
  commandState: string;
  commandRefusal: string | null;
  /** The args and the note of the last answer_ask the page sent: the command list reports them back (what a reload reads), the note as a top-level field and never inside `args`, only for an owner or admin. */
  sentArgs: unknown;
  sentNote: string | undefined;
  postFail: { status: number; code: string } | null;
}
const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function setup(page: Page, tweak: Partial<Mock> = {}) {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP ${e.violatedDirective}`)));
  const mock: Mock = { repos: [repo()], asks: { [R1]: [ask()] }, heardAgeS: 20, asOf: minutesAgo(1), sourceAges: { loop: 60, team_log: 120 }, fail: [], streaming: false, streamFrame: null, reads: [], admin: true, posts: [], commandState: "pending", commandRefusal: null, sentArgs: undefined, sentNote: undefined, postFail: null, ...tweak };
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
    await route.fulfill({ status: res.status(), headers, json: { ...(await res.json()), is_admin: mock.admin } });
  });
  await page.route((u) => u.pathname.startsWith("/api/v1/") && u.pathname !== "/api/v1/events", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.method() === "POST" && /^\/api\/v1\/engine\/repos\/[^/]+\/commands$/.test(p)) {
      mock.posts.push({ path: p, body: req.postDataJSON(), key: req.headers()["idempotency-key"] });
      if (!mock.postFail) {
        const { note, ...closed } = ((req.postDataJSON() as { args?: Obj }).args ?? {}) as Obj & { note?: string };
        mock.sentArgs = closed;
        mock.sentNote = note;
      }
      if (mock.postFail) return json(route, mock.postFail.status, { error: { code: mock.postFail.code, message: SERVER_TEXT, request_id: "r" } });
      return json(route, 201, { command_id: CMD, state: "pending", expires_at: new Date(Date.now() + 600_000).toISOString() });
    }
    if (req.method() !== "GET") return json(route, 404, { error: { code: "not_found", message: SERVER_TEXT, request_id: "r" } });
    if ((req.headers()["accept"] ?? "").includes("text/event-stream")) return route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: idle\ndata: {}\n\n" });
    if (p.startsWith("/api/v1/engine/")) mock.reads.push(p);
    if (mock.fail.some((f) => p === f || p.endsWith(f))) return json(route, 500, { error: { code: "server_error", message: SERVER_TEXT, request_id: "r" } });
    const fresh = { next_cursor: null, as_of: mock.asOf, heard_age_s: mock.heardAgeS, source_ages_s: mock.sourceAges, gaps: [], missing_events: 0 };
    if (p === "/api/v1/engine/repos") return json(route, 200, { items: mock.repos, ...fresh });
    if (/^\/api\/v1\/engine\/repos\/[^/]+\/commands$/.test(p)) return json(route, 200, { commands: [{ id: CMD, state: mock.commandState, refusal: mock.commandRefusal, kind: "answer_ask", args: mock.sentArgs, ...(mock.admin && mock.sentNote !== undefined ? { note: mock.sentNote } : {}), expires_at: new Date(Date.now() + 600_000).toISOString(), acked_at: mock.commandState === "applied" ? minutesAgo(1) : null }] });
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
  test("an open ask shows the repo, a sentence for its kind, its D# and PR # links, how long ago, and the data's age; with operate off its buttons are locked", async ({ page }) => {
    const { errors } = await setup(page, { repos: [repo({ operate_enabled: false })] });
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
    // operate off: the controls are there but locked (EB-13b), and a fresh machine says nothing about being away
    await expect(row.locator("button")).toHaveCount(3);
    for (const b of await row.locator("button").all()) await expect(b).toHaveAttribute("aria-disabled", "true");
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

// EB-13b: answering an engine ask. Every call is answered by page.route(); the command route's reply and the engine's report of the command are the mock's.
const btn = (page: Page, row: string, choice: string) => t(page, `ny-choice-${row}-${choice}`);
const ROWID = `engine-${R1}-0123456789abcdef`;
const noteField = (page: Page) => t(page, `ny-note-${ROWID}`);
/** Lets the app's own 3 s look at a sent command run once, then reads what the page says. */
const waitForPost = (mock: Mock, n: number) => expect.poll(() => mock.posts.length, { timeout: 15_000 }).toBe(n);

test.describe("EB-13b: answering an engine ask", () => {
  test("an owner sees Approve, Decline and Defer and a labelled note field with a live count; a decision ask has no Defer", async ({ page }) => {
    const { errors } = await setup(page, { asks: { [R1]: [ask(), ask({ ask_id: "fedcba9876543210", ask_kind: "decision", discussion: null, pr: null })] } });
    await open(page);
    await countIs(page, 2);
    await expect(btn(page, ROWID, "approve")).toHaveText("Approve");
    await expect(btn(page, ROWID, "decline")).toHaveText("Decline");
    await expect(btn(page, ROWID, "defer")).toHaveText("Defer");
    await expect(page.locator(`${WIN} [data-testid^="ny-choice-engine-${R1}-fedcba9876543210-"]`)).toHaveCount(2);
    // the field is labelled, and its count is live without being announced
    const field = noteField(page);
    await expect(page.getByLabel("Note for the engine (optional)").first()).toHaveAttribute("id", `ny-note-${ROWID}`);
    await expect(field).not.toHaveAttribute("maxlength", /.*/); // a long paste is counted and refused, never cut silently
    await expect(t(page, "ny-count").first()).toHaveText("0 / 500");
    await field.fill("Go ahead");
    await expect(t(page, "ny-count").first()).toHaveText("8 / 500");
    await expect(t(page, "ny-live")).toHaveText("");
    // buttons are named for their row and are real buttons, not disabled
    await expect(btn(page, ROWID, "approve")).toHaveAttribute("aria-label", "Approve: acme-labs/widgets");
    await expect(btn(page, ROWID, "approve")).not.toHaveAttribute("disabled", /.*/);
    await expect(btn(page, ROWID, "approve")).toHaveAttribute("aria-disabled", "false");
    await expect(page.locator(`${WIN} [data-testid="ny-rows"]`)).toHaveAttribute("role", "list");
    await clean(page, errors);
  });

  test("pressing Approve sends one answer_ask command with the note, says so once, keeps focus on the button, locks the row, and quotes the note back as text", async ({ page }) => {
    const { mock, errors } = await setup(page);
    await open(page);
    await countIs(page, 1);
    await noteField(page).fill(HOSTILE_NOTE.slice(0, 120));
    await btn(page, ROWID, "approve").focus();
    await page.keyboard.press("Enter");
    await waitForPost(mock, 1);
    expect(mock.posts[0]!.path).toBe(`/api/v1/engine/repos/${R1}/commands`);
    expect(mock.posts[0]!.body).toEqual({ kind: "answer_ask", args: { ask_id: "0123456789abcdef", choice: "approve", note: HOSTILE_NOTE.slice(0, 120).trim() } });
    expect(mock.posts[0]!.key).toMatch(/^[0-9a-f-]{36}$/);
    await expect(t(page, "ny-sent")).toHaveText("Sent: Approve. Waiting for the engine to confirm.");
    await expect(t(page, "ny-live")).toHaveText("Sent: Approve. Waiting for the engine to confirm.");
    // focus stayed on the same button (it is aria-disabled now, not removed), and a second press sends nothing more
    expect(await focusedAct(page)).toBe("choice-approve");
    for (const c of ["approve", "decline", "defer"]) await expect(btn(page, ROWID, c)).toHaveAttribute("aria-disabled", "true");
    await btn(page, ROWID, "approve").click({ force: true }); // Playwright treats aria-disabled as disabled; force it to prove a press is ignored
    await page.waitForTimeout(300);
    expect(mock.posts).toHaveLength(1);
    // the note comes back as text only: no element, no script
    const quoted = t(page, "ny-note-sent");
    await expect(quoted.locator("q")).toHaveText(HOSTILE_NOTE.slice(0, 120).trim());
    await expect(quoted.locator("q *")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    await clean(page, errors);
  });

  test("the engine's report moves the row to applied (said once), and the row leaves when the ask clears; the page reads the asks again by itself", async ({ page }) => {
    const { mock, errors } = await setup(page, { streaming: true });
    await open(page);
    await countIs(page, 1);
    await btn(page, ROWID, "defer").click();
    await waitForPost(mock, 1);
    expect((mock.posts[0]!.body as { args: Obj }).args).toEqual({ ask_id: "0123456789abcdef", choice: "defer" });
    await expect(t(page, "ny-live")).toHaveText(/^Sent: Defer\./);
    mock.commandState = "applied";
    await expect(t(page, "ny-sent")).toHaveAttribute("data-state", "applied", { timeout: 15_000 });
    await expect(t(page, "ny-live")).toHaveText("The engine took your answer: Defer. This ask leaves the list once the engine clears it.");
    // the engine clears the ask: the next read drops the row, says so once, and focus lands on the list heading
    mock.asks[R1] = [];
    await expect(page.locator(`${WIN} [data-testid="ny-row"]`)).toHaveCount(0, { timeout: 15_000 });
    await expect(t(page, "ny-live")).toHaveText("1 engine ask cleared.");
    await expect(page.locator(`${WIN} #ny-heading`)).toBeFocused();
    await clean(page, errors);
  });

  test("a refused answer shows its reason and Send again sends a new command", async ({ page }) => {
    const { mock, errors } = await setup(page);
    await open(page);
    await countIs(page, 1);
    await btn(page, ROWID, "decline").click();
    await waitForPost(mock, 1);
    mock.commandState = "refused";
    mock.commandRefusal = "host_not_running";
    await expect(t(page, "ny-sent")).toHaveAttribute("data-state", "refused", { timeout: 15_000 });
    await expect(t(page, "ny-sent")).toHaveText("The engine's host is not running, so nothing could take the answer. Start it, then send it again.");
    await expect(t(page, "ny-live")).toHaveText("The engine's host is not running, so nothing could take the answer. Start it, then send it again.");
    mock.commandState = "pending";
    await t(page, `ny-again-${ROWID}`).click();
    await waitForPost(mock, 2);
    expect(mock.posts[1]!.body).toEqual(mock.posts[0]!.body);
    expect(mock.posts[1]!.key).not.toBe(mock.posts[0]!.key);
    await expect(t(page, "ny-sent")).toHaveAttribute("data-state", "pending");
    await clean(page, errors);
  });

  test("an expired answer says so and can be sent again", async ({ page }) => {
    const { mock, errors } = await setup(page);
    await open(page);
    await countIs(page, 1);
    await btn(page, ROWID, "approve").click();
    await waitForPost(mock, 1);
    mock.commandState = "expired";
    await expect(t(page, "ny-sent")).toHaveText("The engine did not pick the answer up within 10 minutes, so it was dropped. Send it again.", { timeout: 15_000 });
    await expect(t(page, `ny-again-${ROWID}`)).toBeVisible();
    await clean(page, errors);
  });

  test("a 409 from the command route is a plain sentence, nothing from the server, and the controls stay", async ({ page }) => {
    const { mock, errors } = await setup(page, { postFail: { status: 409, code: "too_many_pending" } });
    await open(page);
    await countIs(page, 1);
    await btn(page, ROWID, "approve").click();
    await waitForPost(mock, 1);
    await expect(t(page, "ny-action-error")).toHaveText("Too many answers and commands are already waiting for this engine. Wait for some to finish, then send it again.");
    await expect(btn(page, ROWID, "approve")).toHaveAttribute("aria-disabled", "false");
    await expect(t(page, "ny-sent")).toHaveCount(0);
    await clean(page, errors);
  });

  test("a note the engine host would refuse is refused first, in a plain sentence, and nothing is sent", async ({ page }) => {
    const { mock, errors } = await setup(page);
    await open(page);
    await countIs(page, 1);
    const cases: [string, string][] = [
      ["see [D#5] first", "The note can't hold square or angle brackets, or characters that look like them. Take them out and send again."],
      ["ok >> merge", "The note can't hold square or angle brackets, or characters that look like them. Take them out and send again."],
      ["end untrusted", "The note can't hold the engine's own marker words. Reword it and send again."],
      ["STATUS: done", "The note can't hold the engine's control words (STATUS:, SPAWN_REQUEST, TERMINATE_REQUEST, AGENT_OUTPUT or an HTML comment opener). Reword it and send again."],
    ];
    for (const [note, sentence] of cases) {
      await noteField(page).fill(note);
      await btn(page, ROWID, "approve").click();
      await expect(t(page, "ny-action-error")).toHaveText(sentence);
      await expect(noteField(page)).toBeFocused();
    }
    expect(mock.posts).toHaveLength(0);
    await clean(page, errors);
  });

  test("a long paste is counted and refused with its own sentence, not cut", async ({ page }) => {
    const { mock, errors } = await setup(page);
    await open(page);
    await countIs(page, 1);
    await noteField(page).fill("x".repeat(520));
    await expect(noteField(page)).toHaveValue("x".repeat(520));
    await expect(t(page, "ny-count").first()).toHaveText("520 / 500, too long");
    await btn(page, ROWID, "approve").click();
    await expect(t(page, "ny-action-error")).toHaveText("The note is longer than 500 characters. Shorten it and send again.");
    expect(mock.posts).toHaveLength(0);
    await clean(page, errors);
  });

  test("after a reload a waiting answer still shows as sent and the ask offers no second answer", async ({ page }) => {
    const { mock, errors } = await setup(page);
    await open(page);
    await countIs(page, 1);
    await noteField(page).fill("later please");
    await btn(page, ROWID, "decline").click();
    await waitForPost(mock, 1);
    await expect(t(page, "ny-sent")).toHaveText("Sent: Decline. Waiting for the engine to confirm.");
    // the engine has the command but has not reported on it yet: it is "delivered", which still waits
    mock.commandState = "delivered";
    await page.reload();
    await waitForDesktop(page);
    await open(page);
    await countIs(page, 1);
    await expect(t(page, "ny-sent")).toHaveText("Sent: Decline. Waiting for the engine to confirm.");
    await expect(t(page, "ny-note-sent").locator("q")).toHaveText("later please");
    for (const c of ["approve", "decline", "defer"]) await expect(btn(page, ROWID, c)).toHaveAttribute("aria-disabled", "true");
    await expect(noteField(page)).toHaveAttribute("aria-disabled", "true");
    await btn(page, ROWID, "approve").click({ force: true });
    await page.waitForTimeout(300);
    expect(mock.posts).toHaveLength(1);
    // the engine's report still reaches the reloaded page
    mock.commandState = "applied";
    await expect(t(page, "ny-sent")).toHaveAttribute("data-state", "applied", { timeout: 15_000 });
    await clean(page, errors);
  });

  test("after a reload an answer the engine already took stays locked, as applied, with its note", async ({ page }) => {
    const { mock, errors } = await setup(page);
    await open(page);
    await countIs(page, 1);
    await noteField(page).fill("go ahead");
    await btn(page, ROWID, "approve").click();
    await waitForPost(mock, 1);
    // the engine took the answer but has not cleared the ask yet
    mock.commandState = "applied";
    await page.reload();
    await waitForDesktop(page);
    await open(page);
    await countIs(page, 1);
    await expect(t(page, "ny-sent")).toHaveAttribute("data-state", "applied");
    await expect(t(page, "ny-sent")).toHaveText("The engine took your answer: Approve. This ask leaves the list once the engine clears it.");
    await expect(t(page, "ny-note-sent").locator("q")).toHaveText("go ahead");
    for (const c of ["approve", "decline", "defer"]) await expect(btn(page, ROWID, c)).toHaveAttribute("aria-disabled", "true");
    await btn(page, ROWID, "decline").click({ force: true });
    await page.waitForTimeout(300);
    expect(mock.posts).toHaveLength(1);
    await clean(page, errors);
  });

  test("when the command list cannot be read the ask stays locked, says why, and Try again reads it once more", async ({ page }) => {
    const { mock, errors } = await setup(page, { fail: ["/commands"] });
    await open(page);
    await countIs(page, 1);
    await expect(t(page, "ny-unchecked")).toHaveText("Can't check whether an answer is already waiting. Try again.");
    for (const c of ["approve", "decline", "defer"]) await expect(btn(page, ROWID, c)).toHaveAttribute("aria-disabled", "true");
    await btn(page, ROWID, "approve").click({ force: true });
    await page.waitForTimeout(300);
    expect(mock.posts).toHaveLength(0);
    // still failing: it stays locked
    await t(page, "ny-recheck-" + ROWID).click();
    await expect(t(page, "ny-unchecked")).toBeVisible();
    // the list answers (and holds no answer for this ask): the controls come back
    mock.fail = [];
    await t(page, "ny-recheck-" + ROWID).click();
    await expect(t(page, "ny-unchecked")).toHaveCount(0);
    await expect(btn(page, ROWID, "approve")).toHaveAttribute("aria-disabled", "false");
    await btn(page, ROWID, "approve").click();
    await waitForPost(mock, 1);
    await clean(page, errors);
  });

  test("a note with a hidden character is refused before it is sent, and focus goes back to the field", async ({ page }) => {
    const { mock, errors } = await setup(page);
    await open(page);
    await countIs(page, 1);
    // the field is one line, so a hidden character can only arrive pasted or set from outside: set it the way a paste would
    await noteField(page).evaluate((el: HTMLInputElement) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, "ok" + String.fromCharCode(0x200b) + "hidden");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await btn(page, ROWID, "approve").click();
    await expect(t(page, "ny-action-error")).toHaveText("The note can't hold line breaks or hidden characters. Edit it and send again.");
    expect(mock.posts).toHaveLength(0);
    await expect(noteField(page)).toBeFocused();
    await clean(page, errors);
  });

  test("with operate off the controls are aria-disabled and name why; a press sends nothing", async ({ page }) => {
    const { mock, errors } = await setup(page, { repos: [repo({ operate_enabled: false })] });
    await open(page);
    await countIs(page, 1);
    await expect(t(page, "ny-lock")).toHaveText("Operate is off for this repository, so answers can't be sent from here. An owner or admin can switch it on in Team.");
    for (const c of ["approve", "decline", "defer"]) {
      await expect(btn(page, ROWID, c)).toHaveAttribute("aria-disabled", "true");
      await expect(btn(page, ROWID, c)).toHaveAttribute("aria-describedby", `ny-lock-${ROWID}`);
    }
    await expect(noteField(page)).toHaveAttribute("aria-disabled", "true");
    await btn(page, ROWID, "approve").click({ force: true });
    await page.waitForTimeout(300);
    expect(mock.posts).toHaveLength(0);
    await clean(page, errors);
  });

  test("a halted engine still takes an answer, and the row says it is halted", async ({ page }) => {
    const { mock, errors } = await setup(page, { repos: [repo({ halted: true })] });
    await open(page);
    await countIs(page, 1);
    await expect(t(page, "ny-halted")).toHaveText("The engine is halted. An answer is still delivered, but nothing new starts until the halt is cleared.");
    await expect(t(page, "ny-lock")).toHaveCount(0);
    await btn(page, ROWID, "approve").click();
    await waitForPost(mock, 1);
    await clean(page, errors);
  });

  test("a member sees who answers, and no control at all", async ({ page }) => {
    const { errors } = await setup(page, { admin: false });
    await open(page);
    await countIs(page, 1);
    await expect(t(page, "ny-waiting")).toHaveText("Waiting for an owner or admin to answer.");
    await expect(page.locator(`${WIN} [data-testid="ny-row"] button`)).toHaveCount(0);
    await expect(page.locator(`${WIN} [data-testid="ny-row"] input`)).toHaveCount(0);
    await clean(page, errors);
  });

  test("a refresh keeps the note, the caret and focus in the field", async ({ page }) => {
    const { mock, errors } = await setup(page, { streaming: true });
    await open(page);
    await countIs(page, 1);
    const field = noteField(page);
    await field.click();
    await page.keyboard.type("keep this");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    mock.reads.length = 0;
    await sendEvent(page, mock, "engine.changed");
    await expect.poll(() => mock.reads.filter((p) => p === "/api/v1/engine/repos").length, { timeout: 15_000 }).toBe(1);
    await expect(field).toBeFocused();
    await expect(field).toHaveValue("keep this");
    await page.keyboard.type("X");
    await expect(field).toHaveValue("keep thXis");
    await expect(t(page, "ny-count").first()).toHaveText("10 / 500");
    await clean(page, errors);
  });

  test("the focus ring on a button and on the note field is 3 px and meets 3:1 against its row in every theme", async ({ page }) => {
    await setup(page);
    await open(page);
    await countIs(page, 1);
    for (const theme of THEMES) {
      await applyTheme(page, theme);
      for (const sel of [`${WIN} [data-testid="ny-choice-${ROWID}-approve"]`, `${WIN} [data-testid="ny-note-${ROWID}"]`]) {
        await page.locator(sel).focus();
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Tab");
        const r = await page.evaluate((s) => {
          const el = document.querySelector(s) as HTMLElement;
          const row = el.closest("li") as HTMLElement;
          const cs = getComputedStyle(el);
          const parse = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 4).map(Number);
          const lum = ([r, g, b]: number[]) => {
            const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
            return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
          };
          let bg = parse(getComputedStyle(row).backgroundColor);
          let up: HTMLElement | null = row;
          while (bg.length === 4 && bg[3] === 0 && up?.parentElement) {
            up = up.parentElement;
            bg = parse(getComputedStyle(up).backgroundColor);
          }
          const [a, b] = [lum(parse(cs.outlineColor)), lum(bg)];
          return { focused: document.activeElement === el, width: parseFloat(cs.outlineWidth), style: cs.outlineStyle, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
        }, sel);
        expect(r.focused, `${theme} ${sel}`).toBe(true);
        expect(r.style, theme).toBe("solid");
        expect(r.width, theme).toBeGreaterThanOrEqual(3);
        expect(r.ratio, `${theme} ${sel}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  test("axe finds nothing serious or critical on the controls, the locked row, a sent answer and a refused one, under every theme", async ({ page }) => {
    const { mock } = await setup(page, { repos: [repo(), repo({ repo_id: R2, full_name: "acme-labs/locked", operate_enabled: false, halted: true })], asks: { [R1]: [ask()], [R2]: [ask({ ask_id: "aaaaaaaaaaaaaaaa", ask_kind: "decision" })] } });
    await open(page);
    await countIs(page, 2);
    await noteField(page).fill("a note");
    await btn(page, ROWID, "approve").click();
    await waitForPost(mock, 1);
    await expect(t(page, "ny-sent")).toBeVisible();
    for (const theme of THEMES) {
      await applyTheme(page, theme);
      expect(await axeSeriousOrCritical(page), theme).toEqual([]);
    }
    mock.commandState = "refused";
    mock.commandRefusal = "unknown_ask";
    await expect(t(page, "ny-sent")).toHaveAttribute("data-state", "refused", { timeout: 15_000 });
    for (const theme of THEMES) {
      await applyTheme(page, theme);
      expect(await axeSeriousOrCritical(page), theme).toEqual([]);
    }
  });

  test("the answer controls do not make the phone width scroll sideways", async ({ page }) => {
    const { errors } = await setup(page, { repos: [repo({ full_name: "acme-labs/a-repository-with-a-very-long-name-that-has-to-wrap-somewhere-on-a-phone" })] });
    await open(page);
    await countIs(page, 1);
    await noteField(page).fill("x".repeat(500));
    const widths = await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      return [el.scrollWidth, el.clientWidth];
    }, `${WIN} .ny-app`);
    expect(widths[0]).toBeLessThanOrEqual(widths[1]);
    await expect(t(page, "ny-count").first()).toHaveText("500 / 500");
    await clean(page, errors);
  });
});
