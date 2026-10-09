// apps/workspace/e2e/repos-allowances.spec.ts
//
// D#6 R7d: the Repos app's sandbox allowance panel on the built cloud dist, at the desktop, tablet and phone projects. Every
// call is answered by page.route(); the 4xx bodies are the ones runner-cloud's sandboxAllowances.ts really sends (the closed
// refusal sits beside `error`, not in `details`). The page carries the production CSP and Trusted Types.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";
import { bootToDesktop } from "./helpers/boot";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const V1 = join(SCRIPT_DIR, "..", "..", "..", "packages", "api", "fixtures", "v1");
const readFixture = (...p: string[]) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
const REPOS = readFixture("listRepos", "200-page.json");
const SETTINGS = readFixture("getRepoSettings", "200-ok.json");
const WEB = REPOS.data[0].id as string;
const NAME = "acme/widgets";
const CSP = "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
const APP = `#windows-container .fulc-window[data-app-id="repos"]`;
const tid = (page: Page, id: string) => page.locator(`${APP} [data-testid="${id}"]`);

const A = { kind: "domain", value: "registry.npmjs.org", access: "connect", reason: "install packages" };
const B = { kind: "path", value: "/nix/store", access: "read", reason: "the dev shell" };
const approvedAt = "2026-10-09T00:00:00.000Z";
const approvedView = (over: Record<string, unknown> = {}) => ({
  repo_id: WEB, execution_mode: "runner_local", in_use: true, set_aside: false, can_change: true,
  approved: { version: 1, entries: [A], command_timeout_s: 600, set_sha256: "ab".repeat(32), approved_at: approvedAt },
  limits: { max_entries: 64, max_command_timeout_s: 1800 }, ...over,
});
const file = (body: unknown) => ({ name: "runner-sandbox.json", mimeType: "application/json", buffer: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)) });

interface Mock { view: unknown; puts: string[]; getStatus: number; putReply?: () => Promise<{ status: number; json: unknown }> }

async function setup(page: Page, opts: { view?: unknown; getStatus?: number } = {}) {
  const appErrors: string[] = [];
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && appErrors.push(m.text()));
  page.on("pageerror", (e) => appErrors.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP ${e.violatedDirective}`)));
  await page.route((u) => u.pathname === "/", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": CSP } });
  });
  const mock: Mock = { view: opts.view ?? approvedView(), puts: [], getStatus: opts.getStatus ?? 200 };
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/cloud/auth/me", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), is_admin: true } });
  });
  await page.route("**/api/v1/repos**", (route) => {
    const u = new URL(route.request().url());
    return json(route, 200, u.pathname.endsWith("/settings") ? SETTINGS : REPOS);
  });
  await page.route("**/api/runners/repos/*/sandbox-allowances", async (route) => {
    const req = route.request();
    expect(new URL(req.url()).pathname).toBe(`/api/runners/repos/${WEB}/sandbox-allowances`);
    if (req.method() === "GET") return mock.getStatus === 200 ? json(route, 200, mock.view) : json(route, mock.getStatus, { error: { code: "internal", message: "SECRET" } });
    mock.puts.push(req.postData() ?? "");
    const r = mock.putReply ? await mock.putReply() : { status: 200, json: { ...(mock.view as object), changed: true } };
    return json(route, r.status, r.json);
  });
  await bootToDesktop(page);
  await page.locator('.dock-icon[data-app-id="repos"]').click();
  await expect(page.locator(APP)).toBeVisible();
  await tid(page, "repos-open").first().click();
  await expect(tid(page, "repos-allow")).toBeVisible();
  return { mock, appErrors };
}

test.describe("D#6 R7d: sandbox allowance panel (mocked API)", () => {
  test("an admin sees the approved set, uploads a file and sees the diff; approve waits for the typed name, then sends exactly set and confirm_repo", async ({ page }) => {
    const { mock, appErrors } = await setup(page);
    await expect(tid(page, "repos-allow-approved").locator("[data-testid=repos-allow-entry]")).toHaveCount(1);
    await expect(tid(page, "repos-allow-timeout")).toHaveText("Command timeout: 600 seconds.");
    await expect(tid(page, "repos-allow-approve")).toHaveCount(0); // nothing picked yet
    await tid(page, "repos-allow-file").setInputFiles(file({ entries: [A, B], command_timeout_s: 900 }));
    await expect(tid(page, "repos-allow-pending").locator("[data-testid=repos-allow-entry]")).toHaveCount(2);
    await expect(tid(page, "repos-allow-diff")).toHaveText("Changes: 1 entry added, timeout 600 to 900.");
    await expect(tid(page, "repos-allow-approve")).toBeDisabled();
    await tid(page, "repos-allow-name").fill("acme/widget");
    await expect(tid(page, "repos-allow-approve")).toBeDisabled();
    await tid(page, "repos-allow-name").fill(NAME);
    await expect(tid(page, "repos-allow-approve")).toBeEnabled();
    mock.view = approvedView({ approved: { version: 2, entries: [A, B], command_timeout_s: 900, set_sha256: "cd".repeat(32), approved_at: approvedAt } });
    await tid(page, "repos-allow-approve").click();
    await expect(tid(page, "repos-allow-done")).toHaveText("Approved. It applies from the next job.");
    expect(mock.puts.map((p) => JSON.parse(p))).toEqual([{ set: { entries: [A, B], command_timeout_s: 900 }, confirm_repo: NAME }]);
    await expect(tid(page, "repos-allow-approved").locator("[data-testid=repos-allow-entry]")).toHaveCount(2);
    await expect(tid(page, "repos-allow-approve")).toHaveCount(0); // the pending set is cleared once approved
    expect(appErrors).toEqual([]);
  });

  test("a set-aside approval can be approved again: the same file is a change, the name is still required, and the PUT carries set and confirm_repo", async ({ page }) => {
    const { mock, appErrors } = await setup(page, { view: approvedView({ set_aside: true, in_use: false }) });
    await tid(page, "repos-allow-file").setInputFiles(file({ entries: [A], command_timeout_s: 600 }));
    await expect(tid(page, "repos-allow-diff")).toHaveText("This set was set aside. Approving it again restores it.");
    await expect(tid(page, "repos-allow-approve")).toBeDisabled();
    await tid(page, "repos-allow-name").fill(NAME);
    await expect(tid(page, "repos-allow-approve")).toBeEnabled();
    mock.view = approvedView();
    await tid(page, "repos-allow-approve").click();
    await expect(tid(page, "repos-allow-done")).toHaveText("Approved. It applies from the next job.");
    expect(mock.puts.map((p) => JSON.parse(p))).toEqual([{ set: { entries: [A], command_timeout_s: 600 }, confirm_repo: NAME }]);
    expect(appErrors).toEqual([]);
  });

  test("while the approve is in flight the button reads Approving and is off; an error keeps the set pending with a sentence of the app's own", async ({ page }) => {
    const { mock, appErrors } = await setup(page);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    mock.putReply = async () => { await gate; return { status: 500, json: { error: { code: "internal", message: "SECRET SERVER TEXT" } } }; };
    await tid(page, "repos-allow-file").setInputFiles(file({ entries: [B], command_timeout_s: 60 }));
    await tid(page, "repos-allow-name").fill(NAME);
    await tid(page, "repos-allow-approve").click();
    await expect(tid(page, "repos-allow-approve")).toHaveText("Approving...");
    await expect(tid(page, "repos-allow-approve")).toBeDisabled();
    await expect(tid(page, "repos-allow-file")).toBeDisabled();
    release();
    await expect(tid(page, "repos-allow-save-error")).toHaveText("That couldn't be saved. Try again.");
    await expect(page.locator(APP)).not.toContainText("SECRET SERVER TEXT");
    await expect(tid(page, "repos-allow-pending")).toBeVisible();
    expect(appErrors).toEqual([]);
  });

  test("a floor-refused upload shows the server's closed reason and the entry; nothing the server wrote is shown", async ({ page }) => {
    const { mock } = await setup(page);
    mock.putReply = async () => ({ status: 400, json: { error: { code: "sandbox_allowance_refused", message: "<b>RAW</b> refused" }, reason: "path_credential", index: 1 } });
    await tid(page, "repos-allow-file").setInputFiles(file({ entries: [A, { kind: "path", value: "/x/.ssh", access: "read", reason: "keys" }], command_timeout_s: 60 }));
    await tid(page, "repos-allow-name").fill(NAME);
    await tid(page, "repos-allow-approve").click();
    await expect(tid(page, "repos-allow-save-error")).toHaveText("The server refused this set: a path holds credentials (entry 2).");
    await expect(page.locator(APP)).not.toContainText("RAW");
  });

  test("a malformed, oversized or non-JSON file is refused in a closed sentence and nothing is sent", async ({ page }) => {
    const { mock } = await setup(page);
    const cases: Array<[unknown, string]> = [
      ["{ not json", "That file isn't valid JSON."],
      [{ entries: [{ kind: "path", value: "", access: "read", reason: "x" }] }, "That file isn't a sandbox allowance file."],
      ["x".repeat(129 * 1024), "That file is too big to be an allowance file."],
    ];
    for (const [body, sentence] of cases) {
      await tid(page, "repos-allow-file").setInputFiles(file(body));
      await expect(tid(page, "repos-allow-upload-error")).toHaveText(sentence);
      await expect(tid(page, "repos-allow-approve")).toHaveCount(0);
    }
    expect(mock.puts).toHaveLength(0);
  });

  test("a member sees the approved set read-only: no file control, no approve, no request that writes", async ({ page }) => {
    const { mock, appErrors } = await setup(page, { view: approvedView({ can_change: false }) });
    await expect(tid(page, "repos-allow-approved").locator("[data-testid=repos-allow-entry]")).toHaveCount(1);
    await expect(tid(page, "repos-allow-admin-only")).toHaveText("Only owners and admins can change this.");
    await expect(tid(page, "repos-allow-file")).toHaveCount(0);
    await expect(tid(page, "repos-allow-approve")).toHaveCount(0);
    expect(mock.puts).toHaveLength(0);
    expect(appErrors).toEqual([]);
  });

  test("approving an empty set needs no typed name and sends only the set", async ({ page }) => {
    const { mock } = await setup(page);
    mock.view = approvedView({ approved: { version: 2, entries: [], command_timeout_s: null, set_sha256: "ef".repeat(32), approved_at: approvedAt }, in_use: false });
    await tid(page, "repos-allow-file").setInputFiles(file({ entries: [] }));
    await expect(tid(page, "repos-allow-pending-empty")).toBeVisible();
    await expect(tid(page, "repos-allow-name")).toHaveCount(0);
    await expect(tid(page, "repos-allow-approve")).toBeEnabled();
    await tid(page, "repos-allow-approve").click();
    await expect(tid(page, "repos-allow-done")).toBeVisible();
    expect(mock.puts.map((p) => JSON.parse(p))).toEqual([{ set: { entries: [] } }]);
    await expect(tid(page, "repos-allow-empty")).toHaveText("The approved set is empty: no extra access.");
  });

  test("entry values are text, never markup, and an empty value never shows as a blank, null or undefined", async ({ page }) => {
    const hostile = { kind: "path", value: "<img src=x onerror=window.__pwned=1>", access: "read", reason: "<script>window.__pwned=1</script>" };
    const blank = { kind: "path", value: "", access: "read", reason: "x" };
    const approved = { version: 1, entries: [hostile, blank], command_timeout_s: 60, set_sha256: "ab".repeat(32), approved_at: approvedAt };
    const { appErrors } = await setup(page, { view: approvedView({ approved }) });
    await expect(tid(page, "repos-allow-value").first()).toHaveText("<img src=x onerror=window.__pwned=1>");
    expect(await page.locator(`${APP} .repos-allow img, ${APP} .repos-allow script`).count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    await expect(tid(page, "repos-allow-value").nth(1)).toHaveText("not given");
    expect(await page.locator(APP).innerText()).not.toMatch(/\b(null|undefined|NaN)\b/i);
    expect(appErrors).toEqual([]);
  });

  test("no set shows its own line", async ({ page }) => {
    await setup(page, { view: approvedView({ approved: null, in_use: false }) });
    await expect(tid(page, "repos-allow-none")).toHaveText("Nothing is approved yet.");
  });

  test("a failed load shows the app's line without the server's text", async ({ page }) => {
    await setup(page, { getStatus: 500 });
    await expect(tid(page, "repos-allow-error")).toHaveText("Allowances aren't available right now.");
    await expect(page.locator(APP)).not.toContainText("SECRET");
  });

  test("the panel never widens the window: no horizontal overflow at this project's size", async ({ page }) => {
    await setup(page);
    await tid(page, "repos-allow-file").setInputFiles(file({ entries: [{ kind: "path", value: "/" + "a".repeat(400), access: "read", reason: "r ".repeat(200).trim() }], command_timeout_s: 60 }));
    await expect(tid(page, "repos-allow-name")).toBeVisible();
    const over = await page.locator(`${APP} .repos-app`).evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(over).toBeLessThanOrEqual(1);
  });
});
