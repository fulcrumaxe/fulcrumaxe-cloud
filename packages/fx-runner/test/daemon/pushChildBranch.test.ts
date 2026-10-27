import { describe, expect, it } from "vitest";
import { CONTINUES_BRANCH, continuesBranch, isContinuesBranch } from "../../src/daemon/push.js";

/**
 * D#483 S5-b2c-3, acceptance 12 and 13 (the daemon's half): the push step accepts the item's own branch in the child shape `fx/<parent#>-<key>` and nothing near it. Whose branch it is is
 * decided by the cloud, which signs it (the runner never picks its own, and the signature is checked before the shape here); the daemon only ever pushes the branch the signed job names.
 */
describe("the daemon's push step and a planned PR child's branch", () => {
  it("takes fx/issue-<n>, fx/<parent#>-<key> and a run branch", () => {
    for (const ok of ["fx/issue-12", "fx/41-api", "fx/41-a-b-c", "fx/2a2a2a2a-2b2b-4c2c-8d2d-2e2e2e2e2e2e-g1"]) expect(isContinuesBranch(ok), ok).toBe(true);
    expect(continuesBranch({ branch: "fx/41-api" })).toBe("fx/41-api");
  });

  it("refuses the near-misses with push_ref_refused", () => {
    for (const bad of ["fx/12-", "fx/12-a/b", "fx/12-..", "fx/12-ABC", `fx/12-${"a".repeat(33)}`, "fx/012-a", "main", "refs/heads/fx/41-api", "fx/41-api\n", "", undefined, null, 41]) {
      expect(isContinuesBranch(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(() => continuesBranch({ branch: "fx/012-a" })).toThrow(/push_ref_refused/);
  });

  it("a run branch is still the run-branch pattern, even when the first group of its uuid is all digits", () => {
    const numeric = "fx/12345678-1234-4234-8234-123456789012-g1";
    expect(CONTINUES_BRANCH.test(numeric)).toBe(true);
    expect(isContinuesBranch(numeric)).toBe(true);
  });
});
