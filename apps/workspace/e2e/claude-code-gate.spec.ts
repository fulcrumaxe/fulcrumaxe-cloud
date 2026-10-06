// apps/workspace/e2e/claude-code-gate.spec.ts
//
// D#37 WS-C2 criterion 14: "Runtime 'Claude Code' gate: opens every app
// in apps-under-test.json and the command palette at desktop and phone
// viewports and asserts innerText, document.title, and every title,
// aria-label and placeholder attribute never match
// /claude[\s_\-. ]*code/i."
//
// This runs against the fully-built dist/ (checks.mjs --ship already
// gates the literal build-time "Claude Code" string, D#2 constraint) --
// this spec is the RUNTIME half: catching a string only assembled at
// runtime (e.g. concatenated from data) that a static byte scan can't
// see. "desktop and phone viewports" comes for free here: this file
// runs under BOTH of playwright.config.ts's projects (desktop/phone),
// same as every other spec in this suite -- no per-test device loop
// needed.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { bootToDesktop } from "./helpers/boot";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const APPS_UNDER_TEST: string[] = JSON.parse(readFileSync(join(SCRIPT_DIR, "apps-under-test.json"), "utf8"));

const CLAUDE_CODE_RE = /claude[\s_\-. ]*code/i;

async function assertNoClaudeCodeString(page: Page, where: string) {
  const title = await page.title();
  expect(title, `document.title at ${where}`).not.toMatch(CLAUDE_CODE_RE);

  const bodyText = await page.locator("body").innerText();
  expect(bodyText, `innerText at ${where}`).not.toMatch(CLAUDE_CODE_RE);

  const attrHits = await page.evaluate(() => {
    const hits: string[] = [];
    const re = /claude[\s_\-. ]*code/i;
    document.querySelectorAll("[title], [aria-label], [placeholder]").forEach((el) => {
      for (const attr of ["title", "aria-label", "placeholder"]) {
        const v = el.getAttribute(attr);
        if (v && re.test(v)) hits.push(`${attr}="${v}" on <${el.tagName.toLowerCase()}>`);
      }
    });
    return hits;
  });
  expect(attrHits, `title/aria-label/placeholder at ${where}`).toEqual([]);
}

test.describe('runtime "Claude Code" gate', () => {
  for (const appId of APPS_UNDER_TEST) {
    test(`app: ${appId}`, async ({ page }) => {
      await bootToDesktop(page);
      await page.locator(`.dock-icon[data-app-id="${appId}"]`).click();
      // Scoped to the real windows: the dock hover preview is a clone with the same class.
      await expect(page.locator(`#windows-container .fulc-window[data-app-id="${appId}"]`)).toBeVisible();
      await assertNoClaudeCodeString(page, `app "${appId}"`);
    });
  }

  test("command palette", async ({ page }) => {
    await bootToDesktop(page);
    await page.keyboard.press("Control+k");
    await expect(page.locator("#command-palette")).toBeVisible();
    await assertNoClaudeCodeString(page, "command palette");
  });
});
