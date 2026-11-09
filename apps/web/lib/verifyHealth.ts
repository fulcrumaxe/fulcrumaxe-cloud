import { resolveChecked } from "@fx/net-guard";
import { reportError } from "@fx/telemetry";
import type { HealthRead } from "@fx/worker";
import { nodeHttpsPinnedRequester, type PinnedRequester } from "../app/api/gh-proxy/[...path]/handler";

/**
 * D#749 V3a: the reader of a deployed app's /api/health for the post-merge verify stage (CWE-918). The base URL comes from a repository's settings, so it is not trusted:
 * the host is resolved and checked by the net guard (`resolveChecked`: no private, loopback or link-local address), and the socket is connected to that one validated
 * address with SNI and Host kept as the app's host, over verified TLS. It is not the global `fetch`. It sends one request, `GET /api/health`, with a User-Agent (the
 * platform refuses a request without one), follows no redirect, reads at most MAX_BODY_BYTES and gives up after TIMEOUT_MS in all. A base URL with a path, query,
 * credentials, a port (the settings check, parseBaseUrl, refuses one too, so a saved address is always readable) or a scheme other than https is refused before anything is resolved. Anything that is not a plain JSON answer from the app
 * (a 3xx, a 5xx other than the health route's own 503, a body too large or not JSON, a refused address, a timeout) reads as `unreachable`; the stage never acts on page text.
 * The answer carries the commit only when it is a commit id.
 */
export const MAX_BODY_BYTES = 16_384;
export const TIMEOUT_MS = 10_000;
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const unreachable: HealthRead = { kind: "unreachable" };

async function readCapped(stream: ReadableStream<Uint8Array> | null): Promise<string | null> {
  if (stream === null) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createVerifyHealthReader(deps: { resolveUpstream?: (host: string) => Promise<string[]>; forwardPinned?: PinnedRequester; timeoutMs?: number } = {}): (baseUrl: string) => Promise<HealthRead> {
  const resolveUpstream = deps.resolveUpstream ?? ((host: string) => resolveChecked(host));
  const forwardPinned = deps.forwardPinned ?? nodeHttpsPinnedRequester;
  return async (baseUrl) => {
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      // fx-swallow-ok: an address that does not parse reads as unreachable, the fixed answer
      return unreachable;
    }
    if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") return unreachable;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = (async (): Promise<HealthRead> => {
      try {
        const address = (await resolveUpstream(url.hostname))[0];
        if (address === undefined) return unreachable;
        const res = await forwardPinned({ host: url.hostname, address, method: "GET", path: "/api/health", headers: { "user-agent": "fulcrumaxe-cloud", accept: "application/json" }, body: null });
        // The health route answers 200 (settings complete) or 503 (incomplete); both carry the identity. A redirect is never followed.
        if (res.status !== 200 && res.status !== 503) {
          await res.bodyStream?.cancel().catch(() => undefined);
          return unreachable;
        }
        const text = await readCapped(res.bodyStream);
        if (text === null) return unreachable;
        const body: unknown = JSON.parse(text);
        if (body === null || typeof body !== "object" || Array.isArray(body)) return unreachable;
        const commit = (body as { commit?: unknown }).commit;
        return { kind: "ok", commit: typeof commit === "string" && COMMIT_ID.test(commit) ? commit : null };
      } catch (err) {
        reportError(err, { stage: "verify_stage.health" });
        return unreachable;
      }
    })();
    const timeout = new Promise<HealthRead>((resolve) => {
      timer = setTimeout(() => resolve(unreachable), deps.timeoutMs ?? TIMEOUT_MS);
    });
    try {
      return await Promise.race([attempt, timeout]);
    } finally {
      clearTimeout(timer);
    }
  };
}
