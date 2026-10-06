import { describe, expect, it } from "vitest";
import type { HostLookup } from "@fx/net-guard";
import { OPERATOR_OAUTH_PLACEHOLDER } from "@fx/runtime/src/operatorSubscription.js";
import { matchesShape, SK_ANT_API_PATTERN_SOURCE, SK_ANT_OAT_PATTERN_SOURCE } from "@fx/runtime/src/redact.js";
import { DecryptTenantKeyError, GithubForwardHostRefusedError, buildFirewallPolicy, buildOperatorFirewallPolicy } from "../src/firewallPolicy.js";
import { assertSandboxEnvMatchesRole } from "../src/fakeSandbox.js";
import { loadGithubForwardConfig } from "../src/githubForwardConfig.js";
import { modelAuthValue, networkPolicy } from "../src/networkPolicy.js";
import { ANTHROPIC_AUTH_TOKEN_PLACEHOLDER, buildSandboxEnv, isForbiddenSandboxEnvName } from "../src/sandboxEnv.js";
import { sdkNetworkPolicy } from "../src/vercelSandboxPort.js";
import { startPolicyFirewall } from "./helpers/policyFirewall.js";
import { httpsRoundTrip } from "../../github/test/helpers/localTlsServer.js";

const TOKEN = "sk-ant-oat01-FAKE-OPERATOR-TOKEN-FOR-TEST-ONLY";
const FORWARD = loadGithubForwardConfig({ FX_GH_FORWARD_SUFFIX: "gh-proxy.fulcrumaxe.app", FX_GH_FORWARD_HOST: "gh-proxy.fulcrumaxe.app" });
const lookupTo =
  (...addresses: string[]): HostLookup =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
const deps = (lookup: HostLookup = lookupTo("140.82.112.3")) => ({ githubForward: FORWARD, lookup });
const input = { role: "project-manager", product: "team" as const };

describe("networkPolicy: the operator_subscription connection kind", () => {
  it("allows api.anthropic.com only, with an Authorization transform, and no wildcard", () => {
    const rules = networkPolicy("project-manager", "team", { provider: "operator_subscription", githubForwardHost: FORWARD.host });
    const model = rules.filter((r) => r.purpose === "model");
    expect(model).toEqual([{ host: "api.anthropic.com", purpose: "model", authHeader: "Authorization" }]);
    expect(rules.map((r) => r.host).sort()).toEqual(["api.anthropic.com", FORWARD.host].sort());
    for (const rule of rules) expect(rule.host).not.toMatch(/[*]/);
  });

  it("does not add the gateway host, and the other kinds are unchanged", () => {
    const hosts = (provider: "ai_gateway" | "anthropic" | "operator_subscription") => networkPolicy("executor", "team", { provider }).map((r) => r.host);
    expect(hosts("operator_subscription")).toEqual(["api.anthropic.com"]);
    expect(hosts("anthropic")).toEqual(["api.anthropic.com"]);
    expect(hosts("ai_gateway")).toEqual(["ai-gateway.vercel.sh"]);
  });

  it("still refuses an unknown kind, including prototype-chain names", () => {
    for (const bad of ["constructor", "toString", "__proto__", "operator", "OPERATOR_SUBSCRIPTION"]) {
      expect(() => networkPolicy("executor", "team", { provider: bad as never })).toThrow(/unknown model provider/);
    }
  });

  it("builds a bearer value only from a subscription-token-shaped key", () => {
    expect(modelAuthValue("operator_subscription", TOKEN)).toBe(`Bearer ${TOKEN}`);
    for (const bad of ["sk-ant-api03-FAKE-API-KEY-FOR-TEST-ONLY", "plain-gateway-key-123", `${TOKEN}\r\nX-Evil: 1`, `${TOKEN} x`, "brokered-at-firewall", ""]) {
      expect(modelAuthValue("operator_subscription", bad)).toBeUndefined();
    }
    // The tenant kinds keep their shapes.
    expect(modelAuthValue("ai_gateway", "k")).toBe("Bearer k");
    expect(modelAuthValue("anthropic", "k")).toBe("k");
  });
});

describe("buildOperatorFirewallPolicy: the token's one exit is the model rule's hidden header value", () => {
  it("carries Authorization: Bearer <token> on api.anthropic.com only, invisible to serialisation and spreads", async () => {
    const rules = await buildOperatorFirewallPolicy(TOKEN, input, deps());
    const model = rules.find((r) => r.purpose === "model")!;
    expect([model.host, model.authHeader, model.authValue]).toEqual(["api.anthropic.com", "Authorization", `Bearer ${TOKEN}`]);
    expect(JSON.stringify(rules)).not.toContain("FAKE-OPERATOR");
    expect(JSON.stringify({ ...model })).not.toContain("FAKE-OPERATOR");
    expect(Object.keys(model)).not.toContain("authValue");
    for (const rule of rules.filter((r) => r.purpose !== "model")) expect(rule.authValue).toBeUndefined();
  });

  it("refuses a value that is not a subscription token with a fixed error that never echoes it", async () => {
    for (const bad of ["sk-ant-api03-FAKE-API-KEY-FOR-TEST-ONLY", "gateway-key-1234567", `${TOKEN}\n`, ""]) {
      const rejection = buildOperatorFirewallPolicy(bad, input, deps());
      await expect(rejection).rejects.toBeInstanceOf(DecryptTenantKeyError);
      await expect(rejection).rejects.toThrow(/^buildFirewallPolicy: failed to decrypt the tenant's model key$/);
      const err = await rejection.catch((e: Error) => e);
      expect(`${(err as Error).message}${(err as Error).stack}`).not.toContain(bad || "never-empty");
    }
  });

  it("keeps the GitHub forward checks: a forward host that resolves to a blocked address builds no policy", async () => {
    const rejection = buildOperatorFirewallPolicy(TOKEN, input, deps(lookupTo("127.0.0.1")));
    await expect(rejection).rejects.toBeInstanceOf(GithubForwardHostRefusedError);
    await expect(rejection).rejects.toMatchObject({ class: "blocked_address" });
  });

  it("leaves the tenant path as it was: the tenant decryptor still runs once and the operator path never calls it", async () => {
    let decrypts = 0;
    const encryptedKey = { ciphertext: new Uint8Array([1]), nonce: new Uint8Array(12), wrappedDek: new Uint8Array(32), kekVersion: 1 };
    await buildFirewallPolicy(async () => (decrypts++, "tenant-key-123456"), { ...input, provider: "ai_gateway", encryptedKey, keyContext: { accountId: "a", connectionId: "c" } }, deps());
    expect(decrypts).toBe(1);
    await buildOperatorFirewallPolicy(TOKEN, input, deps());
    expect(decrypts).toBe(1);
  });
});

describe("buildSandboxEnv: operator mode holds a placeholder and never a credential", () => {
  it("has exactly the CA paths, an empty API key slot and the fixed OAuth placeholder", () => {
    const env = buildSandboxEnv("project-manager", "operator_subscription");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(OPERATOR_OAUTH_PLACEHOLDER);
    expect(env.ANTHROPIC_API_KEY).toBe("");
    // ANTHROPIC_AUTH_TOKEN outranks the OAuth slot in the CLI's credential order: it must not be set.
    expect(Object.hasOwn(env, "ANTHROPIC_AUTH_TOKEN")).toBe(false);
    expect(Object.keys(env).sort()).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"]);
  });

  it("matches no credential shape in any value", () => {
    for (const value of Object.values(buildSandboxEnv("executor", "operator_subscription"))) {
      expect(matchesShape(value, SK_ANT_OAT_PATTERN_SOURCE)).toBe(false);
      expect(matchesShape(value, SK_ANT_API_PATTERN_SOURCE)).toBe(false);
    }
  });

  it("is the tenant env, unchanged, by default: no OAuth slot", () => {
    const env = buildSandboxEnv("executor");
    expect(Object.hasOwn(env, "CLAUDE_CODE_OAUTH_TOKEN")).toBe(false);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(ANTHROPIC_AUTH_TOKEN_PLACEHOLDER);
  });

  it("exempts the OAuth name only in operator mode", () => {
    expect(isForbiddenSandboxEnvName("CLAUDE_CODE_OAUTH_TOKEN")).toBe(true);
    expect(isForbiddenSandboxEnvName("CLAUDE_CODE_OAUTH_TOKEN", "tenant_key")).toBe(true);
    expect(isForbiddenSandboxEnvName("CLAUDE_CODE_OAUTH_TOKEN", "operator_subscription")).toBe(false);
    // Nothing else is exempted by the mode.
    for (const name of ["FX_OPERATOR_CLAUDE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN_2", "CLAUDE_CODE_OAUTH_TOKEN_2", "GH_TOKEN"]) {
      expect(isForbiddenSandboxEnvName(name, "operator_subscription"), name).toBe(true);
    }
  });

  it("the sandbox port's env check accepts the operator env and rejects a real token under the OAuth name", () => {
    expect(() => assertSandboxEnvMatchesRole("executor", buildSandboxEnv("executor", "operator_subscription"))).not.toThrow();
    expect(() => assertSandboxEnvMatchesRole("executor", buildSandboxEnv("executor"))).not.toThrow();
    const smuggled = { ...buildSandboxEnv("executor", "operator_subscription"), CLAUDE_CODE_OAUTH_TOKEN: TOKEN };
    let message = "";
    try {
      assertSandboxEnvMatchesRole("executor", smuggled);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/mismatched keys: \["CLAUDE_CODE_OAUTH_TOKEN"\]/);
    expect(message).not.toContain("FAKE-OPERATOR");
  });
});

/**
 * Real-contract test (owner rule 1). The injection is done by the platform's firewall, so this stands up a stand-in
 * for it as a local HTTPS server and drives it with `https.request` on Node's default connect path: TLS with the
 * server's certificate as an explicit `ca`, SNI and hostname verification on, and a custom `lookup` that answers
 * the `{ all: true }` call Node >= 20 makes. The policy it applies is the one `sdkNetworkPolicy` really builds from
 * the operator rules. Not faithful, and said so in the PR: the platform's own edge cases (see policyFirewall.ts).
 */
describe("the operator policy over a real TLS connection", () => {
  async function setup() {
    const rules = await buildOperatorFirewallPolicy(TOKEN, input, deps());
    const policy = sdkNetworkPolicy(rules);
    const firewall = await startPolicyFirewall(policy, ["api.anthropic.com", "exfil.example"]);
    const lookup = ((_host: string, options: { all?: boolean }, cb: (err: Error | null, a: unknown, f?: number) => void) =>
      options?.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4)) as never;
    const call = (host: string, headers: Record<string, string>) =>
      httpsRoundTrip({ host, port: firewall.port, method: "POST", path: "/v1/messages", ca: firewall.ca, lookup, headers }, "{}");
    return { firewall, call, policy, rules };
  }

  it("replaces the placeholder Authorization with the operator's bearer token, and leaves the CLI's own headers alone", async () => {
    const { firewall, call } = await setup();
    try {
      const res = await call("api.anthropic.com", {
        authorization: `Bearer ${OPERATOR_OAUTH_PLACEHOLDER}`,
        "anthropic-beta": "oauth-2025-04-20,claude-code-20250219",
        "anthropic-version": "2023-06-01",
      });
      expect(res.status).toBe(200);
      expect(firewall.origin).toHaveLength(1);
      const seen = firewall.origin[0]!.headers;
      expect(seen.authorization).toBe(`Bearer ${TOKEN}`);
      expect(seen["anthropic-beta"]).toBe("oauth-2025-04-20,claude-code-20250219");
      expect(seen["anthropic-version"]).toBe("2023-06-01");
      expect(JSON.stringify(seen)).not.toContain(OPERATOR_OAUTH_PLACEHOLDER);
    } finally {
      await firewall.close();
    }
  });

  it("overrides an Authorization header the sandbox made up itself, whatever its case", async () => {
    const { firewall, call } = await setup();
    try {
      await call("api.anthropic.com", { AUTHORIZATION: "Bearer attacker-chosen" });
      expect(firewall.origin[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(Object.keys(firewall.origin[0]!.headers).filter((k) => k.toLowerCase() === "authorization")).toHaveLength(1);
    } finally {
      await firewall.close();
    }
  });

  it("gives the token to no other host: a destination outside the policy is refused and never reaches the origin", async () => {
    const { firewall, call } = await setup();
    try {
      const res = await call("exfil.example", { authorization: `Bearer ${OPERATOR_OAUTH_PLACEHOLDER}` });
      expect(res.status).toBe(403);
      expect(firewall.origin).toHaveLength(0);
      expect(res.body).not.toContain("FAKE-OPERATOR");
    } finally {
      await firewall.close();
    }
  });

  it("puts the token in the policy for api.anthropic.com alone, and in neither the rules' JSON nor the sandbox env", async () => {
    const { policy, rules } = await setup();
    const allow = (policy as { allow: Record<string, Array<{ transform?: Array<{ headers: Record<string, string> }> }>> }).allow;
    const holders = Object.entries(allow).filter(([, rs]) => JSON.stringify(rs).includes("FAKE-OPERATOR"));
    expect(holders.map(([host]) => host)).toEqual(["api.anthropic.com"]);
    expect(JSON.stringify(rules)).not.toContain("FAKE-OPERATOR");
    expect(JSON.stringify(buildSandboxEnv("project-manager", "operator_subscription"))).not.toContain("FAKE-OPERATOR");
  });
});
