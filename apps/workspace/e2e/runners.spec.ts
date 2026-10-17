// apps/workspace/e2e/runners.spec.ts
//
// D#605 FL-9: the Runners app (the fleet page) on the built cloud dist, served by fixture-server.mjs. Every call the window makes is answered by
// page.route(). The logic half (one request per click, the sentences, the account line, the commands) is in test/runners-fleet.test.mjs; this file
// covers what needs the real DOM: that no state is shown by colour alone, every control is keyboard-reachable and focus comes back after each dialog
// (axe, under every theme), a double click is one POST, a disabled control shows its reason, a secret is shown once, and that no null, undefined or id
// reaches the page.

import { test, expect, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { waitForDesktop } from "./helpers/boot";

const CSP = "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
const SERVER_TEXT = "server text that must never be shown";
const ME = "33333333-3333-4333-8333-333333333333";
const R1 = "44444444-4444-4444-8444-444444444441";
const R2 = "44444444-4444-4444-8444-444444444442";
const R3 = "44444444-4444-4444-8444-444444444443";
const REPO_WEB = "99999999-9999-4999-8999-999999999991";
const REPO_API = "99999999-9999-4999-8999-999999999992";
const TOKEN = ["fxrp", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0"].join("_"); // gitleaks:allow
const ok = { allowed: true, reason: null };
const OWN = { pause: ok, drain: ok, resume: { allowed: false, reason: "Not paused." }, rename: ok, remove: ok };
const NOT_MINE = "Only the person who registered this runner, or an owner or admin, can do this.";
const THEMES = ["classic-crt", "retro-amber", "nord", "corporate", "modern-flat", "crystal", "orchard", "cyberpunk"];

const runner = (over: Record<string, unknown> = {}) => ({
  id: R1, credential_mode: "api_key", registered_by: { id: ME, name: "Ada Admin" }, binary_version: "0.9.1", last_seen_at: "2026-10-15T11:59:00.000Z", state: "online_idle", state_note: null,
  revoked_reason: null, sandbox_unavailable: null, plan_consent: { granted: false, changed_at: null }, can_change_plan_consent: false, repos: [{ id: REPO_WEB, name: "acme/web" }, { id: REPO_API, name: "acme/api" }],
  running: { light: 1, heavy: 0 }, capacity: { light: { limit: 8, in_use: 1 }, heavy: { limit: 4, in_use: 0 }, total_limit: 8, limited_by: null }, load_label: null, provisioning: null,
  name: "Desktop", has_name: true, labels: ["gpu"], facts: { os: "macos", arch: "arm64", engine: "os_sandbox" }, current_runs: [], paused: false, draining: false, controls: OWN, register_again: null, ...over,
});
const REPOS = {
  data: [
    { id: REPO_WEB, product: "web", gh_repo_id: 1, install_state: "installed", app_kind: "team", full_name: "acme/web" },
    { id: REPO_API, product: "api", gh_repo_id: 2, install_state: "installed", app_kind: "team", full_name: "acme/api" },
  ],
  next_cursor: null,
};

interface Mock {
  runners: unknown[];
  role: "owner" | "admin" | "member";
  account: Record<string, unknown>;
  tokens: Array<Record<string, unknown>>;
  posts: Array<{ path: string; body: unknown }>;
  deletes: string[];
  mintStatus: number;
  mintDelay: number;
  runFetches: string[];
  isAdmin: boolean;
}
const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function setup(page: Page, tweak: Partial<Mock> = {}) {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP ${e.violatedDirective}`)));
  const mock: Mock = {
    runners: [runner()], role: "admin", account: { limit: 16, capacity: 8, running: 1, runner_count: 1, runner_limit: 5 }, tokens: [], posts: [], deletes: [], mintStatus: 201, mintDelay: 0, runFetches: [], isAdmin: true, ...tweak,
  };
  await page.route((u) => u.pathname === "/", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": CSP } });
  });
  await page.route("**/api/cloud/auth/me", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), is_admin: mock.isAdmin } });
  });
  await page.route("**/api/v1/events", () => new Promise<void>(() => {}));
  await page.route((u) => u.pathname.startsWith("/api/runners") || (u.pathname.startsWith("/api/v1/") && u.pathname !== "/api/v1/events"), async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if ((req.headers()["accept"] ?? "").includes("text/event-stream")) return route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: idle\ndata: {}\n\n" });
    if (p.startsWith("/api/v1/runs/")) mock.runFetches.push(p.split("/")[4]!);
    if (p === "/api/v1/repos") return json(route, 200, REPOS);
    if (p === "/api/runners") return json(route, 200, { runners: mock.runners, viewer: { role: mock.role }, account: mock.account, copy: {} });
    if (p === "/api/runners/provisioning-tokens") {
      if (req.method() === "GET") return json(route, 200, { tokens: mock.tokens, limit: 5 });
      const body = JSON.parse(req.postData() ?? "{}");
      mock.posts.push({ path: p, body });
      if (mock.mintDelay > 0) await new Promise((r) => setTimeout(r, mock.mintDelay));
      if (mock.mintStatus !== 201) return json(route, mock.mintStatus, { error: { code: "token_limit", message: SERVER_TEXT, request_id: "r" } });
      mock.tokens.push({ id: "55555555-5555-4555-8555-555555555555", name: body.name ?? null, labels: body.labels, credential_mode: body.credential_mode, allowed_repo_ids: body.allowed_repo_ids, minted_by: { id: ME, name: "Ada Admin" }, created_at: "2026-10-15T12:00:00.000Z", expires_at: "2026-10-15T13:00:00.000Z" });
      return json(route, 201, { id: "55555555-5555-4555-8555-555555555555", token: TOKEN, expires_at: "2026-10-15T13:00:00.000Z", name: body.name ?? null });
    }
    if (p === "/api/runners/registration-codes") {
      mock.posts.push({ path: p, body: JSON.parse(req.postData() ?? "{}") });
      return json(route, 201, { code: ["fxrr", "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2H1g0"].join("_"), expires_at: "2026-10-15T12:10:00.000Z" }); // gitleaks:allow
    }
    const del = p.match(/^\/api\/runners\/provisioning-tokens\/([^/]+)$/);
    if (del && req.method() === "DELETE") {
      mock.deletes.push(del[1]!);
      mock.tokens = mock.tokens.filter((t) => t.id !== del[1]);
      return json(route, 200, { id: del[1], revoked: true });
    }
    const act = p.match(/^\/api\/runners\/([^/]+)\/(pause|drain|resume|rename|remove)$/);
    if (act && req.method() === "POST") {
      const body = JSON.parse(req.postData() ?? "{}");
      mock.posts.push({ path: p, body });
      await new Promise((r) => setTimeout(r, 150)); // long enough that a second click lands while the first is in flight
      mock.runners = mock.runners.map((r) => {
        if ((r as { id: string }).id !== act[1]) return r;
        if (act[2] === "pause") return { ...(r as object), state: "paused", state_note: "Resumes within 5 min", paused: true, controls: { ...OWN, pause: { allowed: false, reason: "Already paused." }, resume: ok } };
        if (act[2] === "rename" && body.name === null) return { ...(r as object), name: "Unnamed runner (Ada Admin)", has_name: false };
        if (act[2] === "rename") return { ...(r as object), name: body.name, has_name: true };
        if (act[2] === "remove") return { ...(r as object), state: "revoked", controls: null, capacity: null, repos: [] };
        return r;
      });
      return json(route, 200, { runner_id: act[1] });
    }
    return json(route, 404, { error: { code: "not_found", message: SERVER_TEXT, request_id: "r" } });
  });
  await page.goto("/");
  await waitForDesktop(page);
  return { mock, errors };
}

const WIN = `#windows-container .fulc-window[data-app-id="runners"]`;
const t = (page: Page, id: string) => page.locator(`${WIN} [data-testid="${id}"]`);
const open = async (page: Page) => {
  await page.locator('.dock-icon[data-app-id="runners"]').click();
  const win = page.locator(WIN);
  await expect(win).toBeVisible();
  await expect(win).not.toHaveClass(/opening/);
  await expect(t(page, "runners-account")).toBeVisible();
  return win;
};
const press = async (loc: ReturnType<Page["locator"]>) => {
  if (test.info().project.name === "phone") await loc.tap();
  else await loc.click();
};
const sheet = (page: Page) => page.locator('dialog:has([data-testid="runners-sheet"])');
async function clean(page: Page, errors: string[]) {
  expect(errors).toEqual([]);
  const text = await page.evaluate(() => document.body.innerText);
  expect(text).not.toMatch(/\bnull\b|undefined|NaN|ApiError/);
  expect(text).not.toContain(SERVER_TEXT);
  expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i); // no id stands in for a name
}
async function applyTheme(page: Page, theme: string) {
  await page.evaluate(async (id) => {
    const m = await import(new URL("core/theme-manager.js", document.baseURI).href);
    await m.FULCTheme.apply(id);
  }, theme);
}
async function axeSeriousOrCritical(page: Page, scope: string) {
  const res = await new AxeBuilder({ page }).include(scope).exclude(`${WIN} .window-titlebar`).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]).analyze();
  return res.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
}

test.describe("D#605 FL-9: the fleet page", () => {
  test("a row shows every part by name and words: state, version, runs, capacity, check-in, repos, mode, labels, facts, and the account line", async ({ page }) => {
    const { errors } = await setup(page, {
      runners: [
        runner({ current_runs: [{ id: "88888888-8888-4888-8888-888888888881", label: "fulcrumaxe executor · acme/web" }], state: "busy", load_label: "Busy · 1 of 8" }),
        runner({ id: R2, name: "Unnamed runner (Bo Builder)", has_name: false, registered_by: { id: ME, name: "Bo Builder" }, labels: [], facts: null, binary_version: null, last_seen_at: null, capacity: null, state: "offline", provisioning: { minted_by: { id: ME, name: "Ada Admin" }, first_ip: "203.0.113.9" } }),
        runner({ id: R3, name: "Old box", state: "outdated", binary_version: "0.1.0", draining: false }),
      ],
      account: { limit: 16, capacity: 20, running: 1, runner_count: 3, runner_limit: 5 },
    });
    await open(page);
    await expect(t(page, "runners-account")).toHaveText("Capacity 16 of account limit 16 · 1 running"); // never 20
    const rows = t(page, "runners-row");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("Desktop");
    await expect(rows.nth(0)).toContainText("Registered by Ada Admin");
    await expect(rows.nth(0).locator('[data-testid="runners-state"]')).toHaveText(/Busy · 1 of 8/);
    await expect(rows.nth(0)).toContainText("0.9.1");
    await expect(rows.nth(0)).toContainText("Light 1 of 8 · Heavy 0 of 4");
    await expect(rows.nth(0)).toContainText("acme/web, acme/api");
    await expect(rows.nth(0)).toContainText("API key");
    await expect(rows.nth(0)).toContainText("gpu");
    await expect(rows.nth(0)).toContainText("macos · arm64 · os_sandbox");
    await expect(rows.nth(0).locator('[data-testid="runners-run"]')).toHaveText("fulcrumaxe executor · acme/web");
    await expect(rows.nth(1).locator('[data-testid="runners-name"]')).toHaveText("Unnamed runner (Bo Builder)");
    await expect(rows.nth(1)).toContainText("Not reported yet");
    await expect(rows.nth(1)).toContainText("Capacity unknown");
    await expect(rows.nth(1)).toContainText("Never");
    await expect(rows.nth(1).locator('[data-testid="runners-prov"]')).toHaveText("Made from a token by Ada Admin · first seen at 203.0.113.9");
    await expect(rows.nth(2)).toContainText("0.1.0 · Update needed");
    await clean(page, errors);
  });

  test("Pause on a double click sends one request, and the row reads Paused with its note after the refresh", async ({ page }) => {
    const { mock, errors } = await setup(page);
    await open(page);
    const pause = t(page, "runners-pause");
    await pause.dblclick();
    await expect(t(page, "runners-state")).toHaveText(/Paused · Resumes within 5 min/);
    expect(mock.posts.filter((p) => p.path.endsWith("/pause"))).toHaveLength(1);
    await expect(t(page, "runners-resume")).toBeVisible();
    await clean(page, errors);
  });

  test("a draining runner reads Finishing current work, and a member sees every control disabled with its reason", async ({ page }) => {
    const none = { allowed: false, reason: NOT_MINE };
    const { mock, errors } = await setup(page, {
      role: "member",
      runners: [runner({ state: "draining", draining: true, state_note: "Resumes within 5 min", controls: { pause: none, drain: none, resume: none, rename: none, remove: none } })],
    });
    await open(page);
    await expect(t(page, "runners-state")).toHaveText(/Finishing current work/);
    for (const c of ["resume", "rename", "remove"]) {
      const b = t(page, "runners-" + c);
      await expect(b).toHaveAttribute("aria-disabled", "true");
      await expect(b).not.toHaveAttribute("disabled", /.*/);
      await b.click({ force: true }); // aria-disabled stays clickable for a screen reader; the click must do nothing
    }
    await expect(t(page, "runners-reason")).toHaveCount(4); // three controls, and the Add a runner button
    await expect(t(page, "runners-reason").nth(1)).toHaveText(NOT_MINE);
    await expect(t(page, "runners-add")).toHaveAttribute("aria-disabled", "true");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    expect(mock.posts).toEqual([]);
    await clean(page, errors);
  });

  test("a runner revoked because its registrant left reads Revoked: registrant left, has no controls, and offers Register this machine again to owners and admins only", async ({ page }) => {
    const gone = runner({ state: "revoked", state_note: "Revoked: registrant left", revoked_reason: "registrant_left", controls: null, capacity: null, repos: [], name: "Old laptop", register_again: { name: "Old laptop", labels: ["gpu"], repo_ids: [REPO_API] } });
    const { errors } = await setup(page, { runners: [gone] });
    await open(page);
    await expect(t(page, "runners-state")).toHaveText(/Revoked: registrant left/);
    for (const c of ["pause", "drain", "resume", "rename", "remove"]) await expect(t(page, "runners-" + c)).toHaveCount(0);
    await press(t(page, "runners-again"));
    await expect(sheet(page)).toBeVisible();
    await expect(page.locator("#runners-sheet-path-token")).toBeChecked();
    await expect(page.locator("#runners-sheet-name")).toHaveValue("Old laptop");
    await expect(page.locator("#runners-sheet-labels")).toHaveValue("gpu");
    await expect(page.locator(`#runners-repo-${REPO_API}`)).toBeChecked();
    await expect(page.locator(`#runners-repo-${REPO_WEB}`)).not.toBeChecked();
    await clean(page, errors);
  });

  test("a member sees a removed registrant's runner with its state and no action", async ({ page }) => {
    const gone = runner({ state: "revoked", state_note: "Revoked: registrant left", revoked_reason: "registrant_left", controls: null, capacity: null, repos: [], register_again: null });
    const { errors } = await setup(page, { role: "member", runners: [gone] });
    await open(page);
    await expect(t(page, "runners-state")).toHaveText(/Revoked: registrant left/);
    await expect(t(page, "runners-again")).toHaveCount(0);
    await expect(page.locator(`${WIN} .runners-controls`)).toHaveCount(0);
    await clean(page, errors);
  });

  test("a named runner can go back to unnamed: Remove the name sends { name: null }, the row reads Unnamed again, and the button is gone after a reload", async ({ page }) => {
    const { mock, errors } = await setup(page);
    await open(page);
    await expect(t(page, "runners-name")).toHaveText("Desktop");
    await press(t(page, "runners-rename"));
    await press(page.locator('[data-testid="runners-rename-clear"]'));
    await expect(t(page, "runners-name")).toHaveText(/^Unnamed runner \(/);
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    expect(mock.posts.filter((p) => p.path.endsWith("/rename")).map((p) => p.body)).toEqual([{ name: null }]);
    await page.reload();
    await open(page);
    await expect(t(page, "runners-name")).toHaveText(/^Unnamed runner \(/);
    await expect(t(page, "runners-rename")).toBeEnabled();
    await press(t(page, "runners-rename"));
    await expect(page.locator("#runners-rename-input")).toHaveValue("");
    await expect(page.locator('[data-testid="runners-rename-clear"]')).toHaveCount(0);
    await clean(page, errors);
  });

  test("Rename and Remove ask first, send one request, and focus returns to where it was", async ({ page }) => {
    const { mock, errors } = await setup(page);
    await open(page);
    await press(t(page, "runners-rename"));
    const input = page.locator("#runners-rename-input");
    await expect(input).toBeFocused();
    await input.fill("Workstation");
    await press(page.locator('[data-testid="runners-rename-save"]'));
    await expect(t(page, "runners-name")).toHaveText("Workstation");
    await expect(t(page, "runners-rename")).toBeFocused();
    expect(mock.posts.filter((p) => p.path.endsWith("/rename")).map((p) => p.body)).toEqual([{ name: "Workstation" }]);
    await press(t(page, "runners-remove"));
    await expect(page.locator("dialog[open]")).toContainText("Remove Workstation?");
    // Cancel and Escape both go back to the Remove button that opened the dialog, and send nothing.
    await press(page.getByRole("button", { name: "Cancel" }));
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(t(page, "runners-remove")).toBeFocused();
    await press(t(page, "runners-remove"));
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(t(page, "runners-remove")).toBeFocused();
    expect(mock.posts.filter((p) => p.path.endsWith("/remove"))).toHaveLength(0);
    await press(t(page, "runners-remove"));
    await press(page.locator('[data-testid="runners-remove-confirm"]'));
    await expect(t(page, "runners-state")).toHaveText(/Revoked/);
    await expect(t(page, "runners-add")).toBeFocused();
    expect(mock.posts.filter((p) => p.path.endsWith("/remove"))).toHaveLength(1);
    await clean(page, errors);
  });

  test("Add a runner: the token is shown once with a --code-stdin command; reopening shows only its name and expiry; Revoke removes it", async ({ page }) => {
    const { mock, errors } = await setup(page);
    await open(page);
    await press(t(page, "runners-add"));
    await expect(sheet(page)).toBeVisible();
    await expect(page.locator("#runners-sheet-path-code")).toBeFocused();
    await page.locator("#runners-sheet-path-token").check();
    await page.locator("#runners-sheet-name").fill("VPS");
    await page.locator("#runners-sheet-labels").fill("gpu, big-box");
    await page.locator(`#runners-repo-${REPO_WEB}`).check();
    await press(page.locator('[data-testid="runners-sheet-make"]'));
    const secret = page.locator('[data-testid="runners-secret"]');
    await expect(secret).toHaveValue(TOKEN);
    await expect(page.locator('[data-testid="runners-register-command"]')).toContainText("fx-runner register --code-stdin --credential-mode api_key");
    await expect(page.locator('[data-testid="runners-register-command"]')).toContainText("--name 'VPS'");
    expect(mock.posts).toEqual([{ path: "/api/runners/provisioning-tokens", body: { credential_mode: "api_key", allowed_repo_ids: [REPO_WEB], labels: ["gpu", "big-box"], ttl_seconds: 3600, name: "VPS" } }]);
    await press(page.locator('[data-testid="runners-sheet-done"]'));
    await expect(sheet(page)).toHaveCount(0);
    await expect(t(page, "runners-add")).toBeFocused();
    expect(await page.evaluate(() => document.body.innerHTML)).not.toContain("A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0");
    await press(t(page, "runners-add"));
    await expect(page.locator('[data-testid="runners-tokens"] li')).toHaveCount(1);
    await expect(page.locator('[data-testid="runners-tokens"] li')).toContainText("VPS");
    await expect(page.locator('[data-testid="runners-tokens"] li')).toContainText("expires");
    expect(await page.evaluate(() => document.body.innerHTML)).not.toContain("A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0");
    await press(page.getByRole("button", { name: "Revoke VPS" }));
    await expect(page.locator('[data-testid="runners-tokens"] li')).toHaveCount(0);
    expect(mock.deletes).toEqual(["55555555-5555-4555-8555-555555555555"]);
    await press(page.locator("#runners-sheet-close"));
    await expect(t(page, "runners-add")).toBeFocused();
    await clean(page, errors);
  });

  test("closing the sheet while Make is still in flight leaves no secret on the page when the reply arrives", async ({ page }) => {
    const { mock, errors } = await setup(page, { mintDelay: 1500 });
    await open(page);
    await press(t(page, "runners-add"));
    await page.locator("#runners-sheet-path-token").check();
    await page.locator(`#runners-repo-${REPO_WEB}`).check();
    await press(page.locator('[data-testid="runners-sheet-make"]'));
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect.poll(() => mock.posts.length).toBe(1);
    await page.waitForTimeout(2500); // the reply has arrived by now
    expect(await page.evaluate(() => document.body.innerHTML)).not.toContain("A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await clean(page, errors);
  });

  test("a run listed on a row opens in the Runs app; the id it sends is the run's", async ({ page }) => {
    const RUN = "88888888-8888-4888-8888-888888888881";
    const { mock } = await setup(page, { runners: [runner({ current_runs: [{ id: RUN, label: "fulcrumaxe executor · acme/web" }] })] });
    await open(page);
    await press(t(page, "runners-run"));
    await expect(page.locator(`#windows-container .fulc-window[data-app-id="runs"]`)).toBeVisible();
    await expect.poll(() => mock.runFetches.includes(RUN)).toBe(true);
  });

  test("a one-time code, and the sheet's refusals: no repo picked, and a sixth token", async ({ page }) => {
    const { mock, errors } = await setup(page, { mintStatus: 409 });
    await open(page);
    await press(t(page, "runners-add"));
    await press(page.locator('[data-testid="runners-sheet-make"]'));
    await expect(page.locator("#runners-sheet-error")).toHaveText("Pick at least one repo for it to work on.");
    expect(mock.posts).toEqual([]);
    await page.locator("#runners-sheet-path-token").check();
    await page.locator(`#runners-repo-${REPO_API}`).check();
    await press(page.locator('[data-testid="runners-sheet-make"]'));
    await expect(page.locator("#runners-sheet-error")).toHaveText("You already have 5 unused tokens. Revoke one first.");
    await page.locator("#runners-sheet-path-code").check();
    await press(page.locator('[data-testid="runners-sheet-make"]'));
    await expect(page.locator('[data-testid="runners-register-command"]')).toContainText("--code-stdin");
    await expect(page.locator('[data-testid="runners-secret"]')).toHaveValue(/^fxrr_/);
    await clean(page, errors);
  });

  test("a member cannot open the sheet, and the empty fleet says how to start", async ({ page }) => {
    const { errors } = await setup(page, { role: "member", runners: [], account: { limit: 16, capacity: 0, running: 0, runner_count: 0, runner_limit: 5 } });
    await open(page);
    await expect(t(page, "runners-empty")).toContainText("No runners yet");
    await t(page, "runners-add").click({ force: true });
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(t(page, "runners-reason")).toHaveText("Only owners and admins can add a runner.");
    await clean(page, errors);
  });

  // One test per theme: eight themes, three axe scans each, in one test cost more than the test timeout when the machine is busy. Each theme
  // still gets every scan; none is dropped.
  for (const theme of THEMES) test(`keyboard: every control is a focusable button or field (none uses the disabled attribute), and the list and the sheet pass axe under ${theme}`, async ({ page }) => {
    const none = { allowed: false, reason: NOT_MINE };
    await setup(page, {
      runners: [
        runner({ current_runs: [{ id: "88888888-8888-4888-8888-888888888881", label: "fulcrumaxe executor · acme/web" }], state: "busy", load_label: "Busy · 1 of 8" }),
        runner({ id: R2, state: "paused", state_note: "Resumes within 5 min", paused: true, controls: { ...OWN, pause: none, resume: none } }),
        runner({ id: R3, state: "revoked", state_note: "Revoked: registrant left", revoked_reason: "registrant_left", controls: null, register_again: { name: "Old", labels: [], repo_ids: [REPO_WEB] } }),
      ],
      account: { limit: 16, capacity: 8, running: 1, runner_count: 3, runner_limit: 3 },
    });
    await open(page);
    await applyTheme(page, theme);
    expect(await page.locator(`${WIN} button[disabled], ${WIN} input[disabled]`).count()).toBe(0);
    expect(await page.locator(`${WIN} button[tabindex="-1"]`).count()).toBe(0);
    await expect(t(page, "runners-limit-note")).toBeVisible();
    expect(await axeSeriousOrCritical(page, WIN)).toEqual([]);
    await press(t(page, "runners-add"));
    await expect(sheet(page)).toBeVisible();
    expect(await axeSeriousOrCritical(page, "dialog[open]")).toEqual([]);
    await page.locator("#runners-sheet-path-token").check();
    await page.locator(`#runners-repo-${REPO_WEB}`).check();
    await press(page.locator('[data-testid="runners-sheet-make"]'));
    await expect(page.locator('[data-testid="runners-secret"]')).toBeVisible();
    expect(await axeSeriousOrCritical(page, "dialog[open]")).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect(t(page, "runners-add")).toBeFocused();
  });
});
