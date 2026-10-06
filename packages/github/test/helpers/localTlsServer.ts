import https from "node:https";
import net, { type AddressInfo } from "node:net";
import { generateSelfSignedCert } from "../../../webhooks/test/helpers/selfSignedCert.js";
import { checkGithubRequest, type GhReply, type GhRequest } from "./strictGithub.js";

/**
 * Test helpers that drive Node's REAL connection path. The default path is what production runs: TLS with
 * certificate and hostname checks, `autoSelectFamily` on (the default since Node 20), which calls a custom
 * `lookup` with `{ all: true }`. A hand-called `lookup` callback or `rejectUnauthorized: false` hides every
 * bug in that path.
 *
 * `startLocalTlsServer` serves HTTPS on 127.0.0.1 with a self-signed certificate for the given names. The
 * client gets that certificate as its explicit `ca` (never a global trust change, never
 * `rejectUnauthorized: false`), so the SNI name and the certificate's names are really checked.
 *
 * `startStrictGithubServer` is that server speaking GitHub: it applies `checkGithubRequest` to the raw
 * request, where nothing is added on the client's behalf.
 */
export interface LocalTlsServer {
  port: number;
  /** The certificate (also its own CA), to be passed to the client as `ca`. */
  ca: string;
  /** Every request received, as the server saw it. */
  seen: Array<{ method: string; path: string; query?: string; headers: Record<string, string>; body: string; servername: string | false | undefined }>;
  close: () => Promise<void>;
}

export type LocalReply = { status: number; headers?: Record<string, string>; body?: string };

export async function startLocalTlsServer(
  names: { dnsNames?: string[]; ipAddresses?: string[] },
  respond: (req: GhRequest) => LocalReply | Promise<LocalReply>,
): Promise<LocalTlsServer> {
  const { certPem, keyPem } = generateSelfSignedCert(names.dnsNames?.[0] ?? "127.0.0.1", 1, {
    dnsNames: names.dnsNames,
    ipAddresses: names.ipAddresses ?? ["127.0.0.1"],
  });
  const seen: LocalTlsServer["seen"] = [];
  const server = https.createServer({ cert: certPem, key: keyPem }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : v;
      const rawUrl = req.url ?? "/";
      const q = rawUrl.indexOf("?");
      const gh: GhRequest = { method: req.method ?? "GET", path: q === -1 ? rawUrl : rawUrl.slice(0, q), ...(q === -1 ? {} : { query: rawUrl.slice(q + 1) }), headers, body: Buffer.concat(chunks).toString("utf8") };
      seen.push({ ...gh, servername: (req.socket as unknown as { servername?: string | false }).servername });
      Promise.resolve(respond(gh)).then(
        (r) => {
          res.writeHead(r.status, r.headers ?? {});
          res.end(r.body ?? "");
        },
        () => {
          res.writeHead(500);
          res.end();
        },
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    ca: certPem,
    seen,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A local HTTPS server that is GitHub's API as far as `checkGithubRequest` goes; `route` answers what passes the rules. */
export function startStrictGithubServer(route: (req: GhRequest) => GhReply | Promise<GhReply>, now: () => number = Date.now): Promise<LocalTlsServer> {
  return startLocalTlsServer({ dnsNames: ["api.github.com"], ipAddresses: ["127.0.0.1"] }, async (req) => checkGithubRequest(req, now()) ?? (await route(req)));
}

export interface RoundTrip {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * One `https.request` through Node's default connect path. It refuses to run when the process has turned
 * `autoSelectFamily` off, since then it would not be the path production uses. Pass `options.lookup` to
 * exercise a custom lookup the way the connect path calls it.
 */
export function httpsRoundTrip(options: https.RequestOptions, body?: string): Promise<RoundTrip> {
  if (!net.getDefaultAutoSelectFamily()) throw new Error("httpsRoundTrip: autoSelectFamily is off; this is not Node's default connect path");
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : v;
        resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}
