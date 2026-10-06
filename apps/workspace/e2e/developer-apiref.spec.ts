// apps/workspace/e2e/developer-apiref.spec.ts
//
// D#37 WS-F15b (correction C40): the Developer app's API reference tab. The
// built cloud dist is served by fixture-server.mjs with the production CSP and
// Trusted Types directives, and GET /api/v1/openapi.json is answered by
// page.route() from one of three documents:
//   * e2e/apiref-fixture.openapi.json  (the shape the API emits once each
//     operation names its token scope, plus unsafe paths and a $ref cycle),
//   * e2e/apiref-hostile.openapi.json  (markup and script-scheme links in every
//     place the tab prints a string),
//   * packages/api/openapi.json        (the real document, for a smoke run).
// The criteria numbers in the test names are C40 section 3.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { bootToDesktop } from "./helpers/boot";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, "..", "..", "..");
const readJson = (...p: string[]) => JSON.parse(readFileSync(join(...p), "utf8"));
const FIXTURE = readJson(SCRIPT_DIR, "apiref-fixture.openapi.json");
const HOSTILE = readJson(SCRIPT_DIR, "apiref-hostile.openapi.json");
const REAL = readJson(ROOT, "packages", "api", "openapi.json");
const CREATED = readJson(ROOT, "packages", "api", "fixtures", "v1", "createToken", "201-created-named.json");
// Operations for the response-grouping and access tests. They sit beside the shared fixture
// (not in it) because criterion 5 expects every curl in the fixture to carry the token header.
const prop = (name: string) => ({ content: { "application/json": { schema: { type: "object", properties: { [name]: { type: "boolean" } } } } } });
const POLISH_PATHS = {
  "/api/v1/status": {
    get: {
      operationId: "getStatus",
      summary: "Public status",
      security: [],
      responses: {
        "200": { description: "Up", ...prop("up200") },
        "2XX": { description: "Other success", ...prop("up2xx") },
        default: { description: "Anything else", ...prop("updefault") },
        "404": { description: "Not found" },
        "5XX": { description: "Server trouble" },
      },
    },
  },
  "/api/v1/ping": {
    get: { operationId: "getPing", summary: "Ping without a security entry", responses: { "200": { description: "Pong" } } },
  },
};
const POLISH = { ...FIXTURE, paths: { ...FIXTURE.paths, ...POLISH_PATHS } };
const APIREF_SRC = readFileSync(join(SCRIPT_DIR, "..", "apps", "developer", "developer-apiref.js"), "utf8");

const CSP =
  "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
const DEV = `#windows-container .fulc-window[data-app-id="developer"]`;
const PANEL = `${DEV} #dev-panel-apiref`;
const OPS = `${PANEL} [data-testid="dev-ref-op"]`;
const HOSTILE_STRINGS = [
  "<script>window.__pwned=1</script>",
  "<img src=x onerror=window.__pwned=1>",
  "[x](javascript:window.__pwned=1)",
];

const tid = (page: Page, id: string) => page.locator(`${DEV} [data-testid="${id}"]`);
const op = (page: Page, path: string) => page.locator(OPS, { hasText: path });

interface Watch {
  appErrors: string[];
  violations: () => Promise<string[]>;
}

async function watch(page: Page): Promise<Watch> {
  const appErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" && !msg.text().startsWith("Failed to load resource")) appErrors.push(msg.text());
  });
  page.on("pageerror", (err) => appErrors.push(`pageerror: ${err.message}`));
  await page.addInitScript(() => {
    const g = window as unknown as { __tt: string[] };
    g.__tt = [];
    document.addEventListener("securitypolicyviolation", (e) => g.__tt.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  return { appErrors, violations: () => page.evaluate(() => (window as unknown as { __tt: string[] }).__tt) };
}

async function withCsp(page: Page) {
  await page.route((u) => u.pathname === "/", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": CSP } });
  });
}

interface Mock {
  specHits: string[];
  reply: { status: number; body: string };
}

/** The spec route, plus empty answers for the two other tabs so switching tabs works. */
async function mockApi(page: Page, spec: unknown): Promise<Mock> {
  const mock: Mock = { specHits: [], reply: { status: 200, body: JSON.stringify(spec) } };
  await page.route("**/api/v1/openapi.json", (route) => {
    mock.specHits.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: mock.reply.status, contentType: "application/json", body: mock.reply.body });
  });
  await page.route("**/api/v1/tokens**", (route) => {
    if (route.request().method() === "POST") {
      return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(CREATED) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [], next_cursor: null }) });
  });
  await page.route("**/api/v1/webhook-endpoints**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [], next_cursor: null }) })
  );
  return mock;
}

async function bootMocked(page: Page) {
  await bootToDesktop(page);
}

async function openDeveloper(page: Page) {
  await page.locator('.dock-icon[data-app-id="developer"]').click();
  await expect(page.locator(DEV)).toBeVisible();
  await expect(page.locator(DEV)).not.toHaveClass(/opening/);
  await expect(tid(page, "dev-tab-apiref")).toBeVisible();
}

async function openRefTab(page: Page) {
  await tid(page, "dev-tab-apiref").click();
  await expect(tid(page, "dev-ref-app")).toBeVisible();
}

async function setup(page: Page, spec: unknown = FIXTURE) {
  const w = await watch(page);
  await withCsp(page);
  const mock = await mockApi(page, spec);
  await bootMocked(page);
  await openDeveloper(page);
  return { w, mock };
}

async function setupOnTab(page: Page, spec: unknown = FIXTURE) {
  const s = await setup(page, spec);
  await openRefTab(page);
  await expect(page.locator(OPS).first()).toBeVisible();
  return s;
}

/** Opens every operation, waits for each detail to be built, then opens every schema inside them. */
async function expandAll(page: Page) {
  const total = await page.locator(OPS).count();
  await page.evaluate((sel) => document.querySelectorAll(sel).forEach((d) => ((d as HTMLDetailsElement).open = true)), OPS);
  await expect(page.locator(`${PANEL} [data-testid="dev-ref-detail"]`)).toHaveCount(total);
  await page.evaluate((sel) => document.querySelectorAll(`${sel} details`).forEach((d) => ((d as HTMLDetailsElement).open = true)), PANEL);
}

const origin = (page: Page) => new URL(page.url()).origin;

test.describe("D#37 WS-F15b: Developer app, API reference (mocked API)", () => {
  test("criterion 1: opening the app makes no spec request; the first tab open makes one; switching makes none", async ({ page }) => {
    const { mock } = await setup(page);
    await expect(tid(page, "dev-tab-tokens")).toHaveAttribute("aria-selected", "true");
    expect(mock.specHits).toEqual([]);
    await openRefTab(page);
    await expect(page.locator(OPS).first()).toBeVisible();
    expect(mock.specHits).toEqual(["/api/v1/openapi.json"]);
    await tid(page, "dev-tab-tokens").click();
    await tid(page, "dev-tab-webhooks").click();
    await tid(page, "dev-tab-apiref").click();
    await expect(page.locator(OPS).first()).toBeVisible();
    expect(mock.specHits).toHaveLength(1);
  });

  test("criterion 2: grouped by area with counts; search filters method, path, summary and operationId", async ({ page }) => {
    const { w } = await setupOnTab(page);
    const headings = page.locator(`${PANEL} [data-testid="dev-ref-group-heading"]`);
    await expect(headings.filter({ hasText: /^account \(2\)$/ })).toHaveCount(1);
    await expect(headings.filter({ hasText: /^webhook-endpoints \(3\)$/ })).toHaveCount(1);
    await expect(headings.filter({ hasText: /^runs \(1\)$/ })).toHaveCount(1);

    const search = tid(page, "dev-ref-search");
    await search.fill("CANCEL"); // path and summary, any case
    await expect(page.locator(`${OPS}:visible`)).toHaveCount(2);
    await expect(headings.filter({ hasText: /^runs \(1\)$/ })).toBeVisible();
    await expect(headings.filter({ hasText: /^work-items \(1\)$/ })).toBeVisible();
    await expect(headings.filter({ hasText: /^account/ })).toBeHidden();
    await search.fill("patch"); // method
    await expect(page.locator(`${OPS}:visible`)).toHaveCount(1);
    await expect(op(page, "/api/v1/account/settings")).toBeVisible();
    await search.fill("createwebhookendpoint"); // operationId, lower-cased
    await expect(page.locator(`${OPS}:visible`)).toHaveCount(1);
    await search.fill("Ask for a run"); // summary
    await expect(op(page, "/api/v1/runs/{id}/cancel")).toBeVisible();

    await search.fill("  zzz<b>x  ");
    await expect(tid(page, "dev-ref-nomatch")).toContainText("No endpoints match");
    await expect(tid(page, "dev-ref-query")).toHaveText("zzz<b>x");
    await expect(page.locator(`${OPS}:visible`)).toHaveCount(0);
    await expect(page.locator(`${PANEL} [data-testid="dev-ref-group"]:visible`)).toHaveCount(0);
    await search.fill("");
    await expect(tid(page, "dev-ref-nomatch")).toBeHidden();
    await expect(page.locator(`${OPS}:visible`)).toHaveCount(await page.locator(OPS).count());
    expect(w.appErrors).toEqual([]);
  });

  test("criterion 3: an operation shows its parameters, schemas, errors and how it is callable", async ({ page }) => {
    await setupOnTab(page);
    const cancel = op(page, "/api/v1/runs/{id}/cancel");
    await cancel.locator("summary").click();
    await expect(cancel.getByTestId("dev-ref-access")).toHaveText("API token or browser session");
    await expect(cancel.getByTestId("dev-ref-scope")).toHaveText("Token scope: runs:cancel");
    await expect(cancel).toContainText("Cancels the run at its next safe point.");
    const params = cancel.getByTestId("dev-ref-params");
    await expect(params.locator("li").nth(0)).toContainText("id in path, required, string (uuid)");
    await expect(params.locator("li").nth(1)).toContainText("reason in query, optional, string");
    await expect(cancel.getByTestId("dev-ref-errors")).toContainText("404 No such run");
    await expect(cancel.getByTestId("dev-ref-errors")).toContainText("409 The run already finished");
    const okSchema = cancel.getByTestId("dev-ref-schema").filter({ hasText: "202 Cancellation requested" });
    await expect(okSchema).toHaveCount(1);
    await expect(okSchema.locator("code.dev-ref-prop")).toBeHidden(); // collapsed until opened
    await okSchema.locator("summary").click();
    await expect(okSchema.locator("code.dev-ref-prop")).toHaveText("status");

    const account = op(page, "/api/v1/account");
    await account.first().locator("summary").click();
    await expect(account.first().getByTestId("dev-ref-access")).toHaveText("API token or browser session");
    await expect(account.first().getByTestId("dev-ref-scope")).toHaveText("Token scope: not listed in this reference");

    const self = op(page, "/api/v1/tokens/{id}");
    await self.locator("summary").click();
    await expect(self.getByTestId("dev-ref-access")).toHaveText("API token (only for the token itself)");
    await expect(self.getByTestId("dev-ref-scope")).toHaveCount(0);
    await expect(self.getByTestId("dev-ref-curl")).toContainText('-H "Authorization: Bearer $FULCRUMAXE_TOKEN"');

    const session = op(page, "/api/v1/account/settings");
    await session.locator("summary").click();
    await expect(session.getByTestId("dev-ref-access")).toHaveText("Browser session only, not with an API token");
    await expect(session.getByTestId("dev-ref-curl")).toHaveCount(0);
    await session.getByTestId("dev-ref-schema").filter({ hasText: "Request body" }).locator("summary").click();
    await expect(session.getByTestId("dev-ref-schema").filter({ hasText: "Request body" })).toContainText("share");
  });

  test("responses: only 4xx and 5xx codes are errors; 2XX and default are ordinary responses", async ({ page }) => {
    await setupOnTab(page, POLISH);
    const status = op(page, "/api/v1/status");
    await status.locator("summary").click();
    const errors = status.getByTestId("dev-ref-errors");
    await expect(errors.locator("li")).toHaveCount(2);
    await expect(errors.locator("li").nth(0)).toContainText("404 Not found");
    await expect(errors.locator("li").nth(1)).toContainText("5XX Server trouble");
    const schemas = status.getByTestId("dev-ref-schema");
    for (const [label, prop] of [["200 Up", "up200"], ["2XX Other success", "up2xx"], ["default (any other status) Anything else", "updefault"]]) {
      const box = schemas.filter({ hasText: label });
      await expect(box).toHaveCount(1);
      await box.locator("summary").click();
      await expect(box.locator("code.dev-ref-prop")).toHaveText(prop);
    }
  });

  test("access: an empty security list means no authentication; the document's list applies when an operation has none", async ({ page }) => {
    await setupOnTab(page, POLISH);
    const open = op(page, "/api/v1/status");
    await open.locator("summary").click();
    await expect(open.getByTestId("dev-ref-access")).toHaveText("No authentication needed");
    await expect(open.getByTestId("dev-ref-curl")).toHaveText(`curl -X GET "${origin(page)}/api/v1/status"`);
    const ping = op(page, "/api/v1/ping"); // no key and no document list: still the session reading
    await ping.locator("summary").click();
    await expect(ping.getByTestId("dev-ref-access")).toHaveText("Browser session only, not with an API token");
    await expect(ping.getByTestId("dev-ref-curl")).toHaveCount(0);
  });

  test("access: an operation without a security key follows the document's top-level list", async ({ page }) => {
    await setupOnTab(page, { ...POLISH, security: [{ token: ["docs:read"] }] });
    const ping = op(page, "/api/v1/ping");
    await ping.locator("summary").click();
    await expect(ping.getByTestId("dev-ref-access")).toHaveText("API token");
    await expect(ping.getByTestId("dev-ref-scope")).toHaveText("Token scope: docs:read");
    await expect(ping.getByTestId("dev-ref-curl")).toContainText('-H "Authorization: Bearer $FULCRUMAXE_TOKEN"');
    const open = op(page, "/api/v1/status"); // its own empty list still wins
    await open.locator("summary").click();
    await expect(open.getByTestId("dev-ref-access")).toHaveText("No authentication needed");
    const session = op(page, "/api/v1/account/settings"); // and so does its own list
    await session.locator("summary").click();
    await expect(session.getByTestId("dev-ref-access")).toHaveText("Browser session only, not with an API token");
  });

  test("criterion 4: details are built on first expand; a $ref cycle and a deep chain stop", async ({ page }) => {
    const { w } = await setupOnTab(page);
    await expect(page.locator(`${PANEL} [data-testid="dev-ref-detail"]`)).toHaveCount(0);
    const graph = op(page, "/api/v1/graph");
    await graph.locator("summary").click();
    await expect(page.locator(`${PANEL} [data-testid="dev-ref-detail"]`)).toHaveCount(1);
    const body = graph.getByTestId("dev-ref-schema").filter({ hasText: "Request body" });
    await body.locator("summary").click();
    // Node -> children -> Node: the property list is written once, then only the name.
    await expect(body.locator("code.dev-ref-prop", { hasText: /^label$/ })).toHaveCount(1);
    await expect(body.locator("code.dev-ref-prop", { hasText: /^children$/ })).toHaveCount(1);
    // D1 -> ... -> D8 is eight $refs deep: the first levels show, the cap stops the rest.
    await expect(body.locator("code.dev-ref-prop", { hasText: /^d1$/ })).toHaveCount(1);
    await expect(body.locator("code.dev-ref-prop", { hasText: /^bottom$/ })).toHaveCount(0);
    await expect(body.locator("span.dev-ref-type", { hasText: /^D3$/ })).toHaveCount(1);
    expect(w.appErrors).toEqual([]);
  });

  test("criterion 5: curl uses the placeholder token, and Copy writes exactly the shown text", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await setupOnTab(page);
    const cancel = op(page, "/api/v1/runs/{id}/cancel");
    await cancel.locator("summary").click();
    const shown = await cancel.getByTestId("dev-ref-curl").textContent();
    expect(shown).toBe(`curl -X POST "${origin(page)}/api/v1/runs/{id}/cancel" -H "Authorization: Bearer $FULCRUMAXE_TOKEN"`);
    await cancel.getByTestId("dev-ref-copy").click();
    await expect(cancel.getByTestId("dev-ref-copy-note")).toHaveText("Copied to the clipboard.");
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe(shown);
    expect(copied).toContain("$FULCRUMAXE_TOKEN");

    const create = op(page, "/api/v1/webhook-endpoints").nth(1); // the POST
    await create.locator("summary").click();
    await expect(create.getByTestId("dev-ref-curl")).toContainText(
      `-H "Content-Type: application/json" -d '{"url":"string","event_types":["pr.opened"]}'`
    );
  });

  test("criterion 5: a token minted and revealed in the Tokens tab never reaches the reference", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    expect(APIREF_SRC).not.toMatch(/(?:from|import\s*\()\s*["'][^"']*developer-tokens/);
    await page.addInitScript(() => {
      const g = window as unknown as { __clip: string[] };
      g.__clip = [];
      const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = (t: string) => {
        g.__clip.push(t);
        return orig(t);
      };
    });
    await setupOnTab(page);
    await expandAll(page);
    await tid(page, "dev-tab-tokens").click();
    await tid(page, "dev-create-open").click();
    await tid(page, "dev-create-submit").click();
    await expect(tid(page, "dev-secret")).toHaveText(/^fxat_/);

    // The reveal is open: press every Copy curl button in the (hidden) reference panel.
    await page.evaluate((sel) => document.querySelectorAll(`${sel} [data-testid="dev-ref-copy"]`).forEach((b) => (b as HTMLElement).click()), PANEL);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __clip: string[] }).__clip.length)).toBeGreaterThan(5);
    const clip = await page.evaluate(() => (window as unknown as { __clip: string[] }).__clip);
    const panelText = await page.evaluate((sel) => document.querySelector(sel)!.textContent ?? "", PANEL);
    for (const t of [...clip, panelText]) expect(t).not.toMatch(/fxat_[A-Za-z0-9]/);
    for (const t of clip) expect(t).toContain("$FULCRUMAXE_TOKEN");

    await tid(page, "dev-reveal-done").click();
    await tid(page, "dev-tab-apiref").click();
    await expect(page.locator(OPS).first()).toBeVisible();
    expect(await page.evaluate((sel) => document.querySelector(sel)!.textContent ?? "", PANEL)).not.toMatch(/fxat_[A-Za-z0-9]/);
  });

  test("criterion 6: curl is offered only for URL-safe paths; a quote in the body survives a POSIX shell", async ({ page }) => {
    await setupOnTab(page);
    await expandAll(page);
    for (const bad of ["/api/v1/bad/$(id)", "/api/v1/bad/`id`", '/api/v1/bad/"quoted"', "/api/v1/bad path"]) {
      const row = op(page, bad);
      await expect(row).toHaveCount(1);
      await expect(row.getByTestId("dev-ref-access")).toHaveText("API token or browser session");
      await expect(row.getByTestId("dev-ref-curl")).toHaveCount(0);
    }
    const graph = op(page, "/api/v1/graph");
    const shown = (await graph.getByTestId("dev-ref-curl").textContent())!;
    expect(shown).toContain(`'\\''`); // the ' in the enum value, written as '\''
    // Let a real POSIX shell read it back: curl becomes a function that prints its arguments.
    const out = execFileSync("sh", ["-c", `curl() { for a in "$@"; do printf '%s\\n' "$a"; done; }\n${shown}`], { env: { FULCRUMAXE_TOKEN: "TOKEN" } })
      .toString()
      .split("\n");
    const bodyArg = out[out.indexOf("-d") + 1];
    expect(JSON.parse(bodyArg)).toEqual({ mood: FIXTURE.paths["/api/v1/graph"].post.requestBody.content["application/json"].schema.properties.mood.enum[0], count: 0, tags: ["string"] });
    expect(out).toContain("Authorization: Bearer TOKEN");
    expect(out).toContain(`${origin(page)}/api/v1/graph`);
  });

  test("criterion 7: hostile strings from the document stay inert text", async ({ page }) => {
    const { w } = await setupOnTab(page, HOSTILE);
    await expandAll(page);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned)).toBeUndefined();
    await expect(page.locator(`${PANEL} script, ${PANEL} img, ${PANEL} iframe, ${PANEL} object`)).toHaveCount(0);
    const hrefs = await page.locator(`${PANEL} a`).evaluateAll((as) => as.map((a) => a.getAttribute("href")));
    expect(hrefs.length).toBeGreaterThanOrEqual(2); // the https links in the info and operation descriptions
    for (const href of hrefs) expect(href).toMatch(/^https:/);
    const shown = await page.evaluate((sel) => (document.querySelector(sel) as HTMLElement).innerText, PANEL);
    for (const s of HOSTILE_STRINGS) expect(shown).toContain(s);
    for (const where of ["INFO ", "SUM ", "DESC ", "PROP ", "RESP "]) expect(shown).toContain(where);
    await expect(page.locator(`${PANEL} code.dev-ref-prop`, { hasText: HOSTILE_STRINGS[1] })).toBeVisible();
    await expect(page.locator(`${PANEL} code.dev-ref-value`, { hasText: HOSTILE_STRINGS[0] })).toBeVisible();
    expect(await w.violations()).toEqual([]);
    expect(w.appErrors).toEqual([]);
  });

  test("criterion 8: Manage in Webhooks switches to the Webhooks tab through the app's own show()", async ({ page }) => {
    await setupOnTab(page);
    await expandAll(page);
    const create = op(page, "/api/v1/webhook-endpoints").nth(1);
    await expect(create.getByTestId("dev-ref-manage-event")).toHaveCount(3); // one per event type
    for (const path of ["/api/v1/runs/{id}/cancel", "/api/v1/account"]) {
      await expect(op(page, path).first().getByTestId("dev-ref-manage-op")).toHaveCount(0);
    }
    await expect(page.locator(`${OPS}:has([data-testid="dev-ref-manage-op"])`)).toHaveCount(3); // the webhook-endpoints area
    await create.getByTestId("dev-ref-manage-event").first().click();
    await expect(tid(page, "dev-tab-webhooks")).toHaveAttribute("aria-selected", "true");
    await tid(page, "dev-tab-apiref").click();
    await op(page, "/api/v1/webhook-endpoints/{id}/test").getByTestId("dev-ref-manage-op").click();
    await expect(tid(page, "dev-tab-webhooks")).toHaveAttribute("aria-selected", "true");
  });

  test("criterion 9: a failed fetch offers Try again; an unreadable document says so without a page error", async ({ page }) => {
    const { w, mock } = await setup(page);
    expect(mock.specHits).toEqual([]); // nothing asks for the document before the tab is first opened
    // The route handler reads mock.reply in the same tick it records the hit, so once a hit
    // is counted its reply is settled and the next one may be set.
    const fetched = (n: number) => expect.poll(() => mock.specHits.length).toBe(n);
    const retry = tid(page, "dev-ref-retry");
    const status = tid(page, "dev-ref-status");
    mock.reply = { status: 500, body: JSON.stringify({ error: { code: "boom", message: "x", request_id: "r" } }) };
    await openRefTab(page);
    await fetched(1);
    await expect(status).toHaveText("Couldn't load the API reference.");
    await expect(retry).toBeVisible();

    mock.reply = { status: 200, body: JSON.stringify({ openapi: "3.1.0", info: {} }) };
    await retry.click();
    await fetched(2);
    await expect(status).toHaveText("The API reference couldn't be read.");
    await expect(retry).toBeVisible();

    mock.reply = { status: 200, body: "this is not json" };
    await retry.click();
    await fetched(3);
    await expect(status).toHaveText("The API reference couldn't be read.");
    await expect(retry).toBeVisible();

    mock.reply = { status: 200, body: JSON.stringify(FIXTURE) };
    await retry.click();
    await fetched(4);
    await expect(page.locator(OPS).first()).toBeVisible();
    await expect(status).toHaveText("");
    await expect(retry).toBeHidden();
    expect(mock.specHits).toHaveLength(4); // the open and one fetch per Try again, none besides
    expect(w.appErrors).toEqual([]);
  });

  test("criterion 10: keyboard only, from the tab bar to a copied curl", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await setup(page);
    const active = () => page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName);
    await tid(page, "dev-tab-tokens").focus();
    await page.keyboard.press("ArrowRight");
    await expect(tid(page, "dev-tab-webhooks")).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowRight");
    await expect(tid(page, "dev-tab-apiref")).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowRight");
    await expect(tid(page, "dev-tab-tokens")).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowLeft");
    await expect(tid(page, "dev-tab-apiref")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(OPS).first()).toBeVisible();

    await page.keyboard.press("Tab");
    expect(await active()).toBe("dev-ref-search");
    await page.keyboard.type("cancel");
    await expect(page.locator(`${OPS}:visible`)).toHaveCount(2);
    // Any link in the document's own description comes next; the first match's summary follows it.
    for (let i = 0; i < 5 && (await active()) !== "SUMMARY"; i++) await page.keyboard.press("Tab");
    expect(await active()).toBe("SUMMARY");
    await page.keyboard.press("Enter");
    const first = op(page, "/api/v1/runs/{id}/cancel");
    await expect(first.getByTestId("dev-ref-detail")).toBeVisible();
    for (let i = 0; i < 30 && (await active()) !== "dev-ref-copy"; i++) await page.keyboard.press("Tab");
    expect(await active()).toBe("dev-ref-copy");
    await page.keyboard.press("Enter");
    await expect(first.getByTestId("dev-ref-copy-note")).toHaveText("Copied to the clipboard.");
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain("/api/v1/runs/{id}/cancel");
    expect(copied).toContain("Bearer $FULCRUMAXE_TOKEN");
  });

  test("criterion 11: with every operation open the real document does not widen the panel", async ({ page }, testInfo) => {
    await setupOnTab(page, REAL);
    const total = Object.values(REAL.paths as Record<string, object>).reduce((n, item) => n + Object.keys(item).filter((k) => k !== "parameters").length, 0);
    await expect(page.locator(OPS)).toHaveCount(total);
    await expandAll(page);
    const sizes = await page.evaluate((sel) => {
      const root = document.querySelector(`${sel} [data-testid="dev-ref-app"]`) as HTMLElement;
      const panel = document.querySelector(sel) as HTMLElement;
      const code = Array.from(document.querySelectorAll(`${sel} pre.dev-ref-code`)) as HTMLElement[];
      return {
        rootScroll: root.scrollWidth, rootClient: root.clientWidth,
        panelScroll: panel.scrollWidth, panelClient: panel.clientWidth,
        codeScrolls: code.filter((c) => c.scrollWidth > c.clientWidth).length,
      };
    }, PANEL);
    expect(sizes.rootScroll).toBeLessThanOrEqual(sizes.rootClient);
    expect(sizes.panelScroll).toBeLessThanOrEqual(sizes.panelClient);
    if (testInfo.project.name === "phone") expect(sizes.codeScrolls).toBeGreaterThan(0); // long curl lines scroll inside their own box
  });

  test("criterion 12: the tab makes no request but its own, shows no forbidden string, and ignores live events", async ({ page }) => {
    const failures: string[] = [];
    page.on("response", (res) => res.status() >= 400 && failures.push(`${res.status()} ${res.url()}`));
    page.on("requestfailed", (req) => failures.push(`failed ${req.url()}`));
    const { mock } = await setupOnTab(page, REAL);
    const opened = mock.specHits.length;
    await expandAll(page);
    expect(failures).toEqual([]);
    const re = /claude[\s_\-. ]*code/i;
    expect(await page.title()).not.toMatch(re);
    expect(await page.locator("body").innerText()).not.toMatch(re);
    const attrs = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[title], [aria-label], [placeholder]")).flatMap((el) =>
        ["title", "aria-label", "placeholder"].map((a) => el.getAttribute(a) ?? "")
      )
    );
    for (const a of attrs) expect(a).not.toMatch(re);
    expect(mock.specHits).toHaveLength(opened); // expanding fetches nothing
  });
});

test.describe("D#37 WS-F15b: the reference and live events", () => {
  test("criterion 12: live events and a focus refresh re-fetch the token list, never the reference", async ({ page }) => {
    const specHits: string[] = [];
    let tokenGets = 0;
    await page.route("**/api/v1/openapi.json", (route) => {
      specHits.push(route.request().url());
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(FIXTURE) });
    });
    await page.route("**/api/v1/tokens", (route) => {
      tokenGets++;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [], next_cursor: null }) });
    });
    await page.goto("/");
    await page.waitForFunction(() => (window as unknown as { currentStep?: string }).currentStep === "DESKTOP", null, { timeout: 30_000 });
    await openDeveloper(page);
    await expect.poll(() => tokenGets).toBeGreaterThan(0);
    await openRefTab(page);
    await expect(page.locator(OPS).first()).toBeVisible();
    const opened = specHits.length;
    const before = tokenGets;
    await page.evaluate(async () => {
      const ns = await import(new URL("core/storage-ns.js", document.baseURI).href);
      const ch = new BroadcastChannel("fx-live-" + (ns.getNamespace() || "default"));
      ch.postMessage({ type: "event", event: { id: "e-1", type: "api_token.created", created_at: new Date().toISOString(), data: {} } });
      ch.close();
      window.dispatchEvent(new Event("focus"));
    });
    await expect.poll(() => tokenGets, { timeout: 5000 }).toBeGreaterThan(before);
    await page.waitForTimeout(1500);
    expect(specHits).toHaveLength(opened);
  });
});
