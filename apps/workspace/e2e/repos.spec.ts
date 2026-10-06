// apps/workspace/e2e/repos.spec.ts
//
// D#37 WS-F3 (C31, C33): the Repos app on the built cloud dist. Every /api/v1 call the window makes is
// answered by page.route(): 2xx bodies from the contract fixtures, 4xx bodies inline with the code the
// route really returns named above each one. The page carries the production CSP and Trusted Types.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";
import { bootToDesktop, holdClock } from "./helpers/boot";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const V1 = join(SCRIPT_DIR, "..", "..", "..", "packages", "api", "fixtures", "v1");
const readFixture = (...p: string[]) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
const REPOS = readFixture("listRepos", "200-page.json");
const SETTINGS = readFixture("getRepoSettings", "200-ok.json");
const PATCHED = readFixture("patchRepoSettings", "200-ok.json");
const INSTALL = readFixture("getInstallUrl", "200-ok.json");
const WEB = REPOS.data[0].id as string;

const CSP =
  "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
const APP = `#windows-container .fulc-window[data-app-id="repos"]`;
const tid = (page: Page, id: string) => page.locator(`${APP} [data-testid="${id}"]`);
const ADMIN_ONLY = "Only owners and admins can change this.";

// packages/api/src/errors.ts, InvalidRoleSettingsInputError: the guard is turned off without the acknowledgement.
const ACK_422 = {
  error: { code: "invalid_role_settings_input", message: "setRepoGuardSettings: confirmation required", request_id: "req_test" },
  details: [{ path: "acknowledge_external_risk", code: "invalid" }],
};
// packages/api/src/errors.ts, InsufficientRoleError: a member (or a demoted admin) sends the PATCH anyway.
const ROLE_403 = { error: { code: "insufficient_role", message: "insufficient account role", request_id: "req_test" } };

interface Sent { method: string; path: string; search: string; body: string | null }
interface Mock { sent: Sent[]; settings: { auto_merge: boolean; block_external_auto_merge: boolean }; patchReply?: () => { status: number; json: unknown } }

async function setup(page: Page, opts: { admin?: boolean; path?: string } = {}) {
  const appErrors: string[] = [];
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && appErrors.push(m.text()));
  page.on("pageerror", (e) => appErrors.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP ${e.violatedDirective}`)));
  await page.route((u) => u.pathname === "/", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": CSP } });
  });
  const mock: Mock = { sent: [], settings: { ...SETTINGS } };
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/cloud/auth/me", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), is_admin: !!opts.admin } });
  });
  await page.route("**/api/v1/repos**", async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    mock.sent.push({ method: req.method(), path: u.pathname, search: u.search, body: req.postData() });
    if (!u.pathname.endsWith("/settings")) return json(route, 200, REPOS);
    if (req.method() === "GET") return json(route, 200, mock.settings);
    if (mock.patchReply) {
      const r = mock.patchReply();
      return json(route, r.status, r.json);
    }
    const body = JSON.parse(req.postData() ?? "{}");
    if (body.block_external_auto_merge === false && body.acknowledge_external_risk !== true) return json(route, 422, ACK_422);
    const { acknowledge_external_risk: _ack, ...change } = body;
    mock.settings = Object.keys(change).join() === "auto_merge" && change.auto_merge === true ? PATCHED : { ...mock.settings, ...change };
    return json(route, 200, mock.settings);
  });
  await bootToDesktop(page, { url: opts.path });
  return { mock, appErrors };
}

/** Records anything that puts the install URL (or its signed state) into the document or the console. */
async function watchLeaks(page: Page) {
  const leaks: string[] = [];
  await page.exposeFunction("__leak", (m: string) => leaks.push(m));
  await page.addInitScript(() => {
    const bad = (t: string | null | undefined) => !!t && (t.includes("state=") || t.includes("installations/new"));
    new MutationObserver((ms) => {
      for (const m of ms) {
        const attr = m.attributeName ? (m.target as Element).getAttribute(m.attributeName) : null;
        if (bad(m.target.textContent) || bad(attr)) (window as unknown as { __leak: (w: string) => void }).__leak("document");
      }
    }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  page.on("console", (m) => (m.text().includes("state=") || m.text().includes("installations/new")) && leaks.push("console"));
  return leaks;
}

async function openRepos(page: Page) {
  await page.locator('.dock-icon[data-app-id="repos"]').click();
  await expect(page.locator(APP)).toBeVisible();
}
const settingsGets = (m: Mock) => m.sent.filter((s) => s.method === "GET" && s.path.endsWith("/settings"));
const patches = (m: Mock) => m.sent.filter((s) => s.method === "PATCH");

test.describe("D#37 WS-F3: Repos app (mocked API)", () => {
  test("lists repos with their install state, follows next_cursor, and marks a read-only install", async ({ page }) => {
    const readonly = { ...REPOS.data[0], id: "55555555-5555-4555-8555-555555555555", product: "site", app_kind: "team_readonly" };
    const { mock, appErrors } = await setup(page);
    await page.route("**/api/v1/repos**", (route) => {
      const u = new URL(route.request().url());
      mock.sent.push({ method: "GET", path: u.pathname, search: u.search, body: null });
      const second = u.searchParams.get("cursor") === "c1";
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(second ? { data: [REPOS.data[1], readonly], next_cursor: null } : { data: [REPOS.data[0]], next_cursor: "c1" }) });
    });
    await openRepos(page);
    await expect(tid(page, "repos-row")).toHaveCount(3);
    expect(await tid(page, "repos-state").allTextContents()).toEqual(["Installed", "Not installed", "Installed"]);
    await expect(tid(page, "repos-readonly")).toHaveText("Read-only. Install the write App to run work."); // one line, on the read-only repo only
    expect(mock.sent.filter((s) => s.path === "/api/v1/repos").map((g) => g.search)).toEqual(["", "?cursor=c1"]);
    expect(appErrors).toEqual([]); // includes any CSP or Trusted Types violation
  });

  test("a member sees the settings disabled with the explanation, and no request can change them", async ({ page }) => {
    const { mock, appErrors } = await setup(page, { admin: false });
    await openRepos(page);
    await tid(page, "repos-open").first().click();
    await expect(tid(page, "repos-auto-merge")).toBeDisabled();
    await expect(tid(page, "repos-guard")).toBeDisabled();
    await expect(tid(page, "repos-settings-admin-only")).toHaveText(ADMIN_ONLY);
    await expect(tid(page, "repos-install-team")).toBeDisabled();
    await expect(tid(page, "repos-install-team_readonly")).toBeDisabled();
    expect(settingsGets(mock)).toHaveLength(1);
    expect(patches(mock)).toHaveLength(0);
    expect(appErrors).toEqual([]);
  });

  test("an owner or admin turns auto-merge on: one settings read on open, then one PATCH with only that field", async ({ page }) => {
    const { mock, appErrors } = await setup(page, { admin: true });
    await openRepos(page);
    await expect(tid(page, "repos-install-team")).toBeEnabled();
    await tid(page, "repos-open").first().click();
    await expect(tid(page, "repos-auto-merge")).not.toBeChecked();
    expect(settingsGets(mock)).toHaveLength(1);
    expect(settingsGets(mock)[0]!.path).toBe(`/api/v1/repos/${WEB}/settings`);
    await tid(page, "repos-auto-merge").check();
    await expect(tid(page, "repos-auto-merge")).toBeChecked();
    expect(patches(mock)).toHaveLength(1);
    expect(JSON.parse(patches(mock)[0]!.body!)).toEqual({ auto_merge: true });
    await expect(tid(page, "repos-guard")).toBeChecked();
    expect(appErrors).toEqual([]);
  });

  test("turning the guard off needs the acknowledgement: the 422 shows a sentence of the app's own on the checkbox", async ({ page }) => {
    const { mock, appErrors } = await setup(page, { admin: true });
    await openRepos(page);
    await tid(page, "repos-open").first().click();
    await tid(page, "repos-guard").uncheck();
    await expect(tid(page, "repos-confirm")).toBeVisible();
    expect(patches(mock)).toHaveLength(0);
    await tid(page, "repos-guard-off").click();
    expect(JSON.parse(patches(mock)[0]!.body!)).toEqual({ block_external_auto_merge: false });
    await expect(tid(page, "repos-ack-error")).toHaveText("Tick this box to confirm before turning the guard off.");
    await expect(tid(page, "repos-ack")).toHaveAttribute("aria-invalid", "true");
    await expect(tid(page, "repos-guard")).not.toBeChecked(); // still waiting for the acknowledgement
    expect(await page.locator(APP).innerText()).not.toContain("setRepoGuardSettings"); // the server's message is never shown
    await tid(page, "repos-ack").check();
    await expect(tid(page, "repos-ack-error")).toHaveCount(0);
    await tid(page, "repos-guard-off").click();
    await expect(tid(page, "repos-confirm")).toHaveCount(0);
    expect(JSON.parse(patches(mock)[1]!.body!)).toEqual({ block_external_auto_merge: false, acknowledge_external_risk: true });
    await expect(tid(page, "repos-guard")).not.toBeChecked();
    expect(appErrors).toEqual([]);
  });

  test("a forced PATCH that comes back 403 shows the sentence, falls back to disabled, and logs no app error", async ({ page }) => {
    const { mock, appErrors } = await setup(page, { admin: true });
    mock.patchReply = () => ({ status: 403, json: ROLE_403 });
    await openRepos(page);
    await tid(page, "repos-open").first().click();
    await tid(page, "repos-auto-merge").click(); // the refusal puts the box back, so check() would report a state that did not stick
    await expect(tid(page, "repos-save-error")).toHaveText(ADMIN_ONLY);
    await expect(tid(page, "repos-auto-merge")).toBeDisabled();
    await expect(tid(page, "repos-auto-merge")).not.toBeChecked();
    expect(await page.locator(APP).innerText()).not.toContain("insufficient account role");
    expect(appErrors).toEqual([]);
  });

  for (const kind of ["team_readonly", "team"] as const) {
    test(`Install (${kind}) asks for that App kind explicitly and navigates to github.com; the URL is never in the page`, async ({ page }) => {
      const leaks = await watchLeaks(page);
      const { mock, appErrors } = await setup(page, { admin: true });
      let seen = "";
      await page.route("**/api/v1/github/install-url**", (route) => {
        const u = new URL(route.request().url());
        mock.sent.push({ method: "GET", path: u.pathname, search: u.search, body: null });
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(INSTALL) });
      });
      await page.route("https://github.com/**", (route) => {
        seen = route.request().url();
        return route.fulfill({ status: 200, contentType: "text/html", body: "<title>github</title>" });
      });
      await openRepos(page);
      await tid(page, `repos-install-${kind}`).click();
      await page.waitForURL(/github\.com/);
      expect(seen).toBe(INSTALL.url);
      expect(leaks).toEqual([]); // the URL and its state were never written into the document, an attribute, or the console
      const asks = mock.sent.filter((s) => s.path === "/api/v1/github/install-url");
      expect(asks.map((a) => a.search)).toEqual([`?app_kind=${kind}`]);
      expect(appErrors).toEqual([]);
    });
  }

  test("a 429 on the install link counts down from Retry-After and keeps both Install buttons off until it ends", async ({ page }) => {
    const { mock, appErrors } = await setup(page, { admin: true });
    let limited = true;
    await page.route("**/api/v1/github/install-url**", (route) => {
      mock.sent.push({ method: "GET", path: new URL(route.request().url()).pathname, search: "", body: null });
      return limited
        ? route.fulfill({ status: 429, contentType: "application/json", headers: { "Retry-After": "3" }, body: JSON.stringify({ error: { code: "rate_limited", message: "SECRET-SERVICE-TEXT", request_id: "r1" } }) })
        : route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ url: "https://evil.example/x" }) });
    });
    await openRepos(page);
    await holdClock(page); // the countdown is page time: only the runFor calls below move it, however slow the machine is
    await tid(page, "repos-install-team").click();
    await expect(tid(page, "repos-note")).toHaveText("Too many tries. Try again in 3 seconds.");
    await expect(tid(page, "repos-install-team")).toBeDisabled();
    await expect(tid(page, "repos-install-team_readonly")).toBeDisabled();
    await page.clock.runFor(2_000);
    await expect(tid(page, "repos-note")).toHaveText("Too many tries. Try again in 1 second.");
    expect(mock.sent.filter((s) => s.path === "/api/v1/github/install-url")).toHaveLength(1);
    await page.clock.runFor(1_000);
    await expect(tid(page, "repos-install-team")).toBeEnabled();
    await expect(tid(page, "repos-note")).toHaveText("");
    limited = false;
    await tid(page, "repos-install-team").click();
    await expect(tid(page, "repos-note")).toHaveText("Couldn't start the install. Try again.");
    expect(await page.locator("body").innerText()).not.toMatch(/SECRET-SERVICE-TEXT|undefined|NaN/);
    expect(appErrors).toEqual([]);
  });

  test("a 503 github_app_not_configured on the install link shows its own note, asks once, and never shows the server's text", async ({ page }) => {
    const { mock, appErrors } = await setup(page, { admin: true });
    await page.route("**/api/v1/github/install-url**", (route) => {
      mock.sent.push({ method: "GET", path: new URL(route.request().url()).pathname, search: "", body: null });
      return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "github_app_not_configured", message: "SECRET-SERVICE-TEXT", request_id: "r2" } }) });
    });
    await openRepos(page);
    await tid(page, "repos-install-team").click();
    await expect(tid(page, "repos-note")).toHaveText("Installing the GitHub App isn't available right now.");
    await expect(tid(page, "repos-install-team")).toBeEnabled();
    expect(mock.sent.filter((s) => s.path === "/api/v1/github/install-url")).toHaveLength(1);
    expect(await page.locator("body").innerText()).not.toMatch(/SECRET-SERVICE-TEXT|undefined|NaN/);
    expect(appErrors).toEqual([]);
  });

  test("a URL that is not on github.com is never navigated to", async ({ page }) => {
    await setup(page, { admin: true });
    await page.route("**/api/v1/github/install-url**", (route) => route.fulfill({ json: { url: "https://evil.example/installations/new" } }));
    await openRepos(page);
    await tid(page, "repos-install-team").click();
    await expect(tid(page, "repos-note")).toHaveText("Couldn't start the install. Try again.");
  });

  const RETURNS: Record<string, string> = {
    ok: "The GitHub App is installed.",
    failed: "The GitHub App install didn't finish. Try it again.",
    claimed: "That GitHub installation already belongs to another account.",
    pay_first: "Start your subscription first, then install the write App.",
    rate_limited: "Too many tries. Wait a minute, then install again.",
    "%3Cb%3Ehi": "", // an unknown value shows nothing
  };
  for (const [value, sentence] of Object.entries(RETURNS)) {
    test(`the ?install=${value} return shows one fixed sentence, or nothing for an unknown value`, async ({ page }) => {
      await setup(page, { admin: true, path: `/?install=${value}` });
      await openRepos(page);
      await expect(tid(page, "repos-note")).toHaveText(sentence);
      expect(page.url()).not.toContain("install=");
    });
  }

  test("a 401 on the list shows the app's own error line, not a reload message", async ({ page }) => {
    await setup(page, { admin: true });
    // packages/api/src/errors.ts, unauthenticated: the shared api() helper is where session loss is handled, not this app.
    await page.route("**/api/v1/repos**", (route) =>
      route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: { code: "unauthenticated", message: "no session", request_id: "req_test" } }) })
    );
    await openRepos(page);
    await expect(tid(page, "repos-load-error")).toHaveText("Repos aren't available right now.");
    expect(await page.locator(APP).innerText()).not.toMatch(/reload the page/i);
  });

  test("refresh re-reads the list and the open repo's settings; a pending confirmation is not overwritten", async ({ page }) => {
    const { mock } = await setup(page, { admin: true });
    await openRepos(page);
    await tid(page, "repos-open").first().click();
    await expect(tid(page, "repos-auto-merge")).toBeVisible();
    const lists = () => mock.sent.filter((s) => s.path === "/api/v1/repos").length;
    // D#37 C34 section 3: page.clock also fakes the performance marks that start the live client, so start it directly.
    await page.evaluate(async () => {
      const live = await import(new URL("core/cloud-live.js", document.baseURI).href);
      live.default.start();
    });
    const before = { lists: lists(), settings: settingsGets(mock).length };
    // The live client sends `refresh` on focus, at most once per 10 s.
    const focus = async () => {
      await page.clock.runFor(11_000);
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    };
    await focus();
    await expect.poll(lists).toBe(before.lists + 1);
    await expect.poll(() => settingsGets(mock).length).toBe(before.settings + 1);
    await tid(page, "repos-guard").uncheck();
    await focus();
    await expect.poll(lists).toBe(before.lists + 2);
    expect(settingsGets(mock)).toHaveLength(before.settings + 1);
    await expect(tid(page, "repos-confirm")).toBeVisible();
  });

  test("closing the window drops the subscription: 20 open and close cycles leave the subscriber count at its baseline", async ({ page }) => {
    await setup(page, { admin: true });
    await page.emulateMedia({ reducedMotion: "reduce" }); // close() then removes the window synchronously
    const count = () =>
      page.evaluate(async () => {
        const live = await import(new URL("core/cloud-live.js", document.baseURI).href);
        return live.subscriberCount() as number;
      });
    const baseline = await count();
    for (let i = 0; i < 20; i++) {
      await page.evaluate(() => (window as unknown as { FULCWM: { open: (id: string) => void } }).FULCWM.open("repos"));
      await expect(tid(page, "repos-app")).toBeVisible();
      if (i === 0) expect(await count()).toBe(baseline + 3); // the refresh subscription and the two repo events
      await page.evaluate(() => (window as unknown as { FULCWM: { close: (id: string) => void } }).FULCWM.close("repos"));
      await expect(page.locator(APP)).toHaveCount(0);
    }
    expect(await count()).toBe(baseline);
  });

  test("phone: one column, the settings sit under the list", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "phone", "layout check is for the phone project");
    await setup(page, { admin: true });
    await openRepos(page);
    await tid(page, "repos-open").first().click();
    await expect(tid(page, "repos-auto-merge")).toBeVisible();
    const list = (await page.locator(`${APP} .repos-list`).boundingBox())!;
    const detail = (await page.locator(`${APP} .repos-detail`).boundingBox())!;
    expect(detail.y).toBeGreaterThanOrEqual(list.y + list.height - 1);
    expect(Math.abs(detail.x - list.x)).toBeLessThan(2);
  });

  // Element.replaceChildren(null) writes the text "null"; no state of the window may show null, undefined or NaN.
  for (const admin of [true, false]) {
    for (const withRepos of [false, true]) {
      test(`${admin ? "an admin" : "a member"} with ${withRepos ? "repos" : "zero repos"} never sees null, undefined or NaN on screen`, async ({ page }) => {
        const { appErrors } = await setup(page, { admin });
        if (!withRepos) await page.route((u) => u.pathname === "/api/v1/repos", (route) => route.fulfill({ json: { data: [], next_cursor: null } }));
        await openRepos(page);
        const bad = /\b(null|undefined|NaN)\b/i; // the window upper-cases its text, so match any case
        const text = () => page.locator(APP).innerText();
        if (withRepos) {
          await expect(tid(page, "repos-row")).toHaveCount(2);
          await expect(page.locator(`${APP} .repos-name`).first()).toHaveText("acme/widgets");
          expect(await text()).not.toMatch(bad);
          await tid(page, "repos-open").first().click();
          await expect(tid(page, "repos-auto-merge")).toBeVisible();
        } else {
          await expect(tid(page, "repos-empty")).toBeVisible();
        }
        expect(await text()).not.toMatch(bad);
        expect(appErrors).toEqual([]);
      });
    }
  }

  test("the source has no markup sink, no direct fetch, no 401 branch and never reads a server message", () => {
    const src = readFileSync(join(SCRIPT_DIR, "..", "apps", "repos", "repos-app.js"), "utf8");
    expect(src).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\bfetch\(|401|\.message/);
  });
});
