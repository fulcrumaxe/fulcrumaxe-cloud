import { describe, expect, it } from "vitest";
import { isMergeOrProtectionPath } from "../src/mergeProtection.js";

describe("isMergeOrProtectionPath", () => {
  it.each([
    ["PUT", "/pulls/5/merge"],
    ["POST", "/merges"],
    ["PATCH", "/branches/main/protection"],
    ["PUT", "/branches/main/protection"],
    ["POST", "/rulesets"],
    ["PATCH", "/rulesets/9"],
    ["PUT", "/collaborators/alice"],
    ["POST", "/collaborators"],
    ["PATCH", "/hooks/3"],
    ["POST", "/hooks"],
    ["PUT", "/keys/9"],
    ["POST", "/keys"],
    // [H03 fix round, suggestion] DELETE on these is a mutation too — removes
    // branch protection, a ruleset, a collaborator, a webhook, or a deploy key.
    ["DELETE", "/branches/main/protection"],
    ["DELETE", "/rulesets/9"],
    ["DELETE", "/collaborators/alice"],
    ["DELETE", "/hooks/3"],
    ["DELETE", "/keys/9"],
  ])("flags %s %s", (method, subpath) => {
    expect(isMergeOrProtectionPath(method, subpath)).toBe(true);
  });

  it.each([
    ["GET", "/pulls/5/merge"], // checking mergeability, not merging
    ["GET", "/branches/main/protection"], // reading protection settings
    ["GET", "/hooks"],
    ["POST", "/pulls/5/reviews"], // a review is not a merge
    ["DELETE", "/issues/5/labels/needs-fix"], // an ordinary label removal
  ])("does not flag %s %s", (method, subpath) => {
    expect(isMergeOrProtectionPath(method, subpath)).toBe(false);
  });
});
