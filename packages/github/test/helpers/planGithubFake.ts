import https from "node:https";
import type { AccessTokenRequester } from "../../src/installationToken.js";
import { ghError, type GhReply, type GhRequest } from "./strictGithub.js";
import { startStrictGithubServer, type LocalTlsServer } from "./localTlsServer.js";

/**
 * A fake of the GitHub behaviours the plan import touches, served over real TLS on 127.0.0.1 (the server certificate is
 * for api.github.com and the client is given it as its own `ca`; nothing is added on the client's behalf, so a missing
 * User-Agent is really missing). The generic rules (User-Agent, Accept, API version, Authorization forms, App JWT, JSON
 * body) come from `checkGithubRequest`; this file adds what is specific to these routes:
 *
 *   - POST /app/installations/{id}/access_tokens: 422 when the request asks for a permission the installation does not
 *     hold (or a stronger level), 404 for an unknown installation, 201 with `token`, `expires_at` and the `permissions`
 *     object otherwise (a fault switch makes the reply say `write`, to test the read-only check);
 *   - the token GitHub issued is the only credential accepted on the repo routes, and it must hold the permission the
 *     route needs, else 403 "Resource not accessible by integration" (as an installation token without it gets);
 *   - GET /repos/{o}/{n}/contents/{path}: raw media type answers the bytes, the JSON media type answers metadata, a missing
 *     file is a JSON 404;
 *   - GET /repos/{o}/{n}/issues: the list holds issues AND pull requests (a pull request carries a `pull_request` key with
 *     `merged_at`), per_page is cut at 100, and a `Link` header with rel="next" and rel="last" is sent while pages remain;
 *   - POST /graphql: `Authorization: Bearer` only, JSON body; a failure is HTTP 200 with an `errors` array. A repository the
 *     token cannot see is `data.repository: null` plus a NOT_FOUND error. The rate limit answers are the primary one
 *     (403 with x-ratelimit-remaining: 0), the secondary one (403 with retry-after) and the GraphQL RATE_LIMITED type.
 *
 * What it cannot fake faithfully (it goes in the live evidence instead): whether an issues-only token sees
 * `pull_request.merged_at` and bodies on the issues list, and the real GraphQL point costs.
 */
export interface FakeItem {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  login?: string;
  /** Present for a pull request. `merged_at` null means not merged. */
  pull?: { merged_at: string | null };
  labels?: string[];
}

export interface FakeDiscussion {
  number: number;
  title: string;
  body: string;
  closed: boolean;
  /** The Discussion's author (default `someone`). */
  login?: string;
  /** `isMinimized` is true for a comment a maintainer hid (spam, off-topic and so on); default false. */
  comments: Array<{ databaseId: number; body: string; login: string; isMinimized?: boolean }>;
}

export interface FakeGithubState {
  owner: string;
  name: string;
  installationId: number;
  defaultBranch: string;
  headSha: string;
  discussionsEnabled: boolean;
  /** Files at the head commit. */
  files: Map<string, string>;
  items: FakeItem[];
  discussions: FakeDiscussion[];
  /** Repository roles by login. A login that is not here is not a user: the permission route answers 404. */
  collaborators: Record<string, "admin" | "maintain" | "write" | "triage" | "read" | "none">;
  /** What the installation holds. A mint asking for more is a 422. */
  installPermissions: Record<string, "read" | "write">;
  /** How long a minted token lives (default one hour, as GitHub). */
  tokenTtlMs?: number;
  faults: {
    /** The mint reply claims this permission map instead of what was requested. */
    mintReplyPermissions?: Record<string, string>;
    /** The mint reply leaves `permissions` out. */
    mintReplyWithoutPermissions?: boolean;
    primaryRateLimit?: boolean;
    secondaryRateLimit?: boolean;
    graphqlRateLimited?: boolean;
    /** GraphQL answers 200 with an errors array of this type and data.repository null. */
    graphqlRepositoryNull?: boolean;
    /** GraphQL answers 200 with VALID data and also an errors array of an unrelated type (a partial failure). */
    graphqlOtherError?: boolean;
    /** GraphQL answers 200 with `data.repository: null` and NO errors array (it should not, but a reader must not treat it as an empty repository). */
    graphqlNullWithoutErrors?: boolean;
    /** The issues list answers this status. */
    issuesStatus?: number;
    /** Every contents read answers this status. */
    contentsStatus?: number;
    /** The default branch is missing from the GraphQL answer. */
    noDefaultBranch?: boolean;
    /** The comments answer leaves `isMinimized` out of every node. */
    commentsWithoutIsMinimized?: boolean;
  };
}

export function newFakeState(over: Partial<FakeGithubState> = {}): FakeGithubState {
  return {
    owner: "acme",
    name: "widgets",
    installationId: 777,
    defaultBranch: "main",
    headSha: "a".repeat(40),
    discussionsEnabled: true,
    files: new Map(),
    items: [],
    discussions: [],
    collaborators: {},
    installPermissions: { metadata: "read", contents: "read", issues: "read", pull_requests: "read", discussions: "read" },
    faults: {},
    ...over,
  };
}

const LEVEL = { read: 1, write: 2 } as const;

export interface PlanGithub {
  server: LocalTlsServer;
  state: FakeGithubState;
  /** A `fetch` that speaks real TLS to the fake: certificate and hostname are checked against the server's own certificate. */
  fetch: typeof fetch;
  /** The mint call over the same TLS connection path, shaped like the production requester. */
  requester: AccessTokenRequester;
  /** Mints issued so far. */
  mints: Array<{ installationId: number; body: Record<string, unknown>; token: string }>;
  close: () => Promise<void>;
}

const jsonReply = (status: number, body: unknown, headers: Record<string, string> = {}): GhReply => ({
  status,
  headers: { "content-type": "application/json; charset=utf-8", ...headers },
  body: JSON.stringify(body),
});

export async function startPlanGithub(state: FakeGithubState): Promise<PlanGithub> {
  const issued = new Map<string, { permissions: Record<string, string>; expiresAtMs: number }>();
  const mints: PlanGithub["mints"] = [];
  let tokenCounter = 0;
  const repoBase = `/repos/${state.owner}/${state.name}`;

  function pageOf(req: GhRequest, query: URLSearchParams, all: unknown[]): { items: unknown[]; link: string | null } {
    const perPage = Math.min(100, Math.max(1, Number(query.get("per_page") ?? 30) || 30));
    const page = Math.max(1, Number(query.get("page") ?? 1) || 1);
    const last = Math.max(1, Math.ceil(all.length / perPage));
    const mk = (n: number, rel: string) => {
      const q = new URLSearchParams(query);
      q.set("page", String(n));
      return `<https://api.github.com${req.path}?${q.toString()}>; rel="${rel}"`;
    };
    return { items: all.slice((page - 1) * perPage, page * perPage), link: page < last ? `${mk(page + 1, "next")}, ${mk(last, "last")}` : null };
  }

  function credential(req: GhRequest): { token: string; permissions: Record<string, string> } | GhReply {
    const m = /^(?:bearer|token) (\S+)$/i.exec(req.headers["authorization"] ?? "");
    const rec = m ? issued.get(m[1]!) : undefined;
    if (!m || !rec || rec.expiresAtMs <= Date.now()) return ghError(401, "Bad credentials");
    return { token: m[1]!, permissions: rec.permissions };
  }
  const needs = (perms: Record<string, string>, key: string): GhReply | null =>
    perms[key] ? null : ghError(403, "Resource not accessible by integration");

  function rateLimited(): GhReply | null {
    if (state.faults.primaryRateLimit) {
      return jsonReply(403, { message: "API rate limit exceeded for installation ID 777.", documentation_url: "https://docs.github.com/rest/overview/rate-limits-for-the-rest-api", status: "403" }, { "x-ratelimit-remaining": "0", "x-ratelimit-limit": "5000", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 600) });
    }
    if (state.faults.secondaryRateLimit) {
      return jsonReply(403, { message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.", documentation_url: "https://docs.github.com/rest/overview/rate-limits-for-the-rest-api#about-secondary-rate-limits", status: "403" }, { "retry-after": "60", "x-ratelimit-remaining": "4000" });
    }
    return null;
  }

  function itemJson(i: FakeItem): Record<string, unknown> {
    return {
      number: i.number,
      title: i.title,
      body: i.body,
      state: i.state,
      user: { login: i.login ?? "someone" },
      author_association: "MEMBER",
      labels: (i.labels ?? []).map((name) => ({ name })),
      ...(i.pull ? { pull_request: { url: `https://api.github.com${repoBase}/pulls/${i.number}`, html_url: `https://github.com/${state.owner}/${state.name}/pull/${i.number}`, merged_at: i.pull.merged_at } } : {}),
    };
  }

  function graphql(req: GhRequest, perms: Record<string, string>): GhReply {
    if (!/^bearer /i.test(req.headers["authorization"] ?? "")) return ghError(401, "This endpoint requires you to be authenticated.");
    if (req.method !== "POST") return ghError(404, "Not Found");
    let parsed: { query?: unknown; variables?: Record<string, unknown> };
    try {
      parsed = JSON.parse(req.body) as typeof parsed;
    } catch {
      return ghError(400, "Problems parsing JSON");
    }
    const q = typeof parsed.query === "string" ? parsed.query : "";
    const vars = parsed.variables ?? {};
    if (state.faults.graphqlNullWithoutErrors) return jsonReply(200, { data: { repository: null } });
    if (state.faults.graphqlRateLimited) {
      return jsonReply(200, { data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded for installation ID 777." }] });
    }
    if (vars.owner !== state.owner || vars.name !== state.name || state.faults.graphqlRepositoryNull) {
      return jsonReply(200, { data: { repository: null }, errors: [{ type: "NOT_FOUND", path: ["repository"], locations: [{ line: 2, column: 3 }], message: `Could not resolve to a Repository with the name '${String(vars.owner)}/${String(vars.name)}'.` }] });
    }
    const op = /^\s*query\s+(\w+)/.exec(q)?.[1];
    if (state.faults.graphqlOtherError) {
      return jsonReply(200, { data: { repository: { hasDiscussionsEnabled: true, defaultBranchRef: { name: state.defaultBranch, target: { oid: state.headSha } } } }, errors: [{ type: "INTERNAL", message: "Something went wrong while executing your query." }] });
    }
    if (op === "PlanRepoHead") {
      return jsonReply(200, {
        data: {
          repository: {
            hasDiscussionsEnabled: state.discussionsEnabled,
            defaultBranchRef: state.faults.noDefaultBranch ? null : { name: state.defaultBranch, target: { oid: state.headSha } },
          },
        },
      });
    }
    if (!perms["discussions"]) {
      return jsonReply(200, { data: { repository: null }, errors: [{ type: "NOT_FOUND", path: ["repository"], message: "Could not resolve to a Repository with the name 'acme/widgets'." }] });
    }
    if (op === "PlanDiscussions") {
      const first = Math.min(100, Number(vars.first ?? 30));
      const start = typeof vars.after === "string" ? Number(Buffer.from(vars.after, "base64").toString("utf8")) : 0;
      const slice = state.discussions.slice(start, start + first);
      const end = start + slice.length;
      return jsonReply(200, {
        data: {
          repository: {
            hasDiscussionsEnabled: state.discussionsEnabled,
            discussions: {
              totalCount: state.discussions.length,
              pageInfo: { hasNextPage: end < state.discussions.length, endCursor: Buffer.from(String(end)).toString("base64") },
              nodes: slice.map((d) => ({ number: d.number, title: d.title, body: d.body, closed: d.closed, createdAt: "2026-01-01T00:00:00Z", author: { login: d.login ?? "someone" } })),
            },
          },
        },
      });
    }
    if (op === "PlanDiscussionComments") {
      // The import must know which comments a maintainer hid, so the fake refuses a comments document that does not ask for
      // `isMinimized` (an allowlisted constant that stopped asking would otherwise read every comment as "not hidden").
      if (!/\bisMinimized\b/.test(q)) return jsonReply(200, { data: null, errors: [{ type: "MISSING_FIELD", message: "The comments query must select isMinimized." }] });
      const d = state.discussions.find((x) => x.number === vars.number);
      if (!d) return jsonReply(200, { data: { repository: { discussion: null } } });
      const first = Math.min(100, Number(vars.first ?? 30));
      const start = typeof vars.after === "string" ? Number(Buffer.from(vars.after, "base64").toString("utf8")) : 0;
      const slice = d.comments.slice(start, start + first);
      const end = start + slice.length;
      return jsonReply(200, {
        data: {
          repository: {
            discussion: {
              comments: {
                pageInfo: { hasNextPage: end < d.comments.length, endCursor: Buffer.from(String(end)).toString("base64") },
                nodes: slice.map((c) => ({ databaseId: c.databaseId, body: c.body, createdAt: "2026-01-02T00:00:00Z", ...(state.faults.commentsWithoutIsMinimized ? {} : { isMinimized: c.isMinimized === true }), author: { login: c.login } })),
              },
            },
          },
        },
      });
    }
    return jsonReply(200, { data: null, errors: [{ type: "GRAPHQL_PARSE_FAILED", message: "Parse error" }] });
  }

  const route = (req: GhRequest): GhReply => {
    const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(req.path);
    if (mint) {
      if (req.method !== "POST") return ghError(404, "Not Found");
      if (Number(mint[1]) !== state.installationId) return ghError(404, "Not Found");
      const body = req.body ? (JSON.parse(req.body) as { repositories?: string[]; permissions?: Record<string, string> }) : {};
      const requested = body.permissions ?? {};
      for (const [k, v] of Object.entries(requested)) {
        const have = state.installPermissions[k];
        if (!have || (LEVEL[v as "read" | "write"] ?? 99) > LEVEL[have]) return ghError(422, "The permissions requested are not granted to this installation.");
      }
      if (body.repositories && (body.repositories.length !== 1 || body.repositories[0] !== state.name)) return ghError(422, "There is at least one repository that does not exist or is not accessible to the parent installation.");
      tokenCounter += 1;
      const token = `ghs_plan${tokenCounter}`;
      const permissions = state.faults.mintReplyPermissions ?? { ...requested };
      issued.set(token, { permissions: { ...requested }, expiresAtMs: Date.now() + (state.tokenTtlMs ?? 3_600_000) });
      mints.push({ installationId: state.installationId, body: body as Record<string, unknown>, token });
      return jsonReply(201, {
        token,
        expires_at: new Date(Date.now() + (state.tokenTtlMs ?? 3_600_000)).toISOString(),
        ...(state.faults.mintReplyWithoutPermissions ? {} : { permissions }),
        repository_selection: "selected",
      });
    }

    const cred = credential(req);
    if ("status" in cred) return cred;
    const limited = rateLimited();
    if (limited) return limited;

    if (req.path === "/graphql") return graphql(req, cred.permissions);

    if (req.method !== "GET") return ghError(404, "Not Found");
    const url = new URL(`https://api.github.com${req.path}?${req.query ?? ""}`);
    if (!req.path.startsWith(`${repoBase}/`)) return ghError(404, "Not Found");

    if (req.path.startsWith(`${repoBase}/contents/`)) {
      const denied = needs(cred.permissions, "contents");
      if (denied) return denied;
      if (state.faults.contentsStatus) return ghError(state.faults.contentsStatus, "Server Error");
      const ref = url.searchParams.get("ref");
      if (ref !== null && ref !== state.headSha && ref !== state.defaultBranch) return ghError(404, "No commit found for the provided ref.");
      const path = req.path.slice(`${repoBase}/contents/`.length).split("/").map(decodeURIComponent).join("/");
      const content = state.files.get(path);
      if (content === undefined) return ghError(404, "Not Found");
      if (/application\/vnd\.github(\.v3)?\.raw/.test(req.headers["accept"] ?? "")) {
        return { status: 200, headers: { "content-type": "application/vnd.github.raw; charset=utf-8", "content-length": String(Buffer.byteLength(content)) }, body: content };
      }
      return jsonReply(200, { type: "file", name: path.split("/").pop(), path, sha: "b".repeat(40), size: Buffer.byteLength(content), encoding: "base64", content: Buffer.from(content).toString("base64") });
    }

    const collab = new RegExp(`^${repoBase}/collaborators/([^/]+)/permission$`).exec(req.path);
    if (collab) {
      // Like the real route: `permission` is the legacy four-level answer (maintain reads as write, triage as read) and
      // `role_name` is the exact role. Needs metadata read.
      const denied = needs(cred.permissions, "metadata");
      if (denied) return denied;
      const login = decodeURIComponent(collab[1]!);
      const role = state.collaborators[login];
      if (role === undefined) return ghError(404, "Not Found");
      const legacy = { admin: "admin", maintain: "write", write: "write", triage: "read", read: "read", none: "none" }[role];
      return jsonReply(200, { permission: legacy, role_name: role, user: { login } });
    }

    if (req.path === `${repoBase}/issues`) {
      const denied = needs(cred.permissions, "issues");
      if (denied) return denied;
      if (state.faults.issuesStatus) return ghError(state.faults.issuesStatus, "Server Error");
      const wanted = url.searchParams.get("state") ?? "open";
      const direction = url.searchParams.get("direction") === "asc" ? 1 : -1;
      const items = state.items.filter((i) => wanted === "all" || i.state === wanted).sort((a, b) => (a.number - b.number) * direction);
      const { items: pageItems, link } = pageOf(req, url.searchParams, items.map(itemJson));
      return jsonReply(200, pageItems, link ? { link } : {});
    }
    return ghError(404, "Not Found");
  };

  const server = await startStrictGithubServer(route);

  /** `fetch` over real TLS: https.request to 127.0.0.1 with the server certificate as `ca` and api.github.com as the name. */
  const tlsFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== "https:" || url.hostname !== "api.github.com") throw new Error(`planGithubFake: unexpected target ${url.origin}`);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const body = init?.body === undefined || init.body === null ? undefined : String(init.body);
    if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));
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
          lookup: ((_host: string, options: { all?: boolean }, cb: (...args: unknown[]) => void) =>
            options && options.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4)) as never,
          signal: init?.signal ?? undefined,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const h = new Headers();
            for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(", ") : v);
            resolve(new Response(res.statusCode === 204 ? null : Buffer.concat(chunks), { status: res.statusCode ?? 0, headers: h }));
          });
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  }) as typeof fetch;

  /** The mint call over the same TLS path, with the production requester's shape (it passes `permissions` on unfiltered). */
  const requester: AccessTokenRequester = async ({ installationId, appJwt, repositories, permissions }) => {
    const body = JSON.stringify(repositories === null ? { permissions } : { repositories, permissions });
    const res = await tlsFetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${appJwt}`, accept: "application/vnd.github+json", "user-agent": "fulcrumaxe-cloud", "content-type": "application/json" },
      body,
    });
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) {
      let raw: unknown;
      try {
        raw = (JSON.parse(text) as { message?: unknown } | null)?.message;
      } catch {
        raw = text;
      }
      throw Object.assign(new Error("access_token_mint_failed"), { status: res.status, ghMessage: typeof raw === "string" ? raw.replace(/[^A-Za-z ]/g, "").slice(0, 80) : "" });
    }
    const parsed = JSON.parse(text) as { token?: string; expires_at?: string; permissions?: unknown };
    if (!parsed.token || !parsed.expires_at) throw new Error("access_token_mint_failed");
    const perms = parsed.permissions !== null && typeof parsed.permissions === "object" && !Array.isArray(parsed.permissions) ? (parsed.permissions as Record<string, string>) : undefined;
    return { token: parsed.token, expiresAt: parsed.expires_at, ...(perms ? { permissions: perms } : {}) };
  };

  return { server, state, fetch: tlsFetch, requester, mints, close: () => server.close() };
}
