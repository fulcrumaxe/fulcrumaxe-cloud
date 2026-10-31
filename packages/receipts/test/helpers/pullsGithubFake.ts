import https from "node:https";
import { startStrictGithubServer, type LocalTlsServer } from "../../../github/test/helpers/localTlsServer.js";
import { ghError, FETCH_DEFAULT_USER_AGENT, type GhReply, type GhRequest } from "../../../github/test/helpers/strictGithub.js";

/**
 * A fake of the slice of GitHub the re-run close touches: `GET /repos/:o/:r/pulls` filtered by `head` (and `state`), and `PATCH /repos/:o/:r/pulls/:n`
 * with `{ state: "closed" }`. It runs as a real HTTPS server behind `startStrictGithubServer` (User-Agent, Accept, API version, Authorization and
 * JSON-body rules), and like GitHub it needs a token on both routes, answers 404 for a pull request it does not have, and 422 for a body it does not
 * accept. It records every request, so a test can show that no branch was deleted and no ref was written.
 * What it cannot fake: GitHub's own ordering when a head moves between the list and the close, rate limits, and the wording of errors.
 */
export interface FakePr {
  number: number;
  ref: string;
  sha: string;
  state: "open" | "closed";
  /** The head repository's full name; defaults to the repository served. */
  headRepo?: string;
}

export interface PullsFake {
  server: LocalTlsServer;
  requests: GhRequest[];
  pulls: FakePr[];
  fetchImpl: typeof fetch;
  /** `reply`: the next request's answer. `patch`: the next close's answer. */
  override: { reply?: GhReply; patch?: GhReply };
  /**
   * The branches of the repository (name to head sha) and the ones GitHub must keep: a ref update or a delete on a protected one is answered 422 and recorded in `refused`.
   * `push` models a push of a commit that is new work (not a descendant of anything on the remote): a new name is created, an existing name is a non-fast-forward and is refused
   * (recorded), forced or not, because GitHub's contract refuses a rewrite of a protected ref and our sandboxes never rewrite one.
   */
  refs: Map<string, string>;
  protectedRefs: Set<string>;
  refused: string[];
  push: (branch: string, sha: string, o?: { force?: boolean }) => "ok" | "non_fast_forward";
  close: () => Promise<void>;
}

const jsonReply = (status: number, body: unknown): GhReply => ({ status, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body) });

export async function startPullsFake(owner: string, name: string, pulls: FakePr[]): Promise<PullsFake> {
  const requests: GhRequest[] = [];
  const override: PullsFake["override"] = {};
  const refs = new Map<string, string>();
  const protectedRefs = new Set<string>();
  const refused: string[] = [];
  const full = `${owner}/${name}`;
  const shape = (p: FakePr) => ({ number: p.number, state: p.state, head: { ref: p.ref, sha: p.sha, repo: { full_name: p.headRepo ?? full } }, base: { ref: "main" } });
  const server = await startStrictGithubServer((req) => {
    if (req.method === "DELETE" && req.path === "/installation/token") return { status: 204, headers: {}, body: "" };
    requests.push(req);
    if (!/^(Bearer|token) \S+$/.test(req.headers["authorization"] ?? "")) return ghError(401, "Requires authentication");
    if (override.reply) {
      const r = override.reply;
      delete override.reply;
      return r;
    }
    if (req.method === "GET" && req.path === `/repos/${full}/pulls`) {
      const q = new URLSearchParams(req.query ?? "");
      const head = q.get("head");
      const state = q.get("state") ?? "open";
      const hits = pulls.filter((p) => (head === null || `${owner}:${p.ref}` === head) && (state === "all" || p.state === state));
      return jsonReply(200, hits.map(shape));
    }
    const ref = new RegExp(`^/repos/${full}/git/refs/heads/(.+)$`).exec(req.path);
    if (ref && (req.method === "PATCH" || req.method === "DELETE")) {
      const branch = decodeURIComponent(ref[1]!);
      if (protectedRefs.has(branch)) {
        refused.push(`${req.method} ${branch}`);
        return ghError(422, "Update is not a fast forward");
      }
      if (!refs.has(branch)) return ghError(404, "Not Found");
      if (req.method === "DELETE") refs.delete(branch);
      else refs.set(branch, String((JSON.parse(req.body) as Record<string, unknown>)["sha"]));
      return { status: req.method === "DELETE" ? 204 : 200, headers: {}, body: "" };
    }
    const patch = new RegExp(`^/repos/${full}/pulls/(\\d+)$`).exec(req.path);
    if (req.method === "PATCH" && patch) {
      if (override.patch) {
        const r = override.patch;
        delete override.patch;
        return r;
      }
      const p = pulls.find((x) => x.number === Number(patch[1]));
      if (!p) return ghError(404, "Not Found");
      const body = JSON.parse(req.body) as Record<string, unknown>;
      if (body["state"] !== "closed" && body["state"] !== "open") return ghError(422, "Validation Failed");
      p.state = body["state"];
      return jsonReply(200, shape(p));
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
  const push = (branch: string, sha: string, o: { force?: boolean } = {}): "ok" | "non_fast_forward" => {
    if (refs.has(branch)) {
      refused.push(`${o.force ? "FORCE " : ""}push ${branch}`);
      return "non_fast_forward";
    }
    refs.set(branch, sha);
    return "ok";
  };
  return { server, requests, pulls, fetchImpl, override, refs, protectedRefs, refused, push, close: () => server.close() };
}
