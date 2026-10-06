import { createPrivateKey } from "node:crypto";
import type { DeployKind, EnvVar, Validation } from "../../env-manifest";

/**
 * Judges an environment against the manifest (apps/web/env-manifest.ts).
 * Shared by /api/health and the production build gate, so both answer the
 * same way. Nothing here ever returns, logs or throws a value: results carry
 * names and fixed reason codes only.
 *
 * Type-only imports and no enums, so Node can load this file with type
 * stripping (scripts/check-env-manifest.mjs does).
 */

export type EnvLike = Readonly<Record<string, string | undefined>>;

export interface InvalidSetting {
  name: string;
  /** A fixed code such as "not_base64_32". Never a value, never a fragment of one. */
  reason: string;
}

export interface EnvReport {
  kind: DeployKind;
  /** True when no setting required for this kind is missing or invalid. */
  ok: boolean;
  /** Required for this kind and unset or blank. */
  missing: string[];
  /** Required for this kind and set to something the check rejects. */
  invalid: InvalidSetting[];
  /** Optional and set to something the check rejects (the app ignores or trips over it). */
  invalidOptional: InvalidSetting[];
  /** Optional, unset, and switching a feature off. */
  disabled: { name: string; feature: string }[];
}

const DEPLOY_KINDS: readonly string[] = ["staging", "production", "local"];

export function isDeployKind(value: unknown): value is DeployKind {
  return typeof value === "string" && DEPLOY_KINDS.includes(value);
}

/**
 * Which set of requirements applies. FX_DEPLOY_KIND wins when it is a known
 * kind. Otherwise a Vercel Production deployment counts as production, and
 * anything else (a preview, a laptop, CI) as local: a preview deliberately
 * has no secrets, so it is not held to the deployed list.
 */
export function deployKindOf(env: EnvLike): DeployKind {
  const declared = env.FX_DEPLOY_KIND?.trim();
  if (isDeployKind(declared)) return declared;
  return env.VERCEL_ENV === "production" ? "production" : "local";
}

const BASE64_32_BYTES = 32;
const ISSUER_RE = /^https:\/\/oidc\.vercel\.com\/team_[A-Za-z0-9]+$/;
/** Same shape packages/runner/src/networkPolicy.ts STRICT_HOSTNAME_RE enforces on the forward host and suffix: lowercase, at least two labels, alphabetic last label. */
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** Returns null when `value` (already non-blank) passes, or a fixed reason code when it does not. */
export function validateValue(validation: Validation, value: string): string | null {
  switch (validation.type) {
    case "any":
      return null;
    case "base64-32":
      return Buffer.from(value, "base64").length === BASE64_32_BYTES ? null : "not_base64_32_bytes";
    case "min-chars":
      return value.length >= validation.n ? null : `shorter_than_${validation.n}_chars`;
    case "min-bytes":
      return Buffer.byteLength(value, "utf8") >= validation.n ? null : `shorter_than_${validation.n}_bytes`;
    case "postgres-url": {
      const url = parseUrl(value);
      return url && (url.protocol === "postgres:" || url.protocol === "postgresql:") && url.hostname ? null : "not_a_postgres_url";
    }
    case "url": {
      const url = parseUrl(value);
      return url && (url.protocol === "https:" || url.protocol === "http:") && url.hostname ? null : "not_an_http_url";
    }
    case "https-url": {
      const url = parseUrl(value);
      return url && url.protocol === "https:" && url.hostname ? null : "not_an_https_url";
    }
    case "origin": {
      // The app compares this string to the browser's Origin header exactly, so a path or trailing slash would never match.
      const url = parseUrl(value);
      if (!url || (url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname) return "not_an_origin";
      return value === url.origin ? null : "not_a_bare_origin";
    }
    case "enum":
      return validation.values.includes(value) ? null : "not_an_allowed_value";
    case "positive-int":
      return /^[0-9]+$/.test(value) && Number(value) > 0 && Number.isSafeInteger(Number(value)) ? null : "not_a_positive_integer";
    case "digits":
      return /^[0-9]+$/.test(value) ? null : "not_a_non_negative_integer";
    case "github-app-id":
      return /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value)) ? null : "not_a_positive_integer";
    case "pem-private-key":
      // The same parse the App credential loader does, so "valid here" means "usable there".
      try {
        createPrivateKey(value);
        return null;
      } catch {
        return "not_a_pem_private_key";
      }
    case "ed25519-private-key":
      // The same parse the worker's job signer does (packages/worker/src/jobSigner.ts): an Ed25519 key only, and a `\n` written
      // as two characters is a newline. A test runs both over the same fixtures.
      try {
        return createPrivateKey(value.trim().replace(/\\n/g, "\n")).asymmetricKeyType === "ed25519" ? null : "not_an_ed25519_private_key";
      } catch {
        // fx-swallow-ok: a fixed reason code is returned; the parser's message can quote key material and must never reach a result
        return "not_an_ed25519_private_key";
      }
    case "runner-signer-id":
      // The pattern the worker's job signer enforces on the key id.
      return /^[A-Za-z0-9._-]{1,64}$/.test(value.trim()) ? null : "not_a_runner_signer_id";
    case "slug":
      return /^[a-z0-9-]{1,64}$/.test(value) ? null : "not_a_slug";
    case "hostname":
      return HOSTNAME_RE.test(value) ? null : "not_a_hostname";
    case "stripe-secret-key":
      return /^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.test(value) ? null : "not_a_stripe_secret_key";
    case "stripe-restricted-key":
      return /^rk_(test|live)_[A-Za-z0-9]+$/.test(value) ? null : "not_a_stripe_restricted_key";
    case "stripe-webhook-secret":
      return /^whsec_[A-Za-z0-9+/=_-]+$/.test(value) ? null : "not_a_stripe_webhook_secret";
    case "stripe-price-list": {
      const entries = value.split(",").map((e) => e.trim());
      return entries.length > 0 && entries.every((e) => /^price_[A-Za-z0-9]+$/.test(e)) ? null : "not_a_stripe_price_list";
    }
    case "oidc-issuer":
      return ISSUER_RE.test(value) ? null : "not_a_team_oidc_issuer";
    case "oidc-jwks-url":
      return /^https:\/\/oidc\.vercel\.com\/team_[A-Za-z0-9]+\/\.well-known\/jwks$/.test(value) ? null : "not_an_oidc_jwks_url";
    case "uuid-list":
      return value.split(",").every((part) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(part.trim())) ? null : "not_a_uuid_list";
    case "subscription-token":
      return /^sk-ant-oat[0-9]{2}-[A-Za-z0-9_-]{10,}$/.test(value) ? null : "not_a_subscription_token";
  }
}

/** Looks one variable up. A blank or whitespace-only value is the same as unset. */
function valueOf(env: EnvLike, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  return raw.trim() === "" ? undefined : raw;
}

export function evaluateEnv(manifest: readonly EnvVar[], env: EnvLike, kind: DeployKind): EnvReport {
  const report: EnvReport = { kind, ok: true, missing: [], invalid: [], invalidOptional: [], disabled: [] };
  for (const entry of manifest) {
    if (entry.scope === "tooling" || entry.scope === "platform") continue;
    const required = entry.requiredIn.includes(kind);
    const value = valueOf(env, entry.name);
    if (value === undefined) {
      if (required) report.missing.push(entry.name);
      else if (entry.whenMissing === "feature_disabled") report.disabled.push({ name: entry.name, feature: entry.feature });
      continue;
    }
    const reason = validateValue(entry.validation, value);
    if (reason === null) continue;
    (required ? report.invalid : report.invalidOptional).push({ name: entry.name, reason });
  }
  report.ok = report.missing.length === 0 && report.invalid.length === 0;
  return report;
}
