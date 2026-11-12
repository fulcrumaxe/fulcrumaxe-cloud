// apps/workspace/e2e/repos-allowances-mode.spec.ts
//
// D#6 REPOS-ALLOWANCES-STALE-MODE: the allowance panel and the mode picker share one open repo. After "Change mode" in that same panel,
// the allowance approvals and the check must judge the mode now in force, with no reload. Every call is answered by page.route();
// the test never reloads and counts the allowance GETs to prove the panel was not simply re-read.

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
const OTHER = REPOS.data[1].id as string;
const NAME = "acme/widgets";
const HASH = "ab".repeat(32);
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
const A = { kind: "domain", value: "registry.npmjs.org", access: "connect", reason: "install packages" };
const file = (body: unknown) => ({ name: "runner-sandbox.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(body)) });
const allowView = (mode: string, repo = WEB) => ({
  repo_id: repo, execution_mode: mode, in_use: true, set_aside: false, can_change: true,
  approved: { version: 1, entries: [], command_timeout_s: 600, set_sha256: HASH, approved_at: "2026-10-09T00:00:00.000Z" },
  limits: { max_entries: 64, max_command_timeout_s: 1800 },
});

interface Opts { otherMode?: string; postGate?: Promise<void>; postStatus?: number; modeAfterRefusal?: string }
async function setup(page: Page, startMode: string, opts: Opts = {}) {
  const appErrors: string[] = [];
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && appErrors.push(m.text()));
  page.on("pageerror", (e) => appErrors.push(`pageerror: ${e.message}`));
  await page.route((u) => u.pathname === "/", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": CSP } });
  });
  const st = { mode: startMode, otherMode: opts.otherMode ?? "runner_local", allowGets: 0, puts: [] as unknown[] };
  const idOf = (route: Route) => new URL(route.request().url()).pathname.split("/")[4];
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/cloud/auth/me", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), is_admin: true } });
  });
  await page.route("**/api/v1/repos**", (route) => json(route, 200, new URL(route.request().url()).pathname.endsWith("/settings") ? SETTINGS : REPOS));
  await page.route("**/api/runners/repos/*/execution-mode", async (route) => {
    const req = route.request();
    const other = idOf(route) === OTHER;
    if (req.method() === "GET") return json(route, 200, { repo_id: other ? OTHER : WEB, execution_mode: other ? st.otherMode : st.mode, full_name: NAME, key_required: false, copy_sha256: HASH, can_change: true, copy: COPY });
    if (opts.postGate) await opts.postGate;
    if (opts.postStatus) {
      if (opts.modeAfterRefusal) st.mode = opts.modeAfterRefusal;
      return json(route, opts.postStatus, { error: { code: "mode_conflict", message: "SERVER TEXT" } });
    }
    st.mode = (JSON.parse(req.postData() ?? "{}") as { mode: string }).mode;
    return json(route, 200, { execution_mode: st.mode, changed: true, cancelled_runs: 0 });
  });
  await page.route("**/api/runners/repos/*/sandbox-allowances", (route) => {
    const req = route.request();
    if (idOf(route) === OTHER) return json(route, 200, allowView(st.otherMode, OTHER));
    if (req.method() === "GET") { st.allowGets++; return json(route, 200, allowView(startMode)); }
    st.puts.push(JSON.parse(req.postData() ?? "{}"));
    return json(route, 200, { ...allowView(st.mode), changed: true });
  });
  await bootToDesktop(page);
  await page.locator('.dock-icon[data-app-id="repos"]').click();
  await expect(page.locator(APP)).toBeVisible();
  await tid(page, "repos-open").first().click();
  await expect(tid(page, "repos-allow-file")).toBeVisible();
  return { st, appErrors };
}

const changeMode = async (page: Page, mode: string) => {
  await tid(page, `repos-mode-${mode}`).check();
  await tid(page, "repos-mode-name").fill(NAME);
  await tid(page, "repos-mode-apply").click();
  await expect(tid(page, "repos-mode-saved")).toHaveText(COPY.saved);
};

test.describe("D#6 REPOS-ALLOWANCES-STALE-MODE (mocked API)", () => {
  test("moving a sandbox repo to local-only lets the same panel approve a set and a check, with no reload", async ({ page }) => {
    const { st, appErrors } = await setup(page, "sandbox");
    await tid(page, "repos-allow-file").setInputFiles(file({ entries: [A], command_timeout_s: 600 }));
    await tid(page, "repos-allow-name").fill(NAME);
    await expect(tid(page, "repos-allow-not-runner")).toBeVisible();
    await expect(tid(page, "repos-allow-approve")).toBeDisabled();
    await tid(page, "repos-check-add").click();
    await expect(tid(page, "repos-check-not-runner")).toBeVisible();
    await tid(page, "repos-check-input").fill("bash");
    await tid(page, "repos-check-name").fill(NAME);
    await expect(tid(page, "repos-check-approve")).toBeDisabled();

    await changeMode(page, "runner_local");

    await expect(tid(page, "repos-allow-not-runner")).toHaveCount(0);
    await expect(tid(page, "repos-allow-approve")).toBeEnabled();
    await expect(tid(page, "repos-check-not-runner")).toHaveCount(0);
    await expect(tid(page, "repos-check-approve")).toBeEnabled();
    await tid(page, "repos-allow-approve").click();
    await expect(tid(page, "repos-allow-done")).toHaveText("Approved. It applies from the next job.");
    expect(st.puts).toEqual([{ set: { entries: [A], command_timeout_s: 600 }, confirm_repo: NAME }]);
    expect(st.allowGets).toBe(1); // the panel never re-read: the mode came from the change itself
    expect(appErrors).toEqual([]);
  });

  test("moving a local-only repo to the sandbox makes the same panel refuse, with no reload", async ({ page }) => {
    const { appErrors } = await setup(page, "runner_local");
    await tid(page, "repos-allow-file").setInputFiles(file({ entries: [A], command_timeout_s: 600 }));
    await tid(page, "repos-allow-name").fill(NAME);
    await expect(tid(page, "repos-allow-approve")).toBeEnabled();
    await tid(page, "repos-check-add").click();
    await expect(tid(page, "repos-check-not-runner")).toHaveCount(0);

    await changeMode(page, "sandbox");

    await expect(tid(page, "repos-allow-not-runner")).toBeVisible();
    await expect(tid(page, "repos-allow-approve")).toBeDisabled();
    await expect(tid(page, "repos-check-not-runner")).toBeVisible();
    expect(appErrors).toEqual([]);
  });

  test("a mode save still out when another repo opens does not change that repo's approvals", async ({ page }) => {
    let release: () => void = () => {};
    const postGate = new Promise<void>((r) => (release = r));
    const { appErrors } = await setup(page, "runner_local", { otherMode: "runner_local", postGate });
    await tid(page, "repos-mode-sandbox").check();
    await tid(page, "repos-mode-name").fill(NAME);
    await tid(page, "repos-mode-apply").click();
    await expect(tid(page, "repos-mode-apply")).toHaveText(COPY.saving);
    await tid(page, "repos-open").nth(1).click();
    await expect(tid(page, "repos-allow-file")).toBeVisible();
    await tid(page, "repos-allow-file").setInputFiles(file({ entries: [A], command_timeout_s: 600 }));
    await expect(tid(page, "repos-allow-not-runner")).toHaveCount(0);
    release();
    await page.waitForTimeout(500); // the first repo's save resolves now
    await expect(tid(page, "repos-allow-not-runner")).toHaveCount(0);
    await tid(page, "repos-check-add").click();
    await expect(tid(page, "repos-check-not-runner")).toHaveCount(0);
    expect(appErrors).toEqual([]);
  });

  test("a refused mode change re-reads the mode, and the same panel follows the mode now in force", async ({ page }) => {
    const { appErrors } = await setup(page, "sandbox", { postStatus: 409, modeAfterRefusal: "runner_local" });
    await tid(page, "repos-allow-file").setInputFiles(file({ entries: [A], command_timeout_s: 600 }));
    await expect(tid(page, "repos-allow-not-runner")).toBeVisible();
    await tid(page, "repos-mode-runner_local").check();
    await tid(page, "repos-mode-name").fill(NAME);
    await tid(page, "repos-mode-apply").click();
    await expect(tid(page, "repos-mode-error")).not.toHaveText("");
    await expect(tid(page, "repos-mode-runner_local")).toBeChecked(); // the re-read: someone else already moved it
    await expect(tid(page, "repos-allow-not-runner")).toHaveCount(0);
    expect(appErrors).toEqual([]);
  });
});
