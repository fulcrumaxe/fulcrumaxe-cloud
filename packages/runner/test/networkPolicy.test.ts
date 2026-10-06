import { describe, expect, it } from "vitest";
import { INSTALL_PHASE_REGISTRY_ALLOWLIST, networkPolicy, type Connection } from "../src/networkPolicy.js";
import type { ModelProvider, Product, Role } from "../src/types.js";

const ROLES: Role[] = ["executor", "code-reviewer", "project-manager", "security-reviewer"];
const PRODUCTS: Product[] = ["team", "sitekit"];
const PROVIDERS: ModelProvider[] = ["ai_gateway", "anthropic"];

function connectionFor(provider: ModelProvider): Connection {
  return { provider, githubForwardHost: "gh-proxy.fulcrumaxe.app" };
}

/**
 * D#2 H09 pass/fail 2: "networkPolicy(role, product, connection) is
 * deny-by-default. The only allowed destinations are the tenant's model
 * endpoint (ai-gateway.vercel.sh with an Authorization transform for
 * ai_gateway, or api.anthropic.com with an x-api-key transform for
 * anthropic, never both), GitHub hosts via forwardURL to our proxy, and a
 * package-registry allowlist during the `fx test` install phase only. A
 * test asserts no policy contains a `*` rule for any role."
 */
describe("networkPolicy (D#2 H09 pass/fail 2)", () => {
  it("no policy contains a wildcard rule, for any role x product x provider combination", () => {
    for (const role of ROLES) {
      for (const product of PRODUCTS) {
        for (const provider of PROVIDERS) {
          for (const phase of ["run", "install"] as const) {
            const rules = networkPolicy(role, product, connectionFor(provider), phase);
            for (const rule of rules) {
              expect(rule.host).not.toBe("*");
              expect(rule.host).not.toContain("*");
            }
          }
        }
      }
    }
  });

  it("ai_gateway gets exactly ai-gateway.vercel.sh with an Authorization transform, never api.anthropic.com", () => {
    const rules = networkPolicy("executor", "team", connectionFor("ai_gateway"));
    const modelRules = rules.filter((r) => r.purpose === "model");
    expect(modelRules).toHaveLength(1);
    expect(modelRules[0].host).toBe("ai-gateway.vercel.sh");
    expect(modelRules[0].authHeader).toBe("Authorization");
    expect(rules.some((r) => r.host === "api.anthropic.com")).toBe(false);
  });

  it("anthropic gets exactly api.anthropic.com with an x-api-key transform, never ai-gateway.vercel.sh", () => {
    const rules = networkPolicy("executor", "team", connectionFor("anthropic"));
    const modelRules = rules.filter((r) => r.purpose === "model");
    expect(modelRules).toHaveLength(1);
    expect(modelRules[0].host).toBe("api.anthropic.com");
    expect(modelRules[0].authHeader).toBe("x-api-key");
    expect(rules.some((r) => r.host === "ai-gateway.vercel.sh")).toBe(false);
  });

  it("never allows both model hosts at once", () => {
    for (const provider of PROVIDERS) {
      const rules = networkPolicy("executor", "team", connectionFor(provider));
      const modelHosts = rules.filter((r) => r.purpose === "model").map((r) => r.host);
      expect(modelHosts).toHaveLength(1);
    }
  });

  it("GitHub traffic is allowed only via the connection's own forwardURL, never a raw GitHub host", () => {
    const rules = networkPolicy("executor", "team", connectionFor("ai_gateway"));
    expect(rules.some((r) => r.purpose === "github_proxy" && r.host === "gh-proxy.fulcrumaxe.app")).toBe(true);
    expect(rules.some((r) => r.host === "github.com")).toBe(false);
    expect(rules.some((r) => r.host === "api.github.com")).toBe(false);
  });

  it("package-registry allowlist appears only during the install phase, never during a run", () => {
    const runRules = networkPolicy("executor", "team", connectionFor("ai_gateway"), "run");
    expect(runRules.some((r) => r.purpose === "package_registry")).toBe(false);

    const installRules = networkPolicy("executor", "team", connectionFor("ai_gateway"), "install");
    const registryHosts = installRules.filter((r) => r.purpose === "package_registry").map((r) => r.host);
    expect(registryHosts).toEqual([...INSTALL_PHASE_REGISTRY_ALLOWLIST]);
  });

  it("defaults to the run phase when phase is omitted", () => {
    const defaulted = networkPolicy("executor", "team", connectionFor("ai_gateway"));
    const explicit = networkPolicy("executor", "team", connectionFor("ai_gateway"), "run");
    expect(defaulted).toEqual(explicit);
  });

  it("throws on an unrecognized provider rather than silently allowing an unknown host", () => {
    const badConnection = { provider: "unknown" as unknown as ModelProvider, githubForwardHost: "gh-proxy.fulcrumaxe.app" };
    expect(() => networkPolicy("executor", "team", badConnection)).toThrow();
  });

  it("is deny-by-default: the returned list is always small and finite, never grows with role/product", () => {
    for (const role of ROLES) {
      for (const product of PRODUCTS) {
        const rules = networkPolicy(role, product, connectionFor("ai_gateway"));
        // model + github_proxy only, during a run.
        expect(rules).toHaveLength(2);
      }
    }
  });

  /**
   * H09 security review, "must fix" 1: `githubForwardHost` was used
   * unchecked, so a hostile value could produce a wildcard rule, a second
   * model host, raw GitHub access, or an empty host. Each input below is
   * one the reviewer's probe script actually produced a bad rule for.
   */
  describe("githubForwardHost is a strict hostname (H09 security review, must-fix 1)", () => {
    const HOSTILE_FORWARD_HOSTS = ["*", "", "api.anthropic.com", "github.com", "registry.npmjs.org"];

    it.each(HOSTILE_FORWARD_HOSTS)("rejects githubForwardHost = %j", (hostileHost) => {
      const badConnection: Connection = { provider: "ai_gateway", githubForwardHost: hostileHost };
      expect(() => networkPolicy("executor", "team", badConnection)).toThrow();
    });

    it("rejects ai-gateway.vercel.sh (the other provider's model host) too", () => {
      const badConnection: Connection = { provider: "anthropic", githubForwardHost: "ai-gateway.vercel.sh" };
      expect(() => networkPolicy("executor", "team", badConnection)).toThrow();
    });

    it("rejects api.github.com and any *.github.com / *.githubusercontent.com host", () => {
      for (const host of ["api.github.com", "evil.github.com", "raw.githubusercontent.com"]) {
        const badConnection: Connection = { provider: "ai_gateway", githubForwardHost: host };
        expect(() => networkPolicy("executor", "team", badConnection)).toThrow();
      }
    });

    it("rejects npm.pkg.github.com (the second registry allowlist entry) as a forward host", () => {
      const badConnection: Connection = { provider: "ai_gateway", githubForwardHost: "npm.pkg.github.com" };
      expect(() => networkPolicy("executor", "team", badConnection)).toThrow();
    });

    it("rejects a wildcard embedded inside an otherwise hostname-shaped string", () => {
      const badConnection: Connection = { provider: "ai_gateway", githubForwardHost: "github_proxy:*" };
      expect(() => networkPolicy("executor", "team", badConnection)).toThrow();
    });

    it("still accepts a legitimate, distinct proxy host", () => {
      const rules = networkPolicy("executor", "team", connectionFor("ai_gateway"));
      expect(rules.some((r) => r.purpose === "github_proxy" && r.host === "gh-proxy.fulcrumaxe.app")).toBe(true);
    });
  });

  /**
   * H09 security RE-review, "must fix" 1: the first round's check was an
   * exact-string denylist, not a strict-hostname check -- it lowercased
   * and compared the value against a fixed set of spellings, so every
   * variant below (same DNS name, different byte string) reached GitHub,
   * an extra model host, or the package registry unchanged. Each case
   * here is one the reviewer's own probe script produced a bad rule for
   * against the first fix round.
   */
  describe("githubForwardHost rejects variant spellings of the same reserved hosts (H09 security RE-review, must-fix 1)", () => {
    const REJECTED_VARIANTS = [
      // Trailing dot -- the identical DNS name as the blocked host.
      "github.com.",
      "api.github.com.",
      "raw.githubusercontent.com.",
      "api.anthropic.com.",
      "registry.npmjs.org.",
      "github.com..",
      // The githubusercontent.com apex itself (the old suffix-only check
      // needed a leading dot, so the bare apex slipped through).
      "githubusercontent.com",
      // IP literals in every form the review named.
      "140.82.112.3",
      "140.82.112.6",
      "169.254.169.254",
      "0.0.0.0",
      "[2606:50c0:8000::153]",
      "2606:50c0:8000::153",
      "0x8c527003",
      "2354212867",
      // A port, or other URL parts, appended to a reserved host.
      "github.com:443",
      "api.github.com:443",
      "api.anthropic.com:443",
      "github.com/path",
      "gh-proxy.fulcrumaxe.app/../github.com",
      "https://github.com",
      "user@github.com",
      "github.com%2e",
      // Whitespace and separators around or joining a reserved host.
      " ",
      " github.com",
      "github.com ",
      "github.com\n",
      "\tgithub.com",
      "gh-proxy.fulcrumaxe.app,github.com",
      "gh-proxy.fulcrumaxe.app github.com",
      // Non-ASCII lookalikes an IDNA/UTS-46-aware matcher would fold back
      // to github.com, but which are not the literal ASCII string.
      "ｇｉｔｈｕｂ.ｃｏｍ",
      "github。com",
      "xn--github-.com",
      "gıthub.com",
      "GİTHUB.COM",
      // Not a hostname at all, and not a local shortcut around the proxy.
      "localhost",
    ];

    it.each(REJECTED_VARIANTS)("rejects githubForwardHost = %j", (variant) => {
      const badConnection: Connection = { provider: "ai_gateway", githubForwardHost: variant };
      expect(() => networkPolicy("executor", "team", badConnection)).toThrow();
    });

    it("rejects an upper-case spelling of a reserved host, not only the lower-case form", () => {
      for (const host of ["GITHUB.COM", "Api.GitHub.Com", "RAW.GITHUBUSERCONTENT.COM", "API.ANTHROPIC.COM."]) {
        const badConnection: Connection = { provider: "ai_gateway", githubForwardHost: host };
        expect(() => networkPolicy("executor", "team", badConnection)).toThrow();
      }
    });

    it("a legitimate proxy host is still accepted unchanged after the strict-hostname check", () => {
      // Guards against the strict check becoming so strict it also
      // rejects the one host every other test in this file relies on.
      const rules = networkPolicy("executor", "team", connectionFor("ai_gateway"));
      expect(rules.find((r) => r.purpose === "github_proxy")?.host).toBe("gh-proxy.fulcrumaxe.app");
    });
  });

  /**
   * H09 security review, "must fix" 1: the provider lookup was a plain
   * object index, so a prototype-chain name resolved to an inherited
   * `Object.prototype` member instead of throwing "unknown provider" --
   * `JSON.stringify` then drops that non-string `host`, leaving a
   * host-less `{"purpose":"model"}` rule.
   */
  describe("provider lookup rejects prototype-chain names (H09 security review, must-fix 1)", () => {
    const PROTOTYPE_KEY_PROVIDERS = ["constructor", "toString", "hasOwnProperty", "__proto__"];

    it.each(PROTOTYPE_KEY_PROVIDERS)("rejects provider = %j as unknown, not an inherited member", (badProvider) => {
      const badConnection = {
        provider: badProvider as unknown as ModelProvider,
        githubForwardHost: "gh-proxy.fulcrumaxe.app",
      };
      expect(() => networkPolicy("executor", "team", badConnection)).toThrow();
    });
  });
});
