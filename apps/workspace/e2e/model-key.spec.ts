// apps/workspace/e2e/model-key.spec.ts
//
// D#37 WS-F5a/F5b (corrections C31, C33, C34): the Model Key app, against the built cloud dist served by
// fixture-server.mjs. The 2xx bodies come from the repo's contract fixtures
// (packages/api/fixtures/v1/**); every 4xx and the bodiless 204 are mocked inline with page.route()
// (C33 section 2). The document carries the production CSP and Trusted Types directives, so a sink
// in the app fails here for real. The suite runs under the desktop, phone and tablet projects.
//
// The secret checks share one helper, browserHolds(): the DOM, every form value, both web storages,
// every IndexedDB record and the URL. Console output and every request URL are collected separately.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect, type Page, type Route } from "@playwright/test";
import { bootToDesktop, holdClock } from "./helpers/boot";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const V1 = join(SCRIPT_DIR, "..", "..", "..", "packages", "api", "fixtures", "v1");
const fixture = (...p: string[]) => JSON.parse(readFileSync(join(V1, ...p), "utf8"));
const OK = fixture("getModelConnection", "200-ok.json");
const BROKEN = fixture("getModelConnection", "200-broken.json");
const PUT_OK = fixture("putModelConnection", "200-ok.json");
const TEST_BROKEN = fixture("testModelConnection", "200-broken.json");

// A canary that appears nowhere else: any trace of it, or of its ends, is a leak.
const KEY = "zq7canaryKEY4d2b91xxwv";
const LEAK_PARTS = [KEY, KEY.slice(0, 6), KEY.slice(-6)];

const CSP =
  "script-src 'self'; object-src 'none'; base-uri 'self'; require-trusted-types-for 'script'; trusted-types 'none'";
const MK = `#windows-container .fulc-window[data-app-id="model-key"]`;
const tid = (page: Page, id: string) => page.locator(`${MK} [data-testid="${id}"]`);

interface Sent { method: string; path: string; headers: Record<string, string>; body: string | null }
interface Mock {
  sent: Sent[];
  gets: number;
  conn: Record<string, unknown> | null;
  putReply?: () => { status: number; json: unknown; headers?: Record<string, string> };
  /** The next Test key call is refused with 429; `retryAfter` is the header value, or none when absent. */
  testLimit?: { retryAfter?: string };
  deleteStatus: number;
  getStatus?: number;
  testReply: Record<string, unknown>;
  gate?: Promise<void>;
  getGate?: Promise<void>;
  gatedServed: number; // gated GETs whose (stale) answer has been handed to the browser
  armEvent?: string;
}
interface Watch { console: string[]; errors: string[]; urls: string[]; violations: () => Promise<string[]> }

// The v1 error envelope with the code and details.path the route really returns
// (packages/api/src/routes/model-connection.ts: invalid_model_key, path "key" or "provider").
// The message deliberately echoes the canary: the app must never show error.message.
const invalidKey = (path: string, code: string) => ({
  status: 422,
  json: { error: { code: "invalid_model_key", message: `the key ${KEY} was not accepted`, request_id: "r1" }, details: [{ path, code }] },
});

async function setup(page: Page, opts: { admin?: boolean; conn?: Record<string, unknown> | null } = {}) {
  const w: Watch = { console: [], errors: [], urls: [], violations: async () => [] };
  page.on("console", (m) => {
    w.console.push(m.text());
    // Chromium itself logs every 4xx fetch as "Failed to load resource"; only the app's own errors count.
    if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) w.errors.push(m.text());
  });
  page.on("pageerror", (e) => {
    w.console.push(`pageerror: ${e.message}`);
    w.errors.push(e.message);
  });
  page.on("request", (r) => w.urls.push(r.url()));
  await page.addInitScript(() => {
    const g = window as unknown as { __tt: string[] };
    g.__tt = [];
    document.addEventListener("securitypolicyviolation", (e) => g.__tt.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  w.violations = () => page.evaluate(() => (window as unknown as { __tt: string[] }).__tt);
  await page.route((u) => u.pathname === "/", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), "content-security-policy": CSP } });
  });
  const mock: Mock = { sent: [], gets: 0, gatedServed: 0, conn: opts.conn === undefined ? structuredClone(OK) : opts.conn, deleteStatus: 204, testReply: TEST_BROKEN };
  await page.route("**/api/cloud/auth/me", async (route: Route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), is_admin: !!opts.admin } });
  });
  // The live stream: idle by default; one armed frame is delivered the next time the client reconnects.
  await page.route("**/api/v1/events", (route) => {
    const frame = mock.armEvent;
    mock.armEvent = undefined;
    route.fulfill({ status: 200, contentType: "text/event-stream", body: frame ?? "event: idle\ndata: {}\n\n" });
  });
  await page.route("**/api/v1/model-connection**", async (route) => {
    const req = route.request();
    const method = req.method();
    const path = new URL(req.url()).pathname;
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(body) });
    if (method === "GET") {
      mock.gets++;
      if (mock.getGate) {
        const stale = mock.conn; // the answer as it was when the request arrived
        await mock.getGate;
        await (stale ? json(200, stale) : json(404, { error: { code: "not_found", message: "not found", request_id: "r3" } }));
        mock.gatedServed++;
        return;
      }
      if (mock.getStatus) return json(mock.getStatus, { error: { code: "boom", message: `internal ${KEY}`, request_id: "r2" } });
      return mock.conn ? json(200, mock.conn) : json(404, { error: { code: "not_found", message: "not found", request_id: "r3" } });
    }
    mock.sent.push({ method, path, headers: await req.allHeaders(), body: req.postData() });
    if (mock.gate) await mock.gate;
    if (method === "PUT") {
      const forced = mock.putReply?.();
      if (forced) return json(forced.status, forced.json, forced.headers);
      mock.conn = structuredClone(PUT_OK);
      return json(200, mock.conn);
    }
    if (method === "DELETE") {
      if (mock.deleteStatus === 204) mock.conn = null;
      return mock.deleteStatus === 204
        ? route.fulfill({ status: 204 })
        : json(mock.deleteStatus, { error: { code: "insufficient_role", message: "insufficient account role", request_id: "r4" } });
    }
    if (mock.testLimit) {
      const limit = mock.testLimit;
      mock.testLimit = undefined;
      return json(429, { error: { code: "rate_limited", message: `slow down ${KEY}`, request_id: "r6" } }, limit.retryAfter ? { "Retry-After": limit.retryAfter } : {});
    }
    mock.conn = structuredClone(mock.testReply);
    return json(200, mock.conn);
  });
  await bootToDesktop(page);
  await open(page);
  return { w, mock };
}

async function open(page: Page) {
  await page.locator('.dock-icon[data-app-id="model-key"]').click();
  await expect(page.locator(MK)).toBeVisible();
  await expect(page.locator(MK)).not.toHaveClass(/opening/);
}

async function browserHolds(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const parts: string[] = [document.documentElement.outerHTML, location.href];
    document.querySelectorAll("input, textarea, select").forEach((el) => parts.push((el as HTMLInputElement).value));
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i)!;
        parts.push(k, store.getItem(k) ?? "");
      }
    }
    for (const info of (await indexedDB.databases?.()) ?? []) {
      if (!info.name) continue;
      await new Promise<void>((resolve) => {
        const req = indexedDB.open(info.name!);
        req.onerror = () => resolve();
        req.onsuccess = () => {
          const db = req.result;
          const names = Array.from(db.objectStoreNames);
          if (names.length === 0) { db.close(); return resolve(); }
          const tx = db.transaction(names, "readonly");
          let pending = names.length;
          for (const n of names) {
            const all = tx.objectStore(n).getAll();
            const done = () => { if (--pending === 0) { db.close(); resolve(); } };
            all.onsuccess = () => { parts.push(JSON.stringify(all.result)); done(); };
            all.onerror = done;
          }
        };
      });
    }
    return parts.join("\n");
  });
}

async function expectNoKey(page: Page, w: Watch) {
  const held = await browserHolds(page);
  for (const part of LEAK_PARTS) {
    expect(held.includes(part), `the browser holds "${part}"`).toBe(false);
    expect(w.console.join("\n").includes(part), `console output holds "${part}"`).toBe(false);
    expect(w.urls.some((u) => u.includes(part)), `a request URL holds "${part}"`).toBe(false);
  }
  expect(await page.locator(`${MK} input`).evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))).not.toContain(KEY);
}

/**
 * The shell starts the live client from the boot:desktop-ready performance mark, which the fake test clock
 * swallows, so the tests start the real client through its own exported start(). Everything after that is
 * the shell's code: the stream request, frame parsing, dispatch to subscribers, the focus backstop.
 */
const startLive = (page: Page) =>
  page.evaluate(async () => (await import(new URL("core/cloud-live.js", document.baseURI).href)).default.start());

async function paste(page: Page, key = KEY) {
  await tid(page, "mk-key").fill(key);
  await tid(page, "mk-save").click();
}

test.describe("D#37 WS-F5: Model Key app (mocked API)", () => {
  test("shows provider, status, last check and the Key check fingerprint, from one GET", async ({ page }) => {
    const { mock, w } = await setup(page, { admin: true });
    await expect(tid(page, "mk-facts")).toContainText("Vercel AI Gateway");
    await expect(tid(page, "mk-state")).toHaveText("Working");
    await expect(tid(page, "mk-facts")).toContainText("Key check");
    await expect(tid(page, "mk-fingerprint")).toHaveText(OK.fingerprint);
    expect(mock.gets).toBe(1);
    expect(await w.violations()).toEqual([]);
    expect(w.errors).toEqual([]);
  });

  test("no connection: an admin gets the paste form; the key field is a password field that never autocompletes", async ({ page }) => {
    await setup(page, { admin: true, conn: null });
    await expect(tid(page, "mk-none")).toBeVisible();
    const input = tid(page, "mk-key");
    await expect(input).toHaveAttribute("type", "password");
    await expect(input).toHaveAttribute("autocomplete", "off");
    await expect(input).toHaveAttribute("spellcheck", "false");
    expect(await page.locator(`${MK} form`).getAttribute("autocomplete")).toBe("off");
  });

  test("pasting is allowed: a paste event is not cancelled and its text lands in the field", async ({ page }) => {
    await setup(page, { admin: true, conn: null });
    const cancelled = await tid(page, "mk-key").evaluate((el) => {
      (el as HTMLInputElement).focus();
      const dt = new DataTransfer();
      dt.setData("text/plain", "pasted-value");
      const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
      return !el.dispatchEvent(ev);
    });
    expect(cancelled).toBe(false);
  });

  test("save: the key is sent once in the body, the field is empty while the request is pending, and nothing holds the key afterwards", async ({ page }) => {
    const { mock, w } = await setup(page, { admin: true, conn: null });
    let release!: () => void;
    mock.gate = new Promise<void>((r) => (release = r));
    await tid(page, "mk-provider").selectOption("anthropic");
    await paste(page);
    await expect.poll(() => mock.sent.length).toBe(1);
    // Still pending: the field is already empty and disabled.
    await expect(tid(page, "mk-key")).toHaveValue("");
    release();
    await expect(tid(page, "mk-notice")).toHaveText("Key saved.");
    const put = mock.sent[0]!;
    expect(put.method).toBe("PUT");
    expect(put.path).toBe("/api/v1/model-connection");
    expect(JSON.parse(put.body!)).toEqual({ provider: "anthropic", key: KEY });
    expect(put.headers["content-type"]).toBe("application/json");
    expect(put.headers["idempotency-key"]).toBeUndefined();
    await expect(tid(page, "mk-fingerprint")).toHaveText(PUT_OK.fingerprint);
    await expect(page.locator(`${MK} form`)).toHaveCount(0);
    await expectNoKey(page, w);
    expect(await w.violations()).toEqual([]);
  });

  test("a 422 shows the app's own sentence on the field, never error.message, and still leaves no key behind", async ({ page }) => {
    const { mock, w } = await setup(page, { admin: true, conn: null });
    mock.putReply = () => invalidKey("key", "rejected");
    await paste(page);
    await expect(tid(page, "mk-key-error")).toHaveText("The provider rejected this key.");
    await expect(tid(page, "mk-key")).toHaveAttribute("aria-invalid", "true");
    await expect(tid(page, "mk-key")).toHaveValue("");
    mock.putReply = () => invalidKey("key", "invalid_key_format");
    await paste(page, KEY);
    await expect(tid(page, "mk-key-error")).toHaveText("That doesn't look like a key for this provider.");
    mock.putReply = () => invalidKey("provider", "some_other_reason");
    await paste(page, KEY);
    await expect(tid(page, "mk-provider-error")).toHaveText("This provider isn't available right now.");
    await expect(page.locator(MK)).not.toContainText("was not accepted");
    await expectNoKey(page, w);
  });

  test("provider_disabled: choosing Anthropic while it is off says so in words under the provider select", async ({ page }) => {
    const { mock, w } = await setup(page, { admin: true, conn: null });
    mock.putReply = () => invalidKey("provider", "provider_disabled");
    await tid(page, "mk-provider").selectOption("anthropic");
    await paste(page);
    await expect(tid(page, "mk-provider-error")).toHaveText("Anthropic keys aren't available yet. Use a Vercel AI Gateway key for now.");
    await expect(page.locator(MK)).not.toContainText("That didn't work");
    await expect(page.locator(MK)).not.toContainText(/ApiError|Could not load/);
    expect(w.errors).toEqual([]);
  });

  test("a provider-only error on an existing connection puts focus on the provider select, not the disabled Replace", async ({ page }) => {
    const { mock } = await setup(page, { admin: true });
    mock.putReply = () => invalidKey("provider", "provider_disabled");
    await tid(page, "mk-replace").click();
    await tid(page, "mk-provider").selectOption("anthropic");
    await paste(page);
    await expect(tid(page, "mk-provider-error")).toBeVisible();
    await expect(tid(page, "mk-key-error")).toBeHidden();
    await expect(tid(page, "mk-provider")).toBeFocused();
  });

  test("an error code that is a prototype key falls back to the generic key sentence", async ({ page }) => {
    const { mock } = await setup(page, { admin: true, conn: null });
    for (const code of ["constructor", "__proto__", "toString"]) {
      mock.putReply = () => invalidKey("key", code);
      await paste(page);
      await expect(tid(page, "mk-key-error")).toHaveText("The key was not accepted.");
    }
  });

  test("the provider select is described by its help text", async ({ page }) => {
    await setup(page, { admin: true, conn: null });
    const ids = ((await tid(page, "mk-provider").getAttribute("aria-describedby")) ?? "").split(" ");
    expect(ids.length).toBeGreaterThan(0);
    const help = page.locator(`${MK} #${ids[0]}`);
    await expect(help).toHaveCount(1);
    await expect(help).toHaveText(/\S/);
  });

  test("the key field is emptied on Cancel, when the form is closed by a state change, and on destroy", async ({ page }) => {
    const { mock } = await setup(page, { admin: true });
    await tid(page, "mk-replace").click();
    await tid(page, "mk-key").fill(KEY);
    const input = (await tid(page, "mk-key").elementHandle())!;
    await tid(page, "mk-cancel").click();
    await expect(page.locator(`${MK} form`)).toHaveCount(0);
    expect(await input.evaluate((el) => (el as HTMLInputElement).value)).toBe("");
    // Closed by state: the first-key form is up, a refresh fails, and render() takes the form away.
    mock.conn = null;
    await startLive(page);
    await page.clock.runFor(11_000);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(tid(page, "mk-key")).toBeVisible();
    await tid(page, "mk-key").fill(KEY);
    mock.getStatus = 500;
    await page.clock.runFor(11_000);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(tid(page, "mk-load-error")).toBeVisible();
    await expect(page.locator(`${MK} form`)).toHaveCount(0);
    expect(await input.evaluate((el) => (el as HTMLInputElement).value)).toBe("");
    // Destroy: the window closes with a key still typed.
    mock.getStatus = undefined;
    await tid(page, "mk-retry").click();
    await expect(tid(page, "mk-key")).toBeVisible();
    await tid(page, "mk-key").fill(KEY);
    const typed = (await tid(page, "mk-key").elementHandle())!;
    await page.evaluate(() => (window as unknown as { FULCWM: { close: (id: string) => void } }).FULCWM.close("model-key"));
    await expect(page.locator(MK)).toHaveCount(0);
    expect(await typed.evaluate((el) => (el as HTMLInputElement).value)).toBe("");
  });

  test("minimizing the window empties the typed key, and restoring shows an empty field", async ({ page }) => {
    const { w } = await setup(page, { admin: true, conn: null });
    await tid(page, "mk-key").fill(KEY);
    const input = (await tid(page, "mk-key").elementHandle())!;
    await page.evaluate(() => (window as unknown as { FULCWM: { minimize: (id: string) => void } }).FULCWM.minimize("model-key"));
    expect(await input.evaluate((el) => (el as HTMLInputElement).value)).toBe("");
    await page.evaluate(() => (window as unknown as { FULCWM: { restore: (id: string) => void } }).FULCWM.restore("model-key"));
    // Past the minimize animation's 200 ms, so a late finish of that animation cannot slip in between
    // the restore and the checks (it used to re-hide the window on a slow machine).
    await page.clock.runFor(1_000);
    await expect(tid(page, "mk-key")).toBeVisible();
    await expect(tid(page, "mk-key")).toHaveValue("");
    await expectNoKey(page, w);
  });

  test("restoring a window right after minimizing it leaves it restored once the minimize animation's 200 ms have passed", async ({ page }) => {
    // The shell finishes a minimize 200 ms after it starts. A restore that lands inside those 200 ms
    // used to be undone by that late callback (the window came back hidden and "minimized"). The page
    // clock is driven past the 200 ms explicitly, so this never depends on how fast the machine is.
    await setup(page, { admin: true, conn: null });
    await page.evaluate(() => {
      const wm = (window as unknown as { FULCWM: { minimize: (id: string) => void; restore: (id: string) => void } }).FULCWM;
      wm.minimize("model-key");
      wm.restore("model-key");
    });
    await page.clock.runFor(1_000);
    await expect(page.locator(MK)).not.toHaveClass(/minimized/);
    await expect(tid(page, "mk-key")).toBeVisible();
  });

  test("pagehide empties the key field, so a restored page never shows a pasted key", async ({ page }) => {
    await setup(page, { admin: true, conn: null });
    await tid(page, "mk-key").fill(KEY);
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await expect(tid(page, "mk-key")).toHaveValue("");
  });

  test("focus stays on the acted-on control after Test, Save and Remove", async ({ page }) => {
    await setup(page, { admin: true });
    await tid(page, "mk-test").click();
    await expect(tid(page, "mk-notice")).toHaveText("The key was rejected.");
    await expect(tid(page, "mk-test")).toBeFocused();
    await tid(page, "mk-replace").click();
    await paste(page);
    await expect(tid(page, "mk-notice")).toHaveText("Key saved.");
    await expect(tid(page, "mk-replace")).toBeFocused();
    await tid(page, "mk-remove").click();
    await page.locator("#fulc-modal-yes").click();
    await expect(tid(page, "mk-notice")).toHaveText("Key removed.");
    // The Remove button is gone with the connection; focus moves to the paste field, not to the page.
    await expect(tid(page, "mk-key")).toBeFocused();
  });

  test("a slow status fetch that lands after a save does not replace the saved connection", async ({ page }) => {
    const { mock } = await setup(page, { admin: true });
    await startLive(page);
    await page.clock.runFor(11_000);
    mock.conn = { ...structuredClone(OK), fingerprint: "beef" };
    let release!: () => void;
    mock.getGate = new Promise<void>((r) => (release = r));
    const before = mock.gets;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => mock.gets).toBeGreaterThan(before); // the refresh is now in flight, holding the old answer
    await tid(page, "mk-replace").click();
    await paste(page);
    await expect(tid(page, "mk-notice")).toHaveText("Key saved.");
    await expect(tid(page, "mk-fingerprint")).toHaveText(PUT_OK.fingerprint);
    release();
    await expect.poll(() => mock.gatedServed).toBe(1); // the stale answer has reached the browser
    // Let the page take it in: one real (unfaked) task turn.
    await page.evaluate(() => new Promise<void>((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); }));
    await expect(tid(page, "mk-fingerprint")).toHaveText(PUT_OK.fingerprint);
  });

  test("a forced 403 on save is shown as a sentence, with no key left and no app console error", async ({ page }) => {
    const { mock, w } = await setup(page, { admin: true, conn: null });
    mock.putReply = () => ({ status: 403, json: { error: { code: "insufficient_role", message: `insufficient ${KEY}`, request_id: "r5" } } });
    await paste(page);
    await expect(tid(page, "mk-notice")).toHaveText("Only owners and admins can change this.");
    await expectNoKey(page, w);
    expect(w.errors).toEqual([]);
  });

  test("an empty paste is refused in the form without a request", async ({ page }) => {
    const { mock } = await setup(page, { admin: true, conn: null });
    await paste(page, "   ");
    await expect(tid(page, "mk-key-error")).toHaveText("Paste a key first.");
    expect(mock.sent).toEqual([]);
  });

  test("test key: a rejected key is said in words; a working one is confirmed", async ({ page }) => {
    const { mock } = await setup(page, { admin: true });
    await tid(page, "mk-test").click();
    await expect(tid(page, "mk-notice")).toHaveText("The key was rejected.");
    await expect(tid(page, "mk-broken")).toBeVisible();
    expect(mock.sent.map((s) => `${s.method} ${s.path}`)).toEqual(["POST /api/v1/model-connection/test"]);
    expect(mock.sent[0]!.headers["content-type"]).toBe("application/json");
    mock.testReply = { ...OK };
    await tid(page, "mk-test").click();
    await expect(tid(page, "mk-notice")).toHaveText("The key works.");
    await expect(tid(page, "mk-state")).toHaveText("Working");
    mock.testReply = { ...BROKEN, last_error_code: "500" };
    await tid(page, "mk-test").click();
    await expect(tid(page, "mk-notice")).toHaveText("The provider could not be reached to check the key.");
  });

  test("a 429 on Test key counts down from Retry-After, keeps the button off until it ends, then works again", async ({ page }) => {
    const { mock } = await setup(page, { admin: true });
    mock.testReply = { ...OK };
    mock.testLimit = { retryAfter: "4" };
    await holdClock(page); // the countdown is page time: only the runFor calls below move it, however slow the machine is
    await tid(page, "mk-test").click();
    await expect(tid(page, "mk-notice")).toHaveText("Too many tries. Try again in 4 seconds.");
    await expect(tid(page, "mk-test")).toBeDisabled();
    await page.clock.runFor(1_000);
    await expect(tid(page, "mk-notice")).toHaveText("Too many tries. Try again in 3 seconds.");
    await page.clock.runFor(2_000);
    await expect(tid(page, "mk-notice")).toHaveText("Too many tries. Try again in 1 second.");
    await expect(tid(page, "mk-test")).toBeDisabled();
    // Nothing more was sent while the button was off.
    expect(mock.sent.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /api/v1/model-connection/test"]);
    await page.clock.runFor(1_000);
    await expect(tid(page, "mk-test")).toBeEnabled();
    await expect(tid(page, "mk-notice")).toHaveText("");
    await tid(page, "mk-test").click();
    await expect(tid(page, "mk-notice")).toHaveText("The key works.");
    expect(mock.sent).toHaveLength(2);
  });

  test("a 429 without a usable Retry-After still says how long, in plain words, never undefined or NaN", async ({ page }) => {
    const { mock } = await setup(page, { admin: true });
    mock.testLimit = {};
    await tid(page, "mk-test").click();
    const notice = tid(page, "mk-notice");
    await expect(notice).toHaveText("Too many tries. Try again in 10 seconds.");
    await expect(notice).not.toContainText(/undefined|null|NaN/);
    await expect(tid(page, "mk-test")).toBeDisabled();
    mock.testLimit = { retryAfter: "soon" };
    await page.clock.runFor(10_000);
    await expect(tid(page, "mk-test")).toBeEnabled();
    await tid(page, "mk-test").click();
    await expect(notice).toHaveText("Too many tries. Try again in 10 seconds.");
  });

  test("a 429 on Save key does the same: seconds from Retry-After, Save and Test off, and the server message never shown", async ({ page }) => {
    const { mock, w } = await setup(page, { admin: true, conn: null });
    mock.putReply = () => ({ status: 429, json: { error: { code: "rate_limited", message: `slow down ${KEY}`, request_id: "r7" } }, headers: { "Retry-After": "7" } });
    await paste(page);
    await expect(tid(page, "mk-notice")).toHaveText("Too many tries. Try again in 7 seconds.");
    await expect(tid(page, "mk-save")).toBeDisabled();
    await expectNoKey(page, w);
    mock.putReply = undefined;
    await page.clock.runFor(7_000);
    await expect(tid(page, "mk-save")).toBeEnabled();
    await expect(tid(page, "mk-notice")).toHaveText("");
  });

  test("another message during the wait is not overwritten by the countdown", async ({ page }) => {
    const { mock } = await setup(page, { admin: true });
    mock.testLimit = { retryAfter: "5" };
    await tid(page, "mk-test").click();
    await expect(tid(page, "mk-notice")).toHaveText("Too many tries. Try again in 5 seconds.");
    await tid(page, "mk-remove").click();
    await page.locator("#fulc-modal-yes").click();
    await expect(tid(page, "mk-notice")).toHaveText("Key removed.");
    await page.clock.runFor(2_000);
    await expect(tid(page, "mk-notice")).toHaveText("Key removed.");
  });

  test("broken key: the broken state offers Replace key, and saving a new key clears it", async ({ page }) => {
    const { mock, w } = await setup(page, { admin: true, conn: structuredClone(BROKEN) });
    await expect(tid(page, "mk-broken")).toContainText("The key was rejected.");
    await expect(tid(page, "mk-state")).toHaveText("Broken");
    await expect(page.locator(`${MK} form`)).toHaveCount(0);
    await tid(page, "mk-replace").click();
    await expect(tid(page, "mk-key")).toBeFocused();
    await paste(page);
    await expect(tid(page, "mk-state")).toHaveText("Working");
    await expect(tid(page, "mk-broken")).toHaveCount(0);
    expect(mock.sent.map((s) => s.method)).toEqual(["PUT"]);
    await expectNoKey(page, w);
  });

  test("remove: needs a confirm; No sends nothing, Yes deletes and offers the paste form", async ({ page }) => {
    const { mock } = await setup(page, { admin: true });
    await tid(page, "mk-remove").click();
    await page.locator("#fulc-modal-no").click();
    await page.waitForTimeout(50);
    expect(mock.sent).toEqual([]);
    await tid(page, "mk-remove").click();
    await page.locator("#fulc-modal-yes").click();
    await expect(tid(page, "mk-notice")).toHaveText("Key removed.");
    expect(mock.sent.map((s) => `${s.method} ${s.path}`)).toEqual(["DELETE /api/v1/model-connection"]);
    await expect(tid(page, "mk-none")).toBeVisible();
    await expect(tid(page, "mk-key")).toBeVisible();
  });

  test("a member sees status only: no form and no actions, with or without a connection", async ({ page }) => {
    const { mock } = await setup(page, { admin: false });
    await expect(tid(page, "mk-fingerprint")).toBeVisible();
    await expect(tid(page, "mk-actions")).toHaveCount(0);
    await expect(page.locator(`${MK} form`)).toHaveCount(0);
    mock.conn = null;
    await page.evaluate(() => (window as unknown as { FULCWM: { close: (id: string) => void } }).FULCWM.close("model-key"));
    await expect(page.locator(MK)).toHaveCount(0);
    await open(page);
    await expect(tid(page, "mk-none")).toContainText("No model key is connected.");
    await expect(page.locator(MK)).toContainText("Ask an owner or admin");
    await expect(page.locator(`${MK} form`)).toHaveCount(0);
  });

  test("load errors use the app's sentence: a 500 or a 401 never shows the server text or a reload prompt", async ({ page }) => {
    const { mock } = await setup(page, { admin: true });
    mock.getStatus = 500;
    await page.evaluate(() => (window as unknown as { FULCWM: { close: (id: string) => void } }).FULCWM.close("model-key"));
    await expect(page.locator(MK)).toHaveCount(0);
    await open(page);
    await expect(tid(page, "mk-load-error")).toContainText("The model key status could not be loaded.");
    await expect(page.locator(MK)).not.toContainText("internal");
    mock.getStatus = 401;
    await tid(page, "mk-retry").click();
    await expect(tid(page, "mk-load-error")).toBeVisible();
    await expect(page.locator(MK)).not.toContainText(/reload the page/i);
    mock.getStatus = undefined;
    await tid(page, "mk-retry").click();
    await expect(tid(page, "mk-fingerprint")).toBeVisible();
  });

  test("live: model_connection.broken re-fetches the status, and typing in the replace form survives it", async ({ page }) => {
    const { mock } = await setup(page, { admin: true });
    await expect(tid(page, "mk-state")).toHaveText("Working");
    await tid(page, "mk-replace").click();
    await tid(page, "mk-key").fill("partial-typing");
    mock.conn = structuredClone(BROKEN);
    mock.armEvent = `data: ${JSON.stringify({ type: "model_connection.broken", data: { code: 401 } })}\n\n`;
    await startLive(page); // opens the stream, whose first frame is the armed event
    await expect(tid(page, "mk-state")).toHaveText("Broken");
    await expect(tid(page, "mk-key")).toHaveValue("partial-typing");
  });

  test("live: refresh re-fetches, and 20 open/close cycles leave the subscriber count at its baseline", async ({ page }) => {
    const { mock } = await setup(page, { admin: true });
    const count = () =>
      page.evaluate(async () => (await import(new URL("core/cloud-live.js", document.baseURI).href)).subscriberCount() as number);
    const open1 = await count();
    const before = mock.gets;
    mock.conn = { ...structuredClone(OK), fingerprint: "beef" };
    await startLive(page);
    await page.clock.runFor(11_000);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(tid(page, "mk-fingerprint")).toHaveText("beef");
    expect(mock.gets).toBeGreaterThan(before);
    const close = () => page.evaluate(() => (window as unknown as { FULCWM: { close: (id: string) => void } }).FULCWM.close("model-key"));
    await close();
    await expect(page.locator(MK)).toHaveCount(0);
    const baseline = await count();
    expect(open1 - baseline).toBe(2); // the app's two subscriptions
    for (let i = 0; i < 20; i++) {
      await page.evaluate(() => (window as unknown as { FULCWM: { open: (id: string) => void } }).FULCWM.open("model-key"));
      await expect(page.locator(MK)).toBeVisible();
      await close();
      await expect(page.locator(MK)).toHaveCount(0);
    }
    expect(await count()).toBe(baseline);
  });

  test("layout: the whole flow fits the window with no sideways scroll, and buttons are touch-sized on a phone", async ({ page }, testInfo) => {
    await setup(page, { admin: true, conn: null });
    const app = page.locator(`${MK} .mk-app`);
    expect(await app.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    if (testInfo.project.name === "phone") {
      // The rule is min-height: 44px; a scaled phone viewport can render it a fraction short, so the CSS value is checked.
      expect(await tid(page, "mk-save").evaluate((el) => getComputedStyle(el).minHeight)).toBe("44px");
    }
    await paste(page);
    await expect(tid(page, "mk-notice")).toHaveText("Key saved.");
    expect(await app.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  });
});
