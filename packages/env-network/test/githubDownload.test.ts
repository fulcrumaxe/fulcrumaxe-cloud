import { readFileSync } from "node:fs";
import type { EnvSpec } from "@fx/env-spec";
import { describe, expect, it } from "vitest";
import { EnvNetworkError, GITHUB_DOWNLOAD_HOSTS, toPolicy, type NetworkContext, type NetworkRule } from "../src/index.js";

const spec = (domains: readonly string[]): EnvSpec =>
  ({ version: 1, setup: [], run: [], env: {}, secrets: [], services: [], network: { domains } }) as unknown as EnvSpec;
const CTX: NetworkContext = { githubForwardHost: "gh-proxy.fx.example", modelProvider: "ai_gateway", vcrHost: "vcr.fx.example" };
const HOSTS = ["codeload.github.com", "raw.githubusercontent.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com", "pkg-containers.githubusercontent.com"];
const refusal = (domains: readonly string[]): EnvNetworkError | undefined => {
  try { toPolicy(spec(domains), CTX); } catch (e) { if (e instanceof EnvNetworkError) return e; throw e; }
  return undefined;
};

describe("the switchable download hosts", () => {
  it("are exactly the five read-only download hosts, in a frozen list", () => {
    expect([...GITHUB_DOWNLOAD_HOSTS]).toEqual(HOSTS);
    expect(Object.isFrozen(GITHUB_DOWNLOAD_HOSTS)).toBe(true);
  });
  it("states the exact-match invariant for the future forwarding translation", () => {
    const src = readFileSync(new URL("../src/policy.ts", import.meta.url), "utf8");
    expect(src).toMatch(/github\.com and api\.github\.com EXACTLY, never as a\s+\*?\s*suffix/);
  });
  it.each(HOSTS)("%s is emitted as a github_download rule when listed, never as a customer_domain rule", (h) => {
    const rules = toPolicy(spec([h]), CTX).rules;
    expect(rules.filter((r) => r.host === h)).toEqual([{ host: h, purpose: "github_download" }]);
    expect(rules.some((r) => r.purpose === "customer_domain")).toBe(false);
  });
  it("normalises spellings, de-duplicates, and sorts after the platform rules and before the customer rules", () => {
    const rules = toPolicy(spec(["z.example.com", "RAW.githubusercontent.com.", "raw.githubusercontent.com", "codeload.github.com", "a.example.com"]), CTX).rules;
    expect(rules.map((r) => `${r.purpose}:${r.host}`)).toEqual([
      "model:ai-gateway.vercel.sh", "github_proxy:gh-proxy.fx.example",
      "github_download:codeload.github.com", "github_download:raw.githubusercontent.com",
      "customer_domain:a.example.com", "customer_domain:z.example.com",
    ]);
  });
  it("are off unless listed", () => {
    expect(toPolicy(spec(["example.com"]), CTX).rules.some((r) => r.purpose === "github_download")).toBe(false);
  });
  it("leave a spec that lists none of them byte-identical to the pre-change fragment (golden)", () => {
    expect(JSON.stringify(toPolicy(spec(["b.example.com", "A.example.org."]), CTX))).toBe(
      '{"default":"deny","appliesAt":"creation","rules":[{"host":"ai-gateway.vercel.sh","purpose":"model","authHeader":"Authorization"},'
      + '{"host":"gh-proxy.fx.example","purpose":"github_proxy"},{"host":"a.example.org","purpose":"customer_domain"},{"host":"b.example.com","purpose":"customer_domain"}]}',
    );
    expect(JSON.stringify(toPolicy(spec([]), CTX))).toBe(
      '{"default":"deny","appliesAt":"creation","rules":[{"host":"ai-gateway.vercel.sh","purpose":"model","authHeader":"Authorization"},{"host":"gh-proxy.fx.example","purpose":"github_proxy"}]}',
    );
  });
});

describe("everything else under the reserved GitHub apexes stays refused", () => {
  const stillRefused = [
    "github.com", "api.github.com", "gist.githubusercontent.com", "uploads.github.com", "githubusercontent.com",
    "x.raw.githubusercontent.com", "x.codeload.github.com", "a.b.objects.githubusercontent.com", "x.pkg-containers.githubusercontent.com",
    "RAW.GITHUB.COM", "api.github.com.", "API.GITHUB.COM", "ＧＩＴＨＵＢ.ＣＯＭ", "github。com", "X.RAW.GITHUBUSERCONTENT.COM.",
  ];
  it.each(stillRefused)("refuses %j as reserved_host and names the switchable hosts", (h) => {
    const err = refusal([h]);
    expect(err?.code).toBe("reserved_host");
    for (const d of HOSTS) expect(err?.message).toContain(d);
  });
  it("refuses a download host next to a reserved one, and does not leak other hosts", () => {
    const err = refusal(["raw.githubusercontent.com", "github.com"]);
    expect(err?.code).toBe("reserved_host");
    expect(err?.message).not.toMatch(/gist|uploads|api\.github/);
  });
  it("still refuses a download host that a platform context host names exactly", () => {
    const err = (() => {
      try { toPolicy(spec(["raw.githubusercontent.com"]), { ...CTX, githubForwardHost: "raw.githubusercontent.com" }); } catch (e) { return e as EnvNetworkError; }
      return undefined;
    })();
    expect(err?.code).toBe("reserved_host");
  });
});

describe("no credential rides a download host", () => {
  it("emits no authHeader or authValue property on a download rule, enumerable or not", () => {
    const rules = toPolicy(spec(HOSTS), CTX).rules.filter((r) => r.purpose === "github_download");
    expect(rules).toHaveLength(HOSTS.length);
    for (const r of rules) {
      const names = Object.getOwnPropertyNames(r);
      expect([...names].sort()).toEqual(["host", "purpose"]);
      expect(names).not.toContain("authHeader");
      expect(names).not.toContain("authValue");
      expect(Object.getOwnPropertySymbols(r)).toEqual([]);
    }
  });
  it("makes an authHeader on a download rule a type error", () => {
    // @ts-expect-error a github_download rule cannot have an authHeader
    const bad: NetworkRule = { host: "raw.githubusercontent.com", purpose: "github_download", authHeader: "Authorization" };
    expect(bad.purpose).toBe("github_download");
  });
});
