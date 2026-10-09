import { createServer as createHttp, type Server as HttpServer } from "node:http";
import { createServer as createHttps, type Server as HttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import type { BuiltRepo } from "./tufRepo.js";
import { generateSelfSignedCert } from "../helpers/selfSignedCert.js";

/**
 * Local servers that behave the way GitHub Releases does for the updater (D#6 R6-2a):
 *  - origin A answers `/metadata/<file>` and `/targets/<path>` over real TLS (a self-signed certificate the client is handed as its CA);
 *  - a path in `redirects` answers 302 with the stored `Location`, which is how a release asset reaches its CDN origin;
 *  - origin B (another port, so another origin) answers `/files/<path>`;
 *  - a plain-http server counts every request it gets, so a test can show that a refused hop never connected.
 * `metadata` and `files` are live maps: a test replaces or removes an entry between two client runs.
 */
export interface TufServer {
  ca: string;
  /** `https://127.0.0.1:<port>`, origins A and B, and the plain http origin. */
  originA: string;
  originB: string;
  plainOrigin: string;
  metadataBase: string;
  targetBase: string;
  metadata: Map<string, Buffer>;
  files: Map<string, Buffer>;
  /** pathname on A to the Location it answers with (status 302). */
  redirects: Map<string, string>;
  /** Every request served by A or B, as `A /metadata/timestamp.json`. */
  requests: string[];
  plainHits: { count: number };
  close(): Promise<void>;
}

const listen = <S extends HttpServer | HttpsServer>(server: S): Promise<number> =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));

export async function startTufServer(repo: BuiltRepo): Promise<TufServer> {
  const { certPem, keyPem } = generateSelfSignedCert("127.0.0.1", 1, { ipAddresses: ["127.0.0.1"] });
  const metadata = new Map(repo.metadata);
  const files = new Map(repo.files);
  const redirects = new Map<string, string>();
  const requests: string[] = [];
  const plainHits = { count: 0 };

  const serve = (label: "A" | "B") => (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
    const pathname = new URL(req.url ?? "/", "https://x").pathname;
    requests.push(`${label} ${pathname}`);
    const send = (status: number, body?: Buffer, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { "content-length": String(body?.length ?? 0), ...headers });
      res.end(body);
    };
    const redirect = label === "A" ? redirects.get(pathname) : undefined;
    if (redirect !== undefined) return send(302, undefined, { location: redirect });
    const rest = (prefix: string): string => decodeURIComponent(pathname.slice(prefix.length));
    const body =
      label === "A" && pathname.startsWith("/metadata/")
        ? metadata.get(rest("/metadata/"))
        : label === "A" && pathname.startsWith("/targets/")
          ? files.get(rest("/targets/"))
          : label === "B" && pathname.startsWith("/files/")
            ? files.get(rest("/files/"))
            : undefined;
    return body === undefined ? send(404) : send(200, body);
  };

  const a = createHttps({ cert: certPem, key: keyPem }, serve("A"));
  const b = createHttps({ cert: certPem, key: keyPem }, serve("B"));
  const plain = createHttp((_req, res) => {
    plainHits.count += 1;
    res.writeHead(200, { "content-length": "0" });
    res.end();
  });
  const [portA, portB, portPlain] = await Promise.all([listen(a), listen(b), listen(plain)]);
  const originA = `https://127.0.0.1:${portA}`;
  return {
    ca: certPem,
    originA,
    originB: `https://127.0.0.1:${portB}`,
    plainOrigin: `http://127.0.0.1:${portPlain}`,
    metadataBase: `${originA}/metadata/`,
    targetBase: `${originA}/targets/`,
    metadata,
    files,
    redirects,
    requests,
    plainHits,
    close: () =>
      new Promise((resolve) => {
        for (const server of [a, b, plain]) server.closeAllConnections();
        let open = 3;
        for (const server of [a, b, plain]) server.close(() => (--open === 0 ? resolve() : undefined));
      }),
  };
}
