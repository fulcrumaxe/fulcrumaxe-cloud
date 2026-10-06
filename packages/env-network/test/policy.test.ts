import { readFileSync } from "node:fs";
import type { EnvSpec } from "@fx/env-spec";
import { describe, expect, it } from "vitest";
import type { NetworkPolicyRule as RunnerRule } from "../../runner/src/networkPolicy.js";
import { EnvNetworkError, RESERVED_HOSTS, toPolicy, type NetworkContext, type NetworkPurpose, type NetworkRule } from "../src/index.js";

const spec = (domains: readonly string[]): EnvSpec =>
  ({ version: 1, setup: [], run: [], env: {}, secrets: [], services: [], network: { domains } }) as unknown as EnvSpec;
const CTX: NetworkContext = { githubForwardHost: "gh-proxy.fx.example", modelProvider: "ai_gateway", vcrHost: "vcr.fx.example" };
const code = (domains: readonly string[], ctx = CTX): string => {
  try { toPolicy(spec(domains), ctx); } catch (e) { if (e instanceof EnvNetworkError) return e.code; throw e; }
  return "none";
};
const hosts = (domains: readonly string[]) => toPolicy(spec(domains), CTX).rules.filter((r) => r.purpose === "customer_domain").map((r) => r.host);

describe("criterion 1: deny by default, applied at creation", () => {
  it("defaults to deny and says it is for creation time (the platform default is allow-all)", () => {
    const p = toPolicy(spec([]), CTX);
    expect(p.default).toBe("deny");
    expect(p.appliesAt).toBe("creation");
    expect(p.rules.map((r) => r.purpose)).toEqual(["model", "github_proxy"]);
    expect(readFileSync(new URL("../src/policy.ts", import.meta.url), "utf8")).toMatch(/platform default is\s+allow-all/);
  });
  it("adds one exact-host rule per customer domain, sorted and de-duplicated", () => {
    expect(hosts(["b.example.com", "A.example.com", "b.example.com."])).toEqual(["a.example.com", "b.example.com"]);
  });
});

describe("criterion 2: refusals name the entry and say a hostname is required", () => {
  const refused: [string, string][] = [
    ["*", "wildcard"], ["*.", "wildcard"], ["", "empty"], [".", "empty"],
    ["*.example.com", "wildcard"], ["example.*", "wildcard"], ["ex*ample.com", "wildcard"], ["a.*.com", "wildcard"], ["＊.example.com", "wildcard"],
    [".*", "wildcard"], ["^.*$", "wildcard"], ["**", "wildcard"],
    ["0.0.0.0", "ip_address"], ["10.0.0.1", "ip_address"], ["8.8.8.8.", "ip_address"], ["0x7f.1", "ip_address"], ["2130706433", "ip_address"], ["１２７.０.０.１", "ip_address"],
    ["::1", "ip_address"], ["2001:db8::1", "ip_address"], ["[::1]", "ip_address"], ["::ffff:10.0.0.1", "ip_address"], ["[::ffff:10.0.0.1]", "ip_address"], ["::ffff:a00:1", "ip_address"],
    ["10.0.0.0/8", "address_range"], ["0.0.0.0/0", "address_range"], ["::/0", "address_range"], ["[2001:db8::]/32", "address_range"],
    ["example.com:443", "not_a_hostname"], ["https://example.com", "not_a_hostname"], ["example.com/x", "not_a_hostname"], ["user@example.com", "not_a_hostname"],
    ["ex ample.com", "not_a_hostname"], ["a..b.com", "not_a_hostname"], ["-a.com", "not_a_hostname"], ["example.com..", "not_a_hostname"], ["a_b.com", "not_a_hostname"],
  ];
  it.each(refused)("refuses %j as %s", (entry, want) => {
    expect(code([entry])).toBe(want);
    try { toPolicy(spec([entry]), CTX); } catch (e) {
      const err = e as EnvNetworkError;
      expect(err.entry).toBe(entry);
      expect(err.message).toContain(JSON.stringify(entry));
      expect(err.message).toContain("a hostname is required");
    }
  });
  it.each(["example.com", "Example.COM.", "registry.npmjs.org", "localhost", "a-b.c1.example.co.uk", "bücher.de", "xn--bcher-kva.de"])("accepts the hostname %j", (entry) => {
    expect(code([entry])).toBe("none");
  });
  it("normalises before emitting: lower-case, no trailing dot, punycode", () => {
    expect(hosts(["Example.COM.", "bücher.de"])).toEqual(["example.com", "xn--bcher-kva.de"]);
  });
  it("one bad entry refuses the whole spec, and the message holds the entry and nothing of the policy", () => {
    const secret = { githubForwardHost: "internal-proxy.secret.example", modelProvider: "anthropic", vcrHost: "vcr.secret.example" } as const;
    let msg = "";
    try { toPolicy(spec(["ok.example.com", "10.0.0.0/8"]), secret); } catch (e) { msg = (e as Error).message; }
    expect(msg).toBe('address_range: "10.0.0.0/8" is not allowed: a hostname is required');
    expect(msg).not.toMatch(/secret|anthropic|ok\.example/);
  });
  it("cuts a very long entry in the message but keeps it whole on the error", () => {
    const long = `${"a".repeat(300)}.example.com/x`;
    try { toPolicy(spec([long]), CTX); expect.unreachable(); } catch (e) {
      expect((e as EnvNetworkError).entry).toBe(long);
      expect((e as Error).message.length).toBeLessThan(200);
    }
  });
});

describe("criterion 3: reserved hosts are refused by name, never merged", () => {
  const reserved = [
    "github.com", "api.github.com", "gist.githubusercontent.com", "githubusercontent.com", "npm.pkg.github.com",
    "ai-gateway.vercel.sh", "api.anthropic.com", CTX.githubForwardHost, CTX.vcrHost,
  ];
  it.each(reserved)("refuses %s", (h) => {
    expect(code([h])).toBe("reserved_host");
    expect(() => toPolicy(spec(["ok.example.com", h.toUpperCase() + "."]), CTX)).toThrow(new RegExp(`reserved host ${h.replaceAll(".", "\\.")}`));
  });
  it("exports one constant, and pins parity with the runner's reserved names without importing it", () => {
    const runner = readFileSync(new URL("../../runner/src/networkPolicy.ts", import.meta.url), "utf8");
    for (const h of RESERVED_HOSTS) expect(runner, h).toContain(`"${h}"`);
    // The runner also reserves its two install registries; this package leaves them to the customer on purpose.
    expect(RESERVED_HOSTS).toEqual(["github.com", "githubusercontent.com", "ai-gateway.vercel.sh", "api.anthropic.com"]);
    expect(code(["registry.npmjs.org", "crates.io", "evilgithub.com", "github.com.evil.example", "github.io"])).toBe("none");
  });
  it("matches the per-installation hosts exactly, not their subdomains", () => {
    expect(code([`x.${CTX.githubForwardHost}`, `x.${CTX.vcrHost}`])).toBe("none");
  });
  it("refuses a look-alike that normalises to a reserved host, as reserved (criterion 7)", () => {
    for (const h of ["ＧＩＴＨＵＢ.ＣＯＭ", "github。com", "GitHub.com.", "gith​ub.com", "API.GITHUB.COM"]) expect(code([h]), h).toBe("reserved_host");
    expect(code(["gıthub.com"])).toBe("none"); // a different punycode name, not GitHub
  });
  it("rejects a context whose hosts are not plain hostnames", () => {
    expect(code([], { ...CTX, githubForwardHost: "*" })).toBe("invalid_context");
    expect(code([], { ...CTX, vcrHost: "10.0.0.1" })).toBe("invalid_context");
    expect(code([], { ...CTX, modelProvider: "constructor" as never })).toBe("invalid_context");
  });
});

describe("criterion 4: our GitHub forwarding rule has no match key", () => {
  it("is exactly a host and a purpose", () => {
    const gh = toPolicy(spec(["a.example.com"]), CTX).rules.find((r) => r.purpose === "github_proxy")!;
    expect(gh).toEqual({ host: CTX.githubForwardHost, purpose: "github_proxy" });
    expect("match" in gh).toBe(false);
    expect(Object.keys(gh)).toEqual(["host", "purpose"]);
  });
});

describe("criterion 6: tenant isolation", () => {
  it("tenant A's fragment holds nothing from tenant B, and our rules are byte-identical whatever the customer lists", () => {
    const a = toPolicy(spec(["a-only.example.com"]), CTX);
    const b = toPolicy(spec(["b-only.example.com", "more.example.org"]), CTX);
    expect(JSON.stringify(a)).not.toMatch(/b-only|more\.example/);
    expect(JSON.stringify(b)).not.toMatch(/a-only/);
    const ours = (p: { rules: readonly NetworkRule[] }) => JSON.stringify(p.rules.filter((r) => r.purpose !== "customer_domain"));
    expect(ours(a)).toBe(ours(b));
    expect(ours(a)).toBe(ours(toPolicy(spec([]), CTX)));
  });
  it("does not mutate or retain anything between calls", () => {
    const s = spec(["x.example.com"]);
    const first = JSON.stringify(toPolicy(s, CTX));
    toPolicy(spec(["y.example.com"]), CTX);
    expect(JSON.stringify(toPolicy(s, CTX))).toBe(first);
    expect(Object.isFrozen(toPolicy(s, CTX).rules)).toBe(true);
  });
});

describe("emitted shape matches packages/runner's NetworkPolicyRule (type-level, no runtime import)", () => {
  type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
  const sameFields: Eq<Omit<NetworkRule, "purpose">, Omit<RunnerRule, "purpose" | "authValue">> = true;
  // The runner's purposes are ours plus package_registry (its install-phase registries).
  const samePurposes: Eq<NetworkPurpose, Exclude<RunnerRule["purpose"], "package_registry">> = true;
  it("has the same fields and the same platform purposes", () => {
    expect([sameFields, samePurposes]).toEqual([true, true]);
  });
  it("uses the runner's model host and auth header per provider", () => {
    const runner = readFileSync(new URL("../../runner/src/networkPolicy.ts", import.meta.url), "utf8");
    for (const [provider, host, header] of [["ai_gateway", "ai-gateway.vercel.sh", "Authorization"], ["anthropic", "api.anthropic.com", "x-api-key"]] as const) {
      expect(runner).toMatch(new RegExp(`${provider}: "${host}"`));
      expect(runner).toMatch(new RegExp(`${provider}: "${header}"`));
      expect(toPolicy(spec([]), { ...CTX, modelProvider: provider }).rules[0]).toEqual({ host, purpose: "model", authHeader: header });
    }
  });
});
