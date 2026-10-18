import { spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A smart-HTTP git server over `git http-backend` (the CGI that ships with git), standing in for github.com for the transport tests.
 *
 * What it enforces, as the real host does: reads (fetch) are anonymous; a push (`git-receive-pack`) needs HTTP Basic credentials
 * whose password is a token bound to exactly the repositories listed for it, and any other repository answers 403 even with a
 * valid token. It also records every request, so a test can see which header carried the token.
 *
 * What it cannot fake: GitHub's branch protection, its push-rule checks, large-push limits and rate limits, and TLS (a loopback
 * http origin is the one place the transport allows plain http).
 */
export interface GitHttpServer {
  origin: string;
  seen: Array<{ method: string; path: string; authorization: string | undefined }>;
  close(): Promise<void>;
}

export async function startGitHttpServer(root: string, tokens: ReadonlyMap<string, readonly string[]>): Promise<GitHttpServer> {
  const seen: GitHttpServer["seen"] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url ?? "/", "http://x");
      seen.push({ method: req.method ?? "GET", path: url.pathname + url.search, authorization: req.headers.authorization });
      const repo = /^\/([^/]+\/[^/]+?)\.git\//.exec(url.pathname)?.[1];
      const isPush = url.pathname.endsWith("/git-receive-pack") || url.searchParams.get("service") === "git-receive-pack";
      let user = "";
      if (isPush) {
        const m = /^Basic (.+)$/.exec(req.headers.authorization ?? "");
        const [name, ...rest] = m ? Buffer.from(m[1]!, "base64").toString("utf8").split(":") : [];
        const allowed = name === "x-access-token" ? tokens.get(rest.join(":")) : undefined;
        if (!allowed) {
          res.writeHead(401, { "www-authenticate": 'Basic realm="git"' }).end("Authentication required");
          return;
        }
        if (!repo || !allowed.includes(repo)) {
          res.writeHead(403).end("Permission denied: the token does not cover this repository");
          return;
        }
        user = "token-user";
      }
      const child = spawn("git", ["http-backend"], {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: root,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: "1",
          REQUEST_METHOD: req.method ?? "GET",
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          CONTENT_TYPE: req.headers["content-type"] ?? "",
          CONTENT_LENGTH: String(body.length),
          ...(req.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"]) } : {}),
          ...(user ? { REMOTE_USER: user } : {}),
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
        if (split < 0) {
          res.writeHead(500).end();
          return;
        }
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
    seen,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
