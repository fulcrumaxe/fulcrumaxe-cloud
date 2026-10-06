import type { Connection } from "./networkPolicy.js";
import { RESERVED_FORWARD_HOST_NAMES, STRICT_HOSTNAME_RE, githubForwardUrlForHost } from "./networkPolicy.js";
import type { ConnectionKind } from "./types.js";

/**
 * D#66: the operator-configured allowlist that replaces the "any
 * syntactically-strict, non-reserved hostname" acceptance
 * `networkPolicy.ts` shipped with H09a. `loadGithubForwardConfig` is the
 * ONLY function that produces a `GithubForwardConfig` -- it is branded
 * with the module-private `BRAND` symbol below, which no other module can
 * spell, so nothing outside this file can construct one by an object
 * literal alone (decision b). That brand is a compile-time device only,
 * though: `assertGithubForwardConfig` re-validates a value's shape at
 * runtime too, so a value forged past the type system with `as unknown as
 * GithubForwardConfig` (criterion 7) still gets refused -- first because
 * it structurally lacks the brand, and, defense in depth, because its
 * `host`/`suffix` are re-checked against the same rules `loadGithubForwardConfig`
 * itself enforces.
 *
 * Decision (a): the value comes ONLY from the process environment (two
 * variables, `FX_GH_FORWARD_SUFFIX` and `FX_GH_FORWARD_HOST`) -- never a
 * database column, a Workflow step input or a tenant setting. This file is
 * the only place in the whole app that may read either name
 * (`test/githubForwardSource.test.ts` proves it), and it is not called
 * from any production file yet -- wiring a real value is H13's job, not
 * this PR's (`test/githubForwardSource.test.ts` criterion (c) again).
 *
 * `STRICT_HOSTNAME_RE`/`RESERVED_FORWARD_HOST_NAMES` are imported from
 * `networkPolicy.ts` (D#66 correction C3): the pre-existing
 * `test/importBoundary.test.ts` now admits this file to
 * `FORBIDDEN_MODULE_FILES` -- the sandbox-module cluster's own internal
 * edges, the set of files allowed a real `networkPolicy.ts` import --
 * with that one exemption line and no other edit to that test file. A
 * pinned duplicate (an earlier round of this PR) was rejected: the copy
 * wasn't frozen and was reachable off the package barrel, so mutating it
 * changed what `loadGithubForwardConfig` accepted (reproduced in the
 * security review that led to this correction). */

const BRAND: unique symbol = Symbol("GithubForwardConfig");

export interface GithubForwardConfig {
  readonly host: string;
  readonly suffix: string;
  readonly [BRAND]: true;
}

/** D#66 security review, should-fix 5 (CWE-290/CWE-693): every config this
 * module has actually issued, tracked by object identity. `BRAND` alone
 * is a forgeable guard -- `Object.getOwnPropertySymbols` recovers it from
 * a real config, and a value built with the recovered symbol then passes
 * a brand-only check even though `loadGithubForwardConfig` never produced
 * it. `assertGithubForwardConfig` requires membership here, which a
 * caller outside this module cannot fake: a `WeakSet` has no public API
 * to add an entry, and this one is never exported. */
const ISSUED = new WeakSet<object>();

export class GithubForwardConfigError extends Error {
  constructor(reason: string) {
    super(`loadGithubForwardConfig: ${reason}`);
    this.name = "GithubForwardConfigError";
  }
}

function isUnderSuffix(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

/** Same label-boundary matching `networkPolicy.ts`'s own
 * `isReservedForwardHost` uses, over the imported
 * `RESERVED_FORWARD_HOST_NAMES` table. */
function isReserved(host: string): boolean {
  return RESERVED_FORWARD_HOST_NAMES.some((name) => host === name || host.endsWith(`.${name}`));
}

function validateHostnameShape(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new GithubForwardConfigError(`${label} must be a non-empty hostname`);
  }
  if (!STRICT_HOSTNAME_RE.test(value)) {
    throw new GithubForwardConfigError(`${label} must be a strict lowercase ASCII hostname`);
  }
}

function validateSuffix(suffix: string): void {
  validateHostnameShape(suffix, "FX_GH_FORWARD_SUFFIX");
  if (suffix.split(".").length < 2) {
    throw new GithubForwardConfigError("FX_GH_FORWARD_SUFFIX must have at least 2 labels");
  }
  if (isReserved(suffix)) {
    throw new GithubForwardConfigError("FX_GH_FORWARD_SUFFIX must not be a model/registry/GitHub host");
  }
}

function validateHost(host: string, suffix: string): void {
  validateHostnameShape(host, "FX_GH_FORWARD_HOST");
  if (isReserved(host)) {
    throw new GithubForwardConfigError("FX_GH_FORWARD_HOST must not be a model/registry/GitHub host");
  }
  if (!isUnderSuffix(host, suffix)) {
    throw new GithubForwardConfigError("FX_GH_FORWARD_HOST must equal the suffix or be a subdomain of it");
  }
}

/**
 * Reads exactly `FX_GH_FORWARD_SUFFIX` and `FX_GH_FORWARD_HOST` from
 * `env` (criterion 5: no other key is read) and throws
 * `GithubForwardConfigError` unless both are present, both pass the
 * strict hostname check, the suffix has at least 2 labels, neither is a
 * reserved model/registry/GitHub host, and the host equals the suffix or
 * is a subdomain of it.
 */
export function loadGithubForwardConfig(env: Readonly<Record<string, string | undefined>>): GithubForwardConfig {
  const suffix = env["FX_GH_FORWARD_SUFFIX"];
  const host = env["FX_GH_FORWARD_HOST"];
  if (typeof suffix !== "string" || suffix.length === 0) {
    throw new GithubForwardConfigError("FX_GH_FORWARD_SUFFIX is required");
  }
  if (typeof host !== "string" || host.length === 0) {
    throw new GithubForwardConfigError("FX_GH_FORWARD_HOST is required");
  }
  validateSuffix(suffix);
  validateHost(host, suffix);
  // D#66 security review, must-fix 1: frozen so a `host`/`suffix` write
  // after the fact throws instead of silently succeeding -- this is what
  // makes the object safe to read more than once across an `await`
  // boundary (`buildFirewallPolicy` still reads it only once; this is the
  // second, independent half of that fix). `ISSUED.add` below (should-fix
  // 5) is what actually gates `assertGithubForwardConfig`; the freeze
  // protects a caller that reads `.host`/`.suffix` directly.
  const config = Object.freeze<GithubForwardConfig>({ host, suffix, [BRAND]: true });
  ISSUED.add(config);
  return config;
}

/**
 * Repeats every check `loadGithubForwardConfig` performs, against a value
 * it did NOT itself produce -- the defence-in-depth path decision (b)
 * describes. Throws `GithubForwardConfigError` when `value` isn't one
 * `loadGithubForwardConfig` itself issued (D#66 security review,
 * should-fix 5: checked by `ISSUED` membership, not just the `BRAND`
 * symbol -- a symbol recovered off a real config via
 * `Object.getOwnPropertySymbols` and replayed onto a forged object would
 * pass a brand-only check) or when its `host`/`suffix` fail the same
 * rules above.
 */
export function assertGithubForwardConfig(value: unknown): asserts value is GithubForwardConfig {
  if (typeof value !== "object" || value === null || !(BRAND in value) || !ISSUED.has(value)) {
    throw new GithubForwardConfigError("githubForward was not produced by loadGithubForwardConfig");
  }
  const candidate = value as { host?: unknown; suffix?: unknown };
  if (typeof candidate.host !== "string" || typeof candidate.suffix !== "string") {
    throw new GithubForwardConfigError("githubForward.host and .suffix must be strings");
  }
  validateSuffix(candidate.suffix);
  validateHost(candidate.host, candidate.suffix);
}

/**
 * D#2 Correction C28 §2: the ONE function that produces the OIDC `aud`
 * value the gh-proxy route expects. `https://<config.host>/api/gh-proxy`,
 * no trailing slash, query or fragment -- exactly the route prefix
 * `handler.ts` already strips (`pathFromParams`). Whatever code first
 * emits the real Vercel `forwardURL` for GitHub traffic (the network-
 * policy translation, not yet on `main`) must call this same function, so
 * the emitted and verified audience values can never drift apart. Takes
 * the full `GithubForwardConfig` (not a bare string) so a caller can never
 * pass an unvalidated host through by mistake -- the same discipline
 * `toGithubForwardConnection` above already uses for `.host` alone.
 */
export function githubProxyForwardUrl(config: GithubForwardConfig): string {
  return githubForwardUrlForHost(config.host);
}

/**
 * Builds `networkPolicy.ts`'s own `Connection` value from an already
 * resolved forward host. Takes the host as a plain string, not the whole
 * `GithubForwardConfig` (D#66 security review, must-fix 1): the caller
 * (`buildFirewallPolicy`) reads `deps.githubForward.host` into a local
 * exactly once and passes that same local here, so this function is never
 * a second read of the (frozen, but still shared) config object. Lives
 * here, not in `firewallPolicy.ts`, so `firewallPolicy.ts`'s own source
 * never spells out `Connection`'s string-typed field name again (Spec
 * criterion 7's `grep -c` scan of `firewallPolicy.ts` for that exact
 * name).
 */
export function toGithubForwardConnection(host: string, provider: ConnectionKind): Connection {
  return { provider, githubForwardHost: host };
}
