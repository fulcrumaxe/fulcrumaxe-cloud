import { describe, expect, it } from "vitest";
import {
  GithubForwardConfigError,
  assertGithubForwardConfig,
  githubProxyForwardUrl,
  loadGithubForwardConfig,
  type GithubForwardConfig,
} from "../src/githubForwardConfig.js";

/**
 * D#66, Spec (Acceptance) criteria 3-5: the suffix allowlist,
 * suffix-shape validation, and "reads exactly these two env keys".
 *
 * D#2 Correction C28 §2: `githubProxyForwardUrl` pins the OIDC `aud` the
 * gh-proxy route expects, `packages/github/test/oidcVerify.test.ts`
 * failing-first against the real function.
 */

const REAL_SUFFIX = "gh-proxy.fulcrumaxe.app";

function envWith(overrides: Record<string, string | undefined>): Readonly<Record<string, string | undefined>> {
  return { FX_GH_FORWARD_SUFFIX: REAL_SUFFIX, FX_GH_FORWARD_HOST: REAL_SUFFIX, ...overrides };
}

/** D#66, Spec: "'Hostile set' means the existing HOSTILE_FORWARD_HOSTS in
 * networkPolicy.test.ts, plus [these nine]." `HOSTILE_FORWARD_HOSTS` here
 * is copied verbatim from `networkPolicy.test.ts:109` (not imported --
 * that file stays byte-identical per criterion 10 and doesn't export its
 * own list). Includes `"*"` and `""` (D#66 security review, must-fix 2):
 * the criterion only requires every member of the hostile set to throw
 * `GithubForwardConfigError`, not why it throws, and both do -- `""`
 * through the same "FX_GH_FORWARD_HOST is required" branch as a missing
 * value, and `"*"` through the hostname-shape check. (An earlier version
 * of this comment claimed the missing-host test below "already covers
 * `''`" -- it doesn't; that test passes `undefined`, never `""`.) */
const HOSTILE_FORWARD_HOSTS = [
  "api.anthropic.com",
  "github.com",
  "registry.npmjs.org",
  "127.0.0.1.nip.io",
  "169-254-169-254.sslip.io",
  "metadata.google.internal",
  "kubernetes.default.svc",
  "ghcr.io",
  "github.io",
  "githubassets.com",
  "github.dev",
  "githubcopilot.com",
  "*",
  "",
];

describe("loadGithubForwardConfig (D#66 criterion 3: suffix allowlist)", () => {
  it("accepts a host equal to the suffix", () => {
    const config = loadGithubForwardConfig(envWith({ FX_GH_FORWARD_HOST: REAL_SUFFIX }));
    expect(config.host).toBe(REAL_SUFFIX);
    expect(config.suffix).toBe(REAL_SUFFIX);
  });

  it("accepts a host that is a subdomain of the suffix", () => {
    const host = `i123.${REAL_SUFFIX}`;
    const config = loadGithubForwardConfig(envWith({ FX_GH_FORWARD_HOST: host }));
    expect(config.host).toBe(host);
  });

  it("D#66 security review, must-fix 1: the returned config is frozen", () => {
    const config = loadGithubForwardConfig(envWith({}));
    expect(Object.isFrozen(config)).toBe(true);
  });

  it.each([
    "evilgh-proxy.fulcrumaxe.app",
    "gh-proxy.fulcrumaxe.app.evil.com",
    "fulcrumaxe.app",
    ...HOSTILE_FORWARD_HOSTS,
  ])("throws GithubForwardConfigError for host = %j", (host) => {
    expect(() => loadGithubForwardConfig(envWith({ FX_GH_FORWARD_HOST: host }))).toThrow(GithubForwardConfigError);
  });

  it("throws GithubForwardConfigError for a missing host", () => {
    expect(() => loadGithubForwardConfig(envWith({ FX_GH_FORWARD_HOST: undefined }))).toThrow(
      GithubForwardConfigError,
    );
  });

  it("throws GithubForwardConfigError for a missing suffix", () => {
    expect(() => loadGithubForwardConfig(envWith({ FX_GH_FORWARD_SUFFIX: undefined }))).toThrow(
      GithubForwardConfigError,
    );
  });
});

describe("loadGithubForwardConfig (D#66 criterion 4: suffix validation)", () => {
  it.each([
    "app",
    "github.com",
    "api.github.com",
    "githubusercontent.com",
    "ai-gateway.vercel.sh",
    "registry.npmjs.org",
    "GH-PROXY.fulcrumaxe.app",
    "gh-proxy.fulcrumaxe.app.",
    "*.fulcrumaxe.app",
    "127.0.0.1",
  ])("throws GithubForwardConfigError for suffix = %j", (suffix) => {
    expect(() => loadGithubForwardConfig({ FX_GH_FORWARD_SUFFIX: suffix, FX_GH_FORWARD_HOST: suffix })).toThrow(
      GithubForwardConfigError,
    );
  });
});

describe("loadGithubForwardConfig (D#66 criterion 5: environment only)", () => {
  it("reads exactly FX_GH_FORWARD_SUFFIX and FX_GH_FORWARD_HOST, and no other key", () => {
    const readKeys: string[] = [];
    const real: Record<string, string | undefined> = envWith({});
    const proxyEnv = new Proxy(real, {
      get(target, prop, receiver) {
        if (typeof prop === "string") readKeys.push(prop);
        return Reflect.get(target, prop, receiver);
      },
    });
    loadGithubForwardConfig(proxyEnv);
    expect(readKeys).toEqual(["FX_GH_FORWARD_SUFFIX", "FX_GH_FORWARD_HOST"]);
  });
});

/**
 * D#66, Spec (Acceptance) criterion 7's third bullet: `assertGithubForwardConfig`
 * repeats every check on an object it did not itself produce.
 */
describe("assertGithubForwardConfig (D#66, defence in depth)", () => {
  it("accepts a value loadGithubForwardConfig produced", () => {
    const config = loadGithubForwardConfig(envWith({}));
    expect(() => assertGithubForwardConfig(config)).not.toThrow();
  });

  it("refuses a plain object literal (missing the brand) even when host/suffix look internally consistent", () => {
    const forged = { host: "127.0.0.1.nip.io", suffix: "nip.io" } as unknown as GithubForwardConfig;
    expect(() => assertGithubForwardConfig(forged)).toThrow(GithubForwardConfigError);
  });

  it("refuses null and non-objects", () => {
    expect(() => assertGithubForwardConfig(null)).toThrow(GithubForwardConfigError);
    expect(() => assertGithubForwardConfig("gh-proxy.fulcrumaxe.app")).toThrow(GithubForwardConfigError);
    expect(() => assertGithubForwardConfig(undefined)).toThrow(GithubForwardConfigError);
  });

  it("refuses a spread copy of a real config with a forged host outside the original suffix", () => {
    const real = loadGithubForwardConfig(envWith({}));
    const forged = { ...real, host: "evil.com" } as GithubForwardConfig;
    expect(() => assertGithubForwardConfig(forged)).toThrow(GithubForwardConfigError);
  });

  /**
   * D#66 security review, should-fix 5 (CWE-290/CWE-693): the module-
   * private `BRAND` symbol can be recovered off a real config with
   * `Object.getOwnPropertySymbols` and replayed onto a hand-built object
   * whose `host`/`suffix` are internally consistent with each other but
   * were never checked by `loadGithubForwardConfig`. At the un-fixed
   * head, that forged-but-branded object passes `assertGithubForwardConfig`
   * (the assert only checked `host` against the object's OWN `suffix`).
   * `ISSUED` membership closes this: a forged object was never added to
   * it, brand or no brand.
   */
  it("refuses a forged object built with the brand symbol recovered from a real config", () => {
    const real = loadGithubForwardConfig(envWith({}));
    const [brand] = Object.getOwnPropertySymbols(real);
    const forged = {
      host: "127.0.0.1.nip.io",
      suffix: "nip.io",
      [brand]: true,
    } as unknown as GithubForwardConfig;
    expect(() => assertGithubForwardConfig(forged)).toThrow(GithubForwardConfigError);
  });
});

/** D#2 Correction C28 §2: pins the one function that produces the gh-proxy OIDC audience. */
describe("githubProxyForwardUrl (D#2 C28 §2: the OIDC audience source)", () => {
  it("returns https://<host>/api/gh-proxy for the configured host, no trailing slash, query or fragment", () => {
    const config = loadGithubForwardConfig(envWith({ FX_GH_FORWARD_HOST: REAL_SUFFIX }));
    expect(githubProxyForwardUrl(config)).toBe("https://gh-proxy.fulcrumaxe.app/api/gh-proxy");
  });

  it("reflects a subdomain host exactly", () => {
    const host = `i123.${REAL_SUFFIX}`;
    const config = loadGithubForwardConfig(envWith({ FX_GH_FORWARD_HOST: host }));
    expect(githubProxyForwardUrl(config)).toBe(`https://i123.${REAL_SUFFIX}/api/gh-proxy`);
  });
});
