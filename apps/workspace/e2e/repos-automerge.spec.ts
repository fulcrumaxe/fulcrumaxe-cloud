// apps/workspace/e2e/repos-automerge.spec.ts
//
// D#6 R2b: the Repos app's "Merge after reviews on your machine" control on the built cloud dist. Every call is answered by page.route(),
// strictly: the route takes only the bodies runner-cloud's executionMode.ts accepts (auto-merge on with the exact name and the wording's
// hash, auto-merge off alone, a mode change), refuses anything else with 400, and the 4xx bodies carry `error.code` and a message that must
// never be shown. The page carries the production CSP and Trusted Types. The state-by-state logic is in test/repos-automerge.test.mjs; this
// file covers what needs the real DOM: the wording on screen, the typed-name gate on the real input, focus, reload safety, and that nothing
// overflows a phone.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";
import { bootToDesktop } from "./helpers/boot";

const V1 = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "api", "fixtures", "v1");
const readFixture = (...p: string[]) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
const REPOS = readFixture("listRepos", "200-page.json");
const SETTINGS = readFixture("getRepoSettings", "200-ok.json");
const WEB = REPOS.data[0].id as string;
const NAME = "acme/widgets";
const HASH = "ab".repeat(32);
const AM_HASH = "ef".repeat(32);
const AM_NEW_HASH = "12".repeat(32);
const SERVER_TEXT = "SERVER TEXT THAT MUST NEVER BE SHOWN";
const CSP = "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
const APP = `#windows-container .fulc-window[data-app-id="repos"]`;
const tid = (page: Page, id: string) => page.locator(`${APP} [data-testid="${id}"]`);

const WORDING = "Reviews for this repo run on your machine. With auto-merge on, a pull request that passes those reviews merges without a person.";
const COPY = {
  title: "Where this repo's work runs",
  sandbox: "Sandbox",
  sandboxHelp: "The agent runs in our cloud sandbox.",
  localOnly: "Local-only",
  localOnlyHelp: "The agent runs on your machine.",
  cloudVerified: "Cloud-verified",
  cloudVerifiedHelp: "Reviewed in our sandbox.",
  keyRequired: "Needs a key.",
  keyRequiredWhy: "Off until a key is connected.",
  typeName: "Type the repository's full name to confirm.",
  apply: "Change mode",
  cancel: "Cancel",
  saving: "Saving...",
  saved: "Saved. The mode changed.",
  leaveCancels: "Moving this repo to the sandbox cancels its queued runner runs.",
  adminOnly: "Only owners and admins can change this.",
  saveFailed: "That change couldn't be saved. Try again.",
  nameMismatch: "That isn't the repository's name. Type it exactly, including capital letters.",
  copyChanged: "The wording changed, so it was reloaded. Read it and confirm again.",
  keyGone: "No key.",
  publicRepo: "A public repository can't run on a runner.",
  visibilityUnknown: "Visibility unknown.",
  autoMergeWording: WORDING,
  autoMergeTitle: "Merge after reviews on your machine",
  autoMergeIsOn: "Auto-merge is on for this repo.",
  autoMergeIsOff: "Auto-merge is off. A person merges every pull request.",
  autoMergeTurnOn: "Turn on auto-merge",
  autoMergeTurnOff: "Turn off auto-merge",
  autoMergeSavedOn: "Saved. Auto-merge is on.",
  autoMergeSavedOff: "Saved. Auto-merge is off.",
  autoMergeHumanOnly: "A person merges every pull request in this repository, so auto-merge can't be turned on.",
  autoMergeNotLocal: "Auto-merge is only for repositories that run on your machine (local-only).",
};
const view = (over: Record<string, unknown> = {}) => ({
  repo_id: WEB, execution_mode: "runner_local", full_name: NAME, key_required: false, copy_sha256: HASH, auto_merge: false, auto_merge_copy_sha256: AM_HASH,
  can_change: true, runner_blocked: null, copy: COPY, ...over,
});

interface Mock {
  view: Record<string, unknown>;
  posts: unknown[];
  gets: number;
  postReply?: () => Promise<{ status: number; json: unknown }>;
}

async function setup(page: Page, opts: { view?: Record<string, unknown>; admin?: boolean } = {}) {
  const appErrors: string[] = [];
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && appErrors.push(m.text()));
  page.on("pageerror", (e) => appErrors.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP ${e.violatedDirective}`)));
  await page.route((u) => u.pathname === "/", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": CSP } });
  });
  const mock: Mock = { view: opts.view ?? view(), posts: [], gets: 0 };
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/cloud/auth/me", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), is_admin: opts.admin ?? true } });
  });
  await page.route("**/api/v1/repos**", (route) => {
    const u = new URL(route.request().url());
    return json(route, 200, u.pathname.endsWith("/settings") ? SETTINGS : REPOS);
  });
  await page.route("**/api/runners/repos/*/execution-mode", async (route) => {
    const req = route.request();
    expect(new URL(req.url()).pathname).toBe(`/api/runners/repos/${WEB}/execution-mode`);
    if (req.method() === "GET") {
      mock.gets++;
      return json(route, 200, mock.view);
    }
    const b = JSON.parse(req.postData() ?? "{}") as Record<string, unknown>;
    const keys = Object.keys(b).sort().join(",");
    const accepted =
      (b.auto_merge === true && keys === "auto_merge,confirm_repo,copy_sha256") ||
      (b.auto_merge === false && keys === "auto_merge") ||
      (typeof b.mode === "string" && keys === "confirm_repo,mode");
    if (!accepted) return json(route, 400, { error: { code: "invalid_message", message: SERVER_TEXT } });
    mock.posts.push(b);
    if (mock.postReply) {
      const r = await mock.postReply();
      return json(route, r.status, r.json);
    }
    if (typeof b.mode === "string") return json(route, 200, { execution_mode: b.mode, auto_merge: false, changed: true, cancelled_runs: 0 });
    mock.view = { ...mock.view, auto_merge: b.auto_merge === true };
    return json(route, 200, { execution_mode: "runner_local", auto_merge: b.auto_merge, changed: true, cancelled_runs: 0 });
  });
  await bootToDesktop(page);
  await page.locator('.dock-icon[data-app-id="repos"]').click();
  await expect(page.locator(APP)).toBeVisible();
  await tid(page, "repos-open").first().click();
  return { mock, appErrors };
}

const refusal = (status: number, code: string) => ({ status, json: { error: { code, message: SERVER_TEXT } } });
const typeName = async (page: Page, name = NAME) => {
  await tid(page, "repos-automerge-toggle").click();
  await tid(page, "repos-automerge-name").fill(name);
};

test.describe("D#6 R2b: local-review auto-merge control (mocked API)", () => {
  test("a local-only repo shows the control, off, with the server's wording and a Turn on button", async ({ page }) => {
    const { appErrors } = await setup(page);
    await expect(tid(page, "repos-automerge")).toBeVisible();
    await expect(page.locator(`${APP} [data-testid="repos-automerge"] legend`)).toHaveText(COPY.autoMergeTitle);
    await expect(tid(page, "repos-automerge-state")).toHaveText(COPY.autoMergeIsOff);
    await expect(tid(page, "repos-automerge-wording")).toHaveText(WORDING);
    await expect(tid(page, "repos-automerge-toggle")).toHaveText(COPY.autoMergeTurnOn);
    await expect(tid(page, "repos-automerge-confirm")).toHaveCount(0);
    expect(appErrors).toEqual([]);
  });

  test("a sandbox repo has no control", async ({ page }) => {
    const { appErrors } = await setup(page, { view: view({ execution_mode: "sandbox" }) });
    await expect(tid(page, "repos-mode")).toBeVisible();
    await expect(tid(page, "repos-mode-sandbox")).toBeChecked();
    await expect(tid(page, "repos-automerge")).toBeHidden();
    await expect(page.locator(APP)).not.toContainText(COPY.autoMergeTitle);
    expect(appErrors).toEqual([]);
  });

  test("a cloud-verified repo has no control", async ({ page }) => {
    const { appErrors } = await setup(page, { view: view({ execution_mode: "runner_verified" }) });
    await expect(tid(page, "repos-mode-runner_verified")).toBeChecked();
    await expect(tid(page, "repos-automerge")).toBeHidden();
    await expect(page.locator(APP)).not.toContainText(COPY.autoMergeTitle);
    expect(appErrors).toEqual([]);
  });

  test("turning on: the name gate holds on the real input, then the POST carries the exact name and the wording's hash, and the state is read again", async ({ page }) => {
    const { mock, appErrors } = await setup(page);
    await tid(page, "repos-automerge-toggle").click();
    await expect(tid(page, "repos-automerge-confirm")).toBeVisible();
    await expect(tid(page, "repos-automerge-name")).toBeFocused();
    await expect(tid(page, "repos-automerge-apply")).toHaveAttribute("aria-disabled", "true");
    for (const wrong of ["acme/widget", "Acme/widgets", "acme/widgets "]) {
      await tid(page, "repos-automerge-name").fill(wrong);
      await expect(tid(page, "repos-automerge-apply")).toHaveAttribute("aria-disabled", "true");
    }
    await tid(page, "repos-automerge-apply").click({ force: true });
    expect(mock.posts).toEqual([]); // a press on the off button sends nothing
    await tid(page, "repos-automerge-name").fill(NAME);
    await expect(tid(page, "repos-automerge-apply")).toHaveAttribute("aria-disabled", "false");
    const before = mock.gets;
    await tid(page, "repos-automerge-apply").click();
    await expect(tid(page, "repos-automerge-saved")).toHaveText(COPY.autoMergeSavedOn);
    expect(mock.posts).toEqual([{ auto_merge: true, confirm_repo: NAME, copy_sha256: AM_HASH }]);
    await expect(tid(page, "repos-automerge-state")).toHaveText(COPY.autoMergeIsOn);
    await expect(tid(page, "repos-automerge-toggle")).toHaveText(COPY.autoMergeTurnOff);
    await expect(tid(page, "repos-automerge-confirm")).toHaveCount(0);
    expect(mock.gets).toBeGreaterThan(before);
    expect(appErrors).toEqual([]);
  });

  test("cancel closes the question and sends nothing", async ({ page }) => {
    const { mock } = await setup(page);
    await typeName(page);
    await tid(page, "repos-automerge-cancel").click();
    await expect(tid(page, "repos-automerge-confirm")).toHaveCount(0);
    await expect(tid(page, "repos-automerge-toggle")).toHaveText(COPY.autoMergeTurnOn);
    expect(mock.posts).toEqual([]);
  });

  test("a repo that is on shows on after a load, and turns off with one click and no question", async ({ page }) => {
    const { mock, appErrors } = await setup(page, { view: view({ auto_merge: true }) });
    await expect(tid(page, "repos-automerge-state")).toHaveText(COPY.autoMergeIsOn);
    await expect(tid(page, "repos-automerge-toggle")).toHaveText(COPY.autoMergeTurnOff);
    await tid(page, "repos-automerge-toggle").click();
    await expect(tid(page, "repos-automerge-saved")).toHaveText(COPY.autoMergeSavedOff);
    expect(mock.posts).toEqual([{ auto_merge: false }]);
    await expect(tid(page, "repos-automerge-state")).toHaveText(COPY.autoMergeIsOff);
    await expect(tid(page, "repos-automerge-confirm")).toHaveCount(0);
    expect(appErrors).toEqual([]);
  });

  test("while saving the button reads Saving and the field is off; a 500 shows the app's own sentence with focus on it", async ({ page }) => {
    const { mock, appErrors } = await setup(page);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    mock.postReply = async () => { await gate; return refusal(500, "internal"); };
    await typeName(page);
    await tid(page, "repos-automerge-apply").click();
    await expect(tid(page, "repos-automerge-apply")).toHaveText(COPY.saving);
    await expect(tid(page, "repos-automerge-name")).toBeDisabled();
    release();
    await expect(tid(page, "repos-automerge-error")).toHaveText(COPY.saveFailed);
    await expect(tid(page, "repos-automerge-error")).toBeFocused();
    await expect(page.locator(APP)).not.toContainText(SERVER_TEXT);
    await expect(tid(page, "repos-automerge-confirm")).toBeVisible();
    expect(appErrors).toEqual([]);
  });

  for (const [status, code, words] of [
    [409, "human_merge_only", COPY.autoMergeHumanOnly],
    [400, "confirmation_mismatch", COPY.nameMismatch],
    [409, "not_runner_local", COPY.autoMergeNotLocal],
  ] as const) {
    test(`a ${status} ${code} is its own plain sentence, with no server text`, async ({ page }) => {
      const { mock } = await setup(page);
      mock.postReply = async () => refusal(status, code);
      await typeName(page);
      await tid(page, "repos-automerge-apply").click();
      await expect(tid(page, "repos-automerge-error")).toHaveText(words);
      await expect(tid(page, "repos-automerge-error")).toBeFocused();
      await expect(page.locator(APP)).not.toContainText(SERVER_TEXT);
      await expect(tid(page, "repos-automerge-saved")).toHaveText("");
    });
  }

  test("a 409 copy_changed shows the wording sentence, re-reads, and the next confirm carries the new hash", async ({ page }) => {
    const { mock } = await setup(page);
    mock.postReply = async () => {
      mock.view = view({ auto_merge_copy_sha256: AM_NEW_HASH });
      mock.postReply = undefined;
      return refusal(409, "copy_changed");
    };
    await typeName(page);
    await tid(page, "repos-automerge-apply").click();
    await expect(tid(page, "repos-automerge-error")).toHaveText(COPY.copyChanged);
    await tid(page, "repos-automerge-apply").click();
    await expect(tid(page, "repos-automerge-saved")).toHaveText(COPY.autoMergeSavedOn);
    expect(mock.posts).toEqual([
      { auto_merge: true, confirm_repo: NAME, copy_sha256: AM_HASH },
      { auto_merge: true, confirm_repo: NAME, copy_sha256: AM_NEW_HASH },
    ]);
  });

  test("a 403 turns the control read-only with the admin-only line", async ({ page }) => {
    const { mock } = await setup(page);
    mock.postReply = async () => refusal(403, "forbidden");
    await typeName(page);
    await tid(page, "repos-automerge-apply").click();
    await expect(tid(page, "repos-automerge-admin-only")).toHaveText(COPY.adminOnly);
    await expect(tid(page, "repos-automerge-toggle")).toHaveCount(0);
  });

  test("a member sees the state and the wording, the admin-only line, and no button", async ({ page }) => {
    const { mock } = await setup(page, { view: view({ can_change: false, auto_merge: true }), admin: false });
    await expect(tid(page, "repos-automerge-state")).toHaveText(COPY.autoMergeIsOn);
    await expect(tid(page, "repos-automerge-wording")).toHaveText(WORDING);
    await expect(tid(page, "repos-automerge-admin-only")).toHaveText(COPY.adminOnly);
    await expect(tid(page, "repos-automerge-toggle")).toHaveCount(0);
    expect(mock.posts).toEqual([]);
  });

  test("moving the repo to the sandbox with the mode picker takes the control away", async ({ page }) => {
    const { mock } = await setup(page, { view: view({ auto_merge: true }) });
    await expect(tid(page, "repos-automerge")).toBeVisible();
    await tid(page, "repos-mode-sandbox").check();
    await tid(page, "repos-mode-name").fill(NAME);
    mock.view = view({ execution_mode: "sandbox", auto_merge: false });
    await tid(page, "repos-mode-apply").click();
    await expect(tid(page, "repos-automerge")).toBeHidden();
    expect(mock.posts).toEqual([{ mode: "sandbox", confirm_repo: NAME }]);
  });

  test("the control fits the window: nothing scrolls sideways at this viewport", async ({ page }) => {
    await setup(page);
    await typeName(page);
    const over = await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      const box = el.closest(".repos-app") as HTMLElement;
      return { control: el.scrollWidth - el.clientWidth, app: box.scrollWidth - box.clientWidth };
    }, `${APP} [data-testid="repos-automerge"]`);
    expect(over.control).toBeLessThanOrEqual(0);
    expect(over.app).toBeLessThanOrEqual(0);
  });
});
