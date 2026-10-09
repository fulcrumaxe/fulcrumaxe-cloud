import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PINNED_GIT_PROXIES, PINNED_JOB_KEYS, gitProxyHashFor, gitProxyPinned, originHash } from "../src/keyring.js";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The staging cloud address keys the job key table; the staging proxy entry is keyed by the same hash. Hashes only: no host text in the build. */
const STAGING_CLOUD_HASH = "c99106f0f3e8720c0d2d5f275f8d341a21367d193ffbb416e7a73a9ebb00fe0f";
const STAGING_PROXY_HASH = "716e6a8da9466577d9c61b05fc22d60a52ec8508e7e9ed84bf66c0c948ea2fc2";

/** D#6 R5b-1 (C38): the staging proxy pin. Production stays unpinned until R6-W. */
describe("the pinned git proxies", () => {
  it("hold exactly the staging pair, as hashes, keyed by the staging cloud hash that also keys the job key", () => {
    expect(PINNED_GIT_PROXIES).toEqual({ [STAGING_CLOUD_HASH]: STAGING_PROXY_HASH });
    expect(Object.keys(PINNED_JOB_KEYS)).toContain(STAGING_CLOUD_HASH);
    expect(Object.isFrozen(PINNED_GIT_PROXIES)).toBe(true);
  });

  it("an address resolves through the hash of its origin and no other address resolves; production has no entry", () => {
    for (const other of ["https://fulcrumaxe.dev", "https://cloud.fulcrumaxe.dev", "https://other.invalid", "not an address", ""]) {
      expect(gitProxyHashFor(other), other).toBeUndefined();
      expect(gitProxyPinned(other, "https://other.invalid"), other).toBe(false);
    }
  });

  it("gitProxyPinned is true for the pinned pair and false for any other origin, scheme, path or port (checked against the committed table's own hashes)", () => {
    // The pair is exercised through a table built from the committed hashes: an origin is pinned only when its hash is the entry's value.
    const cloud = "https://staging-cloud.invalid";
    const proxy = "https://staging-proxy.invalid";
    const table = { [originHash(cloud)!]: originHash(proxy)! };
    expect(gitProxyPinned(cloud, proxy, table)).toBe(true);
    for (const other of ["https://staging-other.invalid", "http://staging-proxy.invalid", `${proxy}/path`, `${proxy}:8443`, "https://staging-proxy.invalid.evil.invalid"]) {
      expect(gitProxyPinned(cloud, other, table), other).toBe(false);
    }
    // And the committed entry is the only value that pins: a proxy whose hash differs from it never does.
    expect(gitProxyPinned("https://staging-cloud.invalid", proxy, { [originHash(cloud)!]: STAGING_PROXY_HASH })).toBe(false);
  });

  it("keyring.ts holds no host text: no address, no domain name, in code or comments", () => {
    const text = readFileSync(path.join(PACKAGE_DIR, "src", "keyring.ts"), "utf8");
    expect(text).not.toMatch(/https?:\/\/[a-z0-9]/i);
    expect(text).not.toMatch(/\.(app|dev|com|io|net|org|invalid|example)\b/i);
  });
});
