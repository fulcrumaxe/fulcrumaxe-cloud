import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const API_DIR = path.join(__dirname, "..", "app", "api");
const ALLOWLIST_FILE = path.join(API_DIR, "ROUTES.allowlist");

/** Every `route.ts` under `apps/web/app/api/**`, as a path relative to `API_DIR` with forward slashes (matches ROUTES.allowlist's own format). */
function findRouteFiles(dir: string, base: string = dir): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      found.push(...findRouteFiles(full, base));
    } else if (entry === "route.ts") {
      found.push(path.relative(base, full).split(path.sep).join("/"));
    }
  }
  return found;
}

/**
 * D#37 WS-C criterion 6: "`apps/web/app/api/ROUTES.allowlist` equals the
 * set of route files under `apps/web/app/api/**` (inventory test)."
 */
describe("apps/web/app/api/ROUTES.allowlist inventory", () => {
  it("matches the actual set of route.ts files under app/api, exactly", () => {
    const actual = findRouteFiles(API_DIR).sort();
    const allowlisted = readFileSync(ALLOWLIST_FILE, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .sort();
    expect(actual).toEqual(allowlisted);
  });
});

/**
 * D#37 WS-C criterion 6: "Each of /api/login, /api/signup,
 * /api/local-auto-login, /api/cloud/auth/magic/request,
 * /api/admin/users, /api/users, /api/keys, /api/system/status,
 * /api/files, /api/baseapp/x, /api/messages/unread, /api/updates/status,
 * /terminal returns 404 for GET and POST (test)."
 *
 * Next.js's App Router 404s any request that resolves to no route file
 * -- this is a routing invariant, not something a per-request check
 * needs to add. What this test actually verifies is the thing that
 * COULD silently break that guarantee: that none of these paths has a
 * route file (or, for `/terminal`, a page file) that would intercept
 * it. `apps/web/test/shell-routes.test.ts`'s real-`next start` curl
 * transcript (see the PR description) confirms the live HTTP behaviour
 * on a representative sample of this same list.
 */
describe("must-never-exist routes (D#37 WS-C criterion 6)", () => {
  const forbiddenApiPaths = [
    "login",
    "signup",
    "local-auto-login",
    "cloud/auth/magic/request",
    "admin/users",
    "users",
    "keys",
    "system/status",
    "files",
    "baseapp/x",
    "messages/unread",
    "updates/status",
  ];

  for (const p of forbiddenApiPaths) {
    it(`/api/${p} has no route.ts anywhere on its own path or an ancestor directory`, () => {
      const segments = p.split("/");
      for (let depth = 1; depth <= segments.length; depth++) {
        const dir = path.join(API_DIR, ...segments.slice(0, depth));
        expect(existsSync(path.join(dir, "route.ts"))).toBe(false);
      }
    });
  }

  it("/terminal has no page.tsx/page.ts anywhere under apps/web/app", () => {
    const appDir = path.join(__dirname, "..", "app");
    expect(existsSync(path.join(appDir, "terminal", "page.tsx"))).toBe(false);
    expect(existsSync(path.join(appDir, "terminal", "page.ts"))).toBe(false);
  });
});
