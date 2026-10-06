#!/usr/bin/env node
// apps/workspace/perf/brotli-proxy.mjs
//
// D#37 WS-D fix round 1, MUST 2: two gaps between a LOCAL `next start`
// and real production (Vercel's edge network) inflate a local
// `perf/lighthouse.mjs` run's sign-in-visible time past what a real user
// sees, which is exactly the reviewer's own explanation for why the
// first WS-D criterion 6 measurement (3,227ms) came in over budget:
//
//   1. Compression: `next start` only ever negotiates gzip. True brotli
//      for a response is an edge-layer feature (the CDN in front of the
//      origin, not `next start` itself) that this local harness cannot
//      reproduce by running `next start` alone.
//   2. Transport: `next start` speaks plain HTTP/1.1, which caps
//      Chromium at 6 concurrent connections per origin. Vercel's edge
//      serves every client over HTTP/2 (full multiplexing, no such
//      cap). Measured live on this exact build: 87 requests / 178 KB
//      brotli takes ~3,050ms median over HTTP/1.1 under the criterion's
//      Slow-4G/CPUx4 throttle, but ~1,780ms over HTTP/2 -- the
//      connection cap, not bytes or CPU, is the dominant remaining cost
//      (TBT is 0ms either way).
//
// This is a measurement-only stand-in for that edge layer: a reverse
// proxy that sits in front of a real `next start`, forwards every
// request unchanged, and (a) re-encodes the response body as brotli
// (q11 -- the exact quality profile.test.mjs's own build-time brotli
// gate already uses) for any text-ish content type Vercel's own edge
// would compress, and (b) optionally terminates real TLS + HTTP/2 on
// the client side (Node's `http2` compat API) when --tls is given -- Chromium never negotiates HTTP/2 without real TLS (no
// browser supports cleartext h2c for a normal navigation), so this
// falls back to plain HTTP/1.1 without --tls. It is never
// imported by application code, never wired into `next build`/`next
// start`, and adds no new dependency -- only `node:http`, `node:http2`
// and `node:zlib`, all already available in Node itself (zlib already
// used elsewhere in this package, profile.test.mjs).
//
// With --tls the proxy generates a throwaway self-signed key and cert for
// `127.0.0.1`/`localhost` at start (perf/dev-tls.mjs, node:crypto only),
// writes them into a private mkdtemp directory (mode 0600) and deletes
// that directory on exit. Nothing is written under perf/ and no key is
// committed. A real browser still refuses an unknown CA, so callers pass
// `ignoreHTTPSErrors: true` to Playwright's `newContext()` the same way
// this repo's own live-session e2e specs trust a local fixture
// (fake-github-authorize.mjs).
//
// Usage:
//   node perf/brotli-proxy.mjs --upstream http://localhost:3010 --port 3011
//   node perf/brotli-proxy.mjs --upstream http://localhost:3010 --port 3012 \
//     --tls
//
// Point perf/lighthouse.mjs's --url at the PROXY's port (https:// when
// --tls was given), not `next start`'s own port, to get a
// production-like (brotli, HTTP/2) measurement.

import http from "node:http";
import http2 from "node:http2";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateDevTlsCert } from "./dev-tls.mjs";
import zlib from "node:zlib";

// Mirrors the content types Vercel's own edge compresses (text-ish,
// already-compressed binary formats like woff2/png gain nothing and are
// passed through untouched, matching real-world behavior).
const COMPRESSIBLE_RE = /^(text\/|application\/(javascript|json|xml|manifest\+json)|image\/svg\+xml)/i;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function readBody(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

function decodeBody(buf, contentEncoding) {
  if (!contentEncoding) return buf;
  const enc = contentEncoding.toLowerCase();
  if (enc === "gzip") return zlib.gunzipSync(buf);
  if (enc === "br") return zlib.brotliDecompressSync(buf);
  if (enc === "deflate") return zlib.inflateSync(buf);
  return buf; // unknown encoding -- pass through as-is, better than crashing.
}

/** Shared by both the plain-HTTP and the HTTP/2 listener below -- the
 * only real difference between them is how the incoming request/response
 * pair is obtained; forwarding and re-compression are identical. */
function makeRequestHandler(upstreamUrl) {
  return function handleRequest(req, res) {
    // HTTP/2's compat API surfaces pseudo-headers (":method", ":path", ...)
    // in req.headers -- node:http's client rejects any header name that
    // isn't a valid HTTP/1.1 token, so these must never be forwarded.
    const forwardHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!k.startsWith(":")) forwardHeaders[k] = v;
    }

    const upstreamReq = http.request(
      {
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port,
        path: req.url,
        method: req.method,
        headers: { ...forwardHeaders, host: upstreamUrl.host, "accept-encoding": "gzip" },
      },
      async (upstreamRes) => {
        const rawBody = await readBody(upstreamRes);
        const contentType = upstreamRes.headers["content-type"] || "";
        const acceptsBr = (req.headers["accept-encoding"] || "").includes("br");
        const headers = { ...upstreamRes.headers };
        delete headers["content-length"];
        delete headers["transfer-encoding"];
        // HTTP/2 forbids HTTP/1-only connection-management headers outright
        // (ERR_HTTP2_INVALID_CONNECTION_HEADERS) -- harmless to drop for the
        // HTTP/1.1 listener too, since this proxy always closes/reopens its
        // own upstream connection per request rather than surfacing these.
        delete headers["connection"];
        delete headers["keep-alive"];
        delete headers["upgrade"];

        if (acceptsBr && COMPRESSIBLE_RE.test(contentType)) {
          const body = decodeBody(rawBody, upstreamRes.headers["content-encoding"]);
          const compressed = zlib.brotliCompressSync(body, {
            params: {
              [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
              [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length,
            },
          });
          headers["content-encoding"] = "br";
          headers["content-length"] = String(compressed.length);
          res.writeHead(upstreamRes.statusCode || 200, headers);
          res.end(compressed);
        } else {
          delete headers["content-encoding"];
          const body = decodeBody(rawBody, upstreamRes.headers["content-encoding"]);
          headers["content-length"] = String(body.length);
          res.writeHead(upstreamRes.statusCode || 200, headers);
          res.end(body);
        }
      },
    );
    upstreamReq.on("error", (err) => {
      res.writeHead(502);
      res.end(`brotli-proxy: upstream error: ${err.message}`);
    });
    req.pipe(upstreamReq);
  };
}

async function main(argv) {
  const args = parseArgs(argv);
  const upstream = typeof args.upstream === "string" ? args.upstream : null;
  const port = typeof args.port === "string" ? Number(args.port) : null;
  if (!upstream || !port) {
    console.error("perf/brotli-proxy.mjs: usage: node perf/brotli-proxy.mjs --upstream <url> --port <n> [--tls]");
    return 1;
  }
  const upstreamUrl = new URL(upstream);
  const handler = makeRequestHandler(upstreamUrl);

  const useH2 = args.tls === true;
  let tlsDir = null;
  let server;
  if (useH2) {
    const { certPem, keyPem } = generateDevTlsCert();
    tlsDir = fs.mkdtempSync(path.join(os.tmpdir(), "brotli-proxy-tls-"));
    fs.chmodSync(tlsDir, 0o700);
    fs.writeFileSync(path.join(tlsDir, "key.pem"), keyPem, { mode: 0o600 });
    fs.writeFileSync(path.join(tlsDir, "cert.pem"), certPem, { mode: 0o600 });
    const dir = tlsDir;
    process.on("exit", () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    });
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => process.exit(0));
    server = http2.createSecureServer(
      {
        key: fs.readFileSync(path.join(dir, "key.pem")),
        cert: fs.readFileSync(path.join(dir, "cert.pem")),
        allowHTTP1: true,
      },
      handler,
    );
  } else {
    server = http.createServer(handler);
  }

  await new Promise((resolve) => server.listen(port, resolve));
  console.log(
    `perf/brotli-proxy.mjs: listening on :${port} (${useH2 ? "https, h2" : "http, h1.1"}), proxying to ${upstream} (br when the client accepts it)${tlsDir ? `; tls dir ${tlsDir}` : ""}`,
  );
  return new Promise(() => {}); // run until killed
}

main(process.argv.slice(2)).then((code) => {
  if (typeof code === "number") process.exitCode = code;
});
