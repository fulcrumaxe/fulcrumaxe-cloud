import { toPolicy } from "@fx/env-network";
import type { EnvSpec } from "@fx/env-spec";
import { describe, expect, it } from "vitest";
import { mergeEnvNetwork } from "../src/index.js";
import { NET } from "./fakes.js";

const spec = (domains: string[]): EnvSpec =>
  ({ version: 1, setup: [], run: [], env: {}, secrets: [], services: [], network: { domains } }) as unknown as EnvSpec;

/** The runner's rules for one run: the model host with the brokered key (non-enumerable, as the runner builds it) and our proxy. */
function runnerRules() {
  const model = { host: "ai-gateway.vercel.sh", purpose: "model", authHeader: "Authorization" } as { host: string; purpose: string; authHeader?: string };
  Object.defineProperty(model, "authValue", { value: "Bearer secret-key", enumerable: false });
  return [model, { host: "gh-proxy.fx.example", purpose: "github_proxy" }];
}

describe("merging the environment's egress into the runner's rules", () => {
  it("adds the customer's exact hosts and the download hosts they switched on, and nothing else", () => {
    const merged = mergeEnvNetwork(runnerRules(), toPolicy(spec(["registry.npmjs.org", "raw.githubusercontent.com"]), NET));
    expect(merged.map((r) => [r.host, r.purpose])).toEqual([
      ["ai-gateway.vercel.sh", "model"],
      ["gh-proxy.fx.example", "github_proxy"],
      ["raw.githubusercontent.com", "github_download"],
      ["registry.npmjs.org", "customer_domain"],
    ]);
  });

  it("keeps the runner's own rule objects, so the brokered key stays on the model rule and on no other", () => {
    const base = runnerRules();
    const merged = mergeEnvNetwork(base, toPolicy(spec(["registry.npmjs.org"]), NET));
    expect(merged[0]).toBe(base[0]);
    expect((merged[0] as unknown as { authValue?: string }).authValue).toBe("Bearer secret-key");
    for (const added of merged.slice(2)) {
      expect(Object.keys(added).sort()).toEqual(["host", "purpose"]);
      expect((added as unknown as { authValue?: string }).authValue).toBeUndefined();
    }
    expect(JSON.stringify(merged)).not.toContain("secret-key");
  });

  it("never lets an environment reach GitHub around the proxy", () => {
    for (const domains of [["github.com"], ["api.github.com"], ["x.github.com"], ["githubusercontent.com"]]) {
      expect(() => toPolicy(spec(domains), NET)).toThrow(/reserved_host/);
    }
    const merged = mergeEnvNetwork(runnerRules(), toPolicy(spec(["codeload.github.com"]), NET));
    expect(merged.map((r) => r.host)).not.toContain("github.com");
    expect(merged.map((r) => r.host)).not.toContain("api.github.com");
  });

  it("re-checks a fragment that did not come from toPolicy: reserved, proxy-forwarded, other-cased and malformed hosts are refused", () => {
    const frag = (host: string, purpose: string) => ({ default: "deny", appliesAt: "creation", rules: [{ host, purpose }] }) as never;
    for (const host of ["github.com", "api.github.com", "GitHub.com", "api.github.com.", "x.github.com", "githubusercontent.com", "ai-gateway.vercel.sh", "api.anthropic.com"]) {
      for (const purpose of ["customer_domain", "github_download"]) {
        expect(() => mergeEnvNetwork(runnerRules(), frag(host, purpose)), `${host} as ${purpose}`).toThrow(/reserves|not a download host/);
      }
    }
    for (const host of ["*.example.com", "10.0.0.1", "a b", ""]) {
      expect(() => mergeEnvNetwork(runnerRules(), frag(host, "customer_domain")), host).toThrow(/not a plain hostname/);
    }
    // A switchable download host under the reserved apex passes only as itself, and is added in its normal form.
    expect(mergeEnvNetwork(runnerRules(), frag("Codeload.GitHub.com.", "github_download")).at(-1)).toEqual({ host: "codeload.github.com", purpose: "github_download" });
    expect(() => mergeEnvNetwork(runnerRules(), frag("codeload.github.com", "customer_domain"))).toThrow(/reserves/);
  });

  it("adds a host in its normalised form, and a spelling of a host the platform allows is a clash", () => {
    const frag = { default: "deny", appliesAt: "creation", rules: [{ host: "Registry.NPMJS.org.", purpose: "customer_domain" }] } as never;
    expect(mergeEnvNetwork(runnerRules(), frag).at(-1)).toEqual({ host: "registry.npmjs.org", purpose: "customer_domain" });
    const clash = [...runnerRules(), { host: "registry.npmjs.org", purpose: "package_registry" }];
    expect(() => mergeEnvNetwork(clash, frag)).toThrow(/already allows/);
  });

  it("a host the platform already allows is refused, not merged", () => {
    const clash = [...runnerRules(), { host: "registry.npmjs.org", purpose: "package_registry" }];
    expect(() => mergeEnvNetwork(clash, toPolicy(spec(["registry.npmjs.org"]), NET))).toThrow(/already allows/);
  });

  it("an environment with no domains adds nothing", () => {
    const base = runnerRules();
    expect(mergeEnvNetwork(base, toPolicy(spec([]), NET))).toEqual(base);
  });
});
