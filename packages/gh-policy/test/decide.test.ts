import { describe, expect, it } from "vitest";
import { decide } from "../src/decide.js";
import { parseReceivePackRefUpdates } from "../src/parseReceivePack.js";
import { REVIEWER_ROLES } from "../src/rolePermissions.js";
import type { ProxyRequest } from "../src/types.js";
import { buildReceivePackBody, SHA_A, SHA_B, ZERO_SHA } from "./fixtures.js";

const INSTALLATION = { owner: "acme", repo: "widgets" };

function baseReq(overrides: Partial<ProxyRequest>): ProxyRequest {
  return {
    method: "GET",
    host: "api.github.com",
    sniHost: "api.github.com",
    path: "/repos/acme/widgets",
    role: "executor",
    product: "team",
    installation: INSTALLATION,
    ...overrides,
  };
}

describe("criterion 1: default deny", () => {
  it.each([
    ["/zen", "GET"],
    ["/rate_limit", "GET"],
    ["/", "GET"],
    ["/acme/widgets.git/info/refs", "GET"], // git smart-HTTP path with no ?service= to disambiguate
  ])("denies unrecognized path %s %s", (path, method) => {
    const decision = decide(baseReq({ path, method }));
    expect(decision.allow).toBe(false);
  });
});

describe("criterion 2: domain fronting", () => {
  it("denies when Host header does not match the TLS SNI host, even when both are individually allowlisted hosts", () => {
    const decision = decide(
      baseReq({ host: "api.github.com", sniHost: "github.com", path: "/repos/acme/widgets" }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("host_sni_mismatch");
  });
});

describe("criterion 3: repo scope", () => {
  const roles = ["executor", "code-reviewer", "project-manager"];

  it.each(roles)("denies another repo under the same owner for role %s", (role) => {
    const decision = decide(baseReq({ role, path: "/repos/acme/other-repo" }));
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("repo_out_of_scope");
  });

  it.each(roles)("denies another owner's repo entirely for role %s", (role) => {
    const decision = decide(baseReq({ role, path: "/repos/someone-else/widgets" }));
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("repo_out_of_scope");
  });

  it.each(roles)("denies /gists for role %s", (role) => {
    const decision = decide(baseReq({ role, path: "/gists", method: "POST" }));
    expect(decision.allow).toBe(false);
  });

  it.each(roles)("denies /user for role %s", (role) => {
    const decision = decide(baseReq({ role, path: "/user" }));
    expect(decision.allow).toBe(false);
  });

  it.each(roles)("denies /orgs for role %s", (role) => {
    const decision = decide(baseReq({ role, path: "/orgs/acme" }));
    expect(decision.allow).toBe(false);
  });

  it.each(roles)("denies /search for role %s", (role) => {
    const decision = decide(baseReq({ role, path: "/search/issues", query: { q: "x" } }));
    expect(decision.allow).toBe(false);
  });

  it("denies a git push targeting a different repo", () => {
    const decision = decide(
      baseReq({
        role: "executor",
        method: "POST",
        host: "github.com",
        sniHost: "github.com",
        path: "/someone-else/other-repo.git/git-receive-pack",
      }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("repo_out_of_scope");
  });
});

describe("criterion 4: no role may merge or touch protection state", () => {
  const cases: { method: string; path: string; label: string }[] = [
    { method: "PUT", path: "/repos/acme/widgets/pulls/5/merge", label: "PUT pulls/{n}/merge" },
    { method: "POST", path: "/repos/acme/widgets/merges", label: "POST merges" },
    {
      method: "PATCH",
      path: "/repos/acme/widgets/branches/main/protection",
      label: "PATCH branch protection",
    },
    { method: "PUT", path: "/repos/acme/widgets/branches/main/protection", label: "PUT branch protection" },
    { method: "POST", path: "/repos/acme/widgets/rulesets", label: "POST rulesets" },
    { method: "PUT", path: "/repos/acme/widgets/collaborators/alice", label: "PUT collaborators" },
    { method: "PATCH", path: "/repos/acme/widgets/hooks/3", label: "PATCH hooks" },
    { method: "POST", path: "/repos/acme/widgets/hooks", label: "POST hooks" },
    { method: "PUT", path: "/repos/acme/widgets/keys/9", label: "PUT keys" },
    { method: "POST", path: "/repos/acme/widgets/keys", label: "POST keys" },
  ];

  it.each(cases)("denies $label even for executor (contents:write)", ({ method, path }) => {
    const decision = decide(baseReq({ role: "executor", method, path }));
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("merge_or_protection_denied");
  });

  it.each(cases)("denies $label for project-manager too", ({ method, path }) => {
    const decision = decide(baseReq({ role: "project-manager", method, path }));
    expect(decision.allow).toBe(false);
  });
});

describe("criterion 5: pushes restricted to refs/heads/fx/*, each push-capable role to its own sub-prefix", () => {
  function pushDecisionFor(role: string, updates: { old: string; new: string; ref: string }[]) {
    const body = buildReceivePackBody(updates);
    const gitRefUpdates = parseReceivePackRefUpdates(body);
    return decide(
      baseReq({
        role,
        method: "POST",
        host: "github.com",
        sniHost: "github.com",
        path: "/acme/widgets.git/git-receive-pack",
        gitRefUpdates,
      }),
    );
  }

  it("allows executor to push to a plain fx/* branch", () => {
    const decision = pushDecisionFor("executor", [
      { old: ZERO_SHA, new: SHA_A, ref: "refs/heads/fx/H03" },
    ]);
    expect(decision.allow).toBe(true);
    expect(decision.tokenScope?.permissions.contents).toBe("write");
  });

  it("denies a push touching the default branch", () => {
    const decision = pushDecisionFor("executor", [
      { old: SHA_A, new: SHA_B, ref: "refs/heads/main" },
    ]);
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("receive_pack_ref_outside_allowed_prefix");
  });

  it("denies a push touching a tag", () => {
    const decision = pushDecisionFor("executor", [
      { old: ZERO_SHA, new: SHA_A, ref: "refs/tags/v1.0.0" },
    ]);
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("receive_pack_ref_outside_allowed_prefix");
  });

  it("denies when one of several ref updates escapes fx/*", () => {
    const decision = pushDecisionFor("executor", [
      { old: ZERO_SHA, new: SHA_A, ref: "refs/heads/fx/H03" },
      { old: SHA_A, new: SHA_B, ref: "refs/heads/main" },
    ]);
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("receive_pack_ref_outside_allowed_prefix");
  });

  it("allows a git clone (upload-pack) on the team product for any known role", () => {
    // [D#2 fix round 1, must-fix 2] git-upload-pack is POST-only now, same
    // as real git smart-HTTP -- GET only ever reaches the OTHER endpoint,
    // info/refs (ref discovery, covered separately below).
    const decision = decide(
      baseReq({
        role: "code-reviewer",
        method: "POST",
        host: "github.com",
        sniHost: "github.com",
        path: "/acme/widgets.git/git-upload-pack",
      }),
    );
    expect(decision.allow).toBe(true);
    expect(decision.reason).toBe("clone_allowed");
  });

  it("allows ref discovery before a clone (GET info/refs?service=git-upload-pack) for any known role", () => {
    const decision = decide(
      baseReq({
        role: "code-reviewer",
        method: "GET",
        host: "github.com",
        sniHost: "github.com",
        path: "/acme/widgets.git/info/refs",
        query: { service: "git-upload-pack" },
      }),
    );
    expect(decision.allow).toBe(true);
  });

  it("denies PUT/PATCH/DELETE on git-upload-pack, even for a role that may otherwise clone", () => {
    for (const method of ["PUT", "PATCH", "DELETE"] as const) {
      const decision = decide(
        baseReq({
          role: "code-reviewer",
          method,
          host: "github.com",
          sniHost: "github.com",
          path: "/acme/widgets.git/git-upload-pack",
        }),
      );
      expect(decision.allow).toBe(false);
      expect(decision.reason).toBe("upload_pack_method_not_allowed");
    }
  });

  it("denies PUT/PATCH/DELETE on info/refs (upload-pack discovery)", () => {
    for (const method of ["PUT", "PATCH", "DELETE"] as const) {
      const decision = decide(
        baseReq({
          role: "code-reviewer",
          method,
          host: "github.com",
          sniHost: "github.com",
          path: "/acme/widgets.git/info/refs",
          query: { service: "git-upload-pack" },
        }),
      );
      expect(decision.allow).toBe(false);
      expect(decision.reason).toBe("info_refs_method_not_allowed");
    }
  });

  it("denies receive-pack for a role that cannot push at all, even onto fx/*", () => {
    const decision = pushDecisionFor("code-reviewer", [
      { old: ZERO_SHA, new: SHA_A, ref: "refs/heads/fx/H03" },
    ]);
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("receive_pack_requires_push_capable_role");
  });

  it("denies receive-pack with no parsed ref updates (fail closed)", () => {
    const decision = decide(
      baseReq({
        role: "executor",
        method: "POST",
        host: "github.com",
        sniHost: "github.com",
        path: "/acme/widgets.git/git-receive-pack",
      }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("receive_pack_unparsed_or_incomplete");
  });

  it("denies receive-pack whose body parsed cleanly but carried zero ref updates", () => {
    const decision = decide(
      baseReq({
        role: "executor",
        method: "POST",
        host: "github.com",
        sniHost: "github.com",
        path: "/acme/widgets.git/git-receive-pack",
        gitRefUpdates: { updates: [], complete: true },
      }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("receive_pack_no_ref_updates");
  });

  // [H03 fix round 2, Team Lead decision a] docs-writer/release-manager/
  // runbook-writer push via git too, each confined to its own sub-prefix.
  it.each([
    ["docs-writer", "refs/heads/fx/docs/README-update"],
    ["release-manager", "refs/heads/fx/release/v1.2.3"],
    ["runbook-writer", "refs/heads/fx/runbook/incident-42"],
  ] as const)("allows %s to push to its own prefix (%s)", (role, ref) => {
    const decision = pushDecisionFor(role, [{ old: ZERO_SHA, new: SHA_A, ref }]);
    expect(decision.allow).toBe(true);
  });

  it.each([
    ["docs-writer", "refs/heads/fx/release/v1.2.3"],
    ["docs-writer", "refs/heads/fx/runbook/incident-42"],
    ["docs-writer", "refs/heads/fx/H03"], // not even the plain executor-style prefix
    ["release-manager", "refs/heads/fx/docs/README-update"],
    ["release-manager", "refs/heads/fx/runbook/incident-42"],
    ["runbook-writer", "refs/heads/fx/docs/README-update"],
    ["runbook-writer", "refs/heads/fx/release/v1.2.3"],
  ] as const)("denies %s pushing outside its own prefix (%s)", (role, ref) => {
    const decision = pushDecisionFor(role, [{ old: ZERO_SHA, new: SHA_A, ref }]);
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("receive_pack_ref_outside_allowed_prefix");
  });

  it.each([
    "refs/heads/fx/docs/README-update",
    "refs/heads/fx/release/v1.2.3",
    "refs/heads/fx/runbook/incident-42",
  ])("denies executor pushing onto the other three roles' reserved prefix (%s)", (ref) => {
    const decision = pushDecisionFor("executor", [{ old: ZERO_SHA, new: SHA_A, ref }]);
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("receive_pack_ref_outside_allowed_prefix");
  });

  it("executor may still push to an ordinary fx/* branch that shares no prefix with any reserved name", () => {
    const decision = pushDecisionFor("executor", [
      { old: ZERO_SHA, new: SHA_A, ref: "refs/heads/fx/totally-unrelated/H03" },
    ]);
    expect(decision.allow).toBe(true);
  });

  // [H03 fix round 4, item 3] Superseded again: round 3's LOOSER plain
  // string-prefix exclusion over-reached (it blocked plausible unrelated
  // branch names like "fx/release-2.0" for no reason — only the EXACT bare
  // root causes a real git leaf/directory conflict). executor's exclusion
  // is now the same exact-segment boundary the owning role's own grant
  // already uses, so a near-miss like "fx/docs-but-not-really" is
  // ALLOWED for executor again (see canRolePush's docstring in decide.ts).
  it("[round 4] executor may push a near-miss that merely shares docs-writer's prefix as a string, not a real path boundary", () => {
    const decision = pushDecisionFor("executor", [
      { old: ZERO_SHA, new: SHA_A, ref: "refs/heads/fx/docs-but-not-really/H03" },
    ]);
    expect(decision.allow).toBe(true);
  });

  it.each(["refs/heads/fx/release-2.0", "refs/heads/fx/runbooks-old"])(
    "[round 4] executor may push a plausible unrelated branch name that merely shares characters with a reserved root (%s)",
    (ref) => {
      const decision = pushDecisionFor("executor", [{ old: ZERO_SHA, new: SHA_A, ref }]);
      expect(decision.allow).toBe(true);
    },
  );

  // [H03 fix round 3, item W3]
  it.each(["docs-writer", "release-manager", "runbook-writer"] as const)(
    "%s may push its own bare root ref (no trailing content)",
    (role) => {
      const rootRef = `refs/heads/fx/${role === "docs-writer" ? "docs" : role === "release-manager" ? "release" : "runbook"}`;
      const decision = pushDecisionFor(role, [{ old: ZERO_SHA, new: SHA_A, ref: rootRef }]);
      expect(decision.allow).toBe(true);
    },
  );

  it("[round 3] executor is denied each role's bare root ref too, not just its namespace", () => {
    for (const bareRoot of ["refs/heads/fx/docs", "refs/heads/fx/release", "refs/heads/fx/runbook"]) {
      const decision = pushDecisionFor("executor", [{ old: ZERO_SHA, new: SHA_A, ref: bareRoot }]);
      expect(decision.allow).toBe(false);
      expect(decision.reason).toBe("receive_pack_ref_outside_allowed_prefix");
    }
  });

  // [H03 fix round 4, item 3] Superseded: "fx/docsX" is a distinct branch
  // segment, not really inside docs-writer's namespace, so with the
  // exact-segment boundary fix it is no longer excluded from executor.
  it("[round 4] executor may push a lookalike sibling with no separating slash (fx/docsX)", () => {
    const decision = pushDecisionFor("executor", [
      { old: ZERO_SHA, new: SHA_A, ref: "refs/heads/fx/docsX" },
    ]);
    expect(decision.allow).toBe(true);
  });

  it.each(["docs-writer", "release-manager", "runbook-writer"] as const)(
    "%s may discover refs before pushing (info/refs?service=git-receive-pack)",
    (role) => {
      const decision = decide(
        baseReq({
          role,
          method: "GET",
          host: "github.com",
          sniHost: "github.com",
          path: "/acme/widgets.git/info/refs",
          query: { service: "git-receive-pack" },
        }),
      );
      expect(decision.allow).toBe(true);
      expect(decision.reason).toBe("receive_pack_discovery_allowed");
    },
  );
});

describe("criterion 6: reviewer roles read/comment/allowlisted-label only", () => {
  const reviewerRoles = Array.from(REVIEWER_ROLES);

  it.each(reviewerRoles)("%s may read a PR", (role) => {
    const decision = decide(baseReq({ role, method: "GET", path: "/repos/acme/widgets/pulls/5" }));
    expect(decision.allow).toBe(true);
  });

  it.each(reviewerRoles)("%s may post a comment", (role) => {
    const decision = decide(
      baseReq({ role, method: "POST", path: "/repos/acme/widgets/issues/5/comments" }),
    );
    expect(decision.allow).toBe(true);
  });

  it.each(reviewerRoles)("%s may post a PR review", (role) => {
    const decision = decide(
      baseReq({ role, method: "POST", path: "/repos/acme/widgets/pulls/5/reviews" }),
    );
    expect(decision.allow).toBe(true);
  });

  // [H03 fix round item 7] Each reviewer role owns only ITS OWN verdict
  // label(s) now, not the full allowlist — code-review-passed for
  // code-reviewer, security-review-passed for security-reviewer,
  // acceptance-passed/-failed for acceptance-tester, and nothing at all for
  // debater/accessibility-reviewer (they can read/comment but not label).
  it.each([
    ["code-reviewer", "code-review-passed"],
    ["security-reviewer", "security-review-passed"],
    ["acceptance-tester", "acceptance-passed"],
  ] as const)("%s may add its own verdict label (%s)", (role, label) => {
    const decision = decide(
      baseReq({
        role,
        method: "POST",
        path: "/repos/acme/widgets/issues/5/labels",
        labelNames: [label],
      }),
    );
    expect(decision.allow).toBe(true);
  });

  it.each(["debater", "accessibility-reviewer"] as const)(
    "%s owns no verdict label at all, even one from the allowlist",
    (role) => {
      const decision = decide(
        baseReq({
          role,
          method: "POST",
          path: "/repos/acme/widgets/issues/5/labels",
          labelNames: ["code-review-passed"],
        }),
      );
      expect(decision.allow).toBe(false);
      expect(decision.reason).toBe("label_not_allowlisted");
    },
  );

  it.each(reviewerRoles)("%s may NOT add a non-allowlisted label", (role) => {
    const decision = decide(
      baseReq({
        role,
        method: "POST",
        path: "/repos/acme/widgets/issues/5/labels",
        labelNames: ["totally-made-up-label"],
      }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("label_not_allowlisted");
  });

  // [H03 fix round 2, item W1] needs-fix is no longer shared: each reviewer
  // owns its OWN distinctly-named needs-fix label, so removing one role's
  // never touches another's.
  it.each([
    ["code-reviewer", "code-review-needs-fix"],
    ["security-reviewer", "security-needs-fix"],
  ] as const)("%s may remove its own needs-fix label (%s)", (role, label) => {
    const decision = decide(
      baseReq({ role, method: "DELETE", path: `/repos/acme/widgets/issues/5/labels/${label}` }),
    );
    expect(decision.allow).toBe(true);
  });

  it("code-reviewer may NOT remove security-reviewer's needs-fix label", () => {
    const decision = decide(
      baseReq({
        role: "code-reviewer",
        method: "DELETE",
        path: "/repos/acme/widgets/issues/5/labels/security-needs-fix",
      }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("label_not_allowlisted");
  });

  it("security-reviewer may NOT remove code-reviewer's needs-fix label", () => {
    const decision = decide(
      baseReq({
        role: "security-reviewer",
        method: "DELETE",
        path: "/repos/acme/widgets/issues/5/labels/code-review-needs-fix",
      }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("label_not_allowlisted");
  });

  it.each(["acceptance-tester", "debater", "accessibility-reviewer"] as const)(
    "%s may NOT remove code-reviewer's needs-fix label (doesn't own it)",
    (role) => {
      const decision = decide(
        baseReq({
          role,
          method: "DELETE",
          path: "/repos/acme/widgets/issues/5/labels/code-review-needs-fix",
        }),
      );
      expect(decision.allow).toBe(false);
      expect(decision.reason).toBe("label_not_allowlisted");
    },
  );

  it.each(reviewerRoles)("%s may NOT remove a non-allowlisted label", (role) => {
    const decision = decide(
      baseReq({
        role,
        method: "DELETE",
        path: "/repos/acme/widgets/issues/5/labels/some-other-label",
      }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("label_not_allowlisted");
  });

  it.each(reviewerRoles)(
    "%s may NOT PATCH an issue (a body-carried labels field this engine never sees)",
    (role) => {
      const decision = decide(
        baseReq({ role, method: "PATCH", path: "/repos/acme/widgets/issues/5" }),
      );
      expect(decision.allow).toBe(false);
      expect(decision.reason).toBe("issue_or_pr_patch_denied");
    },
  );

  it.each(reviewerRoles)(
    "%s falls through to reviewer_write_denied for an unmatched write (e.g. milestones)",
    (role) => {
      const decision = decide(
        baseReq({ role, method: "PATCH", path: "/repos/acme/widgets/milestones/1" }),
      );
      expect(decision.allow).toBe(false);
      expect(decision.reason).toBe("reviewer_write_denied");
    },
  );

  it.each(reviewerRoles)("%s may NOT write contents (universal REST-contents denial)", (role) => {
    const decision = decide(
      baseReq({ role, method: "PUT", path: "/repos/acme/widgets/contents/README.md" }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("contents_write_via_rest_denied");
  });

  it.each(reviewerRoles)("%s may NOT delete contents (universal REST-contents denial)", (role) => {
    const decision = decide(
      baseReq({ role, method: "DELETE", path: "/repos/acme/widgets/contents/README.md" }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("contents_write_via_rest_denied");
  });
});

describe("criterion 7: sitekit is read-only for every role", () => {
  const roles = ["executor", "code-reviewer", "project-manager", "docs-writer"];

  it.each(roles)("%s may GET a repo resource on sitekit", (role) => {
    const decision = decide(
      baseReq({ role, product: "sitekit", method: "GET", path: "/repos/acme/widgets" }),
    );
    expect(decision.allow).toBe(true);
  });

  it.each(roles)("%s may HEAD a repo resource on sitekit", (role) => {
    const decision = decide(
      baseReq({ role, product: "sitekit", method: "HEAD", path: "/repos/acme/widgets" }),
    );
    expect(decision.allow).toBe(true);
  });

  it.each(roles)("%s may git-upload-pack (clone) on sitekit", (role) => {
    const decision = decide(
      baseReq({
        role,
        product: "sitekit",
        method: "POST",
        host: "github.com",
        sniHost: "github.com",
        path: "/acme/widgets.git/git-upload-pack",
      }),
    );
    expect(decision.allow).toBe(true);
  });

  it.each(roles)("%s may NOT POST a comment on sitekit", (role) => {
    const decision = decide(
      baseReq({
        role,
        product: "sitekit",
        method: "POST",
        path: "/repos/acme/widgets/issues/5/comments",
      }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("sitekit_write_denied");
  });

  it("executor may NOT git-receive-pack (push) on sitekit", () => {
    const body = buildReceivePackBody([{ old: ZERO_SHA, new: SHA_A, ref: "refs/heads/fx/H03" }]);
    const gitRefUpdates = parseReceivePackRefUpdates(body);
    const decision = decide(
      baseReq({
        role: "executor",
        product: "sitekit",
        method: "POST",
        host: "github.com",
        sniHost: "github.com",
        path: "/acme/widgets.git/git-receive-pack",
        gitRefUpdates,
      }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("sitekit_write_denied");
  });
});

describe("criterion 8: tokenScope.permissions come from the per-role minimum table", () => {
  it("returns the executor's own table entry on allow", () => {
    const decision = decide(baseReq({ role: "executor", method: "GET", path: "/repos/acme/widgets" }));
    expect(decision.allow).toBe(true);
    expect(decision.tokenScope?.permissions).toEqual({
      metadata: "read",
      contents: "write",
      pull_requests: "write",
      issues: "read",
    });
  });

  it("scopes the minted token to exactly the installation's one repo", () => {
    const decision = decide(baseReq({ role: "executor", method: "GET", path: "/repos/acme/widgets" }));
    expect(decision.tokenScope?.repositories).toEqual(["widgets"]);
  });
});

describe("non-reviewer roles: writes need the matching write permission", () => {
  it(
    "[H03 fix round item 3] denies even executor writing contents via REST — contents:write in the " +
      "table is the token ceiling for git push, not a REST-endpoint grant",
    () => {
      const decision = decide(
        baseReq({ role: "executor", method: "PUT", path: "/repos/acme/widgets/contents/foo.txt" }),
      );
      expect(decision.allow).toBe(false);
      expect(decision.reason).toBe("contents_write_via_rest_denied");
    },
  );

  it("denies researcher creating an issue (no issues:write permission)", () => {
    const decision = decide(
      baseReq({ role: "researcher", method: "POST", path: "/repos/acme/widgets/issues" }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("role_lacks_write_permission");
  });

  it("denies a write to a resource this engine doesn't recognize", () => {
    const decision = decide(
      baseReq({ role: "executor", method: "PATCH", path: "/repos/acme/widgets/milestones/1" }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("unknown_resource");
  });

  it("allows any known role to read within repo scope", () => {
    const decision = decide(
      baseReq({ role: "researcher", method: "GET", path: "/repos/acme/widgets/commits" }),
    );
    expect(decision.allow).toBe(true);
  });
});

describe("unknown role", () => {
  it("is denied on the team product", () => {
    const decision = decide(baseReq({ role: "not-a-real-role", method: "GET" }));
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("unknown_role");
  });
});

describe("D#2 C20 criterion 10: GitHub Discussions writes through the proxy are denied for every former writer", () => {
  const FORMER_WRITERS = [
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
  ];

  // addDiscussionComment and updateDiscussion exist only as GitHub GraphQL mutations, all POSTed to /graphql.
  // decide() has no GraphQL grant: the request is denied whatever the body says.
  it.each(FORMER_WRITERS)("denies a GraphQL POST (addDiscussionComment / updateDiscussion) for %s", (role) => {
    for (const path of ["/graphql", "/repos/acme/widgets/graphql"]) {
      const decision = decide(baseReq({ method: "POST", path, role }));
      expect(decision.allow, `${role} ${path}`).toBe(false);
      expect(decision.tokenScope).toBeUndefined();
    }
  });

  it.each(FORMER_WRITERS)("denies the Discussions REST paths for %s (no such endpoint is granted)", (role) => {
    for (const [method, path] of [
      ["POST", "/repos/acme/widgets/discussions"],
      ["POST", "/repos/acme/widgets/discussions/1/comments"],
      ["PATCH", "/repos/acme/widgets/discussions/1"],
    ] as const) {
      expect(decide(baseReq({ method, path, role })).allow, `${role} ${method} ${path}`).toBe(false);
    }
  });

  it.each(FORMER_WRITERS)("an allowed request for %s mints a token without discussions: write", (role) => {
    const decision = decide(baseReq({ path: "/repos/acme/widgets", role }));
    if (decision.allow) expect(decision.tokenScope?.permissions.discussions).not.toBe("write");
  });
});
