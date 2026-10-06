import { isOperatorTokenShape } from "@fx/runtime/src/operatorSubscription.js";
import type { ConnectionKind, Product, Role } from "./types.js";

/**
 * D#2 H09 pass/fail 2: "networkPolicy(role, product, connection) is
 * deny-by-default. The only allowed destinations are the tenant's model
 * endpoint (ai-gateway.vercel.sh with an Authorization transform for
 * ai_gateway, or api.anthropic.com with an x-api-key transform for
 * anthropic, never both), GitHub hosts via forwardURL to our proxy, and a
 * package-registry allowlist during the `fx test` install phase only. A
 * test asserts no policy contains a `*` rule for any role."
 *
 * "Deny-by-default" is a property of the CALLER, not of this function's
 * return type: `networkPolicy` never returns a wildcard rule, so a
 * firewall/sandbox network layer that denies anything not explicitly
 * listed here is, by construction, deny-by-default. This module has no
 * way to enforce that the caller actually treats the list that way (that
 * is H13's job, not built yet) -- it only guarantees the list itself
 * never asks for more than the three named categories.
 *
 * Matches packages/runtime/src/production/guard.ts's
 * `ALLOWED_BASE_URL_BY_PROVIDER` exactly (same two hosts, same provider
 * keys) -- that module is H04's, and is the authority on what a
 * `SandboxSpec.baseUrl` is allowed to be; this module is H09's own
 * network-policy authority, over the same two hosts, for the same reason.
 * Kept as a separate, duplicated small table rather than importing guard.ts
 * (an H04 `production/` internal, not part of @fx/runtime's public-ish
 * surface) so a change to H04's production guard cannot silently change
 * H09's network policy without a reviewer seeing both diffs.
 */
const MODEL_HOST_BY_PROVIDER: Readonly<Record<ConnectionKind, string>> = Object.freeze({
  ai_gateway: "ai-gateway.vercel.sh",
  anthropic: "api.anthropic.com",
  // The operator's own subscription: the same Anthropic host, a bearer token instead of a key.
  operator_subscription: "api.anthropic.com",
});

const MODEL_AUTH_HEADER_BY_PROVIDER: Readonly<Record<ConnectionKind, string>> = Object.freeze({
  ai_gateway: "Authorization",
  anthropic: "x-api-key",
  operator_subscription: "Authorization",
});

/** Package registries allowed only during the `fx test` dependency-install
 * phase (Spec pass/fail 2) -- never during the run itself.
 *
 * TODO(H09 security review, "informational" 2): `npm.pkg.github.com` is
 * reached directly here, not through the GitHub proxy, and both
 * registries also accept publishes during this install-phase window --
 * a way to send data out, not just pull dependencies in. Consider
 * GET-only access or a pull-through mirror once the real firewall (H13)
 * is wired up. Left as a TODO, not a code change, per the fix-round scope
 * for this PR -- changing the registry policy itself is out of scope
 * here. */
export const INSTALL_PHASE_REGISTRY_ALLOWLIST: readonly string[] = Object.freeze([
  "registry.npmjs.org",
  "npm.pkg.github.com",
]);

export type NetworkPolicyPurpose = "model" | "github_proxy" | "package_registry";

export interface NetworkPolicyRule {
  /** Exact host this rule allows -- never a wildcard, never a pattern. */
  host: string;
  purpose: NetworkPolicyPurpose;
  /** Present only for the `model` rule: the header the firewall injects
   * the tenant's brokered key under. The sandbox itself never sees the
   * key value -- see firewallPolicy.ts. */
  authHeader?: string;
  /**
   * H14c-3-1 (CARRY-12): the header VALUE for `authHeader` -- the brokered
   * tenant key, the one place it rides. Set by `buildFirewallPolicy` as a
   * NON-ENUMERABLE property, so a serialised, spread, logged or deep-compared
   * policy never shows it; only the sandbox port reads it, by name, to build
   * the SDK header transform for this exact host. Absent on every rule but the
   * model rule.
   */
  readonly authValue?: string;
}

/** The header value the model host expects for `key`: a bearer token for the
 * gateway and for the operator subscription, the raw key for Anthropic. A key
 * that is not one printable ASCII token (a CR/LF or space would split or forge
 * a header) is unusable, and the operator subscription takes only a value
 * shaped like a subscription token. In operator mode the CLI holds a
 * placeholder OAuth token, so it sends the OAuth beta header itself and only
 * the Authorization header is replaced here. */
export function modelAuthValue(provider: ConnectionKind, key: string): string | undefined {
  if (!/^[\x21-\x7e]+$/.test(key)) return undefined;
  if (provider === "operator_subscription") return isOperatorTokenShape(key) ? `Bearer ${key}` : undefined;
  return provider === "ai_gateway" ? `Bearer ${key}` : key;
}

/** The tenant's model connection, as far as `networkPolicy` needs to know
 * about it: which provider, and (for GitHub) the URL of OUR OWN proxy the
 * sandbox forwards GitHub-shaped requests to -- never `github.com` or
 * `api.github.com` directly (H13, not built yet, is what actually holds a
 * GitHub credential and talks to GitHub). */
export interface Connection {
  provider: ConnectionKind;
  /** Our GitHub proxy's own forward URL/host for this installation. Never
   * a raw GitHub host -- see the module doc comment. Validated by
   * `assertStrictGithubForwardHost` below on every call: this field is
   * caller-supplied (it varies per installation, per the doc comment
   * above), so it cannot be hoisted to a single module-level constant --
   * it must be checked every time instead. */
  githubForwardHost?: string;
}

export type NetworkPolicyPhase = "run" | "install";

/**
 * The only GitHub hosts the agent's clone/push and gh calls use, and so the
 * only ones forwarded to our proxy: exact names, never a suffix, so the rule
 * cannot capture codeload.github.com or the githubusercontent.com download
 * hosts (the proxy holds installation tokens and must not see those).
 */
export const GITHUB_FORWARDED_HOSTS: readonly string[] = Object.freeze(["github.com", "api.github.com"]);

/**
 * The forwardURL for a `github_proxy` rule's host: the one definition of the
 * value the proxy later checks as the OIDC audience (`githubProxyForwardUrl`
 * in githubForwardConfig.ts delegates here). No query string or fragment,
 * which the SDK's forwardURL type forbids. Validates the host first.
 */
export function githubForwardUrlForHost(host: string): string {
  assertStrictGithubForwardHost(host);
  return `https://${host}/api/gh-proxy`;
}

/** Names `githubForwardHost` must never equal, or be a subdomain of: the
 * two model hosts, the install-phase registries, and the two GitHub
 * domain apexes (`github.com` covers `api.github.com` and every other
 * `*.github.com` host as a suffix; `githubusercontent.com` covers
 * `raw.githubusercontent.com` / `objects.githubusercontent.com` the same
 * way, and is itself also a forbidden host -- the H09 security re-review
 * found the old suffix-only check rejected `*.githubusercontent.com` but
 * let the bare apex through). Built once from the tables above, rather
 * than duplicated, so this list can't drift out of sync with
 * `MODEL_HOST_BY_PROVIDER` / `INSTALL_PHASE_REGISTRY_ALLOWLIST`. Matched
 * at label boundaries by `isReservedForwardHost` below, never by
 * substring -- see that function's own comment for why.
 *
 * Exported (D#66) for external reuse (`githubForwardConfig.ts` keeps a
 * pinned duplicate rather than a real import -- see that file's own doc
 * comment for why `test/importBoundary.test.ts`'s existing boundary rules
 * out importing this module directly from there; a future caller that
 * ISN'T subject to that boundary can import this export normally). */
export const RESERVED_FORWARD_HOST_NAMES: readonly string[] = Object.freeze([
  ...Object.values(MODEL_HOST_BY_PROVIDER),
  ...INSTALL_PHASE_REGISTRY_ALLOWLIST,
  "github.com",
  "githubusercontent.com",
]);

/**
 * ASCII hostname syntax, and nothing looser (H09 security re-review,
 * "must fix" 1: the first round's check was a denylist over the exact
 * strings a test happened to spell out, so `github.com.` (a trailing
 * dot -- the identical DNS name), `GITHUB.COM` in upper case, a port
 * (`github.com:443`), a scheme/path/userinfo (`https://github.com`,
 * `github.com/x`, `user@github.com`), whitespace or a comma-joined list,
 * an IDNA/UTS-46 lookalike (fullwidth `ｇｉｔｈｕｂ.ｃｏｍ`, an
 * ideographic full stop, `gıthub.com`), and IP literals in every form
 * (dotted `140.82.112.3`, bracketed IPv6, hex `0x8c527003`, decimal
 * `2354212867`) all slipped past it unchanged).
 *
 * This regex requires: only lowercase `a`-`z`, `0`-`9` and `-`; each
 * label 1-63 characters, never starting or ending with `-`; at least one
 * dot and no trailing one; the whole value 1-253 characters; and the
 * final label starts with a letter. That last clause is what rules out
 * every IP-literal shape above without a separate IP parser -- a dotted
 * IPv4 address, a bare decimal or hex integer, and a bracketed IPv6
 * literal all either have no dot at all or end in a label that starts
 * with a digit or `[`/`:`, none of which this pattern accepts. Anything
 * not in this exact lowercase-ASCII-LDH shape is refused outright, never
 * normalized or trimmed -- normalizing before comparison is exactly what
 * let the trailing-dot and upper-case variants through the first time.
 *
 * Exported (D#66) for external reuse (`githubForwardConfig.ts` keeps a
 * pinned duplicate of this exact pattern rather than a real import -- see
 * that file's own doc comment). */
export const STRICT_HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** True when `host` (already known to be a syntactically valid hostname)
 * IS `name`, or is a subdomain of it. Matching `.${name}` as a suffix --
 * never a bare `endsWith(name)` -- is what keeps this at a label
 * boundary: `evilgithubusercontent.com` does not end with
 * `.githubusercontent.com`, only `x.githubusercontent.com` does, so a
 * host that merely CONTAINS a reserved name as a substring is never
 * mistaken for a subdomain of it. */
function isReservedForwardHost(host: string, name: string): boolean {
  return host === name || host.endsWith(`.${name}`);
}

/**
 * Strict-hostname check for `Connection.githubForwardHost` (H09 security
 * review, "must fix" 1): first requires the value to be a syntactically
 * strict, already-lowercase ASCII hostname (`STRICT_HOSTNAME_RE` above --
 * this alone is what closes the trailing-dot, port, scheme, userinfo,
 * whitespace, comma, non-ASCII-lookalike and every IP-literal bypass the
 * re-review found), then rejects it if it IS or is a subdomain of any
 * reserved name -- the two model hosts, the install-phase registries, or
 * the `github.com` / `githubusercontent.com` apexes -- so a caller can
 * never make `networkPolicy` return a wildcard rule, a second model
 * host, the package registry outside the install phase, or a route
 * around our own GitHub proxy straight to GitHub.
 */
function assertStrictGithubForwardHost(host: string): void {
  if (typeof host !== "string" || host.length === 0) {
    throw new Error(`networkPolicy: githubForwardHost must be a non-empty hostname, got ${JSON.stringify(host)}`);
  }
  if (!STRICT_HOSTNAME_RE.test(host)) {
    throw new Error(
      `networkPolicy: githubForwardHost must be a strict lowercase ASCII hostname (no scheme, port, path, userinfo, whitespace, trailing dot, wildcard or IP literal), got ${JSON.stringify(host)}`,
    );
  }
  if (RESERVED_FORWARD_HOST_NAMES.some((name) => isReservedForwardHost(host, name))) {
    throw new Error(`networkPolicy: githubForwardHost must not be a model/registry/GitHub host, got ${JSON.stringify(host)}`);
  }
}

// NOTE (H09 security re-review, "must fix" 1's "stronger still" option):
// the operator-configured proxy-domain suffix allowlist this comment used
// to describe as future work is now built -- see `githubForwardConfig.ts`
// (D#66).

/**
 * Deny-by-default network policy for one role's sandbox: an explicit,
 * finite allowlist and nothing else. Never includes a `*`/wildcard rule
 * (see `test/networkPolicy.test.ts`'s
 * "no policy contains a wildcard rule" test, which iterates every role x
 * product x provider combination).
 */
export function networkPolicy(
  role: Role,
  product: Product,
  connection: Connection,
  phase: NetworkPolicyPhase = "run",
): NetworkPolicyRule[] {
  void role; // Reserved for a future per-role narrowing (e.g. a read-only
  // role that should never reach the package registry even during
  // install). No H09 pass/fail item narrows by role today -- every role
  // gets the same three categories -- so this parameter is accepted (the
  // Spec's own signature: `networkPolicy(role, product, connection)`) but
  // not yet used to vary the result.
  void product; // Same: reserved, not yet used to vary the result -- Sitekit
  // ("sitekit" product) has no different network shape from "team" in any
  // H09 pass/fail item.

  // `Object.hasOwn` (not a plain index/`in` check) so a prototype-chain
  // name -- "constructor", "toString", "hasOwnProperty", "__proto__" --
  // is rejected as unknown rather than resolving to an inherited
  // `Object.prototype` member (H09 security review, "must fix" 1).
  if (!Object.hasOwn(MODEL_HOST_BY_PROVIDER, connection.provider)) {
    throw new Error(`networkPolicy: unknown model provider "${String(connection.provider)}"`);
  }
  const host = MODEL_HOST_BY_PROVIDER[connection.provider];

  const rules: NetworkPolicyRule[] = [
    {
      host,
      purpose: "model",
      authHeader: MODEL_AUTH_HEADER_BY_PROVIDER[connection.provider],
    },
  ];

  // Fail closed: with no forward host configured (omitted entirely) there is
  // NO GitHub rule, so the sandbox has no GitHub access at all. A host that
  // is present but malformed still throws.
  if (connection.githubForwardHost !== undefined) {
    assertStrictGithubForwardHost(connection.githubForwardHost);
    rules.push({ host: connection.githubForwardHost, purpose: "github_proxy" });
  }

  if (phase === "install") {
    for (const registryHost of INSTALL_PHASE_REGISTRY_ALLOWLIST) {
      rules.push({ host: registryHost, purpose: "package_registry" });
    }
  }

  return rules;
}
