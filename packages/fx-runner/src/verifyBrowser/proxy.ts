import { request as httpRequest, createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import type { BasePin } from "./pin.js";

/**
 * D#749 V2c-2a: the origin pin at the network layer. Chromium is started with this proxy as its only way out (loopback included), so a request the page-level hooks
 * never see (the browser's own prefetch, a prerender, anything a later Chromium adds) still has to pass here. Only the exact base origin gets through:
 *  - a plain http request, when the base is http, to that scheme, host and port;
 *  - a CONNECT tunnel (https and WebSocket traffic) to that host and port.
 * Everything else is answered 403 (a CONNECT is refused and closed) and counted. Redirects are never followed here and no body is held: requests and responses are streamed.
 * The upstream address is the base's own, never one taken from the request.
 */
export interface OriginProxy {
  port: number;
  /** How many requests were refused so far. */
  refused(): number;
  close(): Promise<void>;
}

const HOP_BY_HOP = new Set(["proxy-connection", "proxy-authorization", "connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade"]);

/** The scheme, host name and port a base URL stands for; the port is the effective one. */
function target(base: BasePin): { protocol: string; host: string; port: number } {
  const u = new URL(base.href);
  return { protocol: u.protocol, host: u.hostname, port: u.port === "" ? (u.protocol === "https:" ? 443 : 80) : Number(u.port) };
}

export function startOriginProxy(base: BasePin): Promise<OriginProxy> {
  const want = target(base);
  let refused = 0;
  const refuse = (res: ServerResponse): void => {
    refused += 1;
    res.writeHead(403, { "content-type": "text/plain", connection: "close" }).end("refused");
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      // fx-swallow-ok: a request line that is not an absolute address is refused, and counted
      return refuse(res);
    }
    if (want.protocol !== "http:" || url.protocol !== "http:" || url.origin !== base.origin) return refuse(res);
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !HOP_BY_HOP.has(name)));
    const upstream = httpRequest({ host: want.host, port: want.port, method: req.method, path: `${url.pathname}${url.search}`, headers }, (reply) => {
      res.writeHead(reply.statusCode ?? 502, Object.fromEntries(Object.entries(reply.headers).filter(([name]) => !HOP_BY_HOP.has(name))) as Record<string, string | string[]>);
      reply.pipe(res);
    });
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502).end();
      else res.destroy();
    });
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });

  server.on("connect", (req: IncomingMessage, client: Socket, head: Buffer) => {
    const [host, port] = (req.url ?? "").split(":");
    const same = host !== undefined && host.replace(/^\[|\]$/g, "") === want.host.replace(/^\[|\]$/g, "") && Number(port) === want.port;
    if (!same) {
      refused += 1;
      client.end("HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n");
      return;
    }
    const upstream = connect(want.port, want.host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    const drop = (): void => {
      upstream.destroy();
      client.destroy();
    };
    upstream.on("error", drop);
    client.on("error", drop);
    client.on("close", drop);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        refused: () => refused,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
