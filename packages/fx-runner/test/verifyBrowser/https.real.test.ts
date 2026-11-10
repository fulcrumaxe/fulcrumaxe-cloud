import { createServer as createHttpsServer, type Server } from "node:https";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findChromium } from "../../src/verifyBrowser/driver.js";
import { startVerifyBrowserServer } from "../../src/verifyBrowser/server.js";
import { generateSelfSignedCert } from "../helpers/selfSignedCert.js";
import { chromiumSandboxRefused } from "../helpers/chromiumSandbox.js";
import { tmpRoot } from "../helpers/tmpRoot.js";
import { useSourcePlaywright } from "./sourceLoader.js";

/**
 * D#749 V2c-2a: an https base origin through the origin proxy (a CONNECT tunnel to the base host and port), against a real Chromium. The certificate is self-signed, so the
 * test-only option that accepts it is set; the second https server, on another port of the same host, must see no connection. Skipped when no Chromium is found.
 */
const EXE = findChromium(process.env);
const NO_SANDBOX = chromiumSandboxRefused(EXE);
const { certPem, keyPem } = generateSelfSignedCert("127.0.0.1", 1, { ipAddresses: ["127.0.0.1"] });
let app: Server;
let spy: Server;
let base = "";
const spyHits: string[] = [];

const listen = (s: Server): Promise<number> => new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)));

beforeAll(async () => {
  spy = createHttpsServer({ cert: certPem, key: keyPem }, (req, res) => {
    spyHits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "access-control-allow-origin": "*" }).end("spy");
  });
  const spyPort = await listen(spy);
  app = createHttpsServer({ cert: certPem, key: keyPem }, (req, res) => {
    if (req.url === "/data") return void res.writeHead(200).end("Secure total: 42");
    if (req.url === "/redir") return void res.writeHead(302, { location: `https://127.0.0.1:${spyPort}/landed` }).end();
    res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><body><h1>Secure page</h1><p id=d></p><script>
      fetch('/data').then((r) => r.text()).then((t) => { document.getElementById('d').textContent = t; });
      fetch('https://127.0.0.1:${spyPort}/fetch').catch(() => {});
      new Image().src = 'https://127.0.0.1:${spyPort}/img';
      try { new WebSocket('wss://127.0.0.1:${spyPort}/ws'); } catch (e) {}
    </script></body>`);
  });
  base = `https://127.0.0.1:${await listen(app)}`;
});
afterAll(() => {
  app?.close();
  spy?.close();
});

useSourcePlaywright();

describe.skipIf(EXE === undefined || NO_SANDBOX || process.platform !== "linux")("an https base origin through the origin proxy", () => {
  it("loads over a CONNECT tunnel, reaches only the base origin, and refuses a redirect to another port", async () => {
    const jobDir = mkdtempSync(path.join(tmpRoot(), "vb-https-"));
    const input = new PassThrough();
    const output = new PassThrough();
    const server = startVerifyBrowserServer({ baseUrl: base, jobDir, input, output, hostEnv: process.env, executablePath: EXE, ignoreHttpsErrors: true });
    const waiting = new Map<number, (text: string) => void>();
    let buffer = "";
    let id = 0;
    output.setEncoding("utf8");
    output.on("data", (c: string) => {
      buffer += c;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const l of lines) {
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
    expect(await call("open", { path: "/" })).toContain("opened");
    expect(await call("wait_text", { text: "Secure total: 42" })).toBe("text_visible");
    expect(await call("snapshot")).toContain("Secure page");
    expect(await call("open", { path: "/redir" })).toContain("error: left_origin");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(spyHits).toEqual([]);
    await server.stop();
  }, 60_000);
});
