import { execFileSync } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for api.github.com, for the one repository the run-end hook publishes to, served over real HTTP on loopback so the calls go through
 * Node's real connection path.
 *
 * What it enforces, as the real host does for what the hook's calls touch:
 *  - a request with no `User-Agent` is refused 403 (GitHub's rule);
 *  - the bearer must be a live token: an unknown or revoked one answers 401 `Bad credentials`;
 *  - `DELETE /installation/token` answers 204 with an empty body, and the token answers 401 on every later call (and on the git server, which shares the
 *    same live-token map);
 *  - `GET /git/ref/heads/<branch>` answers the ref's head from the public repository itself, or 404;
 *  - `POST /pulls` needs the head branch to exist (422 otherwise) and answers 201 with the pull request's number and github.com address.
 *
 * What it cannot fake: TLS (loopback http is the one place the client allows plain http), rate limits, branch protection, fork rules and GitHub's
 * validation of a title or body beyond the shape.
 */
export interface FakePublicGithub {
  origin: string;
  seen: Array<{ method: string; path: string; authorization: string | undefined; userAgent: string | undefined; body: unknown }>;
  pulls: Array<{ title: string; body: string; head: string; base: string }>;
  /** Makes the next `POST /pulls` answer this status (422 by default shape), once. */
  failNextPull(status: number): void;
  close(): Promise<void>;
}

export interface FakePublicGithubOptions {
  /** The bare public repository on disk, where the branch lookups read. */
  bare: string;
  repo: string;
  /** Live tokens by repository, shared with the git server: revoking removes the entry from both. */
  tokens: Map<string, string[]>;
  env: NodeJS.ProcessEnv;
}

export async function startFakePublicGithub(opts: FakePublicGithubOptions): Promise<FakePublicGithub> {
  const seen: FakePublicGithub["seen"] = [];
  const pulls: FakePublicGithub["pulls"] = [];
  let failNext: number | undefined;
  const head = (branch: string): string | undefined => {
    try {
      return execFileSync("git", ["-C", opts.bare, "rev-parse", "--verify", "-q", `refs/heads/${branch}`], { encoding: "utf8", env: opts.env }).trim();
    } catch {
      return undefined;
    }
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = undefined;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      const path = new URL(req.url ?? "/", "http://x").pathname;
      seen.push({ method: req.method ?? "GET", path, authorization: req.headers.authorization, userAgent: req.headers["user-agent"], body });
      const send = (status: number, json?: unknown): void => {
        res.writeHead(status, json === undefined ? {} : { "content-type": "application/json" }).end(json === undefined ? undefined : JSON.stringify(json));
      };
      if (!req.headers["user-agent"]) return send(403, { message: "Request forbidden by administrative rules. Please make sure your request has a User-Agent header." });
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
      if (bearer === undefined || !opts.tokens.has(bearer)) return send(401, { message: "Bad credentials" });
      if (req.method === "DELETE" && path === "/installation/token") {
        opts.tokens.delete(bearer);
        return send(204);
      }
      const ref = new RegExp(`^/repos/${opts.repo}/git/ref/heads/(.+)$`, "i").exec(path)?.[1];
      if (req.method === "GET" && ref !== undefined) {
        const sha = head(decodeURIComponent(ref));
        return sha === undefined ? send(404, { message: "Not Found" }) : send(200, { ref: `refs/heads/${ref}`, object: { type: "commit", sha } });
      }
      if (req.method === "POST" && path.toLowerCase() === `/repos/${opts.repo}/pulls`.toLowerCase()) {
        if (failNext !== undefined) {
          const status = failNext;
          failNext = undefined;
          return send(status, { message: "Validation Failed" });
        }
        const b = body as { title?: string; body?: string; head?: string; base?: string };
        if (typeof b?.head !== "string" || head(b.head) === undefined) return send(422, { message: "Validation Failed", errors: [{ resource: "PullRequest", field: "head", code: "invalid" }] });
        pulls.push({ title: String(b.title), body: String(b.body), head: b.head, base: String(b.base) });
        return send(201, { number: pulls.length + 8, html_url: `https://github.com/${opts.repo}/pull/${pulls.length + 8}` });
      }
      return send(404, { message: "Not Found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    pulls,
    failNextPull: (status) => {
      failNext = status;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
