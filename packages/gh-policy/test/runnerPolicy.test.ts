import { describe, expect, it } from "vitest";
import { parseReceivePackRefUpdates } from "../src/parseReceivePack.js";
import { decideRunner, RUNNER_PUSHING_ROLES, type RunnerRequest } from "../src/runnerPolicy.js";
import { concatBytes, encodeFlushPkt, encodePktLine, buildReceivePackBody, SHA_A, SHA_B, ZERO_SHA } from "./fixtures.js";

const TICKET_REF = "fx/0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d-g2";
const OTHER_RUN_REF = "fx/0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d-g3";
const REF = `refs/heads/${TICKET_REF}`;
const REPO = { owner: "acme", repo: "widgets" };

const READ_SCOPE = { metadata: "read", contents: "read" };
const PUSH_SCOPE = { metadata: "read", contents: "write" };

function pushBody(updates: { old: string; new: string; ref: string }[]) {
  return parseReceivePackRefUpdates(buildReceivePackBody(updates));
}

function req(over: Partial<RunnerRequest>): RunnerRequest {
  return {
    method: "GET",
    path: "/acme/widgets.git/info/refs",
    query: { service: "git-upload-pack" },
    role: "executor",
    product: "team",
    installation: REPO,
    ticketRef: TICKET_REF,
    ...over,
  };
}

const receivePost = (gitRefUpdates: RunnerRequest["gitRefUpdates"], over: Partial<RunnerRequest> = {}) =>
  req({ method: "POST", path: "/acme/widgets.git/git-receive-pack", query: undefined, gitRefUpdates, ...over });

describe("decideRunner: the allow rows", () => {
  it("allows upload-pack discovery for any role, with the read scope", () => {
    for (const role of ["executor", "docs-writer", "code-reviewer", "security-reviewer"]) {
      for (const method of ["GET", "HEAD"]) {
        const d = decideRunner(req({ role, method }));
        expect(d).toMatchObject({ allow: true, reason: "runner_clone_allowed" });
        expect(d.tokenScope).toEqual({ repositories: ["widgets"], permissions: READ_SCOPE });
      }
    }
  });

  it("allows POST git-upload-pack with the read scope", () => {
    const d = decideRunner(req({ method: "POST", path: "/acme/widgets.git/git-upload-pack", query: undefined }));
    expect(d).toMatchObject({ allow: true, reason: "runner_clone_allowed" });
    expect(d.tokenScope?.permissions).toEqual(READ_SCOPE);
  });

  it("allows receive-pack discovery only for the pushing roles, with the write scope", () => {
    for (const role of ["executor", "docs-writer"]) {
      const d = decideRunner(req({ role, query: { service: "git-receive-pack" } }));
      expect(d).toMatchObject({ allow: true, reason: "runner_receive_pack_discovery_allowed" });
      expect(d.tokenScope).toEqual({ repositories: ["widgets"], permissions: PUSH_SCOPE });
    }
    expect([...RUNNER_PUSHING_ROLES].sort()).toEqual(["docs-writer", "executor"]);
  });

  it("allows exactly one update of the ticket's branch, with the write scope", () => {
    for (const role of ["executor", "docs-writer"]) {
      const d = decideRunner(receivePost(pushBody([{ old: ZERO_SHA, new: SHA_A, ref: REF }]), { role }));
      expect(d).toMatchObject({ allow: true, reason: "runner_push_allowed" });
      expect(d.tokenScope).toEqual({ repositories: ["widgets"], permissions: PUSH_SCOPE });
    }
  });

  it("allows a continuation push of the same branch (old is not zero)", () => {
    expect(decideRunner(receivePost(pushBody([{ old: SHA_B, new: SHA_A, ref: REF }]))).allow).toBe(true);
  });

  it("neither scope carries a workflows key, and the scopes are the two literal objects", () => {
    const read = decideRunner(req({})).tokenScope!.permissions;
    const push = decideRunner(receivePost(pushBody([{ old: ZERO_SHA, new: SHA_A, ref: REF }]))).tokenScope!.permissions;
    expect(read).toEqual({ metadata: "read", contents: "read" });
    expect(push).toEqual({ metadata: "read", contents: "write" });
    for (const scope of [read, push]) {
      expect(Object.keys(scope).sort()).toEqual(["contents", "metadata"]);
      expect(scope).not.toHaveProperty("workflows");
    }
  });

  it("returns a fresh scope object each time, so a caller cannot change the table", () => {
    const first = decideRunner(req({}));
    (first.tokenScope!.permissions as Record<string, string>).contents = "write";
    expect(decideRunner(req({})).tokenScope!.permissions).toEqual(READ_SCOPE);
  });
});

describe("decideRunner: REST is always denied", () => {
  const rest: [string, string, string][] = [
    ["a verdict label", "POST", "/repos/acme/widgets/issues/5/labels"],
    ["a label removal", "DELETE", "/repos/acme/widgets/issues/5/labels/verdict-pass"],
    ["a merge", "PUT", "/repos/acme/widgets/pulls/5/merge"],
    ["a commit status", "POST", `/repos/acme/widgets/statuses/${SHA_A}`],
    ["a check run", "POST", "/repos/acme/widgets/check-runs"],
    ["an approving review", "POST", "/repos/acme/widgets/pulls/5/reviews"],
    ["a review event", "POST", "/repos/acme/widgets/pulls/5/reviews/9/events"],
    ["a contents PUT to a workflow file", "PUT", "/repos/acme/widgets/contents/.github/workflows/x.yml"],
    ["a contents read", "GET", "/repos/acme/widgets/contents/README.md"],
    ["opening a PR", "POST", "/repos/acme/widgets/pulls"],
    ["a plain repo read", "GET", "/repos/acme/widgets"],
  ];
  it.each(rest)("denies %s", (_name, method, path) => {
    expect(decideRunner(req({ method, path, query: undefined }))).toEqual({ allow: false, reason: "runner_rest_denied" });
  });

  it("denies REST even for another repo (the REST rule comes first)", () => {
    expect(decideRunner(req({ method: "GET", path: "/repos/evil/other/issues", query: undefined })).reason).toBe("runner_rest_denied");
  });
});

describe("decideRunner: the other denials", () => {
  it("denies a non-team product", () => {
    expect(decideRunner(req({ product: "sitekit" }))).toEqual({ allow: false, reason: "runner_product_denied" });
  });

  it("denies a repo other than the installation target", () => {
    expect(decideRunner(req({ path: "/acme/other.git/info/refs" })).reason).toBe("repo_out_of_scope");
    expect(decideRunner(req({ path: "/evil/widgets.git/info/refs" })).reason).toBe("repo_out_of_scope");
  });

  it("denies a receive-pack for a non-pushing role, at discovery and at the POST", () => {
    for (const role of ["code-reviewer", "project-manager", "release-manager", "browser-tester", ""]) {
      expect(decideRunner(req({ role, query: { service: "git-receive-pack" } })).reason).toBe("receive_pack_requires_push_capable_role");
      expect(decideRunner(receivePost(pushBody([{ old: ZERO_SHA, new: SHA_A, ref: REF }]), { role })).reason).toBe("receive_pack_requires_push_capable_role");
    }
  });

  it("denies a second ref, even when the first is the ticket's", () => {
    const d = decideRunner(receivePost(pushBody([{ old: ZERO_SHA, new: SHA_A, ref: REF }, { old: ZERO_SHA, new: SHA_B, ref: "refs/heads/fx/extra" }])));
    expect(d).toEqual({ allow: false, reason: "receive_pack_not_single_ref" });
  });

  it("denies a push with no updates", () => {
    expect(decideRunner(receivePost(pushBody([]))).reason).toBe("receive_pack_not_single_ref");
  });

  it("denies a tag", () => {
    expect(decideRunner(receivePost(pushBody([{ old: ZERO_SHA, new: SHA_A, ref: `refs/tags/${TICKET_REF}` }]))).reason).toBe("receive_pack_ref_not_ticket_ref");
  });

  it("denies a ref other than the ticket's: another generation, another branch, a prefix and a suffix of it", () => {
    for (const ref of [`refs/heads/${OTHER_RUN_REF}`, "refs/heads/main", "refs/heads/fx/docs/x", `${REF}x`, `${REF}/y`, TICKET_REF, "refs/heads/fx"]) {
      expect(decideRunner(receivePost(pushBody([{ old: ZERO_SHA, new: SHA_A, ref }]))).reason).toBe("receive_pack_ref_not_ticket_ref");
    }
  });

  it("denies a delete of the ticket's own branch (all-zero new object id), SHA-1 and SHA-256 forms", () => {
    expect(decideRunner(receivePost(pushBody([{ old: SHA_A, new: ZERO_SHA, ref: REF }]))).reason).toBe("receive_pack_delete_denied");
    expect(decideRunner(receivePost(pushBody([{ old: SHA_A, new: "0".repeat(64), ref: REF }]))).reason).toBe("receive_pack_delete_denied");
  });

  it("denies a new object id that is not an object id", () => {
    expect(decideRunner(receivePost(pushBody([{ old: ZERO_SHA, new: "not-hex", ref: REF }]))).reason).toBe("receive_pack_bad_object_id");
  });

  it("denies push-cert: the parser reports it incomplete, and incomplete is refused", () => {
    const body = concatBytes([
      encodePktLine("push-cert\0report-status atomic\n"),
      encodePktLine("certificate version 0.1\n"),
      encodePktLine("pusher T <t@example.invalid> 1 +0000\n"),
      encodePktLine("\n"),
      encodePktLine(`${ZERO_SHA} ${SHA_A} ${REF}\n`),
      encodePktLine("push-cert-end\n"),
      encodeFlushPkt(),
    ]);
    const parsed = parseReceivePackRefUpdates(body);
    expect(parsed.complete).toBe(false);
    expect(decideRunner(receivePost(parsed))).toEqual({ allow: false, reason: "receive_pack_unparsed_or_incomplete" });
  });

  it("denies a truncated or missing receive-pack parse", () => {
    const truncated = parseReceivePackRefUpdates(buildReceivePackBody([{ old: ZERO_SHA, new: SHA_A, ref: REF }]).subarray(0, 30));
    expect(decideRunner(receivePost(truncated)).reason).toBe("receive_pack_unparsed_or_incomplete");
    expect(decideRunner(receivePost(undefined)).reason).toBe("receive_pack_unparsed_or_incomplete");
  });

  it("denies a ticket ref outside the allowed pattern, whatever the body says", () => {
    for (const ticketRef of ["", "fx/main", "fx/docs/x", "main", `${TICKET_REF}/x`, "fx/0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d-g0", "fx/0A1B2C3D-4E5F-6A7B-8C9D-0E1F2A3B4C5D-g2"]) {
      const d = decideRunner(receivePost(pushBody([{ old: ZERO_SHA, new: SHA_A, ref: `refs/heads/${ticketRef}` }]), { ticketRef }));
      expect(d).toEqual({ allow: false, reason: "runner_ticket_ref_invalid" });
    }
  });

  it("denies the wrong method on each git endpoint", () => {
    expect(decideRunner(req({ method: "POST" })).reason).toBe("info_refs_method_not_allowed");
    expect(decideRunner(req({ method: "PUT", path: "/acme/widgets.git/git-upload-pack", query: undefined })).reason).toBe("upload_pack_method_not_allowed");
    expect(decideRunner(req({ method: "GET", path: "/acme/widgets.git/git-upload-pack", query: undefined })).reason).toBe("upload_pack_method_not_allowed");
    expect(decideRunner(receivePost(pushBody([{ old: ZERO_SHA, new: SHA_A, ref: REF }]), { method: "GET" })).reason).toBe("receive_pack_method_not_allowed");
    expect(decideRunner(receivePost(pushBody([{ old: ZERO_SHA, new: SHA_A, ref: REF }]), { method: "DELETE" })).reason).toBe("receive_pack_method_not_allowed");
  });

  it("denies a method outside the set, a non-canonical path and an unrecognised path", () => {
    expect(decideRunner(req({ method: "get" })).reason).toBe("method_not_allowed");
    expect(decideRunner(req({ path: "/acme/widgets.git/../info/refs" })).reason).toBe("path_not_canonical");
    expect(decideRunner(req({ path: "/acme/widgets.git/info/refs/" })).reason).toBe("path_not_canonical");
    expect(decideRunner(req({ query: undefined })).reason).toBe("path_not_recognized");
    expect(decideRunner(req({ path: "/user", query: undefined })).reason).toBe("path_not_recognized");
  });

  it("never allows a denied request a token scope", () => {
    expect(decideRunner(req({ product: "sitekit" })).tokenScope).toBeUndefined();
  });
});
