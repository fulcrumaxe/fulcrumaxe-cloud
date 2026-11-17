// apps/workspace/e2e/team.spec.ts
//
// The Team app (agents, merge lanes, the watch switch) on the built cloud dist, served by fixture-server.mjs, at phone, tablet and desktop. Every call the
// window makes is answered by page.route() with the documented engine read shapes (test/fixtures/team/fixtures.mjs). The logic half (the agent-state
// table, the data-age and gap rules, the exact requests) is in test/team.test.mjs; this file covers what needs the real DOM and the production CSP:
// names are text and never elements, nothing reads null/undefined/NaN, the banner cannot be dismissed, the layout per breakpoint (element counts and
// bounding boxes), contrast numbers and axe under every theme, and engine.changed refetching every panel.

import { test, expect, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { bootToDesktop, waitForDesktop } from "./helpers/boot";
import { HOSTILE, REPO_A, REPO_B, makeFixtures } from "../test/fixtures/team/fixtures.mjs";

const CSP = "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
const SERVER_TEXT = "server text that must never be shown";
const THEMES = ["classic-crt", "retro-amber", "nord", "corporate", "modern-flat", "crystal", "orchard", "cyberpunk"];
const WIN = `#windows-container .fulc-window[data-app-id="team"]`;
const BASE = "/api/v1/engine";
type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

interface Mock {
  settings: Obj;
  repos: Obj[];
  agents: Obj;
  lanes: Obj;
  gates: Obj;
  log: Obj;
  /** The plan answer; null is a 204 (no snapshot). */
  plan: Obj | null;
  stats: Obj;
  usage: Obj;
  /** When set, answers /log by cursor (a page of lines, and the cursor for the next) instead of `log`. */
  logPage: ((cursor: string) => Obj) | null;
  /** Every PUT, with its body. */
  puts: { path: string; body: unknown }[];
  /** GET reads per path (query included). */
  reads: string[];
  /** Path fragments that answer 500. */
  fail: string[];
  /** The plan GET answers 404 with no code, as a server that has no such route does. */
  failPlan404?: boolean;
  /** The PUT answer: 200, or an error status with its code. */
  putStatus: number;
  putCode: string;
  streaming: boolean;
  streamFrame: string | null;
  /** The command list ({commands}) and the repo's decision settings; both change when the app writes. */
  commands: Obj;
  dials: Obj;
  /** Every POST to the command route or the dial route. */
  posts: { path: string; body: any }[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** Every DELETE of a command, by id. */
  deletes: string[];
  /** The answer to a command POST (201) or a command DELETE (200), or an error status with `postCode`. */
  postStatus: number;
  postCode: string;
  /** The answer to a dial POST: 200, or an error status with `dialCode`. */
  dialStatus: number;
  dialCode: string;
  /** Every POST to a halt route, as "halt" or "clear". */
  halts: string[];
  /** The answer to a halt or clear POST: 200, or an error status with `haltCode`. A successful halt leaves the repo halted, and pending when `haltPends`. */
  haltStatus: number;
  haltCode: string;
  haltPends: boolean;
}
const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

function fresh(over: Partial<Mock> = {}): Mock {
  const F = makeFixtures(Date.now());
  return {
    settings: F.settings(), repos: [F.repo(), F.repo({ repo_id: REPO_B, full_name: "acme-labs/site", runner_name: "Studio desktop" })],
    agents: F.envelope([F.agent(), F.agent({ agent_id: "b2c3d4e5f6071829", role: "code-reviewer", discussion: 43, background: true, started_at: F.iso(120) })]),
    lanes: F.envelope([F.lane({ pr: 7, state: "testing" }), F.lane({ pr: 9, discussion: 44, state: "queued" }), F.lane({ pr: 5, discussion: 40, state: "merged" })]),
    gates: F.envelope([F.gate({ pr: 7, gate: "gate1", result: "pass" }), F.gate({ pr: 7, gate: "code_review", result: "fail" }), F.gate({ pr: 5, gate: "ci_full", result: "pass" })]),
    log: F.envelope([F.logLine({ line_id: "aaaa000000000001", pr: 7 }), F.logLine({ line_id: "aaaa000000000002", actor_role: "executor", category: "spawned", pr: null }), F.logLine({ line_id: "aaaa000000000003", discussion: null, pr: 9, category: "gate_passed" })]),
    plan: F.plan(), stats: F.stats(), usage: F.usage(), logPage: null,
    puts: [], reads: [], fail: [], putStatus: 200, putCode: "", streaming: false, streamFrame: null,
    commands: { commands: [] }, dials: F.dials(), posts: [], deletes: [], postStatus: 201, postCode: "", dialStatus: 200, dialCode: "", halts: [], haltStatus: 200, haltCode: "", haltPends: true, ...over,
  };
}

async function setup(page: Page, mock: Mock, opts: { clock?: boolean } = {}) {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP ${e.violatedDirective}`)));
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
  await page.route((u) => u.pathname.startsWith("/api/v1/repos/") && u.pathname.includes("/decision-settings"), async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    mock.reads.push(url.pathname);
    if (req.method() === "GET") return json(route, 200, mock.dials);
    const body = req.postDataJSON();
    mock.posts.push({ path: url.pathname, body });
    if (mock.dialStatus !== 200) return json(route, mock.dialStatus, { error: { code: mock.dialCode, message: SERVER_TEXT, request_id: "r" } });
    mock.dials = { ...mock.dials, dials: mock.dials.dials.map((d: Obj) => (d.decision_type === body.decision_type ? { ...d, disposition: body.disposition } : d)) };
    return json(route, 200, mock.dials);
  });
  await page.route((u) => u.pathname.startsWith(BASE), async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname + url.search;
    if (req.method() === "GET") {
      mock.reads.push(p);
      if (mock.fail.some((f) => p.includes(f))) return json(route, 500, { error: { code: "server_error", message: SERVER_TEXT, request_id: "r" } });
      if (url.pathname === `${BASE}/settings`) return json(route, 200, mock.settings);
      if (url.pathname === `${BASE}/repos`) return json(route, 200, { items: mock.repos });
      const m = url.pathname.match(new RegExp(`^${BASE}/repos/([^/]+)/(agents|lanes|gates|log|plan|stats|usage)$`));
      if (m && m[2] === "plan" && mock.failPlan404) return json(route, 404, { error: { code: "", message: SERVER_TEXT, request_id: "r" } });
      if (m && m[2] === "plan") return mock.plan === null ? route.fulfill({ status: 204 }) : json(route, 200, mock.plan);
      if (m && m[2] === "log" && mock.logPage) return json(route, 200, mock.logPage(url.searchParams.get("cursor") ?? ""));
      if (m) return json(route, 200, mock[m[2] as "agents" | "lanes" | "gates" | "log" | "stats" | "usage"]);
      if (url.pathname.endsWith("/commands")) return json(route, 200, mock.commands);
    }
    if (req.method() === "POST" && url.pathname.endsWith("/commands")) {
      const body = req.postDataJSON();
      mock.posts.push({ path: url.pathname, body });
      if (mock.postStatus !== 201) return json(route, mock.postStatus, { error: { code: mock.postCode, message: SERVER_TEXT, request_id: "r" } });
      const F = makeFixtures(Date.now());
      const id = `c0000000-0000-4000-8000-${String(mock.commands.commands.length + 1).padStart(12, "0")}`;
      mock.commands = { commands: [F.command({ id, kind: body.kind, args: body.args }), ...mock.commands.commands] };
      return json(route, 201, { command_id: id, state: "pending", expires_at: new Date(Date.now() + 540000).toISOString() });
    }
    const hm = req.method() === "POST" ? url.pathname.match(new RegExp(`^${BASE}/repos/([^/]+)/halt(/clear)?$`)) : null;
    if (hm) {
      const kind = hm[2] ? "clear" : "halt";
      mock.halts.push(kind);
      expect(req.postDataJSON()).toEqual({});
      if (mock.haltStatus !== 200) return json(route, mock.haltStatus, { error: { code: mock.haltCode, message: SERVER_TEXT, request_id: "r" } });
      mock.repos = mock.repos.map((r) => (r.repo_id === decodeURIComponent(hm[1]) ? { ...r, halted: kind === "halt", halt_pending: kind === "halt" && mock.haltPends } : r));
      return json(route, 200, kind === "halt" ? { halt_epoch: 1, halted: true, applied: false } : { halt_epoch: 1, halted: false });
    }
    if (req.method() === "DELETE" && url.pathname.startsWith(`${BASE}/commands/`)) {
      const id = decodeURIComponent(url.pathname.slice(`${BASE}/commands/`.length));
      mock.deletes.push(id);
      if (mock.postStatus !== 201) return json(route, mock.postStatus, { error: { code: mock.postCode, message: SERVER_TEXT, request_id: "r" } });
      mock.commands = { commands: mock.commands.commands.map((c: Obj) => (c.id === id ? { ...c, state: "cancelled" } : c)) };
      return json(route, 200, { command_id: id, state: "cancelled" });
    }
    if (req.method() === "PUT") {
      mock.puts.push({ path: url.pathname, body: req.postDataJSON() });
      if (mock.putStatus !== 200) return json(route, mock.putStatus, { error: { code: mock.putCode, message: SERVER_TEXT, request_id: "r" } });
      const body = (req.postDataJSON() ?? {}) as Obj;
      if (typeof body.watch_enabled === "boolean") mock.settings = { ...mock.settings, watch_enabled: body.watch_enabled };
      if (typeof body.operate_enabled === "boolean") {
        mock.settings = { ...mock.settings, operate_enabled: body.operate_enabled };
        mock.repos = mock.repos.map((r) => ({ ...r, operate_enabled: body.operate_enabled }));
      }
      if (Array.isArray(body.repo_ids)) mock.settings = { ...mock.settings, repos: mock.settings.repos.map((r: Obj) => ({ ...r, enabled: body.repo_ids.includes(r.repo_id) })) };
      return json(route, 200, { ok: true });
    }
    return json(route, 404, { error: { code: "not_found", message: SERVER_TEXT, request_id: "r" } });
  });
  if (opts.clock) await bootToDesktop(page);
  else {
    await page.goto("/");
    await waitForDesktop(page);
  }
  return { mock, errors };
}

const t = (page: Page, id: string) => page.locator(`${WIN} [data-testid="${id}"]`);
const open = async (page: Page) => {
  await page.locator('.dock-icon[data-app-id="team"]').click();
  const win = page.locator(WIN);
  await expect(win).toBeVisible();
  await expect(win).not.toHaveClass(/opening/);
  await expect(t(page, "tm-loading")).toHaveCount(0);
  return win;
};
const press = async (loc: ReturnType<Page["locator"]>) => {
  if (test.info().project.name === "phone") await loc.tap();
  else await loc.click();
};
async function clean(page: Page, errors: string[]) {
  expect(errors).toEqual([]);
  const text = await page.evaluate(() => document.body.innerText);
  expect(text).not.toMatch(/\bnull\b|undefined|NaN|Invalid Date|ApiError|Could not load/);
  expect(text).not.toContain(SERVER_TEXT);
  expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i); // no id stands in for a name
}
async function applyTheme(page: Page, theme: string) {
  await page.evaluate(async (id) => {
    const m = await import(new URL("core/theme-manager.js", document.baseURI).href);
    await m.FULCTheme.apply(id);
  }, theme);
}
type Box = { x: number; y: number; width: number; height: number };
const box = async (loc: ReturnType<Page["locator"]>): Promise<Box> => {
  const b = await loc.boundingBox();
  if (!b) throw new Error("no bounding box");
  return b;
};

test.describe("Team app", () => {
  test("a repo with a live engine: picker, chip, agents with D# links, lanes with gate chips and a Merged today list", async ({ page }) => {
    const { errors } = await setup(page, fresh());
    await open(page);
    await expect(t(page, "tm-repo").locator("option")).toHaveText(["acme-labs/widgets", "acme-labs/site"]);
    await expect(t(page, "tm-chip")).toHaveText("Engine connection: Live");
    await expect(t(page, "tm-runner")).toHaveText("Runner: Workshop laptop");
    await expect(t(page, "tm-agent")).toHaveCount(2);
    await expect(t(page, "tm-agent").nth(0)).toContainText("executor");
    await expect(t(page, "tm-agent").nth(0).locator("a")).toHaveAttribute("href", "https://github.com/acme-labs/widgets/discussions/42");
    await expect(t(page, "tm-agent").nth(0).locator("a")).toHaveAttribute("rel", /noopener/);
    await expect(t(page, "tm-agent").nth(0).locator("a")).toHaveAttribute("aria-label", "D#42 (opens in a new window)");
    await expect(page.locator(`${WIN} .tm-app ul:not([role="list"])`)).toHaveCount(0); // list-style:none drops the list role in some readers, so each list says it
    await expect(t(page, "tm-chip").locator(".tm-vh")).toHaveText("Engine connection: ");
    await expect(t(page, "tm-agent").nth(1)).toContainText("background");
    await expect(t(page, "tm-agent-text").nth(0)).toHaveText(/^since \d\d:\d\d$/);
    await expect(t(page, "tm-lane")).toHaveCount(3);
    const open7 = page.locator(`${WIN} [data-testid="tm-lane"][data-pr="7"]`);
    await expect(open7.locator('[data-testid="tm-gate"]')).toHaveText(["Gate 1: pass", "Code review: fail"]);
    await expect(open7.locator('[data-testid="tm-pr"]')).toHaveAttribute("href", "https://github.com/acme-labs/widgets/pull/7");
    const merged = t(page, "tm-merged");
    await expect(merged).toContainText("Merged today");
    await expect(merged.locator('[data-testid="tm-lane"]')).toHaveCount(1);
    await expect(merged.locator('[data-testid="tm-pr"]')).toHaveText("PR #5");
    await expect(t(page, "tm-agents-asof")).toHaveText(/^as of \d\d:\d\d \(\d+ min ago\)$/);
    await expect(t(page, "tm-lanes-asof")).toHaveText(/^as of \d\d:\d\d \(\d+ min ago\)$/);
    await expect(t(page, "tm-banner")).toBeHidden();
    await expect(t(page, "tm-agents-warn")).toHaveCount(0);
    await clean(page, errors);
  });

  test("layout numbers: the two panels sit side by side when the window is wide and stack when it is narrow; nothing overflows and every control is 44 px", async ({ page }) => {
    const { errors } = await setup(page, fresh());
    await open(page);
    // A phone window is first drawn at its default size and then fitted to the screen; measure after the fit.
    if (test.info().project.name === "phone") await expect.poll(() => page.evaluate((sel) => (document.querySelector(sel) as HTMLElement).getBoundingClientRect().width <= innerWidth + 1, WIN)).toBe(true);
    // One synchronous read, so a window still settling from its open animation cannot move between the three boxes.
    const [app, a, l] = await page.evaluate((sel) => ([".tm-app", '[data-testid="tm-agents"]', '[data-testid="tm-lanes"]'] as const).map((q) => { const r = (document.querySelector(sel + " " + q) as HTMLElement).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }), WIN) as Box[];
    // The layout switches on the app's own CSS width (a phone window is drawn scaled, so its box in the viewport is not that width).
    const cssWidth = await page.evaluate((sel) => (document.querySelector(sel) as HTMLElement).clientWidth, `${WIN} .tm-app`);
    const wide = cssWidth - 28 >= 640;
    if (test.info().project.name === "phone") expect(wide).toBe(false);
    if (wide) {
      expect(Math.abs(a.y - l.y)).toBeLessThanOrEqual(1);
      expect(l.x).toBeGreaterThanOrEqual(a.x + a.width - 1);
    } else {
      expect(l.y).toBeGreaterThanOrEqual(a.y + a.height - 1);
      expect(Math.abs(a.x - l.x)).toBeLessThanOrEqual(1);
    }
    for (const b of [a, l]) {
      expect(b.x).toBeGreaterThanOrEqual(app.x - 0.5);
      expect(b.x + b.width).toBeLessThanOrEqual(app.x + app.width + 0.5);
    }
    const over = await page.evaluate((sel) => { const el = document.querySelector(sel) as HTMLElement; return [el.scrollWidth, el.clientWidth]; }, `${WIN} .tm-app`);
    expect(over[0]).toBeLessThanOrEqual(over[1]);
    for (const id of ["tm-repo", "tm-settings-btn"]) expect((await box(t(page, id))).height).toBeGreaterThanOrEqual(43.5); // the phone window is drawn at a scale just under 1
    // The second row: plan and stats side by side when wide; the log spans the whole width.
    const [pl, st, lg, us] = await page.evaluate((sel) => (['[data-testid="tm-plan"]', '[data-testid="tm-stats"]', '[data-testid="tm-log"]', '[data-testid="tm-usage"]'] as const).map((q) => { const r = (document.querySelector(sel + " " + q) as HTMLElement).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }), WIN) as Box[];
    if (wide) {
      expect(Math.abs(pl.y - st.y)).toBeLessThanOrEqual(1);
      expect(lg.width).toBeGreaterThan(pl.width + st.width - 2);
    } else {
      expect(st.y).toBeGreaterThanOrEqual(pl.y + pl.height - 1);
      expect(Math.abs(lg.width - a.width)).toBeLessThanOrEqual(1);
    }
    // The Cost panel spans the whole width below plan and stats, and the log comes after it.
    expect(us.y).toBeGreaterThanOrEqual(Math.max(pl.y + pl.height, st.y + st.height) - 1);
    expect(Math.abs(us.width - lg.width)).toBeLessThanOrEqual(1);
    expect(lg.y).toBeGreaterThanOrEqual(us.y + us.height - 1);
    console.log("LAYOUT2 " + JSON.stringify({ project: test.info().project.name, plan: [Math.round(pl.x), Math.round(pl.y), Math.round(pl.width), Math.round(pl.height)], stats: [Math.round(st.x), Math.round(st.y), Math.round(st.width), Math.round(st.height)], log: [Math.round(lg.x), Math.round(lg.y), Math.round(lg.width), Math.round(lg.height)] }));
    // Element counts: one picker, one chip, six panels, 18 rows (2 agents, 3 lane rows, 2 plan items, 2 roadmap rows, 4 figures, 2 cost rows, 3 log lines), one heading.
    expect(await page.locator(`${WIN} .tm-panels .tm-panel`).count()).toBe(6);
    expect(await page.locator(`${WIN} .tm-panels .tm-item`).count()).toBe(18);
    expect(await page.locator(`${WIN} .tm-bar select`).count()).toBe(1);
    expect(await page.locator(`${WIN} h2`).count()).toBe(1);
    console.log("LAYOUT " + JSON.stringify({ project: test.info().project.name, app: [Math.round(app.width), Math.round(app.height), cssWidth], agents: [Math.round(a.x), Math.round(a.y), Math.round(a.width), Math.round(a.height)], lanes: [Math.round(l.x), Math.round(l.y), Math.round(l.width), Math.round(l.height)], wide }));
    await clean(page, errors);
  });

  test("L3: an agent that started 4 h ago with no stop reads unknown, and the word running is never used for it", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const { errors } = await setup(page, fresh({ agents: F.envelope([F.agent({ started_at: F.iso(4 * 3600) }), F.agent({ agent_id: "b2c3d4e5f6071829", state: "unknown", started_at: F.iso(500) })]) }));
    await open(page);
    const rows = t(page, "tm-agent");
    await expect(rows).toHaveCount(2);
    for (const i of [0, 1]) {
      await expect(rows.nth(i)).toHaveAttribute("data-state", "unknown");
      await expect(rows.nth(i).locator('[data-testid="tm-agent-text"]')).toHaveText(/^unknown: started \d\d:\d\d, no stop seen$/);
      expect((await rows.nth(i).innerText()).toLowerCase()).not.toContain("running");
    }
    await expect(t(page, "tm-agents-empty")).toHaveCount(0);
    await clean(page, errors);
  });

  test("L2: a stale heartbeat shows last seen N min ago on every panel and keeps the data, and a running agent turns unknown", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const { errors } = await setup(page, fresh({
      repos: [F.repo({ liveness: "stale", last_heard_at: F.iso(600) })],
      agents: F.envelope([F.agent()], { heard_age_s: 600 }), lanes: F.envelope([F.lane()], { heard_age_s: 600 }), gates: F.envelope([F.gate()], { heard_age_s: 600 }),
    }));
    await open(page);
    await expect(t(page, "tm-chip")).toHaveText(/^Engine connection: Stale since \d\d:\d\d$/);
    await expect(t(page, "tm-agents-warn")).toHaveText("last seen 10 min ago");
    await expect(t(page, "tm-lanes-warn")).toHaveText("last seen 10 min ago");
    await expect(t(page, "tm-agent")).toHaveCount(1);
    await expect(t(page, "tm-agent")).toHaveAttribute("data-state", "unknown");
    await expect(t(page, "tm-lane")).toHaveCount(1);
    const warn = await box(t(page, "tm-agents-warn"));
    expect(warn.width).toBeGreaterThan(0);
    await clean(page, errors);
  });

  test("the other liveness chips: runner removed and never connected", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const m = fresh({ repos: [F.repo({ liveness: "runner_removed" }), F.repo({ repo_id: REPO_B, full_name: "acme-labs/site", liveness: "never", last_heard_at: null })] });
    const { errors } = await setup(page, m);
    await open(page);
    await expect(t(page, "tm-chip")).toHaveText("Engine connection: Runner removed");
    await t(page, "tm-repo").selectOption(REPO_B);
    await expect(t(page, "tm-chip")).toHaveText("Engine connection: Never connected");
    await expect.poll(() => m.reads.some((r) => r.includes(`/${REPO_B}/agents`))).toBe(true);
    await clean(page, errors);
  });

  test("L1: missing events put a banner with the time and the count on the app; it has no control to dismiss it and stays through a refresh", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const gap = { missing_events: 12, gaps: [{ from_seq: 5, to_seq: 16, before_ts: F.iso(1800) }] };
    const { errors } = await setup(page, fresh({ lanes: F.envelope([F.lane()], gap) }));
    await open(page);
    const banner = t(page, "tm-banner");
    await expect(banner).toHaveText(/^Events missing since \d\d:\d\d \(12 events\)$/);
    expect(await banner.locator("button, a, input").count()).toBe(0);
    expect(await page.locator(`${WIN} [data-testid="tm-banner"]`).count()).toBe(1);
    await expect(page.locator(`${WIN} .tm-banner`)).toHaveCSS("border-top-width", "2px");
    // Open and close the settings sheet: the banner is still there.
    await press(t(page, "tm-settings-btn"));
    await expect(banner).toBeVisible();
    await press(t(page, "tm-settings-btn"));
    await expect(banner).toBeVisible();
    await clean(page, errors);
  });

  test("L2: a source over its limit reads <source> not updated for N h; the merge queue only while a PR in the lane is not final", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const ages = { loop: 3 * 3600, team_log: 3 * 3600, plan: 30 * 3600, merge_queue: 7 * 3600 };
    const { errors } = await setup(page, fresh({ agents: F.envelope([F.agent()], { source_ages_s: ages }) }));
    await open(page);
    await expect(t(page, "tm-notice")).toHaveText(["loop not updated for 3 h", "team log not updated for 3 h", "plan not updated for 30 h", "merge queue not updated for 7 h"]);
    await clean(page, errors);
  });

  test("the merge queue limit is silent when every PR in the lane is final", async ({ page }) => {
    const F = makeFixtures(Date.now());
    await setup(page, fresh({ lanes: F.envelope([F.lane({ state: "merged" })], { source_ages_s: { merge_queue: 9 * 3600 } }), agents: F.envelope([F.agent()], { source_ages_s: { merge_queue: 9 * 3600 } }) }));
    await open(page);
    await expect(t(page, "tm-lane")).toHaveCount(1);
    await expect(t(page, "tm-notice")).toHaveCount(0);
  });

  test("an empty lane and no agents say so", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const { errors } = await setup(page, fresh({ agents: F.envelope([]), lanes: F.envelope([]), gates: F.envelope([]) }));
    await open(page);
    await expect(t(page, "tm-agents-empty")).toHaveText("No agents running");
    await expect(t(page, "tm-lanes-empty")).toHaveText("No pull requests in the merge lane");
    await expect(t(page, "tm-agents-asof")).toHaveText(/^as of /);
    await clean(page, errors);
  });

  test("a panel that cannot be read says so instead of showing an empty list, and the others still show", async ({ page }) => {
    const { errors } = await setup(page, fresh({ fail: ["/lanes"] }));
    await open(page);
    await expect(t(page, "tm-lanes-failed")).toHaveText("This panel couldn't be read.");
    await expect(t(page, "tm-lanes-empty")).toHaveCount(0);
    await expect(t(page, "tm-agent")).toHaveCount(2);
    await expect(t(page, "tm-refresh-failed")).toBeHidden(); // one panel failing does not flag the refresh of the whole view
    await clean(page, errors);
  });

  test("the plan route answering 404 (not there yet) fails the Plan panel only: its error shows, the view note does not", async ({ page }) => {
    const { errors } = await setup(page, fresh({ failPlan404: true }));
    await open(page);
    await expect(t(page, "tm-plan-failed")).toHaveText("This panel couldn't be read.");
    await expect(t(page, "tm-agent")).toHaveCount(2);
    await expect(t(page, "tm-stats-failed")).toHaveCount(0);
    await expect(t(page, "tm-refresh-failed")).toBeHidden();
    await clean(page, errors);
  });

  test("watch off: the app says so, an owner sees the switch, and turning it on sends one PUT and loads the panels", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const { mock, errors } = await setup(page, fresh({ settings: F.settings({ watch_enabled: false }) }));
    await open(page);
    await expect(t(page, "tm-off")).toHaveText("Engine watch is off");
    expect(mock.reads.some((r) => r.includes("/repos"))).toBe(false);
    const sw = t(page, "tm-watch-off");
    await expect(sw).not.toBeChecked();
    await press(sw);
    await expect(t(page, "tm-agent")).toHaveCount(2);
    expect(mock.puts).toEqual([{ path: `${BASE}/settings`, body: { watch_enabled: true } }]);
    await expect(t(page, "tm-heading")).toBeFocused();
    await clean(page, errors);
  });

  test("watch off, as a member: the sentence shows and there is no switch", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const { errors } = await setup(page, fresh({ settings: F.settings({ watch_enabled: false, can_edit: false }) }));
    await open(page);
    await expect(t(page, "tm-off")).toHaveText("Engine watch is off");
    await expect(t(page, "tm-watch-off")).toHaveCount(0);
    await clean(page, errors);
  });

  test("settings sheet: the switch and the repo boxes, a refused repo greyed with its reason, and a refusal from the server in plain words", async ({ page }) => {
    const { mock, errors } = await setup(page, fresh());
    await open(page);
    await expect(t(page, "tm-sheet")).toBeHidden();
    await press(t(page, "tm-settings-btn"));
    await expect(t(page, "tm-sheet")).toBeVisible();
    await expect(t(page, "tm-settings-btn")).toHaveAttribute("aria-expanded", "true");
    await expect(t(page, "tm-settings-btn")).toHaveAttribute("aria-controls", "tm-sheet");
    await expect(t(page, "tm-sheet")).toHaveAttribute("id", "tm-sheet");
    await expect(page.locator(`${WIN} section[aria-label], ${WIN} [role="region"]`)).toHaveCount(0); // the sheet is no second "Settings" landmark
    await expect(t(page, "tm-watch")).toBeChecked();
    await expect(t(page, "tm-repo-row")).toHaveCount(2);
    await expect(t(page, `tm-repo-${REPO_A}`)).toBeChecked();
    await expect(t(page, `tm-repo-${REPO_B}`)).toBeDisabled();
    await expect(t(page, "tm-refusal")).toHaveText("Public repository");
    await expect(t(page, `tm-repo-${REPO_B}`)).toHaveAttribute("aria-describedby", `tm-why-${REPO_B}`);
    await expect(t(page, "tm-refusal")).toHaveAttribute("id", `tm-why-${REPO_B}`);
    // Untick the repo that is on: one PUT with the new list, and the picker loses it.
    await press(t(page, `tm-repo-${REPO_A}`));
    await expect.poll(() => mock.puts.length).toBe(1);
    expect(mock.puts[0]).toEqual({ path: `${BASE}/settings`, body: { repo_ids: [] } });
    await expect(t(page, `tm-repo-${REPO_A}`)).not.toBeChecked();
    // A refusal is said in the app's words, not the server's.
    mock.putStatus = 409;
    mock.putCode = "public_repo";
    await press(t(page, `tm-repo-${REPO_A}`));
    await expect(t(page, "tm-live")).toHaveText("A public repository can't be watched.");
    await clean(page, errors);
  });

  test("settings sheet as a member: read-only, no delete button", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const { mock, errors } = await setup(page, fresh({ settings: F.settings({ can_edit: false }) }));
    await open(page);
    await press(t(page, "tm-settings-btn"));
    await expect(t(page, "tm-readonly")).toHaveText("Only an owner or admin can change these settings.");
    await expect(t(page, "tm-watch")).toBeDisabled();
    await expect(t(page, `tm-repo-${REPO_A}`)).toBeDisabled();
    await expect(t(page, "tm-delete")).toHaveCount(0);
    // aria-disabled, not disabled: Tab reaches each control, which names the sentence that explains it, and Space changes nothing.
    for (const id of ["tm-watch", `tm-repo-${REPO_A}`]) {
      const box1 = t(page, id);
      await expect(box1).toHaveAttribute("aria-disabled", "true");
      await expect(box1).toHaveAttribute("aria-describedby", "tm-ro");
      await expect(box1).not.toHaveAttribute("disabled", /.*/);
      await box1.focus();
      expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe(id);
      await page.keyboard.press("Space");
      await expect(box1).toBeChecked();
    }
    await expect(page.locator(`${WIN} #tm-ro`)).toHaveText("Only an owner or admin can change these settings.");
    await page.keyboard.press("Tab"); // the next stop is reached with the keyboard, so nothing in the list traps focus
    expect(mock.puts).toEqual([]);
    await clean(page, errors);
  });

  test("deleting engine data asks first; Cancel sends nothing and Yes sends one PUT to the delete route", async ({ page }) => {
    const { mock, errors } = await setup(page, fresh());
    await open(page);
    await press(t(page, "tm-settings-btn"));
    await press(t(page, "tm-delete"));
    await expect(t(page, "tm-confirm")).toContainText("This cannot be undone.");
    await press(t(page, "tm-delete-cancel"));
    await expect(t(page, "tm-confirm")).toHaveCount(0);
    expect(mock.puts).toEqual([]);
    await press(t(page, "tm-delete"));
    await press(t(page, "tm-delete-yes"));
    await expect(t(page, "tm-live")).toHaveText("Engine data deleted.");
    expect(mock.puts).toEqual([{ path: `${BASE}/settings/delete-data`, body: null }]);
    await clean(page, errors);
  });

  test("names are only ever text: a hostile repo, runner and agent role create no element, link or script", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const name = "acme-labs/<b>x</b>";
    const m = fresh({
      repos: [F.repo({ full_name: name, runner_name: HOSTILE })], settings: F.settings({ repos: [F.settingsRepo({ full_name: name })] }),
      agents: F.envelope([F.agent({ role: HOSTILE })]), lanes: F.envelope([F.lane()]),
    });
    const { errors } = await setup(page, m);
    await open(page);
    await expect(t(page, "tm-runner")).toContainText(HOSTILE);
    await expect(t(page, "tm-agent")).toContainText(HOSTILE);
    await expect(page.locator(`${WIN} .tm-app img, ${WIN} .tm-app script, ${WIN} .tm-app iframe, ${WIN} .tm-app b, ${WIN} .tm-app svg`)).toHaveCount(0);
    await expect(t(page, "tm-runner").locator("bdi")).toHaveCount(1);
    await expect(t(page, "tm-agent").locator(".tm-role bdi")).toHaveCount(1);
    // The repo's name is not a usable link target, so the D# stays plain text.
    await expect(t(page, "tm-agent").locator("a")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    expect(errors).toEqual([]);
  });

  test("a refresh does not close an open repo list or take focus from a box", async ({ page }) => {
    const { mock } = await setup(page, fresh({ streaming: true }));
    await open(page);
    await press(t(page, "tm-settings-btn"));
    const box1 = t(page, `tm-repo-${REPO_A}`);
    await box1.focus();
    const before = mock.reads.length;
    mock.streamFrame = `id: c-1\nevent: engine.changed\ndata: ${JSON.stringify({ id: "e1", type: "engine.changed", created_at: new Date().toISOString(), data: { repo_id: REPO_A, session_id: "s", last_seq: 9 } })}\n\n`;
    await expect.poll(async () => { if (mock.streamFrame !== null) await page.evaluate(() => window.dispatchEvent(new Event("pointerdown"))); return mock.streamFrame; }, { timeout: 30_000 }).toBeNull();
    await expect.poll(() => mock.reads.length, { timeout: 10_000 }).toBeGreaterThan(before);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe(`tm-repo-${REPO_A}`);
  });

  test("engine.changed refetches every panel for the repo, within 5 s, without a reload", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const { mock } = await setup(page, fresh({ streaming: true, agents: F.envelope([F.agent()]) }));
    await open(page);
    await expect(t(page, "tm-agent")).toHaveCount(1);
    mock.reads.length = 0;
    mock.agents = F.envelope([F.agent(), F.agent({ agent_id: "b2c3d4e5f6071829", role: "code-reviewer" })]);
    mock.lanes = F.envelope([F.lane({ pr: 11, state: "queued" })]);
    mock.streamFrame = `id: c-2\nevent: engine.changed\ndata: ${JSON.stringify({ id: "e2", type: "engine.changed", created_at: new Date().toISOString(), data: { repo_id: REPO_A, session_id: "s", last_seq: 10 } })}\n\n`;
    await expect.poll(async () => { if (mock.streamFrame !== null) await page.evaluate(() => window.dispatchEvent(new Event("pointerdown"))); return mock.streamFrame; }, { timeout: 30_000 }).toBeNull();
    await expect(t(page, "tm-agent")).toHaveCount(2, { timeout: 5000 });
    await expect(t(page, "tm-pr")).toHaveText("PR #11", { timeout: 5000 });
    for (const kind of ["agents?state=running", "lanes", "gates", "log?limit=100", "plan", "stats", "usage"]) expect(mock.reads.filter((r) => r === `${BASE}/repos/${REPO_A}/${kind}`).length).toBeGreaterThanOrEqual(1);
  });

  test("without a live stream the panels are read again every 15 s", async ({ page }) => {
    const { mock } = await setup(page, fresh(), { clock: true });
    await open(page);
    await expect(t(page, "tm-agent")).toHaveCount(2);
    mock.reads.length = 0;
    await page.clock.runFor(15_500);
    await expect.poll(() => mock.reads.filter((r) => r.endsWith("/lanes")).length).toBeGreaterThanOrEqual(1);
  });

  test("a refresh that lands while a save is out does not put the ticked box back; the box and the saved value agree after a reload", async ({ page }) => {
    const { mock, errors } = await setup(page, fresh({ streaming: true }));
    await open(page);
    await press(t(page, "tm-settings-btn"));
    const repoBox = t(page, `tm-repo-${REPO_A}`);
    await expect(repoBox).toBeChecked();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    await page.route((u) => u.pathname === `${BASE}/settings`, async (route) => { if (route.request().method() === "PUT") await held; await route.fallback(); });
    await press(repoBox); // untick: the save is held
    await expect(repoBox).not.toBeChecked();
    const settingsReads = () => mock.reads.filter((r) => r === `${BASE}/settings`).length;
    const before = settingsReads();
    mock.streamFrame = `id: c-2\nevent: engine.changed\ndata: ${JSON.stringify({ id: "e2", type: "engine.changed", created_at: new Date().toISOString(), data: { repo_id: REPO_A, session_id: "s", last_seq: 11 } })}\n\n`;
    await expect.poll(async () => { if (mock.streamFrame !== null) await page.evaluate(() => window.dispatchEvent(new Event("pointerdown"))); return mock.streamFrame; }, { timeout: 30_000 }).toBeNull();
    await expect.poll(settingsReads, { timeout: 10_000 }).toBeGreaterThan(before); // the refresh read the old, ticked value while the save was out
    await expect(t(page, `tm-repo-${REPO_A}`)).not.toBeChecked();
    release();
    await expect.poll(() => mock.puts.length).toBe(1);
    await expect(t(page, `tm-repo-${REPO_A}`)).not.toBeChecked();
    await page.reload();
    await waitForDesktop(page);
    await open(page);
    await press(t(page, "tm-settings-btn"));
    await expect(t(page, `tm-repo-${REPO_A}`)).not.toBeChecked();
    await clean(page, errors);
  });

  test("a refresh that finds nothing new keeps the same boxes: not rebuilt, focus and identity stay", async ({ page }) => {
    const { mock } = await setup(page, fresh({ streaming: true }));
    await open(page);
    await press(t(page, "tm-settings-btn"));
    await t(page, `tm-repo-${REPO_A}`).focus();
    await page.evaluate((id) => { (document.querySelector(`[data-testid="tm-repo-${id}"]`) as HTMLElement & { mark?: number }).mark = 7; }, REPO_A);
    const before = mock.reads.length;
    mock.streamFrame = `id: c-3\nevent: engine.changed\ndata: ${JSON.stringify({ id: "e3", type: "engine.changed", created_at: new Date().toISOString(), data: { repo_id: REPO_A, session_id: "s", last_seq: 12 } })}\n\n`;
    await expect.poll(async () => { if (mock.streamFrame !== null) await page.evaluate(() => window.dispatchEvent(new Event("pointerdown"))); return mock.streamFrame; }, { timeout: 30_000 }).toBeNull();
    await expect.poll(() => mock.reads.length, { timeout: 10_000 }).toBeGreaterThan(before);
    await expect.poll(() => mock.reads.filter((r) => r === `${BASE}/settings`).length).toBeGreaterThan(1);
    expect(await page.evaluate((id) => (document.querySelector(`[data-testid="tm-repo-${id}"]`) as (HTMLElement & { mark?: number }) | null)?.mark, REPO_A)).toBe(7);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe(`tm-repo-${REPO_A}`);
  });

  test("toggling a box keeps keyboard focus on it while the save is out and after it, and the box stays in the Tab order", async ({ page }) => {
    const { mock, errors } = await setup(page, fresh());
    await open(page);
    await press(t(page, "tm-settings-btn"));
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    await page.route((u) => u.pathname === `${BASE}/settings`, async (route) => { if (route.request().method() === "PUT") await held; await route.fallback(); });
    const active = () => page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
    const box1 = t(page, "tm-watch");
    await box1.focus();
    await page.keyboard.press("Space");
    await expect(box1).toHaveAttribute("aria-disabled", "true"); // saving
    await expect(box1).not.toHaveAttribute("disabled", /.*/);
    expect(await active()).toBe("tm-watch");
    await page.keyboard.press("Space"); // a press while the save is out changes nothing
    release();
    await expect(box1).not.toHaveAttribute("aria-disabled", "true");
    expect(mock.puts[0].body).toEqual({ watch_enabled: false });
    expect(await active()).toBe("tm-watch");
    await expect(t(page, "tm-live")).toHaveText("Saved.");
    // A repo box, the same way (the held PUT is already released, so the answer comes at once).
    await expect(box1).not.toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Space");
    await expect.poll(() => mock.puts.length).toBe(2);
    await expect(box1).not.toHaveAttribute("aria-disabled", "true");
    const repoBox = t(page, `tm-repo-${REPO_A}`);
    await repoBox.focus();
    await expect(repoBox).not.toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Space");
    await expect.poll(() => mock.puts.length).toBe(3);
    await expect(repoBox).not.toHaveAttribute("aria-disabled", "true");
    expect(mock.puts[2].body).toEqual({ repo_ids: [] });
    expect(await active()).toBe(`tm-repo-${REPO_A}`);
    await clean(page, errors);
  });

  test("the delete confirm takes focus, Cancel and Escape give it back to Delete, and Yes lands on Delete with the result spoken", async ({ page }) => {
    const { mock, errors } = await setup(page, fresh());
    await open(page);
    await press(t(page, "tm-settings-btn"));
    const active = () => page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
    const confirm = t(page, "tm-confirm");
    // Opening: focus moves into the group (on Cancel, the safe answer), which is named by its own heading.
    await press(t(page, "tm-delete"));
    await expect(confirm).toBeVisible();
    expect(await active()).toBe("tm-delete-cancel");
    await expect(confirm).toHaveAttribute("role", "group");
    const labelledBy = (await confirm.getAttribute("aria-labelledby")) ?? "";
    await expect(page.locator(`${WIN} #${labelledBy}`)).toHaveText("Delete engine data");
    await page.keyboard.press("Shift+Tab");
    expect(await active()).toBe("tm-delete-yes");
    // Cancel.
    await press(t(page, "tm-delete-cancel"));
    await expect(confirm).toHaveCount(0);
    expect(await active()).toBe("tm-delete");
    // Escape, from the confirm.
    await press(t(page, "tm-delete"));
    expect(await active()).toBe("tm-delete-cancel");
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    expect(await active()).toBe("tm-delete");
    await expect(t(page, "tm-sheet")).toBeVisible(); // Escape closed the confirm and nothing else
    expect(mock.puts).toEqual([]);
    // Yes: one PUT, the outcome spoken, and focus on Delete rather than on a vanished button.
    await press(t(page, "tm-delete"));
    await press(t(page, "tm-delete-yes"));
    await expect(t(page, "tm-live")).toHaveText("Engine data deleted.");
    await expect(confirm).toHaveCount(0);
    expect(await active()).toBe("tm-delete");
    expect(mock.puts).toEqual([{ path: `${BASE}/settings/delete-data`, body: null }]);
    await clean(page, errors);
  });

  test("a 403 on the delete route says only the account owner can delete engine data", async ({ page }) => {
    const { mock, errors } = await setup(page, fresh());
    await open(page);
    await press(t(page, "tm-settings-btn"));
    mock.putStatus = 403;
    mock.putCode = "forbidden";
    await press(t(page, "tm-delete"));
    await press(t(page, "tm-delete-yes"));
    await expect(t(page, "tm-live")).toHaveText("Only the account owner can delete engine data.");
    await clean(page, errors);
  });

  test("the banner and the refresh note are announced when they change and not on every poll", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const gap = (n: number) => ({ missing_events: n, gaps: [{ from_seq: 1, to_seq: n, before_ts: F.iso(900) }] });
    const ALL = ["/agents", "/lanes", "/gates", "/log", "/plan", "/stats", "/usage"]; // the note is for the whole view failing, so every panel read fails together
    const mock = fresh({ agents: F.envelope([F.agent()], gap(3)), fail: ["/lanes"] });
    const { errors } = await setup(page, mock, { clock: true });
    await open(page);
    const live = t(page, "tm-live");
    await expect(live).toContainText("Events missing since");
    await expect(live).toContainText("(3 events)");
    await expect(live).toContainText("Merge lane panel couldn't be read.");
    await expect(live).not.toContainText("Couldn't refresh");
    await expect(t(page, "tm-refresh-failed")).toBeHidden();
    await page.evaluate((sel) => {
      const w = window as unknown as { __said: number };
      w.__said = 0;
      new MutationObserver(() => { w.__said += 1; }).observe(document.querySelector(sel) as Element, { childList: true, characterData: true, subtree: true });
    }, `${WIN} [data-testid="tm-live"]`);
    const count = () => page.evaluate(() => (window as unknown as { __said: number }).__said);
    const poll = async () => {
      const before = mock.reads.filter((r) => r.endsWith("/gates")).length;
      await page.clock.runFor(15_500);
      await expect.poll(() => mock.reads.filter((r) => r.endsWith("/gates")).length).toBeGreaterThan(before);
      await page.waitForTimeout(300);
    };
    // Polls that find the same banner and the same failure say nothing.
    await poll();
    await poll();
    expect(await count()).toBe(0);
    // A banner that changes is said; a note that clears is not, and is said again when it comes back.
    mock.agents = F.envelope([F.agent()], gap(5));
    await poll();
    await expect(live).toContainText("(5 events)");
    const afterBanner = await count();
    expect(afterBanner).toBeGreaterThan(0);
    mock.fail = [];
    await poll();
    expect(await count()).toBe(afterBanner);
    mock.fail = ALL;
    await poll();
    await expect(live).toHaveText("Couldn't refresh. Showing the last data received.");
    expect(await count()).toBeGreaterThan(afterBanner);
    await clean(page, errors);
  });

  test("the same notice twice is announced twice", async ({ page }) => {
    const { mock } = await setup(page, fresh());
    await open(page);
    await press(t(page, "tm-settings-btn"));
    await page.evaluate((sel) => {
      const w = window as unknown as { __said: number };
      w.__said = 0;
      new MutationObserver(() => { w.__said += 1; }).observe(document.querySelector(sel) as Element, { childList: true, characterData: true, subtree: true });
    }, `${WIN} [data-testid="tm-live"]`);
    const said = () => page.evaluate(() => (window as unknown as { __said: number }).__said);
    mock.putStatus = 409;
    mock.putCode = "public_repo";
    await press(t(page, `tm-repo-${REPO_A}`));
    await expect(t(page, "tm-live")).toHaveText("A public repository can't be watched.");
    const first = await said();
    expect(first).toBeGreaterThan(0);
    await press(t(page, `tm-repo-${REPO_A}`));
    await expect.poll(said).toBeGreaterThan(first);
    await expect(t(page, "tm-live")).toHaveText("A public repository can't be watched.");
  });

  // ── Operate ───────────────────────────────────────────────────────────────────────────────────────────────────────
  // A locked control is aria-disabled, so Playwright's own click would wait for it forever; a locked press is sent as a bare click event.
  const operateOn = (over: Partial<Mock> = {}) => {
    const F = makeFixtures(Date.now());
    return fresh({ settings: F.settings({ operate_enabled: true }), repos: [F.repo({ operate_enabled: true }), F.repo({ repo_id: REPO_B, full_name: "acme-labs/site", operate_enabled: true })], ...over });
  };
  const activeId = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.getAttribute("data-focus"));
  const CMDS = `${BASE}/repos/${REPO_A}/commands`;
  const SENT = "Sent. Waiting for the runner to pick it up.";
  const watchSaid = (page: Page) => page.evaluate((sel) => {
    const w = window as unknown as { __said: number };
    w.__said = 0;
    new MutationObserver(() => { w.__said += 1; }).observe(document.querySelector(sel) as Element, { childList: true, characterData: true, subtree: true });
  }, `${WIN} [data-testid="tm-live"]`);
  const said = (page: Page) => page.evaluate(() => (window as unknown as { __said: number }).__said);

  test("operate off: the panel says so, every control is aria-disabled with the reason, none is disabled, and a press sends nothing; the switch turns it on", async ({ page }) => {
    const { mock, errors } = await setup(page, fresh());
    await open(page);
    await expect(t(page, "tm-operate")).toBeVisible();
    await expect(t(page, "tm-op-why")).toHaveText("Operate is off.");
    const gate = page.locator(`${WIN} [data-gate]`);
    expect(await gate.count()).toBeGreaterThanOrEqual(14); // 3 buttons, the request form (3), the dial form (4), the 3 dial selects and their 3 Apply buttons, and 2 Stop buttons
    for (let i = 0; i < (await gate.count()); i++) {
      await expect(gate.nth(i)).toHaveAttribute("aria-disabled", "true");
      await expect(gate.nth(i)).toHaveAttribute("aria-describedby", "tm-op-why");
      await expect(gate.nth(i)).not.toHaveAttribute("disabled", /.*/);
    }
    await expect(page.locator(`${WIN} .tm-app ul:not([role="list"])`)).toHaveCount(0);
    await t(page, "tm-op-pause").focus();
    expect(await activeId(page)).toBe("tm-op-pause"); // still in the Tab order
    await t(page, "tm-op-pause").dispatchEvent("click");
    await t(page, "tm-op-request").dispatchEvent("click");
    await page.keyboard.press("Space");
    expect(mock.posts).toEqual([]);
    // The switch is how it gets turned on, so it is the one control that is not locked by this.
    const sw = t(page, "tm-op-switch");
    await expect(sw).not.toBeChecked();
    await expect(sw).not.toHaveAttribute("aria-disabled", "true");
    await sw.focus();
    await page.keyboard.press("Space");
    await expect(t(page, "tm-op-why")).toHaveCount(0);
    await expect(t(page, "tm-op-pause")).not.toHaveAttribute("aria-disabled", "true");
    expect(await activeId(page)).toBe("tm-op-switch");
    expect(mock.puts).toEqual([{ path: `${BASE}/settings`, body: { operate_enabled: true } }]);
    await clean(page, errors);
  });

  test("a member sees no operate controls and no command or dial is read; watch off and a halt lock everything with their reason", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const member = await setup(page, fresh({ settings: F.settings({ can_edit: false, operate_enabled: true }) }));
    await open(page);
    await expect(t(page, "tm-operate")).toBeHidden();
    await expect(t(page, "tm-stop")).toHaveCount(0);
    expect(member.mock.reads.some((r) => r.includes("/commands") || r.includes("decision-settings"))).toBe(false);
    await clean(page, member.errors);
  });

  test("watch off: the panel stays, locked, with the reason and a switch that says to turn watch on first", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const { errors } = await setup(page, fresh({ settings: F.settings({ watch_enabled: false, operate_enabled: true }) }));
    await open(page);
    await expect(t(page, "tm-op-why")).toHaveText("Engine watch is off.");
    await expect(t(page, "tm-op-switch")).toHaveAttribute("aria-disabled", "true");
    await expect(t(page, "tm-op-switch")).toHaveAttribute("aria-describedby", "tm-op-sw-why");
    await expect(t(page, "tm-op-sw-why")).toHaveText("Turn on engine watch first.");
    await expect(t(page, "tm-op-start")).toHaveAttribute("aria-disabled", "true");
    await expect(t(page, "tm-op-cmds")).toHaveText("");
    await clean(page, errors);
  });

  test("a halted repo locks every control with the halt as the reason; a runner that was removed hides them; an offline machine says commands expire", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const halted = await setup(page, operateOn({ repos: [F.repo({ operate_enabled: true, halted: true })] }));
    await open(page);
    await expect(t(page, "tm-op-why")).toHaveText("The engine is halted.");
    await expect(t(page, "tm-op-pause")).toHaveAttribute("aria-disabled", "true");
    await expect(t(page, "tm-stop").first()).toHaveAttribute("aria-disabled", "true");
    await clean(page, halted.errors);
  });

  test("a removed runner hides the controls; an offline machine says commands will expire in 10 min", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const m = operateOn({ repos: [F.repo({ operate_enabled: true, liveness: "runner_removed" }), F.repo({ repo_id: REPO_B, full_name: "acme-labs/site", operate_enabled: true, liveness: "stale", last_heard_at: F.iso(600) })] });
    const { errors } = await setup(page, m);
    await open(page);
    await expect(t(page, "tm-op-removed")).toHaveText("The runner for this repository was removed, so commands can't be sent.");
    await expect(t(page, "tm-op-ctl")).toBeHidden();
    await t(page, "tm-repo").selectOption(REPO_B);
    await expect(t(page, "tm-op-offline")).toHaveText("Machine offline; commands will expire in 10 min.");
    await expect(t(page, "tm-op-ctl")).toBeVisible();
    await clean(page, errors);
  });

  test("Start day, Pause loop and Resume loop each send one command, say so once, keep focus on the button, and show the command pending", async ({ page }) => {
    const { mock, errors } = await setup(page, operateOn());
    await open(page);
    const live = t(page, "tm-live");
    for (const [id, kind] of [["tm-op-start", "start_day"], ["tm-op-pause", "pause_loop"], ["tm-op-resume", "resume_loop"]] as const) {
      await press(t(page, id));
      await expect(live).toHaveText(SENT);
      await expect(t(page, id)).not.toHaveAttribute("aria-disabled", "true");
      expect(await activeId(page)).toBe(id);
      expect(mock.posts.at(-1)).toEqual({ path: CMDS, body: { kind, args: {} } });
    }
    expect(mock.posts).toHaveLength(3);
    await expect(t(page, "tm-cmd")).toHaveCount(3);
    await expect(t(page, "tm-cmd").first().locator('[data-testid="tm-cmd-state"]')).toHaveText("Pending");
    await expect(t(page, "tm-cmd").first()).toContainText("Resume the loop");
    await expect(t(page, "tm-cmds-asof")).toHaveText(/^as of \d\d:\d\d \(\d+ min ago\)$/);
    await expect(page.locator(`${WIN} .tm-app ul:not([role="list"])`)).toHaveCount(0);
    await clean(page, errors);
  });

  test("Request agent sends the role and the Discussion; a bad number sends nothing and says why; what was typed survives the refresh", async ({ page }) => {
    const { mock, errors } = await setup(page, operateOn());
    await open(page);
    await t(page, "tm-op-role").selectOption("code-reviewer");
    await t(page, "tm-op-discussion").fill("0");
    await press(t(page, "tm-op-request"));
    await expect(t(page, "tm-live")).toHaveText("Choose a role and enter a Discussion number of 1 or more.");
    expect(mock.posts).toEqual([]);
    await t(page, "tm-op-discussion").fill("42");
    await press(t(page, "tm-op-request"));
    await expect(t(page, "tm-live")).toHaveText(SENT);
    expect(mock.posts).toEqual([{ path: CMDS, body: { kind: "request_spawn", args: { role: "code-reviewer", discussion: 42 } } }]);
    await expect(t(page, "tm-cmd").first()).toContainText("Request a code reviewer for D#42");
    await expect(t(page, "tm-op-discussion")).toHaveValue("42"); // the form is built once: the refresh after the send did not clear it
    await expect(t(page, "tm-op-role")).toHaveValue("code-reviewer");
    expect(await activeId(page)).toBe("tm-op-request");
    await clean(page, errors);
  });

  test("Set a dial sends the class, the level and how long it lasts", async ({ page }) => {
    const { mock, errors } = await setup(page, operateOn());
    await open(page);
    await expect(t(page, "tm-op-class").locator("option")).toHaveCount(8);
    await t(page, "tm-op-class").selectOption("merge.standard");
    await t(page, "tm-op-level").selectOption("2");
    await t(page, "tm-op-ttl").selectOption("for_today");
    await press(t(page, "tm-op-setdial"));
    await expect(t(page, "tm-live")).toHaveText(SENT);
    expect(mock.posts).toEqual([{ path: CMDS, body: { kind: "set_dial", args: { dial_class: "merge.standard", level: 2, ttl: "for_today" } } }]);
    await expect(t(page, "tm-cmd").first()).toContainText("Set standard merges to level 2 (for today)");
    await clean(page, errors);
  });

  test("Stop asks first: focus goes to Cancel, Escape and Cancel give it back to the Stop button, and Yes sends one stop and leaves the button saying it is on its way", async ({ page }) => {
    const { mock, errors } = await setup(page, operateOn());
    await open(page);
    await expect(t(page, "tm-stop")).toHaveCount(2);
    const first = t(page, "tm-stop").first();
    await expect(first).toHaveAttribute("aria-label", "Stop the executor agent on D#42 (id a1b2c3)");
    await expect(t(page, "tm-stop").nth(1)).toHaveAttribute("aria-label", "Stop the code reviewer agent on D#43 (id b2c3d4)"); // words, never the wire role
    const confirm = t(page, "tm-stop-confirm");
    await press(first);
    await expect(confirm).toBeVisible();
    await expect(t(page, "tm-stop-who")).toHaveText("Stop the executor agent on D#42 (id a1b2c3).");
    expect(await activeId(page)).toBe("tm-stop-cancel");
    await expect(confirm).toHaveAttribute("role", "group");
    const labelledBy = (await confirm.getAttribute("aria-labelledby")) ?? "";
    await expect(page.locator(`${WIN} #${labelledBy}`)).toHaveText("Stop this agent?");
    await page.keyboard.press("Shift+Tab");
    expect(await activeId(page)).toBe("tm-stop-yes");
    await press(t(page, "tm-stop-cancel"));
    await expect(confirm).toHaveCount(0);
    expect(await activeId(page)).toBe("tm-stop");
    await press(first);
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    expect(await activeId(page)).toBe("tm-stop");
    expect(mock.posts).toEqual([]);
    await press(first);
    await press(t(page, "tm-stop-yes"));
    await expect(t(page, "tm-live")).toHaveText(SENT);
    await expect(confirm).toHaveCount(0);
    expect(mock.posts).toEqual([{ path: CMDS, body: { kind: "stop_agent", args: { agent_id: "a1b2c3d4e5f60718" } } }]);
    await expect(t(page, "tm-stop").first()).toHaveText("Stop requested");
    await expect(t(page, "tm-stop").first()).toHaveAttribute("aria-disabled", "true");
    expect(await activeId(page)).toBe("tm-stop");
    await expect(t(page, "tm-cmd").first()).toContainText("Stop the executor agent");
    await clean(page, errors);
  });

  test("Stop closes with its agent: when the agent goes away the question closes and focus lands on the agents heading", async ({ page }) => {
    const mockData = operateOn();
    const { errors } = await setup(page, mockData, { clock: true });
    await open(page);
    await press(t(page, "tm-stop").first());
    await expect(t(page, "tm-stop-confirm")).toBeVisible();
    expect(await activeId(page)).toBe("tm-stop-cancel");
    mockData.agents = { ...mockData.agents, items: mockData.agents.items.slice(1) };
    await page.clock.runFor(61_000);
    await expect(t(page, "tm-stop-confirm")).toHaveCount(0);
    expect(await activeId(page)).toBe("agents-head");
    await expect(t(page, "tm-stop")).toHaveCount(1);
    await clean(page, errors);
  });

  test("a command's outcome is said once, when its state changes; what was already there is not announced", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const id = "c0000000-0000-4000-8000-000000000001";
    const mockData = operateOn({ commands: { commands: [F.command({ id, state: "applied", acked_at: F.iso(20), kind: "start_day" }), F.command({ id: "c0000000-0000-4000-8000-000000000002", state: "pending" })] } });
    const { errors } = await setup(page, mockData, { clock: true });
    await open(page);
    await expect(t(page, "tm-live")).toHaveText("");
    await watchSaid(page);
    mockData.commands = { commands: [mockData.commands.commands[0], { ...mockData.commands.commands[1], state: "applied", acked_at: new Date().toISOString() }] };
    await page.clock.runFor(61_000);
    await expect(t(page, "tm-live")).toHaveText("Pause the loop: Applied. The engine did it.");
    const once = await said(page);
    await page.clock.runFor(61_000);
    await page.clock.runFor(61_000);
    expect(await said(page)).toBe(once); // nothing changed, nothing said again
    await expect(t(page, "tm-live")).toHaveText("Pause the loop: Applied. The engine did it.");
    await clean(page, errors);
  });

  test("Cancel stays usable while operate is off or the repo is halted, though every other control is locked", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const id = "c0000000-0000-4000-8000-000000000001";
    const { mock, errors } = await setup(page, operateOn({ repos: [F.repo({ operate_enabled: true, halted: true })], commands: { commands: [F.command({ id })] } }));
    await open(page);
    await expect(t(page, "tm-op-why")).toHaveText("The engine is halted.");
    await expect(t(page, "tm-op-pause")).toHaveAttribute("aria-disabled", "true");
    await expect(t(page, "tm-cmd-cancel")).toHaveAttribute("aria-disabled", "false");
    await expect(t(page, "tm-cmd-cancel")).not.toHaveAttribute("aria-describedby", /.*/);
    await press(t(page, "tm-cmd-cancel"));
    await expect(t(page, "tm-live")).toHaveText("Command cancelled.");
    expect(mock.deletes).toEqual([id]);
    await clean(page, errors);
  });

  test("every 409 and the 403 on a send is a plain sentence, never the server's text; the same sentence twice is said twice", async ({ page }) => {
    const { mock, errors } = await setup(page, operateOn());
    await open(page);
    const cases: [number, string, string][] = [
      [409, "too_many_pending", "Too many commands are waiting (20 is the most). Wait for some to finish, or cancel one."],
      [409, "operate_off", "Operate is off for this repository. Turn it on first."],
      [409, "engine_not_connected", "No engine is connected for this repository. Start the engine on your machine first."],
      [409, "halted", "The engine is halted, so this command isn't allowed."],
      [403, "forbidden", "Only an owner or admin can send commands."],
      [500, "server_error", "That didn't send. Try again."],
    ];
    for (const [status, code, sentence] of cases) {
      mock.postStatus = status;
      mock.postCode = code;
      await press(t(page, "tm-op-pause"));
      await expect(t(page, "tm-live")).toHaveText(sentence);
      await expect(t(page, "tm-op-pause")).not.toHaveAttribute("aria-disabled", "true");
      expect(await activeId(page)).toBe("tm-op-pause");
    }
    await expect(t(page, "tm-cmd")).toHaveCount(0); // nothing was queued by a refusal
    await watchSaid(page);
    mock.postStatus = 409;
    mock.postCode = "too_many_pending";
    await press(t(page, "tm-op-pause"));
    await expect.poll(() => said(page)).toBeGreaterThan(0);
    const first = await said(page);
    await press(t(page, "tm-op-pause"));
    await expect.poll(() => said(page)).toBeGreaterThan(first);
    await clean(page, errors);
  });

  test("a command's state is a word, with the refusal in plain words; Applied needs the runner's report; only a pending command has Cancel", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const id = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const commands = [
      F.command({ id: id(1), state: "pending" }),
      F.command({ id: id(2), state: "delivered", delivered_at: F.iso(30), expires_at: new Date(Date.now() + 500000).toISOString() }),
      F.command({ id: id(3), state: "applied", acked_at: F.iso(20) }),
      F.command({ id: id(4), state: "applied", acked_at: null }),
      F.command({ id: id(5), state: "refused", refusal: "host_not_running", acked_at: F.iso(20) }),
      F.command({ id: id(6), state: "expired", expires_at: F.iso(5) }),
      F.command({ id: id(7), state: "not_confirmed", delivered_at: F.iso(900) }),
      F.command({ id: id(8), state: "cancelled" }),
      F.command({ id: id(9), state: "pending", expires_at: F.iso(1) }),
    ];
    const { errors } = await setup(page, operateOn({ commands: { commands } }));
    await open(page);
    await expect(t(page, "tm-cmd-state")).toHaveText(["Pending", "Delivered", "Applied", "Delivered", "Refused", "Expired", "Not confirmed", "Cancelled", "Expired"]);
    await expect(t(page, "tm-cmd").nth(4).locator('[data-testid="tm-cmd-detail"]')).toHaveText("The engine host is not running on that machine.");
    await expect(t(page, "tm-cmd-cancel")).toHaveCount(1);
    await expect(t(page, "tm-cmd-cancel")).toHaveAttribute("aria-label", "Cancel: Pause the loop");
    await clean(page, errors);
  });

  test("Cancel on a pending command sends one DELETE, shows Cancelled, and puts focus on the list heading; a refusal says why", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const id = "c0000000-0000-4000-8000-000000000001";
    const { mock, errors } = await setup(page, operateOn({ commands: { commands: [F.command({ id }), F.command({ id: "c0000000-0000-4000-8000-000000000002", kind: "start_day" })] } }));
    await open(page);
    await expect(t(page, "tm-cmd-cancel")).toHaveCount(2);
    mock.postStatus = 409;
    mock.postCode = "already_delivered";
    const listReads = () => mock.reads.filter((r) => r.includes("/commands")).length;
    const before409 = listReads();
    await press(t(page, "tm-cmd-cancel").first());
    await expect.poll(listReads).toBeGreaterThan(before409); // a 409 means the list was stale: it is read again
    await expect(t(page, "tm-live")).toHaveText("The runner already has this command, so it can't be cancelled.");
    mock.postStatus = 201;
    await press(t(page, "tm-cmd-cancel").first());
    await expect(t(page, "tm-live")).toHaveText("Command cancelled.");
    expect(mock.deletes).toEqual([id, id]);
    await expect(t(page, "tm-cmd-state").first()).toHaveText("Cancelled");
    await expect(t(page, "tm-cmd-cancel")).toHaveCount(1);
    expect(await activeId(page)).toBe("cmds-head");
    await clean(page, errors);
  });

  test("the three engine dials: Apply posts one, focus stays on Apply, a refusal is a sentence, and an unapplied choice survives the clock ticking over", async ({ page }) => {
    const { mock, errors } = await setup(page, operateOn(), { clock: true });
    await open(page);
    await expect(t(page, "tm-dial")).toHaveCount(3);
    await expect(t(page, "tm-dial").nth(1)).toContainText("Server label for engine_merge");
    await expect(t(page, "tm-dial-select").nth(2).locator("option")).toHaveText(["Go ahead", "Ask me first"]);
    await expect(t(page, "tm-dials-asof")).toHaveText(/^as of \d\d:\d\d \(\d+ min ago\)$/);
    // A choice not yet applied is kept while the panels are read again, even across a minute.
    await t(page, "tm-dial-select").first().selectOption("act");
    const before = mock.reads.filter((r) => r.endsWith("/lanes")).length;
    await page.clock.runFor(61_000);
    await expect.poll(() => mock.reads.filter((r) => r.endsWith("/lanes")).length).toBeGreaterThan(before);
    await expect(t(page, "tm-dial-select").first()).toHaveValue("act");
    // Apply the middle one.
    await t(page, "tm-dial-select").nth(1).selectOption("act");
    await press(t(page, "tm-dial-apply").nth(1));
    await expect(t(page, "tm-live")).toHaveText("Dial saved.");
    expect(mock.posts).toEqual([{ path: `/api/v1/repos/${REPO_A}/decision-settings/dial`, body: { decision_type: "engine_merge", disposition: "act" } }]);
    await expect(t(page, "tm-dial-select").nth(1)).toHaveValue("act");
    expect(await activeId(page)).toBe("tm-dial-apply");
    // A refusal.
    mock.dialStatus = 422;
    mock.dialCode = "validation_failed";
    await press(t(page, "tm-dial-apply").nth(2));
    await expect(t(page, "tm-live")).toHaveText("That setting isn't allowed for this dial.");
    await clean(page, errors);
  });

  test("while a command is out every control is aria-disabled, focus stays on the button, and a second press sends nothing; afterwards it comes back and the result is said", async ({ page }) => {
    const { mock, errors } = await setup(page, operateOn());
    await open(page);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    await page.route((u) => u.pathname.endsWith("/commands"), async (route) => { if (route.request().method() === "POST") await held; await route.fallback(); });
    const pause = t(page, "tm-op-pause");
    await pause.focus();
    await page.keyboard.press("Space");
    await expect(pause).toHaveAttribute("aria-disabled", "true");
    await expect(t(page, "tm-op-start")).toHaveAttribute("aria-disabled", "true");
    await expect(pause).not.toHaveAttribute("disabled", /.*/);
    expect(await activeId(page)).toBe("tm-op-pause");
    await page.keyboard.press("Space"); // a press while the send is out changes nothing
    release();
    await expect(pause).not.toHaveAttribute("aria-disabled", "true");
    await expect(t(page, "tm-live")).toHaveText(SENT);
    expect(await activeId(page)).toBe("tm-op-pause");
    expect(mock.posts).toHaveLength(1);
    await clean(page, errors);
  });

  test("a refresh that finds the same list says nothing; the operate notice is announced when it changes", async ({ page }) => {
    const { mock, errors } = await setup(page, operateOn(), { clock: true });
    await open(page);
    await press(t(page, "tm-op-pause"));
    await expect(t(page, "tm-live")).toHaveText(SENT);
    await watchSaid(page);
    const poll = async () => {
      const before = mock.reads.filter((r) => r.endsWith("/gates")).length;
      await page.clock.runFor(15_500);
      await expect.poll(() => mock.reads.filter((r) => r.endsWith("/gates")).length).toBeGreaterThan(before);
      await page.waitForTimeout(300);
    };
    await poll();
    await poll();
    expect(await said(page)).toBe(0);
    await clean(page, errors);
  });

  // ── Halt ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  const REPOS_READS = (mock: Mock) => mock.reads.filter((r) => r === `${BASE}/repos`).length;

  test("an owner halts: Halt asks first in plain words with the runner's name, focus goes to Cancel, Escape and Cancel give it back, Yes sends one POST and the chip reads Halting…", async ({ page }) => {
    const { mock, errors } = await setup(page, operateOn());
    await open(page);
    await expect(t(page, "tm-halt-chip")).toBeHidden();
    const btn = t(page, "tm-halt-btn");
    await expect(btn).toHaveText("Halt");
    await expect(btn).toHaveAttribute("aria-disabled", "false");
    const confirm = t(page, "tm-halt-confirm");
    await press(btn);
    await expect(confirm).toBeVisible();
    await expect(t(page, "tm-halt-confirm-text")).toHaveText("This stops the engine on Workshop laptop now and kills its agents.");
    await expect(confirm).toContainText("Every command is refused until an owner or admin clears the halt.");
    await expect(confirm).toHaveAttribute("role", "group");
    const labelledBy = (await confirm.getAttribute("aria-labelledby")) ?? "";
    await expect(page.locator(`${WIN} #${labelledBy}`)).toHaveText("Halt the engine?");
    expect(await activeId(page)).toBe("tm-halt-cancel");
    await page.keyboard.press("Shift+Tab");
    expect(await activeId(page)).toBe("tm-halt-yes");
    await press(t(page, "tm-halt-cancel"));
    await expect(confirm).toHaveCount(0);
    expect(await activeId(page)).toBe("tm-halt-btn");
    await press(btn);
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    expect(await activeId(page)).toBe("tm-halt-btn");
    expect(mock.halts).toEqual([]);
    await press(btn);
    await press(t(page, "tm-halt-yes"));
    await expect(t(page, "tm-halt-chip")).toHaveText("Halting…");
    expect(mock.halts).toEqual(["halt"]);
    await expect(confirm).toHaveCount(0);
    await expect(t(page, "tm-halt-text")).toHaveAttribute("data-state", "pending");
    await expect(t(page, "tm-clear-btn")).toHaveText("Clear halt");
    await expect(t(page, "tm-halt-btn")).toHaveCount(0);
    expect(await activeId(page)).toBe("tm-clear-btn"); // focus follows the one control that stands for the action
    await expect(t(page, "tm-live")).toHaveText("Halting. Waiting for the machine to confirm it stopped the engine.");
    await expect(t(page, "tm-op-why")).toHaveText("A halt is being applied."); // pending wins over halted while the machine has not confirmed
    await clean(page, errors);
  });

  test("the halt applied: the chip reads Halted on the next read, said once; a clear asks first, says the engine is not started, and puts the app back", async ({ page }) => {
    const { mock, errors } = await setup(page, operateOn(), { clock: true });
    await open(page);
    await press(t(page, "tm-halt-btn"));
    await press(t(page, "tm-halt-yes"));
    await expect(t(page, "tm-halt-chip")).toHaveText("Halting…");
    mock.repos = mock.repos.map((r) => ({ ...r, halt_pending: false }));
    await watchSaid(page);
    await page.clock.runFor(15_500);
    await expect(t(page, "tm-halt-chip")).toHaveText("Halted");
    await expect(t(page, "tm-live")).toHaveText("The engine is halted.");
    await expect(t(page, "tm-halt-text")).toHaveText("The engine is halted. It is stopped on the machine and every command is refused until a person clears the halt.");
    await expect(t(page, "tm-op-why")).toHaveText("The engine is halted.");
    await expect(t(page, "tm-op-pause")).toHaveAttribute("aria-disabled", "true");
    const said1 = await said(page);
    await page.clock.runFor(15_500);
    await page.clock.runFor(15_500);
    await page.waitForTimeout(300);
    expect(await said(page)).toBe(said1); // a poll that finds the same state says nothing
    const confirm = t(page, "tm-halt-confirm");
    await press(t(page, "tm-clear-btn"));
    await expect(confirm).toBeVisible();
    await expect(page.locator(`${WIN} #tm-halt-q`)).toHaveText("Clear the halt?");
    await expect(confirm).toContainText("The engine is not started for you");
    await expect(confirm).toContainText("does not lift that");
    expect(await activeId(page)).toBe("tm-halt-cancel");
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    expect(await activeId(page)).toBe("tm-clear-btn");
    expect(mock.halts).toEqual(["halt"]);
    await press(t(page, "tm-clear-btn"));
    await press(t(page, "tm-halt-yes"));
    expect(mock.halts).toEqual(["halt", "clear"]);
    await expect(t(page, "tm-halt-chip")).toBeHidden();
    await expect(t(page, "tm-halt-btn")).toHaveText("Halt");
    expect(await activeId(page)).toBe("tm-halt-btn");
    await expect(t(page, "tm-live")).toHaveText("The halt is cleared. The engine is not started again until you start it.");
    await expect(t(page, "tm-op-pause")).toHaveAttribute("aria-disabled", "false");
    await clean(page, errors);
  });

  test("a member sees the halted state and its chip but no Halt, no Clear and no question; an owner sees Halt even while operate is off", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const member = await setup(page, operateOn({ settings: F.settings({ can_edit: false, operate_enabled: true }), repos: [F.repo({ operate_enabled: true, halted: true })] }));
    await open(page);
    await expect(t(page, "tm-halt-chip")).toHaveText("Halted");
    await expect(t(page, "tm-halt-text")).toContainText("The engine is halted.");
    await expect(page.locator(`${WIN} [data-testid="tm-halt"] button`)).toHaveCount(0);
    await expect(t(page, "tm-operate")).toBeHidden();
    await clean(page, member.errors);
  });

  test("a member of a repo that is not halted sees no halt section at all", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const { errors } = await setup(page, operateOn({ settings: F.settings({ can_edit: false, operate_enabled: true }) }));
    await open(page);
    await expect(t(page, "tm-halt")).toBeHidden();
    await expect(t(page, "tm-halt-chip")).toBeHidden();
    await clean(page, errors);
  });

  test("an owner with operate off can still halt: the Halt button is there and sends one POST", async ({ page }) => {
    const { mock, errors } = await setup(page, fresh({ settings: makeFixtures(Date.now()).settings() }));
    await open(page);
    await expect(t(page, "tm-op-pause")).toHaveAttribute("aria-disabled", "true");
    await press(t(page, "tm-halt-btn"));
    await press(t(page, "tm-halt-yes"));
    await expect.poll(() => mock.halts).toEqual(["halt"]);
    await clean(page, errors);
  });

  test("every refusal of a halt or a clear is a plain sentence in the page, never the server's text, and the repos are read again", async ({ page }) => {
    const { mock, errors } = await setup(page, operateOn());
    await open(page);
    const cases: [number, string, string][] = [
      [403, "forbidden", "Only an owner or admin can halt the engine."],
      [404, "not_found", "That repository no longer exists."],
      [409, "conflict", "The halt was not accepted. Reload the page and try again."],
      [500, "server_error", "The halt may not have gone through. Check the state above, then try again."],
    ];
    for (const [status, code, sentence] of cases) {
      mock.haltStatus = status;
      mock.haltCode = code;
      const reads = REPOS_READS(mock);
      await press(t(page, "tm-halt-btn"));
      await press(t(page, "tm-halt-yes"));
      await expect(t(page, "tm-halt-note")).toHaveText(sentence);
      await expect(t(page, "tm-live")).toContainText(sentence);
      expect(await activeId(page)).toBe("tm-halt-btn");
      await expect.poll(() => REPOS_READS(mock)).toBeGreaterThan(reads);
      await expect(page.locator(`${WIN} [data-testid="tm-halt"] button`)).toHaveCount(1);
    }
    expect(mock.halts).toEqual(["halt", "halt", "halt", "halt"]);
    mock.haltStatus = 200;
    mock.haltCode = "";
    await press(t(page, "tm-halt-btn"));
    await expect(t(page, "tm-halt-note")).toHaveCount(0); // a new question clears the note
    await press(t(page, "tm-halt-yes"));
    await expect(t(page, "tm-clear-btn")).toBeVisible();
    mock.haltStatus = 403;
    mock.haltCode = "forbidden";
    await press(t(page, "tm-clear-btn"));
    await press(t(page, "tm-halt-yes"));
    await expect(t(page, "tm-halt-note")).toHaveText("Only an owner or admin, signed in, can clear a halt.");
    expect(await activeId(page)).toBe("tm-clear-btn");
    await clean(page, errors);
  });

  test("a save in flight locks Halt with aria-disabled and a reason while focus stays on it", async ({ page }) => {
    const { mock, errors } = await setup(page, operateOn());
    await open(page);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    await page.route((u) => u.pathname.endsWith("/halt"), async (route) => { await gate; await route.fallback(); });
    await press(t(page, "tm-halt-btn"));
    await press(t(page, "tm-halt-yes"));
    await expect(t(page, "tm-clear-btn").or(t(page, "tm-halt-btn"))).toHaveAttribute("aria-disabled", "true");
    await expect(t(page, "tm-halt-why")).toHaveText("Another change is being saved. Try again in a moment.");
    await expect(t(page, "tm-halt-btn")).toHaveAttribute("aria-describedby", "tm-halt-why");
    expect(await activeId(page)).toBe("tm-halt-btn");
    await t(page, "tm-halt-btn").evaluate((el) => (el as HTMLElement).click()); // a press while it is out opens nothing and sends nothing more
    await expect(t(page, "tm-halt-confirm")).toHaveCount(0);
    release();
    await expect.poll(() => mock.halts).toEqual(["halt"]);
    await expect(t(page, "tm-clear-btn")).toHaveAttribute("aria-disabled", "false");
    await expect(t(page, "tm-halt-why")).toHaveCount(0);
    await clean(page, errors);
  });

  test("the question closes when someone else halts: focus lands on the control that replaced it", async ({ page }) => {
    const { mock, errors } = await setup(page, operateOn(), { clock: true });
    await open(page);
    await press(t(page, "tm-halt-btn"));
    await expect(t(page, "tm-halt-confirm")).toBeVisible();
    mock.repos = mock.repos.map((r) => ({ ...r, halted: true, halt_pending: false }));
    await page.clock.runFor(15_500);
    await expect(t(page, "tm-halt-confirm")).toHaveCount(0);
    await expect(t(page, "tm-clear-btn")).toBeVisible();
    expect(await activeId(page)).toBe("tm-clear-btn");
    expect(mock.halts).toEqual([]);
    await clean(page, errors);
  });

  test("a hostile runner name is only ever text in the halt question", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const { errors } = await setup(page, operateOn({ repos: [F.repo({ operate_enabled: true, runner_name: HOSTILE })] }));
    await open(page);
    await press(t(page, "tm-halt-btn"));
    await expect(t(page, "tm-halt-confirm-text")).toContainText(HOSTILE);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    await expect(page.locator(`${WIN} [data-testid="tm-halt-confirm"] img, ${WIN} [data-testid="tm-halt-confirm"] script, ${WIN} [data-testid="tm-halt-confirm"] a`)).toHaveCount(0);
    await clean(page, errors);
  });

  test("themes with the halt on screen: axe finds nothing serious, and the halt text, chip, note and focus rings keep contrast 4.5 and 3 under every theme (numbers recorded)", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const { errors } = await setup(page, operateOn({ repos: [F.repo({ operate_enabled: true, halted: true, halt_pending: true })] }));
    await open(page);
    const measure = () => page.evaluate((sel) => {
      const lum = (c: string) => {
        const m = c.match(/[\d.]+/g)!.map(Number);
        const [r, g, b] = m.slice(0, 3).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const bg = (el: Element) => {
        for (let e: Element | null = el; e; e = e.parentElement) {
          const c = getComputedStyle(e).backgroundColor;
          const m = c.match(/[\d.]+/g)!.map(Number);
          if (m.length < 4 || m[3] === 1) return c;
        }
        return "rgb(0, 0, 0)";
      };
      const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      let text = 21;
      for (const el of document.querySelectorAll(`${sel} .tm-halt-chip, ${sel} .tm-halt-state, ${sel} .tm-halt-note, ${sel} .tm-halt .tm-btn, ${sel} .tm-halt .tm-sub, ${sel} .tm-halt .tm-muted, ${sel} .tm-confirm p`)) {
        if ((el as HTMLElement).offsetParent === null) continue;
        text = Math.min(text, ratio(lum(getComputedStyle(el).color), lum(bg(el))));
      }
      const ae = document.activeElement as HTMLElement | null;
      let ring = -1; // -1: the keyboard is not on a control of the app
      if (ae && ae.closest(sel) && ae.matches(":focus-visible")) {
        const cs = getComputedStyle(ae);
        ring = cs.outlineStyle === "none" || parseFloat(cs.outlineWidth) < 2 ? 0 : ratio(lum(cs.outlineColor), lum(bg(ae.parentElement as Element)));
      }
      return { text: Math.round(text * 100) / 100, ring: Math.round(ring * 100) / 100 };
    }, WIN);
    const axe = async (label: string) => {
      const res = await new AxeBuilder({ page }).include(WIN).exclude(`${WIN} .window-titlebar`).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
      expect(res.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`), label).toEqual([]);
    };
    const ratios: Record<string, number> = {};
    const rings: Record<string, number> = {};
    for (const theme of THEMES) {
      await applyTheme(page, theme);
      await axe(theme + " halting");
      // The keyboard lands on Clear halt, opens the question with Enter (so focus-visible holds on Cancel), and walks back.
      await t(page, "tm-clear-btn").focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      const a = await measure();
      rings[theme + " clear"] = a.ring;
      ratios[theme + " halting"] = a.text;
      await page.keyboard.press("Enter");
      await expect(t(page, "tm-halt-confirm")).toBeVisible();
      expect(await activeId(page)).toBe("tm-halt-cancel");
      await axe(theme + " question");
      const b = await measure();
      rings[theme + " cancel"] = b.ring;
      ratios[theme + " question"] = b.text;
      await page.keyboard.press("Shift+Tab");
      const c = await measure();
      rings[theme + " yes"] = c.ring;
      await page.keyboard.press("Escape");
      await expect(t(page, "tm-halt-confirm")).toHaveCount(0);
    }
    for (const [k, v] of Object.entries(ratios)) expect(v, k).toBeGreaterThanOrEqual(4.5);
    expect(Object.entries(rings).filter(([, v]) => v < 3), "focus rings under 3:1 (or missing)").toEqual([]);
    console.log("HALT-CONTRAST " + JSON.stringify({ project: test.info().project.name, ...ratios }));
    console.log("HALT-FOCUSRING " + JSON.stringify({ project: test.info().project.name, ...rings }));
    await clean(page, errors);
  });

  test("Log: each line shows its time, role, kind and D# / PR links, with the fixed note and a Load older button that has nothing to do", async ({ page }) => {
    const { errors } = await setup(page, fresh());
    await open(page);
    await expect(t(page, "tm-log-note")).toHaveText("Log text stays on your machine; the cloud receives only what kind of line it was.");
    const rows = t(page, "tm-log-line");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("team-lead");
    await expect(rows.nth(0)).toContainText("merged");
    await expect(rows.nth(0)).toContainText(/\d\d:\d\d/);
    await expect(rows.nth(0).locator("a").nth(0)).toHaveAttribute("href", "https://github.com/acme-labs/widgets/discussions/42");
    await expect(rows.nth(0).locator("a").nth(1)).toHaveAttribute("href", "https://github.com/acme-labs/widgets/pull/7");
    await expect(rows.nth(2)).toContainText("gate passed");
    await expect(rows.nth(1).locator("a")).toHaveCount(1); // no PR on this line
    await expect(t(page, "tm-log-asof")).toHaveText(/^as of \d\d:\d\d \(\d+ min ago\)$/);
    await expect(t(page, "tm-log-older")).toHaveAttribute("aria-disabled", "true");
    await expect(t(page, "tm-log-older")).toHaveText("No older lines");
    await expect(t(page, "tm-log-list")).toHaveAttribute("tabindex", "0");
    await expect(t(page, "tm-log-list")).toHaveAttribute("aria-label", "Log lines");
    await clean(page, errors);
  });

  test("Log with 10,000 events: paging all the way down keeps at most 400 rows in the DOM, no long task over 200 ms, and Load older keeps focus", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const PAGE = 100, TOTAL = 10_000;
    const logPage = (cursor: string) => {
      const start = cursor === "" ? 0 : Number(cursor);
      const next = start + PAGE;
      return F.envelope(F.logLines(PAGE, start), { next_cursor: next >= TOTAL ? null : String(next) });
    };
    const mock = fresh({ log: logPage(""), logPage });
    mock.log = { ...logPage(""), next_cursor: String(PAGE) };
    const { errors } = await setup(page, mock);
    await page.addInitScript(() => {
      const w = window as unknown as { __long: number[] };
      w.__long = [];
      try { new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__long.push(e.duration))).observe({ entryTypes: ["longtask"] }); } catch { /* no long-task support: the count stays 0 */ }
    });
    await page.reload();
    await waitForDesktop(page);
    await open(page);
    const rows = page.locator(`${WIN} [data-testid="tm-log-line"]`);
    await expect(rows).toHaveCount(100);
    let most = 100, pages = 1;
    const older = t(page, "tm-log-older");
    await older.focus();
    for (let i = 0; i < 99; i++) {
      await page.keyboard.press("Enter");
      await expect(older).not.toHaveText("Loading older lines…");
      pages += 1;
      most = Math.max(most, await rows.count());
      expect(most).toBeLessThanOrEqual(400);
      expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe("tm-log-older"); // focus stays on the button through every rebuild
      if ((await older.getAttribute("aria-disabled")) === "true") break;
    }
    await expect(older).toHaveText("No older lines");
    await expect(rows).toHaveCount(400);
    await expect(t(page, "tm-log-newest")).toContainText("9600 newer lines not shown");
    await expect(t(page, "tm-live")).toContainText("Older log lines loaded");
    const long = await page.evaluate(() => (window as unknown as { __long: number[] }).__long);
    console.log("LOGLOAD " + JSON.stringify({ project: test.info().project.name, pages, mostRows: most, longTasksOver200: long.filter((d) => d > 200).length, longest: Math.round(Math.max(0, ...long)) }));
    expect(long.filter((d) => d > 200)).toEqual([]);
    // Back to newest: the first page again, and the button is gone with focus handed to the list's own place (the heading, never the page).
    await press(t(page, "tm-log-newest"));
    await expect(rows).toHaveCount(100);
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
    await clean(page, errors);
  });

  test("Log scrolling: reaching the bottom of the list loads the next page without a click", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const logPage = (cursor: string) => { const start = cursor === "" ? 0 : Number(cursor); return F.envelope(F.logLines(60, start), { next_cursor: start + 60 >= 240 ? null : String(start + 60) }); };
    const { errors } = await setup(page, fresh({ log: { ...logPage(""), next_cursor: "60" }, logPage }));
    await open(page);
    const rows = page.locator(`${WIN} [data-testid="tm-log-line"]`);
    await expect(rows).toHaveCount(60);
    await page.evaluate((sel) => { const l = document.querySelector(sel + ' [data-testid="tm-log-list"]') as HTMLElement; l.scrollTop = l.scrollHeight; }, WIN);
    await expect(rows).toHaveCount(120);
    await clean(page, errors);
  });


  test("Cost: the route's total and each row's figure are drawn as sent, a row with no figure says why in words, and the header carries its age", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const mock = fresh({ usage: F.usage({ items: [F.usageItem({ api_equivalent_usd: 1234.5 }), F.usageItem({ subject_kind: "tick", subject_id: "t1", model: null, credential_mode: null, tokens: null, api_equivalent_usd: null, state: "not_recorded", note: "Usage was not recorded for this tick. That is not the same as $0." })], totals: { api_equivalent_usd: 1235.5, tokens: { input: 1, output: 1, cache_read: 0, cache_write: 0 } } }) });
    const { errors } = await setup(page, mock);
    await open(page);
    await expect(t(page, "tm-usage-headline")).toHaveText("$1,235.50"); // the route's own total, not the two rows added
    await expect(t(page, "tm-usage-value")).toHaveText(["$1,234.50", "Usage was not recorded for this tick. That is not the same as $0."]);
    await expect(t(page, "tm-usage-row").nth(0)).toContainText("Agent · sonnet-5 · on your Claude plan");
    await expect(t(page, "tm-usage-row").nth(1)).toContainText("Tick · unknown model");
    await expect(t(page, "tm-usage-asof")).toHaveText(/^as of \d\d:\d\d \(0 min ago\)$/);
    await expect(t(page, "tm-usage-window")).toHaveText(/^Window: \d{4}-\d\d-\d\d to \d{4}-\d\d-\d\d$/);
    expect((await t(page, "tm-usage").innerText()).replace(/That is not the same as \$0\./i, "")).not.toMatch(/\$0(?!\.\d*[1-9])/);
    await clean(page, errors);
  });

  test("Cost: its gap reaches the banner, its stale heartbeat warns on its header, and a source age shows its notice", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const { errors } = await setup(page, fresh({ usage: F.usage({ missing_events: 2, gaps: [{ from_seq: 1, to_seq: 2, before_ts: F.iso(900) }], heard_age_s: 900, source_ages_s: { loop: 2 * 3600 } }) }));
    await open(page);
    await expect(t(page, "tm-banner")).toHaveText(/^Events missing since \d\d:\d\d \(2 events\)$/);
    await expect(t(page, "tm-usage-warn")).toHaveText("last seen 15 min ago");
    await expect(t(page, "tm-notice")).toHaveText(["loop not updated for 2 h"]);
    await expect(t(page, "tm-usage-row")).toHaveCount(2);
    await clean(page, errors);
  });

  test("Stats: '(from N events)' is a button that opens the kinds, the count and the event numbers per session, keeps focus on itself, and closes again", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const seqs = [3, 4, 5, 7].map((seq) => ({ session_id: "s-one", seq }));
    const { errors } = await setup(page, fresh({ stats: F.stats({ merges: { value: 4, provenance: { kinds: ["pr_merged"], count: 4, seqs } } }) }));
    await open(page);
    const btn = t(page, "tm-stat-from").nth(2);
    const region = t(page, "tm-stat-prov").nth(2);
    await expect(btn).toHaveText("(from 4 events)");
    await expect(btn).toHaveAttribute("aria-expanded", "false");
    await expect(region).toBeHidden();
    await btn.focus();
    await page.keyboard.press("Enter");
    await expect(btn).toHaveAttribute("aria-expanded", "true");
    await expect(region).toBeVisible();
    await expect(region).toContainText("Event kinds: pr merged");
    await expect(region).toContainText("Events: 4");
    await expect(region).toContainText("Session 1: seq 3–5, 7");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-focus"))).toBe("prov-merges");
    expect(await page.evaluate((sel) => (document.querySelector(sel + ' [data-testid="tm-stats"]') as HTMLElement).innerText.includes("s-one"), WIN)).toBe(false);
    await page.keyboard.press("Space");
    await expect(btn).toHaveAttribute("aria-expanded", "false");
    await expect(region).toBeHidden();
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-focus"))).toBe("prov-merges");
    await clean(page, errors);
  });

  test("a refresh that only moves the 'as of' time does not rebuild the plan, so focus stays on a D# link", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const { mock } = await setup(page, fresh(), { clock: true });
    await open(page);
    const link = t(page, "tm-plan").locator('[data-testid="tm-d"]').first();
    await link.focus();
    await page.evaluate(() => { (window as unknown as { __kept: Element | null }).__kept = document.activeElement; });
    const before = await t(page, "tm-plan-asof").innerText();
    mock.plan = { ...mock.plan, as_of: F.iso(600) }; // ten minutes earlier: the header text must change
    mock.reads.length = 0;
    await page.clock.runFor(15_500);
    await expect.poll(() => mock.reads.filter((r) => r.endsWith("/plan")).length).toBeGreaterThanOrEqual(1);
    await expect(t(page, "tm-plan-asof")).not.toHaveText(before);
    expect(mock.reads.some((r) => r.endsWith("/plan"))).toBe(true);
    expect(await page.evaluate(() => document.activeElement === (window as unknown as { __kept: Element | null }).__kept)).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe("tm-d");
  });

  test("Log: a failed older page says so, keeps the rows and can be tried again; lines are only text", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const first = F.envelope([F.logLine({ actor_role: HOSTILE, category: HOSTILE })], { next_cursor: "x" });
    const mock = fresh({ log: first, logPage: (cursor) => (cursor === "" ? first : { weird: true }) });
    const { errors } = await setup(page, mock);
    await open(page);
    await expect(t(page, "tm-log-line").locator(".tm-role bdi")).toHaveText(HOSTILE);
    await expect(t(page, "tm-log-line")).toContainText("other"); // an odd kind is a plain word
    await expect(page.locator(`${WIN} .tm-app img, ${WIN} .tm-app script, ${WIN} .tm-app b`)).toHaveCount(0);
    await press(t(page, "tm-log-older"));
    await expect(t(page, "tm-log-older-failed")).toHaveText("Older lines couldn't be loaded.");
    await expect(t(page, "tm-live")).toContainText("Older lines couldn't be loaded."); // announced, not only drawn
    await expect(t(page, "tm-log-line")).toHaveCount(1);
    await expect(t(page, "tm-log-older")).toHaveText("Load older");
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    expect(errors).toEqual([]);
  });

  test("Plan: today's items with D# links, roadmap rows with key, status and counts, (no key) for an empty key, and the 30-day merged count", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const lanes = F.envelope([F.lane({ pr: 1, discussion: 42, state: "merged", updated_at: F.iso(86400) }), F.lane({ pr: 2, discussion: 42, state: "merged", updated_at: F.iso(40 * 86400) })]);
    const { errors } = await setup(page, fresh({ lanes }));
    await open(page);
    await expect(t(page, "tm-plan-date")).toHaveText(/^Plan for \d{4}-\d\d-\d\d$/);
    await expect(t(page, "tm-plan-item")).toHaveCount(2);
    await expect(t(page, "tm-plan-item").nth(0)).toContainText("1.");
    await expect(t(page, "tm-plan-item").nth(0)).toContainText("In progress");
    await expect(t(page, "tm-plan-item").nth(0).locator("a")).toHaveAttribute("href", "https://github.com/acme-labs/widgets/discussions/42");
    const rows = t(page, "tm-roadmap-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("EB-6b");
    await expect(t(page, "tm-roadmap-counts").nth(0)).toHaveText("1 merged in the last 30 days · 3 planned");
    await expect(rows.nth(1)).toContainText("(no key)");
    await expect(t(page, "tm-plan-asof")).toHaveText(/^as of \d\d:\d\d \(\d+ min ago\)$/);
    await clean(page, errors);
  });

  test("Plan: no snapshot reads Plan not synced yet, and a snapshot over 26 h old reads Plan from <date>", async ({ page }) => {
    const { errors } = await setup(page, fresh({ plan: null }));
    await open(page);
    await expect(t(page, "tm-plan-none")).toHaveText("Plan not synced yet");
    await expect(t(page, "tm-plan-warn")).toHaveCount(0);
    await clean(page, errors);
    const F = makeFixtures(Date.now());
    const p2 = await page.context().newPage();
    const second = await setup(p2, fresh({ plan: F.plan({ age_s: 27 * 3600, plan_date: "2026-11-14" }) }));
    await open(p2);
    await expect(t(p2, "tm-plan-date")).toHaveText("Plan from 2026-11-14");
    await clean(p2, second.errors);
  });

  test("Plan: a hostile row key is text, and a long roadmap pages 100 rows at a time with focus kept on the button", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const roadmap = Array.from({ length: 250 }, (_, i) => ({ row_key: i === 0 ? HOSTILE : "R" + i, discussion: null, status: "done", planned_prs: null }));
    const { errors } = await setup(page, fresh({ plan: F.plan({ roadmap }) }));
    await open(page);
    await expect(t(page, "tm-roadmap-row")).toHaveCount(100);
    await expect(t(page, "tm-roadmap-row").first().locator("bdi")).toHaveText(HOSTILE);
    await expect(page.locator(`${WIN} .tm-app img, ${WIN} .tm-app script, ${WIN} .tm-app b`)).toHaveCount(0);
    await expect(t(page, "tm-plan-span")).toHaveText("Rows 1–100 of 250");
    await expect(t(page, "tm-plan-prev")).toHaveAttribute("aria-disabled", "true");
    await t(page, "tm-plan-next").focus();
    await page.keyboard.press("Enter");
    await expect(t(page, "tm-plan-span")).toHaveText("Rows 101–200 of 250");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe("tm-plan-next");
    await page.keyboard.press("Enter");
    await expect(t(page, "tm-plan-span")).toHaveText("Rows 201–250 of 250");
    await expect(t(page, "tm-roadmap-row")).toHaveCount(50);
    await expect(t(page, "tm-plan-next")).toHaveAttribute("aria-disabled", "true");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe("tm-plan-next");
    await clean(page, errors);
  });

  test("Stats: the figures as the server sent them, each with the events behind it; a missing figure says no figures yet", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const { errors } = await setup(page, fresh());
    await open(page);
    const rows = t(page, "tm-stat");
    await expect(rows).toHaveText([/Agents by role: executor 2, code-reviewer 1 \(from 6 events\)/, /Duration: median 120.5 s, p90 300 s \(from 3 events\)/, /Merges: 4 \(from 4 events\)/, /Gates passed: 3 of 4 \(from 1 event\)/]);
    await expect(t(page, "tm-stats-window")).toHaveText(/^Window: \d{4}-\d\d-\d\d to \d{4}-\d\d-\d\d$/);
    await expect(t(page, "tm-stats-asof")).toHaveText(/^as of /);
    await clean(page, errors);
    void F;
  });

  test("Stats and plan that cannot be read say so, and the log and lanes still show; a stale heartbeat warns on the new panels too", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const { errors } = await setup(page, fresh({ fail: ["/stats", "/plan", "/usage"], log: F.envelope([F.logLine()], { heard_age_s: 900 }) }));
    await open(page);
    await expect(t(page, "tm-usage-failed")).toHaveText("This panel couldn't be read.");
    await expect(t(page, "tm-live")).toContainText("Plan panel couldn't be read. Stats panel couldn't be read. Cost panel couldn't be read.");
    await expect(t(page, "tm-stats-failed")).toHaveText("This panel couldn't be read.");
    await expect(t(page, "tm-plan-failed")).toHaveText("This panel couldn't be read.");
    await expect(t(page, "tm-log-warn")).toHaveText("last seen 15 min ago");
    await expect(t(page, "tm-log-line")).toHaveCount(1);
    await expect(t(page, "tm-lane")).toHaveCount(3);
    await clean(page, errors);
  });

  test("L1: a gap that only the log reports puts the banner on the app, and the log's source age shows its notice", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const { errors } = await setup(page, fresh({ log: F.envelope([F.logLine()], { missing_events: 5, gaps: [{ from_seq: 1, to_seq: 5, before_ts: F.iso(1200) }], source_ages_s: { team_log: 3 * 3600 } }) }));
    await open(page);
    await expect(t(page, "tm-banner")).toHaveText(/^Events missing since \d\d:\d\d \(5 events\)$/);
    await expect(t(page, "tm-notice")).toHaveText(["team log not updated for 3 h"]);
    await clean(page, errors);
  });

  test("a control with nothing left to do keeps focus (aria-disabled), never dropping it to the page", async ({ page }) => {
    const mock = fresh({ log: makeFixtures(Date.now()).envelope([makeFixtures(Date.now()).logLine()], { next_cursor: "x" }), logPage: () => makeFixtures(Date.now()).envelope([], { next_cursor: null }) });
    const { errors } = await setup(page, mock);
    await open(page);
    await t(page, "tm-log-older").focus();
    await page.keyboard.press("Enter");
    await expect(t(page, "tm-log-older")).toHaveText("No older lines");
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
    await clean(page, errors);
  });

  test("themes: axe finds nothing serious or critical, the app's text keeps a contrast of at least 4.5 and its focus ring at least 3 under every theme (numbers recorded)", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const longRoadmap = Array.from({ length: 150 }, (_, i) => ({ row_key: "R" + i, discussion: 42, status: "in_progress", planned_prs: 2 }));
    const { errors } = await setup(page, operateOn({ plan: F.plan({ roadmap: longRoadmap }), commands: { commands: [F.command(), F.command({ id: "c0000000-0000-4000-8000-000000000002", kind: "start_day", state: "refused", refusal: "halted", acked_at: F.iso(10) })] }, agents: F.envelope([F.agent(), F.agent({ agent_id: "b2c3d4e5f6071829", started_at: F.iso(5 * 3600) })], { heard_age_s: 400, missing_events: 3, gaps: [{ from_seq: 1, to_seq: 3, before_ts: F.iso(900) }], source_ages_s: { loop: 9000 } }) }));
    await open(page);
    await press(t(page, "tm-settings-btn"));
    const ratios: Record<string, number> = {};
    const rings: Record<string, number> = {};
    const ringsAll: Record<string, number> = {};
    for (const theme of THEMES) {
      await applyTheme(page, theme);
      const res = await new AxeBuilder({ page }).include(WIN).exclude(`${WIN} .window-titlebar`).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
      const bad = res.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
      expect(bad, theme).toEqual([]);
      // Contrast numbers: each text kind against the first opaque background behind it.
      const measure = () => page.evaluate((sel) => {
        const lum = (c: string) => {
          const m = c.match(/[\d.]+/g)!.map(Number);
          const [r, g, b] = m.slice(0, 3).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const bg = (el: Element) => {
          for (let e: Element | null = el; e; e = e.parentElement) {
            const c = getComputedStyle(e).backgroundColor;
            const m = c.match(/[\d.]+/g)!.map(Number);
            if (m.length < 4 || m[3] === 1) return c;
          }
          return "rgb(0, 0, 0)";
        };
        let worst = 21;
        for (const el of document.querySelectorAll(`${sel} .tm-asof, ${sel} .tm-warn, ${sel} .tm-chip, ${sel} .tm-banner, ${sel} .tm-notice, ${sel} .tm-muted, ${sel} .tm-role, ${sel} .tm-state, ${sel} .tm-time, ${sel} .tm-cat, ${sel} .tm-gate, ${sel} .tm-link, ${sel} .tm-btn, ${sel} .tm-check, ${sel} .tm-field, ${sel} .tm-select, ${sel} .tm-input, ${sel} .tm-cmd-detail`)) {
          const a = lum(getComputedStyle(el).color), b = lum(bg(el));
          worst = Math.min(worst, (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05));
        }
        // The focus ring of whatever the keyboard is on: at least 2 px, and 3:1 against what is behind it.
        const ae = document.activeElement as HTMLElement | null;
        let ring: number | null = null;
        if (ae && ae.closest(sel) && ae.matches(":focus-visible")) {
          const cs = getComputedStyle(ae);
          const a = lum(cs.outlineColor), b = lum(bg(ae.parentElement as Element));
          ring = cs.outlineStyle === "none" || parseFloat(cs.outlineWidth) < 2 ? 0 : Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
        }
        return { text: Math.round(worst * 100) / 100, ring };
      }, WIN);
      const min = (await measure()).text;
      ratios[theme] = min;
      expect(min, theme).toBeGreaterThanOrEqual(4.5);
      // Focus ring, reached with the keyboard (so :focus-visible holds): the picker, the settings button, a box in the sheet and a link.
      for (const id of ["tm-repo", "tm-settings-btn", "tm-watch", "tm-d", "tm-log-list", "tm-log-older", "tm-plan-next", "tm-op-switch", "tm-op-start", "tm-op-role", "tm-op-discussion", "tm-op-class", "tm-op-setdial", "tm-dial-select", "tm-dial-apply", "tm-cmd-cancel", "tm-halt-btn"]) {
        await t(page, id).first().focus();
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Tab");
        const got = await measure();
        ringsAll[`${theme} ${id}`] = got.ring ?? -1; // -1: the keyboard did not land on the control
        rings[theme] = Math.min(rings[theme] ?? 21, got.ring ?? -1);
      }
    }
    expect(Object.entries(ringsAll).filter(([, v]) => v < 3), "focus rings under 3:1 (or missing)").toEqual([]);
    console.log("CONTRAST " + JSON.stringify({ project: test.info().project.name, ...ratios }));
    console.log("FOCUSRING " + JSON.stringify({ project: test.info().project.name, ...rings }));
    await clean(page, errors);
  });
});
