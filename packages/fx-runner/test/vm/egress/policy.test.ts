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
    ["a forwardURL that is a URL object", { allow: { "git.example.com": [{ forwardURL: new URL("https://proxy.example.com/x") }] } }],
  ];
  it.each(REFUSED)("refuses %s", (_name, value) => {
    expect(() => parseEgressPolicy(value)).toThrow(PolicyRefused);
  });
  it("does not echo the offending value", () => {
    expect(() => parseEgressPolicy({ allow: ["169.254.169.254"] })).toThrow(/^egress policy refused: a host is not a plain DNS name$/);
  });
});

describe("parseEgressPolicy: the reverse endpoint's routes", () => {
  const routeOf = (rules: unknown) => parseEgressPolicy({ allow: { "api.example.com": rules } }).routes.get("api.example.com");
  it("reads a forwardURL rule and a transform rule, lower-casing header names", () => {
    expect(routeOf([{ forwardURL: "https://proxy.example.com/api/fwd" }])?.forwardURL?.href).toBe("https://proxy.example.com/api/fwd");
    expect(routeOf([{ transform: [{ headers: { "X-Api-Key": "k", Authorization: "Bearer x" } }, { headers: { "ai-reporting-tags": "t" } }] }])?.headers).toEqual({ "x-api-key": "k", authorization: "Bearer x", "ai-reporting-tags": "t" });
  });
  it("a direct host and a deny-all policy have no route", () => {
    expect(routeOf([])).toBeUndefined();
    expect(parseEgressPolicy("deny-all").routes.size).toBe(0);
  });
  const UNSERVED: Array<[string, unknown]> = [
    ["two rules", [{ transform: [{ headers: { a: "1" } }] }, { transform: [{ headers: { b: "2" } }] }]],
    ["a match", [{ match: "x", transform: [{ headers: { a: "1" } }] }]],
    ["a response rule", [{ response: [] }]],
    ["a forward and a transform in one rule", [{ forwardURL: "https://proxy.example.com/x", transform: [{ headers: { a: "1" } }] }]],
    ["an empty transform", [{ transform: [] }]],
    ["a transform that sets no header", [{ transform: [{ headers: {} }] }]],
    ["a transform entry with no headers", [{ transform: [{}] }]],
    ["a transform entry with another key", [{ transform: [{ headers: { a: "1" }, body: "x" }] }]],
    ["a header named host", [{ transform: [{ headers: { Host: "evil.example.com" } }] }]],
    ["a header named content-length", [{ transform: [{ headers: { "Content-Length": "1" } }] }]],
    ["a header value with a line break", [{ transform: [{ headers: { a: "x\r\nb: y" } }] }]],
    ["a header value with a leading space", [{ transform: [{ headers: { a: " x" } }] }]],
    ["a header value with a trailing space", [{ transform: [{ headers: { a: "x " } }] }]],
    ["a header value with a tab", [{ transform: [{ headers: { a: "x\ty" } }] }]],
    ["an empty header value", [{ transform: [{ headers: { a: "" } }] }]],
    ["a header name with a space", [{ transform: [{ headers: { "a b": "1" } }] }]],
    ["a non-string header value", [{ transform: [{ headers: { a: 1 } }] }]],
  ];
  it.each(UNSERVED)("serves no route for %s, but the host stays in the policy as rewritten", (_name, rules) => {
    const parsed = parseEgressPolicy({ allow: { "api.example.com": rules } });
    expect(parsed.routes.size).toBe(0);
    expect(parsed.hosts.get("api.example.com")).toBe("rewritten");
  });
});
