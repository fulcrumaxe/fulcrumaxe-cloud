// apps/workspace/e2e/fake-github-authorize.mjs
//
// D#37 WS-C2 fix round 2 (criterion 15, owner ruling 2026-09-24, C15e):
// the ONLY stand-in this milestone is allowed to use -- a tiny local
// fake for the GitHub OAuth AUTHORIZE endpoint. Nothing on the app's
// own origin is stubbed: this server only ever plays the part of
// github.com/login/oauth/authorize, and it does that by immediately
// redirecting to the app's real, existing /api/auth/test/callback route
// with the query params that route already requires (githubUserId,
// email, login -- see apps/web/app/api/auth/test/callback/handler.ts).
// Everything downstream of that redirect -- session issuance, cookies,
// sign-out, the old-cookie replay -- runs against the real apps/web
// server untouched.
//
// The app is pointed at this server via FX_GITHUB_AUTHORIZE_URL
// (packages/core/src/auth/provider.ts's resolveGithubAuthorizeUrlOverride),
// which is only honoured when FX_ENABLE_TEST_AUTH=1 and neither
// NODE_ENV=production nor VERCEL_ENV is set -- the exact same gate
// TestOnlyProvider itself already requires for /api/auth/test/callback
// to work at all, so nothing here widens what a real deployment
// accepts.
//
// Plain node:http, no npm dependency, matching fixture-server.mjs's
// own convention -- Playwright's needs here are just "listen, answer a
// redirect."
//
// Usage: node e2e/fake-github-authorize.mjs --port 4610 --callback-base https://127.0.0.1:4611
// Programmatic: import { startFakeGithubAuthorize } from "./fake-github-authorize.mjs";

import { createServer } from "node:http";

const DEFAULT_PORT = 4610;

// A fixed, synthetic identity -- this is a fake authorize screen, not a
// real one, so there is no real GitHub account behind it. Distinct from
// any fixture used elsewhere so a milestone run's created row is easy
// to recognize in Postgres.
export const FAKE_IDENTITY = Object.freeze({
  githubUserId: 990137,
  email: "milestone-fake@example.test",
  login: "milestone-fake-user",
});

export function startFakeGithubAuthorize({ port = DEFAULT_PORT, callbackBase } = {}) {
  if (!callbackBase) {
    throw new Error("startFakeGithubAuthorize: callbackBase is required");
  }

  const server = createServer((req, res) => {
    // What github.com/login/oauth/authorize insists on, and what this app's own provider always sends
    // (packages/core/src/auth/provider.ts getAuthorizationUrl). A request missing them used to be waved
    // through, which hid a broken authorize URL until a real run:
    //   - GET only, and a client_id (GitHub answers 404 without one);
    //   - a redirect_uri, when given, that is an absolute http(s) URL (GitHub answers 422 otherwise);
    //   - the CSRF `state` this app's callback requires.
    // The values themselves are still never checked against any credential.
    const refuse = (status, text) => {
      res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
      res.end(text);
    };
    if (req.method !== "GET") return refuse(404, "Not Found");
    const query = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
    if (!query.get("client_id")) return refuse(404, "Not Found");
    const redirectUri = query.get("redirect_uri");
    if (redirectUri !== null && !/^https?:\/\/[^/\s]+/.test(redirectUri)) {
      return refuse(422, "The redirect_uri is not associated with this application.");
    }
    if (!query.get("state")) return refuse(400, "Missing state");
    const target = new URL("/api/auth/test/callback", callbackBase);
    target.searchParams.set("githubUserId", String(FAKE_IDENTITY.githubUserId));
    target.searchParams.set("email", FAKE_IDENTITY.email);
    target.searchParams.set("login", FAKE_IDENTITY.login);
    res.writeHead(302, { Location: target.toString() });
    res.end();
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const url = `http://127.0.0.1:${addr.port}`;
      resolve({
        server,
        url,
        port: addr.port,
        authorizeUrl: `${url}/authorize`,
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
  const port = args.port ? Number(args.port) : DEFAULT_PORT;
  const callbackBase = args["callback-base"];
  if (!callbackBase) {
    throw new Error("fake-github-authorize.mjs: --callback-base is required (the apps/web base URL)");
  }
  const { authorizeUrl } = await startFakeGithubAuthorize({ port, callbackBase });
  console.log(
    `fake-github-authorize.mjs: listening at ${authorizeUrl}, redirecting to ${callbackBase}/api/auth/test/callback`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
