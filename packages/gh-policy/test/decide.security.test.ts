import { describe, expect, it } from "vitest";
import { decide } from "../src/decide.js";
import { parseReceivePackRefUpdates } from "../src/parseReceivePack.js";
import { ROLE_PERMISSIONS } from "../src/rolePermissions.js";
import type { ProxyRequest, Product } from "../src/types.js";
import { buildReceivePackBody, SHA_A, ZERO_SHA } from "./fixtures.js";

/**
 * Security fix round on top of commit 4094cb0. Every describe block below
 * is named after the exact item in the review that found it. Each of these
 * failed (returned `allow: true`, or threw) against 4094cb0's decide.ts —
 * see the fix-round report for the red-run transcript against that commit;
 * these assertions are what makes the fixed code green.
 */

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

describe("item 1: non-canonical path / method bypasses of the merge block", () => {
  const executorPerms = { role: "executor" };

  it.each([
    ["dot-dot segment before pulls", "PUT", "/repos/acme/widgets/pulls/../pulls/1/merge"],
    ["percent-encoded dot-dot", "PUT", "/repos/acme/widgets/pulls/%2e%2e/pulls/1/merge"],
    ["dot segment", "PUT", "/repos/acme/widgets/pulls/1/./merge"],
    ["empty segment (double slash)", "PUT", "/repos/acme/widgets/pulls/1//merge"],
    ["trailing slash", "PUT", "/repos/acme/widgets/pulls/1/merge/"],
    ["query string embedded in the path itself", "PUT", "/repos/acme/widgets/pulls/1/merge?x=1"],
    ["deep dot-dot escape past /pulls prefix", "POST", "/repos/acme/widgets/pulls/../../../evil/x/pulls"],
  ])("denies: %s (%s %s)", (_label, method, path) => {
    const decision = decide(baseReq({ ...executorPerms, method, path }));
    expect(decision.allow).toBe(false);
  });

  it("denies a lowercase 'put' method rather than normalizing it to PUT", () => {
    const decision = decide(
      baseReq({ role: "executor", method: "put", path: "/repos/acme/widgets/pulls/1/merge" }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("method_not_allowed");
  });

  it("still allows the exact-canonical, correct-case merge path to be recognized as a merge (denied for the right reason)", () => {
    const decision = decide(
      baseReq({ role: "executor", method: "PUT", path: "/repos/acme/widgets/pulls/1/merge" }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("merge_or_protection_denied");
  });
});

describe("item 2: host allowlist", () => {
  it("denies host===sniHost when the host itself isn't allowlisted", () => {
    const decision = decide(
      baseReq({ host: "evil.example", sniHost: "evil.example", path: "/repos/acme/widgets" }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("host_not_allowed");
  });

  it("denies a port suffix on an otherwise-allowed host", () => {
    const decision = decide(
      baseReq({
        host: "api.github.com:444",
        sniHost: "api.github.com:444",
        path: "/repos/acme/widgets",
      }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("host_not_allowed");
  });

  it("denies a REST path sent to the git host (the mirror of the check above)", () => {
    const decision = decide(
      baseReq({
        host: "github.com",
        sniHost: "github.com",
        method: "GET",
        path: "/repos/acme/widgets",
      }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("host_not_allowed");
  });

  it("denies a git smart-HTTP path sent to the REST API host", () => {
    const decision = decide(
      baseReq({
        host: "api.github.com",
        sniHost: "api.github.com",
        method: "POST",
        path: "/acme/widgets.git/git-upload-pack",
      }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("host_not_allowed");
  });

  it("denies a REST path sent to a non-API GitHub host (uploads.github.com)", () => {
    const decision = decide(
      baseReq({
        host: "uploads.github.com",
        sniHost: "uploads.github.com",
        method: "PUT",
        path: "/repos/acme/widgets/contents/a.txt",
      }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("host_not_allowed");
  });

  it("compares hosts case-insensitively but still denies an unallowlisted one", () => {
    const decision = decide(
      baseReq({ host: "API.GITHUB.COM", sniHost: "api.github.com", path: "/repos/acme/widgets" }),
    );
    expect(decision.allow).toBe(true); // both normalize to api.github.com
  });
});

describe("item 3: the REST contents API is never a write path", () => {
  it.each(["executor", "docs-writer", "release-manager", "runbook-writer"])(
    "denies %s PUT on /contents/...",
    (role) => {
      const decision = decide(
        baseReq({ role, method: "PUT", path: "/repos/acme/widgets/contents/src/a.ts" }),
      );
      expect(decision.allow).toBe(false);
      expect(decision.reason).toBe("contents_write_via_rest_denied");
    },
  );

  it.each(["executor", "docs-writer", "release-manager", "runbook-writer"])(
    "denies %s DELETE on /contents/...",
    (role) => {
      const decision = decide(
        baseReq({ role, method: "DELETE", path: "/repos/acme/widgets/contents/CHANGELOG.md" }),
      );
      expect(decision.allow).toBe(false);
      expect(decision.reason).toBe("contents_write_via_rest_denied");
    },
  );

  it("still allows reading contents", () => {
    const decision = decide(
      baseReq({ role: "docs-writer", method: "GET", path: "/repos/acme/widgets/contents/README.md" }),
    );
    expect(decision.allow).toBe(true);
  });
});

describe("item 4: ref validity, not just the fx/* prefix string", () => {
  function pushDecisionFor(ref: string) {
    const body = buildReceivePackBody([{ old: ZERO_SHA, new: SHA_A, ref }]);
    const gitRefUpdates = parseReceivePackRefUpdates(body);
    return decide(
      baseReq({
        role: "executor",
        method: "POST",
        host: "github.com",
        sniHost: "github.com",
        path: "/acme/widgets.git/git-receive-pack",
        gitRefUpdates,
      }),
    );
  }

  it("denies refs/heads/fx/../main even though it satisfies startsWith('refs/heads/fx/')", () => {
    const decision = pushDecisionFor("refs/heads/fx/../main");
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("receive_pack_ref_outside_allowed_prefix");
  });

  it("denies a ref containing @{ (reflog syntax)", () => {
    const decision = pushDecisionFor("refs/heads/fx/H03@{upstream}");
    expect(decision.allow).toBe(false);
  });

  it("denies a ref with a double slash", () => {
    const decision = pushDecisionFor("refs/heads/fx//H03");
    expect(decision.allow).toBe(false);
  });

  it("still allows a genuinely valid fx/* ref", () => {
    const decision = pushDecisionFor("refs/heads/fx/H03");
    expect(decision.allow).toBe(true);
  });
});

describe("item 5: prototype keys are never a role, on either product", () => {
  it.each(["toString", "__proto__", "constructor", "hasOwnProperty", "valueOf"])(
    "denies role=%s on the team product",
    (role) => {
      const decision = decide(baseReq({ role, method: "GET", path: "/repos/acme/widgets" }));
      expect(decision.allow).toBe(false);
      expect(decision.reason).toBe("unknown_role");
    },
  );

  it.each(["toString", "__proto__", "constructor", "hasOwnProperty", "valueOf"])(
    "denies role=%s on the sitekit product too",
    (role) => {
      const decision = decide(
        baseReq({ role, product: "sitekit", method: "GET", path: "/repos/acme/widgets" }),
      );
      expect(decision.allow).toBe(false);
      expect(decision.reason).toBe("unknown_role");
    },
  );

  it("a real role still resolves its own permissions object, not Object.prototype", () => {
    const decision = decide(baseReq({ role: "executor", method: "GET", path: "/repos/acme/widgets" }));
    expect(decision.allow).toBe(true);
    expect(decision.tokenScope?.permissions).toEqual({
      metadata: "read",
      contents: "write",
      pull_requests: "write",
      issues: "read",
    });
  });
});

describe("item 6: a malformed percent-encoded label name denies instead of throwing", () => {
  it("does not throw for DELETE .../labels/%E0", () => {
    expect(() =>
      decide(
        baseReq({
          role: "code-reviewer",
          method: "DELETE",
          path: "/repos/acme/widgets/issues/1/labels/%E0",
        }),
      ),
    ).not.toThrow();
  });

  it("denies %E0, though as of the round-2 W2 fix the reason is now path_not_canonical, not malformed_label_encoding", () => {
    // %E0 is byte 0xE0 — non-ASCII, so canonicalPath.ts now rejects it as a
    // percent-encoded byte before decide() ever reaches the label-specific
    // decodeURIComponent try/catch (item 6's original fix). Both layers
    // agree "deny", which is what matters; the reason string moved because
    // the earlier, more general check now fires first. See the dedicated
    // decodeURIComponent-still-throws-nothing-gets-through coverage below.
    const decision = decide(
      baseReq({
        role: "code-reviewer",
        method: "DELETE",
        path: "/repos/acme/widgets/issues/1/labels/%E0",
      }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("path_not_canonical");
  });

  it("still works normally for a well-formed, non-allowlisted label", () => {
    const decision = decide(
      baseReq({
        role: "code-reviewer",
        method: "DELETE",
        path: "/repos/acme/widgets/issues/1/labels/some-other-label",
      }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("label_not_allowlisted");
  });
});

describe("item 7: verdict labels are scoped to the matching reviewer role only", () => {
  it.each(["project-manager", "incident-commander"])(
    "denies %s adding a verdict label via POST .../labels — no reviewer-role check should ever let this through",
    (role) => {
      const decision = decide(
        baseReq({
          role,
          method: "POST",
          path: "/repos/acme/widgets/issues/1/labels",
          labelNames: ["code-review-passed"],
        }),
      );
      expect(decision.allow).toBe(false);
      expect(decision.reason).toBe("verdict_label_requires_reviewer_role");
    },
  );

  it.each(["project-manager", "incident-commander"])(
    "denies %s removing a verdict label via DELETE .../labels/{name}",
    (role) => {
      const decision = decide(
        baseReq({
          role,
          method: "DELETE",
          path: "/repos/acme/widgets/issues/1/labels/code-review-needs-fix",
        }),
      );
      expect(decision.allow).toBe(false);
      expect(decision.reason).toBe("verdict_label_requires_reviewer_role");
    },
  );

  it("code-reviewer may not set security-reviewer's label", () => {
    const decision = decide(
      baseReq({
        role: "code-reviewer",
        method: "POST",
        path: "/repos/acme/widgets/issues/1/labels",
        labelNames: ["security-review-passed"],
      }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("label_not_allowlisted");
  });

  it("security-reviewer may not set code-reviewer's label", () => {
    const decision = decide(
      baseReq({
        role: "security-reviewer",
        method: "POST",
        path: "/repos/acme/widgets/issues/1/labels",
        labelNames: ["code-review-passed"],
      }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("label_not_allowlisted");
  });

  it("acceptance-tester may not remove code-reviewer's needs-fix label (doesn't own it)", () => {
    const decision = decide(
      baseReq({
        role: "acceptance-tester",
        method: "DELETE",
        path: "/repos/acme/widgets/issues/1/labels/code-review-needs-fix",
      }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("label_not_allowlisted");
  });

  // [H03 fix round 2, item W1] needs-fix is no longer shared between
  // code-reviewer and security-reviewer — each owns a distinctly-named one,
  // so removing code-reviewer's can never also clear security-reviewer's.
  it("code-reviewer may remove its OWN needs-fix label, not security-reviewer's", () => {
    const own = decide(
      baseReq({
        role: "code-reviewer",
        method: "DELETE",
        path: "/repos/acme/widgets/issues/1/labels/code-review-needs-fix",
      }),
    );
    expect(own.allow).toBe(true);

    const others = decide(
      baseReq({
        role: "code-reviewer",
        method: "DELETE",
        path: "/repos/acme/widgets/issues/1/labels/security-needs-fix",
      }),
    );
    expect(others.allow).toBe(false);
    expect(others.reason).toBe("label_not_allowlisted");
  });

  it("security-reviewer may remove its OWN needs-fix label, not code-reviewer's", () => {
    const own = decide(
      baseReq({
        role: "security-reviewer",
        method: "DELETE",
        path: "/repos/acme/widgets/issues/1/labels/security-needs-fix",
      }),
    );
    expect(own.allow).toBe(true);

    const others = decide(
      baseReq({
        role: "security-reviewer",
        method: "DELETE",
        path: "/repos/acme/widgets/issues/1/labels/code-review-needs-fix",
      }),
    );
    expect(others.allow).toBe(false);
    expect(others.reason).toBe("label_not_allowlisted");
  });

  it("debater owns no verdict label at all", () => {
    const decision = decide(
      baseReq({
        role: "debater",
        method: "POST",
        path: "/repos/acme/widgets/issues/1/labels",
        labelNames: ["code-review-passed"],
      }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("label_not_allowlisted");
  });

  it.each(["project-manager", "incident-commander", "code-reviewer"])(
    "denies %s PATCH /issues/{n} — the body could carry a labels field this engine never sees",
    (role) => {
      const decision = decide(
        baseReq({ role, method: "PATCH", path: "/repos/acme/widgets/issues/1" }),
      );
      expect(decision.allow).toBe(false);
      expect(decision.reason).toBe("issue_or_pr_patch_denied");
    },
  );

  it("denies PATCH /pulls/{n} the same way", () => {
    const decision = decide(
      baseReq({ role: "project-manager", method: "PATCH", path: "/repos/acme/widgets/pulls/1" }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("issue_or_pr_patch_denied");
  });
});

describe("item 8: decide() denies a receive-pack push whose parse was incomplete", () => {
  it("denies when gitRefUpdates.complete is false, even with well-formed-looking updates present", () => {
    const decision = decide(
      baseReq({
        role: "executor",
        method: "POST",
        host: "github.com",
        sniHost: "github.com",
        path: "/acme/widgets.git/git-receive-pack",
        gitRefUpdates: {
          updates: [{ old: ZERO_SHA, new: SHA_A, ref: "refs/heads/fx/H03" }],
          complete: false,
        },
      }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("receive_pack_unparsed_or_incomplete");
  });

  it("allows when complete is true and every ref is a valid fx/* ref", () => {
    const decision = decide(
      baseReq({
        role: "executor",
        method: "POST",
        host: "github.com",
        sniHost: "github.com",
        path: "/acme/widgets.git/git-receive-pack",
        gitRefUpdates: {
          updates: [{ old: ZERO_SHA, new: SHA_A, ref: "refs/heads/fx/H03" }],
          complete: true,
        },
      }),
    );
    expect(decision.allow).toBe(true);
  });
});

describe("receive-pack: only GET/HEAD (discovery) or POST (push) are meaningful", () => {
  it("denies a PUT to the git-receive-pack endpoint", () => {
    const decision = decide(
      baseReq({
        role: "executor",
        method: "PUT",
        host: "github.com",
        sniHost: "github.com",
        path: "/acme/widgets.git/git-receive-pack",
      }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("receive_pack_method_not_allowed");
  });
});

describe("generic non-reviewer write path still succeeds when the role actually has it", () => {
  it("allows project-manager to create a new issue (issues:write, not a single-resource PATCH)", () => {
    const decision = decide(
      baseReq({ role: "project-manager", method: "POST", path: "/repos/acme/widgets/issues" }),
    );
    expect(decision.allow).toBe(true);
    expect(decision.reason).toBe("write_allowed");
  });
});

describe("suggestion: executor push discovery (info/refs?service=git-receive-pack)", () => {
  it("allows the executor to discover refs before pushing", () => {
    const decision = decide(
      baseReq({
        role: "executor",
        method: "GET",
        host: "github.com",
        sniHost: "github.com",
        path: "/acme/widgets.git/info/refs",
        query: { service: "git-receive-pack" },
      }),
    );
    expect(decision.allow).toBe(true);
    expect(decision.reason).toBe("receive_pack_discovery_allowed");
  });

  it("still requires a push-capable role for push discovery", () => {
    const decision = decide(
      baseReq({
        role: "code-reviewer",
        method: "GET",
        host: "github.com",
        sniHost: "github.com",
        path: "/acme/widgets.git/info/refs",
        query: { service: "git-receive-pack" },
      }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("receive_pack_requires_push_capable_role");
  });

  it("still requires github.com, not api.github.com, for discovery", () => {
    const decision = decide(
      baseReq({
        role: "executor",
        method: "GET",
        host: "api.github.com",
        sniHost: "api.github.com",
        path: "/acme/widgets.git/info/refs",
        query: { service: "git-receive-pack" },
      }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("host_not_allowed");
  });
});

// ---------------------------------------------------------------------------
// H03 fix round 2 — security re-review of 185b0f4
// ---------------------------------------------------------------------------

describe("[round 2] item E1: control characters and whitespace in a path segment", () => {
  it.each([
    ["a literal tab inside a keyword segment", "PUT", "/repos/acme/widgets/pulls/1/mer\tge"],
    ["a tab-padded dot segment", "PUT", "/repos/acme/widgets/pulls/.\t./pulls/1/merge"],
    ["a trailing space on the last segment", "PUT", "/repos/acme/widgets/pulls/1/merge "],
    ["a leading space on a segment", "PUT", "/repos/acme/widgets/pulls/ 1/merge"],
    ["a DEL character (0x7F)", "PUT", "/repos/acme/widgets/pulls/1/merge\x7f"],
    ["a newline", "PUT", "/repos/acme/widgets/pulls/1/merge\n"],
  ])("denies: %s (%s %s)", (_label, method, path) => {
    const decision = decide(baseReq({ role: "executor", method, path }));
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("path_not_canonical");
  });
});

describe("[round 2] item E2: PUT/DELETE on the labels collection is always destructive", () => {
  it.each(["code-reviewer", "security-reviewer", "acceptance-tester"])(
    "denies %s PUT on the labels collection (would replace every role's labels)",
    (role) => {
      const decision = decide(
        baseReq({
          role,
          method: "PUT",
          path: "/repos/acme/widgets/issues/1/labels",
          labelNames: ["code-review-passed"],
        }),
      );
      expect(decision.allow).toBe(false);
      expect(decision.reason).toBe("labels_collection_replace_or_clear_denied");
    },
  );

  it.each(["code-reviewer", "security-reviewer", "acceptance-tester"])(
    "denies %s DELETE on the labels collection (would clear every role's labels)",
    (role) => {
      const decision = decide(
        baseReq({ role, method: "DELETE", path: "/repos/acme/widgets/issues/1/labels" }),
      );
      expect(decision.allow).toBe(false);
      expect(decision.reason).toBe("labels_collection_replace_or_clear_denied");
    },
  );

  it("POST (add) on the labels collection still works for the owning role", () => {
    const decision = decide(
      baseReq({
        role: "code-reviewer",
        method: "POST",
        path: "/repos/acme/widgets/issues/1/labels",
        labelNames: ["code-review-passed"],
      }),
    );
    expect(decision.allow).toBe(true);
  });

  it("DELETE of a single label still works for the owning role", () => {
    const decision = decide(
      baseReq({
        role: "code-reviewer",
        method: "DELETE",
        path: "/repos/acme/widgets/issues/1/labels/code-review-passed",
      }),
    );
    expect(decision.allow).toBe(true);
  });
});

describe("[round 2] item W2: percent-encoding, case, and delimiter tricks", () => {
  it.each([
    ["lowercase-m percent-encoded into 'merge'", "PUT", "/repos/acme/widgets/pulls/1/%6derge"],
    ["percent-encoded PR number", "PUT", "/repos/acme/widgets/pulls/%31/merge"],
    ["semicolon path-parameter delimiter", "PUT", "/repos/acme/widgets/pulls/1/merge;x"],
    ["double-encoded dot-dot (%252e%252e)", "PUT", "/repos/acme/widgets/pulls/%252e%252e/pulls/1/merge"],
    ["overlong UTF-8 dot-dot (%c0%ae%c0%ae)", "PUT", "/repos/acme/widgets/pulls/%c0%ae%c0%ae/pulls/1/merge"],
    ["literal fullwidth dot (U+FF0E)", "PUT", "/repos/acme/widgets/pulls/．．/pulls/1/merge"],
  ])("denies: %s (%s %s)", (_label, method, path) => {
    const decision = decide(baseReq({ role: "executor", method, path }));
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("path_not_canonical");
  });

  // [H03 fix round 3, suggestion] MERGE (wrong case) used to be caught here,
  // at the path-canonical layer. As of round 3, canonicalPath.ts no longer
  // enforces keyword casing at all (see its docstring) — the wrong-case
  // spelling now passes canonicalization and is denied later, by
  // decide()'s own case-sensitive routing finding no matching rule for it.
  // Still denied, just one layer later and for a different, more precise
  // reason. See "[round 3] suggestion: keyword casing..." below for the
  // fuller set of both-directions evidence.
  it("wrong-case keyword MERGE is denied by decide()'s routing, not path canonicalization", () => {
    const decision = decide(
      baseReq({ role: "executor", method: "PUT", path: "/repos/acme/widgets/pulls/1/MERGE" }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("unknown_resource");
  });

  it("does not force-lowercase an owner or repo name (only fixed API keywords)", () => {
    const decision = decide(
      baseReq({
        role: "executor",
        method: "GET",
        path: "/repos/Acme/Widgets",
        installation: { owner: "Acme", repo: "Widgets" },
      }),
    );
    expect(decision.allow).toBe(true);
  });
});

describe("[round 2] Team Lead decision (a): docs/release/runbook push prefixes, cross-checked at the token-scope layer too", () => {
  it("docs-writer's tokenScope still carries contents:write (needed to push at all)", () => {
    const decision = decide(
      baseReq({ role: "docs-writer", method: "GET", path: "/repos/acme/widgets" }),
    );
    expect(decision.allow).toBe(true);
    expect(decision.tokenScope?.permissions.contents).toBe("write");
  });

  it("docs-writer still cannot use that same contents:write to PUT the REST contents API", () => {
    const decision = decide(
      baseReq({ role: "docs-writer", method: "PUT", path: "/repos/acme/widgets/contents/README.md" }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("contents_write_via_rest_denied");
  });
});

describe("[round 2] Team Lead decision (b): PATCH on issues/pulls is gated on patchFields", () => {
  it("denies any PATCH on /issues/{n} with patchFields omitted", () => {
    const decision = decide(
      baseReq({ role: "project-manager", method: "PATCH", path: "/repos/acme/widgets/issues/1" }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("issue_or_pr_patch_denied");
  });

  it("allows project-manager to PATCH title/body/state/state_reason on an issue", () => {
    const decision = decide(
      baseReq({
        role: "project-manager",
        method: "PATCH",
        path: "/repos/acme/widgets/issues/1",
        patchFields: ["title", "body", "state", "state_reason"],
      }),
    );
    expect(decision.allow).toBe(true);
    expect(decision.reason).toBe("issue_or_pr_patch_allowed");
  });

  it("denies project-manager PATCHing an issue's labels even alongside an allowed field", () => {
    const decision = decide(
      baseReq({
        role: "project-manager",
        method: "PATCH",
        path: "/repos/acme/widgets/issues/1",
        patchFields: ["title", "labels"],
      }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("issue_or_pr_patch_field_denied");
  });

  it.each(["assignees", "milestone", "base", "maintainer_can_modify"])(
    "denies %s even as the sole requested field, for any role/resource pair",
    (field) => {
      const decision = decide(
        baseReq({
          role: "executor",
          method: "PATCH",
          path: "/repos/acme/widgets/pulls/1",
          patchFields: [field],
        }),
      );
      expect(decision.allow).toBe(false);
      expect(decision.reason).toBe("issue_or_pr_patch_field_denied");
    },
  );

  it("denies project-manager PATCHing a pull request (no allowlist entry for project-manager:pulls)", () => {
    const decision = decide(
      baseReq({
        role: "project-manager",
        method: "PATCH",
        path: "/repos/acme/widgets/pulls/1",
        patchFields: ["title"],
      }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("issue_or_pr_patch_field_denied");
  });

  it("allows executor to PATCH title/body on a pull request", () => {
    const decision = decide(
      baseReq({
        role: "executor",
        method: "PATCH",
        path: "/repos/acme/widgets/pulls/1",
        patchFields: ["title", "body"],
      }),
    );
    expect(decision.allow).toBe(true);
    expect(decision.reason).toBe("issue_or_pr_patch_allowed");
  });

  it("denies executor PATCHing an issue (no allowlist entry for executor:issues)", () => {
    const decision = decide(
      baseReq({
        role: "executor",
        method: "PATCH",
        path: "/repos/acme/widgets/issues/1",
        patchFields: ["title"],
      }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("issue_or_pr_patch_field_denied");
  });

  it("denies a reviewer role PATCHing an issue even with patchFields provided (no allowlist entry at all)", () => {
    const decision = decide(
      baseReq({
        role: "code-reviewer",
        method: "PATCH",
        path: "/repos/acme/widgets/issues/1",
        patchFields: ["title"],
      }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("issue_or_pr_patch_field_denied");
  });

  it("denies a field outside the role's exact allowlist even when it sounds harmless", () => {
    const decision = decide(
      baseReq({
        role: "project-manager",
        method: "PATCH",
        path: "/repos/acme/widgets/issues/1",
        patchFields: ["title", "some_future_field"],
      }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("issue_or_pr_patch_field_denied");
  });
});

describe("[round 2] suggestion: executors don't review", () => {
  it("denies executor POST /pulls/{n}/reviews", () => {
    const decision = decide(
      baseReq({ role: "executor", method: "POST", path: "/repos/acme/widgets/pulls/1/reviews" }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("review_requires_reviewer_role");
  });

  it("denies executor PUT /pulls/{n}/reviews/{id}/dismissals", () => {
    const decision = decide(
      baseReq({
        role: "executor",
        method: "PUT",
        path: "/repos/acme/widgets/pulls/1/reviews/9/dismissals",
      }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("review_requires_reviewer_role");
  });

  it("a reviewer role may still POST a review (unaffected by the executor-only carve-out)", () => {
    const decision = decide(
      baseReq({ role: "code-reviewer", method: "POST", path: "/repos/acme/widgets/pulls/1/reviews" }),
    );
    expect(decision.allow).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// H03 fix round 3 — security re-review of f7e9996
// ---------------------------------------------------------------------------

describe("[round 3] item E3: /pulls is no longer a prefix catch-all", () => {
  it("denies executor POST /pulls/{n}/reviews/{id}/events (submitting a pending review)", () => {
    const decision = decide(
      baseReq({
        role: "executor",
        method: "POST",
        path: "/repos/acme/widgets/pulls/1/reviews/5/events",
      }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("review_requires_reviewer_role");
  });

  it("denies executor PUT /pulls/{n}/reviews/{id} (rewriting a reviewer's text)", () => {
    const decision = decide(
      baseReq({ role: "executor", method: "PUT", path: "/repos/acme/widgets/pulls/1/reviews/5" }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("review_requires_reviewer_role");
  });

  it("denies executor DELETE /pulls/{n}/reviews/{id} too (deleting a pending review), closing the family, not just the two repros", () => {
    const decision = decide(
      baseReq({ role: "executor", method: "DELETE", path: "/repos/acme/widgets/pulls/1/reviews/5" }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("review_requires_reviewer_role");
  });

  it("denies executor POST /pulls/{n}/reviews/{id}/comments too", () => {
    const decision = decide(
      baseReq({
        role: "executor",
        method: "POST",
        path: "/repos/acme/widgets/pulls/1/reviews/5/comments",
      }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("review_requires_reviewer_role");
  });

  it("denies a fabricated, non-existent PR subpath (PATCH /pulls/{n}/lock)", () => {
    const decision = decide(
      baseReq({ role: "executor", method: "PATCH", path: "/repos/acme/widgets/pulls/1/lock" }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("unknown_resource");
  });

  it("a reviewer role may still read the review family (GET is unaffected)", () => {
    const decision = decide(
      baseReq({ role: "code-reviewer", method: "GET", path: "/repos/acme/widgets/pulls/1/reviews" }),
    );
    expect(decision.allow).toBe(true);
  });

  it("executor may still open a PR (POST /pulls, the enumerated route it actually needs)", () => {
    const decision = decide(
      baseReq({ role: "executor", method: "POST", path: "/repos/acme/widgets/pulls" }),
    );
    expect(decision.allow).toBe(true);
    expect(decision.reason).toBe("write_allowed");
  });

  it("executor may still request reviewers (POST /pulls/{n}/requested_reviewers)", () => {
    const decision = decide(
      baseReq({
        role: "executor",
        method: "POST",
        path: "/repos/acme/widgets/pulls/1/requested_reviewers",
      }),
    );
    expect(decision.allow).toBe(true);
  });

  it("[same root cause, /contents] denies executor POST on /contents/... — the prefix catch-all this used to fall through too", () => {
    // Before this fix, only PUT/DELETE on /contents were denied (item 3,
    // round 1); a POST slipped past that check and hit the SAME
    // resourceForSubpath prefix catch-all E3 closes for /pulls. No
    // enumerated route exists for /contents at all now, so any method that
    // isn't the universally-denied PUT/DELETE falls to unknown_resource.
    const decision = decide(
      baseReq({ role: "docs-writer", method: "POST", path: "/repos/acme/widgets/contents/newfile.txt" }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("unknown_resource");
  });

  it("[same root cause, /issues] denies a fabricated issues subpath (PATCH /issues/{n}/transfer)", () => {
    const decision = decide(
      baseReq({ role: "project-manager", method: "PATCH", path: "/repos/acme/widgets/issues/1/transfer" }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("unknown_resource");
  });
});

describe("[round 3] item W3: push-prefix boundary — bare root and lookalike siblings", () => {
  it("denies executor pushing the bare reserved root refs/heads/fx/docs (no trailing slash)", () => {
    const body = buildReceivePackBody([{ old: ZERO_SHA, new: SHA_A, ref: "refs/heads/fx/docs" }]);
    const gitRefUpdates = parseReceivePackRefUpdates(body);
    const decision = decide(
      baseReq({
        role: "executor",
        method: "POST",
        host: "github.com",
        sniHost: "github.com",
        path: "/acme/widgets.git/git-receive-pack",
        gitRefUpdates,
      }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("receive_pack_ref_outside_allowed_prefix");
  });

  // [H03 fix round 4, item 3] Superseded: the exact-segment boundary means
  // "fx/docsX" is a distinct branch name, not inside docs-writer's
  // namespace, so it's no longer excluded from executor. See item E3's
  // "[round 4]" block below for the direct, focused evidence; kept here
  // too so this describe block's own history reads coherently.
  it("[round 4] allows executor pushing the lookalike sibling refs/heads/fx/docsX (shares characters, not a real path boundary)", () => {
    const body = buildReceivePackBody([{ old: ZERO_SHA, new: SHA_A, ref: "refs/heads/fx/docsX" }]);
    const gitRefUpdates = parseReceivePackRefUpdates(body);
    const decision = decide(
      baseReq({
        role: "executor",
        method: "POST",
        host: "github.com",
        sniHost: "github.com",
        path: "/acme/widgets.git/git-receive-pack",
        gitRefUpdates,
      }),
    );
    expect(decision.allow).toBe(true);
  });

  it("allows docs-writer to push its own bare root ref refs/heads/fx/docs", () => {
    const body = buildReceivePackBody([{ old: ZERO_SHA, new: SHA_A, ref: "refs/heads/fx/docs" }]);
    const gitRefUpdates = parseReceivePackRefUpdates(body);
    const decision = decide(
      baseReq({
        role: "docs-writer",
        method: "POST",
        host: "github.com",
        sniHost: "github.com",
        path: "/acme/widgets.git/git-receive-pack",
        gitRefUpdates,
      }),
    );
    expect(decision.allow).toBe(true);
  });
});

describe("[round 3] item W4: percent-encoded '#' and '?' close the URL-splitting gap", () => {
  it.each(["%3f", "%3F", "%23"])("denies a merge attempt with the URL-splitting byte %s encoded in it", (enc) => {
    const decision = decide(
      baseReq({ role: "executor", method: "PUT", path: `/repos/acme/widgets/pulls/1/merge${enc}` }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("path_not_canonical");
  });
});

describe("[round 3] suggestion: keyword casing only matters where a keyword is actually expected", () => {
  it("allows GET .../contents/docs/Keys (a real file/directory name, not the /keys endpoint)", () => {
    const decision = decide(
      baseReq({ role: "executor", method: "GET", path: "/repos/acme/widgets/contents/docs/Keys" }),
    );
    expect(decision.allow).toBe(true);
  });

  it("allows GET .../branches/Refs (a real branch name, not the git info/refs endpoint)", () => {
    const decision = decide(
      baseReq({ role: "executor", method: "GET", path: "/repos/acme/widgets/branches/Refs" }),
    );
    expect(decision.allow).toBe(true);
  });

  it("still denies a merge attempt spelled MERGE in the actual keyword position", () => {
    const decision = decide(
      baseReq({ role: "executor", method: "PUT", path: "/repos/acme/widgets/pulls/1/MERGE" }),
    );
    expect(decision.allow).toBe(false);
    // Denied by decide()'s own case-sensitive routing (no rule matches an
    // uppercase MERGE), not by path canonicalization — see the W2 block
    // above for the direct comparison.
    expect(decision.reason).toBe("unknown_resource");
  });

  it("still denies the real, correctly-cased merge (unaffected baseline)", () => {
    const decision = decide(
      baseReq({ role: "executor", method: "PUT", path: "/repos/acme/widgets/pulls/1/merge" }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("merge_or_protection_denied");
  });
});

describe("[round 3] suggestion: PM closing a PR via the issues PATCH endpoint is a known, deliberate overlap", () => {
  it("allows project-manager to PATCH state on an issue-shaped path (documented overlap: GitHub's /issues/{n} also accepts PR numbers)", () => {
    const decision = decide(
      baseReq({
        role: "project-manager",
        method: "PATCH",
        path: "/repos/acme/widgets/issues/1",
        patchFields: ["state"],
      }),
    );
    expect(decision.allow).toBe(true);
    expect(decision.reason).toBe("issue_or_pr_patch_allowed");
  });
});

// ---------------------------------------------------------------------------
// H03 fix round 4 — the security review passed f851349; four small
// unblocking/tightening changes, called out individually below.
// ---------------------------------------------------------------------------

describe("[round 4] item 1: /issues/{n}/comments (PR conversation comments) accepts issues:write OR pull_requests:write", () => {
  it("allows executor to comment on a PR conversation (has pull_requests:write, not issues:write)", () => {
    const decision = decide(
      baseReq({ role: "executor", method: "POST", path: "/repos/acme/widgets/issues/1/comments" }),
    );
    expect(decision.allow).toBe(true);
    expect(decision.reason).toBe("write_allowed");
  });

  it("allows browser-tester to comment on a PR conversation too (same permission shape as executor)", () => {
    const decision = decide(
      baseReq({
        role: "browser-tester",
        method: "POST",
        path: "/repos/acme/widgets/issues/1/comments",
      }),
    );
    expect(decision.allow).toBe(true);
  });

  it("a role with neither issues:write nor pull_requests:write still can't comment", () => {
    // docs-writer's permission table is exactly {metadata: read, contents:
    // write} — no issues, no pull_requests — so it's the "role with
    // neither permission" this fix does NOT unblock, despite being named
    // in the review alongside executor/browser-tester. Flagging this
    // explicitly rather than widening ROLE_PERMISSIONS unasked: if
    // docs-writer is meant to comment on its own PR, that's a permissions
    // table change, a separate decision from this route-level fix.
    const decision = decide(
      baseReq({ role: "docs-writer", method: "POST", path: "/repos/acme/widgets/issues/1/comments" }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("role_lacks_write_permission");
  });

  it("project-manager (issues:write, no pull_requests) can still comment via the issues-permission side of the OR", () => {
    const decision = decide(
      baseReq({
        role: "project-manager",
        method: "POST",
        path: "/repos/acme/widgets/issues/1/comments",
      }),
    );
    expect(decision.allow).toBe(true);
  });

  it("the PR-comments route (/pulls/{n}/comments) is unaffected — still pull_requests:write only", () => {
    const decision = decide(
      baseReq({
        role: "project-manager", // issues:write, no pull_requests
        method: "POST",
        path: "/repos/acme/widgets/pulls/1/comments",
      }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("role_lacks_write_permission");
  });
});

describe("[round 4] item 2: non-reviewer roles may add/remove ordinary triage labels, by NAME not by path", () => {
  it('PM adds "bug" (an ordinary triage label) — allowed', () => {
    const decision = decide(
      baseReq({
        role: "project-manager",
        method: "POST",
        path: "/repos/acme/widgets/issues/1/labels",
        labelNames: ["bug"],
      }),
    );
    expect(decision.allow).toBe(true);
    expect(decision.reason).toBe("triage_label_write_allowed");
  });

  it('PM adds "code-review-passed" (a verdict label) — denied, reviewer-only regardless of issues:write', () => {
    const decision = decide(
      baseReq({
        role: "project-manager",
        method: "POST",
        path: "/repos/acme/widgets/issues/1/labels",
        labelNames: ["code-review-passed"],
      }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("verdict_label_requires_reviewer_role");
  });

  it("code-reviewer adds its own verdict label — allowed (unaffected: reviewer branch handles this, not the generic path)", () => {
    const decision = decide(
      baseReq({
        role: "code-reviewer",
        method: "POST",
        path: "/repos/acme/widgets/issues/1/labels",
        labelNames: ["code-review-passed"],
      }),
    );
    expect(decision.allow).toBe(true);
  });

  it('PM removes "security-needs-fix" (security-reviewer\'s verdict label) — denied', () => {
    const decision = decide(
      baseReq({
        role: "project-manager",
        method: "DELETE",
        path: "/repos/acme/widgets/issues/1/labels/security-needs-fix",
      }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("verdict_label_requires_reviewer_role");
  });

  it('PM removes "bug" (an ordinary triage label) — allowed', () => {
    const decision = decide(
      baseReq({
        role: "project-manager",
        method: "DELETE",
        path: "/repos/acme/widgets/issues/1/labels/bug",
      }),
    );
    expect(decision.allow).toBe(true);
    expect(decision.reason).toBe("triage_label_remove_allowed");
  });

  it("a role without issues:write still can't add an ordinary triage label", () => {
    const decision = decide(
      baseReq({
        role: "researcher", // metadata: read, contents: read only
        method: "POST",
        path: "/repos/acme/widgets/issues/1/labels",
        labelNames: ["bug"],
      }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("role_lacks_write_permission");
  });

  it("a role without issues:write still can't remove an ordinary triage label either", () => {
    const decision = decide(
      baseReq({
        role: "researcher",
        method: "DELETE",
        path: "/repos/acme/widgets/issues/1/labels/bug",
      }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("role_lacks_write_permission");
  });

  it("denies a mixed request naming both an ordinary label and a verdict label in the same call", () => {
    const decision = decide(
      baseReq({
        role: "project-manager",
        method: "POST",
        path: "/repos/acme/widgets/issues/1/labels",
        labelNames: ["bug", "code-review-passed"],
      }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("verdict_label_requires_reviewer_role");
  });

  it("denies a POST to the labels collection with no label names at all", () => {
    const decision = decide(
      baseReq({
        role: "project-manager",
        method: "POST",
        path: "/repos/acme/widgets/issues/1/labels",
      }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("triage_label_names_required");
  });

  it("incident-commander (also issues:write) can add a triage label too", () => {
    const decision = decide(
      baseReq({
        role: "incident-commander",
        method: "POST",
        path: "/repos/acme/widgets/issues/1/labels",
        labelNames: ["p1"],
      }),
    );
    expect(decision.allow).toBe(true);
  });
});

describe("[round 4] item 3: executor's push exclusion is exact-segment, not a loose string prefix", () => {
  function pushDecisionFor(role: string, ref: string) {
    const body = buildReceivePackBody([{ old: ZERO_SHA, new: SHA_A, ref }]);
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

  it.each([
    "refs/heads/fx/docsX",
    "refs/heads/fx/release-2.0",
    "refs/heads/fx/runbooks-old",
    "refs/heads/fx/docs-but-not-really/H03",
  ])("allows executor to push %s (shares characters with a reserved root, not a real path boundary)", (ref) => {
    const decision = pushDecisionFor("executor", ref);
    expect(decision.allow).toBe(true);
  });

  it.each([
    "refs/heads/fx/docs",
    "refs/heads/fx/release",
    "refs/heads/fx/runbook",
  ])("still denies executor pushing the exact bare reserved root %s", (ref) => {
    const decision = pushDecisionFor("executor", ref);
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("receive_pack_ref_outside_allowed_prefix");
  });

  it.each([
    "refs/heads/fx/docs/README",
    "refs/heads/fx/release/v1",
    "refs/heads/fx/runbook/incident-1",
  ])("still denies executor pushing inside a reserved namespace %s", (ref) => {
    const decision = pushDecisionFor("executor", ref);
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("receive_pack_ref_outside_allowed_prefix");
  });

  it("the owning role's own grant is unaffected by this change (still exact bare-root-or-nested)", () => {
    const bareRoot = pushDecisionFor("docs-writer", "refs/heads/fx/docs");
    const nested = pushDecisionFor("docs-writer", "refs/heads/fx/docs/README");
    const sibling = pushDecisionFor("docs-writer", "refs/heads/fx/docsX");
    expect(bareRoot.allow).toBe(true);
    expect(nested.allow).toBe(true);
    expect(sibling.allow).toBe(false); // not docs-writer's either — nobody's
  });
});

describe("[round 4] item 4: requested_reviewers is POST-only now", () => {
  it("allows executor POST /pulls/{n}/requested_reviewers (unaffected baseline)", () => {
    const decision = decide(
      baseReq({
        role: "executor",
        method: "POST",
        path: "/repos/acme/widgets/pulls/1/requested_reviewers",
      }),
    );
    expect(decision.allow).toBe(true);
  });

  it("denies executor DELETE /pulls/{n}/requested_reviewers (withdrawing a review request is no longer a route)", () => {
    const decision = decide(
      baseReq({
        role: "executor",
        method: "DELETE",
        path: "/repos/acme/widgets/pulls/1/requested_reviewers",
      }),
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("unknown_resource");
  });
});

describe("[round 4] regression sweep: legitimate flows verified still working after this round", () => {
  it("executor: open a PR, comment on it, PATCH title/body, push to fx/*", () => {
    expect(
      decide(baseReq({ role: "executor", method: "POST", path: "/repos/acme/widgets/pulls" })).allow,
    ).toBe(true);
    expect(
      decide(
        baseReq({ role: "executor", method: "POST", path: "/repos/acme/widgets/issues/1/comments" }),
      ).allow,
    ).toBe(true);
    expect(
      decide(
        baseReq({
          role: "executor",
          method: "PATCH",
          path: "/repos/acme/widgets/pulls/1",
          patchFields: ["title", "body"],
        }),
      ).allow,
    ).toBe(true);
    const body = buildReceivePackBody([{ old: ZERO_SHA, new: SHA_A, ref: "refs/heads/fx/H03" }]);
    expect(
      decide(
        baseReq({
          role: "executor",
          method: "POST",
          host: "github.com",
          sniHost: "github.com",
          path: "/acme/widgets.git/git-receive-pack",
          gitRefUpdates: parseReceivePackRefUpdates(body),
        }),
      ).allow,
    ).toBe(true);
  });

  it("code-reviewer: read a PR, comment, submit a review, add/remove its own verdict label", () => {
    expect(
      decide(baseReq({ role: "code-reviewer", method: "GET", path: "/repos/acme/widgets/pulls/1" }))
        .allow,
    ).toBe(true);
    expect(
      decide(
        baseReq({
          role: "code-reviewer",
          method: "POST",
          path: "/repos/acme/widgets/pulls/1/comments",
        }),
      ).allow,
    ).toBe(true);
    expect(
      decide(
        baseReq({ role: "code-reviewer", method: "POST", path: "/repos/acme/widgets/pulls/1/reviews" }),
      ).allow,
    ).toBe(true);
    expect(
      decide(
        baseReq({
          role: "code-reviewer",
          method: "POST",
          path: "/repos/acme/widgets/issues/1/labels",
          labelNames: ["code-review-passed"],
        }),
      ).allow,
    ).toBe(true);
    expect(
      decide(
        baseReq({
          role: "code-reviewer",
          method: "DELETE",
          path: "/repos/acme/widgets/issues/1/labels/code-review-needs-fix",
        }),
      ).allow,
    ).toBe(true);
  });

  it("project-manager: create an issue, triage-label it, comment, close it via PATCH state", () => {
    expect(
      decide(baseReq({ role: "project-manager", method: "POST", path: "/repos/acme/widgets/issues" }))
        .allow,
    ).toBe(true);
    expect(
      decide(
        baseReq({
          role: "project-manager",
          method: "POST",
          path: "/repos/acme/widgets/issues/1/labels",
          labelNames: ["triage"],
        }),
      ).allow,
    ).toBe(true);
    expect(
      decide(
        baseReq({
          role: "project-manager",
          method: "POST",
          path: "/repos/acme/widgets/issues/1/comments",
        }),
      ).allow,
    ).toBe(true);
    expect(
      decide(
        baseReq({
          role: "project-manager",
          method: "PATCH",
          path: "/repos/acme/widgets/issues/1",
          patchFields: ["state"],
        }),
      ).allow,
    ).toBe(true);
  });

  it("docs-writer/release-manager/runbook-writer: discover refs and push to their own namespace", () => {
    for (const [role, sub] of [
      ["docs-writer", "docs"],
      ["release-manager", "release"],
      ["runbook-writer", "runbook"],
    ] as const) {
      const discovery = decide(
        baseReq({
          role,
          method: "GET",
          host: "github.com",
          sniHost: "github.com",
          path: "/acme/widgets.git/info/refs",
          query: { service: "git-receive-pack" },
        }),
      );
      expect(discovery.allow).toBe(true);

      const body = buildReceivePackBody([
        { old: ZERO_SHA, new: SHA_A, ref: `refs/heads/fx/${sub}/H03` },
      ]);
      const push = decide(
        baseReq({
          role,
          method: "POST",
          host: "github.com",
          sniHost: "github.com",
          path: "/acme/widgets.git/git-receive-pack",
          gitRefUpdates: parseReceivePackRefUpdates(body),
        }),
      );
      expect(push.allow).toBe(true);
    }
  });

  it("still-denied baselines are unaffected: merge, protection, review-family for non-reviewers, REST contents writes", () => {
    expect(
      decide(baseReq({ role: "executor", method: "PUT", path: "/repos/acme/widgets/pulls/1/merge" }))
        .allow,
    ).toBe(false);
    expect(
      decide(
        baseReq({
          role: "executor",
          method: "PATCH",
          path: "/repos/acme/widgets/branches/main/protection",
        }),
      ).allow,
    ).toBe(false);
    expect(
      decide(
        baseReq({
          role: "executor",
          method: "POST",
          path: "/repos/acme/widgets/pulls/1/reviews",
        }),
      ).allow,
    ).toBe(false);
    expect(
      decide(
        baseReq({ role: "docs-writer", method: "PUT", path: "/repos/acme/widgets/contents/x.md" }),
      ).allow,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D#2 fix round 1, must-fix 2 — security re-review of PR #160 at edea9ce:
// "Git endpoints accept any method... The offline sweep found 477
// non-canonical git allows." `decide()` used to return `clone_allowed` for
// ANY method once `target.service === "upload-pack"`, and `receive-pack`
// discovery was gated on method alone, not on which literal endpoint the
// request actually hit -- so PUT/PATCH/DELETE on `git-upload-pack` and on
// `info/refs` were forwarded to GitHub with a minted credential. This table
// is the "one test per method" the review asked for, generalized to a full
// role x product x method x git-endpoint sweep: it fails on edea9ce
// (`clone_allowed`/`sitekit_clone_allowed` for every method there, not just
// the legal ones) and passes once decide.ts's step 4a gates on the literal
// endpoint.
// ---------------------------------------------------------------------------

describe("must-fix 2: a git target's method is gated by literal ENDPOINT, for every role and both products", () => {
  const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;
  const PRODUCTS: readonly Product[] = ["team", "sitekit"];
  // 25 named roles + one unknown role, matching the review's "26 roles".
  const ROLES: readonly string[] = [...Object.keys(ROLE_PERMISSIONS), "not-a-real-role"];

  const GIT_SHAPES: ReadonlyArray<{
    label: "info/refs (upload-pack)" | "info/refs (receive-pack)" | "git-upload-pack" | "git-receive-pack";
    path: string;
    query?: Record<string, string>;
  }> = [
    {
      label: "info/refs (upload-pack)",
      path: "/acme/widgets.git/info/refs",
      query: { service: "git-upload-pack" },
    },
    {
      label: "info/refs (receive-pack)",
      path: "/acme/widgets.git/info/refs",
      query: { service: "git-receive-pack" },
    },
    { label: "git-upload-pack", path: "/acme/widgets.git/git-upload-pack" },
    { label: "git-receive-pack", path: "/acme/widgets.git/git-receive-pack" },
  ];

  /** The ONLY method/endpoint pairings decide() may ever allow, for ANY role or product. */
  function isLegalCombo(shapeLabel: string, method: string): boolean {
    const isRead = method === "GET" || method === "HEAD";
    if (shapeLabel.startsWith("info/refs")) return isRead;
    return method === "POST"; // git-upload-pack or git-receive-pack
  }

  const cases: Array<{
    product: Product;
    role: string;
    method: (typeof METHODS)[number];
    shapeLabel: string;
    path: string;
    query?: Record<string, string>;
    legal: boolean;
  }> = [];
  for (const product of PRODUCTS) {
    for (const role of ROLES) {
      for (const shape of GIT_SHAPES) {
        for (const method of METHODS) {
          cases.push({
            product,
            role,
            method,
            shapeLabel: shape.label,
            path: shape.path,
            query: shape.query,
            legal: isLegalCombo(shape.label, method),
          });
        }
      }
    }
  }

  it(`generates the full sweep (${PRODUCTS.length} products x ${ROLES.length} roles x ${GIT_SHAPES.length} endpoints x ${METHODS.length} methods)`, () => {
    expect(cases.length).toBe(PRODUCTS.length * ROLES.length * GIT_SHAPES.length * METHODS.length);
    // Sanity: exactly the legal shapes are marked legal (2 read methods on
    // each info/refs shape, 1 write method -- POST -- on each pack shape).
    expect(cases.filter((c) => c.legal).length).toBe(
      PRODUCTS.length * ROLES.length * (2 * 2 + 1 * 2),
    );
  });

  it.each(cases.filter((c) => !c.legal))(
    "$product/$role: $method $shapeLabel is NEVER allowed (illegal method/endpoint pairing)",
    ({ product, role, method, path, query }) => {
      const decision = decide(
        baseReq({
          role,
          product,
          method,
          host: "github.com",
          sniHost: "github.com",
          path,
          query,
        }),
      );
      expect(decision.allow).toBe(false);
    },
  );
});
