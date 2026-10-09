/**
 * D#6 R2b-3 (body criterion 9, C22 section 6): the GitHub ALLOWLIST for a `runner_local` repo. For these repos our cloud must
 * never receive the customer's source files or diffs, so every call our App makes about one goes through this wrapper, and a
 * call goes through only if it is one of the few the run path makes. Everything else is refused before the request is made, with
 * `LocalOnlyGithubError("not_allowlisted")`. (The first version was a deny list. It let the tarball, the zipball, the readme,
 * pull review comments and a raw `POST /graphql` through, which is why a list of what is forbidden cannot be the fence.)
 *
 * The allowlist is `LOCAL_ONLY_ALLOWLIST` (A1 to A6 below). A request matches an entry only when ALL of these hold:
 *
 *   - its method is the entry's, spelled exactly;
 *   - its path, put in canonical form, has exactly the shape of one of the entry's templates. Canonical form is how a server would
 *     read the path: percent-decoded (twice, so `%252e` cannot hide a dot), lower-cased for matching, repeated slashes collapsed,
 *     and the query and fragment taken off. `{owner}` and `{repo}` match `[a-z0-9_.-]{1,100}` and are never `.` or `..`; `{n}` and
 *     `{id}` match `\d{1,19}`. A path that still holds `?`, `#`, a backslash or a control character after decoding is refused, and
 *     an encoded slash makes extra segments, so it cannot stand for one;
 *   - every query key (from `query` and from a query string written in the path) is one the entry lists, with a value of its shape;
 *   - its body has the entry's shape (a GET has none);
 *   - an `Accept` header, if the caller supplied one, is `application/vnd.github+json` or `application/vnd.github.v3+json`, so a
 *     diff or patch media type is refused whatever the path. A call that supplies none is sent with the first, so no call this
 *     wrapper forwards ever leaves it to GitHub's default media type.
 *
 * `POST /graphql` (A1) is allowed only for four documents fixed in this module, byte for byte, with variables of their own
 * schema. A caller never supplies a query (`graphql(op, variables)` takes the operation's name and looks the text up here); the documents select refs, counts, oids and changed paths with their change type, and
 * none selects a patch, a diff, text, a blob, contents or a body (a test holds that).
 *
 * D#6 R3c (C35 section 3.3) adds the review driver's and the merge gate's calls, each as narrow as the call itself:
 *   A7   POST /repos/{owner}/{repo}/statuses/{sha}, body exactly { state, context, description } with our review context
 *   A8   GET  /repos/{owner}/{repo}/branches/{branch}/protection (one path segment for the branch)
 *   A9   the fixed GraphQL document `CommitChecks`, keyed by pull request number and reading its last commit (check-run name, status, conclusion and app id; status-context name and state)
 *   A10  PUT  /repos/{owner}/{repo}/pulls/{n}/merge, body exactly { sha, merge_method: "squash" }
 *
 * Calls not listed are refused until a numbered correction adds them with their own negative tests. Reading CI state uses only a
 * fixed GraphQL document that selects state and conclusion, never a check run's output text, summary or annotations.
 */

/** The shape of the App client's request. The Accept header is optional because the production client sends none of its own. */
export interface GithubRequest {
  method: string;
  path: string;
  query?: Readonly<Record<string, string | number>>;
  headers?: Readonly<Record<string, string>>;
  body?: unknown;
}
export interface GithubResponse {
  status: number;
  body: unknown;
}
export interface GithubClient {
  request(req: GithubRequest): Promise<GithubResponse>;
}

/** Thrown, before any request is made, for a call the allowlist does not hold. The message names the rule, never the path. */
export class LocalOnlyGithubError extends Error {
  constructor(readonly rule: string) {
    super(`local-only github: refused (${rule})`);
    this.name = "LocalOnlyGithubError";
  }
}

/** The four GraphQL documents A1 allows, fixed here. They select refs, counts, oids, changed paths and their change type, and check names and states; nothing that carries source. */
export const GITHUB_GRAPHQL_DOCUMENTS = Object.freeze({
  RunBranchState: `query RunBranchState($owner: String!, $name: String!, $head: String!, $base: String!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name target { oid } }
    ref(qualifiedName: $head) { name target { oid } }
    baseRef: ref(qualifiedName: $base) { compare(headRef: $head) { aheadBy } }
  }
}`,
  PullRequestFiles: `query PullRequestFiles($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      files(first: 100, after: $cursor) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes { path changeType }
      }
    }
  }
}`,
  MarkReady: `mutation MarkReady($id: ID!) {
  markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { number isDraft } }
}`,
  // D#6 R3c (A9): the CI signal for one commit. Names, statuses, conclusions, the app that ran a check, and status contexts with their
  // state. It never selects a check run's output, summary, text, details or annotations.
  CommitChecks: `query CommitChecks($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      commits(last: 1) {
        nodes {
          commit {
            oid
            statusCheckRollup {
              contexts(first: 100, after: $cursor) {
                totalCount
                pageInfo { hasNextPage endCursor }
                nodes {
                  __typename
                  ... on CheckRun { name status conclusion checkSuite { app { databaseId } } }
                  ... on StatusContext { context state }
                }
              }
            }
          }
        }
      }
    }
  }
}`,
});
export type GithubGraphqlOperation = keyof typeof GITHUB_GRAPHQL_DOCUMENTS;

/** One allowed call. `paths` are templates; `query` lists the only query keys; `body` says in words what the body must be. */
export interface LocalOnlyAllowlistEntry {
  id: string;
  method: "GET" | "POST" | "PATCH" | "PUT";
  paths: readonly string[];
  query: readonly string[];
  body: string;
}

/** The calls R2b-3 makes (C22 section 6) and R3c adds (C35 section 3.3), nothing else. A test holds this list equal to the table in the Spec. */
export const LOCAL_ONLY_ALLOWLIST: readonly LocalOnlyAllowlistEntry[] = Object.freeze(
  [
    { id: "A1", method: "POST", paths: ["/graphql"], query: [], body: "{ query: one of the three fixed documents, variables: that document's schema }" },
    { id: "A2", method: "GET", paths: ["/repos/{owner}/{repo}", "/repositories/{id}"], query: [], body: "none" },
    { id: "A3", method: "GET", paths: ["/repos/{owner}/{repo}/pulls"], query: ["head", "base", "state", "per_page"], body: "none" },
    { id: "A4", method: "POST", paths: ["/repos/{owner}/{repo}/pulls"], query: [], body: "{ title, head, base, body, draft: boolean }" },
    { id: "A5", method: "PATCH", paths: ["/repos/{owner}/{repo}/pulls/{n}"], query: [], body: '{ state: "closed" }' },
    { id: "A6", method: "POST", paths: ["/app/installations/{id}/access_tokens"], query: [], body: "none, or { repository_ids: [the repo id] }" },
    { id: "A7", method: "POST", paths: ["/repos/{owner}/{repo}/statuses/{sha}"], query: [], body: '{ state, context: "fulcrumaxe/review", description }' },
    { id: "A8", method: "GET", paths: ["/repos/{owner}/{repo}/branches/{branch}/protection"], query: [], body: "none" },
    { id: "A10", method: "PUT", paths: ["/repos/{owner}/{repo}/pulls/{n}/merge"], query: [], body: '{ sha, merge_method: "squash" }' },
  ].map((entry) => Object.freeze(entry) as LocalOnlyAllowlistEntry),
);

const NOT_ALLOWLISTED = "not_allowlisted";
const ACCEPT_RULE = "accept";
/** The media type every forwarded call carries. */
const JSON_ACCEPT = "application/vnd.github+json";
const ACCEPT = /^application\/vnd\.github(?:\.v3)?\+json$/i;

const NAME = /^[a-z0-9_.-]{1,100}$/;
const DIGITS = /^\d{1,19}$/;
const PLACEHOLDERS: Readonly<Record<string, (segment: string) => boolean>> = {
  "{owner}": (s) => NAME.test(s) && s !== "." && s !== "..",
  "{repo}": (s) => NAME.test(s) && s !== "." && s !== "..",
  "{n}": (s) => DIGITS.test(s),
  "{id}": (s) => DIGITS.test(s),
  "{sha}": (s) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(s),
  "{branch}": (s) => NAME.test(s) && s !== "." && s !== "..",
};

function decoded(value: string): string {
  let out = value;
  for (let i = 0; i < 2; i++) {
    try {
      out = decodeURIComponent(out);
    } catch {
      // fx-swallow-ok: a malformed escape is read as written, and a path that still holds a percent sign matches no template
      return out;
    }
  }
  return out;
}

/** A query key or value, as a server reads it: decoded once. (A key spelled `%2568ead` is `%68ead` to a server, which is not `head`.) */
function decodedOnce(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // fx-swallow-ok: a malformed escape is read as written, which matches no key and no value shape
    return value;
  }
}

/** The path's segments in canonical form and the query keys written in it, or null when the path cannot be read as one plain path. */
function canonical(path: string): { segments: string[]; keys: string[] } | null {
  const cut = path.search(/[?#]/);
  const pathPart = cut < 0 ? path : path.slice(0, cut);
  const queryPart = cut >= 0 && path[cut] === "?" ? path.slice(cut + 1).split("#")[0]! : "";
  const text = decoded(pathPart).toLowerCase();
  // After decoding, a query or fragment mark, a backslash or a control character would be read differently by a server than by us.
  if (/[?#\\\u0000-\u001f\u007f]/.test(text)) return null;
  const segments = text.split("/").filter((s) => s.length > 0);
  const keys = queryPart.length === 0 ? [] : queryPart.split("&").filter((p) => p.length > 0).map((p) => decodedOnce(p.split("=")[0]!));
  return { segments, keys };
}

function templateMatches(template: string, segments: readonly string[]): boolean {
  const parts = template.split("/").filter((s) => s.length > 0);
  if (parts.length !== segments.length) return false;
  return parts.every((part, i) => {
    const check = PLACEHOLDERS[part];
    return check ? check(segments[i]!) : part === segments[i];
  });
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
};
const hasExactKeys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean => {
  const keys = Object.keys(value);
  return required.every((k) => keys.includes(k)) && keys.every((k) => required.includes(k) || optional.includes(k));
};

const OWNER_OR_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const REF_NAME = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,254}$/;
const CURSOR = /^[A-Za-z0-9+/=_-]{1,200}$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** The context of the platform's own commit status. A test in the pipeline package holds it equal to the gate's constant. */
export const LOCAL_ONLY_REVIEW_STATUS_CONTEXT = "fulcrumaxe/review";
const NODE_ID = /^[A-Za-z0-9_=+/-]{1,100}$/;
const str = (value: unknown, pattern: RegExp): boolean => typeof value === "string" && pattern.test(value) && !value.includes("..");
/** An owner or repository name: the pattern, and never `.` or `..` themselves (a name may hold two dots in a row). */
const ownerOrName = (value: unknown): boolean => typeof value === "string" && OWNER_OR_NAME.test(value) && value !== "." && value !== "..";
const positiveInt = (value: unknown): boolean => typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

/** The variables each fixed document takes. */
const VARIABLES: Readonly<Record<GithubGraphqlOperation, (v: Record<string, unknown>) => boolean>> = {
  RunBranchState: (v) => hasExactKeys(v, ["owner", "name", "head", "base"]) && ownerOrName(v.owner) && ownerOrName(v.name) && str(v.head, REF_NAME) && str(v.base, REF_NAME),
  PullRequestFiles: (v) =>
    hasExactKeys(v, ["owner", "name", "number"], ["cursor"]) && ownerOrName(v.owner) && ownerOrName(v.name) && positiveInt(v.number) && (v.cursor === undefined || v.cursor === null || str(v.cursor, CURSOR)),
  MarkReady: (v) => hasExactKeys(v, ["id"]) && str(v.id, NODE_ID),
  CommitChecks: (v) =>
    hasExactKeys(v, ["owner", "name", "number"], ["cursor"]) && ownerOrName(v.owner) && ownerOrName(v.name) && positiveInt(v.number) && (v.cursor === undefined || v.cursor === null || str(v.cursor, CURSOR)),
};

/** Whether the body has the shape the entry names. */
function bodyFits(entry: LocalOnlyAllowlistEntry, body: unknown): boolean {
  switch (entry.id) {
    case "A1": {
      if (!isPlainObject(body) || !hasExactKeys(body, ["query", "variables"])) return false;
      const op = (Object.keys(GITHUB_GRAPHQL_DOCUMENTS) as GithubGraphqlOperation[]).find((name) => GITHUB_GRAPHQL_DOCUMENTS[name] === body.query);
      return op !== undefined && isPlainObject(body.variables) && VARIABLES[op](body.variables);
    }
    case "A4":
      return (
        isPlainObject(body) &&
        hasExactKeys(body, ["title", "head", "base", "body", "draft"]) &&
        typeof body.title === "string" && body.title.length >= 1 && body.title.length <= 256 &&
        str(body.head, REF_NAME) &&
        str(body.base, REF_NAME) &&
        typeof body.body === "string" && body.body.length <= 65536 &&
        typeof body.draft === "boolean"
      );
    case "A7":
      return (
        isPlainObject(body) &&
        hasExactKeys(body, ["state", "context", "description"]) &&
        (body.state === "success" || body.state === "failure" || body.state === "pending" || body.state === "error") &&
        body.context === LOCAL_ONLY_REVIEW_STATUS_CONTEXT &&
        typeof body.description === "string" && body.description.length <= 140
      );
    case "A10":
      return isPlainObject(body) && hasExactKeys(body, ["sha", "merge_method"]) && typeof body.sha === "string" && SHA.test(body.sha) && body.merge_method === "squash";
    case "A5":
      return isPlainObject(body) && hasExactKeys(body, ["state"]) && body.state === "closed";
    case "A6": {
      if (body === undefined || body === null) return true;
      if (!isPlainObject(body)) return false;
      if (Object.keys(body).length === 0) return true;
      return hasExactKeys(body, ["repository_ids"]) && Array.isArray(body.repository_ids) && body.repository_ids.length === 1 && positiveInt(body.repository_ids[0]);
    }
    default:
      // The GETs: no body at all.
      return body === undefined || body === null;
  }
}

const QUERY_VALUES: Readonly<Record<string, (value: string) => boolean>> = {
  head: (v) => REF_NAME.test(v) && !v.includes(".."),
  base: (v) => REF_NAME.test(v) && !v.includes(".."),
  state: (v) => v === "open" || v === "closed" || v === "all",
  per_page: (v) => /^\d{1,3}$/.test(v) && Number(v) >= 1 && Number(v) <= 100,
};

/** The rule a call breaks, or null when it is on the allowlist. `not_allowlisted` for anything the list does not hold; `accept` for a media type other than JSON. */
export function localOnlyViolation(req: Pick<GithubRequest, "method" | "path" | "query" | "headers" | "body">): string | null {
  if (typeof req.method !== "string" || typeof req.path !== "string") return NOT_ALLOWLISTED;
  const where = canonical(req.path);
  if (where === null) return NOT_ALLOWLISTED;
  const entry = LOCAL_ONLY_ALLOWLIST.find((e) => e.method === req.method && e.paths.some((template) => templateMatches(template, where.segments)));
  if (!entry) return NOT_ALLOWLISTED;

  const given = Object.entries(req.query ?? {});
  for (const key of [...where.keys, ...given.map(([k]) => k)]) if (!entry.query.includes(key)) return NOT_ALLOWLISTED;
  for (const [key, value] of given) if (!QUERY_VALUES[key]?.(String(value))) return NOT_ALLOWLISTED;
  // A key written in the path carries a value too; it is held to the same shape.
  const cut = req.path.search(/[?#]/);
  if (cut >= 0 && req.path[cut] === "?") {
    for (const pair of req.path.slice(cut + 1).split("#")[0]!.split("&").filter((p) => p.length > 0)) {
      const [rawKey, ...rest] = pair.split("=");
      if (!QUERY_VALUES[decodedOnce(rawKey!)]?.(decodedOnce(rest.join("=")))) return NOT_ALLOWLISTED;
    }
  }

  if (!bodyFits(entry, req.body)) return NOT_ALLOWLISTED;
  for (const [name, value] of Object.entries(req.headers ?? {})) {
    if (name.toLowerCase() === "accept" && !ACCEPT.test(value)) return ACCEPT_RULE;
  }
  return null;
}

/** The wrapped client: `request` for the REST calls on the allowlist, and `graphql` for the three fixed documents. */
export interface LocalOnlyGithub extends GithubClient {
  /**
   * Runs one of the fixed documents by name. The caller never supplies query text: an unknown name (including a prototype key such as
   * `toString`) is refused as `not_allowlisted`, and the variables are held to that document's schema by the same check as every call.
   * The answer is GitHub's, as received: a GraphQL error arrives as status 200 with an `errors` array, so the caller must read it.
   */
  graphql(op: GithubGraphqlOperation, variables: Readonly<Record<string, unknown>>): Promise<GithubResponse>;
}

/** Wraps `inner`: every call is checked first, and one the allowlist does not hold throws `LocalOnlyGithubError` without reaching `inner`. */
export function localOnlyGithub(inner: GithubClient): LocalOnlyGithub {
  const send = (req: GithubRequest): Promise<GithubResponse> => {
    const rule = localOnlyViolation(req);
    if (rule !== null) return Promise.reject(new LocalOnlyGithubError(rule));
    const hasAccept = Object.keys(req.headers ?? {}).some((name) => name.toLowerCase() === "accept");
    return inner.request(hasAccept ? req : { ...req, headers: { ...req.headers, accept: JSON_ACCEPT } });
  };
  return {
    request: send,
    graphql(op, variables) {
      if (typeof op !== "string" || !Object.hasOwn(GITHUB_GRAPHQL_DOCUMENTS, op)) return Promise.reject(new LocalOnlyGithubError(NOT_ALLOWLISTED));
      return send({ method: "POST", path: "/graphql", body: { query: GITHUB_GRAPHQL_DOCUMENTS[op], variables } });
    },
  };
}
