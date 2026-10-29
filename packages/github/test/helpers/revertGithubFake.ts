import https from "node:https";
import { REVERT_PR_DOCUMENT } from "../../src/revertPr.js";
import { startStrictGithubServer, type LocalTlsServer } from "./localTlsServer.js";
import { ghError, FETCH_DEFAULT_USER_AGENT, type GhReply, type GhRequest } from "./strictGithub.js";

/**
 * A fake of the slice of GitHub the revert write touches: `GET /repos/:o/:r/pulls/:n` and `POST /graphql` with the revert mutation. It runs as a real HTTPS server
 * behind `startStrictGithubServer` (User-Agent, Accept, API version, Authorization and JSON-body rules) and applies the GraphQL rules this code touches:
 *   - `/graphql` needs a bearer token (401 without one) and a JSON body with a string `query` and an object `variables` (else 400);
 *   - every GraphQL failure is HTTP 200 with an `errors` array and `data: null` (unknown document, invalid variable, unmerged pull request, unknown node id, conflict).
 * What it cannot fake: GitHub's merge-base computation (a conflict is declared by the test), rate limits, and the exact wording of errors (the code under test
 * never reads it).
 */
export interface FakePull {
  number: number;
  nodeId: string;
  merged: boolean;
  conflicts?: boolean;
}

export interface RevertFake {
  server: LocalTlsServer;
  requests: GhRequest[];
  mutations: Array<Record<string, unknown>>;
  fetchImpl: typeof fetch;
  override: { reply?: GhReply };
  state: { revoked: number };
  close: () => Promise<void>;
}

const jsonReply = (status: number, body: unknown): GhReply => ({ status, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body) });
const gqlError = (type: string, message: string): GhReply => jsonReply(200, { data: null, errors: [{ type, message }] });

export async function startRevertFake(owner: string, name: string, pulls: FakePull[]): Promise<RevertFake> {
  const requests: GhRequest[] = [];
  const mutations: Array<Record<string, unknown>> = [];
  const override: RevertFake["override"] = {};
  let next = 900;
  const state = { revoked: 0 };
  const server = await startStrictGithubServer((req) => {
    if (req.method === "DELETE" && req.path === "/installation/token") {
      state.revoked += 1;
      return { status: 204, headers: {}, body: "" };
    }
    requests.push(req);
    const pull = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/.exec(req.path);
    if (req.method === "GET" && pull) {
      const found = pull[1] === owner && pull[2] === name ? pulls.find((p) => p.number === Number(pull[3])) : undefined;
      return found ? jsonReply(200, { number: found.number, node_id: found.nodeId, merged: found.merged, state: found.merged ? "closed" : "open" }) : ghError(404, "Not Found");
    }
    if (req.method === "POST" && req.path === "/graphql") {
      if (!/^Bearer \S+$/.test(req.headers["authorization"] ?? "")) return ghError(401, "Bad credentials");
      let parsed: unknown;
      try {
        parsed = JSON.parse(req.body);
      } catch {
        return ghError(400, "Problems parsing JSON");
      }
      const b = parsed as { query?: unknown; variables?: unknown } | null;
      if (b === null || typeof b !== "object" || typeof b.query !== "string" || (b.variables !== undefined && (typeof b.variables !== "object" || b.variables === null))) return ghError(400, "Problems parsing JSON");
      if (b.query !== REVERT_PR_DOCUMENT) return gqlError("undefinedField", "Field is not defined");
      const v = (b.variables ?? {}) as Record<string, unknown>;
      if (typeof v["pullRequestId"] !== "string") return gqlError("INVALID_VARIABLE", "Variable $pullRequestId of type ID! was provided invalid value");
      if (typeof v["draft"] !== "boolean") return gqlError("INVALID_VARIABLE", "Variable $draft of type Boolean! was provided invalid value");
      if (typeof v["title"] !== "string" || typeof v["body"] !== "string") return gqlError("INVALID_VARIABLE", "Variable of type String! was provided invalid value");
      if (override.reply) {
        const r = override.reply;
        delete override.reply;
        return r;
      }
      const target = pulls.find((p) => p.nodeId === v["pullRequestId"]);
      if (!target) return gqlError("NOT_FOUND", "Could not resolve to a node");
      if (!target.merged) return gqlError("UNPROCESSABLE", "Pull request is not merged");
      if (target.conflicts) return gqlError("UNPROCESSABLE", "Pull request could not be reverted");
      mutations.push(v);
      next += 1;
      return jsonReply(200, { data: { revertPullRequest: { revertPullRequest: { number: next, url: `https://github.com/${owner}/${name}/pull/${next}` } } } });
    }
    return ghError(404, "Not Found");
  });
  /** `fetch` over real TLS to the fake. Node's fetch adds `user-agent: node`, so this does too. */
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== "api.github.com") throw new Error(`unexpected target ${url.origin}`);
    const headers: Record<string, string> = { "user-agent": FETCH_DEFAULT_USER_AGENT };
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    return await new Promise<Response>((resolve, reject) => {
      const req = https.request(
        {
          host: "api.github.com",
          port: server.port,
          method: init?.method ?? "GET",
          path: `${url.pathname}${url.search}`,
          headers,
          ca: server.ca,
          servername: "api.github.com",
          lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => (o?.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4))) as never,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve(new Response(res.statusCode === 204 ? null : Buffer.concat(chunks), { status: res.statusCode ?? 0 })));
        },
      );
      req.on("error", reject);
      req.end(typeof init?.body === "string" ? init.body : undefined);
    });
  }) as typeof fetch;
  return { server, requests, mutations, fetchImpl, override, state, close: () => server.close() };
}
