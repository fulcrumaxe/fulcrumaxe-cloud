import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// The same gate apps/web runs after its build (scripts/check.sh); only the allowlist below is this app's own.
import { findBaked } from "../../web/scripts/check-baked-paths.mjs";
import { createFakeRedis } from "./support/fakeRedis";

const APP_DIR = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = resolve(APP_DIR, "../..");
const ID = "fedcba9876543210fedcba9876543210";
const STORE_TOKEN = "built-store-token";
// What pnpm and node need from the host, by name (the proxy variables are how the sandbox reaches the registry); no FX_* or VERCEL_* setting reaches the build.
const HOST_ENV_NAMES = ["PATH", "HOME", "TMPDIR", "USER", "LANG", "PNPM_HOME", "NODE_PATH", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "CI", "pnpm_config_store_dir", "pnpm_config_verify_store_integrity", "XDG_CACHE_HOME", "XDG_DATA_HOME"];
const hostEnv = (extra: Record<string, string>): NodeJS.ProcessEnv =>
  Object.assign(Object.fromEntries(HOST_ENV_NAMES.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]]))), extra) as NodeJS.ProcessEnv;
const READ_TOKEN = "built-read-token";

// The path webpack bakes into each route's loader and client-reference manifest is its source file, kept as an id and never opened
// (the same two shapes the apps/web allowlist lists for its own routes). Anything else holding the build machine's path fails.
const HARMLESS = [
  /^app\/api\/(health|hook\/\[id\]|read\/\[id\])\/route\.js: <root>\/apps\/live-sink\/app\/api\/(health|hook\/\[id\]|read\/\[id\])\/route\.ts$/,
  /^app\/api\/(health|hook\/\[id\]|read\/\[id\])\/route_client-reference-manifest\.js: <root>\/apps\/live-sink\/(app\/api\/(health|hook\/\[id\]|read\/\[id\])\/route)?$/,
];

async function freePort(): Promise<number> {
  return new Promise((ok) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => ok(port));
    });
  });
}

describe("built output", () => {
  let moved = "";
  let child: ChildProcess | undefined;
  let redisServer: Server | undefined;
  let base = "";

  beforeAll(async () => {
    const built = spawnSync("pnpm", ["exec", "next", "build"], { cwd: APP_DIR, env: hostEnv({ NODE_ENV: "production" }), encoding: "utf8", timeout: 280_000 });
    if (built.status !== 0) throw new Error(`next build failed:\n${built.stdout}\n${built.stderr}`);
  }, 300_000);

  afterAll(async () => {
    child?.kill();
    redisServer?.close();
    if (moved) rmSync(moved, { recursive: true, force: true });
  });

  it("passes the next-server trace check that apps/web runs", () => {
    const run = spawnSync("node", [join(REPO_ROOT, "apps/web/scripts/check-next-trace.mjs")], { env: hostEnv({ NEXT_APP_DIR: APP_DIR }), encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("check-next-trace: ok");
  });

  it("holds no build-machine path in .next/server beyond the route ids", () => {
    const roots = [...new Set([REPO_ROOT, realpathSync(REPO_ROOT)])];
    const found = findBaked(join(APP_DIR, ".next", "server"), roots) as string[];
    expect(found.filter((entry) => !HARMLESS.some((pattern) => pattern.test(entry)))).toEqual([]);
  });

  it("lists the three routes and nothing else, and sets only the Git deployment rule in vercel.json", () => {
    const manifest = JSON.parse(readFileSync(join(APP_DIR, ".next/server/app-paths-manifest.json"), "utf8")) as Record<string, string>;
    expect(Object.keys(manifest).sort()).toEqual(["/api/health/route", "/api/hook/[id]/route", "/api/read/[id]/route"]);
    expect(JSON.parse(readFileSync(join(APP_DIR, "vercel.json"), "utf8"))).toEqual({
      $schema: "https://openapi.vercel.sh/vercel.json",
      git: { deploymentEnabled: { "**": false, main: true } },
    });
  });

  it("runs from the standalone folder moved to another directory, with the original gone, against a store over HTTP", async () => {
    moved = mkdtempSync(join(tmpdir(), "live-sink-moved-"));
    cpSync(join(APP_DIR, ".next/standalone"), moved, { recursive: true, verbatimSymlinks: true });
    rmSync(join(APP_DIR, ".next/standalone"), { recursive: true, force: true });

    const redis = createFakeRedis(STORE_TOKEN);
    redisServer = createServer((req, res) => {
      let text = "";
      req.on("data", (c) => (text += c));
      req.on("end", () => {
        const { status, json } = redis.handle(req.url ?? "", req.method ?? "", req.headers.authorization ?? null, text);
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
      });
    });
    const redisPort = await freePort();
    await new Promise<void>((ok) => redisServer!.listen(redisPort, "127.0.0.1", ok));

    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = spawn("node", ["apps/live-sink/server.js"], {
      cwd: moved,
      env: {
        PATH: hostEnv({}).PATH ?? "",
        NODE_ENV: "production",
        PORT: String(port),
        HOSTNAME: "127.0.0.1",
        KV_REST_API_URL: `http://127.0.0.1:${redisPort}`,
        KV_REST_API_TOKEN: STORE_TOKEN,
        LIVE_SINK_READ_TOKEN: READ_TOKEN,
      },
      stdio: "ignore",
    });
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      up = await fetch(`${base}/api/health`).then((r) => r.ok, () => false);
      if (!up) await new Promise((r) => setTimeout(r, 100));
    }
    expect(up).toBe(true);

    const health = await fetch(`${base}/api/health`);
    expect([health.status, await health.text()]).toEqual([200, '{"ok":true}']);
    expect((await fetch(`${base}/api/hook/nope`, { method: "POST", body: "x" })).status).toBe(404);
    expect((await fetch(`${base}/api/hook/${ID}`, { method: "POST", body: "x".repeat(65537) })).status).toBe(413);
    expect((await fetch(`${base}/api/hook/${ID}`, { method: "POST", body: '{"hello":"moved"}', headers: { "x-signature": "abc" } })).status).toBe(200);
    expect((await fetch(`${base}/api/read/${ID}`)).status).toBe(401);
    const authorized = { headers: { authorization: `Bearer ${READ_TOKEN}` } };
    const read = (await (await fetch(`${base}/api/read/${ID}`, authorized)).json()) as { deliveries: { body: string; headers: Record<string, string> }[] };
    expect([read.deliveries[0]?.body, read.deliveries[0]?.headers["x-signature"]]).toEqual(['{"hello":"moved"}', "abc"]);
    expect((await fetch(`${base}/api/read/${ID}`, authorized)).status).toBe(404);
  }, 60_000);
});
