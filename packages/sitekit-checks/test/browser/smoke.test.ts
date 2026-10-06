import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serveStatic, type StaticServer } from "../../src/lib/browser/serve.js";
import { evaluateJson, openPage, withBrowser } from "../../src/lib/browser/run.js";
import { createPlaywrightDriver } from "./playwright-driver.js";

const FIXTURES = path.resolve(import.meta.dirname, "fixtures/smoke");
let server: StaticServer;

beforeAll(async () => {
  server = await serveStatic(FIXTURES);
});
afterAll(() => server.close());

/** Does any process still carry this throwaway HOME in its environment? */
async function processesWithHome(home: string): Promise<number> {
  let n = 0;
  for (const pid of (await fs.readdir("/proc")).filter((d) => /^\d+$/.test(d))) {
    const env = await fs.readFile(`/proc/${pid}/environ`, "utf8").catch(() => "");
    if (env.split("\0").includes(`HOME=${home}`)) n++;
  }
  return n;
}

describe("real Chromium through the driver seam", () => {
  it("aborts every non-origin request and still reads the page", async () => {
    const driver = createPlaywrightDriver(server.origin);
    try {
      const page = await driver.open();
      await page.goto(`${server.origin}/index.html`);
      expect(await evaluateJson(page, "() => document.title")).toBe("Smoke page");
      expect(await evaluateJson(page, "(a) => a.x", { x: 7 })).toBe(7);
      expect(page.blockedRequests()).toBeGreaterThanOrEqual(2);
    } finally {
      await driver.close();
    }
  });

  it("a SharedWorker cannot reach a foreign loopback server", async () => {
    const hits: string[] = [];
    const foreign = createServer((req, res) => {
      hits.push(req.url ?? "");
      res.writeHead(200).end("x");
    });
    await new Promise<void>((r) => foreign.listen(0, "127.0.0.1", r));
    const { port } = foreign.address() as { port: number };
    const driver = createPlaywrightDriver(server.origin);
    try {
      const page = await driver.open();
      await page.goto(`${server.origin}/shared.html?p=${port}`);
      await new Promise((r) => setTimeout(r, 1500));
    } finally {
      await driver.close();
      foreign.closeAllConnections();
      await new Promise<void>((r) => foreign.close(() => r()));
    }
    expect(hits).toEqual([]);
  });

  it("does not hang on alert()", async () => {
    const driver = createPlaywrightDriver(server.origin);
    try {
      const page = await driver.open();
      await page.goto(`${server.origin}/alert.html`);
      expect(await evaluateJson(page, "() => document.title")).toBe("Alert page");
    } finally {
      await driver.close();
    }
  });

  it("ends an infinite loop as check_timeout inside the budget + 5 s", async () => {
    const driver = createPlaywrightDriver(server.origin);
    const started = Date.now();
    const result = await withBrowser({ driver, budgetMs: 2000 }, async (d) => {
      const page = await openPage(d);
      await page.goto(`${server.origin}/loop.html`);
      return { ok: true, findings: [] };
    });
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.kind)).toEqual(["check_timeout"]);
    expect(Date.now() - started).toBeLessThan(2000 + 5000);
  });

  it("leaves no browser process behind after close()", async () => {
    const driver = createPlaywrightDriver(server.origin);
    await driver.open();
    const home = driver.homeDir() as string;
    expect(await processesWithHome(home)).toBeGreaterThan(0);
    await driver.close();
    expect(await processesWithHome(home)).toBe(0);
    await expect(fs.stat(home)).rejects.toThrow();
  });
});
