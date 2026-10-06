import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import net from "node:net";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * R1: the proxy project deploys only the gh-proxy route (plus an empty-404
 * fallback). This test runs the real `next build` of apps/gh-proxy with no
 * environment set (the route reads its settings lazily, so the build needs
 * none), lists what came out, then starts it with `next start` and sends raw
 * request lines.
 */

const APP_DIR = fileURLToPath(new URL("..", import.meta.url));
const NEXT_DIR = join(APP_DIR, ".next");
const ROUTE = "/api/gh-proxy/[...path]/route";
// The empty-404 fallback for a path the gate approves but the router does not match to ROUTE.
const FALLBACK = "/[[...rest]]/route";

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(NEXT_DIR, rel), "utf8")) as Record<string, unknown>;
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(relative(APP_DIR, full));
  }
  return out.sort();
}

describe("source tree: nothing but the proxy route", () => {
  it("has the proxy route and the empty-404 fallback under app/, no pages/, no public/", () => {
    expect(listFiles(join(APP_DIR, "app"))).toEqual(["app/[[...rest]]/route.ts", "app/api/gh-proxy/[...path]/route.ts"]);
    expect(existsSync(join(APP_DIR, "pages"))).toBe(false);
    expect(existsSync(join(APP_DIR, "public"))).toBe(false);
    expect(existsSync(join(APP_DIR, "src"))).toBe(false);
  });

  it("turns Git deployments off for every branch but main, and sets nothing else", () => {
    expect(JSON.parse(readFileSync(join(APP_DIR, "vercel.json"), "utf8"))).toEqual({
      $schema: "https://openapi.vercel.sh/vercel.json",
      git: { deploymentEnabled: { "**": false, main: true } },
    });
  });
});

describe("next build output", () => {
  beforeAll(() => {
    // Only what pnpm and node need: no FX_* or VERCEL_* setting reaches the build.
    const buildEnv = { NODE_ENV: "production" } as NodeJS.ProcessEnv;
    for (const key of ["PATH", "HOME", "TMPDIR", "USER", "LANG", "PNPM_HOME", "NODE_PATH", "XDG_CACHE_HOME", "XDG_DATA_HOME"]) {
      const value = process.env[key];
      if (value !== undefined) buildEnv[key] = value;
    }
    const built = spawnSync("pnpm", ["exec", "next", "build"], { cwd: APP_DIR, env: buildEnv, encoding: "utf8", timeout: 280_000 });
    if (built.status !== 0) throw new Error(`next build failed:\n${built.stdout}\n${built.stderr}`);
  }, 300_000);

  it("lists exactly two app routes, the gh-proxy route and the empty-404 fallback", () => {
    expect(Object.keys(readJson("server/app-paths-manifest.json")).sort()).toEqual([FALLBACK, ROUTE]);
  });

  it("lists no page but Next's own error pages", () => {
    expect(Object.keys(readJson("server/pages-manifest.json")).sort()).toEqual(["/404", "/_app", "/_document", "/_error"]);
  });

  it("has no static route, two dynamic routes (the proxy prefix and the fallback), and no data route", () => {
    const routes = readJson("routes-manifest.json") as {
      staticRoutes: unknown[];
      dataRoutes: unknown[];
      dynamicRoutes: { page: string }[];
    };
    expect(routes.staticRoutes).toEqual([]);
    expect(routes.dataRoutes).toEqual([]);
    expect(routes.dynamicRoutes.map((r) => r.page).sort()).toEqual(["/[[...rest]]", "/api/gh-proxy/[...path]"]);
  });

  it("has no redirects, rewrites or header rules", () => {
    const routes = readJson("routes-manifest.json") as {
      redirects: unknown[];
      headers: unknown[];
      rewrites: { beforeFiles: unknown[]; afterFiles: unknown[]; fallback: unknown[] };
    };
    expect(routes.redirects).toEqual([]);
    expect(routes.headers).toEqual([]);
    expect(routes.rewrites).toEqual({ beforeFiles: [], afterFiles: [], fallback: [] });
  });

  it("never answers a trailing slash with a redirect, and has no image optimizer", () => {
    const config = readJson("required-server-files.json").config as {
      skipTrailingSlashRedirect: boolean;
      trailingSlash: boolean;
      images: { unoptimized: boolean };
    };
    expect(config.skipTrailingSlashRedirect).toBe(true);
    expect(config.trailingSlash).toBe(false);
    expect(config.images.unoptimized).toBe(true);
  });

  it("builds the one gate middleware over every path, and no other function", () => {
    const middleware = readJson("server/middleware-manifest.json") as {
      middleware: Record<string, { matchers: { originalSource: string }[] }>;
      functions: Record<string, unknown>;
    };
    expect(Object.keys(middleware.middleware)).toEqual(["/"]);
    expect(middleware.middleware["/"]?.matchers.map((m) => m.originalSource)).toEqual(["/:path*"]);
    expect(middleware.functions).toEqual({});
  });

  it("emits no server route file other than the two routes", () => {
    const appFiles = listFiles(join(NEXT_DIR, "server", "app")).map((f) => f.replace(/^\.next\/server\//, ""));
    const routeFiles = appFiles.filter((f) => /\.(js|html|rsc|body|meta)$/.test(f) && !f.endsWith(".nft.json"));
    expect(routeFiles.every((f) => f.startsWith("app/api/gh-proxy/[...path]/") || f.startsWith("app/[[...rest]]/"))).toBe(true);
  });
});

/**
 * The same build, started with `next start` and hit with raw request lines, so
 * the answers are what a caller really gets (Next's own request handling and
 * the middleware included), not what the pure gate function says.
 */
describe("next start: raw request lines", () => {
  const HOST = "gh-proxy.fixture.test";
  let server: ChildProcess | undefined;
  let port = 0;

  async function freePort(): Promise<number> {
    for (let i = 0; i < 50; i++) {
      const candidate = 5100 + Math.floor(Math.random() * 900);
      const free = await new Promise<boolean>((resolve) => {
        const probe = net.createServer();
        probe.once("error", () => resolve(false));
        probe.listen(candidate, "127.0.0.1", () => probe.close(() => resolve(true)));
      });
      if (free) return candidate;
    }
    throw new Error("no free port in 5100-5999");
  }

  interface Answer {
    status: number;
    location: string | null;
    body: string;
  }

  function send(requestLine: string, host: string | null = HOST): Promise<Answer> {
    return new Promise((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      let raw = "";
      const done = () => {
        const [head = "", ...rest] = raw.split("\r\n\r\n");
        const lines = head.split("\r\n");
        const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(lines[0] ?? "")?.[1] ?? 0);
        const location = lines.find((l) => /^location:/i.test(l))?.replace(/^location:\s*/i, "") ?? null;
        resolve({ status, location, body: rest.join("\r\n\r\n") });
      };
      socket.on("data", (d) => (raw += d.toString("latin1")));
      socket.on("close", done);
      socket.on("error", done);
      socket.setTimeout(15_000, () => socket.destroy());
      socket.write(`${requestLine}\r\n${host === null ? "" : `Host: ${host}\r\n`}Connection: close\r\n\r\n`);
    });
  }

  beforeAll(async () => {
    port = await freePort();
    const env = {
      FX_GH_PROXY_PUBLIC_HOST: HOST,
      FX_GH_FORWARD_HOST: HOST,
      FX_GH_FORWARD_SUFFIX: "fixture.test",
      DATABASE_URL_GH_PROXY: "postgres://nobody@127.0.0.1:1/none",
      VERCEL_OIDC_ISSUER: "https://oidc.vercel.com/team_1",
      VERCEL_OIDC_JWKS_URL: "https://oidc.vercel.com/team_1/.well-known/jwks",
      VERCEL_TEAM_ID: "team_1",
      FX_GH_PROXY_SANDBOX_PROJECT_ID: "prj_1",
    } as Record<string, string>;
    for (const key of ["PATH", "HOME", "TMPDIR", "USER", "LANG", "PNPM_HOME", "NODE_PATH"]) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    server = spawn("pnpm", ["exec", "next", "start", "-p", String(port), "-H", "127.0.0.1"], {
      cwd: APP_DIR,
      env: env as NodeJS.ProcessEnv,
      detached: true,
      stdio: "ignore",
    });
    for (let i = 0; i < 100; i++) {
      const up = await new Promise<boolean>((resolve) => {
        const probe = net.connect(port, "127.0.0.1", () => {
          probe.destroy();
          resolve(true);
        });
        probe.once("error", () => resolve(false));
      });
      if (up) return;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error("next start did not come up");
  }, 60_000);

  afterAll(() => {
    if (server?.pid) {
      try {
        process.kill(-server.pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  });

  // The proxy's own answers are JSON (the cold-start DNS check fails offline, or the OIDC
  // header is missing): a JSON error that is not 404 means the request got past the gate.
  const reachedHandler = (r: Answer) => r.status !== 404 && r.body.includes('"error"');
  // Chunked bodies end with "0\r\n\r\n", so an empty body arrives as "0" or "".
  const emptyNotFound = (r: Answer) => r.status === 404 && r.body.replace(/^0\r\n\r\n|^0$/, "").trim() === "" && !r.body.includes("<");

  it("lets a plain proxy path through to the handler", async () => {
    expect(reachedHandler(await send("GET /api/gh-proxy/repos/o/r HTTP/1.1"))).toBe(true);
  });

  it("resolves %2e%2e before the gate, so the handler sees the cleaned path (not a bypass: see identityPins.test.ts)", async () => {
    expect(reachedHandler(await send("GET /api/gh-proxy/repos/%2e%2e/x HTTP/1.1"))).toBe(true);
  });

  it.each(["/api/gh-proxy/a%2fb", "/api/gh-proxy/a%2Fb", "/api/gh-proxy/a%5cb", "/api/gh-proxy/a%00b"])("refuses %s with an empty 404", async (path) => {
    expect(emptyNotFound(await send(`GET ${path} HTTP/1.1`))).toBe(true);
  });

  it("answers an empty 404, not Next's HTML page, for a path that only resolves into the prefix", async () => {
    expect(emptyNotFound(await send("GET /x/../api/gh-proxy/a HTTP/1.1"))).toBe(true);
  });

  it.each(["/", "/api/health", "/_next/static/x.js"])("answers an empty 404 for %s", async (path) => {
    expect(emptyNotFound(await send(`GET ${path} HTTP/1.1`))).toBe(true);
  });

  it("answers an empty 404 for a wrong host and for a missing host", async () => {
    expect(emptyNotFound(await send("GET /api/gh-proxy/repos/o/r HTTP/1.1", "attacker.example"))).toBe(true);
    expect(emptyNotFound(await send("GET /api/gh-proxy/repos/o/r HTTP/1.0", null))).toBe(true);
  });

  it("answers an empty 404 for a method outside the six", async () => {
    expect(emptyNotFound(await send("OPTIONS /api/gh-proxy/repos/o/r HTTP/1.1"))).toBe(true);
  });

  // Known gap: Next redirects these before middleware runs and no config turns it off.
  // Pinned so a change shows up: the Location must stay a same-host relative path.
  it.each([
    ["//api/gh-proxy/x", "/api/gh-proxy/x"],
    ["/api/gh-proxy//repos/o/r", "/api/gh-proxy/repos/o/r"],
    ["/\\evil.test/x", "/evil.test/x"],
    ["/api/gh-proxy/a\\b", "/api/gh-proxy/a/b"],
  ])("%s gets Next's 308 with a relative Location (known gap)", async (path, location) => {
    const res = await send(`GET ${path} HTTP/1.1`);
    expect(res.status).toBe(308);
    expect(res.location).toBe(location);
    expect(res.location).toMatch(/^\/(?!\/)/); // same host: never scheme-relative or absolute
  });

  it("TRACE never reaches the handler (Next's wrapper fails it before the middleware runs)", async () => {
    const res = await send("TRACE /api/gh-proxy/repos/o/r HTTP/1.1");
    expect([404, 500]).toContain(res.status);
    expect(res.body).not.toContain("proxy_unavailable");
    expect(res.body).not.toContain("missing_oidc_token");
  });
});
