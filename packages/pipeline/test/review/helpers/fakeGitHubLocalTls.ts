import https from "node:https";
import type { LookupFunction } from "node:net";
import type { GithubClient, GithubRequest, GithubResponse } from "@fx/runner-cloud";
import { startStrictGithubServer, type LocalTlsServer } from "../../../../github/test/helpers/localTlsServer.js";
import { fakeGitHubLocal, type LocalFake, type QueueState } from "./fakeGitHubLocal.js";
import type { FakeRepoState } from "./fakeGitHubRest.js";

/**
 * D#519 MQ4-e2-c3: `fakeGitHubLocal` with its inner client moved behind Node's REAL TLS path. The real `localOnlyGithub` wrapper still sits in front, and the strict inner rules
 * (the A1 to A10 allowlist, the fixed GraphQL documents byte for byte, paged answers of 100 with cursors in GitHub's upper-case enums) are unchanged; what is added is a real
 * HTTPS hop: a self-signed certificate checked by the client against the SNI name, a custom `lookup` called with `{ all: true }`, and the shared strict rules of
 * `checkGithubRequest` on the raw request (User-Agent required, Accept, API version, JSON bodies). The client sends the headers the wrapper gives it (Accept) and adds the
 * production client's own (User-Agent, API version, bearer), so a request that lacks any of them is answered 403 or 415 and fails the test.
 * What it cannot fake faithfully: GitHub's schema accepting the CommitChecks document as written (a live run is the first check), rate limits, exact error wording.
 */
export interface LocalTlsFake extends LocalFake {
  server: LocalTlsServer;
  close(): Promise<void>;
}

export async function fakeGitHubLocalTls(s: FakeRepoState & { runBranch?: string }, opts: { exclude?: readonly string[]; queue?: QueueState } = {}): Promise<LocalTlsFake> {
  let inner: GithubClient | undefined;
  const server = await startStrictGithubServer(async (req) => {
    const query: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(req.query ?? "")) query[k] = v;
    const headers: Record<string, string> = {};
    if (req.headers["accept"] !== undefined) headers["Accept"] = req.headers["accept"];
    let out: GithubResponse;
    try {
      out = await inner!.request({ method: req.method, path: req.path, ...(Object.keys(query).length > 0 ? { query } : {}), headers, ...(req.body === "" ? {} : { body: JSON.parse(req.body) as unknown }) });
    } catch {
      // fx-swallow-ok: the inner fake already counted a refusal in `denied`; the client sees a plain 500
      return { status: 500, headers: { "content-type": "application/json" }, body: "{}" };
    }
    return { status: out.status, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(out.body) };
  });
  const lookup = ((_host: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => (o.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4))) as unknown as LookupFunction;
  const client: GithubClient = {
    request(req: GithubRequest): Promise<GithubResponse> {
      const url = new URL(`https://api.github.com${req.path}`);
      for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, String(v));
      const payload = req.body === undefined ? undefined : JSON.stringify(req.body);
      const headers: Record<string, string> = {
        ...Object.fromEntries(Object.entries(req.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
        authorization: "Bearer installation-token-for-test", // gitleaks:allow
        "x-github-api-version": "2022-11-28",
        "user-agent": "fulcrumaxe-cloud",
        ...(payload === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) }),
      };
      return new Promise((resolve, reject) => {
        const r = https.request({ host: url.hostname, port: server.port, method: req.method, path: `${url.pathname}${url.search}`, headers, ca: server.ca, servername: url.hostname, lookup }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed: unknown = null;
            try {
              parsed = text ? JSON.parse(text) : null;
            } catch {
              // fx-swallow-ok: a body that is not JSON reads as no body; the status still decides
              parsed = null;
            }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
        });
        r.on("error", reject);
        r.end(payload);
      });
    },
  };
  const fake = fakeGitHubLocal(s, { ...opts, transport: (i) => ((inner = i), client) });
  return { ...fake, server, close: () => server.close() };
}
