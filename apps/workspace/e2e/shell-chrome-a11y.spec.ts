// apps/workspace/e2e/shell-chrome-a11y.spec.ts
//
// D#37 SHELL-TARGET-SIZE: the window titlebar's minimize / maximize / close buttons meet WCAG 2.2
// SC 2.5.8 (target size, minimum) under every shipped theme and every Themes-app window-chrome
// choice. Two windows are open (one active, one not) because the inactive state restyles the
// buttons in several themes. Axe is pointed at the controls only, with the wcag22aa tag.
//
// The second half guards layout: the fix must not move the titlebar. EXPECTED holds, per theme,
// the titlebar height and the left/right edges of the title text, measured on main before the
// fix (same harness, same viewport per project), and each must stay within 2 px.
//
// Same fixture-server harness as phone-menus.spec.ts; runs in desktop, phone and tablet.

import { inflateSync } from "node:zlib";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "@playwright/test";

const BOOT_FAST_FORWARD_MS = 15_000;
const THEMES = ["classic-crt", "retro-amber", "corporate", "crystal", "cyberpunk", "modern-flat", "nord", "orchard"];
const CHROMES = ["classic", "minimal", "rounded", "sharp", "neon-border"];
const CONTROLS = ".fulc-window .window-controls";

type Fw = { FULCWM: { open: (id: string) => void } };

async function bootToDesktop(page: Page) {
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.goto("/");
  await page.clock.runFor(BOOT_FAST_FORWARD_MS);
  await page.waitForFunction(() => (window as unknown as { currentStep?: string }).currentStep === "DESKTOP", {
    timeout: 10_000,
  });
  // Two windows: "roles" opened first, "themes" last so it is the focused one.
  for (const id of ["roles", "themes"]) {
    await page.evaluate((x) => (window as unknown as Fw).FULCWM.open(x), id);
    await expect(page.locator(`.fulc-window[data-app-id="${id}"]`)).toBeVisible();
  }
  await expect(page.locator(".fulc-window.active")).toHaveCount(1);
  await expect(page.locator(".fulc-window:not(.active)")).toHaveCount(1);
}

// page.clock is installed, so rAF-based waitForFunction can stall; advance the fake clock while polling.
const bodyData = (page: Page, key: string, want: string) =>
  expect
    .poll(
      async () => {
        await page.clock.runFor(250);
        return page.evaluate((k) => document.body.dataset[k], key);
      },
      { timeout: 30_000 },
    )
    .toBe(want);

const applyTheme = (page: Page, id: string) =>
  page.evaluate(async (x) => {
    const m = await import(new URL("core/theme-manager.js", document.baseURI).href);
    await m.FULCTheme.apply(x);
  }, id);

// Drives the same code path as the Themes app's Window Chrome select.
const applyChrome = (page: Page, chrome: string) =>
  page.evaluate(async (c) => {
    const m = await import(new URL("core/theme-layout.js", document.baseURI).href);
    m.FULCLayout.apply({ ...(m.FULCLayout.current() || {}), "window-chrome": c });
  }, chrome);

async function targetSizeViolations(page: Page, label: string) {
  const res = await new AxeBuilder({ page }).include(CONTROLS).withTags(["wcag22aa"]).analyze();
  const ran = [...res.passes, ...res.violations, ...res.incomplete].filter((r) => r.id === "target-size");
  expect(ran.length, `${label}: target-size rule ran`).toBeGreaterThan(0);
  return res.violations
    .filter((v) => v.id === "target-size")
    .map((v) => `${label}: ${v.nodes.map((n) => `${n.target.join(" ")} -- ${n.failureSummary?.split("\n")[1]?.trim()}`).join(" | ")}`);
}

interface Metrics {
  titlebarHeight: number;
  titleLeft: number;
  titleRight: number;
  dots: number[];
}
// [titlebar height, title text left, title text right], measured on main (966bf85) before the fix.
// Phone differs from desktop/tablet only in the window's own position (maximized vs centred).
const EXPECTED: Record<"phone" | "wide", Record<string, [number, number, number]>> = {
  phone: {
    "classic-crt": [28.6, 169.3, 221.4],
    "retro-amber": [28.6, 169.3, 221.3],
    corporate: [29.6, 169.0, 221.1],
    crystal: [33, 38.4, 92.1],
    cyberpunk: [53, 186.6, 252.6],
    "modern-flat": [29.8, 173.0, 233.0],
    nord: [19, 7, 46],
    orchard: [33, 179.3, 232.7],
  },
  wide: {
    "classic-crt": [28.6, 321.9, 374.0],
    "retro-amber": [28.6, 321.9, 373.9],
    corporate: [29.6, 322.6, 374.7],
    crystal: [33, 128.4, 182.1],
    cyberpunk: [53, 363.2, 429.2],
    "modern-flat": [29.8, 329.6, 389.6],
    nord: [19, 98, 137],
    orchard: [33, 343.3, 396.7],
  },
};
// Measured once the geometry has stopped moving (a theme switch can leave a transition running).
async function measure(page: Page): Promise<Metrics> {
  let prev = JSON.stringify(await measureOnce(page));
  for (let i = 0; i < 20; i++) {
    await page.clock.runFor(250);
    const next = JSON.stringify(await measureOnce(page));
    if (next === prev) return JSON.parse(next);
    prev = next;
  }
  throw new Error("titlebar geometry never settled");
}
const measureOnce = (page: Page) =>
  page.evaluate(() => {
    const win = document.querySelector<HTMLElement>(".fulc-window.active")!;
    const bar = win.querySelector<HTMLElement>(".window-titlebar")!;
    const title = win.querySelector<HTMLElement>(".window-title")!;
    const range = document.createRange();
    range.selectNodeContents(title);
    const t = range.getBoundingClientRect();
    const dot = win.querySelector<HTMLElement>(".window-close")!;
    const cs = getComputedStyle(dot);
    return {
      titlebarHeight: bar.getBoundingClientRect().height,
      titleLeft: t.left,
      titleRight: t.right,
      dots: [parseFloat(cs.width), parseFloat(cs.height)],
    };
  });

// D#37 SHELL-RESIZE-CORNERS. The eight resize zones sit above the titlebar buttons, so a button must not
// overlap one (R1), a pointer anywhere on it must reach it, and the 24px spacing circle round the outermost
// control must clear the corner zones (R2: centre >= 12px from the nearest corner box). Windows whose zones
// are hidden (phone, maximized) have no box to hit; the check then passes trivially and says so.
const CIRCLE_RADIUS = 12;
// The phone maximize is a real-time CSS transition, so the fake clock alone cannot tell when it has finished. Read the
// active window and its buttons every 100ms of real time (advancing the fake clock too) until three reads in a row are
// identical. A window that never settles fails the test loudly; there is no fall-through and no retry.
async function settleWindow(page: Page, timeoutMs = 10_000) {
  const boxes = () =>
    page.evaluate(() =>
      JSON.stringify([...document.querySelectorAll(".fulc-window.active, .fulc-window.active .window-btn")].map((e) => e.getBoundingClientRect())),
    );
  const t0 = Date.now();
  let prev = await boxes(), same = 0;
  while (same < 3) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`the active window's geometry never settled within ${timeoutMs}ms`);
    await page.clock.runFor(100);
    await new Promise((r) => setTimeout(r, 100));
    const next = await boxes();
    same = next === prev ? same + 1 : 0;
    prev = next;
  }
}
async function zoneGeometry(page: Page, label: string) {
  await settleWindow(page);
  const g = await page.evaluate(() => {
    const win = document.querySelector<HTMLElement>(".fulc-window.active")!;
    const box = (e: Element) => e.getBoundingClientRect();
    const zones = [...win.querySelectorAll(".wm-edge, .wm-corner")].filter((z) => box(z).width > 0);
    const corners = zones.filter((z) => z.classList.contains("wm-corner"));
    const btns = [...win.querySelectorAll<HTMLElement>(".window-controls .window-btn")].filter((b) => box(b).width > 0);
    const wb = box(win);
    const edgeGap = (b: HTMLElement) => Math.min(box(b).left - wb.left, wb.right - box(b).right);
    const outer = [...btns].sort((a, b) => edgeGap(a) - edgeGap(b))[0];
    const d = (b: Element, z: Element) => {
      const p = box(b), q = box(z);
      const cx = p.left + p.width / 2, cy = p.top + p.height / 2;
      return Math.hypot(Math.max(q.left - cx, 0, cx - q.right), Math.max(q.top - cy, 0, cy - q.bottom));
    };
    const hits = (x: number, y: number, b: Element) => {
      const t = document.elementFromPoint(x, y);
      return !!t && (t === b || b.contains(t));
    };
    // S-1: the window's rounded outline clips a flush control (crystal's close button). A grid point is dropped when
    // it lies outside that outline, decided from the window's box and corner radii alone, never from what
    // elementFromPoint returns. Each drop must fall inside a corner's radius square (asserted by the caller).
    const cs = getComputedStyle(win);
    const radii = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius]
      .map((r) => parseFloat(r) || 0);
    const corners4 = [[wb.left, wb.top, 1, 1], [wb.right, wb.top, -1, 1], [wb.right, wb.bottom, -1, -1], [wb.left, wb.bottom, 1, -1]];
    const cornerOf = (x: number, y: number) =>
      corners4.findIndex(([cx, cy, sx, sy], i) => (x - cx) * sx >= 0 && (x - cx) * sx <= radii[i] && (y - cy) * sy >= 0 && (y - cy) * sy <= radii[i]);
    const outsideOutline = (x: number, y: number) => {
      const i = cornerOf(x, y);
      if (i < 0) return false;
      const [cx, cy, sx, sy] = corners4[i];
      return Math.hypot(x - (cx + sx * radii[i]), y - (cy + sy * radii[i])) > radii[i];
    };
    // R-1: a control is ROUND when its corner radius is at least half its smaller side; round controls are sampled
    // inside the inscribed ellipse, others over the box, so a box corner outside a circle is never asked to hit.
    const samples = (b: HTMLElement) => {
      const p = box(b), r = getComputedStyle(b).borderTopLeftRadius, side = Math.min(p.width, p.height);
      const round = (r.endsWith("%") ? (parseFloat(r) / 100) * side : parseFloat(r)) >= side / 2;
      const cx = p.left + p.width / 2, cy = p.top + p.height / 2, rx = p.width / 2 - 1, ry = p.height / 2 - 1;
      const pts: number[][] = [[cx, cy]];
      const dropped: number[][] = [];
      for (let x = p.left + 1; x <= p.right - 1; x += 2)
        for (let y = p.top + 1; y <= p.bottom - 1; y += 2)
          if (!round || ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) (outsideOutline(x, y) ? dropped : pts).push([x, y]);
      return { pts, dropped };
    };
    return {
      zones: zones.length,
      overlaps: btns.flatMap((b) => zones.filter((z) => {
        const p = box(b), q = box(z);
        return p.left < q.right && p.right > q.left && p.top < q.bottom && p.bottom > q.top;
      }).map((z) => `${b.className} x ${z.className}`)),
      misses: btns.flatMap((b) => {
        const m = samples(b).pts.find(([x, y]) => !hits(x, y, b));
        return m ? [`${b.className} at (${m[0]}, ${m[1]})`] : [];
      }),
      drops: btns.map((b) => ({ btn: b.className, n: samples(b).dropped.length })).filter((d) => d.n > 0),
      strayDrops: btns.flatMap((b) => samples(b).dropped.filter(([x, y]) => cornerOf(x, y) < 0).map(([x, y]) => `${b.className} at (${x}, ${y})`)),
      clearance: outer && corners.length ? Math.min(...corners.map((z) => d(outer, z))) : null,
    };
  });
  if (process.env.MEASURE_CHROME) console.log(`ZONES ${label} ${JSON.stringify(g)}`);
  if (g.zones === 0) console.log(`${label}: resize zones hidden, geometry check passes trivially`);
  return g;
}
// STACKED rows may overlap a zone by box: crystal's full-height caption buttons sit flush in the corner and are
// stacked above the zones instead of moved, so the grid below still proves every visible point reaches the button.
const STACKED = new Set(["theme crystal"]);
const expectClear = async (page: Page, label: string) => {
  const g = await zoneGeometry(page, label);
  if (STACKED.has(label)) console.log(`${label}: stacked above the zones, box overlaps logged: ${g.overlaps.join("; ")}`);
  else expect(g.overlaps, `${label}: buttons overlap resize zones`).toEqual([]);
  if (g.drops.length) console.log(`${label}: points outside the window outline dropped: ${JSON.stringify(g.drops)}`);
  expect(g.strayDrops, `${label}: sample dropped away from a window corner's radius`).toEqual([]);
  expect(g.misses, `${label}: pointer on a button reaches something else`).toEqual([]);
  if (g.clearance !== null) expect(g.clearance, `${label}: outermost control's circle clears the corner`).toBeGreaterThanOrEqual(CIRCLE_RADIUS);
};

test.describe("D#37 SHELL-TARGET-SIZE: window chrome buttons", () => {
  for (const theme of THEMES) {
    test(`theme ${theme}: titlebar controls meet target size, layout unmoved`, async ({ page }, testInfo) => {
      await bootToDesktop(page);
      await applyTheme(page, theme);
      await bodyData(page, "experience", theme);
      expect(await targetSizeViolations(page, theme)).toEqual([]);
      const seen = await measure(page);
      if (process.env.MEASURE_CHROME) console.log(`MEASURED ${testInfo.project.name} ${theme} ${JSON.stringify(seen)}`);
      const [h, l, r] = EXPECTED[testInfo.project.name === "phone" ? "phone" : "wide"][theme];
      expect(Math.abs(seen.titlebarHeight - h), `${theme}: titlebar height`).toBeLessThanOrEqual(2);
      expect(Math.abs(seen.titleLeft - l), `${theme}: title left edge`).toBeLessThanOrEqual(2);
      expect(Math.abs(seen.titleRight - r), `${theme}: title right edge`).toBeLessThanOrEqual(2);
      if (theme === "orchard") expect(seen.dots, "orchard dots still paint as 12px circles").toEqual([12, 12]);
    });
  }

  // Under one theme, every chrome the Themes app offers.
  for (const chrome of CHROMES) {
    test(`Themes-app chrome ${chrome}: controls meet target size`, async ({ page }) => {
      await bootToDesktop(page);
      await applyTheme(page, "classic-crt");
      await applyChrome(page, chrome);
      await bodyData(page, "windowChrome", chrome);
      expect(await targetSizeViolations(page, `chrome ${chrome}`)).toEqual([]);
    });
  }

  for (const theme of THEMES) {
    test(`theme ${theme}: buttons clear the resize zones`, async ({ page }) => {
      await bootToDesktop(page);
      await applyTheme(page, theme);
      await bodyData(page, "experience", theme);
      await expectClear(page, `theme ${theme}`);
    });
  }
  for (const chrome of CHROMES) {
    test(`Themes-app chrome ${chrome}: buttons clear the resize zones`, async ({ page }) => {
      await bootToDesktop(page);
      await applyTheme(page, "classic-crt");
      await applyChrome(page, chrome);
      await bodyData(page, "windowChrome", chrome);
      await expectClear(page, `chrome ${chrome}`);
    });
  }
});

// R-2b: the zones outside the buttons must still resize. A zone's visible area is worked out by geometry alone: the
// zone box, clipped by the window box and its rounded outline, minus every control box. Where a 2x2px square of it
// is free, a drag from there must change the window size in the drag direction (inward, so the desktop edge cannot
// cap it) by 20px. Where none is, the zone is COVERED by a control, which only a STACKED row may be.
const DRAGS = [
  { zone: "wm-corner-ne", dx: -40, dy: 40, w: true, h: true },
  { zone: "wm-edge-n", dx: 0, dy: 40, w: false, h: true },
  { zone: "wm-edge-e", dx: -40, dy: 0, w: true, h: false },
];
async function dragFromZone(page: Page, zone: string, dx: number, dy: number) {
  const start = await page.evaluate((z) => {
    const win = document.querySelector<HTMLElement>(".fulc-window.active")!;
    const zb = win.querySelector(`.${z}`)!.getBoundingClientRect();
    const wb = win.getBoundingClientRect();
    const cs = getComputedStyle(win);
    const rad = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map((r) => parseFloat(r) || 0);
    const cn = [[wb.left, wb.top, 1, 1], [wb.right, wb.top, -1, 1], [wb.right, wb.bottom, -1, -1], [wb.left, wb.bottom, 1, -1]];
    const ctl = [...win.querySelectorAll(".window-controls .window-btn")].map((b) => b.getBoundingClientRect()).filter((b) => b.width > 0);
    const free = (x: number, y: number) => {
      if (x < wb.left || x > wb.right || y < wb.top || y > wb.bottom) return false;
      const out = cn.some(([cx, cy, sx, sy], i) => (x - cx) * sx < rad[i] && (y - cy) * sy < rad[i] && Math.hypot(x - (cx + sx * rad[i]), y - (cy + sy * rad[i])) > rad[i]);
      return !out && !ctl.some((b) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom);
    };
    const block = (x: number, y: number) => {
      for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) if (!free(x + i / 2, y + j / 2)) return false;
      return true;
    };
    for (let x = zb.left; x <= zb.right - 2; x += 0.5)
      for (let y = zb.top; y <= zb.bottom - 2; y += 0.5) if (block(x, y)) return { pick: [x + 1, y + 1], size: [win.offsetWidth, win.offsetHeight] };
    return { pick: null, size: [win.offsetWidth, win.offsetHeight] };
  }, zone);
  if (!start.pick) return { covered: true as const };
  const [x, y] = start.pick;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up();
  await page.clock.runFor(250);
  const after = await page.evaluate(() => {
    const w = document.querySelector<HTMLElement>(".fulc-window.active")!;
    return [w.offsetWidth, w.offsetHeight];
  });
  return { covered: false as const, before: start.size, after, at: [x, y] };
}
// Crystal's blur layer must cover the titlebar's whole border box. inset:0 stops at the padding box and leaves the
// 1px border-bottom row unblurred, so the layer's box is compared with the bar's border box.
test("D#37 SHELL-RESIZE-CORNERS: crystal's blur layer covers the titlebar's whole border box", async ({ page }) => {
  await bootToDesktop(page);
  await applyTheme(page, "crystal");
  await bodyData(page, "experience", "crystal");
  await page.clock.runFor(1000);
  await settleWindow(page);
  const g = await page.evaluate(() => {
    const bar = document.querySelector<HTMLElement>(".fulc-window.active .window-titlebar")!;
    const b = getComputedStyle(bar), p = getComputedStyle(bar, "::before");
    const r = bar.getBoundingClientRect();
    return {
      border: parseFloat(b.borderBottomWidth), content: p.content, blur: p.backdropFilter,
      // The layer's containing block is the padding box, so its top edge sits at the bar's top and its height is the layer's own.
      top: parseFloat(p.top), left: parseFloat(p.left), width: parseFloat(p.width), height: parseFloat(p.height),
      barWidth: r.width, barHeight: r.height,
    };
  });
  expect(g.border, "crystal's titlebar has a bottom border row").toBeGreaterThan(0);
  expect(g.blur, "the layer carries the blur").toContain("blur(32px)");
  expect([g.top, g.left], "layer starts at the bar's top-left").toEqual([0, 0]);
  expect(Math.abs(g.width - g.barWidth), "layer width equals the titlebar's border box").toBeLessThan(0.01);
  expect(Math.abs(g.height - g.barHeight), "layer height equals the titlebar's border box").toBeLessThan(0.01);
});

test.describe("D#37 SHELL-RESIZE-CORNERS: zones outside the buttons still resize", () => {
  for (const theme of ["crystal", "nord"]) {
    test(`theme ${theme}: NE corner, N edge and E edge resize or are covered by a stacked control`, async ({ page }) => {
      await bootToDesktop(page);
      await applyTheme(page, theme);
      await bodyData(page, "experience", theme);
      await page.clock.runFor(1000);
      await settleWindow(page);
      if ((await page.locator(".fulc-window.active .wm-corner-ne").evaluate((e) => e.getBoundingClientRect().width)) === 0) {
        console.log(`${theme}: resize zones hidden, drag check passes trivially`);
        return;
      }
      for (const d of DRAGS) {
        const r = await dragFromZone(page, d.zone, d.dx, d.dy);
        if (r.covered) {
          console.log(`R2b theme ${theme} ${d.zone}: COVERED (visible area under 2x2px)`);
          expect.soft(STACKED.has(`theme ${theme}`), `theme ${theme} ${d.zone}: only a stacked row may be covered`).toBe(true);
          continue;
        }
        console.log(`R2b theme ${theme} ${d.zone} from ${r.at}: ${r.before} -> ${r.after}`);
        if (d.w) expect.soft(r.before[0] - r.after[0], `theme ${theme} ${d.zone}: width follows the drag`).toBeGreaterThanOrEqual(20);
        if (d.h) expect.soft(r.before[1] - r.after[1], `theme ${theme} ${d.zone}: height follows the drag`).toBeGreaterThanOrEqual(20);
      }
    });
  }
});

// D#37 SHELL-A11Y-FOLLOWUP: spoken names, a visible keyboard focus ring that is not clipped, and readable inactive glyphs.
const ACTIVE_BAR = ".fulc-window.active .window-titlebar";

test.describe("D#37 SHELL-A11Y-FOLLOWUP: window buttons", () => {
  for (const theme of THEMES) {
    test(`theme ${theme}: accessible names follow the maximize state`, async ({ page }, testInfo) => {
      await bootToDesktop(page);
      await applyTheme(page, theme);
      await bodyData(page, "experience", theme);
      const bar = page.locator(ACTIVE_BAR);
      const names = () => bar.locator(".window-btn").evaluateAll((bs) => bs.map((b) => b.getAttribute("aria-label")));
      if (testInfo.project.name === "phone") {
        // Phones open every window maximized, so the maximize button is already labelled Restore (crystal's own
        // `display: flex !important` keeps that button painted on phones; layout is out of scope here).
        await expect(bar.getByRole("button", { name: "Minimize", exact: true })).toBeVisible();
        await expect(bar.getByRole("button", { name: "Close", exact: true })).toBeVisible();
        expect(await names()).toEqual(["Minimize", "Restore", "Close"]);
        return;
      }
      await expect(bar.getByRole("button", { name: "Minimize", exact: true })).toHaveCount(1);
      await expect(bar.getByRole("button", { name: "Maximize", exact: true })).toHaveCount(1);
      await expect(bar.getByRole("button", { name: "Close", exact: true })).toHaveCount(1);
      expect(await names(), `${theme}: every titlebar button is named, none by its glyph`).toEqual(["Minimize", "Maximize", "Close"]);
      await bar.getByRole("button", { name: "Maximize", exact: true }).click();
      await expect(bar.getByRole("button", { name: "Restore", exact: true })).toHaveCount(1);
      await expect(bar.getByRole("button", { name: "Maximize", exact: true })).toHaveCount(0);
      await bar.getByRole("button", { name: "Restore", exact: true }).click();
      await expect(bar.getByRole("button", { name: "Maximize", exact: true })).toHaveCount(1);
    });
  }
});

// The label follows the window's state on every path that leaves "maximized", not only the button itself.
test.describe("D#37 SHELL-A11Y-FOLLOWUP: maximize label stays true", () => {
  test("dragging a maximized window out by its titlebar, or snapping it, puts the label back to Maximize", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "phone", "phone windows stay maximized");
    await bootToDesktop(page);
    const bar = page.locator(ACTIVE_BAR);
    const maximize = bar.locator(".window-maximize");
    const label = () => maximize.evaluate((b) => `${b.getAttribute("aria-label")}|${b.getAttribute("title")}`);
    await maximize.click();
    expect(await label(), "maximized").toBe("Restore|Restore");

    // Drag out: mousedown on the bar restores the window at once; the button must follow. The mouse drag is the
    // desktop path (the tablet project is touch-first), so only desktop takes it; the snap below runs on both.
    if (testInfo.project.name === "desktop") {
      // Measure the settled titlebar: maximize animates the window, and a point taken mid-transition can land in its content.
      await page.locator(".fulc-window.active").evaluate((w) => Promise.all(w.getAnimations().map((a) => a.finished)));
      const box = (await bar.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 60, { steps: 4 });
      await page.mouse.up();
      expect(await page.locator(".fulc-window.active").evaluate((w) => w.classList.contains("maximized")), "window left maximized").toBe(false);
      expect(await label(), "after a titlebar drag").toBe("Maximize|Maximize");
      await expect(bar.getByRole("button", { name: "Maximize", exact: true })).toHaveCount(1);
    } else {
      await maximize.click();
      expect(await label(), "restored by the button").toBe("Maximize|Maximize");
    }

    await maximize.click();
    expect(await label(), "maximized again").toBe("Restore|Restore");
    await page.evaluate(() => (window as unknown as { FULCWM: { snapTo: (id: string, where: string) => void } }).FULCWM.snapTo("themes", "left"));
    expect(await label(), "after snapping").toBe("Maximize|Maximize");
  });
});

// Tabs through the active window's visible buttons (keyboard focus, so :focus-visible applies) and reports each
// button's outline and whether the ring, the border box grown by outline-width + outline-offset, leaves the window.
async function ringReport(page: Page) {
  await page.locator(`${ACTIVE_BAR} .window-minimize`).focus();
  const seen: { btn: string; style: string; width: number; offset: number; escapes: string[] }[] = [];
  for (let i = 0; i < 3; i++) {
    seen.push(
      await page.evaluate(() => {
        const b = document.activeElement as HTMLElement;
        const cs = getComputedStyle(b), r = b.getBoundingClientRect();
        const w = b.closest(".fulc-window")!.getBoundingClientRect();
        const width = parseFloat(cs.outlineWidth), offset = parseFloat(cs.outlineOffset), g = width + offset;
        const escapes = [
          r.left - g < w.left - 0.01 && "left", r.top - g < w.top - 0.01 && "top",
          r.right + g > w.right + 0.01 && "right", r.bottom + g > w.bottom + 0.01 && "bottom",
        ].filter(Boolean) as string[];
        return { btn: b.className, style: cs.outlineStyle, width, offset, escapes };
      }),
    );
    await page.keyboard.press("Tab");
    if (!(await page.evaluate(() => document.activeElement?.classList.contains("window-btn")))) break;
  }
  return seen;
}
const ringProblems = (seen: Awaited<ReturnType<typeof ringReport>>, label: string, clip: boolean) => {
  expect(seen.length, `${label}: tabbed to the window buttons`).toBeGreaterThanOrEqual(2);
  return seen.flatMap((s) => [
    ...(s.style === "none" || s.width < 2 ? [`${label}: ${s.btn} outline ${s.style} ${s.width}px`] : []),
    ...(clip && s.escapes.length ? [`${label}: ${s.btn} ring leaves the window on ${s.escapes.join(", ")}`] : []),
  ]);
};

test.describe("D#37 SHELL-A11Y-FOLLOWUP: focus ring", () => {
  for (const theme of THEMES) {
    test(`theme ${theme}: keyboard focus ring is drawn and stays inside the window`, async ({ page }) => {
      await bootToDesktop(page);
      await applyTheme(page, theme);
      await bodyData(page, "experience", theme);
      await page.clock.runFor(1000);
      await settleWindow(page);
      const seen = await ringReport(page);
      if (process.env.MEASURE_CHROME) console.log(`RING ${theme} ${JSON.stringify(seen)}`);
      expect(ringProblems(seen, `theme ${theme}`, true)).toEqual([]);
    });
  }
  for (const chrome of CHROMES) {
    test(`Themes-app chrome ${chrome}: keyboard focus ring is drawn`, async ({ page }) => {
      await bootToDesktop(page);
      await applyTheme(page, "classic-crt");
      await applyChrome(page, chrome);
      await bodyData(page, "windowChrome", chrome);
      await settleWindow(page);
      // Presence only: whether a chrome's ring is clipped is judged per theme above.
      expect(ringProblems(await ringReport(page), `chrome ${chrome}`, false)).toEqual([]);
    });
  }
});

// The first pixel of a 1x1 PNG, decoded without a library: one scanline, and every PNG filter reduces to the raw
// bytes when the left and upper neighbours are absent.
const pngPixel = (png: Buffer): number[] => {
  const idat: Buffer[] = [];
  let colorType = 0;
  for (let o = 8; o < png.length; ) {
    const len = png.readUInt32BE(o), type = png.toString("ascii", o + 4, o + 8);
    if (type === "IHDR") colorType = png[o + 8 + 9];
    if (type === "IDAT") idat.push(png.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  expect([2, 6], "PNG colour type is RGB or RGBA").toContain(colorType);
  const raw = inflateSync(Buffer.concat(idat));
  return [raw[1], raw[2], raw[3]];
};
const luminance = (rgb: number[]) => {
  const [r, g, b] = rgb.map((v) => v / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: number[], b: number[]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test("D#37 SHELL-A11Y-FOLLOWUP: crystal's inactive glyphs reach 4.5:1 and the active glyph is unchanged", async ({ page }, testInfo) => {
  // Phone windows are all maximized and stacked: the inactive one is not rendered, so there is no glyph to measure.
  test.skip(testInfo.project.name === "phone", "inactive windows are not painted on phones");
  await bootToDesktop(page);
  await applyTheme(page, "crystal");
  await bodyData(page, "experience", "crystal");
  await page.clock.runFor(1000);
  await settleWindow(page);
  const colors = await page.evaluate(() => {
    const c = (sel: string) => getComputedStyle(document.querySelector(`${sel} .window-minimize`)!).color;
    return { active: c(".fulc-window.active"), inactive: c(".fulc-window:not(.active)") };
  });
  expect(colors.active, "active-window glyph colour is unchanged").toBe("rgba(255, 255, 255, 0.75)");
  const [r, g, b, a = 1] = colors.inactive.match(/[\d.]+/g)!.map(Number);
  // Sample the rendered titlebar a few px left of the minimize button, where only the bar paints.
  const box = (await page.locator(".fulc-window:not(.active) .window-minimize").boundingBox())!;
  const bg = pngPixel(await page.screenshot({ clip: { x: Math.floor(box.x - 6), y: Math.floor(box.y + box.height / 2), width: 1, height: 1 } }));
  const glyph = [r, g, b].map((v, i) => v * a + bg[i] * (1 - a));
  const got = contrast(glyph, bg);
  console.log(`crystal inactive glyph ${colors.inactive} over titlebar rgb(${bg}) = ${got.toFixed(2)}:1`);
  expect(got, "inactive glyph contrast").toBeGreaterThanOrEqual(4.5);
});
