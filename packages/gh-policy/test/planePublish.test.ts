import { describe, expect, it } from "vitest";
import { decidePlanePublish, PLANE_PUBLISH_DENY_REASONS, parseReceivePackRefUpdates, type PlanePublishRequest } from "../src/index.js";
import { buildReceivePackBody, buildUnterminatedReceivePackBody, SHA_A, SHA_B, ZERO_SHA } from "./fixtures.js";

/**
 * D#598 P1f-4b: the publish run's rule set. Private repository acme/widgets (the run's own), public repository acme-public/widgets-pub, one recorded
 * branch. The ref updates and the pull request body are derived from the request's own bytes by the caller, as the proxy does.
 */
const BRANCH = "fx/p-0b1c2d3e-0000-4000-8000-000000000001";
const BASE: Omit<PlanePublishRequest, "method" | "path" | "query"> = {
  privateRepo: { owner: "acme", repo: "widgets" },
  publishTarget: { codeRepo: "acme-public/widgets-pub", branch: BRANCH },
};
const GIT = (repo: string, endpoint: string) => `/${repo}/${endpoint}`;

function ask(method: string, path: string, extra: Partial<PlanePublishRequest> = {}) {
  return decidePlanePublish({ ...BASE, method, path, query: {}, ...extra });
}
const discovery = (repo: string, service: string, method = "GET") => ask(method, GIT(repo, "info/refs"), { query: { service } });
const push = (updates: { old: string; new: string; ref: string }[]) => ask("POST", GIT("acme-public/widgets-pub", "git-receive-pack"), { gitRefUpdates: parseReceivePackRefUpdates(buildReceivePackBody(updates)) });
const pull = (body: Record<string, unknown> | null) => ask("POST", "/repos/acme-public/widgets-pub/pulls", { pullRequestBody: body });
const denied = (d: ReturnType<typeof ask>, reason: string) => expect(d).toEqual({ allow: false, reason });

describe("the private repository is read only", () => {
  it("allows upload-pack discovery and the upload-pack POST, with a private (read) token", () => {
    expect(discovery("acme/widgets", "git-upload-pack")).toMatchObject({ allow: true, side: "private" });
    expect(ask("POST", GIT("acme/widgets", "git-upload-pack"))).toMatchObject({ allow: true, side: "private" });
  });
  it("refuses receive-pack in both forms, and every REST request", () => {
    denied(discovery("acme/widgets", "git-receive-pack"), "publish_request_not_allowed");
    denied(ask("POST", GIT("acme/widgets", "git-receive-pack")), "publish_request_not_allowed");
    denied(ask("GET", "/repos/acme/widgets/issues/5"), "publish_request_not_allowed");
    denied(ask("POST", "/repos/acme/widgets/pulls", { pullRequestBody: { head: BRANCH, base: "main" } }), "publish_request_not_allowed");
  });
});

describe("the public repository, git", () => {
  it("allows discovery for either service (a GET), and the upload-pack POST", () => {
    expect(discovery("acme-public/widgets-pub", "git-upload-pack")).toMatchObject({ allow: true, side: "public" });
    expect(discovery("acme-public/widgets-pub", "git-receive-pack")).toMatchObject({ allow: true, side: "public" });
    expect(ask("POST", GIT("acme-public/widgets-pub", "git-upload-pack"))).toMatchObject({ allow: true, side: "public" });
  });
  it("allows a receive-pack that creates exactly the recorded branch", () => {
    expect(push([{ old: ZERO_SHA, new: SHA_A, ref: `refs/heads/${BRANCH}` }])).toMatchObject({ allow: true, side: "public" });
    // A SHA-256 repository's zero id is 64 characters.
    expect(push([{ old: "0".repeat(64), new: "a".repeat(64), ref: `refs/heads/${BRANCH}` }])).toMatchObject({ allow: true });
  });
  it("allows a receive-pack that replaces the head of exactly the recorded branch (the fix-round republish), and says which it is", () => {
    expect(push([{ old: SHA_B, new: SHA_A, ref: `refs/heads/${BRANCH}` }])).toMatchObject({ allow: true, side: "public", reason: "public_branch_update_allowed" });
    expect(push([{ old: "b".repeat(64), new: "a".repeat(64), ref: `refs/heads/${BRANCH}` }])).toMatchObject({ allow: true });
    expect(push([{ old: ZERO_SHA, new: SHA_A, ref: `refs/heads/${BRANCH}` }])).toMatchObject({ allow: true, reason: "public_branch_create_allowed" });
  });
  it.each([
    ["two ref updates", [{ old: ZERO_SHA, new: SHA_A, ref: `refs/heads/${BRANCH}` }, { old: ZERO_SHA, new: SHA_B, ref: "refs/heads/fx/other" }]],
    ["no ref update", []],
    ["a branch other than the recorded one", [{ old: ZERO_SHA, new: SHA_A, ref: "refs/heads/fx/other" }]],
    ["the recorded name as a tag", [{ old: ZERO_SHA, new: SHA_A, ref: `refs/tags/${BRANCH}` }]],
    ["main", [{ old: ZERO_SHA, new: SHA_A, ref: "refs/heads/main" }]],
    ["an update of another branch than the recorded one", [{ old: SHA_B, new: SHA_A, ref: "refs/heads/fx/other" }]],
    ["an update of main", [{ old: SHA_B, new: SHA_A, ref: "refs/heads/main" }]],
    ["an update of the recorded name as a tag", [{ old: SHA_B, new: SHA_A, ref: `refs/tags/${BRANCH}` }]],
    ["two updates, one of them the recorded branch", [{ old: SHA_B, new: SHA_A, ref: `refs/heads/${BRANCH}` }, { old: SHA_B, new: SHA_A, ref: "refs/heads/main" }]],
    ["a delete of the recorded branch", [{ old: SHA_A, new: ZERO_SHA, ref: `refs/heads/${BRANCH}` }]],
    ["a create of nothing (old and new both zero)", [{ old: ZERO_SHA, new: ZERO_SHA, ref: `refs/heads/${BRANCH}` }]],
  ])("refuses a receive-pack with %s", (_label, updates) => {
    denied(push(updates), "publish_ref_not_allowed");
  });
  it("refuses a receive-pack whose ref section never ends", () => {
    const d = ask("POST", GIT("acme-public/widgets-pub", "git-receive-pack"), { gitRefUpdates: parseReceivePackRefUpdates(buildUnterminatedReceivePackBody([{ old: ZERO_SHA, new: SHA_A, ref: `refs/heads/${BRANCH}` }])) });
    denied(d, "publish_receive_pack_unparsed");
    denied(ask("POST", GIT("acme-public/widgets-pub", "git-receive-pack")), "publish_receive_pack_unparsed");
  });
  it("refuses a wrong method on every git endpoint, and a query on a POST", () => {
    for (const m of ["POST", "PUT", "DELETE", "HEAD"]) denied(discovery("acme-public/widgets-pub", "git-upload-pack", m), "publish_method_not_allowed");
    for (const e of ["git-upload-pack", "git-receive-pack"]) for (const m of ["GET", "PUT", "PATCH", "DELETE"]) denied(ask(m, GIT("acme-public/widgets-pub", e)), "publish_method_not_allowed");
    denied(ask("POST", GIT("acme-public/widgets-pub", "git-upload-pack"), { query: { service: "git-upload-pack" } }), "publish_request_not_allowed");
  });
});

describe("the public repository, REST", () => {
  it("allows the read of the recorded branch's ref, and nothing else under /git", () => {
    expect(ask("GET", `/repos/acme-public/widgets-pub/git/ref/heads/${BRANCH}`)).toMatchObject({ allow: true, side: "public" });
    denied(ask("GET", "/repos/acme-public/widgets-pub/git/ref/heads/main"), "publish_request_not_allowed");
    denied(ask("GET", "/repos/acme-public/widgets-pub/git/ref/heads/fx/other"), "publish_request_not_allowed");
    denied(ask("DELETE", `/repos/acme-public/widgets-pub/git/refs/heads/${BRANCH}`), "publish_request_not_allowed");
    denied(ask("PATCH", `/repos/acme-public/widgets-pub/git/ref/heads/${BRANCH}`), "publish_request_not_allowed");
    denied(ask("GET", `/repos/acme-public/widgets-pub/git/ref/heads/${BRANCH}`, { query: { x: "1" } }), "publish_request_not_allowed");
  });
  it("allows a pull request from the recorded branch onto main", () => {
    expect(pull({ title: "t", head: BRANCH, base: "main", body: "b", maintainer_can_modify: false })).toMatchObject({ allow: true, side: "public" });
  });
  it.each([
    ["another head", { title: "t", head: "fx/other", base: "main" }],
    ["a head with an owner prefix", { title: "t", head: `acme-public:${BRANCH}`, base: "main" }],
    ["another base", { title: "t", head: BRANCH, base: "release" }],
    ["no base", { title: "t", head: BRANCH }],
    ["a head that is not a string", { title: "t", head: [BRANCH], base: "main" }],
    ["an issue to convert", { issue: 5, head: BRANCH, base: "main" }],
    ["a head_repo", { title: "t", head: BRANCH, base: "main", head_repo: "someone/else" }],
  ])("refuses a pull request with %s", (_label, body) => denied(pull(body), "publish_pull_request_not_allowed"));
  it("refuses a pull request body that did not parse or repeated a key", () => denied(pull(null), "publish_pull_request_not_allowed"));
  it.each([
    ["GET", "/repos/acme-public/widgets-pub/pulls"],
    ["PATCH", "/repos/acme-public/widgets-pub/pulls/3"],
    ["PUT", "/repos/acme-public/widgets-pub/pulls/3/merge"],
    ["GET", "/repos/acme-public/widgets-pub/contents/README.md"],
    ["PUT", "/repos/acme-public/widgets-pub/contents/README.md"],
    ["POST", "/repos/acme-public/widgets-pub/issues"],
    ["POST", "/repos/acme-public/widgets-pub/git/refs"],
    ["GET", "/repos/acme-public/widgets-pub"],
  ])("refuses any other API path: %s %s", (method, path) => denied(ask(method, path), "publish_request_not_allowed"));
});

describe("repositories are compared exactly", () => {
  it.each([
    ["a different case of the public owner", "Acme-Public/widgets-pub"],
    ["a different case of the public name", "acme-public/Widgets-Pub"],
    ["an added suffix", "acme-public/widgets-pub-2"],
    ["a prefix", "acme-public/widgets-pu"],
    ["another owner", "other/widgets-pub"],
    ["a different case of the private repo", "Acme/widgets"],
  ])("refuses %s", (_label, repo) => {
    denied(discovery(repo, "git-upload-pack"), "publish_repo_out_of_scope");
    denied(ask("GET", `/repos/${repo}/git/ref/heads/${BRANCH}`), "publish_repo_out_of_scope");
  });
  it("refuses a pairing that names the run's own repository, and a malformed pairing", () => {
    denied(decidePlanePublish({ ...BASE, publishTarget: { codeRepo: "acme/widgets", branch: BRANCH }, method: "GET", path: GIT("acme/widgets", "info/refs"), query: { service: "git-upload-pack" } }), "publish_repo_out_of_scope");
    for (const codeRepo of ["acme-public", "a/b/c", "/x", "x/"]) {
      denied(decidePlanePublish({ ...BASE, publishTarget: { codeRepo, branch: BRANCH }, method: "GET", path: GIT("acme-public/widgets-pub", "info/refs"), query: { service: "git-upload-pack" } }), "publish_repo_out_of_scope");
    }
  });
  it("accepts the .git spelling of the same repository, which git itself sends", () => {
    expect(discovery("acme-public/widgets-pub.git", "git-upload-pack")).toMatchObject({ allow: true, side: "public" });
  });
});

describe("paths", () => {
  it.each(["/repos/acme-public/widgets-pub/git/ref/heads/../main", "/repos/acme-public//widgets-pub/pulls", "/acme-public/widgets-pub/info/refs/", "/repos/acme-public/widgets-pub/git/ref/heads/fx%2Fp-1"])(
    "refuses a path that is not canonical: %s",
    (path) => denied(ask("GET", path, { query: { service: "git-upload-pack" } }), "publish_path_not_canonical"),
  );
  it("refuses a path that is not a repository path, and an info/refs with no service", () => {
    denied(ask("GET", "/user"), "publish_path_not_recognized");
    denied(ask("GET", "/gists"), "publish_path_not_recognized");
    denied(ask("GET", GIT("acme-public/widgets-pub", "info/refs")), "publish_path_not_recognized");
  });
});

describe("reasons", () => {
  it("every reason the rule set returns is one of the fixed strings", () => {
    const reasons = new Set<string>();
    const probes = [
      ask("GET", "/repos/a//b"),
      ask("GET", "/user"),
      ask("GET", "/repos/x/y"),
      discovery("acme-public/widgets-pub", "git-upload-pack", "PUT"),
      ask("GET", "/repos/acme-public/widgets-pub"),
      ask("POST", GIT("acme-public/widgets-pub", "git-receive-pack")),
      push([]),
      pull(null),
    ];
    for (const d of probes) if (!d.allow) reasons.add(d.reason);
    expect([...reasons].sort()).toEqual([...PLANE_PUBLISH_DENY_REASONS].sort());
    for (const r of reasons) expect(r).toMatch(/^publish_[a-z_]+$/);
  });
});
