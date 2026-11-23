/**
 * D#845 ON-8c: the engine release archive, fetched on the host and checked before a byte of it goes anywhere near a sandbox.
 *
 * THREAT MODEL. The adversary is a compromised cloud (it names the URL and the sha256), a compromised or hijacked redirect on the way, and a hostile archive. At risk: this machine's files and
 * memory, and the sandbox the engine would later be put into. What this file does:
 *  - https only, each hop re-checked against `ENGINE_TARBALL_HOSTS` (the expected chain is the project host to the code host), at most `MAX_HOPS` redirects, never an
 *    address with credentials or a port, and never a redirect handed to the transport to follow: every hop is one request and one decision made here. The host check is not a parameter;
 *    a test transport (`EngineTransport`) replaces only how bytes are fetched, never which hosts are allowed;
 *  - the body is capped at `MAX_ARCHIVE_BYTES` while it streams (a declared length over the cap is refused before a byte is read) and hashed as it arrives;
 *  - the hash is compared with the cloud's `tarball_sha256` first. Only a body whose hash holds is decompressed (to at most `MAX_TAR_BYTES`) and read entry by entry with `readTar`
 *    (no absolute or `..` path, no link out of the tree, no hard link, device or set-id mode, entry and size caps).
 * Every refusal is a closed code and a closed reason word; nothing the server or the archive said is repeated.
 */
import { createHash } from "node:crypto";
import https from "node:https";
import { gunzipSync } from "node:zlib";
import { ENGINE_TARBALL_HOSTS, isEngineTarballUrl } from "@fulcrumaxe/runner-protocol";
import { ArchiveRefused, readTar, type TarEntry } from "../vm/workspace/tar.js";

export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const MAX_TAR_BYTES = 256 * 1024 * 1024;
export const MAX_TAR_ENTRIES = 50_000;
export const MAX_HOPS = 3;
const TOTAL_TIMEOUT_MS = 10 * 60_000;
const IDLE_TIMEOUT_MS = 30_000;
const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

export type EngineArchiveCode = "engine_fetch_failed" | "engine_checksum" | "engine_archive_refused";
/** A refusal: a code of `SETUP_FAILURE_CODES` and one closed lower-case word (`SETUP_FAILURE_REASON_PATTERN`) that says which check. */
export class EngineArchiveRefused extends Error {
  constructor(readonly code: EngineArchiveCode, readonly reason: string) {
    super(`${code}:${reason}`);
    this.name = "EngineArchiveRefused";
  }
}

/** One response of one request. `body` is read at most once; `close` ends the request without reading the rest. */
export interface EngineResponse {
  status: number;
  location?: string | undefined;
  contentLength?: number | undefined;
  body: AsyncIterable<Uint8Array>;
  close(): void;
}
export type EngineTransport = (url: URL, signal: AbortSignal) => Promise<EngineResponse>;

export interface HttpsTransportOptions {
  /** Trust anchors, and the port and address to connect to: for tests that run a local HTTPS server. Production leaves all three out. */
  ca?: string | Buffer | undefined;
  port?: number | undefined;
  address?: string | undefined;
}

/** The production transport: one GET, no agent, no redirect followed, the system's trust store. */
export function createHttpsTransport(options: HttpsTransportOptions = {}): EngineTransport {
  return (url, signal) =>
    new Promise((resolve, reject) => {
      const request = https.request(
        { protocol: "https:", hostname: url.hostname, port: options.port ?? 443, path: url.pathname + url.search, method: "GET", agent: false, signal, timeout: IDLE_TIMEOUT_MS, headers: { "user-agent": "fx-runner", accept: "application/gzip, */*" }, ...(options.ca === undefined ? {} : { ca: options.ca }), ...(options.address === undefined ? {} : { lookup: ((_host: string, lookupOptions: { all?: boolean }, cb: (...args: unknown[]) => void) => (lookupOptions.all === true ? cb(null, [{ address: options.address, family: 4 }]) : cb(null, options.address, 4))) as never }) },
        (response) => {
          const length = Number(response.headers["content-length"]);
          resolve({ status: response.statusCode ?? 0, location: response.headers.location, contentLength: Number.isSafeInteger(length) && length >= 0 ? length : undefined, body: response, close: () => response.destroy() });
        },
      );
      request.on("timeout", () => request.destroy());
      // fx-swallow-ok: the transport's error text may carry an address; the caller reports one closed code for a request that failed
      request.on("error", () => reject(new EngineArchiveRefused("engine_fetch_failed", "request")));
      request.end();
    });
}

/** True for an https address on an allowed host, with no credentials and no port. */
function hopAllowed(url: URL): boolean {
  return url.protocol === "https:" && url.username === "" && url.password === "" && url.port === "" && (ENGINE_TARBALL_HOSTS as readonly string[]).includes(url.hostname);
}

export interface FetchedEngine {
  /** sha256 of the downloaded bytes, which equals the release's `tarball_sha256`. */
  sha256: string;
  /** The decompressed tar, and its checked entries (file bodies are views into it). */
  tar: Buffer;
  entries: TarEntry[];
}

/** Reads the body, at most `MAX_ARCHIVE_BYTES`, hashing as it goes. */
async function readBody(response: EngineResponse): Promise<{ bytes: Buffer; sha256: string }> {
  if (response.contentLength !== undefined && response.contentLength > MAX_ARCHIVE_BYTES) throw new EngineArchiveRefused("engine_archive_refused", "too_large");
  const hash = createHash("sha256");
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > MAX_ARCHIVE_BYTES) throw new EngineArchiveRefused("engine_archive_refused", "too_large");
      hash.update(chunk);
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    if (error instanceof EngineArchiveRefused) throw error;
    // fx-swallow-ok: a body that stopped or errored mid-stream is one closed code; the transport's text is never repeated
    throw new EngineArchiveRefused("engine_fetch_failed", "body");
  } finally {
    response.close();
  }
  return { bytes: Buffer.concat(chunks), sha256: hash.digest("hex") };
}

/** Downloads, checks and reads the release archive. Throws `EngineArchiveRefused`, and nothing else. */
export async function fetchEngineArchive(release: { tarball_url: string; tarball_sha256: string }, options: { transport?: EngineTransport; signal?: AbortSignal } = {}): Promise<FetchedEngine> {
  const transport = options.transport ?? createHttpsTransport();
  const signal = options.signal === undefined ? AbortSignal.timeout(TOTAL_TIMEOUT_MS) : AbortSignal.any([options.signal, AbortSignal.timeout(TOTAL_TIMEOUT_MS)]);
  if (!isEngineTarballUrl(release.tarball_url)) throw new EngineArchiveRefused("engine_archive_refused", "host");
  let url = new URL(release.tarball_url);
  for (let hop = 0; ; hop++) {
    // Re-checked before every request, the first one included: no connection is made to an address that fails it.
    if (!hopAllowed(url)) throw new EngineArchiveRefused("engine_archive_refused", "host");
    const response = await transport(url, signal).catch((error: unknown) => {
      throw error instanceof EngineArchiveRefused ? error : new EngineArchiveRefused("engine_fetch_failed", "request");
    });
    if (REDIRECTS.has(response.status)) {
      response.close();
      if (hop >= MAX_HOPS) throw new EngineArchiveRefused("engine_fetch_failed", "hops");
      try {
        url = new URL(response.location ?? "", url);
      } catch {
        // fx-swallow-ok: a location that is not an address is a refused redirect
        throw new EngineArchiveRefused("engine_archive_refused", "host");
      }
      continue;
    }
    if (response.status !== 200) {
      response.close();
      throw new EngineArchiveRefused("engine_fetch_failed", "status");
    }
    const { bytes, sha256 } = await readBody(response);
    if (sha256 !== release.tarball_sha256.toLowerCase()) throw new EngineArchiveRefused("engine_checksum", "mismatch");
    let tar: Buffer;
    try {
      tar = gunzipSync(bytes, { maxOutputLength: MAX_TAR_BYTES });
    } catch {
      // fx-swallow-ok: a body that is not gzip, or that expands past the cap, is one closed refusal
      throw new EngineArchiveRefused("engine_archive_refused", "gzip");
    }
    try {
      return { sha256, tar, entries: readTar(tar, { maxEntries: MAX_TAR_ENTRIES, maxTotalBytes: MAX_TAR_BYTES }) };
    } catch (error) {
      throw error instanceof ArchiveRefused ? new EngineArchiveRefused("engine_archive_refused", error.code.replace(/^archive_/, "")) : new EngineArchiveRefused("engine_archive_refused", "malformed");
    }
  }
}

/** The body of the file at `relative` inside the archive's one top directory (`<repo>-<sha>/`), or undefined. */
export function engineFile(entries: readonly TarEntry[], relative: string): Buffer | undefined {
  const top = entries[0]?.path.split("/")[0];
  if (top === undefined) return undefined;
  return entries.find((entry) => entry.kind === "file" && entry.path === `${top}/${relative}`)?.data;
}
