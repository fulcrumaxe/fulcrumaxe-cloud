/**
 * The only way the updater reaches the network (D#6 R6-2a, correction C38 section 2).
 *
 * It replaces tuf-js's default fetcher for three reasons:
 * - It requests nothing outside the two base URLs the build names, and only over `https:`.
 * - GitHub serves a release asset through a redirect to another origin. Each hop is followed by hand, up to a small limit, and a hop
 *   that is not `https:` is refused before any connection is made. (`fetch` would follow a hop to `http:` without asking.)
 * - Certificate checking is Node's own; the optional `ca` exists for tests that run a local HTTPS server, and production never sets it.
 *
 * A refusal here is remembered in `lastRefusal`, because tuf-js wraps some download errors into a text-only error on its way out.
 */
import type { IncomingMessage } from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { BaseFetcher } from "tuf-js";
import { DownloadHTTPError } from "tuf-js/dist/error.js";

export type FetchRefusalCode = "url_not_allowed" | "redirect_refused" | "download_failed";

export class FetchRefusal extends Error {
  constructor(
    readonly code: FetchRefusalCode,
    message: string,
  ) {
    super(message);
  }
}

export const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const IDLE_TIMEOUT_MS = 30_000;
const TOTAL_TIMEOUT_MS = 20 * 60_000;

export interface PinnedFetcherOptions {
  /** The base URLs a request may start under. Each must be an `https:` URL without credentials. */
  allowedBases: readonly string[];
  /** Trust anchors for TLS. Tests only: it adds a local certificate. Production leaves it out and uses the system's. */
  ca?: string | Buffer | undefined;
  maxRedirects?: number | undefined;
  userAgent?: string | undefined;
}

function parseBase(base: string): URL {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    // fx-swallow-ok: a base that is not an address is refused as the configuration error it is
    throw new FetchRefusal("url_not_allowed", "a base URL is not an address");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new FetchRefusal("url_not_allowed", "a base URL must be a plain https URL");
  }
  return url;
}

export class PinnedFetcher extends BaseFetcher {
  /** The latest refusal made by this fetcher, if any. */
  lastRefusal: FetchRefusal | undefined;
  /** The bytes of each metadata file downloaded through `downloadBytes`, by the role name its file name carries. */
  readonly metadataBytes = new Map<string, Buffer>();
  private readonly bases: URL[];
  private readonly ca: string | Buffer | undefined;
  private readonly maxRedirects: number;
  private readonly userAgent: string;

  constructor(options: PinnedFetcherOptions) {
    super();
    this.bases = options.allowedBases.map(parseBase);
    this.ca = options.ca;
    this.maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
    this.userAgent = options.userAgent ?? "fx-runner";
  }

  override async downloadBytes(url: string, maxLength: number): Promise<Buffer> {
    const bytes = await super.downloadBytes(url, maxLength);
    const role = new URL(url).pathname.match(/(?:^|\/)(?:\d+\.)?(root|timestamp|snapshot|targets)\.json$/)?.[1];
    if (role !== undefined) this.metadataBytes.set(role, bytes);
    return bytes;
  }

  async fetch(url: string): Promise<ReadableStream<Uint8Array<ArrayBuffer>>> {
    this.lastRefusal = undefined;
    try {
      return await this.follow(url);
    } catch (error) {
      if (error instanceof FetchRefusal) this.lastRefusal = error;
      throw error;
    }
  }

  private allowed(url: URL): boolean {
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return false;
    return this.bases.some((base) => {
      const prefix = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
      return url.origin === base.origin && url.pathname.startsWith(prefix);
    });
  }

  private async follow(start: string): Promise<ReadableStream<Uint8Array<ArrayBuffer>>> {
    let url: URL;
    try {
      url = new URL(start);
    } catch {
      // fx-swallow-ok: a request for something that is not an address is refused as outside the configured locations
      throw new FetchRefusal("url_not_allowed", "the address is outside the configured update locations");
    }
    if (!this.allowed(url)) throw new FetchRefusal("url_not_allowed", "the address is outside the configured update locations");
    const signal = AbortSignal.timeout(TOTAL_TIMEOUT_MS);
    for (let hop = 0; hop <= this.maxRedirects; hop++) {
      const response = await this.get(url, signal);
      const status = response.statusCode ?? 0;
      if (!REDIRECT_STATUSES.has(status)) {
        if (status < 200 || status > 299) {
          response.resume();
          throw new DownloadHTTPError("Failed to download", status);
        }
        return Readable.toWeb(response) as unknown as ReadableStream<Uint8Array<ArrayBuffer>>;
      }
      response.resume();
      const location = response.headers.location;
      if (location === undefined) throw new FetchRefusal("redirect_refused", "a redirect without a location");
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        // fx-swallow-ok: a location that is not an address is a refused redirect, reported as such
        throw new FetchRefusal("redirect_refused", "a redirect to something that is not an address");
      }
      if (next.protocol !== "https:") throw new FetchRefusal("redirect_refused", "a redirect to a non-https address");
      if (next.username !== "" || next.password !== "") throw new FetchRefusal("redirect_refused", "a redirect to an address with credentials");
      url = next;
    }
    throw new FetchRefusal("redirect_refused", "too many redirects");
  }

  private get(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const request = https.get(
        url,
        { agent: false, signal, timeout: IDLE_TIMEOUT_MS, headers: { "User-Agent": this.userAgent }, ...(this.ca === undefined ? {} : { ca: this.ca }) },
        resolve,
      );
      request.on("timeout", () => request.destroy(new FetchRefusal("download_failed", "the server stopped answering")));
      // fx-swallow-ok: the transport's error text may carry an address; the refusal names only that the request failed
      request.on("error", (error) => reject(error instanceof FetchRefusal ? error : new FetchRefusal("download_failed", "the request failed")));
    });
  }
}
