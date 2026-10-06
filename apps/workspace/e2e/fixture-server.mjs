// apps/workspace/e2e/fixture-server.mjs
//
// D#37 WS-B: a plain node:http static file server for the built dist/,
// plus fixture JSON for the handful of /api/* routes the cloud-profile
// boot sequence hits on the way to a rendered, signed-in desktop
// (core/boot.js's runBoot(), script.js's showDesktop(), and
// apps/activation/activation.js's license gate -- see the module comment
// on FIXTURE_ROUTES below for exactly which calls these cover and how
// that list was derived).
//
// No npm dependency (matches import/checks.mjs and import/import.mjs's
// own "Node built-ins only" convention) -- Playwright's own webServer
// option just needs a command that listens and answers 200 on the root
// path, which this does.
//
// Usage: node e2e/fixture-server.mjs [--dist <dir>] [--port <n>]
// Programmatic: import { startFixtureServer } from "./fixture-server.mjs";

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIST_DIR = join(SCRIPT_DIR, "..", "dist");
const DEFAULT_PORT = 0; // 0 = let the OS pick a free port
export const KEEP_ALIVE_TIMEOUT_MS = 10 * 60_000;
// D#37 WS-F7a: the /api/v1 fixtures are the repo's contract fixtures
// (packages/api/fixtures/v1/**, validated against openapi.json by D#31's
// contract test), never an invented shape (correction C3).
const V1_FIXTURES_DIR = join(SCRIPT_DIR, "..", "..", "..", "packages", "api", "fixtures", "v1");

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

// Every fixture route this server answers, and why the cloud-profile boot
// sequence needs it (traced from core/boot.js's runBoot()/fetchMode(),
// script.js's showDesktop(), core/preferences.js's fetchPreferences(),
// core/entitlements.js's _doInit(), and apps/activation/activation.js's
// applyStatus() -- the only fetch() calls that fire unconditionally on a
// fresh, signed-in cloud-profile boot with every WS-B feature flag false):
//
//   /api/branding          boot.js fetchBranding()
//   /api/mode               boot.js fetchMode() -- carries `features`, the
//                            object core/features.js reads for every WS-B
//                            fork gate (presence/liveEntitlements/crdt/
//                            messages/updates)
//   /api/system/mode         boot.js fetchMode() (window.FulcCloudMode)
//   /api/cloud/auth/me       boot.js checkCloudSession() -- signed-in fixture
//   /api/entitlements/me     core/entitlements.js _doInit()
//   /api/profile             script.js showDesktop() -> fetchProfile()
//   /api/preferences         core/preferences.js fetchPreferences()
//   /api/license/status      apps/activation/activation.js applyStatus()
//
// Deliberately NOT a real allowlist/mode-matrix -- this is a fixture for
// ONE scenario (signed-in cloud desktop, every WS-B feature off), not a
// general-purpose mock backend. Per Correction C6, this fixture route
// table is invented for this test and is never read from or compared
// against any other allowlist in the repo.
function fixtureRoutes(features) {
  const routes = new Map();

  routes.set("/api/branding", {
    system_tag: "FULC TEST",
    os_name: "FULC TEST OS",
    copyright: "2026 Test Fixture",
    welcome_message: "WELCOME",
    page_title: "FULC TEST",
  });

  routes.set("/api/mode", { mode: "cloud", profile: "cloud", container: false, features });
  routes.set("/api/system/mode", { cloud: true });
  // D#37 WS-C2 criterion 11: storage_ns is what core/storage-ns.js
  // namespaces every localStorage key under -- fixed and distinct from
  // any other test fixture's value so a test can assert on the exact
  // `fx:<ns>:` prefix it produces.
  routes.set("/api/cloud/auth/me", {
    email: "idle-e2e@example.com",
    username: "idle-e2e",
    is_admin: false,
    storage_ns: "ns-idle-e2e",
    // D#37 WS-L1: boot.js now gates the desktop on workspace_access rather
    // than a licence (core/boot.js: `if (cloudSession.workspace_access !==
    // 'open') { ...render the subscription gate...; return; }`) -- without
    // this field every fixture-backed spec's boot got stuck on the gate
    // screen instead of reaching DESKTOP (confirmed: every spec in this
    // directory that boots through this fixture, not just the theme ones,
    // started failing on `window.currentStep === "DESKTOP"` timeouts the
    // moment WS-L1 merged to main). This fixture predates the gate and
    // represents an always-subscribed account, matching every other
    // fixture route here that also assumes a fully-entitled session.
    workspace_access: "open",
  });
  // D#37 WS-C2 bugfix: matches the REAL apps/web response shape
  // (apps/web/lib/shell/session-routes.ts's entitlementsResponse(),
  // WS-C1 criterion 4) -- {entitlements, default}, not {decisions}. A
  // stale {decisions:{}} fixture here (no `default` field at all) made
  // every app, including Themes, come back Deny and open the upgrade
  // modal instead of the app -- found by claude-code-gate.spec.ts
  // actually opening Themes, which no earlier WS-B/WS-C1 test did.
  routes.set("/api/entitlements/me", { entitlements: {}, default: "allow" });
  routes.set("/api/profile", { id: "1", username: "idle-e2e", isAdmin: false });
  routes.set("/api/preferences", {});
  routes.set("/api/license/status", { state: "Licensed" });
  // D#37 WS-D criterion 5: core/boot-metrics.js POSTs one RUM beacon
  // (boot:signin-visible or boot:desktop-ready) right as the sign-in
  // screen or the desktop appears -- without a fixture route here, every
  // spec in this directory that reaches either state would 404 that
  // request the moment this task landed (this map answers any method,
  // matching how every other fixture route here works; the real handler
  // is apps/web/app/api/rum/route.ts).
  routes.set("/api/rum", { ok: true });

  return routes;
}

function contentTypeFor(path) {
  return CONTENT_TYPES[extname(path).toLowerCase()] || "application/octet-stream";
}

async function serveStatic(distDir, urlPath, res) {
  // Strip query string, reject path traversal.
  const cleanPath = urlPath.split("?")[0];
  const rel = cleanPath === "/" ? "index.html" : cleanPath.replace(/^\/+/, "");
  const normalized = normalize(rel);
  if (normalized.startsWith("..") || normalized.split(sep).includes("..")) {
    res.writeHead(400).end("bad path");
    return;
  }
  const abs = join(distDir, normalized);

  try {
    const st = await stat(abs);
    if (!st.isFile()) throw new Error("not a file");
    const body = await readFile(abs);
    res.writeHead(200, { "Content-Type": contentTypeFor(abs), "Content-Length": body.length });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
  }
}

export function startFixtureServer({ distDir = DEFAULT_DIST_DIR, port = DEFAULT_PORT, features } = {}) {
  const routes = fixtureRoutes(features || {});

  const server = createServer((req, res) => {
    const urlPath = (req.url || "/").split("?")[0];

    // D#37 WS-C2 fix round 3 (criterion 15, console-error elimination):
    // the real apps/web server now sets a plain, non-HttpOnly
    // `fx_has_session=1` cookie alongside the real session cookie at
    // sign-in (apps/web/app/api/auth/_lib/sessionCookie.ts), and
    // core/boot.js's checkCloudSession() only attempts
    // GET /api/cloud/auth/me when that hint is present -- otherwise it
    // skips straight to "no session" without ever making the request
    // (avoiding an unavoidable browser-level console error for the
    // predictable-failure case; see boot.js's own comment). This
    // fixture represents exactly one scenario -- "signed-in cloud
    // desktop" (this file's own header comment) -- so it carries that
    // same hint on every response, the same way a real signed-in
    // browser would already hold it before any page load. A test that
    // wants the SIGNED-OUT boot path still gets it by intercepting
    // /api/cloud/auth/me itself with page.route() (see
    // signin-desktop.spec.ts's bootToSignIn()/sign-out tests) -- this
    // hint only decides whether that fetch is attempted, never what it
    // returns.
    res.setHeader("Set-Cookie", "fx_has_session=1; Path=/");

    // D#37 WS-C2 criterion 12: the real apps/web handler revokes the
    // session server-side and answers with Clear-Site-Data -- this
    // fixture has no real session to revoke, so it only reproduces the
    // one thing the fork's OWN sign-out logic (core/cloud-signout.js)
    // reacts to: the header on the response.
    if (urlPath === "/api/auth/signout" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json", "Clear-Site-Data": '"cache"' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // D#37 WS-F7a: opening the Developer app lists tokens. Answer that one
    // read from the contract fixture so the no-404 sweep can open the app;
    // every token mutation is exercised by developer-tokens.spec.ts through
    // page.route() instead.
    if (urlPath === "/api/v1/tokens" && req.method === "GET") {
      readFile(join(V1_FIXTURES_DIR, "listTokens", "200-page.json")).then(
        (body) => {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(body);
        },
        () => {
          res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "fixture unreadable" }));
        }
      );
      return;
    }

    // D#37 WS-F5a: opening the Model Key app reads the connection status. Same
    // pattern as the tokens read above; error cases are mocked in
    // model-key.spec.ts through page.route().
    if (urlPath === "/api/v1/model-connection" && req.method === "GET") {
      readFile(join(V1_FIXTURES_DIR, "getModelConnection", "200-ok.json")).then(
        (body) => {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(body);
        },
        () => {
          res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "fixture unreadable" }));
        }
      );
      return;
    }

    // D#37 WS-F3: opening the Repos app lists repos (same pattern as tokens; the rest is mocked in repos.spec.ts).
    if (urlPath === "/api/v1/repos" && req.method === "GET") {
      readFile(join(V1_FIXTURES_DIR, "listRepos", "200-page.json")).then(
        (body) => {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(body);
        },
        () => {
          res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "fixture unreadable" }));
        }
      );
      return;
    }

    // D#37 WS-F1a: opening the Pipeline app lists work items (its repos read is the Repos block above).
    // GET only, body from the contract fixture; item, timeline and error cases are mocked by pipeline.spec.ts.
    if (urlPath === "/api/v1/work-items" && req.method === "GET") {
      readFile(join(V1_FIXTURES_DIR, "listWorkItems", "200-page.json")).then(
        (body) => {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(body);
        },
        () => {
          res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "fixture unreadable" }));
        }
      );
      return;
    }

    // D#37 WS-F2a: opening the Runs app lists runs (GET only, first page; runs.spec.ts mocks paging, one run and the errors).
    // Every cursor gets the same page, so the app must not follow next_cursor to the end.
    if (urlPath === "/api/v1/runs" && req.method === "GET") {
      readFile(join(V1_FIXTURES_DIR, "listRuns", "200-page.json")).then(
        (body) => res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(body),
        () => res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "fixture unreadable" }))
      );
      return;
    }

    // D#37 WS-F4a: opening the Roles app reads the chosen repo's roles (the repos list is answered above).
    if (/^\/api\/v1\/repos\/[^/]+\/roles$/.test(urlPath) && req.method === "GET") {
      readFile(join(V1_FIXTURES_DIR, "listRoles", "200-ok.json")).then(
        (body) => {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(body);
        },
        () => {
          res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "fixture unreadable" }));
        }
      );
      return;
    }

    // D#37 WS-F4c: opening the Roles app's Run limits view reads the account's limits (GET only; the PUT and 4xx are mocked in roles-limits.spec.ts).
    if (urlPath === "/api/v1/run-limits" && req.method === "GET") {
      readFile(join(V1_FIXTURES_DIR, "getRunLimits", "200-ok.json")).then(
        (body) => res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(body),
        () => res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "fixture unreadable" }))
      );
      return;
    }

    // D#37 WS-F9a: opening the Onboarding app reads the setup progress (GET only; onboarding.spec.ts mocks the rest).
    if (urlPath === "/api/v1/onboarding" && req.method === "GET") {
      readFile(join(V1_FIXTURES_DIR, "getOnboarding", "200-new.json")).then(
        (body) => res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(body),
        () => res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "fixture unreadable" }))
      );
      return;
    }

    // D#37 WS-F6: opening the Budget & Billing app reads usage, budgets and the account (GET only; the PATCHes, the
    // billing links and every error are mocked in billing.spec.ts). The plan list is a session route, not /api/v1.
    const BILLING_READS = {
      "/api/v1/usage": join(V1_FIXTURES_DIR, "getUsage", "200-ok.json"),
      "/api/v1/budgets": join(V1_FIXTURES_DIR, "getBudgets", "200-ok.json"),
      "/api/v1/account": join(V1_FIXTURES_DIR, "getAccount", "200-ok.json"),
      "/api/plans": join(SCRIPT_DIR, "plans-fixture.json"),
    };
    if (req.method === "GET" && Object.hasOwn(BILLING_READS, urlPath)) {
      readFile(BILLING_READS[urlPath]).then(
        (body) => res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(body),
        () => res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "fixture unreadable" }))
      );
      return;
    }

    // D#3 (Site review picker): opening Site review reads the sites list; this account has none (an empty page), and a
    // site's versions would be the same empty page. site-review.spec.ts mocks the populated cases.
    if (req.method === "GET" && (urlPath === "/api/v1/sites" || /^\/api\/v1\/sites\/[^/]+\/versions$/.test(urlPath))) {
      readFile(join(V1_FIXTURES_DIR, "listSiteVersions", "200-empty.json")).then(
        (body) => res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(body),
        () => res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "fixture unreadable" }))
      );
      return;
    }

    // D#37 WS-LV1: the shell's live client opens the account stream once the
    // desktop is up. This fixture has no events, so it answers with an `idle`
    // frame (the client closes and stays quiet until input) rather than a 404.
    if (urlPath === "/api/v1/events" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
      res.end("event: idle\ndata: {}\n\n");
      return;
    }

    if (routes.has(urlPath)) {
      const body = JSON.stringify(routes.get(urlPath));
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(body);
      return;
    }

    if (urlPath.startsWith("/api/")) {
      // Any /api/* route not in the fixture table is unexpected for this
      // scenario -- 404 rather than silently 200-ing something the boot
      // sequence never asked for, so a missing fixture shows up loudly.
      res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "no fixture" }));
      return;
    }

    serveStatic(distDir, urlPath, res);
  });

  // Node closes an idle kept-alive socket after 5 s by default. Specs pass requests through this server with
  // route.fetch, and a client that reuses a pooled socket at the instant the server closes it gets "socket hang up"
  // (seen once in 1,079 runs under load). Keep idle sockets open far longer than any test runs (the longest test
  // timeout is 180 s), so the server never is the side that closes one mid-test. headersTimeout must stay above it.
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = KEEP_ALIVE_TIMEOUT_MS + 5_000;

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const url = `http://127.0.0.1:${addr.port}`;
      resolve({
        server,
        url,
        port: addr.port,
        stop: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    args[key] = next;
    i++;
  }
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  const distDir = args.dist ? join(process.cwd(), args.dist) : DEFAULT_DIST_DIR;
  const port = args.port ? Number(args.port) : DEFAULT_PORT;

  // The cloud profile's own features block -- imported dynamically so this
  // CLI entry point works even when profiles/cloud.json changes shape.
  const { loadProfile } = await import("../build/profile.mjs");
  const profile = loadProfile(join(SCRIPT_DIR, "..", "profiles", "cloud.json"));

  const { url } = await startFixtureServer({ distDir, port, features: profile.features });
  console.log(`fixture-server.mjs: listening on ${url} (serving ${distDir})`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
