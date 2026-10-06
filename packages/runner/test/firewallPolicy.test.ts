import { describe, expect, it } from "vitest";
import type { HostLookup } from "@fx/net-guard";
import {
  DecryptTenantKeyError,
  GithubForwardHostRefusedError,
  buildFirewallPolicy,
  type DecryptTenantKey,
  type EncryptedTenantKey,
  type FirewallPolicyDeps,
  type FirewallPolicyInput,
} from "../src/firewallPolicy.js";
import { loadGithubForwardConfig, type GithubForwardConfig } from "../src/githubForwardConfig.js";
import { networkPolicy } from "../src/networkPolicy.js";

const FAKE_PLAINTEXT_KEY = "fake-plaintext-tenant-model-key-zzz999";

function fakeEncryptedKey(): EncryptedTenantKey {
  return {
    ciphertext: new TextEncoder().encode("not-the-real-key-ciphertext"),
    nonce: new Uint8Array(12),
    wrappedDek: new Uint8Array(32),
    kekVersion: 1,
  };
}

function baseInput(): FirewallPolicyInput {
  return {
    role: "executor",
    product: "team",
    provider: "ai_gateway",
    encryptedKey: fakeEncryptedKey(),
    keyContext: { accountId: "acct-1", connectionId: "conn-1" },
  };
}

/** D#66: a valid, fixture-only `GithubForwardConfig`, built through
 * `loadGithubForwardConfig` (the only function that produces one) --
 * never a hand-rolled object. */
const TEST_FORWARD_CONFIG: GithubForwardConfig = loadGithubForwardConfig({
  FX_GH_FORWARD_SUFFIX: "gh-proxy.fulcrumaxe.app",
  FX_GH_FORWARD_HOST: "gh-proxy.fulcrumaxe.app",
});

function lookupResolvingTo(...addresses: string[]): HostLookup {
  return async () => addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
}

/** D#66: the mechanical `deps` argument `buildFirewallPolicy` now takes.
 * Defaults to a fake lookup that resolves to a known-public address, so
 * none of the pre-existing tests below make a real DNS query. */
function testDeps(overrides: Partial<FirewallPolicyDeps> = {}): FirewallPolicyDeps {
  return {
    githubForward: TEST_FORWARD_CONFIG,
    lookup: lookupResolvingTo("140.82.112.3"),
    ...overrides,
  };
}

/**
 * D#2 H09 pass/fail 3: "The tenant key is decrypted only inside the step
 * that builds the firewall policy, and is not returned from that step. It
 * is not in the workflow step's serialized input or output (Workflow
 * persists those), and a test inspects the recorded step payloads."
 */
describe("buildFirewallPolicy (D#2 H09 pass/fail 3)", () => {
  it("hands the decryptor the ciphertext and the non-secret account/connection ids, so it can bind the AAD", async () => {
    const seen: unknown[][] = [];
    const decrypt: DecryptTenantKey = async (...args) => {
      seen.push(args);
      return FAKE_PLAINTEXT_KEY;
    };
    const input = baseInput();
    await buildFirewallPolicy(decrypt, input, testDeps());
    expect(seen).toEqual([[input.encryptedKey, { accountId: "acct-1", connectionId: "conn-1" }]]);
  });

  it("decrypts exactly once, inside this function", async () => {
    let calls = 0;
    const decrypt: DecryptTenantKey = async () => {
      calls++;
      return FAKE_PLAINTEXT_KEY;
    };
    await buildFirewallPolicy(decrypt, baseInput(), testDeps());
    expect(calls).toBe(1);
  });

  it("the decrypted plaintext never appears in the returned policy (the 'serialized output' the Spec means)", async () => {
    const decrypt: DecryptTenantKey = async () => FAKE_PLAINTEXT_KEY;
    const result = await buildFirewallPolicy(decrypt, baseInput(), testDeps());
    const serializedOutput = JSON.stringify(result);
    expect(serializedOutput).not.toContain(FAKE_PLAINTEXT_KEY);
  });

  it("the plaintext never appears in the step's own input either -- the input only ever carries ciphertext", () => {
    const input = baseInput();
    // Uint8Array serializes to an object of numeric indices under
    // JSON.stringify -- this assertion is really "the input type has no
    // plaintext field to begin with", proven structurally, not just by a
    // substring scan of ciphertext bytes.
    const serializedInput = JSON.stringify(input);
    expect(serializedInput).not.toContain(FAKE_PLAINTEXT_KEY);
    expect(Object.keys(input.encryptedKey)).toEqual(["ciphertext", "nonce", "wrappedDek", "kekVersion"]);
  });

  it("returns exactly what networkPolicy would return for the same role/product/connection", async () => {
    const decrypt: DecryptTenantKey = async () => FAKE_PLAINTEXT_KEY;
    const input = baseInput();
    const deps = testDeps();
    const result = await buildFirewallPolicy(decrypt, input, deps);
    const expected = networkPolicy(input.role, input.product, {
      provider: input.provider,
      githubForwardHost: deps.githubForward.host,
    });
    expect(result).toEqual(expected);
  });

  it("honors an explicit install phase", async () => {
    const decrypt: DecryptTenantKey = async () => FAKE_PLAINTEXT_KEY;
    const result = await buildFirewallPolicy(decrypt, { ...baseInput(), phase: "install" }, testDeps());
    expect(result.some((r) => r.purpose === "package_registry")).toBe(true);
  });

  it("refuses an empty decrypted key rather than silently building a policy for nothing", async () => {
    const decrypt: DecryptTenantKey = async () => "";
    await expect(buildFirewallPolicy(decrypt, baseInput(), testDeps())).rejects.toThrow();
  });

  /**
   * H09 security review, "should fix" 3: a decryptor's own thrown error
   * (message or `cause`) never reaches this function's caller -- it is
   * caller-injected and not known here, so this function must be the
   * boundary. Covers both a rejected decrypt and a non-string return.
   */
  describe("decrypt-error boundary (H09 security review, should-fix 3)", () => {
    it("wraps a rejected decrypt in a fixed-message typed error, never the original message", async () => {
      const decrypt: DecryptTenantKey = async () => {
        throw new Error(`leak-me: ${FAKE_PLAINTEXT_KEY}`);
      };
      const rejection = buildFirewallPolicy(decrypt, baseInput(), testDeps());
      await expect(rejection).rejects.toBeInstanceOf(DecryptTenantKeyError);
      await expect(rejection).rejects.toThrow(new DecryptTenantKeyError().message);
      // The key inside the original decrypt error must never appear in
      // what this function's caller sees.
      let thrown: unknown;
      try {
        await buildFirewallPolicy(decrypt, baseInput(), testDeps());
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Error);
      const typed = thrown as Error;
      expect(typed.message).not.toContain(FAKE_PLAINTEXT_KEY);
      expect(typed.cause).toBeUndefined();
      expect(JSON.stringify(typed)).not.toContain(FAKE_PLAINTEXT_KEY);
    });

    it("wraps a decrypt error whose cause carries the plaintext -- cause is never forwarded", async () => {
      const decrypt: DecryptTenantKey = async () => {
        throw new Error("decrypt failed", { cause: FAKE_PLAINTEXT_KEY });
      };
      let thrown: unknown;
      try {
        await buildFirewallPolicy(decrypt, baseInput(), testDeps());
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(DecryptTenantKeyError);
      const typed = thrown as Error;
      expect(typed.cause).toBeUndefined();
      expect(typed.message).not.toContain(FAKE_PLAINTEXT_KEY);
    });

    it("refuses a non-string return from decryptTenantKey rather than passing it through", async () => {
      const decrypt = (async () => ({ leaked: FAKE_PLAINTEXT_KEY })) as unknown as DecryptTenantKey;
      const rejection = buildFirewallPolicy(decrypt, baseInput(), testDeps());
      await expect(rejection).rejects.toBeInstanceOf(DecryptTenantKeyError);
      let thrown: unknown;
      try {
        await buildFirewallPolicy(decrypt, baseInput(), testDeps());
      } catch (err) {
        thrown = err;
      }
      expect(JSON.stringify(thrown as Error)).not.toContain(FAKE_PLAINTEXT_KEY);
    });
  });
});

/**
 * D#66, Spec (Acceptance) criterion 6: resolved-IP enforcement.
 * `buildFirewallPolicy` resolves `deps.githubForward.host` on EVERY call,
 * through the injected `HostLookup`, and refuses to build a policy at all
 * unless the lookup returns at least one address and none of them are
 * blocked.
 */
describe("buildFirewallPolicy: resolved-IP enforcement (D#66 criterion 6)", () => {
  it("(a) a lookup returning a public address resolves, and the github_proxy rule's host equals config.host", async () => {
    const decrypt: DecryptTenantKey = async () => FAKE_PLAINTEXT_KEY;
    const deps = testDeps({ lookup: lookupResolvingTo("140.82.112.3") });
    const result = await buildFirewallPolicy(decrypt, baseInput(), deps);
    const proxyRule = result.find((r) => r.purpose === "github_proxy");
    expect(proxyRule?.host).toBe(deps.githubForward.host);
  });

  it("(b) a lookup returning one public and one blocked address rejects with class blocked_address, decrypt never called", async () => {
    let decryptCalls = 0;
    const decrypt: DecryptTenantKey = async () => {
      decryptCalls++;
      return FAKE_PLAINTEXT_KEY;
    };
    const deps = testDeps({ lookup: lookupResolvingTo("140.82.112.3", "10.0.0.5") });
    const rejection = buildFirewallPolicy(decrypt, baseInput(), deps);
    await expect(rejection).rejects.toBeInstanceOf(GithubForwardHostRefusedError);
    await expect(rejection).rejects.toMatchObject({ class: "blocked_address" });
    expect(decryptCalls).toBe(0);
  });

  it("(c) a lookup returning zero addresses rejects with class dns_failed, decrypt never called", async () => {
    let decryptCalls = 0;
    const decrypt: DecryptTenantKey = async () => {
      decryptCalls++;
      return FAKE_PLAINTEXT_KEY;
    };
    const deps = testDeps({ lookup: lookupResolvingTo() });
    const rejection = buildFirewallPolicy(decrypt, baseInput(), deps);
    await expect(rejection).rejects.toBeInstanceOf(GithubForwardHostRefusedError);
    await expect(rejection).rejects.toMatchObject({ class: "dns_failed" });
    expect(decryptCalls).toBe(0);
  });

  it("(d) a lookup that throws rejects with class dns_failed, decrypt never called", async () => {
    let decryptCalls = 0;
    const decrypt: DecryptTenantKey = async () => {
      decryptCalls++;
      return FAKE_PLAINTEXT_KEY;
    };
    const deps = testDeps({
      lookup: async () => {
        throw new Error("dns lookup failed");
      },
    });
    const rejection = buildFirewallPolicy(decrypt, baseInput(), deps);
    await expect(rejection).rejects.toBeInstanceOf(GithubForwardHostRefusedError);
    await expect(rejection).rejects.toMatchObject({ class: "dns_failed" });
    expect(decryptCalls).toBe(0);
  });

  it("(e) a lookup returning an IPv4-mapped blocked address rejects with class blocked_address, decrypt never called", async () => {
    let decryptCalls = 0;
    const decrypt: DecryptTenantKey = async () => {
      decryptCalls++;
      return FAKE_PLAINTEXT_KEY;
    };
    const deps = testDeps({ lookup: lookupResolvingTo("::ffff:169.254.169.254") });
    const rejection = buildFirewallPolicy(decrypt, baseInput(), deps);
    await expect(rejection).rejects.toBeInstanceOf(GithubForwardHostRefusedError);
    await expect(rejection).rejects.toMatchObject({ class: "blocked_address" });
    expect(decryptCalls).toBe(0);
  });

  it("(b)-(e): no error message or property contains the blocked address", async () => {
    const decrypt: DecryptTenantKey = async () => FAKE_PLAINTEXT_KEY;
    const cases: FirewallPolicyDeps[] = [
      testDeps({ lookup: lookupResolvingTo("140.82.112.3", "10.0.0.5") }),
      testDeps({ lookup: lookupResolvingTo() }),
      testDeps({
        lookup: async () => {
          throw new Error("dns lookup failed");
        },
      }),
      testDeps({ lookup: lookupResolvingTo("::ffff:169.254.169.254") }),
    ];
    for (const deps of cases) {
      let thrown: unknown;
      try {
        await buildFirewallPolicy(decrypt, baseInput(), deps);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(GithubForwardHostRefusedError);
      const serialized = JSON.stringify(thrown as Error);
      expect((thrown as Error).message).not.toContain("10.0.0.5");
      expect((thrown as Error).message).not.toContain("169.254");
      expect(serialized).not.toContain("10.0.0.5");
      expect(serialized).not.toContain("169.254");
    }
  });

  it("calls the lookup once per buildFirewallPolicy call -- two calls mean two lookups, nothing cached", async () => {
    let lookupCalls = 0;
    const lookup: HostLookup = async () => {
      lookupCalls++;
      return [{ address: "140.82.112.3", family: 4 }];
    };
    const decrypt: DecryptTenantKey = async () => FAKE_PLAINTEXT_KEY;
    const deps = testDeps({ lookup });
    await buildFirewallPolicy(decrypt, baseInput(), deps);
    await buildFirewallPolicy(decrypt, baseInput(), deps);
    expect(lookupCalls).toBe(2);
  });
});

/**
 * D#66 security review, must-fix 1 (CWE-367 -> CWE-918): `buildFirewallPolicy`
 * used to read `deps.githubForward.host` three times across two `await`s
 * (the assert, the lookup, and the Connection builder). A `lookup` that
 * mutates the shared config object between the first read and the last
 * could put an unresolved, unchecked host into the `github_proxy` rule.
 * `loadGithubForwardConfig` now freezes what it returns, and
 * `buildFirewallPolicy` reads the host into a local exactly once, right
 * after the assert, and reuses that local everywhere else.
 */
describe("buildFirewallPolicy: TOCTOU-safe host read (D#66 security review, must-fix 1)", () => {
  it("a host mutated during the lookup cannot reach the github_proxy rule", async () => {
    const config = loadGithubForwardConfig({
      FX_GH_FORWARD_SUFFIX: "gh-proxy.fulcrumaxe.app",
      FX_GH_FORWARD_HOST: "gh-proxy.fulcrumaxe.app",
    });
    const decrypt: DecryptTenantKey = async () => FAKE_PLAINTEXT_KEY;
    const lookup: HostLookup = async () => {
      (config as { host: string }).host = "127.0.0.1.nip.io";
      return [{ address: "140.82.112.3", family: 4 }];
    };
    let rejected = false;
    let proxyHost: string | undefined;
    try {
      const result = await buildFirewallPolicy(decrypt, baseInput(), { githubForward: config, lookup });
      proxyHost = result.find((r) => r.purpose === "github_proxy")?.host;
    } catch {
      rejected = true;
    }
    // Either the call rejects (the frozen config refused the in-flight
    // mutation), or it succeeds with the ORIGINAL host -- never the
    // mutated one the lookup tried to slip in after the check.
    expect(rejected || proxyHost === "gh-proxy.fulcrumaxe.app").toBe(true);
    expect(proxyHost).not.toBe("127.0.0.1.nip.io");
  });
});

/**
 * D#66 security review round 2, must-fix 1 (CWE-367 -> CWE-918): the freeze
 * on the config object closes a mutation of an already-read config, but
 * `buildFirewallPolicy` also used to read the `deps.githubForward`
 * *container* itself twice -- once for `assertGithubForwardConfig`, once
 * for `.host`. A `deps` whose `githubForward` is a getter can hand back a
 * real, issued config on the first read and a forged object on the second,
 * and no freeze on the first object stops that: the second read never
 * touches the first object at all.
 */
describe("buildFirewallPolicy: TOCTOU-safe container read (D#66 security review round 2, must-fix 1)", () => {
  it("a deps.githubForward getter that swaps in a forged host after the assert never reaches the github_proxy rule", async () => {
    const real = loadGithubForwardConfig({
      FX_GH_FORWARD_SUFFIX: "gh-proxy.fulcrumaxe.app",
      FX_GH_FORWARD_HOST: "gh-proxy.fulcrumaxe.app",
    });
    const forged = { host: "evil.example.com", suffix: "example.com" } as unknown as GithubForwardConfig;
    let reads = 0;
    const deps: FirewallPolicyDeps = {
      // First read (the assert) sees the real, issued config. Every read
      // after that sees the forged object -- proving that ANY second read
      // of the container, wherever it happens, is what this closes.
      get githubForward() {
        reads++;
        return reads === 1 ? real : forged;
      },
      lookup: lookupResolvingTo("140.82.112.3"),
    };
    const decrypt: DecryptTenantKey = async () => FAKE_PLAINTEXT_KEY;
    let rejected = false;
    let proxyHost: string | undefined;
    try {
      const result = await buildFirewallPolicy(decrypt, baseInput(), deps);
      proxyHost = result.find((r) => r.purpose === "github_proxy")?.host;
    } catch {
      rejected = true;
    }
    // The forged host must never reach the rule -- rejecting outright is
    // also an acceptable outcome, but landing the real host is not proof
    // enough on its own: it must also be true that `deps.githubForward`
    // was read exactly once. An implementation that reads the container
    // twice but happens to keep the SECOND (forged) read's `.host` off the
    // rule by other means would still pass the host assertion alone; the
    // `reads` assertion below is what actually pins the read count, so a
    // second read of `deps.githubForward` anywhere in the function --
    // including one reintroduced after this fix -- turns this test red.
    expect(proxyHost).not.toBe("evil.example.com");
    expect(rejected || proxyHost === "gh-proxy.fulcrumaxe.app").toBe(true);
    expect(reads).toBe(1);
  });
});

/**
 * D#66, Spec (Acceptance) criterion 7: no string path. `FirewallPolicyInput`
 * no longer has a `githubForwardHost` field, and `buildFirewallPolicy`'s
 * `deps.githubForward` rejects both a bare string (a compile-time check)
 * and a forged object cast past the type system (a runtime check).
 */
describe("buildFirewallPolicy: no string path (D#66 criterion 7)", () => {
  it("type test: a bare string for deps.githubForward does not typecheck (see the @ts-expect-error below)", () => {
    // This function is never called -- it exists only so `pnpm typecheck`
    // compiles the line below. `@ts-expect-error` itself fails
    // compilation unless the marked line actually produces a type error,
    // which is what proves a string is rejected.
    function typeOnlyCheck(): void {
      const decrypt: DecryptTenantKey = async () => FAKE_PLAINTEXT_KEY;
      // @ts-expect-error -- deps.githubForward must be a GithubForwardConfig, not a bare string.
      void buildFirewallPolicy(decrypt, baseInput(), { githubForward: "gh-proxy.fulcrumaxe.app" });
    }
    void typeOnlyCheck;
    expect(true).toBe(true);
  });

  it("runtime test: a cast object forged past the type system is refused with class config, before the lookup is called", async () => {
    let lookupCalls = 0;
    const lookup: HostLookup = async () => {
      lookupCalls++;
      return [{ address: "140.82.112.3", family: 4 }];
    };
    const decrypt: DecryptTenantKey = async () => FAKE_PLAINTEXT_KEY;
    const forged = { host: "127.0.0.1.nip.io", suffix: "nip.io" } as unknown as GithubForwardConfig;
    const rejection = buildFirewallPolicy(decrypt, baseInput(), { githubForward: forged, lookup });
    await expect(rejection).rejects.toBeInstanceOf(GithubForwardHostRefusedError);
    await expect(rejection).rejects.toMatchObject({ class: "config" });
    expect(lookupCalls).toBe(0);
  });
});

/** D#68 OPS-T1 security criterion 15: no log/telemetry vendor is ever reachable from a sandbox. */
describe("network policy reaches no telemetry vendor host (D#68 criterion 15)", () => {
  const VENDOR_HOST = /sentry|datadog|betterstack|logtail|axiom|honeycomb|newrelic|posthog|segment|mixpanel/i;

  it("no rule host, in either phase or for either provider, matches a vendor name", () => {
    const hosts: string[] = [];
    for (const provider of ["ai_gateway", "anthropic"] as const) {
      for (const phase of ["run", "install"] as const) {
        const connection = { provider, githubForwardHost: TEST_FORWARD_CONFIG.host };
        for (const rule of networkPolicy("executor", "team", connection, phase)) hosts.push(rule.host);
      }
    }
    expect(hosts.length).toBeGreaterThan(0);
    for (const host of hosts) expect(host).not.toMatch(VENDOR_HOST);
  });

  it("the matcher does flag a vendor host (so the assertion above can fail)", () => {
    for (const host of ["o1.ingest.sentry.io", "http-intake.logs.datadoghq.com", "in.logtail.com", "api.segment.io"]) {
      expect(host).toMatch(VENDOR_HOST);
    }
  });
});

/** D#2 H14c-3-1 (CARRY-12): the key's one exit is the model rule's non-enumerable header value. */
describe("buildFirewallPolicy carries the key on the model rule only (H14c-3-1)", () => {
  it("gateway: a bearer value on the model rule, invisible to serialisation and spreads", async () => {
    const result = await buildFirewallPolicy(async () => FAKE_PLAINTEXT_KEY, baseInput(), testDeps());
    const model = result.find((r) => r.purpose === "model")!;
    expect(model.authHeader).toBe("Authorization");
    expect(model.authValue).toBe(`Bearer ${FAKE_PLAINTEXT_KEY}`);
    expect(JSON.stringify(result)).not.toContain(FAKE_PLAINTEXT_KEY);
    expect(JSON.stringify({ ...model })).not.toContain(FAKE_PLAINTEXT_KEY);
    for (const rule of result.filter((r) => r.purpose !== "model")) expect(rule.authValue).toBeUndefined();
  });

  it("anthropic: the raw key under x-api-key", async () => {
    const result = await buildFirewallPolicy(async () => FAKE_PLAINTEXT_KEY, { ...baseInput(), provider: "anthropic" }, testDeps());
    const model = result.find((r) => r.purpose === "model")!;
    expect([model.authHeader, model.authValue]).toEqual(["x-api-key", FAKE_PLAINTEXT_KEY]);
  });

  it("a key that could split or forge a header is unusable", async () => {
    for (const bad of ["k\r\nX-Evil: 1", "has space", "\u00e9key"]) {
      await expect(buildFirewallPolicy(async () => bad, baseInput(), testDeps())).rejects.toBeInstanceOf(DecryptTenantKeyError);
    }
  });
});
