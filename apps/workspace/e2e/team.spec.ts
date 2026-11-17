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
  /** Every PUT, with its body. */
  puts: { path: string; body: unknown }[];
  /** GET reads per path (query included). */
  reads: string[];
  /** Path fragments that answer 500. */
  fail: string[];
  /** The PUT answer: 200, or an error status with its code. */
  putStatus: number;
  putCode: string;
  streaming: boolean;
  streamFrame: string | null;
}
const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

function fresh(over: Partial<Mock> = {}): Mock {
  const F = makeFixtures(Date.now());
  return {
    settings: F.settings(), repos: [F.repo(), F.repo({ repo_id: REPO_B, full_name: "acme-labs/site", runner_name: "Studio desktop" })],
    agents: F.envelope([F.agent(), F.agent({ agent_id: "b2c3d4e5f6071829", role: "code-reviewer", discussion: 43, background: true, started_at: F.iso(120) })]),
    lanes: F.envelope([F.lane({ pr: 7, state: "testing" }), F.lane({ pr: 9, discussion: 44, state: "queued" }), F.lane({ pr: 5, discussion: 40, state: "merged" })]),
    gates: F.envelope([F.gate({ pr: 7, gate: "gate1", result: "pass" }), F.gate({ pr: 7, gate: "code_review", result: "fail" }), F.gate({ pr: 5, gate: "ci_full", result: "pass" })]),
    puts: [], reads: [], fail: [], putStatus: 200, putCode: "", streaming: false, streamFrame: null, ...over,
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
  await page.route((u) => u.pathname.startsWith(BASE), async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname + url.search;
    if (req.method() === "GET") {
      mock.reads.push(p);
      if (mock.fail.some((f) => p.includes(f))) return json(route, 500, { error: { code: "server_error", message: SERVER_TEXT, request_id: "r" } });
      if (url.pathname === `${BASE}/settings`) return json(route, 200, mock.settings);
      if (url.pathname === `${BASE}/repos`) return json(route, 200, { items: mock.repos });
      const m = url.pathname.match(new RegExp(`^${BASE}/repos/([^/]+)/(agents|lanes|gates)$`));
      if (m) return json(route, 200, mock[m[2] as "agents" | "lanes" | "gates"]);
    }
    if (req.method() === "PUT") {
      mock.puts.push({ path: url.pathname, body: req.postDataJSON() });
      if (mock.putStatus !== 200) return json(route, mock.putStatus, { error: { code: mock.putCode, message: SERVER_TEXT, request_id: "r" } });
      const body = (req.postDataJSON() ?? {}) as Obj;
      if (typeof body.watch_enabled === "boolean") mock.settings = { ...mock.settings, watch_enabled: body.watch_enabled };
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
    // Element counts: one picker, one chip, two panels, five rows (2 agents, 3 lane rows), one heading.
    expect(await page.locator(`${WIN} .tm-panel`).count()).toBe(2);
    expect(await page.locator(`${WIN} .tm-panel .tm-item`).count()).toBe(5);
    expect(await page.locator(`${WIN} select`).count()).toBe(1);
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
    await expect(t(page, "tm-refresh-failed")).toHaveText("Couldn't refresh. Showing the last data received.");
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
    for (const kind of ["agents?state=running", "lanes", "gates"]) expect(mock.reads.filter((r) => r === `${BASE}/repos/${REPO_A}/${kind}`).length).toBeGreaterThanOrEqual(1);
  });

  test("without a live stream the panels are read again every 15 s", async ({ page }) => {
    const { mock } = await setup(page, fresh(), { clock: true });
    await open(page);
    await expect(t(page, "tm-agent")).toHaveCount(2);
    mock.reads.length = 0;
    await page.clock.runFor(15_500);
    await expect.poll(() => mock.reads.filter((r) => r.endsWith("/lanes")).length).toBeGreaterThanOrEqual(1);
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
    await expect.poll(() => mock.puts.length).toBe(1);
    expect(mock.puts[0].body).toEqual({ watch_enabled: false });
    await expect(box1).not.toHaveAttribute("aria-disabled", "true");
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
    const mock = fresh({ agents: F.envelope([F.agent()], gap(3)), fail: ["/lanes"] });
    const { errors } = await setup(page, mock, { clock: true });
    await open(page);
    const live = t(page, "tm-live");
    await expect(live).toContainText("Events missing since");
    await expect(live).toContainText("(3 events)");
    await expect(live).toContainText("Couldn't refresh. Showing the last data received.");
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
    mock.fail = ["/lanes"];
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

  test("themes: axe finds nothing serious or critical, the app's text keeps a contrast of at least 4.5 and its focus ring at least 3 under every theme (numbers recorded)", async ({ page }) => {
    const F = makeFixtures(Date.now());
    const { errors } = await setup(page, fresh({ agents: F.envelope([F.agent(), F.agent({ agent_id: "b2c3d4e5f6071829", started_at: F.iso(5 * 3600) })], { heard_age_s: 400, missing_events: 3, gaps: [{ from_seq: 1, to_seq: 3, before_ts: F.iso(900) }], source_ages_s: { loop: 9000 } }) }));
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
        for (const el of document.querySelectorAll(`${sel} .tm-asof, ${sel} .tm-warn, ${sel} .tm-chip, ${sel} .tm-banner, ${sel} .tm-notice, ${sel} .tm-muted, ${sel} .tm-role, ${sel} .tm-state, ${sel} .tm-gate, ${sel} .tm-link, ${sel} .tm-btn, ${sel} .tm-check`)) {
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
      for (const id of ["tm-repo", "tm-settings-btn", "tm-watch", "tm-d"]) {
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
