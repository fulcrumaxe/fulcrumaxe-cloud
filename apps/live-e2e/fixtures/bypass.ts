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
 * Coverage note: the rule is applied to the `context` (and so `page`) fixture only. A pack that calls
 * `browser.newContext()` or uses the built-in `request` fixture bypasses it; the lint test that forbids
 * that, and the production write fence, arrive with T1c.
 */
import { join } from "node:path";
import { test as base } from "@playwright/test";
import { BYPASS_HEADER, bypassHeadersFor, createClient, SET_COOKIE_HEADER, type ApiClient } from "../src/client.js";
import { packageRoot, TARGET_ENV_NAME } from "../src/limits.js";
import { BYPASS_ENV } from "../src/needs.js";
import { loadTarget, type Target } from "../src/targets.js";

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
    const extra = bypassHeadersFor(req.url(), origin, secret);
    if (BYPASS_HEADER in extra) {
      const response = await route.fetch({ headers: { ...req.headers(), ...extra, [SET_COOKIE_HEADER]: "true" }, maxRedirects: 0 });
      await route.fulfill({ response });
    } else {
      await route.continue();
    }
  };
}

/** The secret is sent only to a deployment that declares protection; an unprotected target never sees it. */
function secretFor(target: Target): string | undefined {
  return target.protected ? process.env[BYPASS_ENV] : undefined;
}

interface Fixtures {
  target: Target;
  api: ApiClient;
  anon: ApiClient;
  bypass: undefined;
}

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  target: async ({}, use) => {
    const name = process.env[TARGET_ENV_NAME];
    if (name === undefined || name === "") throw new Error(`${TARGET_ENV_NAME} is not set`);
    await use(loadTarget(join(packageRoot(), "targets"), name, process.env));
  },
  api: async ({ target }, use) => {
    await use(createClient({ origin: target.origin, bypassSecret: secretFor(target) }));
  },
  anon: async ({ target }, use) => {
    await use(createClient({ origin: target.origin }));
  },
  bypass: [
    async ({ context, target }, use) => {
      await context.route("**/*", bypassRouteHandler(target.origin, secretFor(target)));
      await use(undefined);
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";
