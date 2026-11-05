// apps/workspace/e2e/repos-plan-writeback-held.spec.ts
//
// The Repos app's "Merge plan updates automatically" switch on the built cloud dist, for the one state where the merge dial holds it: the switch is on and the
// repo's merge dial ("Merging a pull request once its reviews pass") says ask, so a person still merges plan updates. The screen must say that plainly, name the
// setting and say where to change it (Roles, Autonomy), and never auto-raise the dial: the page sends only the switch's own PUT. Every call is answered by
// page.route(); the state-by-state logic is in test/repos-plan-writeback.test.mjs.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";
import { bootToDesktop } from "./helpers/boot";

const V1 = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "api", "fixtures", "v1");
const readFixture = (...p: string[]) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
const REPOS = readFixture("listRepos", "200-page.json");
const SETTINGS = readFixture("getRepoSettings", "200-ok.json");
const APP = `#windows-container .fulc-window[data-app-id="repos"]`;
const tid = (page: Page, id: string) => page.locator(`${APP} [data-testid="${id}"]`);

const HELD =
  "Automatic merging is on, but \"Merging a pull request once its reviews pass\" is set to ask, so a person merges plan updates for now. Change that in Roles, Autonomy.";

async function setup(page: Page, answer: { auto_merge: boolean; merge_dial: string; recent_merges?: unknown[] }) {
  const writes: string[] = [];
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  // The signed-in person is an owner or admin, so the switch is operable.
  await page.route("**/api/cloud/auth/me", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), is_admin: true } });
  });
  const state = { default: false, recent_merges: [] as unknown[], ...answer };
  await page.route("**/api/v1/repos**", (route) => {
    const r = route.request();
    const u = new URL(r.url());
    if (u.pathname.endsWith("/plan-writeback/setting")) {
      if (r.method() === "PUT") {
        writes.push(`PUT ${r.postData()}`);
        state.auto_merge = (JSON.parse(r.postData() ?? "{}") as { auto_merge: boolean }).auto_merge;
      }
      return json(route, 200, state); // the server's own answer: the dial is read, never written, by this route
    }
    if (r.method() !== "GET") writes.push(`${r.method()} ${u.pathname}`);
    return json(route, 200, u.pathname.endsWith("/settings") ? SETTINGS : REPOS);
  });
  await bootToDesktop(page);
  await page.locator('.dock-icon[data-app-id="repos"]').click();
  await expect(page.locator(APP)).toBeVisible();
  await tid(page, "repos-open").first().click();
  return { writes };
}

test.describe("plan updates: the merge dial is what holds a merge", () => {
  test("switch on and dial ask: the screen says the merge dial holds it, names the setting and where to change it, and sends nothing", async ({ page }) => {
    const { writes } = await setup(page, { auto_merge: true, merge_dial: "ask" });
    await expect(tid(page, "repos-plan-writeback-switch")).toBeChecked();
    await expect(tid(page, "repos-plan-writeback-held")).toHaveText(HELD);
    expect(writes).toEqual([]); // reading the screen never moves the dial or the switch
  });

  test("switch on and dial act (the default for a repo with no row): nothing is held, and the last automatic merge is shown", async ({ page }) => {
    await setup(page, { auto_merge: true, merge_dial: "act", recent_merges: [{ id: "r1", at: "2026-11-04T09:30:00.000Z", chosen: "act" }] });
    await expect(tid(page, "repos-plan-writeback-switch")).toBeChecked();
    await expect(tid(page, "repos-plan-writeback-held")).toBeHidden();
    await expect(tid(page, "repos-plan-writeback-last")).toHaveText("Last plan update merged automatically on 2026-11-04.");
  });

  test("switch off and dial ask: nothing to explain", async ({ page }) => {
    await setup(page, { auto_merge: false, merge_dial: "ask" });
    await expect(tid(page, "repos-plan-writeback-switch")).not.toBeChecked();
    await expect(tid(page, "repos-plan-writeback-held")).toBeHidden();
  });

  test("turning the switch on while the dial is ask shows the held sentence from the server's answer, and only the switch is written", async ({ page }) => {
    const { writes } = await setup(page, { auto_merge: false, merge_dial: "ask" });
    await expect(tid(page, "repos-plan-writeback-held")).toBeHidden();
    await tid(page, "repos-plan-writeback-switch").check();
    await expect(tid(page, "repos-plan-writeback-held")).toHaveText(HELD);
    expect(writes).toEqual(['PUT {"auto_merge":true}']);
  });
});
