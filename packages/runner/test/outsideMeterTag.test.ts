import { describe, expect, it } from "vitest";
import { mintGatewayTag } from "@fx/spend";
import { buildFirewallPolicy, type FirewallPolicyDeps, type FirewallPolicyInput } from "../src/firewallPolicy.js";
import { loadGithubForwardConfig } from "../src/githubForwardConfig.js";
import { sdkNetworkPolicy } from "../src/vercelSandboxPort.js";

/** D#221 OM-2 (C6 3.2): the tag is added outside the VM, in the model rule's header transform, and nowhere else. */
const KEY = "vck_plaintext-tenant-key-aaa111";
const deps: FirewallPolicyDeps = {
  githubForward: loadGithubForwardConfig({ FX_GH_FORWARD_SUFFIX: "gh-proxy.fulcrumaxe.app", FX_GH_FORWARD_HOST: "gh-proxy.fulcrumaxe.app" }),
  lookup: async () => [{ address: "140.82.112.3", family: 4 }],
};
const input = (provider: "ai_gateway" | "anthropic", reportTag?: string): FirewallPolicyInput => ({
  role: "executor",
  product: "team",
  provider,
  encryptedKey: { ciphertext: new Uint8Array(1), nonce: new Uint8Array(12), wrappedDek: new Uint8Array(32), kekVersion: 1 },
  keyContext: { accountId: "a", connectionId: "c" },
  ...(reportTag && { reportTag }),
});
const decrypt = async (): Promise<string> => KEY;

/** The write side of the gateway as documented: our transform's tags are merged with any the VM sent (a union, at most 10). */
function gatewayAppliesTransform(vmTags: string[], transformHeaders: Record<string, string>): { status: number; tags: string[] } {
  const ours = transformHeaders["ai-reporting-tags"];
  const tags = [...new Set([...vmTags, ...(ours ? [ours] : [])])];
  return tags.length > 10 || tags.some((t) => !/^[\w.-]{1,64}$/.test(t)) ? { status: 400, tags: [] } : { status: 200, tags };
}

describe("report tag injection (D#221 OM-2)", () => {
  it("rides in the model rule's transform next to the auth header, and is non-enumerable on the rule", async () => {
    const tag = mintGatewayTag();
    const rules = await buildFirewallPolicy(decrypt, input("ai_gateway", tag), deps);
    const model = rules.find((r) => r.purpose === "model")!;
    expect(model.reportTag).toBe(tag);
    expect(Object.keys(model)).not.toContain("reportTag");
    expect(JSON.stringify(rules)).not.toContain(tag);
    expect(JSON.stringify(rules)).not.toContain(KEY);
    const allow = (sdkNetworkPolicy(rules) as { allow: Record<string, { transform: { headers: Record<string, string> }[] }[]> }).allow;
    expect(allow["ai-gateway.vercel.sh"]![0]!.transform[0]!.headers).toEqual({ Authorization: `Bearer ${KEY}`, "ai-reporting-tags": tag });
    // The tag appears in no other host's rule.
    expect(JSON.stringify(Object.entries(allow).filter(([h]) => h !== "ai-gateway.vercel.sh"))).not.toContain(tag);
  });

  it("an Anthropic-direct rule carries no tag header, even if one is passed", async () => {
    const rules = await buildFirewallPolicy(decrypt, input("anthropic", mintGatewayTag()), deps);
    const allow = (sdkNetworkPolicy(rules) as { allow: Record<string, { transform: { headers: Record<string, string> }[] }[]> }).allow;
    expect(Object.keys(allow["api.anthropic.com"]![0]!.transform[0]!.headers)).toEqual(["x-api-key"]);
  });

  it("refuses a value that is not a minted tag (a run id never becomes one)", async () => {
    await expect(buildFirewallPolicy(decrypt, input("ai_gateway", "0b9f3c1e-6d2a-4c57-9a41-3f2d1e8b7a60"), deps)).rejects.toThrow(/report tag/);
  });

  it("with no tag the transform is the auth header alone", async () => {
    const rules = await buildFirewallPolicy(decrypt, input("ai_gateway"), deps);
    const allow = (sdkNetworkPolicy(rules) as { allow: Record<string, { transform: { headers: Record<string, string> }[] }[]> }).allow;
    expect(Object.keys(allow["ai-gateway.vercel.sh"]![0]!.transform[0]!.headers)).toEqual(["Authorization"]);
  });

  it("write-side fake: the union keeps our tag even when the VM sends its own, and 10 VM tags get a 400 on its own requests", async () => {
    const tag = mintGatewayTag();
    const rules = await buildFirewallPolicy(decrypt, input("ai_gateway", tag), deps);
    const headers = (sdkNetworkPolicy(rules) as { allow: Record<string, { transform: { headers: Record<string, string> }[] }[]> }).allow["ai-gateway.vercel.sh"]![0]!.transform[0]!.headers;
    expect(gatewayAppliesTransform(["vm_tag"], headers).tags).toContain(tag);
    expect(gatewayAppliesTransform([], headers)).toEqual({ status: 200, tags: [tag] });
    expect(gatewayAppliesTransform(Array.from({ length: 10 }, (_, i) => `t${i}`), headers).status).toBe(400);
    expect(gatewayAppliesTransform([], { "ai-reporting-tags": "bad tag!" }).status).toBe(400);
  });
});
