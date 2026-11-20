// apps/workspace/e2e/dock-preview-clone.spec.ts
//
// D#37 (DOCK-PREVIEW-CLONE): the dock's hover preview and the alt-tab strip
// clone a window's DOM. The clone must not pass for a live window -- a plain
// `.fulc-window[data-app-id=X]` locator has to keep resolving to exactly one
// element once the pointer has rested on a dock icon -- and it must stay out
// of the accessibility tree and inert.

import { test, expect } from "@playwright/test";
import { bootToDesktop } from "./helpers/boot";

const PREVIEW_DELAY_PAST_MS = 1_000; // the preview shows after ~400 ms

test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name === "phone", "no dock hover or Alt+Tab on a phone");
});

test.describe("D#37 DOCK-PREVIEW-CLONE", () => {
  test("a hovered dock icon's preview clone does not duplicate the live window", async ({ page }) => {
    await bootToDesktop(page);
    await page.locator('.dock-icon[data-app-id="themes"]').click();
    await expect(page.locator('.fulc-window[data-app-id="themes"]')).toBeVisible();

    // An app's own test hooks must not be counted twice: mark a node in the live window (as the first-party apps do), then preview it.
    await page.evaluate(() => {
      const live = document.querySelector('.fulc-window[data-app-id="themes"]')!;
      const probe = document.createElement("span");
      probe.setAttribute("data-testid", "probe-card");
      live.appendChild(probe);
    });

    await page.locator('.dock-icon[data-app-id="themes"]').hover();
    await page.clock.runFor(PREVIEW_DELAY_PAST_MS);

    await expect(page.locator('[data-testid="probe-card"]')).toHaveCount(1);
    await expect(page.locator('.dock-preview [data-testid="probe-card"]')).toHaveCount(0);

    const clone = page.locator(".dock-preview .fulc-window-clone");
    await expect(clone).toHaveCount(1);
    await expect(clone).toHaveAttribute("aria-hidden", "true");
    await expect(clone).toHaveAttribute("inert", "");
    await expect(clone).toHaveAttribute("data-preview-of", "themes");
    await expect(clone).not.toHaveAttribute("data-app-id", /.*/);

    // The point of the change: one match, not two.
    await expect(page.locator('.fulc-window[data-app-id="themes"]')).toHaveCount(1);
    await expect(page.locator('.fulc-window[data-app-id="themes"] .window-titlebar')).toHaveCount(1);
    await expect(page.locator(".dock-preview .fulc-window")).toHaveCount(0);
    await expect(page.locator('.dock-preview [data-app-id="themes"]')).toHaveCount(0);
  });

  test("a long list marked data-preview-keep is cut to that many children in the preview, and the live list is untouched", async ({ page }) => {
    await bootToDesktop(page);
    await page.locator('.dock-icon[data-app-id="themes"]').click();
    await expect(page.locator('.fulc-window[data-app-id="themes"]')).toBeVisible();
    await page.evaluate(() => {
      const live = document.querySelector('.fulc-window[data-app-id="themes"]')!;
      const ul = document.createElement("ul");
      ul.setAttribute("data-preview-keep", "3");
      ul.id = "long-probe";
      for (let i = 0; i < 12; i++) { const li = document.createElement("li"); li.textContent = "row " + i; ul.appendChild(li); }
      live.appendChild(ul);
    });
    await page.locator('.dock-icon[data-app-id="themes"]').hover();
    await page.clock.runFor(PREVIEW_DELAY_PAST_MS);
    await expect(page.locator(".dock-preview .fulc-window-clone")).toHaveCount(1);
    await expect(page.locator(".dock-preview #long-probe > li")).toHaveCount(3);
    await expect(page.locator(".dock-preview #long-probe > li").last()).toHaveText("row 2");
    await expect(page.locator('.fulc-window[data-app-id="themes"] #long-probe > li')).toHaveCount(12);
  });
  test("the preview's copy of a radio group does not take the live selection", async ({ page }) => {
    await bootToDesktop(page);
    await page.locator('.dock-icon[data-app-id="themes"]').click();
    await expect(page.locator('.fulc-window[data-app-id="themes"]')).toBeVisible();
    await page.evaluate(() => {
      const live = document.querySelector('.fulc-window[data-app-id="themes"]')!;
      const box = document.createElement("div");
      box.innerHTML =
        '<input type="radio" name="probe-dial" id="probe-a" value="a">' +
        '<input type="radio" name="probe-dial" id="probe-b" value="b">' +
        '<input type="radio" name="probe-dial" id="probe-c" value="c">' +
        '<input type="checkbox" name="probe-box" id="probe-check">' +
        '<select name="probe-sel" id="probe-sel"><option value="x">x</option><option value="y">y</option></select>' +
        '<textarea name="probe-text" id="probe-text"></textarea>' +
        '<input type="text" name="probe-line" id="probe-line">';
      live.appendChild(box);
      // Set as a person would: the choice lives in the control's state, not in the markup.
      (document.getElementById("probe-c") as HTMLInputElement).checked = true;
      (document.getElementById("probe-check") as HTMLInputElement).checked = true;
      (document.getElementById("probe-sel") as HTMLSelectElement).value = "y";
      (document.getElementById("probe-text") as HTMLTextAreaElement).value = "typed";
      (document.getElementById("probe-line") as HTMLInputElement).value = "line";
    });

    await page.locator('.dock-icon[data-app-id="themes"]').hover();
    await page.clock.runFor(PREVIEW_DELAY_PAST_MS);
    await expect(page.locator(".dock-preview .fulc-window-clone")).toHaveCount(1);
    // Let the clone paint, then let any group reconciliation happen.
    await page.clock.runFor(500);

    const live = await page.evaluate(() => ({
      radios: ["probe-a", "probe-b", "probe-c"].map((id) => (document.getElementById(id) as HTMLInputElement).checked),
      check: (document.getElementById("probe-check") as HTMLInputElement).checked,
      sel: (document.getElementById("probe-sel") as HTMLSelectElement).value,
      text: (document.getElementById("probe-text") as HTMLTextAreaElement).value,
      line: (document.getElementById("probe-line") as HTMLInputElement).value,
    }));
    expect(live).toEqual({ radios: [false, false, true], check: true, sel: "y", text: "typed", line: "line" });

    // The copy shows the same choice but belongs to no group, form or label of the live window.
    const copy = await page.evaluate(() => {
      const c = document.querySelector(".dock-preview .fulc-window-clone")!;
      const controls = Array.from(c.querySelectorAll("input, select, textarea"));
      return {
        named: controls.filter((n) => n.hasAttribute("name") || n.hasAttribute("id")).length,
        checkedRadios: Array.from(c.querySelectorAll('input[type="radio"]')).filter((n) => (n as HTMLInputElement).checked).length,
      };
    });
    expect(copy.named).toBe(0);
    expect(copy.checkedRadios).toBe(1);
  });
});
