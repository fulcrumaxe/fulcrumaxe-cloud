import { promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import type { HeadersOptions } from "../../extra/headers.js";

export interface StaticServer {
  /** e.g. "http://127.0.0.1:41234" */
  origin: string;
  port: number;
  /** The address the socket is bound to; always "127.0.0.1". */
  address: string;
  close(): Promise<void>;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function headerRules(config: HeadersOptions["headers"] | undefined, urlPath: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rule of config ?? []) {
    // `(.*)` is the only wildcard the deployed headers shape uses; everything else is literal.
    const literal = rule.source.split("(.*)").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const re = new RegExp("^" + literal.join(".*") + "$");
    if (re.test(urlPath)) for (const h of rule.headers) out[h.key] = h.value;
  }
  return out;
}

/** The file to serve for a request path, or null. Containment is checked on realpath, after symlinks resolve. */
async function resolveFile(realRoot: string, rawPath: string): Promise<string | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    // fx-swallow-ok: a request path that does not decode is served as not found
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  let target = path.join(realRoot, decoded);
  try {
    if ((await fs.stat(target)).isDirectory()) target = path.join(target, "index.html");
    const real = await fs.realpath(target);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
    return (await fs.stat(real)).isFile() ? real : null;
  } catch {
    // fx-swallow-ok: a missing or unreadable file is served as not found
    return null;
  }
}

/**
 * Static file server for browser checks: 127.0.0.1 only, ephemeral port,
 * GET/HEAD only, files under `root` only. It runs no handler of any kind, so
 * `/api/x` is a 404 unless a static file of that name exists.
 */
export async function serveStatic(root: string, options: { headers?: HeadersOptions["headers"] } = {}): Promise<StaticServer> {
  const realRoot = await fs.realpath(root);
  const server: Server = createServer((req, res) => {
    void (async () => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { Allow: "GET, HEAD" }).end();
        return;
      }
      const rawPath = (req.url ?? "/").split(/[?#]/)[0] ?? "/";
      const file = await resolveFile(realRoot, rawPath);
      if (!file) {
        res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
        return;
      }
      const body = await fs.readFile(file);
      res.writeHead(200, {
        "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream",
        ...headerRules(options.headers, rawPath),
      });
      res.end(req.method === "HEAD" ? undefined : body);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port, address } = server.address() as { port: number; address: string };
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    address,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
