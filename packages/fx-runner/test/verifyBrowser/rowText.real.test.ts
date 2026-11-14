import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findChromium, launchDriver } from "../../src/verifyBrowser/driver.js";
import { parseBase, type BasePin } from "../../src/verifyBrowser/pin.js";
import { chromiumSandboxRefused } from "../helpers/chromiumSandbox.js";
import { tmpRoot } from "../helpers/tmpRoot.js";
import { useSourcePlaywright } from "./sourceLoader.js";

/** wait_text answers with the row a match sits in, and the snapshot reaches a collapsed section's summary line. */
const EXE = findChromium(process.env);
const NO_SANDBOX = chromiumSandboxRefused(EXE);
useSourcePlaywright();

const PAGE = `<!doctype html><dl><dt>Runs in</dt><dd>Local-only</dd></dl>
<table><tr><td>Orders</td><td>Total: 7</td></tr></table>
<details><summary>More settings</summary><p>Hidden body</p></details><p>Plain line</p>`;

let app: Server;
let base: BasePin;
let work = "";
beforeAll(async () => {
  work = mkdtempSync(path.join(tmpRoot(), "pw-row-"));
  app = createServer((_q, res) => void res.writeHead(200, { "content-type": "text/html" }).end(PAGE));
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  base = parseBase(`http://127.0.0.1:${(app.address() as AddressInfo).port}`)!;
});
afterAll(() => {
  app?.close();
  if (work !== "") rmSync(work, { recursive: true, force: true });
});

describe.skipIf(EXE === undefined || NO_SANDBOX)("a real browser", () => {
  it("waitText returns the label with its value for a dt/dd pair, the row for a table cell, and false for text that never shows", async () => {
    const driver = await launchDriver({ base, executablePath: EXE!, jobDir: work, hostEnv: { PATH: process.env.PATH }, onConsole: () => undefined });
    try {
      await driver.go(`${base.origin}/`);
      expect(await driver.waitText("Runs in", 10_000)).toBe("Runs in Local-only");
      expect(String(await driver.waitText("Total: 7", 10_000))).toContain("Orders");
      expect(await driver.waitText("never on this page", 600)).toBe(false);
    } finally {
      await driver.close();
    }
  }, 60_000);

  it("the snapshot lists a summary element, so a collapsed section can be clicked", async () => {
    const driver = await launchDriver({ base, executablePath: EXE!, jobDir: work, hostEnv: { PATH: process.env.PATH }, onConsole: () => undefined });
    try {
      await driver.go(`${base.origin}/`);
      const { elements } = await driver.scan();
      expect(elements.some((e) => JSON.stringify(e).includes("More settings"))).toBe(true);
    } finally {
      await driver.close();
    }
  }, 60_000);
});
