import { describe, expect, it } from "vitest";
import type { NetworkPolicyRule } from "../src/networkPolicy.js";
import { sdkNetworkPolicy } from "../src/vercelSandboxPort.js";

/**
 * D#5 E9: the environment's two rule purposes are valid runner rules, and the SDK policy built from them allows the
 * exact host with no transform and no forward target: never a header, never our GitHub proxy.
 */
describe("environment egress rules in the SDK policy", () => {
  const model = { host: "ai-gateway.vercel.sh", purpose: "model", authHeader: "Authorization" } as NetworkPolicyRule;
  Object.defineProperty(model, "authValue", { value: "Bearer k", enumerable: false });
  const rules: NetworkPolicyRule[] = [
    model,
    { host: "gh-proxy.fx.example", purpose: "github_proxy" },
    { host: "codeload.github.com", purpose: "github_download" },
    { host: "registry.npmjs.org", purpose: "customer_domain" },
  ];

  it("allows each added host exactly, with an empty rule list", () => {
    const policy = sdkNetworkPolicy(rules) as { allow: Record<string, unknown[]> };
    expect(policy.allow["codeload.github.com"]).toEqual([]);
    expect(policy.allow["registry.npmjs.org"]).toEqual([]);
  });

  it("refuses a host that is already allowed, in either order, so no rule can replace the proxy forwarding or the key", () => {
    const proxy: NetworkPolicyRule = { host: "gh-proxy.fx.example", purpose: "github_proxy" };
    for (const host of ["github.com", "api.github.com"]) {
      for (const purpose of ["customer_domain", "github_download"] as const) {
        const env: NetworkPolicyRule = { host, purpose };
        expect(() => sdkNetworkPolicy([proxy, env]), `${host} after`).toThrow(/same host/);
        expect(() => sdkNetworkPolicy([env, proxy]), `${host} before`).toThrow(/same host/);
      }
    }
    expect(() => sdkNetworkPolicy([model, { host: "ai-gateway.vercel.sh", purpose: "customer_domain" }])).toThrow(/same host/);
    expect(() => sdkNetworkPolicy([{ host: "a.example.com", purpose: "customer_domain" }, { host: "a.example.com", purpose: "customer_domain" }])).toThrow(/same host/);
  });

  it("keeps the proxy's forward rule on exactly github.com and api.github.com, and the key on the model host alone", () => {
    const policy = sdkNetworkPolicy(rules) as { allow: Record<string, unknown[]> };
    expect(Object.keys(policy.allow).sort()).toEqual(["ai-gateway.vercel.sh", "api.github.com", "codeload.github.com", "github.com", "registry.npmjs.org"]);
    for (const host of ["github.com", "api.github.com"]) expect(JSON.stringify(policy.allow[host])).toContain("forwardURL");
    for (const host of ["codeload.github.com", "registry.npmjs.org"]) expect(JSON.stringify(policy.allow[host])).not.toMatch(/forwardURL|transform|Bearer/);
    expect(JSON.stringify(policy.allow["ai-gateway.vercel.sh"])).toContain("Bearer k");
  });
});
