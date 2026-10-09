import { generateKeyPairSync } from "node:crypto";
import { ENV_MANIFEST, type DeployKind, type Validation } from "../../env-manifest";

/** One value per validation type that passes it. Fabricated; none of these is a real credential. */
let pem: string | undefined;
export function validValue(validation: Validation): string {
  switch (validation.type) {
    case "any":
      return "some-value";
    case "base64-32":
      return Buffer.alloc(32, 7).toString("base64");
    case "min-chars":
    case "min-bytes":
      return "x".repeat(validation.n + 8);
    case "postgres-url":
      return "postgres://login:pw@db.example.test:5432/app";
    case "url":
      return "https://example.test/terms";
    case "https-url":
      return "https://example.test/callback";
    case "origin":
      return "https://app.example.test";
    case "enum":
      return validation.values[0] as string;
    case "positive-int":
      return "5";
    case "digits":
      return "250";
    case "github-app-id":
      return "123456";
    case "pem-private-key":
      pem ??= generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      return pem;
    case "ed25519-private-key":
      pem ??= generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      return pem;
    case "runner-signer-id":
      return "job-signer-1";
    case "slug":
      return "fx-app";
    case "hostname":
      return "forward.example.test";
    case "stripe-secret-key":
      return "sk_test_abc123";
    case "stripe-restricted-key":
      return "rk_test_abc123";
    case "stripe-webhook-secret":
      return "whsec_abc123";
    case "stripe-price-list":
      return "price_abc123, price_def456";
    case "oidc-issuer":
      return "https://oidc.vercel.com/team_abc123";
    case "oidc-jwks-url":
      return "https://oidc.vercel.com/team_abc123/.well-known/jwks";
    case "uuid-list":
      return "11111111-1111-4111-8111-111111111111, 22222222-2222-4222-8222-222222222222";
    case "repo-id-list":
      return "123456,789012";
    case "subscription-token":
      return "sk-ant-oat01-FAKE-FIXTURE-VALUE-NOT-A-CREDENTIAL";
    case "iso-timestamp":
      return "2026-11-01T00:00:00Z";
  }
}

/** An environment that satisfies every setting required for `kind` (and sets nothing else). */
export function completeEnv(kind: DeployKind): Record<string, string> {
  const env: Record<string, string> = { FX_DEPLOY_KIND: kind };
  for (const entry of ENV_MANIFEST) {
    if (entry.scope !== "tooling" && entry.requiredIn.includes(kind)) env[entry.name] = validValue(entry.validation);
  }
  return env;
}
