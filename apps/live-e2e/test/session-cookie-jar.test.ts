/**
 * The session fixture composed with the write fence and the bypass route, in a REAL Playwright run (the spec imports
 * `fixtures/session.ts`, which extends `fixtures/bypass.ts`, where the bypass route and the fence are automatic
 * fixtures on the same `context`). Line 13a of the T3 list: after the fixture has put the stored cookie in the
 * browser, the context's cookie jar holds exactly one cookie, `__Host-fx_session`, `Secure`, `Path=/`, host-only on the
 * exact target host; the bypass header and the fence are both working in that same context; and a cookie value
 * planted in the store is in neither results.json nor the summary after a session pack has run (sessions-run.test.ts).
 *
 * What a local run cannot show: the target here is `https://localhost:<port>` with a self-signed certificate that the
 * Playwright config trusts (`ignoreHTTPSErrors`), so Chromium accepts the `Secure` cookie the way it does for the real
 * staging host, but trust and cookie handling on the real host are the first live run's job (L6). Against the real
 * host Vercel also sets its own bypass cookie, so the jar there holds that one too; the stand-in here does not.
 */
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLocalTlsServer, type LocalTlsServer } from "../../../packages/github/test/helpers/localTlsServer.js";
import { HOST_ENV_NAMES, playwrightCli } from "../src/run.js";
import { browserSessionCookie } from "../src/sessions.js";
import { putRole, readStore, storePath } from "../src/store.js";
import { BYPASS_VALUE, signSession } from "./session-helpers.js";
import { PACKAGE_ROOT, tmpDir } from "./helpers.js";

const keyBytes = randomBytes(32);
const H = 3_600_000;
const D = 86_400_000;

let staging: LocalTlsServer;
let production: LocalTlsServer;
let seenStaging: { path: string; cookie: string | undefined; bypass: string | undefined }[] = [];
let productionHits = 0;
let rotated = "";

beforeAll(async () => {
  staging = await startLocalTlsServer({ dnsNames: ["localhost"] }, (req) => {
    seenStaging.push({ path: req.path, cookie: req.headers["cookie"], bypass: req.headers["x-vercel-protection-bypass"] });
    return { status: 200, headers: { "content-type": "text/html", "set-cookie": `__Host-fx_session=${rotated}; Path=/; HttpOnly; Secure; SameSite=Lax` }, body: "<html>ok</html>" };
  });
  production = await startLocalTlsServer({ ipAddresses: ["127.0.0.1"] }, () => {
    productionHits += 1;
    return { status: 200, body: "production stand-in" };
  });
}, 60_000);
afterAll(async () => {
  await staging?.close();
  await production?.close();
});

function runSpec(home: string, body: string): Promise<{ code: number; output: string }> {
  const dir = tmpDir("t3_cookie_jar_pw_");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "playwright.config.mjs"), 'export default { testDir: ".", testMatch: "*.spec.mjs", workers: 1, reporter: "line", use: { ignoreHTTPSErrors: true } };\n');
  writeFileSync(
    join(dir, "jar.spec.mjs"),
    `import { test, expect } from ${JSON.stringify(join(PACKAGE_ROOT, "fixtures", "session.ts"))};\ntest.use({ sessionRole: "owner" });\ntest("jar", async ({ page, context, browser, target, session }) => {\nvoid session;\n${body}\n});\n`,
  );
  const env: Record<string, string> = {
    LIVE_E2E_TARGET: "staging",
    LIVE_E2E_STAGING_ORIGIN: `https://localhost:${staging.port}`,
    LIVE_E2E_STAGING_PROJECT_ID: "prj_Staging1",
    LIVE_E2E_PRODUCTION_ORIGIN: `https://127.0.0.1:${production.port}`,
    LIVE_E2E_PRODUCTION_PROJECT_ID: "prj_Production1",
    VERCEL_AUTOMATION_BYPASS_SECRET: BYPASS_VALUE,
    LIVE_E2E_SESSION_KEY: keyBytes.toString("base64"),
  };
  for (const name of HOST_ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  env["HOME"] = home;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [playwrightCli(), "test", "--config", join(dir, "playwright.config.mjs")], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d: Buffer) => (output += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (output += d.toString("utf8")));
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

describe("session fixture + fence + bypass in one real Playwright context (13a)", () => {
  it("the jar holds exactly one cookie: __Host-fx_session, secure, path /, host-only on the target host; the bypass header and the fence work in the same context", async () => {
    const home = tmpDir("t3_cookie_jar_home_");
    const file = storePath(home, "staging");
    const now = Date.now();
    const first = signSession({ sid: "first", sessionStart: now - 2 * D, lastSeenAt: now - 3 * H });
    rotated = signSession({ sid: "first", sessionStart: now - 2 * D, lastSeenAt: now });
    await putRole(file, "staging", keyBytes, "owner", first);
    seenStaging = [];
    productionHits = 0;
    const prodUrl = `https://127.0.0.1:${production.port}/probe`;
    const res = await runSpec(
      home,
      [
        // Control: a context with no fence at all reaches the production stand-in, so "blocked" below means the fence.
        `const plain = await browser.newContext({ ignoreHTTPSErrors: true });`,
        `await (await plain.newPage()).goto(${JSON.stringify(prodUrl)});`,
        `await plain.close();`,
        // The same shape check before any navigation (the fixture's own cookie) and after the app answered (its refresh).
        `const check = async () => {`,
        `  const cookies = await context.cookies();`,
        `  expect(cookies).toHaveLength(1);`,
        `  const c = cookies[0];`,
        `  expect(c.name).toBe("__Host-fx_session");`,
        `  expect(c.secure).toBe(true);`,
        `  expect(c.path).toBe("/");`,
        `  expect(c.httpOnly).toBe(true);`,
        // Host-only: Chromium reports the host itself (a Domain= cookie would start with a dot), and it is the exact target host.
        `  expect(c.domain).toBe(new URL(target.origin).hostname);`,
        `};`,
        `await check();`,
        `const failures = [];`,
        `page.on("requestfailed", (r) => failures.push(r.url() + " " + (r.failure()?.errorText ?? "")));`,
        `await page.goto(target.origin + "/");`,
        `await check();`,
        `const outcome = await page.evaluate((u) => fetch(u, { mode: "no-cors" }).then(() => "sent", () => "blocked"), ${JSON.stringify(prodUrl)});`,
        `expect(outcome).toBe("blocked");`,
        // Refused by the fence itself (not by a certificate or network error): Chromium reports ERR_BLOCKED_BY_CLIENT, as for a fence abort.
        `expect(failures).toEqual([${JSON.stringify(prodUrl)} + " net::ERR_BLOCKED_BY_CLIENT.Inspector"]);`,
      ].join("\n"),
    );
    expect(res.output, res.output).toContain("1 passed");
    expect(res.code).toBe(0);
    // The bypass route and the stored cookie both applied to the same request.
    const landing = seenStaging.find((s) => s.path === "/");
    expect(landing?.bypass).toBe(BYPASS_VALUE);
    expect(landing?.cookie).toBe(`__Host-fx_session=${first}`);
    // Only the control reached the production stand-in; the fenced context did not.
    expect(productionHits).toBe(1);
    // And the app's refresh, seen through that context, is what the fixture wrote back.
    expect(readStore(file, "staging", keyBytes)["owner"]).toBe(rotated);
  }, 180_000);

  it("a cookie the fixture would put in the wrong place is caught: a second cookie in the jar fails the one-cookie assertion (control)", async () => {
    const home = tmpDir("t3_cookie_jar_home_");
    const file = storePath(home, "staging");
    const now = Date.now();
    const first = signSession({ sid: "first", sessionStart: now - 2 * D, lastSeenAt: now - 3 * H });
    rotated = first;
    await putRole(file, "staging", keyBytes, "owner", first);
    const res = await runSpec(
      home,
      [`await page.goto(target.origin + "/");`, `await context.addCookies([{ name: "other", value: "x", url: target.origin }]);`, `expect(await context.cookies()).toHaveLength(1);`].join("\n"),
    );
    expect(res.code).not.toBe(0);
    expect(res.output).toContain("toHaveLength");
  }, 180_000);
});

describe("Chromium and the Secure __Host- cookie on a plain-http target", () => {
  it("refuses it ('Invalid cookie fields'), which is why the jar test above runs against a local HTTPS server", async () => {
    const server = createServer((_req, res) => res.writeHead(200).end("ok"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      const origin = `http://localhost:${(server.address() as AddressInfo).port}`;
      await expect(context.addCookies([browserSessionCookie(origin, "abc")])).rejects.toThrow("Invalid cookie fields");
      expect(await context.cookies()).toEqual([]);
    } finally {
      await browser.close();
      server.close();
    }
  }, 60_000);
});
