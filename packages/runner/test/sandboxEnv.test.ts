import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_API_KEY_EXEMPT_NAME,
  ANTHROPIC_AUTH_TOKEN_EXEMPT_NAME,
  ANTHROPIC_AUTH_TOKEN_PLACEHOLDER,
  FORBIDDEN_ENV_NAME_PATTERN,
  buildSandboxEnv,
  isForbiddenSandboxEnvName,
} from "../src/sandboxEnv.js";
import type { Role } from "../src/types.js";

const ROLES: Role[] = [
  "executor",
  "code-reviewer",
  "security-reviewer",
  "project-manager",
  "acceptance-tester",
  "browser-tester",
  "technical-architect",
  "product-owner",
  "cost-analyst",
  "performance-expert",
  "security-expert",
  "researcher",
];

/** A representative set of real secret shapes this codebase actually
 * injects/handles elsewhere -- the "fake customer key, installation
 * token, App key, Stripe key, KEK or webhook secret" the Spec names. If
 * `buildSandboxEnv` ever grew a code path that read ambient input, one of
 * these constants slipping into its output is exactly what this test
 * would catch.
 *
 * Correction C7 on D#2 (brief-only note for H09): "The criterion 4
 * sandbox-env check injects fake `fxat_…` and `whsec_…` values too." --
 * this platform's own API-token and webhook-secret shapes (D#31 API-3/
 * API-4), added alongside the third-party shapes above so a future
 * `buildSandboxEnv` change can't leak either. */
const FAKE_INJECTED_SECRETS: readonly string[] = [
  "fake-customer-model-key-abc123",
  "ghs_fakeInstallationToken000000000000",
  "fake-github-app-private-key-pem-blob",
  "sk_test_fakeStripeSecretKey0000000000",
  "fake-kek-material-base64-0000000000==",
  "fake-webhook-signing-secret-0000000000",
  // fxat_ + 49 alphanumeric characters (this platform's API token shape).
  "fxat_fake0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHI",
  // whsec_ + 32 base64 characters (this platform's webhook secret shape).
  "whsec_fakeabcdefghijklmnopqrstuvwxyzAB",
];

/**
 * D#2 H09 pass/fail 4: "The sandbox env for every role contains no value
 * matching the injected fake customer key, installation token, App key,
 * Stripe key, KEK or webhook secret, and no variable named like
 * /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/ except ANTHROPIC_API_KEY="" and
 * a placeholder ANTHROPIC_AUTH_TOKEN (test)."
 */
describe("buildSandboxEnv: trust for the per-sandbox proxy CA (GitHub traffic is TLS-terminated by the firewall)", () => {
  it("points clone/push, gh, curl and node at the system bundle, for every role", () => {
    for (const role of ROLES) {
      const env = buildSandboxEnv(role);
      for (const name of ["GIT_SSL_CAINFO", "SSL_CERT_FILE", "CURL_CA_BUNDLE", "NODE_EXTRA_CA_CERTS"]) {
        expect(env[name]).toBe("/etc/ssl/certs/ca-certificates.crt");
        expect(isForbiddenSandboxEnvName(name)).toBe(false);
      }
    }
  });
});

describe("buildSandboxEnv (D#2 H09 pass/fail 4)", () => {
  it("for every role, no env var name matches the forbidden pattern except the two exempt placeholders", () => {
    for (const role of ROLES) {
      const env = buildSandboxEnv(role);
      for (const name of Object.keys(env)) {
        if (name === ANTHROPIC_API_KEY_EXEMPT_NAME || name === ANTHROPIC_AUTH_TOKEN_EXEMPT_NAME) continue;
        expect(FORBIDDEN_ENV_NAME_PATTERN.test(name)).toBe(false);
      }
    }
  });

  it("ANTHROPIC_API_KEY is exempt and empty; ANTHROPIC_AUTH_TOKEN is exempt and a placeholder, never a real-shaped token", () => {
    for (const role of ROLES) {
      const env = buildSandboxEnv(role);
      expect(env[ANTHROPIC_API_KEY_EXEMPT_NAME]).toBe("");
      expect(env[ANTHROPIC_AUTH_TOKEN_EXEMPT_NAME]).toBe(ANTHROPIC_AUTH_TOKEN_PLACEHOLDER);
      expect(env[ANTHROPIC_AUTH_TOKEN_EXEMPT_NAME]).not.toMatch(/^sk-ant-/);
    }
  });

  it("contains no value matching any injected fake secret, for every role", () => {
    for (const role of ROLES) {
      const env = buildSandboxEnv(role);
      const serialized = JSON.stringify(env);
      for (const secret of FAKE_INJECTED_SECRETS) {
        expect(serialized).not.toContain(secret);
      }
    }
  });

  it("never reads process.env -- injecting a forbidden var into process.env does not leak into the output", () => {
    const probeName = "STRIPE_SECRET_KEY";
    const original = process.env[probeName];
    process.env[probeName] = "sk_test_fakeStripeSecretKey0000000000";
    try {
      const env = buildSandboxEnv("executor");
      expect(env[probeName]).toBeUndefined();
      expect(JSON.stringify(env)).not.toContain(process.env[probeName]!);
    } finally {
      if (original === undefined) delete process.env[probeName];
      else process.env[probeName] = original;
    }
  });

  it("isForbiddenSandboxEnvName matches the Spec's own KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL set, case-insensitively", () => {
    for (const bad of ["STRIPE_SECRET_KEY", "installation_token", "WEBHOOK_SECRET", "DB_PASSWORD", "KEK_CREDENTIAL"]) {
      expect(isForbiddenSandboxEnvName(bad)).toBe(true);
    }
    for (const ok of ["ANTHROPIC_MODEL", "NODE_ENV", "HOME", "PATH"]) {
      expect(isForbiddenSandboxEnvName(ok)).toBe(false);
    }
  });

  /**
   * H09 security review, "informational" 1: the Spec's own
   * /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/ pattern misses abbreviated or
   * lookalike credential names -- `GH_PAT`, `PASSWD`, and a `*_PEM`
   * private-key blob name -- so extend the forbidden-name check to cover
   * them too, without flagging ordinary names like `PATH`.
   */
  it("isForbiddenSandboxEnvName also catches GH_PAT, PASSWD, and *_PEM names", () => {
    for (const bad of ["GH_PAT", "PASSWD", "DB_PASSWD", "PRIVATE_PEM", "CLIENT_CERT_PEM"]) {
      expect(isForbiddenSandboxEnvName(bad)).toBe(true);
    }
  });

  it("the extended pattern does not flag ordinary names that merely contain PAT as a substring", () => {
    for (const ok of ["PATH", "COMPATIBLE_MODE", "REPO_PATH"]) {
      expect(isForbiddenSandboxEnvName(ok)).toBe(false);
    }
  });

  /**
   * H09 security re-review, "suggestion" 3: `KEK` (a key-encryption key --
   * named in the Spec's own pass/fail 4 alongside the other secret shapes
   * the sandbox env must never contain) and a bare `PEM` (not only the
   * existing `*_PEM` suffix) were not flagged.
   */
  it("isForbiddenSandboxEnvName also catches bare KEK and bare PEM names", () => {
    for (const bad of ["KEK", "kek", "APP_KEK", "KEK_VERSION", "PEM", "pem"]) {
      expect(isForbiddenSandboxEnvName(bad)).toBe(true);
    }
  });

  /**
   * D#66 CORRECTION C1: `PEM_DIR` is removed from this "ok" array. Decision
   * (e) states the intent explicitly -- "`PEM_DIR` becomes forbidden too.
   * That is deliberate" -- so the specific rule wins over criterion 9's
   * general "unchanged" clause for this one token. See the new
   * `isForbiddenSandboxEnvName also forbids PEM_DIR and the other
   * env-name-fix criterion cases (D#66)` test below for `PEM_DIR`'s new
   * expected result.
   */
  it("the KEK/PEM extension does not flag ordinary names that merely contain those letters", () => {
    for (const ok of ["PEMBROKE", "TEMPLATE", "KEKO", "KEKULE_STRUCTURE"]) {
      expect(isForbiddenSandboxEnvName(ok)).toBe(false);
    }
  });

  it("isForbiddenSandboxEnvName exempts exactly the two placeholder names, even though their names match the pattern", () => {
    expect(FORBIDDEN_ENV_NAME_PATTERN.test(ANTHROPIC_API_KEY_EXEMPT_NAME)).toBe(true);
    expect(FORBIDDEN_ENV_NAME_PATTERN.test(ANTHROPIC_AUTH_TOKEN_EXEMPT_NAME)).toBe(true);
    expect(isForbiddenSandboxEnvName(ANTHROPIC_API_KEY_EXEMPT_NAME)).toBe(false);
    expect(isForbiddenSandboxEnvName(ANTHROPIC_AUTH_TOKEN_EXEMPT_NAME)).toBe(false);
  });

  /**
   * D#66, Spec (Acceptance) criterion 9 ("Env-name fix"), and CORRECTION
   * C1: `PEM_DIR` is now forbidden (decision (e) states the intent
   * explicitly), alongside the other carried-over gaps -- a name that
   * isn't even a well-formed env-var identifier (a leading/trailing
   * space, a hyphen) is forbidden too.
   */
  it("D#66: isForbiddenSandboxEnvName forbids the env-name-fix criterion's bad set", () => {
    for (const bad of ["APP_PEM_FILE", "GH_PAT ", " GH_PAT", "GH-PAT", "PEM_DIR", "MY_PEM", "PEM"]) {
      expect(isForbiddenSandboxEnvName(bad)).toBe(true);
    }
  });

  it("D#66: isForbiddenSandboxEnvName allows the env-name-fix criterion's ok set", () => {
    for (const ok of ["PATH", "COMPATIBLE_MODE", "PEMBROKE", "HOME", ANTHROPIC_API_KEY_EXEMPT_NAME, ANTHROPIC_AUTH_TOKEN_EXEMPT_NAME]) {
      expect(isForbiddenSandboxEnvName(ok)).toBe(false);
    }
  });
});
