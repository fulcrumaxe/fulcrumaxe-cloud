import { NextRequest, NextResponse } from "next/server";

/**
 * D#37 WS-C criterion 5: "The four session routes are served by ONE
 * route module (`api/shell/session/route.ts`) reached through rewrites
 * that pass the original path as a query parameter, so the boot chain
 * pays at most one cold start." The logical resources -- `me` (aliased
 * at both `/api/cloud/auth/me` and `/api/profile`, which criterion 3
 * requires to answer identically), `entitlements`, and `preferences` --
 * map from the ORIGINAL request path.
 *
 * D#37 WS-L1 (correction C19c criterion 4): "The licence route is gone.
 * `/api/license/status` is removed from RESOURCE_BY_PATH ... A GET now
 * gets the existing unknown-path 404." There is no `/api/license/*`
 * route in cloud at all -- the licence-activation module does not
 * belong here (owner ruling). `license` stays out of the
 * ShellSessionResource union rather than becoming an unreachable member.
 *
 * This file is deliberately separate from `session-routes.ts`: it is
 * imported by `apps/web/middleware.ts`, which Next.js bundles for the
 * Edge runtime, and `session-routes.ts` transitively pulls in
 * `node:crypto` (via `storage-ns.ts`) and `pg` -- neither bundles for
 * Edge. Keeping the plain path-to-resource mapping here, with zero
 * Node-only imports, is what lets middleware do the rewrite without
 * dragging in code that only ever runs in the route handler (Node
 * runtime) that receives the rewritten request.
 */
export type ShellSessionResource = "me" | "entitlements" | "preferences" | "plans";

const RESOURCE_BY_PATH: Record<string, ShellSessionResource> = {
  "/api/cloud/auth/me": "me",
  "/api/profile": "me",
  "/api/entitlements/me": "entitlements",
  "/api/preferences": "preferences",
  // D#37 WS-F6 (G1): the read-only plan list, served from the plan source.
  "/api/plans": "plans",
};

export function resourceForShellPath(shellPath: string | null): ShellSessionResource | null {
  if (!shellPath) return null;
  return RESOURCE_BY_PATH[shellPath] ?? null;
}

/**
 * The header `shellSessionRewriteStep` carries the original path in, and
 * `shellSessionHandler` (session-routes.ts) reads it from.
 *
 * KNOWN DIVERGENCE FROM THE SPEC'S EXACT WORDING (flagged, not silently
 * dropped -- see the PR description): criterion 5 says "a query
 * parameter." Confirmed empirically against a real `next start` during
 * this PR's Gate 2 verification: neither a `next.config.mjs`-level
 * `rewrites()` rule NOR a middleware-level `NextResponse.rewrite()` with
 * a query string in the destination made that query string reach
 * `req.nextUrl.searchParams` inside the destination App Router route
 * handler -- the handler consistently saw an empty search string, even
 * though Next correctly dispatched to the right file (`x-middleware
 * -rewrite` in the response confirmed the rewrite decision itself was
 * right). A request HEADER, by contrast, propagates reliably through a
 * middleware rewrite -- this codebase's own `sessionStep` already
 * depends on exactly that (`x-fx-user-id`/`x-fx-account-id`), unaffected
 * by this gap. This satisfies the criterion's actual goal (one route
 * module, dispatch by the original path, one cold start) through a
 * mechanism that is provably reliable in this Next.js version, rather
 * than one that is provably not.
 */
export const SHELL_PATH_HEADER = "x-fx-shell-path";

/**
 * The `apps/web/middleware.ts` STEPS entry that implements criterion 5's
 * "reached through rewrites." See `SHELL_PATH_HEADER`'s comment for why
 * the original path travels as a header, not a query parameter.
 */
export function shellSessionRewriteStep(req: NextRequest, headers: Headers): NextResponse | void {
  const pathname = req.nextUrl.pathname;
  if (!resourceForShellPath(pathname)) return;
  headers.set(SHELL_PATH_HEADER, pathname);
  const url = req.nextUrl.clone();
  url.pathname = "/api/shell/session";
  url.search = "";
  return NextResponse.rewrite(url, { request: { headers } });
}
