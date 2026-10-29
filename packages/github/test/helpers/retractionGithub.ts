import type { AccessTokenRequester } from "../../src/installationToken.js";
import { ghError, type GhReply, type GhRequest } from "./strictGithub.js";

/**
 * A strict stand-in for the GitHub surfaces a retraction writes to, to be served behind `startStrictGithubServer` (User-Agent, Accept, API version, bearer
 * form and JSON body rules are applied there, on the raw request). On top of that it enforces what the real service does that our code touches:
 *  - the installation access-token mint refuses a permission the installation does not hold with 422 "The permissions requested are not granted to this
 *    installation." (the live answer), so a Discussion write is refused at mint time while the installation holds `discussions: read` only;
 *  - every REST and GraphQL call needs a bearer token this fake minted; a token without the write permission the route needs is refused (REST: 403 "Resource not
 *    accessible by integration"; GraphQL: HTTP 200 with a FORBIDDEN error, which is how GraphQL reports it);
 *  - releases: `GET` and `PATCH /releases/<id>` (404 when unknown, `body` a string); comments: `POST /issues/<n>/comments` answers 201 with `html_url`.
 * What it cannot fake faithfully: GitHub's rate limits, abuse detection, the exact wording of every error, and which node ids exist outside the ones given.
 */
export interface RetractionFakeOptions {
  /** The permissions the installation holds (the mint refuses more than this). */
  installation: Readonly<Record<string, "read" | "write">>;
  releases?: Readonly<Record<number, string>>;
  issues?: readonly number[];
  discussions?: readonly string[];
}

export interface RetractionFake {
  requester: AccessTokenRequester;
  route: (req: GhRequest) => GhReply;
  state: { mintAsked: Array<Record<string, string>>; graphqlMutations: number; writes: number; revoked: string[]; comments: Array<{ target: string; body: string }>; releases: Record<number, string>; installation: Record<string, "read" | "write">; dropFromToken: string[] };
}

const json = (status: number, body: unknown): GhReply => ({ status, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body) });
const REST_FORBIDDEN = (): GhReply => ghError(403, "Resource not accessible by integration");

export function makeRetractionFake(opts: RetractionFakeOptions): RetractionFake {
  const tokens = new Map<string, Record<string, string>>();
  const state: RetractionFake["state"] = { mintAsked: [], graphqlMutations: 0, writes: 0, revoked: [], comments: [], releases: { ...(opts.releases ?? {}) }, installation: { ...opts.installation }, dropFromToken: [] };
  const holds = (token: string, key: string): boolean => tokens.get(token)?.[key] === "write";

  const requester: AccessTokenRequester = async (p) => {
    const asked = Object.fromEntries(Object.entries(p.permissions)) as Record<string, string>;
    state.mintAsked.push(asked);
    for (const [k, level] of Object.entries(asked)) {
      const have = state.installation[k];
      if (have === undefined || (level === "write" && have !== "write")) throw Object.assign(new Error("mint refused"), { status: 422, ghMessage: "The permissions requested are not granted to this installation" });
    }
    const token = `ghs_retract${tokens.size + 1}`;
    // `dropFromToken` models an installation that lost a permission after the mint answered: GitHub then refuses the call, not the mint.
    tokens.set(token, Object.fromEntries(Object.entries(asked).filter(([k]) => !state.dropFromToken.includes(k))));
    return { token, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), permissions: { metadata: "read", ...asked }, repositories: [...(p.repositories ?? [])] };
  };

  const route = (req: GhRequest): GhReply => {
    const bearer = /^bearer (\S+)$/i.exec(req.headers["authorization"] ?? "")?.[1] ?? "";
    if (req.method === "DELETE" && req.path === "/installation/token") {
      state.revoked.push(bearer);
      return { status: 204, headers: {}, body: "" };
    }
    if (!tokens.has(bearer)) return ghError(401, "Bad credentials");

    if (req.path === "/graphql") {
      if (req.method !== "POST") return ghError(404, "Not Found");
      let doc: unknown;
      try {
        doc = JSON.parse(req.body);
      } catch {
        return ghError(400, "Problems parsing JSON");
      }
      const d = doc as { query?: unknown; variables?: unknown };
      if (typeof doc !== "object" || doc === null || typeof d.query !== "string" || (d.variables !== undefined && (typeof d.variables !== "object" || d.variables === null || Array.isArray(d.variables)))) return ghError(400, "Problems parsing JSON");
      if (!/^mutation \w+\(\$discussionId: ID!, \$body: String!\) \{ addDiscussionComment\(input: \{discussionId: \$discussionId, body: \$body\}\) \{ comment \{ url \} \} \}$/.test(d.query)) {
        return json(200, { data: null, errors: [{ type: "PARSE_ERROR", message: "Parse error" }] });
      }
      state.graphqlMutations += 1;
      const v = d.variables as { discussionId?: unknown; body?: unknown } | undefined;
      if (!holds(bearer, "discussions")) return json(200, { data: { addDiscussionComment: null }, errors: [{ type: "FORBIDDEN", path: ["addDiscussionComment"], message: "Resource not accessible by integration" }] });
      if (typeof v?.discussionId !== "string" || !(opts.discussions ?? []).includes(v.discussionId)) return json(200, { data: { addDiscussionComment: null }, errors: [{ type: "NOT_FOUND", path: ["addDiscussionComment"], message: "Could not resolve to a node with the global id" }] });
      state.writes += 1;
      state.comments.push({ target: v.discussionId, body: String(v.body) });
      return json(200, { data: { addDiscussionComment: { comment: { url: `https://github.com/acme/widgets/discussions/1#discussioncomment-${state.writes}` } } } });
    }

    const release = /^\/repos\/acme\/widgets\/releases\/(\d+)$/.exec(req.path);
    if (release) {
      const id = Number(release[1]);
      if (!(id in state.releases)) return ghError(404, "Not Found");
      if (req.method === "GET") return json(200, { id, body: state.releases[id], html_url: `https://github.com/acme/widgets/releases/tag/v${id}` });
      if (req.method === "PATCH") {
        if (!holds(bearer, "contents")) return REST_FORBIDDEN();
        const b = JSON.parse(req.body) as { body?: unknown };
        if (typeof b.body !== "string") return ghError(422, "Validation Failed");
        state.writes += 1;
        state.releases[id] = b.body;
        return json(200, { id, body: b.body, html_url: `https://github.com/acme/widgets/releases/tag/v${id}` });
      }
    }
    const comment = /^\/repos\/acme\/widgets\/issues\/(\d+)\/comments$/.exec(req.path);
    if (comment && req.method === "POST") {
      if (!holds(bearer, "issues")) return REST_FORBIDDEN();
      if (!(opts.issues ?? []).includes(Number(comment[1]))) return ghError(404, "Not Found");
      const b = JSON.parse(req.body) as { body?: unknown };
      if (typeof b.body !== "string" || b.body === "") return ghError(422, "Validation Failed");
      state.writes += 1;
      state.comments.push({ target: `issue:${comment[1]}`, body: b.body });
      return json(201, { id: state.writes, html_url: `https://github.com/acme/widgets/issues/${comment[1]}#issuecomment-${state.writes}` });
    }
    return ghError(404, "Not Found");
  };

  return { requester, route, state };
}
