// apps/workspace/e2e/roles.spec.ts
//
// D#37 WS-F4a (C31, C33 sections 2-3, C34 sections 3-4): the Roles app, read
// view. The built cloud dist is served by fixture-server.mjs, with the two v1
// reads re-answered by page.route() from the contract fixtures so each test
// can shape the reply. The document carries the production CSP and Trusted
// Types directives, so a sink in the app fails here for real. Error replies
// are mocked inline (C33 section 2). WS-F4b adds the writes: the mode and model
// selects, each one PATCH with only the changed field.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";
import { bootToDesktop } from "./helpers/boot";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const V1 = join(SCRIPT_DIR, "..", "..", "..", "packages", "api", "fixtures", "v1");
const readFixture = (...p: string[]) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
const REPOS = readFixture("listRepos", "200-page.json");
const ROLES = readFixture("listRoles", "200-ok.json");
const SEC = readFixture("patchRole", "200-ok.json");
const INSTALLED_ID = REPOS.data[0].id;
const SECOND = { ...REPOS.data[0], id: "55555555-5555-4555-8555-555555555555", product: "api" };

const CSP =
  "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
const WIN = `#windows-container .fulc-window[data-app-id="roles"]`;
const tid = (page: Page, id: string) => page.locator(`${WIN} [data-testid="${id}"]`);
const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

interface Seen {
  appErrors: string[];
  requests: string[];
  patches: { role: string; body: Record<string, unknown> }[];
  violations: () => Promise<string[]>;
}

async function setup(
  page: Page,
  opts: {
    repos?: unknown | ((url: URL) => unknown);
    roles?: (repoId: string) => unknown | ((r: Route) => Promise<void>);
    admin?: boolean;
    /** Answers a PATCH; the default echoes the role with the requested field applied. */
    patch?: (route: Route, role: string, body: Record<string, unknown>) => Promise<void>;
  } = {}
): Promise<Seen> {
  const seen = { appErrors: [] as string[], requests: [] as string[], patches: [] as Seen["patches"] };
  page.on("console", (m) => {
    // Chromium logs its own line for a 4xx/5xx fetch; the app's console output is what C25 cares about.
    if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) seen.appErrors.push(m.text());
  });
  page.on("pageerror", (e) => seen.appErrors.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => {
    const g = window as unknown as { __tt: string[] };
    g.__tt = [];
    document.addEventListener("securitypolicyviolation", (e) => g.__tt.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  await page.route((u) => u.pathname === "/", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": CSP } });
  });
  await page.route("**/api/cloud/auth/me", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), is_admin: !!opts.admin } });
  });
  await page.route("**/api/v1/repos**", async (route) => {
    const url = new URL(route.request().url());
    seen.requests.push(`${route.request().method()} ${url.pathname}${url.search}`);
    if (route.request().method() === "PATCH") {
      const role = decodeURIComponent(url.pathname.split("/").pop()!);
      const body = route.request().postDataJSON();
      seen.patches.push({ role, body });
      if (opts.patch) return opts.patch(route, role, body);
      const base = ROLES.data.find((r: { role: string }) => r.role === role) ?? SEC;
      return json(route, 200, { ...base, ...body });
    }
    const m = url.pathname.match(/^\/api\/v1\/repos\/([^/]+)\/roles$/);
    if (!m) {
      const r = typeof opts.repos === "function" ? (opts.repos as (u: URL) => unknown)(url) : opts.repos;
      return json(route, 200, r ?? REPOS);
    }
    const reply = opts.roles ? opts.roles(m[1]) : ROLES;
    if (typeof reply === "function") return (reply as (r: Route) => Promise<void>)(route);
    return json(route, 200, reply);
  });
  return { ...seen, violations: () => page.evaluate(() => (window as unknown as { __tt: string[] }).__tt) };
}

async function openRoles(page: Page) {
  await page.evaluate(() => (window as unknown as { FULCWM: { open: (id: string) => void } }).FULCWM.open("roles"));
  await expect(page.locator(WIN)).toBeVisible();
}

/** The window's close animation runs on the faked clock, so step it forward. */
async function closeRoles(page: Page) {
  await page.evaluate(() => (window as unknown as { FULCWM: { close: (id: string) => void } }).FULCWM.close("roles"));
  await page.clock.runFor(1000);
  await expect(page.locator(WIN)).toHaveCount(0);
}

async function boot(page: Page, opts: Parameters<typeof setup>[1] = {}) {
  const seen = await setup(page, opts);
  await bootToDesktop(page);
  await openRoles(page);
  return seen;
}

/** C34 section 3: page.clock hides the boot:desktop-ready mark, so the live client is started by hand once the desktop shows. */
async function startLive(page: Page) {
  await page.evaluate(async () => {
    const live = await import(new URL("core/cloud-live.js", document.baseURI).href);
    live.default.start();
  });
}

const subscribers = (page: Page) =>
  page.evaluate(async () => (await import(new URL("core/cloud-live.js", document.baseURI).href)).subscriberCount() as number);

test("lists installed repos only, and each role with its mode, model and spend", async ({ page }) => {
  const seen = await boot(page);
  await expect(tid(page, "roles-row")).toHaveCount(2);
  await expect(tid(page, "roles-repo").locator("option")).toHaveText(["web"]);
  const build = page.locator(`${WIN} [data-role="build"]`);
  await expect(build).toContainText("fulcrumaxe build");
  await expect(build.locator("option")).toHaveText(["off", "suggest", "auto"]);
  await expect(build.locator("select")).toHaveValue("auto");
  await expect(build.locator("select")).toBeDisabled();
  await expect(build.locator('[data-testid="roles-model"]')).toHaveText("Follows the routing table");
  const spend = build.locator('[data-testid="roles-spend"]');
  await expect(spend).toHaveText(ROLES.data[0].expected_spend.text);
  await expect(spend).toHaveAttribute("title", ROLES.data[0].expected_spend.caveat);
  const reviewer = page.locator(`${WIN} [data-role="code-reviewer"]`);
  await expect(reviewer.locator("option")).toHaveText(["off", "suggest"]);
  await expect(reviewer.locator('[data-testid="roles-model"]')).toHaveText("opus-5");
  // Read view only: every request is a GET.
  expect(seen.requests.every((r) => r.startsWith("GET "))).toBe(true);
  expect(seen.requests).toContain(`GET /api/v1/repos/${INSTALLED_ID}/roles`);
  expect(seen.appErrors).toEqual([]);
  expect(await seen.violations()).toEqual([]);
});

test("a model floor reads 'at least <floor>'", async ({ page }) => {
  const roles = { data: [{ ...ROLES.data[0], model: "opus-5", model_floor: "sonnet-5" }] };
  await boot(page, { roles: () => roles });
  await expect(tid(page, "roles-model")).toHaveText("opus-5 (at least sonnet-5)");
});

test("follows next_cursor and remembers the chosen repo", async ({ page }) => {
  // Two pages: the first holds only the not-installed repo.
  const seen = await boot(page, {
    repos: (url: URL) =>
      url.searchParams.get("cursor")
        ? { data: [REPOS.data[0], SECOND], next_cursor: null }
        : { data: [REPOS.data[1]], next_cursor: "c2" },
  });
  await expect(tid(page, "roles-repo").locator("option")).toHaveText(["web", "api"]);
  expect(seen.requests.some((r) => r.includes("cursor=c2"))).toBe(true);
  await tid(page, "roles-repo").selectOption(SECOND.id);
  await expect.poll(() => seen.requests.filter((r) => r.endsWith(`${SECOND.id}/roles`)).length).toBe(1);
  expect(await page.evaluate(() => localStorage.getItem("fx:ns-idle-e2e:roles:repo"))).toBe(SECOND.id);
  // Closing and reopening picks the remembered repo, not the first one.
  await closeRoles(page);
  await openRoles(page);
  await expect(tid(page, "roles-repo")).toHaveValue(SECOND.id);
});

test("a member sees a note and read-only controls: no model select, disabled mode", async ({ page }) => {
  const seen = await boot(page);
  await expect(tid(page, "roles-note")).toHaveText("Only owners and admins can change roles.");
  await expect(tid(page, "roles-mode").first()).toHaveAttribute("data-can-edit", "false");
  await expect(tid(page, "roles-mode").first()).toBeDisabled();
  await expect(tid(page, "roles-model-select")).toHaveCount(0);
  expect(seen.patches).toEqual([]);
});

test("an admin has no note (auth/me is overridden)", async ({ page }) => {
  await boot(page, { admin: true });
  await expect(tid(page, "roles-row")).toHaveCount(2);
  await expect(tid(page, "roles-note")).toHaveText("");
  await expect(tid(page, "roles-mode").first()).toHaveAttribute("data-can-edit", "true");
  await expect(tid(page, "roles-mode").first()).toBeEnabled();
});

test("no installed repo: a fixed line and no roles request", async ({ page }) => {
  const seen = await boot(page, { repos: { data: [REPOS.data[1]], next_cursor: null } });
  await expect(tid(page, "roles-status")).toHaveText("No repos are installed yet.");
  expect(seen.requests.some((r) => r.endsWith("/roles"))).toBe(false);
});

for (const status of [500, 401]) {
  test(`a ${status} on the roles read shows the app's own sentence, never the server's text or "Reload the page"`, async ({
    page,
  }) => {
    // Body shape: the v1 error envelope (packages/api/src/errors.ts).
    const body = { error: { code: "internal", message: "listRoleSettings: secret internal detail", request_id: "r1" } };
    const seen = await boot(page, { roles: () => (route: Route) => json(route, status, body) });
    await expect(tid(page, "roles-status")).toHaveText("Roles aren't available right now.");
    await expect(page.locator(WIN)).not.toContainText("secret internal detail");
    await expect(page.locator(WIN)).not.toContainText("Reload the page");
    expect(seen.appErrors).toEqual([]);
  });
}

test("live: refresh reloads the roles, and closing the window drops the subscription", async ({ page }) => {
  let n = 0;
  await boot(page, {
    roles: () => {
      n++;
      return { data: [{ ...ROLES.data[0], mode: n > 1 ? "off" : "auto" }] };
    },
  });
  await startLive(page);
  await expect(tid(page, "roles-mode")).toHaveValue("auto");
  const base = await subscribers(page);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(tid(page, "roles-mode")).toHaveValue("off");
  for (let i = 0; i < 20; i++) {
    await closeRoles(page);
    await openRoles(page);
  }
  await closeRoles(page);
  expect(await subscribers(page)).toBe(base - 1);
});

test("phone: one role per row, stacked, with a native select", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "phone", "phone project only");
  await boot(page);
  // The window opens at desktop width and settles to the phone width, so poll the
  // layout (offset positions, not the animated bounding box) until it stacks.
  await expect
    .poll(() =>
      page.locator(`${WIN} [data-role="build"]`).evaluate((row) => {
        const name = row.querySelector(".roles-name") as HTMLElement;
        const mode = row.querySelector("select") as HTMLElement;
        return mode.offsetTop >= name.offsetTop + name.offsetHeight;
      })
    )
    .toBe(true);
  expect(await tid(page, "roles-mode").first().evaluate((el) => el.tagName)).toBe("SELECT");
});

const sec = (page: Page) => page.locator(`${WIN} [data-role="security-reviewer"]`);
const model = (page: Page, role = "security-reviewer") => page.locator(`${WIN} [data-role="${role}"] [data-testid="roles-model-select"]`);

test("the model select offers exactly the role's allowed_models, plus 'follows the table'", async ({ page }) => {
  await boot(page, {
    admin: true,
    roles: () => ({ data: [ROLES.data[0], SEC, { ...SEC, role: "security-expert", model: null, allowed_models: [] }] }),
  });
  await expect(model(page, "build").locator("option")).toHaveText(["Follows the routing table", "haiku-4.5", "sonnet-5", "opus-5"]);
  await expect(model(page)).toHaveValue("opus-5");
  await expect(model(page).locator("option")).toHaveText(["Follows the routing table", "sonnet-5", "opus-5"]);
  await expect(sec(page).locator(".roles-floor")).toHaveText(" (at least sonnet-5)");
  // A role the server allows nothing on offers nothing to pick: fail closed.
  await expect(model(page, "security-expert").locator("option")).toHaveText(["Follows the routing table"]);
  const values = await page
    .locator(`${WIN} [data-testid="roles-model-select"] option`)
    .evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
  for (const v of values) expect(v).toMatch(/^$|^(haiku|sonnet|opus)-/);
});

test("a model id the server adds shows up in the select with no app change", async ({ page }) => {
  await boot(page, {
    admin: true,
    roles: () => ({ data: [{ ...ROLES.data[0], allowed_models: ["haiku-4.5", "sonnet-5", "opus-5", "fixture-model-9"] }] }),
  });
  await expect(model(page, "build").locator("option")).toHaveText([
    "Follows the routing table",
    "haiku-4.5",
    "sonnet-5",
    "opus-5",
    "fixture-model-9",
  ]);
});

test("choosing a model sends one PATCH with only the model; clearing sends null; focus stays on the select", async ({ page }) => {
  const seen = await boot(page, { admin: true, roles: () => ({ data: [ROLES.data[0], SEC] }) });
  await model(page, "build").selectOption("sonnet-5");
  await expect.poll(() => seen.patches.length).toBe(1);
  expect(seen.patches[0]).toEqual({ role: "build", body: { model: "sonnet-5" } });
  await expect(model(page, "build")).toHaveValue("sonnet-5");
  await expect(model(page, "build")).toBeFocused();
  await model(page, "build").selectOption("");
  await expect.poll(() => seen.patches.length).toBe(2);
  expect(seen.patches[1].body).toEqual({ model: null });
  await expect(model(page, "build")).toHaveValue("");
  await expect(tid(page, "roles-row-error")).toHaveCount(0);
});

test("choosing a mode sends one PATCH with only the mode, and the keyboard alone can do it", async ({ page }) => {
  const seen = await boot(page, { admin: true });
  const mode = page.locator(`${WIN} [data-role="build"] [data-testid="roles-mode"]`);
  await mode.focus();
  await page.keyboard.press("ArrowUp");
  expect(seen.patches).toEqual([]);
  await expect(tid(page, "roles-status")).toHaveText("Press Enter or move on to save.");
  await page.keyboard.press("Enter");
  await expect.poll(() => seen.patches.length).toBe(1);
  expect(seen.patches[0]).toEqual({ role: "build", body: { mode: "suggest" } });
  await expect(mode).toHaveValue("suggest");
  await expect(mode).toBeFocused();
});

test("the spend line shows the server's new text after a model change and after a mode change, with no second read", async ({ page }) => {
  const spendText = (usd: string) => `expected spend on your model bill: $${usd}/month`;
  let gets = 0;
  const seen = await boot(page, {
    admin: true,
    roles: () => {
      gets++;
      return { data: [ROLES.data[0]] };
    },
    // The answer carries a different figure per change; the app must show it as given.
    patch: async (route, _role, body) => {
      const usd = body.model === "haiku-4.5" ? "56.00" : body.model === null ? "210.00" : body.mode === "off" ? "0.00" : "490.00";
      const caveat = "This is an estimate based on the selected model.";
      await json(route, 200, {
        ...ROLES.data[0],
        ...body,
        expected_spend: { ...ROLES.data[0].expected_spend, text: spendText(usd), caveat },
      });
    },
  });
  const spend = page.locator(`${WIN} [data-role="build"] [data-testid="roles-spend"]`);
  await expect(spend).toHaveText(ROLES.data[0].expected_spend.text);
  const reads = gets;
  await model(page, "build").selectOption("haiku-4.5");
  await expect(spend).toHaveText(spendText("56.00"));
  await expect(spend).toHaveAttribute("title", "This is an estimate based on the selected model.");
  await model(page, "build").selectOption("opus-5");
  await expect(spend).toHaveText(spendText("490.00"));
  await model(page, "build").selectOption("");
  await expect(spend).toHaveText(spendText("210.00"));
  await page.locator(`${WIN} [data-role="build"] [data-testid="roles-mode"]`).selectOption("off");
  await expect(spend).toHaveText(spendText("0.00"));
  expect(seen.patches.map((p) => p.body)).toEqual([{ model: "haiku-4.5" }, { model: "opus-5" }, { model: null }, { mode: "off" }]);
  expect(gets).toBe(reads);
  await expect(spend).not.toContainText(/null|undefined|NaN/);
});

test("a 422 shows the server's message on the row, puts the select back and focuses it", async ({ page }) => {
  const message = '"haiku-4.5" is below the floor ("sonnet-5") for role "security-reviewer"';
  const seen = await boot(page, {
    admin: true,
    roles: () => ({ data: [SEC] }),
    patch: (route) =>
      json(route, 422, {
        error: { code: "invalid_role_settings_input", message, request_id: "r1" },
        details: [{ path: "model", code: "invalid" }],
      }),
  });
  // A request built by hand: the select never offers haiku for this role.
  await model(page).evaluate((el) => {
    const o = document.createElement("option");
    o.value = "haiku-4.5";
    el.appendChild(o);
  });
  await model(page).selectOption("haiku-4.5");
  await expect(tid(page, "roles-row-error")).toHaveText(message);
  await expect(model(page)).toHaveValue("opus-5");
  await expect(model(page)).toBeFocused();
  await expect(model(page)).toHaveAttribute("aria-invalid", "true");
  const id = await tid(page, "roles-row-error").getAttribute("id");
  await expect(model(page)).toHaveAttribute("aria-describedby", `roles-floor-security-reviewer ${id}`);
  expect(seen.appErrors).toEqual([]);
});

for (const [status, sentence] of [
  [403, "Only owners and admins can change roles."],
  [500, "That change couldn't be saved. Try again."],
] as const) {
  test(`a ${status} on save shows the app's own sentence, never the server's text`, async ({ page }) => {
    const body = { error: { code: "x", message: "secret internal detail", request_id: "r1" } };
    const seen = await boot(page, { admin: true, patch: (route) => json(route, status, body) });
    await model(page, "build").selectOption("opus-5");
    await expect(tid(page, "roles-row-error")).toHaveText(sentence);
    await expect(model(page, "build")).toHaveValue("");
    await expect(page.locator(WIN)).not.toContainText("secret internal detail");
    expect(seen.appErrors).toEqual([]);
  });
}

test("a keyboard user stepping through models saves once, with the final value (fast and slow presses)", async ({ page }) => {
  for (const gap of [0, 250]) {
    const seen = await boot(page, {
      admin: true,
      roles: () => ({ data: [ROLES.data[0]] }),
      patch: async (route, _role, body) => {
        await new Promise((r) => setTimeout(r, 150));
        await json(route, 200, { ...ROLES.data[0], ...body });
      },
    });
    await model(page, "build").focus();
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("ArrowDown");
      if (gap) await page.waitForTimeout(gap);
    }
    expect(seen.patches).toEqual([]);
    await page.keyboard.press("Enter");
    await expect.poll(() => seen.patches.length).toBe(1);
    expect(seen.patches[0]).toEqual({ role: "build", body: { model: "opus-5" } });
    await expect(tid(page, "roles-status")).toHaveText("Saved");
    await expect(model(page, "build")).toHaveValue("opus-5");
    await expect(model(page, "build")).toBeFocused();
    await page.waitForTimeout(300);
    expect(seen.patches).toHaveLength(1);
    await page.reload();
  }
});

test("leaving the select saves a held keyboard change, and focus is not pulled back if it moved on", async ({ page }) => {
  const seen = await boot(page, { admin: true, roles: () => ({ data: [ROLES.data[0]] }) });
  await model(page, "build").focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Tab");
  await expect.poll(() => seen.patches.length).toBe(1);
  expect(seen.patches[0].body).toEqual({ model: "haiku-4.5" });
  await expect(tid(page, "roles-status")).toHaveText("Saved");
  await expect(model(page, "build")).not.toBeFocused();
});

test("a 422 whose message holds markup renders as inert text", async ({ page }) => {
  const message = "<img src=x onerror=window.__xss=1><script>window.__xss=2</script>";
  const seen = await boot(page, {
    admin: true,
    patch: (route) =>
      json(route, 422, { error: { code: "invalid_role_settings_input", message, request_id: "r1" }, details: [{ path: "model", code: "invalid" }] }),
  });
  page.on("dialog", (d) => {
    seen.appErrors.push("dialog: " + d.message());
    void d.dismiss();
  });
  await model(page, "build").selectOption("opus-5");
  await expect(tid(page, "roles-row-error")).toHaveText(message);
  await expect(tid(page, "roles-row-error").locator("img, script")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  expect(await seen.violations()).toEqual([]);
  expect(seen.appErrors).toEqual([]);
});

test("the floor hint describes the model select; rows clear while another repo loads", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await boot(page, {
    admin: true,
    repos: { data: [REPOS.data[0], SECOND], next_cursor: null },
    roles: (repoId) => (repoId === SECOND.id ? (route: Route) => gate.then(() => json(route, 200, { data: [ROLES.data[0]] })) : { data: [SEC] }),
  });
  await expect(model(page)).toHaveAttribute("aria-describedby", /roles-floor-security-reviewer/);
  await tid(page, "roles-repo").selectOption(SECOND.id);
  await expect(tid(page, "roles-row")).toHaveCount(0);
  release();
  await expect(tid(page, "roles-row")).toHaveCount(1);
});

test("starting a save drops a refresh already in flight, then reloads once", async ({ page }) => {
  let gets = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const seen = await boot(page, {
    admin: true,
    roles: () => {
      gets++;
      return gets === 2 ? (route: Route) => gate.then(() => json(route, 200, { data: [{ ...ROLES.data[0], mode: "off" }] })) : { data: [ROLES.data[0]] };
    },
  });
  await startLive(page);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => gets).toBe(2);
  await model(page, "build").selectOption("opus-5");
  await expect.poll(() => seen.patches.length).toBe(1);
  release();
  await expect.poll(() => gets).toBe(3);
  await expect(tid(page, "roles-mode")).toHaveValue("auto");
});

test("a refresh during a save waits for it, then reloads once", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let gets = 0;
  const seen = await boot(page, {
    admin: true,
    roles: () => {
      gets++;
      return { data: [ROLES.data[0]] };
    },
    patch: async (route, _role, body) => {
      await gate;
      await json(route, 200, { ...ROLES.data[0], ...body });
    },
  });
  await startLive(page);
  await model(page, "build").selectOption("opus-5");
  await expect(tid(page, "roles-row")).toHaveAttribute("aria-busy", "true");
  await expect(model(page, "build")).toBeEnabled();
  const before = gets;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForTimeout(200);
  expect(gets).toBe(before);
  release();
  await expect.poll(() => gets).toBe(before + 1);
  expect(seen.patches).toHaveLength(1);
});

test("the app source has no sink, no direct fetch, only the PATCH mutation, no 401 branch, no SDK state", () => {
  const src = readFileSync(join(SCRIPT_DIR, "..", "apps", "roles", "roles-app.js"), "utf8");
  expect(src).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  expect(src).not.toMatch(/\bfetch\(/);
  expect(src.match(/"(PATCH|POST|PUT|DELETE)"/g)).toEqual(['"PATCH"']);
  expect(src).not.toMatch(/401/);
  // Exactly one read of a server message, and it sits in the 422 branch.
  expect(src.match(/\.message\b/g)).toHaveLength(1);
  const fn = src.slice(src.indexOf("function failure"));
  const branch = fn.slice(fn.indexOf("status === 422"), fn.indexOf("return { field, text: e &&"));
  expect(branch).toContain(".message");
  expect(src).not.toMatch(/FULC\.(state|config|window|backend|events)/);
});
