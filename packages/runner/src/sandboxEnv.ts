import { OPERATOR_OAUTH_PLACEHOLDER } from "@fx/runtime/src/operatorSubscription.js";
import type { Role } from "./types.js";

/**
 * D#2 H09 pass/fail 4: "The sandbox env for every role contains no value
 * matching the injected fake customer key, installation token, App key,
 * Stripe key, KEK or webhook secret, and no variable named like
 * /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/ except ANTHROPIC_API_KEY="" and
 * a placeholder ANTHROPIC_AUTH_TOKEN (test)."
 *
 * Consensus Summary point 2: "No secret in a sandbox. Credentials are
 * brokered at the firewall." `buildSandboxEnv` is the single place that
 * decides what goes into a role's sandbox env, and it is built to make a
 * leak structurally impossible rather than merely tested against known
 * secret shapes: it takes a small, explicit, non-secret parameter object
 * -- never `process.env`, never a decrypted key, never a raw installation
 * token -- so there is no code path by which a real credential could ever
 * reach its return value. The two placeholders below exist so the agent
 * process inside the sandbox (which still expects these env var NAMES to
 * be present, per the Claude Code CLI's own contract) sees harmless
 * values: an empty string and a fixed non-secret marker, never anything
 * that could be mistaken for -- or that shape-matches -- a real key.
 */
export const ANTHROPIC_API_KEY_EXEMPT_NAME = "ANTHROPIC_API_KEY";
export const ANTHROPIC_AUTH_TOKEN_EXEMPT_NAME = "ANTHROPIC_AUTH_TOKEN";

/** The two env var NAMES exempt from the forbidden-shape check below --
 * both are placeholders, not real credentials (see the module doc
 * comment). Any other key must not match `FORBIDDEN_ENV_NAME_PATTERN`. */
export const EXEMPT_ENV_NAMES: ReadonlySet<string> = new Set([
  ANTHROPIC_API_KEY_EXEMPT_NAME,
  ANTHROPIC_AUTH_TOKEN_EXEMPT_NAME,
]);

/** The one extra placeholder name, exempt ONLY in operator-subscription mode: the CLI's OAuth token slot. */
export const OPERATOR_OAUTH_ENV_NAME = "CLAUDE_CODE_OAUTH_TOKEN";

/** Which brokering the run uses: the tenant's own key (the default), or the operator's subscription. */
export type SandboxEnvMode = "tenant_key" | "operator_subscription";

/** A var name shaped like a credential. Matched case-insensitively against
 * the whole name (not anchored), matching the Spec's own
 * `/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/` exactly, extended per H09
 * security review "informational" 1 to also catch the abbreviated/
 * lookalike names the Spec's own pattern misses: `GH_PAT` (a personal
 * access token that doesn't contain "TOKEN"), `PASSWD` (doesn't contain
 * "PASSWORD"), and any name ending `_PEM` or exactly `PEM` (a PEM-encoded
 * private key blob). Further extended per the H09 security re-review,
 * "suggestion" 3 to also catch a bare `KEK` (a key-encryption key, named
 * in the Spec's own pass/fail 4 alongside the other secret shapes but not
 * previously covered by this pattern) at a name boundary. `PAT` and `KEK`
 * are bounded by `_`/start/`_`/end.
 *
 * D#66, decision (e): `PEM` is now matched at segment boundaries on BOTH
 * sides (`(?:^|_)PEM(?:_|$)`), not only as the whole trailing segment --
 * `APP_PEM_FILE` and `PEM_DIR` are now caught too. This is deliberate:
 * the sandbox env is built only from named placeholders
 * (`buildSandboxEnv` below never reads ambient input), so failing closed
 * on a non-secret name costs nothing. `PEMBROKE` and `COMPATIBLE_MODE`
 * stay allowed -- `PEM`/`PAT`/`KEK` never match as a mere substring, only
 * at a `_`/start/end boundary on both sides. */
export const FORBIDDEN_ENV_NAME_PATTERN =
  /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|(?:^|_)PAT(?:_|$)|(?:^|_)PEM(?:_|$)|(?:^|_)KEK(?:_|$)/i;

/** The value placed under `ANTHROPIC_AUTH_TOKEN` -- a fixed, clearly-not-a-
 * real-token marker. The real brokered auth happens at the firewall (H13,
 * not built yet); nothing that ever reaches the sandbox env can be a real
 * token, by construction. */
export const ANTHROPIC_AUTH_TOKEN_PLACEHOLDER = "brokered-at-firewall";

/**
 * GitHub traffic is forwarded (forwardURL), so the sandbox firewall terminates TLS for github.com and
 * api.github.com with a per-sandbox CA. Vercel's docs (sandbox/concepts, "Proxy CA certificates") say the
 * platform adds that CA to the system bundle and sets these variables on its managed images; a custom image
 * or a changed command environment would lose that, so the same names are pinned here to the same system
 * bundle: git (GIT_SSL_CAINFO), gh (a Go binary, SSL_CERT_FILE), curl and node. Paths, not secrets.
 */
const SYSTEM_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";
export const SANDBOX_CA_ENV: Readonly<Record<string, string>> = Object.freeze({
  GIT_SSL_CAINFO: SYSTEM_CA_BUNDLE,
  SSL_CERT_FILE: SYSTEM_CA_BUNDLE,
  CURL_CA_BUNDLE: SYSTEM_CA_BUNDLE,
  NODE_EXTRA_CA_CERTS: SYSTEM_CA_BUNDLE,
});

/**
 * Builds the env map for one role's sandbox. Deliberately takes NO
 * "ambient" input (no `process.env`, no connection/credential object) --
 * only `role`, which today doesn't even vary the output (every role gets
 * the identical two placeholders; nothing else). A future role-specific
 * non-secret env var would extend this function's explicit parameter list,
 * never reach for `process.env`.
 */
export function buildSandboxEnv(role: Role, mode: SandboxEnvMode = "tenant_key"): Record<string, string> {
  void role; // No H09 pass/fail item varies the sandbox env by role today.
  if (mode === "operator_subscription") {
    // Operator mode: the CLI believes it holds an OAuth token (so it sends the OAuth headers
    // itself) and the firewall swaps the Authorization header for ours. ANTHROPIC_AUTH_TOKEN is
    // left out: it outranks the OAuth slot in the CLI's credential order and would bypass it.
    return {
      ...SANDBOX_CA_ENV,
      [ANTHROPIC_API_KEY_EXEMPT_NAME]: "",
      [OPERATOR_OAUTH_ENV_NAME]: OPERATOR_OAUTH_PLACEHOLDER,
    };
  }
  return {
    ...SANDBOX_CA_ENV,
    [ANTHROPIC_API_KEY_EXEMPT_NAME]: "",
    [ANTHROPIC_AUTH_TOKEN_EXEMPT_NAME]: ANTHROPIC_AUTH_TOKEN_PLACEHOLDER,
  };
}

/** D#66, decision (e): a real env var name is always
 * `^[A-Za-z_][A-Za-z0-9_]*$` -- a leading/trailing space (`"GH_PAT "`,
 * `" GH_PAT"`) or any other non-identifier character (`"GH-PAT"`) is not
 * a name a shell or `process.env` could even carry as one token, so
 * treating anything outside that shape as forbidden costs nothing and
 * closes those carried-over gaps without weakening
 * `FORBIDDEN_ENV_NAME_PATTERN` itself. */
const ENV_NAME_SHAPE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** True when `name` is a credential-shaped env var name that is NOT one of
 * the two exempt placeholders -- i.e. a name `buildSandboxEnv`'s output
 * (or any other candidate sandbox env) must never contain. Fails closed
 * on a name that isn't even a well-formed identifier (see
 * `ENV_NAME_SHAPE_RE` above) before testing the credential-shape pattern. */
export function isForbiddenSandboxEnvName(name: string, mode: SandboxEnvMode = "tenant_key"): boolean {
  if (EXEMPT_ENV_NAMES.has(name)) return false;
  if (mode === "operator_subscription" && name === OPERATOR_OAUTH_ENV_NAME) return false;
  if (!ENV_NAME_SHAPE_RE.test(name)) return true;
  return FORBIDDEN_ENV_NAME_PATTERN.test(name);
}
