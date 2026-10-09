/**
 * Playwright fixtures for the live packs.
 *
 *  - `bypass` (automatic): routes every browser request and adds the Vercel bypass header to those whose origin
 *    is exactly the target's (`bypassHeadersFor`, the same rule the API client uses). Redirects are never
 *    followed on the header's behalf; see `bypassRouteHandler`.
 *  - `api`: the shared client, bypass on. `anon`: the same client with no secret, for the wall check.
 *  - `target`: the resolved target.
 *
 * Nothing here reads more of the environment than the target variables and the bypass secret.
 *
 * The write fence (fixtures/fence.ts) is installed on the same context after the bypass handler, so it sees every
 * request first. Coverage note: both apply to the `context` (and so `page`) fixture and to the shared client
 * only; test/pack-lint.test.ts fails any pack that builds its own context or request path.
 */
import { join } from "node:path";
import { test as base } from "@playwright/test";
import { BYPASS_HEADER, bypassHeadersFor, createClient, SET_COOKIE_HEADER, type ApiClient, type ProbeSend } from "../src/client.js";
import { packageRoot, TARGET_ENV_NAME } from "../src/limits.js";
import { BYPASS_ENV } from "../src/needs.js";
import { fenceConfigFor, loadTarget, type Target } from "../src/targets.js";
import { installBrowserFence, installFetchGuard } from "./fence.js";

/** The slice of Playwright's Route (and of the response its `fetch` returns) that the handler touches. */
export interface RouteLike<R = unknown> {
  request(): { url(): string; headers(): Record<string, string> };
  continue(options?: { headers?: Record<string, string> }): Promise<void>;
  fetch(options: { headers: Record<string, string>; maxRedirects: number }): Promise<R>;
  fulfill(options: { response: R }): Promise<void>;
}

/**
 * Requests to the target origin are fetched here with the header and `maxRedirects: 0`, then fulfilled: the
 * browser sees any 3xx itself and follows it as a NEW request, which comes back through this handler and gets
 * the same exact-origin decision. `route.continue({ headers })` must not be used for this: Chromium applies
 * those headers to every redirect hop of the request, and never shows the hop to the handler, so the secret
 * would reach whatever origin the target redirects to. Anything not on the target origin is continued untouched.
 *
 * Chromium does not route a redirect hop after a fulfilled response, so a same-origin hop carries no header.
 * It does not need one: the target's answer is asked (`x-vercel-set-bypass-cookie`) to set the bypass cookie,
 * which the browser stores for the deployment host only and sends on later same-host requests.
 */
export function bypassRouteHandler<R>(origin: string, secret: string | undefined): (route: RouteLike<R>) => Promise<void> {
  return async (route) => {
    const req = route.request();
    const extra = bypassFetchHeaders(req.url(), origin, secret);
    if (BYPASS_HEADER in extra) {
      const response = await route.fetch({ headers: { ...req.headers(), ...extra }, maxRedirects: 0 });
      await route.fulfill({ response });
    } else {
      await route.continue();
    }
  };
}

/**
 * What a route handler adds when it fetches `url` itself: the bypass header (exact-origin rule) and the ask for a
 * bypass cookie, or nothing. The staging fence fetches non-reads itself, so it uses this too.
 */
export function bypassFetchHeaders(url: string, origin: string, secret: string | undefined): Record<string, string> {
  const extra = bypassHeadersFor(url, origin, secret);
  return BYPASS_HEADER in extra ? { ...extra, [SET_COOKIE_HEADER]: "true" } : {};
}

/** The secret is sent only to a deployment that declares protection; an unprotected target never sees it. */
function secretFor(target: Target): string | undefined {
  return target.protected ? process.env[BYPASS_ENV] : undefined;
}

interface Fixtures {
  target: Target;
  fence: undefined;
  api: ApiClient;
  anon: ApiClient;
  bypass: undefined;
  /**
   * The refusal probes the pack declares, set per spec file with `test.use({ packProbes: { list } })`. Wrapped in an
   * object because Playwright reads a bare array of objects as a `[value, options]` pair.
   */
  packProbes: { list: ProbeSend[] };
}

/** The target this worker process runs against, from the environment `live-e2e run` sets. */
function currentTarget(): Target {
  const name = process.env[TARGET_ENV_NAME];
  if (name === undefined || name === "") throw new Error(`${TARGET_ENV_NAME} is not set`);
  return loadTarget(join(packageRoot(), "targets"), name, process.env);
}

interface WorkerFixtures {
  /** Backstop: `globalThis.fetch` refuses the production host (see `installFetchGuard`) for the life of the worker. */
  fetchGuard: undefined;
}

export const test = base.extend<Fixtures, WorkerFixtures>({
  // eslint-disable-next-line no-empty-pattern
  target: async ({}, use) => {
    await use(currentTarget());
  },
  fetchGuard: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const restore = installFetchGuard(fenceConfigFor(currentTarget(), join(packageRoot(), "targets"), process.env));
      try {
        await use(undefined);
      } finally {
        restore();
      }
    },
    { scope: "worker", auto: true },
  ],
  packProbes: [{ list: [] }, { option: true }],
  api: async ({ target, packProbes }, use) => {
    const fence = fenceConfigFor(target, join(packageRoot(), "targets"), process.env);
    await use(createClient({ origin: target.origin, bypassSecret: secretFor(target), fence, probes: packProbes.list }));
  },
  anon: async ({ target }, use) => {
    const fence = fenceConfigFor(target, join(packageRoot(), "targets"), process.env);
    await use(createClient({ origin: target.origin, fence }));
  },
  bypass: [
    async ({ context, target }, use) => {
      await context.route("**/*", bypassRouteHandler(target.origin, secretFor(target)));
      await use(undefined);
    },
    { auto: true },
  ],
  fence: [
    // Depends on `bypass` so it is registered after it: the fence then runs first and falls back to the bypass handler.
    async ({ context, target, bypass }, use) => {
      void bypass;
      await installBrowserFence(context, fenceConfigFor(target, join(packageRoot(), "targets"), process.env), {
        extraHeaders: (url) => bypassFetchHeaders(url, target.origin, secretFor(target)),
      });
      await use(undefined);
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";
