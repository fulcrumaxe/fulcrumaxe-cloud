import http from "node:http";
import type { AddressInfo } from "node:net";
import { createInstallationHttp, InstallationTokenCache, type AccessTokenRequester } from "@fx/github";
import { generateKeyPairSync } from "node:crypto";
import { createRunPullRequestPort, type GithubRequest, type RunPullRequestPort } from "@fx/runner-cloud";
import { checkGithubRequest } from "../../../../github/test/helpers/strictGithub.js";
import type { FakeGithub } from "../../../../runner-cloud/test/helpers/githubFake.js";

/**
 * D#6 R4d-6: a GitHub API server for the end-to-end runner test, on a loopback port, reached by the cloud through Node's real `fetch` (the same HTTP client the
 * production installation client uses), not through a stubbed function.
 *
 * Every request goes through two layers before it is answered, so a client that breaks a rule gets what GitHub would answer:
 *  1. `checkGithubRequest` (packages/github/test/helpers/strictGithub.ts), applied to the raw request: a request with no User-Agent is a 403 with GitHub's
 *     plain-text body, an Accept or API version it does not know is refused, a body that is not JSON is a 400;
 *  2. the strict fake of the pull-request calls (packages/runner-cloud/test/helpers/githubFake.ts), which allows only the allowlisted calls with their exact bodies,
 *     pages the changed-files listing 100 to a page, reports a rename as `RENAMED`, refuses a pull request on a branch that does not exist with a 422, and so on.
 * What the strict fake would throw for (a call outside the allowlist, a malformed body) is answered 500 and kept in `violations`, which a test must find empty.
 *
 * What it cannot fake faithfully: it speaks plain HTTP on a loopback address, not TLS to api.github.com (the cloud's client rewrites the host, see `rewritingFetch`),
 * and GitHub's rate limits and exact wording of errors.
 */
export interface GithubServer {
  origin: string;
  /** Every request received, as the server saw it (header names lower-cased). */
  seen: Array<{ method: string; path: string; query: string; headers: Record<string, string>; body: string }>;
  /** What the strict fake refused by throwing: a call or a body the cloud must never send. */
  violations: string[];
  close: () => Promise<void>;
}

/** `fake` is asked for on every request, so a test can replace the repository's state between scenarios. */
export async function startGithubServer(fake: () => FakeGithub): Promise<GithubServer> {
  const seen: GithubServer["seen"] = [];
  const violations: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : v;
        const url = new URL(req.url ?? "/", "http://localhost");
        const body = Buffer.concat(chunks).toString("utf8");
        const method = req.method ?? "GET";
        seen.push({ method, path: url.pathname, query: url.search.slice(1), headers, body });
        const send = (status: number, replyHeaders: Record<string, string>, text: string): void => {
          res.writeHead(status, replyHeaders);
          res.end(text);
        };
        const refused = checkGithubRequest({ method, path: url.pathname, ...(url.search === "" ? {} : { query: url.search.slice(1) }), headers, body });
        if (refused) return send(refused.status, refused.headers, refused.body);
        const query: Record<string, string> = {};
        for (const [k, v] of url.searchParams) query[k] = v;
        const request: GithubRequest = { method, path: url.pathname, query, headers, ...(body === "" ? {} : { body: JSON.parse(body) as unknown }) };
        try {
          const reply = await fake().request(request);
          send(reply.status, { "content-type": "application/json; charset=utf-8" }, JSON.stringify(reply.body));
        } catch (error) {
          violations.push(error instanceof Error ? error.message : String(error));
          send(500, { "content-type": "application/json; charset=utf-8" }, JSON.stringify({ message: "strict fake refused the call" }));
        }
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    violations,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The global `fetch` with `https://api.github.com` rewritten to the server's loopback origin: the only change to what the production client sends. */
export function rewritingFetch(origin: string): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== "https://api.github.com") throw new Error(`the harness reaches GitHub only at api.github.com, not ${url.origin}`);
    return fetch(`${origin}${url.pathname}${url.search}`, init);
  }) as typeof fetch;
}

/**
 * The cloud's pull-request port as apps/web builds it (apps/web/lib/github/runnerPullRequest.ts, `createAppRunPullRequestPort`), over the REAL installation
 * client (`createInstallationHttp`: its path allowlist, headers, redirect and timeout rules) and the real token cache, with only the token request and the host
 * replaced. The 10-line adapter between the two is copied from apps/web, which this package cannot import.
 */
export function createHarnessPullRequestPort(input: { github: GithubServer; appLogin: string }): RunPullRequestPort {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const requester: AccessTokenRequester = async () => ({ token: "ghs_harness_token", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  const open = createInstallationHttp({
    resolveInstallation: async () => ({ installationId: 9, appKind: "team" }),
    appCredentials: () => ({ appId: "app-1", privateKeyPem: privateKey as unknown as string, webhookSecret: "unused" }),
    requester,
    cache: new InstallationTokenCache(),
    fetchImpl: rewritingFetch(input.github.origin),
  });
  return createRunPullRequestPort({
    appLogin: async () => input.appLogin,
    async open(repo) {
      const http = await open("runner_pr", { repoId: repo.id, owner: repo.owner, name: repo.name });
      return {
        request(req: GithubRequest) {
          if (!["GET", "POST", "PATCH"].includes(req.method)) return Promise.reject(new Error("method_refused"));
          return http.request({ method: req.method as "GET" | "POST" | "PATCH", path: req.path, ...(req.query === undefined ? {} : { query: req.query }), ...(req.body === undefined ? {} : { body: req.body }) });
        },
      };
    },
  });
}
