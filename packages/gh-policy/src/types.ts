/**
 * Types for the GitHub proxy policy engine.
 *
 * This module is pure: no network, no filesystem, no process access. It only
 * makes decisions from the data it is handed. The proxy function (H13) is
 * the caller that owns talking to GitHub and to the sandbox.
 *
 * ## Trust boundary (fix round 3, item W5 — docs only, no code here enforces this)
 *
 * `gitRefUpdates`, `labelNames` and `patchFields` are the ONLY windows this
 * pure module has into a request body it never parses itself. Every
 * security property this package proves (label ownership, patch-field
 * allowlists, fx/* push scoping) is proved ASSUMING these three fields are
 * an honest, complete account of that body — this module has no way to
 * verify that assumption itself, because verifying it requires the real
 * HTTP request and body, which a pure decision function deliberately never
 * touches. The caller (H13's proxy function) is the trust boundary, and it
 * MUST:
 *
 *   1. Derive each field from the EXACT parsed JSON body (or, for
 *      `gitRefUpdates`, the exact pkt-line body) of the SAME request being
 *      decided — never from a cached, assumed, or partially-read version.
 *   2. Deny the request outright when the body is missing, fails to parse,
 *      or parses to something other than the expected shape (e.g. JSON
 *      that isn't an object) — never fall back to treating an unparsable
 *      body as "no fields" or "an empty array." An engine that can't see a
 *      `labels` field is not the same thing as a body that has none.
 *   3. Forward the body to GitHub BYTE-IDENTICAL to what was parsed. If the
 *      proxy parses one JSON object to build `patchFields` but forwards a
 *      re-serialized (or otherwise different) body, `decide()`'s approval
 *      is an approval of a request that was never actually made — the same
 *      failure mode `canonicalPath.ts` exists to prevent for the URL path,
 *      just for the body instead.
 *
 * See `README.md` for the same guarantee stated for integrators reading the
 * package from outside.
 */

/** The two products a repo can be attached to. Sitekit is read-only. */
export type Product = "team" | "sitekit";

/** GitHub App installation-permission verbs the token can be scoped to. */
export type PermissionLevel = "read" | "write";

/** A minimal set of GitHub App granular permission names this engine cares about. */
export type PermissionName =
  | "metadata"
  | "contents"
  | "issues"
  | "pull_requests"
  | "discussions";

/** One ref update requested by a `git-receive-pack` push. */
export interface RefUpdate {
  ref: string;
  old: string;
  new: string;
}

/**
 * The result of parsing a `git-receive-pack` pkt-line body. `complete` is
 * true only when the parser actually reached a clean flush-pkt with every
 * intervening line well-formed — a malformed length, a truncated line, or
 * running out of bytes before the flush-pkt all set it false. A caller
 * (`decide()`) must treat `complete: false` as "cannot verify", not as
 * "zero ref updates", and deny accordingly.
 */
export interface ParsedRefUpdates {
  updates: RefUpdate[];
  complete: boolean;
}

/** The installation this request is scoped to: always exactly one repo. */
export interface InstallationTarget {
  owner: string;
  repo: string;
}

/** A normalized request the proxy asks the policy engine to decide on. */
export interface ProxyRequest {
  method: string;
  /** The `Host` header the client sent. */
  host: string;
  /** The SNI hostname the TLS handshake actually used. */
  sniHost: string;
  path: string;
  query?: Record<string, string>;
  role: string;
  product: Product;
  installation: InstallationTarget;
  /**
   * Ref updates parsed from a `git-receive-pack` request body, if any.
   * TRUST BOUNDARY: see the module docstring above — must come from the
   * exact pkt-line body of this same request, and that same body is what
   * must reach GitHub if this call is allowed.
   */
  gitRefUpdates?: ParsedRefUpdates;
  /**
   * Label names a labels-mutating request would add or replace, parsed by
   * the caller from the JSON body (mirrors how `gitRefUpdates` is parsed
   * from the pkt-line body rather than re-parsed here). Not needed for a
   * single-label DELETE, whose target is already in the path.
   * TRUST BOUNDARY: see the module docstring above — must come from the
   * exact parsed JSON body of this same request, and that same body is
   * what must reach GitHub if this call is allowed.
   */
  labelNames?: string[];
  /**
   * The field names a PATCH on an issue or PR body would set, parsed by the
   * caller from the JSON body the same way `labelNames` is. `decide()` never
   * sees the body itself, so a PATCH with this omitted is denied outright —
   * "I can't tell what fields this would touch" is never treated as "so it
   * must be safe."
   * TRUST BOUNDARY: see the module docstring above — must come from the
   * exact parsed JSON body of this same request, and that same body is
   * what must reach GitHub if this call is allowed.
   */
  patchFields?: string[];
}

/** The token scope the proxy should mint or reuse when a request is allowed. */
export interface TokenScope {
  repositories: [string];
  permissions: Partial<Record<PermissionName, PermissionLevel>>;
}

/** The engine's verdict on one proxied request. */
export interface Decision {
  allow: boolean;
  reason: string;
  tokenScope?: TokenScope;
}
