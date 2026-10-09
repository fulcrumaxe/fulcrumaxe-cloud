import { createPrivateKey } from "node:crypto";
import { SignJWT, importPKCS8 } from "jose";
import type { TokenScope } from "@fx/gh-policy";
import type { AppCredentialsSource } from "./appCredentials.js";
import { assertWriteInstallation } from "./writeInstallation.js";

/**
 * D#2 H13b, body criteria 3 and 4, and sec-criteria B4. Mints the GitHub
 * App JWT and, from it, a per-role, one-repo installation access token.
 *
 * Body criterion 4: `mintAppJwt` below is the ONLY place `privateKeyPem`
 * is read; every error this module throws is a fixed message with no
 * `cause`, so a bad/malformed key never gets echoed into a thrown error,
 * a log line or an HTTP response.
 *
 * B4: the cache key includes `role`, so a token cached for one role's
 * `decide()` `tokenScope` is never handed to a different role's request,
 * even against the same installation and repo.
 */

/** What a failed mint may pass on for diagnostics: the HTTP status and a letters-only message, nothing else. */
function refusalDiagnostic(err: unknown): { name: string; status: number; ghMessage?: string } | undefined {
  const e = (err && typeof err === "object" ? err : {}) as { status?: unknown; ghMessage?: unknown };
  if (typeof e.status !== "number" || !Number.isInteger(e.status) || e.status < 100 || e.status > 599) return undefined;
  const ghMessage = typeof e.ghMessage === "string" && /^[A-Za-z ]{1,80}$/.test(e.ghMessage) ? e.ghMessage : undefined;
  return { name: "MintRefused", status: e.status, ...(ghMessage ? { ghMessage } : {}) };
}

export class InstallationTokenError extends Error {
  readonly reason: string;
  constructor(reason: string, options?: { cause?: unknown }) {
    super(`installationToken: ${reason}`, options);
    this.name = "InstallationTokenError";
    this.reason = reason;
  }
}

/**
 * D#2 Correction C28 §3 item 8: the mint call has its own timeout (10s,
 * `MINT_TIMEOUT_MS` in the route's handler, the only place that actually
 * runs a timer). A `requester` that times out throws this -- exported so
 * `getInstallationToken` below can tell it apart from every OTHER
 * requester failure (a 401, a network error, a malformed response) and
 * re-throw it AS ITSELF rather than collapsing it into the generic
 * `InstallationTokenError("mint_failed")` those get. That distinction is
 * what lets `decideProxyRequest` answer a mint TIMEOUT with 502
 * `upstream_unavailable` while every other mint failure still denies with
 * 403 `token_mint_failed`, unchanged from before this correction.
 */
export class MintTimeoutError extends Error {
  constructor() {
    super("installationToken: mint_timeout");
    this.name = "MintTimeoutError";
  }
}

/**
 * GitHub accepts both PKCS#1 ("BEGIN RSA PRIVATE KEY") and PKCS#8
 * ("BEGIN PRIVATE KEY") App key exports; jose's `importPKCS8` only reads
 * the latter. `node:crypto`'s `createPrivateKey` parses either and
 * re-exports PKCS#8, so this never depends on which format the operator
 * downloaded -- and never adds a dependency to do it.
 */
function toPkcs8Pem(pem: string): string {
  try {
    return createPrivateKey(pem).export({ type: "pkcs8", format: "pem" }).toString();
  } catch {
    throw new InstallationTokenError("private_key_invalid");
  }
}

/**
 * The App-level JWT GitHub's `/app/installations/{id}/access_tokens`
 * endpoint requires as bearer auth. `exp` is capped well under GitHub's
 * 10-minute ceiling; `iat` is backdated 60s for clock skew, the same
 * margin GitHub's own docs recommend.
 */
export async function mintAppJwt(
  appId: string,
  privateKeyPem: string,
  now: () => number = Date.now,
): Promise<string> {
  const key = await importPKCS8(toPkcs8Pem(privateKeyPem), "RS256");
  const iatSec = Math.floor(now() / 1000) - 60;
  const expSec = iatSec + 540;
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt(iatSec)
    .setExpirationTime(expSec)
    .setIssuer(appId)
    .sign(key);
}

export interface MintedAccessToken {
  token: string;
  /** ISO-8601, as GitHub's API returns it. */
  expiresAt: string;
  /**
   * The permissions GitHub says the minted token holds (the `permissions` object of the mint response). Only the
   * `plan_read` purpose needs it: that purpose refuses a token that holds anything but `read`, and refuses a mint
   * response that does not say (D#483 S3, E2).
   */
  permissions?: Readonly<Record<string, string>>;
}

/**
 * Calls GitHub's installation access-token endpoint. Injected rather than
 * hardcoded to `fetch` so the real implementation (in the route's handler)
 * can go through O3's pinned connector -- this is itself an "upstream
 * connection to GitHub" that O3 covers, not just the proxied request.
 */
export type AccessTokenRequester = (params: {
  installationId: number;
  appJwt: string;
  /** One repo name, or null for an installation-wide token (only `WideScope` produces null). */
  repositories: TokenScope["repositories"] | null;
  /** Permission name to level. `TokenScope` permissions are a subset; the `merge_gate` purpose adds the check, status and administration reads and the status write. */
  permissions: Readonly<Record<string, "read" | "write">>;
}) => Promise<MintedAccessToken>;

/**
 * The explicit installation-wide variant, for the repo sync's listing call
 * only. Read-only metadata by type, so a wide token can never carry a write.
 */
export interface WideScope {
  installationWide: true;
  permissions: { metadata: "read" };
}
const isWide = (s: TokenScope | WideScope): s is WideScope => "installationWide" in s;

/** The merge gate's scope: one repository and the fixed merge-gate permissions (built inside `getInstallationToken`, never taken from a caller). */
interface MergeGateScope {
  repositories: TokenScope["repositories"];
  permissions: Readonly<Record<string, "read" | "write">>;
}

interface CacheEntry {
  token: string;
  expiresAtMs: number;
}

/**
 * A tiny in-memory cache, module-instance-scoped (a warm Vercel Function
 * invocation reuses it; a cold start starts empty -- "caches" per body
 * criterion 3, never persisted anywhere durable). Keyed by installation +
 * role + repo + the exact permission set, so two different roles (or two
 * different permission scopes for the same role) never collide.
 */
export class InstallationTokenCache {
  private readonly entries = new Map<string, CacheEntry>();

  private static keyFor(installationId: number, appKind: string, role: string, scope: TokenScope | WideScope | MergeGateScope, namespace: string): string {
    const perms = Object.entries(scope.permissions)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    // A namespace (the runner git purpose) keeps its tokens apart from a sandbox run's: same role and same permissions, different authority.
    return `${namespace}${appKind}:${installationId}:${role}:${isWide(scope) ? "*wide*" : scope.repositories[0]}:${perms}`;
  }

  get(installationId: number, appKind: string, role: string, scope: TokenScope | WideScope | MergeGateScope, nowMs: number, namespace = ""): string | undefined {
    const entry = this.entries.get(InstallationTokenCache.keyFor(installationId, appKind, role, scope, namespace));
    if (!entry || entry.expiresAtMs <= nowMs) return undefined;
    return entry.token;
  }

  set(
    installationId: number,
    appKind: string,
    role: string,
    scope: TokenScope | WideScope | MergeGateScope,
    token: string,
    expiresAtMs: number,
    namespace = "",
  ): void {
    this.entries.set(InstallationTokenCache.keyFor(installationId, appKind, role, scope, namespace), { token, expiresAtMs });
  }
}

/**
 * D#2 H13e: what a minted token is for. `run` covers gh-proxy (every sandbox
 * GitHub request), PRs, merges and Discussion writes, and needs the write
 * (`team`) App. `preview_read` is H17's read-only preview and needs the
 * `team_readonly` App. `sitekit_read` is the site-kit App's read-only access
 * (repo sync first) and needs the `sitekit` App; that App never gets `run`.
 *
 * D#483 P3: `merge_gate` is the stage driver's merge gate and nothing else: it needs the write (`team`) App and a fixed
 * permission set no other purpose may ask for (see MERGE_GATE_PERMISSIONS). It exists so the check-run, status and
 * branch-protection reads, and the commit-status write, are NOT in the allowlist of every other purpose.
 */
export const MINT_PURPOSES = ["run", "preview_read", "sitekit_read", "merge_gate", "plan_read", "runner_git"] as const;
export type MintPurpose = (typeof MINT_PURPOSES)[number];

/**
 * D#2 RC-1a (C64 section 3): the only permission keys an installation token
 * may ever request. Repo creation runs on the customer's user token, so no
 * purpose asks for `administration` (or a future creation key); a key outside
 * this list is refused before any credential is read.
 */
export const ALLOWED_TOKEN_PERMISSIONS: readonly string[] = ["metadata", "contents", "issues", "pull_requests", "discussions"];

/**
 * D#483 P3: the only permissions a `merge_gate` token ever asks for, whatever the caller's scope says. Reads: check runs
 * (`checks`), commit statuses and branch protection (`administration`, read only: GitHub serves protection and ruleset
 * reads under it). Writes: commit statuses (the platform's own `fulcrumaxe/review` status, owner ruling B), and
 * `contents` and `pull_requests` (the merge itself, made only when auto-merge is allowed). These keys are valid ONLY for
 * this purpose: `ALLOWED_TOKEN_PERMISSIONS` (every other purpose) holds none of `checks`, `statuses` or `administration`.
 */
export const MERGE_GATE_PERMISSIONS: Readonly<Record<string, "read" | "write">> = Object.freeze({
  metadata: "read",
  checks: "read",
  statuses: "write",
  administration: "read",
  contents: "write",
  pull_requests: "write",
});

/** The only permission keys a `runner_git` token may ask for. GitHub itself refuses a push that touches .github/workflows/** for want of `workflows`. */
const RUNNER_GIT_PERMISSION_KEYS: readonly string[] = ["metadata", "contents"];

/** The only permissions a `preview_read` token ever asks for: reads, never a write. Issues are read because the preview prompt lists open issues. */
const PREVIEW_READ_PERMISSIONS: TokenScope["permissions"] = { metadata: "read", contents: "read", issues: "read" };

/**
 * D#483 S3 (M0, E1): the only permissions a `plan_read` token ever asks for, whatever the caller's scope says. The
 * importer reads the repository's roadmap file (contents), its issues and pull requests (the issues list carries both)
 * and its Discussions. Every value is `read`, and the mint refuses a response that says otherwise (`token_not_read_only`).
 * `pull_requests: read` is included (owner ruling Q-S3-2, 2026-10-05): the read App was granted it, and the importer
 * needs merged-PR evidence (`merged_at`, the PR body) to decide done from remaining. Read-only, like `issues`.
 */
export const PLAN_READ_PERMISSIONS: Readonly<Record<string, "read">> = Object.freeze({
  metadata: "read",
  contents: "read",
  issues: "read",
  pull_requests: "read",
  discussions: "read",
});

/** The only permissions a `sitekit_read` token ever asks for: reads, never a write. */
const SITEKIT_READ_PERMISSIONS: TokenScope["permissions"] = { metadata: "read", contents: "read" };

/** E2 (D#483 S3): every permission GitHub reports for a `plan_read` token must be exactly `read`, and at least one must be reported. */
export function assertTokenReadOnly(permissions: unknown): asserts permissions is Record<string, "read"> {
  if (permissions === null || typeof permissions !== "object" || Array.isArray(permissions)) throw new InstallationTokenError("token_not_read_only");
  const entries = Object.entries(permissions as Record<string, unknown>);
  if (entries.length === 0 || entries.some(([, level]) => level !== "read")) throw new InstallationTokenError("token_not_read_only");
}

export interface GetInstallationTokenParams {
  installationId: number;
  /** From the `installations` row, never from the request. Anything but the value the purpose requires is refused. */
  appKind: string | null | undefined;
  purpose: MintPurpose;
  role: string;
  scope: TokenScope | WideScope;
  appCredentials: AppCredentialsSource;
  requester: AccessTokenRequester;
  cache: InstallationTokenCache;
  now?: () => number;
}

/** Cached tokens are dropped 5 minutes before GitHub's own expiry, never used right up to the wire. */
const EXPIRY_SAFETY_MARGIN_MS = 5 * 60 * 1000;

export async function getInstallationToken(params: GetInstallationTokenParams): Promise<string> {
  const now = params.now ?? Date.now;
  const nowMs = now();

  // The type pins a WideScope to metadata:read; this pins it at runtime too
  // (a cast or a JSON-shaped value can get past the type). Before any cache or credential use.
  if (isWide(params.scope)) {
    const perms = Object.entries(params.scope.permissions as Record<string, unknown>);
    if (perms.length !== 1 || perms[0]![0] !== "metadata" || perms[0]![1] !== "read") {
      throw new InstallationTokenError("wide_scope_not_metadata_read");
    }
  }

  // The purpose check runs before the cache and before any credential is
  // read, so a refused kind gets no token and no GitHub call.
  let scope: TokenScope | WideScope | MergeGateScope = params.scope;
  let appKind: string;
  let allowed: readonly string[] = ALLOWED_TOKEN_PERMISSIONS;
  let namespace = "";
  if (params.purpose === "merge_gate") {
    // The write App, one repository, a fixed permission set. A wide scope has no business here.
    assertWriteInstallation(params.appKind);
    if (isWide(params.scope)) throw new InstallationTokenError("purpose_not_allowed");
    scope = { repositories: params.scope.repositories, permissions: MERGE_GATE_PERMISSIONS };
    allowed = Object.keys(MERGE_GATE_PERMISSIONS);
    appKind = params.appKind;
  } else if (params.purpose === "run") {
    assertWriteInstallation(params.appKind);
    appKind = params.appKind;
  } else if (params.purpose === "runner_git") {
    // D#6 R5a-2c: a runner's git request, on the write App, for one repository and `metadata` and `contents` only. A scope that names anything
    // else (workflows, pull_requests) is refused below, and the tokens are cached apart from a sandbox run's.
    assertWriteInstallation(params.appKind);
    if (isWide(params.scope)) throw new InstallationTokenError("purpose_not_allowed");
    allowed = RUNNER_GIT_PERMISSION_KEYS;
    appKind = params.appKind;
    namespace = "runner_git:";
  } else if (params.purpose === "plan_read" && (params.appKind === "team_readonly" || params.appKind === "team")) {
    // D#483 S3: a one-repository, fixed, read-only set. An installation-wide token has no business here.
    if (isWide(params.scope)) throw new InstallationTokenError("purpose_not_allowed");
    scope = { repositories: params.scope.repositories, permissions: PLAN_READ_PERMISSIONS };
    allowed = Object.keys(PLAN_READ_PERMISSIONS);
    appKind = params.appKind;
  } else if (params.purpose === "preview_read" && params.appKind === "team_readonly") {
    // A wide token is already metadata-read only, a subset of what preview_read allows.
    if (!isWide(params.scope)) scope = { repositories: params.scope.repositories, permissions: PREVIEW_READ_PERMISSIONS };
    appKind = params.appKind;
  } else if (params.purpose === "sitekit_read" && params.appKind === "sitekit") {
    if (!isWide(params.scope)) scope = { repositories: params.scope.repositories, permissions: SITEKIT_READ_PERMISSIONS };
    appKind = params.appKind;
  } else {
    throw new InstallationTokenError("purpose_not_allowed");
  }

  if (Object.keys(scope.permissions).some((k) => !allowed.includes(k))) {
    throw new InstallationTokenError("permission_not_allowed");
  }

  const cached = params.cache.get(params.installationId, appKind, params.role, scope, nowMs, namespace);
  if (cached) return cached;

  const credentials = params.appCredentials(appKind);
  const appJwt = await mintAppJwt(credentials.appId, credentials.privateKeyPem, now);
  let minted: MintedAccessToken;
  try {
    minted = await params.requester({
      installationId: params.installationId,
      appJwt,
      repositories: isWide(scope) ? null : scope.repositories,
      permissions: scope.permissions,
    });
  } catch (err) {
    // A timeout is re-thrown as itself (see MintTimeoutError's doc
    // comment) -- every other requester failure keeps collapsing into the
    // generic, no-detail error, exactly as before this correction.
    if (err instanceof MintTimeoutError) throw err;
    // The original error is never attached (its message could carry anything, e.g. a
    // login): only a refused mint's HTTP status and its letters-only upstream message.
    throw new InstallationTokenError("mint_failed", { cause: refusalDiagnostic(err) });
  }

  const expiresAtMs = Date.parse(minted.expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    throw new InstallationTokenError("mint_failed");
  }
  // E2: a read token must be read-only in fact, not only by request. GitHub's own answer is checked, and a response that
  // does not state the permissions is refused, so the token is neither cached nor handed out.
  if (params.purpose === "plan_read") assertTokenReadOnly(minted.permissions);
  params.cache.set(
    params.installationId,
    appKind,
    params.role,
    scope,
    minted.token,
    expiresAtMs - EXPIRY_SAFETY_MARGIN_MS,
    namespace,
  );
  return minted.token;
}
