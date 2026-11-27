import { describe, expect, it } from "vitest";
import { RunPullRequestError, createRunPullRequestPort, type PullRequestRepo } from "../src/runPullRequest.js";
import { GITHUB_GRAPHQL_DOCUMENTS, LocalOnlyGithubError, localOnlyGithub, type GithubClient, type GithubRequest } from "../src/localOnlyGithub.js";
import { installPullRequestText } from "../src/setupInstallPr.js";
import { FAKE_APP_LOGIN, FakeGithub, installationKindClient, openInstallationKinds } from "./helpers/githubFake.js";

/**
 * D#845 ON-24a (FU-322, Ruling 127): the install pull request's `MarkReady` goes through the `setup_ready` client, because GitHub refuses the mutation to the pull request token (contents read). The strict fake
 * refuses it the same way (HTTP 200, data null, one FORBIDDEN error) to any client whose token lacks contents write. The run path keeps its own client and its draft.
 */
const REPO: PullRequestRepo = { id: "22222222-2222-4222-8222-222222222222", owner: "acme", name: "widgets" };
const BRANCH = "fx/engine-install-1.2.3";
const TEXT = installPullRequestText("1.2.3");

function rig() {
  const fake = new FakeGithub();
  const repo = fake.addRepo("acme", "widgets");
  fake.pushBranch(repo, BRANCH, { files: [{ path: "a.md", changeType: "ADDED" }] });
  const opened: Array<string | undefined> = [];
  const closed: string[] = [];
  const kinds = openInstallationKinds(fake);
  const port = createRunPullRequestPort({
    open: async (r, purpose) => {
      opened.push(purpose);
      const inner = await kinds(r, purpose);
      return { request: (req) => inner.request(req), close: async () => void closed.push(purpose ?? "runner_pr") };
    },
    appLogin: async () => FAKE_APP_LOGIN,
    sleep: async () => undefined,
  });
  return { fake, repo, port, opened, closed };
}
const reasonOf = async (p: Promise<unknown>) => ((await p.then(() => null, (e: unknown) => e)) as RunPullRequestError | null)?.reason;

describe("the install pull request's mark-ready (setup: true)", () => {
  it("makes a freshly opened draft ready, through the setup_ready client alone, and releases its token", async () => {
    const t = rig();
    const ref = await t.port.openDraft({ repo: REPO, branch: BRANCH, base: "main", text: TEXT });
    expect(t.repo.pulls[0]!.draft).toBe(true);
    t.opened.length = 0;
    await t.port.markReady({ repo: REPO, pullRequest: ref, setup: true });
    expect(t.repo.pulls[0]!.draft).toBe(false);
    expect(t.opened).toEqual(["setup_ready"]);
    expect(t.closed).toEqual(["setup_ready"]);
  });

  it("makes an existing draft ready too (a repeat of the step reuses the pull request a first pass opened)", async () => {
    const t = rig();
    await t.port.openDraft({ repo: REPO, branch: BRANCH, base: "main", text: TEXT });
    const again = await t.port.openDraft({ repo: REPO, branch: BRANCH, base: "main", text: TEXT });
    expect(again).toMatchObject({ reused: true, draft: true });
    await t.port.markReady({ repo: REPO, pullRequest: again, setup: true });
    expect(t.repo.pulls).toHaveLength(1);
    expect(t.repo.pulls[0]!.draft).toBe(false);
  });

  it("revokes the token when GitHub refuses the mutation, too", async () => {
    const t = rig();
    const ref = await t.port.openDraft({ repo: REPO, branch: BRANCH, base: "main", text: TEXT });
    t.fake.inject = { label: /^A1 MarkReady$/, reply: { status: 200, body: { data: { markPullRequestReadyForReview: null }, errors: [{ type: "FORBIDDEN" }] } } };
    t.closed.length = 0;
    expect(await reasonOf(t.port.markReady({ repo: REPO, pullRequest: ref, setup: true }))).toBe("rejected");
    expect(t.closed).toEqual(["setup_ready"]);
  });

  it("an already-ready pull request is not asked again and opens no client", async () => {
    const t = rig();
    const ref = await t.port.openDraft({ repo: REPO, branch: BRANCH, base: "main", text: TEXT });
    await t.port.markReady({ repo: REPO, pullRequest: ref, setup: true });
    t.opened.length = 0;
    await t.port.markReady({ repo: REPO, pullRequest: { ...ref, draft: false }, setup: true });
    expect(t.opened).toEqual([]);
  });
});

describe("the run path's mark-ready (no setup flag)", () => {
  it("stays on the pull request client, which GitHub refuses, and leaves the draft a draft", async () => {
    const t = rig();
    const ref = await t.port.openDraft({ repo: REPO, branch: BRANCH, base: "main", text: TEXT });
    t.opened.length = 0;
    expect(await reasonOf(t.port.markReady({ repo: REPO, pullRequest: ref }))).toBe("rejected");
    expect(t.opened).toEqual([undefined]);
    expect(t.repo.pulls[0]!.draft).toBe(true);
  });
});

describe("the strict fake's contents-write rule", () => {
  const body = (id: string): GithubRequest => ({ method: "POST", path: "/graphql", headers: { accept: "application/vnd.github+json" }, body: { query: GITHUB_GRAPHQL_DOCUMENTS.MarkReady, variables: { id } } });

  it("answers HTTP 200, data null and FORBIDDEN to a pull request token, and marks ready for a token holding contents write", async () => {
    const t = rig();
    const ref = await t.port.openDraft({ repo: REPO, branch: BRANCH, base: "main", text: TEXT });
    const denied = await installationKindClient(t.fake, "runner_pr").request(body(ref.nodeId));
    expect(denied.status).toBe(200);
    expect(denied.body).toMatchObject({ data: { markPullRequestReadyForReview: null }, errors: [{ type: "FORBIDDEN", path: ["markPullRequestReadyForReview"] }] });
    expect(t.repo.pulls[0]!.draft).toBe(true);
    const allowed = await installationKindClient(t.fake, "setup_ready").request(body(ref.nodeId));
    expect(allowed.body).toMatchObject({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } });
    expect(t.repo.pulls[0]!.draft).toBe(false);
  });

  it("the setup_ready kind sends POST /graphql and nothing else", async () => {
    const t = rig();
    const client = installationKindClient(t.fake, "setup_ready");
    await expect(client.request({ method: "GET", path: "/repos/acme/widgets" })).rejects.toThrow("path_refused");
    await expect(client.request({ method: "GET", path: "/repos/acme/widgets/pulls" })).rejects.toThrow("path_refused");
    expect(t.fake.denied).toBe(2);
  });
});

describe("the markReadyOnly fence", () => {
  const seen = (): { client: GithubClient; sent: GithubRequest[] } => {
    const sent: GithubRequest[] = [];
    return { sent, client: { request: async (r) => (sent.push(r), { status: 200, body: {} }) } };
  };
  const graphql = (query: string, variables: unknown): GithubRequest => ({ method: "POST", path: "/graphql", body: { query, variables } });
  const DOC = GITHUB_GRAPHQL_DOCUMENTS;

  it("lets the MarkReady document through, and only with its own variables", async () => {
    const { client, sent } = seen();
    const gh = localOnlyGithub(client, { markReadyOnly: true });
    await gh.request(graphql(DOC.MarkReady, { id: "PR_kwDOAbCd123" }));
    expect(sent).toHaveLength(1);
    for (const variables of [{}, { id: "PR_x", extra: 1 }, { id: "has space" }]) await expect(gh.request(graphql(DOC.MarkReady, variables))).rejects.toBeInstanceOf(LocalOnlyGithubError);
    expect(sent).toHaveLength(1);
  });

  it("refuses every other document and every REST call, even those the other options allow", async () => {
    const { client, sent } = seen();
    const gh = localOnlyGithub(client, { markReadyOnly: true, setupInstall: true, setupFinish: true });
    const refused: GithubRequest[] = [
      graphql(DOC.PullRequestFiles, { owner: "acme", name: "widgets", number: 1 }),
      graphql(DOC.RunBranchState, { owner: "acme", name: "widgets", head: "a", base: "b" }),
      graphql("mutation { closePullRequest(input: {}) { clientMutationId } }", {}),
      { method: "GET", path: "/repos/acme/widgets" },
      { method: "GET", path: "/repos/acme/widgets/pulls" },
      { method: "POST", path: "/repos/acme/widgets/pulls", body: { title: "t", head: "a", base: "b", body: "x", draft: true } },
      { method: "PATCH", path: "/repos/acme/widgets/pulls/1", body: { state: "closed" } },
    ];
    for (const req of refused) await expect(gh.request(req), `${req.method} ${req.path}`).rejects.toBeInstanceOf(LocalOnlyGithubError);
    expect(sent).toEqual([]);
  });

  it("a client built without it still allows the run's other calls (the option narrows, nothing else changes)", async () => {
    const { client, sent } = seen();
    await localOnlyGithub(client).request({ method: "GET", path: "/repos/acme/widgets" });
    expect(sent).toHaveLength(1);
  });
});
