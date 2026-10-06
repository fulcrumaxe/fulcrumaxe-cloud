import type { EnvVar, MissingEffect, Validation } from "../../env-manifest";

/**
 * Renders the settings tables in docs/ops/staging.md from the manifest, so
 * the doc cannot drift from what the code reads. The test in
 * apps/web/test/env-manifest.test.ts fails when the doc differs from this
 * output; `node --experimental-strip-types apps/web/scripts/check-env-manifest.mjs --write-docs`
 * rewrites it. Type-only imports: loadable by Node's type stripping.
 */

export const DOCS_BEGIN = "<!-- env-manifest:begin (generated from apps/web/env-manifest.ts; do not edit by hand) -->";
export const DOCS_END = "<!-- env-manifest:end -->";

export function describeValidation(validation: Validation): string {
  switch (validation.type) {
    case "any":
      return "any non-blank value";
    case "base64-32":
      return "base64 of exactly 32 bytes";
    case "min-chars":
      return `at least ${validation.n} characters`;
    case "min-bytes":
      return `at least ${validation.n} bytes`;
    case "postgres-url":
      return "postgres:// URL";
    case "url":
      return "http(s) URL";
    case "https-url":
      return "https URL";
    case "origin":
      return "bare origin, e.g. https://host (no path, no trailing slash)";
    case "enum":
      return `one of ${validation.values.map((x) => `\`${x}\``).join(", ")}`;
    case "positive-int":
      return "positive integer";
    case "digits":
      return "digits only";
    case "github-app-id":
      return "positive integer (the App id)";
    case "pem-private-key":
      return "PEM private key";
    case "ed25519-private-key":
      return "Ed25519 private key (PKCS#8 PEM; a two-character `\\n` is read as a newline)";
    case "runner-signer-id":
      return "1 to 64 letters, digits, dot, underscore or dash";
    case "slug":
      return "lowercase letters, digits, hyphens (max 64)";
    case "hostname":
      return "hostname";
    case "stripe-secret-key":
      return "`sk_` or `rk_` Stripe key";
    case "stripe-webhook-secret":
      return "`whsec_` signing secret";
    case "stripe-price-list":
      return "comma-separated `price_` ids";
    case "oidc-issuer":
      return "`https://oidc.vercel.com/<team id>`";
    case "oidc-jwks-url":
      return "`<issuer>/.well-known/jwks`";
    case "uuid-list":
      return "comma-separated account ids (UUIDs)";
    case "subscription-token":
      return "`sk-ant-oat` subscription token";
  }
}

const EFFECT_LABEL: Record<MissingEffect, string> = {
  request_fails: "requests fail",
  boot_error: "server refuses to start",
  build_fails: "build fails",
  feature_disabled: "feature off",
  default_used: "default applies",
  tool_refuses: "tool refuses",
  none: "nothing",
};

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function row(entry: EnvVar): string {
  const needed = entry.requiredIn.length > 0 ? entry.requiredIn.join(", ") : "optional";
  return `| \`${entry.name}\` | ${needed} | ${entry.secret ? "secret" : "plain"} | ${cell(entry.feature)} | ${cell(describeValidation(entry.validation))} | ${EFFECT_LABEL[entry.whenMissing]}: ${cell(entry.note)} |`;
}

const HEADER = ["| Variable | Needed in | Kind | Feature | Check | If missing |", "|---|---|---|---|---|---|"];

/** The generated block, markers included, with no trailing newline. */
export function renderEnvDocs(manifest: readonly EnvVar[]): string {
  const deployed = manifest.filter((e) => e.scope === "web" || e.scope === "build");
  const platform = manifest.filter((e) => e.scope === "platform");
  const tooling = manifest.filter((e) => e.scope === "tooling");
  const lines = [DOCS_BEGIN, "", ...HEADER, ...deployed.map(row), ""];
  lines.push(`Set by Node, Next or Vercel, not by hand: ${platform.map((e) => `\`${e.name}\``).join(", ")}.`, "");
  lines.push(`Read only by dev, bench and test-support code, never set on a deployment: ${tooling.map((e) => `\`${e.name}\``).join(", ")}.`, "");
  lines.push(DOCS_END);
  return lines.join("\n");
}

/** Replaces the generated block in `doc`; null when the markers are missing. */
export function replaceGeneratedBlock(doc: string, block: string): string | null {
  const start = doc.indexOf(DOCS_BEGIN);
  const end = doc.indexOf(DOCS_END);
  if (start === -1 || end === -1 || end < start) return null;
  return doc.slice(0, start) + block + doc.slice(end + DOCS_END.length);
}
