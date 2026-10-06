import { describe, expect, it } from "vitest";
import {
  ALLOWLISTED_VERDICT_LABELS,
  lookupReviewerVerdictLabels,
  lookupRolePermissions,
  REVIEWER_ROLES,
  ROLE_PERMISSIONS,
  ROLE_PUSH_PREFIX,
  SITEKIT_PERMISSIONS,
} from "../src/rolePermissions.js";

/**
 * Pins the per-role minimum permission table (H03 criterion 8): any
 * widening or narrowing of a role's permissions has to show up as a diff
 * here, so it can't slip through review unnoticed.
 *
 * [H03 fix round 1, item 3] `docs-writer`, `release-manager` and
 * `runbook-writer` lost `contents: "write"` because it let them PUT/DELETE
 * the REST contents API directly, bypassing the fx/* restriction entirely.
 *
 * [H03 fix round 2, Team Lead decision a] `contents: "write"` is back for
 * those three — they now push via git-receive-pack too, each confined to
 * its own `refs/heads/fx/<name>/*` sub-prefix (`ROLE_PUSH_PREFIX`,
 * enforced in `decide.ts`'s `canRolePush`). `decide.ts` still denies REST
 * contents writes universally regardless of this table, so restoring the
 * token ceiling here does not reopen the REST bypass.
 */
describe("criterion 8: ROLE_PERMISSIONS is pinned", () => {
  it("matches the frozen expected table exactly", () => {
    expect(ROLE_PERMISSIONS).toEqual({
      executor: { metadata: "read", contents: "write", pull_requests: "write", issues: "read" },
      "code-reviewer": { metadata: "read", contents: "read", pull_requests: "write", issues: "read" },
      "security-reviewer": { metadata: "read", contents: "read", pull_requests: "write", issues: "read" },
      "acceptance-tester": { metadata: "read", contents: "read", pull_requests: "write", issues: "read" },
      debater: { metadata: "read", contents: "read", pull_requests: "write", issues: "read" },
      "accessibility-reviewer": {
        metadata: "read",
        contents: "read",
        pull_requests: "write",
        issues: "read",
      },
      "project-manager": {
        metadata: "read",
        contents: "read",
        issues: "write",
        pull_requests: "read",
      },
      "technical-architect": { metadata: "read", contents: "read" },
      "product-owner": { metadata: "read", contents: "read" },
      "cost-analyst": { metadata: "read", contents: "read" },
      "performance-expert": { metadata: "read", contents: "read" },
      "security-expert": { metadata: "read", contents: "read" },
      researcher: { metadata: "read", contents: "read" },
      "mission-analyst": { metadata: "read", contents: "read" },
      "run-analyst": { metadata: "read", contents: "read" },
      "feedback-scanner": { metadata: "read", issues: "read", discussions: "read" },
      "quality-sweep": { metadata: "read", contents: "read" },
      "visual-verifier": { metadata: "read", contents: "read" },
      "docs-writer": { metadata: "read", contents: "write" },
      "incident-commander": { metadata: "read", contents: "read", issues: "write" },
      "release-manager": { metadata: "read", contents: "write" },
      "runbook-writer": { metadata: "read", contents: "write" },
      "ux-designer": { metadata: "read", contents: "read" },
      "analytics-engineer": { metadata: "read", contents: "read" },
      "browser-tester": { metadata: "read", contents: "read", pull_requests: "write" },
      "tui-tester": { metadata: "read", contents: "read" },
    });
  });

  it("lists exactly the 26 roles", () => {
    expect(Object.keys(ROLE_PERMISSIONS)).toHaveLength(26);
  });

  it("every reviewer role has an entry, and none of them grants contents:write", () => {
    for (const role of REVIEWER_ROLES) {
      const perms = ROLE_PERMISSIONS[role];
      expect(perms).toBeDefined();
      expect(perms?.contents).not.toBe("write");
    }
  });

  it("[H03 fix round 2] contents:write is exactly the four push-capable roles", () => {
    const pushCapable = new Set(["executor", ...ROLE_PUSH_PREFIX.keys()]);
    for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) {
      if (pushCapable.has(role)) {
        expect(perms.contents).toBe("write");
      } else {
        expect(perms.contents).not.toBe("write");
      }
    }
  });

  it("sitekit permissions are read-only", () => {
    expect(SITEKIT_PERMISSIONS).toEqual({ metadata: "read", contents: "read" });
  });

  it("the allowlisted verdict labels are exactly the merge-gate labels", () => {
    expect(new Set(ALLOWLISTED_VERDICT_LABELS)).toEqual(
      new Set([
        "code-review-passed",
        "code-review-needs-fix",
        "security-review-passed",
        "security-needs-fix",
        "acceptance-passed",
        "acceptance-failed",
      ]),
    );
  });
});

/** [H03 fix round 1, item a] Push prefixes for the three content-writing roles. */
describe("ROLE_PUSH_PREFIX", () => {
  it("maps exactly docs-writer, release-manager and runbook-writer to their own prefix", () => {
    expect(new Map(ROLE_PUSH_PREFIX)).toEqual(
      new Map([
        ["docs-writer", "refs/heads/fx/docs/"],
        ["release-manager", "refs/heads/fx/release/"],
        ["runbook-writer", "refs/heads/fx/runbook/"],
      ]),
    );
  });

  it("does not list executor (executor's rule is 'everything else', not a fixed prefix)", () => {
    expect(ROLE_PUSH_PREFIX.has("executor")).toBe(false);
  });
});

/** [H03 fix round 1, item 5] Object.hasOwn-backed lookup: prototype keys must never resolve. */
describe("lookupRolePermissions", () => {
  it("returns undefined for 'toString' rather than Object.prototype.toString", () => {
    expect(lookupRolePermissions("toString")).toBeUndefined();
  });

  it("returns undefined for '__proto__' rather than Object.prototype itself", () => {
    expect(lookupRolePermissions("__proto__")).toBeUndefined();
  });

  it("returns undefined for 'constructor'", () => {
    expect(lookupRolePermissions("constructor")).toBeUndefined();
  });

  it("returns undefined for 'hasOwnProperty'", () => {
    expect(lookupRolePermissions("hasOwnProperty")).toBeUndefined();
  });

  it("still resolves a real role", () => {
    expect(lookupRolePermissions("executor")).toEqual(ROLE_PERMISSIONS.executor);
  });
});

/**
 * [H03 fix round 1, item 7 + fix round 2, item W1] Each reviewer role owns
 * only its own verdict labels — no label is shared between two roles
 * anymore, since a shared label let one reviewer clear another's NACK by
 * deleting it.
 */
describe("lookupReviewerVerdictLabels", () => {
  it("code-reviewer owns code-review-passed and code-review-needs-fix only", () => {
    expect(lookupReviewerVerdictLabels("code-reviewer")).toEqual(
      new Set(["code-review-passed", "code-review-needs-fix"]),
    );
  });

  it("security-reviewer owns security-review-passed and security-needs-fix only", () => {
    expect(lookupReviewerVerdictLabels("security-reviewer")).toEqual(
      new Set(["security-review-passed", "security-needs-fix"]),
    );
  });

  it("acceptance-tester owns acceptance-passed and acceptance-failed only", () => {
    expect(lookupReviewerVerdictLabels("acceptance-tester")).toEqual(
      new Set(["acceptance-passed", "acceptance-failed"]),
    );
  });

  it("no two roles share a label", () => {
    const seen = new Map<string, string>();
    for (const role of ["code-reviewer", "security-reviewer", "acceptance-tester"]) {
      for (const label of lookupReviewerVerdictLabels(role)) {
        const owner = seen.get(label);
        expect(owner, `label "${label}" claimed by both ${owner} and ${role}`).toBeUndefined();
        seen.set(label, role);
      }
    }
  });

  it("debater owns no verdict labels", () => {
    expect(lookupReviewerVerdictLabels("debater")).toEqual(new Set());
  });

  it("accessibility-reviewer owns no verdict labels", () => {
    expect(lookupReviewerVerdictLabels("accessibility-reviewer")).toEqual(new Set());
  });

  it("an unknown role owns no verdict labels (not a thrown error, not Object.prototype)", () => {
    expect(lookupReviewerVerdictLabels("toString")).toEqual(new Set());
    expect(lookupReviewerVerdictLabels("__proto__")).toEqual(new Set());
  });
});

/** The ten roles that held `discussions: "write"` before D#2 C20 item 3 removed it. */
const FORMER_DISCUSSION_WRITERS = [
  "project-manager",
  "technical-architect",
  "product-owner",
  "cost-analyst",
  "performance-expert",
  "security-expert",
  "mission-analyst",
  "quality-sweep",
  "ux-designer",
  "tui-tester",
] as const;

describe("D#2 C20 criterion 9: no role gets discussions: write", () => {
  it("no role in ROLE_PERMISSIONS maps discussions to write", () => {
    for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) {
      expect(perms.discussions, role).not.toBe("write");
    }
  });

  it("the ten former writers have no discussions key at all, and feedback-scanner keeps read", () => {
    for (const role of FORMER_DISCUSSION_WRITERS) {
      expect(Object.hasOwn(ROLE_PERMISSIONS[role]!, "discussions"), role).toBe(false);
    }
    expect(ROLE_PERMISSIONS["feedback-scanner"]!.discussions).toBe("read");
  });
});
