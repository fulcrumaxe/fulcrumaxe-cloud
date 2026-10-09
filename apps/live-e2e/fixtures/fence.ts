/**
 * The browser half of the write fence (layer 4 of the production guard). The API client applies the same rule
 * (`fenceVerdict`, src/client.ts) to its own requests; `context.route` cannot see those, which is why packs reach
 * the app only through the `page`/`context` fixtures and the shared client (test/pack-lint.test.ts enforces it).
 *
 * The deny decisions compare a canonical HOSTNAME (lowercase, trailing dots stripped, scheme and port ignored):
 * `http://<prod host>`, `https://<prod host>.` and `<prod host>:8443` are all the production host.
 *
 *  - production: a non-read request to ANY origin is aborted. A production browser run has no reason to write
 *    anywhere, and Chromium follows a 307/308 itself without showing the hop to a route handler, so a write to
 *    another origin could be carried to production. The one exception is the shell's own writes (sign-out and the
 *    two telemetry sinks, `SHELL_WRITE_ALLOWLIST`), and only on the exact production origin.
 *  - staging: every request, of any method, to the production host is aborted. A non-read is never handed to the
 *    browser to send: the fence fetches it itself with `maxRedirects: 0` and aborts when the answer is ANY 3xx,
 *    whatever its Location, so a redirect is never fulfilled for a write. (Playwright never routes a redirect hop
 *    of a request the browser follows, nor the hop after a fulfilled 3xx, and the browser keeps the method and
 *    body on a 307/308 and, for PUT/PATCH/DELETE, on a 301/302 as well; a chain of hops cannot be checked from
 *    here, so no write redirect is allowed at all.) Our own tests must not rely on a write that redirects.
 *  - WebSockets: `context.routeWebSocket` refuses a connection to the production host on both targets (on
 *    production that is the target itself). The mocked socket is closed without ever connecting to the server.
 *
 * The match is on the host, never a prefix or suffix test.
 *
 * Node side: `installFetchGuard` wraps `globalThis.fetch` in the pack's test process, so a direct `fetch` that the
 * pack lint missed still cannot write to the production host on a production run, or reach it at all on a staging
 * run. A non-read is sent with `redirect: "manual"` and a 3xx answer throws, so a write redirect is never followed
 * here either. The shared client keeps the platform fetch it captured at load, so its declared probes are not
 * affected by the host check (it applies the same no-redirect rule itself).
 *
 * Residual, accepted: on staging a GET that a redirect leads to the production host is a hop the browser follows
 * without the handler seeing it. It is a read only. A write cannot get there: every non-read on staging is fetched
 * by the fence and a 3xx answer aborts it.
 */
import type { Browser, BrowserContext, Route } from "@playwright/test";
import { canonicalHost, ClientError, fenceVerdict, isReadMethod, isSameHost, type FenceConfig } from "../src/client.js";

/** What Playwright reports for a request the test itself refused. */
export const BLOCKED_CODE = "blockedbyclient";

/** The slice of the response `route.fetch` returns that the staging check reads. */
export interface FenceResponse {
  status(): number;
  headers(): Record<string, string>;
}

/** The slice of Playwright's Route the handler uses. */
export interface FenceRoute<R extends FenceResponse = FenceResponse> extends Pick<Route, "abort" | "fallback"> {
  request(): { url(): string; method(): string; headers(): Record<string, string> };
  fetch(options: { headers: Record<string, string>; maxRedirects: number }): Promise<R>;
  fulfill(options: { response: R }): Promise<void>;
}

export interface FenceOptions {
  /** Extra headers when the fence fetches a request itself (staging non-reads): the bypass header, for the target. */
  extraHeaders?: (url: string) => Record<string, string>;
}

/** Whether the answer is a redirect. A non-read that is answered with one is aborted, never fulfilled. */
function isRedirect(response: FenceResponse): boolean {
  return response.status() >= 300 && response.status() < 400;
}

/**
 * Aborts a fenced request, otherwise hands it on (`fallback`) to the handlers registered before this one, so the
 * bypass handler still sees every request the fence lets through.
 */
export function fenceRouteHandler<R extends FenceResponse = FenceResponse>(config: FenceConfig, options: FenceOptions = {}): (route: FenceRoute<R>) => Promise<void> {
  return async (route) => {
    const req = route.request();
    const url = req.url();
    const method = req.method();
    if (fenceVerdict({ method, url, shell: true }, config) !== null) {
      await route.abort(BLOCKED_CODE);
      return;
    }
    if (config.target === "staging" && !isReadMethod(method)) {
      let response: R;
      try {
        response = await route.fetch({ headers: { ...req.headers(), ...(options.extraHeaders?.(url) ?? {}) }, maxRedirects: 0 });
      } catch {
        await route.abort(BLOCKED_CODE);
        return;
      }
      if (isRedirect(response)) {
        await route.abort(BLOCKED_CODE);
        return;
      }
      await route.fulfill({ response });
      return;
    }
    await route.fallback();
  };
}

/** The host a WebSocket must not reach: the production host (on a production run, the target itself). */
function fencedWebSocketHost(config: FenceConfig): string | undefined {
  return config.target === "production" ? config.targetOrigin : config.productionOrigin;
}

/** Registers the fence on a context. Call it AFTER the handlers it must precede: Playwright runs the last registered first. */
export async function installBrowserFence(context: Pick<BrowserContext, "route" | "routeWebSocket">, config: FenceConfig, options: FenceOptions = {}): Promise<void> {
  await context.route("**/*", fenceRouteHandler<Awaited<ReturnType<Route["fetch"]>>>(config, options));
  const fenced = fencedWebSocketHost(config);
  if (fenced !== undefined && canonicalHost(fenced) !== undefined) {
    await context.routeWebSocket(
      (url) => isSameHost(url.href, fenced),
      (ws) => {
        void ws.close();
      },
    );
  }
}

/** A context as a live pack gets it: service workers blocked and the fence installed. */
export async function newFencedContext(browser: Browser, config: FenceConfig, options: FenceOptions = {}): Promise<BrowserContext> {
  const context = await browser.newContext({ serviceWorkers: "block" });
  await installBrowserFence(context, config, options);
  return context;
}

/** The method and URL of a `fetch(input, init)` call. */
function fetchTarget(input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]): { method: string; url: string } {
  const isRequest = typeof input === "object" && "url" in input;
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : isRequest ? input.url : String(input);
  const method = init?.method ?? (isRequest ? input.method : "GET");
  return { method, url };
}

/**
 * `base` with the write fence in front: a request the fence refuses throws a ClientError before `base` runs. A
 * non-read is sent with `redirect: "manual"` whatever the caller asked for, and a 3xx answer throws: a redirect on a
 * write is never followed, on any host.
 */
export function guardFetch(config: FenceConfig, base: typeof fetch): typeof fetch {
  return (async (input, init) => {
    const { method, url } = fetchTarget(input, init);
    const refusal = fenceVerdict({ method, url }, config);
    if (refusal !== null) throw new ClientError(`fetch: ${method.toUpperCase()} to the production host is refused (${refusal})`);
    if (isReadMethod(method)) return base(input, init);
    const response = await base(input, { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new ClientError(`fetch: ${method.toUpperCase()} was answered with a ${response.status} redirect; a redirect on a write is never followed`);
    }
    return response;
  }) as typeof fetch;
}

/** Replaces `globalThis.fetch` with the guarded one. Returns the function that puts the previous one back. */
export function installFetchGuard(config: FenceConfig): () => void {
  const previous = globalThis.fetch;
  globalThis.fetch = guardFetch(config, previous);
  return () => {
    globalThis.fetch = previous;
  };
}
