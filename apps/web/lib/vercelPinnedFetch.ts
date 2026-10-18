import { resolveChecked } from "@fx/net-guard";
import { nodeHttpsPinnedRequester, type PinnedRequester } from "../app/api/gh-proxy/[...path]/handler";

/**
 * D#598 P8d-1: the `fetch` the Vercel env-name adapter goes out through (CWE-918). It does what `createPinnedAppFetch`
 * (lib/github/installationHttp.ts) does for GitHub: the host is resolved and checked by the net guard (`resolveChecked`: no private,
 * loopback or link-local address), and the socket is connected to that one validated address by the pinned connector, with SNI and Host
 * kept as `api.vercel.com`, over verified TLS. It is not the global `fetch`.
 *
 * It sends exactly one kind of request, `GET https://api.vercel.com/v10/projects/<name>/env[?query]`. Any other scheme, host, port, credentials,
 * fragment, path or method is refused before anything is resolved or sent, and so is a query that asks for `decrypt=true`. A redirect is never
 * followed (the token would travel with it). The caller's abort signal ends both the wait for headers and the body read.
 */
const HOST = "api.vercel.com";
const PATH_RE = /^\/v10\/projects\/[a-z0-9._-]{1,100}\/env$/;

function abortable(stream: ReadableStream<Uint8Array>, signal: AbortSignal | undefined): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let onAbort: (() => void) | undefined;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (signal === undefined) return;
      onAbort = () => {
        controller.error(signal.reason);
        void reader.cancel(signal.reason).catch(() => undefined);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel(reason) {
      if (signal !== undefined && onAbort !== undefined) signal.removeEventListener("abort", onAbort);
      await reader.cancel(reason);
    },
  });
}

export function createPinnedVercelFetch(deps: { resolveUpstream?: (host: string) => Promise<string[]>; forwardPinned?: PinnedRequester } = {}): typeof fetch {
  const resolveUpstream = deps.resolveUpstream ?? ((host: string) => resolveChecked(host));
  const forwardPinned = deps.forwardPinned ?? nodeHttpsPinnedRequester;
  return (async (input: unknown, init?: RequestInit) => {
    const refuse = (why: string): never => {
      throw new Error(`pinned vercel fetch: ${why}`);
    };
    if ((init?.method ?? "GET") !== "GET") refuse("only GET");
    if (init?.body !== undefined && init.body !== null) refuse("no request body");
    let url: URL;
    try {
      url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : "");
    } catch {
      // fx-swallow-ok: an address that does not parse is refused with the fixed message below
      return refuse("not a URL");
    }
    if (url.protocol !== "https:" || url.hostname !== HOST || url.port !== "" || url.username !== "" || url.password !== "" || url.hash !== "") refuse("only https://api.vercel.com");
    if (!PATH_RE.test(url.pathname)) refuse("only /v10/projects/<name>/env");
    if (url.searchParams.getAll("decrypt").some((v) => v !== "false")) refuse("decrypt is never requested");
    const signal = init?.signal ?? undefined;
    signal?.throwIfAborted();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const addresses = await resolveUpstream(HOST);
    const address = addresses[0];
    if (address === undefined) return refuse("no address");
    const aborted = new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
    const res = await Promise.race([forwardPinned({ host: HOST, address, method: "GET", path: `${url.pathname}${url.search}`, headers, body: null }), aborted]);
    if (res.status >= 300 && res.status < 400) {
      await res.bodyStream?.cancel().catch(() => undefined);
      return refuse("redirect refused");
    }
    return new Response(res.bodyStream === null ? null : abortable(res.bodyStream, signal), { status: res.status });
  }) as typeof fetch;
}
