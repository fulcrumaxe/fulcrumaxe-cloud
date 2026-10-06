import type { EnvSpec } from "@fx/env-spec";
import { describe, expect, it } from "vitest";
import { EnvNetworkError, normalizeHostname, toPolicy, type NetworkContext } from "../src/index.js";

const CTX: NetworkContext = { githubForwardHost: "gh-proxy.fx.example", modelProvider: "ai_gateway", vcrHost: "vcr.fx.example" };
const spec = (domains: readonly string[]): EnvSpec =>
  ({ version: 1, setup: [], run: [], env: {}, secrets: [], services: [], network: { domains } }) as unknown as EnvSpec;

/**
 * Names that resolve inside the platform or the VM are refused at spec time, whatever the firewall does with the
 * address they resolve to: a single label goes through the resolver's search path, and the special-use suffixes
 * and the cloud metadata zone are never a customer's service.
 */
describe("special-use hostnames are refused by name", () => {
  const refused = [
    "localhost", "LOCALHOST", "localhost.", "metadata", "db", "intranet",
    "metadata.google.internal", "Metadata.Google.Internal.", "foo.internal", "internal",
    "printer.local", "local", "x.localhost", "router.home.arpa", "home.arpa",
  ];
  it.each(refused)("refuses %j as special_use_host", (entry) => {
    expect(normalizeHostname(entry)).toEqual({ code: "special_use_host" });
    try {
      toPolicy(spec([entry]), CTX);
      throw new Error("not refused");
    } catch (e) {
      expect(e).toBeInstanceOf(EnvNetworkError);
      expect((e as EnvNetworkError).code).toBe("special_use_host");
      expect((e as EnvNetworkError).message).toContain(JSON.stringify(entry));
    }
  });

  it.each(["internal.example.com", "local.example.com", "notinternal.com", "mylocalhost.com", "home.arpa.example.com", "example.co"])(
    "still accepts %j: only a whole label or suffix counts",
    (entry) => {
      expect(normalizeHostname(entry)).toEqual({ host: entry });
    },
  );

  it("one such entry refuses the whole spec", () => {
    expect(() => toPolicy(spec(["registry.npmjs.org", "metadata.google.internal"]), CTX)).toThrow(/special_use_host/);
  });

  it("a platform context host is held to the same rule", () => {
    expect(() => toPolicy(spec([]), { ...CTX, vcrHost: "registry" })).toThrow(/invalid_context/);
  });
});
