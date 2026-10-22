// apps/workspace/e2e/vercel.spec.ts
//
// D#598 P8d-3b: the Vercel connection app, against the built cloud dist served by fixture-server.mjs. Every 2xx body comes
// from the contract fixtures the real routes wrote (packages/api/fixtures/v1/**: getVercelConnectionDetails for the state,
// connectVercel and rotateVercelConnection for the writes); every 4xx and the bodiless 204 are mocked inline with the
// envelope the route really answers (pinned in packages/api/test/vercel-connection-writes.test.ts).
// One test per C14 state: not connected, connected, check failed, revoked or expired, rotating.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";
import { bootToDesktop } from "./helpers/boot";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const V1 = join(SCRIPT_DIR, "..", "..", "..", "packages", "api", "fixtures", "v1");
const fixture = (...p: string[]) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
const D = "getVercelConnectionDetails";
const NOT_CONNECTED = fixture(D, "200-not-connected.json");
const CONNECTED = fixture(D, "200-connected-team.json");
const UNAVAILABLE = fixture(D, "200-names-unavailable.json");
const CHECK_PASSED = fixture(D, "200-check-passed.json");
const CHECK_FAILED = fixture(D, "200-check-cannot-read.json");
const REVOKED = fixture(D, "200-revoked-from-check.json");

// A canary that appears nowhere else: any trace of it is a leak.
const TOKEN = "zq7canaryVTOK4d2b91xxwv"; // gitleaks:allow
const CSP = "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
const VC = `#windows-container .fulc-window[data-app-id="vercel"]`;
const tid = (page: Page, id: string) => page.locator(`${VC} [data-testid="${id}"]`);

interface Mock { details: Record<string, unknown>; sent: { method: string; body: string | null }[]; detailsGets: number; getStatus?: number; putStatus?: { status: number; json: unknown } }

const refusal = (status: number, code: string, path?: string) => ({
  status,
  json: { error: { code, message: `the token ${TOKEN} was not accepted`, request_id: "r1" }, ...(path ? { details: [{ path, code }] } : {}) },
});

async function setup(page: Page, opts: { admin?: boolean; details: Record<string, unknown>; getStatus?: number }) {
  const errors: string[] = [];
  const urls: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text());
  });
  page.on("request", (r) => urls.push(r.url()));
  await page.addInitScript(() => {
    const g = window as unknown as { __tt: string[] };
    g.__tt = [];
    document.addEventListener("securitypolicyviolation", (e) => g.__tt.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  await page.route((u) => u.pathname === "/", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": CSP } });
  });
  const mock: Mock = { details: structuredClone(opts.details), sent: [], detailsGets: 0, getStatus: opts.getStatus };
  await page.route("**/api/cloud/auth/me", async (route: Route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), is_admin: !!opts.admin } });
  });
  await page.route("**/api/v1/events", (route) => route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: idle\ndata: {}\n\n" }));
  await page.route("**/api/v1/vercel-connection**", async (route) => {
    const req = route.request();
    const method = req.method();
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (method === "GET") {
      mock.detailsGets++;
      if (mock.getStatus) return json(mock.getStatus, { error: { code: "boom", message: `internal ${TOKEN}`, request_id: "r2" } });
      return json(200, mock.details);
    }
    mock.sent.push({ method, body: req.postData() });
    if (mock.putStatus) return json(mock.putStatus.status, mock.putStatus.json);
    if (method === "DELETE") {
      mock.details = structuredClone(NOT_CONNECTED);
      return route.fulfill({ status: 204 });
    }
    // The state a successful write leaves behind (the details route derives it; here the stored row is the connected fixture).
    mock.details = structuredClone(CONNECTED);
    return json(method === "POST" ? 201 : 200, fixture(method === "POST" ? "connectVercel" : "rotateVercelConnection", method === "POST" ? "201-connected.json" : "200-rotated.json"));
  });
  await bootToDesktop(page);
  await openApp(page);
  return { mock, errors, urls };
}

async function openApp(page: Page) {
  await page.locator('.dock-icon[data-app-id="vercel"]').click();
  await expect(page.locator(VC)).toBeVisible();
  await expect(page.locator(VC)).not.toHaveClass(/opening/);
}

async function expectNoToken(page: Page, urls: string[]) {
  const held = await page.evaluate(() => {
    const parts = [document.documentElement.outerHTML, location.href, JSON.stringify(localStorage), JSON.stringify(sessionStorage)];
    document.querySelectorAll("input").forEach((el) => parts.push((el as HTMLInputElement).value));
    return parts.join("\n");
  });
  for (const part of [TOKEN, TOKEN.slice(0, 6), TOKEN.slice(-6)]) {
    expect(held.includes(part), `the browser holds "${part}"`).toBe(false);
    expect(urls.some((u) => u.includes(part)), `a request URL holds "${part}"`).toBe(false);
  }
}

test.describe("D#598 P8d-3b: Vercel connection app (mocked API)", () => {
  test("not connected: says so; an admin gets the connect form with a masked token field", async ({ page }) => {
    const { errors } = await setup(page, { admin: true, details: NOT_CONNECTED });
    await expect(tid(page, "vc-none")).toHaveText("Vercel is not connected.");
    await expect(tid(page, "vc-token")).toHaveAttribute("type", "password");
    await expect(tid(page, "vc-token")).toHaveAttribute("autocomplete", "off");
    await expect(tid(page, "vc-save")).toHaveText("Connect Vercel");
    await expect(tid(page, "vc-cancel")).toBeHidden();
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { __tt: string[] }).__tt)).toEqual([]);
  });

  test("not connected: a member reads it and is told whom to ask; there is no form", async ({ page }) => {
    await setup(page, { admin: false, details: NOT_CONNECTED });
    await expect(tid(page, "vc-none")).toBeVisible();
    await expect(tid(page, "vc-readonly")).toHaveText("Ask an owner or admin to connect it.");
    await expect(tid(page, "vc-form")).toHaveCount(0);
  });

  test("connected: shows the team and project names, never an id, and no check yet", async ({ page }) => {
    await setup(page, { admin: true, details: CONNECTED });
    await expect(tid(page, "vc-connected")).toHaveText("Vercel is connected.");
    await expect(tid(page, "vc-team-name")).toHaveText("Acme Studio");
    await expect(tid(page, "vc-projects")).toHaveText(/api\s*web-app/);
    await expect(tid(page, "vc-check")).toHaveText("No environment check has run yet.");
    await expect(tid(page, "vc-form")).toHaveCount(0);
    expect(await page.locator(VC).innerText()).not.toMatch(/prj_|team_/);
  });

  test("connected: a personal token reads as the personal account; a passed check shows its sentence", async ({ page }) => {
    await setup(page, { admin: true, details: CHECK_PASSED });
    await expect(tid(page, "vc-team-name")).toHaveText("Your personal account");
    await expect(tid(page, "vc-check")).toContainText("DATABASE_URL is set on web-app.");
    await expect(tid(page, "vc-check-failed")).toHaveCount(0);
  });

  test("connected, names unavailable: says the names could not be loaded and keeps the connection", async ({ page }) => {
    await setup(page, { admin: true, details: UNAVAILABLE });
    await expect(tid(page, "vc-connected")).toBeVisible();
    await expect(tid(page, "vc-names-unavailable")).toContainText("could not be loaded");
    await expect(tid(page, "vc-actions")).toBeVisible();
  });

  test("check failed: names which check (the project it could not read), and the connection stays", async ({ page }) => {
    await setup(page, { admin: true, details: CHECK_FAILED });
    await expect(tid(page, "vc-check-failed")).toContainText("The last environment check failed.");
    await expect(tid(page, "vc-check-failed")).toContainText(CHECK_FAILED.check.sentence);
    await expect(tid(page, "vc-connected")).toBeVisible();
    await expect(tid(page, "vc-revoked")).toHaveCount(0);
  });

  test("revoked or expired, from the latest check: says so, shows what the check said, offers Replace token", async ({ page }) => {
    await setup(page, { admin: true, details: REVOKED });
    await expect(tid(page, "vc-revoked")).toContainText("Vercel is not accepting this token.");
    await expect(tid(page, "vc-revoked-check")).toHaveText(REVOKED.check.sentence);
    await expect(tid(page, "vc-replace")).toBeEnabled();
    await expect(tid(page, "vc-facts")).toHaveCount(0);
  });

  test("a member sees every state read-only: no Replace, no Disconnect", async ({ page }) => {
    await setup(page, { admin: false, details: REVOKED });
    await expect(tid(page, "vc-revoked")).toBeVisible();
    await expect(tid(page, "vc-readonly")).toHaveText("Ask an owner or admin to change this.");
    await expect(tid(page, "vc-replace")).toHaveCount(0);
    await expect(tid(page, "vc-disconnect")).toHaveCount(0);
  });

  test("rotating: Replace token opens the form (no team field); the new token is sent once, the field emptied, the token never kept", async ({ page }) => {
    const { mock, urls } = await setup(page, { admin: true, details: REVOKED });
    await tid(page, "vc-replace").click();
    await expect(tid(page, "vc-form-help")).toContainText("The current one stays in use until Vercel accepts the new one.");
    await expect(tid(page, "vc-team")).toBeHidden();
    await expect(tid(page, "vc-replace")).toBeDisabled();
    await tid(page, "vc-token").fill(TOKEN);
    await tid(page, "vc-save").click();
    await expect(tid(page, "vc-notice")).toHaveText("Token replaced.");
    await expect(tid(page, "vc-connected")).toBeVisible();
    await expect(tid(page, "vc-form")).toHaveCount(0);
    expect(mock.sent).toEqual([{ method: "PUT", body: JSON.stringify({ token: TOKEN }) }]);
    await expectNoToken(page, urls);
  });

  test("connect, reload: the state persists; disconnect (confirmed), reload: not connected again", async ({ page }) => {
    const { mock, urls } = await setup(page, { admin: true, details: NOT_CONNECTED });
    await tid(page, "vc-team").fill("team_abc123");
    await tid(page, "vc-token").fill(TOKEN);
    await tid(page, "vc-save").click();
    await expect(tid(page, "vc-connected")).toBeVisible();
    expect(mock.sent[0]).toEqual({ method: "POST", body: JSON.stringify({ token: TOKEN, team_id: "team_abc123" }) });
    await expectNoToken(page, urls);
    await page.reload();
    await bootToDesktop(page);
    await openApp(page);
    await expect(tid(page, "vc-team-name")).toHaveText("Acme Studio");
    await page.evaluate(() => { (window as unknown as { fulcConfirm: () => Promise<boolean> }).fulcConfirm = async () => true; });
    await tid(page, "vc-disconnect").click();
    await expect(tid(page, "vc-notice")).toHaveText("Vercel is disconnected.");
    await expect(tid(page, "vc-none")).toBeVisible();
    await page.reload();
    await bootToDesktop(page);
    await openApp(page);
    await expect(tid(page, "vc-none")).toBeVisible();
    expect(mock.sent.map((s) => s.method)).toEqual(["POST", "DELETE"]);
  });

  test("a disconnect that finds it already disconnected (404 not_connected) re-reads and shows the not-connected state", async ({ page }) => {
    const { mock } = await setup(page, { admin: true, details: CONNECTED });
    await expect(tid(page, "vc-connected")).toBeVisible();
    mock.putStatus = refusal(404, "not_connected");
    mock.details = structuredClone(NOT_CONNECTED);
    await page.evaluate(() => { (window as unknown as { fulcConfirm: () => Promise<boolean> }).fulcConfirm = async () => true; });
    await tid(page, "vc-disconnect").click();
    await expect(tid(page, "vc-none")).toBeVisible();
    await expect(tid(page, "vc-notice")).toHaveText("Vercel is disconnected.");
    expect(mock.sent.map((s) => s.method)).toEqual(["DELETE"]);
  });

  test("a refused token and a bad team id show the app's own sentences, never the server's text", async ({ page }) => {
    const { mock, urls } = await setup(page, { admin: true, details: NOT_CONNECTED });
    mock.putStatus = refusal(422, "token_rejected", "token");
    await tid(page, "vc-token").fill(TOKEN);
    await tid(page, "vc-save").click();
    await expect(tid(page, "vc-token-error")).toHaveText("Vercel didn't accept that token. Check that it hasn't expired and can see your projects.");
    mock.putStatus = refusal(422, "invalid_team_id", "team_id");
    await tid(page, "vc-token").fill(TOKEN);
    await tid(page, "vc-save").click();
    await expect(tid(page, "vc-team-error")).toHaveText("That doesn't look like a Vercel team id. It starts with team_.");
    await expect(tid(page, "vc-token")).toHaveValue("");
    expect(await page.locator(VC).innerText()).not.toContain(TOKEN);
    await expectNoToken(page, urls);
  });

  test("a failed load says so, shows no state and offers Try again; none of the server's text appears", async ({ page }) => {
    const { mock } = await setup(page, { admin: true, details: CONNECTED, getStatus: 500 });
    await expect(tid(page, "vc-load-error")).toContainText("The Vercel connection could not be loaded.");
    await expect(tid(page, "vc-connected")).toHaveCount(0);
    expect(await page.locator(VC).innerText()).not.toContain(TOKEN);
    mock.getStatus = undefined;
    await tid(page, "vc-retry").click();
    await expect(tid(page, "vc-connected")).toBeVisible();
    await expect(tid(page, "vc-load-error")).toHaveCount(0);
  });
});
