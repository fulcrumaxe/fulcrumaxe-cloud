import { createServer, type Server } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEPLOY_VERIFIER_ROLE } from "@fulcrumaxe/runner-protocol";
import { serverOptionsFrom } from "../../src/commands/verifyBrowserServer.js";
import { createVerifyLocal } from "../../src/daemon/verifyLocal.js";
import { mcpConfigFor } from "../../src/engines/claude/settingsFile.js";
import { setSetting } from "../../src/runnerSettings.js";
import { bypassAllowedFor, headersWithBypass } from "../../src/verifyBrowser/bypass.js";
import { findChromium } from "../../src/verifyBrowser/driver.js";
import { parseBase } from "../../src/verifyBrowser/pin.js";
import { startVerifyBrowserServer } from "../../src/verifyBrowser/server.js";
import { chromiumSandboxRefused } from "../helpers/chromiumSandbox.js";
import { tmpRoot } from "../helpers/tmpRoot.js";
import { BASE, rig } from "./harness.js";
import { useSourcePlaywright } from "./sourceLoader.js";

/**
 * D#749: the Vercel protection bypass for the verify browser. Every value here is a made-up one. The header goes only to the base origin, only when that origin is the registered
 * cloud origin, and the secret is in no output the job reports.
 */
const FAKE = "fake-bypass-value-0123456789";
const base = parseBase(BASE)!;
const root = mkdtempSync(path.join(tmpRoot(), "pw-bypass-"));
const UID = process.getuid?.() ?? 0;

describe("headersWithBypass", () => {
  it("adds the pair to the base origin only, and keeps the request's own headers", () => {
    const own = { accept: "text/html" };
    expect(headersWithBypass(own, `${BASE}/items?x=1`, base, FAKE)).toEqual({ accept: "text/html", "x-vercel-protection-bypass": FAKE, "x-vercel-set-bypass-cookie": "true" });
    for (const other of ["https://other.example.test/", "https://app.example.test:8443/", "http://app.example.test/", "https://app.example.test.evil.test/", "https://evil.test/https://app.example.test/", "not a url"]) {
      expect(headersWithBypass(own, other, base, FAKE), other).toEqual(own);
    }
  });

  it("no secret: the headers are the request's own", () => {
    expect(headersWithBypass({ accept: "x" }, `${BASE}/`, base, undefined)).toEqual({ accept: "x" });
  });

  it("is allowed only for a base that is exactly the registered cloud origin", () => {
    expect(bypassAllowedFor(base, "https://app.example.test")).toBe(true);
    for (const o of [undefined, "https://app.example.test:8443", "http://app.example.test", "https://other.example.test"]) expect(bypassAllowedFor(base, o), String(o)).toBe(false);
  });
});

describe("the server hands the secret to the driver only for the cloud origin", () => {
  it("cloud origin equals the base: the driver config carries it", async () => {
    const r = rig({ "/": { elements: [], text: "hi" } }, { bypassSecret: FAKE, cloudOrigin: BASE });
    await r.call("open", { path: "/" });
    expect(r.driver()!.cfg!.bypassSecret).toBe(FAKE);
    await r.server.stop();
  });

  it("another cloud origin, none, or no secret: the driver config does not", async () => {
    for (const extra of [{ bypassSecret: FAKE, cloudOrigin: "https://cloud.example.test" }, { bypassSecret: FAKE }, { cloudOrigin: BASE }, {}]) {
      const r = rig({ "/": { elements: [], text: "hi" } }, extra);
      await r.call("open", { path: "/" });
      expect(r.driver()!.cfg!.bypassSecret, JSON.stringify(extra)).toBeUndefined();
      expect("bypassSecret" in r.driver()!.cfg!).toBe(false);
      await r.server.stop();
    }
  });

  it("a page text that holds the secret is scrubbed from the snapshot", async () => {
    const r = rig({ "/": { elements: [{ name: `Token ${FAKE}` }], text: `echo ${FAKE} end` } }, { bypassSecret: FAKE, cloudOrigin: BASE });
    await r.call("open", { path: "/" });
    const snap = await r.call("snapshot");
    expect(snap.text).not.toContain(FAKE);
    expect(snap.text).toContain("[redacted]");
    await r.server.stop();
  });

  it("nothing the job reports carries the secret", async () => {
    const r = rig({ "/": { elements: [{ name: "Go" }], text: "page" } }, { bypassSecret: FAKE, cloudOrigin: BASE });
    const seen: string[] = [];
    for (const [name, args] of [["open", { path: "/" }], ["snapshot", {}], ["console", {}], ["submit_answer", { envelope: {} }]] as const) seen.push((await r.call(name, args)).text);
    expect(seen.join("\n")).not.toContain(FAKE);
    await r.server.stop();
  });
});

describe("the runner side: the spec and the MCP file carry a path and an origin, never the secret", () => {
  const server = { command: "/opt/fx/fx-runner", args: [], baseUrl: "https://app.example.test/", executable: "/opt/chromium", storageState: "/h/s.json" };

  it("mcp args gain the two flags only with both set", () => {
    const args = (spec: object) => (mcpConfigFor({ role: DEPLOY_VERIFIER_ROLE, browserMethod: "playwright_runner" }, "/j", { ...server, ...spec }).mcpServers["fxverify"] as { args: string[] }).args;
    expect(args({})).not.toContain("--bypass-file");
    expect(args({ bypassFile: "/h/.fx-runner/bypass", cloudOrigin: "https://app.example.test" }).slice(-4)).toEqual(["--bypass-file", "/h/.fx-runner/bypass", "--cloud-origin", "https://app.example.test"]);
    expect(args({ bypassFile: "/h/.fx-runner/bypass" })).not.toContain("--bypass-file");
  });

  it("verifyServer() names the file only when the base origin is the registered cloud origin", () => {
    const home = mkdtempSync(path.join(root, "vl-"));
    const stateDir = path.join(home, ".fx-runner");
    mkdirSync(stateDir, { mode: 0o700 });
    setSetting(stateDir, "verify.browser.base_url", "https://app.example.test");
    setSetting(stateDir, "verify.browser.executable", "/opt/chromium");
    const make = (bypass: { file: string; cloudOrigin: string } | undefined) => createVerifyLocal({ stateDir, uid: UID, username: "t", env: {}, platform: "linux", home, selfCommand: ["/opt/fx/fx-runner"], bypass });
    const file = path.join(stateDir, "bypass");
    expect(make({ file, cloudOrigin: "https://app.example.test" }).verifyServer()).toMatchObject({ bypassFile: file, cloudOrigin: "https://app.example.test" });
    for (const other of [undefined, { file, cloudOrigin: "https://cloud.example.test" }]) {
      const spec = make(other).verifyServer()!;
      expect(spec.baseUrl).toBe("https://app.example.test/");
      expect("bypassFile" in spec || "cloudOrigin" in spec).toBe(false);
    }
  });
});

describe("serverOptionsFrom reads the secret from the file, by the runner's own checks", () => {
  const home = mkdtempSync(path.join(root, "so-"));
  mkdirSync(path.join(home, ".fx-runner"), { mode: 0o700 });
  const file = path.join(home, ".fx-runner", "bypass");
  writeFileSync(file, `${FAKE}\n`, { mode: 0o600 });
  const host = { input: new PassThrough(), output: new PassThrough(), env: { PATH: "/usr/bin" }, uid: UID, home, platform: "linux" as const };
  const flags = () => new Map<string, string | true>([["job-dir", "/state/jobs/r"], ["base-url", "https://app.example.test"], ["executable", "/opt/chromium"], ["storage-state", "/h/s.json"]]);

  it("no flags: no secret, no cloud origin (behaviour unchanged)", () => {
    const opts = serverOptionsFrom(flags(), host);
    expect("bypassSecret" in opts || "cloudOrigin" in opts).toBe(false);
  });

  it("both flags and a good file: the secret and the origin are set", () => {
    const f = flags();
    f.set("bypass-file", file);
    f.set("cloud-origin", "https://app.example.test");
    expect(serverOptionsFrom(f, host)).toMatchObject({ bypassSecret: FAKE, cloudOrigin: "https://app.example.test" });
  });

  it("a half pair, a relative path, a loose mode or a file outside home is refused with a message that has no secret", () => {
    const messages: string[] = [];
    const attempt = (mutate: (f: Map<string, string | true>) => void, h = host) => {
      const f = flags();
      mutate(f);
      try {
        serverOptionsFrom(f, h);
        messages.push("NO THROW");
      } catch (e) {
        messages.push((e as Error).message);
      }
    };
    attempt((f) => f.set("bypass-file", file));
    attempt((f) => f.set("cloud-origin", "https://app.example.test"));
    attempt((f) => (f.set("bypass-file", "rel"), f.set("cloud-origin", "https://app.example.test")));
    const loose = path.join(home, ".fx-runner", "loose");
    writeFileSync(loose, FAKE, { mode: 0o600 });
    chmodSync(loose, 0o644);
    attempt((f) => (f.set("bypass-file", loose), f.set("cloud-origin", "https://app.example.test")));
    attempt((f) => (f.set("bypass-file", file), f.set("cloud-origin", "https://app.example.test")), { ...host, home: undefined } as unknown as typeof host);
    expect(messages).not.toContain("NO THROW");
    expect(messages.join("\n")).not.toContain(FAKE);
  });
});

// A real Chromium against two local servers. The base is the "cloud" one; the other is a different origin that a redirect and the page's own subresources point at.
const EXE = findChromium(process.env);
const NO_SANDBOX = chromiumSandboxRefused(EXE);
useSourcePlaywright();

describe.skipIf(EXE === undefined || NO_SANDBOX || process.platform !== "linux")("a real browser", () => {
  let app: Server;
  let foreign: Server;
  let appBase = "";
  const appSeen: Array<Record<string, string | string[] | undefined>> = [];
  const foreignSeen: Array<Record<string, string | string[] | undefined>> = [];
  const listen = (s: Server): Promise<number> => new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)));

  beforeAll(async () => {
    foreign = createServer((req, res) => {
      foreignSeen.push(req.headers);
      res.writeHead(200, { "access-control-allow-origin": "*" }).end("foreign");
    });
    const foreignPort = await listen(foreign);
    app = createServer((req, res) => {
      appSeen.push({ ...req.headers, url: req.url });
      if (req.url === "/redir") return void res.writeHead(302, { location: `http://127.0.0.1:${foreignPort}/landed` }).end();
      if (req.url === "/echo") return void res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><h1>Echo</h1><p>seen: ${String(req.headers["x-vercel-protection-bypass"])}</p>`);
      if (req.url === "/data") return void res.writeHead(200).end("data ok");
      res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><h1>Home page</h1><p id=d></p><script>
        fetch('/data').then((r) => r.text()).then((t) => { document.getElementById('d').textContent = t; });
        fetch('http://127.0.0.1:${foreignPort}/fetch').catch(() => {});
        new Image().src = 'http://127.0.0.1:${foreignPort}/img';
      </script>`);
    });
    appBase = `http://127.0.0.1:${await listen(app)}`;
  });
  afterAll(() => {
    app?.close();
    foreign?.close();
  });

  async function session(extra: { bypassSecret?: string; cloudOrigin?: string }): Promise<{ outputs: string[]; call: (name: string, args?: unknown) => Promise<string>; stop: () => Promise<void> }> {
    const jobDir = mkdtempSync(path.join(tmpRoot(), "vb-bypass-"));
    const input = new PassThrough();
    const output = new PassThrough();
    const server = startVerifyBrowserServer({ baseUrl: appBase, jobDir, input, output, hostEnv: process.env, executablePath: EXE, ...extra });
    const waiting = new Map<number, (text: string) => void>();
    const outputs: string[] = [];
    let buffer = "";
    let id = 0;
    output.setEncoding("utf8");
    output.on("data", (c: string) => {
      buffer += c;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const l of lines) {
        outputs.push(l);
        const m = JSON.parse(l) as { id: number; result: { content: Array<{ text: string }> } };
        waiting.get(m.id)?.(m.result.content[0]!.text);
      }
    });
    const call = (name: string, args?: unknown): Promise<string> =>
      new Promise((resolve) => {
        id += 1;
        waiting.set(id, resolve);
        input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
      });
    await call("begin_journey", { id: "c1" });
    return { outputs, call, stop: () => server.stop() };
  }

  it("own origin carries the header and the cookie request; the foreign origin and a redirect to it see nothing; the output has no secret", async () => {
    appSeen.length = 0;
    foreignSeen.length = 0;
    const s = await session({ bypassSecret: FAKE, cloudOrigin: appBase });
    expect(await s.call("open", { path: "/" })).toContain("opened");
    expect(await s.call("wait_text", { text: "data ok" })).toBe("text_visible");
    await s.call("snapshot");
    expect(await s.call("open", { path: "/redir" })).toContain("error: left_origin");
    await s.call("console");
    await new Promise((resolve) => setTimeout(resolve, 800));
    const mine = appSeen.filter((h) => h.url === "/" || h.url === "/data");
    expect(mine.length).toBeGreaterThanOrEqual(2);
    for (const h of mine) {
      expect(h["x-vercel-protection-bypass"]).toBe(FAKE);
      expect(h["x-vercel-set-bypass-cookie"]).toBe("true");
    }
    expect(foreignSeen).toEqual([]);
    expect(s.outputs.join("\n")).not.toContain(FAKE);
    await s.stop();
  }, 60_000);

  it("a page that echoes the request header into its body: the snapshot and every reply have the placeholder, not the secret", async () => {
    const s = await session({ bypassSecret: FAKE, cloudOrigin: appBase });
    expect(await s.call("open", { path: "/echo" })).toContain("opened");
    const snap = await s.call("snapshot");
    expect(snap).toContain("seen: ");
    expect(snap).toContain("[redacted]");
    expect(snap).not.toContain(FAKE);
    await s.stop();
    expect(s.outputs.join("\n")).not.toContain(FAKE);
  }, 60_000);

  it("the cloud origin is another host: the base gets no header at all", async () => {
    appSeen.length = 0;
    const s = await session({ bypassSecret: FAKE, cloudOrigin: "https://cloud.example.test" });
    expect(await s.call("open", { path: "/" })).toContain("opened");
    await s.call("wait_text", { text: "data ok" });
    await s.stop();
    expect(appSeen.length).toBeGreaterThan(0);
    for (const h of appSeen) {
      expect(h["x-vercel-protection-bypass"]).toBeUndefined();
      expect(h["x-vercel-set-bypass-cookie"]).toBeUndefined();
    }
  }, 60_000);

  it("no token: no header, and the page loads as before", async () => {
    appSeen.length = 0;
    const s = await session({ cloudOrigin: appBase });
    expect(await s.call("open", { path: "/" })).toContain("opened");
    expect(await s.call("wait_text", { text: "data ok" })).toBe("text_visible");
    await s.stop();
    for (const h of appSeen) {
      expect(h["x-vercel-protection-bypass"]).toBeUndefined();
      expect(h["x-vercel-set-bypass-cookie"]).toBeUndefined();
    }
  }, 60_000);
});
