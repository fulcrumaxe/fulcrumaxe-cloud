import { gunzipSync } from "node:zlib";
import { decideRunner, isFullCloneRequest, parseReceivePackRefUpdates, parseTarget, parseUploadPackRequest, type ParsedRefUpdates } from "@fx/gh-policy";
import { AppCredentialsError, type AppCredentialsSource } from "./appCredentials.js";
import { getInstallationToken, InstallationTokenError, MintTimeoutError, type AccessTokenRequester, type InstallationTokenCache } from "./installationToken.js";
import { isQueryAllowed, normalizeQuery, type ProxyDecisionQuery } from "./proxyDecision.js";
import type { RunnerCloneBudget } from "./runnerCloneBudget.js";
import { secondsUntilUtcMidnight } from "./runnerCloneBudget.js";
import type { RunnerGitResolver } from "./runnerGitResolver.js";
import type { RunnerGitTicketClaims } from "./runnerGitTicket.js";
import { InstallationNotWritableError } from "./writeInstallation.js";

/**
 * D#6 R5a-2c (correction C27 sections 2.1 steps 7 to 11 and 3.3): one runner git request, from a ticket the proxy has already verified to a
 * minted installation token. Order: the target (must be a git target for the ticket's own repository), the body encoding, the upload-pack
 * body (inflated with a cap, then parsed), the database lookup of the lease, the rename check, the runner policy, the daily byte budget,
 * the mint. Nothing is minted before every earlier check passed.
 *
 * `run`, `generation`, `repo` and `ref` come ONLY from the verified ticket; role, product, installation and the repository's current name come
 * from the database for that lease. Every denial carries a closed reason that the caller reports; none carries a token, a claim or body text.
 */

/** The most a runner request body may be, compressed or not, and the most a gzip body may inflate to. */
export const MAX_RUNNER_GIT_BODY_BYTES = 4_194_304;

export type RunnerGitDenyReason =
  | "runner_path_refused"
  | "runner_query_refused"
  | "runner_repo_mismatch"
  | "runner_content_encoding"
  | "runner_inflate_refused"
  | "runner_upload_pack_unparsable"
  | "runner_lease_unresolved"
  | "runner_policy_denied"
  | "runner_mint_failed"
  | "installation_not_writable"
  | "runner_upstream_unavailable"
  | "lease_stale"
  | "lease_ended"
  | "runner_revoked"
  | "clone_limited"
  | "clone_bytes_limited";

export type RunnerGitDecision =
  | {
      allow: true;
      upstreamHost: "github.com";
      installationToken: string;
      /** The validated query map, the one the forwarded query string is rebuilt from. */
      query: Record<string, string>;
      /** True only for a gzip body on a POST to `git-upload-pack`: the one case where the header travels on, with the original bytes. */
      forwardContentEncoding: boolean;
      /** True for a POST to `git-upload-pack`: its response bytes count against the repository's daily budget. */
      meterResponse: boolean;
    }
  | { allow: false; status: 401 | 403 | 409 | 429 | 502; reason: RunnerGitDenyReason; retryAfterSeconds?: number };

export interface RunnerGitDecisionInput {
  method: string;
  /** The path after `/api/gh-proxy`, exactly as received. */
  path: string;
  query: ProxyDecisionQuery;
  /** The exact request bytes (already capped at `MAX_RUNNER_GIT_BODY_BYTES`). */
  rawBody: Uint8Array;
  /** The raw `Content-Encoding` header, or null when absent. */
  contentEncoding: string | null;
  ticket: RunnerGitTicketClaims;
}

export interface RunnerGitDecisionDeps {
  resolveRunnerGit: RunnerGitResolver;
  appCredentials: AppCredentialsSource;
  tokenCache: InstallationTokenCache;
  accessTokenRequester: AccessTokenRequester;
  cloneBudget: RunnerCloneBudget;
  now?: () => number;
}

const deny = (status: 401 | 403 | 409 | 429 | 502, reason: RunnerGitDenyReason, retryAfterSeconds?: number): RunnerGitDecision =>
  retryAfterSeconds === undefined ? { allow: false, status, reason } : { allow: false, status, reason, retryAfterSeconds };

/** The request body as the git server would read it: inflated when it is gzip, with a hard cap on the output. Null when it cannot be. */
function inflateBounded(raw: Uint8Array): Uint8Array | null {
  try {
    return gunzipSync(raw, { maxOutputLength: MAX_RUNNER_GIT_BODY_BYTES });
  } catch {
    // fx-swallow-ok: a body that does not inflate within the cap is refused by the caller under its own closed reason
    return null;
  }
}

export async function decideRunnerGitRequest(input: RunnerGitDecisionInput, deps: RunnerGitDecisionDeps): Promise<RunnerGitDecision> {
  const now = deps.now ?? Date.now;
  const { ticket } = input;

  const query = normalizeQuery(input.query);
  if (query === null) return deny(403, "runner_query_refused");
  const target = parseTarget(input.path, query);
  if (!target || target.kind !== "git") return deny(403, "runner_path_refused");
  if (!isQueryAllowed("git", query)) return deny(403, "runner_query_refused");
  if (target.owner !== ticket.repo.owner || target.repo !== ticket.repo.name) return deny(403, "runner_repo_mismatch");

  const isUploadPackPost = target.endpoint === "git-upload-pack" && input.method === "POST";
  const isReceivePackPost = target.endpoint === "git-receive-pack" && input.method === "POST";

  // Only `identity` or `gzip` ever; gzip only where git itself compresses (an upload-pack request over 1 KiB).
  const encoding = input.contentEncoding === null ? null : input.contentEncoding.toLowerCase();
  if (encoding !== null && encoding !== "identity" && !(encoding === "gzip" && isUploadPackPost)) return deny(403, "runner_content_encoding");
  const forwardContentEncoding = encoding === "gzip";

  let fullClone = false;
  if (isUploadPackPost) {
    const body = forwardContentEncoding ? inflateBounded(input.rawBody) : input.rawBody;
    if (body === null) return deny(403, "runner_inflate_refused");
    const parsed = parseUploadPackRequest(body);
    // Unparsable means unverifiable: refused, never read as "not a full clone".
    if (!parsed.complete) return deny(403, "runner_upload_pack_unparsable");
    fullClone = isFullCloneRequest(parsed);
  }

  const lease = await deps.resolveRunnerGit({
    runnerId: ticket.runnerId,
    accountId: ticket.accountId,
    runId: ticket.runId,
    generation: ticket.leaseGeneration,
    repoId: ticket.repo.id,
    fullClone,
  });
  if (lease === null) return deny(403, "runner_lease_unresolved");
  if (lease.verdict !== "ok") {
    switch (lease.verdict) {
      case "stale":
        return deny(409, "lease_stale");
      case "not_running":
      case "expired":
        return deny(409, "lease_ended");
      case "revoked":
        return deny(401, "runner_revoked");
      case "clone_limited":
        return deny(429, "clone_limited", secondsUntilUtcMidnight(now()));
      default:
        // unknown, not_verified, no_repo, installation_ambiguous: one generic refusal.
        return deny(403, "runner_lease_unresolved");
    }
  }
  // A repository renamed since the ticket was signed no longer matches it.
  if (lease.owner !== ticket.repo.owner || lease.repo !== ticket.repo.name) return deny(403, "runner_repo_mismatch");

  const gitRefUpdates: ParsedRefUpdates | undefined = isReceivePackPost ? parseReceivePackRefUpdates(input.rawBody) : undefined;
  const decision = decideRunner({
    method: input.method,
    path: input.path,
    query,
    role: lease.role,
    product: lease.product,
    installation: { owner: lease.owner, repo: lease.repo },
    ticketRef: ticket.ref,
    ...(gitRefUpdates ? { gitRefUpdates } : {}),
  });
  if (!decision.allow || !decision.tokenScope) return deny(403, "runner_policy_denied");

  if (isUploadPackPost) {
    // The enforced limit (C28 section 3): bytes already streamed today. A repository over its allowance is refused before any mint or forward;
    // an answer that cannot be had refuses too.
    const spent = await deps.cloneBudget.isSpent(ticket.repo.id);
    if (spent === null) return deny(403, "runner_lease_unresolved");
    if (spent) return deny(429, "clone_bytes_limited", secondsUntilUtcMidnight(now()));
  }

  let installationToken: string;
  try {
    installationToken = await getInstallationToken({
      installationId: lease.installationId,
      appKind: lease.appKind,
      purpose: "runner_git",
      role: lease.role,
      scope: decision.tokenScope,
      appCredentials: deps.appCredentials,
      requester: deps.accessTokenRequester,
      cache: deps.tokenCache,
      now: deps.now,
    });
  } catch (err) {
    // fx-swallow-ok: every branch below is a refusal the caller reports by its closed code; the mint error itself is logged by class and fixed code only
    if (err instanceof MintTimeoutError) return deny(502, "runner_upstream_unavailable");
    if (err instanceof InstallationNotWritableError) return deny(403, "installation_not_writable");
    // The class and, for the two classes whose message is a fixed code, that code. Never a token, a key or upstream text.
    const fixedCode =
      err instanceof AppCredentialsError || err instanceof InstallationTokenError ? err.message.replace(/[^A-Za-z0-9_ ():-]/g, "").slice(0, 80) : undefined;
    console.warn("gh-proxy: runner token mint failed", { error: err instanceof Error ? err.name : "unknown", ...(fixedCode ? { code: fixedCode } : {}) });
    return deny(403, "runner_mint_failed");
  }

  return { allow: true, upstreamHost: "github.com", installationToken, query, forwardContentEncoding, meterResponse: isUploadPackPost };
}
