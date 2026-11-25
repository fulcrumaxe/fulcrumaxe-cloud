// apps/workspace/e2e/repos-remove.spec.ts
//
// D#845 ON-16a2: the "Remove from fulcrumaxe" sheet of the Repos app on the built cloud dist. Every call the window makes is answered by
// page.route(): the repos list carries one row for each removal state (e2e/repos-removal-fixture.json), and the remove route answers with
// the shapes `removeProjectRoute` sends (200 with { repo_id, runner_id, machine_parts, already_removed, pr }, 409 setup_running, 403 forbidden).
// The page carries the production CSP and Trusted Types.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { bootToDesktop } from "./helpers/boot";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FX = JSON.parse(readFileSync(join(SCRIPT_DIR, "repos-removal-fixture.json"), "utf8"));
const SETTINGS = JSON.parse(readFileSync(join(SCRIPT_DIR, "..", "..", "..", "packages", "api", "fixtures", "v1", "getRepoSettings", "200-ok.json"), "utf8"));
const CSP = "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
const APP = `#windows-container .fulc-window[data-app-id="repos"]`;
const DIALOG = `[data-testid="repos-remove-dialog"]`;
const tid = (page: Page, id: string) => page.locator(`${APP} [data-testid="${id}"]`);
const sheet = (page: Page, id: string) => page.locator(`${DIALOG} [data-testid="${id}"]`);
const ALL = [FX.repos.none, FX.repos.waiting_machine, FX.repos.removing, FX.repos.failed];

interface Sent { method: string; path: string; body: string | null }

async function setup(page: Page, opts: { admin?: boolean; remove?: () => { status: number; json: unknown }; servers?: unknown; serverDelete?: () => { status: number; json: unknown } } = {}) {
  const appErrors: string[] = [];
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && appErrors.push(m.text()));
  page.on("pageerror", (e) => appErrors.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP ${e.violatedDirective}`)));
  await page.route((u) => u.pathname === "/", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": CSP } });
  });
  const sent: Sent[] = [];
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/cloud/auth/me", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), is_admin: !!opts.admin } });
  });
  await page.route("**/api/v1/repos**", (route) => {
    const req = route.request();
    const u = new URL(req.url());
    sent.push({ method: req.method(), path: u.pathname, body: req.postData() });
    return u.pathname.endsWith("/settings") ? json(route, 200, SETTINGS) : json(route, 200, { data: ALL, next_cursor: null });
  });
  await page.route("**/api/runners/repos/*/remove", (route) => {
    const req = route.request();
    sent.push({ method: req.method(), path: new URL(req.url()).pathname, body: req.postData() });
    const r = opts.remove ? opts.remove() : { status: 200, json: FX.answers.queued_no_pr };
    return json(route, r.status, r.json);
  });
  // MC-12: the server that holds the project (none unless a test says), and the one request that deletes it with the project.
  await page.route((u) => u.pathname === "/api/v1/machine-servers", (route) => {
    const req = route.request();
    sent.push({ method: req.method(), path: new URL(req.url()).pathname + new URL(req.url()).search, body: req.postData() });
    return json(route, 200, opts.servers ?? FX.servers.none);
  });
  await page.route((u) => /^\/api\/v1\/machine-servers\/[^/]+\/delete-with-project$/.test(u.pathname), (route) => {
    const req = route.request();
    sent.push({ method: req.method(), path: new URL(req.url()).pathname, body: req.postData() });
    const r = opts.serverDelete ? opts.serverDelete() : { status: 202, json: FX.server_answer };
    return json(route, r.status, r.json);
  });
  await bootToDesktop(page);
  return { sent, appErrors };
}

async function openRepos(page: Page) {
  await page.locator('.dock-icon[data-app-id="repos"]').click();
  await expect(page.locator(APP)).toBeVisible();
}
const openRow = async (page: Page, name: string) => {
  await tid(page, "repos-open").filter({ hasText: name }).click();
  await expect(tid(page, "repos-remove-open")).toBeVisible();
};
const removes = (sent: Sent[]) => sent.filter((s) => s.method === "POST" && s.path.endsWith("/remove"));
const serverRemoves = (sent: Sent[]) => sent.filter((s) => s.method === "POST" && s.path.endsWith("/delete-with-project"));
const repoGets = (sent: Sent[]) => sent.filter((s) => s.method === "GET" && s.path === "/api/v1/repos");

test.describe("D#845 ON-16a2: Remove from fulcrumaxe (mocked API)", () => {
  test("each removal state is a line on its repo's row, with the machine's name in <bdi>, and a repo with none has no line", async ({ page }) => {
    const { appErrors } = await setup(page, { admin: true });
    await openRepos(page);
    await expect(tid(page, "repos-row")).toHaveCount(4);
    expect(await tid(page, "repos-state").allTextContents()).toEqual(["Installed", "Installed", "Installed", "Installed"]);
    const lines = tid(page, "repos-removal");
    await expect(lines).toHaveCount(3);
    expect(await lines.evaluateAll((els) => els.map((e) => [e.getAttribute("data-state"), e.textContent]))).toEqual([
      ["waiting_machine", "Waiting for Studio box שלום to come back"],
      ["removing", "Removing from Studio box…"],
      ["failed", "Couldn't remove the engine's sandbox from Studio box (sandbox_busy). Remove the machine to clear it, or place the project on another machine."],
    ]);
    expect(await tid(page, "repos-removal-machine").evaluateAll((els) => els.map((e) => e.tagName))).toEqual(["BDI", "BDI", "BDI"]);
    await expect(tid(page, "repos-row").first().locator('[data-testid="repos-removal"]')).toHaveCount(0);
    await expect(page.locator(APP)).not.toContainText(/undefined|null/);
    expect(appErrors).toEqual([]);
  });

  test("the sheet opens with its default ticks and sends nothing; Cancel closes it with nothing sent and focus back on the button", async ({ page }) => {
    const { sent, appErrors } = await setup(page, { admin: true });
    await openRepos(page);
    await openRow(page, "acme/widgets");
    await tid(page, "repos-remove-open").click();
    await expect(page.locator(DIALOG)).toBeVisible();
    await expect(page.locator(`${DIALOG} h2`)).toHaveText("Remove from fulcrumaxe");
    await expect(sheet(page, "repos-remove-name")).toHaveText("acme/widgets");
    expect(await sheet(page, "repos-remove-name").evaluate((e) => e.tagName)).toBe("BDI");
    await expect(sheet(page, "repos-remove-stop")).toHaveText("Its engine is stopped on its machine.");
    expect(await sheet(page, "repos-remove-stop").evaluate((e) => e.tagName)).toBe("P"); // a fact, not a box
    await expect(page.locator(`${DIALOG} input[type="checkbox"]`)).toHaveCount(2);
    await expect(sheet(page, "repos-remove-sandbox")).toBeChecked();
    await expect(sheet(page, "repos-remove-pr")).not.toBeChecked();
    await expect(page.locator(DIALOG)).toContainText("Delete its sandbox and snapshots");
    await expect(page.locator(DIALOG)).toContainText("Open a PR removing the engine files");
    await expect(page.locator(DIALOG)).toContainText("never deleted");
    await expect(sheet(page, "repos-remove-waiting")).toHaveCount(0);
    await sheet(page, "repos-remove-cancel").click();
    await expect(page.locator(DIALOG)).toHaveCount(0);
    await expect(tid(page, "repos-remove-open")).toBeFocused();
    expect(removes(sent)).toHaveLength(0);
    await tid(page, "repos-remove-open").click(); // a second opening starts from the defaults again
    await sheet(page, "repos-remove-sandbox").uncheck();
    await page.keyboard.press("Escape");
    await expect(page.locator(DIALOG)).toHaveCount(0);
    await tid(page, "repos-remove-open").click();
    await expect(sheet(page, "repos-remove-sandbox")).toBeChecked();
    expect(removes(sent)).toHaveLength(0);
    expect(appErrors).toEqual([]);
  });

  test("Remove sends one POST with the default ticks, says it was removed, and re-reads the list", async ({ page }) => {
    const { sent, appErrors } = await setup(page, { admin: true });
    await openRepos(page);
    await openRow(page, "acme/widgets");
    const reads = repoGets(sent).length;
    await tid(page, "repos-remove-open").click();
    await sheet(page, "repos-remove-confirm").click();
    await expect(sheet(page, "repos-remove-done")).toHaveText("Removed.");
    await expect(sheet(page, "repos-remove-machine")).toContainText("stops the engine and cleans up");
    await expect(sheet(page, "repos-remove-pr-line")).toHaveCount(0);
    await expect(sheet(page, "repos-remove-confirm")).toBeHidden();
    expect(removes(sent)).toHaveLength(1);
    expect(removes(sent)[0]!.path).toBe(`/api/runners/repos/${FX.repos.none.id}/remove`);
    expect(JSON.parse(removes(sent)[0]!.body!)).toEqual({ delete_sandbox: true, removal_pr: false });
    await expect.poll(() => repoGets(sent).length).toBeGreaterThan(reads);
    await sheet(page, "repos-remove-cancel").click(); // "Close" once it is done
    await expect(page.locator(DIALOG)).toHaveCount(0);
    expect(appErrors).toEqual([]);
  });

  test("with the PR ticked and the sandbox unticked the POST says so, and the answer shows 'Opened PR #41' with its GitHub link", async ({ page }) => {
    const { sent, appErrors } = await setup(page, { admin: true, remove: () => ({ status: 200, json: FX.answers.pr_opened }) });
    await openRepos(page);
    await openRow(page, "acme/widgets");
    await tid(page, "repos-remove-open").click();
    await sheet(page, "repos-remove-sandbox").uncheck();
    await sheet(page, "repos-remove-pr").check();
    await sheet(page, "repos-remove-confirm").click();
    await expect(sheet(page, "repos-remove-pr-line")).toHaveText("Opened PR #41");
    const link = sheet(page, "repos-remove-pr-link");
    await expect(link).toHaveAttribute("href", "https://github.com/acme/widgets/pull/41");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(JSON.parse(removes(sent)[0]!.body!)).toEqual({ delete_sandbox: false, removal_pr: true });
    expect(appErrors).toEqual([]);
  });

  test("a PR that could not be opened says why in the app's own words, and the removal still reads as done", async ({ page }) => {
    const { appErrors } = await setup(page, { admin: true, remove: () => ({ status: 200, json: FX.answers.pr_code }) });
    await openRepos(page);
    await openRow(page, "acme/widgets");
    await tid(page, "repos-remove-open").click();
    await sheet(page, "repos-remove-pr").check();
    await sheet(page, "repos-remove-confirm").click();
    await expect(sheet(page, "repos-remove-done")).toHaveText("Removed.");
    await expect(sheet(page, "repos-remove-pr-line")).toContainText("No merged install PR was found");
    await expect(sheet(page, "repos-remove-pr-link")).toHaveCount(0);
    await expect(page.locator(DIALOG)).not.toContainText("install_pr_not_merged");
    expect(appErrors).toEqual([]);
  });

  test("a refusal is a sentence of the app's own, the ticks stay, and the person can try again", async ({ page }) => {
    let reply: { status: number; json: unknown } = { status: 409, json: { error: { code: "setup_running", message: "server text that must never show", request_id: "req_test" } } };
    const { sent, appErrors } = await setup(page, { admin: true, remove: () => reply });
    await openRepos(page);
    await openRow(page, "acme/widgets");
    await tid(page, "repos-remove-open").click();
    await sheet(page, "repos-remove-pr").check();
    await sheet(page, "repos-remove-confirm").click();
    await expect(sheet(page, "repos-remove-error")).toHaveText("Wait for the install to finish, or let it fail, then remove.");
    await expect(page.locator(DIALOG)).not.toContainText("server text");
    await expect(sheet(page, "repos-remove-pr")).toBeChecked();
    reply = { status: 200, json: FX.answers.queued_no_pr };
    await sheet(page, "repos-remove-confirm").click();
    await expect(sheet(page, "repos-remove-done")).toHaveText("Removed.");
    expect(removes(sent)).toHaveLength(2);
    expect(appErrors).toEqual([]);
  });

  test("a repo whose machine is offline has the sheet explain that the machine will stop and clean up when it reconnects", async ({ page }) => {
    const { appErrors } = await setup(page, { admin: true });
    await openRepos(page);
    await openRow(page, "acme/docs");
    await expect(tid(page, "repos-removal")).toHaveCount(3); // the row line stays while the sheet is open
    await tid(page, "repos-remove-open").click();
    await expect(sheet(page, "repos-remove-waiting")).toHaveText("Studio box שלום will stop and clean up when it reconnects.");
    expect(await sheet(page, "repos-remove-waiting").locator("bdi").evaluate((e) => e.textContent)).toBe("Studio box שלום");
    expect(appErrors).toEqual([]);
  });

  test("a member sees the button disabled with the explanation, and nothing can be sent", async ({ page }) => {
    const { sent, appErrors } = await setup(page, { admin: false });
    await openRepos(page);
    await openRow(page, "acme/widgets");
    await expect(tid(page, "repos-remove-open")).toBeDisabled();
    await expect(tid(page, "repos-settings-admin-only")).toHaveText("Only owners and admins can change this.");
    await expect(page.locator(DIALOG)).toHaveCount(0);
    expect(removes(sent)).toHaveLength(0);
    expect(appErrors).toEqual([]);
  });

  test("the sheet and the row lines have no serious or critical accessibility violation", async ({ page }) => {
    await setup(page, { admin: true });
    await openRepos(page);
    await openRow(page, "acme/docs");
    await tid(page, "repos-remove-open").click();
    await expect(page.locator(DIALOG)).toBeVisible();
    const res = await new AxeBuilder({ page }).include(DIALOG).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
    expect(res.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.impact} ${v.id}`)).toEqual([]);
  });
  test("MC-12: the box 'Also delete server' shows the server's name in <bdi> and its stored monthly price, and ticking it swaps the stop line and the sandbox box for one line", async ({ page }) => {
    const { sent, appErrors } = await setup(page, { admin: true, servers: FX.servers.one });
    await openRepos(page);
    await openRow(page, "acme/widgets");
    await tid(page, "repos-remove-open").click();
    const box = sheet(page, "repos-remove-server");
    await expect(box).toBeVisible();
    await expect(box).not.toBeChecked();
    await expect(page.locator(`${DIALOG} label`).filter({ hasText: "Also delete server" })).toHaveText("Also delete server Studio server שלום (stops €5.1051 a month)");
    expect(await sheet(page, "repos-remove-server-name").evaluate((e) => e.tagName)).toBe("BDI");
    expect(sent.filter((s) => s.path.startsWith("/api/v1/machine-servers")).map((s) => s.path)).toEqual([`/api/v1/machine-servers?repo_id=${FX.repos.none.id}`]);
    await expect(sheet(page, "repos-remove-sandbox")).toBeVisible();
    await box.check();
    await expect(sheet(page, "repos-remove-sandbox")).toHaveCount(0);
    await expect(sheet(page, "repos-remove-stop")).toHaveCount(0);
    await expect(sheet(page, "repos-remove-server-fact")).toContainText("sandbox and snapshots");
    await expect(page.locator(DIALOG)).not.toContainText(/undefined|null|NaN/);
    await box.uncheck(); // the undo: back to the plain removal's two lines
    await expect(sheet(page, "repos-remove-sandbox")).toBeChecked();
    await expect(sheet(page, "repos-remove-server-fact")).toHaveCount(0);
    expect(removes(sent)).toHaveLength(0);
    expect(serverRemoves(sent)).toHaveLength(0);
    expect(appErrors).toEqual([]);
  });

  test("MC-12: ticked, confirming sends one request to the server's route and none to the plain removal, and the answer says the server is being deleted", async ({ page }) => {
    const { sent, appErrors } = await setup(page, { admin: true, servers: FX.servers.one });
    await openRepos(page);
    await openRow(page, "acme/widgets");
    const reads = repoGets(sent).length;
    await tid(page, "repos-remove-open").click();
    await sheet(page, "repos-remove-server").check();
    await sheet(page, "repos-remove-pr").check();
    await sheet(page, "repos-remove-confirm").click();
    await expect(sheet(page, "repos-remove-done")).toHaveText("Removed.");
    await expect(sheet(page, "repos-remove-server-done")).toContainText("The server is being deleted");
    await expect(sheet(page, "repos-remove-server-done")).toContainText("removal PR is opened with it");
    await expect(sheet(page, "repos-remove-machine")).toHaveCount(0);
    expect(removes(sent)).toHaveLength(0);
    expect(serverRemoves(sent)).toHaveLength(1);
    expect(serverRemoves(sent)[0]!.path).toBe(`/api/v1/machine-servers/${FX.servers.one.servers[0].id}/delete-with-project`);
    expect(JSON.parse(serverRemoves(sent)[0]!.body!)).toEqual({ repo_id: FX.repos.none.id, removal_pr: true });
    await expect.poll(() => repoGets(sent).length).toBeGreaterThan(reads);
    expect(appErrors).toEqual([]);
  });

  test("MC-12: a box ticked and then unticked sends the plain removal request", async ({ page }) => {
    const { sent, appErrors } = await setup(page, { admin: true, servers: FX.servers.one });
    await openRepos(page);
    await openRow(page, "acme/widgets");
    await tid(page, "repos-remove-open").click();
    await sheet(page, "repos-remove-server").check();
    await sheet(page, "repos-remove-server").uncheck();
    await sheet(page, "repos-remove-confirm").click();
    await expect(sheet(page, "repos-remove-done")).toHaveText("Removed.");
    expect(serverRemoves(sent)).toHaveLength(0);
    expect(JSON.parse(removes(sent)[0]!.body!)).toEqual({ delete_sandbox: true, removal_pr: false });
    expect(appErrors).toEqual([]);
  });

  test("MC-12: a repo whose machine is not one of our servers has no box, and the sheet is the same two boxes as before", async ({ page }) => {
    const { appErrors } = await setup(page, { admin: true });
    await openRepos(page);
    await openRow(page, "acme/widgets");
    await tid(page, "repos-remove-open").click();
    await expect(sheet(page, "repos-remove-sandbox")).toBeVisible();
    await expect(sheet(page, "repos-remove-server")).toHaveCount(0);
    await expect(page.locator(`${DIALOG} input[type="checkbox"]`)).toHaveCount(2);
    expect(appErrors).toEqual([]);
  });

  test("MC-12: a refused server delete is a sentence of the app's own, the ticks stay, and nothing reads as removed", async ({ page }) => {
    const { sent, appErrors } = await setup(page, { admin: true, servers: FX.servers.one, serverDelete: () => ({ status: 409, json: { error: { code: "project_not_on_server", message: "server text that must never show", request_id: "req_test" } } }) });
    await openRepos(page);
    await openRow(page, "acme/widgets");
    await tid(page, "repos-remove-open").click();
    await sheet(page, "repos-remove-server").check();
    await sheet(page, "repos-remove-confirm").click();
    await expect(sheet(page, "repos-remove-error")).toHaveText("This project isn't on that server any more. Close this and open it again.");
    await expect(page.locator(DIALOG)).not.toContainText("server text");
    await expect(sheet(page, "repos-remove-server")).toBeChecked();
    await expect(sheet(page, "repos-remove-done")).toHaveCount(0);
    expect(serverRemoves(sent)).toHaveLength(1);
    expect(appErrors).toEqual([]);
  });

  test("MC-12: the sheet with the server box has no serious or critical accessibility violation", async ({ page }) => {
    await setup(page, { admin: true, servers: FX.servers.one });
    await openRepos(page);
    await openRow(page, "acme/widgets");
    await tid(page, "repos-remove-open").click();
    await sheet(page, "repos-remove-server").check();
    const res = await new AxeBuilder({ page }).include(DIALOG).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
    expect(res.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.impact} ${v.id}`)).toEqual([]);
  });
});
