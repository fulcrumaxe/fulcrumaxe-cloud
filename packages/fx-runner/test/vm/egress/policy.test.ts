import { describe, expect, it } from "vitest";
import { DEFAULT_TEMPLATE_POLICY, PolicyRefused, parseEgressPolicy } from "../../../src/vm/egress/policy.js";

const hosts = (value: unknown): Array<[string, string]> => [...parseEgressPolicy(value).hosts.entries()];

describe("parseEgressPolicy", () => {
  it("deny-all and an empty allow have no hosts", () => {
    expect(hosts("deny-all")).toEqual([]);
    expect(hosts({})).toEqual([]);
    expect(hosts({ allow: [] })).toEqual([]);
  });
  it("reads a host list and a rule table the way the cloud builds them", () => {
    expect(hosts({ allow: ["pkg.example.com"] })).toEqual([["pkg.example.com", "direct"]]);
    const table = {
      allow: {
        "api.example.com": [{ transform: [{ headers: { Authorization: "Bearer x" } }] }],
        "git.example.com": [{ forwardURL: "https://proxy.example.com/api/gh-proxy" }],
        "pkg.example.com": [],
      },
    };
    expect(hosts(table)).toEqual([["api.example.com", "rewritten"], ["git.example.com", "rewritten"], ["pkg.example.com", "direct"]]);
  });
  it("the default template policy allows the package registry and nothing else", () => {
    expect(hosts(DEFAULT_TEMPLATE_POLICY)).toEqual([["registry.npmjs.org", "direct"]]);
  });
  const REFUSED: Array<[string, unknown]> = [
    ["allow-all", "allow-all"],
    ["an unknown string", "deny"],
    ["null", null],
    ["a number", 7],
    ["a list", ["pkg.example.com"]],
    ["subnets", { allow: ["pkg.example.com"], subnets: { allow: ["10.0.0.0/8"] } }],
    ["an unknown key", { allow: [], extra: 1 }],
    ["allow is a string", { allow: "pkg.example.com" }],
    ["a wildcard host", { allow: ["*.example.com"] }],
    ["an address literal host", { allow: ["169.254.169.254"] }],
    ["an address literal key", { allow: { "127.0.0.1": [] } }],
    ["a bracketed literal", { allow: ["[::1]"] }],
    ["a host with a port", { allow: ["pkg.example.com:443"] }],
    ["an upper case host", { allow: ["PKG.example.com"] }],
    ["localhost", { allow: ["localhost"] }],
    ["a non-string host", { allow: [7] }],
    ["rules that are not a list", { allow: { "pkg.example.com": {} } }],
    ["a rule of unknown shape", { allow: { "pkg.example.com": [{ nope: 1 }] } }],
    ["a non-object rule", { allow: { "pkg.example.com": ["x"] } }],
    ["a forwardURL over http", { allow: { "git.example.com": [{ forwardURL: "http://proxy.example.com/x" }] } }],
    ["a forwardURL with a query", { allow: { "git.example.com": [{ forwardURL: "https://proxy.example.com/x?a=1" }] } }],
    ["a forwardURL with a fragment", { allow: { "git.example.com": [{ forwardURL: "https://proxy.example.com/x#a" }] } }],
    ["a forwardURL with credentials", { allow: { "git.example.com": [{ forwardURL: "https://u:p@proxy.example.com/x" }] } }],
    ["a forwardURL with a port", { allow: { "git.example.com": [{ forwardURL: "https://proxy.example.com:8443/x" }] } }],
    ["a forwardURL to an address literal", { allow: { "git.example.com": [{ forwardURL: "https://169.254.169.254/x" }] } }],
    ["a forwardURL that is not a URL", { allow: { "git.example.com": [{ forwardURL: "nope" }] } }],
    ["a forwardURL that is not a string", { allow: { "git.example.com": [{ forwardURL: 7 }] } }],
  ];
  it.each(REFUSED)("refuses %s", (_name, value) => {
    expect(() => parseEgressPolicy(value)).toThrow(PolicyRefused);
  });
  it("does not echo the offending value", () => {
    expect(() => parseEgressPolicy({ allow: ["169.254.169.254"] })).toThrow(/^egress policy refused: a host is not a plain DNS name$/);
  });
});
