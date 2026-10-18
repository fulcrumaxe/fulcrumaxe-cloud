import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { decidePlanePublish } from "../../../gh-policy/src/planePublish.js";
import { parseReceivePackRefUpdates } from "../../../gh-policy/src/parseReceivePack.js";

/**
 * A stand-in for the gh-proxy as a `plane_publish` sandbox meets it, over real HTTP on loopback: one origin answers both what github.com
 * (smart-HTTP git, served by `git http-backend`) and api.github.com would, so the hook's real git and real `fetch` go through Node's real
 * connection path.
 *
 * What it enforces, as the real proxy does (P1f-4b): every request is decided by the real `decidePlanePublish` rule set, fed the same inputs the
 * proxy feeds it (the path, the query, the receive-pack ref updates parsed from THIS request's bytes through the real parser, the PR body), with
 * the private repository and the one recorded branch fixed here, never taken from the request. A denial answers 403 `denied`. For each allowed
 * request it mints a fresh token, uses it for that one upstream call, and revokes it before answering; `log` records the steps in that order.
 * The client's own credentials are ignored (the sandbox has none): a push is accepted because the proxy's token is used, so a client that sent a
 * header of its own proves nothing here, and `clientAuth` records what it sent so a test can check it carried no real token.
 *
 * What it cannot fake: TLS and the OIDC forward (loopback http is the one place the hook's transport allows plain http), the App's real
 * minting rules, rate limits and GitHub's branch protection. An uninstalled App is shown only as a generic denial (`publicStatus`).
 */
export interface ProxyEntry {
  side: "private" | "public";
  method: string;
  path: string;
  decision: "allowed" | "denied";
  steps: string[];
}

export interface PublishProxyFake {
  origin: string;
  log: ProxyEntry[];
  pulls: Array<{ title: string; body: string; head: string; base: string }>;
  clientAuth: Array<string | undefined>;
  /** Every token the proxy ever minted, so a test can search for the exact values. */
  minted: string[];
  /** Tokens minted and not yet revoked: empty whenever no request is in flight. */
  liveTokens: Set<string>;
  /** From now on every request to the public repository answers this status (a mint that fails, an uninstalled App). */
  failPublic(status: number): void;
  /** From now on a receive-pack POST is cut off mid-request (a network error on push). */
  dropReceivePack(): void;
  /** The next `POST /pulls` answers this status once (GitHub refusing the PR after the push). */
  failNextPull(status: number): void;
  close(): Promise<void>;
}

export interface PublishProxyOptions {
  /** The directory that holds `<owner>/<name>.git` for both repositories. */
  root: string;
  privateRepo: { owner: string; repo: string };
  publishTarget: { codeRepo: string; branch: string };
  env: NodeJS.ProcessEnv;
}

export async function startPublishProxy(opts: PublishProxyOptions): Promise<PublishProxyFake> {
  const log: ProxyEntry[] = [];
  const pulls: PublishProxyFake["pulls"] = [];
  const clientAuth: Array<string | undefined> = [];
  const live = new Set<string>();
  const minted: string[] = [];
  let publicFail: number | undefined;
  let dropPush = false;
  let pullFail: number | undefined;
  const [pubOwner, pubName] = opts.publishTarget.codeRepo.split("/") as [string, string];
  const bare = path.join(opts.root, pubOwner, `${pubName}.git`);
  const branchHead = (branch: string): string | undefined => {
    try {
      return execFileSync("git", ["-C", bare, "rev-parse", "--verify", "-q", `refs/heads/${branch}`], { encoding: "utf8", env: opts.env }).trim();
    } catch {
      return undefined;
    }
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? "/", "http://x");
      const method = req.method ?? "GET";
      clientAuth.push(req.headers.authorization);
      const send = (status: number, json?: unknown): void => void res.writeHead(status, json === undefined ? {} : { "content-type": "application/json" }).end(json === undefined ? undefined : JSON.stringify(json));
      const query = Object.fromEntries(url.searchParams.entries());
      const isReceive = method === "POST" && url.pathname.endsWith("/git-receive-pack");
      const isPull = method === "POST" && /\/pulls$/.test(url.pathname);
      let pullBody: Record<string, unknown> | null | undefined;
      if (isPull) {
        try {
          pullBody = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
        } catch {
          pullBody = null;
        }
      }
      let updates;
      if (isReceive) {
        const raw = req.headers["content-encoding"] === "gzip" ? gunzipSync(body) : body;
        updates = parseReceivePackRefUpdates(new Uint8Array(raw));
      }
      const decision = decidePlanePublish({ method, path: url.pathname, query, privateRepo: opts.privateRepo, publishTarget: opts.publishTarget, ...(updates ? { gitRefUpdates: updates } : {}), ...(isPull ? { pullRequestBody: pullBody ?? null } : {}) });
      const entry: ProxyEntry = { side: decision.allow ? decision.side : "public", method, path: url.pathname + url.search, decision: decision.allow ? "allowed" : "denied", steps: [] };
      log.push(entry);
      if (!decision.allow) return send(403, { message: "denied" });
      if (decision.side === "public" && publicFail !== undefined) return send(publicFail, { message: "unavailable" });
      if (!req.headers["user-agent"]) return send(403, { message: "Request forbidden by administrative rules. Please make sure your request has a User-Agent header." });
      // One token for this one upstream call: minted, used, revoked before the answer leaves.
      const token = `ghs_${randomBytes(12).toString("hex")}`;
      live.add(token);
      minted.push(token);
      entry.steps.push("mint");
      const finish = (status: number, json?: unknown): void => {
        live.delete(token);
        entry.steps.push("revoke");
        send(status, json);
      };
      entry.steps.push("use");
      if (isReceive && dropPush) {
        live.delete(token);
        entry.steps.push("revoke");
        req.socket.destroy();
        return;
      }
      if (url.pathname.startsWith("/repos/")) {
        if (method === "GET") {
          const sha = branchHead(decodeURIComponent(url.pathname.split("/git/ref/heads/")[1] ?? ""));
          return sha === undefined ? finish(404, { message: "Not Found" }) : finish(200, { object: { type: "commit", sha } });
        }
        if (pullFail !== undefined) {
          const status = pullFail;
          pullFail = undefined;
          return finish(status, { message: "Validation Failed" });
        }
        const b = pullBody as { title: string; body: string; head: string; base: string };
        if (branchHead(b.head) === undefined) return finish(422, { message: "Validation Failed" });
        pulls.push({ title: b.title, body: b.body, head: b.head, base: b.base });
        return finish(201, { number: pulls.length + 8, html_url: `https://github.com/${opts.publishTarget.codeRepo}/pull/${pulls.length + 8}` });
      }
      const child = spawn("git", ["http-backend"], {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: opts.root,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_PROJECT_ROOT: opts.root,
          GIT_HTTP_EXPORT_ALL: "1",
          REQUEST_METHOD: method,
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          CONTENT_TYPE: req.headers["content-type"] ?? "",
          CONTENT_LENGTH: String(body.length),
          ...(req.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"]) } : {}),
          ...(isReceive || query.service === "git-receive-pack" ? { REMOTE_USER: "proxy-token" } : {}),
        },
        stdio: ["pipe", "pipe", "ignore"],
      });
      const out: Buffer[] = [];
      child.stdout.on("data", (c: Buffer) => out.push(c));
      child.stdin.on("error", () => undefined);
      child.stdin.end(body);
      child.on("close", () => {
        const raw = Buffer.concat(out);
        const split = raw.indexOf("\r\n\r\n");
        live.delete(token);
        entry.steps.push("revoke");
        if (split < 0) return void res.writeHead(500).end();
        const headers: Record<string, string> = {};
        let status = 200;
        for (const line of raw.subarray(0, split).toString("utf8").split("\r\n")) {
          const [k, ...v] = line.split(": ");
          if (k!.toLowerCase() === "status") status = Number(v.join(": ").split(" ")[0]);
          else headers[k!] = v.join(": ");
        }
        res.writeHead(status, headers).end(raw.subarray(split + 4));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    log,
    pulls,
    clientAuth,
    liveTokens: live,
    minted,
    failPublic: (status) => void (publicFail = status),
    dropReceivePack: () => void (dropPush = true),
    failNextPull: (status) => void (pullFail = status),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
