import { spawn } from "node:child_process";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { generateSelfSignedCert } from "./selfSignedCert.js";

/**
 * A stand-in for the cloud's GitHub relay (D#6 R5a-3), strict about what the real one is strict about, with the real `git http-backend`
 * behind it so every body is what the installed git really sends (v2 `ls-refs` and `fetch`, gzip over 1 KiB, `have` lines, receive-pack).
 *  - TLS with a self-signed certificate the test hands to git as its CA (the real client path, not plain http);
 *  - a request must carry `fx-git-ticket: <the expected ticket>` or it is a 401, and it must carry no `Authorization`;
 *  - the path must be `/api/gh-proxy/<owner>/<name>.git/...`;
 *  - a body over 4 MiB (inflated for gzip: the cap applies to what is read) is a 413;
 *  - the ticket header is not passed on to git-http-backend (it never reaches the upstream).
 * Every request is recorded; a test may make any request answer a given status first (`script`).
 */
export interface RelayRequest {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string | string[] | undefined>;
  /** The inflated body. */
  body: Buffer;
  /** For a POST to git-upload-pack: the v2 command (`ls-refs`, `fetch`) or `v0`. */
  command?: string;
  haves?: number;
  wants?: number;
  /** For a POST to git-receive-pack: the ref updates asked for. */
  updates?: Array<{ old: string; new: string; ref: string }>;
  status: number;
}

export interface Relay {
  origin: string;
  caPem: string;
  requests: RelayRequest[];
  /** The ticket every request must carry. Change it to make the next requests 401. */
  ticket: { value: string };
  /** Called with each request before it is served; return a status to answer that instead of serving it. */
  script: { before?: (req: RelayRequest, index: number) => number | undefined };
  close(): Promise<void>;
}

const MAX_BODY = 4 * 1024 * 1024;

function pktLines(buf: Buffer): string[] {
  const out: string[] = [];
  let at = 0;
  while (at + 4 <= buf.length) {
    const len = parseInt(buf.subarray(at, at + 4).toString("ascii"), 16);
    if (!Number.isFinite(len)) break;
    if (len < 4) {
      out.push(len === 0 ? "<flush>" : len === 1 ? "<delim>" : "<end>");
      at += 4;
      continue;
    }
    out.push(buf.subarray(at + 4, at + len).toString("utf8"));
    at += len;
  }
  return out;
}

export async function startRelay(input: { projectRoot: string; ticket: string; owner: string; name: string }): Promise<Relay> {
  const { certPem, keyPem } = generateSelfSignedCert("127.0.0.1", 1, { ipAddresses: ["127.0.0.1"] });
  const requests: RelayRequest[] = [];
  const state: Relay = { origin: "", caPem: certPem, requests, ticket: { value: input.ticket }, script: {}, close: async () => {} };
  const prefix = `/api/gh-proxy/${input.owner}/${input.name}.git`;

  const server: Server = createServer({ cert: certPem, key: keyPem }, (req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY * 4) over = true;
      else chunks.push(chunk);
    });
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "https://x");
      let body: Buffer = Buffer.concat(chunks);
      const record: RelayRequest = { method: req.method ?? "", path: url.pathname, query: url.search.slice(1), headers: { ...req.headers }, body: Buffer.alloc(0), status: 0 };
      requests.push(record);
      const reply = (status: number, text = ""): void => {
        record.status = status;
        res.writeHead(status, { "content-type": "text/plain" });
        res.end(text);
      };
      try {
        if (req.headers["content-encoding"] === "gzip") body = gunzipSync(body, { maxOutputLength: MAX_BODY + 1 });
      } catch {
        return reply(413, "too large");
      }
      record.body = body;
      if (req.headers["fx-git-ticket"] !== state.ticket.value || req.headers.authorization !== undefined) {
        res.setHeader("www-authenticate", 'Basic realm="relay"');
        return reply(401, "ticket_invalid");
      }
      if (over || body.length > MAX_BODY) return reply(413, "push_too_large");
      if (!url.pathname.startsWith(`${prefix}/`)) return reply(403, "denied");
      const lines = pktLines(body);
      if (url.pathname.endsWith("/git-upload-pack") && req.method === "POST") {
        const v2 = lines[0]?.startsWith("command=");
        record.command = v2 ? lines[0]!.slice(8).trim() : "v0";
        record.haves = lines.filter((l) => l.startsWith("have ")).length;
        record.wants = lines.filter((l) => l.startsWith("want ")).length;
      }
      if (url.pathname.endsWith("/git-receive-pack") && req.method === "POST") {
        record.updates = [];
        const first = lines[0] ?? "";
        for (const line of lines) {
          if (line === "<flush>") break;
          const [command] = line.split("\0");
          const m = command!.match(/^([0-9a-f]{40,64}) ([0-9a-f]{40,64}) (\S+)/);
          if (m) record.updates.push({ old: m[1]!, new: m[2]!, ref: m[3]! });
        }
        void first;
      }
      const forced = state.script.before?.(record, requests.length - 1);
      if (forced !== undefined) return reply(forced, "scripted");
      // The upstream: the real git http-backend over a directory of bare repositories. The ticket is not among the variables it is given.
      const cgi = spawn("git", ["http-backend"], {
        env: {
          PATH: process.env.PATH ?? "",
          GIT_PROJECT_ROOT: input.projectRoot,
          GIT_HTTP_EXPORT_ALL: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          REMOTE_USER: "relay",
          REQUEST_METHOD: req.method ?? "GET",
          PATH_INFO: url.pathname.slice("/api/gh-proxy".length),
          QUERY_STRING: url.search.slice(1),
          CONTENT_TYPE: String(req.headers["content-type"] ?? ""),
          CONTENT_LENGTH: String(body.length),
          ...(req.headers["git-protocol"] === undefined ? {} : { GIT_PROTOCOL: String(req.headers["git-protocol"]) }),
        },
        stdio: ["pipe", "pipe", "ignore"],
      });
      // http-backend may exit without reading the whole body (a GET, a refusal); the write to its closed stdin then fails with EPIPE.
      // The reply is built from what it printed, so a lost write is not an error here.
      cgi.stdin.on("error", () => {});
      cgi.stdin.end(body);
      const out: Buffer[] = [];
      cgi.stdout.on("data", (c: Buffer) => out.push(c));
      cgi.on("close", () => {
        const all = Buffer.concat(out);
        const split = all.indexOf("\r\n\r\n");
        const head = all.subarray(0, split < 0 ? 0 : split).toString("utf8");
        const payload = all.subarray(split < 0 ? 0 : split + 4);
        const headers: Record<string, string> = {};
        let status = 200;
        for (const line of head.split("\r\n")) {
          const [k, ...v] = line.split(":");
          if (!k) continue;
          if (k.toLowerCase() === "status") status = parseInt(v.join(":").trim(), 10);
          else headers[k] = v.join(":").trim();
        }
        record.status = status;
        res.writeHead(status, headers);
        res.end(payload);
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  return state;
}
