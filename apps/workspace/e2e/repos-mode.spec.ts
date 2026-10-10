// apps/workspace/e2e/repos-mode.spec.ts
//
// D#6 R5b-2b-iii: the Repos app's mode picker on the built cloud dist, at the desktop, tablet and phone projects. Every call is answered by
// page.route(); the bodies are the ones runner-cloud's repoMode.ts and executionMode.ts really send (the 4xx bodies carry `error.code` and a
// message that must never be shown). The page carries the production CSP and Trusted Types. The state-by-state logic is in
// test/repos-mode.test.mjs; this file covers what needs the real DOM: the radiogroup and its labels, the disabled reason wired by
// aria-describedby, the typed-name gate on the real input, focus on the error, and that nothing overflows a phone.

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
const NEW_HASH = "cd".repeat(32);
const SERVER_TEXT = "SERVER TEXT THAT MUST NEVER BE SHOWN";
const CSP = "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
const APP = `#windows-container .fulc-window[data-app-id="repos"]`;
const tid = (page: Page, id: string) => page.locator(`${APP} [data-testid="${id}"]`);

const COPY = {
  title: "Where this repo's work runs",
  sandbox: "Sandbox",
  sandboxHelp: "The agent runs in our cloud sandbox.",
  localOnly: "Local-only",
  localOnlyHelp: "The agent runs on your machine. Reviews run on your machine.",
  cloudVerified: "Cloud-verified",
  cloudVerifiedHelp: "The agent runs on your machine. Each pull request is reviewed in our sandbox on the API key you connect.",
  keyRequired: "Cloud-verified review runs on an API key you connect.",
  keyRequiredWhy: "Cloud-verified is off until a model API key is connected.",
  typeName: "Type the repository's full name to confirm.",
  apply: "Change mode",
  cancel: "Cancel",
  saving: "Saving...",
  saved: "Saved. The mode changed.",
  leaveCancels: "Moving this repo to the sandbox cancels its queued runner runs. A run that is already running is not stopped.",
  adminOnly: "Only owners and admins can change this.",
  saveFailed: "That change couldn't be saved. Try again.",
  nameMismatch: "That isn't the repository's name. Type it exactly, including capital letters.",
  copyChanged: "The wording changed, so it was reloaded. Read it and confirm again.",
  keyGone: "No usable model API key is connected any more, so cloud-verified stayed off.",
  publicRepo: "A public repository can't run on a runner.",
  visibilityUnknown: "The repository's visibility couldn't be read. Try again in a moment.",
};
const view = (over: Record<string, unknown> = {}) => ({
  repo_id: WEB, execution_mode: "sandbox", full_name: NAME, key_required: false, copy_sha256: HASH, can_change: true, copy: COPY, ...over,
});

interface Mock {
  view: Record<string, unknown>;
  getStatus: number;
  posts: unknown[];
  postReply?: () => Promise<{ status: number; json: unknown }>;
  getGate?: Promise<void>;
}

async function setup(page: Page, opts: { view?: Record<string, unknown>; getStatus?: number; admin?: boolean; getGate?: Promise<void> } = {}) {
  const appErrors: string[] = [];
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && appErrors.push(m.text()));
  page.on("pageerror", (e) => appErrors.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP ${e.violatedDirective}`)));
  await page.route((u) => u.pathname === "/", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": CSP } });
  });
  const mock: Mock = { view: opts.view ?? view(), getStatus: opts.getStatus ?? 200, posts: [], getGate: opts.getGate };
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
      if (mock.getGate) await mock.getGate;
      return mock.getStatus === 200 ? json(route, 200, mock.view) : json(route, mock.getStatus, { error: { code: "internal", message: SERVER_TEXT } });
    }
    mock.posts.push(JSON.parse(req.postData() ?? "{}"));
    const r = mock.postReply ? await mock.postReply() : { status: 200, json: { execution_mode: (JSON.parse(req.postData() ?? "{}") as { mode: string }).mode, changed: true, cancelled_runs: 0 } };
    return json(route, r.status, r.json);
  });
  await bootToDesktop(page);
  await page.locator('.dock-icon[data-app-id="repos"]').click();
  await expect(page.locator(APP)).toBeVisible();
  await tid(page, "repos-open").first().click();
  return { mock, appErrors };
}

const refusal = (status: number, code: string) => ({ status, json: { error: { code, message: SERVER_TEXT } } });
const pick = async (page: Page, mode: string) => tid(page, `repos-mode-${mode}`).check();

test.describe("D#6 R5b-2b-iii: repo mode picker (mocked API)", () => {
  test("the three modes are radios in a labelled radiogroup, with the current one checked and the copy's words", async ({ page }) => {
    const { appErrors } = await setup(page, { view: view({ execution_mode: "runner_local" }) });
    await expect(tid(page, "repos-mode-group")).toHaveAttribute("role", "radiogroup");
    await expect(page.locator(`${APP} [role=radiogroup][aria-label="${COPY.title}"]`)).toHaveCount(1);
    await expect(page.getByRole("radio", { name: new RegExp(COPY.sandbox) })).toBeVisible();
    await expect(tid(page, "repos-mode-sandbox")).not.toBeChecked();
    await expect(tid(page, "repos-mode-runner_local")).toBeChecked();
    await expect(tid(page, "repos-mode-runner_verified")).not.toBeChecked();
    await expect(tid(page, "repos-mode")).toContainText(COPY.sandboxHelp);
    await expect(tid(page, "repos-mode")).toContainText(COPY.localOnlyHelp);
    await expect(tid(page, "repos-mode-confirm")).toHaveCount(0);
    expect(appErrors).toEqual([]);
  });

  test("local-only: picking it opens the question; apply waits for the exact name; the POST has the mode and the name and no hash", async ({ page }) => {
    const { mock, appErrors } = await setup(page);
    await pick(page, "runner_local");
    await expect(tid(page, "repos-mode-confirm")).toBeVisible();
    await expect(tid(page, "repos-mode-apply")).toBeDisabled();
    for (const wrong of ["acme/widget", "Acme/widgets", "acme/widgets "]) {
      await tid(page, "repos-mode-name").fill(wrong);
      await expect(tid(page, "repos-mode-apply")).toBeDisabled();
    }
    await tid(page, "repos-mode-name").fill(NAME);
    await expect(tid(page, "repos-mode-apply")).toBeEnabled();
    await tid(page, "repos-mode-apply").click();
    await expect(tid(page, "repos-mode-saved")).toHaveText(COPY.saved);
    expect(mock.posts).toEqual([{ mode: "runner_local", confirm_repo: NAME }]);
    await expect(tid(page, "repos-mode-runner_local")).toBeChecked();
    await expect(tid(page, "repos-mode-confirm")).toHaveCount(0);
    expect(appErrors).toEqual([]);
  });

  test("cloud-verified: the wording is shown, the name gate holds, and the POST carries the hash the server gave", async ({ page }) => {
    const { mock, appErrors } = await setup(page);
    await pick(page, "runner_verified");
    await expect(tid(page, "repos-mode-wording")).toHaveText(COPY.cloudVerifiedHelp);
    await expect(tid(page, "repos-mode-apply")).toBeDisabled();
    await tid(page, "repos-mode-name").fill(NAME.toUpperCase());
    await expect(tid(page, "repos-mode-apply")).toBeDisabled();
    await tid(page, "repos-mode-apply").click({ force: true });
    expect(mock.posts).toEqual([]); // a press on the off button sends nothing
    await tid(page, "repos-mode-name").fill(NAME);
    await expect(tid(page, "repos-mode-apply")).toBeEnabled();
    await tid(page, "repos-mode-apply").click();
    await expect(tid(page, "repos-mode-saved")).toHaveText(COPY.saved);
    expect(mock.posts).toEqual([{ mode: "runner_verified", confirm_repo: NAME, copy_sha256: HASH }]);
    await expect(tid(page, "repos-mode-runner_verified")).toBeChecked();
    expect(appErrors).toEqual([]);
  });

  test("keyRequired: cloud-verified is off, its reason is wired to the radio by aria-describedby, and it cannot be picked", async ({ page }) => {
    const { mock, appErrors } = await setup(page, { view: view({ key_required: true }) });
    const radio = tid(page, "repos-mode-runner_verified");
    await expect(radio).toBeDisabled();
    await expect(tid(page, "repos-mode-sandbox")).toBeEnabled();
    await expect(tid(page, "repos-mode-runner_local")).toBeEnabled();
    const reasonId = await radio.getAttribute("aria-describedby");
    expect(reasonId).toBeTruthy();
    await expect(page.locator(`${APP} [id="${reasonId}"]`)).toHaveText(`${COPY.keyRequired} ${COPY.keyRequiredWhy}`);
    await radio.click({ force: true });
    await expect(tid(page, "repos-mode-confirm")).toHaveCount(0);
    expect(mock.posts).toEqual([]);
    expect(appErrors).toEqual([]);
  });

  test("leaving cloud-verified for the sandbox says the queued runs are cancelled; leaving it for local-only does not", async ({ page }) => {
    const { mock } = await setup(page, { view: view({ execution_mode: "runner_verified", key_required: true }) });
    await expect(tid(page, "repos-mode-runner_verified")).toBeChecked();
    await pick(page, "runner_local");
    await expect(tid(page, "repos-mode-leave")).toHaveCount(0);
    await pick(page, "sandbox");
    await expect(tid(page, "repos-mode-leave")).toHaveText(COPY.leaveCancels);
    await tid(page, "repos-mode-name").fill(NAME);
    await tid(page, "repos-mode-apply").click();
    await expect(tid(page, "repos-mode-saved")).toHaveText(COPY.saved);
    expect(mock.posts).toEqual([{ mode: "sandbox", confirm_repo: NAME }]);
  });

  test("while saving the button reads Saving and everything is off; a 500 shows the app's own sentence, focus lands on it, and the choice is kept", async ({ page }) => {
    const { mock, appErrors } = await setup(page);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    mock.postReply = async () => { await gate; return refusal(500, "internal"); };
    await pick(page, "runner_local");
    await tid(page, "repos-mode-name").fill(NAME);
    await tid(page, "repos-mode-apply").click();
    await expect(tid(page, "repos-mode-apply")).toHaveText(COPY.saving);
    await expect(tid(page, "repos-mode-apply")).toBeDisabled();
    await expect(tid(page, "repos-mode-sandbox")).toBeDisabled();
    await expect(tid(page, "repos-mode-name")).toBeDisabled();
    release();
    await expect(tid(page, "repos-mode-error")).toHaveText(COPY.saveFailed);
    await expect(tid(page, "repos-mode-error")).toBeFocused();
    await expect(page.locator(APP)).not.toContainText(SERVER_TEXT);
    await expect(tid(page, "repos-mode-confirm")).toBeVisible();
    await expect(tid(page, "repos-mode-runner_local")).toBeChecked();
    expect(appErrors).toEqual([]);
  });

  test("a server 409 copy_changed shows the wording sentence with focus on it, re-reads, and the next confirm carries the new hash", async ({ page }) => {
    const { mock } = await setup(page);
    mock.postReply = async () => {
      mock.view = view({ copy_sha256: NEW_HASH });
      mock.postReply = undefined;
      return refusal(409, "copy_changed");
    };
    await pick(page, "runner_verified");
    await tid(page, "repos-mode-name").fill(NAME);
    await tid(page, "repos-mode-apply").click();
    await expect(tid(page, "repos-mode-error")).toHaveText(COPY.copyChanged);
    await expect(tid(page, "repos-mode-error")).toBeFocused();
    await expect(page.locator(APP)).not.toContainText(SERVER_TEXT);
    await tid(page, "repos-mode-apply").click();
    await expect(tid(page, "repos-mode-saved")).toHaveText(COPY.saved);
    expect(mock.posts).toEqual([
      { mode: "runner_verified", confirm_repo: NAME, copy_sha256: HASH },
      { mode: "runner_verified", confirm_repo: NAME, copy_sha256: NEW_HASH },
    ]);
  });

  test("a server 409 api_key_required shows the key sentence and turns cloud-verified off after the re-read", async ({ page }) => {
    const { mock } = await setup(page);
    mock.postReply = async () => {
      mock.view = view({ key_required: true });
      return refusal(409, "api_key_required");
    };
    await pick(page, "runner_verified");
    await tid(page, "repos-mode-name").fill(NAME);
    await tid(page, "repos-mode-apply").click();
    await expect(tid(page, "repos-mode-error")).toHaveText(COPY.keyGone);
    await expect(tid(page, "repos-mode-error")).toBeFocused();
    await expect(tid(page, "repos-mode-runner_verified")).toBeDisabled();
  });

  test("a 400 name mismatch from the server is its own sentence; a 403 turns the picker read-only", async ({ page }) => {
    const { mock } = await setup(page);
    mock.postReply = async () => refusal(400, "confirmation_mismatch");
    await pick(page, "runner_local");
    await tid(page, "repos-mode-name").fill(NAME);
    await tid(page, "repos-mode-apply").click();
    await expect(tid(page, "repos-mode-error")).toHaveText(COPY.nameMismatch);
    mock.postReply = async () => refusal(403, "forbidden");
    await tid(page, "repos-mode-apply").click();
    await expect(tid(page, "repos-mode-error")).toHaveText(COPY.adminOnly);
    await expect(tid(page, "repos-mode-sandbox")).toBeDisabled();
    await expect(tid(page, "repos-mode-admin-only")).toHaveText(COPY.adminOnly);
  });

  test("a member sees the mode but every option is off and the admin-only line is wired to the radios", async ({ page }) => {
    const { mock } = await setup(page, { view: view({ can_change: false, execution_mode: "runner_local" }), admin: false });
    for (const m of ["sandbox", "runner_local", "runner_verified"]) await expect(tid(page, `repos-mode-${m}`)).toBeDisabled();
    await expect(tid(page, "repos-mode-runner_local")).toBeChecked();
    const id = await tid(page, "repos-mode-sandbox").getAttribute("aria-describedby");
    await expect(page.locator(`${APP} [id="${id}"]`)).toHaveText(COPY.adminOnly);
    expect(mock.posts).toEqual([]);
  });

  test("loading is shown while the read is out, and a failed read shows a sentence of the app's own, never the server's text", async ({ page }) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    await setup(page, { getStatus: 500, getGate: gate });
    await expect(tid(page, "repos-mode-loading")).toBeVisible();
    release();
    await expect(tid(page, "repos-mode-load-error")).toBeVisible();
    await expect(page.locator(APP)).not.toContainText(SERVER_TEXT);
    await expect(tid(page, "repos-mode-sandbox")).toHaveCount(0);
  });

  test("the picker fits the window: nothing scrolls sideways at this viewport", async ({ page }) => {
    await setup(page);
    await pick(page, "runner_verified");
    await tid(page, "repos-mode-name").fill(NAME);
    const over = await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      const box = el.closest(".repos-app") as HTMLElement;
      return { picker: el.scrollWidth - el.clientWidth, app: box.scrollWidth - box.clientWidth };
    }, `${APP} [data-testid="repos-mode"]`);
    expect(over.picker).toBeLessThanOrEqual(0);
    expect(over.app).toBeLessThanOrEqual(0);
  });
});
