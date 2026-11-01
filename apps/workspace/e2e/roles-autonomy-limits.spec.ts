// apps/workspace/e2e/roles-autonomy-limits.spec.ts
//
// D#483 S5-h: the Autonomy view's build, auto-start, margin and discovery rows. The built cloud dist is served by fixture-server.mjs; the API
// is a small stateful fake (page.route) built from the committed fixtures, so a change survives a reload. What the server decides (the preview
// figures, the hash check, the versions and the audit rows) is proved against real Postgres in packages/api/test/build-concurrency.test.ts,
// envelope-settings.test.ts and discovery.test.ts; here the subject is the page: real clicks, the one request each action sends, every state,
// the way back, and keyboard and phone width as numbers.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page, type Route } from "@playwright/test";
import { bootToDesktop } from "./helpers/boot";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const V1 = join(SCRIPT_DIR, "..", "..", "..", "packages", "api", "fixtures", "v1");
const fx = (...p: string[]) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
const REPOS = fx("listRepos", "200-page.json");
const DIALS = fx("getDecisionSettings", "200-ok.json");
const ASK = fx("getAskSettings", "200-ok.json");
const AUTO_OFF = fx("getAutostartEnvelope", "200-off.json");
const AUTO_ON = fx("getAutostartEnvelope", "200-on.json");
const MARGIN = fx("getEnvelopeMargin", "200-setting.json");
const DISC = fx("getDiscoverySetting", "200-ok.json");

const WIN = `#windows-container .fulc-window[data-app-id="roles"]`;
const tid = (page: Page, id: string) => page.locator(`${WIN} [data-testid="${id}"]`);
const rowOf = (page: Page, key: string) => page.locator(`${WIN} [data-testid="lim-row"][data-row="${key}"]`);
const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const wm = (page: Page, act: "open" | "close") => page.evaluate((a) => (window as unknown as { FULCWM: Record<string, (id: string) => void> }).FULCWM[a]("roles"), act);
const NEVER = /undefined|null|NaN|\[object|[a-z]+_[a-z]+/;

interface Change {
  version: number;
  from: number;
  to: number;
  changed_by_name: string;
  changed_at: string;
  preview: Record<string, unknown>;
}
interface World {
  canChange: boolean;
  conc: Record<"acct" | "repo", { value: number; start: number; changes: Change[] }>;
  auto: typeof AUTO_OFF;
  margin: typeof MARGIN;
  disc: typeof DISC;
  /** The next PUT to the account limit answers 409 preview_stale once. */
  staleOnce: boolean;
  writes: { method: string; path: string; body: Record<string, unknown> }[];
  previews: number;
  appErrors: string[];
}

const preview = (scope: string, from: number, to: number, nonce: number) => ({
  scope,
  repo_id: scope === "repo" ? DISC.repo_id : null,
  kind: to > from ? "raise" : to < from ? "lower" : "same",
  from,
  to,
  items: 6,
  unpriced_items: 1 + nonce,
  effective_limit_old: from,
  effective_limit_new: to,
  clear_minutes_old: 120,
  clear_minutes_new: 60 + nonce,
  extra_per_hour_cents: 150,
  extra_per_day_cents: 3600,
  queue_total_cents: 9000,
  basis: "history",
  notes: [{ code: "unpriced_items", text: "One waiting item has no estimate yet and is left out of these figures." }],
  preview_hash: "h" + from + "-" + to + "-" + nonce,
});

async function boot(page: Page, over: Partial<World> = {}): Promise<World> {
  const w: World = {
    canChange: true,
    conc: { acct: { value: 4, start: 4, changes: [] }, repo: { value: 2, start: 2, changes: [] } },
    auto: AUTO_OFF,
    margin: MARGIN,
    disc: { ...DISC, changes: [] },
    staleOnce: false,
    writes: [],
    previews: 0,
    appErrors: [],
    ...over,
  };
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && w.appErrors.push(m.text()));
  page.on("pageerror", (e) => w.appErrors.push(`pageerror: ${e.message}`));
  const concurrency = async (route: Route, key: "acct" | "repo", tail: string, method: string, body: Record<string, unknown>) => {
    const c = w.conc[key];
    const clamp = key === "repo" ? { applied_limit: 1, clamp_reason: "one_build_per_repo_until_d598" } : { history_count: c.changes.length };
    if (tail === "history") return json(route, 200, { changes: [...c.changes].reverse() });
    if (tail === "preview") {
      w.previews++;
      return json(route, 200, preview(key === "acct" ? "account" : "repo", c.value, Number(body.max_builds), w.previews));
    }
    if (method === "PUT") {
      w.writes.push({ method, path: `${key}/build-concurrency`, body });
      const to = Number(body.max_builds);
      if (w.staleOnce && to > c.value) {
        w.staleOnce = false;
        w.previews++;
        return json(route, 409, { error: { code: "preview_stale", message: "what the preview showed has changed" }, data: { preview: preview("account", c.value, to, w.previews) } });
      }
      c.changes.push({ version: c.changes.length + 1, from: c.value, to, changed_by_name: "Ada Admin", changed_at: "2026-10-31T15:00:00.000Z", preview: to > c.value ? preview(key === "acct" ? "account" : "repo", c.value, to, 1) : { kind: "lower", from: c.value, to } });
      c.value = to;
      return json(route, 200, { value: c.value, start_value: c.start, ...clamp, changed: true });
    }
    return json(route, 200, { value: c.value, start_value: c.start, ...clamp });
  };
  await page.route("**/api/v1/account/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1/account/", "");
    const method = route.request().method();
    const body = method === "GET" ? {} : route.request().postDataJSON();
    const m = path.match(/^build-concurrency(?:\/(history|preview))?$/);
    if (m) return concurrency(route, "acct", m[1] ?? "", method, body);
    if (path === "autostart-envelope") {
      if (method === "PUT") {
        w.writes.push({ method, path, body });
        const amount = Number(body.amount_usd ?? 0);
        w.auto = amount > 0 ? { ...AUTO_ON, amount_usd: amount, remaining_this_week_usd: amount - 12.5 } : AUTO_OFF;
        return json(route, 200, { ...w.auto, changed: true });
      }
      return json(route, 200, w.auto);
    }
    if (path === "envelope-margin") {
      if (method === "PUT") {
        w.writes.push({ method, path, body });
        w.margin = { ...w.margin, margin_pct: Number(body.margin_pct), source: "setting" };
      }
      return json(route, 200, w.margin);
    }
    return json(route, 404, { error: { code: "not_found", message: "no" } });
  });
  await page.route("**/api/v1/repos**", async (route) => {
    const url = new URL(route.request().url());
    const m = url.pathname.match(/^\/api\/v1\/repos\/([^/]+)\/(.+)$/);
    if (!m) return json(route, 200, REPOS);
    const method = route.request().method();
    const tail = m[2]!;
    const body = method === "GET" ? {} : route.request().postDataJSON();
    if (tail === "decision-settings") return json(route, 200, { ...DIALS, can_change: w.canChange });
    if (tail === "ask-settings") return json(route, 200, { ...ASK, can_change: w.canChange });
    const c = tail.match(/^build-concurrency(?:\/(history|preview))?$/);
    if (c) return concurrency(route, "repo", c[1] ?? "", method, body);
    if (tail === "discovery") {
      if (method === "PUT") {
        w.writes.push({ method, path: "discovery", body });
        const f = String(body.frequency);
        w.disc = { ...w.disc, frequency: f, label: w.disc.options.find((o: { value: string }) => o.value === f)!.label, source: "set" };
      }
      return json(route, 200, { ...w.disc, can_change: w.canChange });
    }
    return json(route, 200, { data: [] });
  });
  await bootToDesktop(page);
  await wm(page, "open");
  await expect(page.locator(WIN)).toBeVisible();
  await openAutonomy(page);
  return w;
}

async function openAutonomy(page: Page) {
  await tid(page, "roles-tab-autonomy").click();
  await expect(tid(page, "au-levels")).toBeVisible();
  await expect(tid(page, "lim-rows")).toBeVisible();
}

const history = (page: Page, key: string) => rowOf(page, key).getByTestId("lim-change");

test.describe("D#483 S5-h: Autonomy, builds at once and the other limits", () => {
  test("change builds at once: preview, accept, reload shows the value and a history line; then set it back", async ({ page }) => {
    const w = await boot(page);
    const row = rowOf(page, "acct");
    await expect(row.getByTestId("lim-acct-value")).toHaveText("Now: 4");
    await expect(row).toContainText("Starting value: 4");
    await expect(row).toContainText("Not changed yet.");

    await row.getByTestId("lim-acct-input").fill("8");
    await row.getByTestId("lim-acct-review").click();
    const pv = row.getByTestId("lim-acct-preview");
    await expect(pv).toBeVisible();
    await expect(pv.getByTestId("lim-fact")).toHaveText([
      "Time to clear the queue: 2 hours now, 1 hour 1 minute after this change",
      "Extra spend per hour: $1.50",
      "Extra spend per day: $36.00",
      "Whole queue: $90.00",
      "Items with no estimate: 2",
      "Priced from: your recent runs",
    ]);
    await expect(pv.getByTestId("lim-note")).toHaveText("One waiting item has no estimate yet and is left out of these figures.");
    expect(w.writes).toEqual([]); // a preview writes nothing

    await row.getByTestId("lim-acct-accept").click();
    await expect(row.getByTestId("lim-acct-value")).toHaveText("Now: 8");
    expect(w.writes).toEqual([{ method: "PUT", path: "acct/build-concurrency", body: { max_builds: 8, accept: true, preview_hash: "h4-8-1" } }]);
    await expect(row.getByTestId("lim-acct-preview")).toHaveCount(0);
    await expect(history(page, "acct")).toHaveCount(1);
    await expect(history(page, "acct").first()).toContainText(/^Changed from 4 to 8 by Ada Admin on .*2026/);
    // the history keeps the figures that were shown at accept time
    await expect(history(page, "acct").first().getByTestId("lim-shown")).toContainText(["Shown: Extra spend per day: $36.00"]);

    // After a reload the value and the history line come from the server.
    await page.reload();
    await bootToDesktop(page);
    await wm(page, "open");
    await openAutonomy(page);
    await expect(rowOf(page, "acct").getByTestId("lim-acct-value")).toHaveText("Now: 8");
    await expect(history(page, "acct").first()).toContainText("Changed from 4 to 8 by Ada Admin");

    // The undo: set it back. A lowering is previewed too, and the history then shows both changes.
    await rowOf(page, "acct").getByTestId("lim-acct-input").fill("4");
    await rowOf(page, "acct").getByTestId("lim-acct-review").click();
    await rowOf(page, "acct").getByTestId("lim-acct-accept").click();
    await expect(rowOf(page, "acct").getByTestId("lim-acct-value")).toHaveText("Now: 4");
    await expect(history(page, "acct")).toHaveText([/Changed from 8 to 4 by Ada Admin/, /Changed from 4 to 8 by Ada Admin/]);
    await expect(history(page, "acct").first().getByTestId("lim-shown")).toHaveCount(0); // a lowering stored no figures
    expect(w.writes).toHaveLength(2);
    expect(w.appErrors).toEqual([]);
  });

  test("a stale preview: the fresh one is shown in place, nothing is written, and the second accept saves", async ({ page }) => {
    const w = await boot(page, { staleOnce: true });
    const row = rowOf(page, "acct");
    await row.getByTestId("lim-acct-input").fill("9");
    await row.getByTestId("lim-acct-review").click();
    await row.getByTestId("lim-acct-accept").click();
    await expect(row.getByTestId("lim-error")).toHaveText("What the preview showed has changed. Check the new figures, then accept again.");
    await expect(row.getByTestId("lim-acct-preview")).toBeVisible();
    await expect(row.getByTestId("lim-fact").first()).toContainText("1 hour 3 minutes"); // the fresh preview, not the first one
    await expect(row.getByTestId("lim-acct-value")).toHaveText("Now: 4");
    expect(w.conc.acct.changes).toEqual([]);
    await row.getByTestId("lim-acct-accept").click();
    await expect(row.getByTestId("lim-acct-value")).toHaveText("Now: 9");
    expect(w.writes.map((x) => x.body.preview_hash)).toEqual(["h4-9-1", "h4-9-3"]);
  });

  test("the repo row carries the one-build-per-repo sentence; cancel writes nothing; the same number is refused naming the field", async ({ page }) => {
    const w = await boot(page);
    const row = rowOf(page, "repo");
    await expect(row.getByTestId("lim-repo-scope")).toHaveText("This applies once parallel builds on one repo are supported.");
    await row.getByTestId("lim-repo-input").fill("2");
    await row.getByTestId("lim-repo-review").click();
    await expect(row.getByTestId("lim-error")).toHaveText("Builds at once: that is already the number in force.");
    await row.getByTestId("lim-repo-input").fill("0");
    await row.getByTestId("lim-repo-review").click();
    await expect(row.getByTestId("lim-error")).toHaveText("Builds at once: enter a whole number of 1 or more.");
    await row.getByTestId("lim-repo-input").fill("5");
    await row.getByTestId("lim-repo-review").click();
    await expect(row.getByTestId("lim-repo-preview")).toBeVisible();
    await row.getByTestId("lim-repo-cancel").click();
    await expect(row.getByTestId("lim-repo-preview")).toHaveCount(0);
    await expect(tid(page, "lim-repo-review")).toBeFocused();
    expect(w.writes).toEqual([]);
  });

  test("weekly limit needs a confirmation, margin and discovery save through their routes, and each goes back", async ({ page }) => {
    const w = await boot(page);
    const auto = rowOf(page, "auto");
    await expect(auto.getByTestId("lim-auto-value")).toContainText("Set a weekly auto-start limit");
    await auto.getByTestId("lim-auto-input").fill("37");
    await auto.getByTestId("lim-auto-save").click();
    await expect(auto.getByTestId("lim-error")).toHaveText("Weekly auto-start limit: confirm the weekly limit to turn auto-start on.");
    expect(w.writes).toEqual([]);
    await auto.getByTestId("lim-auto-confirm").check();
    await auto.getByTestId("lim-auto-save").click();
    await expect(auto.getByTestId("lim-auto-value")).toContainText("Now: $37.00 a week");
    await auto.getByTestId("lim-auto-off").click();
    await expect(auto.getByTestId("lim-auto-value")).toContainText("Set a weekly auto-start limit");
    expect(w.writes.map((x) => x.body)).toEqual([{ amount_usd: 37, confirm: true }, { amount_usd: 0 }]);

    const margin = rowOf(page, "margin");
    await expect(margin.getByTestId("lim-margin-value")).toHaveText("Now: 35%");
    await margin.getByTestId("lim-margin-input").fill("12.345");
    await margin.getByTestId("lim-margin-save").click();
    await expect(margin.getByTestId("lim-error")).toHaveText(/^Default margin: enter a number from 0 to 500 with at most two decimals\.$/);
    await margin.getByTestId("lim-margin-input").fill("12.5");
    await margin.getByTestId("lim-margin-save").click();
    await expect(margin.getByTestId("lim-margin-value")).toHaveText("Now: 12.5%");
    await margin.getByTestId("lim-margin-default").click();
    await expect(margin.getByTestId("lim-margin-value")).toHaveText("Now: 20%");

    const disc = rowOf(page, "disc");
    await expect(disc.getByTestId("lim-disc-value")).toHaveText("Now: Every day");
    await disc.getByTestId("lim-disc-select").selectOption({ label: "Every week" });
    await disc.getByTestId("lim-disc-apply").click();
    await expect(disc.getByTestId("lim-disc-value")).toHaveText("Now: Every week");
    await disc.getByTestId("lim-disc-select").selectOption({ label: "Every day" });
    await disc.getByTestId("lim-disc-apply").click();
    await expect(disc.getByTestId("lim-disc-value")).toHaveText("Now: Every day");
    expect(w.writes.slice(2).map((x) => [x.path, x.body])).toEqual([
      ["envelope-margin", { margin_pct: 12.5 }],
      ["envelope-margin", { margin_pct: 20 }],
      ["discovery", { frequency: "weekly" }],
      ["discovery", { frequency: "daily" }],
    ]);
    expect(w.appErrors).toEqual([]);
  });

  test("S5h-2: a plain member sees every row and its history with no control at all", async ({ page }) => {
    const w = await boot(page, { canChange: false });
    w.conc.acct.changes.push({ version: 1, from: 4, to: 6, changed_by_name: "Ada Admin", changed_at: "2026-10-30T14:05:00.000Z", preview: {} });
    w.conc.acct.value = 6;
    await page.reload();
    await bootToDesktop(page);
    await wm(page, "open");
    await openAutonomy(page);
    await expect(tid(page, "lim-readonly")).toHaveText("Only owners and admins can change these settings.");
    await expect(rowOf(page, "acct").getByTestId("lim-acct-value")).toHaveText("Now: 6");
    await expect(history(page, "acct")).toHaveCount(1);
    await expect(tid(page, "lim-margin-value")).toBeVisible();
    await expect(tid(page, "lim-disc-value")).toHaveText("Now: Every day");
    await expect(page.locator(`${WIN} [data-testid="lim-body"] :is(button, input, select)`)).toHaveCount(0);
    expect(w.writes).toEqual([]);
  });

  test("a setting that cannot be read says so in a fixed sentence and the others still work", async ({ page }) => {
    await boot(page);
    await page.route("**/api/v1/account/envelope-margin", (route) => json(route, 500, { error: { code: "boom", message: "SECRET" } }));
    await page.reload();
    await bootToDesktop(page);
    await wm(page, "open");
    await openAutonomy(page);
    await expect(rowOf(page, "margin").getByTestId("lim-unavailable")).toHaveText("This setting isn't available right now.");
    await expect(rowOf(page, "acct").getByTestId("lim-acct-value")).toHaveText("Now: 4");
    expect(await tid(page, "lim-body").innerText()).not.toContain("SECRET");
  });

  test("labels come from the server: no id, null, undefined or NaN on screen in the owner view, the preview or the error state", async ({ page }) => {
    await boot(page);
    const body = tid(page, "lim-body");
    const check = async () => {
      expect(await body.innerText()).not.toMatch(NEVER);
      for (const o of await body.locator("option").allInnerTexts()) expect(o).not.toMatch(NEVER);
    };
    await check();
    await rowOf(page, "acct").getByTestId("lim-acct-input").fill("8");
    await rowOf(page, "acct").getByTestId("lim-acct-review").click();
    await expect(rowOf(page, "acct").getByTestId("lim-acct-preview")).toBeVisible();
    await check();
    await rowOf(page, "auto").getByTestId("lim-auto-input").fill("x");
    await rowOf(page, "auto").getByTestId("lim-auto-save").click();
    await expect(rowOf(page, "auto").getByTestId("lim-error")).toBeVisible();
    await check();
  });

  test("keyboard and focus: every control is reachable by Tab and shows a focus ring; no accessibility violation", async ({ page }) => {
    await boot(page);
    await rowOf(page, "acct").getByTestId("lim-acct-input").fill("8");
    await rowOf(page, "acct").getByTestId("lim-acct-review").click();
    await expect(rowOf(page, "acct").getByTestId("lim-acct-preview")).toBeVisible();
    const controls = page.locator(`${WIN} [data-testid="lim-body"] :is(button, input, select)`);
    const total = await controls.count();
    expect(total).toBe(14);
    const reached = new Set<number>();
    await controls.first().focus();
    for (let i = 0; i < total; i++) {
      const info = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement;
        const box = document.querySelector('#windows-container .fulc-window[data-app-id="roles"] [data-testid="lim-body"]')!;
        const all = [...box.querySelectorAll("button, input, select")];
        const cs = getComputedStyle(el);
        return { index: all.indexOf(el), outline: parseFloat(cs.outlineWidth), style: cs.outlineStyle };
      });
      expect(info.index, `step ${i}`).toBeGreaterThanOrEqual(0);
      expect(info.style).not.toBe("none");
      expect(info.outline).toBeGreaterThanOrEqual(2);
      reached.add(info.index);
      await page.keyboard.press("Tab");
    }
    expect(reached.size).toBe(total);
    const scan = (await new AxeBuilder({ page }).include(WIN).exclude(`${WIN} .window-titlebar`).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze()).violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical"
    );
    expect(scan.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
  });

  test("phone width: no horizontal scroll at 375 px and every button is on screen", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "phone", "phone project only");
    await page.setViewportSize({ width: 375, height: 812 });
    await boot(page);
    await rowOf(page, "acct").getByTestId("lim-acct-input").fill("8");
    await rowOf(page, "acct").getByTestId("lim-acct-review").click();
    await expect(rowOf(page, "disc")).toBeVisible();
    await page.evaluate(() => document.querySelector('[data-testid="lim-row"][data-row="disc"]')!.scrollIntoView());
    const m = await page.evaluate(() => {
      const win = document.querySelector('#windows-container .fulc-window[data-app-id="roles"]') as HTMLElement;
      const box = win.querySelector('[data-testid="au-limits"]') as HTMLElement;
      const right = box.getBoundingClientRect().right;
      const over = [...box.querySelectorAll("button, input, select")].filter((el) => (el as HTMLElement).getBoundingClientRect().right > window.innerWidth + 0.5).length;
      return { viewport: window.innerWidth, docOver: document.documentElement.scrollWidth - window.innerWidth, boxScroll: box.scrollWidth - box.clientWidth, right, over };
    });
    expect(m.viewport).toBe(375);
    expect(m.docOver).toBeLessThanOrEqual(0);
    expect(m.boxScroll).toBeLessThanOrEqual(0);
    expect(m.right).toBeLessThanOrEqual(m.viewport);
    expect(m.over).toBe(0);
  });

  test("the view source has no sink and no direct fetch, and the section only writes through the four settings' routes", () => {
    const src = readFileSync(join(SCRIPT_DIR, "..", "apps", "roles", "roles-autonomy.js"), "utf8");
    expect(src).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(src).not.toMatch(/\bfetch\(/);
    expect(src).not.toMatch(/"(PATCH|DELETE)"/);
    expect(src).not.toMatch(/FULC\.(state|config|window|backend|events)/);
    const writes = [...src.matchAll(/api\("(PUT|POST)", ([^,]+),/g)].map((x) => `${x[1]} ${x[2]}`).filter((x) => !x.startsWith("POST repoPath(")).sort();
    expect(writes).toEqual(['POST base + "/preview"', 'POST base + "/preview"', 'PUT ACCOUNT + "autostart-envelope"', 'PUT ACCOUNT + "envelope-margin"', 'PUT base', 'PUT repoPath(repoId']);
  });
});
