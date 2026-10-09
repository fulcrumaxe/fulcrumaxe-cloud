// The runtime backstop: in a pack's test process the fixtures wrap globalThis.fetch, so a direct fetch that the
// pack lint missed still cannot write to the production host (production run) or reach it at all (staging run).
// The shared client keeps the platform fetch it captured, so its declared probes still go out.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { guardFetch, installFetchGuard } from "../fixtures/fence.js";
import { ClientError, createClient, type FenceConfig } from "../src/client.js";
import { HOST_ENV_NAMES, playwrightCli } from "../src/run.js";
import { PACKAGE_ROOT, tmpDir } from "./helpers.js";

describe("fetch guard", () => {
  const seen: string[] = [];
  let server: Server;
  let port = 0;
  const host = (name: string): string => `http://${name}:${port}`;

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      req.resume();
      res.writeHead(200).end("ok");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => server.close());

  // The configured origin is https while the local server speaks http, so only the host can match.
  const production = (): FenceConfig => ({ target: "production", targetOrigin: `https://localhost:${port}` });
  const staging = (): FenceConfig => ({ target: "staging", targetOrigin: "https://stg.example.test", productionOrigin: `https://localhost:${port}` });

  it("production: a non-read to the production host throws and never reaches the server; reads and other hosts pass", async () => {
    seen.length = 0;
    const guarded = guardFetch(production(), fetch);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      await expect(guarded(`${host("localhost")}/w`, { method }), method).rejects.toThrow(ClientError);
    }
    // Every way of naming the host, and every way of passing the request.
    await expect(guarded(`${host("localhost.")}/w`, { method: "POST" })).rejects.toThrow("production-write-fence");
    await expect(guarded(`${host("LOCALHOST")}/w`, { method: "POST" })).rejects.toThrow("production-write-fence");
    await expect(guarded(new URL(`${host("localhost")}/w`), { method: "POST" })).rejects.toThrow("production-write-fence");
    await expect(guarded(new Request(`${host("localhost")}/w`, { method: "POST" }))).rejects.toThrow("production-write-fence");
    expect(seen).toEqual([]);
    expect((await guarded(`${host("localhost")}/r`)).status).toBe(200);
    expect((await guarded(`${host("127.0.0.1")}/other`, { method: "POST" })).status).toBe(200);
    expect(seen).toEqual(["GET /r", "POST /other"]);
  });

  it("staging: any request to the production host throws, a read included", async () => {
    seen.length = 0;
    const guarded = guardFetch(staging(), fetch);
    await expect(guarded(`${host("localhost")}/r`)).rejects.toThrow("staging-blocks-production");
    await expect(guarded(`${host("localhost.")}/r`, { method: "HEAD" })).rejects.toThrow("staging-blocks-production");
    await expect(guarded(`${host("localhost")}/w`, { method: "POST" })).rejects.toThrow("staging-blocks-production");
    expect(seen).toEqual([]);
    expect((await guarded(`${host("127.0.0.1")}/ok`)).status).toBe(200);
  });

  it("a non-read is sent with redirect manual and a 3xx answer throws, whatever the Location; a read is followed", async () => {
    const calls: { url: string; redirect: string | undefined; method: string | undefined }[] = [];
    const base = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      calls.push({ url: String(input), redirect: init?.redirect, method: init?.method });
      const status = Number(new URL(String(input)).searchParams.get("status") ?? 200);
      return new Response(null, { status, headers: status >= 300 ? { location: "https://elsewhere.example.test/x" } : {} });
    }) as typeof fetch;
    for (const config of [production(), staging()]) {
      const guarded = guardFetch(config, base);
      for (const status of [301, 302, 303, 307, 308]) {
        for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
          calls.length = 0;
          // The caller asks to follow; the guard overrides it.
          await expect(guarded(`https://other.example.test/w?status=${status}`, { method, redirect: "follow" }), `${config.target} ${method} ${status}`).rejects.toThrow("never followed");
          expect(calls).toEqual([{ url: `https://other.example.test/w?status=${status}`, redirect: "manual", method }]);
        }
      }
      expect((await guarded("https://other.example.test/w?status=200", { method: "POST" })).status).toBe(200);
      calls.length = 0;
      await guarded("https://other.example.test/r?status=302", { redirect: "follow" });
      expect(calls[0]?.redirect).toBe("follow");
    }
  });

  it("staging with no production origin refuses every request", async () => {
    const guarded = guardFetch({ target: "staging", targetOrigin: "https://stg.example.test" }, (async () => new Response("ok")) as typeof fetch);
    await expect(guarded("https://stg.example.test/x")).rejects.toThrow("staging-no-production-origin");
    await expect(guarded("https://stg.example.test/x", { method: "POST" })).rejects.toThrow("staging-no-production-origin");
  });

  it("installFetchGuard replaces globalThis.fetch and the returned function puts the previous one back", async () => {
    seen.length = 0;
    const before = globalThis.fetch;
    const restore = installFetchGuard(production());
    try {
      expect(globalThis.fetch).not.toBe(before);
      await expect(globalThis.fetch(`${host("localhost")}/w`, { method: "POST" })).rejects.toThrow(ClientError);
      expect(seen).toEqual([]);
    } finally {
      restore();
    }
    expect(globalThis.fetch).toBe(before);
  });

  it("the shared client is not stopped by the guard: its declared probe still goes out", async () => {
    seen.length = 0;
    const restore = installFetchGuard(production());
    try {
      // A client for the plain-http local server, built after the guard went in.
      const local = createClient({ origin: host("localhost"), probes: [{ method: "POST", path: "/probe" }], fence: { target: "production", targetOrigin: host("localhost") } });
      expect((await local.probe({ method: "POST", path: "/probe" })).status).toBe(200);
      expect(seen).toEqual(["POST /probe"]);
    } finally {
      restore();
    }
  });
});

// The fixture wiring, in a real Playwright process: a spec that uses the pack fixtures and calls fetch directly.
describe("fetch guard fixture in a real Playwright run", () => {
  let server: Server;
  const seen: string[] = [];
  let port = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      req.resume();
      res.writeHead(200).end("ok");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => server.close());

  function runSpec(targetName: "production" | "staging", body: string): Promise<{ code: number; output: string }> {
    const dir = tmpDir("t1c_guard_pw_");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "playwright.config.mjs"), 'export default { testDir: ".", testMatch: "*.spec.mjs", workers: 1, reporter: "line" };\n');
    writeFileSync(
      join(dir, "guard.spec.mjs"),
      `import { test } from ${JSON.stringify(join(PACKAGE_ROOT, "fixtures", "bypass.ts"))};\ntest("guard", async () => {\n${body}\n});\n`,
    );
    const env: Record<string, string> = {
      LIVE_E2E_TARGET: targetName,
      LIVE_E2E_PRODUCTION_ORIGIN: `https://localhost:${port}`,
      LIVE_E2E_PRODUCTION_PROJECT_ID: "prj_Production1",
      LIVE_E2E_STAGING_ORIGIN: "https://stg.example.test",
      LIVE_E2E_STAGING_PROJECT_ID: "prj_Staging1",
    };
    // The host basics the browser needs, by name (the same list a real run hands its children).
    for (const name of HOST_ENV_NAMES) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [playwrightCli(), "test", "--config", join(dir, "playwright.config.mjs")], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (d: Buffer) => (output += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => (output += d.toString("utf8")));
      child.on("close", (code) => resolve({ code: code ?? 1, output }));
    });
  }

  const expectRefused = (url: string, method: string): string =>
    `const e = await fetch(${JSON.stringify(url)}, { method: ${JSON.stringify(method)} }).then(() => null, (err) => err);\nif (e === null || e.name !== "ClientError") throw new Error("not refused: " + String(e));`;

  it("production run: a direct fetch POST to the production host is refused before it is sent", async () => {
    seen.length = 0;
    const res = await runSpec("production", expectRefused(`http://localhost:${port}/direct`, "POST"));
    expect(res.output).toContain("1 passed");
    expect(res.code).toBe(0);
    expect(seen).toEqual([]);
  }, 120_000);

  it("staging run: a direct fetch GET to the production host is refused before it is sent", async () => {
    seen.length = 0;
    const res = await runSpec("staging", expectRefused(`http://localhost:${port}/direct`, "GET"));
    expect(res.output).toContain("1 passed");
    expect(res.code).toBe(0);
    expect(seen).toEqual([]);
  }, 120_000);
});
