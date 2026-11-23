import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import type { ServerResponse } from "node:http";
import { createHttpsTransport, type EngineTransport } from "../../src/setup/engineArchive.js";
import { generateSelfSignedCert } from "./selfSignedCert.js";

export type Route = (response: ServerResponse) => void | Promise<void>;

export interface EngineHttps {
  /** The real HTTPS transport, pointed at this server: the host in the URL is still `codeload.github.com` (so the host check and TLS name are the real ones), the bytes come from here. */
  transport: EngineTransport;
  /** Every request this server saw: its Host header and path. */
  seen: Array<{ host: string; path: string }>;
  close(): Promise<void>;
}

/** A local HTTPS server standing in for github.com and codeload.github.com. `routes` is keyed by `host + path`; no real network is reached. */
export async function startEngineHttps(routes: Record<string, Route>): Promise<EngineHttps> {
  const cert = generateSelfSignedCert("codeload.github.com", 1, { dnsNames: ["codeload.github.com", "github.com"] });
  const seen: EngineHttps["seen"] = [];
  const server: Server = createServer({ cert: cert.certPem, key: cert.keyPem }, (request, response) => {
    const host = (request.headers.host ?? "").replace(/:\d+$/, "");
    seen.push({ host, path: request.url ?? "" });
    const route = routes[`${host}${request.url ?? ""}`];
    if (route === undefined) {
      response.statusCode = 404;
      response.end();
      return;
    }
    void Promise.resolve(route(response));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    transport: createHttpsTransport({ ca: cert.certPem, port, address: "127.0.0.1" }),
    seen,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

export const sendBytes = (bytes: Buffer): Route => (response) => {
  response.setHeader("content-length", String(bytes.length));
  response.end(bytes);
};
export const redirectTo = (location: string, status = 302): Route => (response) => {
  response.statusCode = status;
  response.setHeader("location", location);
  response.end();
};
