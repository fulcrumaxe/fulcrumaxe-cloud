// apps/workspace/e2e/onboarding.spec.ts
//
// D#37 WS-F9a: the Onboarding app and the onboarding-mode gate, on the built cloud dist behind fixture-server.mjs.
// Every /api/v1 call is answered by page.route() from the contract fixtures (packages/api/fixtures/v1); the page carries
// the production CSP and Trusted Types. Desktop and phone projects both run everything; the phone checks sit in the walk.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { bootToDesktop } from "./helpers/boot";

const DIR = dirname(fileURLToPath(import.meta.url));
const fx = (...p: string[]) => JSON.parse(readFileSync(join(DIR, "..", "..", "..", "packages", "api", "fixtures", "v1", ...p), "utf8"));
const PLANS = JSON.parse(readFileSync(join(DIR, "plans-fixture.json"), "utf8"));
const ONB = { new: fx("getOnboarding", "200-new.json"), step3: fx("getOnboarding", "200-step3.json"), pay: fx("getOnboarding", "200-pay.json"), done: fx("getOnboarding", "200-complete.json") };
const doneUpTo = (n: number) => ({ ...ONB.new, steps: ONB.new.steps.map((s: object, i: number) => ({ ...s, completed_at: i < n ? `2026-09-20T09:0${i}:00.000Z` : null })) });
const PV = (name: string) => fx("getOnboardingPreview", name);
const REQ = (name: string) => fx("requestPreview", name);
const ALL_REPOS = fx("listRepos", "200-page.json");
const REPOS = { ...ALL_REPOS, data: [{ ...ALL_REPOS.data[0], app_kind: "team_readonly" }, ALL_REPOS.data[1]] };
const CSP = "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OTHERS = ["pipeline", "runs", "roles", "developer"];

/** The slice of the page's shell globals these tests drive from the console. */
interface Shell {
  FULCWM: { open(id: string, arg?: unknown): void; close(id: string): void };
  FULCApps: { ids(): string[]; get(id: string): unknown; visible(): { id: string }[] };
}
type Reply = { status: number; json?: unknown; text?: string; headers?: Record<string, string> } | "abort" | "hang";
const json = (body: unknown, status = 200): Reply => ({ status, json: body });
const err = (status: number, code: string): Reply => json({ error: { code, message: "x", request_id: "r" } }, status);
interface Mock {
  access: string; isAdmin: boolean; isOwner: boolean; partner: boolean;
  onboarding: Reply[]; previewGet: Reply[]; previewPost: Reply[]; // a queue: the last reply repeats
  requests: string[]; posts: { key?: string; body: unknown; ct: string }[]; checkouts: unknown[];
  repos: unknown; plans: unknown;
}
const mock = (o: Partial<Mock> = {}): Mock => ({
  access: "no_subscription", isAdmin: true, isOwner: true, partner: false,
  onboarding: [json(ONB.new)], previewGet: [json(PV("200-none.json"))], previewPost: [json(REQ("202-accepted.json"), 202)],
  requests: [], posts: [], checkouts: [], repos: REPOS, plans: PLANS.plans, ...o,
});
const take = (q: Reply[]) => (q.length > 1 ? q.shift()! : q[0]);
const answer = async (route: Route, r: Reply) => {
  if (r === "abort") return route.abort("failed");
  if (r !== "hang") await route.fulfill({ status: r.status, contentType: "application/json", headers: r.headers, body: r.text ?? JSON.stringify(r.json ?? {}) });
};
const count = (m: Mock, r: string) => m.requests.filter((x) => x === r).length;
const v1 = (m: Mock) => m.requests.filter((r) => r.includes("/api/v1/") || r.includes("/api/entitlements/me"));

async function setup(page: Page, m: Mock) {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(e.message));
  page.on("dialog", (d) => { problems.push("dialog " + d.message()); void d.dismiss(); });
  page.on("request", (r) => { const u = new URL(r.url()); if (u.pathname.startsWith("/api/")) m.requests.push(`${r.method()} ${u.pathname}`); });
  await page.route((u) => u.pathname === "/", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": CSP } });
  });
  await page.route("**/api/cloud/auth/me", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), workspace_access: m.access, is_admin: m.isAdmin } });
  });
  await page.route((u) => u.pathname === "/api/v1/onboarding", (route) => answer(route, take(m.onboarding)));
  await page.route((u) => u.pathname === "/api/v1/onboarding/preview", async (route) => {
    const req = route.request();
    if (req.method() !== "POST") return answer(route, take(m.previewGet));
    m.posts.push({ key: (await req.allHeaders())["idempotency-key"], body: req.postDataJSON(), ct: (await req.allHeaders())["content-type"] ?? "" });
    return answer(route, take(m.previewPost));
  });
  await page.route((u) => u.pathname === "/api/v1/repos", (route) => route.fulfill({ json: m.repos }));
  await page.route("**/api/plans", (route) => route.fulfill({ json: { ...PLANS, plans: m.plans, viewer: { is_owner: m.isOwner, partner_billed: m.partner } } }));
  await page.route("**/api/v1/billing/checkout-session", (route) => {
    m.checkouts.push(route.request().postDataJSON());
    return route.fulfill({ json: { url: "https://checkout.stripe.com/c/pay/opaque" } });
  });
  await page.route("https://*.stripe.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>stripe</title>" }));
  return problems;
}
const win = (page: Page, id: string) => page.locator(`.fulc-window[data-app-id="${id}"]`);
/** Scoped to the live window: the dock's hover preview holds a static clone of it that matches the same selectors. */
const ob = (page: Page) => win(page, "onboarding");
const dock = (page: Page, id: string) => page.locator(`.dock-icon[data-app-id="${id}"]`);
const current = (page: Page) => ob(page).locator('[data-testid="ob-app"] [aria-current="step"]');
/** Leaves Onboarding and comes back, which is how a hand-off returns: the window regains focus and re-reads. */
async function returnToOnboarding(page: Page, via = "repos") {
  await dock(page, via).click();
  await dock(page, "onboarding").click();
}
/**
 * Counts, in the page, each time the preview panel arms its next read (setTimeout of its `poll`). It only watches: the
 * call goes on to the page clock as before. This is the one fact a step has to wait for, because the panel sets the next
 * timer only after the previous read was answered and handled, and a runFor before that moves no timer at all.
 * Pass it to bootToDesktop as beforeGoto: init scripts added after the clock's wrap the clock's setTimeout.
 */
async function countPollTimers(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { setTimeout: (...a: unknown[]) => unknown; __pollTimers: number };
    w.__pollTimers = 0;
    const set = w.setTimeout;
    w.setTimeout = function (this: unknown, fn: unknown, ...rest: unknown[]) {
      if (typeof fn === "function" && fn.name === "poll") w.__pollTimers++;
      return set.call(this, fn, ...rest);
    };
  });
}
const pollTimers = (page: Page) => page.evaluate(() => (window as unknown as { __pollTimers: number }).__pollTimers);
/** Waits until the panel has armed `n` poll timers in all (the read before it is answered and handled). */
const untilPollTimers = (page: Page, n: number) => expect.poll(() => pollTimers(page), { intervals: [20, 50, 100, 250], timeout: 60_000 }).toBeGreaterThanOrEqual(n);
/**
 * Moves the stopped clock by `ms`; unless this is the read that ends polling, waits until the next timer is armed, so the
 * next step finds it. fastForward fires each due timer once and does not replay every animation frame in between, which
 * is what makes runFor(15 s) cost seconds of real time on a loaded machine; eighty of those were the test's whole budget.
 */
async function stepAndSettle(page: Page, ms: number, last = false) {
  const before = await pollTimers(page);
  await page.clock.fastForward(ms);
  if (!last) await untilPollTimers(page, before + 1);
}
async function gateFor(page: Page, m: Mock) {
  await setup(page, m);
  await page.goto("/");
  await expect(page.locator("#subscription-gate-screen")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#desktop-screen")).toHaveClass(/hidden/);
}

test.describe("the gate decision (criterion 1)", () => {
  test("open: the full desktop, no onboarding read, nothing opens by itself", async ({ page }) => {
    const m = mock({ access: "open" });
    await setup(page, m);
    await bootToDesktop(page);
    expect(v1(m).filter((r) => r.includes("/api/v1/onboarding"))).toEqual([]);
    await expect(page.locator("#subscription-gate-screen")).toHaveCount(0);
    await expect(win(page, "onboarding")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as Shell).FULCApps.ids())).toContain("pipeline");
  });

  test("subscription_ended: today's gate whatever onboarding says, and no /api/v1 call at all", async ({ page }) => {
    const m = mock({ access: "subscription_ended" });
    await gateFor(page, m);
    await expect(page.locator("#subscription-gate-heading")).toHaveText("Your subscription has ended");
    expect(v1(m)).toEqual([]);
  });

  test("no_subscription with every step done: today's gate after exactly one onboarding read", async ({ page }) => {
    const m = mock({ onboarding: [json(ONB.done)] });
    await gateFor(page, m);
    await expect(page.locator("#subscription-gate-heading")).toHaveText("Choose a plan to open your workspace");
    expect(v1(m)).toEqual(["GET /api/v1/onboarding"]);
  });

  const FAIL_CLOSED: [string, Reply, boolean][] = [
    ["a member (403 insufficient_role) gets the member copy", err(403, "insufficient_role"), false],
    ["a token (403 session_required)", err(403, "session_required"), true],
    ["a 401", err(401, "unauthorized"), true],
    ["a 500", err(500, "internal_error"), true],
    ["a network failure", "abort", true],
    ["a body that fails validation", json({ started_at: "x", steps: [] }), true],
    ["a body that is not JSON", { status: 200, text: "<html>" }, true],
    ["a read that never answers (five-second limit)", "hang", true],
  ];
  for (const [name, reply, admin] of FAIL_CLOSED) {
    test(`fails closed to the gate on ${name}`, async ({ page }) => {
      const m = mock({ onboarding: [reply], isAdmin: admin });
      await gateFor(page, m);
      await expect(page.locator("#subscription-gate-body")).toHaveText(
        admin ? "Your account doesn't have a subscription yet. A subscription unlocks your fulcrumaxe cloud workspace." : "Your account doesn't have a subscription yet. Ask an owner or admin of this account to choose a plan.",
      );
      expect(v1(m)).toEqual(["GET /api/v1/onboarding"]);
    });
  }
});

test.describe("onboarding mode: the desktop with four apps (criteria 2, 3)", () => {
  test("opens Onboarding on its own, focused, with no gate screen", async ({ page }) => {
    const m = mock();
    await setup(page, m);
    await bootToDesktop(page);
    await expect(page.locator("#subscription-gate-screen")).toHaveCount(0);
    await expect(win(page, "onboarding")).toBeVisible();
    await expect(win(page, "onboarding")).toHaveClass(/active/);
    await expect(ob(page).locator('[data-testid="ob-title"]')).toBeFocused();
  });

  test("the dock and the desktop icons offer exactly onboarding, model-key, repos and themes", async ({ page }) => {
    await setup(page, mock());
    await bootToDesktop(page);
    const ids = (sel: string) => page.locator(sel).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.appId).sort());
    expect(await ids(".dock-icon[data-app-id]")).toEqual(["model-key", "onboarding", "repos", "themes"]);
    expect((await ids(".desktop-icon[data-app-id]")).filter((id) => !["model-key", "onboarding", "repos", "themes"].includes(id!))).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as Shell).FULCApps.visible().map((a: { id: string }) => a.id).sort())).toEqual(["model-key", "onboarding", "repos", "themes"]);
  });

  test("Themes is offered before purchase: it opens from the dock, and a theme change applies and no request is refused", async ({ page }) => {
    const m = mock();
    await setup(page, m);
    const refused: string[] = [];
    page.on("response", (r) => { if (new URL(r.url()).pathname.startsWith("/api/") && r.status() >= 400) refused.push(`${r.status()} ${new URL(r.url()).pathname}`); });
    await bootToDesktop(page);
    await dock(page, "themes").click();
    const themes = win(page, "themes");
    await expect(themes).toBeVisible();
    const before = await page.evaluate(() => document.body.dataset.experience);
    const other = themes.locator(".theme-card").filter({ hasNot: page.locator(".theme-card-apply", { hasText: "Active" }) }).first();
    const next = await other.getAttribute("data-experience-id");
    expect(next).toBeTruthy();
    expect(next).not.toBe(before);
    await other.locator(".theme-card-apply").click();
    await page.waitForFunction((id) => document.body.dataset.experience === id, next);
    expect(refused).toEqual([]);
  });

  test("no other app opens: not from the console, not from the registry, not from the palette", async ({ page }) => {
    const m = mock();
    await setup(page, m);
    await bootToDesktop(page);
    const got = await page.evaluate((others) => {
      const w = window as unknown as Shell;
      others.forEach((id: string) => w.FULCWM.open(id, { x: 1 }));
      return { found: others.map((id: string) => w.FULCApps.get(id)), ids: w.FULCApps.ids().sort() };
    }, OTHERS);
    await page.clock.runFor(1000);
    expect(got.found).toEqual([null, null, null, null]);
    expect(got.ids).toEqual(["model-key", "onboarding", "repos", "themes"]);
    await expect(page.locator(OTHERS.map((id) => `.fulc-window[data-app-id="${id}"]`).join(", "))).toHaveCount(0);
    await page.keyboard.press("Control+k");
    await expect(page.locator("#command-palette")).toBeVisible();
    await page.locator("#command-palette-input").fill("pipeline");
    await expect(page.locator(".command-palette-item")).toHaveCount(0);
    await page.keyboard.press("Escape");
  });

  test("the launcher lists and can launch only the four apps, and the keyboard reaches no others", async ({ page }) => {
    await setup(page, mock());
    await bootToDesktop(page);
    const FOUR = ["model-key", "onboarding", "repos", "themes"];
    // Every launcher surface reads these catalogue filters.
    const lists = await page.evaluate(() => {
      const apps = (window as unknown as { FULCApps: Record<string, () => { id: string }[]> }).FULCApps;
      return [apps.all(), apps.visible(), apps.launchable()].map((l) => l.map((a) => a.id).sort());
    });
    expect(lists).toEqual([FOUR, FOUR, FOUR]);
    // Keyboard: focus each dock entry and press Enter, then try the palette shortcut for another app's name.
    for (const id of FOUR) {
      await dock(page, id).focus();
      await page.keyboard.press("Enter");
    }
    await page.keyboard.press("Control+k");
    await page.locator("#command-palette-input").fill("open pipeline");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    await page.clock.runFor(1000);
    const open = await page.locator(".fulc-window").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.appId).sort());
    expect(open).toEqual(FOUR);
  });

  test("the session calls only the four apps' own routes and the onboarding routes", async ({ page }) => {
    const m = mock();
    await setup(page, m);
    await bootToDesktop(page);
    await dock(page, "model-key").click();
    await expect(win(page, "model-key")).toBeVisible();
    await dock(page, "repos").click();
    await expect(win(page, "repos")).toBeVisible();
    // events is the shell's one live stream (the model-key and repos windows subscribe to it); no other app route is called.
    const allowed = /^(GET|POST|PUT|PATCH|DELETE) \/api\/v1\/(onboarding|onboarding\/preview|events|model-connection(\/[a-z-]+)?|repos|repos\/[^/]+\/settings|github\/install-url)$/;
    expect(v1(m).filter((r) => !allowed.test(r))).toEqual([]);
    expect(count(m, "GET /api/v1/onboarding")).toBeGreaterThan(0);
  });
});

test.describe("the step list (criteria 4, 5, 8, 11)", () => {
  test("six steps in the server's order, the first open one is current, finished ones show the server's time", async ({ page }) => {
    const m = mock({ onboarding: [json(ONB.step3)] });
    const problems = await setup(page, m);
    await bootToDesktop(page);
    const list = ob(page).locator('[data-testid="ob-app"] ol[aria-label="Setup steps"]');
    await expect(list.locator("li.ob-step")).toHaveCount(6);
    await expect(list.locator("> li > .ob-step-head > strong")).toHaveText(["Add your model key", "Install the GitHub App (read-only)", "Try a free preview", "Choose a plan", "Install the GitHub App (write)", "Get your first pull request"]);
    await expect(current(page)).toHaveCount(1);
    await expect(current(page)).toHaveAttribute("data-testid", "ob-step-preview");
    await expect(ob(page).locator('[data-testid="ob-step-model_key"] .ob-state')).toContainText("Done");
    await expect(ob(page).locator('[data-testid="ob-step-model_key"] time')).toHaveAttribute("datetime", ONB.step3.steps[0].completed_at);
    await expect(ob(page).locator('[data-testid="ob-step-first_pr"]')).toContainText("Your first pull request will show here");
    await expect(ob(page).locator('[data-testid="ob-step-preview"]')).not.toContainText("null"); // step 3 returns no button node
    const stored = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]));
    expect(stored).not.toMatch(/readonly_app|model_key|ob-step/);
    expect(problems).toEqual([]);
  });

  test("two devices on the same account show the same step, and both follow the server to the next", async ({ page, browser }) => {
    const m = mock();
    await setup(page, m);
    await bootToDesktop(page);
    const second = await browser.newContext(test.info().project.use as object);
    const page2 = await second.newPage();
    await setup(page2, m);
    await bootToDesktop(page2);
    for (const p of [page, page2]) await expect(current(p)).toHaveAttribute("data-testid", "ob-step-model_key");
    m.onboarding = [json(ONB.step3)];
    for (const p of [page, page2]) {
      await returnToOnboarding(p);
      await expect(current(p)).toHaveAttribute("data-testid", "ob-step-preview");
    }
    await second.close();
  });

  for (const [name, progress, step, app, button] of [
    ["step 1 opens the Model Key app", ONB.new, "model_key", "model-key", "Open Model Key"],
    ["step 2 opens Repos", doneUpTo(1), "readonly_app", "repos", "Open Repos"],
    ["step 5 opens Repos", doneUpTo(4), "write_app", "repos", "Open Repos"],
  ] as const) {
    test(`hand-off: ${name}, and coming back re-reads progress`, async ({ page }) => {
      const m = mock({ onboarding: [json(progress)] });
      await setup(page, m);
      await bootToDesktop(page);
      await expect(current(page)).toHaveAttribute("data-testid", "ob-step-" + step);
      await current(page).getByRole("button", { name: button }).click();
      await expect(win(page, app)).toBeVisible();
      m.onboarding = [json(doneUpTo(6))];
      await returnToOnboarding(page, app);
      await expect(ob(page).locator('[data-testid="ob-complete"]')).toHaveText("Setup is complete.");
    });
  }

  test("a read that fails says so and can be retried; a member's 403 gets its own sentence", async ({ page }) => {
    const m = mock();
    await setup(page, m);
    await bootToDesktop(page);
    m.onboarding = [err(403, "insufficient_role")];
    await returnToOnboarding(page);
    await expect(ob(page).locator('[data-testid="ob-error"]')).toContainText("Only owners and admins can see setup progress.");
    m.onboarding = [{ status: 500, json: {} }];
    await ob(page).locator('[data-testid="ob-retry"]').click();
    await expect(ob(page).locator('[data-testid="ob-error"]')).toContainText("Your setup progress couldn't be loaded.");
    m.onboarding = [json(ONB.step3)];
    await ob(page).locator('[data-testid="ob-retry"]').click();
    await expect(current(page)).toHaveAttribute("data-testid", "ob-step-preview");
    await expect(ob(page).locator('[data-testid="ob-error"]')).toBeEmpty();
  });
});

test.describe("step 3, the free preview (criterion 6)", () => {
  const start = (page: Page) => ob(page).locator('[data-testid="ob-preview-start"]');
  const msg = (page: Page) => ob(page).locator('[data-testid="ob-preview-msg"]');
  async function bootStep3(mo: Partial<Mock> = {}) {
    return mock({ onboarding: [json(ONB.step3)], ...mo });
  }

  test("lists only installed read-only repos, states the 20 dollar cap, and sends one keyed request", async ({ page }) => {
    const m = await bootStep3({ previewGet: [json(PV("200-none.json")), json(PV("200-running.json"))] });
    await setup(page, m);
    await bootToDesktop(page);
    await expect(ob(page).locator('[data-testid="ob-repo"] option')).toHaveText(["acme/widgets"]);
    await expect(ob(page).locator('[data-testid="ob-app"]')).toContainText("up to 20 US dollars of model usage");
    await start(page).click();
    await expect(ob(page).locator('[data-testid="ob-preview-state"]')).toContainText("working through your repository");
    expect(m.posts).toHaveLength(1);
    expect(m.posts[0].key).toMatch(UUID);
    expect(m.posts[0].body).toEqual({ repo_id: REPOS.data[0].id, confirm_model_cap_usd: 20 });
    expect(m.posts[0].ct).toContain("application/json");
  });

  test("a repo with no full name falls back to its product label in the picker", async ({ page }) => {
    const m = await bootStep3();
    await setup(page, m);
    const noName = { ...REPOS, data: [{ ...REPOS.data[0], full_name: null }] };
    await page.route((u) => u.pathname === "/api/v1/repos", (route) => route.fulfill({ json: noName }));
    await bootToDesktop(page);
    await expect(ob(page).locator('[data-testid="ob-repo"] option')).toHaveText(["web"]);
  });

  test("retrying the same intent after a lost request reuses its key",async ({ page }) => {
    const m = await bootStep3({ previewPost: ["abort", json(REQ("202-accepted.json"), 202)], previewGet: [json(PV("200-none.json")), json(PV("200-running.json"))] });
    await setup(page, m);
    await bootToDesktop(page);
    await start(page).click();
    await expect(msg(page)).toHaveText("The preview couldn't be started. Try again.");
    await start(page).click();
    await expect(ob(page).locator('[data-testid="ob-preview-state"]')).toContainText("working through your repository");
    expect(m.posts).toHaveLength(2);
    expect(m.posts[0].key).toMatch(UUID);
    expect(m.posts[1].key).toBe(m.posts[0].key);
  });

  test("a refused request is not retried under the same key", async ({ page }) => {
    const m = await bootStep3({ previewPost: [json(REQ("409-preview_capacity.json"), 409), json(REQ("202-accepted.json"), 202)] });
    await setup(page, m);
    await bootToDesktop(page);
    await start(page).click();
    await expect(msg(page)).toHaveText("Previews are busy right now. Try again later.");
    await start(page).click();
    await expect.poll(() => m.posts.length).toBe(2);
    expect(m.posts[1].key).toMatch(UUID);
    expect(m.posts[1].key).not.toBe(m.posts[0].key);
  });

  test("a 429 on Start counts down from Retry-After and keeps the button off until it ends", async ({ page }) => {
    const limited: Reply = { status: 429, json: { error: { code: "rate_limited", message: "SECRET-SERVICE-TEXT", request_id: "r" } }, headers: { "Retry-After": "3" } };
    const m = await bootStep3({ previewPost: [limited, json(REQ("202-accepted.json"), 202)], previewGet: [json(PV("200-none.json")), json(PV("200-running.json"))] });
    await setup(page, m);
    await bootToDesktop(page, { keepPaused: true }); // the countdown is page time: only the runFor calls below move it, however slow the machine is
    await start(page).click();
    await expect(msg(page)).toHaveText("Too many tries. Try again in 3 seconds.");
    await expect(start(page)).toBeDisabled();
    await page.clock.runFor(2_000);
    await expect(msg(page)).toHaveText("Too many tries. Try again in 1 second.");
    expect(m.posts).toHaveLength(1);
    await page.clock.runFor(1_000);
    await expect(start(page)).toBeEnabled();
    await expect(msg(page)).toHaveText("");
    await start(page).click();
    await expect(ob(page).locator('[data-testid="ob-preview-state"]')).toContainText("working through your repository");
    expect(m.posts).toHaveLength(2);
    expect(m.posts[1].key).not.toBe(m.posts[0].key); // a refused request is never retried under the same key
    expect(await ob(page).innerText()).not.toMatch(/SECRET-SERVICE-TEXT|undefined|NaN/);
  });

  test("every refusal gets a plain sentence of its own", async ({ page }) => {
    const m = await bootStep3();
    await setup(page, m);
    await bootToDesktop(page);
    const cases: [Reply, string][] = [
      [json(REQ("503-preview_unavailable.json"), 503), "A free preview isn't available yet."],
      [json(REQ("422-preview_cap_not_confirmed.json"), 422), "The preview couldn't be started. Try again."],
      [err(409, "preview_install_limit"), "A free preview can't be started for this account."],
      [json(REQ("409-model_key_required.json"), 409), "Add a model key first, then start the preview."],
    ];
    for (const [reply, text] of cases) {
      m.previewPost = [reply];
      await start(page).click();
      await expect(msg(page)).toHaveText(text);
    }
    await ob(page).locator('[data-testid="ob-open-model-key"]').click();
    await expect(win(page, "model-key")).toBeVisible();
    m.previewPost = [json(REQ("409-preview_exists.json"), 409)];
    m.previewGet = [json(PV("200-running.json"))];
    await returnToOnboarding(page, "model-key");
    await start(page).click();
    await expect(ob(page).locator('[data-testid="ob-preview-state"]')).toContainText("working through your repository");
    await expect(msg(page)).toHaveText("");
  });

  test("a finished preview shows its issues as plain text (an <img onerror> title is literal) and the step moves on", async ({ page }) => {
    const m = await bootStep3({ previewGet: [json(PV("200-none.json")), json(PV("200-running.json")), json(PV("200-finished.json"))] });
    const problems = await setup(page, m);
    await bootToDesktop(page);
    await start(page).click();
    await expect(ob(page).locator('[data-testid="ob-live"]')).toHaveText("Your preview is running.");
    m.onboarding = [json(ONB.pay)];
    await page.clock.runFor(3000);
    const result = ob(page).locator('[data-testid="ob-result"]');
    await expect(result).toContainText("#31 Add a dark theme <img src=x onerror=alert(1)>");
    await expect(result).toContainText("Expected cost: $3.20");
    await expect(result).toContainText("Acceptance: an empty config file loads the defaults");
    await expect(result.locator("img")).toHaveCount(0);
    await expect(ob(page).locator('[data-testid="ob-live"]')).toHaveText("Your preview has finished.");
    await expect(current(page)).toHaveAttribute("data-testid", "ob-step-pay");
    expect(problems).toEqual([]);
  });

  for (const [name, reply, testid, text] of [
    ["finished with no result", PV("200-finished-no-result.json"), "ob-preview-failed", "Your preview couldn't finish"],
    ["void", PV("200-void.json"), "ob-preview-failed", "Your preview couldn't finish"],
    ["finished with unusable output", { ...PV("200-finished.json"), preview: { ...PV("200-finished.json").preview, result: { error: "invalid_output" } } }, "ob-outcome", "The preview finished, but its output couldn't be shown."],
  ] as const) {
    test(`an earlier preview that is ${name} is said so in plain text`, async ({ page }) => {
      const m = await bootStep3({ previewGet: [json(reply)] });
      await setup(page, m);
      await bootToDesktop(page);
      await expect(ob(page).locator(`[data-testid="${testid}"]`)).toHaveText(text);
      await expect(start(page)).toBeHidden();
    });
  }

  test("a run that succeeded with no issues says the agent found none it could read, and still shows the sample spec as plain text", async ({ page }) => {
    const done = PV("200-finished.json");
    const empty = { ...done, preview: { ...done.preview, result: { issues: [], sample_spec: { issue_number: null, body: "Plan: <b>read the README</b> <img src=x onerror=alert(1)>" } } } };
    const m = await bootStep3({ previewGet: [json(empty)] });
    const problems = await setup(page, m);
    await bootToDesktop(page);
    const result = ob(page).locator('[data-testid="ob-result"]');
    await expect(result.locator('[data-testid="ob-no-issues"]')).toContainText("The agent found no open issues it could read");
    await expect(result.locator('[data-testid="ob-issues"]')).toHaveCount(0);
    await expect(result.locator("pre.ob-spec")).toHaveText("Plan: <b>read the README</b> <img src=x onerror=alert(1)>");
    await expect(result.locator("b, img")).toHaveCount(0);
    expect(await ob(page).innerText()).not.toMatch(/\b(null|undefined|nan)\b/i);
    expect(problems).toEqual([]);
  });

  test("a run that succeeded with no issues and no spec still explains itself", async ({ page }) => {
    const done = PV("200-finished.json");
    await setup(page, await bootStep3({ previewGet: [json({ ...done, preview: { ...done.preview, result: { issues: [], sample_spec: null } } })] }));
    await bootToDesktop(page);
    await expect(ob(page).locator('[data-testid="ob-no-issues"]')).toBeVisible();
    await expect(ob(page).locator("pre.ob-spec")).toHaveCount(0);
  });

  test("a failed preview run is shown as failed with retry guidance, and the flow stays on step 3", async ({ page }) => {
    const m = await bootStep3({ previewGet: [json(PV("200-none.json")), json(PV("200-running.json")), json(PV("200-finished-no-result.json"))] });
    await setup(page, m);
    await bootToDesktop(page);
    await start(page).click();
    await page.clock.runFor(3000);
    await expect(ob(page).locator('[data-testid="ob-preview-failed"]')).toHaveText("Your preview couldn't finish");
    await expect(ob(page).locator('[data-testid="ob-preview-retry"]')).toContainText("can't be started again");
    await expect(ob(page).locator('[data-testid="ob-live"]')).toHaveText("Your preview stopped.");
    await expect(ob(page).locator('[data-testid="ob-result"]')).toHaveCount(0);
    await expect(current(page)).toHaveAttribute("data-testid", "ob-step-preview");
  });

  test("a failed run that handed the free preview back offers Start again", async ({ page }) => {
    const base = PV("200-agent-never-started.json");
    await setup(page, await bootStep3({ previewGet: [json({ ...base, progress: { ...base.progress, slot_freed: true } })] }));
    await bootToDesktop(page);
    await expect(ob(page).locator('[data-testid="ob-preview-retry"]')).toHaveText("You can start the preview again.");
    await expect(start(page)).toBeVisible();
    await expect(current(page)).toHaveAttribute("data-testid", "ob-step-preview");
  });

  test("a read that always fails is retried only a bounded number of times, then says it couldn't load", async ({ page }) => {
    test.setTimeout(240_000); // eighty stepped reads
    const m = await bootStep3({ previewGet: [json(PV("200-none.json")), err(500, "internal_error")] });
    await setup(page, m);
    await bootToDesktop(page, { keepPaused: true, beforeGoto: countPollTimers }); // the clock stands still between steps, so a count is a count
    await start(page).click();
    const reads = () => count(m, "GET /api/v1/onboarding/preview");
    await expect.poll(reads).toBe(2);
    await untilPollTimers(page, 1); // the failed read has been handled and the first retry is armed
    // Three seconds apart for the first forty reads, then fifteen seconds apart, and eighty in all.
    for (let i = 1; i <= 39; i++) {
      await stepAndSettle(page, 3000);
      expect(reads()).toBe(i + 2);
    }
    for (let j = 1; j <= 40; j++) {
      await stepAndSettle(page, 15_000, j === 40); // the eightieth read arms nothing
      if (j < 40) expect(reads()).toBe(41 + j);
    }
    await expect(msg(page)).toHaveText("The preview couldn't be loaded. Reopen this window to try again.");
    const total = reads();
    await page.clock.runFor(60_000);
    expect(reads()).toBe(total);
    expect(total).toBeLessThanOrEqual(82);
  });

  test("polling is bounded, and stops when the window closes", async ({ page }) => {
    test.setTimeout(240_000);
    const m = await bootStep3({ previewGet: [json(PV("200-running.json"))] });
    await setup(page, m);
    await bootToDesktop(page, { keepPaused: true, beforeGoto: countPollTimers });
    const reads = () => count(m, "GET /api/v1/onboarding/preview");
    await untilPollTimers(page, 1); // the first read has been answered and handled, and the next is armed
    for (let i = 1; i <= 40; i++) {
      await stepAndSettle(page, 3000); // the answer is handled and the next timer set before the clock moves again
      expect(reads()).toBe(i + 1);
    }
    for (let j = 1; j <= 40; j++) {
      await stepAndSettle(page, 15_000, j === 40); // the eightieth read arms nothing
      if (j < 40) expect(reads()).toBe(41 + j);
    }
    await expect(ob(page).locator('[data-testid="ob-preview-msg"]')).toContainText("taking longer than usual");
    expect(reads()).toBe(81);
    // A fresh window polls again; closing it ends the timer.
    await page.evaluate(() => (window as unknown as Shell).FULCWM.close("onboarding"));
    await page.evaluate(() => (window as unknown as Shell).FULCWM.open("onboarding"));
    await expect.poll(reads).toBe(82);
    await page.evaluate(() => (window as unknown as Shell).FULCWM.close("onboarding"));
    await page.clock.runFor(30_000);
    expect(reads()).toBe(82);
  });
});

test.describe("step 4, pay (criterion 7)", () => {
  test("shows the gate's own plan picker; the owner's Subscribe sends the same checkout request", async ({ page }) => {
    const m = mock({ onboarding: [json(ONB.pay)] });
    await setup(page, m);
    await bootToDesktop(page);
    const step = ob(page).locator('[data-testid="ob-step-pay"]');
    await expect(step).toContainText("A subscription unlocks your fulcrumaxe cloud workspace.");
    await expect(step).not.toContainText("null"); // step 4 returns no button node
    await expect(ob(page).locator('[data-testid="ob-app"] ol')).not.toContainText("null");
    await expect(step.locator(".subscription-gate-plan")).toHaveCount(3);
    await step.locator('[data-plan="team"] .subscription-gate-subscribe').click();
    await page.waitForURL(/checkout\.stripe\.com/);
    expect(m.checkouts).toEqual([{ plan: "team", success_path: "/", cancel_path: "/" }]);
  });

  for (const [name, o, plans, subscribe, ask] of [
    ["an admin who is not the owner sees the plans and Ask an owner", { isOwner: false }, 3, 0, 3],
    ["a partner-billed account sees no plan list at all", { partner: true }, 0, 0, 0],
  ] as const) {
    test(name, async ({ page }) => {
      const m = mock({ onboarding: [json(ONB.pay)], ...o });
      await setup(page, m);
      await bootToDesktop(page);
      const step = ob(page).locator('[data-testid="ob-step-pay"]');
      await expect(step.locator(".subscription-gate-plan")).toHaveCount(plans);
      await expect(step.locator(".subscription-gate-subscribe")).toHaveCount(subscribe);
      await expect(step.locator(".subscription-gate-ask")).toHaveCount(ask);
    });
  }
});

test.describe("steps 1 to 5 end to end, and accessibility (criteria 10, 11)", () => {
  test("a fixture account walks steps 1 to 5; every control is 44 px and nothing scrolls sideways", async ({ page }, info) => {
    const phone = info.project.name === "phone";
    const m = mock({ previewGet: [json(PV("200-none.json")), json(PV("200-finished.json"))] });
    await setup(page, m);
    await bootToDesktop(page);
    const check = async () => {
      // Measure the settled window, not one still scaling in.
      await ob(page).evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      for (const box of await ob(page).locator('[data-testid="ob-app"] button:visible, [data-testid="ob-app"] select:visible').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()))) {
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.width).toBeGreaterThanOrEqual(44);
      }
      if (phone) {
        // Full-window: the shell maximises it, and it spans the viewport apart from the window's own 1 px border.
        await expect(win(page, "onboarding")).toHaveClass(/maximized/);
        expect((await win(page, "onboarding").boundingBox())!.width).toBeGreaterThanOrEqual(page.viewportSize()!.width - 4);
      }
    };
    await check();
    await ob(page).getByRole("button", { name: "Open Model Key" }).click();
    await expect(win(page, "model-key")).toBeVisible();
    if (phone) await expect(win(page, "onboarding")).toBeHidden();
    m.onboarding = [json(doneUpTo(1))];
    await returnToOnboarding(page, "model-key");
    await expect(current(page)).toHaveAttribute("data-testid", "ob-step-readonly_app");
    await check();
    await ob(page).getByRole("button", { name: "Open Repos" }).click();
    await expect(win(page, "repos")).toBeVisible();
    m.onboarding = [json(ONB.step3)];
    await returnToOnboarding(page, "repos");
    await expect(current(page)).toHaveAttribute("data-testid", "ob-step-preview");
    await check();
    m.onboarding = [json(ONB.pay)];
    await ob(page).locator('[data-testid="ob-preview-start"]').click();
    await expect(ob(page).locator('[data-testid="ob-result"]')).toBeVisible();
    await expect(current(page)).toHaveAttribute("data-testid", "ob-step-pay");
    await expect(ob(page).locator(".subscription-gate-subscribe")).toHaveCount(3);
    await check();
    m.onboarding = [json(doneUpTo(4))];
    await returnToOnboarding(page, "model-key");
    await expect(current(page)).toHaveAttribute("data-testid", "ob-step-write_app");
    await check();
    expect(m.posts).toHaveLength(1);
  });

  test("axe finds nothing serious in the Onboarding window or the onboarding-mode desktop", async ({ page }) => {
    await setup(page, mock({ onboarding: [json(ONB.step3)], previewGet: [json(PV("200-finished.json"))] }));
    await bootToDesktop(page);
    await expect(ob(page).locator('[data-testid="ob-result"]')).toBeVisible();
    for (const scope of ['[data-testid="ob-app"]', "#desktop-screen"]) {
      const res = await new AxeBuilder({ page }).include(scope).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
      expect(res.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${scope} ${v.impact} ${v.id}`)).toEqual([]);
    }
    await expect(ob(page).locator('[data-testid="ob-live"]')).toHaveAttribute("aria-live", "polite");
  });
});

// A missing or null field must never become the visible words "null" or "undefined" (or "NaN") anywhere in the window.
test.describe("no placeholder words in the Onboarding window", () => {
  const PLACEHOLDER = /\b(null|undefined|nan)\b/i;
  const finished = (issues: unknown, spec: unknown) => json({ preview: { ...PV("200-finished.json").preview, result: { issues, sample_spec: spec } } });
  const step3 = (o: Partial<Mock> = {}): Partial<Mock> => ({ onboarding: [json(ONB.step3)], ...o });
  const RESULT = '[data-testid="ob-result"]';
  const cases: [string, Partial<Mock>, string][] = [
    ["a new account with no repos", { repos: { data: [], next_cursor: null } }, '[data-testid="ob-step-model_key"]'],
    ["a new account with repos", {}, '[data-testid="ob-step-model_key"]'],
    ["a new account whose preview read is unavailable (503)", { previewGet: [err(503, "preview_unavailable")] }, '[data-testid="ob-step-model_key"]'],
    ["step 3 with no repos", step3({ repos: { data: [], next_cursor: null } }), '[data-testid="ob-preview-open-repos"]'],
    ["step 3 with a repo", step3(), '[data-testid="ob-preview-start"]'],
    ["step 3 whose preview read is unavailable (503)", step3({ previewGet: [err(503, "preview_unavailable")] }), '[data-testid="ob-preview-msg"]:text("couldn")'],
    ["step 3 with a finished preview", step3({ previewGet: [json(PV("200-finished.json"))] }), RESULT],
    ["a finished preview whose issue fields are null", step3({ previewGet: [finished([{ number: null, title: null, category: null, expected_model_usd: null }], { issue_number: null, body: null })] }), RESULT],
    ["a finished preview whose issue fields are missing", step3({ previewGet: [finished([{}, { number: 5 }, { title: "Only a title" }, null], {})] }), RESULT],
    ["a finished preview with no issues list and no spec", step3({ previewGet: [finished(null, null)] }), RESULT],
    ["step 4 with the plan list", { onboarding: [json(ONB.pay)] }, ".subscription-gate-plan"],
    ["step 4 with plans that lack their limits", { onboarding: [json(ONB.pay)], plans: [{ id: "starter", price_usd_month: 129 }, { id: "scale", price_usd_month: 1299, repo_limit: null }] }, ".subscription-gate-plan"],
  ];
  for (const [name, o, ready] of cases) {
    test(name, async ({ page }) => {
      const m = mock(o);
      await setup(page, m);
      await bootToDesktop(page);
      await expect(ob(page).locator(ready).first()).toBeVisible();
      expect(await ob(page).innerText()).not.toMatch(PLACEHOLDER);
      expect(await ob(page).locator('[data-testid="ob-live"]').textContent()).not.toMatch(PLACEHOLDER);
    });
  }

  test("a start refused with 503 preview_unavailable says so in words", async ({ page }) => {
    const m = mock(step3({ previewPost: [err(503, "preview_unavailable")] }));
    await setup(page, m);
    await bootToDesktop(page);
    await ob(page).locator('[data-testid="ob-preview-start"]').click();
    await expect(ob(page).locator('[data-testid="ob-preview-msg"]')).toHaveText("A free preview isn't available yet.");
    expect(await ob(page).innerText()).not.toMatch(PLACEHOLDER);
  });
});

// ONBOARDING-PAY-ANYTIME: choosing a plan is possible from the first screen, and the preview is optional, never a gate.
test.describe("pay at any step, and the skipped preview", () => {
  const SKIPPED = fx("getOnboarding", "200-skipped.json");
  /** The server's answer for a paid account: `done` names the steps that are done; the preview is skipped unless it has a time. */
  const paid = (done: string[] = [], previewTime: string | null = null) => ({
    ...SKIPPED,
    steps: SKIPPED.steps.map((s: { step: string; completed_at: string | null; skipped: boolean }) => {
      if (s.step === "preview") return previewTime ? { ...s, completed_at: previewTime, skipped: false } : s;
      return done.includes(s.step) ? { ...s, completed_at: "2026-09-20T09:30:00.000Z" } : s;
    }),
  });
  const ahead = (page: Page) => ob(page).locator('[data-testid="ob-skip-ahead"]');
  const skipPreview = (page: Page) => ob(page).locator('[data-testid="ob-skip-preview"]');
  const picker = (page: Page) => ob(page).locator('[data-testid="ob-step-pay"] .subscription-gate-plan');
  const subscribe = (page: Page) => ob(page).locator('[data-testid="ob-step-pay"] [data-plan="team"] .subscription-gate-subscribe');
  const start = (page: Page) => ob(page).locator('[data-testid="ob-preview-start"]');
  const skippedMark = (page: Page) => ob(page).locator('[data-testid="ob-step-preview"] [data-testid="ob-skipped"]');
  const PLACEHOLDER = /\b(null|undefined|nan)\b/i;

  test("pay from step 1: the first screen offers a plan, under step 4, and Subscribe sends the same checkout request", async ({ page }) => {
    const m = mock();
    const problems = await setup(page, m);
    await bootToDesktop(page);
    await expect(current(page)).toHaveAttribute("data-testid", "ob-step-model_key");
    await expect(ahead(page)).toHaveText("Skip ahead: choose a plan");
    const box = (await ahead(page).boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
    await expect(picker(page)).toHaveCount(0);
    await ahead(page).click();
    await expect(picker(page)).toHaveCount(3);
    await expect(ahead(page)).toHaveCount(0); // the picker is open: no second way in
    await expect(current(page)).toHaveAttribute("data-testid", "ob-step-model_key"); // nothing else moved
    await subscribe(page).click();
    await page.waitForURL(/checkout\.stripe\.com/);
    expect(m.checkouts).toEqual([{ plan: "team", success_path: "/", cancel_path: "/" }]);
    expect(m.posts).toEqual([]); // no preview was started to get here
    expect(count(m, "GET /api/v1/onboarding/preview")).toBe(0); // step 3's panel was never mounted
    expect(problems).toEqual([]);
  });

  test("pay from step 2: the same action is on screen, and the app hand-off is still there", async ({ page }) => {
    await setup(page, mock({ onboarding: [json(doneUpTo(1))] }));
    await bootToDesktop(page);
    await expect(current(page)).toHaveAttribute("data-testid", "ob-step-readonly_app");
    await expect(current(page).getByRole("button", { name: "Open Repos" })).toBeVisible();
    await ahead(page).click();
    await expect(picker(page)).toHaveCount(3);
    await expect(current(page)).toHaveAttribute("data-testid", "ob-step-readonly_app");
  });

  test("skip from step 3: the preview step has its own wording, the picker opens, and the preview stays startable", async ({ page }) => {
    const m = mock({ onboarding: [json(ONB.step3)] });
    await setup(page, m);
    await bootToDesktop(page);
    await expect(current(page)).toHaveAttribute("data-testid", "ob-step-preview");
    await expect(skipPreview(page)).toHaveText("Skip the preview and choose a plan");
    await expect(ob(page).locator('[data-testid="ob-step-preview"] [data-testid="ob-skip-preview"]')).toHaveCount(1);
    await skipPreview(page).click();
    await expect(picker(page)).toHaveCount(3);
    await expect(skipPreview(page)).toHaveCount(0);
    await expect(ahead(page)).toHaveCount(0);
    await expect(start(page)).toBeVisible(); // an unpaid user still gets the free preview
    await subscribe(page).click();
    await page.waitForURL(/checkout\.stripe\.com/);
    expect(m.checkouts).toEqual([{ plan: "team", success_path: "/", cancel_path: "/" }]);
    expect(m.posts).toEqual([]);
  });

  test("when pay is the current step there is no skip action, only the picker", async ({ page }) => {
    await setup(page, mock({ onboarding: [json(ONB.pay)] }));
    await bootToDesktop(page);
    await expect(picker(page)).toHaveCount(3);
    await expect(ahead(page)).toHaveCount(0);
    await expect(skipPreview(page)).toHaveCount(0);
  });

  test("paid without a preview, key and app still to do: Skipped, no Start, no plan action, current is step 1", async ({ page }) => {
    const m = mock({ onboarding: [json(ONB.new)] });
    await setup(page, m);
    await bootToDesktop(page);
    await ahead(page).click();
    await expect(picker(page)).toHaveCount(3);
    m.onboarding = [json(paid())];
    await returnToOnboarding(page);
    await expect(skippedMark(page)).toHaveText("Skipped");
    await expect(ob(page).locator('[data-testid="ob-step-preview"]')).not.toHaveClass(/ob-current/);
    await expect(start(page)).toHaveCount(0);
    await expect(ahead(page)).toHaveCount(0);
    await expect(picker(page)).toHaveCount(0); // paid: the picker is gone
    await expect(current(page)).toHaveAttribute("data-testid", "ob-step-model_key");
    await expect(ob(page).locator('[data-testid="ob-step-pay"]')).toContainText("Done");
    expect(await ob(page).innerText()).not.toMatch(PLACEHOLDER);
  });

  test("paid, key and read-only app done: the skipped preview never blocks the write app (step 5 is current)", async ({ page }) => {
    const m = mock({ onboarding: [json(paid(["model_key", "readonly_app"]))] });
    await setup(page, m);
    await bootToDesktop(page);
    await expect(skippedMark(page)).toHaveText("Skipped");
    await expect(current(page)).toHaveAttribute("data-testid", "ob-step-write_app");
    await expect(current(page).getByRole("button", { name: "Open Repos" })).toBeVisible();
    expect(count(m, "GET /api/v1/onboarding/preview")).toBe(0);
  });

  test("paid after a preview ran: it keeps its real time and shows Done, never Skipped", async ({ page }) => {
    await setup(page, mock({ onboarding: [json(paid(["model_key", "readonly_app"], "2026-09-20T09:40:00.000Z"))] }));
    await bootToDesktop(page);
    const step = ob(page).locator('[data-testid="ob-step-preview"]');
    await expect(step).toContainText("Done");
    await expect(step.locator("time")).toHaveAttribute("datetime", "2026-09-20T09:40:00.000Z");
    await expect(skippedMark(page)).toHaveCount(0);
    await expect(start(page)).toHaveCount(0);
  });

  test("paid, then the key is removed: step 1 is current again and the preview stays Skipped", async ({ page }) => {
    const m = mock({ onboarding: [json(paid(["model_key", "readonly_app"]))] });
    await setup(page, m);
    await bootToDesktop(page);
    await expect(current(page)).toHaveAttribute("data-testid", "ob-step-write_app");
    m.onboarding = [json(paid(["readonly_app"]))];
    await returnToOnboarding(page, "model-key");
    await expect(current(page)).toHaveAttribute("data-testid", "ob-step-model_key");
    await expect(current(page).getByRole("button", { name: "Open Model Key" })).toBeVisible();
    await expect(skippedMark(page)).toHaveText("Skipped");
    await expect(start(page)).toHaveCount(0);
  });

  test("paid, then the read-only app is uninstalled: step 2 is current again and the preview stays Skipped", async ({ page }) => {
    const m = mock({ onboarding: [json(paid(["model_key", "readonly_app"]))] });
    await setup(page, m);
    await bootToDesktop(page);
    m.onboarding = [json(paid(["model_key"]))];
    await returnToOnboarding(page);
    await expect(current(page)).toHaveAttribute("data-testid", "ob-step-readonly_app");
    await expect(skippedMark(page)).toHaveText("Skipped");
    await expect(start(page)).toHaveCount(0);
    expect(await ob(page).innerText()).not.toMatch(PLACEHOLDER);
  });

  test("paying while step 3 shows an unstarted preview removes its Start button", async ({ page }) => {
    const m = mock({ onboarding: [json(ONB.step3)] });
    await setup(page, m);
    await bootToDesktop(page);
    await expect(start(page)).toBeVisible();
    m.onboarding = [json(paid(["model_key", "readonly_app"]))];
    await returnToOnboarding(page);
    await expect(skippedMark(page)).toHaveText("Skipped");
    await expect(start(page)).toHaveCount(0);
    await expect(ob(page).locator('[data-testid="ob-repo"]')).toHaveCount(0);
  });

  test("paying while a preview is running: Skipped with no Start, the run is still shown, and its real result turns the step Done", async ({ page }) => {
    const m = mock({ onboarding: [json(ONB.step3)], previewGet: [json(PV("200-none.json")), json(PV("200-running.json")), json(PV("200-running.json")), json(PV("200-finished.json"))] });
    await setup(page, m);
    await bootToDesktop(page);
    await start(page).click();
    await expect(ob(page).locator('[data-testid="ob-preview-state"]')).toContainText("working through your repository");
    m.onboarding = [json(paid(["model_key", "readonly_app"]))]; // the plan is paid while the run is going
    await returnToOnboarding(page);
    const step = ob(page).locator('[data-testid="ob-step-preview"]');
    await expect(skippedMark(page)).toHaveText("Skipped");
    await expect(start(page)).toBeHidden(); // the panel is kept for the run, and with a run there is nothing to start
    await expect(step).toContainText("working through your repository");
    m.onboarding = [json(paid(["model_key", "readonly_app"], "2026-09-20T09:55:00.000Z"))];
    await page.clock.runFor(9000);
    await expect(step.locator("time")).toHaveAttribute("datetime", "2026-09-20T09:55:00.000Z");
    await expect(skippedMark(page)).toHaveCount(0);
    await expect(step.locator('[data-testid="ob-result"]')).toBeVisible();
    expect(await ob(page).innerText()).not.toMatch(PLACEHOLDER);
  });

  test("a skipped preview alone does not hold a lapsed account in onboarding mode: it gets the gate", async ({ page }) => {
    await setup(page, mock({ onboarding: [json(paid(["model_key", "readonly_app", "write_app", "first_pr"]))] }));
    await page.goto("/");
    await expect(page.locator("#subscription-gate-screen")).toBeVisible({ timeout: 20_000 });
    await expect(win(page, "onboarding")).toHaveCount(0);
  });
});

// PREVIEW-LIVE-PROGRESS: the free preview's live panel. Every screen below is a fixture of the contract (getOnboardingPreview).
test.describe("step 3, live progress", () => {
  const PLACEHOLDER = /\b(null|undefined|nan)\b/i;
  /** Words that would call our compute free. The panel's compute line must never match. */
  const FREE = /\b(free|no charge|no cost|at no cost|zero cost|complimentary)\b/i;
  const SKIPPED = fx("getOnboarding", "200-skipped.json");
  const state = (page: Page) => ob(page).locator('[data-testid="ob-preview-state"]');
  const stageStates = (page: Page) =>
    ob(page).locator('[data-testid="ob-stages"] > li').evaluateAll((els) => els.map((e) => `${(e as HTMLElement).dataset.testid!.replace("ob-stage-", "")}:${(e as HTMLElement).dataset.status}`));
  async function boot(page: Page, reply: unknown, extra: Partial<Mock> = {}) {
    const m = mock({ onboarding: [json(ONB.step3)], previewGet: [json(reply)], ...extra });
    const problems = await setup(page, m);
    await bootToDesktop(page);
    return { m, problems };
  }
  const computeLine = (page: Page) => ob(page).locator('[data-testid="ob-numbers"] li').nth(1);

  test("a running preview shows the timeline from what the run recorded, the feed, and the numbers", async ({ page }) => {
    const { problems } = await boot(page, PV("200-running.json"));
    await expect(state(page).locator('[data-testid="ob-outcome"]')).toHaveText("The agent is working through your repository.");
    expect(await stageStates(page)).toEqual(["queued:done", "sandbox:done", "clone:done", "read:done", "plan:active", "write:pending", "done:pending"]);
    await expect(ob(page).locator('[data-testid="ob-stage-clone"]')).toContainText("Cloning acme/widgets");
    await expect(ob(page).locator('[data-testid="ob-stage-plan"]')).toContainText("in progress"); // said in words, not by colour alone
    await expect(ob(page).locator('[data-testid="ob-feed"] li')).toHaveText([
      "The run started", "Repository cloned", "Reading README.md", "Reading src/server.ts", "Searching for 'login'", "Looking through packages/api", "Running the tests", "The agent sent its first message",
    ]);
    const numbers = ob(page).locator('[data-testid="ob-numbers"] li');
    await expect(numbers.nth(0)).toHaveText("Files read: 2");
    await expect(numbers.nth(1)).toContainText("about $0.0047");
    await expect(numbers.nth(1)).toContainText("our cost");
    await expect(numbers.nth(2)).toHaveText("Model usage: none recorded yet, on your Vercel AI Gateway key");
    expect(await computeLine(page).innerText()).not.toMatch(FREE);
    expect(await ob(page).innerText()).not.toMatch(PLACEHOLDER);
    expect(problems).toEqual([]);
  });

  test("the timer counts from the server's elapsed figure; the stages move only when the answer says so", async ({ page }) => {
    const later = { ...PV("200-running.json"), progress: { ...PV("200-running.json").progress, elapsed_seconds: 200 } };
    await boot(page, PV("200-running.json"), { previewGet: [json(PV("200-running.json")), json(later)] });
    const timer = ob(page).locator('[data-testid="ob-timer"]');
    await expect(timer).toHaveText("3:00");
    const before = await stageStates(page);
    await page.clock.runFor(2000);
    await expect(timer).toHaveText("3:02"); // ticking on its own between answers
    await page.clock.runFor(1000); // the next answer arrives and the figure follows the server's
    await expect(timer).toHaveText(/^3:2[0-1]$/);
    await page.clock.runFor(40_000); // a long wait later, the same answers: the same stages (nothing advances on a timer)
    expect(await stageStates(page)).toEqual(before);
  });

  // [fixture, outcome, headline, the stage marked stopped (or ""), extra words that must be on screen]
  const SCREENS: [string, string, string, string, string[]][] = [
    ["200-queued.json", "queued", "Your preview is queued. It starts as soon as a secure sandbox is ready.", "", []],
    ["200-starting.json", "starting", "Starting a secure sandbox for your repository.", "", []],
    ["200-slow.json", "running", "The agent is working through your repository.", "", ["This is taking longer than usual. It is still running"]],
    ["200-finished-no-result.json", "failed", "Your preview couldn't finish", "read", []],
    ["200-cancelled.json", "cancelled", "Your preview was cancelled before it finished.", "read", []],
    ["200-sandbox-stopped.json", "sandbox_stopped", "The secure sandbox stopped before the agent finished. Nothing you did caused it.", "read", []],
    ["200-agent-never-started.json", "agent_never_started", "This didn't start on our side. Your free preview isn't used up; try again.", "sandbox", ["The agent didn't start in time."]],
    ["200-void.json", "void", "Your preview couldn't finish", "queued", ["Previews aren't available right now."]],
  ];
  for (const [file, outcome, headline, stopped, words] of SCREENS) {
    test(`the ${outcome} screen (${file}) says what happened, marks the stage, and shows no placeholder or overflow`, async ({ page }) => {
      await boot(page, PV(file));
      const view = ob(page).locator('[data-testid="ob-progress"]');
      await expect(view).toHaveAttribute("data-outcome", outcome);
      await expect(view.locator("p.ob-headline")).toHaveText(headline);
      const states = await stageStates(page);
      expect(states.filter((s) => s.endsWith(":failed")).map((s) => s.split(":")[0])).toEqual(stopped ? [stopped] : []);
      if (stopped) await expect(ob(page).locator(`[data-testid="ob-stage-${stopped}"]`)).toContainText("stopped here");
      for (const w of words) await expect(state(page)).toContainText(w);
      await expect(ob(page).locator('[data-testid="ob-slow"]')).toHaveCount(file === "200-slow.json" ? 1 : 0);
      // a preview voided before it had a run has no end to measure to, so no timer
      if (outcome === "void") await expect(ob(page).locator('[data-testid="ob-timer"]')).toHaveCount(0);
      else await expect(ob(page).locator('[data-testid="ob-timer"]')).toHaveText(/^\d+:\d\d$/);
      // the honest "used up" line is for a failure after the agent started or a cancel, never for one that was ours before it started
      const usedUp = ["failed", "cancelled", "sandbox_stopped"].includes(outcome);
      await expect(state(page).getByText("This free preview is used up.")).toHaveCount(usedUp ? 1 : 0);
      expect(await computeLine(page).innerText()).not.toMatch(FREE);
      expect(await ob(page).innerText()).not.toMatch(PLACEHOLDER);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      // Start comes back only when the failure was ours before the agent started (the free preview is not used up)
      if (outcome !== "agent_never_started") await expect(ob(page).locator('[data-testid="ob-preview-start"]')).toBeHidden();
    });
  }

  test("a start timeout on our side frees the free preview: Start is offered again and a new run replaces the screen", async ({ page }) => {
    const m = mock({ onboarding: [json(ONB.step3)], previewGet: [json(PV("200-agent-never-started.json")), json(PV("200-running.json"))] });
    await setup(page, m);
    await bootToDesktop(page);
    await expect(ob(page).locator('[data-testid="ob-progress"]')).toHaveAttribute("data-outcome", "agent_never_started");
    const startBtn = ob(page).locator('[data-testid="ob-preview-start"]');
    await expect(startBtn).toBeVisible();
    await startBtn.click();
    expect(m.posts).toHaveLength(1);
    await expect(ob(page).locator('[data-testid="ob-progress"]')).toHaveAttribute("data-outcome", "running");
    await expect(startBtn).toBeHidden();
  });

  test("a start timeout over the daily free-slot bound reads as used up: the panel never claims a slot the row did not hand back", async ({ page }) => {
    const base = PV("200-agent-never-started.json");
    const notFreed = { ...base, preview: { ...base.preview, state: "finished", void_reason: null }, progress: { ...base.progress, slot_freed: false } };
    await boot(page, notFreed);
    await expect(ob(page).locator("p.ob-headline")).toHaveText("The agent never started in the sandbox. This free preview is used up.");
    await expect(ob(page).locator('[data-testid="ob-preview-start"]')).toBeHidden();
    await expect(state(page)).not.toContainText("isn't used up");
  });

  test("a repository that is too large says so and does not claim the free preview is unused", async ({ page }) => {
    const base = PV("200-finished-no-result.json");
    await boot(page, { ...base, progress: { ...base.progress, reason: "clone_too_large" } });
    await expect(state(page)).toContainText("This repository is too large for a free preview (over 200 MB).");
    await expect(state(page)).toContainText("This free preview is used up.");
    await expect(ob(page).locator('[data-testid="ob-preview-start"]')).toBeHidden();
  });

  test("a failure after the agent started leaves no Start: that preview is used up", async ({ page }) => {
    await boot(page, PV("200-finished-no-result.json"));
    await expect(ob(page).locator('[data-testid="ob-preview-start"]')).toBeHidden();
    await expect(state(page)).toContainText("This free preview is used up.");
  });

  test("finished: the result is the payoff, the numbers are final, and an unpaid account is offered the plan picker", async ({ page }) => {
    await boot(page, PV("200-finished.json"));
    await expect(ob(page).locator('[data-testid="ob-result"]')).toContainText("#12 Crash when the config file is empty");
    expect(await stageStates(page)).toEqual(["queued", "sandbox", "clone", "read", "plan", "write", "done"].map((id) => `${id}:done`));
    await expect(ob(page).locator('[data-testid="ob-timer"]')).toHaveText("9:00");
    await expect(computeLine(page)).toContainText("$0.02, recorded");
    await expect(ob(page).locator('[data-testid="ob-numbers"] li').nth(2)).toHaveText("Model usage: $0.42 on your Vercel AI Gateway key");
    expect(await computeLine(page).innerText()).not.toMatch(FREE);
    const choose = ob(page).locator('[data-testid="ob-choose-plan"]');
    await expect(choose).toHaveText("Choose a plan");
    expect((await choose.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await choose.click();
    await expect(ob(page).locator('[data-testid="ob-pay-panel"] .subscription-gate-plan')).toHaveCount(3);
    expect(await ob(page).innerText()).not.toMatch(PLACEHOLDER);
  });

  test("an operator account sees its model usage as the operator subscription, never a dollar figure or a customer key", async ({ page }) => {
    await boot(page, PV("200-finished-operator.json"));
    await expect(ob(page).locator('[data-testid="ob-numbers"] li').nth(2)).toHaveText("Model usage: operator subscription");
    await expect(computeLine(page)).toContainText("our cost");
  });

  test("a paid account's finished preview shows its result and offers no second plan button", async ({ page }) => {
    const m = mock({ onboarding: [json(ONB.step3)], previewGet: [json(PV("200-none.json")), json(PV("200-running.json")), json(PV("200-finished.json"))] });
    await setup(page, m);
    await bootToDesktop(page);
    await ob(page).locator('[data-testid="ob-preview-start"]').click();
    m.onboarding = [json({ ...SKIPPED, steps: SKIPPED.steps.map((s: { step: string }) => (s.step === "preview" ? { ...s, completed_at: "2026-09-20T09:55:00.000Z", skipped: false } : s)) })];
    await page.clock.runFor(3000);
    await expect(ob(page).locator('[data-testid="ob-result"]')).toBeVisible();
    await expect(ob(page).locator('[data-testid="ob-choose-plan"]')).toHaveCount(0);
  });

  test("feed lines are plain text: markup in a line stays literal", async ({ page }) => {
    const hostile = PV("200-running.json");
    hostile.progress.feed = [{ seq: 1, at: "2026-09-21T14:01:00.000Z", text: "Reading <img src=x onerror=alert(1)>.ts" }];
    const { problems } = await boot(page, hostile);
    await expect(ob(page).locator('[data-testid="ob-feed"] li')).toHaveText("Reading <img src=x onerror=alert(1)>.ts");
    await expect(ob(page).locator('[data-testid="ob-feed"] img')).toHaveCount(0);
    expect(problems).toEqual([]);
  });

  test("no feed yet says so honestly", async ({ page }) => {
    const empty = PV("200-starting.json");
    empty.progress.feed = [];
    await boot(page, empty);
    await expect(ob(page).locator('[data-testid="ob-feed"]')).toHaveText("Nothing to show yet. Activity appears here as the agent works.");
  });

  test("a long feed is capped at thirty lines and shows the newest", async ({ page }) => {
    const long = PV("200-running.json");
    long.progress.feed = Array.from({ length: 60 }, (_, i) => ({ seq: i + 1, at: "2026-09-21T14:01:00.000Z", text: `Reading src/file${i}.ts` }));
    await boot(page, long);
    await expect(ob(page).locator('[data-testid="ob-feed"] li')).toHaveCount(30);
    await expect(ob(page).locator('[data-testid="ob-feed"] li').last()).toHaveText("Reading src/file59.ts");
  });

  for (const [name, progress] of [["null", null], ["an unknown outcome", { outcome: "nonsense" }], ["no stages", { outcome: "running", stages: [] }]] as const) {
    test(`an answer whose progress is ${name} falls back to the plain running message, with no placeholder`, async ({ page }) => {
      await boot(page, { ...PV("200-running.json"), progress });
      await expect(state(page)).toHaveText("Your preview is running. This can take a few minutes.");
      expect(await ob(page).innerText()).not.toMatch(PLACEHOLDER);
    });
  }

  test("when an earlier step reopens the panel is torn down: no timer, no more reads", async ({ page }) => {
    const m = mock({ onboarding: [json(ONB.step3)], previewGet: [json(PV("200-running.json"))] });
    await setup(page, m);
    await bootToDesktop(page);
    await expect(ob(page).locator('[data-testid="ob-timer"]')).toBeVisible();
    m.onboarding = [json(doneUpTo(1))]; // the read-only app was removed
    await returnToOnboarding(page, "repos");
    await expect(ob(page).locator('[data-testid="ob-progress"]')).toHaveCount(0);
    await expect(ob(page).locator('[data-testid="ob-timer"]')).toHaveCount(0);
    const reads = count(m, "GET /api/v1/onboarding/preview");
    await page.clock.runFor(60_000);
    expect(count(m, "GET /api/v1/onboarding/preview")).toBe(reads);
  });
});
