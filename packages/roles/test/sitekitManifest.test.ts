import { describe, expect, it } from "vitest";
import { ROLE_MANIFEST, ROLE_NAMES, SITEKIT_ROLE_MANIFEST, SITEKIT_ROLE_NAMES } from "../src/manifest";
import { loadPlatformCard, loadProductCard, loadRoleCard } from "../src/cards";

describe("the site-kit role manifest (D#3 K05, D#2 C12)", () => {
  it("holds exactly the two roles, kept out of the hosted team's 26", () => {
    expect([...SITEKIT_ROLE_NAMES]).toEqual(["site-extractor", "site-verifier"]);
    expect(ROLE_NAMES).toHaveLength(26);
    for (const name of SITEKIT_ROLE_NAMES) expect(ROLE_NAMES).not.toContain(name);
    expect(ROLE_MANIFEST.some((r) => SITEKIT_ROLE_NAMES.includes(r.name))).toBe(false);
  });

  it("each entry has the manifest's shape and a mode list that includes off", () => {
    for (const e of SITEKIT_ROLE_MANIFEST) {
      expect(e.allowedModes).toContain("off");
      expect(e.allowedModes).toContain(e.defaultMode);
      expect(e.perSpawnCapUsd).toBeGreaterThan(0);
      expect(e.writeAccess).toBe(false);
      expect(e.needsBrowser).toBe(false);
    }
  });

  it("the extractor's card is a platform card, and no dev-team or product-run card is handed out for it", () => {
    expect(loadPlatformCard("site-extractor")).toMatch(/^---\nname: site-extractor\nproduct: true\n---\n/);
    expect(loadRoleCard("site-extractor")).toBeUndefined();
    expect(loadProductCard("site-extractor")).toBeUndefined();
  });
});
