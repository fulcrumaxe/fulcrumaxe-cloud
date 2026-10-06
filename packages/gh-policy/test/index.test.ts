import { describe, expect, it } from "vitest";
import {
  ALLOWLISTED_VERDICT_LABELS,
  decide,
  isCanonicalPath,
  isValidRefName,
  lookupReviewerVerdictLabels,
  lookupRolePermissions,
  parseReceivePackRefUpdates,
  REVIEWER_ROLES,
  ROLE_PERMISSIONS,
  SITEKIT_PERMISSIONS,
} from "../src/index.js";

describe("public API surface (src/index.ts)", () => {
  it("re-exports decide and it behaves the same as the direct import", () => {
    const decision = decide({
      method: "GET",
      host: "api.github.com",
      sniHost: "api.github.com",
      path: "/repos/acme/widgets",
      role: "executor",
      product: "team",
      installation: { owner: "acme", repo: "widgets" },
    });
    expect(decision.allow).toBe(true);
  });

  it("re-exports parseReceivePackRefUpdates with the {updates, complete} shape", () => {
    expect(parseReceivePackRefUpdates(new TextEncoder().encode("0000"))).toEqual({
      updates: [],
      complete: true,
    });
  });

  it("re-exports the permission tables and role sets", () => {
    expect(ROLE_PERMISSIONS.executor).toBeDefined();
    expect(SITEKIT_PERMISSIONS).toEqual({ metadata: "read", contents: "read" });
    expect(REVIEWER_ROLES.has("code-reviewer")).toBe(true);
    expect(ALLOWLISTED_VERDICT_LABELS.has("code-review-needs-fix")).toBe(true);
  });

  it("re-exports the fix-round additions: lookupRolePermissions, lookupReviewerVerdictLabels, isCanonicalPath, isValidRefName", () => {
    expect(lookupRolePermissions("executor")).toBeDefined();
    expect(lookupRolePermissions("__proto__")).toBeUndefined();
    expect(lookupReviewerVerdictLabels("code-reviewer").has("code-review-passed")).toBe(true);
    expect(isCanonicalPath("/repos/acme/widgets")).toBe(true);
    expect(isCanonicalPath("/repos/acme/widgets/../evil")).toBe(false);
    expect(isValidRefName("refs/heads/fx/H03")).toBe(true);
    expect(isValidRefName("refs/heads/fx/../main")).toBe(false);
  });
});
