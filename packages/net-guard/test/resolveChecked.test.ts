import { describe, expect, it } from "vitest";
import { NetGuardError, resolveChecked, type HostLookup, type LookupAddress } from "../src/resolveChecked.js";

function lookupReturning(addresses: readonly LookupAddress[]): HostLookup {
  return async () => [...addresses];
}

function lookupThrowing(message = "boom"): HostLookup {
  return async () => {
    throw new Error(message);
  };
}

/**
 * D#66: `resolveChecked` never makes a real DNS query in these tests --
 * every `HostLookup` here is a fake -- and it never caches, so a repeat
 * call re-resolves.
 */
describe("resolveChecked", () => {
  it("returns the addresses the lookup returns, all public", async () => {
    const addresses = await resolveChecked(
      "gh-proxy.fulcrumaxe.app",
      lookupReturning([{ address: "140.82.112.3", family: 4 }]),
    );
    expect(addresses).toEqual(["140.82.112.3"]);
  });

  it("throws NetGuardError code dns_failed when the lookup returns zero addresses", async () => {
    const rejection = resolveChecked("gh-proxy.fulcrumaxe.app", lookupReturning([]));
    await expect(rejection).rejects.toBeInstanceOf(NetGuardError);
    await expect(rejection).rejects.toMatchObject({ code: "dns_failed" });
  });

  it("throws NetGuardError code dns_failed when the lookup throws", async () => {
    const rejection = resolveChecked("gh-proxy.fulcrumaxe.app", lookupThrowing());
    await expect(rejection).rejects.toBeInstanceOf(NetGuardError);
    await expect(rejection).rejects.toMatchObject({ code: "dns_failed" });
  });

  it("throws NetGuardError code blocked_address when any returned address is blocked", async () => {
    const rejection = resolveChecked(
      "gh-proxy.fulcrumaxe.app",
      lookupReturning([
        { address: "140.82.112.3", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ]),
    );
    await expect(rejection).rejects.toBeInstanceOf(NetGuardError);
    await expect(rejection).rejects.toMatchObject({ code: "blocked_address" });
  });

  it("the error message names the host and the class, never a resolved address", async () => {
    let thrown: unknown;
    try {
      await resolveChecked(
        "gh-proxy.fulcrumaxe.app",
        lookupReturning([{ address: "169.254.169.254", family: 4 }]),
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(NetGuardError);
    const typed = thrown as NetGuardError;
    expect(typed.message).toContain("gh-proxy.fulcrumaxe.app");
    expect(typed.message).toContain("blocked_address");
    expect(typed.message).not.toContain("169.254.169.254");
  });

  it("calls the lookup once per call -- two calls mean two lookups, nothing cached", async () => {
    let calls = 0;
    const lookup: HostLookup = async () => {
      calls++;
      return [{ address: "140.82.112.3", family: 4 }];
    };
    await resolveChecked("gh-proxy.fulcrumaxe.app", lookup);
    await resolveChecked("gh-proxy.fulcrumaxe.app", lookup);
    expect(calls).toBe(2);
  });

  it("passes { all: true, verbatim: true } to the lookup", async () => {
    let receivedOptions: unknown;
    const lookup: HostLookup = async (_host, options) => {
      receivedOptions = options;
      return [{ address: "140.82.112.3", family: 4 }];
    };
    await resolveChecked("gh-proxy.fulcrumaxe.app", lookup);
    expect(receivedOptions).toEqual({ all: true, verbatim: true });
  });
});
