import {
  decide,
  parseTarget,
  parseReceivePackRefUpdates,
  type ProxyRequest,
  type Product,
} from "@fx/gh-policy";
import {
  getInstallationToken,
  InstallationTokenError,
  MintTimeoutError,
  type AccessTokenRequester,
  type InstallationTokenCache,
} from "./installationToken.js";
import { AppCredentialsError, type AppCredentialsSource } from "./appCredentials.js";
import { InstallationNotWritableError } from "./writeInstallation.js";

/**
 * D#2 H13b: orchestrates one proxied request from a verified sandbox
 * identity through to a forward/deny decision. Everything network- or
 * DB-touching is an injected dependency (B1: every field handed to
 * `decide()` is derived from THIS request's own bytes, never a re-read),
 * so this file's own tests never open a socket or a database connection.
 */

const GIT_UPSTREAM_HOST = "github.com";
const API_UPSTREAM_HOST = "api.github.com";

/**
 * D#2 H13, body criterion 3: what the OIDC-verified `sandbox_name` claim
 * resolves to. A real implementation queries `agent_runs` (by
 * `sandbox_name`) joined through `work_items` -> `repos` -> `installations`
 * -- but `platform_ops` has no SELECT grant on `agent_runs`/`work_items`
 * on `main` (H13a's migration only grants `installations`/`repos`, for a
 * different need), and the owner/repo NAME strings this needs aren't
 * stored anywhere (`repos` has only the numeric `gh_repo_id`). Both are
 * new migrations, outside H13b's `acceptance_files`. Flagged in the PR
 * description, same shape as D#66/C10 leaving `githubForwardHost` unwired
 * until its own PR landed. `defaultSandboxRunResolver` fails closed
 * (`null`, so every request denies `sandbox_not_resolved`) until a
 * follow-up wires a real implementation.
 */
export interface ResolvedSandboxRun {
  role: string;
  product: Product;
  /** `installations.gh_installation_id` -- required by the access-token mint call. */
  installationId: number;
  /** `installations.app_kind` of that row (H13e). Read from the database, never from the request. */
  appKind: string | null;
  /** GitHub owner/repo name strings, as they appear in the request path and in `decide()`'s `InstallationTarget`. */
  owner: string;
  repo: string;
  /** True when the run is an onboarding preview (D#2 H17c): read-only, on the read-only App, whatever else is asked. */
  isPreview?: boolean;
}

export type SandboxRunResolver = (sandboxName: string) => Promise<ResolvedSandboxRun | null>;

/** Fails closed: every request denies until a real resolver is injected. See the doc comment above. */
export const defaultSandboxRunResolver: SandboxRunResolver = async () => null;

/**
 * D#2 Correction C28 §3 item 2: `query` accepts EITHER shape.
 *
 * - A plain `Record<string, string>` is treated as already-validated --
 *   the legacy shape every pre-C28 test in this file still passes, so
 *   none of them needed to change for this correction (no regression,
 *   criterion 9).
 * - An array of `[key, value]` pairs IN RECEIVED ORDER, duplicates
 *   preserved, is the shape `handler.ts` always builds in production from
 *   `URLSearchParams` -- `normalizeQuery` below is the ONE place that
 *   judges it, so a request carrying the same key twice is denied before
 *   `decide()` (gh-policy's own function) ever runs, and the map it
 *   builds is what's forwarded (criterion (b), which also fixes REST
 *   pagination, (f)) -- never `url.searchParams.toString()`'s raw,
 *   possibly-duplicated string.
 */
export type ProxyDecisionQuery = Record<string, string> | ReadonlyArray<readonly [string, string]>;

export interface ProxyDecisionInput {
  method: string;
  /** The path after `/api/gh-proxy`, exactly as received -- never normalized (B2). */
  path: string;
  query: ProxyDecisionQuery;
  /** The exact raw request bytes (B5: fully read, capped, before any decision). */
  rawBody: Uint8Array;
  sandboxName: string;
  /**
   * D#2 fix round 1, must-fix 1: the raw `Content-Encoding` request header
   * value, or `null`/omitted if the header was absent. Git gzips any
   * upload-pack request body over 1 KiB (`Content-Encoding: gzip`), so that
   * ONE case -- `gzip` on a POST to the literal `git-upload-pack` endpoint
   * -- is the only one this engine ever forwards. Every other request that
   * carries this header is denied outright, before any mint: stripping the
   * header while still forwarding the (now silently misinterpreted)
   * compressed bytes would let the upstream read pkt-lines out of
   * gzip-compressed data, and git never compresses a receive-pack body or a
   * REST JSON body in the first place. Optional (defaults to `null` inside
   * `decideProxyRequest`) so the many existing fixtures that don't care
   * about this header don't all need updating -- an omitted field here
   * honestly means "this header was absent," same as an explicit `null`.
   */
  contentEncoding?: string | null;
}

/**
 * Normalizes `query` into a plain key/value map, refusing (returns `null`)
 * any array-shaped input where a key repeats. A `Record` input is assumed
 * already validated by its caller and passed through unchanged -- see the
 * `ProxyDecisionQuery` doc comment above for why both shapes exist.
 */
function normalizeQuery(query: ProxyDecisionQuery): Record<string, string> | null {
  if (!Array.isArray(query)) {
    return query as Record<string, string>;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of query) {
    if (Object.prototype.hasOwnProperty.call(out, key)) return null;
    out[key] = value;
  }
  return out;
}

export interface ProxyDecisionDeps {
  resolveSandboxRun: SandboxRunResolver;
  appCredentials: AppCredentialsSource;
  tokenCache: InstallationTokenCache;
  accessTokenRequester: AccessTokenRequester;
  now?: () => number;
}

export type ProxyDenyReason =
  | "path_not_recognized"
  | "body_too_large"
  | "query_not_allowed"
  | "body_invalid"
  | "content_encoding_not_allowed"
  | "sandbox_not_resolved"
  | "policy_denied"
  | "token_mint_failed"
  | "upstream_unavailable";

export type ProxyDecisionResult =
  | {
      allow: true;
      upstreamHost: typeof GIT_UPSTREAM_HOST | typeof API_UPSTREAM_HOST;
      installationToken: string;
      /**
       * D#2 C28 §3 items 2/3: the SAME validated key/value map `decide()`
       * itself judged -- never re-derived from the raw request. `handler.ts`
       * rebuilds the forwarded query string from exactly this, so a key the
       * proxy never saw (because it judged a deduped map) can never appear
       * upstream either.
       */
      query: Record<string, string>;
      /**
       * D#2 fix round 1, must-fix 1: true only when this request is the one
       * case that may carry `Content-Encoding` upstream (a POST to the
       * literal `git-upload-pack` endpoint with `gzip`) -- every other
       * shape that carried the header was already denied above, before
       * this result is ever built. `handler.ts` uses this instead of
       * re-deriving the same endpoint/method check from the request a
       * second time.
       */
      forwardContentEncoding: boolean;
    }
  | { allow: false; status: 403 | 404 | 413 | 502; reason: string };

/** B5: fully parsed and capped BEFORE any decision. Git push bodies carry a packfile; REST bodies are small JSON. */
export const MAX_PROXY_BODY_BYTES = 50_000_000;

/**
 * B7: a git smart-HTTP request carries `service` and nothing else, ever
 * -- any other key is a smuggling attempt. A REST query string stays
 * flexible (it's GitHub's own), but a denylist closes the exact
 * smuggling shape this criterion names: a key that looks like it's
 * trying to override routing the path already decided.
 */
const GIT_ALLOWED_QUERY_KEYS = new Set(["service"]);
const API_DENIED_QUERY_KEYS = new Set(["repo", "repository", "owner", "merge", "installation", "token", "access_token"]);

function isQueryAllowed(kind: "git" | "api", query: Record<string, string>): boolean {
  const keys = Object.keys(query);
  if (kind === "git") {
    return keys.every((k) => GIT_ALLOWED_QUERY_KEYS.has(k));
  }
  return keys.every((k) => !API_DENIED_QUERY_KEYS.has(k.toLowerCase()));
}

/**
 * D#2 C28 §3 item 6: true when `text` is syntactically valid JSON but
 * contains a duplicate key in some object literal, AT ANY NESTING DEPTH.
 * `JSON.parse` itself matches plain JS object-literal semantics: a
 * duplicate key silently collapses to its last-seen value, so the parsed
 * RESULT can never reveal that the wire bytes disagreed with themselves
 * (the review's example, `{"labels":[...],"labels":[...]}`, parses to a
 * single `labels` key with no trace the byte stream had two). This walks
 * the same text with its own minimal recursive-descent scanner -- it only
 * decides object-key uniqueness and is NEVER the parse result itself
 * (`JSON.parse`, in `parseJsonObject` below, still owns that): the text
 * has already been confirmed syntactically valid JSON before this runs,
 * so it only has to track brace/bracket nesting and string boundaries
 * correctly, not re-validate every JSON grammar rule.
 */
function hasDuplicateJsonKey(text: string): boolean {
  let i = 0;
  const len = text.length;
  let duplicateFound = false;

  function skipWs(): void {
    while (i < len) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") i++;
      else break;
    }
  }

  // Decodes a JSON string literal starting at text[i] === '"' into its
  // actual string value (escapes resolved) -- comparing DECODED values,
  // not raw source text, so e.g. "labels" and "labels" (which decode
  // to the same key) are correctly seen as the same key.
  function parseString(): string {
    i++; // opening quote
    let out = "";
    while (i < len) {
      const c = text[i]!;
      if (c === '"') {
        i++;
        return out;
      }
      if (c === "\\") {
        const esc = text[i + 1];
        switch (esc) {
          case '"':
            out += '"';
            i += 2;
            break;
          case "\\":
            out += "\\";
            i += 2;
            break;
          case "/":
            out += "/";
            i += 2;
            break;
          case "b":
            out += "\b";
            i += 2;
            break;
          case "f":
            out += "\f";
            i += 2;
            break;
          case "n":
            out += "\n";
            i += 2;
            break;
          case "r":
            out += "\r";
            i += 2;
            break;
          case "t":
            out += "\t";
            i += 2;
            break;
          case "u": {
            const hex = text.slice(i + 2, i + 6);
            out += String.fromCharCode(parseInt(hex, 16));
            i += 6;
            break;
          }
          default:
            // JSON.parse already confirmed this text is valid JSON, so an
            // unrecognized escape here can't actually occur -- unreachable
            // in practice, kept only so the scanner still terminates.
            i += 2;
        }
        continue;
      }
      out += c;
      i++;
    }
    throw new Error("hasDuplicateJsonKey: unterminated string");
  }

  function parseValue(): void {
    skipWs();
    const c = text[i];
    if (c === "{") {
      parseObject();
      return;
    }
    if (c === "[") {
      parseArray();
      return;
    }
    if (c === '"') {
      parseString();
      return;
    }
    // number, true, false, null -- skip to the next structural character.
    while (i < len && !",]}".includes(text[i]!) && !/\s/.test(text[i]!)) i++;
  }

  function parseArray(): void {
    i++; // '['
    skipWs();
    if (text[i] === "]") {
      i++;
      return;
    }
    for (;;) {
      parseValue();
      skipWs();
      if (text[i] === ",") {
        i++;
        skipWs();
        continue;
      }
      if (text[i] === "]") {
        i++;
        return;
      }
      throw new Error("hasDuplicateJsonKey: malformed array");
    }
  }

  function parseObject(): void {
    i++; // '{'
    const seen = new Set<string>();
    skipWs();
    if (text[i] === "}") {
      i++;
      return;
    }
    for (;;) {
      skipWs();
      const key = parseString();
      if (seen.has(key)) duplicateFound = true;
      seen.add(key);
      skipWs();
      if (text[i] !== ":") throw new Error("hasDuplicateJsonKey: expected ':'");
      i++;
      parseValue();
      skipWs();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "}") {
        i++;
        return;
      }
      throw new Error("hasDuplicateJsonKey: malformed object");
    }
  }

  parseValue();
  return duplicateFound;
}

export type ParsedJsonBody =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: "unparsable" | "duplicate_key" };

/** True only for a JSON object (not an array, not null) -- the shape every JSON-bodied field below requires. */
function parseJsonObject(rawBody: Uint8Array): ParsedJsonBody {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
  } catch {
    return { ok: false, reason: "unparsable" };
  }
  if (text.length === 0) return { ok: false, reason: "unparsable" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "unparsable" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "unparsable" };
  }
  let duplicate: boolean;
  try {
    duplicate = hasDuplicateJsonKey(text);
  } catch {
    // The scanner disagreeing with JSON.parse's own success would be a bug
    // in the scanner, not a real ambiguity in the request -- fail closed
    // rather than risk silently accepting bytes it couldn't actually walk.
    return { ok: false, reason: "unparsable" };
  }
  if (duplicate) return { ok: false, reason: "duplicate_key" };
  return { ok: true, value: parsed as Record<string, unknown> };
}

const ISSUE_OR_PR_SINGLE_RE = /^\/(?:issues|pulls)\/\d+$/;
const LABELS_COLLECTION_RE = /^\/issues\/\d+\/labels$/;

/**
 * B1 (honest inputs) / gh-policy's own trust-boundary contract: derives
 * `gitRefUpdates`/`labelNames`/`patchFields` from THIS request's exact raw
 * body, and returns `"invalid"` (never "no fields") when a body that
 * should carry one of these fields fails to parse -- gh-policy's decide()
 * then denies on an empty/missing field, never approves a guess.
 */
function deriveBodyFields(
  kind: "git" | "api",
  method: string,
  subpathOrService: { subpath?: string; service?: string },
  rawBody: Uint8Array,
): Pick<ProxyRequest, "gitRefUpdates" | "labelNames" | "patchFields"> | "invalid" | "duplicate_key" {
  if (kind === "git") {
    if (subpathOrService.service === "receive-pack" && method === "POST") {
      return { gitRefUpdates: parseReceivePackRefUpdates(rawBody) };
    }
    return {};
  }

  const subpath = subpathOrService.subpath ?? "";
  if (method === "PATCH" && ISSUE_OR_PR_SINGLE_RE.test(subpath)) {
    const parsed = parseJsonObject(rawBody);
    if (!parsed.ok) return parsed.reason === "duplicate_key" ? "duplicate_key" : "invalid";
    return { patchFields: Object.keys(parsed.value) };
  }
  if (method === "POST" && LABELS_COLLECTION_RE.test(subpath)) {
    const parsed = parseJsonObject(rawBody);
    if (!parsed.ok) return parsed.reason === "duplicate_key" ? "duplicate_key" : "invalid";
    const labels = parsed.value["labels"];
    if (!Array.isArray(labels) || !labels.every((l) => typeof l === "string")) return "invalid";
    return { labelNames: labels };
  }
  return {};
}

/**
 * A preview run may only read: REST GET/HEAD, ref discovery (GET/HEAD) and the
 * upload-pack endpoint (a POST, but a read). Everything else, known as a write
 * or not, is refused.
 */
function isPreviewReadRequest(target: NonNullable<ReturnType<typeof parseTarget>>, method: string): boolean {
  const m = method.toUpperCase();
  if (target.kind === "api") return m === "GET" || m === "HEAD";
  if (target.endpoint === "info/refs") return target.service === "upload-pack" && (m === "GET" || m === "HEAD");
  return target.endpoint === "git-upload-pack" && m === "POST";
}

function deny(status: 403 | 404 | 413 | 502, reason: string): ProxyDecisionResult {
  return { allow: false, status, reason };
}

/**
 * The single entry point: resolves the sandbox, builds an honest
 * `ProxyRequest`, calls `decide()` exactly once (B6: never cached, never
 * reused across a retry), and on allow mints or caches the installation
 * token `decide()` scoped. Every deny path returns a reason string for the
 * caller to log -- never a token, never a private key, never raw upstream
 * error text (body criterion 4).
 */
export async function decideProxyRequest(
  input: ProxyDecisionInput,
  deps: ProxyDecisionDeps,
): Promise<ProxyDecisionResult> {
  if (input.rawBody.byteLength > MAX_PROXY_BODY_BYTES) {
    return deny(413, "body_too_large");
  }

  // D#2 C28 §3 item 2: judged and deduped BEFORE parseTarget (which itself
  // reads `query.service` to disambiguate a git info/refs request -- it
  // must see the validated map too, never a raw duplicate-tolerant one)
  // and before gh-policy's own `decide()`. A repeated key denies with the
  // same generic reason the existing denylist check below already uses.
  const query = normalizeQuery(input.query);
  if (query === null) {
    return deny(403, "query_not_allowed");
  }

  const target = parseTarget(input.path, query);
  if (!target) {
    return deny(404, "path_not_recognized");
  }

  if (!isQueryAllowed(target.kind, query)) {
    return deny(403, "query_not_allowed");
  }

  // D#2 fix round 1, must-fix 1: `Content-Encoding` is judged BEFORE any
  // mint, same as every other pre-mint gate above. The one shape ever
  // forwarded is `gzip` on a POST to the literal `git-upload-pack`
  // endpoint (git compresses any upload-pack request body over 1 KiB);
  // every other request carrying this header at all is denied outright --
  // never stripped-and-forwarded, which would silently change what the
  // forwarded bytes mean to the upstream.
  const contentEncoding = input.contentEncoding ?? null;
  let forwardContentEncoding = false;
  if (contentEncoding !== null) {
    const isUploadPackPost =
      target.kind === "git" && target.endpoint === "git-upload-pack" && input.method === "POST";
    if (!isUploadPackPost || contentEncoding.toLowerCase() !== "gzip") {
      return deny(403, "content_encoding_not_allowed");
    }
    forwardContentEncoding = true;
  }

  const run = await deps.resolveSandboxRun(input.sandboxName);
  if (!run) {
    return deny(403, "sandbox_not_resolved");
  }

  // H17c: a preview run is read-only and only ever on the read-only App. Judged
  // before any body is parsed and before any mint; a run that is not a preview
  // skips this and behaves exactly as before.
  if (run.isPreview === true) {
    if (run.appKind !== "team_readonly") return deny(403, "installation_not_writable");
    if (!isPreviewReadRequest(target, input.method)) return deny(403, "preview_read_only");
  }

  const bodyFields = deriveBodyFields(
    target.kind,
    input.method,
    target.kind === "git" ? { service: target.service } : { subpath: target.subpath },
    input.rawBody,
  );
  if (bodyFields === "invalid") {
    return deny(403, "body_unparsable");
  }
  if (bodyFields === "duplicate_key") {
    return deny(403, "body_invalid");
  }

  // B3: the host handed to decide() is EXACTLY the host this same call's
  // caller will connect to -- one local, computed once, never re-derived
  // from any header. Both `host` and `sniHost` are this same local, so a
  // future refactor can never let them diverge without decide() itself
  // catching it (host_sni_mismatch).
  const upstreamHost = target.kind === "git" ? GIT_UPSTREAM_HOST : API_UPSTREAM_HOST;

  const proxyRequest: ProxyRequest = {
    method: input.method,
    host: upstreamHost,
    sniHost: upstreamHost,
    path: input.path,
    query,
    role: run.role,
    product: run.product,
    installation: { owner: run.owner, repo: run.repo },
    ...bodyFields,
  };

  const decision = decide(proxyRequest);
  if (!decision.allow || !decision.tokenScope) {
    return deny(403, decision.reason);
  }

  let installationToken: string;
  try {
    installationToken = await getInstallationToken({
      installationId: run.installationId,
      appKind: run.appKind,
      purpose: run.isPreview === true ? "preview_read" : "run",
      role: run.role,
      scope: decision.tokenScope,
      appCredentials: deps.appCredentials,
      requester: deps.accessTokenRequester,
      cache: deps.tokenCache,
      now: deps.now,
    });
  } catch (err) {
    // D#2 C28 §3 item 8: a mint TIMEOUT specifically is an upstream
    // availability failure, not a policy denial -- 502, like the route's
    // existing resolveUpstream-failure response, not the generic 403 every
    // OTHER mint failure still gets (unchanged from before this
    // correction: see the "token_mint_failed" test in proxyDecision.test.ts).
    if (err instanceof MintTimeoutError) {
      return deny(502, "upstream_unavailable");
    }
    // H13e: a non-`team` installation is denied with its own code, before
    // any token was minted or any GitHub call made.
    if (err instanceof InstallationNotWritableError) {
      return deny(403, "installation_not_writable");
    }
    // Why the mint failed: app kind, error class name and, for the two classes whose message is a
    // fixed code (not_configured (<kind>), mint_failed, ...), that code. Any other message can echo
    // an upstream body, so it is never logged; neither is a token or key. A kind with a bad
    // variable was already described once, by shape, when the credentials loaded.
    const fixedCode =
      err instanceof AppCredentialsError || err instanceof InstallationTokenError
        ? err.message.replace(/[^A-Za-z0-9_ ():-]/g, "").slice(0, 80)
        : undefined;
    console.warn("gh-proxy: token mint failed", {
      appKind: run.appKind,
      error: err instanceof Error ? err.name : "unknown",
      ...(fixedCode ? { code: fixedCode } : {}),
    });
    return deny(403, "token_mint_failed");
  }

  return { allow: true, upstreamHost, installationToken, query, forwardContentEncoding };
}
