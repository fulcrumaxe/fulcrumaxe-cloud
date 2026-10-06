import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ENV_MANIFEST, type DeployKind, type Validation } from "../env-manifest";
import { deployKindOf, evaluateEnv, validateValue } from "../lib/env/check";
import { completeEnv } from "./support/envFixtures";

/** For every validation type: values that pass, and values that fail with the expected fixed code. */
const CASES: Record<Validation["type"], { validation: Validation; good: string[]; bad: [string, string][] }> = {
  any: { validation: { type: "any" }, good: ["x"], bad: [] },
  "base64-32": {
    validation: { type: "base64-32" },
    good: [Buffer.alloc(32, 1).toString("base64")],
    bad: [
      [Buffer.alloc(16, 1).toString("base64"), "not_base64_32_bytes"],
      [Buffer.alloc(33, 1).toString("base64"), "not_base64_32_bytes"],
      ["not base64 at all!", "not_base64_32_bytes"],
    ],
  },
  "min-chars": { validation: { type: "min-chars", n: 8 }, good: ["12345678"], bad: [["1234567", "shorter_than_8_chars"]] },
  "min-bytes": { validation: { type: "min-bytes", n: 4 }, good: ["abcd", "éé"], bad: [["abc", "shorter_than_4_bytes"]] },
  "postgres-url": {
    validation: { type: "postgres-url" },
    good: ["postgres://u:p@h.example:5432/db", "postgresql://u@h/db"],
    bad: [["mysql://u@h/db", "not_a_postgres_url"], ["not a url", "not_a_postgres_url"], ["postgres://", "not_a_postgres_url"]],
  },
  url: { validation: { type: "url" }, good: ["https://a.test/x", "http://localhost:3000"], bad: [["ftp://a.test", "not_an_http_url"], ["nope", "not_an_http_url"]] },
  "https-url": { validation: { type: "https-url" }, good: ["https://a.test/cb"], bad: [["http://a.test/cb", "not_an_https_url"], ["a.test/cb", "not_an_https_url"]] },
  origin: {
    validation: { type: "origin" },
    good: ["https://app.example.test", "http://localhost:3000"],
    bad: [
      ["https://app.example.test/", "not_a_bare_origin"],
      ["https://app.example.test/path", "not_a_bare_origin"],
      ["app.example.test", "not_an_origin"],
    ],
  },
  enum: { validation: { type: "enum", values: ["a", "b"] }, good: ["a", "b"], bad: [["c", "not_an_allowed_value"], ["A", "not_an_allowed_value"]] },
  "positive-int": { validation: { type: "positive-int" }, good: ["1", "86400"], bad: [["0", "not_a_positive_integer"], ["-1", "not_a_positive_integer"], ["1.5", "not_a_positive_integer"], ["1e3", "not_a_positive_integer"]] },
  digits: { validation: { type: "digits" }, good: ["0", "250"], bad: [["-1", "not_a_non_negative_integer"], ["0x10", "not_a_non_negative_integer"], ["1.5", "not_a_non_negative_integer"]] },
  "github-app-id": { validation: { type: "github-app-id" }, good: ["12345"], bad: [["0", "not_a_positive_integer"], ["012", "not_a_positive_integer"], ["abc", "not_a_positive_integer"]] },
  "pem-private-key": {
    validation: { type: "pem-private-key" },
    good: [],
    bad: [["-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----", "not_a_pem_private_key"], ["plain text", "not_a_pem_private_key"]],
  },
  "ed25519-private-key": {
    validation: { type: "ed25519-private-key" },
    good: [],
    bad: [["-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----", "not_an_ed25519_private_key"], ["plain text", "not_an_ed25519_private_key"]],
  },
  "runner-signer-id": { validation: { type: "runner-signer-id" }, good: ["job-signer-1", "a.b_c-D"], bad: [["has space", "not_a_runner_signer_id"], ["x".repeat(65), "not_a_runner_signer_id"], ["a/b", "not_a_runner_signer_id"]] },
  slug: { validation: { type: "slug" }, good: ["fx-team", "a1"], bad: [["Fx-Team", "not_a_slug"], ["has space", "not_a_slug"], ["x".repeat(65), "not_a_slug"]] },
  hostname: { validation: { type: "hostname" }, good: ["fwd.example.test"], bad: [["nodots", "not_a_hostname"], ["https://fwd.example.test", "not_a_hostname"], ["UPPER.example.test", "not_a_hostname"]] },
  "stripe-restricted-key": { validation: { type: "stripe-restricted-key" }, good: ["rk_test_abc123", "rk_live_abc123"], bad: [["sk_test_abc123", "not_a_stripe_restricted_key"], ["rk_abc", "not_a_stripe_restricted_key"]] },
  "stripe-secret-key": { validation: { type: "stripe-secret-key" }, good: ["sk_test_abc123", "rk_live_abc123"], bad: [["pk_test_abc", "not_a_stripe_secret_key"], ["sk_abc", "not_a_stripe_secret_key"]] },
  "stripe-webhook-secret": { validation: { type: "stripe-webhook-secret" }, good: ["whsec_abc123"], bad: [["abc123", "not_a_stripe_webhook_secret"]] },
  "stripe-price-list": {
    validation: { type: "stripe-price-list" },
    good: ["price_abc", "price_abc, price_def"],
    bad: [["prod_abc", "not_a_stripe_price_list"], ["price_abc,", "not_a_stripe_price_list"], ["price_abc, nope", "not_a_stripe_price_list"]],
  },
  "oidc-issuer": { validation: { type: "oidc-issuer" }, good: ["https://oidc.vercel.com/team_abc123"], bad: [["https://oidc.vercel.com", "not_a_team_oidc_issuer"], ["http://oidc.vercel.com/team_t", "not_a_team_oidc_issuer"], ["https://oidc.vercel.com/acme", "not_a_team_oidc_issuer"]] },
  "oidc-jwks-url": {
    validation: { type: "oidc-jwks-url" },
    good: ["https://oidc.vercel.com/team_abc123/.well-known/jwks"],
    bad: [["https://oidc.vercel.com/team_abc123", "not_an_oidc_jwks_url"], ["https://evil.test/team_abc123/.well-known/jwks", "not_an_oidc_jwks_url"], ["https://oidc.vercel.com/acme/.well-known/jwks", "not_an_oidc_jwks_url"]],
  },
  "uuid-list": {
    validation: { type: "uuid-list" },
    good: ["11111111-1111-4111-8111-111111111111", "11111111-1111-4111-8111-111111111111, 22222222-2222-4222-8222-222222222222"],
    bad: [["not-a-uuid", "not_a_uuid_list"], ["11111111-1111-4111-8111-111111111111,oops", "not_a_uuid_list"], ["11111111-1111-4111-8111-111111111111,", "not_a_uuid_list"]],
  },
  "subscription-token": {
    validation: { type: "subscription-token" },
    good: ["sk-ant-oat01-FAKE-FIXTURE-VALUE-NOT-A-CREDENTIAL"],
    bad: [["sk-ant-api03-FAKE-FIXTURE-VALUE-NOT-A-CREDENTIAL", "not_a_subscription_token"], ["Bearer sk-ant-oat01-FAKE-FIXTURE-VALUE-NOT-A-CREDENTIAL", "not_a_subscription_token"], ["short", "not_a_subscription_token"]],
  },
};

describe("validateValue", () => {
  for (const [type, c] of Object.entries(CASES)) {
    it(`${type}: accepts valid values and rejects bad ones with a fixed code`, () => {
      for (const good of c.good) expect(validateValue(c.validation, good), good).toBeNull();
      for (const [bad, reason] of c.bad) expect(validateValue(c.validation, bad), bad).toBe(reason);
    });
  }

  it("accepts a real private key and rejects a truncated one", async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(validateValue({ type: "pem-private-key" }, pem)).toBeNull();
    expect(validateValue({ type: "pem-private-key" }, pem.slice(0, pem.length - 40))).toBe("not_a_pem_private_key");
  });

  it("has a case for every validation type the manifest uses", () => {
    const used = new Set(ENV_MANIFEST.map((e) => e.validation.type));
    expect([...used].filter((t) => !(t in CASES))).toEqual([]);
  });

  it("never puts the value in the reason", () => {
    for (const c of Object.values(CASES)) {
      for (const [bad, reason] of c.bad) expect(reason.includes(bad) && bad.length > 3, `${c.validation.type}: ${reason}`).toBe(false);
    }
  });
});

describe("deployKindOf", () => {
  it("uses FX_DEPLOY_KIND when it names a kind", () => {
    expect(deployKindOf({ FX_DEPLOY_KIND: "staging", VERCEL_ENV: "production" })).toBe("staging");
  });
  it("treats a Vercel Production deployment as production, and everything else as local", () => {
    expect(deployKindOf({ VERCEL_ENV: "production" })).toBe("production");
    expect(deployKindOf({ VERCEL_ENV: "preview" })).toBe("local");
    expect(deployKindOf({})).toBe("local");
  });
  it("ignores a FX_DEPLOY_KIND it does not know", () => {
    expect(deployKindOf({ FX_DEPLOY_KIND: "prod", VERCEL_ENV: "production" })).toBe("production");
  });
});

describe("evaluateEnv", () => {
  const KINDS: DeployKind[] = ["staging", "production"];

  for (const kind of KINDS) {
    it(`${kind}: a complete environment is ok`, () => {
      const report = evaluateEnv(ENV_MANIFEST, completeEnv(kind), kind);
      expect(report).toMatchObject({ ok: true, missing: [], invalid: [] });
    });

    it(`${kind}: removing any one required setting reports exactly that name as missing`, () => {
      const required = ENV_MANIFEST.filter((e) => e.requiredIn.includes(kind));
      expect(required.length).toBeGreaterThan(20);
      for (const entry of required) {
        const env = completeEnv(kind);
        delete env[entry.name];
        const report = evaluateEnv(ENV_MANIFEST, env, kind);
        expect({ name: entry.name, ok: report.ok, missing: report.missing }).toEqual({ name: entry.name, ok: false, missing: [entry.name] });
      }
    });

    it(`${kind}: a blank required setting counts as missing`, () => {
      const env = { ...completeEnv(kind), FX_CURSOR_KEY_V1: "   " };
      expect(evaluateEnv(ENV_MANIFEST, env, kind).missing).toEqual(["FX_CURSOR_KEY_V1"]);
    });
  }

  it("reports an invalid required setting by name and reason, never by value", () => {
    const wrong = "definitely-not-base64-of-32-bytes-0123456789";
    const env = { ...completeEnv("staging"), FX_CURSOR_KEY_V1: wrong };
    const report = evaluateEnv(ENV_MANIFEST, env, "staging");
    expect(report.ok).toBe(false);
    expect(report.invalid).toEqual([{ name: "FX_CURSOR_KEY_V1", reason: "not_base64_32_bytes" }]);
    expect(JSON.stringify(report)).not.toContain(wrong);
  });

  it("rejects an origin with a trailing slash, which the CSRF check would never match", () => {
    const env = { ...completeEnv("production"), FX_APP_ORIGIN: "https://app.example.test/" };
    expect(evaluateEnv(ENV_MANIFEST, env, "production").invalid).toEqual([{ name: "FX_APP_ORIGIN", reason: "not_a_bare_origin" }]);
  });

  it("local needs nothing", () => {
    expect(evaluateEnv(ENV_MANIFEST, {}, "local")).toMatchObject({ ok: true, missing: [], invalid: [] });
  });

  it("reports an unset optional feature as disabled and does not fail on it", () => {
    const report = evaluateEnv(ENV_MANIFEST, completeEnv("production"), "production");
    expect(report.ok).toBe(true);
    const names = report.disabled.map((d) => d.name);
    expect(names).toContain("FX_API_TOKENS_ENABLED");
    expect(names).toContain("GITHUB_APP_SITEKIT_ID");
    expect(report.disabled.find((d) => d.name === "FX_API_TOKENS_ENABLED")?.feature).toBe("Public API tokens");
    // A variable with a default is not a disabled feature.
    expect(names).not.toContain("FX_SESSION_IDLE_SECONDS");
  });

  it("stops listing a feature as disabled once its setting is present", () => {
    const env = { ...completeEnv("production"), FX_API_TOKENS_ENABLED: "1" };
    expect(evaluateEnv(ENV_MANIFEST, env, "production").disabled.map((d) => d.name)).not.toContain("FX_API_TOKENS_ENABLED");
  });

  it("flags an invalid optional setting without failing the deployment", () => {
    const env = { ...completeEnv("production"), FX_SESSION_IDLE_SECONDS: "soon" };
    const report = evaluateEnv(ENV_MANIFEST, env, "production");
    expect(report.ok).toBe(true);
    expect(report.invalidOptional).toEqual([{ name: "FX_SESSION_IDLE_SECONDS", reason: "not_a_positive_integer" }]);
  });

  it("ignores platform and tooling names", () => {
    const env = { ...completeEnv("production"), ANTHROPIC_API_KEY: "", NODE_ENV: "weird" };
    expect(evaluateEnv(ENV_MANIFEST, env, "production")).toMatchObject({ ok: true, invalidOptional: [] });
  });
});

/**
 * The manifest check for the runner job-signing settings must accept and refuse exactly what the worker's loader does
 * (packages/worker/src/jobSigner.ts). The check cannot import the worker (it loads under Node type stripping, and a repo scan
 * keeps the worker's internals out of every other test), so the SAME fixture table is in both places: this file runs the table
 * through the manifest check, and packages/worker/test/jobSigner.test.ts ("agreement fixtures") runs it through the loader.
 * Change one table and the other must change with it.
 */
describe("runner job signer settings: agreement fixtures (the same table as the worker's loader test)", () => {
  const ed = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const oneLine = (pem: string): string => pem.trim().replace(/\n/g, "\\n");
  const KEYS: Array<[string, string, boolean]> = [
    ["an Ed25519 key", ed, true],
    ["an Ed25519 key with literal backslash-n", oneLine(ed), true],
    ["an Ed25519 key with surrounding whitespace", `\n  ${ed}  \n`, true],
    ["an RSA key", rsa, false],
    ["an RSA key with literal backslash-n", oneLine(rsa), false],
    ["a truncated key", ed.slice(0, ed.length - 40), false],
    ["text that is not a key", "plain text", false],
  ];
  for (const [label, pem, ok] of KEYS) {
    it(`key: ${label} is ${ok ? "accepted" : "refused"}`, () => {
      expect(validateValue({ type: "ed25519-private-key" }, pem) === null).toBe(ok);
    });
  }

  const IDS: Array<[string, boolean]> = [["job-signer-1", true], ["A.b_c-9", true], ["x".repeat(64), true], ["x".repeat(65), false], ["has space", false], ["a/b", false], ["a:b", false], ["ünï", false]];
  for (const [id, ok] of IDS) {
    it(`signer id ${JSON.stringify(id.length > 20 ? `${id.length} chars` : id)} is ${ok ? "accepted" : "refused"}`, () => {
      expect(validateValue({ type: "runner-signer-id" }, id) === null).toBe(ok);
    });
  }
});
