import { SubscriptionCredentialsRefused } from "../types.js";
import type { ModelProvider, SandboxSpec } from "../types.js";
import {
  SK_ANT_ADMIN_PATTERN_SOURCE,
  SK_ANT_API_PATTERN_SOURCE,
  SK_ANT_OAT_PATTERN_SOURCE,
  VCK_PATTERN_SOURCE,
  matchesShape,
} from "../redact.js";
import { OPERATOR_OAUTH_PLACEHOLDER, OPERATOR_TOKEN_ENV } from "../operatorSubscription.js";

const AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/claude-code";
// The Anthropic API's own default base URL — no override needed, but an
// explicit value must still match this to count as the "Anthropic as the
// alternative" path (Spec H04 pass/fail 2).
const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

const ALLOWED_BASE_URL_BY_PROVIDER: Record<ModelProvider, string> = {
  ai_gateway: AI_GATEWAY_BASE_URL,
  anthropic: ANTHROPIC_BASE_URL,
};

/**
 * Env var NAMES that only ever carry a model credential or a model
 * endpoint override — never legitimate for a sandbox env (or the
 * orchestrator's own env, for the same reason): credentials and base URLs
 * only ever arrive by firewall brokering (Spec H04 fix-round 1 item 2,
 * CWE-522). Declaring `spec.baseUrl` correctly is not enough on its own —
 * `assertSandboxSpecAllowed` used to check only that field, so
 * `spec.env.ANTHROPIC_BASE_URL` (or a raw key/token env var) sitting
 * alongside a valid `spec.baseUrl` sailed straight through.
 *
 * Fix-round 2 item 3 replaced a blanket `^ANTHROPIC_`/`^CLAUDE_CODE_` prefix
 * ban with this narrower rule: an EXACT set of known credential/endpoint
 * keys, plus any key under those two prefixes whose name contains "TOKEN",
 * "KEY", or "SECRET" — so a harmless setting like `ANTHROPIC_MODEL` is
 * allowed through (it isn't a credential or an endpoint override) while
 * `ANTHROPIC_BASE_URL` (doesn't contain any of those three words, so it
 * needs the exact-name entry) and any future `ANTHROPIC_*_TOKEN`/
 * `CLAUDE_CODE_*_SECRET`-shaped var still get caught. `AI_GATEWAY_API_KEY`
 * doesn't share either prefix, so it stays in the exact set.
 */
const EXACT_FORBIDDEN_SANDBOX_ENV_KEYS: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "AI_GATEWAY_API_KEY",
]);

const SENSITIVE_NAME_PREFIXES = ["ANTHROPIC_", "CLAUDE_CODE_"];
const SENSITIVE_NAME_FRAGMENTS = ["TOKEN", "KEY", "SECRET"];

function isForbiddenSandboxEnvKey(key: string): boolean {
  if (EXACT_FORBIDDEN_SANDBOX_ENV_KEYS.has(key)) return true;
  const hasSensitivePrefix = SENSITIVE_NAME_PREFIXES.some((prefix) => key.startsWith(prefix));
  if (!hasSensitivePrefix) return false;
  const upper = key.toUpperCase();
  return SENSITIVE_NAME_FRAGMENTS.some((fragment) => upper.includes(fragment));
}

/**
 * Shape patterns checked against every value in the orchestrator env
 * (subscription credentials only — a tenant model key has no legitimate
 * reason to be there either, but that isn't this check's job) versus every
 * value in the sandbox env (subscription AND tenant-key shapes both — a
 * tenant's actual key only ever arrives by firewall brokering, never
 * through a `spec.env` map the orchestrator builds itself; fix-round 2 item
 * 3). Both scans use `matchesShape` from `src/redact.ts` — the identical
 * pattern source redaction uses — so the refusal side and the redaction
 * side cannot drift apart the way the old hand-rolled `startsWith` check
 * did (fix-round 2 item 2).
 */
const ORCHESTRATOR_ENV_FORBIDDEN_SHAPES: readonly string[] = [SK_ANT_OAT_PATTERN_SOURCE];
const SANDBOX_ENV_FORBIDDEN_SHAPES: readonly string[] = [
  SK_ANT_OAT_PATTERN_SOURCE,
  SK_ANT_API_PATTERN_SOURCE,
  SK_ANT_ADMIN_PATTERN_SOURCE,
  VCK_PATTERN_SOURCE,
];

/** Returns the first env var name whose value matches any of `shapes`, or
 * undefined. Checked by name-agnostic value scan because a caller could
 * smuggle a credential under any key, not just a documented one. */
function findCredentialShapedKey(
  env: Record<string, string | undefined>,
  shapes: readonly string[],
  skipKey?: string,
): string | undefined {
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    if (key === skipKey) continue;
    if (shapes.some((shape) => matchesShape(value, shape))) return key;
  }
  return undefined;
}

/** Refuses construction when the orchestrator's own env carries a
 * subscription credential — production must never run on subscription
 * login, only on a tenant's brokered key. Checks both the documented
 * `CLAUDE_CODE_OAUTH_TOKEN` name AND any other key whose value is
 * subscription-token-shaped, matched anywhere in the value (fix-round 2
 * item 2 — this used to be a `startsWith` check, so `"Bearer sk-ant-oat…"`
 * or a leading space passed unnoticed; fix-round 1 item 2 is what added the
 * any-key value scan in the first place, for the same reason: the token
 * under `ANTHROPIC_AUTH_TOKEN` instead of the documented name). */
export function assertNoSubscriptionCredentials(env: NodeJS.ProcessEnv): void {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    throw new SubscriptionCredentialsRefused(
      "production runner refused: CLAUDE_CODE_OAUTH_TOKEN is set in the orchestrator env",
    );
  }
  // The operator exception: the worker holds our own subscription token under this ONE exact
  // name (read only when the firewall policy is built, see operatorSubscription.ts). The same
  // value under any other name is still refused.
  const offendingKey = findCredentialShapedKey(
    env as Record<string, string | undefined>,
    ORCHESTRATOR_ENV_FORBIDDEN_SHAPES,
    OPERATOR_TOKEN_ENV,
  );
  if (offendingKey) {
    throw new SubscriptionCredentialsRefused(
      `production runner refused: orchestrator env var "${offendingKey}" holds a subscription-token-shaped value`,
    );
  }
}

/** Refuses a sandbox spec that:
 *   - requests any model-credential or model-endpoint-override key in its
 *     env (an exact known name, or any `ANTHROPIC_*`/`CLAUDE_CODE_*` key
 *     whose name contains TOKEN/KEY/SECRET) — regardless of what
 *     `spec.baseUrl` itself says;
 *   - carries a subscription- or tenant-key-shaped value under ANY key
 *     (`sk-ant-oat…`, `sk-ant-api…`, `sk-ant-admin…`, `vck_…`); or
 *   - declares a `baseUrl` that isn't the AI Gateway or Anthropic API's own
 *     default for its declared provider.
 */
export function assertSandboxSpecAllowed(spec: SandboxSpec): void {
  if (spec.operatorSubscription !== undefined && spec.operatorSubscription !== true) {
    throw new SubscriptionCredentialsRefused("production runner refused: operatorSubscription must be exactly true when set");
  }
  const operator = spec.operatorSubscription === true;
  if (operator && (spec.provider !== "anthropic" || spec.baseUrl !== ANTHROPIC_BASE_URL)) {
    throw new SubscriptionCredentialsRefused("production runner refused: the operator subscription path only goes to the Anthropic API default");
  }
  if (spec.env) {
    // Operator mode: the CLI's one placeholder, by exact name and exact value. Nothing else
    // relaxes, and any other value under this name (a real token included) is still refused.
    const env =
      operator && spec.env.CLAUDE_CODE_OAUTH_TOKEN === OPERATOR_OAUTH_PLACEHOLDER
        ? Object.fromEntries(Object.entries(spec.env).filter(([key]) => key !== "CLAUDE_CODE_OAUTH_TOKEN"))
        : spec.env;
    const forbiddenKey = Object.keys(env).find(isForbiddenSandboxEnvKey);
    if (forbiddenKey) {
      throw new SubscriptionCredentialsRefused(
        `production runner refused: "${forbiddenKey}" requested for the sandbox env — model credentials and endpoints only ever arrive by firewall brokering`,
      );
    }
    const offendingKey = findCredentialShapedKey(env, SANDBOX_ENV_FORBIDDEN_SHAPES);
    if (offendingKey) {
      throw new SubscriptionCredentialsRefused(
        `production runner refused: sandbox env var "${offendingKey}" holds a credential-shaped value`,
      );
    }
  }
  const expected = ALLOWED_BASE_URL_BY_PROVIDER[spec.provider];
  if (!expected || spec.baseUrl !== expected) {
    throw new SubscriptionCredentialsRefused(
      `production runner refused: base URL "${spec.baseUrl}" is not the ${spec.provider} default (${expected ?? "unknown provider"})`,
    );
  }
}
